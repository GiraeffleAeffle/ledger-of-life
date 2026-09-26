import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signal,sourceFrom,hash} from '../src/common.ts';
import {diff} from '../src/changes.ts';
import {near,along} from '../src/mcp.ts';
import type {Signal} from '../src/schema.ts';
const e={body:new Uint8Array([1]),sha256:hash(new Uint8Array([1])),retrievedAt:'2026-09-26',url:'https://example.org/data'};
function feature(id:string,geometry:Signal['geometry']):Signal{return signal({id:`test:${id}`,cityId:'koeln',kind:'roadworks',category:'road',title:'Road',statement:'A road closure.',status:'current',startDate:null,endDate:null,nextStep:'Check.',unknowns:[],scale:'street',geometryPrecision:geometry?'approximate':'none',sources:[sourceFrom(e,'Source','Publisher','item 1')],extraction:{method:'structured'},reviewState:'candidate',asOf:'2026-09-26'},geometry);}
test('version-aware diff distinguishes additions changes and removals',()=>{const old=[feature('a',{type:'Point',coordinates:[7,51]}),feature('b',null)];const revised=feature('a',{type:'Point',coordinates:[7.1,51]});assert.deepEqual(diff(old,[revised,feature('c',null)]),{added:['test:c'],changed:['test:a'],removed:['test:b']});});
test('near and along include interior polygons and intersecting segments but exclude citywide records',()=>{const point=feature('point',{type:'Point',coordinates:[7,51]}),citywide=feature('citywide',null),line=feature('line',{type:'LineString',coordinates:[[6.99,51],[7.01,51]]}),area=feature('area',{type:'Polygon',coordinates:[[[6.99,50.99],[7.01,50.99],[7.01,51.01],[6.99,51.01],[6.99,50.99]]]});const items=[point,citywide,line,area];assert.deepEqual(near(items,[7,51],100).map(f=>f.properties.id),['test:point','test:line','test:area']);assert.deepEqual(along(items,[[7,50.98],[7,51.02]],50).map(f=>f.properties.id),['test:point','test:line','test:area']);assert.deepEqual(near(items,[8,51],100),[]);});
