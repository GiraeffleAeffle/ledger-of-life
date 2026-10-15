import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {canonicalJson,digest,semanticHash} from '../src/district-adapter-contract.ts';
import {DistrictCas,type ArtifactKind} from '../src/district-cas.ts';
import {DistrictJobStore,migrateDistrictJobs,runDistrictJobs,type OwnerNotification,type NotificationAcknowledgement} from '../src/district-jobs.ts';
import {DistrictAssessmentBroker,assessmentBJobHandler,enqueueAssessmentB} from '../src/district-assessment-broker.ts';
import {BridgeLeaseSchema,BridgeStatusSchema,type BridgeLease} from '../src/district-assessment-bridge-contract.ts';
import {assessmentItemSchema,type AssessmentOutput} from '../src/district-assessment.ts';
import {createPolicyReceipt} from '../src/district-policy-receipt.ts';
import {encodeStepReceipt,unknownReceiptCounts,type StepReceipt} from '../src/district-step-receipt.ts';
import {provisionCivicPolicyAuthority,initializeManagedAcquisitionLane,withManagedSourceWrite,recordHostOptOut,CIVIC_ACQUISITION_DECISION_ID,CivicPolicyStateError} from '../src/civic-opt-out.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';

// Opt-in isolated LOCAL Postgres only; synthetic sources/CLI event fixtures.
// Nothing invokes SSH, provider binaries, external sources or notification networks.
const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
const clientContractSha256=digest('synthetic-deny-write-client-contract');
const identity={provider:'anthropic-subscription' as const,tool:'claude-cli' as const,toolVersion:'0.0.0-synthetic-test-only',model:'claude-haiku-5-5' as const,modelIdentityBasis:'reported-cli-model-and-tool-version' as const};
const evidence={...identity,modelIdentitySha256:createHash('sha256').update(JSON.stringify(identity)).digest('hex')};
function answerFor(lease:BridgeLease){
 const data=lease.data as {itemId:string;evidence:{sourceId:string;locators:{id:string;quote:string}[]}[]};
 const source=data.evidence[0],locator=source.locators[0];
 const output:AssessmentOutput={itemId:data.itemId,outcome:'supported',assertions:[{claimId:'claim1',sourceId:source.sourceId,locatorId:locator.id,quote:locator.quote,subjectId:null,objectId:null,unit:null,value:null,date:null,dateRole:null,financialRole:'none',stage:null,modality:'unknown'}],scores:{correctness:2,sources:2,usefulness:1},holdReasons:[],rationale:'Synthetic bridge integration fixture, never a civic assessment.',valueReview:null};
 const startedAt=new Date().toISOString(),finishedAt=new Date().toISOString();
 const stdout=[JSON.stringify({type:'system',subtype:'init',tools:[],mcp_servers:[],model:identity.model}),JSON.stringify({type:'assistant',message:{id:'msg_synthetic_'+lease.leaseId,model:identity.model,content:[]}}),JSON.stringify({type:'result',subtype:'success',is_error:false,model:identity.model,request_id:'req_synthetic_'+lease.leaseId,structured_output:output,usage:{input_tokens:11,output_tokens:7},total_cost_usd:0.003})].join('\n')+'\n';
 return {stdout,evidence,startedAt,finishedAt};
}
function submitFor(lease:BridgeLease){
 const answer=answerFor(lease);
 return {operation:'submit' as const,leaseId:lease.leaseId,inputSha256:lease.inputSha256,purgeAck:{sourceFiles:0 as const,responseFiles:0 as const,modelFileWritesDenied:true as const,completedAt:new Date().toISOString()},answer};
}

async function fixture(pool:Pool,name:string){
 const directory=await mkdtemp(join(await realpath(tmpdir()),'assessment-broker-test-'));
 const stateDir=join(directory,'policy');
 // Explicit isolated TEST owner provisioning, never broker auto-provisioning.
 const authority=await provisionCivicPolicyAuthority({stateDir,authorityId:'fixture:'+randomUUID()});
 const policyOptions={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const cas=new DistrictCas(join(directory,'cas'),{maxBytes:1024*1024});
 await initializeManagedAcquisitionLane(cas.root,{...policyOptions,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const store=new DistrictJobStore(pool),broker=new DistrictAssessmentBroker(pool,cas,{policyOptions,fixtureProtocol:true});
 const text='Synthetic original evidence '+name+' '+randomUUID()+'.',sourceSha256=digest(text),sourceId='source-'+randomUUID(),url='https://example.org/'+sourceId+'.txt';
 const scope={publisherId:'synthetic-test',sourceId,municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'2026-10-11'};
 const now=Date.now(),checkedAt=new Date(now-1000).toISOString(),expiresAt=new Date(now+120000).toISOString();
 const proof=await createPolicyReceipt({source:{url,sha256:sourceSha256,mimeType:'text/plain'},sourcePolicy:{robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'},permission:{kind:'distribution_licence',distributionUrl:url,licenceId:'synthetic-test-only',termsUrl:'https://example.org/test-terms',termsSha256:digest('test terms'),approvalSha256:digest('test approval')},scope,checkedAt,expiresAt},policyOptions);
 const put=async(bytes:Buffer,kind:ArtifactKind)=>{
  const hash=digest(bytes),artifact=await withManagedSourceWrite(cas.root,[{kind:'http_observation',relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,sourceSha256,url,observationId:name,receiptSha256:proof.receiptSha256,independentAllowed:kind==='source_original'}],()=>cas.put(bytes,{kind,mimeType:kind==='source_original'?'text/plain':'application/json',...(kind==='source_original'?{admission:{state:'allowed' as const,sourceSha256,policyProofSha256:proof.receiptSha256,checkedAt,expiresAt}}:{})}),policyOptions);
  await store.addArtifact(artifact);return artifact;
 };
 await put(Buffer.from(canonicalJson(proof.receipt)),'receipt');await put(Buffer.from(text),'source_original');
 const parser:StepReceipt={version:'district-step-receipt-v1',canonicalizationVersion:'district-json-v1',id:randomUUID(),runId:randomUUID(),jobKey:digest('parse '+name),step:'parse',lane:'cpu',sourceId,municipalityId:'strausberg',attempt:1,leaseToken:'1',category:'development',dependencyReceiptIds:[],enqueuedAt:checkedAt,startedAt:checkedAt,finishedAt:checkedAt,queueWaitMs:0,elapsedMs:null,cpuUserMicros:null,cpuSystemMicros:null,outcome:'succeeded',reasonCode:'completed',inputHashes:[sourceSha256],outputHashes:[sourceSha256],policyProofSha256:proof.receiptSha256,originProofSha256:null,versions:{parser:'synthetic-parser-v1'},cache:{disposition:'miss',originalGenerationReceiptId:null},provider:null,counts:unknownReceiptCounts};
 const parserArtifact=await put(Buffer.from(encodeStepReceipt(parser).bytes),'receipt');
 const rubric='Synthetic frozen rubric';
 const item=assessmentItemSchema.parse({version:'assessment-item-v1',itemId:name,question:'What does the original source establish?',claim:'',rubric,rubricSha256:digest(rubric),sources:[{sourceId,originalSha256:sourceSha256,textSha256:sourceSha256,parserVersion:'synthetic-parser-v1',parserReceiptSha256:parserArtifact.sha256,admissionReceiptSha256:proof.receiptSha256,ocrSuspected:false,locators:[{id:'page1',page:1,table:null,start:0,end:text.length}]}],claimIds:['claim1'],entityIds:[],constraints:[],criticalKinds:[]});
 const itemArtifact=await put(Buffer.from(canonicalJson(item)),'derived'),snapshotId=randomUUID();
 await pool.query(`INSERT INTO district_pipeline.source_snapshots(id,publisher_id,source_id,municipality_id,ags,tenant,resource_identity,request_method,request_selector_sha256,observation_window,retrieved_at,scope_sha256) VALUES($1,$2,$3,$4,$5,NULL,$6,'GET',$7,$8,$9,$10)`,[snapshotId,scope.publisherId,sourceId,scope.municipalityId,scope.ags,url,digest('GET'),scope.observationWindow,checkedAt,semanticHash(scope)]);
 await pool.query(`INSERT INTO district_pipeline.policy_decisions(id,source_snapshot_id,proof_sha256,source_sha256,receipt_json,state,observed_robots,owner_robots_override,opt_out_version,policy_version,checked_at,expires_at,reason_code) VALUES($1,$2,$3,$4,$5,'allowed','allowed',false,$6,$7,$8,$9,'synthetic_shared_admission')`,[randomUUID(),snapshotId,proof.receiptSha256,sourceSha256,proof.receipt,proof.receipt.optOutSnapshotSha256,proof.receipt.version,checkedAt,expiresAt]);
 const jobKey=await enqueueAssessmentB(broker,{itemArtifactSha256:itemArtifact.sha256,sourceScope:scope,policyProofSha256:proof.receiptSha256,transport:'mac-bridge',clientContractSha256});
 return {directory,policyOptions,authority,cas,store,broker,jobKey,text,itemArtifact,proof};
}
async function ready(pool:Pool,jobKey:string){
 const deadline=Date.now()+5000;
 for(;;){const rows=await pool.query<{id:string;state:string}>(`SELECT b.id,b.state FROM district_pipeline.assessment_bridge_leases b JOIN district_pipeline.jobs j ON j.id=b.job_id WHERE j.job_key=$1 AND b.state='ready' ORDER BY b.created_at DESC LIMIT 1`,[jobKey]);if(rows.rows[0])return rows.rows[0];if(Date.now()>=deadline)throw Error('Synthetic bridge did not become ready within fixture bound');await delay(10);}
}

test('fenced B assessment protocol against isolated local Postgres',{skip:!connectionString,timeout:120000},async t=>{
 const base=new URL(connectionString!);
 if(!['postgres:','postgresql:'].includes(base.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(base.hostname))throw Error('Broker fixture refuses a remote database');
 const host=base.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Broker fixture refuses a remote host override');
 const admin=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:10000}),database='district_bridge_test_'+randomUUID().replaceAll('-','');
 const closeAdmin=poolShutdownBarrier(admin);let pool:Pool|undefined,closePool:(()=>Promise<void>)|undefined,created=false;const directories:string[]=[];
 t.after(async()=>{try{await closePool?.();if(created)await admin.query('DROP DATABASE "'+database+'"');}finally{await closeAdmin();for(const directory of directories)await rm(directory,{recursive:true,force:true});}});
 await admin.query('CREATE DATABASE "'+database+'"');created=true;const isolated=new URL(base);isolated.pathname='/'+database;
 pool=new Pool({connectionString:isolated.href,max:8,connectionTimeoutMillis:5000,statement_timeout:10000});closePool=poolShutdownBarrier(pool);const db=pool;
 await migrateDistrictJobs(db);
 const start=async(name:string,bounded=false)=>{
  const f=await fixture(db,name);directories.push(f.directory);
  const notificationApprovalSha256=digest('synthetic-notification-approval'),destinationSha256=digest('synthetic-destination');
  const notifications:OwnerNotification[]=[];
  const notifyOwner=async(payload:OwnerNotification):Promise<NotificationAcknowledgement>=>{notifications.push(payload);return {provider:'synthetic-test',messageId:'synthetic-'+payload.id,notificationId:payload.id,payloadSha256:digest(canonicalJson(payload)),destinationSha256,acknowledgedAt:new Date().toISOString()};};
  const authorizationId=await f.store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[f.jobKey],ags:['12064472'],maxJobs:1,maxElapsedMs:60000,category:'development',mode:bounded?'bounded_unattended':'attended',...(bounded?{notificationApprovalSha256,notificationDestinationSha256:destinationSha256,notificationProvider:'synthetic-test'}:{})});
  const controller=new AbortController();
  const run=runDistrictJobs({store:f.store,cas:f.cas,handlers:{assessment_b:assessmentBJobHandler(f.broker)},authorizationId,maxJobs:1,maxElapsedMs:60000,leaseMs:30000,signal:controller.signal,...(bounded?{mode:'bounded_unattended' as const,notifyOwner,notificationApprovalSha256,notificationDestinationSha256:destinationSha256,notificationProvider:'synthetic-test'}:{ownerPresent:true as const})});
  await ready(db,f.jobKey);
  const claim=()=>f.broker.dispatch({operation:'claim',jobKey:f.jobKey,clientId:'synthetic-mac-client',clientContractSha256});
  return {...f,authorizationId,run,claim,notifications,controller};
 };

 await t.test('isolated fixture protocol requires explicit pinned opt-in and cannot authorize the production broker',async()=>{
  const f=await fixture(db,'fixture-boundary');directories.push(f.directory);
  assert.throws(()=>new DistrictAssessmentBroker(db,f.cas,{fixtureProtocol:true,policyOptions:{stateDir:f.policyOptions.stateDir,authorityId:f.authority.authorityId}}),{name:'DistrictExecutionHold',message:'authorization_revoked'});
  const production=new DistrictAssessmentBroker(db,f.cas,{policyOptions:f.policyOptions});
  const authorizationId=await f.store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[f.jobKey],ags:['12064472'],maxJobs:1,maxElapsedMs:60000,category:'development',mode:'attended'});
  const run=await runDistrictJobs({store:f.store,cas:f.cas,handlers:{assessment_b:assessmentBJobHandler(production)},authorizationId,maxJobs:1,maxElapsedMs:60000,ownerPresent:true,leaseMs:30000});
  assert.equal(run.state,'held');assert.equal(run.reasonCode,'authorization_revoked');
  assert.equal((await db.query('SELECT id FROM district_pipeline.assessment_bridge_leases WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1)',[f.jobKey])).rowCount,0);
  const nativeKey=await enqueueAssessmentB(f.broker,{itemArtifactSha256:f.itemArtifact.sha256,sourceScope:f.proof.receipt.scope,policyProofSha256:f.proof.receiptSha256,transport:'vm-omp'});
  const nativeAuthorization=await f.store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[nativeKey],ags:['12064472'],maxJobs:1,maxElapsedMs:60000,category:'development',mode:'attended'});
  const nativeRun=await runDistrictJobs({store:f.store,cas:f.cas,handlers:{assessment_b:assessmentBJobHandler(f.broker)},authorizationId:nativeAuthorization,maxJobs:1,maxElapsedMs:60000,ownerPresent:true,leaseMs:30000});
  assert.equal(nativeRun.state,'held');assert.equal(nativeRun.reasonCode,'isolation_unavailable');
  assert.equal((await db.query('SELECT id FROM district_pipeline.assessment_bridge_leases WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1)',[nativeKey])).rowCount,0);
 });

 await t.test('intent commits before transfer; genuine answer, inputs and purge acknowledgement persist on the VM',async()=>{
  const f=await start('accepted');
  const lease=BridgeLeaseSchema.parse(await f.claim());
  assert.equal(lease.authorityId,f.authority.authorityId);assert.equal(lease.authoritySha256,f.authority.authoritySha256);
  const intent=await db.query<{intent_sha256:string}>('SELECT intent_sha256 FROM district_pipeline.assessment_bridge_submission_intents WHERE lease_id=$1',[lease.leaseId]);assert.equal(intent.rows.length,1);
  const second=BridgeStatusSchema.parse(await f.claim());assert.equal(second.state,'active');assert.equal('data' in second,false,'ambiguous reconnect cannot get another submission payload');
  const request=submitFor(lease),ack=BridgeStatusSchema.parse(await f.broker.dispatch(request));
  assert.equal(ack.state,'submitted');assert.equal(ack.inputSha256,lease.inputSha256);assert.equal(ack.purgeAckSha256,semanticHash(request.purgeAck));assert.ok(ack.receiptSha256);
  const run=await f.run;assert.equal(run.state,'completed');
  assert.deepEqual(await f.broker.dispatch(request),ack,'exact ACK replay has no model/resubmission effect');
  await assert.rejects(f.broker.dispatch({...request,answer:{...request.answer,stdout:request.answer.stdout+'\n'}}));
  const submission=await db.query<{provider_response_sha256:string;receipt_artifact_sha256:string;answer_artifact_sha256:string;reconciliation_input_sha256:string;committed_at:Date}>('SELECT * FROM district_pipeline.assessment_bridge_submissions WHERE lease_id=$1',[lease.leaseId]);
  assert.ok(submission.rows[0].committed_at instanceof Date,'the unlocked/fenced receipt path must support real pg audit timestamps');
  assert.equal((await f.cas.read(submission.rows[0].provider_response_sha256)).toString('utf8'),request.answer.stdout);
  const receipt=JSON.parse((await f.cas.read(submission.rows[0].receipt_artifact_sha256)).toString('utf8'));assert.equal(receipt.startedAt,request.answer.startedAt);assert.equal(receipt.finishedAt,request.answer.finishedAt);assert.equal(receipt.estimatedApiUsd,0.003);
  const reconciliation=JSON.parse((await f.cas.read(submission.rows[0].reconciliation_input_sha256)).toString('utf8'));assert.equal(reconciliation.itemArtifactSha256,f.itemArtifact.sha256);assert.equal(reconciliation.B.receiptSha256,receipt.receiptSha256);
  const step=await db.query<{receipt:{provider:{estimatedApiUsd:number}}}>('SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=$1',[run.runId]);assert.equal(step.rows[0].receipt.provider.estimatedApiUsd,0.003);
  const metadata=await db.query('SELECT to_jsonb(b) AS metadata FROM district_pipeline.assessment_bridge_leases b WHERE id=$1',[lease.leaseId]);assert.equal(canonicalJson(metadata.rows).includes(f.text),false);
  await assert.rejects(db.query('UPDATE district_pipeline.assessment_bridge_submission_intents SET client_id=$2 WHERE lease_id=$1',[lease.leaseId,'other-client']),/Immutable/);
 });

 await t.test('slow real evidence, managed writes and receipt reads do not block executor heartbeats',async slow=>{
  // Much shorter SQL timeout than the real evidence delay, without extending
  // either SQL timeout or executor lease to conceal blocked authority locks.
  const heartbeatPool=new Pool({connectionString:isolated.href,max:8,connectionTimeoutMillis:5000,statement_timeout:400});
  const closeHeartbeatPool=poolShutdownBarrier(heartbeatPool);
  const f=await fixture(heartbeatPool,'slow-evidence-heartbeat');directories.push(f.directory);
  const controller=new AbortController();
  let run:Promise<unknown>|undefined;
  slow.after(async()=>{controller.abort();try{await run;}finally{await closeHeartbeatPool();}});
  const renewedDuring=new Set<string>(),receiptHashes=new Set<string>();
  const delayed=async<T>(kind:string,body:()=>Promise<T>):Promise<T>=>{
   const before=(await db.query<{state:string;lease_expires_at:Date}>('SELECT state,lease_expires_at FROM district_pipeline.jobs WHERE job_key=$1',[f.jobKey])).rows[0];
   await delay(1100);
   const after=(await db.query<{state:string;lease_expires_at:Date}>('SELECT state,lease_expires_at FROM district_pipeline.jobs WHERE job_key=$1',[f.jobKey])).rows[0];
   assert.equal(before.state,'leased');assert.equal(after.state,'leased');
   assert.ok(after.lease_expires_at>before.lease_expires_at,kind+' must allow a real committed executor heartbeat while evidence IO exceeds statement_timeout');
   renewedDuring.add(kind);
   return body();
  };
  // Delay the actual private work; never replace authenticated evidence or CAS
  // results with a fixture answer. No production test-only callback is added.
  const hooks=f.broker as unknown as {checkedEvidence(...args:unknown[]):Promise<unknown>;persist(...args:unknown[]):Promise<unknown>};
  const checked=hooks.checkedEvidence.bind(f.broker),persist=hooks.persist.bind(f.broker),read=f.cas.read.bind(f.cas);
  slow.mock.method(hooks,'checkedEvidence',(...args:unknown[])=>delayed('checkedEvidence',()=>checked(...args)));
  slow.mock.method(hooks,'persist',(...args:unknown[])=>delayed('managedWrite',async()=>{
   const artifact=await persist(...args);
   if(args[1]==='receipt')receiptHashes.add(digest(args[0] as Buffer));
   return artifact;
  }));
  slow.mock.method(f.cas,'read',(hash:string)=>receiptHashes.has(hash)?delayed('receiptRead',()=>read(hash)):read(hash));
  const authorizationId=await f.store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[f.jobKey],ags:['12064472'],maxJobs:1,maxElapsedMs:60000,category:'development',mode:'attended'});
  const execution=runDistrictJobs({store:f.store,cas:f.cas,handlers:{assessment_b:assessmentBJobHandler(f.broker)},authorizationId,maxJobs:1,maxElapsedMs:60000,leaseMs:1800,signal:controller.signal,ownerPresent:true});
  run=execution;
  await ready(db,f.jobKey);
  const lease=BridgeLeaseSchema.parse(await f.broker.dispatch({operation:'claim',jobKey:f.jobKey,clientId:'synthetic-slow-client',clientContractSha256}));
  assert.equal(BridgeStatusSchema.parse(await f.broker.dispatch(submitFor(lease))).state,'submitted');
  assert.equal((await execution).state,'completed');
  assert.deepEqual([...renewedDuring].sort(),['checkedEvidence','managedWrite','receiptRead']);
  const receipts=await db.query<{reason_code:string}>("SELECT r.receipt->>'reasonCode' AS reason_code FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id WHERE j.job_key=$1",[f.jobKey]);
  assert.deepEqual(receipts.rows.map(row=>row.reason_code),['completed']);
 });

 for(const phase of ['prepare','claim','submit'] as const)for(const mutation of ['policy','snapshot','artifact'] as const){
  await t.test(`${phase} fences ${mutation} changes made after unlocked authenticated IO`,async race=>{
   const f=await fixture(db,`${phase}-${mutation}-unlocked`);directories.push(f.directory);
   const controller=new AbortController();
   let run:Promise<unknown>|undefined,armed=phase==='prepare',mutated=false;
   let mutationWork:Promise<void>|undefined;
   race.after(async()=>{controller.abort();await run;});
   const mutate=()=>{
    mutationWork??=(async()=>{
    mutated=true;
    if(mutation==='policy')await db.query("UPDATE district_pipeline.policy_decisions SET state='excluded' WHERE proof_sha256=$1",[f.proof.receiptSha256]);
    else if(mutation==='snapshot'){
     // Snapshots/receipt bodies are immutable: publish a genuine newer allowed
     // receipt rather than bypassing their database immutability protections.
     const original=f.proof.receipt;
     const refreshed=await createPolicyReceipt({source:original.source,sourcePolicy:original.sourcePolicy,permission:original.permission,scope:original.scope,checkedAt:new Date().toISOString(),expiresAt:original.expiresAt},f.policyOptions);
     const bytes=Buffer.from(canonicalJson(refreshed.receipt)),hash=digest(bytes);
     const artifact=await withManagedSourceWrite(f.cas.root,[{kind:'prepared_source',relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,sourceSha256:original.source.sha256,url:original.source.url,observationId:'synthetic-policy-refresh',receiptSha256:f.proof.receiptSha256,independentAllowed:false}],()=>f.cas.put(bytes,{kind:'receipt',mimeType:'application/json'}),f.policyOptions);
     await f.store.addArtifact(artifact);
     await db.query(`INSERT INTO district_pipeline.policy_decisions(id,source_snapshot_id,proof_sha256,source_sha256,receipt_json,state,observed_robots,owner_robots_override,opt_out_version,policy_version,checked_at,expires_at,reason_code) SELECT $1,source_snapshot_id,$2,source_sha256,$3,'allowed',observed_robots,owner_robots_override,$4,$5,$6,$7,'synthetic_policy_refresh' FROM district_pipeline.policy_decisions WHERE proof_sha256=$8`,[randomUUID(),hash,refreshed.receipt,refreshed.receipt.optOutSnapshotSha256,refreshed.receipt.version,refreshed.receipt.checkedAt,refreshed.receipt.expiresAt,f.proof.receiptSha256]);
    }else await db.query("UPDATE district_pipeline.artifacts SET disposition='excluded' WHERE sha256=$1",[f.proof.receipt.source.sha256]);
    })();
    return mutationWork;
   };
   const hooks=f.broker as unknown as {checkedEvidence(...args:unknown[]):Promise<unknown>;persist(...args:unknown[]):Promise<unknown>};
   const checked=hooks.checkedEvidence.bind(f.broker),persist=hooks.persist.bind(f.broker);
   race.mock.method(hooks,'checkedEvidence',async(...args:unknown[])=>{
    const value=await checked(...args);
    if(armed&&phase!=='submit')await mutate();
    return value;
   });
   let writes=0;
   race.mock.method(hooks,'persist',async(...args:unknown[])=>{
    const value=await persist(...args);
    if(armed&&phase==='submit'&&++writes===4)await mutate();
    return value;
   });
   const authorizationId=await f.store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[f.jobKey],ags:['12064472'],maxJobs:1,maxElapsedMs:60000,category:'development',mode:'attended'});
   const execution=runDistrictJobs({store:f.store,cas:f.cas,handlers:{assessment_b:assessmentBJobHandler(f.broker)},authorizationId,maxJobs:1,maxElapsedMs:60000,leaseMs:30000,signal:controller.signal,ownerPresent:true});run=execution;
   if(phase!=='prepare'){
    await ready(db,f.jobKey);
    if(phase==='claim'){
     armed=true;
     const held=await f.broker.dispatch({operation:'claim',jobKey:f.jobKey,clientId:'synthetic-race-client',clientContractSha256});
     assert.equal('data' in held,false);assert.notEqual(BridgeStatusSchema.parse(held).state,'active');
    }else{
     const lease=BridgeLeaseSchema.parse(await f.broker.dispatch({operation:'claim',jobKey:f.jobKey,clientId:'synthetic-race-client',clientContractSha256}));
     armed=true;
     assert.notEqual(BridgeStatusSchema.parse(await f.broker.dispatch(submitFor(lease))).state,'submitted');
    }
   }
   const result=await execution;assert.equal(result.state,'held');assert.ok(mutated);
   assert.equal(result.reasonCode,'policy_excluded');
   const accepted=await db.query("SELECT s.lease_id FROM district_pipeline.assessment_bridge_submissions s JOIN district_pipeline.assessment_bridge_leases b ON b.id=s.lease_id JOIN district_pipeline.jobs j ON j.id=b.job_id WHERE j.job_key=$1 AND s.state='accepted'",[f.jobKey]);
   assert.equal(accepted.rowCount,0);
   if(phase==='prepare')assert.equal((await db.query('SELECT id FROM district_pipeline.assessment_bridge_leases WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1)',[f.jobKey])).rowCount,0);
   if(phase==='claim')assert.equal((await db.query('SELECT lease_id FROM district_pipeline.assessment_bridge_submission_intents WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1)',[f.jobKey])).rowCount,0);
  });
 }

 await t.test('offline unexposed B safely pauses and only explicit resume/new approval may create a new lease',async()=>{
  const f=await start('offline-unexposed'),prior=await ready(db,f.jobKey);
  assert.equal((await db.query('SELECT * FROM district_pipeline.assessment_bridge_submission_intents WHERE lease_id=$1',[prior.id])).rows.length,0);
  f.controller.abort();assert.equal((await f.run).state,'held');
  await f.store.resume(f.jobKey);
  const authorizationId=await f.store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[f.jobKey],ags:['12064472'],maxJobs:1,maxElapsedMs:60000,category:'development'});
  const run=runDistrictJobs({store:f.store,cas:f.cas,handlers:{assessment_b:assessmentBJobHandler(f.broker)},authorizationId,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
  await ready(db,f.jobKey);const lease=BridgeLeaseSchema.parse(await f.claim());assert.notEqual(lease.leaseId,prior.id);
  assert.equal(BridgeStatusSchema.parse(await f.broker.dispatch(submitFor(lease))).state,'submitted');assert.equal((await run).state,'completed');
  const history=await db.query<{state:string}>('SELECT state FROM district_pipeline.assessment_bridge_leases WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1) ORDER BY created_at',[f.jobKey]);assert.deepEqual(history.rows.map(row=>row.state),['held','submitted']);
 });

 await t.test('heartbeat expiry is a durable hold and cannot fabricate a purge acknowledgement or resubmit',async()=>{
  const f=await start('expired'),lease=BridgeLeaseSchema.parse(await f.claim());
  await db.query("UPDATE district_pipeline.assessment_bridge_leases SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[lease.leaseId]);
  const check=BridgeStatusSchema.parse(await f.broker.dispatch({operation:'check',leaseId:lease.leaseId,inputSha256:lease.inputSha256}));assert.equal(check.state,'expired');assert.equal(check.purgeAckSha256,null);
  assert.equal((await f.run).state,'held');
  const ack=BridgeStatusSchema.parse(await f.broker.dispatch({operation:'abandon',leaseId:lease.leaseId,inputSha256:lease.inputSha256,reason:'lease_expired',purgeAck:{sourceFiles:0,responseFiles:0,modelFileWritesDenied:true,completedAt:new Date().toISOString()}}));assert.equal(ack.state,'expired');assert.ok(ack.purgeAckSha256);
  assert.equal((await db.query('SELECT * FROM district_pipeline.assessment_bridge_submissions WHERE lease_id=$1',[lease.leaseId])).rows.length,0);
  assert.equal('data' in await f.claim(),false);
  await assert.rejects(f.broker.dispatch({operation:'submit',leaseId:lease.leaseId,inputSha256:lease.inputSha256,answer:answerFor(lease)}),'purge acknowledgement is required');
  await f.store.resume(f.jobKey);
  const renewedApproval=await f.store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[f.jobKey],ags:['12064472'],maxJobs:1,maxElapsedMs:60000,category:'development'});
  const retried=await runDistrictJobs({store:f.store,cas:f.cas,handlers:{assessment_b:assessmentBJobHandler(f.broker)},authorizationId:renewedApproval,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
  assert.equal(retried.state,'held');assert.equal(retried.reasonCode,'execution_exception');
  assert.equal((await db.query('SELECT * FROM district_pipeline.assessment_bridge_submission_intents WHERE lease_id=$1',[lease.leaseId])).rows.length,1,'new owner approval cannot accidentally replay an ambiguous submission');
 });

 await t.test('revoked execution approval holds B and uses the existing notification outbox',async()=>{
  const f=await start('revoked',true),lease=BridgeLeaseSchema.parse(await f.claim());
  await db.query("UPDATE district_pipeline.preauthorizations SET state='revoked' WHERE id=$1",[f.authorizationId]);
  const check=BridgeStatusSchema.parse(await f.broker.dispatch({operation:'check',leaseId:lease.leaseId,inputSha256:lease.inputSha256}));assert.equal(check.state,'held');assert.equal(check.purgeAckSha256,null);
  const run=await f.run;assert.equal(run.state,'held');assert.equal(run.reasonCode,'authorization_revoked');
  assert.deepEqual(f.notifications.map(n=>n.phase),['startup','disposition']);
  const outbox=await db.query<{state:string}>('SELECT state FROM district_pipeline.owner_notifications WHERE run_id=$1 ORDER BY created_at',[run.runId]);assert.deepEqual(outbox.rows.map(n=>n.state),['delivered','delivered']);
 });

 await t.test('invalid provider execution is preserved privately but never receives a fabricated assessment receipt',async()=>{
  const f=await start('invalid-provider'),lease=BridgeLeaseSchema.parse(await f.claim()),request=submitFor(lease);
  request.answer.stdout=request.answer.stdout.replaceAll('claude-haiku-5-5','claude-sonnet-latest');
  const ack=BridgeStatusSchema.parse(await f.broker.dispatch(request));assert.equal(ack.state,'held');assert.equal(ack.receiptSha256,null);assert.ok(ack.purgeAckSha256);
  assert.equal((await f.run).state,'held');
  const saved=await db.query<{state:string;receipt_artifact_sha256:string|null;provider_response_sha256:string}>('SELECT * FROM district_pipeline.assessment_bridge_submissions WHERE lease_id=$1',[lease.leaseId]);
  assert.equal(saved.rows[0].state,'rejected');assert.equal(saved.rows[0].receipt_artifact_sha256,null);
  assert.equal((await f.cas.read(saved.rows[0].provider_response_sha256)).toString('utf8'),request.answer.stdout);
 });

 await t.test('cancellation, source opt-out, missing canonical source authority and stale fences cannot pass heartbeat or submit',async()=>{
  for(const scenario of ['cancelled','opted-out','authority-missing','stale-fence'] as const){
   const f=await start(scenario),lease=BridgeLeaseSchema.parse(await f.claim());
   if(scenario==='cancelled')await f.store.cancel(f.jobKey);
   if(scenario==='opted-out')await recordHostOptOut({host:'example.org',reason:'rights_holder_objection'},f.policyOptions);
   if(scenario==='authority-missing')await unlink(join(f.policyOptions.stateDir,'authority.json'));
   if(scenario==='stale-fence')await db.query('UPDATE district_pipeline.jobs SET fencing_token=fencing_token+1 WHERE job_key=$1',[f.jobKey]);
   try{
    const held=BridgeStatusSchema.parse(await f.broker.dispatch({operation:'check',leaseId:lease.leaseId,inputSha256:lease.inputSha256}));assert.notEqual(held.state,'active');assert.equal(held.purgeAckSha256,null);
   }catch(error){
    assert.equal(scenario,'authority-missing');assert.ok(error instanceof CivicPolicyStateError);assert.equal(error.code,'CIVIC_POLICY_AUTHORITY_UNPROVISIONED');
   }
   assert.equal((await f.run).state,'held');
   if(scenario==='authority-missing'){
    // The executor records the propagated operator failure and fences the job;
    // the SQL lease need not be rewritten before a later fenced check/submit.
    const saved=await db.query<{state:string;reason_code:string}>('SELECT state,reason_code FROM district_pipeline.jobs WHERE job_key=$1',[f.jobKey]);assert.equal(saved.rows[0].state,'held_execution');assert.equal(saved.rows[0].reason_code,'execution_exception');
   }
   const submitted=BridgeStatusSchema.parse(await f.broker.dispatch(submitFor(lease)));assert.notEqual(submitted.state,'submitted');assert.equal(submitted.receiptSha256,null);
   assert.equal((await db.query('SELECT * FROM district_pipeline.assessment_bridge_submissions WHERE lease_id=$1',[lease.leaseId])).rows.length,0);
  }
 });

 await t.test('authority row locks serialize final claim/submit with competing revocation and run termination',async()=>{
  for(const phase of ['claim','submit'] as const)for(const mutation of ['revoke','terminate'] as const)for(const first of ['broker','authority'] as const){
   const f=await start(`interleave-${phase}-${mutation}-${first}`);
   const nonce=randomUUID().replaceAll('-',''),name='bridge_gate_'+nonce;
   const probePool=new Pool({connectionString:isolated.href,max:1,application_name:name,connectionTimeoutMillis:5000,statement_timeout:10000});
   const probe=new DistrictAssessmentBroker(probePool,f.cas,{policyOptions:f.policyOptions,fixtureProtocol:true});
   const session=await probePool.connect(),probePid=(await session.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;session.release();
   const competitor=await db.connect(),competitorPid=(await competitor.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const gate=await db.connect(),gateKey=parseInt(nonce.slice(0,6),16)+100000;
   const table=phase==='claim'?'assessment_bridge_submission_intents':'assessment_bridge_submissions';
   let triggerCreated=false,gateHeld=false;
   let operation:Promise<unknown>|undefined,competingWrite:Promise<unknown>|undefined;
   const runRow=await db.query<{run_id:string}>('SELECT run_id FROM district_pipeline.assessment_bridge_leases WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1) AND state=$2',[f.jobKey,'ready']);
   const runId=runRow.rows[0].run_id;
   const lease=phase==='submit'?BridgeLeaseSchema.parse(await f.claim()):null;
   const request=lease?submitFor(lease):{operation:'claim' as const,jobKey:f.jobKey,clientId:'synthetic-mac-client',clientContractSha256};
   const writeAuthority=()=>mutation==='revoke'
    ?competitor.query("UPDATE district_pipeline.preauthorizations SET state='revoked' WHERE id=$1",[f.authorizationId])
    :competitor.query("UPDATE district_pipeline.executor_runs SET state='held',reason_code='owner_stopped',finished_at=clock_timestamp() WHERE id=$1",[runId]);
   const waitForBlocker=async(pid:number,blocker:number)=>{
    const deadline=Date.now()+5000;
    for(;;){
     // Queue heartbeats may be ahead of this contender on a tuple lock;
     // require the real transitive blocking chain to reach the intended owner.
     const observed=await db.query<{blocked:boolean}>(`WITH RECURSIVE blocking(pid,seen) AS (
      SELECT $1::integer,ARRAY[$1::integer]
      UNION ALL SELECT blocker.pid,blocking.seen||blocker.pid FROM blocking
      CROSS JOIN LATERAL unnest(pg_blocking_pids(blocking.pid)) AS blocker(pid)
      WHERE NOT blocker.pid=ANY(blocking.seen)
     ) SELECT COALESCE(bool_or(pid=$2),false) AS blocked FROM blocking WHERE pid<>$1`,[pid,blocker]);
     if(observed.rows[0].blocked)return;
     if(Date.now()>=deadline)throw Error(`Expected authority-lock interleaving was not established: ${phase}/${mutation}/${first}`);
     await delay(10);
    }
   };
   try{
    await competitor.query('BEGIN');
    if(first==='broker'){
     // Database-only test barrier at the final intent/result INSERT, after the
     // broker's final validation. No production callback or fake policy gate.
     await db.query(`CREATE FUNCTION district_pipeline.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(18442,TG_ARGV[0]::integer); RETURN NEW; END $$`);
     await db.query(`CREATE TRIGGER ${name} BEFORE INSERT ON district_pipeline.${table} FOR EACH ROW EXECUTE FUNCTION district_pipeline.${name}('${gateKey}')`);triggerCreated=true;
     await gate.query('SELECT pg_advisory_lock(18442,$1)',[gateKey]);gateHeld=true;
     operation=probe.dispatch(request);
     const gatePid=(await gate.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
     await waitForBlocker(probePid,gatePid);
     competingWrite=writeAuthority();
     await waitForBlocker(competitorPid,probePid);
     // The competing authority mutation demonstrably cannot commit between
     // final validation and intent/evidence/result COMMIT.
     await gate.query('SELECT pg_advisory_unlock(18442,$1)',[gateKey]);gateHeld=false;
     const result=await operation;
     if(phase==='claim')BridgeLeaseSchema.parse(result);
     else assert.equal(BridgeStatusSchema.parse(result).state,'submitted');
     await competingWrite;await competitor.query('COMMIT');
    }else{
     // Opposite serialization: authority already changed but is uncommitted.
     // The broker must wait and then observe it, not use an earlier unlocked read.
     await writeAuthority();
     operation=probe.dispatch(request);
     await waitForBlocker(probePid,competitorPid);
     await competitor.query('COMMIT');
     const result=BridgeStatusSchema.parse(await operation);
     assert.equal('data' in result,false);assert.notEqual(result.state,'active');assert.notEqual(result.state,'submitted');
     const accepted=await db.query('SELECT * FROM district_pipeline.assessment_bridge_submissions WHERE lease_id=(SELECT id FROM district_pipeline.assessment_bridge_leases WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1) ORDER BY created_at DESC LIMIT 1)',[f.jobKey]);
     assert.equal(accepted.rows.length,0);
    }
    assert.equal((await f.run).state,'held');
   }finally{
    f.controller.abort();
    if(gateHeld)await gate.query('SELECT pg_advisory_unlock(18442,$1)',[gateKey]);
    await competitor.query('ROLLBACK');
    await Promise.allSettled([...(operation?[operation]:[]),...(competingWrite?[competingWrite]:[]),f.run]);
    if(triggerCreated){await db.query(`DROP TRIGGER ${name} ON district_pipeline.${table}`);await db.query(`DROP FUNCTION district_pipeline.${name}()`);}
    competitor.release();gate.release();await probePool.end();
   }
  }
 });
});
