import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Pool, type PoolClient, type QueryResultRow} from 'pg';
import {z} from 'zod';
import {canonicalJson, digest, HashSchema, ScopeSchema, type AdapterScope} from './district-adapter-contract.ts';
import {DistrictCas, type CasArtifact} from './district-cas.ts';
import {CANONICALIZATION_VERSION, STEP_RECEIPT_VERSION, ReasonCodeSchema, encodeStepReceipt, unknownReceiptCounts, type JobOutcome, type ReasonCode, type StepReceipt} from './district-step-receipt.ts';

// This is the authorized R1 ring, not a district-prefix or whole-Amt admission rule.
export const R1_MUNICIPALITIES:Readonly<Record<string,string>>={strausberg:'12064472',hoppegarten:'12064227','ruedersdorf-bei-berlin':'12064428',ratzeburg:'01053100',moelln:'01053090',schwarzenbek:'01053116',ludwigslust:'13076090',parchim:'13076108',hagenow:'13076060'};
const token=z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/);
const SpecSchema=z.object({step:token,lane:token,semanticContractSha256:HashSchema,inputArtifactHashes:z.array(HashSchema),sourceScope:ScopeSchema,selector:z.unknown(),policyProofSha256:HashSchema.nullable()}).strict();
export interface DistrictJobSpec {step:string;lane:string;semanticContractSha256:string;inputArtifactHashes:string[];sourceScope:AdapterScope;selector:unknown;policyProofSha256:string|null}
export interface ClaimedJob {id:string;jobKey:string;spec:DistrictJobSpec;attempt:number;fencingToken:string;runId:string;enqueuedAt:string;startedAt:string;leaseExpiresAt:string;dependencyReceiptIds:string[];category:'production'|'evaluation'|'development'}
export interface JobHandlerContext {job:ClaimedJob;signal:AbortSignal;cas:DistrictCas;acquireHostLane:(laneKey:string)=>Promise<void>}
export interface JobHandlerResult {outcome:JobOutcome;reasonCode:ReasonCode;outputs?:CasArtifact[];versions?:Record<string,string>;counts?:Partial<StepReceipt['counts']>;cache?:StepReceipt['cache'];provider?:StepReceipt['provider'];originProofSha256?:string|null}
export type JobHandler=(context:JobHandlerContext)=>Promise<JobHandlerResult>;
export interface ExecutorResult {runId:string;state:'completed'|'held';reasonCode:ReasonCode;jobsStarted:number;receiptIds:string[]}
export type ExecutionMode='attended'|'bounded_unattended';
export interface OwnerNotification {id:string;phase:'startup'|'disposition';runId:string;authorizationId:string;state:'running'|'completed'|'held';reasonCode:ReasonCode|null;jobsStarted:number;receiptIds:string[];notificationApprovalSha256:string;destinationSha256:string;provider:string}
export interface NotificationIdentity {notificationApprovalSha256:string;destinationSha256:string;provider:string}
export interface NotificationAcknowledgement {provider:string;messageId:string;notificationId:string;payloadSha256:string;destinationSha256:string;acknowledgedAt:string}
export interface NotificationConfig extends NotificationIdentity {notifyOwner:(notification:OwnerNotification)=>Promise<NotificationAcknowledgement>}
const NotificationAcknowledgementSchema=z.object({provider:token,messageId:z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),notificationId:z.uuid(),payloadSha256:HashSchema,destinationSha256:HashSchema,acknowledgedAt:z.iso.datetime()}).strict();
export class DistrictExecutionHold extends Error {readonly reasonCode:ReasonCode;constructor(reasonCode:ReasonCode){super(reasonCode);this.name='DistrictExecutionHold';this.reasonCode=reasonCode;}}
interface JobRow extends QueryResultRow {id:string;job_key:string;spec:DistrictJobSpec;state:string;created_at:Date;attempt_started_at:Date;lease_expires_at:Date;lease_owner:string;attempt:number;fencing_token:string;host_lane_key:string|null;budget_id:string|null;reserved_micro_usd:string;claimed_dependency_receipt_ids:string[];cancellation_requested:boolean}
interface AuthorizationRow extends QueryResultRow {id:string;expires_at:Date;first_started_at:Date|null;max_elapsed_ms:number;jobs_started:number;max_jobs:number;allowed_job_keys:string[];allowed_ags:string[];state:string;category:ClaimedJob['category'];execution_mode:ExecutionMode;notification_approval_sha256:string|null;notification_destination_sha256:string|null;notification_provider:string|null;now:Date}
export interface RunBounds {runId:string;authorizationId:string;maxJobs:number;maxElapsedMs:number;startedAt:Date;deadlineAt:Date;deadlineReason:ReasonCode}
export interface EnqueueOptions {dependencies?:{jobKey:string;expectedReceiptSha256?:string}[];priority?:number;notBefore?:string;hostLaneKey?:string;budgetId?:string;reservedMicroUsd?:number}
export interface AuthorizationInput {id?:string;approvalSha256:string;approvedBy:string;expiresAt:string;jobKeys:string[];ags:string[];maxJobs:number;maxElapsedMs:number;category:ClaimedJob['category'];mode?:ExecutionMode;notificationApprovalSha256?:string;notificationDestinationSha256?:string;notificationProvider?:string}

export function canonicalJobIdentity(input:DistrictJobSpec):{jobKey:string;spec:DistrictJobSpec} {
  const parsed=SpecSchema.parse(input);
  if(R1_MUNICIPALITIES[parsed.sourceScope.municipalityId]!==parsed.sourceScope.ags)throw Error('Job outside authorized R1 municipality scope');
  const spec:DistrictJobSpec={...parsed,inputArtifactHashes:[...new Set(parsed.inputArtifactHashes)].sort()};
  const jobKey=digest(canonicalJson({canonicalizationVersion:CANONICALIZATION_VERSION,step:spec.step,semanticContractSha256:spec.semanticContractSha256,inputArtifactHashes:spec.inputArtifactHashes,sourceScope:spec.sourceScope,selector:spec.selector,policyProofSha256:spec.policyProofSha256}));
  return {jobKey,spec};
}
/** Preserve tenant IDs, request parameters and query order. Fragments are not HTTP identity. */
export function canonicalResourceIdentity(raw:string):string {
  const url=new URL(raw);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Resource URL rejected');
  url.hash='';return url.href;
}

/** Explicit ordered migrations, each committed independently and byte-hash pinned.
 * A failure in 002 cannot roll back already-applied 001 or silently rewrite it.
 */
export async function migrateDistrictJobs(pool:Pool):Promise<void> {
  const migrations=[
    {version:1,file:new URL('../migrations/001_district_jobs.sql',import.meta.url)},
    {version:2,file:new URL('../migrations/002_r1_metadata.sql',import.meta.url)},
    {version:3,file:new URL('../migrations/003_assessment_bridge.sql',import.meta.url)},
  ];
  const client=await pool.connect();
  try {
    for(const migration of migrations){
      const bytes=await readFile(migration.file),hash=digest(bytes);
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(18441,1)');
        await client.query('CREATE SCHEMA IF NOT EXISTS district_pipeline');
        await client.query('CREATE TABLE IF NOT EXISTS district_pipeline.schema_migrations (version integer PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
        const future=await client.query('SELECT version FROM district_pipeline.schema_migrations WHERE version>$1 LIMIT 1',[migrations[migrations.length-1].version]);
        if(future.rowCount)throw Error('Database migration is newer than this runner');
        const previous=await client.query<{sha256:string}>('SELECT sha256 FROM district_pipeline.schema_migrations WHERE version=$1',[migration.version]);
        if(previous.rowCount){if(previous.rows[0].sha256!==hash)throw Error('Applied migration byte hash changed');}
        else {await client.query(bytes.toString('utf8'));await client.query('INSERT INTO district_pipeline.schema_migrations(version,sha256) VALUES($1,$2)',[migration.version,hash]);}
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;}
    }
  } finally {client.release();}
}

const R1MetadataKindSchema=z.enum(['structured_run','records','coverage','registry','routes','acquisition_descriptor','http_observation','replay_artifact','replay_proof']);
export type R1MetadataKind=z.infer<typeof R1MetadataKindSchema>;
export interface R1MetadataSnapshotInput {kind:R1MetadataKind;payload:unknown}
/** Callers validate a closed, content-free kind-specific audit schema. The
 * structured_run/records/coverage kinds store only artifact/source/proof pins
 * and fixed numeric counts, never raw locators, quotes, errors or full payloads.
 * Persist audits PG-first; full private payloads remain source-bound purgeable
 * CAS. The returned audit SHA is distinct from the private content SHA.
 */
export async function insertR1MetadataSnapshot(pool:Pool,input:R1MetadataSnapshotInput):Promise<string> {
  const kind=R1MetadataKindSchema.parse(input.kind),payload=input.payload;
  if(!Array.isArray(payload)&&(payload===null||typeof payload!=='object'||Object.getPrototypeOf(payload)!==Object.prototype))throw Error('Safe metadata payload must be an object or array');
  const bytes=canonicalJson(payload),sha256=digest(bytes);
  const inserted=await pool.query<{sha256:string}>(`INSERT INTO district_pipeline.r1_metadata_snapshots(sha256,kind,payload_json) VALUES($1,$2,$3::jsonb) ON CONFLICT(sha256) DO NOTHING RETURNING sha256`,[sha256,kind,bytes]);
  if(!inserted.rowCount){
    const existing=await pool.query<{kind:R1MetadataKind;payload_json:unknown}>('SELECT kind,payload_json FROM district_pipeline.r1_metadata_snapshots WHERE sha256=$1',[sha256]);
    if(!existing.rowCount||existing.rows[0].kind!==kind||canonicalJson(existing.rows[0].payload_json)!==bytes)throw Error('Safe metadata snapshot identity conflict');
  }
  return sha256;
}

export class DistrictJobStore {
  readonly pool:Pool;
  constructor(pool:Pool){this.pool=pool;}
  private async transaction<T>(body:(client:PoolClient)=>Promise<T>):Promise<T> {
    const client=await this.pool.connect();
    try {await client.query('BEGIN');const result=await body(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async addArtifact(artifact:CasArtifact):Promise<void> {
    HashSchema.parse(artifact.sha256);
    if(!Number.isSafeInteger(artifact.byteLength)||artifact.byteLength<0||artifact.storageKey!=='sha256/'+artifact.sha256.slice(0,2)+'/'+artifact.sha256)throw Error('Artifact metadata rejected');
    const result=await this.pool.query<{byte_length:string;storage_key:string;disposition:string}>(`INSERT INTO district_pipeline.artifacts(sha256,kind,mime_type,byte_length,storage_key) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING byte_length,storage_key,disposition`,[artifact.sha256,artifact.kind,artifact.mimeType,artifact.byteLength,artifact.storageKey]);
    const row=result.rows[0];
    if(Number(row.byte_length)!==artifact.byteLength||row.storage_key!==artifact.storageKey||row.disposition!=='retained')throw Error('Artifact registration conflict or exclusion');
  }
  async enqueue(input:DistrictJobSpec,options:EnqueueOptions={}):Promise<string> {
    const {jobKey,spec}=canonicalJobIdentity(input), dependencies=options.dependencies??[];
    for(const dep of dependencies){HashSchema.parse(dep.jobKey);if(dep.expectedReceiptSha256)HashSchema.parse(dep.expectedReceiptSha256);if(dep.jobKey===jobKey)throw Error('Self dependency rejected');}
    if(new Set(dependencies.map(dep=>dep.jobKey)).size!==dependencies.length)throw Error('Duplicate dependency rejected');
    const reserved=options.reservedMicroUsd??0;
    if(!Number.isSafeInteger(reserved)||reserved<0)throw Error('Reservation bound rejected');
    return this.transaction(async client=>{
      const inserted=await client.query<{id:string}>(`INSERT INTO district_pipeline.jobs(id,job_key,canonicalization_version,semantic_contract_sha256,step,lane,source_id,municipality_id,ags,spec,policy_proof_sha256,priority,not_before,host_lane_key,budget_id,reserved_micro_usd)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz,clock_timestamp()),$14,$15,$16) ON CONFLICT(job_key) DO NOTHING RETURNING id`,
        [randomUUID(),jobKey,CANONICALIZATION_VERSION,spec.semanticContractSha256,spec.step,spec.lane,spec.sourceScope.sourceId,spec.sourceScope.municipalityId,spec.sourceScope.ags,spec,spec.policyProofSha256,options.priority??0,options.notBefore??null,options.hostLaneKey??null,options.budgetId??null,reserved]);
      if(!inserted.rowCount){
        const existing=await client.query<JobRow>('SELECT * FROM district_pipeline.jobs WHERE job_key=$1',[jobKey]);
        const row=existing.rows[0];
        const bound=await client.query<{job_key:string;expected_receipt_sha256:string|null}>(`SELECT p.job_key,d.expected_receipt_sha256 FROM district_pipeline.job_dependencies d JOIN district_pipeline.jobs p ON p.id=d.predecessor_job_id WHERE d.job_id=$1 ORDER BY p.job_key`,[row.id]);
        const expected=dependencies.map(dep=>({job_key:dep.jobKey,expected_receipt_sha256:dep.expectedReceiptSha256??null})).sort((a,b)=>a.job_key.localeCompare(b.job_key));
        if(canonicalJson(row.spec)!==canonicalJson(spec)||canonicalJson(bound.rows)!==canonicalJson(expected)||row.host_lane_key!==(options.hostLaneKey??null)||row.budget_id!==(options.budgetId??null)||Number(row.reserved_micro_usd)!==reserved)throw Error('Existing canonical job has incompatible execution dependencies');
        return jobKey;
      }
      const id=inserted.rows[0].id;
      for(const hash of spec.inputArtifactHashes)await client.query('INSERT INTO district_pipeline.job_input_artifacts(job_id,artifact_sha256) VALUES($1,$2)',[id,hash]);
      for(const dep of dependencies){const predecessor=await client.query<{id:string}>('SELECT id FROM district_pipeline.jobs WHERE job_key=$1',[dep.jobKey]);if(!predecessor.rowCount)throw Error('Dependency must be enqueued first');await client.query('INSERT INTO district_pipeline.job_dependencies(job_id,predecessor_job_id,expected_receipt_sha256) VALUES($1,$2,$3)',[id,predecessor.rows[0].id,dep.expectedReceiptSha256??null]);}
      return jobKey;
    });
  }
  async authorize(input:AuthorizationInput):Promise<string> {
    HashSchema.parse(input.approvalSha256);input.jobKeys.forEach(key=>HashSchema.parse(key));
    if(!input.approvedBy||input.approvedBy.length>256||!input.jobKeys.length||!input.ags.length||input.ags.some(ags=>!Object.values(R1_MUNICIPALITIES).includes(ags))||!Number.isInteger(input.maxJobs)||input.maxJobs<1||input.maxJobs>10000||!Number.isInteger(input.maxElapsedMs)||input.maxElapsedMs<1||input.maxElapsedMs>86400000)throw Error('Preauthorization bounds rejected');
    const mode=input.mode??'attended';
    if(mode!=='attended'&&mode!=='bounded_unattended')throw Error('Execution mode rejected');
    if(mode==='bounded_unattended'&&(!input.notificationApprovalSha256||!input.notificationDestinationSha256||!input.notificationProvider))throw new DistrictExecutionHold('notification_unavailable');
    if(input.notificationApprovalSha256)HashSchema.parse(input.notificationApprovalSha256);
    if(input.notificationDestinationSha256)HashSchema.parse(input.notificationDestinationSha256);
    if(input.notificationProvider)token.parse(input.notificationProvider);
    const id=input.id??randomUUID();z.uuid().parse(id);
    const eligible=await this.pool.query<{job_key:string;ags:string}>(`SELECT job_key,ags FROM district_pipeline.jobs WHERE job_key=ANY($1::text[])`,[input.jobKeys]);
    if(eligible.rows.length!==new Set(input.jobKeys).size||eligible.rows.some(row=>!input.ags.includes(row.ags)))throw Error('Preauthorization references missing or out-of-scope jobs');
    await this.pool.query(`INSERT INTO district_pipeline.preauthorizations(id,approval_sha256,approved_by,approved_at,expires_at,allowed_job_keys,allowed_ags,max_jobs,max_elapsed_ms,category,execution_mode,notification_approval_sha256,notification_destination_sha256,notification_provider) VALUES($1,$2,$3,clock_timestamp(),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,input.approvalSha256,input.approvedBy,input.expiresAt,[...new Set(input.jobKeys)].sort(),[...new Set(input.ags)].sort(),input.maxJobs,input.maxElapsedMs,input.category,mode,input.notificationApprovalSha256??null,input.notificationDestinationSha256??null,input.notificationProvider??null]);
    return id;
  }
  private async authorization(client:PoolClient,id:string):Promise<AuthorizationRow> {
    const result=await client.query<AuthorizationRow>('SELECT *,clock_timestamp() AS now FROM district_pipeline.preauthorizations WHERE id=$1 FOR UPDATE',[id]);
    if(!result.rowCount)throw new DistrictExecutionHold('authorization_revoked');
    const auth=result.rows[0];
    if(auth.state!=='approved')throw new DistrictExecutionHold('authorization_revoked');
    if(auth.expires_at<=auth.now)throw new DistrictExecutionHold('authorization_expired');
    if(auth.first_started_at&&auth.now.getTime()-auth.first_started_at.getTime()>=auth.max_elapsed_ms)throw new DistrictExecutionHold('authorization_time_exhausted');
    return auth;
  }
  async beginRun(authorizationId:string,maxJobs:number,maxElapsedMs:number,mode:ExecutionMode='attended',notification?:NotificationIdentity):Promise<RunBounds> {
    z.uuid().parse(authorizationId);
    return this.transaction(async client=>{
      const auth=await this.authorization(client,authorizationId);
      if(auth.execution_mode!==mode)throw new DistrictExecutionHold('authorization_mode_mismatch');
      if(mode==='bounded_unattended'&&(!notification||notification.notificationApprovalSha256!==auth.notification_approval_sha256||notification.destinationSha256!==auth.notification_destination_sha256||notification.provider!==auth.notification_provider))throw new DistrictExecutionHold('notification_unavailable');
      if(auth.jobs_started>=auth.max_jobs)throw new DistrictExecutionHold('authorization_jobs_exhausted');
      if(maxJobs>auth.max_jobs||maxElapsedMs>auth.max_elapsed_ms)throw Error('Executor bounds exceed preauthorization');
      const runId=randomUUID();
      const run=await client.query<{started_at:Date}>(`INSERT INTO district_pipeline.executor_runs(id,authorization_id,owner_present,execution_mode,state,max_jobs,max_elapsed_ms) VALUES($1,$2,$3,$4,'running',$5,$6) RETURNING started_at`,[runId,authorizationId,mode==='attended',mode,maxJobs,maxElapsedMs]);
      await client.query('UPDATE district_pipeline.preauthorizations SET first_started_at=COALESCE(first_started_at,$2::timestamptz) WHERE id=$1',[authorizationId,run.rows[0].started_at]);
      if(mode==='bounded_unattended')await this.insertNotification(client,{id:randomUUID(),phase:'startup',runId,authorizationId,state:'running',reasonCode:null,jobsStarted:0,receiptIds:[],notificationApprovalSha256:auth.notification_approval_sha256!,destinationSha256:auth.notification_destination_sha256!,provider:auth.notification_provider!});
      const startedAt=run.rows[0].started_at,authorizedEnd=(auth.first_started_at??startedAt).getTime()+auth.max_elapsed_ms;
      const deadlineAt=new Date(Math.min(startedAt.getTime()+maxElapsedMs,auth.expires_at.getTime(),authorizedEnd));
      const deadlineReason:ReasonCode=deadlineAt.getTime()===auth.expires_at.getTime()?'authorization_expired':deadlineAt.getTime()===authorizedEnd?'authorization_time_exhausted':'max_time_reached';
      return {runId,authorizationId,maxJobs,maxElapsedMs,startedAt,deadlineAt,deadlineReason};
    });
  }
  /** Lock existing authority rows before any job or dependent row, including
   * late hold/reconciliation paths that intentionally permit expired authority.
   */
  private async lockRunAuthority(client:PoolClient,runId:string):Promise<boolean> {
    const runs=await client.query<{authorization_id:string}>('SELECT authorization_id FROM district_pipeline.executor_runs WHERE id=$1 FOR UPDATE',[runId]);
    if(!runs.rowCount)return false;
    const authorizations=await client.query('SELECT id FROM district_pipeline.preauthorizations WHERE id=$1 FOR UPDATE',[runs.rows[0].authorization_id]);
    return authorizations.rowCount===1;
  }
  private async assertRun(client:PoolClient,run:RunBounds):Promise<AuthorizationRow> {
    const result=await client.query<{state:string;now:Date}>('SELECT state,clock_timestamp() AS now FROM district_pipeline.executor_runs WHERE id=$1 FOR UPDATE',[run.runId]);
    if(!result.rowCount||result.rows[0].state!=='running')throw new DistrictExecutionHold('lease_lost');
    if(result.rows[0].now.getTime()-run.startedAt.getTime()>=run.maxElapsedMs)throw new DistrictExecutionHold('max_time_reached');
    const auth=await this.authorization(client,run.authorizationId);
    if(auth.execution_mode==='bounded_unattended'){
      const ready=await client.query(`SELECT 1 FROM district_pipeline.owner_notifications WHERE run_id=$1 AND phase='startup' AND state='delivered' AND destination_sha256=$2 AND provider=$3 AND notification_approval_sha256=$4`,[run.runId,auth.notification_destination_sha256,auth.notification_provider,auth.notification_approval_sha256]);
      if(!ready.rowCount)throw new DistrictExecutionHold('notification_unavailable');
    }
    return auth;
  }
  private async policyDisposition(client:PoolClient,jobId:string,spec:DistrictJobSpec):Promise<ReasonCode|null> {
    const originals=await client.query<{sha256:string;disposition:string}>(`SELECT a.sha256,a.disposition FROM district_pipeline.job_input_artifacts i JOIN district_pipeline.artifacts a ON a.sha256=i.artifact_sha256 WHERE i.job_id=$1`,[jobId]);
    if(originals.rows.some(row=>row.disposition!=='retained'))return 'policy_excluded';
    if(!spec.policyProofSha256){
      const original=await client.query(`SELECT 1 FROM district_pipeline.job_input_artifacts i JOIN district_pipeline.artifacts a ON a.sha256=i.artifact_sha256 WHERE i.job_id=$1 AND a.kind='source_original' LIMIT 1`,[jobId]);
      return original.rowCount?'policy_excluded':null;
    }
    const policies=await client.query<{state:string;checked_at:Date;expires_at:Date;source_sha256:string;publisher_id:string;source_id:string;municipality_id:string;ags:string;tenant:string|null;observation_window:string;now:Date}>(`SELECT p.*,s.publisher_id,s.source_id,s.municipality_id,s.ags,s.tenant,s.observation_window,clock_timestamp() AS now FROM district_pipeline.policy_decisions p JOIN district_pipeline.source_snapshots s ON s.id=p.source_snapshot_id WHERE p.proof_sha256=$1`,[spec.policyProofSha256]);
    if(!policies.rowCount)return 'policy_excluded';const policy=policies.rows[0];
    if(policy.checked_at>policy.now||policy.expires_at<=policy.now)return 'policy_expired';
    if(policy.state==='held_origin')return 'origin_unresolved';
    if(policy.state!=='allowed')return 'policy_excluded';
    const scope=spec.sourceScope;
    if(policy.publisher_id!==scope.publisherId||policy.source_id!==scope.sourceId||policy.municipality_id!==scope.municipalityId||policy.ags!==scope.ags||policy.tenant!==scope.tenant||policy.observation_window!==scope.observationWindow||!spec.inputArtifactHashes.includes(policy.source_sha256))return 'policy_excluded';
    return null;
  }
  private async hostAdmission(client:PoolClient,laneKey:string,jobId:string,fence:string,expiry:Date):Promise<ReasonCode|null> {
    await client.query('SELECT pg_advisory_xact_lock(18441,3)');
    const active=await client.query<{count:string;own_lane:boolean}>(`SELECT count(DISTINCT lane_key) AS count,COALESCE(bool_or(lane_key=$1),false) AS own_lane FROM district_pipeline.host_lane_leases WHERE expires_at>clock_timestamp()`,[laneKey]);
    if(Number(active.rows[0].count)>=4&&!active.rows[0].own_lane)return 'host_capacity';
    const lanes=await client.query<{max_in_flight:number;min_start_interval_ms:number;next_start_at:Date;retry_after:Date|null;paused_reason:string|null;now:Date}>('SELECT *,clock_timestamp() AS now FROM district_pipeline.host_lanes WHERE lane_key=$1 FOR UPDATE',[laneKey]);
    if(!lanes.rowCount)return 'host_paused';const lane=lanes.rows[0];
    if(lane.paused_reason)return 'host_paused';
    if(lane.next_start_at>lane.now||(lane.retry_after&&lane.retry_after>lane.now))return 'host_delay';
    const inFlight=await client.query<{count:string}>('SELECT count(*) FROM district_pipeline.host_lane_leases WHERE lane_key=$1 AND expires_at>clock_timestamp()',[laneKey]);
    if(Number(inFlight.rows[0].count)>=lane.max_in_flight)return 'host_capacity';
    await client.query(`INSERT INTO district_pipeline.host_lane_leases(lane_key,job_id,fencing_token,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(lane_key,job_id) DO UPDATE SET fencing_token=EXCLUDED.fencing_token,expires_at=EXCLUDED.expires_at`,[laneKey,jobId,fence,expiry]);
    await client.query(`UPDATE district_pipeline.host_lanes SET last_started_at=clock_timestamp(),next_start_at=clock_timestamp()+min_start_interval_ms*interval '1 millisecond' WHERE lane_key=$1`,[laneKey]);
    return null;
  }
  async claim(run:RunBounds,leaseMs:number):Promise<{kind:'job';job:ClaimedJob}|{kind:'stop';reasonCode:ReasonCode}> {
    if(!Number.isInteger(leaseMs)||leaseMs<50||leaseMs>300000)throw Error('Lease bound rejected');
    return this.transaction<{kind:'job';job:ClaimedJob}|{kind:'stop';reasonCode:ReasonCode}>(async client=>{
      const auth=await this.assertRun(client,run);
      if(auth.jobs_started>=auth.max_jobs)return {kind:'stop',reasonCode:'authorization_jobs_exhausted'};
      const candidates=await client.query<JobRow>(`SELECT j.* FROM district_pipeline.jobs j LEFT JOIN district_pipeline.host_lanes h ON h.lane_key=j.host_lane_key
        WHERE j.state IN ('queued','deferred') AND j.not_before<=clock_timestamp() AND j.job_key=ANY($1::text[]) AND j.ags=ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM district_pipeline.job_dependencies d WHERE d.job_id=j.id AND NOT EXISTS (
          SELECT 1 FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs p ON p.id=r.job_id
          WHERE p.id=d.predecessor_job_id AND p.state IN ('succeeded','no_supported_case') AND r.outcome=p.state
          AND (d.expected_receipt_sha256 IS NULL OR d.expected_receipt_sha256=r.receipt_sha256)))
        ORDER BY h.last_started_at NULLS FIRST,j.priority DESC,j.created_at,j.job_key FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[auth.allowed_job_keys,auth.allowed_ags]);
      if(!candidates.rowCount){
        const unresolved=await client.query<{reason_code:string|null}>(`SELECT reason_code FROM district_pipeline.jobs WHERE job_key=ANY($1::text[]) AND ags=ANY($2::text[]) AND state NOT IN ('succeeded','no_supported_case','cancelled','superseded') ORDER BY created_at,job_key LIMIT 1`,[auth.allowed_job_keys,auth.allowed_ags]);
        if(unresolved.rowCount){
          const reason=ReasonCodeSchema.safeParse(unresolved.rows[0].reason_code);
          return {kind:'stop',reasonCode:reason.success?reason.data:'dependency_uncommitted'};
        }
        return {kind:'stop',reasonCode:'no_ready_jobs'};
      }
      const row=candidates.rows[0];let hold:ReasonCode|null=null;
      if(row.cancellation_requested)hold='cancellation_requested';
      if(!hold)hold=await this.policyDisposition(client,row.id,row.spec);
      // R1 has no authorization for paid API execution, irrespective of available budget.
      if(Number(row.reserved_micro_usd)>0)hold='paid_not_authorized';
      if(hold){await client.query(`UPDATE district_pipeline.jobs SET state=$2,reason_code=$3 WHERE id=$1`,[row.id,hold==='cancellation_requested'?'cancelled':hold.startsWith('policy_')?'blocked_policy':hold==='origin_unresolved'?'held_origin':'held_execution',hold]);return {kind:'stop',reasonCode:hold};}
      const now=auth.now.getTime(),authorizationEnd=auth.first_started_at!.getTime()+auth.max_elapsed_ms;
      const expiry=new Date(Math.min(now+leaseMs,auth.expires_at.getTime(),authorizationEnd,run.startedAt.getTime()+run.maxElapsedMs));
      const fence=(BigInt(row.fencing_token)+1n).toString();
      if(row.host_lane_key){const disposition=await this.hostAdmission(client,row.host_lane_key,row.id,fence,expiry);if(disposition){await client.query(`UPDATE district_pipeline.jobs SET state='deferred',reason_code=$2,not_before=CASE WHEN $2='host_delay' THEN COALESCE((SELECT GREATEST(next_start_at,retry_after) FROM district_pipeline.host_lanes WHERE lane_key=$3),clock_timestamp()) ELSE not_before END WHERE id=$1`,[row.id,disposition,row.host_lane_key]);return {kind:'stop',reasonCode:disposition};}}
      const dependencies=await client.query<{id:string}>(`SELECT r.id FROM district_pipeline.job_dependencies d JOIN district_pipeline.jobs p ON p.id=d.predecessor_job_id JOIN district_pipeline.step_receipts r ON r.job_id=p.id AND r.outcome=p.state WHERE d.job_id=$1 AND (d.expected_receipt_sha256 IS NULL OR d.expected_receipt_sha256=r.receipt_sha256) ORDER BY r.id`,[row.id]);
      const receiptIds=dependencies.rows.map(receipt=>receipt.id);
      const leased=await client.query<JobRow>(`UPDATE district_pipeline.jobs SET state='leased',reason_code=NULL,lease_owner=$2,lease_expires_at=$3,fencing_token=$4,attempt=attempt+1,attempt_started_at=clock_timestamp(),claimed_dependency_receipt_ids=$5 WHERE id=$1 RETURNING *`,[row.id,run.runId,expiry,fence,receiptIds]);
      await client.query('UPDATE district_pipeline.preauthorizations SET jobs_started=jobs_started+1 WHERE id=$1',[run.authorizationId]);
      const current=leased.rows[0];return {kind:'job',job:{id:current.id,jobKey:current.job_key,spec:current.spec,attempt:current.attempt,fencingToken:fence,runId:run.runId,enqueuedAt:current.created_at.toISOString(),startedAt:current.attempt_started_at.toISOString(),leaseExpiresAt:expiry.toISOString(),dependencyReceiptIds:receiptIds,category:auth.category}};
    });
  }
  async renew(run:RunBounds,job:ClaimedJob,leaseMs:number):Promise<string> {
    if(!Number.isInteger(leaseMs)||leaseMs<50||leaseMs>300000)throw Error('Lease bound rejected');
    return this.transaction(async client=>{
      const auth=await this.assertRun(client,run);
      const expiry=new Date(Math.min(auth.now.getTime()+leaseMs,auth.expires_at.getTime(),auth.first_started_at!.getTime()+auth.max_elapsed_ms,run.startedAt.getTime()+run.maxElapsedMs));
      const result=await client.query(`UPDATE district_pipeline.jobs SET lease_expires_at=$4 WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND state='leased' AND lease_expires_at>clock_timestamp() AND NOT cancellation_requested`,[job.id,job.runId,job.fencingToken,expiry]);
      if(!result.rowCount)throw new DistrictExecutionHold('lease_lost');
      await client.query('UPDATE district_pipeline.host_lane_leases SET expires_at=$3 WHERE job_id=$1 AND fencing_token=$2',[job.id,job.fencingToken,expiry]);
      return expiry.toISOString();
    });
  }
  async acquireHostLane(run:RunBounds,job:ClaimedJob,laneKey:string):Promise<void> {
    await this.transaction(async client=>{
      await this.assertRun(client,run);
      const result=await client.query<JobRow>(`SELECT * FROM district_pipeline.jobs WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND state='leased' AND lease_expires_at>clock_timestamp() AND NOT cancellation_requested FOR UPDATE`,[job.id,job.runId,job.fencingToken]);
      if(!result.rowCount)throw new DistrictExecutionHold('lease_lost');
      // Repeated request starts on an already-held lane still observe its shared delay.
      await client.query('DELETE FROM district_pipeline.host_lane_leases WHERE lane_key=$1 AND job_id=$2 AND fencing_token=$3',[laneKey,job.id,job.fencingToken]);
      const hold=await this.hostAdmission(client,laneKey,job.id,job.fencingToken,result.rows[0].lease_expires_at);
      if(hold)throw new DistrictExecutionHold(hold);
    });
  }
  private async insertReceipt(client:PoolClient,job:ClaimedJob,receipt:StepReceipt):Promise<void> {
    const encoded=encodeStepReceipt(receipt);
    if(receipt.jobKey!==job.jobKey||receipt.runId!==job.runId||receipt.attempt!==job.attempt||receipt.leaseToken!==job.fencingToken||receipt.step!==job.spec.step||receipt.lane!==job.spec.lane||receipt.sourceId!==job.spec.sourceScope.sourceId||receipt.municipalityId!==job.spec.sourceScope.municipalityId||receipt.category!==job.category||receipt.enqueuedAt!==job.enqueuedAt||receipt.startedAt!==job.startedAt||canonicalJson(receipt.dependencyReceiptIds)!==canonicalJson(job.dependencyReceiptIds)||canonicalJson(receipt.inputHashes)!==canonicalJson(job.spec.inputArtifactHashes)||receipt.policyProofSha256!==job.spec.policyProofSha256)throw Error('Receipt lease/input binding rejected');
    if(receipt.cache.disposition==='hit'){
      const original=await client.query(`SELECT 1 FROM district_pipeline.step_receipts WHERE id=$1 AND outcome IN ('succeeded','no_supported_case')`,[receipt.cache.originalGenerationReceiptId]);
      if(!original.rowCount)throw Error('Cache receipt lacks authentic original generation');
    }
    await client.query(`INSERT INTO district_pipeline.step_receipts(id,job_id,run_id,attempt,fencing_token,outcome,receipt_sha256,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[receipt.id,job.id,job.runId,job.attempt,job.fencingToken,receipt.outcome,encoded.sha256,encoded.receipt]);
    for(const dependency of receipt.dependencyReceiptIds)await client.query('INSERT INTO district_pipeline.step_receipt_dependencies(receipt_id,dependency_receipt_id) VALUES($1,$2)',[receipt.id,dependency]);
    for(const hash of receipt.outputHashes)await client.query('INSERT INTO district_pipeline.job_output_artifacts(receipt_id,artifact_sha256) VALUES($1,$2)',[receipt.id,hash]);
  }
  async finish(run:RunBounds,job:ClaimedJob,receipt:StepReceipt):Promise<void> {
    await this.transaction(async client=>{
      await this.assertRun(client,run);
      const current=await client.query<JobRow>(`SELECT * FROM district_pipeline.jobs WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND state='leased' AND lease_expires_at>clock_timestamp() AND NOT cancellation_requested FOR UPDATE`,[job.id,job.runId,job.fencingToken]);
      if(!current.rowCount)throw new DistrictExecutionHold('lease_lost');
      const policy=await this.policyDisposition(client,job.id,job.spec);
      if(policy)throw new DistrictExecutionHold(policy);
      await this.insertReceipt(client,job,receipt);
      await client.query(`UPDATE district_pipeline.jobs SET state=$4,reason_code=$5,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3`,[job.id,job.runId,job.fencingToken,receipt.outcome,receipt.reasonCode]);
      await client.query('DELETE FROM district_pipeline.host_lane_leases WHERE job_id=$1 AND fencing_token=$2',[job.id,job.fencingToken]);
    });
  }
  /** A disposition may be recorded after expiration; successful effects never may.
   * It still requires the same owner and fence and cannot release dependencies.
   */
  async hold(job:ClaimedJob,reasonCode:ReasonCode,receipt:StepReceipt):Promise<boolean> {
    return this.transaction(async client=>{
      if(!await this.lockRunAuthority(client,job.runId))return false;
      const current=await client.query(`SELECT id FROM district_pipeline.jobs WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND state='leased' FOR UPDATE`,[job.id,job.runId,job.fencingToken]);
      if(!current.rowCount)return false;
      const held={...receipt,outcome:'held_execution' as const,reasonCode,outputHashes:[]};
      await this.insertReceipt(client,job,held);
      await client.query(`UPDATE district_pipeline.jobs SET state='held_execution',reason_code=$4,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1 WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3`,[job.id,job.runId,job.fencingToken,reasonCode]);
      await client.query('DELETE FROM district_pipeline.host_lane_leases WHERE job_id=$1 AND fencing_token=$2',[job.id,job.fencingToken]);
      await client.query(`UPDATE district_pipeline.provider_reservations SET state='held_uncertain' WHERE job_id=$1 AND fencing_token=$2 AND state='reserved'`,[job.id,job.fencingToken]);
      return true;
    });
  }
  async cancel(jobKey:string):Promise<void> {HashSchema.parse(jobKey);await this.pool.query(`UPDATE district_pipeline.jobs SET cancellation_requested=true,state=CASE WHEN state IN ('queued','deferred') THEN 'cancelled' ELSE state END,reason_code='cancellation_requested' WHERE job_key=$1`,[jobKey]);}
  /** Only an explicit owner action resumes a hold; no automatic retry or paid resubmission. */
  async resume(jobKey:string):Promise<void> {
    HashSchema.parse(jobKey);
    const result=await this.pool.query(`UPDATE district_pipeline.jobs j SET state='queued',reason_code=NULL,not_before=clock_timestamp() WHERE job_key=$1 AND state IN ('held_execution','held_origin','held_quality','blocked_policy','blocked_access','failed_execution','deferred') AND NOT cancellation_requested AND NOT EXISTS(SELECT 1 FROM district_pipeline.provider_reservations r WHERE r.job_id=j.id AND r.state IN ('reserved','held_uncertain','pending_usage'))`,[jobKey]);
    if(!result.rowCount)throw Error('Job cannot be resumed without resolving its disposition');
  }
  private async insertNotification(client:PoolClient,payload:OwnerNotification):Promise<void> {
    await client.query(`INSERT INTO district_pipeline.owner_notifications(id,run_id,phase,notification_approval_sha256,destination_sha256,expected_provider,payload,payload_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[payload.id,payload.runId,payload.phase,payload.notificationApprovalSha256,payload.destinationSha256,payload.provider,payload,digest(canonicalJson(payload))]);
  }
  private async endRunTransaction(client:PoolClient,runId:string,state:'completed'|'held',reasonCode:ReasonCode):Promise<void> {
    if(!await this.lockRunAuthority(client,runId))return;
    await this.endLockedRun(client,runId,state,reasonCode);
  }
  /** Caller already holds this run and authorization through COMMIT. */
  private async endLockedRun(client:PoolClient,runId:string,state:'completed'|'held',reasonCode:ReasonCode):Promise<void> {
    const runs=await client.query<{authorization_id:string;execution_mode:ExecutionMode;notification_approval_sha256:string|null;notification_destination_sha256:string|null;notification_provider:string|null}>(`SELECT r.authorization_id,r.execution_mode,a.notification_approval_sha256,a.notification_destination_sha256,a.notification_provider FROM district_pipeline.executor_runs r JOIN district_pipeline.preauthorizations a ON a.id=r.authorization_id WHERE r.id=$1 AND r.state='running'`,[runId]);
    if(!runs.rowCount)return;
    await client.query(`UPDATE district_pipeline.executor_runs SET state=$2,reason_code=$3,finished_at=clock_timestamp() WHERE id=$1`,[runId,state,reasonCode]);
    const row=runs.rows[0];
    if(row.execution_mode==='bounded_unattended'){
      const receipts=await client.query<{id:string}>('SELECT id FROM district_pipeline.step_receipts WHERE run_id=$1 ORDER BY id',[runId]);
      const payload:OwnerNotification={id:randomUUID(),phase:'disposition',runId,authorizationId:row.authorization_id,state,reasonCode,jobsStarted:receipts.rows.length,receiptIds:receipts.rows.map(receipt=>receipt.id),notificationApprovalSha256:row.notification_approval_sha256!,destinationSha256:row.notification_destination_sha256!,provider:row.notification_provider!};
      await this.insertNotification(client,payload);
    }
  }
  async endRun(runId:string,state:'completed'|'held',reasonCode:ReasonCode):Promise<void> {await this.transaction(client=>this.endRunTransaction(client,runId,state,reasonCode));}
  async pendingNotifications():Promise<OwnerNotification[]> {
    const result=await this.pool.query<{payload:OwnerNotification;payload_sha256:string}>(`SELECT payload,payload_sha256 FROM district_pipeline.owner_notifications WHERE state<>'delivered' ORDER BY created_at,id`);
    for(const row of result.rows)if(digest(canonicalJson(row.payload))!==row.payload_sha256)throw Error('Owner notification byte binding mismatch');
    return result.rows.map(row=>row.payload);
  }
  async recordNotificationDelivery(id:string,acknowledgement:NotificationAcknowledgement|null):Promise<void> {
    const ack=acknowledgement===null?null:NotificationAcknowledgementSchema.parse(acknowledgement);
    await this.transaction(async client=>{
      const notification=await client.query<{run_id:string}>('SELECT run_id FROM district_pipeline.owner_notifications WHERE id=$1',[id]);
      if(!notification.rowCount||!await this.lockRunAuthority(client,notification.rows[0].run_id))throw new DistrictExecutionHold('lease_lost');
      const result=await client.query<{run_id:string}>(`UPDATE district_pipeline.owner_notifications SET state=$2,attempts=attempts+1,delivered_at=CASE WHEN $2='delivered' THEN clock_timestamp() ELSE NULL END,provider=$3,provider_message_id=$4,acknowledged_at=$5 WHERE id=$1 AND state<>'delivered' AND ($2='failed' OR (expected_provider=$3 AND destination_sha256=$6 AND payload_sha256=$7 AND id=$8::uuid)) RETURNING run_id`,[id,ack?'delivered':'failed',ack?.provider??null,ack?.messageId??null,ack?.acknowledgedAt??null,ack?.destinationSha256??null,ack?.payloadSha256??null,ack?.notificationId??null]);
      if(!ack&&result.rowCount){
        await this.endLockedRun(client,result.rows[0].run_id,'held','notification_failed');
        await client.query(`UPDATE district_pipeline.executor_runs SET state='held',reason_code='notification_failed',finished_at=clock_timestamp() WHERE id=$1`,[result.rows[0].run_id]);
      }
      if(ack&&!result.rowCount)throw new DistrictExecutionHold('notification_failed');
    });
  }
  /** Called only while owning the global R1 advisory lock. A crashed attempt is
   * a hold with unknown timing/usage, not a fabricated successful receipt.
   */
  async holdAbandonedRuns(lock:PoolClient):Promise<void> {
    const owned=await lock.query<{owned:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=18441 AND objid=2 AND granted) AS owned`);
    if(!owned.rows[0].owned)throw new DistrictExecutionHold('executor_busy');
    await this.transaction(async client=>{
      // Acquire all run rows before any shared authorization: two old runs may
      // share one authorization while a broker operates on either run.
      const authorities=await client.query<{id:string;authorization_id:string}>(`SELECT r.id,r.authorization_id FROM district_pipeline.executor_runs r WHERE r.state='running' OR EXISTS(SELECT 1 FROM district_pipeline.jobs j WHERE j.lease_owner=r.id AND j.state='leased') ORDER BY r.id FOR UPDATE OF r`);
      const authorizationIds=[...new Set(authorities.rows.map(row=>row.authorization_id))].sort();
      if(authorizationIds.length)await client.query('SELECT id FROM district_pipeline.preauthorizations WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[authorizationIds]);
      const abandoned=await client.query<JobRow & {category:ClaimedJob['category'];now:Date}>(`SELECT j.*,a.category,clock_timestamp() AS now FROM district_pipeline.jobs j JOIN district_pipeline.executor_runs r ON r.id=j.lease_owner JOIN district_pipeline.preauthorizations a ON a.id=r.authorization_id WHERE j.state='leased' AND r.id=ANY($1::uuid[]) ORDER BY j.id FOR UPDATE OF j`,[authorities.rows.map(row=>row.id)]);
      for(const row of abandoned.rows){
        const job:ClaimedJob={id:row.id,jobKey:row.job_key,spec:row.spec,attempt:row.attempt,fencingToken:row.fencing_token,runId:row.lease_owner,enqueuedAt:row.created_at.toISOString(),startedAt:row.attempt_started_at.toISOString(),leaseExpiresAt:row.lease_expires_at.toISOString(),dependencyReceiptIds:row.claimed_dependency_receipt_ids,category:row.category};
        const reason:ReasonCode=row.lease_expires_at<=row.now?'lease_expired':'lease_lost';
        const receipt=makeReceipt(job,{outcome:'held_execution',reasonCode:reason},null,null,row.now.toISOString());
        await this.insertReceipt(client,job,receipt);
        await client.query(`UPDATE district_pipeline.jobs SET state='held_execution',reason_code=$2,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1 WHERE id=$1`,[row.id,reason]);
        await client.query('DELETE FROM district_pipeline.host_lane_leases WHERE job_id=$1',[row.id]);
        await client.query(`UPDATE district_pipeline.provider_reservations SET state='held_uncertain' WHERE job_id=$1 AND state='reserved'`,[row.id]);
      }
      for(const row of authorities.rows)await this.endLockedRun(client,row.id,'held','lease_lost');
    });
  }
  /** Shared budget reservations are also usable by later dependent provider waves.
   * This does not authorize R1 paid execution. Unknown spend remains reserved.
   */
  async reserveProviderBudget(budgetId:string,jobId:string,fencingToken:string,microUsd:number,submissionIntentSha256:string):Promise<string> {
    if(!Number.isSafeInteger(microUsd)||microUsd<=0)throw Error('Worst-case spend reservation required');HashSchema.parse(submissionIntentSha256);
    return this.transaction(async client=>{
      const owner=await client.query<{lease_owner:string}>('SELECT lease_owner FROM district_pipeline.jobs WHERE id=$1 AND state=$2 AND fencing_token=$3',[jobId,'leased',fencingToken]);
      if(!owner.rowCount||!await this.lockRunAuthority(client,owner.rows[0].lease_owner))throw new DistrictExecutionHold('lease_lost');
      const current=await client.query(`SELECT j.id FROM district_pipeline.jobs j JOIN district_pipeline.executor_runs r ON r.id=j.lease_owner JOIN district_pipeline.preauthorizations a ON a.id=r.authorization_id WHERE j.id=$1 AND j.state='leased' AND j.fencing_token=$2 AND j.lease_owner=$3 AND j.lease_expires_at>clock_timestamp() AND NOT j.cancellation_requested AND r.state='running' AND a.state='approved' AND a.expires_at>clock_timestamp() AND a.first_started_at+a.max_elapsed_ms*interval '1 millisecond'>clock_timestamp() AND r.started_at+r.max_elapsed_ms*interval '1 millisecond'>clock_timestamp() FOR UPDATE OF j`,[jobId,fencingToken,owner.rows[0].lease_owner]);if(!current.rowCount)throw new DistrictExecutionHold('lease_lost');
      const budget=await client.query<{cap_micro_usd:string;spent_micro_usd:string;reserved_micro_usd:string;pause_fraction:string;expires_at:Date;paused_reason:string|null;now:Date}>('SELECT *,clock_timestamp() AS now FROM district_pipeline.provider_budgets WHERE id=$1 FOR UPDATE',[budgetId]);
      if(!budget.rowCount)throw new DistrictExecutionHold('budget_exhausted');const row=budget.rows[0];
      if(row.expires_at<=row.now)throw new DistrictExecutionHold('budget_expired');if(row.paused_reason)throw new DistrictExecutionHold('budget_paused');
      const total=BigInt(row.spent_micro_usd)+BigInt(row.reserved_micro_usd)+BigInt(microUsd),cap=BigInt(row.cap_micro_usd);
      if(total>cap)throw new DistrictExecutionHold('budget_exhausted');
      // Numeric pause_fraction is converted to a fixed millionth before bigint math.
      const pauseMillionths=BigInt(Math.floor(Number(row.pause_fraction)*1000000));
      if(total*1000000n>cap*pauseMillionths)throw new DistrictExecutionHold('budget_paused');
      const id=randomUUID();await client.query(`INSERT INTO district_pipeline.provider_reservations(id,budget_id,job_id,fencing_token,reserved_micro_usd,state,submission_intent_sha256) VALUES($1,$2,$3,$4,$5,'reserved',$6)`,[id,budgetId,jobId,fencingToken,microUsd,submissionIntentSha256]);
      await client.query('UPDATE district_pipeline.provider_budgets SET reserved_micro_usd=reserved_micro_usd+$2 WHERE id=$1',[budgetId,microUsd]);return id;
    });
  }
  async recordProviderSubmission(reservationId:string,providerRequestId:string|null,batchId:string|null):Promise<void> {
    if(!providerRequestId&&!batchId)throw Error('Provider submission identifier required');
    const result=await this.pool.query(`UPDATE district_pipeline.provider_reservations SET provider_request_id=$2,batch_id=$3,state='pending_usage' WHERE id=$1 AND state='reserved'`,[reservationId,providerRequestId,batchId]);if(!result.rowCount)throw new DistrictExecutionHold('lease_lost');
  }
  async settleProviderReservation(reservationId:string,actualMicroUsd:number|null):Promise<void> {
    if(actualMicroUsd!==null&&(!Number.isSafeInteger(actualMicroUsd)||actualMicroUsd<0))throw Error('Actual spend rejected');
    await this.transaction(async client=>{
      const reservation=await client.query<{budget_id:string;reserved_micro_usd:string;state:string;actual_micro_usd:string|null}>('SELECT * FROM district_pipeline.provider_reservations WHERE id=$1 FOR UPDATE',[reservationId]);if(!reservation.rowCount)throw Error('Reservation missing');const row=reservation.rows[0];
      if(row.state==='settled'){if(actualMicroUsd!==Number(row.actual_micro_usd))throw Error('Settled spend cannot change');return;}
      if(actualMicroUsd===null){await client.query(`UPDATE district_pipeline.provider_reservations SET state='pending_usage' WHERE id=$1`,[reservationId]);return;}
      await client.query(`UPDATE district_pipeline.provider_budgets SET reserved_micro_usd=reserved_micro_usd-$2,spent_micro_usd=spent_micro_usd+$3,paused_reason=CASE WHEN $3>$2 THEN 'budget_overrun' ELSE paused_reason END WHERE id=$1`,[row.budget_id,row.reserved_micro_usd,actualMicroUsd]);
      await client.query(`UPDATE district_pipeline.provider_reservations SET state='settled',actual_micro_usd=$2 WHERE id=$1`,[reservationId,actualMicroUsd]);
    });
  }
}

function makeReceipt(job:ClaimedJob,result:JobHandlerResult,elapsedMs:number|null,cpu:NodeJS.CpuUsage|null,finishedAt=new Date().toISOString()):StepReceipt {
  return {version:STEP_RECEIPT_VERSION,canonicalizationVersion:CANONICALIZATION_VERSION,id:randomUUID(),runId:job.runId,jobKey:job.jobKey,step:job.spec.step,lane:job.spec.lane,sourceId:job.spec.sourceScope.sourceId,municipalityId:job.spec.sourceScope.municipalityId,attempt:job.attempt,leaseToken:job.fencingToken,category:job.category,dependencyReceiptIds:job.dependencyReceiptIds,enqueuedAt:job.enqueuedAt,startedAt:job.startedAt,finishedAt,queueWaitMs:Math.max(0,Date.parse(job.startedAt)-Date.parse(job.enqueuedAt)),elapsedMs,cpuUserMicros:cpu?.user??null,cpuSystemMicros:cpu?.system??null,outcome:result.outcome,reasonCode:result.reasonCode,inputHashes:job.spec.inputArtifactHashes,outputHashes:[...new Set((result.outputs??[]).map(output=>output.sha256))].sort(),policyProofSha256:job.spec.policyProofSha256,originProofSha256:result.originProofSha256??null,versions:result.versions??{},cache:result.cache??{disposition:'not_applicable',originalGenerationReceiptId:null},provider:result.provider??null,counts:{...unknownReceiptCounts,...result.counts}};
}
export interface ExecutorOptions {store:DistrictJobStore;cas:DistrictCas;handlers:Readonly<Record<string,JobHandler>>;authorizationId:string;mode?:ExecutionMode;ownerPresent?:true;maxJobs:number;maxElapsedMs:number;leaseMs?:number;signal?:AbortSignal;notifyOwner?:NotificationConfig['notifyOwner'];notificationApprovalSha256?:string;notificationDestinationSha256?:string;notificationProvider?:string}
/** No polling daemon, subprocess, arbitrary module loading, or automatic retries.
 * Inject trusted, signal-aware handlers; the only accepted effects are fenced receipts.
 * Late asynchronous results are discarded. JavaScript cannot preempt synchronous
 * CPU loops: handlers must bound CPU work/use isolated parsers, and VM invocation
 * must have an OS hard deadline. Postgres rejects effects past authorization/lease expiry.
 */
export async function runDistrictJobs(options:ExecutorOptions):Promise<ExecutorResult> {
  const mode=options.mode??'attended';
  if(mode!=='attended'&&mode!=='bounded_unattended')throw Error('Execution mode rejected');
  if(mode==='attended'&&options.ownerPresent!==true)throw new DistrictExecutionHold('owner_absent');
  if(mode==='bounded_unattended'&&(!options.notifyOwner||!options.notificationApprovalSha256||!options.notificationDestinationSha256||!options.notificationProvider))throw new DistrictExecutionHold('notification_unavailable');
  if(options.notificationApprovalSha256)HashSchema.parse(options.notificationApprovalSha256);
  if(options.notificationDestinationSha256)HashSchema.parse(options.notificationDestinationSha256);
  if(options.notificationProvider)token.parse(options.notificationProvider);
  const notificationConfig:NotificationConfig|undefined=mode==='bounded_unattended'?{notifyOwner:options.notifyOwner!,notificationApprovalSha256:options.notificationApprovalSha256!,destinationSha256:options.notificationDestinationSha256!,provider:options.notificationProvider!}:undefined;
  if(!Number.isInteger(options.maxJobs)||options.maxJobs<1||options.maxJobs>10000||!Number.isInteger(options.maxElapsedMs)||options.maxElapsedMs<1||options.maxElapsedMs>86400000)throw Error('Executor bounds required');
  const leaseMs=options.leaseMs??30000;if(!Number.isInteger(leaseMs)||leaseMs<50||leaseMs>300000)throw Error('Lease bound rejected');
  const invocationStart=performance.now();
  const lock=await options.store.pool.connect();let run:RunBounds|undefined;let jobsStarted=0;const receiptIds:string[]=[];
  let stopped:ReasonCode|null=null;const stopController=new AbortController();
  const ownerStop=()=>{stopped='owner_stopped';stopController.abort(new DistrictExecutionHold('owner_stopped'));};
  const lockLost=()=>{stopped='lease_lost';stopController.abort(new DistrictExecutionHold('lease_lost'));};
  options.signal?.addEventListener('abort',ownerStop,{once:true});lock.on('error',lockLost);
  try {
    const acquired=await lock.query<{locked:boolean}>('SELECT pg_try_advisory_lock(18441,2) AS locked');
    if(!acquired.rows[0].locked)throw new DistrictExecutionHold('executor_busy');
    if(options.signal?.aborted)throw new DistrictExecutionHold('owner_stopped');
    await options.store.holdAbandonedRuns(lock);
    if(notificationConfig)await deliverDistrictOwnerNotifications(options.store,notificationConfig,Math.max(1,options.maxElapsedMs-(performance.now()-invocationStart)));
    run=await options.store.beginRun(options.authorizationId,options.maxJobs,options.maxElapsedMs,mode,notificationConfig);
    const monotonicStart=performance.now();
    const availableMs=Math.min(run.deadlineAt.getTime()-run.startedAt.getTime(),options.maxElapsedMs-(monotonicStart-invocationStart));
    const deadlineReason:ReasonCode=availableMs<run.deadlineAt.getTime()-run.startedAt.getTime()?'max_time_reached':run.deadlineReason;
    if(notificationConfig)await deliverDistrictOwnerNotifications(options.store,notificationConfig,Math.max(1,availableMs));
    while(jobsStarted<options.maxJobs){
      if(stopped)break;
      if(performance.now()-monotonicStart>=availableMs){stopped=deadlineReason;break;}
      const claim=await options.store.claim(run,leaseMs);
      if(claim.kind==='stop'){stopped=claim.reasonCode;break;}
      const job=claim.job; jobsStarted++;
      const controller=new AbortController();const abortRun=()=>controller.abort(stopController.signal.reason);stopController.signal.addEventListener('abort',abortRun,{once:true});
      const start=performance.now(),cpu=process.cpuUsage();let renewal:Promise<void>|undefined;let timer:NodeJS.Timeout|undefined;let leaseTimer:NodeJS.Timeout|undefined;
      const deadline=setTimeout(()=>controller.abort(new DistrictExecutionHold(deadlineReason)),Math.max(1,availableMs-(performance.now()-monotonicStart)));
      const armLease=(expiresAt:string)=>{
        clearTimeout(leaseTimer);
        const reason:ReasonCode=Date.parse(expiresAt)===run!.deadlineAt.getTime()?run!.deadlineReason:'lease_expired';
        leaseTimer=setTimeout(()=>controller.abort(new DistrictExecutionHold(reason)),Math.max(1,Date.parse(expiresAt)-Date.now()));
      };
      armLease(job.leaseExpiresAt);
      const renew=()=>{timer=setTimeout(()=>{renewal=options.store.renew(run!,job,leaseMs).then(expiresAt=>{if(!controller.signal.aborted){armLease(expiresAt);renew();}},error=>controller.abort(error instanceof DistrictExecutionHold?error:new DistrictExecutionHold('lease_lost')));},Math.max(10,Math.floor(leaseMs/3)));};
      renew();let receipt:StepReceipt|undefined;
      let rejectAbort:((reason:unknown)=>void)|undefined;
      const onAbort=()=>rejectAbort?.(controller.signal.reason);
      controller.signal.addEventListener('abort',onAbort,{once:true});
      try {
        const handler=Object.hasOwn(options.handlers,job.spec.step)?options.handlers[job.spec.step]:undefined;
        if(!handler)throw new DistrictExecutionHold('handler_missing');
        for(const hash of job.spec.inputArtifactHashes){controller.signal.throwIfAborted();try{await options.cas.verify(hash);}catch{throw new DistrictExecutionHold('cas_unavailable');}}
        controller.signal.throwIfAborted();
        const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
        const result=await Promise.race([Promise.resolve().then(()=>handler({job,signal:controller.signal,cas:options.cas,acquireHostLane:laneKey=>options.store.acquireHostLane(run!,job,laneKey)})),aborted]);
        if(controller.signal.aborted)throw controller.signal.reason;
        if(result.provider){
          const provider=result.provider;
          const subscription=provider.provider==='openai-subscription'||provider.provider==='anthropic-subscription';
          // Subscription CLI API-equivalent estimates are not paid invoices.
          if(!subscription||(provider.actualBilledUsd!==null&&provider.actualBilledUsd>0)||provider.reservedMicroUsd>0)throw new DistrictExecutionHold('paid_not_authorized');
        }
        for(const output of result.outputs??[]){controller.signal.throwIfAborted();await options.cas.verify(output.sha256);await options.store.addArtifact(output);}
        receipt=makeReceipt(job,result,performance.now()-start,process.cpuUsage(cpu));
        await options.store.finish(run,job,receipt);receiptIds.push(receipt.id);
        if(result.outcome!=='succeeded'&&result.outcome!=='no_supported_case'){stopped=result.reasonCode;break;}
      } catch(error) {
        const reason=error instanceof DistrictExecutionHold?error.reasonCode:'execution_exception';
        receipt=makeReceipt(job,{outcome:'held_execution',reasonCode:reason},performance.now()-start,process.cpuUsage(cpu));
        if(await options.store.hold(job,reason,receipt))receiptIds.push(receipt.id);
        stopped=reason;break;
      } finally {
        clearTimeout(deadline);clearTimeout(timer);clearTimeout(leaseTimer);controller.signal.removeEventListener('abort',onAbort);controller.abort(new DistrictExecutionHold('owner_stopped'));stopController.signal.removeEventListener('abort',abortRun);await renewal;
      }
    }
    const reasonCode:ReasonCode=stopped??'max_jobs_reached';
    const state=reasonCode==='no_ready_jobs'||reasonCode==='max_jobs_reached'?'completed':'held';
    await options.store.endRun(run.runId,state,reasonCode);
    if(notificationConfig)await deliverDistrictOwnerNotifications(options.store,notificationConfig,Math.max(1,options.maxElapsedMs-(performance.now()-invocationStart)));
    return {runId:run.runId,state,reasonCode,jobsStarted,receiptIds};
  } catch(error) {
    const reason=error instanceof DistrictExecutionHold?error.reasonCode:'execution_exception';
    if(run){
      await options.store.endRun(run.runId,'held',reason);
      if(notificationConfig&&reason!=='notification_failed')await deliverDistrictOwnerNotifications(options.store,notificationConfig,Math.max(1,options.maxElapsedMs-(performance.now()-invocationStart)));
      return {runId:run.runId,state:'held',reasonCode:reason,jobsStarted,receiptIds};
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort',ownerStop);lock.removeListener('error',lockLost);
    try{await lock.query('SELECT pg_advisory_unlock(18441,2)');}finally{lock.release();}
  }
}

/** The outbox is durable before a callback can perform network I/O. Delivery is
 * at least once: callbacks should deduplicate by notification.id. Failures pause,
 * never spin or fall back to an unapproved destination.
 */
export async function deliverDistrictOwnerNotifications(store:DistrictJobStore,config:NotificationConfig,maxElapsedMs=10000):Promise<void> {
  HashSchema.parse(config.notificationApprovalSha256);
  HashSchema.parse(config.destinationSha256);token.parse(config.provider);
  if(!Number.isFinite(maxElapsedMs)||maxElapsedMs<=0)throw Error('Notification time bound required');
  const started=performance.now();
  for(const notification of await store.pendingNotifications()){
    if(notification.notificationApprovalSha256!==config.notificationApprovalSha256||notification.destinationSha256!==config.destinationSha256||notification.provider!==config.provider)throw new DistrictExecutionHold('notification_unavailable');
    let timeout:NodeJS.Timeout|undefined;
    try {
      const remaining=Math.max(1,Math.min(10000,maxElapsedMs-(performance.now()-started)));
      const deadline=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new DistrictExecutionHold('notification_failed')),remaining);});
      const acknowledgement=NotificationAcknowledgementSchema.parse(await Promise.race([Promise.resolve().then(()=>config.notifyOwner(notification)),deadline]));
      if(acknowledgement.destinationSha256!==config.destinationSha256||acknowledgement.provider!==config.provider||acknowledgement.notificationId!==notification.id||acknowledgement.payloadSha256!==digest(canonicalJson(notification)))throw new DistrictExecutionHold('notification_failed');
      await store.recordNotificationDelivery(notification.id,acknowledgement);
    } catch {
      await store.recordNotificationDelivery(notification.id,null);
      throw new DistrictExecutionHold('notification_failed');
    } finally {clearTimeout(timeout);}
  }
}

export const artifactVerificationHandler:JobHandler=async ({job,signal,cas})=>{
  for(const hash of job.spec.inputArtifactHashes){signal.throwIfAborted();await cas.verify(hash);}
  return {outcome:'succeeded',reasonCode:'completed',versions:{cas:'district-cas-v1'}};
};
/** Invoke from an application entrypoint with a fixed registry of real handlers.
 * No handler name is interpreted as a shell command or import path.
 * DATABASE_URL is read only by the runner; it is never logged or passed as context.
 */
export async function runDistrictJobsCli(handlers:Readonly<Record<string,JobHandler>>,argv=process.argv.slice(2),notificationConfig?:NotificationConfig):Promise<void> {
  const [command,...args]=argv;
  if(command!=='migrate'&&command!=='run')throw Error('Usage: district-jobs.ts migrate | run --authorization-id UUID --max-jobs N --max-seconds N [--mode attended --owner-present | --mode bounded_unattended] [--cas-root PATH]');
  const flags:Record<string,string|true>={};
  for(let i=0;i<args.length;i++){const arg=args[i];if(arg==='--owner-present'){if(flags[arg])throw Error('Duplicate CLI flag');flags[arg]=true;}else if(['--authorization-id','--max-jobs','--max-seconds','--cas-root','--mode'].includes(arg)){if(flags[arg]||!args[i+1]||args[i+1].startsWith('--'))throw Error('CLI flag value required');flags[arg]=args[++i];}else throw Error('Unknown CLI flag');}
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required');
  if(command==='migrate'&&args.length)throw Error('Migration accepts no execution flags');
  const mode=flags['--mode']??'attended';
  if(mode!=='attended'&&mode!=='bounded_unattended')throw Error('Execution mode rejected');
  if(command==='run'&&mode==='attended'&&(!process.stdin.isTTY||flags['--owner-present']!==true))throw new DistrictExecutionHold('owner_absent');
  if(command==='run'&&mode==='bounded_unattended'&&(!notificationConfig||flags['--owner-present']))throw new DistrictExecutionHold('notification_unavailable');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4,connectionTimeoutMillis:5000,statement_timeout:10000,application_name:'stadtstack-r1-bounded'});
  const abort=new AbortController();const stop=()=>abort.abort(new DistrictExecutionHold('owner_stopped'));
  try {
    if(command==='migrate'){await migrateDistrictJobs(pool);process.stdout.write('District job migration applied.\n');return;}
    const id=flags['--authorization-id'];const jobs=Number(flags['--max-jobs']),seconds=Number(flags['--max-seconds']);
    if(typeof id!=='string'||!Number.isInteger(jobs)||!Number.isInteger(seconds)||seconds<1)throw Error('Explicit authorization and positive job/time bounds required');
    process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('SIGHUP',stop);
    if(mode==='attended'){process.stdin.on('end',stop);process.stdin.on('close',stop);process.stdin.resume();}
    const result=await runDistrictJobs({store:new DistrictJobStore(pool),cas:new DistrictCas(typeof flags['--cas-root']==='string'?flags['--cas-root']:undefined),handlers,authorizationId:id,mode,ownerPresent:mode==='attended'?true:undefined,maxJobs:jobs,maxElapsedMs:seconds*1000,signal:abort.signal,notifyOwner:notificationConfig?.notifyOwner,notificationApprovalSha256:notificationConfig?.notificationApprovalSha256,notificationDestinationSha256:notificationConfig?.destinationSha256,notificationProvider:notificationConfig?.provider});
    process.stdout.write(JSON.stringify(result)+'\n');if(result.state==='held')process.exitCode=2;
  } finally {
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);process.removeListener('SIGHUP',stop);process.stdin.removeListener('end',stop);process.stdin.removeListener('close',stop);process.stdin.pause();await pool.end();
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  runDistrictJobsCli({verify_artifacts:artifactVerificationHandler}).catch(error=>{process.stderr.write((error instanceof DistrictExecutionHold?error.reasonCode:'District jobs command failed; inspect private state and configuration.')+'\n');process.exitCode=2;});
}
