import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {ResidualBoundsSchema,ResidualInputSchema,ResidualExtractionSchema,residualMimeSupported,residualJobHandlersFor,enqueueResidualPreparation,loadResidualSource,enqueueCommittedResidualExtraction,exportResidualTextContribution} from '../src/district-residual-jobs.ts';
import {PILOT_BASE_CORPUS_SHA256} from '../src/district-corpus.ts';
import type {JobHandlerContext} from '../src/district-jobs.ts';
import {canonicalJobIdentity,type DistrictJobStore} from '../src/district-jobs.ts';
import type {DistrictCas} from '../src/district-cas.ts';
import type {TextRunContribution} from '../src/text-run-lineage.ts';
const hash='a'.repeat(64);
const bounds={maxDocuments:1,maxChunks:4,maxModelCalls:8,paidMicroUsd:0} as const;
const input={documentId:'original-document',corpusSha256:PILOT_BASE_CORPUS_SHA256,corpusObservations:[{kind:'http_observation' as const,url:'https://example.org/original',sourceSha256:hash,observationId:'1-11111111-1111-4111-8111-111111111111.json',receiptSha256:'f'.repeat(64)}],registrySha256:'b'.repeat(64),registry:{path:'/fixture/operator-registry-descriptor.json',sha256:'d'.repeat(64)},policyReceiptSha256:'c'.repeat(64),httpObservation:{observationId:'1-11111111-1111-4111-8111-111111111111.json',receiptSha256:'f'.repeat(64)},requestEvidenceSha256:hash,bounds};
const residualJobHandlers=residualJobHandlersFor({} as Pool);
test('residual lane accepts original documents and unresolved metadata narratives, not fabricated text containers',()=>{
 for(const mime of ['application/pdf','text/html','application/xhtml+xml','text/plain','text/plain; charset=utf-8','application/json','application/xml','text/xml'])assert.equal(residualMimeSupported(mime),true);
 for(const mime of ['application/zip','image/png','application/octet-stream'])assert.equal(residualMimeSupported(mime),false);
});
test('one original per residual job and zero paid spend are mandatory',()=>{
 assert.deepEqual(ResidualBoundsSchema.parse(bounds),bounds);
 for(const invalid of [{...bounds,maxDocuments:2},{...bounds,paidMicroUsd:1},{...bounds,maxChunks:0},{...bounds,maxChunks:25},{...bounds,maxModelCalls:1},{...bounds,maxModelCalls:49}])assert.throws(()=>ResidualBoundsSchema.parse(invalid));
});
test('residual input is closed: no synthetic text, invented dates or provider selector',()=>{
 assert.deepEqual(ResidualInputSchema.parse(input),input);
 for(const extra of [{text:'synthetic metadata narrative'},{documentDate:'2026-10-11'},{stageDate:'2026-10-11'},{provider:'anthropic-subscription'},{handler:'/tmp/module.ts'},{sourceType:'website'}])assert.throws(()=>ResidualInputSchema.parse({...input,...extra}));
 assert.throws(()=>ResidualInputSchema.parse({...input,httpObservation:undefined}));
 assert.throws(()=>ResidualInputSchema.parse({...input,httpObservation:{...input.httpObservation,observationId:'../invented.json'}}));
 assert.throws(()=>ResidualInputSchema.parse({...input,registry:undefined}));
 assert.throws(()=>ResidualInputSchema.parse({...input,registry:{path:'/fixture/raw-registry.json'}}));
});
test('corpus, registry, policy and bounds participate in exact canonical job identity',()=>{
 const spec={step:'residual_prepare',lane:'residual_preparation',semanticContractSha256:hash,inputArtifactHashes:[input.corpusSha256,input.registrySha256,input.policyReceiptSha256],sourceScope:{publisherId:'fixture-publisher',sourceId:'fixture-source',municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'fixture-window'},selector:input,policyProofSha256:input.policyReceiptSha256};
 const original=canonicalJobIdentity(spec).jobKey;
 for(const changed of [{...input,documentId:'other-original'},{...input,registrySha256:'d'.repeat(64)},{...input,registry:{...input.registry,sha256:'e'.repeat(64)}},{...input,bounds:{...bounds,maxChunks:3}},{...input,policyReceiptSha256:'e'.repeat(64)}])assert.notEqual(canonicalJobIdentity({...spec,selector:changed}).jobKey,original);
});
test('fixed registry exposes preparation and extraction only, never Mac substitution',()=>{
 assert.deepEqual(Object.keys(residualJobHandlersFor({} as Pool)).sort(),['residual_extract','residual_prepare']);
});
test('dependent extraction cannot enqueue an uncommitted or merely predicted preparation',async()=>{
 let enqueued=false;
 const pool={query:async()=>({rows:[]})} as unknown as Pool;
 const store={enqueue:async()=>{enqueued=true;return hash;}} as unknown as DistrictJobStore;
 await assert.rejects(enqueueCommittedResidualExtraction(pool,store,{} as DistrictCas,hash),/not committed/);
 assert.equal(enqueued,false);
});
test('malformed predecessor keys are rejected before querying Postgres',async()=>{
 let queried=false;
 const pool={query:async()=>{queried=true;return {rows:[]};}} as unknown as Pool;
 await assert.rejects(enqueueCommittedResidualExtraction(pool,{} as DistrictJobStore,{} as DistrictCas,'predicted-output'));
 assert.equal(queried,false);
});
test('text contribution export rejects empty or duplicate job selections before authenticating a run',async()=>{
 for(const keys of [[],[hash,hash]])await assert.rejects(exportResidualTextContribution({} as Pool,{} as DistrictCas,keys,{} as TextRunContribution),/distinct committed extraction jobs/);
});
test('residual extraction metadata requires authentic preparation provenance and result pins',()=>{
 const result={schemaVersion:'stadtstack-document-result-v2',taskId:hash,groupId:hash,provider:'openai-subscription',purpose:'production',municipalityId:'strausberg',sourceSha256:hash,preparedSha256:hash,promptSha256:hash,schemaSha256:hash,generatedAt:'2026-10-11T00:00:00.000Z',records:[],quarantine:[],chunks:[]};
 const envelope={schemaVersion:'district-residual-extraction-v1',documentId:input.documentId,corpusSha256:input.corpusSha256,registrySha256:input.registrySha256,policyReceiptSha256:input.policyReceiptSha256,preparationJobKey:hash,preparationReceiptId:'11111111-1111-4111-8111-111111111111',preparationReceiptSha256:hash,preparedArtifactSha256:hash,result};
 assert.deepEqual(ResidualExtractionSchema.parse(envelope),envelope);
 assert.throws(()=>ResidualExtractionSchema.parse({...envelope,preparationReceiptId:null}));
 assert.throws(()=>ResidualExtractionSchema.parse({...envelope,preparedArtifactSha256:'unknown'}));
 assert.throws(()=>ResidualExtractionSchema.parse({...envelope,model:{provider:'openai-subscription'}}));
 assert.throws(()=>ResidualExtractionSchema.parse({...envelope,result:{...result,provider:'anthropic-subscription'}}));
 assert.throws(()=>ResidualExtractionSchema.parse({...envelope,result:{...result,purpose:'agreement'}}));
});
test('unauthorized corpora fail schema, enqueue, defensive load and both execution paths before any source processing',async()=>{
 const unauthorized={...input,corpusSha256:hash};
 assert.throws(()=>ResidualInputSchema.parse(unauthorized),/owner-authorized/);
 let reads=0,enqueues=0;
 const cas={read:async()=>{reads++;throw Error('Must not read unauthorized source');}} as unknown as DistrictCas;
 const store={enqueue:async()=>{enqueues++;return hash;}} as unknown as DistrictJobStore;
 await assert.rejects(enqueueResidualPreparation(store,cas,unauthorized),/owner-authorized/);
 await assert.rejects(loadResidualSource(cas,unauthorized),/owner-authorized/);
 const handlers=residualJobHandlersFor({query:async()=>assert.fail('Must not query unauthorized source')} as unknown as Pool);
 for(const step of ['residual_prepare','residual_extract']){
  const selector={...unauthorized,contract:{preparationSha256:hash,extraction:{promptSha256:hash,schemaSha256:hash,extractorSha256:hash},outputSha256:hash},...(step==='residual_extract'?{preparationJobKey:hash,preparationReceiptId:'11111111-1111-4111-8111-111111111111',preparationReceiptSha256:hash,preparedArtifactSha256:hash}:{})};
  await assert.rejects(handlers[step]({job:{spec:{step,selector}},cas} as unknown as JobHandlerContext),/owner-authorized/);
 }
 assert.equal(reads,0);assert.equal(enqueues,0);
});
