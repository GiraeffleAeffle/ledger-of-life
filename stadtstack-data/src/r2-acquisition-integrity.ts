import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';

export interface R2IntegrityGuard{journalPath:string;recordSha256:string;manifestSha256:string;changedSourceReleasePath?:string;changedSourceReleaseSha256?:string}
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`:JSON.stringify(value);
const ReleaseSchema=z.object({schemaVersion:z.literal('r2-changed-source-release-v1'),id:z.literal('r2-changed-source-release'),reviewedBy:z.string().min(1),reviewedAt:z.iso.datetime(),reason:z.string().min(1),representations:z.array(z.object({url:z.url(),sourceId:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),r1Sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1)}).strict();
async function privateFile(path:string,kind:string):Promise<Buffer>{
 const absolute=resolve(path),metadata=await lstat(absolute);
 if(!metadata.isFile()||metadata.isSymbolicLink()||await realpath(absolute)!==absolute)throw Error(`${kind} must be a regular non-symlink file`);
 return readFile(absolute);
}
export async function assertR2ReferencesReleased(references:readonly {id:string;url:string;sha256:string}[],guard?:R2IntegrityGuard):Promise<void>{
 if(!guard)return;
 for(const value of [guard.recordSha256,guard.manifestSha256])if(!/^[a-f0-9]{64}$/.test(value))throw Error('R2 integrity guard identity is malformed');
 const bytes=await privateFile(guard.journalPath,'R2 acquisition journal'),text=bytes.toString('utf8');
 if(!text.endsWith('\n'))throw Error('R2 acquisition journal has an incomplete record');
 let latest:Record<string,unknown>|undefined,sequence=0,previousRecordHash:string|null=null;
 for(const line of text.trimEnd().split('\n')){
  const row=JSON.parse(line) as Record<string,unknown>,recordHash=row.recordHash,{recordHash:_omit,...payload}=row;
  if(row.schemaVersion!=='r2-acquisition-progress-v3'||row.sequence!==++sequence||row.previousRecordHash!==previousRecordHash||typeof recordHash!=='string'||sha(canonical(payload))!==recordHash||row.recordSha256!==guard.recordSha256||row.manifestSha256!==guard.manifestSha256||!row.quarantined||typeof row.quarantined!=='object'||Array.isArray(row.quarantined))throw Error('R2 acquisition journal identity, sequence, hash chain, or shape mismatch');
  previousRecordHash=recordHash;latest=row;
 }
 if(!latest)throw Error('R2 acquisition journal is empty');
 if(!latest.completed||typeof latest.completed!=='object'||Array.isArray(latest.completed))throw Error('R2 acquisition journal completed set is invalid');
 const completed=latest.completed as Record<string,unknown>;
 for(const reference of references){
  const row=completed[reference.url];
  if(!row||typeof row!=='object'||Array.isArray(row)||(row as Record<string,unknown>).sourceId!==reference.id||(row as Record<string,unknown>).sha256!==reference.sha256)throw Error('R2 source reference does not match the latest completed URL/source/digest journal entry');
 }
 const held=Object.entries(latest.quarantined as Record<string,unknown>).map(([url,value])=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('R2 quarantine journal entry is invalid');
  const row=value as Record<string,unknown>;
  if(row.url!==undefined&&row.url!==url||typeof row.sourceId!=='string'||typeof row.sha256!=='string'||typeof row.r1Sha256!=='string')throw Error('R2 quarantine journal tuple is invalid');
  return {url,sourceId:row.sourceId,sha256:row.sha256,r1Sha256:row.r1Sha256};
 });
 const relevant=held.filter(item=>references.some(reference=>reference.url===item.url&&reference.sha256===item.sha256));
 if(!relevant.length)return;
 if(!guard.changedSourceReleasePath||!guard.changedSourceReleaseSha256)throw Error('R2 source representation is quarantined pending explicit changed-source review');
 const releaseBytes=await privateFile(guard.changedSourceReleasePath,'R2 changed-source release');
 if(sha(releaseBytes)!==guard.changedSourceReleaseSha256)throw Error('R2 changed-source release digest mismatch');
 const release=ReleaseSchema.parse(JSON.parse(releaseBytes.toString('utf8')));
 if(Date.parse(release.reviewedAt)>Date.now())throw Error('R2 changed-source review time is in the future');
 const tuples=new Map<string,typeof release.representations[number]>();
 for(const row of release.representations){
  if(new URL(row.url).href!==row.url||tuples.has(row.url)||!held.some(item=>item.url===row.url&&item.sourceId===row.sourceId&&item.sha256===row.sha256&&item.r1Sha256===row.r1Sha256))throw Error('R2 changed-source release contains a wrong URL/source/digest tuple');
  tuples.set(row.url,row);
 }
 for(const item of relevant){
  const reference=references.find(candidate=>candidate.url===item.url&&candidate.sha256===item.sha256)!;
  if(reference.id!==item.sourceId||!tuples.has(item.url))throw Error('R2 source representation remains quarantined without its exact release tuple');
 }
}
