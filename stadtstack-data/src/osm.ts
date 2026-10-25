import {signal,sourceFrom,sourceStatus} from './common.ts';
import type {ResponseEvidence} from './common.ts';
import type {City} from './cities.ts';
import type {Signal} from './schema.ts';
export type Coord=[number,number];
export type Osm={elements:{type:string;id:number;lat?:number;lon?:number;center?:{lat:number;lon:number};tags?:Record<string,string>}[]};
export type OsmResult=ResponseEvidence & {data:Osm};
export type Boundary={geojson:{type:'Polygon'|'MultiPolygon';coordinates:Coord[][]|Coord[][][]} ;osm_type?:string;osm_id?:number};
function inRing(point:Coord,ring:Coord[]){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
export function inBoundary(point:Coord,boundary:Boundary['geojson']){const polygons:Coord[][][]=boundary.type==='Polygon'?[boundary.coordinates as Coord[][]]:boundary.coordinates as Coord[][][];return polygons.some(rings=>rings.length&&inRing(point,rings[0])&&!rings.slice(1).some(r=>inRing(point,r)));}
/** Transform supplied evidence only; acquisition and source authorization belong to the caller. */
export function parseOsm(city:City,result:OsmResult,boundary:ResponseEvidence & {data:Boundary[]}){
 const outline=boundary.data.find(x=>x.osm_type==='relation'&&x.osm_id===city.osmRelation)?.geojson;
 if(!outline||!['Polygon','MultiPolygon'].includes(outline.type))throw Error(`Nominatim has no administrative boundary for ${city.id}`);
 const evidence=result;
 const features:Signal[]=result.data.elements.flatMap(item=>{
  const loc=item.center??(item.lon!==undefined&&item.lat!==undefined?{lon:item.lon,lat:item.lat}:undefined),tags=item.tags??{};
  if(!loc||!tags.name||!inBoundary([loc.lon,loc.lat],outline))return [];
  const category=tags.club??tags.sport??tags.shop??tags.amenity??'place';
  const url=`https://www.openstreetmap.org/${item.type}/${item.id}`;
  const state=tags['opening_hours']?'Öffnungszeiten in OSM eingetragen; nicht unabhängig bestätigt':'Betrieb und Öffnungszeiten nicht geprüft';
  return [signal({id:`osm:${item.type}-${item.id}`,cityId:city.id,kind:'place',category,title:tags.name,statement:`${tags.name} ist in OpenStreetMap als ${category} eingetragen. ${state}.`,status:'OSM-Eintrag, nicht offiziell geprüft',startDate:null,endDate:null,nextStep:'Aktuelle Angaben direkt beim Ort prüfen.',unknowns:['Aktueller Betrieb und tatsächliche Öffnungszeiten'],scale:'street',geometryPrecision:item.type==='node'?'exact':'approximate',sources:[{...sourceFrom(evidence,'OpenStreetMap contributors','OpenStreetMap contributors',`${item.type}/${item.id}; tags.name, ${tags.club?'tags.club':tags.sport?'tags.sport':tags.shop?'tags.shop':'tags.amenity'}`,'ODbL 1.0','open_licence'),url}],extraction:{method:'structured'},reviewState:'candidate',asOf:evidence.retrievedAt},{type:'Point',coordinates:[loc.lon,loc.lat]})];
 });
 return {features,sources:[sourceStatus('osm','places','OpenStreetMap contributors','https://www.openstreetmap.org/copyright','open_licence',evidence.retrievedAt,'ok',undefined,'ODbL 1.0'),sourceStatus('osm-boundary','boundary','OpenStreetMap contributors',boundary.url,'open_licence',boundary.retrievedAt,'ok',undefined,'ODbL 1.0')]};
}
