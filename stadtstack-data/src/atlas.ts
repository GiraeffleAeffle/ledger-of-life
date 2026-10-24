import {signal,sourceFrom} from './common.ts';
import type {ResponseEvidence} from './common.ts';
import {assertPublicUrls,isPublicUrl,parseSourceDate} from './publication-quality.ts';
import type {Signal} from './schema.ts';
// This is public committed research about the local prototype, NOT a hosted Atlas API.
export const ATLAS_PUBLIC_PROVENANCE_URL='https://raw.githubusercontent.com/GiraeffleAeffle/ledger-of-life/26e1421270c67d6449afa8d4ddc908eff686595c/docs/research/STADTSTACK_ATLAS_AND_CCF_INTERFACES.md';
export type AtlasProject={id:string;title:string;category?:string;stage:string;summary:string;status:string;next?:string;unknowns?:string[];location?:{coordinates:[number,number];precision?:string};consultation?:{start?:string;end?:string;url?:string};milestones?:{date:string;kind:string;label:string;source:string}[];sources:{id?:string;title:string;url:string;locator?:string;retrievedAt?:string}[]};
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
