import {XMLParser} from 'fast-xml-parser';
import {join} from 'node:path';
import {cachedFetch,hash,jsonFile,cacheDir,save,staleFetches} from './common.ts';
import type {City} from './cities.ts';
import {findEventVenue, type EventPoint, type EventLocationSource} from './event-venues.ts';

export interface FeedSource {id:string;kind:'press'|'events';publisher:string;url:string;licence:string;reuse:string;retrievedAt:string;status:string;pageUrl?:string}
export interface FeedItem {id:string;kind:'news'|'event';title:string;url:string;publisher:string;publishedAt:string;eventStart:string|null;publisherRecordId:string|null;venue:string|null;geometry:EventPoint|null;geometryPrecision:'exact'|'approximate'|'none';locationSource:EventLocationSource|null;sourceId:string;reuse:string;retrievedAt:string;reviewState:'auto_checked'}
export interface CityFeed {schemaVersion:'stadtstack-feed-v1';cityId:string;generatedAt:string;sources:FeedSource[];items:FeedItem[]}
type Config={id:string;kind:'press'|'events';publisher:string;url:string;pageUrl?:string};
const configs:Record<string,Config[]>={
 strausberg:[{id:'strausberg-press',kind:'press',publisher:'Stadt Strausberg',url:'https://www.stadt-strausberg.de/aktuelles/feed/'},{id:'strausberg-events',kind:'events',publisher:'Stadt Strausberg',url:'https://www.stadt-strausberg.de/veranstaltungen/feed/'}],
 muenster:[{id:'muenster-press',kind:'press',publisher:'Stadt Münster',url:'https://www.presse-service.de/rss.aspx?p=77'}],
 wuppertal:[{id:'wuppertal-press',kind:'press',publisher:'Stadt Wuppertal',url:'https://www.wuppertal.de/presse/aktuelle-meldungen.php?sp%3Aout=rss'}],
 dresden:[{id:'dresden-press',kind:'press',publisher:'Landeshauptstadt Dresden',url:'https://www.dresden.de/konfiguration/rss/rss-feed-pressemitteilungen.rss'}],
 koeln:[{id:'koeln-events',kind:'events',publisher:'koeln.de',url:'https://www.koeln.de/events/?ical=1'}],
 'castrop-rauxel':[{id:'castrop-rauxel-press',kind:'press',publisher:'Stadt Castrop-Rauxel',url:'https://www.castrop-rauxel.de/news',pageUrl:'https://www.castrop-rauxel.de/news'}],
 duesseldorf:[{id:'duesseldorf-press',kind:'press',publisher:'Landeshauptstadt Düsseldorf',url:'https://www.duesseldorf.de/aktuelles/news',pageUrl:'https://www.duesseldorf.de/aktuelles/news'}],
 freiburg:[{id:'freiburg-press',kind:'press',publisher:'Stadt Freiburg',url:'https://www.freiburg.de/pressemitteilungen/index.html',pageUrl:'https://www.freiburg.de/pressemitteilungen/index.html'}]
};
const xml=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',textNodeName:'#text',htmlEntities:true,processEntities:true});
const text=(v:any):string=>typeof v==='string'?v:typeof v==='number'?String(v):v?.['#text']??'';
const date=(v:any):string|null=>{const d=new Date(text(v));return Number.isNaN(d.getTime())?null:d.toISOString()};
function decode(v:string){return v.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").trim();}
function cleanUrl(value:string,base?:string):string{const url=new URL(value,base);for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key))url.searchParams.delete(key);return url.href;}
function canonicalId(value:string,link:string):string{const guid=decode(value)||link;return guid.startsWith('http://')||guid.startsWith('https://')?cleanUrl(guid):guid;}
function zonedDate(local:string,tz:string):Date{const wall=Date.parse(local+'Z');let guess=wall;for(let i=0;i<3;i++){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));const values=Object.fromEntries(parts.map(p=>[p.type,p.value]));const represented=Date.UTC(Number(values.year),Number(values.month)-1,Number(values.day),Number(values.hour),Number(values.minute),Number(values.second));guess+=wall-represented;}return new Date(guess);}
function decodeFeed(bytes:Uint8Array):string{const sample=new TextDecoder().decode(bytes.slice(0,300));const declared=sample.match(/<\?xml[^>]*encoding=["']([^"']+)/i)?.[1];try{return new TextDecoder(declared??'utf-8').decode(bytes);}catch{return new TextDecoder().decode(bytes);}}
export function parseSyndication(body:string,source:Config,retrievedAt:string,now=new Date()):FeedItem[]{
 const parsed=xml.parse(body),rss=parsed.rss?.channel?.item,atom=parsed.feed?.entry;
 const entries=rss?(Array.isArray(rss)?rss:[rss]):atom?(Array.isArray(atom)?atom:[atom]):[];
 const cutoff=now.getTime()-45*86400000;
 return entries.flatMap((entry:any)=>{
  const title=decode(text(entry.title)),links=Array.isArray(entry.link)?entry.link:[entry.link];
  const atomLink=links.find((candidate:any)=>candidate?.['@_rel']==='alternate')??links.find((candidate:any)=>candidate?.['@_href']);
  const rawLink=text(atomLink?.['@_href']??atomLink??entry.link),link=rawLink?cleanUrl(rawLink,source.url):'';
  const published=date(entry.pubDate??entry.updated??entry.published);
  if(!title||!link||!published||(source.kind==='press'&&Date.parse(published)<cutoff))return[];
  const guid=canonicalId(text(entry.guid??entry.id),link);
  const eventDate=source.kind==='events'?date(entry['event-date']??entry.eventDate??entry['eventStart']):null;
  const pair=text(entry['georss:point']).trim();
  const geoPoint=/^-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?$/.test(pair)?pair.split(/\s+/).map(Number):null;
  const lat=text(entry['geo:lat']).trim(),lon=text(entry['geo:long']).trim();
  const explicit=/^-?\d+(?:\.\d+)?$/.test(lat)&&/^-?\d+(?:\.\d+)?$/.test(lon);
  const latitude=explicit?Number(lat):geoPoint?.[0];
  const longitude=explicit?Number(lon):geoPoint?.[1];
  const geometry:EventPoint|null=source.kind==='events'&&latitude!==undefined&&longitude!==undefined&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180
   ?{type:'Point',coordinates:[longitude,latitude]}:null;
  const venue=source.kind==='events'?decode(text(entry.location??entry['event-location']))||null:null;
  return [{id:`${source.id}:${hash(guid)}`,kind:source.kind==='events'?'event':'news',title,url:link,publisher:source.publisher,publishedAt:published,eventStart:eventDate,publisherRecordId:source.id==='strausberg-events'&&/^https:\/\/www\.stadt-strausberg\.de\/\?post_type=rb_events&p=\d+$/.test(guid)?new URL(guid).searchParams.get('p'):null,venue,geometry,geometryPrecision:geometry?'exact':'none',locationSource:geometry||venue?{url:source.url,publisher:source.publisher,method:'syndication_geo' as const,retrievedAt}:null,sourceId:source.id,reuse:'facts_with_attribution',retrievedAt,reviewState:'auto_checked' as const}];
 });
}
export function parseICalendar(body:string,source:Config,retrievedAt:string,now=new Date()):FeedItem[]{
 const unfolded=body.replace(/\r?\n[ \t]/g,''),events=unfolded.split(/BEGIN:VEVENT\s*/i).slice(1).map(s=>s.split(/END:VEVENT/i)[0]);
 const from=now.getTime(),to=from+60*86400000;
 return events.flatMap(block=>{
  const fields=new Map<string,string>();
  for(const line of block.split(/\r?\n/)){const m=line.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/i);if(m)fields.set(m[1].toUpperCase(),m[2]);}
  const title=decode(fields.get('SUMMARY')??''),rawUrl=fields.get('URL')??'',start=fields.get('DTSTART');
  if(!title||!rawUrl||!start)return[];
  const url=cleanUrl(rawUrl),raw=block.match(/^DTSTART(?:;TZID=([^;:\r\n]+))?(?:;VALUE=DATE)?:(.*)$/im);
  if(!raw)return[];
  let d:Date;
  if(raw[2].endsWith('Z'))d=new Date(raw[2].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,'$1-$2-$3T$4:$5:$6Z'));
  else if(raw[2].includes('T')){const tz=raw[1]??'UTC';const local=raw[2].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/,'$1-$2-$3T$4:$5:$6');d=zonedDate(local,tz);}
  else d=new Date(raw[2].replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3T00:00:00Z'));
  if(Number.isNaN(d.getTime())||d.getTime()<from||d.getTime()>to)return[];
  const rawGeo=fields.get('GEO')?.trim(),geo=rawGeo&&/^-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?$/.test(rawGeo)?rawGeo.split(';').map(Number):null;
  const geometry:EventPoint|null=geo?.length===2&&geo.every(Number.isFinite)&&Math.abs(geo[0])<=90&&Math.abs(geo[1])<=180?{type:'Point',coordinates:[geo[1],geo[0]]}:null;
  const venue=fields.get('LOCATION')?.replace(/\\([nN])/g,' ').replace(/\\([,;\\])/g,'$1').trim()||null;
  const uid=canonicalId(fields.get('UID')??'',url);
  return [{id:`${source.id}:${hash(uid)}`,kind:'event',title,url,publisher:source.publisher,publishedAt:date(fields.get('DTSTAMP')??fields.get('LAST-MODIFIED'))??retrievedAt,eventStart:d.toISOString(),publisherRecordId:null,venue,geometry,geometryPrecision:geometry?'exact':'none',locationSource:geometry||venue?{url:source.url,publisher:source.publisher,method:'ics_geo' as const,retrievedAt}:null,sourceId:source.id,reuse:'facts_with_attribution',retrievedAt,reviewState:'auto_checked' as const}];
 });
}

/** Join only identical publisher record IDs; titles and proximity never prove identity. */
export function enrichFromOfficialCalendar(items:FeedItem[],body:string,cityId:string,sourceUrl:string,retrievedAt:string):FeedItem[]{
 const records=[...body.matchAll(/<article\b[^>]*class="[^"]*\brb-event-item-id-(\d+)-\d{4}-\d{2}-\d{2}\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi)].map(([,recordId,html])=>{
  const title=html.match(/<h3>([\s\S]*?)<\/h3>/i)?.[1]?.replace(/<[^>]+>/g,'').trim();
  const day=html.match(/<time\s+datetime="(\d{4}-\d{2}-\d{2})"/i)?.[1];
  const hour=html.match(/class="rb-event-item-time"[^>]*>[\s\S]*?(\d{1,2}:\d{2})/i)?.[1];
  const address=html.match(/<address\b[^>]*class="rb-event-item-location"[^>]*>([\s\S]*?)<\/address>/i)?.[1];
  const venue=address?decode(address.replace(/<br\s*\/?>/gi,', ').replace(/<[^>]+>/g,'').replace(/\s+/g,' ')):null;
  return {recordId,title: title?decode(title):null,day,hour,venue};
 });
 return items.map(item=>{
  if(item.kind!=='event'||item.sourceId!==`${cityId}-events`||!item.publisherRecordId)return item;
  const matching=records.filter(record=>record.recordId===item.publisherRecordId&&record.title===item.title);
  if(matching.length!==1)return item;
  const {day,hour,venue}=matching[0];
  const eventStart=day&&hour?zonedDate(`${day}T${hour}:00`,'Europe/Berlin').toISOString():item.eventStart;
  const location=venue?findEventVenue(cityId,venue):null;
  return {...item,eventStart,venue:venue??item.venue,geometry:location?.geometry??item.geometry,geometryPrecision:location?.geometryPrecision??item.geometryPrecision,
   locationSource:venue||day&&hour?{url:sourceUrl,publisher:'Stadt Strausberg',method:location?'venue_registry':'official_event',retrievedAt,...(location?{geometrySourceUrl:location.geometrySourceUrl,geometryLicence:location.geometryLicence,geometryAttribution:location.geometryAttribution}:{})}:item.locationSource};
 });
}

export async function collectFeeds(city:City):Promise<CityFeed>{
 const old=await jsonFile<CityFeed>(join(cacheDir,'staging','cities',city.id,'feed.json'));
 const sources:FeedSource[]=[],items:FeedItem[]=[];
 for(const config of configs[city.id]??[]){
  const retrievedAt=new Date().toISOString();
  if(config.pageUrl){sources.push({...config,licence:'unknown',reuse:'facts_with_attribution',retrievedAt,status:'not_available'});continue;}
  const staleBefore=staleFetches.length;
  try{
   const result=await cachedFetch(config.url,86400000,{timeout:15000}),isStale=staleFetches.slice(staleBefore).some(f=>f.url===config.url);
   const isIcal=config.url.toLowerCase().includes('ical=1'),body=isIcal?new TextDecoder('utf-8').decode(result.body):decodeFeed(result.body);
   const found=isIcal?parseICalendar(body,config,result.retrievedAt):parseSyndication(body,config,result.retrievedAt);
   if(isStale&&old){items.push(...old.items.filter(i=>i.sourceId===config.id));sources.push({...config,licence:'unknown',reuse:'facts_with_attribution',retrievedAt:result.retrievedAt,status:'stale'});}
   else{items.push(...found);sources.push({...config,licence:'unknown',reuse:'facts_with_attribution',retrievedAt:result.retrievedAt,status:isStale?'stale':'ok'});}
  }catch{const previous=old?.items.filter(i=>i.sourceId===config.id)??[];items.push(...previous);sources.push({...config,licence:'unknown',reuse:'facts_with_attribution',retrievedAt,status:previous.length?'stale':'failed'});}
 }
 // Older staged publications predate location fields. Keep their identities and mark unknowns explicitly.
 for(const item of items){item.publisherRecordId??=null;item.venue??=null;item.geometry??=null;item.geometryPrecision??='none';item.locationSource??=null;}
 if(city.id==='strausberg'){
  const months=['januar','februar','maerz','april','mai','juni','juli','august','september','oktober','november','dezember'];
  for(let offset=0;offset<3;offset++){
   const month=new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth()+offset,1));
   const year=month.getUTCFullYear(),number=month.getUTCMonth()+1;
   const url=`https://www.stadt-strausberg.de/veranstaltungen/${year}-${String(number).padStart(2,'0')}-01/${months[number-1]}-${year}/`;
   const id=`strausberg-calendar-${year}-${String(number).padStart(2,'0')}`,retrievedAt=new Date().toISOString();
   try{
    const staleBefore=staleFetches.length;
    const response=await cachedFetch(url,86400000,{timeout:15000});
    const enriched=enrichFromOfficialCalendar(items,decodeFeed(response.body),city.id,url,response.retrievedAt);
    items.splice(0,items.length,...enriched);
    sources.push({id,kind:'events',publisher:'Stadt Strausberg',url,licence:'unknown',reuse:'facts_with_attribution',retrievedAt:response.retrievedAt,status:staleFetches.slice(staleBefore).some(f=>f.url===url)?'stale':'ok'});
   }catch{
    sources.push({id,kind:'events',publisher:'Stadt Strausberg',url,licence:'unknown',reuse:'facts_with_attribution',retrievedAt,status:'failed'});
   }
  }
 }
 const feed:CityFeed={schemaVersion:'stadtstack-feed-v1',cityId:city.id,generatedAt:new Date().toISOString(),sources,items};
 await save(join(cacheDir,'staging','cities',city.id,'feed.json'),JSON.stringify(feed));
 return feed;
}
