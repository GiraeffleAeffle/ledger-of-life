import {signal} from './common.ts';
import type {Signal} from './schema.ts';

const isCouncil=(feature:Signal)=>feature.properties.kind==='council_paper'||feature.properties.kind==='council_meeting';
const normalName=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('de');
export function canonicalOparlUrl(value:string){
 const url=new URL(value);
 if(url.protocol!=='http:'&&url.protocol!=='https:')throw Error(`Not an OParl object URL: ${value}`);
 url.protocol='https:';
 url.pathname=url.pathname.replace(/\/+$/,'')||'/';
 url.hash='';
 return url.toString();
}
export const councilId=(url:string)=>`council:${encodeURIComponent(canonicalOparlUrl(url))}`;
function sourceKey(source:Signal['properties']['sources'][number]){return `${source.snapshotUrl??source.url}\0${source.url}\0${source.locator}\0${source.sha256}`;}
function mergeSources(preferred:Signal,other:Signal){
 const sources=[...preferred.properties.sources],seen=new Set(sources.map(sourceKey));
 for(const source of other.properties.sources)if(!seen.has(sourceKey(source))){sources.push(source);seen.add(sourceKey(source));}
 const {version:_,...properties}=preferred.properties;
 return signal({...properties,sources},preferred.geometry);
}

function mergePlanningParts(preferred:Signal,other:Signal){
 const merged=mergeSources(preferred,other),polygons:[number,number][][][]=[];
 const seen=new Set<string>();
 for(const geometry of [preferred.geometry,other.geometry]){
  const parts=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:[];
  for(const polygon of parts){const key=JSON.stringify(polygon);if(!seen.has(key)){seen.add(key);polygons.push(polygon);}}
 }
 const geometry:Signal['geometry']=polygons.length===1?{type:'Polygon',coordinates:polygons[0]}:polygons.length?{type:'MultiPolygon',coordinates:polygons}:preferred.geometry??other.geometry;
 const {version:_,...properties}=merged.properties;
 return signal({...properties,unknowns:[...new Set([...preferred.properties.unknowns,...other.properties.unknowns])],geometryPrecision:geometry?.type==='Polygon'||geometry?.type==='MultiPolygon'?'area':geometry?properties.geometryPrecision:'none'},geometry);
}
const modified=(feature:Signal)=>{
 const time=Date.parse(feature.properties.upstreamModified??'');
 return Number.isFinite(time)?time:-Infinity;
};
function councilObject(feature:Signal){return canonicalOparlUrl(feature.properties.sources[0].url);}
const osmType=(feature:Signal,type:'node'|'way')=>feature.properties.kind==='place'&&feature.properties.id.startsWith(`osm:${type}-`)&&feature.geometry?.type==='Point';
function placeKey(feature:Signal){return `${normalName(feature.properties.title)}\0${normalName(feature.properties.category)}`;}
function separation(a:Signal,b:Signal){
 if(a.properties.cityId!==b.properties.cityId||a.geometry?.type!=='Point'||b.geometry?.type!=='Point')return Infinity;
 const [lon,lat]=a.geometry.coordinates,[otherLon,otherLat]=b.geometry.coordinates;
 return Math.hypot((lon-otherLon)*111320*Math.cos(lat*Math.PI/180),(lat-otherLat)*111320);
}
function nearbyOsmPairs(features:Signal[]){
 const nodes=new Map<string,Signal[]>(),pairs:{node:Signal;way:Signal}[]=[];
 for(const feature of features)if(osmType(feature,'node')){const key=placeKey(feature),bucket=nodes.get(key)??[];bucket.push(feature);nodes.set(key,bucket);}
 for(const way of features)if(osmType(way,'way')){
  let closest:Signal|undefined,distance=50;
  for(const node of nodes.get(placeKey(way))??[]){const metres=separation(node,way);if(metres<distance){closest=node;distance=metres;}}
  if(closest)pairs.push({node:closest,way});
 }
 return pairs;
}
export function duplicateStats(features:Signal[]){
 const seen=new Set<string>(),titles=new Set<string>(),cases=new Set<string>();let councilUrl=0,titleDate=0,planningCase=0;
 for(const feature of features){const p=feature.properties;
  if(isCouncil(feature)){const key=`${p.kind}\0${councilObject(feature)}`;if(seen.has(key))councilUrl++;else seen.add(key);}
  if(p.kind==='planning'&&p.caseKey&&p.startDate){const key=`${p.cityId}\0${p.caseKey}\0${p.startDate}\0${p.endDate}`;if(cases.has(key))planningCase++;else cases.add(key);}
  if(p.startDate){const key=`${p.kind}\0${normalName(p.title)}\0${p.startDate.slice(0,10)}`;if(titles.has(key))titleDate++;else titles.add(key);}
 }
 return {councilUrl,titleDate,planningCase,osmNodeWay:nearbyOsmPairs(features).length};
}
export function deduplicateCitySignals(features:Signal[]){
 const byId=new Map<string,Signal>();
 for(const item of features){const p=item.properties;
  // A shared plan number is not permission to combine distinct legal-date versions.
  const id=isCouncil(item)?councilId(councilObject(item)):p.kind==='planning'&&p.caseKey&&p.startDate?`${p.caseKey}@${p.startDate}${p.endDate?`@${p.endDate}`:''}`:p.id;
  const key=`${p.cityId}\0${id}`;
  let feature=item;
  if(id!==item.properties.id){const {version:_,...properties}=item.properties;feature=signal({...properties,id},item.geometry);}
  const previous=byId.get(key);
  if(!previous){byId.set(key,feature);continue;}
  if(isCouncil(feature)){
   const preferred=modified(feature)>modified(previous)||modified(feature)===modified(previous)?feature:previous;
   byId.set(key,mergeSources(preferred,preferred===feature?previous:feature));
  }else if(feature.properties.kind==='planning'&&feature.properties.caseKey&&feature.properties.startDate){
   const compensation=(item:Signal)=>/Ausgleich|Ergänzung der Ausgleich/i.test(item.properties.title);
   const preferred=compensation(previous)!==compensation(feature)?compensation(previous)?feature:previous:previous.properties.title.localeCompare(feature.properties.title)<=0?previous:feature;
   byId.set(key,mergePlanningParts(preferred,preferred===feature?previous:feature));
  }else byId.set(key,feature);
 }
 for(const {node,way} of nearbyOsmPairs([...byId.values()])){
  const nodeKey=`${node.properties.cityId}\0${node.properties.id}`,wayKey=`${way.properties.cityId}\0${way.properties.id}`;
  const currentNode=byId.get(nodeKey),currentWay=byId.get(wayKey);
  if(currentNode&&currentWay){byId.set(nodeKey,mergeSources(currentNode,currentWay));byId.delete(wayKey);}
 }
 return [...byId.values()].sort((a,b)=>a.properties.id.localeCompare(b.properties.id));
}
