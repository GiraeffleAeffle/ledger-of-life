import test from 'node:test';
import assert from 'node:assert/strict';
import {buildR1TextCompositionContext,rebuildR1TextCoverageContext,loadR1TextCompositionInput,r1TextCompositionInputSchema} from '../src/district-r1-text-composition.ts';
import {buildTextRunLineage,readTextLineageArtifact,type TextLineageArtifact,type TextRunContribution} from '../src/text-run-lineage.ts';
import {type DistrictReleaseCompositionInput} from '../src/district-release-composition.ts';
import {DistrictKnowledgeRecordSchema,knowledgeEvidenceHash,sha256,REQUIRED_DETERMINISTIC_CHECKS,type DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {GRAPH_DETERMINISTIC_CHECKS,normalizeGraphClaims} from '../src/district-graph-claims.ts';
import {PROVIDER_CONFIGS,type ExtractorProvider} from '../src/district-model-contract.ts';
import {identityAssertion,unknownValidity,type IdentityAdmission,type IdentityAssertion} from '../src/district-entity-resolution.ts';
import {semanticHash} from '../src/district-adapter-contract.ts';

// Explicit synthetic offline artifacts only; no civic facts, operational receipts,
// provider/judge execution, source requests or policy authorizations are represented.
const earlier='2026-10-01T12:00:00.000Z',now='2026-10-11T12:00:00.000Z';
const sourceHash=sha256('synthetic text source'),city='synthetic-town',sourceId='synthetic-source';
function artifact(value:unknown):TextLineageArtifact{const bytes=JSON.stringify(value);return {bytes,sha256:sha256(bytes)};}
function record(id:string,provider:ExtractorProvider='openai-subscription'):DistrictKnowledgeRecord{
 const config=PROVIDER_CONFIGS[provider],modelIdentitySha256=sha256('synthetic '+provider);
 const result:DistrictKnowledgeRecord={
  kind:'text_model',id,municipalityId:city,ags:'12064001',districtId:'synthetic-district',
  title:'Synthetic title',titleQuote:'Synthetic title',summary:'Synthetic summary',summaryQuote:'Synthetic summary',municipalityQuote:'Synthetic town',
  caseKeyType:'source_document',caseKey:'source_document:'+sourceHash,caseQuote:null,caseType:'unknown',
  documentDate:'2026-10-01',documentDateQuote:'2026-10-01',documentDateReason:null,stage:'unknown',stageDate:null,stageDateQuote:null,stageDateReason:'Synthetic undated stage',originalStatus:'',stageQuote:'',stages:[],topics:[],locations:[],entities:[],relations:[],
  sources:[{id:sourceId,url:'https://example.org/synthetic',sha256:sourceHash,retrievedAt:earlier,locator:'chars:0-100',mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}}],
  extraction:{extractorVersion:'synthetic',extractorSha256:sha256('synthetic extractor'),model:config.model,provider,tool:config.tool,toolVersion:'synthetic-tool',modelIdentitySha256,modelIdentityBasis:config.modelIdentityBasis,returnedModel:null,runtimeWarnings:['Synthetic retained warning'],promptVersion:'synthetic-prompt',promptSha256:sha256('synthetic prompt '+id),judgePromptVersion:'synthetic-judge',judgePromptSha256:sha256('synthetic judge prompt '+id),inputSha256:sourceHash,textSha256:sha256('synthetic text'),responseSha256:sha256('synthetic response '+id),ocrUsed:false,textMethod:'text',cacheKey:sha256('synthetic cache '+id),extractedAt:earlier,chunk:{index:0,count:1,start:0,end:100}},
  verification:{kind:'text_model',status:'auto-verified',deterministic:{passed:true,checks:[...REQUIRED_DETERMINISTIC_CHECKS,...GRAPH_DETERMINISTIC_CHECKS].map(id=>({id,passed:true,reason:'Synthetic check only'}))},faithfulness:{score:0.9,threshold:0.8,model:config.model,provider,tool:config.tool,toolVersion:'synthetic-tool',modelIdentitySha256,returnedModel:null,reason:'Synthetic judgment fixture only',evaluatedAt:earlier,responseSha256:sha256('synthetic judge '+id),sameModel:true,limitation:'Same-model judgment is not independent verification.'},evidenceHash:''},
 };
 result.verification.evidenceHash=knowledgeEvidenceHash(result);
 return DistrictKnowledgeRecordSchema.parse(result);
}
function historicalV2(value:DistrictKnowledgeRecord){
 const {kind:_kind,...claims}=value,{kind:_verificationKind,...verification}=value.verification;
 const legacy={...claims,verification:{...verification,evidenceHash:''}};
 legacy.verification.evidenceHash=knowledgeEvidenceHash(legacy);
 return legacy;
}
function run(label:string,records:unknown[],options:{v2?:boolean;balanced?:boolean;generatedAt?:string;assertions?:IdentityAssertion[];admissions?:IdentityAdmission[];cases?:unknown[];includePlan?:boolean}={}):TextRunContribution{
 const generatedAt=options.generatedAt??now,cases=options.cases??[];
 const crawl=artifact({schemaVersion:'stadtstack-crawl-index-v1',generatedAt,documents:[{id:'synthetic-document',municipalityId:city,sourceId,sha256:sourceHash,url:'https://example.org/synthetic'}],checks:[{municipalityId:city,sourceId,checkState:'checked',checkedAt:generatedAt,documentCount:1,coverage:{state:'partial',pendingCount:7,runnableCount:5,blockedCount:2,scope:'Synthetic broad source'}}]});
 const registry=artifact({generatedAt,municipalities:[{id:city,sources:[{id:sourceId}]}]});
 const pins={corpusSha256:crawl.sha256,registrySha256:registry.sha256,promptContractSha256:sha256('synthetic contract '+label),schemaSha256:sha256('synthetic schema '+label)};
 const municipalities=[{id:city,selectedDocumentGroups:1,preparedDocumentGroups:1,attemptedDocumentGroups:1}];
 const extractionRun=artifact({schemaVersion:'stadtstack-extraction-run-v2',generatedAt,assignmentMode:options.balanced?'balanced':'codex-only',...pins,scope:'all_fetched_documents',maxDocumentsPerMunicipality:null,availableDocumentGroups:1,attemptedDocumentGroups:1,pendingDocumentGroups:0,municipalities,fixtureLabel:label});
 const preparationPlan=artifact({schemaVersion:'stadtstack-preparation-plan-v1',generatedAt,...pins,maxDocumentsPerMunicipality:null,availableDocumentGroups:1,selectedDocumentGroups:1,municipalities,groups:[{expected:{municipalityId:city,sourceSha256:sourceHash}}],quarantine:[]});
 return {runId:extractionRun.sha256,sourceArtifactKind:'native_extraction_output',pins,artifacts:{extractionRun,records:artifact({schemaVersion:options.v2?'stadtstack-knowledge-v2':'stadtstack-knowledge-v3',generatedAt,records,...(options.v2?{}:{identityAssertions:options.assertions??[],identityAdmissions:options.admissions??[]})}),quarantine:artifact({schemaVersion:'stadtstack-quarantine-v1',generatedAt,cases}),crawl,registry,...(options.includePlan===false?{}:{preparationPlan})}};
}
function input(runs:TextRunContribution[],recordIds:string[][]):DistrictReleaseCompositionInput{return {contributions:runs,approvedRunOrder:runs.map(run=>run.runId),admissions:runs.map((run,index)=>({runId:run.runId,recordIds:recordIds[index]})),generatedAt:now};}

function identityFixture(){
 const assertion=identityAssertion({version:1,leftMentionId:'synthetic-left',rightMentionId:'synthetic-right',decision:'same_identity',status:'accepted',method:'authoritative_review',ruleVersion:'synthetic-rule',author:'synthetic-author',adjudicator:'synthetic-reviewer',evidenceHashes:[sourceHash],reviewReceiptSha256:sha256('synthetic identity assessment'),validity:unknownValidity()});
 const payload={schemaVersion:'assessment-disposition-v1' as const,assertionId:assertion.id,assertionSha256:semanticHash(assertion),assessmentReceiptSha256:assertion.reviewReceiptSha256!,receiptHashes:{A:sha256('synthetic A'),B:sha256('synthetic B'),C:sha256('synthetic C')},itemSha256:sha256('synthetic item'),leftMentionId:assertion.leftMentionId,rightMentionId:assertion.rightMentionId,decision:assertion.decision,status:'admitted' as const,adjudicator:'synthetic-reviewer',labelProvenance:'ai_reconciled' as const,sourceEvidenceHashes:[sourceHash],deterministicPassed:true as const};
 return {assertion,admission:{...payload,sealSha256:semanticHash(payload)}};
}

test('R1 adapter uses exact canonical lineage, original balanced/Codex pins and unique source groups',()=>{
 const old=record('old','anthropic-subscription'),current=record('new');
 const historical=run('balanced',[old],{balanced:true,generatedAt:earlier}),correction=run('correction',[current]);
 const originals=[historical.artifacts.records.bytes,correction.artifacts.records.bytes];
 const context=buildR1TextCompositionContext(input([historical,correction],[[old.id],[current.id]]));
 assert.deepEqual(context.coverage.textLineage,buildTextRunLineage([historical,correction],context.composition.selections,now));
 assert.deepEqual(context.coverage.textLineage.runs.map(run=>run.assignmentMode),['balanced','codex-only']);
 assert.deepEqual(context.coverage.textLineage.runs.map(run=>run.pins),[historical.pins,correction.pins]);
 assert.equal(context.coverage.textLineage.cumulative.attemptsAcrossRuns,2);
 assert.equal(context.coverage.textLineage.cumulative.groups.attemptedDocumentGroups,1);
 assert.equal(context.coverage.textLineage.cumulative.groups.fetchedDocumentGroups,1);
 assert.equal(context.coverage.textLineage.cumulative.groups.selectedDocumentGroups.count,1);
 assert.equal(context.coverage.textLineage.cumulative.groups.preparedDocumentGroups.count,1);
 assert.deepEqual(context.knowledge.records.map(record=>record.extraction),[current.extraction,old.extraction]);
 assert.deepEqual(context.knowledge.records.find(record=>record.id===old.id)!.verification.faithfulness,old.verification.faithfulness);
 assert.deepEqual([historical.artifacts.records.bytes,correction.artifacts.records.bytes],originals);
 assert.equal(context.replay.runs[0].artifacts.records,historical.artifacts.records.sha256);
 const {dependencySha256,...payload}=context.replay;
 assert.equal(dependencySha256,semanticHash(payload));
 assert.deepEqual(context.dependencies,[{role:'text_composition',sha256:dependencySha256}]);
 const noPlan=run('unknown-selection',[old],{balanced:true,includePlan:false});
 assert.equal(buildR1TextCompositionContext(input([noPlan],[[old.id]])).coverage.textLineage.cumulative.groups.selectedDocumentGroups.state,'unknown');
});

test('historical v2 requires explicitly approved schema projection and only adds both text markers',()=>{
 const legacy=historicalV2(record('legacy','anthropic-subscription'));
 const contribution=run('historical-v2',[legacy],{v2:true,balanced:true,generatedAt:earlier});
 assert.throws(()=>buildR1TextCompositionContext(input([contribution],[[legacy.id]])),/kind|schemaProjection|text markers|text_model/i);
 const approved=input([contribution],[[legacy.id]]);
 approved.admissions=[{...approved.admissions[0],schemaProjection:{version:'knowledge-v2-to-v3-text-model-v1'}}];
 const context=buildR1TextCompositionContext(approved),projected=context.knowledge.records[0];
 assert.equal(projected.kind,'text_model');assert.equal(projected.verification.kind,'text_model');
 const {kind:_kind,...claims}=projected,{kind:_verificationKind,evidenceHash:_hash,...gates}=projected.verification;
 const {evidenceHash:_originalHash,...originalGates}=legacy.verification;
 assert.deepEqual({...claims,verification:gates},{...legacy,verification:originalGates});
 assert.deepEqual(context.coverage.textLineage.selectedRecordOrigins[0].schemaProjection,{version:'knowledge-v2-to-v3-text-model-v1'});
 assert.equal(context.coverage.textLineage.selectedRecordOrigins[0].originalEvidenceHash,legacy.verification.evidenceHash);
 const originalRoot=readTextLineageArtifact(contribution.artifacts.records);
 assert.ok(originalRoot!==null&&typeof originalRoot==='object'&&'records' in originalRoot&&Array.isArray(originalRoot.records));
 assert.deepEqual(originalRoot.records[0],legacy);
 const current=run('already-v3',[record('current')]);
 const invalid=input([current],[['current']]);invalid.admissions=[{...invalid.admissions[0],schemaProjection:{version:'knowledge-v2-to-v3-text-model-v1'}}];
 assert.throws(()=>buildR1TextCompositionContext(invalid),/projection|knowledge-v2|unmarked/i);
});

test('explicit historical schema projection normalizes only derived graph IDs and evidence hash',()=>{
 const original=record('legacy-graph');
 const graph=normalizeGraphClaims({entities:[{mentionId:'synthetic-company',name:'Synthetic Company',type:'company',quote:'Synthetic Company',identifiers:[]}],relations:[]},{municipalityId:city,sourceSha256:sourceHash,ags:original.ags});
 const legacy=historicalV2({...original,...graph});
 legacy.entities[0].entityId='entity:'+sha256('synthetic obsolete graph identity');
 legacy.entities[0].identityBasis.key='synthetic obsolete graph identity';
 legacy.verification.evidenceHash=knowledgeEvidenceHash(legacy);
 const before=structuredClone(legacy),contribution=run('legacy-graph',[legacy],{v2:true});
 const approved=input([contribution],[[legacy.id]]);
 approved.admissions=[{...approved.admissions[0],schemaProjection:{version:'knowledge-v2-to-v3-text-model-v1'}}];
 const context=buildR1TextCompositionContext(approved),projected=context.knowledge.records[0];
 assert.notEqual(projected.entities[0].entityId,legacy.entities[0].entityId);
 assert.notEqual(projected.verification.evidenceHash,legacy.verification.evidenceHash);
 const {entityId:_id,identityBasis:_basis,...claim}=projected.entities[0];
 const {entityId:_oldId,identityBasis:_oldBasis,...originalClaim}=legacy.entities[0];
 assert.deepEqual(claim,originalClaim);
 assert.deepEqual(projected.sources,legacy.sources);
 assert.deepEqual(projected.extraction,legacy.extraction);
 assert.deepEqual(projected.verification.faithfulness,legacy.verification.faithfulness);
 assert.deepEqual(legacy,before);
 const unbound=structuredClone(contribution);unbound.artifacts.records.bytes=String(unbound.artifacts.records.bytes)+' ';
 assert.throws(()=>buildR1TextCompositionContext({...approved,contributions:[unbound]}),/artifact hash mismatch/);
});

test('actual v3 root identity assertion/admission histories survive composition without rewriting',()=>{
 const {assertion,admission}=identityFixture();
 const first=run('first',[record('first')],{assertions:[assertion],admissions:[admission]});
 const second=run('second',[record('second')],{assertions:[assertion],admissions:[admission]});
 const context=buildR1TextCompositionContext(input([first,second],[['first'],['second']]));
 assert.deepEqual(context.knowledge.identityAssertions,[assertion]);
 assert.deepEqual(context.knowledge.identityAdmissions,[admission]);
 const conflicting={...assertion,author:'different synthetic author'};
 const conflict=run('conflict',[record('conflict')],{assertions:[conflicting]});
 assert.throws(()=>buildR1TextCompositionContext(input([first,conflict],[['first'],['conflict']])),/Conflicting original identity assertion/);
});

test('final coverage subset keeps all original attempts, rejects native rows and claim/judge rewrites',()=>{
 const first=record('first'),second=record('second');
 const contribution=run('two-records',[first,second]);
 const context=buildR1TextCompositionContext(input([contribution],[['first','second']]));
 const subset=rebuildR1TextCoverageContext(context,[second],now);
 assert.equal(subset.textLineage.selectedRecordOrigins.length,1);
 assert.equal(subset.textLineage.selectedRecordOrigins[0].recordId,'second');
 assert.equal(subset.textLineage.cumulative.groups.attemptedDocumentGroups,1);
 assert.deepEqual(subset.textLineage,buildTextRunLineage([contribution],subset.selections,now));
 assert.throws(()=>rebuildR1TextCoverageContext(context,[{...first,kind:'structured'} as unknown as DistrictKnowledgeRecord],now),/Native records/);
 assert.throws(()=>rebuildR1TextCoverageContext(context,[record('absent')],now),/no selected original run/);
 const rewritten=structuredClone(first);rewritten.summary='Changed claim';rewritten.verification.evidenceHash=knowledgeEvidenceHash(rewritten);
 assert.throws(()=>rebuildR1TextCoverageContext(context,[rewritten],now),/changes original claims/);
 const judge=structuredClone(first);judge.verification.faithfulness.evaluatedAt=now;judge.verification.evidenceHash=knowledgeEvidenceHash(judge);
 assert.throws(()=>rebuildR1TextCoverageContext(context,[judge],now),/changes original claims/);
 assert.throws(()=>rebuildR1TextCoverageContext(context,[first,first],now),/Duplicate selected/);
});

test('retained publication contributions cannot be represented as extraction runs',()=>{
 const contribution=run('retained',[record('retained')]);
 const retained={...contribution,sourceArtifactKind:'retained_publication' as const,retainedPublication:{manifest:artifact({}),coverage:artifact({})}};
 assert.throws(()=>buildR1TextCompositionContext(input([retained],[['retained']])),/authenticated retained-role input/);
 assert.equal(r1TextCompositionInputSchema.safeParse({schemaVersion:'district-r1-text-composition-input-v1',generatedAt:now,approvedRunOrder:[contribution.runId],admissions:[{runId:contribution.runId,recordIds:[]}],contributions:[{runId:contribution.runId,pins:contribution.pins,sourceArtifactKind:'retained_publication',artifacts:Object.fromEntries(Object.entries(contribution.artifacts).map(([key,value])=>[key,{path:key,sha256:value.sha256}]))}]}).success,false);
});

test('failed later correction never deletes an older admitted record or doubles unique attempted bytes',()=>{
 const old=record('carry-forward','anthropic-subscription'),failed=record(old.id);
 failed.verification.status='candidate';failed.verification.faithfulness.score=0.2;failed.verification.evidenceHash=knowledgeEvidenceHash(failed);
 const first=run('carry-forward',[old],{balanced:true,generatedAt:earlier});
 const later=run('failed-correction',[],{cases:[{municipalityId:city,sourceId,sourceSha256:sourceHash,reason:'Synthetic failed correction',candidate:failed}]});
 const context=buildR1TextCompositionContext(input([first,later],[[old.id],[]]));
 assert.deepEqual(context.knowledge.records,[old]);
 assert.equal(context.coverage.textLineage.cumulative.attemptsAcrossRuns,2);
 assert.equal(context.coverage.textLineage.cumulative.groups.attemptedDocumentGroups,1);
 assert.equal(context.coverage.textLineage.selectedRecordOrigins[0].runId,first.runId);
 assert.equal(context.composition.audit.quarantine[0].selectedRunId,first.runId);
 const replacement=run('admitted-replacement',[record(old.id)]);
 const selected=buildR1TextCompositionContext(input([first,replacement],[[old.id],[old.id]]));
 assert.equal(selected.coverage.textLineage.selectedRecordOrigins[0].runId,replacement.runId);
 assert.notEqual(context.replay.dependencySha256,selected.replay.dependencySha256);
});

test('managed-I/O loader uses independently pinned artifacts without implicit projection or reads',async()=>{
 const contribution=run('loaded',[record('loaded')]),memory=new Map<string,string|Uint8Array>();
 const artifacts=Object.fromEntries(Object.entries(contribution.artifacts).map(([name,artifact])=>{
  const path='synthetic-memory/'+name;memory.set(path,artifact.bytes);
  return [name,{path,sha256:artifact.sha256}];
 }));
 const raw={schemaVersion:'district-r1-text-composition-input-v1',generatedAt:now,approvedRunOrder:[contribution.runId],admissions:[{runId:contribution.runId,recordIds:['loaded']}],contributions:[{runId:contribution.runId,pins:contribution.pins,sourceArtifactKind:'native_extraction_output',artifacts}]};
 const original=JSON.stringify(raw),read=async(pin:{path:string})=>{
  const bytes=memory.get(pin.path);if(bytes===undefined)throw Error('Missing synthetic in-memory artifact');return bytes;
 };
 const loaded=await loadR1TextCompositionInput(raw,read);
 assert.equal(loaded.contributions[0].artifacts.records.bytes,contribution.artifacts.records.bytes);
 assert.equal(loaded.admissions[0].schemaProjection,undefined);
 assert.deepEqual(buildR1TextCompositionContext(loaded).knowledge.records,[record('loaded')]);
 assert.equal(JSON.stringify(raw),original);
 memory.set('synthetic-memory/records','tampered synthetic artifact');
 await assert.rejects(loadR1TextCompositionInput(raw,read),/artifact pin mismatch/);
 const invalid=structuredClone(raw);invalid.contributions[0].sourceArtifactKind='retained_publication';
 assert.equal(r1TextCompositionInputSchema.safeParse(invalid).success,false);
});
