import {z} from 'zod';
import {HashSchema,canonicalJson} from './district-adapter-contract.ts';
import {StepReceiptSchema} from './district-step-receipt.ts';

const pin=z.object({path:z.string().min(1),sha256:HashSchema}).strict();
const receiptSummary=z.object({id:StepReceiptSchema.shape.id,jobKey:StepReceiptSchema.shape.jobKey,step:StepReceiptSchema.shape.step,outcome:StepReceiptSchema.shape.outcome,reasonCode:StepReceiptSchema.shape.reasonCode});
export const Step8QueueEvidenceSchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-step8-queue-evidence-v1'),extractionRun:pin,documentId:z.string(),jobKey:HashSchema,
 stepReceipts:z.array(z.object({sha256:HashSchema,receipt:receiptSummary,extractionRun:pin}).strict()),
 extractionAttemptHistory:z.object({extractionRun:pin,pointer:z.literal('/queue/extractionAttemptHistory')}).strict().optional(),
}).strict();

/** The complete immutable source queue is already a replay dependency. Never
 * multiply its source-wide specs/receipts/accounting by the document count.
 * Inline only the receipt fields used to classify this exact document; retain
 * the original receipt hashes and pin all remaining evidence without loss. */
export function step8QueueEvidence(extractionRun:z.infer<typeof pin>,queue:unknown,documentId:string,jobKey:string){
 const source=z.object({stepReceipts:z.array(z.object({sha256:HashSchema,receipt:receiptSummary}).passthrough()),extractionAttemptHistory:z.unknown().optional()}).passthrough().parse(queue);
 return Step8QueueEvidenceSchema.parse({schemaVersion:'stadtstack-r1-step8-queue-evidence-v1',extractionRun,documentId,jobKey,
  stepReceipts:source.stepReceipts.filter(row=>row.receipt.jobKey===jobKey&&['residual_prepare','residual_extract'].includes(row.receipt.step)).map(row=>({sha256:row.sha256,receipt:receiptSummary.parse(row.receipt),extractionRun})),
  ...(source.extractionAttemptHistory===undefined?{}:{extractionAttemptHistory:{extractionRun,pointer:'/queue/extractionAttemptHistory'}})});
}

/** Acceptance recomputes the projection from the SHA-pinned original, rather
 * than treating the compact classification metadata as independent evidence. */
export async function authenticateStep8QueueEvidence(raw:unknown,documentId:string,jobKey:string,read:(inputPin:z.infer<typeof pin>)=>Promise<unknown>){
 const selected=Step8QueueEvidenceSchema.parse(raw);
 if(selected.documentId!==documentId||selected.jobKey!==jobKey)throw Error('Step8 queue evidence document/job mismatch');
 const run=z.object({queue:z.unknown()}).passthrough().parse(await read(selected.extractionRun));
 if(canonicalJson(selected)!==canonicalJson(step8QueueEvidence(selected.extractionRun,run.queue,documentId,jobKey)))throw Error('Step8 queue evidence differs from its pinned original');
 return selected;
}
