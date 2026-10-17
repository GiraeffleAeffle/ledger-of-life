import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessmentItemSchema, assessmentOutputSchema, AssessmentSourceContextSchema, assessmentEvidenceContext, originalEvidence, assessmentProviderInput, buildAssessmentPassInput, createAssessmentReceipt, deterministicChecks, mismatchReport,
  canonical, reconcile, validateReceipt, verifyPinnedAssessment, writeImmutable, ownerAudit, recordOwnerAudit,
  type AssessmentOutput } from '../src/district-assessment.ts';
import { admittedAssessmentFixture, syntheticAssessmentReceipt as receipt } from './district-assessment.fixture.ts';
import {modelIdentitySha256} from '../src/district-model-contract.ts';
import { recordHostOptOut, CIVIC_ACQUISITION_DECISION_ID } from '../src/civic-opt-out.ts';
import { symlink, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const pinned = 'a'.repeat(64);
const quote = 'Plan 2025: 100 EUR. Beschluss am 28.02.2025.';
const assertion = { claimId: 'claim1', sourceId: 'source1', locatorId: 'page1', quote,
  subjectId: 'town', objectId: 'project', unit: 'EUR', value: '100', date: '2025-02-28', dateRole: 'approval',
  financialRole: 'plan' as const, stage: 'adopted', modality: 'confirmed' as const };
const output: AssessmentOutput = { itemId: 'H01', outcome: 'supported', assertions: [assertion],
  scores: { correctness: 2, sources: 2, usefulness: 1 }, holdReasons: [], rationale: 'Synthetic test fixture, not civic evidence.' };
async function fixture() {
  const admitted = await admittedAssessmentFixture(quote);
  const item = assessmentItemSchema.parse({ version: 'assessment-item-v1', itemId: 'H01', question: 'Plan or actual?', claim: '100 EUR planned',
    rubric: 'Frozen 0–2; abstention usefulness zero.', rubricSha256: hash('Frozen 0–2; abstention usefulness zero.'),
    sources: [admitted.source],
    claimIds: ['claim1'], entityIds: ['town', 'project'], constraints: [assertion], criticalKinds: ['finance'] });
  return { ...admitted, item };
}
test('original bytes, text, rubric and exact UTF-16 locator are mandatory', async () => {
  const { directory, item, context, originalObjectPath, authority, policy } = await fixture();
  try {
    assert.equal(policy.authorityId, authority.authorityId);
    assert.equal(policy.authoritySha256, authority.authoritySha256);
    assert.equal(context.policyOptions.authorityId, authority.authorityId);
    assert.equal(context.policyOptions.authoritySha256, authority.authoritySha256);
    const evidence = await originalEvidence(item, context);
    assert.equal(evidence[0].locators[0].quote, quote);
    assert.deepEqual(deterministicChecks(item, evidence, output), []);
    await writeFile(originalObjectPath, 'changed');
    await assert.rejects(originalEvidence(item, context), /binding/);
    assert.throws(() => assessmentItemSchema.parse({ ...item, predictions: [1] }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('native assessor custody uses closed canonical provenance without fabricating bindings or replacing authority', () => {
  const sourceContext = { root: '/synthetic/approved/model-artifacts', kind: 'artifacts' as const,
    decisionId: CIVIC_ACQUISITION_DECISION_ID, stateDir: '/synthetic/approved/policy',
    authorityId: 'fixture:11111111-1111-4111-8111-111111111111', authoritySha256: pinned,
    bindings: [{ kind: 'http_observation' as const, url: 'https://example.org/source', sourceSha256: hash(quote),
      observationId: 'synthetic-actual-observation', receiptSha256: pinned }] };
  assert.deepEqual(AssessmentSourceContextSchema.parse(sourceContext), sourceContext);
  const context = assessmentEvidenceContext({ sourceContext });
  assert.deepEqual(context.sourceContext, sourceContext);
  assert.deepEqual(context.policyOptions, { stateDir: sourceContext.stateDir, authorityId: sourceContext.authorityId, authoritySha256: pinned });
  assert.throws(() => AssessmentSourceContextSchema.parse({ ...sourceContext, bindings: [{ phase: 'pre-admission',
    url: 'https://example.org/source', sourceSha256: hash(quote) }] }));
  assert.throws(() => AssessmentSourceContextSchema.parse({ ...sourceContext, bindings: [], approved: true }));
  assert.throws(() => AssessmentSourceContextSchema.parse({ ...sourceContext, decisionId: 'another-authorization' }));
  assert.throws(() => assessmentEvidenceContext({ sourceContext, policyStateDir: '/another/policy' }), /policy state differs/);
});
test('blind provider projection omits historical judge/classifier outputs without changing frozen rubric or native uncertainty', async () => {
  const bankBytes = await readFile(new URL('../evaluation/pilot-questions.json', import.meta.url));
  const bank = JSON.parse(bankBytes.toString('utf8'));
  const question = bank.questions.find((q: { id: string }) => q.id === 'H01');
  const historical = JSON.parse(await readFile(new URL('../reports/pilot-value-enhanced.json', import.meta.url), 'utf8'));
  const rubric = historical.method.grading, scientificText = 'Source reports a 95% confidence interval; sampling uncertainty is not causal impact.';
  const locator = { sourceSha256: hash(scientificText), format: 'csv' as const, nativeId: 'measurement-1',
    path: 'rows/1/confidence_level', sheet: null, rowKey: 'measurement-1', cells: ['confidence_level'],
    rawValue: 0.67, schemaHash: pinned, mappingVersion: 'synthetic-source-mapping-v1' };
  const record = { id: 'record:confidence', sourceIds: ['source:score'], statement: scientificText,
    verification: { faithfulness: { score: 0.998765, rationale: 'OLD_JUDGE_SENTINEL' } },
    extraction: { model: 'OLD_MODEL_SENTINEL', confidence: 0.882 },
    modelConfidence: 0.771, topics: [{ id: 'OLD_TOPIC_SENTINEL', confidence: 0.778899 }], category: 'OLD_TOPIC_SENTINEL',
    classifierProbabilities: { relevant: 0.123987 }, targetScore: 'OLD_TARGET_SCORE_SENTINEL',
    relations: [{ subjectId: 'facility', objectId: 'organization', predicate: 'operates',
      quote: 'Synthetic source statement about the candidate relationship.', confidence: 0.811 }],
    observation: { kind: 'statistical_observation', predicate: 'reported_confidence_level', value: 0.67,
      evidence: [locator], limitations: [scientificText] },
    graph: { edges: [{ id: 'edge-1', verification: { judgeScore: 'OLD_GRAPH_JUDGE_SENTINEL' },
      classifier_probabilities: { relevant: 0.941 }, evidence: [locator] }] } };
  const item = assessmentItemSchema.parse({ version: 'assessment-item-v1', itemId: question.id,
    question: question.question, claim: scientificText, rubric, rubricSha256: hash(rubric),
    sources: [], claimIds: ['claim1'], entityIds: ['facility', 'organization'], constraints: [], criticalKinds: [],
    valueTarget: { questionBankSha256: createHash('sha256').update(bankBytes).digest('hex'), releaseId: historical.server.releaseId,
      evidenceSha256: pinned, lane: 'withoutGraph', question, records: { 'record:confidence': record },
      sources: { 'source:score': { id: 'source:score', url: 'https://example.org/scientific-source.csv',
        sha256: locator.sourceSha256, locators: [locator], verification: { verdict: 'OLD_SOURCE_JUDGE_SENTINEL' } } },
      calls: [{ tool: 'get_signal', response: { record } }, { tool: 'get_source', response: {
        id: 'source:score', locators: [locator], judge: { score: 'OLD_CALL_JUDGE_SENTINEL' } } }],
      retrievalComplete: true, graphBounded: false } });
  const evidence = [{ sourceId: 'source:score', admittedSourceId: 'source1', url: 'https://example.org/scientific-source.csv',
    originalSha256: locator.sourceSha256, textSha256: hash(scientificText), parserVersion: 'synthetic-parser',
    parserReceiptSha256: pinned, admissionReceiptSha256: pinned, ocrSuspected: false, text: scientificText,
    locators: [{ id: 'page1', page: 1, table: null, start: 0, end: scientificText.length, quote: scientificText }] }];
  const before = canonical(item.valueTarget), payload = assessmentProviderInput(item, evidence);
  const transmitted = canonical(payload), projected = JSON.parse(transmitted).valueTarget;
  for (const hidden of ['OLD_JUDGE_SENTINEL', 'OLD_MODEL_SENTINEL', 'OLD_TOPIC_SENTINEL', 'OLD_GRAPH_JUDGE_SENTINEL',
    'OLD_SOURCE_JUDGE_SENTINEL', 'OLD_CALL_JUDGE_SENTINEL', 'OLD_TARGET_SCORE_SENTINEL', '0.998765', '0.123987', '0.778899']) {
    assert.equal(transmitted.includes(hidden), false, hidden + ' must not reach a blind assessor');
  }
  assert.equal(projected.projectionVersion, 'assessment-blind-provider-v1');
  assert.equal(projected.fullTargetSha256, hash(before));
  assert.deepEqual(projected.question, question);
  assert.equal(payload.question, question.question); assert.equal(payload.rubric, rubric);
  assert.strictEqual(payload.evidence, evidence);
  assert.equal(projected.records['record:confidence'].statement, scientificText);
  assert.deepEqual(projected.records['record:confidence'].observation.evidence, [locator]);
  assert.deepEqual(projected.records['record:confidence'].observation.limitations, [scientificText]);
  assert.equal(projected.records['record:confidence'].observation.value, 0.67);
  assert.deepEqual(projected.calls[0].response.record.observation.evidence, [locator]);
  assert.deepEqual(projected.sources['source:score'].locators, [locator]);
  assert.equal(projected.records['record:confidence'].relations[0].subjectId, 'facility');
  assert.equal(Object.hasOwn(projected.records['record:confidence'].relations[0], 'confidence'), false);
  assert.equal(Object.hasOwn(projected.records['record:confidence'], 'verification'), false);
  assert.equal(canonical(item.valueTarget), before, 'full immutable target must remain untouched');
});
test('broker pass and receipt helpers preserve validated answer provenance/clocks and reject contaminated A/B input', () => {
  const item = assessmentItemSchema.parse({ version: 'assessment-item-v1', itemId: 'H01', question: 'Plan or actual?',
    claim: 'Synthetic receipt-constructor test only.', rubric: 'Frozen 0–2 fixture rubric.', rubricSha256: hash('Frozen 0–2 fixture rubric.'),
    sources: [{ sourceId: 'source1', originalSha256: hash(quote), textSha256: hash(quote), parserVersion: 'synthetic-parser',
      parserReceiptSha256: pinned, admissionReceiptSha256: pinned, ocrSuspected: false,
      locators: [{ id: 'page1', page: 1, table: null, start: 0, end: quote.length }] }],
    claimIds: ['claim1'], entityIds: ['town', 'project'], constraints: [assertion], criticalKinds: ['finance'] });
  const evidence = [{ sourceId: 'source1', admittedSourceId: 'source1', url: 'https://example.org/fixture',
    originalSha256: hash(quote), textSha256: hash(quote), parserVersion: 'synthetic-parser',
    parserReceiptSha256: pinned, admissionReceiptSha256: pinned, ocrSuspected: false, text: quote,
    locators: [{ id: 'page1', page: 1, table: null, start: 0, end: quote.length, quote }] }];
  const input = buildAssessmentPassInput(item, evidence, 'B');
  const A = receipt(item, 'A', output, input.data);
  const answer = { value: output, responseSha256: hash('Synthetic validated raw CLI response'),
    returnedModel: A.returnedModel, runtimeWarnings: [], evidence: A.modelEvidence,
    requestedModel: A.requestedModel, reportedModels: [A.requestedModel],
    usage: { topLevel: { inputTokens: 17, outputTokens: 23 }, perModel: {}, cliEstimatedApiCostUsd: null } };
  const clocks = { startedAt: '2026-10-11T03:04:05.123Z', finishedAt: '2026-10-11T03:04:06.456Z' };
  const B = createAssessmentReceipt(item, 'B', answer, clocks, evidence);
  assert.equal(B.startedAt, clocks.startedAt); assert.equal(B.finishedAt, clocks.finishedAt);
  assert.equal(B.responseSha256, answer.responseSha256); assert.deepEqual(B.usage, answer.usage);
  assert.equal(B.actualBilledUsd, null); assert.equal(B.estimatedApiUsd, null);
  assert.equal(B.requestSha256, input.requestSha256);
  const thirdInput = buildAssessmentPassInput(item, evidence, 'C', { A, B });
  assert.deepEqual(thirdInput.dependencies, [A.receiptSha256, B.receiptSha256]);
  const C = createAssessmentReceipt(item, 'C', answer, clocks, evidence, thirdInput);
  assert.deepEqual(C.dependencies, thirdInput.dependencies);
  assert.equal(B.providerEncodingVersion,input.providerEncodingVersion);assert.equal(C.providerEncodingVersion,thirdInput.providerEncodingVersion);
  assert.throws(() => buildAssessmentPassInput(item, evidence, 'A', { A, B }), /Blind passes/);
  const contaminated = receipt(item, 'A', output, { ...input.data, targetScore: 2 });
  assert.throws(() => buildAssessmentPassInput(item, evidence, 'C', { A: contaminated, B }), /Blind request/);
  assert.throws(() => createAssessmentReceipt(item, 'B', { ...answer, returnedModel: 'another-model' }, clocks, evidence), /identity/);
  assert.throws(() => createAssessmentReceipt(item, 'B', answer, clocks, evidence, { ...input,
    data: { ...input.data, classifierProbability: 0.99 } }), /input changed/);
  assert.throws(() => createAssessmentReceipt(item, 'B', answer, { ...clocks, finishedAt: '2026-10-11T03:04:04.000Z' }, evidence), /binding/);
  // A different actual transport is not a different logical Haiku model or a
  // rewrite of the already sealed historical Claude receipt.
  const historical = canonical(A);
  const ompIdentity = { provider: 'anthropic-subscription' as const, tool: 'omp-cli' as const,
    toolVersion: '0.0.0-synthetic-omp', model: 'claude-haiku-5-5',
    modelIdentityBasis: 'reported-cli-model-and-tool-version' as const };
  const ompAnswer = { ...answer, evidence: { ...ompIdentity, modelIdentitySha256: modelIdentitySha256(ompIdentity) },
    returnedModel: ompIdentity.model, responseSha256: hash('Synthetic omp completed assistant event, not an invocation') };
  const ompB = createAssessmentReceipt(item, 'B', ompAnswer, clocks, evidence);
  assert.deepEqual(validateReceipt(ompB, item, 'B'), ompB);
  assert.equal(ompB.modelEvidence.tool, 'omp-cli');
  assert.equal(ompB.requestedModel, A.requestedModel);
  assert.equal(ompB.returnedModel, A.returnedModel);
  assert.equal(ompB.responseSha256, ompAnswer.responseSha256);
  assert.notEqual(ompB.modelEvidence.modelIdentitySha256, A.modelEvidence.modelIdentitySha256);
  assert.equal(canonical(A), historical);
  assert.deepEqual(buildAssessmentPassInput(item, evidence, 'C', { A, B: ompB }).dependencies, [A.receiptSha256, ompB.receiptSha256]);
  for (const identityPatch of [{ provider: 'openai-subscription' }, { tool: 'codex-cli' }, { model: 'claude-haiku-4-5' },
    { modelIdentityBasis: 'configured-cli-model-and-tool-version' }, { toolVersion: '0.0.1-synthetic-omp' },
    { modelIdentitySha256: A.modelEvidence.modelIdentitySha256 }]) {
    const { receiptSha256: _receipt, ...body } = ompB;
    const changed = { ...body, modelEvidence: { ...body.modelEvidence, ...identityPatch } };
    assert.throws(() => validateReceipt({ ...changed, receiptSha256: hash(canonical(changed)) }, item, 'B'));
  }
  assert.throws(() => createAssessmentReceipt(item, 'B', { ...ompAnswer, returnedModel: null }, clocks, evidence), /identity/);
  assert.throws(() => createAssessmentReceipt(item, 'B', { ...ompAnswer, reportedModels: [] }, clocks, evidence), /identity/);
  assert.throws(() => createAssessmentReceipt(item, 'B', { ...ompAnswer, requestedModel: 'anthropic/claude-haiku-5-5' }, clocks, evidence), /identity/);
});
test('explicit original-span context is byte-bound and cannot omit an assessed locator', async () => {
  const prefix = 'Unrelated wider context. '.repeat(2000), full = prefix + quote + '\nLater unrelated material.';
  const admitted = await admittedAssessmentFixture(full);
  try {
    const item = assessmentItemSchema.parse({ version: 'assessment-item-v1', itemId: 'H01', question: 'Plan or actual?', claim: '',
      rubric: 'Frozen fixture rubric', rubricSha256: hash('Frozen fixture rubric'), claimIds: ['claim1'], entityIds: [],
      constraints: [], criticalKinds: ['finance'], sources: [{ ...admitted.source,
        locators: [{ id: 'page1', page: 1, table: null, start: prefix.length, end: prefix.length + quote.length }],
        contextSelection: { version: 'original-context-selection-v1',
          spans: [{ start: prefix.length, end: prefix.length + quote.length }],
          limitations: ['Broader sections explicitly omitted; escalate if qualifications cannot be established.'] } }] });
    const evidence = await originalEvidence(item, admitted.context);
    assert.equal(evidence[0].text, null);
    assert.equal(evidence[0].selectedContext?.spans[0].text, quote);
    assert.equal(evidence[0].textSha256, admitted.source.textSha256);
    const bad = assessmentItemSchema.parse({ ...item, sources: [{ ...item.sources[0],
      contextSelection: { ...item.sources[0].contextSelection, spans: [{ start: prefix.length + 1, end: prefix.length + quote.length }] } }] });
    await assert.rejects(originalEvidence(bad, admitted.context), /omits assessed locator/);
  } finally { await rm(admitted.directory, { recursive: true, force: true }); }
});
test('agreement cannot overrule calendar, quotation, unit, endpoints or financial contradictions', async () => {
  const { directory, item, context } = await fixture();
  try {
    const evidence = await originalEvidence(item, context);
    for (const mutation of [{ date: '2025-02-30' }, { date: '9999-99-99' }, { quote: 'invented' },
      { unit: null }, { subjectId: 'project', objectId: 'town' }, { financialRole: 'payment' }, { modality: 'planned' }, { dateRole: 'payment' }]) {
      const changed = assessmentOutputSchema.parse({ ...output, assertions: [{ ...assertion, ...mutation }] });
      assert.ok(deterministicChecks(item, evidence, changed).length > 0);
      assert.deepEqual(mismatchReport(changed, changed), []);
    }
    const abstain = { ...output, outcome: 'abstain' as const };
    assert.ok(deterministicChecks(item, evidence, abstain).includes('abstention_usefulness'));
    evidence[0].ocrSuspected = true;
    assert.ok(deterministicChecks(item, evidence, output).includes('ocr_suspected'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('third pass is mandatory, binds both blind requests, and never creates independent gold', async () => {
  const { directory, item, context } = await fixture();
  try {
    const evidence = await originalEvidence(item, context);
    const request = { itemId: item.itemId, question: item.question, claim: item.claim, rubric: item.rubric, claimIds: item.claimIds, entityIds: item.entityIds, evidence };
    const A = receipt(item, 'A', output, request), B = receipt(item, 'B', output, request);
    const thirdRequest = { ...request, assessments: { A, B }, mismatchReport: { mismatches: [], A: [], B: [] } };
    const C = receipt(item, 'C', output, thirdRequest, [A.receiptSha256, B.receiptSha256]);
    const disposition = await reconcile(item, { A, B, C }, context);
    assert.equal(disposition.disposition, 'ai_reconciled');
    assert.equal(disposition.independentlyValidated, false);
    assert.equal(disposition.correlatedErrorRisk, 'same-model-family');
    const artifacts = await Promise.all([item, A, B, C, disposition].map(value =>
      context.cas.put(Buffer.from(canonical(value)), { kind: 'receipt', mimeType: 'application/json' })));
    const index = { itemArtifactSha256: artifacts[0].sha256, AArtifactSha256: artifacts[1].sha256,
      BArtifactSha256: artifacts[2].sha256, CArtifactSha256: artifacts[3].sha256 };
    const verified = await verifyPinnedAssessment(context.cas, artifacts[4].sha256, index, { policyOptions: context.policyOptions });
    assert.deepEqual(verified.final, disposition);
    await assert.rejects(verifyPinnedAssessment(context.cas, artifacts[4].sha256,
      { ...index, BArtifactSha256: artifacts[1].sha256 }, { policyOptions: context.policyOptions }), /binding/);
    await assert.rejects(reconcile(item, { A, B, C: null }, context));
    assert.throws(() => validateReceipt({ ...A, output: { ...output, scores: { correctness: 2, sources: 2, usefulness: 2 } } }, item, 'A'), /binding/);
    const contaminated = receipt(item, 'A', output, { ...request, targetScore: 2 });
    const C2 = receipt(item, 'C', output, { ...request, assessments: { A: contaminated, B }, mismatchReport: { mismatches: [], A: [], B: [] } }, [contaminated.receiptSha256, B.receiptSha256]);
    await assert.rejects(reconcile(item, { A: contaminated, B, C: C2 }, context), /Blind request/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('immutable private receipts reject overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assessment-receipt-test-'));
  try {
    const path = join(directory, 'receipt.json'); await writeImmutable(path, { pinned });
    await assert.rejects(writeImmutable(path, { pinned: 'changed' }));
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pinned, pinned);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('C cannot override deterministic A/B failures even with clean supported resolution', async () => {
  const { directory, item, context } = await fixture();
  try {
    const evidence = await originalEvidence(item, context);
    const request = { itemId: item.itemId, question: item.question, claim: item.claim, rubric: item.rubric,
      claimIds: item.claimIds, entityIds: item.entityIds, evidence };
    const bad = assessmentOutputSchema.parse({ ...output, assertions: [{ ...assertion, financialRole: 'payment' }] });
    const A = receipt(item, 'A', bad, request), B = receipt(item, 'B', bad, request);
    const issues = deterministicChecks(item, evidence, bad);
    const C = receipt(item, 'C', output, { ...request, assessments: { A, B },
      mismatchReport: { mismatches: [], A: issues, B: issues } }, [A.receiptSha256, B.receiptSha256]);
    const disposition = await reconcile(item, { A, B, C }, context);
    assert.equal(disposition.disposition, 'held');
    assert.equal(disposition.output, null);
    assert.equal(disposition.blocksAffectedAdmission, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('CAS-only manifest rejects secret paths, symlinks, FIFOs, oversized bytes and revoked policy', { timeout: 10_000 }, async () => {
  const admitted = await fixture();
  const { directory, item, context, originalObjectPath } = admitted;
  try {
    for (const pathField of ['originalPath', 'textPath', 'admissible']) {
      assert.throws(() => assessmentItemSchema.parse({ ...item, sources: [{ ...item.sources[0], [pathField]: '/private/secret' }] }));
    }
    await assert.rejects(originalEvidence({ ...item, sources: [{ ...item.sources[0], parserVersion: 'untrusted' }] }, context), /Parser receipt/);
    await unlink(originalObjectPath);
    const secret = join(directory, 'secret'); await writeFile(secret, quote, { mode: 0o600 });
    await symlink(secret, originalObjectPath);
    await assert.rejects(originalEvidence(item, context));
    await unlink(originalObjectPath);
    await promisify(execFile)('/usr/bin/mkfifo', ['-m', '600', originalObjectPath]);
    await assert.rejects(originalEvidence(item, context), /size|type/);
    await unlink(originalObjectPath);
    await writeFile(originalObjectPath, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(originalEvidence(item, context), /size|type/);
    await writeFile(originalObjectPath, quote, { mode: 0o600 });
    await recordHostOptOut({ host: 'example.org', reason: 'rights_holder_objection', reference: 'fixture-revocation' }, context.policyOptions);
    await assert.rejects(originalEvidence(item, context));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('stratified audit is reproducible, probabilistic, limited to eight and does not waive exceptions', () => {
  const risks = ['routine', 'critical_stage', 'critical_finance', 'critical_identity', 'ocr'] as const;
  const frame = Array.from({ length: 50 }, (_, i) => ({ itemId: 'item' + i, evidenceSha256: pinned, risk: risks[i % 5], exception: 'none' as const, exceptionMinutes: 0 }));
  const packet = ownerAudit(frame, 'precommitted-seed');
  assert.deepEqual(packet, ownerAudit([...frame].reverse(), 'precommitted-seed'));
  assert.equal(packet.selected.length, 8);
  assert.ok(packet.selected.some(x => x.risk === 'routine'));
  assert.ok(packet.selected.every(x => x.inclusionProbability > 0 && x.inclusionProbability <= 1));
  assert.equal(packet.withinGate, true); assert.equal(packet.blocksPhaseAcceptance, true);
  const checks = packet.selected.map(x => ({ itemId: x.itemId, evidenceSha256: x.evidenceSha256, minutes: 10, findings: 'Checked original.', reviewer: 'owner', resolved: true }));
  const checked = recordOwnerAudit(frame, 'precommitted-seed', checks);
  assert.equal(checked.blocksPhaseAcceptance, false); assert.equal(checked.independentlyValidatedSet, false);
  assert.equal(recordOwnerAudit(frame, 'precommitted-seed', checks.map(x => ({ ...x, minutes: 20 }))).blocksPhaseAcceptance, true);
  const over = ownerAudit([{ ...frame[0], exception: 'rights', exceptionMinutes: 41 }], 'seed');
  assert.equal(over.withinGate, false); assert.equal(over.exceptions.length, 1);
  assert.throws(() => recordOwnerAudit(frame, 'seed', [{ ...checks[0], evidenceSha256: 'b'.repeat(64) }]), /binding/);
});
test('all frozen question IDs/towns are pinned; W04/B03/K03 remain unaddressed with no admission credit', async () => {
  const bankBytes = await readFile(new URL('../evaluation/pilot-questions.json', import.meta.url));
  const bank = JSON.parse(bankBytes.toString('utf8'));
  const report = JSON.parse(await readFile(new URL('../reports/pilot-question-source-disposition.json', import.meta.url), 'utf8'));
  assert.equal(report.questionBankSha256, createHash('sha256').update(bankBytes).digest('hex'));
  assert.equal(report.rows.length, 30);
  assert.equal(report.frozenBeforeContextImports, true);
  for (const question of bank.questions) {
    const row = report.rows.find((x: { questionId: string }) => x.questionId === question.id);
    assert.equal(row.question, question.question);
    assert.deepEqual(row.towns.map((x: { cityId: string }) => x.cityId), question.cityIds);
    assert.deepEqual(row.requiredEvidenceRoles, question.requires);
    assert.equal(row.sourceCoverageCredit, false);
    assert.ok(row.sourceRoutes.every((x: { admissionReceiptSha256: string | null }) => x.admissionReceiptSha256 === null));
  }
  for (const id of ['W04', 'B03', 'K03']) assert.equal(report.rows.find((x: { questionId: string }) => x.questionId === id).disposition, 'unaddressed');
});
