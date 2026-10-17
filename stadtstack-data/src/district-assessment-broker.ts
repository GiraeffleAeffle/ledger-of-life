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
import {loadPolicyReceipt,recheckPolicyReceipt,type PolicyReceipt} from './district-policy-receipt.ts';
import {inspectClaudeEvents} from './district-claude.ts';
import type {ModelAnswer} from './district-model-contract.ts';
import {StepReceiptSchema,encodeStepReceipt,type ReasonCode} from './district-step-receipt.ts';
import {assertCivicPolicyAuthority,readCivicOptOutSnapshot,assertManagedSourceReadable,initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID,CivicPolicyStateError,type CivicPolicyAuthorityReceipt} from './civic-opt-out.ts';
import {ASSESSMENT_BRIDGE_VERSION,NATIVE_B_BRIDGE_VERSION,NATIVE_B_LIFECYCLE_LIMITS,BRIDGE_LIMITS,BridgeLeaseSchema,BridgeRequestSchema,BridgeStatusSchema,BridgePurgeAckSchema,BridgeAnswerSchema,bridgeInputHash,nativeBInputHash,type BridgeAnswer,type BridgeLease,type BridgeRequest,type BridgeStatus} from './district-assessment-bridge-contract.ts';
import {runVmOmpAssessment,ompRunnerOutputContractSha256,OmpRunnerHold,OmpAssessmentOutputRejected,OmpNativeCleanupSchema,OmpOutputRejectionSchema,ompOutputRejectionVersions,ompOutputRejectionFromVersions,type OmpOutputRejection,type OmpRunnerResult} from './district-omp-b-runner.ts';
import {AssessmentContextHold,assertAssessmentContextBound} from './district-assessment-context.ts';
import {assertValueAssessmentContext} from './district-value-context.ts';
import {assertBSubscriptionResume,recordBSubscriptionHold,bSubscriptionFailureVersions} from './district-subscription-usage.ts';
import {OmpFailureKindSchema,OmpContainerExitCodeSchema,OmpDecodeCheckSchema} from './district-exception-diagnostics.ts';
import {ompOutputStructureVersions,OmpOutputStructureSchema} from './district-omp-output-diagnostics.ts';
import {NATIVE_B_MODEL,NATIVE_B_SELECTOR,assertNativeBResponseIdentity} from './district-b-native-model.ts';

/** Closed, content-free native hold classification; never persist an error message. */
export function assessmentBridgeHoldReason(error:unknown):ReasonCode{
 if(error instanceof DistrictExecutionHold)return error.reasonCode;
 if(error instanceof OmpAssessmentOutputRejected)return 'quality_failed';
 if(error instanceof OmpRunnerHold&&error.subscriptionLimit)return 'budget_paused';
 if(error instanceof OmpRunnerHold)return `omp_${error.reason}`;
 return 'execution_exception';
}
/** Preserve only the governed limit proof and a closed host diagnostic label. */
export function assessmentBridgeFailureVersions(leaseId:string,error:unknown):Record<string,string>{
 if(!(error instanceof OmpRunnerHold))return {};
 const versions=error.failureProof?bSubscriptionFailureVersions(leaseId,error.noOutput,error.failureProof):{};
 const kind=OmpFailureKindSchema.safeParse(error.failureKind);
 if(kind.success)versions.ompFailureKind=kind.data;
 const exit=OmpContainerExitCodeSchema.safeParse(error.containerExitCode);
 if(exit.success)versions.ompContainerExitCode=String(exit.data);
 const check=OmpDecodeCheckSchema.safeParse(error.decodeCheck);
 if(check.success)versions.ompDecodeCheck=check.data;
 if(error.controlMode==='0444')versions.ompControlMode='0444';
 if(error instanceof OmpAssessmentOutputRejected){
  const rejection=OmpOutputRejectionSchema.safeParse(error.rejection);
  if(rejection.success)Object.assign(versions,ompOutputRejectionVersions(rejection.data));
 }
 return versions;
}

export const ASSESSMENT_B_STEP='assessment_b';
export const AssessmentBSelectorSchema=z.union([
 z.object({version:z.literal(ASSESSMENT_BRIDGE_VERSION),transport:z.literal('mac-bridge'),role:z.literal('B'),provider:z.literal('anthropic-subscription'),requestedModel:z.literal('claude-haiku-5-5'),itemArtifactSha256:HashSchema,clientContractSha256:HashSchema}).strict(),
 z.object({version:z.literal(ASSESSMENT_BRIDGE_VERSION),transport:z.literal('vm-omp'),role:z.literal('B'),provider:z.literal('anthropic-subscription'),requestedModel:z.literal('claude-haiku-5-5'),itemArtifactSha256:HashSchema,runnerOutputContractSha256:HashSchema}).strict(),
 z.object({version:z.literal(NATIVE_B_BRIDGE_VERSION),transport:z.literal('vm-omp'),role:z.literal('B'),provider:z.literal('anthropic-subscription'),requestedModel:z.literal(NATIVE_B_MODEL),itemArtifactSha256:HashSchema,runnerOutputContractSha256:HashSchema}).strict(),
]);
type LeaseState='ready'|'active'|'held'|'expired'|'cancelled'|'submitted';
interface LeaseRow extends QueryResultRow {id:string;job_id:string;run_id:string;fencing_token:string;requested_model:'claude-haiku-5-5'|typeof NATIVE_B_MODEL;item_sha256:string;request_artifact_sha256:string;request_sha256:string;input_sha256:string;authority_id:string;authority_sha256:string;policy_snapshot_sha256:string;client_contract_sha256:string;state:LeaseState;reason_code:ReasonCode|null;created_at:Date;deadline_at:Date;client_id:string|null;claimed_at:Date|null;expires_at:Date;receipt_sha256:string|null;purge_ack_sha256:string|null}
interface JobAuthorityRow extends QueryResultRow {id:string;job_key:string;spec:DistrictJobSpec;fencing_token:string;state:string;lease_owner:string|null;lease_expires_at:Date|null;cancellation_requested:boolean;run_state:string;run_started_at:Date;run_max_elapsed_ms:number;authorization_id:string;approval_sha256:string;approved_by:string;approved_at:Date;expires_at:Date;allowed_job_keys:string[];allowed_ags:string[];max_jobs:number;max_elapsed_ms:number;jobs_started:number;first_started_at:Date|null;category:string;execution_mode:string;authorization_state:string;notification_approval_sha256:string|null;notification_destination_sha256:string|null;notification_provider:string|null;now:Date}
interface SourceReference {sha256:string;url:string;policyReceiptSha256:string}
interface PolicyPin {originalSha256:string;originalReceiptSha256:string;original:PolicyReceipt;currentReceiptSha256:string;current:PolicyReceipt;configured:string|undefined}
interface CheckedEvidence {item:AssessmentItem;evidence:OriginalEvidence;data:Record<string,unknown>;sources:SourceReference[];sourceAuthority:CivicPolicyAuthorityReceipt;policySnapshotSha256:string;optOutSnapshotSha256:string;artifactHashes:string[];policyPins:PolicyPin[];validUntil:number}
type EvidenceCheck={checked:CheckedEvidence}|{reason:ReasonCode};
interface SubmissionRow extends QueryResultRow {lease_id:string;submission_sha256:string;provider_response_sha256:string;answer_artifact_sha256:string;receipt_artifact_sha256:string|null;reconciliation_input_sha256:string;provider_request_id:string|null;provider_response_id:string|null;state:'accepted'|'rejected';reason_code:ReasonCode;committed_at:Date}
export interface RecordedBridgeAssessment {receipt:AssessmentReceipt;answer:ModelAnswer;providerRequestId:string|null;providerResponseId:string|null;clocks:Pick<BridgeAnswer,'startedAt'|'finishedAt'>}
interface StagedSubmission {response:CasArtifact;answer:CasArtifact;receipt:CasArtifact|null;reconciliation:CasArtifact;parsed:RecordedBridgeAssessment|undefined}
interface OmpRejectionBinding {leaseId:string;jobKey:string;runId:string;fencingToken:string;inputSha256:string;itemSha256:string;requestSha256:string}
function rejectedOmpArtifacts(binding:OmpRejectionBinding,rejection:OmpOutputRejection){
 const response={version:'assessment-vm-omp-rejected-response-v1',...binding,rejection,retained:'hashes-and-closed-diagnostics-only'};
 const responseSha256=digest(canonicalJson(response));
 const answer={version:'assessment-vm-omp-rejected-answer-v1',...binding,responseArtifactSha256:responseSha256,modelAnswer:null};
 const answerSha256=digest(canonicalJson(answer));
 const reconciliation={version:'assessment-vm-omp-rejected-reconciliation-v1',...binding,responseArtifactSha256:responseSha256,answerArtifactSha256:answerSha256,disposition:'held_quality',reasonCode:'quality_failed',assessmentReceiptSha256:null};
 const reconciliationSha256=digest(canonicalJson(reconciliation));
 const submissionSha256=semanticHash({version:'assessment-vm-omp-rejection-v1',...binding,responseSha256,answerSha256,reconciliationSha256});
 return {response,answer,reconciliation,responseSha256,answerSha256,reconciliationSha256,submissionSha256};
}
/** Explicit immutable-history dispatch; native Sonnet never hashes as Haiku v1. */
export function assessmentBIntentHash(binding:{leaseId:string;jobKey:string;runId:string;fencingToken:string;inputSha256:string;clientId:string},model:LeaseRow['requested_model']):string{
 if(model!=='claude-haiku-5-5'&&model!==NATIVE_B_MODEL)throw new DistrictExecutionHold('quality_failed');
 return semanticHash({version:model===NATIVE_B_MODEL?NATIVE_B_BRIDGE_VERSION:ASSESSMENT_BRIDGE_VERSION,...binding,provider:'anthropic-subscription',model});
}
/** Read-only terminal evidence: never treats generic rejected/ambiguous intents as settled. */
export async function settledOmpOutputRejectionLeases(pool:Pick<Pool,'query'>,jobKey:string):Promise<string[]>{
 HashSchema.parse(jobKey);
 const rows=await pool.query<LeaseRow&{receipt:unknown;receipt_hash:string;receipt_id:string;submission_sha256:string;provider_response_sha256:string;answer_artifact_sha256:string;reconciliation_input_sha256:string;intent_sha256:string}>(`
  SELECT l.*,r.receipt,r.receipt_sha256 AS receipt_hash,r.id AS receipt_id,s.submission_sha256,s.provider_response_sha256,s.answer_artifact_sha256,s.reconciliation_input_sha256,i.intent_sha256
  FROM district_pipeline.jobs j JOIN district_pipeline.assessment_bridge_leases l ON l.job_id=j.id
  JOIN district_pipeline.assessment_bridge_submission_intents i ON i.lease_id=l.id AND i.job_id=j.id AND i.run_id=l.run_id AND i.fencing_token=l.fencing_token AND i.input_sha256=l.input_sha256 AND i.client_id='vm-omp-docker'
  JOIN district_pipeline.assessment_bridge_submissions s ON s.lease_id=l.id AND s.state='rejected' AND s.reason_code='quality_failed' AND s.receipt_artifact_sha256 IS NULL
  JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.run_id=l.run_id AND r.fencing_token=l.fencing_token AND r.fencing_token=j.fencing_token AND r.attempt=j.attempt
  WHERE j.job_key=$1 AND j.spec->>'step'='assessment_b' AND j.state='held_quality' AND j.reason_code='quality_failed'
   AND r.outcome='held_quality' AND l.state='held' AND l.reason_code='quality_failed' AND l.client_id='vm-omp-docker'
   AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY[s.provider_response_sha256,s.answer_artifact_sha256,s.reconciliation_input_sha256]) requested(hash)
    WHERE NOT EXISTS(SELECT 1 FROM district_pipeline.artifacts a WHERE a.sha256=requested.hash AND a.disposition='retained'))`,[jobKey]);
 const settled:string[]=[];
 for(const row of rows.rows){
  const parsed=StepReceiptSchema.safeParse(row.receipt);if(!parsed.success)continue;const receipt=parsed.data,v=receipt.versions;
  if(receipt.id!==row.receipt_id||receipt.jobKey!==jobKey||receipt.runId!==row.run_id||receipt.leaseToken!==String(row.fencing_token)||receipt.step!=='assessment_b'||receipt.outcome!=='held_quality'||receipt.reasonCode!=='quality_failed'||encodeStepReceipt(receipt).sha256!==row.receipt_hash||v.transport!=='vm-omp-docker'||v.ompContainerExitCode!=='0'||v.ompBridgeLeaseId!==row.id)continue;
  const proof=ompOutputRejectionFromVersions(v);if(!proof)continue;
  if(proof.version==='omp-output-rejection-v3'&&proof.structure.delivery.requestSha256!==row.request_sha256)continue;
  const binding={leaseId:row.id,jobKey,runId:row.run_id,fencingToken:String(row.fencing_token),inputSha256:row.input_sha256,itemSha256:row.item_sha256,requestSha256:row.request_sha256};
  const expected=rejectedOmpArtifacts(binding,proof);
  if(row.intent_sha256!==assessmentBIntentHash({leaseId:row.id,jobKey,runId:row.run_id,fencingToken:String(row.fencing_token),inputSha256:row.input_sha256,clientId:'vm-omp-docker'},row.requested_model)
   ||row.submission_sha256!==expected.submissionSha256||v.ompSubmissionSha256!==row.submission_sha256||v.ompOutputSettlementSha256!==expected.answerSha256
   ||row.provider_response_sha256!==expected.responseSha256||row.answer_artifact_sha256!==expected.answerSha256||row.reconciliation_input_sha256!==expected.reconciliationSha256)continue;
  const hashes=[expected.responseSha256,expected.answerSha256,expected.reconciliationSha256];
  if(hashes.some(hash=>!receipt.outputHashes.includes(hash)))continue;
  settled.push(row.id);
 }
 return settled;
}

/** Mixed broker request/output interpretation stays semantic; live authorization
 * and custody imports are not transitive output fingerprints. */
export async function assessmentBJobContract(hash?:(file:string)=>Promise<string>):Promise<string>{
 const files=['district-assessment-broker.ts','district-b-native-model.ts','district-assessment-projection.ts','district-schema.ts','district-graph-claims.ts','district-assessment.ts','district-assessment-context.ts','district-value-context.ts','pilot-value-transcript.ts','district-claims.ts','district-assessment-bridge-contract.ts','district-claude.ts','district-model-contract.ts','district-omp-b-runner.ts','district-omp-output-diagnostics.ts','district-subscription-limit.ts','district-execution-profile.ts','../docker/omp-b/Dockerfile','../docker/omp-b/settings.yml','../docker/omp-b/entry.sh','../docker/omp-b/natives.sha256','../scripts/build-omp-b-image.sh'];
 return semanticHash({version:NATIVE_B_BRIDGE_VERSION,files:await Promise.all(files.map(async file=>({file,sha256:hash?await hash(file):digest(await readFile(new URL(file,import.meta.url)))})))});
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
export function assessmentEvidenceArtifactHashes(item:AssessmentItem):string[]{return [...new Set([...item.sources.flatMap(source=>[source.originalSha256,source.textSha256,source.parserReceiptSha256,source.admissionReceiptSha256]),...(item.valueContext?[item.valueContext.custodyReceiptSha256]:[])])].sort();}
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

/** Native B uses the reviewed VM runner; legacy Mac dispatch is isolated-fixture only.
 * Source evidence remains managed and provider handoff stays runner-owned. */
export class DistrictAssessmentBroker {
 readonly store:DistrictJobStore;
 readonly context:AssessmentEvidenceContext;
 readonly pool:Pool;
 readonly cas:DistrictCas;
 readonly fixtureProtocol:boolean;
 private readonly fixtureOmpRunner?:typeof runVmOmpAssessment;
 private readonly nativeLifecycle:{leaseMs:number;heartbeatMs:number};
 constructor(pool:Pool,cas:DistrictCas,options:Omit<AssessmentEvidenceContext,'cas'>&{fixtureProtocol?:true;fixtureOmpRunner?:typeof runVmOmpAssessment;fixtureNativeLifecycle?:{leaseMs:number;heartbeatMs:number}}={}){
  const {fixtureProtocol,fixtureOmpRunner,fixtureNativeLifecycle,...context}=options;
  if(fixtureProtocol&&(!context.policyOptions?.authorityId?.startsWith('fixture:')||!context.policyOptions.authoritySha256||!context.policyOptions.stateDir)||(fixtureOmpRunner||fixtureNativeLifecycle)&&!fixtureProtocol)throw new DistrictExecutionHold('authorization_revoked');
  this.pool=pool;this.cas=cas;this.store=new DistrictJobStore(pool);this.context={...context,cas};this.fixtureProtocol=fixtureProtocol===true;this.fixtureOmpRunner=fixtureOmpRunner;
  this.nativeLifecycle=fixtureNativeLifecycle?z.object({leaseMs:z.number().int().min(100).max(NATIVE_B_LIFECYCLE_LIMITS.leaseMs),heartbeatMs:z.number().int().min(10)}).strict().refine(v=>v.heartbeatMs*2<v.leaseMs).parse(fixtureNativeLifecycle):NATIVE_B_LIFECYCLE_LIMITS;
 }
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
 private async checkedEvidence(itemHash:string,spec:DistrictJobSpec):Promise<CheckedEvidence>{
  const sourceAuthority=await assertCivicPolicyAuthority(this.context.policyOptions),optout=await readCivicOptOutSnapshot(this.context.policyOptions);
  const requiredMode=this.fixtureProtocol?'isolated-fixture':'codex-workstation-local';
  if(sourceAuthority.mode!==requiredMode||sourceAuthority.authorityId!==optout.authorityId||sourceAuthority.authoritySha256!==optout.authoritySha256)throw new DistrictExecutionHold('authorization_revoked');
  const item=assessmentItemSchema.parse(JSON.parse((await this.cas.read(itemHash)).toString('utf8')));
  if(digest(canonicalJson(item))!==itemHash)throw new DistrictExecutionHold('quality_failed');
  if(item.valueTarget)assertValueAssessmentContext(item);
  const anchor=item.valueContext?await loadPolicyReceipt(this.cas,item.valueContext.custodyReceiptSha256):undefined;
  const hashes=[...new Set([itemHash,...assessmentEvidenceArtifactHashes(item),...(anchor?[anchor.source.sha256]:[])])];
  if(hashes.some(hash=>!spec.inputArtifactHashes.includes(hash)))throw new DistrictExecutionHold('policy_excluded');
  const artifacts=await this.pool.query<{sha256:string;disposition:string}>('SELECT sha256,disposition FROM district_pipeline.artifacts WHERE sha256=ANY($1::text[])',[hashes]);
  if(artifacts.rows.length!==new Set(hashes).size||artifacts.rows.some(row=>row.disposition!=='retained'))throw new DistrictExecutionHold('policy_excluded');
  const currentAdmissionReceipts:Record<string,string>={};
  const artifactHashes=new Set(hashes),policyPins:PolicyPin[]=[];
  const sources:SourceReference[]=[],snapshots:{sourceId:string;originalSha256:string;scope:AdapterScope;snapshotSha256:string;currentReceiptSha256:string}[]=[];
  let validUntil=Infinity,primary=false;
  // Custody may belong to another town; only this non-evidence anchor is exempt
  // from the question's town filter. Actual answer sources always retain it.
  const custodySource=anchor?{sourceId:anchor.scope.sourceId,originalSha256:anchor.source.sha256,
    admissionReceiptSha256:item.valueContext!.custodyReceiptSha256,textSha256:item.valueContext!.custodyReceiptSha256,
    parserReceiptSha256:item.valueContext!.custodyReceiptSha256}:undefined;
  const policySources=[...item.sources,...custodySource&&!item.sources.some(source=>source.admissionReceiptSha256===custodySource.admissionReceiptSha256)?[custodySource]:[]];
  for(const source of policySources){
   const original=await loadPolicyReceipt(this.cas,source.admissionReceiptSha256);
   const scope=original.scope;
   if(item.valueTarget){
    const cities=z.array(z.string()).parse(item.valueTarget.question.cityIds);
    if(source!==custodySource&&!cities.includes(scope.municipalityId))throw new DistrictExecutionHold('policy_excluded');
   }else if(scope.municipalityId!==spec.sourceScope.municipalityId||scope.ags!==spec.sourceScope.ags)throw new DistrictExecutionHold('policy_excluded');
   if(same(scope,spec.sourceScope)&&source.admissionReceiptSha256===spec.policyProofSha256)primary=true;
   const originalRow=await this.pool.query<{state:string;receipt_json:unknown}>('SELECT state,receipt_json FROM district_pipeline.policy_decisions WHERE proof_sha256=$1 AND source_sha256=$2',[source.admissionReceiptSha256,source.originalSha256]);
   if(originalRow.rows.length!==1||originalRow.rows[0].state!=='allowed'||!same(originalRow.rows[0].receipt_json,original))throw new DistrictExecutionHold('policy_excluded');
   const configured=this.context.currentAdmissionReceipts?.[source.admissionReceiptSha256];
   const currentRow=await this.currentPolicy(this.pool,source.originalSha256,scope,configured),current=await loadPolicyReceipt(this.cas,currentRow.proof_sha256);
   if(!same(current,currentRow.receipt_json))throw new DistrictExecutionHold('policy_excluded');
   const checked=await recheckPolicyReceipt(original,{...this.context.policyOptions,evaluationAt:new Date().toISOString(),currentProof:current});
   currentAdmissionReceipts[source.admissionReceiptSha256]=currentRow.proof_sha256;
   validUntil=Math.min(validUntil,Date.parse(current.expiresAt));
   artifactHashes.add(currentRow.proof_sha256);
   policyPins.push({originalSha256:source.originalSha256,originalReceiptSha256:source.admissionReceiptSha256,original,currentReceiptSha256:currentRow.proof_sha256,current,configured});
   sources.push({sha256:source.originalSha256,url:original.source.url,policyReceiptSha256:source.admissionReceiptSha256});
   snapshots.push({sourceId:source.sourceId,originalSha256:source.originalSha256,scope,snapshotSha256:checked.snapshotSha256,currentReceiptSha256:currentRow.proof_sha256});
   for(const hash of new Set([itemHash,source.originalSha256,source.textSha256,source.parserReceiptSha256,source.admissionReceiptSha256,currentRow.proof_sha256]))await assertManagedSourceReadable(resolve(this.cas.root,'sha256',hash.slice(0,2),hash),{...this.context.policyOptions,sourceUrl:original.source.url});
  }
  if(!primary)throw new DistrictExecutionHold('policy_excluded');
  const evidence=await originalEvidence(item,{...this.context,currentAdmissionReceipts});
  const data=assessmentProviderInput(item,evidence);
  assertAssessmentContextBound(data);
  const finalAuthority=await assertCivicPolicyAuthority(this.context.policyOptions),finalOptout=await readCivicOptOutSnapshot(this.context.policyOptions);
  if(!same(finalAuthority,sourceAuthority)||finalOptout.authorityId!==sourceAuthority.authorityId||finalOptout.authoritySha256!==sourceAuthority.authoritySha256||finalOptout.sha256!==optout.sha256)throw new DistrictExecutionHold('authorization_revoked');
  return {item,evidence,data,sources,sourceAuthority,optOutSnapshotSha256:optout.sha256,artifactHashes:[...artifactHashes],policyPins,policySnapshotSha256:semanticHash({sourceAuthority,optOutSnapshotSha256:optout.sha256,sources:snapshots.sort((a,b)=>a.sourceId.localeCompare(b.sourceId))}),validUntil};
 }
 private async persist(bytes:Buffer,kind:ArtifactKind,sources:SourceReference[],observationId:string,mimeType='application/json'):Promise<CasArtifact>{
  const hash=digest(bytes),storageKey=`sha256/${hash.slice(0,2)}/${hash}`;
  await initializeManagedAcquisitionLane(this.cas.root,{...this.context.policyOptions,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
  const artifact=await withManagedSourceWrite(this.cas.root,sources.map(source=>({kind:'prepared_source' as const,relativePath:storageKey,contentSha256:hash,sourceSha256:source.sha256,url:source.url,observationId,receiptSha256:source.policyReceiptSha256,independentAllowed:false})),()=>this.cas.put(bytes,{kind,mimeType}),this.context.policyOptions);
  return artifact;
 }
 private async registerArtifacts(client:PoolClient,artifacts:CasArtifact[]):Promise<void>{
  for(const artifact of artifacts){
   await client.query(`INSERT INTO district_pipeline.artifacts(sha256,kind,mime_type,byte_length,storage_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(sha256) DO NOTHING`,[artifact.sha256,artifact.kind,artifact.mimeType,artifact.byteLength,artifact.storageKey]);
   const row=await client.query<{byte_length:string;storage_key:string;disposition:string}>('SELECT byte_length,storage_key,disposition FROM district_pipeline.artifacts WHERE sha256=$1',[artifact.sha256]);
   if(Number(row.rows[0]?.byte_length)!==artifact.byteLength||row.rows[0]?.storage_key!==artifact.storageKey||row.rows[0]?.disposition!=='retained')throw new DistrictExecutionHold('policy_excluded');
  }
 }
 private async currentPolicy(reader:Pool|PoolClient,originalSha256:string,scope:AdapterScope,configured:string|undefined):Promise<{proof_sha256:string;receipt_json:unknown}>{
  const rows=await reader.query<{proof_sha256:string;receipt_json:unknown}>(`SELECT p.proof_sha256,p.receipt_json FROM district_pipeline.policy_decisions p JOIN district_pipeline.source_snapshots s ON s.id=p.source_snapshot_id JOIN district_pipeline.artifacts a ON a.sha256=p.proof_sha256 AND a.disposition='retained' WHERE p.source_sha256=$1 AND p.state='allowed' AND p.checked_at<=clock_timestamp() AND p.expires_at>clock_timestamp() AND s.publisher_id=$2 AND s.source_id=$3 AND s.municipality_id=$4 AND s.ags=$5 AND s.tenant IS NOT DISTINCT FROM $6 AND s.observation_window=$7 AND ($8::text IS NULL OR p.proof_sha256=$8) ORDER BY p.checked_at DESC,p.proof_sha256 LIMIT 1`,[originalSha256,scope.publisherId,scope.sourceId,scope.municipalityId,scope.ags,scope.tenant,scope.observationWindow,configured??null]);
  if(rows.rows.length!==1)throw new DistrictExecutionHold('policy_expired');
  return rows.rows[0];
 }
 /** No managed inventory/CAS reads here: authenticate bytes before taking locks,
  * then fence their retained hashes and exact policy selection at admission. */
 private async revalidateEvidence(client:PoolClient,checked:CheckedEvidence,extraHashes:string[]=[]):Promise<void>{
  const hashes=[...new Set([...checked.artifactHashes,...extraHashes])];
  const artifacts=await client.query<{sha256:string;disposition:string}>('SELECT sha256,disposition FROM district_pipeline.artifacts WHERE sha256=ANY($1::text[])',[hashes]);
  if(artifacts.rows.length!==hashes.length||artifacts.rows.some(row=>row.disposition!=='retained'))throw new DistrictExecutionHold('policy_excluded');
  for(const pin of checked.policyPins){
   if(this.context.currentAdmissionReceipts?.[pin.originalReceiptSha256]!==pin.configured)throw new DistrictExecutionHold('policy_excluded');
   const original=await client.query<{state:string;receipt_json:unknown}>('SELECT state,receipt_json FROM district_pipeline.policy_decisions WHERE proof_sha256=$1 AND source_sha256=$2',[pin.originalReceiptSha256,pin.originalSha256]);
   if(original.rows.length!==1||original.rows[0].state!=='allowed'||!same(original.rows[0].receipt_json,pin.original))throw new DistrictExecutionHold('policy_excluded');
   const current=await this.currentPolicy(client,pin.originalSha256,pin.original.scope,pin.configured);
   if(current.proof_sha256!==pin.currentReceiptSha256||!same(current.receipt_json,pin.current))throw new DistrictExecutionHold('policy_excluded');
  }
  const authority=await assertCivicPolicyAuthority(this.context.policyOptions),optout=await readCivicOptOutSnapshot(this.context.policyOptions);
  if(!same(authority,checked.sourceAuthority)||optout.authorityId!==authority.authorityId||optout.authoritySha256!==authority.authoritySha256)throw new DistrictExecutionHold('authorization_revoked');
  if(optout.sha256!==checked.optOutSnapshotSha256)throw new DistrictExecutionHold('policy_excluded');
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
 /** Initial authority check is short; all authenticated evidence work is unlocked.
  * The caller MUST use current() after reacquiring authority -> bridge locks. */
 private async readCurrent(row:LeaseRow):Promise<EvidenceCheck>{
  try{
   const snapshot=await this.transaction<{spec:DistrictJobSpec}|{reason:ReasonCode}>(async client=>{
    const job=await this.job(client,row.job_id,row.run_id),reason=disposition(job,row.run_id,row.fencing_token);
    if(reason)return {reason};
    const latest=(await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
    if(!latest||latest.run_id!==row.run_id||latest.fencing_token!==row.fencing_token||!['ready','active','submitted'].includes(latest.state))return {reason:'lease_lost' as const};
    if(latest.deadline_at<=job.now||(latest.state==='active'&&latest.expires_at<=job.now))return {reason:'lease_expired' as const};
    return {spec:job.spec};
   });
   if('reason' in snapshot)return {reason:snapshot.reason};
   return {checked:await this.checkedEvidence(row.item_sha256,snapshot.spec)};
  }catch(error){if(error instanceof CivicPolicyStateError)throw error;return {reason:error instanceof DistrictExecutionHold?error.reasonCode:'policy_excluded'};}
 }
 private async current(client:PoolClient,row:LeaseRow,evidence:EvidenceCheck):Promise<{job:JobAuthorityRow;checked:CheckedEvidence}|{reason:ReasonCode}>{
  try{
   const job=await this.job(client,row.job_id,row.run_id),reason=disposition(job,row.run_id,row.fencing_token);
   if(reason)return {reason};
   if(row.deadline_at<=job.now||(row.state==='active'&&row.expires_at<=job.now))return {reason:'lease_expired'};
   if('reason' in evidence)return evidence;
   const checked=evidence.checked;
   if(checked.sourceAuthority.authorityId!==row.authority_id||checked.sourceAuthority.authoritySha256!==row.authority_sha256)return {reason:'authorization_revoked'};
   if(checked.policySnapshotSha256!==row.policy_snapshot_sha256||assessmentDigest(checked.data)!==row.request_sha256)return {reason:'policy_excluded'};
   await this.revalidateEvidence(client,checked,[row.request_artifact_sha256]);
   const latest=await this.job(client,row.job_id,row.run_id),latestReason=disposition(latest,row.run_id,row.fencing_token);
   if(latestReason)return {reason:latestReason};
   if(row.deadline_at<=latest.now||(row.state==='active'&&row.expires_at<=latest.now))return {reason:'lease_expired'};
   return {job:latest,checked};
  }catch(error){if(error instanceof CivicPolicyStateError)throw error;return {reason:error instanceof DistrictExecutionHold?error.reasonCode:'policy_excluded'};}
 }
 private async preparationAuthority(client:PoolClient,job:ClaimedJob):Promise<LeaseRow[]>{
  const current=await this.job(client,job.id,job.runId),reason=disposition(current,job.runId,job.fencingToken);
  if(reason)throw new DistrictExecutionHold(reason);
  const resolvedLeases=await assertBSubscriptionResume(client,current.authorization_id,job.id);
  const intent=await client.query<{lease_id:string}>('SELECT lease_id FROM district_pipeline.assessment_bridge_submission_intents WHERE job_id=$1',[job.id]);
  if(intent.rows.some(row=>!resolvedLeases.includes(row.lease_id)))throw new DistrictExecutionHold('execution_exception');
  const existing=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE job_id=$1 FOR UPDATE',[job.id]);
  if(existing.rows.some(row=>row.fencing_token===job.fencingToken||row.claimed_at!==null&&!resolvedLeases.includes(row.id)))throw new DistrictExecutionHold('execution_exception');
  return existing.rows;
 }
 async prepare(job:ClaimedJob,signal:AbortSignal):Promise<string>{
  signal.throwIfAborted();
  const selector=AssessmentBSelectorSchema.parse(job.spec.selector);
  // An isolated fixture may exercise native persistence only with an explicit
  // synthetic runner. It can never reach a provider, and production cannot inject one.
  if(this.fixtureProtocol&&selector.transport!=='mac-bridge'&&!this.fixtureOmpRunner)throw new DistrictExecutionHold('isolation_unavailable');
  if(!this.fixtureProtocol&&(selector.transport!=='vm-omp'||selector.version!==NATIVE_B_BRIDGE_VERSION))throw new DistrictExecutionHold('authorization_revoked');
  if(job.spec.step!==ASSESSMENT_B_STEP||job.spec.lane!=='assessment'||job.spec.semanticContractSha256!==await assessmentBJobContract()||canonicalJobIdentity(job.spec).jobKey!==job.jobKey||selector.transport==='vm-omp'&&selector.runnerOutputContractSha256!==await ompRunnerOutputContractSha256())throw new DistrictExecutionHold('quality_failed');
  await this.transaction(client=>this.preparationAuthority(client,job));
  const checked=await this.checkedEvidence(selector.itemArtifactSha256,job.spec);
  signal.throwIfAborted();
  const request=await this.persist(Buffer.from(canonicalJson(checked.data)),'derived',checked.sources,job.jobKey);
  const clientContractSha256=selector.transport==='mac-bridge'?selector.clientContractSha256:selector.runnerOutputContractSha256;
  return this.transaction(async client=>{
   const existing=await this.preparationAuthority(client,job);
   await this.revalidateEvidence(client,checked);
   await this.registerArtifacts(client,[request]);
   // Only a newly authorized attempt may replace an unexposed lease; retain history.
   for(const prior of existing)if(prior.state==='ready'||prior.state==='active')await this.hold(client,prior,'lease_lost');
   const binding={jobKey:job.jobKey,authorityId:checked.sourceAuthority.authorityId,authoritySha256:checked.sourceAuthority.authoritySha256,policySnapshotSha256:checked.policySnapshotSha256,role:'B' as const,provider:'anthropic-subscription' as const,system:PROMPTS.B,data:checked.data,outputSchema:z.toJSONSchema(assessmentOutputSchema),clientContractSha256};
   const inputSha256=selector.transport==='vm-omp'&&selector.version===NATIVE_B_BRIDGE_VERSION?nativeBInputHash({...binding,requestedModel:NATIVE_B_MODEL}):bridgeInputHash({...binding,requestedModel:'claude-haiku-5-5'});
   const latest=await this.job(client,job.id,job.runId),latestReason=disposition(latest,job.runId,job.fencingToken);
   if(latestReason)throw new DistrictExecutionHold(latestReason);
   const native=selector.transport==='vm-omp'&&selector.version===NATIVE_B_BRIDGE_VERSION;
   const id=randomUUID(),deadline=new Date(Math.min(hardDeadline(latest),checked.validUntil,latest.now.getTime()+(native?NATIVE_B_LIFECYCLE_LIMITS.maxLifecycleMs:BRIDGE_LIMITS.maxLeaseMs)));
   if(deadline<=latest.now)throw new DistrictExecutionHold('lease_expired');
   signal.throwIfAborted();
   await client.query(`INSERT INTO district_pipeline.assessment_bridge_leases(id,job_id,run_id,fencing_token,item_sha256,request_artifact_sha256,request_sha256,input_sha256,authority_id,authority_sha256,policy_snapshot_sha256,client_contract_sha256,role,provider,requested_model,state,deadline_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'B','anthropic-subscription',$13,'ready',$14,$14)`,[id,job.id,job.runId,job.fencingToken,selector.itemArtifactSha256,request.sha256,assessmentDigest(checked.data),inputSha256,binding.authorityId,binding.authoritySha256,checked.policySnapshotSha256,clientContractSha256,selector.requestedModel,deadline]);
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
  if(!this.fixtureProtocol)throw new DistrictExecutionHold('isolation_unavailable');
  const request=BridgeRequestSchema.parse(input);
  const located=await this.pool.query<LeaseRow>(request.operation==='claim'?'SELECT b.* FROM district_pipeline.assessment_bridge_leases b JOIN district_pipeline.jobs j ON j.id=b.job_id WHERE j.job_key=$1 ORDER BY b.created_at DESC,b.id DESC LIMIT 1':'SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1',[request.operation==='claim'?request.jobKey:request.leaseId]);
  if(located.rows.length!==1)throw new DistrictExecutionHold('dependency_uncommitted');
  const identity=located.rows[0];
  await this.transaction(async client=>{
   const authority=await this.job(client,identity.job_id,identity.run_id);
   if(AssessmentBSelectorSchema.parse(authority.spec.selector).transport!=='mac-bridge')throw new DistrictExecutionHold('isolation_unavailable');
   if(request.operation==='claim'&&request.clientContractSha256!==identity.client_contract_sha256)throw new DistrictExecutionHold('isolation_unavailable');
   if(request.operation!=='claim'&&request.inputSha256!==identity.input_sha256)throw new DistrictExecutionHold('quality_failed');
  });
  const evidence:EvidenceCheck=identity.state==='ready'||identity.state==='active'||request.operation==='abandon'?await this.readCurrent(identity):{reason:'lease_lost'};
  const receivedAt=(await this.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
  const staged=request.operation==='submit'&&identity.state==='active'&&'checked' in evidence?await this.stageSubmission(identity,request,evidence.checked,receivedAt):undefined;
  return this.transaction(async client=>{
   // Slow evidence and managed writes above never retain authority row locks.
   const authority=await this.job(client,identity.job_id,identity.run_id),selector=AssessmentBSelectorSchema.parse(authority.spec.selector);
   if(selector.transport!=='mac-bridge')throw new DistrictExecutionHold('isolation_unavailable');
   const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[identity.id]);
   if(found.rows.length!==1)throw new DistrictExecutionHold('lease_lost');
   const row=found.rows[0];
   if(request.operation==='claim'){
    if(request.clientContractSha256!==row.client_contract_sha256)throw new DistrictExecutionHold('isolation_unavailable');
    if(row.state!=='ready')return status(row); // Never retransmit evidence after a recorded intent.
    const current=await this.current(client,row,evidence);if('reason' in current)return this.hold(client,row,current.reason);
    const now=current.job.now,expires=new Date(Math.min(now.getTime()+BRIDGE_LIMITS.leaseMs,row.deadline_at.getTime()));
    const lease=BridgeLeaseSchema.parse({version:ASSESSMENT_BRIDGE_VERSION,leaseId:row.id,jobKey:request.jobKey,inputSha256:row.input_sha256,authorityId:row.authority_id,authoritySha256:row.authority_sha256,policySnapshotSha256:row.policy_snapshot_sha256,expiresAt:expires.toISOString(),role:'B',provider:'anthropic-subscription',requestedModel:'claude-haiku-5-5',system:PROMPTS.B,data:current.checked.data,outputSchema:z.toJSONSchema(assessmentOutputSchema),clientContractSha256:row.client_contract_sha256});
    const intentSha256=semanticHash({version:ASSESSMENT_BRIDGE_VERSION,leaseId:row.id,jobKey:request.jobKey,runId:row.run_id,fencingToken:row.fencing_token,inputSha256:row.input_sha256,clientId:request.clientId,provider:lease.provider,model:lease.requestedModel});
    // COMMIT occurs before dispatch returns any evidence to the private SSH pipe.
    await client.query('INSERT INTO district_pipeline.assessment_bridge_submission_intents(lease_id,job_id,run_id,fencing_token,input_sha256,intent_sha256,client_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.id,row.job_id,row.run_id,row.fencing_token,row.input_sha256,intentSha256,request.clientId]);
    await client.query(`UPDATE district_pipeline.assessment_bridge_leases SET state='active',client_id=$2,claimed_at=$3,expires_at=$4,last_checked_at=$3 WHERE id=$1`,[row.id,request.clientId,now,expires]);row.state='active';await this.event(client,row,'active','completed');
    return lease;
   }
   if(request.inputSha256!==row.input_sha256)throw new DistrictExecutionHold('quality_failed');
   if(request.operation==='abandon'){
    await this.acknowledgePurge(client,row,request.purgeAck,receivedAt);
    const current=await this.current(client,row,evidence);
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
   const current=await this.current(client,row,evidence);if('reason' in current)return this.hold(client,row,current.reason);
   if(request.operation==='check'){
    const expiry=new Date(Math.min(Date.now()+BRIDGE_LIMITS.leaseMs,row.deadline_at.getTime(),hardDeadline(current.job),current.checked.validUntil));
    await client.query('UPDATE district_pipeline.assessment_bridge_leases SET expires_at=$2,last_checked_at=clock_timestamp() WHERE id=$1',[row.id,expiry]);row.expires_at=expiry;return status(row);
   }
   if(!staged)return this.hold(client,row,'quality_failed');
   return this.submit(client,row,request,current.checked,staged);
  });
 }
 private async stageSubmission(row:LeaseRow,request:Extract<BridgeRequest,{operation:'submit'}>,checked:CheckedEvidence,receivedAt:Date):Promise<StagedSubmission>{
  const raw=BridgeAnswerSchema.parse(request.answer);
  const response=await this.persist(Buffer.from(raw.stdout),'provider_response',checked.sources,row.id,'application/x-ndjson');
  let parsed:RecordedBridgeAssessment|undefined;
  try{parsed=assessmentBridgeReceipt(checked.item,checked.evidence,checked.data,raw,{claimedAt:row.claimed_at!.toISOString(),deadlineAt:row.expires_at.toISOString(),receivedAt:receivedAt.toISOString()});}catch{/* Rejected execution is preserved, never converted into a fake assessment. */}
  const answer=await this.persist(Buffer.from(canonicalJson({version:'assessment-bridge-answer-v1',inputSha256:row.input_sha256,providerResponseArtifactSha256:response.sha256,evidence:raw.evidence,startedAt:raw.startedAt,finishedAt:raw.finishedAt,answer:parsed?.answer??null})),'derived',checked.sources,row.id);
  const receipt=parsed?await this.persist(Buffer.from(canonicalJson(parsed.receipt)),'receipt',checked.sources,row.id):null;
  const reconciliation=await this.persist(Buffer.from(canonicalJson({version:'assessment-bridge-reconciliation-input-v1',itemArtifactSha256:row.item_sha256,requestArtifactSha256:row.request_artifact_sha256,requestSha256:row.request_sha256,inputSha256:row.input_sha256,receiptArtifactSha256:receipt?.sha256??null,B:parsed?.receipt??null,deterministicIssues:parsed?.receipt.deterministicIssues??null,disposition:parsed?'assessment_recorded':'held_execution',providerResponseArtifactSha256:response.sha256})),'derived',checked.sources,row.id);
  return {response,answer,receipt,reconciliation,parsed};
 }
 private async submit(client:PoolClient,row:LeaseRow,request:Extract<BridgeRequest,{operation:'submit'}>,checked:CheckedEvidence,staged:StagedSubmission):Promise<BridgeStatus>{
  if(Date.parse(request.purgeAck.completedAt)<Date.parse(request.answer.finishedAt))return this.hold(client,row,'quality_failed');
  const {response,answer,receipt,reconciliation,parsed}=staged;
  const final=await this.current(client,row,{checked});
  if('reason' in final)return this.hold(client,row,final.reason);
  await this.registerArtifacts(client,[response,answer,...receipt?[receipt]:[],reconciliation]);
  const accepted=parsed!==undefined,reason:ReasonCode=accepted?'completed':'quality_failed';
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
    const snapshot=(await this.pool.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE job_id=$1 AND run_id=$2 AND fencing_token=$3',[job.id,job.runId,job.fencingToken])).rows[0];
    if(!snapshot)throw new DistrictExecutionHold('lease_lost');
    const evidence=await this.readCurrent(snapshot);
    let completion:{saved:SubmissionRow;receipt:AssessmentReceipt}|undefined;
    if(snapshot.state==='submitted'&&'checked' in evidence){
     const saved=(await this.pool.query<SubmissionRow>('SELECT * FROM district_pipeline.assessment_bridge_submissions WHERE lease_id=$1',[snapshot.id])).rows[0];
     if(!saved||saved.state!=='accepted'||!saved.receipt_artifact_sha256||!snapshot.purge_ack_sha256)throw new DistrictExecutionHold('quality_failed');
     const receipt=validateReceipt(JSON.parse((await this.cas.read(saved.receipt_artifact_sha256)).toString('utf8')),evidence.checked.item,'B');
     completion={saved,receipt};
    }
    const result=await this.transaction(async client=>{
     await this.job(client,job.id,job.runId);
     const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE job_id=$1 AND run_id=$2 AND fencing_token=$3 FOR UPDATE',[job.id,job.runId,job.fencingToken]),row=found.rows[0];
     if(!row)throw new DistrictExecutionHold('lease_lost');
     if(row.run_id!==job.runId||row.fencing_token!==job.fencingToken)throw new DistrictExecutionHold('lease_lost');
     const checked=await this.current(client,row,evidence);
     if('reason' in checked&&row.state!=='submitted')await this.hold(client,row,checked.reason);
     if(row.state==='ready'||row.state==='active')return null;
     if(row.state!=='submitted')return {outcome:'held_execution' as const,reasonCode:row.reason_code??'execution_exception'};
     if('reason' in checked)throw new DistrictExecutionHold(checked.reason);
     const submission=await client.query<SubmissionRow>('SELECT * FROM district_pipeline.assessment_bridge_submissions WHERE lease_id=$1',[row.id]),saved=submission.rows[0];
     const selector=AssessmentBSelectorSchema.parse(job.spec.selector);
     if(!saved||saved.state!=='accepted'||!saved.receipt_artifact_sha256||selector.transport==='mac-bridge'&&!row.purge_ack_sha256)throw new DistrictExecutionHold('quality_failed');
     if(!completion)return null; // Submission committed while the unlocked read was in flight.
     const {saved:previous,receipt}=completion;
     // pg returns audit timestamps as Date, not canonical-JSON values. Fence
     // every immutable submission field without serializing driver objects.
     const fields=['lease_id','submission_sha256','provider_response_sha256','answer_artifact_sha256','receipt_artifact_sha256','reconciliation_input_sha256','provider_request_id','provider_response_id','state','reason_code'] as const;
     if(saved.committed_at.getTime()!==previous.committed_at.getTime()||fields.some(field=>saved[field]!==previous[field]))throw new DistrictExecutionHold('quality_failed');
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
 private async settleVmOutputRejection(job:ClaimedJob,leaseId:string,error:OmpAssessmentOutputRejected,signal:AbortSignal):Promise<JobHandlerResult>{
  const rejection=OmpOutputRejectionSchema.parse(error.rejection);
  const initial=(await this.pool.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1',[leaseId])).rows[0];
  if(!initial)throw new DistrictExecutionHold('lease_lost');
  if(rejection.version==='omp-output-rejection-v3'&&rejection.structure.delivery.requestSha256!==initial.request_sha256)throw new DistrictExecutionHold('quality_failed');
  const evidence=await this.readCurrent(initial);if('reason' in evidence)throw new DistrictExecutionHold(evidence.reason);
  const binding={leaseId,jobKey:job.jobKey,runId:job.runId,fencingToken:job.fencingToken,inputSha256:initial.input_sha256,itemSha256:initial.item_sha256,requestSha256:initial.request_sha256};
  const documents=rejectedOmpArtifacts(binding,rejection);
  const response=await this.persist(Buffer.from(canonicalJson(documents.response)),'provider_response',evidence.checked.sources,leaseId);
  signal.throwIfAborted();
  const answer=await this.persist(Buffer.from(canonicalJson(documents.answer)),'derived',evidence.checked.sources,leaseId);
  signal.throwIfAborted();
  const reconciliation=await this.persist(Buffer.from(canonicalJson(documents.reconciliation)),'derived',evidence.checked.sources,leaseId);
  const checked=await this.readCurrent(initial);signal.throwIfAborted();
  return this.transaction(async client=>{
   const authority=await this.job(client,job.id,job.runId),reason=disposition(authority,job.runId,job.fencingToken);if(reason)throw new DistrictExecutionHold(reason);
   const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]),row=found.rows[0];
   if(!row||row.state!=='active'||row.run_id!==job.runId||row.fencing_token!==job.fencingToken||row.client_id!=='vm-omp-docker')throw new DistrictExecutionHold('lease_lost');
   const final=await this.current(client,row,checked);if('reason' in final)throw new DistrictExecutionHold(final.reason);
   const intent=await client.query<{intent_sha256:string}>(`SELECT intent_sha256 FROM district_pipeline.assessment_bridge_submission_intents WHERE lease_id=$1 AND job_id=$2 AND run_id=$3 AND fencing_token=$4 AND input_sha256=$5 AND client_id='vm-omp-docker'`,[leaseId,job.id,job.runId,job.fencingToken,row.input_sha256]);
   const expectedIntent=assessmentBIntentHash({leaseId,jobKey:job.jobKey,runId:job.runId,fencingToken:job.fencingToken,inputSha256:row.input_sha256,clientId:'vm-omp-docker'},row.requested_model);
   if(intent.rows[0]?.intent_sha256!==expectedIntent)throw new DistrictExecutionHold('quality_failed');
   await this.registerArtifacts(client,[response,answer,reconciliation]);
   await client.query(`INSERT INTO district_pipeline.assessment_bridge_submissions(lease_id,submission_sha256,provider_response_sha256,answer_artifact_sha256,receipt_artifact_sha256,reconciliation_input_sha256,provider_request_id,provider_response_id,state,reason_code) VALUES($1,$2,$3,$4,NULL,$5,NULL,NULL,'rejected','quality_failed')`,[leaseId,documents.submissionSha256,response.sha256,answer.sha256,reconciliation.sha256]);
   await this.hold(client,row,'quality_failed');
   return {outcome:'held_quality',reasonCode:'quality_failed',outputs:[response,answer,reconciliation],versions:{...assessmentBridgeFailureVersions(leaseId,error),transport:'vm-omp-docker',ompBridgeLeaseId:leaseId,ompSubmissionSha256:documents.submissionSha256,ompOutputSettlementSha256:answer.sha256}};
  });
 }
 /** Renew only live ownership; never revive expiry, retry an intent or extend
  * the immutable lifecycle/authorization/policy deadline. No managed CAS I/O. */
 private renewNative(job:ClaimedJob,lease:LeaseRow,checked:CheckedEvidence,ownerSignal:AbortSignal){
  const stopped=new AbortController(),failed=new AbortController(),wakeSignal=AbortSignal.any([stopped.signal,ownerSignal]);
  const running=(async()=>{
   while(!stopped.signal.aborted){
    await delay(this.nativeLifecycle.heartbeatMs,undefined,{signal:wakeSignal});
    await this.transaction(async client=>{
     ownerSignal.throwIfAborted();stopped.signal.throwIfAborted();
     const authority=await this.job(client,job.id,job.runId),reason=disposition(authority,job.runId,job.fencingToken);
     if(reason)throw new DistrictExecutionHold(reason);
     const row=(await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[lease.id])).rows[0];
     if(!row||row.state!=='active'||row.run_id!==job.runId||row.fencing_token!==job.fencingToken||row.client_id!=='vm-omp-docker'||row.requested_model!==NATIVE_B_MODEL)throw new DistrictExecutionHold('lease_lost');
     const current=await this.current(client,row,{checked});if('reason' in current)throw new DistrictExecutionHold(current.reason);
     const expires=new Date(Math.min(current.job.now.getTime()+this.nativeLifecycle.leaseMs,row.deadline_at.getTime(),hardDeadline(current.job),checked.validUntil));
     if(expires<=current.job.now)throw new DistrictExecutionHold('lease_expired');
     await client.query('UPDATE district_pipeline.assessment_bridge_leases SET expires_at=$2,last_checked_at=clock_timestamp() WHERE id=$1',[row.id,expires]);
    });
   }
  })().catch(error=>{if(!stopped.signal.aborted)failed.abort(error instanceof DistrictExecutionHold?error:new DistrictExecutionHold('execution_exception',{cause:error}));});
  return {signal:failed.signal,stop:async()=>{stopped.abort();await running;}};
 }
 async waitForVmOmpAssessment(job:ClaimedJob,signal:AbortSignal):Promise<JobHandlerResult>{
  let leaseId:string|undefined;
  const ownerSignal=signal;let renewal:ReturnType<DistrictAssessmentBroker['renewNative']>|undefined;
  try{
   const selector=AssessmentBSelectorSchema.parse(job.spec.selector);
   if(selector.transport!=='vm-omp'||selector.version!==NATIVE_B_BRIDGE_VERSION||selector.runnerOutputContractSha256!==await ompRunnerOutputContractSha256())throw new DistrictExecutionHold('quality_failed');
   leaseId=await this.prepare(job,signal);
   const initial=(await this.pool.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1',[leaseId])).rows[0];
   if(!initial)throw new DistrictExecutionHold('lease_lost');
   const initialEvidence=await this.readCurrent(initial);
   const prepared=await this.transaction(async client=>{
    const authority=await this.job(client,job.id,job.runId),reason=disposition(authority,job.runId,job.fencingToken);
    if(reason)throw new DistrictExecutionHold(reason);
    const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]);
    const row=found.rows[0];if(!row||row.state!=='ready'||row.fencing_token!==job.fencingToken)throw new DistrictExecutionHold('lease_lost');
    const current=await this.current(client,row,initialEvidence);if('reason' in current)throw new DistrictExecutionHold(current.reason);
    const clock=await client.query<{now:Date}>('SELECT clock_timestamp() AS now'),claimedAt=clock.rows[0]!.now;
    if(row.deadline_at<=claimedAt||current.checked.validUntil<=claimedAt.getTime())throw new DistrictExecutionHold('lease_expired');
    const expiresAt=new Date(Math.min(claimedAt.getTime()+this.nativeLifecycle.leaseMs,row.deadline_at.getTime(),hardDeadline(current.job),current.checked.validUntil));
    if(expiresAt<=claimedAt)throw new DistrictExecutionHold('lease_expired');
    const intentSha256=assessmentBIntentHash({leaseId:row.id,jobKey:job.jobKey,runId:job.runId,fencingToken:job.fencingToken,inputSha256:row.input_sha256,clientId:'vm-omp-docker'},row.requested_model);
    await client.query('INSERT INTO district_pipeline.assessment_bridge_submission_intents(lease_id,job_id,run_id,fencing_token,input_sha256,intent_sha256,client_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.id,job.id,job.runId,job.fencingToken,row.input_sha256,intentSha256,'vm-omp-docker']);
    await client.query(`UPDATE district_pipeline.assessment_bridge_leases SET state='active',client_id='vm-omp-docker',claimed_at=$2,expires_at=$3,last_checked_at=$2 WHERE id=$1`,[row.id,claimedAt,expiresAt]);
    row.state='active';row.client_id='vm-omp-docker';row.claimed_at=claimedAt;row.expires_at=expiresAt;
    await this.event(client,row,'active','completed');
    return {row,checked:current.checked,intentSha256,claimedAt};
   });
   renewal=this.renewNative(job,prepared.row,prepared.checked,ownerSignal);
   signal=AbortSignal.any([ownerSignal,renewal.signal]);signal.throwIfAborted();
   let run:OmpRunnerResult;
   try{run=await (this.fixtureOmpRunner??runVmOmpAssessment)(prepared.checked.data,{
    ...this.context.policyOptions,root:this.cas.root,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,
    authorityId:prepared.checked.sourceAuthority.authorityId,authoritySha256:prepared.checked.sourceAuthority.authoritySha256,
    bindings:prepared.checked.sources.map(source=>({kind:'prepared_source',url:source.url,sourceSha256:source.sha256,observationId:prepared.row.id,receiptSha256:source.policyReceiptSha256})),
   },signal,{beforeHandoff:async()=>{
    const evidence=await this.readCurrent(prepared.row);
    await this.transaction(async client=>{
     const authority=await this.job(client,job.id,job.runId),authorityReason=disposition(authority,job.runId,job.fencingToken);
     if(authorityReason)throw new DistrictExecutionHold(authorityReason);
     const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]),row=found.rows[0];
     if(!row||row.state!=='active'||row.fencing_token!==job.fencingToken)throw new DistrictExecutionHold('lease_lost');
     const current=await this.current(client,row,evidence);if('reason' in current)throw new DistrictExecutionHold(current.reason);
    });
   }});}catch(error){
    if(error instanceof OmpAssessmentOutputRejected)return await this.settleVmOutputRejection(job,prepared.row.id,error,signal);
    const reason=assessmentBridgeHoldReason(error);
    await this.transaction(async client=>{
     const authority=await this.job(client,job.id,job.runId);
     const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]);
     if(found.rows[0]){
      if(error instanceof OmpRunnerHold&&error.subscriptionLimit&&error.failureProof)await recordBSubscriptionHold(client,authority.authorization_id,job.id,found.rows[0].id,error.subscriptionLimit,error.noOutput,error.failureProof);
      await this.hold(client,found.rows[0],reason);
     }
    });
    if(reason==='execution_exception')throw new DistrictExecutionHold(reason,{cause:error});
    return {outcome:'held_execution',reasonCode:reason,versions:assessmentBridgeFailureVersions(prepared.row.id,error)};
   }
   signal.throwIfAborted();
   const row=(await this.pool.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1',[leaseId])).rows[0];
   if(!row||row.state!=='active'||row.fencing_token!==job.fencingToken)throw new DistrictExecutionHold('lease_lost');
   const checked=await this.readCurrent(row);
   if('reason' in checked)throw new DistrictExecutionHold(checked.reason);
   const receivedAt=(await this.pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   assertNativeBResponseIdentity(run.answer);
   const receipt=createAssessmentReceipt(checked.checked.item,'B',run.answer,{startedAt:run.startedAt,finishedAt:run.finishedAt},checked.checked.evidence);
   if(receipt.requestSha256!==row.request_sha256||receipt.schemaSha256!==run.outputSchemaSha256||receipt.dependencies.length||receipt.provider!=='anthropic-subscription'||Date.parse(run.startedAt)<prepared.claimedAt.getTime()||Date.parse(run.finishedAt)>Math.min(row.expires_at.getTime(),receivedAt.getTime()))throw new DistrictExecutionHold('quality_failed');
   const structure=OmpOutputStructureSchema.parse(run.outputStructure);
   if(structure.delivery.requestSha256!==row.request_sha256||structure.delivery.systemPromptSha256!==run.systemPromptSha256)throw new DistrictExecutionHold('quality_failed');
   const cleanup=OmpNativeCleanupSchema.parse(run.cleanup);
   if(cleanup.requestSha256!==row.request_sha256||cleanup.responseSha256!==run.answer.responseSha256||cleanup.runnerContractSha256!==run.runnerContractSha256||cleanup.imageId!==run.imageId||Date.parse(cleanup.completedAt)<Date.parse(run.finishedAt)||Date.parse(cleanup.completedAt)>receivedAt.getTime())throw new DistrictExecutionHold('execution_exception');
   // Native cleanup is a distinct immutable acknowledgement, never a fabricated
   // Mac proof claiming file writes were denied. The database purge gate stays intact.
   const purgeAck=await this.persist(Buffer.from(canonicalJson({version:'assessment-vm-omp-purge-ack-v1',leaseId:row.id,inputSha256:row.input_sha256,cleanup})),'receipt',checked.checked.sources,row.id);
   signal.throwIfAborted();
   const normalizationVersions:Record<string,string>={...ompOutputStructureVersions(structure),ompContainerExitCode:'0',ompControlMode:run.controlMode,ompPurgeAckSha256:purgeAck.sha256,...run.outputNormalization?{ompOutputNormalization:run.outputNormalization}:{}};
   const transport={selector:NATIVE_B_SELECTOR,bootstrapSelector:'anthropic/claude-haiku-5-5',effectiveModel:NATIVE_B_MODEL,transport:'vm-omp-docker',transportMayInternallyRetry:true,internalRetryDisclosure:'Provider transient retries may occur up to ten times with one authentication retry; usage covers only the final attempt.',usageScope:'final_attempt_only',networkDisclosure:'Default bridge egress permits inference and may permit shared model-catalog refreshes; no egress-only inference restriction is enforced.',promptDisclosure:'The source-free control prompt includes the exact frozen output schema; stock omp may append generated context, footer, date, or cwd material despite this pinned file.',imageId:run.imageId,settingsSha256:run.settingsSha256,systemPromptSha256:run.systemPromptSha256,outputSchemaSha256:run.outputSchemaSha256,accountLabelSha256:run.accountLabelSha256,runnerContractSha256:run.runnerContractSha256,outputStructure:structure,...normalizationVersions};
   const response=await this.persist(Buffer.from(run.stdout),'provider_response',checked.checked.sources,row.id,'application/x-ndjson');
   signal.throwIfAborted();
   const answer=await this.persist(Buffer.from(canonicalJson({version:'assessment-vm-omp-answer-v2',inputSha256:row.input_sha256,responseArtifactSha256:response.sha256,modelAnswer:run.answer,transport,startedAt:run.startedAt,finishedAt:run.finishedAt})),'derived',checked.checked.sources,row.id);
   signal.throwIfAborted();
   const savedReceipt=await this.persist(Buffer.from(canonicalJson(receipt)),'receipt',checked.checked.sources,row.id);
   signal.throwIfAborted();
   const reconciliation=await this.persist(Buffer.from(canonicalJson({version:'assessment-vm-omp-reconciliation-v2',itemArtifactSha256:row.item_sha256,requestArtifactSha256:row.request_artifact_sha256,requestSha256:row.request_sha256,inputSha256:row.input_sha256,receiptArtifactSha256:savedReceipt.sha256,B:receipt,deterministicIssues:receipt.deterministicIssues,disposition:'assessment_recorded',providerResponseArtifactSha256:response.sha256,transport})),'derived',checked.checked.sources,row.id);
   signal.throwIfAborted();
   const result=await this.transaction(async client=>{
    await this.job(client,job.id,job.runId);
    const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]),row=found.rows[0];
    if(!row||row.state!=='active'||row.fencing_token!==job.fencingToken)throw new DistrictExecutionHold('lease_lost');
    const final=await this.current(client,row,checked);
    if('reason' in final){await this.hold(client,row,final.reason);return {outcome:'held_execution' as const,reasonCode:final.reason};}
    await this.registerArtifacts(client,[response,answer,savedReceipt,reconciliation,purgeAck]);
    await client.query(`INSERT INTO district_pipeline.assessment_bridge_submissions(lease_id,submission_sha256,provider_response_sha256,answer_artifact_sha256,receipt_artifact_sha256,reconciliation_input_sha256,provider_request_id,provider_response_id,state,reason_code) VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,'accepted','completed')`,[row.id,semanticHash({leaseId:row.id,inputSha256:row.input_sha256,responseSha256:run.answer.responseSha256}),response.sha256,answer.sha256,savedReceipt.sha256,reconciliation.sha256]);
    await client.query(`UPDATE district_pipeline.assessment_bridge_leases SET state='submitted',reason_code='completed',receipt_sha256=$2,purge_ack_sha256=$3 WHERE id=$1`,[row.id,savedReceipt.sha256,purgeAck.sha256]);
    row.state='submitted';row.receipt_sha256=savedReceipt.sha256;row.purge_ack_sha256=purgeAck.sha256;await this.event(client,row,'submitted','completed');
    const hashes=[row.request_artifact_sha256,response.sha256,answer.sha256,savedReceipt.sha256,reconciliation.sha256,purgeAck.sha256];
    const artifacts=await client.query<{sha256:string;kind:ArtifactKind;mime_type:string;byte_length:string;storage_key:string;disposition:string}>('SELECT * FROM district_pipeline.artifacts WHERE sha256=ANY($1::text[])',[hashes]);
    if(artifacts.rows.length!==new Set(hashes).size||artifacts.rows.some(item=>item.disposition!=='retained'))throw new DistrictExecutionHold('policy_excluded');
    const tokens=run.answer.usage.topLevel;
    return {outcome:receipt.deterministicIssues.length||receipt.output.outcome==='unresolved'?'held_quality' as const:'succeeded' as const,reasonCode:receipt.deterministicIssues.length||receipt.output.outcome==='unresolved'?'quality_failed' as const:'completed' as const,outputs:artifacts.rows.map(item=>({sha256:item.sha256,byteLength:Number(item.byte_length),kind:item.kind,mimeType:item.mime_type,storageKey:item.storage_key})),versions:{assessment:NATIVE_B_BRIDGE_VERSION,role:'B',transport:'vm-omp-docker',runnerContractSha256:run.runnerContractSha256,imageId:run.imageId,settingsSha256:run.settingsSha256,systemPromptSha256:run.systemPromptSha256,outputSchemaSha256:run.outputSchemaSha256,accountLabelSha256:run.accountLabelSha256,transportMayInternallyRetry:'true',...normalizationVersions},provider:{provider:receipt.provider,endpoint:'omp-cli-vm-docker',requestedModel:receipt.requestedModel,returnedModel:receipt.returnedModel,requestId:null,responseId:null,requestSha256:receipt.requestSha256,responseSha256:receipt.responseSha256,batchId:null,customId:job.jobKey,submissionIntentSha256:prepared.intentSha256,tokens:{standardInput:tokens?.inputTokens??null,cacheWriteInput:tokens?.cacheCreationTokens??null,cacheReadInput:tokens?.cacheReadTokens??null,output:tokens?.outputTokens??null},actualBilledUsd:null,estimatedApiUsd:receipt.estimatedApiUsd,currency:'USD' as const,rateCardDate:null,rateCardSha256:null,reservedMicroUsd:0,subscriptionUsage:{availability:'unavailable' as const,units:null}}};
   });
   return result;
  }catch(error){
   const reason=assessmentBridgeHoldReason(error);
   if(leaseId)try{await this.transaction(async client=>{await this.job(client,job.id,job.runId);const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]);if(found.rows[0])await this.hold(client,found.rows[0],reason);});}catch{}
   if(error instanceof DistrictExecutionHold)throw error;
   throw new DistrictExecutionHold(reason,{cause:error});
  }finally{
   await renewal?.stop();
   if(ownerSignal.aborted&&leaseId)await this.transaction(async client=>{await this.job(client,job.id,job.runId);const found=await client.query<LeaseRow>('SELECT * FROM district_pipeline.assessment_bridge_leases WHERE id=$1 FOR UPDATE',[leaseId]);if(found.rows[0])await this.hold(client,found.rows[0],'owner_stopped');});
  }
 }
}

/** Fixed registry entry. Native B is Sonnet only; no model fallback. */
export function assessmentBJobHandler(broker:DistrictAssessmentBroker):JobHandler{return async({job,signal,cas})=>{
 if(cas.root!==broker.cas.root)throw new DistrictExecutionHold('cas_unavailable');
 const selector=AssessmentBSelectorSchema.parse(job.spec.selector);
 try{return await(selector.transport==='vm-omp'?broker.waitForVmOmpAssessment(job,signal):broker.waitForAssessment(job,signal));}
 catch(error){if(!(error instanceof AssessmentContextHold))throw error;return {outcome:'held_quality',reasonCode:error.reasonCode,counts:{heldFacts:1}};}
};}
export async function enqueueAssessmentB(broker:DistrictAssessmentBroker,input:({itemArtifactSha256:string;sourceScope:AdapterScope;policyProofSha256:string;transport:'mac-bridge';clientContractSha256:string}|{itemArtifactSha256:string;sourceScope:AdapterScope;policyProofSha256:string;transport:'vm-omp'})):Promise<string>{
 if(input.transport==='mac-bridge'&&!broker.fixtureProtocol)throw new DistrictExecutionHold('isolation_unavailable');
 const base={role:'B',provider:'anthropic-subscription',itemArtifactSha256:input.itemArtifactSha256};
 const selector=AssessmentBSelectorSchema.parse(input.transport==='mac-bridge'?{...base,version:ASSESSMENT_BRIDGE_VERSION,requestedModel:'claude-haiku-5-5',transport:input.transport,clientContractSha256:input.clientContractSha256}:{...base,version:NATIVE_B_BRIDGE_VERSION,requestedModel:NATIVE_B_MODEL,transport:input.transport,runnerOutputContractSha256:await ompRunnerOutputContractSha256()});
 const item=assessmentItemSchema.parse(JSON.parse((await broker.cas.read(selector.itemArtifactSha256)).toString('utf8')));
 const anchor=item.valueContext?await loadPolicyReceipt(broker.cas,item.valueContext.custodyReceiptSha256):undefined;
 if(item.valueContext&&item.valueContext.custodyReceiptSha256!==input.policyProofSha256)throw new DistrictExecutionHold('policy_excluded');
 return broker.store.enqueue({step:ASSESSMENT_B_STEP,lane:'assessment',semanticContractSha256:await assessmentBJobContract(),inputArtifactHashes:[...new Set([selector.itemArtifactSha256,...assessmentEvidenceArtifactHashes(item),...(anchor?[anchor.source.sha256]:[])])].sort(),sourceScope:ScopeSchema.parse(input.sourceScope),selector,policyProofSha256:HashSchema.parse(input.policyProofSha256)});
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
