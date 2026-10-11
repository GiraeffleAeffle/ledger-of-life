import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256, knowledgeEvidenceHash, DistrictKnowledgeRecordSchema, type DistrictExtractionClaims} from '../src/district-schema.ts';
import {normalizeGraphClaims} from '../src/district-graph-claims.ts';
import {documentChunks, deterministicChecks, JUDGE_INSTRUCTIONS, JUDGE_PROMPT_VERSION, JUDGE_PROMPT_SHA256, judgeJSONSchema, LIMITATION} from '../src/district-claims.ts';
import {prepareDocument, type PreparedSourceReference} from '../src/district-prepared-document.ts';
import {PILOT_COMPLETION_CORPUS_SHA256} from '../src/district-corpus.ts';
import {createWorkPlan} from '../src/district-work-plan.ts';
import {PROVIDER_CONFIGS, EMPTY_USAGE, type ModelEvidence, type ModelAnswer} from '../src/district-model-contract.ts';
import {REASSESSMENT_VERSION, assessExistingRelation, materializeReassessment, executeReassessmentPass, mergeReassessmentDeltas, validateFrozenReassessment, assertNativeReassessmentHost, relationDateEligible, reassessmentJudgeBinding, reassessmentDeltaHash, type ReassessmentContract, type FrozenReassessment, type JudgeOnlyRuntime, type ReassessmentDelta, type ReassessmentJudgeEvidence} from '../src/district-reassess-relations.ts';

// Every source, generation receipt and judge score below is synthetic test data.
// No real model, authentication, network, extraction, or external document command is used.
const at='2026-10-10T12:00:00.000Z';
const hash=(value:unknown)=>sha256(JSON.stringify(value));
const blob=(value:unknown)=>{const bytes=JSON.stringify(value);return {bytes,sha256:sha256(bytes)};};
const contract:ReassessmentContract={version:REASSESSMENT_VERSION,judgePromptVersion:JUDGE_PROMPT_VERSION,judgePromptSha256:JUDGE_PROMPT_SHA256,judgeSchemaSha256:hash(judgeJSONSchema),assessorSha256:sha256('synthetic assessor code contract'),threshold:0.8};
const legacyContract={promptSha256:sha256('synthetic legacy joint contract'),schemaSha256:sha256('synthetic legacy schema'),extractorSha256:sha256('synthetic legacy extractor')};
const generationAnswer=(identity:ModelEvidence,claims:DistrictExtractionClaims)=>{
  const body={binding:sha256('synthetic original extraction request'),modelIdentitySha256:identity.modelIdentitySha256,receivedAt:at,value:{record:claims,reason:'Synthetic case'},responseSha256:sha256('synthetic original raw response'),returnedModel:identity.model,runtimeWarnings:[]};
  return {...body,cacheSha256:hash(body)};
};
async function fixture(options:{dated?:boolean;bad?:'endpoint'|'phrase';kind?:'planning'|'unchanged';admitted?:boolean;balanced?:boolean}={}) {
  const dated=options.dated!==false,kind=options.kind??'planning';
  const quote=kind==='unchanged'?'Test Netz GmbH betreibt Test Wärmenetz.':'Test Netz GmbH plant den Ausbau von Test Wärmenetz.';
  const relationQuote=options.bad==='endpoint'?'Test Netz GmbH plant den Ausbau.':quote;
  const text=['Strausberg',dated?'Stand 10.10.2026':'Ohne Dokumentdatum',quote,...(relationQuote!==quote?[relationQuote]:[])].join('\n');
  const sourceSha256=sha256(text);
  const reference:PreparedSourceReference={id:'synthetic-source',url:'https://example.org/synthetic-source',sha256:sourceSha256,retrievedAt:at,locator:'document-sha256:'+sourceSha256,mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
  const prepared=await prepareDocument({bytes:Buffer.from(text),municipalityId:'strausberg',references:[reference],mimeType:'text/plain',extractorSha256:sha256('synthetic preparation'),toolVersions:{node:'synthetic'}},async()=>{throw Error('Synthetic fixture must never execute an external document command');});
  const plan=createWorkPlan([{municipalityId:'strausberg',sourceSha256,preparedSha256:prepared.receiptSha256}],legacyContract,options.balanced?'balanced':'codex-only');
  const task=plan.tasks.find(task=>task.purpose==='production')!,config=PROVIDER_CONFIGS[task.provider];
  const identityBody={provider:task.provider,tool:config.tool,toolVersion:'synthetic-1',model:config.model,modelIdentityBasis:config.modelIdentityBasis};
  const identity:ModelEvidence={...identityBody,modelIdentitySha256:hash(identityBody)};
  const claims:DistrictExtractionClaims={title:'Strausberg',titleQuote:'Strausberg',summary:quote,summaryQuote:quote,municipalityQuote:'Strausberg',caseKey:null,caseKeyType:'source_document',caseQuote:null,caseType:'infrastructure',documentDate:dated?'2026-10-10':null,documentDateQuote:dated?'Stand 10.10.2026':null,documentDateReason:dated?null:'Synthetic undated source',topics:[],stage:'unknown',stageDate:null,stageDateQuote:null,stageDateReason:'No dated stage',originalStatus:'',stageQuote:'',stages:[],locations:[],entities:[{mentionId:'operator',name:'Test Netz GmbH',type:'company',quote:'Test Netz GmbH',identifiers:[]},{mentionId:'network',name:'Test Wärmenetz',type:'facility',quote:'Test Wärmenetz',identifiers:[]}],relations:[{fromMention:'operator',toMention:'network',type:kind==='unchanged'?'operates':'implements',quote:relationQuote,predicateQuote:options.bad==='phrase'?'Test Netz GmbH':kind==='unchanged'?'betreibt':'plant den Ausbau',modality:kind==='unchanged'?'asserted':'planned',time:null,conditions:null}]};
  const answer=generationAnswer(identity,claims),chunk=documentChunks(prepared.text)[0];
  const deterministic=deterministicChecks(claims,chunk.text,'Strausberg');
  // Model the historical rejection even if the new lexical gate has expanded.
  if(kind==='planning'){
    const check=deterministic.checks.find(check=>check.id==='graph_relations')!;check.passed=false;check.reason='Synthetic legacy unsupported planning relation type';deterministic.passed=false;
  }
  const admitted=options.admitted??kind==='unchanged';
  const recordValue={...claims,...normalizeGraphClaims(claims,{municipalityId:'strausberg',sourceSha256}),id:'knowledge:synthetic-replay',municipalityId:'strausberg',ags:'12064472',districtId:'maerkisch-oderland',caseKey:'source_document:'+sourceSha256,sources:[{...reference,locator:`text-sha256:${prepared.textSha256};chars:${chunk.start}-${chunk.end}`}],extraction:{extractorVersion:'synthetic-legacy-v8',extractorSha256:legacyContract.extractorSha256,...identity,returnedModel:identity.model,promptVersion:'district-claims-v7-joint-graph',promptSha256:sha256('synthetic actual old prompt'),judgePromptVersion:'synthetic-old-judge',judgePromptSha256:sha256('synthetic old judge prompt'),inputSha256:sourceSha256,textSha256:prepared.textSha256,responseSha256:answer.responseSha256,ocrUsed:false,textMethod:'text' as const,cacheKey:sha256('synthetic record cache'),extractedAt:at,chunk:{index:chunk.index,count:chunk.count,start:chunk.start,end:chunk.end}},verification:{status:admitted?'auto-verified' as const:'candidate' as const,deterministic,faithfulness:{score:admitted?0.9:null,threshold:0.8 as const,provider:identity.provider,tool:identity.tool,toolVersion:identity.toolVersion,model:identity.model,modelIdentitySha256:identity.modelIdentitySha256,returnedModel:admitted?identity.model:null,reason:'Synthetic fixture, not actual model evidence',evaluatedAt:admitted?at:null,responseSha256:admitted?sha256('synthetic original judge'):null,sameModel:true as const,limitation:LIMITATION},evidenceHash:'',...(!admitted?{reason:'Synthetic legacy rejection'}:{})}};
  recordValue.verification.evidenceHash=knowledgeEvidenceHash(recordValue);
  const record=DistrictKnowledgeRecordSchema.parse(recordValue);
  const result={schemaVersion:'stadtstack-document-result-v2',taskId:task.id,groupId:task.groupId,provider:task.provider,purpose:'production',municipalityId:'strausberg',sourceSha256,preparedSha256:prepared.receiptSha256,promptSha256:plan.promptSha256,schemaSha256:plan.schemaSha256,generatedAt:at,records:admitted?[record]:[],quarantine:admitted?[]:[{documentId:'document:'+sourceSha256,municipalityId:'strausberg',sourceId:reference.id,sourceSha256,chunk:0,reason:'Synthetic original rejection',candidate:record}],chunks:[{index:0,outcome:admitted?'admitted':'rejected',responseSha256:answer.responseSha256,recordId:record.id}]};
  const resultBlob=blob(result);task.state='completed';task.resultSha256=resultBlob.sha256;task.attempts=3;
  const municipality={id:'strausberg',name:'Strausberg',ags:record.ags,districtId:record.districtId};
  const expected={receiptSha256:prepared.receiptSha256,municipalityId:prepared.municipalityId,sourceSha256:prepared.sourceSha256,extractorSha256:prepared.extractorSha256,references:prepared.references,toolVersions:prepared.toolVersions};
  const preparation={schemaVersion:'stadtstack-preparation-plan-v1',generatedAt:at,corpusSha256:PILOT_COMPLETION_CORPUS_SHA256,registrySha256:sha256('synthetic registry'),extractorSha256:prepared.extractorSha256,maxDocumentsPerMunicipality:null,availableDocumentGroups:1,selectedDocumentGroups:1,selectedRepresentations:1,municipalities:[{...municipality,availableDocumentGroups:1,selectedDocumentGroups:1,selectedRepresentations:1}],groups:[{municipality,documentIds:['synthetic-document'],expected,referenceWarnings:[]}],quarantine:[]};
  const frozen:FrozenReassessment={version:REASSESSMENT_VERSION,frozenAt:at,contract,workPlan:blob(plan),preparationPlan:blob(preparation),documents:[{taskId:task.id,result:resultBlob,prepared:blob(prepared)}],answers:[blob(answer)]};
  return {frozen,frozenSha256:blob(frozen).sha256,plan,task,record,claims,prepared,identity,answer,result};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function assessment(f:Fixture){return assessExistingRelation({key:sha256('synthetic key'),record:f.record,prepared:f.prepared,municipalityName:'Strausberg',answers:[f.answer]});}
function runtime(f:Fixture,value:unknown={score:0.91,reason:'Synthetic judge fixture only',criticalUnsupported:false}) {
  const calls:Array<{system:string;input:unknown;purpose:string}>=[];
  const implementation:JudgeOnlyRuntime={readiness:async()=>f.identity,stopped:async()=>false,judge:async(provider,system,input,schema,usage)=>{
    calls.push({system,input,purpose:usage.purpose});
    assert.equal(provider,f.task.provider);assert.equal(system,JUDGE_INSTRUCTIONS);assert.equal(usage.purpose,'judge');assert.deepEqual(schema,judgeJSONSchema);
    const answer:ModelAnswer={value,responseSha256:sha256('synthetic new actual judge response'),returnedModel:f.identity.model,runtimeWarnings:[],evidence:f.identity,requestedModel:f.identity.model,reportedModels:[f.identity.model],usage:EMPTY_USAGE};return answer;
  }};
  return {implementation,calls};
}
async function pass(f:Fixture,implementation:JudgeOnlyRuntime){return executeReassessmentPass({frozen:f.frozen,frozenSha256:f.frozenSha256,contract,provider:f.task.provider,platform:f.task.provider==='openai-subscription'?'linux':'darwin',runtime:implementation,usage:{ledgerPath:'synthetic-unused-ledger',pausePath:'synthetic-unused-pause'}});}
function merge(f:Fixture,deltas:ReassessmentDelta[]=[]){return mergeReassessmentDeltas({frozen:f.frozen,frozenSha256:f.frozenSha256,contract,deltas});}
function reseal(delta:ReassessmentDelta){const {deltaSha256:_old,...body}=delta;delta.deltaSha256=reassessmentDeltaHash(body);return delta;}

test('existing planning triple changes type, never becomes implementation, and never calls extraction',async()=>{
  const f=await fixture(),r=runtime(f),a=assessment(f);
  assert.equal(a.claims?.relations[0].type,'plans');assert.equal(a.claims?.relations[0].modality,'planned');assert.equal(a.deterministic?.passed,true);assert.equal(a.newlyPassed,true);
  assert.equal(a.deterministic?.checks.length,21);assert.ok(a.normalization);
  const delta=await pass(f,r.implementation),merged=merge(f,[delta]);
  assert.equal(r.calls.length,1);assert.ok(r.calls.every(call=>call.system===JUDGE_INSTRUCTIONS&&call.purpose==='judge'));
  assert.equal(merged.records.length,1);assert.equal(merged.records[0].relations[0].type,'plans');assert.equal(merged.records[0].relations[0].modality,'planned');
  assert.equal(merged.report.counts.judgeCalls,1);assert.equal(merged.report.counts.judgePasses,1);assert.equal(merged.report.byTypeModality['plans:planned'].normalized,1);
});
test('original generation response, timestamp, tool and prompt provenance survive actual reassessment',async()=>{
  const f=await fixture(),r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]),record=merged.records[0];
  for(const key of ['responseSha256','extractedAt','model','tool','toolVersion','modelIdentitySha256','promptVersion','promptSha256','judgePromptVersion','judgePromptSha256','extractorSha256'] as const)assert.equal(record.extraction[key],f.record.extraction[key]);
  assert.equal(record.extraction.relationNormalization?.responseSha256,f.record.extraction.responseSha256);
  assert.notEqual(record.verification.evidenceHash,f.record.verification.evidenceHash);assert.equal(record.verification.evidenceHash,knowledgeEvidenceHash(record));
  assert.equal(record.verification.faithfulness.responseSha256,sha256('synthetic new actual judge response'));
  assert.ok(record.verification.faithfulness.evaluatedAt);assert.equal(record.verification.faithfulness.threshold,0.8);
  assert.equal(merged.results[0].generatedAt,at);assert.equal(merged.results[0].promptSha256,f.plan.promptSha256);
});
test('changed claims cannot inherit a score and require current bound actual judgment',async()=>{
  const f=await fixture(),a=assessment(f),decision=materializeReassessment(a,null,contract);
  assert.equal(decision.admitted,false);assert.equal(decision.hold,'current_actual_judge_missing');assert.equal(decision.record.verification.faithfulness.score,null);
  assert.equal(merge(f).records.length,0);
});
for(const bad of ['endpoint','phrase'] as const)test('missing '+bad+' remains rejected without judge or extraction calls',async()=>{
  const f=await fixture({bad}),r=runtime(f),a=assessment(f);
  assert.equal(a.deterministic?.passed,false);const merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,0);assert.equal(merged.records.length,0);assert.equal(merged.report.counts.stillWithheld,1);
});
for(const value of [{score:0.79,reason:'Synthetic below threshold',criticalUnsupported:false},{score:0.95,reason:'Synthetic critical unsupported',criticalUnsupported:true},{score:'unknown',reason:'Synthetic invalid answer',criticalUnsupported:false}])test('failed, critical, or invalid actual judge stays held: '+JSON.stringify(value),async()=>{
  const f=await fixture(),r=runtime(f,value),merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,1);assert.equal(merged.records.length,0);assert.equal(merged.report.counts.judgeFails,1);assert.equal(merged.report.counts.stillWithheld,1);
});
test('missing dates remain withheld; an unknown stage with a document date is individually eligible',async()=>{
  const f=await fixture({dated:false}),r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,0);assert.equal(merged.records.length,0);assert.equal(merged.report.counts.dateEligible,0);assert.equal(merged.quarantine[0].reason,'date_missing');
  assert.equal(relationDateEligible({documentDate:'2026-10-10',stageDate:null,stages:[]}),true);
  assert.equal((await fixture()).record.stage,'unknown');
});
test('unchanged admitted relations and original attempt counters are preserved without new judgment',async()=>{
  const f=await fixture({kind:'unchanged'}),r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,0);assert.deepEqual(merged.records,[f.record]);assert.deepEqual(merged.report.preserved.workPlan,f.plan);assert.equal(merged.report.counts.reusedUnchanged,1);
});
test('actual cached judgment is reusable only for identical current input and contract',async()=>{
  const f=await fixture(),a=assessment(f),body={binding:reassessmentJudgeBinding(f.task.provider,f.identity,a.judgeInput),modelIdentitySha256:f.identity.modelIdentitySha256,receivedAt:at,value:{score:0.9,reason:'Synthetic cached actual judge fixture',criticalUnsupported:false},responseSha256:sha256('synthetic cached judge response'),returnedModel:f.identity.model,runtimeWarnings:[]};
  f.frozen.answers.push(blob({...body,cacheSha256:hash(body)}));f.frozenSha256=blob(f.frozen).sha256;
  const r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,0);assert.equal(merged.records.length,1);assert.equal(merged.report.counts.judgeCalls,0);assert.equal(merged.report.counts.judgePasses,1);
  const changed=structuredClone(f);const wrong={...body,binding:sha256('different actual judge input')};changed.frozen.answers[1]=blob({...wrong,cacheSha256:hash(wrong)});changed.frozenSha256=blob(changed.frozen).sha256;
  const r2=runtime(changed);await pass(changed,r2.implementation);assert.equal(r2.calls.length,1);
});
test('native host check and provider filtering happen before readiness or model invocation',async()=>{
  assert.throws(()=>assertNativeReassessmentHost('openai-subscription','darwin'),/native host/);
  assert.throws(()=>assertNativeReassessmentHost('anthropic-subscription','linux'),/native host/);
  const f=await fixture(),r=runtime(f);
  const delta=await executeReassessmentPass({frozen:f.frozen,frozenSha256:f.frozenSha256,contract,provider:'anthropic-subscription',platform:'darwin',runtime:r.implementation,usage:{ledgerPath:'unused',pausePath:'unused'}});
  assert.equal(delta.entries.length,0);assert.equal(r.calls.length,0);assert.equal(merge(f,[delta]).records.length,0);
});
test('delta merge rejects foreign source/input/identity/contract and duplicate providers',async()=>{
  const f=await fixture(),r=runtime(f),delta=await pass(f,r.implementation);
  const foreign=structuredClone(delta);foreign.frozenSha256=sha256('different frozen run');assert.throws(()=>merge(f,[reseal(foreign)]),/binding mismatch/);
  const wrongInput=structuredClone(delta);wrongInput.entries[0].judge!.inputSha256=sha256('different source chunk');assert.throws(()=>merge(f,[reseal(wrongInput)]),/input\/identity/);
  const wrongContract=structuredClone(delta);wrongContract.contract.judgePromptVersion='other';assert.throws(()=>merge(f,[reseal(wrongContract)]),/contract mismatch/);
  const wrongClaims=structuredClone(delta);wrongClaims.entries[0].claimsSha256=sha256('different triple');assert.throws(()=>merge(f,[reseal(wrongClaims)]),/claim mismatch/);
  const wrongIdentity=structuredClone(delta);wrongIdentity.entries[0].judge!.identity.toolVersion='changed';assert.throws(()=>merge(f,[reseal(wrongIdentity)]),/identity binding/);
  assert.throws(()=>merge(f,[delta,delta]),/binding mismatch/);
});
test('missing raw generation evidence and unrecognized raw relation enums fail closed',async()=>{
  const f=await fixture(),r=runtime(f);f.frozen.answers=[];f.frozenSha256=blob(f.frozen).sha256;
  const missing=merge(f,[await pass(f,r.implementation)]);assert.equal(r.calls.length,0);assert.equal(missing.records.length,0);assert.equal(missing.quarantine[0].reason,'raw_generation_evidence_missing_or_ambiguous');
  const other=await fixture(),raw=JSON.parse(other.frozen.answers[0].bytes);raw.value.record.relations[0].type='owns';const {cacheSha256:_hash,...body}=raw;raw.cacheSha256=hash(body);other.frozen.answers[0]=blob(raw);other.frozenSha256=blob(other.frozen).sha256;
  const unknown=merge(other);assert.equal(unknown.records.length,0);assert.equal(unknown.quarantine[0].reason,'raw_relation_candidate_unknown');
});
test('native identity changes and pause errors remain held without model calls',async()=>{
  const f=await fixture(),r=runtime(f),identityBody={provider:f.identity.provider,tool:f.identity.tool,toolVersion:'synthetic-2',model:f.identity.model,modelIdentityBasis:f.identity.modelIdentityBasis};
  r.implementation.readiness=async()=>({...identityBody,modelIdentitySha256:hash(identityBody)});
  const merged=merge(f,[await pass(f,r.implementation)]);assert.equal(r.calls.length,0);assert.equal(merged.records.length,0);assert.equal(merged.report.counts.judgeCalls,0);
  const paused=runtime(f);paused.implementation.stopped=async()=>true;const delta=await pass(f,paused.implementation);
  assert.equal(paused.calls.length,0);assert.equal(delta.entries[0].failure?.failureCategory,'operator_pause');
});
test('a successful pass can resume from its exact persisted judge evidence with zero extra calls',async()=>{
  const f=await fixture(),r=runtime(f);let saved:ReassessmentJudgeEvidence|null=null;
  const options={frozen:f.frozen,frozenSha256:f.frozenSha256,contract,provider:f.task.provider,platform:'linux' as const,runtime:r.implementation,usage:{ledgerPath:'unused',pausePath:'unused'}};
  await executeReassessmentPass({...options,save:async(_key,evidence)=>{saved=evidence;}});assert.ok(saved);assert.equal(r.calls.length,1);
  const delta=await executeReassessmentPass({...options,load:async()=>saved});assert.equal(r.calls.length,1);assert.equal(merge(f,[delta]).records.length,1);
});
test('frozen hashes, active task boundary and completed-primary coverage cannot be forged',async()=>{
  const f=await fixture();validateFrozenReassessment(f.frozen,contract);
  const tampered=structuredClone(f.frozen);tampered.documents[0].prepared.bytes+=' ';assert.throws(()=>validateFrozenReassessment(tampered,contract),/byte binding/);
  const active=structuredClone(f.frozen),plan=JSON.parse(active.workPlan.bytes);plan.tasks[0].state='running';plan.tasks[0].resultSha256=null;active.workPlan=blob(plan);assert.throws(()=>validateFrozenReassessment(active,contract),/stopped frozen/);
  const missing=structuredClone(f.frozen);missing.documents=[];assert.throws(()=>validateFrozenReassessment(missing,contract),/inventory mismatch/);
});
test('no-case evidence and opaque quarantine are retained without reconstructing summary triples',async()=>{
  const f=await fixture(),result=structuredClone(f.result);result.records=[];result.quarantine=[{documentId:'document:'+f.prepared.sourceSha256,municipalityId:'strausberg',sourceId:'synthetic-source',sourceSha256:f.prepared.sourceSha256,chunk:0,reason:'No supported case in source excerpt'}] as typeof result.quarantine;result.chunks=[{index:0,outcome:'no_case',responseSha256:f.answer.responseSha256,recordId:null}] as unknown as typeof result.chunks;
  const updated=blob(result);f.frozen.documents[0].result=updated;f.plan.tasks[0].resultSha256=updated.sha256;f.frozen.workPlan=blob(f.plan);f.frozenSha256=blob(f.frozen).sha256;
  const r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]);assert.equal(r.calls.length,0);assert.deepEqual(merged.results[0],result);assert.equal(merged.report.preserved.noCaseChunks,1);
});
test('unchanged previously unjudged or failed facts are not opportunistically retried',async()=>{
  const f=await fixture({kind:'unchanged',admitted:false}),r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,0);assert.equal(merged.records.length,0);assert.equal(merged.quarantine[0].reason,'previous_judge_failed_or_unknown');
});

test('whole-document budget holds survive beside ordinary relation reassessment without model calls for the held document',async()=>{
 const f=await fixture(),text='Synthetic oversized source text. '.repeat(16000),sourceSha256=sha256(text);
 const reference={...f.prepared.references[0],url:'https://example.org/synthetic-budget',sha256:sourceSha256,locator:'document-sha256:'+sourceSha256};
 const prepared=await prepareDocument({bytes:Buffer.from(text),municipalityId:'strausberg',references:[reference],mimeType:'text/plain',extractorSha256:f.prepared.extractorSha256,toolVersions:f.prepared.toolVersions},async()=>{throw Error('No external fixture command');});
 assert.throws(()=>documentChunks(prepared.text),/Document exceeds model chunk limit/);
 const plan=createWorkPlan([{municipalityId:'strausberg',sourceSha256:f.prepared.sourceSha256,preparedSha256:f.prepared.receiptSha256},{municipalityId:'strausberg',sourceSha256,preparedSha256:prepared.receiptSha256}],legacyContract,'codex-only');
 const ordinaryTask=plan.tasks.find(task=>task.purpose==='production'&&task.group.sourceSha256===f.prepared.sourceSha256)!;
 const heldTask=plan.tasks.find(task=>task.purpose==='production'&&task.group.sourceSha256===sourceSha256)!;
 const ordinaryResult={...f.result,taskId:ordinaryTask.id,groupId:ordinaryTask.groupId};
 const heldResult={schemaVersion:'stadtstack-document-result-v2',taskId:heldTask.id,groupId:heldTask.groupId,provider:heldTask.provider,purpose:'production',municipalityId:'strausberg',sourceSha256,preparedSha256:prepared.receiptSha256,promptSha256:plan.promptSha256,schemaSha256:plan.schemaSha256,generatedAt:at,records:[],chunks:[],quarantine:[{documentId:'document:'+sourceSha256,municipalityId:'strausberg',sourceId:reference.id,sourceSha256,chunk:null,reason:'Document exceeds model chunk limit; entire document quarantined before model readiness (no truncation or model calls)'}]};
 const ordinaryBlob=blob(ordinaryResult),heldBlob=blob(heldResult);
 for(const [task,result] of [[ordinaryTask,ordinaryBlob],[heldTask,heldBlob]] as const){task.state='completed';task.resultSha256=result.sha256;}
 const preparation=JSON.parse(f.frozen.preparationPlan.bytes);
 preparation.availableDocumentGroups=2;preparation.selectedDocumentGroups=2;preparation.selectedRepresentations=2;
 Object.assign(preparation.municipalities[0],{availableDocumentGroups:2,selectedDocumentGroups:2,selectedRepresentations:2});
 preparation.groups.push({municipality:preparation.groups[0].municipality,documentIds:['synthetic-budget'],expected:{receiptSha256:prepared.receiptSha256,municipalityId:prepared.municipalityId,sourceSha256,extractorSha256:prepared.extractorSha256,references:prepared.references,toolVersions:prepared.toolVersions},referenceWarnings:[]});
 f.frozen.workPlan=blob(plan);f.frozen.preparationPlan=blob(preparation);
 f.frozen.documents=[{taskId:ordinaryTask.id,result:ordinaryBlob,prepared:blob(f.prepared)},{taskId:heldTask.id,result:heldBlob,prepared:blob(prepared)}];
 f.frozenSha256=blob(f.frozen).sha256;
 assert.equal(validateFrozenReassessment(f.frozen,contract).documents.length,2);
 const r=runtime(f);let readinessCalls=0;r.implementation.readiness=async()=>{readinessCalls++;return f.identity;};
 const merged=merge(f,[await pass(f,r.implementation)]);
 assert.equal(readinessCalls,1);assert.equal(r.calls.length,1);assert.equal(merged.records.length,1);
 assert.deepEqual(merged.results.find(result=>result.taskId===heldTask.id),heldResult);
 assert.ok(merged.quarantine.some(item=>item.chunk===null&&item.sourceSha256===sourceSha256));
 const forged=structuredClone(f.frozen),badResult=structuredClone(heldResult);
 badResult.quarantine[0].sourceSha256=sha256('synthetic wrong source');
 const badBlob=blob(badResult);forged.documents[1].result=badBlob;heldTask.resultSha256=badBlob.sha256;forged.workPlan=blob(plan);
 assert.throws(()=>validateFrozenReassessment(forged,contract),/whole-document budget evidence mismatch/);
});

test('judge-only readiness receives cancellation and cannot begin a judge after interruption',{timeout:2000},async()=>{
 const f=await fixture(),r=runtime(f),controller=new AbortController();
 let entered!:()=>void;const readinessEntered=new Promise<void>(resolve=>{entered=resolve;});
 r.implementation.readiness=async(_provider,signal)=>{
  entered();assert.equal(signal,controller.signal);assert.ok(signal);
  return new Promise<ModelEvidence>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 };
 const pending=executeReassessmentPass({frozen:f.frozen,frozenSha256:f.frozenSha256,contract,provider:f.task.provider,platform:'linux',runtime:r.implementation,usage:{ledgerPath:'unused',pausePath:'unused',signal:controller.signal}});
 await readinessEntered;controller.abort(Object.assign(Error('Synthetic operator interruption'),{failureCategory:'operator_pause'}));
 const delta=await pending;
 assert.equal(r.calls.length,0);assert.equal(delta.entries[0].judgeAttempted,false);assert.equal(delta.entries[0].judge,null);
 assert.equal(delta.entries[0].failure?.failureCategory,'operator_pause');
});
