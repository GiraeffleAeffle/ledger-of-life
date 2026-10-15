import {z} from 'zod';
import type {Pool} from 'pg';
import {HashSchema,canonicalJson,semanticHash} from './district-adapter-contract.ts';
import {canonicalJobIdentity,type DistrictJobSpec} from './district-jobs.ts';
import {ReasonCodeSchema,encodeStepReceipt,type StepReceipt} from './district-step-receipt.ts';

const fields={documentId:z.string().min(1),jobKey:HashSchema,receiptId:z.uuid(),receiptSha256:HashSchema,reasonCode:ReasonCodeSchema};
export const TerminalDocumentExceptionSchema=z.object({...fields,step:z.enum(['residual_prepare','residual_extract'])}).strict();
export const TerminalAssessmentExceptionSchema=z.object({...fields,step:z.enum(['assessment_prepare','assessment_a','assessment_b','assessment_c','assessment_reconcile'])}).strict();
export type TerminalDocumentException=z.infer<typeof TerminalDocumentExceptionSchema>;
export type TerminalAssessmentException=z.infer<typeof TerminalAssessmentExceptionSchema>;
export type TerminalException=TerminalDocumentException|TerminalAssessmentException;
const heldOutcomes=new Set(['blocked_policy','blocked_access','held_origin','held_quality','held_execution','failed_execution']);
interface ReceiptRow {job_id:string;job_key:string;job_step:string;spec:DistrictJobSpec;state:string;reason_code:string|null;current_attempt:number;receipt_id:string;receipt_job_id:string;run_id:string;attempt:number;fencing_token:string;outcome:string;receipt:StepReceipt;receipt_sha256:string}
export function authenticateTerminalReceiptRow(row:ReceiptRow){
 const encoded=encodeStepReceipt(row.receipt),receipt=encoded.receipt,spec=row.spec;
 if(encoded.sha256!==row.receipt_sha256||receipt.id!==row.receipt_id||row.receipt_job_id!==row.job_id||receipt.runId!==row.run_id||receipt.attempt!==row.attempt||receipt.leaseToken!==row.fencing_token||receipt.outcome!==row.outcome||receipt.jobKey!==row.job_key||canonicalJobIdentity(spec).jobKey!==row.job_key||spec.step!==row.job_step||receipt.step!==spec.step||receipt.lane!==spec.lane||receipt.policyProofSha256!==spec.policyProofSha256||receipt.municipalityId!==spec.sourceScope.municipalityId||receipt.sourceId!==spec.sourceScope.sourceId||canonicalJson([...receipt.inputHashes].sort())!==canonicalJson([...spec.inputArtifactHashes].sort()))throw Error('Terminal exception committed receipt row binding mismatch');
 return encoded;
}
/** Current held disposition only: a resumed, leased or superseded attempt cannot
 * be re-labelled as a permanent exception. History consists of real receipts,
 * not inferred manual-resume events. No job or receipt is mutated here. */
export async function loadTerminalException(pool:Pool,pin:TerminalException){
 const rows=await pool.query<ReceiptRow>(`SELECT j.id AS job_id,j.job_key,j.step AS job_step,j.spec,j.state,j.reason_code,j.attempt AS current_attempt,r.id AS receipt_id,r.job_id AS receipt_job_id,r.run_id,r.attempt,r.fencing_token,r.outcome,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id WHERE j.job_key=$1 ORDER BY r.attempt,r.id`,[pin.jobKey]);
 if(!rows.rows.length)throw Error('Terminal exception committed receipt unavailable');
 const history=rows.rows.map(row=>({row,...authenticateTerminalReceiptRow(row)})),selected=history.find(entry=>entry.receipt.id===pin.receiptId);
 if(!selected||selected.sha256!==pin.receiptSha256||selected.receipt.step!==pin.step||selected.receipt.reasonCode!==pin.reasonCode||!heldOutcomes.has(selected.receipt.outcome)||selected.row.state!==selected.receipt.outcome||selected.row.reason_code!==pin.reasonCode||selected.row.current_attempt!==selected.receipt.attempt||history.some(entry=>entry.receipt.attempt>selected.receipt.attempt))throw Error('Terminal exception is not the current committed held attempt');
 return {spec:selected.row.spec,receipt:selected.receipt,sha256:selected.sha256,attemptHistory:history.map(({receipt,sha256})=>({receipt,sha256}))};
}
export function assertTerminalSourceScope(spec:DistrictJobSpec,scope:DistrictJobSpec['sourceScope'],policyReceiptSha256:string){
 if(semanticHash(spec.sourceScope)!==semanticHash(scope)||spec.policyProofSha256!==policyReceiptSha256)throw Error('Terminal exception changes source scope or original policy');
}
