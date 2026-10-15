import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rm,unlink} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {canonicalJson,digest,semanticHash} from '../src/district-adapter-contract.ts';
import {DistrictJobStore,migrateDistrictJobs,runDistrictJobs,type JobHandler} from '../src/district-jobs.ts';
import {assessmentQueueContract,assessmentQueueHandlers,enqueuePreparedAssessmentPass,enqueueAssessmentResolution,residualAssessmentItem,residualRecordPropositions,exportAssessmentResults} from '../src/district-assessment-jobs.ts';
import {DistrictAssessmentBroker,assessmentBJobHandler,enqueueAssessmentB} from '../src/district-assessment-broker.ts';
import {BridgeLeaseSchema,BridgeStatusSchema} from '../src/district-assessment-bridge-contract.ts';
import {assessmentItemSchema,originalEvidence,buildAssessmentPassInput,type AssessmentItem,type AssessmentOutput,type AssessmentPassInput} from '../src/district-assessment.ts';
import {knowledgeEvidenceHash,type DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {PROVIDER_CONFIGS,SubscriptionRuntimeError,type ModelAnswer} from '../src/district-model-contract.ts';
import {initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
import {registerR1CodexDocument,reserveR1CodexCall} from '../src/district-codex-accounting.ts';
import {admittedAssessmentFixture,recordFor,answer} from './district-assessment.fixture.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';
import type {PreparedDocument} from '../src/district-prepared-document.ts';
import {buildPreparedAssessmentContext,AssessmentContextHold} from '../src/district-assessment-context.ts';

const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;

// The entire sequential matrix shares this parent allowance on the two-CPU R1 gate.
test('governed A/B/C queue and original-wide Codex ceilings',{skip:!connectionString,timeout:300000},async t=>{
 const base=new URL(connectionString!);if(!['localhost','127.0.0.1','[::1]',''].includes(base.hostname))throw Error('Fixture refuses remote PostgreSQL');
 const host=base.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Fixture refuses remote host override');
 const admin=new Pool({connectionString,max:2}),closeAdmin=poolShutdownBarrier(admin),database='district_assessment_queue_'+randomUUID().replaceAll('-','');
 let db:Pool|undefined,closeDb:(()=>Promise<void>)|undefined,created=false;const directories:string[]=[];
 t.after(async()=>{try{await closeDb?.();if(created)await admin.query('DROP DATABASE "'+database+'"');}finally{await closeAdmin();for(const directory of directories)await rm(directory,{recursive:true,force:true});}});
 await admin.query('CREATE DATABASE "'+database+'"');created=true;const url=new URL(base);url.pathname='/'+database;
 db=new Pool({connectionString:url.href,max:8});closeDb=poolShutdownBarrier(db);const pool=db;await migrateDistrictJobs(pool);
 async function fixture(name:string,originalText?:string,mutate?:(record:DistrictKnowledgeRecord,text:string)=>void,mutateItem?:(item:AssessmentItem)=>void){
  const text=originalText??'Strausberg synthetic original evidence '+name+' '+randomUUID()+'.',f=await admittedAssessmentFixture(text,true);directories.push(f.directory);
  const cas=f.context.cas,policy=f.context.policyOptions,store=new DistrictJobStore(pool),record=recordFor(f,text),rubric='Synthetic frozen rubric: exact evidence only; AI agreement is not independent gold.';
  if(mutate){mutate(record,text);record.verification.evidenceHash=knowledgeEvidenceHash(record);}
  await initializeManagedAcquisitionLane(cas.root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
  const put=async(value:unknown,kind:'derived'|'receipt'|'source_original'|'parser_output'='derived',raw=false)=>{
   const bytes=raw?Buffer.from(value as string):Buffer.from(canonicalJson(value)),hash=digest(bytes);
   const artifact=await withManagedSourceWrite(cas.root,[{kind:'http_observation',relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,url:f.policy.source.url,sourceSha256:f.source.originalSha256,observationId:name,receiptSha256:f.policyArtifact.sha256,independentAllowed:kind==='source_original'}],()=>cas.put(bytes,{kind,mimeType:raw?'text/plain':'application/json',...(kind==='source_original'?{admission:{state:'allowed' as const,sourceSha256:f.source.originalSha256,policyProofSha256:f.policyArtifact.sha256,checkedAt:f.policy.checkedAt,expiresAt:f.policy.expiresAt}}:{})}),policy);
   await store.addArtifact(artifact);return artifact;
  };
  for(const artifact of [f.policyArtifact,f.parserArtifact])await put(JSON.parse((await cas.read(artifact.sha256)).toString('utf8')),'receipt');
  await put(text,'source_original',true);
  const projection=residualRecordPropositions(record);
  const quotes=new Set<string>();
  const visit=(value:unknown):void=>{if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')for(const [key,member] of Object.entries(value)){if((key==='quote'||key.endsWith('Quote'))&&typeof member==='string'&&member.length)quotes.add(member);else visit(member);}};
  visit(record);
  const locators=[...quotes].map(quote=>{const start=text.indexOf(quote);assert.ok(start>=0);return {id:`span:${start}:${start+quote.length}`,page:null,table:null,start,end:start+quote.length};}).sort((a,b)=>a.start-b.start||a.end-b.end);
  const boundedSource={...f.source,locators,assessmentContext:buildPreparedAssessmentContext(text,f.source.textSha256,record.extraction.chunk,record.sources.map(source=>source.locator),locators)};
  const item=assessmentItemSchema.parse({version:'assessment-item-v1',itemId:record.id,question:'Verify every proposition independently against the original source.',claim:canonicalJson(projection),rubric,rubricSha256:digest(rubric),sources:[boundedSource],claimIds:projection.propositions.map(proposition=>proposition.claimId),entityIds:[],constraints:[],criticalKinds:[]});
  mutateItem?.(item);
  const itemArtifact=await put(item),recordArtifact=await put(record),bundle=await put({version:'r1-assessment-items-v1',items:[{itemArtifactSha256:itemArtifact.sha256,recordArtifactSha256:recordArtifact.sha256,maxModelCalls:48}]});
  const snapshot=randomUUID(),scope=f.policy.scope;
  await pool.query(`INSERT INTO district_pipeline.source_snapshots(id,publisher_id,source_id,municipality_id,ags,tenant,resource_identity,request_method,request_selector_sha256,observation_window,retrieved_at,scope_sha256) VALUES($1,$2,$3,$4,$5,NULL,$6,'GET',$7,$8,$9,$10)`,[snapshot,scope.publisherId,scope.sourceId,scope.municipalityId,scope.ags,f.policy.source.url,digest('synthetic GET '+name),scope.observationWindow,f.policy.checkedAt,semanticHash(scope)]);
  await pool.query(`INSERT INTO district_pipeline.policy_decisions(id,source_snapshot_id,proof_sha256,source_sha256,receipt_json,state,observed_robots,owner_robots_override,opt_out_version,policy_version,checked_at,expires_at,reason_code) VALUES($1,$2,$3,$4,$5,'allowed','allowed',false,$6,$7,$8,$9,'synthetic_shared_admission')`,[randomUUID(),snapshot,f.policyArtifact.sha256,f.source.originalSha256,f.policy,f.policy.optOutSnapshotSha256,f.policy.version,f.policy.checkedAt,f.policy.expiresAt]);
  const preparationKey=await store.enqueue({step:'assessment_prepare',lane:'assessment',semanticContractSha256:await assessmentQueueContract(),inputArtifactHashes:[itemArtifact.sha256,recordArtifact.sha256,bundle.sha256,f.originalArtifact.sha256,f.policyArtifact.sha256,f.parserArtifact.sha256],sourceScope:scope,selector:{syntheticFixture:name},policyProofSha256:f.policyArtifact.sha256});
  const authorize=async(key:string)=>store.authorize({approvalSha256:digest('synthetic lead-issued stage citing #81 '+randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[key],ags:[scope.ags],maxJobs:10,maxElapsedMs:60000,category:'development'});
  const run=async(key:string,handlers:Readonly<Record<string,JobHandler>>,authorizationId?:string)=>{
   authorizationId??=await authorize(key);
   return runDistrictJobs({store,cas,handlers,authorizationId,maxJobs:1,maxElapsedMs:60000,ownerPresent:true,leaseMs:30000});
  };
  const preparedRun=await run(preparationKey,{assessment_prepare:async()=>({outcome:'succeeded',reasonCode:'completed',outputs:[itemArtifact,recordArtifact,bundle]})});
  assert.equal(preparedRun.state,'completed',canonicalJson(preparedRun));
  const AJobKey=(await enqueuePreparedAssessmentPass(pool,store,cas,preparationKey,'A'))[0];
  const broker=new DistrictAssessmentBroker(pool,cas,{policyOptions:policy,fixtureProtocol:true}),clientContractSha256=digest('synthetic protocol contract');
  const BJobKey=await enqueueAssessmentB(broker,{itemArtifactSha256:itemArtifact.sha256,sourceScope:scope,policyProofSha256:f.policyArtifact.sha256,transport:'mac-bridge',clientContractSha256});
  const handlers=(provider:(input:AssessmentPassInput)=>Promise<ModelAnswer>=async input=>answer(input))=>assessmentQueueHandlers(pool,{policyOptions:policy,fixtureProvider:provider});
  const runB=async(disagree=false,unresolved=false)=>{
   const pending=run(BJobKey,{assessment_b:assessmentBJobHandler(broker)});
   const deadline=Date.now()+5000;
   for(;;){const rows=await pool.query(`SELECT b.id FROM district_pipeline.assessment_bridge_leases b JOIN district_pipeline.jobs j ON j.id=b.job_id WHERE j.job_key=$1 AND b.state='ready'`,[BJobKey]);if(rows.rowCount)break;if(Date.now()>=deadline)throw Error('Synthetic B lease deadline');await delay(10);}
   const lease=BridgeLeaseSchema.parse(await broker.dispatch({operation:'claim',jobKey:BJobKey,clientId:'synthetic-client',clientContractSha256}));
   const startedAt=new Date().toISOString();
   const output=answer(buildAssessmentPassInput(item,await originalEvidence(item,f.context),'B'),unresolved).value as AssessmentOutput;if(disagree)output.scores.usefulness=2;
   const config=PROVIDER_CONFIGS['anthropic-subscription'],identity={provider:'anthropic-subscription' as const,tool:'claude-cli' as const,toolVersion:'0.0.0-synthetic-test-only',model:config.model,modelIdentityBasis:config.modelIdentityBasis};
   const stdout=[{type:'system',subtype:'init',tools:[],mcp_servers:[],model:config.model},{type:'assistant',message:{id:'msg_synthetic',model:config.model,content:[]}},{type:'result',subtype:'success',is_error:false,model:config.model,request_id:'req_synthetic',structured_output:output,usage:{input_tokens:1,output_tokens:1}}].map(value=>JSON.stringify(value)).join('\n')+'\n';
   const finishedAt=new Date().toISOString(),completedAt=new Date().toISOString();
   const submitted=await broker.dispatch({operation:'submit',leaseId:lease.leaseId,inputSha256:lease.inputSha256,purgeAck:{sourceFiles:0,responseFiles:0,modelFileWritesDenied:true,completedAt},answer:{stdout,evidence:{...identity,modelIdentitySha256:digest(JSON.stringify(identity))},startedAt,finishedAt}});
   assert.equal(BridgeStatusSchema.parse(submitted).state,'submitted');
   const result=await pending,state=await pool.query('SELECT state,reason_code FROM district_pipeline.jobs WHERE job_key=$1',[BJobKey]);
   assert.equal(state.rows[0].state,unresolved?'held_quality':'succeeded',canonicalJson(state.rows[0]));
   return result;
  };
  return {...f,cas,policy,proof:f.policy,store,item,record,preparationKey,AJobKey,BJobKey,handlers,authorize,run,runB,put};
 }
 await t.test('full blind A/B agreement plus mandatory genuine C is admitted',async()=>{
  const f=await fixture('agreement');let calls=0;
  const provider=async(input:AssessmentPassInput)=>{calls++;if(input.role==='A'){assert.equal(input.assessments,null);assert.equal('assessments' in input.data,false);}return answer(input);};
  assert.equal((await f.run(f.AJobKey,f.handlers(provider))).state,'completed');assert.equal((await f.runB()).state,'completed');
  const pair={AJobKey:f.AJobKey,BJobKey:f.BJobKey};
  const pending=await enqueueAssessmentResolution(pool,f.store,f.cas,pair,'reconcile',f.policy);await f.run(pending,f.handlers());
  const pendingRow=await pool.query('SELECT state,reason_code FROM district_pipeline.jobs WHERE job_key=$1',[pending]);assert.equal(pendingRow.rows[0].reason_code,'dependency_uncommitted');
  const CJobKey=await enqueueAssessmentResolution(pool,f.store,f.cas,pair,'C',f.policy);assert.equal((await f.run(CJobKey,f.handlers(provider))).state,'completed');
  const finalKey=await enqueueAssessmentResolution(pool,f.store,f.cas,{...pair,CJobKey},'reconcile',f.policy);assert.equal((await f.run(finalKey,f.handlers())).state,'completed');
  const finalRow=await pool.query(`SELECT receipt FROM district_pipeline.step_receipts WHERE receipt->>'jobKey'=$1`,[finalKey]);const final=JSON.parse((await f.cas.read(finalRow.rows[0].receipt.outputHashes[0])).toString('utf8'));
  assert.equal(final.disposition,'ai_reconciled');assert.equal(final.independentlyValidated,false);assert.equal(calls,2);
  const count=await pool.query('SELECT count(*) FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=$1',[f.source.originalSha256]);assert.equal(Number(count.rows[0].count),2);
  const exported=await exportAssessmentResults(pool,f.cas,[f.AJobKey,f.BJobKey,CJobKey,finalKey],f.policy);
  assert.equal(exported.results.length,4);assert.equal(canonicalJson(exported).includes('Synthetic provider fixture'),false);
 });
 for(const unresolved of [false,true])await t.test('disagreement C '+(unresolved?'holds':'reconciles'),async()=>{
  const f=await fixture('disagreement-'+unresolved);await f.run(f.AJobKey,f.handlers());await f.runB(true);
  const pair={AJobKey:f.AJobKey,BJobKey:f.BJobKey},CJobKey=await enqueueAssessmentResolution(pool,f.store,f.cas,pair,'C',f.policy);
  await f.run(CJobKey,f.handlers(async input=>{assert.ok(input.discrepancies?.mismatches.includes('scores'));return answer(input,unresolved);}));
  const key=await enqueueAssessmentResolution(pool,f.store,f.cas,{...pair,CJobKey},'reconcile',f.policy),result=await f.run(key,f.handlers());assert.equal(result.state,unresolved?'held':'completed');
 });
 await t.test('48 combined extraction/A/C intents cap and ambiguous intents never replay',async()=>{
  const f=await fixture('cap');let called=false;
  // Synthetic extraction job uses the same canonical pre-effect reservation as native misses.
  const extractionKey=await f.store.enqueue({step:'residual_extract',lane:'residual_extraction',semanticContractSha256:digest('synthetic extraction'),inputArtifactHashes:[f.originalArtifact.sha256,f.policyArtifact.sha256],sourceScope:f.proof.scope,selector:{fixture:'48 real reservation operations, no provider'},policyProofSha256:f.policyArtifact.sha256});
  await f.run(extractionKey,{residual_extract:async context=>{
   for(let i=0;i<48;i++)await reserveR1CodexCall(pool,context.job,f.source.originalSha256,digest('synthetic source call '+i));
   await assert.rejects(reserveR1CodexCall(pool,context.job,f.source.originalSha256,digest('synthetic source call 0')),{message:'usage_unknown'});
   return {outcome:'succeeded',reasonCode:'completed'};
  }});
  const result=await f.run(f.AJobKey,f.handlers(async input=>{called=true;return answer(input);}));assert.equal(result.reasonCode,'source_limit_exceeded');assert.equal(called,false);
  await assert.rejects(pool.query('UPDATE district_pipeline.r1_codex_call_intents SET paid_micro_usd=1 WHERE original_sha256=$1',[f.source.originalSha256]),/Immutable/);
 });
 await t.test('tampered B receipt yields a durable hold before C/admission',async()=>{
  const f=await fixture('tamper');await f.run(f.AJobKey,f.handlers());await f.runB();
  const pair={AJobKey:f.AJobKey,BJobKey:f.BJobKey},key=await enqueueAssessmentResolution(pool,f.store,f.cas,pair,'reconcile',f.policy);
  const row=await pool.query(`SELECT receipt FROM district_pipeline.step_receipts WHERE receipt->>'jobKey'=$1`,[f.BJobKey]);let hash:string|undefined;
  for(const candidate of row.rows[0].receipt.outputHashes){try{const value=JSON.parse((await f.cas.read(candidate)).toString('utf8'));if(value.version==='assessment-receipt-v1')hash=candidate;}catch{}}
  assert.ok(hash);
  // Delete only the synthetic committed B receipt, exercising custody/CAS tamper refusal.
  await unlink(f.cas.root+'/sha256/'+hash.slice(0,2)+'/'+hash);
  const result=await f.run(key,f.handlers());assert.equal(result.state,'held');
 });
 for(const field of ['summary','documentDate','stage'] as const)await t.test('unsupported actual '+field+' proposition cannot admit a non-critical record',async()=>{
  const mutate=(record:DistrictKnowledgeRecord,text:string)=>{
   if(field==='summary')record.summary='The original establishes an entirely different synthetic project.';
   else if(field==='documentDate'){record.documentDate='2027-01-01';record.documentDateQuote=text;}
   else {record.stage='draft';record.stageQuote=text;record.originalStatus='Synthetic draft assertion unsupported by the original';}
  };
  const f=await fixture('wrong-'+field,undefined,mutate);
  const projected=JSON.parse(f.item.claim);assert.ok(projected.propositions.some((p:{selector:string;value:unknown})=>p.selector==='/'+field&&p.value===f.record[field]));
  assert.equal('verification' in projected,false);assert.equal('extraction' in projected,false);
  const reject=async(input:AssessmentPassInput)=>{
   const supplied=JSON.parse(JSON.stringify(input.data.claim));
   const restored={...supplied,version:'r1-record-propositions-v1',propositions:supplied.propositions.map(({sourceIds,...p}:Record<string,unknown>&{sourceIds:string[]})=>({...p,sources:sourceIds.map(id=>supplied.sources.find((source:{id:string})=>source.id===id))}))};
   assert.equal(canonicalJson(restored),f.item.claim);return answer(input,true);
  };
  await f.run(f.AJobKey,f.handlers(reject));await f.runB();
  const pair={AJobKey:f.AJobKey,BJobKey:f.BJobKey},CJobKey=await enqueueAssessmentResolution(pool,f.store,f.cas,pair,'C',f.policy);
  await f.run(CJobKey,f.handlers(reject));
  const key=await enqueueAssessmentResolution(pool,f.store,f.cas,{...pair,CJobKey},'reconcile',f.policy);
  const result=await f.run(key,f.handlers());assert.equal(result.state,'held');
  const row=await pool.query('SELECT state,reason_code FROM district_pipeline.jobs WHERE job_key=$1',[key]);assert.notEqual(row.rows[0].state,'succeeded');
  const blindB=await fixture('wrong-'+field+'-rejected-by-B',undefined,mutate);
  await blindB.run(blindB.AJobKey,blindB.handlers());
  assert.equal((await blindB.runB(false,true)).state,'held');
  await assert.rejects(enqueueAssessmentResolution(pool,blindB.store,blindB.cas,{AJobKey:blindB.AJobKey,BJobKey:blindB.BJobKey},'C',blindB.policy),/dependency_uncommitted/);
 });
 await t.test('partial supported proposition coverage cannot admit a record',async()=>{
  const f=await fixture('partial-coverage');assert.ok(f.item.claimIds.length>1);
  await f.run(f.AJobKey,f.handlers());await f.runB();
  const pair={AJobKey:f.AJobKey,BJobKey:f.BJobKey},CJobKey=await enqueueAssessmentResolution(pool,f.store,f.cas,pair,'C',f.policy);
  await f.run(CJobKey,f.handlers(async input=>{
   const complete=answer(input),output=complete.value as AssessmentOutput;
   output.assertions=output.assertions.slice(0,1);
   return {...complete,value:output,responseSha256:digest(canonicalJson(output))};
  }));
  const key=await enqueueAssessmentResolution(pool,f.store,f.cas,{...pair,CJobKey},'reconcile',f.policy);
  assert.equal((await f.run(key,f.handlers())).state,'held');
 });
 await t.test('usage limit stops its authorization and only a later explicit authorization resumes',async()=>{
  const f=await fixture('usage-limit');let calls=0;
  const other=await fixture('usage-other-source');
  const firstAuthorization=await f.store.authorize({approvalSha256:digest('synthetic bounded stage citing #81 '+randomUUID()),approvedBy:'synthetic-test-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[f.AJobKey,other.AJobKey],ags:[f.proof.scope.ags],maxJobs:10,maxElapsedMs:60000,category:'development'});
  const result=await f.run(f.AJobKey,f.handlers(async()=>{calls++;throw new SubscriptionRuntimeError('rate_limit','Synthetic subscription usage limit');}),firstAuthorization);assert.equal(result.reasonCode,'budget_paused');assert.equal(calls,1);
  const further=await other.run(other.AJobKey,other.handlers(async input=>{calls++;return answer(input);}),firstAuthorization);assert.equal(further.reasonCode,'budget_paused');assert.equal(calls,1);
  await f.store.resume(f.AJobKey);
  const replay=await f.run(f.AJobKey,f.handlers(async input=>{calls++;return answer(input);}),firstAuthorization);assert.equal(replay.reasonCode,'budget_paused');assert.equal(calls,1);
  await f.store.resume(f.AJobKey);
  const nextAuthorization=await f.authorize(f.AJobKey);
  const resumed=await f.run(f.AJobKey,f.handlers(async input=>{calls++;return answer(input);}),nextAuthorization);assert.equal(resumed.state,'completed');assert.equal(calls,2);
  const audit=await pool.query('SELECT * FROM district_pipeline.r1_codex_resumptions WHERE held_authorization_id=$1 AND authorization_id=$2',[firstAuthorization,nextAuthorization]);
  assert.equal(audit.rowCount,1);assert.equal(audit.rows[0].approved_by,'synthetic-test-owner');assert.ok(audit.rows[0].approved_at<audit.rows[0].resumed_at||audit.rows[0].approved_at.getTime()===audit.rows[0].resumed_at.getTime());
  await assert.rejects(pool.query('DELETE FROM district_pipeline.r1_codex_usage_holds WHERE authorization_id=$1',[firstAuthorization]),/Immutable/);
  await assert.rejects(pool.query('UPDATE district_pipeline.r1_codex_resumptions SET approved_by=$1 WHERE authorization_id=$2',['synthetic mutation',nextAuthorization]),/Immutable/);
  const count=await pool.query('SELECT count(*) FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=$1',[f.source.originalSha256]);assert.equal(Number(count.rows[0].count),2);
 });
 await t.test('oversized A/B context holds quality before any call intent or B lease',async()=>{
  const f=await fixture('context-overcap',undefined,undefined,item=>{item.question='x'.repeat(22000);});let called=false;
  const A=await f.run(f.AJobKey,f.handlers(async input=>{called=true;return answer(input);}));
  const broker=new DistrictAssessmentBroker(pool,f.cas,{policyOptions:f.policy,fixtureProtocol:true});
  const B=await f.run(f.BJobKey,{assessment_b:assessmentBJobHandler(broker)});
  assert.equal(A.reasonCode,'assessment_context_exceeded');assert.equal(B.reasonCode,'assessment_context_exceeded');assert.equal(called,false);
  const jobs=await pool.query('SELECT state,reason_code FROM district_pipeline.jobs WHERE job_key=ANY($1::text[])',[[f.AJobKey,f.BJobKey]]);
  assert.ok(jobs.rows.every(row=>row.state==='held_quality'&&row.reason_code==='assessment_context_exceeded'));
  const intents=await pool.query('SELECT count(*) FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=$1',[f.source.originalSha256]);assert.equal(Number(intents.rows[0].count),0);
  const leases=await pool.query('SELECT count(*) FROM district_pipeline.assessment_bridge_leases b JOIN district_pipeline.jobs j ON j.id=b.job_id WHERE j.job_key=$1',[f.BJobKey]);assert.equal(Number(leases.rows[0].count),0);
 });
 await t.test('stale successful preparation keys refuse both passes before creating jobs',async()=>{
  const f=await fixture('stale-preparation'),row=(await pool.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[f.preparationKey])).rows[0];
  const bundle=await f.put({version:'r1-assessment-items-v1',items:[{itemArtifactSha256:(await f.put(f.item)).sha256,recordArtifactSha256:(await f.put(f.record)).sha256,maxModelCalls:48}]});
  const oldKey=await f.store.enqueue({...row.spec,semanticContractSha256:digest('synthetic pre-cutover assessment contract')});
  await f.run(oldKey,{assessment_prepare:async()=>({outcome:'succeeded',reasonCode:'completed',outputs:[await f.put(f.item),await f.put(f.record),bundle]})});
  const before=(await pool.query("SELECT count(*) FROM district_pipeline.jobs WHERE step IN ('assessment_a','assessment_b')")).rows[0].count;
  const broker=new DistrictAssessmentBroker(pool,f.cas,{policyOptions:f.policy,fixtureProtocol:true});
  for(const role of ['A','B'] as const)await assert.rejects(enqueuePreparedAssessmentPass(pool,f.store,f.cas,oldKey,role,broker),AssessmentContextHold);
  assert.equal((await pool.query("SELECT count(*) FROM district_pipeline.jobs WHERE step IN ('assessment_a','assessment_b')")).rows[0].count,before);
 });
 await t.test('current-contract residual execution refuses small legacy context-free items without calls or leases',async()=>{
  const f=await fixture('legacy-item'),legacy=structuredClone(f.item);delete legacy.sources[0].assessmentContext;
  assert.ok(Buffer.byteLength(canonicalJson(legacy))<22000);
  const itemHash=(await f.put(legacy)).sha256,broker=new DistrictAssessmentBroker(pool,f.cas,{policyOptions:f.policy,fixtureProtocol:true});let called=false;
  for(const [key,step] of [[f.AJobKey,'assessment_a'],[f.BJobKey,'assessment_b']] as const){
   const spec=(await pool.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[key])).rows[0].spec,oldHash=spec.selector.itemArtifactSha256;
   const next=await f.store.enqueue({...spec,selector:{...spec.selector,itemArtifactSha256:itemHash},inputArtifactHashes:spec.inputArtifactHashes.map((hash:string)=>hash===oldHash?itemHash:hash)},{dependencies:(spec.selector.predecessors??[]).map((pin:{jobKey:string;receiptSha256:string})=>({jobKey:pin.jobKey,expectedReceiptSha256:pin.receiptSha256}))});
   const handlers=step==='assessment_a'?f.handlers(async input=>{called=true;return answer(input);}):{assessment_b:assessmentBJobHandler(broker)};
   const result=await f.run(next,handlers);assert.equal(result.reasonCode,'quality_failed');
   assert.equal((await pool.query('SELECT state FROM district_pipeline.jobs WHERE job_key=$1',[next])).rows[0].state,'held_quality');
  }
  assert.equal(called,false);
  assert.equal(Number((await pool.query('SELECT count(*) FROM district_pipeline.r1_codex_call_intents WHERE original_sha256=$1',[f.source.originalSha256])).rows[0].count),0);
  assert.equal(Number((await pool.query("SELECT count(*) FROM district_pipeline.assessment_bridge_leases b JOIN district_pipeline.jobs j ON j.id=b.job_id WHERE j.source_id=$1 AND j.spec->>'policyProofSha256'=$2",[f.proof.scope.sourceId,f.policyArtifact.sha256])).rows[0].count),0);
 });
 await t.test('prepared-text item factory binds actual UTF-16 spans and never imports model constraints',async()=>{
  const f=await fixture('factory'),text=(await f.cas.read(f.source.textSha256)).toString('utf8');
  const prepared:PreparedDocument={version:'district-prepared-v2',municipalityId:'strausberg',sourceSha256:f.source.originalSha256,sourceBytes:Buffer.byteLength(text),mimeType:'text/plain',references:f.record.sources,extractorSha256:digest('synthetic parser'),toolVersions:{fixture:'synthetic'},text,textSha256:f.source.textSha256,offsetUnit:'utf16_code_units',textLength:text.length,method:'text',ocrUsed:false,limitations:[],receiptSha256:digest('synthetic prepared receipt')};
  const item=residualAssessmentItem(f.record,prepared,digest('synthetic prepared artifact'),f.policyArtifact.sha256);assert.deepEqual(item.constraints,[]);assert.equal(item.sources[0].textSha256,prepared.textSha256);for(const locator of item.sources[0].locators)assert.ok(text.slice(locator.start,locator.end));
  await assert.rejects(registerR1CodexDocument(pool,'strausberg',f.source.originalSha256,49));
 });
 await t.test('critical finalization binds the complete private record with canonical preparation',async()=>{
  const text='Strausberg hat den Plan als Satzung beschlossen. Synthetic '+randomUUID(),f=await fixture('critical-factory',text);
  f.record.stage='adopted';f.record.stageQuote=text;f.record.originalStatus='als Satzung beschlossen';f.record.verification.evidenceHash=knowledgeEvidenceHash(f.record);
  const prepared:PreparedDocument={version:'district-prepared-v2',municipalityId:'strausberg',sourceSha256:f.source.originalSha256,sourceBytes:Buffer.byteLength(text),mimeType:'text/plain',references:f.record.sources,extractorSha256:digest('synthetic parser'),toolVersions:{fixture:'synthetic'},text,textSha256:f.source.textSha256,offsetUnit:'utf16_code_units',textLength:text.length,method:'text',ocrUsed:false,limitations:[],receiptSha256:digest('synthetic prepared receipt')};
  const item=residualAssessmentItem(f.record,prepared,digest('synthetic prepared artifact'),f.policyArtifact.sha256);
  assert.equal(item.criticalTarget?.recordId,f.record.id);assert.ok(item.criticalKinds.includes('stage'));assert.deepEqual(item.constraints,[]);
  assert.equal(item.criticalTarget?.recordEvidenceSha256,f.record.verification.evidenceHash);
 });
 await t.test('500 cumulative selected originals is not renewed by another stage',async()=>{
  const count=await pool.query('SELECT count(*) FROM district_pipeline.r1_codex_selections'),existing=Number(count.rows[0].count);
  for(let i=existing;i<500;i++)await registerR1CodexDocument(pool,'strausberg',digest('synthetic document-selection '+i),48);
  await assert.rejects(registerR1CodexDocument(pool,'strausberg',digest('synthetic overflow original'),48),{message:'source_limit_exceeded'});
  await registerR1CodexDocument(pool,'strausberg',digest('synthetic document-selection 499'),24);
  const after=await pool.query('SELECT count(*) FROM district_pipeline.r1_codex_selections');assert.equal(Number(after.rows[0].count),500);
 });
});
