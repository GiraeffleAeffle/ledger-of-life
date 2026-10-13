import { mkdtemp, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DistrictCas, type CasPutOptions } from '../src/district-cas.ts';
import { createPolicyReceipt } from '../src/district-policy-receipt.ts';
import { canonicalJson, digest } from '../src/district-adapter-contract.ts';
import { encodeStepReceipt, unknownReceiptCounts, type StepReceipt } from '../src/district-step-receipt.ts';
import { provisionCivicPolicyAuthority, initializeManagedAcquisitionLane, withManagedSourceWrite, CIVIC_ACQUISITION_DECISION_ID } from '../src/civic-opt-out.ts';
import { z } from 'zod';
import { assessmentOutputSchema, PROMPTS, digest as assessmentDigest, originalEvidence, buildAssessmentPassInput,
  type AssessmentEvidenceContext, type AssessmentItem, type AssessmentOutput, type AssessmentReceipt } from '../src/district-assessment.ts';

// Synthetic licensed bytes and explicit parser receipts; never source data or provider calls.
export async function admittedAssessmentFixture(text: string, managed = false) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'assessment-cas-test-'));
  const cas = new DistrictCas(join(directory, 'cas'), { maxBytes: 1024 * 1024 });
  // Explicit synthetic provisioning follows the canonical opt-out test seam.
  // Production assessment never provisions or substitutes a policy authority.
  const stateDir = join(directory, 'policy');
  const authority = await provisionCivicPolicyAuthority({ stateDir, authorityId: 'fixture:' + randomUUID() });
  const policyOptions = { stateDir, authorityId: authority.authorityId, authoritySha256: authority.authoritySha256 };
  const source = { url: 'https://example.org/assessment-fixture.txt', sha256: digest(text), mimeType: 'text/plain' };
  const now = Date.now(), checkedAt = new Date(now - 1000).toISOString(), expiresAt = new Date(now + 300_000).toISOString();
  const created = await createPolicyReceipt({ source,
    scope: { publisherId: 'fixture', sourceId: 'source1', municipalityId: 'strausberg', ags: '12064472', tenant: null, observationWindow: '2026-10-11' },
    sourcePolicy: { robots: { state: 'allowed', url: 'https://example.org/robots.txt' }, tdm: { state: 'not_declared', evidence: [] }, access: 'public', legalClassification: 'not_assessed', publication: 'facts_with_attribution_only' },
    permission: { kind: 'distribution_licence', distributionUrl: source.url, licenceId: 'synthetic-test-only', termsUrl: 'https://example.org/terms', termsSha256: digest('test terms'), approvalSha256: digest('test approval') },
    checkedAt, expiresAt }, policyOptions);
  if (managed) await initializeManagedAcquisitionLane(cas.root, { ...policyOptions, decisionId: CIVIC_ACQUISITION_DECISION_ID, kind: 'artifacts' });
  const put = async (bytes: Buffer, options: CasPutOptions) => {
    if (!managed) return cas.put(bytes, options);
    const hash = digest(bytes);
    return withManagedSourceWrite(cas.root, [{ kind: 'http_observation', relativePath: `sha256/${hash.slice(0,2)}/${hash}`,
      contentSha256: hash, url: source.url, sourceSha256: source.sha256, observationId: 'synthetic-assessment-fixture',
      receiptSha256: created.receiptSha256, independentAllowed: options.kind === 'source_original' }],
      () => cas.put(bytes, options), policyOptions);
  };
  const policyArtifact = await put(Buffer.from(canonicalJson(created.receipt)), { kind: 'receipt', mimeType: 'application/json' });
  const originalArtifact = await put(Buffer.from(text), { kind: 'source_original', mimeType: 'text/plain', admission: {
    state: 'allowed', sourceSha256: source.sha256, policyProofSha256: policyArtifact.sha256, checkedAt, expiresAt } });
  const step: StepReceipt = { version: 'district-step-receipt-v1', canonicalizationVersion: 'district-json-v1',
    id: randomUUID(), runId: randomUUID(), jobKey: digest('fixture parse'), step: 'parse', lane: 'cpu', sourceId: 'source1', municipalityId: 'strausberg',
    attempt: 1, leaseToken: '1', category: 'development', dependencyReceiptIds: [], enqueuedAt: checkedAt, startedAt: checkedAt, finishedAt: checkedAt,
    queueWaitMs: 0, elapsedMs: null, cpuUserMicros: null, cpuSystemMicros: null, outcome: 'succeeded', reasonCode: 'completed',
    inputHashes: [source.sha256], outputHashes: [source.sha256], policyProofSha256: policyArtifact.sha256, originProofSha256: null,
    versions: { parser: 'fixture-parser-v1' }, cache: { disposition: 'miss', originalGenerationReceiptId: null }, provider: null, counts: unknownReceiptCounts };
  const encoded = encodeStepReceipt(step);
  const parserArtifact = await put(Buffer.from(encoded.bytes), { kind: 'receipt', mimeType: 'application/json' });
  return { directory, authority, context: { cas, policyOptions }, policy: created.receipt, policyArtifact, parserArtifact, originalArtifact,
    originalObjectPath: join(cas.root, originalArtifact.storageKey),
    source: { sourceId: 'source1', originalSha256: source.sha256, textSha256: source.sha256, parserVersion: 'fixture-parser-v1',
      parserReceiptSha256: parserArtifact.sha256, admissionReceiptSha256: policyArtifact.sha256, ocrSuspected: false,
      locators: [{ id: 'page1', page: 1, table: null, start: 0, end: text.length }] } };
}
export function syntheticAssessmentReceipt(item: AssessmentItem, role: 'A' | 'B' | 'C', output: AssessmentOutput,
  request: unknown, dependencies: string[] = []): AssessmentReceipt {
  const identity = { provider: 'anthropic-subscription' as const, tool: 'claude-cli' as const,
    toolVersion: '0.0.0-synthetic-test-only', model: 'claude-haiku-5-5',
    modelIdentityBasis: 'reported-cli-model-and-tool-version' as const };
  const body = { version: 'assessment-receipt-v1' as const, canonicalizationVersion: 'district-json-v1' as const,
    role, itemSha256: assessmentDigest(item),
    requestSha256: assessmentDigest(request), responseSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    outputSha256: assessmentDigest(output), promptSha256: createHash('sha256').update(PROMPTS[role]).digest('hex'),
    schemaSha256: assessmentDigest(z.toJSONSchema(assessmentOutputSchema)), rubricSha256: item.rubricSha256,
    provider: 'anthropic-subscription' as const, requestedModel: 'claude-haiku-5-5', returnedModel: 'claude-haiku-5-5',
    modelEvidence: { ...identity, modelIdentitySha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex') },
    decoding: 'subscription-runtime-pinned' as const,
    startedAt: '2026-10-11T00:00:00Z', finishedAt: '2026-10-11T00:00:01Z', usage: null, actualBilledUsd: null,
    estimatedApiUsd: null, dependencies, output, deterministicIssues: [] };
  return { ...body, receiptSha256: assessmentDigest(body) };
}
export async function syntheticAssessmentTriplet(item: AssessmentItem, output: AssessmentOutput, context: AssessmentEvidenceContext) {
  const evidence = await originalEvidence(item, context);
  const input = buildAssessmentPassInput(item, evidence, 'A');
  const A = syntheticAssessmentReceipt(item, 'A', output, input.data), B = syntheticAssessmentReceipt(item, 'B', output, input.data);
  const reconciliation = buildAssessmentPassInput(item, evidence, 'C', { A, B });
  const C = syntheticAssessmentReceipt(item, 'C', output, reconciliation.data, reconciliation.dependencies);
  return { A, B, C };
}
