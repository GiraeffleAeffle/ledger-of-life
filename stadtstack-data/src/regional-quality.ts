import {z} from 'zod';
import {hash} from './common.ts';
const item=z.object({title:z.string(),url:z.url(),date:z.string().nullable(),locator:z.string()}).passthrough();
const regional=z.object({schemaVersion:z.literal('stadtstack-regional-topics-v1'),generatedAt:z.string(),asOf:z.string(),coverage:z.record(z.string(),z.unknown()),topics:z.array(z.object({id:z.string(),municipalities:z.array(z.object({municipalityId:z.string(),items:z.array(item)}).passthrough())}).passthrough())}).passthrough();
export interface RegionalQuarantine {id:string;cityId:string;reason:string}
/** Unknown source dates are withheld from dated comparisons, never replaced by release time. */
export function normalizeRegionalPublication(input:unknown){
 const data=regional.parse(input),quarantined:RegionalQuarantine[]=[];
 let inputRecords=0,publishedRecords=0;
 data.topics=data.topics.flatMap(topic=>{
  topic.municipalities=topic.municipalities.flatMap(municipality=>{
   municipality.items=municipality.items.filter(item=>{
    inputRecords++;
    const date=item.date;
    if(!date||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==date.slice(0,10)){
     quarantined.push({id:`regional:${topic.id}:${municipality.municipalityId}:${hash(item.url+'\n'+item.locator).slice(0,16)}`,cityId:municipality.municipalityId,reason:'source_event_date_missing_or_invalid'});
     return false;
    }
    publishedRecords++;return true;
   });
   return municipality.items.length?[municipality]:[];
  });
  return topic.municipalities.length?[topic]:[];
 });
 data.coverage={...data.coverage,datedPublication:{inputRecords,publishedRecords,quarantinedRecords:quarantined.length,municipalities:new Set(data.topics.flatMap(t=>t.municipalities.map(m=>m.municipalityId))).size,singleMunicipalityTopics:data.topics.filter(t=>t.municipalities.length===1).map(t=>t.id),policy:'Only sourced complete event dates enter comparison; null/invalid dates are quarantined, never replaced by retrieval or release timestamps.'}};
 return {data,quarantined,inputRecords,publishedRecords};
}
