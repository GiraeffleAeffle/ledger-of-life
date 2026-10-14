import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {z} from 'zod';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {createOperatorRegistryFixture,operatorRegistryFixtureValue} from './helpers/operator-registry-fixture.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';
import {DistrictJobStore,migrateDistrictJobs,runDistrictJobs,type JobHandler} from '../src/district-jobs.ts';
import {DistrictCas,type CasPutOptions} from '../src/district-cas.ts';
import {acquisitionContract,acquisitionHandler,acquiredRepresentationHandler,enqueueAcquiredRepresentation,loadDescriptor,AcquisitionSelectorSchema,AcquiredRepresentationSelectorSchema} from '../src/district-r1.ts';
import {persistR1Representation,persistOperatorRegistry,enqueueStructuredSnapshot} from '../src/district-r1-state.ts';
import {genesisOwnerAccountRoot,readGenesisOwnerRepresentation} from '../src/genesis-owner-acquisition.ts';
import {readPriorGenesisOwnerAcquisition} from '../src/genesis-owner-reuse.ts';
import {PoliteFetcher} from '../src/polite-fetch.ts';
import type {FetchedDocument} from '../src/polite-fetch.ts';
import {ContentFreeSourcePolicySchema} from '../src/district-schema.ts';
import {createPolicyReceipt} from '../src/district-policy-receipt.ts';
import {admittedRegisteredRobotsScopes} from '../src/registered-source-policy.ts';
import {sourcePolicyExpiresAt} from '../src/source-policy.ts';
import {authenticatedHttpBinding,authenticateHttpSourceBindings} from '../src/district-http-observation.ts';
import {assertStructuredParserInput} from '../src/district-structured-jobs.ts';
import {StructuredWorkerRequestSchema} from '../src/district-structured-parser-worker.ts';
import {StepReceiptSchema,unknownReceiptCounts,CANONICALIZATION_VERSION,STEP_RECEIPT_VERSION} from '../src/district-step-receipt.ts';
import {persistCrawlRequestEvidence} from '../src/district-crawl-request.ts';
import {initializeManagedAcquisitionLane,withManagedSourceWrite,recordHostOptOut,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
import {canonicalJson,digest} from '../src/district-adapter-contract.ts';

const endpoint='https://www.regionalstatistik.de/genesisws/rest/2020/data/table';
const body='name=12411-02-03&area=free&language=de&regionalvariable=GEMEIN&regionalkey=12064472&startyear=2024&endyear=2024&compress=false&transpose=false&job=false';
const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
const scenarios=['happy','other-job','overlap','stale','ambiguous','opted-out','wrong-request','missing-sidecar','tampered-body','wrong-pin','revoked','not-independent'] as const;

test('offline owner-account salvage uses genuine own-attempt evidence without another request',{skip:!connectionString,timeout:240000},async t=>{
 const url=new URL(connectionString!);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(url.hostname))throw Error('Salvage fixture refuses non-local Postgres');
 const host=url.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Salvage fixture refuses non-local host override');
 const admin=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:10000}),database='district_k1_salvage_'+randomUUID().replaceAll('-',''),closeAdmin=poolShutdownBarrier(admin);
 let created=false,closePool:(()=>Promise<void>)|undefined;
 t.after(async()=>{try{await closePool?.();if(created)await admin.query('DROP DATABASE "'+database+'"');}finally{await closeAdmin();}});
 await admin.query('CREATE DATABASE "'+database+'"');created=true;
 const isolated=new URL(url);isolated.pathname='/'+database;
 const pool=new Pool({connectionString:isolated.href,max:4,connectionTimeoutMillis:5000,statement_timeout:10000});closePool=poolShutdownBarrier(pool);
 const store=new DistrictJobStore(pool);await migrateDistrictJobs(pool);
 for(const scenario of scenarios)await t.test(scenario,async child=>{
  const fixture=await createCivicPolicyTestContext(child),fetchRoot=join(fixture.root,'fetch'),ownerRoot=genesisOwnerAccountRoot(fetchRoot);
  const registryValue=operatorRegistryFixtureValue(),city=registryValue.municipalities[0];
  city.id='strausberg';city.ags='12064472';city.districtId='maerkisch-oderland';
  registryValue.districts[0].id=city.districtId;registryValue.inventory[0].ags=city.ags;registryValue.inventory[0].districtId=city.districtId;
  city.sources.push({id:'regionalstatistik-genesis',kind:'structured',url:endpoint,vendor:'unknown',checkState:'not_checked',checkedAt:null,evidence:[],reason:'Synthetic owner-account configuration only; no live source observation'});
  const registered=await createOperatorRegistryFixture(child,{context:fixture,value:registryValue,label:'k1-registry'}),registry=registered.admitted.registry,registrySha256=registered.registrySha256;
  class HoldOnSourceCas extends DistrictCas {
   armed=false;
   override async put(bytes:Uint8Array,options:CasPutOptions){if(this.armed&&options.kind==='source_original'){this.armed=false;throw Error('Synthetic post-fetch exception');}return super.put(bytes,options);}
  }
  const cas=new HoldOnSourceCas(join(fixture.root,'cas'));
  await persistOperatorRegistry(store,cas,registered.admitted,fixture.policy);
  const scope={publisherId:'synthetic-k1-publisher',sourceId:'regionalstatistik-genesis',municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'synthetic-k1-'+scenario};
  const selector=AcquisitionSelectorSchema.parse({version:'district-r1-acquisition-v1',scope,root:endpoint,request:{url:endpoint,method:'POST',body,contentType:'application/x-www-form-urlencoded;charset=UTF-8',publicOperation:'genesis_guest'},permission:{kind:'facts_with_attribution'},maxRequests:5,maxBytes:4096,sourceVersion:null,discovery:null});
  const eligibility=admittedRegisteredRobotsScopes(registry,registrySha256).find(row=>row.municipalityId===scope.municipalityId&&row.sourceId===scope.sourceId)!;
  const originalBytes=Buffer.from('{"syntheticFixture":true,"rows":[]}\n'),sourceSha256=digest(originalBytes);
  await initializeManagedAcquisitionLane(ownerRoot,{...fixture.policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
  async function capture(ageMs=0,requestBody=body,sidecar=true){
   const checkedAt=new Date().toISOString(),policyAt=new Date(Date.now()-ageMs).toISOString(),observationId=Date.now()+'-'+randomUUID()+'.json';
   const sourcePolicy=ContentFreeSourcePolicySchema.parse({robots:{state:'allowed',url:'https://www.regionalstatistik.de/robots.txt',checkedAt:policyAt},tdm:{state:'not_declared',evidence:[{url:'https://www.regionalstatistik.de/.well-known/tdmrep.json',locator:'TDMRep standardized location HTTP absence',value:'404',checkedAt:policyAt}]},access:'authenticated_owner_account',ownerAccountAccess:{decisionId:'owner-2026-10-13-regionalstatistik-account',credentialKind:'token'},legalClassification:'not_assessed',publication:'facts_with_attribution_only'});
   const observation={url:endpoint,method:'POST' as const,checkedAt,retrievedAt:checkedAt,state:'fetched' as const,status:200,sha256:sourceSha256,bytes:originalBytes.length,mimeType:'application/json',policy:sourcePolicy},observationBytes=Buffer.from(JSON.stringify(observation,null,2)+'\n');
   const httpObservation={observationId,receiptSha256:digest(observationBytes),bytes:observationBytes.toString('utf8')},binding=authenticatedHttpBinding(httpObservation,observation),relativeBody='sha256/'+sourceSha256.slice(0,2)+'/'+sourceSha256,relativeObservation='observations/'+observationId;
   await withManagedSourceWrite(ownerRoot,[{...binding,relativePath:relativeBody,contentSha256:sourceSha256,independentAllowed:true},{...binding,relativePath:relativeObservation,contentSha256:httpObservation.receiptSha256,independentAllowed:false}],async()=>{
    await mkdir(join(ownerRoot,'sha256',sourceSha256.slice(0,2)),{recursive:true,mode:0o700});await mkdir(join(ownerRoot,'observations'),{recursive:true,mode:0o700});
    await writeFile(join(ownerRoot,relativeBody),originalBytes,{mode:0o600});await writeFile(join(ownerRoot,relativeObservation),observationBytes,{flag:'wx',mode:0o600});
   },fixture.policy);
   const requestEvidence=sidecar?await persistCrawlRequestEvidence(ownerRoot,{schemaVersion:'stadtstack-crawl-request-evidence-v1',httpObservation:binding,request:{url:endpoint,method:'POST',contentType:selector.request.contentType,bodySha256:digest(requestBody),publicSelector:null},redirectChain:[endpoint]},fixture.policy):null;
   const document:FetchedDocument={...observation,localPath:join(ownerRoot,relativeBody),observationPath:join(ownerRoot,relativeObservation)};
   return {document,httpObservation,binding,requestEvidence};
  }
  const baseline=await capture();
  const baselineProof=await createPolicyReceipt({source:{url:endpoint,sha256:sourceSha256,mimeType:'application/json'},scope,sourcePolicy:baseline.document.policy,registeredSourceEligibility:eligibility,permission:selector.permission,checkedAt:new Date().toISOString(),expiresAt:sourcePolicyExpiresAt(baseline.document.policy!,baseline.document.checkedAt,baseline.document,scope,eligibility)},fixture.policy);
  const baselineRepresentation=await persistR1Representation(store,cas,{bytes:originalBytes,receipt:baselineProof.receipt,request:selector.request,retrievedAt:baseline.document.retrievedAt,fetchedAt:baseline.document.checkedAt,sourceVersion:null,redirectChain:[endpoint],httpObservation:{...baseline.httpObservation,bytes:Buffer.from(baseline.httpObservation.bytes)}},fixture.policy);
  const originalJobKey=await store.enqueue({step:'acquire_representation',lane:'acquisition',semanticContractSha256:await acquisitionContract(),inputArtifactHashes:[],sourceScope:scope,selector,policyProofSha256:null});
  const concurrentJobKey=scenario==='overlap'?await store.enqueue({step:'acquire_representation',lane:'acquisition',semanticContractSha256:await acquisitionContract(),inputArtifactHashes:[],sourceScope:scope,selector:{...selector,maxBytes:2048},policyProofSha256:null}):undefined;
  let originalContext:Parameters<JobHandler>[0]|undefined;
  async function run(jobKey:string,handler:JobHandler,step:string){
   const keys=jobKey===originalJobKey&&concurrentJobKey?[jobKey,concurrentJobKey]:[jobKey];
   const authorizationId=await store.authorize({approvalSha256:digest('synthetic-k1-'+randomUUID()),approvedBy:'synthetic-fixture-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:keys,ags:[scope.ags],maxJobs:keys.length,maxElapsedMs:60000,category:'development'});
   return runDistrictJobs({store,cas,handlers:{[step]:handler},authorizationId,ownerPresent:true,maxJobs:keys.length,maxElapsedMs:60000});
  }
  let captured=baseline,otherAttemptRecorded=false;
  const fetch=child.mock.method(PoliteFetcher.prototype,'fetch',async()=>{
   if(scenario==='other-job'&&otherAttemptRecorded)return captured.document;
   captured=await capture(scenario==='stale'?8*86400000:0,scenario==='wrong-request'?body+'&synthetic=other':body,scenario!=='missing-sidecar');
   if(scenario==='ambiguous')await capture();
   if(concurrentJobKey){
    // Real fixture leases and a real committed owner-stopped attempt create the
    // overlap; no prior receipt or observation clock is rewritten or invented.
    assert.ok(originalContext);
    const row=(await pool.query<{authorization_id:string;started_at:Date;max_jobs:number;max_elapsed_ms:number}>('SELECT authorization_id,started_at,max_jobs,max_elapsed_ms FROM district_pipeline.executor_runs WHERE id=$1',[originalContext.job.runId])).rows[0];
    const claim=await store.claim({runId:originalContext.job.runId,authorizationId:row.authorization_id,startedAt:row.started_at,maxJobs:row.max_jobs,maxElapsedMs:row.max_elapsed_ms,deadlineAt:new Date(row.started_at.getTime()+row.max_elapsed_ms),deadlineReason:'max_time_reached'},30000);
    assert.equal(claim.kind,'job');if(claim.kind!=='job')throw Error('Synthetic concurrent attempt was not claimed');
    const job=claim.job;assert.equal(job.jobKey,concurrentJobKey);
    const finishedAt=new Date().toISOString();
    const stopped=StepReceiptSchema.parse({version:STEP_RECEIPT_VERSION,canonicalizationVersion:CANONICALIZATION_VERSION,id:randomUUID(),runId:job.runId,jobKey:job.jobKey,step:job.spec.step,lane:job.spec.lane,sourceId:job.spec.sourceScope.sourceId,municipalityId:job.spec.sourceScope.municipalityId,attempt:job.attempt,leaseToken:job.fencingToken,category:job.category,dependencyReceiptIds:job.dependencyReceiptIds,enqueuedAt:job.enqueuedAt,startedAt:job.startedAt,finishedAt,queueWaitMs:Date.parse(job.startedAt)-Date.parse(job.enqueuedAt),elapsedMs:null,cpuUserMicros:null,cpuSystemMicros:null,outcome:'held_execution',reasonCode:'owner_stopped',inputHashes:job.spec.inputArtifactHashes,outputHashes:[],policyProofSha256:job.spec.policyProofSha256,originProofSha256:null,versions:{},cache:{disposition:'not_applicable',originalGenerationReceiptId:null},provider:null,counts:unknownReceiptCounts});
    assert.equal(await store.hold(job,'owner_stopped',stopped),true);
   }
   return captured.document;
  });
  if(scenario==='other-job'){
   const otherSelector={...selector,maxBytes:2048};
   const otherJobKey=await store.enqueue({step:'acquire_representation',lane:'acquisition',semanticContractSha256:await acquisitionContract(),inputArtifactHashes:[],sourceScope:scope,selector:otherSelector,policyProofSha256:null});
   cas.armed=true;
   const otherRun=await run(otherJobKey,acquisitionHandler(store,registry,{fetchRoot,policy:fixture.policy},registrySha256),'acquire_representation');
   assert.equal(otherRun.state,'held');otherAttemptRecorded=true;
  }
  cas.armed=true;
  const originalHandler=acquisitionHandler(store,registry,{fetchRoot,policy:fixture.policy},registrySha256);
  const originalRun=await run(originalJobKey,async context=>{originalContext=context;return originalHandler(context);},'acquire_representation');
  assert.equal(originalRun.state,'held');assert.equal(originalRun.reasonCode,'execution_exception');assert.equal(fetch.mock.callCount(),scenario==='other-job'?2:1);
  const priorRow=(await pool.query<{receipt_sha256:string;receipt:unknown}>(`SELECT receipt_sha256,receipt FROM district_pipeline.step_receipts WHERE run_id=$1 AND receipt->>'jobKey'=$2`,[originalRun.runId,originalJobKey])).rows[0],priorReceipt=StepReceiptSchema.parse(priorRow.receipt);
  assert.equal(priorReceipt.outcome,'held_execution');assert.deepEqual(priorReceipt.outputHashes,[]);assert.deepEqual(priorReceipt.versions,{});
  const prior={priorJobKey:originalJobKey,priorReceiptSha256:priorRow.receipt_sha256,priorAttempt:priorReceipt.attempt,observationId:captured.httpObservation.observationId,requestEvidenceSha256:captured.requestEvidence?.sha256??digest('missing synthetic sidecar')};
  const selection=AcquiredRepresentationSelectorSchema.parse({acquisition:selector,prior});
  fetch.mock.restore();
  const forbiddenFetch=child.mock.method(PoliteFetcher.prototype,'fetch',async()=>{throw Error('Offline admission must not send another request');});
  if(scenario==='opted-out')await recordHostOptOut({host:'www.regionalstatistik.de',reason:'municipality_objection',reference:'synthetic-k1-opt-out'},fixture.policy);
  if(scenario==='tampered-body')await writeFile(captured.document.localPath,'synthetic tampering',{mode:0o600});
  if(scenario==='wrong-pin')selection.prior.requestEvidenceSha256=digest('wrong synthetic request pin');
  if(scenario==='revoked'||scenario==='not-independent'){
   const path=join(fixture.policy.stateDir!,'inventory.json'),inventory=JSON.parse(await readFile(path,'utf8'));
   const entry=inventory.entries.find((entry:{rootId:string;relativePath:string;observationId:string})=>entry.rootId===digest(ownerRoot)&&entry.relativePath==='sha256/'+sourceSha256.slice(0,2)+'/'+sourceSha256&&entry.observationId===captured.httpObservation.observationId);
   assert.ok(entry);if(scenario==='revoked')entry.state='revoked';else entry.independentAllowed=false;
   await writeFile(path,JSON.stringify(inventory)+'\n',{mode:0o600});
  }
  if(scenario!=='happy'){
   await assert.rejects(readPriorGenesisOwnerAcquisition(store,fetchRoot,selector,selection.prior,fixture.policy,eligibility));
   await assert.rejects(enqueueAcquiredRepresentation(store,cas,registry,registrySha256,selection,{fetchRoot,policy:fixture.policy}));
   // A previously enqueued/offline-authorized job must also revalidate at execution.
   const jobKey=await store.enqueue({step:'admit_acquired_representation',lane:'acquisition',semanticContractSha256:await acquisitionContract(),inputArtifactHashes:[registrySha256],sourceScope:scope,selector:selection,policyProofSha256:null});
   const result=await run(jobKey,acquiredRepresentationHandler(store,registry,{fetchRoot,policy:fixture.policy},registrySha256),'admit_acquired_representation');
   assert.equal(result.state,'held');assert.equal(forbiddenFetch.mock.callCount(),0);
   assert.equal((await pool.query("SELECT state FROM district_pipeline.jobs WHERE job_key=$1",[originalJobKey])).rows[0].state,'held_execution');
   return;
  }
  for(const source of [baseline,captured])assert.deepEqual((await readGenesisOwnerRepresentation(fetchRoot,source.document,fixture.policy)).bytes,originalBytes);
  const acquired=await readPriorGenesisOwnerAcquisition(store,fetchRoot,selector,prior,fixture.policy,eligibility);
  assert.equal(acquired.response.checkedAt,captured.document.checkedAt);assert.equal(acquired.response.retrievedAt,captured.document.retrievedAt);
  const jobKey=await enqueueAcquiredRepresentation(store,cas,registry,registrySha256,selection,{fetchRoot,policy:fixture.policy});assert.notEqual(jobKey,originalJobKey);
  const admittedRun=await run(jobKey,acquiredRepresentationHandler(store,registry,{fetchRoot,policy:fixture.policy},registrySha256),'admit_acquired_representation');
  assert.equal(admittedRun.state,'completed');assert.equal(forbiddenFetch.mock.callCount(),0);
  const admittedRow=(await pool.query<{receipt:unknown}>('SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=$1',[admittedRun.runId])).rows[0],admissionReceipt=StepReceiptSchema.parse(admittedRow.receipt);
  assert.equal(admissionReceipt.step,'admit_acquired_representation');assert.equal(admissionReceipt.versions.acquisitionMode,'offline_prior_attempt');assert.equal(admissionReceipt.versions.priorAcquisitionReceiptSha256,priorRow.receipt_sha256);assert.equal(admissionReceipt.versions.priorHttpObservationSha256,captured.httpObservation.receiptSha256);
  const descriptorHash=(await pool.query<{artifact_sha256:string}>(`SELECT a.artifact_sha256 FROM district_pipeline.job_output_artifacts a JOIN district_pipeline.artifacts f ON f.sha256=a.artifact_sha256 WHERE a.receipt_id=$1 AND f.kind='derived'`,[admissionReceipt.id])).rows[0].artifact_sha256;
  const descriptor=await loadDescriptor(store,cas,descriptorHash,fixture.policy);
  assert.equal(descriptor.snapshotId,baselineRepresentation.snapshotId);assert.equal(descriptor.fetchedAt,captured.document.checkedAt);assert.equal(descriptor.snapshot.retrievedAt,captured.document.retrievedAt);assert.notEqual(descriptor.snapshot.retrievedAt,baselineRepresentation.snapshot.retrievedAt);
  const proof=JSON.parse((await cas.read(descriptor.receiptSha256)).toString('utf8'));
  assert.equal(proof.expiresAt,acquired.expiresAt);assert.deepEqual(proof.sourcePolicy,captured.document.policy);
  for(const source of [baseline,captured])assert.deepEqual(await authenticateHttpSourceBindings(cas,[source.binding],[{url:endpoint,sha256:sourceSha256}],fixture.policy),[source.binding]);
  const structured=await enqueueStructuredSnapshot(store,cas,{adapter:'genesis',operation:'parse',registry:registered.registryPin,registrySha256,scope,districtId:registry.municipalities.find(city=>city.id==='strausberg')!.districtId,snapshot:descriptor.snapshot,options:{},cursor:null,sourceBindings:[captured.binding]},fixture.policy);
  const worker=z.object({worker:StructuredWorkerRequestSchema}).parse(structured.spec.selector).worker;
  for(const source of [baseline,captured])await assertStructuredParserInput(cas,worker,[source.binding],fixture.policy);
  const derivedBytes=Buffer.from('synthetic derived parser bundle'),derivedSha256=digest(derivedBytes);
  await withManagedSourceWrite(cas.root,[baseline.binding,captured.binding].map(binding=>({...binding,relativePath:'sha256/'+derivedSha256.slice(0,2)+'/'+derivedSha256,contentSha256:derivedSha256,independentAllowed:false})),()=>cas.put(derivedBytes,{kind:'derived',mimeType:'application/json'}),fixture.policy);
  const derivedRequest={...worker,inputArtifactSha256:derivedSha256};
  await assert.rejects(assertStructuredParserInput(cas,derivedRequest,[captured.binding],fixture.policy),{code:'CONTENT_PROVENANCE_MISMATCH'});
  await assertStructuredParserInput(cas,derivedRequest,[baseline.binding,captured.binding],fixture.policy);
  assert.equal((await pool.query('SELECT state FROM district_pipeline.jobs WHERE job_key=$1',[originalJobKey])).rows[0].state,'held_execution');
  assert.equal(forbiddenFetch.mock.callCount(),0);
 });
});
