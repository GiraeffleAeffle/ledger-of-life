import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getTopic } from './topic-vocabulary.ts';

export const KNOWLEDGE_SCHEMA_VERSION = 'stadtstack-knowledge-v1';
export const FAITHFULNESS_THRESHOLD = 0.8;
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const QUOTE_NORMALIZATION_VERSION = 'whitespace-spans-v1';
export const QuoteNormalizationSchema = z.object({
  version: z.literal(QUOTE_NORMALIZATION_VERSION), offsetUnit: z.literal('utf16_code_units'),
  restorations: z.array(z.object({
    field: z.string().regex(/^(?:titleQuote|summaryQuote|municipalityQuote|caseQuote|documentDateQuote|stageDateQuote|stageQuote|originalStatus|(?:topics|entities|locations)\[\d+\]\.quote|stages\[\d+\]\.(?:quote|dateQuote|originalStatus))$/),
    proposedSha256: hashSchema, restoredSha256: hashSchema,
    start: z.number().int().nonnegative(), end: z.number().int().positive(),
  }).strict()).max(160),
  displayFields: z.array(z.string()).max(60),
}).strict();
export type QuoteNormalization = z.infer<typeof QuoteNormalizationSchema>;
export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
const quote = z.string().min(1).max(1800);
const coordinate = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const geometry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: coordinate }).strict(),
  z.object({ type: z.literal('LineString'), coordinates: z.array(coordinate).min(2).max(200) }).strict(),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(coordinate).min(4).max(200)).min(1).max(10) }).strict(),
]);
export const stageSchema = z.enum(['motion', 'draft', 'consultation', 'decision', 'adopted', 'in_force', 'implemented', 'rejected', 'withdrawn', 'unknown']);
export const caseKeyTypeSchema = z.enum(['diplan', 'bobsh', 'paper_reference', 'plan_number', 'source_document']);
export const sourceTypeSchema = z.enum(['council', 'participation', 'gazette', 'website']);
export const SourceAccessPolicySchema = z.object({
  robots: z.object({ state: z.enum(['allowed', 'blocked', 'unavailable']), url: z.url(), sha256: hashSchema.optional(), checkedAt: z.iso.datetime().optional() }).strict(),
  tdm: z.object({ state: z.enum(['reserved', 'not_reserved', 'not_declared', 'unavailable']), evidence: z.array(z.object({ url: z.url(), locator: z.string(), value: z.string(), sha256: hashSchema.optional(), checkedAt: z.iso.datetime().optional() }).strict()) }).strict(),
  access: z.enum(['public', 'authentication', 'captcha', 'paywall']), legalClassification: z.literal('not_assessed'), publication: z.literal('facts_with_attribution_only'),
}).strict();
export function assertSubscriptionSourcePolicy(input: unknown, document?: { mimeType: string; sha256: string; url: string }) {
  const parsed = SourceAccessPolicySchema.safeParse(input);
  if (!parsed.success) throw Error('Source policy evidence missing or invalid; recollect before subscription extraction');
  if (parsed.data.robots.state !== 'allowed' || !['not_reserved', 'not_declared'].includes(parsed.data.tdm.state) || parsed.data.access !== 'public') throw Error('Source policy blocks extraction; ask_municipality');
  if (document && document.mimeType.split(';', 1)[0].trim().toLowerCase() === 'application/pdf') {
    const evidence = parsed.data.tdm.evidence.filter(item => /^PDF\.js \S+ XMP metadata \(pdf-tdm-v2\)$/.test(item.locator) && item.sha256 === document.sha256 && item.url === document.url && Boolean(item.checkedAt));
    if (evidence.some(item => item.value === '1')) throw Error('Source PDF parsed metadata reserves TDM; ask_municipality');
    if (!evidence.some(item => item.value === '0' || item.value === 'no_tdm_reservation_field')) throw Error('Source PDF parsed metadata evidence missing or not byte-bound; recollect before subscription extraction');
  }
  return parsed.data;
}
const stageEventSchema = z.object({
  stage: stageSchema, date: daySchema.nullable(), dateQuote: quote.nullable(),
  originalStatus: quote, quote,
}).strict();
// Only source claims are requested from the model; identity/provenance/gates are constructed by the pipeline.
export const DistrictExtractionClaimsSchema = z.object({
  title: z.string().min(1).max(300), titleQuote: quote,
  summary: z.string().min(1).max(1800), summaryQuote: quote,
  municipalityQuote: quote,
  caseKey: z.string().min(1).max(300).nullable(), caseKeyType: caseKeyTypeSchema,
  caseQuote: quote.nullable(), caseType: z.enum(['planning', 'council_paper', 'consultation', 'budget', 'infrastructure', 'unknown']),
  documentDate: daySchema.nullable(), documentDateQuote: quote.nullable(), documentDateReason: z.string().min(1).max(500).nullable(),
  topics: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), provenance: z.enum(['rule', 'model', 'human']), confidence: z.number().min(0).max(1), quote }).strict()).max(24),
  stage: stageSchema, stageDate: daySchema.nullable(), stageDateQuote: quote.nullable(),
  stageDateReason: z.string().min(1).max(500).nullable(), originalStatus: z.string().max(1800), stageQuote: z.string().max(1800),
  stages: z.array(stageEventSchema).max(20),
  entities: z.array(z.object({ name: z.string().min(1).max(300), type: z.enum(['municipality', 'authority', 'organization', 'place']), quote }).strict()).max(30),
  locations: z.array(z.object({ label: z.string().min(1).max(300), quote, geometry: geometry.nullable(), precision: z.enum(['none', 'approximate', 'exact']) }).strict()).max(20),
}).strict();
export type DistrictExtractionClaims = z.infer<typeof DistrictExtractionClaimsSchema>;
export const deterministicCheckSchema = z.object({ id: z.string().min(1), passed: z.boolean(), reason: z.string().min(1) }).strict();
export const REQUIRED_DETERMINISTIC_CHECKS = ['schema', 'exact_quotes', 'municipality', 'title', 'case_identity', 'document_date', 'stage_date', 'stage', 'stage_history', 'critical_stage_promotion', 'critical_budget_spending', 'topic_hierarchy', 'entity_labels', 'location_labels', 'geometry', 'summary_numbers', 'no_contacts'] as const;
export const DistrictKnowledgeRecordSchema = DistrictExtractionClaimsSchema.extend({
  id: z.string().min(1), municipalityId: z.string().min(1), ags: z.string().regex(/^\d{8}$/), districtId: z.string().min(1),
  caseKey: z.string().min(1),
  sources: z.array(z.object({ id: z.string().min(1), url: z.url(), sha256: hashSchema, retrievedAt: z.iso.datetime(), locator: z.string().min(1), mimeType: z.string().min(1), sourceType: sourceTypeSchema, policy: SourceAccessPolicySchema }).strict()).min(1),
  extraction: z.object({
    extractorVersion: z.string().min(1), extractorSha256: hashSchema, model: z.string().min(1),
    provider: z.literal('openai-subscription'), tool: z.enum(['codex-cli', 'omp-cli']), toolVersion: z.string().min(1),
    modelIdentitySha256: hashSchema, modelIdentityBasis: z.literal('configured-cli-model-and-tool-version'), returnedModel: z.string().min(1).nullable(),
    runtimeWarnings: z.array(z.string().min(1)).optional(),
    quoteNormalization: QuoteNormalizationSchema.optional(),
    promptVersion: z.string().min(1), promptSha256: hashSchema, judgePromptVersion: z.string().min(1), judgePromptSha256: hashSchema,
    inputSha256: hashSchema, textSha256: hashSchema, responseSha256: hashSchema, ocrUsed: z.boolean(), textMethod: z.enum(['pdf_text', 'pdf_ocr', 'html', 'text', 'json', 'xml', 'zip_xml']), documentLimitations: z.array(z.string().min(1)).optional(),
    cacheKey: hashSchema, extractedAt: z.iso.datetime(), chunk: z.object({ index: z.number().int().nonnegative(), count: z.number().int().positive(), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict(),
  }).strict(),
  verification: z.object({
    status: z.enum(['candidate', 'auto-verified']), deterministic: z.object({ passed: z.boolean(), checks: z.array(deterministicCheckSchema).min(1) }).strict(),
    faithfulness: z.object({ score: z.number().min(0).max(1).nullable(), threshold: z.literal(0.8), model: z.string().min(1), provider: z.literal('openai-subscription'), tool: z.enum(['codex-cli', 'omp-cli']), toolVersion: z.string().min(1), modelIdentitySha256: hashSchema, returnedModel: z.string().min(1).nullable(), runtimeWarnings: z.array(z.string().min(1)).optional(), reason: z.string().min(1), evaluatedAt: z.iso.datetime().nullable(), responseSha256: hashSchema.nullable(), sameModel: z.literal(true), limitation: z.literal('Same-model judgment is not independent verification.') }).strict(),
    evidenceHash: hashSchema, reason: z.string().optional(),
  }).strict(),
}).strict().superRefine((record, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  for (const tag of record.topics) if (!getTopic(tag.id) || getTopic(tag.id)!.parentId !== tag.parentId) fail(`Unknown topic hierarchy: ${tag.id}`);
  if (new Set(record.topics.map(tag => tag.id)).size !== record.topics.length) fail('Duplicate topic');
  if (record.documentDate === null && !record.documentDateReason) fail('Missing document date needs reason');
  if (record.stageDate === null && !record.stageDateReason) fail('Missing stage date needs reason');
  if (record.documentDate !== null && !record.documentDateQuote) fail('Document date needs quotation');
  if (record.stageDate !== null && !record.stageDateQuote) fail('Stage date needs quotation');
  if (record.stage !== 'unknown' && (!record.stageQuote || !record.originalStatus)) fail('Known stage needs quotation');
  for (const location of record.locations) if ((location.geometry === null) !== (location.precision === 'none')) fail('Geometry/precision mismatch');
  for (const event of record.stages) if (event.date !== null && !event.dateQuote) fail('Stage history date needs quotation');
  if (record.verification.deterministic.passed !== record.verification.deterministic.checks.every(check => check.passed)) fail('Deterministic gate mismatch');
  if (!REQUIRED_DETERMINISTIC_CHECKS.every(id => record.verification.deterministic.checks.some(check => check.id === id))) fail('Required deterministic evidence missing');
  if (new Set(record.verification.deterministic.checks.map(check => check.id)).size !== record.verification.deterministic.checks.length) fail('Duplicate deterministic evidence');
  if (record.extraction.model !== record.verification.faithfulness.model || record.extraction.modelIdentitySha256 !== record.verification.faithfulness.modelIdentitySha256 || record.extraction.tool !== record.verification.faithfulness.tool || record.extraction.toolVersion !== record.verification.faithfulness.toolVersion) fail('Same-model judge identity mismatch');
  if (record.caseKeyType === 'source_document' && record.caseKey !== `source_document:${record.extraction.inputSha256}`) fail('Source-document fallback identity mismatch');
  if (record.extraction.chunk.index >= record.extraction.chunk.count || record.extraction.chunk.start >= record.extraction.chunk.end) fail('Invalid text chunk locator');
  for (const restoration of record.extraction.quoteNormalization?.restorations ?? []) {
    if (restoration.start < record.extraction.chunk.start || restoration.end > record.extraction.chunk.end || restoration.start >= restoration.end) fail('Quote restoration locator escapes source chunk');
    let value: unknown = record;
    for (const part of restoration.field.replace(/\[(\d+)\]/g, '.$1').split('.')) value = value !== null && typeof value === 'object' && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
    if (typeof value !== 'string' || sha256(value) !== restoration.restoredSha256) fail('Quote restoration hash does not bind restored source text');
  }
  if (record.verification.status === 'auto-verified' && (!record.verification.deterministic.passed || record.verification.faithfulness.score === null || record.verification.faithfulness.score < FAITHFULNESS_THRESHOLD || !record.verification.faithfulness.evaluatedAt || !record.verification.faithfulness.responseSha256)) fail('Promotion requires actual passing deterministic and model gates');
  if (record.extraction.inputSha256 !== record.sources[0].sha256) fail('Source/extraction hash mismatch');
  for (const source of record.sources) {
    try { assertSubscriptionSourcePolicy(source.policy, source); } catch { fail('Source policy does not permit extraction/publication'); }
  }
  if (record.verification.evidenceHash !== knowledgeEvidenceHash(record)) fail('Verification evidence hash mismatch');
});
export type DistrictKnowledgeRecord = z.infer<typeof DistrictKnowledgeRecordSchema>;
export function knowledgeEvidenceHash(record: { verification: { evidenceHash: string; [key: string]: unknown }; [key: string]: unknown }): string {
  const { verification, ...claims } = record;
  const { evidenceHash: _hash, ...gates } = verification;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return sha256(JSON.stringify(canonical({ ...claims, verification: gates })));
}
export const KnowledgeRecordsSchema = z.object({ schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION), generatedAt: z.iso.datetime(), records: z.array(DistrictKnowledgeRecordSchema) }).strict();
export type KnowledgeRegistryBinding = { municipalities: Array<{ id: string; name: string; ags: string; districtId: string; sources: Array<{ id: string; kind: string; url: string | null; checkState: string }> }> };
export function validateKnowledgeRelease(input: unknown, registry: KnowledgeRegistryBinding): z.infer<typeof KnowledgeRecordsSchema> {
  const parsed = KnowledgeRecordsSchema.parse(input);
  const ids = new Set<string>();
  for (const record of parsed.records) {
    if (ids.has(record.id)) throw Error(`Duplicate knowledge ID: ${record.id}`);
    ids.add(record.id);
    const municipality = registry.municipalities.find(item => item.id === record.municipalityId);
    if (!municipality || municipality.ags !== record.ags || municipality.districtId !== record.districtId) throw Error(`Unbound municipality: ${record.id}`);
    if (record.verification.status !== 'auto-verified') throw Error(`Candidate cannot be published: ${record.id}`);
    for (const source of record.sources) if (!municipality.sources.some(item => item.id === source.id && item.kind === source.sourceType && item.url !== null && item.checkState === 'checked')) throw Error(`Unbound source: ${record.id}`);
  }
  return parsed;
}
