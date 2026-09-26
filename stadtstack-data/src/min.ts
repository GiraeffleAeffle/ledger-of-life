import {booleanValid} from '@turf/boolean-valid';
import polygonClipping from 'polygon-clipping';
import type {FeatureCollection, Signal} from './schema.ts';

type Coord = [number,number];
type Ring = Coord[];
type Geometry = Signal['geometry'];
type Properties = Signal['properties'];
export type CompactProperties = Pick<Properties,'id'|'version'|'cityId'|'kind'|'category'|'title'|'statement'|'status'|'startDate'|'endDate'|'nextStep'|'scale'|'geometryPrecision'|'reviewState'|'asOf'> & {
 sourceCount:number;
 primarySource:Pick<Properties['sources'][number],'url'|'title'|'publisher'|'licence'|'reuse'>;
 faithfulness?:{score:number;threshold:number};
};
export interface CompactCollection {type:'FeatureCollection';features:{type:'Feature';geometry:Geometry;properties:CompactProperties}[]}
const grid=(number:number)=>Number(number.toFixed(5));
const same=(a:Coord,b:Coord)=>a[0]===b[0]&&a[1]===b[1];
const round=(coord:Coord):Coord=>[grid(coord[0]),grid(coord[1])];

function distanceSquared(p:Coord,a:Coord,b:Coord,lonMetres:number){
 const dx=(b[0]-a[0])*lonMetres,dy=(b[1]-a[1])*111320;
 const t=dx===0&&dy===0?0:Math.max(0,Math.min(1,((p[0]-a[0])*lonMetres*dx+(p[1]-a[1])*111320*dy)/(dx*dx+dy*dy)));
 const x=(p[0]-a[0])*lonMetres-t*dx,y=(p[1]-a[1])*111320-t*dy;
 return x*x+y*y;
}
function douglasPeucker(points:Coord[],toleranceMetres:number){
 if(points.length<=2)return points;
 const keep=new Uint8Array(points.length);keep[0]=keep[points.length-1]=1;
 const stack:[number,number][]=[[0,points.length-1]];
 const lonMetres=111320*Math.cos(points[0][1]*Math.PI/180);
 while(stack.length){const [first,last]=stack.pop()!;let farthest=toleranceMetres*toleranceMetres,index=-1;
  for(let i=first+1;i<last;i++){const distance=distanceSquared(points[i],points[first],points[last],lonMetres);if(distance>farthest){farthest=distance;index=i;}}
  if(index>=0){keep[index]=1;stack.push([first,index],[index,last]);}
 }
 return points.filter((_,index)=>keep[index]);
}
function roundedRing(ring:Ring,toleranceMetres:number):Ring|undefined{
 const open=same(ring[0],ring[ring.length-1])?ring.slice(0,-1):ring;
 let points=open;
 if(toleranceMetres>0&&open.length>3){
  const longitude=111320*Math.cos(open[0][1]*Math.PI/180),origin=open[0];
  let pivot=1,distance=0;
  for(let i=1;i<open.length;i++){const dx=(open[i][0]-origin[0])*longitude,dy=(open[i][1]-origin[1])*111320;if(dx*dx+dy*dy>distance){distance=dx*dx+dy*dy;pivot=i;}}
  points=[...douglasPeucker(open.slice(0,pivot+1),toleranceMetres).slice(0,-1),...douglasPeucker([...open.slice(pivot),open[0]],toleranceMetres).slice(0,-1)];
 }
 const snapped:Ring=[];
 for(const point of points){const next=round(point);if(!snapped.length||!same(snapped[snapped.length-1],next))snapped.push(next);}
 if(snapped.length>1&&same(snapped[0],snapped[snapped.length-1]))snapped.pop();
 if(snapped.length<3)return;
 snapped.push(snapped[0]);
 return snapped;
}
function polygon(rings:Ring[],toleranceMetres:number):Ring[]|undefined{
 const shell=roundedRing(rings[0],toleranceMetres);if(!shell)return toleranceMetres?polygon(rings,0):undefined;
 const reduced=[shell,...rings.slice(1).map(r=>roundedRing(r,toleranceMetres)).filter((r):r is Ring=>r!==undefined)];
 if(booleanValid({type:'Polygon',coordinates:reduced}))return reduced;
 if(toleranceMetres){const fallback=polygon(rings,0);if(fallback)return fallback;}
 if(booleanValid({type:'Polygon',coordinates:[shell]}))return [shell];
}
function repairSnappedPolygon(rings:Ring[]):Geometry|undefined{
 const snapped=rings.map(r=>roundedRing(r,0)).filter((r):r is Ring=>r!==undefined);
 if(!snapped.length)return;
 try{
  const pieces=polygonClipping.union(snapped).map(p=>p.map(r=>r.map(round))).filter(p=>booleanValid({type:'Polygon',coordinates:p}));
  const area=(polygon:Ring[])=>Math.abs(polygon[0].reduce((sum,point,i,ring)=>i?sum+ring[i-1][0]*point[1]-ring[i-1][1]*point[0]:0,0));
  pieces.sort((a,b)=>area(b)-area(a));
  const valid:Ring[][]=[];
  for(const part of pieces)if(booleanValid({type:'MultiPolygon',coordinates:[...valid,part]}))valid.push(part);
  if(valid.length)return {type:'MultiPolygon',coordinates:valid};
 }catch{return;}
}
function compactGeometry(geometry:Geometry,id:string):Geometry{
 if(!geometry)return null;
 if(geometry.type==='Point')return {type:'Point',coordinates:round(geometry.coordinates)};
 if(geometry.type==='LineString'){
  let coords=douglasPeucker(geometry.coordinates,4).map(round).filter((point,index,array)=>index===0||!same(point,array[index-1]));
  if(coords.length<2)coords=geometry.coordinates.map(round).filter((point,index,array)=>index===0||!same(point,array[index-1]));
  if(coords.length<2)return {type:'Point',coordinates:round(geometry.coordinates[0])};
  return {type:'LineString',coordinates:coords};
 }
 const original=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
 let reduced=original.map(rings=>polygon(rings,4)).filter((rings):rings is Ring[]=>rings!==undefined);
 if(!reduced.length)return geometry.type==='Polygon'?repairSnappedPolygon(geometry.coordinates)??{type:'Point',coordinates:round(original[0][0][0])}:{type:'Point',coordinates:round(original[0][0][0])};
 if(geometry.type==='MultiPolygon'&&!booleanValid({type:'MultiPolygon',coordinates:reduced})){
  reduced=original.map(rings=>polygon(rings,0)).filter((rings):rings is Ring[]=>rings!==undefined);
  if(!booleanValid({type:'MultiPolygon',coordinates:reduced})){
   const valid:Ring[][]=[];
   for(const part of reduced)if(booleanValid({type:'MultiPolygon',coordinates:[...valid,part]}))valid.push(part);
   reduced=valid;
  }
 }
 if(!reduced.length)return {type:'Point',coordinates:round(original[0][0][0])};
 return geometry.type==='Polygon'?{type:'Polygon',coordinates:reduced[0]}:{type:'MultiPolygon',coordinates:reduced};
}
export function compactCollection(collection:FeatureCollection):CompactCollection{
 return {type:'FeatureCollection',features:collection.features.map(feature=>{
  const p=feature.properties,source=p.sources[0],faithfulness=p.extraction.faithfulness;
  const properties:CompactProperties={id:p.id,version:p.version,cityId:p.cityId,kind:p.kind,category:p.category,title:p.title,statement:p.statement,status:p.status,startDate:p.startDate,endDate:p.endDate,nextStep:p.nextStep,scale:p.scale,geometryPrecision:p.geometryPrecision,reviewState:p.reviewState,asOf:p.asOf,sourceCount:p.sources.length,primarySource:{url:source.url,title:source.title,publisher:source.publisher,licence:source.licence,reuse:source.reuse},...(faithfulness?{faithfulness:{score:faithfulness.score,threshold:faithfulness.threshold}}:{})};
  const geometry=compactGeometry(feature.geometry,p.id);
  if(geometry?.type==='Point'&&feature.geometry?.type!=='Point')properties.geometryPrecision='approximate';
  if(geometry&&!booleanValid(geometry))throw Error(`Invalid compact geometry: ${p.id}`);
  return {type:'Feature' as const,geometry,properties};
 })};
}
