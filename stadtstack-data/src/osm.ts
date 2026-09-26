import {cachedJson,signal,sourceFrom,sourceStatus} from './common.ts';
import type {ResponseEvidence} from './common.ts';
import type {City} from './cities.ts';
import type {Signal} from './schema.ts';
type Coord=[number,number];
type Osm={elements:{type:string;id:number;lat?:number;lon?:number;center?:{lat:number;lon:number};tags?:Record<string,string>}[]};
type OsmResult=ResponseEvidence & {data:Osm};
type Boundary={geojson:{type:'Polygon'|'MultiPolygon';coordinates:Coord[][]|Coord[][][]} ;osm_type?:string;osm_id?:number};
const instances=['https://overpass.openstreetmap.fr/api/interpreter','https://gall.openstreetmap.de/api/interpreter','https://overpass.private.coffee/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass-api.de/api/interpreter','https://overpass.osm.ch/api/interpreter'];
function inRing(point:Coord,ring:Coord[]){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
function inBoundary(point:Coord,boundary:Boundary['geojson']){const polygons:Coord[][][]=boundary.type==='Polygon'?[boundary.coordinates as Coord[][]]:boundary.coordinates as Coord[][][];return polygons.some(rings=>rings.length&&inRing(point,rings[0])&&!rings.slice(1).some(r=>inRing(point,r)));}
export async function collectOsm(city:City){
 const q=new URLSearchParams({q:`${city.name}, ${city.state}, Deutschland`,format:'json',limit:'1',polygon_geojson:'1'});
 const boundary=await cachedJson<Boundary[]>(`https://nominatim.openstreetmap.org/search?${q}`,365*86400000,{timeout:18000});
 const outline=boundary.data.find(x=>x.osm_type==='relation'&&x.osm_id===city.osmRelation)?.geojson;
 if(!outline||!['Polygon','MultiPolygon'].includes(outline.type))throw Error(`Nominatim has no administrative boundary for ${city.id}`);
 const [w,s,e,n]=city.bbox,box=`(${s},${w},${n},${e})`;
 const query=`[out:json][timeout:40];(nwr${box}["club"];nwr${box}["sport"];nwr${box}["shop"~"^(supermarket|bakery|pharmacy)$"];nwr${box}["amenity"~"^(hospital|clinic|doctors|pharmacy|school|kindergarten|townhall|library|community_centre|police|fire_station|post_office)$"];);out center;`;
 let result:OsmResult|undefined,failure='';
 for(const instance of instances){try{const response=await cachedJson<Osm>(instance,86400000,{method:'POST',body:new URLSearchParams({data:query}).toString(),timeout:45000});if(!response.data.elements?.length)throw Error(`Empty Overpass bbox ${city.id}`);result=response;break;}catch(error){failure=String(error);}}
 if(!result)throw Error(`Overpass mirrors exhausted: ${failure}`);
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
