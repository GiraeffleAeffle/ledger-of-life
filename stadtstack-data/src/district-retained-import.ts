import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {dataReleaseId,dataReleaseSchema,releasePathSchema,type DataRelease} from './data-release.ts';
import {sha256,hashSchema} from './district-schema.ts';
import {publicUrl} from './polite-fetch.ts';
import {readPinnedJson,sourceArtifactUrls,writeManagedSourceArtifact} from './district-private-io.ts';
import {assertCivicPolicyAuthority,assertHostNotOptedOut,assertManagedSourceReadable,CIVIC_ACQUISITION_DECISION_ID,type CivicPolicyOptions,type ManagedSourceBinding,type RetainedPublicationBinding} from './civic-opt-out.ts';

export const RETAINED_PUBLICATION_ROOT=fileURLToPath(new URL('../cache/publication/owner-policy-2026-10-11',import.meta.url));
const frozenOutput=fileURLToPath(new URL('../out',import.meta.url));
const MAX_MEMBER_BYTES=512*1024*1024;
const destinationPathSchema=z.string().min(1).max(2048).refine(value=>!isAbsolute(value)&&!value.includes('\\')&&value.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(part))&&/\.(?:json|geojson)$/.test(value),'Explicit contained JSON destination required');
const sourceUrlSchema=z.string().min(1).max(8192).refine(value=>{try{publicUrl(value);return /^https?:\/\/\S+$/i.test(value);}catch{return false;}},'Public source URL required');
export const RetainedPublicationSourceSchema=z.object({url:sourceUrlSchema,sourceSha256:hashSchema.nullable()}).strict();
export type RetainedPublicationSource=z.infer<typeof RetainedPublicationSourceSchema>;
export const RetainedPublicationMemberSchema=z.object({
 publicationRoot:z.string().min(1),manifestSha256:hashSchema,releaseId:hashSchema,memberPath:releasePathSchema,
 declaredSources:z.array(RetainedPublicationSourceSchema).max(100_000),
}).strict();
export type RetainedPublicationMember=z.infer<typeof RetainedPublicationMemberSchema>;
export const RetainedPublicationImportSchema=RetainedPublicationMemberSchema.extend({managedRoot:z.string().min(1),destinationPath:destinationPathSchema}).strict();
export type RetainedPublicationImport=z.infer<typeof RetainedPublicationImportSchema>;
export const RetainedPublicationImportPlanSchema=z.object({
 schemaVersion:z.literal('stadtstack-retained-import-plan-v1'),managedRoot:z.string().min(1),
 imports:z.array(RetainedPublicationMemberSchema.extend({destinationPath:destinationPathSchema}).strict()).min(1).max(10_000),
}).strict();
export type RetainedPublicationImportPlan=z.infer<typeof RetainedPublicationImportPlanSchema>;
export type RetainedPublicationSourceBinding=Extract<ManagedSourceBinding,{kind:'retained_publication'}>&{independentAllowed:false};
export interface AuthenticatedRetainedPublicationMember {
 publication:RetainedPublicationBinding;bytes:Buffer;bindings:RetainedPublicationSourceBinding[];
}
export interface RetainedPublicationImportReceipt {
 schemaVersion:'stadtstack-retained-publication-import-v1';path:string;sha256:string;bytes:number;
 publication:RetainedPublicationBinding;bindings:RetainedPublicationSourceBinding[];
}

function contained(root:string,path:string){const part=relative(root,path);return part===''||!isAbsolute(part)&&part!=='..'&&!part.startsWith('../');}
function json(bytes:Uint8Array):unknown {
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('Retained publication JSON invalid');}
}
async function assertDeclaredSources(sources:RetainedPublicationSource[],policy:CivicPolicyOptions){
 await assertCivicPolicyAuthority(policy);
 const tuples=new Set<string>();
 for(const source of sources){const key=JSON.stringify([source.url,source.sourceSha256]);if(tuples.has(key))throw Error('Duplicate retained source declaration');tuples.add(key);await assertHostNotOptedOut(source.url,policy);}
}
async function readPublicationBytes(root:string,path:string,maxBytes:number):Promise<Buffer>{
 const canonicalRoot=await realpath(root),rootStat=await lstat(root);
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw Error('Retained publication root must be a real directory');
 const filename=join(canonicalRoot,path);
 if(!contained(canonicalRoot,filename))throw Error('Retained publication member escapes its root');
 let directory=canonicalRoot;
 for(const part of path.split('/').slice(0,-1)){directory=join(directory,part);const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Retained publication directory alias rejected');}
 const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat({bigint:true});if(!before.isFile()||before.size>BigInt(maxBytes))throw Error('Retained publication input size/type rejected');
  const bytes=await handle.readFile(),after=await handle.stat({bigint:true});
  if(bytes.length>maxBytes||BigInt(bytes.length)!==before.size||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error('Retained publication changed while reading');
  return bytes;
 }finally{await handle.close();}
}

/** Original publication assertions only: absent hashes stay null, never the member/manifest digest. */
export function retainedPublicationSources(value:unknown):RetainedPublicationSource[]{
 let urls:Set<string>;
 try{urls=new Set(sourceArtifactUrls(value));}catch{throw Error('Retained publication provenance inventory invalid');}
 const tuples=new Map<string,RetainedPublicationSource>(),pending:Array<{value:unknown;depth:number;sourceSha256?:unknown}>=[{value,depth:0}];let count=0;
 const add=(url:string,sourceSha256:unknown=null)=>{
  const source=RetainedPublicationSourceSchema.safeParse({url,sourceSha256:sourceSha256===undefined?null:sourceSha256});
  if(!source.success)throw Error('Retained publication source provenance invalid');
  tuples.set(JSON.stringify([source.data.url,source.data.sourceSha256]),source.data);
 };
 while(pending.length){
  const node=pending.pop()!;
  if(++count>1_000_000||node.depth>40)throw Error('Retained publication provenance inventory exceeds bounds');
  if(typeof node.value==='string'){
   if(urls.has(node.value))add(node.value,node.sourceSha256);
   else for(const match of node.value.matchAll(/https?:\/\/[^\s<>"'\\]+/giu))add(match[0]);
   // Canonical council IDs can embed a percent-encoded source URL.
   if(/https?%3a%2f%2f/i.test(node.value)){
    let decoded:string;try{decoded=decodeURIComponent(node.value);}catch{throw Error('Retained publication encoded provenance invalid');}
    for(const match of decoded.matchAll(/https?:\/\/[^\s<>"'\\]+/giu))add(match[0]);
   }
  }
  else if(Array.isArray(node.value)){for(const item of node.value)pending.push({value:item,depth:node.depth+1});}
  else if(node.value&&typeof node.value==='object'){
   const object=node.value as Record<string,unknown>,embedded=typeof object.bytes==='string'&&typeof object.sha256==='string';
   if(embedded){let decoded:unknown;try{decoded=JSON.parse(object.bytes as string);}catch{throw Error('Retained publication embedded JSON invalid');}pending.push({value:decoded,depth:node.depth+1});}
   for(const [key,item] of Object.entries(object)){
    if(/https?(?::\/\/|%3a%2f%2f)/i.test(key))pending.push({value:key,depth:node.depth+1});
    if(key==='bytes'&&embedded)continue;
    const paired=(key==='url'||key==='snapshotUrl'||key==='sourceUrl')&&(Object.hasOwn(object,'sourceSha256')||key!=='sourceUrl'&&Object.hasOwn(object,'sha256'));
    pending.push({value:item,depth:node.depth+1,...(paired?{sourceSha256:Object.hasOwn(object,'sourceSha256')?object.sourceSha256:object.sha256}:{})});
   }
  }
 }
 return [...tuples].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,source])=>source);
}

/** Authenticate historical members without applying today's required-member list to an older release. */
export async function readAuthenticatedRetainedPublicationMember(raw:RetainedPublicationMember,policy:CivicPolicyOptions):Promise<AuthenticatedRetainedPublicationMember>{
 const input=RetainedPublicationMemberSchema.parse(raw);
 await assertDeclaredSources(input.declaredSources,policy);
 const manifestBytes=await readPublicationBytes(input.publicationRoot,'release-manifest.json',8*1024*1024);
 if(sha256(manifestBytes)!==input.manifestSha256)throw Error('Retained publication manifest byte pin mismatch');
 const parsed=dataReleaseSchema.safeParse(json(manifestBytes));if(!parsed.success)throw Error('Retained publication manifest invalid');
 const manifest:DataRelease=parsed.data;
 if(new Set(manifest.files.map(file=>file.path)).size!==manifest.files.length)throw Error('Retained publication has duplicate members');
 if(manifest.id!==input.releaseId||dataReleaseId(manifest.files)!==manifest.id)throw Error('Retained publication release identity mismatch');
 const member=manifest.files.find(file=>file.path===input.memberPath);if(!member)throw Error('Retained publication member is not manifest-bound');
 await assertDeclaredSources(input.declaredSources,policy);
 const bytes=await readPublicationBytes(input.publicationRoot,input.memberPath,MAX_MEMBER_BYTES);
 if(bytes.length!==member.bytes||sha256(bytes)!==member.sha256)throw Error('Retained publication member byte pin mismatch');
 const sources=retainedPublicationSources(json(bytes)),declared=new Set(input.declaredSources.map(source=>JSON.stringify([source.url,source.sourceSha256])));
 if(sources.length!==declared.size||sources.some(source=>!declared.has(JSON.stringify([source.url,source.sourceSha256]))))throw Error('Retained publication contains undeclared or mismatched source provenance');
 await assertDeclaredSources(sources,policy);
 const publication:RetainedPublicationBinding={manifestSha256:input.manifestSha256,releaseId:manifest.id,memberPath:member.path,memberSha256:member.sha256,memberBytes:member.bytes};
 return {publication,bytes,bindings:sources.map(source=>({kind:'retained_publication',...source,publication,independentAllowed:false}))};
}

async function destinationRoot(input:RetainedPublicationImport):Promise<string>{
 const root=resolve(input.managedRoot),publicationRoot=await realpath(input.publicationRoot);
 if(contained(publicationRoot,root)||contained(root,publicationRoot)||contained(frozenOutput,root)||contained(root,frozenOutput))throw Error('Retained publication destination must not overlap retained or frozen output');
 // Existing ancestors must not redirect a new managed root into a retained tree.
 let ancestor=root;
 for(;;){
  try{const stat=await lstat(ancestor);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Retained publication destination alias rejected');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=dirname(ancestor);if(parent===ancestor)break;ancestor=parent;
 }
 return root;
}

/** Explicit managed copy only; never source acquisition, claim admission, or an HTTP observation. */
export async function importRetainedPublicationMember(raw:RetainedPublicationImport,policy:CivicPolicyOptions):Promise<RetainedPublicationImportReceipt>{
 const input=RetainedPublicationImportSchema.parse(raw);
 await assertDeclaredSources(input.declaredSources,policy);
 const root=await destinationRoot(input),path=join(root,input.destinationPath);
 const {managedRoot:_managed,destinationPath:_destination,...member}=input;
 const authenticated=await readAuthenticatedRetainedPublicationMember(member,policy);
 if(!authenticated.bindings.length)throw Error('Retained source member has no source provenance to enroll');
 const digest=await writeManagedSourceArtifact(root,path,authenticated.bytes,authenticated.bindings,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 await assertManagedSourceReadable(path,policy);
 return {schemaVersion:'stadtstack-retained-publication-import-v1',path,sha256:digest,bytes:authenticated.bytes.length,publication:authenticated.publication,bindings:authenticated.bindings};
}

export async function runRetainedPublicationImportPlan(raw:RetainedPublicationImportPlan,policy:CivicPolicyOptions):Promise<RetainedPublicationImportReceipt[]>{
 const plan=RetainedPublicationImportPlanSchema.parse(raw),destinations=new Set<string>();
 await assertCivicPolicyAuthority(policy);
 for(const item of plan.imports){
  if(destinations.has(item.destinationPath))throw Error('Duplicate retained import destination');destinations.add(item.destinationPath);
  await assertDeclaredSources(item.declaredSources,policy);
  await destinationRoot({...item,managedRoot:plan.managedRoot});
 }
 const receipts:RetainedPublicationImportReceipt[]=[];
 for(const item of plan.imports)receipts.push(await importRetainedPublicationMember({...item,managedRoot:plan.managedRoot},policy));
 return receipts;
}

export async function readRetainedPublicationImportPlan(path:string,expectedSha256:string,policy:CivicPolicyOptions):Promise<RetainedPublicationImportPlan>{
 await assertCivicPolicyAuthority(policy);
 return RetainedPublicationImportPlanSchema.parse(await readPinnedJson(path,expectedSha256,8*1024*1024));
}
