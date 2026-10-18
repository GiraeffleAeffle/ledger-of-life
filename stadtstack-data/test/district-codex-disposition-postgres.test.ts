import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {DistrictCas} from '../src/district-cas.ts';
import {digest,semanticHash} from '../src/district-adapter-contract.ts';
import {DistrictJobStore,migrateDistrictJobs,runDistrictJobs,type ClaimedJob,type JobHandler,type DistrictJobSpec} from '../src/district-jobs.ts';
import {reserveR1CodexCall} from '../src/district-codex-accounting.ts';
import {CODEX_UNSETTLED_RETRY_VERSION,CodexUnsettledRetrySchema,registerCodexUnsettledRetry,readUnknownCodexDispositions,readCodexRetrySettlement,type CodexUnsettledRetry} from '../src/district-codex-disposition.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';
import {cachedModelAnswer,modelAnswerCacheBinding,type CachedAnswer} from '../src/district-answer-cache.ts';
import {prepareDocument,preparedCacheContext,type PreparedSourceReference} from '../src/district-prepared-document.ts';
const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
const pins={parentApproval:{id:'r1-nine-town-models-2026-10-13',sha256:'2ac6267d17ed08452665a0b2de92ec4da89915fe8619b668b85585301327502b'},autonomyApproval:{id:'r1-autonomy-and-release-2026-10-14',sha256:'865e80d2aad2ec23250b83b50c012639d0b04f068fc64d42eabe1b36a82b35f5'},holdPolicy:{id:'r1-lead-hold-resume-policy-2026-10-15',sha256:'c5b15eb22f544b63a8fbf71eb9b5cfbf334ee37340c542a223ad6a5464e4f493'},holdPolicyAmendment:{id:'r1-lead-hold-resume-policy-2026-10-15-amendment-1',sha256:'4ef8a73624eeb33672dc41b367f4c56c7ef9dcbd9df77bff30fffc9d5648befe'}};
async function fixture(t:TestContext,extraUnknown=false,step='residual_extract',withCompletion=false){
 const url=new URL(connectionString!);assert(['','localhost','127.0.0.1','[::1]'].includes(url.hostname));const host=url.searchParams.get('host');assert(!host||host.startsWith('/')||['localhost','127.0.0.1','::1'].includes(host));
 const database='district_codex_disposition_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString,max:1}),closeAdmin=poolShutdownBarrier(admin);let pool:Pool|undefined,directory:string|undefined,created=false;
 t.after(async()=>{try{if(pool)await pool.end();if(created)await admin.query('DROP DATABASE "'+database+'"');}finally{await closeAdmin();if(directory)await rm(directory,{recursive:true,force:true});}});
 await admin.query('CREATE DATABASE "'+database+'"');created=true;url.pathname='/'+database;pool=new Pool({connectionString:url.href,max:4});const db=pool;await migrateDistrictJobs(db);directory=await mkdtemp(join(tmpdir(),'codex-disposition-'));
 const authority=await createCivicPolicyTestContext(t),options={fixture:{policy:authority.policy},casRoot:join(directory,'cas')},store=new DistrictJobStore(db),cas=new DistrictCas(options.casRoot),sourceBytes=Buffer.from('Synthetic source '+randomUUID()),originalSha256=digest(sourceBytes),requestSha256=digest(randomUUID());
 const scope={publisherId:'synthetic-publisher',sourceId:'synthetic-source',municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'synthetic-isolated-fixture'};
 const spec:DistrictJobSpec={step,lane:'synthetic-test',semanticContractSha256:digest(randomUUID()),inputArtifactHashes:[],sourceScope:scope,selector:step==='residual_extract'?{documentId:'synthetic-document'}:{itemArtifactSha256:digest('synthetic-item')},policyProofSha256:null},jobKey=await store.enqueue(spec);
 const authorize=()=>store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-test-lead',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[jobKey],ags:[scope.ags],maxJobs:3,maxElapsedMs:60000,category:'development'});
 const authorizationId=await authorize();let claim:ClaimedJob|undefined,intentId='';
 const run=(handler:JobHandler,authorization:string)=>runDistrictJobs({store,cas,authorizationId:authorization,maxJobs:1,maxElapsedMs:60000,ownerPresent:true,handlers:{[step]:handler}});
 let reusable:{options:Parameters<typeof cachedModelAnswer>[0];body:CachedAnswer;path:string;intentId:string;request:string}|undefined;
 if(withCompletion){
  const reference:PreparedSourceReference={id:'synthetic-source',url:'https://stadt.de/source',sha256:originalSha256,retrievedAt:'2026-10-11T12:00:00.000Z',locator:'synthetic fixture',mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://stadt.de/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
  const prepared=await prepareDocument({bytes:sourceBytes,municipalityId:'strausberg',references:[reference],mimeType:'text/plain',extractorSha256:digest('synthetic extractor'),toolVersions:{node:process.versions.node}},async()=>{assert.fail('No parser may launch');});
  const modelIdentitySha256=digest('synthetic identity'),binding=modelAnswerCacheBinding({provider:'openai-subscription',modelIdentitySha256,system:'synthetic extraction',input:{source:{text:prepared.text}},schema:{type:'object'},sourceContext:preparedCacheContext(prepared.receiptSha256,prepared.references)}),cacheRoot=join(dirname(cas.root),basename(cas.root)+'-residual-model',jobKey,'cache');
  const body:CachedAnswer={binding,modelIdentitySha256,receivedAt:new Date().toISOString(),value:{record:null},responseSha256:digest('synthetic response'),returnedModel:null,runtimeWarnings:[]};
  reusable={options:{cacheRoot,binding,modelIdentitySha256,sourceContext:{decisionId:authority.decisionId,references:prepared.references,receiptSha256:prepared.receiptSha256,policy:authority.policy}},body,path:join(cacheRoot,binding+'.answer.json'),intentId:'',request:semanticHash(binding)};
 }
 await run(async context=>{claim={...context.job,fencingToken:Number(context.job.fencingToken)};if(reusable)await cachedModelAnswer(reusable.options,async()=>{reusable!.intentId=await reserveR1CodexCall(db,context.job,originalSha256,reusable!.request);return reusable!.body;});intentId=await reserveR1CodexCall(db,context.job,originalSha256,requestSha256);if(extraUnknown)await reserveR1CodexCall(db,context.job,originalSha256,digest('synthetic-second-request'));return {outcome:'held_execution',reasonCode:'max_time_reached'};},authorizationId);
 const held=(await db.query('SELECT id,receipt_sha256,receipt FROM district_pipeline.step_receipts WHERE job_id=$1',[claim!.id])).rows[0];
 const record:CodexUnsettledRetry={schemaVersion:'stadtstack-r1-operator-action-record-v1',id:'r1-codex-unsettled-retry-synthetic-'+randomUUID(),action:'codex-unsettled-intent-bounded-retry',version:CODEX_UNSETTLED_RETRY_VERSION,issuedBy:'R1 VM lead (omp session in tmux on codex-workstation)',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+50000).toISOString(),...pins,binding:{scope,step:step as 'residual_extract'|'assessment_a'|'assessment_c',jobKey,jobId:claim!.id,semanticContractSha256:spec.semanticContractSha256,...(step==='residual_extract'?{documentId:'synthetic-document'}:{}),originalSha256,intentId,requestSha256,runId:claim!.runId,authorizationId,fencingToken:claim!.fencingToken,priorAttempt:1,heldReceiptId:held.id,heldReceiptSha256:held.receipt_sha256},completionState:'completion_unknown',decision:'bounded_retry',bounds:{maxReplacementIntents:1,allowedAttempt:2,maxModelCallsPerOriginal:48,paidMicroUsd:0,refund:false,resetLifetimeCalls:false,extraResumes:0,maxResumesPerJobKey:2},reason:'Synthetic fixture: deliberately unknown provider effect; no provider is called.'};
 const register=(value=record)=>{const recordBytes=Buffer.from(JSON.stringify(value)+'\n');return registerCodexUnsettledRetry(db,{recordBytes,recordSha256:digest(recordBytes)},options);};
 const reserve=(job:ClaimedJob,request=requestSha256)=>reserveR1CodexCall(db,job,originalSha256,request,48,{},options);
 return {db,store,jobKey,claim:claim!,record,register,reserve,run,authorize,originalSha256,requestSha256,intentId,options,reusable};
}
test('disposition schema admits only honest bounded retry, never completion or abandonment',async()=>{
 const source=await readFile(new URL('../src/district-codex-disposition.ts',import.meta.url),'utf8');assert(source.includes("completionState:z.literal('completion_unknown')"));
 assert(source.includes("maxReplacementIntents:z.literal(1)"));assert.equal(CodexUnsettledRetrySchema.safeParse({issuedAt:''}).success,false);
});
test('Codex unknown-effect retry against disposable PostgreSQL',{skip:!connectionString,timeout:120000},async t=>{
 await t.test('append-only decision, one NEW charged intent, concurrent duplicate refusal, no extra resume',async t=>{
  const f=await fixture(t),original=(await f.db.query('SELECT * FROM district_pipeline.r1_codex_call_intents WHERE id=$1',[f.intentId])).rows[0],jobBefore=(await f.db.query('SELECT state,attempt,reason_code FROM district_pipeline.jobs WHERE job_key=$1',[f.jobKey])).rows[0];
  const proof=await f.register();assert.equal(proof.completionState,'completion_unknown');assert.equal(proof.replacementIntentId,null);assert.deepEqual(await f.register(),proof,'Same committed decision is recovered, not reissued');
  assert.deepEqual((await f.db.query('SELECT state,attempt,reason_code FROM district_pipeline.jobs WHERE job_key=$1',[f.jobKey])).rows[0],jobBefore,'Registration is not a resume');
  assert.equal((await readCodexRetrySettlement(f.db,f.jobKey,f.options)).length,1);
  for(const change of [{completionState:'completed'},{decision:'terminal_abandonment'},{bounds:{...f.record.bounds,maxReplacementIntents:2}},{bounds:{...f.record.bounds,refund:true}},{issuedAt:''},{expiresAt:'2026-10-26T00:00:00Z'}])assert.equal(CodexUnsettledRetrySchema.safeParse({...f.record,...change}).success,false);
  await assert.rejects(f.register({...f.record,reason:'Conflicting replacement for the already disposed intent'}));
  await f.store.resume(f.jobKey);const auth=await f.authorize();let replacement='';
  await f.run(async context=>{assert.equal(context.job.attempt,2);const pair=await Promise.allSettled([f.reserve(context.job),f.reserve(context.job)]),passed=pair.filter(row=>row.status==='fulfilled'),failed=pair.filter(row=>row.status==='rejected');assert.equal(passed.length,1);assert.equal(failed.length,1);assert.equal((failed[0] as PromiseRejectedResult).reason.message,'usage_unknown');replacement=(passed[0] as PromiseFulfilledResult<string>).value;return {outcome:'held_execution',reasonCode:'max_time_reached'};},auth);
  assert.notEqual(replacement,f.intentId);assert.deepEqual((await f.db.query('SELECT * FROM district_pipeline.r1_codex_call_intents WHERE id=$1',[f.intentId])).rows[0],original,'Old intent retained byte-for-byte');
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM district_pipeline.r1_codex_call_intents')).rows[0].count,2);const consumed=(await readUnknownCodexDispositions(f.db,f.jobKey,f.options))[0];assert.equal(consumed.replacementIntentId,replacement);
  assert.equal((await f.db.query('SELECT sum(paid_micro_usd)::text AS paid FROM district_pipeline.r1_codex_call_intents')).rows[0].paid,'0');
  for(const table of ['r1_codex_unsettled_retries','r1_codex_unsettled_retry_intents'])for(const action of ['DELETE FROM','UPDATE'])await assert.rejects(f.db.query(action==='UPDATE'?`UPDATE district_pipeline.${table} SET ${table.endsWith('_intents')?'replacement_intent_id=replacement_intent_id':'record_id=record_id'}`:`DELETE FROM district_pipeline.${table}`));
  await f.store.resume(f.jobKey);await f.run(async context=>{assert.equal(context.job.attempt,3);await assert.rejects(f.reserve(context.job),{message:'usage_unknown'});return {outcome:'held_execution',reasonCode:'max_time_reached'};},await f.authorize());
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM district_pipeline.r1_codex_call_intents')).rows[0].count,2,'Unknown replacement is not retried again');
 });
 await t.test('wrong job/request/run/authorization/receipt/scope/hash and expired/future authority refuse without state changes',async t=>{
  const f=await fixture(t);
  for(const binding of [{jobId:randomUUID()},{requestSha256:digest('foreign request')},{runId:randomUUID()},{authorizationId:randomUUID()},{heldReceiptSha256:digest('forged receipt')},{scope:{...f.record.binding.scope,sourceId:'foreign-source'}},{fencingToken:2},{documentId:'different-document'}])await assert.rejects(f.register({...f.record,binding:{...f.record.binding,...binding}}));
  await assert.rejects(f.register({...f.record,issuedAt:new Date(Date.now()+30000).toISOString()}));await assert.rejects(f.register({...f.record,expiresAt:f.record.issuedAt}));
  const bytes=Buffer.from(JSON.stringify(f.record));await assert.rejects(registerCodexUnsettledRetry(f.db,{recordBytes:bytes,recordSha256:digest('wrong bytes')},f.options));
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM district_pipeline.r1_codex_unsettled_retries')).rows[0].count,0);assert.equal((await f.db.query('SELECT state FROM district_pipeline.jobs WHERE job_key=$1',[f.jobKey])).rows[0].state,'held_execution');
 });
 for(const mode of ['valid','tampered','completed_target'])await t.test('genuine managed prior answer is read-only, never invented: '+mode,async t=>{
  const f=await fixture(t,false,'residual_extract',true);assert(f.reusable);const reusable=f.reusable,before=await readFile(reusable.path);
  if(mode==='tampered'){await writeFile(reusable.path,Buffer.from('unauthenticated changed fixture bytes'));await assert.rejects(f.register());return;}
  if(mode==='completed_target'){await assert.rejects(f.register({...f.record,binding:{...f.record.binding,intentId:reusable.intentId,requestSha256:reusable.request}}),/Exactly the named unknown intent/);return;}
  await f.register();await f.store.resume(f.jobKey);
  await f.run(async context=>{assert.deepEqual(await cachedModelAnswer(reusable.options,async()=>{assert.fail('Existing completed request must not run again');}),reusable.body);await f.reserve(context.job);return {outcome:'held_execution',reasonCode:'max_time_reached'};},await f.authorize());
  assert.deepEqual(await readFile(reusable.path),before);assert.equal((await f.db.query('SELECT count(*)::int AS count FROM district_pipeline.r1_codex_call_intents')).rows[0].count,3);
 });
 await t.test('a second unknown intent cannot be implicitly disposed',async t=>{const f=await fixture(t,true);await assert.rejects(f.register(),/Exactly the named unknown intent/);});
 await t.test('expired unused record is not settlement or permission for a later attempt',async t=>{
  const f=await fixture(t),record={...f.record,expiresAt:new Date(Date.now()+1800).toISOString()};await f.register(record);await delay(Math.max(0,Date.parse(record.expiresAt)-Date.now()+5));assert.equal((await readCodexRetrySettlement(f.db,f.jobKey,f.options)).length,0);
  await f.store.resume(f.jobKey);await f.run(async context=>{await assert.rejects(f.reserve(context.job),{message:'usage_unknown'});return {outcome:'held_execution',reasonCode:'max_time_reached'};},await f.authorize());
 });
 await t.test('unused record is bound to the NEXT attempt, never a subsequent one',async t=>{
  const f=await fixture(t);await f.register();await f.store.resume(f.jobKey);await f.run(async()=>({outcome:'held_execution',reasonCode:'max_time_reached'}),await f.authorize());assert.equal((await readCodexRetrySettlement(f.db,f.jobKey,f.options)).length,0);await f.store.resume(f.jobKey);
  await f.run(async context=>{await assert.rejects(f.reserve(context.job),{message:'usage_unknown'});return {outcome:'held_execution',reasonCode:'max_time_reached'};},await f.authorize());
 });
 await t.test('new retry remains under the original lifetime 48 cap, including concurrent intervening calls',async t=>{
  const f=await fixture(t);await f.register();await f.store.resume(f.jobKey);
  await f.run(async context=>{for(let n=0;n<47;n++)await f.reserve(context.job,digest('synthetic other request '+n));await assert.rejects(f.reserve(context.job),{message:'source_limit_exceeded'});return {outcome:'held_execution',reasonCode:'max_time_reached'};},await f.authorize());
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM district_pipeline.r1_codex_call_intents')).rows[0].count,48);assert.equal((await f.db.query('SELECT count(*)::int AS count FROM district_pipeline.r1_codex_unsettled_retry_intents')).rows[0].count,0);
 });
 await t.test('original authority revocation and unresolved account usage remain hard stops',async t=>{
  const f=await fixture(t);await f.db.query("UPDATE district_pipeline.preauthorizations SET state='revoked' WHERE id=$1",[f.record.binding.authorizationId]);await assert.rejects(f.register());
  const g=await fixture(t);await g.db.query('INSERT INTO district_pipeline.r1_codex_usage_holds(authorization_id,run_id,failed_intent_id) VALUES($1,$2,$3)',[g.record.binding.authorizationId,g.claim.runId,g.intentId]);await assert.rejects(g.register(),/Unresolved provider\/usage hold/);
 });
 await t.test('fixture seam accepts only an isolated fixture authority, never an environment switch',async t=>{
  const f=await fixture(t),recordBytes=Buffer.from(JSON.stringify(f.record));await assert.rejects(registerCodexUnsettledRetry(f.db,{recordBytes,recordSha256:digest(recordBytes)},{fixture:{policy:{...f.options.fixture.policy,stateDir:join(f.options.casRoot,'nonexistent-authority')}}}));
 });
 for(const step of ['assessment_a','assessment_c'])await t.test('same exact accounting decision applies to '+step+' without inventing a source document selector',async t=>{const f=await fixture(t,false,step);await f.register();await f.store.resume(f.jobKey);await f.run(async context=>{await f.reserve(context.job);return {outcome:'held_execution',reasonCode:'max_time_reached'};},await f.authorize());assert.equal((await f.db.query('SELECT count(*)::int AS count FROM district_pipeline.r1_codex_call_intents')).rows[0].count,2);});
 });
