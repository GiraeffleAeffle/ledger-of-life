import proj4 from 'proj4';
import {XMLParser} from 'fast-xml-parser';
import {cachedFetch,signal,sourceFrom,sourceStatus} from './common.ts';
import {geoFeeds} from './geodata-registry.ts';
import type {GeoFeed} from './geodata-registry.ts';
import type {City} from './cities.ts';
import type {Signal,Catalogue} from './schema.ts';
import {parseSourceDate,assertPublicUrls} from './publication-quality.ts';
type UpstreamFeature={id?:string|number;properties:Record<string,unknown>;geometry?:{type:string;coordinates:unknown}};
const utm32='+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs';
function normalizedGeometry(input:UpstreamFeature['geometry']):Signal['geometry']{if(!input)return null;const fix=(value:unknown):unknown=>{if(Array.isArray(value)){if(value.length>=2&&typeof value[0]==='number'&&typeof value[1]==='number'){const point=[value[0],value[1]] as [number,number];return Math.abs(point[0])>180||Math.abs(point[1])>90?proj4(utm32,'EPSG:4326',point):point;}return value.map(fix);}return value;};const coords=fix(input.coordinates);switch(input.type){case 'Point':return {type:'Point',coordinates:coords as [number,number]};case 'LineString':return {type:'LineString',coordinates:coords as [number,number][]};case 'MultiLineString':{const parts=coords as [number,number][][];const longest=parts.sort((a,b)=>b.length-a.length)[0];return longest?.length>=2?{type:'LineString',coordinates:longest}:null;}case 'Polygon':return {type:'Polygon',coordinates:coords as [number,number][][]};case 'MultiPolygon':return {type:'MultiPolygon',coordinates:coords as [number,number][][][]};default:return null;}}
export function gmlFeatures(xml:string,type:string):UpstreamFeature[]{
 const parsed=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',removeNSPrefix:true,parseTagValue:false}).parse(xml) as {FeatureCollection?:{member?:unknown;featureMember?:unknown}};
 const members=parsed.FeatureCollection?.member??parsed.FeatureCollection?.featureMember??[];
 const pairs=(raw:unknown):[number,number][]=>{
  const text=typeof raw==='string'?raw:raw&&typeof raw==='object'&&'#text' in raw&&typeof raw['#text']==='string'?raw['#text']:null;
  if(!text)return [];
  return text.trim().split(/\s+/).map(Number).reduce<[number,number][]>((output,value,i,all)=>{if(i%2===0)output.push([all[i+1],value]);return output;},[]);
 };
 const polygon=(raw:unknown):[number,number][][]=>{
  if(!raw||typeof raw!=='object'||!('exterior' in raw))return [];
  const data=raw as {exterior?:{LinearRing?:{posList?:unknown}};interior?:{LinearRing?:{posList?:unknown}}|{LinearRing?:{posList?:unknown}}[]};
  const outer=data.exterior?.LinearRing?.posList;
  const holes=Array.isArray(data.interior)?data.interior:data.interior?[data.interior]:[];
  return outer?[pairs(outer),...holes.flatMap(r=>r.LinearRing?.posList?[pairs(r.LinearRing.posList)]:[])]:[];
 };
 return (Array.isArray(members)?members:[members]).flatMap(member=>{
  if(!member||typeof member!=='object')return [];
  const item=(member as Record<string,unknown>)[type.split(':').at(-1)!] as Record<string,unknown>|undefined;
  if(!item)return [];
  const props:Record<string,unknown>={};
  let geometry:UpstreamFeature['geometry'];
  for(const [key,value] of Object.entries(item)){
   if(['msGeometry','geometry','geom'].includes(key)){
    const obj=value as Record<string,unknown>;
    if(obj.Point){const pos=(obj.Point as {pos?:string}).pos;if(pos)geometry={type:'Point',coordinates:pairs(pos)[0]};}
    else if(obj.LineString){const list=(obj.LineString as {posList?:string}).posList;if(list)geometry={type:'LineString',coordinates:pairs(list)};}
    else if(obj.Polygon)geometry={type:'Polygon',coordinates:polygon(obj.Polygon)};
    else if(obj.MultiSurface||obj.MultiPolygon){const many=(obj.MultiSurface??obj.MultiPolygon) as {surfaceMember?:{Polygon?:unknown}|{Polygon?:unknown}[];polygonMember?:{Polygon?:unknown}|{Polygon?:unknown}[]};const parts=many.surfaceMember??many.polygonMember??[];geometry={type:'MultiPolygon',coordinates:(Array.isArray(parts)?parts:[parts]).map(member=>polygon(member.Polygon))};}
   }else if(!key.startsWith('@_')&&key!=='boundedBy')props[key]=value;
  }
  return [{id:String(item['@_id']??props.Aktenzeichen??''),properties:props,geometry}];
 });
}
/** Full source plan ID includes amendment/version suffixes; row OIDs identify geometry parts only. */
export function planningCaseKey(feed:GeoFeed,properties:Record<string,unknown>):string|undefined{
 const raw=feed.id==='koeln-bplan'?properties.o_name:properties.planid;
 return typeof raw==='string'&&raw.trim()?`${feed.id}:${raw.trim()}`:undefined;
}
export function makeSignal(city:City,feed:GeoFeed,row:UpstreamFeature,index:number,e:{body:Uint8Array;retrievedAt:string;sha256:string;url:string}){
 const p=row.properties,geometry=normalizedGeometry(row.geometry);if(!geometry&&feed.kind==='roadworks')return;
 const label=p.arbeitstitel??p.name??p.bezeichnung??p.Adresse??p.Kategorie??'Plan',cleanLabel=String(label).trim().replace(/\s+/g,' ').slice(0,220);
 const identifier=String((feed.sourceType==='arcgis-rest'?p.oid:undefined)??p.planid??p.Aktenzeichen??p.fuid??row.id??`${e.sha256.slice(0,12)}-${index}`);
 // ArcGIS date fields use epoch milliseconds when represented numerically; WFS dates remain strings.
 const date=parseSourceDate(p.rechtskr??p.datum,feed.sourceType==='arcgis-rest'?'milliseconds':undefined);
 const range=String(p['Genehmigungs-Zeitraum']??'').match(/(\d{2}[.-]\d{2}[.-]\d{4})\s+bis\s+(\d{2}[.-]\d{2}[.-]\d{4})/);
 const start=feed.kind==='roadworks'?(range?parseSourceDate(range[1]):parseSourceDate(p.beginntam)):date,end=feed.kind==='roadworks'?(range?parseSourceDate(range[2]):parseSourceDate(p.endetam)):null;
 if(feed.kind==='roadworks'&&end&&Date.parse(end)<Date.now()-86400000)return;
 const caseKey=feed.kind==='planning'?planningCaseKey(feed,p):undefined;
 const locator=`${feed.featureType??'layer'}[${feed.sourceType==='arcgis-rest'?'oid':p.planid?'planid':p.Aktenzeichen?'Aktenzeichen':p.fuid?'fuid':'id'}=${identifier}]; ${caseKey?`authoritative plan id=${caseKey}; `:''}${feed.kind==='planning'?`source legal date ${p.rechtskr!==undefined?'rechtskr':'datum'}=${String(p.rechtskr??p.datum??'missing')}; `:''}properties and geometry${p.hinweis?`; hinweis=${String(p.hinweis).trim()}`:''}`;
 const sources:Signal['properties']['sources']=[sourceFrom(e,`${feed.publisher} ${feed.kind==='planning'?'Bebauungspläne':'Baustellen'}`,feed.publisher,locator,feed.licence,'open_licence')];
 for(const field of ['o_namemitpfad','o_name_begr','xplangml','scanurl']){
  const url=p[field];if(typeof url!=='string'||!url.trim())continue;
  assertPublicUrls({url});
  sources.push({url,title:`${feed.publisher} ${field}`,publisher:feed.publisher,locator:`${locator}; ${field} (source-linked document, bytes not fetched)`,retrievedAt:e.retrievedAt,sha256:null,snapshot:false,licence:'unknown',reuse:'facts_with_attribution'});
 }
 const recent=date&&Date.parse(date)>=Date.now()-5*365.25*86400000;const status=feed.kind==='planning'?date?`rechtskräftig seit ${date}`:String(p.status??'Planstatus in Quelle prüfen'):range?`Genehmigter Zeitraum ${start} bis ${end}; tatsächliche Arbeiten prüfen`:String(p.typ_bez??p.Kategorie??'Baustelle im städtischen Datensatz');const title=feed.kind==='planning'?`Bebauungsplan ${String(p.o_name??p.plannr??identifier).trim()} – ${cleanLabel}`:cleanLabel;
 const statement=feed.kind==='planning'?`${city.name} führt den Bebauungsplan „${cleanLabel}“${date?` als seit ${date} rechtskräftig`:''}. ${geometry?'Die Planfläche zeigt geltendes Planungsrecht, keine neue Baustelle.':'Ein Planumriss ist im Datensatz nicht enthalten; das ist keine neue Baustelle.'}`:`${city.name} führt ${String(p.typ_bez??p.Kategorie??'Straßenarbeiten').trim()} bei ${cleanLabel} im Baustellendatensatz${start&&end?` für den angegebenen Zeitraum ${start} bis ${end}`:''}. Der Genehmigungszeitraum ist keine Garantie für tatsächliche Arbeiten vor Ort.`;
 return signal({id:caseKey&&date?`${caseKey}@${date}`:`${feed.id}:${identifier}`,cityId:city.id,kind:feed.kind,...(caseKey?{caseKey}:{}),temporalBasis:'source_event',category:feed.kind==='planning'?String(p.plantyp??'Bebauungsplan'):String(p.typ_bez??p.Kategorie??'Straßenarbeiten'),title,statement,status,startDate:start,endDate:end,nextStep:feed.kind==='planning'?'Planzeichnung und aktuelle Änderungen bei der Stadt prüfen.':'Aktuelle Sperrung und Ausführung bei der Stadt prüfen.',unknowns:feed.kind==='planning'?['Aktuelle Änderungen und konkrete Vorhaben nicht durch Planumriss belegt',...(p.hinweis?[`Quellenhinweis: ${String(p.hinweis).trim()}`]:[]),...(geometry?[]:['Umriss fehlt im Datensatz'])]:['Tatsächliche Ausführung und Verkehrsführung vor Ort nicht bestätigt'],scale:feed.kind==='planning'&&recent&&geometry?'neighbourhood':feed.kind==='roadworks'?'street':'city',geometryPrecision:geometry?geometry.type==='Point'?'exact':geometry.type==='LineString'?'approximate':'area':'none',sources,extraction:{method:'structured'},reviewState:'auto_checked',asOf:e.retrievedAt},geometry);
}
export async function collectGeodata(city:City,sourceType:'wfs'|'arcgis-rest'){
 const features:Signal[]=[],sources:Catalogue['cities'][number]['sources']=[];
 for(const feed of geoFeeds.filter(f=>f.cityId===city.id&&f.sourceType===sourceType)){
  const collected:Signal[]=[];let exhausted=false,errorMessage:string|undefined,retrievedAt=new Date().toISOString(),rawCount=0;
  for(let offset=0;offset<feed.limit;offset+=feed.pageSize){
   const url=new URL(feed.sourceType==='arcgis-rest'?feed.url+'/query':feed.url),size=Math.min(feed.pageSize,feed.limit-offset);
   const params=feed.sourceType==='arcgis-rest'?{where:'1=1',outFields:'*',returnGeometry:'true',outSR:'4326',orderByFields:'oid',resultOffset:String(offset),resultRecordCount:String(size),f:'geojson'}:{SERVICE:'WFS',VERSION:feed.version!,REQUEST:'GetFeature',TYPENAME:feed.featureType!,OUTPUTFORMAT:'geojson',SRSNAME:'EPSG:4326',STARTINDEX:String(offset),COUNT:String(size),MAXFEATURES:String(size)};
   for(const [key,value] of Object.entries(params))if(value!==undefined)url.searchParams.set(key,value);
   try{
    let e=await cachedFetch(url.toString(),86400000,{timeout:30000}),text=Buffer.from(e.body).toString('utf8'),rows:UpstreamFeature[],more=false;
    if(text.trimStart().startsWith('{')){
     const data=JSON.parse(text) as {features?:UpstreamFeature[];error?:{message:string};exceededTransferLimit?:boolean};
     if(data.error)throw Error(data.error.message);if(!Array.isArray(data.features))throw Error('Missing source feature array');
     rows=data.features;more=data.exceededTransferLimit===true;
    }else if(feed.sourceType==='wfs'){
     url.searchParams.delete('OUTPUTFORMAT');e=await cachedFetch(url.toString(),86400000,{timeout:30000});text=Buffer.from(e.body).toString('utf8');
     if(text.includes('ExceptionReport'))throw Error('WFS returned an ExceptionReport');
     if(!/<(?:[\w.-]+:)?FeatureCollection(?:\s|\/?>)/.test(text))throw Error('WFS response lacks a FeatureCollection');
     rows=gmlFeatures(text,feed.featureType!);
    }else throw Error('ArcGIS response was not GeoJSON');
    retrievedAt=e.retrievedAt;rawCount+=rows.length;
    for(let i=0;i<rows.length;i++){const feature=makeSignal(city,feed,rows[i],offset+i,e);if(feature)collected.push(feature);}
    if(rows.length<size&&!more){exhausted=true;break;}
   }catch(error){errorMessage=String(error);break;}
  }
  const dates=collected.flatMap(f=>f.properties.startDate?[f.properties.startDate]:[]).sort();
  const state:'complete'|'partial'|'empty'|'failed'=errorMessage?(rawCount?'partial':'failed'):!collected.length?'empty':exhausted?'complete':'partial';
  const reason=errorMessage?'Source collection interrupted; preceding fetched rows retained.':!collected.length?(rawCount?'Fetched source rows yield no current signals after source-specific filtering.':'Checked source returned an empty feature array.'):!exhausted?`Source row limit ${feed.limit} reached; full inventory not established.`:collected.some(f=>!f.properties.startDate)?'Source exhausted; records without sourced dates require publication quarantine.':undefined;
  sources.push({...sourceStatus(feed.id,feed.kind,feed.publisher,feed.url,'open_licence',retrievedAt,state==='complete'?'ok':state,errorMessage,feed.licence),recordCount:collected.length,coverage:{requestedStart:null,requestedEnd:null,observedStart:dates[0]??null,observedEnd:dates.at(-1)??null,checkedAt:retrievedAt,state,...(reason?{reason}:{})}});
  features.push(...collected);
 }
 return {features,sources};
}
