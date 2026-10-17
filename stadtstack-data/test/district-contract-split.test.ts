import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {digest,semanticHash} from '../src/district-adapter-contract.ts';
import {canonicalJobIdentity,type DistrictJobSpec} from '../src/district-jobs.ts';
import {residualJobContract,residualPreparationContract} from '../src/district-residual-jobs.ts';
import {preparationExtractorSha256,prepareDocument,verifyPreparedDocument} from '../src/district-prepared-document.ts';
import {jointExtractionContract} from '../src/district-inference.ts';
import {assessmentQueueContract} from '../src/district-assessment-jobs.ts';
import {assessmentBJobContract} from '../src/district-assessment-broker.ts';
import {acquisitionContract} from '../src/district-r1.ts';
import {policyRefreshContract} from '../src/district-policy-refresh.ts';
import {structuredJobContract} from '../src/district-structured-jobs.ts';
import {operatorRegistryConfigContractSha256} from '../src/district-registry-config.ts';
import {parserOutputContractSha256,parserIsolationContractSha256} from '../src/district-parser-isolation.ts';
import {ompRunnerOutputContractSha256,ompRunnerContractSha256} from '../src/district-omp-b-runner.ts';
import {hostCodeVersions} from '../src/district-host-provenance.ts';
import type {ContractSourceHash} from '../src/district-contract-source.ts';
import {EXTRACTOR_SOURCE_FILES} from '../src/district-claims.ts';

// Only fingerprint I/O is injected. These hashes are explicitly synthetic and do
// not authorize an effect, image, parser, provider or production source.
const hash:ContractSourceHash=async file=>digest('Synthetic contract source '+file);
const change=(file:string):ContractSourceHash=>async candidate=>candidate===file?digest('Synthetic changed source '+file):hash(candidate);
const hostFiles=['civic-opt-out.ts','district-jobs.ts','source-policy.ts','registered-source-policy.ts','district-private-io.ts','district-codex-accounting.ts','district-policy-receipt.ts','district-policy-refresh.ts','district-model-readiness.ts','district-model-usage.ts','district-model-diagnostics.ts','district-corpus.ts','district-crawl-request.ts','district-http-observation.ts','source-observation.ts','document-origin.ts','document-origin-contract.ts','document-origin-rules.ts','civic-docker.ts','district-cas.ts','genesis-owner-credentials.ts','genesis-owner-reuse.ts','district-structured-registry-admission.ts','../sources/district-host-groups.json'];
const contracts:Record<string,{compute:(hash:ContractSourceHash)=>Promise<unknown>;semantic:string}>={
 residual:{compute:residualJobContract,semantic:'district-residual-jobs.ts'},
 residualPreparation:{compute:residualPreparationContract,semantic:'district-document.ts'},
 preparation:{compute:preparationExtractorSha256,semantic:'district-document.ts'},
 extraction:{compute:jointExtractionContract,semantic:'district-claims.ts'},
 assessmentQueue:{compute:assessmentQueueContract,semantic:'district-assessment-context.ts'},
 assessmentB:{compute:assessmentBJobContract,semantic:'district-assessment.ts'},
 acquisition:{compute:acquisitionContract,semantic:'district-native-request.ts'},
 policyRefresh:{compute:policyRefreshContract,semantic:'district-schema.ts'},
 structured:{compute:hash=>structuredJobContract('council',hash),semantic:'district-structured-record.ts'},
 registry:{compute:operatorRegistryConfigContractSha256,semantic:'district-registry.ts'},
 parserOutput:{compute:parserOutputContractSha256,semantic:'district-parser-worker.py'},
 ompOutput:{compute:ompRunnerOutputContractSha256,semantic:'../docker/omp-b/settings.yml'},
};
function spec(contract:unknown):DistrictJobSpec{
 return {step:'synthetic_contract_split',lane:'cpu',semanticContractSha256:semanticHash(contract),inputArtifactHashes:[digest('Synthetic original')],sourceScope:{publisherId:'synthetic',sourceId:'synthetic',municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'synthetic'},selector:{contract},policyProofSha256:digest('Synthetic policy pin')};
}
for(const [name,{compute,semantic}] of Object.entries(contracts)){
 test(name+' ignores every host-only source hash but binds semantic sources and job identity',async()=>{
  const before=await compute(hash),key=canonicalJobIdentity(spec(before)).jobKey;
  for(const file of hostFiles){
   const after=await compute(change(file));assert.deepEqual(after,before,file);
   assert.equal(canonicalJobIdentity(spec(after)).jobKey,key,file);
  }
  const after=await compute(change(semantic));assert.notDeepEqual(after,before,semantic);
  assert.notEqual(canonicalJobIdentity(spec(after)).jobKey,key,semantic);
 });
}
test('database supervision remains host-only for the five queued R1 semantic contracts',async()=>{
 const affected=['district-database.ts','district-jobs.ts','district-r1.ts','district-codex-accounting.ts','replay-pipeline.ts','civic-opt-out.ts'];
 for(const name of ['residualPreparation','residual','assessmentQueue','assessmentB','policyRefresh']){
  const before=await contracts[name].compute(hash);
  for(const file of affected)assert.deepEqual(await contracts[name].compute(change(file)),before,name+': '+file);
 }
});
test('exception stderr diagnostics do not enter queued semantics or the OMP runner contract',async()=>{
 for(const file of ['district-jobs.ts','district-exception-diagnostics.ts']){
  for(const name of ['residualPreparation','residual','assessmentQueue','assessmentB','policyRefresh'])assert.deepEqual(await contracts[name].compute(change(file)),await contracts[name].compute(hash),name+': '+file);
  assert.equal(await ompRunnerContractSha256(change(file)),await ompRunnerContractSha256(hash),file);
 }
});
test('seal exception diagnostics stay outside all fourteen contracts and the generation replay set',async()=>{
 for(const file of ['district-queue-text-run.ts','district-exception-diagnostics.ts']){
  for(const [name,{compute}] of Object.entries(contracts))assert.deepEqual(await compute(change(file)),await compute(hash),name+': '+file);
  for(const compute of [parserIsolationContractSha256,ompRunnerContractSha256])assert.equal(await compute(change(file)),await compute(hash),file);
  assert.equal((EXTRACTOR_SOURCE_FILES as readonly string[]).includes(file),false,file);
 }
});
test('notification presentation stays outside every semantic contract and the OMP runner contract',async()=>{
 for(const file of ['district-notifications.ts','district-jobs.ts']){
  for(const [name,{compute}] of Object.entries(contracts))assert.deepEqual(await compute(change(file)),await compute(hash),name+': '+file);
  assert.equal(await ompRunnerContractSha256(change(file)),await ompRunnerContractSha256(hash),file);
 }
});
test('stage drain control preserves campaign, parser security/output and B/OMP contracts',async()=>{
 for(const name of ['residualPreparation','residual','assessmentQueue','policyRefresh','assessmentB'])assert.deepEqual(await contracts[name].compute(change('district-jobs.ts')),await contracts[name].compute(hash),name);
 for(const compute of [parserIsolationContractSha256,parserOutputContractSha256,ompRunnerContractSha256])assert.equal(await compute(change('district-jobs.ts')),await compute(hash));
});

test('host resolver and native image cutovers change only B contracts among the scoped queued job contracts',async()=>{
 for(const file of ['district-omp-b-runner.ts','district-omp-output-diagnostics.ts','../scripts/build-omp-b-image.sh','../docker/omp-b/Dockerfile','../docker/omp-b/natives.sha256']){
  for(const name of ['residualPreparation','residual','assessmentQueue','policyRefresh'])
   assert.deepEqual(await contracts[name].compute(change(file)),await contracts[name].compute(hash),name+': '+file);
  assert.notDeepEqual(await assessmentBJobContract(change(file)),await assessmentBJobContract(hash));
  assert.notEqual(await ompRunnerContractSha256(change(file)),await ompRunnerContractSha256(hash));
  assert.notEqual(await ompRunnerOutputContractSha256(change(file)),await ompRunnerOutputContractSha256(hash));
  assert.equal(await parserOutputContractSha256(change(file)),await parserOutputContractSha256(hash));
 }
});
test('source projection and native B admission are assessment-only semantic dependencies',async()=>{
 for(const file of ['district-assessment-projection.ts','district-b-native-model.ts']){
  for(const compute of [assessmentQueueContract,assessmentBJobContract,ompRunnerOutputContractSha256,ompRunnerContractSha256])assert.notDeepEqual(await compute(change(file)),await compute(hash),file);
  for(const compute of [residualPreparationContract,residualJobContract,policyRefreshContract,parserOutputContractSha256,parserIsolationContractSha256])assert.deepEqual(await compute(change(file)),await compute(hash),file);
 }
});
test('preparation jobs are independent of extraction prompts/model/decoding/chunking and output assembly',async()=>{
 const preparation=await residualPreparationContract(hash),extraction=await residualJobContract(hash);
 assert.deepEqual(Object.keys(preparation),['preparationSha256']);
 for(const file of ['district-model.ts','district-inference.ts','district-answer-cache.ts','district-claims.ts','district-residual-jobs.ts']){
  const nextPreparation=await residualPreparationContract(change(file)),nextExtraction=await residualJobContract(change(file));
  assert.deepEqual(nextPreparation,preparation,file);
  assert.equal(canonicalJobIdentity({...spec(nextPreparation),step:'residual_prepare'}).jobKey,canonicalJobIdentity({...spec(preparation),step:'residual_prepare'}).jobKey,file);
  assert.notDeepEqual(nextExtraction,extraction,file);
  assert.notEqual(canonicalJobIdentity({...spec(nextExtraction),step:'residual_extract'}).jobKey,canonicalJobIdentity({...spec(extraction),step:'residual_extract'}).jobKey,file);
 }
 for(const file of ['district-document.ts','district-prepared-document.ts','district-parser-worker.py','district-execution-profile.ts']){
  assert.notDeepEqual(await residualPreparationContract(change(file)),preparation,file);
  assert.notDeepEqual(await residualJobContract(change(file)),extraction,file);
 }
});
test('security authorization still changes on host-only edits while parser/OMP output identity does not',async()=>{
 for(const file of ['civic-opt-out.ts','civic-docker.ts']){
  assert.notEqual(await parserIsolationContractSha256(hash),await parserIsolationContractSha256(change(file)));
  assert.notEqual(await ompRunnerContractSha256(hash),await ompRunnerContractSha256(change(file)));
  assert.equal(await parserOutputContractSha256(hash),await parserOutputContractSha256(change(file)));
  assert.equal(await ompRunnerOutputContractSha256(hash),await ompRunnerOutputContractSha256(change(file)));
 }
 for(const compute of [parserOutputContractSha256,ompRunnerOutputContractSha256,assessmentBJobContract,preparationExtractorSha256]){
  assert.notEqual(await compute(hash),await compute(change('district-execution-profile.ts')),'Actual model/locale/CLI framing remains semantic after its extraction from custody');
 }
});
test('prepared immutable receipt survives host change but rejects preparation, image, tool or text changes',async()=>{
 const text='Synthetic municipal original with enough text to exercise immutable preparation, never civic evidence.',bytes=Buffer.from(text),sourceSha256=digest(bytes);
 const references=[{id:'synthetic',url:'https://example.org/synthetic',sha256:sourceSha256,retrievedAt:'2026-10-13T00:00:00Z',locator:'Synthetic fixture',mimeType:'text/plain',sourceType:'website' as const,policy:{robots:{state:'allowed' as const,url:'https://example.org/robots.txt'},tdm:{state:'not_declared' as const,evidence:[]},access:'public' as const,legalClassification:'not_assessed' as const,publication:'facts_with_attribution_only' as const}}];
 const prepared=await prepareDocument({bytes,municipalityId:'strausberg',references,mimeType:'text/plain',extractorSha256:await preparationExtractorSha256(hash),toolVersions:{node:'0.0.0-synthetic',parser_isolation:'district-parser-isolation-v1',parser_image:'sha256:'+digest('Synthetic image'),parser_contract:await parserOutputContractSha256(hash)}},async()=>assert.fail('Pure synthetic text must not launch a parser'));
 const hostExpected={...prepared,extractorSha256:await preparationExtractorSha256(change('civic-opt-out.ts'))};
 assert.deepEqual(verifyPreparedDocument(prepared,hostExpected,bytes),prepared);
 assert.throws(()=>verifyPreparedDocument(prepared,{...prepared,extractorSha256:digest('Synthetic semantic change')},bytes),/extractor identity/);
 for(const key of ['parser_image','parser_contract','node'])assert.throws(()=>verifyPreparedDocument(prepared,{...prepared,toolVersions:{...prepared.toolVersions,[key]:'synthetic-changed'}},bytes),/tool versions/);
 assert.throws(()=>verifyPreparedDocument({...prepared,text:prepared.text+'tampered'},prepared,bytes),/receipt hash/);
});
test('complete host-code manifest records actual per-file bytes and a canonical summary',async()=>{
 const versions=await hostCodeVersions(),manifest=Object.entries(versions).filter(([key])=>key.startsWith('hostCode.')).map(([key,sha256])=>({file:key.slice('hostCode.'.length),sha256}));
 assert.equal(versions.hostCodeManifestVersion,'district-host-code-v1');
 assert.equal(versions.hostCodeManifestSha256,semanticHash(manifest));
 for(const file of ['civic-opt-out.ts','district-jobs.ts','district-database.ts','source-policy.ts','district-policy-refresh.ts','district-cas.ts','district-model-usage.ts'])assert.equal(versions['hostCode.src/'+file],digest(await readFile(new URL('../src/'+file,import.meta.url))));
 const modified=manifest.map(entry=>entry.file==='src/civic-opt-out.ts'?{...entry,sha256:digest('Synthetic alternate host bytes')}:entry);
 assert.notEqual(semanticHash(modified),versions.hostCodeManifestSha256);
 assert.equal('hostCodeManifestSha256' in spec(await residualJobContract(hash)),false);
});

test('native assessment operator entrypoint cannot invalidate acquisition observation identity',async()=>{
 assert.equal(await acquisitionContract(change('district-r1-assessment-cli.ts')),await acquisitionContract(hash));
});
