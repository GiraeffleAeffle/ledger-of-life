import {constants} from 'node:fs';
import {mkdir,lstat,open,rename,unlink,link,opendir} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import type {Stats,BigIntStats} from 'node:fs';
import {resolve,join,dirname,basename,relative,isAbsolute,parse,sep} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {DistrictKnowledgeRecordSchema,SourceAccessPolicySchema} from './district-schema.ts';
import {effectiveSourcePermission} from './source-policy.ts';

const WEEK=7*24*60*60*1000,MAX_STATE=16*1024*1024,MAX_CONTENT=64*1024*1024,MAX_FILES=100_000;
const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const hex=z.string().regex(/^[a-f0-9]{64}$/),opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const timestamp=z.string().datetime({offset:true}),kindSchema=z.enum(['fetch','prepared','artifacts']);
const reasonSchema=z.enum(['municipality_objection','rights_holder_objection']);
const identitySchema=z.object({dev:z.number().int().nonnegative(),ino:z.number().int().nonnegative()}).strict();
export const CIVIC_ACQUISITION_DECISION_ID='owner-2026-10-11-public-civic-sources' as const;
const LANE_MARKER='.civic-acquisition-lane.json';
const laneMarkerSchema=z.object({schemaVersion:z.literal(1),decisionId:z.literal(CIVIC_ACQUISITION_DECISION_ID),rootId:hex,identity:identitySchema,kind:kindSchema}).strict();
export interface ManagedAcquisitionLaneOptions extends CivicPolicyOptions {decisionId:typeof CIVIC_ACQUISITION_DECISION_ID;kind?:'fetch'|'prepared'|'artifacts'}
const objectionSchema=z.object({schemaVersion:z.literal(1),host:z.string(),receivedAt:timestamp,purgeDueAt:timestamp,reason:reasonSchema,reference:opaque.optional()}).strict();
const rootSchema=z.object({id:hex,path:z.string(),kind:kindSchema,identity:identitySchema,complete:z.boolean()}).strict();
const entrySchema=z.object({id:hex,rootId:hex,relativePath:z.string(),contentSha256:hex,sourceSha256:hex,host:z.string(),urlSha256:hex,observationId:opaque,receiptSha256:hex,independentAllowed:z.boolean(),state:z.enum(['active','revoked','deleted','missing'])}).strict();
const inventorySchema=z.object({schemaVersion:z.literal(1),roots:z.array(rootSchema).max(10_000),entries:z.array(entrySchema).max(MAX_FILES)}).strict();
const issueSchema=z.object({code:z.enum(['no_managed_roots','inventory_incomplete','unsafe_root','content_changed','unsafe_content','shared_derived_requires_rebuild','inventory_unavailable','operation_failed','inventory_busy']),rootId:hex.optional(),contentId:hex.optional()}).strict();
const purgeSchema=z.object({host:z.string(),receivedAt:timestamp,purgeDueAt:timestamp,attemptedAt:timestamp,status:z.enum(['purged','partial','error']),deletedFiles:z.number().int().nonnegative(),deletedBytes:z.number().int().nonnegative(),removedReferences:z.number().int().nonnegative(),retainedSharedFiles:z.number().int().nonnegative(),retainedSharedBytes:z.number().int().nonnegative(),missingFiles:z.number().int().nonnegative(),issues:z.array(issueSchema),scope:z.literal('registered_managed_roots')}).strict();
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
const crawlMetadataSchema=z.object({url:publicLink,sha256:hex,localPath:z.string().max(4096),mimeType:z.string().max(256),retrievedAt:timestamp,checkedAt:timestamp,status:z.number().int(),observationPath:z.string().max(4096),policy:SourceAccessPolicySchema.optional(),id:shortText,municipalityId:shortText,ags:shortText,districtId:shortText,sourceId:shortText,documentDate:shortText.nullable(),adapter:shortText,metadata:documentMetadataSchema}).strict();
const excludedMetadataSchema=crawlMetadataSchema.omit({localPath:true}).extend({policy:SourceAccessPolicySchema,sizeBytes:counter,exclusion:observationSchema.shape.exclusion.unwrap()}).strict();
const seedMetadataSchema=z.object({url:publicLink,title:shortText.optional(),documentDate:shortText.nullable().optional(),sourceId:shortText,adapter:shortText.optional(),metadata:documentMetadataSchema.optional(),dateReason:shortText.optional(),evidence:z.array(z.object({url:publicLink,locator:shortText,sha256:hex.optional(),retrievedAt:timestamp.optional()}).strict()).optional()}).strict();
const frontierMetadataSchema=z.object({
 schemaVersion:z.literal(1),municipalityId:shortText,sourceId:shortText,
 queue:z.array(seedMetadataSchema.extend({from:z.string().max(8192),depth:counter,revalidate:z.boolean().optional(),previous:crawlMetadataSchema.optional()}).strict()).max(MAX_FILES),
 visited:z.array(publicLink).max(MAX_FILES),documents:z.array(crawlMetadataSchema).max(MAX_FILES),excludedDocuments:z.array(excludedMetadataSchema).max(MAX_FILES).optional(),
 failures:z.array(z.object({url:publicLink,failure:shortText,reason:shortText,checkedAt:timestamp,status:z.number().int().optional(),policy:SourceAccessPolicySchema.optional(),retryAfter:shortText.optional(),action:z.literal('ask_municipality')}).strict()).max(MAX_FILES),
 roots:z.array(publicLink).max(MAX_FILES),checkedUrls:z.record(publicLink,z.object({checkedAt:timestamp,documentId:shortText}).strict()).optional(),lastCheckedAt:timestamp.nullable().optional(),
}).strict();
const checkpointMetadataSchema=z.object({
 schemaVersion:z.literal(1),bodyId:publicLink,baseUrl:publicLink,kind:z.enum(['paper','meeting']),backfillComplete:z.boolean(),watermark:timestamp.nullable(),
 filterSupport:z.enum(['unknown','supported','unsupported']).optional(),filterSupportReason:shortText.optional(),withdrawnIds:z.array(publicLink).max(MAX_FILES).optional(),
 active:z.object({mode:z.enum(['backfill','incremental','refresh']),startedAt:timestamp,nextUrl:publicLink,visited:z.array(publicLink).max(MAX_FILES),seenIds:z.array(publicLink).max(MAX_FILES).optional(),seenCount:counter.optional(),expectedTotal:counter.nullable().optional()}).strict().nullable(),
 segments:counter,pages:counter,rawRecordCount:counter,lastCheckedAt:timestamp.nullable(),error:shortText.optional(),
}).strict();
type Root=z.infer<typeof rootSchema>;
type Entry=z.infer<typeof entrySchema>;
type Inventory=z.infer<typeof inventorySchema>;
type Objection=z.infer<typeof objectionSchema>;
type Issue=z.infer<typeof issueSchema>;
export type PurgeReceipt=z.infer<typeof purgeSchema>;
export type OptOutReceipt=Objection&{purge:PurgeReceipt};
export interface CivicPolicyOptions {stateDir?:string}
export interface CivicOptOutSnapshot {
 schemaVersion:'civic-opt-out-snapshot-v1';sha256:string;
 objections:Array<{hostSha256:string;receivedAt:string;purgeDueAt:string}>;
}
export interface ManagedSourceContent {
 relativePath:string;contentSha256:string;sourceSha256:string;url:string;
 observationId:string;receiptSha256:string;independentAllowed:boolean;
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
function statePath(options:CivicPolicyOptions):string{return resolve(options.stateDir??join(homedir(),'.cache','stadtstack-data','civic-policy'));}
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
async function atomicJson(path:string,value:unknown,exclusive=false,privateDirectory=true):Promise<void>{
 await directory(dirname(path),true,privateDirectory);const temporary=join(dirname(path),'.'+randomUUID()+'.tmp');
 const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
 try{
  if(exclusive)await link(temporary,path);
  else{try{await fileBytes(path,MAX_STATE,true);}catch(error){if(!missing(error))throw error;}await rename(temporary,path);}
  const parent=await open(dirname(path),constants.O_RDONLY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
 }finally{try{await unlink(temporary);}catch(error){if(!missing(error))throw error;}}
}
async function ensureState(path:string){await directory(path,true,true);await directory(join(path,'hosts'),true,true);await directory(join(path,'attempts'),true,true);}
function objectionPath(state:string,host:string){return join(state,'hosts',digest(host)+'.json');}
async function readObjection(state:string,host:string):Promise<Objection|undefined>{
 try{await directory(state,false,true);}catch(error){if(missing(error))return undefined;throw new CivicPolicyStateError();}
 try{await directory(join(state,'hosts'),false,true);}catch{throw new CivicPolicyStateError();}
 let initial:Buffer;
 try{initial=(await fileBytes(objectionPath(state,host),8192,true)).bytes;}catch(error){if(missing(error))return undefined;throw new CivicPolicyStateError();}
 try{
  let value=objectionSchema.parse(JSON.parse(initial.toString('utf8')));const prefix=digest(host)+'-';
  const revisions:string[]=[];let count=0;
  for await(const entry of await opendir(join(state,'hosts'))){if(++count>MAX_FILES)throw new CivicPolicyStateError();if(entry.name.startsWith(prefix)){if(revisions.length>=10_000)throw new CivicPolicyStateError();revisions.push(entry.name);}}
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
 const host=hostFromUrl(url);if(await readObjection(statePath(options),host))throw new HostOptedOutError(host);
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
 * The hash binds only JSON.stringify({schemaVersion,objections}) in the order
 * returned here. No contacts, opaque references, local paths, raw host names,
 * inventories or purge statuses enter that public projection.
 * Objections publish outside the inventory lock, so both directory membership
 * and nanosecond file identities must remain stable across the whole read.
 * Call assertHostNotOptedOut independently at every live/model/release boundary.
 */
export async function readCivicOptOutSnapshot(options:CivicPolicyOptions={}):Promise<CivicOptOutSnapshot>{
 const state=statePath(options),schemaVersion='civic-opt-out-snapshot-v1' as const;
 try{await directory(state,false,true);}catch(error){
  if(!missing(error))throw new CivicPolicyStateError();
  try{await lstat(state);}catch(again){if(missing(again)){const body={schemaVersion,objections:[]};return {...body,sha256:digest(JSON.stringify(body))};}throw new CivicPolicyStateError();}
  throw new CivicPolicyStateError('CIVIC_POLICY_BUSY');
 }
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
 const objections=[...selected.values()].sort((a,b)=>a.hostSha256<b.hostSha256?-1:a.hostSha256>b.hostSha256?1:0),body={schemaVersion,objections};
 return {...body,sha256:digest(JSON.stringify(body))};
}
const queues=new Map<string,Promise<void>>();
async function locked<T>(state:string,work:()=>Promise<T>):Promise<T>{
 const prior=queues.get(state)??Promise.resolve();let done!:()=>void;const gate=new Promise<void>(resolve=>{done=resolve;});queues.set(state,gate);await prior;
 const path=join(state,'inventory.lock');let handle:FileHandle|undefined;
 try{
  await ensureState(state);
  try{handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new CivicPolicyStateError('CIVIC_POLICY_BUSY');throw error;}
  const original=await handle.stat();await handle.writeFile(JSON.stringify({pid:process.pid,nonce:randomUUID()})+'\n');await handle.sync();
  try{return await work();}finally{const current=await lstat(path);if(!sameIdentity(original,current)||current.isSymbolicLink())throw new CivicPolicyStateError();await unlink(path);}
 }finally{await handle?.close();done();if(queues.get(state)===gate)queues.delete(state);}
}
function entryId(entry:Omit<Entry,'id'|'state'>):string{return digest(JSON.stringify([entry.rootId,entry.relativePath,entry.contentSha256,entry.sourceSha256,entry.host,entry.urlSha256,entry.observationId,entry.receiptSha256,entry.independentAllowed]));}
function checkedRelative(root:Root,path:string,contentSha256:string,receiptSha256:string):string{
 if(path.includes('\\')||path.includes('\0')||isAbsolute(path)||path.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw new CivicPolicyStateError();
 const derivedFetch=/^oparl-bodies\/[a-f0-9]{64}\.json$/.test(path)||/^api-frontiers\/[a-f0-9]{64}-mv\.json$/.test(path)||/^oparl\/[a-f0-9]{64}\/(?:paper|meeting)\/page-\d+\.json$/.test(path);
 const shardedCas=path==='sha256/'+contentSha256.slice(0,2)+'/'+contentSha256;
 const valid=root.kind==='fetch'?path==='sha256/'+contentSha256||derivedFetch:root.kind==='prepared'?path===receiptSha256+'.json':shardedCas||/^(?:source-content\/)?[a-f0-9]{64}(?:\.answer)?\.(?:json|jsonl|txt)$/.test(path);
 if(!valid||!contained(root.path,join(root.path,path)))throw new CivicPolicyStateError();return path;
}
function makeEntry(root:Root,input:ManagedSourceContent):Entry{
 const sourceSha256=hex.parse(input.sourceSha256),contentSha256=hex.parse(input.contentSha256),receiptSha256=hex.parse(input.receiptSha256);
 if(root.kind==='fetch'&&input.relativePath.startsWith('sha256/')&&sourceSha256!==contentSha256)throw new CivicPolicyStateError();
 const value={rootId:root.id,relativePath:checkedRelative(root,input.relativePath,contentSha256,receiptSha256),contentSha256,sourceSha256,host:hostFromUrl(input.url),urlSha256:urlHash(input.url),observationId:opaque.parse(input.observationId),receiptSha256,independentAllowed:z.boolean().parse(input.independentAllowed)};
 return {...value,id:entryId(value),state:'active'};
}
async function loadInventory(state:string):Promise<Inventory>{
 let value:Inventory;try{value=inventorySchema.parse(JSON.parse((await fileBytes(join(state,'inventory.json'),MAX_STATE,true)).bytes.toString('utf8')));}catch(error){if(missing(error))return {schemaVersion:1,roots:[],entries:[]};throw new CivicPolicyStateError();}
 if(new Set(value.roots.map(root=>root.id)).size!==value.roots.length||new Set(value.entries.map(entry=>entry.id)).size!==value.entries.length)throw new CivicPolicyStateError();
 for(const root of value.roots)if(root.id!==digest(root.path)||root.path!==resolve(root.path))throw new CivicPolicyStateError();
 for(const entry of value.entries){const root=value.roots.find(root=>root.id===entry.rootId);if(!root||entry.host!==canonicalHost(entry.host)||entry.id!==entryId(entry)||root.kind==='fetch'&&entry.relativePath.startsWith('sha256/')&&entry.sourceSha256!==entry.contentSha256)throw new CivicPolicyStateError();checkedRelative(root,entry.relativePath,entry.contentSha256,entry.receiptSha256);}
 return value;
}
async function saveInventory(state:string,value:Inventory){inventorySchema.parse(value);if(Buffer.byteLength(JSON.stringify(value))>MAX_STATE)throw new CivicPolicyStateError();await atomicJson(join(state,'inventory.json'),value);}
async function verifyRoot(root:Root){if(!sameIdentity(root.identity,await directory(root.path)))throw new CivicPolicyStateError();}
function mergeEntries(inventory:Inventory,entries:Entry[]){
 for(const entry of entries){const old=inventory.entries.find(item=>item.id===entry.id);if(old){if(old.state!=='active')throw new CivicPolicyStateError('CONTENT_REFERENCE_REVOKED');continue;}
  if(entry.relativePath==='sha256/'+entry.contentSha256&&inventory.entries.some(item=>item.rootId===entry.rootId&&item.relativePath===entry.relativePath&&(item.contentSha256!==entry.contentSha256||item.sourceSha256!==entry.sourceSha256)))throw new CivicPolicyStateError();inventory.entries.push(entry);
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
// Registration is explicit: this never searches home, other worktrees or remote
// machines. Known formats are inventoried only inside the supplied managed root.
async function reconcile(root:Root,inventory:Inventory):Promise<boolean>{
 await verifyRoot(root);let complete=true,count=0;const paths=new Set<string>();
 const visit=async(folder:string):Promise<void>=>{
  for await(const child of await opendir(join(root.path,folder))){if(++count>MAX_FILES)throw new CivicPolicyStateError();const path=folder?folder+'/'+child.name:child.name,stat=await lstat(join(root.path,path));
   if(stat.isSymbolicLink()){complete=false;continue;}
   if(stat.isDirectory()){
    const allowed=root.kind==='fetch'?/^(?:sha256|observations|requests|pdf-tdm-policy|oparl-bodies|api-frontiers|frontiers|oparl(?:\/[a-f0-9]{64}(?:\/(?:paper|meeting))?)?)$/.test(path):root.kind==='prepared'?/^(?:indexes|plans)$/.test(path):path==='source-content'||/^sha256(?:\/[a-f0-9]{2})?$/.test(path);
    if(!allowed){complete=false;continue;}await directory(join(root.path,path));await visit(path);continue;
   }
   if(!stat.isFile()){complete=false;continue;}
   if(!folder&&child.name===LANE_MARKER){
    try{await readAcquisitionLaneMarker(root.path,root.kind);}catch{complete=false;}continue;
   }
   if(root.kind==='fetch'&&/^observations\/[A-Za-z0-9._-]+\.json$/.test(path)){
    try{const {bytes}=await fileBytes(join(root.path,path),MAX_STATE),observation=observationSchema.parse(JSON.parse(bytes.toString('utf8')));
     if(observation.policy)SourceAccessPolicySchema.parse(observation.policy);
     if(['fetched','not_modified'].includes(observation.state)&&hex.safeParse(observation.sha256).success){
      const sourceSha256=hex.parse(observation.sha256),entry=makeEntry(root,{relativePath:'sha256/'+sourceSha256,contentSha256:sourceSha256,sourceSha256,url:observation.url,observationId:basename(path),receiptSha256:digest(bytes),independentAllowed:independentPolicy(observation.policy,observation.url,sourceSha256)});
      const old=inventory.entries.find(item=>item.id===entry.id);if(!old)mergeEntries(inventory,[entry]);
     }else if(!['failed','redirected','excluded','opted_out'].includes(observation.state))complete=false;
    }catch{complete=false;}continue;
   }
   if(root.kind==='fetch'&&/^requests\/[a-f0-9]{64}\.json$/.test(path)){
    try{const value=observationSchema.parse(JSON.parse((await fileBytes(join(root.path,path),MAX_STATE)).bytes.toString('utf8')));if(value.policy)SourceAccessPolicySchema.parse(value.policy);}catch{complete=false;}continue;
   }
   if(root.kind==='fetch'&&/^pdf-tdm-policy\/[A-Za-z0-9.+-]+-[a-f0-9]{64}\.json$/.test(path)){
    try{const value=pdfPolicySchema.parse(JSON.parse((await fileBytes(join(root.path,path),8192)).bytes.toString('utf8')));if(!path.endsWith('-'+value.sha256+'.json'))complete=false;}catch{complete=false;}continue;
   }
   if(root.kind==='fetch'&&/^frontiers\/[a-f0-9]{64}\.json$/.test(path)){
    try{frontierMetadataSchema.parse(JSON.parse((await fileBytes(join(root.path,path),MAX_STATE)).bytes.toString('utf8')));}catch{complete=false;}continue;
   }
   if(root.kind==='fetch'&&/^oparl\/[a-f0-9]{64}\/(?:paper|meeting)\/checkpoint\.json$/.test(path)){
    try{checkpointMetadataSchema.parse(JSON.parse((await fileBytes(join(root.path,path),MAX_STATE)).bytes.toString('utf8')));}catch{complete=false;}continue;
   }
   if(root.kind==='artifacts'&&/^[a-f0-9]{64}\.record\.json$/.test(path)){
    try{DistrictKnowledgeRecordSchema.parse(JSON.parse((await fileBytes(join(root.path,path),MAX_STATE)).bytes.toString('utf8')));}catch{complete=false;}continue;
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
     // A static import cannot work: preparation-run constructs schemas from
     // prepared-document, which itself imports this lifecycle module.
     (await import('./district-preparation-run.ts')).preparationPlanSchema.parse(JSON.parse(bytes.toString('utf8')));
     if(basename(path)!==digest(bytes)+'.json')complete=false;
    }catch{complete=false;}continue;
   }
   if(root.kind==='prepared'&&/^[a-f0-9]{64}\.json$/.test(path)){
    try{const {bytes}=await fileBytes(join(root.path,path),MAX_CONTENT),value=JSON.parse(bytes.toString('utf8')),{receiptSha256,...body}=value;
     if(value.version!=='district-prepared-v1'||receiptSha256!==path.slice(0,-5)||digest(canonical(body))!==receiptSha256||typeof value.text!=='string'||digest(value.text)!==value.textSha256||!Array.isArray(value.references)||!value.references.length)throw new CivicPolicyStateError();
     for(const ref of value.references){if(ref.sha256!==value.sourceSha256)throw new CivicPolicyStateError();const entry=makeEntry(root,{relativePath:path,contentSha256:digest(bytes),sourceSha256:value.sourceSha256,url:ref.url,observationId:ref.id,receiptSha256,independentAllowed:independentPolicy(ref.policy,ref.url,value.sourceSha256)});if(!inventory.entries.some(item=>item.id===entry.id))mergeEntries(inventory,[entry]);}
    }catch{complete=false;}
   }
   paths.add(path);
  }
 };
 await visit('');
 for(const path of paths){const entries=inventory.entries.filter(entry=>entry.rootId===root.id&&entry.relativePath===path);
  if(!entries.length){complete=false;continue;}try{const actual=await fileDigest(join(root.path,path));if(entries.every(entry=>entry.contentSha256!==actual.sha256))complete=false;}catch{complete=false;}
 }
 return complete;
}
function managedRootPath(input:string,state:string):string{
 const path=resolve(input);
 if(path===parse(path).root||path===homedir()||path===state||contained(path,state)||contained(state,path)||path.split(sep).some(part=>part==='.secrets'||part==='.ssh'||part==='.git'))throw new CivicPolicyStateError();
 return path;
}
async function enrollRoot(state:string,path:string,kind:Root['kind']):Promise<Root>{
 const inventory=await loadInventory(state),stat=await directory(path,true),id=digest(path);let root=inventory.roots.find(root=>root.id===id);
 if(root){if(root.kind!==kind||!sameIdentity(root.identity,stat))throw new CivicPolicyStateError();}
 else{if(inventory.roots.some(root=>contained(root.path,path)||contained(path,root.path)))throw new CivicPolicyStateError();root={id,path,kind,identity:{dev:stat.dev,ino:stat.ino},complete:false};inventory.roots.push(root);}
 root.complete=await reconcile(root,inventory);await saveInventory(state,inventory);return root;
}
async function readAcquisitionLaneMarker(path:string,kind:Root['kind']):Promise<void>{
 try{
  const stat=await directory(path),marker=laneMarkerSchema.parse(JSON.parse((await fileBytes(join(path,LANE_MARKER),8192,true)).bytes.toString('utf8')));
  if(marker.kind!==kind||marker.rootId!==digest(path)||!sameIdentity(marker.identity,stat))throw new CivicPolicyStateError('ACQUISITION_LANE_MISMATCH');
 }catch(error){if(missing(error))throw error;throw new CivicPolicyStateError('ACQUISITION_LANE_UNSAFE');}
}
const laneInitializations=new Map<string,Promise<void>>();
/** Explicit acquisition opt-in, never inferred from a dated directory name.
 * Nonempty unmarked roots are rejected before shared policy state is mutated.
 * This also enrolls the root and verifies inventory completeness; generic legacy
 * inventory registration deliberately cannot authorize acquisition.
 */
export async function initializeManagedAcquisitionLane(input:string,options:ManagedAcquisitionLaneOptions):Promise<void>{
 if(options.decisionId!==CIVIC_ACQUISITION_DECISION_ID)throw new CivicPolicyStateError('ACQUISITION_DECISION_REQUIRED');
 const state=statePath(options),path=managedRootPath(input,state),kind=kindSchema.parse(options.kind??'fetch');
 const needsMarker=async():Promise<boolean>=>{
  try{await directory(path);}catch(error){if(missing(error))return true;throw error;}
  try{await readAcquisitionLaneMarker(path,kind);return false;}catch(error){if(!missing(error))throw error;}
  for await(const _entry of await opendir(path))throw new CivicPolicyStateError('ACQUISITION_LANE_REQUIRED');
  return true;
 };
 const prior=laneInitializations.get(path)??Promise.resolve();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});laneInitializations.set(path,gate);await prior;
 try{
  await needsMarker();
  await locked(state,async()=>{
   if(await needsMarker()){
    const stat=await directory(path,true);
    await atomicJson(join(path,LANE_MARKER),{schemaVersion:1,decisionId:CIVIC_ACQUISITION_DECISION_ID,rootId:digest(path),identity:{dev:stat.dev,ino:stat.ino},kind},true,false);
   }
   const root=await enrollRoot(state,path,kind);if(!root.complete)throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');
  });
 }finally{release();if(laneInitializations.get(path)===gate)laneInitializations.delete(path);}
}
/** Explicit legacy purge inventory, not an acquisition-lane authorization. */
export async function registerManagedCacheRoot(input:string,options:{kind:'fetch'|'prepared'|'artifacts';stateDir?:string}):Promise<void>{
 const state=statePath(options),path=managedRootPath(input,state),kind=kindSchema.parse(options.kind);
 await locked(state,async()=>{await enrollRoot(state,path,kind);});
}
/** Explicitly registered artifacts are checked, not blessed by a boolean assertion. */
export async function markManagedCacheInventoryComplete(input:string,options:CivicPolicyOptions={}):Promise<void>{
 const state=statePath(options);await locked(state,async()=>{const inventory=await loadInventory(state),root=inventory.roots.find(root=>root.path===resolve(input));if(!root)throw new CivicPolicyStateError();root.complete=await reconcile(root,inventory);await saveInventory(state,inventory);if(!root.complete)throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');});
}
export async function recordManagedSourceContent(input:string,entry:ManagedSourceContent,options:CivicPolicyOptions={}):Promise<void>{
 const state=statePath(options);await locked(state,async()=>{const inventory=await loadInventory(state),root=inventory.roots.find(root=>root.path===resolve(input));if(!root)throw new CivicPolicyStateError();await verifyRoot(root);await assertHostNotOptedOut(entry.url,options);const item=makeEntry(root,entry),actual=await fileDigest(join(root.path,item.relativePath));if(actual.sha256!==item.contentSha256)throw new CivicPolicyStateError();mergeEntries(inventory,[item]);await saveInventory(state,inventory);});
}
/** All source-content producers must use this boundary, including cache hits.
 * Entries commit before the callback. An interrupted write remains inventoried;
 * objections publish independently, then wait for this lock before purging.
 * The callback must not recursively invoke inventory APIs or write other paths.
 * The root must first be explicitly initialized as an acquisition lane.
 */
export async function withManagedSourceWrite<T>(input:string,entries:ManagedSourceContent[],work:()=>Promise<T>,options:CivicPolicyOptions={}):Promise<T>{
 const state=statePath(options);return locked(state,async()=>{
  const inventory=await loadInventory(state),root=inventory.roots.find(root=>root.path===resolve(input));if(!root||!root.complete||!entries.length)throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');await verifyRoot(root);
  try{await readAcquisitionLaneMarker(root.path,root.kind);}catch(error){if(missing(error))throw new CivicPolicyStateError('ACQUISITION_LANE_REQUIRED');throw error;}
  for(const entry of entries)await assertHostNotOptedOut(entry.url,options);
  const items=entries.map(entry=>makeEntry(root,entry));
  for(const item of items){
   const prior=inventory.entries.filter(entry=>entry.rootId===root.id&&entry.relativePath===item.relativePath);
   try{const actual=await fileDigest(join(root.path,item.relativePath));if(actual.sha256!==item.contentSha256&&!prior.some(entry=>entry.contentSha256===actual.sha256))throw new CivicPolicyStateError();}
   catch(error){if(!missing(error))throw error;}
  }
  mergeEntries(inventory,items);await saveInventory(state,inventory);
  const result=await work();await verifyRoot(root);await readAcquisitionLaneMarker(root.path,root.kind);
  for(const entry of entries)await assertHostNotOptedOut(entry.url,options);
  for(const item of items){const actual=await fileDigest(join(root.path,item.relativePath));if(actual.sha256!==item.contentSha256)throw new CivicPolicyStateError();}
  return result;
 });
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
  try{actual=await fileDigest(join(root.path,first.relativePath));}catch(error){if(missing(error)){for(const entry of items){if(entry.state==='active')receipt.removedReferences++;entry.state='missing';}receipt.missingFiles++;continue;}issue('unsafe_content');continue;}
  const matching=items.find(entry=>entry.contentSha256===actual.sha256);
  if(!matching){
   if(inventory.entries.some(entry=>entry.rootId===root.id&&entry.relativePath===first.relativePath&&entry.contentSha256===actual.sha256)){for(const entry of items){if(entry.state==='active')receipt.removedReferences++;entry.state='missing';}continue;}
   issue('content_changed');continue;
  }
  first=matching;
  const others=inventory.entries.filter(entry=>entry.rootId===root.id&&entry.relativePath===first.relativePath&&entry.contentSha256===actual.sha256&&entry.state==='active'&&!items.includes(entry));let independent=true;
  try{
   for(const item of items.filter(entry=>entry.contentSha256===actual.sha256)){
    let covered=false;
    for(const other of others)if(other.independentAllowed&&other.sourceSha256===item.sourceSha256&&other.urlSha256!==item.urlSha256&&other.observationId!==item.observationId&&!(await readObjection(state,other.host))){covered=true;break;}
    if(!covered){independent=false;break;}
   }
  }catch{issue('inventory_unavailable');continue;}
  if(independent){
   for(const entry of items){if(entry.state==='active')receipt.removedReferences++;entry.state='revoked';}
   receipt.retainedSharedFiles++;receipt.retainedSharedBytes+=actual.stat.size;
   // Hash identity, not a caller flag or filename, distinguishes an original
   // shared representation from a derived copy that may embed withdrawn refs.
   if(items.some(entry=>entry.contentSha256===actual.sha256&&entry.sourceSha256!==actual.sha256))issue('shared_derived_requires_rebuild');
   continue;
  }
  try{
   // Digest and inode are rechecked immediately before a nonrecursive unlink.
   // Owner-only state/root components exclude other users from the rename race;
   // participating producers are serialized by the shared inventory lock.
   await verifyRoot(root);await directory(dirname(join(root.path,first.relativePath)));const now=await lstat(join(root.path,first.relativePath));
   if(!now.isFile()||now.isSymbolicLink()||now.nlink!==1||!sameIdentity(now,actual.stat)||now.size!==actual.stat.size||now.mtimeMs!==actual.stat.mtimeMs||now.ctimeMs!==actual.stat.ctimeMs)throw new CivicPolicyStateError();
   await unlink(join(root.path,first.relativePath));receipt.deletedFiles++;receipt.deletedBytes+=actual.stat.size;
   for(const entry of inventory.entries.filter(entry=>entry.rootId===root.id&&entry.relativePath===first.relativePath)){if(items.includes(entry)&&entry.state==='active')receipt.removedReferences++;entry.state='deleted';}
  }catch{issue('unsafe_content');}
 }
}
async function purgeLocked(state:string,objection:Objection):Promise<PurgeReceipt>{
 const receipt=emptyReceipt(objection);let inventory:Inventory;
 try{inventory=await loadInventory(state);}catch{receipt.status='error';receipt.issues.push({code:'inventory_unavailable'});await saveAttempt(state,receipt);return receipt;}
 if(!inventory.roots.length)receipt.issues.push({code:'no_managed_roots'});
 for(const root of inventory.roots){try{root.complete=await reconcile(root,inventory);}catch{root.complete=false;receipt.issues.push({code:'unsafe_root',rootId:root.id});}if(!root.complete)receipt.issues.push({code:'inventory_incomplete',rootId:root.id});}
 // Revoked shared entries are reconsidered on retries: the independent host may
 // have objected since the previous attempt. Tombstones never authorize reads.
 await withdraw(state,inventory,inventory.entries.filter(entry=>entry.host===objection.host&&(entry.state==='active'||entry.state==='revoked')),receipt);
 receipt.status=receipt.issues.length?'partial':'purged';await saveInventory(state,inventory);await saveAttempt(state,receipt);return receipt;
}
/** Owner/operator-only action. Blocking is durable BEFORE any inventory lock or
 * purge, and this call awaits the purge attempt rather than scheduling a cron.
 * A busy/unavailable inventory yields a durable error receipt; no lock stealing.
 */
export async function recordHostOptOut(input:{host:string;reason:'municipality_objection'|'rights_holder_objection';reference?:string;receivedAt?:string},options:CivicPolicyOptions={}):Promise<OptOutReceipt>{
 const state=statePath(options),host=canonicalHost(input.host),receivedAt=new Date(timestamp.parse(input.receivedAt??new Date().toISOString())).toISOString();
 if(Date.parse(receivedAt)>Date.now())throw new CivicPolicyStateError('INVALID_RECEIVED_AT');
 const objection=objectionSchema.parse({schemaVersion:1,host,reason:input.reason,reference:input.reference,receivedAt,purgeDueAt:new Date(Date.parse(receivedAt)+WEEK).toISOString()});
 await ensureState(state);
 try{await atomicJson(objectionPath(state,host),objection,true);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 let effective=(await readObjection(state,host))!;
 if(Date.parse(objection.receivedAt)<Date.parse(effective.receivedAt)){
  // Deadline tightening does not wait for a busy purge lock and cannot race a
  // competing registration into extending the deadline: revisions are immutable.
  try{await atomicJson(join(state,'hosts',digest(host)+'-'+digest(objection.receivedAt)+'.json'),objection,true);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  effective=(await readObjection(state,host))!;
 }
 try{
  const purge=await locked(state,async()=>{effective=(await readObjection(state,host))!;return purgeLocked(state,effective);});return {...effective,receivedAt:purge.receivedAt,purgeDueAt:purge.purgeDueAt,purge};
 }catch(error){const purge=emptyReceipt(effective);purge.status='error';purge.issues.push({code:error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_BUSY'?'inventory_busy':'operation_failed'});await saveAttempt(state,purge);return {...effective,receivedAt:purge.receivedAt,purgeDueAt:purge.purgeDueAt,purge};}
}
export async function purgeOptedOutHost(input:string,options:CivicPolicyOptions={}):Promise<PurgeReceipt>{
 const state=statePath(options),host=canonicalHost(input),objection=await readObjection(state,host);if(!objection)throw new CivicPolicyStateError('HOST_NOT_REGISTERED');
 try{return await locked(state,async()=>purgeLocked(state,(await readObjection(state,host))!));}
 catch(error){const receipt=emptyReceipt(objection);receipt.status='error';receipt.issues.push({code:error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_BUSY'?'inventory_busy':'operation_failed'});await saveAttempt(state,receipt);return receipt;}
}
/** Withdraws only newly managed provenance for a classification exclusion. No
 * legacy/frozen discovery, host-wide objection or public metadata deletion.
 */
export async function relinquishManagedSourceContent(input:string,source:{url:string;sourceSha256:string},options:CivicPolicyOptions={}):Promise<{disposition:'removed'|'retained_independent'|'not_managed'|'partial';removedReferences:number}>{
 const state=statePath(options),host=hostFromUrl(source.url),sourceSha256=hex.parse(source.sourceSha256),urlSha256=urlHash(source.url);
 return locked(state,async()=>{const inventory=await loadInventory(state),root=inventory.roots.find(root=>root.path===resolve(input));if(!root)return {disposition:'not_managed',removedReferences:0};if(root.kind!=='fetch')throw new CivicPolicyStateError();
  const entries=inventory.entries.filter(entry=>entry.rootId===root.id&&entry.host===host&&entry.urlSha256===urlSha256&&entry.sourceSha256===sourceSha256&&(entry.state==='active'||entry.state==='revoked'));if(!entries.length)return {disposition:'not_managed',removedReferences:0};
  const now=new Date().toISOString(),receipt=emptyReceipt({schemaVersion:1,host,reason:'rights_holder_objection',receivedAt:now,purgeDueAt:now});await withdraw(state,inventory,entries,receipt);await saveInventory(state,inventory);
  return {disposition:receipt.issues.length?'partial':receipt.retainedSharedFiles?'retained_independent':'removed',removedReferences:receipt.removedReferences};
 });
}
/** CLI is an explicit local operator action, never a web/contact endpoint.
 * register --host HOST --reason CODE [--reference OPAQUE] [--received-at ISO]
 * purge --host HOST; both accept --state-dir PATH and return metadata only.
 * Exit 2 means partial/error; a deadline is never evidence of completed purge.
 */
export async function civicOptOutMain(args:string[]=process.argv.slice(2)):Promise<void>{
 const command=args[0],{values}=parseArgs({args:args.slice(1),options:{host:{type:'string'},reason:{type:'string'},reference:{type:'string'},'received-at':{type:'string'},'state-dir':{type:'string'}},strict:true});
 if(!values.host||!['register','purge'].includes(command))throw new CivicPolicyStateError('INVALID_OPERATOR_ARGUMENTS');
 const options={stateDir:values['state-dir']};
 const receipt=command==='register'?await recordHostOptOut({host:values.host,reason:reasonSchema.parse(values.reason),reference:values.reference,receivedAt:values['received-at']},options):await purgeOptedOutHost(values.host,options);
 console.log(JSON.stringify(receipt));const purge='purge' in receipt?receipt.purge:receipt;if(purge.status!=='purged')process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)civicOptOutMain().catch(()=>{console.error('Civic opt-out operation failed; acquisition remains fail-closed. Operator review required.');process.exitCode=2;});
