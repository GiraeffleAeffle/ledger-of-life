import {createHash} from 'node:crypto';
import {z} from 'zod';
import {governedReleaseDirectory} from './governed-release-directory.ts';
import {catalogueSchema,collectionSchema,type Catalogue,type Signal} from './schema.ts';
import {coreBundleSchema,type CoreBundle} from './core-schema.ts';
import {verifyDataRelease,requireReleaseFiles,readReleaseFile,type DataRelease} from './data-release.ts';
import {QueryIndex,regionalSchema,type Regional,type KnowledgeQueryData} from './mcp-query.ts';
import {validateKnowledgeRelease} from './district-schema.ts';
import {districtRegistrySchema} from './district-registry.ts';
import {districtCoverageSchema,validateDistrictCoverage,assertKnowledgeSlice} from './district-publication.ts';
import {changesSchema,validateChanges,signalChangeRecord,knowledgeChangeRecord,type Changes} from './changes.ts';
import {GraphIndex} from './district-graph-query.ts';
import {publicationInputsSchema,verifyPublicationPolicyReceipts,requiredPublicationStaging,type PublicationInputs} from './district-publication-inputs.ts';
import {loadGovernedRevocations} from './mcp-revocation-config.ts';
import {isSourceRevoked,type VerifiedRevocations} from './civic-revocations.ts';
import {administrativeView} from './mcp-revocation-view.ts';
import {visibleSignals,visibleRegional,visibleCatalogue,visibleCore,visibleChanges} from './mcp-read-view.ts';

export type ReleaseLoadOptions={mode:'sealed';revocations?:VerifiedRevocations};
export type ReleasedData={bundle:CoreBundle;manifest:Record<string,unknown>;dataManifest:DataRelease;publicationInputs:PublicationInputs;catalogue:Catalogue;features:Signal[];changes:Record<string,Changes>;regional:Regional;index:QueryIndex;graph:GraphIndex;mode:'sealed';revocations:VerifiedRevocations};
let release:ReleasedData|undefined;
let loading:Promise<ReleasedData>|undefined;
const readViews=new WeakMap<ReleasedData,ReleasedData>();
/** Materialized once per immutable startup snapshot, including injected server releases. */
export function prepareReleaseReadView(input:ReleasedData,knowledge:KnowledgeQueryData|undefined=input.index?.knowledge):ReleasedData {
  const cached=readViews.get(input);if(cached&&cached.revocations===input.revocations)return cached;
  const view=administrativeView(input.dataManifest.id,input.revocations);
  if(input.mode!=='sealed')throw Error('Hosted MCP requires a sealed publication');
  if(input.graph.administrativeView?.viewId!==view.viewId)throw Error('Graph administrative read-view mismatch');
  const index=input.index.administrativeView?.viewId===view.viewId?input.index:new QueryIndex(input.dataManifest.id,input.dataManifest.generatedAt,input.features,input.regional,input.catalogue,knowledge,input.revocations);
  const features=visibleSignals(input.features,input.revocations);
  const output={...input,index,features,regional:visibleRegional(input.regional,input.revocations),catalogue:visibleCatalogue(input.catalogue,features,input.revocations),bundle:visibleCore(input.bundle,input.features,input.revocations),changes:visibleChanges(input.changes,input.features,knowledge,input.revocations)};
  readViews.set(input,output);readViews.set(output,output);
  return output;
}
export async function loadRelease(directory=governedReleaseDirectory(),options:ReleaseLoadOptions={mode:'sealed'}):Promise<ReleasedData> {
  const dataManifest=await verifyDataRelease(directory);
  const revocations=options.revocations??await loadGovernedRevocations(dataManifest.id);
  if(revocations.releaseId!==dataManifest.id)throw Error('Sealed revocation release identity mismatch');
  isSourceRevoked(revocations,{}); // Require the verified runtime brand, not caller-shaped metadata.
  const bytes=await readReleaseFile(directory,dataManifest,'core/strausberg-facts.json');
  const bundle=coreBundleSchema.parse(JSON.parse(bytes.toString('utf8')));
  const sha=z.string().regex(/^[a-f0-9]{64}$/);
  const manifest=z.object({schemaVersion:z.literal('stadtstack-core-release-v1'),bundlePath:z.literal('core/strausberg-facts.json'),bundleSha256:sha,bundleVersion:sha,corpus:z.object({fullPath:z.literal('cities/strausberg/signals.geojson'),fullSha256:sha}).passthrough()}).passthrough().parse(JSON.parse((await readReleaseFile(directory,dataManifest,'core/release-manifest.json')).toString('utf8')));
  if(createHash('sha256').update(bytes).digest('hex')!==manifest.bundleSha256||bundle.version!==manifest.bundleVersion)throw Error('Core bundle release mismatch');
  const corpus=await readReleaseFile(directory,dataManifest,manifest.corpus.fullPath);
  if(createHash('sha256').update(corpus).digest('hex')!==manifest.corpus.fullSha256)throw Error('Core corpus release mismatch');
  const catalogue=catalogueSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'catalogue.json')).toString('utf8')));
  const features:Signal[]=[],changes:Record<string,Changes>={};
  for(const city of catalogue.cities) {
    if(!/^[a-z0-9-]{1,80}$/.test(city.id))throw Error('Invalid released city id');
    requireReleaseFiles(dataManifest,[`cities/${city.id}/signals.geojson`,`cities/${city.id}/signals.min.geojson`,`cities/${city.id}/changes.json`,...(city.feedUrl?[city.feedUrl]:[])]);
    const collectionBytes=city.id==='strausberg'?corpus:await readReleaseFile(directory,dataManifest,`cities/${city.id}/signals.geojson`);
    const collection=collectionSchema.parse(JSON.parse(collectionBytes.toString('utf8')));
    changes[city.id]=validateChanges(JSON.parse((await readReleaseFile(directory,dataManifest,`cities/${city.id}/changes.json`)).toString('utf8')),collection.features.map(signalChangeRecord));
    if(changes[city.id].snapshots.some(snapshot=>snapshot.cityId!==city.id||snapshot.recordType!=='signal')||changes[city.id].events.some(event=>event.cityId!==city.id||event.recordType!=='signal'))throw Error('Released city change scope mismatch');
    if(collection.features.some(feature=>feature.properties.cityId!==city.id))throw Error('Released feature city mismatch');
    features.push(...collection.features);
  }
  const regional=regionalSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'regions/brandenburg-mol/topics.json')).toString('utf8')));
  requireReleaseFiles(dataManifest,['knowledge/registry.json','knowledge/records.json','knowledge/coverage.json','knowledge/graph.json','knowledge/changes.json','knowledge/publication-inputs.json']);
  const registry=districtRegistrySchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/registry.json')).toString('utf8')));
  const knowledgeBytes=await readReleaseFile(directory,dataManifest,'knowledge/records.json');
  const knowledge=validateKnowledgeRelease(JSON.parse(knowledgeBytes.toString('utf8')),registry);
  const knowledgeChanges=validateChanges(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/changes.json')).toString('utf8')),knowledge.records.map(knowledgeChangeRecord));
  const municipalityIds=new Set(registry.municipalities.map(city=>city.id));
  for(const cityId of municipalityIds)changes[cityId]??={schemaVersion:'stadtstack-changes-v2',generatedAt:dataManifest.generatedAt,snapshots:[],events:[]};
  for(const snapshot of knowledgeChanges.snapshots){
    if(snapshot.recordType!=='knowledge'||!municipalityIds.has(snapshot.cityId))throw Error('Released knowledge snapshot scope mismatch');
    changes[snapshot.cityId].snapshots.push(snapshot);
  }
  for(const event of knowledgeChanges.events){
    if(event.recordType!=='knowledge'||!municipalityIds.has(event.cityId))throw Error('Released knowledge change scope mismatch');
    changes[event.cityId].events.push(event);
  }
  for(const [cityId,feed] of Object.entries(changes))changes[cityId]=changesSchema.parse({...feed,generatedAt:dataManifest.generatedAt,snapshots:feed.snapshots.sort((a,b)=>a.recordType.localeCompare(b.recordType)),events:feed.events.sort((a,b)=>a.recordType.localeCompare(b.recordType)||a.id.localeCompare(b.id)||a.kind.localeCompare(b.kind))});
  const publicationInputs=publicationInputsSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/publication-inputs.json')).toString('utf8')));
  if(JSON.stringify(publicationInputs.staging.map(member=>member.path))!==JSON.stringify(requiredPublicationStaging(catalogue.cities.map(city=>city.id))))throw Error('Release publication input inventory mismatch');
  verifyPublicationPolicyReceipts(publicationInputs,knowledge.records.map(record=>record.id));
  for(const path of ['knowledge/registry.json','knowledge/records.json','knowledge/coverage.json']){
    const member=publicationInputs.staging.find(member=>member.path===path)!,released=dataManifest.files.find(member=>member.path===path)!;
    if(member.sha256!==released.sha256||member.bytes!==released.bytes)throw Error('Release knowledge differs from its publication input binding');
  }
  const coverage=districtCoverageSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/coverage.json')).toString('utf8')));
  validateDistrictCoverage(coverage,registry,knowledge.records);
  assertKnowledgeSlice(registry,knowledge.records);
  const graph=new GraphIndex(dataManifest.id,JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/graph.json')).toString('utf8')),knowledgeBytes,undefined,revocations);
  const queryKnowledge={records:knowledge.records,municipalities:registry.municipalities,coverage};
  const index=new QueryIndex(dataManifest.id,dataManifest.generatedAt,features,regional,catalogue,queryKnowledge,revocations);
  release=prepareReleaseReadView({bundle,manifest,dataManifest,publicationInputs,catalogue,features,changes,regional,index,graph,mode:'sealed',revocations},queryKnowledge);
  return release;
}
export function loadedRelease():ReleasedData {
  if(!release)throw Error('Release not loaded');
  return release;
}
export async function ensureRelease():Promise<ReleasedData> {
  if(release)return release;
  loading??=loadRelease();
  return loading;
}
