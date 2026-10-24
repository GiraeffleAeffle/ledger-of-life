import {join} from 'node:path';
import type {Pool} from 'pg';
import {z} from 'zod';
import {HashSchema,canonicalJson,semanticHash} from './district-adapter-contract.ts';
import {canonicalJobIdentity,type DistrictJobSpec} from './district-jobs.ts';
import {encodeStepReceipt,type StepReceipt} from './district-step-receipt.ts';
import type {DistrictCas} from './district-cas.ts';
import {DistrictKnowledgeRecordSchema} from './district-schema.ts';
import {assessmentItemSchema} from './district-assessment.ts';
import {assertManagedSourceReadable,type CivicPolicyOptions} from './civic-opt-out.ts';
import {PreparedDocumentSchema,verifyPreparedDocument} from './district-prepared-document.ts';

const predecessor=z.object({jobKey:HashSchema,receiptId:z.uuid(),receiptSha256:HashSchema}).strict();
const itemEntry=z.object({itemArtifactSha256:HashSchema,recordArtifactSha256:HashSchema,maxModelCalls:z.number().int().min(2).max(48)}).strict();
const heldEntry=z.object({recordArtifactSha256:HashSchema,itemArtifactSha256:HashSchema.nullable(),holdReceiptArtifactSha256:HashSchema}).strict();
export const AssessmentItemHoldPinSchema=z.object({preparationJobKey:HashSchema,itemBundleArtifactSha256:HashSchema,holdReceiptArtifactSha256:HashSchema}).strict();
export const AssessmentItemHoldReceiptSchema=z.object({version:z.literal('r1-assessment-item-hold-v1'),preparationJobKey:HashSchema,assessmentQueueContractSha256:HashSchema,
 recordId:z.string().min(1),recordArtifactSha256:HashSchema,itemArtifactSha256:HashSchema.nullable(),extractionArtifactSha256:HashSchema,
 preparedArtifactSha256:HashSchema,preparedTextSha256:HashSchema,originalSha256:HashSchema,policyReceiptSha256:HashSchema,
 outcome:z.literal('held_quality'),reasonCode:z.enum(['assessment_context_exceeded','quality_failed']),assessmentProviderCalls:z.literal(0)}).strict();
export const AssessmentItemBundleSchema=z.discriminatedUnion('version',[
 // Immutable historical bundles retain their original interpretation.
 z.object({version:z.literal('r1-assessment-items-v1'),items:z.array(itemEntry)}).strict(),
 z.object({version:z.literal('r1-assessment-items-v2'),items:z.array(itemEntry),heldItems:z.array(heldEntry)}).strict(),
]);
export type AssessmentItemHoldPin=z.infer<typeof AssessmentItemHoldPinSchema>;
async function committed(pool:Pool,jobKey:string,step:string){
 const rows=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.job_key=$1 AND j.step=$2 AND j.state='succeeded' ORDER BY r.attempt DESC LIMIT 1`,[jobKey,step]);
 if(rows.rows.length!==1)throw Error('Item hold requires committed successful ancestry');
 const row=rows.rows[0],encoded=encodeStepReceipt(row.receipt);
 if(encoded.sha256!==row.receipt_sha256||canonicalJobIdentity(row.spec).jobKey!==jobKey||encoded.receipt.jobKey!==jobKey||encoded.receipt.step!==step||encoded.receipt.policyProofSha256!==row.spec.policyProofSha256||canonicalJson([...encoded.receipt.inputHashes].sort())!==canonicalJson([...row.spec.inputArtifactHashes].sort()))throw Error('Item hold committed receipt binding mismatch');
 return {...row,receipt:encoded.receipt,pin:{jobKey,receiptId:encoded.receipt.id,receiptSha256:encoded.sha256}};
}
/** Read-only authentication of immutable child dispositions, including all-held
 * successful preparations. Never reinterpret a historical hold under today's
 * request size or source policy; callers separately enforce current source gates. */
export async function loadAssessmentItemHold(pool:Pool,cas:DistrictCas,raw:unknown,policy:CivicPolicyOptions={}){
 const pin=AssessmentItemHoldPinSchema.parse(raw),preparation=await committed(pool,pin.preparationJobKey,'assessment_prepare');
 const readBytes=async(hash:string)=>{HashSchema.parse(hash);await assertManagedSourceReadable(join(cas.root,'sha256',hash.slice(0,2),hash),policy);return cas.read(hash);};
 const read=async(hash:string)=>JSON.parse((await readBytes(hash)).toString('utf8'));
 if(!preparation.receipt.outputHashes.includes(pin.holdReceiptArtifactSha256))throw Error('Item hold is not a committed preparation output');
 const hold=AssessmentItemHoldReceiptSchema.parse(await read(pin.holdReceiptArtifactSha256));
 if(hold.preparationJobKey!==pin.preparationJobKey||hold.assessmentQueueContractSha256!==preparation.spec.semanticContractSha256||hold.policyReceiptSha256!==preparation.spec.policyProofSha256)throw Error('Item hold changes its preparation contract or policy');
 if(!preparation.receipt.outputHashes.includes(pin.itemBundleArtifactSha256))throw Error('Item hold bundle is not a committed preparation output');
 const bundle=AssessmentItemBundleSchema.parse(await read(pin.itemBundleArtifactSha256));
 if(bundle.version!=='r1-assessment-items-v2')throw Error('Item hold requires a versioned disposition bundle');
 const entries=bundle.heldItems.filter(entry=>entry.holdReceiptArtifactSha256===pin.holdReceiptArtifactSha256);
 if(entries.length!==1||entries[0].recordArtifactSha256!==hold.recordArtifactSha256||entries[0].itemArtifactSha256!==hold.itemArtifactSha256||bundle.items.some(entry=>entry.recordArtifactSha256===hold.recordArtifactSha256)||new Set([...bundle.items,...bundle.heldItems].map(entry=>entry.recordArtifactSha256)).size!==bundle.items.length+bundle.heldItems.length)throw Error('Item hold bundle coverage or overlap mismatch');
 for(const hash of [hold.recordArtifactSha256,...(hold.itemArtifactSha256?[hold.itemArtifactSha256]:[])])if(!preparation.receipt.outputHashes.includes(hash))throw Error('Item hold omits committed artifacts');
 const selector=z.object({version:z.literal('r1-assessment-item-job-v1'),extraction:predecessor,extractionArtifactSha256:HashSchema}).strict().parse(preparation.spec.selector),extraction=await committed(pool,selector.extraction.jobKey,'residual_extract');
 if(canonicalJson(selector.extraction)!==canonicalJson(extraction.pin)||!preparation.receipt.dependencyReceiptIds.includes(extraction.pin.receiptId)||!preparation.spec.inputArtifactHashes.includes(selector.extractionArtifactSha256)||selector.extractionArtifactSha256!==hold.extractionArtifactSha256||!extraction.receipt.outputHashes.includes(hold.extractionArtifactSha256)||canonicalJson(extraction.spec.sourceScope)!==canonicalJson(preparation.spec.sourceScope)||extraction.spec.policyProofSha256!==hold.policyReceiptSha256)throw Error('Item hold extraction ancestry mismatch');
 const envelope=z.object({documentId:z.string(),preparationJobKey:HashSchema,preparationReceiptId:z.uuid(),preparationReceiptSha256:HashSchema,preparedArtifactSha256:HashSchema,policyReceiptSha256:HashSchema,result:z.object({sourceSha256:HashSchema,preparedSha256:HashSchema,records:z.array(DistrictKnowledgeRecordSchema)}).passthrough()}).passthrough().parse(await read(hold.extractionArtifactSha256));
 const record=DistrictKnowledgeRecordSchema.parse(await read(hold.recordArtifactSha256)),matches=envelope.result.records.filter(candidate=>candidate.id===hold.recordId);
 if(record.id!==hold.recordId||semanticHash(record)!==hold.recordArtifactSha256||matches.length!==1||canonicalJson(matches[0])!==canonicalJson(record)||envelope.preparedArtifactSha256!==hold.preparedArtifactSha256||envelope.result.sourceSha256!==hold.originalSha256||envelope.policyReceiptSha256!==hold.policyReceiptSha256)throw Error('Item hold original record binding mismatch');
 if(canonicalJson([...bundle.items,...bundle.heldItems].map(entry=>entry.recordArtifactSha256).sort())!==canonicalJson(envelope.result.records.map(record=>semanticHash(record)).sort()))throw Error('Item hold bundle does not cover the exact extraction');
 const parser=await committed(pool,envelope.preparationJobKey,'residual_prepare'),prepared=PreparedDocumentSchema.parse(await read(hold.preparedArtifactSha256));
 if(parser.pin.receiptId!==envelope.preparationReceiptId||parser.pin.receiptSha256!==envelope.preparationReceiptSha256||!extraction.receipt.dependencyReceiptIds.includes(parser.pin.receiptId)||!parser.receipt.outputHashes.includes(hold.preparedArtifactSha256)||!parser.receipt.outputHashes.includes(hold.preparedTextSha256)||prepared.textSha256!==hold.preparedTextSha256||prepared.sourceSha256!==hold.originalSha256)throw Error('Item hold prepared text ancestry mismatch');
 const original=await readBytes(hold.originalSha256);try{verifyPreparedDocument(prepared,{...prepared,receiptSha256:envelope.result.preparedSha256},original);}finally{original.fill(0);}
 const text=await readBytes(hold.preparedTextSha256);try{if(text.toString('utf8')!==prepared.text)throw Error('Item hold prepared text changed');}finally{text.fill(0);}
 if(hold.itemArtifactSha256){const item=assessmentItemSchema.parse(await read(hold.itemArtifactSha256));if(item.itemId!==record.id||item.sourceRecord?.recordSha256!==hold.recordArtifactSha256||canonicalJson(item.sourceRecord.record)!==canonicalJson(record)||item.sources.some(source=>source.originalSha256!==hold.originalSha256||source.textSha256!==hold.preparedTextSha256||source.parserReceiptSha256!==hold.preparedArtifactSha256||source.admissionReceiptSha256!==hold.policyReceiptSha256))throw Error('Item hold retained item binding mismatch');}
 return {pin,hold,record,preparation,extraction,documentId:envelope.documentId};
}
