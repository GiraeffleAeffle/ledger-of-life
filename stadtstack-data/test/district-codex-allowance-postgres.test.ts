import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {canonicalJson,digest} from '../src/district-adapter-contract.ts';
import {DistrictCas,type CasArtifact} from '../src/district-cas.ts';
import {DistrictJobStore,DistrictExecutionHold,migrateDistrictJobs,runDistrictJobs,type ClaimedJob,type DistrictJobSpec,type EnqueueOptions,type JobHandler} from '../src/district-jobs.ts';
import {assessmentQueueContract} from '../src/district-assessment-jobs.ts';
import {registerR1CodexDocument,reserveR1CodexCall,holdR1CodexFailure} from '../src/district-codex-accounting.ts';
import {CODEX_ASSESSMENT_ALLOWANCE_PIN,CodexAssessmentAllowanceSchema,codexAssessmentAllowancePreflight,codexCallCapacity,type CodexAllowanceOptions} from '../src/district-codex-allowance.ts';
import {resumeSubscriptionUsage} from '../src/district-subscription-usage.ts';
import {SubscriptionRuntimeError} from '../src/district-model-contract.ts';
import {failureDiagnostic,runtimeToolEvidence} from '../src/district-model-diagnostics.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';

const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
const parent='2ac6267d17ed08452665a0b2de92ec4da89915fe8619b668b85585301327502b',delegation='a527b02f4fd04487cf9eeb7314f539d83fd841cf0422cc8c2f69e411dd1d369f';
const sourceLimit=(error:unknown)=>error instanceof DistrictExecutionHold&&error.reasonCode==='source_limit_exceeded';
async function fixture(t:TestContext,bodyCount=1,repeatedOriginal=false){
 const base=new URL(connectionString!);if(!['postgres:','postgresql:'].includes(base.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(base.hostname))throw Error('Allowance fixture refuses remote PostgreSQL');
 const host=base.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Allowance fixture refuses remote host override');
 const admin=new Pool({connectionString,max:2}),closeAdmin=poolShutdownBarrier(admin),database='district_allowance_'+randomUUID().replaceAll('-','');
 let created=false,closePool:(()=>Promise<void>)|undefined,directory:string|undefined;
 t.after(async()=>{try{await closePool?.();if(created)await admin.query('DROP DATABASE "'+database+'"');}finally{await closeAdmin();if(directory)await rm(directory,{recursive:true,force:true});}});
 await admin.query('CREATE DATABASE "'+database+'"');created=true;const url=new URL(base);url.pathname='/'+database;
 const pool=new Pool({connectionString:url.href,max:12});closePool=poolShutdownBarrier(pool);await migrateDistrictJobs(pool);
 directory=await mkdtemp(join(tmpdir(),'codex-allowance-'));const cas=new DistrictCas(join(directory,'cas')),store=new DistrictJobStore(pool),{policy}=await createCivicPolicyTestContext(t),nonce=randomUUID();
 const queue=await assessmentQueueContract(),corpus=digest('synthetic corpus '+nonce),policySha=digest('synthetic policy '+nonce),scope={publisherId:'synthetic-publisher',sourceId:'synthetic-'+nonce,municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'2026-10-17'};
 const originals=Array.from({length:bodyCount},(_,index)=>digest('synthetic original '+nonce+' '+(repeatedOriginal?0:index)));
 const cohort={schemaVersion:'r1-nine-town-frozen-assessment-cohort-v1',purpose:'Synthetic content-free allowance fixture',parentApproval:{path:'synthetic-owner.json',sha256:parent},catalogueSha256:digest('synthetic catalogue'),sourceCount:1,documentCount:bodyCount,uniqueOriginalCount:new Set(originals).size,sources:[{source:scope.sourceId,corpusSha256:corpus,scope,documentCount:bodyCount}],documents:originals.map((originalSha256,index)=>({source:scope.sourceId,corpusSha256:corpus,documentId:'synthetic-document-'+index,originalSha256,scope}))};
 const cohortBytes=Buffer.from(canonicalJson(cohort));
 const record={schemaVersion:'r1-codex-assessment-allowance-v1',id:CODEX_ASSESSMENT_ALLOWANCE_PIN.id,issuedBy:'R1 VM lead (omp session in tmux on codex-workstation)',issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:'2026-10-25T21:59:59Z',parentApproval:{id:'r1-nine-town-models-2026-10-13',sha256:parent},delegationApproval:{id:'r1-b-model-sonnet-2026-10-17',sha256:delegation},cohort:{path:'stadtstack-data/reports/approvals/r1-frozen-assessment-cohort-2026-10-17.json',sha256:digest(cohortBytes)},assessment:{projectionVersion:'assessment-source-record-v2',queueContractSha256:queue,steps:['assessment_a','assessment_c']},bounds:{baseMaxCallsPerOriginal:48,maxExtraCallsPerOriginal:24,maxExtraCallsCohort:100,provider:'openai-subscription',paidMicroUsd:0,normalSubscriptionOnly:true},scope:'Synthetic fixture only'};
 const options:CodexAllowanceOptions={fixture:{policy,recordBytes:Buffer.from(canonicalJson(record)),cohortBytes}},pin=()=>{const bytes=options.fixture?.recordBytes;assert.ok(bytes);return {id:record.id,sha256:digest(bytes)};};
 const mutateRecord=(changes:Partial<typeof record>)=>{options.fixture!.recordBytes=Buffer.from(canonicalJson({...record,...changes}));};
 const spec=(step:string,selector:unknown,inputArtifactHashes:string[]=[]):DistrictJobSpec=>({step,lane:'synthetic-allowance',semanticContractSha256:queue,inputArtifactHashes,sourceScope:scope,selector,policyProofSha256:policySha});
 const authorize=(jobKey:string)=>store.authorize({approvalSha256:digest('synthetic authority '+randomUUID()),approvedBy:'synthetic-test-lead',expiresAt:new Date(Date.now()+120000).toISOString(),jobKeys:[jobKey],ags:[scope.ags],maxJobs:10,maxElapsedMs:120000,category:'development'});
 async function run(jobKey:string,step:string,handler:JobHandler){const authorizationId=await authorize(jobKey);return runDistrictJobs({store,cas,authorizationId,ownerPresent:true,maxJobs:1,maxElapsedMs:120000,handlers:{[step]:handler}});}
 async function complete(input:DistrictJobSpec,outputs:CasArtifact[],dependencies:EnqueueOptions['dependencies']=[]){
  const jobKey=await store.enqueue(input,{dependencies});const result=await run(jobKey,input.step,async()=>({outcome:'succeeded',reasonCode:'completed',outputs}));assert.equal(result.state,'completed');
  const rows=await pool.query<{id:string;receipt_id:string;receipt_sha256:string}>('SELECT j.id,r.id AS receipt_id,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id WHERE j.job_key=$1 AND r.outcome=$2',[jobKey,'succeeded']);assert.equal(rows.rows.length,1);const row=rows.rows[0];
  return {id:row.id,jobKey,pin:{jobKey,receiptId:row.receipt_id,receiptSha256:row.receipt_sha256},runId:result.runId};
 }
 async function document(index=0,changes:{legacy?:boolean;value?:boolean;original?:string;maxCalls?:number}={}){
  const extractionArtifact=await cas.put(Buffer.from('synthetic extraction '+nonce+' '+index),{kind:'derived'}),itemArtifact=await cas.put(Buffer.from('synthetic v2 item '+nonce+' '+index),{kind:'derived'}),recordArtifact=await cas.put(Buffer.from('synthetic full record '+nonce+' '+index),{kind:'derived'});
  const extractionSpec=spec('residual_extract',{documentId:'synthetic-document-'+index,corpusSha256:corpus,policyReceiptSha256:policySha,corpusObservations:[{sourceSha256:changes.original??originals[index]}]});
  const extraction=await complete(extractionSpec,[extractionArtifact]);
  const prepareSpec=spec('assessment_prepare',{version:changes.value?'r1-value-assessment-item-job-v1':'r1-assessment-item-job-v1',extraction:extraction.pin,extractionArtifactSha256:extractionArtifact.sha256},[extractionArtifact.sha256]);if(changes.legacy)prepareSpec.semanticContractSha256=digest('synthetic historical projection-v1');
  const preparation=await complete(prepareSpec,[itemArtifact,recordArtifact],[{jobKey:extraction.jobKey,expectedReceiptSha256:extraction.pin.receiptSha256}]);
  const selector={version:'r1-assessment-pass-job-v1',itemArtifactSha256:itemArtifact.sha256,recordArtifactSha256:recordArtifact.sha256,maxModelCalls:changes.maxCalls??48,predecessors:[preparation.pin]};
  const A=spec('assessment_a',selector,[itemArtifact.sha256,recordArtifact.sha256]);const jobKey=await store.enqueue(A,{dependencies:[{jobKey:preparation.jobKey,expectedReceiptSha256:preparation.pin.receiptSha256}]});
  return {index,extraction,preparation,selector,A,jobKey,original:originals[index],itemArtifact,recordArtifact};
 }
 async function seed(original:string,extraction:Awaited<ReturnType<typeof complete>>,count=48,maxCalls=48){
  await registerR1CodexDocument(pool,scope.municipalityId,original,maxCalls);
  const requests=Array.from({length:count},()=>digest('synthetic historical request '+randomUUID()));
  await pool.query(`WITH inserted AS (INSERT INTO district_pipeline.r1_codex_call_intents(id,original_sha256,job_id,fencing_token,request_sha256,stage) SELECT gen_random_uuid(),$1,$2,1,request,'residual_extract' FROM unnest($3::text[]) AS request RETURNING id) INSERT INTO district_pipeline.r1_codex_call_authorizations(intent_id,authorization_id,run_id) SELECT i.id,r.authorization_id,r.id FROM inserted i CROSS JOIN district_pipeline.executor_runs r WHERE r.id=$4`,[original,extraction.id,requests,extraction.runId]);
 }
 const reserve=(job:ClaimedJob,original:string,maxCalls=48,allowance=options)=>reserveR1CodexCall(pool,job,original,digest('synthetic new request '+randomUUID()),maxCalls,allowance);
 const invoke=(entry:Awaited<ReturnType<typeof document>>,action:(job:ClaimedJob)=>Promise<void>)=>run(entry.jobKey,'assessment_a',async({job})=>{await action(job);return {outcome:'succeeded',reasonCode:'completed'};});
 async function quotaHold(entry:Awaited<ReturnType<typeof document>>){
  const resetAt=new Date(Date.now()-1000).toISOString();
  return run(entry.jobKey,'assessment_a',async({job})=>{
   await reserve(job,entry.original);
   const stdout=JSON.stringify({type:'turn.failed',error:{code:'usage_limit_reached',resets_at:resetAt}})+'\n';
   const diagnostic=failureDiagnostic({callId:randomUUID(),provider:'openai-subscription',startedAt:new Date().toISOString(),attempted:true,exitCode:1,failureCategory:'rate_limit',reason:'rate_limit',parserFailureCategory:'rate_limit',...runtimeToolEvidence('openai-subscription',stdout),subscriptionNoOutput:true});
   return holdR1CodexFailure(pool,job,entry.original,new SubscriptionRuntimeError('rate_limit','Synthetic fixture quota failure',{reason:'rate_limit',diagnostic}));
  });
 }
 return {pool,store,cas,record,options,pin,mutateRecord,scope,originals,queue,spec,authorize,run,complete,document,seed,reserve,invoke,quotaHold};
}

test('pinned Codex assessment allowance against disposable PostgreSQL',{skip:!connectionString,timeout:300000},async t=>{
 await t.test('base48 then exactly24 fresh A extras; concurrent final original slot has one winner',async t=>{
  const f=await fixture(t),d=await f.document();await f.seed(d.original,d.extraction);
  const before=await codexAssessmentAllowancePreflight(f.pool,[d.jobKey],f.pin(),f.options);assert.equal(before.jobs[0].capacity.baseRemaining,0);assert.equal(before.jobs[0].capacity.extraRemaining,24);
  const result=await f.invoke(d,async job=>{
   for(let index=0;index<23;index++)await f.reserve(job,d.original);
   const raced=await Promise.allSettled([f.reserve(job,d.original),f.reserve(job,d.original)]);assert.equal(raced.filter(row=>row.status==='fulfilled').length,1);assert.equal(raced.filter(row=>row.status==='rejected'&&sourceLimit(row.reason)).length,1);
   const report=await codexCallCapacity(f.pool,job.jobKey,d.original,48,f.options,true);assert.equal(report.lifetimeCalls,72);assert.equal(report.lifetimeExtraCalls,24);assert.equal(report.allowed,false);
  });assert.equal(result.state,'completed');assert.equal((await f.pool.query('SELECT max_calls FROM district_pipeline.r1_codex_documents')).rows[0].max_calls,48);
  const charges=await f.pool.query<{original_extra_ordinal:number;allowance_sha256:string;cohort_sha256:string;queue_contract_sha256:string}>('SELECT original_extra_ordinal,allowance_sha256,cohort_sha256,queue_contract_sha256 FROM district_pipeline.r1_codex_allowance_intents ORDER BY original_extra_ordinal');
  assert.deepEqual(charges.rows.map(row=>row.original_extra_ordinal),Array.from({length:24},(_,index)=>index+1));
  for(const row of charges.rows){assert.equal(row.allowance_sha256,f.pin().sha256);assert.equal(row.cohort_sha256,f.record.cohort.sha256);assert.equal(row.queue_contract_sha256,f.queue);}
  await assert.rejects(f.pool.query('UPDATE district_pipeline.r1_codex_allowance_intents SET allowance_sha256=$1',[digest('synthetic mutation')]),/Immutable/);
  await assert.rejects(f.pool.query('DELETE FROM district_pipeline.r1_codex_allowance_intents'),/Immutable/);
 });
 await t.test('cohort100 is lifetime across bodies; concurrent final cohort slot has one winner',async t=>{
  const f=await fixture(t,6),documents=[];for(let index=0;index<6;index++){const d=await f.document(index);await f.seed(d.original,d.extraction);documents.push(d);}
  for(let index=0;index<4;index++){const d=documents[index];assert.equal((await f.invoke(d,async job=>{for(let call=0;call<24;call++)await f.reserve(job,d.original);})).state,'completed');}
  assert.equal((await f.invoke(documents[4],async job=>{for(let call=0;call<3;call++)await f.reserve(job,documents[4].original);})).state,'completed');
  const last=documents[5];assert.equal((await f.invoke(last,async job=>{
   const raced=await Promise.allSettled([f.reserve(job,last.original),f.reserve(job,last.original)]);assert.equal(raced.filter(row=>row.status==='fulfilled').length,1);assert.equal(raced.filter(row=>row.status==='rejected'&&sourceLimit(row.reason)).length,1);
   const capacity=await codexCallCapacity(f.pool,job.jobKey,last.original,48,f.options,true);assert.equal(capacity.cohortExtraCalls,100);assert.equal(capacity.cohortExtraRemaining,0);await assert.rejects(f.reserve(job,last.original),sourceLimit);
  })).state,'completed');
  const ledger=await f.pool.query('SELECT count(*) AS count,max(cohort_extra_ordinal) AS maximum FROM district_pipeline.r1_codex_allowance_intents');assert.equal(Number(ledger.rows[0].count),100);assert.equal(ledger.rows[0].maximum,100);
 });
 await t.test('C uses the same authenticated A/prepare/extraction ancestry and lifetime original counter',async t=>{
  const f=await fixture(t),d=await f.document();await f.seed(d.original,d.extraction);await f.invoke(d,async job=>{await f.reserve(job,d.original);});
  const aRows=await f.pool.query('SELECT r.id,r.receipt_sha256 FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id WHERE j.job_key=$1 AND r.outcome=$2',[d.jobKey,'succeeded']);
  const aPin={jobKey:d.jobKey,receiptId:aRows.rows[0].id,receiptSha256:aRows.rows[0].receipt_sha256};
  const B=await f.complete(f.spec('assessment_b',{transport:'vm-omp',itemArtifactSha256:d.itemArtifact.sha256},[d.itemArtifact.sha256]),[]);
  const selector={...d.selector,predecessors:[aPin,B.pin],AJobKey:d.jobKey,BJobKey:B.jobKey},C=f.spec('assessment_c',selector,d.A.inputArtifactHashes),key=await f.store.enqueue(C,{dependencies:selector.predecessors.map(pin=>({jobKey:pin.jobKey,expectedReceiptSha256:pin.receiptSha256}))});
  const report=await codexAssessmentAllowancePreflight(f.pool,[key],f.pin(),f.options);assert.equal(report.jobs[0].capacity.lifetimeCalls,49);
  assert.equal((await f.run(key,'assessment_c',async({job})=>{await f.reserve(job,d.original);return {outcome:'succeeded',reasonCode:'completed'};})).state,'completed');
 });
 await t.test('two frozen documents with the same original share one24-extra ceiling',async t=>{
  const f=await fixture(t,2,true),a=await f.document(0),b=await f.document(1);assert.equal(a.original,b.original);await f.seed(a.original,a.extraction);
  assert.equal((await f.invoke(a,async job=>{for(let index=0;index<23;index++)await f.reserve(job,a.original);})).state,'completed');
  const before=await codexAssessmentAllowancePreflight(f.pool,[b.jobKey],f.pin(),f.options);assert.equal(before.cohort.uniqueOriginalCount,1);assert.equal(before.jobs[0].capacity.extraRemaining,1);
  assert.equal((await f.invoke(b,async job=>{await f.reserve(job,b.original);await assert.rejects(f.reserve(job,b.original),sourceLimit);})).state,'completed');
 });
 await t.test('a changed record pin cannot reset immutable original or cohort positions',async t=>{
  const f=await fixture(t),d=await f.document();await f.seed(d.original,d.extraction);const originalPin=f.pin();
  assert.equal((await f.invoke(d,async job=>{
   for(let index=0;index<23;index++)await f.reserve(job,d.original);
   f.mutateRecord({scope:'Synthetic reissued record, same delegated bounds and cohort'});assert.notEqual(f.pin().sha256,originalPin.sha256);
   const capacity=await codexCallCapacity(f.pool,job.jobKey,d.original,48,f.options,true);assert.equal(capacity.lifetimeExtraCalls,23);assert.equal(capacity.cohortExtraCalls,23);
   await f.reserve(job,d.original);await assert.rejects(f.reserve(job,d.original),sourceLimit);
  })).state,'completed');
  const ledger=await f.pool.query('SELECT count(DISTINCT allowance_sha256) AS records,max(original_extra_ordinal) AS maximum FROM district_pipeline.r1_codex_allowance_intents');assert.equal(Number(ledger.rows[0].records),2);assert.equal(ledger.rows[0].maximum,24);
 });
 await t.test('a live lease cannot borrow another job identity for allowance admission',async t=>{
  const f=await fixture(t,2),first=await f.document(0),other=await f.document(1);await f.seed(first.original,first.extraction);await f.seed(other.original,other.extraction);
  assert.equal((await f.invoke(first,async job=>{
   await assert.rejects(f.reserve({...job,jobKey:other.jobKey},other.original),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='lease_lost');
   await f.reserve(job,first.original);
  })).state,'completed');
  const charges=await f.pool.query('SELECT original_sha256 FROM district_pipeline.r1_codex_allowance_intents');assert.deepEqual(charges.rows,[{original_sha256:first.original}]);
 });
 await t.test('the ordinary48 works without an issued allowance, but call49 fails closed',async t=>{
  const f=await fixture(t),d=await f.document();await f.seed(d.original,d.extraction,47);f.mutateRecord({issuedAt:''});
  assert.equal((await f.invoke(d,async job=>{await f.reserve(job,d.original);await assert.rejects(f.reserve(job,d.original),sourceLimit);})).state,'completed');
 });
 await t.test('inconsistent pre-existing excess is never reset or silently accepted',async t=>{
  const f=await fixture(t),d=await f.document();await f.seed(d.original,d.extraction,49);
  const intent=(await f.pool.query('SELECT id FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=$1 LIMIT 1',[d.original])).rows[0].id;
  await assert.rejects(f.pool.query('INSERT INTO district_pipeline.r1_codex_allowance_intents(intent_id,original_sha256,allowance_sha256,cohort_sha256,queue_contract_sha256,original_extra_ordinal,cohort_extra_ordinal) VALUES($1,$2,$3,$4,$5,1,1)',[intent,d.original,f.pin().sha256,f.record.cohort.sha256,f.queue]),/binding/);
  await assert.rejects(codexAssessmentAllowancePreflight(f.pool,[d.jobKey],f.pin(),f.options),sourceLimit);
  assert.equal((await f.invoke(d,async job=>{await assert.rejects(f.reserve(job,d.original),sourceLimit);})).state,'completed');
 });
 for(const mode of ['legacy','value','foreign-original','wrong-queue','expired','unissued','not-fresh','forged-cohort','narrowed','declared'] as const){
  await t.test(mode+' cannot borrow beyond the stored base bound',async t=>{
   const bound=mode==='narrowed'||mode==='declared'?36:48;
   const f=await fixture(t),d=await f.document(0,{legacy:mode==='legacy',value:mode==='value',original:mode==='foreign-original'?digest('foreign original'):undefined,maxCalls:bound});
   await f.seed(d.original,d.extraction,bound,mode==='narrowed'?36:48);
   if(mode==='wrong-queue')f.mutateRecord({assessment:{...f.record.assessment,queueContractSha256:digest('wrong queue')}});
   if(mode==='expired')f.mutateRecord({issuedAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()});
   if(mode==='unissued')f.mutateRecord({issuedAt:''});
   if(mode==='not-fresh')f.mutateRecord({issuedAt:new Date().toISOString()});
   if(mode==='forged-cohort')f.mutateRecord({cohort:{...f.record.cohort,sha256:digest('forged cohort')}});
   assert.equal((await f.invoke(d,async job=>{await assert.rejects(f.reserve(job,d.original,bound),sourceLimit);})).state,'completed');
  });
 }
 await t.test('missing allowance and caller-forged pin do not activate extra capacity',async t=>{
  const f=await fixture(t),d=await f.document();await f.seed(d.original,d.extraction);
  await assert.rejects(codexAssessmentAllowancePreflight(f.pool,[d.jobKey],{...f.pin(),sha256:digest('forged approval')},f.options),sourceLimit);
  f.options.fixture!.recordBytes=null;
  assert.equal((await f.invoke(d,async job=>{await assert.rejects(f.reserve(job,d.original),sourceLimit);await assert.rejects(f.reserve(job,d.original,48,{}),sourceLimit);})).state,'completed');
 });
 await t.test('extraction never borrows extras and the selector/schema cap remains48',async t=>{
  const f=await fixture(t),d=await f.document();await f.seed(d.original,d.extraction);
  assert.equal((await f.invoke(d,async job=>{await f.reserve(job,d.original);})).state,'completed');
  const input=f.spec('residual_extract',{scenario:'synthetic later extraction',nonce:randomUUID()}),key=await f.store.enqueue(input);
  assert.equal((await f.run(key,'residual_extract',async({job})=>{await assert.rejects(f.reserve(job,d.original),sourceLimit);return {outcome:'succeeded',reasonCode:'completed'};})).state,'completed');
  assert.equal(CodexAssessmentAllowanceSchema.safeParse({...f.record,bounds:{...f.record.bounds,baseMaxCallsPerOriginal:49}}).success,false);
 });
 await t.test('native B cannot reserve any assessment-only Codex allowance',async t=>{
  const f=await fixture(t),d=await f.document();await f.seed(d.original,d.extraction);
  const input=f.spec('assessment_b',{transport:'vm-omp',itemArtifactSha256:d.itemArtifact.sha256},[d.itemArtifact.sha256]),key=await f.store.enqueue(input);
  assert.equal((await f.run(key,'assessment_b',async({job})=>{
   await assert.rejects(f.reserve(job,d.original),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='authorization_revoked');
   return {outcome:'succeeded',reasonCode:'completed'};
  })).state,'completed');
  assert.equal(Number((await f.pool.query('SELECT count(*) FROM district_pipeline.r1_codex_allowance_intents')).rows[0].count),0);
 });
 await t.test('failed extra intent is retained; usage resume and read-only preflight agree on remaining capacity',async t=>{
  const f=await fixture(t),d=await f.document();await f.seed(d.original,d.extraction);
  const held=await f.quotaHold(d);assert.equal(held.reasonCode,'budget_paused');
  const report=await codexAssessmentAllowancePreflight(f.pool,[d.jobKey],f.pin(),f.options);assert.equal(report.jobs[0].capacity.lifetimeExtraCalls,1);assert.equal(report.jobs[0].capacity.extraRemaining,23);
  await assert.rejects(resumeSubscriptionUsage(f.pool,{jobKeys:[d.jobKey],approvedBy:'synthetic-test-lead',expiresAt:new Date(Date.now()+60000).toISOString(),maxElapsedMs:60000,mode:'attended'},{checkPolicy:async()=>{}}),sourceLimit);
  const resumed=await resumeSubscriptionUsage(f.pool,{jobKeys:[d.jobKey],approvedBy:'synthetic-test-lead',expiresAt:new Date(Date.now()+60000).toISOString(),maxElapsedMs:60000,mode:'attended'},{checkPolicy:async()=>{},codexAllowance:f.options});assert.ok(resumed);
  const after=await codexAssessmentAllowancePreflight(f.pool,[d.jobKey],f.pin(),f.options);assert.deepEqual(after.jobs,report.jobs);
 });
 await t.test('exhausted allowance stays held in usage resume and read-only preflight',async t=>{
  const f=await fixture(t,2,true),first=await f.document(0),held=await f.document(1);await f.seed(first.original,first.extraction);
  assert.equal((await f.invoke(first,async job=>{for(let index=0;index<23;index++)await f.reserve(job,first.original);})).state,'completed');
  assert.equal((await f.quotaHold(held)).reasonCode,'budget_paused');
  const capacity=await codexCallCapacity(f.pool,held.jobKey,held.original,48,f.options,true);assert.equal(capacity.lifetimeCalls,72);assert.equal(capacity.allowed,false);
  await assert.rejects(codexAssessmentAllowancePreflight(f.pool,[held.jobKey],f.pin(),f.options),sourceLimit);
  await assert.rejects(resumeSubscriptionUsage(f.pool,{jobKeys:[held.jobKey],approvedBy:'synthetic-test-lead',expiresAt:new Date(Date.now()+60000).toISOString(),maxElapsedMs:60000,mode:'attended'},{checkPolicy:async()=>{},codexAllowance:f.options}),sourceLimit);
  assert.equal(Number((await f.pool.query('SELECT count(*) FROM district_pipeline.r1_subscription_resumptions')).rows[0].count),0);
 });
});
