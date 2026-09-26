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
