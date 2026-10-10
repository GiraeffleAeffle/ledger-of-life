import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {signal} from '../src/common.ts';
import {canonicalOparlUrl,councilId,deduplicateCitySignals,duplicateStats} from '../src/dedupe.ts';
import type {Signal} from '../src/schema.ts';

const source=(url:string,snapshotUrl:string)=>({url,snapshotUrl,title:'Public record',publisher:'City',locator:'record id',retrievedAt:'2026-09-26',sha256:'a'.repeat(64),snapshot:true,licence:'unknown',reuse:'facts_with_attribution' as const});
const council=(id:string,modified:string,title:string,snapshot:string)=>signal({id,cityId:'koeln',kind:'council_paper',category:'Ratsvorlage',title,statement:`Proposal: ${title}`,status:'decision unverified',startDate:'2026-09-24',endDate:null,nextStep:'Check council minutes',unknowns:['Decision pending'],scale:'city',geometryPrecision:'none',sources:[source(decodeURIComponent(id.slice(id.indexOf(':')+1)),snapshot)],extraction:{method:'structured'},reviewState:'candidate',asOf:modified,upstreamModified:modified},null);
const place=(id:string,title:string,category:string,coordinate:[number,number])=>signal({id,cityId:'koeln',kind:'place',category,title,statement:`OSM listing: ${title}`,status:'Unverified',startDate:null,endDate:null,nextStep:'Confirm locally',unknowns:['Opening hours'],scale:'street',geometryPrecision:id.startsWith('osm:node-')?'exact':'approximate',sources:[{...source(`https://www.openstreetmap.org/${id.slice(4).replace('-', '/')}`,`https://overpass-api.de/${id}`),licence:'ODbL 1.0',reuse:'open_licence' as const}],extraction:{method:'structured'},reviewState:'candidate',asOf:'2026-09-26'},{type:'Point',coordinates:coordinate});

test('CCF and live OParl URLs resolve to one stable council id; newer modified wins and both sources survive',()=>{
 const old=council('ccf:http%3A%2F%2Fexample.org%2Foparl%2Fpapers%2F42%2F','2026-09-21T10:00:00Z','Earlier title','https://github.com/komma-systems/ccf/blob/main/42.json');
 const fresh=council('oparl:https%3A%2F%2Fexample.org%2Foparl%2Fpapers%2F42','2026-09-25T11:00:00Z','Corrected title','https://example.org/oparl/papers?page=1');
 assert.equal(canonicalOparlUrl('http://example.org/oparl/papers/42/'),canonicalOparlUrl('https://example.org/oparl/papers/42'));
 assert.equal(duplicateStats([old,fresh]).councilUrl,1);
 for(const order of [[old,fresh],[fresh,old]]){
  const merged=deduplicateCitySignals(order);
  assert.equal(merged.length,1);
  assert.equal(merged[0].properties.id,councilId('https://example.org/oparl/papers/42'));
  assert.equal(merged[0].properties.title,'Corrected title');
  assert.equal(merged[0].properties.upstreamModified,'2026-09-25T11:00:00Z');
  assert.equal(merged[0].properties.sources.length,2);
  assert.deepEqual(new Set(merged[0].properties.sources.map(x=>x.snapshotUrl)),new Set([old.properties.sources[0].snapshotUrl,fresh.properties.sources[0].snapshotUrl]));
  assert.equal(duplicateStats(merged).councilUrl,0);
 }
});

const roadwork=(id:string,lon:number)=>signal({id,cityId:'koeln',kind:'roadworks',category:'A1',title:'A1 | Segment A',statement:'Roadwork notice',status:'planned',startDate:'2026-09-24',endDate:null,nextStep:'Verify current works',unknowns:['Actual execution'],scale:'street',geometryPrecision:'approximate',sources:[source(`https://verkehr.autobahn.de/o/autobahn/A1/services/roadworks/${id}`,`https://verkehr.autobahn.de/cache/${id}`)],extraction:{method:'structured'},reviewState:'candidate',asOf:'2026-09-26'},{type:'Point',coordinates:[lon,50.96]});

test('same title and day alone cannot erase distinct council objects or highway segments',()=>{
 const first=council('ccf:https%3A%2F%2Fexample.org%2Foparl%2Fpapers%2F41','2026-09-25T11:00:00Z','Sitzung','https://ccf.example.org/41');
 const second=council('oparl:https%3A%2F%2Fexample.org%2Foparl%2Fpapers%2F42','2026-09-25T11:00:00Z','Sitzung','https://oparl.example.org/42');
 const distinct=deduplicateCitySignals([first,second,roadwork('autobahn:1',6.96),roadwork('autobahn:2',6.98)]);
 assert.equal(distinct.length,4);
 assert.equal(duplicateStats(distinct).titleDate,2);
 assert.equal(duplicateStats(distinct).councilUrl,0);
});

test('node and nearby way of the same place merge evidence; distinct and distant places survive',()=>{
 const node=place('osm:node-7','Public Library','library',[6.96,50.96]);
 const way=place('osm:way-8','Public Library','library',[6.96008,50.96006]);
 const distant=place('osm:way-9','Public Library','library',[6.97,50.97]);
 const different=place('osm:way-10','Public Library','community_centre',[6.96008,50.96006]);
 assert.equal(duplicateStats([node,way,distant,different]).osmNodeWay,1);
 const merged=deduplicateCitySignals([node,way,distant,different]);
 assert.equal(merged.length,3);
 assert.deepEqual(merged.map(f=>f.properties.id),['osm:node-7','osm:way-10','osm:way-9']);
 assert.equal(merged[0].properties.geometryPrecision,'exact');
 assert.equal(merged[0].properties.sources.length,2);
 assert.equal(duplicateStats(merged).osmNodeWay,0);
});

const planning=(id:string,caseKey:string,date:string,geometry:Signal['geometry'],locator:string)=>signal({id,caseKey,cityId:'koeln',kind:'planning',category:'Bebauungsplan',title:`Bebauungsplan ${caseKey}`,statement:'Source plan boundary, not new construction',status:`rechtskräftig seit ${date}`,startDate:date,endDate:null,nextStep:'Check plan documents',unknowns:[locator],scale:'city',geometryPrecision:geometry?'area':'none',sources:[{...source('https://geoportal.stadt-koeln.de/arcgis/rest/services/planen_und_bauen/b_plan_uebersicht/MapServer/1','https://geoportal.stadt-koeln.de/arcgis/rest/services/planen_und_bauen/b_plan_uebersicht/MapServer/1/query'),locator}],extraction:{method:'structured'},reviewState:'auto_checked',asOf:'2026-10-10'},geometry);

test('authoritative case/date dedupe merges multipart polygons, holes and every row locator without title heuristics',()=>{
 const ring:[number,number][]=[[6.9,50.9],[6.91,50.9],[6.91,50.91],[6.9,50.9]],hole:[number,number][]=[[6.902,50.902],[6.903,50.902],[6.903,50.903],[6.902,50.902]],second:[number,number][]=[[7,51],[7.01,51],[7.01,51.01],[7,51]];
 const key='koeln-bplan:63419.02.000.00';
 const first=planning('koeln-bplan:15',key,'2020-12-02',{type:'Polygon',coordinates:[ring,hole]},'layer[oid=15]; Ausgleichsfläche eA1');
 const other=planning('koeln-bplan:16',key,'2020-12-02',{type:'MultiPolygon',coordinates:[[second],[ring,hole]]},'layer[oid=16]; Ausgleichsfläche eA3');
 const duplicate=planning('koeln-bplan:17',key,'2020-12-02',{type:'Polygon',coordinates:[ring,hole]},'layer[oid=17]');
 assert.equal(duplicateStats([first,other,duplicate]).planningCase,2);
 const merged=deduplicateCitySignals([first,other,duplicate]);
 assert.equal(merged.length,1);
 assert.equal(merged[0].properties.id,`${key}@2020-12-02`);
 assert.equal(merged[0].geometry?.type,'MultiPolygon');
 if(merged[0].geometry?.type==='MultiPolygon')assert.deepEqual(merged[0].geometry.coordinates,[[ring,hole],[second]]);
 assert.equal(merged[0].properties.sources.length,3);
 assert.equal(merged[0].properties.unknowns.length,3);
 assert.equal(merged[0].properties.geometryPrecision,'area');
 assert.notEqual(merged[0].properties.version,first.properties.version);
 assert.equal(duplicateStats(merged).planningCase,0);
});

test('legal-date versions, complete amendment IDs and authoritative Münster plan IDs remain distinct',()=>{
 const first=planning('koeln-bplan:227','koeln-bplan:59518.03.000.00','2008-12-10',null,'layer[oid=227]; 1. Bauabschnitt');
 const second=planning('koeln-bplan:380','koeln-bplan:59518.03.000.00','2011-11-16',null,'layer[oid=380]; 2. Bauabschnitt');
 const amendment=planning('koeln-bplan:55','koeln-bplan:58480.03.004.03','2013-04-24',null,'layer[oid=55]');
 const distinctAmendment=planning('koeln-bplan:107','koeln-bplan:58480.03.005.03','2013-04-24',null,'layer[oid=107]');
 const muensterFirst=planning('muenster-bplan:2','muenster-bplan:DE_05515000_St. Mauritz_8__2','1974-12-04',null,'planid=DE_05515000_St. Mauritz_8__2');
 const muensterSecond=planning('muenster-bplan:3','muenster-bplan:DE_05515000_St. Mauritz_8__3','1974-12-04',null,'planid=DE_05515000_St. Mauritz_8__3');
 assert.equal(deduplicateCitySignals([first,second,amendment,distinctAmendment,muensterFirst,muensterSecond]).length,6);
});

test('same source locator with different fetched byte hashes retains both provenance versions',()=>{
 const first=planning('koeln-bplan:15','koeln-bplan:63419.02.000.00','2020-12-02',null,'layer[oid=15]');
 const later=planning('koeln-bplan:15','koeln-bplan:63419.02.000.00','2020-12-02',null,'layer[oid=15]');
 later.properties.sources[0].sha256='b'.repeat(64);
 const merged=deduplicateCitySignals([first,later]);
 assert.equal(merged.length,1);
 assert.deepEqual(new Set(merged[0].properties.sources.map(s=>s.sha256)),new Set(['a'.repeat(64),'b'.repeat(64)]));
});
