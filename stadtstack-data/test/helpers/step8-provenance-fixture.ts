import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import type {Pool} from 'pg';
import {join,dirname} from 'node:path';
import {readFile,writeFile,rename,symlink} from 'node:fs/promises';
import {digest,canonicalJson} from '../../src/district-adapter-contract.ts';
import {writeManagedSourceArtifact,writePrivateJson,type SourceArtifactBinding} from '../../src/district-private-io.ts';
import {authenticatePublicationProvenance,assertAuthenticatedPublicationProvenance,privatePublicationProvenanceSchema} from '../../src/district-publication-provenance.ts';
import type {CivicPolicyOptions} from '../../src/civic-opt-out.ts';
import type {DistrictCas} from '../../src/district-cas.ts';
import type {sealQueueTextContribution} from '../../src/district-queue-text-run.ts';
import {createWitnessedProvenanceContext,assertCanonicalSealSelection,buildProvenanceSupplement,authenticateSupplement,authenticateSealProvenance,authenticateCanonicalSealProvenance,exportCanonicalTextContribution,type NativeProvenancePin} from '../../src/r1-step8-provenance.ts';
import {loadR1TextCompositionInput} from '../../src/district-r1-text-composition.ts';

type Control=(name:string,value:unknown)=>Promise<{path:string;sha256:string}>;
export async function issueFixtureNativeSelection<T extends {catalogue:NativeProvenancePin}>(control:Control,frame:T,name='native-selection'){
 const selection=await control(name+'-frame.json',frame),catalogue=frame.catalogue;
 const evidence=await control(name+'-evidence.json',{kind:'explicit isolated-fixture selection',selection}),collector=await control(name+'-collector.json',{kind:'isolated-fixture selection helper',implementationSha256:digest(await readFile(new URL(import.meta.url)))});
 return control(name+'-issued.json',{schemaVersion:'stadtstack-r1-operator-action-record-v1',id:name,action:'select-governed-native-seals',issuedBy:'isolated test fixture owner',issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),parentApproval:{id:'synthetic fixture approval',sha256:digest('synthetic fixture approval')},catalogue,selection,evidence,collector,rule:{generationPrecedenceNewestFirst:['a'.repeat(40)],withinGeneration:'latest successful closed finishedAt; ties refuse',publishedSourcesExcluded:[],candidateSource:null,order:'sourceId ascending'},bounds:{maxFreshSeals:0,maxCoreCommands:0,maxModelCalls:0,maxExecutorRuns:0,paidMicroUsd:0},reason:'Synthetic fixture authorization only; canonical DB receipt and producer reconstruction remains mandatory'});
}
type Native={scope:{municipalityId:string;sourceId:string};document:{id:string;sha256:string};queue:unknown;sealed:Awaited<ReturnType<typeof sealQueueTextContribution>>};
export async function exerciseCanonicalProvenance(t:TestContext,input:{pool:Pool;cas:DistrictCas;policy:CivicPolicyOptions;root:string;base:Native;witnesses:Native[];canonicalBuildCount:()=>number}){
 const {pool,cas,policy}=input,root=join(input.root,'canonical-provenance-controls'),native=[input.base,...input.witnesses];
 const control:Control=async(name,value)=>{const path=join(root,name),sha256=await writePrivateJson(path,value);return {path,sha256};};
 const catalogue=await control('catalogue.json',{rows:native.map(source=>({scope:source.scope,index:source.sealed.artifacts.crawl,originals:[{documentId:source.document.id,sha256:source.document.sha256}]}))});
 const entries=await Promise.all(native.map(async(source,index)=>({municipalityId:source.scope.municipalityId,sourceId:source.scope.sourceId,corpus:source.sealed.artifacts.crawl,output:await control('native/'+index+'/seal.json',source.sealed),admission:'published',queue:source.queue})));
 const frame={schemaVersion:'stadtstack-r1-native-seal-selection-v1',catalogue,seals:entries},issued=await issueFixtureNativeSelection(control,frame),withoutNoop=await issueFixtureNativeSelection(control,{...frame,seals:entries.slice(0,2)},'without-noop');
 const changedAncillary={...native[0].sealed,criticalInventory:{...native[0].sealed.criticalInventory,sha256:'f'.repeat(64)}},forgedOutput=await control('forged-seal.json',changedAncillary),forged=await issueFixtureNativeSelection(control,{...frame,seals:[{...entries[0],output:forgedOutput},...entries.slice(1)]},'forged-ancillary');
 const copiedOutput=await control('copied-seal.json',native[0].sealed),aliased=await issueFixtureNativeSelection(control,{...frame,seals:[{...entries[0],output:copiedOutput},...entries.slice(1)]},'copied-output');
 const options={pool,casRoot:cas.root,catalogue,mode:'step8' as const,workers:1,timing:{estimatedDurationSeconds:600,expiryMarginSeconds:60}},targets=[native[0].sealed.criticalInventory.sha256,native[0].sealed.criticalAdmissions.sha256],evidence={nativeOutput:entries[0].output,nativeProvenance:{path:native[0].sealed.privateProvenance.path,sha256:native[0].sealed.privateProvenance.sha256,bytes:native[0].sealed.privateProvenance.bytes},targets};
 await assert.rejects(authenticatePublicationProvenance(evidence.nativeProvenance.path,evidence.nativeProvenance.sha256,policy),{code:'CONTENT_PROVENANCE_MISMATCH'});
 const beforeExpiryPreflight=input.canonicalBuildCount();
 await assert.rejects(createWitnessedProvenanceContext(issued,policy,{...options,timing:{estimatedDurationSeconds:7*86400,expiryMarginSeconds:60}}),/policy .*expires .*required through/);
 assert.equal(input.canonicalBuildCount(),beforeExpiryPreflight,'insufficient pinned proof lifetime refuses before any canonical producer reconstruction');
 await assert.rejects(createWitnessedProvenanceContext(forged,policy,options),/criticalInventory differs from canonical producer/,'a real canonical6-artifact run does not authenticate fabricated ancillary roles');
 const context=await createWitnessedProvenanceContext(issued,policy,options);
 let built:Awaited<ReturnType<typeof buildProvenanceSupplement>>;
 try{
  await assertCanonicalSealSelection(context,entries.map(entry=>({output:entry.output,queue:entry.queue})));
  await assert.rejects(assertCanonicalSealSelection(context,entries.slice(0,2).map(entry=>({output:entry.output,queue:entry.queue}))),/witness set differs/);
  await assert.rejects(assertCanonicalSealSelection(context,[...entries].reverse().map(entry=>({output:entry.output,queue:entry.queue}))),/identity or order differs/);
  await assert.rejects(authenticateSealProvenance(copiedOutput,undefined,policy,context),/not in the exact governed/);
  built=await buildProvenanceSupplement(evidence,policy,context);
  const expectedAttestation=built.attestationSha256,witness=built.attestation.witnesses[0];
  assert.ok(witness&&typeof witness==='object'&&'sourceId' in witness);witness.sourceId='caller-mutation';
  built.attestation.issuance.sha256='f'.repeat(64);built.attestation.selection.sha256='f'.repeat(64);built.attestation.nativeOutput.path='/synthetic/caller-alias';built.attestation.nativeProvenance.sha256='f'.repeat(64);
  built=await buildProvenanceSupplement(evidence,policy,context);
  assert.equal(built.attestationSha256,expectedAttestation,'returned attestation metadata cannot mutate the cached canonical identity set');
  await assert.rejects(buildProvenanceSupplement({...evidence,targets:[...targets,targets[0]]},policy,context),/Duplicate/);
  const automatic=await authenticateCanonicalSealProvenance(entries[0].output,undefined,policy,context);assert.ok(automatic.generatedSupplement);assert.doesNotThrow(()=>assertAuthenticatedPublicationProvenance(automatic.reader));
  for(const pin of automatic.inventory.inputs)assert.equal(digest(await automatic.reader.read(pin.path)),pin.sha256);
  const contribution=(await loadR1TextCompositionInput(JSON.parse((await automatic.reader.read(native[0].sealed.path)).toString('utf8')),pin=>automatic.reader.read(pin.path))).contributions[0];
  const exported=await exportCanonicalTextContribution(context,entries[0].output,[],contribution),expectedRun=exported.contribution.runId;
  exported.contribution.pins.corpusSha256='f'.repeat(64);const mutated=Buffer.from(exported.contribution.artifacts.extractionRun.bytes);mutated[0]^=1;exported.contribution.artifacts.extractionRun.bytes=mutated;
  assert.equal((await exportCanonicalTextContribution(context,entries[0].output,[],contribution)).contribution.runId,expectedRun,'caller mutations never alter the private canonical result');
  const changed=structuredClone(contribution),changedBytes=Buffer.from(changed.artifacts.extractionRun.bytes);changedBytes[0]^=1;changed.artifacts.extractionRun.bytes=changedBytes;
  await assert.rejects(exportCanonicalTextContribution(context,entries[0].output,[],changed),/artifact bytes differ/);
  await assert.rejects(exportCanonicalTextContribution(context,entries[0].output,['f'.repeat(64)],contribution),/extraction selection differs/);
  await assert.rejects(buildProvenanceSupplement({...evidence,targets:['f'.repeat(64)]},policy,context),/target absent/);
 }finally{await context.finish();}
 const inventory=await control('supplement-inventory.json',built!.inventory),attestation=await control('supplement-attestation.json',built!.attestation),supplement={inventory,attestation};
 assert.equal(digest(await readFile(inventory.path)),built!.sha256);assert.equal(digest(await readFile(attestation.path)),built!.attestationSha256);
 const beforeInventory=await readFile(join(policy.stateDir!,'inventory.json')),counts=async()=>(await pool.query('SELECT (SELECT count(*) FROM district_pipeline.jobs) AS jobs,(SELECT count(*) FROM district_pipeline.step_receipts) AS receipts,(SELECT count(*) FROM district_pipeline.artifacts) AS artifacts')).rows,beforeCounts=await counts();
 const authenticated=await createWitnessedProvenanceContext(issued,policy,options);
 try{const reader=await authenticateSupplement(evidence,supplement,policy,authenticated);assert.doesNotThrow(()=>assertAuthenticatedPublicationProvenance(reader));for(const pin of built!.inventory.inputs)assert.equal(digest(await reader.read(pin.path)),pin.sha256);const selected=await authenticateSealProvenance(evidence.nativeOutput,{...supplement,targets},policy,authenticated);assert.equal(selected.originalProvenance.sha256,evidence.nativeProvenance.sha256);selected.originalProvenance.sha256='f'.repeat(64);assert.equal((await authenticateSealProvenance(evidence.nativeOutput,{...supplement,targets},policy,authenticated)).originalProvenance.sha256,evidence.nativeProvenance.sha256,'supplemented return pin is not mutable cached authority');}finally{await authenticated.finish();}
 assert.deepEqual(await readFile(join(policy.stateDir!,'inventory.json')),beforeInventory);assert.deepEqual(await counts(),beforeCounts);
 for(const alternative of [withoutNoop,aliased]){
  const different=await createWitnessedProvenanceContext(alternative,policy,options);
  try{const inputEvidence=alternative===aliased?{...evidence,nativeOutput:copiedOutput}:evidence;const other=await buildProvenanceSupplement(inputEvidence,policy,different);assert.deepEqual(other.bytes,built!.bytes,'no-op witness/alias leaves binding union unchanged');assert.notEqual(other.attestationSha256,built!.attestationSha256);await assert.rejects(authenticateSupplement(inputEvidence,supplement,policy,different),/exact governed canonical witness set/);}finally{await different.finish();}
 }
 // These two genuine pre-model terminal sources require no inherited model or
 // parser mocks in child processes. Each child reconstructs from real PG/CAS.
 const parallelCatalogue=await control('parallel-catalogue.json',{rows:input.witnesses.map(source=>({scope:source.scope,index:source.sealed.artifacts.crawl,originals:[{documentId:source.document.id,sha256:source.document.sha256}]}))}),parallelFrame={...frame,catalogue:parallelCatalogue,seals:entries.slice(1)},parallelSelection=await issueFixtureNativeSelection(control,parallelFrame,'parallel');
 for(const workers of [2,3]){
  const parallel=await createWitnessedProvenanceContext(parallelSelection,policy,{...options,catalogue:parallelCatalogue,workers});
  try{assert.equal(parallel.reconstructionWorkers,workers);await assertCanonicalSealSelection(parallel,parallelFrame.seals.map(entry=>({output:entry.output,queue:entry.queue})));await parallel.checkpoint();}
  finally{await parallel.finish();}
 }
 const badParallel=await issueFixtureNativeSelection(control,{...parallelFrame,seals:parallelFrame.seals.map((entry,index)=>index?entry:{...entry,output:forgedOutput})},'parallel-bad-source');
 await assert.rejects(createWitnessedProvenanceContext(badParallel,policy,{...options,catalogue:parallelCatalogue,workers:2}),/differs from canonical|canonical source scope/,'one worker failure rejects the entire result batch');
 assert.deepEqual(await readFile(join(policy.stateDir!,'inventory.json')),beforeInventory);assert.deepEqual(await counts(),beforeCounts);
 const cached=await createWitnessedProvenanceContext(issued,policy,options),path=entries[2].output.path,parent=dirname(path),moved=parent+'-moved';
 await rename(parent,moved);await symlink(moved,parent);
 await assert.rejects(buildProvenanceSupplement(evidence,policy,cached),/witness changed/);await assert.rejects(cached.finish(),/witness changed/);
 // This is an isolated test-only managed write, after every positive fence.
 const epoch=await createWitnessedProvenanceContext(withoutNoop,policy,options),first=privatePublicationProvenanceSchema.parse(JSON.parse((await cas.read(input.base.sealed.privateProvenance.sha256)).toString('utf8'))).inputs[0].bindings[0] as SourceArtifactBinding;
 await writeManagedSourceArtifact(cas.root,join(cas.root,'canonical-epoch-change.json'),Buffer.from('{}'),[first],{...policy,decisionId:'owner-2026-10-11-public-civic-sources',kind:'artifacts'});
 await assert.rejects(buildProvenanceSupplement(evidence,policy,epoch),/inventory epoch changed/);await assert.rejects(epoch.finish(),/inventory epoch changed/);
}
