import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadDistrictRegistry} from '../src/district-registry.ts';
import {buildDistrictCoverage,validateDistrictCoverage,assertKnowledgeSlice,knowledgePublicationHold,quarantineReasonHistogram,projectDistrictCoverage,type KnowledgeSliceEvidence} from '../src/district-publication.ts';
import {buildTextRunLineage,readTextLineageArtifact,textRunLineageSchema} from '../src/text-run-lineage.ts';
import {composeSyntheticText,syntheticTextContribution,syntheticTextRecord,textArtifact} from './helpers/text-publication-fixture.ts';
import {sha256,knowledgeEvidenceHash} from '../src/district-schema.ts';
import {modelIdentitySha256} from '../src/district-model-contract.ts';

// Synthetic observations exercise counting only; these are not municipal facts.
const registry=await loadDistrictRegistry(fileURLToPath(new URL('../sources/district-registry.json',import.meta.url)));
const city=registry.municipalities[0],at='2026-10-10T12:00:00.000Z';
const first=sha256('synthetic original source bytes'),newer=sha256('synthetic pending source bytes'),withdrawn=sha256('synthetic withdrawn source bytes');
const crawl={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:at,documents:[
 {id:'one',municipalityId:city.id,sourceId:city.sources[0].id,sha256:first},
 {id:'copy',municipalityId:city.id,sourceId:city.sources[1].id,sha256:first},
 {id:'new',municipalityId:city.id,sourceId:city.sources[0].id,sha256:newer}
],checks:[]};
const quarantine={schemaVersion:'stadtstack-quarantine-v1',cases:[first,withdrawn].map(sourceSha256=>({municipalityId:city.id,sourceId:city.sources[0].id,sourceSha256,reason:'Synthetic unsupported case'}))};
const originalCrawl={...crawl,documents:[crawl.documents[0],{id:'withdrawn-original',municipalityId:city.id,sourceId:city.sources[0].id,sha256:withdrawn}]};
const originalRun=syntheticTextContribution(registry,originalCrawl,[],quarantine.cases,{balanced:true});
const run=buildTextRunLineage([originalRun],[],at);

test('Coverage separates representations, attempted byte groups, new pending input and withdrawn input',()=>{
 const coverage=buildDistrictCoverage(registry,crawl,[],quarantine,run);
 const observed=coverage.municipalities.find(item=>item.id===city.id)!;
 assert.equal(observed.documents,3);
 assert.deepEqual(observed.extraction,{fetchedDocumentGroups:2,runSelectedDocumentGroups:null,preparedDocumentGroups:null,attemptedDocumentGroups:1,pendingDocumentGroups:1,unavailableAttemptedDocumentGroups:1});
 assert.equal(coverage.textLineage!.runs[0].scope,'all_fetched_documents');
 assert.equal(coverage.textLineage!.runs[0].groups.pendingFetchedDocumentGroups,0);
 assert.deepEqual(coverage.textLineage!.runs[0].pins,originalRun.pins);
});

test('synthetic coverage and lineage distinguish actual omp and historical Claude tools without relabeling Haiku',()=>{
 const historical=syntheticTextRecord(registry,'synthetic:historical-claude',first,'anthropic-subscription');
 const before=JSON.stringify(historical),fresh=syntheticTextRecord(registry,'synthetic:fresh-omp',newer,'anthropic-subscription');
 const identity={provider:'anthropic-subscription' as const,tool:'omp-cli' as const,toolVersion:'0.0.0-synthetic-omp',model:'claude-haiku-5-5',modelIdentityBasis:'reported-cli-model-and-tool-version' as const};
 const modelEvidence={...identity,modelIdentitySha256:modelIdentitySha256(identity)};
 Object.assign(fresh.extraction,modelEvidence,{returnedModel:identity.model});
 const {modelIdentityBasis:_basis,...judgeIdentity}=modelEvidence;
 Object.assign(fresh.verification.faithfulness,judgeIdentity,{returnedModel:identity.model});
 fresh.verification.evidenceHash=knowledgeEvidenceHash(fresh);
 const observations=[historical,fresh].map((record,index)=>({schemaVersion:'stadtstack-crawl-index-v1',generatedAt:at,documents:[{id:'synthetic:'+index,municipalityId:city.id,sourceId:city.sources[0].id,sha256:record.extraction.inputSha256}],checks:[]}));
 const contributions=[historical,fresh].map((record,index)=>syntheticTextContribution(registry,observations[index],[record],[],{balanced:true,label:'synthetic route '+index}));
 const selections=[historical,fresh].map((record,index)=>({runId:contributions[index].runId,recordId:record.id,originalEvidenceHash:record.verification.evidenceHash,projectedRecord:record}));
 const lineage=buildTextRunLineage(contributions,selections,at);
 const combined={...observations[0],documents:observations.flatMap(observation=>observation.documents)};
 const coverage=buildDistrictCoverage(registry,combined,[historical,fresh],{schemaVersion:'stadtstack-quarantine-v1',cases:[]},lineage,at);
 assert.doesNotThrow(()=>validateDistrictCoverage(coverage,registry,[historical,fresh]));
 assert.deepEqual(coverage.models.map(model=>model.tool).sort(),['claude-cli','omp-cli']);
 assert.deepEqual([...new Set(coverage.models.map(model=>model.model))],['claude-haiku-5-5']);
 assert.equal(lineage.selectedRecordOrigins.find(origin=>origin.recordId===fresh.id)!.model.modelIdentitySha256,modelEvidence.modelIdentitySha256);
 assert.equal(lineage.selectedRecordOrigins.find(origin=>origin.recordId===historical.id)!.model.modelIdentitySha256,historical.extraction.modelIdentitySha256);
 assert.equal(JSON.stringify(historical),before);
 const mixed=structuredClone(coverage);
 mixed.models.find(model=>model.tool==='omp-cli')!.provider='openai-subscription';
 assert.throws(()=>validateDistrictCoverage(mixed,registry,[historical,fresh]));
 const falseSummary=structuredClone(lineage);
 falseSummary.runs[1].providers=[{provider:'anthropic-subscription',model:identity.model,tool:'claude-cli',assignedGroups:1,completedGroups:1,agreementCompleted:0,publishedCandidates:1}];
 assert.equal(textRunLineageSchema.safeParse(falseSummary).success,false);
 const codexOnly=syntheticTextContribution(registry,observations[1],[fresh],[]);
 assert.throws(()=>buildTextRunLineage([codexOnly],[{...selections[1],runId:codexOnly.runId}],at),/Codex-only/);
});

test('replay coverage clock is explicit while original extraction and source clocks remain unchanged',()=>{
 const historical='2026-10-11T09:25:12.545Z',coverage=buildDistrictCoverage(registry,crawl,[],quarantine,run,historical);
 assert.equal(coverage.generatedAt,historical);assert.equal(coverage.textLineage!.runs[0].generatedAt,at);
 assert.equal(crawl.generatedAt,at);assert.equal(run.generatedAt,at);
 assert.throws(()=>buildDistrictCoverage(registry,crawl,[],quarantine,run,'not-a-clock'));
 const normal=buildDistrictCoverage(registry,crawl,[],quarantine,run);
 assert.equal(normal.generatedAt,run.generatedAt);
});

test('Coverage rejects invented attempted totals, missing pending input and concealed extraction caps',()=>{
 const original=readTextLineageArtifact(originalRun.artifacts.extractionRun) as Record<string,unknown>;
 for(const [change,reason] of [[{attemptedDocumentGroups:3},/counts/],[{scope:'bounded_per_municipality'},/selection policy/],[{scope:'bounded_per_municipality',maxDocumentsPerMunicipality:1},/budget exceeded/]] as const){
  const extractionRun=textArtifact({...original,...change});
  assert.throws(()=>buildTextRunLineage([{...originalRun,runId:extractionRun.sha256,artifacts:{...originalRun.artifacts,extractionRun}}],[],at),reason);
 }
 const coverage=buildDistrictCoverage(registry,crawl,[],quarantine,run);
 coverage.municipalities[0].extraction.pendingDocumentGroups=0;
 assert.throws(()=>validateDistrictCoverage(coverage,registry,[]),/Extraction coverage mismatch/);
});

test('Public source barriers retain full counts but only three safe examples',()=>{
 const blocked=Array.from({length:500},(_,i)=>({url:i===0?'http://127.0.0.1/private':`https://example.org/blocked/${i}`,failure:'robots_blocked',checkedAt:at}));
 const observed={...crawl,checks:[{municipalityId:city.id,sourceId:city.sources[0].id,checkState:'checked',checkedAt:at,documentCount:2,coverage:{state:'blocked',pendingCount:0,runnableCount:0,blockedCount:500,action:'ask_municipality'},blocked}]};
 const coverage=buildDistrictCoverage(registry,observed,[],quarantine,run);
 const source=coverage.municipalities[0].sources[0];
 assert.equal(source.failedLinkCount,500);assert.equal(source.failureExamples.length,3);
 assert.equal(source.failureExamples[0].url,null);assert.equal(source.coverage.blockedCount,500);
 assert.equal(JSON.stringify(coverage).includes('/blocked/499'),false);
});

test('District slice acceptance is separate from unchanged individual date gates',()=>{
 // Acceptance-only projections; not model receipts or releasable knowledge records.
 const records=registry.districts.map<KnowledgeSliceEvidence>(district=>({kind:'text_model',id:'test:'+district.id,districtId:district.id,municipalityId:registry.municipalities.find(city=>city.districtId===district.id)!.id,documentDate:'2026-10-10',stageDate:null,stage:'draft',stages:[]}));
 assert.doesNotThrow(()=>assertKnowledgeSlice(registry,records));
 assert.throws(()=>assertKnowledgeSlice(registry,records,3),/1\/3/);
 assert.throws(()=>assertKnowledgeSlice(registry,[{...records[0],documentDate:null},...records.slice(1)]),/Undated knowledge withheld/);
 assert.throws(()=>assertKnowledgeSlice(registry,[{...records[0],stage:'unknown'},...records.slice(1)]),/0\/1/);
});

test('Every registered town exposes checked-without-gated-records versus not-checked explicitly',()=>{
 const coverage=buildDistrictCoverage(registry,crawl,[],quarantine,run);
 assert.equal(coverage.municipalities[0].status,'checked_no_gated_records');
 assert.equal(coverage.municipalities[0].datedStagedRecords,0);
 assert.equal(coverage.municipalities[1].status,'not_checked');
 coverage.municipalities[0].status='gated_records';
 assert.throws(()=>validateDistrictCoverage(coverage,registry,[]),/admission coverage mismatch/);
});

test('Coverage reports only actual per-provider admitted identities and counts',()=>{
 const records=[syntheticTextRecord(registry,'openai-one',first),syntheticTextRecord(registry,'openai-two',first),syntheticTextRecord(registry,'anthropic-one',newer,'anthropic-subscription')];
 const contribution=syntheticTextContribution(registry,crawl,records,[],{balanced:true});
 const context=composeSyntheticText([contribution],[records.map(record=>record.id)],at);
 const coverage=buildDistrictCoverage(registry,crawl,records,{schemaVersion:'stadtstack-quarantine-v1',cases:[]},context.coverage.textLineage);
 assert.deepEqual(Object.fromEntries(coverage.models.map(model=>[model.provider,model.publishedRecords])),{'openai-subscription':2,'anthropic-subscription':1});
 assert.equal(coverage.accounting.publishedMunicipalities,1);
 assert.equal(coverage.accounting.checkedWithoutPublishedMunicipalities,0);
 const wrongCount=structuredClone(coverage);wrongCount.models[0].publishedRecords++;
 assert.throws(()=>validateDistrictCoverage(wrongCount,registry,records),/model provenance/);
 const missingProvider=structuredClone(coverage);missingProvider.models.pop();
 assert.throws(()=>validateDistrictCoverage(missingProvider,registry,records),/Missing admitted model/);
 const substitutedModel=structuredClone(coverage);substitutedModel.models[0].model='different-model';
 assert.throws(()=>validateDistrictCoverage(substitutedModel,registry,records),/model provenance/);
 const falseMode=structuredClone(coverage);falseMode.textLineage!.runs[0].assignmentMode='codex-only';
 assert.throws(()=>validateDistrictCoverage(falseMode,registry,records),/Codex-only assignment/);
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
 const original=structuredClone(cases),coverage=buildDistrictCoverage(registry,crawl,[],{...quarantine,cases},run),observed=coverage.municipalities[0];
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
 for(const item of [{...base,municipalityId:'unregistered'},{...base,sourceId:'unregistered'}])assert.throws(()=>buildDistrictCoverage(registry,crawl,[],{...quarantine,cases:[item]},run),/municipality\/source binding mismatch/);
 const candidate={municipalityId:city.id,extraction:{inputSha256:first},sources:[{id:city.sources[0].id,sha256:first}],verification:{deterministic:{passed:false,checks:[{id:'exact_quotes',passed:false}]},faithfulness:{score:null,threshold:0.8,responseSha256:null}}};
 for(const changed of [{...candidate,municipalityId:registry.municipalities[1].id},{...candidate,extraction:{inputSha256:withdrawn}},{...candidate,sources:[{id:city.sources[1].id,sha256:first}]}])assert.throws(()=>quarantineReasonHistogram([{...base,candidate:changed}]),/candidate source binding mismatch/);
});

test('registry inventory, checked towns, run selection, preparation, attempts and publication are distinct',()=>{
 const checkedOnly=registry.municipalities[1],selectedOnly=registry.municipalities[2];
 const observedCrawl={...crawl,documents:[...crawl.documents,{id:'selected-only',municipalityId:selectedOnly.id,sourceId:selectedOnly.sources[0].id,sha256:newer}],checks:[{municipalityId:checkedOnly.id,sourceId:checkedOnly.sources[0].id,checkState:'not_found',checkedAt:at,documentCount:0}]};
 const selected=[{municipalityId:city.id,sourceSha256:first},{municipalityId:city.id,sourceSha256:withdrawn},{municipalityId:selectedOnly.id,sourceSha256:newer}];
 const prepared=[selected[0],selected[2]];
 const contribution=syntheticTextContribution(registry,{...observedCrawl,documents:[...originalCrawl.documents,observedCrawl.documents[3]]},[],quarantine.cases,{balanced:true,selected,prepared});
 const observedRun=buildTextRunLineage([contribution],[],at);
 const coverage=buildDistrictCoverage(registry,observedCrawl,[],quarantine,observedRun);
 assert.equal(registry.inventory.length,319);
 assert.deepEqual(coverage.accounting,{registryMunicipalities:319,configuredMunicipalities:registry.municipalities.length,checkedMunicipalities:3,runSelectedMunicipalities:2,preparedMunicipalities:2,attemptedMunicipalities:1,publishedMunicipalities:0,checkedWithoutPublishedMunicipalities:3,unvisitedMunicipalities:316});
 const checked=coverage.municipalities.find(item=>item.id===checkedOnly.id)!;
 assert.equal(checked.status,'checked_no_gated_records');
 assert.equal(checked.extraction.attemptedDocumentGroups,0);
 assert.equal(checked.extraction.runSelectedDocumentGroups,0);
 assert.equal(coverage.municipalities[3].status,'not_checked');
 assert.equal(coverage.districts.reduce((n,district)=>n+district.municipalitiesAttempted,0),1);
 assert.equal(coverage.districts.reduce((n,district)=>n+district.municipalitiesChecked,0),3);
 const {preparationPlan:_,...artifacts}=contribution.artifacts;
 const withoutPreparation=buildTextRunLineage([{...contribution,artifacts}],[],at);
 assert.equal(buildDistrictCoverage(registry,observedCrawl,[],quarantine,withoutPreparation).accounting.preparedMunicipalities,null);
 const withoutSelection=buildDistrictCoverage(registry,crawl,[],quarantine,run);
 assert.equal(withoutSelection.accounting.runSelectedMunicipalities,null);
 assert.equal(withoutSelection.accounting.preparedMunicipalities,null);
});

test('coverage rejects invented pipeline accounting and reason counts',()=>{
 const coverage=buildDistrictCoverage(registry,crawl,[],quarantine,run);
 const accounting=structuredClone(coverage);accounting.accounting.attemptedMunicipalities++;
 assert.throws(()=>validateDistrictCoverage(accounting,registry,[]),/accounting mismatch/);
 const histogram=structuredClone(coverage);histogram.municipalities[0].quarantineReasons.categories[0].count++;
 assert.throws(()=>validateDistrictCoverage(histogram,registry,[]),/histogram count mismatch/);
 const source=structuredClone(coverage);source.municipalities[0].sources[0].quarantinedRecords--;
 assert.throws(()=>validateDistrictCoverage(source,registry,[]),/histogram count mismatch|source totals mismatch/);
 const attempted=structuredClone(coverage);attempted.districts[0].municipalitiesAttempted++;
 assert.throws(()=>validateDistrictCoverage(attempted,registry,[]),/attempt\/quarantine totals mismatch/);
 const wrongRun=structuredClone(run);wrongRun.cumulative.groups.attemptedDocumentGroups++;
 assert.throws(()=>buildDistrictCoverage(registry,crawl,[],quarantine,wrongRun),/counts|group|cumulative/i);
});

test('identical source bytes in different towns do not share quarantine counts or attempt identities',()=>{
 const other=registry.municipalities[1];
 const documents=[crawl.documents[0],{id:'other-town',municipalityId:other.id,sourceId:other.sources[0].id,sha256:first}];
 const cases=[
  {municipalityId:city.id,sourceId:city.sources[0].id,sourceSha256:first,reason:'No supported case in source excerpt'},
  {municipalityId:other.id,sourceId:other.sources[0].id,sourceSha256:first,reason:'Structured output/schema validation failed'},
 ];
 const townCrawl={...crawl,documents},contribution=syntheticTextContribution(registry,townCrawl,[],cases,{balanced:true});
 const coverage=buildDistrictCoverage(registry,townCrawl,[],{...quarantine,cases},buildTextRunLineage([contribution],[],at));
 assert.equal(coverage.accounting.attemptedMunicipalities,2);
 assert.equal(coverage.municipalities[0].quarantinedRecords,1);
 assert.equal(coverage.municipalities[1].quarantinedRecords,1);
 assert.deepEqual(coverage.municipalities[0].quarantineReasons.categories,[{reason:'no_supported_case',count:1}]);
 assert.deepEqual(coverage.municipalities[1].quarantineReasons.categories,[{reason:'invalid_structured_output',count:1}]);
 assert.equal(coverage.municipalities[0].sources[1].quarantinedRecords,0);
});

test('v5 district accounting exposes full inventory independently of configured and attempted towns',()=>{
 const coverage=buildDistrictCoverage(registry,crawl,[],quarantine,run);
 assert.equal(coverage.schemaVersion,'stadtstack-district-coverage-v5');
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
