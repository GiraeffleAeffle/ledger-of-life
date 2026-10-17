import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,lstat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {digest} from '../src/district-adapter-contract.ts';
import {DistrictJobStore,migrateDistrictJobs} from '../src/district-jobs.ts';
import {guardDistrictPool,isDistrictDatabaseConnectionError} from '../src/district-database.ts';
import {formatR1Failure} from '../src/district-r1.ts';

interface Entered {entered:true;stateDir:string;runId:string;backendPid?:number}
interface Worker {process:ChildProcess;closed:Promise<number|null>;entered:Promise<Entered>;stdout:()=>string;stderr:()=>string}
function worker(file:URL,args:string[],env:NodeJS.ProcessEnv):Worker {
 const child=fork(file,args,{env,execArgv:['--experimental-strip-types'],stdio:['ignore','pipe','pipe','ipc']});
 const closed=Promise.withResolvers<number|null>(),entered=Promise.withResolvers<Entered>();let stdout='',stderr='';
 // A migration child has no admission IPC, and a failing worker may close before
 // the caller starts awaiting its exit. Neither promise should be unhandled.
 void entered.promise.catch(()=>{});void closed.promise.catch(()=>{});
 child.stdout!.on('data',chunk=>{stdout+=chunk;});child.stderr!.on('data',chunk=>{stderr+=chunk;});
 child.on('message',(message:Entered)=>{if(message.entered)entered.resolve(message);});
 child.once('error',error=>{entered.reject(error);closed.reject(error);});
 child.once('close',code=>{entered.reject(Error('Worker closed before handler admission: '+stderr));closed.resolve(code);});
 return {process:child,closed:closed.promise,entered:entered.promise,stdout:()=>stdout,stderr:()=>stderr};
}
async function waitUntil(ready:()=>Promise<boolean>,timeoutMs=30000):Promise<void>{
 const deadline=performance.now()+timeoutMs;
 while(!await ready()){if(performance.now()>=deadline)throw Error('Timed out waiting for database-loss fixture');await delay(25);}
}
async function cleaned(directory:string):Promise<boolean>{
 try{return await readFile(join(directory,'cleanup-finished'),'utf8')==='closed';}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
function assertTypedFailure(child:Worker,phase:'admission'|'execution'):void {
 assert.equal(child.stdout(),'');assert.match(child.stderr(),new RegExp('R1_FAILURE phase='+phase+' code=DATABASE_CONNECTION_LOST'));
 assert.doesNotMatch(child.stderr(),/Unhandled|unhandled|ECONNRESET|terminating connection|postgresql:\/\//);
}

test('database failures have content-free typed diagnostics, not a new disposition',()=>{
 for(const error of [Object.assign(Error('private transport details'),{code:'ECONNRESET'}),Object.assign(Error('private server details'),{code:'57P01'}),Error('Connection terminated unexpectedly')]){
  assert.equal(isDistrictDatabaseConnectionError(error),true);assert.equal(formatR1Failure(error,'execution'),'R1_FAILURE phase=execution code=DATABASE_CONNECTION_LOST\n');
 }
 assert.equal(isDistrictDatabaseConnectionError(Object.assign(Error('synthetic SQL error'),{code:'23505'})),false);
 assert.equal(formatR1Failure(Error('private command failure'),'admission'),'R1_FAILURE phase=admission code=R1_COMMAND_FAILED\n');
});

const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
test('database loss stops CLI/executor work and drains real inventory sections',{skip:!connectionString,timeout:240000},async t=>{
 const url=new URL(connectionString!);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(url.hostname))throw Error('Integration test refuses a non-local Postgres endpoint');
 const host=url.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Integration test refuses non-local host override');
 const database='district_loss_test_'+randomUUID().replaceAll('-',''),directory=await mkdtemp(join(tmpdir(),'district-loss-'));
 const admin=guardDistrictPool(new Pool({connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:10000}));
 const children:Worker[]=[];let created=false,pool:Pool|undefined;
 t.after(async()=>{
  for(const child of children){if(child.process.exitCode===null&&child.process.signalCode===null)child.process.kill('SIGKILL');await child.closed;}
  try{
   if(created)await admin.query('ALTER DATABASE "'+database+'" ALLOW_CONNECTIONS true');
   await pool?.end();if(created)await admin.query('DROP DATABASE "'+database+'"');
  }finally{await admin.end();await rm(directory,{recursive:true,force:true});}
 });
 await admin.query('CREATE DATABASE "'+database+'"');created=true;
 const isolated=new URL(url);isolated.pathname='/'+database;
 pool=guardDistrictPool(new Pool({connectionString:isolated.href,max:4,connectionTimeoutMillis:5000,statement_timeout:10000}));
 const store=new DistrictJobStore(pool);await migrateDistrictJobs(pool);

 await t.test('non-executor migrate CLI reports admission failure after backend termination',async()=>{
  const blocker=await pool!.connect();await blocker.query('SELECT pg_advisory_lock(18441,1)');
  const child=worker(new URL('../src/district-r1.ts',import.meta.url),['migrate'],{...process.env,DATABASE_URL:isolated.href});children.push(child);
  try{
   let pid:number|undefined;
   await waitUntil(async()=>{const rows=await admin.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query='SELECT pg_advisory_xact_lock(18441,1)'`,[database]);pid=rows.rows[0]?.pid;return pid!==undefined;});
   assert.equal((await admin.query<{terminated:boolean}>('SELECT pg_terminate_backend($1) AS terminated',[pid])).rows[0].terminated,true);
   assert.equal(await child.closed,2,child.stderr());assertTypedFailure(child,'admission');
  }finally{await blocker.query('SELECT pg_advisory_unlock(18441,1)');blocker.release();}
 });

 async function launch(mode:string){
  const sourceId='synthetic-loss-'+randomUUID(),key=await store.enqueue({step:'verify_artifacts',lane:'cpu',semanticContractSha256:digest('synthetic-database-loss'),inputArtifactHashes:[],sourceScope:{publisherId:'synthetic',sourceId,municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'synthetic'},selector:{mode},policyProofSha256:null});
  const approval=digest('synthetic notification approval'),destination=digest('synthetic notification destination');
  const authorizationId=await store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+240000).toISOString(),jobKeys:[key],ags:['12064472'],maxJobs:1,maxElapsedMs:180000,category:'development',mode:'bounded_unattended',notificationApprovalSha256:approval,notificationDestinationSha256:destination,notificationProvider:'ntfy'});
  const workspace=join(directory,sourceId),child=worker(new URL('./helpers/database-loss-executor.ts',import.meta.url),[isolated.href,authorizationId,join(directory,'cas'),workspace,approval,destination,mode],process.env);children.push(child);
  const entered=await child.entered;assert.ok(await lstat(join(entered.stateDir,'inventory.lock')));
  return {child,entered,key,workspace};
 }
 async function terminateExecutor(runId:string):Promise<void>{
  const targets=await admin.query<{pid:number}>(`SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=$1 AND l.locktype='advisory' AND l.classid=18442 AND l.objid=(hashtext($2)::bigint & 4294967295)::oid`,[database,runId]);
  assert.equal(targets.rowCount,1);
  assert.equal((await admin.query<{terminated:boolean}>('SELECT pg_terminate_backend($1) AS terminated',[targets.rows[0].pid])).rows[0].terminated,true);
 }
 async function assertDrained(child:Worker,entered:Entered,workspace:string):Promise<void>{
  assert.equal(await child.closed,2,child.stderr());assertTypedFailure(child,'execution');assert.equal(await cleaned(workspace),true);
  await assert.rejects(lstat(join(entered.stateDir,'inventory.lock')),{code:'ENOENT'});
 }
 async function assertFinalized(key:string,runId:string):Promise<void>{
  const jobs=await pool!.query<{state:string;reason_code:string}>(`SELECT state,reason_code FROM district_pipeline.jobs WHERE job_key=$1`,[key]);assert.equal(jobs.rows[0].state,'held_execution');assert.equal(jobs.rows[0].reason_code,'lease_lost');
  const runs=await pool!.query<{state:string;reason_code:string}>('SELECT state,reason_code FROM district_pipeline.executor_runs WHERE id=$1',[runId]);assert.deepEqual(runs.rows[0],{state:'held',reason_code:'lease_lost'});
  const receipts=await pool!.query<{outcome:string;reason_code:string}>(`SELECT outcome,receipt->>'reasonCode' AS reason_code FROM district_pipeline.step_receipts WHERE run_id=$1`,[runId]);assert.equal(receipts.rowCount,1);assert.deepEqual(receipts.rows[0],{outcome:'held_execution',reason_code:'lease_lost'});
 }
 for(const mode of ['executor','checked-out','idle','query'])await t.test('terminated '+mode+' connection aborts handler and finalizes only after drain',async()=>{
  const {child,entered,key,workspace}=await launch(mode);
  if(mode==='executor')await terminateExecutor(entered.runId);
  else assert.equal((await admin.query<{terminated:boolean}>('SELECT pg_terminate_backend($1) AS terminated',[entered.backendPid])).rows[0].terminated,true);
  await assertDrained(child,entered,workspace);await assertFinalized(key,entered.runId);
 });

 await t.test('temporary database unavailability reconnects for fenced finalization without handler replay',async()=>{
  const {child,entered,key,workspace}=await launch('executor');
  await admin.query('ALTER DATABASE "'+database+'" ALLOW_CONNECTIONS false');
  try{
   await terminateExecutor(entered.runId);await waitUntil(()=>cleaned(workspace));
   // Recovery must encounter an actual rejected connection, not simply use a
   // surviving executor pool client. Its dedicated pool cannot connect yet.
   await delay(1500);assert.equal(child.process.exitCode,null);
  }finally{await admin.query('ALTER DATABASE "'+database+'" ALLOW_CONNECTIONS true');}
  await assertDrained(child,entered,workspace);await assertFinalized(key,entered.runId);
 });
 await t.test('persistent database unavailability exits within cleanup reserve and leaves existing reconciliation in charge',{timeout:90000},async()=>{
  const {child,entered,key,workspace}=await launch('executor');
  await admin.query('ALTER DATABASE "'+database+'" ALLOW_CONNECTIONS false');const start=performance.now();
  try{
   await terminateExecutor(entered.runId);await assertDrained(child,entered,workspace);
   assert.ok(performance.now()-start<75000,'Database recovery must not outlive the 60s cleanup allocation plus process shutdown');
  }finally{await admin.query('ALTER DATABASE "'+database+'" ALLOW_CONNECTIONS true');}
  const pending=await pool!.query<{state:string}>(`SELECT state FROM district_pipeline.jobs WHERE job_key=$1`,[key]);assert.equal(pending.rows[0].state,'leased');
  assert.equal((await pool!.query('SELECT id FROM district_pipeline.step_receipts WHERE run_id=$1',[entered.runId])).rowCount,0);
 });
});
