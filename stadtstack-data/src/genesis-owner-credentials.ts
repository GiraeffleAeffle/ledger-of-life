import {constants} from 'node:fs';
import {open,lstat,realpath,type FileHandle} from 'node:fs/promises';
import {dirname,basename,resolve} from 'node:path';
import {isOwnerGenesisEndpoint} from './source-policy.ts';
import {nativePublicRequestHeaders,type NativePublicOperation} from './district-native-request.ts';
import {readZip,readCsv} from './adapters/structured-tables.ts';

export const GENESIS_OWNER_CREDENTIAL_PATH='/home/max/.config/stadtstack/regionalstatistik/credentials.json';
export const GENESIS_CREDENTIAL_MAX_BYTES=16*1024;
export const GENESIS_RESPONSE_SCREEN_LIMITS=Object.freeze({inputBytes:4*1024*1024,totalBytes:16*1024*1024,memberBytes:4*1024*1024,members:64,ratio:200,headerBytes:8192,percentPasses:8,jsonStrings:200000});
/** Never attach remote text, archive names or a parser cause to this hold. */
export class GenesisResponseScreeningHold extends Error {
 constructor(){super('authenticated_response_screening_hold');this.name='GenesisResponseScreeningHold';}
}
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
 /** Raw memory-only check for outbound selectors and scalar echoes. Decoded
  * response screening below is mandatory before any response-derived effect. */
 contains(value:string|Buffer):boolean {
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);
  for(const needle of this.#needles)if(bytes.includes(needle))return true;
  if(typeof value==='string'&&/[\u0080-\u00ff]/.test(value)){
   // Node exposes HTTP header octets as Latin-1, even when a sender encoded a
   // value in UTF-8. Check that byte interpretation too, without logging it.
   const octets=Buffer.from(value,'latin1');
   for(const needle of this.#needles)if(octets.includes(needle))return true;
  }
  return false;
 }
 #screenScalar(value:string,percentDecode=false):void {
  if(this.contains(value))throw new GenesisResponseScreeningHold();
  if(!percentDecode)return;
  if(Buffer.byteLength(value)>GENESIS_RESPONSE_SCREEN_LIMITS.headerBytes)throw new GenesisResponseScreeningHold();
  for(let pass=0;pass<GENESIS_RESPONSE_SCREEN_LIMITS.percentPasses;pass++){
   if(!/%[a-f0-9]{2}/i.test(value))return;
   // Decode every percent byte, including Latin-1 octets and over-encoding of
   // ordinary ASCII. Scan both interpretations; never persist the decoded text.
   value=value.replace(/(?:%[a-f0-9]{2})+/gi,encoded=>{
    const bytes=Buffer.from(encoded.replaceAll('%',''),'hex');
    if(this.contains(bytes))throw new GenesisResponseScreeningHold();
    try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return bytes.toString('latin1');}
   });
   if(this.contains(value))throw new GenesisResponseScreeningHold();
  }
  if(/%[a-f0-9]{2}/i.test(value))throw new GenesisResponseScreeningHold();
 }
 #screenCsv(text:string):void {
  const table=readCsv(Buffer.from(text),{limits:{inputBytes:8*1024*1024,rows:20000,columns:128,cells:200000}});
  for(const row of table.rows)for(const cell of row)this.#screenScalar(cell.raw);
 }
 #screenJson(text:string):void {
  JSON.parse(text);
  // Scan ALL lexical string tokens after JSON.parse unescaping, not just the
  // resulting object: duplicate keys must not hide an overwritten echo.
  let strings=0;
  for(const token of text.matchAll(/"(?:[^"\\]|\\.)*"/g)){
   if(++strings>GENESIS_RESPONSE_SCREEN_LIMITS.jsonStrings)throw new GenesisResponseScreeningHold();
   const value:string=JSON.parse(token[0]);this.#screenScalar(value);
   if(value.includes('\n')||value.includes('\r'))this.#screenCsv(value);
  }
 }
 #screenText(bytes:Uint8Array,format:'json'|'csv'|'text'):void {
  const buffer=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(this.contains(buffer))throw new GenesisResponseScreeningHold();
  const latin1=buffer.toString('latin1');let utf8:string|undefined;
  try{utf8=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{}
  for(const text of utf8===undefined||utf8===latin1?[latin1]:[utf8,latin1]){
   if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||/^(?:%PDF-|<|PK)/.test(text.trimStart()))throw new GenesisResponseScreeningHold();
   this.#screenScalar(text);
   const trimmed=text.replace(/^\uFEFF/,'').trimStart();
   if(format==='json'||trimmed.startsWith('{')||trimmed.startsWith('['))this.#screenJson(trimmed);
   else this.#screenCsv(text);
  }
 }
 /** Host-only secrecy gate. HOLD on an echo, invalid/bounded decode, or unknown
  * format; never redact-and-admit and never send these bytes to a sandbox first. */
 screenResponse(body:Buffer,headers:Record<string,string|undefined>,status:number):void {
  try{
   if(!this.#username||body.length>GENESIS_RESPONSE_SCREEN_LIMITS.inputBytes)throw new GenesisResponseScreeningHold();
   for(const value of Object.values(headers))if(value!==undefined)this.#screenScalar(value,true);
   if(!body.length&&status>=300)return; // No retained error/redirect body.
   if(this.contains(body))throw new GenesisResponseScreeningHold();
   const mime=(headers['content-type']??'application/octet-stream').split(';')[0].trim().toLowerCase();
   if(body[0]===0x50&&body[1]===0x4b||['application/zip','application/x-zip-compressed'].includes(mime)){
    const {inputBytes,totalBytes,memberBytes,members,ratio}=GENESIS_RESPONSE_SCREEN_LIMITS;
    const archive=readZip(body,{inputBytes,totalBytes,memberBytes,members,ratio});
    if(!archive.size)throw new GenesisResponseScreeningHold();
    for(const [name,bytes] of archive){
     this.#screenScalar(name,true);
     if(name.endsWith('/')&&!bytes.length)continue;
     const format=/\.json$/i.test(name)?'json':/\.csv$/i.test(name)?'csv':/\.txt$/i.test(name)?'text':null;
     if(!format)throw new GenesisResponseScreeningHold();
     this.#screenText(bytes,format);
    }
   }else{
    const format=/^(?:application|text)\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(mime)?'json':['text/csv','application/csv'].includes(mime)?'csv':['text/plain','application/octet-stream'].includes(mime)?'text':null;
    if(!format)throw new GenesisResponseScreeningHold();
    this.#screenText(body,format);
   }
  }catch{throw new GenesisResponseScreeningHold();}
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
