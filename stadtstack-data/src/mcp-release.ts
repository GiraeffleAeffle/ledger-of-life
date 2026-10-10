import {createHash} from 'node:crypto';
import {z} from 'zod';
import {outDir} from './common.ts';
import {catalogueSchema,collectionSchema,type Catalogue,type Signal} from './schema.ts';
import {coreBundleSchema,type CoreBundle} from './core-schema.ts';
import {verifyDataRelease,requireReleaseFiles,readReleaseFile,type DataRelease} from './data-release.ts';
import {QueryIndex,regionalSchema,type Regional} from './mcp-query.ts';
import {validateKnowledgeRelease} from './district-schema.ts';
import {districtRegistrySchema} from './district-registry.ts';
import {districtCoverageSchema,validateDistrictCoverage,assertKnowledgeSlice} from './district-publication.ts';
import {changesSchema,type Changes} from './changes.ts';

export type ReleasedData={bundle:CoreBundle;manifest:Record<string,unknown>;dataManifest:DataRelease;catalogue:Catalogue;features:Signal[];changes:Record<string,Changes>;regional:Regional;index:QueryIndex};
let release:ReleasedData|undefined;
let loading:Promise<ReleasedData>|undefined;
export async function loadRelease(directory=outDir):Promise<ReleasedData> {
  const dataManifest=await verifyDataRelease(directory);
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
    changes[city.id]=changesSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,`cities/${city.id}/changes.json`)).toString('utf8')));
    if(collection.features.some(feature=>feature.properties.cityId!==city.id))throw Error('Released feature city mismatch');
    features.push(...collection.features);
  }
  const regional=regionalSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'regions/brandenburg-mol/topics.json')).toString('utf8')));
  requireReleaseFiles(dataManifest,['knowledge/registry.json','knowledge/records.json','knowledge/coverage.json']);
  const registry=districtRegistrySchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/registry.json')).toString('utf8')));
  const knowledge=validateKnowledgeRelease(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/records.json')).toString('utf8')),registry);
  const coverage=districtCoverageSchema.parse(JSON.parse((await readReleaseFile(directory,dataManifest,'knowledge/coverage.json')).toString('utf8')));
  validateDistrictCoverage(coverage,registry,knowledge.records);
  assertKnowledgeSlice(registry,knowledge.records);
  const index=new QueryIndex(dataManifest.id,dataManifest.generatedAt,features,regional,catalogue,{records:knowledge.records,municipalities:registry.municipalities,coverage});
  release={bundle,manifest,dataManifest,catalogue,features,changes,regional,index};
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
