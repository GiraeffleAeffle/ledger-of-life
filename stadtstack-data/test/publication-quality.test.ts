import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionSchema} from '../src/schema.ts';
import {signal} from '../src/common.ts';
import {assertPublicUrls,isPublicUrl,publicUrlIssues,parseSourceDate,normalizePublicationSignals} from '../src/publication-quality.ts';

const feature=(id:string,startDate:string|null,kind:'planning'|'place'|'council_meeting'='planning',endDate:string|null=null)=>signal({id,cityId:'koeln',kind,category:'Fixture',title:'Source fixture',statement:'Source-derived fixture',status:'unverified',startDate,endDate,nextStep:'Check source',unknowns:[],scale:'city',geometryPrecision:'none',sources:[{url:'https://www.stadt-koeln.de/',title:'Public source',publisher:'Stadt Köln',locator:'source record',retrievedAt:'2026-10-10T12:00:00Z',sha256:null,snapshot:false,licence:'unknown',reuse:'facts_with_attribution'}],extraction:{method:'structured'},reviewState:'candidate',asOf:'2026-10-10T12:00:00Z'},null);

test('public URL gate rejects private hosts, obfuscated addresses, internal schemes and credentials',()=>{
 for(const url of ['http://localhost:4317/api/atlas/strausberg','https://LOCALHOST./map','http://atlas.internal/x','http://printer/x','http://127.1/x','http://2130706433/x','http://0x7f000001/x','http://10.1.2.3/x','http://172.16.0.1/x','http://192.168.1.1/x','http://100.64.1.1/x','http://169.254.169.254/x','http://192.0.2.1/x','http://[::1]/x','http://[fc00::1]/x','http://[fe80::1]/x','http://[::ffff:127.0.0.1]/x','http://[2001:db8::1]/x','file:///tmp/snapshot','s3://private-bucket/file','data:text/plain,source','https://user:password@example.org/x','https://example.org/x?access_token=fixture'])assert.equal(isPublicUrl(url),false,url);
 for(const url of ['https://www.stadt-koeln.de/','https://bb.beteiligung.diplanung.de/verfahren/solarpark-flugplatz/public/detail','https://raw.githubusercontent.com/GiraeffleAeffle/ledger-of-life/main/README.md','https://8.8.8.8/','https://[2001:4860:4860::8888]/'])assert.equal(isPublicUrl(url),true,url);
});

test('URL gate visits catalogue, geometry sources, snapshots, references and free-text links without leaking rejected values',()=>{
 const value={cities:[{sources:[{url:'https://example.org/public',snapshotUrl:'http://localhost:4317/private'}]}],geometrySourceUrl:'http://10.1.2.3/polygon',nested:{source:'file:///private/fixture'},locator:'see http://atlas.internal/doc'};
 assert.equal(publicUrlIssues(value).length,4);
 assert.throws(()=>assertPublicUrls(value),/Nonpublic publication URL at cities\[0\].sources\[0\].snapshotUrl/);
 try{assertPublicUrls(value);}catch(error){assert.equal(String(error).includes('http://localhost'),false);}
});

test('only documented catalogue distribution keys allow safe relative release paths',()=>{
 assertPublicUrls({cities:[{id:'koeln',feedUrl:'cities/koeln/feed.json',minUrl:'cities/koeln/signals.min.geojson',sources:[{url:'https://www.stadt-koeln.de/'}]}]});
 for(const value of [{url:'cities/koeln/feed.json'},{feedUrl:'../private/feed.json'},{minUrl:'//localhost/signals.min.geojson'},{feedUrl:'cities/../secret/feed.json'},{feedUrl:'http://localhost:4317/feed.json'}])assert.throws(()=>assertPublicUrls(value));
});

test('source date parsing validates calendar days and requires explicit numeric epoch units',()=>{
 assert.equal(parseSourceDate('2026-10-10'),'2026-10-10');
 assert.equal(parseSourceDate('2026/02/23 00:00:00'),'2026-02-23');
 assert.equal(parseSourceDate('31.10.2012'),'2012-10-31');
 assert.equal(parseSourceDate('02-12-2020'),'2020-12-02');
 assert.equal(parseSourceDate(Date.UTC(2022,9,26),'milliseconds'),'2022-10-26');
 assert.equal(parseSourceDate(Date.UTC(2022,9,26)/1000,'seconds'),'2022-10-26');
 for(const raw of ['2026-02-30','31.04.2026','2026-13-01','2026-09','2026','unknown','1690000000',Date.UTC(2022,9,26),Infinity,null])assert.equal(parseSourceDate(raw),null,String(raw));
});

test('strict comparable date gate explicitly quarantines undated records but retains OSM observation semantics',()=>{
 const input=[feature('plan:dated','2026-10-01'),feature('plan:undated',null),feature('plan:invalid','2026-02-30'),feature('plan:reversed','2026-10-10','planning','2026-10-09'),feature('osm:node-7',null,'place')];
 const result=normalizePublicationSignals(input);
 assert.deepEqual(result.counts,{input:5,deduplicated:5,published:2,quarantined:3});
 assert.deepEqual(result.quarantined,[{id:'plan:undated',cityId:'koeln',reason:'missing_sourced_start_date'},{id:'plan:invalid',cityId:'koeln',reason:'invalid_sourced_start_date'},{id:'plan:reversed',cityId:'koeln',reason:'end_before_start'}]);
 assert.equal(result.features.find(x=>x.properties.id==='osm:node-7')?.properties.temporalBasis,'observation');
 assert.equal(result.features.find(x=>x.properties.id==='osm:node-7')?.properties.startDate,null);
 assert.equal(input[0].properties.temporalBasis,undefined);
});

test('meeting ISO precision and offsets survive normalization, reversed precise ranges do not',()=>{
 const good=feature('meeting:1','2026-10-10T18:00:00+02:00','council_meeting','2026-10-10T17:00:00Z');
 const reversed=feature('meeting:2','2026-10-10T18:00:00+02:00','council_meeting','2026-10-10T15:00:00Z');
 const result=normalizePublicationSignals([good,reversed]);
 assert.equal(result.features[0].properties.startDate,good.properties.startDate);
 assert.equal(result.features[0].properties.endDate,good.properties.endDate);
 assert.equal(result.quarantined[0].reason,'end_before_start');
});

test('unsafe source references fail publication rather than disappear silently',()=>{
 const unsafe=feature('plan:unsafe','2026-10-10');unsafe.properties.sources[0].snapshotUrl='http://localhost:4317/raw';
 assert.throws(()=>normalizePublicationSignals([unsafe]),/nonpublic_hostname/);
});

test('place exemption still requires an actual asOf and a sourced observation retrieval date',()=>{
 const asOfMissing=feature('osm:node-8',null,'place');asOfMissing.properties.asOf='';
 const asOfInvalid=feature('osm:node-9',null,'place');asOfInvalid.properties.asOf='2026-02-30';
 const retrievalMissing=feature('osm:node-10',null,'place');retrievalMissing.properties.sources[0].retrievedAt='unknown';
 const result=normalizePublicationSignals([asOfMissing,asOfInvalid,retrievalMissing]);
 assert.equal(result.features.length,0);
 assert.deepEqual(result.quarantined.map(q=>q.reason),['missing_observation_asof','invalid_observation_asof','missing_sourced_observation_date']);
});

test('quality normalization preserves real hash-bound core versions and verification evidence unchanged',async()=>{
 const collection=collectionSchema.parse(JSON.parse(await readFile(new URL('../out/cities/strausberg/signals.geojson',import.meta.url),'utf8')));
 const core=collection.features.filter(f=>f.properties.assertion&&f.properties.verification);
 assert.equal(core.length,3);
 const normalized=normalizePublicationSignals(core);
 assert.equal(normalized.quarantined.length,0);
 for(const before of core){
  const after=normalized.features.find(f=>f.properties.id===before.properties.id)!;
  assert.equal(after,before);
  assert.equal(after.properties.version,before.properties.version);
  assert.deepEqual(after.properties.assertion,before.properties.assertion);
  assert.deepEqual(after.properties.verification,before.properties.verification);
 }
});
