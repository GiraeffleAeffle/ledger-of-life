import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,digest,observation,type AdapterCoverage,type StructuredObservation} from '../src/district-adapter-contract.ts';
import {STRUCTURED_WORKER_VERSION,StructuredSnapshotMetadataSchema,StructuredWorkerRequestSchema,StructuredInputBundleSchema,StructuredOutputPageSchema,pageStructuredResult,structuredAdapterFor,type StructuredWorkerRequest} from '../src/district-structured-parser-worker.ts';

const snapshot={sourceSha256:digest('synthetic native source'),url:'https://example.org/native.json',mimeType:'application/json',retrievedAt:'2026-10-11T00:00:00.000Z',policyReceiptSha256:digest('synthetic policy receipt'),sourceVersion:'fixture-v1',request:{method:'GET' as const,body:null,contentType:null}};
const scope={publisherId:'fixture-publisher',sourceId:'fixture-source',municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'2026-10-11'};
const request:StructuredWorkerRequest={version:STRUCTURED_WORKER_VERSION,operation:'parse',adapter:'genesis',options:{},scope,cursor:null,snapshot,inputArtifactSha256:snapshot.sourceSha256,auxiliary:[]};
const coverage:AdapterCoverage={state:'complete',scope:'fixture municipality',reason:'Synthetic source fully parsed',checkedAt:snapshot.retrievedAt,nextCursor:null,observedRows:3,limitations:[]};
function row(nativeId:string,value='synthetic native value'):StructuredObservation{
 return observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId,nativeVersion:'1',kind:'StatisticalObservation',subject:`fixture:${nativeId}`,predicate:'population',value,unit:'persons',date:'2024',dateRole:'reference_period',financialRole:'none',geography:{ags:scope.ags,basis:'source_explicit',role:'administrative_area'},sourceReferenceDate:'2024',publishedAt:null,retrievedAt:snapshot.retrievedAt,evidence:[{sourceSha256:snapshot.sourceSha256,format:'json',nativeId,path:`/records/${nativeId}/value`,sheet:null,rowKey:nativeId,cells:['value'],rawValue:'synthetic native value',schemaHash:digest('synthetic schema'),mappingVersion:'synthetic-mapping-v1'}],limitations:[]});
}

 test('worker request admits only fixed adapters and strict secret-free metadata transport',()=>{
 assert.deepEqual(StructuredWorkerRequestSchema.parse(request),request);
 for(const patch of [{version:'other'},{operation:'execute'},{adapter:'../arbitrary-module.ts'},{inputArtifactSha256:'bad'},{extra:'unknown'},{scope:{...scope,ags:'1053100'}},{auxiliary:[{slot:'arbitrary',snapshot}]}])assert.equal(StructuredWorkerRequestSchema.safeParse({...request,...patch}).success,false);
 for(const patch of [{sourceSha256:'bad'},{url:'not-a-url'},{retrievedAt:'yesterday'},{policyReceiptSha256:'bad'},{bytes:'embedded input'},{request:{...snapshot.request,Authorization:'synthetic-secret'}}])assert.equal(StructuredSnapshotMetadataSchema.safeParse({...snapshot,...patch}).success,false);
 for(const slot of ['municipalBoundaries','stationSnapshot'] as const){
  const auxiliary=[{slot,snapshot:{...snapshot,sourceSha256:digest(slot),url:`https://example.org/${slot}.json`}}];
  assert.deepEqual(StructuredWorkerRequestSchema.parse({...request,auxiliary}).auxiliary,auxiliary);
  assert.throws(()=>structuredAdapterFor({...request,options:{[slot]:{bytes:'unadmitted bytes'}}}),/admitted artifact transport/);
 }
 assert.equal(StructuredWorkerRequestSchema.safeParse({...request,auxiliary:Array(3).fill({slot:'stationSnapshot',snapshot})}).success,false);
});

test('auxiliary input bundle schema accepts canonical synthetic byte transport, not paths or arbitrary slots',()=>{
 const bundle={version:'structured-input-bundle-v1',sourceBytes:Buffer.from('synthetic source').toString('base64'),auxiliary:[{slot:'municipalBoundaries',bytes:Buffer.from('synthetic boundaries').toString('base64')},{slot:'stationSnapshot',bytes:Buffer.from('synthetic stations').toString('base64')}]};
 assert.deepEqual(StructuredInputBundleSchema.parse(bundle),bundle);
 for(const patch of [{version:'other'},{path:'/private/unrelated'},{sourceBytes:123},{auxiliary:[{slot:'other',bytes:'eA=='}]},{auxiliary:[{slot:'stationSnapshot',bytes:'eA==',path:'/private/unrelated'}]},{auxiliary:Array(3).fill({slot:'stationSnapshot',bytes:'eA=='})}])assert.equal(StructuredInputBundleSchema.safeParse({...bundle,...patch}).success,false);
});

test('single-page and empty results preserve exact original coverage and deterministic request binding',()=>{
 const observations=[row('1'),row('2')];
 const output=pageStructuredResult({observations,coverage},request);
 assert.deepEqual(output.result,{observations,coverage});
 assert.deepEqual(output.page,{offset:0,end:2,total:2,nextCursor:null,bindingSha256:digest(canonicalJson({...request,cursor:null})),sourceCoverage:coverage});
 assert.deepEqual(StructuredOutputPageSchema.parse(output.page),output.page);
 const emptyCoverage={...coverage,state:'empty' as const,observedRows:0,reason:'Synthetic source explicitly empty'};
 const empty=pageStructuredResult({observations:[],coverage:emptyCoverage},request);
 assert.deepEqual(empty.result,{observations:[],coverage:emptyCoverage});assert.equal(empty.page.total,0);assert.equal(empty.page.end,0);assert.equal(empty.page.nextCursor,null);
 for(const patch of [{offset:-1},{end:1.5},{total:-1},{bindingSha256:'bad'},{extra:'unknown'},{sourceCoverage:{...coverage,state:'unknown'}}])assert.equal(StructuredOutputPageSchema.safeParse({...output.page,...patch}).success,false);
});

test('bounded pagination retains all native observations and original source coverage on every page',()=>{
 const observations=[row('1','a'.repeat(1100*1024)),row('2','b'.repeat(1100*1024)),row('3','c'.repeat(1100*1024))];
 let current=request;
 const collected:StructuredObservation[]=[];
 for(let index=0;index<observations.length;index++){
  const output=pageStructuredResult({observations,coverage},current);
  assert.equal(output.page.offset,index);assert.equal(output.page.end,index+1);assert.equal(output.page.total,3);assert.deepEqual(output.page.sourceCoverage,coverage);
  assert.equal(output.result.coverage.state,'partial');assert.equal(output.result.coverage.observedRows,coverage.observedRows);assert.equal(output.result.observations.length,1);assert.ok(output.result.coverage.limitations.some(value=>value.includes('all output pages')));
  assert.ok(Buffer.byteLength(canonicalJson(output.result.observations[0]))<=2*1024*1024);
  collected.push(...output.result.observations);
  if(index<2){assert.ok(output.page.nextCursor);assert.equal(output.result.coverage.nextCursor,output.page.nextCursor);current={...request,cursor:output.page.nextCursor};}else assert.equal(output.page.nextCursor,null);
 }
 assert.deepEqual(collected,observations);
});

test('one observation at the byte bound is admitted but larger observations are rejected without truncation',()=>{
 const base=row('bounded','');
 const allowance=2*1024*1024-Buffer.byteLength(canonicalJson(base));
 const exact={...base,value:'x'.repeat(allowance)};
 assert.equal(Buffer.byteLength(canonicalJson(exact)),2*1024*1024);
 assert.deepEqual(pageStructuredResult({observations:[exact],coverage},request).result.observations,[exact]);
 assert.throws(()=>pageStructuredResult({observations:[{...exact,value:`${exact.value}x`}],coverage},request),/Single structured observation exceeds/);
});

test('cursor binding rejects changed scope, bytes, policy, options and supporting snapshot metadata',()=>{
 const observations=[row('1','a'.repeat(1100*1024)),row('2','b'.repeat(1100*1024))];
 const first=pageStructuredResult({observations,coverage},request);assert.ok(first.page.nextCursor);
 const resumed={...request,cursor:first.page.nextCursor};
 const changes:Partial<StructuredWorkerRequest>[]=[{scope:{...scope,ags:'01053090'}},{scope:{...scope,tenant:'other-tenant'}},{scope:{...scope,observationWindow:'2026-10-12'}},{options:{format:'changed'}},{operation:'discover'},{adapter:'mastr'},{inputArtifactSha256:digest('changed input')},{snapshot:{...snapshot,sourceSha256:digest('changed bytes')}},{snapshot:{...snapshot,policyReceiptSha256:digest('changed policy')}},{snapshot:{...snapshot,request:{method:'POST',body:'selector=other',contentType:'text/plain'}}},{auxiliary:[{slot:'stationSnapshot',snapshot}]}];
 for(const change of changes)assert.throws(()=>pageStructuredResult({observations,coverage},{...resumed,...change}),/cursor scope mismatch/);
 for(const cursor of ['not-json',JSON.stringify({kind:'other',bindingSha256:first.page.bindingSha256,offset:1}),JSON.stringify({kind:'structured-output-page-v1',bindingSha256:first.page.bindingSha256,offset:-1}),JSON.stringify({kind:'structured-output-page-v1',bindingSha256:first.page.bindingSha256,offset:1,extra:true})])assert.throws(()=>pageStructuredResult({observations,coverage},{...request,cursor}));
 for(const offset of [2,3])assert.throws(()=>pageStructuredResult({observations,coverage},{...request,cursor:canonicalJson({kind:'structured-output-page-v1',bindingSha256:first.page.bindingSha256,offset})}),/cursor exceeds result/);
});

test('output pagination never promotes held or partial source coverage to complete',()=>{
 const observations=[row('1','a'.repeat(1100*1024)),row('2','b'.repeat(1100*1024))];
 for(const state of ['partial','held_quality','held_origin','blocked_access','failed_execution'] as const){
  const sourceCoverage={...coverage,state,nextCursor:'native-source-cursor'};
  const first=pageStructuredResult({observations,coverage:sourceCoverage},request);
  assert.equal(first.result.coverage.state,state);assert.deepEqual(first.page.sourceCoverage,sourceCoverage);
  const last=pageStructuredResult({observations,coverage:sourceCoverage},{...request,cursor:first.page.nextCursor});
  assert.equal(last.result.coverage.state,state);assert.equal(last.result.coverage.nextCursor,'native-source-cursor');assert.equal(last.page.nextCursor,null);
 }
});
