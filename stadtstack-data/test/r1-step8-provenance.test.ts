import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool,Client} from 'pg';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {watch,type FSWatcher} from 'node:fs';
import {NativeSealSelectionSchema,ProvenanceSupplementSelectionSchema,createCanonicalWitnessReadPool,assertProductionNativeSealCohort,ReconstructionWorkersSchema,assertReconstructionMemory,assertCanonicalEpochFinished} from '../src/r1-step8-provenance.ts';

const pin={path:'/synthetic/private/control.json',sha256:'a'.repeat(64)};
const seal={municipalityId:'synthetic',sourceId:'website',corpus:pin,output:pin,admission:'published',queue:{jobKeys:['b'.repeat(64)],reconciliationJobKeys:[]}};
test('governed native selection is pinned, ordered and has no free-standing witness authority',()=>{
 const frame={schemaVersion:'stadtstack-r1-native-seal-selection-v1',catalogue:pin,seals:[seal]};
 assert.equal(NativeSealSelectionSchema.parse(frame).seals.length,1);
 assert.throws(()=>NativeSealSelectionSchema.parse({...frame,witnesses:[{output:pin,provenance:pin}]}));
 assert.throws(()=>NativeSealSelectionSchema.parse({...frame,seals:[]}));
 assert.throws(()=>NativeSealSelectionSchema.parse({...frame,seals:[{...seal,output:{...pin,path:'/synthetic/../alias'}}]}));
 assert.throws(()=>NativeSealSelectionSchema.parse({...frame,issuedAt:''}),'issuance is a separately reviewed lead-action wrapper, not invented frame metadata');
});
test('supplements require independent inventory and exact-witness attestation pins',()=>{
 const selected={inventory:pin,attestation:{...pin,path:'/synthetic/private/attestation.json'},targets:['c'.repeat(64)]};
 assert.deepEqual(ProvenanceSupplementSelectionSchema.parse(selected),selected);
 assert.throws(()=>ProvenanceSupplementSelectionSchema.parse({...pin,targets:selected.targets}));
 assert.throws(()=>ProvenanceSupplementSelectionSchema.parse({...selected,attestation:undefined}));
});
test('real socket DSNs default omitted ports and never inherit injected clients or GUC overrides',async()=>{
 class ForbiddenClient extends Client {constructor(){super();assert.fail('Caller client must never be constructed');}}
 for(const [url,port] of [['postgresql:///civic_r1?host=/var/run/postgresql',5432],['postgresql:///civic_r1?host=/var/run/postgresql&port=55432',55432]] as const){
  const caller=new Pool({connectionString:url,Client:ForbiddenClient,options:'-c default_transaction_read_only=off'}),reader=createCanonicalWitnessReadPool(caller.options);
  try{assert.equal(reader.options.port,port);assert.equal(reader.options.host,'/var/run/postgresql');assert.equal(reader.options.database,'civic_r1');assert.equal(reader.options.options,'-c default_transaction_read_only=on');assert.equal(reader.options.Client,undefined);assert.equal(reader.options.connectionString,undefined);}finally{await reader.end();await caller.end();}
 }
 assert.throws(()=>createCanonicalWitnessReadPool(new Pool({connectionString:'postgresql:///civic_r1?host=/var/run/postgresql&port=0'}).options));
});
test('canonical reconstruction is bounded to one–three workers and refuses unsafe memory headroom',()=>{
 assert.equal(ReconstructionWorkersSchema.parse(undefined),3);
 for(const workers of [1,2,3]){
  assert.equal(ReconstructionWorkersSchema.parse(workers),workers);
  const requiredKiB=(workers*1.5+4)*1024**2;
  assert.equal(assertReconstructionMemory(workers,`MemAvailable: ${requiredKiB} kB\n`).requiredBytes,requiredKiB*1024);
  assert.throws(()=>assertReconstructionMemory(workers,`MemAvailable: ${requiredKiB-1} kB\n`),/memory refused/);
 }
 for(const workers of [0,4,1.5,NaN])assert.throws(()=>ReconstructionWorkersSchema.parse(workers));
 assert.throws(()=>assertReconstructionMemory(1,'MemFree: 999999999 kB\n'),/MemAvailable/);
 assert.throws(()=>assertCanonicalEpochFinished({witnesses:27,reconstructionWorkers:3,checkpoint:async()=>{},finish:async()=>{}}),/successfully finished/,'a caller-authored passed object cannot authorize staging writes');
});
test('production step8 requires exactly the complete published 27-source cohort',()=>{
 const sources=Array.from({length:27},(_,index)=>({municipalityId:'synthetic-'+index,sourceId:'synthetic-source-'+index}));
 const catalogue={rows:sources.map(scope=>({scope}))},published=NativeSealSelectionSchema.parse({schemaVersion:'stadtstack-r1-native-seal-selection-v1',catalogue:pin,seals:sources.map((source,index)=>({...seal,...source,output:{path:'/synthetic/output-'+index,sha256:index.toString(16).padStart(64,'0')},admission:'published'}))});
 assert.doesNotThrow(()=>assertProductionNativeSealCohort(published,catalogue));
 assert.throws(()=>assertProductionNativeSealCohort({...published,seals:published.seals.slice(0,25)},catalogue),/complete 27-source/,'historical partial25 is not publication authority');
 assert.throws(()=>assertProductionNativeSealCohort({...published,seals:[...published.seals.slice(0,26),published.seals[0]]},catalogue),/complete 27-source/);
 assert.throws(()=>assertProductionNativeSealCohort({...published,seals:published.seals.map((entry,index)=>index===0?{...entry,sourceId:'unlisted-source'}:entry)},catalogue),/complete 27-source/);
 assert.throws(()=>assertProductionNativeSealCohort(published,{rows:[...catalogue.rows.slice(0,26),catalogue.rows[0]]}),/complete 27-source/);
 const candidate=structuredClone(published);candidate.seals[26].admission='adoption_candidate';
 assert.throws(()=>assertProductionNativeSealCohort(candidate,catalogue),/all 27 published/);
});
// Positive canonical receipt/ancillary-role and negative operator-authored proof,
// alias/reordering/no-op-witness/epoch regressions run in the real disposable-PG
// topology fixture via helpers/step8-provenance-fixture.ts. Enrolling synthetic
// JSON alone is deliberately no longer a positive authentication fixture.

// Integration deadline only: fake time cannot drive real OS process/IPC/PG loss.
// Success waits on actual file/exit events, never a guessed sleep.
async function bounded<T>(work:Promise<T>,ms:number){
 let timer:NodeJS.Timeout|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Worker lifecycle deadline exceeded')),ms);})]);}
 finally{clearTimeout(timer);}
}
for(const loss of ['parent','database'] as const)test(`CPU-starved reconstruction supervisor exits on ${loss} loss without an orphan`,{skip:!process.env.DISTRICT_TEST_DATABASE_URL,timeout:15000},async()=>{
 const url=new URL(process.env.DISTRICT_TEST_DATABASE_URL!);assert.notEqual(url.pathname,'/civic_r1');assert.ok(url.searchParams.get('host')?.startsWith('/tmp/'));
 const admin=new Pool({connectionString:url.href,user:userInfo().username,max:1}),database='r1_supervisor_'+randomUUID().replaceAll('-',''),root=await mkdtemp(join(tmpdir(),'r1-supervisor-test-'));
 let child:ReturnType<typeof fork>|undefined,closed:Promise<unknown>|undefined,watcher:FSWatcher|undefined;
 try{
  await admin.query('CREATE DATABASE \"'+database+'\"');url.pathname='/'+database;
  const marker=join(root,'busy-thread');
  watcher=watch(root);const ready=new Promise<void>((accept,reject)=>{watcher!.on('error',reject);watcher!.on('change',(_event,name)=>{if(name?.toString()==='busy-thread')accept();});});
  const {NODE_TEST_CONTEXT:_,...env}=process.env;
  child=fork(fileURLToPath(new URL('./fixtures/step8-supervisor-parent.ts',import.meta.url)),[marker],{execArgv:['--experimental-strip-types'],env:{...env,DISTRICT_TEST_DATABASE_URL:url.href},stdio:['ignore','ignore','inherit','ipc']});
  closed=once(child,'exit');const pid=child.pid;assert.ok(pid);
  await bounded(ready,5000);assert.equal(Number(await readFile(marker,'utf8')),pid);
  // The marker is written immediately before an infinite CPU loop in the real
  // reconstruction thread; its supervisor must remain independently responsive.
  const started=Date.now();
  if(loss==='parent')child.disconnect();
  else{
   const rows=(await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name=$2',[database,'r1-reconstruction-liveness'])).rows;
   assert.equal(rows.length,1);assert.equal((await admin.query('SELECT pg_terminate_backend($1) AS stopped',[rows[0].pid])).rows[0].stopped,true);
  }
  const result=await bounded(closed,5000) as [number|null,NodeJS.Signals|null];
  assert.equal(result[0],1);assert.ok(Date.now()-started<5000);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{
  watcher?.close();
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await closed?.catch(()=>{});await admin.query('DROP DATABASE IF EXISTS "'+database+'" WITH (FORCE)');await admin.end();await rm(root,{recursive:true,force:true});
 }
});
