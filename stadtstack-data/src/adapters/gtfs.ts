import {readCsv, readZip} from './structured-tables.ts';
import {z} from 'zod';
import {assertSnapshot, observation, ScopeSchema, semanticHash} from '../district-adapter-contract.ts';
import type {AdmittedSnapshot, AdapterScope, AdapterCoverage, StructuredAdapter, StructuredLocator, StructuredObservation} from '../district-adapter-contract.ts';

export const GTFS_MAPPING_VERSION = 'gtfs-static-native-v1';
export const GTFS_LIMITS = {archiveBytes:64 * 1024 * 1024, expandedBytes:256 * 1024 * 1024, memberBytes:64 * 1024 * 1024, members:64, ratio:200, rows:250_000, columns:256, cells:4_000_000, observations:500_000, landingBytes:2 * 1024 * 1024, discoveryPage:16, boundaryVertices:100_000} as const;
const pilots = ['12064472','12064227','12064428','01053100','01053090','01053116','13076090','13076108','13076060'];
const sources = ['mobility-vbb-gtfs','mobility-nahsh-gtfs','mobility-delfi-national-gtfs','mobility-vmv-official-discovery'];
const limitations = ['Scheduled service only; not actual operation, punctuality, ridership or measured project impact.', 'Native IDs are publisher/feed-scoped; no cross-feed identity merge.', 'A parsed feed does not establish municipality or regional service completeness.', 'NAH.SH does not establish complete Lauenburg/HVV coverage.'];

type FieldType = 'id'|'text'|'integer'|'number'|'date'|'time'|'flag';
interface TableSpec {key:string[]; required:string[]; fields:Record<string,FieldType>}
const specs:Record<string,TableSpec> = {
 'agency.txt':{key:['agency_id'],required:['agency_name','agency_url','agency_timezone'],fields:{agency_id:'id',agency_name:'text',agency_url:'text',agency_timezone:'text',agency_lang:'text'}},
 'routes.txt':{key:['route_id'],required:['route_id','route_type'],fields:{route_id:'id',agency_id:'id',route_short_name:'text',route_long_name:'text',route_type:'integer'}},
 'trips.txt':{key:['trip_id'],required:['route_id','service_id','trip_id'],fields:{trip_id:'id',route_id:'id',service_id:'id',trip_headsign:'text',direction_id:'flag',shape_id:'id',block_id:'id'}},
 'stops.txt':{key:['stop_id'],required:['stop_id'],fields:{stop_id:'id',stop_code:'text',stop_name:'text',stop_lat:'number',stop_lon:'number',location_type:'integer',parent_station:'id',zone_id:'id'}},
 'stop_times.txt':{key:['trip_id','stop_sequence'],required:['trip_id','stop_sequence'],fields:{trip_id:'id',stop_id:'id',stop_sequence:'integer',arrival_time:'time',departure_time:'time',pickup_type:'integer',drop_off_type:'integer',timepoint:'flag'}},
 'calendar.txt':{key:['service_id'],required:['service_id','monday','tuesday','wednesday','thursday','friday','saturday','sunday','start_date','end_date'],fields:{service_id:'id',monday:'flag',tuesday:'flag',wednesday:'flag',thursday:'flag',friday:'flag',saturday:'flag',sunday:'flag',start_date:'date',end_date:'date'}},
 'calendar_dates.txt':{key:['service_id','date'],required:['service_id','date','exception_type'],fields:{service_id:'id',date:'date',exception_type:'integer'}},
 'feed_info.txt':{key:[],required:['feed_publisher_name','feed_publisher_url','feed_lang'],fields:{feed_publisher_name:'text',feed_publisher_url:'text',feed_lang:'text',feed_start_date:'date',feed_end_date:'date',feed_version:'text'}}
};
export interface NativeGtfsRow {table:string; row:number; nativeId:string; raw:Record<string,string>; values:Record<string,string|number>; schemaHash:string}
export interface NativeGtfsFeed {rows:NativeGtfsRow[]; tables:Map<string,NativeGtfsRow[]>; unmappedMembers:string[]; unmappedColumns:string[]}
function fail(message:string):never {throw Error(message);}
function date(raw:string):string {
 if(!/^\d{8}$/.test(raw))return fail('Invalid GTFS YYYYMMDD date');
 const value=`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
 if(!Number.isFinite(Date.parse(`${value}T00:00:00Z`))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)return fail('Invalid GTFS calendar date');
 return value;
}
function convert(raw:string,type:FieldType):string|number {
 if(type==='date')return date(raw);
 if(type==='time') {if(!/^\d{2,3}:[0-5]\d:[0-5]\d$/.test(raw))fail('Invalid GTFS service-day time');return raw;}
 if(type==='number') {if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)||!Number.isFinite(Number(raw)))fail('Invalid GTFS number');return Number(raw);}
 if(type==='integer'||type==='flag') {if(!/^\d+$/.test(raw)||(type==='flag'&&!/^[01]$/.test(raw)))fail('Invalid GTFS integer/flag');return Number(raw);}
 return raw;
}
/** Receives original ZIP bytes, never normalized feed objects or a network client. */
export function readGtfsFeed(bytes:Uint8Array):NativeGtfsFeed {
 if(bytes.length>GTFS_LIMITS.archiveBytes)fail('GTFS compressed archive limit');
 const members=readZip(bytes,{inputBytes:GTFS_LIMITS.archiveBytes,totalBytes:GTFS_LIMITS.expandedBytes,memberBytes:GTFS_LIMITS.memberBytes,members:GTFS_LIMITS.members,ratio:GTFS_LIMITS.ratio});
 if(members.size>GTFS_LIMITS.members)fail('GTFS archive member limit');
 let total=0;
 for(const [name,data] of members) {total+=data.length;if(total>GTFS_LIMITS.expandedBytes)fail('GTFS expanded archive limit');if(name.includes('/')||name.includes('\\'))fail('GTFS requires root archive members');}
 const tables=new Map<string,NativeGtfsRow[]>(), rows:NativeGtfsRow[]=[], unmappedColumns:string[]=[];
 for(const [name,spec] of Object.entries(specs)) {
  const bytes=members.get(name);if(!bytes)continue;
  const table=readCsv(bytes,{delimiter:',',encoding:'utf-8',limits:{inputBytes:GTFS_LIMITS.memberBytes,rows:GTFS_LIMITS.rows+1,columns:GTFS_LIMITS.columns,cells:GTFS_LIMITS.cells}}), header=table.rows[0]?.map(cell=>cell.raw)??[];
  if(!header.length||new Set(header).size!==header.length||header.some(value=>!value))fail(`Invalid ${name} header`);
  for(const key of spec.required)if(!header.includes(key))fail(`Changed ${name} schema: missing ${key}`);
  for(const key of header)if(!spec.fields[key])unmappedColumns.push(`${name}:${key}`);
  const nativeRows:NativeGtfsRow[]=[], keys=new Set<string>(), schemaHash=semanticHash({table:name,header});
  for(let i=1;i<table.rows.length;i++) {
   const cells=table.rows[i];if(cells.every(cell=>cell.raw===''))continue;
   if(cells.length!==header.length)fail(`Invalid ${name} row width`);
   const raw:Record<string,string>={},values:Record<string,string|number>={};
   for(let j=0;j<header.length;j++) {raw[header[j]]=cells[j].raw;const type=spec.fields[header[j]];if(type&&cells[j].raw!=='')values[header[j]]=convert(cells[j].raw,type);}
   for(const field of spec.required)if(raw[field]==='')fail(`Missing ${name}:${field}`);
   const key=spec.key.length&&spec.key.every(key=>raw[key])?spec.key.map(key=>encodeURIComponent(raw[key])).join(':'):`row:${i+1}`;
   const uniquenessKey=name==='stop_times.txt'?`${encodeURIComponent(raw.trip_id)}:${values.stop_sequence}`:key;
   if(keys.has(uniquenessKey))fail(`Duplicate ${name} native key`);keys.add(uniquenessKey);
   const row={table:name,row:i+1,nativeId:`${name}:${key}`,raw,values,schemaHash};nativeRows.push(row);rows.push(row);
   if(rows.length>GTFS_LIMITS.rows)fail('GTFS row limit');
  }
  tables.set(name,nativeRows);
 }
 for(const name of ['agency.txt','routes.txt','trips.txt','stops.txt','stop_times.txt'])if(!tables.has(name))fail(`Missing required GTFS member ${name}`);
 if(!tables.has('calendar.txt')&&!tables.has('calendar_dates.txt'))fail('Missing GTFS service calendar');
 const agencies=tables.get('agency.txt')!,routes=tables.get('routes.txt')!,trips=tables.get('trips.txt')!,stops=tables.get('stops.txt')!;
 if(agencies.length>1&&agencies.some(row=>!row.raw.agency_id))fail('Multiple agencies require agency_id');
 const ids=(rows:NativeGtfsRow[],key:string)=>new Set(rows.map(row=>row.raw[key]));
 const agencyIds=ids(agencies,'agency_id'),routeIds=ids(routes,'route_id'),tripIds=ids(trips,'trip_id'),stopIds=ids(stops,'stop_id');
 const serviceIds=new Set([...(tables.get('calendar.txt')??[]),...(tables.get('calendar_dates.txt')??[])].map(row=>row.raw.service_id));
 for(const row of routes) {
  if(!row.raw.route_short_name&&!row.raw.route_long_name)fail('Route requires a name');
  if(row.raw.agency_id&&!agencyIds.has(row.raw.agency_id))fail('Unknown route agency');
  if(!row.raw.agency_id&&agencies.length!==1)fail('Ambiguous route agency');
 }
 for(const row of trips)if(!routeIds.has(row.raw.route_id)||!serviceIds.has(row.raw.service_id))fail('Unknown trip route/service');
 for(const row of stops) {
  const kind=row.raw.location_type||'0';
  if(['0','1','2'].includes(kind)&&(!row.raw.stop_name||row.values.stop_lat===undefined||row.values.stop_lon===undefined))fail('Stop requires name/coordinates');
  if(row.values.stop_lat!==undefined&&Math.abs(Number(row.values.stop_lat))>90||row.values.stop_lon!==undefined&&Math.abs(Number(row.values.stop_lon))>180)fail('Invalid stop coordinates');
  if(row.raw.parent_station&&!stopIds.has(row.raw.parent_station))fail('Unknown parent station');
 }
 for(const row of tables.get('stop_times.txt')!) {
  if(!row.raw.stop_id)fail('GTFS Flex location groups are not supported by this static-stop mapping');
  if(!tripIds.has(row.raw.trip_id)||!stopIds.has(row.raw.stop_id))fail('Unknown stop-time trip/stop');
 }
 for(const row of tables.get('calendar.txt')??[])if(String(row.values.start_date)>String(row.values.end_date))fail('Reversed calendar interval');
 for(const row of tables.get('calendar_dates.txt')??[])if(![1,2].includes(Number(row.values.exception_type)))fail('Invalid calendar exception type');
 return {rows,tables,unmappedMembers:[...members.keys()].filter(name=>!specs[name]),unmappedColumns};
}

interface Boundary {ags:string; vintage:string; geometry:{type:'Polygon'|'MultiPolygon';coordinates:number[][][]|number[][][][]}; index:number; schemaHash:string}
export interface GtfsOptions {municipalBoundaries?:AdmittedSnapshot}
function boundaries(snapshot:AdmittedSnapshot):Boundary[] {
 assertSnapshot(snapshot);if(snapshot.bytes.length>GTFS_LIMITS.landingBytes)fail('Boundary byte limit');
 const position=z.array(z.number().finite()).min(2).max(3),ring=z.array(position).min(4),polygon=z.array(ring).min(1);
 const geometry=z.discriminatedUnion('type',[z.object({type:z.literal('Polygon'),coordinates:polygon}),z.object({type:z.literal('MultiPolygon'),coordinates:z.array(polygon).min(1)})]);
 const feature=z.object({type:z.literal('Feature'),properties:z.object({ags:z.string().regex(/^\d{8}$/),boundary_vintage:z.string().min(1)}).passthrough(),geometry}).passthrough();
 const data=z.object({type:z.literal('FeatureCollection'),features:z.array(feature).max(1000)}).passthrough().parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(snapshot.bytes)));
 if(data.crs!==undefined)fail('GeoJSON join requires RFC7946 WGS84 coordinates, not an unverified CRS');
 let vertices=0;
 return data.features.map((feature,index)=>{
  const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;
  if(!Array.isArray(polygons)||!polygons.length)fail('Invalid boundary polygon');
  for(const polygon of polygons) {if(!Array.isArray(polygon)||!polygon.length)fail('Invalid boundary rings');for(const ring of polygon) {
   if(!Array.isArray(ring)||ring.length<4)fail('Invalid boundary ring');
   for(const point of ring) {if(!Array.isArray(point)||point.length<2||!Number.isFinite(point[0])||!Number.isFinite(point[1])||Math.abs(point[0])>180||Math.abs(point[1])>90)fail('Invalid boundary coordinate');if(++vertices>GTFS_LIMITS.boundaryVertices)fail('Boundary vertex limit');}
   const last=ring[ring.length-1];
   if(ring[0][0]!==last[0]||ring[0][1]!==last[1])fail('Unclosed boundary ring');
  }}
  return {ags:feature.properties.ags,vintage:feature.properties.boundary_vintage,geometry:feature.geometry,index,schemaHash:semanticHash({properties:Object.keys(feature.properties).sort(),geometry:feature.geometry.type})};
 });
}
// Boundary points remain unresolved, preventing adjacent municipalities from both winning.
function ringContains(point:number[],ring:number[][]):boolean|null {
 let inside=false;const [x,y]=point;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++) {const [ax,ay]=ring[i],[bx,by]=ring[j];const cross=(x-ax)*(by-ay)-(y-ay)*(bx-ax);
  if(Math.abs(cross)<1e-12&&x>=Math.min(ax,bx)&&x<=Math.max(ax,bx)&&y>=Math.min(ay,by)&&y<=Math.max(ay,by))return null;
  if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;
 }
 return inside;
}
function contains(point:number[],boundary:Boundary):boolean|null {
 const polygons=boundary.geometry.type==='Polygon'?[boundary.geometry.coordinates as number[][][]]:boundary.geometry.coordinates as number[][][][];
 let found=false;
 for(const polygon of polygons) {const outer=ringContains(point,polygon[0]);if(outer===null)return null;if(!outer)continue;let hole=false;for(const ring of polygon.slice(1)) {const inner=ringContains(point,ring);if(inner===null)return null;if(inner)hole=true;}if(!hole)found=true;}
 return found;
}
function scopeHold(scope:AdapterScope):{state:AdapterCoverage['state'];reason:string}|null {
 ScopeSchema.parse(scope);
 if(!pilots.includes(scope.ags)||!sources.includes(scope.sourceId))return {state:'not_applicable',reason:'Outside the nine-pilot GTFS source scope'};
 if(scope.sourceId==='mobility-vmv-official-discovery')return {state:'not_checked',reason:'No direct public VMV GTFS endpoint/licence established; no fabricated feed'};
 if(scope.sourceId==='mobility-delfi-national-gtfs')return {state:'blocked_access',reason:'DELFI registration required; download not acquired and CC BY version unresolved'};
 if(scope.sourceId==='mobility-vbb-gtfs'&&!scope.ags.startsWith('12064')||scope.sourceId==='mobility-nahsh-gtfs'&&!scope.ags.startsWith('01053'))return {state:'not_applicable',reason:'Catalog feed region is not this pilot region'};
 return null;
}
function coverage(snapshot:AdmittedSnapshot,scope:AdapterScope,state:AdapterCoverage['state'],reason:string,observedRows=0,nextCursor:string|null=null):AdapterCoverage {
 return {state,scope:`${scope.sourceId}:${scope.ags}`,reason,checkedAt:snapshot.retrievedAt,nextCursor,observedRows,limitations};
}
function locator(snapshot:AdmittedSnapshot,row:NativeGtfsRow,key:string):StructuredLocator {
 return {sourceSha256:snapshot.sourceSha256,format:'gtfs',nativeId:row.nativeId,path:`${row.table}/row/${row.row}/${key}`,sheet:row.table,rowKey:row.nativeId,cells:[key],rawValue:row.raw[key]??null,schemaHash:row.schemaHash,mappingVersion:GTFS_MAPPING_VERSION};
}
function entity(scope:AdapterScope,table:string,id:string):string {return `${encodeURIComponent(scope.publisherId)}:${encodeURIComponent(scope.sourceId)}:${table}:${encodeURIComponent(id)}`;}
export function createGtfsAdapter(options:GtfsOptions={}):StructuredAdapter {
 return {id:'gtfs',version:GTFS_MAPPING_VERSION,
  discover(snapshot,scope,cursor) {
   assertSnapshot(snapshot);const hold=scopeHold(scope);if(hold)return {resources:[],coverage:coverage(snapshot,scope,hold.state,hold.reason)};
   try {
    if(snapshot.bytes.length>GTFS_LIMITS.landingBytes)fail('GTFS landing byte limit');
    const html=new TextDecoder('utf-8',{fatal:true}).decode(snapshot.bytes);
    if(/<input\b[^>]*type\s*=\s*["']?password/i.test(html))return {resources:[],coverage:coverage(snapshot,scope,'blocked_access','Landing requires authentication')};
    const urls=new Set<string>();
    for(const match of html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
     const url=new URL(match[1].replace(/&amp;/g,'&'),snapshot.url);
     if(url.protocol!=='https:')continue;
     if(scope.sourceId==='mobility-vbb-gtfs'&&url.hostname==='unternehmen.vbb.de'&&(url.pathname==='/gtfs'||/\.zip$/i.test(url.pathname)&&/gtfs/i.test(url.pathname)))urls.add(url.href);
     if(scope.sourceId==='mobility-nahsh-gtfs'&&url.hostname==='opendata.schleswig-holstein.de'&&/\/resource\/[^/]+\/download\//.test(url.pathname))urls.add(url.href);
    }
    const all=[...urls].sort();let offset=0;
    if(cursor!==null) {const parsed=JSON.parse(cursor);if(parsed.sourceSha256!==snapshot.sourceSha256||parsed.scopeHash!==semanticHash(scope)||!Number.isInteger(parsed.offset)||parsed.offset<0||parsed.offset>=all.length||parsed.offset%GTFS_LIMITS.discoveryPage!==0)fail('Invalid or stale GTFS discovery cursor');offset=parsed.offset;}
    const end=Math.min(offset+GTFS_LIMITS.discoveryPage,all.length),next=end<all.length?JSON.stringify({sourceSha256:snapshot.sourceSha256,scopeHash:semanticHash(scope),offset:end}):null;
    return {resources:all.slice(offset,end).map(url=>({url,nativeId:`${scope.sourceId}:${url}`,parentId:scope.sourceId,method:'GET' as const,body:null,format:'gtfs'})),coverage:coverage(snapshot,scope,next?'partial':all.length?'complete':'empty',all.length?'Advertised static downloads only; payload and town coverage unverified':'No advertised GTFS resource in this landing snapshot; absence is not a feed tombstone',all.length,next)};
   } catch(error) {return {resources:[],coverage:coverage(snapshot,scope,'held_quality',error instanceof Error?error.message:'Invalid landing')};}
  },
  parse(snapshot,scope) {
   assertSnapshot(snapshot);const hold=scopeHold(scope);if(hold)return {observations:[],coverage:coverage(snapshot,scope,hold.state,hold.reason)};
   try {
    const feed=readGtfsFeed(snapshot.bytes),boundaryList=options.municipalBoundaries?boundaries(options.municipalBoundaries):[];
    const observations:StructuredObservation[]=[];
    const byId=(table:string,key:string)=>new Map((feed.tables.get(table)??[]).map(row=>[row.raw[key],row]));
    const trips=byId('trips.txt','trip_id'),stops=byId('stops.txt','stop_id'),routes=byId('routes.txt','route_id'),agencies=byId('agency.txt','agency_id');
    const feedInfo=feed.tables.get('feed_info.txt')?.[0];
    if((feed.tables.get('feed_info.txt')?.length??0)>1)fail('GTFS feed_info requires one row');
    const nativeVersion=feedInfo?.raw.feed_version||snapshot.sourceVersion;
    const referenceDate=feedInfo?.values.feed_start_date as string|undefined;
    function emit(row:NativeGtfsRow,predicate:string,value:string|number,keys:string[],unit:string|null=null,eventDate:string|null=null,dateRole:string|null=null,extra:StructuredLocator[]=[],joined:Boundary|null=null,supportingEvidence:StructuredObservation['supportingEvidence']=[]) {
     if(observations.length>=GTFS_LIMITS.observations)fail('GTFS observation output limit');
     const service=row.table==='calendar.txt'||row.table==='calendar_dates.txt';
     if(row.table==='calendar_dates.txt'&&eventDate===null) {eventDate=String(row.values.date);dateRole='service_exception_date';if(!keys.includes('date'))extra=[...extra,locator(snapshot,row,'date')];}
     observations.push(observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId:row.nativeId,nativeVersion,kind:service?'ScheduledServiceCalendar':row.table==='stop_times.txt'?'ScheduledStopCall':row.table==='stops.txt'?'Stop':row.table==='routes.txt'?'Route':row.table==='trips.txt'?'Trip':row.table==='agency.txt'?'Agency':'FeedMetadata',subject:service?entity(scope,'calendar_service',row.raw.service_id):entity(scope,row.table,row.nativeId),predicate,value,unit,date:eventDate,dateRole,financialRole:'none',geography:{ags:joined?.ags??null,basis:joined?'verified_join':'unknown',role:joined?'performance_location':'unknown'},sourceReferenceDate:referenceDate??null,publishedAt:null,retrievedAt:snapshot.retrievedAt,evidence:[...keys.map(key=>locator(snapshot,row,key)),...extra],supportingEvidence,limitations:[...limitations,...(joined?[`Point-in-polygon WGS84 join; boundary vintage ${joined.vintage}.`]:['No municipality attribution from names, tariff zones, agency seats or requested scope.'])]}));
    }
    for(const row of feed.rows) {
     let joined:Boundary|null=null;
     if(row.table==='stops.txt'&&row.values.stop_lon!==undefined&&row.values.stop_lat!==undefined&&boundaryList.length) {
      const results=boundaryList.map(boundary=>({boundary,result:contains([Number(row.values.stop_lon),Number(row.values.stop_lat)],boundary)}));
      const hits=results.filter(item=>item.result===true);
      if(hits.length===1&&!results.some(item=>item.result===null)&&hits[0].boundary.ags===scope.ags)joined=hits[0].boundary;
     }
     for(const [key,value] of Object.entries(row.values)) {
      const type=specs[row.table].fields[key];
      emit(row,key,value,[key],key==='stop_lat'||key==='stop_lon'?'degree (WGS84)':type==='time'?'GTFS service-day HH:MM:SS (hours may exceed 24)':null,type==='date'?String(value):null,type==='date'?(key==='date'?'service_exception_date':key.includes('start')?'scheduled_valid_from':'scheduled_valid_to'):null);
     }
     if(joined&&options.municipalBoundaries) {
      const boundary=joined,source=options.municipalBoundaries;
      const evidence:StructuredLocator={sourceSha256:source.sourceSha256,format:'json',nativeId:boundary.ags,path:`/features/${boundary.index}`,sheet:null,rowKey:boundary.ags,cells:['properties.ags','properties.boundary_vintage','geometry'],rawValue:boundary.ags,schemaHash:boundary.schemaHash,mappingVersion:GTFS_MAPPING_VERSION};
      emit(row,'located_in',joined.ags,['stop_id','stop_lon','stop_lat'],null,null,null,[],joined,[{role:'municipality_join',locator:evidence}]);
     }
     if(row.table==='trips.txt') {
      emit(row,'scheduled_on',entity(scope,'calendar_service',row.raw.service_id),['trip_id','service_id']);
      const route=routes.get(row.raw.route_id)!;
      emit(row,'on_route',entity(scope,'routes.txt',route.nativeId),['trip_id','route_id'],null,null,null,[locator(snapshot,route,'route_id')]);
     }
     if(row.table==='routes.txt') {
      const agency=row.raw.agency_id?agencies.get(row.raw.agency_id)!:feed.tables.get('agency.txt')![0];
      emit(row,'scheduled_agency',entity(scope,'agency.txt',agency.nativeId),row.raw.agency_id?['route_id','agency_id']:['route_id'],null,null,null,[locator(snapshot,agency,agency.raw.agency_id?'agency_id':'agency_name')]);
     }
     if(row.table==='stop_times.txt') {
      const trip=trips.get(row.raw.trip_id)!,stop=stops.get(row.raw.stop_id)!;
      emit(row,'calls_at',entity(scope,'stops.txt',stop.nativeId),['trip_id','stop_id','stop_sequence'],null,null,null,[locator(snapshot,trip,'trip_id'),locator(snapshot,stop,'stop_id')]);
      emit(trip,'calls_at',entity(scope,'stops.txt',stop.nativeId),['trip_id'],null,null,null,[locator(snapshot,row,'trip_id'),locator(snapshot,row,'stop_id'),locator(snapshot,row,'stop_sequence')]);
      const route=routes.get(trip.raw.route_id)!;
      emit(route,'scheduled_serves',entity(scope,'stops.txt',stop.nativeId),['route_id'],null,null,null,[locator(snapshot,trip,'route_id'),locator(snapshot,trip,'trip_id'),locator(snapshot,row,'trip_id'),locator(snapshot,row,'stop_id')]);
     }
    }
    const result=coverage(snapshot,scope,feed.rows.length?'partial':'empty',feed.rows.length?'Native static schedule parsed; town completeness and live payload capability not established':'Header-only native feed; not evidence of withdrawn service',feed.rows.length);
    result.limitations=[...limitations,...feed.unmappedMembers.map(name=>`Unmapped member: ${name}`),...feed.unmappedColumns.map(name=>`Unmapped column: ${name}`),...(boundaryList.length?[]:['No admitted municipality boundary snapshot supplied; stop AGS remains unknown.'])];
    return {observations,coverage:result};
   } catch(error) {return {observations:[],coverage:coverage(snapshot,scope,'held_quality',error instanceof Error?error.message:'Invalid GTFS archive')};}
  }
 };
}
export const gtfsAdapter=createGtfsAdapter();
export const discover=gtfsAdapter.discover;
export const parse=gtfsAdapter.parse;
