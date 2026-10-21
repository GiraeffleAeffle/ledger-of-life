import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {publicationInput,PublicationOptionsSchema,publish,historicalKnowledgeRecords} from '../src/publish.ts';
import type {PublicationOptions} from '../src/publish.ts';
import {outDir,hash} from '../src/common.ts';
import {writeManagedSourceArtifact} from '../src/district-private-io.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {authenticatePublicationProvenance} from '../src/district-publication-provenance.ts';
import type {AuthenticatedPreparedPublication} from '../src/prepare-knowledge.ts';
import {fileURLToPath} from 'node:url';
import {loadDistrictRegistry} from '../src/district-registry.ts';
import {knowledgeEvidenceHash} from '../src/district-schema.ts';
import {syntheticTextRecord} from './helpers/text-publication-fixture.ts';
import {initializeManagedAcquisitionLane} from '../src/civic-opt-out.ts';

async function stagedFixture(directory:string,t:{after:(callback:()=>Promise<void>)=>void}){
 const context=await createCivicPolicyTestContext(t),stagingDir=join(context.managedRoot,'staging'),privateProvenance=join(directory,'private-provenance.json'),cataloguePath=join(stagingDir,'catalogue.json'),catalogueBytes=Buffer.from(JSON.stringify({generatedAt:'2026-10-11T03:46:26.421Z',cities:[]})),binding={kind:'prepared_source' as const,url:'https://example.org/synthetic-publication-input',sourceSha256:hash('synthetic source'),observationId:'synthetic-publication-input',receiptSha256:hash('synthetic receipt'),independentAllowed:true};
 await initializeManagedAcquisitionLane(context.managedRoot,{...context.policy,decisionId:context.decisionId,kind:'artifacts'});
 await mkdir(stagingDir,{recursive:true});
 await writeManagedSourceArtifact(context.managedRoot,cataloguePath,catalogueBytes,[binding],{...context.policy,decisionId:context.decisionId,kind:'artifacts'});
 const knowledgePath=join(stagingDir,'knowledge','preparation.json'),knowledgeBytes=Buffer.from('{"syntheticFixture":true}');
 await writeManagedSourceArtifact(context.managedRoot,knowledgePath,knowledgeBytes,[binding],{...context.policy,decisionId:context.decisionId,kind:'artifacts'});
 const inventory={schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[{path:relative(directory,knowledgePath),sha256:hash(knowledgeBytes),bytes:knowledgeBytes.length,bindings:[binding]}]};
 const stagingInventory={schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[{path:relative(directory,cataloguePath),sha256:hash(catalogueBytes),bytes:catalogueBytes.length,bindings:[binding]}]},stagingProvenance=join(directory,'staging-provenance.json');
 await writeFile(privateProvenance,JSON.stringify(inventory));await writeFile(stagingProvenance,JSON.stringify(stagingInventory));
 return {stagingDir,privateProvenance:{path:privateProvenance,sha256:hash(JSON.stringify(inventory))},stagingProvenance:{path:stagingProvenance,sha256:hash(JSON.stringify(stagingInventory))},policyStateDir:context.policy.stateDir,policyAuthorityId:context.policy.authorityId,policyAuthoritySha256:context.policy.authoritySha256};
}

const at='2026-10-11T09:25:14.000Z',manifestAt='2026-10-11T09:25:14.460Z';
const prerequisites={asOf:'2026-10-11',priorRelease:{gitCommit:'a'.repeat(40),manifestSha256:'b'.repeat(64),releaseId:'c'.repeat(64)},policyReceipts:'synthetic-policy-inventory.json',publicationInputs:'synthetic-publication-inputs.json',offlineReplay:true};

test('publication replay requires explicit quality and manifest clocks without overriding staged data clocks',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-publication-clock-'));
 try{
  const custody=await stagedFixture(directory,t),options:PublicationOptions={...prerequisites,...custody,outDir:join(directory,'release'),priorCityRoot:join(directory,'prior'),qualityGeneratedAt:at,manifestGeneratedAt:manifestAt};
  assert.deepEqual(PublicationOptionsSchema.parse(options),options);
  assert.throws(()=>PublicationOptionsSchema.parse({...options,qualityGeneratedAt:undefined}));
  assert.throws(()=>PublicationOptionsSchema.parse({...options,manifestGeneratedAt:'now'}));
  assert.throws(()=>PublicationOptionsSchema.parse({...options,asOf:undefined}));
  assert.throws(()=>PublicationOptionsSchema.parse({...options,priorRelease:undefined}));
  assert.throws(()=>PublicationOptionsSchema.parse({...options,privateProvenance:undefined}),/privateProvenance/);
  assert.throws(()=>PublicationOptionsSchema.parse({...options,stagingProvenance:undefined}),/stagingProvenance/);
  assert.deepEqual(await publicationInput('catalogue.json',options),{generatedAt:'2026-10-11T03:46:26.421Z',cities:[]});
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('missing replay staging never falls back to released regional or knowledge members',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-publication-no-fallback-'));
 try{
  const custody=await stagedFixture(directory,t),options:PublicationOptions={...prerequisites,...custody,outDir:join(directory,'release'),priorCityRoot:join(directory,'prior'),qualityGeneratedAt:at,manifestGeneratedAt:manifestAt};
  for(const path of ['regions/brandenburg-mol/topics.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json'])await assert.rejects(publicationInput(path,options),{code:'ENOENT'});
  await assert.rejects(publish({...options,outDir}),/target output/);
  await assert.rejects(publish({...options,priorCityRoot:outDir}),/target output/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('genuine input provenance does not authorize structurally supplied staging or predecessor readers',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-publication-forged-lease-'));
 try{
  const fixture=await stagedFixture(directory,t),options:PublicationOptions={...prerequisites,...fixture,outDir:join(directory,'release'),priorCityRoot:join(directory,'prior'),qualityGeneratedAt:at,manifestGeneratedAt:manifestAt};
  const provenance=await authenticatePublicationProvenance(fixture.privateProvenance.path,fixture.privateProvenance.sha256,{stateDir:fixture.policyStateDir,authorityId:fixture.policyAuthorityId,authoritySha256:fixture.policyAuthoritySha256});
  const stagingProvenance=await authenticatePublicationProvenance(fixture.stagingProvenance.path,fixture.stagingProvenance.sha256,{stateDir:fixture.policyStateDir,authorityId:fixture.policyAuthorityId,authoritySha256:fixture.policyAuthoritySha256});
  let reads=0;
  const supplied={provenance,stagingProvenance,stagingDir:fixture.stagingDir,priorDirectory:options.priorCityRoot,read:async()=>{reads++;return Buffer.from('{}');},readStaging:async()=>{reads++;return Buffer.from('{}');},readPrior:async()=>{reads++;return Buffer.from('{}');}};
  await assert.rejects(publish(options,undefined,supplied as AuthenticatedPreparedPublication));
  assert.equal(reads,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('authentic predecessor change revisions retain original unmarked bytes and reject invalid evidence or current markers',async()=>{
 const registry=await loadDistrictRegistry(fileURLToPath(new URL('../sources/district-registry.json',import.meta.url)));
 const record=syntheticTextRecord(registry,'synthetic-prior-knowledge',hash('synthetic source'),'openai-subscription',at);
 const {kind:_kind,...claims}=record,{kind:_verificationKind,...verification}=record.verification;
 const original={...claims,verification};original.verification.evidenceHash=knowledgeEvidenceHash(original);
 const envelope={schemaVersion:'stadtstack-knowledge-v2',generatedAt:at,records:[original]},before=JSON.stringify(envelope);
 assert.deepEqual(historicalKnowledgeRecords(envelope),[original]);
 assert.equal(JSON.stringify(envelope),before);
 assert.throws(()=>historicalKnowledgeRecords({...envelope,records:[{...original,summary:'Changed authentic prior assertion'}]}),/evidence hash mismatch/);
 assert.throws(()=>historicalKnowledgeRecords({...envelope,records:[original,original]}),/Duplicate/);
 assert.throws(()=>historicalKnowledgeRecords({...envelope,schemaVersion:'stadtstack-knowledge-v3'}));
 const unknown={...record,kind:'unknown',verification:{...record.verification}};unknown.verification.evidenceHash=knowledgeEvidenceHash(unknown);
 assert.throws(()=>historicalKnowledgeRecords({...envelope,schemaVersion:'stadtstack-knowledge-v3',records:[unknown]}));
});
