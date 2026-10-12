import {constants} from 'node:fs';
import {open,lstat,realpath,readlink} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,join,sep} from 'node:path';
import {MAX_REVOCATION_BYTES,RevocationTrustSchema,verifyRevocations,type RevocationTrust,type VerifiedRevocations} from './civic-revocations.ts';

const MAX_TRUST_BYTES=64*1024;
/** Reviewed 0.3.2 Mac/VM public signer cohort from reports/handoff-release-0.3.2.json. */
export const GOVERNED_REVOCATION_SIGNER_PINS:Readonly<RevocationTrust['keys']>=Object.freeze([
 Object.freeze({keyId:'ed25519:9a687b0082820b1df5743cd2faa1150bd38171fab50d8248d6cad28aca59ab1e',publicKeySpki:'MCowBQYDK2VwAyEA7pH0triIjJrhZWSYqriNuor/5UYHQZnvZK9lSjvuAPA='}),
 Object.freeze({keyId:'ed25519:8393ad2b0087229073c57103c2e47a1b6f6e987c781b00bcbbaae060aa5ceebd',publicKeySpki:'MCowBQYDK2VwAyEAkod48Z56zro687MC/XdBpzQX3N+YtSMb9U5c0ZIkVeA='}),
]);
function requireSignerPins(trust:RevocationTrust,pins:Readonly<RevocationTrust['keys']>):void{
 if(trust.keys.length!==pins.length||!pins.every(pin=>trust.keys.some(key=>key.keyId===pin.keyId&&key.publicKeySpki===pin.publicKeySpki)))throw new GovernedRevocationConfigError();
}
/** Public independent pin-set check; signature and artifact checks still remain mandatory. */
export function requireGovernedRevocationSignerPins(trustInput:unknown):RevocationTrust{
 const trust=RevocationTrustSchema.parse(trustInput);requireSignerPins(trust,GOVERNED_REVOCATION_SIGNER_PINS);return trust;
}
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
 let current:string=sep;
 for(const component of cohort.split(sep).filter(Boolean)){
  current=join(current,component);const metadata=await lstat(current);
  const stickyAncestor=(metadata.mode&0o1000)!==0&&current!==root&&!inside(root,current);
  const unsafeWrite=(metadata.mode&0o022)!==0&&!stickyAncestor&&!(current===root&&(metadata.mode&0o1000)!==0);
  if(!metadata.isDirectory()||metadata.isSymbolicLink()||metadata.uid!==0&&metadata.uid!==uid||unsafeWrite)throw new GovernedRevocationConfigError();
 }
}
async function governedConfigFile(root:string,name:string):Promise<string>{
 const uid=process.getuid?.();if(uid===undefined)throw new GovernedRevocationConfigError();
 const initial=relative(root,name);if(!inside(root,name))throw new GovernedRevocationConfigError();
 let pending=initial.split(sep).filter(Boolean),current=root,hops=0;
 while(pending.length){
  const component=pending.shift()!;
  if(component==='.'||component==='')continue;
  if(component==='..'){
   current=dirname(current);if(current!==root&&!inside(root,current))throw new GovernedRevocationConfigError();
   continue;
  }
  const candidate=join(current,component),metadata=await lstat(candidate);
  if(metadata.uid!==0&&metadata.uid!==uid)throw new GovernedRevocationConfigError();
  if(metadata.isSymbolicLink()){
   if(++hops>4)throw new GovernedRevocationConfigError();
   const target=await readlink(candidate);if(isAbsolute(target))throw new GovernedRevocationConfigError();
   pending=[...target.split(sep).filter(Boolean),...pending];current=dirname(candidate);
  }else{
   if(pending.length&&!metadata.isDirectory())throw new GovernedRevocationConfigError();
   if(!pending.length&&!metadata.isFile())throw new GovernedRevocationConfigError();
   current=candidate;
  }
 }
 if(!inside(root,current))throw new GovernedRevocationConfigError();
 return current;
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
 return loadRevocationCohort(expectedReleaseId,env,GOVERNED_REVOCATION_SIGNER_PINS);
}
/** Explicit synthetic-cohort injection for tests only; hosted startup never calls this path or selects pins from env. */
export async function loadGovernedRevocationsForTesting(expectedReleaseId:string,env:NodeJS.ProcessEnv,pins:Readonly<RevocationTrust['keys']>):Promise<VerifiedRevocations>{
 return loadRevocationCohort(expectedReleaseId,env,pins);
}
async function loadRevocationCohort(expectedReleaseId:string,env:NodeJS.ProcessEnv,pins:Readonly<RevocationTrust['keys']>):Promise<VerifiedRevocations>{
 try{
  const trustPath=configuredPath(env.STADTSTACK_MCP_REVOCATION_TRUST_FILE),artifactPath=configuredPath(env.STADTSTACK_MCP_REVOCATIONS_FILE);
  if(trustPath===artifactPath||dirname(trustPath)!==dirname(artifactPath))throw new GovernedRevocationConfigError();
  const root=await realpath(dirname(trustPath));
  await governedDirectoryChain(root,root);
  const [trustReal,artifactReal]=await Promise.all([governedConfigFile(root,join(root,relative(dirname(trustPath),trustPath))),governedConfigFile(root,join(root,relative(dirname(trustPath),artifactPath)))]);
  if(dirname(trustReal)!==dirname(artifactReal))throw new GovernedRevocationConfigError();
  await governedDirectoryChain(root,dirname(trustReal));
  const [trustBytes,artifactBytes]=await Promise.all([boundedConfigFile(trustReal,MAX_TRUST_BYTES),boundedConfigFile(artifactReal,MAX_REVOCATION_BYTES)]);
  if(await realpath(trustPath)!==trustReal||await realpath(artifactPath)!==artifactReal)throw new GovernedRevocationConfigError();
  const trust=RevocationTrustSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(trustBytes)));
  requireSignerPins(trust,pins);
  return verifyRevocations(artifactBytes,trust,expectedReleaseId);
 }catch{throw new GovernedRevocationConfigError();}
}
