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
function sourceKey(source:Signal['properties']['sources'][number]){return `${source.snapshotUrl??source.url}\0${source.url}\0${source.locator}`;}
function mergeSources(preferred:Signal,other:Signal){
 const sources=[...preferred.properties.sources],seen=new Set(sources.map(sourceKey));
 for(const source of other.properties.sources)if(!seen.has(sourceKey(source))){sources.push(source);seen.add(sourceKey(source));}
 const {version:_,...properties}=preferred.properties;
 return signal({...properties,sources},preferred.geometry);
}
const modified=(feature:Signal)=>{
 const time=Date.parse(feature.properties.upstreamModified??'');
 return Number.isFinite(time)?time:-Infinity;
};
function councilObject(feature:Signal){return canonicalOparlUrl(feature.properties.sources[0].url);}
const osmType=(feature:Signal,type:'node'|'way')=>feature.properties.kind==='place'&&feature.properties.id.startsWith(`osm:${type}-`)&&feature.geometry?.type==='Point';
function placeKey(feature:Signal){return `${normalName(feature.properties.title)}\0${normalName(feature.properties.category)}`;}
function separation(a:Signal,b:Signal){
 if(a.geometry?.type!=='Point'||b.geometry?.type!=='Point')return Infinity;
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
 const seen=new Set<string>(),titles=new Set<string>();let councilUrl=0,titleDate=0;
 for(const feature of features){const p=feature.properties;
  if(isCouncil(feature)){const key=`${p.kind}\0${councilObject(feature)}`;if(seen.has(key))councilUrl++;else seen.add(key);}
  if(p.startDate){const key=`${p.kind}\0${normalName(p.title)}\0${p.startDate.slice(0,10)}`;if(titles.has(key))titleDate++;else titles.add(key);}
 }
 return {councilUrl,titleDate,osmNodeWay:nearbyOsmPairs(features).length};
}
export function deduplicateCitySignals(features:Signal[]){
 const byId=new Map<string,Signal>();
 for(const item of features){const id=isCouncil(item)?councilId(councilObject(item)):item.properties.id;
  let feature=item;
  if(id!==item.properties.id){const {version:_,...properties}=item.properties;feature=signal({...properties,id},item.geometry);}
  const previous=byId.get(id);
  if(!previous){byId.set(id,feature);continue;}
  if(isCouncil(feature)){
   const preferred=modified(feature)>modified(previous)||modified(feature)===modified(previous)?feature:previous;
   byId.set(id,mergeSources(preferred,preferred===feature?previous:feature));
  }else byId.set(id,feature);
 }
 for(const {node,way} of nearbyOsmPairs([...byId.values()])){
  const currentNode=byId.get(node.properties.id),currentWay=byId.get(way.properties.id);
  if(currentNode&&currentWay){byId.set(node.properties.id,mergeSources(currentNode,currentWay));byId.delete(way.properties.id);}
 }
 return [...byId.values()].sort((a,b)=>a.properties.id.localeCompare(b.properties.id));
}
