import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,join,sep} from 'node:path';
import {MAX_REVOCATION_BYTES,verifyRevocations,type VerifiedRevocations} from './civic-revocations.ts';

const MAX_TRUST_BYTES=64*1024;
export class GovernedRevocationConfigError extends Error {
 constructor(){super('Governed revocation configuration is missing, unsafe or invalid');this.name='GovernedRevocationConfigError';}
}
function configuredPath(value:string|undefined):string {
 if(!value||value!==value.trim()||value.includes('\0')||!isAbsolute(value))throw new GovernedRevocationConfigError();
 return resolve(value);
}
function inside(root:string,path:string):boolean {
 const child=relative(root,path);return child!==''&&!isAbsolute(child)&&child!=='..'&&!child.startsWith('..'+sep);
}
async function governedDirectoryChain(root:string,cohort:string):Promise<void>{
 const uid=process.getuid?.();if(uid===undefined)throw new GovernedRevocationConfigError();
 let current=sep;
 for(const component of cohort.split(sep).filter(Boolean)){
  current=join(current,component);const metadata=await lstat(current);
  const stickyAncestor=(metadata.mode&0o1000)!==0&&current!==root&&!inside(root,current);
  if(!metadata.isDirectory()||metadata.isSymbolicLink()||metadata.uid!==0&&metadata.uid!==uid||(metadata.mode&0o022)!==0&&!stickyAncestor)throw new GovernedRevocationConfigError();
 }
}
async function boundedConfigFile(path:string,maxBytes:number):Promise<Uint8Array>{
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const initial=await file.stat(),uid=process.getuid?.();
  if(!initial.isFile()||initial.size<=0||initial.size>maxBytes||(initial.mode&0o022)!==0||uid===undefined||initial.uid!==0&&initial.uid!==uid)throw new GovernedRevocationConfigError();
  const bytes=Buffer.alloc(initial.size+1);let length=0;
  while(length<bytes.length){const read=await file.read(bytes,length,bytes.length-length,null);if(read.bytesRead===0)break;length+=read.bytesRead;}
  const final=await file.stat(),named=await lstat(path);
  if(length!==initial.size||final.size!==initial.size||final.mtimeMs!==initial.mtimeMs||final.ctimeMs!==initial.ctimeMs||!named.isFile()||named.isSymbolicLink()||named.dev!==initial.dev||named.ino!==initial.ino)throw new GovernedRevocationConfigError();
  return bytes.subarray(0,length);
 }finally{await file.close();}
}
/** Startup only. A governed Recreate rollout replaces this immutable in-memory cohort. */
export async function loadGovernedRevocations(expectedReleaseId:string,env:NodeJS.ProcessEnv=process.env):Promise<VerifiedRevocations>{
 try{
  const trustPath=configuredPath(env.STADTSTACK_MCP_REVOCATION_TRUST_FILE),artifactPath=configuredPath(env.STADTSTACK_MCP_REVOCATIONS_FILE);
  if(trustPath===artifactPath||dirname(trustPath)!==dirname(artifactPath))throw new GovernedRevocationConfigError();
  const root=await realpath(dirname(trustPath)),trustReal=await realpath(trustPath),artifactReal=await realpath(artifactPath);
  // Kubernetes projected config files may be symlinks into one immutable revision.
  if(!inside(root,trustReal)||!inside(root,artifactReal)||dirname(trustReal)!==dirname(artifactReal))throw new GovernedRevocationConfigError();
  await governedDirectoryChain(root,dirname(trustReal));
  const [trustBytes,artifactBytes]=await Promise.all([boundedConfigFile(trustReal,MAX_TRUST_BYTES),boundedConfigFile(artifactReal,MAX_REVOCATION_BYTES)]);
  if(await realpath(trustPath)!==trustReal||await realpath(artifactPath)!==artifactReal)throw new GovernedRevocationConfigError();
  const trust=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(trustBytes));
  return verifyRevocations(artifactBytes,trust,expectedReleaseId);
 }catch{throw new GovernedRevocationConfigError();}
}
