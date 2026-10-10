import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gmlFeatures,planningCaseKey,makeSignal} from '../src/geodata.ts';
import {geoFeeds} from '../src/geodata-registry.ts';
import {cities} from '../src/cities.ts';
test('GML fallback retains plan polygon rings and exact feature locator',()=>{const xml=`<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ms="http://mapserver.gis.umn.edu/mapserver" xmlns:gml="http://www.opengis.net/gml/3.2"><wfs:member><ms:bplan2 gml:id="bplan2.17"><ms:msGeometry><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>51 7 51 8 52 8 51 7</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></ms:msGeometry><ms:name>Testplan</ms:name></ms:bplan2></wfs:member></wfs:FeatureCollection>`;assert.deepEqual(gmlFeatures(xml,'ms:bplan2'),[{id:'bplan2.17',properties:{name:'Testplan'},geometry:{type:'Polygon',coordinates:[[[7,51],[8,51],[8,52],[7,51]]]}}]);});

test('Köln authoritative plan identity differs from geometry row OID and preserves full amendment suffix',()=>{
 const feed=geoFeeds.find(f=>f.id==='koeln-bplan')!,city=cities.find(c=>c.id==='koeln')!;
 assert.equal(planningCaseKey(feed,{oid:15,o_name:'63419.02.000.00'}),'koeln-bplan:63419.02.000.00');
 assert.equal(planningCaseKey(feed,{oid:16,o_name:'63419.02.000.00'}),'koeln-bplan:63419.02.000.00');
 assert.notEqual(planningCaseKey(feed,{o_name:'58480.03.004.03'}),planningCaseKey(feed,{o_name:'58480.03.005.03'}));
 assert.equal(planningCaseKey(feed,{oid:1428,o_name:null}),undefined);
 const evidence={body:new Uint8Array(),url:feed.url+'/query?f=geojson',retrievedAt:'2026-10-10T12:00:00Z',sha256:'a'.repeat(64)};
 const row=makeSignal(city,feed,{properties:{oid:15,o_name:'63419.02.000.00',arbeitstitel:'Ergänzung der Ausgleichsfläche',rechtskr:'2020-12-02',hinweis:'Ergänzung Ausgleichsfläche eA1',o_namemitpfad:'https://geoportal.stadt-koeln.de/BPlan-Public/63419.02.000.00.pdf'},geometry:{type:'Polygon',coordinates:[[[6.9,50.9],[6.91,50.9],[6.91,50.91],[6.9,50.9]]]}},0,evidence)!;
 assert.equal(row.properties.caseKey,'koeln-bplan:63419.02.000.00');
 assert.equal(row.properties.startDate,'2020-12-02');
 assert.match(row.properties.sources[0].locator,/oid=15/);
 assert.match(row.properties.sources[0].locator,/rechtskr=2020-12-02/);
 assert.match(row.properties.sources[0].locator,/Ausgleichsfläche eA1/);
 assert.equal(row.properties.sources[0].sha256,evidence.sha256);
 assert.equal(row.properties.sources[1].snapshot,false);
 assert.equal(row.properties.sources[1].sha256,null);
 assert.equal(row.properties.sources[1].licence,'unknown');
});

test('Münster similarly titled plans retain source plan IDs rather than title-only identity',()=>{
 const feed=geoFeeds.find(f=>f.id==='muenster-bplan')!;
 assert.notEqual(planningCaseKey(feed,{planid:'DE_05515000_Albachten_7_A_',name:'Nördlich der B 51 / Östlich der L 1156 (L 529)'}),planningCaseKey(feed,{planid:'DE_05515000_Albachten_7_B_',name:'Nördlich der B 51 / Östlich der L 1156 (L 529)'}));
 assert.notEqual(planningCaseKey(feed,{planid:'DE_05515000_St. Mauritz_8__2'}),planningCaseKey(feed,{planid:'DE_05515000_St. Mauritz_8__3'}));
});
