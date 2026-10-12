import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import { canonicalJson, semanticHash, observation } from '../src/district-adapter-contract.ts';
import { DistrictKnowledgeRecordSchema, REQUIRED_DETERMINISTIC_CHECKS, knowledgeEvidenceHash, sha256, type DistrictKnowledgeRecord } from '../src/district-schema.ts';
import { GRAPH_DETERMINISTIC_CHECKS } from '../src/district-graph-claims.ts';
import { PROVIDER_CONFIGS } from '../src/district-model-contract.ts';
import { assessmentItemSchema, assessmentOutputSchema, reconcile, assessmentProviderInput, originalEvidence, type AssessmentEvidenceContext, type AssessmentItem } from '../src/district-assessment.ts';
import { prepareCriticalAssessment, admitCriticalKnowledge } from '../src/district-critical-assessment.ts';
import { criticalKnowledgeTarget, assertCriticalAdmissionsBound } from '../src/district-critical-assessment-public.ts';
import { CriticalAdmissionsSchema, CriticalAdmissionSchema } from '../src/district-critical-assessment-contract.ts';
import { admitStructuredObservations } from '../src/district-structured-record.ts';
import { buildDistrictCoverage } from '../src/district-publication.ts';
import { buildTextRunLineage,type TextLineageArtifact } from '../src/text-run-lineage.ts';
import { loadDistrictRegistry } from '../src/district-registry.ts';
import { dataReleaseId } from '../src/data-release.ts';
import {loadRetainedPublicationComposition} from '../src/district-r1-text-composition.ts';
import {textArtifact,syntheticTextContribution} from './helpers/text-publication-fixture.ts';
import { admittedAssessmentFixture, syntheticAssessmentTriplet } from './district-assessment.fixture.ts';
import type { PolicyReceipt } from '../src/district-policy-receipt.ts';
interface CriticalFixture { directory: string; context: AssessmentEvidenceContext; source: AssessmentItem['sources'][number]; policy: PolicyReceipt }
async function retainedPublicationFixture(record:DistrictKnowledgeRecord){
 const registry=await loadDistrictRegistry(fileURLToPath(new URL('../sources/district-registry.json',import.meta.url)));
 const city=registry.municipalities.find(item=>item.id===record.municipalityId)!;
 record.sources[0].id=city.sources[0].id;record.sources[0].sourceType=city.sources[0].kind as typeof record.sources[number]['sourceType'];
 record.documentDate='2026-10-11';record.documentDateQuote='11 October 2026';record.documentDateReason=null;
 record.verification.evidenceHash=knowledgeEvidenceHash(record);
 DistrictKnowledgeRecordSchema.parse(record);
 const generatedAt='2026-10-11T12:00:00.000Z',crawl={schemaVersion:'stadtstack-crawl-index-v1',generatedAt,documents:[{id:'synthetic-retained',municipalityId:city.id,sourceId:city.sources[0].id,sha256:record.extraction.inputSha256}],checks:[]};
 const run=syntheticTextContribution(registry,crawl,[record],[]),lineage=buildTextRunLineage([run],[{runId:run.runId,recordId:record.id,originalEvidenceHash:record.verification.evidenceHash,projectedRecord:record}],generatedAt);
 const coverage=buildDistrictCoverage(registry,crawl,[record],{schemaVersion:'stadtstack-quarantine-v1',cases:[]},lineage,generatedAt);
 const recordsArtifact=textArtifact({schemaVersion:'stadtstack-knowledge-v3',generatedAt,records:[record],identityAssertions:[],identityAdmissions:[]}),registryArtifact=textArtifact(registry),coverageArtifact=textArtifact(coverage);
 const files=([['knowledge/records.json',recordsArtifact],['knowledge/coverage.json',coverageArtifact],['knowledge/registry.json',registryArtifact]] as const).map(([path,value])=>({path,sha256:value.sha256,bytes:Buffer.byteLength(value.bytes as string)}));
 const manifest=textArtifact({schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt,files,quality:{publishedRecords:1,quarantinedRecords:0,cities:registry.municipalities.length}});
 const byPath=new Map<string,TextLineageArtifact>([['manifest.json',manifest],['records.json',recordsArtifact],['coverage.json',coverageArtifact],['registry.json',registryArtifact]]);
 const retainedPins=Object.fromEntries(([['manifest',manifest],['records',recordsArtifact],['coverage',coverageArtifact],['registry',registryArtifact]] as const).map(([name,value])=>[name,{path:`retained/${name}.json`,sha256:value.sha256}]));
 const nativePins=Object.fromEntries(Object.entries(run.artifacts).map(([name,value])=>[name,{path:`native/${name}.json`,sha256:value.sha256}]));
 const raw={schemaVersion:'district-r1-text-composition-input-v1',generatedAt,approvedRunOrder:[run.runId],admissions:[{runId:run.runId,recordIds:[]}],contributions:[{runId:run.runId,pins:run.pins,sourceArtifactKind:'native_extraction_output',artifacts:nativePins}],retainedPublication:{...retainedPins,recordIds:[record.id]}};
 const load=async(pin:{path:string})=>{
  const artifact=pin.path.startsWith('retained/')?byPath.get(pin.path.slice('retained/'.length))??byPath.get(pin.path.split('/').at(-1)!):undefined;
  if(!artifact)throw Error('Unexpected synthetic artifact pin');
  return artifact.bytes;
 };
 const composition=await loadRetainedPublicationComposition(raw,load);
 assert.ok(composition);
 return {composition,raw,load,record,registry,coverage};
}

const digest = semanticHash('synthetic fixture hash');
function modelRecord(fixture: CriticalFixture, summary: string, stage: 'adopted' | 'implemented' | 'unknown' = 'unknown') {
  const source = fixture.source, config = PROVIDER_CONFIGS['openai-subscription'];
  const checks = [...REQUIRED_DETERMINISTIC_CHECKS, ...GRAPH_DETERMINISTIC_CHECKS].map(id => ({ id, passed: true, reason: 'Synthetic historical gate fixture; no model executed.' }));
  const quote = summary;
  const record = { kind: 'text_model' as const, id: 'knowledge:synthetic-critical', municipalityId: 'strausberg', ags: '12064472', districtId: 'maerkisch-oderland',
    title: 'Strausberg', titleQuote: 'Strausberg', municipalityQuote: 'Strausberg', summary, summaryQuote: quote,
    caseKeyType: 'source_document' as const, caseKey: 'source_document:' + source.originalSha256, caseQuote: null, caseType: 'unknown' as const,
    documentDate: null, documentDateQuote: null, documentDateReason: 'Synthetic source has no complete date.',
    stage, stageDate: null, stageDateQuote: null, stageDateReason: 'Synthetic event has no complete date.',
    originalStatus: stage === 'unknown' ? '' : stage === 'adopted' ? 'als Satzung beschlossen' : 'fertiggestellt',
    stageQuote: stage === 'unknown' ? '' : quote, stages: [], entities: [], relations: [], locations: [], topics: [],
    sources: [{ id: source.sourceId, url: fixture.policy.source.url, sha256: source.originalSha256, retrievedAt: '2026-10-11T00:00:00.000Z',
      locator: 'source-original', mimeType: 'text/plain', sourceType: 'website' as const, policy: fixture.policy.sourcePolicy }],
    extraction: { extractorVersion: 'synthetic-original', extractorSha256: digest, provider: 'openai-subscription' as const,
      model: config.model, tool: config.tool, toolVersion: 'synthetic-original', modelIdentitySha256: digest,
      modelIdentityBasis: config.modelIdentityBasis, returnedModel: null, promptVersion: 'synthetic-original', promptSha256: digest,
      judgePromptVersion: 'synthetic-original', judgePromptSha256: digest, inputSha256: source.originalSha256, textSha256: source.textSha256,
      responseSha256: semanticHash('original generator response'), ocrUsed: false, textMethod: 'text' as const,
      cacheKey: digest, extractedAt: '2026-10-11T00:00:00.000Z', chunk: { index: 0, count: 1, start: 0, end: summary.length } },
    verification: { kind: 'text_model' as const, status: 'auto-verified' as const, deterministic: { passed: true, checks },
      faithfulness: { score: 0.9, threshold: 0.8 as const, provider: 'openai-subscription' as const, model: config.model, tool: config.tool,
        toolVersion: 'synthetic-original', modelIdentitySha256: digest, returnedModel: null, reason: 'Synthetic original judgment, not an executed model call.',
        evaluatedAt: '2026-10-11T00:00:00.000Z', responseSha256: semanticHash('original judge response'), sameModel: true as const,
        limitation: 'Same-model judgment is not independent verification.' as const }, evidenceHash: '' } };
  record.verification.evidenceHash = knowledgeEvidenceHash(record);
  return DistrictKnowledgeRecordSchema.parse(record);
}
async function reviewedBundle(fixture: CriticalFixture, record: DistrictKnowledgeRecord, unresolved = false) {
  const rubric = '0–2 source/correctness; every critical stage, financial role, condition and date must match the complete projection. AI consensus is not independent gold.';
  const raw = assessmentItemSchema.parse({ version: 'assessment-item-v1', itemId: record.id,
    question: 'Sind die ursprünglichen, exakt gebundenen kritischen Behauptungen vollständig durch Originalevidenz belegt?',
    claim: '', rubric, rubricSha256: sha256(rubric), sources: [fixture.source], claimIds: ['initial'], entityIds: [], constraints: [], criticalKinds: [] });
  const item = prepareCriticalAssessment(record, raw), target = item.criticalTarget!;
  const output = assessmentOutputSchema.parse({ itemId: item.itemId, outcome: unresolved ? 'unresolved' : 'supported',
    scores: { correctness: unresolved ? 0 : 2, sources: unresolved ? 0 : 2, usefulness: 0 }, holdReasons: [],
    rationale: 'Synthetic original-evidence fixture; no models executed.',
    assertions: target.claims.map(claim => ({ claimId: claim.claimId, sourceId: claim.sourceId, locatorId: 'page1',
      quote: claim.quote, subjectId: claim.subjectId, objectId: claim.objectId, value: null, unit: null,
      date: claim.date, dateRole: claim.dateRole, financialRole: claim.financialRoles[0], stage: claim.stage, modality: claim.modality })),
    criticalReview: { recordId: target.recordId, recordEvidenceSha256: target.recordEvidenceSha256,
      claimProjectionSha256: target.claimProjectionSha256, claims: target.claims.map(claim => ({
        claimId: claim.claimId, claimSha256: claim.claimSha256, verdict: unresolved ? 'unresolved' : 'supported',
        rationale: 'Synthetic inspection of the complete source-bound claim; no independent gold claimed.' })) } });
  const receipts = await syntheticAssessmentTriplet(item, output, fixture.context), final = await reconcile(item, receipts, fixture.context);
  const artifacts = await Promise.all([item, receipts.A, receipts.B, receipts.C, final].map(value =>
    fixture.context.cas.put(Buffer.from(canonicalJson(value)), { kind: 'receipt', mimeType: 'application/json' })));
  const entry = { recordId: record.id, recordEvidenceSha256: record.verification.evidenceHash, itemArtifactSha256: artifacts[0].sha256,
    AArtifactSha256: artifacts[1].sha256, BArtifactSha256: artifacts[2].sha256, CArtifactSha256: artifacts[3].sha256,
    finalArtifactSha256: artifacts[4].sha256 };
  return { item, output, receipts, final, entry, inventory: { records: [entry] } };
}
test('old generation/single-judge receipts cannot admit a critical finalization without actual A/B/C artifacts', async () => {
  const text = 'Strausberg hat den Plan als Satzung beschlossen.';
  const fixture = await admittedAssessmentFixture(text);
  try {
    const record = modelRecord(fixture, text, 'adopted'), generation = structuredClone(record.extraction), judgment = structuredClone(record.verification.faithfulness);
    const result = await admitCriticalKnowledge([record], { records: [] }, fixture.context.cas, { policyOptions: fixture.context.policyOptions });
    assert.deepEqual(result.admissions, []);
    assert.deepEqual(result.holds, [{ recordId: record.id, reason: 'critical_assessment_missing' }]);
    assert.deepEqual(record.extraction, generation); assert.deepEqual(record.verification.faithfulness, judgment);
    assert.throws(() => assertCriticalAdmissionsBound([record], []), /cover exactly/);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
test('authenticated retained originals use retained gates only; changed or unselected critical records remain held',async()=>{
 const fixture=await admittedAssessmentFixture('Strausberg hat den Plan als Satzung beschlossen.');
 try{
  const record=modelRecord(fixture,'Strausberg hat den Plan als Satzung beschlossen.','adopted'),retained=await retainedPublicationFixture(record);
  const accepted=await admitCriticalKnowledge([record],{records:[]},fixture.context.cas,{retainedPublication:retained.composition});
  assert.deepEqual(accepted.holds,[]);
  assert.equal(accepted.admissions[0].labelProvenance,'retained_original_gates');
  assert.equal(accepted.admissions[0].independentlyValidated,false);
  assert.equal('AArtifactSha256' in accepted.admissions[0],false);
  const lineage={...retained.composition.baseline.lineage,selectedRecordOrigins:retained.composition.selectedRecordOrigins};
  assert.doesNotThrow(()=>assertCriticalAdmissionsBound([record],accepted.admissions,lineage));
  assert.throws(()=>assertCriticalAdmissionsBound([record],accepted.admissions),/exact publication lineage/);
  const changed=structuredClone(record);changed.summary='Strausberg hat einen anderen Plan beschlossen.';changed.summaryQuote=changed.summary;changed.verification.evidenceHash=knowledgeEvidenceHash(changed);
  const changedResult=await admitCriticalKnowledge([changed],{records:[]},fixture.context.cas,{retainedPublication:retained.composition});
  assert.deepEqual(changedResult.admissions,[]);
  assert.equal(changedResult.holds[0].reason,'critical_assessment_binding');
  assert.throws(()=>assertCriticalAdmissionsBound([changed],accepted.admissions,lineage),/evidence binding|publication lineage/);
  const unselected={...retained.composition,selectedRecordOrigins:[]};
  const unselectedResult=await admitCriticalKnowledge([record],{records:[]},fixture.context.cas,{retainedPublication:unselected});
  assert.deepEqual(unselectedResult.admissions,[]);
  assert.equal(unselectedResult.holds[0].reason,'critical_assessment_missing');
 }finally{await rm(fixture.directory,{recursive:true,force:true});}
});
test('actual private final/item/A/B/C replay produces only exact source-bound AI admission and stable full inventory dependency', async () => {
  const text = 'Strausberg hat den Plan als Satzung beschlossen.';
  const fixture = await admittedAssessmentFixture(text);
  try {
    const record = modelRecord(fixture, text, 'adopted'), before = canonicalJson(record);
    const bundle = await reviewedBundle(fixture, record);
    const result = await admitCriticalKnowledge([record], bundle.inventory, fixture.context.cas, { policyOptions: fixture.context.policyOptions });
    assert.deepEqual(result.holds, []); assert.equal(result.admissions.length, 1);
    const projection = CriticalAdmissionsSchema.parse({ schemaVersion: 'critical-knowledge-admissions-v1', admissions: result.admissions });
    assertCriticalAdmissionsBound([record], projection.admissions);
    assert.equal(result.admissions[0].recordEvidenceSha256, record.verification.evidenceHash);
    assert.equal(result.admissions[0].claimProjectionSha256, bundle.item.criticalTarget!.claimProjectionSha256);
    assert.equal(result.admissions[0].labelProvenance, 'ai_reconciled');
    assert.equal(result.admissions[0].independentlyValidated, false);
    assert.equal(canonicalJson(record), before);
    const replay = await admitCriticalKnowledge([record], bundle.inventory, fixture.context.cas,
      { policyOptions: fixture.context.policyOptions, originalAdmissions: result.admissions });
    assert.deepEqual(replay.admissions, result.admissions);
    const withheldReplay = await admitCriticalKnowledge([], bundle.inventory, fixture.context.cas, { policyOptions: fixture.context.policyOptions });
    assert.equal(withheldReplay.dependencySha256, result.dependencySha256); assert.deepEqual(withheldReplay.admissions, []);
    const { sealSha256, ...body } = result.admissions[0];
    assert.equal(sealSha256, semanticHash(body));
    const substituted = { ...body, sourceEvidenceHashes: [digest] };
    const invalid = CriticalAdmissionSchema.parse({ ...substituted, sealSha256: semanticHash(substituted) });
    assert.throws(() => assertCriticalAdmissionsBound([record], [invalid]), /evidence binding/);
    const altered = structuredClone(record); altered.summary = 'Strausberg hat einen anderen Plan als Satzung beschlossen.';
    altered.verification.evidenceHash = knowledgeEvidenceHash(altered);
    const changed = await admitCriticalKnowledge([altered], bundle.inventory, fixture.context.cas, { policyOptions: fixture.context.policyOptions });
    assert.deepEqual(changed.admissions, []); assert.equal(changed.holds[0].reason, 'critical_assessment_binding');
    const blinded = assessmentProviderInput(bundle.item, await originalEvidence(bundle.item, fixture.context));
    const candidate = JSON.parse(JSON.stringify(blinded)).criticalTarget.claimProjection;
    assert.equal(Object.hasOwn(candidate, 'extraction'), false);
    assert.equal(Object.hasOwn(candidate, 'verification'), false);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
test('held/unresolved assessments and arbitrary receipt hashes hold affected records', async () => {
  const text = 'Strausberg hat die Anlage fertiggestellt.';
  const fixture = await admittedAssessmentFixture(text);
  try {
    const record = modelRecord(fixture, text, 'implemented');
    const unresolved = await reviewedBundle(fixture, record, true);
    const held = await admitCriticalKnowledge([record], unresolved.inventory, fixture.context.cas, { policyOptions: fixture.context.policyOptions });
    assert.deepEqual(held.admissions, []); assert.equal(held.holds[0].reason, 'critical_assessment_held');
    const arbitrary = { records: [{ ...unresolved.entry, finalArtifactSha256: digest }] };
    const missing = await admitCriticalKnowledge([record], arbitrary, fixture.context.cas, { policyOptions: fixture.context.policyOptions });
    assert.deepEqual(missing.admissions, []); assert.equal(missing.holds[0].reason, 'critical_assessment_binding');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
test('actual payout requires assessed financial role and cannot borrow a real assessment for another projection', async () => {
  const text = 'Strausberg hat 100 EUR tatsächlich gezahlt.';
  const fixture = await admittedAssessmentFixture(text);
  try {
    const record = modelRecord(fixture, text);
    const target = criticalKnowledgeTarget(record)!;
    assert.equal(target.claims[0].kind, 'finance'); assert.deepEqual(target.claims[0].financialRoles, ['payment']);
    const bundle = await reviewedBundle(fixture, record), admitted = await admitCriticalKnowledge([record], bundle.inventory, fixture.context.cas,
      { policyOptions: fixture.context.policyOptions });
    assert.equal(admitted.admissions.length, 1);
    const wrong = assessmentOutputSchema.parse({ ...bundle.output, assertions: bundle.output.assertions.map(assertion => ({ ...assertion, financialRole: 'approval' })) });
    const receipts = await syntheticAssessmentTriplet(bundle.item, wrong, fixture.context), final = await reconcile(bundle.item, receipts, fixture.context);
    const artifacts = await Promise.all([receipts.A, receipts.B, receipts.C, final].map(value => fixture.context.cas.put(Buffer.from(canonicalJson(value)), { kind: 'receipt', mimeType: 'application/json' })));
    const inventory = { records: [{ ...bundle.entry, AArtifactSha256: artifacts[0].sha256, BArtifactSha256: artifacts[1].sha256,
      CArtifactSha256: artifacts[2].sha256, finalArtifactSha256: artifacts[3].sha256 }] };
    const rejected = await admitCriticalKnowledge([record], inventory, fixture.context.cas, { policyOptions: fixture.context.policyOptions });
    assert.deepEqual(rejected.admissions, []); assert.equal(rejected.holds[0].reason, 'critical_assessment_binding');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
test('bare budget approval source cannot become actual expenditure even when all synthetic assessors agree', async () => {
  const original = 'Strausberg hat einen Planansatz von 100 EUR bewilligt.';
  const fixture = await admittedAssessmentFixture(original);
  try {
    const record = modelRecord(fixture, 'Strausberg hat 100 EUR ausgegeben.');
    record.summaryQuote = original; record.verification.evidenceHash = knowledgeEvidenceHash(record);
    const bundle = await reviewedBundle(fixture, record);
    const result = await admitCriticalKnowledge([record], bundle.inventory, fixture.context.cas, { policyOptions: fixture.context.policyOptions });
    assert.deepEqual(result.admissions, []); assert.equal(result.holds[0].reason, 'critical_assessment_binding');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
test('native coded actual-payment verification stays structured and never receives fake model assessment', async () => {
  const text = 'Synthetic native source row: amount=100 EUR.';
  const fixture = await admittedAssessmentFixture(text);
  try {
    const native = observation({ publisherId: 'fixture', sourceId: 'source1', nativeId: 'payment-1', nativeVersion: null,
      kind: 'PaymentObservation', subject: 'Synthetic payment', predicate: 'paid_amount', value: 100, unit: 'EUR',
      date: '2025-02-28', dateRole: 'payment', financialRole: 'payment', geography: { ags: '12064472', basis: 'source_explicit', role: 'administrative_area' },
      sourceReferenceDate: '2025-02-28', publishedAt: null, retrievedAt: '2026-10-11T00:00:00.000Z',
      evidence: [{ sourceSha256: fixture.source.originalSha256, format: 'csv', nativeId: 'payment-1', path: '/amount',
        sheet: null, rowKey: 'payment-1', cells: ['amount'], rawValue: '100', schemaHash: digest, mappingVersion: 'synthetic-native-v1' }],
      limitations: ['Synthetic deterministic source-field fixture; no claim of independent truth.'] });
    const records = await admitStructuredObservations({ adapter: { id: 'synthetic-native', version: 'synthetic-native-v1' },
      adapterContractSha256: digest, snapshot: { bytes: Buffer.from(text), sourceSha256: fixture.source.originalSha256,
        url: fixture.policy.source.url, mimeType: 'text/plain', retrievedAt: '2026-10-11T00:00:00.000Z', policyReceiptSha256: fixture.source.admissionReceiptSha256, sourceVersion: null },
      scope: fixture.policy.scope, districtId: 'maerkisch-oderland', candidates: [native],
      checkCurrentPolicy: async () => ({ allowed: true, receiptSha256: fixture.source.admissionReceiptSha256, sourceSha256: fixture.source.originalSha256,
        scopeSha256: semanticHash(fixture.policy.scope), checkedAt: new Date().toISOString() }),
      replayInSandbox: async () => ({ observations: [native], coverage: { state: 'complete', scope: 'synthetic fixture', reason: 'Exact synthetic field replay.',
        checkedAt: '2026-10-11T00:00:00.000Z', nextCursor: null, observedRows: 1, limitations: [] } }) });
    const before = canonicalJson(records);
    assert.equal(criticalKnowledgeTarget(records[0]), null);
    const result = await admitCriticalKnowledge(records, { records: [] }, fixture.context.cas, { policyOptions: fixture.context.policyOptions });
    assert.deepEqual(result.admissions, []); assert.deepEqual(result.holds, []);
    assert.equal(records[0].verification.kind, 'structured'); assert.equal('faithfulness' in records[0].verification, false);
    assert.equal(canonicalJson(records), before);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
