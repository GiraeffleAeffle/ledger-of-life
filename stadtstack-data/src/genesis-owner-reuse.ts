import {readFile,lstat,opendir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {HashSchema,canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {canonicalJobIdentity,type DistrictJobStore,type DistrictJobSpec} from './district-jobs.ts';
import {StepReceiptSchema} from './district-step-receipt.ts';
import {HttpObservationProofSchema,authenticatedHttpBinding} from './district-http-observation.ts';
import {SourceObservationSchema} from './source-observation.ts';
import {CrawlRequestEvidenceSchema} from './district-crawl-request.ts';
import {assertManagedSourceBindings,type CivicPolicyOptions} from './civic-opt-out.ts';
import {genesisOwnerAccountRoot,readGenesisOwnerRepresentation} from './genesis-owner-acquisition.ts';
import {ownerGenesisAccessFor,sourcePolicyExpiresAt} from './source-policy.ts';
import type {RegisteredRobotsAudit} from './registered-source-policy.ts';
import type {FetchedDocument} from './polite-fetch.ts';
import type {AcquisitionSelectorSchema} from './district-r1.ts';

export const OwnerAcquisitionReusePinSchema=z.object({priorJobKey:HashSchema,priorReceiptSha256:HashSchema,priorAttempt:z.number().int().positive(),observationId:HttpObservationProofSchema.shape.observationId,requestEvidenceSha256:HashSchema}).strict();
export type OwnerAcquisitionReusePin=z.infer<typeof OwnerAcquisitionReusePinSchema>;
type Acquisition=z.infer<typeof AcquisitionSelectorSchema>;
const observationMetadataSchema=SourceObservationSchema.pick({url:true,method:true,checkedAt:true}).extend({state:z.string()});
async function boundedBytes(path:string):Promise<Buffer>{
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Prior acquisition evidence bounds rejected');
 const bytes=await readFile(path);if(bytes.length>1024*1024)throw Error('Prior acquisition evidence bounds rejected');return bytes;
}

/** Offline admission only. A held request is never retried, and timing is taken
 * from its committed attempt receipt rather than manufactured lease clocks. */
export async function readPriorGenesisOwnerAcquisition(store:Pick<DistrictJobStore,'pool'>,rawRoot:string,acquisition:Acquisition,pinInput:unknown,policy:CivicPolicyOptions={},eligibility?:RegisteredRobotsAudit){
 const pin=OwnerAcquisitionReusePinSchema.parse(pinInput);
 if(acquisition.request.method!=='POST'||acquisition.request.publicOperation!=='genesis_guest'||!ownerGenesisAccessFor(acquisition.request.url)||acquisition.permission.kind!=='facts_with_attribution')throw Error('Prior acquisition reuse requires the owner-account selector');
 const rows=await store.pool.query<{job_id:string;job_key:string;spec:DistrictJobSpec;state:string;attempt:number;receipt_id:string;run_id:string;receipt_attempt:number;fencing_token:string;receipt_sha256:string;receipt:unknown}>(`SELECT j.id AS job_id,j.job_key,j.spec,j.state,j.attempt,r.id AS receipt_id,r.run_id,r.attempt AS receipt_attempt,r.fencing_token,r.receipt_sha256,r.receipt FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id WHERE j.job_key=$1 ORDER BY r.attempt DESC LIMIT 2`,[pin.priorJobKey]);
 const row=rows.rows[0];
 if(!row||row.state!=='held_execution'||row.attempt!==pin.priorAttempt||row.receipt_sha256!==pin.priorReceiptSha256||canonicalJobIdentity(row.spec).jobKey!==pin.priorJobKey)throw Error('Prior acquisition is not the pinned last held attempt');
 const receipt=StepReceiptSchema.parse(row.receipt);
 if(semanticHash(receipt)!==pin.priorReceiptSha256||receipt.id!==row.receipt_id||receipt.runId!==row.run_id||receipt.attempt!==row.receipt_attempt||receipt.leaseToken!==row.fencing_token||receipt.jobKey!==pin.priorJobKey||receipt.attempt!==pin.priorAttempt||receipt.step!=='acquire_representation'||receipt.lane!=='acquisition'||receipt.outcome!=='held_execution'||receipt.outputHashes.length||row.spec.step!==receipt.step||row.spec.lane!==receipt.lane||receipt.versions.acquisition!==undefined&&receipt.versions.acquisition!==row.spec.semanticContractSha256||canonicalJson(row.spec.selector)!==canonicalJson(acquisition)||semanticHash(row.spec.sourceScope)!==semanticHash(acquisition.scope)||canonicalJson(receipt.inputHashes)!==canonicalJson(row.spec.inputArtifactHashes)||receipt.policyProofSha256!==row.spec.policyProofSha256||receipt.sourceId!==acquisition.scope.sourceId||receipt.municipalityId!==acquisition.scope.municipalityId||Date.parse(receipt.finishedAt)>Date.now())throw Error('Prior acquisition receipt changes selector or attempt identity');
 const overlap=await store.pool.query(`SELECT r.id FROM district_pipeline.step_receipts r WHERE r.receipt->>'step'='acquire_representation' AND (r.job_id<>$1 OR r.attempt<>$2) AND (r.receipt->>'startedAt')::timestamptz<=$4::timestamptz AND (r.receipt->>'finishedAt')::timestamptz>=$3::timestamptz LIMIT 1`,[row.job_id,pin.priorAttempt,receipt.startedAt,receipt.finishedAt]);
 if(overlap.rowCount)throw Error('Prior acquisition attempt window overlaps another acquisition');
 const root=genesisOwnerAccountRoot(rawRoot),directory=join(root,'observations');
 if(await realpath(directory)!==directory)throw Error('Prior acquisition observation directory mismatch');
 const candidates:{document:FetchedDocument;requestEvidenceSha256:string;redirectChain:string[]}[]=[],start=Date.parse(receipt.startedAt),end=Date.parse(receipt.finishedAt);
 let count=0;
 for await(const entry of await opendir(directory)){
  if(++count>10000)throw Error('Prior acquisition observation scan bound exceeded');
  if(!entry.isFile()||!HttpObservationProofSchema.shape.observationId.safeParse(entry.name).success)throw Error('Prior acquisition observation directory is unsafe');
  const observationPath=join(directory,entry.name),bytes=await boundedBytes(observationPath),raw=JSON.parse(bytes.toString('utf8')),metadata=observationMetadataSchema.parse(raw);
  const checkedAt=Date.parse(metadata.checkedAt),createdAt=Number(entry.name.slice(0,entry.name.indexOf('-')));
  if(checkedAt<start||checkedAt>end||createdAt<start||createdAt>end||metadata.url!==acquisition.request.url||metadata.method!==acquisition.request.method||metadata.state!=='fetched')continue;
  const observed=SourceObservationSchema.parse(raw),proof=HttpObservationProofSchema.parse({observationId:entry.name,receiptSha256:digest(bytes),bytes:bytes.toString('utf8')}),binding=authenticatedHttpBinding(proof,{url:acquisition.request.url,sha256:observed.sha256});
  const evidencePath=join(root+'-request-evidence','requests',entry.name);
  await assertManagedSourceBindings(evidencePath,[binding],policy);
  const evidenceBytes=await boundedBytes(evidencePath),evidence=CrawlRequestEvidenceSchema.parse(JSON.parse(evidenceBytes.toString('utf8')));
  await assertManagedSourceBindings(evidencePath,[binding],policy);
  if(canonicalJson(evidence.httpObservation)!==canonicalJson(binding)||evidence.request.url!==acquisition.request.url||evidence.request.method!==acquisition.request.method||evidence.request.contentType!==acquisition.request.contentType||evidence.request.bodySha256!==(acquisition.request.body===null?null:digest(acquisition.request.body))||evidence.redirectChain.some(url=>!ownerGenesisAccessFor(url)))throw Error('Prior acquisition request evidence differs from exact selector');
  const document:FetchedDocument={...observed,localPath:join(root,'sha256',observed.sha256.slice(0,2),observed.sha256),observationPath};
  candidates.push({document,requestEvidenceSha256:digest(evidenceBytes),redirectChain:evidence.redirectChain});
 }
 if(candidates.length!==1||candidates[0].document.observationPath!==join(directory,pin.observationId)||candidates[0].requestEvidenceSha256!==pin.requestEvidenceSha256)throw Error('Prior acquisition observation selection is missing or ambiguous');
 const selected=candidates[0],admitted=await readGenesisOwnerRepresentation(rawRoot,selected.document,policy,acquisition.maxBytes);
 const expiresAt=sourcePolicyExpiresAt(selected.document.policy!,selected.document.checkedAt,selected.document,acquisition.scope,eligibility);
 if(Date.parse(expiresAt)<=Date.now())throw Error('Prior acquisition policy evidence is stale');
 return {...admitted,response:selected.document,redirectChain:selected.redirectChain,expiresAt,versions:{acquisitionMode:'offline_prior_attempt',priorAcquisitionJobKey:pin.priorJobKey,priorAcquisitionReceiptSha256:pin.priorReceiptSha256,priorAcquisitionAttempt:String(pin.priorAttempt),priorAcquisitionContractSha256:row.spec.semanticContractSha256,priorHttpObservationId:pin.observationId,priorHttpObservationSha256:admitted.httpObservation.receiptSha256,priorRequestEvidenceSha256:pin.requestEvidenceSha256}};
}
