import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadDistrictRegistry} from '../src/district-registry.ts';
import {buildDistrictCoverage,validateDistrictCoverage,assertKnowledgeSlice,knowledgePublicationHold,quarantineReasonHistogram,projectDistrictCoverage,type KnowledgeSliceEvidence,type DistrictCoverageRecord} from '../src/district-publication.ts';
import {PROVIDER_CONFIGS,type ExtractorProvider} from '../src/district-model-contract.ts';
import {DistrictKnowledgeRecordSchema,REQUIRED_DETERMINISTIC_CHECKS,knowledgeEvidenceHash,sha256,type DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {textRunLineageSchema,type TextRunLineage,type TextSourceGroup} from '../src/text-run-lineage.ts';
import {GRAPH_DETERMINISTIC_CHECKS} from '../src/district-graph-claims.ts';
import {dataReleaseId} from '../src/data-release.ts';
import {composeDistrictRelease} from '../src/district-release-composition.ts';
import {authenticateRetainedKnowledgePublication,type RetainedKnowledgePublicationInput} from '../src/retained-knowledge-lineage.ts';

// Synthetic observations exercise counting only; these are not municipal facts.
const registry=await loadDistrictRegistry(fileURLToPath(new URL('../sources/district-registry.json',import.meta.url)));
const city=registry.municipalities[0],at='2026-10-10T12:00:00.000Z';
const first='1'.repeat(64),newer='2'.repeat(64),withdrawn='3'.repeat(64);
const crawl={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:at,documents:[
 {id:'one',municipalityId:city.id,sourceId:city.sources[0].id,sha256:first},
 {id:'copy',municipalityId:city.id,sourceId:city.sources[1].id,sha256:first},
 {id:'new',municipalityId:city.id,sourceId:city.sources[0].id,sha256:newer}
],checks:[]};
const quarantine={schemaVersion:'stadtstack-quarantine-v1',cases:[first,withdrawn].map(sourceSha256=>({municipalityId:city.id,sourceId:city.sources[0].id,sourceSha256,reason:'Synthetic unsupported case'}))};
const run={schemaVersion:'stadtstack-extraction-run-v2',generatedAt:at,assignmentMode:'balanced',corpusSha256:'4'.repeat(64),registrySha256:'5'.repeat(64),promptContractSha256:'6'.repeat(64),schemaSha256:'7'.repeat(64),scope:'all_fetched_documents',maxDocumentsPerMunicipality:null,availableDocumentGroups:2,attemptedDocumentGroups:2,pendingDocumentGroups:0};
type SyntheticRun=Omit<typeof run,'maxDocumentsPerMunicipality'>&{maxDocumentsPerMunicipality:number|null;municipalities?:{id:string;selectedDocumentGroups:number;preparedDocumentGroups?:number;attemptedDocumentGroups:number}[]};
type SyntheticGroups={fetched?:TextSourceGroup[];selected?:TextSourceGroup[]|null;prepared?:TextSourceGroup[]|null};
const groupIdentity=(group:TextSourceGroup)=>JSON.stringify([group.municipalityId,group.sourceSha256]);
const uniqueGroups=(groups:TextSourceGroup[])=>[...new Map(groups.map(group=>[groupIdentity(group),group])).values()].sort((a,b)=>a.municipalityId<b.municipalityId?-1:a.municipalityId>b.municipalityId?1:a.sourceSha256<b.sourceSha256?-1:a.sourceSha256>b.sourceSha256?1:0);
// Public-projection fixtures only. Artifact authentication has its own byte-bound tests.
function syntheticLineage(input:SyntheticRun,records:DistrictCoverageRecord[],cases:readonly {municipalityId:string;sourceSha256:string}[],options:SyntheticGroups={}):TextRunLineage{
 const attempted=uniqueGroups([...records.map(record=>({municipalityId:record.municipalityId,sourceSha256:record.extraction.inputSha256})),...cases.map(({municipalityId,sourceSha256})=>({municipalityId,sourceSha256}))]);
 const bindings={fetched:uniqueGroups(options.fetched??attempted),attempted,selected:options.selected===undefined||options.selected===null?null:uniqueGroups(options.selected),prepared:options.prepared===undefined||options.prepared===null?null:uniqueGroups(options.prepared)};
 const counts=(groups:typeof bindings)=>{
  const fetched=new Set(groups.fetched.map(groupIdentity)),present=groups.attempted.filter(group=>fetched.has(groupIdentity(group))).length;
  return {fetchedDocumentGroups:fetched.size,selectedDocumentGroups:groups.selected===null?{state:'unknown' as const,count:null}:{state:'exact' as const,count:groups.selected.length},preparedDocumentGroups:groups.prepared===null?{state:'unknown' as const,count:null}:{state:'exact' as const,count:groups.prepared.length},attemptedDocumentGroups:groups.attempted.length,pendingFetchedDocumentGroups:fetched.size-present,unavailableAttemptedDocumentGroups:groups.attempted.length-present};
 };
 const runId=sha256(JSON.stringify(input)),recordsSha256=sha256(JSON.stringify(records)),groups=counts(bindings);
 const pins={corpusSha256:input.corpusSha256,registrySha256:input.registrySha256,promptContractSha256:input.promptContractSha256,schemaSha256:input.schemaSha256};
 const artifactPins={extractionRun:runId,records:recordsSha256,quarantine:sha256(JSON.stringify(cases)),crawl:input.corpusSha256,registry:input.registrySha256,preparationPlan:bindings.selected===null?null:sha256('synthetic preparation metadata')};
 const origins=records.map((record,outputRecordIndex)=>{
  const {provider,model,tool,toolVersion,modelIdentitySha256,modelIdentityBasis}=record.extraction;
  return {runId,sourceArtifactKind:'native_extraction_output' as const,schemaProjection:null,recordId:record.id,outputRecordIndex,outputArtifactSha256:recordsSha256,originalRecordSha256:sha256(JSON.stringify(record)),originalEvidenceHash:record.verification.evidenceHash,projectedEvidenceHash:record.verification.evidenceHash,currentEvidenceHash:record.verification.evidenceHash,municipalityId:record.municipalityId,sourceSha256:record.extraction.inputSha256,model:{provider,model,tool,toolVersion,modelIdentitySha256,modelIdentityBasis},extractionResponseSha256:record.extraction.responseSha256,judgeResponseSha256:record.verification.faithfulness.responseSha256,promptSha256:record.extraction.promptSha256,judgePromptSha256:record.extraction.judgePromptSha256};
 });
 const municipalityIds=[...new Set([...registry.municipalities.map(city=>city.id),...bindings.fetched.map(group=>group.municipalityId),...attempted.map(group=>group.municipalityId)])].sort();
 return textRunLineageSchema.parse({schemaVersion:'stadtstack-text-run-lineage-v1',generatedAt:at,runs:[{runId,sourceArtifactKind:'native_extraction_output',recordsSchemaVersion:'stadtstack-knowledge-v2',retainedPublication:null,generatedAt:input.generatedAt,assignmentMode:input.assignmentMode,pins,artifacts:artifactPins,artifactClocks:{extractionRun:input.generatedAt,records:at,quarantine:at,crawl:at,registry:at,preparationPlan:artifactPins.preparationPlan===null?null:at},scope:input.scope,maxDocumentsPerMunicipality:input.maxDocumentsPerMunicipality,availableDocumentGroups:input.availableDocumentGroups,attemptedDocumentGroups:input.attemptedDocumentGroups,pendingDocumentGroups:input.pendingDocumentGroups,municipalities:input.municipalities??null,providers:null,groups}],selectedRecordOrigins:origins,cumulative:{attemptsAcrossRuns:input.attemptedDocumentGroups,groups,groupBindings:bindings,municipalities:municipalityIds.map(id=>({id,...counts({fetched:bindings.fetched.filter(group=>group.municipalityId===id),attempted:attempted.filter(group=>group.municipalityId===id),selected:bindings.selected?.filter(group=>group.municipalityId===id)??null,prepared:bindings.prepared?.filter(group=>group.municipalityId===id)??null})})),frontierUnion:'unknown'}});
}
function coverageFor(registryInput:typeof registry,crawlInput:unknown,records:DistrictCoverageRecord[],quarantineInput:{schemaVersion:string;cases:{municipalityId:string;sourceSha256:string}[]},runInput:SyntheticRun,generatedAt?:string,groups?:SyntheticGroups){
 const coverage=buildDistrictCoverage(registryInput,crawlInput,records,quarantineInput,syntheticLineage(runInput,records,quarantineInput.cases,groups),generatedAt);
 assert.ok(coverage.textLineage);
 return {...coverage,textLineage:coverage.textLineage};
}
 const projection=(provider:ExtractorProvider,inputSha256:string,chunk:number):DistrictCoverageRecord=>{
  const config=PROVIDER_CONFIGS[provider];
  const id=`synthetic:${provider}:${inputSha256}:${chunk}`,evidenceHash=sha256(id);
  return {id,municipalityId:city.id,documentDate:'2026-10-10',stageDate:null,stage:'draft',stages:[],sources:[{id:city.sources[0].id}],extraction:{provider,model:config.model,tool:config.tool,toolVersion:'1.0.0',modelIdentitySha256:provider==='openai-subscription'?'8'.repeat(64):'9'.repeat(64),modelIdentityBasis:config.modelIdentityBasis,inputSha256,responseSha256:sha256(id+':extraction'),promptSha256:run.promptContractSha256,judgePromptSha256:sha256('synthetic judge prompt')},verification:{evidenceHash,faithfulness:{responseSha256:sha256(id+':judge')}}};
 };

test('Coverage separates representations, attempted byte groups, new pending input and withdrawn input',()=>{
 const coverage=coverageFor(registry,crawl,[],quarantine,run);
 const observed=coverage.municipalities.find(item=>item.id===city.id)!;
 assert.equal(observed.documents,3);
 assert.deepEqual(observed.extraction,{fetchedDocumentGroups:2,runSelectedDocumentGroups:null,preparedDocumentGroups:null,attemptedDocumentGroups:1,pendingDocumentGroups:1,unavailableAttemptedDocumentGroups:1});
 assert.equal(coverage.textLineage.runs[0].scope,'all_fetched_documents');
 assert.equal(coverage.textLineage.runs[0].pendingDocumentGroups,0);
 assert.equal(coverage.textLineage.runs[0].pins.corpusSha256,run.corpusSha256);
 assert.equal(coverage.textLineage.runs[0].pins.promptContractSha256,run.promptContractSha256);
});

test('replay coverage clock is explicit while original extraction and source clocks remain unchanged',()=>{
 const historical='2026-10-11T09:25:12.545Z',coverage=coverageFor(registry,crawl,[],quarantine,run,historical);
 assert.equal(coverage.generatedAt,historical);assert.equal(coverage.textLineage.runs[0].generatedAt,at);
 assert.equal(crawl.generatedAt,at);assert.equal(run.generatedAt,at);
 assert.throws(()=>coverageFor(registry,crawl,[],quarantine,run,'not-a-clock'));
 const before=Date.now(),normal=coverageFor(registry,crawl,[],quarantine,run);
 assert.ok(Date.parse(normal.generatedAt)>=before&&Date.parse(normal.generatedAt)<=Date.now());
});

test('Coverage rejects invented attempted totals, missing pending input and concealed extraction caps',()=>{
 assert.throws(()=>coverageFor(registry,crawl,[],quarantine,{...run,attemptedDocumentGroups:3}),/accounting|totals|counts/);
 assert.throws(()=>coverageFor(registry,crawl,[],quarantine,{...run,scope:'bounded_per_municipality'}),/selection policy/);
 assert.throws(()=>coverageFor(registry,crawl,[],quarantine,{...run,scope:'bounded_per_municipality',maxDocumentsPerMunicipality:1,municipalities:[{id:city.id,selectedDocumentGroups:2,attemptedDocumentGroups:2}]}),/budget exceeded/);
 const coverage=coverageFor(registry,crawl,[],quarantine,run);
 coverage.municipalities[0].extraction.pendingDocumentGroups=0;
 assert.throws(()=>validateDistrictCoverage(coverage,registry,[]),/Extraction coverage mismatch/);
});

test('Public source barriers retain full counts but only three safe examples',()=>{
 const blocked=Array.from({length:500},(_,i)=>({url:i===0?'http://127.0.0.1/private':`https://example.org/blocked/${i}`,failure:'robots_blocked',checkedAt:at}));
 const observed={...crawl,checks:[{municipalityId:city.id,sourceId:city.sources[0].id,checkState:'checked',checkedAt:at,documentCount:2,coverage:{state:'blocked',pendingCount:0,runnableCount:0,blockedCount:500,action:'ask_municipality'},blocked}]};
 const coverage=coverageFor(registry,observed,[],quarantine,run);
 const source=coverage.municipalities[0].sources[0];
 assert.equal(source.failedLinkCount,500);assert.equal(source.failureExamples.length,3);
 assert.equal(source.failureExamples[0].url,null);assert.equal(source.coverage.blockedCount,500);
 assert.equal(JSON.stringify(coverage).includes('/blocked/499'),false);
});

test('District slice acceptance is separate from unchanged individual date gates',()=>{
 // Acceptance-only projections; not model receipts or releasable knowledge records.
 const records=registry.districts.map<KnowledgeSliceEvidence>(district=>({id:'test:'+district.id,districtId:district.id,municipalityId:registry.municipalities.find(city=>city.districtId===district.id)!.id,documentDate:'2026-10-10',stageDate:null,stage:'draft',stages:[]}));
 assert.doesNotThrow(()=>assertKnowledgeSlice(registry,records));
 assert.throws(()=>assertKnowledgeSlice(registry,records,3),/1\/3/);
 assert.throws(()=>assertKnowledgeSlice(registry,[{...records[0],documentDate:null},...records.slice(1)]),/Undated knowledge withheld/);
 assert.throws(()=>assertKnowledgeSlice(registry,[{...records[0],stage:'unknown'},...records.slice(1)]),/0\/1/);
});

test('Every registered town exposes checked-without-gated-records versus not-checked explicitly',()=>{
 const coverage=coverageFor(registry,crawl,[],quarantine,run);
 assert.equal(coverage.municipalities[0].status,'checked_no_gated_records');
 assert.equal(coverage.municipalities[0].datedStagedRecords,0);
 assert.equal(coverage.municipalities[1].status,'not_checked');
 coverage.municipalities[0].status='gated_records';
 assert.throws(()=>validateDistrictCoverage(coverage,registry,[]),/admission coverage mismatch/);
});

test('Coverage reports only actual per-provider admitted identities and counts',()=>{
 const records=[projection('openai-subscription',first,0),projection('openai-subscription',first,1),projection('anthropic-subscription',newer,0)];
 const coverage=coverageFor(registry,crawl,records,{schemaVersion:'stadtstack-quarantine-v1',cases:[]},run);
 assert.deepEqual(Object.fromEntries(coverage.models.map(model=>[model.provider,model.publishedRecords])),{'openai-subscription':2,'anthropic-subscription':1});
 assert.equal(coverage.accounting.publishedMunicipalities,1);
 assert.equal(coverage.accounting.checkedWithoutPublishedMunicipalities,0);
 const wrongCount=structuredClone(coverage);wrongCount.models[0].publishedRecords++;
 assert.throws(()=>validateDistrictCoverage(wrongCount,registry,records),/model provenance/);
 const missingProvider=structuredClone(coverage);missingProvider.models.pop();
 assert.throws(()=>validateDistrictCoverage(missingProvider,registry,records),/Missing admitted model/);
 const substitutedModel=structuredClone(coverage);substitutedModel.models[0].model='different-model';
 assert.throws(()=>validateDistrictCoverage(substitutedModel,registry,records),/model provenance/);
 const falseMode=structuredClone(coverage);falseMode.textLineage.runs[0].assignmentMode='codex-only';
 assert.throws(()=>validateDistrictCoverage(falseMode,registry,records),/Codex-only/);
});

test('publication withholds a malformed or nonpublic quoted URL without repairing source evidence',()=>{
 const record={documentDate:'2026-10-10',stageDate:null,stages:[],summaryQuote:'Synthetic quotation: httos://www.beispiel.de/ and https://internal/'};
 const original=structuredClone(record),hold=knowledgePublicationHold(record);
 assert.deepEqual(hold?.reasons,['nonpublic_evidence_url']);
 assert.deepEqual(hold?.urlIssues,[{path:'summaryQuote',reason:'nonpublic_scheme'},{path:'summaryQuote',reason:'nonpublic_hostname'}]);
 assert.deepEqual(record,original);
 assert.equal(knowledgePublicationHold({...record,summaryQuote:'Synthetic quotation: https://www.beispiel.de/'}),null);
});

test('publication retains independent date and URL holds without admitting or counting a record twice',()=>{
 const record={documentDate:null,stageDate:null,stages:[],summaryQuote:'Synthetic quotation: file:///synthetic/source'};
 assert.deepEqual(knowledgePublicationHold(record)?.reasons,['missing_sourced_date','nonpublic_evidence_url']);
 assert.deepEqual(knowledgePublicationHold({...record,summaryQuote:'Synthetic source text.'})?.reasons,['missing_sourced_date']);
 assert.equal(knowledgePublicationHold({...record,stageDate:'2026-10-10',summaryQuote:'Synthetic source text.'}),null);
});

test('quarantine histograms count mixed gates per source-bound entry without copying private evidence',()=>{
 const candidate={municipalityId:city.id,extraction:{inputSha256:first},sources:[{id:city.sources[0].id,sha256:first}],
  documentDate:'1998-04-03',summaryQuote:'private candidate https://internal/private-evidence',
  verification:{deterministic:{passed:false,checks:[{id:'exact_quotes',passed:false,reason:'private explanation'},{id:'exact_quotes',passed:false},{id:'graph_relations',passed:false},{id:'no_contacts',passed:true}]},faithfulness:{score:null,threshold:0.8,responseSha256:null,reason:'private judgment'}}};
 const base={municipalityId:city.id,sourceId:city.sources[0].id,sourceSha256:first};
 const cases=[
  {...base,reason:'private raw model text',candidate},
  {...base,reason:'No supported case in source excerpt'},
  {...base,sourceId:city.sources[1].id,reason:'Structured output/schema validation failed'},
  {...base,sourceSha256:withdrawn,reason:'unknown https://internal/held-at-1998-04-03',documentDate:'1998-04-03'},
  {...base,reason:'Faithfulness gate not passed',candidate:{...candidate,verification:{deterministic:{passed:true,checks:[{id:'exact_quotes',passed:true}]},faithfulness:{score:0.4,threshold:0.8,responseSha256:first}}}},
  {...base,reason:'Publication withheld: missing_sourced_date, nonpublic_evidence_url',publicationReasons:['missing_sourced_date','nonpublic_evidence_url']},
 ];
 const original=structuredClone(cases),coverage=coverageFor(registry,crawl,[],{...quarantine,cases},run),observed=coverage.municipalities[0];
 assert.equal(observed.quarantinedRecords,6);
 assert.deepEqual(Object.fromEntries(observed.quarantineReasons.categories.map(row=>[row.reason,row.count])),{deterministic_gate_failed:1,faithfulness_gate_failed:1,invalid_structured_output:1,missing_sourced_date:1,no_supported_case:1,nonpublic_evidence_url:1,unknown:1});
 assert.deepEqual(observed.quarantineReasons.failedDeterministicChecks,[{id:'exact_quotes',count:1},{id:'graph_relations',count:1}]);
 assert.equal(observed.sources[0].quarantinedRecords,5);
 assert.deepEqual(observed.sources[1].quarantineReasons,{categories:[{reason:'invalid_structured_output',count:1}],failedDeterministicChecks:[]});
 assert.deepEqual(cases,original);
 const publicProjection=JSON.stringify(projectDistrictCoverage(coverage));
 for(const privateValue of ['1998-04-03','https://internal','private raw','private explanation','private judgment',first,withdrawn])assert.equal(publicProjection.includes(privateValue),false);
});

test('unknown reasons and unknown check identifiers stay bounded without echoing content',()=>{
 const base={municipalityId:city.id,sourceId:city.sources[0].id,sourceSha256:first};
 const histogram=quarantineReasonHistogram([
  {...base,reason:'__proto__'},
  {...base,reason:'exact_quotes, graph_modality'},
  {...base,reason:'secret https://internal/unknown',candidate:{municipalityId:city.id,extraction:{inputSha256:first},sources:[{id:city.sources[0].id,sha256:first}],verification:{deterministic:{passed:false,checks:[{id:'secret https://internal/check',passed:false}]},faithfulness:{score:null,threshold:0.8,responseSha256:null}}}},
 ]);
 assert.deepEqual(histogram,{categories:[{reason:'deterministic_gate_failed',count:2},{reason:'unknown',count:2}],failedDeterministicChecks:[{id:'exact_quotes',count:1},{id:'graph_modality',count:1}]});
 assert.equal(JSON.stringify(histogram).includes('secret'),false);
 assert.deepEqual(quarantineReasonHistogram([]),{categories:[],failedDeterministicChecks:[]});
});

test('quarantine cannot move evidence between municipalities, sources or byte groups',()=>{
 const base={municipalityId:city.id,sourceId:city.sources[0].id,sourceSha256:first,reason:'No supported case in source excerpt'};
 for(const item of [{...base,municipalityId:'unregistered'},{...base,sourceId:'unregistered'}])assert.throws(()=>coverageFor(registry,crawl,[],{...quarantine,cases:[item]},{...run,availableDocumentGroups:1,attemptedDocumentGroups:1}),/municipality\/source binding mismatch|outside the publication registry/);
 const candidate={municipalityId:city.id,extraction:{inputSha256:first},sources:[{id:city.sources[0].id,sha256:first}],verification:{deterministic:{passed:false,checks:[{id:'exact_quotes',passed:false}]},faithfulness:{score:null,threshold:0.8,responseSha256:null}}};
 for(const changed of [{...candidate,municipalityId:registry.municipalities[1].id},{...candidate,extraction:{inputSha256:withdrawn}},{...candidate,sources:[{id:city.sources[1].id,sha256:first}]}])assert.throws(()=>quarantineReasonHistogram([{...base,candidate:changed}]),/candidate source binding mismatch/);
});

test('registry inventory, checked towns, run selection, preparation, attempts and publication are distinct',()=>{
 const checkedOnly=registry.municipalities[1],selectedOnly=registry.municipalities[2];
 const observedCrawl={...crawl,documents:[...crawl.documents,{id:'selected-only',municipalityId:selectedOnly.id,sourceId:selectedOnly.sources[0].id,sha256:newer}],checks:[{municipalityId:checkedOnly.id,sourceId:checkedOnly.sources[0].id,checkState:'not_found',checkedAt:at,documentCount:0}]};
 const observedRun={...run,availableDocumentGroups:3,pendingDocumentGroups:1,municipalities:registry.municipalities.map(item=>({id:item.id,selectedDocumentGroups:item.id===city.id?2:item.id===selectedOnly.id?1:0,preparedDocumentGroups:item.id===city.id||item.id===selectedOnly.id?1:0,attemptedDocumentGroups:item.id===city.id?2:0}))};
 const selected=[{municipalityId:city.id,sourceSha256:first},{municipalityId:city.id,sourceSha256:withdrawn},{municipalityId:selectedOnly.id,sourceSha256:newer}];
 const groups={fetched:selected,selected,prepared:[selected[0],selected[2]]};
 const coverage=coverageFor(registry,observedCrawl,[],quarantine,observedRun,undefined,groups);
 assert.equal(registry.inventory.length,319);
 assert.deepEqual(coverage.accounting,{registryMunicipalities:319,configuredMunicipalities:registry.municipalities.length,checkedMunicipalities:3,runSelectedMunicipalities:2,preparedMunicipalities:2,attemptedMunicipalities:1,publishedMunicipalities:0,checkedWithoutPublishedMunicipalities:3,unvisitedMunicipalities:316});
 const checked=coverage.municipalities.find(item=>item.id===checkedOnly.id)!;
 assert.equal(checked.status,'checked_no_gated_records');
 assert.equal(checked.extraction.attemptedDocumentGroups,0);
 assert.equal(checked.extraction.runSelectedDocumentGroups,0);
 assert.equal(coverage.municipalities[3].status,'not_checked');
 assert.equal(coverage.districts.reduce((n,district)=>n+district.municipalitiesAttempted,0),1);
 assert.equal(coverage.districts.reduce((n,district)=>n+district.municipalitiesChecked,0),3);
 const withoutPreparation={...observedRun,municipalities:observedRun.municipalities.map(({preparedDocumentGroups:_,...item})=>item)};
 assert.equal(coverageFor(registry,observedCrawl,[],quarantine,withoutPreparation,undefined,{...groups,prepared:null}).accounting.preparedMunicipalities,null);
 const withoutSelection=coverageFor(registry,crawl,[],quarantine,run);
 assert.equal(withoutSelection.accounting.runSelectedMunicipalities,null);
 assert.equal(withoutSelection.accounting.preparedMunicipalities,null);
});

test('coverage rejects invented pipeline accounting and reason counts',()=>{
 const coverage=coverageFor(registry,crawl,[],quarantine,run);
 const accounting=structuredClone(coverage);accounting.accounting.attemptedMunicipalities++;
 assert.throws(()=>validateDistrictCoverage(accounting,registry,[]),/accounting mismatch/);
 const histogram=structuredClone(coverage);histogram.municipalities[0].quarantineReasons.categories[0].count++;
 assert.throws(()=>validateDistrictCoverage(histogram,registry,[]),/histogram count mismatch/);
 const source=structuredClone(coverage);source.municipalities[0].sources[0].quarantinedRecords--;
 assert.throws(()=>validateDistrictCoverage(source,registry,[]),/histogram count mismatch|source totals mismatch/);
 const attempted=structuredClone(coverage);attempted.districts[0].municipalitiesAttempted++;
 assert.throws(()=>validateDistrictCoverage(attempted,registry,[]),/attempt\/quarantine totals mismatch/);
 const wrongRun={...run,municipalities:registry.municipalities.map(item=>({id:item.id,selectedDocumentGroups:2,attemptedDocumentGroups:0}))};
 assert.throws(()=>coverageFor(registry,crawl,[],quarantine,wrongRun),/group totals mismatch|counts/);
});

test('identical source bytes in different towns do not share quarantine counts or attempt identities',()=>{
 const other=registry.municipalities[1];
 const documents=[crawl.documents[0],{id:'other-town',municipalityId:other.id,sourceId:other.sources[0].id,sha256:first}];
 const cases=[
  {municipalityId:city.id,sourceId:city.sources[0].id,sourceSha256:first,reason:'No supported case in source excerpt'},
  {municipalityId:other.id,sourceId:other.sources[0].id,sourceSha256:first,reason:'Structured output/schema validation failed'},
 ];
 const coverage=coverageFor(registry,{...crawl,documents},[],{...quarantine,cases},run);
 assert.equal(coverage.accounting.attemptedMunicipalities,2);
 assert.equal(coverage.municipalities[0].quarantinedRecords,1);
 assert.equal(coverage.municipalities[1].quarantinedRecords,1);
 assert.deepEqual(coverage.municipalities[0].quarantineReasons.categories,[{reason:'no_supported_case',count:1}]);
 assert.deepEqual(coverage.municipalities[1].quarantineReasons.categories,[{reason:'invalid_structured_output',count:1}]);
 assert.equal(coverage.municipalities[0].sources[1].quarantinedRecords,0);
});

test('v4 district accounting exposes full inventory independently of configured and attempted towns',()=>{
 const coverage=coverageFor(registry,crawl,[],quarantine,run);
 assert.equal(coverage.schemaVersion,'stadtstack-district-coverage-v4');
 for(const district of coverage.districts){
  assert.equal(district.municipalitiesRegistered,registry.inventory.filter(item=>item.districtId===district.id).length);
  assert.equal(district.municipalitiesConfigured,registry.municipalities.filter(item=>item.districtId===district.id).length);
  assert.ok(district.municipalitiesRegistered>district.municipalitiesConfigured);
  assert.equal(district.municipalitiesAttempted,district.id===city.districtId?1:0);
 }
 assert.equal(coverage.districts.reduce((n,district)=>n+district.municipalitiesRegistered,0),319);
 assert.deepEqual(projectDistrictCoverage(coverage).districts,coverage.districts);
 const wrongInventory=structuredClone(coverage);wrongInventory.districts[0].municipalitiesRegistered--;
 assert.throws(()=>validateDistrictCoverage(wrongInventory,registry,[]),/District coverage totals mismatch/);
 const wrongConfigured=structuredClone(coverage);wrongConfigured.districts[0].municipalitiesConfigured++;
 assert.throws(()=>validateDistrictCoverage(wrongConfigured,registry,[]),/District coverage totals mismatch/);
});

test('coverage retains balanced history beside Codex-only corrections without counting a repeated PDF twice',()=>{
 const historicalRecord=projection('anthropic-subscription',first,0),correctionRecord=projection('openai-subscription',newer,0);
 const historical=syntheticLineage({...run,availableDocumentGroups:1,attemptedDocumentGroups:1},[historicalRecord],[]);
 const repeatedAttempt={municipalityId:city.id,sourceId:city.sources[0].id,sourceSha256:first,reason:'No supported case in source excerpt'};
 const correction=syntheticLineage({...run,generatedAt:'2026-10-11T12:00:00.000Z',assignmentMode:'codex-only',corpusSha256:sha256('synthetic correction corpus')},[correctionRecord],[repeatedAttempt]);
 const lineage=textRunLineageSchema.parse({...correction,runs:[...historical.runs,...correction.runs],selectedRecordOrigins:[...historical.selectedRecordOrigins,...correction.selectedRecordOrigins],cumulative:{...correction.cumulative,attemptsAcrossRuns:3}});
 const records=[historicalRecord,correctionRecord],coverage=buildDistrictCoverage(registry,crawl,records,{schemaVersion:'stadtstack-quarantine-v1',cases:[repeatedAttempt]},lineage);
 assert.deepEqual(coverage.textLineage!.runs.map(item=>item.assignmentMode),['balanced','codex-only']);
 assert.equal(coverage.textLineage!.cumulative.attemptsAcrossRuns,3);
 assert.equal(coverage.municipalities[0].extraction.attemptedDocumentGroups,2);
 assert.equal(coverage.municipalities[0].extraction.pendingDocumentGroups,0);
 assert.equal(coverage.textLineage!.selectedRecordOrigins.find(origin=>origin.recordId===historicalRecord.id)?.runId,historical.runs[0].runId);
 assert.deepEqual(Object.fromEntries(coverage.models.map(model=>[model.provider,model.publishedRecords])),{'openai-subscription':1,'anthropic-subscription':1});
 const relabelled=structuredClone(coverage);relabelled.textLineage!.runs[0].assignmentMode='codex-only';
 assert.throws(()=>validateDistrictCoverage(relabelled,registry,records),/Codex-only/);
 const inventedOrigin=structuredClone(coverage);inventedOrigin.textLineage!.selectedRecordOrigins[0].recordId='synthetic:unrelated-record';
 assert.throws(()=>validateDistrictCoverage(inventedOrigin,registry,records),/lineage record\/generation binding/);
});

test('targeted completion preserves broader pending coverage and every original scoped observation',()=>{
 const sourceId=city.sources[0].id,later='2026-10-11T12:00:00.000Z';
 const broader={municipalityId:city.id,sourceId,checkState:'checked',checkedAt:at,documentCount:2,coverage:{state:'partial',pendingCount:7,runnableCount:5,blockedCount:2,scope:'Observed source links'}};
 const target={municipalityId:city.id,sourceId,checkState:'checked',checkedAt:later,documentCount:1,coverage:{state:'partial',pendingCount:0,runnableCount:0,blockedCount:0,scope:'Exactly selected registered page roots',sourceCoverage:'not_assessed',targetScope:{kind:'page_roots',urls:['https://example.org/selected'],state:'complete',pendingCount:0,runnableCount:0,blockedCount:0}}};
 const coverage=coverageFor(registry,{...crawl,checks:[broader,target]},[],quarantine,run),source=coverage.municipalities[0].sources[0];
 assert.equal(source.coverageSelection,'latest_non_targeted_observation');
 assert.equal(source.checkedAt,at);assert.equal(source.coverage.pendingCount,7);
 assert.equal(source.observations.length,2);assert.equal(source.observations[1].checkedAt,later);
 assert.equal(source.observations[1].coverage.state,'partial');
 assert.equal(source.observations[1].coverage.sourceCoverage,'not_assessed');
 assert.equal(source.observations[1].coverage.targetScope?.state,'complete');
 const falselyComplete=structuredClone(coverage);falselyComplete.municipalities[0].sources[0].observations[1].coverage.state='complete';
 assert.throws(()=>validateDistrictCoverage(falselyComplete,registry,[]),/source-wide completeness/);
 const targetOnly=coverageFor(registry,{...crawl,checks:[target]},[],quarantine,run).municipalities[0].sources[0];
 assert.equal(targetOnly.coverageSelection,'latest_targeted_observation');
 assert.equal(targetOnly.coverage.state,'partial');assert.equal(targetOnly.coverage.sourceCoverage,'not_assessed');
 assert.equal(targetOnly.coverage.targetScope?.state,'complete');
});

// All baseline bytes and receipts below are synthetic sealed-publication fixtures.
// No source acquisition, model call or new verification receipt is performed.
const oldModelClock='2026-10-01T10:00:00.000Z',oldPublicationClock='2026-10-09T11:00:00.000Z';
function retainedRecord(id:string,provider:ExtractorProvider='openai-subscription'):DistrictKnowledgeRecord{
 const config=PROVIDER_CONFIGS[provider],modelIdentitySha256=sha256(`synthetic retained identity ${provider}`),source=city.sources[0];
 const record:DistrictKnowledgeRecord={
  id,municipalityId:city.id,ags:city.ags,districtId:city.districtId,title:'Synthetic retained title',titleQuote:'Synthetic retained title',summary:'Synthetic retained summary',summaryQuote:'Synthetic retained summary',municipalityQuote:'Synthetic town',
  caseKeyType:'source_document',caseKey:`source_document:${first}`,caseQuote:null,caseType:'unknown',documentDate:'2026-10-01',documentDateQuote:'2026-10-01',documentDateReason:null,
  stage:'draft',stageDate:null,stageDateQuote:null,stageDateReason:'Synthetic event date unavailable',originalStatus:'Entwurf',stageQuote:'Entwurf',stages:[],topics:[],locations:[],entities:[],relations:[],
  sources:[{id:source.id,url:source.url!,sha256:first,retrievedAt:oldModelClock,locator:'chars:0-500',mimeType:'text/plain',sourceType:source.kind,policy:{robots:{state:'allowed',url:new URL('/robots.txt',source.url!).href},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}}],
  extraction:{extractorVersion:'synthetic-extractor',extractorSha256:sha256('synthetic-extractor'),provider,model:config.model,tool:config.tool,toolVersion:'historical-synthetic-tool',modelIdentitySha256,modelIdentityBasis:config.modelIdentityBasis,returnedModel:provider==='anthropic-subscription'?config.model:null,runtimeWarnings:[],promptVersion:'synthetic-prompt',promptSha256:run.promptContractSha256,judgePromptVersion:'synthetic-judge',judgePromptSha256:sha256('synthetic judge prompt'),inputSha256:first,textSha256:sha256('synthetic-text'),responseSha256:sha256(`${id}:extraction`),ocrUsed:false,textMethod:'text',cacheKey:sha256(`${id}:cache`),extractedAt:oldModelClock,chunk:{index:0,count:1,start:0,end:500}},
  verification:{status:'auto-verified',deterministic:{passed:true,checks:[...REQUIRED_DETERMINISTIC_CHECKS,...GRAPH_DETERMINISTIC_CHECKS].map(id=>({id,passed:true,reason:'Synthetic original gate'}))},faithfulness:{score:0.9,threshold:0.8,provider,model:config.model,tool:config.tool,toolVersion:'historical-synthetic-tool',modelIdentitySha256,returnedModel:provider==='anthropic-subscription'?config.model:null,reason:'Synthetic original judgment',evaluatedAt:oldModelClock,responseSha256:sha256(`${id}:judge`),sameModel:true,limitation:'Same-model judgment is not independent verification.'},evidenceHash:''},
 };
 record.verification.evidenceHash=knowledgeEvidenceHash(record);return DistrictKnowledgeRecordSchema.parse(record);
}
function sealedRetained(records:DistrictKnowledgeRecord[],coverage:unknown,recordIds=records.map(record=>record.id)):RetainedKnowledgePublicationInput{
 const artifact=(value:unknown)=>{const bytes=JSON.stringify(value);return {bytes,sha256:sha256(bytes)};};
 const members={records:artifact({schemaVersion:'stadtstack-knowledge-v2',generatedAt:oldPublicationClock,records}),coverage:artifact(coverage),registry:artifact(registry)};
 const files=(['records','coverage','registry'] as const).map(kind=>({path:`knowledge/${kind}.json`,sha256:members[kind].sha256,bytes:Buffer.byteLength(members[kind].bytes)}));
 return {recordIds,artifacts:{...members,manifest:artifact({schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt:oldPublicationClock,files,quality:{publishedRecords:records.length,quarantinedRecords:0,cities:1}})}};
}
function oldBaseline(recordCount=228){
 const records=Array.from({length:recordCount},(_,i)=>retainedRecord(`synthetic-retained-${i}`,i<Math.min(160,recordCount)?'anthropic-subscription':'openai-subscription'));
 const observed={...crawl,documents:[crawl.documents[0]],checks:[{municipalityId:city.id,sourceId:city.sources[0].id,checkState:'checked',checkedAt:oldModelClock,documentCount:5193,coverage:{state:'partial',pendingCount:7,runnableCount:5,blockedCount:2}}]};
 const current=coverageFor(registry,observed,records,{schemaVersion:'stadtstack-quarantine-v1',cases:[]},{...run,availableDocumentGroups:1,attemptedDocumentGroups:1},oldPublicationClock);
 const {textLineage:_lineage,retainedPublication:_retained,historicalCoverage:_history,coverageScope:_scope,...legacy}=current;
 const covered=legacy.municipalities[0],district=legacy.districts.find(district=>district.id===city.districtId)!;
 covered.documents=5193;covered.extraction={fetchedDocumentGroups:4119,runSelectedDocumentGroups:null,preparedDocumentGroups:null,attemptedDocumentGroups:417,pendingDocumentGroups:3702,unavailableAttemptedDocumentGroups:0};
 covered.sources[0].documentCount=5193;district.documents=5193;
 const coverage={...legacy,schemaVersion:'stadtstack-district-coverage-v3',municipalities:legacy.municipalities.map(city=>({...city,sources:city.sources.map(({observations:_observations,coverageSelection:_selection,...source})=>source)})),extractionRun:{generatedAt:oldModelClock,assignmentMode:'balanced',corpusSha256:run.corpusSha256,registrySha256:run.registrySha256,promptContractSha256:run.promptContractSha256,schemaSha256:run.schemaSha256,selection:'bounded_per_municipality',maxDocumentsPerMunicipality:417,availableDocumentGroupsAtRunStart:4119,attemptedDocumentGroups:417,pendingDocumentGroupsAtRunStart:3702}};
 return {records,input:sealedRetained(records,coverage),coverage};
}
function retainedComposition(input:RetainedKnowledgePublicationInput){
 return composeDistrictRelease({retainedPublication:input,contributions:[],approvedRunOrder:[],admissions:[],generatedAt:at});
}

test('sealed 228-like baseline plus one fresh overlapping PDF preserves separate cohorts and all admitted records',()=>{
 const baseline=oldBaseline(),retained=retainedComposition(baseline.input),fresh=retainedRecord('synthetic-new-codex');
 fresh.extraction.extractedAt=at;fresh.verification.faithfulness.evaluatedAt=at;fresh.verification.evidenceHash=knowledgeEvidenceHash(fresh);
 const records=[...retained.records.records,fresh],native=syntheticLineage({...run,assignmentMode:'codex-only',availableDocumentGroups:1,attemptedDocumentGroups:1},[fresh],[]);
 const targeted={municipalityId:city.id,sourceId:city.sources[0].id,checkState:'checked',checkedAt:at,documentCount:1,coverage:{state:'partial',pendingCount:0,runnableCount:0,blockedCount:0,sourceCoverage:'not_assessed',targetScope:{kind:'seed_documents',urls:[fresh.sources[0].url],state:'complete',pendingCount:0,runnableCount:0,blockedCount:0}}};
 const coverage=buildDistrictCoverage(registry,{...crawl,documents:[crawl.documents[0]],checks:[targeted]},records,{schemaVersion:'stadtstack-quarantine-v1',cases:[]},native,at,retained.retainedPublication);
 assert.equal(coverage.municipalities[0].publishedRecords,229);assert.equal(coverage.municipalities[0].datedStagedRecords,229);
 assert.equal(coverage.districts.find(district=>district.id===city.districtId)!.publishedRecords,229);
 assert.equal(coverage.models.reduce((n,model)=>n+model.publishedRecords,0),229);
 assert.equal(coverage.textLineage!.cumulative.groups.attemptedDocumentGroups,1);
 assert.equal(coverage.municipalities[0].extraction.attemptedDocumentGroups,1);
 assert.equal(coverage.coverageScope.crossCohortUniqueDocumentGroups,'unknown');
 const historical=coverage.historicalCoverage!.publication;
 assert.equal(historical.municipalities[0].publishedRecords,228);
 assert.equal(historical.municipalities[0].extraction.fetchedDocumentGroups,4119);
 assert.equal(historical.extractionRun!.attemptedDocumentGroups,417);
 assert.equal(historical.extractionRun!.generatedAt,oldModelClock);
 assert.equal(historical.municipalities[0].sources[0].checkedAt,oldModelClock);
 assert.equal(historical.municipalities[0].sources[0].coverage.pendingCount,7);
 assert.equal(coverage.municipalities[0].sources[0].coverage.sourceCoverage,'not_assessed');
 assert.equal(coverage.municipalities[0].sources[0].coverage.state,'partial');
 assert.equal(coverage.retainedPublication!.selectedRecordOrigins[0].extractedAt,oldModelClock);
 assert.equal(coverage.retainedPublication!.selectedRecordOrigins[0].evaluatedAt,oldModelClock);
 assert.equal(coverage.textLineage!.runs[0].generatedAt,at);
 assert.equal(records.at(-1)!.extraction.extractedAt,at);
 assert.equal(JSON.stringify(coverage.historicalCoverage).includes('groupBindings'),false);
});

test('retained-only selection and subsequent sealed v4 republish require no native receipts or new checks',()=>{
 const baseline=oldBaseline(2);baseline.input.recordIds=[baseline.records[1].id];
 const first=retainedComposition(baseline.input),coverage=buildDistrictCoverage(registry,first.crawl,first.records.records,first.quarantine,first.lineage,at,first.retainedPublication);
 assert.equal(coverage.textLineage,null);assert.equal(coverage.coverageScope.crossCohortUniqueDocumentGroups,'unknown');
 assert.equal(coverage.municipalities[0].status,'gated_records');assert.equal(coverage.municipalities[0].checked,false);
 assert.equal(coverage.municipalities[0].publishedRecords,1);assert.equal(coverage.municipalities[0].datedStagedRecords,1);
 assert.equal(coverage.municipalities[0].sources[0].checkedAt,null);assert.deepEqual(coverage.municipalities[0].sources[0].observations,[]);
 assert.equal(coverage.municipalities[0].extraction.attemptedDocumentGroups,0);
 const sealed=sealedRetained(first.records.records,coverage),second=retainedComposition(sealed);
 const again=buildDistrictCoverage(registry,second.crawl,second.records.records,second.quarantine,second.lineage,at,second.retainedPublication);
 assert.equal(again.textLineage,null);assert.deepEqual(second.records.records,first.records.records);
 assert.equal(again.historicalCoverage!.publication.coverageSchemaVersion,'stadtstack-district-coverage-v4');
 assert.equal(again.historicalCoverage!.priorPublications[0].coverageSchemaVersion,'stadtstack-district-coverage-v3');
 assert.equal(again.historicalCoverage!.priorPublications[0].municipalities[0].publishedRecords,2);
 assert.equal(again.historicalCoverage!.priorPublications[0].extractionRun!.generatedAt,oldModelClock);
 assert.throws(()=>buildDistrictCoverage(registry,crawl,second.records.records,second.quarantine,null,at,second.retainedPublication),/cannot invent native observations/);
});

test('retained coverage rejects counts, source host, member proofs, origins and split provenance tampering',()=>{
 const baseline=oldBaseline(2),composition=retainedComposition(baseline.input),records=composition.records.records;
 const build=(retained=composition.retainedPublication,currentRegistry=registry)=>buildDistrictCoverage(currentRegistry,composition.crawl,records,composition.quarantine,null,at,retained);
 const coverage=build(),wrongCount=structuredClone(coverage);wrongCount.historicalCoverage!.publication.municipalities[0].publishedRecords++;
 assert.throws(()=>validateDistrictCoverage(wrongCount,registry,records),/historical coverage|Historical|counts/);
 const wrongHost=structuredClone(registry);wrongHost.municipalities[0].sources[0].url='https://other.example.org/source';
 assert.throws(()=>build(composition.retainedPublication,wrongHost),/record\/source\/model binding/);
 const wrongMember=structuredClone(composition.retainedPublication)!;wrongMember.baseline.lineage.members.records.bytes++;
 assert.throws(()=>build(wrongMember),/provenance|binding/);
 const wrongOrigin=structuredClone(composition.retainedPublication)!;wrongOrigin.selectedRecordOrigins[0].sourceSha256=newer;
 assert.throws(()=>build(wrongOrigin),/origin mismatch/);
 const wrongClock=structuredClone(coverage);wrongClock.retainedPublication!.selectedRecordOrigins[0].evaluatedAt=at;
 assert.throws(()=>validateDistrictCoverage(wrongClock,registry,records),/record\/source\/model binding/);
 const wrongProof=structuredClone(coverage);wrongProof.retainedPublication!.members.coverage.bytes++;
 assert.throws(()=>validateDistrictCoverage(wrongProof,registry,records,composition.retainedPublication),/member\/origin proof mismatch/);
 const changedSource=structuredClone(records);changedSource[0].sources[0].id=city.sources[1].id;
 assert.throws(()=>validateDistrictCoverage(coverage,registry,changedSource),/record\/source\/model binding/);
 const split=syntheticLineage({...run,availableDocumentGroups:1,attemptedDocumentGroups:1},records,[]);
 assert.throws(()=>buildDistrictCoverage(registry,{...crawl,documents:[crawl.documents[0]],checks:[]},records,composition.quarantine,split,at,composition.retainedPublication),/Split publication provenance/);
 const badInput=structuredClone(baseline.input);badInput.artifacts.coverage.bytes+=' ';
 assert.throws(()=>authenticateRetainedKnowledgePublication(badInput),/member binding|artifact hash/);
});
