import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cachedJson,cacheDir,hash,signal,sourceStatus} from './common.ts';
import {canonicalOparlUrl,councilId} from './dedupe.ts';
import {createCouncilAcquisition,loadCouncilIndex,traverseCouncilList,type CouncilAcquisition} from './council-cache.ts';
import {CouncilBindingError,bodyMatchesCity,bodyIdMatchesCity,councilCoverage,councilEventDate,councilLicence,councilWindow,inCouncilWindow,parseOparlList,recordMatchesBody,selectCouncilBody} from './council-oparl.ts';
import type {CouncilEvidence,CouncilKind,CouncilWindow,OparlBody,OparlRecord,OparlSystem,OparlListPage,StoredCouncilRecord} from './council-oparl.ts';
import {cities,type City} from './cities.ts';
import type {Catalogue,Signal} from './schema.ts';
import {assertHostNotOptedOut} from './civic-opt-out.ts';

type Archive={source_id:string;record_type:CouncilKind;modified_at:string;deleted_at?:string|null;data:OparlRecord};
type Rights={licence:string;reuse:'open_licence'|'facts_with_attribution';evidence:{url:string;checkedAt:string;note:string}};
export interface CouncilCollection {features:Signal[];sources:Catalogue['cities'][number]['sources']}
const zeroLicence='https://www.govdata.de/dl-de/zero-2-0';
const duesseldorfLicenceUrl='https://opendata.duesseldorf.de/dataset/oparl-schnittstelle-zum-ratsinformationsystem-der-stadt-d%C3%BCsseldorf';
async function discoverCouncil(city:City,acquisition:CouncilAcquisition){
 if(!city.endpoint)throw Error(`No configured OParl endpoint for ${city.name}`);
 const response=await acquisition.loadJson(city.endpoint),system=response.data as OparlSystem;
 if(!system||!/^https?:\/\/schema\.oparl\.org\/1\.[01]\/System$/.test(system.type)||typeof system.body!=='string')throw Error(`Invalid OParl System for ${city.name}`);
 const bodies:OparlBody[]=[],visited=new Set<string>();let url:string|null=canonicalOparlUrl(system.body);
 while(url){
  if(visited.has(url)||visited.size>=50)throw Error(`Incomplete OParl Body discovery for ${city.name}`);
  visited.add(url);const list=await acquisition.loadJson(url);const page:OparlListPage<OparlBody>=parseOparlList<OparlBody>(list.data,url,'Body');
  if(page.records.some(body=>typeof body.name!=='string'||!body.name))throw Error(`Unnamed OParl Body for ${city.name}`);
  bodies.push(...page.records);url=page.next;
 }
 const body=selectCouncilBody(bodies,city),checkedAt=new Date().toISOString();
 acquisition.bindBody(body);
 const declared=councilLicence(body.license??system.license);
 let rights:Rights={...declared,evidence:{url:body.id,checkedAt,note:declared.licence!=='unknown'?'Licence/terms URI explicitly declared by official OParl Body/System for metadata; only recognised permissive licences treated as open. Attached third-party files require their own rights check.':`Checked official System and Body license fields: ${JSON.stringify(body.license??system.license??null)}; no identified reuse licence. Only attributed derived facts, not document redistribution.`}};
 if(city.id==='duesseldorf'&&declared.licence==='unknown'){
  try{
   const terms=await acquisition.loadText(duesseldorfLicenceUrl),text=terms.text;
   if(text.includes(zeroLicence)&&text.includes('ris-oparl.itk-rheinland.de/Oparl/bodies/0015'))rights={licence:zeroLicence,reuse:'open_licence',evidence:{url:terms.url,checkedAt:terms.checkedAt??terms.retrievedAt,note:`Official Düsseldorf OParl dataset identifies body 0015 and Datenlizenz Deutschland Zero 2.0. Applies to public metadata/derived facts; no blanket permission inferred for attached third-party documents. System value "Open" alone is not a licence. Source SHA-256 ${terms.sha256}; declared resource policy retained in the managed acquisition observation.`}};
  }catch{rights.evidence.note+=' Official open-data dataset licence page could not be fetched; rights remain unknown.';}
 }
 if(rights.licence==='unknown'&&(city.id==='freiburg'||city.id==='castrop-rauxel')){
  const termsUrl=city.id==='freiburg'?'https://www.freiburg.de/pb/224613.html':'https://www.castrop-rauxel.de/impressum';
  try{
   const terms=await acquisition.loadText(termsUrl),text=terms.text;
   if(text.includes('Urheberrecht'))rights.evidence={url:terms.url,checkedAt:terms.checkedAt??terms.retrievedAt,note:(city.id==='freiburg'?'Official System/Body contain no licence. Municipal imprint allows private copying only and protects contributions; its scope is the municipal website, not an identified RIS/API reuse grant. Rights remain unknown; attributed derived facts only, no full-text/file redistribution.':'Official System/Body contain no licence. Municipal imprint requires permission beyond statutory exceptions and expressly rejects blanket §5 UrhG official-work status; no RIS/API open grant identified. Rights remain unknown; attributed derived facts only, no full-text/file redistribution.')+` Source SHA-256 ${terms.sha256}; declared resource policy retained in the managed acquisition observation.`};
  }catch{rights.evidence.note+=' Municipal copyright notice could not be fetched; no permission inferred.';}
 }
 return {body,rights,checkedAt};
}
function bindingFor(city:City,body:OparlBody){return {id:body.id,name:body.name,cityId:city.id,matched:bodyMatchesCity(body.name,city)&&bodyIdMatchesCity(body.id,city),expectedNames:[city.name,...city.councilBodyAliases??[]]};}
export function councilBindingFailure(city:City,error:CouncilBindingError){
 const checkedAt=new Date().toISOString(),window=councilWindow(),observed=error.observedBodies[0]??{id:city.councilBodyId??city.endpoint!,name:'No matching Body returned'};
 return {features:[] as Signal[],sources:[{...sourceStatus('oparl-binding','council',city.name,observed.id,'facts_with_attribution',checkedAt,'failed',String(error)),recordCount:0,bodyBinding:{...bindingFor(city,observed),matched:false},coverage:{requestedStart:window.start,requestedEnd:window.end,observedStart:null,observedEnd:null,checkedAt,state:'failed' as const,reason:String(error)}}]};
}
let lastNominatim=0;
export async function geocode(city:City,title:string):Promise<[number,number]|undefined>{const match=title.match(/(?:[A-ZÄÖÜ][\p{L}ß-]{3,}(?:straße|strasse|weg|platz|allee|gasse|ring)|(?:Straße|Platz|Weg)\s+[\p{L}ß-]{3,})/iu);if(!match)return;const query=new URLSearchParams({q:`${match[0]}, ${city.name}, Deutschland`,format:'json',limit:'1',countrycodes:'de'});const url=`https://nominatim.openstreetmap.org/search?${query}`;const wait=Math.max(0,1100-(Date.now()-lastNominatim));if(wait){const {promise,resolve}=Promise.withResolvers<void>();setTimeout(resolve,wait);await promise;}lastNominatim=Date.now();try{const e=await cachedJson<{lon:string;lat:string}[]>(url,365*86400000,{timeout:10000});const p=e.data[0];if(p){const lon=Number(p.lon),lat=Number(p.lat);if(lon>city.bbox[0]&&lon<city.bbox[2]&&lat>city.bbox[1]&&lat<city.bbox[3])return [lon,lat];}}catch{}return;}
async function convert(city:City,record:OparlRecord,kind:CouncilKind,e:CouncilEvidence,window:CouncilWindow,rights:Rights,limitGeocode:{remaining:number}):Promise<Signal|undefined>{
 if(!record.id||record.deleted||!inCouncilWindow(record,kind,window))return;
 const title=(record.name??record.title??'Unbenannter Vorgang').slice(0,450),date=councilEventDate(record,kind)!;
 const publicText=`${title} ${(record.text??record.description??'').slice(0,1000)}`;
 let point:[number,number]|undefined;
 if(kind==='paper'&&limitGeocode.remaining>0&&/straße|strasse|weg|platz|allee|gasse|ring/iu.test(publicText)){limitGeocode.remaining--;point=await geocode(city,publicText);}
 const licence=record.license?councilLicence(record.license):rights;
 const src:Signal['properties']['sources'][number]={url:canonicalOparlUrl(record.id),snapshotUrl:e.url,title:kind==='meeting'?'OParl Sitzung':'OParl Vorlage',publisher:city.name,locator:`record ${record.id}; data.name, data.${kind==='meeting'?'start':'date'}, data.consultation, data.license`,retrievedAt:e.retrievedAt,checkedAt:e.checkedAt,sha256:e.sha256,snapshot:true,licence:licence.licence,reuse:licence.reuse};
 const statement=kind==='meeting'
  ?`Eine Sitzung mit dem Titel „${title}“ ist für ${date} im Ratsinformationssystem verzeichnet. Tagesordnung und Beschlüsse sind anhand des Eintrags zu prüfen.`
  :`Eine Ratsvorlage mit dem Titel „${title}“ ist im Ratsinformationssystem verzeichnet. Eine Vorlage ist keine bestätigte Entscheidung oder Umsetzung.`;
 return signal({id:councilId(record.id),cityId:city.id,kind:kind==='meeting'?'council_meeting':'council_paper',category:kind==='meeting'?'Sitzung':'Ratsvorlage',title,statement,status:kind==='meeting'?'Sitzung verzeichnet':'Vorlage, Beschlussstatus ungeprüft',startDate:date,endDate:kind==='meeting'?record.end??null:null,nextStep:kind==='meeting'?'Aktuelle Tagesordnung und Beschlüsse im Ratsinformationssystem prüfen.':'Beratung und Beschluss im Ratsinformationssystem prüfen.',unknowns:['Ob ein Beschluss gefasst wurde',...(point?['Räumlicher Bezug aus Straßennennung nur näherungsweise']:['Genauer räumlicher Bezug'])],scale:point?'street':'city',geometryPrecision:point?'approximate':'none',sources:[src],extraction:{method:'structured'},reviewState:'candidate',asOf:record.modified??e.retrievedAt,upstreamModified:record.modified??null},point?{type:'Point',coordinates:point}:null);
}
/** Read-only historical import: never refreshes Git, discovers live endpoints, or geocodes archive text. */
export async function collectRetainedCcf(city:City,options:{snapshotRoot?:string;stampPath?:string;liveAcquisition?:CouncilAcquisition;stateDir?:string;now?:Date}={}):Promise<CouncilCollection>{
 const registered=cities.find(item=>item.id===city.id);
 if(!registered?.endpoint||!registered.councilBodyId||!city.endpoint||canonicalOparlUrl(city.endpoint)!==canonicalOparlUrl(registered.endpoint))throw Error('Retained CCF import requires a registered City endpoint and Body');
 const acquisition=options.liveAcquisition;
 if(acquisition&&(acquisition.cityId!==registered.id||acquisition.registeredSourceUrl!==canonicalOparlUrl(registered.endpoint)))throw Error('Retained CCF import has a foreign live council context');
 const repository='https://github.com/komma-systems/ccf',snapshotRoot=options.snapshotRoot??join(cacheDir,'ccf');
 const assertActive=async()=>{
  if(acquisition){await acquisition.fetcher.assertHostAllowed(registered.endpoint!);await acquisition.fetcher.assertHostAllowed(repository);}
  else{await assertHostNotOptedOut(registered.endpoint!,{stateDir:options.stateDir});await assertHostNotOptedOut(repository,{stateDir:options.stateDir});}
 };
 await assertActive();
 let fetched:{at?:unknown};
 try{fetched=JSON.parse(await readFile(options.stampPath??join(cacheDir,'ccf-fetched.json'),'utf8'));}
 catch{throw Error('Retained CCF retrieval stamp missing or invalid; live Git acquisition is disabled');}
 if(typeof fetched.at!=='string'||!Number.isFinite(Date.parse(fetched.at)))throw Error('Retained CCF retrieval stamp missing or invalid; retrieval time is never invented');
 const checkedAt=fetched.at,body:OparlBody={id:registered.councilBodyId,name:registered.name};
 const rights:Rights={licence:'unknown',reuse:'facts_with_attribution',evidence:{url:repository,checkedAt,note:'Retained CCF snapshot only. Body identity is pinned in the City registry; no new System/Body discovery or licence check. Record-specific declarations remain separately attributed; no document redistribution.'}};
 const features:Signal[]=[],sources:CouncilCollection['sources']=[],window=councilWindow(options.now),limitGeocode={remaining:0};
 for(const kind of ['meeting','paper'] as const){
  await assertActive();
  const folder=join(snapshotRoot,'data','de',registered.id,kind),storage=acquisition?.storage(body.id,kind),checkpoint=await storage?.load();
  const live=checkpoint&&storage?await loadCouncilIndex(storage,checkpoint):new Map<string,StoredCouncilRecord>();
  const withdrawn=new Set(checkpoint?.withdrawnIds??[]);
  let files:string[];
  try{files=(await readdir(folder)).filter(name=>name.endsWith('.json'));}
  catch{throw Error(`Retained CCF ${kind} snapshot missing or inaccessible; no live refresh attempted`);}
  let count=0,quarantined=0,unbound=0,deleted=0,observedStart:string|null=null,observedEnd:string|null=null;
  for(const file of files){
   await assertActive();
   const raw=await readFile(join(folder,file)),archive=JSON.parse(raw.toString('utf8')) as Archive,record=archive.data;
   const liveRecord=live.get(canonicalOparlUrl(record.id));
   if(archive.deleted_at||record.deleted||liveRecord?.record.deleted||withdrawn.has(canonicalOparlUrl(record.id))){deleted++;continue;}
   if(!recordMatchesBody(record,body)&&(!liveRecord||record.body)){unbound++;continue;}
   // A completed live inventory also vetoes older archive-only objects absent before its first watermark.
   const archivedModified=Date.parse(record.modified??''),liveObservedAt=Date.parse(checkpoint?.lastCheckedAt??'');
   if(checkpoint?.backfillComplete&&!checkpoint.active&&!checkpoint.error&&!liveRecord&&(!Number.isFinite(archivedModified)||archivedModified<=liveObservedAt)){deleted++;continue;}
   if(!councilEventDate(record,kind)){quarantined++;continue;}
   if(!inCouncilWindow(record,kind,window))continue;
   const e={retrievedAt:checkedAt,sha256:hash(raw),url:`https://github.com/komma-systems/ccf/blob/main/data/de/${city.id}/${kind}/${file}`};
   const feature=await convert(city,record,kind,e,window,rights,limitGeocode);
   if(feature){features.push(feature);count++;const day=feature.properties.startDate!.slice(0,10);if(!observedStart||day<observedStart)observedStart=day;if(!observedEnd||day>observedEnd)observedEnd=day;}
  }
  const coverageState=count||quarantined||unbound?'partial' as const:'empty' as const;
  sources.push({...sourceStatus(`ccf-retained-${kind}`,'council',city.name,repository,rights.reuse,checkedAt,coverageState,undefined,rights.licence),recordCount:count,bodyBinding:bindingFor(city,body),licenceEvidence:rights.evidence,coverage:{requestedStart:window.start,requestedEnd:window.end,observedStart,observedEnd,checkedAt,state:coverageState,reason:`Retained CCF snapshot imported with original retrieval time ${checkedAt}; no Git fetch, live archive check or geocoding. Not complete/current API coverage; ${files.length} retained files inspected, ${unbound} withheld without matching registered Body/live-list ownership, ${quarantined} quarantined without valid source event date, ${deleted} source deletions/full-scan withdrawals withheld.`}});
 }
 await assertActive();
 return {features,sources};
}
export async function collectOparl(city:City,options:{maxPages?:number;geocodeBudget?:number;now?:Date;reuseCompleteMs?:number;acquisition?:CouncilAcquisition}={}):Promise<CouncilCollection>{
 if(!city.endpoint)return {features:[] as Signal[],sources:[] as Catalogue['cities'][number]['sources']};
 const acquisition=options.acquisition??createCouncilAcquisition(city);
 if(acquisition.cityId!==city.id||acquisition.registeredSourceUrl!==canonicalOparlUrl(city.endpoint))throw Error('Council acquisition context differs from the selected City endpoint');
 let discovery:{body:OparlBody;rights:Rights;checkedAt:string};
 try{discovery=await discoverCouncil(city,acquisition);}catch(error){if(error instanceof CouncilBindingError)return councilBindingFailure(city,error);throw error;}
 const {body,rights}=discovery,features:Signal[]=[],sources=[];
 const now=options.now??new Date(),window=councilWindow(now),limitGeocode={remaining:options.geocodeBudget??8};
 for(const kind of ['meeting','paper'] as const){
  if(!body[kind]){
   const checkedAt=new Date().toISOString();sources.push({...sourceStatus(`oparl-${kind}`,'council',city.name,body.id,rights.reuse,checkedAt,'not_checked',undefined,rights.licence),recordCount:0,bodyBinding:bindingFor(city,body),licenceEvidence:rights.evidence,coverage:{requestedStart:window.start,requestedEnd:window.end,observedStart:null,observedEnd:null,checkedAt,state:'not_checked' as const,reason:`Body does not advertise a ${kind} list.`}});continue;
  }
  const result=await traverseCouncilList(body,kind,acquisition.storage(body.id,kind),acquisition.loadJson,{maxPages:options.maxPages,now:now.toISOString(),reuseCompleteMs:options.reuseCompleteMs});
  const checkedAt=result.state.lastCheckedAt??new Date().toISOString(),health=councilCoverage(result.records,kind,window,result.state,checkedAt);
  for(const {record,evidence} of result.records.values()){
   const feature=await convert(city,record,kind,evidence,window,rights,limitGeocode);if(feature)features.push(feature);
  }
  const status=health.coverage.state==='complete'?'ok':health.coverage.state;
  sources.push({...sourceStatus(`oparl-${kind}`,'council',city.name,canonicalOparlUrl(body[kind]!),rights.reuse,result.state.lastCheckedAt??checkedAt,status,result.state.error,rights.licence),recordCount:health.recordCount,bodyBinding:bindingFor(city,body),licenceEvidence:rights.evidence,coverage:health.coverage});
 }
 return {features,sources};
}
