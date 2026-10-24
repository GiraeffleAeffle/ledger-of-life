/** Presentation only. The server's content-bound publication gate grants this status. */
export interface AutoVerifiedSource {
  status: 'auto-verified';
  meaning: 'Automated checks, not human review or independent truth certification';
  evidenceBasis: 'single-primary-source; no independent corroboration';
  extractorVersion: string;
  assertionHash: string;
  sourceSha256: string;
  evidenceHash: string;
  evaluator: string;
  model: 'codex:gpt-6-luna';
  metric: 'DeepEval FaithfulnessMetric';
  metricVersion: '3.9.9';
  evaluatedAt: string;
  score: number;
  threshold: 0.8;
}
export type SourceVerification = AutoVerifiedSource | { status: 'unverified'; reason: 'Publication checks unavailable or mismatched' };
export type SourceAssertion =
  | { date: string; value: number; unit: 'm'; reference: 'Normalstau' }
  | { year: number; value: number; unit: 'EUR' };
export const REVIEW_LABELS: Readonly<Record<string, string>> = {
  candidate: 'Candidate · not yet checked',
  auto_checked: 'Automatically checked · not reviewed by a person',
  reviewed: 'Human-reviewed',
  rejected: 'Rejected interpretation',
};
export function sourceReviewLabel(reviewState: string, verification?: SourceVerification): string {
  if (verification?.status === 'unverified') return 'Unverified · publication checks unavailable';
  if (reviewState === 'auto_checked' && verification?.status === 'auto-verified') return 'Auto-verified · automated, not human-reviewed';
  return REVIEW_LABELS[reviewState] ?? 'Not yet checked';
}
export function sourceAssertionLabel(assertion?: SourceAssertion): string {
  if (!assertion) return '';
  return assertion.unit === 'm' ? `Measurement date ${assertion.date} · historical, not live`
    : `Budget year ${assertion.year} · planned, not spent`;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export function sourceDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
/** Exact allowlist for durable/public DTOs, not a substitute for the publication gate. */
export function projectAutoVerification(value: unknown): AutoVerifiedSource | null {
  if (!object(value) || value.status !== 'auto-verified' || value.meaning !== 'Automated checks, not human review or independent truth certification' ||
    value.evidenceBasis !== 'single-primary-source; no independent corroboration' || !bounded(value.extractorVersion, 100) ||
    !hash(value.assertionHash) || !hash(value.sourceSha256) || !hash(value.evidenceHash) || !bounded(value.evaluator, 160) ||
    value.model !== 'codex:gpt-6-luna' || value.metric !== 'DeepEval FaithfulnessMetric' || value.metricVersion !== '3.9.9' ||
    !bounded(value.evaluatedAt, 40) || !Number.isFinite(Date.parse(value.evaluatedAt)) || new Date(value.evaluatedAt).toISOString() !== value.evaluatedAt ||
    value.threshold !== 0.8 || typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < value.threshold || value.score > 1) return null;
  return { status: value.status, meaning: value.meaning, evidenceBasis: value.evidenceBasis, extractorVersion: value.extractorVersion,
    assertionHash: value.assertionHash, sourceSha256: value.sourceSha256, evidenceHash: value.evidenceHash,
    evaluator: value.evaluator, model: value.model, metric: value.metric, metricVersion: value.metricVersion,
    evaluatedAt: value.evaluatedAt, score: value.score, threshold: value.threshold };
}
export function projectSourceAssertion(value: unknown): SourceAssertion | null {
  if (!object(value) || typeof value.value !== 'number' || !Number.isFinite(value.value)) return null;
  if (value.unit === 'm' && sourceDate(value.date) && value.reference === 'Normalstau')
    return { date: value.date, value: value.value, unit: value.unit, reference: value.reference };
  if (value.unit === 'EUR' && Number.isSafeInteger(value.year) && Number(value.year) >= 1900 && Number(value.year) <= 9999 && Number.isSafeInteger(value.value) && value.value >= 0)
    return { year: Number(value.year), value: value.value, unit: value.unit };
  return null;
}
