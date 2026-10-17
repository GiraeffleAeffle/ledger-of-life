import {z} from 'zod';
import {HashSchema} from './district-adapter-contract.ts';
import {StepReceiptSchema,encodeStepReceipt} from './district-step-receipt.ts';

const extractionPin=z.object({documentId:z.string().min(1),jobKey:HashSchema,receiptId:z.uuid(),receiptSha256:HashSchema,extractionArtifactSha256:HashSchema,sourceSha256:HashSchema}).strict();
/** A seal disposition, never a fabricated job outcome or caller-supplied hold. */
export const DuplicateSourceContentExceptionSchema=extractionPin.extend({
 step:z.literal('residual_extract'),reasonCode:z.literal('duplicate_source_content'),
 municipalityId:z.string().min(1),sourceId:z.string().min(1),corpusSha256:HashSchema,sourceUrl:z.url(),
 canonical:extractionPin,selectionRule:z.literal('smallest_document_id_v1'),
 outcome:StepReceiptSchema.shape.outcome,receipt:StepReceiptSchema,
 attemptHistory:z.array(z.object({receipt:StepReceiptSchema,sha256:HashSchema}).strict()).min(1),
 excludedRecords:z.array(z.object({recordId:z.string().min(1),evidenceSha256:HashSchema}).strict()),
 excludedAssessmentJobKeys:z.array(HashSchema),
}).strict();
export type DuplicateSourceContentException=z.infer<typeof DuplicateSourceContentExceptionSchema>;
export function assertDuplicateSourceContentReceipt(exception:DuplicateSourceContentException){
 const encoded=encodeStepReceipt(exception.receipt),receipt=encoded.receipt;
 if(encoded.sha256!==exception.receiptSha256||receipt.id!==exception.receiptId||receipt.jobKey!==exception.jobKey||receipt.step!==exception.step||receipt.municipalityId!==exception.municipalityId||receipt.sourceId!==exception.sourceId||receipt.outcome!==exception.outcome||receipt.outputHashes.length!==1||receipt.outputHashes[0]!==exception.extractionArtifactSha256||exception.sourceSha256!==exception.canonical.sourceSha256)throw Error('Duplicate source content receipt/output binding mismatch');
 if(!exception.attemptHistory.some(entry=>entry.sha256===exception.receiptSha256))throw Error('Duplicate source content omits its selected attempt');
 for(const entry of exception.attemptHistory)if(entry.receipt.jobKey!==exception.jobKey||encodeStepReceipt(entry.receipt).sha256!==entry.sha256)throw Error('Duplicate source content attempt history mismatch');
}
