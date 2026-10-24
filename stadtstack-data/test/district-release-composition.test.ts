import test from 'node:test';
import assert from 'node:assert/strict';
import { composeDistrictRelease, projectDistrictRecordIdentity, type DistrictReleaseCompositionInput } from '../src/district-release-composition.ts';
import { DistrictKnowledgeRecordSchema, KNOWLEDGE_SCHEMA_VERSION, REQUIRED_DETERMINISTIC_CHECKS, knowledgeEvidenceHash, sha256, type DistrictKnowledgeRecord } from '../src/district-schema.ts';
import { GRAPH_DETERMINISTIC_CHECKS, normalizeGraphClaims } from '../src/district-graph-claims.ts';
import { PROVIDER_CONFIGS, type ExtractorProvider } from '../src/district-model-contract.ts';
import { authenticateTextRunContribution, buildTextRunLineage, type TextLineageArtifact, type TextRunContribution } from '../src/text-run-lineage.ts';
import { dataReleaseId, dataReleaseSchema, type DataRelease } from '../src/data-release.ts';
import { authenticateRetainedKnowledgePublication, RetainedKnowledgeLineageSchema, validateRetainedKnowledgeComposition, type RetainedKnowledgePublicationInput } from '../src/retained-knowledge-lineage.ts';

const now = '2026-10-11T12:00:00.000Z';
const earlier = '2026-10-01T12:00:00.000Z';
const sourceHash = sha256('Synthetic shared document bytes, not actual municipal evidence');
const municipalityId = 'synthetic-town';
const sourceId = 'synthetic-source';

// All records, checks, model identities and receipts below are synthetic test
// fixtures only. No model, judge, policy authority or source request is executed.
function recordFixture(id: string, provider: ExtractorProvider = 'openai-subscription'): DistrictKnowledgeRecord {
  const config = PROVIDER_CONFIGS[provider];
  const modelIdentitySha256 = sha256(`synthetic identity ${provider}`);
  const graph = normalizeGraphClaims({
    entities: [
      { mentionId: 'company', name: 'Synthetische Stadtwerke', type: 'company', quote: 'Synthetische Stadtwerke', identifiers: [] },
      { mentionId: 'facility', name: 'Synthetisches Hallenbad', type: 'facility', quote: 'Synthetisches Hallenbad', identifiers: [] },
    ],
    relations: [{ fromMention: 'company', toMention: 'facility', type: 'operates', quote: 'Synthetische Stadtwerke betreibt Synthetisches Hallenbad.', predicateQuote: 'betreibt', modality: 'asserted', time: null, conditions: null }],
  }, { municipalityId, sourceSha256: sourceHash, ags: '12064001' });
  const record: DistrictKnowledgeRecord = {
    kind:'text_model',id, municipalityId, ags: '12064001', districtId: 'synthetic-district',
    title: 'Synthetic evidence title', titleQuote: 'Synthetic evidence title', summary: 'Synthetic evidence summary', summaryQuote: 'Synthetic evidence summary', municipalityQuote: 'Synthetic town',
    caseKeyType: 'source_document', caseKey: `source_document:${sourceHash}`, caseQuote: null, caseType: 'unknown',
    documentDate: '2026-10-01', documentDateQuote: '2026-10-01', documentDateReason: null,
    stage: 'unknown', stageDate: null, stageDateQuote: null, stageDateReason: 'Synthetic source has no event date', originalStatus: '', stageQuote: '', stages: [], topics: [], locations: [], ...graph,
    sources: [{ id: sourceId, url: 'https://example.org/synthetic-source', sha256: sourceHash, retrievedAt: earlier, locator: 'chars:0-500', mimeType: 'text/plain', sourceType: 'website', policy: { robots: { state: 'allowed', url: 'https://example.org/robots.txt' }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' } }],
    extraction: { extractorVersion: 'synthetic-extractor', extractorSha256: sha256('synthetic-extractor'), model: config.model, provider, tool: config.tool, toolVersion: 'synthetic-tool', modelIdentitySha256, modelIdentityBasis: config.modelIdentityBasis, returnedModel: provider === 'anthropic-subscription' ? config.model : null, runtimeWarnings: ['Synthetic retained runtime warning'], promptVersion: 'synthetic-prompt', promptSha256: sha256('synthetic-prompt'), judgePromptVersion: 'synthetic-judge-prompt', judgePromptSha256: sha256('synthetic-judge-prompt'), inputSha256: sourceHash, textSha256: sha256('synthetic-text'), responseSha256: sha256(`synthetic-response:${id}:${provider}`), ocrUsed: false, textMethod: 'text', cacheKey: sha256(`synthetic-cache:${id}:${provider}`), extractedAt: earlier, chunk: { index: 0, count: 1, start: 0, end: 500 } },
    verification: { kind:'text_model',status: 'auto-verified', deterministic: { passed: true, checks: [...REQUIRED_DETERMINISTIC_CHECKS, ...GRAPH_DETERMINISTIC_CHECKS].map(id => ({ id, passed: true, reason: 'Synthetic fixture check only' })) }, faithfulness: { score: 0.9, threshold: 0.8, model: config.model, provider, tool: config.tool, toolVersion: 'synthetic-tool', modelIdentitySha256, returnedModel: provider === 'anthropic-subscription' ? config.model : null, reason: 'Synthetic fixture only, not an actual judgment', evaluatedAt: earlier, responseSha256: sha256(`synthetic-judge:${id}:${provider}`), sameModel: true, limitation: 'Same-model judgment is not independent verification.' }, evidenceHash: '' },
  };
  record.verification.evidenceHash = knowledgeEvidenceHash(record);
  return DistrictKnowledgeRecordSchema.parse(record);
}
function legacyIdentity(record: DistrictKnowledgeRecord): DistrictKnowledgeRecord {
  const legacy = structuredClone(record);
  for (const entity of legacy.entities) {
    const key = JSON.stringify([entity.type, entity.name.toLocaleLowerCase('de'), legacy.municipalityId]);
    entity.entityId = `entity:${sha256(key)}`;
    entity.identityBasis.key = key;
  }
  for (const relation of legacy.relations) {
    relation.fromId = legacy.entities.find(entity => entity.mentionId === relation.fromMention)!.entityId;
    relation.toId = legacy.entities.find(entity => entity.mentionId === relation.toMention)!.entityId;
  }
  legacy.verification.evidenceHash = knowledgeEvidenceHash(legacy);
  return legacy;
}
function artifact(value: unknown): TextLineageArtifact {
  const bytes = JSON.stringify(value);
  return { bytes, sha256: sha256(bytes) };
}
type FixtureCase = { municipalityId: string; sourceId: string; sourceSha256: string; reason: string; candidate?: DistrictKnowledgeRecord };
function runFixture(label: string, records: DistrictKnowledgeRecord[], options: {
  assignmentMode?: 'balanced' | 'codex-only'; generatedAt?: string; cases?: FixtureCase[];
  documents?: Array<{ id: string; municipalityId: string; sourceId: string; sha256: string; url?: string; retrievedAt?: string }>;
  checks?: Array<Record<string, unknown>>; includePlan?: boolean;
} = {}): TextRunContribution {
  const cases = options.cases ?? [];
  const documents = options.documents ?? [{ id: 'synthetic-document', municipalityId, sourceId, sha256: sourceHash, url: 'https://example.org/synthetic-source', retrievedAt: options.generatedAt ?? now }];
  const available = new Set(documents.map(document => document.sha256)).size;
  const attempted = new Set([...records.map(record => record.extraction.inputSha256), ...cases.map(item => item.sourceSha256)]).size;
  const crawl = artifact({ schemaVersion: 'stadtstack-crawl-index-v1', generatedAt: options.generatedAt ?? now, documents, checks: options.checks ?? [{ municipalityId, sourceId, checkState: 'checked', checkedAt: earlier, documentCount: documents.length, coverage: { state: 'partial', pendingCount: 7, runnableCount: 5, blockedCount: 2, scope: 'Configured source endpoint' } }], excludedDocuments: [{ id: `excluded-${label}`, municipalityId, sourceId, reason: 'Synthetic excluded observation' }] });
  const registry = artifact({ municipalities: [{ id: municipalityId, sources: [...new Set([sourceId, ...documents.map(document => document.sourceId)])].map(id => ({ id })) }] });
  const pins = { corpusSha256: crawl.sha256, registrySha256: registry.sha256, promptContractSha256: sha256('synthetic-contract'), schemaSha256: sha256('synthetic-schema') };
  const municipalities = [{ id: municipalityId, selectedDocumentGroups: available, preparedDocumentGroups: available, attemptedDocumentGroups: attempted }];
  const extractionRun = artifact({ schemaVersion: 'stadtstack-extraction-run-v2', generatedAt: options.generatedAt ?? now, assignmentMode: options.assignmentMode ?? 'codex-only', ...pins, scope: 'all_fetched_documents', maxDocumentsPerMunicipality: null, availableDocumentGroups: available, attemptedDocumentGroups: attempted, pendingDocumentGroups: available - attempted, municipalities, fixtureLabel: label });
  const preparationPlan = artifact({ schemaVersion: 'stadtstack-preparation-plan-v1', ...pins, maxDocumentsPerMunicipality: null, availableDocumentGroups: available, selectedDocumentGroups: available, municipalities, groups: [...new Set(documents.map(document => document.sha256))].map(sourceSha256 => ({ expected: { municipalityId, sourceSha256 } })), quarantine: [] });
  return { runId: extractionRun.sha256, sourceArtifactKind: 'native_extraction_output', pins, artifacts: { extractionRun, records: artifact({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: options.generatedAt ?? now, records, identityAssertions: [], identityAdmissions: [] }), quarantine: artifact({ schemaVersion: 'stadtstack-quarantine-v1', generatedAt: options.generatedAt ?? now, cases }), crawl, registry, ...(options.includePlan === false ? {} : { preparationPlan }) } };
}
function compositionInput(contributions: TextRunContribution[], admittedIds: string[][]): DistrictReleaseCompositionInput {
  return { contributions, approvedRunOrder: contributions.map(run => run.runId), admissions: contributions.map((run, index) => ({ runId: run.runId, recordIds: admittedIds[index] })), generatedAt: now };
}

function unchangedEvidence(record: DistrictKnowledgeRecord) {
  const { evidenceHash: _hash, ...verification } = record.verification;
  return { ...record, verification, entities: record.entities.map(({ entityId: _id, identityBasis: _basis, ...claim }) => claim), relations: record.relations.map(({ fromId: _from, toId: _to, ...claim }) => claim) };
}

test('mixed genuine-shape legacy/current runs project only graph identities and keep original generation receipts', () => {
  const legacy = legacyIdentity(recordFixture('historical-haiku', 'anthropic-subscription'));
  const oldCodex = recordFixture('historical-codex');
  const current = recordFixture('current-codex');
  const original = structuredClone(legacy);
  const historical = runFixture('balanced-history', [legacy, oldCodex], { assignmentMode: 'balanced', generatedAt: earlier });
  const correction = runFixture('codex-correction', [current]);
  const result = composeDistrictRelease(compositionInput([historical, correction], [[legacy.id, oldCodex.id], [current.id]]));
  assert.equal(result.records.records.length, 3);
  const projected = result.records.records.find(record => record.id === legacy.id)!;
  assert.notEqual(projected.verification.evidenceHash, legacy.verification.evidenceHash);
  assert.deepEqual(unchangedEvidence(projected), unchangedEvidence(legacy));
  assert.deepEqual(legacy, original);
  assert.deepEqual(projected.extraction, legacy.extraction);
  assert.deepEqual(projected.verification.faithfulness, legacy.verification.faithfulness);
  assert.deepEqual(projected.sources, legacy.sources);
  assert.equal(projected.relations[0].fromId, projected.entities[0].entityId);
  assert.deepEqual(result.provenance.runs[0].records, [legacy, oldCodex]);
  assert.strictEqual(result.provenance.originalContributions[0], historical);
  assert.ok(result.lineage);
  assert.deepEqual(result.lineage.runs.map(run => run.assignmentMode), ['balanced', 'codex-only']);
  const audit = result.audit.records.find(item => item.recordId === legacy.id)!;
  assert.equal(audit.originalEvidenceHash, legacy.verification.evidenceHash);
  assert.equal(audit.projectedEvidenceHash, projected.verification.evidenceHash);
  assert.equal(audit.selectedRunId, historical.runId);
  for (const secret of [legacy.title, legacy.summary, legacy.relations[0].quote, legacy.sources[0].url, legacy.verification.faithfulness.reason]) assert.equal(JSON.stringify(result.audit).includes(secret), false);
});

test('duplicate record selection follows only the explicitly approved order, not generation or document clocks', () => {
  const first = recordFixture('collision', 'anthropic-subscription');
  const second = recordFixture('collision');
  second.documentDate = '2020-01-01'; second.documentDateQuote = '2020-01-01';
  second.verification.evidenceHash = knowledgeEvidenceHash(second);
  const left = runFixture('first', [first], { assignmentMode: 'balanced', generatedAt: now });
  const right = runFixture('second', [second], { generatedAt: earlier });
  const result = composeDistrictRelease(compositionInput([left, right], [['collision'], ['collision']]));
  assert.deepEqual(result.records.records, [second]);
  assert.deepEqual(result.audit.records.map(item => item.disposition), ['unselected_revision', 'selected']);
  assert.ok(result.lineage);
  assert.equal(result.lineage.selectedRecordOrigins[0].runId, right.runId);
  assert.equal(result.lineage.selectedRecordOrigins[0].outputArtifactSha256, right.artifacts.records.sha256);
  const reversed = composeDistrictRelease(compositionInput([right, left], [['collision'], ['collision']]));
  assert.deepEqual(reversed.records.records, [first]);
  const unapproved = compositionInput([left, right], [['collision'], ['collision']]);
  unapproved.approvedRunOrder = [right.runId, left.runId];
  assert.throws(() => composeDistrictRelease(unapproved), /approved input order/);
  assert.throws(() => composeDistrictRelease(compositionInput([left, left], [['collision'], ['collision']])), /approved input order/);
});

test('failed new candidate retains older admitted evidence and original quarantine/source group provenance', () => {
  const old = recordFixture('carry-forward', 'anthropic-subscription');
  const failed = recordFixture(old.id);
  failed.verification.status = 'candidate';
  failed.verification.faithfulness.score = 0.2;
  failed.verification.reason = 'Synthetic failed candidate';
  failed.verification.evidenceHash = knowledgeEvidenceHash(failed);
  const item: FixtureCase = { municipalityId, sourceId, sourceSha256: sourceHash, reason: 'Synthetic failed candidate', candidate: failed };
  const historical = runFixture('historical', [old], { assignmentMode: 'balanced' });
  const later = runFixture('failed-correction', [], { cases: [item] });
  const result = composeDistrictRelease(compositionInput([historical, later], [[old.id], []]));
  assert.deepEqual(result.records.records, [old]);
  assert.deepEqual(result.quarantine.cases, [item]);
  assert.deepEqual(result.provenance.quarantineOrigins, [{ runId: later.runId, caseIndex: 0, municipalityId, sourceId, sourceSha256: sourceHash, candidateRecordId: old.id, candidateEvidenceHash: failed.verification.evidenceHash }]);
  assert.equal(result.audit.quarantine[0].candidateEvidenceHash, failed.verification.evidenceHash);
  assert.equal(result.audit.quarantine[0].selectedRunId, historical.runId);
  assert.equal(result.audit.quarantine[0].selectedEvidenceHash, old.verification.evidenceHash);
  assert.equal(JSON.stringify(result.audit).includes(item.reason), false);
  assert.ok(result.lineage);
  assert.equal(result.lineage.cumulative.attemptsAcrossRuns, 2);
  assert.equal(result.lineage.cumulative.groups.attemptedDocumentGroups, 1);
  const inOutputs = runFixture('candidate-in-output', [failed]);
  const carried = composeDistrictRelease(compositionInput([historical, inOutputs], [[old.id], []]));
  assert.deepEqual(carried.records.records, [old]);
  assert.equal(carried.audit.records[1].disposition, 'candidate');
  assert.deepEqual(carried.provenance.withheldRecords[0].record, failed);
  assert.throws(() => composeDistrictRelease(compositionInput([inOutputs], [[failed.id]])), /cannot promote/);
});

test('parent admission omissions preserve older revisions, and publication holds cannot be overridden', () => {
  const old = recordFixture('dated');
  const withheld = recordFixture(old.id);
  withheld.documentDate = null; withheld.documentDateQuote = null; withheld.documentDateReason = 'Synthetic undated replacement';
  withheld.verification.evidenceHash = knowledgeEvidenceHash(withheld);
  const first = runFixture('dated-run', [old]);
  const second = runFixture('undated-run', [withheld]);
  const input = compositionInput([first, second], [[old.id], []]);
  const result = composeDistrictRelease(input);
  assert.deepEqual(result.records.records, [old]);
  assert.equal(result.audit.records[1].disposition, 'withheld_by_intake');
  assert.equal(result.audit.records[1].selectedRunId, first.runId);
  assert.throws(() => composeDistrictRelease(compositionInput([first, second], [[old.id], [old.id]])), /publication-withheld/);
  assert.throws(() => composeDistrictRelease({ ...input, admissions: [] }), /Admission inventory/);
  assert.throws(() => composeDistrictRelease(compositionInput([first], [['absent']])), /absent original record/);
  assert.throws(() => composeDistrictRelease(compositionInput([first], [[old.id, old.id]])), /Duplicate record in admission/);
});

test('tampered bytes, original evidence hashes, native judge receipts and purported passing gates fail closed', () => {
  const original = recordFixture('tamper');
  const contribution = runFixture('unaltered', [original]);
  const badBytes = structuredClone(contribution);
  badBytes.artifacts.records.bytes = String(badBytes.artifacts.records.bytes).replace(original.title, 'Tampered title');
  assert.throws(() => composeDistrictRelease(compositionInput([badBytes], [[original.id]])), /artifact hash mismatch/);
  const badHash = structuredClone(original); badHash.summary = 'Tampered summary without original hash';
  assert.throws(() => projectDistrictRecordIdentity(badHash), /Original record evidence hash/);
  assert.throws(() => composeDistrictRelease(compositionInput([runFixture('wrong-hash', [badHash])], [[badHash.id]])), /Original record evidence hash/);
  const badJudge = structuredClone(original); badJudge.verification.faithfulness.modelIdentitySha256 = sha256('different judge'); badJudge.verification.evidenceHash = knowledgeEvidenceHash(badJudge);
  assert.throws(() => composeDistrictRelease(compositionInput([runFixture('wrong-judge', [badJudge])], [[badJudge.id]])), /model\/judge binding/);
  const falseGate = structuredClone(original); falseGate.verification.faithfulness.score = 0.2; falseGate.verification.evidenceHash = knowledgeEvidenceHash(falseGate);
  assert.throws(() => composeDistrictRelease(compositionInput([runFixture('false-gate', [falseGate])], [[falseGate.id]])), /passing deterministic and model gates/);
  const extraClaim = { ...original, unrecognizedClaim: 'Cannot be stripped away during projection' };
  extraClaim.verification = { ...original.verification, evidenceHash: knowledgeEvidenceHash(extraClaim) };
  assert.throws(() => projectDistrictRecordIdentity(extraClaim), /Unrecognized key/);
});

test('overlapping byte groups deduplicate coverage without erasing aliases, observations or broader pending scope', () => {
  const old = recordFixture('old');
  const newer = recordFixture('new');
  const document = { id: 'synthetic-document', municipalityId, sourceId, sha256: sourceHash, url: 'https://example.org/synthetic-source', retrievedAt: earlier };
  const alias = { ...document, id: 'synthetic-alias', sourceId: 'synthetic-alias-source', url: 'https://example.org/synthetic-alias' };
  const broad = { municipalityId, sourceId, checkState: 'checked', checkedAt: earlier, documentCount: 1, coverage: { state: 'partial', pendingCount: 9, runnableCount: 7, blockedCount: 2, scope: 'Configured source endpoint' } };
  const narrow = { municipalityId, sourceId, checkState: 'checked', checkedAt: now, documentCount: 1, coverage: { state: 'complete', pendingCount: 0, runnableCount: 0, blockedCount: 0, scope: 'Explicit registered target page only' } };
  const first = runFixture('broad', [old], { documents: [document], checks: [broad] });
  const second = runFixture('targeted', [newer], { documents: [{ ...document, retrievedAt: now }, alias], checks: [narrow] });
  const result = composeDistrictRelease(compositionInput([first, second], [[old.id], [newer.id]]));
  assert.deepEqual(result.crawl.documents, [document, alias]);
  assert.deepEqual(result.crawl.checks, [{ ...broad, runId: first.runId }, { ...narrow, runId: second.runId }]);
  assert.deepEqual(result.provenance.crawlChecks.map(observation => observation.check), [broad, narrow]);
  assert.equal(result.provenance.crawlDocuments[0].observations.length, 2);
  assert.equal(result.provenance.crawlDocuments[0].observations[1].document.retrievedAt, now);
  assert.equal(result.provenance.crawlExcludedDocuments.length, 2);
  assert.ok(result.lineage);
  assert.equal(result.lineage.cumulative.frontierUnion, 'unknown');
  assert.deepEqual(result.lineage.cumulative.groups, { fetchedDocumentGroups: 1, selectedDocumentGroups: { state: 'exact', count: 1 }, preparedDocumentGroups: { state: 'exact', count: 1 }, attemptedDocumentGroups: 1, pendingFetchedDocumentGroups: 0, unavailableAttemptedDocumentGroups: 0 });
  assert.equal(result.lineage.cumulative.attemptsAcrossRuns, 2);
  assert.deepEqual(result.lineage.runs.map(run => run.attemptedDocumentGroups), [1, 1]);
});

test('different bytes at the same crawl document identity preserve both versions and exact pending groups', () => {
  const record = recordFixture('published');
  const changed = sha256('Synthetic changed source bytes');
  const first = runFixture('old-bytes', [record]);
  const second = runFixture('new-bytes-no-attempt', [], { documents: [{ id: 'synthetic-document', municipalityId, sourceId, sha256: changed, url: 'https://example.org/synthetic-source' }], includePlan: false });
  const result = composeDistrictRelease(compositionInput([first, second], [[record.id], []]));
  assert.equal(result.crawl.documents.length, 2);
  assert.ok(result.lineage);
  assert.equal(result.lineage.cumulative.groups.fetchedDocumentGroups, 2);
  assert.equal(result.lineage.cumulative.groups.attemptedDocumentGroups, 1);
  assert.equal(result.lineage.cumulative.groups.pendingFetchedDocumentGroups, 1);
  assert.deepEqual(result.lineage.cumulative.groups.selectedDocumentGroups, { state: 'unknown', count: null });
  assert.deepEqual(result.records.records, [record]);
});

test('old full-artifact retained contributions remain audit-readable but cannot enter native composition', () => {
  for (const schemaVersion of ['stadtstack-district-coverage-v4', 'stadtstack-district-coverage-v5']) {
    const explicitKinds = schemaVersion.endsWith('v5');
    const haiku = { ...recordFixture('retained-haiku', 'anthropic-subscription'), ...(explicitKinds ? { kind: 'text_model' as const } : {}) };
    const codex = { ...recordFixture('retained-codex'), ...(explicitKinds ? { kind: 'text_model' as const } : {}) };
    if (explicitKinds) {
      Object.assign(haiku.verification, { kind: 'text_model' });
      Object.assign(codex.verification, { kind: 'text_model' });
    }
    haiku.verification.evidenceHash = knowledgeEvidenceHash(haiku);
    codex.verification.evidenceHash = knowledgeEvidenceHash(codex);
    const old = runFixture('retained-old', [haiku], { assignmentMode: 'balanced', generatedAt: earlier });
    const newer = runFixture('retained-new', [codex]);
    if (explicitKinds) {
      old.artifacts.records = artifact({ schemaVersion: 'stadtstack-knowledge-v3', generatedAt: earlier, identityAssertions: [], identityAdmissions: [], records: [haiku] });
      newer.artifacts.records = artifact({ schemaVersion: 'stadtstack-knowledge-v3', generatedAt: now, identityAssertions: [], identityAdmissions: [], records: [codex] });
    }
    const prior = buildTextRunLineage([old, newer], [
      { runId: old.runId, recordId: haiku.id, originalEvidenceHash: haiku.verification.evidenceHash, projectedRecord: haiku },
      { runId: newer.runId, recordId: codex.id, originalEvidenceHash: codex.verification.evidenceHash, projectedRecord: codex },
    ], now);
    const members = explicitKinds ? [{ id: 'opaque-native-row', kind: 'structured' as const, verification: { kind: 'structured' as const } }, codex, haiku] : [codex, haiku];
    const records = artifact({ schemaVersion: explicitKinds ? 'stadtstack-knowledge-v3' : 'stadtstack-knowledge-v2', generatedAt: now, ...(explicitKinds ? { identityAssertions: [], identityAdmissions: [] } : {}), records: members });
    const coverage = artifact({ schemaVersion, generatedAt: now, textLineage: prior, municipalities: [{ id: municipalityId, publishedRecords: members.length }] });
    const files = [
      { path: 'knowledge/records.json' as const, sha256: records.sha256, bytes: Buffer.byteLength(String(records.bytes)) },
      { path: 'knowledge/coverage.json' as const, sha256: coverage.sha256, bytes: Buffer.byteLength(String(coverage.bytes)) },
    ];
    const manifest = artifact({ schemaVersion: 'stadtstack-data-release-v1', id: dataReleaseId(files), generatedAt: now, files, quality: { publishedRecords: members.length, quarantinedRecords: 0, cities: 1 } });
    const contributions: TextRunContribution[] = [old, newer].map(run => ({ ...run, sourceArtifactKind: 'retained_publication', artifacts: { ...run.artifacts, records }, retainedPublication: { manifest, coverage } }));
    if (explicitKinds) {
      assert.deepEqual(authenticateTextRunContribution(contributions[0]).records, [haiku]);
      assert.throws(() => composeDistrictRelease(compositionInput(contributions, [[], [codex.id]])), /authenticated retained-role input/);
      continue;
    }
    assert.deepEqual(authenticateTextRunContribution(contributions[0]).records, [haiku]);
    assert.deepEqual(authenticateTextRunContribution(contributions[1]).records, [codex]);
    assert.throws(() => composeDistrictRelease(compositionInput(contributions, [[], [codex.id]])), /authenticated retained-role input/);
  }
});

test('identity projection rejects foreign record discriminators without stripping or relabelling originals', () => {
  for (const kind of ['structured', 'unknown']) {
    const original = { ...legacyIdentity(recordFixture('foreign-record-kind')), kind };
    original.verification.evidenceHash = knowledgeEvidenceHash(original);
    const unchanged = structuredClone(original);
    assert.throws(() => projectDistrictRecordIdentity(DistrictKnowledgeRecordSchema.parse(original)), /Invalid input/);
    assert.deepEqual(original, unchanged);
  }
});

test('explicit v2-to-v3 schema projection rejects marked v3 inputs without changing authentic bytes', () => {
  const record = legacyIdentity(recordFixture('explicit-schema-projection'));
  const contribution = runFixture('explicit-schema-projection', [record]);
  const input = compositionInput([contribution], [[record.id]]);
  input.admissions[0].schemaProjection = { version: 'knowledge-v2-to-v3-text-model-v1' };
  const unchanged = structuredClone(input);
  assert.throws(() => composeDistrictRelease(input), /requires an unmarked authenticated knowledge-v2 contribution/);
  assert.deepEqual(input, unchanged);
  input.admissions[0].recordIds = [];
  assert.throws(() => composeDistrictRelease(input), /requires an unmarked authenticated knowledge-v2 contribution/);
  Object.assign(input.admissions[0], { schemaProjection: { version: 'unapproved-projection' } });
  assert.throws(() => composeDistrictRelease(input), /knowledge-v2-to-v3-text-model-v1/);
});

test('unmarked v2 originals require explicit projection and retain authentic claims and receipts', () => {
  const marked = legacyIdentity(recordFixture('unmarked-v2-original'));
  const { kind: _kind, verification, ...claims } = marked;
  const { kind: _verificationKind, ...gates } = verification;
  const original = { ...claims, verification: gates };
  original.verification.evidenceHash = knowledgeEvidenceHash(original);
  const contribution = runFixture('unmarked-v2-original', [marked]);
  contribution.artifacts.records = artifact({ schemaVersion: 'stadtstack-knowledge-v2', generatedAt: now, records: [original] });
  const input = compositionInput([contribution], [[original.id]]);
  const authenticBytes = contribution.artifacts.records.bytes;
  assert.throws(() => composeDistrictRelease(input), /"kind"/);
  input.admissions[0].schemaProjection = { version: 'knowledge-v2-to-v3-text-model-v1' };
  const composed = composeDistrictRelease(input);
  const projected = composed.records.records[0];
  assert.equal(projected.kind, 'text_model');
  assert.equal(projected.verification.kind, 'text_model');
  assert.deepEqual(projected.extraction, original.extraction);
  assert.deepEqual(projected.sources, original.sources);
  assert.deepEqual(projected.verification.faithfulness, original.verification.faithfulness);
  assert.equal(projected.summaryQuote, original.summaryQuote);
  assert.equal(composed.audit.records[0].originalEvidenceHash, original.verification.evidenceHash);
  assert.deepEqual(composed.provenance.runs[0].records, [original]);
  assert.equal(contribution.artifacts.records.bytes, authenticBytes);
});

// Sealed v3 shape: the extraction summary has historical pins/counts, NOT a
// run artifact hash, crawl, quarantine, prepared receipts or group identities.
function retainedFixture(records: DistrictKnowledgeRecord[]): RetainedKnowledgePublicationInput {
  const evidence = [{ url: 'https://example.org/identity', locator: 'Synthetic identity', sha256: sha256('identity'), retrievedAt: earlier }];
  const sources = ['website', 'council', 'participation', 'gazette'].map(kind => ({ id: kind === 'website' ? sourceId : `synthetic-${kind}`, kind, url: 'https://example.org/synthetic-source', vendor: 'unknown', checkState: 'checked', checkedAt: earlier, evidence }));
  const registry = artifact({
    schemaVersion: 'stadtstack-source-registry-v1', generatedAt: earlier,
    districts: [{ id: 'synthetic-district', name: 'Synthetic district', ags: '12064', state: 'Synthetic state', inventorySources: evidence, inventoryAsOf: '2026-10-01', inventoryComplete: true }],
    municipalities: [{ id: municipalityId, name: 'Synthetic town', ags: '12064001', districtId: 'synthetic-district', districtAgs: '12064', amt: null, administrativeStatus: 'amtsfrei', administrativeEvidence: evidence, identitySources: evidence, sources, seedDocuments: [{ url: 'https://example.org/synthetic-source', sourceId, title: 'Synthetic seed', documentDate: '2026-10-01', evidence }] }],
    inventory: [{ ags: '12064001', name: 'Synthetic town', districtId: 'synthetic-district', identitySourceUrl: evidence[0].url, pilot: true, sourceCheckState: 'checked', reason: 'Synthetic identity' }], notes: [],
  });
  const histogram = { categories: [], failedDeterministicChecks: [] };
  const models = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const { provider, model, tool, toolVersion, modelIdentitySha256, modelIdentityBasis } = record.extraction;
    const key = JSON.stringify([provider, model, tool, toolVersion, modelIdentitySha256, modelIdentityBasis]);
    const old = models.get(key);
    if (old) old.publishedRecords = Number(old.publishedRecords) + 1;
    else models.set(key, { provider, model, tool, toolVersion, modelIdentitySha256, modelIdentityBasis, publishedRecords: 1, faithfulnessThreshold: 0.8 });
  }
  const coverage = artifact({
    schemaVersion: 'stadtstack-district-coverage-v3', generatedAt: now,
    accounting: { registryMunicipalities: 1, configuredMunicipalities: 1, checkedMunicipalities: 1, runSelectedMunicipalities: 1, preparedMunicipalities: 1, attemptedMunicipalities: 1, publishedMunicipalities: records.length ? 1 : 0, checkedWithoutPublishedMunicipalities: records.length ? 0 : 1, unvisitedMunicipalities: 0 },
    districts: [{ id: 'synthetic-district', ags: '12064', municipalitiesRegistered: 1, municipalitiesConfigured: 1, municipalitiesChecked: 1, municipalitiesAttempted: 1, municipalitiesWithRecords: records.length ? 1 : 0, municipalitiesWithDatedStages: 0, documents: 17, publishedRecords: records.length, quarantinedRecords: 0 }],
    municipalities: [{ id: municipalityId, ags: '12064001', districtId: 'synthetic-district', checked: true, status: records.length ? 'gated_records' : 'checked_no_gated_records', documents: 17, publishedRecords: records.length, datedStagedRecords: 0, quarantinedRecords: 0, quarantineReasons: histogram,
      extraction: { fetchedDocumentGroups: 11, runSelectedDocumentGroups: 7, preparedDocumentGroups: 5, attemptedDocumentGroups: 7, pendingDocumentGroups: 4, unavailableAttemptedDocumentGroups: 0 },
      sources: sources.map(source => ({ sourceId: source.id, kind: source.kind, registryState: 'checked', crawlState: 'checked', checkedAt: earlier, documentCount: source.id === sourceId ? 17 : 0, publishedRecords: source.id === sourceId ? records.length : 0, quarantinedRecords: 0, quarantineReasons: histogram, coverage: { state: 'partial', pendingCount: 2, runnableCount: 1, blockedCount: 1 }, failedLinkCount: 0, failureExamples: [] })),
    }],
    models: [...models.values()],
    extractionRun: { generatedAt: earlier, assignmentMode: 'balanced', corpusSha256: sha256('historical corpus pin, not reacquired'), registrySha256: sha256('historical registry pin differs from published registry'), promptContractSha256: sha256('historical prompt contract'), schemaSha256: sha256('historical schema'), selection: 'bounded_per_municipality', maxDocumentsPerMunicipality: 7, availableDocumentGroupsAtRunStart: 11, attemptedDocumentGroups: 7, pendingDocumentGroupsAtRunStart: 4 },
  });
  const output = artifact({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, generatedAt: now, records, identityAssertions: [], identityAdmissions: [] });
  const files = ([['records', output], ['coverage', coverage], ['registry', registry]] as const).map(([kind, value]) => ({ path: `knowledge/${kind}.json` as const, sha256: value.sha256, bytes: Buffer.byteLength(String(value.bytes)) }));
  const manifest = artifact({ schemaVersion: 'stadtstack-data-release-v1', id: dataReleaseId(files), generatedAt: now, files, quality: { publishedRecords: records.length, quarantinedRecords: 0, cities: 1 } });
  return { artifacts: { manifest, records: output, coverage, registry }, recordIds: records.map(record => record.id) };
}

test('sealed v3 baseline plus native contribution keeps historical receipts separate from real runs', () => {
  const original = legacyIdentity(recordFixture('retained-original', 'anthropic-subscription'));
  const baseline = retainedFixture([original]);
  const native = runFixture('actual-native', [recordFixture('native-record')]);
  const result = composeDistrictRelease({ ...compositionInput([native], [['native-record']]), retainedPublication: baseline });
  assert.equal(result.records.records.length, 2);
  assert.deepEqual(result.lineage!.runs.map(run => run.runId), [native.runId]);
  assert.equal(result.lineage!.cumulative.attemptsAcrossRuns, 1);
  assert.deepEqual(result.selections.map(selection => selection.recordId), ['native-record']);
  const retained = result.records.records.find(record => record.id === original.id)!;
  assert.deepEqual(unchangedEvidence(retained), unchangedEvidence(original));
  assert.deepEqual(retained.extraction, original.extraction);
  assert.deepEqual(retained.verification.faithfulness, original.verification.faithfulness);
  assert.deepEqual(retained.verification.deterministic, original.verification.deterministic);
  const provenance = result.retainedPublication!;
  assert.deepEqual(provenance.baseline.records, [original]);
  assert.equal(provenance.selectedRecordOrigins[0].originalEvidenceHash, original.verification.evidenceHash);
  assert.equal(provenance.selectedRecordOrigins[0].extractedAt, earlier);
  assert.equal(provenance.selectedRecordOrigins[0].evaluatedAt, earlier);
  assert.equal(provenance.baseline.coverage.extractionRun!.attemptedDocumentGroups, 7);
  assert.equal(provenance.selectedRecordOrigins.length, 1);
  validateRetainedKnowledgeComposition(provenance);
  const publicLineage = RetainedKnowledgeLineageSchema.parse({ ...provenance.baseline.lineage, selectedRecordOrigins: provenance.selectedRecordOrigins });
  for (const excluded of [original.title, original.summary, original.sources[0].url, original.verification.faithfulness.reason, 'runId', 'groupBindings']) assert.equal(JSON.stringify(publicLineage).includes(excluded), false);
});

test('retained-only republication requires no model runs, synthetic artifacts or refreshed clocks', () => {
  const original = recordFixture('only-retained');
  const input = { ...compositionInput([], []), retainedPublication: retainedFixture([original]) };
  const result = composeDistrictRelease(input);
  assert.deepEqual(result.records.records, [original]);
  assert.equal(result.lineage, null);
  assert.deepEqual(result.selections, []);
  assert.deepEqual(result.crawl.documents, []);
  assert.deepEqual(result.crawl.checks, []);
  assert.deepEqual(result.quarantine.cases, []);
  assert.deepEqual(result.provenance.runs, []);
  assert.equal(result.retainedPublication!.selectedRecordOrigins.length, 1);
  assert.throws(() => composeDistrictRelease(compositionInput([], [])), /approved input order/);
  input.retainedPublication.schemaProjection = { version: 'knowledge-v2-to-v3-text-model-v1' };
  assert.throws(() => composeDistrictRelease(input), /requires an unmarked authenticated knowledge-v2 publication/);
});

test('only an admitted native same-ID revision replaces a retained baseline selection', () => {
  const original = recordFixture('same-id', 'anthropic-subscription');
  const replacement = recordFixture(original.id);
  const baseline = retainedFixture([original]);
  const native = runFixture('new-revision', [replacement]);
  const kept = composeDistrictRelease({ ...compositionInput([native], [[]]), retainedPublication: baseline });
  assert.deepEqual(kept.records.records, [original]);
  assert.equal(kept.retainedPublication!.selectedRecordOrigins.length, 1);
  assert.deepEqual(kept.lineage!.selectedRecordOrigins, []);
  const revised = composeDistrictRelease({ ...compositionInput([native], [[replacement.id]]), retainedPublication: baseline });
  assert.deepEqual(revised.records.records, [replacement]);
  assert.deepEqual(revised.retainedPublication!.selectedRecordOrigins, []);
  assert.equal(revised.lineage!.selectedRecordOrigins[0].runId, native.runId);
  const failed = structuredClone(replacement);
  failed.verification.status = 'candidate'; failed.verification.faithfulness.score = 0.2; failed.verification.evidenceHash = knowledgeEvidenceHash(failed);
  const candidate = runFixture('failed-revision', [failed]);
  assert.deepEqual(composeDistrictRelease({ ...compositionInput([candidate], [[]]), retainedPublication: baseline }).records.records, [original]);
  assert.throws(() => composeDistrictRelease({ ...compositionInput([candidate], [[failed.id]]), retainedPublication: baseline }), /cannot promote/);
});

test('retained authentication rejects hashes, manifest identity, member sizes, paths and admission tampering', () => {
  const original = recordFixture('sealed');
  const baseline = retainedFixture([original]);
  const changedBytes = structuredClone(baseline); changedBytes.artifacts.records.bytes = String(changedBytes.artifacts.records.bytes) + ' ';
  assert.throws(() => authenticateRetainedKnowledgePublication(changedBytes), /member binding|artifact hash/);
  for (const mutate of [
    (manifest: DataRelease) => { manifest.id = sha256('wrong release ID'); },
    (manifest: DataRelease) => { manifest.files[0].bytes++; manifest.id = dataReleaseId(manifest.files); },
    (manifest: DataRelease) => { manifest.files[0].path = 'knowledge/graph.json'; manifest.id = dataReleaseId(manifest.files); },
    (manifest: DataRelease) => { manifest.files.push(manifest.files[0]); manifest.id = dataReleaseId(manifest.files); },
  ]) {
    const bad = structuredClone(baseline), manifest = dataReleaseSchema.parse(JSON.parse(String(bad.artifacts.manifest.bytes)));
    mutate(manifest); bad.artifacts.manifest = artifact(manifest);
    assert.throws(() => authenticateRetainedKnowledgePublication(bad));
  }
  for (const recordIds of [['absent'], [original.id, original.id]]) assert.throws(() => authenticateRetainedKnowledgePublication({ ...baseline, recordIds }), /unique exact/);
  assert.throws(() => authenticateRetainedKnowledgePublication({ ...baseline, recordIds: [] }), /select at least one original text record/);
  const tampered = structuredClone(original); tampered.summary = 'Changed claim';
  assert.throws(() => authenticateRetainedKnowledgePublication(retainedFixture([tampered])), /evidence hash/);
  const candidate = structuredClone(original); candidate.verification.status = 'candidate'; candidate.verification.evidenceHash = knowledgeEvidenceHash(candidate);
  assert.throws(() => authenticateRetainedKnowledgePublication(retainedFixture([candidate])), /original candidate/);
  const gate = structuredClone(original); gate.verification.faithfulness.score = 0.2; gate.verification.evidenceHash = knowledgeEvidenceHash(gate);
  assert.throws(() => authenticateRetainedKnowledgePublication(retainedFixture([gate])), /passing deterministic and model gates/);
  const unbound = structuredClone(original); unbound.sources[0].id = 'unregistered-source'; unbound.verification.evidenceHash = knowledgeEvidenceHash(unbound);
  assert.throws(() => authenticateRetainedKnowledgePublication(retainedFixture([unbound])), /source\/registry binding/);
});

test('retained coverage boundary rejects changed private originals and selected public metadata', () => {
  const original = recordFixture('authenticated-original');
  const result = composeDistrictRelease({ ...compositionInput([], []), retainedPublication: retainedFixture([original]) });
  const wrongClock = structuredClone(result.retainedPublication!); wrongClock.selectedRecordOrigins[0].evaluatedAt = now;
  assert.throws(() => validateRetainedKnowledgeComposition(wrongClock), /origin mismatch/);
  const wrongRegistry = structuredClone(result.retainedPublication!); wrongRegistry.baseline.registry.municipalities[0].sources[0].url = 'https://different.example.org/';
  assert.throws(() => validateRetainedKnowledgeComposition(wrongRegistry), /private provenance/);
  const wrongCounts = structuredClone(result.retainedPublication!); wrongCounts.baseline.coverage.municipalities[0].publishedRecords++;
  assert.throws(() => validateRetainedKnowledgeComposition(wrongCounts), /private provenance/);
});
