import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadDistrictRegistry} from '../src/district-registry.ts';
import {digest,semanticHash,observation,type StructuredAdapter,type AdapterCoverage} from '../src/district-adapter-contract.ts';
import {admitStructuredObservations} from '../src/district-structured-record.ts';
import {buildDistrictCoverage,validateDistrictCoverage,knowledgePublicationHold,knowledgePublicationQuarantineCase,assertKnowledgeSlice} from '../src/district-publication.ts';
import {structuredRunSchema} from '../src/district-structured-run.ts';
import {sha256,knowledgeEvidenceHash} from '../src/district-schema.ts';
import {buildTextRunLineage,textLineageRecordSha256} from '../src/text-run-lineage.ts';
import {composeSyntheticText,historicalTextRecord,syntheticTextContribution,syntheticTextRecord} from './helpers/text-publication-fixture.ts';

// Explicit synthetic counting fixtures; no observed civic facts or operational adapter receipts.
const registryPath=fileURLToPath(new URL('../sources/district-registry.json',import.meta.url));
const registry=await loadDistrictRegistry(registryPath);
const city=registry.municipalities[0],sourceId='synthetic-structured-source',at='2026-10-10T12:00:00.000Z';
city.sources.push({id:sourceId,kind:'structured',url:'https://example.org/synthetic.csv',vendor:'other',checkState:'checked',checkedAt:at,evidence:[{url:'https://example.org/synthetic.csv',locator:'Synthetic registry source fixture.'}]});
const registrySha256=semanticHash(registry);
const scope={publisherId:'synthetic-fixture-publisher',sourceId,municipalityId:city.id,ags:city.ags,tenant:null,observationWindow:'synthetic-2022'};
const bytes=Buffer.from('synthetic native row fixture'),sourceSha256=digest(bytes),policyReceiptSha256='1'.repeat(64),adapterContractSha256='2'.repeat(64);
const snapshot={bytes,sourceSha256,url:'https://example.org/synthetic.csv',mimeType:'text/csv',retrievedAt:at,policyReceiptSha256,sourceVersion:null};
const native=observation({publisherId:scope.publisherId,sourceId,nativeId:'fixture-row-1',nativeVersion:null,kind:'StatisticalObservation',subject:'synthetic population',predicate:'population',value:7,unit:'persons',date:'2022-05-15',dateRole:'reference_date',financialRole:'none',geography:{ags:city.ags,basis:'source_explicit',role:'administrative_area'},sourceReferenceDate:'2022-05-15',publishedAt:null,retrievedAt:at,evidence:[{sourceSha256,format:'csv',nativeId:'fixture-row-1',path:'/population',sheet:null,rowKey:'fixture-row-1',cells:['population'],rawValue:7,schemaHash:'3'.repeat(64),mappingVersion:'synthetic-v1'}],limitations:['Synthetic fixture; not municipal evidence.']});
const adapterCoverage:AdapterCoverage={state:'complete',scope:'synthetic fixture',reason:'Synthetic deterministic row fixture.',checkedAt:at,nextCursor:null,observedRows:1,limitations:['Synthetic fixture; not operational coverage.']};
const adapter:StructuredAdapter={id:'synthetic-publication-fixture',version:'synthetic-v1',discover:()=>({resources:[],coverage:adapterCoverage}),parse:()=>({observations:[native],coverage:adapterCoverage})};
const records=await admitStructuredObservations({adapter,adapterContractSha256,snapshot,scope,districtId:city.districtId,candidates:[native],replayInSandbox:async()=>({observations:[native],coverage:adapterCoverage}),checkCurrentPolicy:async()=>({allowed:true,receiptSha256:policyReceiptSha256,sourceSha256,scopeSha256:semanticHash(scope),checkedAt:at})});
const receipt={family:'synthetic-fixture',operation:'parse',adapterId:adapter.id,adapterVersion:adapter.version,municipalityId:city.id,sourceId,scopeSha256:semanticHash(scope),sourceSha256,policyReceiptSha256,stepReceiptSha256:'4'.repeat(64),additionalStepReceiptSha256s:[],coverage:adapterCoverage};
const run={schemaVersion:'district-structured-run-v1',generatedAt:at,registrySha256,questionDispositionSha256:'5'.repeat(64),adapterContractSha256:semanticHash([adapterContractSha256]),records,coverage:[receipt]};
const crawl={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:at,documents:[],checks:[]};
const quarantine={schemaVersion:'stadtstack-quarantine-v1',cases:[]};

 test('structured publication counts native records separately without inventing model extraction',()=>{
 const coverage=buildDistrictCoverage(registry,crawl,records,quarantine,null,at,run);
 const observed=coverage.municipalities.find(item=>item.id===city.id)!;
 assert.equal(observed.publishedRecords,1);
 assert.equal(observed.structuredRecords,1);
 assert.equal(observed.textModelRecords,0);
 assert.equal(observed.datedStagedRecords,0);
 assert.equal(observed.extraction.attemptedDocumentGroups,0);
 assert.equal(coverage.textLineage,null);
 assert.deepEqual(coverage.models,[]);
 assert.equal(coverage.adapters.length,1);
 assert.equal(coverage.adapters[0].publishedRecords,1);
 assert.equal(coverage.adapters[0].coverage.state,'complete');
 assert.equal('extraction' in records[0],false);
 assert.equal('faithfulness' in records[0].verification,false);
 assert.doesNotThrow(()=>validateDistrictCoverage(coverage,registry,records));
 const invented=structuredClone(coverage);invented.municipalities[0].textModelRecords=1;
 assert.throws(()=>validateDistrictCoverage(invented,registry,records),/record|count|provenance/i);
 });

 test('structured coverage retains blocked and unchecked receipts without calling them admitted adapters',()=>{
 const blocked={...receipt,sourceSha256:null,policyReceiptSha256:null,stepReceiptSha256:null,coverage:{...adapterCoverage,state:'blocked_access',observedRows:0}};
 const blockedRun={...run,records:[],coverage:[blocked]};
 const coverage=buildDistrictCoverage(registry,crawl,[],quarantine,null,at,blockedRun);
 assert.deepEqual(coverage.models,[]);
 assert.equal(coverage.adapters[0].publishedRecords,0);
 assert.equal(coverage.adapters[0].coverage.state,'blocked_access');
 const unchecked=buildDistrictCoverage(registry,crawl,[],quarantine,null,at,{...blockedRun,coverage:[{...blocked,coverage:{...blocked.coverage,state:'not_checked',checkedAt:null}}]});
 assert.equal(unchecked.accounting.checkedMunicipalities,0);
 });

 test('structured run cannot move admitted evidence across source, scope, policy or adapter version',()=>{
 assert.equal(structuredRunSchema.safeParse(run).success,true);
 for(const mutation of [{sourceId:'unregistered-fixture-source'},{sourceSha256:'6'.repeat(64)},{scopeSha256:'7'.repeat(64)},{policyReceiptSha256:'8'.repeat(64)},{adapterVersion:'invented-v2'},{stepReceiptSha256:null}]){
  assert.throws(()=>buildDistrictCoverage(registry,crawl,records,quarantine,null,at,{...run,coverage:[{...receipt,...mutation}]}),/structured|binding|receipt|source|adapter/i);
 }
 assert.throws(()=>buildDistrictCoverage(registry,crawl,records,quarantine,null,at,{...run,records:[]}),/structured|binding|record/i);
 });

 test('dated contextual native observations do not satisfy sourced action-stage acceptance',()=>{
 assert.equal(knowledgePublicationHold(records[0]),null);
 assert.throws(()=>assertKnowledgeSlice(registry,records),/slice incomplete/i);
 const held={...records[0],source:{...records[0].source,url:'https://localhost/private.csv'}};
 const hold=knowledgePublicationHold(held)!;
 assert.deepEqual(hold.reasons,['nonpublic_evidence_url']);
 const item=knowledgePublicationQuarantineCase(held,hold);
 assert.equal(item.sourceId,sourceId);
 assert.equal(item.sourceSha256,sourceSha256);
 assert.equal(JSON.stringify(item).includes('localhost'),false);
 });

test('mixed v5 coverage preserves original balanced and Codex-only text receipts without charging native rows to extraction',()=>{
 const inputSha256=sha256('synthetic mixed source bytes'),textSource=city.sources[0];
 const earlier='2026-10-09T12:00:00.000Z';
 const old=historicalTextRecord(syntheticTextRecord(registry,'synthetic-old',inputSha256,'anthropic-subscription',earlier));
 const current=syntheticTextRecord(registry,'synthetic-new',inputSha256);
 const oldRegistry=structuredClone(registry);oldRegistry.municipalities[0].sources=oldRegistry.municipalities[0].sources.filter(source=>source.id!==sourceId);
 const documents=[{id:'synthetic-text-source',municipalityId:city.id,sourceId:textSource.id,sha256:inputSha256}];
 const broad={municipalityId:city.id,sourceId:textSource.id,checkState:'checked',checkedAt:earlier,documentCount:1,coverage:{state:'partial',pendingCount:7,runnableCount:5,blockedCount:2,scope:'Synthetic broad source'}};
 const targeted={municipalityId:city.id,sourceId:textSource.id,checkState:'checked',checkedAt:at,documentCount:1,coverage:{state:'partial',pendingCount:0,runnableCount:0,blockedCount:0,sourceCoverage:'not_assessed',targetScope:{kind:'seed_documents',urls:['https://example.org/synthetic'],state:'complete',pendingCount:0,runnableCount:0,blockedCount:0}}};
 const group={municipalityId:city.id,sourceSha256:inputSha256};
 const historical=syntheticTextContribution(oldRegistry,{...crawl,generatedAt:earlier,documents,checks:[broad]},[old],[],{label:'original-balanced',balanced:true,v2:true,prepared:[group]});
 const correction=syntheticTextContribution(registry,{...crawl,documents,checks:[targeted]},[current],[],{label:'original-codex',prepared:[group]});
 const originalBytes=[historical.artifacts.records.bytes,correction.artifacts.records.bytes];
 assert.throws(()=>composeSyntheticText([historical,correction],[[old.id],[current.id]],at),/kind|schemaProjection|text markers|text_model/i);
 const context=composeSyntheticText([historical,correction],[[old.id],[current.id]],at,[historical.runId]);
 const mixed=[...context.knowledge.records,...records];
 const coverage=buildDistrictCoverage(registry,context.coverage.crawl,mixed,context.coverage.quarantine,context.coverage.textLineage,at,run),observed=coverage.municipalities.find(item=>item.id===city.id)!;
 assert.equal(coverage.schemaVersion,'stadtstack-district-coverage-v5');
 assert.equal(observed.publishedRecords,3);
 assert.equal(observed.textModelRecords,2);
 assert.equal(observed.structuredRecords,1);
 assert.equal(observed.extraction.attemptedDocumentGroups,1);
 assert.equal(observed.datedStagedRecords,2);
 assert.equal(coverage.models.length,2);
 assert.deepEqual(coverage.models.map(model=>model.publishedRecords),[1,1]);
 assert.equal(coverage.adapters[0].publishedRecords,1);
 assert.deepEqual(coverage.textLineage,buildTextRunLineage([historical,correction],context.composition.selections,at));
 assert.deepEqual(coverage.textLineage!.runs.map(row=>row.assignmentMode),['balanced','codex-only']);
 assert.deepEqual(coverage.textLineage!.runs.map(row=>row.pins),[historical.pins,correction.pins]);
 assert.notEqual(historical.pins.registrySha256,correction.pins.registrySha256);
 assert.equal(coverage.textLineage!.cumulative.attemptsAcrossRuns,2);
 assert.equal(coverage.textLineage!.cumulative.groups.attemptedDocumentGroups,1);
 assert.equal(coverage.textLineage!.cumulative.groups.selectedDocumentGroups.count,1);
 assert.equal(coverage.textLineage!.cumulative.groups.preparedDocumentGroups.count,1);
 const projected=context.knowledge.records.find(row=>row.id===old.id)!;
 assert.deepEqual(projected.extraction,old.extraction);
 assert.deepEqual(projected.verification.faithfulness,old.verification.faithfulness);
 const origin=coverage.textLineage!.selectedRecordOrigins.find(row=>row.recordId===old.id)!;
 assert.deepEqual(origin.schemaProjection,{version:'knowledge-v2-to-v3-text-model-v1'});
 assert.equal(origin.originalRecordSha256,textLineageRecordSha256(old));
 assert.equal(origin.originalEvidenceHash,old.verification.evidenceHash);
 assert.equal(origin.currentEvidenceHash,knowledgeEvidenceHash(projected));
 assert.equal(origin.outputArtifactSha256,historical.artifacts.records.sha256);
 assert.deepEqual([historical.artifacts.records.bytes,correction.artifacts.records.bytes],originalBytes);
 const observedSource=observed.sources.find(source=>source.sourceId===textSource.id)!;
 assert.equal(observedSource.coverageSelection,'latest_non_targeted_observation');
 assert.equal(observedSource.coverage.pendingCount,7);
 assert.deepEqual(observedSource.observations.map(row=>row.runId),[historical.runId,correction.runId]);
 assert.equal(observedSource.observations[1].coverage.targetScope!.state,'complete');
 assert.doesNotThrow(()=>validateDistrictCoverage(coverage,registry,mixed));
 assert.equal(structuredRunSchema.safeParse({...run,records:[{...records[0],extraction:current.extraction}]}).success,false);
 for(const field of ['inputSha256','responseSha256','promptSha256','judgePromptSha256','modelIdentitySha256'] as const){
  const changed=structuredClone(mixed),text=changed.find(row=>row.kind==='text_model')!;
  if(text.kind!=='text_model')throw Error('Expected synthetic text fixture');
  text.extraction[field]=sha256('substituted '+field);
  assert.throws(()=>validateDistrictCoverage(coverage,registry,changed),/generation binding mismatch/);
 }
});
