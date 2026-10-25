import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';

export interface R2IntegrityGuard{journalPath:string;recordSha256:string;manifestSha256:string}
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`:JSON.stringify(value);
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
  if(row.schemaVersion!=='r2-acquisition-progress-v4')throw Error('R2 acquisition journal schema mismatch');
  if(row.sequence!==++sequence)throw Error(`R2 acquisition journal sequence mismatch (${String(row.sequence)} != ${sequence})`);
  if(row.previousRecordHash!==previousRecordHash)throw Error('R2 acquisition journal previous-record hash mismatch');
  if(typeof recordHash!=='string'||sha(canonical(payload))!==recordHash)throw Error('R2 acquisition journal record hash mismatch');
  if(row.recordSha256!==guard.recordSha256||row.manifestSha256!==guard.manifestSha256)throw Error('R2 acquisition journal identity differs from the source guard');
  if(!row.quarantined||typeof row.quarantined!=='object'||Array.isArray(row.quarantined)||!Array.isArray(row.appliedChangedReleases))throw Error('R2 acquisition journal quarantine or release set is invalid');
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
 const applied=latest.appliedChangedReleases as Array<{sha256:string;reviewedBy:string;reviewedAt:string;reason:string;representations:Array<{url:string;sourceId:string;sha256:string;r1Sha256:string}>}>;
 for(const release of applied){
  if(!release||!/^([a-f0-9]{64})$/.test(release.sha256)||typeof release.reviewedBy!=='string'||!release.reviewedBy||typeof release.reason!=='string'||!release.reason||!Number.isFinite(Date.parse(release.reviewedAt))||Date.parse(release.reviewedAt)>Date.now()||!Array.isArray(release.representations))throw Error('R2 applied changed-source release journal entry is malformed');
  const seen=new Set<string>();for(const tuple of release.representations)if(!tuple||typeof tuple.url!=='string'||new URL(tuple.url).href!==tuple.url||seen.has(tuple.url)||typeof tuple.sourceId!=='string'||!tuple.sourceId||!/^([a-f0-9]{64})$/.test(tuple.sha256)||!/^([a-f0-9]{64})$/.test(tuple.r1Sha256))throw Error('R2 applied changed-source release tuple is malformed');else seen.add(tuple.url);
 }
 for(const item of relevant){
  const reference=references.find(candidate=>candidate.url===item.url&&candidate.sha256===item.sha256)!;
  if(reference.id!==item.sourceId)throw Error('R2 source representation does not match its quarantined source binding');
  const heldRow=(latest.quarantined as Record<string,{reviewed?:unknown}>)[item.url];
  if(heldRow?.reviewed!==true||!applied.some(release=>release.representations.some(tuple=>tuple.url===item.url&&tuple.sourceId===item.sourceId&&tuple.sha256===item.sha256&&tuple.r1Sha256===item.r1Sha256)))throw Error('R2 source representation is quarantined pending an exact journaled changed-source release');
 }
}
