import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadDistrictRegistry} from '../src/district-registry.ts';
import {buildDistrictCoverage,validateDistrictCoverage,assertKnowledgeSlice,type KnowledgeSliceEvidence} from '../src/district-publication.ts';

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
const run={schemaVersion:'stadtstack-extraction-run-v1',generatedAt:at,scope:'all_fetched_documents',maxDocumentsPerMunicipality:null,availableDocumentGroups:2,attemptedDocumentGroups:2,pendingDocumentGroups:0};

test('Coverage separates representations, attempted byte groups, new pending input and withdrawn input',()=>{
 const coverage=buildDistrictCoverage(registry,crawl,[],quarantine,'gpt-6-luna',run);
 const observed=coverage.municipalities.find(item=>item.id===city.id)!;
 assert.equal(observed.documents,3);
 assert.deepEqual(observed.extraction,{fetchedDocumentGroups:2,attemptedDocumentGroups:1,pendingDocumentGroups:1,unavailableAttemptedDocumentGroups:1});
 assert.equal(coverage.extractionRun.selection,'all_at_run_start');
 assert.equal(coverage.extractionRun.pendingDocumentGroupsAtRunStart,0);
});

test('Coverage rejects invented attempted totals, missing pending input and concealed extraction caps',()=>{
 assert.throws(()=>buildDistrictCoverage(registry,crawl,[],quarantine,'gpt-6-luna',{...run,attemptedDocumentGroups:3}),/counts/);
 assert.throws(()=>buildDistrictCoverage(registry,crawl,[],quarantine,'gpt-6-luna',{...run,scope:'bounded_per_municipality'}),/selection policy/);
 assert.throws(()=>buildDistrictCoverage(registry,crawl,[],quarantine,'gpt-6-luna',{...run,scope:'bounded_per_municipality',maxDocumentsPerMunicipality:1}),/budget exceeded/);
 const coverage=buildDistrictCoverage(registry,crawl,[],quarantine,'gpt-6-luna',run);
 coverage.municipalities[0].extraction.pendingDocumentGroups=0;
 assert.throws(()=>validateDistrictCoverage(coverage,registry,[]),/Extraction coverage mismatch/);
});

test('Public source barriers retain full counts but only three safe examples',()=>{
 const blocked=Array.from({length:500},(_,i)=>({url:i===0?'http://127.0.0.1/private':`https://example.org/blocked/${i}`,failure:'robots_blocked',checkedAt:at}));
 const observed={...crawl,checks:[{municipalityId:city.id,sourceId:city.sources[0].id,checkState:'checked',checkedAt:at,documentCount:2,coverage:{state:'blocked',pendingCount:0,runnableCount:0,blockedCount:500,action:'ask_municipality'},blocked}]};
 const coverage=buildDistrictCoverage(registry,observed,[],quarantine,'gpt-6-luna',run);
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
 const coverage=buildDistrictCoverage(registry,crawl,[],quarantine,'gpt-6-luna',run);
 assert.equal(coverage.municipalities[0].status,'checked_no_gated_records');
 assert.equal(coverage.municipalities[0].datedStagedRecords,0);
 assert.equal(coverage.municipalities[1].status,'not_checked');
 coverage.municipalities[0].status='gated_records';
 assert.throws(()=>validateDistrictCoverage(coverage,registry,[]),/admission coverage mismatch/);
});
