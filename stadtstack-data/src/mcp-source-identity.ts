import {createHash} from 'node:crypto';
import type {RevocationSourceDescriptor} from './civic-revocations.ts';
export type SourceIdentityInput={url?:unknown;locator?:unknown;locators?:unknown;publisher?:unknown;sha256?:unknown;policyReceiptSha256?:unknown;scopeSha256?:unknown;role?:unknown};
type DescriptorSource=SourceIdentityInput&{id:string;url:string};
export type KnowledgeDescriptorInput={municipalityId:string}&(
 {kind?:'text_model';sources:readonly DescriptorSource[]}|
 {kind:'structured';source:DescriptorSource;supportingSources:readonly (DescriptorSource&{sha256:string;role:string})[];observation:{publisherId:string;evidence:readonly unknown[];supportingEvidence:readonly {role:string;locator:{sourceSha256:string}}[]};verification:{adapterId:string}}
);

/** Auxiliary source-policy and snapshot URLs are provenance targets, not source identities. */
export function sourceMetadataUrls(source:unknown):string[] {
 const pending:unknown[]=[source],seen=new WeakSet<object>(),urls=new Set<string>();let nodes=0;
 while(pending.length){
  if(++nodes>100000)throw Error('Source provenance exceeds read-view bounds');
  const value=pending.pop();
  if(typeof value==='string'){for(const match of value.matchAll(/https?:\/\/[^\s<>"'\\]+/giu))urls.add(match[0]);}
  else if(value&&typeof value==='object'&&!seen.has(value)){seen.add(value);if(Array.isArray(value))pending.push(...value);else for(const [key,child] of Object.entries(value)){pending.push(key,child);}}
 }
 return [...urls];
}
/** Existing MCP wire canonicalization; undefined object fields are omitted and array order is preserved. */
export function canonical(value:unknown):string {
 if(Array.isArray(value))return JSON.stringify(value.map(item=>JSON.parse(canonical(item))));
 if(value&&typeof value==='object')return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,JSON.parse(canonical(item))])));
 return JSON.stringify(value);
}
/** Preserve the exact published source identity tuple, including null hash and absent fields. */
export function mcpSourceId(source:SourceIdentityInput):string {
 return `source:${createHash('sha256').update(canonical({url:source.url,locator:source.locator,locators:source.locators,publisher:source.publisher,sha256:source.sha256??null,policyReceiptSha256:source.policyReceiptSha256,scopeSha256:source.scopeSha256,role:source.role})).digest('hex')}`;
}
/** Canonical published attribution, shared by indexing and every revocation decision. */
export function knowledgeSources(record:KnowledgeDescriptorInput):Array<SourceIdentityInput&{registrySourceId:string;url:string}> {
 if(record.kind==='structured'){
  const primary={...record.source,registrySourceId:record.source.id,publisher:record.observation.publisherId,sourceType:record.verification.adapterId,locators:record.observation.evidence};
  const supporting=record.supportingSources.map(source=>({...source,registrySourceId:source.id,locators:record.observation.supportingEvidence.filter(evidence=>evidence.role===source.role&&evidence.locator.sourceSha256===source.sha256).map(evidence=>evidence.locator)}));
  return [primary,...supporting];
 }
 return record.sources.map(source=>({...source,publisher:record.municipalityId,registrySourceId:source.id}));
}
/** Auxiliary provenance remains revocable without changing the canonical source identity. */
export function knowledgeSourceDescriptors(record:KnowledgeDescriptorInput):RevocationSourceDescriptor[] {
 const sources=knowledgeSources(record);
 const primaryUrls=new Set(sources.map(source=>source.url)),auxiliaryUrls=new Set(sources.flatMap(sourceMetadataUrls));
 return [...sources.map(source=>({mcpSourceId:mcpSourceId(source),municipalityId:record.municipalityId,registrySourceId:source.registrySourceId,url:source.url})),...[...auxiliaryUrls].filter(url=>!primaryUrls.has(url)).map(url=>({municipalityId:record.municipalityId,url}))];
}
