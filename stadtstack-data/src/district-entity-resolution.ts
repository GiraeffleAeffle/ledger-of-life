import { z } from 'zod';
import { HashSchema, digest, semanticHash, canonicalJson, ObservationSchema, ScopeSchema, type StructuredObservation, type AdapterScope, type StructuredLocator } from './district-adapter-contract.ts';

export const IDENTITY_RULE_VERSION = 'district-identity-v1';
export const identityDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
const sourceMonths: Record<string, string> = { januar: '01', februar: '02', märz: '03', april: '04', mai: '05', juni: '06', juli: '07', august: '08', september: '09', oktober: '10', november: '11', dezember: '12' };
export const SOURCE_CALENDAR_TOKEN = `(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\.\\s*\\d{1,2}\\.\\s*\\d{4}|\\d{1,2}\\.?\\s+(?:${Object.keys(sourceMonths).join('|')})\\s+\\d{4})`;
/** The same complete ISO/numeric/German month formats admitted by the text claim calendar gates. */
export function sourceCalendarDay(token: string): string | null {
  const value = token.normalize('NFC').replace(/\s+/gu, ' ').trim();
  let iso = value;
  const numeric = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/u.exec(value);
  const written = /^(\d{1,2})\.?\s+(\p{L}+)\s+(\d{4})$/u.exec(value);
  if (numeric) iso = `${numeric[3]}-${numeric[2].padStart(2, '0')}-${numeric[1].padStart(2, '0')}`;
  else if (written) {
    const month = written[2].toLocaleLowerCase('de');
    if (!Object.hasOwn(sourceMonths, month)) return null;
    iso = `${written[3]}-${sourceMonths[month]}-${written[1].padStart(2, '0')}`;
  }
  return identityDaySchema.safeParse(iso).success ? iso : null;
}
const sourceBoundToken = `(?:${SOURCE_CALENDAR_TOKEN}|\\d{4}-\\d{2}|\\d{4})`;
const sourceRange = new RegExp(`^(?:(ab|seit|vom|von|nach) )?(${sourceBoundToken}) (bis(?: einschließlich| ausschließlich)?|through|vor) (${sourceBoundToken})$`, 'iu');
const sourceOpen = new RegExp(`^(?:ab|seit) (${sourceBoundToken}) (?:bis auf Weiteres|unbefristet)$`, 'iu');
const sourcePoint = new RegExp(`^(?:(?:am|im Jahr|in) )?(${sourceBoundToken})$`, 'iu');
const sourceEnd = new RegExp(`^(bis(?: einschließlich| ausschließlich)?|vor) (${sourceBoundToken})$`, 'iu');
function sourceBound(value: string, inclusive: boolean): Extract<EffectiveInterval['validFrom'], { kind: 'date' }> {
  const precision = /^\d{4}$/u.test(value) ? 'year' : /^\d{4}-\d{2}$/u.test(value) ? 'month' : 'day';
  const date = precision === 'year' ? `${value}-01-01` : precision === 'month' ? `${value}-01` : sourceCalendarDay(value);
  if (date === null) throw Error('Invalid source calendar date');
  return { kind: 'date', date: identityDaySchema.parse(date), inclusive, precision };
}
/** Coarse bounds constrain applicability only at days guaranteed by every possible boundary date. */
const monthEndDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
function guaranteedBound(value: Extract<EffectiveInterval['validFrom'], { kind: 'date' }>, start: boolean): Extract<EffectiveInterval['validFrom'], { kind: 'date' }> {
  if (value.precision === 'day') return value;
  const year = value.date.slice(0, 4), month = value.precision === 'year' ? start ? '12' : '01' : value.date.slice(5, 7);
  const numericYear = Number(year), numericMonth = Number(month);
  const lastDay = numericMonth === 2 && numericYear % 4 === 0 && (numericYear % 100 !== 0 || numericYear % 400 === 0) ? 29 : monthEndDays[numericMonth - 1];
  const date = `${year}-${month}-${start ? lastDay : '01'}`;
  return { ...value, date, precision: 'day' };
}
const boundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({ kind: z.literal('open') }).strict(),
  z.object({ kind: z.literal('date'), date: identityDaySchema, inclusive: z.boolean(), precision: z.enum(['day', 'month', 'year']) }).strict(),
]);
export const EffectiveIntervalSchema = z.object({
  validFrom: boundSchema, validTo: boundSchema,
  expression: z.string().min(1).nullable(), evidenceHashes: z.array(HashSchema),
}).strict().superRefine((value, ctx) => {
  if ((value.validFrom.kind !== 'unknown' || value.validTo.kind !== 'unknown') && (!value.expression || !value.evidenceHashes.length)) ctx.addIssue({ code: 'custom', message: 'Known temporal bounds require source expression and evidence' });
  if (value.validFrom.kind === 'date' && value.validTo.kind === 'date' && (value.validFrom.date > value.validTo.date || value.validFrom.date === value.validTo.date && (!value.validFrom.inclusive || !value.validTo.inclusive))) ctx.addIssue({ code: 'custom', message: 'Empty or inverted validity interval' });
});
export type EffectiveInterval = z.infer<typeof EffectiveIntervalSchema>;
export function unknownValidity(): EffectiveInterval { return { validFrom: { kind: 'unknown' }, validTo: { kind: 'unknown' }, expression: null, evidenceHashes: [] }; }

/** Exact source expressions only. Absence of an end date never creates an open boundary. */
export function effectiveIntervalFromExpression(expression: string | null, evidenceHashes: string[]): EffectiveInterval {
  if (expression === null) return unknownValidity();
  const comparison = expression.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const range = sourceRange.exec(comparison);
  if (range) return EffectiveIntervalSchema.parse({
    validFrom: sourceBound(range[2], range[1]?.toLocaleLowerCase('de') !== 'nach'),
    validTo: sourceBound(range[4], !['vor', 'bis ausschließlich'].includes(range[3].toLocaleLowerCase('de'))),
    expression, evidenceHashes,
  });
  const expresslyOpen = sourceOpen.exec(comparison);
  if (expresslyOpen) return EffectiveIntervalSchema.parse({
    validFrom: sourceBound(expresslyOpen[1], true), validTo: { kind: 'open' }, expression, evidenceHashes,
  });
  const point = sourcePoint.exec(comparison);
  if (point) return EffectiveIntervalSchema.parse({
    validFrom: sourceBound(point[1], true), validTo: sourceBound(point[1], true), expression, evidenceHashes,
  });
  const ended = sourceEnd.exec(comparison);
  if (ended) return EffectiveIntervalSchema.parse({ validFrom: { kind: 'unknown' }, validTo: sourceBound(ended[2], !['vor', 'bis ausschließlich'].includes(ended[1].toLocaleLowerCase('de'))), expression, evidenceHashes });
  return EffectiveIntervalSchema.parse({ ...unknownValidity(), expression, evidenceHashes });
}
/** Unknown is not infinity; coarse precision only admits days guaranteed to be within the interval. */
export function intervalContains(input: EffectiveInterval, asOf: string): boolean {
  const interval = EffectiveIntervalSchema.parse(input), day = identityDaySchema.parse(asOf);
  if (interval.validFrom.kind === 'unknown' || interval.validTo.kind === 'unknown') return false;
  const from = interval.validFrom.kind === 'date' ? guaranteedBound(interval.validFrom, true) : interval.validFrom;
  const to = interval.validTo.kind === 'date' ? guaranteedBound(interval.validTo, false) : interval.validTo;
  if (from.kind === 'date' && (day < from.date || day === from.date && !from.inclusive)) return false;
  if (to.kind === 'date' && (day > to.date || day === to.date && !to.inclusive)) return false;
  return true;
}

/** Possible overlap is only a conflict diagnostic, never admission of unknown validity. */
export function intervalCouldContain(input: EffectiveInterval, asOf: string): boolean {
  const interval = EffectiveIntervalSchema.parse(input), day = identityDaySchema.parse(asOf);
  const from = interval.validFrom.kind === 'date' ? guaranteedBound(interval.validFrom, false) : interval.validFrom;
  const to = interval.validTo.kind === 'date' ? guaranteedBound(interval.validTo, true) : interval.validTo;
  return !(from.kind === 'date' && (day < from.date || day === from.date && !from.inclusive) || to.kind === 'date' && (day > to.date || day === to.date && !to.inclusive));
}
export function intervalBoundaryRange(bound: EffectiveInterval['validFrom']): { earliest: string; latest: string } | null {
  if (bound.kind !== 'date') return null;
  return { earliest: guaranteedBound(bound, false).date, latest: guaranteedBound(bound, true).date };
}
export function intervalIntersection(inputs: EffectiveInterval[]): EffectiveInterval | null {
  if (!inputs.length) return null;
  const intervals = inputs.map(value => EffectiveIntervalSchema.parse(value));
  if (intervals.some(value => value.validFrom.kind === 'unknown' || value.validTo.kind === 'unknown')) return null;
  let validFrom: EffectiveInterval['validFrom'] = { kind: 'open' }, validTo: EffectiveInterval['validTo'] = { kind: 'open' };
  for (const interval of intervals) {
    const from = interval.validFrom.kind === 'date' ? guaranteedBound(interval.validFrom, true) : interval.validFrom;
    const to = interval.validTo.kind === 'date' ? guaranteedBound(interval.validTo, false) : interval.validTo;
    if (from.kind === 'date' && (validFrom.kind !== 'date' || from.date > validFrom.date || from.date === validFrom.date && !from.inclusive)) validFrom = from;
    if (to.kind === 'date' && (validTo.kind !== 'date' || to.date < validTo.date || to.date === validTo.date && !to.inclusive)) validTo = to;
  }
  if (validFrom.kind === 'date' && validTo.kind === 'date' && (validFrom.date > validTo.date || validFrom.date === validTo.date && (!validFrom.inclusive || !validTo.inclusive))) return null;
  return EffectiveIntervalSchema.parse({ validFrom, validTo, expression: intervals.map(value => value.expression).join(' ∩ '), evidenceHashes: [...new Set(intervals.flatMap(value => value.evidenceHashes))].sort() });
}
export const StrongIdentifierSchema = z.object({ namespace: z.string().min(1), issuer: z.string().min(1), value: z.string().min(1), evidenceHashes: z.array(HashSchema).min(1) }).strict();
export type StrongIdentifier = z.infer<typeof StrongIdentifierSchema>;
/** Only Unicode/whitespace equivalence is universal. Case, punctuation and zeroes remain meaningful. */
export const normalizeIdentityValue = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
const legalFormNames: Record<string, string> = {
  'gmbh & co. kg': 'GmbH & Co. KG', 'ggmbh': 'gGmbH', 'gmbh': 'GmbH', 'ag': 'AG', 'kg': 'KG',
  'ug (haftungsbeschränkt)': 'UG (haftungsbeschränkt)', 'eg': 'eG', 'e. v.': 'e.V.', 'e.v.': 'e.V.', 'aör': 'AöR', 'kdör': 'KdöR', 'kör': 'KöR',
};
/** Only an explicitly written, complete legal-form suffix; brands and abbreviations elsewhere do not qualify. */
export function legalFormFromName(name: string): string | null {
  const match = /(?:^|\s)(GmbH\s*&\s*Co\.\s*KG|gGmbH|GmbH|UG\s*\(haftungsbeschränkt\)|AG|KG|eG|e\.\s*V\.|AöR|KdöR|KöR)\s*$/iu.exec(name);
  if (!match) return null;
  const key = normalizeIdentityValue(match[1]).toLocaleLowerCase('de');
  return Object.hasOwn(legalFormNames, key) ? legalFormNames[key] : null;
}
export function identifierKey(identifier: StrongIdentifier): string {
  return canonicalJson([normalizeIdentityValue(identifier.namespace), normalizeIdentityValue(identifier.issuer), normalizeIdentityValue(identifier.value)]);
}
export const CouncilBodyIdentitySchema = z.object({
  kind: z.literal('ags_scoped_council_body'), key: z.string().min(1), scope: z.string().regex(/^ags:\d{8}$/),
  ambiguity: z.literal('Source-grounded identity grouping, not independent legal-entity verification.'),
}).strict();
export const IdentityMentionSchema = z.object({
  id: z.string().min(1), type: z.string().min(1), name: z.string().min(1), municipalityId: z.string().min(1),
  sourceSha256: HashSchema, identifiers: z.array(StrongIdentifierSchema), legalForm: z.string().min(1).nullable(),
  period: z.string().min(1).nullable(), validity: EffectiveIntervalSchema, evidenceHashes: z.array(HashSchema).min(1),
  councilBodyIdentity: CouncilBodyIdentitySchema.nullable(),
}).strict();
export type IdentityMention = z.infer<typeof IdentityMentionSchema>;
export const IdentityAssertionSchema = z.object({
  id: z.string().regex(/^identity:[a-f0-9]{64}$/), version: z.number().int().positive(),
  leftMentionId: z.string().min(1), rightMentionId: z.string().min(1),
  decision: z.enum(['same_identity', 'different_identity', 'related_not_same', 'insufficient_evidence']),
  status: z.enum(['accepted', 'proposed', 'contested', 'retracted']), method: z.enum(['strong_identifier', 'council_body_alias', 'authoritative_review', 'model_shadow']),
  ruleVersion: z.string().min(1), author: z.string().min(1), adjudicator: z.string().min(1).nullable(),
  evidenceHashes: z.array(HashSchema).min(1), reviewReceiptSha256: HashSchema.nullable(), validity: EffectiveIntervalSchema,
}).strict().superRefine((value, ctx) => {
  if (value.id !== `identity:${semanticHash({ pair: [value.leftMentionId, value.rightMentionId].sort(), ruleVersion: value.ruleVersion, method: value.method })}`) ctx.addIssue({ code: 'custom', message: 'Identity assertion key mismatch' });
  if (value.leftMentionId === value.rightMentionId) ctx.addIssue({ code: 'custom', message: 'Identity assertion requires distinct mentions' });
  if (value.method === 'model_shadow' && value.status === 'accepted') ctx.addIssue({ code: 'custom', message: 'Model identity matches are shadow only' });
  if (value.method === 'authoritative_review' && value.status === 'accepted' && (!value.adjudicator || !value.reviewReceiptSha256)) ctx.addIssue({ code: 'custom', message: 'Accepted review requires pinned adjudication receipt' });
});
export type IdentityAssertion = z.infer<typeof IdentityAssertionSchema>;
export function identityAssertion(input: Omit<IdentityAssertion, 'id'>): IdentityAssertion {
  const pair = [input.leftMentionId, input.rightMentionId].sort();
  return IdentityAssertionSchema.parse({ ...input, id: `identity:${semanticHash({ pair, ruleVersion: input.ruleVersion, method: input.method })}` });
}

/** Public-safe binding of an actual private A/B/C reconciliation, sealed by the admission publisher. */
export const IdentityAdmissionSchema = z.object({
  schemaVersion: z.literal('assessment-disposition-v1'), assertionId: z.string().regex(/^identity:[a-f0-9]{64}$/),
  assertionSha256: HashSchema,
  assessmentReceiptSha256: HashSchema, receiptHashes: z.object({ A: HashSchema, B: HashSchema, C: HashSchema }).strict(),
  itemSha256: HashSchema, leftMentionId: z.string().min(1), rightMentionId: z.string().min(1),
  decision: IdentityAssertionSchema.shape.decision, status: z.literal('admitted'), adjudicator: z.string().min(1),
  labelProvenance: z.literal('ai_reconciled'), sourceEvidenceHashes: z.array(HashSchema).min(1),
  deterministicPassed: z.literal(true), sealSha256: HashSchema,
}).strict().superRefine((value, ctx) => {
  const { sealSha256, ...receipt } = value;
  if (sealSha256 !== semanticHash(receipt)) ctx.addIssue({ code: 'custom', message: 'Identity admission seal mismatch' });
  if (value.leftMentionId === value.rightMentionId) ctx.addIssue({ code: 'custom', message: 'Identity admission endpoints must differ' });
});
export type IdentityAdmission = z.infer<typeof IdentityAdmissionSchema>;

/** The publisher must obtain admission seals by actual CAS receipt replay, never hash-string approval. */
export function assertIdentityAssertionsBound(mentions: IdentityMention[], assertions: IdentityAssertion[], admissions: IdentityAdmission[], additionalSourceHashes: string[] = []): void {
  const byId = new Map(mentions.map(value => [value.id, value]));
  const admittedHashes = new Set([...additionalSourceHashes, ...mentions.flatMap(value => [value.sourceSha256, ...value.evidenceHashes, ...value.identifiers.flatMap(identifier => identifier.evidenceHashes), ...value.validity.evidenceHashes])]);
  const seals = new Map<string, IdentityAdmission>();
  for (const input of admissions) {
    const seal = IdentityAdmissionSchema.parse(input);
    const key = canonicalJson([seal.assertionId, seal.assertionSha256, seal.assessmentReceiptSha256]);
    if (seals.has(key)) throw Error('Duplicate identity review admission');
    if (seal.sourceEvidenceHashes.some(hash => !admittedHashes.has(hash))) throw Error('Unbound identity review source evidence');
    seals.set(key, seal);
  }
  for (const input of assertions) {
    const assertion = IdentityAssertionSchema.parse(input);
    if (!byId.has(assertion.leftMentionId) || !byId.has(assertion.rightMentionId)) throw Error('Unbound identity assertion endpoint');
    if (assertion.evidenceHashes.some(hash => !admittedHashes.has(hash)) || assertion.validity.evidenceHashes.some(hash => !admittedHashes.has(hash))) throw Error('Unbound identity assertion source evidence');
    if (['strong_identifier', 'council_body_alias'].includes(assertion.method) && assertion.status === 'accepted' && assertion.decision === 'same_identity' && (assertion.validity.validFrom.kind !== 'unknown' || assertion.validity.validTo.kind !== 'unknown')) {
      const left = byId.get(assertion.leftMentionId)!, right = byId.get(assertion.rightMentionId)!;
      const expected = intervalIntersection([left.validity, right.validity]) ?? unknownValidity();
      if (canonicalJson([assertion.validity.validFrom, assertion.validity.validTo]) !== canonicalJson([expected.validFrom, expected.validTo])) throw Error('Strong identity applicability differs from sourced endpoint validity');
    }
    if (assertion.method === 'authoritative_review' && assertion.status === 'accepted') {
      if (assertion.validity.validFrom.kind !== 'unknown' || assertion.validity.validTo.kind !== 'unknown') {
        const normalized = effectiveIntervalFromExpression(assertion.validity.expression, assertion.validity.evidenceHashes);
        if (canonicalJson([normalized.validFrom, normalized.validTo]) !== canonicalJson([assertion.validity.validFrom, assertion.validity.validTo])) throw Error('Reviewed identity interval differs from source expression normalization');
      }
      const seal = seals.get(canonicalJson([assertion.id, semanticHash(assertion), assertion.reviewReceiptSha256]));
      if (!seal || seal.assertionId !== assertion.id || seal.assertionSha256 !== semanticHash(assertion) || seal.leftMentionId !== assertion.leftMentionId || seal.rightMentionId !== assertion.rightMentionId || seal.adjudicator !== assertion.adjudicator || seal.decision !== assertion.decision || assertion.evidenceHashes.some(hash => !seal.sourceEvidenceHashes.includes(hash))) throw Error('Accepted identity review lacks matching actual admission seal');
    }
  }
}
export function clusterConflicts(mentions: IdentityMention[]): string[] {
  const conflicts: string[] = [];
  if (new Set(mentions.map(value => value.councilBodyIdentity && ['municipality', 'authority', 'organization'].includes(value.type) ? 'authority' : value.type === 'company' ? 'organization' : value.type)).size > 1) conflicts.push('incompatible_types');
  if (new Set(mentions.map(value => value.legalForm).filter(value => value !== null)).size > 1) conflicts.push('incompatible_legal_forms');
  if (new Set(mentions.map(value => value.period).filter(value => value !== null)).size > 1) conflicts.push('incompatible_periods');
  if (new Set(mentions.map(value => value.councilBodyIdentity?.key).filter(value => value !== undefined)).size > 1) conflicts.push('incompatible_council_bodies');
  const domains = new Map<string, Set<string>>();
  for (const mention of mentions) for (const id of mention.identifiers) {
    const domain = canonicalJson([normalizeIdentityValue(id.namespace), normalizeIdentityValue(id.issuer)]);
    const values = domains.get(domain) ?? new Set<string>(); values.add(normalizeIdentityValue(id.value)); domains.set(domain, values);
  }
  if ([...domains.values()].some(values => values.size > 1)) conflicts.push('conflicting_strong_identifiers');
  return conflicts;
}
function sharesIdentifier(left: IdentityMention, right: IdentityMention): boolean {
  const keys = new Set(left.identifiers.map(identifierKey));
  return right.identifiers.some(value => keys.has(identifierKey(value)));
}
/** Rebuild from immutable mentions + latest assertion versions: retraction really splits a cluster. */
export function resolveIdentityMentions(input: IdentityMention[], assertionInput: IdentityAssertion[] = []) {
  const mentions = input.map(value => IdentityMentionSchema.parse(value)).sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(mentions.map(value => [value.id, value]));
  if (byId.size !== mentions.length) throw Error('Duplicate identity mention');
  const latest = new Map<string, IdentityAssertion>();
  for (const raw of assertionInput) {
    const assertion = IdentityAssertionSchema.parse(raw);
    if (!byId.has(assertion.leftMentionId) || !byId.has(assertion.rightMentionId)) throw Error('Unbound identity assertion endpoint');
    const prior = latest.get(assertion.id);
    if (prior?.version === assertion.version) throw Error('Duplicate identity assertion version');
    if (!prior || assertion.version > prior.version) latest.set(assertion.id, assertion);
  }
  const identifierOwners = new Map<string, IdentityMention>();
  for (const mention of mentions) for (const identifier of mention.identifiers) {
    const key = identifierKey(identifier), previous = identifierOwners.get(key);
    if (!previous) { identifierOwners.set(key, mention); continue; }
    if (previous.id === mention.id) continue;
    const generated = identityAssertion({
      version: 1, leftMentionId: previous.id, rightMentionId: mention.id, decision: 'same_identity',
      status: 'accepted', method: 'strong_identifier', ruleVersion: IDENTITY_RULE_VERSION,
      author: 'deterministic-resolver', adjudicator: null, reviewReceiptSha256: null,
      evidenceHashes: [...new Set([...previous.evidenceHashes, ...mention.evidenceHashes])].sort(),
      validity: intervalIntersection([previous.validity, mention.validity]) ?? unknownValidity(),
    });
    if (!latest.has(generated.id)) latest.set(generated.id, generated);
  }
  const councilOwners = new Map<string, IdentityMention>();
  for (const mention of mentions) {
    if (!mention.councilBodyIdentity || mention.identifiers.length) continue;
    const key = mention.councilBodyIdentity.key, previous = councilOwners.get(key);
    if (!previous) { councilOwners.set(key, mention); continue; }
    const generated = identityAssertion({
      version: 1, leftMentionId: previous.id, rightMentionId: mention.id, decision: 'same_identity',
      status: 'accepted', method: 'council_body_alias', ruleVersion: 'ags-council-body-v1',
      author: 'deterministic-resolver', adjudicator: null, reviewReceiptSha256: null,
      evidenceHashes: [...new Set([...previous.evidenceHashes, ...mention.evidenceHashes])].sort(),
      validity: intervalIntersection([previous.validity, mention.validity]) ?? unknownValidity(),
    });
    if (!latest.has(generated.id)) latest.set(generated.id, generated);
  }
  const assertions = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
  const clusters = new Map(mentions.map(value => [value.id, [value]]));
  const owner = new Map(mentions.map(value => [value.id, value.id]));
  const blocked: Array<{ assertionId: string; reasons: string[] }> = [];
  for (const assertion of assertions) {
    if (assertion.status !== 'accepted' || assertion.decision !== 'same_identity') continue;
    const left = byId.get(assertion.leftMentionId)!, right = byId.get(assertion.rightMentionId)!;
    const leftKey = owner.get(left.id)!, rightKey = owner.get(right.id)!;
    if (leftKey === rightKey) continue;
    const proposed = [...clusters.get(leftKey)!, ...clusters.get(rightKey)!];
    const reasons = clusterConflicts(proposed);
    if (assertion.method === 'strong_identifier' && !sharesIdentifier(left, right)) reasons.push('missing_shared_strong_identifier');
    if (assertion.method === 'council_body_alias' && (!left.councilBodyIdentity || !right.councilBodyIdentity || left.councilBodyIdentity.key !== right.councilBodyIdentity.key || left.identifiers.length || right.identifiers.length)) reasons.push('missing_canonical_council_alias_basis');
    if (assertion.method === 'authoritative_review' && left.municipalityId !== right.municipalityId && !assertion.reviewReceiptSha256) reasons.push('missing_cross_town_review');
    if (assertions.some(value => (value.status === 'contested' || value.status === 'accepted' && value.decision === 'different_identity') && proposed.some(mention => mention.id === value.leftMentionId) && proposed.some(mention => mention.id === value.rightMentionId))) reasons.push('contradictory_identity_assertion');
    if (reasons.length) { blocked.push({ assertionId: assertion.id, reasons }); continue; }
    const key = [leftKey, rightKey].sort()[0]; clusters.delete(leftKey); clusters.delete(rightKey); clusters.set(key, proposed);
    for (const mention of proposed) owner.set(mention.id, key);
  }
  const resolved = [...clusters.values()].map(values => {
    const identifiers = [...new Set(values.flatMap(value => value.identifiers.map(identifierKey)))].sort();
    const periods = [...new Set(values.map(value => value.period).filter(value => value !== null))].sort();
    const key = identifiers.length && !clusterConflicts(values).length ? { type: values[0].type === 'company' ? 'organization' : values[0].type, identifiers, periods } : { mentionIds: values.map(value => value.id).sort() };
    const council = values[0].councilBodyIdentity;
    const id = !identifiers.length && council && values.every(value => value.councilBodyIdentity?.key === council.key) && !clusterConflicts(values).length ? `entity:${digest(council.key)}` : `entity:${semanticHash(key)}`;
    return { id, mentionIds: values.map(value => value.id).sort(), aliases: [...new Set(values.map(value => value.name))].sort(), conflicts: clusterConflicts(values) };
  });
  const counts = new Map<string, number>();
  for (const cluster of resolved) counts.set(cluster.id, (counts.get(cluster.id) ?? 0) + 1);
  for (const cluster of resolved) if (counts.get(cluster.id)! > 1) cluster.id = `entity:${semanticHash({ identity: cluster.id, unresolvedMentions: cluster.mentionIds })}`;
  return { assertions, blocked, clusters: resolved.sort((a, b) => a.id.localeCompare(b.id)) };
}
/** Bounded candidates only: labels block pairs, they never authorize a merge. */
export function identityCandidatePairs(input: IdentityMention[], maxPairs = 100): Array<[string, string]> {
  if (!Number.isInteger(maxPairs) || maxPairs < 1 || maxPairs > 1000) throw Error('Invalid identity candidate bound');
  if (input.length > 5000) throw Error('Identity candidate mention bound exceeded');
  const mentions = input.map(value => IdentityMentionSchema.parse(value)).sort((a, b) => a.id.localeCompare(b.id));
  const groups = new Map<string, IdentityMention[]>();
  for (const mention of mentions) {
    const type = mention.type === 'company' ? 'organization' : mention.type;
    const keys = [`name:${canonicalJson([mention.municipalityId, type, normalizeIdentityValue(mention.name).toLocaleLowerCase('de')])}`, ...mention.identifiers.map(value => `identifier:${identifierKey(value)}`)];
    for (const key of keys) { const group = groups.get(key) ?? []; group.push(mention); groups.set(key, group); }
  }
  const result: Array<[string, string]> = [], seen = new Set<string>();
  let examined = 0;
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const left = group[i], right = group[j], pair = canonicalJson([left.id, right.id]);
      if (left.id === right.id || seen.has(pair)) continue;
      seen.add(pair);
      if (++examined > 10000) throw Error('Identity candidate comparison bound exceeded');
      if (clusterConflicts([left, right]).length) continue;
      result.push([left.id, right.id]); if (result.length === maxPairs) return result;
    }
  }
  return result;
}

export interface NativeIdentityGraph {
  mentions: IdentityMention[];
  assertions: IdentityAssertion[];
  relations: Array<{ id: string; subjectMentionId: string; objectMentionId: string; predicate: string; modality: 'asserted'; validity: EffectiveInterval; eventDate: string | null; eventDateRole: string | null; evidence: StructuredLocator[] }>;
}
export interface ProcurementReferenceIdentity {
  namespace: string; issuer: string; nativeKey: string; technicalParty: boolean; european: boolean;
}
/** Canonical adapter keys, decoded once: European IDs are global; technical actors are notice-local. */
export function procurementReferenceIdentity(value: string, publisherId: string): ProcurementReferenceIdentity | null {
  if (!value.startsWith('procurement:')) return null;
  const parts = value.slice('procurement:'.length).split(':').map(part => decodeURIComponent(part));
  if (`procurement:${parts.map(encodeURIComponent).join(':')}` !== value) throw Error('Non-canonical procurement key');
  if (parts[0] === 'eu-eforms') {
    if (parts.length === 4 && parts[1] === 'notice' && parts[2] && /^(?:0|[1-9]\d{0,8})$/u.test(parts[3])) return { namespace: 'eu-eforms:notice', issuer: 'eu-eforms', nativeKey: value, technicalParty: false, european: true };
    if (parts.length === 3 && parts[1] === 'procedure' && parts[2]) return { namespace: 'eu-eforms:procedure', issuer: 'eu-eforms', nativeKey: value, technicalParty: false, european: true };
    if (parts.length === 4 && parts[1] && parts[2] === 'lot' && parts[3]) return { namespace: 'eu-eforms:lot', issuer: 'eu-eforms', nativeKey: value, technicalParty: false, european: true };
    return null;
  }
  if (parts.length === 3 && parts[0].startsWith('procurement:')) {
    const notice = procurementReferenceIdentity(parts[0], publisherId);
    if (!notice || notice.namespace !== 'eu-eforms:notice' || !parts[2] || !['party', 'award', 'tender', 'contract', 'tendering_party', 'lotresult'].includes(parts[1])) return null;
    return { namespace: `eu-eforms:notice-local:${parts[1]}`, issuer: parts[0], nativeKey: value, technicalParty: parts[1] === 'party' || parts[1] === 'tendering_party', european: true };
  }
  if (parts[0] !== publisherId) return null;
  if (parts.length === 3 && parts[1] === 'ocid' && parts[2] || parts.length === 5 && parts[1] === 'ocid' && parts[2] && parts[3] === 'release' && parts[4] || parts.length === 4 && parts[1] && ['lot', 'award', 'tender', 'contract', 'party'].includes(parts[2]) && parts[3]) {
    return { namespace: `ocds:${parts.length === 3 ? 'procedure' : parts.length === 5 ? 'notice' : parts[2]}`, issuer: publisherId, nativeKey: value, technicalParty: parts.length === 4 && parts[2] === 'party', european: false };
  }
  return null;
}

/** Pinned native-field mappings only; an observation subject label is never an identity key. */
export function nativeStructuredIdentityGraph(observationInput: StructuredObservation, scopeInput: AdapterScope): NativeIdentityGraph {
  const observation = ObservationSchema.parse(observationInput), scope = ScopeSchema.parse(scopeInput);
  const result: NativeIdentityGraph = { mentions: [], assertions: [], relations: [] };
  if (observation.publisherId !== scope.publisherId || observation.sourceId !== scope.sourceId) throw Error('Native identity mapping scope mismatch');
  const nativeProof = observation.evidence.filter(value => value.nativeId === observation.nativeId);
  const mappedSourceMention = (type: string, id: string, name: string, proof: StructuredLocator[], options: { identified?: boolean; period?: string | null; namespace?: string; issuer?: string } = {}): IdentityMention => {
    if (!proof.length) throw Error('Native source identity lacks locator evidence');
    const sourceSha256 = observation.evidence[0].sourceSha256, namespace = options.namespace ?? `${scope.sourceId}:${scope.tenant ?? ''}:${type}`;
    const hashes = proof.map(value => semanticHash(value)).sort();
    const mention = IdentityMentionSchema.parse({
      id: `mention:${semanticHash([scope.municipalityId, sourceSha256, namespace, id])}`, type, name,
      municipalityId: scope.municipalityId, sourceSha256,
      identifiers: options.identified === false ? [] : [{ namespace, issuer: options.issuer ?? scope.publisherId, value: id, evidenceHashes: hashes }],
      legalForm: ['organization', 'company'].includes(type) ? legalFormFromName(name) : null, period: options.period ?? null, validity: unknownValidity(), evidenceHashes: hashes, councilBodyIdentity: null,
    });
    result.mentions.push(mention); return mention;
  };
  const link = (subject: IdentityMention, object: IdentityMention, predicate: string): void => {
    const relation = { subjectMentionId: subject.id, objectMentionId: object.id, predicate, modality: 'asserted' as const, validity: unknownValidity(), eventDate: null, eventDateRole: null, evidence: observation.evidence };
    result.relations.push({ id: semanticHash(relation), ...relation });
  };
  const version = observation.evidence[0].mappingVersion;
  if (version === 'funding-operations-v2' && ['FundingOperation', 'ProgrammeAttribution', 'AgriculturalPaymentDisclosure'].includes(observation.kind)) {
    const payment = observation.kind === 'AgriculturalPaymentDisclosure';
    const prefix = `${scope.publisherId}:${scope.sourceId}:${payment ? 'payment' : 'operation'}:`;
    if (!observation.subject.startsWith(prefix) || !payment && observation.subject !== prefix + observation.nativeId) throw Error('Native funding identity subject mismatch');
    if (observation.predicate === 'source_status' && observation.value === 'withdrawn') return result;
    const operation = mappedSourceMention(payment ? 'payment_disclosure' : 'funding_operation', observation.subject, observation.predicate === 'title' && typeof observation.value === 'string' ? observation.value : observation.subject, nativeProof, { identified: !payment });
    if (['awarded_to', 'paid_to'].includes(observation.predicate) && typeof observation.value === 'string') {
      const name = observation.evidence[0].rawValue;
      if (typeof name !== 'string' || !name.trim()) throw Error('Funding recipient lacks source name field');
      const recipient = mappedSourceMention('organization', observation.value, name, observation.evidence, { identified: false });
      link(operation, recipient, observation.predicate);
    }
    if (observation.predicate === 'supported_by' && typeof observation.value === 'string') {
      const attribution = mappedSourceMention('programme_attribution', observation.value, observation.value, observation.evidence, { identified: false });
      link(attribution, operation, 'supports');
    }
    if (observation.kind === 'ProgrammeAttribution' && observation.predicate === 'programme' && typeof observation.value === 'string') {
      const programme = z.object({ authority: z.string().min(1), fund: z.string().min(1), period: z.string().nullable(), code: z.string().nullable(), identityBasis: z.string() }).strict().parse(JSON.parse(observation.value));
      const reference = `${scope.publisherId}:programme:${semanticHash(programme)}`;
      const attribution = mappedSourceMention('programme_attribution', reference, reference, observation.evidence, { identified: false });
      link(attribution, operation, 'supports');
      // Catalogue authority/fund/period defaults remain attributed metadata, never native issuer/period evidence.
      const explicitTuple = [programme.authority, programme.fund, programme.period, programme.code].every(value => {
        if (value === null) return false;
        const expected = normalizeIdentityValue(value);
        return observation.evidence.some(locator => typeof locator.rawValue === 'string' && normalizeIdentityValue(locator.rawValue) === expected);
      });
      if (explicitTuple && programme.period && programme.code) {
        const identifier = canonicalJson([programme.authority, programme.fund, programme.period, programme.code]);
        const canonicalProgramme = mappedSourceMention('funding_programme', identifier, programme.code, observation.evidence, { period: programme.period });
        link(attribution, canonicalProgramme, 'describes');
        link(canonicalProgramme, operation, 'supports');
      }
    }
    return result;
  }
  if (version === 'procurement-native-v1') {
    const reference = procurementReferenceIdentity(observation.subject, scope.publisherId);
    if (!reference) return result;
    const types: Record<string, string> = { Notice: 'procurement_notice', Procedure: 'procurement_procedure', Tender: 'procurement_tender', Lot: 'procurement_lot', LotResult: 'procurement_lot_result', Buyer: 'procurement_party', OrganizationMention: 'procurement_party', Award: 'award', Contract: 'contract' };
    const type = Object.hasOwn(types, observation.kind) ? types[observation.kind] : null;
    if (!type) return result;
    const identity = (descriptor: ProcurementReferenceIdentity, objectType: string) => descriptor.european || descriptor.technicalParty || objectType === 'procurement_procedure' ? descriptor.nativeKey : canonicalJson([descriptor.nativeKey, observation.nativeVersion]);
    const subject = mappedSourceMention(type, identity(reference, type), observation.subject, nativeProof, reference);
    const targets: Record<string, string> = { announces: 'procurement_procedure', part_of: 'procurement_procedure', procures_procedure: 'procurement_procedure', for_lot: 'procurement_lot', awarded_to: 'procurement_party', award_reference: 'award', tender_reference: 'procurement_tender', contract_reference: 'contract', tendering_party_reference: 'procurement_tendering_party' };
    const targetType = Object.hasOwn(targets, observation.predicate) ? targets[observation.predicate] : null;
    const targetReference = targetType && typeof observation.value === 'string' ? procurementReferenceIdentity(observation.value, scope.publisherId) : null;
    if (targetType && targetReference && typeof observation.value === 'string') {
      const target = mappedSourceMention(targetType, identity(targetReference, targetType), observation.value, observation.evidence, targetReference);
      link(subject, target, observation.predicate);
    }
    return result;
  }
  if (version === 'permit-notices-html-v1' && observation.kind === 'PermitProcedureMetadata') {
    mappedSourceMention('permit_procedure', observation.nativeId, observation.nativeId, nativeProof);
    return result;
  }
  if (/^planning-wfs-native-v1:[a-f0-9]{64}$/u.test(observation.evidence[0].mappingVersion) && ['SpatialPlan', 'PlanGeometry', 'PlanAmendmentReference'].includes(observation.kind)) {
    if (observation.subject !== canonicalJson([scope.publisherId, scope.sourceId, observation.nativeId])) throw Error('Native plan identity subject mismatch');
    mappedSourceMention('spatial_plan', observation.nativeId, observation.predicate === 'plan_name' && typeof observation.value === 'string' ? observation.value : observation.nativeId, nativeProof);
    // Amendment strings and overlapping geometry remain source fields, never same_as/amends links.
    return result;
  }
  if (observation.evidence[0].mappingVersion === 'council-native-v3' && observation.evidence[0].format === 'json') {
    const kinds: Record<string, string> = { Body: 'authority', Organization: 'organization', Meeting: 'council_meeting', Paper: 'council_paper', AgendaItem: 'agenda_item', File: 'document' };
    const type = Object.hasOwn(kinds, observation.kind) ? kinds[observation.kind] : null;
    if (!type || observation.predicate === 'withdrawn') return result;
    if (observation.subject !== `${scope.publisherId}:${scope.sourceId}:${scope.tenant ?? ''}:${observation.nativeId}`) throw Error('Native council identity subject mismatch');
    const subject = mappedSourceMention(type, observation.nativeId, observation.predicate === 'name' && typeof observation.value === 'string' ? observation.value : observation.nativeId, nativeProof);
    const targetTypes: Record<string, string> = { belongs_to_body: 'authority', agenda_meeting: 'council_meeting', references_paper: 'council_paper', references_document: 'document', meeting_organization: 'organization' };
    const targetType = Object.hasOwn(targetTypes, observation.predicate) ? targetTypes[observation.predicate] : null;
    if (targetType && typeof observation.value === 'string' && /^https?:\/\//u.test(observation.value)) {
      const proof = observation.evidence.filter(value => value.rawValue === observation.value);
      const target = mappedSourceMention(targetType, observation.value, observation.value, proof);
      const relation = { subjectMentionId: subject.id, objectMentionId: target.id, predicate: observation.predicate, modality: 'asserted' as const, validity: unknownValidity(), eventDate: null, eventDateRole: null, evidence: observation.evidence };
      result.relations.push({ id: semanticHash(relation), ...relation });
    }
    return result;
  }
  if (!observation.evidence.every(value => value.mappingVersion === 'mastr-public-export-v1')) return result;
  const unit = /^mastr:unit:(SEE\d{12})$/u.exec(observation.subject);
  const actor = /^mastr:actor:(ABR\d{12})$/u.exec(observation.subject);
  const hashes = observation.evidence.map(value => semanticHash(value)).sort();
  const sourceSha256 = observation.evidence[0].sourceSha256;
  if (observation.evidence.some(value => value.sourceSha256 !== sourceSha256)) throw Error('Mixed source identity evidence');
  const addMention = (type: string, namespace: string, id: string, name: string): IdentityMention => {
    const identifierEvidence = observation.evidence.filter(value => normalizeIdentityValue(String(value.rawValue)) === id);
    if (!identifierEvidence.length) throw Error('Native identity ID lacks source field evidence');
    const mention = IdentityMentionSchema.parse({
      id: `mention:${semanticHash([scope.municipalityId, sourceSha256, namespace, id])}`, type, name,
      municipalityId: scope.municipalityId, sourceSha256, identifiers: [{ namespace, issuer: 'Bundesnetzagentur', value: id, evidenceHashes: identifierEvidence.map(value => semanticHash(value)).sort() }],
      legalForm: type === 'organization' ? legalFormFromName(name) : null, period: null, validity: unknownValidity(), evidenceHashes: hashes, councilBodyIdentity: null,
    });
    result.mentions.push(mention); return mention;
  };
  if (unit && observation.nativeId === unit[1]) addMention('energy_unit', 'MaStR:Einheit', unit[1], unit[1]);
  if (actor && observation.kind === 'OrganizationObservation' && observation.predicate === 'registered_organization_name' && typeof observation.value === 'string') {
    if (!observation.evidence.some(value => value.rawValue === observation.value)) throw Error('Native organization name lacks source field evidence');
    addMention('organization', 'MaStR:Marktakteur', actor[1], observation.value);
  }
  if (actor && observation.kind === 'RegisteredOperatorAssignment' && observation.predicate === 'operates' && observation.value === `mastr:unit:${observation.nativeId}`) {
    const subject = addMention('organization', 'MaStR:Marktakteur', actor[1], actor[1]);
    if (!/^SEE\d{12}$/u.test(observation.nativeId)) throw Error('Invalid native energy unit ID');
    const object = addMention('energy_unit', 'MaStR:Einheit', observation.nativeId, observation.nativeId);
    const relation = { subjectMentionId: subject.id, objectMentionId: object.id, predicate: 'operates', modality: 'asserted' as const, validity: unknownValidity(), eventDate: null, eventDateRole: null, evidence: observation.evidence };
    result.relations.push({ id: semanticHash(relation), ...relation });
  }
  return result;
}

export const TemporalPathStepSchema = z.object({
  validity: EffectiveIntervalSchema, identityValidity: z.array(EffectiveIntervalSchema),
  eventDate: identityDaySchema.nullable(), eventDateRole: z.string().min(1).nullable(), eventEvidenceHashes: z.array(HashSchema),
  unresolvedContradiction: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.eventDate !== null && (!value.eventDateRole || !value.eventEvidenceHashes.length)) ctx.addIssue({ code: 'custom', message: 'Event time requires role and source evidence' });
  if (value.eventDate === null && value.eventDateRole !== null) ctx.addIssue({ code: 'custom', message: 'Event role requires event date' });
});
export type TemporalPathStep = z.infer<typeof TemporalPathStepSchema>;
/** Financial/legal dates need chronology, not interval simultaneity. Ongoing edges do. */
export function temporalPathEligible(input: TemporalPathStep[], asOfInput: string, mode: 'as_of' | 'chronological' = 'as_of'): boolean {
  const asOf = identityDaySchema.parse(asOfInput), steps = input.map(value => TemporalPathStepSchema.parse(value));
  let previousEventDate: string | null = null;
  const ongoing: EffectiveInterval[] = [];
  for (const step of steps) {
    if (step.unresolvedContradiction) return false;
    if (step.eventDate !== null) {
      if (step.eventDate > asOf || step.identityValidity.some(value => !intervalContains(value, step.eventDate!))) return false;
      if (mode === 'chronological' && previousEventDate !== null && step.eventDate < previousEventDate) return false;
      previousEventDate = step.eventDate;
    } else {
      if (!intervalContains(step.validity, asOf) || step.identityValidity.some(value => !intervalContains(value, asOf))) return false;
      ongoing.push(step.validity, ...step.identityValidity);
    }
  }
  return !ongoing.length || intervalIntersection(ongoing) !== null;
}
