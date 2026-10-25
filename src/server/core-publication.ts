import { createHash } from 'node:crypto';
import { projectAutoVerification, projectSourceAssertion, sourceDate, type AutoVerifiedSource, type SourceAssertion } from '../data/city-source-evidence.ts';
import type { CityCollection } from './city-signals.ts';

export const CORE_FACT_IDS = ['lake:straussee-level-2026-09-14', 'budget:investment-outlays-2025', 'budget:investment-outlays-2026'] as const;
export const isCoreFact = (id: string) => (CORE_FACT_IDS as readonly string[]).includes(id);
export type PublishedSnapshot = { value: unknown; sha256: string };
export type CoreAdmission = Map<string, { verification: AutoVerifiedSource; assertion: SourceAssertion }>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function requireRecord(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error('Invalid core publication object');
  return value;
}
function requireFacts(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== CORE_FACT_IDS.length || value.some((entry) => !object(entry))) throw new Error('Invalid core fact set');
  const records = value as Record<string, unknown>[];
  if (new Set(records.map((entry) => entry.id)).size !== records.length || records.some((entry) => typeof entry.id !== 'string' || !isCoreFact(entry.id))) throw new Error('Unexpected core fact IDs');
  return records;
}
/** Immutable image manifest is the trust root, not a signed upstream certificate.
 * Publication owns PDF re-extraction/judge execution; runtime checks their exact
 * committed bindings before giving a core claim a badge or AI admission. */
export function validateCorePublication(bundleSnapshot: PublishedSnapshot, manifestSnapshot: PublishedSnapshot,
  fullSnapshot: PublishedSnapshot, compactSnapshot: PublishedSnapshot): CoreAdmission {
  const bundle = requireRecord(bundleSnapshot.value), manifest = requireRecord(manifestSnapshot.value);
  const gates = requireRecord(manifest.gates), corpus = requireRecord(manifest.corpus);
  if (bundle.schemaVersion !== 'stadtstack-core-facts-v1' || manifest.schemaVersion !== 'stadtstack-core-release-v1' ||
    bundle.cityId !== 'strausberg' || manifest.cityId !== 'strausberg' || manifest.bundlePath !== 'core/strausberg-facts.json' ||
    !sha(bundleSnapshot.sha256) || manifest.bundleSha256 !== bundleSnapshot.sha256 || !sha(bundle.version) || manifest.bundleVersion !== bundle.version ||
    manifest.extractorVersion !== 'strausberg-core-pdf-v1' || gates.required !== true || gates.deterministic !== 'passed' ||
    gates.faithfulnessThreshold !== 0.8 || gates.model !== 'codex:gpt-6-luna' ||
    corpus.fullPath !== 'cities/strausberg/signals.geojson' || corpus.minPath !== 'cities/strausberg/signals.min.geojson' ||
    !sha(fullSnapshot.sha256) || !sha(compactSnapshot.sha256) || corpus.fullSha256 !== fullSnapshot.sha256 || corpus.minSha256 !== compactSnapshot.sha256)
    throw new Error('Core publication manifest mismatch');
  const facts = requireFacts(bundle.facts), entries = requireFacts(manifest.facts);
  const full = requireRecord(fullSnapshot.value), compact = requireRecord(compactSnapshot.value);
  if (full.type !== 'FeatureCollection' || compact.type !== 'FeatureCollection' || !Array.isArray(full.features) || !Array.isArray(compact.features) || !Array.isArray(manifest.sources)) throw new Error('Invalid core publication corpus');
  const result: CoreAdmission = new Map();
  for (const fact of facts) {
    const id = String(fact.id), entry = entries.find((item) => item.id === id)!;
    const source = requireRecord(fact.source), verification = requireRecord(fact.verification);
    const policy = requireRecord(verification.policy), deterministic = requireRecord(verification.deterministic), judge = requireRecord(verification.faithfulness);
    const assertion = projectSourceAssertion(fact.assertion);
    if (!assertion || !same(assertion, fact.assertion) || typeof fact.statement !== 'string' || !fact.statement || fact.statement.length > 2000 ||
      !sourceDate(source.documentDate) || typeof source.url !== 'string' || typeof source.locator !== 'string' || !source.locator ||
      typeof source.retrievedAt !== 'string' || !Number.isFinite(Date.parse(source.retrievedAt)) || !sha(source.sha256)) throw new Error('Invalid core assertion/source');
    const url = new URL(source.url);
    if (url.origin !== 'https://www.stadt-strausberg.de' || url.username || url.password || url.hash || url.search || !url.pathname.endsWith('.pdf')) throw new Error('Unexpected core primary source');
    const water = assertion.unit === 'm';
    if (water ? fact.topic !== 'water' || id !== `lake:straussee-level-${assertion.date}` : fact.topic !== 'budget' || id !== `budget:investment-outlays-${assertion.year}`) throw new Error('Core assertion identity mismatch');
    if (verification.status !== 'auto-verified' || verification.meaning !== 'Passed named automated gates; not human review or independent truth certification.' ||
      verification.evidenceBasis !== 'single-primary-source; no independent corroboration' || verification.extractorVersion !== manifest.extractorVersion ||
      deterministic.passed !== true || !Array.isArray(deterministic.checks) || !deterministic.checks.length || deterministic.checks.some((check) => typeof check !== 'string' || !check) ||
      policy.metric !== 'DeepEval FaithfulnessMetric' || policy.metricVersion !== '3.9.9' || policy.penalizeAmbiguousClaims !== true || policy.threshold !== 0.8 || policy.model !== gates.model ||
      judge.actual !== true || judge.model !== gates.model || judge.threshold !== 0.8 || typeof judge.reason !== 'string' || !judge.reason || !sha(judge.contextHash)) throw new Error('Core automated gate mismatch');
    const assertionHash = digest(JSON.stringify({ id, statement: fact.statement, assertion }));
    const version = digest(JSON.stringify({ assertionHash, sourceSha256: source.sha256, extractorVersion: verification.extractorVersion }));
    const evidenceHash = digest(JSON.stringify({ score: judge.score, threshold: judge.threshold, reason: judge.reason, evaluator: judge.evaluator,
      model: judge.model, actual: judge.actual, evaluatedAt: judge.evaluatedAt, statementHash: judge.statementHash, contextHash: judge.contextHash }));
    if (verification.assertionHash !== assertionHash || verification.sourceSha256 !== source.sha256 || fact.version !== version ||
      judge.statementHash !== digest(fact.statement) || judge.evidenceHash !== evidenceHash || entry.version !== version ||
      entry.assertionHash !== assertionHash || entry.sourceSha256 !== source.sha256 || entry.evidenceHash !== evidenceHash ||
      !manifest.sources.some((item) => object(item) && item.url === source.url && item.sha256 === source.sha256 && item.documentDate === source.documentDate && item.retrievedAt === source.retrievedAt)) throw new Error('Core content binding mismatch');
    const projection = projectAutoVerification({ status: verification.status,
      meaning: 'Automated checks, not human review or independent truth certification', evidenceBasis: verification.evidenceBasis,
      extractorVersion: verification.extractorVersion, assertionHash, sourceSha256: source.sha256, evidenceHash,
      evaluator: judge.evaluator, model: judge.model, metric: policy.metric, metricVersion: policy.metricVersion,
      evaluatedAt: judge.evaluatedAt, score: judge.score, threshold: judge.threshold });
    if (!projection) throw new Error('Invalid public verification receipt');
    for (const collection of [full, compact]) {
      const matches = (collection.features as unknown[]).filter((feature) => object(feature) && object(feature.properties) && feature.properties.id === id);
      if (matches.length !== 1) throw new Error('Core signal missing or duplicated');
      const p = requireRecord(requireRecord(matches[0]).properties);
      if (p.cityId !== 'strausberg' || p.version !== version || p.statement !== fact.statement || p.reviewState !== 'auto_checked' || p.asOf !== source.documentDate ||
        p.kind !== (water ? 'measurement' : 'budget') || !same(p.assertion, assertion) || !same(p.verification, verification) ||
        p.startDate !== (water ? assertion.date : `${assertion.year}-01-01`) || p.endDate !== (water ? assertion.date : `${assertion.year}-12-31`)) throw new Error('Core signal semantics mismatch');
      if (collection === full) {
        if (!Array.isArray(p.sources) || p.sources.length !== 1 || !object(p.sources[0]) || p.sources[0].url !== source.url || p.sources[0].sha256 !== source.sha256 || p.sources[0].locator !== source.locator ||
          !Array.isArray(p.unknowns) || !p.unknowns.length || p.unknowns.some((item) => typeof item !== 'string')) throw new Error('Core source/caveat mismatch');
      }
    }
    result.set(id, { verification: projection, assertion });
  }
  if (bundle.version !== digest(JSON.stringify(facts.map((fact) => ({ id: fact.id, version: fact.version }))))) throw new Error('Core bundle version mismatch');
  return result;
}
/** Strip raw pipeline receipts; only admitted presentation metadata reaches clients. */
export function projectCorePublication(collection: CityCollection, admission: CoreAdmission): CityCollection {
  return { ...collection, features: collection.features.map((feature) => {
    const p = feature.properties;
    if (!isCoreFact(p.id) && !p.verification && !p.assertion) return feature;
    const projected = { ...feature };
    projected.properties = { ...p };
    delete projected.properties.verification;
    delete projected.properties.assertion;
    const verified = admission.get(p.id);
    if (verified) {
      projected.properties.verification = verified.verification;
      projected.properties.assertion = verified.assertion;
    } else if (isCoreFact(p.id)) {
      projected.properties.verification = { status: 'unverified', reason: 'Publication checks unavailable or mismatched' };
    }
    return projected;
  }) };
}
