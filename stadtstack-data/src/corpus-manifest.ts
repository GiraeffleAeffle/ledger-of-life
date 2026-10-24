import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,realpath,lstat} from 'node:fs/promises';
import {dirname,join,relative,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {crawlDocumentSchema,excludedCrawlDocumentSchema} from './district-corpus.ts';
import {districtRegistrySchema,type DistrictRegistry} from './district-registry.ts';
import {preparationPlanSchema,type PreparationGroup} from './district-preparation-run.ts';
import {WorkPlanSchema,type WorkPlan,type WorkTask} from './district-work-plan.ts';
import {checkResult} from './district-extract.ts';
import {hashSchema,sha256,knowledgeEvidenceHash,validateKnowledgeRelease,OwnerRobotsOverrideSchema,SourceAccessPolicySchema} from './district-schema.ts';
import {ModelEvidenceSchema,SupportedModelRouteSchema} from './district-model-contract.ts';
import {verifyDataRelease,readReleaseFile} from './data-release.ts';
import {isPublicUrl} from './publication-quality.ts';
import {effectiveSourcePermission,ownerRobotsOverrideApplies,projectSourcePolicyMetadata,type SourceAccessPolicy} from './source-policy.ts';
import {DocumentOriginSchema} from './document-origin-contract.ts';
import {textRunLineageSchema,textLineageRecordSha256,type TextRunLineage} from './text-run-lineage.ts';
import {RetainedKnowledgeLineageSchema} from './retained-knowledge-lineage.ts';
import {districtCoverageSchema,validateDistrictCoverage} from './district-publication.ts';
import {SourceObservationSchema,sourceObservationMatches,type SourceObservation} from './source-observation.ts';
import {assertCivicPolicyAuthority,assertHostNotOptedOut,assertManagedSourceReadable,assertManagedObservationReadable,assertManagedRawSourceBinding,CIVIC_POLICY_AUTHORITY,type CivicPolicyOptions} from './civic-opt-out.ts';

const VERSION='stadtstack-corpus-manifest-v3' as const;
const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/).max(300),timestamp=z.string().datetime({offset:true}),count=z.number().int().nonnegative();
const publicUrl=z.string().url().refine(isPublicUrl,'Unsafe public URL'),mime=z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/);
const httpScalar=z.string().max(4096).refine(value=>!/[\u0000-\u001f\u007f]/u.test(value),'Invalid HTTP scalar');
const observationName=z.string().max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/);
const role=z.enum(['original_run_corpus','additional_inventory']);
const MissingReason=z.enum(['not_recorded','unsafe_observation_path','observation_missing','observation_invalid','index_evidence_missing','observation_mismatch']);
const HttpSchema=z.object({status:z.number().int().min(100).max(599).nullable(),etag:httpScalar.nullable(),lastModified:httpScalar.nullable(),observationId:observationName.nullable(),observationSha256:hashSchema.nullable(),observationState:z.enum(['fetched','not_modified','excluded']).nullable(),bindingStatus:z.enum(['bound','missing','mismatch']),missingReason:MissingReason.nullable()}).strict();
const nativeStatus=z.enum(['not_selected','preparation_hold','pending','running','failed','completed']);
const publishedSchema=z.object({state:z.enum(['not_published','native_published','retained_published']),basis:z.enum(['original_native_result_and_sealed_release_lineage','sealed_release_lineage']).nullable(),recordIds:z.array(identifier)}).strict();
const ProcessingSchema=z.object({runId:hashSchema,scopeWorkPlanId:hashSchema,status:z.enum(['source_excluded','outside_original_corpus','reference_excluded','not_selected','preparation_hold','pending','running','failed','completed','native_published','retained_published']),inOriginalCorpus:z.boolean(),nativeStatus,preparationStatus:z.enum(['not_selected','held','prepared']),referenceIncluded:z.boolean(),taskStates:z.array(z.object({taskId:hashSchema,purpose:z.enum(['production','agreement']),provider:z.enum(['openai-subscription','anthropic-subscription']),state:z.enum(['pending','running','completed','failed']),resultSha256:hashSchema.nullable()}).strict()),chunkCounts:z.object({admitted:count,rejected:count,no_case:count,quarantined:count}).strict(),published:publishedSchema}).strict();
const CitationSchema=z.object({id:identifier,runId:hashSchema,releaseId:hashSchema,sourceArtifactKind:z.enum(['native_extraction_output','retained_publication']),basis:z.enum(['original_native_result_and_sealed_release_lineage','sealed_release_lineage']),sourceLocator:z.string().regex(/^text-sha256:[a-f0-9]{64};chars:\d+-\d+$/),evidenceHash:hashSchema}).strict();
export const CorpusManifestRecordSchema=z.object({
 schemaVersion:z.literal(VERSION),id:hashSchema,municipalityId:identifier,ags:z.string().regex(/^\d{8}$/),districtId:identifier,sourceId:identifier,sourceEndpoint:publicUrl.nullable(),url:publicUrl,fetchedAt:timestamp,checkedAt:timestamp.nullable(),sha256:hashSchema,sizeBytes:count,contentType:mime,
 casPath:z.string().regex(/^sha256\/[a-f0-9]{64}$/).nullable(),bodyState:z.enum(['retained','excluded']),exclusion:excludedCrawlDocumentSchema.shape.exclusion.nullable(),http:HttpSchema,
 robots:z.object({state:z.enum(['allowed','blocked','unavailable']),url:publicUrl,sha256:hashSchema.optional(),checkedAt:timestamp.optional()}).strict().nullable(),robotsStatus:z.enum(['allowed','disallowed','unavailable']).nullable(),override:z.literal('owner-approved 2026-10-11').nullable(),ownerRobotsOverride:OwnerRobotsOverrideSchema.nullable(),documentOrigin:DocumentOriginSchema.nullable(),tdmState:z.enum(['reserved','not_reserved','not_declared','unavailable']).nullable(),tdmReferenceStatus:z.literal('unavailable').nullable(),tdmDeclarationStatus:z.literal('unavailable').nullable(),tdmOverride:z.literal('owner-approved 2026-10-11').nullable(),ownerTdmOverride:OwnerRobotsOverrideSchema.nullable(),observedPermission:z.enum(['permitted','not_permitted','not_recorded']),
 memberships:z.array(z.object({name:identifier,indexSha256:hashSchema,runId:hashSchema,role,documentId:identifier}).strict()).min(1),processing:z.array(ProcessingSchema).min(1),releasedRecords:z.array(CitationSchema),
}).strict().superRefine((record,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(record.bodyState==='retained'?(record.casPath!==`sha256/${record.sha256}`||record.exclusion!==null):(record.casPath!==null||record.exclusion===null||record.http.observationState!=='excluded'||record.http.bindingStatus!=='bound'||record.processing.some(item=>item.status!=='source_excluded'||item.referenceIncluded||item.published.state!=='not_published')||record.releasedRecords.length!==0))fail('Representation retention/exclusion binding mismatch');
 if(record.documentOrigin&&(record.documentOrigin.url!==record.url||record.documentOrigin.sha256!==record.sha256))fail('Origin classification byte/URL binding mismatch');
 if(record.bodyState==='excluded'&&(!record.documentOrigin||record.documentOrigin.classification==='official_work'||record.robots?.state!=='blocked'&&record.tdmState!=='reserved'||record.observedPermission!=='not_permitted'))fail('Exclusion requires a bound non-official restricted representation');
 if(record.robotsStatus!==(record.robots?.state==='blocked'?'disallowed':record.robots?.state??null))fail('Robots declaration projection mismatch');
 if(record.override!==null||record.ownerRobotsOverride!==null)if(record.override!=='owner-approved 2026-10-11'||!ownerRobotsOverrideApplies(record.url,record.ownerRobotsOverride)||!record.robots||record.robots.state==='allowed'||record.robots.state==='blocked'&&!record.robots.sha256||!record.robots.checkedAt||record.robots.url!==new URL('/robots.txt',record.url).href||record.http.bindingStatus!=='bound')fail('Owner exception requires bound actual robots declaration');
 if(record.tdmOverride!==null||record.ownerTdmOverride!==null)if(record.tdmState!=='reserved'||record.tdmOverride!=='owner-approved 2026-10-11'||!ownerRobotsOverrideApplies(record.url,record.ownerTdmOverride)||record.documentOrigin?.classification!=='official_work'||record.http.bindingStatus!=='bound')fail('TDM exception requires a bound official-work decision');
 if(record.http.bindingStatus==='bound'){
  if(!record.http.observationId||!record.http.observationSha256||!record.http.observationState||!record.checkedAt||record.http.status===null||record.http.missingReason!==null)fail('Incomplete bound observation');
 }else if(record.http.status!==null||record.http.etag!==null||record.http.lastModified!==null||record.http.observationState!==null||record.http.missingReason===null)fail('Unbound HTTP metadata');
 for(const item of record.processing){
  const primary=item.taskStates.filter(task=>task.purpose==='production');
  if(primary.length>1||new Set(item.taskStates.map(task=>task.taskId)).size!==item.taskStates.length)fail('Duplicate original task');
  for(const task of item.taskStates)if((task.state==='completed')!==(task.resultSha256!==null))fail('Task result state mismatch');
  if(primary[0]?.state!=='completed'&&Object.values(item.chunkCounts).some(value=>value!==0))fail('Chunk counts require an original completed primary result');
  if(item.referenceIncluded&&(!item.inOriginalCorpus||item.preparationStatus!=='prepared'||record.bodyState==='excluded'))fail('Reference eligibility mismatch');
  if(item.published.state==='not_published'?(item.published.basis!==null||item.published.recordIds.length!==0):(item.status!==item.published.state||!item.published.recordIds.length||item.published.basis!==(item.published.state==='retained_published'?'sealed_release_lineage':'original_native_result_and_sealed_release_lineage')))fail('Publication provenance mismatch');
  if(item.published.state==='native_published'&&(!item.referenceIncluded||primary[0]?.state!=='completed'))fail('Native publication needs its exact prepared reference and original result');
 }
 if(new Set(record.processing.map(item=>item.runId)).size!==record.processing.length||new Set(record.memberships.map(item=>JSON.stringify(item))).size!==record.memberships.length||new Set(record.releasedRecords.map(item=>JSON.stringify(item))).size!==record.releasedRecords.length)fail('Duplicate representation context');
});
export type CorpusManifestRecord=z.infer<typeof CorpusManifestRecordSchema>;
const GenerationInputSchema=z.object({runId:hashSchema,registrySha256:hashSchema,preparationPlanSha256:hashSchema,preparationBindingBasis:z.enum(['sealed_release_lineage','externally_pinned_original_plan']),workPlanSha256:hashSchema,workPlanId:hashSchema}).strict();
const InputsSchema=z.object({indexes:z.array(z.object({name:identifier,sha256:hashSchema,runId:hashSchema,role}).strict()),generations:z.array(GenerationInputSchema),releaseId:hashSchema,releaseManifestSha256:hashSchema,releaseCoverageSha256:hashSchema,releaseRegistrySha256:hashSchema,authority:z.object({authorityId:z.string().min(1),authoritySha256:hashSchema,mode:z.enum(['codex-workstation-local','isolated-fixture'])}).strict(),inventoryScope:z.literal('supplied_text_run_corpora_only'),textLineage:textRunLineageSchema.nullable(),retainedPublication:RetainedKnowledgeLineageSchema.nullable()}).strict().refine(input=>input.textLineage!==null||input.retainedPublication!==null,'An actual native lineage or retained publication is required');
export type CorpusManifestInputs=z.infer<typeof InputsSchema>;
export const CorpusManifestHeaderSchema=z.object({schemaVersion:z.literal('stadtstack-corpus-manifest-header-v3'),type:z.literal('metadata'),inputs:InputsSchema}).strict();
const ManifestSchema=z.object({schemaVersion:z.literal(VERSION),inputs:InputsSchema,records:z.array(CorpusManifestRecordSchema)}).strict();
export type CorpusManifest=z.infer<typeof ManifestSchema>;
const PinSchema=z.object({path:z.string().min(1),sha256:hashSchema}).strict();
const PolicyOptionsSchema=z.object({stateDir:z.string().optional(),authorityId:z.string().optional(),authoritySha256:hashSchema.optional()}).strict();
const OptionsSchema=z.object({releaseRoot:z.string().min(1),releaseManifestSha256:hashSchema,generations:z.array(z.object({runId:hashSchema,registryPin:PinSchema,preparationPlan:PinSchema,workPlan:PinSchema,resultRoot:z.string().min(1)}).strict()),indexes:z.array(PinSchema.extend({name:identifier,runId:hashSchema,rawRoot:z.string().min(1)}).strict()),out:z.string().min(1),summaryOut:z.string().min(1),policy:PolicyOptionsSchema.optional()}).strict();
export type CorpusManifestOptions=z.infer<typeof OptionsSchema>;
const VerificationOptionsSchema=z.object({manifest:PinSchema,indexes:z.array(z.object({name:identifier,rawRoot:z.string().min(1)}).strict()),policy:PolicyOptionsSchema.optional()}).strict();
export type CorpusManifestVerificationOptions=z.infer<typeof VerificationOptionsSchema>;
const limitations=[
 'Each named index is checked only against its explicitly supplied raw root; no cross-root or newer-cache fallback is used.',
 'Original task bytes and hashes are authenticated without applying current graph-identity schemas or recomputing historical plan identities from current model configuration.',
 'Processing and reference membership describe each pinned historical run, not present-day source or model admission; same-byte group counts do not authorize aliases.',
 'Retained publication facts have separate sealed-publication lineage, not invented raw-body rows, task results, preparation receipts or model runs; their source-body inventory is not claimed here.',
 'Content type is normalized/sniffed and size is decoded representation bytes; excluded bodies are not read or verified against CAS.',
 'Historical observations do not establish a complete redirect chain or request history; mutable request pointers are never evidence.',
 'This inventory covers text-run lineage, not structured-pipeline record production. Private paths, source bodies, quotations and model answers are not exported.',
] as const;
export interface CorpusManifestVerification {manifestSha256:string;inputs:CorpusManifestInputs;records:CorpusManifestRecord[];recordCount:number;distinctBodies:number;verifiedBodyCopies:number;totalBodyBytes:number;skippedBodyVerifications:number}
export interface CorpusManifestSummary extends Omit<CorpusManifestVerification,'records'> {schemaVersion:typeof VERSION;boundObservations:number;unboundObservations:number;releasedCitations:number;retainedPublishedRecords:number;limitations:readonly string[]}
const IndexDocumentSchema=crawlDocumentSchema.extend({policy:SourceAccessPolicySchema.optional()});
type IndexDocument=z.infer<typeof IndexDocumentSchema>|z.infer<typeof excludedCrawlDocumentSchema>;
const IndexSchema=z.object({schemaVersion:z.literal('stadtstack-crawl-index-v1'),documents:z.array(IndexDocumentSchema),excludedDocuments:z.array(excludedCrawlDocumentSchema).optional()});
const InventoryPreparationSchema=preparationPlanSchema.safeExtend({corpusSha256:hashSchema});
const provider=z.enum(['openai-subscription','anthropic-subscription']);
// Binding-only historical decoding deliberately preserves, but never re-admits,
// original graph payloads. Hashes are computed over the complete original record.
const HistoricalRecordSchema=z.object({id:identifier,municipalityId:identifier,ags:z.string().regex(/^\d{8}$/),districtId:identifier,sources:z.array(z.object({id:identifier,url:publicUrl,sha256:hashSchema,retrievedAt:timestamp,mimeType:mime,locator:z.string().min(1)}).passthrough()).min(1),extraction:ModelEvidenceSchema.safeExtend({extractorSha256:hashSchema,inputSha256:hashSchema,textSha256:hashSchema,responseSha256:hashSchema,promptSha256:hashSchema,judgePromptSha256:hashSchema,chunk:z.object({index:count,count:z.number().int().positive(),start:count,end:z.number().int().positive()}).strict()}).passthrough(),verification:z.object({evidenceHash:hashSchema,faithfulness:SupportedModelRouteSchema.safeExtend({toolVersion:z.string(),modelIdentitySha256:hashSchema,responseSha256:hashSchema.nullable()}).passthrough()}).passthrough()}).passthrough();
type HistoricalRecord=z.infer<typeof HistoricalRecordSchema>;
const HistoricalResultSchema=z.object({schemaVersion:z.literal('stadtstack-document-result-v2'),taskId:hashSchema,groupId:hashSchema,provider,purpose:z.enum(['production','agreement']),municipalityId:identifier,sourceSha256:hashSchema,preparedSha256:hashSchema,promptSha256:hashSchema,schemaSha256:hashSchema,generatedAt:timestamp,records:z.array(HistoricalRecordSchema),quarantine:z.array(z.object({documentId:z.string(),municipalityId:identifier,sourceId:identifier,sourceSha256:hashSchema,chunk:count.nullable(),reason:z.string(),candidate:HistoricalRecordSchema.optional()}).strict()),chunks:z.array(z.object({index:count,outcome:z.enum(['admitted','rejected','no_case']),responseSha256:hashSchema.nullable(),recordId:z.string().nullable()}).strict())}).strict();
type HistoricalResult=z.infer<typeof HistoricalResultSchema>;
interface Generation {input:z.infer<typeof GenerationInputSchema>;registry:DistrictRegistry;plan:WorkPlan;run:TextRunLineage['runs'][number];groups:Map<string,PreparationGroup>;holds:Set<string>;tasks:Map<string,WorkTask[]>;results:Map<string,HistoricalResult>;originalDocuments:Set<string>}
const key=(...parts:string[])=>JSON.stringify(parts),groupKey=(municipalityId:string,sha:string)=>key(municipalityId,sha),compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const representationKey=(document:IndexDocument)=>key(document.id,document.municipalityId,document.sourceId,document.url,document.sha256,document.mimeType,document.retrievedAt);
const citationKey=(municipalityId:string,source:{id:string;url:string;sha256:string;retrievedAt:string;mimeType:string})=>key(municipalityId,source.id,source.url,source.sha256,source.retrievedAt,source.mimeType);
const excluded=(document:IndexDocument):document is z.infer<typeof excludedCrawlDocumentSchema>=>document.exclusion!==undefined;
async function pinnedJson(pin:z.infer<typeof PinSchema>,policy?:CivicPolicyOptions):Promise<unknown>{
 if(policy)await assertManagedSourceReadable(pin.path,policy);
 const bytes=await readFile(pin.path);if(sha256(bytes)!==pin.sha256)throw Error('Pinned input hash mismatch');
 if(policy)await assertManagedSourceReadable(pin.path,policy);return JSON.parse(bytes.toString('utf8'));
}
async function containedFile(root:string,path:string):Promise<string>{
 const actualRoot=await realpath(root),candidate=resolve(path),actual=await realpath(candidate),part=relative(actualRoot,actual),metadata=await lstat(candidate);
 if(actual!==candidate||!part||part.startsWith('..')||isAbsolute(part)||!metadata.isFile()||metadata.isSymbolicLink())throw Error('Evidence path escapes its root or is not a regular original file');return actual;
}
interface BodyInventory {copies:Map<string,number>;bodies:Map<string,number>}
async function bodySize(rawRoot:string,document:{url:string;sha256:string},inventory:BodyInventory,policy:CivicPolicyOptions):Promise<number>{
 await assertHostNotOptedOut(document.url,policy);
 const path=await containedFile(rawRoot,join(rawRoot,'sha256',hashSchema.parse(document.sha256)));
 await assertManagedSourceReadable(path,{...policy,sourceUrl:document.url});
 let size=inventory.copies.get(path);
 if(size===undefined){const hash=createHash('sha256');size=0;for await(const chunk of createReadStream(path)){hash.update(chunk);size+=chunk.length;}if(hash.digest('hex')!==document.sha256)throw Error('CAS body hash mismatch');inventory.copies.set(path,size);inventory.bodies.set(document.sha256,size);}
 await assertManagedSourceReadable(path,{...policy,sourceUrl:document.url});return size;
}
function relocatedObservation(path:string):string|null{
 const match=/(?:^|\/)observations\/([^/]+\.json)$/.exec(path);
 return match&&observationName.safeParse(match[1]).success&&!path.split('/').includes('..')?match[1]:null;
}
async function observationBytes(rawRoot:string,name:string,policy:CivicPolicyOptions):Promise<Buffer>{
 const path=await containedFile(join(rawRoot,'observations'),join(rawRoot,'observations',observationName.parse(name)));
 if((await lstat(path)).size>16*1024*1024)throw Error('Historical observation size rejected');
 await assertManagedObservationReadable(path,policy);const bytes=await readFile(path);await assertManagedObservationReadable(path,policy);return bytes;
}
function auditPolicy(policy:SourceAccessPolicy|undefined){
 const value=policy?projectSourcePolicyMetadata(policy):undefined;
 return {robots:value?.robots??null,robotsStatus:value?.robots.state==='blocked'?'disallowed' as const:value?.robots.state??null,override:value?.override??null,ownerRobotsOverride:value?.ownerRobotsOverride??null,documentOrigin:value?.documentOrigin??null,tdmState:value?.tdm.state??null,tdmReferenceStatus:value?.tdm.referenceStatus??null,tdmDeclarationStatus:value?.tdm.declarationStatus??null,tdmOverride:value?.tdmOverride??null,ownerTdmOverride:value?.ownerTdmOverride??null};
}
async function bindObservation(rawRoot:string,document:IndexDocument,sizeBytes:number,policy:CivicPolicyOptions):Promise<CorpusManifestRecord['http']>{
 const missing=(missingReason:z.infer<typeof MissingReason>,name:string|null=null,digest:string|null=null):CorpusManifestRecord['http']=>({status:null,etag:null,lastModified:null,observationId:name,observationSha256:digest,observationState:null,bindingStatus:['observation_mismatch','observation_invalid'].includes(missingReason)?'mismatch':'missing',missingReason});
 if(!document.observationPath)return missing('not_recorded');const name=relocatedObservation(document.observationPath);if(!name)return missing('unsafe_observation_path');
 let bytes:Buffer;try{bytes=await observationBytes(rawRoot,name,policy);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return missing('observation_missing',name);throw error;}
 const digest=sha256(bytes);let observation:SourceObservation;try{observation=SourceObservationSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{return missing('observation_invalid',name,digest);}
 if(document.checkedAt===undefined||document.status===undefined)return missing('index_evidence_missing',name,digest);
 if(!sourceObservationMatches(observation,{...document,checkedAt:document.checkedAt,status:document.status,sizeBytes,bodyState:excluded(document)?'excluded':'retained'})||JSON.stringify(auditPolicy(document.policy))!==JSON.stringify(auditPolicy(observation.policy))||excluded(document)&&JSON.stringify(document.exclusion)!==JSON.stringify(observation.exclusion))return missing('observation_mismatch',name,digest);
 if(!excluded(document))await assertManagedRawSourceBinding(join(rawRoot,'sha256',document.sha256),{kind:'http_observation',url:document.url,sourceSha256:document.sha256,observationId:name,receiptSha256:digest},policy);
 return {status:observation.status,etag:observation.etag??null,lastModified:observation.lastModified??null,observationId:name,observationSha256:digest,observationState:observation.state,bindingStatus:'bound',missingReason:null};
}
function validateNativeResult(result:HistoricalResult,task:WorkTask,plan:WorkPlan,group:PreparationGroup):void{
 checkResult(result,task,plan);
 if(new Set(result.chunks.map(chunk=>chunk.index)).size!==result.chunks.length||result.chunks.some((chunk,index)=>chunk.index!==index)||new Set(result.records.map(record=>record.id)).size!==result.records.length)throw Error('Original result chunk/record inventory mismatch');
 const validateRecord=(record:HistoricalRecord)=>{
  const extraction=record.extraction,judge=record.verification.faithfulness,chunk=extraction.chunk;
  if(record.municipalityId!==group.municipality.id||record.ags!==group.municipality.ags||record.districtId!==group.municipality.districtId||extraction.inputSha256!==task.group.sourceSha256||extraction.provider!==task.provider||extraction.extractorSha256!==plan.extractorSha256||chunk.count!==result.chunks.length||chunk.index>=chunk.count||chunk.end<=chunk.start||record.verification.evidenceHash!==knowledgeEvidenceHash(record))throw Error('Original record source/model/chunk/evidence binding mismatch');
  if(sha256(JSON.stringify({extraction:extraction.promptSha256,judge:extraction.judgePromptSha256,extractorSha256:extraction.extractorSha256}))!==plan.promptSha256||judge.provider!==extraction.provider||judge.model!==extraction.model||judge.tool!==extraction.tool||judge.toolVersion!==extraction.toolVersion||judge.modelIdentitySha256!==extraction.modelIdentitySha256)throw Error('Original prompt/judge binding mismatch');
  const expected=new Set(group.expected.references.map(reference=>citationKey(record.municipalityId,reference))),actual=new Set(record.sources.map(reference=>citationKey(record.municipalityId,reference)));
  if(expected.size!==actual.size||actual.size!==record.sources.length||[...actual].some(value=>!expected.has(value))||record.sources.some(reference=>reference.locator!==`text-sha256:${extraction.textSha256};chars:${chunk.start}-${chunk.end}`))throw Error('Original result prepared-reference/locator mismatch');
 };
 for(const record of result.records)validateRecord(record);
 for(const item of result.quarantine){if(item.municipalityId!==task.group.municipalityId||item.sourceSha256!==task.group.sourceSha256||!group.expected.references.some(reference=>reference.id===item.sourceId)||item.chunk!==null&&item.chunk>=result.chunks.length)throw Error('Original quarantine source/chunk mismatch');if(item.candidate)validateRecord(item.candidate);}
 const remaining=new Map(result.records.map(record=>[record.id,record]));
 for(const chunk of result.chunks){
  const record=chunk.outcome==='admitted'&&chunk.recordId!==null?remaining.get(chunk.recordId):chunk.outcome==='rejected'&&chunk.recordId!==null?result.quarantine.find(item=>item.chunk===chunk.index&&item.candidate?.id===chunk.recordId)?.candidate:undefined;
  if(chunk.outcome==='admitted'||chunk.recordId!==null){if(!record||record.extraction.chunk.index!==chunk.index||record.extraction.responseSha256!==chunk.responseSha256)throw Error('Original chunk outcome record binding mismatch');if(chunk.outcome==='admitted')remaining.delete(record.id);}
  if(chunk.outcome==='no_case'&&chunk.recordId!==null)throw Error('No-case chunk cannot carry a record');
 }
 if(remaining.size)throw Error('Original result record has no admitted chunk');
}
function processingFor(document:IndexDocument,generation:Generation,citations:CorpusManifestRecord['releasedRecords']):CorpusManifestRecord['processing'][number]{
 const id=groupKey(document.municipalityId,document.sha256),group=generation.groups.get(id),held=generation.holds.has(id),tasks=generation.tasks.get(id)??[],primary=tasks.find(task=>task.purpose==='production'),result=primary?generation.results.get(primary.id):undefined,inOriginalCorpus=generation.originalDocuments.has(representationKey(document));
 const referenceIncluded=!excluded(document)&&inOriginalCorpus&&!!group&&group.documentIds.includes(document.id)&&!group.referenceWarnings.some(warning=>warning.documentId===document.id&&warning.sourceId===document.sourceId)&&group.expected.references.some(reference=>citationKey(document.municipalityId,reference)===citationKey(document.municipalityId,{...document,id:document.sourceId}));
 const native=primary?.state??(held?'preparation_hold':'not_selected'),chunkCounts={admitted:0,rejected:0,no_case:0,quarantined:result?.quarantine.length??0};for(const chunk of result?.chunks??[])chunkCounts[chunk.outcome]++;
 const selected=citations.filter(citation=>citation.runId===generation.run.runId),state=selected.length?(generation.run.sourceArtifactKind==='retained_publication'?'retained_published':'native_published'):'not_published';
 const status=excluded(document)?'source_excluded':state!=='not_published'?state:!inOriginalCorpus?'outside_original_corpus':group&&!referenceIncluded?'reference_excluded':native;
 return {runId:generation.run.runId,scopeWorkPlanId:generation.plan.id,status,inOriginalCorpus,nativeStatus:native,preparationStatus:group?'prepared':held?'held':'not_selected',referenceIncluded,taskStates:tasks.map(task=>({taskId:task.id,purpose:task.purpose,provider:task.provider,state:task.state,resultSha256:task.resultSha256})),chunkCounts,published:{state,basis:state==='not_published'?null:state==='retained_published'?'sealed_release_lineage':'original_native_result_and_sealed_release_lineage',recordIds:[...new Set(selected.map(citation=>citation.id))].sort(compare)}};
}
function validateManifest(raw:unknown):CorpusManifest{
 const manifest=ManifestSchema.parse(raw),indexes=new Map(manifest.inputs.indexes.map(index=>[index.name,index])),generations=new Map(manifest.inputs.generations.map(generation=>[generation.runId,generation])),runs=new Map((manifest.inputs.textLineage?.runs??[]).map(run=>[run.runId,run]));
 if(indexes.size!==manifest.inputs.indexes.length||generations.size!==manifest.inputs.generations.length||runs.size!==generations.size)throw Error('Duplicate or missing generation/index scope');
 const nativeOrigins=manifest.inputs.textLineage?.selectedRecordOrigins??[],retainedIds=new Set(manifest.inputs.retainedPublication?.selectedRecordOrigins.map(origin=>origin.recordId)??[]);
 if(nativeOrigins.some(origin=>retainedIds.has(origin.recordId)))throw Error('A selected record cannot have both native and retained-publication origins');
 for(const generation of generations.values()){
  const run=runs.get(generation.runId);if(!run||run.pins.registrySha256!==generation.registrySha256||run.artifacts.preparationPlan!==null&&run.artifacts.preparationPlan!==generation.preparationPlanSha256||generation.preparationBindingBasis!==(run.artifacts.preparationPlan===null?'externally_pinned_original_plan':'sealed_release_lineage'))throw Error('Generation lineage pin mismatch');
  if(!manifest.inputs.indexes.some(index=>index.runId===run.runId&&index.sha256===run.pins.corpusSha256&&index.role==='original_run_corpus'))throw Error('Original run corpus is missing');
 }
 for(const index of indexes.values()){const run=runs.get(index.runId);if(!run||index.role!==(index.sha256===run.pins.corpusSha256?'original_run_corpus':'additional_inventory'))throw Error('Index generation/role mismatch');}
 const ids=new Set<string>(),seenOrigins=new Set<string>();
 for(const record of manifest.records){
  if(ids.has(record.id))throw Error('Duplicate representation identity');ids.add(record.id);
  const {id,memberships,processing:_processing,releasedRecords:_releasedRecords,...representation}=record;
  if(memberships.some(member=>member.documentId!==memberships[0].documentId)||id!==sha256(key(memberships[0].documentId,textLineageRecordSha256(representation))))throw Error('Representation identity binding mismatch');
  if(record.processing.length!==generations.size)throw Error('Incomplete representation generation inventory');
  for(const item of record.processing)if(generations.get(item.runId)?.workPlanId!==item.scopeWorkPlanId)throw Error('Processing generation binding mismatch');
  for(const member of record.memberships){const input=indexes.get(member.name);if(!input||input.sha256!==member.indexSha256||input.runId!==member.runId||input.role!==member.role)throw Error('Index membership binding mismatch');}
  for(const citation of record.releasedRecords){
   const origin=nativeOrigins.find(origin=>origin.recordId===citation.id),processing=record.processing.find(item=>item.runId===citation.runId);
   if(citation.releaseId!==manifest.inputs.releaseId||!origin||origin.runId!==citation.runId||origin.sourceArtifactKind!==citation.sourceArtifactKind||origin.currentEvidenceHash!==citation.evidenceHash||origin.municipalityId!==record.municipalityId||origin.sourceSha256!==record.sha256||!processing?.published.recordIds.includes(citation.id))throw Error('Released citation lineage mismatch');seenOrigins.add(citation.id);
  }
  for(const item of record.processing)if(item.published.recordIds.some(id=>!record.releasedRecords.some(citation=>citation.id===id&&citation.runId===item.runId)))throw Error('Published status lacks an exact citation');
 }
 if(seenOrigins.size!==nativeOrigins.length)throw Error('Selected text origin missing from supplied representations');return manifest;
}
export function parseManifestJsonl(bytes:Uint8Array):CorpusManifest{
 const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\n');if(lines.at(-1)==='')lines.pop();
 if(!lines.length||lines.some(line=>line.trim()===''))throw Error('Blank or missing corpus manifest JSONL row');
 const values=lines.map((line,index)=>{try{return JSON.parse(line) as unknown;}catch{throw Error(`Malformed corpus manifest JSONL row ${index+1}`);}}),header=CorpusManifestHeaderSchema.parse(values[0]);
 return validateManifest({schemaVersion:VERSION,inputs:header.inputs,records:values.slice(1)});
}

/** Public metadata export; every source-bearing read still needs the current authority. */
export async function buildCorpusManifest(options:CorpusManifestOptions):Promise<CorpusManifestSummary>{
 const config=OptionsSchema.parse(options);if(resolve(config.out)===resolve(config.summaryOut))throw Error('Manifest and summary paths must differ');
 const selected=config.policy??CIVIC_POLICY_AUTHORITY,authority=await assertCivicPolicyAuthority(selected),policy={...selected,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const releaseBytes=await readFile(join(config.releaseRoot,'release-manifest.json'));if(sha256(releaseBytes)!==config.releaseManifestSha256)throw Error('Pinned release manifest hash mismatch');
 const release=await verifyDataRelease(config.releaseRoot);if(JSON.parse(releaseBytes.toString('utf8')).id!==release.id||sha256(await readFile(join(config.releaseRoot,'release-manifest.json')))!==config.releaseManifestSha256)throw Error('Release changed during manifest build');
 const releaseRegistryBytes=await readReleaseFile(config.releaseRoot,release,'knowledge/registry.json'),releaseRegistry=districtRegistrySchema.parse(JSON.parse(releaseRegistryBytes.toString('utf8'))),released=validateKnowledgeRelease(JSON.parse((await readReleaseFile(config.releaseRoot,release,'knowledge/records.json')).toString('utf8')),releaseRegistry);
 const coverageBytes=await readReleaseFile(config.releaseRoot,release,'knowledge/coverage.json'),coverage=districtCoverageSchema.parse(JSON.parse(coverageBytes.toString('utf8')));
 validateDistrictCoverage(coverage,releaseRegistry,released.records);
 const lineage=coverage.textLineage,nativeRuns=lineage?.runs??[],nativeOrigins=lineage?.selectedRecordOrigins??[],retainedPublication=coverage.retainedPublication;
 if(new Set(config.generations.map(item=>item.runId)).size!==config.generations.length||new Set(config.indexes.map(item=>item.name)).size!==config.indexes.length||config.generations.length!==nativeRuns.length)throw Error('Distinct inputs for every original text generation are required');
 const indexes=new Map<string,{input:CorpusManifestOptions['indexes'][number];rawRoot:string;corpus:z.infer<typeof IndexSchema>}>();
 for(const input of config.indexes){if(!config.generations.some(generation=>generation.runId===input.runId))throw Error('Index has unknown generation');indexes.set(input.name,{input,rawRoot:await realpath(input.rawRoot),corpus:IndexSchema.parse(await pinnedJson(input,policy))});}
 const generations=new Map<string,Generation>();
 for(const input of [...config.generations].sort((a,b)=>compare(a.runId,b.runId))){
  const run=nativeRuns.find(run=>run.runId===input.runId);if(!run)throw Error('Generation is absent from sealed text lineage');
  const registry=districtRegistrySchema.parse(await pinnedJson(input.registryPin)),preparation=InventoryPreparationSchema.parse(await pinnedJson(input.preparationPlan,policy)),plan=WorkPlanSchema.parse(await pinnedJson(input.workPlan));
  if(input.registryPin.sha256!==run.pins.registrySha256||preparation.registrySha256!==input.registryPin.sha256||preparation.corpusSha256!==run.pins.corpusSha256||plan.promptSha256!==run.pins.promptContractSha256||plan.schemaSha256!==run.pins.schemaSha256||plan.assignmentMode!==run.assignmentMode||run.artifacts.preparationPlan!==null&&run.artifacts.preparationPlan!==input.preparationPlan.sha256)throw Error('Original generation input binding mismatch');
  const originals=[...indexes.values()].filter(index=>index.input.runId===run.runId&&index.input.sha256===run.pins.corpusSha256);if(!originals.length)throw Error('Original run corpus is missing');
  const originalDocuments=new Set(originals.flatMap(index=>[...index.corpus.documents,...index.corpus.excludedDocuments??[]].map(representationKey))),groups=new Map<string,PreparationGroup>(),holds=new Set(preparation.quarantine.map(item=>groupKey(item.municipalityId,item.sourceSha256)));
  for(const group of preparation.groups){const id=groupKey(group.municipality.id,group.expected.sourceSha256),city=registry.municipalities.find(city=>city.id===group.municipality.id);if(groups.has(id)||holds.has(id)||!city||city.ags!==group.municipality.ags||city.districtId!==group.municipality.districtId||group.expected.municipalityId!==city.id||group.expected.extractorSha256!==preparation.extractorSha256)throw Error('Preparation group binding mismatch');groups.set(id,group);}
  const tasks=new Map<string,WorkTask[]>(),results=new Map<string,HistoricalResult>(),taskIds=new Set<string>();
  for(const task of plan.tasks){
   const id=groupKey(task.group.municipalityId,task.group.sourceSha256),group=groups.get(id),list=tasks.get(id)??[];
   if(taskIds.has(task.id)||!group||group.expected.receiptSha256!==task.group.preparedSha256||list.some(previous=>previous.purpose===task.purpose)||task.groupId!==sha256(JSON.stringify([task.group.municipalityId,task.group.sourceSha256]))||task.id!==sha256(JSON.stringify([task.groupId,task.group.preparedSha256,task.provider,task.purpose,plan.promptSha256,plan.schemaSha256]))||(task.state==='completed')!==(task.resultSha256!==null)||task.state==='completed'&&task.failure!==null||plan.assignmentMode==='codex-only'&&(task.provider!=='openai-subscription'||task.purpose!=='production'))throw Error('Original task identity/state/preparation binding mismatch');
   taskIds.add(task.id);list.push(task);tasks.set(id,list);
   if(task.state==='completed'){const result=HistoricalResultSchema.parse(await pinnedJson({path:await containedFile(input.resultRoot,join(input.resultRoot,task.id+'.json')),sha256:task.resultSha256!},policy));validateNativeResult(result,task,plan,group);results.set(task.id,result);}
  }
  for(const id of groups.keys())if(!tasks.get(id)?.some(task=>task.purpose==='production'))throw Error('Prepared group missing original primary task');
  generations.set(run.runId,{input:{runId:run.runId,registrySha256:input.registryPin.sha256,preparationPlanSha256:input.preparationPlan.sha256,preparationBindingBasis:run.artifacts.preparationPlan===null?'externally_pinned_original_plan':'sealed_release_lineage',workPlanSha256:input.workPlan.sha256,workPlanId:plan.id},registry,plan,run,groups,holds,tasks,results,originalDocuments});
 }
 const citations=new Map<string,CorpusManifestRecord['releasedRecords']>(),seenCitations=new Set<string>(),textRecords=released.records.filter(record=>!('kind' in record)||record.kind==='text_model').map(record=>HistoricalRecordSchema.parse(record));
 if(textRecords.length!==nativeOrigins.length+(retainedPublication?.selectedRecordOrigins.length??0))throw Error('Current released text records and native/retained origins differ');
 const nativeRecordIds=new Set(nativeOrigins.map(origin=>origin.recordId));
 for(const record of textRecords.filter(record=>nativeRecordIds.has(record.id))){
  const origin=nativeOrigins.find(origin=>origin.recordId===record.id),generation=origin?generations.get(origin.runId):undefined;
  if(!origin||!generation||origin.currentEvidenceHash!==record.verification.evidenceHash||origin.municipalityId!==record.municipalityId||origin.sourceSha256!==record.extraction.inputSha256||origin.extractionResponseSha256!==record.extraction.responseSha256||origin.judgeResponseSha256!==record.verification.faithfulness.responseSha256||origin.promptSha256!==record.extraction.promptSha256||origin.judgePromptSha256!==record.extraction.judgePromptSha256||Object.entries(origin.model).some(([field,value])=>record.extraction[field]!==value))throw Error('Current text citation lineage/model binding mismatch');
  if(origin.sourceArtifactKind==='native_extraction_output'){
   const task=generation.tasks.get(groupKey(record.municipalityId,origin.sourceSha256))?.find(task=>task.purpose==='production'),original=task?generation.results.get(task.id)?.records.find(item=>item.id===record.id):undefined;
   if(!original||textLineageRecordSha256(original)!==origin.originalRecordSha256||original.verification.evidenceHash!==origin.originalEvidenceHash||JSON.stringify(original.sources.map(source=>citationKey(record.municipalityId,source)).sort(compare))!==JSON.stringify(record.sources.map(source=>citationKey(record.municipalityId,source)).sort(compare)))throw Error('Native published origin lacks its unchanged original task record');
  }
  for(const source of record.sources){const id=citationKey(record.municipalityId,source),list=citations.get(id)??[];list.push({id:record.id,runId:origin.runId,releaseId:release.id,sourceArtifactKind:origin.sourceArtifactKind,basis:origin.sourceArtifactKind==='retained_publication'?'sealed_release_lineage':'original_native_result_and_sealed_release_lineage',sourceLocator:source.locator,evidenceHash:record.verification.evidenceHash});citations.set(id,list);}
 }
 const inventory:BodyInventory={copies:new Map(),bodies:new Map()},rows=new Map<string,CorpusManifestRecord>();
 for(const {input,rawRoot,corpus} of [...indexes.values()].sort((a,b)=>compare(a.input.name,b.input.name))){
  const generation=generations.get(input.runId)!;
  for(const document of [...corpus.documents,...corpus.excludedDocuments??[]]){
   publicUrl.parse(document.url);mime.parse(document.mimeType);await assertHostNotOptedOut(document.url,policy);
   const city=generation.registry.municipalities.find(city=>city.id===document.municipalityId),source=city?.sources.find(source=>source.id===document.sourceId);if(!city||city.ags!==document.ags||city.districtId!==document.districtId||!source)throw Error('Index municipality/source binding mismatch');
   const isExcluded=excluded(document),sizeBytes=isExcluded?document.sizeBytes:await bodySize(rawRoot,document,inventory,policy),http=await bindObservation(rawRoot,document,sizeBytes,policy),projection=auditPolicy(document.policy);
   if((document.policy?.ownerRobotsOverride||document.policy?.ownerTdmOverride||isExcluded)&&(!ownerRobotsOverrideApplies(source.url??source.api?.url??'',source.ownerRobotsOverride)||http.bindingStatus!=='bound'))throw Error('Owner exception/exclusion lacks registered source decision or bound observation');
   const citeKey=citationKey(document.municipalityId,{...document,id:document.sourceId}),selectedCitations=isExcluded?[]:(citations.get(citeKey)??[]).filter(citation=>citation.sourceArtifactKind==='retained_publication'||processingFor(document,generations.get(citation.runId)!,[]).referenceIncluded);
   for(const citation of selectedCitations)seenCitations.add(key(citeKey,citation.id,citation.runId));
   const base={schemaVersion:VERSION,municipalityId:city.id,ags:city.ags,districtId:city.districtId,sourceId:source.id,sourceEndpoint:source.url,url:document.url,fetchedAt:document.retrievedAt,checkedAt:document.checkedAt??null,sha256:document.sha256,sizeBytes,contentType:document.mimeType,casPath:isExcluded?null:`sha256/${document.sha256}`,bodyState:isExcluded?'excluded' as const:'retained' as const,exclusion:isExcluded?document.exclusion:null,http,...projection,observedPermission:isExcluded?'not_permitted' as const:document.policy?effectiveSourcePermission(document.policy,document)?'permitted' as const:'not_permitted' as const:'not_recorded' as const};
   const id=sha256(key(document.id,textLineageRecordSha256(base))),member={name:input.name,indexSha256:input.sha256,runId:input.runId,role:input.sha256===generation.run.pins.corpusSha256?'original_run_corpus' as const:'additional_inventory' as const,documentId:document.id},existing=rows.get(id);
   if(existing){if(!existing.memberships.some(item=>JSON.stringify(item)===JSON.stringify(member)))existing.memberships.push(member);continue;}
   rows.set(id,CorpusManifestRecordSchema.parse({...base,id,memberships:[member],processing:[...generations.values()].map(generation=>processingFor(document,generation,selectedCitations)),releasedRecords:selectedCitations}));
  }
 }
 const expectedCitations=[...citations].flatMap(([id,items])=>items.map(item=>key(id,item.id,item.runId)));if(expectedCitations.some(id=>!seenCitations.has(id)))throw Error('Released source citation missing from supplied indexes');
 const inputs:CorpusManifestInputs={indexes:[...indexes.values()].map(({input})=>({name:input.name,sha256:input.sha256,runId:input.runId,role:input.sha256===generations.get(input.runId)!.run.pins.corpusSha256?'original_run_corpus' as const:'additional_inventory' as const})).sort((a,b)=>compare(a.name,b.name)),generations:[...generations.values()].map(generation=>generation.input),releaseId:release.id,releaseManifestSha256:config.releaseManifestSha256,releaseCoverageSha256:sha256(coverageBytes),releaseRegistrySha256:sha256(releaseRegistryBytes),authority:{authorityId:authority.authorityId,authoritySha256:authority.authoritySha256,mode:authority.mode},inventoryScope:'supplied_text_run_corpora_only',textLineage:lineage,retainedPublication};
 const records=[...rows.values()].sort((a,b)=>compare(a.id,b.id));for(const record of records){record.memberships.sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b)));record.releasedRecords.sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b)));}
 const manifest=validateManifest({schemaVersion:VERSION,inputs,records}),header=CorpusManifestHeaderSchema.parse({schemaVersion:'stadtstack-corpus-manifest-header-v3',type:'metadata',inputs}),encoded=[JSON.stringify(header),...manifest.records.map(record=>JSON.stringify(record))].join('\n')+'\n';
 const summary:CorpusManifestSummary={schemaVersion:VERSION,manifestSha256:sha256(encoded),inputs,recordCount:records.length,distinctBodies:inventory.bodies.size,verifiedBodyCopies:inventory.copies.size,totalBodyBytes:[...inventory.bodies.values()].reduce((a,b)=>a+b,0),skippedBodyVerifications:records.filter(record=>record.bodyState==='excluded').length,boundObservations:records.filter(record=>record.http.bindingStatus==='bound').length,unboundObservations:records.filter(record=>record.http.bindingStatus!=='bound').length,releasedCitations:expectedCitations.length,retainedPublishedRecords:retainedPublication?.selectedRecordOrigins.length??0,limitations};
 await assertCivicPolicyAuthority(policy);await mkdir(dirname(resolve(config.out)),{recursive:true});await mkdir(dirname(resolve(config.summaryOut)),{recursive:true});await writeFile(config.out,encoded,{flag:'wx'});await writeFile(config.summaryOut,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});return summary;
}

/** Verify an externally pinned public manifest with an explicit raw root for every named index. */
export async function verifyCorpusManifest(options:CorpusManifestVerificationOptions):Promise<CorpusManifestVerification>{
 const config=VerificationOptionsSchema.parse(options),selected=config.policy??CIVIC_POLICY_AUTHORITY,authority=await assertCivicPolicyAuthority(selected),policy={...selected,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},bytes=await readFile(config.manifest.path);
 if(sha256(bytes)!==config.manifest.sha256)throw Error('Pinned manifest hash mismatch');const manifest=parseManifestJsonl(bytes);
 if(manifest.inputs.authority.authorityId!==authority.authorityId||manifest.inputs.authority.authoritySha256!==authority.authoritySha256||manifest.inputs.authority.mode!==authority.mode)throw Error('Manifest authority binding differs from current authority');
 const roots=new Map<string,string>();for(const input of config.indexes){if(roots.has(input.name))throw Error('Duplicate verification index root');roots.set(input.name,await realpath(input.rawRoot));}
 if(roots.size!==manifest.inputs.indexes.length||manifest.inputs.indexes.some(index=>!roots.has(index.name)))throw Error('Every named index needs its own explicit raw root');
 const inventory:BodyInventory={copies:new Map(),bodies:new Map()};
 for(const record of manifest.records)for(const member of record.memberships){
  await assertHostNotOptedOut(record.url,policy);const root=roots.get(member.name)!;
  if(record.bodyState==='retained'&&await bodySize(root,record,inventory,policy)!==record.sizeBytes)throw Error('CAS body size mismatch');
  if(record.http.observationSha256!==null){
   if(!record.http.observationId)throw Error('Historical observation identity missing');const observed=await observationBytes(root,record.http.observationId,policy);
   if(sha256(observed)!==record.http.observationSha256)throw Error('Historical observation digest mismatch');
   if(record.http.bindingStatus==='bound'){
    const observation=SourceObservationSchema.parse(JSON.parse(observed.toString('utf8')));
    if(record.checkedAt===null||record.http.status===null||!sourceObservationMatches(observation,{url:record.url,sha256:record.sha256,mimeType:record.contentType,retrievedAt:record.fetchedAt,checkedAt:record.checkedAt,status:record.http.status,sizeBytes:record.sizeBytes,bodyState:record.bodyState})||observation.state!==record.http.observationState||(observation.etag??null)!==record.http.etag||(observation.lastModified??null)!==record.http.lastModified)throw Error('Historical observation binding mismatch');
    const projection=auditPolicy(observation.policy);for(const field of Object.keys(projection) as Array<keyof typeof projection>)if(JSON.stringify(record[field])!==JSON.stringify(projection[field]))throw Error('Historical source-policy audit binding mismatch');
    if(record.bodyState==='excluded'&&JSON.stringify(record.exclusion)!==JSON.stringify(observation.exclusion))throw Error('Historical exclusion binding mismatch');
    if(record.bodyState==='retained')await assertManagedRawSourceBinding(join(root,'sha256',record.sha256),{kind:'http_observation',url:record.url,sourceSha256:record.sha256,observationId:record.http.observationId,receiptSha256:record.http.observationSha256},policy);
   }
  }
  await assertHostNotOptedOut(record.url,policy);
 }
 await assertCivicPolicyAuthority(policy);return {manifestSha256:sha256(bytes),inputs:manifest.inputs,records:manifest.records,recordCount:manifest.records.length,distinctBodies:inventory.bodies.size,verifiedBodyCopies:inventory.copies.size,totalBodyBytes:[...inventory.bodies.values()].reduce((a,b)=>a+b,0),skippedBodyVerifications:manifest.records.filter(record=>record.bodyState==='excluded').length};
}
async function main(){
 const [command,path,digest,...extra]=process.argv.slice(2);if(extra.length||!path||!digest||!['build','verify'].includes(command))throw Error('Usage: corpus-manifest.ts build|verify CONFIG_JSON CONFIG_SHA256');
 const config=await pinnedJson({path,sha256:hashSchema.parse(digest)});
 if(command==='build')console.log(JSON.stringify(await buildCorpusManifest(OptionsSchema.parse(config))));else{const {records:_records,...summary}=await verifyCorpusManifest(VerificationOptionsSchema.parse(config));console.log(JSON.stringify(summary));}
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false))main().catch(()=>{console.error('Corpus manifest command failed; authority, integrity, schema, containment or provenance gate rejected evidence.');process.exitCode=1;});
