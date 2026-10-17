import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,lstat,rename,symlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {dataReleaseId,type DataRelease} from '../src/data-release.ts';
import {sha256} from '../src/district-schema.ts';
import {assertManagedSourceReadable,CIVIC_ACQUISITION_DECISION_ID,HostOptedOutError,recordHostOptOut} from '../src/civic-opt-out.ts';
import {writeManagedSourceArtifact} from '../src/district-private-io.ts';
import {importRetainedPublicationMember,readAuthenticatedRetainedPublicationMember,retainedPublicationSources,readRetainedPublicationImportPlan,runRetainedPublicationImportPlan,RetainedPublicationImportSchema,type RetainedPublicationImport,type RetainedPublicationImportPlan} from '../src/district-retained-import.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';

const sourceUrl='https://example.org/municipal-source',supportUrl='https://example.net/support',licenceUrl='https://creativecommons.org/licenses/by/4.0/';
const firstHash=sha256('Synthetic original source representation one'),secondHash=sha256('Synthetic original source representation two');
const original={type:'FeatureCollection',features:[{properties:{id:'synthetic-record',statement:'Synthetic retained publication only; not an actual municipal claim.',sources:[{url:sourceUrl,sha256:firstHash},{url:sourceUrl,sha256:secondHash},{url:supportUrl,sha256:null}],licenceUrl}}]};
async function fixture(t:TestContext,value:unknown=original){
 const authority=await createCivicPolicyTestContext(t),publicationRoot=join(authority.root,'retained-release'),managedRoot=join(authority.root,'managed-publication');
 const memberPath='cities/example/signals.geojson',memberBytes=Buffer.from(JSON.stringify(value)+'\n'),member={path:memberPath,sha256:sha256(memberBytes),bytes:memberBytes.length};
 const manifest:DataRelease={schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId([member]),generatedAt:'2026-10-10T12:00:00.000Z',files:[member],quality:{publishedRecords:1,quarantinedRecords:0,cities:1}};
 const manifestBytes=Buffer.from(JSON.stringify(manifest)+'\n'),memberFile=join(publicationRoot,memberPath),manifestFile=join(publicationRoot,'release-manifest.json');
 await mkdir(dirname(memberFile),{recursive:true,mode:0o700});await writeFile(memberFile,memberBytes,{mode:0o600});await writeFile(manifestFile,manifestBytes,{mode:0o600});
 const input:RetainedPublicationImport={publicationRoot,manifestSha256:sha256(manifestBytes),releaseId:manifest.id,memberPath,declaredSources:retainedPublicationSources(value),managedRoot,destinationPath:'cities/example/signals.geojson'};
 return {...authority,input,manifest,manifestBytes,memberBytes,memberFile,manifestFile};
}

test('pinned older release members import exact bytes with truthful nullable publication provenance',async t=>{
 const f=await fixture(t),{managedRoot,destinationPath,...member}=f.input;
 const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('Retained import must not acquire sources');});
 const authenticated=await readAuthenticatedRetainedPublicationMember(member,f.policy);
 // A historical one-member manifest is valid here; current release-required files are not imposed.
 assert.deepEqual(authenticated.bytes,f.memberBytes);assert.equal(f.manifest.files.length,1);
 assert.deepEqual(f.input.declaredSources,[
  {url:licenceUrl,sourceSha256:null},{url:supportUrl,sourceSha256:null},
  ...[firstHash,secondHash].sort().map(sourceSha256=>({url:sourceUrl,sourceSha256})),
 ].sort((a,b)=>JSON.stringify([a.url,a.sourceSha256]).localeCompare(JSON.stringify([b.url,b.sourceSha256]),'en')));
 const receipt=await importRetainedPublicationMember(f.input,f.policy);
 assert.equal(receipt.path,join(managedRoot,destinationPath));assert.equal(receipt.sha256,sha256(f.memberBytes));assert.equal(receipt.bytes,f.memberBytes.length);
 assert.deepEqual(await readFile(receipt.path),f.memberBytes);await assertManagedSourceReadable(receipt.path,f.policy);
 assert.deepEqual(receipt.bindings,authenticated.bindings);
 for(const binding of receipt.bindings){
  assert.equal(binding.kind,'retained_publication');assert.equal(binding.independentAllowed,false);
  assert.equal('observationId' in binding,false);assert.equal('receiptSha256' in binding,false);
  assert.deepEqual(binding.publication,{manifestSha256:f.input.manifestSha256,releaseId:f.manifest.id,memberPath:f.input.memberPath,memberSha256:sha256(f.memberBytes),memberBytes:f.memberBytes.length});
 }
 assert.equal(receipt.bindings.find(binding=>binding.url===supportUrl)!.sourceSha256,null);
 assert.ok(receipt.bindings.every(binding=>binding.sourceSha256!==receipt.sha256&&binding.sourceSha256!==f.input.manifestSha256));
 const inventory=JSON.parse(await readFile(join(f.policy.stateDir!,'inventory.json'),'utf8'));
 for(const entry of inventory.entries){assert.equal(entry.kind,'retained_publication');assert.equal(entry.independentAllowed,false);assert.equal(entry.observationId,undefined);assert.equal(entry.receiptSha256,undefined);}
 assert.deepEqual(await readFile(f.memberFile),f.memberBytes);assert.deepEqual(await readFile(f.manifestFile),f.manifestBytes);assert.equal(network.mock.callCount(),0);
});

test('manifest byte pin release identity duplicate membership and member byte pins are independent gates',async t=>{
 for(const failure of ['manifest-pin','manifest-reformatted','release-id','forged-manifest-id','duplicate-member','member-pin','member-size','unbound-member'] as const){
  const f=await fixture(t);
  if(failure==='manifest-pin')f.input.manifestSha256=sha256('wrong pin');
  if(failure==='manifest-reformatted')await writeFile(f.manifestFile,JSON.stringify(f.manifest,null,2));
  if(failure==='release-id')f.input.releaseId=sha256('wrong release identity');
  if(failure==='member-pin'){const changed=Buffer.from(f.memberBytes);changed[0]^=1;await writeFile(f.memberFile,changed);}
  if(failure==='unbound-member')f.input.memberPath='cities/other/signals.geojson';
  if(failure==='duplicate-member'||failure==='member-size'||failure==='forged-manifest-id'){
   if(failure==='duplicate-member')f.manifest.files.push({...f.manifest.files[0]});else if(failure==='member-size')f.manifest.files[0].bytes++;
   f.manifest.id=failure==='forged-manifest-id'?sha256('forged manifest identity'):dataReleaseId(f.manifest.files);f.input.releaseId=f.manifest.id;
   const bytes=Buffer.from(JSON.stringify(f.manifest));f.input.manifestSha256=sha256(bytes);await writeFile(f.manifestFile,bytes);
  }
  await assert.rejects(importRetainedPublicationMember(f.input,f.policy),/pin mismatch|identity mismatch|duplicate members|not manifest-bound/);
  await assert.rejects(lstat(f.input.managedRoot),{code:'ENOENT'});
 }
});

test('declarations cover each exact URL and original hash tuple including unobserved attribution',async t=>{
 for(const failure of ['missing-url','same-host-other-url','missing-observation','invented-member-hash','invented-source-hash','duplicate-declaration'] as const){
  const f=await fixture(t);
  if(failure==='missing-url')f.input.declaredSources=f.input.declaredSources.filter(source=>source.url!==licenceUrl);
  if(failure==='same-host-other-url')f.input.declaredSources=f.input.declaredSources.map(source=>source.url===supportUrl?{...source,url:'https://example.net/other'}:source);
  if(failure==='missing-observation')f.input.declaredSources=f.input.declaredSources.filter(source=>source.sourceSha256!==secondHash);
  if(failure==='invented-member-hash')f.input.declaredSources=f.input.declaredSources.map(source=>source.sourceSha256===null?{...source,sourceSha256:sha256(f.memberBytes)}:source);
  if(failure==='invented-source-hash')f.input.declaredSources=f.input.declaredSources.map(source=>source.sourceSha256===firstHash?{...source,sourceSha256:sha256('fabricated source hash')}:source);
  if(failure==='duplicate-declaration')f.input.declaredSources.push({...f.input.declaredSources[0]});
  await assert.rejects(importRetainedPublicationMember(f.input,f.policy),/source provenance|Duplicate retained source declaration/);
  await assert.rejects(lstat(f.input.managedRoot),{code:'ENOENT'});
 }
 const f=await fixture(t);
 assert.equal(RetainedPublicationImportSchema.safeParse({...f.input,independentAllowed:true}).success,false);
 assert.equal(RetainedPublicationImportSchema.safeParse({...f.input,observationId:'invented-http-observation'}).success,false);
});

test('inventory preserves snapshot URLs nested source receipts and hash-bound embedded JSON without guessing raw hashes',()=>{
 const embedded=JSON.stringify({sources:[{url:sourceUrl,sha256:null}],attribution:licenceUrl});
 const value={sources:[{url:sourceUrl,snapshotUrl:supportUrl,sha256:firstHash}],origin:{sourceUrl:'https://example.org/origin',sourceSha256:secondHash},archive:{bytes:embedded,sha256:sha256(embedded)},['https://example.net/keyed-source']:'citation',statement:'See https://example.net/embedded for attribution',id:'council:'+encodeURIComponent('https://example.org/encoded-id')};
 const sources=retainedPublicationSources(value);
 for(const expected of [
  {url:sourceUrl,sourceSha256:firstHash},{url:sourceUrl,sourceSha256:null},{url:supportUrl,sourceSha256:firstHash},
  {url:'https://example.org/origin',sourceSha256:secondHash},{url:licenceUrl,sourceSha256:null},{url:'https://example.net/keyed-source',sourceSha256:null},
  {url:'https://example.net/embedded',sourceSha256:null},{url:'https://example.org/encoded-id',sourceSha256:null},
 ])assert.ok(sources.some(source=>source.url===expected.url&&source.sourceSha256===expected.sourceSha256));
 assert.equal(sources.length,8);
 assert.throws(()=>retainedPublicationSources({archive:{bytes:embedded,sha256:sha256('different')}}),/inventory invalid/);
 assert.throws(()=>retainedPublicationSources({source:{url:sourceUrl,sha256:'not-a-hash'}}),/source provenance invalid/);
 assert.throws(()=>retainedPublicationSources({url:'https://user:password@example.org/source'}),/inventory invalid/);
});

test('current objections gate before retained reads and after import purge every non-independent derived copy',async t=>{
 const blocked=await fixture(t);await recordHostOptOut({host:new URL(sourceUrl).hostname,reason:'municipality_objection'},blocked.policy);
 blocked.input.publicationRoot=join(blocked.root,'missing-original-proves-pre-read-gate');
 await assert.rejects(importRetainedPublicationMember(blocked.input,blocked.policy),HostOptedOutError);
 const {managedRoot:_root,destinationPath:_path,...blockedMember}=blocked.input;
 await assert.rejects(readAuthenticatedRetainedPublicationMember(blockedMember,blocked.policy),HostOptedOutError);
 await assert.rejects(lstat(blocked.input.managedRoot),{code:'ENOENT'});
 const f=await fixture(t),receipt=await importRetainedPublicationMember(f.input,f.policy),derived=join(f.input.managedRoot,'derived/summary.json');
 await writeManagedSourceArtifact(f.input.managedRoot,derived,JSON.stringify({summary:'Synthetic derived content'}),receipt.bindings,{...f.policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 await assertManagedSourceReadable(derived,f.policy);
 const objection=await recordHostOptOut({host:new URL(sourceUrl).hostname,reason:'rights_holder_objection'},f.policy);
 assert.equal(objection.purge.status,'purged');assert.equal(objection.purge.deletedFiles,2);
 for(const path of [receipt.path,derived]){await assert.rejects(lstat(path),{code:'ENOENT'});await assert.rejects(assertManagedSourceReadable(path,f.policy));}
 await assert.rejects(importRetainedPublicationMember(f.input,f.policy),HostOptedOutError);
 assert.deepEqual(await readFile(f.memberFile),f.memberBytes);assert.deepEqual(await readFile(f.manifestFile),f.manifestBytes);
});

test('retained and destination paths cannot escape or auto-adopt an existing unmarked root',async t=>{
 const overlap=await fixture(t);overlap.input.managedRoot=overlap.input.publicationRoot;
 await assert.rejects(importRetainedPublicationMember(overlap.input,overlap.policy),/must not overlap/);
 const alias=await fixture(t),saved=join(alias.input.publicationRoot,'saved-cities');
 await rename(join(alias.input.publicationRoot,'cities'),saved);await symlink(saved,join(alias.input.publicationRoot,'cities'));
 await assert.rejects(importRetainedPublicationMember(alias.input,alias.policy),/directory alias rejected/);
 const unmarked=await fixture(t);await mkdir(unmarked.input.managedRoot,{mode:0o700});const legacy=join(unmarked.input.managedRoot,'legacy.json');await writeFile(legacy,'{"retained":"unrelated"}',{mode:0o600});
 await assert.rejects(importRetainedPublicationMember(unmarked.input,unmarked.policy));assert.equal(await readFile(legacy,'utf8'),'{"retained":"unrelated"}');
 await assert.rejects(lstat(join(unmarked.input.managedRoot,'.civic-acquisition-lane.json')),{code:'ENOENT'});
 assert.equal(RetainedPublicationImportSchema.safeParse({...unmarked.input,destinationPath:'../escape.json'}).success,false);
 assert.equal(RetainedPublicationImportSchema.safeParse({...unmarked.input,memberPath:'../outside.json'}).success,false);
});

test('batch collection requires an exact plan pin explicit destinations and complete independent member authentication',async t=>{
 const f=await fixture(t),{managedRoot,...item}=f.input;
 const plan:RetainedPublicationImportPlan={schemaVersion:'stadtstack-retained-import-plan-v1',managedRoot,imports:[item,{...item,destinationPath:'previous/cities/example/signals.geojson'}]};
 const planFile=join(f.root,'import-plan.json'),bytes=JSON.stringify(plan)+'\n';await writeFile(planFile,bytes,{mode:0o600});
 await assert.rejects(readRetainedPublicationImportPlan(planFile,sha256('wrong plan'),f.policy),/byte binding mismatch/);
 const loaded=await readRetainedPublicationImportPlan(planFile,sha256(bytes),f.policy);assert.deepEqual(loaded,plan);
 const receipts=await runRetainedPublicationImportPlan(loaded,f.policy);assert.equal(receipts.length,2);assert.deepEqual(receipts[0].bindings,receipts[1].bindings);
 for(const receipt of receipts)assert.deepEqual(await readFile(receipt.path),f.memberBytes);
 await assert.rejects(runRetainedPublicationImportPlan({...plan,imports:[item,item]},f.policy),/Duplicate retained import destination/);
});

test('authenticated content-free historical metadata stays readable but cannot invent a source enrollment',async t=>{
 const f=await fixture(t,{schemaVersion:'synthetic-metadata',count:1}),{managedRoot:_root,destinationPath:_path,...member}=f.input;
 const read=await readAuthenticatedRetainedPublicationMember(member,f.policy);assert.deepEqual(read.bindings,[]);
 await assert.rejects(importRetainedPublicationMember(f.input,f.policy),/no source provenance to enroll/);
 await assert.rejects(lstat(f.input.managedRoot),{code:'ENOENT'});
});
