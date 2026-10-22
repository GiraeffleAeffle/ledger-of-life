import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {HashSchema,ScopeSchema,canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {StepReceiptSchema} from './district-step-receipt.ts';
import type {StepReceipt} from './district-step-receipt.ts';
import {canonicalJobIdentity} from './district-jobs.ts';
import type {DistrictJobSpec} from './district-jobs.ts';
import {AcquisitionSelectorSchema,RepresentationDescriptorSchema} from './district-r1.ts';
import {StructuredWorkerRequestSchema} from './district-structured-parser-worker.ts';
import {authenticatedHttpBinding,HttpSourceBindingSchema} from './district-http-observation.ts';

const Pin=z.object({path:z.string().refine(isAbsolute),sha256:HashSchema}).strict();
const Clock=z.iso.datetime();
const Step=z.object({sha256:HashSchema,receipt:StepReceiptSchema,stageAuthority:Pin}).strict();
const Evidence=z.object({
 schemaVersion:z.literal('r1-step8-structured-execution-evidence-v1'),continuation:Pin,ownerDecision:Pin,baseAuthority:Pin,
 securityRelease:Pin,nodeVersion:z.literal('v24.22.1'),nodePath:z.string().refine(isAbsolute),startedAt:Clock,finishedAt:Clock,
 priorGenesis:z.object({continuation:Pin,sha256:HashSchema,receipt:StepReceiptSchema}).strict(),
 steps:z.array(Step).min(3).max(6),stageAuthorities:z.array(Pin).min(3).max(6),
 wholeOperationHttpCeilingIncludingHistory:z.literal(20),newAcquisitionAttempts:z.literal(1),newParseJobs:z.number().int().min(2).max(5),
}).strict();

export interface StructuredExecutionCustody {
 query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>;
 readCas(hash:string):Promise<Uint8Array>;
}

/** Evidence hashes choose records; only native committed PG custody authenticates
 * their job identities, contracts and clocks. Managed CAS supplies native outputs. */
async function authenticateExecutionCustody(evidence:z.infer<typeof Evidence>,custody:StructuredExecutionCustody){
 z.object({transaction_read_only:z.literal('on')}).parse((await custody.query('SHOW transaction_read_only')).rows[0]);
 const committed=new Map<string,{receipt:StepReceipt;spec:DistrictJobSpec}>();
 const selected=[evidence.priorGenesis,...evidence.steps];
 for(const entry of selected){
  const result=await custody.query(`SELECT r.receipt_sha256,r.receipt,j.spec,j.job_key,j.state,j.attempt AS current_attempt
    FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id
    WHERE r.receipt_sha256=$1 AND r.id=$2::uuid AND r.run_id=$3::uuid AND j.job_key=$4`,
   [entry.sha256,entry.receipt.id,entry.receipt.runId,entry.receipt.jobKey]);
  requireThat(result.rows.length===1,'Structured execution receipt is not a canonical committed DB receipt');
  const row=z.object({receipt_sha256:HashSchema,receipt:StepReceiptSchema,spec:z.unknown(),job_key:HashSchema,state:z.literal('succeeded'),current_attempt:z.number().int().positive()}).parse(result.rows[0]);
  // canonicalJobIdentity performs the existing strict SpecSchema validation.
  const identity=canonicalJobIdentity(row.spec as DistrictJobSpec),receipt=row.receipt;
  requireThat(row.receipt_sha256===entry.sha256&&semanticHash(receipt)===entry.sha256&&same(receipt,entry.receipt)&&row.job_key===receipt.jobKey&&identity.jobKey===receipt.jobKey&&row.current_attempt===receipt.attempt,'Structured execution changes canonical DB custody, job identity or attempt');
  requireThat(identity.spec.step===receipt.step&&identity.spec.sourceScope.sourceId===receipt.sourceId&&identity.spec.sourceScope.municipalityId===receipt.municipalityId,'Canonical execution source/step mismatch');
  if(receipt.step==='acquire_representation')requireThat(receipt.versions.acquisition===identity.spec.semanticContractSha256,'Canonical acquisition semantic contract mismatch');
  committed.set(entry.sha256,{receipt,spec:identity.spec});
 }
 const descriptors=new Map<string,{descriptor:z.infer<typeof RepresentationDescriptorSchema>;receipt:StepReceipt}>();
 for(const entry of selected){
  if(entry.receipt.step!=='acquire_representation')continue;
  const native=committed.get(entry.sha256)!;
  const outputs=await custody.query("SELECT sha256 FROM district_pipeline.artifacts WHERE sha256=ANY($1::text[]) AND kind='derived'",[native.receipt.outputHashes]);
  requireThat(outputs.rows.length===1,'Canonical acquisition requires its unique committed representation descriptor');
  const descriptorHash=z.object({sha256:HashSchema}).parse(outputs.rows[0]).sha256;
  requireThat(native.receipt.outputHashes.includes(descriptorHash),'Acquisition descriptor is not a native output');
  const bytes=Buffer.from(await custody.readCas(descriptorHash));requireThat(digest(bytes)===descriptorHash,'Acquisition descriptor CAS digest mismatch');
  const descriptor=RepresentationDescriptorSchema.parse(JSON.parse(bytes.toString('utf8'))),selector=AcquisitionSelectorSchema.parse(native.spec.selector),snapshot=descriptor.snapshot;
  requireThat(same(descriptor.scope,native.spec.sourceScope)&&descriptor.root===selector.root&&same(snapshot.request,{method:selector.request.method,body:selector.request.body,contentType:selector.request.contentType}),'Canonical descriptor changes acquisition scope/request');
  for(const hash of [snapshot.sourceSha256,snapshot.policyReceiptSha256,descriptor.httpObservation.receiptSha256])requireThat(native.receipt.outputHashes.includes(hash),'Parser source/policy/HTTP proof is not an authenticated acquisition output');
  requireThat(Date.parse(descriptor.fetchedAt)>=Date.parse(native.receipt.startedAt)&&Date.parse(descriptor.admittedAt)<=Date.parse(native.receipt.finishedAt),'Representation clocks are outside canonical acquisition execution');
  const observation=Buffer.from(await custody.readCas(descriptor.httpObservation.receiptSha256));
  requireThat(digest(observation)===descriptor.httpObservation.receiptSha256&&observation.toString('utf8')===descriptor.httpObservation.bytes,'Canonical acquisition HTTP observation differs from managed CAS');
  requireThat(!descriptors.has(descriptor.scope.sourceId),'Duplicate acquired source in execution evidence');
  descriptors.set(descriptor.scope.sourceId,{descriptor,receipt:native.receipt});
 }
 requireThat(descriptors.size===2,'Both canonical GENESIS and PEGEL acquisitions are required');
 for(const entry of evidence.steps){
  if(entry.receipt.step!=='structured_parse')continue;
  const native=committed.get(entry.sha256)!,acquired=descriptors.get(native.receipt.sourceId);requireThat(acquired,'Selected parser lacks its canonical acquisition');
  const selector=z.object({worker:StructuredWorkerRequestSchema,sourceBindings:z.array(HttpSourceBindingSchema),supportingSources:z.array(z.unknown())}).passthrough().parse(native.spec.selector),worker=selector.worker,descriptor=acquired!.descriptor,snapshot=descriptor.snapshot;
  requireThat(worker.operation==='parse'&&worker.adapter===(native.receipt.sourceId==='pegelonline'?'gauges':'genesis')&&same(worker.options,{})&&worker.auxiliary.length===0&&selector.supportingSources.length===0,'Parser changes approved local operation or supporting input scope');
  requireThat(same(worker.scope,descriptor.scope)&&same(worker.snapshot,snapshot)&&worker.inputArtifactSha256===snapshot.sourceSha256&&native.spec.policyProofSha256===snapshot.policyReceiptSha256&&native.receipt.policyProofSha256===snapshot.policyReceiptSha256,'Selected parser input differs from authenticated acquisition output');
  const binding=authenticatedHttpBinding(descriptor.httpObservation,{url:snapshot.url,sha256:snapshot.sourceSha256});
  requireThat(same(selector.sourceBindings,[binding]),'Parser does not select the acquired original HTTP observation');
  for(const hash of [snapshot.sourceSha256,snapshot.policyReceiptSha256,binding.receiptSha256])requireThat(native.spec.inputArtifactHashes.includes(hash)&&native.receipt.inputHashes.includes(hash),'Canonical parser omits an acquired source/policy/HTTP input');
  requireThat(Date.parse(native.receipt.startedAt)>=Date.parse(acquired!.receipt.finishedAt),'Parser precedes its canonical committed acquisition');
 }
}
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const requireThat=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
/** An execution deadline governs actual completed work, not the later policy
 * recheck clock. It cannot authorize a future request or renew any source proof. */
export function assertHistoricalStructuredExecution(window:{issuedAt:string;expiresAt:string},startedAt:string,finishedAt:string){
 const issued=Date.parse(Clock.parse(window.issuedAt)),end=Date.parse(Clock.parse(window.expiresAt)),started=Date.parse(Clock.parse(startedAt)),finished=Date.parse(Clock.parse(finishedAt));
 requireThat(issued<=started&&started<=finished&&finished<=end&&finished<=Date.now(),'Structured work did not finish inside its genuinely issued execution window');
}
export async function authenticateStructuredExecutionEvidence(input:{evidence:z.infer<typeof Pin>;baseAuthority:z.infer<typeof Pin>;selectionIssuedAt:string;receipts:readonly {runId:string;sha256:string;step:string;municipalityId:string;sourceId:string}[];readControl:(pin:z.infer<typeof Pin>)=>Promise<Uint8Array>;custody:StructuredExecutionCustody}){
 const read=async(pin:z.infer<typeof Pin>)=>{const bytes=Buffer.from(await input.readControl(Pin.parse(pin)));requireThat(digest(bytes)===pin.sha256,'Structured execution control digest mismatch');return JSON.parse(bytes.toString('utf8'));};
 const evidence=Evidence.parse(await read(input.evidence));requireThat(same(evidence.baseAuthority,input.baseAuthority),'Execution evidence changes original renewal authority');
 const continuation=z.object({schemaVersion:z.literal('r1-step8-structured-rest-continuation-v1'),issuedAt:Clock,expiresAt:Clock,baseAuthority:Pin,ownerDecision:Pin,ownerDraftSha256:HashSchema,securityRelease:Pin,acquisitionSelector:z.object({scope:ScopeSchema,discovery:z.null()}).passthrough(),acquisitionContractSha256:HashSchema,resolution:z.object({action:z.literal('one-pegel-attempt-then-all-remaining-local-parses'),mode:z.enum(['resume_held','new_contract_job']),priorJobKey:HashSchema,acquisitionJobKey:HashSchema,pegelAttemptBefore:z.literal(1),pegelAttemptAfter:z.union([z.literal(1),z.literal(2)]),additionalHttpRequestCeiling:z.literal(8),wholeOperationHttpCeilingIncludingHistory:z.literal(20),maxNewAcquisitionJobs:z.literal(1),maxLocalParseJobs:z.literal(5),maxPegelPages:z.literal(4),maxNewJobs:z.literal(6),maxWholeOperationJobs:z.literal(8),maxModelCalls:z.literal(0),paidMicroUsd:z.literal(0)}).passthrough()}).passthrough().parse(await read(evidence.continuation));
 const rawOwner=await read(evidence.ownerDecision),owner=z.object({schemaVersion:z.literal('stadtstack-r1-owner-approval-record-v1'),issuedAt:Clock,approved:z.literal(true),approver:z.literal('Max (owner)'),ownerStatementsVerbatim:z.array(z.string().min(1)).min(1),baseAuthority:Pin,request:z.object({action:z.literal('one-additional-exact-pegel-attempt-and-remaining-local-structured-parses'),jobKey:HashSchema,acquisition:Pin,securityStop:z.object({cve:z.literal('CVE-2026-111497'),requiresIssuedPostStopRelease:z.literal(true),requiresReviewedPoliteFetchFix:z.literal(true),requiresNodeVersion:z.literal('v24.22.1'),noLiveFetchUntilAllGatesPass:z.literal(true)}).strict(),additionalAcquisitionAttempts:z.literal(1),additionalPegelDataRequests:z.literal(1),additionalHttpRequestCeiling:z.literal(8),wholeOperationHttpCeilingIncludingHistory:z.literal(20),wholeOperationAcquisitionAttemptCeilingIncludingHistory:z.literal(3),wholeOperationJobCeilingIncludingHistory:z.literal(8),maxRemainingLocalParseJobs:z.literal(5),maxPegelParserPages:z.literal(4),maxModelCalls:z.literal(0),paidMicroUsd:z.literal(0),wallBudgetExtension:z.literal(true),expiresAt:Clock}).passthrough()}).passthrough().parse(rawOwner);
 requireThat(same(continuation.baseAuthority,input.baseAuthority)&&same(owner.baseAuthority,input.baseAuthority)&&same(continuation.ownerDecision,evidence.ownerDecision)&&continuation.expiresAt===owner.request.expiresAt&&continuation.resolution.priorJobKey===owner.request.jobKey,'Execution continuation changes exact owner scope');
 requireThat(continuation.ownerDraftSha256===digest(JSON.stringify({...rawOwner,issuedAt:'',approved:false,ownerStatementsVerbatim:[]},null,2)+'\n'),'Execution owner decision differs from reviewed draft');
 requireThat(Date.parse(owner.issuedAt)<=Date.parse(continuation.issuedAt),'Continuation precedes owner decision');
 requireThat(same(evidence.securityRelease,continuation.securityRelease),'Execution evidence drops the issued security release');
 const security=z.object({schemaVersion:z.literal('r1-step8-source-fetch-security-release-v1'),issuedAt:Clock,sourceFetchStopLifted:z.literal(true),approvedBy:z.literal('Main'),cve:z.literal('CVE-2026-111497'),node:z.object({path:z.string().refine(isAbsolute),version:z.literal('v24.22.1'),sha256:HashSchema}).strict(),politeFetch:Pin,fixReview:Pin,gateEvidence:Pin,acquisitionContractSha256:HashSchema}).passthrough().parse(await read(evidence.securityRelease));
 const review=z.object({verdict:z.literal('approved'),reviewedBy:z.literal('Main'),cve:z.literal('CVE-2026-111497'),politeFetchSha256:HashSchema}).passthrough().parse(await read(security.fixReview)),gates=z.object({passed:z.literal(true),nodeVersion:z.literal('v24.22.1'),politeFetchSha256:HashSchema,acquisitionContractSha256:HashSchema}).passthrough().parse(await read(security.gateEvidence));
 requireThat(review.politeFetchSha256===security.politeFetch.sha256&&gates.politeFetchSha256===security.politeFetch.sha256&&gates.acquisitionContractSha256===security.acquisitionContractSha256&&continuation.acquisitionContractSha256===security.acquisitionContractSha256&&evidence.nodePath===security.node.path&&Date.parse(security.issuedAt)<=Date.parse(evidence.startedAt),'Execution lacks the exact reviewed fixed fetch/Node security cutover');
 const manifest=z.object({jobs:z.array(z.unknown())}).passthrough().parse(await read(owner.request.acquisition));
 requireThat(manifest.jobs.some(row=>same(row,continuation.acquisitionSelector))&&continuation.acquisitionSelector.scope.sourceId==='pegelonline'&&continuation.acquisitionSelector.scope.municipalityId==='hagenow','Fixed-contract acquisition changes approved exact selector');
 const target=canonicalJobIdentity({step:'acquire_representation',lane:'acquisition',semanticContractSha256:continuation.acquisitionContractSha256,inputArtifactHashes:[],sourceScope:continuation.acquisitionSelector.scope,selector:continuation.acquisitionSelector,policyProofSha256:null}).jobKey;
 requireThat(target===continuation.resolution.acquisitionJobKey&&(continuation.resolution.mode==='resume_held'?target===continuation.resolution.priorJobKey&&continuation.resolution.pegelAttemptAfter===2:target!==continuation.resolution.priorJobKey&&continuation.resolution.pegelAttemptAfter===1),'Acquisition contract cutover retags an immutable historical job');
 assertHistoricalStructuredExecution(continuation,evidence.startedAt,evidence.finishedAt);
 requireThat(Date.parse(evidence.finishedAt)<=Date.parse(Clock.parse(input.selectionIssuedAt)),'Selection precedes completed structured execution');
 const prior=z.object({issuedAt:Clock,expiresAt:Clock,baseAuthority:Pin,resolution:z.object({action:z.literal('fresh-authority-for-unattempted-genesis-only'),jobKeys:z.array(HashSchema).length(1)}).passthrough()}).passthrough().parse(await read(evidence.priorGenesis.continuation)),genesis=evidence.priorGenesis.receipt;
 requireThat(same(prior.baseAuthority,input.baseAuthority)&&semanticHash(genesis)===evidence.priorGenesis.sha256&&genesis.sourceId==='regionalstatistik-genesis'&&genesis.municipalityId==='strausberg'&&genesis.step==='acquire_representation'&&genesis.attempt===1&&genesis.outcome==='succeeded'&&genesis.provider===null&&prior.resolution.jobKeys[0]===genesis.jobKey,'Prior GENESIS acquisition is not the exact successful inspected continuation');
 assertHistoricalStructuredExecution(prior,genesis.startedAt,genesis.finishedAt);
 requireThat(new Set(evidence.steps.map(row=>row.sha256)).size===evidence.steps.length,'Duplicate execution step');
 const acquisitions=evidence.steps.filter(row=>row.receipt.step==='acquire_representation'),parsers=evidence.steps.filter(row=>row.receipt.step==='structured_parse');
 requireThat(acquisitions.length===1&&parsers.length===evidence.newParseJobs&&acquisitions.length+parsers.length===evidence.steps.length,'Execution evidence changes acquisition/parse count');
 const acquisition=acquisitions[0].receipt;requireThat(acquisition.jobKey===continuation.resolution.acquisitionJobKey&&acquisition.attempt===continuation.resolution.pegelAttemptAfter&&acquisition.versions.acquisition===security.acquisitionContractSha256&&acquisition.sourceId==='pegelonline'&&acquisition.municipalityId==='hagenow','Additional acquisition is not the exact gated PEGEL attempt');
 let genesisParsers=0,pegelParsers=0;
 for(const row of parsers){if(row.receipt.sourceId==='regionalstatistik-genesis')genesisParsers++;else if(row.receipt.sourceId==='pegelonline')pegelParsers++;}
 requireThat(genesisParsers===1&&pegelParsers>=1&&pegelParsers<=4&&genesisParsers+pegelParsers===parsers.length,'Execution evidence changes local parser source/page scope');
 const metadata=parsers.map(({sha256,receipt})=>({sha256,runId:receipt.runId,step:receipt.step,municipalityId:receipt.municipalityId,sourceId:receipt.sourceId})).sort((a,b)=>a.sha256.localeCompare(b.sha256));
 requireThat(same(metadata,[...input.receipts].sort((a,b)=>a.sha256.localeCompare(b.sha256))),'Execution evidence differs from exact selected parser receipts');
 requireThat(same(evidence.stageAuthorities,evidence.steps.map(row=>row.stageAuthority)),'Unused or reordered execution stage authority');
 for(const row of evidence.steps){
  const receipt=row.receipt;requireThat(semanticHash(receipt)===row.sha256&&receipt.outcome==='succeeded'&&receipt.provider===null,'Execution receipt identity/outcome mismatch');
  assertHistoricalStructuredExecution(continuation,receipt.startedAt,receipt.finishedAt);
  requireThat(Date.parse(receipt.startedAt)>=Date.parse(evidence.startedAt)&&Date.parse(receipt.finishedAt)<=Date.parse(evidence.finishedAt),'Receipt outside completed evidence interval');
  const stage=z.object({schemaVersion:z.literal('stadtstack-r1-stage-authorization-record-v1'),issuedAt:Clock,expiresAt:Clock,parentContinuation:Pin,stage:z.object({step:z.string(),jobKeys:z.array(HashSchema).length(1),ags:z.array(z.string()).length(1),maxJobs:z.literal(1),maxElapsedMs:z.number().int().positive().max(540000),category:z.literal('production'),mode:z.literal('bounded_unattended')}).strict()}).passthrough().parse(await read(row.stageAuthority));
  requireThat(same(stage.parentContinuation,evidence.continuation)&&stage.stage.step===receipt.step&&stage.stage.jobKeys[0]===receipt.jobKey&&stage.stage.ags[0]===(receipt.sourceId==='pegelonline'?'13076060':'12064472')&&stage.expiresAt===continuation.expiresAt&&Date.parse(stage.issuedAt)>=Date.parse(continuation.issuedAt),'Stage authority changes continuation/job scope');
  assertHistoricalStructuredExecution(stage,receipt.startedAt,receipt.finishedAt);
 }
 await authenticateExecutionCustody(evidence,input.custody);
 return evidence;
}
