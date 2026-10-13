import {z} from 'zod';
import {HashSchema, canonicalJson, digest} from './district-adapter-contract.ts';

export const CANONICALIZATION_VERSION='district-json-v1';
export const STEP_RECEIPT_VERSION='district-step-receipt-v1';
export const JobOutcomeSchema=z.enum(['succeeded','no_supported_case','blocked_policy','blocked_access','held_origin','held_quality','held_execution','deferred','failed_execution','cancelled','superseded']);
export const ReasonCodeSchema=z.enum(['completed','no_supported_case','policy_expired','policy_excluded','origin_unresolved','quality_failed','dependency_uncommitted','lease_expired','lease_lost','authorization_expired','authorization_revoked','authorization_jobs_exhausted','authorization_time_exhausted','authorization_mode_mismatch','notification_unavailable','notification_failed','owner_absent','owner_stopped','max_jobs_reached','max_time_reached','handler_missing','execution_exception','isolation_unavailable','budget_paused','budget_exhausted','budget_expired','budget_overrun','paid_not_authorized','usage_unknown','host_paused','host_capacity','host_delay','host_access_blocked','source_access_barrier','source_http_error','source_policy_refused','source_redirect_refused','source_limit_exceeded','source_unavailable','cas_unavailable','cancellation_requested','superseded','no_ready_jobs','executor_busy']);
export type JobOutcome=z.infer<typeof JobOutcomeSchema>;
export type ReasonCode=z.infer<typeof ReasonCodeSchema>;
const count=z.number().int().nonnegative().nullable();
const usd=z.number().finite().nonnegative().nullable();
const timestamp=z.iso.datetime();
const identifier=z.string().min(1).max(256);
export const ProviderReceiptSchema=z.object({
  provider:identifier,endpoint:identifier,requestedModel:identifier,returnedModel:identifier.nullable(),
  requestId:identifier.nullable(),responseId:identifier.nullable(),requestSha256:HashSchema,responseSha256:HashSchema.nullable(),
  batchId:identifier.nullable(),customId:HashSchema.nullable(),submissionIntentSha256:HashSchema,
  tokens:z.object({standardInput:count,cacheWriteInput:count,cacheReadInput:count,output:count}).strict(),
  actualBilledUsd:usd,estimatedApiUsd:usd,currency:z.literal('USD'),rateCardDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  rateCardSha256:HashSchema.nullable(),reservedMicroUsd:z.number().int().nonnegative().safe(),
  subscriptionUsage:z.object({availability:z.enum(['available','unavailable','not_applicable']),units:count}).strict(),
}).strict();
export const StepReceiptSchema=z.object({
  version:z.literal(STEP_RECEIPT_VERSION),canonicalizationVersion:z.literal(CANONICALIZATION_VERSION),
  id:z.uuid(),runId:z.uuid(),jobKey:HashSchema,step:identifier,lane:identifier,sourceId:identifier,municipalityId:identifier,
  attempt:z.number().int().positive(),leaseToken:z.string().regex(/^[1-9]\d*$/),category:z.enum(['production','evaluation','development']),
  dependencyReceiptIds:z.array(z.uuid()),enqueuedAt:timestamp,startedAt:timestamp,finishedAt:timestamp,
  queueWaitMs:z.number().finite().nonnegative(),elapsedMs:z.number().finite().nonnegative().nullable(),
  cpuUserMicros:count,cpuSystemMicros:count,outcome:JobOutcomeSchema,reasonCode:ReasonCodeSchema,
  inputHashes:z.array(HashSchema),outputHashes:z.array(HashSchema),policyProofSha256:HashSchema.nullable(),originProofSha256:HashSchema.nullable(),
  versions:z.record(z.string(),identifier),cache:z.object({disposition:z.enum(['miss','hit','not_applicable']),originalGenerationReceiptId:z.uuid().nullable()}).strict(),
  provider:ProviderReceiptSchema.nullable(),
  counts:z.object({bytes:count,pages:count,ocrPages:count,rows:count,spans:count,candidates:count,acceptedFacts:count,heldFacts:count,distinctCases:count}).strict(),
}).strict().superRefine((receipt,context)=>{
  if(Date.parse(receipt.finishedAt)<Date.parse(receipt.startedAt)||Date.parse(receipt.startedAt)<Date.parse(receipt.enqueuedAt))context.addIssue({code:'custom',message:'Receipt clock ordering rejected'});
  if(receipt.cache.disposition==='hit'&&!receipt.cache.originalGenerationReceiptId)context.addIssue({code:'custom',message:'Cache hit requires original generation receipt'});
  for(const values of [receipt.dependencyReceiptIds,receipt.inputHashes,receipt.outputHashes])if(new Set(values).size!==values.length)context.addIssue({code:'custom',message:'Duplicate receipt bindings rejected'});
  if(receipt.provider?.subscriptionUsage.availability!=='available'&&receipt.provider?.subscriptionUsage.units!=null)context.addIssue({code:'custom',message:'Unavailable subscription usage cannot be zero-filled'});
});
export type StepReceipt=z.infer<typeof StepReceiptSchema>;
/** Wall-clock attempt timing belongs in this receipt, never in semantic job identity. */
export function encodeStepReceipt(input:StepReceipt):{receipt:StepReceipt;sha256:string;bytes:string} {
  const receipt=StepReceiptSchema.parse(input);
  const bytes=canonicalJson(receipt);
  return {receipt,sha256:digest(bytes),bytes};
}
export const unknownReceiptCounts:StepReceipt['counts']={bytes:null,pages:null,ocrPages:null,rows:null,spans:null,candidates:null,acceptedFacts:null,heldFacts:null,distinctCases:null};
