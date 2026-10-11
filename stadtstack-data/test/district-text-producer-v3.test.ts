import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {inferPreparedDocument,jointExtractionContract,archiveJointExtractionContract,documentResultSchema} from '../src/district-inference.ts';
import {prepareDocument,preparedCacheContext,preparedSourceBindings,type PreparedSourceReference} from '../src/district-prepared-document.ts';
import {DistrictExtractionClaimsSchema,DistrictKnowledgeRecordSchema,KnowledgeRecordsSchema,KNOWLEDGE_SCHEMA_VERSION,knowledgeEvidenceHash,sha256} from '../src/district-schema.ts';
import {PROVIDER_CONFIGS} from '../src/district-model-contract.ts';
import {EXTRACTOR_VERSION,EXTRACTOR_SOURCE_FILES,EXTRACTION_INSTRUCTIONS,JUDGE_INSTRUCTIONS,outputJSONSchema,judgeJSONSchema,restoreSourceQuotes,documentChunks,deterministicChecks,JUDGE_PROMPT_VERSION,JUDGE_PROMPT_SHA256} from '../src/district-claims.ts';
import {TOPIC_VOCABULARY} from '../src/topic-vocabulary.ts';
import {materializeReassessment,REASSESSMENT_VERSION,type RelationAssessment,type ReassessmentContract} from '../src/district-reassess-relations.ts';
import {modelAnswerCacheBinding} from '../src/district-answer-cache.ts';
import {writeManagedSourceArtifact} from '../src/district-private-io.ts';
import {CIVIC_ACQUISITION_DECISION_ID,initializeManagedAcquisitionLane,CivicPolicyStateError} from '../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {verifyGenerationArchive} from '../src/replay-pipeline.ts';
import type {ReadinessExecutor} from '../src/district-model-readiness.ts';

// Synthetic source/answers only. Native generation, credentials and networking are
// forbidden; the real producer consumes sealed synthetic answers through its cache.
const generatedAt='2026-10-01T12:00:00.000Z',judgedAt='2026-10-02T12:00:00.000Z';
const municipality={id:'beispielstadt',name:'Beispielstadt',ags:'12064001',districtId:'unit-district'};
const text='Stadt Beispielstadt\nWärmeplanung\nDer Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.\nStand: 10.10.2026';
const claims=DistrictExtractionClaimsSchema.parse({
 title:'Wärmeplanung',titleQuote:'Wärmeplanung',summary:'Der Entwurf der Wärmeplanung wurde veröffentlicht.',summaryQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',
 municipalityQuote:'Stadt Beispielstadt',caseKey:null,caseKeyType:'source_document',caseQuote:null,caseType:'planning',
 documentDate:'2026-10-10',documentDateQuote:'Stand: 10.10.2026',documentDateReason:null,
 topics:[{id:'waermeplanung',parentId:'energie',provenance:'model',confidence:0.9,quote:'Wärmeplanung'}],stage:'draft',stageDate:'2026-10-09',stageDateQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stageDateReason:null,
 originalStatus:'Entwurf',stageQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stages:[],entities:[],relations:[],locations:[],
});

test('actual scoped generation archive freezes source bytes and keeps the first archive clock on resume',async context=>{
 const {root}=await createCivicPolicyTestContext(context),contract=await jointExtractionContract();
 const pin=await archiveJointExtractionContract(root,contract),bytes=await readFile(pin.path,'utf8'),before=await stat(pin.path);
 assert.equal(pin.sha256,sha256(bytes));
 const archive=verifyGenerationArchive(JSON.parse(bytes));
 assert.equal(archive.schemaVersion,'stadtstack-extraction-contract-archive-v2');
 assert.equal(archive.extractorVersion,EXTRACTOR_VERSION);
 assert.deepEqual(archive.sources.map(source=>source.name),[...EXTRACTOR_SOURCE_FILES]);
 for(const source of archive.sources){
  assert.equal(source.code,await readFile(new URL('../src/'+source.name,import.meta.url),'utf8'));
  assert.equal(source.sha256,sha256(source.code));
 }
 const repeated=await archiveJointExtractionContract(root,contract);
 assert.deepEqual(repeated,pin);assert.equal(await readFile(pin.path,'utf8'),bytes);
 assert.equal((await stat(pin.path)).mtimeMs,before.mtimeMs);
 await assert.rejects(archiveJointExtractionContract(root,{...contract,extractorSha256:sha256('synthetic wrong generation contract')}),/actual work-plan contract/);
 await writeFile(pin.path,JSON.stringify({...archive,promptVersion:'synthetic relabeled prompt'})+'\n');
 await assert.rejects(archiveJointExtractionContract(root,contract),/relabel an existing contract/);
});

test('live text producer and warm cache require v3 discriminants without rewriting generation or judge provenance', async context=>{
 const {root,policy}=await createCivicPolicyTestContext(context);
 // The explicit in-memory protocol executor is accepted only by a real pinned
 // isolated authority; no production marker, native auth or source permission is forged.
 const provider='openai-subscription' as const,config=PROVIDER_CONFIGS[provider];
 const identityBody={provider,tool:config.tool,toolVersion:'1.2.3',model:config.model,modelIdentityBasis:config.modelIdentityBasis};
 const identity={...identityBody,modelIdentitySha256:sha256(JSON.stringify(identityBody))};
 const calls:string[][]=[];
 const fixtureReadinessExecutor:ReadinessExecutor=async(_provider,args)=>{
  calls.push(args);
  const stdout=args[0]==='--version'?'codex-cli 1.2.3\n':JSON.stringify(args)===JSON.stringify(['login','status'])?'Logged in using ChatGPT\n':assert.fail('Unexpected source-free readiness request');
  return {stdout,stderr:'',code:0,failure:null};
 };
 const guard=context.mock.method(childProcess,'spawn',()=>{assert.fail('Native calls are forbidden in isolated producer fixture');});
 syncBuiltinESMExports();
 try{
  const sourceSha256=sha256(text);
  const reference:PreparedSourceReference={id:'unit-source',url:'https://example.org/document',sha256:sourceSha256,retrievedAt:generatedAt,locator:'document-sha256:'+sourceSha256,mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
  const prepared=await prepareDocument({bytes:Buffer.from(text),municipalityId:municipality.id,references:[reference],mimeType:'text/plain',extractorSha256:sha256('synthetic preparation'),toolVersions:{node:'synthetic'}},async()=>{assert.fail('Plain text must not spawn parsers');});
  const contract=await jointExtractionContract(),cache=join(root,'cache');await mkdir(cache,{mode:0o700});
  await initializeManagedAcquisitionLane(cache,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
  const sourceContext=preparedCacheContext(prepared.receiptSha256,prepared.references),sourceBindings=preparedSourceBindings(prepared.references,prepared.receiptSha256);
  const sourceInput={municipality:{id:municipality.id,name:municipality.name},vocabulary:TOPIC_VOCABULARY.map(({pattern:_pattern,...topic})=>topic),source:{text:prepared.text}};
  const request={provider,modelIdentitySha256:identity.modelIdentitySha256,system:EXTRACTION_INSTRUCTIONS,input:sourceInput,schema:outputJSONSchema};
  const binding=modelAnswerCacheBinding({...request,sourceContext});
  assert.equal(modelAnswerCacheBinding({...request,sourceContext:preparedCacheContext(prepared.receiptSha256,[...prepared.references,...prepared.references])}),binding);
  for(const changedContext of [
   preparedCacheContext(sha256('synthetic different prepared receipt'),prepared.references),
   preparedCacheContext(prepared.receiptSha256,[{...reference,id:'synthetic different source'}]),
   preparedCacheContext(prepared.receiptSha256,[{...reference,url:'https://example.org/different-source'}]),
  ])assert.notEqual(modelAnswerCacheBinding({...request,sourceContext:changedContext}),binding);
  const normalized=restoreSourceQuotes(claims,prepared.text,0).claims;
  async function seal(system:string,input:unknown,schema:object,value:unknown,receivedAt:string,responseSha256:string){
   const binding=modelAnswerCacheBinding({provider,modelIdentitySha256:identity.modelIdentitySha256,system,input,schema,sourceContext});
   const body={binding,modelIdentitySha256:identity.modelIdentitySha256,receivedAt,value,responseSha256,returnedModel:identity.model,runtimeWarnings:['Synthetic original receipt warning']};
   await writeManagedSourceArtifact(cache,join(cache,binding+'.answer.json'),JSON.stringify({...body,cacheSha256:sha256(JSON.stringify(body))})+'\n',sourceBindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
  }
  const responseSha256=sha256('synthetic generation answer'),judgeSha256=sha256('synthetic judge answer');
  await seal(EXTRACTION_INSTRUCTIONS,sourceInput,outputJSONSchema,{record:claims,reason:'Synthetic supported case'},generatedAt,responseSha256);
  await seal(JUDGE_INSTRUCTIONS,{source:{text:prepared.text},candidate:normalized},judgeJSONSchema,{score:0.91,reason:'Synthetic judgment, not civic evidence',criticalUnsupported:false},judgedAt,judgeSha256);
  const options={taskId:sha256('synthetic task'),groupId:sha256('synthetic group'),purpose:'production' as const,provider,municipality,prepared,expected:prepared,contract,out:root,policy,fixtureReadinessExecutor,usage:{ledgerPath:join(root,'usage.jsonl'),pausePath:join(root,'pause.json'),policy}};
  const result=await inferPreparedDocument(options);
  assert.equal(result.records.length,1);assert.deepEqual(result.quarantine,[]);
  const record=result.records[0];
  assert.equal(record.kind,'text_model');assert.equal(record.verification.kind,'text_model');
  assert.equal(record.extraction.model,identity.model);assert.equal(record.extraction.modelIdentitySha256,identity.modelIdentitySha256);
  assert.equal(record.extraction.extractedAt,generatedAt);assert.equal(record.extraction.responseSha256,responseSha256);
  assert.equal(record.verification.faithfulness.evaluatedAt,judgedAt);assert.equal(record.verification.faithfulness.responseSha256,judgeSha256);assert.equal(record.verification.faithfulness.score,0.91);
  assert.equal(record.verification.evidenceHash,knowledgeEvidenceHash(record));
  const warm=await inferPreparedDocument(options);assert.deepEqual(warm.records,[record]);assert.equal(calls.length,4);
  const envelope=KnowledgeRecordsSchema.parse({schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt,records:[record],identityAssertions:[],identityAdmissions:[]});
  assert.deepEqual(envelope.identityAssertions,[]);assert.deepEqual(envelope.identityAdmissions,[]);
  for(const field of ['identityAssertions','identityAdmissions'])assert.equal(KnowledgeRecordsSchema.safeParse({...envelope,[field]:undefined}).success,false);
  assert.equal(KnowledgeRecordsSchema.safeParse({...envelope,schemaVersion:'stadtstack-knowledge-v2'}).success,false);
  for(const altered of [{...record,kind:undefined},{...record,verification:{...record.verification,kind:undefined}},{...record,kind:'structured'}])assert.equal(DistrictKnowledgeRecordSchema.safeParse(altered).success,false);
  assert.equal(documentResultSchema.safeParse({...result,records:[{...record,kind:'structured'}]}).success,false);

  const reassessmentContract:ReassessmentContract={version:REASSESSMENT_VERSION,judgePromptVersion:JUDGE_PROMPT_VERSION,judgePromptSha256:JUDGE_PROMPT_SHA256,judgeSchemaSha256:sha256(JSON.stringify(judgeJSONSchema)),assessorSha256:sha256('synthetic reassessment'),threshold:0.8};
  const assessment:RelationAssessment={key:sha256('synthetic assessment'),original:record,claims:normalized,normalization:null,quoteNormalization:record.extraction.quoteNormalization,deterministic:deterministicChecks(normalized,documentChunks(prepared.text)[0].text,municipality.name),changed:true,newlyPassed:false,dateEligible:true,needsJudge:true,hold:null,judgeInput:null,judgeBinding:null,claimsSha256:sha256(JSON.stringify(normalized))};
  const held=materializeReassessment(assessment,null,reassessmentContract);
  assert.equal(held.record.kind,'text_model');assert.equal(held.record.verification.kind,'text_model');assert.equal(held.admitted,false);
  assert.deepEqual(held.record.extraction,record.extraction);assert.equal(held.record.verification.faithfulness.score,null);assert.equal(held.record.verification.faithfulness.responseSha256,null);
  const unchanged=materializeReassessment({...assessment,changed:false,needsJudge:false},null,reassessmentContract);
  assert.deepEqual(unchanged.record,record);assert.equal(unchanged.admitted,true);

  // Reject a pre-cutover cache object rather than patching its discriminants or hash.
  const recordPath=join(cache,record.extraction.cacheKey+'.record.json'),legacy={...JSON.parse(await readFile(recordPath,'utf8'))};delete legacy.kind;delete legacy.verification.kind;
  await writeFile(recordPath,JSON.stringify(legacy)+'\n');
  await assert.rejects(inferPreparedDocument(options),CivicPolicyStateError);
  assert.deepEqual(JSON.parse(await readFile(recordPath,'utf8')),legacy);
 }finally{guard.mock.restore();syncBuiltinESMExports();}
});
