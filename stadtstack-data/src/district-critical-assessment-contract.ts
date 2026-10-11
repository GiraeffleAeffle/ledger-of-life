import { z } from 'zod';
import { HashSchema, semanticHash } from './district-adapter-contract.ts';

export const CRITICAL_ASSESSMENT_VERSION = 'critical-record-assessment-v1';
export const CRITICAL_ADMISSIONS_VERSION = 'critical-knowledge-admissions-v1';
const financialRole = z.enum(['none', 'plan', 'approval', 'payment', 'actual']);
export const CriticalClaimSchema = z.object({
  claimId: z.string().regex(/^critical:[a-f0-9]{64}$/), kind: z.enum(['finalization', 'finance']),
  selector: z.string().min(1), claimSha256: HashSchema,
  sourceId: z.string().min(1), sourceSha256: HashSchema, sourceUrl: z.url(), quote: z.string().min(1).max(1800),
  stage: z.enum(['adopted', 'in_force', 'implemented']).nullable(), financialRoles: z.array(financialRole).min(1),
  subjectId: z.string().min(1), objectId: z.string().nullable(),
  date: z.string().nullable(), dateRole: z.string().nullable(), modality: z.enum(['confirmed', 'historical']),
  context: z.record(z.string(), z.unknown()),
}).strict();
export type CriticalClaim = z.infer<typeof CriticalClaimSchema>;
export const CriticalRecordTargetSchema = z.object({
  version: z.literal(CRITICAL_ASSESSMENT_VERSION), recordId: z.string().min(1), recordEvidenceSha256: HashSchema,
  claimProjectionSha256: HashSchema, claimProjection: z.record(z.string(), z.unknown()),
  claims: z.array(CriticalClaimSchema).min(1),
}).strict();
export const CriticalRecordReviewSchema = z.object({
  recordId: z.string().min(1), recordEvidenceSha256: HashSchema, claimProjectionSha256: HashSchema,
  claims: z.array(z.object({ claimId: z.string().regex(/^critical:[a-f0-9]{64}$/), claimSha256: HashSchema,
    verdict: z.enum(['supported', 'unsupported', 'unresolved']), rationale: z.string().min(20) }).strict()).min(1),
}).strict();
export const CriticalAssessmentInventorySchema = z.object({ records: z.array(z.object({
  recordId: z.string().min(1), recordEvidenceSha256: HashSchema,
  finalArtifactSha256: HashSchema, itemArtifactSha256: HashSchema,
  AArtifactSha256: HashSchema, BArtifactSha256: HashSchema, CArtifactSha256: HashSchema,
}).strict()) }).strict();
export type CriticalAssessmentInventory = z.infer<typeof CriticalAssessmentInventorySchema>;
const fields = z.object({
  version: z.literal('critical-knowledge-admission-v1'), recordId: z.string().min(1), recordEvidenceSha256: HashSchema,
  claimProjectionSha256: HashSchema,
  claims: z.array(CriticalClaimSchema.pick({ claimId: true, kind: true, claimSha256: true })).min(1),
  assessmentReceiptSha256: HashSchema, itemSha256: HashSchema,
  receiptHashes: z.object({ A: HashSchema, B: HashSchema, C: HashSchema }).strict(),
  artifactHashes: z.object({ item: HashSchema, A: HashSchema, B: HashSchema, C: HashSchema }).strict(),
  sourceEvidenceHashes: z.array(HashSchema).min(1),
  correlatedErrorRisk: z.enum(['same-model-family', 'different-providers-still-not-independent-validation']),
  labelProvenance: z.literal('ai_reconciled'), independentlyValidated: z.literal(false), status: z.literal('admitted'),
}).strict();
export const CriticalAdmissionSchema = fields.extend({ sealSha256: HashSchema }).strict().superRefine((seal, ctx) => {
  const { sealSha256, ...body } = seal;
  if (sealSha256 !== semanticHash(body)) ctx.addIssue({ code: 'custom', message: 'Critical admission seal hash mismatch' });
  if (new Set(seal.claims.map(c => c.claimId)).size !== seal.claims.length) ctx.addIssue({ code: 'custom', message: 'Duplicate critical claim seal' });
});
export type CriticalAdmission = z.infer<typeof CriticalAdmissionSchema>;
export const CriticalAdmissionsSchema = z.object({ schemaVersion: z.literal(CRITICAL_ADMISSIONS_VERSION),
  admissions: z.array(CriticalAdmissionSchema) }).strict();
export const CriticalPublicationHoldSchema = z.object({ recordId: z.string().min(1),
  reason: z.enum(['critical_assessment_missing', 'critical_assessment_held', 'critical_assessment_binding', 'original_gates_not_admitted']) }).strict();
export type CriticalPublicationHold = z.infer<typeof CriticalPublicationHoldSchema>;
