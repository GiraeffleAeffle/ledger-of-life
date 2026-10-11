import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AcquisitionSelectorSchema,HostGroupsSchema,registeredScope,validateAcquisitionSelector,readFetchedBytes,structuredHoldSummary,parseR1RegistryArguments} from '../src/district-r1.ts';
import {digest,observation,CoverageSchema} from '../src/district-adapter-contract.ts';
import {districtRegistrySchema} from '../src/district-registry.ts';
import {DistrictCas} from '../src/district-cas.ts';
import {DistrictJobStore} from '../src/district-jobs.ts';
import {Pool} from 'pg';
import {ResidualInputSchema} from '../src/district-residual-jobs.ts';
import {HttpObservationProofSchema} from '../src/district-http-observation.ts';

const scope={publisherId:'fixture-publisher',sourceId:'fixture-source',municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'2026-10-11'};
async function registryFixture(){
 const registry=districtRegistrySchema.parse(JSON.parse(await readFile(new URL('../sources/district-registry.json',import.meta.url),'utf8')));
 const city=registry.municipalities.find(city=>city.id===scope.municipalityId)!;
 city.sources.push({id:scope.sourceId,kind:'structured',url:'https://example.org/root',vendor:'other',checkState:'not_checked',checkedAt:null,evidence:[],reason:'Fixture discovery only'});
 return registry;
}
const selector={version:'district-r1-acquisition-v1',scope,root:'https://example.org/root',request:{url:'https://example.org/root',method:'GET',body:null,contentType:null,publicOperation:null},permission:{kind:'official_work'},maxRequests:5,maxBytes:1024,sourceVersion:null,discovery:null};

test('operator acquisition schema requires exact bounds and forbids handler/header escape hatches',()=>{
 assert.equal(AcquisitionSelectorSchema.parse(selector).maxRequests,5);
 assert.equal(AcquisitionSelectorSchema.parse({...selector,permission:{kind:'facts_with_attribution'}}).permission.kind,'facts_with_attribution');
 for(const input of [{...selector,maxRequests:0},{...selector,maxRequests:101},{...selector,maxBytes:0},{...selector,maxBytes:67108865},{...selector,handler:'./arbitrary.ts'},{...selector,request:{...selector.request,headers:{Authorization:'fixture'}}}])assert.throws(()=>AcquisitionSelectorSchema.parse(input));
});

test('registered scope preserves exact pilot AGS and source root',async()=>{
 const registry=await registryFixture();assert.equal(registeredScope(registry,scope,selector.root).city.ags,'01053100');
 for(const changed of [{...scope,ags:'01053'},{...scope,municipalityId:'other'},{...scope,sourceId:'unregistered'}])assert.throws(()=>registeredScope(registry,changed,selector.root));
 assert.throws(()=>registeredScope(registry,scope,'https://example.org/root/child'));
});

test('non-root acquisitions cannot use caller-invented resource references',async()=>{
 const pool=new Pool(),store=new DistrictJobStore(pool),cas=new DistrictCas(join(tmpdir(),'r1-unopened-cas'));
 try{
  const registry=await registryFixture();await validateAcquisitionSelector(registry,store,cas,selector);
  await assert.rejects(validateAcquisitionSelector(registry,store,cas,{...selector,request:{...selector.request,url:'https://example.org/root/child'}}),/committed discovery/);
  await assert.rejects(validateAcquisitionSelector(registry,store,cas,{...selector,request:{...selector.request,body:'unexpected'}}),/GET selector/);
  await assert.rejects(validateAcquisitionSelector(registry,store,cas,{...selector,request:{url:'https://example.org/root',method:'POST',body:'{}',contentType:'application/json',publicOperation:'ted_search'}}),/endpoint mismatch/);
 }finally{await pool.end();}
});

test('fetch bytes are exact bounded regular files under the selected private hash root',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'r1-fetch-fixture-'))),bytes=Buffer.from('admitted source fixture'),hash=digest(bytes),file=join(root,'sha256',hash);
 try{
  await mkdir(join(root,'sha256'),{mode:0o700});await writeFile(file,bytes,{mode:0o600});
  assert.deepEqual(await readFetchedBytes(root,file,hash,bytes.length),bytes);
  await assert.rejects(readFetchedBytes(root,file,hash,bytes.length-1),/size rejected/);
  await assert.rejects(readFetchedBytes(root,join(root,'outside'),hash,1024),/outside fixed/);
  await writeFile(file,'changed');await assert.rejects(readFetchedBytes(root,file,hash,1024),/digest mismatch/);
  await rm(file);await symlink(join(root,'target'),file);await assert.rejects(readFetchedBytes(root,file,hash,1024));
  await rm(file);await mkdir(file);await assert.rejects(readFetchedBytes(root,file,hash,1024),/type or size/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('host grouping is a pinned conservative capacity pool, not publisher equivalence',async()=>{
 const config=JSON.parse(await readFile(new URL('../sources/district-host-groups.json',import.meta.url),'utf8')),parsed=HostGroupsSchema.parse(config);
 assert.equal(parsed.serviceGroups[0].minStartIntervalMs,2500);
 for(const changed of [
  {...config,serviceGroups:[{...parsed.serviceGroups[0],groupingBasis:'same_publisher'}]},
  {...config,serviceGroups:[{...parsed.serviceGroups[0],minStartIntervalMs:2000}]},
  {...config,serviceGroups:[{...parsed.serviceGroups[0],maxInFlight:2}]},
  {...config,serviceGroups:[]},
 ])assert.throws(()=>HostGroupsSchema.parse(changed));
});

test('residual enqueue is bounded subscription work without caller-selected handlers or paid routes',()=>{
 const hash='a'.repeat(64),input={documentId:'fixture-document',corpusSha256:hash,registry:{path:'/fixture/operator-registry-descriptor.json',sha256:hash},registrySha256:hash,policyReceiptSha256:hash,httpObservation:{observationId:'fixture-observation.json',receiptSha256:hash},bounds:{maxDocuments:1,maxChunks:24,maxModelCalls:48,paidMicroUsd:0}};
 assert.equal(ResidualInputSchema.parse(input).bounds.maxModelCalls,48);
 for(const changed of [
  {...input,bounds:{...input.bounds,maxDocuments:2}},
  {...input,bounds:{...input.bounds,maxChunks:25}},
  {...input,bounds:{...input.bounds,maxModelCalls:49}},
  {...input,bounds:{...input.bounds,paidMicroUsd:1}},
  {...input,handler:'./untrusted.ts'},
  {...input,provider:'paid-api'},
 ])assert.throws(()=>ResidualInputSchema.parse(changed));
});

test('native hold metadata counts actual fields without exposing source literals or contact details',()=>{
 const hash='a'.repeat(64),retrievedAt='2026-10-11T00:00:00Z';
 const rows=[{predicate:'description',value:'private narrative fixture'},{predicate:'title',value:'x'.repeat(1801)},{predicate:'email',value:'private@example.org'},{predicate:'capacity',value:12}].map((field,index)=>observation({
  publisherId:'fixture',sourceId:'fixture',nativeId:String(index),nativeVersion:null,kind:'Observation',subject:'Fixture',...field,unit:null,date:null,dateRole:null,financialRole:'none',geography:{ags:'01053100',basis:'source_explicit',role:'administrative_area'},sourceReferenceDate:null,publishedAt:null,retrievedAt,
  evidence:[{sourceSha256:hash,format:'json',nativeId:String(index),path:`rows[${index}]`,sheet:null,rowKey:null,cells:[],rawValue:field.value,schemaHash:hash,mappingVersion:'fixture-v1'}],limitations:[],
 }));
 const output={unpublishedObservations:3,result:{observations:rows,coverage:CoverageSchema.parse({state:'partial',scope:'fixture',reason:'fixture',checkedAt:retrievedAt,nextCursor:null,observedRows:4,limitations:[]})}};
 const summary=structuredHoldSummary([output]);
 assert.deepEqual(summary.counts,{narrative_requires_text_model:1,source_literal_exceeds_short_quote:1,contact_field:1});
 assert.equal(summary.residualRequiredObservations,2);assert.equal(summary.otherUnpublishedObservations,0);
 assert.deepEqual(summary.routeHints,[{route:'residual_text_model',command:'enqueue-residual-preparation'},{route:'contact_excluded_from_publication',command:null}]);
 assert.equal(JSON.stringify(summary).includes('private narrative fixture'),false);assert.equal(JSON.stringify(summary).includes('private@example.org'),false);
 assert.throws(()=>structuredHoldSummary([{...output,unpublishedObservations:2}]),/exceeds actual unpublished/);
});

test('HTTP observation provenance preserves exact receipt bytes instead of an admissibility hash',()=>{
 const bytes=JSON.stringify({url:'https://example.org/source',method:'GET',checkedAt:'2026-10-11T00:00:00Z',retrievedAt:'2026-10-11T00:00:00Z',state:'fetched',status:200,sha256:'a'.repeat(64),bytes:32,mimeType:'text/html'},null,2)+'\n';
 const proof={observationId:'1760140800000-00000000-0000-0000-0000-000000000000.json',receiptSha256:digest(bytes),bytes};
 assert.equal(HttpObservationProofSchema.parse(proof).bytes,bytes);
 assert.throws(()=>HttpObservationProofSchema.parse({...proof,receiptSha256:'b'.repeat(64)}),/byte digest/);
 assert.throws(()=>HttpObservationProofSchema.parse({...proof,observationId:'../source.json'}));
 const unsafe=JSON.stringify({...JSON.parse(bytes),rawSourceText:'private original'});
 assert.throws(()=>HttpObservationProofSchema.parse({...proof,bytes:unsafe,receiptSha256:digest(unsafe)}),/safe schema/);
});

test('native commands require an explicit registry descriptor pin without a bare-path default',()=>{
 const hash='a'.repeat(64),flags=['--registry-config','/fixture/registry-descriptor.json','--registry-config-sha256',hash];
 assert.deepEqual(parseR1RegistryArguments([...flags,'--authorization-id','fixture-id','--max-jobs','1']),{registryPin:{path:'/fixture/registry-descriptor.json',sha256:hash},args:['--authorization-id','fixture-id','--max-jobs','1']});
 assert.throws(()=>parseR1RegistryArguments([]));
 assert.throws(()=>parseR1RegistryArguments(['--registry-config','sources/district-registry.json']));
 assert.throws(()=>parseR1RegistryArguments([...flags,'--registry-config','another.json']),/Duplicate/);
 assert.throws(()=>parseR1RegistryArguments(['--registry-config','--registry-config-sha256',hash]),/requires a value/);
 assert.throws(()=>parseR1RegistryArguments(['--registry-config','descriptor.json','--registry-config-sha256','not-a-hash']));
});
