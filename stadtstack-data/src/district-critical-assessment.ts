import { semanticHash, canonicalJson, ObservationSchema } from './district-adapter-contract.ts';
import { PublicKnowledgeRecordSchema, knowledgeEvidenceHash, type PublicKnowledgeRecord } from './district-schema.ts';
import { stageEvidenceSupports } from './district-stage-evidence.ts';
import { criticalKnowledgeTarget, assertCriticalAdmissionsBound, actualFinancialRole } from './district-critical-assessment-public.ts';
import { assessmentItemSchema, verifyPinnedAssessment, type AssessmentEvidenceContext } from './district-assessment.ts';
import { loadPolicyReceipt } from './district-policy-receipt.ts';
import type { DistrictCas } from './district-cas.ts';
import { CriticalAssessmentInventorySchema, CriticalAdmissionSchema,
  type CriticalAdmission, type CriticalPublicationHold } from './district-critical-assessment-contract.ts';
import { validateRetainedKnowledgeComposition, retainedKnowledgeRecordOrigin, type RetainedKnowledgeComposition } from './retained-knowledge-lineage.ts';
import { textLineageRecordSha256 } from './text-run-lineage.ts';

export function prepareCriticalAssessment(recordInput: PublicKnowledgeRecord, itemInput: unknown) {
  const record = PublicKnowledgeRecordSchema.parse(recordInput), target = criticalKnowledgeTarget(record);
  if (record.kind !== 'text_model' || !target) throw Error('Record has no model-derived critical claims');
  const item = assessmentItemSchema.parse(itemInput);
  if (item.itemId !== record.id || item.valueTarget) throw Error('Critical assessment must bind the exact private record, not a value-review lane');
  const expected = new Set(record.sources.map(source => source.id + ':' + source.sha256));
  if (item.sources.length !== record.sources.length || item.sources.some(source => !expected.has((source.mcpSourceId ?? source.sourceId) + ':' + source.originalSha256))) throw Error('Critical assessment original source membership mismatch');
  const entityIds = [...new Set([record.id, ...record.entities.map(entity => entity.entityId)])].sort();
  const criticalKinds = [...new Set(target.claims.map(claim => claim.kind === 'finalization' ? 'stage' as const : 'finance' as const))];
  return assessmentItemSchema.parse({ ...item, claim: 'Independently verify or reject every source-bound critical claim and the complete supplied record projection.',
    claimIds: target.claims.map(claim => claim.claimId), entityIds, criticalKinds, criticalTarget: target });
}
/** New claims require actual A/B/C replay; authenticated unchanged originals retain only their original gates. */
export async function admitCriticalKnowledge(recordsInput: readonly PublicKnowledgeRecord[], inventoryInput: unknown, cas: DistrictCas,
  options: Omit<AssessmentEvidenceContext, 'cas'> & { originalAdmissions?: readonly CriticalAdmission[]; retainedPublication?: RetainedKnowledgeComposition | null } = {}) {
  const records = recordsInput.map(record => PublicKnowledgeRecordSchema.parse(record));
  const inventory = CriticalAssessmentInventorySchema.parse(inventoryInput), entries = new Map(inventory.records.map(entry => [entry.recordId, entry]));
  // Preserve the original candidate inventory in replay identity after affected
  // records are held. Unused entries never produce admission seals.
  if (entries.size !== inventory.records.length) throw Error('Critical assessment inventory record identity mismatch');
  const retained = options.retainedPublication ? validateRetainedKnowledgeComposition(options.retainedPublication) : null;
  const retainedOrigins = new Map(retained?.selectedRecordOrigins.map(origin => [origin.recordId, origin]) ?? []);
  const admissions: CriticalAdmission[] = [], holds: CriticalPublicationHold[] = [];
  for (const record of records) {
    const target = criticalKnowledgeTarget(record);
    if (!target || record.kind !== 'text_model') continue;
    if (record.verification.status !== 'auto-verified' || record.verification.evidenceHash !== knowledgeEvidenceHash(record)) {
      holds.push({ recordId: record.id, reason: 'original_gates_not_admitted' }); continue;
    }
    const retainedOrigin = retainedOrigins.get(record.id);
    if (retained && retainedOrigin) {
      try {
        const origin = retainedKnowledgeRecordOrigin(retained.baseline, retainedOrigin.outputRecordIndex, record);
        if (textLineageRecordSha256(origin) !== textLineageRecordSha256(retainedOrigin)) throw Error('Retained critical record differs from authenticated original');
        const fields = {
          version: 'critical-knowledge-admission-v1' as const, recordId: record.id,
          recordEvidenceSha256: record.verification.evidenceHash, claimProjectionSha256: target.claimProjectionSha256,
          claims: target.claims.map(claim => ({ claimId: claim.claimId, kind: claim.kind, claimSha256: claim.claimSha256 })),
          sourceEvidenceHashes: [...new Set(target.claims.flatMap(claim => [claim.sourceSha256, semanticHash([claim.sourceSha256, claim.quote])]))].sort(),
          labelProvenance: 'retained_original_gates' as const, independentlyValidated: false as const, status: 'admitted' as const,
          retainedPublication: {
            releaseId: retained.baseline.lineage.releaseId, manifestSha256: retained.baseline.lineage.manifestSha256,
            recordsSha256: retained.baseline.lineage.members.records.sha256,
            originalRecordSha256: origin.originalRecordSha256, originalEvidenceHash: origin.originalEvidenceHash,
            originSha256: textLineageRecordSha256(origin),
          },
        };
        admissions.push(CriticalAdmissionSchema.parse({ ...fields, sealSha256: semanticHash(fields) }));
      } catch {
        holds.push({ recordId: record.id, reason: 'critical_assessment_binding' });
      }
      continue;
    }
    const entry = entries.get(record.id);
    if (!entry) { holds.push({ recordId: record.id, reason: 'critical_assessment_missing' }); continue; }
    if (entry.recordEvidenceSha256 !== record.verification.evidenceHash) { holds.push({ recordId: record.id, reason: 'critical_assessment_binding' }); continue; }
    try {
      const verified = await verifyPinnedAssessment(cas, entry.finalArtifactSha256, entry, options);
      const { final, item, assessments } = verified;
      if (final.disposition !== 'ai_reconciled' || final.blocksAffectedAdmission || !final.output || final.output.outcome !== 'supported'
        || final.output.scores.correctness !== 2 || final.output.scores.sources !== 2) {
        holds.push({ recordId: record.id, reason: 'critical_assessment_held' }); continue;
      }
      if (item.itemId !== record.id || !item.criticalTarget || canonicalJson(item.criticalTarget) !== canonicalJson(target)
        || !final.output.criticalReview || final.output.criticalReview.claims.some(claim => claim.verdict !== 'supported')) throw Error('Critical review target differs from exact record');
      const prepared = prepareCriticalAssessment(record, item);
      if (canonicalJson(prepared) !== canonicalJson(item)) throw Error('Critical assessment task projection changed');
      for (const source of item.sources) {
        const proof = await loadPolicyReceipt(cas, source.admissionReceiptSha256);
        const original = record.sources.find(candidate => candidate.id === (source.mcpSourceId ?? source.sourceId) && candidate.sha256 === source.originalSha256);
        if (!original || original.url !== proof.source.url || proof.scope.municipalityId !== record.municipalityId || proof.scope.ags !== record.ags) throw Error('Critical original source scope/URL mismatch');
      }
      const sourceEvidence = new Set<string>();
      for (const claim of target.claims) {
        const assertion = final.output.assertions.find(value => value.claimId === claim.claimId);
        if (!assertion || assertion.sourceId !== claim.sourceId || assertion.subjectId !== claim.subjectId || assertion.objectId !== claim.objectId
          || assertion.stage !== claim.stage || !claim.financialRoles.includes(assertion.financialRole) || assertion.modality !== claim.modality
          || assertion.date !== claim.date || assertion.dateRole !== claim.dateRole) throw Error('Critical assessed stage/financial/date/endpoint roles mismatch');
        const source = item.sources.find(value => (value.mcpSourceId ?? value.sourceId) === assertion.sourceId && value.originalSha256 === claim.sourceSha256);
        if (!source) throw Error('Critical assessed original source mismatch');
        if ('nativeEvidence' in assertion) {
          if (assertion.nativeEvidence.sourceSha256 !== claim.sourceSha256 || String(assertion.nativeEvidence.rawValue) !== claim.quote) throw Error('Critical native evidence is not the actual claimed field');
          sourceEvidence.add(semanticHash(assertion.nativeEvidence));
          if (claim.kind === 'finance') {
            const pending: unknown[] = [JSON.parse((await cas.read(source.textSha256)).toString('utf8'))];
            const roles: string[] = [];
            let visited = 0;
            while (pending.length) {
              if (++visited > 100_000) throw Error('Native financial evidence traversal bound exceeded');
              const node = pending.pop();
              if (Array.isArray(node)) pending.push(...node);
              else if (node && typeof node === 'object') {
                const observation = ObservationSchema.safeParse(node);
                if (observation.success && observation.data.evidence.some(locator => canonicalJson(locator) === canonicalJson(assertion.nativeEvidence))) {
                  if (observation.data.value === null) throw Error('Missing native financial value is not an actual payout');
                  roles.push(observation.data.financialRole);
                } else pending.push(...Object.values(node));
              }
            }
            if (!roles.length || roles.some(role => role !== assertion.financialRole)) throw Error('Native financial role contradicts assessed payment/actual claim');
          }
        } else {
          if (assertion.quote !== claim.quote) throw Error('Critical original quote differs from claimed evidence');
          sourceEvidence.add(semanticHash([claim.sourceSha256, assertion.quote]));
        }
        if (claim.kind === 'finalization' && claim.selector.startsWith('/relations/') === false && !stageEvidenceSupports(claim.stage!, claim.quote)) throw Error('Finalization contradicts deterministic original-source gate');
        if (claim.kind === 'finance' && !('nativeEvidence' in assertion) && actualFinancialRole(claim.quote) !== assertion.financialRole) throw Error('Actual financial role lacks exact original-source support');
        sourceEvidence.add(claim.sourceSha256);
        sourceEvidence.add(semanticHash([claim.sourceSha256, claim.quote]));
      }
      const fields = { version: 'critical-knowledge-admission-v1' as const, recordId: record.id,
        recordEvidenceSha256: record.verification.evidenceHash, claimProjectionSha256: target.claimProjectionSha256,
        claims: target.claims.map(claim => ({ claimId: claim.claimId, kind: claim.kind, claimSha256: claim.claimSha256 })),
        assessmentReceiptSha256: entry.finalArtifactSha256, itemSha256: final.itemSha256,
        receiptHashes: { A: assessments.A.receiptSha256, B: assessments.B.receiptSha256, C: assessments.C.receiptSha256 },
        artifactHashes: { item: entry.itemArtifactSha256, A: entry.AArtifactSha256, B: entry.BArtifactSha256, C: entry.CArtifactSha256 },
        sourceEvidenceHashes: [...sourceEvidence].sort(), correlatedErrorRisk: final.correlatedErrorRisk as Extract<CriticalAdmission, { labelProvenance: 'ai_reconciled' }>['correlatedErrorRisk'],
        labelProvenance: 'ai_reconciled' as const, independentlyValidated: false as const, status: 'admitted' as const };
      admissions.push(CriticalAdmissionSchema.parse({ ...fields, sealSha256: semanticHash(fields) }));
    } catch {
      holds.push({ recordId: record.id, reason: 'critical_assessment_binding' });
    }
  }
  admissions.sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);
  holds.sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);
  if (options.originalAdmissions && canonicalJson(options.originalAdmissions) !== canonicalJson(admissions)) throw Error('Published critical admissions differ from actual private assessment replay');
  const included = records.filter(record => !holds.some(hold => hold.recordId === record.id));
  assertCriticalAdmissionsBound(included, admissions, retained ? { ...retained.baseline.lineage, selectedRecordOrigins: retained.selectedRecordOrigins } : null);
  return { admissions, holds, dependencySha256: semanticHash({
    assessments: inventory.records.map(entry => ({ ...entry })).sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
    retainedPublication: retained ? { lineage: retained.baseline.lineage, recordIds: [...retained.baseline.input.recordIds].sort() } : null,
  }) };
}
