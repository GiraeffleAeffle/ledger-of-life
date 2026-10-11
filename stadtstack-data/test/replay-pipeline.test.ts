import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,outDir} from '../src/common.ts';
import {ReplayReceiptSchema,ReplayClocksSchema,verifyReplayAnswer,verifyGenerationArchive,verifyCachedGeneration,replayAnswerBinding,compareReplayRelease,readReplayPin,requiredReplayStaging,readCommittedReleaseFile} from '../src/replay-pipeline.ts';
import type {HistoricalGeneration,ReplayReceipt} from '../src/replay-pipeline.ts';
import type {ModelEvidence} from '../src/district-model-contract.ts';
import type {DocumentResult} from '../src/district-inference.ts';
import type {PreparedSourceReference} from '../src/district-prepared-document.ts';
import {prepareDocument} from '../src/district-prepared-document.ts';
import {dataReleaseId} from '../src/data-release.ts';
import type {DataRelease} from '../src/data-release.ts';
import * as claims from '../src/district-claims.ts';
import * as schema from '../src/district-schema.ts';
import * as graph from '../src/district-graph-claims.ts';
import * as vocabulary from '../src/topic-vocabulary.ts';
import * as models from '../src/district-model-contract.ts';

// Entirely synthetic evidence. No private corpus, provider, readiness, external
// document command, Git subprocess or network is needed by these unit tests.
const at='2026-10-10T12:00:00.000Z',later='2026-10-11T09:25:14.460Z';
const jsonHash=(value:unknown)=>hash(JSON.stringify(value));
const clocks={recordsGeneratedAt:at,quarantineGeneratedAt:at,coverageGeneratedAt:later,qualityGeneratedAt:later,manifestGeneratedAt:later};
const identityBody={provider:'openai-subscription' as const,tool:'codex-cli' as const,toolVersion:'synthetic-1',model:models.PROVIDER_CONFIGS['openai-subscription'].model,modelIdentityBasis:'configured-cli-model-and-tool-version' as const};
const identity:ModelEvidence={...identityBody,modelIdentitySha256:jsonHash(identityBody)};
const archiveNames=['district-claims.ts','district-inference.ts','district-model.ts','district-claude.ts','district-model-contract.ts','district-model-usage.ts','district-model-diagnostics.ts','district-schema.ts','district-graph-claims.ts','topic-vocabulary.ts','../regional/taxonomy.mjs'];
function syntheticArchive(){
 const sources=archiveNames.map(name=>{const code='// Synthetic archived file: '+name+'\n';return {name,code,sha256:hash(code)};});
 return {schemaVersion:'stadtstack-extraction-contract-archive-v1' as const,archivedAt:at,promptSha256:hash('synthetic original prompt identity'),schemaSha256:jsonHash(claims.outputJSONSchema),extractorSha256:jsonHash({version:'district-extractor-v8-joint-graph',hashes:sources.map(source=>source.sha256)}),extractorVersion:'district-extractor-v8-joint-graph' as const,promptVersion:'synthetic-original-extraction',judgePromptVersion:'synthetic-original-judge',judgePromptSha256:jsonHash({system:'Synthetic original judge instructions',schema:claims.judgeJSONSchema}),extractionInstructions:'Synthetic original extraction instructions',judgeInstructions:'Synthetic original judge instructions',outputSchema:claims.outputJSONSchema,judgeSchema:claims.judgeJSONSchema,sources};
}
async function noCaseFixture(text='Strausberg synthetic source with no supported case.'){
 const sourceSha256=hash(text);
 const reference:PreparedSourceReference={id:'synthetic-source',url:'https://example.org/synthetic-source',sha256:sourceSha256,retrievedAt:at,locator:'document-sha256:'+sourceSha256,mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
 const prepared=await prepareDocument({bytes:Buffer.from(text),municipalityId:'strausberg',references:[reference],mimeType:'text/plain',extractorSha256:hash('synthetic text preparation'),toolVersions:{node:'synthetic'}},async()=>{throw Error('A text fixture must not execute a document command');});
 const municipality={id:'strausberg',name:'Strausberg',ags:'12064472',districtId:'maerkisch-oderland'},archive=syntheticArchive();
 // Pure current modules supply schemas/chunking for this synthetic no-case test;
 // real replay loads and checks the pinned historical modules, never these labels.
 const historical:HistoricalGeneration={archive,claims,schema,graph,vocabulary,models};
 const sourceInput={municipality:{id:municipality.id,name:municipality.name},vocabulary:vocabulary.TOPIC_VOCABULARY.map(({pattern:_pattern,...topic})=>topic),source:{text:prepared.text}};
 const body={binding:replayAnswerBinding(identity,archive.extractionInstructions,sourceInput,archive.outputSchema),modelIdentitySha256:identity.modelIdentitySha256,receivedAt:at,value:{record:null,reason:'Synthetic no case'},responseSha256:hash('synthetic historical raw provider response'),returnedModel:identity.model,runtimeWarnings:[]};
 const answer=verifyReplayAnswer({...body,cacheSha256:jsonHash(body)});
 const result:DocumentResult={schemaVersion:'stadtstack-document-result-v2',taskId:hash('synthetic task'),groupId:hash('synthetic group'),provider:identity.provider,purpose:'production',municipalityId:municipality.id,sourceSha256,preparedSha256:prepared.receiptSha256,promptSha256:jsonHash({extraction:archive.promptSha256,judge:archive.judgePromptSha256,extractorSha256:archive.extractorSha256}),schemaSha256:archive.schemaSha256,generatedAt:at,records:[],quarantine:[{documentId:'document:'+sourceSha256,municipalityId:municipality.id,sourceId:reference.id,sourceSha256,chunk:0,reason:'No supported case in source excerpt'}],chunks:[{index:0,outcome:'no_case',responseSha256:answer.responseSha256,recordId:null}]};
 return {result,prepared,municipality,historical,identities:[identity],answers:new Map([[answer.binding,answer]]),answer,sourceInput};
}

async function admittedFixture(){
 const text='Stadt Strausberg\nWärmeplanung\nDer Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.\nStand: 10.10.2026',fixture=await noCaseFixture(text),{prepared,municipality,historical}=fixture,{archive}=historical;
 const raw=schema.DistrictExtractionClaimsSchema.parse({title:'Wärmeplanung',titleQuote:'Wärmeplanung',summary:'Der Entwurf der Wärmeplanung wurde veröffentlicht.',summaryQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',municipalityQuote:'Stadt Strausberg',caseKey:null,caseKeyType:'source_document',caseQuote:null,caseType:'planning',documentDate:'2026-10-10',documentDateQuote:'Stand: 10.10.2026',documentDateReason:null,topics:[{id:'waermeplanung',parentId:'energie',provenance:'model',confidence:0.9,quote:'Wärmeplanung'}],stage:'draft',stageDate:'2026-10-09',stageDateQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stageDateReason:null,originalStatus:'Entwurf',stageQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stages:[],entities:[],relations:[],locations:[]});
 const extractionBody={binding:fixture.answer.binding,modelIdentitySha256:identity.modelIdentitySha256,receivedAt:at,value:{record:raw,reason:'Synthetic grounded case'},responseSha256:hash('synthetic case raw response'),returnedModel:identity.model,runtimeWarnings:[]},answer=verifyReplayAnswer({...extractionBody,cacheSha256:jsonHash(extractionBody)});
 const chunk=claims.documentChunks(prepared.text)[0],restored=claims.restoreSourceQuotes(raw,chunk.text,chunk.start),deterministic=claims.deterministicChecks(restored.claims,chunk.text,municipality.name);
 assert.equal(deterministic.passed,true);
 const judgeBody={binding:replayAnswerBinding(identity,archive.judgeInstructions,{source:{text:chunk.text},candidate:restored.claims},archive.judgeSchema),modelIdentitySha256:identity.modelIdentitySha256,receivedAt:later,value:{score:0.91,reason:'Synthetic actual historical judgment',criticalUnsupported:false},responseSha256:hash('synthetic raw judge response'),returnedModel:identity.model,runtimeWarnings:[]},judge=verifyReplayAnswer({...judgeBody,cacheSha256:jsonHash(judgeBody)});
 const references=prepared.references.map(reference=>({...reference,locator:`text-sha256:${prepared.textSha256};chars:${chunk.start}-${chunk.end}`})),caseKey='source_document:'+prepared.sourceSha256;
 const cacheKey=claims.extractionCacheKey({provider:identity.provider,documentHash:prepared.sourceSha256,textHash:prepared.textSha256,extractorHash:archive.extractorSha256,modelIdentitySha256:identity.modelIdentitySha256,chunk:{index:chunk.index,start:chunk.start,end:chunk.end},municipalityId:municipality.id,sourceBinding:JSON.stringify(municipality)});
 const candidate={...restored.claims,...graph.normalizeGraphClaims(restored.claims,{municipalityId:municipality.id,sourceSha256:prepared.sourceSha256}),id:`knowledge:${municipality.id}:${hash(`${caseKey}\n${prepared.sourceSha256}\n${chunk.index}`).slice(0,24)}`,municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,caseKey,sources:references,
  extraction:{extractorVersion:archive.extractorVersion,extractorSha256:archive.extractorSha256,...identity,returnedModel:answer.returnedModel,runtimeWarnings:answer.runtimeWarnings,quoteNormalization:restored.normalization,promptVersion:archive.promptVersion,promptSha256:archive.promptSha256,judgePromptVersion:archive.judgePromptVersion,judgePromptSha256:archive.judgePromptSha256,inputSha256:prepared.sourceSha256,textSha256:prepared.textSha256,responseSha256:answer.responseSha256,ocrUsed:prepared.ocrUsed,textMethod:prepared.method,documentLimitations:[...prepared.limitations,models.PROVIDER_CONFIGS[identity.provider].toolLimitation],cacheKey,extractedAt:answer.receivedAt,chunk:{index:chunk.index,count:chunk.count,start:chunk.start,end:chunk.end}},
  verification:{status:'auto-verified' as const,deterministic,faithfulness:{score:judgeBody.value.score,threshold:0.8,model:identity.model,provider:identity.provider,tool:identity.tool,toolVersion:identity.toolVersion,modelIdentitySha256:identity.modelIdentitySha256,returnedModel:judge.returnedModel,runtimeWarnings:judge.runtimeWarnings,reason:judgeBody.value.reason,evaluatedAt:judge.receivedAt,responseSha256:judge.responseSha256,sameModel:true as const,limitation:claims.LIMITATION},evidenceHash:''}};
 candidate.verification.evidenceHash=schema.knowledgeEvidenceHash(candidate);
 const record=claims.rebindSourceReferences(schema.DistrictKnowledgeRecordSchema.parse(candidate),references);
 fixture.result.records=[record];fixture.result.quarantine=[];fixture.result.chunks=[{index:0,outcome:'admitted',responseSha256:answer.responseSha256,recordId:record.id}];
 fixture.answers=new Map([[answer.binding,answer],[judge.binding,judge]]);
 return {...fixture,answer,judge,record};
}

test('completed admission requires original extraction and judge receipts without rewriting provenance',async()=>{
 const fixture=await admittedFixture(),original=structuredClone(fixture.record);
 assert.deepEqual(verifyCachedGeneration(fixture),{generationAnswers:1,judgeAnswers:1});
 assert.deepEqual(fixture.result.records[0],original);
 assert.equal(original.extraction.extractedAt,at);assert.equal(original.verification.faithfulness.evaluatedAt,later);
 assert.equal(original.documentDate,'2026-10-10');assert.equal(original.stageDate,'2026-10-09');
 assert.equal(original.extraction.extractorVersion,'district-extractor-v8-joint-graph');
 fixture.answers.delete(fixture.judge.binding);
 assert.throws(()=>verifyCachedGeneration(fixture),/bound historical answer missing; live generation is forbidden/);
});

test('completed result cannot inherit a changed score, generation timestamp or source locator',async()=>{
 const fixture=await admittedFixture();
 for(const changed of ['score','timestamp','locator'] as const){
  const result=structuredClone(fixture.result),record=result.records[0];
  if(changed==='score')record.verification.faithfulness.score=1;
  else if(changed==='timestamp')record.extraction.extractedAt=later;
  else record.sources[0].locator='text-sha256:'+record.extraction.textSha256+';chars:1-2';
  record.verification.evidenceHash=schema.knowledgeEvidenceHash(record);
  assert.throws(()=>verifyCachedGeneration({...fixture,result}),/differs from original/);
 }
});

test('answer validation seals original field order, value and actual receipt timestamp',()=>{
 const body={binding:hash('binding'),modelIdentitySha256:identity.modelIdentitySha256,receivedAt:at,value:{record:null,reason:'Synthetic'},responseSha256:hash('raw response'),returnedModel:identity.model,runtimeWarnings:[]},answer={...body,cacheSha256:jsonHash(body)};
 assert.equal(verifyReplayAnswer(answer).receivedAt,at);
 assert.throws(()=>verifyReplayAnswer({...answer,receivedAt:later}),/digest/);
 assert.throws(()=>verifyReplayAnswer({...answer,value:{record:null,reason:'changed'}}),/digest/);
 const reordered={value:body.value,binding:body.binding,modelIdentitySha256:body.modelIdentitySha256,receivedAt:body.receivedAt,responseSha256:body.responseSha256,returnedModel:body.returnedModel,runtimeWarnings:body.runtimeWarnings,cacheSha256:answer.cacheSha256};
 assert.throws(()=>verifyReplayAnswer(reordered),/digest/);
});

test('historical archive pins original source order, every source body and schema/prompt digest',()=>{
 const archive=syntheticArchive();assert.deepEqual(verifyGenerationArchive(archive),archive);
 const sourceChanged=structuredClone(archive);sourceChanged.sources[0].code+='changed';assert.throws(()=>verifyGenerationArchive(sourceChanged),/digest/);
 const reordered=structuredClone(archive);reordered.sources.reverse();assert.throws(()=>verifyGenerationArchive(reordered),/inventory/);
 assert.throws(()=>verifyGenerationArchive({...archive,extractorVersion:claims.EXTRACTOR_VERSION}),/Invalid/);
 assert.throws(()=>verifyGenerationArchive({...archive,judgeInstructions:'different prompt'}),/digest/);
 assert.throws(()=>verifyGenerationArchive({...archive,outputSchema:{type:'null'}}),/digest/);
});

test('cache-only no-case replay preserves original hold and timestamps without readiness',async()=>{
 const fixture=await noCaseFixture(),before=structuredClone(fixture.result);
 assert.deepEqual(verifyCachedGeneration(fixture),{generationAnswers:1,judgeAnswers:0});
 assert.deepEqual(fixture.result,before);assert.equal(fixture.result.generatedAt,at);assert.equal(fixture.answer.receivedAt,at);
});

test('missing or differently prompted actual answer fails closed, never becomes no-case',async()=>{
 const fixture=await noCaseFixture();fixture.answers.clear();
 assert.throws(()=>verifyCachedGeneration(fixture),/missing or ambiguous; live generation is forbidden/);
 const wrong={...fixture.answer,binding:replayAnswerBinding(identity,claims.EXTRACTION_INSTRUCTIONS,fixture.sourceInput,fixture.historical.archive.outputSchema)};
 fixture.answers.set(wrong.binding,wrong);
 assert.throws(()=>verifyCachedGeneration(fixture),/missing or ambiguous/);
});

test('original task, source, schema, municipality and identity cannot be rebound to newer evidence',async()=>{
 const fixture=await noCaseFixture();
 for(const patch of [{sourceSha256:hash('other source')},{preparedSha256:hash('other prepared')},{schemaSha256:hash('other schema')},{promptSha256:hash('other prompt')},{municipalityId:'other-city'}])assert.throws(()=>verifyCachedGeneration({...fixture,result:{...fixture.result,...patch}}),/binding mismatch/);
 assert.throws(()=>verifyCachedGeneration({...fixture,identities:[{...identity,toolVersion:'newer-cli'}]}),/identity mismatch/);
 const changedAnswer={...fixture.answer,returnedModel:'different-model'};
 assert.throws(()=>verifyCachedGeneration({...fixture,answers:new Map([[changedAnswer.binding,changedAnswer]])}),/model binding/);
 const changedText={...fixture.prepared,text:'Another source body'};
 assert.throws(()=>verifyCachedGeneration({...fixture,prepared:changedText}),/missing or ambiguous/);
});

test('no-case cannot hide a changed outcome, fabricated reason, missing chunk or unrelated quarantine',async()=>{
 const fixture=await noCaseFixture();
 const wrongOutcome=structuredClone(fixture.result);wrongOutcome.chunks[0].outcome='rejected';assert.throws(()=>verifyCachedGeneration({...fixture,result:wrongOutcome}),/withheld outcome/);
 const wrongReason=structuredClone(fixture.result);wrongReason.quarantine[0].reason='Not attempted';assert.throws(()=>verifyCachedGeneration({...fixture,result:wrongReason}),/explicit hold/);
 const wrongSource=structuredClone(fixture.result);wrongSource.quarantine[0].sourceSha256=hash('other source');assert.throws(()=>verifyCachedGeneration({...fixture,result:wrongSource}),/inventory/);
 assert.throws(()=>verifyCachedGeneration({...fixture,result:{...fixture.result,chunks:[]}}),/chunk coverage/);
 const absentHold=structuredClone(fixture.result);absentHold.quarantine=[];assert.throws(()=>verifyCachedGeneration({...fixture,result:absentHold}),/inventory/);
});

test('release proof requires every member hash/size AND exact manifest bytes, not only ID/count',()=>{
 const files:DataRelease['files']=[{path:'catalogue.json',sha256:hash('synthetic catalogue'),bytes:19},{path:'knowledge/records.json',sha256:hash('synthetic records'),bytes:17}],manifest:DataRelease={schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt:later,files,quality:{publishedRecords:1,quarantinedRecords:0,cities:1}},bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
 assert.equal(compareReplayRelease(bytes,bytes,manifest).releaseId,manifest.id);
 const changed=structuredClone(manifest);changed.files[1].sha256=hash('different records');assert.throws(()=>compareReplayRelease(bytes,Buffer.from(JSON.stringify(changed)),changed),/member digest/);
 const wrongSize=structuredClone(manifest);wrongSize.files[1].bytes++;assert.throws(()=>compareReplayRelease(bytes,bytes,wrongSize),/member digest/);
 const missing=structuredClone(manifest);missing.files.pop();assert.throws(()=>compareReplayRelease(bytes,bytes,missing),/member digest/);
 const newer={...manifest,generatedAt:at};assert.equal(dataReleaseId(newer.files),manifest.id);assert.throws(()=>compareReplayRelease(bytes,Buffer.from(JSON.stringify(newer,null,2)+'\n'),newer),/manifest bytes/);
 assert.throws(()=>compareReplayRelease(bytes,Buffer.from(JSON.stringify(manifest)),manifest),/manifest bytes/);
});

test('pinned input reader rejects changed bytes and target-output reuse including symlink aliases',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-replay-pin-'));
 try{
  const bytes='synthetic pinned evidence\n';await writeFile(join(directory,'input.json'),bytes);
  assert.equal((await readReplayPin({path:'input.json',sha256:hash(bytes)},directory)).toString(),bytes);
  await assert.rejects(readReplayPin({path:'input.json',sha256:hash('changed')},directory),/digest/);
  // The released catalogue exists in the tracked checkout; it is never read by this test.
  await symlink(join(outDir,'catalogue.json'),join(directory,'target-alias.json'));
  await assert.rejects(readReplayPin({path:'target-alias.json',sha256:hash('unused')},directory),/forbids target/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('receipt requires exact clocks, full private/public prerequisites and has no live execution option',()=>{
 const pin={path:'synthetic-input.json',sha256:hash('synthetic pin')};
 const receipt:ReplayReceipt={schemaVersion:'stadtstack-offline-replay-v1',corpusManifest:pin,rawRoot:'raw',registry:pin,index:pin,frozen:pin,deltas:[],generationContract:pin,answers:[],modelIdentities:[identity],extractionRun:pin,clocks,staging:[{...pin,destination:'catalogue.json'}],coreEvidence:[{path:'pdf/'+hash('synthetic PDF')+'.pdf',sha256:hash('synthetic PDF')}],priorRelease:{gitCommit:'a'.repeat(40),manifestSha256:hash('prior manifest'),releaseId:hash('prior release')},expectedRelease:pin,runtime:{node:'synthetic',icu:'synthetic',unicode:'synthetic',locale:'de-DE',timeZone:'Europe/Berlin',packageLockSha256:hash('lock'),sourceFiles:[pin]},workspace:'cache/synthetic-fresh-replay'};
 assert.deepEqual(ReplayReceiptSchema.parse(receipt),receipt);
 assert.throws(()=>ReplayReceiptSchema.parse({...receipt,allowLiveModel:true}),/Unrecognized/);
 assert.throws(()=>ReplayReceiptSchema.parse({...receipt,coreEvidence:[]}),/Too small/);
 assert.throws(()=>ReplayReceiptSchema.parse({...receipt,priorRelease:undefined}),/Invalid/);
 assert.throws(()=>ReplayClocksSchema.parse({...clocks,coverageGeneratedAt:'now'}),/Invalid/);
 assert.throws(()=>ReplayReceiptSchema.parse({...receipt,staging:[{...pin,destination:'knowledge/records.json'}]}),/Invalid/);
 assert.deepEqual(requiredReplayStaging(['b','a']),['catalogue.json','cities/a/feed.json','cities/a/signals.geojson','cities/b/feed.json','cities/b/signals.geojson','core/strausberg-facts.json','regions/brandenburg-mol/topics.json']);
});

test('prior release Git paths resolve from the nested data package, not repository root',async()=>{
 const bytes=await readCommittedReleaseFile('HEAD','release-manifest.json');
 const manifest=JSON.parse(bytes.toString('utf8')) as DataRelease;
 assert.match(manifest.id,/^[a-f0-9]{64}$/);
 assert.equal(dataReleaseId(manifest.files),manifest.id);
 assert.ok(manifest.files.some(file=>file.path==='knowledge/records.json'));
});
