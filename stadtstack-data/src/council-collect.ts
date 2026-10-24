import {realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {cities} from './cities.ts';
import {collectOparl} from './council.ts';
import {createCouncilAcquisition} from './council-cache.ts';
import {assertCivicPolicyAuthority,CIVIC_POLICY_AUTHORITY} from './civic-opt-out.ts';

/** Explicit one-city acquisition; no automatic broad backfill or legacy output. */
export async function councilCollectMain(argv=process.argv.slice(2)){
 const {values}=parseArgs({args:argv,options:{city:{type:'string'},pages:{type:'string'}},strict:true,allowPositionals:false});
 if(!values.city||values.city==='all')throw Error('Council collection requires one explicitly selected registered --city');
 const maxPages=values.pages===undefined?50:Number(values.pages),city=cities.find(item=>item.id===values.city&&item.endpoint);
 if(!city||!Number.isInteger(maxPages)||maxPages<1)throw Error('Invalid registered council city or page budget');
 const authority=await assertCivicPolicyAuthority(CIVIC_POLICY_AUTHORITY);
 if(authority.mode!=='codex-workstation-local'||process.platform!=='linux')throw Error('Council acquisition requires the authoritative Codex VM');
 const policy={...CIVIC_POLICY_AUTHORITY,authoritySha256:authority.authoritySha256},acquisition=createCouncilAcquisition(city,{policy});
 const result=await collectOparl(city,{maxPages,acquisition});
 await acquisition.persistCollection('collection.json',{cityId:city.id,collectedAt:new Date().toISOString(),recordCount:result.features.length,sources:result.sources});
 await acquisition.persistCollection('signals.geojson',{type:'FeatureCollection',features:result.features});
 const failed=result.sources.some(source=>source.status==='failed');
 console.log(JSON.stringify({cityId:city.id,records:result.features.length,sources:result.sources.length,state:failed?'failed':'collected'}));
 if(failed)process.exitCode=1;
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false))await councilCollectMain().catch(()=>{console.error('Council collection stopped; no source body or partial permission-denied result exported. Inspect governed acquisition metadata.');process.exitCode=1;});
