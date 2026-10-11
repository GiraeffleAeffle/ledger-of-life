import {createHash} from 'node:crypto';
import {isRecordRevoked,isSourceRevoked,type RevocationSourceDescriptor,type VerifiedRevocations} from './civic-revocations.ts';
export type SourceIdentityInput={url?:unknown;locator?:unknown;locators?:unknown;publisher?:unknown;sha256?:unknown;policyReceiptSha256?:unknown;scopeSha256?:unknown;role?:unknown};
type DescriptorSource=SourceIdentityInput&{id:string;url:string};
export type KnowledgeDescriptorInput={municipalityId:string}&(
 {kind?:'text_model';sources:readonly DescriptorSource[]}|
 {kind:'structured';source:DescriptorSource;supportingSources:readonly (DescriptorSource&{sha256:string;role:string})[];observation:{publisherId:string;evidence:readonly unknown[];supportingEvidence:readonly {role:string;locator:{sourceSha256:string}}[]};verification:{adapterId:string}}
);

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
/** Primary and supporting descriptors mirror QueryIndex attribution; no source or scope inference. */
export function knowledgeSourceDescriptors(record:KnowledgeDescriptorInput):RevocationSourceDescriptor[] {
 if(record.kind==='structured'){
  const primary={...record.source,registrySourceId:record.source.id,publisher:record.observation.publisherId,sourceType:record.verification.adapterId,locators:record.observation.evidence};
  const supporting=record.supportingSources.map(source=>({...source,registrySourceId:source.id,locators:record.observation.supportingEvidence.filter(evidence=>evidence.role===source.role&&evidence.locator.sourceSha256===source.sha256).map(evidence=>evidence.locator)}));
  return [primary,...supporting].map(source=>({mcpSourceId:mcpSourceId(source),municipalityId:record.municipalityId,registrySourceId:source.registrySourceId,url:source.url}));
 }
 return record.sources.map(source=>({mcpSourceId:mcpSourceId({...source,registrySourceId:source.id,publisher:record.municipalityId}),municipalityId:record.municipalityId,registrySourceId:source.id,url:source.url}));
}

export type KnowledgeReadRecord=KnowledgeDescriptorInput&{id:string};
export type KnowledgeReadEnvelope<T extends KnowledgeReadRecord=KnowledgeReadRecord>={schemaVersion:string;generatedAt:string;records:readonly T[]};
export type SafeKnowledgeReadView<T extends KnowledgeReadRecord=KnowledgeReadRecord>=Readonly<{records:KnowledgeReadEnvelope<T>;revocations:VerifiedRevocations;visibleRecordIds:readonly string[]}>;
const safeKnowledgeViews=new WeakMap<SafeKnowledgeReadView,{original:string;mask:string}>();
function freezeReadData(value:unknown):void {
 if(!value||typeof value!=='object'||Object.isFrozen(value))return;
 for(const item of Object.values(value))freezeReadData(item);
 Object.freeze(value);
}
/** Select unchanged admitted records with the one authenticated matcher, never a replacement source event. */
export function createSafeKnowledgeReadView<T extends KnowledgeReadRecord>(original:KnowledgeReadEnvelope<T>,revocations:VerifiedRevocations):SafeKnowledgeReadView<T> {
 isSourceRevoked(revocations,{});
 const records=original.records.filter(record=>!isRecordRevoked(revocations,{recordId:record.id,municipalityId:record.municipalityId,sources:knowledgeSourceDescriptors(record)}));
 const envelope=JSON.parse(canonical({...original,records})) as KnowledgeReadEnvelope<T>;
 freezeReadData(envelope);
 const view:SafeKnowledgeReadView<T>=Object.freeze({records:envelope,revocations,visibleRecordIds:Object.freeze(records.map(record=>record.id).sort())});
 safeKnowledgeViews.set(view,{original:canonical(original),mask:revocations.artifactSha256});
 return view;
}
/** Graphs accept only the original-subset view issued by the shared reader, not caller-invented visibility. */
export function assertSafeKnowledgeReadView(originalBytes:string|Uint8Array,view:SafeKnowledgeReadView,revocations:VerifiedRevocations):void {
 isSourceRevoked(revocations,{});
 const proof=safeKnowledgeViews.get(view);
 const original=JSON.parse(typeof originalBytes==='string'?originalBytes:Buffer.from(originalBytes).toString('utf8'));
 if(!proof||proof.mask!==revocations.artifactSha256||view.revocations!==revocations||canonical(original)!==proof.original)throw Error('Safe knowledge view is not bound to original publication and verified mask');
}
