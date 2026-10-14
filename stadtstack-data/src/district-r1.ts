import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir,rename,readFile} from 'node:fs/promises';
import {dirname,join,resolve,basename,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as waitBeforeDispatch} from 'node:timers/promises';
import {Pool} from 'pg';
import {z} from 'zod';
import {DistrictCas} from './district-cas.ts';
import type {CasArtifact} from './district-cas.ts';
import {DistrictJobStore,DistrictExecutionHold,runDistrictJobsCli,migrateDistrictJobs,R1_MUNICIPALITIES,insertR1MetadataSnapshot} from './district-jobs.ts';
import type {JobHandler,DistrictJobSpec} from './district-jobs.ts';
import {canonicalJson,digest,semanticHash,ScopeSchema,HashSchema} from './district-adapter-contract.ts';
import type {AdapterScope} from './district-adapter-contract.ts';
import {districtRegistrySchema} from './district-registry.ts';
import type {DistrictRegistry} from './district-registry.ts';
import {registerStructuredCatalog} from './district-structured-registry.ts';
import {buildOperatorRegistryConfigDescriptor,readOperatorRegistryInputPin,operatorRegistryInputPinSchema,parseOperatorRegistryConfiguration} from './district-registry-config.ts';
import {StructuredWorkerRequestSchema,StructuredSnapshotMetadataSchema} from './district-structured-parser-worker.ts';
import {StructuredJobResultSchema,structuredJobHandlers} from './district-structured-jobs.ts';
import {persistOperatorRegistry,persistR1Representation,enqueueStructuredSnapshot,exportStepReceipt} from './district-r1-state.ts';
import {PolicyReceiptSchema,createPolicyReceipt,recheckPolicyReceipt} from './district-policy-receipt.ts';
import {StepReceiptSchema} from './district-step-receipt.ts';
import {PoliteFetcher,PoliteFetchError} from './polite-fetch.ts';
import type {FetchedDocument,FetchFailure,FixturePolicyInspection} from './polite-fetch.ts';
import {nativePublicRequestHeaders} from './district-native-request.ts';
import {readGenesisOwnerRepresentation} from './genesis-owner-acquisition.ts';
import {OwnerAcquisitionReusePinSchema,readPriorGenesisOwnerAcquisition} from './genesis-owner-reuse.ts';
import {admittedRegisteredRobotsScopes,type RegisteredRobotsAudit} from './registered-source-policy.ts';
import {pipelineNotificationConfig} from './district-notifications.ts';
import {initializeManagedAcquisitionLane,withManagedSourceWrite,assertManagedSourceReadable,assertManagedRawSourceBinding,assertCivicPolicyAuthority,CIVIC_ACQUISITION_DECISION_ID} from './civic-opt-out.ts';
import type {ManagedSourceContent,ManagedSourceBinding,CivicPolicyOptions} from './civic-opt-out.ts';
import {HttpObservationSchema,HttpObservationProofSchema,HttpSourceBindingSchema,authenticatedHttpBinding} from './district-http-observation.ts';
import type {HttpObservationProof} from './district-http-observation.ts';
import {ownerRobotsOverrideFor,ownerGenesisAccessFor,sourcePolicyExpiresAt,registeredSourcePolicyApplies,PUBLIC_SOURCE_POLICY_VALIDITY_MS} from './source-policy.ts';
import {structuredRunSchema,structuredCoverageReceiptSchema,structuredCoverageStateForNoOutput,verifyStructuredRunReceipts} from './district-structured-run.ts';
import type {StructuredJobResult} from './district-structured-jobs.ts';
import type {StructuredCoverageReceipt} from './district-structured-run.ts';
import type {StepReceipt,ReasonCode} from './district-step-receipt.ts';
import type {StructuredSupportingSource} from './district-structured-record.ts';
import {StructuredKnowledgeRecordSchema} from './district-structured-record.ts';
import type {StructuredWorkerRequest} from './district-structured-parser-worker.ts';
import {ResidualInputSchema,residualJobHandlersFor,enqueueResidualPreparation,enqueueCommittedResidualExtraction,exportResidualTextContribution} from './district-residual-jobs.ts';
import {CrawlCorpusImportSchema,importCrawlCorpusForResidual} from './district-crawl-import.ts';
import {DistrictAssessmentBroker,enqueueAssessmentB,assessmentEvidenceArtifactHashes} from './district-assessment-broker.ts';
import {assessmentItemSchema} from './district-assessment.ts';
import {assessmentQueueHandlers,enqueueResidualAssessmentItems,enqueuePreparedAssessmentPass,enqueueAssessmentResolution,exportAssessmentResults} from './district-assessment-jobs.ts';
import {r1TextCompositionInputSchema,loadR1TextCompositionInput,buildR1TextCompositionContext} from './district-r1-text-composition.ts';
import {structuredFieldPublicationHold} from './district-public-fields.ts';
import type {StructuredFieldHold} from './district-public-fields.ts';
import {CrawlPolicyRefreshEnqueueSchema,enqueueCrawlPolicyRefresh,policyRefreshHandler} from './district-policy-refresh.ts';
import {QueueTextSealInputSchema,sealQueueTextContribution} from './district-queue-text-run.ts';
import {KnowledgeRecordsSchema} from './district-schema.ts';
import {readTextLineageArtifact} from './text-run-lineage.ts';

const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const R1_FETCH_ROOT=join(REPO,'cache/districts/r1-fetch');
const OPERATOR_ROOT=join(REPO,'cache/districts/r1-operator');
const CAS_ROOT=join(REPO,'cache/districts/cas');
const ACQUISITION_VERSION='district-r1-acquisition-v1';
const PermissionSchema=PolicyReceiptSchema.shape.permission;
const requestSchema=z.object({url:z.url(),method:z.enum(['GET','POST']),body:z.string().max(65536).nullable(),contentType:z.string().nullable(),publicOperation:z.enum(['genesis_guest','ted_search']).nullable()}).strict();
export const AcquisitionSelectorSchema=z.object({version:z.literal(ACQUISITION_VERSION),scope:ScopeSchema,root:z.url(),request:requestSchema,permission:PermissionSchema,maxRequests:z.number().int().min(1).max(100),maxBytes:z.number().int().min(1).max(64*1024*1024),sourceVersion:z.string().nullable(),discovery:z.object({stepReceiptSha256:HashSchema,resultSha256:HashSchema}).strict().nullable()}).strict();
export const AcquiredRepresentationSelectorSchema=z.object({acquisition:AcquisitionSelectorSchema,prior:OwnerAcquisitionReusePinSchema}).strict();
const assessmentBEnqueueInput=z.object({itemArtifactSha256:HashSchema,sourceScope:ScopeSchema,policyProofSha256:HashSchema});
export const AssessmentBEnqueueManifestSchema=z.object({jobs:z.array(z.discriminatedUnion('transport',[
 assessmentBEnqueueInput.extend({transport:z.literal('mac-bridge'),clientContractSha256:HashSchema}).strict(),
 assessmentBEnqueueInput.extend({transport:z.literal('vm-omp')}).strict(),
])).min(1).max(10000)}).strict();
interface HttpSourceReference {sha256:string;url:string;policyReceiptSha256:string;httpObservation:HttpObservationProof}
interface HttpSourceAuditReference extends HttpSourceReference {descriptorSha256:string}
export const AcquisitionDescriptorPinSchema=z.object({sha256:HashSchema,path:z.string().min(1)}).strict();
export type AcquisitionDescriptorPin=z.infer<typeof AcquisitionDescriptorPinSchema>;
export const R1ArtifactAuditSchema=z.object({
 schemaVersion:z.literal('district-r1-artifact-audit-v1'),
 kind:z.enum(['acquisition_descriptor','structured_run','records','coverage']),
 artifact:z.object({sha256:HashSchema,byteLength:z.number().int().nonnegative(),kind:z.literal('derived'),mimeType:z.literal('application/json')}).strict(),
 sources:z.array(z.object({binding:HttpSourceBindingSchema,policyReceiptSha256:HashSchema}).strict()).min(1),
 counts:z.object({records:z.number().int().nonnegative().nullable(),coverageReceipts:z.number().int().nonnegative().nullable()}).strict(),
}).strict();
function httpObservationBinding(source:HttpSourceReference):ManagedSourceBinding {
 return authenticatedHttpBinding(source.httpObservation,{url:source.url,sha256:source.sha256});
}
export const RepresentationDescriptorSchema=z.object({version:z.literal('district-r1-representation-v1'),scope:ScopeSchema,root:z.url(),snapshotId:z.uuid(),policyDecisionId:z.uuid(),receiptSha256:HashSchema,sourceArtifact:z.object({sha256:HashSchema,byteLength:z.number().int().nonnegative(),kind:z.literal('source_original'),mimeType:z.string(),storageKey:z.string()}).strict(),snapshot:StructuredSnapshotMetadataSchema,httpObservation:HttpObservationProofSchema,fetchedAt:z.iso.datetime(),admittedAt:z.iso.datetime(),redirectChain:z.array(z.url())}).strict().superRefine((descriptor,ctx)=>{
 try{authenticatedHttpBinding(descriptor.httpObservation,{url:descriptor.snapshot.url,sha256:descriptor.snapshot.sourceSha256,mimeType:descriptor.snapshot.mimeType,retrievedAt:descriptor.snapshot.retrievedAt,fetchedAt:descriptor.fetchedAt});}catch{ctx.addIssue({code:'custom',message:'Representation HTTP observation binding mismatch'});}
 if(descriptor.receiptSha256!==descriptor.snapshot.policyReceiptSha256||descriptor.sourceArtifact.sha256!==descriptor.snapshot.sourceSha256||descriptor.sourceArtifact.mimeType!==descriptor.snapshot.mimeType)ctx.addIssue({code:'custom',message:'Representation policy and source artifact binding mismatch'});
});
export const HostGroupsSchema=z.object({schemaVersion:z.literal('district-host-groups-v1'),serviceGroups:z.tuple([z.object({id:z.literal('r1-public-acquisition'),groupingBasis:z.literal('conservative_capacity_pool_not_publisher_equivalence'),scope:z.literal('all_registered_public_sources_and_observed_redirect_hosts'),minStartIntervalMs:z.literal(2500),maxInFlight:z.literal(1)}).strict()])}).strict();
export async function acquisitionContract(){
 const hostGroupsBytes=await readFile(join(REPO,'sources/district-host-groups.json'));
 HostGroupsSchema.parse(JSON.parse(hostGroupsBytes.toString('utf8')));
 return semanticHash({version:ACQUISITION_VERSION,hostGroupsSha256:digest(hostGroupsBytes),files:await Promise.all(['district-r1.ts','district-r1-state.ts','polite-fetch.ts','district-crawl-request.ts','district-policy-receipt.ts','source-policy.ts','registered-source-policy.ts','civic-opt-out.ts','district-native-request.ts','genesis-owner-credentials.ts','genesis-owner-acquisition.ts','genesis-owner-reuse.ts','district-http-observation.ts'].map(async file=>({file,sha256:digest(await readFile(join(REPO,'src',file)))})))});
}

/** Controlled counts over the actual committed pages; no source literals or raw hold explanations. */
export function structuredHoldSummary(outputs:readonly Pick<StructuredJobResult,'result'|'unpublishedObservations'>[]){
 const counts:Record<StructuredFieldHold,number>={narrative_requires_text_model:0,source_literal_exceeds_short_quote:0,contact_field:0};
 let unpublishedObservations=0;
 for(const output of outputs){
  unpublishedObservations+=output.unpublishedObservations;
  if('observations' in output.result)for(const observation of output.result.observations){const hold=structuredFieldPublicationHold(observation);if(hold)counts[hold]++;}
 }
 const heldObservations=counts.narrative_requires_text_model+counts.source_literal_exceeds_short_quote+counts.contact_field,residualRequiredObservations=counts.narrative_requires_text_model+counts.source_literal_exceeds_short_quote;
 if(heldObservations>unpublishedObservations)throw Error('Native field hold count exceeds actual unpublished observations');
 return {schemaVersion:'district-r1-native-field-holds-v1',basis:'actual_committed_output_pages',heldObservations,unpublishedObservations,otherUnpublishedObservations:unpublishedObservations-heldObservations,counts,residualRequiredObservations,contactExcludedObservations:counts.contact_field,routeHints:[...(residualRequiredObservations?[{route:'residual_text_model',command:'enqueue-residual-preparation'}]:[]),...(counts.contact_field?[{route:'contact_excluded_from_publication',command:null}]:[])]};
}

export function registeredScope(registry:DistrictRegistry,scope:AdapterScope,root:string){
 const city=registry.municipalities.find(row=>row.id===scope.municipalityId);
 if(!city||city.ags!==scope.ags||R1_MUNICIPALITIES[city.id]!==city.ags)throw Error('Scope outside registered R1 ring');
 const source=city.sources.find(row=>row.id===scope.sourceId);
 if(!source||source.url!==root)throw Error('Exact registered source root required');
 // Publisher and tenant are explicitly selected provenance, not inferred host authority.
 return {city,source};
}
async function privateRoot(root:string){
 await mkdir(root,{recursive:true,mode:0o700});
 const stat=await lstat(root);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||await realpath(root)!==root)throw Error('Private root rejected');
}
export async function readFetchedBytes(root:string,file:string,sha256:string,maxBytes:number):Promise<Buffer>{
 HashSchema.parse(sha256);
 if(resolve(file)!==join(root,'sha256',sha256))throw Error('Fetch path outside fixed hash root');
 if(await realpath(root)!==root||await realpath(join(root,'sha256'))!==join(root,'sha256'))throw Error('Fetch directory symlink rejected');
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size>maxBytes)throw Error('Fetched input type or size rejected');
  const bytes=Buffer.alloc(stat.size);let offset=0;
  while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)throw Error('Fetched file truncated');offset+=result.bytesRead;}
  const end=Buffer.alloc(1);if((await handle.read(end,0,1,offset)).bytesRead||digest(bytes)!==sha256)throw Error('Fetched bytes changed or digest mismatch');return bytes;
 }finally{await handle.close();}
}

/** Read only the actual transport-returned immutable observation in the fixed fetch root. */
async function readHttpObservation(response:FetchedDocument,root=R1_FETCH_ROOT,policy:CivicPolicyOptions={}){
 const observationId=basename(response.observationPath),path=join(root,'observations',observationId);
 if(resolve(response.observationPath)!==path||await realpath(root)!==root||await realpath(dirname(path))!==dirname(path))throw Error('HTTP observation escaped fixed fetch root');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.size<1||stat.size>1024*1024)throw Error('HTTP observation type or byte bound rejected');
  const bytes=Buffer.alloc(stat.size);let offset=0;
  while(offset<bytes.length){const read=await file.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw Error('HTTP observation truncated');offset+=read.bytesRead;}
  const extra=Buffer.alloc(1);if((await file.read(extra,0,1,offset)).bytesRead)throw Error('HTTP observation changed');
  const proof=HttpObservationProofSchema.parse({observationId,receiptSha256:digest(bytes),bytes:bytes.toString('utf8')}),observation=HttpObservationSchema.parse(JSON.parse(proof.bytes));
  const binding=authenticatedHttpBinding(proof,{url:response.url,sha256:response.sha256,mimeType:response.mimeType,retrievedAt:response.retrievedAt,fetchedAt:response.checkedAt});
  if(binding.kind!=='http_observation'||observation.status!==response.status)throw Error('HTTP observation differs from actual fetched response');
  await assertManagedRawSourceBinding(join(root,'sha256',response.sha256),binding,policy);
  return proof;
 }finally{await file.close();}
}

async function sourceHttpReference(store:DistrictJobStore,cas:DistrictCas,source:{sha256:string;url:string;policyReceiptSha256:string}):Promise<HttpSourceAuditReference>{
 const selected=[{binding:{kind:'http_observation',url:source.url,sourceSha256:source.sha256},policyReceiptSha256:source.policyReceiptSha256}];
 const rows=await store.pool.query<{sha256:string;payload_json:unknown}>(`SELECT sha256,payload_json FROM district_pipeline.r1_metadata_snapshots WHERE kind='acquisition_descriptor' AND payload_json->'sources' @> $1::jsonb LIMIT 2`,[canonicalJson(selected)]);
 if(rows.rowCount!==1||semanticHash(rows.rows[0].payload_json)!==rows.rows[0].sha256)throw Error('Source lacks unique authenticated acquisition audit');
 const audit=R1ArtifactAuditSchema.parse(rows.rows[0].payload_json);
 if(audit.kind!=='acquisition_descriptor')throw Error('Acquisition audit kind mismatch');
 await assertManagedSourceReadable(join(cas.root,'sha256',audit.artifact.sha256.slice(0,2),audit.artifact.sha256),{sourceUrl:source.url});
 const bytes=await cas.read(audit.artifact.sha256),descriptor=RepresentationDescriptorSchema.parse(JSON.parse(bytes.toString('utf8')));
 if(bytes.length!==audit.artifact.byteLength||descriptor.receiptSha256!==source.policyReceiptSha256||descriptor.snapshot.sourceSha256!==source.sha256||descriptor.snapshot.url!==source.url||!audit.sources.some(item=>item.policyReceiptSha256===source.policyReceiptSha256&&canonicalJson(item.binding)===canonicalJson(authenticatedHttpBinding(descriptor.httpObservation,{url:source.url,sha256:source.sha256}))))throw Error('Acquisition audit and private descriptor differ');
 return {...source,httpObservation:descriptor.httpObservation,descriptorSha256:audit.artifact.sha256};
}
/** Canonical metadata-only audit/staging outputs, not a raw-source managed lane.
 * They cannot be served without the publication path's current-policy rechecks. */
async function writeOperator(name:'registry.json'|`registry-proposal-${string}.json`|`catalog-routes-proposal-${string}.json`,value:unknown){
 if(name!=='registry.json'&&!/^(?:registry|catalog-routes)-proposal-\d{4}-\d{2}-\d{2}\.json$/.test(name))throw Error('Operator proposal output name rejected');
 await privateRoot(OPERATOR_ROOT);
 const temporary=join(OPERATOR_ROOT,`${name}.${randomUUID()}.tmp`),target=join(OPERATOR_ROOT,name),bytes=Buffer.from(canonicalJson(value)+'\n');
 const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
 await rename(temporary,target);
}

/** Only content-free audit hashes/bindings/counts persist; complete source-derived JSON is purgable CAS. */
export async function persistMetadata(store:DistrictJobStore,cas:DistrictCas,input:{kind:'acquisition_descriptor'|'structured_run'|'records'|'coverage';payload:unknown;sources:HttpSourceReference[]},policy:CivicPolicyOptions={}):Promise<CasArtifact>{
 let payload:unknown,recordCount:number|null=null,coverageCount:number|null=null;
 switch(input.kind){
  case 'acquisition_descriptor':payload=RepresentationDescriptorSchema.parse(input.payload);break;
  case 'structured_run':{const run=structuredRunSchema.parse(input.payload);payload=run;recordCount=run.records.length;coverageCount=run.coverage.length;break;}
  case 'records':{const records=z.array(StructuredKnowledgeRecordSchema).parse(input.payload);payload=records;recordCount=records.length;break;}
  case 'coverage':{const coverage=z.array(structuredCoverageReceiptSchema).parse(input.payload);payload=coverage;coverageCount=coverage.length;break;}
 }
 const bytes=Buffer.from(canonicalJson(payload)),hash=digest(bytes);
 if(bytes.length>64*1024*1024||!input.sources.length)throw Error('Source-derived artifact requires bounded bytes and actual sources');
 const audit=R1ArtifactAuditSchema.parse({schemaVersion:'district-r1-artifact-audit-v1',kind:input.kind,artifact:{sha256:hash,byteLength:bytes.length,kind:'derived',mimeType:'application/json'},sources:input.sources.map(source=>({binding:httpObservationBinding(source),policyReceiptSha256:source.policyReceiptSha256})),counts:{records:recordCount,coverageReceipts:coverageCount}});
 const auditSha256=await insertR1MetadataSnapshot(store.pool,{kind:input.kind,payload:audit});
 if(auditSha256!==semanticHash(audit))throw Error('Content-free artifact audit hash mismatch');
 await initializeManagedAcquisitionLane(cas.root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const references=input.sources.map((source):ManagedSourceContent=>({...httpObservationBinding(source),relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,independentAllowed:false}));
 const artifact=await withManagedSourceWrite(cas.root,references,()=>cas.put(bytes,{kind:'derived',mimeType:'application/json'}),policy);
 await store.addArtifact(artifact);return artifact;
}
export function parseR1RegistryArguments(rawArgs:readonly string[]){
 let path:string|undefined,sha256:string|undefined;const args:string[]=[];
 for(let index=0;index<rawArgs.length;index++){
  const flag=rawArgs[index];
  if(flag!=='--registry-config'&&flag!=='--registry-config-sha256'){args.push(flag);continue;}
  const value=rawArgs[++index];if(!value||value.startsWith('--'))throw Error('Registry configuration flag requires a value');
  if(flag==='--registry-config'){if(path!==undefined)throw Error('Duplicate registry configuration flag');path=value;}
  else{if(sha256!==undefined)throw Error('Duplicate registry configuration digest');sha256=value;}
 }
 return {registryPin:operatorRegistryInputPinSchema.parse({path,sha256}),args};
}

async function committedResult(store:DistrictJobStore,cas:DistrictCas,receiptSha256:string,resultSha256:string){
 const rows=await store.pool.query<{receipt:unknown}>('SELECT receipt FROM district_pipeline.step_receipts WHERE receipt_sha256=$1',[receiptSha256]);
 if(rows.rowCount!==1)throw Error('Committed receipt required');
 const receipt=StepReceiptSchema.parse(rows.rows[0].receipt);
 if(semanticHash(receipt)!==receiptSha256||!receipt.outputHashes.includes(resultSha256))throw Error('Committed output binding mismatch');
 const result=StructuredJobResultSchema.parse(JSON.parse((await cas.read(resultSha256)).toString('utf8')));
 if(!receipt.inputHashes.includes(result.sourceSha256)||receipt.policyProofSha256!==result.policyReceiptSha256||receipt.sourceId!==result.scope.sourceId||receipt.municipalityId!==result.scope.municipalityId)throw Error('Structured receipt source binding mismatch');
 return {receipt,result};
}
export async function validateAcquisitionSelector(registry:DistrictRegistry,store:DistrictJobStore,cas:DistrictCas,input:unknown){
 const selector=AcquisitionSelectorSchema.parse(input);registeredScope(registry,selector.scope,selector.root);
 const request=selector.request;
 if(request.method==='GET'&&(request.body!==null||request.publicOperation!==null||request.contentType!==null))throw Error('GET selector cannot carry POST profile');
 const headers=nativePublicRequestHeaders(new URL(request.url),request.method,request.body??undefined,request.publicOperation??undefined);
 if(request.method==='POST'&&request.contentType!==headers['Content-Type'])throw Error('Content type must match fixed native profile');
 if(request.publicOperation==='genesis_guest'&&ownerGenesisAccessFor(request.url)&&selector.permission.kind!=='facts_with_attribution')throw Error('Owner account permission is facts_with_attribution only');
 if(selector.discovery){
  const {receipt,result}=await committedResult(store,cas,selector.discovery.stepReceiptSha256,selector.discovery.resultSha256);
  if(receipt.step!=='structured_discover'||receipt.outcome!=='succeeded'||semanticHash(result.scope)!==semanticHash(selector.scope)||!('resources' in result.result)||!result.result.resources.some(resource=>resource.url===request.url&&resource.method===request.method&&resource.body===request.body))throw Error('Resource is not an actual admitted discovery selector');
  const proof=PolicyReceiptSchema.parse(JSON.parse((await cas.read(result.policyReceiptSha256)).toString('utf8')));await recheckPolicyReceipt(proof,{evaluationAt:new Date().toISOString()});
 }else if(request.url!==selector.root)throw Error('Non-root acquisition requires committed discovery output');
 return selector;
}
// Do not project error messages, URLs, response bodies or policy evidence into receipts.
// Sandbox inspection failures and unexpected cache errors remain execution holds.
const acquisitionFailureReasons:Readonly<Record<FetchFailure,ReasonCode>>={
 unsafe_url:'source_policy_refused',robots_blocked:'source_policy_refused',robots_unavailable:'source_policy_refused',
 tdm_reserved:'source_policy_refused',tdm_unavailable:'source_policy_refused',access_barrier:'source_access_barrier',credential_unavailable:'source_access_barrier',
 dns_error:'source_unavailable',timeout:'source_unavailable',network_error:'execution_exception',inspection_failed:'execution_exception',http_error:'source_http_error',
 too_large:'source_limit_exceeded',redirect_limit:'source_redirect_refused',invalid_redirect:'source_redirect_refused',
 cross_host_redirect:'source_redirect_refused',cache_missing:'cas_unavailable',unsupported_encoding:'source_unavailable',
 host_busy:'host_capacity',host_state_unsafe:'source_policy_refused',host_cooldown:'host_delay',
 host_opted_out:'policy_excluded',document_excluded:'policy_excluded',host_admission_deferred:'host_capacity',
};
export function acquisitionFailureReason(error:unknown):ReasonCode|null {
 return error instanceof PoliteFetchError&&Object.hasOwn(acquisitionFailureReasons,error.failure)?acquisitionFailureReasons[error.failure]:null;
}
/** These dispositions follow a settled fetch rejection, unlike executor aborts. */
export function isSettledAcquisitionFailure(reason:ReasonCode):boolean {for(const failure in acquisitionFailureReasons)if(Object.hasOwn(acquisitionFailureReasons,failure)&&acquisitionFailureReasons[failure as FetchFailure]===reason)return true;return false;}
export interface AcquisitionFixture {fetchRoot:string;policy:CivicPolicyOptions;inspection?:FixturePolicyInspection}
/** Shared governed request admission for acquisition and current-policy jobs. */
export async function createR1PublicFetcher(store:DistrictJobStore,context:Parameters<JobHandler>[0],options:{maxRequests:number;maxBytes:number;fixture?:AcquisitionFixture;registry?:DistrictRegistry;registrySha256?:string;onRedirect?:(event:{requestUrl:string;from:string;to:string;status:number})=>void}){
 const fixture=options.fixture;
 if(fixture&&(await assertCivicPolicyAuthority(fixture.policy)).mode!=='isolated-fixture')throw Error('Acquisition fixture requires isolated authority');
 const fetchRoot=fixture?.fetchRoot??R1_FETCH_ROOT,policy=fixture?.policy??{};
 await privateRoot(fetchRoot);await initializeManagedAcquisitionLane(fetchRoot,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'fetch'});
 let requests=0;
 const group=HostGroupsSchema.parse(JSON.parse(await readFile(join(REPO,'sources/district-host-groups.json'),'utf8'))).serviceGroups[0],laneKey=`service:${group.id}`;
 const fetcher=new PoliteFetcher({cacheDir:fetchRoot,minDelayMs:group.minStartIntervalMs,maxBytes:options.maxBytes,ownerPolicyLane:{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID},fixtureInspection:fixture?.inspection,ownerAcquisitionProducer:context.job.spec.step==='acquire_representation'?{jobKey:context.job.jobKey,attempt:context.job.attempt,fencingToken:context.job.fencingToken}:undefined,beforeRequest:async url=>{
  context.signal.throwIfAborted();if(++requests>options.maxRequests)throw new DistrictExecutionHold('source_limit_exceeded');
  if(!['http:','https:'].includes(new URL(url).protocol))throw Error('Non-public acquisition transport');
  const lane=await store.pool.query<{normalized_host:string;shared_service_group:string;max_in_flight:number;min_start_interval_ms:number}>('INSERT INTO district_pipeline.host_lanes(lane_key,normalized_host,shared_service_group,max_in_flight,min_start_interval_ms) VALUES($1,$2,$3,$4,$5) ON CONFLICT(lane_key) DO UPDATE SET lane_key=EXCLUDED.lane_key RETURNING normalized_host,shared_service_group,max_in_flight,min_start_interval_ms',[laneKey,'*',group.id,group.maxInFlight,group.minStartIntervalMs]);
  const configured=lane.rows[0];if(configured.normalized_host!=='*'||configured.shared_service_group!==group.id||configured.max_in_flight!==1||configured.min_start_interval_ms<group.minStartIntervalMs)throw Error('Pinned shared capacity configuration mismatch');
  const timing=await store.pool.query<{paused_reason:string|null;wait_ms:string}>(`SELECT paused_reason,GREATEST(0,CEIL(EXTRACT(EPOCH FROM (GREATEST(next_start_at,retry_after,clock_timestamp())-clock_timestamp()))*1000)) AS wait_ms FROM district_pipeline.host_lanes WHERE lane_key=$1`,[laneKey]);
  if(timing.rowCount!==1)throw Error('Shared capacity lane disappeared');
  if(timing.rows[0].paused_reason!==null)throw new DistrictExecutionHold('host_paused');
  const waitMs=Number(timing.rows[0].wait_ms);
  if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>60000)throw new DistrictExecutionHold('host_delay');
  if(waitMs)await waitBeforeDispatch(waitMs,undefined,{signal:context.signal}).catch(error=>{context.signal.throwIfAborted();throw error;});
  await context.acquireHostLane(laneKey);context.signal.throwIfAborted();
 },onRedirect:options.onRedirect});
 if(options.registry)fetcher.registerRegisteredSources(options.registry,options.registrySha256??semanticHash(options.registry));
 return fetcher;
}
async function completeAcquisitionAdmission(store:DistrictJobStore,context:Parameters<JobHandler>[0],selector:z.infer<typeof AcquisitionSelectorSchema>,contract:string,policy:CivicPolicyOptions,response:FetchedDocument,admitted:{bytes:Buffer;httpObservation:HttpObservationProof},redirectChain:string[],registeredSourceEligibility?:RegisteredRobotsAudit,originalExpiresAt?:string,versions:Record<string,string>={}):ReturnType<JobHandler>{
 const {bytes,httpObservation}=admitted;
 const checkedAt=new Date().toISOString(),expiresAt=originalExpiresAt??(registeredSourcePolicyApplies(response.policy!,response,selector.scope,registeredSourceEligibility)?sourcePolicyExpiresAt(response.policy!,response.checkedAt,response,selector.scope,registeredSourceEligibility):new Date(Date.parse(checkedAt)+PUBLIC_SOURCE_POLICY_VALIDITY_MS).toISOString()),proof=await createPolicyReceipt({source:{url:response.url,sha256:response.sha256,mimeType:response.mimeType},sourcePolicy:response.policy,registeredSourceEligibility,scope:selector.scope,permission:selector.permission,checkedAt,expiresAt},policy);
 const representation=await persistR1Representation(store,context.cas,{bytes,receipt:proof.receipt,request:selector.request,retrievedAt:response.retrievedAt,fetchedAt:response.checkedAt,sourceVersion:selector.sourceVersion,redirectChain,httpObservation:{observationId:httpObservation.observationId,receiptSha256:httpObservation.receiptSha256,bytes:Buffer.from(httpObservation.bytes)}},policy);
 const descriptor=RepresentationDescriptorSchema.parse({version:'district-r1-representation-v1',scope:selector.scope,root:selector.root,snapshotId:representation.snapshotId,policyDecisionId:representation.policyDecisionId,receiptSha256:representation.receiptSha256,sourceArtifact:representation.sourceArtifact,snapshot:representation.snapshot,httpObservation,fetchedAt:response.checkedAt,admittedAt:proof.receipt.checkedAt,redirectChain});
 const artifact=await persistMetadata(store,context.cas,{kind:'acquisition_descriptor',payload:descriptor,sources:[{sha256:response.sha256,url:response.url,policyReceiptSha256:proof.receiptSha256,httpObservation}]},policy);
 return {outcome:'succeeded',reasonCode:'completed',outputs:[representation.sourceArtifact,representation.receiptArtifact,representation.observationArtifact,artifact],versions:{acquisition:contract,...versions},counts:{bytes:bytes.length}};
}

function acquisitionEligibility(registry:DistrictRegistry,registrySha256:string,selector:z.infer<typeof AcquisitionSelectorSchema>){
 return admittedRegisteredRobotsScopes(registry,registrySha256).find(row=>row.municipalityId===selector.scope.municipalityId&&row.sourceId===selector.scope.sourceId&&row.ags===selector.scope.ags&&row.root===selector.root);
}

/** A separate, newly authorized admission job: this handler has no fetcher and
 * cannot retry the already consumed owner-account request. */
export function acquiredRepresentationHandler(store:DistrictJobStore,registry:DistrictRegistry,fixture?:AcquisitionFixture,registrySha256=semanticHash(registry)):JobHandler{return async context=>{
 const selected=AcquiredRepresentationSelectorSchema.parse(context.job.spec.selector),selector=await validateAcquisitionSelector(registry,store,context.cas,selected.acquisition),contract=await acquisitionContract();
 if(context.job.spec.step!=='admit_acquired_representation'||context.job.spec.lane!=='acquisition'||context.job.spec.semanticContractSha256!==contract||semanticHash(context.job.spec.sourceScope)!==semanticHash(selector.scope)||!context.job.spec.inputArtifactHashes.includes(registrySha256))throw Error('Offline acquisition job contract mismatch');
 if(fixture&&(await assertCivicPolicyAuthority(fixture.policy)).mode!=='isolated-fixture')throw Error('Acquisition fixture requires isolated authority');
 context.signal.throwIfAborted();
 const eligibility=acquisitionEligibility(registry,registrySha256,selector),policy=fixture?.policy??{},acquired=await readPriorGenesisOwnerAcquisition(store,fixture?.fetchRoot??R1_FETCH_ROOT,selector,selected.prior,policy,eligibility);
 context.signal.throwIfAborted();
 return completeAcquisitionAdmission(store,context,selector,contract,policy,acquired.response,acquired,acquired.redirectChain,eligibility,acquired.expiresAt,acquired.versions);
};}

export async function enqueueAcquiredRepresentation(store:DistrictJobStore,cas:DistrictCas,registry:DistrictRegistry,registrySha256:string,input:unknown,fixture?:AcquisitionFixture):Promise<string>{
 const selected=AcquiredRepresentationSelectorSchema.parse(input),selector=await validateAcquisitionSelector(registry,store,cas,selected.acquisition);
 if(fixture&&(await assertCivicPolicyAuthority(fixture.policy)).mode!=='isolated-fixture')throw Error('Acquisition fixture requires isolated authority');
 await readPriorGenesisOwnerAcquisition(store,fixture?.fetchRoot??R1_FETCH_ROOT,selector,selected.prior,fixture?.policy??{},acquisitionEligibility(registry,registrySha256,selector));
 return store.enqueue({step:'admit_acquired_representation',lane:'acquisition',semanticContractSha256:await acquisitionContract(),inputArtifactHashes:[registrySha256],sourceScope:selector.scope,selector:selected,policyProofSha256:null});
}

export function acquisitionHandler(store:DistrictJobStore,registry:DistrictRegistry,fixture?:AcquisitionFixture,registrySha256=semanticHash(registry)):JobHandler{return async context=>{
 const selector=await validateAcquisitionSelector(registry,store,context.cas,context.job.spec.selector),contract=await acquisitionContract();
 if(context.job.spec.semanticContractSha256!==contract||semanticHash(context.job.spec.sourceScope)!==semanticHash(selector.scope))throw Error('Acquisition job contract mismatch');
 // A custom root/inspection seam is fixture-only, never a production authority override.
 if(fixture&&(await assertCivicPolicyAuthority(fixture.policy)).mode!=='isolated-fixture')throw Error('Acquisition fixture requires isolated authority');
 const fetchRoot=fixture?.fetchRoot??R1_FETCH_ROOT,policy=fixture?.policy??{};
 const {city,source}=registeredScope(registry,selector.scope,selector.root);await privateRoot(fetchRoot);
 await initializeManagedAcquisitionLane(fetchRoot,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'fetch'});
 const redirectChain=[selector.request.url];
 const fetcher=await createR1PublicFetcher(store,context,{maxRequests:selector.maxRequests,maxBytes:selector.maxBytes,fixture,registry,registrySha256,onRedirect:event=>{if(event.requestUrl===selector.request.url)redirectChain.push(event.to);}});
 const fetchOptions={method:selector.request.method,body:selector.request.body??undefined,publicOperation:selector.request.publicOperation??undefined,ownerRobotsOverride:ownerRobotsOverrideFor(selector.root)??undefined,registeredSourceUrl:selector.root,registeredMunicipalityId:city.id,registeredSourceId:source.id,municipalityName:city.name,machinePolicyUrls:source.knownMachinePolicyUrls};
 if(selector.discovery){
  const {result}=await committedResult(store,context.cas,selector.discovery.stepReceiptSha256,selector.discovery.resultSha256);
  const original=PolicyReceiptSchema.parse(JSON.parse((await context.cas.read(result.policyReceiptSha256)).toString('utf8')));
  fetcher.authorizeRegisteredSourceDiscovery(fetchOptions,{...original.source,policy:original.sourcePolicy},[selector.request.url]);
 }
 let response:FetchedDocument;
 try{response=await fetcher.fetch(selector.request.url,fetchOptions);}
 catch(error){context.signal.throwIfAborted();const reasonCode=acquisitionFailureReason(error);if(reasonCode===null||reasonCode==='execution_exception')throw error;return {outcome:'held_execution',reasonCode,versions:{acquisition:contract}};}
 context.signal.throwIfAborted();
 const {bytes,httpObservation}=response.policy?.access==='authenticated_owner_account'?await readGenesisOwnerRepresentation(fetchRoot,response,policy,selector.maxBytes):{bytes:await readFetchedBytes(fetchRoot,response.localPath,response.sha256,selector.maxBytes),httpObservation:await readHttpObservation(response,fetchRoot,policy)};
 const registeredSourceEligibility=fetcher.registeredSourceEligibility({registeredMunicipalityId:selector.scope.municipalityId,registeredSourceId:selector.scope.sourceId,registeredSourceUrl:selector.root});
 return completeAcquisitionAdmission(store,context,selector,contract,policy,response,{bytes,httpObservation},redirectChain,registeredSourceEligibility);
};}
export async function loadDescriptor(store:DistrictJobStore,cas:DistrictCas,hash:string,policy:CivicPolicyOptions={}){
 HashSchema.parse(hash);await assertManagedSourceReadable(join(cas.root,'sha256',hash.slice(0,2),hash),policy);const bytes=await cas.read(hash),descriptor=RepresentationDescriptorSchema.parse(JSON.parse(bytes.toString('utf8')));
 const audit=await store.pool.query<{sha256:string;payload_json:unknown}>(`SELECT sha256,payload_json FROM district_pipeline.r1_metadata_snapshots WHERE kind='acquisition_descriptor' AND payload_json->'artifact'->>'sha256'=$1 LIMIT 2`,[hash]);
 if(audit.rowCount!==1||semanticHash(audit.rows[0].payload_json)!==audit.rows[0].sha256)throw Error('Canonical acquisition descriptor audit binding mismatch');
 const safe=R1ArtifactAuditSchema.parse(audit.rows[0].payload_json);
 if(safe.kind!=='acquisition_descriptor'||safe.artifact.sha256!==hash||safe.artifact.byteLength!==bytes.length||!safe.sources.some(source=>source.policyReceiptSha256===descriptor.receiptSha256&&canonicalJson(source.binding)===canonicalJson(authenticatedHttpBinding(descriptor.httpObservation,{url:descriptor.snapshot.url,sha256:descriptor.snapshot.sourceSha256}))))throw Error('Acquisition artifact does not match its content-free audit');
 const committed=await store.pool.query(`SELECT id FROM district_pipeline.step_receipts WHERE receipt->>'step' IN ('acquire_representation','admit_acquired_representation') AND outcome='succeeded' AND receipt->'outputHashes' @> $1::jsonb`,[JSON.stringify([hash])]);
 if(!committed.rowCount)throw Error('Representation descriptor is not a committed acquisition output');
 // The source snapshot retains its first-seen retrieval clock. Each subsequent
 // representation is clock-bound by its own immutable HTTP observation above.
 const rows=await store.pool.query(`SELECT r.id FROM district_pipeline.representations r JOIN district_pipeline.policy_decisions p ON p.id=r.policy_decision_id JOIN district_pipeline.source_snapshots s ON s.id=r.source_snapshot_id WHERE r.source_snapshot_id=$1 AND r.policy_decision_id=$2 AND r.artifact_sha256=$3 AND p.proof_sha256=$4 AND r.admission='admitted' AND p.state='allowed' AND r.fetched_at=$5 AND r.admitted_at=$6 AND s.scope_sha256=$7`,[descriptor.snapshotId,descriptor.policyDecisionId,descriptor.snapshot.sourceSha256,descriptor.receiptSha256,descriptor.fetchedAt,descriptor.admittedAt,semanticHash(descriptor.scope)]);
 if(rows.rowCount!==1)throw Error('Descriptor lacks actual persisted representation');
 const proof=PolicyReceiptSchema.parse(JSON.parse((await cas.read(descriptor.receiptSha256)).toString('utf8')));
 if(semanticHash(proof)!==descriptor.receiptSha256||semanticHash(proof.scope)!==semanticHash(descriptor.scope)||proof.source.sha256!==descriptor.snapshot.sourceSha256||proof.source.url!==descriptor.snapshot.url)throw Error('Descriptor policy mismatch');
 await recheckPolicyReceipt(proof,{...policy,evaluationAt:new Date().toISOString()});await cas.verify(descriptor.snapshot.sourceSha256);return descriptor;
}
async function stdinJson(){let bytes=0;const chunks:Buffer[]=[];for await(const chunk of process.stdin){const value=Buffer.from(chunk);bytes+=value.length;if(bytes>4*1024*1024)throw Error('Operator manifest too large');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}

async function exportRun(store:DistrictJobStore,cas:DistrictCas,registry:DistrictRegistry,input:unknown){
 const selection=z.object({runIds:z.array(z.uuid()).min(1).max(1000)}).strict().parse(input);
 const rows=await store.pool.query<{receipt_sha256:string;receipt:unknown;spec:DistrictJobSpec}>(`SELECT r.receipt_sha256,r.receipt,j.spec FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id WHERE r.run_id=ANY($1::uuid[]) AND r.receipt->>'step' IN ('structured_parse','structured_discover') ORDER BY r.committed_at,r.receipt_sha256`,[selection.runIds]);
 if(!rows.rowCount)throw Error('No committed structured outputs in selected runs');
 const groups=new Map<string,{result:StructuredJobResult;pages:{result:StructuredJobResult;receipt:StepReceipt;hash:string}[]}>();
 const technical:StructuredCoverageReceipt[]=[];
 for(const row of rows.rows){
  const receipt=StepReceiptSchema.parse(row.receipt);
  if(!receipt.outputHashes.length){
   const selector=z.object({worker:StructuredWorkerRequestSchema}).passthrough().parse(row.spec.selector),worker=selector.worker;
   if(receipt.outcome==='succeeded'||semanticHash(worker.scope)!==semanticHash(row.spec.sourceScope)||receipt.policyProofSha256!==worker.snapshot.policyReceiptSha256)throw Error('Technical receipt job binding mismatch');
   const source=await sourceHttpReference(store,cas,{url:worker.snapshot.url,sha256:worker.snapshot.sourceSha256,policyReceiptSha256:worker.snapshot.policyReceiptSha256});
   await exportStepReceipt(store,cas,row.receipt_sha256,{url:source.url,sha256:source.sha256,policyReceiptSha256:source.policyReceiptSha256,binding:httpObservationBinding(source)});
   const state=structuredCoverageStateForNoOutput(receipt.outcome);
   technical.push({family:worker.adapter,operation:worker.operation,adapterId:worker.adapter,adapterVersion:null,municipalityId:worker.scope.municipalityId,sourceId:worker.scope.sourceId,scopeSha256:semanticHash(worker.scope),sourceSha256:worker.snapshot.sourceSha256,policyReceiptSha256:worker.snapshot.policyReceiptSha256,stepReceiptSha256:row.receipt_sha256,additionalStepReceiptSha256s:[],coverage:{state,scope:canonicalJson(worker.scope),reason:`Actual committed ${receipt.outcome}: ${receipt.reasonCode}; no parser output was committed.`,checkedAt:state==='not_checked'?null:receipt.finishedAt,nextCursor:null,observedRows:0,limitations:['Technical execution disposition, not operational adapter or source-completeness evidence.']}});
   continue;
  }
  if(receipt.outputHashes.length!==1)throw Error('Unexpected structured output count');
  const {result}=await committedResult(store,cas,row.receipt_sha256,receipt.outputHashes[0]);
  const proof=PolicyReceiptSchema.parse(JSON.parse((await cas.read(result.policyReceiptSha256)).toString('utf8')));
  await recheckPolicyReceipt(proof,{evaluationAt:new Date().toISOString()});
  const source=await sourceHttpReference(store,cas,{url:proof.source.url,sha256:result.sourceSha256,policyReceiptSha256:result.policyReceiptSha256});
  await exportStepReceipt(store,cas,row.receipt_sha256,{url:source.url,sha256:source.sha256,policyReceiptSha256:source.policyReceiptSha256,binding:httpObservationBinding(source)});
  const key=semanticHash({adapter:result.adapterId,version:result.adapterVersion,scope:result.scope,source:result.sourceSha256,policy:result.policyReceiptSha256,operation:receipt.step});
  let group=groups.get(key);if(!group){group={result,pages:[]};groups.set(key,group);}
  group.pages.push({result,receipt,hash:row.receipt_sha256});
 }
 const coverage:StructuredCoverageReceipt[]=[...technical],records=new Map<string,StructuredJobResult['records'][number]>(),contracts=new Set<string>(),updated=structuredClone(registry);
 for(const group of groups.values()){
  const result=group.result,pages=group.pages.sort((a,b)=>(a.result.page?.offset??0)-(b.result.page?.offset??0)||a.hash.localeCompare(b.hash));
  let observed=result.result.coverage;
  if(result.page){
   const original=result.page.sourceCoverage;let end=0,complete=true;
   for(const page of pages){const meta=page.result.page;if(!meta||meta.offset!==end||meta.total!==result.page.total||meta.bindingSha256!==result.page.bindingSha256||canonicalJson(meta.sourceCoverage)!==canonicalJson(original)){complete=false;break;}end=meta.end;}
   if(complete&&end===result.page.total&&pages.at(-1)?.result.page?.nextCursor===null)observed=original;
   else observed={...original,state:'partial',nextCursor:pages.at(-1)?.result.page?.nextCursor??null};
  }
  const city=updated.municipalities.find(row=>row.id===result.scope.municipalityId),source=city?.sources.find(row=>row.id===result.scope.sourceId);
  if(!city||city.ags!==result.scope.ags||!source||!source.url)throw Error('Export source no longer registered');
  const hasRecords=pages.some(page=>page.result.records.length>0);
  if(hasRecords&&!['complete','partial'].includes(observed.state))throw Error('Records cannot claim technical coverage');
  if(['complete','partial','empty'].includes(observed.state)){
   source.checkState='checked';source.checkedAt=observed.checkedAt;
   source.evidence.push({url:source.url,locator:`Actual committed R1 ${result.adapterId} parser receipts: ${pages.map(page=>page.hash).join(', ')}`,sha256:result.sourceSha256,retrievedAt:observed.checkedAt??undefined});
   source.reason='Exact source acquired and parsed; completeness is stated only by the bound structured coverage receipt.';
  }
  coverage.push({family:result.adapterId,operation:pages[0].receipt.step==='structured_parse'?'parse':'discover',adapterId:result.adapterId,adapterVersion:result.adapterVersion,municipalityId:result.scope.municipalityId,sourceId:result.scope.sourceId,scopeSha256:semanticHash(result.scope),sourceSha256:result.sourceSha256,policyReceiptSha256:result.policyReceiptSha256,stepReceiptSha256:pages[0].hash,additionalStepReceiptSha256s:pages.slice(1).map(page=>page.hash),coverage:observed});
  for(const page of pages){contracts.add(page.result.adapterContractSha256);for(const record of page.result.records){const previous=records.get(record.id);if(previous&&canonicalJson(previous)!==canonicalJson(record))throw Error('Conflicting committed record identity');records.set(record.id,record);}}
 }
 const checked=districtRegistrySchema.parse(updated),registryBytes=Buffer.from(canonicalJson(checked)+'\n');
 const run=structuredRunSchema.parse({schemaVersion:'district-structured-run-v1',generatedAt:new Date().toISOString(),registrySha256:digest(registryBytes),questionDispositionSha256:digest(await readFile(join(REPO,'reports/pilot-question-source-disposition.json'))),adapterContractSha256:semanticHash([...contracts].sort()),records:[...records.values()].sort((a,b)=>a.id.localeCompare(b.id)),coverage});
 await verifyStructuredRunReceipts(run,cas,{evaluationAt:new Date().toISOString()});
 const references=new Map<string,HttpSourceAuditReference>();
 for(const row of run.coverage)if(row.sourceSha256&&row.policyReceiptSha256){
  const proof=PolicyReceiptSchema.parse(JSON.parse((await cas.read(row.policyReceiptSha256)).toString('utf8')));
  references.set(`${row.sourceSha256}:${row.policyReceiptSha256}`,await sourceHttpReference(store,cas,{sha256:row.sourceSha256,url:proof.source.url,policyReceiptSha256:row.policyReceiptSha256}));
 }
 for(const group of groups.values())for(const page of group.pages)for(const source of page.result.supportingSources)references.set(`${source.sha256}:${source.policyReceiptSha256}`,await sourceHttpReference(store,cas,source));
 const sources=[...references.values()];
 const runArtifact=await persistMetadata(store,cas,{kind:'structured_run',payload:run,sources});
 const recordsArtifact=await persistMetadata(store,cas,{kind:'records',payload:run.records,sources});
 const coverageArtifact=await persistMetadata(store,cas,{kind:'coverage',payload:run.coverage,sources});
 await writeOperator('registry.json',checked);
 const acquisitionDescriptors:AcquisitionDescriptorPin[]=[];
 for(const source of sources){await cas.verify(source.descriptorSha256);acquisitionDescriptors.push(AcquisitionDescriptorPinSchema.parse({sha256:source.descriptorSha256,path:join(cas.root,'sha256',source.descriptorSha256.slice(0,2),source.descriptorSha256)}));}
 process.stdout.write(canonicalJson({records:run.records.length,coverage:run.coverage.length,nativeFieldHolds:structuredHoldSummary([...groups.values()].flatMap(group=>group.pages.map(page=>page.result))),registrySha256:run.registrySha256,structuredRunSha256:runArtifact.sha256,acquisitionDescriptors,artifacts:{structuredRun:{...runArtifact,path:join(cas.root,runArtifact.storageKey)},records:{...recordsArtifact,path:join(cas.root,recordsArtifact.storageKey)},coverage:{...coverageArtifact,path:join(cas.root,coverageArtifact.storageKey)}}})+'\n');
}

export async function districtR1Cli(argv=process.argv.slice(2)){
 const [command,...rawArgs]=argv;
 if(command==='registry-descriptor'){
  if(rawArgs.length!==4||rawArgs[0]!=='--commit'||rawArgs[2]!=='--output'||!rawArgs[1]||!rawArgs[3])throw Error('registry-descriptor requires exactly --commit <oid> --output <dir>');
  const output=resolve(rawArgs[3]),root=resolve(OPERATOR_ROOT),part=relative(root,output);
  if(part===''||part==='..'||part.startsWith(`..${process.platform==='win32'?'\\\\':'/'}`)||isAbsolute(part))throw Error('Registry descriptor output must be a new directory under the R1 operator cache');
  await mkdir(root,{recursive:true,mode:0o700});
  try{await lstat(output);throw Error('Registry descriptor output directory already exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const built=await buildOperatorRegistryConfigDescriptor({repository:REPO,commit:rawArgs[1],outputDirectory:output});
  process.stdout.write(canonicalJson({descriptorPath:built.descriptorPath,descriptorSha256:built.descriptorSha256,configurationSha256:built.descriptor.sha256,gitCommit:built.descriptor.code.gitCommit})+'\n');return;
 }
 if(command==='migrate'){
  if(rawArgs.length)throw Error('Migration accepts no registry or execution arguments');
  if(!process.env.DATABASE_URL)throw Error('Database configuration required');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4,connectionTimeoutMillis:5000,statement_timeout:10000});
  try{await migrateDistrictJobs(pool);}finally{await pool.end();}return;
 }
 const {registryPin,args}=parseR1RegistryArguments(rawArgs),admitted=await readOperatorRegistryInputPin(registryPin,{}),registry=admitted.registry,registrySha256=digest(admitted.bytes);
 if(command==='run'){
  if(!process.env.DATABASE_URL)throw Error('Database configuration required');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4,connectionTimeoutMillis:5000,statement_timeout:10000});
  try{
   await persistOperatorRegistry(new DistrictJobStore(pool),new DistrictCas(CAS_ROOT),admitted);
   const authorizationIndex=args.indexOf('--authorization-id'),authorizationId=z.uuid().parse(args[authorizationIndex+1]);
   if(authorizationIndex<0)throw Error('Explicit authorization required');
   const authorization=await pool.query<{has_b:boolean;only_b:boolean}>(`SELECT BOOL_OR(j.step='assessment_b') AS has_b,BOOL_AND(j.step='assessment_b') AS only_b FROM district_pipeline.preauthorizations a JOIN district_pipeline.jobs j ON j.job_key=ANY(a.allowed_job_keys) WHERE a.id=$1`,[authorizationId]);
   if(authorization.rows[0]?.has_b&&!authorization.rows[0]?.only_b)throw new DistrictExecutionHold('authorization_mode_mismatch');
   const refreshStore=new DistrictJobStore(pool),refresh=policyRefreshHandler(refreshStore,(context,maxRequests)=>createR1PublicFetcher(refreshStore,context,{maxRequests,maxBytes:1024*1024,registry,registrySha256}));
   await runDistrictJobsCli({...structuredJobHandlers,...residualJobHandlersFor(pool),...assessmentQueueHandlers(pool),policy_refresh:refresh,acquire_representation:acquisitionHandler(new DistrictJobStore(pool),registry,undefined,registrySha256),admit_acquired_representation:acquiredRepresentationHandler(new DistrictJobStore(pool),registry,undefined,registrySha256)},['run',...args,'--cas-root',CAS_ROOT],pipelineNotificationConfig);
  }finally{await pool.end();}return;
 }
 if(args.length)throw Error('R1 commands require only explicit registry configuration flags and bounded JSON stdin');
 if(command==='catalog'){
  const catalogBytes=await readFile(join(REPO,'sources/civic-source-catalog.csv'));
  if(digest(catalogBytes)!=='c19460dddf97c1e4ac2ef85d5bb34a9feff9482af2e8399d06c5b20001d05e40')throw Error('Catalog differs from explicit initial-plan control approval');
  const proposal=registerStructuredCatalog(registry,catalogBytes),date=new Date().toISOString().slice(0,10);
  parseOperatorRegistryConfiguration(proposal.registry);
  await writeOperator(`registry-proposal-${date}.json`,proposal.registry);await writeOperator(`catalog-routes-proposal-${date}.json`,proposal.routes);
  process.stdout.write(canonicalJson({state:'proposal_not_admitted',inputRegistrySha256:registrySha256,catalogSha256:proposal.catalogSha256,routes:proposal.routes.length,requires:'separate_shared_registry_config_admission'})+'\n');return;
 }
 if(!process.env.DATABASE_URL)throw Error('Database configuration required');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4,connectionTimeoutMillis:5000,statement_timeout:10000}),store=new DistrictJobStore(pool),cas=new DistrictCas(CAS_ROOT);
 try{
  await persistOperatorRegistry(store,cas,admitted);
  const input=await stdinJson();
  if(command==='import-crawl-corpus'){
   const manifest=CrawlCorpusImportSchema.parse(input);
   if(canonicalJson(manifest.registry)!==canonicalJson(registryPin))throw Error('Crawl import descriptor must match admitted CLI registry pin');
   process.stdout.write(canonicalJson(await importCrawlCorpusForResidual(store,cas,manifest))+'\n');return;
  }
  if(command==='enqueue-policy-refresh'){
   const manifest=CrawlPolicyRefreshEnqueueSchema.parse(input);
   if(canonicalJson(manifest.manifest.registry)!==canonicalJson(registryPin))throw Error('Refresh descriptor must match admitted CLI registry pin');
   process.stdout.write(canonicalJson(await enqueueCrawlPolicyRefresh(store,cas,manifest))+'\n');return;
  }
  if(command==='seal-text-contribution'){
   const manifest=QueueTextSealInputSchema.parse(input);
   for(const jobKey of manifest.jobKeys){
    const row=await pool.query<{selector:unknown}>('SELECT spec->\'selector\' AS selector FROM district_pipeline.jobs WHERE job_key=$1',[jobKey]);
    if(row.rowCount!==1)throw Error('Queue seal extraction selector unavailable');
    const selected=ResidualInputSchema.strip().parse(row.rows[0].selector);
    if(selected.registrySha256!==registrySha256||canonicalJson(selected.registry)!==canonicalJson(registryPin))throw Error('Queue seal descriptor must match admitted CLI registry');
   }
   process.stdout.write(canonicalJson(await sealQueueTextContribution(pool,cas,manifest))+'\n');return;
  }
  if(command==='export-text-contribution'){
   const manifest=z.object({jobKeys:z.array(HashSchema).min(1).max(10000),compositionArtifactSha256:HashSchema}).strict().parse(input),compositionPath=join(cas.root,'sha256',manifest.compositionArtifactSha256.slice(0,2),manifest.compositionArtifactSha256);
   await assertManagedSourceReadable(compositionPath);
   const serialized=r1TextCompositionInputSchema.parse(JSON.parse((await cas.read(manifest.compositionArtifactSha256)).toString('utf8')));
   if(serialized.contributions.length!==1||serialized.contributions[0].sourceArtifactKind!=='native_extraction_output')throw Error('Residual export requires one genuine sealed native contribution');
   const composition=await loadR1TextCompositionInput(serialized,async pin=>{
    const actualPath=join(cas.root,'sha256',pin.sha256.slice(0,2),pin.sha256);
    if(pin.path!==actualPath)throw Error('Text contribution artifact must use fixed managed CAS hash path');
    await assertManagedSourceReadable(actualPath);return cas.read(pin.sha256);
   });
   const exported=await exportResidualTextContribution(pool,cas,manifest.jobKeys,composition.contributions[0]),stepReceiptSha256s:string[]=[];
   const context=buildR1TextCompositionContext(composition),native=KnowledgeRecordsSchema.parse(readTextLineageArtifact(exported.contribution.artifacts.records));
   if(exported.contribution.pins.registrySha256!==registrySha256||canonicalJson(context.knowledge.records)!==canonicalJson(native.records)||canonicalJson(serialized.approvedRunOrder)!==canonicalJson([exported.contribution.runId])||serialized.generatedAt!==native.generatedAt)throw Error('Residual export composition rewrites its sealed admissions');
   for(let index=0;index<exported.stepReceipts.length;index++){
    const receipt=exported.stepReceipts[index],result=exported.results[index],policy=PolicyReceiptSchema.parse(JSON.parse((await cas.read(result.policyReceiptSha256)).toString('utf8')));
    const selectorRow=await pool.query<{selector:unknown}>('SELECT spec->\'selector\' AS selector FROM district_pipeline.jobs WHERE job_key=$1',[receipt.jobKey]);
    if(selectorRow.rowCount!==1)throw Error('Residual contribution source selector missing');
    const residual=ResidualInputSchema.passthrough().parse(selectorRow.rows[0].selector),httpObservation=HttpObservationProofSchema.parse({...residual.httpObservation,bytes:(await cas.read(residual.httpObservation.receiptSha256)).toString('utf8')}),reference={url:policy.source.url,sha256:result.result.sourceSha256,policyReceiptSha256:result.policyReceiptSha256,httpObservation};
    const source={url:reference.url,sha256:reference.sha256,policyReceiptSha256:reference.policyReceiptSha256,binding:httpObservationBinding(reference)};
    const hash=semanticHash(receipt);await exportStepReceipt(store,cas,hash,source);await exportStepReceipt(store,cas,result.preparationReceiptSha256,source);stepReceiptSha256s.push(hash);
   }
   process.stdout.write(canonicalJson({compositionArtifactSha256:manifest.compositionArtifactSha256,path:compositionPath,runId:exported.contribution.runId,stepReceiptSha256s,committedDocuments:exported.results.length,records:context.knowledge.records.length,heldRecords:context.composition.quarantine.cases.filter(entry=>entry.candidate!==undefined).length})+'\n');return;
  }
  if(command==='enqueue-residual-preparation'){
   const manifest=z.object({jobs:z.array(ResidualInputSchema).min(1).max(10000)}).strict().parse(input),jobKeys:string[]=[];
   for(const job of manifest.jobs){if(job.registrySha256!==registrySha256||canonicalJson(job.registry)!==canonicalJson(registryPin))throw Error('Residual preparation registry descriptor does not match admitted CLI configuration');jobKeys.push(await enqueueResidualPreparation(store,cas,job));}
   process.stdout.write(canonicalJson({jobKeys})+'\n');return;
  }
  if(command==='enqueue-residual-extraction'){
   const manifest=z.object({preparationJobKeys:z.array(HashSchema).min(1).max(10000)}).strict().parse(input),jobKeys:string[]=[];
   for(const preparationJobKey of manifest.preparationJobKeys)jobKeys.push(await enqueueCommittedResidualExtraction(pool,store,cas,preparationJobKey));
   process.stdout.write(canonicalJson({jobKeys})+'\n');return;
  }
  if(command==='assessment-results'){
   const manifest=z.object({jobKeys:z.array(HashSchema).min(1).max(10000)}).strict().parse(input);
   process.stdout.write(canonicalJson(await exportAssessmentResults(pool,cas,manifest.jobKeys))+'\n');return;
  }
  if(command==='enqueue-assessment-items'){
   const manifest=z.object({extractionJobKeys:z.array(HashSchema).min(1).max(10000)}).strict().parse(input),jobKeys:string[]=[];
   for(const key of manifest.extractionJobKeys)jobKeys.push(await enqueueResidualAssessmentItems(pool,store,cas,key));
   process.stdout.write(canonicalJson({jobKeys})+'\n');return;
  }
  if(command==='enqueue-assessment-a'||command==='enqueue-prepared-assessment-b'){
   const manifest=z.object({preparationJobKeys:z.array(HashSchema).min(1).max(10000)}).strict().parse(input),jobKeys:string[]=[],broker=new DistrictAssessmentBroker(pool,cas);
   for(const key of manifest.preparationJobKeys)jobKeys.push(...await enqueuePreparedAssessmentPass(pool,store,cas,key,command==='enqueue-assessment-a'?'A':'B',broker));
   process.stdout.write(canonicalJson({jobKeys})+'\n');return;
  }
  if(command==='enqueue-assessment-c'||command==='enqueue-assessment-reconciliation'){
   const job=z.object({AJobKey:HashSchema,BJobKey:HashSchema,CJobKey:HashSchema.optional()}).strict(),manifest=z.object({jobs:z.array(job).min(1).max(10000)}).strict().parse(input),jobKeys:string[]=[];
   for(const selected of manifest.jobs)jobKeys.push(await enqueueAssessmentResolution(pool,store,cas,selected,command==='enqueue-assessment-c'?'C':'reconcile'));
   process.stdout.write(canonicalJson({jobKeys})+'\n');return;
  }
  if(command==='enqueue-assessment-b'){
   if(process.platform!=='linux')throw new DistrictExecutionHold('isolation_unavailable');
   const manifest=AssessmentBEnqueueManifestSchema.parse(input),broker=new DistrictAssessmentBroker(pool,cas),jobKeys:string[]=[];
   for(const job of manifest.jobs){
    await assertManagedSourceReadable(join(cas.root,'sha256',job.itemArtifactSha256.slice(0,2),job.itemArtifactSha256));
    const item=assessmentItemSchema.parse(JSON.parse((await cas.read(job.itemArtifactSha256)).toString('utf8')));
    if(semanticHash(item)!==job.itemArtifactSha256||!item.sources.some(source=>source.admissionReceiptSha256===job.policyProofSha256))throw Error('Assessment item primary policy binding mismatch');
    const proof=PolicyReceiptSchema.parse(JSON.parse((await cas.read(job.policyProofSha256)).toString('utf8')));
    if(semanticHash(proof.scope)!==semanticHash(job.sourceScope))throw Error('Assessment item registered scope mismatch');
    registeredScope(registry,job.sourceScope,registry.municipalities.find(city=>city.id===job.sourceScope.municipalityId)?.sources.find(source=>source.id===job.sourceScope.sourceId)?.url??'');
    for(const hash of assessmentEvidenceArtifactHashes(item))await assertManagedSourceReadable(join(cas.root,'sha256',hash.slice(0,2),hash));
    jobKeys.push(await enqueueAssessmentB(broker,job));
   }
   process.stdout.write(canonicalJson({jobKeys})+'\n');return;
  }
  if(command==='results'){
   const selection=z.object({runIds:z.array(z.uuid()).min(1).max(1000)}).strict().parse(input);
   const rows=await pool.query<{receipt_sha256:string;receipt:unknown}>(`SELECT receipt_sha256,receipt FROM district_pipeline.step_receipts WHERE run_id=ANY($1::uuid[]) AND receipt->>'step' IN ('structured_parse','structured_discover') ORDER BY committed_at`,[selection.runIds]);
   for(const row of rows.rows){const receipt=StepReceiptSchema.parse(row.receipt);
    if(!receipt.outputHashes.length){process.stdout.write(canonicalJson({stepReceiptSha256:row.receipt_sha256,outcome:receipt.outcome,reasonCode:receipt.reasonCode,resultSha256:null})+'\n');continue;}
    if(receipt.outputHashes.length!==1)throw Error('Unexpected structured output count');
    const resultSha256=receipt.outputHashes[0],{result}=await committedResult(store,cas,row.receipt_sha256,resultSha256),proof=PolicyReceiptSchema.parse(JSON.parse((await cas.read(result.policyReceiptSha256)).toString('utf8')));
    await recheckPolicyReceipt(proof,{evaluationAt:new Date().toISOString()});
    const coverage=result.result.coverage,page=result.page,source=await sourceHttpReference(store,cas,{sha256:result.sourceSha256,url:proof.source.url,policyReceiptSha256:result.policyReceiptSha256});
    process.stdout.write(canonicalJson({stepReceiptSha256:row.receipt_sha256,resultSha256,scope:result.scope,sourceSha256:result.sourceSha256,policyReceiptSha256:result.policyReceiptSha256,httpObservation:{observationId:source.httpObservation.observationId,receiptSha256:source.httpObservation.receiptSha256},operation:receipt.step,nativeFieldHolds:structuredHoldSummary([result]),coverage:{state:coverage.state,scopeSha256:semanticHash(result.scope),checkedAt:coverage.checkedAt,nextCursor:coverage.nextCursor,observedRows:coverage.observedRows},page:page?{offset:page.offset,end:page.end,total:page.total,nextCursor:page.nextCursor,bindingSha256:page.bindingSha256,sourceCoverage:{state:page.sourceCoverage.state,checkedAt:page.sourceCoverage.checkedAt,nextCursor:page.sourceCoverage.nextCursor,observedRows:page.sourceCoverage.observedRows}}:null,resources:'resources' in result.result?result.result.resources:[]})+'\n');
   }return;
  }
  if(command==='representations'){
   const selection=z.object({runIds:z.array(z.uuid()).min(1).max(1000)}).strict().parse(input);
   const rows=await pool.query<{receipt:unknown}>(`SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=ANY($1::uuid[]) AND receipt->>'step' IN ('acquire_representation','admit_acquired_representation') AND outcome='succeeded' ORDER BY committed_at`,[selection.runIds]);
   const representations:{representationSha256:string;snapshotId:string;sourceSha256:string;policyReceiptSha256:string;scope:AdapterScope;httpObservation:{observationId:string;receiptSha256:string}}[]=[];
   for(const row of rows.rows){const receipt=StepReceiptSchema.parse(row.receipt);for(const hash of receipt.outputHashes){
    const artifact=await pool.query<{kind:string}>('SELECT kind FROM district_pipeline.artifacts WHERE sha256=$1',[hash]);
    if(artifact.rows[0]?.kind!=='derived')continue;
    const descriptor=await loadDescriptor(store,cas,hash);
    representations.push({representationSha256:hash,snapshotId:descriptor.snapshotId,sourceSha256:descriptor.snapshot.sourceSha256,policyReceiptSha256:descriptor.receiptSha256,scope:descriptor.scope,httpObservation:{observationId:descriptor.httpObservation.observationId,receiptSha256:descriptor.httpObservation.receiptSha256}});
   }}
   process.stdout.write(canonicalJson({representations})+'\n');return;
  }
  if(command==='enqueue-acquired-representation'){
   const manifest=z.object({jobs:z.array(AcquiredRepresentationSelectorSchema).min(1).max(100)}).strict().parse(input),jobKeys:string[]=[];
   for(const item of manifest.jobs)jobKeys.push(await enqueueAcquiredRepresentation(store,cas,registry,registrySha256,item));
   process.stdout.write(canonicalJson({jobKeys})+'\n');return;
  }
  if(command==='enqueue-acquisition'){
   const manifest=z.object({jobs:z.array(AcquisitionSelectorSchema).min(1).max(10000)}).strict().parse(input),jobKeys:string[]=[];
   for(const item of manifest.jobs){const selector=await validateAcquisitionSelector(registry,store,cas,item),discovery=selector.discovery;
    const spec:DistrictJobSpec={step:'acquire_representation',lane:'acquisition',semanticContractSha256:await acquisitionContract(),inputArtifactHashes:discovery?[discovery.resultSha256]:[],sourceScope:selector.scope,selector,policyProofSha256:null};
    jobKeys.push(await store.enqueue(spec));
   }process.stdout.write(canonicalJson({jobKeys})+'\n');return;
  }
  if(command==='enqueue-structured'){
   const manifest=z.object({jobs:z.array(z.object({representationSha256:HashSchema,adapter:StructuredWorkerRequestSchema.shape.adapter,operation:z.enum(['parse','discover']),options:z.record(z.string(),z.unknown()),cursor:z.string().nullable(),auxiliary:z.array(z.object({slot:z.enum(['municipalBoundaries','stationSnapshot']),representationSha256:HashSchema}).strict()).max(2)}).strict()).min(1).max(10000)}).strict().parse(input),jobKeys:string[]=[];
   for(const item of manifest.jobs){const descriptor=await loadDescriptor(store,cas,item.representationSha256),{city}=registeredScope(registry,descriptor.scope,descriptor.root),auxiliary:StructuredWorkerRequest['auxiliary']=[],supportingSources:StructuredSupportingSource[]=[],sourceBindings:ManagedSourceBinding[]=[httpObservationBinding({sha256:descriptor.snapshot.sourceSha256,url:descriptor.snapshot.url,policyReceiptSha256:descriptor.receiptSha256,httpObservation:descriptor.httpObservation})];
    for(const support of item.auxiliary){const accepted=await loadDescriptor(store,cas,support.representationSha256);registeredScope(registry,accepted.scope,accepted.root);if(accepted.scope.municipalityId!==city.id||accepted.scope.ags!==city.ags)throw Error('Supporting municipality mismatch');auxiliary.push({slot:support.slot,snapshot:accepted.snapshot});supportingSources.push({id:accepted.scope.sourceId,url:accepted.snapshot.url,sha256:accepted.snapshot.sourceSha256,mimeType:accepted.snapshot.mimeType,retrievedAt:accepted.snapshot.retrievedAt,policyReceiptSha256:accepted.receiptSha256,scopeSha256:semanticHash(accepted.scope),role:support.slot==='municipalBoundaries'?'municipality_join':'source_metadata'});sourceBindings.push(httpObservationBinding({sha256:accepted.snapshot.sourceSha256,url:accepted.snapshot.url,policyReceiptSha256:accepted.receiptSha256,httpObservation:accepted.httpObservation}));}
    jobKeys.push((await enqueueStructuredSnapshot(store,cas,{adapter:item.adapter,operation:item.operation,registry:registryPin,registrySha256,scope:descriptor.scope,districtId:city.districtId,snapshot:descriptor.snapshot,options:item.options,cursor:item.cursor,auxiliary,supportingSources,sourceBindings})).jobKey);
   }process.stdout.write(canonicalJson({jobKeys})+'\n');return;
  }
  if(command==='authorize'){
   const approval=z.object({approvalSha256:HashSchema,approvedBy:z.string().min(1),expiresAt:z.iso.datetime(),jobKeys:z.array(HashSchema).min(1),ags:z.array(z.string().regex(/^\d{8}$/)).min(1),maxJobs:z.number().int().positive(),maxElapsedMs:z.number().int().positive(),category:z.enum(['production','evaluation','development']),mode:z.enum(['attended','bounded_unattended'])}).strict().parse(input);
   const steps=await pool.query<{step:string}>('SELECT step FROM district_pipeline.jobs WHERE job_key=ANY($1::text[])',[approval.jobKeys]);
   if(steps.rows.some(job=>job.step==='assessment_b')&&steps.rows.some(job=>job.step!=='assessment_b'))throw new DistrictExecutionHold('authorization_mode_mismatch');
   const id=await store.authorize({...approval,...(approval.mode==='bounded_unattended'?{notificationApprovalSha256:pipelineNotificationConfig.notificationApprovalSha256,notificationDestinationSha256:pipelineNotificationConfig.destinationSha256,notificationProvider:pipelineNotificationConfig.provider}:{})});process.stdout.write(canonicalJson({authorizationId:id})+'\n');return;
  }
  if(command==='export'){await exportRun(store,cas,registry,input);return;}
  throw Error('Unknown R1 command');
 }finally{await pool.end();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)districtR1Cli().catch(error=>{process.stderr.write((error instanceof DistrictExecutionHold?error.reasonCode:'R1 command failed; inspect private configuration and committed state.')+'\n');process.exitCode=2;});
