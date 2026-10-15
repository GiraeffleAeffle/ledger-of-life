import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {HashSchema,digest,semanticHash} from './district-adapter-contract.ts';
import {DistrictJobStore,DistrictExecutionHold,canonicalJobIdentity,type DistrictJobSpec,type NotificationIdentity} from './district-jobs.ts';
import {SubscriptionLimitSchema,type SubscriptionLimit} from './district-subscription-limit.ts';
import {encodeStepReceipt,StepReceiptSchema} from './district-step-receipt.ts';

export const SUBSCRIPTION_RESUME_APPROVAL='9882aa1a3938c41a358760705705b943b31e569e11a7b5a2f6579c8661a6b028';
export const SUBSCRIPTION_PARENT_APPROVAL='2ac6267d17ed08452665a0b2de92ec4da89915fe8619b668b85585301327502b';
const OWNER_EXPIRY='2026-10-25T21:59:59Z';
export const UsageResumeInputSchema=z.object({jobKeys:z.array(HashSchema).min(1).max(500),approvedBy:z.string().min(1).max(256),expiresAt:z.iso.datetime(),maxElapsedMs:z.number().int().min(1).max(86400000),mode:z.enum(['attended','bounded_unattended'])}).strict();
export type UsageResumeInput=z.infer<typeof UsageResumeInputSchema>;
interface UsageHold {id:string;provider:SubscriptionLimit['provider'];authorization_id:string;job_id:string;bridge_lease_id:string|null;reset_at:Date|null;observed_at:Date;no_output:boolean}
interface ResumeJob {id:string;job_key:string;spec:DistrictJobSpec;state:string;reason_code:string;held_run_id:string|null;receipt:unknown;receipt_sha256:string|null;attempt:number;fencing_token:string;cancellation_requested:boolean;reserved_micro_usd:string}
interface PriorAuthorization {id:string;state:string;expires_at:Date;max_elapsed_ms:number;allowed_job_keys:string[];allowed_ags:string[];category:'production'|'evaluation'|'development'}

/** Read-only operator report, including legacy holds with no captured clock. */
export async function subscriptionUsageStatus(pool:Pool){
 const result=await pool.query(`SELECT h.id,h.provider,h.authorization_id,h.job_id,h.limit_kind,h.reset_at,h.observed_at,h.no_output,clock_timestamp() AS now,
  CASE WHEN h.reset_at IS NULL THEN 'no_reset_stated' WHEN NOT h.no_output THEN 'output_may_exist' WHEN h.reset_at>clock_timestamp() THEN 'before_reset' ELSE 'reset_recorded' END AS reset_status
  FROM district_pipeline.r1_subscription_usage_holds h WHERE NOT EXISTS(SELECT 1 FROM district_pipeline.r1_subscription_resumptions r WHERE r.hold_id=h.id) AND NOT EXISTS(SELECT 1 FROM district_pipeline.r1_codex_resumptions r WHERE r.held_authorization_id=h.codex_authorization_id)
  UNION ALL SELECT NULL,'openai-subscription',h.authorization_id,i.job_id,'usage_limit',NULL,h.held_at,false,clock_timestamp(),'no_reset_stated'
  FROM district_pipeline.r1_codex_usage_holds h JOIN district_pipeline.r1_codex_call_intents i ON i.id=h.failed_intent_id WHERE NOT EXISTS(SELECT 1 FROM district_pipeline.r1_subscription_usage_holds e WHERE e.codex_authorization_id=h.authorization_id) AND NOT EXISTS(SELECT 1 FROM district_pipeline.r1_codex_resumptions r WHERE r.held_authorization_id=h.authorization_id)`);
 return {holds:result.rows};
}

export async function recordBSubscriptionHold(client:PoolClient,authorizationId:string,jobId:string,leaseId:string,input:SubscriptionLimit,noOutput:boolean){
 const limit=SubscriptionLimitSchema.parse(input);
 if(limit.provider!=='anthropic-subscription')throw new DistrictExecutionHold('usage_unknown');
 await client.query(`INSERT INTO district_pipeline.r1_subscription_usage_holds(id,provider,authorization_id,job_id,bridge_lease_id,limit_kind,reset_at,observed_at,no_output) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),limit.provider,authorizationId,jobId,leaseId,limit.limitKind,limit.resetAt,limit.observedAt,noOutput]);
}
/** Never clear a submission intent or claimed lease. A separately committed
 * disposition admits only the exact proven empty provider failure it names. */
export async function assertBSubscriptionResume(client:PoolClient,authorizationId:string,jobId:string):Promise<string[]>{
 const unresolved=await client.query(`SELECT 1 FROM district_pipeline.r1_subscription_usage_holds h WHERE h.provider='anthropic-subscription' AND NOT EXISTS(SELECT 1 FROM district_pipeline.r1_subscription_resumptions r WHERE r.hold_id=h.id) LIMIT 1`);
 if(unresolved.rowCount)throw new DistrictExecutionHold('budget_paused');
 const resolved=await client.query<{bridge_lease_id:string}>(`SELECT h.bridge_lease_id FROM district_pipeline.r1_subscription_usage_holds h JOIN district_pipeline.r1_subscription_resumptions r ON r.hold_id=h.id AND r.job_id=h.job_id JOIN district_pipeline.preauthorizations disposition ON disposition.id=r.authorization_id JOIN district_pipeline.preauthorizations current ON current.id=$1 WHERE h.job_id=$2 AND h.provider='anthropic-subscription' AND h.no_output AND h.reset_at IS NOT NULL AND h.reset_at<=clock_timestamp() AND disposition.approved_at>h.observed_at AND disposition.approved_at>=h.reset_at AND current.approved_at>=disposition.approved_at AND current.state='approved' AND current.expires_at>clock_timestamp() AND r.owner_approval_sha256=$3 AND r.parent_approval_sha256=$4`,[authorizationId,jobId,SUBSCRIPTION_RESUME_APPROVAL,SUBSCRIPTION_PARENT_APPROVAL]);
 return resolved.rows.map(row=>row.bridge_lease_id);
}

/** Lead-only, no waits or provider calls. The same transaction issues fresh
 * canonical authority, records its basis and invokes guarded queue resume.
 * Codex's own reserveR1CodexCall creates r1_codex_resumptions lazily, unchanged. */
export async function resumeSubscriptionUsage(pool:Pool,raw:UsageResumeInput,options:{checkPolicy:(spec:DistrictJobSpec)=>Promise<void>;notification?:NotificationIdentity}){
 const input=UsageResumeInputSchema.parse(raw),jobKeys=[...new Set(input.jobKeys)].sort();
 if(jobKeys.length!==input.jobKeys.length)throw Error('Duplicate resume job key');
 for(const [name,expected] of [['r1-subscription-usage-autoresume-2026-10-14',SUBSCRIPTION_RESUME_APPROVAL],['r1-nine-town-models-2026-10-13',SUBSCRIPTION_PARENT_APPROVAL]]){
  if(digest(await readFile(new URL(`../reports/approvals/${name}.json`,import.meta.url)))!==expected)throw new DistrictExecutionHold('authorization_revoked');
 }
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(18441,81)');
  // Match the run -> authority -> job lock order; only inactive runs may resume.
  const runs=await client.query<{id:string;authorization_id:string;state:string}>(`SELECT DISTINCT r.id,r.authorization_id,r.state FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts s ON s.job_id=j.id AND s.attempt=j.attempt JOIN district_pipeline.executor_runs r ON r.id=s.run_id WHERE j.job_key=ANY($1::text[]) ORDER BY r.id`,[jobKeys]);
  for(const run of runs.rows){
   const locked=await client.query<{state:string}>('SELECT state FROM district_pipeline.executor_runs WHERE id=$1 FOR UPDATE',[run.id]);
   if(locked.rows[0]?.state==='running')throw new DistrictExecutionHold('lease_lost');
  }
  const authorizationIds=[...new Set(runs.rows.map(run=>run.authorization_id))].sort();
  const authorities=await client.query<PriorAuthorization>('SELECT * FROM district_pipeline.preauthorizations WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[authorizationIds]);
  const jobs=await client.query<ResumeJob>(`SELECT j.*,s.run_id AS held_run_id,s.receipt,s.receipt_sha256 FROM district_pipeline.jobs j LEFT JOIN district_pipeline.step_receipts s ON s.job_id=j.id AND s.attempt=j.attempt WHERE j.job_key=ANY($1::text[]) ORDER BY j.id FOR UPDATE OF j`,[jobKeys]);
  if(jobs.rowCount!==jobKeys.length)throw new DistrictExecutionHold('authorization_revoked');
  const clock=await client.query<{now:Date}>('SELECT clock_timestamp() AS now'),now=clock.rows[0].now;
  if(now>=new Date(OWNER_EXPIRY)||Date.parse(input.expiresAt)<=now.getTime()||Date.parse(input.expiresAt)>Date.parse(OWNER_EXPIRY))throw new DistrictExecutionHold('authorization_expired');
  const provider:SubscriptionLimit['provider']=jobs.rows[0].spec.step==='assessment_b'?'anthropic-subscription':'openai-subscription';
  const scopes=new Set(jobs.rows.map(job=>semanticHash(job.spec.sourceScope)));
  if(scopes.size!==1)throw new DistrictExecutionHold('authorization_mode_mismatch');
  // A new observation window/generation must not reset the per-source counter.
  const {observationWindow:priorWindow,...sourceIdentity}=jobs.rows[0].spec.sourceScope;
  const scopeSha256=semanticHash(sourceIdentity);
  const holds=await client.query<UsageHold>(`SELECT h.* FROM district_pipeline.r1_subscription_usage_holds h WHERE h.provider=$1 AND (h.provider='anthropic-subscription' OR h.authorization_id=ANY($2::uuid[]) OR (NOT EXISTS(SELECT 1 FROM district_pipeline.r1_subscription_resumptions r WHERE r.hold_id=h.id) AND NOT EXISTS(SELECT 1 FROM district_pipeline.r1_codex_resumptions c WHERE c.held_authorization_id=h.codex_authorization_id))) ORDER BY h.id`,[provider,authorizationIds]);
  // Legacy Codex holds lack reset evidence and are deliberately not eligible.
  if(provider==='openai-subscription'){
   const legacy=await client.query(`SELECT 1 FROM district_pipeline.r1_codex_usage_holds h WHERE NOT EXISTS(SELECT 1 FROM district_pipeline.r1_subscription_usage_holds e WHERE e.codex_authorization_id=h.authorization_id) AND NOT EXISTS(SELECT 1 FROM district_pipeline.r1_codex_resumptions r WHERE r.held_authorization_id=h.authorization_id) LIMIT 1`);
   if(legacy.rowCount)throw new DistrictExecutionHold('budget_paused');
  }
  if(!holds.rowCount)throw new DistrictExecutionHold('usage_unknown');
  for(const hold of holds.rows){
   if(!hold.reset_at||hold.reset_at>now||hold.observed_at>=now||!hold.no_output)throw new DistrictExecutionHold('budget_paused');
  }
  const live=await client.query(`SELECT 1 FROM district_pipeline.executor_runs r JOIN district_pipeline.preauthorizations a ON a.id=r.authorization_id WHERE r.state='running' AND a.allowed_job_keys && $1::text[] LIMIT 1`,[jobKeys]);
  if(live.rowCount)throw new DistrictExecutionHold('lease_lost');
  const selections=await client.query<{count:string}>('SELECT count(*) FROM district_pipeline.r1_codex_selections');
  if(Number(selections.rows[0].count)>500)throw new DistrictExecutionHold('source_limit_exceeded');
  const sourceResumes=await client.query<{count:string}>('SELECT count(DISTINCT authorization_id) FROM district_pipeline.r1_subscription_resumptions WHERE source_scope_sha256=$1',[scopeSha256]);
  if(Number(sourceResumes.rows[0].count)>=6)throw new DistrictExecutionHold('source_limit_exceeded');
  for(const job of jobs.rows){
   const run=runs.rows.find(run=>run.id===job.held_run_id),authorization=authorities.rows.find(auth=>auth.id===run?.authorization_id);
   if(!authorization||authorization.state!=='approved'||!authorization.allowed_job_keys.includes(job.job_key)||!authorization.allowed_ags.includes(job.spec.sourceScope.ags))throw new DistrictExecutionHold('authorization_revoked');
   if(authorization.expires_at<=now||Date.parse(input.expiresAt)>authorization.expires_at.getTime())throw new DistrictExecutionHold('authorization_expired');
   if(input.maxElapsedMs>authorization.max_elapsed_ms)throw new DistrictExecutionHold('authorization_time_exhausted');
   if(job.state!=='held_execution'||job.reason_code!=='budget_paused'||job.cancellation_requested||Number(job.reserved_micro_usd)!==0||canonicalJobIdentity(job.spec).jobKey!==job.job_key)throw new DistrictExecutionHold('usage_unknown');
   const encoded=encodeStepReceipt(StepReceiptSchema.parse(job.receipt)),receipt=encoded.receipt;
   const receiptFence=BigInt(receipt.leaseToken),fence=BigInt(job.fencing_token);
   if(encoded.sha256!==job.receipt_sha256||receipt.jobKey!==job.job_key||receipt.runId!==job.held_run_id||receipt.attempt!==job.attempt||receipt.step!==job.spec.step||receipt.outcome!=='held_execution'||receipt.reasonCode!=='budget_paused'||fence!==receiptFence&&fence!==receiptFence+1n)throw new DistrictExecutionHold('usage_unknown');
   const nativeB=z.object({transport:z.literal('vm-omp')}).safeParse(job.spec.selector);
   if(provider==='anthropic-subscription'?(job.spec.step!=='assessment_b'||!nativeB.success):!['residual_extract','assessment_a','assessment_c'].includes(job.spec.step))throw new DistrictExecutionHold('authorization_mode_mismatch');
   const own=holds.rows.filter(hold=>hold.authorization_id===authorization.id);
   if(!own.length&&provider==='openai-subscription')throw new DistrictExecutionHold('usage_unknown');
   if(provider==='anthropic-subscription'){
    const ambiguous=await client.query(`SELECT 1 FROM district_pipeline.assessment_bridge_leases b WHERE b.job_id=$1 AND b.claimed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM district_pipeline.r1_subscription_usage_holds h WHERE h.bridge_lease_id=b.id AND h.no_output AND h.reset_at<=clock_timestamp()) LIMIT 1`,[job.id]);
    if(ambiguous.rowCount)throw new DistrictExecutionHold('usage_unknown');
   }else{
    // Count every intent for each original, not just this job's intents.
    const originalCaps=await client.query(`SELECT 1 FROM district_pipeline.r1_codex_documents d WHERE d.original_sha256 IN(SELECT original_sha256 FROM district_pipeline.r1_codex_call_intents WHERE job_id=$1) AND (SELECT count(*) FROM district_pipeline.r1_codex_call_intents i WHERE i.original_sha256=d.original_sha256)>=d.max_calls LIMIT 1`,[job.id]);
    if(originalCaps.rowCount)throw new DistrictExecutionHold('source_limit_exceeded');
    const ambiguous=await client.query(`SELECT 1 FROM district_pipeline.r1_codex_call_intents i WHERE i.job_id=$1 AND NOT EXISTS(SELECT 1 FROM district_pipeline.r1_codex_usage_holds h WHERE h.failed_intent_id=i.id) LIMIT 1`,[job.id]);
    if(ambiguous.rowCount)throw new DistrictExecutionHold('usage_unknown');
   }
   await options.checkPolicy(job.spec);
  }
  const finalClock=await client.query<{now:Date}>('SELECT clock_timestamp() AS now');
  if(finalClock.rows[0].now>=new Date(OWNER_EXPIRY)||finalClock.rows[0].now>=new Date(input.expiresAt)||authorities.rows.some(auth=>auth.expires_at<=finalClock.rows[0].now))throw new DistrictExecutionHold('authorization_expired');
  if(new Set(authorities.rows.map(auth=>auth.category)).size!==1)throw new DistrictExecutionHold('authorization_mode_mismatch');
  const authorizationId=randomUUID(),approval={version:'r1-subscription-usage-resume-v1',authorizationId,ownerApprovalSha256:SUBSCRIPTION_RESUME_APPROVAL,parentApprovalSha256:SUBSCRIPTION_PARENT_APPROVAL,holdIds:holds.rows.map(hold=>hold.id),holdReceipts:jobs.rows.map(job=>({jobKey:job.job_key,receiptSha256:job.receipt_sha256,runId:job.held_run_id,attempt:job.attempt})),...input,jobKeys,approvedAt:now.toISOString()};
  const approvalSha256=semanticHash(approval);
  // These two canonical methods only need query(); bind them to this transaction.
  const store=new DistrictJobStore(client as unknown as Pool);
  await store.authorize({id:authorizationId,approvalSha256,approvedBy:input.approvedBy,expiresAt:input.expiresAt,jobKeys,ags:[...new Set(jobs.rows.map(job=>job.spec.sourceScope.ags))],maxJobs:jobKeys.length,maxElapsedMs:input.maxElapsedMs,category:authorities.rows[0].category,mode:input.mode,...options.notification});
  for(const job of jobs.rows){
   let inserted=false;
   for(const hold of holds.rows){
    const result=await client.query(`INSERT INTO district_pipeline.r1_subscription_resumptions(hold_id,job_id,authorization_id,source_scope_sha256,approval_sha256,owner_approval_sha256,parent_approval_sha256,prior_receipt_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[hold.id,job.id,authorizationId,scopeSha256,approvalSha256,SUBSCRIPTION_RESUME_APPROVAL,SUBSCRIPTION_PARENT_APPROVAL,job.receipt_sha256]);
    inserted||=!!result.rowCount;
   }
   if(!inserted)throw new DistrictExecutionHold('usage_unknown');
   await store.resume(job.job_key);
  }
  await client.query('COMMIT');return {authorizationId,approvalSha256,approval,jobKeys,provider};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
