import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {chmod,mkdir,readFile,open,realpath,lstat,writeFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {districtRegistrySchema} from './district-registry.ts';
import type {DistrictRegistry} from './district-registry.ts';
import {GitSnapshotSchema,authenticateGitObjectProof} from './district-git-snapshot-import.ts';
import {RetainedPublicationSourceSchema,retainedPublicationSources} from './district-retained-import.ts';
import {sha256,hashSchema} from './district-schema.ts';
import {textLineageRecordSha256} from './text-run-lineage.ts';
import {assertCivicPolicyAuthority,assertHostNotOptedOut,assertManagedSourceReadable,assertManagedSourceBindings,CIVIC_ACQUISITION_DECISION_ID} from './civic-opt-out.ts';
import type {CivicPolicyOptions} from './civic-opt-out.ts';
import {writeManagedSourceArtifact,readPinnedJson} from './district-private-io.ts';

const pinSchema=z.object({path:z.string().min(1),sha256:hashSchema,bytes:z.number().int().nonnegative().max(8*1024*1024)}).strict();
const objectPinSchema=pinSchema.extend({oid:z.string().regex(/^[a-f0-9]{40}$/)}).strict();
const codeSchema=GitSnapshotSchema.extend({path:z.literal('stadtstack-data/sources/district-registry.json')});
export const operatorRegistryApprovalSchema=z.object({role:z.literal('district_source_registry'),approver:z.literal('owner'),decisionId:z.literal(CIVIC_ACQUISITION_DECISION_ID),date:z.literal('2026-10-11'),configurationSha256:hashSchema,gitCommit:z.string().regex(/^[a-f0-9]{40}$/)}).strict();
export const operatorRegistryConfigBindingSchema=z.object({kind:z.literal('operator_registry_config'),url:RetainedPublicationSourceSchema.shape.url,configurationSha256:hashSchema,schemaContractSha256:hashSchema,code:codeSchema,approval:operatorRegistryApprovalSchema,independentAllowed:z.literal(false)}).strict().superRefine((binding,ctx)=>{
 if(binding.configurationSha256!==binding.code.sha256||binding.approval.configurationSha256!==binding.configurationSha256||binding.approval.gitCommit!==binding.code.gitCommit)ctx.addIssue({code:'custom',message:'Operator configuration code/approval mismatch'});
});
export type OperatorRegistryConfigBinding=z.infer<typeof operatorRegistryConfigBindingSchema>;
export const operatorRegistryConfigSchema=pinSchema.extend({kind:z.literal('operator_registry_config'),schemaContractSha256:hashSchema,code:codeSchema,approval:operatorRegistryApprovalSchema,commit:objectPinSchema,trees:z.array(objectPinSchema).min(1).max(128),declaredEndpoints:z.array(RetainedPublicationSourceSchema.shape.url).min(1).max(100_000)}).strict().superRefine((input,ctx)=>{
 if(input.sha256!==input.code.sha256||input.bytes!==input.code.bytes||input.commit.oid!==input.code.gitCommit||input.approval.configurationSha256!==input.sha256||input.approval.gitCommit!==input.code.gitCommit)ctx.addIssue({code:'custom',message:'Operator configuration Git/approval byte binding mismatch'});
});
export type OperatorRegistryConfig=z.infer<typeof operatorRegistryConfigSchema>;
const destinationSchema=z.string().min(1).max(2048).refine(path=>!isAbsolute(path)&&!path.includes('\\')&&path.split('/').every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(part))&&path.endsWith('.json'));
export const operatorRegistryConfigImportSchema=operatorRegistryConfigSchema.safeExtend({managedRoot:z.string().min(1),destinationPath:destinationSchema});
export type OperatorRegistryConfigImport=z.infer<typeof operatorRegistryConfigImportSchema>;
export const operatorRegistryConfigSourcePinSchema=pinSchema.extend({bindings:z.array(operatorRegistryConfigBindingSchema).min(1)}).strict().superRefine((pin,ctx)=>{
 if(pin.bindings.some(binding=>binding.configurationSha256!==pin.sha256||binding.code.bytes!==pin.bytes))ctx.addIssue({code:'custom',message:'Operator registry source pin does not contain the approved exact configuration'});
});
export type OperatorRegistryConfigSourcePin=z.infer<typeof operatorRegistryConfigSourcePinSchema>;
const execFileAsync=promisify(execFile);
const OPERATOR_REGISTRY_CODE_PATH='stadtstack-data/sources/district-registry.json';
/** Build immutable Git-backed operator evidence from a committed registry, never from the checkout. */
export async function buildOperatorRegistryConfigDescriptor(input:{repository:string;commit:string;outputDirectory:string}){
 const {repository,commit:requestedCommit,outputDirectory}=input;
 const env:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
 const git=async(args:string[])=>{const result=await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null','-c','commit.gpgSign=false',...args],{cwd:repository,env,encoding:'buffer',maxBuffer:16*1024*1024});return result.stdout as Buffer;};
 const gitCommit=(await git(['rev-parse','--verify',`${requestedCommit}^{commit}`])).toString('ascii').trim();
 if(!/^[a-f0-9]{40}$/.test(gitCommit))throw Error('Registry commit must resolve to a full SHA-1 commit');
 const body=await git(['cat-file','blob',`${gitCommit}:${OPERATOR_REGISTRY_CODE_PATH}`]);
 const blobOid=(await git(['rev-parse',`${gitCommit}:${OPERATOR_REGISTRY_CODE_PATH}`])).toString('ascii').trim();
 if(!/^[a-f0-9]{40}$/.test(blobOid))throw Error('Registry blob must use a full SHA-1 object ID');
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw Error('Operator registry configuration JSON invalid');}
 const registry=parseOperatorRegistryConfiguration(value),root=resolve(outputDirectory);
 await mkdir(root,{recursive:true,mode:0o700});
 await chmod(root,0o700);
 const writePinned=async(name:string,bytes:Buffer,oid?:string)=>{
  if(oid){const type=name.startsWith('commit-')?'commit':'tree',actual=createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');if(actual!==oid)throw Error(`Git ${type} bytes do not authenticate their OID`);}
  const path=join(root,name);await writeFile(path,bytes,{mode:0o600,flag:'wx'});
  return {path,sha256:sha256(bytes),bytes:bytes.length,...(oid?{oid}:{})};
 };
 const actualBlob=createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
 if(actualBlob!==blobOid)throw Error('Git blob bytes do not authenticate their OID');
 const code=await writePinned('district-registry.json',body);
 const commitBytes=await git(['cat-file','commit',gitCommit]),commitPin=await writePinned(`commit-${gitCommit}.bin`,commitBytes,gitCommit);
 const treePins=[];
 for(const revision of [`${gitCommit}:stadtstack-data/sources`,`${gitCommit}:stadtstack-data`,`${gitCommit}^{tree}`]){
  const oid=(await git(['rev-parse',revision])).toString('ascii').trim();if(!/^[a-f0-9]{40}$/.test(oid))throw Error('Registry tree must use a full SHA-1 object ID');
  const bytes=await git(['cat-file','tree',oid]);treePins.push(await writePinned(`tree-${oid}.bin`,bytes,oid));
 }
 const code=await writePinned('district-registry.json',body);
 const descriptor=operatorRegistryConfigSchema.parse({kind:'operator_registry_config',path:code.path,sha256:code.sha256,bytes:code.bytes,schemaContractSha256:await operatorRegistryConfigContractSha256(),code:{gitCommit,path:OPERATOR_REGISTRY_CODE_PATH,blobOid,sha256:code.sha256,bytes:code.bytes},commit:commitPin,trees:treePins,approval:{role:'district_source_registry',approver:'owner',decisionId:CIVIC_ACQUISITION_DECISION_ID,date:'2026-10-11',configurationSha256:code.sha256,gitCommit},declaredEndpoints:operatorRegistryEndpoints(registry)});
 const descriptorBytes=Buffer.from(JSON.stringify(descriptor)+'\n'),descriptorPath=join(root,'operator-registry-config.json');
 await writeFile(descriptorPath,descriptorBytes,{mode:0o600,flag:'wx'});
 return {descriptorPath,descriptorSha256:sha256(descriptorBytes),descriptor};
}

/** Bind the actual bounded codec, registry schema and URL/provenance validators, not an unversioned promise. */
export async function operatorRegistryConfigContractSha256(){
 const files=['district-registry-config.ts','district-registry.ts','district-schema.ts','district-git-snapshot-import.ts','district-retained-import.ts','district-private-io.ts','text-run-lineage.ts','source-policy.ts','document-origin-contract.ts','polite-fetch.ts','public-address.ts','civic-opt-out.ts'];
 return sha256(JSON.stringify(await Promise.all(files.map(async file=>sha256(await readFile(new URL(file,import.meta.url)))))));
}
/** Configuration metadata only. Unknown/model/body keys cannot be silently stripped into permission. */
export function parseOperatorRegistryConfiguration(value:unknown):DistrictRegistry{
 const pending:Array<{value:unknown;key:string;depth:number}>=[{value,key:'',depth:0}];let nodes=0;
 while(pending.length){
  const item=pending.pop()!;
  if(++nodes>200_000||item.depth>16)throw Error('Operator registry metadata exceeds structural bounds');
  if(typeof item.value==='string'){
   const limit=item.key==='locator'?600:/url$/i.test(item.key)?8192:1024;
   if(item.value.length>limit||/<(?:!doctype|!--|\/?[a-z][^>]*>)/i.test(item.value)||/\b(?:file|data|javascript):/i.test(item.value))throw Error('Operator registry contains unsafe or oversized metadata');
  }else if(Array.isArray(item.value)){
   if(item.value.length>10_000)throw Error('Operator registry metadata array exceeds bounds');
   for(const child of item.value)pending.push({value:child,key:item.key,depth:item.depth+1});
  }else if(item.value&&typeof item.value==='object'){
   const fields=Object.entries(item.value);if(fields.length>64)throw Error('Operator registry metadata object exceeds bounds');
   for(const [key,child] of fields){
    if(/^(?:body|rawbody|text|sourcetext|sourcebody|model|modelresponse|prompt|messages|record|records|candidate|candidates|summary|quote|quotes|response|request|html|xml|payload|bytes)$/i.test(key.replace(/[^a-z]/gi,'')))throw Error('Operator registry contains source-body/model fields');
    pending.push({value:child,key,depth:item.depth+1});
   }
  }
 }
 const registry=districtRegistrySchema.parse(value);
 if(textLineageRecordSha256(registry)!==textLineageRecordSha256(value))throw Error('Operator registry contains unknown or source-body/model fields');
 retainedPublicationSources(registry); // Reject unsafe or malformed URLs even in metadata notes/locators.
 return registry;
}
export function operatorRegistryEndpoints(registry:DistrictRegistry){return [...new Set(retainedPublicationSources(registry).map(source=>source.url))].sort();}
async function endpointsActive(endpoints:string[],policy:CivicPolicyOptions){
 await assertCivicPolicyAuthority(policy);
 if(new Set(endpoints).size!==endpoints.length)throw Error('Duplicate declared registry endpoint');
 for(const url of endpoints)await assertHostNotOptedOut(url,policy);
}
async function pinnedBytes(pin:z.infer<typeof pinSchema>):Promise<Buffer>{
 const path=resolve(pin.path);if(await realpath(path)!==path)throw Error('Operator registry input alias rejected');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await file.stat({bigint:true});if(!before.isFile()||before.size!==BigInt(pin.bytes))throw Error('Operator registry input type/length mismatch');
  const bytes=await file.readFile(),after=await file.stat({bigint:true});
  if(bytes.length!==pin.bytes||sha256(bytes)!==pin.sha256||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw Error('Operator registry input byte pin mismatch');
  return bytes;
 }finally{await file.close();}
}
export async function readOperatorRegistryConfig(raw:OperatorRegistryConfig,policy:CivicPolicyOptions){
 const input=operatorRegistryConfigSchema.parse(raw);
 await endpointsActive(input.declaredEndpoints,policy);
 if(input.schemaContractSha256!==await operatorRegistryConfigContractSha256())throw Error('Operator registry codec contract mismatch');
 const commit=await pinnedBytes(input.commit),trees=new Map<string,Buffer>();
 for(const tree of input.trees){if(trees.has(tree.oid))throw Error('Duplicate registry Git tree proof');trees.set(tree.oid,await pinnedBytes(tree));}
 const bytes=await pinnedBytes(input);
 authenticateGitObjectProof(input.code,commit,trees,bytes);
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('Operator registry configuration JSON invalid');}
 const registry=parseOperatorRegistryConfiguration(value),endpoints=operatorRegistryEndpoints(registry);
 if(JSON.stringify([...input.declaredEndpoints].sort())!==JSON.stringify(endpoints))throw Error('Operator registry endpoint declarations are incomplete or extra');
 await endpointsActive(endpoints,policy);
 const bindings:OperatorRegistryConfigBinding[]=endpoints.map(url=>({kind:'operator_registry_config',url,configurationSha256:input.sha256,schemaContractSha256:input.schemaContractSha256,code:input.code,approval:input.approval,independentAllowed:false}));
 return {bytes,registry,bindings};
}
function contained(root:string,path:string){const part=relative(resolve(root),resolve(path));return part===''||!isAbsolute(part)&&part!=='..'&&!part.startsWith('../');}
export async function importOperatorRegistryConfig(raw:OperatorRegistryConfigImport,policy:CivicPolicyOptions):Promise<OperatorRegistryConfigSourcePin>{
 const input=operatorRegistryConfigImportSchema.parse(raw),root=resolve(input.managedRoot),frozen=fileURLToPath(new URL('../out',import.meta.url));
 await endpointsActive(input.declaredEndpoints,policy);
 if(contained(root,frozen)||contained(frozen,root)||[input,input.commit,...input.trees].some(pin=>contained(root,pin.path)))throw Error('Operator registry destination overlaps original or frozen inputs');
 let ancestor=root;
 for(;;){try{const metadata=await lstat(ancestor);if(!metadata.isDirectory()||metadata.isSymbolicLink())throw Error('Operator registry destination alias rejected');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}const parent=dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
 const {managedRoot:_root,destinationPath:_destination,...descriptor}=input;
 const authenticated=await readOperatorRegistryConfig(descriptor,policy),path=join(root,input.destinationPath);
 const digest=await writeManagedSourceArtifact(root,path,authenticated.bytes,authenticated.bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
 const pin=operatorRegistryConfigSourcePinSchema.parse({path,sha256:digest,bytes:authenticated.bytes.length,bindings:authenticated.bindings});
 await assertManagedSourceBindings(path,pin.bindings,policy);return pin;
}
export async function readOperatorRegistryConfigSourcePin(raw:OperatorRegistryConfigSourcePin,policy:CivicPolicyOptions){
 const pin=operatorRegistryConfigSourcePinSchema.parse(raw);
 await endpointsActive(pin.bindings.map(binding=>binding.url),policy);await assertManagedSourceReadable(pin.path,policy);await assertManagedSourceBindings(pin.path,pin.bindings,policy);
 const contract=await operatorRegistryConfigContractSha256();if(pin.bindings.some(binding=>binding.schemaContractSha256!==contract))throw Error('Operator registry codec contract mismatch');
 const bytes=await pinnedBytes(pin),registry=parseOperatorRegistryConfiguration(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
 if(JSON.stringify(operatorRegistryEndpoints(registry))!==JSON.stringify(pin.bindings.map(binding=>binding.url).sort()))throw Error('Managed operator registry endpoint declarations differ');
 await assertManagedSourceBindings(pin.path,pin.bindings,policy);return {bytes,registry};
}

export const operatorRegistryInputPinSchema=z.object({path:z.string().min(1),sha256:hashSchema}).strict();
export type OperatorRegistryInputPin=z.infer<typeof operatorRegistryInputPinSchema>;
export interface AdmittedOperatorRegistryConfiguration {path:string;bytes:Buffer;registry:DistrictRegistry;bindings:OperatorRegistryConfigBinding[]}
/** A descriptor pin is control metadata, never a bare registry-data path. */
export async function readOperatorRegistryInputPin(input:OperatorRegistryInputPin,policy:CivicPolicyOptions):Promise<AdmittedOperatorRegistryConfiguration>{
 const pin=operatorRegistryInputPinSchema.parse(input);
 await assertCivicPolicyAuthority(policy);
 const descriptor=z.union([operatorRegistryConfigSchema,operatorRegistryConfigSourcePinSchema]).parse(await readPinnedJson(pin.path,pin.sha256,8*1024*1024));
 if('kind' in descriptor)return {path:descriptor.path,...await readOperatorRegistryConfig(descriptor,policy)};
 return {path:descriptor.path,...await readOperatorRegistryConfigSourcePin(descriptor,policy),bindings:descriptor.bindings};
}
