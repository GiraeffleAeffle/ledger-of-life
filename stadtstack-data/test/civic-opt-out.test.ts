import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,lstat,readdir,symlink,link,rename,chmod} from 'node:fs/promises';
import {watch,promises as fsPromises} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {assertHostNotOptedOut,readCivicOptOutSnapshot,registerManagedCacheRoot,initializeManagedAcquisitionLane,CIVIC_ACQUISITION_DECISION_ID,recordHostOptOut,purgeOptedOutHost,recordManagedSourceContent,withManagedSourceWrite,markManagedCacheInventoryComplete,relinquishManagedSourceContent,HostOptedOutError,CivicPolicyStateError,civicOptOutMain} from '../src/civic-opt-out.ts';
import type {ManagedSourceContent} from '../src/civic-opt-out.ts';

const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const now='2026-10-11T12:00:00.000Z';
async function sandbox(t:TestContext){
 const base=await realpath(await mkdtemp(join(tmpdir(),'civic-opt-out-synthetic-')));
 t.after(()=>rm(base,{recursive:true,force:true}));
 return {base,root:join(base,'fetch'),stateDir:join(base,'policy')};
}
function rawEntry(bytes:string,url='https://council.test/document',independentAllowed=false):ManagedSourceContent{
 const sha256=hash(bytes);return {relativePath:'sha256/'+sha256,contentSha256:sha256,sourceSha256:sha256,url,observationId:hash(url),receiptSha256:hash('receipt:'+url+sha256),independentAllowed};
}
async function publish(root:string,entry:ManagedSourceContent,bytes:string,stateDir:string){
 const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')),managed=inventory.roots.find((item:{path:string})=>item.path===root);assert.ok(managed);
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:managed.kind,stateDir});
 await withManagedSourceWrite(root,[entry],async()=>{await mkdir(dirname(join(root,entry.relativePath)),{recursive:true,mode:0o700});await writeFile(join(root,entry.relativePath),bytes,{mode:0o600});},{stateDir});
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';return JSON.stringify(value);
}
function preparedFixture(hosts=['council.test']){
 const sourceSha256=hash('synthetic source'),text='Synthetic full source text retained only in temporary regression fixtures.';
 const body={version:'district-prepared-v1',municipalityId:'synthetic',sourceSha256,sourceBytes:16,mimeType:'text/plain',references:hosts.map(host=>({id:hash(host),url:'https://'+host+'/document',sha256:sourceSha256,retrievedAt:now,locator:'fixture',mimeType:'text/plain',sourceType:'council',policy:{access:'public',robots:{state:'allowed',url:'https://'+host+'/robots.txt'},tdm:{state:'not_declared',evidence:[]},legalClassification:'not_assessed',publication:'facts_with_attribution_only'}})),extractorSha256:hash('extractor'),toolVersions:{node:'22'},text,textSha256:hash(text),offsetUnit:'utf16_code_units',textLength:text.length,method:'text',ocrUsed:false,limitations:[]};
 return {...body,receiptSha256:hash(canonical(body))};
}

test('host assertion is read-only on absent state, canonicalizes DNS and blocks exact host across schemes',async t=>{
 const {stateDir}=await sandbox(t);await assertHostNotOptedOut('https://council.test/a',{stateDir});await assert.rejects(lstat(stateDir),{code:'ENOENT'});
 t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});
 const receipt=await recordHostOptOut({host:'COUNCIL.TEST.',reason:'municipality_objection',reference:'case-opaque-1'},{stateDir});
 assert.equal(receipt.host,'council.test');assert.equal(receipt.purgeDueAt,'2026-10-18T12:00:00.000Z');assert.equal(receipt.purge.status,'partial');assert.equal(receipt.purge.issues[0].code,'no_managed_roots');
 for(const url of ['https://council.test/a','http://COUNCIL.TEST./b'])await assert.rejects(assertHostNotOptedOut(url,{stateDir}),HostOptedOutError);
 await assertHostNotOptedOut('https://other.council.test/a',{stateDir});
 assert.equal((await lstat(stateDir)).mode&0o777,0o700);
 assert.equal((await lstat(join(stateDir,'hosts',hash('council.test')+'.json'))).mode&0o777,0o600);
});

test('registration synchronously purges verified source copies, keeps only safe audit hashes, and never extends a deadline',async t=>{
 const {base,root,stateDir}=await sandbox(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});
 await registerManagedCacheRoot(root,{kind:'fetch',stateDir});
 const bytes='SOURCE_BODY_NEVER_COPY_TO_AUDIT',entry=rawEntry(bytes);await publish(root,entry,bytes,stateDir);
 const unrelated=join(base,'unrelated.txt');await writeFile(unrelated,'unrelated user file',{mode:0o600});
 const first=await recordHostOptOut({host:'council.test',reason:'rights_holder_objection',receivedAt:'2026-10-10T00:00:00.000Z'},{stateDir});
 assert.equal(first.purge.status,'purged');assert.equal(first.purge.deletedFiles,1);assert.equal(first.purge.removedReferences,1);
 await assert.rejects(lstat(join(root,entry.relativePath)),{code:'ENOENT'});assert.equal(await readFile(unrelated,'utf8'),'unrelated user file');
 const second=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(second.purgeDueAt,first.purgeDueAt);assert.equal(second.purge.deletedFiles,0);
 for(const path of [join(stateDir,'inventory.json'),...((await readdir(join(stateDir,'attempts'))).map(name=>join(stateDir,'attempts',name)))])assert.equal((await readFile(path,'utf8')).includes(bytes),false);
 await assert.rejects(publish(root,entry,bytes,stateDir),HostOptedOutError);
});

test('past objections retain their overdue deadline and earlier repeat registration tightens it even with a busy purge lock',async t=>{
 const {root,stateDir}=await sandbox(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});
 await registerManagedCacheRoot(root,{kind:'fetch',stateDir});await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});
 const lock=join(stateDir,'inventory.lock');await writeFile(lock,'operator-held',{mode:0o600});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection',receivedAt:'2026-09-01T00:00:00.000Z'},{stateDir});
 assert.equal(receipt.purge.status,'error');assert.equal(receipt.purgeDueAt,'2026-09-08T00:00:00.000Z');assert.equal(receipt.purge.issues[0].code,'inventory_busy');
 assert.equal(await readFile(lock,'utf8'),'operator-held');await rm(lock);
 assert.equal((await purgeOptedOutHost('council.test',{stateDir})).purgeDueAt,'2026-09-08T00:00:00.000Z');
 await assert.rejects(recordHostOptOut({host:'future.test',reason:'municipality_objection',receivedAt:'2026-10-12T00:00:00.000Z'},{stateDir}),CivicPolicyStateError);
});

test('an objection blocks immediately while a producer holds the inventory lock and awaits synchronous purge',async t=>{
 const {root,stateDir}=await sandbox(t);await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir});
 const entry=rawEntry('in-flight'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const writing=withManagedSourceWrite(root,[entry],async()=>{entered.resolve();await release.promise;await mkdir(join(root,'sha256'),{mode:0o700});await writeFile(join(root,entry.relativePath),'in-flight',{mode:0o600});},{stateDir});
 await entered.promise;
 const marker=hash('council.test')+'.json',visible=Promise.withResolvers<void>();
 const watcher=watch(join(stateDir,'hosts'),(_event,name)=>{if(String(name)===marker)visible.resolve();});t.after(()=>watcher.close());
 let finished=false;const recording=recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir}).then(value=>{finished=true;return value;});
 await visible.promise;
 // Publication may briefly be between link and unlink; either explicit objection
 // or unsafe transitional state must fail closed, never an allowed acquisition.
 await assert.rejects(assertHostNotOptedOut(entry.url,{stateDir}));assert.equal(finished,false);
 const rejected=assert.rejects(writing,HostOptedOutError);release.resolve();await rejected;
 const receipt=await recording;assert.equal(receipt.purge.deletedFiles,1);await assert.rejects(lstat(join(root,entry.relativePath)),{code:'ENOENT'});
});

test('concurrent owner registrations do not overwrite different host objections or lose inventory roots',async t=>{
 const {base,stateDir}=await sandbox(t);
 await Promise.all(Array.from({length:8},(_,i)=>registerManagedCacheRoot(join(base,'cache-'+i),{kind:'fetch',stateDir})));
 await Promise.all(Array.from({length:8},(_,i)=>recordHostOptOut({host:'host'+i+'.test',reason:'municipality_objection'},{stateDir})));
 for(let i=0;i<8;i++)await assert.rejects(assertHostNotOptedOut('https://host'+i+'.test/source',{stateDir}),HostOptedOutError);
 assert.equal(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).roots.length,8);
});

test('shared raw CAS keeps genuinely independent provenance and cannot become an opted-out host fallback',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root,{kind:'fetch',stateDir});
 const bytes='shared raw',first=rawEntry(bytes),second=rawEntry(bytes,'https://independent.test/source',true);
 await publish(root,first,bytes,stateDir);await publish(root,second,bytes,stateDir);
 const one=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});
 assert.equal(one.purge.status,'purged');assert.equal(one.purge.deletedFiles,0);assert.equal(one.purge.retainedSharedFiles,1);assert.equal(one.purge.retainedSharedBytes,Buffer.byteLength(bytes));
 assert.equal(await readFile(join(root,first.relativePath),'utf8'),bytes);await assert.rejects(assertHostNotOptedOut(first.url,{stateDir}),HostOptedOutError);await assertHostNotOptedOut(second.url,{stateDir});
 const two=await recordHostOptOut({host:'independent.test',reason:'rights_holder_objection'},{stateDir});assert.equal(two.purge.deletedFiles,1);
 await assert.rejects(lstat(join(root,first.relativePath)),{code:'ENOENT'});
});

test('same observation or unpermitted sharing cannot manufacture independent allowed provenance',async t=>{
 const {base,stateDir}=await sandbox(t);
 for(const [label,permitted,sameObservation] of [['unpermitted',false,false],['rebound',true,true]] as const){
  const root=join(base,label);await registerManagedCacheRoot(root,{kind:'fetch',stateDir});const bytes=label,first=rawEntry(bytes,'https://'+label+'.test/doc'),second=rawEntry(bytes,'https://other-'+label+'.test/doc',permitted);
  if(sameObservation)second.observationId=first.observationId;
  await publish(root,first,bytes,stateDir);await publish(root,second,bytes,stateDir);
  const receipt=await recordHostOptOut({host:label+'.test',reason:'municipality_objection'},{stateDir});assert.equal(receipt.purge.retainedSharedFiles,0);assert.equal(receipt.purge.deletedFiles,1);
 }
});

test('automatic fetch inventory binds immutable observations, retains public metadata and detects orphan raw copies',async t=>{
 const {root,stateDir}=await sandbox(t),bytes='legacy known source',sha256=hash(bytes);
 await mkdir(join(root,'sha256'),{recursive:true,mode:0o700});await mkdir(join(root,'observations'),{mode:0o700});await mkdir(join(root,'requests'),{mode:0o700});
 await writeFile(join(root,'sha256',sha256),bytes,{mode:0o600});
 const observation={url:'https://council.test/doc',method:'GET',state:'fetched',checkedAt:now,retrievedAt:now,sha256,mimeType:'text/plain',bytes:bytes.length};
 const observationPath=join(root,'observations','fixture.json'),requestPath=join(root,'requests',hash('request')+'.json');await writeFile(observationPath,JSON.stringify(observation),{mode:0o600});await writeFile(requestPath,JSON.stringify(observation),{mode:0o600});
 await registerManagedCacheRoot(root,{kind:'fetch',stateDir});await markManagedCacheInventoryComplete(root,{stateDir});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(receipt.purge.status,'purged');assert.equal(receipt.purge.deletedFiles,1);assert.equal(JSON.parse(await readFile(observationPath,'utf8')).sha256,sha256);assert.equal(JSON.parse(await readFile(requestPath,'utf8')).sha256,sha256);
 const orphan='orphan';await writeFile(join(root,'sha256',hash(orphan)),orphan,{mode:0o600});await registerManagedCacheRoot(root,{kind:'fetch',stateDir});await assert.rejects(markManagedCacheInventoryComplete(root,{stateDir}),CivicPolicyStateError);
 assert.equal((await purgeOptedOutHost('council.test',{stateDir})).status,'partial');assert.equal(await readFile(join(root,'sha256',hash(orphan)),'utf8'),orphan);
});

test('known prepared full-text receipts auto-enroll, and shared prepared references require rebuild rather than a false purge',async t=>{
 const {base,stateDir}=await sandbox(t);
 for(const hosts of [['single.test'],['shared.test','independent.test']]){
  const root=join(base,hosts[0]),receipt=preparedFixture(hosts),path=join(root,receipt.receiptSha256+'.json');await mkdir(root,{mode:0o700});await writeFile(path,JSON.stringify(receipt)+'\n',{mode:0o600});
  await registerManagedCacheRoot(root,{kind:'prepared',stateDir});await markManagedCacheInventoryComplete(root,{stateDir});
  const result=await recordHostOptOut({host:hosts[0],reason:'municipality_objection'},{stateDir});
  if(hosts.length===1){assert.equal(result.purge.deletedFiles,1);await assert.rejects(lstat(path),{code:'ENOENT'});}
  else{assert.equal(result.purge.status,'partial');assert.equal(result.purge.retainedSharedFiles,1);assert.ok(result.purge.issues.some(issue=>issue.code==='shared_derived_requires_rebuild'));assert.equal((await lstat(path)).isFile(),true);}
 }
});

test('explicit frozen-text and raw model-answer inventories purge content without deleting unknown legacy artifacts',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'artifacts');await registerManagedCacheRoot(root,{kind:'artifacts',stateDir});
 for(const suffix of ['.json','.answer.json']){const bytes='synthetic full raw text '+suffix,key=hash(suffix),entry={...rawEntry(bytes),relativePath:key+suffix,sourceSha256:hash('original source')};await publish(root,entry,bytes,stateDir);}
 const unsupported=join(root,'old-frozen-corpus.ndjson');await writeFile(unsupported,'Uninventoried legacy source body',{mode:0o600});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(receipt.purge.deletedFiles,2);assert.equal(receipt.purge.status,'partial');assert.ok(receipt.purge.issues.some(issue=>issue.code==='inventory_incomplete'));assert.equal(await readFile(unsupported,'utf8'),'Uninventoried legacy source body');
 await assert.rejects(publish(root,{...rawEntry('new','https://new.test/doc'),relativePath:hash('new')+'.json'},'new',stateDir),CivicPolicyStateError);
});

test('unsealed artifact roots require explicit hash enrollment before accepting source writes',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'artifacts'),bytes='known derived text',entry={...rawEntry(bytes),relativePath:hash('frozen-id')+'.json'};
 await mkdir(root,{mode:0o700});await writeFile(join(root,entry.relativePath),bytes,{mode:0o600});await registerManagedCacheRoot(root,{kind:'artifacts',stateDir});
 let called=false;await assert.rejects(withManagedSourceWrite(root,[entry],async()=>{called=true;},{stateDir}),CivicPolicyStateError);assert.equal(called,false);
 await recordManagedSourceContent(root,entry,{stateDir});await markManagedCacheInventoryComplete(root,{stateDir});
 assert.equal((await recordHostOptOut({host:'council.test',reason:'rights_holder_objection'},{stateDir})).purge.deletedFiles,1);
});

test('traversal, arbitrary names, symlink roots and writable shared state are rejected before callbacks',async t=>{
 const {base,root,stateDir}=await sandbox(t);await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir});let called=false;
 for(const relativePath of ['../unrelated','sha256/../../secret','/absolute','sha256\\escape','.secrets','README.md'])await assert.rejects(withManagedSourceWrite(root,[{...rawEntry('x'),relativePath}],async()=>{called=true;},{stateDir}),CivicPolicyStateError);
 assert.equal(called,false);const alias=join(base,'alias');await symlink(root,alias);await assert.rejects(registerManagedCacheRoot(alias,{kind:'fetch',stateDir}),CivicPolicyStateError);
 await chmod(stateDir,0o755);await assert.rejects(assertHostNotOptedOut('https://council.test/doc',{stateDir}),CivicPolicyStateError);await chmod(stateDir,0o700);
 await assert.rejects(recordHostOptOut({host:'council.test',reason:'municipality_objection',reference:'contact person@example.test'},{stateDir}));
});

test('hash tampering, file symlinks and hardlinks retain targets and report partial, never unrelated deletion',async t=>{
 const {base,stateDir}=await sandbox(t);
 for(const mode of ['tamper','symlink','hardlink']){
  const root=join(base,mode);await registerManagedCacheRoot(root,{kind:'fetch',stateDir});const bytes='original-'+mode,entry=rawEntry(bytes,'https://'+mode+'.test/doc');await publish(root,entry,bytes,stateDir);
  const target=join(base,mode+'-outside.txt');await writeFile(target,'unrelated outside content',{mode:0o600});
  if(mode==='tamper')await writeFile(join(root,entry.relativePath),'replacement',{mode:0o600});
  else{await rm(join(root,entry.relativePath));if(mode==='symlink')await symlink(target,join(root,entry.relativePath));else await link(target,join(root,entry.relativePath));}
  const receipt=await recordHostOptOut({host:mode+'.test',reason:'municipality_objection'},{stateDir});assert.equal(receipt.purge.status,'partial');assert.equal(receipt.purge.deletedFiles,0);assert.equal(await readFile(target,'utf8'),'unrelated outside content');
 }
});

test('inventory edits and root inode replacement fail closed with durable error or partial receipts',async t=>{
 const {base,root,stateDir}=await sandbox(t),bytes='owned raw';await registerManagedCacheRoot(root,{kind:'fetch',stateDir});const entry=rawEntry(bytes);await publish(root,entry,bytes,stateDir);
 const registry=join(stateDir,'inventory.json'),original=await readFile(registry,'utf8'),tampered=JSON.parse(original);tampered.entries[0].relativePath='../outside';await writeFile(registry,JSON.stringify(tampered),{mode:0o600});
 const bad=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(bad.purge.status,'error');assert.equal(bad.purge.issues[0].code,'inventory_unavailable');assert.equal(await readFile(join(root,entry.relativePath),'utf8'),bytes);
 await writeFile(registry,original,{mode:0o600});await rename(root,join(base,'original-root'));await mkdir(root,{mode:0o700});await mkdir(join(root,'sha256'),{mode:0o700});await writeFile(join(root,entry.relativePath),bytes,{mode:0o600});
 const changed=await purgeOptedOutHost('council.test',{stateDir});assert.equal(changed.status,'partial');assert.equal(changed.deletedFiles,0);assert.equal(await readFile(join(root,entry.relativePath),'utf8'),bytes);
});

test('crashed producer enrollment is retained and a missing content file is accounted for on purge',async t=>{
 const {root,stateDir}=await sandbox(t);await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir});const entry=rawEntry('not-written');
 await assert.rejects(withManagedSourceWrite(root,[entry],async()=>{throw Error('synthetic crash');},{stateDir}),/synthetic crash/);
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(receipt.purge.status,'purged');assert.equal(receipt.purge.missingFiles,1);assert.equal(receipt.purge.deletedFiles,0);
});

test('classification exclusion withdraws exact managed URL/hash only and reports independent physical retention',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root,{kind:'fetch',stateDir});const bytes='shared-exclusion',first=rawEntry(bytes),second=rawEntry(bytes,'https://independent.test/other',true);
 await publish(root,first,bytes,stateDir);await publish(root,second,bytes,stateDir);
 const result=await relinquishManagedSourceContent(root,{url:first.url,sourceSha256:first.sourceSha256},{stateDir});assert.equal(result.disposition,'retained_independent');assert.equal(result.removedReferences,1);await assertHostNotOptedOut(first.url,{stateDir});
 const absent=await relinquishManagedSourceContent(root,{url:first.url,sourceSha256:hash('different')},{stateDir});assert.equal(absent.disposition,'not_managed');
 const final=await relinquishManagedSourceContent(root,{url:second.url,sourceSha256:second.sourceSha256},{stateDir});assert.equal(final.disposition,'removed');await assert.rejects(lstat(join(root,first.relativePath)),{code:'ENOENT'});
});

test('derived replacement inventories bind actual versions and do not delete unrelated newer source content',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root,{kind:'fetch',stateDir});const relativePath='oparl-bodies/'+hash('body')+'.json';
 const old={...rawEntry('old','https://old.test/page'),relativePath},current={...rawEntry('new','https://new.test/page'),relativePath};await publish(root,old,'old',stateDir);await publish(root,current,'new',stateDir);
 const first=await recordHostOptOut({host:'old.test',reason:'municipality_objection'},{stateDir});assert.equal(first.purge.deletedFiles,0);assert.equal(await readFile(join(root,relativePath),'utf8'),'new');
 const second=await recordHostOptOut({host:'new.test',reason:'municipality_objection'},{stateDir});assert.equal(second.purge.deletedFiles,1);
});

test('operator CLI registration awaits purge and emits metadata-only partial status with nonzero exit',async t=>{
 const {stateDir}=await sandbox(t),outputs:string[]=[];const previous=process.exitCode;t.after(()=>{process.exitCode=previous;});t.mock.method(console,'log',(value:string)=>{outputs.push(value);});
 await civicOptOutMain(['register','--host','operator.test','--reason','municipality_objection','--reference',randomUUID(),'--state-dir',stateDir]);
 const receipt=JSON.parse(outputs[0]);assert.equal(receipt.host,'operator.test');assert.equal(receipt.purge.status,'partial');assert.equal(process.exitCode,2);assert.equal(receipt.purge.scope,'registered_managed_roots');await assert.rejects(assertHostNotOptedOut('https://operator.test/',{stateDir}),HostOptedOutError);
});

test('URL-scoped exclusion retains separate allowed same-host provenance, but a host objection removes both',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root,{kind:'fetch',stateDir});const bytes='same-host shared',denied=rawEntry(bytes,'https://council.test/denied'),allowed=rawEntry(bytes,'https://council.test/allowed',true);
 await publish(root,denied,bytes,stateDir);await publish(root,allowed,bytes,stateDir);
 const exclusion=await relinquishManagedSourceContent(root,{url:denied.url,sourceSha256:denied.sourceSha256},{stateDir});assert.equal(exclusion.disposition,'retained_independent');assert.equal(await readFile(join(root,allowed.relativePath),'utf8'),bytes);
 const objection=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(objection.purge.deletedFiles,1);assert.equal(objection.purge.retainedSharedFiles,0);await assert.rejects(assertHostNotOptedOut(allowed.url,{stateDir}),HostOptedOutError);
});

test('one independent source cannot retain a mixed derived artifact containing another opted-out-only source',async t=>{
 const {root,stateDir}=await sandbox(t);await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir});const bytes='mixed derived text',relativePath='api-frontiers/'+hash('mixed')+'-mv.json';
 const first={...rawEntry(bytes),sourceSha256:hash('source-a'),relativePath},second={...rawEntry(bytes,'https://council.test/second'),sourceSha256:hash('source-b'),relativePath},independent={...rawEntry(bytes,'https://independent.test/first',true),sourceSha256:hash('source-a'),relativePath};
 await withManagedSourceWrite(root,[first,second,independent],async()=>{await mkdir(join(root,'api-frontiers'),{mode:0o700});await writeFile(join(root,relativePath),bytes,{mode:0o600});},{stateDir});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(receipt.purge.deletedFiles,1);assert.equal(receipt.purge.retainedSharedFiles,0);
});

test('bounded metadata-only frontier and checkpoint formats remain, while interrupted raw temporaries force partial',async t=>{
 const {root,stateDir}=await sandbox(t),bodyId=hash('body');
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir});
 const frontier=join(root,'frontiers',hash('frontier')+'.json'),checkpoint=join(root,'oparl',bodyId,'paper','checkpoint.json');
 await mkdir(dirname(frontier),{recursive:true,mode:0o700});await mkdir(dirname(checkpoint),{recursive:true,mode:0o700});
 await writeFile(frontier,JSON.stringify({schemaVersion:1,municipalityId:'synthetic',sourceId:'council',queue:[],visited:[],documents:[],failures:[],roots:[]}),{mode:0o600});
 await writeFile(checkpoint,JSON.stringify({schemaVersion:1,bodyId:'https://council.test/body',baseUrl:'https://council.test/paper',kind:'paper',backfillComplete:true,watermark:now,active:null,segments:0,pages:0,rawRecordCount:0,lastCheckedAt:now}),{mode:0o600});
 await registerManagedCacheRoot(root,{kind:'fetch',stateDir});await markManagedCacheInventoryComplete(root,{stateDir});const entry=rawEntry('published');await publish(root,entry,'published',stateDir);
 const partialPath=join(root,'sha256',hash('unpublished')+'.tmp');await writeFile(partialPath,'partial raw source bytes',{mode:0o600});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(receipt.purge.status,'partial');assert.equal(receipt.purge.deletedFiles,1);assert.equal((await lstat(frontier)).isFile(),true);assert.equal((await lstat(checkpoint)).isFile(),true);assert.equal(await readFile(partialPath,'utf8'),'partial raw source bytes');
});

test('malformed opt-out metadata fails closed and does not leak tampered source text in audit',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root,{kind:'fetch',stateDir});await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});
 const marker=join(stateDir,'hosts',hash('council.test')+'.json'),value=JSON.parse(await readFile(marker,'utf8'));value.purgeDueAt='2099-01-01T00:00:00.000Z';await writeFile(marker,JSON.stringify(value),{mode:0o600});
 await assert.rejects(assertHostNotOptedOut('https://council.test/doc',{stateDir}),CivicPolicyStateError);await assert.rejects(purgeOptedOutHost('council.test',{stateDir}),CivicPolicyStateError);
});

test('simultaneous same-host objections preserve the earliest canonical UTC deadline',async t=>{
 const {root,stateDir}=await sandbox(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});await registerManagedCacheRoot(root,{kind:'fetch',stateDir});
 await Promise.all(['2026-10-10T12:00:00.000Z','2026-10-09T14:00:00.000+02:00','2026-10-11T12:00:00.000Z'].map(receivedAt=>recordHostOptOut({host:'council.test',reason:'municipality_objection',receivedAt},{stateDir})));
 const final=await purgeOptedOutHost('council.test',{stateDir});assert.equal(final.receivedAt,'2026-10-09T12:00:00.000Z');assert.equal(final.purgeDueAt,'2026-10-16T12:00:00.000Z');await assert.rejects(assertHostNotOptedOut('https://council.test/source',{stateDir}),HostOptedOutError);
});

test('operator CLI does not return a successful registration before source deletion completes',async t=>{
 const {root,stateDir}=await sandbox(t),bytes='operator-owned source',entry=rawEntry(bytes);await registerManagedCacheRoot(root,{kind:'fetch',stateDir});await publish(root,entry,bytes,stateDir);
 const outputs:string[]=[];t.mock.method(console,'log',(value:string)=>{outputs.push(value);});await civicOptOutMain(['register','--host','council.test','--reason','rights_holder_objection','--state-dir',stateDir]);
 assert.equal(JSON.parse(outputs[0]).purge.status,'purged');assert.equal(JSON.parse(outputs[0]).purge.deletedFiles,1);await assert.rejects(lstat(join(root,entry.relativePath)),{code:'ENOENT'});
});

test('explicit acquisition initialization seals empty roots of every kind with owner-only identity-bound markers',async t=>{
 const {base,stateDir}=await sandbox(t);
 for(const kind of ['fetch','prepared','artifacts'] as const){
  const root=join(base,kind);if(kind==='prepared')await mkdir(root,{mode:0o755});
  await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind,stateDir});
  const path=join(root,'.civic-acquisition-lane.json'),marker=JSON.parse(await readFile(path,'utf8')),stat=await lstat(root);
  assert.equal(marker.decisionId,CIVIC_ACQUISITION_DECISION_ID);assert.equal(marker.kind,kind);assert.equal(marker.rootId,hash(root));assert.deepEqual(marker.identity,{dev:stat.dev,ino:stat.ino});assert.equal((await lstat(path)).mode&0o777,0o600);
  await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind,stateDir});await markManagedCacheInventoryComplete(root,{stateDir});
 }
 const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));assert.equal(inventory.roots.length,3);assert.ok(inventory.roots.every((root:{complete:boolean})=>root.complete));
});

test('dated paths and known legacy CAS files cannot authorize nonempty unmarked acquisition roots',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'isolated0.3.2-owner-2026-10-11'),bytes='historical source';
 await mkdir(join(root,'sha256'),{recursive:true,mode:0o700});await writeFile(join(root,'sha256',hash(bytes)),bytes,{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir}),CivicPolicyStateError);
 await assert.rejects(lstat(stateDir),{code:'ENOENT'});await assert.rejects(lstat(join(root,'.civic-acquisition-lane.json')),{code:'ENOENT'});assert.equal(await readFile(join(root,'sha256',hash(bytes)),'utf8'),bytes);
});

test('generic purge-root registration never grants source-write authorization',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root,{kind:'fetch',stateDir});let called=false;
 await assert.rejects(withManagedSourceWrite(root,[rawEntry('new')],async()=>{called=true;},{stateDir}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='ACQUISITION_LANE_REQUIRED');
 assert.equal(called,false);await assert.rejects(lstat(join(root,'.civic-acquisition-lane.json')),{code:'ENOENT'});
});

test('marker copying, kind changes, unsafe permissions and wrong decisions cannot reauthorize a root',async t=>{
 const {base,root,stateDir}=await sandbox(t);await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir});
 const markerPath=join(root,'.civic-acquisition-lane.json'),bytes=await readFile(markerPath),copy=join(base,'copy');await mkdir(copy,{mode:0o700});await writeFile(join(copy,'.civic-acquisition-lane.json'),bytes,{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(copy,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir}),CivicPolicyStateError);
 await assert.rejects(initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'prepared',stateDir}),CivicPolicyStateError);
 await assert.rejects(initializeManagedAcquisitionLane(join(base,'wrong-decision'),{decisionId:'unapproved' as typeof CIVIC_ACQUISITION_DECISION_ID,stateDir}),CivicPolicyStateError);
 await assert.rejects(lstat(join(base,'wrong-decision')),{code:'ENOENT'});
 await chmod(markerPath,0o644);await assert.rejects(initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir}),CivicPolicyStateError);await chmod(markerPath,0o600);
 const stat=await readFile(join(stateDir,'inventory.json'),'utf8');await rename(root,join(base,'moved'));await mkdir(root,{mode:0o700});await writeFile(join(root,'.civic-acquisition-lane.json'),bytes,{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir}),CivicPolicyStateError);assert.equal(await readFile(join(stateDir,'inventory.json'),'utf8'),stat);
});

test('concurrent initialization converges on one marker and valid markers do not conceal incomplete inventories',async t=>{
 const {root,stateDir}=await sandbox(t);await Promise.all(Array.from({length:4},()=>initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir})));
 assert.equal(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).roots.length,1);
 await writeFile(join(root,'unsupported-frozen-text.txt'),'unknown legacy source content',{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='MANAGED_INVENTORY_INCOMPLETE');
 assert.equal(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).roots[0].complete,false);
});

test('public opt-out snapshots are read-only on absent state and hash only their explicit projection',async t=>{
 const {stateDir}=await sandbox(t),snapshot=await readCivicOptOutSnapshot({stateDir});
 const body={schemaVersion:'civic-opt-out-snapshot-v1',objections:[]};
 assert.deepEqual(snapshot,{...body,sha256:hash(JSON.stringify(body))});await assert.rejects(lstat(stateDir),{code:'ENOENT'});
 await recordHostOptOut({host:'later.test',reason:'municipality_objection'},{stateDir});
 await assert.rejects(assertHostNotOptedOut('https://later.test/source',{stateDir}),HostOptedOutError);assert.equal(snapshot.objections.length,0);
});

test('snapshot entries sort hashed hosts, select earliest deadlines and omit private provenance',async t=>{
 const {base,stateDir}=await sandbox(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});
 await recordHostOptOut({host:'zeta.test',reason:'rights_holder_objection',reference:'PRIVATE-OPAQUE-Z',receivedAt:'2026-10-10T00:00:00.000Z'},{stateDir});
 await recordHostOptOut({host:'alpha.test',reason:'municipality_objection',reference:'PRIVATE-OPAQUE-A',receivedAt:'2026-10-09T00:00:00.000Z'},{stateDir});
 await recordHostOptOut({host:'alpha.test',reason:'municipality_objection',receivedAt:'2026-10-08T00:00:00.000Z'},{stateDir});
 const snapshot=await readCivicOptOutSnapshot({stateDir}),objections=[
  {hostSha256:hash('alpha.test'),receivedAt:'2026-10-08T00:00:00.000Z',purgeDueAt:'2026-10-15T00:00:00.000Z'},
  {hostSha256:hash('zeta.test'),receivedAt:'2026-10-10T00:00:00.000Z',purgeDueAt:'2026-10-17T00:00:00.000Z'},
 ].sort((a,b)=>a.hostSha256<b.hostSha256?-1:1);
 assert.deepEqual(snapshot.objections,objections);assert.equal(snapshot.sha256,hash(JSON.stringify({schemaVersion:'civic-opt-out-snapshot-v1',objections})));
 const encoded=JSON.stringify(snapshot);for(const privateValue of ['alpha.test','zeta.test','PRIVATE-OPAQUE',stateDir,'municipality_objection','rights_holder_objection'])assert.equal(encoded.includes(privateValue),false);
 await registerManagedCacheRoot(join(base,'another-private-root'),{kind:'fetch',stateDir});await purgeOptedOutHost('alpha.test',{stateDir});
 assert.equal((await readCivicOptOutSnapshot({stateDir})).sha256,snapshot.sha256);
});

test('equivalent objection projections have the same hash across private state locations and references',async t=>{
 const {base,stateDir}=await sandbox(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});const other=join(base,'other-policy');
 for(const [path,reference,reason] of [[stateDir,'PRIVATE-ONE','municipality_objection'],[other,'PRIVATE-TWO','rights_holder_objection']] as const)await recordHostOptOut({host:'council.test',reason,reference,receivedAt:now},{stateDir:path});
 assert.deepEqual(await readCivicOptOutSnapshot({stateDir}),await readCivicOptOutSnapshot({stateDir:other}));
});

test('snapshot capture rejects concurrent membership or immutable-file changes instead of returning a torn hash',async t=>{
 for(const mutation of ['insert','replace']){
  const {stateDir}=await sandbox(t);await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});
  const hosts=join(stateDir,'hosts'),marker=join(hosts,hash('council.test')+'.json'),existing=JSON.parse(await readFile(marker,'utf8')),original=fsPromises.opendir;let scans=0;
  t.mock.method(fsPromises,'opendir',async(...args:Parameters<typeof fsPromises.opendir>)=>{
   const handle=await original(...args);
   if(String(args[0])===hosts&&++scans===(mutation==='insert'?1:2)){
    const value=mutation==='insert'?{...existing,host:'concurrent.test'}:{...existing,reference:'concurrently-changed-private-reference'};
    await writeFile(mutation==='insert'?join(hosts,hash('concurrent.test')+'.json'):marker,JSON.stringify(value)+'\n',{mode:0o600});
   }
   return handle;
  });
  // Built-in named imports must observe this synthetic filesystem interleaving.
  syncBuiltinESMExports();
  try{await assert.rejects(readCivicOptOutSnapshot({stateDir}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_BUSY');}
  finally{t.mock.restoreAll();syncBuiltinESMExports();}
 }
});

test('snapshots reject orphan revisions, unknown registry files and unsafe host metadata without exposing contents',async t=>{
 const {stateDir}=await sandbox(t);await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});const hosts=join(stateDir,'hosts'),marker=join(hosts,hash('council.test')+'.json');
 const value=JSON.parse(await readFile(marker,'utf8')),revision=join(hosts,hash('council.test')+'-'+hash(value.receivedAt)+'.json');await rename(marker,revision);
 await assert.rejects(readCivicOptOutSnapshot({stateDir}),CivicPolicyStateError);await rename(revision,marker);
 const unknown=join(hosts,'unknown.json');await writeFile(unknown,'PRIVATE-SOURCE-CONTENT',{mode:0o600});
 await assert.rejects(readCivicOptOutSnapshot({stateDir}),(error:unknown)=>error instanceof CivicPolicyStateError&&!error.message.includes('PRIVATE-SOURCE-CONTENT'));await rm(unknown);
 await chmod(marker,0o644);await assert.rejects(readCivicOptOutSnapshot({stateDir}),CivicPolicyStateError);
});

test('sharded source CAS supports arbitrary bytes and preserves independent raw provenance without host fallback',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'source-cas'),bytes='\u0000\u0001synthetic native source',contentSha256=hash(bytes),relativePath='sha256/'+contentSha256.slice(0,2)+'/'+contentSha256;
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir});
 const first={...rawEntry(bytes),relativePath},second={...rawEntry(bytes,'https://independent.test/source',true),relativePath};await publish(root,first,bytes,stateDir);await publish(root,second,bytes,stateDir);
 const one=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(one.purge.status,'purged');assert.equal(one.purge.deletedFiles,0);assert.equal(one.purge.retainedSharedFiles,1);assert.equal(await readFile(join(root,relativePath),'utf8'),bytes);
 await assert.rejects(assertHostNotOptedOut(first.url,{stateDir}),HostOptedOutError);await assertHostNotOptedOut(second.url,{stateDir});
 const two=await recordHostOptOut({host:'independent.test',reason:'municipality_objection'},{stateDir});assert.equal(two.purge.deletedFiles,1);await assert.rejects(lstat(join(root,relativePath)),{code:'ENOENT'});assert.equal((await lstat(join(root,'.civic-acquisition-lane.json'))).isFile(),true);
});

test('sharded derived CAS records every source binding and retains unrelated original objects',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'source-cas');await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir});
 const bytes='multi-source parsed native content',contentSha256=hash(bytes),relativePath='sha256/'+contentSha256.slice(0,2)+'/'+contentSha256,otherBytes='independently acquired original',otherHash=hash(otherBytes);
 const entries=[{...rawEntry(bytes),relativePath,sourceSha256:hash('council original')},{...rawEntry(bytes,'https://other.test/original',true),relativePath,sourceSha256:otherHash}];
 await withManagedSourceWrite(root,entries,async()=>{await mkdir(dirname(join(root,relativePath)),{recursive:true,mode:0o700});await writeFile(join(root,relativePath),bytes,{mode:0o600});},{stateDir});
 const independent={...rawEntry(otherBytes,'https://other.test/original',true),relativePath:'sha256/'+otherHash.slice(0,2)+'/'+otherHash};await publish(root,independent,otherBytes,stateDir);
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(receipt.purge.deletedFiles,1);assert.equal(receipt.purge.retainedSharedFiles,0);assert.equal(await readFile(join(root,independent.relativePath),'utf8'),otherBytes);
});

test('sharded CAS rejects wrong prefixes, mismatched basenames and unregistered blobs including claimed metadata',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'source-cas');await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir});
 const bytes='bound object',entry=rawEntry(bytes),prefix=entry.contentSha256.slice(0,2),wrong=prefix==='00'?'ff':'00';let called=false;
 for(const relativePath of ['sha256/'+wrong+'/'+entry.contentSha256,'sha256/'+prefix+'/'+hash('different'),'sha256/'+prefix+'/../'+entry.contentSha256,'sha256/'+prefix+'/'+entry.contentSha256+'.json'])await assert.rejects(withManagedSourceWrite(root,[{...entry,relativePath}],async()=>{called=true;},{stateDir}),CivicPolicyStateError);
 assert.equal(called,false);
 const unregistered=JSON.stringify({schemaVersion:'claimed-safe-metadata',kind:'metadata',fullText:'untracked source body'}),sha256=hash(unregistered),path=join(root,'sha256',sha256.slice(0,2),sha256);
 await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,unregistered,{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='MANAGED_INVENTORY_INCOMPLETE');
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(receipt.purge.status,'partial');assert.equal(receipt.purge.deletedFiles,0);assert.equal(await readFile(path,'utf8'),unregistered);
});

test('retained sharded derived copies remain explicit partial and canonical audit outside the content root survives',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'source-cas');await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,stateDir});
 const bytes='derived full model output',contentSha256=hash(bytes),relativePath='sha256/'+contentSha256.slice(0,2)+'/'+contentSha256,sourceSha256=hash('original source');
 const first={...rawEntry(bytes),relativePath,sourceSha256},other={...rawEntry(bytes,'https://independent.test/source',true),relativePath,sourceSha256};await publish(root,first,bytes,stateDir);await publish(root,other,bytes,stateDir);
 const canonicalAudit=join(base,'canonical-audit.json');await writeFile(canonicalAudit,JSON.stringify({sourceSha256,receiptSha256:first.receiptSha256}),{mode:0o600});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},{stateDir});assert.equal(receipt.purge.status,'partial');assert.equal(receipt.purge.retainedSharedFiles,1);assert.ok(receipt.purge.issues.some(issue=>issue.code==='shared_derived_requires_rebuild'));assert.equal(JSON.parse(await readFile(canonicalAudit,'utf8')).sourceSha256,sourceSha256);
});
