import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {sha256} from '../src/district-schema.ts';
import {retainedPublicationSources} from '../src/district-retained-import.ts';
import {AuthenticatedGitSnapshotImportSchema,gitSnapshotSourcePinSchema,importAuthenticatedGitSnapshot,readAuthenticatedGitSnapshotSourcePin,readAuthenticatedGitSnapshotImportPlan,runAuthenticatedGitSnapshotImportPlan} from '../src/district-git-snapshot-import.ts';
import type {AuthenticatedGitSnapshotImport,AuthenticatedGitSnapshotImportPlan} from '../src/district-git-snapshot-import.ts';
import {assertManagedSourceReadable,assertManagedSourceBindings,recordHostOptOut,HostOptedOutError} from '../src/civic-opt-out.ts';
import {knowledgeSourcePinSchema} from '../src/prepare-knowledge.ts';

const sourceUrl='https://example.org/original',unknownUrl='https://example.net/unobserved',sourceHash=sha256('Synthetic original source bytes, not Git snapshot bytes');
const value={type:'FeatureCollection',features:[{properties:{id:'historical-synthetic',statement:'Synthetic old text: historical comparison only, never a newly admitted claim.',sources:[{url:sourceUrl,sha256:sourceHash},{url:unknownUrl,sha256:null}]}}]};
function objectOid(kind:'commit'|'tree'|'blob',body:Buffer){return createHash('sha1').update(Buffer.from(kind+' '+body.length+'\0')).update(body).digest('hex');}
function treeEntry(mode:string,name:string,oid:string){return Buffer.concat([Buffer.from(mode+' '+name+'\0'),Buffer.from(oid,'hex')]);}
async function fixture(t:TestContext,options:{leafMode?:string;parentMode?:string;duplicateLeaf?:boolean}={}){
 const authority=await createCivicPolicyTestContext(t),objects=join(authority.root,'original-object-bodies');await mkdir(objects,{mode:0o700});
 const blobBytes=Buffer.from(JSON.stringify(value)+'\n'),blobOid=objectOid('blob',blobBytes),blobPath=join(objects,'original-blob.json');await writeFile(blobPath,blobBytes,{mode:0o600});
 const trees:AuthenticatedGitSnapshotImport['trees']=[];
 const store=async(kind:'commit'|'tree',bytes:Buffer)=>{const oid=objectOid(kind,bytes),path=join(objects,kind+'-'+oid+'.bin');await writeFile(path,bytes,{mode:0o600});return {path,oid,sha256:sha256(bytes),bytes:bytes.length};};
 const leaf=treeEntry(options.leafMode??'100644','signals.geojson',blobOid);
 let current=await store('tree',options.duplicateLeaf?Buffer.concat([leaf,leaf]):leaf);trees.push(current);
 for(const name of ['synthetic','cities','out','stadtstack-data']){current=await store('tree',treeEntry(name==='stadtstack-data'?options.parentMode??'40000':'40000',name,current.oid));trees.push(current);}
 const commit=await store('commit',Buffer.from(`tree ${current.oid}\nauthor Synthetic Fixture <fixture@example.test> 0 +0000\ncommitter Synthetic Fixture <fixture@example.test> 0 +0000\n\nSynthetic history authentication test only\n`));
 const input:AuthenticatedGitSnapshotImport={purpose:'historical_change_reconstruction_only',snapshot:{gitCommit:commit.oid,path:'stadtstack-data/out/cities/synthetic/signals.geojson',blobOid,sha256:sha256(blobBytes),bytes:blobBytes.length},commit,trees,blob:{path:blobPath,sha256:sha256(blobBytes),bytes:blobBytes.length},declaredSources:retainedPublicationSources(value),managedRoot:join(authority.root,'historical-baselines'),destinationPath:'cities/synthetic/signals.geojson'};
 return {...authority,input,blobBytes,store};
}

test('authentic commit/tree/blob chain imports exact private baseline without inventing release or source receipts',async t=>{
 const f=await fixture(t),network=t.mock.method(globalThis,'fetch',async()=>{throw Error('Git snapshot import must remain offline');});
 const pin=await importAuthenticatedGitSnapshot(f.input,f.policy);
 assert.equal(pin.sha256,sha256(f.blobBytes));assert.equal(pin.bytes,f.blobBytes.length);assert.deepEqual(pin.snapshot,f.input.snapshot);
 assert.deepEqual(await readAuthenticatedGitSnapshotSourcePin(pin,f.policy),f.blobBytes);
 assert.deepEqual(await readFile(f.input.blob.path),f.blobBytes);
 for(const binding of pin.bindings){
  assert.equal(binding.kind,'authenticated_git_snapshot');assert.equal(binding.purpose,'historical_change_reconstruction_only');assert.equal(binding.independentAllowed,false);
  assert.equal('observationId' in binding,false);assert.equal('receiptSha256' in binding,false);assert.equal('publication' in binding,false);
 }
 assert.equal(pin.bindings.find(binding=>binding.url===sourceUrl)!.sourceSha256,sourceHash);
 assert.equal(pin.bindings.find(binding=>binding.url===unknownUrl)!.sourceSha256,null);
 assert.ok(pin.bindings.every(binding=>binding.sourceSha256!==pin.sha256));
 await assertManagedSourceBindings(pin.path,pin.bindings,{...f.policy,purpose:'historical_change_reconstruction_only'});
 await assert.rejects(assertManagedSourceReadable(pin.path,f.policy));
 assert.equal(knowledgeSourcePinSchema.safeParse({path:pin.path,sha256:pin.sha256,bytes:pin.bytes,bindings:pin.bindings}).success,false,'historical rows cannot enter knowledge admission pins');
 assert.equal(network.mock.callCount(),0);
});

test('commit and object OIDs, exact path tree chain and SHA256 byte pins are independent gates',async t=>{
 for(const failure of ['commit-oid','tree-oid','blob-oid','blob-sha256','blob-length','missing-tree','wrong-path','unrelated-tree','changed-tree'] as const){
  const f=await fixture(t);
  if(failure==='commit-oid'){f.input.commit.oid='f'.repeat(40);f.input.snapshot.gitCommit=f.input.commit.oid;}
  if(failure==='tree-oid')f.input.trees[0].oid='e'.repeat(40);
  if(failure==='blob-oid')f.input.snapshot.blobOid='d'.repeat(40);
  if(failure==='blob-sha256'){f.input.blob.sha256=sha256('different bytes');f.input.snapshot.sha256=f.input.blob.sha256;}
  if(failure==='blob-length'){f.input.blob.bytes++;f.input.snapshot.bytes++;}
  if(failure==='missing-tree')f.input.trees.shift();
  if(failure==='wrong-path')f.input.snapshot.path='stadtstack-data/out/cities/another/signals.geojson';
  if(failure==='unrelated-tree')f.input.trees.push(await f.store('tree',treeEntry('100644','unrelated.json',f.input.snapshot.blobOid)));
  if(failure==='changed-tree'){const path=f.input.trees[0].path,bytes=await readFile(path);bytes[0]^=1;await writeFile(path,bytes);}
  await assert.rejects(importAuthenticatedGitSnapshot(f.input,f.policy),/mismatch|incomplete|not present|unrelated/);
  await assert.rejects(lstat(f.input.managedRoot),{code:'ENOENT'});
 }
});

test('Git paths may traverse only trees and terminate only at an unambiguous regular file',async t=>{
 for(const options of [{leafMode:'120000'},{leafMode:'160000'},{parentMode:'100644'},{duplicateLeaf:true}]){
  const f=await fixture(t,options);await assert.rejects(importAuthenticatedGitSnapshot(f.input,f.policy),/regular file|non-tree|Ambiguous/);
  await assert.rejects(lstat(f.input.managedRoot),{code:'ENOENT'});
 }
 const f=await fixture(t);
 assert.equal(AuthenticatedGitSnapshotImportSchema.safeParse({...f.input,snapshot:{...f.input.snapshot,path:'../signals.geojson'}}).success,false);
 assert.equal(AuthenticatedGitSnapshotImportSchema.safeParse({...f.input,purpose:'claim_admission'}).success,false);
 assert.equal(AuthenticatedGitSnapshotImportSchema.safeParse({...f.input,manifest:{invented:true}}).success,false);
});

test('nullable upstream hashes must match exact historical declarations rather than substituted Git hashes',async t=>{
 for(const failure of ['missing','invented-hash','extra','duplicate'] as const){
  const f=await fixture(t);
  if(failure==='missing')f.input.declaredSources=f.input.declaredSources.filter(source=>source.url!==unknownUrl);
  if(failure==='invented-hash')f.input.declaredSources=f.input.declaredSources.map(source=>source.sourceSha256===null?{...source,sourceSha256:f.input.snapshot.sha256}:source);
  if(failure==='extra')f.input.declaredSources.push({url:'https://example.org/unobserved',sourceSha256:null});
  if(failure==='duplicate')f.input.declaredSources.push({...f.input.declaredSources[0]});
  await assert.rejects(importAuthenticatedGitSnapshot(f.input,f.policy),/source declarations|Duplicate historical/);
  await assert.rejects(lstat(f.input.managedRoot),{code:'ENOENT'});
 }
});

test('current objections gate before any original file read and purge every managed baseline copy',async t=>{
 const blocked=await fixture(t);await recordHostOptOut({host:'example.org',reason:'municipality_objection',reference:'synthetic-git-blocked'},blocked.policy);
 blocked.input.commit.path=join(blocked.root,'nonexistent-proves-early-policy-check');
 await assert.rejects(importAuthenticatedGitSnapshot(blocked.input,blocked.policy),HostOptedOutError);
 await assert.rejects(lstat(blocked.input.managedRoot),{code:'ENOENT'});
 const f=await fixture(t),pin=await importAuthenticatedGitSnapshot(f.input,f.policy);
 const objection=await recordHostOptOut({host:'example.net',reason:'rights_holder_objection',reference:'synthetic-git-purge'},f.policy);
 assert.equal(objection.purge.status,'purged');await assert.rejects(lstat(pin.path),{code:'ENOENT'});
 await assert.rejects(readAuthenticatedGitSnapshotSourcePin(pin,f.policy),HostOptedOutError);
 assert.deepEqual(await readFile(f.input.blob.path),f.blobBytes);
});

test('managed baseline pins and offline plans cannot alter authenticated snapshot provenance',async t=>{
 const f=await fixture(t),{managedRoot,...member}=f.input;
 const plan:AuthenticatedGitSnapshotImportPlan={schemaVersion:'stadtstack-git-snapshot-import-plan-v1',managedRoot,imports:[member]};
 const path=join(f.root,'import-plan.json'),bytes=JSON.stringify(plan)+'\n';await writeFile(path,bytes,{mode:0o600});
 await assert.rejects(readAuthenticatedGitSnapshotImportPlan(path,sha256('wrong plan'),f.policy),/byte binding mismatch/);
 const loaded=await readAuthenticatedGitSnapshotImportPlan(path,sha256(bytes),f.policy),[pin]=await runAuthenticatedGitSnapshotImportPlan(loaded,f.policy);
 assert.deepEqual(await readAuthenticatedGitSnapshotSourcePin(pin,f.policy),f.blobBytes);
 assert.equal(gitSnapshotSourcePinSchema.safeParse({...pin,snapshot:{...pin.snapshot,gitCommit:'f'.repeat(40)}}).success,false);
 const forged=structuredClone(pin);forged.bindings[0].sourceSha256=sha256('invented original source');
 await assert.rejects(readAuthenticatedGitSnapshotSourcePin(forged,f.policy));
 await assert.rejects(runAuthenticatedGitSnapshotImportPlan({...plan,imports:[member,member]},f.policy),/Duplicate historical Git destination/);
});
