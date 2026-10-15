import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {canonicalJson,digest} from '../src/district-adapter-contract.ts';
import {DistrictCas} from '../src/district-cas.ts';
import {DistrictJobStore,DistrictExecutionHold,migrateDistrictJobs,insertR1MetadataSnapshot,runDistrictJobs,runDistrictJobsCli,deliverDistrictOwnerNotifications,artifactVerificationHandler,type AuthorizationInput,type ClaimedJob,type DistrictJobSpec,type JobHandler,type OwnerNotification,type NotificationAcknowledgement} from '../src/district-jobs.ts';
import {CANONICALIZATION_VERSION,STEP_RECEIPT_VERSION,unknownReceiptCounts,type StepReceipt} from '../src/district-step-receipt.ts';
import {reserveR1CodexCall} from '../src/district-codex-accounting.ts';
import {NotificationAmbiguousError,NotificationTransientError} from '../src/district-jobs.ts';
import {pipelineNotificationConfig,sendPipelineNotification} from '../src/district-notifications.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';
import {reportR1ExecutorFailure} from '../src/district-r1.ts';

// Real Postgres only. The connection must be local and its role must have CREATEDB.
// Run: DISTRICT_TEST_DATABASE_URL=postgresql://localhost/postgres node --experimental-strip-types --test test/district-jobs-postgres.test.ts
// Each invocation creates/drops its own randomly named database; no existing schema is cleared.
const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;

function jobSpec(name:string,step='verify_artifacts',hashes:string[]=[]):DistrictJobSpec {
  return {step,lane:'cpu',semanticContractSha256:digest('integration-contract-v1'),inputArtifactHashes:hashes,sourceScope:{publisherId:'synthetic-publisher',sourceId:'synthetic-'+name,municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'2026-10-11'},selector:{scenario:name,nonce:randomUUID()},policyProofSha256:null};
}
function receiptFor(job:ClaimedJob):StepReceipt {
  return {version:STEP_RECEIPT_VERSION,canonicalizationVersion:CANONICALIZATION_VERSION,id:randomUUID(),runId:job.runId,jobKey:job.jobKey,step:job.spec.step,lane:job.spec.lane,sourceId:job.spec.sourceScope.sourceId,municipalityId:job.spec.sourceScope.municipalityId,attempt:job.attempt,leaseToken:job.fencingToken,category:job.category,dependencyReceiptIds:job.dependencyReceiptIds,enqueuedAt:job.enqueuedAt,startedAt:job.startedAt,finishedAt:new Date().toISOString(),queueWaitMs:Math.max(0,Date.parse(job.startedAt)-Date.parse(job.enqueuedAt)),elapsedMs:0,cpuUserMicros:null,cpuSystemMicros:null,outcome:'succeeded',reasonCode:'completed',inputHashes:job.spec.inputArtifactHashes,outputHashes:[],policyProofSha256:job.spec.policyProofSha256,originProofSha256:null,versions:{test:'postgres-integration-v1'},cache:{disposition:'not_applicable',originalGenerationReceiptId:null},provider:null,counts:{...unknownReceiptCounts}};
}

test('durable R1 queue against isolated local Postgres', {skip:!connectionString,timeout:120000},async t=>{
  let url:URL;try{url=new URL(connectionString!);}catch{throw Error('DISTRICT_TEST_DATABASE_URL must be a local Postgres URL');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(url.hostname))throw Error('Integration test refuses a non-local Postgres endpoint');
  const host=url.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Integration test refuses non-local host override');
  const admin=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,statement_timeout:10000});
  const closeAdmin=poolShutdownBarrier(admin);
  const database='district_r1_test_'+randomUUID().replaceAll('-','');
  const resources:{created:boolean;closePool?:()=>Promise<void>;directory?:string}={created:false};
  t.after(async()=>{
    try{await resources.closePool?.();if(resources.created)await admin.query('DROP DATABASE "'+database+'"');}
    finally{await closeAdmin();if(resources.directory)await rm(resources.directory,{recursive:true,force:true});}
  });
  await admin.query('CREATE DATABASE "'+database+'"');
  resources.created=true;
  const isolated=new URL(url);isolated.pathname='/'+database;
  const pool=new Pool({connectionString:isolated.href,max:8,connectionTimeoutMillis:5000,statement_timeout:10000});
  resources.closePool=poolShutdownBarrier(pool);
  const directory=await mkdtemp(join(tmpdir(),'district-pg-cas-'));
  resources.directory=directory;
  const store=new DistrictJobStore(pool),cas=new DistrictCas(join(directory,'cas'));
  const handlers:Record<string,JobHandler>={verify_artifacts:artifactVerificationHandler};
  const authorize=async (jobKeys:string[],overrides:Partial<AuthorizationInput>={})=>store.authorize({approvalSha256:digest(randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys,ags:['12064472'],maxJobs:jobKeys.length,maxElapsedMs:60000,category:'development',...overrides});
  const run=async (authorizationId:string,maxJobs:number,registry:Readonly<Record<string,JobHandler>>=handlers,maxElapsedMs=60000)=>runDistrictJobs({store,cas,handlers:registry,authorizationId,ownerPresent:true,maxJobs,maxElapsedMs});

  await t.test('migration applies atomically, pins exact bytes and contains every plan entity',async()=>{
    await migrateDistrictJobs(pool);await migrateDistrictJobs(pool);
    const expected=['source_snapshots','representations','policy_decisions','artifacts','jobs','job_dependencies','step_receipts','host_lanes','provider_budgets','case_identities','entity_identities','identity_assertions','release_candidates','release_files','active_release','preauthorizations','owner_notifications','r1_metadata_snapshots'];
    expected.push('assessment_bridge_leases','assessment_bridge_submission_intents','assessment_bridge_purge_acknowledgements','assessment_bridge_submissions','assessment_bridge_events');
    expected.push('r1_codex_documents','r1_codex_selections','r1_codex_call_intents','r1_codex_call_authorizations','r1_codex_usage_holds','r1_codex_resumptions');
    expected.push('resource_slots');
    const tables=await pool.query<{table_name:string}>(`SELECT table_name FROM information_schema.tables WHERE table_schema='district_pipeline'`);
    for(const name of expected)assert.ok(tables.rows.some(row=>row.table_name===name),name);
    const original=await pool.query<{sha256:string}>('SELECT sha256 FROM district_pipeline.schema_migrations WHERE version=1');
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=1',[digest('wrong')]);
    await assert.rejects(migrateDistrictJobs(pool),/byte hash/);
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=1',[original.rows[0].sha256]);
    const migrations=await pool.query<{version:number;sha256:string}>('SELECT version,sha256 FROM district_pipeline.schema_migrations ORDER BY version');
    assert.deepEqual(migrations.rows.map(row=>row.version),[1,2,3,4,5,6]);
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=2',[digest('wrong-002')]);
    await assert.rejects(migrateDistrictJobs(pool),/byte hash/);
    assert.equal((await pool.query<{sha256:string}>('SELECT sha256 FROM district_pipeline.schema_migrations WHERE version=1')).rows[0].sha256,original.rows[0].sha256);
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=2',[migrations.rows[1].sha256]);
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=3',[digest('wrong-003')]);
    await assert.rejects(migrateDistrictJobs(pool),/byte hash/);
    const earlier=await pool.query<{version:number;sha256:string}>('SELECT version,sha256 FROM district_pipeline.schema_migrations WHERE version<=2 ORDER BY version');
    assert.deepEqual(earlier.rows,migrations.rows.slice(0,2));
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=3',[migrations.rows[2].sha256]);
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=4',[digest('wrong-004')]);
    await assert.rejects(migrateDistrictJobs(pool),/byte hash/);
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=4',[migrations.rows[3].sha256]);
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=5',[digest('wrong-005')]);
    await assert.rejects(migrateDistrictJobs(pool),/byte hash/);
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=5',[migrations.rows[4].sha256]);
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=6',[digest('wrong-006')]);
    await assert.rejects(migrateDistrictJobs(pool),/byte hash/);
    await pool.query('UPDATE district_pipeline.schema_migrations SET sha256=$1 WHERE version=6',[migrations.rows[5].sha256]);
  });

  await t.test('immutable artifact audits omit private quotes/errors while full payload remains purgeable CAS',async()=>{
    const quote='SYNTHETIC_PRIVATE_QUOTE_NOT_PG',error='SYNTHETIC_PRIVATE_ERROR_FRAGMENT_NOT_PG';
    const fullPayload={records:[{rawValue:quote}],errors:[error]},fullBytes=Buffer.from(canonicalJson(fullPayload)),contentSha256=digest(fullBytes);
    // Projection/storage fixture; the operator owns the actual closed audit validator.
    const payload={artifact:{sha256:contentSha256,byteLength:fullBytes.length,mimeType:'application/json',kind:'derived'},sourceBindings:[{sourceSha256:digest('synthetic-source'),policyReceiptSha256:digest('synthetic-policy'),httpObservationId:'synthetic-http-source-id',httpObservationSha256:digest('synthetic-http-source-bytes')}],counts:{records:1,errors:1}};
    const sha256=await insertR1MetadataSnapshot(pool,{kind:'records',payload});
    assert.equal(sha256,digest(canonicalJson(payload)));assert.notEqual(sha256,contentSha256);
    assert.equal(await insertR1MetadataSnapshot(pool,{kind:'records',payload}),sha256);
    const content=await cas.put(fullBytes,{kind:'derived',mimeType:'application/json'});
    assert.equal(content.sha256,contentSha256);
    const privateBytes=(await cas.read(contentSha256)).toString('utf8');assert.ok(privateBytes.includes(quote));assert.ok(privateBytes.includes(error));
    const duplicate=await cas.put(Buffer.from(canonicalJson(payload)),{kind:'derived',mimeType:'application/json'});
    assert.equal(duplicate.sha256,sha256);
    const persisted=await pool.query<{kind:string;payload_json:unknown}>('SELECT kind,payload_json FROM district_pipeline.r1_metadata_snapshots WHERE sha256=$1',[sha256]);
    assert.equal(persisted.rows[0].kind,'records');assert.deepEqual(persisted.rows[0].payload_json,payload);
    const encoded=canonicalJson(persisted.rows[0].payload_json);assert.equal(digest(encoded),sha256);
    assert.equal(encoded.includes(quote),false);assert.equal(encoded.includes(error),false);
    await rm(join(cas.root,content.storageKey));await rm(join(cas.root,duplicate.storageKey));
    await assert.rejects(cas.read(contentSha256));await assert.rejects(cas.read(sha256));
    assert.deepEqual((await pool.query<{payload_json:unknown}>('SELECT payload_json FROM district_pipeline.r1_metadata_snapshots WHERE sha256=$1',[sha256])).rows[0].payload_json,payload);
    await assert.rejects(pool.query(`UPDATE district_pipeline.r1_metadata_snapshots SET payload_json='{}' WHERE sha256=$1`,[sha256]),/Immutable/);
    await assert.rejects(pool.query('DELETE FROM district_pipeline.r1_metadata_snapshots WHERE sha256=$1',[sha256]),/Immutable/);
    await assert.rejects(insertR1MetadataSnapshot(pool,{kind:'coverage',payload}),/identity conflict/);
    await assert.rejects(insertR1MetadataSnapshot(pool,{kind:'records',payload:'not-safe-metadata'}),/object or array/);
    await assert.rejects(pool.query(`INSERT INTO district_pipeline.r1_metadata_snapshots(sha256,kind,payload_json) VALUES($1,'records','"scalar"')`,[digest('scalar')]),/check constraint/);
    const array=[{registrySha256:digest('synthetic-registry')}],arraySha=await insertR1MetadataSnapshot(pool,{kind:'registry',payload:array});
    assert.equal(arraySha,digest(canonicalJson(array)));
  });

  await t.test('dedicated HTTP observation metadata preserves its original content-free UTF8 audit bytes',async()=>{
    // Storage-only fixture; the operator validates the canonical SourceObservation schema.
    const rawUtf8='{"id":"synthetic-http-observation","status":200,"source":"Mölln"}\n';
    const payload={observation:JSON.parse(rawUtf8),rawUtf8,observationId:'synthetic-http-observation',observationSha256:digest(Buffer.from(rawUtf8,'utf8'))};
    const sha256=await insertR1MetadataSnapshot(pool,{kind:'http_observation',payload});
    const duplicate=await cas.put(Buffer.from(canonicalJson(payload)),{kind:'derived',mimeType:'application/json'});
    assert.equal(duplicate.sha256,sha256);await rm(join(cas.root,duplicate.storageKey));
    const stored=await pool.query<{kind:string;payload_json:typeof payload}>('SELECT kind,payload_json FROM district_pipeline.r1_metadata_snapshots WHERE sha256=$1',[sha256]);
    assert.equal(stored.rows[0].kind,'http_observation');assert.deepEqual(stored.rows[0].payload_json,payload);
    assert.deepEqual(Buffer.from(stored.rows[0].payload_json.rawUtf8,'utf8'),Buffer.from(rawUtf8,'utf8'));
    assert.equal(digest(Buffer.from(stored.rows[0].payload_json.rawUtf8,'utf8')),stored.rows[0].payload_json.observationSha256);
    assert.equal(JSON.parse(stored.rows[0].payload_json.rawUtf8).id,stored.rows[0].payload_json.observationId);
    await assert.rejects(cas.read(sha256));
    await assert.rejects(pool.query(`INSERT INTO district_pipeline.r1_metadata_snapshots(sha256,kind,payload_json) VALUES($1,'http_trace','{}')`,[digest('unsupported-http-kind')]),/check constraint/);
  });

  await t.test('content-free replay artifact and proof audits survive removal of their managed CAS bytes',async()=>{
    const artifact=await cas.put(Buffer.from('{"syntheticReplay":true}'),{kind:'derived',mimeType:'application/json'});
    const inputBindingSha256=digest('synthetic-authenticated-replay-inputs');
    const artifactPayload={sha256:artifact.sha256,byteLength:artifact.byteLength,mimeType:artifact.mimeType,kind:artifact.kind,storageKey:artifact.storageKey,inputBindingSha256};
    const artifactAuditSha256=await insertR1MetadataSnapshot(pool,{kind:'replay_artifact',payload:artifactPayload});
    const proofPayload={clocks:{sourceEvaluationAt:'2026-10-11T00:00:00.000Z',graphAsOf:'2026-10-01T00:00:00.000Z'},comparison:{expectedManifestSha256:digest('synthetic-release'),actualManifestSha256:digest('synthetic-release')},artifactPins:[{sha256:artifact.sha256,auditSha256:artifactAuditSha256}],inputBindingSha256};
    const proofAuditSha256=await insertR1MetadataSnapshot(pool,{kind:'replay_proof',payload:proofPayload});
    const artifactDuplicate=await cas.put(Buffer.from(canonicalJson(artifactPayload)),{kind:'derived',mimeType:'application/json'});
    const proofDuplicate=await cas.put(Buffer.from(canonicalJson(proofPayload)),{kind:'derived',mimeType:'application/json'});
    assert.equal(artifactDuplicate.sha256,artifactAuditSha256);assert.equal(proofDuplicate.sha256,proofAuditSha256);
    for(const object of [artifact,artifactDuplicate,proofDuplicate])await rm(join(cas.root,object.storageKey));
    const stored=await pool.query<{sha256:string;kind:string;payload_json:unknown}>(`SELECT sha256,kind,payload_json FROM district_pipeline.r1_metadata_snapshots WHERE sha256=ANY($1::text[])`,[[artifactAuditSha256,proofAuditSha256]]);
    assert.equal(stored.rowCount,2);
    for(const row of stored.rows)assert.equal(digest(canonicalJson(row.payload_json)),row.sha256);
    assert.deepEqual(stored.rows.find(row=>row.kind==='replay_artifact')?.payload_json,artifactPayload);
    assert.deepEqual(stored.rows.find(row=>row.kind==='replay_proof')?.payload_json,proofPayload);
    assert.equal(Object.hasOwn(artifactPayload,'body'),false);assert.equal(Object.hasOwn(proofPayload,'body'),false);
    await assert.rejects(cas.read(artifact.sha256));
    await assert.rejects(cas.read(artifactAuditSha256));await assert.rejects(cas.read(proofAuditSha256));
  });

  await t.test('committed predecessor receipts release dependencies; CAS outputs, identities and receipt hashes stay durable',async()=>{
    const input=await cas.put(Buffer.from('Synthetic source rows'),{kind:'derived',mimeType:'text/plain'});await store.addArtifact(input);
    const parent=jobSpec('dag-parent','parse_fixture',[input.sha256]),child=jobSpec('dag-child');
    const parentKey=await store.enqueue(parent),childKey=await store.enqueue(child,{dependencies:[{jobKey:parentKey}],priority:100});
    assert.equal(await store.enqueue(parent),parentKey);
    const order:string[]=[];
    const authorizationId=await authorize([parentKey,childKey]);
    const result=await run(authorizationId,2,{...handlers,parse_fixture:async context=>{
      order.push('parent');assert.deepEqual(await context.cas.read(input.sha256),Buffer.from('Synthetic source rows'));
      const output=await context.cas.put(Buffer.from('{"fixtureRows":1}'),{kind:'parser_output',mimeType:'application/json'});
      return {outcome:'succeeded',reasonCode:'completed',outputs:[output],counts:{rows:1},versions:{parser:'fixture-v1'}};
    },verify_artifacts:async context=>{order.push('child');assert.equal(context.job.dependencyReceiptIds.length,1);return artifactVerificationHandler(context);}});
    assert.equal(result.state,'completed');assert.deepEqual(order,['parent','child']);assert.equal(result.receiptIds.length,2);
    const receipts=await pool.query<{receipt:StepReceipt;receipt_sha256:string}>(`SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE run_id=$1 ORDER BY committed_at`,[result.runId]);
    assert.equal(receipts.rows[0].receipt.counts.rows,1);assert.equal(receipts.rows[1].receipt.dependencyReceiptIds[0],receipts.rows[0].receipt.id);
    for(const row of receipts.rows)assert.equal(row.receipt_sha256,digest(canonicalJson(row.receipt)));
    const bindings=await pool.query('SELECT * FROM district_pipeline.step_receipt_dependencies WHERE receipt_id=$1',[receipts.rows[1].receipt.id]);assert.equal(bindings.rowCount,1);
    const outputs=await pool.query<{artifact_sha256:string}>('SELECT artifact_sha256 FROM district_pipeline.job_output_artifacts WHERE receipt_id=$1',[receipts.rows[0].receipt.id]);assert.equal(outputs.rowCount,1);await cas.verify(outputs.rows[0].artifact_sha256);
    await assert.rejects(pool.query('DELETE FROM district_pipeline.job_output_artifacts WHERE receipt_id=$1',[receipts.rows[0].receipt.id]),/Immutable/);
    await assert.rejects(pool.query('INSERT INTO district_pipeline.job_output_artifacts(receipt_id,artifact_sha256) VALUES($1,$2)',[receipts.rows[0].receipt.id,input.sha256]),/not in immutable receipt/);
    await assert.rejects(pool.query(`UPDATE district_pipeline.step_receipts SET outcome='failed_execution' WHERE id=$1`,[receipts.rows[0].receipt.id]),/Immutable/);
    await assert.rejects(pool.query('UPDATE district_pipeline.preauthorizations SET max_jobs=max_jobs+1 WHERE id=$1',[authorizationId]),/immutable/);
    await assert.rejects(store.enqueue(child),/incompatible/);
    const wrongPin=await store.enqueue(jobSpec('wrong-receipt'),{dependencies:[{jobKey:parentKey,expectedReceiptSha256:digest('not-the-receipt')}]});
    const pinned=await run(await authorize([wrongPin]),1);assert.equal(pinned.jobsStarted,0);assert.equal(pinned.state,'held');assert.equal(pinned.reasonCode,'dependency_uncommitted');
  });

  await t.test('receipt commit failure rolls back job state and cannot release dependencies',async()=>{
    const key=await store.enqueue(jobSpec('rollback'));
    const authorizationId=await authorize([key]);const bounds=await store.beginRun(authorizationId,1,60000),claim=await store.claim(bounds,30000);assert.equal(claim.kind,'job');if(claim.kind!=='job')return;
    const receipt={...receiptFor(claim.job),outputHashes:[digest('missing-output-artifact')]};
    await assert.rejects(store.finish(bounds,claim.job,receipt),/foreign key/);
    const row=await pool.query<{state:string}>('SELECT state FROM district_pipeline.jobs WHERE job_key=$1',[key]);assert.equal(row.rows[0].state,'leased');
    const receipts=await pool.query('SELECT id FROM district_pipeline.step_receipts WHERE job_id=$1',[claim.job.id]);assert.equal(receipts.rowCount,0);
    await store.hold(claim.job,'execution_exception',receiptFor(claim.job));await store.endRun(bounds.runId,'held','execution_exception');
  });

  await t.test('late holds, crash recovery and reservations lock authority before dependent job rows', {timeout:30000},async()=>{
    for(const operation of ['hold','recovery','reservation'] as const){
      const key=await store.enqueue(jobSpec('authority-order-'+operation)),authorizationId=await authorize([key]);
      const bounds=await store.beginRun(authorizationId,1,60000),claim=await store.claim(bounds,30000);
      assert.equal(claim.kind,'job');if(claim.kind!=='job')return;
      const workPool=new Pool({connectionString:isolated.href,max:1,connectionTimeoutMillis:5000,statement_timeout:15000}),workStore=new DistrictJobStore(workPool);
      const closeWorkPool=poolShutdownBarrier(workPool);
      const observer=await workPool.connect(),pid=(await observer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;observer.release();
      const authority=await pool.connect(),serviceLock=operation==='recovery'?await pool.connect():null;
      let guardOpen=false,settled=false;
      let completion:Promise<{ok:boolean;value?:unknown;error?:unknown}>|undefined;
      try{
        await authority.query('BEGIN');guardOpen=true;
        await authority.query('SELECT id FROM district_pipeline.executor_runs WHERE id=$1 FOR UPDATE',[bounds.runId]);
        await authority.query('SELECT id FROM district_pipeline.preauthorizations WHERE id=$1 FOR UPDATE',[authorizationId]);
        let action:Promise<unknown>;
        if(operation==='recovery'){
          await serviceLock!.query('SELECT pg_advisory_lock(18441,2)');
          action=workStore.holdAbandonedRuns(serviceLock!);
        }else if(operation==='reservation'){
          const budgetId=randomUUID();
          await pool.query(`INSERT INTO district_pipeline.provider_budgets(id,provider,currency,owner_approval_sha256,cap_micro_usd,expires_at) VALUES($1,'openai','USD',$2,1000,clock_timestamp()+interval '1 hour')`,[budgetId,digest('synthetic-lock-order-budget')]);
          action=workStore.reserveProviderBudget(budgetId,claim.job.id,claim.job.fencingToken,1,digest('synthetic-lock-order-intent'));
        }else action=workStore.hold(claim.job,'owner_stopped',receiptFor(claim.job));
        completion=action.then(value=>{settled=true;return {ok:true,value};},error=>{settled=true;return {ok:false,error};});
        // Real Postgres row-lock observation, not a guessed sleep or mocked clock.
        const deadline=Date.now()+10000;
        for(;;){
          const activity=await pool.query<{wait_event_type:string|null}>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]);
          if(activity.rows[0]?.wait_event_type==='Lock')break;
          assert.equal(settled,false,'Operation bypassed the locked authority row');
          assert.ok(Date.now()<deadline,'Operation did not reach the authority lock');
        }
        // A job-first implementation would hold this row while awaiting the run,
        // causing NOWAIT to fail and exposing the broker/runner lock inversion.
        await authority.query('SELECT id FROM district_pipeline.jobs WHERE id=$1 FOR UPDATE NOWAIT',[claim.job.id]);
        await authority.query('COMMIT');guardOpen=false;
        const outcome=await completion;assert.equal(outcome.ok,true);
        if(operation==='reservation'){
          assert.equal(typeof outcome.value,'string');await store.settleProviderReservation(outcome.value as string,0);
          await store.hold(claim.job,'owner_stopped',receiptFor(claim.job));
        }
      }finally{
        if(guardOpen)await authority.query('ROLLBACK');authority.release();
        await completion;
        if(serviceLock){await serviceLock.query('SELECT pg_advisory_unlock(18441,2)');serviceLock.release();}
        await closeWorkPool();await store.endRun(bounds.runId,'held','owner_stopped');
      }
    }
  });

  await t.test('expired/crashed leases become explicit holds and stale fencing tokens cannot commit accepted effects',async()=>{
    const key=await store.enqueue(jobSpec('crash-fence'));
    const authorizationId=await authorize([key],{maxJobs:2});const oldRun=await store.beginRun(authorizationId,2,60000),oldClaim=await store.claim(oldRun,30000);assert.equal(oldClaim.kind,'job');if(oldClaim.kind!=='job')return;
    await pool.query(`UPDATE district_pipeline.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[oldClaim.job.id]);
    await assert.rejects(store.finish(oldRun,oldClaim.job,receiptFor(oldClaim.job)),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='lease_lost');
    const recovery=await run(authorizationId,1);assert.equal(recovery.jobsStarted,0);
    const held=await pool.query<{state:string;reason_code:string;fencing_token:string}>('SELECT state,reason_code,fencing_token FROM district_pipeline.jobs WHERE job_key=$1',[key]);assert.equal(held.rows[0].state,'held_execution');assert.equal(held.rows[0].reason_code,'lease_expired');assert.ok(BigInt(held.rows[0].fencing_token)>BigInt(oldClaim.job.fencingToken));
    const crashReceipt=await pool.query<{receipt:StepReceipt}>('SELECT receipt FROM district_pipeline.step_receipts WHERE job_id=$1',[oldClaim.job.id]);assert.equal(crashReceipt.rows[0].receipt.elapsedMs,null);assert.equal(crashReceipt.rows[0].receipt.cpuUserMicros,null);
    await store.resume(key);const resumed=await run(authorizationId,1);assert.equal(resumed.jobsStarted,1);
    await assert.rejects(store.finish(oldRun,oldClaim.job,receiptFor(oldClaim.job)),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='lease_lost');
    const accepted=await pool.query(`SELECT id FROM district_pipeline.step_receipts WHERE job_id=$1 AND outcome='succeeded'`,[oldClaim.job.id]);assert.equal(accepted.rowCount,1);
    assert.equal(await store.enqueue(oldClaim.job.spec),key);
  });

  await t.test('preauthorization expiration aborts active work, records its hold and never runs the dependent job',async()=>{
    const first=await store.enqueue(jobSpec('expires','await_abort')),second=await store.enqueue(jobSpec('expiry-dependent'),{dependencies:[{jobKey:first}]});
    const authorizationId=await authorize([first,second],{expiresAt:new Date(Date.now()+1000).toISOString()});let calls=0;
    const result=await run(authorizationId,2,{...handlers,await_abort:async ({signal})=>{calls++;await new Promise<void>((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});return {outcome:'succeeded',reasonCode:'completed'};}});
    assert.equal(result.state,'held');assert.equal(result.reasonCode,'authorization_expired');assert.equal(calls,1);
    const receipts=await pool.query<{receipt:StepReceipt}>('SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=$1',[result.runId]);assert.equal(receipts.rowCount,1);assert.equal(receipts.rows[0].receipt.outcome,'held_execution');assert.equal(receipts.rows[0].receipt.reasonCode,'authorization_expired');
    const child=await pool.query<{attempt:number}>('SELECT attempt FROM district_pipeline.jobs WHERE job_key=$1',[second]);assert.equal(child.rows[0].attempt,0);
  });

  await t.test('maximum jobs and elapsed time stay bounded across explicit resumptions',async()=>{
    const one=await store.enqueue(jobSpec('job-bound-one')),two=await store.enqueue(jobSpec('job-bound-two'));
    const authorizationId=await authorize([one,two],{maxJobs:1});const first=await run(authorizationId,1);assert.equal(first.jobsStarted,1);assert.equal(first.reasonCode,'max_jobs_reached');
    await assert.rejects(run(authorizationId,1),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='authorization_jobs_exhausted');
    const sleeping=await store.enqueue(jobSpec('time-bound','await_abort'));
    const bounded=await authorize([sleeping],{maxElapsedMs:100});
    const result=await run(bounded,1,{await_abort:async ({signal})=>{await new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return {outcome:'succeeded',reasonCode:'completed'};}},100);
    assert.equal(result.state,'held');assert.equal(result.reasonCode,'max_time_reached');
    // Node fake clocks cannot advance Postgres: wait to the persisted authorization deadline.
    await pool.query(`SELECT pg_sleep(GREATEST(0,extract(epoch FROM(first_started_at+max_elapsed_ms*interval '1 millisecond'-clock_timestamp())))) FROM district_pipeline.preauthorizations WHERE id=$1`,[bounded]);
    await assert.rejects(store.beginRun(bounded,1,100),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='authorization_time_exhausted');
  });

  await t.test('exceptions, unknown handlers, cancellation and owner absence fail closed without exception contents',async()=>{
    const secret='synthetic-secret-must-not-enter-receipts';
    const failure=await store.enqueue(jobSpec('exception','throws'));
    const failed=await run(await authorize([failure]),1,{throws:async()=>{throw Error(secret);}});assert.equal(failed.reasonCode,'execution_exception');
    const receipt=await pool.query<{receipt:StepReceipt}>('SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=$1',[failed.runId]);assert.doesNotMatch(JSON.stringify(receipt.rows[0].receipt),new RegExp(secret));
    const missing=await store.enqueue(jobSpec('missing','not_a_registered_handler'));
    assert.equal((await run(await authorize([missing]),1)).reasonCode,'handler_missing');
    const cancelled=await store.enqueue(jobSpec('cancelled'));await store.cancel(cancelled);const cancelledRun=await run(await authorize([cancelled]),1);assert.equal(cancelledRun.jobsStarted,0);
    await assert.rejects(store.resume(cancelled),/cannot be resumed/);
    const unattended=await store.enqueue(jobSpec('absent-owner'));const authorizationId=await authorize([unattended]);
    await assert.rejects(runDistrictJobs({store,cas,handlers,authorizationId,maxJobs:1,maxElapsedMs:60000}),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='owner_absent');
    await assert.rejects(runDistrictJobs({store,cas,handlers,authorizationId,mode:'bounded_unattended',maxJobs:1,maxElapsedMs:60000}),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='notification_unavailable');
  });

  await t.test('independent executors progress concurrently without holding live siblings',async()=>{
    const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const key=await store.enqueue(jobSpec('concurrent','wait_for_release')),other=await store.enqueue(jobSpec('concurrent-other'));
    const first=run(await authorize([key]),1,{wait_for_release:async()=>{started.resolve();await release.promise;return {outcome:'succeeded',reasonCode:'completed'};}});
    await started.promise;
    try{const second=await run(await authorize([other]),1);assert.equal(second.state,'completed');assert.equal(second.jobsStarted,1);}finally{release.resolve();}
    assert.equal((await first).state,'completed');
  });
  await t.test('two separate executor processes complete disjoint jobs concurrently',async()=>{
    const keys=await Promise.all([1,2].map(n=>store.enqueue(jobSpec('process-'+n,'process_fixture'))));
    const auths=await Promise.all(keys.map(key=>authorize([key])));
    const launch=(id:string,wait:boolean)=>{
      const entered=Promise.withResolvers<void>(),completed=Promise.withResolvers<void>();
      const child=fork(new URL('./helpers/parallel-executor.ts',import.meta.url),[isolated.href,id,cas.root,wait?'wait':'go'],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','inherit','ipc']});
      child.on('message',(message:{entered?:boolean;result?:{state:string}})=>{
        if(message.entered)entered.resolve();
        if(message.result)assert.equal(message.result.state,'completed');
      });
      child.on('error',error=>{entered.reject(error);completed.reject(error);});
      child.on('exit',code=>{if(code===0)completed.resolve();else{const error=Error('Fixture executor exit '+code);entered.reject(error);completed.reject(error);}});
      return {child,entered:entered.promise,completed:completed.promise};
    };
    const first=launch(auths[0],true);await first.entered;
    try{const second=launch(auths[1],false);await second.entered;await second.completed;}finally{first.child.send({release:true});}
    await first.completed;
  });

  await t.test('one authorization cannot register two simultaneous running runs',async()=>{
    const key=await store.enqueue(jobSpec('same-authorization')),authorizationId=await authorize([key],{maxJobs:2});
    const registrations=await Promise.allSettled([store.beginRun(authorizationId,1,60000),store.beginRun(authorizationId,1,60000)]);
    assert.equal(registrations.filter(result=>result.status==='fulfilled').length,1);
    for(const result of registrations){
      if(result.status==='rejected')assert.equal((result.reason as DistrictExecutionHold).reasonCode,'executor_busy');
      else await store.endRun(result.value.runId,'completed','no_ready_jobs');
    }
    const next=await store.beginRun(authorizationId,1,60000);await store.endRun(next.runId,'completed','no_ready_jobs');
  });

  await t.test('concurrent per-original reservations never exceed 48 durable intents',async()=>{
    const keys=await Promise.all([1,2].map(n=>store.enqueue(jobSpec('codex-cap-'+n,'residual_extract'))));
    const claims=await Promise.all(keys.map(async key=>{
      const bounds=await store.beginRun(await authorize([key]),1,60000),claim=await store.claim(bounds,30000);
      assert.equal(claim.kind,'job');if(claim.kind!=='job')throw Error('Expected claim');return {bounds,job:claim.job};
    }));
    const original=digest(randomUUID());
    const reservations=await Promise.allSettled(Array.from({length:60},(_,n)=>reserveR1CodexCall(pool,claims[n%2].job,original,digest('request-'+n))));
    assert.equal(reservations.filter(r=>r.status==='fulfilled').length,48);
    assert.equal((await pool.query<{count:string}>('SELECT count(*) FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=$1',[original])).rows[0].count,'48');
    for(const result of reservations)if(result.status==='rejected')assert.equal((result.reason as DistrictExecutionHold).reasonCode,'source_limit_exceeded');
    for(const {bounds,job} of claims){await store.hold(job,'owner_stopped',receiptFor(job));await store.endRun(bounds.runId,'held','owner_stopped');}
  });

  await t.test('resource slots bound both resources, fence renewals and recover expired crashed holders',async()=>{
    for(const resource of ['codex-subscription','omp-b'] as const){
      const keys=await Promise.all([1,2,3].map(n=>store.enqueue(jobSpec(resource+'-'+n))));
      const claims=await Promise.all(keys.map(async key=>{
        const bounds=await store.beginRun(await authorize([key]),1,60000),claim=await store.claim(bounds,30000);
        if(claim.kind!=='job')throw Error('Expected claim');return {bounds,job:claim.job};
      }));
      const admitted=await Promise.all(claims.map(({bounds,job})=>store.acquireResourceSlot(bounds,job,resource,2)));
      assert.equal(admitted.filter(Boolean).length,2);
      const held=admitted.findIndex(Boolean),waiting=admitted.findIndex(value=>!value);
      await pool.query(`UPDATE district_pipeline.resource_slots SET expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1`,[claims[held].job.id]);
      await assert.rejects(store.renew(claims[held].bounds,claims[held].job,30000),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='lease_lost');
      assert.equal(await store.acquireResourceSlot(claims[waiting].bounds,claims[waiting].job,resource,2),true);
      assert.equal((await pool.query<{count:string}>('SELECT count(*) FROM district_pipeline.resource_slots WHERE resource=$1',[resource])).rows[0].count,'2');
      for(const {bounds,job} of claims){await store.releaseResourceSlot(job,resource);await store.hold(job,'owner_stopped',receiptFor(job));await store.endRun(bounds.runId,'held','owner_stopped');}
    }
  });

  await t.test('slot renewal shares admission lock and lost/reclaimed slots cannot silently renew',async()=>{
    for(const resource of ['codex-subscription','omp-b'] as const){
      const claims=await Promise.all([1,2].map(async n=>{
        const key=await store.enqueue(jobSpec('slot-renewal-race-'+resource+n)),bounds=await store.beginRun(await authorize([key]),1,60000),claim=await store.claim(bounds,30000);
        if(claim.kind!=='job')throw Error('Expected claim');return {bounds,job:claim.job};
      }));
      const [holder,waiting]=claims;
      assert.equal(await store.acquireResourceSlot(holder.bounds,holder.job,resource,1),true);
      // Waiting jobs have no acquired obligation and may legitimately renew.
      await store.renew(waiting.bounds,waiting.job,30000);
      const originalExpiry=(await pool.query<{lease_expires_at:Date}>('SELECT lease_expires_at FROM district_pipeline.jobs WHERE id=$1',[holder.job.id])).rows[0].lease_expires_at;
      const workPool=new Pool({connectionString:isolated.href,max:1,statement_timeout:15000}),workStore=new DistrictJobStore(workPool),closeWork=poolShutdownBarrier(workPool);
      const probe=await workPool.connect(),pid=(await probe.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;probe.release();
      const guard=await pool.connect();let locked=false,settled=false;
      let renewal:Promise<{ok:boolean;error?:unknown}>|undefined,admission:Promise<boolean>|undefined;
      try {
        await guard.query('SELECT pg_advisory_lock(18443,hashtext($1))',[resource]);locked=true;
        renewal=workStore.renew(holder.bounds,holder.job,30000).then(()=>{settled=true;return {ok:true};},error=>{settled=true;return {ok:false,error};});
        const deadline=Date.now()+10000;
        for(;;){
          const activity=await pool.query<{wait_event_type:string|null}>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]);
          if(activity.rows[0]?.wait_event_type==='Lock')break;
          assert.equal(settled,false,'Renewal bypassed the admission/reclamation lock');
          assert.ok(Date.now()<deadline,'Renewal did not wait on the resource lock');await pool.query('SELECT pg_sleep(0.01)');
        }
        await pool.query(`UPDATE district_pipeline.resource_slots SET expires_at=clock_timestamp()-interval '1 second' WHERE resource=$1 AND job_id=$2`,[resource,holder.job.id]);
        admission=store.acquireResourceSlot(waiting.bounds,waiting.job,resource,1);
        await guard.query('SELECT pg_advisory_unlock(18443,hashtext($1))',[resource]);locked=false;
        const renewed=await renewal;assert.equal(renewed.ok,false);assert.equal((renewed.error as DistrictExecutionHold).reasonCode,'lease_lost');
        assert.equal(await admission,true);
        assert.equal((await pool.query<{lease_expires_at:Date}>('SELECT lease_expires_at FROM district_pipeline.jobs WHERE id=$1',[holder.job.id])).rows[0].lease_expires_at.toISOString(),originalExpiry.toISOString(),'Failed slot renewal must roll back the job renewal');
        // The slot row has now disappeared: durable acquisition tracking still
        // rejects the old holder instead of treating it as a waiting job.
        await assert.rejects(store.renew(holder.bounds,holder.job,30000),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='lease_lost');
        assert.equal((await pool.query<{count:string}>('SELECT count(*) FROM district_pipeline.resource_slots WHERE resource=$1',[resource])).rows[0].count,'1');
      } finally {
        if(locked)await guard.query('SELECT pg_advisory_unlock(18443,hashtext($1))',[resource]);guard.release();
        await renewal;await admission;await closeWork();
        for(const {bounds,job} of claims){await store.releaseResourceSlot(job,resource);await store.hold(job,'owner_stopped',receiptFor(job));await store.endRun(bounds.runId,'held','owner_stopped');}
      }
    }
  });

  await t.test('handler wrapper serializes provider lifetimes while waiting jobs renew',async()=>{
    for(const step of ['residual_extract','assessment_b']){
      let active=0,peak=0;const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
      const keys=await Promise.all([1,2].map(n=>store.enqueue(jobSpec('wrapper-'+step+n,step))));
      const auths=await Promise.all(keys.map(key=>authorize([key])));
      const handler:JobHandler=async()=>{active++;peak=Math.max(peak,active);entered.resolve();await release.promise;active--;return {outcome:'succeeded',reasonCode:'completed'};};
      const first=runDistrictJobs({store,cas,handlers:{[step]:handler},authorizationId:auths[0],ownerPresent:true,maxJobs:1,maxElapsedMs:60000,leaseMs:300});
      await entered.promise;
      const second=runDistrictJobs({store,cas,handlers:{[step]:handler},authorizationId:auths[1],ownerPresent:true,maxJobs:1,maxElapsedMs:60000,leaseMs:300});
      try{
        for(;;){const waiting=await pool.query('SELECT 1 FROM district_pipeline.jobs WHERE job_key=$1 AND state=$2',[keys[1],'leased']);if(waiting.rowCount)break;await pool.query('SELECT pg_sleep(0.01)');}
        await pool.query('SELECT pg_sleep(0.4)');assert.equal(peak,1);
      }finally{release.resolve();}
      const results=await Promise.all([first,second]);assert.ok(results.every(result=>result.state==='completed'));assert.equal(peak,1);
    }
  });

  await t.test('shared host lanes enforce one in-flight request, start delays, paused access and explicit resumption',async()=>{
    const lane='portal-'+randomUUID();await pool.query(`INSERT INTO district_pipeline.host_lanes(lane_key,normalized_host,shared_service_group) VALUES($1,'example.org','synthetic-shared-service')`,[lane]);
    const first=await store.enqueue(jobSpec('host-town-a'),{hostLaneKey:lane}),second=await store.enqueue(jobSpec('host-town-b'),{hostLaneKey:lane});const authorizationId=await authorize([first,second]);
    const result=await run(authorizationId,2);assert.equal(result.jobsStarted,1);assert.equal(result.reasonCode,'host_delay');
    const leases=await pool.query('SELECT * FROM district_pipeline.host_lane_leases WHERE lane_key=$1',[lane]);assert.equal(leases.rowCount,0);
    const spacing=await pool.query<{spacing:string}>(`SELECT extract(epoch FROM(next_start_at-last_started_at))*1000 AS spacing FROM district_pipeline.host_lanes WHERE lane_key=$1`,[lane]);assert.ok(Number(spacing.rows[0].spacing)>=2000);
    await pool.query(`UPDATE district_pipeline.host_lanes SET next_start_at=clock_timestamp()-interval '1 second' WHERE lane_key=$1`,[lane]);
    const deferred=await pool.query<{job_key:string}>(`SELECT job_key FROM district_pipeline.jobs WHERE job_key=ANY($1) AND state='deferred'`,[[first,second]]);await store.resume(deferred.rows[0].job_key);
    assert.equal((await run(authorizationId,1)).jobsStarted,1);
    const blocked=await store.enqueue(jobSpec('host-paused'),{hostLaneKey:lane});await pool.query(`UPDATE district_pipeline.host_lanes SET paused_reason='host_access_blocked' WHERE lane_key=$1`,[lane]);
    const paused=await run(await authorize([blocked]),1);assert.equal(paused.jobsStarted,0);assert.equal(paused.reasonCode,'host_paused');
  });

  await t.test('current policy proof is required even for artifact cache reuse and representation admission binds bytes',async()=>{
    const bytes=Buffer.from('Synthetic admitted municipal bytes'),hash=digest(bytes),snapshot=randomUUID(),policy=randomUUID(),proof=digest(randomUUID());
    const fetchedAt=new Date(Date.now()-120000).toISOString();
    await pool.query(`INSERT INTO district_pipeline.source_snapshots(id,publisher_id,source_id,municipality_id,ags,resource_identity,request_method,request_selector_sha256,observation_window,retrieved_at,scope_sha256) VALUES($1,'test-publisher','test-source','strausberg','12064472','https://example.org/tenant?body=1','GET',$2,'2026-10-11',$4,$3)`,[snapshot,digest('request'),digest(snapshot),fetchedAt]);
    await pool.query(`INSERT INTO district_pipeline.policy_decisions(id,source_snapshot_id,proof_sha256,source_sha256,receipt_json,state,observed_robots,owner_robots_override,opt_out_version,policy_version,checked_at,expires_at,reason_code) VALUES($1,$2,$3,$4,$5,'allowed','disallowed',true,'v1','v1',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour','completed')`,[policy,snapshot,proof,hash,{fixture:'immutable-policy-storage',sourceSha256:hash}]);
    const original=await cas.put(bytes,{kind:'source_original',mimeType:'text/plain',admission:{state:'allowed',sourceSha256:hash,policyProofSha256:proof,checkedAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}});await store.addArtifact(original);
    await pool.query(`INSERT INTO district_pipeline.representations(id,source_snapshot_id,artifact_sha256,policy_decision_id,final_url,redirect_chain,fetched_at,admitted_at,mime_type,admission) VALUES($1,$2,$3,$4,'https://example.org/tenant?body=1','[]',$5,(SELECT checked_at FROM district_pipeline.policy_decisions WHERE id=$4),'text/plain','admitted')`,[randomUUID(),snapshot,hash,policy,fetchedAt]);
    const representation=await pool.query<{fetched_at:Date;admitted_at:Date}>(`SELECT fetched_at,admitted_at FROM district_pipeline.representations WHERE source_snapshot_id=$1`,[snapshot]);
    assert.equal(representation.rows[0].fetched_at.toISOString(),fetchedAt);assert.ok(representation.rows[0].admitted_at>representation.rows[0].fetched_at);
    await assert.rejects(pool.query(`INSERT INTO district_pipeline.representations(id,source_snapshot_id,artifact_sha256,policy_decision_id,final_url,redirect_chain,fetched_at,admitted_at,mime_type,admission) SELECT $1,$2,$3,p.id,'https://example.org/tenant?body=1','[]',$5,p.checked_at-interval '1 second','text/plain','admitted' FROM district_pipeline.policy_decisions p WHERE p.id=$4`,[randomUUID(),snapshot,hash,policy,fetchedAt]),/byte-bound/);
    await assert.rejects(pool.query(`INSERT INTO district_pipeline.representations(id,source_snapshot_id,artifact_sha256,policy_decision_id,final_url,redirect_chain,fetched_at,admitted_at,mime_type,admission) SELECT $1,$2,$3,p.id,'https://example.org/tenant?body=1','[]',$5,p.expires_at,'text/plain','admitted' FROM district_pipeline.policy_decisions p WHERE p.id=$4`,[randomUUID(),snapshot,hash,policy,fetchedAt]),/byte-bound/);
    await assert.rejects(pool.query(`INSERT INTO district_pipeline.representations(id,source_snapshot_id,artifact_sha256,policy_decision_id,final_url,redirect_chain,fetched_at,admitted_at,mime_type,admission) SELECT $1,$2,$3,p.id,'https://example.org/tenant?body=1','[]',p.checked_at+interval '1 second',p.checked_at,'text/plain','admitted' FROM district_pipeline.policy_decisions p WHERE p.id=$4`,[randomUUID(),snapshot,hash,policy]),/byte-bound/);
    const different=await cas.put(Buffer.from('different bytes'),{kind:'derived',mimeType:'text/plain'});await store.addArtifact(different);
    await assert.rejects(pool.query(`INSERT INTO district_pipeline.representations(id,source_snapshot_id,artifact_sha256,policy_decision_id,final_url,redirect_chain,fetched_at,admitted_at,mime_type,admission) VALUES($1,$2,$3,$4,'https://example.org/','[]',$5,(SELECT checked_at FROM district_pipeline.policy_decisions WHERE id=$4),'text/plain','admitted')`,[randomUUID(),snapshot,different.sha256,policy,fetchedAt]),/byte-bound/);
    const spec=jobSpec('policy-cache','verify_artifacts',[hash]);spec.policyProofSha256=proof;spec.sourceScope={...spec.sourceScope,publisherId:'test-publisher',sourceId:'test-source'};
    const admitted=await store.enqueue(spec);assert.equal((await run(await authorize([admitted]),1)).jobsStarted,1);
    const wrongTown=await store.enqueue({...spec,selector:{fixture:'other-municipality'},sourceScope:{...spec.sourceScope,municipalityId:'hoppegarten',ags:'12064227'}});
    const rejectedTown=await run(await authorize([wrongTown],{ags:['12064227']}),1);assert.equal(rejectedTown.reasonCode,'policy_excluded');
    await assert.rejects(pool.query(`UPDATE district_pipeline.policy_decisions SET receipt_json='{\"tampered\":true}' WHERE id=$1`,[policy]),/immutable/);
    const expiredProof=digest(randomUUID());
    await pool.query(`INSERT INTO district_pipeline.policy_decisions(id,source_snapshot_id,proof_sha256,source_sha256,receipt_json,state,observed_robots,owner_robots_override,opt_out_version,policy_version,checked_at,expires_at,reason_code) VALUES($1,$2,$3,$4,$5,'allowed','disallowed',true,'v1','v1',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour','completed')`,[randomUUID(),snapshot,expiredProof,hash,{fixture:'expired-policy-storage',sourceSha256:hash}]);
    const key=await store.enqueue({...spec,selector:{fixture:'expired-cache'},policyProofSha256:expiredProof});
    let calls=0;const result=await run(await authorize([key]),1,{verify_artifacts:async context=>{calls++;return artifactVerificationHandler(context);}});assert.equal(calls,0);assert.equal(result.reasonCode,'policy_expired');
    await pool.query(`UPDATE district_pipeline.policy_decisions SET state='excluded' WHERE id=$1`,[policy]);
    await assert.rejects(pool.query(`UPDATE district_pipeline.policy_decisions SET state='allowed' WHERE id=$1`,[policy]),/new proof required/);
    const revoked=await store.enqueue({...spec,selector:{fixture:'revoked-cache'}});assert.equal((await run(await authorize([revoked]),1)).reasonCode,'policy_excluded');
    assert.equal((await cas.read(hash)).length,bytes.length);
  });

  await t.test('budget reservations are atomic, unknown usage stays reserved, 80%/hard caps hold and R1 paid execution is prohibited',async()=>{
    const key=await store.enqueue(jobSpec('budget-accounting'));const authorizationId=await authorize([key]);const bounds=await store.beginRun(authorizationId,1,60000),claim=await store.claim(bounds,30000);assert.equal(claim.kind,'job');if(claim.kind!=='job')return;
    const budget=randomUUID();await pool.query(`INSERT INTO district_pipeline.provider_budgets(id,provider,currency,owner_approval_sha256,cap_micro_usd,expires_at) VALUES($1,'openai','USD',$2,1000000,clock_timestamp()+interval '1 hour')`,[budget,digest('synthetic-budget-approval')]);
    const reservation=await store.reserveProviderBudget(budget,claim.job.id,claim.job.fencingToken,500000,digest('submission-intent'));
    await store.recordProviderSubmission(reservation,'synthetic-request-id',null);await store.settleProviderReservation(reservation,null);
    let accounting=await pool.query<{reserved_micro_usd:string;spent_micro_usd:string}>('SELECT reserved_micro_usd,spent_micro_usd FROM district_pipeline.provider_budgets WHERE id=$1',[budget]);assert.equal(accounting.rows[0].reserved_micro_usd,'500000');assert.equal(accounting.rows[0].spent_micro_usd,'0');
    await assert.rejects(store.reserveProviderBudget(budget,claim.job.id,claim.job.fencingToken,400000,digest('second-intent')),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='budget_paused');
    await assert.rejects(store.reserveProviderBudget(budget,claim.job.id,claim.job.fencingToken,600000,digest('third-intent')),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='budget_exhausted');
    await store.settleProviderReservation(reservation,400000);await store.settleProviderReservation(reservation,400000);
    accounting=await pool.query('SELECT reserved_micro_usd,spent_micro_usd FROM district_pipeline.provider_budgets WHERE id=$1',[budget]);assert.equal(accounting.rows[0].reserved_micro_usd,'0');assert.equal(accounting.rows[0].spent_micro_usd,'400000');
    await assert.rejects(store.settleProviderReservation(reservation,300000),/cannot change/);
    await store.hold(claim.job,'owner_stopped',receiptFor(claim.job));await store.endRun(bounds.runId,'held','owner_stopped');
    const paid=await store.enqueue(jobSpec('paid-prohibited'),{budgetId:budget,reservedMicroUsd:1});let paidCalls=0;
    const result=await run(await authorize([paid]),1,{verify_artifacts:async context=>{paidCalls++;return artifactVerificationHandler(context);}});assert.equal(result.reasonCode,'paid_not_authorized');assert.equal(paidCalls,0);
  });

  await t.test('subscription API-equivalent estimates remain estimates while paid routes and charges are held',async()=>{
    // Synthetic receipt fixtures only: no provider process, endpoint or billing operation runs.
    const receipt:NonNullable<StepReceipt['provider']>={provider:'openai-subscription',endpoint:'subscription-cli',requestedModel:'synthetic-pinned-model',returnedModel:null,requestId:null,responseId:null,requestSha256:digest('synthetic-request'),responseSha256:null,batchId:null,customId:null,submissionIntentSha256:digest('synthetic-intent'),tokens:{standardInput:null,cacheWriteInput:null,cacheReadInput:null,output:null},actualBilledUsd:null,estimatedApiUsd:1.25,currency:'USD',rateCardDate:null,rateCardSha256:null,reservedMicroUsd:0,subscriptionUsage:{availability:'unavailable',units:null}};
    for(const provider of ['openai-subscription','anthropic-subscription']){
      const key=await store.enqueue(jobSpec('subscription-estimate-'+provider,'provider_fixture'));
      const result=await run(await authorize([key]),1,{provider_fixture:async()=>({outcome:'succeeded',reasonCode:'completed',provider:{...receipt,provider}})});
      assert.equal(result.state,'completed');assert.equal(result.jobsStarted,1);
      const persisted=await pool.query<{receipt:StepReceipt}>('SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=$1',[result.runId]);
      assert.equal(persisted.rows[0].receipt.provider?.provider,provider);
      assert.equal(persisted.rows[0].receipt.provider?.estimatedApiUsd,1.25);
      assert.equal(persisted.rows[0].receipt.provider?.actualBilledUsd,null);
      assert.equal(persisted.rows[0].receipt.provider?.subscriptionUsage.units,null);
    }
    for(const provider of [
      {...receipt,provider:'openai',endpoint:'/v1/responses',actualBilledUsd:null},
      {...receipt,provider:'anthropic-api',endpoint:'/v1/messages',estimatedApiUsd:0,actualBilledUsd:0},
      {...receipt,actualBilledUsd:0.01},
      {...receipt,reservedMicroUsd:1},
    ]){
      const key=await store.enqueue(jobSpec('paid-receipt-'+randomUUID(),'provider_fixture'));
      const result=await run(await authorize([key]),1,{provider_fixture:async()=>({outcome:'succeeded',reasonCode:'completed',provider})});
      assert.equal(result.state,'held');assert.equal(result.reasonCode,'paid_not_authorized');
      const persisted=await pool.query<{outcome:string}>(`SELECT outcome FROM district_pipeline.step_receipts WHERE run_id=$1`,[result.runId]);
      assert.equal(persisted.rows[0].outcome,'held_execution');
    }
  });

  await t.test('a normally returned held CLI result retains JSON stdout, exit 2 and R1 execution stderr',async st=>{
    const key=await store.enqueue(jobSpec('cli-held-result')),approval=digest('cli-approved-notification-route'),destination=digest('cli-approved-destination'),provider='ntfy';
    const authorizationId=await authorize([key],{mode:'bounded_unattended',notificationApprovalSha256:approval,notificationDestinationSha256:destination,notificationProvider:provider});
    const previousUrl=process.env.DATABASE_URL,previousExit=process.exitCode;let stdout='',stderr='';
    process.env.DATABASE_URL=isolated.href;
    st.mock.method(process.stdout,'write',(chunk:string|Uint8Array)=>{stdout+=String(chunk);return true;});
    st.mock.method(process.stderr,'write',(chunk:string|Uint8Array)=>{stderr+=String(chunk);return true;});
    try{
      const result=await runDistrictJobsCli({verify_artifacts:async()=>({outcome:'held_execution',reasonCode:'execution_exception'})},['run','--authorization-id',authorizationId,'--max-jobs','1','--max-seconds','60','--mode','bounded_unattended','--cas-root',cas.root],{
        notificationApprovalSha256:approval,destinationSha256:destination,provider,
        notifyOwner:async notification=>({provider,messageId:randomUUID(),notificationId:notification.id,payloadSha256:digest(canonicalJson(notification)),destinationSha256:destination,acknowledgedAt:new Date().toISOString()}),
      });
      assert.ok(result);assert.equal(result.state,'held');assert.equal(result.reasonCode,'execution_exception');
      reportR1ExecutorFailure(result);
      assert.equal(stdout,JSON.stringify(result)+'\n');assert.equal(process.exitCode,2);
      assert.equal(stderr,'R1_FAILURE phase=execution code=execution_exception\n');
      const committed=await pool.query("SELECT r.receipt->>'reasonCode' AS reason FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id WHERE j.job_key=$1",[key]);
      assert.equal(committed.rows[0].reason,'execution_exception');
      stderr='';reportR1ExecutorFailure({...result,state:'completed',reasonCode:'completed'});reportR1ExecutorFailure(undefined);assert.equal(stderr,'');
    }finally{
      st.mock.restoreAll();process.exitCode=previousExit;if(previousUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previousUrl;
    }
  });

  await t.test('bounded unattended mode proves approved channel readiness before work and stores real acknowledgement identities',async()=>{
    const approval=digest('approved-notification-route'),destination=digest('synthetic-approved-destination'),provider='ntfy',key=await store.enqueue(jobSpec('bounded-approved'));
    const identity={notificationApprovalSha256:approval,notificationDestinationSha256:destination,notificationProvider:provider};
    const acknowledge=async (notification:OwnerNotification):Promise<NotificationAcknowledgement>=>({provider,messageId:randomUUID(),notificationId:notification.id,payloadSha256:digest(canonicalJson(notification)),destinationSha256:notification.destinationSha256,acknowledgedAt:new Date().toISOString()});
    await assert.rejects(authorize([key],{mode:'bounded_unattended'}),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='notification_unavailable');
    const authorizationId=await authorize([key],{mode:'bounded_unattended',...identity});
    await assert.rejects(run(authorizationId,1),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='authorization_mode_mismatch');
    await assert.rejects(runDistrictJobs({store,cas,handlers,authorizationId,mode:'bounded_unattended',maxJobs:1,maxElapsedMs:60000,...identity,notificationDestinationSha256:digest('wrong-route'),notifyOwner:acknowledge}),error=>error instanceof DistrictExecutionHold&&error.reasonCode==='notification_unavailable');
    const notifications:OwnerNotification[]=[];
    const result=await runDistrictJobs({store,cas,handlers:{verify_artifacts:async context=>{
      const startup=await pool.query<{state:string}>(`SELECT state FROM district_pipeline.owner_notifications WHERE run_id=$1 AND phase='startup'`,[context.job.runId]);
      assert.equal(startup.rows[0].state,'delivered');assert.equal(notifications.length,1);return artifactVerificationHandler(context);
    }},authorizationId,mode:'bounded_unattended',maxJobs:1,maxElapsedMs:60000,...identity,notifyOwner:async notification=>{
      const durable=await pool.query<{state:string;payload:OwnerNotification}>('SELECT state,payload FROM district_pipeline.owner_notifications WHERE id=$1',[notification.id]);
      assert.equal(durable.rows[0].state,'pending');assert.deepEqual(durable.rows[0].payload,notification);notifications.push(notification);return acknowledge(notification);
    }});
    assert.equal(result.state,'completed');assert.deepEqual(notifications.map(item=>item.phase),['startup','disposition']);assert.equal(notifications[0].runId,result.runId);
    const runs=await pool.query<{owner_present:boolean;execution_mode:string}>('SELECT owner_present,execution_mode FROM district_pipeline.executor_runs WHERE id=$1',[result.runId]);
    assert.equal(runs.rows[0].owner_present,false);assert.equal(runs.rows[0].execution_mode,'bounded_unattended');
    const outbox=await pool.query<{state:string;provider_message_id:string;provider:string}>('SELECT state,provider_message_id,provider FROM district_pipeline.owner_notifications WHERE run_id=$1',[result.runId]);
    assert.equal(outbox.rowCount,2);for(const row of outbox.rows){assert.equal(row.state,'delivered');assert.ok(row.provider_message_id);assert.equal(row.provider,provider);}
    const retryKey=await store.enqueue(jobSpec('notification-transient')),retryAuth=await authorize([retryKey],{mode:'bounded_unattended',...identity});
    let transientCalls=0;
    const retried=await runDistrictJobs({store,cas,handlers,authorizationId:retryAuth,mode:'bounded_unattended',maxJobs:1,maxElapsedMs:60000,...identity,notifyOwner:async notification=>{
      if(notification.phase==='startup'&&transientCalls++===0)throw new NotificationTransientError('synthetic outage');
      return acknowledge(notification);
    }});
    assert.equal(retried.state,'completed');assert.equal(transientCalls,2);
    const transientRow=await pool.query<{attempts:number}>(`SELECT attempts FROM district_pipeline.owner_notifications WHERE run_id=$1 AND phase='startup'`,[retried.runId]);
    assert.equal(transientRow.rows[0].attempts,2);

    const ambiguousKey=await store.enqueue(jobSpec('notification-ambiguous')),ambiguousAuth=await authorize([ambiguousKey],{mode:'bounded_unattended',...identity});
    const ambiguousPosts:OwnerNotification[]=[];
    const recovered=await runDistrictJobs({store,cas,handlers,authorizationId:ambiguousAuth,mode:'bounded_unattended',maxJobs:1,maxElapsedMs:60000,...identity,notifyOwner:async notification=>{
      if(notification.phase==='startup'){
        ambiguousPosts.push(notification);
        if(ambiguousPosts.length===1)throw new NotificationAmbiguousError('synthetic accepted-but-timeout');
      }
      return acknowledge(notification);
    }});
    assert.equal(recovered.state,'completed');assert.equal(ambiguousPosts.length,2);
    assert.equal(ambiguousPosts[0].id,ambiguousPosts[1].id);assert.equal(canonicalJson(ambiguousPosts[0]),canonicalJson(ambiguousPosts[1]));
    const ambiguousRow=await pool.query<{attempts:number;state:string;provider_message_id:string}>(`SELECT attempts,state,provider_message_id FROM district_pipeline.owner_notifications WHERE run_id=$1 AND phase='startup'`,[recovered.runId]);
    assert.equal(ambiguousRow.rows[0].attempts,2);assert.equal(ambiguousRow.rows[0].state,'delivered');assert.ok(ambiguousRow.rows[0].provider_message_id);

    const streamKey=await store.enqueue(jobSpec('notification-stream-timeout'));
    const streamIdentity={notificationApprovalSha256:pipelineNotificationConfig.notificationApprovalSha256,notificationDestinationSha256:pipelineNotificationConfig.destinationSha256,notificationProvider:pipelineNotificationConfig.provider};
    const streamAuth=await authorize([streamKey],{mode:'bounded_unattended',...streamIdentity});
    const streamPosts:OwnerNotification[]=[];
    const streamRecovered=await runDistrictJobs({store,cas,handlers,authorizationId:streamAuth,mode:'bounded_unattended',maxJobs:1,maxElapsedMs:60000,...streamIdentity,notifyOwner:async(notification,signal)=>sendPipelineNotification(notification,{
      readToken:async()=> 'synthetic_fixture_publisher_token',
      send:async(_url,init)=>{
        if(notification.phase==='startup'){
          streamPosts.push(notification);
          if(streamPosts.length===1)return new Response(new ReadableStream<Uint8Array>({start(controller){controller.error(new DOMException('timeout','TimeoutError'));}}));
        }
        return new Response(JSON.stringify({id:randomUUID(),event:'message',topic:'pipeline',message:String(init?.body),time:Math.floor(Date.now()/1000)}));
      },
    },signal)});
    assert.equal(streamRecovered.state,'completed');assert.equal(streamPosts.length,2);
    assert.equal(streamPosts[0].id,streamPosts[1].id);assert.equal(canonicalJson(streamPosts[0]),canonicalJson(streamPosts[1]));
    const streamRow=await pool.query<{attempts:number;state:string}>(`SELECT attempts,state FROM district_pipeline.owner_notifications WHERE run_id=$1 AND phase='startup'`,[streamRecovered.runId]);
    assert.deepEqual(streamRow.rows,[{attempts:2,state:'delivered'}]);

    const parallelKey=await store.enqueue(jobSpec('notification-claim')),parallelAuth=await authorize([parallelKey],{mode:'bounded_unattended',...identity});
    const parallelRun=await store.beginRun(parallelAuth,1,60000,'bounded_unattended',{notificationApprovalSha256:approval,destinationSha256:destination,provider});
    const deliveries=new Map<string,number>(),config={notificationApprovalSha256:approval,destinationSha256:destination,provider,notifyOwner:async(notification:OwnerNotification)=>{
      deliveries.set(notification.id,(deliveries.get(notification.id)??0)+1);await pool.query('SELECT pg_sleep(0.05)');return acknowledge(notification);
    }};
    await Promise.all([deliverDistrictOwnerNotifications(store,config),deliverDistrictOwnerNotifications(store,config)]);
    assert.deepEqual([...deliveries.values()],[1]);
    await store.endRun(parallelRun.runId,'completed','no_ready_jobs');await deliverDistrictOwnerNotifications(store,config);
    const replayKey=await store.enqueue(jobSpec('notification-ack-replay')),replayAuthorization=await authorize([replayKey],{mode:'bounded_unattended',...identity});
    const replay=await runDistrictJobs({store,cas,handlers,authorizationId:replayAuthorization,mode:'bounded_unattended',maxJobs:1,maxElapsedMs:60000,...identity,notifyOwner:async notification=>({...await acknowledge(notification),messageId:outbox.rows[0].provider_message_id})});
    assert.equal(replay.reasonCode,'notification_failed');assert.equal(replay.jobsStarted,0);
    await deliverDistrictOwnerNotifications(store,{notificationApprovalSha256:approval,destinationSha256:destination,provider,notifyOwner:acknowledge});
    const noAck=await store.enqueue(jobSpec('notification-no-op')),noAckAuthorization=await authorize([noAck],{mode:'bounded_unattended',...identity});
    const noOp=await runDistrictJobs({store,cas,handlers,authorizationId:noAckAuthorization,mode:'bounded_unattended',maxJobs:1,maxElapsedMs:60000,...identity,notifyOwner:async()=>undefined as unknown as NotificationAcknowledgement});
    assert.equal(noOp.reasonCode,'notification_failed');assert.equal(noOp.jobsStarted,0);
    await deliverDistrictOwnerNotifications(store,{notificationApprovalSha256:approval,destinationSha256:destination,provider,notifyOwner:acknowledge});
    const failure=await store.enqueue(jobSpec('notification-failure')),failureAuthorization=await authorize([failure],{mode:'bounded_unattended',...identity});let calls=0;
    const failed=await runDistrictJobs({store,cas,handlers:{verify_artifacts:async context=>{calls++;return artifactVerificationHandler(context);}},authorizationId:failureAuthorization,mode:'bounded_unattended',maxJobs:1,maxElapsedMs:60000,...identity,notifyOwner:async()=>{throw Error('private-notification-destination');}});
    assert.equal(failed.state,'held');assert.equal(failed.reasonCode,'notification_failed');assert.equal(failed.jobsStarted,0);assert.equal(calls,0);
    const pending=await store.pendingNotifications();assert.equal(pending.length,2);assert.ok(pending.some(item=>item.phase==='disposition'&&item.reasonCode==='notification_failed'));assert.doesNotMatch(JSON.stringify(pending),/private-notification-destination/);
    const failedRun=await pool.query<{state:string;reason_code:string}>('SELECT state,reason_code FROM district_pipeline.executor_runs WHERE id=$1',[failed.runId]);
    assert.equal(failedRun.rows[0].state,'held');assert.equal(failedRun.rows[0].reason_code,'notification_failed');
    await deliverDistrictOwnerNotifications(store,{notificationApprovalSha256:approval,destinationSha256:destination,provider,notifyOwner:acknowledge});
    const persistentKey=await store.enqueue(jobSpec('notification-persistent')),persistentAuth=await authorize([persistentKey],{mode:'bounded_unattended',...identity});
    let persistentAttempts=0;
    const persistent=await runDistrictJobs({store,cas,handlers,authorizationId:persistentAuth,mode:'bounded_unattended',maxJobs:1,maxElapsedMs:1200,...identity,notifyOwner:async()=>{
      persistentAttempts++;throw new NotificationTransientError('synthetic persistent outage');
    }});
    assert.equal(persistent.reasonCode,'notification_failed');assert.equal(persistent.jobsStarted,0);assert.equal(persistentAttempts,2);
  });
});
