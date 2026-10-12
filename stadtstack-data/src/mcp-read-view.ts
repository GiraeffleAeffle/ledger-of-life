import {createHash} from 'node:crypto';
import {isRecordRevoked,isSourceRevoked,type VerifiedRevocations,type RevocationSourceDescriptor} from './civic-revocations.ts';
import {canonical,mcpSourceId,knowledgeSourceDescriptors,sourceMetadataUrls} from './mcp-source-identity.ts';
import type {Catalogue,Signal} from './schema.ts';
import type {Regional,KnowledgeQueryData} from './mcp-query.ts';
import type {CoreBundle} from './core-schema.ts';
import type {Changes} from './changes.ts';
import {regionalStatement} from './regional-statement.ts';
import type {AdministrativeView} from './mcp-revocation-view.ts';

type RegionalItem=Regional['topics'][number]['municipalities'][number]['items'][number];
export function regionalRecordId(municipalityId:string,item:RegionalItem){return `regional:${createHash('sha256').update(canonical({municipalityId,url:item.url,locator:item.locator})).digest('hex')}`;}
export function regionalSource(item:RegionalItem,asOf:string,statement=regionalStatement(item)){
 return {url:item.url,title:item.title,publisher:'Official regional evidence (see source URL)',locator:item.locator,sha256:statement.statementEvidence[0]?.sourceSha256,statementEvidence:statement.statementEvidence,retrievedAt:null,asOf,retrievalNote:'Regional snapshot asOf is known; an individual source retrieval timestamp is not supplied.',licence:'unknown',reuse:'facts_with_attribution',sourceType:item.sourceType,licenceNote:'No open licence inferred by the query layer; see released regional source evidence.'};
}
export function signalSourceDescriptors(feature:Signal):RevocationSourceDescriptor[]{return feature.properties.sources.flatMap(source=>[{mcpSourceId:mcpSourceId(source),url:source.url,municipalityId:feature.properties.cityId},...sourceMetadataUrls(source).filter(url=>url!==source.url).map(url=>({municipalityId:feature.properties.cityId,url}))]);}

export function visibleSignals(features:Signal[],mask:VerifiedRevocations){return mask.targets.length?features.filter(feature=>!isRecordRevoked(mask,{recordId:feature.properties.id,municipalityId:feature.properties.cityId,sources:signalSourceDescriptors(feature)})):features;}
export function visibleRegional(regional:Regional,mask:VerifiedRevocations):Regional {
 if(!mask.targets.length)return regional;
 return {...regional,region:{id:regional.region.id,name:regional.region.name},municipalities:regional.municipalities.map(({id,name,ags})=>({id,name,ags})),topics:regional.topics.map(topic=>({...topic,municipalities:topic.municipalities.map(municipality=>({...municipality,items:municipality.items.filter(item=>!isRecordRevoked(mask,{recordId:regionalRecordId(municipality.municipalityId,item),municipalityId:municipality.municipalityId,sources:[{url:item.url,mcpSourceId:mcpSourceId(regionalSource(item,regional.asOf))},...sourceMetadataUrls(item).filter(url=>url!==item.url).map(url=>({url}))]}))}))}))};
}
export function visibleKnowledge(knowledge:KnowledgeQueryData,mask:VerifiedRevocations,view:AdministrativeView):KnowledgeQueryData {
 if(!mask.targets.length)return knowledge;
 const revokedRegistrySources=new Set<string>();
 const records=knowledge.records.filter(record=>{
  const descriptors=knowledgeSourceDescriptors(record);
  for(const descriptor of descriptors)if(descriptor.registrySourceId&&isSourceRevoked(mask,descriptor))revokedRegistrySources.add(JSON.stringify([record.municipalityId,descriptor.registrySourceId]));
  return !isRecordRevoked(mask,{recordId:record.id,municipalityId:record.municipalityId,sources:descriptors});
 });
 const municipalities=knowledge.municipalities.map(city=>({id:city.id,name:city.name,ags:city.ags,districtId:city.districtId,administrativeStatus:city.administrativeStatus,amt:city.amt&&sourceMetadataUrls(city.amt).every(url=>!isSourceRevoked(mask,{municipalityId:city.id,url}))?city.amt:null,sources:city.sources.filter(source=>!revokedRegistrySources.has(JSON.stringify([city.id,source.id]))&&!isSourceRevoked(mask,{municipalityId:city.id,registrySourceId:source.id,...(source.url?{url:source.url}:{})})&&sourceMetadataUrls(source).every(url=>!isSourceRevoked(mask,{url}))).map(({id,kind,url,checkState})=>({id,kind,url,checkState}))}));
 return {records,municipalities,coverage:{scope:'Visible published records only. Original source attempts, document totals, quarantine and historical coverage are not counts of this administrative view and are omitted.',administrativeView:view,municipalities:municipalities.map(({id})=>{const visible=records.filter(record=>record.municipalityId===id);return {id,publishedRecords:visible.length,datedStagedRecords:visible.filter(record=>record.kind==='text_model'&&record.stageDate!==null&&record.stage!=='unknown').length};})}};
}
export function visibleCatalogue(catalogue:Catalogue,features:Signal[],mask:VerifiedRevocations):Catalogue {
 if(!mask.targets.length)return catalogue;
 // Publication feeds/minified files and their byte counts bypass the read view. Never link them.
 return {schemaVersion:catalogue.schemaVersion,generatedAt:catalogue.generatedAt,publisher:catalogue.publisher,cities:catalogue.cities.map(city=>({id:city.id,name:city.name,state:city.state,center:city.center,bbox:city.bbox,sources:city.sources.filter(source=>!isSourceRevoked(mask,{url:source.url,municipalityId:city.id,registrySourceId:source.id})&&!sourceMetadataUrls(source).some(url=>isSourceRevoked(mask,{url}))&&features.some(feature=>feature.properties.cityId===city.id&&feature.properties.sources.some(contributor=>contributor.url===source.url))).map(({id,kind,publisher,url,licence,reuse,retrievedAt})=>({id,kind,publisher,url,licence,reuse,retrievedAt}))}))};
}
export function visibleCore(bundle:CoreBundle,allFeatures:Signal[],mask:VerifiedRevocations,registrySources:readonly RevocationSourceDescriptor[]=[]):CoreBundle {
 if(!mask.targets.length)return bundle;
 return {...bundle,facts:bundle.facts.filter(fact=>{const signal=allFeatures.find(feature=>feature.properties.id===fact.id);return !isRecordRevoked(mask,{recordId:fact.id,municipalityId:bundle.cityId,sources:[{url:fact.source.url,mcpSourceId:mcpSourceId(fact.source)},...sourceMetadataUrls(fact.source).filter(url=>url!==fact.source.url).map(url=>({url})),...(signal?signalSourceDescriptors(signal):[]),...registrySources.filter(source=>source.municipalityId===bundle.cityId&&source.url===fact.source.url)]});})};
}

/** Only sealed in-memory provenance is usable. Historical missing ancestry is not a policy lookup. */
export function visibleChanges(changes:Record<string,Changes>,features:readonly Signal[],knowledge:Pick<KnowledgeQueryData,'records'>|undefined,mask:VerifiedRevocations):Record<string,Changes> {
 if(!mask.targets.length)return changes;
 const records=new Map<string,RevocationSourceDescriptor[]>(),hashes=new Map<string,RevocationSourceDescriptor[]>(),affectedCities=new Set<string>();
 const add=(city:string,id:string,sources:RevocationSourceDescriptor[],sourceHashes:readonly (string|null)[])=>{records.set(JSON.stringify([city,id]),sources);if(isRecordRevoked(mask,{recordId:id,municipalityId:city,sources}))affectedCities.add(city);for(const hash of sourceHashes)if(hash)hashes.set(hash,[...(hashes.get(hash)??[]),...sources]);};
 for(const feature of features)add(feature.properties.cityId,feature.properties.id,signalSourceDescriptors(feature),feature.properties.sources.map(source=>source.sha256));
 for(const record of knowledge?.records??[])add(record.municipalityId,record.id,knowledgeSourceDescriptors(record),(record.kind==='structured'?[record.source,...record.supportingSources]:record.sources).map(source=>source.sha256));
 const relevant=(city:string)=>mask.targets.some(target=>target.type==='host'||target.type==='mcp_source'||target.type==='registry_source'&&target.municipalityId===city);
 const blocked=(city:string,id:string)=>{const sources=records.get(JSON.stringify([city,id]));return isRecordRevoked(mask,{recordId:id,municipalityId:city,sources:sources??[]})||!sources&&relevant(city);};
 return Object.fromEntries(Object.entries(changes).map(([city,feed])=>[city,{...feed,events:feed.events.filter(event=>{
  if(blocked(city,event.id)||sourceMetadataUrls(event).some(url=>isSourceRevoked(mask,{url})))return false;
  const evidence=event.evidence;
  if(evidence&&(blocked(city,evidence.recordId)||evidence.replacementRecordId!==null&&blocked(city,evidence.replacementRecordId)||isSourceRevoked(mask,{url:evidence.sourceUrl})))return false;
  for(const revision of [event.previous,event.current])if(revision){
   if(relevant(city)&&(!revision.sourceHashes.length||revision.sourceHashes.some(hash=>{const sources=hashes.get(hash);return !sources||sources.some(source=>isSourceRevoked(mask,source));})))return false;
   // Revision metric provenance uses registry IDs, not necessarily MCP IDs. Only exact known ancestry is admissible.
   for(const claim of revision.metricClaims)for(const item of [claim.evidence,claim.scopeEvidence,claim.replaces?.evidence])if(item&&relevant(city)&&item.sourceIds.some(id=>{const sources=records.get(JSON.stringify([city,event.id]));const matches=sources?.filter(source=>source.mcpSourceId===id||source.registrySourceId===id);return !matches?.length||matches.some(source=>isSourceRevoked(mask,source));}))return false;
  }
  return true;
 }),snapshots:affectedCities.has(city)?[]:feed.snapshots}]));
}
