import test from 'node:test';
import type {TestContext} from 'node:test';
import {join,basename} from 'node:path';
import {readFile,lstat,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import {recordHostOptOut,assertManagedSourceReadable,assertManagedSourceBindings,HostOptedOutError,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
import {writeManagedSourceArtifact,writeManagedSourceJson,writePrivateJson} from '../src/district-private-io.ts';
import type {SourceArtifactBinding} from '../src/district-private-io.ts';
import {knowledgePreparedSourcePinSchema} from '../src/prepare-knowledge.ts';
import assert from 'node:assert/strict';
import {sha256, knowledgeEvidenceHash, DistrictKnowledgeRecordSchema, type DistrictExtractionClaims, type DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {normalizeGraphClaims} from '../src/district-graph-claims.ts';
import {documentChunks, deterministicChecks, JUDGE_INSTRUCTIONS, JUDGE_PROMPT_VERSION, JUDGE_PROMPT_SHA256, judgeJSONSchema, LIMITATION} from '../src/district-claims.ts';
import {prepareDocument,cachePreparedDocument,preparedSourceBindings, type PreparedSourceReference, type PreparedDocument} from '../src/district-prepared-document.ts';
import {PILOT_COMPLETION_CORPUS_SHA256} from '../src/district-corpus.ts';
import {createWorkPlan,type WorkPlan,type WorkTask} from '../src/district-work-plan.ts';
import {documentResultSchema,type DocumentResult} from '../src/district-inference.ts';
import type {CachedAnswer} from '../src/district-answer-cache.ts';
import type {CivicPolicyOptions} from '../src/civic-opt-out.ts';
import {canonicalJson} from '../src/district-adapter-contract.ts';
import {PROVIDER_CONFIGS, EMPTY_USAGE, type ModelEvidence, type ModelAnswer} from '../src/district-model-contract.ts';
import {REASSESSMENT_VERSION, assessExistingRelation, materializeReassessment, executeReassessmentPass, mergeReassessmentDeltas, validateFrozenReassessment, assertNativeReassessmentHost, relationDateEligible, reassessmentJudgeBinding, reassessmentDeltaHash, freezeReassessment, mergeReassessment, FrozenReassessmentSchema, HistoricalFrozenReassessmentSchema, reassessmentArtifactPinSchema, type ReassessmentContract, type FrozenReassessment, type JudgeOnlyRuntime, type ReassessmentDelta, type ReassessmentJudgeEvidence} from '../src/district-reassess-relations.ts';
import {assembleRun,readTaskResult} from '../src/district-extract.ts';
import {preparationPlanSchema} from '../src/district-preparation-run.ts';
import {PoliteFetcher,sourceContentBinding} from '../src/polite-fetch.ts';
import type {FetchObservation} from '../src/polite-fetch.ts';
import {operatorRegistryConfigSchema,operatorRegistryConfigContractSha256,importOperatorRegistryConfig} from '../src/district-registry-config.ts';
import {retainedPublicationSources} from '../src/district-retained-import.ts';
import {MODEL_INPUT_BOUND_REASON,MAX_SUBSCRIPTION_INPUT_BYTES} from '../src/district-model.ts';
import {isProviderStopped} from '../src/district-model-usage.ts';

// Every source, generation receipt and judge score below is synthetic test data.
// Real isolated fixture authority only; no native model, network or external document command.
const at='2026-10-10T12:00:00.000Z';
const hash=(value:unknown)=>sha256(JSON.stringify(value));
const blob=(value:unknown)=>{const bytes=JSON.stringify(value);return {bytes,sha256:sha256(bytes)};};
test('reassessment source pins use the canonical closed publication binding codec',()=>{
 const prepared={kind:'prepared_source' as const,url:'https://example.org/synthetic',sourceSha256:sha256('synthetic original'),observationId:'synthetic-prepared',receiptSha256:sha256('synthetic prepared receipt'),independentAllowed:true};
 const http={...prepared,kind:'http_observation' as const,observationId:'synthetic-http',independentAllowed:false};
 const pin={path:'synthetic.json',sha256:sha256('synthetic artifact'),bytes:32,bindings:[prepared,http]};
 assert.deepEqual(reassessmentArtifactPinSchema.parse(pin),pin);
 for(const binding of [{...http,approved:true},{...http,independentAllowed:undefined},{...http,kind:'authenticated_git_snapshot'}])assert.equal(reassessmentArtifactPinSchema.safeParse({...pin,bindings:[binding]}).success,false);
});
const contract:ReassessmentContract={version:REASSESSMENT_VERSION,judgePromptVersion:JUDGE_PROMPT_VERSION,judgePromptSha256:JUDGE_PROMPT_SHA256,judgeSchemaSha256:hash(judgeJSONSchema),assessorSha256:sha256('synthetic assessor code contract'),threshold:0.8};
const legacyContract={promptSha256:sha256('synthetic legacy joint contract'),schemaSha256:sha256('synthetic legacy schema'),extractorSha256:sha256('synthetic legacy extractor')};
const generationAnswer=(identity:ModelEvidence,claims:DistrictExtractionClaims)=>{
  const body={binding:sha256('synthetic original extraction request'),modelIdentitySha256:identity.modelIdentitySha256,receivedAt:at,value:{record:claims,reason:'Synthetic case'},responseSha256:sha256('synthetic original raw response'),returnedModel:identity.model,runtimeWarnings:[]};
  return {...body,cacheSha256:hash(body)};
};
async function fixture(t:TestContext,options:{dated?:boolean;bad?:'endpoint'|'phrase';kind?:'planning'|'unchanged';admitted?:boolean;balanced?:boolean;legacyLaterChunk?:boolean;extraReference?:boolean;sourcePrefix?:string}={}):Promise<Fixture> {
  const context=await createCivicPolicyTestContext(t),preparedRoot=join(context.root,'prepared'),managedRoot=join(context.root,'artifacts');
  const dated=options.dated!==false,kind=options.kind??'planning';
  const quote=kind==='unchanged'?'Test Netz GmbH betreibt Test Wärmenetz.':'Test Netz GmbH plant den Ausbau von Test Wärmenetz.';
  const relationQuote=options.bad==='endpoint'?'Test Netz GmbH plant den Ausbau.':quote;
  const text=(options.sourcePrefix??'')+(options.legacyLaterChunk?'x'.repeat(5000)+'\n':'')+['Strausberg',dated?'Stand 10.10.2026':'Ohne Dokumentdatum',quote,...(relationQuote!==quote?[relationQuote]:[])].join('\n');
  const sourceSha256=sha256(text);
  const reference:PreparedSourceReference={id:'synthetic-source',url:'https://example.org/synthetic-source',sha256:sourceSha256,retrievedAt:at,locator:'document-sha256:'+sourceSha256,mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
  const references=options.extraReference?[reference,{...reference,id:'synthetic-alias',url:'https://example.net/synthetic-alias',policy:{...reference.policy,robots:{state:'allowed' as const,url:'https://example.net/robots.txt'}}}]:[reference];
  const prepared=await prepareDocument({bytes:Buffer.from(text),municipalityId:'strausberg',references,mimeType:'text/plain',extractorSha256:sha256('synthetic preparation'),toolVersions:{node:'synthetic',parser_isolation:'district-parser-isolation-v1',parser_image:'sha256:'+sha256('synthetic fixture parser image; not reviewed'),parser_contract:sha256('synthetic fixture parser contract; no actual execution')}},async()=>{throw Error('Synthetic fixture must never execute an external document command');});
  await cachePreparedDocument(preparedRoot,prepared,{decisionId:context.decisionId,...context.policy});
  const plan=createWorkPlan([{municipalityId:'strausberg',sourceSha256,preparedSha256:prepared.receiptSha256}],legacyContract,options.balanced?'balanced':'codex-only');
  const task=plan.tasks.find(task=>task.purpose==='production')!,config=PROVIDER_CONFIGS[task.provider];
  const identityBody={provider:task.provider,tool:config.tool,toolVersion:'synthetic-1',model:config.model,modelIdentityBasis:config.modelIdentityBasis};
  const identity:ModelEvidence={...identityBody,modelIdentitySha256:hash(identityBody)};
  const claims:DistrictExtractionClaims={title:'Strausberg',titleQuote:'Strausberg',summary:quote,summaryQuote:quote,municipalityQuote:'Strausberg',caseKey:null,caseKeyType:'source_document',caseQuote:null,caseType:'infrastructure',documentDate:dated?'2026-10-10':null,documentDateQuote:dated?'Stand 10.10.2026':null,documentDateReason:dated?null:'Synthetic undated source',topics:[],stage:'unknown',stageDate:null,stageDateQuote:null,stageDateReason:'No dated stage',originalStatus:'',stageQuote:'',stages:[],locations:[],entities:[{mentionId:'operator',name:'Test Netz GmbH',type:'company',quote:'Test Netz GmbH',identifiers:[]},{mentionId:'network',name:'Test Wärmenetz',type:'facility',quote:'Test Wärmenetz',identifiers:[]}],relations:[{fromMention:'operator',toMention:'network',type:kind==='unchanged'?'operates':'implements',quote:relationQuote,predicateQuote:options.bad==='phrase'?'Test Netz GmbH':kind==='unchanged'?'betreibt':'plant den Ausbau',modality:kind==='unchanged'?'asserted':'planned',time:null,conditions:null}]};
  const answer=generationAnswer(identity,claims),chunk=options.legacyLaterChunk?{index:1,count:2,start:3500,end:prepared.text.length,text:prepared.text.slice(3500)}:documentChunks(prepared.text)[0];
  const deterministic=deterministicChecks(claims,chunk.text,'Strausberg');
  // Model the historical rejection even if the new lexical gate has expanded.
  if(kind==='planning'){
    const check=deterministic.checks.find(check=>check.id==='graph_relations')!;check.passed=false;check.reason='Synthetic legacy unsupported planning relation type';deterministic.passed=false;
  }
  const admitted=options.admitted??kind==='unchanged';
  const recordValue={kind:'text_model' as const,...claims,...normalizeGraphClaims(claims,{municipalityId:'strausberg',sourceSha256,ags:'12064472'}),id:'knowledge:synthetic-replay',municipalityId:'strausberg',ags:'12064472',districtId:'maerkisch-oderland',caseKey:'source_document:'+sourceSha256,sources:prepared.references.map(reference=>({...reference,locator:`text-sha256:${prepared.textSha256};chars:${chunk.start}-${chunk.end}`})),extraction:{extractorVersion:'synthetic-legacy-v8',extractorSha256:legacyContract.extractorSha256,...identity,returnedModel:identity.model,promptVersion:'district-claims-v7-joint-graph',promptSha256:sha256('synthetic actual old prompt'),judgePromptVersion:'synthetic-old-judge',judgePromptSha256:sha256('synthetic old judge prompt'),inputSha256:sourceSha256,textSha256:prepared.textSha256,responseSha256:answer.responseSha256,ocrUsed:false,textMethod:'text' as const,cacheKey:sha256('synthetic record cache'),extractedAt:at,chunk:{index:chunk.index,count:chunk.count,start:chunk.start,end:chunk.end}},verification:{kind:'text_model' as const,status:admitted?'auto-verified' as const:'candidate' as const,deterministic,faithfulness:{score:admitted?0.9:null,threshold:0.8 as const,provider:identity.provider,tool:identity.tool,toolVersion:identity.toolVersion,model:identity.model,modelIdentitySha256:identity.modelIdentitySha256,returnedModel:admitted?identity.model:null,reason:'Synthetic fixture, not actual model evidence',evaluatedAt:admitted?at:null,responseSha256:admitted?sha256('synthetic original judge'):null,sameModel:true as const,limitation:LIMITATION},evidenceHash:'',...(!admitted?{reason:'Synthetic legacy rejection'}:{})}};
  recordValue.verification.evidenceHash=knowledgeEvidenceHash(recordValue);
  const record=DistrictKnowledgeRecordSchema.parse(recordValue);
  const result=documentResultSchema.parse({schemaVersion:'stadtstack-document-result-v2',taskId:task.id,groupId:task.groupId,provider:task.provider,purpose:'production',municipalityId:'strausberg',sourceSha256,preparedSha256:prepared.receiptSha256,promptSha256:plan.promptSha256,schemaSha256:plan.schemaSha256,generatedAt:at,records:admitted?[record]:[],quarantine:admitted?[]:[{documentId:'document:'+sourceSha256,municipalityId:'strausberg',sourceId:reference.id,sourceSha256,chunk:chunk.index,reason:'Synthetic original rejection',candidate:record}],chunks:[...(options.legacyLaterChunk?[{index:0,outcome:'no_case',responseSha256:sha256('synthetic first-window no-case response'),recordId:null}]:[]),{index:chunk.index,outcome:admitted?'admitted':'rejected',responseSha256:answer.responseSha256,recordId:record.id}]});
  const resultBlob=blob(result);task.state='completed';task.resultSha256=resultBlob.sha256;task.attempts=3;
  const municipality={id:'strausberg',name:'Strausberg',ags:record.ags,districtId:record.districtId};
  const expected={receiptSha256:prepared.receiptSha256,municipalityId:prepared.municipalityId,sourceSha256:prepared.sourceSha256,extractorSha256:prepared.extractorSha256,references:prepared.references,toolVersions:prepared.toolVersions};
  const preparation={schemaVersion:'stadtstack-preparation-plan-v1',generatedAt:at,corpusSha256:PILOT_COMPLETION_CORPUS_SHA256,registrySha256:sha256('synthetic registry'),extractorSha256:prepared.extractorSha256,maxDocumentsPerMunicipality:null,availableDocumentGroups:1,selectedDocumentGroups:1,selectedRepresentations:1,municipalities:[{...municipality,availableDocumentGroups:1,selectedDocumentGroups:1,selectedRepresentations:1}],groups:[{municipality,documentIds:['synthetic-document'],expected,referenceWarnings:[]}],quarantine:[]};
  const frozen:FrozenReassessment={version:REASSESSMENT_VERSION,frozenAt:at,contract,controlBindings:{workPlan:[],preparationPlan:[]},workPlan:blob(plan),preparationPlan:blob(preparation),documents:[{taskId:task.id,result:resultBlob,prepared:blob(prepared)}],answers:[blob(answer)]};
  return {frozen,frozenSha256:blob(frozen).sha256,plan,task,record,claims,prepared,identity,answer,result,root:context.root,policy:context.policy,preparedRoot,managedRoot};
}
test('assembly rejects preparation candidates without inventing a receipt from their evidence hash',async t=>{
 const f=await fixture(t),preparation=preparationPlanSchema.parse(JSON.parse(f.frozen.preparationPlan.bytes)),out=join(f.root,'uncreated-assembly');
 preparation.quarantine.push({documentId:'document:'+f.prepared.sourceSha256,municipalityId:f.prepared.municipalityId,sourceId:f.prepared.references[0].id,sourceSha256:f.prepared.sourceSha256,chunk:null,reason:'Synthetic invalid preparation candidate',candidate:f.record});
 await assert.rejects(assembleRun(preparation,f.plan,out,{path:join(f.root,'unread-registry-descriptor.json'),sha256:sha256('synthetic unread registry descriptor')},f.policy),/lacks an authenticated prepared receipt/);
 await assert.rejects(lstat(out),{code:'ENOENT'});
});
type Fixture={frozen:FrozenReassessment;frozenSha256:string;plan:WorkPlan;task:WorkTask;record:DistrictKnowledgeRecord;claims:DistrictExtractionClaims;prepared:PreparedDocument;identity:ModelEvidence;answer:CachedAnswer&{cacheSha256:string};result:DocumentResult;root:string;policy:CivicPolicyOptions;preparedRoot:string;managedRoot:string};
type ArtifactRole='result'|'prepared'|'answer';
type BindingFault='retained'|'config'|'receipt'|'extra'|'missing'|'nonindependent';
function faultyBindings(f:Fixture,fault:BindingFault,bytes:string):SourceArtifactBinding[]{
 const correct=preparedSourceBindings(f.prepared.references,f.prepared.receiptSha256),first=correct[0];
 if(fault==='receipt')return correct.map(binding=>({...binding,receiptSha256:sha256('synthetic unrelated prepared receipt')}));
 if(fault==='extra')return [...correct,{...first,url:'https://example.net/extra-contributor',sourceSha256:sha256('synthetic extra source representation'),observationId:'synthetic-extra-source',receiptSha256:sha256('synthetic extra prepared receipt')}];
 if(fault==='missing'){assert.ok(correct.length>1);return correct.slice(0,1);}
 if(fault==='nonindependent')return correct.map(binding=>({...binding,independentAllowed:false}));
 if(fault==='retained')return [{kind:'retained_publication',url:first.url,sourceSha256:first.sourceSha256,independentAllowed:false,publication:{manifestSha256:sha256('synthetic unrelated retained manifest'),releaseId:sha256('synthetic retained release'),memberPath:'knowledge/records.json',memberSha256:sha256(bytes),memberBytes:Buffer.byteLength(bytes)}}];
 const configurationSha256=sha256('synthetic operator configuration'),gitCommit='1'.repeat(40);
 return [{kind:'operator_registry_config',url:first.url,configurationSha256,schemaContractSha256:sha256('synthetic operator codec'),code:{gitCommit,path:'stadtstack-data/sources/district-registry.json',blobOid:'2'.repeat(40),sha256:configurationSha256,bytes:32},approval:{role:'district_source_registry',approver:'owner',decisionId:CIVIC_ACQUISITION_DECISION_ID,date:'2026-10-11',configurationSha256,gitCommit},independentAllowed:false}];
}
async function managedFreezeFixture(f:Fixture,override?:{role:ArtifactRole;fault:BindingFault}){
 const bindings=preparedSourceBindings(f.prepared.references,f.prepared.receiptSha256),managed={decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy};
 const resultRoot=join(f.managedRoot,'results'),copiedPreparedRoot=join(f.managedRoot,'prepared-input');
 const paths={result:join(resultRoot,f.task.id+'.json'),prepared:join(copiedPreparedRoot,f.prepared.receiptSha256+'.json'),answer:join(f.managedRoot,'answers',f.answer.binding+'.answer.json')};
 const bytes={result:f.frozen.documents[0].result.bytes,prepared:JSON.stringify(f.prepared)+'\n',answer:f.frozen.answers[0].bytes};
 for(const role of ['result','prepared','answer'] as const)await writeManagedSourceArtifact(f.managedRoot,paths[role],bytes[role],override?.role===role?faultyBindings(f,override.fault,bytes[role]):bindings,managed);
 const workPlanPath=join(f.root,'work-plan.json'),workPlanSha=await writePrivateJson(workPlanPath,f.plan);
 const preparationValue=JSON.parse(f.frozen.preparationPlan.bytes),preparationPath=join(f.managedRoot,'preparation-plan.json'),preparationSha=await writeManagedSourceJson(f.managedRoot,preparationPath,preparationValue,bindings,managed);
 const answerPin=knowledgePreparedSourcePinSchema.parse({path:paths.answer,sha256:sha256(bytes.answer),bytes:Buffer.byteLength(bytes.answer),bindings});
 return {paths,bytes,bindings,options:{workPlan:{path:workPlanPath,sha256:workPlanSha,bytes:Buffer.byteLength(JSON.stringify(f.plan,null,2)+'\n'),metadata:{role:'work_plan_metadata' as const,encoding:{indent:2,trailingNewlines:1},value:f.plan}},preparationPlan:{path:preparationPath,sha256:preparationSha,bytes:Buffer.byteLength(JSON.stringify(preparationValue,null,2)+'\n'),bindings},resultRoot,preparedRoot:copiedPreparedRoot,answers:[answerPin],out:join(f.root,'frozen','receipt.json'),policy:f.policy}};
}
function assessment(f:Fixture){return assessExistingRelation({key:sha256('synthetic key'),record:f.record,prepared:f.prepared,municipalityName:'Strausberg',answers:[f.answer]});}
function runtime(f:Fixture,value:unknown={score:0.91,reason:'Synthetic judge fixture only',criticalUnsupported:false}) {
  const calls:Array<{system:string;input:unknown;purpose:string}>=[];
  const implementation:JudgeOnlyRuntime={readiness:async(_provider,_signal,policy)=>{assert.deepEqual(policy,f.policy);return f.identity;},stopped:async()=>false,judge:async(provider,system,input,schema,usage)=>{
    calls.push({system,input,purpose:usage.purpose});
    assert.equal(provider,f.task.provider);assert.equal(system,JUDGE_INSTRUCTIONS);assert.equal(usage.purpose,'judge');assert.deepEqual(schema,judgeJSONSchema);
    assert.equal(usage.sourceContext?.root,f.managedRoot);assert.deepEqual(usage.policy,f.policy);
    const selected=preparedSourceBindings(f.prepared.references,f.prepared.receiptSha256);
    const expected=selected.map(({independentAllowed:_independent,...binding})=>canonicalJson(binding)).sort();
    assert.deepEqual(usage.sourceContext?.bindings.map(binding=>canonicalJson(binding)).sort(),expected);
    const answer:ModelAnswer={value,responseSha256:sha256('synthetic new actual judge response'),returnedModel:f.identity.model,runtimeWarnings:[],evidence:f.identity,requestedModel:f.identity.model,reportedModels:[f.identity.model],usage:EMPTY_USAGE};return answer;
  }};
  return {implementation,calls};
}
async function pass(f:Fixture,implementation:JudgeOnlyRuntime){return executeReassessmentPass({frozen:f.frozen,frozenSha256:f.frozenSha256,contract,provider:f.task.provider,platform:'linux',runtime:implementation,managedRoot:f.managedRoot,policy:f.policy,usage:{ledgerPath:join(f.root,'unused-ledger'),pausePath:join(f.root,'unused-pause')}});}
function merge(f:Fixture,deltas:ReassessmentDelta[]=[]){return mergeReassessmentDeltas({frozen:f.frozen,frozenSha256:f.frozenSha256,contract,deltas});}
function reseal(delta:ReassessmentDelta){const {deltaSha256:_old,...body}=delta;delta.deltaSha256=reassessmentDeltaHash(body);return delta;}

test('oversize reassessment judge inputs become deterministic quarantine holds without pausing or invoking the provider',async t=>{
  const f=await fixture(t,{sourcePrefix:'\u0001'.repeat(8000)+'\n'}),a=assessment(f),r=runtime(f);
  assert.equal(a.deterministic?.passed,true);assert.equal(a.newlyPassed,true);assert.equal(a.dateEligible,true);
  assert.ok(Buffer.byteLength(JSON.stringify(a.judgeInput))>MAX_SUBSCRIPTION_INPUT_BYTES);
  assert.equal(a.needsJudge,false);assert.equal(a.hold,MODEL_INPUT_BOUND_REASON);
  let readiness=0,pauseChecks=0;
  r.implementation.readiness=async()=>{readiness++;return f.identity;};
  r.implementation.stopped=async()=>{pauseChecks++;return false;};
  const delta=await pass(f,r.implementation),merged=merge(f,[delta]);
  assert.equal(readiness,0);assert.equal(pauseChecks,0);assert.equal(r.calls.length,0);
  assert.equal(delta.entries[0].judgeAttempted,false);assert.equal(delta.entries[0].failure,null);
  assert.equal(await isProviderStopped(join(f.root,'unused-pause'),f.task.provider),false);
  await assert.rejects(lstat(join(f.root,'unused-pause')),{code:'ENOENT'});
  assert.equal(merged.records.length,0);assert.equal(merged.report.counts.judgeCalls,0);
  assert.equal(merged.quarantine.length,1);assert.equal(merged.quarantine[0].reason,MODEL_INPUT_BOUND_REASON);
});
test('existing planning triple changes type, never becomes implementation, and never calls extraction',async t=>{
  const f=await fixture(t),r=runtime(f),a=assessment(f);
  assert.equal(a.claims?.relations[0].type,'plans');assert.equal(a.claims?.relations[0].modality,'planned');assert.equal(a.deterministic?.passed,true);assert.equal(a.newlyPassed,true);
  assert.equal(a.deterministic?.checks.length,21);assert.ok(a.normalization);
  const delta=await pass(f,r.implementation),merged=merge(f,[delta]);
  assert.equal(r.calls.length,1);assert.ok(r.calls.every(call=>call.system===JUDGE_INSTRUCTIONS&&call.purpose==='judge'));
  assert.equal(merged.records.length,1);assert.equal(merged.records[0].relations[0].type,'plans');assert.equal(merged.records[0].relations[0].modality,'planned');
  assert.equal(merged.report.counts.judgeCalls,1);assert.equal(merged.report.counts.judgePasses,1);assert.equal(merged.report.byTypeModality['plans:planned'].normalized,1);
});
test('original generation response, timestamp, tool and prompt provenance survive actual reassessment',async t=>{
  const f=await fixture(t),r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]),record=merged.records[0];
  for(const key of ['responseSha256','extractedAt','model','tool','toolVersion','modelIdentitySha256','promptVersion','promptSha256','judgePromptVersion','judgePromptSha256','extractorSha256'] as const)assert.equal(record.extraction[key],f.record.extraction[key]);
  assert.equal(record.extraction.relationNormalization?.responseSha256,f.record.extraction.responseSha256);
  assert.notEqual(record.verification.evidenceHash,f.record.verification.evidenceHash);assert.equal(record.verification.evidenceHash,knowledgeEvidenceHash(record));
  assert.equal(record.verification.faithfulness.responseSha256,sha256('synthetic new actual judge response'));
  assert.ok(record.verification.faithfulness.evaluatedAt);assert.equal(record.verification.faithfulness.threshold,0.8);
  assert.equal(merged.results[0].generatedAt,at);assert.equal(merged.results[0].promptSha256,f.plan.promptSha256);
});
test('changed claims cannot inherit a score and require current bound actual judgment',async t=>{
  const f=await fixture(t),a=assessment(f),decision=materializeReassessment(a,null,contract);
  assert.equal(decision.admitted,false);assert.equal(decision.hold,'current_actual_judge_missing');assert.equal(decision.record.verification.faithfulness.score,null);
  assert.equal(merge(f).records.length,0);
});
for(const bad of ['endpoint','phrase'] as const)test('missing '+bad+' remains rejected without judge or extraction calls',async t=>{
  const f=await fixture(t,{bad}),r=runtime(f),a=assessment(f);
  assert.equal(a.deterministic?.passed,false);const merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,0);assert.equal(merged.records.length,0);assert.equal(merged.report.counts.stillWithheld,1);
});
for(const value of [{score:0.79,reason:'Synthetic below threshold',criticalUnsupported:false},{score:0.95,reason:'Synthetic critical unsupported',criticalUnsupported:true},{score:'unknown',reason:'Synthetic invalid answer',criticalUnsupported:false}])test('failed, critical, or invalid actual judge stays held: '+JSON.stringify(value),async t=>{
  const f=await fixture(t),r=runtime(f,value),merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,1);assert.equal(merged.records.length,0);assert.equal(merged.report.counts.judgeFails,1);assert.equal(merged.report.counts.stillWithheld,1);
});
test('missing dates remain withheld; an unknown stage with a document date is individually eligible',async t=>{
  const f=await fixture(t,{dated:false}),r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,0);assert.equal(merged.records.length,0);assert.equal(merged.report.counts.dateEligible,0);assert.equal(merged.quarantine[0].reason,'date_missing');
  assert.equal(relationDateEligible({documentDate:'2026-10-10',stageDate:null,stages:[]}),true);
  assert.equal((await fixture(t)).record.stage,'unknown');
});
test('unchanged admitted relations and original attempt counters are preserved without new judgment',async t=>{
  const f=await fixture(t,{kind:'unchanged'}),r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,0);assert.deepEqual(merged.records,[f.record]);assert.deepEqual(merged.report.preserved.workPlan,f.plan);assert.equal(merged.report.counts.reusedUnchanged,1);
});
test('actual cached judgment is reusable only for identical current input and contract',async t=>{
  const f=await fixture(t),a=assessment(f),body={binding:reassessmentJudgeBinding(f.task.provider,f.identity,a.judgeInput,f.prepared),modelIdentitySha256:f.identity.modelIdentitySha256,receivedAt:at,value:{score:0.9,reason:'Synthetic cached actual judge fixture',criticalUnsupported:false},responseSha256:sha256('synthetic cached judge response'),returnedModel:f.identity.model,runtimeWarnings:[]};
  f.frozen.answers.push(blob({...body,cacheSha256:hash(body)}));f.frozenSha256=blob(f.frozen).sha256;
  const r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,0);assert.equal(merged.records.length,1);assert.equal(merged.report.counts.judgeCalls,0);assert.equal(merged.report.counts.judgePasses,1);
  const changed=structuredClone(f);const wrong={...body,binding:sha256('different actual judge input')};changed.frozen.answers[1]=blob({...wrong,cacheSha256:hash(wrong)});changed.frozenSha256=blob(changed.frozen).sha256;
  const r2=runtime(changed);await pass(changed,r2.implementation);assert.equal(r2.calls.length,1);
});
test('native host check and provider filtering happen before readiness or model invocation',async t=>{
  assert.throws(()=>assertNativeReassessmentHost('openai-subscription','darwin'),/Codex-only VM/);
  assert.throws(()=>assertNativeReassessmentHost('anthropic-subscription','linux'),/Codex-only VM/);
  assert.throws(()=>assertNativeReassessmentHost('anthropic-subscription','darwin'),/Codex-only VM/);
  const f=await fixture(t),r=runtime(f);let readinessCalls=0;r.implementation.readiness=async()=>{readinessCalls++;return f.identity;};
  await assert.rejects(executeReassessmentPass({frozen:f.frozen,frozenSha256:f.frozenSha256,contract,provider:'anthropic-subscription',platform:'darwin',runtime:r.implementation,managedRoot:f.managedRoot,policy:f.policy,usage:{ledgerPath:join(f.root,'unused'),pausePath:join(f.root,'unused-pause')}}),/Codex-only VM/);
  assert.equal(readinessCalls,0);assert.equal(r.calls.length,0);
});
test('delta merge rejects foreign source/input/identity/contract and duplicate providers',async t=>{
  const f=await fixture(t),r=runtime(f),delta=await pass(f,r.implementation);
  const foreign=structuredClone(delta);foreign.frozenSha256=sha256('different frozen run');assert.throws(()=>merge(f,[reseal(foreign)]),/binding mismatch/);
  const wrongInput=structuredClone(delta);wrongInput.entries[0].judge!.inputSha256=sha256('different source chunk');assert.throws(()=>merge(f,[reseal(wrongInput)]),/input\/identity/);
  const wrongContract=structuredClone(delta);wrongContract.contract.judgePromptVersion='other';assert.throws(()=>merge(f,[reseal(wrongContract)]),/contract mismatch/);
  const wrongClaims=structuredClone(delta);wrongClaims.entries[0].claimsSha256=sha256('different triple');assert.throws(()=>merge(f,[reseal(wrongClaims)]),/claim mismatch/);
  const wrongIdentity=structuredClone(delta);wrongIdentity.entries[0].judge!.identity.toolVersion='changed';assert.throws(()=>merge(f,[reseal(wrongIdentity)]),/identity binding/);
  assert.throws(()=>merge(f,[delta,delta]),/binding mismatch/);
});
test('missing raw generation evidence and unrecognized raw relation enums fail closed',async t=>{
  const f=await fixture(t),r=runtime(f);f.frozen.answers=[];f.frozenSha256=blob(f.frozen).sha256;
  const missing=merge(f,[await pass(f,r.implementation)]);assert.equal(r.calls.length,0);assert.equal(missing.records.length,0);assert.equal(missing.quarantine[0].reason,'raw_generation_evidence_missing_or_ambiguous');
  const other=await fixture(t),raw=JSON.parse(other.frozen.answers[0].bytes);raw.value.record.relations[0].type='owns';const {cacheSha256:_hash,...body}=raw;raw.cacheSha256=hash(body);other.frozen.answers[0]=blob(raw);other.frozenSha256=blob(other.frozen).sha256;
  const unknown=merge(other);assert.equal(unknown.records.length,0);assert.equal(unknown.quarantine[0].reason,'raw_relation_candidate_unknown');
});
test('native identity changes and pause errors remain held without model calls',async t=>{
  const f=await fixture(t),r=runtime(f),identityBody={provider:f.identity.provider,tool:f.identity.tool,toolVersion:'synthetic-2',model:f.identity.model,modelIdentityBasis:f.identity.modelIdentityBasis};
  r.implementation.readiness=async()=>({...identityBody,modelIdentitySha256:hash(identityBody)});
  const merged=merge(f,[await pass(f,r.implementation)]);assert.equal(r.calls.length,0);assert.equal(merged.records.length,0);assert.equal(merged.report.counts.judgeCalls,0);
  const paused=runtime(f);paused.implementation.stopped=async()=>true;const delta=await pass(f,paused.implementation);
  assert.equal(paused.calls.length,0);assert.equal(delta.entries[0].failure?.failureCategory,'operator_pause');
});
test('a successful pass can resume from its exact persisted judge evidence with zero extra calls',async t=>{
  const f=await fixture(t),r=runtime(f);let saved:ReassessmentJudgeEvidence|null=null;
  const options={frozen:f.frozen,frozenSha256:f.frozenSha256,contract,provider:f.task.provider,platform:'linux' as const,runtime:r.implementation,managedRoot:f.managedRoot,policy:f.policy,usage:{ledgerPath:join(f.root,'unused'),pausePath:join(f.root,'unused-pause')}};
  await executeReassessmentPass({...options,save:async(_key,evidence)=>{saved=evidence;}});assert.ok(saved);assert.equal(r.calls.length,1);
  const delta=await executeReassessmentPass({...options,load:async()=>saved});assert.equal(r.calls.length,1);assert.equal(merge(f,[delta]).records.length,1);
});
test('frozen hashes, active task boundary and completed-primary coverage cannot be forged',async t=>{
  const f=await fixture(t);validateFrozenReassessment(f.frozen,contract);
  const tampered=structuredClone(f.frozen);tampered.documents[0].prepared.bytes+=' ';assert.throws(()=>validateFrozenReassessment(tampered,contract),/byte binding/);
  const active=structuredClone(f.frozen),plan=JSON.parse(active.workPlan.bytes);plan.tasks[0].state='running';plan.tasks[0].resultSha256=null;active.workPlan=blob(plan);assert.throws(()=>validateFrozenReassessment(active,contract),/stopped frozen/);
  const missing=structuredClone(f.frozen);missing.documents=[];assert.throws(()=>validateFrozenReassessment(missing,contract),/inventory mismatch/);
});
test('no-case evidence and opaque quarantine are retained without reconstructing summary triples',async t=>{
  const f=await fixture(t),result=structuredClone(f.result);result.records=[];result.quarantine=[{documentId:'document:'+f.prepared.sourceSha256,municipalityId:'strausberg',sourceId:'synthetic-source',sourceSha256:f.prepared.sourceSha256,chunk:0,reason:'No supported case in source excerpt'}] as typeof result.quarantine;result.chunks=[{index:0,outcome:'no_case',responseSha256:f.answer.responseSha256,recordId:null}] as unknown as typeof result.chunks;
  const updated=blob(result);f.frozen.documents[0].result=updated;f.plan.tasks[0].resultSha256=updated.sha256;f.frozen.workPlan=blob(f.plan);f.frozenSha256=blob(f.frozen).sha256;
  const r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]);assert.equal(r.calls.length,0);assert.deepEqual(merged.results[0],result);assert.equal(merged.report.preserved.noCaseChunks,1);
});
test('unchanged previously unjudged or failed facts are not opportunistically retried',async t=>{
  const f=await fixture(t,{kind:'unchanged',admitted:false}),r=runtime(f),merged=merge(f,[await pass(f,r.implementation)]);
  assert.equal(r.calls.length,0);assert.equal(merged.records.length,0);assert.equal(merged.quarantine[0].reason,'previous_judge_failed_or_unknown');
});

test('whole-document budget holds survive beside ordinary relation reassessment without model calls for the held document',async t=>{
 const f=await fixture(t),text='Synthetic oversized source text. '.repeat(16000),sourceSha256=sha256(text);
 const reference={...f.prepared.references[0],url:'https://example.org/synthetic-budget',sha256:sourceSha256,locator:'document-sha256:'+sourceSha256};
 const prepared=await prepareDocument({bytes:Buffer.from(text),municipalityId:'strausberg',references:[reference],mimeType:'text/plain',extractorSha256:f.prepared.extractorSha256,toolVersions:f.prepared.toolVersions},async()=>{throw Error('No external fixture command');});
 await cachePreparedDocument(f.preparedRoot,prepared,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
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

test('judge-only readiness receives cancellation and cannot begin a judge after interruption',{timeout:2000},async t=>{
 const f=await fixture(t),r=runtime(f),controller=new AbortController();
 let entered!:()=>void;const readinessEntered=new Promise<void>(resolve=>{entered=resolve;});
 r.implementation.readiness=async(_provider,signal)=>{
  entered();assert.equal(signal,controller.signal);assert.ok(signal);
  return new Promise<ModelEvidence>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 };
 const pending=executeReassessmentPass({frozen:f.frozen,frozenSha256:f.frozenSha256,contract,provider:f.task.provider,platform:'linux',runtime:r.implementation,managedRoot:f.managedRoot,policy:f.policy,usage:{ledgerPath:join(f.root,'unused'),pausePath:join(f.root,'unused-pause'),signal:controller.signal}});
 await readinessEntered;controller.abort(Object.assign(Error('Synthetic operator interruption'),{failureCategory:'operator_pause'}));
 const delta=await pending;
 assert.equal(r.calls.length,0);assert.equal(delta.entries[0].judgeAttempted,false);assert.equal(delta.entries[0].judge,null);
 assert.equal(delta.entries[0].failure?.failureCategory,'operator_pause');
});

test('an original later source window is assessed without reinterpretation by the current chunk algorithm',async t=>{
 const f=await fixture(t,{legacyLaterChunk:true}),r=runtime(f);
 assert.ok(!documentChunks(f.prepared.text).some(chunk=>chunk.index===1&&chunk.start===3500&&chunk.end===f.prepared.text.length));
 assert.deepEqual(f.record.extraction.chunk,{index:1,count:2,start:3500,end:f.prepared.text.length});
 assert.equal(validateFrozenReassessment(f.frozen,contract).documents[0].result.chunks.length,2);
 const assessed=assessment(f);assert.equal(assessed.needsJudge,true);
 const merged=merge(f,[await pass(f,r.implementation)]);
 assert.equal(r.calls.length,1);
 assert.deepEqual(r.calls[0].input,{source:{text:f.prepared.text.slice(3500)},candidate:assessed.claims});
 assert.deepEqual(merged.records[0].extraction.chunk,f.record.extraction.chunk);
 assert.equal(merged.results[0].chunks[0].outcome,'no_case');
});

test('active objections stop cached judgment loading, readiness and judging before any call',async t=>{
 const f=await fixture(t),r=runtime(f);let loads=0,readiness=0;
 r.implementation.readiness=async()=>{readiness++;return f.identity;};
 await recordHostOptOut({host:'example.org',reason:'municipality_objection',reference:'synthetic-reassessment-objection'},f.policy);
 await assert.rejects(executeReassessmentPass({frozen:f.frozen,frozenSha256:f.frozenSha256,contract,provider:'openai-subscription',platform:'linux',runtime:r.implementation,managedRoot:f.managedRoot,policy:f.policy,usage:{ledgerPath:join(f.root,'unused'),pausePath:join(f.root,'unused-pause')},load:async()=>{loads++;return null;}}),/objection/);
 assert.equal(loads,0);assert.equal(readiness,0);assert.equal(r.calls.length,0);
});

test('managed frozen and materialized reassessment bytes purge on objection and cannot be merged again',async t=>{
 const f=await fixture(t),bindings=preparedSourceBindings(f.prepared.references,f.prepared.receiptSha256),managed={decisionId:'owner-2026-10-11-public-civic-sources' as const,...f.policy};
 const resultRoot=join(f.managedRoot,'results'),resultPath=join(resultRoot,f.task.id+'.json');
 await writeManagedSourceArtifact(f.managedRoot,resultPath,f.frozen.documents[0].result.bytes,bindings,managed);
 const answerPath=join(f.managedRoot,'answers',f.answer.binding+'.answer.json');
 const answerSha=await writeManagedSourceArtifact(f.managedRoot,answerPath,f.frozen.answers[0].bytes,bindings,managed);
 await cachePreparedDocument(f.preparedRoot,f.prepared,managed);
 const workPlanPath=join(f.root,'work-plan.json'),workPlanSha=await writePrivateJson(workPlanPath,f.plan);
 const preparationValue=JSON.parse(f.frozen.preparationPlan.bytes),preparationPath=join(f.managedRoot,'preparation-plan.json'),preparationSha=await writeManagedSourceJson(f.managedRoot,preparationPath,preparationValue,bindings,managed);
 const frozen=await freezeReassessment({workPlan:{path:workPlanPath,sha256:workPlanSha,bytes:Buffer.byteLength(JSON.stringify(f.plan,null,2)+'\n'),metadata:{role:'work_plan_metadata',encoding:{indent:2,trailingNewlines:1},value:f.plan}},preparationPlan:{path:preparationPath,sha256:preparationSha,bytes:Buffer.byteLength(JSON.stringify(preparationValue,null,2)+'\n'),bindings},resultRoot,preparedRoot:f.preparedRoot,answers:[{path:answerPath,sha256:answerSha,bytes:Buffer.byteLength(f.frozen.answers[0].bytes),bindings}],out:join(f.root,'frozen','receipt.json'),policy:f.policy});
 await assertManagedSourceReadable(frozen.path,f.policy);
 const stored=JSON.parse(await readFile(frozen.path,'utf8'));assert.equal(JSON.parse(stored.documents[0].result.bytes).generatedAt,at);
 const merged=await mergeReassessment({frozen,deltas:[],out:join(f.root,'merged'),policy:f.policy});
 for(const artifact of merged.artifacts)await assertManagedSourceReadable(artifact.path,f.policy);
 const objection=await recordHostOptOut({host:'example.org',reason:'rights_holder_objection',reference:'synthetic-frozen-purge'},f.policy);
 assert.equal(objection.purge.status,'purged');
 for(const path of [frozen.path,...merged.artifacts.map(artifact=>artifact.path)])await assert.rejects(lstat(path),{code:'ENOENT'});
 await assert.rejects(mergeReassessment({frozen,deltas:[],out:join(f.root,'merge-after-objection'),policy:f.policy}));
 await assert.rejects(lstat(join(f.root,'merge-after-objection')),{code:'ENOENT'});
});

for(const role of ['result','prepared','answer'] as const)for(const fault of ['retained','config','receipt','extra','missing','nonindependent'] as const)test(`freeze rejects ${role} with ${fault} provenance before materializing a copy`,async t=>{
 const f=await fixture(t,{extraReference:fault==='missing'}),staged=await managedFreezeFixture(f,{role,fault});
 await assert.rejects(freezeReassessment(staged.options));
 await assert.rejects(lstat(staged.options.out),{code:'ENOENT'});
 assert.equal(await readFile(staged.paths[role],'utf8'),staged.bytes[role]);
});

test('freeze requires every explicit original answer pin without creating an unbound output',async t=>{
 const f=await fixture(t),staged=await managedFreezeFixture(f);
 await assert.rejects(freezeReassessment({...staged.options,answers:[]}),/every selected original answer receipt/);
 await assert.rejects(lstat(staged.options.out),{code:'ENOENT'});
});
test('correct full answer pins and locator-specific payloads retain every prepared contributor',async t=>{
 const f=await fixture(t,{extraReference:true}),staged=await managedFreezeFixture(f),preparation=preparationPlanSchema.parse(JSON.parse(f.frozen.preparationPlan.bytes));
 const cached=await readTaskResult(staged.paths.result,f.task,f.plan,preparation.groups[0],f.policy);
 assert.deepEqual(cached.result.quarantine[0].candidate?.sources,f.record.sources);
 const frozen=await freezeReassessment(staged.options);
 assert.equal(frozen.bindings.length,2);assert.equal(frozen.bytes,(await readFile(frozen.path)).length);
 await assertManagedSourceBindings(frozen.path,staged.bindings,f.policy);
 const merged=await mergeReassessment({frozen,deltas:[],out:join(f.root,'exact-context-merge'),policy:f.policy});
 for(const pin of [merged,...merged.artifacts]){
  assert.equal(pin.bytes,(await readFile(pin.path)).length);
  await assertManagedSourceBindings(pin.path,staged.bindings,f.policy);
 }
});

for(const fault of ['retained','config','receipt','extra','missing','nonindependent'] as const)test(`task result cache rejects ${fault} provenance without reusing caller labels`,async t=>{
 const f=await fixture(t,{extraReference:fault==='missing'}),staged=await managedFreezeFixture(f,{role:'result',fault}),preparation=preparationPlanSchema.parse(JSON.parse(f.frozen.preparationPlan.bytes));
 await assert.rejects(readTaskResult(staged.paths.result,f.task,f.plan,preparation.groups[0],f.policy));
 assert.equal(await readFile(staged.paths.result,'utf8'),staged.bytes.result);
});

for(const changed of ['id','url','retrievedAt','policy'] as const)test(`task result payload ${changed} cannot diverge from its prepared receipt`,async t=>{
 const f=await fixture(t),result=structuredClone(f.result),candidate=result.quarantine[0].candidate!,source=candidate.sources[0];
 if(changed==='id')source.id='synthetic-unselected-source';
 if(changed==='url')source.url='https://example.org/not-the-prepared-reference';
 if(changed==='retrievedAt')source.retrievedAt='2026-10-09T12:00:00.000Z';
 if(changed==='policy')source.policy.robots.checkedAt='2026-10-09T12:00:00.000Z';
 candidate.verification.evidenceHash=knowledgeEvidenceHash(candidate);
 const encoded=blob(result),path=join(f.managedRoot,'results',f.task.id+'.json'),bindings=preparedSourceBindings(f.prepared.references,f.prepared.receiptSha256);
 await writeManagedSourceArtifact(f.managedRoot,path,encoded.bytes,bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
 const task={...f.task,resultSha256:encoded.sha256},preparation=preparationPlanSchema.parse(JSON.parse(f.frozen.preparationPlan.bytes));
 await assert.rejects(readTaskResult(path,task,f.plan,preparation.groups[0],f.policy));
 assert.equal(await readFile(path,'utf8'),encoded.bytes);
});

for(const role of ['result','prepared','answer'] as const)test(`an omitted extra contributor objection gates ${role} before its already-purged body can be read`,async t=>{
 const f=await fixture(t),staged=await managedFreezeFixture(f,{role,fault:'extra'});
 const objection=await recordHostOptOut({host:'example.net',reason:'rights_holder_objection',reference:'synthetic-extra-ancestor'},f.policy);
 assert.equal(objection.purge.status,'purged');await assert.rejects(lstat(staged.paths[role]),{code:'ENOENT'});
 await assert.rejects(freezeReassessment(staged.options),HostOptedOutError);
 await assert.rejects(lstat(staged.options.out),{code:'ENOENT'});
 if(role==='result'){
  const preparation=preparationPlanSchema.parse(JSON.parse(f.frozen.preparationPlan.bytes));
  await assert.rejects(readTaskResult(staged.paths.result,f.task,f.plan,preparation.groups[0],f.policy),HostOptedOutError);
 }
});

for(const fault of ['retained','config','receipt','extra','missing','nonindependent'] as const)test(`frozen pins cannot launder ${fault} inherited provenance`,async t=>{
 const f=await fixture(t,{extraReference:fault==='missing'}),staged=await managedFreezeFixture(f),frozen=await freezeReassessment(staged.options),bytes=await readFile(frozen.path,'utf8');
 const bindings=faultyBindings(f,fault,bytes),root=join(f.root,'wrong-frozen'),path=join(root,'frozen.json');
 await writeManagedSourceArtifact(root,path,bytes,bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
 const declared={...frozen,path,bindings};
 // Even a caller declaration that agrees with a wrong ledger must differ from the decoded complete prepared contexts.
 await assert.rejects(mergeReassessment({frozen:declared,deltas:[],out:join(f.root,'denied-frozen-merge'),policy:f.policy}));
 await assert.rejects(lstat(join(f.root,'denied-frozen-merge')),{code:'ENOENT'});
 assert.equal(await readFile(path,'utf8'),bytes);
});

test('delta paths retain the complete frozen prepared ancestry rather than caller-provided role or permission labels',async t=>{
 const f=await fixture(t,{extraReference:true}),staged=await managedFreezeFixture(f),frozen=await freezeReassessment(staged.options),decoded=FrozenReassessmentSchema.parse(JSON.parse(await readFile(frozen.path,'utf8'))),r=runtime(f);
 const delta=await executeReassessmentPass({frozen:decoded,frozenSha256:frozen.sha256,contract:decoded.contract,provider:'openai-subscription',platform:'linux',runtime:r.implementation,managedRoot:f.managedRoot,policy:f.policy,usage:{ledgerPath:join(f.root,'unused-ledger'),pausePath:join(f.root,'unused-pause')}});
 assert.equal(r.calls.length,1);
 const bytes=JSON.stringify(delta,null,2)+'\n';
 for(const fault of ['retained','config','receipt','extra','missing','nonindependent'] as const){
  const root=join(f.root,'wrong-delta-'+fault),path=join(root,'delta.json'),bindings=faultyBindings(f,fault,bytes);
  await writeManagedSourceArtifact(root,path,bytes,bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
  const pin={path,sha256:sha256(bytes),bytes:Buffer.byteLength(bytes),bindings:staged.bindings};
  await assert.rejects(mergeReassessment({frozen,deltas:[pin],out:join(f.root,'denied-delta-'+fault),policy:f.policy}));
  await assert.rejects(lstat(join(f.root,'denied-delta-'+fault)),{code:'ENOENT'});assert.equal(await readFile(path,'utf8'),bytes);
 }
 const root=join(f.root,'correct-delta'),path=join(root,'delta.json');
 await writeManagedSourceArtifact(root,path,bytes,staged.bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
 const merged=await mergeReassessment({frozen,deltas:[{path,sha256:sha256(bytes),bytes:Buffer.byteLength(bytes),bindings:staged.bindings}],out:join(f.root,'accepted-delta'),policy:f.policy});
 for(const pin of merged.artifacts)await assertManagedSourceBindings(pin.path,staged.bindings,f.policy);
});

for(const role of ['frozen','delta'] as const)test(`an extra ${role} ancestor objection is enforced before reading its purged bytes`,async t=>{
 const f=await fixture(t),staged=await managedFreezeFixture(f),frozen=await freezeReassessment(staged.options);
 const decoded=FrozenReassessmentSchema.parse(JSON.parse(await readFile(frozen.path,'utf8')));
 let bytes:string;
 if(role==='frozen')bytes=await readFile(frozen.path,'utf8');
 else{
  const r=runtime(f),delta=await executeReassessmentPass({frozen:decoded,frozenSha256:frozen.sha256,contract:decoded.contract,provider:'openai-subscription',platform:'linux',runtime:r.implementation,managedRoot:f.managedRoot,policy:f.policy,usage:{ledgerPath:join(f.root,'unused-ledger'),pausePath:join(f.root,'unused-pause')}});
  assert.equal(r.calls.length,1);bytes=JSON.stringify(delta,null,2)+'\n';
 }
 const root=join(f.root,'extra-ancestor-'+role),path=join(root,role+'.json');
 await writeManagedSourceArtifact(root,path,bytes,faultyBindings(f,'extra',bytes),{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
 const pin=knowledgePreparedSourcePinSchema.parse({path,sha256:sha256(bytes),bytes:Buffer.byteLength(bytes),bindings:staged.bindings});
 const objection=await recordHostOptOut({host:'example.net',reason:'rights_holder_objection',reference:'synthetic-extra-'+role},f.policy);
 assert.equal(objection.purge.status,'purged');await assert.rejects(lstat(path),{code:'ENOENT'});
 await assertManagedSourceBindings(frozen.path,staged.bindings,f.policy);
 const out=join(f.root,'denied-extra-'+role);
 await assert.rejects(mergeReassessment({frozen:role==='frozen'?pin:frozen,deltas:role==='delta'?[pin]:[],out,policy:f.policy}),HostOptedOutError);
 await assert.rejects(lstat(out),{code:'ENOENT'});
});

test('inline work-plan metadata reproduces pinned original bytes without reading its path',async t=>{
 const f=await fixture(t),staged=await managedFreezeFixture(f);
 staged.options.workPlan.path=join(f.root,'nonexistent-inline-work-plan.json');
 const frozen=await freezeReassessment(staged.options),stored=FrozenReassessmentSchema.parse(JSON.parse(await readFile(frozen.path,'utf8')));
 assert.deepEqual(stored.controlBindings.workPlan,[]);
 assert.deepEqual(stored.controlBindings.preparationPlan,staged.bindings);
 assert.equal(stored.workPlan.bytes,JSON.stringify(f.plan,null,2)+'\n');
 assert.equal(stored.workPlan.sha256,staged.options.workPlan.sha256);
 await assert.rejects(lstat(staged.options.workPlan.path),{code:'ENOENT'});
});

test('untyped plan path pins and altered metadata encoding cannot reopen generic audit reads',async t=>{
 const f=await fixture(t),staged=await managedFreezeFixture(f);
 for(const field of ['workPlan','preparationPlan'] as const){
  const pin=staged.options[field];
  await assert.rejects(freezeReassessment({...staged.options,[field]:{path:pin.path,sha256:pin.sha256}}));
  await assert.rejects(lstat(staged.options.out),{code:'ENOENT'});
 }
 const wrongEncoding={...staged.options.workPlan,metadata:{...staged.options.workPlan.metadata,encoding:{indent:0,trailingNewlines:0}}};
 await assert.rejects(freezeReassessment({...staged.options,workPlan:wrongEncoding}));
 const value={...f.plan,sourceText:'Synthetic source body cannot hide in metadata'},bytes=JSON.stringify(value,null,2)+'\n';
 const hiddenBody={...staged.options.workPlan,sha256:sha256(bytes),bytes:Buffer.byteLength(bytes),metadata:{...staged.options.workPlan.metadata,value}};
 await assert.rejects(freezeReassessment({...staged.options,workPlan:hiddenBody}));
 await assert.rejects(lstat(staged.options.out),{code:'ENOENT'});
});

test('preparation candidates require real inherited plan bindings rather than inline metadata',async t=>{
 const f=await fixture(t),staged=await managedFreezeFixture(f),value=JSON.parse(f.frozen.preparationPlan.bytes);
 value.quarantine.push({documentId:'document:'+f.prepared.sourceSha256,municipalityId:f.record.municipalityId,sourceId:f.prepared.references[0].id,sourceSha256:f.prepared.sourceSha256,chunk:null,reason:'Synthetic source-bound preparation artifact',candidate:f.record});
 const bytes=JSON.stringify(value,null,2)+'\n';
 const inline={path:join(f.root,'unread-inline-preparation.json'),sha256:sha256(bytes),bytes:Buffer.byteLength(bytes),metadata:{role:'preparation_plan_metadata',encoding:{indent:2,trailingNewlines:1},value}};
 await assert.rejects(freezeReassessment({...staged.options,preparationPlan:inline}));
 await assert.rejects(lstat(staged.options.out),{code:'ENOENT'});
 const sourcePath=join(f.managedRoot,'preparation-with-candidate.json'),digest=await writeManagedSourceArtifact(f.managedRoot,sourcePath,bytes,staged.bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
 const pin=knowledgePreparedSourcePinSchema.parse({path:sourcePath,sha256:digest,bytes:Buffer.byteLength(bytes),bindings:staged.bindings});
 const frozen=await freezeReassessment({...staged.options,preparationPlan:pin}),stored=FrozenReassessmentSchema.parse(JSON.parse(await readFile(frozen.path,'utf8')));
 assert.deepEqual(stored.controlBindings.preparationPlan,staged.bindings);
 assert.deepEqual(JSON.parse(stored.preparationPlan.bytes).quarantine[0].candidate,f.record);
 await assertManagedSourceBindings(frozen.path,staged.bindings,f.policy);
});

test('closed content-free preparation metadata needs no source-file read or invented control receipt',async t=>{
 const f=await fixture(t),staged=await managedFreezeFixture(f),value=JSON.parse(f.frozen.preparationPlan.bytes),bytes=JSON.stringify(value)+'\n\n';
 const preparationPlan={path:join(f.root,'nonexistent-inline-preparation.json'),sha256:sha256(bytes),bytes:Buffer.byteLength(bytes),metadata:{role:'preparation_plan_metadata',encoding:{indent:0,trailingNewlines:2},value}};
 const frozen=await freezeReassessment({...staged.options,preparationPlan}),stored=FrozenReassessmentSchema.parse(JSON.parse(await readFile(frozen.path,'utf8')));
 assert.deepEqual(stored.controlBindings,{workPlan:[],preparationPlan:[]});
 assert.equal(stored.preparationPlan.bytes,bytes);
 await assert.rejects(lstat(preparationPlan.path),{code:'ENOENT'});
 await assertManagedSourceBindings(frozen.path,staged.bindings,f.policy);
});

test('v1 frozen artifacts remain historical-codec-only and never become current source or model authority',async t=>{
 const f=await fixture(t),{controlBindings:_controls,...body}=f.frozen;
 const historical={...body,version:'district-relation-reassessment-v1' as const,contract:{...body.contract,version:'district-relation-reassessment-v1' as const}};
 assert.deepEqual(HistoricalFrozenReassessmentSchema.parse(historical),historical);
 assert.throws(()=>validateFrozenReassessment(historical,contract));
 const r=runtime(f);let readiness=0,loads=0;r.implementation.readiness=async()=>{readiness++;return f.identity;};
 await assert.rejects(executeReassessmentPass({frozen:historical,frozenSha256:blob(historical).sha256,contract,provider:'openai-subscription',platform:'linux',runtime:r.implementation,managedRoot:f.managedRoot,policy:f.policy,usage:{ledgerPath:join(f.root,'unused'),pausePath:join(f.root,'unused-pause')},load:async()=>{loads++;return null;}}));
 assert.equal(readiness,0);assert.equal(loads,0);assert.equal(r.calls.length,0);
 await assert.rejects(lstat(f.managedRoot),{code:'ENOENT'});
});

test('genuine source-bound control ancestors survive freeze, judge context, delta and every merge output',async t=>{
 const f=await fixture(t),staged=await managedFreezeFixture(f);
 const text='Strausberg. Synthetic additional control source supporting the work-plan metadata, not a new municipal claim.';
 const reference:PreparedSourceReference={...f.prepared.references[0],id:'synthetic-control-only',url:'https://example.net/control-only',sha256:sha256(text),locator:'synthetic control input',policy:{...f.prepared.references[0].policy,robots:{state:'allowed',url:'https://example.net/robots.txt'}}};
 const prepared=await prepareDocument({bytes:Buffer.from(text),municipalityId:'strausberg',references:[reference],mimeType:'text/plain',extractorSha256:f.prepared.extractorSha256,toolVersions:f.prepared.toolVersions},async()=>{throw Error('No external fixture command');});
 await cachePreparedDocument(f.preparedRoot,prepared,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
 const inherited=[...staged.bindings,...preparedSourceBindings(prepared.references,prepared.receiptSha256)];
 const path=join(f.managedRoot,'source-bound-work-plan.json'),bytes=JSON.stringify(f.plan,null,2)+'\n',sha=await writeManagedSourceArtifact(f.managedRoot,path,bytes,inherited,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
 const workPlan=knowledgePreparedSourcePinSchema.parse({path,sha256:sha,bytes:Buffer.byteLength(bytes),bindings:inherited});
 const frozen=await freezeReassessment({...staged.options,workPlan}),stored=FrozenReassessmentSchema.parse(JSON.parse(await readFile(frozen.path,'utf8')));
 assert.equal(frozen.bindings.length,2);assert.deepEqual(stored.controlBindings.workPlan,inherited);
 const r=runtime({...f,frozen:stored}),judge=r.implementation.judge;
 r.implementation.judge=async(...args)=>{
  assert.deepEqual(args[4].sourceContext?.bindings,staged.bindings.map(({independentAllowed:_flag,...binding})=>binding));
  return judge(...args);
 };
 const delta=await executeReassessmentPass({frozen:stored,frozenSha256:frozen.sha256,contract:stored.contract,provider:'openai-subscription',platform:'linux',runtime:r.implementation,managedRoot:f.managedRoot,policy:f.policy,usage:{ledgerPath:join(f.root,'unused'),pausePath:join(f.root,'unused-pause')}});
 assert.equal(r.calls.length,1);
 const deltaPath=join(f.managedRoot,'delta-with-controls.json'),deltaBytes=JSON.stringify(delta,null,2)+'\n',deltaSha=await writeManagedSourceArtifact(f.managedRoot,deltaPath,deltaBytes,frozen.bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
 const deltaPin=reassessmentArtifactPinSchema.parse({path:deltaPath,sha256:deltaSha,bytes:Buffer.byteLength(deltaBytes),bindings:frozen.bindings});
 const merged=await mergeReassessment({frozen,deltas:[deltaPin],out:join(f.root,'merge-with-controls'),policy:f.policy});
 for(const pin of [merged,...merged.artifacts])await assertManagedSourceBindings(pin.path,frozen.bindings,f.policy);
 const objection=await recordHostOptOut({host:'example.net',reason:'rights_holder_objection',reference:'synthetic-genuine-control-ancestor'},f.policy);
 assert.equal(objection.purge.status,'purged');
 for(const output of [frozen,deltaPin,merged,...merged.artifacts])await assert.rejects(lstat(output.path),{code:'ENOENT'});
 await assert.rejects(mergeReassessment({frozen,deltas:[deltaPin],out:join(f.root,'denied-control-merge'),policy:f.policy}),HostOptedOutError);
});

test('genuine control provenance conservatively retains non-independent permission through frozen and merge copies',async t=>{
 const f=await fixture(t),staged=await managedFreezeFixture(f),bindings=staged.bindings.map(binding=>({...binding,independentAllowed:false}));
 const path=join(f.managedRoot,'nonindependent-work-plan.json'),bytes=JSON.stringify(f.plan,null,2)+'\n';
 const sha=await writeManagedSourceArtifact(f.managedRoot,path,bytes,bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy});
 const workPlan=knowledgePreparedSourcePinSchema.parse({path,sha256:sha,bytes:Buffer.byteLength(bytes),bindings});
 const frozen=await freezeReassessment({...staged.options,workPlan});
 assert.deepEqual(frozen.bindings,bindings);
 await assertManagedSourceBindings(frozen.path,bindings,f.policy);
 const merged=await mergeReassessment({frozen,deltas:[],out:join(f.root,'nonindependent-merge'),policy:f.policy});
 for(const pin of [merged,...merged.artifacts]){
  assert.deepEqual(pin.bindings,bindings);
  await assertManagedSourceBindings(pin.path,bindings,f.policy);
 }
});

interface ControlWireFixture {wire(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>}
test('real HTTP and Git-approved configuration control ancestry stays on artifacts, never in native model source scope',async t=>{
 const f=await fixture(t),staged=await managedFreezeFixture(f),managed={decisionId:CIVIC_ACQUISITION_DECISION_ID,...f.policy};
 const fetcher=new PoliteFetcher({cacheDir:join(f.root,'http-control'),minDelayMs:0,ownerPolicyLane:managed,fixtureInspection:fixturePolicyInspection});
 // Transport and parser inspection are synthetic; authority, observations, ledger and raw bytes use real fixture operations.
 t.mock.method(fetcher as unknown as ControlWireFixture,'wire',async(uri:URL)=>{
  if(uri.pathname==='/robots.txt'||uri.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('Stadt Strausberg. Synthetische amtliche Bekanntmachung für einen technischen Test des Kontrollplans.')};
 });
 const response=await fetcher.fetch('https://http.example.org/control'),observed=sourceContentBinding(response);
 const http:SourceArtifactBinding={kind:'http_observation',url:observed.url,sourceSha256:observed.sha256,observationId:basename(observed.observationPath),receiptSha256:sha256(await readFile(observed.observationPath)),independentAllowed:observed.independentAllowed};
 const url='https://config.example.org/source',evidence={url,locator:'Synthetic registry control reference',sha256:sha256('synthetic registry reference'),retrievedAt:at};
 const value={schemaVersion:'stadtstack-source-registry-v1',generatedAt:at,districts:[{id:'maerkisch-oderland',name:'Synthetic district',ags:'12064',state:'Brandenburg',inventorySources:[evidence],inventoryAsOf:'2026-10-10',inventoryComplete:true}],municipalities:[{id:'strausberg',name:'Strausberg',ags:'12064472',districtId:'maerkisch-oderland',districtAgs:'12064',amt:null,administrativeStatus:'amtsfrei',administrativeEvidence:[evidence],identitySources:[evidence],sources:['website','council','participation','gazette'].map(kind=>({id:kind,kind,url,vendor:'unknown',checkState:'not_checked',checkedAt:null,evidence:[],reason:'Synthetic configuration only'})),seedDocuments:[{url,sourceId:'website',title:'Synthetic configured seed',documentDate:null,dateReason:'No observation date',evidence:[evidence]}]}],inventory:[{ags:'12064472',name:'Strausberg',districtId:'maerkisch-oderland',identitySourceUrl:url,pilot:true,sourceCheckState:'not_checked',reason:'Synthetic configuration only'}],notes:['Synthetic Git-approved control, not source/model evidence']};
 const codeRoot=join(f.root,'config-code');await mkdir(codeRoot,{mode:0o700});
 const codeBytes=Buffer.from(JSON.stringify(value)+'\n'),codePath=join(codeRoot,'registry.json');await writeFile(codePath,codeBytes,{mode:0o600});
 const oid=(kind:string,bytes:Buffer)=>createHash('sha1').update(kind+' '+bytes.length+'\0').update(bytes).digest('hex');
 const entry=(name:string,object:string,mode='40000')=>Buffer.concat([Buffer.from(mode+' '+name+'\0'),Buffer.from(object,'hex')]);
 const store=async(kind:string,bytes:Buffer)=>{const object=oid(kind,bytes),path=join(codeRoot,kind+'-'+object+'.bin');await writeFile(path,bytes,{mode:0o600});return {path,oid:object,sha256:sha256(bytes),bytes:bytes.length};};
 const blobOid=oid('blob',codeBytes),leaf=await store('tree',entry('district-registry.json',blobOid,'100644')),middle=await store('tree',entry('sources',leaf.oid)),tree=await store('tree',entry('stadtstack-data',middle.oid));
 const commit=await store('commit',Buffer.from(`tree ${tree.oid}\nauthor Synthetic Fixture <fixture@example.test> 0 +0000\ncommitter Synthetic Fixture <fixture@example.test> 0 +0000\n\nSynthetic registry control\n`));
 const descriptor=operatorRegistryConfigSchema.parse({kind:'operator_registry_config',path:codePath,sha256:sha256(codeBytes),bytes:codeBytes.length,schemaContractSha256:await operatorRegistryConfigContractSha256(),code:{gitCommit:commit.oid,path:'stadtstack-data/sources/district-registry.json',blobOid,sha256:sha256(codeBytes),bytes:codeBytes.length},approval:{role:'district_source_registry',approver:'owner',decisionId:CIVIC_ACQUISITION_DECISION_ID,date:'2026-10-11',configurationSha256:sha256(codeBytes),gitCommit:commit.oid},commit,trees:[leaf,middle,tree],declaredEndpoints:[...new Set(retainedPublicationSources(value).map(source=>source.url))]});
 const config=await importOperatorRegistryConfig({...descriptor,managedRoot:join(f.root,'config-control'),destinationPath:'registry.json'},f.policy);
 const controls=[http,...config.bindings],path=join(f.managedRoot,'mixed-control-work-plan.json'),bytes=JSON.stringify(f.plan,null,2)+'\n',digest=await writeManagedSourceArtifact(f.managedRoot,path,bytes,controls,managed);
 const workPlan=reassessmentArtifactPinSchema.parse({path,sha256:digest,bytes:Buffer.byteLength(bytes),bindings:controls});
 const frozen=await freezeReassessment({...staged.options,workPlan}),stored=FrozenReassessmentSchema.parse(JSON.parse(await readFile(frozen.path,'utf8')));
 assert.deepEqual(new Set(frozen.bindings.map(binding=>binding.kind)),new Set(['prepared_source','http_observation','operator_registry_config']));
 assert.deepEqual(stored.controlBindings.workPlan,controls);
 const r=runtime(f),judge=r.implementation.judge;
 r.implementation.judge=async(...args)=>{
  assert.deepEqual(args[4].sourceContext?.bindings,staged.bindings.map(({independentAllowed:_flag,...binding})=>binding));
  return judge(...args);
 };
 const delta=await executeReassessmentPass({frozen:stored,frozenSha256:frozen.sha256,contract:stored.contract,provider:'openai-subscription',platform:'linux',runtime:r.implementation,managedRoot:f.managedRoot,policy:f.policy,usage:{ledgerPath:join(f.root,'unused-ledger'),pausePath:join(f.root,'unused-pause')}});
 const deltaPath=join(f.managedRoot,'mixed-delta.json'),deltaBytes=JSON.stringify(delta,null,2)+'\n',deltaSha=await writeManagedSourceArtifact(f.managedRoot,deltaPath,deltaBytes,frozen.bindings,managed);
 const deltaPin=reassessmentArtifactPinSchema.parse({path:deltaPath,sha256:deltaSha,bytes:Buffer.byteLength(deltaBytes),bindings:frozen.bindings});
 const merged=await mergeReassessment({frozen,deltas:[deltaPin],out:join(f.root,'mixed-merge'),policy:f.policy});
 for(const pin of [frozen,deltaPin,merged,...merged.artifacts])await assertManagedSourceBindings(pin.path,frozen.bindings,f.policy);
 assert.equal(r.calls.length,1);
 const retainedControls=faultyBindings(f,'retained',bytes);
 assert.equal(reassessmentArtifactPinSchema.safeParse({...workPlan,bindings:retainedControls}).success,true); // Canonical artifact codec accepts custody; authentication still requires actual provenance.
 assert.equal(reassessmentArtifactPinSchema.safeParse({...workPlan,bindings:[{kind:'authenticated_git_snapshot',purpose:'historical_change_reconstruction_only',url,sourceSha256:null,snapshot:descriptor.code,independentAllowed:false}]}).success,false);
 const objection=await recordHostOptOut({host:'config.example.org',reason:'rights_holder_objection',reference:'synthetic-mixed-control-purge'},f.policy);
 assert.equal(objection.purge.status,'purged');
 for(const pin of [frozen,deltaPin,merged,...merged.artifacts])await assert.rejects(lstat(pin.path),{code:'ENOENT'});
});
