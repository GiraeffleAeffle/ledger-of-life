import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {canonicalJson,digest,semanticHash} from '../src/district-adapter-contract.ts';
import {DistrictJobStore,migrateDistrictJobs,runDistrictJobs} from '../src/district-jobs.ts';
import type {JobHandler} from '../src/district-jobs.ts';
import {enqueueValueAssessments,enqueueAssessmentResolution,assessmentQueueHandlers,exportValueAssessmentResults} from '../src/district-assessment-jobs.ts';
import {DistrictAssessmentBroker,assessmentBJobHandler,enqueueAssessmentB} from '../src/district-assessment-broker.ts';
import {BridgeLeaseSchema,BridgeStatusSchema} from '../src/district-assessment-bridge-contract.ts';
import {assessmentItemSchema,assessmentOutputSchema,originalEvidence,buildAssessmentPassInput} from '../src/district-assessment.ts';
import type {AssessmentItem,AssessmentPassInput} from '../src/district-assessment.ts';
import {reserveR1CodexCall} from '../src/district-codex-accounting.ts';
import {PROVIDER_CONFIGS,EMPTY_USAGE} from '../src/district-model-contract.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';
import {valueAssessmentFixture,valueOutput} from './district-value-assessment.fixture.ts';

const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
test('candidate value answers run through governed A/B/C and reconciliation with per-question-lane accounting',
 {skip:!connectionString,timeout:120000},async t=>{
 const base=new URL(connectionString!);if(!['localhost','127.0.0.1','[::1]',''].includes(base.hostname))throw Error('Fixture refuses remote PostgreSQL');
 const host=base.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Fixture refuses remote host override');
 const admin=new Pool({connectionString,max:2}),closeAdmin=poolShutdownBarrier(admin),database='district_value_queue_'+randomUUID().replaceAll('-','');
 let pool:Pool|undefined,closePool:(()=>Promise<void>)|undefined,created=false;
 const f=await valueAssessmentFixture(true);t.after(async()=>{try{await closePool?.();if(created)await admin.query('DROP DATABASE "'+database+'"');}finally{await closeAdmin();await rm(f.directory,{recursive:true,force:true});}});
 await admin.query('CREATE DATABASE "'+database+'"');created=true;const url=new URL(base);url.pathname='/'+database;
 pool=new Pool({connectionString:url.href,max:8});closePool=poolShutdownBarrier(pool);const db=pool;
 await migrateDistrictJobs(db);const store=new DistrictJobStore(db),cas=f.context.cas,policy=f.context.policyOptions,scope=f.policy.scope;
 for(const artifact of [f.originalArtifact,f.policyArtifact,f.parserArtifact])await store.addArtifact(artifact);
 const snapshot=randomUUID();
 await db.query(`INSERT INTO district_pipeline.source_snapshots(id,publisher_id,source_id,municipality_id,ags,tenant,resource_identity,request_method,request_selector_sha256,observation_window,retrieved_at,scope_sha256) VALUES($1,$2,$3,$4,$5,NULL,$6,'GET',$7,$8,$9,$10)`,[snapshot,scope.publisherId,scope.sourceId,scope.municipalityId,scope.ags,f.policy.source.url,digest('synthetic GET'),scope.observationWindow,f.policy.checkedAt,semanticHash(scope)]);
 await db.query(`INSERT INTO district_pipeline.policy_decisions(id,source_snapshot_id,proof_sha256,source_sha256,receipt_json,state,observed_robots,owner_robots_override,opt_out_version,policy_version,checked_at,expires_at,reason_code) VALUES($1,$2,$3,$4,$5,'allowed','allowed',false,$6,$7,$8,$9,'synthetic_shared_admission')`,[randomUUID(),snapshot,f.policyArtifact.sha256,f.source.originalSha256,f.policy,f.policy.optOutSnapshotSha256,f.policy.version,f.policy.checkedAt,f.policy.expiresAt]);
 const reportPath=join(f.directory,'collected.json');await writeFile(reportPath,JSON.stringify(f.report),{mode:0o600});
 const manifest={reportPath,sourceBindings:[f.source],custodyReceiptSha256:f.policyArtifact.sha256,maxModelCalls:2};
 const before=(await db.query('SELECT count(*) FROM district_pipeline.jobs')).rows[0].count;
 await assert.rejects(enqueueValueAssessments(db,store,cas,{...manifest,sourceBindings:[]},{policyOptions:policy}));
 assert.equal((await db.query('SELECT count(*) FROM district_pipeline.jobs')).rows[0].count,before);
 const queued=await enqueueValueAssessments(db,store,cas,manifest,{policyOptions:policy});
 assert.equal(queued.jobs.length,37);assert.equal(new Set(queued.jobs.map(job=>job.answerUnitSha256)).size,37);
 const requested=await db.query("SELECT spec FROM district_pipeline.jobs WHERE step='assessment_b'");
 assert.equal(requested.rows.length,37);assert.ok(requested.rows.every(row=>row.spec.selector.transport==='vm-omp'));
 const run=async(key:string,handlers:Readonly<Record<string,JobHandler>>)=>{
  const authorizationId=await store.authorize({approvalSha256:digest('synthetic owner development approval '+randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[key],ags:[scope.ags],maxJobs:1,maxElapsedMs:60000,category:'development'});
  return runDistrictJobs({store,cas,handlers,authorizationId,maxJobs:1,maxElapsedMs:60000,ownerPresent:true,leaseMs:30000});
 };
 const provider=(item:AssessmentItem)=>async(input:AssessmentPassInput)=>{
  if(input.role==='A'){assert.equal(input.assessments,null);assert.equal('assessments' in input.data,false);}
  const output=assessmentOutputSchema.parse(valueOutput(item,item.sources.length?f.quote:undefined)),config=PROVIDER_CONFIGS['openai-subscription'];
  const identity={provider:'openai-subscription' as const,tool:config.tool,toolVersion:'0.0.0-synthetic-test-only',model:config.model,modelIdentityBasis:config.modelIdentityBasis};
  return {value:output,responseSha256:digest(canonicalJson(output)),evidence:{...identity,modelIdentitySha256:digest(JSON.stringify(identity))},requestedModel:config.model,returnedModel:null,reportedModels:[],runtimeWarnings:[],usage:{...EMPTY_USAGE,perModel:{}}};
 };
 for(const selected of [queued.jobs.find(job=>job.questionId==='W01')!,queued.jobs.find(job=>job.questionId==='W03'&&job.lane==='withGraph')!]){
  const item=assessmentItemSchema.parse(JSON.parse((await cas.read(selected.itemArtifactSha256)).toString('utf8')));
  const handlers=assessmentQueueHandlers(db,{policyOptions:policy,fixtureProvider:provider(item)});
  assert.equal((await run(selected.AJobKey,handlers)).state,'completed');
  // Synthetic protocol seam only: production enqueue above always chooses vm-omp.
  const broker=new DistrictAssessmentBroker(db,cas,{policyOptions:policy,fixtureProtocol:true}),clientContractSha256=digest('synthetic fixture client');
  const BJobKey=await enqueueAssessmentB(broker,{itemArtifactSha256:selected.itemArtifactSha256,sourceScope:scope,policyProofSha256:f.policyArtifact.sha256,transport:'mac-bridge',clientContractSha256});
  const pending=run(BJobKey,{assessment_b:assessmentBJobHandler(broker)}),deadline=Date.now()+10000;
  for(;;){const rows=await db.query(`SELECT b.id FROM district_pipeline.assessment_bridge_leases b JOIN district_pipeline.jobs j ON j.id=b.job_id WHERE j.job_key=$1 AND b.state='ready'`,[BJobKey]);if(rows.rowCount)break;if(Date.now()>=deadline)throw Error('Synthetic B lease deadline');await delay(10);}
  const lease=BridgeLeaseSchema.parse(await broker.dispatch({operation:'claim',jobKey:BJobKey,clientId:'synthetic-client',clientContractSha256}));
  assert.equal('assessments' in lease.data,false);assert.equal(lease.data.itemId,item.itemId);
  const input=buildAssessmentPassInput(item,await originalEvidence(item,f.context),'B');assert.equal(canonicalJson(lease.data),canonicalJson(input.data));
  const output=valueOutput(item,item.sources.length?f.quote:undefined),config=PROVIDER_CONFIGS['anthropic-subscription'];
  const identity={provider:'anthropic-subscription' as const,tool:'claude-cli' as const,toolVersion:'0.0.0-synthetic-test-only',model:config.model,modelIdentityBasis:config.modelIdentityBasis};
  const stdout=[{type:'system',subtype:'init',tools:[],mcp_servers:[],model:config.model},{type:'assistant',message:{id:'msg_synthetic',model:config.model,content:[]}},{type:'result',subtype:'success',is_error:false,model:config.model,request_id:'req_synthetic',structured_output:output,usage:{input_tokens:1,output_tokens:1}}].map(value=>JSON.stringify(value)).join('\n')+'\n';
  const now=new Date().toISOString(),submitted=await broker.dispatch({operation:'submit',leaseId:lease.leaseId,inputSha256:lease.inputSha256,purgeAck:{sourceFiles:0,responseFiles:0,modelFileWritesDenied:true,completedAt:now},answer:{stdout,evidence:{...identity,modelIdentitySha256:digest(JSON.stringify(identity))},startedAt:now,finishedAt:now}});
  assert.equal(BridgeStatusSchema.parse(submitted).state,'submitted');assert.equal((await pending).state,'completed');
  const pair={AJobKey:selected.AJobKey,BJobKey};
  const CJobKey=await enqueueAssessmentResolution(db,store,cas,pair,'C',policy);assert.equal((await run(CJobKey,handlers)).state,'completed');
  const finalKey=await enqueueAssessmentResolution(db,store,cas,{...pair,CJobKey},'reconcile',policy);assert.equal((await run(finalKey,handlers)).state,'completed');
  const exported=await exportValueAssessmentResults(db,cas,[finalKey],policy);assert.equal(exported.length,1);
  assert.ok(exported[0].item.endsWith(selected.itemArtifactSha256));assert.ok(exported[0].C.startsWith(cas.root));
  const count=await db.query('SELECT count(*) FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=$1',[selected.answerUnitSha256]);assert.equal(Number(count.rows[0].count),2);
  const over=await store.enqueue({step:'assessment_a',lane:'assessment',semanticContractSha256:digest('synthetic cap check'),inputArtifactHashes:[selected.itemArtifactSha256],sourceScope:scope,selector:{fixture:'third-call-must-hold',answerUnitSha256:selected.answerUnitSha256},policyProofSha256:f.policyArtifact.sha256});
  const denied=await run(over,{assessment_a:async context=>{await reserveR1CodexCall(db,context.job,selected.answerUnitSha256,digest('synthetic forbidden third request'),48);throw Error('Cap was bypassed');}});
  assert.equal(denied.reasonCode,'source_limit_exceeded');
 }
 assert.equal(Number((await db.query('SELECT count(*) FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=$1',[f.source.originalSha256])).rows[0].count),0,'value answer units do not spend or reset source-document call caps');
});
