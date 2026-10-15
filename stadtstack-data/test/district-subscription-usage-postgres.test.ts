import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {DistrictCas} from '../src/district-cas.ts';
import {digest,semanticHash} from '../src/district-adapter-contract.ts';
import {DistrictJobStore,migrateDistrictJobs,runDistrictJobs,type ClaimedJob,type JobHandler,type DistrictJobSpec} from '../src/district-jobs.ts';
import {reserveR1CodexCall,holdR1CodexFailure} from '../src/district-codex-accounting.ts';
import {SubscriptionRuntimeError} from '../src/district-model-contract.ts';
import {failureDiagnostic,runtimeToolEvidence} from '../src/district-model-diagnostics.ts';
import {resumeSubscriptionUsage,recordBSubscriptionHold,bSubscriptionFailureVersions,assertBSubscriptionResume,subscriptionUsageStatus,SUBSCRIPTION_RESUME_APPROVAL,SUBSCRIPTION_PARENT_APPROVAL,type UsageResumeInput} from '../src/district-subscription-usage.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';
import {ompSubscriptionLimit} from '../src/district-subscription-limit.ts';
import {cachedModelAnswer,modelAnswerCacheBinding,type CachedAnswer} from '../src/district-answer-cache.ts';
import {prepareDocument,preparedCacheContext,preparedSourceBindings,type PreparedSourceReference} from '../src/district-prepared-document.ts';
import {withManagedSourceWrite} from '../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;

async function fixture(t:TestContext,provider:'openai-subscription'|'anthropic-subscription'='openai-subscription'){
 const base=new URL(connectionString!);
 if(!['postgres:','postgresql:'].includes(base.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(base.hostname))throw Error('Usage fixture refuses remote PostgreSQL');
 const host=base.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Usage fixture refuses remote host override');
 const database='district_usage_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString,max:2}),closeAdmin=poolShutdownBarrier(admin);
 let created=false,pool:Pool|undefined,closePool:(()=>Promise<void>)|undefined,directory:string|undefined;
 t.after(async()=>{try{await closePool?.();if(created)await admin.query('DROP DATABASE "'+database+'"');}finally{await closeAdmin();if(directory)await rm(directory,{recursive:true,force:true});}});
 await admin.query('CREATE DATABASE "'+database+'"');created=true;const url=new URL(base);url.pathname='/'+database;
 pool=new Pool({connectionString:url.href,max:8});closePool=poolShutdownBarrier(pool);const db=pool;
 await migrateDistrictJobs(db);directory=await mkdtemp(join(tmpdir(),'subscription-usage-'));
 const cas=new DistrictCas(join(directory,'cas')),store=new DistrictJobStore(db),hash=digest(randomUUID());
 const spec:DistrictJobSpec={step:provider==='openai-subscription'?'residual_extract':'assessment_b',lane:'synthetic-test',semanticContractSha256:hash,inputArtifactHashes:[],sourceScope:{publisherId:'synthetic-publisher',sourceId:'synthetic-source',municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'2026-10-15'},selector:{transport:'vm-omp',nonce:randomUUID()},policyProofSha256:null};
 const jobKey=await store.enqueue(spec),expiresAt=new Date(Date.now()+60000).toISOString();
 const authorizationId=await store.authorize({approvalSha256:digest('synthetic initial authority '+randomUUID()),approvedBy:'synthetic-test-lead',expiresAt,jobKeys:[jobKey],ags:['12064472'],maxJobs:10,maxElapsedMs:60000,category:'development'});
 const run=(handler:JobHandler,authorization=authorizationId)=>runDistrictJobs({store,cas,authorizationId:authorization,maxJobs:1,maxElapsedMs:60000,ownerPresent:true,handlers:{[spec.step]:handler}});
 const input:UsageResumeInput={jobKeys:[jobKey],approvedBy:'synthetic-test-lead',expiresAt,maxElapsedMs:60000,mode:'attended'};
 let policyChecks=0;
 const resume=(overrides:Partial<UsageResumeInput>={})=>resumeSubscriptionUsage(db,{...input,...overrides},{checkPolicy:async()=>{policyChecks++;}});
 const sourceBytes=Buffer.from('Synthetic quota source '+randomUUID()),originalSha256=digest(sourceBytes),requestSha256=digest(randomUUID());
 let job:ClaimedJob|undefined,leaseId:string|undefined;
 async function bridgeIntent(claim:ClaimedJob){
  const artifact=await cas.put(Buffer.from('synthetic bridge artifact'),{kind:'derived',mimeType:'application/json'});await store.addArtifact(artifact);
  const id=randomUUID();
  await db.query(`INSERT INTO district_pipeline.assessment_bridge_leases(id,job_id,run_id,fencing_token,item_sha256,request_artifact_sha256,request_sha256,input_sha256,authority_id,authority_sha256,policy_snapshot_sha256,client_contract_sha256,role,provider,requested_model,state,deadline_at,expires_at,claimed_at,client_id,reason_code) VALUES($1,$2,$3,$4,$5,$5,$5,$5,'fixture:synthetic',$5,$5,$5,'B','anthropic-subscription','claude-haiku-5-5','held',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '30 seconds',clock_timestamp(),'synthetic-vm','budget_paused')`,[id,claim.id,claim.runId,claim.fencingToken,artifact.sha256]);
  await db.query(`INSERT INTO district_pipeline.assessment_bridge_submission_intents(lease_id,job_id,run_id,fencing_token,input_sha256,intent_sha256,client_id) VALUES($1,$2,$3,$4,$5,$6,'synthetic-vm')`,[id,claim.id,claim.runId,claim.fencingToken,artifact.sha256,digest(id)]);
  return id;
 }
 async function hold(resetAt:string|null,noOutput=true,extraIntent=false,authorization=authorizationId,beforeLimit?:(job:ClaimedJob)=>Promise<void>,failure:{exitCode?:number;incomplete?:boolean;omitReceiptProof?:boolean}={}){
  const result=await run(async context=>{
   job=context.job;
   if(provider==='openai-subscription'){
    await beforeLimit?.(job);
    await reserveR1CodexCall(db,job,originalSha256,requestSha256);
    if(extraIntent)await reserveR1CodexCall(db,job,originalSha256,digest('synthetic ambiguous '+randomUUID()));
    const stdout=JSON.stringify({type:'turn.failed',error:{code:'usage_limit_reached',...(resetAt?{resets_at:resetAt}:{})}})+'\n';
    const diagnostic=failureDiagnostic({callId:randomUUID(),provider,startedAt:new Date().toISOString(),attempted:true,exitCode:1,failureCategory:'rate_limit',reason:'rate_limit',parserFailureCategory:'rate_limit',...runtimeToolEvidence(provider,stdout),subscriptionNoOutput:noOutput});
    return holdR1CodexFailure(db,job,originalSha256,new SubscriptionRuntimeError('rate_limit','Synthetic fixture quota failure',{reason:'rate_limit',diagnostic}));
   }
   leaseId=await bridgeIntent(job);
   const message={role:'assistant',provider:'anthropic',api:'anthropic-messages',model:'claude-haiku-5-5',timestamp:1,stopReason:'error',content:noOutput?[]:[{type:'text',text:'Synthetic ambiguous partial output'}],errorMessage:JSON.stringify({type:'rate_limit_error',...(resetAt?{reset_at:resetAt}:{})})};
   const events=failure.incomplete?[{type:'session'},{type:'error',error:{type:'rate_limit_error',reset_at:resetAt}}]:[{type:'session'},{type:'agent_start'},{type:'turn_start'},{type:'message_start',message:{...message,stopReason:undefined,errorMessage:undefined}},{type:'message_end',message},{type:'turn_end',message,toolResults:[]},{type:'agent_end',messages:[message]}];
   const evidence=ompSubscriptionLimit(events.map(event=>JSON.stringify(event)).join('\n')+'\n','',new Date().toISOString(),failure.exitCode??0);assert.ok(evidence);
   const client=await db.connect();try{await client.query('BEGIN');await recordBSubscriptionHold(client,authorization,job.id,leaseId,evidence.limit,evidence.noOutput,evidence.failureProof);await client.query('COMMIT');}finally{client.release();}
   return {outcome:'held_execution',reasonCode:'budget_paused',...(!failure.omitReceiptProof?{versions:bSubscriptionFailureVersions(leaseId,evidence.noOutput,evidence.failureProof)}:{})};
  },authorization);
  assert.equal(result.reasonCode,'budget_paused');return {job:job!,leaseId};
 }
 return {db,store,cas,jobKey,spec,authorizationId,run,input,resume,hold,bridgeIntent,sourceBytes,originalSha256,requestSha256,get policyChecks(){return policyChecks;}};
}

test('subscription usage autoresume against disposable PostgreSQL',{skip:!connectionString,timeout:120000},async t=>{
 await t.test('DB clock refuses before the stated reset; fresh canonical authority resumes once after it',async t=>{
  const f=await fixture(t),resetAt=new Date(Date.now()+2000).toISOString();await f.hold(resetAt);
  await assert.rejects(f.resume(),{message:'budget_paused'});
  const status=await subscriptionUsageStatus(f.db);assert.equal(status.holds[0].reset_status,'before_reset');
  await delay(Math.max(0,Date.parse(resetAt)-Date.now()+10));
  const resumed=await f.resume();assert.notEqual(resumed.authorizationId,f.authorizationId);assert.equal(f.policyChecks,1);
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_codex_resumptions')).rowCount,0,'Only reserveR1CodexCall may create canonical resumption rows');
  await assert.rejects(f.resume(),{message:'usage_unknown'});
  const result=await f.run(async context=>{await reserveR1CodexCall(f.db,context.job,f.originalSha256,f.requestSha256);return {outcome:'succeeded',reasonCode:'completed'};},resumed.authorizationId);
  assert.equal(result.state,'completed');assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_codex_resumptions')).rowCount,1);
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_codex_call_intents')).rowCount,2);
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_subscription_resumptions')).rowCount,1);
 });
 await t.test('no stated reset remains held, is reported, and never probes',async t=>{
  const f=await fixture(t);await f.hold(null);await assert.rejects(f.resume(),{message:'budget_paused'});
  assert.equal((await subscriptionUsageStatus(f.db)).holds[0].reset_status,'no_reset_stated');assert.equal(f.policyChecks,0);
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_subscription_resumptions')).rowCount,0);
 });
 await t.test('unknown Codex intents remain immutable and held',async t=>{
  const f=await fixture(t);await f.hold(new Date(Date.now()-1000).toISOString(),true,true);
  await assert.rejects(f.resume(),{message:'usage_unknown'});assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_codex_call_intents')).rowCount,2);
  assert.equal((await f.db.query('SELECT state FROM district_pipeline.jobs WHERE job_key=$1',[f.jobKey])).rows[0].state,'held_execution');
 });
 for(const mode of ['valid','missing','tampered','bad_digest','unmanaged'] as const)await t.test('completed extraction before judge limit reconciles only authenticated reusable cache: '+mode,async t=>{
  const f=await fixture(t),authority=await createCivicPolicyTestContext(t);
  const reference:PreparedSourceReference={id:'synthetic-source',url:'https://stadt.de/source',sha256:f.originalSha256,retrievedAt:'2026-10-11T12:00:00.000Z',locator:'synthetic fixture',mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://stadt.de/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
  const prepared=await prepareDocument({bytes:f.sourceBytes,municipalityId:'strausberg',references:[reference],mimeType:'text/plain',extractorSha256:digest('synthetic cache extractor'),toolVersions:{node:process.versions.node}},async()=>{throw Error('Synthetic text must not launch a parser');});
  const modelIdentitySha256=digest('synthetic readiness identity'),binding=modelAnswerCacheBinding({provider:'openai-subscription',modelIdentitySha256,system:'synthetic frozen extraction',input:{source:{text:prepared.text}},schema:{type:'object'},sourceContext:preparedCacheContext(prepared.receiptSha256,prepared.references)});
  const cacheRoot=join(dirname(f.cas.root),basename(f.cas.root)+'-residual-model',f.jobKey,'cache'),path=join(cacheRoot,binding+'.answer.json');
  const body:CachedAnswer={binding,modelIdentitySha256,receivedAt:new Date().toISOString(),value:{record:null},responseSha256:digest('synthetic completed native response'),returnedModel:null,runtimeWarnings:[]};
  const options={cacheRoot,binding,modelIdentitySha256,sourceContext:{decisionId:authority.decisionId,references:prepared.references,receiptSha256:prepared.receiptSha256,policy:authority.policy}};
  let generated=0;
  await f.hold(new Date(Date.now()-1000).toISOString(),true,false,f.authorizationId,async job=>{
   const generate=async()=>{await reserveR1CodexCall(f.db,job,f.originalSha256,semanticHash(binding));generated++;return body;};
   if(mode==='unmanaged'){await generate();await mkdir(cacheRoot,{recursive:true});await writeFile(path,JSON.stringify({...body,cacheSha256:digest(JSON.stringify(body))})+'\n');}
   else await cachedModelAnswer(options,generate);
  });
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_codex_call_intents')).rowCount,2);
  if(mode==='missing')await rm(path);
  if(mode==='tampered')await writeFile(path,JSON.stringify({...body,value:{record:'unapproved changed bytes'},cacheSha256:digest(JSON.stringify({...body,value:{record:'unapproved changed bytes'}}))})+'\n');
  if(mode==='bad_digest'){
   const bytes=Buffer.from(JSON.stringify({...body,cacheSha256:digest('not the body')})+'\n');
   await withManagedSourceWrite(cacheRoot,preparedSourceBindings(prepared.references,prepared.receiptSha256).map(source=>({...source,relativePath:binding+'.answer.json',contentSha256:digest(bytes)})),()=>writeFile(path,bytes),authority.policy);
  }
  const resume=()=>resumeSubscriptionUsage(f.db,f.input,{casRoot:f.cas.root,completionPolicy:authority.policy,checkPolicy:async()=>{}});
  if(mode!=='valid'){
   await assert.rejects(resume(),{message:'usage_unknown'});
   assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_subscription_resumptions')).rowCount,0);return;
  }
  const bytes=await readFile(path),resumed=await resume();assert.equal(resumed.approval.completionProofs.length,1);assert.equal(resumed.approval.completionProofs[0].answerContentSha256,digest(bytes));
  const result=await f.run(async context=>{
   assert.deepEqual(await cachedModelAnswer(options,async()=>{assert.fail('Completed extraction must be reused, never submitted again');}),body);
   await reserveR1CodexCall(f.db,context.job,f.originalSha256,f.requestSha256);return {outcome:'succeeded',reasonCode:'completed'};
  },resumed.authorizationId);
  assert.equal(result.state,'completed');assert.equal(generated,1);assert.deepEqual(await readFile(path),bytes);
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_codex_call_intents')).rowCount,3);
 });
 await t.test('six source resumptions are a durable ceiling, not reset by new stage authority',async t=>{
  const f=await fixture(t);let authorization=f.authorizationId;
  for(let n=0;n<6;n++){
   await f.hold(new Date(Date.now()-1000).toISOString(),true,false,authorization);
   authorization=(await f.resume()).authorizationId;
  }
  await f.hold(new Date(Date.now()-1000).toISOString(),true,false,authorization);
  await assert.rejects(f.resume(),{message:'source_limit_exceeded'});
  assert.equal((await f.db.query('SELECT count(DISTINCT authorization_id) FROM district_pipeline.r1_subscription_resumptions')).rows[0].count,'6');
 });
 await t.test('Codex output ambiguity never becomes an automatic retry',async t=>{
  const f=await fixture(t);await f.hold(new Date(Date.now()-1000).toISOString(),false);
  await assert.rejects(f.resume(),{message:'budget_paused'});
 });
 await t.test('guarded resume retains unresolved reservations and rolls back its new authority',async t=>{
  const f=await fixture(t),held=await f.hold(new Date(Date.now()-1000).toISOString()),budget=randomUUID();
  await f.db.query(`INSERT INTO district_pipeline.provider_budgets(id,provider,currency,owner_approval_sha256,cap_micro_usd,expires_at) VALUES($1,'synthetic-test','USD',$2,1,$3)`,[budget,digest('synthetic budget'),f.input.expiresAt]);
  await f.db.query(`INSERT INTO district_pipeline.provider_reservations(id,budget_id,job_id,fencing_token,reserved_micro_usd,state) VALUES($1,$2,$3,$4,1,'held_uncertain')`,[randomUUID(),budget,held.job.id,held.job.fencingToken]);
  await assert.rejects(f.resume(),/Job cannot be resumed/);
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.preauthorizations')).rowCount,1);
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_subscription_resumptions')).rowCount,0);
 });
 await t.test('a denied current source policy cannot create a disposition',async t=>{
  const f=await fixture(t);await f.hold(new Date(Date.now()-1000).toISOString());
  await assert.rejects(resumeSubscriptionUsage(f.db,f.input,{checkPolicy:async()=>{throw Error('synthetic policy denial');}}),/synthetic policy denial/);
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_subscription_resumptions')).rowCount,0);
 });
 await t.test('per-original remaining call cap cannot be renewed by new authority',async t=>{
  const f=await fixture(t);await f.hold(new Date(Date.now()-1000).toISOString());
  await f.db.query('UPDATE district_pipeline.r1_codex_documents SET max_calls=2 WHERE original_sha256=$1',[f.originalSha256]);
  const intent=await f.db.query('SELECT * FROM district_pipeline.r1_codex_call_intents');
  await f.db.query(`INSERT INTO district_pipeline.r1_codex_call_intents(id,original_sha256,job_id,fencing_token,request_sha256,stage) VALUES($1,$2,$3,$4,$5,'residual_extract')`,[randomUUID(),f.originalSha256,intent.rows[0].job_id,intent.rows[0].fencing_token,digest('synthetic cap fill')]);
  await assert.rejects(f.resume(),{message:'source_limit_exceeded'});
 });
 await t.test('expiry, parent expiry, revocation and guarded reservations refuse without new authority',async t=>{
  const f=await fixture(t);await f.hold(new Date(Date.now()-1000).toISOString());
  await assert.rejects(f.resume({expiresAt:'2026-10-26T00:00:00Z'}),{message:'authorization_expired'});
  await assert.rejects(f.resume({expiresAt:'2026-10-01T00:00:00Z'}),{message:'authorization_expired'});
  await assert.rejects(f.resume({maxElapsedMs:60001}),{message:'authorization_time_exhausted'});
  await f.db.query("UPDATE district_pipeline.preauthorizations SET state='revoked' WHERE id=$1",[f.authorizationId]);
  await assert.rejects(f.resume(),{message:'authorization_revoked'});
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_subscription_resumptions')).rowCount,0);
 });
 await t.test('concurrent callers cannot double-resume a committed hold',async t=>{
  const f=await fixture(t);await f.hold(new Date(Date.now()-1000).toISOString());
  const outcomes=await Promise.allSettled([f.resume(),f.resume()]);assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_subscription_resumptions')).rowCount,1);
 });
 await t.test('a proven empty B limit admits a newer fenced intent without deleting the claimed lease',async t=>{
  const f=await fixture(t,'anthropic-subscription'),held=await f.hold(new Date(Date.now()-1000).toISOString());
  const resumed=await f.resume();
  const result=await f.run(async context=>{
   const client=await f.db.connect();try{assert.deepEqual(await assertBSubscriptionResume(client,resumed.authorizationId,context.job.id),[held.leaseId]);}finally{client.release();}
   await f.bridgeIntent(context.job);return {outcome:'succeeded',reasonCode:'completed'};
  },resumed.authorizationId);
  assert.equal(result.state,'completed');assert.equal((await f.db.query('SELECT * FROM district_pipeline.assessment_bridge_submission_intents')).rowCount,2);
  const prior=await f.db.query('SELECT state,claimed_at FROM district_pipeline.assessment_bridge_leases WHERE id=$1',[held.leaseId]);assert.equal(prior.rows[0].state,'held');assert.ok(prior.rows[0].claimed_at);
  await assert.rejects(f.db.query('DELETE FROM district_pipeline.assessment_bridge_submission_intents'),/Immutable/);
 });
 for(const failure of [{exitCode:137},{incomplete:true}] as const)await t.test('B killed or unterminated typed limit remains ambiguous: '+JSON.stringify(failure),async t=>{
  const f=await fixture(t,'anthropic-subscription');await f.hold(new Date(Date.now()-1000).toISOString(),true,false,f.authorizationId,undefined,failure);
  assert.equal((await f.db.query('SELECT no_output FROM district_pipeline.r1_subscription_usage_holds')).rows[0].no_output,false);
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.r1_proven_bridge_limit_failures')).rowCount,0);
  await assert.rejects(f.resume(),{message:'budget_paused'});
 });
 await t.test('B certification without its authenticated terminal held receipt cannot bypass the retry trigger',async t=>{
  const f=await fixture(t,'anthropic-subscription');await f.hold(new Date(Date.now()-1000).toISOString(),true,false,f.authorizationId,undefined,{omitReceiptProof:true});
  assert.equal((await f.db.query('SELECT no_output FROM district_pipeline.r1_subscription_usage_holds')).rows[0].no_output,true,'Exercise the independent receipt barrier, not just the certification flag');
  await assert.rejects(f.resume(),{message:'usage_unknown'});
  await f.store.resume(f.jobKey);
  const approvalSha256=digest('synthetic manual bypass attempt'),manual=await f.store.authorize({approvalSha256,approvedBy:'synthetic-manual-lead',expiresAt:f.input.expiresAt,jobKeys:[f.jobKey],ags:['12064472'],maxJobs:1,maxElapsedMs:60000,category:'development'});
  await f.db.query(`INSERT INTO district_pipeline.r1_subscription_resumptions(hold_id,job_id,authorization_id,source_scope_sha256,approval_sha256,owner_approval_sha256,parent_approval_sha256,prior_receipt_sha256) SELECT h.id,h.job_id,$1,$2,$3,$4,$5,s.receipt_sha256 FROM district_pipeline.r1_subscription_usage_holds h JOIN district_pipeline.step_receipts s ON s.job_id=h.job_id`,[manual,digest('synthetic source scope'),approvalSha256,SUBSCRIPTION_RESUME_APPROVAL,SUBSCRIPTION_PARENT_APPROVAL]);
  const result=await f.run(async context=>{await f.bridgeIntent(context.job);return {outcome:'succeeded',reasonCode:'completed'};},manual);
  assert.equal(result.state,'held');assert.equal((await f.db.query('SELECT * FROM district_pipeline.assessment_bridge_submission_intents')).rowCount,1);
 });
 for(const noOutput of [false,true])await t.test(noOutput?'B no-reset hold remains held':'B possible model output remains held',async t=>{
  const f=await fixture(t,'anthropic-subscription');await f.hold(noOutput?null:new Date(Date.now()-1000).toISOString(),noOutput);
  await assert.rejects(f.resume(),{message:'budget_paused'});
  const client=await f.db.connect();try{await assert.rejects(assertBSubscriptionResume(client,f.authorizationId,(await f.db.query('SELECT id FROM district_pipeline.jobs')).rows[0].id),{message:'budget_paused'});}finally{client.release();}
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.assessment_bridge_submission_intents')).rowCount,1);
  await f.store.resume(f.jobKey);
  const manual=await f.store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-manual-lead',expiresAt:f.input.expiresAt,jobKeys:[f.jobKey],ags:['12064472'],maxJobs:1,maxElapsedMs:60000,category:'development'});
  const rawRetry=await f.run(async context=>{await f.bridgeIntent(context.job);return {outcome:'succeeded',reasonCode:'completed'};},manual);
  assert.equal(rawRetry.state,'held','Database trigger retains the ambiguous intent barrier even under a manual queue resume');
  assert.equal((await f.db.query('SELECT * FROM district_pipeline.assessment_bridge_submission_intents')).rowCount,1);
 });
});
