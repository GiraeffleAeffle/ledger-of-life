import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {createGtfsAdapter,gtfsAdapter,readGtfsFeed,GTFS_LIMITS} from '../src/adapters/gtfs.ts';
import {digest} from '../src/district-adapter-contract.ts';
import type {AdmittedSnapshot,AdapterScope} from '../src/district-adapter-contract.ts';

const scope:AdapterScope={publisherId:'VBB',sourceId:'mobility-vbb-gtfs',municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'2026-10'};
function snapshot(bytes:Uint8Array|string,url='https://unternehmen.vbb.de/digitale-services/datensaetze/'):AdmittedSnapshot {
 const data=typeof bytes==='string'?new TextEncoder().encode(bytes):bytes;
 return {bytes:data,sourceSha256:digest(data),url,mimeType:'application/zip',retrievedAt:'2026-10-11T00:00:00Z',policyReceiptSha256:'a'.repeat(64),sourceVersion:'fixture-only'};
}
function crc32(bytes:Uint8Array):number {
 let crc=0xffffffff;for(const byte of bytes) {crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;
}
/** Original ZIP fixture bytes, including actual local/central headers and CSV members. */
function zip(files:Record<string,string>,options:{deflate?:boolean;symlink?:boolean}={}):Uint8Array {
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const [name,text] of Object.entries(files)) {
  const filename=Buffer.from(name),raw=Buffer.from(text),body=options.deflate?deflateRawSync(raw):raw,method=options.deflate?8:0,crc=crc32(raw);
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(method,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(raw.length,22);header.writeUInt16LE(filename.length,26);
  local.push(header,filename,body);
  const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50,0);entry.writeUInt16LE(0x0314,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(method,10);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(body.length,20);entry.writeUInt32LE(raw.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(options.symlink?0xa1ff0000:0x81a40000,38);entry.writeUInt32LE(offset,42);
  central.push(entry,filename);offset+=header.length+filename.length+body.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
function files(empty=false):Record<string,string> {
 return {
  'agency.txt':'agency_id,agency_name,agency_url,agency_timezone\r\n'+(empty?'':'0001,"Regional, Transit",https://example.org,Europe/Berlin\r\n'),
  'routes.txt':'route_id,agency_id,route_short_name,route_type\n'+(empty?'':'001,0001,1,3\n'),
  'trips.txt':'route_id,service_id,trip_id\n'+(empty?'':'001,0007,0009\n'),
  'stops.txt':'stop_id,stop_name,stop_lat,stop_lon\n'+(empty?'':'0005,Strausberg,52.58,13.88\n'),
  'stop_times.txt':'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'+(empty?'':'0009,25:10:00,25:11:00,0005,001\n'),
  'calendar.txt':'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n'+(empty?'':'0007,1,1,1,1,1,0,0,20261001,20261231\n'),
  'calendar_dates.txt':'service_id,date,exception_type\n'+(empty?'':'0007,20261012,2\n'),
  'feed_info.txt':'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_version\n'+(empty?'':'VBB,https://example.org,de,20261001,2026.10\n')
 };
}
function boundary(ags='12064472',ring:number[][]=[[13,52],[14,52],[14,53],[13,53],[13,52]]) {
 return snapshot(JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{ags,boundary_vintage:'2026-01-01'},geometry:{type:'Polygon',coordinates:[ring]}}]}),'https://example.org/municipal-boundaries.geojson');
}

test('native ZIP/CSV preserves feed IDs, service-day times, raw evidence and sourced dates',()=>{
 const source=snapshot(zip(files(),{deflate:true})),result=gtfsAdapter.parse(source,scope);
 assert.equal(result.coverage.state,'partial');assert.ok(result.observations.length>0);
 const agency=result.observations.find(row=>row.predicate==='agency_id')!;
 assert.equal(agency.value,'0001');assert.equal(agency.evidence[0].rawValue,'0001');assert.equal(agency.evidence[0].sourceSha256,source.sourceSha256);
 assert.equal(result.observations.find(row=>row.predicate==='agency_name')?.value,'Regional, Transit');
 assert.equal(result.observations.find(row=>row.predicate==='arrival_time')?.value,'25:10:00');
 const start=result.observations.find(row=>row.predicate==='start_date')!;assert.equal(start.date,'2026-10-01');assert.equal(start.dateRole,'scheduled_valid_from');assert.equal(start.evidence[0].rawValue,'20261001');
 assert.ok(result.observations.every(row=>row.geography.ags===null));
 assert.ok(result.observations.some(row=>row.predicate==='scheduled_serves'));
 assert.ok(result.observations.some(row=>row.predicate==='calls_at'));
 assert.ok(result.observations.every(row=>row.limitations.some(text=>text.includes('Scheduled service only'))));
});

test('identical native IDs in different feeds never share subject identities',()=>{
 const source=snapshot(zip(files())),a=gtfsAdapter.parse(source,scope),b=gtfsAdapter.parse(source,{...scope,publisherId:'NAH.SH',sourceId:'mobility-nahsh-gtfs',ags:'01053100',municipalityId:'ratzeburg'});
 assert.notEqual(a.observations[0].subject,b.observations[0].subject);
});

test('municipality membership requires admitted native WGS84 geometry and retains leading-zero AGS',()=>{
 const adapter=createGtfsAdapter({municipalBoundaries:boundary('01053100')}),result=adapter.parse(snapshot(zip(files())),{...scope,sourceId:'mobility-nahsh-gtfs',ags:'01053100',municipalityId:'ratzeburg'});
 const join=result.observations.find(row=>row.predicate==='located_in')!;
 assert.equal(join.value,'01053100');assert.equal(join.geography.ags,'01053100');assert.equal(join.geography.basis,'verified_join');
 assert.equal(join.evidence.length,3);assert.ok(join.evidence.every(locator=>locator.format==='gtfs'));
 assert.ok(join.evidence.every(locator=>locator.sourceSha256===digest(zip(files()))));
 assert.equal(join.supportingEvidence.length,1);assert.equal(join.supportingEvidence[0].role,'municipality_join');
 assert.equal(join.supportingEvidence[0].locator.format,'json');assert.equal(join.supportingEvidence[0].locator.sourceSha256,boundary('01053100').sourceSha256);
 assert.ok(result.observations.filter(row=>row.kind==='Agency'||row.kind==='Route').every(row=>row.geography.ags===null));
});

test('boundary-edge, overlapping polygons and holes cannot fabricate a join',()=>{
 const edge=createGtfsAdapter({municipalBoundaries:boundary('12064472',[[13.88,52],[14,52],[14,53],[13.88,53],[13.88,52]])});
 assert.ok(edge.parse(snapshot(zip(files())),scope).observations.every(row=>row.predicate!=='located_in'));
 const base=JSON.parse(new TextDecoder().decode(boundary().bytes));base.features.push({...base.features[0],properties:{ags:'12064227',boundary_vintage:'2026-01-01'}});
 assert.ok(createGtfsAdapter({municipalBoundaries:snapshot(JSON.stringify(base))}).parse(snapshot(zip(files())),scope).observations.every(row=>row.predicate!=='located_in'));
 base.features.pop();base.features[0].geometry.coordinates.push([[13.8,52.5],[13.9,52.5],[13.9,52.7],[13.8,52.7],[13.8,52.5]]);
 assert.ok(createGtfsAdapter({municipalBoundaries:snapshot(JSON.stringify(base))}).parse(snapshot(zip(files())),scope).observations.every(row=>row.predicate!=='located_in'));
});

test('header-only native feed is empty, not withdrawn or proof of no municipal service',()=>{
 const result=gtfsAdapter.parse(snapshot(zip(files(true))),scope);assert.equal(result.coverage.state,'empty');assert.deepEqual(result.observations,[]);assert.match(result.coverage.reason,/not evidence of withdrawn/);
});

test('calendar removal is a dated scheduled exception, not deletion of trip or actual service',()=>{
 const result=gtfsAdapter.parse(snapshot(zip(files())),scope),exception=result.observations.find(row=>row.predicate==='exception_type')!;
 assert.equal(exception.value,2);assert.equal(exception.evidence[0].rawValue,'2');
 assert.ok(result.observations.some(row=>row.kind==='Trip'));
 const dated=result.observations.find(row=>row.kind==='ScheduledServiceCalendar'&&row.predicate==='date')!;assert.equal(dated.date,'2026-10-12');assert.equal(dated.dateRole,'service_exception_date');
});

test('removed schema, broken references, invalid calendar and ZIP corruption hold without partial facts',()=>{
 const malformed=[{...files(),'trips.txt':'route_id,trip_id\n001,0009\n'},{...files(),'trips.txt':'route_id,service_id,trip_id\n999,0007,0009\n'},{...files(),'calendar_dates.txt':'service_id,date,exception_type\n0007,20260230,2\n'}];
 for(const file of malformed) {const result=gtfsAdapter.parse(snapshot(zip(file)),scope);assert.equal(result.coverage.state,'held_quality');assert.deepEqual(result.observations,[]);}
 const corrupted=Buffer.from(zip(files()));corrupted[40]^=1;
 assert.equal(gtfsAdapter.parse(snapshot(corrupted),scope).coverage.state,'held_quality');
 assert.throws(()=>readGtfsFeed(new Uint8Array(GTFS_LIMITS.archiveBytes+1)),/archive limit/);
});

test('archives reject traversal, absolute paths, symlinks, duplicates and expansion bombs',()=>{
 for(const name of ['../stops.txt','/stops.txt','C:\\stops.txt','nested/stops.txt'])assert.equal(gtfsAdapter.parse(snapshot(zip({[name]:'x'})),scope).coverage.state,'held_quality');
 assert.equal(gtfsAdapter.parse(snapshot(zip(files(),{symlink:true})),scope).coverage.state,'held_quality');
 assert.equal(gtfsAdapter.parse(snapshot(zip({'bomb.txt':'x'.repeat(100_000)},{deflate:true})),scope).coverage.state,'held_quality');
 const duplicate=Buffer.from(zip({'aaaa.txt':'x','bbbb.txt':'y'}));
 for(let i=0;i<duplicate.length-8;i++)if(duplicate.subarray(i,i+8).toString()==='bbbb.txt')duplicate.write('aaaa.txt',i);
 assert.equal(gtfsAdapter.parse(snapshot(duplicate),scope).coverage.state,'held_quality');
});

test('discovery consumes native HTML and snapshot/scope-bound pagination without acquisition',()=>{
 const links=Array.from({length:18},(_,i)=>`<a href="/archive/gtfs-${i}.zip">GTFS</a>`).join(''),source=snapshot(links);
 const first=gtfsAdapter.discover(source,scope,null);assert.equal(first.resources.length,16);assert.equal(first.coverage.state,'partial');
 const second=gtfsAdapter.discover(source,scope,first.coverage.nextCursor);assert.equal(second.resources.length,2);assert.equal(second.coverage.nextCursor,null);
 assert.equal(gtfsAdapter.discover(snapshot(links+' '),scope,first.coverage.nextCursor).coverage.state,'held_quality');
 assert.equal(gtfsAdapter.discover(source,{...scope,observationWindow:'2026-11'},first.coverage.nextCursor).coverage.state,'held_quality');
 assert.ok(first.resources.every(row=>row.method==='GET'&&row.format==='gtfs'));
 assert.equal(gtfsAdapter.discover(snapshot('<p>Withdrawn from this landing</p>'),scope,null).coverage.state,'empty');
});

test('DELFI is registration-held, MV direct feed unresolved, passwords blocked and pilot boundary enforced',()=>{
 for(const call of ['parse','discover'] as const) {
  const source=snapshot(call==='parse'?zip(files()):'<a href="https://example.org/private.zip">download</a>');
  const invoke=(target:AdapterScope)=>call==='parse'?gtfsAdapter.parse(source,target):gtfsAdapter.discover(source,target,null);
  assert.equal(invoke({...scope,sourceId:'mobility-delfi-national-gtfs'}).coverage.state,'blocked_access');
  assert.equal(invoke({...scope,sourceId:'mobility-vmv-official-discovery',ags:'13076090'}).coverage.state,'not_checked');
  assert.equal(invoke({...scope,ags:'99999999'}).coverage.state,'not_applicable');
 }
 assert.equal(gtfsAdapter.discover(snapshot('<input type="password">'),scope,null).coverage.state,'blocked_access');
 const mismatched=snapshot(zip(files()));mismatched.sourceSha256='b'.repeat(64);assert.throws(()=>gtfsAdapter.parse(mismatched,scope),/byte binding/);
});
