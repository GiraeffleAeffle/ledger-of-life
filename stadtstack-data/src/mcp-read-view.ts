import {createHash} from 'node:crypto';
import {isRecordRevoked,isSourceRevoked,type RevocationSourceDescriptor,type VerifiedRevocations} from './civic-revocations.ts';
import {canonical,knowledgeSourceDescriptors,mcpSourceId,sourceMetadataUrls} from './mcp-source-identity.ts';
import type {Signal} from './schema.ts';
import type {Changes} from './changes.ts';
import type {KnowledgeQueryData,Regional} from './mcp-query.ts';
import {regionalStatement} from './regional-statement.ts';

type RegionalItem=Regional['topics'][number]['municipalities'][number]['items'][number];
export function regionalRecordId(municipalityId:string,item:RegionalItem){return `regional:${createHash('sha256').update(canonical({municipalityId,url:item.url,locator:item.locator})).digest('hex')}`;}
export function regionalSource(item:RegionalItem,asOf:string,statement=regionalStatement(item)){
 return {url:item.url,title:item.title,publisher:'Official regional evidence (see source URL)',locator:item.locator,sha256:statement.statementEvidence[0]?.sourceSha256,statementEvidence:statement.statementEvidence,retrievedAt:null,asOf,retrievalNote:'Regional snapshot asOf is known; an individual source retrieval timestamp is not supplied.',licence:'unknown',reuse:'facts_with_attribution',sourceType:item.sourceType,licenceNote:'No open licence inferred by the query layer; see released regional source evidence.'};
}
export function signalSourceDescriptors(feature:Signal):RevocationSourceDescriptor[]{return feature.properties.sources.flatMap(source=>[{mcpSourceId:mcpSourceId(source),url:source.url,municipalityId:feature.properties.cityId},...sourceMetadataUrls(source).filter(url=>url!==source.url).map(url=>({municipalityId:feature.properties.cityId,url}))]);}

/** Hide change evidence whose identity, source ancestry, or replacement witness is withheld. */
export function visibleChanges(changes:Record<string,Changes>,features:readonly Signal[],knowledge:Pick<KnowledgeQueryData,'records'>,mask:VerifiedRevocations):Record<string,Changes>{
 const byRecord=new Map<string,RevocationSourceDescriptor[]>(),byHash=new Map<string,RevocationSourceDescriptor[]>(),affectedCities=new Set<string>();
 for(const feature of features){const id=feature.properties.id,city=feature.properties.cityId,sources=signalSourceDescriptors(feature);byRecord.set(id,sources);for(const source of feature.properties.sources)if(source.sha256){const descriptor=sources.find(item=>item.mcpSourceId===mcpSourceId(source));if(descriptor)byHash.set(source.sha256,[...(byHash.get(source.sha256)??[]),descriptor]);}if(isRecordRevoked(mask,{recordId:id,municipalityId:city,sources}))affectedCities.add(city);}
 for(const record of knowledge.records){const descriptors=knowledgeSourceDescriptors(record),recordSources=record.kind==='structured'?[record.source,...record.supportingSources]:record.sources;byRecord.set(record.id,descriptors);for(const source of recordSources){const descriptor=descriptors.find(item=>item.registrySourceId===source.id);if(source.sha256&&descriptor)byHash.set(source.sha256,[...(byHash.get(source.sha256)??[]),descriptor]);}if(isRecordRevoked(mask,{recordId:record.id,municipalityId:record.municipalityId,sources:descriptors}))affectedCities.add(record.municipalityId);}
 const relevant=(city:string)=>mask.targets.some(target=>target.type==='host'||target.type==='mcp_source'||target.type==='registry_source'&&target.municipalityId===city);
 return Object.fromEntries(Object.entries(changes).map(([city,feed])=>[city,{...feed,events:feed.events.filter(event=>{
  const sources=byRecord.get(event.id);
  if(isRecordRevoked(mask,{recordId:event.id,municipalityId:city,sources:sources??[]})||!sources&&relevant(city)||sourceMetadataUrls(event).some(url=>isSourceRevoked(mask,{url})))return false;
  if(event.evidence){const evidenceSources=byRecord.get(event.evidence.recordId);if(isRecordRevoked(mask,{recordId:event.evidence.recordId,municipalityId:city,sources:evidenceSources??[]})||!evidenceSources&&relevant(city)||isSourceRevoked(mask,{url:event.evidence.sourceUrl})||event.evidence.replacementRecordId!==null&&isRecordRevoked(mask,{recordId:event.evidence.replacementRecordId,municipalityId:city,sources:byRecord.get(event.evidence.replacementRecordId)??[]}))return false;}
  for(const revision of [event.previous,event.current])if(revision){
   if(relevant(city)&&(!revision.sourceHashes.length||revision.sourceHashes.some(hash=>{const descriptors=byHash.get(hash);return !descriptors?.length||descriptors.some(source=>isSourceRevoked(mask,source));})))return false;
   for(const claim of revision.metricClaims)for(const evidence of [claim.evidence,claim.scopeEvidence,claim.replaces?.evidence])if(evidence&&relevant(city)&&evidence.sourceIds.some(id=>{const matches=sources?.filter(source=>source.mcpSourceId===id||source.registrySourceId===id);return !matches?.length||matches.some(source=>isSourceRevoked(mask,source));}))return false;
  }
  return true;
 }),snapshots:affectedCities.has(city)?[]:feed.snapshots}]));
}
