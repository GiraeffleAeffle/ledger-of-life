import {cachedJson,cachedFetch,signal,sourceFrom,sourceStatus} from './common.ts';
import type {ResponseEvidence} from './common.ts';
import {assertPublicUrls,isPublicUrl,parseSourceDate} from './publication-quality.ts';
import type {City} from './cities.ts';
import type {Signal} from './schema.ts';
// This is public committed research about the local prototype, NOT a hosted Atlas API.
export const ATLAS_PUBLIC_PROVENANCE_URL='https://raw.githubusercontent.com/GiraeffleAeffle/ledger-of-life/26e1421270c67d6449afa8d4ddc908eff686595c/docs/research/STADTSTACK_ATLAS_AND_CCF_INTERFACES.md';
export type AtlasProject={id:string;title:string;category?:string;stage:string;summary:string;status:string;next?:string;unknowns?:string[];location?:{coordinates:[number,number];precision?:string};consultation?:{start?:string;end?:string;url?:string};milestones?:{date:string;kind:string;label:string;source:string}[];sources:{id?:string;title:string;url:string;locator?:string;retrievedAt?:string}[]};
type Atlas={asOf:string;projects:AtlasProject[];schemaVersion:string;municipalityId:string};
/** Only source-linked recorded events, never target dates, latest/asOf or retrieval timestamps. */
export function atlasEventDate(project:AtlasProject):{date:string;sourceId?:string;label:string}|null{
 const consultation=parseSourceDate(project.consultation?.start);
 if(consultation&&project.consultation?.url&&isPublicUrl(project.consultation.url))return {date:consultation,label:'consultation.start'};
 const dated=(project.milestones??[]).flatMap(m=>{
  const date=parseSourceDate(m.date);
  return date&&m.kind==='recorded'&&project.sources.some(s=>s.id===m.source&&isPublicUrl(s.url))?[{date,sourceId:m.source,label:m.label}]:[];
 }).sort((a,b)=>b.date.localeCompare(a.date));
 return dated[0]??null;
}
/** Refresh committed signals from the curated register without depending on the private UI. */
export function normalizeRetainedAtlasSignals(features:Signal[],projects:AtlasProject[],research:ResponseEvidence,registerSha256:string):Signal[]{
 assertPublicUrls(features);assertPublicUrls({url:research.url});
 const byId=new Map(projects.map(p=>[`atlas:${p.id}`,p]));
 return features.map(feature=>{
  const p=byId.get(feature.properties.id);if(!p)return feature;
  const event=atlasEventDate(p),eventSource=p.sources.find(s=>s.id===event?.sourceId);
  const {version:_,...properties}=feature.properties;
  const sources=properties.sources.map(s=>({...s,locator:s.locator+(event&&((eventSource&&s.url===eventSource.url)||event.label==='consultation.start'&&s.url===p.consultation?.url)?`; sourced event ${event.date}: ${event.label}`:'')}));
  const eventUrl=eventSource?.url??(event?.label==='consultation.start'?p.consultation?.url:undefined);
  if(event&&eventUrl&&!sources.some(s=>s.url===eventUrl))sources.push({url:eventUrl,title:eventSource?.title??'Public consultation',publisher:new URL(eventUrl).hostname,locator:`source-linked recorded event ${event.date}: ${event.label}`,retrievedAt:research.retrievedAt,sha256:null,snapshot:false,licence:'unknown',reuse:'facts_with_attribution'});
  sources.push(sourceFrom(research,'Committed Atlas interface research (not a hosted API)','Stadtstack research',`Atlas method provenance; local curated register SHA-256 ${registerSha256}; project ${p.id}. Register hash describes local derivation bytes, not the public research document or primary documents. This source sha256 hashes only fetched public research bytes.`));
  return signal({...properties,startDate:event?.date??parseSourceDate(properties.startDate),endDate:parseSourceDate(p.consultation?.end)??parseSourceDate(properties.endDate),temporalBasis:'source_event',sources,unknowns:[...properties.unknowns,...(event&&event.label!=='consultation.start'?['Datum bezeichnet den jüngsten quellengebundenen dokumentierten Vorgang, keinen bestätigten Baubeginn.']:[])]},feature.geometry);
 });
}

/** Exact known local catalogue entries only: replacement is method provenance, never an API claim. */
export function publicAtlasCatalogueSources<T extends {id:string;url:string}>(sources:T[]):T[]{
 return sources.map(s=>(s.id==='atlas'||s.id==='atlas-map')&&/^http:\/\/localhost:4317\/api\/atlas\/[a-z0-9-]+(?:\/map)?$/.test(s.url)?{...s,url:ATLAS_PUBLIC_PROVENANCE_URL}:s);
}
export async function collectAtlas(city:City){
 const localUrl=`http://localhost:4317/api/atlas/${city.id}`;
 const e=await cachedJson<Atlas>(localUrl,1800000),m=await cachedJson<{schemaVersion:string;areas:{features:{geometry?:Signal['geometry'];properties?:{id?:string;precision?:string;source?:string}}[]}}>(localUrl+'/map',1800000);
 if(e.data.schemaVersion!=='atlas-city-read-model-v1'||m.data.schemaVersion!=='project-atlas-map-v1')throw Error('Unexpected atlas schema');
 assertPublicUrls(e.data.projects.map(p=>({sources:p.sources,consultation:p.consultation})));
 const research=await cachedFetch(ATLAS_PUBLIC_PROVENANCE_URL);
 const areas=new Map(m.data.areas.features.map(a=>[a.properties?.id,a]));
 const features=e.data.projects.map(p=>{
  const area=areas.get(p.id),polygon=area?.geometry&&['Polygon','MultiPolygon'].includes(area.geometry.type)?area.geometry:null;
  const geometry:Signal['geometry']=polygon??(p.location?{type:'Point',coordinates:p.location.coordinates}:null),kind=p.stage==='construction'?'construction':p.stage==='consultation'?'consultation':'planning';
  const event=atlasEventDate(p);
  const sources:Signal['properties']['sources']=p.sources.filter(s=>isPublicUrl(s.url)).map(s=>({url:s.url,title:s.title,publisher:new URL(s.url).hostname,locator:`${s.locator??`atlas project ${p.id}; ${s.title}`}${event&&event.sourceId&&event.sourceId===s.id?`; recorded milestone ${event.date}: ${event.label}`:''}`,retrievedAt:s.retrievedAt??e.retrievedAt,sha256:null,snapshot:false,licence:'unknown',reuse:'facts_with_attribution' as const}));
  if(p.consultation?.url&&isPublicUrl(p.consultation.url)&&!sources.some(s=>s.url===p.consultation!.url))sources.push({url:p.consultation.url,title:'Public consultation',publisher:new URL(p.consultation.url).hostname,locator:`atlas project ${p.id}; consultation.start=${p.consultation.start??'missing'}; consultation.end=${p.consultation.end??'missing'}`,retrievedAt:e.retrievedAt,sha256:null,snapshot:false,licence:'unknown',reuse:'facts_with_attribution'});
  else if(event?.label==='consultation.start')for(const s of sources)if(s.url===p.consultation?.url)s.locator+=`; consultation.start=${event.date}; consultation.end=${p.consultation.end??'missing'}`;
  sources.push(sourceFrom(research,'Committed Atlas interface research (not a hosted API)','Stadtstack research',`Atlas research method and interfaces; local project ${p.id}; local read-model SHA-256 ${e.sha256}; local map SHA-256 ${m.sha256}. These two hashes describe local derivation bytes, not upstream primary documents. This source sha256 hashes only the fetched public research document.`));
  const ended=p.consultation?.end&&Date.parse(p.consultation.end)<Date.now();
  const status=ended?`Beteiligungsfrist endete am ${p.consultation!.end}; aktueller Verfahrensstand nicht bestätigt`:p.status;
  const nextStep=ended?`Nach Fristende: ${(p.next??'weitere Abwägung und Entscheidung').replace(/^Stellungnahmen bis [^;]+;[ ]*(anschließend[ ]*)?/i,'')}`:p.next??'Nächster Schritt nicht belegt.';
  return signal({id:`atlas:${p.id}`,cityId:city.id,kind,temporalBasis:'source_event',category:p.category??'',title:p.title,statement:p.summary,status,startDate:event?.date??null,endDate:parseSourceDate(p.consultation?.end),nextStep,unknowns:[...(p.unknowns??[]),...(event&&event.label!=='consultation.start'?['Datum bezeichnet den jüngsten quellengebundenen dokumentierten Vorgang, keinen bestätigten Baubeginn.']:[])],scale:geometry?'neighbourhood':'city',geometryPrecision:polygon?'area':geometry?'approximate':'none',sources,extraction:{method:'structured'},reviewState:'candidate',asOf:e.data.asOf??e.retrievedAt},geometry);
 });
 const evidence={url:ATLAS_PUBLIC_PROVENANCE_URL,checkedAt:research.retrievedAt,note:'Independent local research preview; no general Atlas dataset/municipal geometry licence established. Primary-document rights remain unknown. Public research is interface/method provenance, not a hosted Atlas endpoint.'};
 return {features,sources:[{...sourceStatus('atlas','atlas','Stadtstack Atlas research',ATLAS_PUBLIC_PROVENANCE_URL,'facts_with_attribution',e.retrievedAt,features.length?'ok':'empty'),recordCount:features.length,licenceEvidence:evidence,coverage:{requestedStart:null,requestedEnd:null,observedStart:features.map(f=>f.properties.startDate).filter((d):d is string=>d!==null).sort()[0]??null,observedEnd:features.map(f=>f.properties.startDate).filter((d):d is string=>d!==null).sort().at(-1)??null,checkedAt:e.retrievedAt,state:features.length?'partial' as const:'empty' as const,reason:'Curated local Atlas preview, not a complete municipality inventory; undated signals require publication quarantine.'}},{...sourceStatus('atlas-map','atlas','Stadtstack Atlas research',ATLAS_PUBLIC_PROVENANCE_URL,'facts_with_attribution',m.retrievedAt,m.data.areas.features.length?'ok':'empty'),recordCount:m.data.areas.features.length,licenceEvidence:evidence}]};
}
