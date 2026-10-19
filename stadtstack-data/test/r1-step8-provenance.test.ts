import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rename,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import type {TestContext} from 'node:test';
import {digest,canonicalJson} from '../src/district-adapter-contract.ts';
import {writeManagedSourceArtifact,writePrivateJson,type SourceArtifactBinding} from '../src/district-private-io.ts';
import {assertAuthenticatedPublicationProvenance,authenticatePublicationProvenance} from '../src/district-publication-provenance.ts';
import {recordHostOptOut} from '../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {createWitnessedProvenanceContext,buildProvenanceSupplement,authenticateSupplement,authenticateSealProvenance,type NativeProvenanceWitness,type SupplementEvidence} from '../src/r1-step8-provenance.ts';

const encoded=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
async function fixture(t:TestContext,options:{count?:number;secondKind?:'prepared_source';secondIndependent?:boolean;differentTargetPath?:boolean}={}){
 const context=await createCivicPolicyTestContext(t),sources=[];
 const shared=[Buffer.from('{"records":[]}'),Buffer.from('{"schemaVersion":"synthetic-critical-admissions-v1","admissions":[]}')],targets=shared.map(digest);
 const put=async(path:string,bytes:Buffer,binding:SourceArtifactBinding)=>{const sha256=await writeManagedSourceArtifact(context.managedRoot,path,bytes,[binding],{...context.policy,decisionId:context.decisionId,kind:'artifacts'});return {path,sha256,bytes:bytes.length};};
 for(let index=0;index<(options.count??2);index++){
  const binding:SourceArtifactBinding={kind:index===1&&options.secondKind?'prepared_source':'http_observation',url:'https://source'+index+'.example.org/synthetic',sourceSha256:digest('synthetic original '+index),observationId:'synthetic-'+index+'.json',receiptSha256:digest('synthetic observation '+index),independentAllowed:index===1?options.secondIndependent??true:true};
  const runBytes=encoded({schemaVersion:'explicitly-synthetic-native-provenance-fixture',source:index}),run=await put(join(context.managedRoot,'runs',digest(runBytes)+'.json'),runBytes,binding),inputs=[{...run,bindings:[binding]}];
  for(const bytes of shared){const sha256=digest(bytes),path=join(context.managedRoot,index===1&&options.differentTargetPath?'other-path':'shared',sha256+'.json'),pin=await put(path,bytes,binding);inputs.push({...pin,bindings:[binding]});}
  const inventory={schemaVersion:'stadtstack-private-publication-provenance-v1',inputs},provenance=await put(join(context.managedRoot,'manifests',String(index)+'.json'),encoded(inventory),binding);
  const output=await put(join(context.managedRoot,'outputs',String(index)+'.json'),encoded({runId:run.sha256,privateProvenance:{...provenance,bindings:[binding]},artifacts:{extractionRun:{path:run.path,sha256:run.sha256}}}),binding);
  sources.push({output,provenance,inventory,binding});
 }
 const native=sources[0],witnesses:NativeProvenanceWitness[]=sources.slice(1).map(source=>({output:source.output,provenance:source.provenance})),inputs:SupplementEvidence={nativeOutput:native.output,nativeProvenance:native.provenance,witnesses,targets};
 const save=async(bytes:Buffer,name='supplement.json')=>{const path=join(context.root,'operator-controls',name),sha256=await writePrivateJson(path,JSON.parse(bytes.toString('utf8')));return {path,sha256,bytes:bytes.length};};
 return {context,sources,native,witnesses,inputs,targets,save};
}

test('witnessed native union preserves deterministic prototype bytes and unchanged Core exact binding checks',async t=>{
 const f=await fixture(t),before=await readFile(join(f.context.policy.stateDir!,'inventory.json'));
 await assert.rejects(authenticatePublicationProvenance(f.native.provenance.path,f.native.provenance.sha256,f.context.policy),{code:'CONTENT_PROVENANCE_MISMATCH'});
 const context=await createWitnessedProvenanceContext(f.witnesses,f.context.policy),built=await buildProvenanceSupplement(f.inputs,f.context.policy,context);
 const expected=structuredClone(f.native.inventory);
 for(const pin of expected.inputs.filter(pin=>f.targets.includes(pin.sha256))){const bindings=new Map(pin.bindings.map(binding=>[canonicalJson(binding),binding]));for(const witness of f.sources.slice(1))for(const other of witness.inventory.inputs)if(other.sha256===pin.sha256)for(const binding of other.bindings)bindings.set(canonicalJson(binding),binding);pin.bindings=[...bindings].sort(([a],[b])=>a.localeCompare(b)).map(([,binding])=>binding);}
 assert.deepEqual(built.bytes,encoded(expected));assert.equal(built.sha256,digest(built.bytes));
 const pin=await f.save(built.bytes),reader=await authenticateSupplement(f.inputs,pin,f.context.policy,context);
 assert.doesNotThrow(()=>assertAuthenticatedPublicationProvenance(reader));
 for(const input of built.inventory.inputs)assert.equal(digest(await reader.read(input.path)),input.sha256);
 const selected=await authenticateSealProvenance(f.native.output,{...pin,targets:f.targets},f.context.policy,context);assert.equal(selected.originalProvenance.sha256,f.native.provenance.sha256);
 await assert.rejects(authenticateSealProvenance(f.native.output,undefined,f.context.policy,context),{code:'CONTENT_PROVENANCE_MISMATCH'});
 await context.finish();assert.deepEqual(await readFile(join(f.context.policy.stateDir!,'inventory.json')),before);
 assert.deepEqual(JSON.parse((await readFile(f.native.provenance.path)).toString('utf8')),f.native.inventory,'native proof remains untouched');
 await assert.rejects(buildProvenanceSupplement(f.inputs,f.context.policy,context),/finished/);
});

test('unwitnessed additions, dropped contributors and changed non-target metadata cannot authenticate',async t=>{
 const f=await fixture(t),built=await buildProvenanceSupplement(f.inputs,f.context.policy);
 for(const [name,mutate] of [
  ['drop',(value:typeof built.inventory)=>{value.inputs.find(pin=>f.targets.includes(pin.sha256))!.bindings.pop();}],
  ['invent',(value:typeof built.inventory)=>{const pin=value.inputs.find(pin=>f.targets.includes(pin.sha256))!;pin.bindings.push({...pin.bindings[0],url:'https://invented.example.org/'});}],
  ['non-target',(value:typeof built.inventory)=>{value.inputs[0].bytes++;}],
 ] as const){const value=structuredClone(built.inventory);mutate(value);const pin=await f.save(encoded(value),name+'.json');await assert.rejects(authenticateSupplement(f.inputs,pin,f.context.policy),/differs from independently witnessed/);}
});

test('missing native witnesses remain a failure of unchanged Core, not a synthesized binding union',async t=>{
 const f=await fixture(t,{count:3}),inputs={...f.inputs,witnesses:f.witnesses.slice(0,1)},built=await buildProvenanceSupplement(inputs,f.context.policy),pin=await f.save(built.bytes);
 await assert.rejects(authenticateSupplement(inputs,pin,f.context.policy),{code:'CONTENT_PROVENANCE_MISMATCH'});
});

test('supplements reject absent, duplicate and nongrowing targets',async t=>{
 const f=await fixture(t);
 await assert.rejects(buildProvenanceSupplement({...f.inputs,targets:['f'.repeat(64)]},f.context.policy),/target absent/);
 await assert.rejects(buildProvenanceSupplement({...f.inputs,targets:[f.targets[0],f.targets[0]]},f.context.policy),/Duplicate/);
 await assert.rejects(buildProvenanceSupplement({...f.inputs,witnesses:[]},f.context.policy),/No independent supplemental/);
});

for(const [name,options,reason] of [
 ['another content-identical path',{differentTargetPath:true},/path or byte-size differs/],
 ['prepared bindings',{secondKind:'prepared_source' as const},/actual native HTTP/],
 ['changed independent permission',{secondIndependent:false},/actual native HTTP/],
] as const)test('witness union rejects '+name,async t=>{const f=await fixture(t,options);await assert.rejects(buildProvenanceSupplement(f.inputs,f.context.policy),reason);});

test('witness native-output/provenance pins and native extraction-run identity are inseparable',async t=>{
 const f=await fixture(t);
 await assert.rejects(createWitnessedProvenanceContext([{output:f.witnesses[0].output,provenance:f.native.provenance}],f.context.policy),/changes independently pinned/);
 await assert.rejects(createWitnessedProvenanceContext([...f.witnesses,...f.witnesses],f.context.policy),/Duplicate native/);
});

test('cached witness authorization fails closed on a changed immutable file',async t=>{
 const f=await fixture(t),context=await createWitnessedProvenanceContext(f.witnesses,f.context.policy);
 await writeFile(f.witnesses[0].output.path,Buffer.concat([await readFile(f.witnesses[0].output.path),Buffer.from('\n')]),{mode:0o600});
 await assert.rejects(buildProvenanceSupplement(f.inputs,f.context.policy,context),/witness changed/);
 await assert.rejects(context.finish(),/witness changed/);
});

test('cached witness authorization rejects a parent alias even when file identity is unchanged',async t=>{
 const f=await fixture(t),context=await createWitnessedProvenanceContext(f.witnesses,f.context.policy),parent=dirname(f.witnesses[0].output.path),moved=parent+'-moved';
 await rename(parent,moved);await symlink(moved,parent);
 await assert.rejects(buildProvenanceSupplement(f.inputs,f.context.policy,context),/witness changed/);
 await assert.rejects(context.finish(),/witness changed/);
});

test('cached witness authorization fails closed on a changed inventory epoch',async t=>{
 const f=await fixture(t),context=await createWitnessedProvenanceContext(f.witnesses,f.context.policy);
 await writeManagedSourceArtifact(f.context.managedRoot,join(f.context.managedRoot,'later.json'),'{}',[f.native.binding],{...f.context.policy,decisionId:f.context.decisionId,kind:'artifacts'});
 await assert.rejects(buildProvenanceSupplement(f.inputs,f.context.policy,context),/inventory epoch changed/);
 await assert.rejects(context.finish(),/inventory epoch changed/);
});

test('genuine Core capability keeps live revocation veto after supplement authentication',async t=>{
 const f=await fixture(t),built=await buildProvenanceSupplement(f.inputs,f.context.policy),pin=await f.save(built.bytes),reader=await authenticateSupplement(f.inputs,pin,f.context.policy);
 await recordHostOptOut({host:'source0.example.org',reason:'rights_holder_objection'},f.context.policy);
 await assert.rejects(reader.read(built.inventory.inputs[1].path));
});
