import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signal} from '../src/common.ts';
import {ATLAS_PUBLIC_PROVENANCE_URL,atlasEventDate,normalizeRetainedAtlasSignals,publicAtlasCatalogueSources} from '../src/atlas.ts';
import type {AtlasProject} from '../src/atlas.ts';
import {assertPublicUrls,normalizePublicationSignals} from '../src/publication-quality.ts';

const project:AtlasProject={id:'fixture',title:'Fixture',stage:'planning',summary:'Source-derived fixture',status:'unverified',sources:[{id:'city',title:'City source',url:'https://www.stadt-strausberg.de/bauleitplanung-2/'}],milestones:[{date:'2025-11-07',kind:'recorded',label:'Recorded decision',source:'city'},{date:'2026-12-31',kind:'scheduled',label:'Target completion',source:'city'},{date:'2026-09-01',kind:'document',label:'Document date only',source:'city'}]};
const retained=signal({id:'atlas:fixture',cityId:'strausberg',kind:'planning',category:'Fixture',title:'Fixture',statement:'Local interpretation with primary citation',status:'unverified',startDate:null,endDate:null,nextStep:'Check primary evidence',unknowns:[],scale:'city',geometryPrecision:'area',sources:[{url:project.sources[0].url,title:'City source',publisher:'Stadt Strausberg',locator:'Original source locator',retrievedAt:'2026-09-28T18:37:21.572Z',sha256:null,snapshot:false,licence:'unknown',reuse:'facts_with_attribution'}],extraction:{method:'structured'},reviewState:'candidate',asOf:'2026-09-05'},{type:'Polygon',coordinates:[[[13.88,52.58],[13.89,52.58],[13.89,52.59],[13.88,52.58]]]});

test('Atlas event date selects source-linked recorded events, never target/document/latest/asOf dates',()=>{
 assert.deepEqual(atlasEventDate(project),{date:'2025-11-07',sourceId:'city',label:'Recorded decision'});
 assert.equal(atlasEventDate({...project,milestones:[{date:'2025-11',kind:'recorded',label:'Month-only observation',source:'city'}]}),null);
 assert.equal(atlasEventDate({...project,milestones:[{date:'2025-11-07',kind:'recorded',label:'Unbound event',source:'missing'}]}),null);
 assert.deepEqual(atlasEventDate({...project,consultation:{start:'2026-08-17',end:'2026-09-20',url:'https://bb.beteiligung.diplanung.de/verfahren/altstadtquartier-srb/public/detail'}}),{date:'2026-08-17',label:'consultation.start'});
});

test('retained Atlas normalization preserves polygon and primary locator, and distinguishes research snapshot hash from local derivation hash',()=>{
 const research={body:new Uint8Array(),url:ATLAS_PUBLIC_PROVENANCE_URL,retrievedAt:'2026-10-10T12:00:00Z',sha256:'b'.repeat(64)};
 const normalized=normalizeRetainedAtlasSignals([retained],[project],research,'a'.repeat(64));
 assert.equal(normalized[0].geometry,retained.geometry);
 assert.equal(normalized[0].properties.startDate,'2025-11-07');
 assert.match(normalized[0].properties.sources[0].locator,/Original source locator; sourced event 2025-11-07/);
 const method=normalized[0].properties.sources[1];
 assert.equal(method.url,ATLAS_PUBLIC_PROVENANCE_URL);
 assert.equal(method.sha256,research.sha256);
 assert.match(method.locator,/local curated register SHA-256 a{64}/);
 assert.equal(method.snapshot,true);
 assertPublicUrls(normalized);
 assert.equal(retained.properties.startDate,null);
 const undated=normalizeRetainedAtlasSignals([retained],[{...project,milestones:[]}],research,'a'.repeat(64));
 assert.equal(normalizePublicationSignals(undated).quarantined[0].reason,'missing_sourced_start_date');
});

test('known local Atlas catalogue URLs become real public committed method provenance, not invented hosted endpoints',()=>{
 const sources=[{id:'atlas',url:'http://localhost:4317/api/atlas/strausberg'},{id:'atlas-map',url:'http://localhost:4317/api/atlas/strausberg/map'},{id:'primary',url:'https://www.stadt-strausberg.de/'}];
 const normalized=publicAtlasCatalogueSources(sources);
 assert.deepEqual(normalized.map(s=>s.url),[ATLAS_PUBLIC_PROVENANCE_URL,ATLAS_PUBLIC_PROVENANCE_URL,sources[2].url]);
 assertPublicUrls(normalized);
 assert.equal(sources[0].url,'http://localhost:4317/api/atlas/strausberg');
});
