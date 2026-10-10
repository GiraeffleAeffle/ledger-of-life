import {join} from 'node:path';
import {cities} from './cities.ts';
import {cacheDir,save} from './common.ts';
import {collectOparl} from './council.ts';

// Public-source collection only. It writes ignored cache evidence, never staging or published output.
// Run again with the same city to resume an explicit partial backfill, then use modified_since after completion.
const cityArgument=process.argv.indexOf('--city'),pageArgument=process.argv.indexOf('--pages');
const target=cityArgument<0?'all':process.argv[cityArgument+1],maxPages=pageArgument<0?50:Number(process.argv[pageArgument+1]);
if(!Number.isInteger(maxPages)||maxPages<1)throw Error('--pages must be a positive integer (per source list)');
const selected=cities.filter(city=>city.endpoint&&(target==='all'||city.id===target));
if(!selected.length)throw Error(`No configured council city ${target}`);
for(const city of selected){
 try{
  const result=await collectOparl(city,{maxPages,geocodeBudget:0});
  await save(join(cacheDir,'council-evidence',`${city.id}-collection.json`),JSON.stringify({cityId:city.id,collectedAt:new Date().toISOString(),recordCount:result.features.length,sources:result.sources},null,2));
  await save(join(cacheDir,'council-evidence',`${city.id}-signals.geojson`),JSON.stringify({type:'FeatureCollection',features:result.features}));
  console.log(JSON.stringify({cityId:city.id,records:result.features.length,sources:result.sources}));
  if(result.sources.some(source=>source.status==='failed'))process.exitCode=1;
 }catch(error){
  await save(join(cacheDir,'council-evidence',`${city.id}-collection.json`),JSON.stringify({cityId:city.id,collectedAt:new Date().toISOString(),state:'failed',reason:String(error)},null,2));
  console.error(`${city.id}: ${String(error)}`);process.exitCode=1;
 }
}
