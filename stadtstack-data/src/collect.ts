import {join} from 'node:path';
import {cities} from './cities.ts';
import {cacheDir,cachedJson,jsonFile,save,sourceStatus,staleFetches} from './common.ts';
import {collectAtlas} from './atlas.ts';
import {collectOsm} from './osm.ts';
import {collectAutobahn} from './autobahn.ts';
import {collectCcf,collectOparl} from './council.ts';
import {collectGeodata} from './geodata.ts';
import {geoFeeds} from './geodata-registry.ts';
import {deduplicateCitySignals,duplicateStats} from './dedupe.ts';
import {collectFeeds} from './feeds.ts';
import type {Catalogue,FeatureCollection,Signal} from './schema.ts';
const target=process.argv.includes('--city')?process.argv[process.argv.indexOf('--city')+1]:'all';const selected=target==='all'?cities:cities.filter(c=>c.id===target);if(!selected.length)throw Error(`Unknown city ${target}`);
const old=await jsonFile<Catalogue>(join(cacheDir,'staging','catalogue.json'));const catalogue:Catalogue={schemaVersion:'stadtstack-signals-v1',generatedAt:new Date().toISOString(),publisher:'Stadtstack (independent derived factual summaries)',cities:target==='all'?[]:old?.cities.filter(c=>c.id!==target)??[]};
for(const city of selected){await collectFeeds(city);let features:Signal[]=[],sources:Catalogue['cities'][number]['sources']=[];
 try{
  const q=new URLSearchParams({q:`${city.name}, ${city.state}, Deutschland`,format:'json',limit:'1',polygon_geojson:'1'});
  const e=await cachedJson<{boundingbox:[string,string,string,string];lon:string;lat:string;osm_type?:string;osm_id?:number}[]>(`https://nominatim.openstreetmap.org/search?${q}`,365*86400000);
  const place=e.data[0];
  if(place){city.center=[Number(place.lon),Number(place.lat)];city.bbox=[Number(place.boundingbox[2]),Number(place.boundingbox[0]),Number(place.boundingbox[3]),Number(place.boundingbox[1])];if(place.osm_type==='relation'&&place.osm_id)city.osmRelation=place.osm_id;}
  sources.push(sourceStatus('nominatim','boundary','OpenStreetMap contributors',e.url,'open_licence',e.retrievedAt,'ok',undefined,'ODbL 1.0'));
 }catch(error){
  sources.push(sourceStatus('nominatim','boundary','OpenStreetMap contributors','https://nominatim.openstreetmap.org/','open_licence',new Date().toISOString(),'failed',String(error),'ODbL 1.0'));
 }
 const adapters:[string,()=>Promise<{features:Signal[];sources:Catalogue['cities'][number]['sources']}>][]=[];if(city.id==='strausberg')adapters.push(['atlas',()=>collectAtlas(city)]);adapters.push(['osm',()=>collectOsm(city)],['autobahn',()=>collectAutobahn(city)]);if(city.endpoint)adapters.push(['ccf',()=>collectCcf(city)],['oparl',()=>collectOparl(city)]);if(geoFeeds.some(f=>f.cityId===city.id&&f.sourceType==='wfs'))adapters.push(['wfs',()=>collectGeodata(city,'wfs')]);if(geoFeeds.some(f=>f.cityId===city.id&&f.sourceType==='arcgis-rest'))adapters.push(['arcgis-rest',()=>collectGeodata(city,'arcgis-rest')]);
 for(const [id,run] of adapters){
  const staleOffset=staleFetches.length;
  try{
   const result=await run();
   features.push(...result.features);
   sources.push(...result.sources);
   if(result.sources.some(s=>s.status==='failed')){
    const previous=await jsonFile<FeatureCollection>(join(cacheDir,'staging','cities',city.id,'signals.geojson'));
    const currentIds=new Set(result.features.map(f=>f.properties.id));
    const prefixes=id==='ccf'||id==='oparl'?['council:',`${id}:`]:id==='wfs'||id==='arcgis-rest'?geoFeeds.filter(f=>f.cityId===city.id&&f.sourceType===id).map(f=>`${f.id}:`):[`${id}:`];
    if(previous)features.push(...previous.features.filter(f=>prefixes.some(prefix=>f.properties.id.startsWith(prefix))&&!currentIds.has(f.properties.id)));
   }
   console.log(`${city.id}/${id}: ${result.features.length}`);
  }catch(error){
   console.error(`${city.id}/${id}: ${String(error)}`);
   const url=id==='atlas'?`http://localhost:4317/api/atlas/${city.id}`:id==='osm'?'https://overpass-api.de/api/interpreter':id==='autobahn'?'https://verkehr.autobahn.de/o/autobahn/':id==='ccf'?'https://github.com/komma-systems/ccf':id==='wfs'||id==='arcgis-rest'?geoFeeds.find(f=>f.cityId===city.id&&f.sourceType===id)?.url??'https://oparl.org/':city.endpoint??'https://oparl.org/';
   sources.push(sourceStatus(id,id,id,url,id==='osm'||id==='wfs'||id==='arcgis-rest'?'open_licence':id==='autobahn'?'unknown':'facts_with_attribution',new Date().toISOString(),'failed',String(error)));
   const previous=await jsonFile<FeatureCollection>(join(cacheDir,'staging','cities',city.id,'signals.geojson'));
   const prefixes=id==='ccf'||id==='oparl'?['council:',`${id}:`]:id==='wfs'||id==='arcgis-rest'?geoFeeds.filter(f=>f.cityId===city.id&&f.sourceType===id).map(f=>`${f.id}:`):[`${id}:`];
   if(previous)features.push(...previous.features.filter(f=>prefixes.some(prefix=>f.properties.id.startsWith(prefix))));
  }
  for(const failure of staleFetches.slice(staleOffset))sources.push(sourceStatus(`stale-${id}`,id,id,failure.url,'unknown',new Date().toISOString(),'stale',failure.error));
 }
 const before=duplicateStats(features),deduplicated=deduplicateCitySignals(features),after=duplicateStats(deduplicated);
 console.log(`${city.id}/duplicates: OParl URL ${before.councilUrl} -> ${after.councilUrl}; title+date+kind ${before.titleDate} -> ${after.titleDate}; OSM node/way ${before.osmNodeWay} -> ${after.osmNodeWay}`);
 const collection:FeatureCollection={type:'FeatureCollection',features:deduplicated};
 await save(join(cacheDir,'staging','cities',city.id,'signals.geojson'),JSON.stringify(collection));
 catalogue.cities.push({id:city.id,name:city.name,state:city.state,center:city.center,bbox:city.bbox,sources,feedUrl:`cities/${city.id}/feed.json`,temporalCoverage:{start:null,end:new Date().toISOString()},spatialCoverage:`bbox:${city.bbox.join(',')}`,licence:'Mixed; see each source'});
 await save(join(cacheDir,'staging','catalogue.json'),JSON.stringify(catalogue));
}
