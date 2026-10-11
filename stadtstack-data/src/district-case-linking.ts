import { z } from 'zod';
import { HashSchema, semanticHash, canonicalJson } from './district-adapter-contract.ts';
import { EffectiveIntervalSchema, identityDaySchema, intervalContains, normalizeIdentityValue } from './district-entity-resolution.ts';

export const CASE_LINKING_VERSION = 'district-case-linking-v1';
export const CaseReferenceSchema = z.object({
  kind: z.enum(['diplan', 'bobsh', 'uvp', 'wfs', 'paper_reference', 'plan_number', 'funding_operation', 'procurement_procedure', 'financial_measure']),
  namespace: z.string().min(1), issuer: z.string().min(1), municipalityId: z.string().min(1), tenant: z.string().min(1).nullable(),
  value: z.string().min(1), version: z.string().min(1).nullable(), planType: z.string().min(1).nullable(),
  period: z.string().min(1).nullable(), evidenceHashes: z.array(HashSchema).min(1),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'plan_number' && (!value.planType || !value.version)) ctx.addIssue({ code: 'custom', message: 'Plan number identity requires plan type and explicit amendment/version' });
  if (value.kind === 'paper_reference' && !value.version) ctx.addIssue({ code: 'custom', message: 'Council event identity requires documented year/version' });
  if (value.kind === 'financial_measure' && (!value.period || !value.version)) ctx.addIssue({ code: 'custom', message: 'Financial measure requires fiscal period and plan version' });
});
export type CaseReference = z.infer<typeof CaseReferenceSchema>;
export const CaseIdentitySchema = z.object({
  id: z.string().regex(/^(?:case|event|document-bucket):[a-f0-9]{64}$/),
  kind: z.enum(['procedure', 'event', 'document_bucket']), countedProject: z.literal(false),
  reference: CaseReferenceSchema.nullable(), municipalityId: z.string().min(1), sourceSha256: HashSchema.nullable(),
  ruleVersion: z.literal(CASE_LINKING_VERSION),
}).strict();
export type CaseIdentity = z.infer<typeof CaseIdentitySchema>;
/** A procedure ID identifies a procedure, not proof of an enduring physical project. */
export function caseIdentity(input: { reference: CaseReference | null; municipalityId: string; sourceSha256: string }): CaseIdentity {
  HashSchema.parse(input.sourceSha256);
  if (!input.reference) return CaseIdentitySchema.parse({ id: `document-bucket:${semanticHash([input.municipalityId, input.sourceSha256])}`, kind: 'document_bucket', countedProject: false, reference: null, municipalityId: input.municipalityId, sourceSha256: input.sourceSha256, ruleVersion: CASE_LINKING_VERSION });
  const reference = CaseReferenceSchema.parse(input.reference);
  if (reference.municipalityId !== input.municipalityId) throw Error('Case municipality scope mismatch');
  const key = { ...reference, namespace: normalizeIdentityValue(reference.namespace), issuer: normalizeIdentityValue(reference.issuer), value: normalizeIdentityValue(reference.value), evidenceHashes: [] };
  const event = reference.kind === 'paper_reference';
  return CaseIdentitySchema.parse({ id: `${event ? 'event' : 'case'}:${semanticHash(key)}`, kind: event ? 'event' : 'procedure', countedProject: false, reference, municipalityId: input.municipalityId, sourceSha256: null, ruleVersion: CASE_LINKING_VERSION });
}
export const CaseEventSchema = z.object({
  id: z.string().regex(/^event:[a-f0-9]{64}$/), nativeId: z.string().min(1), issuer: z.string().min(1), namespace: z.string().min(1),
  version: z.string().min(1), role: z.enum(['deliberation', 'adoption', 'permit', 'condition', 'award', 'approval', 'payment', 'actual_expenditure', 'commissioning', 'measured_result']),
  date: identityDaySchema, dateEvidenceHashes: z.array(HashSchema).min(1), references: z.array(CaseReferenceSchema),
  participants: z.array(z.object({ entityId: z.string().min(1), role: z.string().min(1), validity: EffectiveIntervalSchema, identityValidity: z.array(EffectiveIntervalSchema) }).strict()),
  evidenceHashes: z.array(HashSchema).min(1),
}).strict();
export type CaseEvent = z.infer<typeof CaseEventSchema>;
export function caseEvent(input: Omit<CaseEvent, 'id'>): CaseEvent {
  return CaseEventSchema.parse({ ...input, id: `event:${semanticHash([input.namespace, input.issuer, input.nativeId, input.version, input.role])}` });
}
/** Explicit references only. Similar titles/amounts/locations never attach an event. */
export function attachCaseEvents(identityInput: CaseIdentity, eventInput: CaseEvent[]) {
  const identity = CaseIdentitySchema.parse(identityInput);
  const events = eventInput.map(value => CaseEventSchema.parse(value));
  const attached: CaseEvent[] = [], unresolved: Array<{ eventId: string; reason: string }> = [];
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.id)) throw Error('Duplicate case event');
    ids.add(event.id);
    if (identity.kind === 'document_bucket' || !event.references.some(reference => caseIdentity({ reference, municipalityId: reference.municipalityId, sourceSha256: event.evidenceHashes[0] }).id === identity.id)) {
      unresolved.push({ eventId: event.id, reason: 'no_explicit_case_reference' }); continue;
    }
    if (event.participants.some(participant => !intervalContains(participant.validity, event.date) || participant.identityValidity.some(validity => !intervalContains(validity, event.date)))) {
      unresolved.push({ eventId: event.id, reason: 'participant_identity_or_role_not_supported_at_event_date' }); continue;
    }
    attached.push(event);
  }
  attached.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { caseId: identity.id, countedProject: false as const, events: attached, unresolved: unresolved.sort((a, b) => a.eventId.localeCompare(b.eventId)), temporalMode: 'chronological_event_dates' as const };
}
/** Equality ignores evidence receipts, but never issuer/tenant/version/period scope. */
export function caseReferenceKey(reference: CaseReference): string {
  const value = CaseReferenceSchema.parse(reference);
  return canonicalJson({ ...value, evidenceHashes: [], value: normalizeIdentityValue(value.value), namespace: normalizeIdentityValue(value.namespace), issuer: normalizeIdentityValue(value.issuer) });
}

export interface TextCaseIdentityInput {
  caseKeyType: 'diplan' | 'bobsh' | 'paper_reference' | 'plan_number' | 'source_document';
  caseKey: string; caseQuote: string | null; municipalityId: string;
  sources: Array<{ id: string; sha256: string }>;
  extraction: { inputSha256: string };
  verification: { evidenceHash: string };
}
/** Deterministic reader projection: retain original claims/provenance; do not relabel model generation. */
export function caseIdentityFromText(record: TextCaseIdentityInput): CaseIdentity {
  const source = record.sources.find(value => value.sha256 === record.extraction.inputSha256);
  const fallback = () => caseIdentity({ reference: null, municipalityId: record.municipalityId, sourceSha256: record.extraction.inputSha256 });
  if (!source || record.caseKeyType === 'source_document' || !record.caseQuote?.includes(record.caseKey)) return fallback();
  let version: string | null = null, planType: string | null = null;
  if (record.caseKeyType === 'paper_reference') {
    version = /(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/u.exec(record.caseKey)?.[1] ?? null;
    if (!version) return fallback();
  }
  if (record.caseKeyType === 'plan_number') {
    planType = /\b(Bebauungsplan|Flächennutzungsplan|B-Plan|F-Plan)\b/u.exec(record.caseQuote)?.[1] ?? null;
    version = /(?:\d+\.\s*Änderung|Urfassung|Originalfassung)/u.exec(record.caseQuote)?.[0] ?? null;
    if (!planType || !version) return fallback();
  }
  const reference: CaseReference = {
    kind: record.caseKeyType, namespace: record.caseKeyType, issuer: source.id,
    municipalityId: record.municipalityId, tenant: null, value: record.caseKey,
    version, planType, period: null, evidenceHashes: [record.verification.evidenceHash],
  };
  return caseIdentity({ reference, municipalityId: record.municipalityId, sourceSha256: record.extraction.inputSha256 });
}
