import {readFile,lstat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {HashSchema,ScopeSchema,canonicalJson,digest} from './district-adapter-contract.ts';
import {canonicalJobIdentity,type ClaimedJob,type DistrictJobSpec} from './district-jobs.ts';
import {encodeStepReceipt,type StepReceipt} from './district-step-receipt.ts';
import {assertCivicPolicyAuthority,type CivicPolicyOptions} from './civic-opt-out.ts';
import {completedCodexIntents} from './district-subscription-cache.ts';
import {subscriptionUsageStatus} from './district-subscription-usage.ts';
import {guardDistrictPool} from './district-database.ts';

export const CODEX_UNSETTLED_RETRY_VERSION='r1-codex-unsettled-retry-v1';
const ISSUER='R1 VM lead (omp session in tmux on codex-workstation)';
const authorities={parentApproval:{id:'r1-nine-town-models-2026-10-13',sha256:'2ac6267d17ed08452665a0b2de92ec4da89915fe8619b668b85585301327502b'},autonomyApproval:{id:'r1-autonomy-and-release-2026-10-14',sha256:'865e80d2aad2ec23250b83b50c012639d0b04f068fc64d42eabe1b36a82b35f5'},holdPolicy:{id:'r1-lead-hold-resume-policy-2026-10-15',sha256:'c5b15eb22f544b63a8fbf71eb9b5cfbf334ee37340c542a223ad6a5464e4f493'},holdPolicyAmendment:{id:'r1-lead-hold-resume-policy-2026-10-15-amendment-1',sha256:'4ef8a73624eeb33672dc41b367f4c56c7ef9dcbd9df77bff30fffc9d5648befe'}} as const;
const pinSchema=z.object({id:z.string(),sha256:HashSchema}).strict();
export const CodexUnsettledRetrySchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-operator-action-record-v1'),id:z.string().regex(/^r1-codex-unsettled-retry-[a-z0-9-]+$/),action:z.literal('codex-unsettled-intent-bounded-retry'),version:z.literal(CODEX_UNSETTLED_RETRY_VERSION),issuedBy:z.literal(ISSUER),issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
 parentApproval:pinSchema,autonomyApproval:pinSchema,holdPolicy:pinSchema,holdPolicyAmendment:pinSchema,
 binding:z.object({scope:ScopeSchema,step:z.enum(['residual_extract','assessment_a','assessment_c']),jobKey:HashSchema,jobId:z.uuid(),semanticContractSha256:HashSchema,documentId:z.string().min(1).optional(),originalSha256:HashSchema,intentId:z.uuid(),requestSha256:HashSchema,runId:z.uuid(),authorizationId:z.uuid(),fencingToken:z.number().int().positive(),priorAttempt:z.number().int().positive(),heldReceiptId:z.uuid(),heldReceiptSha256:HashSchema}).strict(),
 completionState:z.literal('completion_unknown'),decision:z.literal('bounded_retry'),
 bounds:z.object({maxReplacementIntents:z.literal(1),allowedAttempt:z.number().int().positive(),maxModelCallsPerOriginal:z.literal(48),paidMicroUsd:z.literal(0),refund:z.literal(false),resetLifetimeCalls:z.literal(false),extraResumes:z.literal(0),maxResumesPerJobKey:z.literal(2)}).strict(),reason:z.string().min(1).max(4096)
}).strict().superRefine((record,ctx)=>{
 if(Date.parse(record.issuedAt)>=Date.parse(record.expiresAt)||Date.parse(record.expiresAt)>Date.parse('2026-10-25T21:59:59Z')||record.bounds.allowedAttempt!==record.binding.priorAttempt+1)ctx.addIssue({code:'custom',message:'Retry exceeds its original approval/attempt bounds'});
 for(const [key,pin] of Object.entries(authorities))if(canonicalJson(record[key as keyof typeof authorities])!==canonicalJson(pin))ctx.addIssue({code:'custom',message:'Delegated authority pin differs'});
 if(record.binding.step==='residual_extract'?!record.binding.documentId:record.binding.documentId!==undefined)ctx.addIssue({code:'custom',message:'Only a residual selector carries a document ID; assessment identity is the exact job/original binding'});
});
export type CodexUnsettledRetry=z.infer<typeof CodexUnsettledRetrySchema>;
export interface CodexDispositionFixture {policy:CivicPolicyOptions}
export interface CodexDispositionOptions {fixture?:CodexDispositionFixture;casRoot?:string;policy?:CivicPolicyOptions}
type Query=Pick<PoolClient,'query'>;
// The shared report reads only .query; retain this transaction's PoolClient
// rather than moving the read to the pool or asserting a client is a full Pool.
const querySubscriptionUsageStatus=subscriptionUsageStatus as (connection:Pick<Pool,'query'>)=>ReturnType<typeof subscriptionUsageStatus>;
interface Stored {record_sha256:string;record_id:string;record_bytes:Buffer;intent_id:string;job_id:string;held_receipt_id:string;held_receipt_sha256:string;original_sha256:string;request_sha256:string;run_id:string;authorization_id:string;prior_attempt:number;allowed_attempt:number;issued_at:Date;expires_at:Date;committed_at:Date;replacement_intent_id:string|null}
export interface UnknownCodexDisposition {intentId:string;requestSha256:string;recordId:string;recordSha256:string;completionState:'completion_unknown';decision:'bounded_retry';priorAttempt:number;allowedAttempt:number;heldReceiptId:string;heldReceiptSha256:string;replacementIntentId:string|null;expiresAt:string}
function requireThat(value:unknown,message='Codex unsettled retry refused'):asserts value{if(!value)throw Error(message);}
async function fixtureMode(options:CodexDispositionOptions){if(!options.fixture)return false;requireThat((await assertCivicPolicyAuthority(options.fixture.policy)).mode==='isolated-fixture','Codex disposition fixture requires an isolated authority');return true;}
async function approvalBytes(){for(const pin of Object.values(authorities))requireThat(digest(await readFile(new URL('../reports/approvals/'+pin.id+'.json',import.meta.url)))===pin.sha256,'Codex disposition authority bytes differ');}
/** Public, committed lead metadata only; never credentials or provider output. */
export async function readCodexUnsettledRecord(id:string,sha256:string,options:CodexDispositionOptions={}){
 requireThat(/^r1-codex-unsettled-retry-[a-z0-9-]+$/.test(id));HashSchema.parse(sha256);
 const path=new URL('../reports/approvals/'+id+'.json',import.meta.url),stat=await lstat(path);requireThat(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=2097152);
 const bytes=await readFile(path);requireThat(digest(bytes)===sha256,'Codex disposition record pin differs');
 if(!await fixtureMode(options)){
  const root=fileURLToPath(new URL('../../',import.meta.url)),relative='stadtstack-data/reports/approvals/'+id+'.json';
  const {stdout}=await promisify(execFile)('git',['-C',root,'show','HEAD:'+relative],{encoding:'buffer',maxBuffer:2097152});requireThat(stdout.equals(bytes),'Codex disposition must be committed at the execution HEAD');
 }
 const record=CodexUnsettledRetrySchema.parse(JSON.parse(bytes.toString('utf8')));requireThat(record.id===id);return {record,bytes,sha256};
}
async function boundEvidence(client:Query,record:CodexUnsettledRetry){
 const b=record.binding;
 const result=await client.query(`SELECT j.id,j.job_key,j.spec,j.state,j.reason_code,j.attempt,j.cancellation_requested,j.reserved_micro_usd,j.policy_proof_sha256,p.state AS policy_state,p.checked_at AS policy_checked_at,p.expires_at AS policy_expires_at,
 r.receipt,r.receipt_sha256,r.attempt AS receipt_attempt,r.fencing_token AS receipt_fence,r.outcome,r.run_id AS receipt_run_id,
 i.original_sha256,i.request_sha256,i.fencing_token AS intent_fence,i.created_at AS intent_created_at,i.stage,i.paid_micro_usd,a.authorization_id AS intent_authorization_id,a.run_id AS intent_run_id,
 e.state AS run_state,e.finished_at AS run_finished_at,e.authorization_id AS run_authorization_id,auth.state AS authorization_state
 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.id=$2
 JOIN district_pipeline.r1_codex_call_intents i ON i.job_id=j.id AND i.id=$3
 JOIN district_pipeline.r1_codex_call_authorizations a ON a.intent_id=i.id
 JOIN district_pipeline.executor_runs e ON e.id=r.run_id
 JOIN district_pipeline.preauthorizations auth ON auth.id=e.authorization_id
 LEFT JOIN district_pipeline.policy_decisions p ON p.proof_sha256=j.policy_proof_sha256 WHERE j.job_key=$1`,[b.jobKey,b.heldReceiptId,b.intentId]);
 requireThat(result.rows.length===1);const row=result.rows[0],spec=row.spec as DistrictJobSpec,encoded=encodeStepReceipt(row.receipt),receipt=encoded.receipt;
 requireThat(row.id===b.jobId&&canonicalJobIdentity(spec).jobKey===b.jobKey&&spec.step===b.step&&spec.semanticContractSha256===b.semanticContractSha256&&canonicalJson(spec.sourceScope)===canonicalJson(b.scope));
 requireThat(encoded.sha256===b.heldReceiptSha256&&row.receipt_sha256===encoded.sha256&&receipt.id===b.heldReceiptId&&receipt.jobKey===b.jobKey&&receipt.step===b.step&&receipt.runId===b.runId&&receipt.attempt===b.priorAttempt&&receipt.leaseToken===String(b.fencingToken)&&receipt.policyProofSha256===spec.policyProofSha256);
 requireThat(receipt.outcome==='held_execution'&&['max_time_reached','lease_lost','lease_expired','execution_exception'].includes(receipt.reasonCode)&&row.receipt_attempt===receipt.attempt&&String(row.receipt_fence)===receipt.leaseToken);
 requireThat(row.original_sha256===b.originalSha256&&row.request_sha256===b.requestSha256&&Number(row.intent_fence)===b.fencingToken&&row.intent_authorization_id===b.authorizationId&&row.intent_run_id===b.runId&&row.receipt_run_id===b.runId&&row.stage===b.step&&Number(row.paid_micro_usd)===0);
 requireThat(['held','completed'].includes(row.run_state)&&row.run_authorization_id===b.authorizationId&&row.run_finished_at&&new Date(row.run_finished_at).getTime()>=Date.parse(receipt.finishedAt)&&row.authorization_state==='approved');
 requireThat(new Date(row.intent_created_at).getTime()>=Date.parse(receipt.startedAt)&&new Date(row.intent_created_at).getTime()<=Date.parse(receipt.finishedAt)&&Date.parse(receipt.finishedAt)<=Date.parse(record.issuedAt));
 if(b.step==='residual_extract')requireThat((spec.selector as {documentId?:string}).documentId===b.documentId);
 return {row,spec,receipt};
}
function authenticateStored(row:Stored,record:CodexUnsettledRetry){const b=record.binding;requireThat(digest(row.record_bytes)===row.record_sha256&&row.intent_id===b.intentId&&row.job_id===b.jobId&&row.held_receipt_id===b.heldReceiptId&&row.held_receipt_sha256===b.heldReceiptSha256&&row.original_sha256===b.originalSha256&&row.request_sha256===b.requestSha256&&row.run_id===b.runId&&row.authorization_id===b.authorizationId&&row.prior_attempt===b.priorAttempt&&row.allowed_attempt===record.bounds.allowedAttempt&&new Date(row.issued_at).getTime()===Date.parse(record.issuedAt)&&new Date(row.expires_at).getTime()===Date.parse(record.expiresAt)&&new Date(row.committed_at)>=new Date(record.issuedAt)&&new Date(row.committed_at)<new Date(record.expiresAt));}
function requireStoredRecordId(row:Stored,record:CodexUnsettledRetry){requireThat(row.record_id===record.id);}
/** SELECT-only. A disposition proves an explicit unknown-effect decision, NEVER completion. */
export async function readUnknownCodexDispositions(client:Query,jobKey:string,options:CodexDispositionOptions={}):Promise<UnknownCodexDisposition[]>{
 HashSchema.parse(jobKey);const fixture=await fixtureMode(options);
 const found=await client.query<Stored>(`SELECT d.*,c.replacement_intent_id FROM district_pipeline.r1_codex_unsettled_retries d JOIN district_pipeline.jobs j ON j.id=d.job_id LEFT JOIN district_pipeline.r1_codex_unsettled_retry_intents c ON c.disposition_sha256=d.record_sha256 WHERE j.job_key=$1 ORDER BY d.committed_at,d.record_sha256`,[jobKey]);
 if(!found.rows.length)return [];await approvalBytes();const proofs:UnknownCodexDisposition[]=[];
 for(const row of found.rows){const record=CodexUnsettledRetrySchema.parse(JSON.parse(row.record_bytes.toString('utf8')));authenticateStored(row,record);requireThat(record.binding.jobKey===jobKey);
  requireStoredRecordId(row,record);
  if(!fixture){const raw=await readFile(new URL('../reports/approvals/'+record.id+'.json',import.meta.url));requireThat(raw.equals(row.record_bytes),'Committed retry authority changed or disappeared');}
  await boundEvidence(client,record);
  if(row.replacement_intent_id){const replacement=await client.query(`SELECT i.job_id,i.original_sha256,i.request_sha256,i.paid_micro_usd,i.fencing_token,i.stage FROM district_pipeline.r1_codex_call_intents i WHERE i.id=$1`,[row.replacement_intent_id]);requireThat(replacement.rows.length===1);const i=replacement.rows[0];requireThat(i.job_id===row.job_id&&i.original_sha256===row.original_sha256&&i.request_sha256===row.request_sha256&&Number(i.paid_micro_usd)===0&&i.stage===record.binding.step&&Number(i.fencing_token)>record.binding.fencingToken);}
  proofs.push({intentId:row.intent_id,requestSha256:row.request_sha256,recordId:record.id,recordSha256:row.record_sha256,completionState:'completion_unknown',decision:'bounded_retry',priorAttempt:row.prior_attempt,allowedAttempt:row.allowed_attempt,heldReceiptId:row.held_receipt_id,heldReceiptSha256:row.held_receipt_sha256,replacementIntentId:row.replacement_intent_id,expiresAt:new Date(row.expires_at).toISOString()});
 }
 return proofs;
}
/** Operator settlement admission, not an assertion that the answer exists.
 * An unconsumed permission is usable only for the exact still-held attempt and
 * its genuine remaining lifetime. A consumed decision stays historical evidence. */
export async function readCodexRetrySettlement(client:Query,jobKey:string,options:CodexDispositionOptions={}){
 const proofs=await readUnknownCodexDispositions(client,jobKey,options);if(!proofs.length)return [];
 const result=await client.query(`SELECT j.state,j.attempt,r.id AS receipt_id,r.receipt_sha256,clock_timestamp() AS now FROM district_pipeline.jobs j LEFT JOIN LATERAL(SELECT id,receipt_sha256 FROM district_pipeline.step_receipts WHERE job_id=j.id ORDER BY attempt DESC LIMIT 1) r ON true WHERE j.job_key=$1`,[jobKey]);
 requireThat(result.rows.length===1);const job=result.rows[0];
 return proofs.filter(proof=>proof.replacementIntentId||['held_execution','queued','deferred'].includes(job.state)&&job.attempt===proof.priorAttempt&&job.receipt_id===proof.heldReceiptId&&job.receipt_sha256===proof.heldReceiptSha256&&new Date(job.now)<new Date(proof.expiresAt));
}
/** Append one decision only. Does not resume/authorize a job or alter any prior intent. */
export async function registerCodexUnsettledRetry(pool:Pool,input:{recordBytes:Buffer;recordSha256:string},options:CodexDispositionOptions={}){
 guardDistrictPool(pool);requireThat(input.recordBytes.length<=2097152&&digest(input.recordBytes)===input.recordSha256);const record=CodexUnsettledRetrySchema.parse(JSON.parse(input.recordBytes.toString('utf8'))),fixture=await fixtureMode(options);await approvalBytes();
 if(!fixture){requireThat(userInfo().username==='max','Only the lead OS operator may register an unknown-effect retry');const pinned=await readCodexUnsettledRecord(record.id,input.recordSha256);requireThat(pinned.bytes.equals(input.recordBytes));await assertCivicPolicyAuthority(options.policy);}
 const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(18441,81)');
  const existing=await client.query<Stored>('SELECT d.*,c.replacement_intent_id FROM district_pipeline.r1_codex_unsettled_retries d LEFT JOIN district_pipeline.r1_codex_unsettled_retry_intents c ON c.disposition_sha256=d.record_sha256 WHERE d.intent_id=$1',[record.binding.intentId]);
  if(existing.rows.length){requireThat(existing.rows.length===1&&existing.rows[0].record_sha256===input.recordSha256,'Intent already has a different immutable disposition');const proofs=await readUnknownCodexDispositions(client,record.binding.jobKey,options);await client.query('COMMIT');return proofs.find(proof=>proof.intentId===record.binding.intentId)!;}
  const clock=(await client.query('SELECT clock_timestamp() AS now,current_user AS operator')).rows[0];requireThat(fixture||clock.operator==='max','Only the lead DB operator may register a disposition');const now=new Date(clock.now);
  requireThat(Date.parse(record.issuedAt)<=now.getTime()&&now.getTime()<Date.parse(record.expiresAt));
  await client.query('SELECT id FROM district_pipeline.jobs WHERE id=$1 FOR UPDATE',[record.binding.jobId]);const {row,spec,receipt}=await boundEvidence(client,record);
  requireThat(row.state===receipt.outcome&&row.reason_code===receipt.reasonCode&&row.attempt===record.binding.priorAttempt&&!row.cancellation_requested&&Number(row.reserved_micro_usd)===0);
  requireThat(fixture&&!row.policy_proof_sha256||row.policy_state==='allowed'&&row.policy_checked_at&&new Date(row.policy_checked_at)<=now&&row.policy_expires_at&&new Date(row.policy_expires_at)>now,'Source policy is not current');
  const latest=await client.query('SELECT id FROM district_pipeline.step_receipts WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1',[row.id]);requireThat(latest.rows[0]?.id===record.binding.heldReceiptId);
  const holds=await client.query(`SELECT count(*)::int AS count FROM district_pipeline.step_receipts WHERE job_id=$1 AND outcome IN ('held_execution','failed_execution','held_quality','held_origin','blocked_policy','blocked_access')`,[row.id]);requireThat(holds.rows[0].count>=1&&holds.rows[0].count<=2,'Normal lifetime resume budget exhausted');
  const live=await client.query(`SELECT 1 FROM district_pipeline.executor_runs e JOIN district_pipeline.preauthorizations a ON a.id=e.authorization_id WHERE $1=ANY(a.allowed_job_keys) AND (e.state='running' OR EXISTS(SELECT 1 FROM pg_locks l WHERE l.locktype='advisory' AND l.classid=18442 AND l.objid=(hashtext(e.id::text)::bigint & 4294967295) AND l.objsubid=2 AND l.granted)) LIMIT 1`,[record.binding.jobKey]);requireThat(!live.rowCount,'Prior executor is not quiescent');
  const reservations=await client.query(`SELECT 1 FROM district_pipeline.provider_reservations WHERE job_id=$1 AND state IN ('reserved','held_uncertain','pending_usage') LIMIT 1`,[row.id]);requireThat(!reservations.rowCount&&!(await querySubscriptionUsageStatus(client)).holds.length,'Unresolved provider/usage hold');
  if(!fixture){const current=spec.step==='residual_extract'?await import('./district-residual-jobs.ts').then(async m=>digest(canonicalJson(await m.residualJobContract()))):await import('./district-assessment-jobs.ts').then(m=>m.assessmentQueueContract());requireThat(spec.semanticContractSha256===current,'Old-contract job cannot receive a retry');}
  const intents=(await client.query('SELECT id,request_sha256 FROM district_pipeline.r1_codex_call_intents WHERE job_id=$1 ORDER BY id',[row.id])).rows;
  const prior=await readUnknownCodexDispositions(client,record.binding.jobKey,options),completed=await completedCodexIntents(options.casRoot??fileURLToPath(new URL('../cache/districts/cas',import.meta.url)),record.binding.jobKey,intents,options.fixture?.policy??options.policy);
  const unresolved=intents.filter(i=>!completed.some(p=>p.intentId===i.id)&&!prior.some(p=>p.intentId===i.id&&p.replacementIntentId));requireThat(unresolved.length===1&&unresolved[0].id===record.binding.intentId,'Exactly the named unknown intent must remain');
  const calls=await client.query('SELECT count(*)::int AS count FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=$1',[record.binding.originalSha256]);requireThat(calls.rows[0].count<48,'Unchanged 48-call ceiling has no capacity');
  const b=record.binding;await client.query(`INSERT INTO district_pipeline.r1_codex_unsettled_retries(record_sha256,record_id,record_bytes,intent_id,job_id,held_receipt_id,held_receipt_sha256,original_sha256,request_sha256,run_id,authorization_id,prior_attempt,allowed_attempt,completion_state,action,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'completion_unknown','bounded_retry',$14,$15)`,[input.recordSha256,record.id,input.recordBytes,b.intentId,b.jobId,b.heldReceiptId,b.heldReceiptSha256,b.originalSha256,b.requestSha256,b.runId,b.authorizationId,b.priorAttempt,record.bounds.allowedAttempt,record.issuedAt,record.expiresAt]);
  const proof=(await readUnknownCodexDispositions(client,b.jobKey,options)).find(proof=>proof.intentId===b.intentId)!;await client.query('COMMIT');return proof;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
/** Called only inside reserve's existing serialized transaction, before a NEW intent. */
export async function codexUnsettledRetryAdmission(client:Query,job:ClaimedJob,originalSha256:string,requestSha256:string,options:CodexDispositionOptions={}){
 const proofs=(await readUnknownCodexDispositions(client,job.jobKey,options)).filter(proof=>proof.requestSha256===requestSha256);
 if(!proofs.length)return {target:undefined,ignoredIntentIds:[] as string[]};
 const clock=(await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
 const available=proofs.filter(proof=>!proof.replacementIntentId&&proof.allowedAttempt===job.attempt&&new Date(proof.expiresAt)>new Date(clock));requireThat(available.length<=1);
 const target=available[0];if(target){const original=(await client.query('SELECT original_sha256 FROM district_pipeline.r1_codex_call_intents WHERE id=$1',[target.intentId])).rows[0];requireThat(original?.original_sha256===originalSha256);}
 return {target,ignoredIntentIds:proofs.filter(proof=>proof.replacementIntentId||proof===target).map(proof=>proof.intentId)};
}
export async function consumeCodexUnsettledRetry(client:Query,recordSha256:string,replacementIntentId:string){await client.query('INSERT INTO district_pipeline.r1_codex_unsettled_retry_intents(disposition_sha256,replacement_intent_id) VALUES($1,$2)',[recordSha256,replacementIntentId]);}
