import {constants,type BigIntStats} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {assertCivicPolicyAuthority,readCivicOptOutSnapshot,ManagedSourceBindingSchema,CivicPolicyStateError,CIVIC_ACQUISITION_DECISION_ID,CIVIC_POLICY_STATE_DIR,type CivicPolicyOptions,type CivicPolicyAuthorityReceipt} from './civic-opt-out.ts';
import {ManagedDockerResourceSchema} from './civic-docker.ts';

// This step8-only adapter deliberately does not enter any processing contract's
// source closure. The frozen writer exposes no lock-free inventory loader: its
// public inventory read acquires a writing lock. Decode its bounded v1 wire
// format here, reusing public proof/authority codecs, and never publish or cache
// an authorization. Changes to the writer format must fail closed in this view.
const MAX_STATE=480*1024*1024,MAX_CONTENT=512*1024*1024,MAX_RECORDS=500_000;
const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const hex=z.string().regex(/^[a-f0-9]{64}$/),opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const identity=z.object({dev:z.number().int().nonnegative(),ino:z.number().int().nonnegative()}).strict(),kind=z.enum(['fetch','prepared','artifacts']);
const sourceKinds=['http_observation','prepared_source','retained_publication','authenticated_git_snapshot','operator_registry_config'] as const;
const proofKeys=['observationId','receiptSha256','publication','snapshot','purpose','configurationSha256','schemaContractSha256','code','approval'] as const;
const sourceWire=z.object({host:z.string(),urlSha256:hex,kind:z.enum([...sourceKinds,'pre_admission','preparation_input']),sourceSha256:hex.nullable(),observationId:opaque.optional(),receiptSha256:hex.optional(),publication:z.unknown().optional(),snapshot:z.unknown().optional(),purpose:z.literal('historical_change_reconstruction_only').optional(),configurationSha256:hex.optional(),schemaContractSha256:hex.optional(),code:z.unknown().optional(),approval:z.unknown().optional()}).strict();
function proofShape(value:z.infer<typeof sourceWire>,ctx:z.RefinementCtx){
 const proof:Record<string,unknown>={kind:value.kind,sourceSha256:value.sourceSha256,url:'https://'+value.host+'/'};
 for(const key of proofKeys)if(value[key]!==undefined)proof[key]=value[key];
 // The inventory retains only the host and URL digest. The host-root URL here
 // validates proof shape; it never stands in for original URL identity/evidence.
 if(value.kind==='pre_admission'||value.kind==='preparation_input'){
  if(value.sourceSha256===null||proofKeys.some(key=>value[key]!==undefined))ctx.addIssue({code:'custom',message:'Invalid pre-admission provenance'});
 }else{
  if(value.kind==='operator_registry_config'){
   if(value.sourceSha256!==null)ctx.addIssue({code:'custom',message:'Invalid registry provenance'});
   delete proof.sourceSha256;
  }
  if(!ManagedSourceBindingSchema.safeParse(proof).success)ctx.addIssue({code:'custom',message:'Invalid managed source provenance'});
 }
}
const sourceSchema=sourceWire.superRefine(proofShape);
const entrySchema=sourceWire.extend({id:hex,rootId:hex,relativePath:z.string(),contentSha256:hex,kind:z.enum(sourceKinds),independentAllowed:z.boolean(),state:z.enum(['active','revoked','deleted','missing'])}).strict().superRefine((value,ctx)=>{
 proofShape(value,ctx);
 if(['retained_publication','authenticated_git_snapshot','operator_registry_config'].includes(value.kind)&&value.independentAllowed)ctx.addIssue({code:'custom',message:'Derived proof cannot be independent'});
});
const rootSchema=z.object({id:hex,path:z.string(),kind,identity,complete:z.boolean(),casWatermarks:z.record(hex,z.object({stamp:z.string().max(256).regex(/^\d+(?::\d+){7}$/),checkedAtNs:z.string().regex(/^\d{1,24}$/)}).strict()).optional()}).strict();
const scratchSchema=z.object({id:z.uuid(),rootId:hex,directory:z.string(),purpose:z.enum(['document','classification','openai','artifact']),createdAt:z.string().datetime({offset:true}),ownerPid:z.number().int().positive(),identity:identity.nullable(),state:z.enum(['planned','active','closing','closed','purged','partial']),sources:z.array(sourceSchema).min(1).max(100_000),groups:z.array(z.object({pid:z.number().int().positive(),settled:z.boolean()}).strict()).max(256),resources:z.array(ManagedDockerResourceSchema).max(16).default([]),tombstones:z.array(z.object({pathSha256:hex,contentSha256:hex,bytes:z.number().int().nonnegative()}).strict()).max(512)}).strict();
const inventorySchema=z.object({schemaVersion:z.literal(1),inventoryId:z.uuid(),roots:z.array(rootSchema).max(10_000),entries:z.array(entrySchema).max(MAX_RECORDS),scratch:z.array(scratchSchema).max(MAX_RECORDS).default([])}).strict();
const pinSchema=z.object({sha256:hex,bytes:z.number().int().positive().max(MAX_STATE),family:z.enum(['entries','scratch']),previousSha256:hex.nullable()}).strict();
const hotSchema=inventorySchema.extend({storage:z.object({format:z.literal('sealed-segments-v1'),segments:z.array(pinSchema).max(MAX_RECORDS),entryStates:z.record(hex,z.enum(['active','revoked','deleted','missing'])),retiredRoots:z.record(hex,hex)}).strict()});
const segmentSchema=z.object({schemaVersion:z.literal('civic-inventory-segment-v1'),inventoryId:z.uuid(),family:z.enum(['entries','scratch']),previousSha256:hex.nullable(),entries:z.array(entrySchema).max(MAX_RECORDS),scratch:z.array(scratchSchema).max(MAX_RECORDS)}).strict();
const laneSchema=z.object({schemaVersion:z.literal(1),decisionId:z.literal(CIVIC_ACQUISITION_DECISION_ID),rootId:hex,identity,kind,authorityId:opaque,authoritySha256:hex}).strict();
type Root=z.infer<typeof rootSchema>;
type Entry=z.infer<typeof entrySchema>;
type Inventory=z.infer<typeof inventorySchema>;
const sameIdentity=(a:{dev:number|bigint;ino:number|bigint},b:{dev:number|bigint;ino:number|bigint})=>BigInt(a.dev)===BigInt(b.dev)&&BigInt(a.ino)===BigInt(b.ino);
const stamp=(stat:BigIntStats)=>[stat.dev,stat.ino,stat.mode,stat.uid,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
const contained=(root:string,path:string)=>{const child=relative(root,path);return !!child&&child!=='..'&&!child.startsWith('..'+sep)&&!isAbsolute(child);};
async function directory(path:string,privateLeaf=false){
 const absolute=resolve(path),base=parse(absolute).root;let current=base,result=await lstat(base);
 for(const component of absolute.slice(base.length).split(sep).filter(Boolean)){
  current=join(current,component);result=await lstat(current);
  if(!result.isDirectory()||result.isSymbolicLink()||(result.mode&0o022)!==0&&(result.mode&0o1000)===0)throw new CivicPolicyStateError();
 }
 if(result.uid!==process.getuid?.()||privateLeaf&&(result.mode&0o077)!==0)throw new CivicPolicyStateError();return result;
}
async function fileBytes(path:string,max:number,privateFile=false,segment=false){
 await directory(dirname(path),segment);const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await handle.stat({bigint:true}),before=stamp(stat);
  if(!stat.isFile()||stat.nlink!==1n||stat.uid!==BigInt(process.getuid!())||(stat.mode&BigInt(privateFile?0o077:0o022))!==0n||segment&&(stat.mode&0o777n)!==0o600n||stat.size>BigInt(max)||stamp(await lstat(path,{bigint:true}))!==before)throw new CivicPolicyStateError();
  const buffer=Buffer.allocUnsafe(Number(stat.size)+1);let total=0;
  while(total<buffer.length){const {bytesRead}=await handle.read(buffer,total,buffer.length-total,null);if(!bytesRead)break;total+=bytesRead;}
  if(BigInt(total)!==stat.size||stamp(await handle.stat({bigint:true}))!==before||stamp(await lstat(path,{bigint:true}))!==before)throw new CivicPolicyStateError();
  const bytes=buffer.subarray(0,total);return {bytes,sha256:digest(bytes),stat};
 }finally{await handle.close();}
}
// Epoch checks need only a digest: do not retain another inventory-sized buffer.
async function inventoryDigest(state:string){
 const path=join(state,'inventory.json');await directory(state,true);
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await handle.stat({bigint:true}),before=stamp(stat);
  if(!stat.isFile()||stat.nlink!==1n||stat.uid!==BigInt(process.getuid!())||(stat.mode&0o077n)!==0n||stat.size>BigInt(MAX_STATE)||stamp(await lstat(path,{bigint:true}))!==before)throw new CivicPolicyStateError();
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let total=0;
  for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>MAX_STATE)throw new CivicPolicyStateError();hash.update(buffer.subarray(0,bytesRead));}
  if(BigInt(total)!==stat.size||stamp(await handle.stat({bigint:true}))!==before||stamp(await lstat(path,{bigint:true}))!==before)throw new CivicPolicyStateError();
  return {sha256:hash.digest('hex'),stat};
 }finally{await handle.close();}
}
function canonicalHost(host:string){
 if(!host||host!==host.trim()||/[\s/@?#\\]/.test(host))throw new CivicPolicyStateError('INVALID_HOST');
 const url=new URL('https://'+host);
 if(url.port||url.username||url.password||url.hostname.toLowerCase().replace(/\.$/,'')!==host||host.length>253||host.includes('%'))throw new CivicPolicyStateError('INVALID_HOST');
 return host;
}
function entryId(entry:Entry){return digest(JSON.stringify([entry.rootId,entry.relativePath,entry.contentSha256,entry.kind,entry.sourceSha256,entry.host,entry.urlSha256,entry.observationId??null,entry.receiptSha256??null,entry.publication??null,entry.snapshot??null,entry.purpose??null,entry.configurationSha256??null,entry.schemaContractSha256??null,entry.code??null,entry.approval??null,entry.independentAllowed]));}
function checkedRelative(root:Root,path:string,contentSha256:string,receiptSha256?:string){
 if(path.includes('\\')||path.includes('\0')||isAbsolute(path)||path.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw new CivicPolicyStateError();
 const derivedFetch=/^(?:oparl-bodies|frontiers)\/[a-f0-9]{64}\.json$/.test(path)||/^api-frontiers\/[a-f0-9]{64}-mv\.json$/.test(path)||/^oparl\/[a-f0-9]{64}\/(?:paper|meeting)\/page-\d+\.json$/.test(path)||/^observations\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/.test(path)||/^requests\/[a-f0-9]{64}\.json$/.test(path)||/^collections\/[a-z0-9][a-z0-9-]{0,159}-(?:collection\.json|signals\.geojson)$/.test(path);
 const shardedCas=path==='sha256/'+contentSha256.slice(0,2)+'/'+contentSha256;
 const artifactPath=path.split('/').length<=12&&path.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(part)&&!/^(?:credentials?|secrets?|auth|tokens?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(part))&&/\.(?:json|jsonl|geojson|txt|md)$/.test(path);
 const valid=root.kind==='fetch'?path==='sha256/'+contentSha256||derivedFetch:root.kind==='prepared'?path===receiptSha256+'.json':path.startsWith('sha256/')?shardedCas:artifactPath;
 if(!valid||!contained(root.path,join(root.path,path)))throw new CivicPolicyStateError();
}
const bulkEntry=(entry:Entry)=>['retained_publication','operator_registry_config','authenticated_git_snapshot'].includes(entry.kind);
const archivedLease=(lease:z.infer<typeof scratchSchema>)=>lease.state==='closed'||lease.state==='purged';
async function loadInventory(state:string,expectedSha256:string,authority:CivicPolicyAuthorityReceipt):Promise<Inventory>{
 try{
  const manifest=await fileBytes(join(state,'inventory.json'),MAX_STATE,true);
  if(manifest.sha256!==expectedSha256)throw new CivicPolicyStateError('CIVIC_POLICY_AUDIT_EPOCH_CHANGED');
  const raw:unknown=JSON.parse(manifest.bytes.toString('utf8'));let inventory:Inventory;
  if(raw&&typeof raw==='object'&&'storage' in raw){
   const hot=hotSchema.parse(raw),entries=new Map<string,Entry>(),scratch=new Map<string,z.infer<typeof scratchSchema>>();
   const ordinals=new Map(hot.storage.segments.map((pin,index)=>[pin.sha256,index])),retired=new Map<string,number>();
   if(ordinals.size!==hot.storage.segments.length)throw new CivicPolicyStateError();
   for(const [rootId,sha256] of Object.entries(hot.storage.retiredRoots)){const ordinal=ordinals.get(sha256);if(ordinal===undefined)throw new CivicPolicyStateError();retired.set(rootId,ordinal);}
   let previous:string|null=null;
   for(const [ordinal,pin] of hot.storage.segments.entries()){
    if(pin.previousSha256!==previous)throw new CivicPolicyStateError();
    const actual=await fileBytes(join(state,'inventory-segments',pin.sha256+'.json'),MAX_STATE,true,true);
    if(actual.bytes.length!==pin.bytes||actual.sha256!==pin.sha256)throw new CivicPolicyStateError();
    const segment=segmentSchema.parse(JSON.parse(actual.bytes.toString('utf8')));
    if(segment.inventoryId!==hot.inventoryId||segment.family!==pin.family||segment.previousSha256!==pin.previousSha256||segment.family==='entries'&&(segment.scratch.length||!segment.entries.length||segment.entries.some(entry=>!bulkEntry(entry)))||segment.family==='scratch'&&(segment.entries.length||!segment.scratch.length||segment.scratch.some(lease=>!archivedLease(lease))))throw new CivicPolicyStateError();
    previous=pin.sha256;
    for(const entry of segment.entries){if((retired.get(entry.rootId)??-1)>=ordinal)continue;if(entries.has(entry.id))throw new CivicPolicyStateError();entries.set(entry.id,entry);}
    for(const lease of segment.scratch){if((retired.get(lease.rootId)??-1)>=ordinal)continue;if(scratch.has(lease.id))throw new CivicPolicyStateError();scratch.set(lease.id,lease);}
   }
   for(const [id,state] of Object.entries(hot.storage.entryStates))if(!entries.has(id)||entries.get(id)!.state===state)throw new CivicPolicyStateError();
   inventory={schemaVersion:1,inventoryId:hot.inventoryId,roots:hot.roots,entries:[...Array.from(entries.values(),entry=>hot.storage.entryStates[entry.id]===undefined?entry:{...entry,state:hot.storage.entryStates[entry.id]}),...hot.entries],scratch:[...scratch.values(),...hot.scratch]};
  }else inventory=inventorySchema.parse(raw);
  const marker=JSON.parse((await fileBytes(join(state,'authority.json'),8192,true)).bytes.toString('utf8'));
  if(digest(JSON.stringify(marker))!==authority.authoritySha256||z.object({inventoryId:z.uuid()}).passthrough().parse(marker).inventoryId!==inventory.inventoryId)throw new CivicPolicyStateError();
  const roots=new Map(inventory.roots.map(root=>[root.id,root]));
  if(roots.size!==inventory.roots.length||inventory.entries.length>MAX_RECORDS||inventory.scratch.length>MAX_RECORDS||new Set(inventory.entries.map(entry=>entry.id)).size!==inventory.entries.length||new Set(inventory.scratch.map(lease=>lease.id)).size!==inventory.scratch.length)throw new CivicPolicyStateError();
  for(const root of inventory.roots)if(root.id!==digest(root.path)||root.path!==resolve(root.path))throw new CivicPolicyStateError();
  for(const entry of inventory.entries){
   const root=roots.get(entry.rootId);if(!root||entry.host!==canonicalHost(entry.host)||entry.id!==entryId(entry)||root.kind==='fetch'&&entry.relativePath.startsWith('sha256/')&&entry.sourceSha256!==entry.contentSha256)throw new CivicPolicyStateError();
   checkedRelative(root,entry.relativePath,entry.contentSha256,entry.receiptSha256);
  }
  for(const lease of inventory.scratch){
   if(!roots.has(lease.rootId)||lease.directory!=='scratch/'+lease.id||lease.sources.some(source=>source.host!==canonicalHost(source.host)||source.kind==='pre_admission'&&lease.purpose!=='classification'||source.kind==='preparation_input'&&lease.purpose!=='document'||['authenticated_git_snapshot','operator_registry_config'].includes(source.kind)&&lease.purpose!=='artifact'))throw new CivicPolicyStateError();
   if(new Set(lease.resources.map(resource=>resource.id)).size!==lease.resources.length||lease.resources.some(resource=>resource.scratchId!==lease.id||resource.rootId!==lease.rootId||resource.name!==('profile' in resource?'stadtstack-omp-b-':'stadtstack-parser-')+lease.id+'-'+resource.nonce||resource.artifactRelativePath===null&&(resource.artifactSha256!==null||resource.artifactBytes!==null)||resource.artifactRelativePath!==null&&(resource.artifactSha256===null||resource.artifactBytes===null)))throw new CivicPolicyStateError('DAEMON_RESOURCE_BINDING_MISMATCH');
  }
  return inventory;
 }catch(error){if(error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_AUDIT_EPOCH_CHANGED')throw error;throw new CivicPolicyStateError('CIVIC_POLICY_INVENTORY_UNAVAILABLE');}
}
async function verifyRoot(root:Root,authority:CivicPolicyAuthorityReceipt){
 if(!sameIdentity(root.identity,await directory(root.path)))throw new CivicPolicyStateError();
 try{
  const marker=laneSchema.parse(JSON.parse((await fileBytes(join(root.path,'.civic-acquisition-lane.json'),8192,true)).bytes.toString('utf8')));
  if(marker.kind!==root.kind||marker.rootId!==digest(root.path)||!sameIdentity(marker.identity,root.identity)||marker.authorityId!==authority.authorityId||marker.authoritySha256!==authority.authoritySha256)throw new CivicPolicyStateError();
 }catch{throw new CivicPolicyStateError('ACQUISITION_LANE_UNSAFE');}
}
/** Batch audit only. Call finish before using results. No locks or writes. */
export async function createReadOnlyManagedSourceAudit(options:CivicPolicyOptions={}){
 const authority=await assertCivicPolicyAuthority(options),policy={...options,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},state=resolve(policy.stateDir??CIVIC_POLICY_STATE_DIR);
 const epoch=await inventoryDigest(state),snapshot=await readCivicOptOutSnapshot(policy),inventory=await loadInventory(state,epoch.sha256,authority);
 const roots=new Set<Root>(),objections=new Set(snapshot.objections.map(entry=>entry.hostSha256)),byPath=new Map<string,Entry[]>();let finished=false;
 for(const entry of inventory.entries){const key=entry.rootId+'\0'+entry.relativePath,bucket=byPath.get(key);if(bucket)bucket.push(entry);else byPath.set(key,[entry]);}
 const assertEpoch=async()=>{
  const current=await inventoryDigest(state);
  if(current.sha256!==epoch.sha256||!sameIdentity(current.stat,epoch.stat)||(await readCivicOptOutSnapshot(policy)).sha256!==snapshot.sha256)throw new CivicPolicyStateError('CIVIC_POLICY_AUDIT_EPOCH_CHANGED');
  await assertCivicPolicyAuthority(policy);
 };
 await assertEpoch();
 return {authority,inventorySha256:epoch.sha256,optOutSnapshotSha256:snapshot.sha256,
  async read(input:string,expectedSha256?:string,purpose?:'historical_change_reconstruction_only'){
   if(finished)throw new CivicPolicyStateError('CIVIC_POLICY_AUDIT_FINISHED');
   const path=resolve(input),root=inventory.roots.find(item=>contained(item.path,path));
   if(!root||!root.complete)throw new CivicPolicyStateError('MANAGED_INVENTORY_INCOMPLETE');
   await verifyRoot(root,authority);roots.add(root);
   const entries=byPath.get(root.id+'\0'+relative(root.path,path).split(sep).join('/'))??[];
   if(!entries.length)throw new CivicPolicyStateError('CONTENT_PROVENANCE_MISSING');
   if(entries.some(entry=>entry.state==='revoked'||objections.has(digest(entry.host))))throw new CivicPolicyStateError('CONTENT_REFERENCE_REVOKED');
   if(entries.some(entry=>entry.kind==='authenticated_git_snapshot')&&purpose!=='historical_change_reconstruction_only')throw new CivicPolicyStateError('HISTORICAL_SOURCE_PURPOSE_REQUIRED');
   const {bytes,sha256}=await fileBytes(path,MAX_CONTENT),current=entries.filter(entry=>entry.contentSha256===sha256);
   if(!current.length||expectedSha256!==undefined&&sha256!==hex.parse(expectedSha256))throw new CivicPolicyStateError('CONTENT_BINDING_MISMATCH');
   if(current.some(entry=>entry.state!=='active'))throw new CivicPolicyStateError('CONTENT_REFERENCE_REVOKED');return bytes;
  },
  async finish(){
   if(finished)throw new CivicPolicyStateError('CIVIC_POLICY_AUDIT_FINISHED');finished=true;
   for(const root of roots)await verifyRoot(root,authority);
   await assertEpoch();await loadInventory(state,epoch.sha256,authority);await assertEpoch();
   return {inventorySha256:epoch.sha256,optOutSnapshotSha256:snapshot.sha256};
  }};
}
