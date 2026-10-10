import {cities,type City} from './cities.ts';
import {bodyMatchesCity} from './council-oparl.ts';
import {canonicalOparlUrl} from './dedupe.ts';
import type {Catalogue,Signal,FeatureCollection} from './schema.ts';

type Source=Catalogue['cities'][number]['sources'][number];
function sourceRecords(source:Source,features:readonly Signal[]){
 if(source.id==='osm')return features.filter(f=>f.properties.id.startsWith('osm:'));
 if(source.kind==='atlas')return features.filter(f=>f.properties.id.startsWith('atlas:'));
 if(source.kind==='council'){
  const prefix=source.url.replace(/^http:/,'https:').split('?')[0].replace(/\/page\/\d+\/?$/,'').replace(/\/$/,'');
  return features.filter(f=>f.properties.kind===(source.id.includes('paper')?'council_paper':'council_meeting')&&f.properties.sources.some(s=>{
   const key=(s.snapshotUrl??s.url).replace(/^http:/,'https:').split('?')[0].replace(/\/page\/\d+\/?$/,'').replace(/\/$/,'');
   return key===prefix||source.id.startsWith('ccf')&&key.startsWith(prefix+'/');
  }));
 }
 return features.filter(f=>f.properties.sources.some(s=>s.url===source.url||s.snapshotUrl===source.url));
}
function observedDates(features:readonly Signal[]){
 const dates=features.map(f=>f.properties.startDate??(f.properties.temporalBasis==='observation'||f.properties.kind==='place'?f.properties.asOf:null)).filter((s):s is string=>Boolean(s)&&Number.isFinite(Date.parse(s!))).sort();
 return {start:dates[0]??null,end:dates.at(-1)??null};
}
/** Fill explicit snapshot diagnostics, never manufacture a source document/event date. */
export function sourceHealth(source:Source,features:readonly Signal[]):Source{
 const records=sourceRecords(source,features),observed=observedDates(records);
 const count=source.recordCount??records.length;
 const contextOnly=source.kind==='boundary';
 const status=source.status==='ok'&&source.recordCount===0?'ok':source.status==='ok'&&contextOnly?'context_only':source.status==='ok'&&count===0?'empty':source.status==='ok'&&records.length===0?'withheld':source.status??(count?'ok':'empty');
 const state=source.coverage?.state??(status==='failed'?'failed':status==='not_checked'?'not_checked':contextOnly?'not_checked':count?'partial':'empty');
 return {...source,status,recordCount:count,publishedRecordCount:records.length,
  coverage:source.coverage??{requestedStart:null,requestedEnd:null,observedStart:observed.start,observedEnd:observed.end,checkedAt:source.retrievedAt,state,
   reason:contextOnly?'Auxiliary boundary context, not emitted civic records; no event coverage claimed.':'Coverage derived from the retained dated snapshot; no complete requested history window was recorded.'},
  licenceEvidence:source.licenceEvidence??{url:source.url,checkedAt:source.retrievedAt,note:source.licence==='unknown'?'No upstream redistribution licence is established in this source metadata; attribution-linked factual summaries only, not an open-licence assertion.':`Recorded source licence: ${source.licence}; retain its attribution and source-specific obligations.`},
 };
}
export const cityTemporalCoverage=observedDates;

export interface RetainedCouncilSnapshot {features:Signal[];sources:Source[];quarantined:Array<{id:string;reason:string}>}
/** Offline identity repair only: never reads backfill caches or freshens source observations. */
export function retainCouncilSnapshot(city:City,features:Signal[],sources:Source[]):RetainedCouncilSnapshot{
 if(!city.councilBodyId)return {features,sources,quarantined:[]};
 const expected=canonicalOparlUrl(city.councilBodyId);
 const bodyOf=(value:string):string|null=>{
  const url=new URL(canonicalOparlUrl(value)),match=/^(.*\/(?:bodies|body)\/[^/]+)(?:\/|$)/i.exec(url.pathname);
  return match?url.origin+match[1]:null;
 };
 const quarantined:RetainedCouncilSnapshot['quarantined']=[];
 const retained=features.filter(feature=>{
  if(!['council_paper','council_meeting'].includes(feature.properties.kind))return true;
  const p=feature.properties,urls=p.sources.flatMap(source=>[source.url,...(source.snapshotUrl?[source.snapshotUrl]:[])]);
  if(p.id.startsWith('council:'))urls.push(decodeURIComponent(p.id.slice('council:'.length)));
  const bodies=new Set(urls.map(bodyOf).filter((body):body is string=>body!==null));
  if(bodies.size===1&&bodies.has(expected))return true;
  quarantined.push({id:p.id,reason:`Retained council evidence does not bind exclusively to approved Body ${expected}`});return false;
 });
 const corrected=sources.map(source=>{
  if(source.kind!=='council')return source;
  const observed=bodyOf(source.url),wrong=observed!==null&&observed!==expected;
  const before=sourceHealth(source,features),published=sourceRecords(source,retained),dates=observedDates(published);
  const {bodyBinding:_previousBinding,...metadata}=before;
  const status:'failed'|'partial'|'not_checked'=wrong?'failed':published.length?'partial':'not_checked';
  return {...metadata,status,publishedRecordCount:published.length,
   ...(!wrong&&published.length?{bodyBinding:{id:expected,name:city.councilBodyAliases?.[0]??city.name,cityId:city.id,matched:true,expectedNames:city.councilBodyAliases??[city.name]}}:{}),
   coverage:{requestedStart:null,requestedEnd:null,observedStart:dates.start,observedEnd:dates.end,checkedAt:source.coverage?.checkedAt??source.retrievedAt,state:status,
    reason:wrong?`Retained source belongs to ${observed}, not ${expected}; its city records are quarantined. No replacement backfill used.`:`Existing published snapshot retained; identity checked against the pinned Body and retained source URLs, not a new request. ${quarantined.length} city council records withheld for missing/foreign binding. No new history window or upstream-empty claim.`}
  };
 });
 return {features:retained,sources:corrected,quarantined};
}
export function assertSourceHealth(catalogue:Catalogue,collections?:Record<string,FeatureCollection>){
 for(const city of catalogue.cities){
  const configured=cities.find(c=>c.id===city.id);
  for(const source of city.sources){
   if(source.recordCount===undefined||!source.coverage||!source.licenceEvidence)throw Error(`Missing source diagnostics: ${city.id}/${source.id}`);
   if(source.status==='ok'&&(source.recordCount===0||source.publishedRecordCount===0))throw Error(`Source claims success with zero records: ${city.id}/${source.id}`);
   const binding=source.bodyBinding;
   if(source.kind==='council'&&source.status!=='failed'&&source.status!=='not_checked'&&!binding)throw Error(`Missing council municipality binding: ${city.id}/${source.id}`);
   if(binding&&(!configured||!binding.matched||binding.cityId!==city.id||!bodyMatchesCity(binding.name,configured)||(configured.councilBodyId&&canonicalOparlUrl(binding.id)!==canonicalOparlUrl(configured.councilBodyId))))throw Error(`Council municipality binding mismatch: ${city.id}/${source.id}`);
  }
  if(configured?.councilBodyId&&collections?.[city.id]){
   const body=canonicalOparlUrl(configured.councilBodyId)+'/';
   for(const feature of collections[city.id].features){
    if(!['council_paper','council_meeting'].includes(feature.properties.kind))continue;
    if(!feature.properties.id.startsWith('council:'))throw Error(`Noncanonical council object identity: ${city.id}`);
    const objectUrl=canonicalOparlUrl(decodeURIComponent(feature.properties.id.slice('council:'.length)));
    if(/\/bodies\/[^/]+(?:\/|$)/i.test(new URL(objectUrl).pathname)&&!objectUrl.startsWith(body))throw Error(`Council object belongs to another body: ${city.id}`);
   }
  }
 }
}
