import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,lstat,readdir,open} from 'node:fs/promises';
import {promises as fs} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {provisionCivicPolicyAuthority,initializeManagedAcquisitionLane,withManagedSourceWrite,recoverCivicPolicyLock,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
import type {ManagedSourceContent} from '../src/civic-opt-out.ts';

const moduleUrl=new URL('../src/civic-opt-out.ts',import.meta.url).href;
async function fixture(t:TestContext){
 const base=await realpath(await mkdtemp(join(tmpdir(),'civic-lock-holder-'))),stateDir=join(base,'policy'),root=join(base,'fetch');
 t.after(()=>rm(base,{recursive:true,force:true}));
 const authority=await provisionCivicPolicyAuthority({stateDir,authorityId:'fixture:'+randomUUID()}),policy={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 await initializeManagedAcquisitionLane(root,{...policy,kind:'fetch',decisionId:CIVIC_ACQUISITION_DECISION_ID});
 const sha256=createHash('sha256').update('synthetic holder content').digest('hex');
 const entry:ManagedSourceContent={kind:'http_observation',relativePath:'sha256/'+sha256,contentSha256:sha256,sourceSha256:sha256,url:'https://council.test/holder',observationId:sha256,receiptSha256:sha256,independentAllowed:false};
 await withManagedSourceWrite(root,[entry],async()=>{await mkdir(join(root,'sha256'),{mode:0o700});await writeFile(join(root,entry.relativePath),'synthetic holder content',{mode:0o600});},policy);
 return {base,stateDir,root,policy,entry,lock:join(stateDir,'inventory.lock')};
}
async function record(){
 const text=await readFile(`/proc/${process.pid}/stat`,'utf8');
 return {pid:process.pid,nonce:randomUUID(),boot_id:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),starttime:text.slice(text.lastIndexOf(')')+2).split(/\s+/)[19]!};
}
function child(t:TestContext,body:string,args:string[]=[]){
 const processChild=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {initializeManagedAcquisitionLane,withManagedSourceWrite,recoverCivicPolicyLock,withCivicPolicyShutdown,CIVIC_ACQUISITION_DECISION_ID} from ${JSON.stringify(moduleUrl)};${body}`,...args],{stdio:['pipe','pipe','pipe']});
 const closed=Promise.withResolvers<number|null>();let stdout='',stderr='';
 processChild.stdout.on('data',chunk=>{stdout+=chunk;});processChild.stderr.on('data',chunk=>{stderr+=chunk;});
 processChild.once('error',closed.reject);processChild.once('close',closed.resolve);
 t.after(async()=>{if(processChild.exitCode===null&&processChild.signalCode===null)processChild.kill('SIGKILL');await closed.promise;});
 return {process:processChild,closed:closed.promise,stdout:()=>stdout,stderr:()=>stderr};
}
function line(processChild:ChildProcessWithoutNullStreams,expected:string):Promise<void>{
 const arrived=Promise.withResolvers<void>();let output='';
 const receive=(chunk:Buffer)=>{output+=chunk;if(output.split('\n').includes(expected)){processChild.stdout.removeListener('data',receive);arrived.resolve();}};
 processChild.stdout.on('data',receive);processChild.once('close',()=>arrived.reject(Error('Child closed before '+expected)));
 return arrived.promise;
}

test('holder record binds actual Linux boot and pid starttime; a live holder is never recovered',async t=>{
 const {root,policy,entry,lock,stateDir}=await fixture(t),expected=await record();
 await withManagedSourceWrite(root,[entry],async()=>{
  const actual=JSON.parse(await readFile(lock,'utf8'));assert.equal(actual.boot_id,expected.boot_id);assert.equal(actual.starttime,expected.starttime);assert.equal(actual.pid,process.pid);
 },policy);
 await writeFile(lock,JSON.stringify(expected),{mode:0o600});const identity=await lstat(lock);
 assert.equal((await recoverCivicPolicyLock(policy)).reasonCode,'HOLDER_ALIVE_OR_UNPROVEN');
 await assert.rejects(initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,lockWaitMs:50}),{code:'CIVIC_POLICY_BUSY'});
 assert.equal((await lstat(lock)).ino,identity.ino);assert.equal((await readdir(stateDir)).filter(name=>name.includes('quarantine')).length,0);
});

for(const evidence of ['pid-absent','different-boot','pid-reused'] as const)test('provably dead holder is quarantined without blessing inventory: '+evidence,async t=>{
 const {root,policy,lock,stateDir}=await fixture(t),owner=await record();
 if(evidence==='pid-absent'){
  const exited=child(t,'');owner.pid=exited.process.pid!;assert.equal(await exited.closed,0);await assert.rejects(readFile(`/proc/${owner.pid}/stat`),{code:'ENOENT'});
 }else if(evidence==='different-boot')owner.boot_id=randomUUID();
 else owner.starttime=String(BigInt(owner.starttime)+1n);
 const bytes=JSON.stringify(owner),inventory=await readFile(join(stateDir,'inventory.json'));await writeFile(lock,bytes,{mode:0o600});
 const receipt=await recoverCivicPolicyLock(policy);assert.equal(receipt.status,'recovered');assert.equal(receipt.legacy,false);
 assert.deepEqual(await readFile(join(stateDir,'inventory.json')),inventory);
 const quarantine=(await readdir(stateDir)).filter(name=>name.startsWith('inventory.lock.quarantine-'));assert.equal(quarantine.length,1);assert.equal(await readFile(join(stateDir,quarantine[0]!), 'utf8'),bytes);
 await writeFile(join(root,'foreign-source'),'unregistered',{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID}),{code:'MANAGED_INVENTORY_INCOMPLETE'});
 assert.equal(await readFile(join(root,'foreign-source'),'utf8'),'unregistered');
});

test('ordinary waiter automatically recovers a new-format dead holder',async t=>{
 const {root,policy,lock,stateDir}=await fixture(t),owner=await record();owner.boot_id=randomUUID();
 await writeFile(lock,JSON.stringify(owner),{mode:0o600});
 await initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,lockWaitMs:3000});
 await assert.rejects(lstat(lock),{code:'ENOENT'});assert.equal((await readdir(stateDir)).filter(name=>name.startsWith('inventory.lock.quarantine-')).length,1);
});

test('two breakers serialize, and a subsequent live holder cannot be quarantined', {timeout:15000},async t=>{
 const {root,policy,entry,lock,stateDir}=await fixture(t),owner=await record();owner.boot_id=randomUUID();await writeFile(lock,JSON.stringify(owner),{mode:0o600});
 const first=child(t,`const [root,policyText,entryText]=process.argv.slice(1),policy=JSON.parse(policyText),rename=fs.rename;fs.rename=async(...args)=>{if(String(args[0])===join(policy.stateDir,'inventory.lock')){process.stdout.write('breaking\\n');const gate=Promise.withResolvers();process.stdin.once('data',gate.resolve);await gate.promise;}return rename(...args);};syncBuiltinESMExports();await recoverCivicPolicyLock(policy);await withManagedSourceWrite(root,[JSON.parse(entryText)],async()=>{process.stdout.write('holding\\n');const gate=Promise.withResolvers();process.stdin.once('data',gate.resolve);await gate.promise;},policy);`,[root,JSON.stringify(policy),JSON.stringify(entry)]);
 await line(first.process,'breaking');
 const second=child(t,`process.stdout.write(JSON.stringify(await recoverCivicPolicyLock(JSON.parse(process.argv[1])))+'\\n');`,[JSON.stringify(policy)]);
 assert.equal(await second.closed,0,second.stderr());assert.equal(JSON.parse(second.stdout()).reasonCode,'RECOVERY_MUTEX_BUSY');
 const holding=line(first.process,'holding');first.process.stdin.write('release-break');await holding;
 const current=await readFile(lock);assert.equal((await recoverCivicPolicyLock(policy)).reasonCode,'HOLDER_ALIVE_OR_UNPROVEN');assert.deepEqual(await readFile(lock),current);
 first.process.stdin.end('release-holder');assert.equal(await first.closed,0,first.stderr());assert.equal((await readdir(stateDir)).filter(name=>name.startsWith('inventory.lock.quarantine-')).length,1);
});

test('a killed breaker cannot strand its kernel break mutex', {timeout:15000},async t=>{
 const {root,policy,lock}=await fixture(t),owner=await record();owner.boot_id=randomUUID();await writeFile(lock,JSON.stringify(owner),{mode:0o600});
 const breaker=child(t,`const policy=JSON.parse(process.argv[1]),rename=fs.rename;fs.rename=async(...args)=>{if(String(args[0])===join(policy.stateDir,'inventory.lock')){process.stdout.write('breaking\\n');await new Promise(()=>{});}return rename(...args);};syncBuiltinESMExports();await recoverCivicPolicyLock(policy);`,[JSON.stringify(policy)]);
 await line(breaker.process,'breaking');breaker.process.kill('SIGKILL');await breaker.closed;
 await initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,lockWaitMs:3000});await assert.rejects(lstat(lock),{code:'ENOENT'});
});

test('replacement between initial inspection and break-mutex acquisition is never moved',async t=>{
 const {policy,lock,stateDir}=await fixture(t),dead=await record(),live=await record();dead.boot_id=randomUUID();await writeFile(lock,JSON.stringify(dead),{mode:0o600});
 const originalOpen=fs.open;let swapped=false;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const handle=await originalOpen(...args);if(String(args[0])===join(stateDir,'inventory.break.lock')&&!swapped){swapped=true;await rm(lock);await writeFile(lock,JSON.stringify(live),{mode:0o600});}return handle;});syncBuiltinESMExports();
 try{assert.equal((await recoverCivicPolicyLock(policy)).reasonCode,'LOCK_REPLACED');assert.deepEqual(JSON.parse(await readFile(lock,'utf8')),live);assert.equal((await readdir(stateDir)).filter(name=>name.includes('quarantine')).length,0);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('legacy repair is explicit and refuses open descriptors or incomplete /proc visibility',async t=>{
 const {base,root,policy,lock,stateDir}=await fixture(t),exited=child(t,'');assert.equal(await exited.closed,0);
 const legacy={pid:exited.process.pid!,nonce:randomUUID()},bytes=JSON.stringify(legacy);await writeFile(lock,bytes,{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,lockWaitMs:50}),{code:'CIVIC_POLICY_BUSY'});assert.equal(await readFile(lock,'utf8'),bytes);
 // Restrict this test's process catalogue to its own real /proc/<pid>/fd tree;
 // production scans every process and refuses inaccessible descriptors.
 const catalogue=join(base,'proc');await mkdir(join(catalogue,String(process.pid)),{recursive:true,mode:0o700});
 const opendir=fs.opendir,stat=fs.stat;t.mock.method(fs,'opendir',async(...args:Parameters<typeof fs.opendir>)=>opendir(String(args[0])==='/proc'?catalogue:args[0],args[1]));syncBuiltinESMExports();
 const descriptor=await open(lock,'r');
 try{
  assert.equal((await recoverCivicPolicyLock(policy)).reasonCode,'LOCK_OPEN_OR_UNINSPECTABLE');await descriptor.close();
  t.mock.method(fs,'stat',async(...args:Parameters<typeof fs.stat>)=>{if(String(args[0]).startsWith(`/proc/${process.pid}/fd/`))throw Object.assign(Error('fixture visibility denied'),{code:'EACCES'});return stat(...args);});syncBuiltinESMExports();
  assert.equal((await recoverCivicPolicyLock(policy)).reasonCode,'LOCK_OPEN_OR_UNINSPECTABLE');
  t.mock.restoreAll();t.mock.method(fs,'opendir',async(...args:Parameters<typeof fs.opendir>)=>opendir(String(args[0])==='/proc'?catalogue:args[0],args[1]));syncBuiltinESMExports();
  const inventory=await readFile(join(stateDir,'inventory.json')),receipt=await recoverCivicPolicyLock(policy);assert.equal(receipt.status,'recovered');assert.equal(receipt.legacy,true);assert.deepEqual(await readFile(join(stateDir,'inventory.json')),inventory);
 }finally{await descriptor.close();t.mock.restoreAll();syncBuiltinESMExports();}
});

for(const termination of ['SIGTERM','SIGINT'] as const)test(termination+' drains an owned section and refuses queued/new sections', {timeout:15000},async t=>{
 const {base,root,policy,entry,lock}=await fixture(t),other=join(base,'never-created');
 const worker=child(t,`const [root,policyText,entryText,other]=process.argv.slice(1),policy=JSON.parse(policyText);await withCivicPolicyShutdown(async signal=>{await withManagedSourceWrite(root,[JSON.parse(entryText)],async()=>{const pending=initializeManagedAcquisitionLane(other,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID});const stopped=Promise.withResolvers();signal.addEventListener('abort',stopped.resolve,{once:true});process.stdout.write('holding\\n');await stopped.promise;await assert.rejects(pending,{code:'CIVIC_POLICY_SHUTDOWN'});process.stdout.write('stopped\\n');const gate=Promise.withResolvers();process.stdin.once('data',gate.resolve);await gate.promise;},policy);await assert.rejects(initializeManagedAcquisitionLane(other,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID}),{code:'CIVIC_POLICY_SHUTDOWN'});});process.stdout.write('done\\n');`,[root,JSON.stringify(policy),JSON.stringify(entry),other]);
 await line(worker.process,'holding');const identity=await lstat(lock),stopped=line(worker.process,'stopped');worker.process.kill(termination);await stopped;
 assert.equal(worker.process.exitCode,null);assert.equal((await lstat(lock)).ino,identity.ino);await assert.rejects(lstat(other),{code:'ENOENT'});
 worker.process.stdin.end('finish-owned-work');assert.equal(await worker.closed,0,worker.stderr());assert.match(worker.stdout(),/done/);await assert.rejects(lstat(lock),{code:'ENOENT'});
});

test('missing boot evidence never turns a live pid into a dead-holder proof',async t=>{
 const {policy,lock}=await fixture(t),owner=await record();await writeFile(lock,JSON.stringify(owner),{mode:0o600});
 const original=fs.readFile;t.mock.method(fs,'readFile',async(...args:Parameters<typeof fs.readFile>)=>{if(String(args[0])==='/proc/sys/kernel/random/boot_id')throw Object.assign(Error('fixture proc unavailable'),{code:'ENOENT'});return original(...args);});syncBuiltinESMExports();
 try{assert.equal((await recoverCivicPolicyLock(policy)).reasonCode,'HOLDER_ALIVE_OR_UNPROVEN');assert.deepEqual(JSON.parse(await readFile(lock,'utf8')),owner);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('TERM cancels an external waiter without touching its holder or creating a root',{timeout:15000},async t=>{
 const {base,policy,lock,stateDir}=await fixture(t),owner=await record(),other=join(base,'never-created');await writeFile(lock,JSON.stringify(owner),{mode:0o600});const identity=await lstat(lock);
 const worker=child(t,`const [root,policyText]=process.argv.slice(1),policy=JSON.parse(policyText),open=fs.open;fs.open=async(...args)=>{const h=await open(...args);if(String(args[0]).includes('/inventory.wait-'))process.stdout.write('waiting\\n');return h;};syncBuiltinESMExports();try{await withCivicPolicyShutdown(()=>initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID}));}catch(error){assert.equal(error.code,'CIVIC_POLICY_SHUTDOWN');process.stdout.write('cancelled\\n');}`, [other,JSON.stringify(policy)]);
 await line(worker.process,'waiting');worker.process.kill('SIGTERM');assert.equal(await worker.closed,0,worker.stderr());assert.match(worker.stdout(),/cancelled/);
 assert.equal((await lstat(lock)).ino,identity.ino);assert.deepEqual(JSON.parse(await readFile(lock,'utf8')),owner);await assert.rejects(lstat(other),{code:'ENOENT'});assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.wait-')),false);
});

test('a released lock detached between open and fstat is contention, never unsafe-state or a dead-holder proof',async t=>{
 const {policy,root,lock,stateDir}=await fixture(t),owner=await record(),replacement=await record();await writeFile(lock,JSON.stringify(owner),{mode:0o600});
 const original=fs.open;let detached=false;
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const handle=await original(...args);
  if(String(args[0])===lock&&!detached){detached=true;await rm(lock);await writeFile(lock,JSON.stringify(replacement),{mode:0o600});}
  return handle;
 });syncBuiltinESMExports();
 try{
  assert.equal((await recoverCivicPolicyLock(policy)).reasonCode,'LOCK_REPLACED');assert.equal(detached,true);
  await assert.rejects(initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,lockWaitMs:50}),{code:'CIVIC_POLICY_BUSY'});
  assert.deepEqual(JSON.parse(await readFile(lock,'utf8')),replacement);assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.lock.quarantine-')),false);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
