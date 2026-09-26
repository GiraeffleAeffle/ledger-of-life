import {cachedJson,signal,sourceFrom,sourceStatus} from './common.ts';
import type {City} from './cities.ts';
import type {Signal} from './schema.ts';
type Project={id:string;title:string;category?:string;stage:string;summary:string;status:string;next?:string;unknowns?:string[];location?:{coordinates:[number,number];precision?:string};consultation?:{start?:string;end?:string};latest?:{date?:string};reviewState?:string;sources:{title:string;url:string;locator?:string;retrievedAt?:string}[]};
type Atlas={asOf:string;projects:Project[];schemaVersion:string;municipalityId:string};
export async function collectAtlas(city:City){
 const url=`http://localhost:4317/api/atlas/${city.id}`,mapUrl=url+'/map';const e=await cachedJson<Atlas>(url,1800000);const m=await cachedJson<{schemaVersion:string;areas:{features:{geometry?:Signal['geometry'];properties?:{id?:string;precision?:string}}[]}}>(mapUrl,1800000);
 if(e.data.schemaVersion!=='atlas-city-read-model-v1'||m.data.schemaVersion!=='project-atlas-map-v1')throw Error('Unexpected atlas schema');
 const areas=new Map(m.data.areas.features.map(a=>[a.properties?.id,a]));const features=e.data.projects.map(p=>{
 const area=areas.get(p.id),polygon=area?.geometry&&['Polygon','MultiPolygon'].includes(area.geometry.type)?area.geometry:null;
 const geometry:Signal['geometry']=polygon??(p.location?{type:'Point',coordinates:p.location.coordinates}:null);const kind=p.stage==='construction'?'construction':p.stage==='consultation'?'consultation':'planning';
 const sources:Signal['properties']['sources']=p.sources.map(s=>({url:s.url,title:s.title,publisher:new URL(s.url).hostname,locator:s.locator??`atlas project ${p.id}; ${s.title}`,retrievedAt:s.retrievedAt??e.retrievedAt,sha256:null,snapshot:false,licence:'unknown',reuse:'facts_with_attribution' as const}));if(!sources.length)sources.push(sourceFrom(e,'Atlas project','Stadtstack Atlas',`projects[id=${p.id}]`));
 const ended=p.consultation?.end&&Date.parse(p.consultation.end)<Date.now();
 const status=ended?`Beteiligungsfrist endete am ${p.consultation!.end}; aktueller Verfahrensstand nicht bestätigt`:p.status;
 const nextStep=ended?`Nach Fristende: ${(p.next??'weitere Abwägung und Entscheidung').replace(/^Stellungnahmen bis [^;]+;[ ]*(anschließend[ ]*)?/i,'')}`:p.next??'Nächster Schritt nicht belegt.';
 return signal({id:`atlas:${p.id}`,cityId:city.id,kind,category:p.category??'',title:p.title,statement:p.summary,status,startDate:p.consultation?.start??null,endDate:p.consultation?.end??null,nextStep,unknowns:p.unknowns??[],scale:geometry?'neighbourhood':'city',geometryPrecision:polygon?'area':geometry?'approximate':'none',sources,extraction:{method:'structured'},reviewState:'candidate',asOf:e.data.asOf??e.retrievedAt},geometry);
 });return {features,sources:[sourceStatus('atlas','atlas','Stadtstack Atlas',url,'facts_with_attribution',e.retrievedAt),sourceStatus('atlas-map','atlas','Stadtstack Atlas',mapUrl,'facts_with_attribution',m.retrievedAt)]};
}
