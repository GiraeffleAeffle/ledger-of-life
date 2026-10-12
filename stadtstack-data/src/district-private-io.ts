import {readFile,writeFile,mkdir,rename,lstat,open,unlink} from 'node:fs/promises';
import {dirname,resolve,relative,isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,hashSchema} from './district-schema.ts';
import {assertCivicPolicyAuthority,assertSourceHostsNotOptedOut,initializeManagedAcquisitionLane,withManagedSourceScratch,withManagedSourceWrite,type ManagedAcquisitionLaneOptions,type ManagedSourceBinding,type ManagedSourceContent} from './civic-opt-out.ts';

export type SourceArtifactBinding=ManagedSourceBinding&Pick<ManagedSourceContent,'independentAllowed'>;
/** Every temporary and final source-bearing copy is enrolled before bytes are created. */
export async function writeManagedSourceArtifact(root:string,path:string,bytes:string|Uint8Array,bindings:SourceArtifactBinding[],options:ManagedAcquisitionLaneOptions):Promise<string>{
 const directory=resolve(root),target=resolve(path),relativePath=relative(directory,target);
 if(!relativePath||relativePath.startsWith('..')||isAbsolute(relativePath)||!bindings.length)throw Error('Source artifact needs a contained destination and complete source bindings');
 await assertCivicPolicyAuthority(options);
 await assertSourceHostsNotOptedOut(bindings.map(binding=>binding.url),options);
 await initializeManagedAcquisitionLane(directory,{...options,kind:'artifacts'});
 const contentSha256=sha256(bytes),entries=bindings.map(binding=>({...binding,relativePath,contentSha256}));
 const scratchBindings=bindings.map(({independentAllowed:_independent,...binding})=>binding);
 await withManagedSourceScratch(directory,scratchBindings,async scope=>{
  await scope.assertActive();
  const temporary=join(scope.directory,'artifact');
  await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});
  await withManagedSourceWrite(directory,entries,async()=>{
   await mkdir(dirname(target),{recursive:true,mode:0o700});await rename(temporary,target);
  },options);
 },{...options,kind:'artifacts',purpose:'artifact'});
 return contentSha256;
}
export async function writeManagedSourceJson(root:string,path:string,value:unknown,bindings:SourceArtifactBinding[],options:ManagedAcquisitionLaneOptions):Promise<string>{
 return writeManagedSourceArtifact(root,path,JSON.stringify(value,null,2)+'\n',bindings,options);
}

/** Full URL inventory, including hash-bound JSON blobs used by frozen replay archives. */
export function sourceArtifactUrls(input:unknown):string[]{
 const urls=new Set<string>(),pending:Array<{value:unknown;depth:number}>=[{value:input,depth:0}];let count=0;
 while(pending.length){
  const {value,depth}=pending.pop()!;
  if(++count>1_000_000||depth>40)throw Error('Source artifact inventory exceeds bounds');
  if(typeof value==='string'){
   if(/^https?:\/\/\S+$/i.test(value)){const url=new URL(value);if(url.username||url.password)throw Error('Source artifact contains credential-bearing provenance');urls.add(value);}
  }else if(Array.isArray(value)){
   for(const item of value)pending.push({value:item,depth:depth+1});
  }else if(value&&typeof value==='object'){
   const object=value as Record<string,unknown>,embedded=typeof object.bytes==='string'&&typeof object.sha256==='string';
   if(embedded){
    if(sha256(object.bytes as string)!==hashSchema.parse(object.sha256))throw Error('Source artifact embedded blob hash mismatch');
    pending.push({value:JSON.parse(object.bytes as string),depth:depth+1});
   }
   for(const [key,item] of Object.entries(object))if(key!=='bytes'||!embedded)pending.push({value:item,depth:depth+1});
  }
 }
 return [...urls].sort();
}

export async function writePrivateJson(path:string,value:unknown):Promise<string>{
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const bytes=JSON.stringify(value,null,2)+'\n',temporary=path+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});
 await rename(temporary,path);
 return sha256(bytes);
}
export async function readPinnedJson(path:string,expectedSha256:string,maxBytes=32*1024*1024):Promise<unknown>{
 hashSchema.parse(expectedSha256);
 const metadata=await lstat(path);if(!metadata.isFile()||metadata.size>maxBytes)throw Error('Private artifact size/type rejected');
 const bytes=await readFile(path);if(bytes.length>maxBytes||sha256(bytes)!==expectedSha256)throw Error('Private artifact byte binding mismatch');
 return JSON.parse(bytes.toString('utf8'));
}
export async function acquirePrivateRunLock(path:string,purpose:string):Promise<()=>Promise<void>>{
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const nonce=randomUUID(),handle=await open(path,'wx',0o600);
 await handle.writeFile(JSON.stringify({pid:process.pid,nonce,purpose,startedAt:new Date().toISOString()})+'\n');await handle.close();
 return async()=>{const owner=JSON.parse(await readFile(path,'utf8'));if(owner.pid!==process.pid||owner.nonce!==nonce)throw Error('Private run lock owner changed');await unlink(path);};
}
