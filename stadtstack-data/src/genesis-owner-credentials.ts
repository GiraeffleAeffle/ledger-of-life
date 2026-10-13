import {constants} from 'node:fs';
import {open,lstat,realpath,type FileHandle} from 'node:fs/promises';
import {dirname,basename,resolve} from 'node:path';
import {isOwnerGenesisEndpoint} from './source-policy.ts';
import {nativePublicRequestHeaders,type NativePublicOperation} from './district-native-request.ts';

export const GENESIS_OWNER_CREDENTIAL_PATH='/home/max/.config/stadtstack/regionalstatistik/credentials.json';
export const GENESIS_CREDENTIAL_MAX_BYTES=16*1024;
/** Content-free failure; never attach filesystem/JSON errors or a cause. */
export class GenesisCredentialUnavailable extends Error {
 constructor(){super('credential_unavailable');this.name='GenesisCredentialUnavailable';}
}
/** Host memory only. No enumerable credential fields, serialization or logging API. */
export class GenesisOwnerCredentials {
 readonly kind:'token'|'password';
 #username:string;#password:string;#needles:Buffer[];
 constructor(kind:'token'|'password',username:string,password:string){
  this.kind=kind;this.#username=username;this.#password=password;
  this.#needles=[username,password].filter(Boolean).flatMap(secret=>[Buffer.from(secret),Buffer.from(secret,'latin1'),Buffer.from(JSON.stringify(secret).slice(1,-1)),Buffer.from(encodeURIComponent(secret)),Buffer.from(Buffer.from(secret).toString('base64'))]);
 }
 requestHeaders(url:URL,method:'GET'|'POST',body:string|undefined,operation?:NativePublicOperation):Record<string,string> {
  if(!this.#username||method!=='POST'||operation!=='genesis_guest'||!isOwnerGenesisEndpoint(url.href))throw new GenesisCredentialUnavailable();
  const headers=nativePublicRequestHeaders(url,method,body,operation);
  headers.username=this.#username;headers.password=this.#password;
  return headers;
 }
 /** Refuse echoes before any parser, policy evidence, redirect callback or persistence.
  * Also cover the common JSON, URL and base64 representations of an echoed value. */
 contains(value:string|Buffer):boolean {
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);
  for(const needle of this.#needles)if(bytes.includes(needle))return true;
  return false;
 }
 clear():void {this.#username='';this.#password='';for(const needle of this.#needles)needle.fill(0);this.#needles=[];}
}
/** The production caller always uses GENESIS_OWNER_CREDENTIAL_PATH. The explicit
 * path seam is for disposable file fixtures, never argv/env/request configuration. */
export async function readGenesisOwnerCredentials(path=GENESIS_OWNER_CREDENTIAL_PATH):Promise<GenesisOwnerCredentials> {
 let parent:FileHandle|undefined,file:FileHandle|undefined,bytes:Buffer|undefined;
 try{
  const uid=process.getuid?.();if(uid===undefined||resolve(path)!==path||basename(path)!=='credentials.json')throw new GenesisCredentialUnavailable();
  const parentPath=dirname(path),parentInfo=await lstat(parentPath);
  if(!parentInfo.isDirectory()||parentInfo.isSymbolicLink()||parentInfo.uid!==uid||(parentInfo.mode&0o7777)!==0o700||await realpath(parentPath)!==parentPath)throw new GenesisCredentialUnavailable();
  parent=await open(parentPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const openedParent=await parent.stat();
  if(openedParent.dev!==parentInfo.dev||openedParent.ino!==parentInfo.ino||openedParent.uid!==uid||(openedParent.mode&0o7777)!==0o700)throw new GenesisCredentialUnavailable();
  // Open through the pinned parent descriptor, not a raceable pathname. NONBLOCK
  // ensures an attacker-supplied FIFO cannot hang before the regular-file check.
  file=await open(`/proc/self/fd/${parent.fd}/credentials.json`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=await file.stat();
  if(!info.isFile()||info.uid!==uid||(info.mode&0o7777)!==0o600||info.size<1||info.size>GENESIS_CREDENTIAL_MAX_BYTES)throw new GenesisCredentialUnavailable();
  bytes=Buffer.alloc(GENESIS_CREDENTIAL_MAX_BYTES+1);
  let length=0;
  while(length<bytes.length){const read=await file.read(bytes,length,bytes.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
  const after=await file.stat(),afterParent=await lstat(parentPath);
  if(length!==info.size||length>GENESIS_CREDENTIAL_MAX_BYTES||after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs||after.uid!==uid||(after.mode&0o7777)!==0o600||afterParent.dev!==openedParent.dev||afterParent.ino!==openedParent.ino||afterParent.uid!==uid||(afterParent.mode&0o7777)!==0o700||afterParent.isSymbolicLink())throw new GenesisCredentialUnavailable();
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new GenesisCredentialUnavailable();
  const record=value as Record<string,unknown>,keys=Object.keys(record);
  const scalar=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=4096&&/^[\x20-\x7e\x80-\xff]+$/.test(v)&&v.trim()===v;
  if(keys.length===1&&keys[0]==='token'&&scalar(record.token)&&record.token!=='GAST')return new GenesisOwnerCredentials('token',record.token,'');
  if(keys.length===2&&keys.includes('username')&&keys.includes('password')&&scalar(record.username)&&scalar(record.password)&&record.username!=='GAST')return new GenesisOwnerCredentials('password',record.username,record.password);
  throw new GenesisCredentialUnavailable();
 }catch{throw new GenesisCredentialUnavailable();}
 finally{bytes?.fill(0);await file?.close().catch(()=>{});await parent?.close().catch(()=>{});}
}
