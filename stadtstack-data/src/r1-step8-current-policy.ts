import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {dirname,join,resolve} from 'node:path';
import {OMP_NATIVE_STREAM_VERSION} from './district-omp-b-runner.ts';
import {HashSchema,canonicalJson,digest} from './district-adapter-contract.ts';
import {authenticateStructuredExecutionEvidence} from './r1-step8-structured-execution.ts';
import type {StructuredExecutionCustody} from './r1-step8-structured-execution.ts';
import * as civic from './civic-opt-out.ts';
import type {CivicPolicyOptions} from './civic-opt-out.ts';
import {createCanonicalWitnessReadPool} from './r1-step8-provenance.ts';
import {StepReceiptSchema} from './district-step-receipt.ts';
import {createReadOnlyManagedSourceAudit} from './r1-step8-managed-read-view.ts';

export const STEP8_STRUCTURED_SOURCE_SCOPES=[['strausberg','regionalstatistik-genesis'],['hagenow','pegelonline']] as const;
export const STEP8_PRIOR_RELEASE={gitCommit:'57bddbbd8b84b0634229ad9cd45b689bda7271ea',directory:'release' as const,manifestSha256:'85b9236328402364ee1211ffe274933d3eaf0ff52c976a39720920337cc866b8',releaseId:'4ceebf75374df54c51bcf4a212c73770186a1a6db502423be7f108b665096691'};
const pin=z.object({path:z.string().refine(isAbsolute),sha256:HashSchema}).strict();
export const Step8StructuredSelectionSchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-step8-structured-selection-v1'),id:z.string().min(1),
 issuedBy:z.string().min(1),issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
 renewalAuthority:pin,ownerDecision:pin,runIds:z.array(z.uuid()).min(1).max(1000),
 receipts:z.array(z.object({runId:z.uuid(),sha256:HashSchema,step:z.enum(['structured_parse','structured_discover']),municipalityId:z.string().min(1),sourceId:z.string().min(1)}).strict()).min(1).max(1000),
 executionEvidence:pin.optional(),
}).strict();
/** Independently pinned issuance replaces the erroneous five-ID literal. This
 * checks authority and exact receipt selection, not source-policy currency. */
export async function authenticateStep8StructuredSelection(input:{selection:{path:string;sha256:string};runIds:readonly string[];readControl:(pin:{path:string;sha256:string})=>Promise<Uint8Array>;requiredThrough?:number;custody?:StructuredExecutionCustody}){
 const read=async(selected:{path:string;sha256:string})=>{pin.parse(selected);const bytes=Buffer.from(await input.readControl(selected));if(digest(bytes)!==selected.sha256)throw Error('Structured control digest mismatch');return JSON.parse(bytes.toString('utf8'));};
 const selection=Step8StructuredSelectionSchema.parse(await read(input.selection));
 const issued=(value:{issuedAt:string;expiresAt:string},label:string)=>{const issuedAt=Date.parse(z.iso.datetime().parse(value.issuedAt)),expiresAt=Date.parse(z.iso.datetime().parse(value.expiresAt));if(issuedAt>Date.now()||expiresAt<=Date.now()||expiresAt<=issuedAt||input.requiredThrough!==undefined&&expiresAt<=input.requiredThrough)throw Error(label+' unissued, future, expired or shorter than required horizon');};
 issued(selection,'Structured selection');
 if(new Set(selection.runIds).size!==selection.runIds.length||canonicalJson(selection.runIds)!==canonicalJson(input.runIds))throw Error('Structured selection changes exact ordered run IDs');
 if(new Set(selection.receipts.map(row=>row.sha256)).size!==selection.receipts.length||selection.runIds.some(id=>!selection.receipts.some(row=>row.runId===id))||selection.receipts.some(row=>!selection.runIds.includes(row.runId)))throw Error('Structured selection has duplicate, missing or extra receipt/run membership');
 const scopes=[...new Set(selection.receipts.map(row=>canonicalJson([row.municipalityId,row.sourceId])))].sort();
 if(canonicalJson(scopes)!==canonicalJson(STEP8_STRUCTURED_SOURCE_SCOPES.map(scope=>canonicalJson(scope)).sort()))throw Error('Structured selection must cover exactly the approved K1/K2 source scopes');
 const rawAuthority=await read(selection.renewalAuthority);
 const authority=z.object({schemaVersion:z.literal('stadtstack-r1-operator-action-record-v1'),id:z.string(),action:z.literal('fresh-exact-k1-k2-acquisition-and-structured-parse-for-step8'),issuedBy:z.string().min(1),issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),requiredOwnerDecision:z.string(),acquisition:pin,bounds:z.object({maxModelCalls:z.literal(0),paidMicroUsd:z.literal(0)}).passthrough()}).passthrough().parse(rawAuthority);
 const owner=z.object({schemaVersion:z.literal('stadtstack-r1-owner-approval-record-v1'),id:z.string(),issuedAt:z.iso.datetime(),approver:z.literal('Max (owner)'),ownerStatementsVerbatim:z.array(z.string().min(1)).min(1),approved:z.literal(true),request:z.object({action:z.string(),actionDraftSha256:HashSchema,acquisition:pin,bounds:z.record(z.string(),z.unknown()),expiresAt:z.iso.datetime()}).passthrough()}).passthrough().parse(await read(selection.ownerDecision));
 issued(authority,'Structured renewal authority');issued({issuedAt:owner.issuedAt,expiresAt:owner.request.expiresAt},'Structured owner decision');
 if(authority.requiredOwnerDecision!==owner.id||owner.request.action!==authority.action||owner.request.actionDraftSha256!==digest(JSON.stringify({...rawAuthority,issuedAt:''},null,2)+'\n')||canonicalJson(owner.request.acquisition)!==canonicalJson(authority.acquisition)||canonicalJson(owner.request.bounds)!==canonicalJson(authority.bounds)||authority.expiresAt!==owner.request.expiresAt||Date.parse(selection.expiresAt)>Date.parse(authority.expiresAt)||Date.parse(authority.issuedAt)<Date.parse(owner.issuedAt)||Date.parse(selection.issuedAt)<Date.parse(authority.issuedAt))throw Error('Structured selection changes approved renewal action/bounds or issuance order');
 if(selection.executionEvidence){
  if(!input.custody)throw Error('Structured execution evidence requires canonical read-only DB/CAS custody');
  await authenticateStructuredExecutionEvidence({evidence:selection.executionEvidence,baseAuthority:selection.renewalAuthority,selectionIssuedAt:selection.issuedAt,receipts:selection.receipts,readControl:input.readControl,custody:input.custody});
 }
 return selection;
}

/** Private issuance/assembly callers use the same canonical read-only witness
 * and managed-CAS epoch fence as preflight; there is no controls-only bypass. */
export async function authenticateStep8StructuredSelectionReadOnly(input:Omit<Parameters<typeof authenticateStep8StructuredSelection>[0],'custody'>,access:{connectionString:string;casRoot:string;policy:CivicPolicyOptions}){
 const fence=await createReadOnlyManagedSourceAudit(access.policy),pool=createCanonicalWitnessReadPool({connectionString:access.connectionString});
 try{
  const client=await pool.connect();
  try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const selection=await authenticateStep8StructuredSelection({...input,custody:{query:(sql,values)=>client.query(sql,values),readCas:hash=>fence.read(join(access.casRoot,'sha256',hash.slice(0,2),hash),hash)}});
   await fence.finish();await client.query('COMMIT');return selection;
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
 }finally{await pool.end();}
}
/** The catalogue's independently pinned confirmed review, not publication HEAD
 * or a window-specific code literal, supplies the admitting worker identities. */
export const Step8CurrentGenerationSchema=z.object({
 processingCommit:z.string().regex(/^[a-f0-9]{40}$/),catalogue:pin,processingReview:pin,
 assessmentQueueContractSha256:HashSchema,projectionVersion:z.literal('assessment-source-record-v2'),
 B:z.object({jobContractSha256:HashSchema,runnerContractSha256:HashSchema,runnerOutputContractSha256:HashSchema,
  nativeStreamVersion:z.literal(OMP_NATIVE_STREAM_VERSION),thinking:z.literal('medium'),receiptVersion:z.literal('assessment-receipt-v2'),
  selector:z.literal('anthropic/claude-sonnet-5-5'),transport:z.literal('vm-omp')}).strict(),
}).strict();
export type Step8CurrentGeneration=z.infer<typeof Step8CurrentGenerationSchema>;

export function assertStep8ProcessingPin(policy:Step8CurrentGeneration,rawCatalogue:unknown,rawReview:unknown){
 const catalogue=z.object({processingCodeRevision:z.string().regex(/^[a-f0-9]{7,40}$/),processingPinReview:z.object({path:z.string(),sha256:HashSchema}).passthrough()}).passthrough().parse(rawCatalogue);
 const review=z.object({activation:z.literal('confirmed'),to:z.object({commit:z.string().regex(/^[a-f0-9]{40}$/)}).passthrough(),contracts:z.object({
  current:z.object({assessmentQueue:HashSchema}).passthrough(),assessmentBJobContract:HashSchema,ompRunnerContract:HashSchema,ompRunnerOutputContract:HashSchema,
 }).passthrough()}).passthrough().parse(rawReview);
 if(!policy.processingCommit.startsWith(catalogue.processingCodeRevision)||review.to.commit!==policy.processingCommit
  ||catalogue.processingPinReview.sha256!==policy.processingReview.sha256
  ||resolve(dirname(policy.catalogue.path),catalogue.processingPinReview.path)!==resolve(policy.processingReview.path))throw Error('Inactive processing pin/catalogue');
 if(review.contracts.current.assessmentQueue!==policy.assessmentQueueContractSha256||review.contracts.assessmentBJobContract!==policy.B.jobContractSha256
  ||review.contracts.ompRunnerContract!==policy.B.runnerContractSha256||review.contracts.ompRunnerOutputContract!==policy.B.runnerOutputContractSha256)throw Error('Processing approval contract mismatch');
}

export function assertStep8NativeBStep(policy:Step8CurrentGeneration,spec:{semanticContractSha256:string;selector:unknown},versions:Readonly<Record<string,string>>){
 const selected=z.object({transport:z.literal('vm-omp'),requestedModel:z.literal('claude-sonnet-5-5'),runnerOutputContractSha256:HashSchema}).passthrough().safeParse(spec.selector);
 if(!selected.success||spec.semanticContractSha256!==policy.B.jobContractSha256||selected.data.runnerOutputContractSha256!==policy.B.runnerOutputContractSha256
  ||versions.runnerContractSha256!==policy.B.runnerContractSha256||versions.ompNativeStreamVersion!==policy.B.nativeStreamVersion
  ||versions.ompThinking!==policy.B.thinking||versions.ompOutputNormalization!==undefined)throw Error('Admitting B job is outside approved native Sonnet profile/stream');
}
export const STEP8_PROCESSING_CONTRACT_NAMES=['preparationExtractor','residualPreparation','residualJob','jointExtraction','assessmentQueue','assessmentB','acquisition','policyRefresh','structuredStateGauges','operatorRegistry','parserOutput','parserIsolation','ompOutput','ompRunner'] as const;
const ProcessingContractNameSchema=z.enum(STEP8_PROCESSING_CONTRACT_NAMES);
const ProcessingContractSetSchema=z.object({
 preparationExtractor:HashSchema,residualPreparation:HashSchema,residualJob:HashSchema,jointExtraction:HashSchema,
 assessmentQueue:HashSchema,assessmentB:HashSchema,acquisition:HashSchema,policyRefresh:HashSchema,
 structuredStateGauges:HashSchema,operatorRegistry:HashSchema,parserOutput:HashSchema,parserIsolation:HashSchema,
 ompOutput:HashSchema,ompRunner:HashSchema,
}).strict();
const processingCommit=z.string().regex(/^[a-f0-9]{40}$/);
const R1ProcessingPinPayloadSchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-processing-pin-set-v1'),processingCommit,contracts:ProcessingContractSetSchema,
}).strict();
export const Step8RecordedR1ProcessingPinsSchema=R1ProcessingPinPayloadSchema.extend({pinSetSha256:HashSchema}).strict().superRefine((value,ctx)=>{
 const {pinSetSha256,...payload}=value;
 if(digest(canonicalJson(payload))!==pinSetSha256)ctx.addIssue({code:'custom',message:'Recorded R1 processing pin-set digest mismatch'});
});
export type Step8RecordedR1ProcessingPins=z.infer<typeof Step8RecordedR1ProcessingPinsSchema>;
export function createStep8RecordedR1ProcessingPins(input:{processingCommit:string;contracts:Record<(typeof STEP8_PROCESSING_CONTRACT_NAMES)[number],string>}):Step8RecordedR1ProcessingPins{
 const payload=R1ProcessingPinPayloadSchema.parse({schemaVersion:'stadtstack-r1-processing-pin-set-v1',...input});
 return Step8RecordedR1ProcessingPinsSchema.parse({...payload,pinSetSha256:digest(canonicalJson(payload))});
}
const R2CurrentGenerationPayloadSchema=z.object({
 schemaVersion:z.literal('stadtstack-r2-processing-generation-v1'),processingCommit,fingerprintReportSha256:HashSchema,
 contracts:ProcessingContractSetSchema,
}).strict();
export const Step8R2CurrentGenerationSchema=R2CurrentGenerationPayloadSchema.extend({generationSha256:HashSchema}).strict().superRefine((value,ctx)=>{
 const {generationSha256,...payload}=value;
 if(digest(canonicalJson(payload))!==generationSha256)ctx.addIssue({code:'custom',message:'R2 processing generation digest mismatch'});
});
export type Step8R2CurrentGeneration=z.infer<typeof Step8R2CurrentGenerationSchema>;
export function createStep8R2CurrentGeneration(input:{processingCommit:string;fingerprintReportSha256:string;contracts:Record<(typeof STEP8_PROCESSING_CONTRACT_NAMES)[number],string>}):Step8R2CurrentGeneration{
 const payload=R2CurrentGenerationPayloadSchema.parse({schemaVersion:'stadtstack-r2-processing-generation-v1',...input});
 return Step8R2CurrentGenerationSchema.parse({...payload,generationSha256:digest(canonicalJson(payload))});
}
const R1ReceiptPinAssertionSchema=z.object({
 contractFamily:ProcessingContractNameSchema,semanticContractSha256:HashSchema,jobKey:HashSchema,receipt:StepReceiptSchema,receiptSha256:HashSchema,
}).strict();
/** Check a historically authenticated R1 job against its immutable recorded pins.
 * Receipt/CAS/job-row authentication remains the caller's existing responsibility. */
export function assertStep8R1ReceiptRecordedPin(input:{contractFamily:(typeof STEP8_PROCESSING_CONTRACT_NAMES)[number];semanticContractSha256:string;jobKey:string;receipt:unknown;receiptSha256:string;recordedPins:unknown}){
 const {recordedPins,...assertionInput}=input,pins=Step8RecordedR1ProcessingPinsSchema.parse(recordedPins),assertion=R1ReceiptPinAssertionSchema.parse(assertionInput);
 if(assertion.receipt.jobKey!==assertion.jobKey||assertion.receiptSha256!==digest(canonicalJson(assertion.receipt))
  ||assertion.semanticContractSha256!==pins.contracts[assertion.contractFamily])throw Error('R1 receipt differs from its recorded processing pin');
 return {processingCommit:pins.processingCommit,pinSetSha256:pins.pinSetSha256,receiptSha256:assertion.receiptSha256};
}
const R2JobContractSchema=z.object({
 processingGenerationSha256:HashSchema,contractFamily:ProcessingContractNameSchema,semanticContractSha256:HashSchema,
}).strict();
/** New R2 jobs must carry both the current full-generation identity and the
 * exact semantic contract. A historical receipt cannot supply either pin. */
export function assertStep8R2JobCurrent(currentRaw:unknown,jobRaw:unknown){
 const current=Step8R2CurrentGenerationSchema.parse(currentRaw),job=R2JobContractSchema.parse(jobRaw);
 if(job.processingGenerationSha256!==current.generationSha256||job.semanticContractSha256!==current.contracts[job.contractFamily])throw Error('R2 job is missing or differs from current processing pins');
 return current.generationSha256;
}
export const STEP8_R2_DRAIN_EVIDENCE_MAX_AGE_MS=60_000;
const R2InventoryDrainSchema=z.object({
 schemaVersion:z.literal('civic-inventory-drain-v2'),authoritySha256:HashSchema,inventorySha256:HashSchema,
 observedAt:z.iso.datetime(),noReaders:z.literal(true),noWriters:z.literal(true),
 reference:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
 pendingScratch:z.array(z.object({id:z.uuid(),sha256:HashSchema}).strict()),
}).strict();
const R2CoreDryRunSchema=z.object({status:z.literal('dry_run'),oldManifestSha256:HashSchema}).passthrough();
const R2NonProductionPath=z.string().min(1).refine(value=>isAbsolute(value)&&value!=='/etc'&&!value.startsWith('/etc/'));
const R2CutoverObservationSchema=z.object({
 schemaVersion:z.literal('stadtstack-r2-cutover-observation-v1'),stateDir:R2NonProductionPath,
 authorityId:z.string().min(1).max(200),authoritySha256:HashSchema,observedAt:z.iso.datetime(),
 drainProofPath:R2NonProductionPath,activeLeases:z.array(z.string().min(1).max(256)),
 oldReaderMarkers:z.array(z.string().min(1).max(4096)),
}).strict();
type Step8R2CutoverEvidenceInput={observationBytes:Uint8Array;observationSha256:string;drainProofBytes:Uint8Array;drainSha256:string};
type Step8R2DrainEvidenceInput=Step8R2CutoverEvidenceInput&{now?:number};
/** Authenticate the exact external observation and drain bytes before any live
 * Core probe. The expected hashes are independently supplied by the operator. */
export function assertStep8R2DrainEvidence(input:Step8R2DrainEvidenceInput){
 const observationBytes=Buffer.from(input.observationBytes);
 if(digest(observationBytes)!==input.observationSha256)throw Error('R2 observation digest mismatch');
 let observationRaw:unknown;
 try{observationRaw=JSON.parse(observationBytes.toString('utf8'));}catch{throw Error('R2 observation is not JSON');}
 const observation=R2CutoverObservationSchema.parse(observationRaw),drainBytes=Buffer.from(input.drainProofBytes);
 if(digest(drainBytes)!==input.drainSha256)throw Error('R2 drain-proof digest mismatch');
 let drainRaw:unknown;
 try{drainRaw=JSON.parse(drainBytes.toString('utf8'));}catch{throw Error('R2 drain proof is not JSON');}
 const drain=R2InventoryDrainSchema.parse(drainRaw),now=input.now??Date.now(),observedAt=Date.parse(drain.observedAt);
 if(!Number.isFinite(now)||drain.authoritySha256!==observation.authoritySha256||drain.observedAt!==observation.observedAt
  ||observedAt>now||now-observedAt>STEP8_R2_DRAIN_EVIDENCE_MAX_AGE_MS||observation.activeLeases.length||observation.oldReaderMarkers.length)throw Error('R2 cutover requires fresh locked evidence and no active leases or old readers');
 return {observation,drain};
}
/** The only readiness gate invokes Core's live migration dry-run itself.
 * Core checks the current authority and raw inventory epoch under its exclusive
 * fence; callers cannot substitute a fabricated epoch result. */
export async function assertStep8R2CutoverReady(input:Step8R2CutoverEvidenceInput){
 const evidence=assertStep8R2DrainEvidence({...input,now:Date.now()}),coreV2=civic as unknown as {
  migrateCivicPolicyInventoryV2:(options:CivicPolicyOptions&{drainPath:string;drainSha256:string;dryRun:true})=>Promise<unknown>;
 };
 if(typeof coreV2.migrateCivicPolicyInventoryV2!=='function')throw Error('R2 cutover requires the merged Core v2 migration validator');
 const current=R2CoreDryRunSchema.parse(await coreV2.migrateCivicPolicyInventoryV2({
  stateDir:evidence.observation.stateDir,authorityId:evidence.observation.authorityId,authoritySha256:evidence.observation.authoritySha256,
  drainPath:evidence.observation.drainProofPath,drainSha256:input.drainSha256,dryRun:true,
 }));
 if(current.oldManifestSha256!==evidence.drain.inventorySha256)throw Error('R2 cutover requires fresh locked evidence and no active leases or old readers');
 return {observationSha256:input.observationSha256,authoritySha256:evidence.drain.authoritySha256,inventorySha256:evidence.drain.inventorySha256,drainSha256:input.drainSha256,observedAt:evidence.drain.observedAt,lockedInventorySha256:current.oldManifestSha256};
}
