import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {HashSchema} from './district-adapter-contract.ts';
import {DistrictExecutionHold,type ClaimedJob} from './district-jobs.ts';
import {SubscriptionRuntimeError} from './district-model-contract.ts';
import {guardDistrictPool} from './district-database.ts';
export async function registerR1CodexDocument(pool:Pool,municipalityId:string,originalSha256:string,maxCalls:number){
 guardDistrictPool(pool);
 HashSchema.parse(originalSha256);
 if(!Number.isInteger(maxCalls)||maxCalls<2||maxCalls>48)throw new DistrictExecutionHold('source_limit_exceeded');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(18441,81)');
  const prior=await client.query('SELECT 1 FROM district_pipeline.r1_codex_selections WHERE municipality_id=$1 AND original_sha256=$2',[municipalityId,originalSha256]);
  if(!prior.rowCount){
   const count=await client.query<{count:string}>('SELECT count(*) FROM district_pipeline.r1_codex_selections');
   if(Number(count.rows[0].count)>=500)throw new DistrictExecutionHold('source_limit_exceeded');
  }
  await client.query(`INSERT INTO district_pipeline.r1_codex_documents(original_sha256,max_calls) VALUES($1,$2) ON CONFLICT(original_sha256) DO UPDATE SET max_calls=LEAST(district_pipeline.r1_codex_documents.max_calls,EXCLUDED.max_calls)`,[originalSha256,maxCalls]);
  await client.query('INSERT INTO district_pipeline.r1_codex_selections(municipality_id,original_sha256) VALUES($1,$2) ON CONFLICT DO NOTHING',[municipalityId,originalSha256]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

/** Committed before a source-bearing effect; never refunded or silently replayed. */
export async function reserveR1CodexCall(pool:Pool,job:ClaimedJob,originalSha256:string,requestSha256:string,maxCalls=48){
 guardDistrictPool(pool);
 HashSchema.parse(originalSha256);HashSchema.parse(requestSha256);
 if(!Number.isInteger(maxCalls)||maxCalls<2||maxCalls>48||!['residual_extract','assessment_a','assessment_c'].includes(job.spec.step))throw new DistrictExecutionHold('authorization_revoked');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(18441,81)');
  const active=await client.query<{authorization_id:string;approval_sha256:string;approved_by:string;approved_at:Date}>(`SELECT a.id AS authorization_id,a.approval_sha256,a.approved_by,a.approved_at FROM district_pipeline.jobs j JOIN district_pipeline.executor_runs r ON r.id=j.lease_owner JOIN district_pipeline.preauthorizations a ON a.id=r.authorization_id WHERE j.id=$1 AND j.lease_owner=$2 AND j.fencing_token=$3 AND j.state='leased' AND NOT j.cancellation_requested AND j.lease_expires_at>clock_timestamp() AND r.state='running' AND a.state='approved' AND a.expires_at>clock_timestamp() AND a.first_started_at+a.max_elapsed_ms*interval '1 millisecond'>clock_timestamp() AND r.started_at+r.max_elapsed_ms*interval '1 millisecond'>clock_timestamp() AND j.job_key=ANY(a.allowed_job_keys) AND j.ags=ANY(a.allowed_ags)`,[job.id,job.runId,job.fencingToken]);
  if(active.rowCount!==1)throw new DistrictExecutionHold('lease_lost');
  const authorization=active.rows[0];
  const holds=await client.query<{authorization_id:string;held_at:Date}>(`SELECT h.authorization_id,h.held_at FROM district_pipeline.r1_codex_usage_holds h WHERE NOT EXISTS(SELECT 1 FROM district_pipeline.r1_codex_resumptions r WHERE r.held_authorization_id=h.authorization_id AND r.authorization_id=$1)`,[authorization.authorization_id]);
  if(holds.rows.some(hold=>hold.authorization_id===authorization.authorization_id||authorization.approved_at<=hold.held_at))throw new DistrictExecutionHold('budget_paused');
  for(const hold of holds.rows)await client.query(`INSERT INTO district_pipeline.r1_codex_resumptions(held_authorization_id,authorization_id,run_id,approval_sha256,approved_by,approved_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[hold.authorization_id,authorization.authorization_id,job.runId,authorization.approval_sha256,authorization.approved_by,authorization.approved_at]);
  await client.query(`INSERT INTO district_pipeline.r1_codex_documents(original_sha256,max_calls) VALUES($1,$2) ON CONFLICT(original_sha256) DO UPDATE SET max_calls=LEAST(district_pipeline.r1_codex_documents.max_calls,EXCLUDED.max_calls)`,[originalSha256,maxCalls]);
  const selection=await client.query('SELECT 1 FROM district_pipeline.r1_codex_selections WHERE municipality_id=$1 AND original_sha256=$2',[job.spec.sourceScope.municipalityId,originalSha256]);
  if(!selection.rowCount){
   const count=await client.query<{count:string}>('SELECT count(*) FROM district_pipeline.r1_codex_selections');
   if(Number(count.rows[0].count)>=500)throw new DistrictExecutionHold('source_limit_exceeded');
   await client.query('INSERT INTO district_pipeline.r1_codex_selections(municipality_id,original_sha256) VALUES($1,$2)',[job.spec.sourceScope.municipalityId,originalSha256]);
  }
  // Pin the per-original ceiling through count+insert, even if selection/usage
  // accounting later narrows its independent global transaction lock.
  const document=await client.query<{max_calls:number}>('SELECT max_calls FROM district_pipeline.r1_codex_documents WHERE original_sha256=$1 FOR UPDATE',[originalSha256]);
  const prior=await client.query(`SELECT 1 FROM district_pipeline.r1_codex_call_intents i LEFT JOIN district_pipeline.r1_codex_usage_holds h ON h.failed_intent_id=i.id WHERE i.job_id=$1 AND i.request_sha256=$2 AND (h.authorization_id IS NULL OR h.authorization_id=$3)`,[job.id,requestSha256,authorization.authorization_id]);
  if(prior.rowCount)throw new DistrictExecutionHold('usage_unknown');
  const count=await client.query<{count:string}>('SELECT count(*) FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=$1',[originalSha256]);
  if(Number(count.rows[0].count)>=document.rows[0].max_calls)throw new DistrictExecutionHold('source_limit_exceeded');
  const id=randomUUID();
  await client.query('INSERT INTO district_pipeline.r1_codex_call_intents(id,original_sha256,job_id,fencing_token,request_sha256,stage) VALUES($1,$2,$3,$4,$5,$6)',[id,originalSha256,job.id,job.fencingToken,requestSha256,job.spec.step]);
  await client.query('INSERT INTO district_pipeline.r1_codex_call_authorizations(intent_id,authorization_id,run_id) VALUES($1,$2,$3)',[id,authorization.authorization_id,job.runId]);
  await client.query('COMMIT');return id;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function holdR1CodexFailure(pool:Pool,job:ClaimedJob,originalSha256:string,error:unknown):Promise<never>{
 if(error instanceof SubscriptionRuntimeError&&error.failureCategory==='rate_limit'){
  guardDistrictPool(pool);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(18441,81)');
   const held=await client.query(`INSERT INTO district_pipeline.r1_codex_usage_holds(authorization_id,run_id,failed_intent_id) SELECT a.authorization_id,a.run_id,i.id FROM district_pipeline.r1_codex_call_intents i JOIN district_pipeline.r1_codex_call_authorizations a ON a.intent_id=i.id WHERE i.job_id=$1 AND i.original_sha256=$2 AND i.fencing_token=$3 AND a.run_id=$4 ORDER BY i.created_at DESC LIMIT 1 ON CONFLICT DO NOTHING RETURNING authorization_id`,[job.id,originalSha256,job.fencingToken,job.runId]);
   if(!held.rowCount)throw new DistrictExecutionHold('usage_unknown');
   await client.query('COMMIT');
  }catch(failure){await client.query('ROLLBACK');throw failure;}finally{client.release();}
  throw new DistrictExecutionHold('budget_paused');
 }
 throw error;
}
