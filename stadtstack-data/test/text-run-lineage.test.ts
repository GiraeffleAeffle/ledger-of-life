import test from 'node:test';
import assert from 'node:assert/strict';
import {knowledgeEvidenceHash,sha256,type DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {PROVIDER_CONFIGS,type ExtractorProvider} from '../src/district-model-contract.ts';
import {dataReleaseId} from '../src/data-release.ts';
import {authenticateTextRunContribution,buildAuthenticatedTextRunLineage,buildTextRunLineage,readTextLineageArtifact,textLineageRecordSha256,textRunLineageSchema,type TextLineageArtifact,type TextRecordSelection,type TextRunContribution,type TextRunLineage} from '../src/text-run-lineage.ts';

// Synthetic receipt projections test integrity/accounting, not admission or municipal facts.
const at='2026-10-11T12:00:00.000Z',pdf=sha256('repeated PDF'),other=sha256('another PDF'),pending=sha256('unattempted PDF');
function artifact(value:unknown):TextLineageArtifact{const bytes=JSON.stringify(value);return {bytes,sha256:sha256(bytes)};}
function record(id:string,sourceSha256:string,provider:ExtractorProvider):DistrictKnowledgeRecord{
 const config=PROVIDER_CONFIGS[provider],modelIdentitySha256=sha256(provider);
 const value={id,municipalityId:'town',title:'Synthetic source claim',entities:[],relations:[],sources:[{id:'council',sha256:sourceSha256}],extraction:{provider,model:config.model,tool:config.tool,toolVersion:'synthetic-version',modelIdentitySha256,modelIdentityBasis:config.modelIdentityBasis,inputSha256:sourceSha256,responseSha256:sha256(id+provider),promptSha256:sha256('extraction prompt'),judgePromptSha256:sha256('judge prompt'),extractedAt:at},verification:{evidenceHash:'0'.repeat(64),faithfulness:{provider,model:config.model,tool:config.tool,toolVersion:'synthetic-version',modelIdentitySha256,responseSha256:sha256('judge '+id+provider)}}};
 value.verification.evidenceHash=knowledgeEvidenceHash(value);
 return value as unknown as DistrictKnowledgeRecord;
}
function contribution(records:DistrictKnowledgeRecord[],mode:'balanced'|'codex-only',fetched:string[]=records.map(row=>row.extraction.inputSha256),municipalityId='town'):TextRunContribution{
 const groups=[...new Set(records.map(row=>row.extraction.inputSha256))],available=[...new Set(fetched)];
 const registry=artifact({municipalities:[{id:municipalityId,sources:[{id:'council'}]}]});
 const crawl=artifact({schemaVersion:'stadtstack-crawl-index-v1',generatedAt:at,documents:fetched.map((sha256,i)=>({id:'doc-'+i,municipalityId,sourceId:'council',sha256})),checks:[{municipalityId,sourceId:'council',checkedAt:at,coverage:{state:'partial',pendingCount:7,runnableCount:7,blockedCount:0}}]});
 const pins={corpusSha256:crawl.sha256,registrySha256:registry.sha256,promptContractSha256:sha256('joint prompt'),schemaSha256:sha256('original schema')};
 const run=artifact({schemaVersion:'stadtstack-extraction-run-v2',generatedAt:at,assignmentMode:mode,...pins,scope:'bounded_per_municipality',maxDocumentsPerMunicipality:3,availableDocumentGroups:available.length,attemptedDocumentGroups:groups.length,pendingDocumentGroups:available.length-groups.length,municipalities:[{id:municipalityId,availableDocumentGroups:available.length,selectedDocumentGroups:groups.length,preparedDocumentGroups:groups.length,attemptedDocumentGroups:groups.length}],providers:Object.entries(PROVIDER_CONFIGS).map(([provider,config])=>({provider,model:config.model,tool:config.tool,assignedGroups:new Set(records.filter(row=>row.extraction.provider===provider).map(row=>row.extraction.inputSha256)).size,completedGroups:new Set(records.filter(row=>row.extraction.provider===provider).map(row=>row.extraction.inputSha256)).size,agreementCompleted:0,publishedCandidates:records.filter(row=>row.extraction.provider===provider).length}))});
 const preparationPlan=artifact({schemaVersion:'stadtstack-preparation-plan-v1',...pins,maxDocumentsPerMunicipality:3,availableDocumentGroups:available.length,selectedDocumentGroups:groups.length,municipalities:[{id:municipalityId,selectedDocumentGroups:groups.length}],groups:groups.map(sourceSha256=>({expected:{municipalityId,sourceSha256,receiptSha256:sha256('prepared '+sourceSha256)}})),quarantine:[]});
 return {sourceArtifactKind:'native_extraction_output',runId:run.sha256,pins,artifacts:{extractionRun:run,records:artifact({schemaVersion:'stadtstack-knowledge-v2',generatedAt:at,records}),quarantine:artifact({schemaVersion:'stadtstack-quarantine-v1',cases:[]}),crawl,registry,preparationPlan}};
}
function selection(run:TextRunContribution,record:DistrictKnowledgeRecord):TextRecordSelection{return {runId:run.runId,recordId:record.id,originalEvidenceHash:record.verification.evidenceHash,projectedRecord:structuredClone(record)};}
function changedArtifact(input:TextRunContribution,key:keyof TextRunContribution['artifacts'],change:(value:any)=>void):TextRunContribution{
 const copy=structuredClone(input),value=readTextLineageArtifact(copy.artifacts[key]!);change(value);copy.artifacts[key]=artifact(value);
 if(key==='extractionRun')copy.runId=copy.artifacts.extractionRun.sha256;
 return copy;
}

test('genuine original balanced receipts coexist with a later Codex-only correction',()=>{
 const oldCodex=record('unchanged',other,'openai-subscription'),oldHaiku=record('old-haiku',pdf,'anthropic-subscription'),correction=record('correction',pdf,'openai-subscription');
 const old=contribution([oldCodex,oldHaiku],'balanced',[other,pdf,pending]),newer=contribution([correction],'codex-only',[pdf,pending]);
 const lineage=buildTextRunLineage([old,newer],[selection(old,oldCodex),selection(old,oldHaiku),selection(newer,correction)],at);
 assert.deepEqual(lineage.runs.map(run=>run.assignmentMode),['balanced','codex-only']);
 assert.deepEqual(lineage.selectedRecordOrigins.map(origin=>origin.model.provider),['openai-subscription','anthropic-subscription','openai-subscription']);
 assert.equal(lineage.selectedRecordOrigins[1].originalRecordSha256,textLineageRecordSha256(oldHaiku));
 assert.equal(lineage.selectedRecordOrigins[1].judgeResponseSha256,oldHaiku.verification.faithfulness.responseSha256);
 assert.equal(lineage.selectedRecordOrigins[1].outputArtifactSha256,old.artifacts.records.sha256);
 assert.equal(lineage.runs[0].pins.corpusSha256,old.pins.corpusSha256);
 assert.equal(lineage.runs[1].pins.corpusSha256,newer.pins.corpusSha256);
 assert.equal(lineage.cumulative.attemptsAcrossRuns,3);
 assert.equal(lineage.cumulative.groups.attemptedDocumentGroups,2);
 assert.equal(lineage.cumulative.groups.fetchedDocumentGroups,3);
 assert.equal(lineage.cumulative.groups.pendingFetchedDocumentGroups,1);
 assert.deepEqual(lineage.cumulative.groups.selectedDocumentGroups,{state:'exact',count:2});
 assert.deepEqual(lineage.cumulative.groups.preparedDocumentGroups,{state:'exact',count:2});
 assert.equal(lineage.cumulative.frontierUnion,'unknown');
 assert.equal(JSON.stringify(lineage).includes('pendingCount'),false);
});

test('repeat PDF representations and later attempts do not inflate unique municipality groups',()=>{
 const a=record('first',pdf,'anthropic-subscription'),b=record('second',pdf,'openai-subscription');
 const old=contribution([a],'balanced',[pdf,pdf]),newer=contribution([b],'codex-only',[pdf]);
 const lineage=buildTextRunLineage([old,newer],[selection(old,a),selection(newer,b)],at);
 assert.equal(lineage.cumulative.attemptsAcrossRuns,2);
 assert.equal(lineage.cumulative.groups.fetchedDocumentGroups,1);
 assert.equal(lineage.cumulative.groups.attemptedDocumentGroups,1);
 assert.equal(lineage.cumulative.municipalities[0].attemptedDocumentGroups,1);
 assert.equal(lineage.cumulative.groups.selectedDocumentGroups.count,1);
});

test('unavailable exact preparation identities are explicitly unknown rather than inferred from counts',()=>{
 const a=record('one',pdf,'openai-subscription'),run=contribution([a],'codex-only');delete run.artifacts.preparationPlan;
 const lineage=buildTextRunLineage([run],[selection(run,a)],at);
 assert.equal(lineage.runs[0].municipalities![0].selectedDocumentGroups,1);
 assert.deepEqual(lineage.runs[0].groups.selectedDocumentGroups,{state:'unknown',count:null});
 assert.deepEqual(lineage.cumulative.groups.preparedDocumentGroups,{state:'unknown',count:null});
 const incomplete=changedArtifact(contribution([a],'codex-only'),'preparationPlan',plan=>{plan.groups=[];});
 assert.throws(()=>authenticateTextRunContribution(incomplete),/metadata incomplete/);
 const incorrect=changedArtifact(contribution([a],'codex-only'),'preparationPlan',plan=>{plan.groups[0].expected.sourceSha256=other;});
 assert.throws(()=>authenticateTextRunContribution(incorrect),/absent from original corpus/);
});

test('wrong mode, run ID, original pins, source-bound counts and provider summary fail closed',()=>{
 const a=record('one',pdf,'anthropic-subscription'),run=contribution([a],'balanced');
 assert.throws(()=>authenticateTextRunContribution(changedArtifact(run,'extractionRun',value=>{value.assignmentMode='codex-only';})),/Codex-only/);
 assert.throws(()=>authenticateTextRunContribution({...run,runId:sha256('invented run')}),/run ID/);
 assert.throws(()=>authenticateTextRunContribution({...run,pins:{...run.pins,registrySha256:sha256('current registry')}}),/pin mismatch/);
 assert.throws(()=>authenticateTextRunContribution(changedArtifact(run,'extractionRun',value=>{value.municipalities[0].attemptedDocumentGroups=0;})),/counts mismatch/);
 assert.throws(()=>authenticateTextRunContribution(changedArtifact(run,'extractionRun',value=>{value.providers[1].publishedCandidates=0;})),/provider output binding/);
 const altered=structuredClone(run);altered.artifacts.records.bytes+=' ';
 assert.throws(()=>authenticateTextRunContribution(altered),/artifact hash/);
 const staleEvidence=changedArtifact(run,'records',value=>{value.records[0].title='changed source claim';});
 assert.throws(()=>authenticateTextRunContribution(staleEvidence),/evidence hash/);
});

test('selected origins reject wrong record, run and evidence hashes or altered receipts',()=>{
 const a=record('one',pdf,'anthropic-subscription'),b=record('two',other,'openai-subscription'),old=contribution([a],'balanced'),newer=contribution([b],'codex-only');
 const good=selection(old,a);
 for(const invalid of [{...good,runId:newer.runId},{...good,recordId:'invented'},{...good,originalEvidenceHash:sha256('wrong')}])assert.throws(()=>buildTextRunLineage([old,newer],[invalid],at),/bind|binding/);
 const wrongProjected=structuredClone(good);wrongProjected.projectedRecord.verification.evidenceHash=sha256('wrong current');
 assert.throws(()=>buildTextRunLineage([old],[wrongProjected],at),/hash binding/);
 const changed=structuredClone(good);changed.projectedRecord.extraction.responseSha256=sha256('fabricated native receipt');changed.projectedRecord.verification.evidenceHash=knowledgeEvidenceHash(changed.projectedRecord);
 assert.throws(()=>buildTextRunLineage([old],[changed],at),/generation\/judge receipts/);
 assert.throws(()=>buildTextRunLineage([old],[good,good],at),/Duplicate selected/);
});

test('authenticated decoded receipts avoid repeated parsing and cannot be fabricated or mutated',()=>{
 const a=record('one',pdf,'openai-subscription'),run=contribution([a],'codex-only'),decoded=authenticateTextRunContribution(run);
 assert.equal(buildAuthenticatedTextRunLineage([decoded],[selection(run,a)],at).runs[0].runId,run.runId);
 assert.throws(()=>{decoded.records[0].extraction.responseSha256=sha256('mutated');},TypeError);
 assert.throws(()=>buildAuthenticatedTextRunLineage([{...decoded}],[selection(run,a)],at),/authenticated original/);
});

test('original registry/corpus and preparation metadata are not replaced by current snapshots',()=>{
 const a=record('one',pdf,'openai-subscription'),run=contribution([a],'codex-only');
 const current=changedArtifact(run,'crawl',value=>{value.documents.push({...value.documents[0],sha256:pending});});
 assert.throws(()=>authenticateTextRunContribution(current),/registry\/corpus artifact pin/);
 const registry=changedArtifact(run,'registry',value=>{value.municipalities[0].sources.push({id:'new'});});
 assert.throws(()=>authenticateTextRunContribution(registry),/registry\/corpus artifact pin/);
 const plan=changedArtifact(run,'preparationPlan',value=>{value.registrySha256=sha256('another original registry');});
 assert.throws(()=>authenticateTextRunContribution(plan),/plan original run binding/);
});

test('identity projection binds both hashes while preserving every original generation receipt',()=>{
 const a=record('one',pdf,'anthropic-subscription');
 a.entities=[{mentionId:'council',name:'Synthetic council',type:'authority',quote:'Synthetic council',identifiers:[],entityId:`entity:${sha256('old identity')}`,identityBasis:{kind:'municipality_scoped_name',key:'old key',scope:'town',ambiguity:'Source-grounded identity grouping, not independent legal-entity verification.'}}];
 a.verification.evidenceHash=knowledgeEvidenceHash(a);
 const run=contribution([a],'balanced'),selected=selection(run,a);
 selected.projectedRecord.entities[0].entityId=`entity:${sha256('current identity')}`;
 selected.projectedRecord.entities[0].identityBasis.key='current key';
 selected.projectedRecord.verification.evidenceHash=knowledgeEvidenceHash(selected.projectedRecord);
 const origin=buildTextRunLineage([run],[selected],at).selectedRecordOrigins[0];
 assert.equal(origin.originalEvidenceHash,a.verification.evidenceHash);
 assert.equal(origin.projectedEvidenceHash,selected.projectedRecord.verification.evidenceHash);
 assert.equal(origin.currentEvidenceHash,origin.projectedEvidenceHash);
 assert.notEqual(origin.originalEvidenceHash,origin.projectedEvidenceHash);
 assert.deepEqual(selected.projectedRecord.extraction,a.extraction);
 assert.deepEqual(selected.projectedRecord.verification.faithfulness,a.verification.faithfulness);
});

test('public exact group bindings retain unselected output attempts and reject inconsistent counts',()=>{
 const a=record('published',pdf,'openai-subscription'),b=record('held',other,'anthropic-subscription'),run=contribution([a,b],'balanced',[pdf,other,pending]);
 const lineage=buildTextRunLineage([run],[selection(run,a)],at);
 assert.equal(lineage.selectedRecordOrigins.length,1);
 assert.deepEqual(lineage.cumulative.groupBindings.attempted.map(group=>group.sourceSha256),[pdf,other].sort());
 assert.equal(lineage.cumulative.groupBindings.fetched.length,3);
 const wrong=structuredClone(lineage);wrong.cumulative.groups.attemptedDocumentGroups=1;
 assert.throws(()=>textRunLineageSchema.parse(wrong),/counts do not bind/);
 const duplicate=structuredClone(lineage);duplicate.cumulative.groupBindings.attempted.push(duplicate.cumulative.groupBindings.attempted[0]);
 assert.throws(()=>textRunLineageSchema.parse(duplicate),/unique and canonically ordered/);
 const municipality=structuredClone(lineage);municipality.cumulative.municipalities[0].pendingFetchedDocumentGroups=0;
 assert.throws(()=>textRunLineageSchema.parse(municipality),/municipality counts/);
 const wrongOrigin=structuredClone(lineage);wrongOrigin.selectedRecordOrigins[0].outputArtifactSha256=sha256('another output');
 assert.throws(()=>textRunLineageSchema.parse(wrongOrigin),/origin binding/);
});

test('preparation quarantines are attempted selections but are not invented prepared groups',()=>{
 let run=contribution([],'codex-only',[pdf]);
 run=changedArtifact(run,'extractionRun',value=>{value.attemptedDocumentGroups=1;value.pendingDocumentGroups=0;value.municipalities[0]={id:'town',selectedDocumentGroups:1,preparedDocumentGroups:0,attemptedDocumentGroups:1};});
 run=changedArtifact(run,'quarantine',value=>{value.cases=[{municipalityId:'town',sourceId:'council',sourceSha256:pdf,reason:'Synthetic preparation failure'}];});
 run=changedArtifact(run,'preparationPlan',value=>{value.selectedDocumentGroups=1;value.municipalities[0].selectedDocumentGroups=1;value.quarantine=[{municipalityId:'town',sourceId:'council',sourceSha256:pdf}];});
 const lineage=buildTextRunLineage([run],[],at);
 assert.equal(lineage.cumulative.groups.attemptedDocumentGroups,1);
 assert.deepEqual(lineage.cumulative.groups.selectedDocumentGroups,{state:'exact',count:1});
 assert.deepEqual(lineage.cumulative.groups.preparedDocumentGroups,{state:'exact',count:0});
});

test('artifact clocks remain independent while native output totals bind the original run',()=>{
 const a=record('one',pdf,'openai-subscription');
 let run=contribution([a],'codex-only');
 const recordsAt='2026-10-11T09:13:01.721Z',runAt='2026-10-11T08:44:22.416Z',quarantineAt='2026-10-11T09:14:01.721Z';
 run=changedArtifact(run,'extractionRun',value=>{value.generatedAt=runAt;});
 run=changedArtifact(run,'records',value=>{value.generatedAt=recordsAt;});
 run=changedArtifact(run,'quarantine',value=>{value.generatedAt=quarantineAt;});
 const lineage=buildTextRunLineage([run],[selection(run,a)],at);
 assert.equal(lineage.runs[0].generatedAt,runAt);
 assert.equal(lineage.runs[0].artifactClocks.extractionRun,runAt);
 assert.equal(lineage.runs[0].artifactClocks.records,recordsAt);
 assert.equal(lineage.runs[0].artifactClocks.quarantine,quarantineAt);
 assert.equal(lineage.runs[0].artifactClocks.crawl,at);
 assert.equal(lineage.runs[0].artifactClocks.preparationPlan,null);
 assert.equal(authenticateTextRunContribution(run).records[0].extraction.extractedAt,a.extraction.extractedAt);
 assert.throws(()=>authenticateTextRunContribution(changedArtifact(run,'extractionRun',value=>{value.promotedRecords=2;})),/record counts/);
 assert.throws(()=>authenticateTextRunContribution(changedArtifact(run,'extractionRun',value=>{value.quarantinedCases=1;})),/record counts/);
});

function retainedContribution(native:TextRunContribution,records:DistrictKnowledgeRecord[]):Extract<TextRunContribution,{sourceArtifactKind:'retained_publication'}>{
 const run=readTextLineageArtifact(native.artifacts.extractionRun) as Record<string,any>,generatedAt='2026-10-11T09:13:01.721Z';
 const recordsArtifact=artifact({schemaVersion:'stadtstack-knowledge-v2',generatedAt,records});
 const models=new Map<string,{provider:ExtractorProvider;model:string;tool:'codex-cli'|'claude-cli';toolVersion:string;modelIdentitySha256:string;modelIdentityBasis:'configured-cli-model-and-tool-version'|'reported-cli-model-and-tool-version';publishedRecords:number;faithfulnessThreshold:0.8}>();
 for(const record of records){
  const {provider,model,tool,toolVersion,modelIdentitySha256,modelIdentityBasis}=record.extraction,key=modelIdentitySha256,previous=models.get(key);
  if(previous)previous.publishedRecords++;
  else models.set(key,{provider,model,tool,toolVersion,modelIdentitySha256,modelIdentityBasis,publishedRecords:1,faithfulnessThreshold:0.8});
 }
 const coverage=artifact({schemaVersion:'stadtstack-district-coverage-v3',generatedAt,extractionRun:{generatedAt:run.generatedAt,assignmentMode:run.assignmentMode,...native.pins,selection:run.scope==='all_fetched_documents'?'all_at_run_start':'bounded_per_municipality',maxDocumentsPerMunicipality:run.maxDocumentsPerMunicipality,availableDocumentGroupsAtRunStart:run.availableDocumentGroups,attemptedDocumentGroups:run.attemptedDocumentGroups,pendingDocumentGroupsAtRunStart:run.pendingDocumentGroups},municipalities:[{id:'town',publishedRecords:records.length}],models:[...models.values()]});
 const files=[['knowledge/records.json',recordsArtifact],['knowledge/coverage.json',coverage]].map(([path,value])=>{const member=value as TextLineageArtifact;return {path:path as 'knowledge/records.json'|'knowledge/coverage.json',sha256:member.sha256,bytes:typeof member.bytes==='string'?Buffer.byteLength(member.bytes):member.bytes.byteLength};});
 const manifest=artifact({schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt,files,quality:{publishedRecords:records.length,quarantinedRecords:0,cities:1}});
 return {...native,sourceArtifactKind:'retained_publication',artifacts:{...native.artifacts,records:recordsArtifact},retainedPublication:{manifest,coverage}};
}

test('sealed retained admission subsets preserve original run counts and actual later artifact clocks',()=>{
 const oldCodex=record('old-codex',other,'openai-subscription'),oldHaiku=record('old-haiku',pdf,'anthropic-subscription');
 let native=contribution([oldCodex,oldHaiku],'balanced');
 native=changedArtifact(native,'extractionRun',value=>{value.generatedAt='2026-10-11T08:44:22.416Z';value.promotedRecords=429;value.quarantinedCases=42;value.providers[0].publishedCandidates=200;value.providers[1].publishedCandidates=229;});
 const retained=retainedContribution(native,[oldHaiku]),correction=record('correction',pdf,'openai-subscription'),newer=contribution([correction],'codex-only');
 const lineage=buildTextRunLineage([retained,newer],[selection(retained,oldHaiku),selection(newer,correction)],at);
 assert.equal(lineage.runs[0].sourceArtifactKind,'retained_publication');
 assert.equal(lineage.runs[0].artifactClocks.extractionRun,'2026-10-11T08:44:22.416Z');
 assert.equal(lineage.runs[0].artifactClocks.records,'2026-10-11T09:13:01.721Z');
 assert.equal(lineage.runs[0].providers!.find(row=>row.provider==='anthropic-subscription')!.publishedCandidates,229);
 assert.equal(lineage.runs[0].retainedPublication!.manifestSha256,retained.retainedPublication.manifest.sha256);
 assert.equal(lineage.selectedRecordOrigins[0].sourceArtifactKind,'retained_publication');
 assert.equal(lineage.selectedRecordOrigins[0].outputArtifactSha256,retained.artifacts.records.sha256);
 assert.equal(lineage.selectedRecordOrigins[0].originalEvidenceHash,oldHaiku.verification.evidenceHash);
 assert.equal(lineage.selectedRecordOrigins[0].judgeResponseSha256,oldHaiku.verification.faithfulness.responseSha256);
 assert.equal(lineage.cumulative.attemptsAcrossRuns,3);
 assert.equal(lineage.cumulative.groups.attemptedDocumentGroups,2);
 const unavailable=structuredClone(retained);delete unavailable.artifacts.preparationPlan;
 assert.throws(()=>authenticateTextRunContribution(unavailable),/attempt group identities are unavailable/);
 const relabelled={...retained,sourceArtifactKind:'native_extraction_output',retainedPublication:undefined} as TextRunContribution;
 assert.throws(()=>authenticateTextRunContribution(relabelled),/record counts/);
});

test('retained publication admission is bound to actual manifest members, coverage and original run pins',()=>{
 const a=record('retained',pdf,'anthropic-subscription'),retained=retainedContribution(contribution([a],'balanced'),[a]);
 const wrongMember=structuredClone(retained),manifest=readTextLineageArtifact(wrongMember.retainedPublication.manifest) as Record<string,any>;
 manifest.files[0].sha256=sha256('different retained records');manifest.id=dataReleaseId(manifest.files);
 wrongMember.retainedPublication.manifest=artifact(manifest);
 assert.throws(()=>authenticateTextRunContribution(wrongMember),/member binding/);
 const wrongCoverage=structuredClone(retained);wrongCoverage.retainedPublication.coverage.bytes=String(wrongCoverage.retainedPublication.coverage.bytes)+' ';
 assert.throws(()=>authenticateTextRunContribution(wrongCoverage),/member binding|artifact hash/);
 const wrongRun=changedArtifact(retained,'extractionRun',value=>{value.generatedAt='2026-10-10T12:00:00.000Z';});
 assert.throws(()=>authenticateTextRunContribution(wrongRun),/original run binding/);
 const missingProof={...retained,retainedPublication:undefined} as unknown as TextRunContribution;
 assert.throws(()=>authenticateTextRunContribution(missingProof),/requires explicit manifest/);
});

test('a sealed retained coverage member cannot misstate its admitted model receipts',()=>{
 const a=record('retained',pdf,'anthropic-subscription'),retained=retainedContribution(contribution([a],'balanced'),[a]);
 const coverage=readTextLineageArtifact(retained.retainedPublication.coverage) as Record<string,any>;
 coverage.models[0].publishedRecords=2;
 retained.retainedPublication.coverage=artifact(coverage);
 const manifest=readTextLineageArtifact(retained.retainedPublication.manifest) as Record<string,any>,member=manifest.files.find((file:{path:string})=>file.path==='knowledge/coverage.json');
 member.sha256=retained.retainedPublication.coverage.sha256;
 member.bytes=Buffer.byteLength(String(retained.retainedPublication.coverage.bytes));
 manifest.id=dataReleaseId(manifest.files);retained.retainedPublication.manifest=artifact(manifest);
 assert.throws(()=>authenticateTextRunContribution(retained),/model receipt binding/);
});

test('retained v4/v5 text lineage selects each real run and preserves original member indexes',()=>{
 for(const schemaVersion of ['stadtstack-district-coverage-v4','stadtstack-district-coverage-v5']){
  const a=record('haiku',pdf,'anthropic-subscription'),b=record('codex',other,'openai-subscription');
  if(schemaVersion.endsWith('v5'))for(const row of [a,b]){Object.assign(row,{kind:'text_model'});Object.assign(row.verification,{kind:'text_model'});row.verification.evidenceHash=knowledgeEvidenceHash(row);}
  const old=contribution([a],'balanced'),newer=contribution([b],'codex-only');
  if(schemaVersion.endsWith('v5'))for(const run of [old,newer]){
   const envelope=readTextLineageArtifact(run.artifacts.records) as Record<string,unknown>;
   run.artifacts.records=artifact({...envelope,schemaVersion:'stadtstack-knowledge-v3',identityAssertions:[],identityAdmissions:[]});
  }
  const prior=buildTextRunLineage([old,newer],[selection(old,a),selection(newer,b)],at);
  // Global native admission is R1-owned; text lineage skips only explicit structured rows.
  const members=schemaVersion.endsWith('v5')?[{id:'opaque-native-row',kind:'structured',verification:{kind:'structured'}},b,a]:[b,a];
  const recordsArtifact=artifact({schemaVersion:schemaVersion.endsWith('v5')?'stadtstack-knowledge-v3':'stadtstack-knowledge-v2',generatedAt:at,records:members,...(schemaVersion.endsWith('v5')?{identityAssertions:[],identityAdmissions:[]}:{})});
  const coverage=artifact({schemaVersion,generatedAt:at,textLineage:prior,municipalities:[{id:'town',publishedRecords:members.length}]});
  const files=[{path:'knowledge/records.json' as const,sha256:recordsArtifact.sha256,bytes:Buffer.byteLength(String(recordsArtifact.bytes))},{path:'knowledge/coverage.json' as const,sha256:coverage.sha256,bytes:Buffer.byteLength(String(coverage.bytes))}];
  const manifest=artifact({schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt:at,files,quality:{publishedRecords:members.length,quarantinedRecords:0,cities:1}});
  const retainedOld:TextRunContribution={...old,sourceArtifactKind:'retained_publication',artifacts:{...old.artifacts,records:recordsArtifact},retainedPublication:{manifest,coverage}};
  const retainedNew:TextRunContribution={...newer,sourceArtifactKind:'retained_publication',artifacts:{...newer.artifacts,records:recordsArtifact},retainedPublication:{manifest,coverage}};
  const decodedOld=authenticateTextRunContribution(retainedOld),decodedNew=authenticateTextRunContribution(retainedNew);
  assert.deepEqual(decodedOld.records.map(record=>record.id),['haiku']);
  assert.deepEqual(decodedNew.records.map(record=>record.id),['codex']);
  const lineage=buildAuthenticatedTextRunLineage([decodedOld,decodedNew],[selection(retainedOld,a),selection(retainedNew,b)],at);
  assert.equal(lineage.selectedRecordOrigins[0].outputRecordIndex,members.length-1);
  assert.equal(lineage.selectedRecordOrigins[1].outputRecordIndex,members.length-2);
  assert.equal(lineage.selectedRecordOrigins.some(origin=>origin.recordId==='opaque-native-row'),false);
  if(schemaVersion.endsWith('v5')){
   const reseal=(records:unknown[]):TextRunContribution=>{
    const replacement=artifact({schemaVersion:'stadtstack-knowledge-v3',generatedAt:at,records,identityAssertions:[],identityAdmissions:[]});
    const replacementFiles=files.map(file=>file.path==='knowledge/records.json'?{...file,sha256:replacement.sha256,bytes:Buffer.byteLength(String(replacement.bytes))}:file);
    const replacementManifest=artifact({schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(replacementFiles),generatedAt:at,files:replacementFiles,quality:{publishedRecords:records.length,quarantinedRecords:0,cities:1}});
    return {...retainedOld,sourceArtifactKind:'retained_publication',artifacts:{...retainedOld.artifacts,records:replacement},retainedPublication:{manifest:replacementManifest,coverage}};
   };
   assert.throws(()=>authenticateTextRunContribution(reseal([{id:'opaque-native-row'},b,a])));
   assert.throws(()=>authenticateTextRunContribution(reseal([{id:'opaque-native-row',kind:'unrecognized'},b,a])));
   const extra=record('unattributed-text',pdf,'anthropic-subscription');Object.assign(extra,{kind:'text_model'});Object.assign(extra.verification,{kind:'text_model'});extra.verification.evidenceHash=knowledgeEvidenceHash(extra);
   assert.throws(()=>authenticateTextRunContribution(reseal([...members,extra])),/text record inventory/);
   assert.throws(()=>authenticateTextRunContribution(reseal([members[0],b,extra])),/lineage text record is missing/);
  }
 }
});

test('public lineage validation enforces original run caps/counts/providers without private inputs',()=>{
 const a=record('one',pdf,'openai-subscription'),run=contribution([a],'codex-only'),lineage=buildTextRunLineage([run],[selection(run,a)],at);
 for(const mutate of [
  (value:typeof lineage)=>{value.runs[0].scope='all_fetched_documents';},
  (value:typeof lineage)=>{value.runs[0].maxDocumentsPerMunicipality=0;},
  (value:typeof lineage)=>{value.runs[0].municipalities![0].attemptedDocumentGroups=2;},
  (value:typeof lineage)=>{value.runs[0].municipalities![0].selectedDocumentGroups=4;},
  (value:typeof lineage)=>{value.runs[0].municipalities![0].preparedDocumentGroups=2;},
  (value:typeof lineage)=>{value.runs[0].providers!.find(row=>row.provider==='anthropic-subscription')!.assignedGroups=1;},
 ]){
  const invalid=structuredClone(lineage);mutate(invalid);assert.throws(()=>textRunLineageSchema.parse(invalid));
 }
 const b=record('two',other,'openai-subscription');
 const bounded=[run,contribution([b],'codex-only')].map(input=>{
  let next=changedArtifact(input,'extractionRun',value=>{value.maxDocumentsPerMunicipality=1;});
  next=changedArtifact(next,'preparationPlan',value=>{value.maxDocumentsPerMunicipality=1;});return next;
 });
 const cumulative=buildTextRunLineage(bounded,[selection(bounded[0],a),selection(bounded[1],b)],at);
 assert.equal(cumulative.cumulative.groups.attemptedDocumentGroups,2);
 assert.deepEqual(cumulative.runs.map(original=>original.maxDocumentsPerMunicipality),[1,1]);
 assert.doesNotThrow(()=>textRunLineageSchema.parse(cumulative));
});

test('knowledge-v2 to v3 kind migration requires an explicit narrow projection receipt',()=>{
 const a=record('migrated',pdf,'openai-subscription'),run=contribution([a],'codex-only'),selected=selection(run,a);
 Object.assign(selected.projectedRecord,{kind:'text_model'});
 Object.assign(selected.projectedRecord.verification,{kind:'text_model'});
 selected.projectedRecord.verification.evidenceHash=knowledgeEvidenceHash(selected.projectedRecord);
 assert.throws(()=>buildTextRunLineage([run],[selected],at),/generation\/judge receipts/);
 selected.schemaProjection={version:'knowledge-v2-to-v3-text-model-v1'};
 const lineage=buildTextRunLineage([run],[selected],at),origin=lineage.selectedRecordOrigins[0];
 assert.equal(lineage.runs[0].recordsSchemaVersion,'stadtstack-knowledge-v2');
 assert.deepEqual(origin.schemaProjection,selected.schemaProjection);
 assert.equal(origin.originalEvidenceHash,a.verification.evidenceHash);
 assert.equal(origin.currentEvidenceHash,selected.projectedRecord.verification.evidenceHash);
 assert.equal(origin.judgeResponseSha256,a.verification.faithfulness.responseSha256);
 const changed=structuredClone(selected);changed.projectedRecord.title='Changed claim';changed.projectedRecord.verification.evidenceHash=knowledgeEvidenceHash(changed.projectedRecord);
 assert.throws(()=>buildTextRunLineage([run],[changed],at),/generation\/judge receipts/);
 const wrongKind=structuredClone(selected);Object.assign(wrongKind.projectedRecord.verification,{kind:'structured'});wrongKind.projectedRecord.verification.evidenceHash=knowledgeEvidenceHash(wrongKind.projectedRecord);
 assert.throws(()=>buildTextRunLineage([run],[wrongKind],at),/both explicit text_model/);
 const missing=selection(run,a);missing.schemaProjection=selected.schemaProjection;
 assert.throws(()=>buildTextRunLineage([run],[missing],at),/both explicit text_model/);
 assert.throws(()=>buildTextRunLineage([run],[{...selected,schemaProjection:{version:'unknown'}} as unknown as TextRecordSelection],at));
 const v3=contribution([selected.projectedRecord],'codex-only'),envelope=readTextLineageArtifact(v3.artifacts.records) as Record<string,unknown>;
 v3.artifacts.records=artifact({...envelope,schemaVersion:'stadtstack-knowledge-v3',identityAssertions:[],identityAdmissions:[]});
 const alreadyV3=selection(v3,selected.projectedRecord);alreadyV3.schemaProjection=selected.schemaProjection;
 assert.throws(()=>buildTextRunLineage([v3],[alreadyV3],at),/unmarked authenticated knowledge-v2/);
 const invalidPublic=structuredClone(lineage);invalidPublic.runs[0].recordsSchemaVersion='stadtstack-knowledge-v3';
 assert.throws(()=>textRunLineageSchema.parse(invalidPublic),/authenticated knowledge-v2 source/);
});

function recountCumulative(lineage:TextRunLineage):void{
 const counts=(municipalityId?:string)=>{
  const bindings=lineage.cumulative.groupBindings;
  const groups={fetched:bindings.fetched.filter(group=>municipalityId===undefined||group.municipalityId===municipalityId),attempted:bindings.attempted.filter(group=>municipalityId===undefined||group.municipalityId===municipalityId),selected:bindings.selected?.filter(group=>municipalityId===undefined||group.municipalityId===municipalityId)??null,prepared:bindings.prepared?.filter(group=>municipalityId===undefined||group.municipalityId===municipalityId)??null};
  const fetched=new Set(groups.fetched.map(group=>JSON.stringify([group.municipalityId,group.sourceSha256]))),present=groups.attempted.filter(group=>fetched.has(JSON.stringify([group.municipalityId,group.sourceSha256]))).length;
  return {fetchedDocumentGroups:groups.fetched.length,attemptedDocumentGroups:groups.attempted.length,selectedDocumentGroups:groups.selected===null?{state:'unknown' as const,count:null}:{state:'exact' as const,count:groups.selected.length},preparedDocumentGroups:groups.prepared===null?{state:'unknown' as const,count:null}:{state:'exact' as const,count:groups.prepared.length},pendingFetchedDocumentGroups:fetched.size-present,unavailableAttemptedDocumentGroups:groups.attempted.length-present};
 };
 lineage.cumulative.groups=counts();
 lineage.cumulative.municipalities=lineage.cumulative.municipalities.map(city=>({id:city.id,...counts(city.id)}));
}

test('public cumulative groups cannot hide a single run attempt or exceed any exact category sum',()=>{
 const a=record('selected',pdf,'openai-subscription'),b=record('held',other,'openai-subscription'),run=contribution([a,b],'codex-only');
 const lineage=buildTextRunLineage([run],[selection(run,a)],at);
 const hidden=structuredClone(lineage);hidden.cumulative.groupBindings.attempted=hidden.cumulative.groupBindings.attempted.filter(group=>group.sourceSha256!==other);recountCumulative(hidden);
 assert.throws(()=>textRunLineageSchema.parse(hidden),/attempted union bounds/);
 for(const kind of ['fetched','attempted','selected','prepared'] as const){
  const smaller=structuredClone(lineage);smaller.cumulative.groupBindings[kind]!.pop();recountCumulative(smaller);
  assert.throws(()=>textRunLineageSchema.parse(smaller),/union bounds/);
  const larger=structuredClone(lineage);larger.cumulative.groupBindings[kind]!.push({municipalityId:'town',sourceSha256:pending});
  larger.cumulative.groupBindings[kind]!.sort((left,right)=>left.sourceSha256<right.sourceSha256?-1:left.sourceSha256>right.sourceSha256?1:0);recountCumulative(larger);
  assert.throws(()=>textRunLineageSchema.parse(larger),/union bounds/);
 }
});

test('public municipality union bounds cannot move historic groups between municipalities',()=>{
 const a=record('first-city',pdf,'openai-subscription'),b=record('second-city',other,'openai-subscription');
 b.municipalityId='second-town';b.verification.evidenceHash=knowledgeEvidenceHash(b);
 const firstRun=contribution([a],'codex-only'),secondRun=contribution([b],'codex-only',[other],'second-town');
 const lineage=buildTextRunLineage([firstRun,secondRun],[],at);
 for(const kind of ['fetched','attempted','selected','prepared'] as const){
  const moved=structuredClone(lineage),groups=moved.cumulative.groupBindings[kind]!;
  groups.find(group=>group.municipalityId==='second-town')!.municipalityId='town';
  groups.sort((left,right)=>left.sourceSha256<right.sourceSha256?-1:left.sourceSha256>right.sourceSha256?1:0);recountCumulative(moved);
  assert.throws(()=>textRunLineageSchema.parse(moved),new RegExp(`(?:town|second-town) ${kind} union bounds`));
 }
});

test('selected origins bind their own run municipality activity and provider summaries',()=>{
 const a=record('published',pdf,'openai-subscription'),productive=contribution([a],'codex-only'),empty=contribution([],'codex-only');
 const lineage=buildTextRunLineage([empty,productive],[selection(productive,a)],at);
 const retargeted=structuredClone(lineage);retargeted.selectedRecordOrigins[0].runId=empty.runId;retargeted.selectedRecordOrigins[0].outputArtifactSha256=empty.artifacts.records.sha256;
 assert.throws(()=>textRunLineageSchema.parse(retargeted),/original run attempts|own run municipality activity|native provider output counts/);
 for(const mutate of [
  (value:typeof lineage)=>{value.runs[1].providers![0].model='another-model';},
  (value:typeof lineage)=>{value.runs[1].providers![0].tool='claude-cli';},
  (value:typeof lineage)=>{value.runs[1].providers=[];},
  (value:typeof lineage)=>{value.runs[1].providers![0].publishedCandidates=0;},
 ]){
  const invalid=structuredClone(lineage);mutate(invalid);assert.throws(()=>textRunLineageSchema.parse(invalid),/provider/);
 }
 const b=record('other-city',other,'openai-subscription');b.municipalityId='second-town';b.verification.evidenceHash=knowledgeEvidenceHash(b);
 const otherRun=contribution([b],'codex-only',[other],'second-town'),otherLineage=buildTextRunLineage([productive,otherRun],[selection(productive,a)],at);
 otherLineage.selectedRecordOrigins[0].runId=otherRun.runId;otherLineage.selectedRecordOrigins[0].outputArtifactSha256=otherRun.artifacts.records.sha256;
 assert.throws(()=>textRunLineageSchema.parse(otherLineage),/own run municipality activity/);
 const originallyUnpublished=changedArtifact(productive,'extractionRun',value=>{value.providers[0].publishedCandidates=0;});
 const retained=retainedContribution(originallyUnpublished,[a]);
 assert.doesNotThrow(()=>buildTextRunLineage([retained],[selection(retained,a)],at));
});

test('authenticated envelope metadata preserves private v3 identity roots without reparsing or publication',()=>{
 const original=record('root-metadata',pdf,'openai-subscription'),v2=contribution([original],'codex-only');
 assert.deepEqual(authenticateTextRunContribution(v2).envelopeMetadata,{schemaVersion:'stadtstack-knowledge-v2',generatedAt:at,identityAssertions:null,identityAdmissions:null});
 const marked=structuredClone(original);Object.assign(marked,{kind:'text_model'});Object.assign(marked.verification,{kind:'text_model'});marked.verification.evidenceHash=knowledgeEvidenceHash(marked);
 const v3=contribution([marked],'codex-only'),identityAssertions=[{syntheticAssertion:'kept verbatim'}],identityAdmissions=[{syntheticAdmission:'kept private'}];
 v3.artifacts.records=artifact({schemaVersion:'stadtstack-knowledge-v3',generatedAt:at,records:[marked],identityAssertions,identityAdmissions});
 const authenticated=authenticateTextRunContribution(v3);
 assert.deepEqual(authenticated.envelopeMetadata,{schemaVersion:'stadtstack-knowledge-v3',generatedAt:at,identityAssertions,identityAdmissions});
 assert.throws(()=>authenticated.envelopeMetadata.identityAssertions!.push({}),TypeError);
 const admission=authenticated.envelopeMetadata.identityAdmissions![0];assert.ok(admission!==null&&typeof admission==='object');
 assert.throws(()=>Object.assign(admission,{syntheticAdmission:'changed'}),TypeError);
 const lineage=buildAuthenticatedTextRunLineage([authenticated],[selection(v3,marked)],at);
 assert.equal(JSON.stringify(lineage).includes('identityAssertions'),false);
 assert.equal(JSON.stringify(lineage).includes('syntheticAdmission'),false);
 assert.equal(JSON.stringify(lineage).includes('envelopeMetadata'),false);
});
