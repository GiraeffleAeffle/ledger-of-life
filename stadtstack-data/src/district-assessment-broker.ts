import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient,type QueryResultRow} from 'pg';
import {z} from 'zod';
import {canonicalJson,HashSchema,semanticHash,digest,ScopeSchema,type AdapterScope} from './district-adapter-contract.ts';
import {DistrictCas,type CasArtifact,type ArtifactKind} from './district-cas.ts';
import {DistrictJobStore,DistrictExecutionHold,canonicalJobIdentity,type ClaimedJob,type DistrictJobSpec,type JobHandler,type JobHandlerResult} from './district-jobs.ts';
import {assessmentItemSchema,assessmentOutputSchema,originalEvidence,assessmentProviderInput,createAssessmentReceipt,validateReceipt,PROMPTS,digest as assessmentDigest,type AssessmentItem,type AssessmentReceipt,type AssessmentEvidenceContext,type OriginalEvidence} from './district-assessment.ts';
import {loadPolicyReceipt,recheckPolicyReceipt} from './district-policy-receipt.ts';
import {inspectClaudeEvents} from './district-claude.ts';
import type {ModelAnswer} from './district-model-contract.ts';
import type {ReasonCode} from './district-step-receipt.ts';
import {assertCivicPolicyAuthority,readCivicOptOutSnapshot,assertManagedSourceReadable,initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID,type CivicPolicyAuthorityReceipt} from './civic-opt-out.ts';
import {ASSESSMENT_BRIDGE_VERSION,BRIDGE_LIMITS,BridgeLeaseSchema,BridgeRequestSchema,BridgeStatusSchema,BridgePurgeAckSchema,BridgeAnswerSchema,bridgeInputHash,type BridgeAnswer,type BridgeLease,type BridgeRequest,type BridgeStatus} from './district-assessment-bridge-contract.ts';
import {runVmOmpAssessment,ompRunnerContractSha256,type OmpRunnerResult} from './district-omp-b-runner.ts';

export const ASSESSMENT_B_STEP='assessment_b';
export const AssessmentBSelectorSchema=z.discriminatedUnion('transport',[
 z.object({version:z.literal(ASSESSMENT_BRIDGE_VERSION),transport:z.literal('mac-bridge'),role:z.literal('B'),provider:z.literal('anthropic-subscription'),requestedModel:z.literal('claude-haiku-5-5'),itemArtifactSha256:HashSchema,clientContractSha256:HashSchema}).strict(),
 z.object({version:z.literal(ASSESSMENT_BRIDGE_VERSION),transport:z.literal('vm-omp'),role:z.literal('B'),provider:z.literal('anthropic-subscription'),requestedModel:z.literal('claude-haiku-5-5'),itemArtifactSha256:HashSchema,runnerContractSha256:HashSchema}).strict(),
]);
type LeaseState='ready'|'active'|'held'|'expired'|'cancelled'|'submitted';
interface LeaseRow extends QueryResultRow {id:string;job_id:string;run_id:string;fencing_token:string;item_sha256:string;request_artifact_sha256:string;request_sha256:string;input_sha256:string;authority_id:string;authority_sha256:string;policy_snapshot_sha256:string;client_contract_sha256:string;state:LeaseState;reason_code:ReasonCode|null;created_at:Date;deadline_at:Date;client_id:string|null;claimed_at:Date|null;expires_at:Date;receipt_sha256:string|null;purge_ack_sha256:string|null}
interface JobAuthorityRow extends QueryResultRow {id:string;job_key:string;spec:DistrictJobSpec;fencing_token:string;state:string;lease_owner:string|null;lease_expires_at:Date|null;cancellation_requested:boolean;run_state:string;run_started_at:Date;run_max_elapsed_ms:number;authorization_id:string;approval_sha256:string;approved_by:string;approved_at:Date;expires_at:Date;allowed_job_keys:string[];allowed_ags:string[];max_jobs:number;max_elapsed_ms:number;jobs_started:number;first_started_at:Date|null;category:string;execution_mode:string;authorization_state:string;notification_approval_sha256:string|null;notification_destination_sha256:string|null;notification_provider:string|null;now:Date}
interface SourceReference {sha256:string;url:string;policyReceiptSha256:string}
interface CheckedEvidence {item:AssessmentItem;evidence:OriginalEvidence;data:Record<string,unknown>;sources:SourceReference[];sourceAuthority:CivicPolicyAuthorityReceipt;policySnapshotSha256:string;validUntil:number}
interface SubmissionRow extends QueryResultRow {submission_sha256:string;provider_response_sha256:string;answer_artifact_sha256:string;receipt_artifact_sha256:string|null;reconciliation_input_sha256:string;provider_request_id:string|null;provider_response_id:string|null;state:'accepted'|'rejected';reason_code:ReasonCode}
export interface RecordedBridgeAssessment {receipt:AssessmentReceipt;answer:ModelAnswer;providerRequestId:string|null;providerResponseId:string|null;clocks:Pick<BridgeAnswer,'startedAt'|'finishedAt'>}

/** Pin implementation bytes as well as the frozen request contract. No guessed
 * policy source pin: a missing settled module prevents enqueue/execution. */
export async function assessmentBJobContract():Promise<string>{
 const files=['district-assessment-broker.ts','district-assessment.ts','district-assessment-bridge-contract.ts','district-policy-receipt.ts','district-jobs.ts','district-cas.ts','district-claude.ts','district-model-contract.ts','district-omp-b-runner.ts','../docker/omp-b/Dockerfile','../docker/omp-b/settings.yml','../docker/omp-b/entry.sh','../scripts/build-omp-b-image.sh','civic-opt-out.ts','source-policy.ts','document-origin.ts'];
 return semanticHash({version:ASSESSMENT_BRIDGE_VERSION,files:await Promise.all(files.map(async file=>({file,sha256:digest(await readFile(new URL(file,import.meta.url)))})))});
}
function hardDeadline(row:JobAuthorityRow):number{
 return Math.min(row.expires_at.getTime(),row.run_started_at.getTime()+row.run_max_elapsed_ms,(row.first_started_at?.getTime()??0)+row.max_elapsed_ms);
}
function disposition(row:JobAuthorityRow,runId:string,fence:string):ReasonCode|null{
 if(row.cancellation_requested)return 'cancellation_requested';
 if(row.state!=='leased'||row.lease_owner!==runId||row.fencing_token!==fence||row.run_state!=='running')return 'lease_lost';
 if(!row.lease_expires_at||row.lease_expires_at<=row.now)return 'lease_expired';
 if(row.authorization_state!=='approved')return 'authorization_revoked';
 if(row.expires_at<=row.now)return 'authorization_expired';
 if(!row.first_started_at||row.first_started_at.getTime()+row.max_elapsed_ms<=row.now.getTime())return 'authorization_time_exhausted';
 if(row.run_started_at.getTime()+row.run_max_elapsed_ms<=row.now.getTime())return 'max_time_reached';
 if(!row.allowed_job_keys.includes(row.job_key)||!row.allowed_ags.includes(row.spec.sourceScope.ags)||row.jobs_started>row.max_jobs)return 'authorization_revoked';
 return null;
}
function status(row:LeaseRow):BridgeStatus{
 return BridgeStatusSchema.parse({version:ASSESSMENT_BRIDGE_VERSION,state:row.state==='ready'?'held':row.state,leaseId:row.id,inputSha256:row.input_sha256,expiresAt:row.expires_at.toISOString(),authoritySha256:row.authority_sha256,policySnapshotSha256:row.policy_snapshot_sha256,receiptSha256:row.receipt_sha256,purgeAckSha256:row.purge_ack_sha256});
}
export function assessmentEvidenceArtifactHashes(item:AssessmentItem):string[]{return [...new Set(item.sources.flatMap(source=>[source.originalSha256,source.textSha256,source.parserReceiptSha256,source.admissionReceiptSha256]))].sort();}
function same(a:unknown,b:unknown):boolean{return canonicalJson(a)===canonicalJson(b);}

/** Independently parse the actual provider stream on the VM. A client-created
 * receipt or claimed success boolean is never an accepted assessment. */
export function assessmentBridgeReceipt(item:AssessmentItem,evidence:OriginalEvidence,data:unknown,input:unknown,window:{claimedAt:string;deadlineAt:string;receivedAt:string}):RecordedBridgeAssessment{
 const raw=BridgeAnswerSchema.parse(input);
 const started=Date.parse(raw.startedAt),finished=Date.parse(raw.finishedAt),received=Date.parse(window.receivedAt);
 if(started<Date.parse(window.claimedAt)||finished<started||finished>Date.parse(window.deadlineAt)||finished>received||!same(data,assessmentProviderInput(item,evidence)))throw Error('Original assessment clock/request binding failed');
 const inspected=inspectClaudeEvents(raw.stdout);
 if(!inspected.completed||inspected.toolAttempted||inspected.failureCategory||!inspected.responseSha256||!inspected.reportedModels.length)throw Error('Actual pinned provider execution failed');
 const answer:ModelAnswer={value:inspected.value,responseSha256:inspected.responseSha256,returnedModel:inspected.reportedModels[0],runtimeWarnings:[],evidence:raw.evidence,requestedModel:'claude-haiku-5-5',reportedModels:inspected.reportedModels,usage:inspected.usage};
 const receipt=createAssessmentReceipt(item,'B',answer,{startedAt:raw.startedAt,finishedAt:raw.finishedAt},evidence);
 if(receipt.requestSha256!==assessmentDigest(data)||receipt.dependencies.length||receipt.provider!=='anthropic-subscription')throw Error('Blind B receipt request/provider binding failed');
 let providerRequestId:string|null=null,providerResponseId:string|null=null;
 for(const line of raw.stdout.split('\n')){
  if(!line.trim())continue;
  const event:Record<string,unknown>=JSON.parse(line);
  const message=event.message&&typeof event.message==='object'?event.message as Record<string,unknown>:null;
  if(typeof event.request_id==='string'&&/^[A-Za-z0-9._:-]{1,256}$/.test(event.request_id))providerRequestId=event.request_id;
  if(message&&typeof message.id==='string'&&/^[A-Za-z0-9._:-]{1,256}$/.test(message.id))providerResponseId=message.id;
 }
 return {receipt,answer,providerRequestId,providerResponseId,clocks:{startedAt:raw.startedAt,finishedAt:raw.finishedAt}};
}

/** Trusted VM runner only. The class has no model/source/network fetch capability.
 * SSH authenticates the existing Mac user; all policy and queue authority stay VM-side. */
export class DistrictAssessmentBroker {
 readonly store:DistrictJobStore;
 readonly context:AssessmentEvidenceContext;
 readonly pool:Pool;
 readonly cas:DistrictCas;
 constructor(pool:Pool,cas:DistrictCas,options:Omit<AssessmentEvidenceContext,'cas'>={}){this.pool=pool;this.cas=cas;this.store=new DistrictJobStore(pool);this.context={...options,cas};}
 private async transaction<T>(body:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect();
  try{await client.query('BEGIN');const result=await body(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 private async job(client:PoolClient,id:string,runId:string):Promise<JobAuthorityRow>{
  // Match DistrictJobStore: run -> preauthorization -> job -> bridge lease.
  // These row locks live until the operation commits; an unlocked final read
  // cannot serialize revocation or run termination against evidence/acceptance.
  const run=await client.query<{authorization_id:string}>('SELECT authorization_id FROM district_pipeline.executor_runs WHERE id=$1 FOR UPDATE',[runId]);
  if(run.rows.length!==1)throw new DistrictExecutionHold('lease_lost');
  const approval=await client.query('SELECT id FROM district_pipeline.preauthorizations WHERE id=$1 FOR UPDATE',[run.rows[0].authorization_id]);
  if(approval.rows.length!==1)throw new DistrictExecutionHold('authorization_revoked');
  const result=await client.query<JobAuthorityRow>(`SELECT j.*,r.state AS run_state,r.started_at AS run_started_at,r.max_elapsed_ms AS run_max_elapsed_ms,r.authorization_id,a.approval_sha256,a.approved_by,a.approved_at,a.expires_at,a.allowed_job_keys,a.allowed_ags,a.max_jobs,a.max_elapsed_ms,a.jobs_started,a.first_started_at,a.category,a.execution_mode,a.state AS authorization_state,a.notification_approval_sha256,a.notification_destination_sha256,a.notification_provider,clock_timestamp() AS now FROM district_pipeline.jobs j JOIN district_pipeline.executor_runs r ON r.id=$2 JOIN district_pipeline.preauthorizations a ON a.id=r.authorization_id WHERE j.id=$1 FOR UPDATE OF j`,[id,runId]);
  if(result.rows.length!==1)throw new DistrictExecutionHold('lease_lost');
  return result.rows[0];
 }
 private async checkedEvidence(client:PoolClient,itemHash:string,spec:DistrictJobSpec):Promise<CheckedEvidence>{
  const sourceAuthority=await assertCivicPolicyAuthority(this.context.policyOptions),optout=await readCivicOptOutSnapshot(this.context.policyOptions);
  if(sourceAuthority.mode!=='codex-workstation-local'||sourceAuthority.authorityId!==optout.authorityId||sourceAuthority.authoritySha256!==optout.authoritySha256)throw new DistrictExecutionHold('authorization_revoked');
  const item=assessmentItemSchema.parse(JSON.parse((await this.cas.read(itemHash)).toString('utf8')));
  if(digest(canonicalJson(item))!==itemHash)throw new DistrictExecutionHold('quality_failed');
  const hashes=[itemHash,...assessmentEvidenceArtifactHashes(item)];
  if(hashes.some(hash=>!spec.inputArtifactHashes.includes(hash)))throw new DistrictExecutionHold('policy_excluded');
  const artifacts=await client.query<{sha256:string;disposition:string}>('SELECT sha256,disposition FROM district_pipeline.artifacts WHERE sha256=ANY($1::text[])',[hashes]);
  if(artifacts.rows.length!==new Set(hashes).size||artifacts.rows.some(row=>row.disposition!=='retained'))throw new DistrictExecutionHold('policy_excluded');
  const currentAdmissionReceipts:Record<string,string>={};
  const sources:SourceReference[]=[],snapshots:{sourceId:string;originalSha256:string;scope:AdapterScope;snapshotSha256:string;currentReceiptSha256:string}[]=[];
  let validUntil=Infinity,primary=false;
  for(const source of item.sources){
   const original=await loadPolicyReceipt(this.cas,source.admissionReceiptSha256);
   const scope=original.scope;
   if(scope.municipalityId!==spec.sourceScope.municipalityId||scope.ags!==spec.sourceScope.ags)throw new DistrictExecutionHold('policy_excluded');
   if(same(scope,spec.sourceScope)&&source.admissionReceiptSha256===spec.policyProofSha256)primary=true;
   const originalRow=await client.query<{state:string;receipt_json:unknown}>('SELECT state,receipt_json FROM district_pipeline.policy_decisions WHERE proof_sha256=$1 AND source_sha256=$2',[source.admissionReceiptSha256,source.originalSha256]);
   if(originalRow.rows.length!==1||originalRow.rows[0].state!=='allowed'||!same(originalRow.rows[0].receipt_json,original))throw new DistrictExecutionHold('policy_excluded');
   const configured=this.context.currentAdmissionReceipts?.[source.admissionReceiptSha256];
   const currentRows=await client.query<{proof_sha256:string;receipt_json:unknown}>(`SELECT p.proof_sha256,p.receipt_json FROM district_pipeline.policy_decisions p JOIN district_pipeline.source_snapshots s ON s.id=p.source_snapshot_id JOIN district_pipeline.artifacts a ON a.sha256=p.proof_sha256 AND a.disposition='retained' WHERE p.source_sha256=$1 AND p.state='allowed' AND p.checked_at<=clock_timestamp() AND p.expires_at>clock_timestamp() AND s.publisher_id=$2 AND s.source_id=$3 AND s.municipality_id=$4 AND s.ags=$5 AND s.tenant IS NOT DISTINCT FROM $6 AND s.observation_window=$7 AND ($8::text IS NULL OR p.proof_sha256=$8) ORDER BY p.checked_at DESC,p.proof_sha256 LIMIT 1`,[source.originalSha256,scope.publisherId,scope.sourceId,scope.municipalityId,scope.ags,scope.tenant,scope.observationWindow,configured??null]);
   if(currentRows.rows.length!==1)throw new DistrictExecutionHold('policy_expired');
   const currentRow=currentRows.rows[0],current=await loadPolicyReceipt(this.cas,currentRow.proof_sha256);
   if(!same(current,currentRow.receipt_json))throw new DistrictExecutionHold('policy_excluded');
   const checked=await recheckPolicyReceipt(original,{...this.context.policyOptions,evaluationAt:new Date().toISOString(),currentProof:current});
   currentAdmissionReceipts[source.admissionReceiptSha256]=currentRow.proof_sha256;
   validUntil=Math.min(validUntil,Date.parse(current.expiresAt));
   sources.push({sha256:source.originalSha256,url:original.source.url,policyReceiptSha256:source.admissionReceiptSha256});
   snapshots.push({sourceId:source.sourceId,originalSha256:source.originalSha256,scope,snapshotSha256:checked.snapshotSha256,currentReceiptSha256:currentRow.proof_sha256});
   for(const hash of new Set([itemHash,source.originalSha256,source.textSha256,source.parserReceiptSha256,source.admissionReceiptSha256,currentRow.proof_sha256]))await assertManagedSourceReadable(resolve(this.cas.root,'sha256',hash.slice(0,2),hash),{...this.context.policyOptions,sourceUrl:original.source.url});
  }
  if(!primary)throw new DistrictExecutionHold('policy_excluded');
  const evidence=await originalEvidence(item,{...this.context,currentAdmissionReceipts});
  const data=assessmentProviderInput(item,evidence);
  if(Buffer.byteLength(canonicalJson(data))>BRIDGE_LIMITS.evidenceContextBytes)throw new DistrictExecutionHold('quality_failed');
  const finalAuthority=await assertCivicPolicyAuthority(this.context.policyOptions),finalOptout=await readCivicOptOutSnapshot(this.context.policyOptions);
  if(!same(finalAuthority,sourceAuthority)||finalOptout.authorityId!==sourceAuthority.authorityId||finalOptout.authoritySha256!==sourceAuthority.authoritySha256||finalOptout.sha256!==optout.sha256)throw new DistrictExecutionHold('authorization_revoked');
  return {item,evidence,data,sources,sourceAuthority,policySnapshotSha256:semanticHash({sourceAuthority,optOutSnapshotSha256:optout.sha256,sources:snapshots.sort((a,b)=>a.sourceId.localeCompare(b.sourceId))}),validUntil};
 }
 private async persist(client:PoolClient,bytes:Buffer,kind:ArtifactKind,sources:SourceReference[],observationId:string,mimeType='application/json'):Promise<CasArtifact>{
  const hash=digest(bytes),storageKey=`sha256/${hash.slice(0,2)}/${hash}`;
  await initializeManagedAcquisitionLane(this.cas.root,{...this.context.policyOptions,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
  const artifact=await withManagedSourceWrite(this.cas.root,sources.map(source=>({kind:'prepared_source' as const,relativePath:storageKey,contentSha256:hash,sourceSha256:source.sha256,url:source.url,observationId,receiptSha256:source.policyReceiptSha256,independentAllowed:false})),()=>this.cas.put(bytes,{kind,mimeType}),this.context.policyOptions);
  await client.query(`INSERT INTO district_pipeline.artifacts(sha256,kind,mime_type,byte_length,storage_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(sha256) DO NOTHING`,[artifact.sha256,artifact.kind,artifact.mimeType,artifact.byteLength,artifact.storageKey]);
  const row=await client.query<{byte_length:string;storage_key:string;disposition:string}>('SELECT byte_length,storage_key,disposition FROM district_pipeline.artifacts WHERE sha256=$1',[hash]);
  if(Number(row.rows[0]?.byte_length)!==artifact.byteLength||row.rows[0]?.storage_key!==storageKey||row.rows[0]?.disposition!=='retained')throw new DistrictExecutionHold('policy_excluded');
  return artifact;
 }
 private async event(client:PoolClient,row:LeaseRow,state:LeaseState,reason:ReasonCode):Promise<void>{
  await client.query('INSERT INTO district_pipeline.assessment_bridge_events(id,lease_id,state,reason_code) VALUES($1,$2,$3,$4)',[randomUUID(),row.id,state,reason]);
 }
 private async hold(client:PoolClient,row:LeaseRow,reason:ReasonCode):Promise<BridgeStatus>{
  if(row.state==='ready'||row.state==='active'){
   const state:LeaseState=reason==='cancellation_requested'?'cancelled':reason==='lease_expired'?'expired':'held';
   await client.query('UPDATE district_pipeline.assessment_bridge_leases SET state=$2,reason_code=$3 WHERE id=$1',[row.id,state,reason]);
   row.state=state;row.reason_code=reason;await this.event(client,row,state,reason);
  }
  return status(row);
 }
 private async current(client:PoolClient,row:LeaseRow):Promise<{job:JobAuthorityRow;checked:CheckedEvidence}|{reason:ReasonCode}>{
  try{
   const job=await this.job(client,row.job_id,row.run_id),reason=disposition(job,row.run_id,row.fencing_token);
   if(reason)return {reason};
   if(row.deadline_at<=job.now||(row.state==='active'&&row.expires_at<=job.now))return {reason:'lease_expired'};
   const checked=await this.checkedEvidence(client,row.item_sha256,job.spec);
   if(checked.sourceAuthority.authorityId!==row.authority_id||checked.sourceAuthority.authoritySha256!==row.authority_sha256)return {reason:'authorization_revoked'};
   if(checked.policySnapshotSha256!==row.policy_snapshot_sha256||assessmentDigest(checked.data)!==row.request_sha256)return {reason:'policy_excluded'};
   const latest=await this.job(client,row.job_id,row.run_id),latestReason=disposition(latest,row.run_id,row.fencing_token);
   if(latestReason)return {reason:latestReason};
   if(row.deadline_at<=latest.now||(row.state==='active'&&row.expires_at<=latest.now))return {reason:'lease_expired'};
   return {job:latest,checked};
  }catch(error){return {reason:error instanceof DistrictExecutionHold?error.reasonCode:'policy_excluded'};}
 }
 async prepare(job:ClaimedJob,signal:AbortSignal):Promise<string>{
  signal.throwIfAborted();
  const selector=AssessmentBSelectorSchema.parse(job.spec.selector);
  if(job.spec.step!==ASSESSMENT_B_STEP||job.spec.lane!=='assessment'||job.spec.semanticContractSha256!==await assessmentBJobContract()||canonicalJobIdentity(job.spec).jobKey!==job.jobKey||selector.transport==='vm-omp'&&selector.runnerContractSha256!==await ompRunnerContractSha256())throw new DistrictExecutionHold('quality_failed');
  return this.transaction(async client=>{
   const current=await this.job(client,job.id,job.runId),reason=disposition(current,job.runId,job.fencingToken);
   if(reason)throw new DistrictExecutionHold(reason);
   const intent=await client.query('SELECT lease_id FROM district_pipeline.assessment_bridge_submission_intents WHERE job_id=$1',[job.id]);
   if(intent.rowCount)throw new DistrictExecutionHold('execution_exception'); // Exposure is ambiguous forever until separately reconciled, even after queue resume.
   const existing=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE job_id=$1 FOR UPDATE',[job.id]);
   if(existing.rows.some(row=>row.claimed_at!==null||row.fencing_token===job.fencingToken))throw new DistrictExecutionHold('execution_exception');
   // Only an explicitly resumed/newly authorized queue attempt may replace an
   // unexposed lease. Preserve its historical hold; never reset or erase it.
   for(const prior of existing.rows)if(prior.state==='ready'||prior.state==='active')await this.hold(client,prior,'lease_lost');
   const checked=await this.checkedEvidence(client,selector.itemArtifactSha256,job.spec);
   signal.throwIfAborted();
   const request=await this.persist(client,Buffer.from(canonicalJson(checked.data)),'derived',checked.sources,job.jobKey);
   const id=randomUUID(),deadline=new Date(Math.min(hardDeadline(current),checked.validUntil,current.now.getTime()+BRIDGE_LIMITS.maxLeaseMs));
   const clientContractSha256=selector.transport==='mac-bridge'?selector.clientContractSha256:selector.runnerContractSha256;
   const binding={jobKey:job.jobKey,authorityId:checked.sourceAuthority.authorityId,authoritySha256:checked.sourceAuthority.authoritySha256,policySnapshotSha256:checked.policySnapshotSha256,role:'B' as const,provider:'anthropic-subscription' as const,requestedModel:'claude-haiku-5-5' as const,system:PROMPTS.B,data:checked.data,outputSchema:z.toJSONSchema(assessmentOutputSchema),clientContractSha256};
   const inputSha256=bridgeInputHash(binding);
   const latest=await this.job(client,job.id,job.runId),latestReason=disposition(latest,job.runId,job.fencingToken);
   if(latestReason)throw new DistrictExecutionHold(latestReason);
   if(deadline<=latest.now)throw new DistrictExecutionHold('lease_expired');
   signal.throwIfAborted();
   await client.query(`INSERT INTO district_pipeline.assessment_bridge_leases(id,job_id,run_id,fencing_token,item_sha256,request_artifact_sha256,request_sha256,input_sha256,authority_id,authority_sha256,policy_snapshot_sha256,client_contract_sha256,role,provider,requested_model,state,deadline_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'B','anthropic-subscription','claude-haiku-5-5','ready',$13,$13)`,[id,job.id,job.runId,job.fencingToken,selector.itemArtifactSha256,request.sha256,assessmentDigest(checked.data),inputSha256,binding.authorityId,binding.authoritySha256,checked.policySnapshotSha256,clientContractSha256,deadline]);
   await client.query('INSERT INTO district_pipeline.assessment_bridge_events(id,lease_id,state,reason_code) VALUES($1,$2,\'ready\',\'completed\')',[randomUUID(),id]);
   return id;
  });
 }
 private async acknowledgePurge(client:PoolClient,row:LeaseRow,ackInput:unknown,receivedAt:Date):Promise<void>{
  const ack=BridgePurgeAckSchema.parse(ackInput),completed=Date.parse(ack.completedAt),hash=semanticHash(ack);
  if(!row.claimed_at||completed<row.claimed_at.getTime()||completed>receivedAt.getTime())throw new DistrictExecutionHold('quality_failed');
  if(row.purge_ack_sha256){if(row.purge_ack_sha256!==hash)throw new DistrictExecutionHold('quality_failed');return;}
  await client.query('INSERT INTO district_pipeline.assessment_bridge_purge_acknowledgements(lease_id,input_sha256,ack_sha256,acknowledgement) VALUES($1,$2,$3,$4)',[row.id,row.input_sha256,hash,ack]);
  await client.query('UPDATE district_pipeline.assessment_bridge_leases SET purge_ack_sha256=$2 WHERE id=$1',[row.id,hash]);row.purge_ack_sha256=hash;
 }
 async dispatch(input:unknown):Promise<BridgeLease|BridgeStatus>{
  const request=BridgeRequestSchema.parse(input);
  return this.transaction(async client=>{
   // Locate without locking first, then acquire authority rows before the lease.
   const located=await client.query<LeaseRow>(request.operation==='claim'?'SELECT b.* FROM district_pipeline.assessment_bridge_leases b JOIN district_pipeline.jobs j ON j.id=b.job_id WHERE j.job_key=$1 ORDER BY b.created_at DESC,b.id DESC LIMIT 1':'SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1',[request.operation==='claim'?request.jobKey:request.leaseId]);
   if(located.rows.length!==1)throw new DistrictExecutionHold('dependency_uncommitted');
   const identity=located.rows[0];
   const authority=await this.job(client,identity.job_id,identity.run_id),selector=AssessmentBSelectorSchema.parse(authority.spec.selector);
   if(selector.transport!=='mac-bridge')throw new DistrictExecutionHold('isolation_unavailable');
   const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[identity.id]);
   if(found.rows.length!==1)throw new DistrictExecutionHold('lease_lost');
   const row=found.rows[0];
   if(request.operation==='claim'){
    if(request.clientContractSha256!==row.client_contract_sha256)throw new DistrictExecutionHold('isolation_unavailable');
    if(row.state!=='ready')return status(row); // Never retransmit evidence after a recorded intent.
    const current=await this.current(client,row);if('reason' in current)return this.hold(client,row,current.reason);
    const now=current.job.now,expires=new Date(Math.min(now.getTime()+BRIDGE_LIMITS.leaseMs,row.deadline_at.getTime()));
    const lease=BridgeLeaseSchema.parse({version:ASSESSMENT_BRIDGE_VERSION,leaseId:row.id,jobKey:request.jobKey,inputSha256:row.input_sha256,authorityId:row.authority_id,authoritySha256:row.authority_sha256,policySnapshotSha256:row.policy_snapshot_sha256,expiresAt:expires.toISOString(),role:'B',provider:'anthropic-subscription',requestedModel:'claude-haiku-5-5',system:PROMPTS.B,data:current.checked.data,outputSchema:z.toJSONSchema(assessmentOutputSchema),clientContractSha256:row.client_contract_sha256});
    const intentSha256=semanticHash({version:ASSESSMENT_BRIDGE_VERSION,leaseId:row.id,jobKey:request.jobKey,runId:row.run_id,fencingToken:row.fencing_token,inputSha256:row.input_sha256,clientId:request.clientId,provider:lease.provider,model:lease.requestedModel});
    // COMMIT occurs before dispatch returns any evidence to the private SSH pipe.
    await client.query('INSERT INTO district_pipeline.assessment_bridge_submission_intents(lease_id,job_id,run_id,fencing_token,input_sha256,intent_sha256,client_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.id,row.job_id,row.run_id,row.fencing_token,row.input_sha256,intentSha256,request.clientId]);
    await client.query(`UPDATE district_pipeline.assessment_bridge_leases SET state='active',client_id=$2,claimed_at=$3,expires_at=$4,last_checked_at=$3 WHERE id=$1`,[row.id,request.clientId,now,expires]);row.state='active';await this.event(client,row,'active','completed');
    return lease;
   }
   if(request.inputSha256!==row.input_sha256)throw new DistrictExecutionHold('quality_failed');
   const clock=await client.query<{now:Date}>('SELECT clock_timestamp() AS now'),receivedAt=clock.rows[0].now;
   if(request.operation==='abandon'){
    await this.acknowledgePurge(client,row,request.purgeAck,receivedAt);
    const current=await this.current(client,row);
    const reason='reason' in current?current.reason:request.reason==='lease_expired'?'lease_expired':request.reason==='authority_changed'?'authorization_revoked':'execution_exception';
    return this.hold(client,row,reason);
   }
   if(request.operation==='submit'&&row.state==='submitted'){
    const prior=await client.query<SubmissionRow>('SELECT * FROM district_pipeline.assessment_bridge_submissions WHERE lease_id=$1',[row.id]);
    if(prior.rows[0]?.submission_sha256!==semanticHash(request))throw new DistrictExecutionHold('quality_failed');
    return status(row); // Exact immutable acknowledgement replay, not another model call.
   }
   if(request.operation==='submit')await this.acknowledgePurge(client,row,request.purgeAck,receivedAt);
   if(row.state!=='active')return status(row);
   const current=await this.current(client,row);if('reason' in current)return this.hold(client,row,current.reason);
   if(request.operation==='check'){
    const expiry=new Date(Math.min(Date.now()+BRIDGE_LIMITS.leaseMs,row.deadline_at.getTime(),hardDeadline(current.job),current.checked.validUntil));
    await client.query('UPDATE district_pipeline.assessment_bridge_leases SET expires_at=$2,last_checked_at=clock_timestamp() WHERE id=$1',[row.id,expiry]);row.expires_at=expiry;return status(row);
   }
   return this.submit(client,row,request,current.checked,receivedAt);
  });
 }
 private async submit(client:PoolClient,row:LeaseRow,request:Extract<BridgeRequest,{operation:'submit'}>,checked:CheckedEvidence,receivedAt:Date):Promise<BridgeStatus>{
  const raw=BridgeAnswerSchema.parse(request.answer);
  if(Date.parse(request.purgeAck.completedAt)<Date.parse(raw.finishedAt))return this.hold(client,row,'quality_failed');
  const response=await this.persist(client,Buffer.from(raw.stdout),'provider_response',checked.sources,row.id,'application/x-ndjson');
  let parsed:RecordedBridgeAssessment|undefined;
  try{parsed=assessmentBridgeReceipt(checked.item,checked.evidence,checked.data,raw,{claimedAt:row.claimed_at!.toISOString(),deadlineAt:row.expires_at.toISOString(),receivedAt:receivedAt.toISOString()});}catch{/* Rejected execution is preserved, never converted into a fake assessment. */}
  const answer=await this.persist(client,Buffer.from(canonicalJson({version:'assessment-bridge-answer-v1',inputSha256:row.input_sha256,providerResponseArtifactSha256:response.sha256,evidence:raw.evidence,startedAt:raw.startedAt,finishedAt:raw.finishedAt,answer:parsed?.answer??null})),'derived',checked.sources,row.id);
  const receipt=parsed?await this.persist(client,Buffer.from(canonicalJson(parsed.receipt)),'receipt',checked.sources,row.id):null;
  const reconciliation=await this.persist(client,Buffer.from(canonicalJson({version:'assessment-bridge-reconciliation-input-v1',itemArtifactSha256:row.item_sha256,requestArtifactSha256:row.request_artifact_sha256,requestSha256:row.request_sha256,inputSha256:row.input_sha256,receiptArtifactSha256:receipt?.sha256??null,B:parsed?.receipt??null,deterministicIssues:parsed?.receipt.deterministicIssues??null,disposition:parsed?'assessment_recorded':'held_execution',providerResponseArtifactSha256:response.sha256})),'derived',checked.sources,row.id);
  // Recheck after CAS writes: revocation/expiry during persistence cannot commit accepted effects.
  const final=await this.current(client,row);
  const accepted=parsed!==undefined&&!('reason' in final),reason:ReasonCode='reason' in final?final.reason:accepted?'completed':'quality_failed';
  await client.query(`INSERT INTO district_pipeline.assessment_bridge_submissions(lease_id,submission_sha256,provider_response_sha256,answer_artifact_sha256,receipt_artifact_sha256,reconciliation_input_sha256,provider_request_id,provider_response_id,state,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[row.id,semanticHash(request),response.sha256,answer.sha256,accepted?receipt!.sha256:null,reconciliation.sha256,parsed?.providerRequestId??null,parsed?.providerResponseId??null,accepted?'accepted':'rejected',reason]);
  if(!accepted)return this.hold(client,row,reason);
  await client.query(`UPDATE district_pipeline.assessment_bridge_leases SET state='submitted',reason_code='completed',receipt_sha256=$2 WHERE id=$1`,[row.id,receipt!.sha256]);row.state='submitted';row.receipt_sha256=receipt!.sha256;await this.event(client,row,'submitted','completed');
  return status(row);
 }
 async waitForAssessment(job:ClaimedJob,signal:AbortSignal):Promise<JobHandlerResult>{
  const selector=AssessmentBSelectorSchema.parse(job.spec.selector);
  if(selector.transport!=='mac-bridge')throw new DistrictExecutionHold('quality_failed');
  try{
   await this.prepare(job,signal);
   for(;;){
    signal.throwIfAborted();
    const result=await this.transaction(async client=>{
     await this.job(client,job.id,job.runId);
     const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE job_id=$1 AND run_id=$2 AND fencing_token=$3 FOR UPDATE',[job.id,job.runId,job.fencingToken]),row=found.rows[0];
     if(!row)throw new DistrictExecutionHold('lease_lost');
     if(row.run_id!==job.runId||row.fencing_token!==job.fencingToken)throw new DistrictExecutionHold('lease_lost');
     const checked=await this.current(client,row);
     if('reason' in checked&&row.state!=='submitted')await this.hold(client,row,checked.reason);
     if(row.state==='ready'||row.state==='active')return null;
     if(row.state!=='submitted')return {outcome:'held_execution' as const,reasonCode:row.reason_code??'execution_exception'};
     if('reason' in checked)throw new DistrictExecutionHold(checked.reason);
     const submission=await client.query<SubmissionRow>('SELECT * FROM district_pipeline.assessment_bridge_submissions WHERE lease_id=$1',[row.id]),saved=submission.rows[0];
     const selector=AssessmentBSelectorSchema.parse(job.spec.selector);
     if(!saved||saved.state!=='accepted'||!saved.receipt_artifact_sha256||selector.transport==='mac-bridge'&&!row.purge_ack_sha256)throw new DistrictExecutionHold('quality_failed');
     const receipt=validateReceipt(JSON.parse((await this.cas.read(saved.receipt_artifact_sha256)).toString('utf8')),checked.checked.item,'B');
     if(receipt.requestSha256!==row.request_sha256||receipt.provider!=='anthropic-subscription'||receipt.dependencies.length)throw new DistrictExecutionHold('quality_failed');
     const hashes=[row.request_artifact_sha256,saved.provider_response_sha256,saved.answer_artifact_sha256,saved.receipt_artifact_sha256,saved.reconciliation_input_sha256];
     const artifacts=await client.query<{sha256:string;kind:ArtifactKind;mime_type:string;byte_length:string;storage_key:string;disposition:string}>('SELECT * FROM district_pipeline.artifacts WHERE sha256=ANY($1::text[])',[hashes]);
     if(artifacts.rows.length!==new Set(hashes).size||artifacts.rows.some(a=>a.disposition!=='retained'))throw new DistrictExecutionHold('policy_excluded');
     const intent=await client.query<{intent_sha256:string}>('SELECT intent_sha256 FROM district_pipeline.assessment_bridge_submission_intents WHERE lease_id=$1',[row.id]);
     const tokens=(receipt.usage as ModelAnswer['usage']).topLevel;
     return {outcome:receipt.deterministicIssues.length||receipt.output.outcome==='unresolved'?'held_quality' as const:'succeeded' as const,reasonCode:receipt.deterministicIssues.length||receipt.output.outcome==='unresolved'?'quality_failed' as const:'completed' as const,outputs:artifacts.rows.map(a=>({sha256:a.sha256,byteLength:Number(a.byte_length),kind:a.kind,mimeType:a.mime_type,storageKey:a.storage_key})),versions:{assessment:ASSESSMENT_BRIDGE_VERSION,role:'B'},provider:{provider:receipt.provider,endpoint:'max-subscription-cli',requestedModel:receipt.requestedModel,returnedModel:receipt.returnedModel,requestId:saved.provider_request_id,responseId:saved.provider_response_id,requestSha256:receipt.requestSha256,responseSha256:receipt.responseSha256,batchId:null,customId:job.jobKey,submissionIntentSha256:intent.rows[0].intent_sha256,tokens:{standardInput:tokens?.inputTokens??null,cacheWriteInput:tokens?.cacheCreationTokens??null,cacheReadInput:tokens?.cacheReadTokens??null,output:tokens?.outputTokens??null},actualBilledUsd:null,estimatedApiUsd:receipt.estimatedApiUsd,currency:'USD' as const,rateCardDate:null,rateCardSha256:null,reservedMicroUsd:0,subscriptionUsage:{availability:'unavailable' as const,units:null}}};
    });
    if(result)return result;
    await delay(500,undefined,{signal});
   }
  }finally{
   if(signal.aborted)await this.transaction(async client=>{await this.job(client,job.id,job.runId);const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE job_id=$1 AND run_id=$2 AND fencing_token=$3 FOR UPDATE',[job.id,job.runId,job.fencingToken]);if(found.rows[0])await this.hold(client,found.rows[0],signal.reason instanceof DistrictExecutionHold?signal.reason.reasonCode:'owner_stopped');});
  }
 }
 async waitForVmOmpAssessment(job:ClaimedJob,signal:AbortSignal):Promise<JobHandlerResult>{
  let leaseId:string|undefined;
  try{
   const selector=AssessmentBSelectorSchema.parse(job.spec.selector);
   if(selector.transport!=='vm-omp'||selector.runnerContractSha256!==await ompRunnerContractSha256())throw new DistrictExecutionHold('quality_failed');
   leaseId=await this.prepare(job,signal);
   const prepared=await this.transaction(async client=>{
    const authority=await this.job(client,job.id,job.runId),reason=disposition(authority,job.runId,job.fencingToken);
    if(reason)throw new DistrictExecutionHold(reason);
    const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]);
    const row=found.rows[0];if(!row||row.state!=='ready'||row.fencing_token!==job.fencingToken)throw new DistrictExecutionHold('lease_lost');
    const current=await this.current(client,row);if('reason' in current)throw new DistrictExecutionHold(current.reason);
    const clock=await client.query<{now:Date}>('SELECT clock_timestamp() AS now'),claimedAt=clock.rows[0]!.now;
    if(row.deadline_at<=claimedAt||current.checked.validUntil<=claimedAt.getTime())throw new DistrictExecutionHold('lease_expired');
    const expiresAt=new Date(Math.min(claimedAt.getTime()+BRIDGE_LIMITS.maxLeaseMs,row.deadline_at.getTime(),hardDeadline(current.job),current.checked.validUntil));
    if(expiresAt<=claimedAt)throw new DistrictExecutionHold('lease_expired');
    const intentSha256=semanticHash({version:ASSESSMENT_BRIDGE_VERSION,leaseId:row.id,jobKey:job.jobKey,runId:job.runId,fencingToken:job.fencingToken,inputSha256:row.input_sha256,clientId:'vm-omp-docker',provider:'anthropic-subscription',model:'claude-haiku-5-5'});
    await client.query('INSERT INTO district_pipeline.assessment_bridge_submission_intents(lease_id,job_id,run_id,fencing_token,input_sha256,intent_sha256,client_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.id,job.id,job.runId,job.fencingToken,row.input_sha256,intentSha256,'vm-omp-docker']);
    await client.query(`UPDATE district_pipeline.assessment_bridge_leases SET state='active',client_id='vm-omp-docker',claimed_at=$2,expires_at=$3,last_checked_at=$2 WHERE id=$1`,[row.id,claimedAt,expiresAt]);
    row.state='active';row.client_id='vm-omp-docker';row.claimed_at=claimedAt;row.expires_at=expiresAt;
    await this.event(client,row,'active','completed');
    return {row,checked:current.checked,intentSha256,claimedAt};
   });
   signal.throwIfAborted();
   let run:OmpRunnerResult;
   try{run=await runVmOmpAssessment(prepared.checked.data,{
    ...this.context.policyOptions,root:this.cas.root,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,
    authorityId:prepared.checked.sourceAuthority.authorityId,authoritySha256:prepared.checked.sourceAuthority.authoritySha256,
    bindings:prepared.checked.sources.map(source=>({kind:'prepared_source',url:source.url,sourceSha256:source.sha256,observationId:prepared.row.id,receiptSha256:source.policyReceiptSha256})),
   },signal,{beforeHandoff:async()=>{
    await this.transaction(async client=>{
     const authority=await this.job(client,job.id,job.runId),authorityReason=disposition(authority,job.runId,job.fencingToken);
     if(authorityReason)throw new DistrictExecutionHold(authorityReason);
     const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]),row=found.rows[0];
     if(!row||row.state!=='active'||row.fencing_token!==job.fencingToken)throw new DistrictExecutionHold('lease_lost');
     const current=await this.current(client,row);if('reason' in current)throw new DistrictExecutionHold(current.reason);
    });
   }});}catch(error){
    const reason=error instanceof DistrictExecutionHold?error.reasonCode:'execution_exception';
    await this.transaction(async client=>{await this.job(client,job.id,job.runId);const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]);if(found.rows[0])await this.hold(client,found.rows[0],reason);});
    return {outcome:'held_execution',reasonCode:reason};
   }
   const result=await this.transaction(async client=>{
    const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]),row=found.rows[0];
    if(!row||row.state!=='active'||row.fencing_token!==job.fencingToken)throw new DistrictExecutionHold('lease_lost');
    const checked=await this.current(client,row);
    if('reason' in checked){await this.hold(client,row,checked.reason);return {outcome:'held_execution' as const,reasonCode:checked.reason};}
    const receivedAt=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    const receipt=createAssessmentReceipt(checked.checked.item,'B',run.answer,{startedAt:run.startedAt,finishedAt:run.finishedAt},checked.checked.evidence);
    if(receipt.requestSha256!==row.request_sha256||receipt.schemaSha256!==run.outputSchemaSha256||receipt.dependencies.length||receipt.provider!=='anthropic-subscription'||Date.parse(run.startedAt)<prepared.claimedAt.getTime()||Date.parse(run.finishedAt)>Math.min(row.expires_at.getTime(),receivedAt.getTime()))throw new DistrictExecutionHold('quality_failed');
    const transport={selector:'anthropic/claude-haiku-5-5',transport:'vm-omp-docker',transportMayInternallyRetry:true,internalRetryDisclosure:'Provider transient retries may occur up to ten times with one authentication retry; usage covers only the final attempt.',usageScope:'final_attempt_only',networkDisclosure:'Default bridge egress permits inference and may permit shared model-catalog refreshes; no egress-only inference restriction is enforced.',promptDisclosure:'The source-free control prompt includes the exact frozen output schema; stock omp may append generated context, footer, date, or cwd material despite this pinned file.',imageId:run.imageId,settingsSha256:run.settingsSha256,systemPromptSha256:run.systemPromptSha256,outputSchemaSha256:run.outputSchemaSha256,accountLabelSha256:run.accountLabelSha256,runnerContractSha256:run.runnerContractSha256};
    const response=await this.persist(client,Buffer.from(run.stdout),'provider_response',checked.checked.sources,row.id,'application/x-ndjson');
    const answer=await this.persist(client,Buffer.from(canonicalJson({version:'assessment-vm-omp-answer-v1',inputSha256:row.input_sha256,responseArtifactSha256:response.sha256,modelAnswer:run.answer,transport,startedAt:run.startedAt,finishedAt:run.finishedAt})),'derived',checked.checked.sources,row.id);
    const savedReceipt=await this.persist(client,Buffer.from(canonicalJson(receipt)),'receipt',checked.checked.sources,row.id);
    const reconciliation=await this.persist(client,Buffer.from(canonicalJson({version:'assessment-vm-omp-reconciliation-v1',itemArtifactSha256:row.item_sha256,requestArtifactSha256:row.request_artifact_sha256,requestSha256:row.request_sha256,inputSha256:row.input_sha256,receiptArtifactSha256:savedReceipt.sha256,B:receipt,deterministicIssues:receipt.deterministicIssues,disposition:'assessment_recorded',providerResponseArtifactSha256:response.sha256,transport})),'derived',checked.checked.sources,row.id);
    const final=await this.current(client,row);
    if('reason' in final){await this.hold(client,row,final.reason);return {outcome:'held_execution' as const,reasonCode:final.reason};}
    await client.query(`INSERT INTO district_pipeline.assessment_bridge_submissions(lease_id,submission_sha256,provider_response_sha256,answer_artifact_sha256,receipt_artifact_sha256,reconciliation_input_sha256,provider_request_id,provider_response_id,state,reason_code) VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,'accepted','completed')`,[row.id,semanticHash({leaseId:row.id,inputSha256:row.input_sha256,responseSha256:run.answer.responseSha256}),response.sha256,answer.sha256,savedReceipt.sha256,reconciliation.sha256]);
    await client.query(`UPDATE district_pipeline.assessment_bridge_leases SET state='submitted',reason_code='completed',receipt_sha256=$2 WHERE id=$1`,[row.id,savedReceipt.sha256]);
    row.state='submitted';row.receipt_sha256=savedReceipt.sha256;await this.event(client,row,'submitted','completed');
    const hashes=[row.request_artifact_sha256,response.sha256,answer.sha256,savedReceipt.sha256,reconciliation.sha256];
    const artifacts=await client.query<{sha256:string;kind:ArtifactKind;mime_type:string;byte_length:string;storage_key:string;disposition:string}>('SELECT * FROM district_pipeline.artifacts WHERE sha256=ANY($1::text[])',[hashes]);
    if(artifacts.rows.length!==new Set(hashes).size||artifacts.rows.some(item=>item.disposition!=='retained'))throw new DistrictExecutionHold('policy_excluded');
    const tokens=run.answer.usage.topLevel;
    return {outcome:receipt.deterministicIssues.length||receipt.output.outcome==='unresolved'?'held_quality' as const:'succeeded' as const,reasonCode:receipt.deterministicIssues.length||receipt.output.outcome==='unresolved'?'quality_failed' as const:'completed' as const,outputs:artifacts.rows.map(item=>({sha256:item.sha256,byteLength:Number(item.byte_length),kind:item.kind,mimeType:item.mime_type,storageKey:item.storage_key})),versions:{assessment:ASSESSMENT_BRIDGE_VERSION,role:'B',transport:'vm-omp-docker',runnerContractSha256:run.runnerContractSha256,imageId:run.imageId,settingsSha256:run.settingsSha256,systemPromptSha256:run.systemPromptSha256,outputSchemaSha256:run.outputSchemaSha256,accountLabelSha256:run.accountLabelSha256,transportMayInternallyRetry:'true'},provider:{provider:receipt.provider,endpoint:'omp-cli-vm-docker',requestedModel:receipt.requestedModel,returnedModel:receipt.returnedModel,requestId:null,responseId:null,requestSha256:receipt.requestSha256,responseSha256:receipt.responseSha256,batchId:null,customId:job.jobKey,submissionIntentSha256:prepared.intentSha256,tokens:{standardInput:tokens?.inputTokens??null,cacheWriteInput:tokens?.cacheCreationTokens??null,cacheReadInput:tokens?.cacheReadTokens??null,output:tokens?.outputTokens??null},actualBilledUsd:null,estimatedApiUsd:receipt.estimatedApiUsd,currency:'USD' as const,rateCardDate:null,rateCardSha256:null,reservedMicroUsd:0,subscriptionUsage:{availability:'unavailable' as const,units:null}}};
   });
   return result;
  }catch(error){
   if(leaseId)try{await this.transaction(async client=>{await this.job(client,job.id,job.runId);const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]);if(found.rows[0])await this.hold(client,found.rows[0],error instanceof DistrictExecutionHold?error.reasonCode:'execution_exception');});}catch{}
   if(error instanceof DistrictExecutionHold)throw error;
   throw new DistrictExecutionHold('execution_exception');
  }finally{
   if(signal.aborted&&leaseId)await this.transaction(async client=>{await this.job(client,job.id,job.runId);const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]);if(found.rows[0])await this.hold(client,found.rows[0],'owner_stopped');});
  }
 }
}

/** Fixed registry entry. Never run Codex in place of offline/unavailable Haiku. */
export function assessmentBJobHandler(broker:DistrictAssessmentBroker):JobHandler{return ({job,signal,cas})=>{if(cas.root!==broker.cas.root)throw new DistrictExecutionHold('cas_unavailable');const selector=AssessmentBSelectorSchema.parse(job.spec.selector);return selector.transport==='vm-omp'?broker.waitForVmOmpAssessment(job,signal):broker.waitForAssessment(job,signal);};}
export async function enqueueAssessmentB(broker:DistrictAssessmentBroker,input:({itemArtifactSha256:string;sourceScope:AdapterScope;policyProofSha256:string;transport:'mac-bridge';clientContractSha256:string}|{itemArtifactSha256:string;sourceScope:AdapterScope;policyProofSha256:string;transport:'vm-omp'})):Promise<string>{
 const base={version:ASSESSMENT_BRIDGE_VERSION,role:'B',provider:'anthropic-subscription',requestedModel:'claude-haiku-5-5',itemArtifactSha256:input.itemArtifactSha256};
 const selector=AssessmentBSelectorSchema.parse(input.transport==='mac-bridge'?{...base,transport:input.transport,clientContractSha256:input.clientContractSha256}:{...base,transport:input.transport,runnerContractSha256:await ompRunnerContractSha256()});
 const item=assessmentItemSchema.parse(JSON.parse((await broker.cas.read(selector.itemArtifactSha256)).toString('utf8')));
 return broker.store.enqueue({step:ASSESSMENT_B_STEP,lane:'assessment',semanticContractSha256:await assessmentBJobContract(),inputArtifactHashes:[...new Set([selector.itemArtifactSha256,...assessmentEvidenceArtifactHashes(item)])].sort(),sourceScope:ScopeSchema.parse(input.sourceScope),selector,policyProofSha256:HashSchema.parse(input.policyProofSha256)});
}

/** Only the fixed SSH-invoked command may use this private raw JSON channel.
 * Application/operator CLI wrappers must print generic receipt IDs, not its output. */
export async function assessmentBrokerCli(broker:DistrictAssessmentBroker,input:NodeJS.ReadableStream=process.stdin,output:NodeJS.WritableStream=process.stdout):Promise<void>{
 let bytes=0;const chunks:Buffer[]=[];
 for await(const chunk of input){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));bytes+=buffer.length;if(bytes>BRIDGE_LIMITS.requestBytes)throw new DistrictExecutionHold('quality_failed');chunks.push(buffer);}
 const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 const result=await broker.dispatch(request),encoded=canonicalJson(result)+'\n';
 if(Buffer.byteLength(encoded)>BRIDGE_LIMITS.responseBytes)throw new DistrictExecutionHold('quality_failed');
 output.write(encoded);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const main=async()=>{
  if(process.platform!=='linux'||process.argv.length!==2||!process.env.DATABASE_URL||!process.env.SSH_CONNECTION||process.stdin.isTTY||process.stdout.isTTY)throw new DistrictExecutionHold('isolation_unavailable');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:5000,statement_timeout:10000});
  try{await assessmentBrokerCli(new DistrictAssessmentBroker(pool,new DistrictCas(resolve(root,'cache/districts/cas'),{maxBytes:32*1024*1024})));}finally{await pool.end();}
 };
 main().catch(()=>{process.stderr.write('Assessment bridge held; inspect VM-only authorization and private receipts. No fallback attempted.\n');process.exitCode=2;});
}
