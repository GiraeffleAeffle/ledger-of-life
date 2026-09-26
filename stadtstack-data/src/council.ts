import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cachedJson,cacheDir,hash,jsonFile,save,signal,sourceFrom,sourceStatus} from './common.ts';
import {councilId} from './dedupe.ts';
import type {City} from './cities.ts';
import type {Signal} from './schema.ts';
type OparlRecord={id:string;name?:string;title?:string;text?:string;description?:string;reference?:string;date?:string;start?:string;end?:string;modified?:string;consultation?:{role?:string}[];auxiliaryFile?:{mimeType?:string;downloadUrl?:string;name?:string}[];mainFile?:{mimeType?:string;downloadUrl?:string;name?:string};location?:{description?:string};};
type Archive={source_id:string;record_type:'paper'|'meeting';modified_at:string;deleted_at?:string|null;data:OparlRecord};
const cutoff=Date.now()-60*86400000;const maxPages=2;
async function ensureCcf(){
 const folder=join(cacheDir,'ccf'),stamp=join(cacheDir,'ccf-fetched.json');
 const fetched=await jsonFile<{at:string}>(stamp);
 if(existsSync(join(folder,'.git'))&&fetched&&Date.now()-Date.parse(fetched.at)<43200000)return;
 const args=existsSync(join(folder,'.git'))?['-C',folder,'pull','--ff-only']:['clone','--depth','1','https://github.com/komma-systems/ccf.git',folder];
 const run=spawnSync('git',args,{encoding:'utf8',timeout:90000});
 if(run.status!==0)throw Error(`CCF git fetch failed: ${run.stderr.slice(-300)}`);
 await save(stamp,JSON.stringify({at:new Date().toISOString()}));
}
let lastNominatim=0;
export async function geocode(city:City,title:string):Promise<[number,number]|undefined>{const match=title.match(/(?:[A-ZÄÖÜ][\p{L}ß-]{3,}(?:straße|strasse|weg|platz|allee|gasse|ring)|(?:Straße|Platz|Weg)\s+[\p{L}ß-]{3,})/iu);if(!match)return;const query=new URLSearchParams({q:`${match[0]}, ${city.name}, Deutschland`,format:'json',limit:'1',countrycodes:'de'});const url=`https://nominatim.openstreetmap.org/search?${query}`;const wait=Math.max(0,1100-(Date.now()-lastNominatim));if(wait){const {promise,resolve}=Promise.withResolvers<void>();setTimeout(resolve,wait);await promise;}lastNominatim=Date.now();try{const e=await cachedJson<{lon:string;lat:string}[]>(url,365*86400000,{timeout:10000});const p=e.data[0];if(p){const lon=Number(p.lon),lat=Number(p.lat);if(lon>city.bbox[0]&&lon<city.bbox[2]&&lat>city.bbox[1]&&lat<city.bbox[3])return [lon,lat];}}catch{}return;}
function isRecent(record:OparlRecord,kind:'paper'|'meeting'){const date=Date.parse((kind==='meeting'?record.start:record.date)??record.modified??'');return Number.isFinite(date)&&date>=cutoff;}
async function convert(city:City,record:OparlRecord,kind:'paper'|'meeting',e:{body:Uint8Array;retrievedAt:string;sha256:string;url:string},limitGeocode:{remaining:number}):Promise<Signal|undefined>{
 if(!record.id||!isRecent(record,kind))return;
 const title=(record.name??record.title??'Unbenannter Vorgang').slice(0,450),date=kind==='meeting'?record.start:record.date;
 const publicText=`${title} ${(record.text??record.description??'').slice(0,1000)}`;
 let point:[number,number]|undefined;
 if(kind==='paper'&&limitGeocode.remaining>0&&/straße|strasse|weg|platz|allee|gasse|ring/iu.test(publicText)){limitGeocode.remaining--;point=await geocode(city,publicText);}
 const purl=record.id.startsWith('http')?record.id:e.url;
 const src=sourceFrom(e,kind==='meeting'?'OParl Sitzung':'OParl Vorlage',city.name,`record ${record.id}; data.name, data.${kind==='meeting'?'start':'date'}, data.consultation`,'unknown','facts_with_attribution');
 src.url=purl;
 const statement=kind==='meeting'
  ?`Eine Sitzung mit dem Titel „${title}“ ist für ${date??'ein nicht bekanntes Datum'} im Ratsinformationssystem verzeichnet. Tagesordnung und Beschlüsse sind anhand des Eintrags zu prüfen.`
  :`Eine Ratsvorlage mit dem Titel „${title}“ ist im Ratsinformationssystem verzeichnet. Eine Vorlage ist keine bestätigte Entscheidung oder Umsetzung.`;
 return signal({id:councilId(record.id),cityId:city.id,kind:kind==='meeting'?'council_meeting':'council_paper',category:kind==='meeting'?'Sitzung':'Ratsvorlage',title,statement,status:kind==='meeting'?'Sitzung verzeichnet':'Vorlage, Beschlussstatus ungeprüft',startDate:date??null,endDate:kind==='meeting'?record.end??null:null,nextStep:kind==='meeting'?'Aktuelle Tagesordnung und Beschlüsse im Ratsinformationssystem prüfen.':'Beratung und Beschluss im Ratsinformationssystem prüfen.',unknowns:['Ob ein Beschluss gefasst wurde',...(point?['Räumlicher Bezug aus Straßennennung nur näherungsweise']:['Genauer räumlicher Bezug'])],scale:point?'street':'city',geometryPrecision:point?'approximate':'none',sources:[src],extraction:{method:'structured'},reviewState:'candidate',asOf:record.modified??e.retrievedAt,upstreamModified:record.modified??null},point?{type:'Point',coordinates:point}:null);
}
export async function collectCcf(city:City){
 await ensureCcf();
 const features:Signal[]=[],sources:ReturnType<typeof sourceStatus>[]=[];
 const limitGeocode={remaining:8};
 for(const kind of ['meeting','paper'] as const){
  const folder=join(cacheDir,'ccf','data','de',city.id,kind);
  let files:string[];
  try{files=(await readdir(folder)).filter(n=>n.endsWith('.json'));}catch{continue;}
  let records:{record:Archive;body:Buffer;file:string}[]=[];
  for(const file of files){
   const body=await readFile(join(folder,file)),record=JSON.parse(body.toString('utf8')) as Archive;
   if(!record.deleted_at&&isRecent(record.data,kind))records.push({record,body,file});
  }
  records=records.sort((a,b)=>(b.record.data.date??b.record.data.start??'').localeCompare(a.record.data.date??a.record.data.start??'')).slice(0,kind==='paper'?100:60);
  for(const {record,body,file} of records){
   const e={body,retrievedAt:new Date().toISOString(),sha256:hash(body),url:`https://github.com/komma-systems/ccf/blob/main/data/de/${city.id}/${kind}/${file}`};
   const feature=await convert(city,record.data,kind,e,limitGeocode);
   if(feature)features.push(feature);
  }
  sources.push(sourceStatus(`ccf-${kind}`,'council',city.name,'https://github.com/komma-systems/ccf','facts_with_attribution',new Date().toISOString()));
 }
 return {features,sources};
}
export async function collectOparl(city:City){if(!city.endpoint)return {features:[] as Signal[],sources:[] as ReturnType<typeof sourceStatus>[]};const features:Signal[]=[],sources:ReturnType<typeof sourceStatus>[]=[];const system=await cachedJson<{body:string;type:string}>(city.endpoint,21600000);if(!system.data.type?.includes('/System')||!system.data.body)throw Error('Invalid OParl System');const bodies=await cachedJson<{data:{id:string;paper?:string;meeting?:string}[]}>(system.data.body,21600000);const limitGeocode={remaining:8};for(const body of bodies.data.data.slice(0,2)){for(const kind of ['meeting','paper'] as const){const base=body[kind];if(!base)continue;let url=base;for(let page=0;page<maxPages&&url;page++){try{const response=await cachedJson<{data:OparlRecord[];pagination?:{next?:string};links?:{next?:string}}>(url,21600000);const rows=response.data.data??[];for(const record of rows.slice(0,100)){const f=await convert(city,record,kind,response,limitGeocode);if(f)features.push(f);}sources.push(sourceStatus(`oparl-${kind}-${page}`,'council',city.name,url,'facts_with_attribution',response.retrievedAt));if(rows.length&&rows.every(r=>!isRecent(r,kind)))break;url=response.data.pagination?.next??response.data.links?.next??'';}catch(error){sources.push(sourceStatus(`oparl-${kind}-${page}`,'council',city.name,url,'facts_with_attribution',new Date().toISOString(),'failed',String(error)));break;}}}}return {features,sources};}
