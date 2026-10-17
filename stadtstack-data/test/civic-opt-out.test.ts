import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,lstat,readdir,symlink,link,rename,chmod,cp,utimes} from 'node:fs/promises';
import {watch,promises as fsPromises} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import type {Stats,BigIntStats} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir,homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {DistrictCas} from '../src/district-cas.ts';
import {assertCivicPolicyAuthority,provisionCivicPolicyAuthority,CIVIC_POLICY_AUTHORITY_ID,assertManagedSourceReadable,withManagedSourceScratch,recoverManagedSourceScratch,assertHostNotOptedOut,readCivicOptOutSnapshot,registerManagedCacheRoot,initializeManagedAcquisitionLane,CIVIC_ACQUISITION_DECISION_ID,recordHostOptOut,purgeOptedOutHost,recordManagedSourceContent,withManagedSourceWrite,markManagedCacheInventoryComplete,relinquishManagedSourceContent,HostOptedOutError,CivicPolicyStateError,civicOptOutMain} from '../src/civic-opt-out.ts';
import {assertManagedSourceBindings,assertManagedIndependentHttpSourceBinding,assertManagedRawSourceBinding,assertManagedObservationReadable,ManagedSourceBindingSchema,parseContentFreePreparationPlan,assertSourceHostsNotOptedOut} from '../src/civic-opt-out.ts';
import {retireManagedRoot,RetireReceiptSchema} from '../src/civic-opt-out.ts';
import {compactCivicPolicyInventory,repackCivicPolicyInventory,readCivicPolicyInventory,recoverCivicPolicyLock} from '../src/civic-opt-out.ts';
import {createReadOnlyManagedSourceAudit} from '../src/civic-opt-out.ts';
import {projectSourcePolicyMetadata} from '../src/source-policy.ts';
import type {SourceAccessPolicy} from '../src/source-policy.ts';
import type {ManagedSourceContent,ManagedSourceBinding,CivicPolicyOptions} from '../src/civic-opt-out.ts';

const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const now='2026-10-11T12:00:00.000Z';
type FixturePolicy=Required<Pick<CivicPolicyOptions,'stateDir'|'authorityId'|'authoritySha256'>>;
const fixturePolicies=new Map<string,FixturePolicy>();
function fixturePolicy(stateDir:string):FixturePolicy{
 let policy=fixturePolicies.get(stateDir);
 if(!policy){policy={stateDir,authorityId:'fixture:'+randomUUID(),authoritySha256:'0'.repeat(64)};fixturePolicies.set(stateDir,policy);}
 return policy;
}
async function provisionFixture(stateDir:string){
 const authority=await provisionCivicPolicyAuthority({stateDir,authorityId:fixturePolicy(stateDir).authorityId});
 fixturePolicies.set(stateDir,{stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256});return authority;
}
async function sandbox(t:TestContext,provision=true){
 const base=await realpath(await mkdtemp(join(tmpdir(),'civic-opt-out-synthetic-')));
 t.after(async()=>{fixturePolicies.delete(join(base,'policy'));await rm(base,{recursive:true,force:true});});const stateDir=join(base,'policy');fixturePolicy(stateDir);
 if(provision)await provisionFixture(stateDir);
 return {base,root:join(base,'fetch'),stateDir};
}
function rawEntry(bytes:string,url='https://council.test/document',independentAllowed=false):Extract<ManagedSourceContent,{kind:'http_observation'}>{
 const sha256=hash(bytes);return {kind:'http_observation',relativePath:'sha256/'+sha256,contentSha256:sha256,sourceSha256:sha256,url,observationId:hash(url),receiptSha256:hash('receipt:'+url+sha256),independentAllowed};
}
async function publish(root:string,entry:ManagedSourceContent,bytes:string,stateDir:string){
 const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')),managed=inventory.roots.find((item:{path:string})=>item.path===root);assert.ok(managed);
 await initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, kind: managed.kind, ...fixturePolicy(stateDir)});
 await withManagedSourceWrite(root, [entry], async()=>{await mkdir(dirname(join(root,entry.relativePath)),{recursive:true,mode:0o700});await writeFile(join(root,entry.relativePath),bytes,{mode:0o600});}, fixturePolicy(stateDir));
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

test('lock-free audit reads a stable epoch without acquiring an existing inventory lock or writing',async t=>{
 const {root,stateDir}=await sandbox(t),entry=rawEntry('Synthetic read-only audit');
 await registerManagedCacheRoot(root,{kind:'fetch',...fixturePolicy(stateDir)});await publish(root,entry,'Synthetic read-only audit',stateDir);await markManagedCacheInventoryComplete(root,fixturePolicy(stateDir));
 const lock=join(stateDir,'inventory.lock');await writeFile(lock,'Synthetic deliberately held lock',{mode:0o600});
 const before=await readFile(join(stateDir,'inventory.json')),members=await readdir(stateDir),audit=await createReadOnlyManagedSourceAudit(fixturePolicy(stateDir));
 assert.equal((await audit.read(join(root,entry.relativePath),entry.contentSha256)).toString(),'Synthetic read-only audit');await audit.finish();
 assert.deepEqual(await readFile(join(stateDir,'inventory.json')),before);assert.deepEqual(await readdir(stateDir),members);assert.equal(await readFile(lock,'utf8'),'Synthetic deliberately held lock');
 await assert.rejects(audit.read(join(root,entry.relativePath)),/AUDIT_FINISHED/);
});

test('lock-free audit rejects publication, same-byte inode replacement and objection epoch changes',async t=>{
 const {root,stateDir}=await sandbox(t),entry=rawEntry('Synthetic epoch audit'),path=join(root,entry.relativePath);
 await registerManagedCacheRoot(root,{kind:'fetch',...fixturePolicy(stateDir)});await publish(root,entry,'Synthetic epoch audit',stateDir);await markManagedCacheInventoryComplete(root,fixturePolicy(stateDir));
 const first=await createReadOnlyManagedSourceAudit(fixturePolicy(stateDir));await first.read(path);
 await publish(root,rawEntry('Second synthetic member'),'Second synthetic member',stateDir);await assert.rejects(first.finish(),CivicPolicyStateError);
 const second=await createReadOnlyManagedSourceAudit(fixturePolicy(stateDir));await second.read(path);
 const inventoryPath=join(stateDir,'inventory.json'),replacement=join(stateDir,'audit-epoch-replacement.json');await writeFile(replacement,await readFile(inventoryPath),{mode:0o600});await rename(replacement,inventoryPath);
 await assert.rejects(second.finish(),/AUDIT_EPOCH_CHANGED/);
 const third=await createReadOnlyManagedSourceAudit(fixturePolicy(stateDir));await third.read(path);
 await recordHostOptOut({host:'council.test',reason:'municipality_objection'},fixturePolicy(stateDir));await assert.rejects(third.finish(),CivicPolicyStateError);
});

test('unprovisioned authority fails closed without writes, then canonical host blocking applies across schemes',async t=>{
 const {stateDir}=await sandbox(t,false);await assert.rejects(assertHostNotOptedOut('https://council.test/a', fixturePolicy(stateDir)),CivicPolicyStateError);await assert.rejects(lstat(stateDir),{code:'ENOENT'});
 t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});await provisionFixture(stateDir);await assertHostNotOptedOut('https://council.test/a', fixturePolicy(stateDir));
 const receipt=await recordHostOptOut({host:'COUNCIL.TEST.',reason:'municipality_objection',reference:'case-opaque-1'}, fixturePolicy(stateDir));
 assert.equal(receipt.host,'council.test');assert.equal(receipt.purgeDueAt,'2026-10-18T12:00:00.000Z');assert.equal(receipt.purge.status,'partial');assert.equal(receipt.purge.issues[0].code,'no_managed_roots');
 for(const url of ['https://council.test/a','http://COUNCIL.TEST./b'])await assert.rejects(assertHostNotOptedOut(url, fixturePolicy(stateDir)),HostOptedOutError);
 await assertHostNotOptedOut('https://other.council.test/a', fixturePolicy(stateDir));
 assert.equal((await lstat(stateDir)).mode&0o777,0o700);
 assert.equal((await lstat(join(stateDir,'hosts',hash('council.test')+'.json'))).mode&0o777,0o600);
});

test('registration synchronously purges verified source copies, keeps only safe audit hashes, and never extends a deadline',async t=>{
 const {base,root,stateDir}=await sandbox(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});
 await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});
 const bytes='SOURCE_BODY_NEVER_COPY_TO_AUDIT',entry=rawEntry(bytes);await publish(root,entry,bytes,stateDir);
 const unrelated=join(base,'unrelated.txt');await writeFile(unrelated,'unrelated user file',{mode:0o600});
 const first=await recordHostOptOut({host:'council.test',reason:'rights_holder_objection',receivedAt:'2026-10-10T00:00:00.000Z'}, fixturePolicy(stateDir));
 assert.equal(first.purge.status,'purged');assert.equal(first.purge.deletedFiles,1);assert.equal(first.purge.removedReferences,1);
 await assert.rejects(lstat(join(root,entry.relativePath)),{code:'ENOENT'});assert.equal(await readFile(unrelated,'utf8'),'unrelated user file');
 const second=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(second.purgeDueAt,first.purgeDueAt);assert.equal(second.purge.deletedFiles,0);
 for(const path of [join(stateDir,'inventory.json'),...((await readdir(join(stateDir,'attempts'))).map(name=>join(stateDir,'attempts',name)))])assert.equal((await readFile(path,'utf8')).includes(bytes),false);
 await assert.rejects(publish(root,entry,bytes,stateDir),HostOptedOutError);
});

test('past objections retain their overdue deadline and earlier repeat registration tightens it even with a busy purge lock',async t=>{
 const {root,stateDir}=await sandbox(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});
 await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));
 const lock=join(stateDir,'inventory.lock');await writeFile(lock,'operator-held',{mode:0o600});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection',receivedAt:'2026-09-01T00:00:00.000Z'}, {...fixturePolicy(stateDir),lockWaitMs:50});
 assert.equal(receipt.purge.status,'error');assert.equal(receipt.purgeDueAt,'2026-09-08T00:00:00.000Z');assert.equal(receipt.purge.issues[0].code,'inventory_busy');
 assert.equal(await readFile(lock,'utf8'),'operator-held');await rm(lock);
 assert.equal((await purgeOptedOutHost('council.test', fixturePolicy(stateDir))).purgeDueAt,'2026-09-08T00:00:00.000Z');
 await assert.rejects(recordHostOptOut({host:'future.test',reason:'municipality_objection',receivedAt:'2026-10-12T00:00:00.000Z'}, fixturePolicy(stateDir)),CivicPolicyStateError);
});

test('an objection blocks immediately while a producer holds the inventory lock and awaits synchronous purge',async t=>{
 const {root,stateDir}=await sandbox(t);await initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)});
 const entry=rawEntry('in-flight'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const writing=withManagedSourceWrite(root, [entry], async()=>{entered.resolve();await release.promise;await mkdir(join(root,'sha256'),{mode:0o700});await writeFile(join(root,entry.relativePath),'in-flight',{mode:0o600});}, fixturePolicy(stateDir));
 await entered.promise;
 const marker=hash('council.test')+'.json',visible=Promise.withResolvers<void>();
 const watcher=watch(join(stateDir,'hosts'),(_event,name)=>{if(String(name)===marker)visible.resolve();});t.after(()=>watcher.close());
 let finished=false;const recording=recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir)).then(value=>{finished=true;return value;});
 await visible.promise;
 // Publication may briefly be between link and unlink; either explicit objection
 // or unsafe transitional state must fail closed, never an allowed acquisition.
 await assert.rejects(assertHostNotOptedOut(entry.url, fixturePolicy(stateDir)));assert.equal(finished,false);
 const rejected=assert.rejects(writing,HostOptedOutError);release.resolve();await rejected;
 const receipt=await recording;assert.equal(receipt.purge.deletedFiles,1);await assert.rejects(lstat(join(root,entry.relativePath)),{code:'ENOENT'});
});

test('concurrent owner registrations do not overwrite different host objections or lose inventory roots',async t=>{
 const {base,stateDir}=await sandbox(t);
 await Promise.all(Array.from({length:8},(_,i)=>registerManagedCacheRoot(join(base,'cache-'+i), {kind: 'fetch', ...fixturePolicy(stateDir)})));
 await Promise.all(Array.from({length:8},(_,i)=>recordHostOptOut({host:'host'+i+'.test',reason:'municipality_objection'}, fixturePolicy(stateDir))));
 for(let i=0;i<8;i++)await assert.rejects(assertHostNotOptedOut('https://host'+i+'.test/source', fixturePolicy(stateDir)),HostOptedOutError);
 assert.equal(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).roots.length,8);
});

test('shared raw CAS keeps genuinely independent provenance and cannot become an opted-out host fallback',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});
 const bytes='shared raw',first=rawEntry(bytes),second=rawEntry(bytes,'https://independent.test/source',true);
 await publish(root,first,bytes,stateDir);await publish(root,second,bytes,stateDir);
 const one=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));
 assert.equal(one.purge.status,'purged');assert.equal(one.purge.deletedFiles,0);assert.equal(one.purge.retainedSharedFiles,1);assert.equal(one.purge.retainedSharedBytes,Buffer.byteLength(bytes));
 assert.equal(await readFile(join(root,first.relativePath),'utf8'),bytes);await assert.rejects(assertHostNotOptedOut(first.url, fixturePolicy(stateDir)),HostOptedOutError);await assertHostNotOptedOut(second.url, fixturePolicy(stateDir));
 const two=await recordHostOptOut({host:'independent.test',reason:'rights_holder_objection'}, fixturePolicy(stateDir));assert.equal(two.purge.deletedFiles,1);
 await assert.rejects(lstat(join(root,first.relativePath)),{code:'ENOENT'});
});

test('same observation or unpermitted sharing cannot manufacture independent allowed provenance',async t=>{
 const {base,stateDir}=await sandbox(t);
 for(const [label,permitted,sameObservation] of [['unpermitted',false,false],['rebound',true,true]] as const){
  const root=join(base,label);await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});const bytes=label,first=rawEntry(bytes,'https://'+label+'.test/doc'),second=rawEntry(bytes,'https://other-'+label+'.test/doc',permitted);
  if(sameObservation)second.observationId=first.observationId;
  await publish(root,first,bytes,stateDir);await publish(root,second,bytes,stateDir);
  const receipt=await recordHostOptOut({host:label+'.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(receipt.purge.retainedSharedFiles,0);assert.equal(receipt.purge.deletedFiles,1);
 }
});

test('automatic fetch inventory binds immutable observations, retains public metadata and detects orphan raw copies',async t=>{
 const {root,stateDir}=await sandbox(t),bytes='legacy known source',sha256=hash(bytes);
 await mkdir(join(root,'sha256'),{recursive:true,mode:0o700});await mkdir(join(root,'observations'),{mode:0o700});await mkdir(join(root,'requests'),{mode:0o700});
 await writeFile(join(root,'sha256',sha256),bytes,{mode:0o600});
 const observation={url:'https://council.test/doc',method:'GET',state:'fetched',checkedAt:now,retrievedAt:now,sha256,mimeType:'text/plain',bytes:bytes.length};
 const observationPath=join(root,'observations','fixture.json'),requestPath=join(root,'requests',hash('request')+'.json');await writeFile(observationPath,JSON.stringify(observation),{mode:0o600});await writeFile(requestPath,JSON.stringify(observation),{mode:0o600});
 await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});await markManagedCacheInventoryComplete(root, fixturePolicy(stateDir));
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(receipt.purge.status,'purged');assert.equal(receipt.purge.deletedFiles,1);assert.equal(JSON.parse(await readFile(observationPath,'utf8')).sha256,sha256);assert.equal(JSON.parse(await readFile(requestPath,'utf8')).sha256,sha256);
 const orphan='orphan';await writeFile(join(root,'sha256',hash(orphan)),orphan,{mode:0o600});await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});await assert.rejects(markManagedCacheInventoryComplete(root, fixturePolicy(stateDir)),CivicPolicyStateError);
 assert.equal((await purgeOptedOutHost('council.test', fixturePolicy(stateDir))).status,'partial');assert.equal(await readFile(join(root,'sha256',hash(orphan)),'utf8'),orphan);
});

test('known prepared full-text receipts auto-enroll, and shared prepared references require rebuild rather than a false purge',async t=>{
 const {base,stateDir}=await sandbox(t);
 for(const hosts of [['single.test'],['shared.test','independent.test']]){
  const root=join(base,hosts[0]),receipt=preparedFixture(hosts),path=join(root,receipt.receiptSha256+'.json');await mkdir(root,{mode:0o700});await writeFile(path,JSON.stringify(receipt)+'\n',{mode:0o600});
  await registerManagedCacheRoot(root, {kind: 'prepared', ...fixturePolicy(stateDir)});await markManagedCacheInventoryComplete(root, fixturePolicy(stateDir));
  const result=await recordHostOptOut({host:hosts[0],reason:'municipality_objection'}, fixturePolicy(stateDir));
  if(hosts.length===1){assert.equal(result.purge.deletedFiles,1);await assert.rejects(lstat(path),{code:'ENOENT'});}
  else{assert.equal(result.purge.status,'partial');assert.equal(result.purge.retainedSharedFiles,1);assert.ok(result.purge.issues.some(issue=>issue.code==='shared_derived_requires_rebuild'));assert.equal((await lstat(path)).isFile(),true);}
 }
});

test('explicit frozen-text and raw model-answer inventories purge content without deleting unknown legacy artifacts',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'artifacts');await registerManagedCacheRoot(root, {kind: 'artifacts', ...fixturePolicy(stateDir)});
 for(const suffix of ['.json','.answer.json']){const bytes='synthetic full raw text '+suffix,key=hash(suffix),entry={...rawEntry(bytes),relativePath:key+suffix,sourceSha256:hash('original source')};await publish(root,entry,bytes,stateDir);}
 const unsupported=join(root,'old-frozen-corpus.ndjson');await writeFile(unsupported,'Uninventoried legacy source body',{mode:0o600});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(receipt.purge.deletedFiles,2);assert.equal(receipt.purge.status,'partial');assert.ok(receipt.purge.issues.some(issue=>issue.code==='inventory_incomplete'));assert.equal(await readFile(unsupported,'utf8'),'Uninventoried legacy source body');
 await assert.rejects(publish(root,{...rawEntry('new','https://new.test/doc'),relativePath:hash('new')+'.json'},'new',stateDir),CivicPolicyStateError);
});

test('unsealed artifact roots require explicit hash enrollment before accepting source writes',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'artifacts'),bytes='known derived text',entry={...rawEntry(bytes),relativePath:hash('frozen-id')+'.json'};
 await mkdir(root,{mode:0o700});await writeFile(join(root,entry.relativePath),bytes,{mode:0o600});await registerManagedCacheRoot(root, {kind: 'artifacts', ...fixturePolicy(stateDir)});
 let called=false;await assert.rejects(withManagedSourceWrite(root, [entry], async()=>{called=true;}, fixturePolicy(stateDir)),CivicPolicyStateError);assert.equal(called,false);
 await recordManagedSourceContent(root, entry, fixturePolicy(stateDir));await markManagedCacheInventoryComplete(root, fixturePolicy(stateDir));
 assert.equal((await recordHostOptOut({host:'council.test',reason:'rights_holder_objection'}, fixturePolicy(stateDir))).purge.deletedFiles,1);
});

test('traversal, arbitrary names, symlink roots and writable shared state are rejected before callbacks',async t=>{
 const {base,root,stateDir}=await sandbox(t);await initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)});let called=false;
 for(const relativePath of ['../unrelated','sha256/../../secret','/absolute','sha256\\escape','.secrets','README.md'])await assert.rejects(withManagedSourceWrite(root, [{...rawEntry('x'),relativePath}], async()=>{called=true;}, fixturePolicy(stateDir)),CivicPolicyStateError);
 assert.equal(called,false);const alias=join(base,'alias');await symlink(root,alias);await assert.rejects(registerManagedCacheRoot(alias, {kind: 'fetch', ...fixturePolicy(stateDir)}),CivicPolicyStateError);
 await chmod(stateDir,0o755);await assert.rejects(assertHostNotOptedOut('https://council.test/doc', fixturePolicy(stateDir)),CivicPolicyStateError);await chmod(stateDir,0o700);
 await assert.rejects(recordHostOptOut({host:'council.test',reason:'municipality_objection',reference:'contact person@example.test'}, fixturePolicy(stateDir)));
});

test('hash tampering, file symlinks and hardlinks retain targets and report partial, never unrelated deletion',async t=>{
 const {base,stateDir}=await sandbox(t);
 for(const mode of ['tamper','symlink','hardlink']){
  const root=join(base,mode);await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});const bytes='original-'+mode,entry=rawEntry(bytes,'https://'+mode+'.test/doc');await publish(root,entry,bytes,stateDir);
  const target=join(base,mode+'-outside.txt');await writeFile(target,'unrelated outside content',{mode:0o600});
  if(mode==='tamper')await writeFile(join(root,entry.relativePath),'replacement',{mode:0o600});
  else{await rm(join(root,entry.relativePath));if(mode==='symlink')await symlink(target,join(root,entry.relativePath));else await link(target,join(root,entry.relativePath));}
  const receipt=await recordHostOptOut({host:mode+'.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(receipt.purge.status,'partial');assert.equal(receipt.purge.deletedFiles,0);assert.equal(await readFile(target,'utf8'),'unrelated outside content');
 }
});

test('inventory edits and root inode replacement fail closed with durable error or partial receipts',async t=>{
 const {base,root,stateDir}=await sandbox(t),bytes='owned raw';await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});const entry=rawEntry(bytes);await publish(root,entry,bytes,stateDir);
 const registry=join(stateDir,'inventory.json'),original=await readFile(registry,'utf8'),tampered=JSON.parse(original);tampered.entries[0].relativePath='../outside';await writeFile(registry,JSON.stringify(tampered),{mode:0o600});
 const bad=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(bad.purge.status,'error');assert.equal(bad.purge.issues[0].code,'inventory_unavailable');assert.equal(await readFile(join(root,entry.relativePath),'utf8'),bytes);
 await writeFile(registry,original,{mode:0o600});await rename(root,join(base,'original-root'));await mkdir(root,{mode:0o700});await mkdir(join(root,'sha256'),{mode:0o700});await writeFile(join(root,entry.relativePath),bytes,{mode:0o600});
 const changed=await purgeOptedOutHost('council.test', fixturePolicy(stateDir));assert.equal(changed.status,'partial');assert.equal(changed.deletedFiles,0);assert.equal(await readFile(join(root,entry.relativePath),'utf8'),bytes);
});

test('cached inventory rejects different bytes even when tampering preserves its size',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),bytes='cached raw source',entry=rawEntry(bytes);
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,entry,bytes,stateDir);
 const path=join(stateDir,'inventory.json'),original=await readFile(path,'utf8');
 for(const tamper of ['schema','entry-identity'] as const){
  await writeFile(path,original,{mode:0o600});
  await assertManagedSourceReadable(join(root,entry.relativePath),policy);
  await assertManagedSourceReadable(join(root,entry.relativePath),policy);
  const value=JSON.parse(original);
  if(tamper==='schema')value.entries[0].contentSha256='g'+value.entries[0].contentSha256.slice(1);
  else value.entries[0].host='counci1.test';
  const changed=JSON.stringify(value)+'\n';
  assert.notEqual(changed,original);assert.equal(Buffer.byteLength(changed),Buffer.byteLength(original));
  await writeFile(path,changed,{mode:0o600});
  await assert.rejects(assertManagedSourceReadable(join(root,entry.relativePath),policy),CivicPolicyStateError);
  assert.equal(await readFile(path,'utf8'),changed);assert.equal(await readFile(join(root,entry.relativePath),'utf8'),bytes);
 }
});

test('cached inventory parses independent objects without leaking nested mutations',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),entry=rawEntry('independent cached source');
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,entry,'independent cached source',stateDir);
 await assertManagedSourceReadable(join(root,entry.relativePath),policy);
 const serialized=await readFile(join(stateDir,'inventory.json'),'utf8'),expected=JSON.parse(serialized);
 const parsed:Array<typeof expected>=[],originalParse=JSON.parse;
 // Observe the actual fresh inventory parses through the public locked reader,
 // without exporting a private loader or replacing any authority/file checks.
 t.mock.method(JSON,'parse',(...args:Parameters<typeof JSON.parse>)=>{
  const value=originalParse(...args);if(args[0]===serialized)parsed.push(value);return value;
 });
 await assertManagedSourceReadable(join(root,entry.relativePath),policy);assert.equal(parsed.length,1);
 const first=parsed[0];first.roots[0].complete=false;first.entries[0].state='revoked';first.scratch.push({invalid:'mutation'});first.entries.push({...first.entries[0]});
 await assertManagedSourceReadable(join(root,entry.relativePath),policy);assert.equal(parsed.length,2);
 const second=parsed[1];assert.notStrictEqual(second,first);assert.notStrictEqual(second.roots,first.roots);assert.notStrictEqual(second.roots[0],first.roots[0]);assert.notStrictEqual(second.entries[0],first.entries[0]);assert.notStrictEqual(second.scratch,first.scratch);
 assert.deepEqual(second,expected);assert.equal(await readFile(join(stateDir,'inventory.json'),'utf8'),serialized);
});

for(const missingDefault of ['scratch','resources'] as const)test('noncanonical inventory retains '+missingDefault+' default through recovery before canonical save',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),entry=rawEntry('legacy cached source');
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,entry,'legacy cached source',stateDir);
 if(missingDefault==='resources')await closedRetirementLease(root,stateDir);
 const path=join(stateDir,'inventory.json'),legacy=JSON.parse(await readFile(path,'utf8'));
 if(missingDefault==='scratch')delete legacy.scratch;
 else{
  // A recoverable non-closed lease must consume resources before its save;
  // a closed lease would bypass that default-consuming cleanup path.
  legacy.scratch[0].state='planned';delete legacy.scratch[0].resources;
 }
 const serialized=JSON.stringify(legacy)+'\n';await writeFile(path,serialized,{mode:0o600});
 for(let i=0;i<2;i++)await assertManagedSourceReadable(join(root,entry.relativePath),policy);
 assert.equal(await readFile(path,'utf8'),serialized);
 // Recovery consumes both defaults before canonicalizing anything on disk.
 const recovery=await recoverManagedSourceScratch(policy);assert.equal(recovery.status,'complete');assert.deepEqual(recovery.pendingLeases,[]);
 const saved=JSON.parse(await readFile(path,'utf8'));
 if(missingDefault==='scratch'){assert.deepEqual(recovery.recoveredLeases,[]);assert.deepEqual(saved.scratch,[]);}
 else{assert.deepEqual(recovery.recoveredLeases,[legacy.scratch[0].id]);assert.deepEqual(saved.scratch[0].resources,[]);assert.equal(saved.scratch[0].state,'purged');}
 await assertManagedSourceReadable(join(root,entry.relativePath),policy);
});

test('crashed producer enrollment is retained and a missing content file is accounted for on purge',async t=>{
 const {root,stateDir}=await sandbox(t);await initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)});const entry=rawEntry('not-written');
 await assert.rejects(withManagedSourceWrite(root, [entry], async()=>{throw Error('synthetic crash');}, fixturePolicy(stateDir)),/synthetic crash/);
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(receipt.purge.status,'purged');assert.equal(receipt.purge.missingFiles,1);assert.equal(receipt.purge.deletedFiles,0);
});

test('classification exclusion withdraws exact managed URL/hash only and reports independent physical retention',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});const bytes='shared-exclusion',first=rawEntry(bytes),second=rawEntry(bytes,'https://independent.test/other',true);
 await publish(root,first,bytes,stateDir);await publish(root,second,bytes,stateDir);
 const result=await relinquishManagedSourceContent(root, {url:first.url,sourceSha256:first.sourceSha256}, fixturePolicy(stateDir));assert.equal(result.disposition,'retained_independent');assert.equal(result.removedReferences,1);await assertHostNotOptedOut(first.url, fixturePolicy(stateDir));
 const absent=await relinquishManagedSourceContent(root, {url:first.url,sourceSha256:hash('different')}, fixturePolicy(stateDir));assert.equal(absent.disposition,'not_managed');
 const final=await relinquishManagedSourceContent(root, {url:second.url,sourceSha256:second.sourceSha256}, fixturePolicy(stateDir));assert.equal(final.disposition,'removed');await assert.rejects(lstat(join(root,first.relativePath)),{code:'ENOENT'});
});

test('derived replacement inventories bind actual versions and do not delete unrelated newer source content',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});const relativePath='oparl-bodies/'+hash('body')+'.json';
 const old={...rawEntry('old','https://old.test/page'),relativePath},current={...rawEntry('new','https://new.test/page'),relativePath};await publish(root,old,'old',stateDir);await publish(root,current,'new',stateDir);
 const first=await recordHostOptOut({host:'old.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(first.purge.deletedFiles,0);assert.equal(await readFile(join(root,relativePath),'utf8'),'new');
 const second=await recordHostOptOut({host:'new.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(second.purge.deletedFiles,1);
});

test('operator CLI refuses synthetic authority realms without recording objections or claiming purge',async t=>{
 const {stateDir}=await sandbox(t),outputs:string[]=[];t.mock.method(console,'log',(value:string)=>{outputs.push(value);});
 await assert.rejects(civicOptOutMain(['register','--host','operator.test','--reason','municipality_objection','--authority-id',fixturePolicy(stateDir).authorityId,'--state-dir',stateDir]),CivicPolicyStateError);
 assert.deepEqual(outputs,[]);await assertHostNotOptedOut('https://operator.test/',fixturePolicy(stateDir));
});

test('URL-scoped exclusion retains separate allowed same-host provenance, but a host objection removes both',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});const bytes='same-host shared',denied=rawEntry(bytes,'https://council.test/denied'),allowed=rawEntry(bytes,'https://council.test/allowed',true);
 await publish(root,denied,bytes,stateDir);await publish(root,allowed,bytes,stateDir);
 const exclusion=await relinquishManagedSourceContent(root, {url:denied.url,sourceSha256:denied.sourceSha256}, fixturePolicy(stateDir));assert.equal(exclusion.disposition,'retained_independent');assert.equal(await readFile(join(root,allowed.relativePath),'utf8'),bytes);
 const objection=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(objection.purge.deletedFiles,1);assert.equal(objection.purge.retainedSharedFiles,0);await assert.rejects(assertHostNotOptedOut(allowed.url, fixturePolicy(stateDir)),HostOptedOutError);
});

test('one independent source cannot retain a mixed derived artifact containing another opted-out-only source',async t=>{
 const {root,stateDir}=await sandbox(t);await initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)});const bytes='mixed derived text',relativePath='api-frontiers/'+hash('mixed')+'-mv.json';
 const first={...rawEntry(bytes),sourceSha256:hash('source-a'),relativePath},second={...rawEntry(bytes,'https://council.test/second'),sourceSha256:hash('source-b'),relativePath},independent={...rawEntry(bytes,'https://independent.test/first',true),sourceSha256:hash('source-a'),relativePath};
 await withManagedSourceWrite(root, [first,second,independent], async()=>{await mkdir(join(root,'api-frontiers'),{mode:0o700});await writeFile(join(root,relativePath),bytes,{mode:0o600});}, fixturePolicy(stateDir));
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(receipt.purge.deletedFiles,1);assert.equal(receipt.purge.retainedSharedFiles,0);
});

test('bounded metadata-only frontier and checkpoint formats remain, while interrupted raw temporaries force partial',async t=>{
 const {root,stateDir}=await sandbox(t),bodyId=hash('body');
 await initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)});
 const frontier=join(root,'frontiers',hash('frontier')+'.json'),checkpoint=join(root,'oparl',bodyId,'paper','checkpoint.json');
 await mkdir(dirname(frontier),{recursive:true,mode:0o700});await mkdir(dirname(checkpoint),{recursive:true,mode:0o700});
 await writeFile(frontier,JSON.stringify({schemaVersion:1,municipalityId:'synthetic',sourceId:'council',queue:[],visited:[],documents:[],failures:[],roots:[]}),{mode:0o600});
 await writeFile(checkpoint,JSON.stringify({schemaVersion:1,bodyId:'https://council.test/body',baseUrl:'https://council.test/paper',kind:'paper',backfillComplete:true,watermark:now,active:null,segments:0,pages:0,rawRecordCount:0,lastCheckedAt:now}),{mode:0o600});
 await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});await markManagedCacheInventoryComplete(root, fixturePolicy(stateDir));const entry=rawEntry('published');await publish(root,entry,'published',stateDir);
 const partialPath=join(root,'sha256',hash('unpublished')+'.tmp');await writeFile(partialPath,'partial raw source bytes',{mode:0o600});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(receipt.purge.status,'partial');assert.equal(receipt.purge.deletedFiles,1);assert.equal((await lstat(frontier)).isFile(),true);assert.equal((await lstat(checkpoint)).isFile(),true);assert.equal(await readFile(partialPath,'utf8'),'partial raw source bytes');
});

test('content-free frontiers promote to inventoried source content without adopting unbound payloads',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),relativePath='frontiers/'+hash('promotion')+'.json',path=join(root,relativePath),url='https://council.test/planning';
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await mkdir(dirname(path),{mode:0o700});
 const metadata={schemaVersion:1,municipalityId:'synthetic',sourceId:'council',queue:[{url,sourceId:'council',from:url,depth:0}],visited:[],documents:[],failures:[],roots:[url]};
 await writeFile(path,JSON.stringify(metadata),{mode:0o600});await assertManagedSourceReadable(path,policy);
 const bytes=JSON.stringify({...metadata,queue:[{...metadata.queue[0],title:'Synthetic source-bearing planning title'}]}),entry={...rawEntry(bytes,url),relativePath,sourceSha256:hash('source document')};
 await withManagedSourceWrite(root,[entry],()=>writeFile(path,bytes,{mode:0o600}),policy);await assertManagedSourceReadable(path,policy);
 await markManagedCacheInventoryComplete(root,policy);
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy);
 assert.equal(receipt.purge.status,'purged');assert.equal(receipt.purge.deletedFiles,1);await assert.rejects(lstat(path),{code:'ENOENT'});
 await assert.rejects(assertManagedSourceReadable(path,policy),HostOptedOutError);
});

test('frontier promotion rejects payloads, foreign paths, unsafe files and withdrawn metadata ancestors before writing',async t=>{
 for(const disposition of ['payload','foreign_path','hardlink','permissions','withdrawn_ancestor'] as const){
  const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),folder=disposition==='foreign_path'?'oparl-bodies':'frontiers',relativePath=folder+'/'+hash(disposition)+'.json',path=join(root,relativePath),url='https://council.test/planning';
  await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await mkdir(dirname(path),{mode:0o700});
  const metadata={schemaVersion:1,municipalityId:'synthetic',sourceId:'council',queue:[{url,sourceId:'council',from:url,depth:0}],visited:[],documents:[],failures:[],roots:[url]};
  await writeFile(path,JSON.stringify({...metadata,...(disposition==='payload'?{sourceBody:'Unbound private source text'}:{})}),{mode:0o600});
  if(disposition==='hardlink')await link(path,join(root,'frontiers',hash('hardlink-alias')+'.json'));
  if(disposition==='permissions')await chmod(path,0o620);
  if(disposition==='withdrawn_ancestor')await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy);
  const bytes='new source-bearing frontier',entry={...rawEntry(bytes,'https://independent.test/source'),relativePath,sourceSha256:hash('source')},before=await readFile(path);let called=false;
  await assert.rejects(withManagedSourceWrite(root,[entry],async()=>{called=true;await writeFile(path,bytes);},policy),disposition==='withdrawn_ancestor'?HostOptedOutError:CivicPolicyStateError);
  assert.equal(called,false);assert.deepEqual(await readFile(path),before);
 }
});

test('malformed opt-out metadata fails closed and does not leak tampered source text in audit',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));
 const marker=join(stateDir,'hosts',hash('council.test')+'.json'),value=JSON.parse(await readFile(marker,'utf8'));value.purgeDueAt='2099-01-01T00:00:00.000Z';await writeFile(marker,JSON.stringify(value),{mode:0o600});
 await assert.rejects(assertHostNotOptedOut('https://council.test/doc', fixturePolicy(stateDir)),CivicPolicyStateError);await assert.rejects(purgeOptedOutHost('council.test', fixturePolicy(stateDir)),CivicPolicyStateError);
});

test('simultaneous same-host objections preserve the earliest canonical UTC deadline',async t=>{
 const {root,stateDir}=await sandbox(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});
 await Promise.all(['2026-10-10T12:00:00.000Z','2026-10-09T14:00:00.000+02:00','2026-10-11T12:00:00.000Z'].map(receivedAt=>recordHostOptOut({host:'council.test',reason:'municipality_objection',receivedAt}, fixturePolicy(stateDir))));
 const final=await purgeOptedOutHost('council.test', fixturePolicy(stateDir));assert.equal(final.receivedAt,'2026-10-09T12:00:00.000Z');assert.equal(final.purgeDueAt,'2026-10-16T12:00:00.000Z');await assert.rejects(assertHostNotOptedOut('https://council.test/source', fixturePolicy(stateDir)),HostOptedOutError);
});

test('operator CLI cannot redirect production-authority work to an alternate local store',async t=>{
 const {root,stateDir}=await sandbox(t),bytes='operator-owned source',entry=rawEntry(bytes);await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});await publish(root,entry,bytes,stateDir);
 await assert.rejects(civicOptOutMain(['register','--host','council.test','--reason','rights_holder_objection','--authority-id',CIVIC_POLICY_AUTHORITY_ID,'--state-dir',stateDir]),CivicPolicyStateError);
 assert.equal(await readFile(join(root,entry.relativePath),'utf8'),bytes);
});

test('explicit acquisition initialization seals empty roots of every kind with owner-only identity-bound markers',async t=>{
 const {base,stateDir}=await sandbox(t);
 for(const kind of ['fetch','prepared','artifacts'] as const){
  const root=join(base,kind);if(kind==='prepared')await mkdir(root,{mode:0o755});
  await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind,...fixturePolicy(stateDir)});
  const path=join(root,'.civic-acquisition-lane.json'),marker=JSON.parse(await readFile(path,'utf8')),stat=await lstat(root);
  assert.equal(marker.decisionId,CIVIC_ACQUISITION_DECISION_ID);assert.equal(marker.kind,kind);assert.equal(marker.rootId,hash(root));assert.deepEqual(marker.identity,{dev:stat.dev,ino:stat.ino});assert.equal((await lstat(path)).mode&0o777,0o600);
  await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind,...fixturePolicy(stateDir)});await markManagedCacheInventoryComplete(root, fixturePolicy(stateDir));
 }
 const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));assert.equal(inventory.roots.length,3);assert.ok(inventory.roots.every((root:{complete:boolean})=>root.complete));
});

for(const layout of ['legacy','sealed'])for(const direction of ['nested','ancestor'])test('overlapping '+direction+' lanes leave no debris or incomplete enrolled root: '+layout,async t=>{
 const {base,stateDir}=await sandbox(t),outer=join(base,'lanes'),root=join(outer,'cas'),policy=fixturePolicy(stateDir);
 const options={decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts' as const,...policy};
 await initializeManagedAcquisitionLane(root,options);
 if(layout==='sealed')await compactCivicPolicyInventory(policy);
 const attempted=direction==='nested'?join(root,'residual-prepared','deep'):outer;
 const original=await readFile(join(stateDir,'inventory.json')),marker=await readFile(join(root,'.civic-acquisition-lane.json')),files=await readdir(base,{recursive:true});
 await assert.rejects(initializeManagedAcquisitionLane(attempted,options),CivicPolicyStateError);
 await assert.rejects(registerManagedCacheRoot(attempted,{kind:'artifacts',...policy}),CivicPolicyStateError);
 let called=false;
 await assert.rejects(withManagedSourceScratch(attempted,[{phase:'pre-admission',url:'https://overlap.test/source',sourceSha256:hash('synthetic overlap source')}],async()=>{called=true;},{...options,purpose:'classification'}),CivicPolicyStateError);
 assert.equal(called,false);assert.deepEqual(await readdir(base,{recursive:true}),files);
 assert.deepEqual(await readFile(join(stateDir,'inventory.json')),original);assert.deepEqual(await readFile(join(root,'.civic-acquisition-lane.json')),marker);
 if(direction==='nested')await assert.rejects(lstat(join(root,'residual-prepared')),{code:'ENOENT'});
 else await assert.rejects(lstat(join(outer,'.civic-acquisition-lane.json')),{code:'ENOENT'});
 await markManagedCacheInventoryComplete(root,policy);
 const inventory=await readCivicPolicyInventory(policy);assert.equal(inventory.roots.length,1);assert.equal(inventory.roots[0].path,root);assert.equal(inventory.roots[0].complete,true);assert.deepEqual(inventory.scratch,[]);
});

test('authority-state overlap refuses lane creation without filesystem or inventory changes',async t=>{
 const {base,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),files=await readdir(base,{recursive:true}),original=await readFile(join(stateDir,'inventory.json'));
 for(const path of [stateDir,join(stateDir,'forbidden','lane'),base]){
  await assert.rejects(initializeManagedAcquisitionLane(path,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy}),CivicPolicyStateError);
  await assert.rejects(registerManagedCacheRoot(path,{kind:'artifacts',...policy}),CivicPolicyStateError);
 }
 assert.deepEqual(await readdir(base,{recursive:true}),files);assert.deepEqual(await readFile(join(stateDir,'inventory.json')),original);
});

test('dated paths and known legacy CAS files cannot authorize nonempty unmarked acquisition roots',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'isolated0.3.2-owner-2026-10-11'),bytes='historical source';
 await mkdir(join(root,'sha256'),{recursive:true,mode:0o700});await writeFile(join(root,'sha256',hash(bytes)),bytes,{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)}),CivicPolicyStateError);
 assert.deepEqual(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).roots,[]);await assert.rejects(lstat(join(root,'.civic-acquisition-lane.json')),{code:'ENOENT'});assert.equal(await readFile(join(root,'sha256',hash(bytes)),'utf8'),bytes);
});

test('generic purge-root registration never grants source-write authorization',async t=>{
 const {root,stateDir}=await sandbox(t);await registerManagedCacheRoot(root, {kind: 'fetch', ...fixturePolicy(stateDir)});let called=false;
 await assert.rejects(withManagedSourceWrite(root, [rawEntry('new')], async()=>{called=true;}, fixturePolicy(stateDir)),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='ACQUISITION_LANE_REQUIRED');
 assert.equal(called,false);await assert.rejects(lstat(join(root,'.civic-acquisition-lane.json')),{code:'ENOENT'});
});

test('marker copying, kind changes, unsafe permissions and wrong decisions cannot reauthorize a root',async t=>{
 const {base,root,stateDir}=await sandbox(t);await initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)});
 const markerPath=join(root,'.civic-acquisition-lane.json'),bytes=await readFile(markerPath),copy=join(base,'copy');await mkdir(copy,{mode:0o700});await writeFile(join(copy,'.civic-acquisition-lane.json'),bytes,{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(copy, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)}),CivicPolicyStateError);
 await assert.rejects(initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, kind: 'prepared', ...fixturePolicy(stateDir)}),CivicPolicyStateError);
 await assert.rejects(initializeManagedAcquisitionLane(join(base,'wrong-decision'), {decisionId: 'unapproved' as typeof CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)}),CivicPolicyStateError);
 await assert.rejects(lstat(join(base,'wrong-decision')),{code:'ENOENT'});
 await chmod(markerPath,0o644);await assert.rejects(initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)}),CivicPolicyStateError);await chmod(markerPath,0o600);
 const stat=await readFile(join(stateDir,'inventory.json'),'utf8');await rename(root,join(base,'moved'));await mkdir(root,{mode:0o700});await writeFile(join(root,'.civic-acquisition-lane.json'),bytes,{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)}),CivicPolicyStateError);assert.equal(await readFile(join(stateDir,'inventory.json'),'utf8'),stat);
});

test('concurrent initialization converges on one marker and valid markers do not conceal incomplete inventories',async t=>{
 const {root,stateDir}=await sandbox(t);await Promise.all(Array.from({length:4},()=>initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)})));
 assert.equal(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).roots.length,1);
 await writeFile(join(root,'unsupported-frozen-text.txt'),'unknown legacy source content',{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(root, {decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='MANAGED_INVENTORY_INCOMPLETE');
 assert.equal(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).roots[0].complete,false);
});

test('snapshots require provisioned authority and hash only their explicit authority-bound projection',async t=>{
 const {stateDir}=await sandbox(t,false);await assert.rejects(readCivicOptOutSnapshot(fixturePolicy(stateDir)),CivicPolicyStateError);await assert.rejects(lstat(stateDir),{code:'ENOENT'});
 const authority=await provisionFixture(stateDir),snapshot=await readCivicOptOutSnapshot(fixturePolicy(stateDir));
 const body={schemaVersion:'civic-opt-out-snapshot-v2',authorityId:authority.authorityId,authoritySha256:authority.authoritySha256,objections:[]};
 assert.deepEqual(snapshot,{...body,sha256:hash(JSON.stringify(body))});
 await recordHostOptOut({host:'later.test',reason:'municipality_objection'}, fixturePolicy(stateDir));
 await assert.rejects(assertHostNotOptedOut('https://later.test/source', fixturePolicy(stateDir)),HostOptedOutError);assert.equal(snapshot.objections.length,0);
});

test('snapshot entries sort hashed hosts, select earliest deadlines and omit private provenance',async t=>{
 const {base,stateDir}=await sandbox(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});
 await recordHostOptOut({host:'zeta.test',reason:'rights_holder_objection',reference:'PRIVATE-OPAQUE-Z',receivedAt:'2026-10-10T00:00:00.000Z'}, fixturePolicy(stateDir));
 await recordHostOptOut({host:'alpha.test',reason:'municipality_objection',reference:'PRIVATE-OPAQUE-A',receivedAt:'2026-10-09T00:00:00.000Z'}, fixturePolicy(stateDir));
 await recordHostOptOut({host:'alpha.test',reason:'municipality_objection',receivedAt:'2026-10-08T00:00:00.000Z'}, fixturePolicy(stateDir));
 const snapshot=await readCivicOptOutSnapshot(fixturePolicy(stateDir)),objections=[
  {hostSha256:hash('alpha.test'),receivedAt:'2026-10-08T00:00:00.000Z',purgeDueAt:'2026-10-15T00:00:00.000Z'},
  {hostSha256:hash('zeta.test'),receivedAt:'2026-10-10T00:00:00.000Z',purgeDueAt:'2026-10-17T00:00:00.000Z'},
 ].sort((a,b)=>a.hostSha256<b.hostSha256?-1:1);
 assert.deepEqual(snapshot.objections,objections);assert.equal(snapshot.sha256,hash(JSON.stringify({schemaVersion:'civic-opt-out-snapshot-v2',authorityId:snapshot.authorityId,authoritySha256:snapshot.authoritySha256,objections})));
 const encoded=JSON.stringify(snapshot);for(const privateValue of ['alpha.test','zeta.test','PRIVATE-OPAQUE',stateDir,'municipality_objection','rights_holder_objection'])assert.equal(encoded.includes(privateValue),false);
 await registerManagedCacheRoot(join(base,'another-private-root'), {kind: 'fetch', ...fixturePolicy(stateDir)});await purgeOptedOutHost('alpha.test', fixturePolicy(stateDir));
 assert.equal((await readCivicOptOutSnapshot(fixturePolicy(stateDir))).sha256,snapshot.sha256);
});

test('equal host projections from separate authorities cannot share an immutable authority binding',async t=>{
 const {base,stateDir}=await sandbox(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(now)});const other=join(base,'other-policy');await provisionFixture(other);
 for(const [path,reference,reason] of [[stateDir,'PRIVATE-ONE','municipality_objection'],[other,'PRIVATE-TWO','rights_holder_objection']] as const)await recordHostOptOut({host:'council.test',reason,reference,receivedAt:now},fixturePolicy(path));
 const first=await readCivicOptOutSnapshot(fixturePolicy(stateDir)),second=await readCivicOptOutSnapshot(fixturePolicy(other));assert.deepEqual(first.objections,second.objections);assert.notEqual(first.authoritySha256,second.authoritySha256);assert.notEqual(first.sha256,second.sha256);await assert.rejects(assertCivicPolicyAuthority({...fixturePolicy(other), authoritySha256: first.authoritySha256}),CivicPolicyStateError);
});

test('snapshot capture rejects concurrent membership or immutable-file changes instead of returning a torn hash',async t=>{
 for(const mutation of ['insert','replace']){
  const {stateDir}=await sandbox(t);await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));
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
  try{await assert.rejects(readCivicOptOutSnapshot(fixturePolicy(stateDir)),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_BUSY');}
  finally{t.mock.restoreAll();syncBuiltinESMExports();}
 }
});

test('snapshots reject orphan revisions, unknown registry files and unsafe host metadata without exposing contents',async t=>{
 const {stateDir}=await sandbox(t);await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));const hosts=join(stateDir,'hosts'),marker=join(hosts,hash('council.test')+'.json');
 const value=JSON.parse(await readFile(marker,'utf8')),revision=join(hosts,hash('council.test')+'-'+hash(value.receivedAt)+'.json');await rename(marker,revision);
 await assert.rejects(readCivicOptOutSnapshot(fixturePolicy(stateDir)),CivicPolicyStateError);await rename(revision,marker);
 const unknown=join(hosts,'unknown.json');await writeFile(unknown,'PRIVATE-SOURCE-CONTENT',{mode:0o600});
 await assert.rejects(readCivicOptOutSnapshot(fixturePolicy(stateDir)),(error:unknown)=>error instanceof CivicPolicyStateError&&!error.message.includes('PRIVATE-SOURCE-CONTENT'));await rm(unknown);
 await chmod(marker,0o644);await assert.rejects(readCivicOptOutSnapshot(fixturePolicy(stateDir)),CivicPolicyStateError);
});

test('sharded source CAS supports arbitrary bytes and preserves independent raw provenance without host fallback',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'source-cas'),bytes='\u0000\u0001synthetic native source',contentSha256=hash(bytes),relativePath='sha256/'+contentSha256.slice(0,2)+'/'+contentSha256;
 await initializeManagedAcquisitionLane(root, {kind: 'artifacts', decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)});
 const first={...rawEntry(bytes),relativePath},second={...rawEntry(bytes,'https://independent.test/source',true),relativePath};await publish(root,first,bytes,stateDir);await publish(root,second,bytes,stateDir);
 const one=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(one.purge.status,'purged');assert.equal(one.purge.deletedFiles,0);assert.equal(one.purge.retainedSharedFiles,1);assert.equal(await readFile(join(root,relativePath),'utf8'),bytes);
 await assert.rejects(assertHostNotOptedOut(first.url, fixturePolicy(stateDir)),HostOptedOutError);await assertHostNotOptedOut(second.url, fixturePolicy(stateDir));
 const two=await recordHostOptOut({host:'independent.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(two.purge.deletedFiles,1);await assert.rejects(lstat(join(root,relativePath)),{code:'ENOENT'});assert.equal((await lstat(join(root,'.civic-acquisition-lane.json'))).isFile(),true);
});

test('sharded derived CAS records every source binding and retains unrelated original objects',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'source-cas');await initializeManagedAcquisitionLane(root, {kind: 'artifacts', decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)});
 const bytes='multi-source parsed native content',contentSha256=hash(bytes),relativePath='sha256/'+contentSha256.slice(0,2)+'/'+contentSha256,otherBytes='independently acquired original',otherHash=hash(otherBytes);
 const entries=[{...rawEntry(bytes),relativePath,sourceSha256:hash('council original')},{...rawEntry(bytes,'https://other.test/original',true),relativePath,sourceSha256:otherHash}];
 await withManagedSourceWrite(root, entries, async()=>{await mkdir(dirname(join(root,relativePath)),{recursive:true,mode:0o700});await writeFile(join(root,relativePath),bytes,{mode:0o600});}, fixturePolicy(stateDir));
 const independent={...rawEntry(otherBytes,'https://other.test/original',true),relativePath:'sha256/'+otherHash.slice(0,2)+'/'+otherHash};await publish(root,independent,otherBytes,stateDir);
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(receipt.purge.deletedFiles,1);assert.equal(receipt.purge.retainedSharedFiles,0);assert.equal(await readFile(join(root,independent.relativePath),'utf8'),otherBytes);
});

test('sharded CAS rejects wrong prefixes, mismatched basenames and unregistered blobs including claimed metadata',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'source-cas');await initializeManagedAcquisitionLane(root, {kind: 'artifacts', decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)});
 const bytes='bound object',entry=rawEntry(bytes),prefix=entry.contentSha256.slice(0,2),wrong=prefix==='00'?'ff':'00';let called=false;
 for(const relativePath of ['sha256/'+wrong+'/'+entry.contentSha256,'sha256/'+prefix+'/'+hash('different'),'sha256/'+prefix+'/../'+entry.contentSha256,'sha256/'+prefix+'/'+entry.contentSha256+'.json'])await assert.rejects(withManagedSourceWrite(root, [{...entry,relativePath}], async()=>{called=true;}, fixturePolicy(stateDir)),CivicPolicyStateError);
 assert.equal(called,false);
 const unregistered=JSON.stringify({schemaVersion:'claimed-safe-metadata',kind:'metadata',fullText:'untracked source body'}),sha256=hash(unregistered),path=join(root,'sha256',sha256.slice(0,2),sha256);
 await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,unregistered,{mode:0o600});
 await assert.rejects(initializeManagedAcquisitionLane(root, {kind: 'artifacts', decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='MANAGED_INVENTORY_INCOMPLETE');
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(receipt.purge.status,'partial');assert.equal(receipt.purge.deletedFiles,0);assert.equal(await readFile(path,'utf8'),unregistered);
});

test('retained sharded derived copies remain explicit partial and canonical audit outside the content root survives',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'source-cas');await initializeManagedAcquisitionLane(root, {kind: 'artifacts', decisionId: CIVIC_ACQUISITION_DECISION_ID, ...fixturePolicy(stateDir)});
 const bytes='derived full model output',contentSha256=hash(bytes),relativePath='sha256/'+contentSha256.slice(0,2)+'/'+contentSha256,sourceSha256=hash('original source');
 const first={...rawEntry(bytes),relativePath,sourceSha256},other={...rawEntry(bytes,'https://independent.test/source',true),relativePath,sourceSha256};await publish(root,first,bytes,stateDir);await publish(root,other,bytes,stateDir);
 const canonicalAudit=join(base,'canonical-audit.json');await writeFile(canonicalAudit,JSON.stringify({sourceSha256,receiptSha256:first.receiptSha256}),{mode:0o600});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'}, fixturePolicy(stateDir));assert.equal(receipt.purge.status,'partial');assert.equal(receipt.purge.retainedSharedFiles,1);assert.ok(receipt.purge.issues.some(issue=>issue.code==='shared_derived_requires_rebuild'));assert.equal(JSON.parse(await readFile(canonicalAudit,'utf8')).sourceSha256,sourceSha256);
});

test('production authority cannot fork into a temporary store and fixture authority requires its exact pin',async t=>{
 const {base,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),first=await assertCivicPolicyAuthority(policy);
 assert.equal(first.mode,'isolated-fixture');assert.deepEqual(await provisionFixture(stateDir),first);
 await assert.rejects(assertCivicPolicyAuthority({stateDir,authorityId:policy.authorityId}),CivicPolicyStateError);
 await assert.rejects(assertCivicPolicyAuthority({...policy,authoritySha256:hash('wrong authority')}),CivicPolicyStateError);
 const fork=join(base,'production-fork');await assert.rejects(provisionCivicPolicyAuthority({stateDir:fork,authorityId:CIVIC_POLICY_AUTHORITY_ID}),CivicPolicyStateError);await assert.rejects(lstat(fork),{code:'ENOENT'});
 const copied=join(base,'copied-policy');await cp(stateDir,copied,{recursive:true});await assert.rejects(assertCivicPolicyAuthority({...policy,stateDir:copied}),CivicPolicyStateError);
 await rm(join(stateDir,'authority.json'));await assert.rejects(assertHostNotOptedOut('https://council.test/doc',policy),CivicPolicyStateError);await assert.rejects(readCivicOptOutSnapshot(policy),CivicPolicyStateError);
});

for(const malformed of ['{','{}'])test('authority '+(malformed==='{'?'JSON':'schema')+' failures retain state errors at precheck and locked inventory read',async t=>{
 const {stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),path=join(stateDir,'authority.json'),saved=await readFile(path);
 await writeFile(path,malformed,{mode:0o600});
 await assert.rejects(assertCivicPolicyAuthority(policy),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_AUTHORITY_UNAVAILABLE');
 await writeFile(path,saved,{mode:0o600});
 const originalOpen=fsPromises.open;let injected=0;
 t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
  if(String(args[0])===path&&injected===0&&new Error().stack?.includes('loadInventory')){
   injected++;await writeFile(path,malformed,{mode:0o600});
   const handle=await originalOpen(...args),close=handle.close.bind(handle);
   handle.close=async()=>{try{await close();}finally{await writeFile(path,saved,{mode:0o600});}};
   return handle;
  }
  return originalOpen(...args);
 });syncBuiltinESMExports();
 try{await assert.rejects(readCivicPolicyInventory(policy),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_INVENTORY_UNAVAILABLE');assert.equal(injected,1);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();await writeFile(path,saved,{mode:0o600});}
 assert.deepEqual(await readFile(path),saved);await assertCivicPolicyAuthority(policy);
});

test('private records, result caches, quarantines, frozen archives and materialized outputs are source content',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'private-outputs'),policy=fixturePolicy(stateDir);
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 const paths=[hash('record')+'.record.json','results/'+hash('task')+'.json','records.json','quarantine.json','frozen/archive.json','staging/knowledge/records.jsonl','release/regions/sample.geojson'];
 for(const relativePath of paths){const bytes=JSON.stringify({quote:'synthetic verbatim private source',rejectedCandidate:true,relativePath}),entry={...rawEntry(bytes),sourceSha256:hash('original source'),relativePath};await publish(root,entry,bytes,stateDir);await assertManagedSourceReadable(join(root,relativePath),policy);}
 const audit=join(base,'content-free-audit.json');await writeFile(audit,JSON.stringify({sourceSha256:hash('original source'),outputHashes:paths.map(hash)}),{mode:0o600});
 const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy);assert.equal(receipt.purge.deletedFiles,paths.length);assert.equal(receipt.purge.status,'purged');
 for(const relativePath of paths){await assert.rejects(lstat(join(root,relativePath)),{code:'ENOENT'});await assert.rejects(assertManagedSourceReadable(join(root,relativePath),policy),HostOptedOutError);}
 await assert.rejects(assertManagedSourceReadable(join(root,paths[0]),{...policy,authoritySha256:hash('foreign authority')}),CivicPolicyStateError);
 assert.equal((await lstat(audit)).isFile(),true);
});

test('readable preflight distinguishes absent candidates and never drops withdrawn contributors from derived content',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'readable'),policy=fixturePolicy(stateDir);
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 await assert.rejects(assertManagedSourceReadable(join(root,'missing.json'),policy),{code:'ENOENT'});
 const bytes=JSON.stringify({text:'source excerpt'}),first={...rawEntry(bytes),relativePath:'frozen.json',sourceSha256:hash('original')},other={...rawEntry(bytes,'https://independent.test/source',true),relativePath:'frozen.json',sourceSha256:first.sourceSha256};
 await publish(root,first,bytes,stateDir);await publish(root,other,bytes,stateDir);await assertManagedSourceReadable(join(root,'frozen.json'),policy);
 await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy);
 await assert.rejects(assertManagedSourceReadable(join(root,'frozen.json'),policy),HostOptedOutError);await assert.rejects(assertManagedSourceReadable(join(root,'frozen.json'),{...policy,sourceUrl:other.url}),HostOptedOutError);
 const unknown=join(root,'not-enrolled.record.json');await writeFile(unknown,'private quoted content',{mode:0o600});await assert.rejects(assertManagedSourceReadable(unknown,policy),CivicPolicyStateError);
});

test('managed scratch is enrolled before bytes and nested atomic artifact publication does not deadlock',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'scratch-content'),policy=fixturePolicy(stateDir),bytes=Buffer.from('synthetic scratch source'),sourceSha256=hash(bytes);
 const binding={kind:'prepared_source' as const,url:'https://council.test/source',sourceSha256,observationId:'source-observation',receiptSha256:hash('source-receipt')};let temporary='';
 await withManagedSourceScratch(root,[binding],async scope=>{
  temporary=scope.directory;const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')),lease=inventory.scratch.find((item:{directory:string})=>scope.directory===join(root,item.directory));
  assert.equal(lease.state,'active');assert.equal(lease.sources[0].sourceSha256,sourceSha256);assert.deepEqual(await readdir(scope.directory),[]);
  await scope.writeSource('document.pdf',bytes);assert.equal((await lstat(join(scope.directory,'document.pdf'))).mode&0o777,0o600);
  await writeFile(join(scope.directory,'page-1.png'),'synthetic OCR pixels',{mode:0o600});
  const output=JSON.stringify({quote:'synthetic derived quote'}),staged=join(scope.directory,'output.tmp');await writeFile(staged,output,{mode:0o600});
  await withManagedSourceWrite(root,[{...binding,independentAllowed:false,relativePath:'records.json',contentSha256:hash(output)}],()=>rename(staged,join(root,'records.json')),policy);
 },{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',purpose:'artifact',...policy});
 await assert.rejects(lstat(temporary),{code:'ENOENT'});assert.equal((await lstat(join(root,'records.json'))).isFile(),true);
 const inventory=await readFile(join(stateDir,'inventory.json'),'utf8');assert.equal(inventory.includes('synthetic scratch source'),false);assert.equal(inventory.includes('synthetic OCR pixels'),false);assert.equal(JSON.parse(inventory).scratch[0].state,'closed');
});

test('artifact scratch accepts 100,000 sources and rejects a lease above that cap before its callback',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'large-scratch'),policy=fixturePolicy(stateDir);
 const bindings=Array.from({length:100_000},(_,i)=>({kind:'prepared_source' as const,url:'https://council.test/source/'+i,sourceSha256:hash('source'),observationId:'source-observation',receiptSha256:hash('source-receipt')}));
 const options={decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts' as const,purpose:'artifact' as const,...policy};
 await withManagedSourceScratch(root,bindings,async scope=>{
  const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));
  assert.equal(inventory.scratch[0].sources.length,100_000);assert.equal(inventory.scratch[0].state,'active');
  await scope.assertActive();
 },options);
 let called=false;
 await assert.rejects(withManagedSourceScratch(root,[...bindings,bindings[0]],async()=>{called=true;},options),error=>error instanceof Error&&error.name==='ZodError');
 assert.equal(called,false);
 const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));
 assert.equal(inventory.scratch.length,1);assert.equal(inventory.scratch[0].state,'closed');
});

test('scratch pre-admission provenance is classification-only and unsafe paths never delete unrelated files',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'scratch-content'),policy=fixturePolicy(stateDir),bytes=Buffer.from('input'),binding={phase:'pre-admission' as const,url:'https://council.test/source',sourceSha256:hash(bytes)};
 let called=false;await assert.rejects(withManagedSourceScratch(root,[binding],async()=>{called=true;},{decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'openai',...policy}),CivicPolicyStateError);assert.equal(called,false);await assert.rejects(lstat(root),{code:'ENOENT'});
 const outside=join(base,'outside.txt');await writeFile(outside,'unrelated user bytes',{mode:0o600});
 await assert.rejects(withManagedSourceScratch(root,[binding],async scope=>{
  await scope.writeSource('source.pdf',bytes);await assert.rejects(scope.writeSource('../outside.txt',bytes),CivicPolicyStateError);await symlink(outside,join(scope.directory,'escaped'));
 },{decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',...policy}),CivicPolicyStateError);
 assert.equal(await readFile(outside,'utf8'),'unrelated user bytes');const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy);assert.equal(receipt.purge.status,'partial');assert.ok(receipt.purge.issues.some(issue=>issue.code==='unsafe_scratch'));
});

for(const layout of ['legacy','sealed'])test('canonical recovery retires an interrupted empty private credential directory only: '+layout,async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'cas'),policy=fixturePolicy(stateDir),bytes='Retained authenticated CAS source',entry={...rawEntry(bytes),relativePath:'sha256/'+hash(bytes).slice(0,2)+'/'+hash(bytes)};
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await publish(root,entry,bytes,stateDir);
 const binding={kind:'prepared_source' as const,url:entry.url,sourceSha256:hash(bytes),observationId:'synthetic-bridge',receiptSha256:entry.receiptSha256};
 const rmdir=fsPromises.rmdir,mock=t.mock.method(fsPromises,'rmdir',async(...args:Parameters<typeof fsPromises.rmdir>)=>{
  if(String(args[0]).endsWith('/credential-cwd'))throw Error('Synthetic interrupted directory retirement');
  return rmdir(...args);
 });syncBuiltinESMExports();
 let scratch='';
 try{
  await assert.rejects(withManagedSourceScratch(root,[binding],async scope=>{
   scratch=scope.directory;await assert.rejects(scope.writeSource('credential-cwd/token.json',Buffer.from('never written')),CivicPolicyStateError);
   await mkdir(join(scratch,'credential-cwd'),{mode:0o700});
  },{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'artifact',...policy}),CivicPolicyStateError);
 }finally{mock.mock.restore();syncBuiltinESMExports();}
 let inventory=await readCivicPolicyInventory(policy);assert.equal(inventory.scratch[0].state,'partial');
 if(layout==='sealed')await compactCivicPolicyInventory(policy);
 const recovered=await recoverManagedSourceScratch(policy);assert.equal(recovered.status,'complete');assert.equal(recovered.deletedFiles,0);assert.equal(recovered.deletedBytes,0);
 assert.deepEqual(recovered.recoveredLeases,[inventory.scratch[0].id]);await assert.rejects(lstat(scratch),{code:'ENOENT'});
 inventory=await readCivicPolicyInventory(policy);assert.equal(inventory.scratch[0].state,'purged');assert.equal(inventory.roots[0].complete,true);
 await assertManagedSourceReadable(join(root,entry.relativePath),policy);assert.equal(await readFile(join(root,entry.relativePath),'utf8'),bytes);
});

for(const variant of ['content','nested','symlink','public','active'] as const)test('credential-path cleanup still refuses '+variant,async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'protected-scratch'),policy=fixturePolicy(stateDir),outside=join(base,'outside'),binding={phase:'pre-admission' as const,url:'https://council.test/source',sourceSha256:hash('source')};
 await mkdir(outside,{mode:0o700});await writeFile(join(outside,'token.json'),'Synthetic unrelated credential content',{mode:0o600});
 let scratch='';
 const operation=withManagedSourceScratch(root,[binding],async scope=>{
  scratch=scope.directory;const path=join(scratch,'credential-cwd');
  if(variant==='symlink')await symlink(outside,path);
  else{
   await mkdir(path,{mode:0o700});
   if(variant==='content')await writeFile(join(path,'token.json'),'Synthetic protected content',{mode:0o600});
   if(variant==='nested')await mkdir(join(path,'empty-child'),{mode:0o700});
   if(variant==='public')await chmod(path,0o755);
  }
  if(variant==='active'){
   const receipt=await recoverManagedSourceScratch(policy);assert.equal(receipt.status,'partial');assert.ok(receipt.issues.some(issue=>issue.code==='active_scratch'));
   assert.equal((await lstat(path)).isDirectory(),true);
  }
 },{decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',...policy});
 if(variant==='active'){await operation;return;}
 await assert.rejects(operation,CivicPolicyStateError);const receipt=await recoverManagedSourceScratch(policy);
 assert.equal(receipt.status,'partial');assert.ok(receipt.issues.some(issue=>issue.code==='unsafe_scratch'));
 assert.equal((await lstat(join(scratch,'credential-cwd'))).isSymbolicLink(),variant==='symlink');
 if(variant==='content')assert.equal(await readFile(join(scratch,'credential-cwd','token.json'),'utf8'),'Synthetic protected content');
 assert.equal(await readFile(join(outside,'token.json'),'utf8'),'Synthetic unrelated credential content');
});

for(const layout of ['legacy','sealed'])test('canonical recovery seals and purges only a stopped private Codex output after permissive umask: '+layout,async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'model-scratch'),policy=fixturePolicy(stateDir),bytes='Retained synthetic source',entry={...rawEntry(bytes),relativePath:'sha256/'+hash(bytes).slice(0,2)+'/'+hash(bytes)};
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await publish(root,entry,bytes,stateDir);
 const binding={kind:'prepared_source' as const,url:entry.url,sourceSha256:hash(bytes),observationId:'synthetic-model',receiptSha256:entry.receiptSha256};
 let output='',scratch='';const open=fsPromises.open;
 const mock=t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
  if(output&&String(args[0])===output)throw Error('Synthetic interruption before output sealing');
  return open(...args);
 });syncBuiltinESMExports();
 try{
  await assert.rejects(withManagedSourceScratch(root,[binding],async scope=>{
   scratch=scope.directory;output=join(scratch,'answer.json');
   await writeFile(output,'{"synthetic":true}',{mode:0o600});await chmod(output,0o664);
  },{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'openai',...policy}),CivicPolicyStateError);
 }finally{mock.mock.restore();syncBuiltinESMExports();}
 assert.equal((await lstat(output)).mode&0o777,0o664);
 let inventory=await readCivicPolicyInventory(policy);const lease=inventory.scratch[0];assert.equal(lease.state,'partial');
 if(layout==='sealed')await compactCivicPolicyInventory(policy);
 const recovered=await recoverManagedSourceScratch(policy);
 assert.equal(recovered.status,'complete');assert.deepEqual(recovered.recoveredLeases,[lease.id]);assert.equal(recovered.deletedFiles,1);assert.equal(recovered.deletedBytes,Buffer.byteLength('{"synthetic":true}'));
 await assert.rejects(lstat(scratch),{code:'ENOENT'});
 inventory=await readCivicPolicyInventory(policy);assert.equal(inventory.scratch[0].state,'purged');assert.equal(inventory.roots[0].complete,true);
 assert.equal(inventory.scratch[0].tombstones[0].contentSha256,hash('{"synthetic":true}'));
 await assertManagedSourceReadable(join(root,entry.relativePath),policy);
});

for(const variant of ['other-file','other-purpose','hardlink','symlink','nested','credential','public','executable','oversized'] as const)test('private model output retirement rejects '+variant,async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'model-scratch'),policy=fixturePolicy(stateDir),bytes='Synthetic source',entry={...rawEntry(bytes),relativePath:'sha256/'+hash(bytes).slice(0,2)+'/'+hash(bytes)};
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await publish(root,entry,bytes,stateDir);
 const binding={kind:'prepared_source' as const,url:entry.url,sourceSha256:hash(bytes),observationId:'synthetic-model',receiptSha256:entry.receiptSha256};
 const outside=join(base,'outside.json');await writeFile(outside,'unrelated protected bytes',{mode:0o600});
 let output='';
 await assert.rejects(withManagedSourceScratch(root,[binding],async scope=>{
  output=join(scope.directory,variant==='other-file'?'unknown.json':'answer.json');
  if(variant==='nested'||variant==='credential'){
   const folder=join(scope.directory,variant==='nested'?'nested':'credential-cwd');await mkdir(folder,{mode:0o700});output=join(folder,'answer.json');
  }
  if(variant==='symlink')await symlink(outside,output);
  else{
   if(variant==='hardlink')await link(outside,output);
   else await writeFile(output,variant==='oversized'?'x'.repeat(48*1024+1):'synthetic model output',{mode:0o600});
   await chmod(output,variant==='executable'?0o775:0o664);
  }
  if(variant==='public')await chmod(scope.directory,0o755);
 },{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:variant==='other-purpose'?'artifact':'openai',...policy}),CivicPolicyStateError);
 const recovery=await recoverManagedSourceScratch(policy);assert.equal(recovery.status,'partial');assert.ok(recovery.issues.some(issue=>issue.code==='unsafe_scratch'));
 assert.equal((await lstat(output)).isSymbolicLink(),variant==='symlink');
 assert.equal(await readFile(outside,'utf8'),'unrelated protected bytes');
});

test('an active scratch producer is stopped by objection and no purge claims completion while it can write',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'active-scratch'),policy=fixturePolicy(stateDir),bytes=Buffer.from('active source');
 let receiptStatus='',directory='';
 await assert.rejects(withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://council.test/source',sourceSha256:hash(bytes)}],async scope=>{
  directory=scope.directory;await scope.writeSource('source.pdf',bytes);
  const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy);receiptStatus=receipt.purge.status;assert.ok(receipt.purge.issues.some(issue=>issue.code==='active_scratch'));assert.equal(scope.signal.aborted,true);
 },{decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',...policy}),HostOptedOutError);
 assert.equal(receiptStatus,'partial');await assert.rejects(lstat(directory),{code:'ENOENT'});assert.equal((await purgeOptedOutHost('council.test',policy)).status,'purged');
});

test('gated scratch subprocesses are durably registered before command execution and cleanup removes generated output',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'gated-scratch'),policy=fixturePolicy(stateDir);let directory='';
 await withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://council.test/source',sourceSha256:hash('source')}],async scope=>{
  directory=scope.directory;
  const script=`const fs=require('node:fs');const state=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const lease=state.scratch.find(item=>item.groups.some(group=>group.pid===process.ppid));if(!lease)process.exit(17);fs.writeFileSync('answer.json','{\"source\":\"synthetic worker output\"}',{mode:0o600});`;
  const child=await scope.spawn(process.execPath,['-e',script,join(stateDir,'inventory.json')]);child.stdout.resume();child.stderr.resume();child.stdin.end();
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0);assert.equal((await lstat(join(scope.directory,'answer.json'))).isFile(),true);
 },{decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',...policy});
 await assert.rejects(lstat(directory),{code:'ENOENT'});
});

for(const layout of ['legacy','sealed'])test('interrupted worker scratch is recoverable without scanning unrelated temporary directories: '+layout,async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'orphan-scratch'),policy=fixturePolicy(stateDir),unrelated=join(base,'unrelated-tmp');await mkdir(unrelated,{mode:0o700});await writeFile(join(unrelated,'source.pdf'),'unrelated untouched',{mode:0o600});
 const moduleUrl=new URL('../src/civic-opt-out.ts',import.meta.url).href;
 const script=`import {withManagedSourceScratch,CIVIC_ACQUISITION_DECISION_ID} from ${JSON.stringify(moduleUrl)};import {createHash} from 'node:crypto';import {writeFile} from 'node:fs/promises';import {join} from 'node:path';const root=process.argv[1],policy=JSON.parse(process.argv[2]),bytes=Buffer.from('synthetic orphan source');await withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://council.test/source',sourceSha256:createHash('sha256').update(bytes).digest('hex')}],async scope=>{await scope.writeSource('source.pdf',bytes);await writeFile(join(scope.directory,'answer.json'),'partial synthetic output',{mode:0o600});process.exit(0);},{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification'});`;
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,root,JSON.stringify(policy)],{stdio:'ignore'});
 const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0);
 const before=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')),lease=before.scratch[0];assert.equal(lease.state,'active');assert.equal((await lstat(join(root,lease.directory,'source.pdf'))).isFile(),true);
 if(layout==='sealed'){
  const migration=await compactCivicPolicyInventory(policy);assert.deepEqual(migration.preservedWorkingLeases,[lease.id]);
  assert.deepEqual((await readCivicPolicyInventory(policy)).scratch[0],lease);
 }
 const receipt=await recoverManagedSourceScratch(policy);assert.equal(receipt.status,'complete');assert.equal(receipt.deletedFiles,2);assert.deepEqual(receipt.recoveredLeases,[lease.id]);await assert.rejects(lstat(join(root,lease.directory)),{code:'ENOENT'});assert.equal(await readFile(join(unrelated,'source.pdf'),'utf8'),'unrelated untouched');
});

test('merged lane enrollment refuses incomplete or rebound roots before planned lease mkdir',async t=>{
 const {base,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),root=join(base,'merged-lane'),binding={phase:'pre-admission' as const,url:'https://council.test/source',sourceSha256:hash('source')};
 const options={...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification' as const,kind:'artifacts' as const};
 await initializeManagedAcquisitionLane(root,options);
 await writeFile(join(root,'unbound.txt'),'unbound source bytes',{mode:0o600});
 let called=false;
 await assert.rejects(withManagedSourceScratch(root,[binding],async()=>{called=true;},options),error=>error instanceof CivicPolicyStateError&&error.code==='MANAGED_INVENTORY_INCOMPLETE');
 const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));
 assert.equal(inventory.roots[0].complete,false);assert.deepEqual(inventory.scratch,[]);assert.equal(called,false);
 await assert.rejects(lstat(join(root,'scratch')),{code:'ENOENT'});
 const marker=await readFile(join(root,'.civic-acquisition-lane.json'));await rename(root,join(base,'original'));
 await mkdir(root,{mode:0o700});await writeFile(join(root,'.civic-acquisition-lane.json'),marker,{mode:0o600});
 await assert.rejects(withManagedSourceScratch(root,[binding],async()=>{called=true;},options),CivicPolicyStateError);
 assert.equal(called,false);await assert.rejects(lstat(join(root,'scratch')),{code:'ENOENT'});
});

for(const boundary of ['before-mkdir','after-mkdir'] as const)test('merged planned commit survives worker death '+boundary,async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'planned-crash'),policy=fixturePolicy(stateDir);
 const moduleUrl=new URL('../src/civic-opt-out.ts',import.meta.url).href;
 const script=`import {promises as fs} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {withManagedSourceScratch,CIVIC_ACQUISITION_DECISION_ID} from ${JSON.stringify(moduleUrl)};const [root,policy,boundary]=process.argv.slice(1);const mkdir=fs.mkdir;fs.mkdir=async(...args)=>{const lease=String(args[0]).startsWith(join(root,'scratch')+'/');if(lease&&boundary==='before-mkdir')process.exit(0);const result=await mkdir(...args);if(lease)process.exit(0);return result;};syncBuiltinESMExports();await withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://council.test/source',sourceSha256:'1'.repeat(64)}],async()=>{process.exit(99);},{...JSON.parse(policy),decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification'});`;
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,root,JSON.stringify(policy),boundary],{stdio:'ignore'});
 assert.equal(await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}),0);
 const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')),lease=inventory.scratch[0];
 assert.equal(inventory.roots[0].complete,true);assert.equal(lease.state,'planned');assert.equal(lease.identity,null);assert.equal(lease.sources[0].host,'council.test');
 if(boundary==='after-mkdir')assert.deepEqual(await readdir(join(root,lease.directory)),[]);
 else await assert.rejects(lstat(join(root,lease.directory)),{code:'ENOENT'});
 // Operator fixture step: the child has exited and owns this interrupted lock.
 // Recovery deliberately never steals locks, including from dead workers.
 const lock=join(stateDir,'inventory.lock');assert.equal(JSON.parse(await readFile(lock,'utf8')).pid,child.pid);await rm(lock);
 const receipt=await recoverManagedSourceScratch(policy);assert.equal(receipt.status,'complete');assert.deepEqual(receipt.recoveredLeases,[lease.id]);
 await assert.rejects(lstat(join(root,lease.directory)),{code:'ENOENT'});
});

test('explicit source reads cannot alias another URL or a different mutable artifact version',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'bound-reads'),policy=fixturePolicy(stateDir);await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
 const original={...rawEntry('first','https://first.test/source',true),relativePath:'raw.txt'};await publish(root,original,'first',stateDir);
 await assertManagedSourceReadable(join(root,'raw.txt'),{...policy,sourceUrl:original.url});
 await assert.rejects(assertManagedSourceReadable(join(root,'raw.txt'),{...policy,sourceUrl:'https://never-observed.test/source'}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='CONTENT_PROVENANCE_MISSING');
 const first={...rawEntry('derived first','https://first.test/source'),relativePath:'result.json',sourceSha256:hash('first original')},second={...rawEntry('derived second','https://second.test/source'),relativePath:'result.json',sourceSha256:hash('second original')};
 await publish(root,first,'derived first',stateDir);await publish(root,second,'derived second',stateDir);
 await assert.rejects(assertManagedSourceReadable(join(root,'result.json'),{...policy,sourceUrl:first.url}),CivicPolicyStateError);await assertManagedSourceReadable(join(root,'result.json'),{...policy,sourceUrl:second.url});
});

test('restored opted-out bytes are not concealed by an earlier deletion tombstone',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),bytes='restored synthetic source',entry=rawEntry(bytes);await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await publish(root,entry,bytes,stateDir);
 assert.equal((await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy)).purge.deletedFiles,1);
 await writeFile(join(root,entry.relativePath),bytes,{mode:0o600});const again=await purgeOptedOutHost('council.test',policy);assert.equal(again.deletedFiles,1);assert.equal(again.status,'purged');await assert.rejects(lstat(join(root,entry.relativePath)),{code:'ENOENT'});
});

test('fixture scratch cannot execute native model commands and binding pins cannot be omitted',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'model-scratch'),policy=fixturePolicy(stateDir),binding={kind:'prepared_source' as const,url:'https://council.test/source',sourceSha256:hash('source'),observationId:'observation',receiptSha256:hash('receipt')};
 await assert.rejects(withManagedSourceScratch(root,[binding],scope=>scope.spawn('/home/max/.local/bin/codex',['--version']),{decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'openai',...policy}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='NATIVE_MODEL_REQUIRES_PRODUCTION_AUTHORITY');
 await assert.rejects(assertHostNotOptedOut(binding.url,{stateDir,authorityId:policy.authorityId}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_AUTHORITY_UNPINNED');
 const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));assert.equal(inventory.scratch[0].groups.length,0);assert.equal(inventory.scratch[0].state,'closed');
});

test('lost host registry is never recreated by managed operations or repeated provisioning',async t=>{
 const {base,root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir);
 await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy);
 const hosts=join(stateDir,'hosts'),saved=join(base,'saved-hosts'),authorityBytes=await readFile(join(stateDir,'authority.json'),'utf8');await rename(hosts,saved);
 let callback=false;
 for(const operation of [
  ()=>assertHostNotOptedOut('https://council.test/source',policy),
  ()=>registerManagedCacheRoot(root,{kind:'fetch',...policy}),
  ()=>initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy}),
  ()=>withManagedSourceWrite(root,[rawEntry('new')],async()=>{callback=true;},policy),
  ()=>assertManagedSourceReadable(join(root,'unknown.json'),policy),
  ()=>recordHostOptOut({host:'another.test',reason:'municipality_objection'},policy),
  ()=>provisionCivicPolicyAuthority({stateDir,authorityId:policy.authorityId}),
 ]){await assert.rejects(operation(),CivicPolicyStateError);await assert.rejects(lstat(hosts),{code:'ENOENT'});}
 assert.equal(callback,false);assert.equal(await readFile(join(stateDir,'authority.json'),'utf8'),authorityBytes);
 await mkdir(hosts,{mode:0o700});await assert.rejects(assertCivicPolicyAuthority(policy),CivicPolicyStateError);await assert.rejects(provisionCivicPolicyAuthority({stateDir,authorityId:policy.authorityId}),CivicPolicyStateError);await rm(hosts,{recursive:true});
 await rename(saved,hosts);await assert.rejects(assertHostNotOptedOut('https://council.test/source',policy),HostOptedOutError);
});

test('lost inventory cannot be replaced by a fresh root and restoring the original preserves purge coverage',async t=>{
 const {base,root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),bytes='must remain discoverable',entry=rawEntry(bytes);
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await publish(root,entry,bytes,stateDir);
 const path=join(stateDir,'inventory.json'),saved=join(base,'saved-inventory.json'),replacement=join(base,'replacement-root');await rename(path,saved);
 for(const operation of [
  ()=>registerManagedCacheRoot(replacement,{kind:'fetch',...policy}),
  ()=>initializeManagedAcquisitionLane(replacement,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy}),
  ()=>recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy),
  ()=>provisionCivicPolicyAuthority({stateDir,authorityId:policy.authorityId}),
 ]){await assert.rejects(operation(),CivicPolicyStateError);await assert.rejects(lstat(path),{code:'ENOENT'});}
 await assert.rejects(lstat(replacement),{code:'ENOENT'});assert.equal(await readFile(join(root,entry.relativePath),'utf8'),bytes);
 await writeFile(path,JSON.stringify({schemaVersion:1,inventoryId:randomUUID(),roots:[],entries:[],scratch:[]})+'\n',{mode:0o600});await assert.rejects(assertCivicPolicyAuthority(policy),CivicPolicyStateError);await rm(path);
 await rename(saved,path);const receipt=await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy);assert.equal(receipt.purge.deletedFiles,1);assert.equal(receipt.purge.status,'purged');await assert.rejects(lstat(join(root,entry.relativePath)),{code:'ENOENT'});
});

test('an interrupted bootstrap is repair-required, not a newly empty authoritative store',async t=>{
 const {stateDir}=await sandbox(t,false),policy=fixturePolicy(stateDir);await mkdir(join(stateDir,'hosts'),{recursive:true,mode:0o700});
 const marker=join(stateDir,'hosts',hash('council.test')+'.json');await writeFile(marker,JSON.stringify({schemaVersion:1,host:'council.test',receivedAt:now,purgeDueAt:'2026-10-18T12:00:00.000Z',reason:'municipality_objection'})+'\n',{mode:0o600});
 await assert.rejects(provisionCivicPolicyAuthority({stateDir,authorityId:policy.authorityId}),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_REPAIR_REQUIRED');
 await assert.rejects(lstat(join(stateDir,'authority.json')),{code:'ENOENT'});assert.equal(JSON.parse(await readFile(marker,'utf8')).host,'council.test');
});

test('injected remote policy bodies in observations and requests are purged, not exempted as metadata',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),url='https://stadt.de/document',raw='synthetic source representation',sha256=hash(raw),injected='SYNTHETIC_PRIVATE_FULL_TEXT '.repeat(10000);
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 for(const folder of ['sha256','observations','requests'])await mkdir(join(root,folder),{mode:0o700});
 await writeFile(join(root,'sha256',sha256),raw,{mode:0o600});
 const sourcePolicy:SourceAccessPolicy={robots:{state:'allowed',url:'https://stadt.de/robots.txt'},tdm:{state:'not_declared',evidence:[{url,locator:'HTML meta[name=tdm-policy]',value:injected}]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'};
 const observation={url,method:'GET',state:'fetched',sha256,checkedAt:now,retrievedAt:now,mimeType:'text/plain',bytes:raw.length,policy:sourcePolicy},observationPath=join(root,'observations','source.json'),requestPath=join(root,'requests',hash('request')+'.json');
 await writeFile(observationPath,JSON.stringify(observation),{mode:0o600});await writeFile(requestPath,JSON.stringify(observation),{mode:0o600});
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});const receipt=await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},policy);
 assert.equal(receipt.purge.status,'purged');assert.equal(receipt.purge.deletedFiles,3);for(const path of [observationPath,requestPath,join(root,'sha256',sha256)])await assert.rejects(lstat(path),{code:'ENOENT'});
 assert.equal((await readFile(join(stateDir,'inventory.json'),'utf8')).includes('SYNTHETIC_PRIVATE_FULL_TEXT'),false);
 for(const name of await readdir(join(stateDir,'attempts')))assert.equal((await readFile(join(stateDir,'attempts',name),'utf8')).includes('SYNTHETIC_PRIVATE_FULL_TEXT'),false);
});

test('projected content-free policy evidence survives, while unbound source-bearing metadata remains partial',async t=>{
 const {base,root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),url='https://stadt.de/document',sourcePolicy:SourceAccessPolicy={robots:{state:'allowed',url:'https://stadt.de/robots.txt'},tdm:{state:'not_declared',evidence:[{url,locator:'HTML meta[name=tdm-policy]',value:'private remote policy text '.repeat(1000)}]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'};
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await mkdir(join(root,'observations'),{mode:0o700});
 const safePath=join(root,'observations','safe.json');await writeFile(safePath,JSON.stringify({url,method:'GET',state:'failed',checkedAt:now,retrievedAt:null,policy:projectSourcePolicyMetadata(sourcePolicy)}),{mode:0o600});
 assert.equal((await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},policy)).purge.status,'purged');assert.equal((await lstat(safePath)).isFile(),true);assert.equal((await readFile(safePath,'utf8')).includes('private remote policy text'),false);
 const other=join(base,'unbound');await initializeManagedAcquisitionLane(other,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await mkdir(join(other,'observations'),{mode:0o700});const unsafePath=join(other,'observations','unknown.json');
 await writeFile(unsafePath,JSON.stringify({url:'https://unknown.test/resource',method:'GET',state:'failed',checkedAt:now,retrievedAt:null,policy:sourcePolicy}),{mode:0o600});await registerManagedCacheRoot(other,{kind:'fetch',...policy});
 const result=await recordHostOptOut({host:'unknown.test',reason:'rights_holder_objection'},policy);assert.equal(result.purge.status,'partial');assert.equal((await lstat(unsafePath)).isFile(),true);
});

for(const layout of ['legacy','sealed'])test('retained publications preserve their actual member proof and cannot be relabelled as prepared or HTTP data: '+layout,async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'publication'),policy=fixturePolicy(stateDir),bytes='synthetic retained published fact and short quote';
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 const binding:Extract<ManagedSourceBinding,{kind:'retained_publication'}>={kind:'retained_publication',url:'https://stadt.de/source',sourceSha256:null,publication:{manifestSha256:hash('manifest'),releaseId:'release-fixture',memberPath:'cities/example.json',memberSha256:hash(bytes),memberBytes:Buffer.byteLength(bytes)}};
 await publish(root,{...binding,relativePath:'retained.json',contentSha256:hash(bytes),independentAllowed:false},bytes,stateDir);
 if(layout==='sealed')await compactCivicPolicyInventory(policy);
 await assertManagedSourceBindings(join(root,'retained.json'),[binding],policy);
 await assert.rejects(assertManagedSourceBindings(join(root,'retained.json'),[{kind:'prepared_source',url:binding.url,sourceSha256:hash(bytes),observationId:'invented',receiptSha256:hash('invented')}],policy),CivicPolicyStateError);
 await assert.rejects(assertManagedSourceBindings(join(root,'retained.json'),[{...binding,publication:{...binding.publication,manifestSha256:hash('other')}}],policy),CivicPolicyStateError);
 await assert.rejects(assertManagedSourceBindings(join(root,'retained.json'),[],policy),CivicPolicyStateError);
 assert.equal((await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},policy)).purge.deletedFiles,1);
});

for(const layout of ['legacy','sealed'])test('Git baselines and approved registry configuration stay typed controls, never raw/prepared/model admission: '+layout,async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'typed-controls'),policy=fixturePolicy(stateDir),bytes='synthetic historical rows';
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 const snapshot={gitCommit:'a'.repeat(40),path:'stadtstack-data/out/cities/example.json',blobOid:'b'.repeat(40),sha256:hash(bytes),bytes:Buffer.byteLength(bytes)},historical:Extract<ManagedSourceBinding,{kind:'authenticated_git_snapshot'}>={kind:'authenticated_git_snapshot',purpose:'historical_change_reconstruction_only',url:'https://stadt.de/source',sourceSha256:null,snapshot};
 await publish(root,{...historical,relativePath:'baseline.json',contentSha256:hash(bytes),independentAllowed:false},bytes,stateDir);
 await assert.rejects(assertManagedSourceReadable(join(root,'baseline.json'),policy),CivicPolicyStateError);await assertManagedSourceBindings(join(root,'baseline.json'),[historical],{...policy,purpose:'historical_change_reconstruction_only'});
 await assert.rejects(withManagedSourceScratch(root,[historical],async()=>{}, {decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',purpose:'document',...policy}),CivicPolicyStateError);
 const configBytes='synthetic strictly validated operator configuration',configurationSha256=hash(configBytes),config:Extract<ManagedSourceBinding,{kind:'operator_registry_config'}>={kind:'operator_registry_config',url:'https://stadt.de/source',configurationSha256,schemaContractSha256:hash('closed-registry-codec'),code:{...snapshot,path:'stadtstack-data/sources/district-registry.json',sha256:configurationSha256,bytes:Buffer.byteLength(configBytes)},approval:{role:'district_source_registry',approver:'owner',decisionId:CIVIC_ACQUISITION_DECISION_ID,date:'2026-10-11',configurationSha256,gitCommit:snapshot.gitCommit}};
 await publish(root,{...config,relativePath:'registry.json',contentSha256:configurationSha256,independentAllowed:false},configBytes,stateDir);await assertManagedSourceBindings(join(root,'registry.json'),[config],policy);
 if(layout==='sealed')await compactCivicPolicyInventory(policy);
 await assertManagedSourceBindings(join(root,'baseline.json'),[historical],{...policy,purpose:'historical_change_reconstruction_only'});
 await assertManagedSourceBindings(join(root,'registry.json'),[config],policy);
 await assert.rejects(assertManagedSourceBindings(join(root,'registry.json'),[{...config,schemaContractSha256:hash('different')}],policy),CivicPolicyStateError);
 await assert.rejects(withManagedSourceScratch(root,[config],async()=>{}, {decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',purpose:'openai',...policy}),CivicPolicyStateError);
 assert.equal((await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},policy)).purge.deletedFiles,2);
});

for(const layout of ['legacy','sealed'])test('self-bound and inherited registry bytes admit complete same-configuration descriptor members: '+layout,async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'registry-members'),policy=fixturePolicy(stateDir);
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 const bytes='Synthetic bounded operator configuration',configurationSha256=hash(bytes),code={gitCommit:'a'.repeat(40),path:'stadtstack-data/sources/district-registry.json',blobOid:'b'.repeat(40),sha256:configurationSha256,bytes:Buffer.byteLength(bytes)};
 const first=['https://stadt.de/source','https://another.test/source'].map(url=>({kind:'operator_registry_config' as const,url,configurationSha256,schemaContractSha256:hash('first synthetic codec'),code,approval:{role:'district_source_registry' as const,approver:'owner' as const,decisionId:CIVIC_ACQUISITION_DECISION_ID,date:'2026-10-11' as const,configurationSha256,gitCommit:code.gitCommit},independentAllowed:false}));
 const second=first.map(binding=>({...binding,schemaContractSha256:hash('second synthetic codec')}));
 const path=join(root,'registry.json'),derived='Synthetic index inheriting operator configuration',derivedPath=join(root,'derived.json');
 for(const binding of [...first,...second]){
  await publish(root,{...binding,relativePath:'registry.json',contentSha256:configurationSha256},bytes,stateDir);
  await publish(root,{...binding,relativePath:'derived.json',contentSha256:hash(derived)},derived,stateDir);
 }
 if(layout==='sealed')await compactCivicPolicyInventory(policy);
 for(const bindings of [first,second]){
  await assertManagedSourceBindings(path,bindings,policy);
  await assertManagedSourceBindings(path,bindings,policy,'operator_registry_config');
  await assertManagedSourceBindings(derivedPath,bindings,policy);
  await assertManagedSourceBindings(derivedPath,bindings,policy,'operator_registry_config');
 }
 await assertManagedSourceBindings(derivedPath,[...first,...second],policy);
 for(const bindings of [
  [],
  first.slice(1),
  [first[0],second[1]],
  first.map(binding=>({...binding,schemaContractSha256:hash('foreign codec')})),
  first.map(binding=>({...binding,code:{...binding.code,blobOid:'c'.repeat(40)}})),
  first.map(binding=>({...binding,url:'https://foreign.test/source'})),
  first.map(binding=>({...binding,independentAllowed:true})),
 ])await assert.rejects(assertManagedSourceBindings(path,bindings,policy),{code:'CONTENT_PROVENANCE_MISMATCH'});
 // Deliberate fixture-only revocation preserves genuine entry identities and bytes.
 const inventoryPath=join(stateDir,'inventory.json'),original=await readFile(inventoryPath),inventory=JSON.parse(original.toString('utf8'));
 const logical=await readCivicPolicyInventory(policy),revoked=logical.entries.find(entry=>entry.relativePath==='registry.json'&&entry.schemaContractSha256===second[0].schemaContractSha256);
 assert.ok(revoked);
 if(layout==='sealed')inventory.storage.entryStates[revoked.id]='revoked';
 else inventory.entries.find((entry:{id:string})=>entry.id===revoked.id).state='revoked';
 try{
  await writeFile(inventoryPath,JSON.stringify(inventory)+'\n',{mode:0o600});
  for(const bindings of [first,second])await assert.rejects(assertManagedSourceBindings(path,bindings,{...policy,sourceUrl:bindings[0].url}),{code:'CONTENT_REFERENCE_REVOKED'});
 }finally{await writeFile(inventoryPath,original,{mode:0o600});}
 // A foreign provenance kind on these bytes cannot disappear behind membership.
 await publish(root,{...rawEntry(bytes,'https://foreign.test/source'),relativePath:'registry.json'},bytes,stateDir);
 await assert.rejects(assertManagedSourceBindings(path,first,policy),{code:'CONTENT_PROVENANCE_MISMATCH'});
});

for(const layout of ['legacy','sealed'])test('corpus CAS permits only complete same-byte registry extras and exact source ancestry: '+layout,async t=>{
 const {base,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),cas=new DistrictCas(join(base,'family-cas'));
 await initializeManagedAcquisitionLane(cas.root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 const configuration='Synthetic registry family configuration',configurationSha256=hash(configuration),code={gitCommit:'a'.repeat(40),path:'stadtstack-data/sources/district-registry.json',blobOid:'b'.repeat(40),sha256:configurationSha256,bytes:Buffer.byteLength(configuration)};
 const first=['https://family-one.test/source','https://family-two.test/source'].map(url=>({kind:'operator_registry_config' as const,url,configurationSha256,schemaContractSha256:hash('synthetic first family'),code,approval:{role:'district_source_registry' as const,approver:'owner' as const,decisionId:CIVIC_ACQUISITION_DECISION_ID,date:'2026-10-11' as const,configurationSha256,gitCommit:code.gitCommit},independentAllowed:false}));
 const second=first.map(binding=>({...binding,schemaContractSha256:hash('synthetic second family')}));
 const original=rawEntry('Synthetic original','https://original-family.test/document'),observation:ManagedSourceBinding={kind:'http_observation',url:original.url,sourceSha256:original.sourceSha256,observationId:original.observationId,receiptSha256:original.receiptSha256};
 const put=async(label:string,bindings:ManagedSourceBinding[])=>{
  const bytes=Buffer.from(JSON.stringify({schemaVersion:'stadtstack-crawl-index-v1',documents:[],notes:['Synthetic family-membership fixture',label]})+'\n'),contentSha256=hash(bytes),relativePath=`sha256/${contentSha256.slice(0,2)}/${contentSha256}`;
  const artifact=await withManagedSourceWrite(cas.root,bindings.map(binding=>({...binding,relativePath,contentSha256,independentAllowed:false})),()=>cas.put(bytes,{kind:'derived',mimeType:'application/json'}),policy);
  return join(cas.root,artifact.storageKey);
 };
 const corpusPath=await put('complete',[...first,...second,observation]);
 const partial=await put('partial-extra',[...first,second[0],observation]);
 const foreignSha256=hash('Synthetic foreign configuration'),foreign=second.map(binding=>({...binding,configurationSha256:foreignSha256,code:{...binding.code,sha256:foreignSha256},approval:{...binding.approval,configurationSha256:foreignSha256}}));
 const foreignPath=await put('foreign-configuration',[...first,...foreign,observation]);
 const extraObservation={...observation,url:'https://extra-family.test/original',observationId:hash('extra observation'),receiptSha256:hash('extra HTTP receipt')};
 const extraPath=await put('extra-observation',[...first,...second,observation,extraObservation]);
 const preparedPath=await put('extra-prepared-receipt',[...first,...second,observation,{...extraObservation,kind:'prepared_source'}]);
 if(layout==='sealed')await compactCivicPolicyInventory(policy);
 for(const family of [first,second]){
  await assertManagedSourceBindings(corpusPath,[...family,observation],policy);
  await assertManagedSourceBindings(corpusPath,family,policy,'operator_registry_config');
 }
 for(const [path,declared] of [
  [corpusPath,[first[0],second[1],observation]],
  [corpusPath,[...first]],
  [partial,[...first,observation]],
  [foreignPath,[...first,observation]],
  [extraPath,[...first,observation]],
  [preparedPath,[...first,observation]],
 ] as const)await assert.rejects(assertManagedSourceBindings(path,[...declared],policy),{code:'CONTENT_PROVENANCE_MISMATCH'});
 // Deliberate fixture-only state fault: an otherwise ignorable descriptor
 // contributor remains a live read gate in both physical inventory layouts.
 const inventoryPath=join(stateDir,'inventory.json'),physicalBytes=await readFile(inventoryPath),physical=JSON.parse(physicalBytes.toString('utf8')),logical=await readCivicPolicyInventory(policy),revoked=logical.entries.find(entry=>join(cas.root,entry.relativePath)===corpusPath&&entry.schemaContractSha256===second[0].schemaContractSha256)!;
 assert.ok(revoked);
 if(layout==='sealed')physical.storage.entryStates[revoked.id]='revoked';else physical.entries.find((entry:{id:string})=>entry.id===revoked.id).state='revoked';
 try{
  await writeFile(inventoryPath,JSON.stringify(physical)+'\n',{mode:0o600});
  await assert.rejects(assertManagedSourceBindings(corpusPath,[...first,observation],policy),{code:'CONTENT_REFERENCE_REVOKED'});
 }finally{await writeFile(inventoryPath,physicalBytes,{mode:0o600});}
 const objection=await recordHostOptOut({host:'family-two.test',reason:'municipality_objection'},policy);assert.equal(objection.host,'family-two.test');
 await assert.rejects(assertManagedSourceBindings(corpusPath,[...first,observation],policy),HostOptedOutError);
});


test('raw source admission verifies the real immutable HTTP observation, not another proof kind or receipt hash',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),bytes='synthetic acquired primary source',sourceSha256=hash(bytes),url='https://stadt.de/source';
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await mkdir(join(root,'observations'),{mode:0o700});
 const observationId='actual-observation.json',observation=JSON.stringify({url,method:'GET',state:'fetched',sha256:sourceSha256,checkedAt:now,retrievedAt:now,policy:projectSourcePolicyMetadata({robots:{state:'allowed',url:'https://stadt.de/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'})})+'\n';
 await writeFile(join(root,'observations',observationId),observation,{mode:0o600});const binding:Extract<ManagedSourceBinding,{kind:'http_observation'}>={kind:'http_observation',url,sourceSha256,observationId,receiptSha256:hash(observation)};
 await publish(root,{...binding,relativePath:'sha256/'+sourceSha256,contentSha256:sourceSha256,independentAllowed:true},bytes,stateDir);
 await assertManagedRawSourceBinding(join(root,'sha256',sourceSha256),binding,policy);await assert.rejects(assertManagedRawSourceBinding(join(root,'sha256',sourceSha256),{...binding,receiptSha256:hash('policy-not-http')},policy),CivicPolicyStateError);
 await writeFile(join(root,'observations',observationId),JSON.stringify({altered:true}),{mode:0o600});await assert.rejects(assertManagedRawSourceBinding(join(root,'sha256',sourceSha256),binding,policy),CivicPolicyStateError);
});

test('prepared v2 inventory preserves parser proof and refuses receipts missing its contract',async t=>{
 const {base,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir);
 for(const valid of [true,false]){
  const root=join(base,valid?'prepared-v2':'prepared-v2-unproven'),{receiptSha256:_oldReceipt,...legacy}=preparedFixture([valid?'parser.test':'unproven.test']);
  const body={...legacy,version:'district-prepared-v2',toolVersions:{...legacy.toolVersions,parser_isolation:'district-parser-isolation-v1',parser_image:'sha256:'+hash('reviewed-parser-image'),...(valid?{parser_contract:hash('parser-contract')}:{})}},receiptSha256=hash(canonical(body)),path=join(root,receiptSha256+'.json');
  await mkdir(root,{mode:0o700});await writeFile(path,JSON.stringify({...body,receiptSha256})+'\n',{mode:0o600});
  await registerManagedCacheRoot(root,{kind:'prepared',...policy});
  if(valid){
   await markManagedCacheInventoryComplete(root,policy);
   const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')),entry=inventory.entries.find((item:{receiptSha256?:string})=>item.receiptSha256===receiptSha256);
   assert.equal(entry.kind,'prepared_source');assert.equal(entry.sourceSha256,body.sourceSha256);
   const result=await recordHostOptOut({host:'parser.test',reason:'municipality_objection'},policy);assert.equal(result.purge.deletedFiles,1);await assert.rejects(lstat(path),{code:'ENOENT'});
  }else{
   await assert.rejects(markManagedCacheInventoryComplete(root,policy),CivicPolicyStateError);
   const result=await recordHostOptOut({host:'unproven.test',reason:'municipality_objection'},policy);assert.equal(result.purge.status,'partial');assert.equal(result.purge.deletedFiles,0);assert.ok(await lstat(path));
  }
 }
});

test('shared source binding codec is closed and preserves each genuine proof kind',()=>{
 const url='https://stadt.de/source',sourceSha256=hash('source'),snapshot={gitCommit:'a'.repeat(40),path:'stadtstack-data/sources/district-registry.json',blobOid:'b'.repeat(40),sha256:sourceSha256,bytes:6};
 const http={kind:'http_observation' as const,url,sourceSha256,observationId:'original-observation.json',receiptSha256:hash('original-observation')};
 const retained={kind:'retained_publication' as const,url,publication:{manifestSha256:hash('manifest'),releaseId:'release-1',memberPath:'facts.json',memberSha256:sourceSha256,memberBytes:6}};
 const config={kind:'operator_registry_config' as const,url,configurationSha256:sourceSha256,schemaContractSha256:hash('contract'),code:snapshot,approval:{role:'district_source_registry' as const,approver:'owner' as const,decisionId:CIVIC_ACQUISITION_DECISION_ID,date:'2026-10-11' as const,configurationSha256:sourceSha256,gitCommit:snapshot.gitCommit}};
 const historical={kind:'authenticated_git_snapshot' as const,purpose:'historical_change_reconstruction_only' as const,url,snapshot};
 for(const binding of [http,{...http,kind:'prepared_source' as const},retained,{...retained,sourceSha256:null},historical,config])assert.deepEqual(ManagedSourceBindingSchema.parse(binding),binding);
 for(const binding of [
  {...http,extra:'untrusted'}, {...http,url:'file:///source'}, {...http,url:'https://name:password@stadt.de/source'},
  {...retained,observationId:http.observationId}, {...retained,publication:{...retained.publication,extra:'untrusted'}},
  {...historical,purpose:undefined}, {...config,sourceSha256}, {...config,code:{...snapshot,path:'other.json'}},
  {...config,approval:{...config.approval,configurationSha256:hash('other')}}, {...config,approval:{...config.approval,gitCommit:'c'.repeat(40)}},
 ])assert.equal(ManagedSourceBindingSchema.safeParse(binding).success,false);
});

test('observation metadata reads reject arbitrary JSON, unsafe policy and opted-out redirect hosts',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir);
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});await mkdir(join(root,'observations'),{mode:0o700});
 const path=join(root,'observations','safe.json'),metadata={url:'https://stadt.de/source',method:'GET',state:'redirected',checkedAt:now,retrievedAt:null,location:'https://redirect.test/source',policy:projectSourcePolicyMetadata({robots:{state:'allowed',url:'https://stadt.de/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'})};
 await writeFile(path,JSON.stringify(metadata),{mode:0o600});await assertManagedObservationReadable(path,policy);
 await writeFile(path,JSON.stringify({...metadata,body:'SOURCE_BODY'}),{mode:0o600});await assert.rejects(assertManagedObservationReadable(path,policy),CivicPolicyStateError);
 await writeFile(path,JSON.stringify({...metadata,policy:{sourceBody:'SOURCE_BODY'}}),{mode:0o600});await assert.rejects(assertManagedObservationReadable(path,policy),CivicPolicyStateError);
 await writeFile(path,JSON.stringify(metadata),{mode:0o600});await recordHostOptOut({host:'redirect.test',reason:'municipality_objection'},policy);await assert.rejects(assertManagedObservationReadable(path,policy),HostOptedOutError);
 await assert.rejects(assertManagedObservationReadable(join(root,'inventory.json'),policy),CivicPolicyStateError);
});

test('enrolled observations retain exact byte bindings even when replacement is content-free',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),url='https://stadt.de/source';
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 const relativePath='observations/bound.json',metadata={url,method:'GET',state:'fetched',checkedAt:now,retrievedAt:now,sha256:hash('source')},bytes=JSON.stringify({...metadata,policy:{sourceBody:'SOURCE_BODY'}}),entry:ManagedSourceContent={kind:'http_observation',url,sourceSha256:metadata.sha256,observationId:'bound.json',receiptSha256:hash(bytes),relativePath,contentSha256:hash(bytes),independentAllowed:false};
 await publish(root,entry,bytes,stateDir);await assertManagedObservationReadable(join(root,relativePath),policy);
 await writeFile(join(root,relativePath),JSON.stringify(metadata),{mode:0o600});await assert.rejects(assertManagedObservationReadable(join(root,relativePath),policy),CivicPolicyStateError);
});

test('an orphaned immutable objection revision cannot authorize live acquisition',async t=>{
 const {base,root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),host='council.test';
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 await recordHostOptOut({host,reason:'municipality_objection',receivedAt:'2026-09-02T00:00:00.000Z'},policy);
 await recordHostOptOut({host,reason:'municipality_objection',receivedAt:'2026-09-01T00:00:00.000Z'},policy);
 const primary=join(stateDir,'hosts',hash(host)+'.json');await rename(primary,join(base,'saved-primary.json'));
 assert.ok((await readdir(join(stateDir,'hosts'))).some(name=>name.startsWith(hash(host)+'-')));
 await assertCivicPolicyAuthority(policy);
 await assert.rejects(assertHostNotOptedOut('https://'+host+'/new',policy),CivicPolicyStateError);
 await assert.rejects(readCivicOptOutSnapshot(policy),CivicPolicyStateError);
 let wrote=false;await assert.rejects(withManagedSourceWrite(root,[rawEntry('new source')],async()=>{wrote=true;},policy),CivicPolicyStateError);assert.equal(wrote,false);
 await rename(join(base,'saved-primary.json'),primary);await assert.rejects(assertHostNotOptedOut('https://'+host+'/new',policy),HostOptedOutError);
 await assertHostNotOptedOut('https://unrelated.test/source',policy);
});

test('prepared plan exemption requires exact recursively content-free metadata',async t=>{
 const {PILOT_BASE_CORPUS_SHA256}=await import('../src/district-corpus.ts'),prepared=preparedFixture(['stadt.de']),municipality={id:'synthetic',name:'Synthetic Municipality',ags:'12000001',districtId:'synthetic-district'};
 const reference={...prepared.references[0],locator:'document-sha256:'+prepared.sourceSha256,policy:projectSourcePolicyMetadata({access:'public',robots:{state:'allowed',url:'https://stadt.de/robots.txt'},tdm:{state:'not_declared',evidence:[]},legalClassification:'not_assessed',publication:'facts_with_attribution_only'})};
 const expected={receiptSha256:prepared.receiptSha256,municipalityId:prepared.municipalityId,sourceSha256:prepared.sourceSha256,extractorSha256:prepared.extractorSha256,references:[reference],toolVersions:prepared.toolVersions};
 const group={municipality,documentIds:['synthetic-document'],expected,referenceWarnings:[]},quarantine={documentId:'synthetic-document',municipalityId:municipality.id,sourceId:reference.id,sourceSha256:prepared.sourceSha256,chunk:null,reason:'Extraction failed; see source-bound quarantine identity'};
 const plan={schemaVersion:'stadtstack-preparation-plan-v1',generatedAt:now,corpusSha256:PILOT_BASE_CORPUS_SHA256,registrySha256:hash('registry'),extractorSha256:prepared.extractorSha256,maxDocumentsPerMunicipality:null,availableDocumentGroups:1,selectedDocumentGroups:1,selectedRepresentations:1,municipalities:[{...municipality,availableDocumentGroups:1,selectedDocumentGroups:1,selectedRepresentations:1}],groups:[group],quarantine:[quarantine]};
 const withReference=(value:unknown)=>({...plan,groups:[{...group,expected:{...expected,references:[value]}}]});
 const cases=[
  {safe:true,value:plan},
  {safe:false,value:withReference({...reference,policy:{...prepared.references[0].policy,tdm:{state:'not_declared',evidence:[{url:reference.url,locator:'HTML meta[name=tdm-policy]',value:'SOURCE_BODY_'.repeat(5000)}]}}})},
  {safe:false,value:withReference({...reference,policy:{...reference.policy,robots:{...reference.policy.robots,sourceBody:'SOURCE_BODY'}}})},
  {safe:false,value:{...plan,municipalities:[{...plan.municipalities[0],sourceBody:'SOURCE_BODY'}]}},
  {safe:false,value:{...plan,quarantine:[{...quarantine,candidate:{text:'SOURCE_BODY'}}]}},
  {safe:false,value:{...plan,quarantine:[{...quarantine,reason:'SOURCE_BODY'}]}},
  {safe:false,value:{...plan,groups:[{...group,referenceWarnings:[{documentId:'synthetic-document',sourceId:reference.id,reason:'SOURCE_BODY'}]}]}},
 ];
 for(const {safe,value} of cases){
  if(safe)assert.deepEqual(await parseContentFreePreparationPlan(value),value);else await assert.rejects(parseContentFreePreparationPlan(value));
  const {base,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),root=join(base,'prepared'),bytes=JSON.stringify(value)+'\n',path=join(root,'plans',hash(bytes)+'.json');
  await mkdir(join(root,'plans'),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600});await registerManagedCacheRoot(root,{kind:'prepared',...policy});
  if(safe)await markManagedCacheInventoryComplete(root,policy);else await assert.rejects(markManagedCacheInventoryComplete(root,policy),CivicPolicyStateError);
  const result=await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},policy);
  assert.equal(result.purge.status,safe?'purged':'partial');assert.equal(result.purge.deletedFiles,0);assert.equal(await readFile(path,'utf8'),bytes);
 }
});

test('inventory epoch reads reopen atomically detached inodes without forgiving missing or foreign state',async t=>{
 for(const disposition of ['replacement','repeated','missing','foreign'] as const){
  const {stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),path=join(stateDir,'inventory.json'),bytes=await readFile(path,'utf8'),originalOpen=fsPromises.open;let detachments=0;
  t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
   const handle=await originalOpen(...args);
   if(String(args[0])===path&&detachments<(disposition==='repeated'?12:1)){
    detachments++;
    if(disposition==='missing')await rm(path);
    else{
     const replacement=join(stateDir,'inventory-replacement.json'),value=JSON.parse(bytes);
     if(disposition==='foreign')value.inventoryId=randomUUID();
     await writeFile(replacement,JSON.stringify(value)+'\n',{mode:0o600});await rename(replacement,path);
    }
   }
   return handle;
  });syncBuiltinESMExports();
  try{
   if(disposition==='replacement'||disposition==='repeated')await assertCivicPolicyAuthority(policy);else await assert.rejects(assertCivicPolicyAuthority(policy),CivicPolicyStateError);
   assert.equal(detachments,disposition==='repeated'?12:1);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 }
});

test('managed root initialization waits for external lock release without stealing or changing it',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),lock=join(stateDir,'inventory.lock'),contents=JSON.stringify({pid:process.pid,nonce:randomUUID()})+'\n';
 await writeFile(lock,contents,{mode:0o600});const identity=await lstat(lock);
 const contended=Promise.withResolvers<void>(),released=Promise.withResolvers<void>(),originalOpen=fsPromises.open;let observed=false;
 t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
  try{return await originalOpen(...args);}
  catch(error){
   if(String(args[0])===lock&&!observed&&(error as NodeJS.ErrnoException).code==='EEXIST'){observed=true;contended.resolve();await released.promise;}
   throw error;
  }
 });syncBuiltinESMExports();
 try{
  const pending=initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
  await contended.promise;assert.equal(await readFile(lock,'utf8'),contents);assert.equal((await lstat(lock)).ino,identity.ino);
  await rm(lock);released.resolve();await pending;await markManagedCacheInventoryComplete(root,policy);await assert.rejects(lstat(lock),{code:'ENOENT'});
 }finally{released.resolve();t.mock.restoreAll();syncBuiltinESMExports();}
});

test('independent processes wait beyond the former five-second limit and hand off without stealing', {timeout:30_000},async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),entry=rawEntry('concurrent lock fixture');
 await initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID});
 await publish(root,entry,'concurrent lock fixture',stateDir);
 const moduleUrl=new URL('../src/civic-opt-out.ts',import.meta.url).href,children:ChildProcess[]=[];
 const start=(body:string)=>{
  const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import {initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID} from ${JSON.stringify(moduleUrl)};const [root,policy,entry]=process.argv.slice(1);const options={...JSON.parse(policy),decisionId:CIVIC_ACQUISITION_DECISION_ID};${body}`,root,JSON.stringify(policy),JSON.stringify(entry)],{stdio:['pipe','pipe','pipe']});
  children.push(child);let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});
  const completion=Promise.withResolvers<void>();
  child.once('error',completion.reject);child.once('close',code=>code===0?completion.resolve():completion.reject(Error('fixture child exit '+code+': '+stderr)));
  const completed=completion.promise;void completed.catch(()=>{});
  return {child,completed};
 };
 t.after(async()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');await Promise.all(children.map(child=>{if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();const closed=Promise.withResolvers<void>();child.once('close',()=>closed.resolve());return closed.promise;}));});
 const holder=start(`await withManagedSourceWrite(root,[JSON.parse(entry)],async()=>{process.stdout.write('locked\\n');const release=Promise.withResolvers();process.stdin.once('data',release.resolve);await release.promise;},options);`);
 const held=Promise.withResolvers<void>();holder.child.stdout!.once('data',()=>held.resolve());await held.promise;
 const lock=join(stateDir,'inventory.lock'),identity=await lstat(lock),contents=await readFile(lock);
 const queued=Promise.withResolvers<void>(),watcher=watch(stateDir,()=>{void readdir(stateDir).then(names=>{if(names.filter(name=>name.startsWith('inventory.wait-')).length===2)queued.resolve();},queued.reject);});t.after(()=>watcher.close());
 const waiters=[start(`await initializeManagedAcquisitionLane(root,options);`),start(`await initializeManagedAcquisitionLane(root,options);`)];
 let finished=0;for(const waiter of waiters)void waiter.completed.then(()=>{finished++;},()=>{});
 await queued.promise;
 // Independent processes exercise real O_EXCL timing beyond the former 5 s
 // platform deadline; fake timers cannot advance the other process clocks.
 const elapsed=Promise.withResolvers<void>();setTimeout(elapsed.resolve,5_300);await elapsed.promise;
 assert.equal(finished,0);assert.equal((await lstat(lock)).ino,identity.ino);assert.deepEqual(await readFile(lock),contents);
 holder.child.stdin!.end('release');await holder.completed;await Promise.all(waiters.map(waiter=>waiter.completed));
 assert.equal(finished,2);assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.wait-')),false);
 await assert.rejects(lstat(lock),{code:'ENOENT'});
});

test('configured lock timeout is bounded, cleans waiters, preserves holder and rejects invalid configuration',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),lock=join(stateDir,'inventory.lock');
 await writeFile(lock,'external holder',{mode:0o600});const identity=await lstat(lock),start=performance.now();
 await assert.rejects(initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,lockWaitMs:80}),{code:'CIVIC_POLICY_BUSY'});
 assert.ok(performance.now()-start>=80);assert.equal((await lstat(lock)).ino,identity.ino);assert.equal(await readFile(lock,'utf8'),'external holder');
 assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.wait-')),false);
 for(const lockWaitMs of [0,-1,NaN,Infinity,1.5,600_001])await assert.rejects(readCivicPolicyInventory({...policy,lockWaitMs}),{code:'INVALID_LOCK_WAIT'});
 const previous=process.env.CIVIC_POLICY_LOCK_WAIT_MS;
 t.after(()=>{if(previous===undefined)delete process.env.CIVIC_POLICY_LOCK_WAIT_MS;else process.env.CIVIC_POLICY_LOCK_WAIT_MS=previous;});
 process.env.CIVIC_POLICY_LOCK_WAIT_MS='25';
 await assert.rejects(readCivicPolicyInventory(policy),{code:'CIVIC_POLICY_BUSY'});
 process.env.CIVIC_POLICY_LOCK_WAIT_MS='not-a-duration';
 await assert.rejects(readCivicPolicyInventory(policy),{code:'INVALID_LOCK_WAIT'});
});

test('aborted scratch lock wait removes its waiter without later creating a lane or lease',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),lock=join(stateDir,'inventory.lock'),controller=new AbortController(),reason=Error('synthetic cancellation');
 const initial=await readFile(join(stateDir,'inventory.json'));
 await writeFile(lock,'external holder',{mode:0o600});const identity=await lstat(lock),queued=Promise.withResolvers<void>();
 const watcher=watch(stateDir,()=>{void readdir(stateDir).then(names=>{if(names.some(name=>name.startsWith('inventory.wait-')))queued.resolve();},queued.reject);});t.after(()=>watcher.close());
 let called=false;
 const attempt=withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://council.test/source',sourceSha256:hash('source')}],async()=>{called=true;},{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',signal:controller.signal});
 const rejected=assert.rejects(attempt,error=>error===reason);
 await queued.promise;controller.abort(reason);await rejected;
 assert.equal(called,false);assert.equal((await lstat(lock)).ino,identity.ino);assert.equal(await readFile(lock,'utf8'),'external holder');
 assert.deepEqual(await readFile(join(stateDir,'inventory.json')),initial);
 assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.wait-')),false);await assert.rejects(lstat(root),{code:'ENOENT'});
 await rm(lock);
 await assert.rejects(withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://council.test/source',sourceSha256:hash('source')}],async()=>{called=true;},{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',signal:controller.signal}),error=>error===reason);
 await initializeManagedAcquisitionLane(root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID});
 assert.deepEqual((await readCivicPolicyInventory(policy)).scratch,[]);assert.equal(called,false);
});

async function shardedCasFixture(t:TestContext){
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),bytes='Synthetic sharded immutable CAS',contentSha256=hash(bytes);
 const entry={...rawEntry(bytes),relativePath:`sha256/${contentSha256.slice(0,2)}/${contentSha256}`};
 await initializeManagedAcquisitionLane(root,{...policy,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID});
 await publish(root,entry,bytes,stateDir);
 // Age only the isolated authority's wall clock; real inode metadata remains
 // unchanged. This deterministically places the watermark beyond the racy window.
 t.mock.timers.enable({apis:['Date'],now:Date.now()+60_000});
 await initializeManagedAcquisitionLane(root,{...policy,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID});
 return {root,stateDir,policy,bytes,entry,path:join(root,entry.relativePath)};
}

test('CAS reconciliation reuses persisted exact-inode watermarks, never source-read authorization',async t=>{
 const {root,stateDir,policy,path,bytes}=await shardedCasFixture(t),clock=Date.now(),originalOpen=fsPromises.open;let reads=0;
 t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
  const handle=await originalOpen(...args);
  if(String(args[0])===path){const originalRead=handle.read;t.mock.method(handle,'read',async(...args:Parameters<typeof handle.read>)=>{reads++;return originalRead.apply(handle,args);});}
  return handle;
 });syncBuiltinESMExports();
 try{
  await initializeManagedAcquisitionLane(root,{...policy,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID});assert.equal(reads,0);
  await assertManagedSourceReadable(path,policy);assert.ok(reads>0);
  reads=0;await writeFile(path,bytes);
  await initializeManagedAcquisitionLane(root,{...policy,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID});assert.ok(reads>0);
  reads=0;await initializeManagedAcquisitionLane(root,{...policy,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID});assert.equal(reads,0);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 const script=`import {promises as fs} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {initializeManagedAcquisitionLane,CIVIC_ACQUISITION_DECISION_ID} from ${JSON.stringify(new URL('../src/civic-opt-out.ts',import.meta.url).href)};const [root,policy,path,clock]=process.argv.slice(1),open=fs.open;Date.now=()=>Number(clock);let reads=0;fs.open=async(...args)=>{const h=await open(...args);if(String(args[0])===path){const read=h.read.bind(h);h.read=(...args)=>{reads++;return read(...args);};}return h;};syncBuiltinESMExports();await initializeManagedAcquisitionLane(root,{...JSON.parse(policy),kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID});process.exitCode=reads?9:0;`;
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,root,JSON.stringify(policy),path,String(clock)],{stdio:'ignore'});
 const closed=Promise.withResolvers<number|null>();child.once('error',closed.reject);child.once('close',closed.resolve);assert.equal(await closed.promise,0);
 assert.ok(Object.keys(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).roots[0].casWatermarks).length);
 await rm(path);await initializeManagedAcquisitionLane(root,{...policy,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID});
 assert.equal(Object.hasOwn(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).roots[0],'casWatermarks'),false);
});

for(const mutation of ['unregistered','symlink','directory-symlink','tamper-restored-mtime','replacement','hardlink','mode','open-replacement'] as const)test('warm CAS reconciliation fails closed: '+mutation,async t=>{
 const {root,stateDir,policy,path,bytes}=await shardedCasFixture(t),before=await lstat(path),originalOpen=fsPromises.open;let intercepted=false;
 if(mutation==='unregistered')await writeFile(join(dirname(path),'f'.repeat(64)),'foreign bytes',{mode:0o600});
 if(mutation==='symlink'){await rm(path);await symlink(join(stateDir,'inventory.json'),path);}
 if(mutation==='directory-symlink'){await rename(dirname(path),dirname(path)+'-old');await symlink(dirname(path)+'-old',dirname(path));}
 if(mutation==='tamper-restored-mtime'){await writeFile(path,'X'.repeat(Buffer.byteLength(bytes)));await utimes(path,before.atime,before.mtime);}
 if(mutation==='replacement'){const other=path+'-replacement';await writeFile(other,'X'.repeat(Buffer.byteLength(bytes)),{mode:0o600});await utimes(other,before.atime,before.mtime);await rename(other,path);}
 if(mutation==='hardlink')await link(path,join(stateDir,'hardlink'));
 if(mutation==='mode')await chmod(path,0o666);
 if(mutation==='open-replacement'){
  t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
   const handle=await originalOpen(...args);
   if(String(args[0])===path&&!intercepted){intercepted=true;await rename(path,path+'-old');await writeFile(path,bytes,{mode:0o600});}
   return handle;
  });syncBuiltinESMExports();
 }
 try{await assert.rejects(initializeManagedAcquisitionLane(root,{...policy,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID}),{code:'MANAGED_INVENTORY_INCOMPLETE'});}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
 assert.equal(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).roots[0].complete,false);
 if(mutation==='open-replacement')assert.equal(intercepted,true);
});

for(const mode of ['racy','coarse','unknown-filesystem','tmpfs','clock-rollback'] as const)test('CAS equality never hides same-metadata tampering: '+mode,async t=>{
 const {root,policy,path,bytes}=await shardedCasFixture(t),metadata=await lstat(path,{bigint:true}),originalOpen=fsPromises.open,originalLstat=fsPromises.lstat,originalStatfs=fsPromises.statfs;
 let reads=0;
 const mtimeNs=mode==='coarse'?metadata.mtimeNs/1_000_000_000n*1_000_000_000n:metadata.mtimeNs,ctimeNs=mode==='coarse'?metadata.ctimeNs/1_000_000_000n*1_000_000_000n:metadata.ctimeNs;
 const mask=<T extends Stats|BigIntStats>(stat:T):T=>Object.assign(stat,typeof stat.mtimeMs==='bigint'?{mtimeNs,ctimeNs,mtimeMs:mtimeNs/1_000_000n,ctimeMs:ctimeNs/1_000_000n}:{mtimeMs:Number(mtimeNs)/1e6,ctimeMs:Number(ctimeNs)/1e6});
 if(mode==='racy')t.mock.timers.setTime(Number(ctimeNs/1_000_000n)+1_000);
 t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
  const handle=await originalOpen(...args);
  if(String(args[0])===path){
   const stat=handle.stat,read=handle.read;
   t.mock.method(handle,'stat',async(...args:Parameters<typeof handle.stat>)=>mask(await stat.apply(handle,args)));
   t.mock.method(handle,'read',async(...args:Parameters<typeof handle.read>)=>{reads++;return read.apply(handle,args);});
  }
  return handle;
 });
 t.mock.method(fsPromises,'lstat',async(...args:Parameters<typeof fsPromises.lstat>)=>{const stat=await originalLstat(...args);return String(args[0])===path?mask(stat):stat;});
 if(mode==='unknown-filesystem'||mode==='tmpfs')t.mock.method(fsPromises,'statfs',async(...args:Parameters<typeof fsPromises.statfs>)=>Object.assign(await originalStatfs(...args),{type:mode==='tmpfs'?0x01021994:0}));
 syncBuiltinESMExports();
 try{
  await initializeManagedAcquisitionLane(root,{...policy,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID});
  if(mode==='clock-rollback')t.mock.timers.setTime(Date.now()-100);
  reads=0;await writeFile(path,'X'.repeat(Buffer.byteLength(bytes)));
  await assert.rejects(initializeManagedAcquisitionLane(root,{...policy,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID}),{code:'MANAGED_INVENTORY_INCOMPLETE'});
  assert.ok(reads>0,'unsafe timestamp equality must rehash');
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('purge immediately removes a deleted CAS member watermark from committed inventory',async t=>{
 const {root,stateDir,policy,path}=await shardedCasFixture(t);
 assert.ok(Object.keys((await readCivicPolicyInventory(policy)).roots[0].casWatermarks??{}).length);
 const result=await recordHostOptOut({host:'council.test',reason:'rights_holder_objection'},policy);
 assert.equal(result.purge.status,'purged');await assert.rejects(lstat(path),{code:'ENOENT'});
 const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));
 assert.equal(inventory.roots.find((item:{path:string})=>item.path===root).casWatermarks,undefined);
});

test('purged derived ancestor hosts deny omitted contributor reads before missing body access',async t=>{
 const {base,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),root=join(base,'derived'),relativePath='result.json',bytes='{"facts":[]}',first=rawEntry('first','https://first.test/source'),extra=rawEntry('extra','https://extra.test/source');
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 await withManagedSourceWrite(root,[first,extra].map(binding=>({...binding,relativePath,contentSha256:hash(bytes),independentAllowed:false})),async()=>{await writeFile(join(root,relativePath),bytes,{mode:0o600});},policy);
 await recordHostOptOut({host:'extra.test',reason:'municipality_objection'},policy);await assert.rejects(lstat(join(root,relativePath)),{code:'ENOENT'});
 await assert.rejects(assertManagedSourceBindings(join(root,relativePath),[first],policy),HostOptedOutError);
});

test('council collection paths are source-bound outputs, never exempt metadata',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),binding=rawEntry('council source','https://stadt.de/source');
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 for(const name of ['synthetic-city-collection.json','synthetic-city-signals.geojson']){
  const bytes=JSON.stringify({source:'synthetic council content',name});await publish(root,{...binding,relativePath:'collections/'+name,contentSha256:hash(bytes)},bytes,stateDir);
 }
 await markManagedCacheInventoryComplete(root,policy);
 await assert.rejects(withManagedSourceWrite(root,[{...binding,relativePath:'collections/synthetic-city-other.json',contentSha256:hash('{}')}],async()=>{},policy),CivicPolicyStateError);
 const result=await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},policy);assert.equal(result.purge.status,'purged');assert.equal(result.purge.deletedFiles,2);
 await writeFile(join(root,'collections','unbound-city-collection.json'),'{"source":"unbound source"}',{mode:0o600});
 await assert.rejects(markManagedCacheInventoryComplete(root,policy),CivicPolicyStateError);
});

test('inventory beyond 100,000 entries loads and saves unchanged v1 format; 480 MiB still fails closed',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),entry=rawEntry('large inventory');
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 await publish(root,entry,'large inventory',stateDir);
 const path=join(stateDir,'inventory.json'),inventory=JSON.parse(await readFile(path,'utf8')),original=inventory.entries[0];
 // Unique source identities sharing one CAS object exercise same-path indexing
 // without making thousands of filesystem/source-content fixtures.
 inventory.entries=Array.from({length:100_001},(_,i)=>{
  const value={...original,urlSha256:hash('large-inventory-url-'+i)};
  value.id=hash(JSON.stringify([value.rootId,value.relativePath,value.contentSha256,value.kind,value.sourceSha256,value.host,value.urlSha256,value.observationId??null,value.receiptSha256??null,null,null,null,null,null,null,null,value.independentAllowed]));
  return value;
 });
 const serialized=JSON.stringify(inventory)+'\n';assert.ok(Buffer.byteLength(serialized)>16*1024*1024);assert.ok(Buffer.byteLength(serialized)<480*1024*1024);
 await writeFile(path,serialized,{mode:0o600});
 await recordManagedSourceContent(root,entry,policy);
 const saved=JSON.parse(await readFile(path,'utf8'));
 assert.deepEqual(Object.keys(saved),['schemaVersion','inventoryId','roots','entries','scratch']);
 assert.equal(saved.schemaVersion,1);assert.deepEqual(saved.entries.slice(0,100_001),inventory.entries);assert.equal(saved.entries.length,100_002);
 await assertManagedSourceReadable(join(root,entry.relativePath),policy);
 const handle=await fsPromises.open(path,'r+');try{await handle.truncate(480*1024*1024+1);}finally{await handle.close();}
 let called=false;
 await assert.rejects(withManagedSourceWrite(root,[entry],async()=>{called=true;},policy),CivicPolicyStateError);
 assert.equal(called,false);assert.equal((await lstat(path)).size,480*1024*1024+1);
});

test('bulk host gates canonicalize every URL and do not cache between live boundaries',async t=>{
 const {stateDir}=await sandbox(t),policy=fixturePolicy(stateDir);
 const urls=['https://COUNCIL.TEST./first','http://council.test/second','https://other.test/third'];
 await assertSourceHostsNotOptedOut(urls,policy);
 await assert.rejects(assertSourceHostsNotOptedOut([...urls,'https://user:password@council.test/invalid'],policy),CivicPolicyStateError);
 await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy);
 await assert.rejects(assertSourceHostsNotOptedOut(urls,policy),HostOptedOutError);
});

test('batched shared paths still validate every content hash and revoked reference',async t=>{
 const {base,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),root=join(base,'shared-artifacts'),bytes='{"facts":[]}',first={...rawEntry('first'),relativePath:'shared.json',contentSha256:hash(bytes)},second={...rawEntry('second','https://other.test/source'),relativePath:'shared.json',contentSha256:hash(bytes)};
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 await withManagedSourceWrite(root,[first,second],async()=>{await writeFile(join(root,'shared.json'),bytes,{mode:0o600});},policy);
 await assert.rejects(withManagedSourceWrite(root,[first,{...second,contentSha256:hash('different')}],async()=>{},policy),CivicPolicyStateError);
 await recordHostOptOut({host:'council.test',reason:'municipality_objection'},policy);
 await assert.rejects(withManagedSourceWrite(root,[second],async()=>{},policy),CivicPolicyStateError);
});

async function closedRetirementLease(root:string,stateDir:string){
 await withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://scratch.test/source',sourceSha256:hash('scratch source')}],async()=>{},{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'fetch',purpose:'classification',...fixturePolicy(stateDir)});
}

test('retirement removes populated root and closed leases while preserving another root, then purge and recovery still work',async t=>{
 const {base,root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),other=join(base,'other'),bytes='shared bytes in distinct root-local CAS files',entry=rawEntry(bytes),otherEntry=rawEntry(bytes,'https://other.test/source',true);
 for(const lane of [root,other])await registerManagedCacheRoot(lane,{kind:'fetch',...policy});
 await publish(root,entry,bytes,stateDir);await publish(root,rawEntry(bytes,'https://second.test/source'),bytes,stateDir);await publish(other,otherEntry,bytes,stateDir);
 await closedRetirementLease(root,stateDir);await closedRetirementLease(other,stateDir);
 const before=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')),rootId=hash(root),marker=await readFile(join(root,'.civic-acquisition-lane.json')),otherFile=await lstat(join(other,otherEntry.relativePath));
 const receipt=await retireManagedRoot(root,{reason:'obsolete publication'},policy);
 assert.equal(receipt.schemaVersion,'civic-root-retirement-v1');assert.equal(receipt.authorityId,policy.authorityId);assert.equal(receipt.authoritySha256,policy.authoritySha256);assert.equal(receipt.rootId,rootId);assert.equal(receipt.rootPath,root);assert.equal(receipt.reason,'obsolete publication');
 assert.equal(receipt.status,'retired');assert.equal(receipt.deletedFiles,2);assert.equal(receipt.deletedBytes,Buffer.byteLength(bytes)+marker.length);assert.equal(receipt.missingFiles,0);assert.equal(receipt.removedEntries,2);assert.equal(receipt.removedScratchLeases,1);assert.deepEqual(receipt.issues,[]);
 await assert.rejects(lstat(root),{code:'ENOENT'});
 const after=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));
 assert.equal(after.schemaVersion,1);assert.equal(after.inventoryId,before.inventoryId);
 assert.equal(JSON.stringify(after.roots),JSON.stringify(before.roots.filter((item:{id:string})=>item.id!==rootId)));
 assert.equal(JSON.stringify(after.entries),JSON.stringify(before.entries.filter((item:{rootId:string})=>item.rootId!==rootId)));
 assert.equal(JSON.stringify(after.scratch),JSON.stringify(before.scratch.filter((item:{rootId:string})=>item.rootId!==rootId)));
 assert.equal(await readFile(join(other,otherEntry.relativePath),'utf8'),bytes);assert.equal((await lstat(join(other,otherEntry.relativePath))).ino,otherFile.ino);
 const attempts=await readdir(join(stateDir,'attempts'));assert.equal(attempts.length,1);assert.deepEqual(JSON.parse(await readFile(join(stateDir,'attempts',attempts[0]),'utf8')),receipt);
 assert.deepEqual(RetireReceiptSchema.parse(receipt),receipt);assert.throws(()=>RetireReceiptSchema.parse({...receipt,extra:true}));
 assert.equal((await recordHostOptOut({host:'other.test',reason:'municipality_objection'},policy)).purge.status,'purged');
 assert.equal((await purgeOptedOutHost('other.test',policy)).status,'purged');assert.equal((await recoverManagedSourceScratch(policy)).status,'complete');
});

for(const state of ['planned','active','closing','partial'] as const)test('retirement refuses '+state+' scratch lease without changes',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),entry=rawEntry('managed source');
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,entry,'managed source',stateDir);await closedRetirementLease(root,stateDir);
 const inventoryPath=join(stateDir,'inventory.json'),inventory=JSON.parse(await readFile(inventoryPath,'utf8'));inventory.scratch[0].state=state;await writeFile(inventoryPath,JSON.stringify(inventory)+'\n',{mode:0o600});
 const before=await readFile(inventoryPath);
 await assert.rejects(retireManagedRoot(root,{reason:'must refuse'},policy),CivicPolicyStateError);
 assert.deepEqual(await readFile(inventoryPath),before);assert.equal(await readFile(join(root,entry.relativePath),'utf8'),'managed source');assert.deepEqual(await readdir(join(stateDir,'attempts')),[]);
});

for(const fault of ['unknown','modified','symlink','hardlink','mode','directory-mode'] as const)test('retirement preflight refuses '+fault+' content without changes',async t=>{
 const {base,root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),entry=rawEntry('original bytes');
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,entry,'original bytes',stateDir);
 const path=join(root,entry.relativePath);
 if(fault==='unknown')await writeFile(join(root,'extra.txt'),'unknown',{mode:0o600});
 if(fault==='modified')await writeFile(path,'modified bytes',{mode:0o600});
 if(fault==='symlink'){await rm(path);await symlink(join(base,'outside'),path);}
 if(fault==='hardlink')await link(path,join(base,'outside'));
 if(fault==='mode')await chmod(path,0o666);
 if(fault==='directory-mode')await chmod(join(root,'sha256'),0o777);
 const before=await readFile(join(stateDir,'inventory.json')),names=await readdir(root),identity=await lstat(path);
 await assert.rejects(retireManagedRoot(root,{reason:'must refuse'},policy),CivicPolicyStateError);
 assert.deepEqual(await readFile(join(stateDir,'inventory.json')),before);assert.deepEqual(await readdir(root),names);assert.equal((await lstat(path)).ino,identity.ino);assert.deepEqual(await readdir(join(stateDir,'attempts')),[]);
});

test('retirement refuses non-enrolled, ancestor, state, home and symlink-alias paths without changes',async t=>{
 const {base,root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),entry=rawEntry('safe bytes');
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,entry,'safe bytes',stateDir);await symlink(root,join(base,'alias'));
 const before=await readFile(join(stateDir,'inventory.json'));
 for(const path of [join(base,'not-enrolled'),base,stateDir,homedir(),join(base,'.git'),join(base,'.ssh'),join(base,'.secrets'),join(base,'alias'),'relative-root',root+'/../fetch'])await assert.rejects(retireManagedRoot(path,{reason:'must refuse'},policy),CivicPolicyStateError);
 assert.deepEqual(await readFile(join(stateDir,'inventory.json')),before);assert.equal(await readFile(join(root,entry.relativePath),'utf8'),'safe bytes');assert.deepEqual(await readdir(join(stateDir,'attempts')),[]);
});

test('retirement resumes missing managed files and missing lane marker without keeping tombstone entries',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),first=rawEntry('first'),second=rawEntry('second');
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,first,'first',stateDir);await publish(root,second,'second',stateDir);await closedRetirementLease(root,stateDir);
 await rm(join(root,first.relativePath));await rm(join(root,'.civic-acquisition-lane.json'));
 const receipt=await retireManagedRoot(root,{reason:'resume interrupted retirement'},policy);
 assert.equal(receipt.status,'retired');assert.equal(receipt.missingFiles,1);assert.equal(receipt.deletedFiles,1);assert.equal(receipt.deletedBytes,6);assert.equal(receipt.removedEntries,2);assert.equal(receipt.removedScratchLeases,1);
 await assert.rejects(lstat(root),{code:'ENOENT'});const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));assert.deepEqual(inventory.roots,[]);assert.deepEqual(inventory.entries,[]);assert.deepEqual(inventory.scratch,[]);
});

test('retirement resumes after root directory was removed before inventory commit',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),entry=rawEntry('already deleted');
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,entry,'already deleted',stateDir);await closedRetirementLease(root,stateDir);await rm(root,{recursive:true});
 const receipt=await retireManagedRoot(root,{reason:'resume final filesystem step'},policy);
 assert.equal(receipt.status,'retired');assert.equal(receipt.missingFiles,1);assert.equal(receipt.deletedFiles,0);assert.equal(receipt.removedEntries,1);assert.equal(receipt.removedScratchLeases,1);
 const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));assert.deepEqual(inventory.roots,[]);assert.deepEqual(inventory.entries,[]);assert.deepEqual(inventory.scratch,[]);
});

test('retirement records a partial unlink failure without changing inventory and retry completes',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),entry=rawEntry('managed body');
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,entry,'managed body',stateDir);
 const before=await readFile(join(stateDir,'inventory.json')),originalUnlink=fsPromises.unlink;
 t.mock.method(fsPromises,'unlink',async(path:Parameters<typeof fsPromises.unlink>[0])=>{if(String(path)===join(root,'.civic-acquisition-lane.json'))throw Object.assign(new Error('synthetic interruption'),{code:'EIO'});return originalUnlink(path);});syncBuiltinESMExports();
 try{
  const receipt=await retireManagedRoot(root,{reason:'interrupted'},policy);assert.equal(receipt.status,'partial');assert.equal(receipt.deletedFiles,1);assert.equal(receipt.removedEntries,0);assert.equal(receipt.removedScratchLeases,0);assert.equal(receipt.issues[0].code,'operation_failed');assert.deepEqual(await readFile(join(stateDir,'inventory.json')),before);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 const receipt=await retireManagedRoot(root,{reason:'retry'},policy);assert.equal(receipt.status,'retired');assert.equal(receipt.missingFiles,1);assert.equal(receipt.deletedFiles,1);assert.equal(receipt.removedEntries,1);await assert.rejects(lstat(root),{code:'ENOENT'});
});

test('retirement reports committed counts when inventory parent sync fails after replacement',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),entry=rawEntry('committed body');
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,entry,'committed body',stateDir);await closedRetirementLease(root,stateDir);
 const inventoryPath=join(stateDir,'inventory.json'),originalRename=fsPromises.rename,originalOpen=fsPromises.open;let replaced=false,injected=false;
 t.mock.method(fsPromises,'rename',async(...args:Parameters<typeof fsPromises.rename>)=>{await originalRename(...args);if(String(args[1])===inventoryPath)replaced=true;});
 t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
  if(replaced&&!injected&&String(args[0])===stateDir){injected=true;throw Object.assign(new Error('synthetic post-commit sync failure'),{code:'EIO'});}
  return originalOpen(...args);
 });syncBuiltinESMExports();
 try{
  const receipt=await retireManagedRoot(root,{reason:'commit warning'},policy);
  assert.equal(injected,true);assert.equal(receipt.status,'retired');assert.equal(receipt.deletedFiles,2);assert.equal(receipt.removedEntries,1);assert.equal(receipt.removedScratchLeases,1);assert.deepEqual(receipt.issues,[{code:'operation_failed',rootId:hash(root)}]);
  await assert.rejects(lstat(root),{code:'ENOENT'});const inventory=JSON.parse(await readFile(inventoryPath,'utf8'));assert.deepEqual(inventory.roots,[]);assert.deepEqual(inventory.entries,[]);assert.deepEqual(inventory.scratch,[]);
  const attempts=await readdir(join(stateDir,'attempts'));assert.equal(attempts.length,1);assert.deepEqual(JSON.parse(await readFile(join(stateDir,'attempts',attempts[0]),'utf8')),receipt);
  await assert.rejects(retireManagedRoot(root,{reason:'already committed'},policy),CivicPolicyStateError);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('retire-root CLI continues rejecting fixture authorities without printing a receipt',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),outputs:string[]=[];
 await initializeManagedAcquisitionLane(root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});const before=await readFile(join(stateDir,'inventory.json'));
 t.mock.method(console,'log',(value:string)=>{outputs.push(value);});
 await assert.rejects(civicOptOutMain(['retire-root','--root',root,'--reason','fixture must remain API-only','--authority-id',policy.authorityId,'--state-dir',stateDir,'--authority-sha256',policy.authoritySha256]),CivicPolicyStateError);
 assert.deepEqual(outputs,[]);assert.deepEqual(await readFile(join(stateDir,'inventory.json')),before);await lstat(root);
});

test('independent HTTP membership selects exact live admissions but never relaxes derived ancestry',async t=>{
 const {base,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),root=join(base,'cas'),body='Synthetic same original bytes';
 await registerManagedCacheRoot(root,{kind:'artifacts',...policy});
 const first={...rawEntry(body,'https://first.org/original',true),relativePath:'sha256/'+hash(body).slice(0,2)+'/'+hash(body)},second={...rawEntry(body,'https://second.org/original',true),relativePath:first.relativePath};
 await publish(root,first,body,stateDir);await publish(root,second,body,stateDir);const path=join(root,first.relativePath);
 await assertManagedIndependentHttpSourceBinding(path,first,policy);await assertManagedIndependentHttpSourceBinding(path,second,policy);
 await assert.rejects(assertManagedSourceBindings(path,[first],policy),CivicPolicyStateError);
 for(const binding of [{...first,observationId:hash('wrong observation')},{...first,receiptSha256:hash('wrong receipt')},{...first,sourceSha256:hash('wrong original')},{...first,url:'https://unknown.org/original'}])await assert.rejects(assertManagedIndependentHttpSourceBinding(path,binding,policy),CivicPolicyStateError);
 const denied={...rawEntry('non-independent original','https://first.org/denied',false),relativePath:'denied.json'};await publish(root,denied,'non-independent original',stateDir);await assert.rejects(assertManagedIndependentHttpSourceBinding(join(root,denied.relativePath),denied,policy),CivicPolicyStateError);
 const derived='Synthetic derived composition',derivedPath=join(root,'composition.json');
 const derivedBindings=[first,second].map(binding=>({...binding,independentAllowed:false}));
 await withManagedSourceWrite(root,derivedBindings.map(binding=>({...binding,relativePath:'composition.json',contentSha256:hash(derived)})),()=>writeFile(derivedPath,derived,{mode:0o600}),policy);
 await assertManagedSourceBindings(derivedPath,derivedBindings,policy);await assert.rejects(assertManagedSourceBindings(derivedPath,[derivedBindings[0]],policy),CivicPolicyStateError);await assert.rejects(assertManagedIndependentHttpSourceBinding(derivedPath,first,policy),CivicPolicyStateError);
 await recordHostOptOut({host:'first.org',reason:'municipality_objection'},policy);
 await assert.rejects(assertManagedIndependentHttpSourceBinding(path,first,policy),HostOptedOutError);await assertManagedIndependentHttpSourceBinding(path,second,policy);
 await writeFile(path,'tampered original',{mode:0o600});await assert.rejects(assertManagedIndependentHttpSourceBinding(path,second,policy),CivicPolicyStateError);
});

async function compactionFixture(t:TestContext){
 const {base,stateDir}=await sandbox(t),root=join(base,'sealed-artifacts'),policy=fixturePolicy(stateDir),bytes='Synthetic sealed publication';
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 const binding:Extract<ManagedSourceBinding,{kind:'retained_publication'}>={kind:'retained_publication',url:'https://sealed.test/source',sourceSha256:null,publication:{manifestSha256:hash('sealed manifest'),releaseId:'sealed-fixture',memberPath:'facts.json',memberSha256:hash(bytes),memberBytes:Buffer.byteLength(bytes)}};
 await publish(root,{...binding,relativePath:'facts.json',contentSha256:hash(bytes),independentAllowed:false},bytes,stateDir);
 await withManagedSourceScratch(root,[{phase:'pre-admission',url:binding.url,sourceSha256:hash(bytes)}],async scope=>{await scope.writeSource('document',Buffer.from(bytes));},{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',...policy});
 return {root,stateDir,policy,binding,bytes};
}

test('compaction proves every logical record, preserves original backup bytes, is idempotent, and dry run writes nothing',async t=>{
 const {stateDir,policy}=await compactionFixture(t),path=join(stateDir,'inventory.json');
 const original=await readFile(path),logical=await readCivicPolicyInventory(policy),filesBefore=await readdir(stateDir,{recursive:true});
 const dry=await compactCivicPolicyInventory({...policy,dryRun:true});
 assert.equal(dry.status,'dry_run');assert.equal(dry.logicalEquality,true);assert.equal(dry.backupPath,null);
 assert.deepEqual(await readFile(path),original);assert.deepEqual(await readdir(stateDir,{recursive:true}),filesBefore);
 const receipt=await compactCivicPolicyInventory(policy),physical=JSON.parse(await readFile(path,'utf8'));
 assert.equal(receipt.status,'compacted');assert.equal(receipt.logicalSha256,dry.logicalSha256);assert.deepEqual(receipt.after,dry.after);
 assert.equal(receipt.before.sha256,hash(original));assert.equal(receipt.before.bytes,original.length);
 assert.deepEqual(await readFile(receipt.backupPath!),original);assert.equal((await lstat(receipt.backupPath!)).mode&0o777,0o600);
 assert.deepEqual(await readCivicPolicyInventory(policy),logical);
 assert.equal(physical.entries.length,0);assert.equal(physical.scratch.length,0);assert.equal(physical.storage.segments.length,2);
 assert.equal(physical.storage.segments[0].previousSha256,null);assert.equal(physical.storage.segments[1].previousSha256,physical.storage.segments[0].sha256);
 for(const pin of receipt.segments){const segmentPath=join(stateDir,'inventory-segments',pin.sha256+'.json'),segment=await readFile(segmentPath);assert.equal(hash(segment),pin.sha256);assert.equal(segment.length,pin.bytes);assert.equal((await lstat(segmentPath)).mode&0o777,0o600);}
 const filesAfter=await readdir(stateDir,{recursive:true}),again=await compactCivicPolicyInventory(policy);
 assert.equal(again.status,'already_compacted');assert.deepEqual(again.before,receipt.after);assert.deepEqual(again.after,receipt.after);
 assert.equal(again.logicalSha256,receipt.logicalSha256);assert.deepEqual(await readdir(stateDir,{recursive:true}),filesAfter);
 await assert.rejects(compactCivicPolicyInventory({...policy,authoritySha256:undefined}),{code:'CIVIC_POLICY_AUTHORITY_UNPINNED'});
});

async function fragmentedRepackFixture(t:TestContext){
 const fixture=await compactionFixture(t),{root,stateDir,policy,binding,bytes}=fixture;
 await compactCivicPolicyInventory(policy);
 await publish(root,{...binding,url:'https://second-sealed.test/source',relativePath:'second.json',contentSha256:hash(bytes),independentAllowed:false},bytes,stateDir);
 await withManagedSourceScratch(root,[{phase:'pre-admission',url:binding.url,sourceSha256:hash(bytes)}],async()=>{},{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',...policy});
 return fixture;
}
test('repack folds retirement/state overrides, preserves all logical bytes and old pins, and is idempotent',async t=>{
 const {root,stateDir,policy,binding,bytes}=await fragmentedRepackFixture(t),retiredRoot=join(dirname(root),'retired-and-reenrolled');
 await initializeManagedAcquisitionLane(retiredRoot,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 await publish(retiredRoot,{...binding,relativePath:'old.json',contentSha256:hash(bytes),independentAllowed:false},bytes,stateDir);
 await retireManagedRoot(retiredRoot,{reason:'Synthetic retired repack history'},policy);
 await initializeManagedAcquisitionLane(retiredRoot,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 await publish(retiredRoot,{...binding,url:'https://reenrolled.test/source',relativePath:'new.json',contentSha256:hash(bytes),independentAllowed:false},bytes,stateDir);
 await recordHostOptOut({host:'sealed.test',reason:'municipality_objection'},policy);
 const path=join(stateDir,'inventory.json'),physical=JSON.parse(await readFile(path,'utf8'));
 physical.roots[0].casWatermarks={[hash('Synthetic preserved watermark')]:{stamp:'1:2:33152:1000:1:10:1000000001:1000000002',checkedAtNs:'10000000000'}};
 await writeFile(path,JSON.stringify(physical)+'\n',{mode:0o600});
 assert.ok(Object.keys(physical.storage.retiredRoots).length);assert.ok(Object.keys(physical.storage.entryStates).length);
 const before=await readFile(path),logical=await readCivicPolicyInventory(policy),authority=await readFile(join(stateDir,'authority.json')),objections=await readCivicOptOutSnapshot(policy);
 const originals=new Map<string,Buffer>();for(const pin of physical.storage.segments)originals.set(pin.sha256,await readFile(join(stateDir,'inventory-segments',pin.sha256+'.json')));
 const files=await readdir(stateDir,{recursive:true}),dry=await repackCivicPolicyInventory({...policy,dryRun:true});
 assert.equal(dry.status,'dry_run');assert.equal(dry.logicalEquality,true);assert.equal(dry.authoritativeCandidateReread,false);assert.equal(dry.backup,null);
 assert.ok(dry.after.segments.length<dry.before.segments.length);assert.equal(dry.before.logicalSha256,dry.after.logicalSha256);
 assert.deepEqual(await readFile(path),before);assert.deepEqual(await readdir(stateDir,{recursive:true}),files);
 const result=await repackCivicPolicyInventory(policy);
 assert.equal(result.status,'repacked');assert.equal(result.authoritativeCandidateReread,true);assert.deepEqual(result.before,dry.before);assert.deepEqual(result.after,dry.after);
 assert.deepEqual(await readFile(result.backup!.manifestPath),before);assert.equal(result.backup!.segmentsDirectory,join(stateDir,'inventory-segments'));
 assert.deepEqual(await readCivicPolicyInventory(policy),logical);assert.deepEqual(await readFile(join(stateDir,'authority.json')),authority);assert.deepEqual(await readCivicOptOutSnapshot(policy),objections);
 for(const [sha,original] of originals)assert.deepEqual(await readFile(join(stateDir,'inventory-segments',sha+'.json')),original);
 const packed=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(packed.storage.retiredRoots,{});assert.deepEqual(packed.storage.entryStates,{});
 assert.equal(logical.entries.some(entry=>entry.relativePath==='old.json'),false);assert.equal(logical.entries.some(entry=>entry.relativePath==='new.json'),true);assert.ok(logical.entries.some(entry=>entry.state==='deleted'));
 const afterFiles=await readdir(stateDir,{recursive:true}),again=await repackCivicPolicyInventory(policy);
 assert.equal(again.status,'already_packed');assert.equal(again.backup,null);assert.deepEqual(await readdir(stateDir,{recursive:true}),afterFiles);
 assert.equal(JSON.stringify(result).includes(bytes),false);assert.equal(JSON.stringify(result).includes(binding.url),false);
});

for(const mutation of ['roots','authority','objections','segment','old_segment','backup'] as const)test('repack aborts before the live manifest on changed '+mutation,async t=>{
 const {stateDir,policy}=await fragmentedRepackFixture(t),path=join(stateDir,'inventory.json'),before=await readFile(path),originalOpen=fsPromises.open;let injected=false;
 t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
  const candidate=String(args[0]);
  const staged=!injected&&candidate.startsWith(join(stateDir,'inventory.repack-'))&&candidate.endsWith('.json')?await lstat(candidate).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;return undefined;}):undefined;
  if(staged){
   injected=true;
   if(mutation==='roots'){const value=JSON.parse(await readFile(candidate,'utf8'));value.roots[0].complete=false;await writeFile(candidate,JSON.stringify(value)+'\n',{mode:0o600});}
   if(mutation==='authority')await writeFile(join(stateDir,'authority.json'),Buffer.concat([await readFile(join(stateDir,'authority.json')),Buffer.from('\n')]),{mode:0o600});
   if(mutation==='objections')await writeFile(join(stateDir,'hosts',hash('concurrent.test')+'.json'),JSON.stringify({schemaVersion:1,host:'concurrent.test',reason:'municipality_objection',receivedAt:now,purgeDueAt:'2026-10-18T12:00:00.000Z'})+'\n',{mode:0o600});
   if(mutation==='segment'){const value=JSON.parse(await readFile(candidate,'utf8')),pin=value.storage.segments[0],file=join(stateDir,'inventory-segments',pin.sha256+'.json'),bytes=await readFile(file);bytes[10]^=1;await writeFile(file,bytes,{mode:0o600});}
   if(mutation==='old_segment'){const pin=JSON.parse(before.toString('utf8')).storage.segments[0],file=join(stateDir,'inventory-segments',pin.sha256+'.json'),bytes=await readFile(file);bytes[10]^=1;await writeFile(file,bytes,{mode:0o600});}
   if(mutation==='backup')await writeFile(join(stateDir,'inventory.json.backup-'+hash(before)),Buffer.concat([before,Buffer.from('\n')]),{mode:0o600});
  }
  return originalOpen(...args);
 });syncBuiltinESMExports();
 try{await assert.rejects(repackCivicPolicyInventory(policy),CivicPolicyStateError);assert.equal(injected,true);assert.deepEqual(await readFile(path),before);}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

for(const scenario of [
 {args:[],code:'CIVIC_POLICY_AUTHORITY_UNPINNED'},
 {args:['--authority-sha256','0'.repeat(64),'--pending-scratch','https://private.test/source-body'],code:'INVALID_OPERATOR_ARGUMENTS'},
 {args:['--unexpected-source-title','private source body'],code:'CIVIC_POLICY_REPACK_FAILED'},
])test('repack CLI emits only content-free JSON for '+scenario.code,async t=>{
 const child=spawn(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('../src/civic-opt-out.ts',import.meta.url)),'repack-inventory',...scenario.args],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
 const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 assert.equal(code,2);assert.equal(stdout,'');assert.deepEqual(JSON.parse(stderr),{schemaVersion:'civic-inventory-repack-error-v1',code:scenario.code});assert.equal(stderr.trim().split('\n').length,1);assert.equal(stderr.includes('private'),false);
});

test('repack refuses live/in-process holders immediately without waiting or stealing',async t=>{
 const {root,stateDir,policy,binding,bytes}=await fragmentedRepackFixture(t),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const held=withManagedSourceWrite(root,[{...binding,relativePath:'facts.json',contentSha256:hash(bytes),independentAllowed:false}],async()=>{entered.resolve();await release.promise;},policy);
 await entered.promise;const lock=join(stateDir,'inventory.lock'),original=await readFile(lock);
 try{await assert.rejects(repackCivicPolicyInventory({...policy,dryRun:true}),{code:'CIVIC_POLICY_REPACK_QUIESCENCE_REQUIRED'});assert.deepEqual(await readFile(lock),original);assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.wait-')),false);}
 finally{release.resolve();await held;}
});

test('repack refuses an external live lock without creating a waiter or stealing it',async t=>{
 const {root,stateDir,policy,binding,bytes}=await fragmentedRepackFixture(t),module=new URL('../src/civic-opt-out.ts',import.meta.url).href;
 const script=`import {withManagedSourceWrite} from ${JSON.stringify(module)};
  const {root,policy,entry}=JSON.parse(process.argv[1]);await withManagedSourceWrite(root,[entry],async()=>{process.stdout.write('ready\\n');await new Promise(resolve=>process.stdin.once('data',resolve));},policy);`;
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,JSON.stringify({root,policy,entry:{...binding,relativePath:'facts.json',contentSha256:hash(bytes),independentAllowed:false}})],{stdio:['pipe','pipe','pipe']}),ready=Promise.withResolvers<void>(),closed=Promise.withResolvers<void>();let stdout='',stderr='';
 child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('ready\n'))ready.resolve();});child.stderr.on('data',chunk=>{stderr+=chunk;});
 child.once('error',ready.reject);child.once('close',()=>{if(!stdout.includes('ready\n'))ready.reject(new Error(stderr));closed.resolve();});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed.promise;});
 await ready.promise;const lock=join(stateDir,'inventory.lock'),record=await readFile(lock);
 try{await assert.rejects(repackCivicPolicyInventory({...policy,dryRun:true}),{code:'CIVIC_POLICY_REPACK_QUIESCENCE_REQUIRED'});assert.deepEqual(await readFile(lock),record);assert.equal((await readdir(stateDir)).some(name=>name.startsWith('inventory.wait-')),false);}
 finally{child.stdin.end('release');await closed.promise;}
});

for(const state of ['planned','active','closing','partial'] as const)test('repack requires exact dead-owner partial pins, never an exemption for '+state,async t=>{
 const {stateDir,policy}=await fragmentedRepackFixture(t),path=join(stateDir,'inventory.json'),logical=await readCivicPolicyInventory(policy);
 const child=spawn(process.execPath,['-e',''],{stdio:'ignore'}),exited=Promise.withResolvers<void>();child.once('error',exited.reject);child.once('close',()=>exited.resolve());await exited.promise;
 const physical=JSON.parse(await readFile(path,'utf8')),lease={...logical.scratch[0],id:randomUUID(),directory:'',state,identity:null,ownerPid:child.pid!,groups:[],resources:[]};lease.directory='scratch/'+lease.id;
 physical.scratch.push(lease);await writeFile(path,JSON.stringify(physical)+'\n',{mode:0o600});
 const current=(await readCivicPolicyInventory(policy)).scratch.find(item=>item.id===lease.id)!,pin=lease.id+':'+hash(JSON.stringify(current));
 await assert.rejects(repackCivicPolicyInventory({...policy,dryRun:true}),{code:'CIVIC_POLICY_REPACK_QUIESCENCE_REQUIRED'});
 await assert.rejects(repackCivicPolicyInventory({...policy,dryRun:true,pendingScratch:[lease.id+':'+'0'.repeat(64)]}),{code:'CIVIC_POLICY_REPACK_QUIESCENCE_REQUIRED'});
 if(state==='partial'){
  const result=await repackCivicPolicyInventory({...policy,dryRun:true,pendingScratch:[pin]});assert.deepEqual(result.preservedPendingScratch,[{id:lease.id,sha256:hash(JSON.stringify(current))}]);
  assert.deepEqual((await readCivicPolicyInventory(policy)).scratch.find(item=>item.id===lease.id),current);
  physical.scratch[0].ownerPid=process.pid;await writeFile(path,JSON.stringify(physical)+'\n',{mode:0o600});
  const live=(await readCivicPolicyInventory(policy)).scratch.find(item=>item.id===lease.id)!;
  await assert.rejects(repackCivicPolicyInventory({...policy,dryRun:true,pendingScratch:[lease.id+':'+hash(JSON.stringify(live))]}),{code:'CIVIC_POLICY_REPACK_QUIESCENCE_REQUIRED'});
 }else await assert.rejects(repackCivicPolicyInventory({...policy,dryRun:true,pendingScratch:[pin]}),{code:'CIVIC_POLICY_REPACK_QUIESCENCE_REQUIRED'});
});

test('repack rejects an explicitly pinned partial lease with a live settled process group',async t=>{
 const {stateDir,policy}=await fragmentedRepackFixture(t),path=join(stateDir,'inventory.json'),logical=await readCivicPolicyInventory(policy);
 const dead=spawn(process.execPath,['-e',''],{stdio:'ignore'}),deadExit=Promise.withResolvers<void>();dead.once('error',deadExit.reject);dead.once('close',()=>deadExit.resolve());await deadExit.promise;
 const group=spawn(process.execPath,['-e','process.stdin.resume()'],{detached:true,stdio:['pipe','ignore','ignore']}),spawned=Promise.withResolvers<void>(),closed=Promise.withResolvers<void>();
 group.once('spawn',spawned.resolve);group.once('error',spawned.reject);group.once('close',()=>closed.resolve());t.after(async()=>{group.kill('SIGKILL');await closed.promise;});await spawned.promise;
 const physical=JSON.parse(await readFile(path,'utf8')),id=randomUUID(),lease={...logical.scratch[0],id,directory:'scratch/'+id,state:'partial',identity:null,ownerPid:dead.pid!,groups:[{pid:group.pid!,settled:true}],resources:[]};
 physical.scratch.push(lease);await writeFile(path,JSON.stringify(physical)+'\n',{mode:0o600});
 const current=(await readCivicPolicyInventory(policy)).scratch.find(item=>item.id===id)!;
 await assert.rejects(repackCivicPolicyInventory({...policy,dryRun:true,pendingScratch:[id+':'+hash(JSON.stringify(current))]}),{code:'CIVIC_POLICY_REPACK_QUIESCENCE_REQUIRED'});
});

test('repack requires pinned sealed state and refuses a mismatched original backup before publication',async t=>{
 const fixture=await compactionFixture(t),{stateDir,policy}=fixture,path=join(stateDir,'inventory.json'),monolithic=await readFile(path);
 await assert.rejects(repackCivicPolicyInventory({...policy,authoritySha256:undefined}),{code:'CIVIC_POLICY_AUTHORITY_UNPINNED'});
 await assert.rejects(repackCivicPolicyInventory(policy),{code:'CIVIC_POLICY_REPACK_SEALED_REQUIRED'});assert.deepEqual(await readFile(path),monolithic);
 await compactCivicPolicyInventory(policy);
 await publish(fixture.root,{...fixture.binding,url:'https://backup.test/source',relativePath:'second.json',contentSha256:hash(fixture.bytes),independentAllowed:false},fixture.bytes,stateDir);
 const before=await readFile(path);await writeFile(join(stateDir,'inventory.json.backup-'+hash(before)),'Synthetic wrong original manifest',{mode:0o600});
 await assert.rejects(repackCivicPolicyInventory(policy),{code:'CIVIC_POLICY_BACKUP_MISMATCH'});assert.deepEqual(await readFile(path),before);
});

for(const phase of ['segment','candidate','candidate_rename','candidate_linked','after_rename'] as const)test('repack survives a real process crash at '+phase,{timeout:30_000},async t=>{
 const {stateDir,policy}=await fragmentedRepackFixture(t),path=join(stateDir,'inventory.json'),before=await readFile(path),logical=await readCivicPolicyInventory(policy),physical=JSON.parse(before.toString('utf8')),module=new URL('../src/civic-opt-out.ts',import.meta.url).href;
 const script=`
  // Module-loading boundary: fault hooks must be live before custody imports.
  import {promises as fs} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
  const {policy,stateDir,phase,oldPins,module}=JSON.parse(process.argv[1]),originalOpen=fs.open,originalRename=fs.rename;
  const pause=async()=>{process.stdout.write('ready\\n');await new Promise(resolve=>process.stdin.once('data',resolve));};
  fs.open=async(...args)=>{const handle=await originalOpen(...args),path=String(args[0]);
   if(phase==='segment'&&path.startsWith(stateDir+'/inventory-segments/')&&path.endsWith('.json')&&!oldPins.some(sha=>path.endsWith('/'+sha+'.json')))await pause();
   if(phase==='candidate'&&path.startsWith(stateDir+'/inventory.repack-')&&path.endsWith('.json'))await pause();
   return handle;};
  fs.rename=async(...args)=>{
   const target=String(args[1]),candidate=target.startsWith(stateDir+'/inventory.repack-')&&target.endsWith('.json');
   // Reproduce the old exclusive staging protocol's precise crash window.
   if(phase==='candidate_linked'&&candidate){await fs.link(...args);await pause();await fs.unlink(args[0]);return;}
   await originalRename(...args);
   if(phase==='candidate_rename'&&candidate||phase==='after_rename'&&target===stateDir+'/inventory.json')await pause();
  };
  syncBuiltinESMExports();const {repackCivicPolicyInventory}=await import(module);await repackCivicPolicyInventory(policy);
 `;
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,JSON.stringify({policy,stateDir,phase,oldPins:physical.storage.segments.map((pin:{sha256:string})=>pin.sha256),module})],{stdio:['pipe','pipe','pipe']}),ready=Promise.withResolvers<void>(),closed=Promise.withResolvers<void>();let stdout='',stderr='';
 child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('ready\n'))ready.resolve();});child.stderr.on('data',chunk=>{stderr+=chunk;});
 child.once('error',error=>{ready.reject(error);closed.reject(error);});child.once('close',()=>{if(!stdout.includes('ready\n'))ready.reject(new Error(stderr||'Repack child exited before crash barrier'));closed.resolve();});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed.promise;});
 await ready.promise;
 if(phase==='candidate_linked'||phase==='candidate_rename'){
  const name=(await readdir(stateDir)).find(name=>name.startsWith('inventory.repack-')&&name.endsWith('.json'));assert.ok(name);
  const candidate=await lstat(join(stateDir,name));assert.equal(candidate.nlink,phase==='candidate_linked'?2:1);
  const linkedTemporaries=await Promise.all((await readdir(stateDir)).filter(name=>name.startsWith('.')&&name.endsWith('.tmp')).map(async name=>await lstat(join(stateDir,name))));
  assert.equal(linkedTemporaries.filter(stat=>stat.dev===candidate.dev&&stat.ino===candidate.ino).length,phase==='candidate_linked'?1:0);
 }
 child.kill('SIGKILL');await closed.promise;assert.equal(child.signalCode,'SIGKILL');
 if(phase!=='after_rename')assert.deepEqual(await readFile(path),before);else assert.notDeepEqual(await readFile(path),before);
 assert.equal((await recoverCivicPolicyLock(policy)).status,'recovered');
 assert.deepEqual(await readCivicPolicyInventory(policy),logical);
 const receipt=await repackCivicPolicyInventory(policy);assert.equal(receipt.status,phase==='after_rename'?'already_packed':'repacked');
 assert.deepEqual(await readFile(join(stateDir,'inventory.json.backup-'+hash(before))),before);
 for(const pin of physical.storage.segments)assert.equal(hash(await readFile(join(stateDir,'inventory-segments',pin.sha256+'.json'))),pin.sha256);
 assert.deepEqual(await readCivicPolicyInventory(policy),logical);
 assert.equal((await lstat(path)).nlink,1);
});

test('sealed read snapshots reuse hydration/index but reopen every current pin on every read',async t=>{
 const {root,stateDir,policy,binding}=await compactionFixture(t),migration=await compactCivicPolicyInventory(policy),path=join(root,'facts.json');
 await assertManagedSourceBindings(path,[binding],policy);
 const detached=await readCivicPolicyInventory(policy),entryId=detached.entries[0].id;
 detached.entries[0].state='revoked';detached.roots[0].complete=false;detached.scratch[0].sources.length=0;
 const originalSet=Map.prototype.set,originalOpen=fsPromises.open;let rebuiltEntries=0,pinOpens=0;
 t.mock.method(Map.prototype,'set',function(this:Map<unknown,unknown>,key:unknown,value:unknown){
  if(key===entryId&&value&&typeof value==='object'&&'id' in value&&value.id===entryId)rebuiltEntries++;
  return originalSet.call(this,key,value);
 });
 t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
  if(String(args[0]).startsWith(join(stateDir,'inventory-segments')+'/'))pinOpens++;
  return originalOpen(...args);
 });syncBuiltinESMExports();
 try{
  for(let i=0;i<5;i++)await assertManagedSourceReadable(path,policy);
  assert.equal(rebuiltEntries,0,'unchanged read-only snapshots must not rebuild full entry maps');
  assert.equal(pinOpens,5*migration.segments.length,'every locked read must reopen every pin; warm caches need no speculative reread');
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 const current=await readCivicPolicyInventory(policy);
 assert.equal(current.entries[0].state,'active');assert.equal(current.roots[0].complete,true);assert.equal(current.scratch[0].sources.length,1);
});

test('sealed read snapshot invalidates on manifest state changes and isolates failed mutable transactions',async t=>{
 const {root,stateDir,policy,binding,bytes}=await compactionFixture(t);await compactCivicPolicyInventory(policy);
 const path=join(root,'facts.json'),inventoryPath=join(stateDir,'inventory.json');
 await assertManagedSourceBindings(path,[binding],policy);const before=await readFile(inventoryPath),originalRename=fsPromises.rename;
 t.mock.method(fsPromises,'rename',async(...args:Parameters<typeof fsPromises.rename>)=>{
  if(String(args[1])===inventoryPath)throw Object.assign(new Error('Synthetic pre-commit failure'),{code:'EIO'});
  return originalRename(...args);
 });syncBuiltinESMExports();
 try{await assert.rejects(recordManagedSourceContent(root,{...binding,url:'https://uncommitted.test/source',relativePath:'facts.json',contentSha256:hash(bytes),independentAllowed:false},policy),{code:'EIO'});}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
 assert.deepEqual(await readFile(inventoryPath),before);
 await assertManagedSourceBindings(path,[binding],policy);
 const current=await readCivicPolicyInventory(policy),physical=JSON.parse(before.toString('utf8'));
 physical.storage.entryStates[current.entries[0].id]='revoked';
 await writeFile(inventoryPath,JSON.stringify(physical)+'\n',{mode:0o600});
 await assert.rejects(assertManagedSourceReadable(path,policy),{code:'CONTENT_REFERENCE_REVOKED'});
 assert.equal((await readCivicPolicyInventory(policy)).entries[0].state,'revoked');
 await writeFile(inventoryPath,before,{mode:0o600});await assertManagedSourceBindings(path,[binding],policy);
 await recordHostOptOut({host:'sealed.test',reason:'municipality_objection'},policy);
 await assert.rejects(assertManagedSourceReadable(path,policy),HostOptedOutError);
 assert.equal((await readCivicPolicyInventory(policy)).entries[0].state,'deleted');
});

for(const mode of ['missing','identity'] as const)test('speculative warming tolerates concurrent retirement/save across four processes: '+mode,{timeout:30_000},async t=>{
 const {root,stateDir,policy}=await compactionFixture(t),writerRoot=join(dirname(root),'writer-fetch'),writerBytes='Synthetic concurrent saver',entry=rawEntry(writerBytes);
 await initializeManagedAcquisitionLane(writerRoot,{...policy,kind:'fetch',decisionId:CIVIC_ACQUISITION_DECISION_ID});await publish(writerRoot,entry,writerBytes,stateDir);
 const compacted=await compactCivicPolicyInventory(policy),pinPath=join(stateDir,'inventory-segments',compacted.segments[0]!.sha256+'.json'),lock=join(stateDir,'inventory.lock');
 const moduleUrl=new URL('../src/civic-opt-out.ts',import.meta.url).href,configuration=JSON.stringify({root,writerRoot,policy,entry,pinPath,mode});
 const start=(body:string)=>{
  const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import {readCivicPolicyInventory,retireManagedRoot,withManagedSourceWrite} from ${JSON.stringify(moduleUrl)};const {root,writerRoot,policy,entry,pinPath,mode}=JSON.parse(process.argv[1]);${body}`,configuration],{stdio:['pipe','pipe','pipe']});
  const closed=Promise.withResolvers<number|null>();let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('error',closed.reject);child.once('close',closed.resolve);
  void closed.promise.catch(()=>{});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed.promise;});
  const stage=(name:string):Promise<void>=>{
   if(stdout.split('\n').includes(name))return Promise.resolve();
   const ready=Promise.withResolvers<void>(),receive=()=>{if(stdout.split('\n').includes(name)){child.stdout.removeListener('data',receive);ready.resolve();}};
   if(child.exitCode!==null||child.signalCode!==null)return Promise.reject(Error('Fixture exited before '+name+': '+stderr));
   child.stdout.on('data',receive);child.once('close',()=>ready.reject(Error('Fixture exited before '+name+': '+stderr)));return ready.promise;
  };
  return {child,closed:closed.promise,stage,stdout:()=>stdout,stderr:()=>stderr};
 };
 // IPC gates, not sleeps: all four independent readers have the old manifest
 // before a real retire/save transaction changes the segment under its lock.
 const readers=Array.from({length:4},()=>start(`
  const original=fs.open;let first=true,waiting=false;
  fs.open=async(...args)=>{
   if(String(args[0])===pinPath&&first){
    first=false;const handle=mode==='identity'?await original(...args):undefined,gate=Promise.withResolvers();
    process.stdin.once('data',gate.resolve);process.stdout.write('warming\\n');await gate.promise;return handle??original(...args);
   }
   try{return await original(...args);}catch(error){if(String(args[0])===join(policy.stateDir,'inventory.lock')&&error.code==='EEXIST'&&!waiting){waiting=true;process.stdout.write('waiting\\n');}throw error;}
  };syncBuiltinESMExports();
  const inventory=await readCivicPolicyInventory(policy);process.stdout.write(JSON.stringify({roots:inventory.roots.map(root=>root.path),hashes:inventory.entries.map(entry=>entry.contentSha256),scratch:inventory.scratch.length})+'\\n');
 `));
 await Promise.all(readers.map(reader=>reader.stage('warming')));
 const saver=start(`
  assert.equal((await retireManagedRoot(root,{reason:'Synthetic concurrent segment retirement'},policy)).status,'retired');
  await withManagedSourceWrite(writerRoot,[entry],async()=>{
   // Fixture-only segment turnover inside an actual saver transaction. Missing
   // pins are restored before release; identity replacement keeps exact bytes.
   // No production segment garbage collection or relaxed pin codec is added.
   if(mode==='missing')await fs.rename(pinPath,pinPath+'.retired');
   else{await fs.writeFile(pinPath+'.replacement',await fs.readFile(pinPath),{mode:0o600});await fs.rename(pinPath+'.replacement',pinPath);}
   const gate=Promise.withResolvers();process.stdin.once('data',gate.resolve);process.stdout.write('saving\\n');await gate.promise;
   if(mode==='missing')await fs.rename(pinPath+'.retired',pinPath);
  },policy);
 `);
 await saver.stage('saving');const holder=await lstat(lock);
 for(const reader of readers)reader.child.stdin.end('resume-warming');
 await Promise.all(readers.map(reader=>reader.stage('waiting')));
 assert.equal((await lstat(lock)).ino,holder.ino,'Warm failure must proceed to waiting, not bypass the saver lock');
 saver.child.stdin.end('finish-save');assert.equal(await saver.closed,0,saver.stderr());
 for(const reader of readers){assert.equal(await reader.closed,0,reader.stderr());assert.deepEqual(JSON.parse(reader.stdout().trim().split('\n').at(-1)!),{roots:[writerRoot],hashes:[entry.contentSha256],scratch:0});}
 await assert.rejects(lstat(lock),{code:'ENOENT'});
});

test('locked load rejects a changed pin after successful speculative warming',async t=>{
 const {stateDir,policy}=await compactionFixture(t),migration=await compactCivicPolicyInventory(policy),path=join(stateDir,'inventory-segments',migration.segments[0]!.sha256+'.json'),lock=join(stateDir,'inventory.lock');
 await readCivicPolicyInventory(policy);const originalOpen=fsPromises.open;let changed=false;
 t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
  const handle=await originalOpen(...args);
  if(String(args[0])===lock&&!changed){changed=true;const bytes=await readFile(path);bytes[10]^=1;await writeFile(path,bytes,{mode:0o600});}
  return handle;
 });syncBuiltinESMExports();
 try{await assert.rejects(readCivicPolicyInventory(policy),{code:'CIVIC_POLICY_INVENTORY_UNAVAILABLE'});assert.equal(changed,true);await assert.rejects(lstat(lock),{code:'ENOENT'});}
 finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

for(const family of ['entries','scratch'])for(const mutation of ['tamper','missing','symlink','hardlink','mode'])test('sealed '+family+' '+mutation+' fails closed even after cache warming',async t=>{
 const {root,stateDir,policy}=await compactionFixture(t),migration=await compactCivicPolicyInventory(policy);
 await readCivicPolicyInventory(policy);
 const pin=migration.segments.find(segment=>segment.family===family)!;
 const path=join(stateDir,'inventory-segments',pin.sha256+'.json'),original=await readFile(path),target=join(stateDir,'unrelated.json');
 if(mutation==='tamper'){const tampered=Buffer.from(original);tampered[10]^=1;await writeFile(path,tampered,{mode:0o600});}
 if(mutation==='missing')await rm(path);
 if(mutation==='symlink'){await writeFile(target,original,{mode:0o600});await rm(path);await symlink(target,path);}
 if(mutation==='hardlink')await link(path,target);
 if(mutation==='mode')await chmod(path,0o644);
 await assert.rejects(readCivicPolicyInventory(policy),CivicPolicyStateError);
 await assert.rejects(assertManagedSourceReadable(join(root,'facts.json'),policy),CivicPolicyStateError);
 const purge=await recordHostOptOut({host:'sealed.test',reason:'municipality_objection'},policy);
 assert.equal(purge.purge.status,'error');assert.deepEqual(purge.purge.issues,[{code:'inventory_unavailable'}]);
 assert.equal(await readFile(join(root,'facts.json'),'utf8'),'Synthetic sealed publication');
});

for(const family of ['entries','scratch'])for(const mutation of ['tamper','missing','symlink','hardlink','mode'])test('lock-free audit finish revalidates captured '+family+' segment after '+mutation,async t=>{
 const {root,stateDir,policy}=await compactionFixture(t),migration=await compactCivicPolicyInventory(policy),audit=await createReadOnlyManagedSourceAudit(policy);
 await audit.read(join(root,'facts.json'));const manifest=await readFile(join(stateDir,'inventory.json'));
 const pin=migration.segments.find(segment=>segment.family===family)!,path=join(stateDir,'inventory-segments',pin.sha256+'.json'),original=await readFile(path),target=join(stateDir,'audit-unrelated.json');
 if(mutation==='tamper'){const tampered=Buffer.from(original);tampered[10]^=1;await writeFile(path,tampered,{mode:0o600});}
 if(mutation==='missing')await rm(path);
 if(mutation==='symlink'){await writeFile(target,original,{mode:0o600});await rm(path);await symlink(target,path);}
 if(mutation==='hardlink')await link(path,target);
 if(mutation==='mode')await chmod(path,0o644);
 await assert.rejects(audit.finish(),CivicPolicyStateError);assert.deepEqual(await readFile(join(stateDir,'inventory.json')),manifest);
});

test('manifest chain corruption fails closed, and archived scratch still prevents restoration from being blessed',async t=>{
 const {root,stateDir,policy,binding,bytes}=await compactionFixture(t);
 await compactCivicPolicyInventory(policy);
 const path=join(stateDir,'inventory.json'),original=await readFile(path),physical=JSON.parse(original.toString('utf8'));
 physical.storage.segments[1].previousSha256=hash('foreign predecessor');
 await writeFile(path,JSON.stringify(physical)+'\n',{mode:0o600});await assert.rejects(readCivicPolicyInventory(policy),CivicPolicyStateError);
 await writeFile(path,original,{mode:0o600});
 const archived=(await readCivicPolicyInventory(policy)).scratch[0];assert.equal(archived.state,'closed');assert.equal(archived.tombstones.length,1);assert.equal(archived.sources[0].host,'sealed.test');
 await mkdir(join(root,archived.directory),{mode:0o700});await writeFile(join(root,archived.directory,'restored'),bytes,{mode:0o600});
 await assert.rejects(markManagedCacheInventoryComplete(root,policy),{code:'MANAGED_INVENTORY_INCOMPLETE'});
 const receipt=await recordHostOptOut({host:'sealed.test',reason:'municipality_objection'},policy);
 assert.equal(receipt.purge.deletedFiles,1);assert.equal(receipt.purge.status,'partial');
 await assert.rejects(lstat(join(root,'facts.json')),{code:'ENOENT'});
 await assert.rejects(assertManagedSourceBindings(join(root,'facts.json'),[binding],policy),CivicPolicyStateError);
 assert.equal((await readCivicPolicyInventory(policy)).entries[0].state,'deleted');
 assert.deepEqual((await readCivicPolicyInventory(policy)).scratch[0],archived);
});

test('new bulk entries and closed leases append sealed history; hot writes and retirement preserve exact ownership',async t=>{
 const {root,stateDir,policy,binding,bytes}=await compactionFixture(t);
 await compactCivicPolicyInventory(policy);const before=await readCivicPolicyInventory(policy);
 await publish(root,{...binding,url:'https://second-sealed.test/source',relativePath:'second.json',contentSha256:hash(bytes),independentAllowed:false},bytes,stateDir);
 await withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://second-sealed.test/source',sourceSha256:hash(bytes)}],async scope=>{await scope.writeSource('document',Buffer.from(bytes));},{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',...policy});
 const logical=await readCivicPolicyInventory(policy),physical=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));
 assert.equal(physical.entries.length,0);assert.equal(physical.scratch.length,0);assert.equal(physical.storage.segments.length,4);
 assert.equal(logical.entries.length,2);assert.equal(logical.scratch.length,2);assert.deepEqual(logical.scratch[0],before.scratch[0]);
 await assertManagedSourceBindings(join(root,'second.json'),[{...binding,url:'https://second-sealed.test/source'}],policy);
 const purge=await recordHostOptOut({host:'second-sealed.test',reason:'municipality_objection'},policy);assert.equal(purge.purge.deletedFiles,1);
 await assertManagedSourceBindings(join(root,'facts.json'),[binding],policy);
 const retired=await retireManagedRoot(root,{reason:'Synthetic compacted ownership retirement'},policy);
 assert.equal(retired.status,'retired');assert.equal(retired.removedEntries,2);assert.equal(retired.removedScratchLeases,2);
 const after=await readCivicPolicyInventory(policy);assert.deepEqual(after.roots,[]);assert.deepEqual(after.entries,[]);assert.deepEqual(after.scratch,[]);
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 assert.deepEqual((await readCivicPolicyInventory(policy)).scratch,[]);
 assert.deepEqual((await readCivicPolicyInventory(policy)).entries,[]);
 await publish(root,{...binding,relativePath:'facts.json',contentSha256:hash(bytes),independentAllowed:false},bytes,stateDir);
 const reopened=await readCivicPolicyInventory(policy);assert.equal(reopened.entries.length,1);assert.equal(reopened.entries[0].state,'active');assert.deepEqual(reopened.scratch,[]);
});

test('compaction refuses a mismatched existing backup without publishing a new layout',async t=>{
 const {stateDir,policy}=await compactionFixture(t),path=join(stateDir,'inventory.json'),original=await readFile(path),backupPath=join(stateDir,'backup.json');
 await writeFile(backupPath,'foreign bytes',{mode:0o600});
 await assert.rejects(compactCivicPolicyInventory({...policy,backupPath}),{code:'CIVIC_POLICY_BACKUP_MISMATCH'});
 assert.deepEqual(await readFile(path),original);assert.equal(await readFile(backupPath,'utf8'),'foreign bytes');await assert.rejects(lstat(join(stateDir,'inventory-segments')),{code:'ENOENT'});
});

test('a marked external inventory waiter gets an acquisition opportunity before the holder re-enters',async t=>{
 const {base,root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),bytes='Synthetic fair lock source',entry=rawEntry(bytes),waiterRoot=join(base,'external-waiter');
 await registerManagedCacheRoot(root,{kind:'fetch',...policy});await publish(root,entry,bytes,stateDir);
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),marked=Promise.withResolvers<string>();
 const watcher=watch(stateDir,(_event,name)=>{if(String(name).startsWith('inventory.wait-'))marked.resolve(String(name));});t.after(()=>watcher.close());
 const holding=withManagedSourceWrite(root,[entry],async()=>{entered.resolve();await release.promise;},policy);
 await entered.promise;
 const moduleUrl=new URL('../src/civic-opt-out.ts',import.meta.url).href;
 const script=`import {registerManagedCacheRoot} from ${JSON.stringify(moduleUrl)};await registerManagedCacheRoot(process.argv[1],{kind:'fetch',...JSON.parse(process.argv[2])});`;
 const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,waiterRoot,JSON.stringify(policy)],{stdio:'ignore'});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const finished=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 const marker=await marked.promise;assert.equal((await lstat(join(stateDir,marker))).mode&0o777,0o600);
 release.resolve();await holding;
 await withManagedSourceWrite(root,[entry],async()=>{
  const inventory=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));
  assert.ok(inventory.roots.some((item:{path:string})=>item.path===waiterRoot));
 },policy);
 assert.equal(await finished,0);assert.deepEqual((await readdir(stateDir)).filter(name=>name.startsWith('inventory.wait-')),[]);
});

for(const family of ['entries','scratch'])test('sealed '+family+' without an owning root fail closed unless explicitly retired',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'orphan-sealed'),policy=fixturePolicy(stateDir),bytes='Synthetic orphan sealed record';
 await initializeManagedAcquisitionLane(root,{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 if(family==='entries'){
  const binding:Extract<ManagedSourceBinding,{kind:'retained_publication'}>={kind:'retained_publication',url:'https://orphan-sealed.test/source',sourceSha256:null,publication:{manifestSha256:hash('orphan manifest'),releaseId:'orphan-fixture',memberPath:'facts.json',memberSha256:hash(bytes),memberBytes:Buffer.byteLength(bytes)}};
  await publish(root,{...binding,relativePath:'facts.json',contentSha256:hash(bytes),independentAllowed:false},bytes,stateDir);
 }else{
  await withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://orphan-sealed.test/source',sourceSha256:hash(bytes)}],async scope=>{await scope.writeSource('document',Buffer.from(bytes));},{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',...policy});
 }
 const migration=await compactCivicPolicyInventory(policy);assert.equal(migration.segments.length,1);assert.equal(migration.segments[0].family,family);
 const path=join(stateDir,'inventory.json'),original=await readFile(path),physical=JSON.parse(original.toString('utf8'));
 assert.deepEqual(physical.storage.retiredRoots,{});physical.roots=[];await writeFile(path,JSON.stringify(physical)+'\n',{mode:0o600});
 await assert.rejects(readCivicPolicyInventory(policy),CivicPolicyStateError);
 await assert.rejects(recoverManagedSourceScratch(policy),CivicPolicyStateError);
 const receipt=await recordHostOptOut({host:'orphan-sealed.test',reason:'municipality_objection'},policy);
 assert.equal(receipt.purge.status,'error');assert.deepEqual(receipt.purge.issues,[{code:'inventory_unavailable'}]);assert.equal(receipt.purge.deletedFiles,0);
 if(family==='entries')assert.equal(await readFile(join(root,'facts.json'),'utf8'),bytes);
 // Real retirement, unlike deleting roots out of the manifest, records the
 // cutoff and removes ownership without leaving an orphaned logical record.
 await writeFile(path,original,{mode:0o600});const retired=await retireManagedRoot(root,{reason:'Synthetic explicit sealed retirement'},policy);
 assert.equal(retired.status,'retired');const after=await readCivicPolicyInventory(policy);assert.deepEqual(after.roots,[]);assert.deepEqual(after.entries,[]);assert.deepEqual(after.scratch,[]);
});

for(const family of ['observations','requests'])test('content-free '+family+' replacement retires sealed bindings by copy-on-write without poisoning the root',async t=>{
 const {root,stateDir}=await sandbox(t),policy=fixturePolicy(stateDir),url='https://metadata-sealed.test/source';
 await initializeManagedAcquisitionLane(root,{kind:'fetch',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 const relativePath=family==='observations'?'observations/sealed.json':'requests/'+hash('sealed request')+'.json';
 const initial=JSON.stringify({url,method:'GET',checkedAt:now,retrievedAt:null,state:'failed',failure:'network_error'})+'\n';
 const replacement=JSON.stringify({url,method:'GET',checkedAt:now,retrievedAt:null,state:'failed',failure:'not_found'})+'\n';
 const binding:Extract<ManagedSourceBinding,{kind:'retained_publication'}>={kind:'retained_publication',url,sourceSha256:null,publication:{manifestSha256:hash('metadata manifest'),releaseId:'metadata-fixture',memberPath:relativePath,memberSha256:hash(initial),memberBytes:Buffer.byteLength(initial)}};
 await publish(root,{...binding,relativePath,contentSha256:hash(initial),independentAllowed:false},initial,stateDir);
 await compactCivicPolicyInventory(policy);
 const before=await readCivicPolicyInventory(policy),physicalBefore=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));
 assert.equal(before.entries.length,1);assert.equal(before.entries[0].state,'active');
 const segmentPath=join(stateDir,'inventory-segments',physicalBefore.storage.segments[0].sha256+'.json'),segmentBefore=await readFile(segmentPath);
 await writeFile(join(root,relativePath),replacement,{mode:0o600});await markManagedCacheInventoryComplete(root,policy);
 const after=await readCivicPolicyInventory(policy),physicalAfter=JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8'));
 assert.equal(after.roots[0].complete,true);assert.deepEqual(after.entries,[{...before.entries[0],state:'missing'}]);
 assert.equal(physicalAfter.storage.entryStates[before.entries[0].id],'missing');assert.deepEqual(physicalAfter.storage.segments,physicalBefore.storage.segments);assert.deepEqual(await readFile(segmentPath),segmentBefore);
 assert.equal(before.entries[0].state,'active');assert.equal(await readFile(join(root,relativePath),'utf8'),replacement);
 await assert.rejects(assertManagedSourceReadable(join(root,relativePath),policy),{code:'CONTENT_REFERENCE_REVOKED'});
 await writeFile(join(root,relativePath),initial,{mode:0o600});await markManagedCacheInventoryComplete(root,policy);
 assert.equal((await readCivicPolicyInventory(policy)).entries[0].state,'revoked');
 const receipt=await recordHostOptOut({host:'metadata-sealed.test',reason:'municipality_objection'},policy);
 assert.equal(receipt.purge.status,'purged');assert.equal(receipt.purge.deletedFiles,1);assert.deepEqual(await readFile(segmentPath),segmentBefore);
});

test('late scratch finalization cannot reactivate or mutate a sealed terminal lease',async t=>{
 const {base,stateDir}=await sandbox(t),root=join(base,'terminal-scratch'),policy=fixturePolicy(stateDir),bytes=Buffer.from('Synthetic terminal lease source');
 await assert.rejects(withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://terminal-sealed.test/source',sourceSha256:hash(bytes)}],async()=>{
  // Fixture-only state corruption simulates an unexpectedly terminal durable
  // lease while its wrapper is still alive; normal recovery skips terminal leases.
  const path=join(stateDir,'inventory.json'),physical=JSON.parse(await readFile(path,'utf8'));physical.scratch[0].state='purged';
  await writeFile(path,JSON.stringify(physical)+'\n',{mode:0o600});await compactCivicPolicyInventory(policy);
 },{kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',...policy}),{code:'SCRATCH_IDENTITY_MISMATCH'});
 const after=await readCivicPolicyInventory(policy);assert.equal(after.scratch[0].state,'purged');assert.equal(JSON.parse(await readFile(join(stateDir,'inventory.json'),'utf8')).scratch.length,0);
});
