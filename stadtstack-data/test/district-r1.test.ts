import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,readFile,realpath,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AcquisitionSelectorSchema,HostGroupsSchema,registeredScope,validateAcquisitionSelector,readFetchedBytes,structuredHoldSummary,parseR1RegistryArguments,acquisitionHandler,acquisitionContract,acquisitionFailureReason} from '../src/district-r1.ts';
import {digest,observation,CoverageSchema,canonicalJson,semanticHash} from '../src/district-adapter-contract.ts';
import {districtRegistrySchema} from '../src/district-registry.ts';
import {DistrictCas} from '../src/district-cas.ts';
import {DistrictJobStore,migrateDistrictJobs,runDistrictJobs,type OwnerNotification} from '../src/district-jobs.ts';
import {Pool} from 'pg';
import {ResidualInputSchema} from '../src/district-residual-jobs.ts';
import {PILOT_BASE_CORPUS_SHA256} from '../src/district-corpus.ts';
import {HttpObservationProofSchema} from '../src/district-http-observation.ts';
import {randomUUID} from 'node:crypto';
import {PoliteFetcher,PoliteFetchError,type FetchFailure} from '../src/polite-fetch.ts';
import {ReasonCodeSchema,StepReceiptSchema} from '../src/district-step-receipt.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import {sendPipelineNotification,pipelineNotificationConfig} from '../src/district-notifications.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';

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
 const hash='a'.repeat(64),input={documentId:'fixture-document',corpusSha256:PILOT_BASE_CORPUS_SHA256,corpusObservations:[{kind:'http_observation',url:'https://example.org/original',sourceSha256:hash,observationId:'1-11111111-1111-4111-8111-111111111111.json',receiptSha256:hash}],registry:{path:'/fixture/operator-registry-descriptor.json',sha256:hash},registrySha256:hash,policyReceiptSha256:hash,httpObservation:{observationId:'1-11111111-1111-4111-8111-111111111111.json',receiptSha256:hash},requestEvidenceSha256:hash,bounds:{maxDocuments:1,maxChunks:24,maxModelCalls:48,paidMicroUsd:0}};
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

test('acquisition reasons are canonical content-free holds, not exception-text projections',()=>{
 const expected:Record<FetchFailure,string>={
  unsafe_url:'source_policy_refused',robots_blocked:'source_policy_refused',robots_unavailable:'source_policy_refused',
  tdm_reserved:'source_policy_refused',tdm_unavailable:'source_policy_refused',access_barrier:'source_access_barrier',credential_unavailable:'source_access_barrier',
  dns_error:'source_unavailable',timeout:'source_unavailable',network_error:'execution_exception',http_error:'source_http_error',
  too_large:'source_limit_exceeded',redirect_limit:'source_redirect_refused',invalid_redirect:'source_redirect_refused',
  cross_host_redirect:'source_redirect_refused',cache_missing:'cas_unavailable',unsupported_encoding:'source_unavailable',
  host_busy:'host_capacity',host_state_unsafe:'source_policy_refused',host_cooldown:'host_delay',
  host_opted_out:'policy_excluded',document_excluded:'policy_excluded',host_admission_deferred:'host_capacity',
 };
 for(const [failure,reason] of Object.entries(expected)){
  assert.equal(acquisitionFailureReason(new PoliteFetchError(failure as FetchFailure,'PRIVATE_REASON_SENTINEL',401)),reason);
  assert.equal(ReasonCodeSchema.parse(reason),reason);
 }
 assert.equal(acquisitionFailureReason(Error('PRIVATE_REASON_SENTINEL')),null);
 assert.equal(acquisitionFailureReason({failure:'access_barrier'}),null);
 assert.equal(acquisitionFailureReason(new PoliteFetchError('unclassified' as FetchFailure,'PRIVATE_REASON_SENTINEL')),null);
});

const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
for(const scenario of [
 {name:'401 access barrier',endpoint:'/root',mode:'401',reason:'source_access_barrier',failure:'access_barrier'},
 {name:'robots network error',endpoint:'/robots.txt',mode:'network',reason:'execution_exception',failure:'network_error'},
 {name:'TDM network error',endpoint:'/.well-known/tdmrep.json',mode:'network',reason:'execution_exception',failure:'network_error'},
 {name:'robots unknown error',endpoint:'/robots.txt',mode:'unknown',reason:'execution_exception',failure:'network_error'},
 {name:'TDM unknown error',endpoint:'/.well-known/tdmrep.json',mode:'unknown',reason:'execution_exception',failure:'network_error'},
 {name:'robots inspection error',endpoint:'/robots.txt',mode:'inspection',reason:'execution_exception',failure:'network_error'},
 {name:'TDM inspection error',endpoint:'/.well-known/tdmrep.json',mode:'inspection',reason:'execution_exception',failure:'network_error'},
 {name:'PDF inspection error',endpoint:'/root',mode:'pdf',reason:'execution_exception',failure:'network_error'},
 {name:'PDF runtime finding',endpoint:'/root',mode:'pdf_runtime_finding',reason:'execution_exception',failure:'network_error'},
 {name:'invalid fetched PDF metadata',endpoint:'/root',mode:'pdf_invalid',reason:'source_policy_refused',failure:'tdm_unavailable'},
 {name:'invalid fetched TDM',endpoint:'/.well-known/tdmrep.json',mode:'invalid',reason:'source_policy_refused',failure:'tdm_unavailable'},
] as const)test(`real acquisition handler: ${scenario.name} holds without artifacts and notifies its specific reason`,{skip:!connectionString,timeout:120000},async t=>{
 const url=new URL(connectionString!);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(url.hostname))throw Error('Acquisition fixture refuses non-local Postgres');
 const host=url.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Acquisition fixture refuses non-local host override');
 const admin=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:10000}),database='district_acquisition_test_'+randomUUID().replaceAll('-','');
 const closeAdmin=poolShutdownBarrier(admin),resources:{created:boolean;closePool?:()=>Promise<void>}={created:false};
 t.after(async()=>{try{await resources.closePool?.();if(resources.created)await admin.query('DROP DATABASE "'+database+'"');}finally{await closeAdmin();}});
 await admin.query('CREATE DATABASE "'+database+'"');resources.created=true;
 const isolated=new URL(url);isolated.pathname='/'+database;
 const pool=new Pool({connectionString:isolated.href,max:8,connectionTimeoutMillis:5000,statement_timeout:10000});resources.closePool=poolShutdownBarrier(pool);
 const fixture=await createCivicPolicyTestContext(t),fetchRoot=join(fixture.root,'fetch'),cas=new DistrictCas(join(fixture.root,'cas')),store=new DistrictJobStore(pool);
 await migrateDistrictJobs(pool);
 const registry=await registryFixture(),seen:string[]=[],notifications:OwnerNotification[]=[],sentMessages:string[]=[];
 interface WireSeam {wire(url:URL):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>}
 // Same wire seam as polite-fetch.test.ts: actual fetch/policy classification, no DNS or HTTP.
 t.mock.method(PoliteFetcher.prototype as unknown as WireSeam,'wire',async (target:URL)=>{
  seen.push(target.pathname);
  if(target.pathname===scenario.endpoint){
   if(scenario.mode==='network')throw new PoliteFetchError('network_error','PRIVATE_RUNTIME_SENTINEL');
   if(scenario.mode==='unknown')throw Error('PRIVATE_RUNTIME_SENTINEL');
   if(scenario.mode==='invalid')return {status:200,headers:{'content-type':target.pathname==='/robots.txt'?'text/plain':'application/json'},body:Buffer.from('PRIVATE_INVALID_POLICY_SENTINEL')};
   if(scenario.mode==='inspection')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nAllow: /')};
   if(scenario.mode==='pdf'||scenario.mode==='pdf_runtime_finding'||scenario.mode==='pdf_invalid')return {status:200,headers:{'content-type':'application/pdf'},body:Buffer.from('%PDF-invalid')};
   return {status:401,headers:{'content-type':'text/plain'},body:Buffer.from('PRIVATE_401_BODY_SENTINEL')};
  }
  if(target.pathname==='/robots.txt'||target.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
  throw Error('Source document must not be requested after policy failure');
 });
 const inspection={...fixturePolicyInspection,
  resource:async (...args:Parameters<typeof fixturePolicyInspection.resource>)=>{
   if(scenario.mode==='inspection'&&new URL(args[0]).pathname===scenario.endpoint)throw Error('PRIVATE_RUNTIME_SENTINEL');
   return fixturePolicyInspection.resource(...args);
  },
  pdf:async (...args:Parameters<typeof fixturePolicyInspection.pdf>)=>{
   if(scenario.mode==='pdf')throw Error('PRIVATE_RUNTIME_SENTINEL');
   if(scenario.mode==='pdf_runtime_finding')return {...await fixturePolicyInspection.pdf(...args),finding:{state:'unavailable' as const,reason:'parser_version_mismatch'}};
   return fixturePolicyInspection.pdf(...args);
  },
 };
 const jobKey=await store.enqueue({step:'acquire_representation',lane:'acquisition',semanticContractSha256:await acquisitionContract(),inputArtifactHashes:[],sourceScope:scope,selector,policyProofSha256:null});
 const notificationConfig={...pipelineNotificationConfig,notifyOwner:async (notification:OwnerNotification)=>{
  notifications.push(notification);
  return sendPipelineNotification(notification,{readToken:async()=>'synthetic_fixture_publisher_token',send:async(_target,init)=>{
   const message=String(init?.body);sentMessages.push(message);
   return new Response(JSON.stringify({id:'fixture-message-'+notification.phase,event:'message',topic:'pipeline',message,time:Math.floor(Date.now()/1000)}),{status:200});
  }});
 }};
 const authorizationId=await store.authorize({approvalSha256:digest('synthetic acquisition approval'),approvedBy:'synthetic-fixture-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[jobKey],ags:[scope.ags],maxJobs:1,maxElapsedMs:60000,category:'development',mode:'bounded_unattended',notificationApprovalSha256:notificationConfig.notificationApprovalSha256,notificationDestinationSha256:notificationConfig.destinationSha256,notificationProvider:notificationConfig.provider});
 const result=await runDistrictJobs({store,cas,handlers:{acquire_representation:acquisitionHandler(store,registry,{fetchRoot,policy:fixture.policy,inspection})},authorizationId,maxJobs:1,maxElapsedMs:60000,mode:'bounded_unattended',notifyOwner:notificationConfig.notifyOwner,notificationApprovalSha256:notificationConfig.notificationApprovalSha256,notificationDestinationSha256:notificationConfig.destinationSha256,notificationProvider:notificationConfig.provider});
 assert.equal(result.state,'held');assert.equal(result.reasonCode,scenario.reason);assert.equal(result.jobsStarted,1);
 assert.deepEqual(seen,scenario.endpoint==='/robots.txt'?['/robots.txt']:scenario.endpoint==='/.well-known/tdmrep.json'?['/robots.txt','/.well-known/tdmrep.json']:['/robots.txt','/.well-known/tdmrep.json','/root']);
 const rows=await pool.query<{receipt:unknown;receipt_sha256:string}>('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE run_id=$1',[result.runId]);assert.equal(rows.rowCount,1);
 const receipt=StepReceiptSchema.parse(rows.rows[0].receipt);
 assert.equal(receipt.outcome,'held_execution');assert.equal(receipt.reasonCode,scenario.reason);assert.deepEqual(receipt.outputHashes,[]);assert.equal(receipt.counts.bytes,null);assert.equal(rows.rows[0].receipt_sha256,semanticHash(receipt));assert.deepEqual(result.receiptIds,[receipt.id]);
 const job=await pool.query<{state:string;reason_code:string}>('SELECT state,reason_code FROM district_pipeline.jobs WHERE job_key=$1',[jobKey]);assert.deepEqual(job.rows,[{state:'held_execution',reason_code:scenario.reason}]);
 for(const table of ['representations','source_snapshots','policy_decisions','artifacts','job_output_artifacts','r1_metadata_snapshots'])assert.equal((await pool.query('SELECT 1 FROM district_pipeline.'+table)).rowCount,0,table);
 assert.deepEqual((await readdir(fetchRoot)).sort(),['.civic-acquisition-lane.json','observations']);
 const observations=await Promise.all((await readdir(join(fetchRoot,'observations'))).map(async name=>JSON.parse(await readFile(join(fetchRoot,'observations',name),'utf8'))));
 const failed=observations.find(observation=>observation.url===selector.request.url);
 assert.equal(failed?.failure,scenario.failure);
 if(scenario.mode==='401'){assert.equal(failed.status,401);assert.equal(failed.policy.access,'authentication');}
 assert.deepEqual(notifications.map(notification=>[notification.phase,notification.state,notification.reasonCode]),[['startup','running',null],['disposition','held',scenario.reason]]);
 assert.equal(JSON.parse(sentMessages[1]).reasonCode,scenario.reason);
 const outbox=await pool.query<{state:string}>('SELECT state FROM district_pipeline.owner_notifications WHERE run_id=$1 ORDER BY phase',[result.runId]);assert.deepEqual(outbox.rows,[{state:'delivered'},{state:'delivered'}]);
 assert.doesNotMatch(canonicalJson({receipt,notifications,sentMessages,observations}),/PRIVATE_401_BODY_SENTINEL|PRIVATE_RUNTIME_SENTINEL|PRIVATE_INVALID_POLICY_SENTINEL|synthetic_fixture_publisher_token/);
});
