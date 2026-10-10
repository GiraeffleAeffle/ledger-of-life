import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {signal,sourceFrom,hash,outDir} from '../src/common.ts';
import {catalogueSchema,collectionSchema,type Catalogue,type Signal} from '../src/schema.ts';
import {QueryIndex,regionalSchema,querySchema,queryFields,publicData,type Regional} from '../src/mcp-query.ts';
import {assignTopics,assertTopic} from '../src/topics.ts';
import {searchText} from '../src/mcp.ts';

const catalogue:Catalogue={schemaVersion:'stadtstack-signals-v1',generatedAt:'2026-10-10T12:00:00Z',publisher:'Test',cities:[{id:'strausberg',name:'Strausberg',state:'Brandenburg',center:[13.88,52.58],bbox:[13,52,14,53],sources:[]}]};
const regional:Regional={schemaVersion:'stadtstack-regional-topics-v1',generatedAt:'2026-10-09T12:00:00Z',asOf:'2026-10-09',region:{id:'brandenburg-mol',name:'Märkisch-Oderland'},municipalities:[{id:'hoppegarten',name:'Hoppegarten',ags:'12064227'},{id:'strausberg',name:'Strausberg',ags:'12064472'}],topics:[{id:'waermeplanung',label:'Kommunale Wärmeplanung',municipalities:[{municipalityId:'hoppegarten',stage:'planning',items:[{title:'Kommunale Wärmeplanung in Hoppegarten',url:'https://www.gemeinde-hoppegarten.de/news/1/1240589/nachrichten/kommunale-w%C3%A4rmeplanung-in-hoppegarten.html',date:'2026-05-27',sourceType:'cityWebsite',locator:'Veröffentlichung: 27. Mai 2026',stage:'planning'},{title:'Wärmeplanung und Wärmenetz: Datum offen',url:'https://www.gemeinde-hoppegarten.de/seite/864034/kommunale-w%C3%A4rmeplanung.html',date:null,sourceType:'cityWebsite',locator:'Planung; kein dokumentiertes Datum',stage:'planning'}]}]}]};
function feature(id:string,title:string,kind:Signal['properties']['kind']='planning',date:string|null='2026-09-01') {
  const bytes=new Uint8Array([1]);
  return signal({id:`test:${id}`,cityId:'strausberg',kind,category:'Verkehr & Infrastruktur',title,statement:title,status:'Quelle prüfen',startDate:date,endDate:null,nextStep:'Quelle prüfen',unknowns:[],scale:'city',geometryPrecision:'none',sources:[sourceFrom({body:bytes,sha256:hash(bytes),retrievedAt:'2026-10-09',url:'https://example.org/source'},'Document','Publisher',`item ${id}`)],extraction:{method:'structured'},reviewState:'candidate',asOf:'2026-10-09'},null);
}
function index() {
  return new QueryIndex('a'.repeat(64),'2026-10-10T12:00:00Z',[feature('solar','Solarpark am Flugplatz'),feature('heat','Am Biotop · Fernwärmeleitung'),feature('pv','Photovoltaik auf kommunalen Gebäuden','council_paper'),feature('undated','Solarpark ohne Quelldatum','planning',null),feature('place','Solar Sportplatz','place',null)],regional,catalogue);
}

test('shared topics match subject text, not category or planning record type',()=>{
  const query=index();
  assert.equal(query.page({topic:'solarpark'},'search_topics').total,1);
  assert.equal(query.page({topic:'waermeplanung'},'search_topics').total,2);
  assert.equal(query.page({query:'Solar'},'search_topics').total,3);
  assert.equal(query.page({query:'Solar',excludePlaces:true},'search_topics').total,2);
  assert.deepEqual(searchText([feature('heat','Am Biotop · Fernwärmeleitung')],undefined,'waermeplanung').map(item=>item.properties.id),['test:heat']);
  assert.throws(()=>assertTopic('planning'),/record types/);
  assert.throws(()=>query.page({topic:'does-not-exist'},'search_topics'),/Unknown topic/);
  assert.throws(()=>query.page({cityIds:['does-not-exist']},'search_topics'),/Unknown city/);
  const tag=assignTopics('Fernwärmeleitung Am Biotop',['source:one'])[0];
  assert.equal(tag.id,'waermeplanung');assert.equal(tag.assignment,'rule');assert.ok(tag.evidence.includes('Fernwärmeleitung'));assert.deepEqual(tag.sourceIds,['source:one']);assert.equal('confidence' in tag,false);
});
test('regional municipalities appear in main search without invented catalogue coverage',()=>{
  const query=index();
  const page=query.page({cityIds:['hoppegarten'],topic:'waermeplanung'},'search_topics');
  assert.equal(page.total,1);assert.equal(page.items[0].cityId,'hoppegarten');assert.match(String(page.items[0].id),/^regional:[a-f0-9]{64}$/);
  assert.equal(query.municipalities.get('hoppegarten')?.coverage,'regional_evidence_only');
  assert.equal(query.listTopics(['hoppegarten']).topics.find(topic=>topic.id==='waermeplanung')?.perCity[0].count,1);
  assert.equal(query.listTopics(['hoppegarten']).topics.find(topic=>topic.id==='waermeplanung')?.perCity[0].withheldCount,1);
  const discovery=query.page({cityIds:['hoppegarten'],fields:['id','eventDate','asOf','comparisonEligible','comparisonReason']},'get_regional_topics',query.records.filter(item=>item.origin==='regional'),null,true);
  assert.equal(discovery.total,2);assert.ok(discovery.items.some(item=>item.eventDate===null&&item.comparisonEligible===false&&item.asOf==='2026-10-09'));
  assert.equal(query.page({cityIds:['hoppegarten'],dateFrom:'2026-01-01'},'get_regional_topics',query.records.filter(item=>item.origin==='regional'),null,true).total,1);
});
test('cursor is signed and bound to whole release, tool, filters, limit and projection',()=>{
  const query=index(),options={limit:1,fields:['id','sourceIds'] as ('id'|'sourceIds')[]};
  const first=query.page(options,'search_topics'),firstCursor=first.nextCursor;assert.ok(firstCursor);
  const second=query.page({...options,cursor:firstCursor},'search_topics');assert.notEqual(first.items[0].id,second.items[0].id);
  assert.throws(()=>query.page({...options,cursor:firstCursor,query:'Solar'},'search_topics'),/mismatch/);
  assert.throws(()=>query.page({...options,cursor:firstCursor,limit:2},'search_topics'),/mismatch/);
  assert.throws(()=>query.page({...options,cursor:firstCursor,fields:['title']},'search_topics'),/mismatch/);
  assert.throws(()=>query.page({...options,cursor:firstCursor},'get_council_items'),/mismatch/);
  assert.throws(()=>new QueryIndex('b'.repeat(64),query.releasedAt,[],regional,catalogue).page({...options,cursor:firstCursor},'search_topics'),/mismatch/);
  const [payload,signature]=firstCursor.split('.');
  const tampered=`${payload}.${signature[0]==='A'?'B':'A'}${signature.slice(1)}`;
  assert.throws(()=>query.page({...options,cursor:tampered},'search_topics'),/Invalid/);
  for(const cursor of ['bad','{}','a.b.c'])assert.throws(()=>query.page({...options,cursor},'search_topics'),/Invalid/);
  const decoded=JSON.parse(Buffer.from(payload,'base64url').toString());assert.deepEqual(Object.keys(decoded).sort(),['after','binding','release','v']);assert.equal(decoded.release,'a'.repeat(64));
  const seen:string[]=[];let cursor:string|null=null;
  do {const page=query.page({...options,cursor:cursor??undefined},'search_topics');seen.push(...page.items.map(item=>String(item.id)));cursor=page.nextCursor;}while(cursor);
  assert.equal(new Set(seen).size,seen.length);assert.equal(seen.length,query.page({},'search_topics').total);
});
test('bounded projections and separate source IDs avoid duplicate attribution payloads',()=>{
  const query=index(),page=query.page({fields:['id','sourceIds']},'search_topics');
  assert.deepEqual(Object.keys(page.items[0]).sort(),['id','sourceIds']);
  for(const record of query.records)for(const sourceId of record.sourceIds)assert.ok(query.sources.get(sourceId));
  assert.equal(JSON.stringify(query.page({fields:[...queryFields]},'search_topics')).includes('"sources":'),false);
  assert.equal(querySchema.safeParse({offset:1}).success,false);
  assert.equal(querySchema.safeParse({fields:['sources']}).success,false);
  assert.equal(querySchema.safeParse({limit:51}).success,false);
  assert.equal(querySchema.safeParse({dateFrom:'2026-02-30'}).success,false);
  assert.throws(()=>query.page({dateFrom:'2026-10-10',dateTo:'2026-01-01'},'search_topics'),/dateFrom/);
  assert.deepEqual(publicData({url:'http://localhost:4317/private',safe:'https://www.stadt-strausberg.de/'}),{url:null,safe:'https://www.stadt-strausberg.de/'});
  assert.deepEqual(publicData({id:'atlas:solarpark',url:'javascript:alert(1)',snapshotUrl:'https://example.org/?access_token=not-a-credential',feedUrl:'cities/strausberg/feed.json'}),{id:'atlas:solarpark',url:null,snapshotUrl:null,feedUrl:'cities/strausberg/feed.json'});
  const measurement=new QueryIndex('a'.repeat(64),'2026-10-10T12:00:00Z',[feature('measurement','Historische Messung','measurement','2026-09-14')],regional,catalogue).records.find(record=>record.recordType==='measurement')!;
  assert.equal(measurement.dateSemantics,'source_event');assert.equal(measurement.eventDate,'2026-09-14');
  const place=query.records.find(record=>record.recordType==='place')!;assert.equal(place.dateSemantics,'observation');assert.equal(place.eventDate,null);assert.equal(place.comparisonEligible,true);
});
test('source families remain distinct from record types',()=>{
  const plan=feature('plan','Bebauungsplan');plan.properties.id='koeln-bplan:fixture';
  const road=feature('road','Baustelle','roadworks');road.properties.id='autobahn:fixture';
  const query=new QueryIndex('a'.repeat(64),'2026-10-10T12:00:00Z',[plan,road],regional,catalogue);
  assert.deepEqual(query.records.find(record=>record.id===plan.properties.id)!.sourceTypes,['arcgis-rest']);
  assert.equal(query.page({sourceTypes:['arcgis-rest'],recordTypes:['planning']},'search_topics').total,1);
  assert.equal(query.page({sourceTypes:['autobahn']},'search_topics').total,1);
  assert.throws(()=>query.page({sourceTypes:['planning']},'search_topics'),/Unknown source type/);
});
test('source-derived regional identities are stable across topic arrays and never collapse by title',()=>{
  const item=regional.topics[0].municipalities[0].items[0];
  const extra:Regional={...regional,topics:[...regional.topics,{id:'solarpark',label:'Solarpark',municipalities:[{municipalityId:'hoppegarten',stage:item.stage,items:[item,{...item,url:'https://www.gemeinde-hoppegarten.de/news/other'}]}]}]};
  const query=new QueryIndex('a'.repeat(64),'2026-10-10T12:00:00Z',[],extra,catalogue);
  assert.equal(query.records.length,3);
  const first=query.records.find(record=>record.sourceIds.includes(index().records.find(record=>record.origin==='regional'&&record.eventDate!==null)!.sourceIds[0]))!;
  assert.deepEqual(first.topics.map(topic=>topic.id).sort(),['solarpark','waermeplanung']);
});
test('released JSON supports known subjects and Hoppegarten in shared search',async()=>{
  const cat=catalogueSchema.parse(JSON.parse(await readFile(join(outDir,'catalogue.json'),'utf8'))),features:Signal[]=[];
  for(const city of cat.cities)features.push(...collectionSchema.parse(JSON.parse(await readFile(join(outDir,'cities',city.id,'signals.geojson'),'utf8'))).features);
  const region=regionalSchema.parse(JSON.parse(await readFile(join(outDir,'regions/brandenburg-mol/topics.json'),'utf8')));
  const query=new QueryIndex('c'.repeat(64),cat.generatedAt,features,region,cat);
  assert.ok(query.page({topic:'solarpark'},'search_topics').total>0);
  assert.ok(query.page({topic:'waermeplanung'},'search_topics').total>0);
  assert.ok(query.page({cityIds:['hoppegarten']},'search_topics').total>0);
  assert.throws(()=>query.page({topic:'planning'},'search_topics'),/Unknown topic/);
});
