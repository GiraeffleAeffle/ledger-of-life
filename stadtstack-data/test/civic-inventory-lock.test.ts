import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,lstat,readdir,open} from 'node:fs/promises';
import {constants,promises as fs} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {assertCivicPolicyAuthority,provisionCivicPolicyAuthority,initializeManagedAcquisitionLane,withManagedSourceWrite,recoverCivicPolicyLock,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
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
 const processChild=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {assertCivicPolicyAuthority,initializeManagedAcquisitionLane,withManagedSourceWrite,withManagedSourceScratch,recoverCivicPolicyLock,withCivicPolicyShutdown,CIVIC_ACQUISITION_DECISION_ID} from ${JSON.stringify(moduleUrl)};${body}`,...args],{stdio:['pipe','pipe','pipe']});
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

for(const disposition of ['released','turnover'] as const)test('safe lock detachment during lstat retries acquisition without recovery: '+disposition,async t=>{
 const {policy,root,lock,stateDir}=await fixture(t),contents=JSON.stringify(await record());await writeFile(lock,contents,{mode:0o600});
 const originalLstat=fs.lstat,originalOpen=fs.open;let detachments=0,acquisitions=0,inspections=0;
 t.mock.method(fs,'lstat',async(...args:Parameters<typeof fs.lstat>)=>{
  if(String(args[0])===lock&&(disposition==='turnover'||!detachments)){
   const handle=await originalOpen(lock,'r');
   try{
    await rm(lock);const detached=await handle.stat();assert.equal(detached.nlink,0);detachments++;
    if(disposition==='turnover')await writeFile(lock,contents,{mode:0o600});
    return detached;
   }finally{await handle.close();}
  }
  return originalLstat(...args);
 });
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  if(String(args[0])===lock){if(Number(args[1])&constants.O_EXCL)acquisitions++;else inspections++;}
  return originalOpen(...args);
 });syncBuiltinESMExports();
 try{
  const operation=initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,lockWaitMs:disposition==='turnover'?80:3000});
  if(disposition==='turnover')await assert.rejects(operation,{code:'CIVIC_POLICY_BUSY'});else await operation;
  assert.ok(detachments>0);assert.ok(acquisitions>0);assert.equal(inspections,0,'A detached inode must never enter holder recovery');
  assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.lock.quarantine-')||name.startsWith('inventory.wait-')),false);
  if(disposition==='turnover')assert.equal(await readFile(lock,'utf8'),contents);else await assert.rejects(originalLstat(lock),{code:'ENOENT'});
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('a waiter marker detached during lstat is absent, not unsafe state',async t=>{
 const {policy,root,stateDir}=await fixture(t),marker=join(stateDir,'inventory.wait-'+randomUUID());await writeFile(marker,'',{mode:0o600});
 const originalLstat=fs.lstat;let detached=false;
 // Keep the existing cooperative-cooldown branch deterministic, without sleeps.
 t.mock.method(performance,'now',()=>0);
 t.mock.method(fs,'lstat',async(...args:Parameters<typeof fs.lstat>)=>{
  if(String(args[0])===marker){
   const handle=await open(marker,'r');
   try{await rm(marker);const stat=await handle.stat();assert.equal(stat.nlink,0);detached=true;return stat;}
   finally{await handle.close();}
  }
  return originalLstat(...args);
 });syncBuiltinESMExports();
 try{await initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID});assert.equal(detached,true);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

for(const target of ['lock','waiter','epoch'] as const)test(target+' metadata remains fail-closed even when detached',async t=>{
 const {policy,root,lock,stateDir}=await fixture(t),path=target==='lock'?lock:join(stateDir,target==='epoch'?'inventory.json':'inventory.wait-'+randomUUID());
 if(target!=='epoch')await writeFile(path,'',{mode:0o600});
 const before=await readFile(path),inventory=await readFile(join(stateDir,'inventory.json'));
 const faults=[
  {name:'nonregular',fields:{nlink:0,isFile:()=>false}},
  ...(target==='epoch'?[]:[{name:'symlink',fields:{nlink:0,isSymbolicLink:()=>true}}]),
  {name:'foreign uid',fields:{nlink:0,uid:process.getuid!()+1}},
  {name:'unsafe permissions',fields:{nlink:0,mode:0o100644}},
  {name:'oversize',fields:{nlink:0,size:512*1024*1024}},
  {name:'hardlink',fields:{nlink:2}},
 ];
 for(const fault of faults){
  const originalLstat=fs.lstat,originalOpen=fs.open;let inspected=false;
  if(target==='waiter')t.mock.method(performance,'now',()=>0);
  if(target==='epoch')t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
   const handle=await originalOpen(...args);
   if(String(args[0])===path){const stat=handle.stat;t.mock.method(handle,'stat',async(...args:Parameters<typeof handle.stat>)=>{inspected=true;return Object.assign(await stat.apply(handle,args),fault.fields);});}
   return handle;
  });
  else t.mock.method(fs,'lstat',async(...args:Parameters<typeof fs.lstat>)=>{const stat=await originalLstat(...args);if(String(args[0])===path){inspected=true;return Object.assign(stat,fault.fields);}return stat;});
  syncBuiltinESMExports();
  try{
   const operation=target==='epoch'?assertCivicPolicyAuthority(policy):initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID});
   await assert.rejects(operation,{code:target==='epoch'?'CIVIC_POLICY_INVENTORY_UNAVAILABLE':'CIVIC_POLICY_STATE_UNSAFE'},fault.name);
   assert.equal(inspected,true,fault.name);assert.deepEqual(await readFile(path),before);assert.deepEqual(await readFile(join(stateDir,'inventory.json')),inventory);
   assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.lock.quarantine-')),false);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 }
});

for(const disposition of ['budget','shutdown'] as const)test('epoch detachment retry honors its monotonic budget and shutdown: '+disposition,{timeout:15000},async t=>{
 const {policy,stateDir}=await fixture(t);
 const worker=child(t,`
  const [policyText,disposition]=process.argv.slice(1),policy=JSON.parse(policyText),path=join(policy.stateDir,'inventory.json'),bytes=await fs.readFile(path),open=fs.open,stop=new AbortController(),handles=[];let detachments=0;
  fs.open=async(...args)=>{
   const handle=await open(...args);
   if(String(args[0])===path){
    handles.push(handle);await fs.writeFile(path+'.replacement',bytes,{mode:0o600});await fs.rename(path+'.replacement',path);detachments++;
    if(disposition==='shutdown'&&detachments===9)stop.abort();
   }
   return handle;
  };syncBuiltinESMExports();
  const started=performance.now();
  if(disposition==='budget'){await assert.rejects(assertCivicPolicyAuthority({...policy,lockWaitMs:35}),{code:'CIVIC_POLICY_BUSY'});assert.ok(performance.now()-started>=35);}
  else{await assert.rejects(withCivicPolicyShutdown(()=>assertCivicPolicyAuthority(policy),stop.signal),{code:'CIVIC_POLICY_SHUTDOWN'});assert.equal(detachments,9);}
  assert.ok(detachments>0);assert.ok(handles.every(handle=>handle.fd===-1));await assert.rejects(fs.lstat(join(policy.stateDir,'inventory.lock')),{code:'ENOENT'});process.stdout.write('bounded\\n');
 `,[JSON.stringify(policy),disposition]);
 assert.equal(await worker.closed,0,worker.stderr());assert.match(worker.stdout(),/bounded/);await assert.rejects(lstat(join(stateDir,'inventory.lock')),{code:'ENOENT'});
});

test('shutdown during a detached lock retry preserves the replacement holder and never admits a root',{timeout:15000},async t=>{
 const {base,policy,lock,stateDir}=await fixture(t),contents=JSON.stringify(await record()),other=join(base,'never-created');await writeFile(lock,contents,{mode:0o600});
 const worker=child(t,`
  const [policyText,root]=process.argv.slice(1),policy=JSON.parse(policyText),lock=join(policy.stateDir,'inventory.lock'),contents=await fs.readFile(lock),lstat=fs.lstat,stop=new AbortController();let detachments=0;
  fs.lstat=async(...args)=>{
   if(String(args[0])!==lock)return lstat(...args);
   const handle=await fs.open(lock,'r');
   try{await fs.unlink(lock);const stat=await handle.stat();assert.equal(stat.nlink,0);await fs.writeFile(lock,contents,{mode:0o600});if(++detachments===2)stop.abort();return stat;}
   finally{await handle.close();}
  };syncBuiltinESMExports();
  await assert.rejects(withCivicPolicyShutdown(()=>initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID}),stop.signal),{code:'CIVIC_POLICY_SHUTDOWN'});assert.equal(detachments,2);process.stdout.write('cancelled\\n');
 `,[JSON.stringify(policy),other]);
 assert.equal(await worker.closed,0,worker.stderr());assert.match(worker.stdout(),/cancelled/);assert.equal(await readFile(lock,'utf8'),contents);
 await assert.rejects(lstat(other),{code:'ENOENT'});assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.wait-')||name.startsWith('inventory.lock.quarantine-')),false);
});

for(const stage of [1,2,3,4,5,'active'] as const)test('caller abort cancels detached epoch waiting without cancelling owned cleanup: '+stage,{timeout:15000},async t=>{
 const {base,policy,stateDir}=await fixture(t),root=join(base,'caller-cancelled'),before=await readFile(join(stateDir,'inventory.json'));
 const worker=child(t,`
  // Watchers remain real; inject active turnover only into the explicit read,
  // not their independently scheduled background authority checks.
  const {AsyncLocalStorage}=await import('node:async_hooks'),activeEpoch=new AsyncLocalStorage();
  const [policyText,root,stageText]=process.argv.slice(1),policy=JSON.parse(policyText),stage=stageText==='active'?'active':Number(stageText),path=join(policy.stateDir,'inventory.json'),open=fs.open,stop=new AbortController(),reason=Error('Synthetic caller cancellation'),handles=[];let bytes=await fs.readFile(path),reads=0,detachments=0,enabled=stage!=='active',called=false;
  fs.open=async(...args)=>{
   const handle=await open(...args);
   if(enabled&&(stage!=='active'||activeEpoch.getStore()===true)&&String(args[0])===path&&new Error().stack?.includes('requireInventoryEpoch')&&++reads>=(stage==='active'?1:stage)){
    handles.push(handle);await fs.writeFile(path+'.replacement',bytes,{mode:0o600});await fs.rename(path+'.replacement',path);
    if(++detachments===2)stop.abort(reason);
   }
   return handle;
  };syncBuiltinESMExports();
  await withCivicPolicyShutdown(async processSignal=>{
   const operation=withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://council.test/caller-abort',sourceSha256:'a'.repeat(64)}],async scope=>{
    called=true;assert.equal(stage,'active');bytes=await fs.readFile(path);enabled=true;
    try{await activeEpoch.run(true,()=>scope.assertActive());}finally{enabled=false;}
   },{...policy,kind:'artifacts',purpose:'classification',decisionId:CIVIC_ACQUISITION_DECISION_ID,signal:stop.signal,lockWaitMs:1000});
   await assert.rejects(operation,error=>error===reason);assert.equal(processSignal.aborted,false);
  });
  assert.equal(called,stage==='active');assert.equal(detachments,2);assert.ok(handles.every(handle=>handle.fd===-1));await assert.rejects(fs.lstat(join(policy.stateDir,'inventory.lock')),{code:'ENOENT'});process.stdout.write('caller-cancelled\\n');
 `,[JSON.stringify(policy),root,String(stage)]);
 assert.equal(await worker.closed,0,worker.stderr());assert.match(worker.stdout(),/caller-cancelled/);
 const after=await readFile(join(stateDir,'inventory.json'));
 if(stage==='active'){
  const inventory=JSON.parse(after.toString('utf8'));assert.equal(inventory.scratch.length,1);assert.equal(inventory.scratch[0].state,'closed');await assert.rejects(lstat(join(root,inventory.scratch[0].directory)),{code:'ENOENT'});
 }else{assert.deepEqual(after,before);await assert.rejects(lstat(root),{code:'ENOENT'});}
 assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.wait-')||name.startsWith('inventory.lock.quarantine-')),false);
});
