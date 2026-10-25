import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {sha256,hashSchema} from './district-schema.ts';
import {RetainedPublicationSourceSchema,retainedPublicationSources} from './district-retained-import.ts';
import type {RetainedPublicationSource} from './district-retained-import.ts';
import {readPinnedJson,writeManagedSourceArtifact} from './district-private-io.ts';
import {assertCivicPolicyAuthority,assertHostNotOptedOut,assertManagedSourceReadable,assertManagedSourceBindings,CIVIC_ACQUISITION_DECISION_ID} from './civic-opt-out.ts';
import type {CivicPolicyOptions} from './civic-opt-out.ts';

export const HISTORICAL_GIT_SNAPSHOT_ROOT=fileURLToPath(new URL('../cache/historical-change/owner-policy-2026-10-11',import.meta.url));
const frozenOutput=fileURLToPath(new URL('../out',import.meta.url));
const purpose='historical_change_reconstruction_only' as const;
const oidSchema=z.string().regex(/^[a-f0-9]{40}$/);
const relativePathSchema=z.string().min(1).max(2048).refine(value=>!isAbsolute(value)&&!value.includes('\\')&&!value.includes('\0')&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..'),'Contained Git path required');
const filePinSchema=z.object({path:z.string().min(1),sha256:hashSchema,bytes:z.number().int().nonnegative().max(512*1024*1024)}).strict();
const objectPinSchema=filePinSchema.extend({oid:oidSchema}).strict();
export const GitSnapshotSchema=z.object({gitCommit:oidSchema,path:relativePathSchema,blobOid:oidSchema,sha256:hashSchema,bytes:z.number().int().nonnegative().max(512*1024*1024)}).strict();
export type GitSnapshot=z.infer<typeof GitSnapshotSchema>;
const bindingSchema=RetainedPublicationSourceSchema.extend({kind:z.literal('authenticated_git_snapshot'),purpose:z.literal(purpose),snapshot:GitSnapshotSchema,independentAllowed:z.literal(false)}).strict();
export const gitSnapshotSourcePinSchema=filePinSchema.extend({schemaVersion:z.literal('stadtstack-authenticated-git-snapshot-v1'),snapshot:GitSnapshotSchema,bindings:z.array(bindingSchema).min(1)}).strict().superRefine((pin,ctx)=>{
 if(pin.sha256!==pin.snapshot.sha256||pin.bytes!==pin.snapshot.bytes||pin.bindings.some(binding=>JSON.stringify(binding.snapshot)!==JSON.stringify(pin.snapshot)))ctx.addIssue({code:'custom',message:'Git baseline source pin snapshot mismatch'});
});
export type GitSnapshotSourcePin=z.infer<typeof gitSnapshotSourcePinSchema>;
const destinationSchema=z.string().min(1).max(2048).refine(value=>!isAbsolute(value)&&!value.includes('\\')&&value.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(part))&&/\.(?:json|geojson)$/.test(value),'Contained historical JSON destination required');
const memberShape={purpose:z.literal(purpose),snapshot:GitSnapshotSchema,commit:objectPinSchema,trees:z.array(objectPinSchema).min(1).max(128),blob:filePinSchema,declaredSources:z.array(RetainedPublicationSourceSchema).min(1).max(100_000),destinationPath:destinationSchema};
export const AuthenticatedGitSnapshotImportSchema=z.object({...memberShape,managedRoot:z.string().min(1)}).strict();
export type AuthenticatedGitSnapshotImport=z.infer<typeof AuthenticatedGitSnapshotImportSchema>;
export const AuthenticatedGitSnapshotImportPlanSchema=z.object({schemaVersion:z.literal('stadtstack-git-snapshot-import-plan-v1'),managedRoot:z.string().min(1),imports:z.array(z.object(memberShape).strict()).min(1).max(10_000)}).strict();
export type AuthenticatedGitSnapshotImportPlan=z.infer<typeof AuthenticatedGitSnapshotImportPlanSchema>;
type FilePin=z.infer<typeof filePinSchema>;

function gitOid(kind:'commit'|'tree'|'blob',bytes:Uint8Array){return createHash('sha1').update(`${kind} ${bytes.byteLength}\0`).update(bytes).digest('hex');}
function contained(root:string,path:string){const part=relative(resolve(root),resolve(path));return part===''||!isAbsolute(part)&&part!=='..'&&!part.startsWith('../');}
async function assertSources(sources:RetainedPublicationSource[],policy:CivicPolicyOptions){
 await assertCivicPolicyAuthority(policy);
 const keys=new Set<string>();
 for(const source of sources){const key=JSON.stringify([source.url,source.sourceSha256]);if(keys.has(key))throw Error('Duplicate historical source declaration');keys.add(key);await assertHostNotOptedOut(source.url,policy);}
}
/** Object/file pins refer to exact uncompressed Git object BODY bytes, without a Git object header. */
async function readBytes(pin:FilePin,limit=512*1024*1024):Promise<Buffer>{
 if(pin.bytes>limit)throw Error('Git snapshot input exceeds object byte limit');
 const path=resolve(pin.path);
 if(await realpath(path)!==path)throw Error('Git snapshot input alias rejected');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.size!==BigInt(pin.bytes))throw Error('Git snapshot input file type/length mismatch');
  const bytes=await handle.readFile(),after=await handle.stat({bigint:true});
  if(bytes.byteLength!==pin.bytes||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||sha256(bytes)!==pin.sha256)throw Error('Git snapshot input byte pin mismatch');
  return bytes;
 }finally{await handle.close();}
}
function treeEntries(bytes:Buffer){
 const entries=new Map<string,{mode:string;oid:string}>();let offset=0;
 while(offset<bytes.length){
  const space=bytes.indexOf(0x20,offset),nul=space<0?-1:bytes.indexOf(0,space+1);
  if(space<=offset||nul<=space+1||nul+21>bytes.length)throw Error('Malformed Git tree object');
  const mode=bytes.subarray(offset,space).toString('ascii');
  if(!/^(?:40000|100644|100755|120000|160000)$/.test(mode))throw Error('Unsupported Git tree entry mode');
  const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(space+1,nul));
  if(!name||name==='.'||name==='..'||name.includes('/')||name.includes('\\')||entries.has(name))throw Error('Ambiguous Git tree entry path');
  entries.set(name,{mode,oid:bytes.subarray(nul+1,nul+21).toString('hex')});offset=nul+21;
 }
 return entries;
}
function commitRootTree(bytes:Buffer){
 const end=bytes.indexOf('\n\n');if(end<0)throw Error('Malformed Git commit object');
 const headers=bytes.subarray(0,end).toString('utf8').split('\n'),trees=headers.filter(line=>line.startsWith('tree '));
 if(trees.length!==1||headers[0]!==trees[0]||!/^tree [a-f0-9]{40}$/.test(trees[0]))throw Error('Git commit root tree binding missing or ambiguous');
 return trees[0].slice(5);
}
/** Role-neutral cryptographic proof only: confers no source, configuration or historical-use permission. */
export function authenticateGitObjectProof(snapshotInput:GitSnapshot,commit:Buffer,trees:ReadonlyMap<string,Buffer>,blob:Buffer):void{
 const snapshot=GitSnapshotSchema.parse(snapshotInput);
 if(gitOid('commit',commit)!==snapshot.gitCommit)throw Error('Git object OID mismatch');
 for(const [oid,body] of trees)if(gitOid('tree',body)!==oid)throw Error('Git object OID mismatch');
 let treeOid=commitRootTree(commit);const used=new Set<string>(),parts=snapshot.path.split('/');
 for(const [index,part] of parts.entries()){
  const body=trees.get(treeOid);if(!body)throw Error('Git snapshot tree chain is incomplete');used.add(treeOid);
  const entry=treeEntries(body).get(part);if(!entry)throw Error('Git snapshot path not present in authenticated tree');
  if(index===parts.length-1){
   if(!['100644','100755'].includes(entry.mode))throw Error('Git snapshot target is not a regular file');
   if(entry.oid!==snapshot.blobOid)throw Error('Git snapshot path blob OID mismatch');
  }else{if(entry.mode!=='40000')throw Error('Git snapshot path traverses a non-tree entry');treeOid=entry.oid;}
 }
 if(used.size!==trees.size)throw Error('Git snapshot contains unrelated tree proofs');
 if(blob.length!==snapshot.bytes||sha256(blob)!==snapshot.sha256)throw Error('Git blob byte pin mismatch');
 if(gitOid('blob',blob)!==snapshot.blobOid)throw Error('Git blob OID mismatch');
}
async function authenticate(input:AuthenticatedGitSnapshotImport,policy:CivicPolicyOptions){
 await assertSources(input.declaredSources,policy);
 if(input.commit.oid!==input.snapshot.gitCommit||input.blob.sha256!==input.snapshot.sha256||input.blob.bytes!==input.snapshot.bytes)throw Error('Git snapshot expected pin mismatch');
 const commit=await readBytes(input.commit,16*1024*1024),trees=new Map<string,Buffer>();
 for(const pin of input.trees){if(trees.has(pin.oid))throw Error('Duplicate Git tree proof');trees.set(pin.oid,await readBytes(pin,16*1024*1024));}
 await assertSources(input.declaredSources,policy);
 const bytes=await readBytes(input.blob);
 authenticateGitObjectProof(input.snapshot,commit,trees,bytes);
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('Historical Git snapshot JSON invalid');}
 const sources=retainedPublicationSources(value),declared=new Set(input.declaredSources.map(source=>JSON.stringify([source.url,source.sourceSha256])));
 if(sources.length!==declared.size||sources.some(source=>!declared.has(JSON.stringify([source.url,source.sourceSha256]))))throw Error('Git snapshot source declarations differ from original URL/hash inventory');
 await assertSources(sources,policy);
 return {bytes,bindings:sources.map(source=>({kind:'authenticated_git_snapshot' as const,purpose,snapshot:input.snapshot,...source,independentAllowed:false as const}))};
}
async function destination(input:AuthenticatedGitSnapshotImport){
 const root=resolve(input.managedRoot),path=join(root,input.destinationPath);
 if(contained(root,frozenOutput)||contained(frozenOutput,root))throw Error('Historical Git destination overlaps frozen publication');
 for(const pin of [input.commit,...input.trees,input.blob])if(contained(root,pin.path))throw Error('Historical Git destination overlaps original input');
 let parent=root;
 for(;;){try{const stat=await lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Historical Git destination alias rejected');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const next=dirname(parent);if(next===parent)break;parent=next;}
 return {root,path};
}
/** Private baseline import only. This is not a release, HTTP observation or new claim admission. */
export async function importAuthenticatedGitSnapshot(raw:AuthenticatedGitSnapshotImport,policy:CivicPolicyOptions):Promise<GitSnapshotSourcePin>{
 const input=AuthenticatedGitSnapshotImportSchema.parse(raw);
 await assertSources(input.declaredSources,policy);
 const {root,path}=await destination(input),proof=await authenticate(input,policy);
 const digest=await writeManagedSourceArtifact(root,path,proof.bytes,proof.bindings,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const pin=gitSnapshotSourcePinSchema.parse({schemaVersion:'stadtstack-authenticated-git-snapshot-v1',path,sha256:digest,bytes:proof.bytes.length,snapshot:input.snapshot,bindings:proof.bindings});
 await assertManagedSourceBindings(path,pin.bindings,{...policy,purpose});
 return pin;
}
/** Only historical change reconstruction may read this baseline; no native/claim admission fallback. */
export async function readAuthenticatedGitSnapshotSourcePin(raw:GitSnapshotSourcePin,policy:CivicPolicyOptions):Promise<Buffer>{
 const pin=gitSnapshotSourcePinSchema.parse(raw),context={...policy,purpose};
 await assertSources(pin.bindings,policy);await assertManagedSourceReadable(pin.path,context);await assertManagedSourceBindings(pin.path,pin.bindings,context);
 const bytes=await readBytes(pin);
 if(gitOid('blob',bytes)!==pin.snapshot.blobOid)throw Error('Managed historical Git blob OID mismatch');
 await assertManagedSourceReadable(pin.path,context);await assertManagedSourceBindings(pin.path,pin.bindings,context);
 return bytes;
}
export async function readAuthenticatedGitSnapshotImportPlan(path:string,expectedSha256:string,policy:CivicPolicyOptions):Promise<AuthenticatedGitSnapshotImportPlan>{
 await assertCivicPolicyAuthority(policy);return AuthenticatedGitSnapshotImportPlanSchema.parse(await readPinnedJson(path,expectedSha256,8*1024*1024));
}
export async function runAuthenticatedGitSnapshotImportPlan(raw:AuthenticatedGitSnapshotImportPlan,policy:CivicPolicyOptions):Promise<GitSnapshotSourcePin[]>{
 const plan=AuthenticatedGitSnapshotImportPlanSchema.parse(raw),paths=new Set<string>();await assertCivicPolicyAuthority(policy);
 for(const item of plan.imports){if(paths.has(item.destinationPath))throw Error('Duplicate historical Git destination');paths.add(item.destinationPath);await assertSources(item.declaredSources,policy);await destination({...item,managedRoot:plan.managedRoot});}
 const results:GitSnapshotSourcePin[]=[];
 for(const item of plan.imports)results.push(await importAuthenticatedGitSnapshot({...item,managedRoot:plan.managedRoot},policy));
 return results;
}
