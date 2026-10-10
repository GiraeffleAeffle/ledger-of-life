import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertSourceHealth,sourceHealth,retainCouncilSnapshot} from '../src/source-health.ts';
import {normalizeRegionalPublication} from '../src/regional-quality.ts';
import {cities} from '../src/cities.ts';
import type {Catalogue,FeatureCollection,Signal} from '../src/schema.ts';

function fixture():Catalogue{
 const city=cities.find(c=>c.id==='duesseldorf')!;
 return {schemaVersion:'stadtstack-signals-v1',generatedAt:'2026-10-10T00:00:00Z',publisher:'Test fixture',cities:[{id:city.id,name:city.name,state:city.state,center:city.center,bbox:city.bbox,sources:[{
  id:'oparl-paper',kind:'council',publisher:'Test fixture',url:'https://ris-oparl.itk-rheinland.de/Oparl/bodies/0015/papers',licence:'unknown',reuse:'facts_with_attribution',retrievedAt:'2026-10-10T00:00:00Z',status:'ok',recordCount:1,publishedRecordCount:1,
  bodyBinding:{id:city.councilBodyId!,name:city.name,cityId:city.id,matched:true},
  coverage:{requestedStart:'2024-10-10',requestedEnd:'2026-10-10',observedStart:'2025-01-01',observedEnd:'2025-01-01',checkedAt:'2026-10-10T00:00:00Z',state:'complete'},
  licenceEvidence:{url:'https://ris-oparl.itk-rheinland.de/Oparl/system',checkedAt:'2026-10-10T00:00:00Z',note:'No recognised redistribution licence established.'},
 }]}]};
}

test('publication independently checks body name/id and zero-success claims',()=>{
 assert.doesNotThrow(()=>assertSourceHealth(fixture()));
 const wrongName=fixture();wrongName.cities[0].sources[0].bodyBinding!.name='Stadt Neuss';assert.throws(()=>assertSourceHealth(wrongName),/binding mismatch/);
 const wrongId=fixture();wrongId.cities[0].sources[0].bodyBinding!.id='https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009';assert.throws(()=>assertSourceHealth(wrongId),/binding mismatch/);
 const foreign={type:'FeatureCollection',features:[{properties:{kind:'council_paper',id:'council:'+encodeURIComponent('https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/papers/1')}}]} as FeatureCollection;
 assert.throws(()=>assertSourceHealth(fixture(),{duesseldorf:foreign}),/another body/);
 const empty=fixture();empty.cities[0].sources[0].recordCount=0;assert.throws(()=>assertSourceHealth(empty),/zero records/);
 const withheld=fixture();withheld.cities[0].sources[0].publishedRecordCount=0;assert.throws(()=>assertSourceHealth(withheld),/zero records/);
 const diagnosed=sourceHealth(fixture().cities[0].sources[0],[]);assert.equal(diagnosed.status,'withheld');assert.equal(diagnosed.licence,'unknown');assert.equal(diagnosed.publishedRecordCount,0);
});

test('regional comparison withholds missing or impossible event dates without substituting release time',()=>{
 const input={schemaVersion:'stadtstack-regional-topics-v1',generatedAt:'2026-10-10T00:00:00Z',asOf:'2026-09-27',coverage:{},topics:[{id:'waermeplanung',municipalities:[{municipalityId:'hoppegarten',items:[
  {title:'Dated fixture',url:'https://example.org/1',date:'2026-09-07',locator:'agenda'},
  {title:'Undated fixture',url:'https://example.org/2',date:null,locator:'page'},
  {title:'Impossible fixture',url:'https://example.org/3',date:'2026-02-30',locator:'page'},
 ]}]}]};
 const result=normalizeRegionalPublication(input);assert.equal(result.publishedRecords,1);assert.equal(result.quarantined.length,2);assert.equal(result.data.topics[0].municipalities[0].items[0].date,'2026-09-07');assert.equal(result.data.asOf,'2026-09-27');
});

test('Retained city snapshots keep bound rows unchanged, quarantine foreign identity and never freshen dates',()=>{
 const city=cities.find(city=>city.id==='duesseldorf')!,catalogue=fixture(),at='2026-09-28T00:00:00Z';
 // Synthetic projections contain only fields used by this offline identity repair.
 const row=(body:string):Signal=>({type:'Feature',geometry:null,properties:{id:'council:'+encodeURIComponent(body+'/papers/1'),kind:'council_paper',startDate:'2026-09-01',asOf:at,sources:[{url:body+'/papers/1',snapshotUrl:body+'/papers'}]}} as Signal);
 const good=row(city.councilBodyId!),foreign=row('https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009');
 const source={...catalogue.cities[0].sources[0],retrievedAt:at,coverage:undefined};
 const result=retainCouncilSnapshot(city,[good,foreign],[source,{...source,id:'old-foreign',url:'https://ris-oparl.itk-rheinland.de/Oparl/bodies/0009/papers'}]);
 assert.equal(result.features.length,1);assert.equal(result.features[0],good);assert.equal(result.quarantined[0].id,foreign.properties.id);
 assert.equal(result.sources[0].status,'partial');assert.equal(result.sources[0].coverage?.checkedAt,at);
 assert.equal(result.sources[0].coverage?.requestedStart,null);assert.equal(result.sources[0].retrievedAt,at);
 assert.equal(result.sources[1].status,'failed');assert.equal(result.sources[1].bodyBinding,undefined);
 catalogue.cities[0].sources=result.sources;
 assert.doesNotThrow(()=>assertSourceHealth(catalogue,{duesseldorf:{type:'FeatureCollection',features:result.features}}));
 const empty=retainCouncilSnapshot(city,[],[{...source,recordCount:0}]);
 assert.equal(empty.sources[0].status,'not_checked');assert.match(empty.sources[0].coverage!.reason!,/upstream-empty/);
});
