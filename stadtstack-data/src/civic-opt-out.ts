import {constants,watch} from 'node:fs';
import {mkdir,lstat,open,rename,unlink,link,opendir,rmdir} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import type {Stats,BigIntStats,FSWatcher} from 'node:fs';
import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {Writable} from 'node:stream';
import type {Readable} from 'node:stream';
import {resolve,join,dirname,basename,relative,isAbsolute,parse,sep} from 'node:path';
import {homedir,hostname,userInfo} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {SourceAccessPolicySchema,ContentFreeSourcePolicySchema} from './district-schema.ts';
import {effectiveSourcePermission} from './source-policy.ts';
import {ManagedDockerResourceSchema,canonicalDockerSocket,dockerDaemonIdentity,dockerConfigSha256,createManagedDocker,attachManagedDocker,startManagedDocker,waitManagedDocker,removeManagedDocker} from './civic-docker.ts';
import type {ManagedDockerResource,ManagedDockerOptions,DockerAttach} from './civic-docker.ts';

// Inventory remains bounded below V8's maximum string length; projected replay
// includes hundreds of thousands of entries and large closed scratch leases.
const WEEK=7*24*60*60*1000,MAX_STATE=480*1024*1024,MAX_CONTENT=512*1024*1024,MAX_FILES=100_000,MAX_INVENTORY_RECORDS=500_000,MAX_SCRATCH_SOURCES=100_000,MAX_SCRATCH_FILES=512;
const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const hex=z.string().regex(/^[a-f0-9]{64}$/),opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const timestamp=z.string().datetime({offset:true}),kindSchema=z.enum(['fetch','prepared','artifacts']);
const reasonSchema=z.enum(['municipality_objection','rights_holder_objection']);
const identitySchema=z.object({dev:z.number().int().nonnegative(),ino:z.number().int().nonnegative()}).strict();
export const CIVIC_ACQUISITION_DECISION_ID='owner-2026-10-11-public-civic-sources' as const;
export const CIVIC_POLICY_AUTHORITY_ID='owner-2026-10-11-codex-workstation' as const;
export const CIVIC_POLICY_STATE_DIR='/home/max/.local/state/stadtstack-data/civic-policy';
export const CIVIC_POLICY_AUTHORITY=Object.freeze({authorityId:CIVIC_POLICY_AUTHORITY_ID,stateDir:CIVIC_POLICY_STATE_DIR});
const CIVIC_MACHINE_ID_SHA256='84e44b05b75fbed614c6a2e74690d2580c0035039055077acf22b6ba68f24dfd';
const fixtureAuthority=/^fixture:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const AUTHORITY_MARKER='authority.json';
const authoritySchema=z.object({schemaVersion:z.literal('civic-policy-authority-v1'),authorityId:opaque,mode:z.enum(['codex-workstation-local','isolated-fixture']),stateId:hex,identity:identitySchema,hostsIdentity:identitySchema,attemptsIdentity:identitySchema,inventoryId:z.string().uuid(),machineSha256:hex,provisionedAt:timestamp}).strict();
const LANE_MARKER='.civic-acquisition-lane.json';
const laneMarkerSchema=z.object({schemaVersion:z.literal(1),decisionId:z.literal(CIVIC_ACQUISITION_DECISION_ID),rootId:hex,identity:identitySchema,kind:kindSchema,authorityId:opaque,authoritySha256:hex}).strict();
export interface ManagedAcquisitionLaneOptions extends CivicPolicyOptions {decisionId:typeof CIVIC_ACQUISITION_DECISION_ID;kind?:'fetch'|'prepared'|'artifacts'}
const objectionSchema=z.object({schemaVersion:z.literal(1),host:z.string(),receivedAt:timestamp,purgeDueAt:timestamp,reason:reasonSchema,reference:opaque.optional()}).strict();
const rootSchema=z.object({id:hex,path:z.string(),kind:kindSchema,identity:identitySchema,complete:z.boolean()}).strict();
const publicationBindingSchema=z.object({manifestSha256:hex,releaseId:opaque,memberPath:z.string().min(1).max(2048).refine(value=>!isAbsolute(value)&&!value.includes('\\')&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..')),memberSha256:hex,memberBytes:z.number().int().nonnegative().max(MAX_CONTENT)}).strict();
const gitSnapshotBindingSchema=z.object({gitCommit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),path:z.string().min(1).max(2048).refine(value=>!isAbsolute(value)&&!value.includes('\\')&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..')),blobOid:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),sha256:hex,bytes:z.number().int().nonnegative().max(MAX_CONTENT)}).strict();
const registryApprovalSchema=z.object({role:z.literal('district_source_registry'),approver:z.literal('owner'),decisionId:z.literal(CIVIC_ACQUISITION_DECISION_ID),date:z.literal('2026-10-11'),configurationSha256:hex,gitCommit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)}).strict();
function validProvenanceShape(value:{kind:string;sourceSha256:string|null;observationId?:string;receiptSha256?:string;publication?:unknown;snapshot?:unknown;purpose?:string;configurationSha256?:string;schemaContractSha256?:string;code?:z.infer<typeof gitSnapshotBindingSchema>;approval?:z.infer<typeof registryApprovalSchema>}):boolean{
 if(value.kind==='operator_registry_config')return value.sourceSha256===null&&!!value.configurationSha256&&!!value.schemaContractSha256&&!!value.code&&!!value.approval&&value.code.path==='stadtstack-data/sources/district-registry.json'&&value.code.sha256===value.configurationSha256&&value.approval.configurationSha256===value.configurationSha256&&value.approval.gitCommit===value.code.gitCommit&&!value.publication&&!value.snapshot&&!value.purpose&&!value.observationId&&!value.receiptSha256;
 if(value.configurationSha256!==undefined||value.schemaContractSha256!==undefined||value.code!==undefined||value.approval!==undefined)return false;
 if(value.kind==='authenticated_git_snapshot')return !!value.snapshot&&value.purpose==='historical_change_reconstruction_only'&&!value.publication&&!value.observationId&&!value.receiptSha256;
 if(value.snapshot!==undefined||value.purpose!==undefined)return false;
 if(value.kind==='retained_publication')return !!value.publication&&!value.observationId&&!value.receiptSha256;
 if(value.kind==='pre_admission'||value.kind==='preparation_input')return !!value.sourceSha256&&!value.publication&&!value.observationId&&!value.receiptSha256;
 return !!value.sourceSha256&&!!value.observationId&&!!value.receiptSha256&&!value.publication;
}
const entrySchema=z.object({id:hex,rootId:hex,relativePath:z.string(),contentSha256:hex,kind:z.enum(['http_observation','prepared_source','retained_publication','authenticated_git_snapshot','operator_registry_config']),sourceSha256:hex.nullable(),host:z.string(),urlSha256:hex,observationId:opaque.optional(),receiptSha256:hex.optional(),publication:publicationBindingSchema.optional(),snapshot:gitSnapshotBindingSchema.optional(),purpose:z.literal('historical_change_reconstruction_only').optional(),configurationSha256:hex.optional(),schemaContractSha256:hex.optional(),code:gitSnapshotBindingSchema.optional(),approval:registryApprovalSchema.optional(),independentAllowed:z.boolean(),state:z.enum(['active','revoked','deleted','missing'])}).strict().superRefine((value,ctx)=>{
 if(!validProvenanceShape(value)||['retained_publication','authenticated_git_snapshot','operator_registry_config'].includes(value.kind)&&value.independentAllowed)ctx.addIssue({code:'custom',message:'Source provenance kind and proof differ'});
});
const scratchSourceSchema=z.object({host:z.string(),urlSha256:hex,kind:z.enum(['http_observation','prepared_source','retained_publication','authenticated_git_snapshot','operator_registry_config','pre_admission','preparation_input']),sourceSha256:hex.nullable(),observationId:opaque.optional(),receiptSha256:hex.optional(),publication:publicationBindingSchema.optional(),snapshot:gitSnapshotBindingSchema.optional(),purpose:z.literal('historical_change_reconstruction_only').optional(),configurationSha256:hex.optional(),schemaContractSha256:hex.optional(),code:gitSnapshotBindingSchema.optional(),approval:registryApprovalSchema.optional()}).strict().superRefine((value,ctx)=>{
 if(!validProvenanceShape(value))ctx.addIssue({code:'custom',message:'Scratch provenance kind and proof differ'});
});
const scratchSchema=z.object({
 id:z.string().uuid(),rootId:hex,directory:z.string(),purpose:z.enum(['document','classification','openai','artifact']),createdAt:timestamp,ownerPid:z.number().int().positive(),
 identity:identitySchema.nullable(),state:z.enum(['planned','active','closing','closed','purged','partial']),sources:z.array(scratchSourceSchema).min(1).max(MAX_SCRATCH_SOURCES),
 groups:z.array(z.object({pid:z.number().int().positive(),settled:z.boolean()}).strict()).max(256),
 resources:z.array(ManagedDockerResourceSchema).max(16).default([]),
 tombstones:z.array(z.object({pathSha256:hex,contentSha256:hex,bytes:z.number().int().nonnegative()}).strict()).max(MAX_SCRATCH_FILES),
}).strict();
const inventorySchema=z.object({schemaVersion:z.literal(1),inventoryId:z.string().uuid(),roots:z.array(rootSchema).max(10_000),entries:z.array(entrySchema).max(MAX_INVENTORY_RECORDS),scratch:z.array(scratchSchema).max(MAX_INVENTORY_RECORDS).default([])}).strict();
const segmentPinSchema=z.object({sha256:hex,bytes:z.number().int().positive().max(MAX_STATE),family:z.enum(['entries','scratch']),previousSha256:hex.nullable()}).strict();
const storageSchema=z.object({format:z.literal('sealed-segments-v1'),segments:z.array(segmentPinSchema).max(MAX_INVENTORY_RECORDS),entryStates:z.record(hex,z.enum(['active','revoked','deleted','missing'])),retiredRoots:z.record(hex,hex)}).strict();
const hotInventorySchema=inventorySchema.extend({storage:storageSchema});
const segmentSchema=z.object({schemaVersion:z.literal('civic-inventory-segment-v1'),inventoryId:z.string().uuid(),family:z.enum(['entries','scratch']),previousSha256:hex.nullable(),entries:z.array(entrySchema).max(MAX_INVENTORY_RECORDS),scratch:z.array(scratchSchema).max(MAX_INVENTORY_RECORDS)}).strict();
const issueSchema=z.object({code:z.enum(['no_managed_roots','inventory_incomplete','unsafe_root','content_changed','unsafe_content','shared_derived_requires_rebuild','inventory_unavailable','operation_failed','inventory_busy','active_scratch','unsafe_scratch','scratch_processes_active','daemon_resource_pending']),rootId:hex.optional(),contentId:hex.optional()}).strict();
const purgeSchema=z.object({host:z.string(),receivedAt:timestamp,purgeDueAt:timestamp,attemptedAt:timestamp,status:z.enum(['purged','partial','error']),deletedFiles:z.number().int().nonnegative(),deletedBytes:z.number().int().nonnegative(),removedReferences:z.number().int().nonnegative(),retainedSharedFiles:z.number().int().nonnegative(),retainedSharedBytes:z.number().int().nonnegative(),missingFiles:z.number().int().nonnegative(),issues:z.array(issueSchema),scope:z.literal('registered_managed_roots')}).strict();
export const RetireReceiptSchema=z.object({schemaVersion:z.literal('civic-root-retirement-v1'),authorityId:opaque,authoritySha256:hex,rootId:hex,rootPath:z.string(),reason:z.string().trim().min(1).max(1800),attemptedAt:timestamp,status:z.enum(['retired','partial']),deletedFiles:z.number().int().nonnegative(),deletedBytes:z.number().int().nonnegative(),missingFiles:z.number().int().nonnegative(),removedEntries:z.number().int().nonnegative(),removedScratchLeases:z.number().int().nonnegative(),issues:z.array(issueSchema)}).strict();
const observationSchema=z.object({
 url:z.string().url().max(8192),method:z.enum(['GET','POST']),checkedAt:timestamp,retrievedAt:timestamp.nullable(),
 state:z.enum(['fetched','not_modified','redirected','failed','excluded']),status:z.number().int().optional(),
 failure:z.string().regex(/^[a-z_]{1,80}$/).optional(),retryAfter:z.string().max(160).optional(),sha256:hex.optional(),
 bytes:z.number().int().nonnegative().optional(),mimeType:z.string().max(256).optional(),etag:z.string().max(1024).optional(),
 lastModified:z.string().max(160).optional(),location:z.string().url().max(8192).optional(),policy:z.unknown().optional(),
 exclusion:z.object({reason:z.literal('non_official_restricted'),excludedAt:timestamp,previousManagedCopy:z.enum(['removed','retained_independent','not_managed','partial'])}).strict().optional(),
}).strict();
const pdfPolicySchema=z.object({schemaVersion:z.literal(1),policyVersion:z.string().regex(/^[a-z0-9.-]+$/),pdfjsVersion:z.string().regex(/^[A-Za-z0-9.+-]+$/),sha256:hex,checkedAt:timestamp,finding:z.object({state:z.literal('checked'),reservation:z.union([z.literal(0),z.literal(1),z.null()]),policyPresent:z.boolean(),metadataPresent:z.boolean()}).strict(),fromCache:z.boolean()}).strict();
// These inventory readers accept only the existing bounded metadata formats;
// arbitrary sibling JSON is never assumed to be harmless or purgeable.
const shortText=z.string().max(1800),publicLink=z.string().url().max(8192),counter=z.number().int().nonnegative();
const documentMetadataSchema=z.object({title:shortText.optional(),caseKey:shortText.optional(),caseKeyType:shortText.optional(),stage:shortText.optional(),stageDate:shortText.optional(),sourceType:shortText.optional(),discoveredFrom:publicLink.optional(),oparlRecordId:publicLink.optional(),sourceVersion:shortText.optional(),legalBasis:shortText.optional()}).strict();
const crawlMetadataSchema=z.object({url:publicLink,sha256:hex,localPath:z.string().max(4096),mimeType:z.string().max(256),retrievedAt:timestamp,checkedAt:timestamp,status:z.number().int(),observationPath:z.string().max(4096),policy:ContentFreeSourcePolicySchema.optional(),id:shortText,municipalityId:shortText,ags:shortText,districtId:shortText,sourceId:shortText,documentDate:shortText.nullable(),adapter:shortText,metadata:documentMetadataSchema}).strict();
const excludedMetadataSchema=crawlMetadataSchema.omit({localPath:true}).extend({policy:ContentFreeSourcePolicySchema,metadata:z.object({sourceType:z.enum(['council','participation','gazette','website']).optional()}).strict().optional(),sizeBytes:counter,exclusion:observationSchema.shape.exclusion.unwrap()}).strict();
const seedMetadataSchema=z.object({url:publicLink,title:shortText.optional(),documentDate:shortText.nullable().optional(),sourceId:shortText,adapter:shortText.optional(),metadata:documentMetadataSchema.optional(),dateReason:shortText.optional(),evidence:z.array(z.object({url:publicLink,locator:shortText,sha256:hex.optional(),retrievedAt:timestamp.optional()}).strict()).optional()}).strict();
const frontierMetadataSchema=z.object({
 schemaVersion:z.literal(1),municipalityId:shortText,sourceId:shortText,
 queue:z.array(seedMetadataSchema.extend({from:z.string().max(8192),depth:counter,revalidate:z.boolean().optional(),previous:crawlMetadataSchema.optional()}).strict()).max(MAX_FILES),
 visited:z.array(publicLink).max(MAX_FILES),documents:z.array(crawlMetadataSchema).max(MAX_FILES),excludedDocuments:z.array(excludedMetadataSchema).max(MAX_FILES).optional(),
 failures:z.array(z.object({url:publicLink,failure:shortText,reason:shortText,checkedAt:timestamp,status:z.number().int().optional(),policy:ContentFreeSourcePolicySchema.optional(),retryAfter:shortText.optional(),action:z.literal('ask_municipality')}).strict()).max(MAX_FILES),
 roots:z.array(publicLink).max(MAX_FILES),checkedUrls:z.record(publicLink,z.object({checkedAt:timestamp,documentId:shortText}).strict()).optional(),lastCheckedAt:timestamp.nullable().optional(),
}).strict().superRefine((value,ctx)=>{
 if(value.documents.length||!opaque.safeParse(value.municipalityId).success||!opaque.safeParse(value.sourceId).success||value.queue.some(item=>item.title!==undefined||item.metadata!==undefined||item.previous!==undefined||item.dateReason!==undefined||item.evidence!==undefined||item.from!==''&&!publicLink.safeParse(item.from).success)||value.failures.some(item=>item.reason!==item.failure&&item.reason!=='withheld'))ctx.addIssue({code:'custom',message:'Source-bearing frontier requires managed content provenance'});
});
const checkpointMetadataSchema=z.object({
 schemaVersion:z.literal(1),bodyId:publicLink,baseUrl:publicLink,kind:z.enum(['paper','meeting']),backfillComplete:z.boolean(),watermark:timestamp.nullable(),
 filterSupport:z.enum(['unknown','supported','unsupported']).optional(),filterSupportReason:shortText.optional(),withdrawnIds:z.array(publicLink).max(MAX_FILES).optional(),
 active:z.object({mode:z.enum(['backfill','incremental','refresh']),startedAt:timestamp,nextUrl:publicLink,visited:z.array(publicLink).max(MAX_FILES),seenIds:z.array(publicLink).max(MAX_FILES).optional(),seenCount:counter.optional(),expectedTotal:counter.nullable().optional()}).strict().nullable(),
 segments:counter,pages:counter,rawRecordCount:counter,lastCheckedAt:timestamp.nullable(),error:shortText.optional(),
}).strict();
type Root=z.infer<typeof rootSchema>;
type Entry=z.infer<typeof entrySchema>;
type Inventory=z.infer<typeof inventorySchema>;
// Only exact canonical inventory bytes are memoized, never mutable inventories.
// Legacy bytes requiring codec defaults stay on the full-validation path until
// a save emits the fully parsed value. Authority and safe-file reads stay live.
const validatedInventoryBytes=new Map<string,string>();
type SegmentPin=z.infer<typeof segmentPinSchema>;
interface SealedInventory {storage:z.infer<typeof storageSchema>;entries:Map<string,Entry>;scratch:Map<string,ScratchLease>;roots:Set<string>}
const sealedInventories=new WeakMap<Inventory,SealedInventory>();
// Cached segment objects are frozen. Every load still opens O_NOFOLLOW and checks
// nanosecond inode metadata; changed metadata forces a fresh digest/codec check.
const segmentCache=new Map<string,{stamp:string;value:z.infer<typeof segmentSchema>}>();
const bulkEntry=(entry:Entry)=>['retained_publication','operator_registry_config','authenticated_git_snapshot'].includes(entry.kind);
const archivedLease=(lease:ScratchLease)=>lease.state==='closed'||lease.state==='purged';
const validatedSegmentEntries=new WeakMap<Entry,Root['kind']>();
const validatedSegmentLeases=new WeakSet<ScratchLease>();
function freezeRecord(value:unknown):void{
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeRecord(child);Object.freeze(value);}
}
async function readSegment(state:string,pin:SegmentPin,inventoryId:string):Promise<z.infer<typeof segmentSchema>>{
 const path=join(state,'inventory-segments',pin.sha256+'.json');
 await directory(dirname(path),false,true);
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await handle.stat({bigint:true}),stamp=snapshotStamp(stat);
  if(!stat.isFile()||stat.nlink!==1n||stat.uid!==BigInt(process.getuid!())||(stat.mode&0o777n)!==0o600n||stat.size!==BigInt(pin.bytes)||snapshotStamp(await lstat(path,{bigint:true}))!==stamp)throw new CivicPolicyStateError();
  let cached=segmentCache.get(path);
  if(!cached||cached.stamp!==stamp){
   const buffer=Buffer.allocUnsafe(pin.bytes+1);let total=0;
   while(total<buffer.length){const {bytesRead}=await handle.read(buffer,total,buffer.length-total,null);if(!bytesRead)break;total+=bytesRead;}
   const bytes=buffer.subarray(0,total);
   if(total!==pin.bytes||digest(bytes)!==pin.sha256||snapshotStamp(await handle.stat({bigint:true}))!==stamp||snapshotStamp(await lstat(path,{bigint:true}))!==stamp)throw new CivicPolicyStateError();
   let value:z.infer<typeof segmentSchema>;
   try{value=segmentSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{throw new CivicPolicyStateError('CIVIC_POLICY_INVENTORY_UNAVAILABLE');}
   if(value.family==='entries'&&(value.scratch.length||!value.entries.length||value.entries.some(entry=>!bulkEntry(entry)))||value.family==='scratch'&&(value.entries.length||!value.scratch.length||value.scratch.some(lease=>!archivedLease(lease))))throw new CivicPolicyStateError();
   freezeRecord(value);cached={stamp,value};segmentCache.set(path,cached);
  }
  const value=cached.value;
  if(value.inventoryId!==inventoryId||value.family!==pin.family||value.previousSha256!==pin.previousSha256)throw new CivicPolicyStateError();
  return value;
 }finally{await handle.close();}
}
async function warmInventorySegments(state:string):Promise<void>{
 try{await directory(join(state,'inventory-segments'),false,true);}catch(error){if(missing(error))return;throw error;}
 try{
  const physical:unknown=JSON.parse((await fileBytes(join(state,'inventory.json'),MAX_STATE,true)).bytes.toString('utf8'));
  if(!physical||typeof physical!=='object'||!('storage' in physical))return;
  const parsed=hotInventorySchema.parse(physical);
  const cold=parsed.storage.segments.some(pin=>!segmentCache.has(join(state,'inventory-segments',pin.sha256+'.json')));
  for(const pin of parsed.storage.segments)await readSegment(state,pin,parsed.inventoryId);
  // Cold immutable decoding/semantic validation is deliberately outside the
  // exclusive lock. The locked load re-opens every pin and the current manifest,
  // so this speculative warming never authorizes a stale inventory.
  if(cold)await loadInventory(state);
 }catch{throw new CivicPolicyStateError('CIVIC_POLICY_INVENTORY_UNAVAILABLE');}
}
async function hydrateInventory(state:string,physical:z.infer<typeof hotInventorySchema>):Promise<Inventory>{
 const entries=new Map<string,Entry>(),scratch=new Map<string,ScratchLease>(),roots=new Set(physical.roots.map(root=>root.id));
 const segmentOrdinals=new Map(physical.storage.segments.map((pin,index)=>[pin.sha256,index])),retiredThrough=new Map<string,number>();
 for(const [rootId,sha256] of Object.entries(physical.storage.retiredRoots)){const ordinal=segmentOrdinals.get(sha256);if(ordinal===undefined)throw new CivicPolicyStateError();retiredThrough.set(rootId,ordinal);}
 let previousSha256:string|null=null;
 for(const [ordinal,pin] of physical.storage.segments.entries()){
  if(pin.previousSha256!==previousSha256)throw new CivicPolicyStateError();
  const segment=await readSegment(state,pin,physical.inventoryId);previousSha256=pin.sha256;
  for(const entry of segment.entries){if((retiredThrough.get(entry.rootId)??-1)>=ordinal)continue;if(entries.has(entry.id))throw new CivicPolicyStateError();entries.set(entry.id,entry);}
  for(const lease of segment.scratch){if((retiredThrough.get(lease.rootId)??-1)>=ordinal)continue;if(scratch.has(lease.id))throw new CivicPolicyStateError();scratch.set(lease.id,lease);}
 }
 const logical:Inventory={schemaVersion:1,inventoryId:physical.inventoryId,roots:physical.roots,entries:[],scratch:[]};
 for(const [id,state] of Object.entries(physical.storage.entryStates))if(!entries.has(id)||entries.get(id)!.state===state)throw new CivicPolicyStateError();
 for(const entry of entries.values()){const state=physical.storage.entryStates[entry.id];logical.entries.push(state===undefined?entry:{...entry,state});}
 for(const entry of physical.entries)logical.entries.push(entry);
 for(const lease of scratch.values())logical.scratch.push(lease);
 for(const lease of physical.scratch)logical.scratch.push(lease);
 if(logical.entries.length>MAX_INVENTORY_RECORDS||logical.scratch.length>MAX_INVENTORY_RECORDS)throw new CivicPolicyStateError();
 sealedInventories.set(logical,{storage:physical.storage,entries,scratch,roots});return logical;
}
function setEntryState(inventory:Inventory,entry:Entry,state:Entry['state']):void{
 const index=inventoryIndex(inventory),current=index.byId.get(entry.id)!;
 if(current.state===state)return;
 const replacement={...current,state},position=index.positions.get(entry.id)!;
 inventory.entries[position[0]]=replacement;
 index.byPath.get(inventoryPathKey(entry.rootId,entry.relativePath))![position[1]]=replacement;
 index.byHost.get(entry.host)![position[2]]=replacement;
 index.byId.set(entry.id,replacement);
}
// Transaction-local acceleration only; no index is serialized or reused across
// disk loads. Buckets keep the inventory's insertion order and entry objects,
// so state transitions are visible without rebuilding any index.
interface InventoryIndex {byId:Map<string,Entry>;byPath:Map<string,Entry[]>;byHost:Map<string,Entry[]>;positions:Map<string,[number,number,number]>;cas:Map<string,{contentSha256:string;sourceSha256:string|null;conflicting:boolean}>}
const inventoryIndices=new WeakMap<Inventory,InventoryIndex>();
const inventoryPathKey=(rootId:string,path:string)=>rootId+'\0'+path;
function indexEntry(index:InventoryIndex,entry:Entry){
 index.byId.set(entry.id,entry);
 const pathKey=inventoryPathKey(entry.rootId,entry.relativePath),pathBucket=index.byPath.get(pathKey),hostBucket=index.byHost.get(entry.host);
 index.positions.set(entry.id,[index.byId.size-1,pathBucket?.length??0,hostBucket?.length??0]);
 if(pathBucket)pathBucket.push(entry);else index.byPath.set(pathKey,[entry]);
 if(hostBucket)hostBucket.push(entry);else index.byHost.set(entry.host,[entry]);
 const binding=index.cas.get(pathKey);
 if(binding){if(binding.contentSha256!==entry.contentSha256||binding.sourceSha256!==entry.sourceSha256)binding.conflicting=true;}
 else index.cas.set(pathKey,{contentSha256:entry.contentSha256,sourceSha256:entry.sourceSha256,conflicting:false});
}
function inventoryIndex(inventory:Inventory):InventoryIndex{
 let index=inventoryIndices.get(inventory);
 if(!index){index={byId:new Map(),byPath:new Map(),byHost:new Map(),positions:new Map(),cas:new Map()};for(const entry of inventory.entries)indexEntry(index,entry);inventoryIndices.set(inventory,index);}
 return index;
}
function entriesAt(inventory:Inventory,rootId:string,path:string):Entry[]{return inventoryIndex(inventory).byPath.get(inventoryPathKey(rootId,path))??[];}
type Objection=z.infer<typeof objectionSchema>;
type Issue=z.infer<typeof issueSchema>;
type ScratchLease=z.infer<typeof scratchSchema>;
export interface CivicPolicyAuthorityReceipt {schemaVersion:'civic-policy-authority-v1';authorityId:string;authoritySha256:string;mode:'codex-workstation-local'|'isolated-fixture';provisionedAt:string}
export type PurgeReceipt=z.infer<typeof purgeSchema>;
export type RetireReceipt=z.infer<typeof RetireReceiptSchema>;
export type OptOutReceipt=Objection&{purge:PurgeReceipt};
export interface CivicPolicyOptions {stateDir?:string;authorityId?:string;authoritySha256?:string}
export interface CivicOptOutSnapshot {
 schemaVersion:'civic-opt-out-snapshot-v2';authorityId:string;authoritySha256:string;sha256:string;
 objections:Array<{hostSha256:string;receivedAt:string;purgeDueAt:string}>;
}
export type RetainedPublicationBinding=z.infer<typeof publicationBindingSchema>;
export type AuthenticatedGitSnapshotBinding=z.infer<typeof gitSnapshotBindingSchema>;
export type OperatorRegistryApproval=z.infer<typeof registryApprovalSchema>;
const sourceUrlSchema=z.string().refine(value=>{try{hostFromUrl(value);return true;}catch{return false;}},{message:'Public HTTP(S) source URL required'});
/** Closed wire codec only: live authority and exact inventory checks remain mandatory. */
export const ManagedSourceBindingSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('http_observation'),url:sourceUrlSchema,sourceSha256:hex,observationId:opaque,receiptSha256:hex}).strict(),
 z.object({kind:z.literal('prepared_source'),url:sourceUrlSchema,sourceSha256:hex,observationId:opaque,receiptSha256:hex}).strict(),
 z.object({kind:z.literal('retained_publication'),url:sourceUrlSchema,sourceSha256:hex.nullable().optional(),publication:publicationBindingSchema}).strict(),
 z.object({kind:z.literal('authenticated_git_snapshot'),purpose:z.literal('historical_change_reconstruction_only'),url:sourceUrlSchema,sourceSha256:hex.nullable().optional(),snapshot:gitSnapshotBindingSchema}).strict(),
 z.object({kind:z.literal('operator_registry_config'),url:sourceUrlSchema,configurationSha256:hex,schemaContractSha256:hex,code:gitSnapshotBindingSchema,approval:registryApprovalSchema}).strict(),
]).superRefine((value,ctx)=>{
 const normalized={...value,sourceSha256:'sourceSha256' in value?value.sourceSha256??null:null};
 if(!validProvenanceShape(normalized))ctx.addIssue({code:'custom',message:'Source provenance kind and proof differ'});
});
export type ManagedSourceBinding=z.infer<typeof ManagedSourceBindingSchema>;
export type ManagedSourceContent=ManagedSourceBinding&{relativePath:string;contentSha256:string;independentAllowed:boolean};
export type ManagedScratchBinding=ManagedSourceBinding|{phase:'pre-admission'|'preparation-input';url:string;sourceSha256:string};
export interface ManagedSourceReadOptions extends CivicPolicyOptions {sourceUrl?:string;purpose?:'historical_change_reconstruction_only'}
export interface ManagedSourceContext extends ManagedAcquisitionLaneOptions {root:string;bindings:ManagedScratchBinding[]}

export interface ManagedDockerSession {stdin:Writable;stdout:Readable;stderr:Readable;completion:Promise<{exitCode:number}>}
export interface ManagedDockerContainer {readonly id:string;readonly name:string;start():Promise<ManagedDockerSession>;wait():Promise<{exitCode:number}>;remove():Promise<void>}
export interface ManagedSourceScratch {
 directory:string;signal:AbortSignal;assertActive():Promise<void>;
 writeSource(relativePath:string,bytes:Uint8Array):Promise<void>;
 spawn(file:string,args:string[],options?:{env?:NodeJS.ProcessEnv}):Promise<ChildProcessWithoutNullStreams>;
 createContainer(options:ManagedDockerOptions):Promise<ManagedDockerContainer>;
}
export class HostOptedOutError extends Error {
 readonly code='HOST_OPTED_OUT';readonly host:string;
 constructor(host:string){super('Host acquisition and model use stopped by recorded objection');this.name='HostOptedOutError';this.host=host;}
}
export class CivicPolicyStateError extends Error {
 readonly code:string;
 constructor(code='CIVIC_POLICY_STATE_UNSAFE'){super('Civic policy state requires operator review');this.name='CivicPolicyStateError';this.code=code;}
}
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
function hostFromUrl(input:string):string {
 let url:URL;try{url=new URL(input);}catch{throw new CivicPolicyStateError('INVALID_HOST');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new CivicPolicyStateError('INVALID_HOST');
 const host=url.hostname.toLowerCase().replace(/\.$/,'');
 if(!host||host.length>253||host.includes('%'))throw new CivicPolicyStateError('INVALID_HOST');
 return host;
}
function canonicalHost(input:string):string {
 if(typeof input!=='string'||input!==input.trim()||/[\s/@?#\\]/.test(input))throw new CivicPolicyStateError('INVALID_HOST');
 const url=new URL('https://'+input);
 if(url.port)throw new CivicPolicyStateError('INVALID_HOST');
 return hostFromUrl(url.href);
}
function urlHash(input:string):string {
 const url=new URL(input);hostFromUrl(input);url.hostname=url.hostname.replace(/\.$/,'');url.hash='';return digest(url.href);
}
function statePath(options:CivicPolicyOptions):string{return resolve(options.stateDir??CIVIC_POLICY_STATE_DIR);}
function sameIdentity(a:{dev:number;ino:number},b:{dev:number;ino:number}){return a.dev===b.dev&&a.ino===b.ino;}
function contained(root:string,path:string):boolean{const child=relative(root,path);return !!child&&!child.startsWith('..'+sep)&&child!=='..'&&!isAbsolute(child);}
// No symlink component is accepted, including aliases such as macOS /tmp. Callers
// may explicitly resolve a trusted temporary directory before passing it here.
async function directory(path:string,create=false,privateLeaf=false):Promise<Stats>{
 const absolute=resolve(path),base=parse(absolute).root;let current=base,result=await lstat(base);
 for(const component of absolute.slice(base.length).split(sep).filter(Boolean)){
  current=join(current,component);
  if(create)try{await mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  result=await lstat(current);
  if(!result.isDirectory()||result.isSymbolicLink()||(result.mode&0o022)!==0&&(result.mode&0o1000)===0)throw new CivicPolicyStateError();
 }
 if(result.uid!==process.getuid?.()||privateLeaf&&(result.mode&0o077)!==0)throw new CivicPolicyStateError();
 return result;
}
async function fileBytes(path:string,maxBytes:number,privateFile=false):Promise<{bytes:Buffer;stat:Stats}>{
 await directory(dirname(path));
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await handle.stat();
  // Exclusive metadata publication briefly has the final and temporary names.
  // Source-content readers never accept hardlinks; private immutable registry
  // snapshots may have these two links without a false concurrent-read failure.
  if(!stat.isFile()||stat.nlink<1||stat.nlink>(privateFile?2:1)||stat.uid!==process.getuid?.()||(stat.mode&(privateFile?0o077:0o022))!==0||stat.size>maxBytes)throw new CivicPolicyStateError();
  const buffer=Buffer.allocUnsafe(stat.size+1);let total=0;
  while(total<buffer.length){const {bytesRead}=await handle.read(buffer,total,buffer.length-total,null);if(!bytesRead)break;total+=bytesRead;}
  const after=await handle.stat();
  if(total!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||!privateFile&&after.ctimeMs!==stat.ctimeMs||!sameIdentity(stat,await lstat(path)))throw new CivicPolicyStateError();
  return {bytes:buffer.subarray(0,total),stat};
 }finally{await handle.close();}
}
async function fileDigest(path:string):Promise<{sha256:string;stat:Stats}>{
 await directory(dirname(path));const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await handle.stat();
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o022)!==0||stat.size>MAX_CONTENT)throw new CivicPolicyStateError();
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let total=0;
  for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>MAX_CONTENT)throw new CivicPolicyStateError();hash.update(buffer.subarray(0,bytesRead));}
  const after=await handle.stat();if(stat.size!==total||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs||!sameIdentity(stat,await lstat(path)))throw new CivicPolicyStateError();
  return {sha256:hash.digest('hex'),stat};
 }finally{await handle.close();}
}
async function atomicJson(path:string,value:unknown,exclusive=false,privateDirectory=true,serialized?:string):Promise<void>{
 await directory(dirname(path),false,privateDirectory);const temporary=join(dirname(path),'.'+randomUUID()+'.tmp');
 const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile((serialized??JSON.stringify(value))+'\n');await handle.sync();}finally{await handle.close();}
 try{
  if(exclusive)await link(temporary,path);
  else{try{await fileBytes(path,MAX_STATE,true);}catch(error){if(!missing(error))throw error;}await rename(temporary,path);}
  const parent=await open(dirname(path),constants.O_RDONLY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
 }finally{try{await unlink(temporary);}catch(error){if(!missing(error))throw error;}}
}
async function requireInventoryEpoch(state:string,inventoryId:string):Promise<void>{
 const expected=Buffer.from('{"schemaVersion":1,"inventoryId":'+JSON.stringify(inventoryId)+',');
 // A locked writer atomically replaces the inventory. An already-open old
 // inode can lose its final link before fstat; reopen the published name only.
 for(let attempt=0;attempt<8;attempt++){
  const handle=await open(join(state,'inventory.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const stat=await handle.stat();
   if(stat.nlink===0)continue;
   if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.nlink!==1||stat.size<expected.length||stat.size>MAX_STATE)throw new CivicPolicyStateError('CIVIC_POLICY_INVENTORY_UNAVAILABLE');
   const prefix=Buffer.allocUnsafe(expected.length);let offset=0;
   while(offset<prefix.length){const {bytesRead}=await handle.read(prefix,offset,prefix.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
   if(offset!==prefix.length||!prefix.equals(expected))throw new CivicPolicyStateError('CIVIC_POLICY_INVENTORY_UNAVAILABLE');
   return;
  }finally{await handle.close();}
 }
 throw new CivicPolicyStateError('CIVIC_POLICY_INVENTORY_UNAVAILABLE');
}
interface AuthorityEnvironment {state:string;authorityId:string;mode:CivicPolicyAuthorityReceipt['mode'];machineSha256:string}
async function authorityEnvironment(options:CivicPolicyOptions):Promise<AuthorityEnvironment>{
 const state=statePath(options),authorityId=options.authorityId??CIVIC_POLICY_AUTHORITY_ID;
 if(fixtureAuthority.test(authorityId)){
  if(!options.stateDir||state===CIVIC_POLICY_STATE_DIR||contained(CIVIC_POLICY_STATE_DIR,state)||contained(state,CIVIC_POLICY_STATE_DIR))throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_FOREIGN');
  return {state,authorityId,mode:'isolated-fixture',machineSha256:digest(hostname())};
 }
 if(authorityId!==CIVIC_POLICY_AUTHORITY_ID||state!==CIVIC_POLICY_STATE_DIR||process.platform!=='linux'||hostname()!=='codex-workstation'||userInfo().username!=='max')throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_FOREIGN');
 // Owner-verified machine-id FILEBYTES digest, not a guessed SSH alias or raw ID.
 const handle=await open('/etc/machine-id',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.uid!==0||(stat.mode&0o022)!==0||stat.size<1||stat.size>4096)throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_FOREIGN');
  const bytes=Buffer.allocUnsafe(stat.size+1);let total=0;
  while(total<bytes.length){const result=await handle.read(bytes,total,bytes.length-total,null);if(!result.bytesRead)break;total+=result.bytesRead;}
  const after=await handle.stat(),machineSha256=digest(bytes.subarray(0,total));
  if(total!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||machineSha256!==CIVIC_MACHINE_ID_SHA256)throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_FOREIGN');
  return {state,authorityId,mode:'codex-workstation-local',machineSha256};
 }finally{await handle.close();}
}
/** Explicit owner operation on the designated VM. Never called by acquisition. */
export async function provisionCivicPolicyAuthority(options:Pick<CivicPolicyOptions,'stateDir'|'authorityId'>={}):Promise<CivicPolicyAuthorityReceipt>{
 let environment:AuthorityEnvironment;
 try{environment=await authorityEnvironment(options);}catch(error){if(error instanceof CivicPolicyStateError)throw error;throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_UNAVAILABLE');}
 const {state,authorityId,mode,machineSha256}=environment;
 return locked(options,async()=>{
  let value:z.infer<typeof authoritySchema>;
  try{value=authoritySchema.parse(JSON.parse((await fileBytes(join(state,AUTHORITY_MARKER),8192,true)).bytes.toString('utf8')));}
  catch(error){
   if(!missing(error))throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_UNAVAILABLE');
   // Only a genuinely empty first-time state directory may be provisioned.
   // Interrupted/lost state is repaired from its trusted original, never reset.
   for await(const entry of await opendir(state))if(entry.name!=='inventory.lock')throw new CivicPolicyStateError('CIVIC_POLICY_REPAIR_REQUIRED');
   await mkdir(join(state,'hosts'),{mode:0o700});await mkdir(join(state,'attempts'),{mode:0o700});
   const stat=await directory(state,false,true),hosts=await directory(join(state,'hosts'),false,true),attempts=await directory(join(state,'attempts'),false,true),inventoryId=randomUUID();
   await atomicJson(join(state,'inventory.json'),{schemaVersion:1,inventoryId,roots:[],entries:[],scratch:[]},true);
   value=authoritySchema.parse({schemaVersion:'civic-policy-authority-v1',authorityId,mode,stateId:digest(state),identity:{dev:stat.dev,ino:stat.ino},hostsIdentity:{dev:hosts.dev,ino:hosts.ino},attemptsIdentity:{dev:attempts.dev,ino:attempts.ino},inventoryId,machineSha256,provisionedAt:new Date().toISOString()});
   await atomicJson(join(state,AUTHORITY_MARKER),value,true);
  }
  return assertCivicPolicyAuthority({...options,authorityId,authoritySha256:digest(JSON.stringify(value))});
 },true);
}
/** A copied directory or missing marker is NOT an empty authoritative list. */
export async function assertCivicPolicyAuthority(options:CivicPolicyOptions={}):Promise<CivicPolicyAuthorityReceipt>{
 try{
  const environment=await authorityEnvironment(options),{state,authorityId,mode,machineSha256}=environment;
  if(mode==='isolated-fixture'&&!options.authoritySha256)throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_UNPINNED');
  const stat=await directory(state,false,true),value=authoritySchema.parse(JSON.parse((await fileBytes(join(state,AUTHORITY_MARKER),8192,true)).bytes.toString('utf8')));
  if(value.authorityId!==authorityId||value.mode!==mode)throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_MISMATCH');
  if(value.stateId!==digest(state)||!sameIdentity(value.identity,stat)||value.machineSha256!==machineSha256)throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_FOREIGN');
  if(!sameIdentity(value.hostsIdentity,await directory(join(state,'hosts'),false,true))||!sameIdentity(value.attemptsIdentity,await directory(join(state,'attempts'),false,true)))throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_FOREIGN');
  await requireInventoryEpoch(state,value.inventoryId);
  const authoritySha256=digest(JSON.stringify(value));
  if(options.authoritySha256!==undefined&&hex.parse(options.authoritySha256)!==authoritySha256)throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_MISMATCH');
  return {schemaVersion:value.schemaVersion,authorityId:value.authorityId,authoritySha256,mode:value.mode,provisionedAt:value.provisionedAt};
 }catch(error){if(error instanceof CivicPolicyStateError)throw error;throw new CivicPolicyStateError(missing(error)?'CIVIC_POLICY_AUTHORITY_UNPROVISIONED':'CIVIC_POLICY_AUTHORITY_UNAVAILABLE');}
}
function objectionPath(state:string,host:string){return join(state,'hosts',digest(host)+'.json');}
async function readObjection(state:string,host:string):Promise<Objection|undefined>{
 try{await directory(state,false,true);}catch{throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_UNAVAILABLE');}
 try{await directory(join(state,'hosts'),false,true);}catch{throw new CivicPolicyStateError();}
 let initial:Buffer|undefined;
 try{initial=(await fileBytes(objectionPath(state,host),8192,true)).bytes;}catch(error){if(!missing(error))throw new CivicPolicyStateError();}
 try{
  const prefix=digest(host)+'-',revisions:string[]=[];let count=0;
  for await(const entry of await opendir(join(state,'hosts'))){if(++count>MAX_FILES)throw new CivicPolicyStateError();if(entry.name.startsWith(prefix)){if(revisions.length>=10_000)throw new CivicPolicyStateError();revisions.push(entry.name);}}
  if(initial===undefined){if(revisions.length)throw new CivicPolicyStateError('CIVIC_POLICY_ORPHAN_OBJECTION');return undefined;}
  let value=objectionSchema.parse(JSON.parse(initial.toString('utf8')));
  for(const name of [null,...revisions]){
   if(name!==null&&!/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name))throw new CivicPolicyStateError();
   const candidate=name===null?value:objectionSchema.parse(JSON.parse((await fileBytes(join(state,'hosts',name),8192,true)).bytes.toString('utf8')));
   if(candidate.host!==host||canonicalHost(candidate.host)!==host||Date.parse(candidate.purgeDueAt)>Date.parse(candidate.receivedAt)+WEEK||Date.parse(candidate.purgeDueAt)<Date.parse(candidate.receivedAt))throw new CivicPolicyStateError();
   if(Date.parse(candidate.receivedAt)<Date.parse(value.receivedAt))value=candidate;
  }
  return value;
 }catch{throw new CivicPolicyStateError();}
}
/** Read-only, uncached and fail-closed. Call at every request, cache and model boundary. */
export async function assertHostNotOptedOut(url:string,options:CivicPolicyOptions={}):Promise<void>{
 await assertCivicPolicyAuthority(options);const host=hostFromUrl(url);if(await readObjection(statePath(options),host))throw new HostOptedOutError(host);await assertCivicPolicyAuthority(options);
}
/** One live boundary over many URL bindings. Validate every URL, but an
 * objection is host-wide: read each canonical host once in first-seen order.
 * The set is discarded on return; callers must recheck at their next boundary.
 */
export async function assertSourceHostsNotOptedOut(urls:Iterable<string>,options:CivicPolicyOptions={}):Promise<void>{
 const checked=new Set<string>();
 for(const url of urls){const host=hostFromUrl(url);if(!checked.has(host)){await assertHostNotOptedOut(url,options);checked.add(host);}}
}
function snapshotStamp(stat:BigIntStats):string{
 return [stat.dev,stat.ino,stat.mode,stat.uid,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
}
async function snapshotHostDirectory(state:string):Promise<{directory:string;members:Array<{name:string;stamp:string}>}>{
 try{
  const path=join(state,'hosts');await directory(state,false,true);await directory(path,false,true);
  const before=await lstat(path,{bigint:true}),members:Array<{name:string;stamp:string}>=[];
  for await(const entry of await opendir(path)){
   if(members.length>=MAX_FILES)throw new CivicPolicyStateError();
   // A publishing temporary means the attempted observation was concurrent,
   // even if the final host marker has not yet become visible.
   if(/^\.[a-f0-9-]+\.tmp$/.test(entry.name))throw new CivicPolicyStateError('CIVIC_POLICY_BUSY');
   if(!/^[a-f0-9]{64}(?:-[a-f0-9]{64})?\.json$/.test(entry.name))throw new CivicPolicyStateError();
   const stat=await lstat(join(path,entry.name),{bigint:true});
   if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==BigInt(process.getuid!())||(stat.mode&0o077n)!==0n||stat.nlink!==1n||stat.size>8192n)throw new CivicPolicyStateError();
   members.push({name:entry.name,stamp:snapshotStamp(stat)});
  }
  const after=await lstat(path,{bigint:true});
  if(!before.isDirectory()||before.isSymbolicLink()||snapshotStamp(before)!==snapshotStamp(after))throw new CivicPolicyStateError('CIVIC_POLICY_BUSY');
  members.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);return {directory:snapshotStamp(after),members};
 }catch(error){if(missing(error))throw new CivicPolicyStateError('CIVIC_POLICY_BUSY');if(error instanceof CivicPolicyStateError)throw error;throw new CivicPolicyStateError();}
}
/** Read-only audit evidence, NOT an authorization or an acquisition receipt.
 * The hash binds JSON.stringify({schemaVersion,authorityId,authoritySha256,objections});
 * returned here. No contacts, opaque references, local paths, raw host names,
 * inventories or purge statuses enter that public projection.
 * Objections publish outside the inventory lock, so both directory membership
 * and nanosecond file identities must remain stable across the whole read.
 * Call assertHostNotOptedOut independently at every live/model/release boundary.
 */
export async function readCivicOptOutSnapshot(options:CivicPolicyOptions={}):Promise<CivicOptOutSnapshot>{
 const state=statePath(options),schemaVersion='civic-opt-out-snapshot-v2' as const,authority=await assertCivicPolicyAuthority(options);
 const before=await snapshotHostDirectory(state),primary=new Set(before.members.filter(item=>/^[a-f0-9]{64}\.json$/.test(item.name)).map(item=>item.name.slice(0,64)));
 const selected=new Map<string,CivicOptOutSnapshot['objections'][number]>();
 try{
  for(const member of before.members){
   const value=objectionSchema.parse(JSON.parse((await fileBytes(join(state,'hosts',member.name),8192,true)).bytes.toString('utf8'))),hostSha256=digest(value.host);
   if(canonicalHost(value.host)!==value.host||!primary.has(hostSha256)||member.name!==hostSha256+'.json'&&member.name!==hostSha256+'-'+digest(value.receivedAt)+'.json'||Date.parse(value.purgeDueAt)<Date.parse(value.receivedAt)||Date.parse(value.purgeDueAt)>Date.parse(value.receivedAt)+WEEK)throw new CivicPolicyStateError();
   const receivedAt=new Date(value.receivedAt).toISOString(),purgeDueAt=new Date(value.purgeDueAt).toISOString(),prior=selected.get(hostSha256);
   if(!prior)selected.set(hostSha256,{hostSha256,receivedAt,purgeDueAt});
   else{if(Date.parse(receivedAt)<Date.parse(prior.receivedAt))prior.receivedAt=receivedAt;if(Date.parse(purgeDueAt)<Date.parse(prior.purgeDueAt))prior.purgeDueAt=purgeDueAt;}
  }
 }catch(error){if(missing(error))throw new CivicPolicyStateError('CIVIC_POLICY_BUSY');if(error instanceof CivicPolicyStateError)throw error;throw new CivicPolicyStateError();}
 const after=await snapshotHostDirectory(state);
 if(JSON.stringify(before)!==JSON.stringify(after))throw new CivicPolicyStateError('CIVIC_POLICY_BUSY');
 await assertCivicPolicyAuthority({...options,authoritySha256:authority.authoritySha256});
 const objections=[...selected.values()].sort((a,b)=>a.hostSha256<b.hostSha256?-1:a.hostSha256>b.hostSha256?1:0),body={schemaVersion,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256,objections};
 return {...body,sha256:digest(JSON.stringify(body))};
}
const queues=new Map<string,Promise<void>>();
const nextLockAttempt=new Map<string,number>();
async function hasInventoryWaiters(state:string):Promise<boolean>{
 for await(const entry of await opendir(state)){
  if(!entry.name.startsWith('inventory.wait-'))continue;
  if(!/^inventory\.wait-[a-f0-9-]{36}$/.test(entry.name))throw new CivicPolicyStateError();
  try{
   const stat=await lstat(join(state,entry.name));
   if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.size!==0)throw new CivicPolicyStateError();
   return true;
  }catch(error){if(!missing(error))throw error;}
 }
 return false;
}
async function locked<T>(options:CivicPolicyOptions,work:()=>Promise<T>,provisioning=false):Promise<T>{
 const state=statePath(options);
 const prior=queues.get(state)??Promise.resolve();let done!:()=>void;const gate=new Promise<void>(resolve=>{done=resolve;});queues.set(state,gate);await prior;
 const path=join(state,'inventory.lock');let handle:FileHandle|undefined,waiting:FileHandle|undefined,waitingIdentity:Stats|undefined;
 let waitingPath:string|undefined;
 const stopWaiting=async()=>{
  if(!waiting)return;
  try{const current=await lstat(waitingPath!);if(!waitingIdentity||!sameIdentity(waitingIdentity,current)||current.isSymbolicLink())throw new CivicPolicyStateError();await unlink(waitingPath!);}
  finally{await waiting.close();waiting=undefined;}
 };
 try{
  if(provisioning)await directory(state,true,true);else await assertCivicPolicyAuthority(options);
  if(!provisioning)await warmInventorySegments(state);
  const cooldown=(nextLockAttempt.get(state)??0)-performance.now();
  if(cooldown>0&&await hasInventoryWaiters(state))await new Promise<void>(resolve=>setTimeout(resolve,cooldown));
  const deadline=performance.now()+5_000;
  for(;;){
   try{handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);break;}
   catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    if(performance.now()>=deadline)throw new CivicPolicyStateError('CIVIC_POLICY_BUSY');
    try{const current=await lstat(path);if(!current.isFile()||current.isSymbolicLink()||current.uid!==process.getuid?.()||current.nlink!==1||(current.mode&0o077)!==0||current.size>8192)throw new CivicPolicyStateError();}
    catch(inspectError){if(missing(inspectError))continue;throw inspectError;}
    if(!provisioning&&!waiting){waitingPath=join(state,'inventory.wait-'+randomUUID());waiting=await open(waitingPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);waitingIdentity=await waiting.stat();}
    await new Promise<void>(resolve=>setTimeout(resolve,25));
   }
  }
  const original=await handle.stat();
  try{
   await stopWaiting();
   await handle.writeFile(JSON.stringify({pid:process.pid,nonce:randomUUID()})+'\n');await handle.sync();
   if(!provisioning)await assertCivicPolicyAuthority(options);
   return await work();
  }finally{const current=await lstat(path);if(!sameIdentity(original,current)||current.isSymbolicLink())throw new CivicPolicyStateError();await unlink(path);nextLockAttempt.set(state,performance.now()+50);}
 }finally{try{try{await stopWaiting();}finally{await handle?.close();}}finally{done();if(queues.get(state)===gate)queues.delete(state);}}
}
function entryId(entry:Omit<Entry,'id'|'state'>):string{return digest(JSON.stringify([entry.rootId,entry.relativePath,entry.contentSha256,entry.kind,entry.sourceSha256,entry.host,entry.urlSha256,entry.observationId??null,entry.receiptSha256??null,entry.publication??null,entry.snapshot??null,entry.purpose??null,entry.configurationSha256??null,entry.schemaContractSha256??null,entry.code??null,entry.approval??null,entry.independentAllowed]));}
function checkedRelative(root:Root,path:string,contentSha256:string,receiptSha256?:string):string{
 if(path.includes('\\')||path.includes('\0')||isAbsolute(path)||path.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw new CivicPolicyStateError();
 const derivedFetch=/^(?:oparl-bodies|frontiers)\/[a-f0-9]{64}\.json$/.test(path)||/^api-frontiers\/[a-f0-9]{64}-mv\.json$/.test(path)||/^oparl\/[a-f0-9]{64}\/(?:paper|meeting)\/page-\d+\.json$/.test(path)||/^observations\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/.test(path)||/^requests\/[a-f0-9]{64}\.json$/.test(path)||/^collections\/[a-z0-9][a-z0-9-]{0,159}-(?:collection\.json|signals\.geojson)$/.test(path);
 const shardedCas=path==='sha256/'+contentSha256.slice(0,2)+'/'+contentSha256;
 const artifactPath=path.split('/').length<=12&&path.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(part)&&!/^(?:credentials?|secrets?|auth|tokens?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(part))&&/\.(?:json|jsonl|geojson|txt|md)$/.test(path);
 const valid=root.kind==='fetch'?path==='sha256/'+contentSha256||derivedFetch:root.kind==='prepared'?path===receiptSha256+'.json':path.startsWith('sha256/')?shardedCas:artifactPath;
 if(!valid||!contained(root.path,join(root.path,path)))throw new CivicPolicyStateError();return path;
}
function sourceProvenance(input:ManagedSourceBinding){
 if(input.kind==='operator_registry_config'){
  const value={kind:input.kind,sourceSha256:null,configurationSha256:hex.parse(input.configurationSha256),schemaContractSha256:hex.parse(input.schemaContractSha256),code:gitSnapshotBindingSchema.parse(input.code),approval:registryApprovalSchema.parse(input.approval)};
  if(!validProvenanceShape(value))throw new CivicPolicyStateError('REGISTRY_CONFIGURATION_PROVENANCE_MISMATCH');return value;
 }
 if(input.kind==='authenticated_git_snapshot'){if(input.purpose!=='historical_change_reconstruction_only')throw new CivicPolicyStateError('HISTORICAL_SOURCE_PURPOSE_REQUIRED');return {kind:input.kind,purpose:input.purpose,sourceSha256:input.sourceSha256==null?null:hex.parse(input.sourceSha256),snapshot:gitSnapshotBindingSchema.parse(input.snapshot)};}
 if(input.kind==='retained_publication')return {kind:input.kind,sourceSha256:input.sourceSha256==null?null:hex.parse(input.sourceSha256),publication:publicationBindingSchema.parse(input.publication)};
 if(input.kind!=='http_observation'&&input.kind!=='prepared_source')throw new CivicPolicyStateError('SOURCE_PROVENANCE_KIND_REQUIRED');
 return {kind:input.kind,sourceSha256:hex.parse(input.sourceSha256),observationId:opaque.parse(input.observationId),receiptSha256:hex.parse(input.receiptSha256)};
}
function makeEntry(root:Root,input:ManagedSourceContent):Entry{
 const provenance=sourceProvenance(input),contentSha256=hex.parse(input.contentSha256),receiptSha256='receiptSha256' in provenance?provenance.receiptSha256:undefined;
 if(['retained_publication','authenticated_git_snapshot','operator_registry_config'].includes(input.kind)&&input.independentAllowed||['authenticated_git_snapshot','operator_registry_config'].includes(input.kind)&&root.kind!=='artifacts'||root.kind==='fetch'&&input.relativePath.startsWith('sha256/')&&(input.kind!=='http_observation'||provenance.sourceSha256!==contentSha256))throw new CivicPolicyStateError('SOURCE_PROVENANCE_KIND_MISMATCH');
 const value={rootId:root.id,relativePath:checkedRelative(root,input.relativePath,contentSha256,receiptSha256),contentSha256,...provenance,host:hostFromUrl(input.url),urlSha256:urlHash(input.url),independentAllowed:z.boolean().parse(input.independentAllowed)};
 return entrySchema.parse({...value,id:entryId(value),state:'active'});
}
async function loadInventory(state:string):Promise<Inventory>{
 let value:Inventory,bytes:Buffer,sha256:string,validated:boolean,physical:unknown;
 try{
  bytes=(await fileBytes(join(state,'inventory.json'),MAX_STATE,true)).bytes;sha256=digest(bytes);
  validated=validatedInventoryBytes.get(state)===sha256;
  physical=JSON.parse(bytes.toString('utf8'));
  if(physical&&typeof physical==='object'&&'storage' in physical){
   const parsed=hotInventorySchema.parse(physical);physical=parsed;value=await hydrateInventory(state,parsed);
  }else{value=validated?physical as Inventory:inventorySchema.parse(physical);physical=value;}
  const authority=authoritySchema.parse(JSON.parse((await fileBytes(join(state,AUTHORITY_MARKER),8192,true)).bytes.toString('utf8')));if(value.inventoryId!==authority.inventoryId)throw new CivicPolicyStateError('CIVIC_POLICY_INVENTORY_UNAVAILABLE');
 }catch{validatedInventoryBytes.delete(state);throw new CivicPolicyStateError('CIVIC_POLICY_INVENTORY_UNAVAILABLE');}
 if(validated)return value;
 const roots=new Map(value.roots.map(root=>[root.id,root]));
 if(roots.size!==value.roots.length||inventoryIndex(value).byId.size!==value.entries.length)throw new CivicPolicyStateError();
 for(const root of value.roots)if(root.id!==digest(root.path)||root.path!==resolve(root.path))throw new CivicPolicyStateError();
 for(const entry of value.entries){
  const root=roots.get(entry.rootId);if(!root)throw new CivicPolicyStateError();
  if(validatedSegmentEntries.get(entry)===root.kind)continue;
  if(entry.host!==canonicalHost(entry.host)||entry.id!==entryId(entry)||root.kind==='fetch'&&entry.relativePath.startsWith('sha256/')&&entry.sourceSha256!==entry.contentSha256)throw new CivicPolicyStateError();
  checkedRelative(root,entry.relativePath,entry.contentSha256,entry.receiptSha256);
  if(Object.isFrozen(entry))validatedSegmentEntries.set(entry,root.kind);
 }
 if(new Set(value.scratch.map(lease=>lease.id)).size!==value.scratch.length)throw new CivicPolicyStateError();
 for(const lease of value.scratch){
  if(!roots.has(lease.rootId))throw new CivicPolicyStateError();
  if(validatedSegmentLeases.has(lease))continue;
  if(!roots.has(lease.rootId)||lease.directory!=='scratch/'+lease.id||lease.sources.some(source=>source.host!==canonicalHost(source.host)||source.kind==='pre_admission'&&lease.purpose!=='classification'||source.kind==='preparation_input'&&lease.purpose!=='document'||['authenticated_git_snapshot','operator_registry_config'].includes(source.kind)&&lease.purpose!=='artifact'))throw new CivicPolicyStateError();
  if(new Set(lease.resources.map(resource=>resource.id)).size!==lease.resources.length||lease.resources.some(resource=>resource.scratchId!==lease.id||resource.rootId!==lease.rootId||resource.name!==('profile' in resource?'stadtstack-omp-b-':'stadtstack-parser-')+lease.id+'-'+resource.nonce||resource.artifactRelativePath===null&&(resource.artifactSha256!==null||resource.artifactBytes!==null)||resource.artifactRelativePath!==null&&(resource.artifactSha256===null||resource.artifactBytes===null)))throw new CivicPolicyStateError('DAEMON_RESOURCE_BINDING_MISMATCH');
  if(Object.isFrozen(lease))validatedSegmentLeases.add(lease);
 }
 if(bytes.equals(Buffer.from(JSON.stringify(physical)+'\n')))validatedInventoryBytes.set(state,sha256);
 return value;
}
async function saveInventory(state:string,value:Inventory){
 const sealed=sealedInventories.get(value);
 if(sealed){
  const entries:Entry[]=[],scratch:ScratchLease[]=[],addedEntries:Entry[]=[],addedScratch:ScratchLease[]=[],entryStates:Record<string,Entry['state']>={};
  const roots=new Set(value.roots.map(root=>root.id)),retiredRoots={...sealed.storage.retiredRoots};
  const lastSegment=sealed.storage.segments.at(-1)?.sha256;
  const retired=[...sealed.roots].some(rootId=>!roots.has(rootId));
  if(lastSegment)for(const rootId of sealed.roots)if(!roots.has(rootId))retiredRoots[rootId]=lastSegment;
  for(const entry of value.entries){
   const original=sealed.entries.get(entry.id);
   if(original){if(entry!==original&&entry.state!==original.state)entryStates[entry.id]=entry.state;}
   else if(bulkEntry(entry))addedEntries.push(entry);else entries.push(entry);
  }
  for(const lease of value.scratch)if(!sealed.scratch.has(lease.id)){if(archivedLease(lease))addedScratch.push(lease);else scratch.push(lease);}
  const plan=planInventorySegments(value.inventoryId,sealed.storage.segments,addedEntries,addedScratch);
  for(const segment of plan.added)await publishSegment(state,segment);
  const parsed=hotInventorySchema.parse({schemaVersion:1,inventoryId:value.inventoryId,roots:value.roots,entries,scratch,storage:{format:'sealed-segments-v1',segments:plan.pins,entryStates,retiredRoots}});
  const serialized=JSON.stringify(parsed);
  if(Buffer.byteLength(serialized)+1>MAX_STATE)throw new CivicPolicyStateError();
  await atomicJson(join(state,'inventory.json'),parsed,false,true,serialized);
  for(const segment of plan.added){const stored=await readSegment(state,segment.pin,value.inventoryId);for(const entry of stored.entries)sealed.entries.set(entry.id,entry);for(const lease of stored.scratch)sealed.scratch.set(lease.id,lease);}
  if(retired){
   for(const [id,entry] of sealed.entries)if(!roots.has(entry.rootId))sealed.entries.delete(id);
   for(const [id,lease] of sealed.scratch)if(!roots.has(lease.rootId))sealed.scratch.delete(id);
  }
  sealed.roots=roots;sealed.storage=parsed.storage;validatedInventoryBytes.set(state,digest(serialized+'\n'));return;
 }
 const parsed=inventorySchema.parse(value);
 const serialized=JSON.stringify(parsed);
 if(Buffer.byteLength(serialized)+1>MAX_STATE)throw new CivicPolicyStateError();
 await atomicJson(join(state,'inventory.json'),parsed,false,true,serialized);
 validatedInventoryBytes.set(state,digest(serialized+'\n'));
}
async function verifyRoot(root:Root){if(!sameIdentity(root.identity,await directory(root.path)))throw new CivicPolicyStateError();}
function mergeEntries(inventory:Inventory,entries:Entry[]){
 const index=inventoryIndex(inventory);
 for(const entry of entries){const old=index.byId.get(entry.id);if(old){if(old.state!=='active')throw new CivicPolicyStateError('CONTENT_REFERENCE_REVOKED');continue;}
  const binding=index.cas.get(inventoryPathKey(entry.rootId,entry.relativePath));
  if(entry.relativePath==='sha256/'+entry.contentSha256&&binding&&(binding.conflicting||binding.contentSha256!==entry.contentSha256||binding.sourceSha256!==entry.sourceSha256))throw new CivicPolicyStateError();inventory.entries.push(entry);indexEntry(index,entry);
 }
}
function independentPolicy(raw:unknown,url:string,sha256:string):boolean{
 const policy=SourceAccessPolicySchema.safeParse(raw);
 return policy.success&&effectiveSourcePermission(policy.data,{url,sha256});
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';return JSON.stringify(value);
}
/** Pure metadata validation; does not read an artifact or grant source access. */
export async function parseContentFreePreparationPlan(value:unknown):Promise<import('./district-preparation-run.ts').PreparationPlan>{
 // A static import cannot work: preparation-run constructs schemas from
 // prepared-document, which itself imports this lifecycle module.
 const {preparationPlanSchema,preparationGroupSchema,preparedExpectationSchema}=await import('./district-preparation-run.ts');
 const failure=z.enum(['Structured output/schema validation failed','Extraction failed; see source-bound quarantine identity']);
 const municipality=preparationGroupSchema.shape.municipality.extend({name:z.string().min(1).max(160),districtId:opaque}).strict();
 const reference=preparedExpectationSchema.shape.references.element.extend({id:opaque,locator:z.string().regex(/^document-sha256:[a-f0-9]{64}$/),mimeType:z.string().regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/),policy:ContentFreeSourcePolicySchema}).strict();
 const group=preparationGroupSchema.extend({municipality,documentIds:z.array(opaque).min(1).max(MAX_FILES),expected:preparedExpectationSchema.extend({references:z.array(reference).min(1).max(MAX_FILES)}).strict(),referenceWarnings:z.array(z.object({documentId:opaque,sourceId:opaque,reason:failure}).strict()).max(MAX_FILES)}).strict();
 const quarantine=preparationPlanSchema.shape.quarantine.element.omit({candidate:true}).extend({documentId:opaque,municipalityId:opaque,sourceId:opaque,reason:failure}).strict();
 const metadataSchema=preparationPlanSchema.extend({municipalities:z.array(preparationPlanSchema.shape.municipalities.element.extend({name:municipality.shape.name,districtId:opaque}).strict()).max(MAX_FILES),groups:z.array(group).max(MAX_FILES),quarantine:z.array(quarantine).max(MAX_FILES)}).strict();
 const metadata=metadataSchema.parse(value),original=canonical(value);
 // Parsing must not strip nested unknown fields or normalize away source text.
 if(Buffer.byteLength(original)>MAX_STATE||original!==canonical(metadata))throw new CivicPolicyStateError('INVALID_PREPARATION_METADATA');
 return metadata;
}
function accountObservationCopy(root:Root,inventory:Inventory,path:string,bytes:Buffer,observation:z.infer<typeof observationSchema>,receipt?:{observationId:string;receiptSha256:string}):'metadata'|'source'|'unbound'{
 const contentSha256=digest(bytes),prior=entriesAt(inventory,root.id,path);
 if(observation.policy===undefined||ContentFreeSourcePolicySchema.safeParse(observation.policy).success){
  // A verified content-free replacement can retire the prior unsafe version;
  // it cannot erase an explicit source-content binding to these exact bytes.
  for(const entry of prior)if(entry.contentSha256!==contentSha256&&(entry.state==='active'||entry.state==='revoked'))setEntryState(inventory,entry,'missing');
  return prior.some(entry=>entry.contentSha256===contentSha256)?'source':'metadata';
 }
 const sourceSha256=hex.safeParse(observation.sha256);if(!sourceSha256.success||!receipt)return 'unbound';
 const entry=makeEntry(root,{kind:'http_observation',relativePath:path,contentSha256,sourceSha256:sourceSha256.data,url:observation.url,...receipt,independentAllowed:false});
 if(!inventoryIndex(inventory).byId.has(entry.id))mergeEntries(inventory,[entry]);return 'source';
}
// Registration is explicit: this never searches home, other worktrees or remote
// machines. Known formats are inventoried only inside the supplied managed root.
async function reconcile(root:Root,inventory:Inventory,retiring=false):Promise<boolean>{
 await verifyRoot(root);let complete=true,count=0;const paths=new Set<string>(),requests:string[]=[],receipts=new Map<string,{observationId:string;receiptSha256:string}>();
 const visit=async(folder:string):Promise<void>=>{
  for await(const child of await opendir(join(root.path,folder))){if(++count>MAX_FILES)throw new CivicPolicyStateError();const path=folder?folder+'/'+child.name:child.name,stat=await lstat(join(root.path,path));
   if(stat.isSymbolicLink()){complete=false;continue;}
   if(stat.isDirectory()){
    if(folder==='scratch'){
     const lease=inventory.scratch.find(item=>item.rootId===root.id&&item.directory===path);
     if(!lease){complete=false;continue;}
     if(lease.state==='closed'||lease.state==='purged'){
      if(!retiring){complete=false;continue;}
      try{const tree=await inspectScratchTree(root,lease);if(tree?.files.length)complete=false;}catch{complete=false;}continue;
     }
     try{await inspectScratchTree(root,lease);}catch{complete=false;}continue;
    }
    const allowed=path==='scratch'||(root.kind==='fetch'?/^(?:sha256|observations|requests|pdf-tdm-policy|oparl-bodies|api-frontiers|frontiers|collections|oparl(?:\/[a-f0-9]{64}(?:\/(?:paper|meeting))?)?)$/.test(path):root.kind==='prepared'?/^(?:indexes|plans)$/.test(path):path.startsWith('sha256')?/^sha256(?:\/[a-f0-9]{2})?$/.test(path):path.split('/').length<=12&&path.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(part)&&!/^(?:credentials?|secrets?|auth|tokens?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(part)));
    if(!allowed){complete=false;continue;}await directory(join(root.path,path));await visit(path);continue;
   }
   if(!stat.isFile()){complete=false;continue;}
   if(!folder&&child.name===LANE_MARKER){
    try{await readAcquisitionLaneMarker(root.path,root.kind);}catch{complete=false;}continue;
   }
   // Retirement accepts only already inventoried bytes, not metadata that
   // normal reconciliation can discover or deliberately retain.
   if(retiring){paths.add(path);continue;}
   if(root.kind==='fetch'&&/^observations\/[A-Za-z0-9._-]+\.json$/.test(path)){
    try{const {bytes}=await fileBytes(join(root.path,path),MAX_STATE),observation=observationSchema.parse(JSON.parse(bytes.toString('utf8')));
     const receipt={observationId:basename(path),receiptSha256:digest(bytes)};
     if(hex.safeParse(observation.sha256).success)receipts.set(urlHash(observation.url)+':'+observation.sha256,receipt);
     const disposition=accountObservationCopy(root,inventory,path,bytes,observation,receipt);if(disposition!=='metadata')paths.add(path);if(disposition==='unbound')complete=false;
     if(['fetched','not_modified'].includes(observation.state)&&hex.safeParse(observation.sha256).success){
      const sourceSha256=hex.parse(observation.sha256),entry=makeEntry(root,{kind:'http_observation',relativePath:'sha256/'+sourceSha256,contentSha256:sourceSha256,sourceSha256,url:observation.url,observationId:basename(path),receiptSha256:digest(bytes),independentAllowed:independentPolicy(observation.policy,observation.url,sourceSha256)});
      if(!inventoryIndex(inventory).byId.has(entry.id))mergeEntries(inventory,[entry]);
     }else if(!['failed','redirected','excluded','opted_out'].includes(observation.state))complete=false;
    }catch{complete=false;}continue;
   }
   if(root.kind==='fetch'&&/^requests\/[a-f0-9]{64}\.json$/.test(path)){
    requests.push(path);continue;
   }
   if(root.kind==='fetch'&&/^pdf-tdm-policy\/[A-Za-z0-9.+-]+-[a-f0-9]{64}\.json$/.test(path)){
    try{const value=pdfPolicySchema.parse(JSON.parse((await fileBytes(join(root.path,path),8192)).bytes.toString('utf8')));if(!path.endsWith('-'+value.sha256+'.json'))complete=false;}catch{complete=false;}continue;
   }
   if(root.kind==='fetch'&&/^frontiers\/[a-f0-9]{64}\.json$/.test(path)){
    if(entriesAt(inventory,root.id,path).length){paths.add(path);continue;}
    try{frontierMetadataSchema.parse(JSON.parse((await fileBytes(join(root.path,path),MAX_STATE)).bytes.toString('utf8')));}catch{complete=false;}continue;
   }
   if(root.kind==='fetch'&&/^oparl\/[a-f0-9]{64}\/(?:paper|meeting)\/checkpoint\.json$/.test(path)){
    try{checkpointMetadataSchema.parse(JSON.parse((await fileBytes(join(root.path,path),MAX_STATE)).bytes.toString('utf8')));}catch{complete=false;}continue;
   }
   if(root.kind==='artifacts'&&/^[a-f0-9]{64}\.answer\.lock$/.test(path)){
    try{z.object({pid:z.number().int().positive(),nonce:z.string().uuid()}).strict().parse(JSON.parse((await fileBytes(join(root.path,path),8192,true)).bytes.toString('utf8')));}catch{complete=false;}continue;
   }
   if(root.kind==='prepared'&&/^indexes\/[a-f0-9]{64}\.json$/.test(path)){
    try{z.object({receiptSha256:hex}).strict().parse(JSON.parse((await fileBytes(join(root.path,path),8192)).bytes.toString('utf8')));}catch{complete=false;}continue;
   }
   if(root.kind==='prepared'&&/^plans\/[a-f0-9]{64}\.json$/.test(path)){
    try{
     const {bytes}=await fileBytes(join(root.path,path),MAX_STATE);
     await parseContentFreePreparationPlan(JSON.parse(bytes.toString('utf8')));
     if(basename(path)!==digest(bytes)+'.json')complete=false;
    }catch{complete=false;}continue;
   }
   if(root.kind==='prepared'&&/^[a-f0-9]{64}\.json$/.test(path)){
    try{const {bytes}=await fileBytes(join(root.path,path),MAX_CONTENT),value=JSON.parse(bytes.toString('utf8')),{receiptSha256,...body}=value;
     if(!['district-prepared-v1','district-prepared-v2'].includes(value.version)||receiptSha256!==path.slice(0,-5)||digest(canonical(body))!==receiptSha256||typeof value.text!=='string'||digest(value.text)!==value.textSha256||value.textLength!==value.text.length||value.offsetUnit!=='utf16_code_units'||!Number.isSafeInteger(value.sourceBytes)||value.sourceBytes<1||value.sourceBytes>MAX_CONTENT||!Array.isArray(value.references)||!value.references.length)throw new CivicPolicyStateError();
     if(value.version==='district-prepared-v2'&&(value.toolVersions?.parser_isolation!=='district-parser-isolation-v1'||!/^sha256:[a-f0-9]{64}$/.test(value.toolVersions?.parser_image??'')||!hex.safeParse(value.toolVersions?.parser_contract).success))throw new CivicPolicyStateError('PREPARED_PARSER_CONTRACT_MISSING');
     for(const ref of value.references){if(ref.sha256!==value.sourceSha256)throw new CivicPolicyStateError();const entry=makeEntry(root,{kind:'prepared_source',relativePath:path,contentSha256:digest(bytes),sourceSha256:value.sourceSha256,url:ref.url,observationId:ref.id,receiptSha256,independentAllowed:independentPolicy(ref.policy,ref.url,value.sourceSha256)});if(!inventoryIndex(inventory).byId.has(entry.id))mergeEntries(inventory,[entry]);}
    }catch{complete=false;}
   }
   paths.add(path);
  }
 };
 await visit('');
 for(const path of requests){
  try{const {bytes}=await fileBytes(join(root.path,path),MAX_STATE),value=observationSchema.parse(JSON.parse(bytes.toString('utf8'))),receipt=receipts.get(urlHash(value.url)+':'+value.sha256),disposition=accountObservationCopy(root,inventory,path,bytes,value,receipt);if(disposition!=='metadata')paths.add(path);if(disposition==='unbound')complete=false;}catch{complete=false;}
 }
 for(const path of paths){const entries=entriesAt(inventory,root.id,path);
  if(!entries.length){complete=false;continue;}
  try{
   const actual=await fileDigest(join(root.path,path)),current=entries.filter(entry=>entry.contentSha256===actual.sha256);
   if(!current.length)complete=false;
   // A restored copy does not become exempt merely because its prior reference
   // was tombstoned. Keep it withdrawn and eligible for a renewed purge.
   for(const entry of current)if(entry.state==='deleted'||entry.state==='missing')setEntryState(inventory,entry,'revoked');
  }catch{complete=false;}
 }
 return complete;
}
function managedRootPath(input:string,state:string):string{
 const path=resolve(input);
 if(path===parse(path).root||path===homedir()||path===state||contained(path,state)||contained(state,path)||path.split(sep).some(part=>part==='.secrets'||part==='.ssh'||part==='.git'))throw new CivicPolicyStateError();
 return path;
}
function assertManagedRootDisjoint(inventory:Inventory,path:string):void{
 if(inventory.roots.some(root=>contained(root.path,path)||contained(path,root.path)))throw new CivicPolicyStateError();
}
async function reconcileManagedRoot(inventory:Inventory,path:string,kind:Root['kind']):Promise<Root>{
 assertManagedRootDisjoint(inventory,path);
 const stat=await directory(path,true),id=digest(path);let root=inventory.roots.find(root=>root.id===id);
 if(root){if(root.kind!==kind||!sameIdentity(root.identity,stat))throw new CivicPolicyStateError();}
 else{root={id,path,kind,identity:{dev:stat.dev,ino:stat.ino},complete:false};inventory.roots.push(root);}
 root.complete=await reconcile(root,inventory);return root;
}
async function enrollRoot(state:string,path:string,kind:Root['kind']):Promise<Root>{
 const inventory=await loadInventory(state),root=await reconcileManagedRoot(inventory,path,kind);await saveInventory(state,inventory);return root;
}
async function readAcquisitionLaneMarker(path:string,kind:Root['kind'],authority?:CivicPolicyAuthorityReceipt):Promise<void>{
 try{
  const stat=await directory(path),marker=laneMarkerSchema.parse(JSON.parse((await fileBytes(join(path,LANE_MARKER),8192,true)).bytes.toString('utf8')));
  if(marker.kind!==kind||marker.rootId!==digest(path)||!sameIdentity(marker.identity,stat)||authority&&(marker.authorityId!==authority.authorityId||marker.authoritySha256!==authority.authoritySha256))throw new CivicPolicyStateError('ACQUISITION_LANE_MISMATCH');
 }catch(error){if(missing(error))throw error;throw new CivicPolicyStateError('ACQUISITION_LANE_UNSAFE');}
}
async function reconcileAcquisitionLane(inventory:Inventory,path:string,kind:Root['kind'],authority:CivicPolicyAuthorityReceipt):Promise<Root>{
 // Callers already reject authority/state overlap via managedRootPath. Check
 // enrolled roots before mkdir or marker publication, including legacy roots.
 assertManagedRootDisjoint(inventory,path);
 let needsMarker=false;
 try{await directory(path);}catch(error){if(missing(error))needsMarker=true;else throw error;}
 if(!needsMarker){
  try{await readAcquisitionLaneMarker(path,kind,authority);}catch(error){
   if(!missing(error))throw error;
   for await(const _entry of await opendir(path))throw new CivicPolicyStateError('ACQUISITION_LANE_REQUIRED');
   needsMarker=true;
  }
 }
 if(needsMarker){
  const stat=await directory(path,true);
  await atomicJson(join(path,LANE_MARKER),{schemaVersion:1,decisionId:CIVIC_ACQUISITION_DECISION_ID,rootId:digest(path),identity:{dev:stat.dev,ino:stat.ino},kind,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},true,false);
 }
 return reconcileManagedRoot(inventory,path,kind);
}
const laneInitializations=new Map<string,Promise<void>>();
/** Explicit acquisition opt-in, never inferred from a dated directory name.
 * Nonempty unmarked roots are rejected before shared policy state is mutated.
 * This also enrolls the root and verifies inventory completeness; generic legacy
 * inventory registration deliberately cannot authorize acquisition.
 */
export async function initializeManagedAcquisitionLane(input:string,options:ManagedAcquisitionLaneOptions):Promise<void>{
 if(options.decisionId!==CIVIC_ACQUISITION_DECISION_ID)throw new CivicPolicyStateError('ACQUISITION_DECISION_REQUIRED');
 const authority=await assertCivicPolicyAuthority(options),state=statePath(options),path=managedRootPath(input,state),kind=kindSchema.parse(options.kind??'fetch');
 const prior=laneInitializations.get(path)??Promise.resolve();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});laneInitializations.set(path,gate);await prior;
 try{
  await locked(options,async()=>{
   const inventory=await loadInventory(state),root=await reconcileAcquisitionLane(inventory,path,kind,authority);
   await saveInventory(state,inventory);if(!root.complete)throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');
  });
 }finally{release();if(laneInitializations.get(path)===gate)laneInitializations.delete(path);}
}
/** Explicit legacy purge inventory, not an acquisition-lane authorization. */
export async function registerManagedCacheRoot(input:string,options:CivicPolicyOptions&{kind:'fetch'|'prepared'|'artifacts'}):Promise<void>{
 const state=statePath(options),path=managedRootPath(input,state),kind=kindSchema.parse(options.kind);
 await assertCivicPolicyAuthority(options);
 await locked(options,async()=>{await enrollRoot(state,path,kind);});
}
/** Explicitly registered artifacts are checked, not blessed by a boolean assertion. */
export async function markManagedCacheInventoryComplete(input:string,options:CivicPolicyOptions={}):Promise<void>{
 await assertCivicPolicyAuthority(options);
 const state=statePath(options);await locked(options,async()=>{const inventory=await loadInventory(state),root=inventory.roots.find(root=>root.path===resolve(input));if(!root)throw new CivicPolicyStateError();root.complete=await reconcile(root,inventory);await saveInventory(state,inventory);if(!root.complete)throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');});
}
export async function recordManagedSourceContent(input:string,entry:ManagedSourceContent,options:CivicPolicyOptions={}):Promise<void>{
 const state=statePath(options);await locked(options,async()=>{const inventory=await loadInventory(state),root=inventory.roots.find(root=>root.path===resolve(input));if(!root)throw new CivicPolicyStateError();await verifyRoot(root);await assertHostNotOptedOut(entry.url,options);const item=makeEntry(root,entry),actual=await fileDigest(join(root.path,item.relativePath));if(actual.sha256!==item.contentSha256)throw new CivicPolicyStateError();mergeEntries(inventory,[item]);await saveInventory(state,inventory);});
}
/** The only unbound derived fetch format that can become source-bearing.
 * Validate the old bytes and every recorded host while the inventory is locked.
 */
async function readContentFreeFrontier(path:string,policy:CivicPolicyOptions):Promise<string>{
 const {bytes}=await fileBytes(path,MAX_STATE);let frontier:z.infer<typeof frontierMetadataSchema>;
 try{frontier=frontierMetadataSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{throw new CivicPolicyStateError('INVALID_FRONTIER_METADATA');}
 const urls=new Set([...frontier.roots,...frontier.visited,...frontier.queue.flatMap(item=>item.from?[item.url,item.from]:[item.url]),...frontier.failures.map(item=>item.url),...(frontier.excludedDocuments??[]).map(item=>item.url),...Object.keys(frontier.checkedUrls??{})]);
 for(const url of urls)await assertHostNotOptedOut(url,policy);
 return digest(bytes);
}
/** Bound-cache preflight. A sourceUrl can select a separately permitted ORIGINAL
 * raw representation, never a shared derived result with withdrawn contributors.
 */
export async function assertManagedSourceReadable(input:string,options:ManagedSourceReadOptions={}):Promise<void>{
 const authority=await assertCivicPolicyAuthority(options),state=statePath(options),path=resolve(input),policy={...options,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 await locked(policy,async()=>{
  const inventory=await loadInventory(state),root=inventory.roots.find(item=>contained(item.path,path));
  if(!root||!root.complete)throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');
  await verifyRoot(root);await readAcquisitionLaneMarker(root.path,root.kind,authority);
  const relativePath=relative(root.path,path).split(sep).join('/'),all=entriesAt(inventory,root.id,relativePath);
  let candidates=all.filter(entry=>entry.state==='active'||entry.state==='revoked');
  if(candidates.some(entry=>entry.kind==='authenticated_git_snapshot')&&options.purpose!=='historical_change_reconstruction_only')throw new CivicPolicyStateError('HISTORICAL_SOURCE_PURPOSE_REQUIRED');
  if(all.length&&!candidates.length){
   // Purge tombstones retain their contributor hosts even after the bytes are
   // gone; an objection must gate omitted ancestors before any file read.
   await assertSourceHostsNotOptedOut(all.map(entry=>'https://'+entry.host+'/'),policy);
   throw new CivicPolicyStateError('CONTENT_REFERENCE_REVOKED');
  }
  if(options.sourceUrl!==undefined){
   await assertHostNotOptedOut(options.sourceUrl,policy);
   const selected=candidates.filter(entry=>entry.urlSha256===urlHash(options.sourceUrl!));
   if(!selected.length)throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISSING');
   if(selected.every(entry=>!['retained_publication','authenticated_git_snapshot','operator_registry_config'].includes(entry.kind)&&entry.contentSha256===entry.sourceSha256&&entry.independentAllowed))candidates=selected;
  }
  const checkedHosts=new Set<string>();
  for(const entry of candidates){if(!checkedHosts.has(entry.host)){await assertHostNotOptedOut('https://'+entry.host+'/',policy);checkedHosts.add(entry.host);}if(entry.state!=='active')throw new CivicPolicyStateError('CONTENT_REFERENCE_REVOKED');}
  try{await lstat(path);}catch(error){if(missing(error))throw new CivicPolicyStateError('ENOENT');throw new CivicPolicyStateError();}
  if(!candidates.length){
   if(root.kind!=='fetch'||all.length||!/^frontiers\/[a-f0-9]{64}\.json$/.test(relativePath))throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISSING');
   await readContentFreeFrontier(path,policy);await assertCivicPolicyAuthority(policy);return;
  }
  const actual=await fileDigest(path),current=candidates.filter(entry=>entry.contentSha256===actual.sha256);
  if(!current.length)throw new CivicPolicyStateError('CONTENT_BINDING_MISMATCH');
  if(options.sourceUrl!==undefined&&!current.some(entry=>entry.urlSha256===urlHash(options.sourceUrl!)))throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISSING');
  if(current.some(entry=>['retained_publication','authenticated_git_snapshot','operator_registry_config'].includes(entry.kind)||entry.sourceSha256!==actual.sha256)&&all.some(entry=>entry.contentSha256===actual.sha256&&entry.state!=='active'))throw new CivicPolicyStateError('CONTENT_REFERENCE_REVOKED');
  await assertCivicPolicyAuthority(policy);
 });
}

/** Immutable fetch audit metadata may be unbound; source-bearing observations
 * retain the ordinary exact-byte, current-contributor read boundary.
 */
export async function assertManagedObservationReadable(input:string,options:CivicPolicyOptions={}):Promise<void>{
 const authority=await assertCivicPolicyAuthority(options),state=statePath(options),path=resolve(input),policy={...options,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const sourceBound=await locked(policy,async()=>{
  const inventory=await loadInventory(state),root=inventory.roots.find(item=>contained(item.path,path));
  if(!root?.complete||root.kind!=='fetch')throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');
  await verifyRoot(root);await readAcquisitionLaneMarker(root.path,root.kind,authority);
  const relativePath=relative(root.path,path).split(sep).join('/');
  if(!/^observations\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/.test(relativePath))throw new CivicPolicyStateError('OBSERVATION_PATH_REQUIRED');
  const {bytes}=await fileBytes(path,MAX_STATE);let observation:z.infer<typeof observationSchema>;
  try{observation=observationSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{throw new CivicPolicyStateError('INVALID_MANAGED_OBSERVATION');}
  await assertHostNotOptedOut(observation.url,policy);
  if(observation.location!==undefined)await assertHostNotOptedOut(observation.location,policy);
  const enrolled=entriesAt(inventory,root.id,relativePath).length>0;
  if(!enrolled&&observation.policy!==undefined&&!ContentFreeSourcePolicySchema.safeParse(observation.policy).success)throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISSING');
  await assertCivicPolicyAuthority(policy);return enrolled;
 });
 if(sourceBound)await assertManagedSourceReadable(path,policy);
}

/** Exact inherited provenance, except self-bound operator configuration bytes may
 * carry several admitted descriptors. Their complete declared descriptor set must
 * be an active member; derived artifacts retain exact-set ancestry, including kind filters.
 */
export async function assertManagedSourceBindings(input:string,bindings:Array<ManagedSourceBinding&{independentAllowed?:boolean}>,options:ManagedSourceReadOptions={},kind?:'operator_registry_config'):Promise<void>{
 return assertManagedSourceBindingSet(input,bindings,options,kind);
}
/** Select one independently permitted original without discarding other HTTP admissions. */
export async function assertManagedIndependentHttpSourceBinding(input:string,binding:Extract<ManagedSourceBinding,{kind:'http_observation'}>,options:ManagedSourceReadOptions={}):Promise<void>{
 if(binding.kind!=='http_observation')throw new CivicPolicyStateError('HTTP_SOURCE_PROVENANCE_REQUIRED');
 return assertManagedSourceBindingSet(input,[binding],{...options,sourceUrl:binding.url},undefined,true);
}
async function assertManagedSourceBindingSet(input:string,bindings:Array<ManagedSourceBinding&{independentAllowed?:boolean}>,options:ManagedSourceReadOptions,kind?:'operator_registry_config',independentHttpMember=false):Promise<void>{
 await assertManagedSourceReadable(input,options);
 const authority=await assertCivicPolicyAuthority(options),policy={...options,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},state=statePath(policy),path=resolve(input);
 if(kind!==undefined&&(!bindings.length||bindings.some(binding=>binding.kind!==kind)))throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISMATCH');
 const key=(value:{kind:string;urlSha256:string;sourceSha256:string|null;observationId?:string;receiptSha256?:string;publication?:unknown;snapshot?:unknown;purpose?:string;configurationSha256?:string;schemaContractSha256?:string;code?:unknown;approval?:unknown})=>canonical([value.kind,value.urlSha256,value.sourceSha256,value.observationId??null,value.receiptSha256??null,value.publication??null,value.snapshot??null,value.purpose??null,value.configurationSha256??null,value.schemaContractSha256??null,value.code??null,value.approval??null]);
 const registryDescriptorKey=(value:{kind:string;configurationSha256?:string;schemaContractSha256?:string;code?:unknown;approval?:unknown})=>canonical([value.configurationSha256,value.schemaContractSha256,value.code,value.approval]);
 await locked(policy,async()=>{
  const inventory=await loadInventory(state),root=inventory.roots.find(item=>contained(item.path,path));if(!root?.complete)throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISSING');
  await verifyRoot(root);await readAcquisitionLaneMarker(root.path,root.kind,authority);
  const actual=await fileDigest(path),relativePath=relative(root.path,path).split(sep).join('/');
  const selected=independentHttpMember?key({...sourceProvenance(bindings[0]),urlSha256:urlHash(bindings[0].url)}):null;
  const entries=entriesAt(inventory,root.id,relativePath).filter(entry=>entry.contentSha256===actual.sha256&&(!independentHttpMember||entry.kind==='http_observation'&&entry.independentAllowed&&entry.sourceSha256===actual.sha256&&key(entry)===selected));
  if(!entries.length)throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISSING');
  const checkedHosts=new Set<string>(),independentByIdentity=new Map<string,Set<boolean>>();
  for(const entry of entries){if(!checkedHosts.has(entry.host)){await assertHostNotOptedOut('https://'+entry.host+'/',policy);checkedHosts.add(entry.host);}if(entry.state!=='active'||entry.kind==='authenticated_git_snapshot'&&options.purpose!=='historical_change_reconstruction_only')throw new CivicPolicyStateError('CONTENT_REFERENCE_REVOKED');const identity=key(entry),allowed=independentByIdentity.get(identity);if(allowed)allowed.add(entry.independentAllowed);else independentByIdentity.set(identity,new Set([entry.independentAllowed]));}
  const registryArtifact=bindings.length>0&&bindings.every(binding=>binding.kind==='operator_registry_config'&&binding.independentAllowed===false&&binding.configurationSha256===actual.sha256&&binding.code.bytes===actual.stat.size);
  if(registryArtifact&&entries.some(entry=>entry.kind!=='operator_registry_config'||entry.independentAllowed||entry.configurationSha256!==actual.sha256||entry.code?.bytes!==actual.stat.size))throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISMATCH');
  const expected=new Set(entries.filter(entry=>kind===undefined||entry.kind===kind).map(key)),declared=new Set<string>(),bindingHosts=new Set<string>();
  const declaredDescriptors=registryArtifact?new Set<string>():undefined;
  for(const binding of bindings){
   const host=hostFromUrl(binding.url);if(!bindingHosts.has(host)){await assertHostNotOptedOut(binding.url,policy);bindingHosts.add(host);}const provenance=sourceProvenance(binding),identity=key({...provenance,urlSha256:urlHash(binding.url)});declared.add(identity);
   if(declaredDescriptors)declaredDescriptors.add(registryDescriptorKey(provenance));
   if(binding.independentAllowed!==undefined&&independentByIdentity.get(identity)?.has(!binding.independentAllowed))throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISMATCH');
  }
  if(registryArtifact){
   // Select complete descriptor families, never a mixture of partial endpoint sets.
   if([...declared].some(identity=>!expected.has(identity))||entries.some(entry=>declaredDescriptors!.has(registryDescriptorKey(entry))&&!declared.has(key(entry))))throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISMATCH');
  }else if(expected.size!==declared.size||[...expected].some(identity=>!declared.has(identity))){
   if([...declared].some(identity=>!expected.has(identity)))throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISMATCH');
   // An inherited artifact may carry older complete codec/code descriptor
   // families for the same exact configuration. Other provenance stays exact.
   const families=new Map<string,{configurationSha256:string;urls:Set<string>;declared:boolean}>();
   for(const entry of entries){
    if(kind!==undefined&&entry.kind!==kind)continue;
    const included=declared.has(key(entry));
    if(entry.kind!=='operator_registry_config'){
     if(!included)throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISMATCH');
     continue;
    }
    const descriptor=registryDescriptorKey(entry),family=families.get(descriptor);
    if(family){
     // Any declared endpoint commits to its entire descriptor family.
     if(family.declared!==included)throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISMATCH');
     family.urls.add(entry.urlSha256);
    }else families.set(descriptor,{configurationSha256:entry.configurationSha256!,urls:new Set([entry.urlSha256]),declared:included});
   }
   const complete=[...families.values()].filter(family=>family.declared);
   for(const family of families.values())if(!family.declared&&!complete.some(member=>member.configurationSha256===family.configurationSha256&&member.urls.size===family.urls.size&&[...family.urls].every(url=>member.urls.has(url))))throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISMATCH');
  }
  await assertCivicPolicyAuthority(policy);
 });
}

/** Raw admission requires an actual HTTP observation, never a publication or
 * prepared receipt with a convenient byte hash.
 */
export async function assertManagedRawSourceBinding(input:string,binding:Extract<ManagedSourceBinding,{kind:'http_observation'}>,options:CivicPolicyOptions={}):Promise<void>{
 if(binding.kind!=='http_observation')throw new CivicPolicyStateError('HTTP_SOURCE_PROVENANCE_REQUIRED');
 const proof=sourceProvenance(binding),authority=await assertCivicPolicyAuthority(options),policy={...options,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},state=statePath(policy),path=resolve(input);
 await assertHostNotOptedOut(binding.url,policy);
 await locked(policy,async()=>{
  const inventory=await loadInventory(state),root=inventory.roots.find(item=>item.kind==='fetch'&&contained(item.path,path));if(!root?.complete)throw new CivicPolicyStateError('HTTP_SOURCE_PROVENANCE_REQUIRED');
  await verifyRoot(root);await readAcquisitionLaneMarker(root.path,root.kind,authority);
  const relativePath=relative(root.path,path).split(sep).join('/'),entry=entriesAt(inventory,root.id,relativePath).find(item=>item.kind==='http_observation'&&item.state==='active'&&item.independentAllowed&&item.urlSha256===urlHash(binding.url)&&item.sourceSha256===proof.sourceSha256&&item.contentSha256===proof.sourceSha256&&item.observationId===binding.observationId&&item.receiptSha256===binding.receiptSha256);
  if(!entry||!/^sha256\/[a-f0-9]{64}$/.test(relativePath)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/.test(binding.observationId))throw new CivicPolicyStateError('HTTP_SOURCE_PROVENANCE_REQUIRED');
  const observationBytes=(await fileBytes(join(root.path,'observations',binding.observationId),MAX_STATE)).bytes;
  if(digest(observationBytes)!==binding.receiptSha256)throw new CivicPolicyStateError('HTTP_OBSERVATION_BINDING_MISMATCH');
  let observation:z.infer<typeof observationSchema>;
  try{observation=observationSchema.parse(JSON.parse(observationBytes.toString('utf8')));}catch{throw new CivicPolicyStateError('INVALID_MANAGED_OBSERVATION');}
  if(urlHash(observation.url)!==urlHash(binding.url)||observation.sha256!==binding.sourceSha256||!['fetched','not_modified'].includes(observation.state))throw new CivicPolicyStateError('HTTP_OBSERVATION_BINDING_MISMATCH');
  await assertHostNotOptedOut(binding.url,policy);if((await fileDigest(path)).sha256!==binding.sourceSha256)throw new CivicPolicyStateError('CONTENT_BINDING_MISMATCH');await assertHostNotOptedOut(binding.url,policy);
 });
}

function scratchParts(path:string):string[]{
 if(!path||isAbsolute(path)||path.includes('\\')||/[\x00-\x1f\x7f]/.test(path)||path.split('/').length>6||path.split('/').some(part=>!part||part==='.'||part==='..'||part.length>255))throw new CivicPolicyStateError('SCRATCH_PATH_UNSAFE');
 return path.split('/');
}
const sensitiveScratchPart=(part:string)=>/^\.?(?:ssh|git|env|credentials?|secrets?|auth|tokens?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(part);
function scratchRelative(path:string):string{
 if(scratchParts(path).some(sensitiveScratchPart))throw new CivicPolicyStateError('SCRATCH_PATH_UNSAFE');
 return path;
}
async function inspectScratchTree(root:Root,lease:ScratchLease,retireModelOutput=false):Promise<{files:Array<{path:string;stat:Stats;sealPrivate?:boolean}>;directories:Array<{path:string;stat:Stats}>}|null>{
 await verifyRoot(root);const path=join(root.path,lease.directory);let stat:Stats;
 try{stat=await directory(path,false,true);}catch(error){if(missing(error))return null;throw error;}
 if(lease.identity&&!sameIdentity(lease.identity,stat))throw new CivicPolicyStateError('SCRATCH_IDENTITY_MISMATCH');
 const files:Array<{path:string;stat:Stats;sealPrivate?:boolean}>=[],directories:Array<{path:string;stat:Stats}>=[];let count=0;
 const visit=async(folder:string,metadata:Stats):Promise<void>=>{
  for await(const child of await opendir(folder)){
   if(++count>MAX_SCRATCH_FILES||lease.identity===null)throw new CivicPolicyStateError('SCRATCH_INVENTORY_INCOMPLETE');
   const candidate=join(folder,child.name),parts=scratchParts(relative(path,candidate).split(sep).join('/'));
   const item=await lstat(candidate);
   // Cleanup only, after process/resource quiescence: an old CLI may have
   // inherited a permissive umask. Its sole declared output may be sealed
   // before hashing/deletion, never admitted as an assessor response.
   const sealPrivate=retireModelOutput&&lease.purpose==='openai'&&candidate===join(path,'answer.json')&&
    (item.mode&0o077)!==0&&item.isFile()&&item.nlink===1&&item.size<=48*1024&&(item.mode&0o7111)===0;
   if(item.isSymbolicLink()||item.uid!==process.getuid?.()||((item.mode&0o022)!==0&&!sealPrivate))throw new CivicPolicyStateError('SCRATCH_PATH_UNSAFE');
   if(parts.some(sensitiveScratchPart)){
    // No credential content is adopted, opened or deleted. Only an empty,
    // private, owned directory can be retired by its authenticated lease.
    if(!item.isDirectory()||(item.mode&0o077)!==0)throw new CivicPolicyStateError('SCRATCH_PATH_UNSAFE');
    for await(const _entry of await opendir(candidate))throw new CivicPolicyStateError('SCRATCH_PATH_UNSAFE');
    directories.push({path:candidate,stat:item});continue;
   }
   if(item.isDirectory()){await directory(candidate);await visit(candidate,item);}
   else if(item.isFile()&&item.nlink===1&&item.size<=MAX_CONTENT)files.push({path:candidate,stat:item,sealPrivate});
   else throw new CivicPolicyStateError('SCRATCH_PATH_UNSAFE');
  }
  directories.push({path:folder,stat:metadata});
 };
 await visit(path,stat);return {files,directories};
}
function processExists(pid:number,group=false):boolean{
 if(!Number.isSafeInteger(pid)||pid<1||pid>0x7fffffff)throw new CivicPolicyStateError('SCRATCH_PROCESS_INVALID');
 try{process.kill(group?-pid:pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;if((error as NodeJS.ErrnoException).code==='EPERM')return true;throw new CivicPolicyStateError('SCRATCH_PROCESS_UNAVAILABLE');}
}
const activeScratch=new Map<string,AbortController>();
async function cleanScratch(inventory:Inventory,lease:ScratchLease,policy:CivicPolicyOptions,receipt?:Pick<PurgeReceipt,'issues'|'deletedFiles'|'deletedBytes'|'missingFiles'>,ownerFinished=false):Promise<boolean>{
 if(archivedLease(lease))throw new CivicPolicyStateError('SCRATCH_CLOSED');
 const root=inventory.roots.find(item=>item.id===lease.rootId)!;
 const issue=(code:Issue['code'])=>receipt?.issues.push({code,rootId:lease.rootId,contentId:digest(lease.directory)});
 if(!ownerFinished&&lease.state==='active'&&processExists(lease.ownerPid)){issue('active_scratch');return false;}
 let resourcesRemoved=true;
 if(lease.resources.length){
  const authority=await assertCivicPolicyAuthority(policy),fixtureRoot=authority.mode==='isolated-fixture'?dirname(statePath(policy)):undefined;
  for(const resource of lease.resources)try{await removeManagedDocker(resource,join(root.path,lease.directory),fixtureRoot);resource.state='removed';}catch{resource.state='uncertain';resourcesRemoved=false;issue('daemon_resource_pending');}
 }
 if(!resourcesRemoved){lease.state='partial';return false;}
 for(const group of lease.groups){if(!group.settled&&processExists(group.pid,true)){issue('scratch_processes_active');return false;}group.settled=true;}
 try{
  const tree=await inspectScratchTree(root,lease,true);
  if(tree){
   for(const file of tree.files){
    if(file.sealPrivate){
     const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
     try{
      await directory(join(root.path,lease.directory),false,true);
      const metadata=await handle.stat();
      if(!sameIdentity(file.stat,metadata)||!metadata.isFile()||metadata.uid!==process.getuid?.()||metadata.nlink!==1||metadata.size!==file.stat.size||metadata.mode!==file.stat.mode)throw new CivicPolicyStateError('SCRATCH_CONTENT_CHANGED');
      await handle.chmod(0o600);await handle.sync();
     }finally{await handle.close();}
    }
    const actual=await fileDigest(file.path),current=await lstat(file.path);
    if(!sameIdentity(actual.stat,current)||!sameIdentity(file.stat,current)||current.isSymbolicLink()||current.nlink!==1||current.size!==actual.stat.size||current.mtimeMs!==actual.stat.mtimeMs||current.ctimeMs!==actual.stat.ctimeMs)throw new CivicPolicyStateError('SCRATCH_CONTENT_CHANGED');
    await directory(dirname(file.path));await unlink(file.path);
    lease.tombstones.push({pathSha256:digest(relative(join(root.path,lease.directory),file.path)),contentSha256:actual.sha256,bytes:actual.stat.size});
    if(receipt){receipt.deletedFiles++;receipt.deletedBytes+=actual.stat.size;}
   }
   for(const folder of tree.directories){const current=await lstat(folder.path);if(!current.isDirectory()||current.isSymbolicLink()||!sameIdentity(current,folder.stat))throw new CivicPolicyStateError('SCRATCH_IDENTITY_MISMATCH');await rmdir(folder.path);}
  }else if(receipt)receipt.missingFiles++;
  lease.state=ownerFinished?'closed':'purged';return true;
 }catch{lease.state='partial';issue('unsafe_scratch');return false;}
}
// The wrapper cannot execute a native command until its process-group identity
// has been durably enrolled. Parent death before the gate closes executes nothing.
const SCRATCH_PROCESS_GATE=`process.umask(0o077);const net=require('node:net'),cp=require('node:child_process');let data='',size=0;const gate=new net.Socket({fd:3,readable:true,writable:false});gate.setEncoding('utf8');gate.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>65536)process.exit(126);data+=chunk;});gate.on('error',()=>process.exit(126));gate.on('end',()=>{if(!data)process.exit(0);let value;try{value=JSON.parse(data);}catch{process.exit(126);}const child=cp.spawn(value.file,value.args,{cwd:process.cwd(),env:process.env,stdio:['pipe','inherit','inherit']});process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});child.on('error',()=>process.exit(127));child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exit(code??1);});});`;
/** Source-owned disposable workspace. All subprocesses MUST use scope.spawn;
 * callbacks must await their writes/children, and may call managed final writes.
 * The inventory lock is held only for lease/child registration and cleanup.
 */
export async function withManagedSourceScratch<T>(input:string,bindings:ManagedScratchBinding[],work:(scope:ManagedSourceScratch)=>Promise<T>,options:ManagedAcquisitionLaneOptions&{purpose:ScratchLease['purpose'];signal?:AbortSignal}):Promise<T>{
 const authority=await assertCivicPolicyAuthority(options),policy={...options,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},state=statePath(policy),path=resolve(input);
 if(!bindings.length)throw new CivicPolicyStateError('SCRATCH_PROVENANCE_MISSING');
 const sources=bindings.map(binding=>{
  const base={host:hostFromUrl(binding.url),urlSha256:urlHash(binding.url)};
  if('phase' in binding){const classification=binding.phase==='pre-admission'&&options.purpose==='classification',preparation=binding.phase==='preparation-input'&&options.purpose==='document';if(!classification&&!preparation)throw new CivicPolicyStateError('SCRATCH_PROVENANCE_INVALID');return scratchSourceSchema.parse({...base,kind:classification?'pre_admission':'preparation_input',sourceSha256:hex.parse(binding.sourceSha256)});}
  if(['authenticated_git_snapshot','operator_registry_config'].includes(binding.kind)&&options.purpose!=='artifact')throw new CivicPolicyStateError('NON_SOURCE_PROVENANCE_ADMISSION_DENIED');
  return scratchSourceSchema.parse({...base,...sourceProvenance(binding)});
 });
 await assertSourceHostsNotOptedOut(bindings.map(binding=>binding.url),policy);
 if(options.decisionId!==CIVIC_ACQUISITION_DECISION_ID)throw new CivicPolicyStateError('ACQUISITION_DECISION_REQUIRED');
 const lanePath=managedRootPath(path,state),kind=kindSchema.parse(options.kind??'artifacts');
 const id=randomUUID(),controller=new AbortController(),signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
 let lease!:ScratchLease,root!:Root;
 await locked(policy,async()=>{
  const inventory=await loadInventory(state);root=await reconcileAcquisitionLane(inventory,lanePath,kind,authority);
  // Reconciliation and the planned lease share the pre-mkdir commit. Even a
  // refused incomplete lane must retain its reconciled completeness durably.
  if(!root.complete){await saveInventory(state,inventory);throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');}
  lease={id,rootId:root.id,directory:'scratch/'+id,purpose:options.purpose,createdAt:new Date().toISOString(),ownerPid:process.pid,identity:null,state:'planned',sources,groups:[],resources:[],tombstones:[]};
  inventory.scratch.push(lease);await saveInventory(state,inventory);
  await directory(join(root.path,'scratch'),true,true);await mkdir(join(root.path,lease.directory),{mode:0o700});
  const metadata=await directory(join(root.path,lease.directory),false,true);lease.identity={dev:metadata.dev,ino:metadata.ino};lease.state='active';await saveInventory(state,inventory);
 });
 const scratchDirectory=join(root.path,lease.directory),children:Array<{child:ChildProcessWithoutNullStreams;closed:boolean;completion:Promise<void>}>=[];
 const daemonRemovers=new Set<()=>Promise<void>>();
 const stopDaemons=()=>{for(const remove of daemonRemovers)void remove().catch(()=>{});};
 let finished=false;const watchers:FSWatcher[]=[];
 const stopChildren=()=>{for(const item of children)if(!item.closed&&item.child.pid)try{process.kill(-item.child.pid,'SIGKILL');}catch{/* The owned child may already have exited. */}};
 const assertActive=async()=>{
  signal.throwIfAborted();if(finished)throw new CivicPolicyStateError('SCRATCH_CLOSED');
  try{await assertCivicPolicyAuthority(policy);await verifyRoot(root);if(!sameIdentity(lease.identity!,await directory(scratchDirectory,false,true)))throw new CivicPolicyStateError('SCRATCH_IDENTITY_MISMATCH');await assertSourceHostsNotOptedOut(bindings.map(binding=>binding.url),policy);}
  catch(error){controller.abort(error);throw error;}
 };
 activeScratch.set(id,controller);signal.addEventListener('abort',stopChildren);
 signal.addEventListener('abort',stopDaemons);
 const scope:ManagedSourceScratch={
  directory:scratchDirectory,signal,assertActive,
  async writeSource(relativePath,bytes){
   await assertActive();scratchRelative(relativePath);
   if(bytes.byteLength>MAX_CONTENT)throw new CivicPolicyStateError('SCRATCH_SOURCE_BINDING_MISMATCH');
   const sourceSha256=digest(bytes);if(!sources.some(source=>source.kind==='retained_publication'?source.publication?.memberSha256===sourceSha256&&source.publication.memberBytes===bytes.byteLength:source.kind==='authenticated_git_snapshot'?source.snapshot?.sha256===sourceSha256&&source.snapshot.bytes===bytes.byteLength:source.kind==='operator_registry_config'?source.configurationSha256===sourceSha256&&source.code?.bytes===bytes.byteLength:source.sourceSha256===sourceSha256))throw new CivicPolicyStateError('SCRATCH_SOURCE_BINDING_MISMATCH');
   const target=join(scratchDirectory,relativePath);await directory(dirname(target),true);const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await assertActive();
  },
  async spawn(file,args,spawnOptions={}){
   if(sources.some(source=>['authenticated_git_snapshot','operator_registry_config'].includes(source.kind)))throw new CivicPolicyStateError('NON_SOURCE_PROVENANCE_NATIVE_DENIED');
   await assertActive();const control=JSON.stringify({file,args});
   if(typeof file!=='string'||!file||file.includes('\0')||!Array.isArray(args)||args.some(arg=>typeof arg!=='string'||arg.includes('\0'))||Buffer.byteLength(control)>65536||process.platform==='win32')throw new CivicPolicyStateError('SCRATCH_COMMAND_INVALID');
   if(options.purpose==='openai'&&authority.mode!=='codex-workstation-local')throw new CivicPolicyStateError('NATIVE_MODEL_REQUIRES_PRODUCTION_AUTHORITY');
   if(/^(?:codex|claude)(?:\.exe)?$/i.test(basename(file))&&(options.purpose!=='openai'||basename(file)!=='codex'))throw new CivicPolicyStateError('VM_CODEX_ONLY');
   if(/^(?:docker|podman|nerdctl|ctr)(?:\.exe)?$/i.test(basename(file)))throw new CivicPolicyStateError('DAEMON_RESOURCE_LEASE_REQUIRED');
   const child=spawn(process.execPath,['--input-type=commonjs','-e',SCRATCH_PROCESS_GATE],{cwd:scratchDirectory,env:{...(spawnOptions.env??process.env),TMPDIR:scratchDirectory,TMP:scratchDirectory,TEMP:scratchDirectory},detached:true,stdio:['pipe','pipe','pipe','pipe']}) as ChildProcessWithoutNullStreams;
   let closed!:()=>void;const completion=new Promise<void>(resolve=>{closed=resolve;}),running={child,closed:false,completion};children.push(running);
   child.once('close',()=>{running.closed=true;closed();});child.on('error',()=>controller.abort(new CivicPolicyStateError('SCRATCH_PROCESS_UNAVAILABLE')));
   try{
    await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',()=>reject(new CivicPolicyStateError('SCRATCH_PROCESS_UNAVAILABLE')));});
    if(!child.pid)throw new CivicPolicyStateError('SCRATCH_PROCESS_UNAVAILABLE');
    await locked(policy,async()=>{const inventory=await loadInventory(state),current=inventory.scratch.find(item=>item.id===id);if(!current||current.state!=='active'||current.ownerPid!==process.pid||current.groups.length>=256)throw new CivicPolicyStateError('SCRATCH_CLOSED');current.groups.push({pid:child.pid!,settled:false});await saveInventory(state,inventory);});
    await assertActive();const gate=child.stdio[3] as Writable|undefined;if(!gate)throw new CivicPolicyStateError('SCRATCH_PROCESS_UNAVAILABLE');gate.on('error',()=>controller.abort(new CivicPolicyStateError('SCRATCH_PROCESS_UNAVAILABLE')));gate.end(control);return child;
   }catch(error){controller.abort(error);stopChildren();throw error;}
  },
  async createContainer(spec){
   if(sources.some(source=>['authenticated_git_snapshot','operator_registry_config'].includes(source.kind)))throw new CivicPolicyStateError('NON_SOURCE_PROVENANCE_NATIVE_DENIED');
   await assertActive();
   const omp=spec.profile==='omp-b';
   if(options.purpose==='openai'||!/^sha256:[a-f0-9]{64}$/.test(spec.imageId)||!hex.safeParse(spec.contractSha256).success
    ||omp&&(options.purpose!=='artifact'||!hex.safeParse(spec.controlSha256).success||!Number.isSafeInteger(spec.controlBytes)||spec.controlBytes<1||spec.controlBytes>65536)
    ||!omp&&(spec.profile!==undefined&&spec.profile!=='parser'||spec.artifactRelativePath!==null&&spec.artifactRelativePath!=='document'))throw new CivicPolicyStateError('DOCKER_CONTRACT_INVALID');
   const fixtureRoot=authority.mode==='isolated-fixture'?dirname(state):undefined,socketPath=await canonicalDockerSocket(spec.socketPath,fixtureRoot);
   if(contained(state,socketPath)||contained(scratchDirectory,socketPath))throw new CivicPolicyStateError('DOCKER_SOCKET_UNSAFE');
   const daemonId=await dockerDaemonIdentity(socketPath),nonce=randomUUID(),resourceId=randomUUID();
   let artifactSha256:string|null=null,artifactBytes:number|null=null;
   const verifyControl=async()=>{
    if(spec.profile!=='omp-b')return;
    const folder=join(scratchDirectory,'control'),metadata=await directory(folder);
    if((metadata.mode&0o022)!==0)throw new CivicPolicyStateError('DOCKER_INPUT_NOT_IMMUTABLE');
    const entries=[];for await(const entry of await opendir(folder))entries.push(entry);
    if(entries.length!==1||entries[0]!.name!=='system-prompt.md'||!entries[0]!.isFile())throw new CivicPolicyStateError('DOCKER_CONTROL_INVALID');
    const input=await fileDigest(join(folder,'system-prompt.md'));
    if((input.stat.mode&0o222)!==0||input.sha256!==spec.controlSha256||input.stat.size!==spec.controlBytes)throw new CivicPolicyStateError('DOCKER_INPUT_CHANGED');
   };
   if(spec.profile==='omp-b'){await verifyControl();if(daemonId!==spec.daemonId)throw new CivicPolicyStateError('DOCKER_DAEMON_CHANGED');}
   else if(spec.artifactRelativePath){const input=await fileDigest(join(scratchDirectory,'document'));if((input.stat.mode&0o222)!==0||input.stat.size>64*1024*1024)throw new CivicPolicyStateError('DOCKER_INPUT_NOT_IMMUTABLE');artifactSha256=input.sha256;artifactBytes=input.stat.size;}
   const identity={id:resourceId,scratchId:id,rootId:root.id,authoritySha256:authority.authoritySha256,nonce,name:(omp?'stadtstack-omp-b-':'stadtstack-parser-')+id+'-'+nonce,socketPath,daemonId,imageId:spec.imageId,contractSha256:spec.contractSha256,
    artifactRelativePath:spec.profile==='omp-b'?null:spec.artifactRelativePath,artifactSha256,artifactBytes,
    ...(spec.profile==='omp-b'?{profile:'omp-b' as const,controlSha256:spec.controlSha256,controlBytes:spec.controlBytes}:{})};
   const resource:ManagedDockerResource=ManagedDockerResourceSchema.parse({...identity,configSha256:dockerConfigSha256(identity,scratchDirectory),containerId:null,state:'reserved'});
   const persist=async()=>{
    await locked(policy,async()=>{const inventory=await loadInventory(state),current=inventory.scratch.find(item=>item.id===id),stored=current?.resources.find(item=>item.id===resourceId);
     if(!current||archivedLease(current)||!stored||stored.nonce!==resource.nonce||stored.configSha256!==resource.configSha256||stored.containerId!==null&&stored.containerId!==resource.containerId)throw new CivicPolicyStateError('DAEMON_RESOURCE_BINDING_MISMATCH');
     Object.assign(stored,resource);await saveInventory(state,inventory);
    });
   };
   await assertActive();
   await locked(policy,async()=>{const inventory=await loadInventory(state),current=inventory.scratch.find(item=>item.id===id);if(!current||current.state!=='active'||current.resources.length>=16)throw new CivicPolicyStateError('SCRATCH_CLOSED');current.resources.push(resource);await saveInventory(state,inventory);});
   let attachment:DockerAttach|undefined,completion:Promise<{exitCode:number}>|undefined,removal:Promise<void>|undefined,started=false;
   const waitCancellation=new AbortController();
   const remove=():Promise<void>=>{
    if(removal)return removal;
    removal=(async()=>{
     waitCancellation.abort();attachment?.close();await assertCivicPolicyAuthority(policy);
     // Keep the durable known CID until final close; recovery re-proves absence
     // after an interruption here. Failed removal still commits uncertainty.
     try{await removeManagedDocker(resource,scratchDirectory,fixtureRoot);resource.state='removed';daemonRemovers.delete(remove);}
     catch(error){resource.state='uncertain';await persist();throw error;}
    })();
    void removal.catch(()=>{removal=undefined;});
    return removal;
   };
   daemonRemovers.add(remove);
   try{
    await assertActive();resource.state='create_requested';await persist();
    resource.containerId=await createManagedDocker(resource,scratchDirectory,fixtureRoot);resource.state='created';await persist();await assertActive();
   }catch(error){resource.state='uncertain';await persist();throw error;}
   return {
    get id(){return resource.containerId!;},name:resource.name,remove,
    async start(){
     await assertActive();if(started||resource.state!=='created')throw new CivicPolicyStateError('DOCKER_START_REJECTED');started=true;
     if(resource.artifactRelativePath){const input=await fileDigest(join(scratchDirectory,'document'));if(input.sha256!==resource.artifactSha256||input.stat.size!==resource.artifactBytes||(input.stat.mode&0o222)!==0)throw new CivicPolicyStateError('DOCKER_INPUT_CHANGED');}
     await verifyControl();
     attachment=await attachManagedDocker(resource,scratchDirectory,fixtureRoot);
     await assertActive();resource.state='start_requested';await persist();await startManagedDocker(resource,scratchDirectory,fixtureRoot);
     const attached=attachment;
     completion=Promise.race([Promise.all([waitManagedDocker(resource,fixtureRoot,waitCancellation.signal),attached.ended]).then(([result])=>result),attached.failure]);void completion.catch(()=>{});
     const stdin=new Writable({write(chunk:Buffer,_encoding,callback){void assertActive().then(()=>{attached.stdin.write(chunk,callback);}).catch(error=>{attached.close();callback(error instanceof Error?error:new CivicPolicyStateError('DOCKER_INPUT_REJECTED'));});},final(callback){attached.stdin.end(callback);},destroy(error,callback){if(error)attached.close();callback(error);}});
     stdin.on('error',()=>{});
     return {stdin,stdout:attached.stdout,stderr:attached.stderr,completion};
    },
    async wait(){if(!completion)throw new CivicPolicyStateError('DOCKER_NOT_STARTED');return completion;},
   };
  },
 };
 try{
  for(const watched of [state,join(state,'hosts')]){const watcher=watch(watched,()=>{void assertActive().catch(()=>{});});watcher.on('error',()=>controller.abort(new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_UNAVAILABLE')));watchers.push(watcher);}
  await assertActive();const result=await work(scope);await assertActive();return result;
 }catch(error){await assertActive();throw error;}finally{
  finished=true;controller.abort(new CivicPolicyStateError('SCRATCH_CLOSED'));stopChildren();for(const watcher of watchers)watcher.close();
  let timer:NodeJS.Timeout|undefined;
  try{await Promise.race([Promise.allSettled(children.map(item=>item.completion)),new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);}finally{clearTimeout(timer);}
  signal.removeEventListener('abort',stopChildren);activeScratch.delete(id);
  signal.removeEventListener('abort',stopDaemons);
  // Drain abort-triggered removals (and their failure commits) before loading
  // the final close transaction, so no stale callback can overwrite it.
  await Promise.allSettled([...daemonRemovers].map(remove=>remove()));
  const clean=await locked(policy,async()=>{const inventory=await loadInventory(state),current=inventory.scratch.find(item=>item.id===id);if(!current||current.ownerPid!==process.pid||archivedLease(current))throw new CivicPolicyStateError('SCRATCH_IDENTITY_MISMATCH');current.state='closing';const complete=await cleanScratch(inventory,current,policy,undefined,true);if(!complete)current.state='partial';await saveInventory(state,inventory);return complete;});
  if(!clean)throw new CivicPolicyStateError('SCRATCH_CLEANUP_INCOMPLETE');
 }
}
/** All source-content producers must use this boundary, including cache hits.
 * Entries commit before the callback. An interrupted write remains inventoried;
 * objections publish independently, then wait for this lock before purging.
 * The callback must not recursively invoke inventory APIs or write other paths.
 * The root must first be explicitly initialized as an acquisition lane.
 */
export async function withManagedSourceWrite<T>(input:string,entries:ManagedSourceContent[],work:()=>Promise<T>,options:CivicPolicyOptions={}):Promise<T>{
 const authority=await assertCivicPolicyAuthority(options),state=statePath(options),policy={...options,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};return locked(policy,async()=>{
  const inventory=await loadInventory(state),root=inventory.roots.find(root=>root.path===resolve(input));if(!root||!root.complete||!entries.length)throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');await verifyRoot(root);
  try{await readAcquisitionLaneMarker(root.path,root.kind,authority);}catch(error){if(missing(error))throw new CivicPolicyStateError('ACQUISITION_LANE_REQUIRED');throw error;}
  await assertSourceHostsNotOptedOut(entries.map(entry=>entry.url),policy);
  const items=entries.map(entry=>makeEntry(root,entry));
  // A member can have thousands of source URLs but just one byte representation.
  // The lock excludes participating writers; check each path once on each side
  // of work, never reuse a digest across the callback or another transaction.
  const before=new Map<string,string|null>();
  for(const item of items){
   const prior=entriesAt(inventory,root.id,item.relativePath);
   try{
    const path=join(root.path,item.relativePath);let sha256=before.get(item.relativePath);
    if(sha256===undefined){sha256=(await fileDigest(path)).sha256;before.set(item.relativePath,sha256);}
    if(sha256===null)continue;
    if(sha256!==item.contentSha256&&!prior.some(entry=>entry.contentSha256===sha256)){
     // Empty/discovery-only frontiers start as closed metadata. Their first
     // source receipt promotes them without blessing arbitrary unbound bytes.
     if(root.kind!=='fetch'||prior.length||!/^frontiers\/[a-f0-9]{64}\.json$/.test(item.relativePath)||await readContentFreeFrontier(path,policy)!==sha256)throw new CivicPolicyStateError();
    }
   }
   catch(error){if(!missing(error))throw error;before.set(item.relativePath,null);}
  }
  mergeEntries(inventory,items);await saveInventory(state,inventory);
  const result=await work();await verifyRoot(root);await readAcquisitionLaneMarker(root.path,root.kind,authority);
  await assertSourceHostsNotOptedOut(entries.map(entry=>entry.url),policy);
  const after=new Map<string,string>();
  for(const item of items){let sha256=after.get(item.relativePath);if(sha256===undefined){sha256=(await fileDigest(join(root.path,item.relativePath))).sha256;after.set(item.relativePath,sha256);}if(sha256!==item.contentSha256)throw new CivicPolicyStateError();}
  return result;
 });
}
export interface ManagedScratchRecoveryReceipt {
 schemaVersion:'civic-scratch-recovery-v1';scope:'registered_source_scratch';authorityId:string;authoritySha256:string;attemptedAt:string;
 status:'complete'|'partial';recoveredLeases:string[];pendingLeases:string[];deletedFiles:number;deletedBytes:number;missingFiles:number;issues:Issue[];
}
/** Explicit operator recovery after a worker interruption. Never steals locks or
 * kills an unverified process; live owners/groups remain a reported prerequisite.
 */
export async function recoverManagedSourceScratch(options:CivicPolicyOptions={}):Promise<ManagedScratchRecoveryReceipt>{
 const authority=await assertCivicPolicyAuthority(options),state=statePath(options);
 return locked(options,async()=>{
  const inventory=await loadInventory(state),receipt:ManagedScratchRecoveryReceipt={schemaVersion:'civic-scratch-recovery-v1',scope:'registered_source_scratch',authorityId:authority.authorityId,authoritySha256:authority.authoritySha256,attemptedAt:new Date().toISOString(),status:'complete',recoveredLeases:[],pendingLeases:[],deletedFiles:0,deletedBytes:0,missingFiles:0,issues:[]};
  for(const lease of inventory.scratch){
   if(lease.state==='closed'||lease.state==='purged')continue;
   if(await cleanScratch(inventory,lease,options,receipt))receipt.recoveredLeases.push(lease.id);else receipt.pendingLeases.push(lease.id);
  }
  for(const root of inventory.roots){try{root.complete=await reconcile(root,inventory);}catch{root.complete=false;}if(!root.complete)receipt.issues.push({code:'inventory_incomplete',rootId:root.id});}
  receipt.status=receipt.pendingLeases.length||receipt.issues.length?'partial':'complete';await saveInventory(state,inventory);
  await atomicJson(join(state,'attempts','scratch-'+randomUUID()+'.json'),receipt,true);return receipt;
 });
}
/** Removes one explicitly enrolled root. Inventory ownership survives every
 * interrupted filesystem step until the final atomic inventory replacement.
 */
export async function retireManagedRoot(rootPath:string,input:{reason:string},options:CivicPolicyOptions):Promise<RetireReceipt>{
 const authority=await assertCivicPolicyAuthority(options),policy={...options,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},state=statePath(policy);
 if(!isAbsolute(rootPath)||rootPath!==resolve(rootPath))throw new CivicPolicyStateError('INVALID_OPERATOR_ARGUMENTS');
 const path=managedRootPath(rootPath,state),reason=RetireReceiptSchema.shape.reason.parse(input.reason);
 return locked(policy,async()=>{
  const inventory=await loadInventory(state),root=inventory.roots.find(item=>item.path===path);
  if(!root||inventory.roots.some(item=>item.id!==root.id&&(contained(item.path,path)||contained(path,item.path))))throw new CivicPolicyStateError('MANAGED_ROOT_UNSAFE');
  const leases=inventory.scratch.filter(lease=>lease.rootId===root.id);
  if(leases.some(lease=>lease.state!=='closed'&&lease.state!=='purged'))throw new CivicPolicyStateError('MANAGED_ROOT_ACTIVE_SCRATCH');
  const receipt:RetireReceipt={schemaVersion:'civic-root-retirement-v1',authorityId:authority.authorityId,authoritySha256:authority.authoritySha256,rootId:root.id,rootPath:path,reason,attemptedAt:new Date().toISOString(),status:'partial',deletedFiles:0,deletedBytes:0,missingFiles:0,removedEntries:0,removedScratchLeases:0,issues:[]};
  const files:Array<{path:string;actual:{sha256:string;stat:Stats}}>=[],folders:Array<{path:string;stat:Stats}>=[],seen=new Set<string>();
  let marker:{path:string;actual:{sha256:string;stat:Stats}}|undefined,absent=false;
  // A missing root is the last possible pre-commit crash state. Check every
  // remaining ancestor without creating anything before finishing that state.
  try{await verifyRoot(root);}catch(error){if(!missing(error))throw error;await directory(dirname(path));absent=true;}
  if(!absent){
   if(!await reconcile(root,inventory,true))throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');
   const visit=async(folder:string):Promise<void>=>{
    const absolute=join(path,folder),stat=await directory(absolute);
    for await(const child of await opendir(absolute)){
     const candidate=folder?folder+'/'+child.name:child.name,current=await lstat(join(path,candidate));
     if(current.isDirectory()&&!current.isSymbolicLink()){await visit(candidate);continue;}
     const actual=await fileDigest(join(path,candidate));
     if(candidate===LANE_MARKER){await readAcquisitionLaneMarker(path,root.kind,authority);marker={path:candidate,actual};}
     else{
      if(!entriesAt(inventory,root.id,candidate).some(entry=>entry.contentSha256===actual.sha256))throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');
      files.push({path:candidate,actual});seen.add(candidate);
     }
    }
    folders.push({path:absolute,stat});
   };
   await visit('');
  }
  const managedPaths=new Set<string>();let entryCount=0;
  for(const entry of inventory.entries)if(entry.rootId===root.id){managedPaths.add(entry.relativePath);entryCount++;}
  for(const candidate of managedPaths)if(!seen.has(candidate))receipt.missingFiles++;
  await assertCivicPolicyAuthority(policy);
  try{
   if(marker)files.push(marker);
   for(const file of files){
    const actual=await fileDigest(join(path,file.path));
    if(actual.sha256!==file.actual.sha256||!sameIdentity(actual.stat,file.actual.stat))throw new CivicPolicyStateError('MANAGED_CONTENT_CHANGED');
    await unlinkManagedFile(root,file.path,actual);receipt.deletedFiles++;receipt.deletedBytes+=actual.stat.size;
   }
   for(const folder of folders){
    await directory(dirname(folder.path));const current=await directory(folder.path);
    if(!sameIdentity(current,folder.stat))throw new CivicPolicyStateError('MANAGED_ROOT_UNSAFE');
    await rmdir(folder.path);
   }
   await assertCivicPolicyAuthority(policy);
   receipt.removedEntries=entryCount;receipt.removedScratchLeases=leases.length;
   inventory.roots=inventory.roots.filter(item=>item.id!==root.id);inventory.entries=inventory.entries.filter(entry=>entry.rootId!==root.id);inventory.scratch=inventory.scratch.filter(lease=>lease.rootId!==root.id);
   try{await saveInventory(state,inventory);}catch(error){
    // Atomic replacement can commit before its parent fsync/temporary cleanup
    // fails. Read the authoritative name under this same lock, not our mutated
    // in-memory inventory, before deciding whether a retry still owns the root.
    const committed=await loadInventory(state);
    if(committed.inventoryId!==inventory.inventoryId||committed.roots.some(item=>item.id===root.id)||committed.entries.some(entry=>entry.rootId===root.id)||committed.scratch.some(lease=>lease.rootId===root.id))throw error;
    receipt.issues.push({code:'operation_failed',rootId:root.id});
   }
   receipt.status='retired';
  }catch{
   // A failed pre-commit save leaves original ownership and missing paths for
   // retry; a confirmed replacement above reports the actual committed counts.
   receipt.removedEntries=0;receipt.removedScratchLeases=0;receipt.issues.push({code:'operation_failed',rootId:root.id});
  }
  await atomicJson(join(state,'attempts','retire-'+root.id+'-'+randomUUID()+'.json'),RetireReceiptSchema.parse(receipt),true);
  return receipt;
 });
}
async function unlinkManagedFile(root:Root,path:string,actual:{sha256:string;stat:Stats}):Promise<void>{
 await verifyRoot(root);await directory(dirname(join(root.path,path)));const now=await lstat(join(root.path,path));
 if(!now.isFile()||now.isSymbolicLink()||now.nlink!==1||now.uid!==process.getuid?.()||(now.mode&0o022)!==0||!sameIdentity(now,actual.stat)||now.size!==actual.stat.size||now.mtimeMs!==actual.stat.mtimeMs||now.ctimeMs!==actual.stat.ctimeMs)throw new CivicPolicyStateError();
 await unlink(join(root.path,path));
}
function emptyReceipt(objection:Objection):PurgeReceipt{return {host:objection.host,receivedAt:objection.receivedAt,purgeDueAt:objection.purgeDueAt,attemptedAt:new Date().toISOString(),status:'purged',deletedFiles:0,deletedBytes:0,removedReferences:0,retainedSharedFiles:0,retainedSharedBytes:0,missingFiles:0,issues:[],scope:'registered_managed_roots'};}
async function saveAttempt(state:string,receipt:PurgeReceipt):Promise<void>{
 const objection=await readObjection(state,receipt.host);
 if(!objection)throw new CivicPolicyStateError();
 if(Date.parse(objection.receivedAt)<Date.parse(receipt.receivedAt)){receipt.receivedAt=objection.receivedAt;receipt.purgeDueAt=objection.purgeDueAt;}
 await atomicJson(join(state,'attempts',digest(receipt.host)+'-'+randomUUID()+'.json'),purgeSchema.parse(receipt),true);
}
async function withdraw(state:string,inventory:Inventory,selected:Entry[],receipt:PurgeReceipt):Promise<void>{
 const paths=new Map<string,Entry[]>();for(const entry of selected){const key=entry.rootId+':'+entry.relativePath,items=paths.get(key)??[];items.push(entry);paths.set(key,items);}
 for(const items of paths.values()){
  let first=items[0];const root=inventory.roots.find(root=>root.id===first.rootId)!;
  const issue=(code:Issue['code'])=>receipt.issues.push({code,rootId:root.id,contentId:digest(first.relativePath)});
  try{await verifyRoot(root);}catch{issue('unsafe_root');continue;}
  let actual:{sha256:string;stat:Stats};
  try{actual=await fileDigest(join(root.path,first.relativePath));}catch(error){if(missing(error)){for(const entry of items){if(entry.state==='active')receipt.removedReferences++;setEntryState(inventory,entry,'missing');}receipt.missingFiles++;continue;}issue('unsafe_content');continue;}
  const matching=items.find(entry=>entry.contentSha256===actual.sha256);
  if(!matching){
   if(entriesAt(inventory,root.id,first.relativePath).some(entry=>entry.contentSha256===actual.sha256)){for(const entry of items){if(entry.state==='active')receipt.removedReferences++;setEntryState(inventory,entry,'missing');}continue;}
   issue('content_changed');continue;
  }
  first=matching;
  const selected=new Set(items),others=entriesAt(inventory,root.id,first.relativePath).filter(entry=>entry.contentSha256===actual.sha256&&entry.state==='active'&&!selected.has(entry));let independent=true;
  try{
   for(const item of items.filter(entry=>entry.contentSha256===actual.sha256)){
    let covered=false;
    for(const other of others)if(!['retained_publication','authenticated_git_snapshot','operator_registry_config'].includes(other.kind)&&other.independentAllowed&&item.sourceSha256!==null&&other.sourceSha256===item.sourceSha256&&other.urlSha256!==item.urlSha256&&(other.kind!==item.kind||other.observationId!==item.observationId)&&!(await readObjection(state,other.host))){covered=true;break;}
    if(!covered){independent=false;break;}
   }
  }catch{issue('inventory_unavailable');continue;}
  if(independent){
   for(const entry of items){if(entry.state==='active')receipt.removedReferences++;setEntryState(inventory,entry,'revoked');}
   receipt.retainedSharedFiles++;receipt.retainedSharedBytes+=actual.stat.size;
   // Hash identity, not a caller flag or filename, distinguishes an original
   // shared representation from a derived copy that may embed withdrawn refs.
   if(items.some(entry=>entry.contentSha256===actual.sha256&&(['retained_publication','authenticated_git_snapshot','operator_registry_config'].includes(entry.kind)||entry.sourceSha256!==actual.sha256)))issue('shared_derived_requires_rebuild');
   continue;
  }
  try{
   // Digest and inode are rechecked immediately before a nonrecursive unlink.
   // Owner-only state/root components exclude other users from the rename race;
   // participating producers are serialized by the shared inventory lock.
   await unlinkManagedFile(root,first.relativePath,actual);receipt.deletedFiles++;receipt.deletedBytes+=actual.stat.size;
   for(const entry of entriesAt(inventory,root.id,first.relativePath)){if(selected.has(entry)&&entry.state==='active')receipt.removedReferences++;setEntryState(inventory,entry,'deleted');}
  }catch{issue('unsafe_content');}
 }
}
async function purgeLocked(state:string,objection:Objection,policy:CivicPolicyOptions):Promise<PurgeReceipt>{
 const receipt=emptyReceipt(objection);let inventory:Inventory;
 try{inventory=await loadInventory(state);}catch{receipt.status='error';receipt.issues.push({code:'inventory_unavailable'});await saveAttempt(state,receipt);return receipt;}
 if(!inventory.roots.length)receipt.issues.push({code:'no_managed_roots'});
 for(const root of inventory.roots){try{root.complete=await reconcile(root,inventory);}catch{root.complete=false;receipt.issues.push({code:'unsafe_root',rootId:root.id});}if(!root.complete)receipt.issues.push({code:'inventory_incomplete',rootId:root.id});}
 // Revoked shared entries are reconsidered on retries: the independent host may
 // have objected since the previous attempt. Tombstones never authorize reads.
 await withdraw(state,inventory,(inventoryIndex(inventory).byHost.get(objection.host)??[]).filter(entry=>entry.state==='active'||entry.state==='revoked'),receipt);
 for(const lease of inventory.scratch.filter(item=>item.sources.some(source=>source.host===objection.host)&&item.state!=='closed'&&item.state!=='purged')){
  activeScratch.get(lease.id)?.abort(new HostOptedOutError(objection.host));await cleanScratch(inventory,lease,policy,receipt);
 }
 receipt.status=receipt.issues.length?'partial':'purged';await saveInventory(state,inventory);await saveAttempt(state,receipt);return receipt;
}
/** Owner/operator-only action. Blocking is durable BEFORE any inventory lock or
 * purge, and this call awaits the purge attempt rather than scheduling a cron.
 * A busy/unavailable inventory yields a durable error receipt; no lock stealing.
 */
export async function recordHostOptOut(input:{host:string;reason:'municipality_objection'|'rights_holder_objection';reference?:string;receivedAt?:string},options:CivicPolicyOptions={}):Promise<OptOutReceipt>{
 await assertCivicPolicyAuthority(options);
 const state=statePath(options),host=canonicalHost(input.host),receivedAt=new Date(timestamp.parse(input.receivedAt??new Date().toISOString())).toISOString();
 if(Date.parse(receivedAt)>Date.now())throw new CivicPolicyStateError('INVALID_RECEIVED_AT');
 const objection=objectionSchema.parse({schemaVersion:1,host,reason:input.reason,reference:input.reference,receivedAt,purgeDueAt:new Date(Date.parse(receivedAt)+WEEK).toISOString()});
 await directory(join(state,'hosts'),false,true);
 try{await atomicJson(objectionPath(state,host),objection,true);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 let effective=(await readObjection(state,host))!;
 if(Date.parse(objection.receivedAt)<Date.parse(effective.receivedAt)){
  // Deadline tightening does not wait for a busy purge lock and cannot race a
  // competing registration into extending the deadline: revisions are immutable.
  try{await atomicJson(join(state,'hosts',digest(host)+'-'+digest(objection.receivedAt)+'.json'),objection,true);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  effective=(await readObjection(state,host))!;
 }
 try{
  const purge=await locked(options,async()=>{effective=(await readObjection(state,host))!;return purgeLocked(state,effective,options);});return {...effective,receivedAt:purge.receivedAt,purgeDueAt:purge.purgeDueAt,purge};
 }catch(error){const purge=emptyReceipt(effective);purge.status='error';purge.issues.push({code:error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_BUSY'?'inventory_busy':error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_INVENTORY_UNAVAILABLE'?'inventory_unavailable':'operation_failed'});await saveAttempt(state,purge);return {...effective,receivedAt:purge.receivedAt,purgeDueAt:purge.purgeDueAt,purge};}
}
export async function purgeOptedOutHost(input:string,options:CivicPolicyOptions={}):Promise<PurgeReceipt>{
 await assertCivicPolicyAuthority(options);
 const state=statePath(options),host=canonicalHost(input),objection=await readObjection(state,host);if(!objection)throw new CivicPolicyStateError('HOST_NOT_REGISTERED');
 try{return await locked(options,async()=>purgeLocked(state,(await readObjection(state,host))!,options));}
 catch(error){const receipt=emptyReceipt(objection);receipt.status='error';receipt.issues.push({code:error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_BUSY'?'inventory_busy':error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_INVENTORY_UNAVAILABLE'?'inventory_unavailable':'operation_failed'});await saveAttempt(state,receipt);return receipt;}
}
/** Withdraws only newly managed provenance for a classification exclusion. No
 * legacy/frozen discovery, host-wide objection or public metadata deletion.
 */
export async function relinquishManagedSourceContent(input:string,source:{url:string;sourceSha256:string},options:CivicPolicyOptions={}):Promise<{disposition:'removed'|'retained_independent'|'not_managed'|'partial';removedReferences:number}>{
 await assertCivicPolicyAuthority(options);
 const state=statePath(options),host=hostFromUrl(source.url),sourceSha256=hex.parse(source.sourceSha256),urlSha256=urlHash(source.url);
 return locked(options,async()=>{const inventory=await loadInventory(state),root=inventory.roots.find(root=>root.path===resolve(input));if(!root)return {disposition:'not_managed',removedReferences:0};if(root.kind!=='fetch')throw new CivicPolicyStateError();
  const entries=(inventoryIndex(inventory).byHost.get(host)??[]).filter(entry=>entry.rootId===root.id&&entry.urlSha256===urlSha256&&entry.sourceSha256===sourceSha256&&(entry.state==='active'||entry.state==='revoked'));if(!entries.length)return {disposition:'not_managed',removedReferences:0};
  const now=new Date().toISOString(),receipt=emptyReceipt({schemaVersion:1,host,reason:'rights_holder_objection',receivedAt:now,purgeDueAt:now});await withdraw(state,inventory,entries,receipt);await saveInventory(state,inventory);
  return {disposition:receipt.issues.length?'partial':receipt.retainedSharedFiles?'retained_independent':'removed',removedReferences:receipt.removedReferences};
 });
}
interface PlannedSegment {pin:SegmentPin;serialized:string;inventoryId:string}
function planInventorySegments(inventoryId:string,existing:SegmentPin[],entries:Entry[],scratch:ScratchLease[]):{pins:SegmentPin[];added:PlannedSegment[]}{
 const pins=[...existing],added:PlannedSegment[]=[];
 for(const family of ['entries','scratch'] as const){
  const records=family==='entries'?entries:scratch;let chunk:Array<Entry|ScratchLease>=[],bytes=0;
  const flush=()=>{
   if(!chunk.length)return;
   const previousSha256=pins.at(-1)?.sha256??null;
   const value=segmentSchema.parse({schemaVersion:'civic-inventory-segment-v1',inventoryId,family,previousSha256,entries:family==='entries'?chunk:[],scratch:family==='scratch'?chunk:[]});
   const serialized=JSON.stringify(value),size=Buffer.byteLength(serialized)+1;
   if(size>MAX_STATE)throw new CivicPolicyStateError();
   const pin:SegmentPin={sha256:digest(serialized+'\n'),bytes:size,family,previousSha256};
   pins.push(pin);added.push({pin,serialized,inventoryId});chunk=[];bytes=0;
  };
  for(const record of records){const size=Buffer.byteLength(JSON.stringify(record))+1;if(bytes+size>16*1024*1024)flush();chunk.push(record);bytes+=size;}
  flush();
 }
 storageSchema.shape.segments.parse(pins);return {pins,added};
}
async function publishSegment(state:string,segment:PlannedSegment):Promise<void>{
 const folder=join(state,'inventory-segments');await directory(folder,true,true);
 const path=join(folder,segment.pin.sha256+'.json');
 try{await atomicJson(path,null,true,true,segment.serialized);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 // Also verifies an orphaned segment reused after a crash; never overwrite it.
 await readSegment(state,segment.pin,segment.inventoryId);
}
function logicalInventorySha256(value:Inventory):string{
 const hash=createHash('sha256');hash.update(canonical({schemaVersion:value.schemaVersion,inventoryId:value.inventoryId}));
 // Inventory arrays are identity sets. Record fields, including ordered sources,
 // groups/resources/tombstones, are preserved exactly; only top-level order changes.
 for(const records of [value.roots,value.entries,value.scratch]){
  hash.update('[');
  for(const record of [...records].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)){hash.update(canonical(record));hash.update('\n');}
  hash.update(']');
 }
 return hash.digest('hex');
}
export interface InventoryCompactionReceipt {
 schemaVersion:'civic-inventory-compaction-v1';status:'compacted'|'already_compacted'|'dry_run';authoritySha256:string;
 before:{bytes:number;sha256:string};after:{bytes:number;sha256:string};segments:SegmentPin[];
 backupPath:string|null;logicalSha256:string;logicalEquality:true;preservedWorkingLeases:string[];
}
/** One-shot owner cutover. Active/planned/partial leases stay fully hot and exact.
 * No worker is killed, lock stolen, root scanned, or authority marker replaced.
 */
export async function compactCivicPolicyInventory(options:CivicPolicyOptions&{dryRun?:boolean;backupPath?:string}={}):Promise<InventoryCompactionReceipt>{
 if(!options.authoritySha256)throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_UNPINNED');
 const authority=await assertCivicPolicyAuthority(options),state=statePath(options);
 return locked(options,async()=>{
  const original=(await fileBytes(join(state,'inventory.json'),MAX_STATE,true)).bytes,inventory=await loadInventory(state),before={bytes:original.length,sha256:digest(original)};
  const logicalSha256=logicalInventorySha256(inventory),preservedWorkingLeases=inventory.scratch.filter(lease=>!archivedLease(lease)).map(lease=>lease.id);
  const sealed=sealedInventories.get(inventory);
  if(sealed)return {schemaVersion:'civic-inventory-compaction-v1',status:options.dryRun?'dry_run':'already_compacted',authoritySha256:authority.authoritySha256,before,after:before,segments:sealed.storage.segments,backupPath:null,logicalSha256,logicalEquality:true,preservedWorkingLeases};
  const plan=planInventorySegments(inventory.inventoryId,[],inventory.entries.filter(bulkEntry),inventory.scratch.filter(archivedLease));
  const physical=hotInventorySchema.parse({...inventory,entries:inventory.entries.filter(entry=>!bulkEntry(entry)),scratch:inventory.scratch.filter(lease=>!archivedLease(lease)),storage:{format:'sealed-segments-v1',segments:plan.pins,entryStates:{},retiredRoots:{}}});
  const serialized=JSON.stringify(physical),after={bytes:Buffer.byteLength(serialized)+1,sha256:digest(serialized+'\n')};
  if(after.bytes>MAX_STATE)throw new CivicPolicyStateError();
  const reconstructed:Inventory={schemaVersion:1,inventoryId:physical.inventoryId,roots:physical.roots,entries:[...physical.entries],scratch:[...physical.scratch]};
  for(const segment of plan.added){const value=segmentSchema.parse(JSON.parse(segment.serialized));reconstructed.entries.push(...value.entries);reconstructed.scratch.push(...value.scratch);}
  if(logicalInventorySha256(reconstructed)!==logicalSha256)throw new CivicPolicyStateError('CIVIC_POLICY_COMPACTION_MISMATCH');
  let backupPath:string|null=null;
  if(!options.dryRun){
   backupPath=options.backupPath===undefined?join(state,'inventory.json.backup-'+before.sha256):resolve(options.backupPath);
   if(backupPath===join(state,'inventory.json')||contained(join(state,'inventory-segments'),backupPath))throw new CivicPolicyStateError('INVALID_OPERATOR_ARGUMENTS');
   await directory(dirname(backupPath),false,true);
   // Backup preserves ORIGINAL bytes (including whitespace/default omissions).
   const temporary=join(dirname(backupPath),'.'+randomUUID()+'.tmp');
   const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await handle.writeFile(original);await handle.sync();}finally{await handle.close();}
   try{
    try{await link(temporary,backupPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=await fileBytes(backupPath,MAX_STATE,true);if(!existing.bytes.equals(original))throw new CivicPolicyStateError('CIVIC_POLICY_BACKUP_MISMATCH');}
    const parent=await open(dirname(backupPath),constants.O_RDONLY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
   }finally{await unlink(temporary);}
   for(const segment of plan.added)await publishSegment(state,segment);
   await atomicJson(join(state,'inventory.json'),physical,false,true,serialized);
   validatedInventoryBytes.delete(state);
   const reread=await loadInventory(state),published=(await fileBytes(join(state,'inventory.json'),MAX_STATE,true)).bytes;
   if(logicalInventorySha256(reread)!==logicalSha256||published.length!==after.bytes||digest(published)!==after.sha256)throw new CivicPolicyStateError('CIVIC_POLICY_COMPACTION_MISMATCH');
  }
  return {schemaVersion:'civic-inventory-compaction-v1',status:options.dryRun?'dry_run':'compacted',authoritySha256:authority.authoritySha256,before,after,segments:plan.pins,backupPath,logicalSha256,logicalEquality:true,preservedWorkingLeases};
 });
}
/** Read-only, owner-local audit reconstruction, including full archived records.
 * This is not an authorization snapshot. Call ordinary live read boundaries.
 */
export async function readCivicPolicyInventory(options:CivicPolicyOptions={}):Promise<Inventory>{
 return locked(options,async()=>structuredClone(await loadInventory(statePath(options))));
}
/** Offline sizing/codec benchmark, deliberately not an authority operation.
 * Caller supplies a private COPY; this routine never writes or acquires a lock.
 */
export async function benchmarkCivicInventoryCopy(path:string,iterations=5):Promise<{
 before:{bytes:number;parseMs:number;serializeMs:number};after:{bytes:number;parseMs:number;serializeMs:number};byteReduction:number;codecSpeedup:number;segments:number;
}>{
 if(!Number.isInteger(iterations)||iterations<1||iterations>20)throw new CivicPolicyStateError('INVALID_OPERATOR_ARGUMENTS');
 const bytes=(await fileBytes(resolve(path),MAX_STATE,true)).bytes,original=bytes.toString('utf8');let inventory:Inventory;
 try{inventory=inventorySchema.parse(JSON.parse(original));}catch{throw new CivicPolicyStateError('CIVIC_POLICY_INVENTORY_UNAVAILABLE');}
 const plan=planInventorySegments(inventory.inventoryId,[],inventory.entries.filter(bulkEntry),inventory.scratch.filter(archivedLease));
 const compact=JSON.stringify(hotInventorySchema.parse({...inventory,entries:inventory.entries.filter(entry=>!bulkEntry(entry)),scratch:inventory.scratch.filter(lease=>!archivedLease(lease)),storage:{format:'sealed-segments-v1',segments:plan.pins,entryStates:{},retiredRoots:{}}}))+'\n';
 const measure=(text:string)=>{
  const parseTimes:number[]=[],serializeTimes:number[]=[];
  for(let i=0;i<iterations;i++){const start=performance.now(),value:unknown=JSON.parse(text),parsed=performance.now();JSON.stringify(value);const end=performance.now();parseTimes.push(parsed-start);serializeTimes.push(end-parsed);}
  parseTimes.sort((a,b)=>a-b);serializeTimes.sort((a,b)=>a-b);
  return {bytes:Buffer.byteLength(text),parseMs:parseTimes[Math.floor(iterations/2)],serializeMs:serializeTimes[Math.floor(iterations/2)]};
 };
 const before=measure(original),after=measure(compact);
 return {before,after,byteReduction:before.bytes/after.bytes,codecSpeedup:(before.parseMs+before.serializeMs)/(after.parseMs+after.serializeMs),segments:plan.pins.length};
}
/** CLI is an explicit local operator action, never a web/contact endpoint.
 * register --host HOST --reason CODE [--reference OPAQUE] [--received-at ISO]
 * purge --host HOST; both accept --state-dir PATH and return metadata only.
 * Exit 2 means partial/error; a deadline is never evidence of completed purge.
 */
export async function civicOptOutMain(args:string[]=process.argv.slice(2)):Promise<void>{
 const command=args[0],{values}=parseArgs({args:args.slice(1),options:{host:{type:'string'},root:{type:'string'},reason:{type:'string'},reference:{type:'string'},'received-at':{type:'string'},'state-dir':{type:'string'},'authority-id':{type:'string'},'authority-sha256':{type:'string'},'dry-run':{type:'boolean'},backup:{type:'string'}},strict:true});
 const options={stateDir:values['state-dir'],authorityId:values['authority-id'],authoritySha256:values['authority-sha256']};
 if(options.authorityId!==undefined&&options.authorityId!==CIVIC_POLICY_AUTHORITY_ID||statePath(options)!==CIVIC_POLICY_STATE_DIR)throw new CivicPolicyStateError('CIVIC_POLICY_AUTHORITY_FOREIGN');
 if(command==='provision'){console.log(JSON.stringify(await provisionCivicPolicyAuthority(options)));return;}
 if(command==='compact-inventory'){console.log(JSON.stringify(await compactCivicPolicyInventory({...options,dryRun:values['dry-run'],backupPath:values.backup})));return;}
 if(command==='recover-scratch'){const receipt=await recoverManagedSourceScratch(options);console.log(JSON.stringify(receipt));if(receipt.status!=='complete')process.exitCode=2;return;}
 if(command==='retire-root'){if(!values.root||!values.reason)throw new CivicPolicyStateError('INVALID_OPERATOR_ARGUMENTS');const receipt=await retireManagedRoot(values.root,{reason:values.reason},options);console.log(JSON.stringify(receipt));if(receipt.status!=='retired')process.exitCode=2;return;}
 if(!values.host||!['register','purge'].includes(command))throw new CivicPolicyStateError('INVALID_OPERATOR_ARGUMENTS');
 const receipt=command==='register'?await recordHostOptOut({host:values.host,reason:reasonSchema.parse(values.reason),reference:values.reference,receivedAt:values['received-at']},options):await purgeOptedOutHost(values.host,options);
 console.log(JSON.stringify(receipt));const purge='purge' in receipt?receipt.purge:receipt;if(purge.status!=='purged')process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)civicOptOutMain().catch(()=>{console.error('Civic opt-out operation failed; acquisition remains fail-closed. Operator review required.');process.exitCode=2;});
