import {readFile,copyFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {cities} from './cities.ts';
import {collectOparl} from './council.ts';
import {councilStorage} from './council-cache.ts';
import {collectGeodata} from './geodata.ts';
import {geoFeeds} from './geodata-registry.ts';
import {normalizeRetainedAtlasSignals,publicAtlasCatalogueSources,ATLAS_PUBLIC_PROVENANCE_URL} from './atlas.ts';
import type {AtlasProject} from './atlas.ts';
import {cacheDir,outDir,jsonFile,save,hash,cachedFetch} from './common.ts';
import {coreBundleSchema} from './core-schema.ts';
import {coreSignal,validateCore,validateCoreBytes} from './core.ts';
import type {Catalogue,FeatureCollection} from './schema.ts';
import {retainCouncilSnapshot} from './source-health.ts';

const {values:options}=parseArgs({options:{'atlas-register':{type:'string'},'evidence-cache':{type:'string'},cities:{type:'string'},'retain-city-snapshot':{type:'boolean',default:false}}});
const catalogue=await jsonFile<Catalogue>(join(outDir,'catalogue.json'));if(!catalogue)throw Error('A published starting catalogue is required');
const selected=options.cities?.split(',');
if(selected?.some(id=>!catalogue.cities.some(city=>city.id===id)))throw Error('Unknown selected publication city');
const core=coreBundleSchema.parse(await jsonFile(join(outDir,'core','strausberg-facts.json')));
// Only explicit, content-addressed public source/evaluation files may cross from an existing cache.
if(options['evidence-cache']){
 for(const fact of core.facts){
  for(const [folder,name] of [['pdf',fact.source.sha256+'.pdf'],['core-evidence',fact.verification.faithfulness.evidenceHash+'.json']]){
   await mkdir(join(cacheDir,folder),{recursive:true});
   await copyFile(join(options['evidence-cache'],folder,name),join(cacheDir,folder,name));
  }
 }
}
await validateCoreBytes(core);
const staging=join(cacheDir,'staging');
const diagnostics=[];
for(const city of catalogue.cities){
 const configured=cities.find(c=>c.id===city.id);if(!configured)throw Error(`Missing configured city ${city.id}`);
 const collection=await jsonFile<FeatureCollection>(join(outDir,'cities',city.id,'signals.geojson'));if(!collection)throw Error(`Missing published city ${city.id}`);
 const before=collection.features.length;
 const retained=options['retain-city-snapshot']?retainCouncilSnapshot(configured,collection.features,city.sources):null;
 if(retained){collection.features=retained.features;city.sources=retained.sources;}
 if(!selected||selected.includes(city.id)){
  if(configured.endpoint&&!options['retain-city-snapshot']){
   // Traverse the full inventory, not one interactive page budget. Every page is
   // checkpointed; interrupted runs resume and recently completed lists are reused.
   const council=await collectOparl(configured,{maxPages:10_000,geocodeBudget:0,reuseCompleteMs:6*60*60_000});
   // Never carry misbound old council rows through a refresh failure.
   if(council.sources.some(source=>source.status==='failed'||source.status==='not_checked')||!configured.councilBodyId)throw Error(`Council refresh incomplete for ${city.id}; inspect public cache/source diagnostics and resume`);
   const checkpoints=await Promise.all((['meeting','paper'] as const).map(kind=>councilStorage(configured.councilBodyId!,kind).load()));
   if(checkpoints.some(state=>!state||!state.backfillComplete||state.active||state.error))throw Error(`Council inventory traversal incomplete for ${city.id}; durable cursors retained for the next run`);
   collection.features=collection.features.filter(f=>!['council_paper','council_meeting'].includes(f.properties.kind));
   collection.features.push(...council.features);
   city.sources=city.sources.filter(source=>source.kind!=='council'&&!/^(?:ccf|oparl)/.test(source.id));city.sources.push(...council.sources);
  }
  for(const type of ['wfs','arcgis-rest'] as const){
   if(options['retain-city-snapshot'])continue;
   const configuredFeeds=geoFeeds.filter(feed=>feed.cityId===city.id&&feed.sourceType===type);if(!configuredFeeds.length)continue;
   const geodata=await collectGeodata(configured,type);
   if(geodata.sources.some(source=>source.status==='failed'))throw Error(`Geodata refresh failed for ${city.id}/${type}; no replacement publication made`);
   collection.features=collection.features.filter(f=>!configuredFeeds.some(feed=>f.properties.id.startsWith(feed.id+':')));collection.features.push(...geodata.features);
   city.sources=city.sources.filter(source=>!configuredFeeds.some(feed=>source.id.startsWith(feed.id+'-')));city.sources.push(...geodata.sources);
  }
  if(city.id==='strausberg'){
   if(options['atlas-register']){
    const bytes=await readFile(options['atlas-register']);
    const register=JSON.parse(bytes.toString('utf8')) as {schemaVersion:string;projects:AtlasProject[]};
    if(register.schemaVersion!=='stadtstack-project-register-v1'||!Array.isArray(register.projects))throw Error('Unexpected curated atlas register');
    const research=await cachedFetch(ATLAS_PUBLIC_PROVENANCE_URL);
    collection.features=normalizeRetainedAtlasSignals(collection.features,register.projects,research,hash(bytes));
    await save(join(cacheDir,'atlas','project-register.json'),bytes);
   }
   city.sources=publicAtlasCatalogueSources(city.sources);
  }
 }
 if(city.id==='strausberg'){
  const ids=new Set(core.facts.map(f=>f.id));collection.features=collection.features.filter(f=>!ids.has(f.properties.id));collection.features.push(...core.facts.map(coreSignal));validateCore(core,collection);
 }
 await save(join(staging,'cities',city.id,'signals.geojson'),JSON.stringify(collection));
 await save(join(staging,'cities',city.id,'feed.json'),await readFile(join(outDir,'cities',city.id,'feed.json')));
 diagnostics.push({cityId:city.id,before,staged:collection.features.length,retainedCitySnapshot:retained!==null,sourceIdentityQuarantines:retained?.quarantined??[],council:city.sources.filter(source=>source.kind==='council').map(source=>({id:source.id,status:source.status,recordCount:source.recordCount,coverage:source.coverage,bodyBinding:source.bodyBinding}))});
 const diagnostic=diagnostics.at(-1)!;console.log(JSON.stringify({...diagnostic,sourceIdentityQuarantines:diagnostic.sourceIdentityQuarantines.length}));
}
catalogue.generatedAt=new Date().toISOString();
catalogue.coreBundle={path:'core/strausberg-facts.json',version:core.version,manifestPath:'core/release-manifest.json'};
await save(join(staging,'catalogue.json'),JSON.stringify(catalogue));
await save(join(staging,'core','strausberg-facts.json'),JSON.stringify(core,null,2)+'\n');
await save(join(staging,'regions','brandenburg-mol','topics.json'),await readFile(join(outDir,'regions','brandenburg-mol','topics.json')));
await save(join(cacheDir,'quality-refresh.json'),JSON.stringify({generatedAt:catalogue.generatedAt,diagnostics},null,2)+'\n');
console.log('Quality staging prepared; publish applies all date, identity, provenance and core evidence gates.');
