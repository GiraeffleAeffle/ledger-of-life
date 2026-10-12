import {createHash} from 'node:crypto';
import {z} from 'zod';
import {governedReleaseDirectory} from './governed-release-directory.ts';
import {catalogueSchema,collectionSchema,cityFeedSchema,type Catalogue,type Signal,type CityFeed} from './schema.ts';
import {coreBundleSchema,type CoreBundle} from './core-schema.ts';
import {verifyDataRelease,requireReleaseFiles,readReleaseFile,type DataRelease} from './data-release.ts';
import {QueryIndex,regionalSchema,type Regional} from './mcp-query.ts';
import type {QueryVisibility} from './mcp-query.ts';
import {validateKnowledgeRelease,KnowledgeRecordsSchema} from './district-schema.ts';
import {districtRegistrySchema,type DistrictRegistry} from './district-registry.ts';
import {districtCoverageSchema,validateDistrictCoverage,assertKnowledgeSlice,type DistrictCoverage} from './district-publication.ts';
import {changesSchema,validateChanges,signalChangeRecord,knowledgeChangeRecord,type Changes} from './changes.ts';
import {GraphIndex} from './district-graph-query.ts';
import {publicationInputsSchema,verifyPublicationPolicyReceipts,requiredPublicationStaging,type PublicationInputs} from './district-publication-inputs.ts';
import type {CivicPolicyOptions} from './civic-opt-out.ts';
import {loadGovernedRevocations} from './mcp-revocation-config.ts';
import {isSourceRevoked,isRecordRevoked,type VerifiedRevocations,type RevocationSourceDescriptor} from './civic-revocations.ts';
import {buildKnowledgeGraph,projectKnowledgeReadEnvelope,KnowledgeGraphSchema,type KnowledgeGraph} from './district-graph.ts';
import {CriticalAdmissionsSchema} from './district-critical-assessment-contract.ts';
import {mcpSourceId,sourceMetadataUrls} from './mcp-source-identity.ts';
import {visibleChanges} from './mcp-read-view.ts';
import {assertCriticalAdmissionsBound} from './district-critical-assessment-public.ts';

export type ReleaseLoadOptions={mode:'sealed';revocations?:VerifiedRevocations}|{mode:'vm_candidate';policyOptions:CivicPolicyOptions};
export type ReleasedKnowledge=z.infer<typeof KnowledgeRecordsSchema>;
export type ReleasedData={bundle:CoreBundle;manifest:Record<string,unknown>;dataManifest:DataRelease;publicationInputs:PublicationInputs;catalogue:Catalogue;features:Signal[];feeds:Record<string,CityFeed>;changes:Record<string,Changes>;regional:Regional;knowledge:ReleasedKnowledge;registry:DistrictRegistry;coverage:DistrictCoverage;servedCoverage:MaskedCoverage|null;knowledgeChanges:Changes;graphData:KnowledgeGraph;index:QueryIndex;graph:GraphIndex;mode:'sealed'|'vm_candidate';revocations:VerifiedRevocations|null;visibility:QueryVisibility|null};
let release:ReleasedData|undefined;
let loading:Promise<ReleasedData>|undefined;
const releaseSourceUrls=new WeakMap<ReleasedData,readonly string[]>();
/** Sealed hosted reads use the verified startup mask, never VM/CAS policy access. */
export async function recheckReleasePolicy(data:ReleasedData,policyOptions?:CivicPolicyOptions):Promise<ReleasedData>{
 if(data.mode==='sealed'){if(!data.revocations||data.revocations.releaseId!==data.dataManifest.id)throw Error('Sealed release lacks its governed revocation state');isSourceRevoked(data.revocations,{});return data;}
 if(!policyOptions)throw Error('VM candidate serving requires explicit current policy configuration');
 let urls=releaseSourceUrls.get(data);
 if(!urls){
  const sources=new Set<string>();
  for(const feature of data.features)for(const source of feature.properties.sources){sources.add(source.url);if(source.snapshotUrl)sources.add(source.snapshotUrl);}
  for(const fact of data.bundle.facts)sources.add(fact.source.url);
  for(const topic of data.regional.topics)for(const municipality of topic.municipalities)for(const item of municipality.items)sources.add(item.url);
  for(const record of data.index.knowledge?.records??[])for(const source of record.kind==='structured'?[record.source,...record.supportingSources]:record.sources)sources.add(source.url);
  urls=[...sources];releaseSourceUrls.set(data,urls);
 }
 // Platform-specific VM policy module is intentionally absent from sealed packages.
 const {assertVmReleaseSources}=await import('./mcp-vm-release-policy.ts');
 await assertVmReleaseSources(urls,policyOptions);
 return data;
}
export async function loadRelease(directory=governedReleaseDirectory(),options:ReleaseLoadOptions={mode:'sealed'}):Promise<ReleasedData> {
  const dataManifest=await verifyDataRelease(directory);
  const revocations=options.mode==='sealed'?(options.revocations??await loadGovernedRevocations(dataManifest.id)):null;
  if(revocations){if(revocations.releaseId!==dataManifest.id)throw Error('Sealed revocation release identity mismatch');isSourceRevoked(revocations,{});}
  const bytes=await readReleaseFile(directory,dataManifest,'core/strausberg-facts.json');
  const bundle=coreBundleSchema.parse(JSON.parse(bytes.toString('utf8')));
  const sha=z.string().regex(/^[a-f0-9]{64}$/);
  const manifest=z.object({schemaVersion:z.literal('stadtstack-core-release-v1'),bundlePath:z.literal('core/strausberg-facts.json'),bundleSha256:sha,bundleVersion:sha,corpus:z.object({fullPath:z.literal('cities/strausberg/signals.geojson'),fullSha256:sha}).passthrough()}).passthrough().parse(JSON.parse((await readReleaseFile(directory,dataManifest,'core/release-manifest.json')).toString('utf8')));
  if(createHash('sha256').update(bytes).digest('hex')!==manifest.bundleSha256||bundle.version!==manifest.bundleVersion)throw Error('Core bundle release mismatch');
  const corpus=await readReleaseFile(directory,dataManifest,manifest.corpus.fullPath);
  if(createHash('sha256').update(corpus).digest('hex')!==manifest.corpus.fullSha256)throw Error('Core corpus release mismatch');
  const catalogue=catalogueSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'catalogue.json')).toString('utf8')));
  const features:Signal[]=[],changes:Record<string,Changes>={},feeds:Record<string,CityFeed>={};
  const feedSourceUrls=new Set<string>();
  for(const city of catalogue.cities) {
    if(!/^[a-z0-9-]{1,80}$/.test(city.id))throw Error('Invalid released city id');
    requireReleaseFiles(dataManifest,[`cities/${city.id}/signals.geojson`,`cities/${city.id}/signals.min.geojson`,`cities/${city.id}/changes.json`,...(city.feedUrl?[city.feedUrl]:[])]);
    const collectionBytes=city.id==='strausberg'?corpus:await readReleaseFile(directory,dataManifest,`cities/${city.id}/signals.geojson`);
    const collection=collectionSchema.parse(JSON.parse(collectionBytes.toString('utf8')));
    if(city.feedUrl){const feed=cityFeedSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,city.feedUrl)).toString('utf8')));if(feed.cityId!==city.id)throw Error('Released feed city mismatch');feeds[city.id]=feed;for(const source of feed.sources){feedSourceUrls.add(source.url);if(source.pageUrl)feedSourceUrls.add(source.pageUrl);}for(const item of feed.items){feedSourceUrls.add(item.url);if(item.locationSource){feedSourceUrls.add(item.locationSource.url);if(item.locationSource.geometrySourceUrl)feedSourceUrls.add(item.locationSource.geometrySourceUrl);}}}
    changes[city.id]=validateChanges(JSON.parse((await readReleaseFile(directory,dataManifest,`cities/${city.id}/changes.json`)).toString('utf8')),collection.features.map(signalChangeRecord));
    if(changes[city.id].events.some(event=>event.cityId!==city.id||event.recordType!=='signal'))throw Error('Released city change scope mismatch');
    if(collection.features.some(feature=>feature.properties.cityId!==city.id))throw Error('Released feature city mismatch');
    features.push(...collection.features);
  }
  const regional=regionalSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'regions/brandenburg-mol/topics.json')).toString('utf8')));
  requireReleaseFiles(dataManifest,['knowledge/registry.json','knowledge/records.json','knowledge/coverage.json','knowledge/graph.json','knowledge/changes.json','knowledge/publication-inputs.json','knowledge/assessment-admissions.json']);
  const registry=districtRegistrySchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/registry.json')).toString('utf8')));
  const knowledgeBytes=await readReleaseFile(directory,dataManifest,'knowledge/records.json');
  const knowledge=validateKnowledgeRelease(JSON.parse(knowledgeBytes.toString('utf8')),registry);
  const criticalProjection=CriticalAdmissionsSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/assessment-admissions.json')).toString('utf8')));
  const knowledgeChanges=validateChanges(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/changes.json')).toString('utf8')),knowledge.records.map(knowledgeChangeRecord));
  const municipalityIds=new Set(registry.municipalities.map(city=>city.id));
  for(const cityId of municipalityIds){
    const snapshots=knowledgeChanges.snapshots.filter(snapshot=>snapshot.cityId===cityId&&snapshot.recordType==='knowledge');
    if(snapshots.length!==1)throw Error('Released knowledge changes omit a municipality snapshot');
    const prior=changes[cityId];
    changes[cityId]={schemaVersion:'stadtstack-changes-v2',generatedAt:dataManifest.generatedAt,events:[...(prior?.events??[]),...knowledgeChanges.events.filter(event=>event.cityId===cityId)],snapshots:[...(prior?.snapshots??[]),...snapshots]};
  }
  if(knowledgeChanges.events.some(event=>event.recordType!=='knowledge'||!municipalityIds.has(event.cityId)))throw Error('Released knowledge change scope mismatch');
  for(const [cityId,feed] of Object.entries(changes))changes[cityId]=changesSchema.parse({...feed,events:feed.events.sort((a,b)=>a.recordType.localeCompare(b.recordType)||a.id.localeCompare(b.id)||a.kind.localeCompare(b.kind))});
  const publicationInputs=publicationInputsSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/publication-inputs.json')).toString('utf8')));
  if(JSON.stringify(publicationInputs.staging.map(member=>member.path))!==JSON.stringify(requiredPublicationStaging(catalogue.cities.map(city=>city.id))))throw Error('Release publication input inventory mismatch');
  verifyPublicationPolicyReceipts(publicationInputs,knowledge.records.map(record=>record.id));
  for(const path of ['knowledge/registry.json','knowledge/records.json','knowledge/coverage.json','knowledge/assessment-admissions.json']){
    const member=publicationInputs.staging.find(member=>member.path===path)!,released=dataManifest.files.find(member=>member.path===path)!;
    if(member.sha256!==released.sha256||member.bytes!==released.bytes)throw Error('Release knowledge differs from its publication input binding');
  }
  const coverage=districtCoverageSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/coverage.json')).toString('utf8')));
  validateDistrictCoverage(coverage,registry,knowledge.records);
  assertKnowledgeSlice(registry,knowledge.records);
  assertCriticalAdmissionsBound(knowledge.records,criticalProjection.admissions,coverage.retainedPublication??null);
  const graphData=KnowledgeGraphSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/graph.json')).toString('utf8')));
  if(graphData.asOf!==publicationInputs.asOf)throw Error('Released graph asOf is not publication-bound');
  const graph=new GraphIndex(dataManifest.id,graphData,knowledgeBytes);
  const publicationIndex=new QueryIndex(dataManifest.id,dataManifest.generatedAt,features,regional,catalogue,{records:knowledge.records,municipalities:registry.municipalities,coverage});
  const visibility=revocations?publicationIndex.withRevocations(revocations):null;
  const index=visibility?.index??publicationIndex;
  const metadataBase:ReleasedData={bundle,manifest,dataManifest,publicationInputs,catalogue,features,feeds,changes,regional,knowledge,registry,coverage,servedCoverage:null,knowledgeChanges,graphData,index:publicationIndex,graph,mode:options.mode,revocations,visibility:null};
  const maskedMetadata=visibility&&revocations?.targets.length?projectMaskedReleaseMetadata(metadataBase,visibility):null;
  let servedGraph=graph,servedGraphData=graphData,servedFeatures=features,servedRegional=regional,servedKnowledge=knowledge,servedChanges=changes,servedBundle=bundle,servedRegistry=registry;
  if(visibility&&revocations){
    servedFeatures=features.filter(feature=>visibility.visibleRecordIds.has(feature.properties.id));
    servedRegional=visibility.index.regional;
    servedKnowledge=projectKnowledgeReadEnvelope(knowledge,visibility.visibleRecordIds);
    const safeBytes=servedKnowledge.records.length===knowledge.records.length?knowledgeBytes:JSON.stringify(servedKnowledge);
    const safeGraph=buildKnowledgeGraph(safeBytes,{asOf:graphData.asOf});
    servedGraph=graph.withReadView(safeGraph,safeBytes,visibility.visibleRecordIds,revocations);
    servedGraphData=servedGraph.graphView();
    servedChanges=visibleChanges(changes,features,knowledge,revocations);
    servedBundle={...bundle,facts:bundle.facts.filter(fact=>{const descriptors:RevocationSourceDescriptor[]=[{url:fact.source.url,mcpSourceId:mcpSourceId(fact.source)},...sourceMetadataUrls(fact.source).filter(url=>url!==fact.source.url).map(url=>({url}))];for(const municipality of registry.municipalities)if(municipality.id===bundle.cityId)for(const source of municipality.sources)if(source.url===fact.source.url)descriptors.push({municipalityId:municipality.id,registrySourceId:source.id,url:source.url});return !isRecordRevoked(revocations,{recordId:fact.id,municipalityId:bundle.cityId,sources:descriptors});})};
    servedRegistry={...registry,municipalities:registry.municipalities.map(city=>{
      const sourceIds=new Set(index.knowledge?.municipalities.find(item=>item.id===city.id)?.sources.map(source=>source.id)??[]);
      return {...city,sources:city.sources.filter(source=>sourceIds.has(source.id)),amt:city.amt&&isSourceRevoked(revocations,{url:city.amt.sourceUrl})?null:city.amt,administrativeEvidence:city.administrativeEvidence.filter(item=>!isSourceRevoked(revocations,{municipalityId:city.id,url:item.url})),identitySources:city.identitySources.filter(item=>!isSourceRevoked(revocations,{municipalityId:city.id,url:item.url})),seedDocuments:city.seedDocuments.filter(item=>sourceIds.has(item.sourceId)&&!isSourceRevoked(revocations,{municipalityId:city.id,registrySourceId:item.sourceId,url:item.url})&&item.evidence.every(evidence=>!isSourceRevoked(revocations,{url:evidence.url})))};
    })};
  }
  const sourceUrls=new Set<string>(feedSourceUrls);
  for(const feature of features)for(const source of feature.properties.sources){sourceUrls.add(source.url);if(source.snapshotUrl)sourceUrls.add(source.snapshotUrl);}
  for(const fact of bundle.facts)sourceUrls.add(fact.source.url);
  for(const topic of regional.topics)for(const municipality of topic.municipalities)for(const item of municipality.items)sourceUrls.add(item.url);
  for(const record of knowledge.records)for(const source of record.kind==='structured'?[record.source,...record.supportingSources]:record.sources)sourceUrls.add(source.url);
  const admitted:ReleasedData={bundle:servedBundle,manifest,dataManifest,publicationInputs,catalogue:maskedMetadata?.catalogue??catalogue,features:servedFeatures,feeds:maskedMetadata?.feeds??feeds,changes:servedChanges,regional:servedRegional,knowledge:servedKnowledge,registry:servedRegistry,coverage,servedCoverage:maskedMetadata?.coverage??null,knowledgeChanges,graphData:servedGraphData,index,graph:servedGraph,mode:options.mode,revocations,visibility};
  releaseSourceUrls.set(admitted,[...sourceUrls]);
  await recheckReleasePolicy(admitted,options.mode==='vm_candidate'?options.policyOptions:undefined);
  release=admitted;
  return admitted;
}
export function loadedRelease():ReleasedData {
  if(!release)throw Error('Release not loaded');
  return release;
}
export async function ensureRelease():Promise<ReleasedData> {
  const data=release??await (loading??=loadRelease());
  if(data.mode!=='sealed')throw Error('Default hosted access cannot reuse a VM candidate release');
  return recheckReleasePolicy(data);
}

export interface MaskedCoverage {
 schemaVersion:'stadtstack-district-read-coverage-v1';releaseId:string;maskIdentity:string;
 countMeaning:string;accounting:{servedRecords:number;withheldRecords:number;servedMunicipalities:number};
 municipalities:Array<{id:string;status:'served_records'|'no_served_records';documents:number;publishedRecords:number;datedStagedRecords:number;quarantinedRecords:number;servedTextModelRecords:number;servedStructuredRecords:number;withheldRecords:number;generation:{publishedRecords:number;textModelRecords:number;structuredRecords:number;meaning:string};sources:Array<{sourceId:string;kind:string;registryState:string;observedState:string;checkedAt:string|null;observedDocuments:number;servedRecords:number;meaning:string}>}>;
}
/** Separate qualified served-view metadata; never rewrites sealed provenance or civic changes. */
export function projectMaskedReleaseMetadata(base:ReleasedData,visibility:QueryVisibility):{catalogue:Catalogue;feeds:Record<string,CityFeed>;coverage:MaskedCoverage}{
 const mask=base.revocations;if(base.mode!=='sealed'||!mask||visibility.releaseId!==base.dataManifest.id||visibility.maskIdentity!==mask.artifactSha256)throw Error('Masked metadata requires the exact governed release/read-view identity');
 const blockedScopes=new Set<string>(),blockedUrls=new Set<string>();
 for(const descriptors of visibility.sourceDescriptorsByRecord.values())for(const descriptor of descriptors)if(isSourceRevoked(mask,descriptor)||descriptor.mcpSourceId&&visibility.withheldSourceIds.has(descriptor.mcpSourceId)){
  if(descriptor.municipalityId&&descriptor.registrySourceId)blockedScopes.add(JSON.stringify([descriptor.municipalityId,descriptor.registrySourceId]));
  if(descriptor.url&&!descriptor.municipalityId&&!descriptor.registrySourceId)blockedUrls.add(descriptor.url);
 }
 const allowed=(descriptor:RevocationSourceDescriptor)=>!isSourceRevoked(mask,descriptor)&&!(descriptor.municipalityId&&descriptor.registrySourceId&&blockedScopes.has(JSON.stringify([descriptor.municipalityId,descriptor.registrySourceId])))&&!(descriptor.url&&blockedUrls.has(descriptor.url));
 const visible=base.knowledge.records.filter(record=>visibility.visibleRecordIds.has(record.id)),features=base.features.filter(feature=>visibility.visibleRecordIds.has(feature.properties.id));
 const catalogue:Catalogue={...base.catalogue,cities:base.catalogue.cities.map(city=>({...city,sources:city.sources.filter(source=>allowed({municipalityId:city.id,registrySourceId:source.id,url:source.url})&&sourceMetadataUrls(source).every(url=>!isSourceRevoked(mask,{url}))).map(source=>{const {error:_raw,...safe}=source;const count=features.filter(feature=>feature.properties.cityId===city.id&&feature.properties.sources.some(item=>item.url===source.url||item.snapshotUrl===source.url)).length;return {...safe,publishedRecordCount:count,...(source.status==='failed'?{error:'Source unavailable in the original sealed observation'}:{})};})}))};
 const feeds:Record<string,CityFeed>={};
 for(const [cityId,feed] of Object.entries(base.feeds)){
  const sources=feed.sources.filter(source=>allowed({municipalityId:cityId,registrySourceId:source.id,url:source.url})&&(!source.pageUrl||allowed({municipalityId:cityId,registrySourceId:source.id,url:source.pageUrl}))),sourceIds=new Set(sources.map(source=>source.id));
  const items=feed.items.filter(item=>{const descriptors:RevocationSourceDescriptor[]=[{municipalityId:cityId,registrySourceId:item.sourceId,url:item.url}];if(item.locationSource){descriptors.push({municipalityId:cityId,registrySourceId:item.sourceId,url:item.locationSource.url});if(item.locationSource.geometrySourceUrl)descriptors.push({municipalityId:cityId,url:item.locationSource.geometrySourceUrl});}return sourceIds.has(item.sourceId)&&descriptors.every(allowed)&&!isRecordRevoked(mask,{recordId:item.id,municipalityId:cityId,sources:descriptors});});
  feeds[cityId]={...feed,sources,items};
 }
 const municipalities=base.coverage.municipalities.map(city=>{
  const records=visible.filter(record=>record.municipalityId===city.id),registry=base.registry.municipalities.find(item=>item.id===city.id)!;
  return {id:city.id,status:records.length?'served_records' as const:'no_served_records' as const,documents:city.documents,publishedRecords:records.length,datedStagedRecords:records.filter(record=>record.kind==='text_model'&&record.stageDate!==null).length,quarantinedRecords:city.quarantinedRecords,servedTextModelRecords:records.filter(record=>record.kind==='text_model').length,servedStructuredRecords:records.filter(record=>record.kind==='structured').length,withheldRecords:city.publishedRecords-records.length,generation:{publishedRecords:city.publishedRecords,textModelRecords:city.textModelRecords,structuredRecords:city.structuredRecords,meaning:'Immutable original publication counts, not current served-view counts'},sources:city.sources.filter(source=>{const original=registry.sources.find(item=>item.id===source.sourceId);return allowed({municipalityId:city.id,registrySourceId:source.sourceId,...(original?.url?{url:original.url}:{})})&&sourceMetadataUrls(original??{}).every(url=>!isSourceRevoked(mask,{url}));}).map(source=>({sourceId:source.sourceId,kind:source.kind,registryState:source.registryState,observedState:source.crawlState,checkedAt:source.checkedAt,observedDocuments:source.documentCount,servedRecords:records.filter(record=>record.kind==='structured'?record.source.id===source.sourceId||record.supportingSources.some(item=>item.id===source.sourceId):record.sources.some(item=>item.id===source.sourceId)).length,meaning:'Original source observation clock/count; served records are separately masked'}))};
 });
 return {catalogue,feeds,coverage:{schemaVersion:'stadtstack-district-read-coverage-v1',releaseId:base.dataManifest.id,maskIdentity:mask.artifactSha256,countMeaning:'Governed administrative withholding, not civic withdrawal, source absence, municipality performance or a new source assessment',accounting:{servedRecords:visible.length,withheldRecords:base.knowledge.records.length-visible.length,servedMunicipalities:municipalities.filter(city=>city.publishedRecords>0).length},municipalities}};
}
