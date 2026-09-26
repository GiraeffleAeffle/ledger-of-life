import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {booleanValid} from '@turf/boolean-valid';
import {signal} from '../src/common.ts';
import {compactCollection} from '../src/min.ts';
import type {Signal} from '../src/schema.ts';

const source={url:'https://example.org/plan',title:'Official plan',publisher:'City',locator:'oid=7',retrievedAt:'2026-09-26',sha256:null,snapshot:false,licence:'dl-de/by-2-0',reuse:'open_licence' as const};
const properties=(id:string):Omit<Signal['properties'],'version'>=>({id,cityId:'koeln',kind:'planning',category:'binding',title:'Plan area',statement:'The city lists a binding plan.',status:'legally binding',startDate:null,endDate:null,nextStep:'Inspect the original plan.',unknowns:['Possible amendments'],scale:'neighbourhood',geometryPrecision:'area',sources:[source,{...source,url:'https://example.org/amendment',locator:'amendment 1'}],extraction:{method:'llm',model:'codex',faithfulness:{score:1,threshold:.8,reason:'Supported',evaluator:'DeepEval'}},reviewState:'auto_checked',asOf:'2026-09-26'});
const circle:[number,number][]=Array.from({length:101},(_,i)=>[13.5+.001*Math.cos(i*2*Math.PI/100),52.5+.0006*Math.sin(i*2*Math.PI/100)]);
const tiny:[number,number][]=[[13.51,52.51],[13.510001,52.51],[13.51,52.510001],[13.51,52.51]];

test('compact map keeps every signal, rounds topology, and drops only sub-grid components',()=>{
 const first=signal(properties('plan:7'),{type:'MultiPolygon',coordinates:[[[...circle]],[[...tiny]]]});
 const second=signal({...properties('plan:8'),geometryPrecision:'none'},null);
 const full={type:'FeatureCollection' as const,features:[first,second]};
 const compact=compactCollection(full);
 assert.deepEqual(compact.features.map(f=>f.properties.id),full.features.map(f=>f.properties.id));
 assert.deepEqual(compact.features.map(f=>f.properties.version),full.features.map(f=>f.properties.version));
 assert.equal(compact.features[1].geometry,null);
 const geometry=compact.features[0].geometry;
 assert.equal(geometry?.type,'MultiPolygon');
 if(geometry?.type!=='MultiPolygon')return;
 assert.equal(booleanValid(geometry),true);
 assert.equal(geometry.coordinates.length,1);
 assert.ok(geometry.coordinates[0][0].length<circle.length/2);
 assert.deepEqual(geometry.coordinates[0][0][0],geometry.coordinates[0][0].at(-1));
 for(const polygon of geometry.coordinates)for(const ring of polygon)for(const point of ring)for(const number of point)assert.equal(number,Number(number.toFixed(5)));
 assert.equal(first.geometry?.type,'MultiPolygon');
 assert.equal(first.geometry.coordinates.length,2);
});

test('compact provenance is attributed but excludes full locators and reasoning',()=>{
 const full=signal(properties('plan:7'),{type:'Point',coordinates:[13.50000149,52.50000499]});
 const compact=compactCollection({type:'FeatureCollection',features:[full]}).features[0];
 assert.deepEqual(compact.geometry,{type:'Point',coordinates:[13.5,52.5]});
 assert.equal(compact.properties.sourceCount,2);
 assert.deepEqual(compact.properties.primarySource,{url:source.url,title:source.title,publisher:source.publisher,licence:source.licence,reuse:source.reuse});
 assert.deepEqual(compact.properties.faithfulness,{score:1,threshold:.8});
 assert.equal('sources' in compact.properties,false);
 assert.equal('extraction' in compact.properties,false);
 assert.equal('unknowns' in compact.properties,false);
 assert.equal(JSON.stringify(full).includes('Possible amendments'),true);
});
