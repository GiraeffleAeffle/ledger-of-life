import { z } from 'zod';
import { semanticHash, canonicalJson } from './district-adapter-contract.ts';
import { PublicKnowledgeRecordSchema, type PublicKnowledgeRecord } from './district-schema.ts';
import { stageEvidenceSupports } from './district-stage-evidence.ts';
import { CRITICAL_ASSESSMENT_VERSION, CriticalRecordTargetSchema, CriticalClaimSchema, CriticalAdmissionSchema,
  type CriticalClaim } from './district-critical-assessment-contract.ts';
import { textLineageRecordSha256 } from './text-run-lineage.ts';
import type { RetainedKnowledgeLineage } from './retained-knowledge-lineage.ts';

// Public content validation only: no VM authority, private CAS, filesystem or model jobs.
const finalStages = ['adopted', 'in_force', 'implemented'] as const;
const paid = /\b(?:ausgezahlt|gezahlt|zahlte|zahlten|bezahlt|beglichen|paid|disbursed)\b/iu;
const spent = /\b(?:ausgegeben|verausgabt|abgerechnet|investiert|verbraucht|kostete|Ist-Ausgaben|Ist-Auszahlungen|expenditure)\b|Kosten\s+(?:betrugen|beliefen\s+sich)|tatsächliche[nr]?\s+(?:Ausgaben|Kosten|Auszahlungen)/iu;
const nonActual = /\b(?:soll(?:en|te|ten)?|wird|werden|geplant|vorgesehen|beabsichtigt|voraussichtlich|künftig|noch\s+nicht|nicht|kein(?:e[rmns]?)?|wenn|falls|vorbehaltlich|planned|pending|forecast|predicted|not|never)\b/iu;
/** Conservative critical routing, not a source-truth classifier or a financial parser. */
export function actualFinancialRole(text: string): 'payment' | 'actual' | null {
  for (const clause of text.split(/[!?;,\n]|\.(?=\s|$)|\b(?:aber|sondern|statt|but|rather than)\b/iu)) {
    if (nonActual.test(clause)) continue;
    if (paid.test(clause)) return 'payment';
    if (spent.test(clause)) return 'actual';
  }
  return null;
}
export function criticalKnowledgeTarget(input: PublicKnowledgeRecord) {
  const record = PublicKnowledgeRecordSchema.parse(input);
  if (record.kind === 'structured') return null; // Direct native coding retains structured verification.
  const { extraction: _generation, verification: _judgment, sources, ...claims } = record;
  const sourceProjection = sources.map(source => ({ id: source.id, url: source.url, sha256: source.sha256 }));
  const claimProjection = { ...claims, sources: sourceProjection };
  const primary = sources[0], required: CriticalClaim[] = [];
  const add = (selector: string, kind: CriticalClaim['kind'], quote: string, stage: CriticalClaim['stage'],
    financialRoles: CriticalClaim['financialRoles'], subjectId: string, objectId: string | null,
    date: string | null, historical: boolean, context: Record<string, unknown>) => {
    const body = { kind, selector, sourceId: primary.id, sourceSha256: primary.sha256, sourceUrl: primary.url, quote,
      stage, financialRoles, subjectId, objectId, date, dateRole: date ? 'stage_event' : null,
      modality: historical ? 'historical' as const : 'confirmed' as const, context };
    const claimSha256 = semanticHash(body);
    required.push(CriticalClaimSchema.parse({ ...body, claimSha256, claimId: 'critical:' + semanticHash({ recordId: record.id, claimSha256 }) }));
  };
  if (finalStages.some(stage => stage === record.stage)) add('/stage', 'finalization', record.stageQuote,
    record.stage as CriticalClaim['stage'], ['none'], record.id, null, record.stageDate, false,
    { stage: record.stage, originalStatus: record.originalStatus, dateQuote: record.stageDateQuote });
  for (const [index, event] of record.stages.entries()) if (finalStages.some(stage => stage === event.stage)) {
    add('/stages/' + index, 'finalization', event.quote, event.stage as CriticalClaim['stage'], ['none'], record.id, null,
      event.date, true, { ...event });
  }
  // A summary can assert finality even if the extractor chose a weaker stage field.
  for (const stage of finalStages) if (stageEvidenceSupports(stage, record.summary)) {
    add('/summary/' + stage, 'finalization', record.summaryQuote, stage, ['none'], record.id, null, null, false,
      { summary: record.summary, summaryQuote: record.summaryQuote });
  }
  const financialRole = actualFinancialRole(record.summary);
  if (financialRole) add('/summary/finance', 'finance', record.summaryQuote, null, [financialRole], record.id, null, null, false,
    { summary: record.summary, summaryQuote: record.summaryQuote });
  for (const [index, relation] of record.relations.entries()) {
    const role = actualFinancialRole(relation.quote);
    if (role && !['planned', 'proposed', 'conditional', 'negated'].includes(relation.modality)) {
      add('/relations/' + index + '/finance', 'finance', relation.quote, null, [role],
        relation.fromId, relation.toId, null, relation.modality === 'historical', { ...relation });
    }
    if (relation.modality === 'implemented') {
      if (relation.type === 'funds' && !role) add('/relations/' + index, 'finance', relation.quote, null, ['payment', 'actual'],
        relation.fromId, relation.toId, null, false, { ...relation });
      else if (relation.type !== 'funds') add('/relations/' + index, 'finalization', relation.quote, 'implemented', ['none'],
        relation.fromId, relation.toId, null, false, { ...relation });
    }
  }
  if (!required.length) return null;
  return CriticalRecordTargetSchema.parse({ version: CRITICAL_ASSESSMENT_VERSION, recordId: record.id,
    recordEvidenceSha256: record.verification.evidenceHash, claimProjectionSha256: semanticHash(claimProjection),
    claimProjection, claims: required });
}
export function assertCriticalAdmissionsBound(recordsInput: readonly PublicKnowledgeRecord[], admissionsInput: unknown, retainedPublication?: RetainedKnowledgeLineage | null): void {
  const admissions = z.array(CriticalAdmissionSchema).parse(admissionsInput), byId = new Map(admissions.map(seal => [seal.recordId, seal]));
  if (byId.size !== admissions.length) throw Error('Duplicate critical admission record');
  const required = recordsInput.map(record => criticalKnowledgeTarget(record)).filter(target => target !== null);
  if (required.length !== admissions.length) throw Error('Critical public projection does not cover exactly the included records');
  for (const target of required) {
    const seal = byId.get(target.recordId);
    if (!seal || seal.recordEvidenceSha256 !== target.recordEvidenceSha256 || seal.claimProjectionSha256 !== target.claimProjectionSha256
      || canonicalJson(seal.claims) !== canonicalJson(target.claims.map(claim => ({ claimId: claim.claimId, kind: claim.kind, claimSha256: claim.claimSha256 })))) throw Error('Critical public projection record/claim binding mismatch');
    if (seal.labelProvenance === 'retained_original_gates') {
      const origin = retainedPublication?.selectedRecordOrigins.find(value => value.recordId === target.recordId);
      const record = recordsInput.find(value => value.id === target.recordId)!;
      const binding = seal.retainedPublication;
      if (!retainedPublication || !origin || binding.releaseId !== retainedPublication.releaseId
        || binding.manifestSha256 !== retainedPublication.manifestSha256 || binding.recordsSha256 !== retainedPublication.members.records.sha256
        || binding.originalRecordSha256 !== origin.originalRecordSha256 || binding.originalEvidenceHash !== origin.originalEvidenceHash
        || binding.originSha256 !== textLineageRecordSha256(origin) || origin.currentEvidenceHash !== target.recordEvidenceSha256
        || origin.currentRecordSha256 !== textLineageRecordSha256(record)) throw Error('Critical retained original gates lack exact publication lineage');
    }
    if (target.claims.some(claim => !seal.sourceEvidenceHashes.includes(claim.sourceSha256)
      || !seal.sourceEvidenceHashes.includes(semanticHash([claim.sourceSha256, claim.quote])))) throw Error('Critical public projection original evidence binding mismatch');
  }
}
