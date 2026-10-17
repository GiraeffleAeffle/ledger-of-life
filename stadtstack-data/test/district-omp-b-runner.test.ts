import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,chmod,rm,readFile,mkdir,lstat} from 'node:fs/promises';
import {promises as fsPromises,type Stats} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,type ChildProcess,type SpawnOptions} from 'node:child_process';
import {inspectOmpEvents as inspectBoundOmpEvents,inspectOmpAssessmentCompletion,resolveOmpCredential,ompAssessmentControl,ompRunnerContractSha256,ompAssessmentScratchRoot,OMP_RUNNER_VERSION,OMP_NATIVE_STREAM_VERSION,OMP_VERSION,OMP_HOST_VERSION,OMP_HOST_BINARY,OmpReviewSchema,OmpRunnerHold,OmpAssessmentOutputRejected,OmpOutputRejectionSchema,ompOutputRejectionFromVersions,ompOutputRejectionVersions,OmpNativeCleanupSchema} from '../src/district-omp-b-runner.ts';
import {OMP_CONTAINER_ENVIRONMENT,OMP_EXECUTION_ARGS,OMP_PROCESS} from '../src/district-execution-profile.ts';
import {semanticHash,digest,canonicalJson} from '../src/district-adapter-contract.ts';
import {NativeAssessmentBEnqueueManifestSchema as AssessmentBEnqueueManifestSchema} from '../src/district-r1-assessment-cli.ts';
import {assessmentOutputSchema,assessmentItemSchema,deterministicChecks,PROMPTS,digest as assessmentDigest,type OriginalEvidence} from '../src/district-assessment.ts';
import {z} from 'zod';
import {withManagedSourceScratch,withManagedSourceWrite,initializeManagedAcquisitionLane,assertManagedSourceReadable,readCivicPolicyInventory,CivicPolicyStateError} from '../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {assessmentBridgeHoldReason,assessmentBridgeFailureVersions} from '../src/district-assessment-broker.ts';
import {DistrictExecutionHold} from '../src/district-jobs.ts';
import {ReasonCodeSchema,StepReceiptSchema} from '../src/district-step-receipt.ts';
import {OmpFailureKindSchema,OmpDecodeCheckSchema} from '../src/district-exception-diagnostics.ts';

const syntheticDelivery={requestSha256:digest('Synthetic native request'),systemPromptSha256:ompAssessmentControl().systemPromptSha256,stdin:{intendedBytes:24,deliveredBytes:24,deliveredSha256:digest('Synthetic native request'),frameBytes:49}};
const inspectOmpEvents=(stdout:string,exitCode:number)=>inspectBoundOmpEvents(stdout,exitCode,syntheticDelivery);
const answer={itemId:'synthetic',outcome:'supported',assertions:[],scores:{correctness:1,sources:1,usefulness:1},holdReasons:[],rationale:'synthetic',valueReview:null};
function message(overrides:Record<string,unknown>={}){return {responseId:'msg-one',timestamp:1791800000000,role:'assistant',provider:'anthropic',api:'anthropic-messages',model:'claude-sonnet-5-5',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}],usage:{input:7,output:3,cacheRead:5,cacheWrite:2,totalTokens:17,cost:{input:0.01,output:0.02,cacheRead:0.03,cacheWrite:0.04,total:0.1}},...overrides};}
function eventStream(events:Record<string,unknown>[]=[{type:'message_end',message:message()}]){
 const final=events.find(event=>event.type==='message_end'&&(event.message as {role?:string})?.role==='assistant')?.message;
 const suffix:Record<string,unknown>[]=[];
 if(final&&!events.some(event=>event.type==='turn_end'))suffix.push({type:'turn_end',message:final,toolResults:[],reason:'stop'});
 if(final&&!events.some(event=>event.type==='agent_end'))suffix.push({type:'agent_end',messages:[final],reason:'stop'});
 return [{type:'session',id:'session-one'},{type:'agent_start'},{type:'turn_start'},{type:'message_start',message:{role:'assistant'}},...events,...suffix].map(event=>JSON.stringify(event)).join('\n')+'\n';
}

function nativeEvents(text=JSON.stringify(answer),thoughts=['PRIVATE_THINKING_CONTENT']):Record<string,unknown>[]{
 const events:Record<string,unknown>[]=[{type:'message_update',assistantMessageEvent:{type:'start'}}],content:Record<string,unknown>[]=[];
 for(const [contentIndex,thinking] of thoughts.entries()){
  content.push({type:'thinking',thinking,thinkingSignature:'PRIVATE_THINKING_SIGNATURE',summary:true});
  for(const update of [{type:'thinking_start',contentIndex},{type:'thinking_delta',contentIndex,delta:thinking},{type:'thinking_end',contentIndex,content:thinking}])events.push({type:'message_update',assistantMessageEvent:update});
 }
 const contentIndex=content.length;content.push({type:'text',text});
 for(const update of [{type:'text_start',contentIndex},{type:'text_delta',contentIndex,delta:text},{type:'text_end',contentIndex,content:text},{type:'done',reason:'stop'}])events.push({type:'message_update',assistantMessageEvent:update});
 events.push({type:'message_end',message:message({content})});return events;
}
const inspectNative=(stdout:string)=>inspectBoundOmpEvents(stdout,0,syntheticDelivery,'claude-sonnet-5-5',OMP_NATIVE_STREAM_VERSION);

test('native stream v2 authenticates thinking before one final text without projecting thinking into the answer',()=>{
 for(const thoughts of [[],['PRIVATE_THINKING_CONTENT'],['PRIVATE_THINKING_ONE','PRIVATE_THINKING_TWO']]){
  const events=nativeEvents(JSON.stringify(answer),thoughts),stdout=eventStream(events),parsed=inspectNative(stdout);
  assert.deepEqual(parsed.value,assessmentOutputSchema.parse(answer));assert.doesNotMatch(JSON.stringify(parsed),/PRIVATE_THINKING/);
  const finalLine=stdout.split('\n').find(line=>JSON.parse(line||'{}').type==='message_end')!;
  assert.equal(parsed.responseSha256,digest(finalLine),'hash authenticates the original message, including thinking and signature');
  assert.deepEqual(inspectOmpAssessmentCompletion(stdout,'',0,syntheticDelivery,'2026-10-17T14:00:00Z','0444'),parsed);
 }
 assert.throws(()=>inspectOmpEvents(eventStream(nativeEvents()),0),error=>error instanceof OmpRunnerHold&&error.decodeCheck==='text_update_schema','v1 history remains text-only');
});

test('native thinking deltas are ignored while provider-finalized thinking_end still binds the final block',()=>{
 const events=nativeEvents(),delta=events.find(event=>objectUpdate(event).type==='thinking_delta')!;
 objectUpdate(delta).delta='<think>PRIVATE_THINKING_CONTENT</think>';
 const parsed=inspectNative(eventStream(events));assert.deepEqual(parsed.value,assessmentOutputSchema.parse(answer));assert.doesNotMatch(JSON.stringify(parsed),/PRIVATE_THINKING/);
});

test('a usage stop after thinking stays typed and cannot certify a no-output retry',()=>{
 const observedAt='2026-10-17T14:00:00Z',failure=message({stopReason:'error',content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}},errorMessage:'429 '+JSON.stringify({type:'rate_limit_error',reset_at:'2026-10-17T15:00:00Z'})});
 for(const thinking of [false,true]){
  const prefix=thinking?nativeEvents().filter(event=>String(objectUpdate(event).type).startsWith('thinking_')):[];
  const stdout=eventStream([...prefix,{type:'message_end',message:failure},{type:'turn_end',message:failure,toolResults:[],reason:'error'},{type:'agent_end',messages:[failure],reason:'error'}]);
  assert.throws(()=>inspectOmpAssessmentCompletion(stdout,'',0,syntheticDelivery,observedAt,'0444'),error=>{
   assert.ok(error instanceof OmpRunnerHold);assert.ok(error.subscriptionLimit);assert.equal(error.noOutput,!thinking);
   assert.equal(assessmentBridgeHoldReason(error),'budget_paused');assert.doesNotMatch(JSON.stringify(assessmentBridgeFailureVersions('synthetic',error)),/PRIVATE_THINKING/);return true;
  });
 }
});

test('native stream v2 rejects thinking after text, multiple final texts and every other non-text block',()=>{
 const text={type:'text',text:JSON.stringify(answer)},thinking={type:'thinking',thinking:'PRIVATE_THINKING_CONTENT',thinkingSignature:'PRIVATE_THINKING_SIGNATURE'};
 for(const content of [
  [text,thinking],[thinking,text,text],[thinking],[{type:'redactedThinking',data:'PRIVATE_THINKING_CONTENT'},text],
  [{type:'image',data:'PRIVATE_CONTENT'},text],[{type:'toolCall',id:'one',name:'shell',arguments:{}},text],
  [{...thinking,thinking:1},text],[{...thinking,thinkingSignature:1},text],[{...thinking,PRIVATE_FIELD:true},text],
 ]){
  assert.throws(()=>inspectNative(eventStream([{type:'message_end',message:message({content})}])),error=>error instanceof OmpRunnerHold&&!(error instanceof OmpAssessmentOutputRejected));
 }
 const events=nativeEvents(),afterText=events.findIndex(event=>objectUpdate(event).type==='text_end')+1;
 events.splice(afterText,0,{type:'message_update',assistantMessageEvent:{type:'thinking_start',contentIndex:2}});
 assert.throws(()=>inspectNative(eventStream(events)),error=>error instanceof OmpRunnerHold&&error.decodeCheck==='text_update_order');
});

function objectUpdate(event:Record<string,unknown>):Record<string,unknown>{return (event.assistantMessageEvent??{}) as Record<string,unknown>;}
test('native stream v2 requires ordered typed thinking updates and one closed content block at a time',()=>{
 const mutations:Array<(events:Record<string,unknown>[])=>void>=[
  events=>{events.splice(1,1);},
  events=>{events.splice(3,1);},
  events=>{objectUpdate(events[1]!).contentIndex=1;},
  events=>{objectUpdate(events[2]!).delta=7;},
  events=>{objectUpdate(events[3]!).content='PRIVATE_DIFFERENT_CONTENT';},
  events=>{events.splice(2,0,{type:'message_update',assistantMessageEvent:{type:'thinking_start',contentIndex:1}});},
  events=>{events.splice(2,0,{type:'message_update',assistantMessageEvent:{type:'thinking_signature',contentIndex:0,signature:'PRIVATE_SIGNATURE'}});},
  events=>{objectUpdate(events[1]!).PRIVATE_FIELD=true;},
  events=>{objectUpdate(events[1]!).contentIndex=-1;},
 ];
 for(const mutate of mutations){
  const events=nativeEvents();mutate(events);
  assert.throws(()=>inspectNative(eventStream(events)),error=>error instanceof OmpRunnerHold&&!(error instanceof OmpAssessmentOutputRejected));
 }
 for(const assistantMessageEvent of [{type:'toolcall_start',contentIndex:0},{type:'image_end',contentIndex:0,content:{}},{type:'unknown'}]){
  assert.throws(()=>inspectNative(eventStream([{type:'message_update',assistantMessageEvent},{type:'message_end',message:message()}])));
 }
});

test('native stream v2 compares unstripped thinking and signatures across all response copies',()=>{
 const events=nativeEvents(),original=events[events.length-1]!.message as ReturnType<typeof message>,final={...original,completedAt:1791800000100};
 for(const field of ['thinking','thinkingSignature']){
  const content=structuredClone(original.content) as Array<Record<string,unknown>>;content[0]![field]='PRIVATE_DIFFERENT_CONTENT';
  const stdout=eventStream([...events.slice(0,-1),{type:'message_end',message:final},{type:'turn_end',message:{...original,content},toolResults:[]}]);
  assert.throws(()=>inspectNative(stdout),error=>error instanceof OmpRunnerHold&&error.decodeCheck==='assistant_copy_mismatch');
 }
});

test('native stream v2 retains strict bare-object framing and emits content-free v4 rejection proofs',()=>{
 for(const text of ['PRIVATE_LEADING_PROSE\n'+JSON.stringify(answer),'```json\n'+JSON.stringify(answer)+'\n```','PRIVATE_INVALID_JSON',JSON.stringify({...answer,scores:{correctness:'PRIVATE_VALUE',sources:1,usefulness:1}})]){
  const stdout=eventStream(nativeEvents(text));let rejected:OmpAssessmentOutputRejected|undefined;
  assert.throws(()=>inspectNative(stdout),error=>{assert.ok(error instanceof OmpAssessmentOutputRejected);rejected=error;return true;});
  assert.ok(rejected);assert.equal(rejected.rejection.version,'omp-output-rejection-v4');
  const proof=rejected.rejection;assert.ok(proof.version==='omp-output-rejection-v4');
  assert.equal(proof.streamVersion,OMP_NATIVE_STREAM_VERSION);assert.equal(proof.streamSha256,digest(stdout));assert.equal(proof.outputSha256,digest(text));
  const versions=ompOutputRejectionVersions(proof);
  assert.equal(versions.ompNativeStreamVersion,OMP_NATIVE_STREAM_VERSION);assert.equal(versions.ompOutputNormalization,undefined);
  assert.doesNotMatch(JSON.stringify(proof)+JSON.stringify(versions),/PRIVATE_|thinkingSignature/);
  assert.deepEqual(ompOutputRejectionFromVersions(versions),proof);StepReceiptSchema.shape.versions.parse(versions);
  assert.equal(ompOutputRejectionFromVersions({...versions,ompNativeStreamVersion:'omp-native-stream-v1'}),null);
  assert.equal(ompOutputRejectionFromVersions({...versions,ompOutputNormalization:'single-json-fence-v1'}),null);
  const historical=ompOutputRejectionFromVersions({...versions,ompOutputRejectionVersion:'omp-output-rejection-v3'});
  assert.notEqual(digest(canonicalJson(historical)),digest(canonicalJson(proof)),'changing the version changes the artifact identity authenticated by the broker');
 }
});

test('immutable v2 proofs keep their exact framed-text normalization after the native stream cutover',()=>{
 const legacy={version:'omp-output-rejection-v2' as const,check:'output_schema' as const,streamSha256:digest('Synthetic v2 stream'),outputSha256:digest('Synthetic v2 text'),issueCount:1,issues:[{code:'unrecognized_keys' as const,path:'$',keyCount:1}],outputNormalization:'single-json-fence-v1' as const};
 const before=canonicalJson(legacy),versions=ompOutputRejectionVersions(legacy),decoded=ompOutputRejectionFromVersions(versions);
 assert.equal(canonicalJson(decoded),before);assert.equal(digest(canonicalJson(decoded)),digest(before));assert.equal(versions.ompNativeStreamVersion,undefined);
});

test('omp event inspection accepts a completed text-only message and repeated copies',()=>{
 const original=message(),final={...original,completedAt:1791800000100};
 const inspected=inspectOmpEvents(eventStream([{type:'message_end',message:final},{type:'turn_end',message:original,toolResults:[],reason:'stop'},{type:'agent_end',messages:[original],reason:'stop'}]),0);
 assert.equal(inspected.returnedModel,'claude-sonnet-5-5');assert.deepEqual(inspected.usage.topLevel,{inputTokens:7,outputTokens:3,cacheReadTokens:5,cacheCreationTokens:2});
 assert.equal(inspected.usage.cliEstimatedApiCostUsd,0.1);
 assert.equal(inspected.usage.perModel['claude-sonnet-5-5']!.cliEstimatedApiCostUsd,0.1);
});
test('native decoder never falls back to Haiku; retained Haiku streams require explicit history dispatch',()=>{
 const stream=eventStream([{type:'message_end',message:message({model:'claude-haiku-5-5'})}]);
 assert.throws(()=>inspectOmpEvents(stream,0),{reason:'model_identity_mismatch'});
 assert.equal(inspectBoundOmpEvents(stream,0,syntheticDelivery,'claude-haiku-5-5').returnedModel,'claude-haiku-5-5');
});
test('native cleanup acknowledgement requires complete typed absence evidence and never accepts Mac denial claims',()=>{
 const cleanup={version:'omp-native-cleanup-v1',requestSha256:digest('request'),responseSha256:digest('response'),runnerContractSha256:digest('runner'),imageId:'sha256:'+digest('image'),scratchId:'00000000-0000-4000-8000-000000000001',containerId:digest('container'),containerRemoved:true,managedScratchClosed:true,completedAt:'2026-10-16T12:00:00.000Z'};
 assert.deepEqual(OmpNativeCleanupSchema.parse(cleanup),cleanup);
 for(const changed of [{containerRemoved:false},{managedScratchClosed:false},{containerId:'unknown'},{scratchId:'unknown'},{completedAt:null},{modelFileWritesDenied:true}])assert.equal(OmpNativeCleanupSchema.safeParse({...cleanup,...changed}).success,false);
 for(const key of Object.keys(cleanup)){const missing={...cleanup} as Record<string,unknown>;delete missing[key];assert.equal(OmpNativeCleanupSchema.safeParse(missing).success,false,key);}
});

test('observed omp 18.9.2 envelope permits its user message, strict text updates and completedAt-only enrichment',()=>{
 // Field shapes observed in the one authorized source-free diagnostic; all
 // values below are invented fixtures, not recorded model output.
 const text=JSON.stringify(answer),original=message({duration:10,ttft:1,requestControls:{fixture:true}});
 const user={role:'user',content:[{type:'text',text:'Synthetic diagnostic fixture only.'}]};
 const events=[{type:'session'},{type:'agent_start'},{type:'turn_start'},
  {type:'message_start',message:user},{type:'message_end',message:user},
  {type:'message_start',message:{role:'assistant',content:[]}},
  {type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}},
  {type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:text}},
  {type:'message_update',assistantMessageEvent:{type:'text_end',contentIndex:0,content:text}},
  {type:'message_end',message:{...original,completedAt:1791800000100}},
  {type:'turn_end',message:original,toolResults:[]},{type:'agent_end',messages:[user,original]}];
 assert.deepEqual(inspectOmpEvents(events.map(event=>JSON.stringify(event)).join('\n')+'\n',0).value,answer);
});

test('omp event inspection rejects tool use, terminal failures, wrong route, extra messages, malformed and incomplete streams',()=>{
 const invalid=[
  eventStream([{type:'tool_call',toolName:'shell'}]),
  eventStream([{type:'message_end',message:message({stopReason:'toolUse'})}]),
  eventStream([{type:'message_end',message:message({stopReason:'length'})}]),
  eventStream([{type:'error',message:'failed'}]),
  eventStream([{type:'aborted'}]),
  eventStream([{type:'message_end',message:message({model:'claude-sonnet-4'})}]),
  eventStream([{type:'message_end',message:message({provider:'openai'})}]),
  eventStream([{type:'message_end',message:message({api:'anthropic-completions'})}]),
  eventStream([{type:'message_end',message:message({upstreamModel:'claude-sonnet-4'})}]),
  eventStream([{type:'message_end',message:message()},{type:'message_end',message:message({responseId:'msg-two'})}]),
  '{bad json}\n',
  eventStream([]),
 ];
 for(const stdout of invalid)assert.throws(()=>inspectOmpEvents(stdout,0));
 assert.throws(()=>inspectOmpEvents(eventStream(),1));
});

test('native B failures distinguish exit, assistant stop, stream, turn and agent paths',()=>{
 const cases=[
  [eventStream(),1,'exit_nonzero'],
  [eventStream([{type:'message_end',message:message({stopReason:'length'})}]),0,'stop_length'],
  [eventStream([{type:'message_end',message:message({stopReason:'error'})}]),0,'stop_error'],
  [eventStream([{type:'message_end',message:message({stopReason:'aborted'})}]),0,'stop_other'],
  [eventStream([{type:'message_end',message:message({stopReason:'toolUse'})}]),0,'stop_other'],
  [eventStream([{type:'message_update',assistantMessageEvent:{type:'error',reason:'error'}}]),0,'stream_update_error'],
  [eventStream([{type:'message_update',assistantMessageEvent:{type:'done',reason:'length'}}]),0,'stop_length'],
  [eventStream([{type:'turn_end',reason:'error'}]),0,'turn_reason'],
  [eventStream([{type:'agent_end',reason:'aborted'}]),0,'agent_reason'],
 ] as const;
 for(const [stdout,exit,kind] of cases)assert.throws(()=>inspectOmpEvents(stdout,exit),(error:unknown)=>error instanceof OmpRunnerHold&&error.reason==='provider_failed'&&error.failureKind===kind,kind);
 assert.equal(new OmpRunnerHold('provider_failed').failureKind,'exception_other');
 assert.equal(new OmpRunnerHold('resource_limit').failureKind,undefined);
});

test('typed provider HTTP status survives stripped update errors and abnormal CLI exits',()=>{
 const cases=[[400,'invalid_request'],[401,'auth'],[403,'auth'],[404,'not_found'],[408,'network'],[413,'invalid_request'],[422,'invalid_request'],[429,'rate_limit'],[500,'server'],[503,'server'],[529,'overloaded']] as const;
 for(const [status,category] of cases)for(const exitCode of [0,1]){
  const failed=message({stopReason:'error',content:[],errorStatus:status,errorMessage:'PRIVATE_PROVIDER_MESSAGE sk-ant-oat-synthetic'});
  // Exact stock printableEvent shape: update/error strips its error object;
  // message_end and the later logical copies retain errorStatus/errorId.
  const stdout=eventStream([{type:'message_update',assistantMessageEvent:{type:'error',reason:'error'}},{type:'message_end',message:failed},{type:'turn_end',message:failed,toolResults:[]},{type:'agent_end',messages:[failed]}]);
  assert.throws(()=>inspectOmpEvents(stdout,exitCode),(error:unknown)=>{
   assert.ok(error instanceof OmpRunnerHold);assert.equal(error.reason,'provider_failed');assert.equal(error.failureKind,'provider_error_'+category);
   assert.equal(error.subscriptionLimit,undefined,'A diagnostic 429 never grants a usage hold or retry');
   assert.doesNotMatch(JSON.stringify(error),/PRIVATE_PROVIDER_MESSAGE|sk-ant-oat/);return true;
  });
 }
});

test('typed provider fields and pinned flag IDs produce only the closed diagnostic vocabulary',()=>{
 const cases=[
  [{errorType:'authentication_error'},'auth'],[{error:{type:'permission_error'}},'auth'],
  [{error:{type:'rate_limit_error'}},'rate_limit'],[{error:{type:'overloaded_error'}},'overloaded'],
  [{error:{type:'invalid_request_error'}},'invalid_request'],[{error:{type:'not_found_error'}},'not_found'],
  [{error:{type:'api_error'}},'server'],[{error:{type:'network_error'}},'network'],
  [{error:{code:'ECONNRESET'}},'network'],[{errorId:0x01001000},'auth'],[{errorId:0x40001000},'auth'],
  [{errorId:0x00081000},'rate_limit'],[{errorId:0x00041000},'network'],
  [{errorId:0x00021000},'unknown'],[{errorType:'PRIVATE_UNKNOWN_TYPE'},'unknown'],
 ] as const;
 for(const [fields,category] of cases){
  const stdout=eventStream([{type:'message_end',message:message({stopReason:'error',content:[],...fields})}]);
  assert.throws(()=>inspectOmpEvents(stdout,0),(error:unknown)=>error instanceof OmpRunnerHold&&error.failureKind==='provider_error_'+category);
 }
 const late=message({stopReason:'error',content:[],errorStatus:401});
 assert.throws(()=>inspectOmpEvents(eventStream([{type:'message_update',assistantMessageEvent:{type:'error',error:{errorId:0x1000}}},{type:'agent_end',messages:[late]}]),0),(error:unknown)=>error instanceof OmpRunnerHold&&error.failureKind==='provider_error_auth','Later typed status refines an unknown typed update');
});

test('provider diagnostics never scrape prose, source text, malformed frames or an unbounded stream',()=>{
 for(const privateText of ['401 authentication_error','429 rate_limit_error','529 overloaded_error','ECONNRESET network_error']){
  const stdout=eventStream([{type:'message_end',message:message({stopReason:'error',errorMessage:privateText,content:[{type:'text',text:JSON.stringify({errorStatus:401,errorType:'authentication_error'})}]})}]);
  assert.throws(()=>inspectOmpEvents(stdout,0),(error:unknown)=>error instanceof OmpRunnerHold&&error.failureKind==='stop_error');
 }
 const typed=eventStream([{type:'message_end',message:message({stopReason:'error',errorStatus:401})}]);
 for(const stdout of [typed.slice(0,-1),typed+'{broken}\n',typed+'x'.repeat(2*1024*1024)+'\n',typed.replace('\"session\"','\"not_session\"')]){
  assert.throws(()=>inspectOmpEvents(stdout,1),(error:unknown)=>error instanceof OmpRunnerHold&&error.failureKind==='exit_nonzero');
 }
 assert.throws(()=>inspectOmpEvents(eventStream([{type:'message_end',message:message({errorStatus:401})}]),1),(error:unknown)=>error instanceof OmpRunnerHold&&error.failureKind==='exit_nonzero','Successful assistant content cannot smuggle a provider failure label');
});

test('B failure projection preserves all closed kinds without retaining messages or forged labels',()=>{
 for(const kind of OmpFailureKindSchema.options){
  const error=new OmpRunnerHold('provider_failed',undefined,kind);
  error.message='PRIVATE_PROVIDER_MESSAGE sk-ant-oat-synthetic';
  assert.equal(assessmentBridgeHoldReason(error),'omp_provider_failed');
  assert.deepEqual(assessmentBridgeFailureVersions('synthetic-lease',error),{ompFailureKind:kind});
 }
 const forged=new OmpRunnerHold('provider_failed');
 Object.assign(forged,{failureKind:'PRIVATE_KIND\\nR1_B_FAILURE job=private'});
 assert.deepEqual(assessmentBridgeFailureVersions('synthetic-lease',forged),{});
 assert.deepEqual(assessmentBridgeFailureVersions('synthetic-lease',Error('PRIVATE_ERROR')),{});
});

test('actual completion exit codes survive decoder holds and the closed broker projection',()=>{
 for(const exit of [0,1,126,127,137,255]){
  const stdout=exit===0?eventStream([{type:'message_end',message:message({stopReason:'error',content:[],errorStatus:401})}]):'';
  assert.throws(()=>inspectOmpEvents(stdout,exit),(error:unknown)=>{
   assert.ok(error instanceof OmpRunnerHold);assert.equal(error.containerExitCode,exit);
   assert.equal(assessmentBridgeFailureVersions('synthetic-lease',error).ompContainerExitCode,String(exit));return true;
  });
 }
 assert.equal(new OmpRunnerHold('provider_failed').containerExitCode,undefined,'No fabricated exit code without completion');
 for(const exit of [-1,256,1.5,NaN,Infinity]){
  const error=new OmpRunnerHold('provider_failed',undefined,'exit_nonzero',exit);
  assert.equal(error.containerExitCode,undefined);
  Object.assign(error,{containerExitCode:exit});
  assert.equal(assessmentBridgeFailureVersions('synthetic-lease',error).ompContainerExitCode,undefined);
 }
});

test('text updates must agree with each other and every final block before a rejection can settle',()=>{
 const text=JSON.stringify(answer);
 const updates:Record<string,unknown>[]=[
  {type:'text_start',contentIndex:0},
  {type:'text_delta',contentIndex:0,delta:text.slice(0,17)},
  {type:'text_delta',contentIndex:0,delta:text.slice(17)},
  {type:'text_end',contentIndex:0,content:text},
 ];
 function assertAmbiguous(events:Record<string,unknown>[],finalTexts:string[],check='text_update_mismatch'){
  const stdout=eventStream([...events.map(assistantMessageEvent=>({type:'message_update',assistantMessageEvent})),{type:'message_end',message:message({content:finalTexts.map(text=>({type:'text',text}))})}]);
  assert.throws(()=>inspectOmpEvents(stdout,0),(error:unknown)=>{
   assert.ok(error instanceof OmpRunnerHold);assert.equal(error instanceof OmpAssessmentOutputRejected,false);
   assert.equal(error.reason,'event_stream');assert.equal(error.decodeCheck,check);
   assert.equal(assessmentBridgeHoldReason(error),'omp_event_stream');
   const versions=assessmentBridgeFailureVersions('synthetic-lease',error);
   assert.equal(versions.ompDecodeCheck,check);assert.equal(ompOutputRejectionFromVersions(versions),null);
   return true;
  });
 }
 // All three final copies agree, but contradict the valid JSON emitted earlier.
 for(const finalText of ['{','{}'])assertAmbiguous(updates,[finalText]);
 assertAmbiguous([...updates.slice(0,-1),{type:'text_end',contentIndex:0,content:'{}'}],[text]);
 assertAmbiguous(updates.slice(0,-1),[text],'text_update_order');
 assertAmbiguous([updates[1]!],[text],'text_update_order');
 assertAmbiguous([updates[3]!],[text],'text_update_order');
 assertAmbiguous([updates[0]!,updates[0]!],[text],'text_update_order');
 assertAmbiguous([...updates,updates[1]!],[text],'text_update_order');
 assertAmbiguous([...updates,updates[3]!],[text],'text_update_order');
 assertAmbiguous(updates.map(update=>({...update,contentIndex:1})),[text]);
 assertAmbiguous(updates,[text,'']);
 // Equal concatenated text does not excuse inconsistent block boundaries.
 const split=17,blocks=[text.slice(0,split),text.slice(split)];
 const blockUpdates=blocks.flatMap((content,contentIndex)=>[
  {type:'text_start',contentIndex},{type:'text_delta',contentIndex,delta:content},{type:'text_end',contentIndex,content},
 ]);
 assertAmbiguous(blockUpdates,[text.slice(0,split+1),text.slice(split+1)]);
});

test('consistent streamed blocks accept valid output and settle only genuinely invalid final output',()=>{
 for(const text of [JSON.stringify(answer),'{','{}']){
  const blocks=[text.slice(0,1),text.slice(1)],updates=blocks.flatMap((content,contentIndex)=>[
   {type:'text_start',contentIndex},
   {type:'text_delta',contentIndex,delta:content.slice(0,1)},
   {type:'text_delta',contentIndex,delta:content.slice(1)},
   {type:'text_end',contentIndex,content},
  ]);
  const stdout=eventStream([...updates.map(assistantMessageEvent=>({type:'message_update',assistantMessageEvent})),{type:'message_end',message:message({content:blocks.map(text=>({type:'text',text}))})}]);
  if(text===JSON.stringify(answer))assert.deepEqual(inspectOmpEvents(stdout,0).value,answer);
  else assert.throws(()=>inspectOmpEvents(stdout,0),(error:unknown)=>error instanceof OmpAssessmentOutputRejected&&error.decodeCheck===(text==='{'?'output_json':'output_schema'));
 }
});

test('only one complete lowercase json fence is normalized after raw stream reconciliation',()=>{
 const json=JSON.stringify(answer);
 for(const newline of ['\n','\r\n'])for(const whitespace of ['',' \t\r\n']){
  const text=whitespace+'```json'+newline+json+newline+'```'+whitespace;
  const final=message({content:[{type:'text',text}]}),events=[
   {type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}},
   {type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:text}},
   {type:'message_update',assistantMessageEvent:{type:'text_end',contentIndex:0,content:text}},
   {type:'message_end',message:final},
  ];
  const inspected=inspectOmpEvents(eventStream(events),0);
  assert.deepEqual(inspected.value,answer);assert.equal(inspected.outputNormalization,'single-json-fence-v1');
  assert.equal(inspected.responseSha256,digest(JSON.stringify({type:'message_end',message:final})));
  assert.throws(()=>inspectOmpEvents(eventStream([{...events[0]},{...events[1],assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:json}},...events.slice(2)]),0),(error:unknown)=>error instanceof OmpRunnerHold&&!(error instanceof OmpAssessmentOutputRejected)&&error.decodeCheck==='text_update_mismatch');
 }
 assert.equal(inspectOmpEvents(eventStream(),0).outputNormalization,undefined);
 for(const text of [
  'Commentary\n```json\n'+json+'\n```','```json\n'+json+'\n```\nCommentary',
  '```\n'+json+'\n```','```JSON\n'+json+'\n```','```json '+json+'\n```',
  '```json\n'+json+'\n```json','```json\n'+json,
  '```json\n'+json+'\n```\n```json\n'+json+'\n```',
  '```json\n'+json+'\n````',
 ]){
  assert.throws(()=>inspectOmpEvents(eventStream([{type:'message_end',message:message({content:[{type:'text',text}]})}]),0),(error:unknown)=>{
   assert.ok(error instanceof OmpAssessmentOutputRejected);assert.equal(error.decodeCheck,'output_json');
   assert.equal(error.rejection.version,'omp-output-rejection-v3');
   assert.equal('outputNormalization' in error.rejection,false);return true;
  });
 }
 const multiple='```json\n'+json+'\n'+json+'\n```';
 assert.throws(()=>inspectOmpEvents(eventStream([{type:'message_end',message:message({content:[{type:'text',text:multiple}]})}]),0),(error:unknown)=>{
  assert.ok(error instanceof OmpAssessmentOutputRejected);assert.equal(error.decodeCheck,'output_json');
  assert.ok(error.rejection.version==='omp-output-rejection-v3');
  assert.equal(error.rejection.outputNormalization,'single-json-fence-v1');return true;
 });
});

test('v3 diagnostics retain only schema object paths and unknown-key counts, never names or values',()=>{
 const value={...answer,scores:{...answer.scores,PRIVATE_SCORE:'PRIVATE_VALUE'},PRIVATE_ROOT_ONE:true,PRIVATE_ROOT_TWO:'PRIVATE_VALUE'};
 const text='```json\n'+JSON.stringify(value)+'\n```',stdout=eventStream([{type:'message_end',message:message({content:[{type:'text',text}]})}]);
 assert.throws(()=>inspectOmpEvents(stdout,0),(error:unknown)=>{
  assert.ok(error instanceof OmpAssessmentOutputRejected);const proof=error.rejection;
  assert.ok(proof.version==='omp-output-rejection-v3');assert.equal(proof.check,'output_schema');
  assert.equal(proof.outputNormalization,'single-json-fence-v1');assert.equal(proof.outputSha256,digest(text));assert.equal(proof.streamSha256,digest(stdout));
  assert.deepEqual(proof.issues.filter(issue=>issue.code==='unrecognized_keys'),[{code:'unrecognized_keys',path:'$.scores',keyCount:1},{code:'unrecognized_keys',path:'$',keyCount:2}]);
  const versions=ompOutputRejectionVersions(proof);assert.equal(versions.ompOutputNormalization,'single-json-fence-v1');
  assert.deepEqual(ompOutputRejectionFromVersions(versions),proof);StepReceiptSchema.shape.versions.parse(versions);
  assert.doesNotMatch(JSON.stringify(proof)+JSON.stringify(versions),/PRIVATE_/);
  assert.equal(ompOutputRejectionFromVersions({...versions,ompOutputNormalization:'PRIVATE_FLAG'}),null);
  for(const issue of [{code:'unrecognized_keys',path:'$'},{code:'unrecognized_keys',path:'$',keyCount:0},{code:'unrecognized_keys',path:'$',keyCount:98305},{code:'unrecognized_keys',path:'$.scores.correctness',keyCount:1},{code:'invalid_type',path:'$',keyCount:1}]){
   assert.equal(OmpOutputRejectionSchema.safeParse({...proof,issueCount:1,issues:[issue]}).success,false);
  }
  return true;
 });
});

test('immutable v1 proofs retain exact canonical bytes through explicit version-dispatched reading',()=>{
 const legacy={version:'omp-output-rejection-v1' as const,check:'output_schema' as const,streamSha256:digest('Synthetic historical raw stream'),outputSha256:digest('Synthetic historical raw text'),issueCount:1,issues:[{code:'unrecognized_keys' as const,path:'$'}]};
 const before=canonicalJson(legacy),versions=ompOutputRejectionVersions(legacy),decoded=ompOutputRejectionFromVersions(versions);
 assert.deepEqual(decoded,legacy);assert.equal(canonicalJson(decoded),before);assert.equal(digest(canonicalJson(decoded)),digest(before));
 assert.equal(versions.ompOutputNormalization,undefined);
 assert.equal(ompOutputRejectionFromVersions({...versions,ompOutputRejectionVersion:'omp-output-rejection-v4'}),null);
 assert.equal(OmpOutputRejectionSchema.safeParse({...legacy,outputNormalization:'single-json-fence-v1'}).success,false);
 assert.equal(OmpOutputRejectionSchema.safeParse({...legacy,issues:[{...legacy.issues[0],keyCount:1}]}).success,false);
});

test('settled output rejection requires a complete single-response stream and keeps only closed diagnostics',()=>{
 for(const [text,check] of [['PRIVATE_INVALID_JSON sk-ant-oat-secret','output_json'],[JSON.stringify({...answer,scores:{correctness:'PRIVATE_VALUE',sources:1,usefulness:1},PRIVATE_FIELD:'PRIVATE_VALUE'}),'output_schema']] as const){
  const stdout=eventStream([{type:'message_end',message:message({content:[{type:'text',text}]})}]);
  let rejected:OmpAssessmentOutputRejected|undefined;
  assert.throws(()=>inspectOmpEvents(stdout,0),(error:unknown)=>{assert.ok(error instanceof OmpAssessmentOutputRejected);rejected=error;return true;});
  assert.ok(rejected);assert.equal(rejected.decodeCheck,check);assert.equal(rejected.containerExitCode,0);
  assert.equal(rejected.rejection.version,'omp-output-rejection-v3');
  assert.equal(assessmentBridgeHoldReason(rejected),'quality_failed');OmpOutputRejectionSchema.parse(rejected.rejection);
  const versions=assessmentBridgeFailureVersions('synthetic-lease',rejected);
  assert.equal(versions.ompDecodeCheck,check);assert.doesNotMatch(JSON.stringify(versions),/PRIVATE_|sk-ant-oat/);
  StepReceiptSchema.shape.versions.parse(versions);
  assert.ok(Object.values(versions).every(value=>Buffer.byteLength(value)<=256));
  assert.deepEqual(ompOutputRejectionFromVersions(versions),rejected.rejection);
  assert.equal(ompOutputRejectionFromVersions({...versions,ompOutputIssue0:'{"code":"PRIVATE_PROSE","path":"$"}'}),null);
  assert.equal(ompOutputRejectionFromVersions({...versions,ompOutputIssueCount:'01'}),null);
  assert.equal(ompOutputRejectionFromVersions({...versions,ompOutputIssue32:'{"code":"invalid_type","path":"$"}'}),null);
  assert.equal(rejected.rejection.streamSha256,digest(stdout));assert.equal(rejected.rejection.outputSha256,digest(text));
  if(check==='output_schema')assert.ok(rejected.rejection.issues.some(issue=>issue.path==='$.scores.correctness'));
  const truncated=stdout.split('\n').slice(0,-2).join('\n')+'\n';
  assert.throws(()=>inspectOmpEvents(truncated,0),(error:unknown)=>error instanceof OmpRunnerHold&&!(error instanceof OmpAssessmentOutputRejected)&&error.decodeCheck==='incomplete_lifecycle');
  assert.throws(()=>inspectOmpEvents(stdout,1),(error:unknown)=>error instanceof OmpRunnerHold&&error.reason==='provider_failed');
 }
});

test('framing rejection retains a closed check without promoting ambiguity to quality',()=>{
 const cases:[string,string][]=[
  [eventStream().slice(0,-1),'final_newline'],['','empty_stream'],['\n','event_json'],['null\n','event_envelope'],['{}\n','event_envelope'],['{\"type\":\"wrong\"}\n','session_header'],
  [eventStream([{type:'tool_call'}]),'forbidden_event'],[eventStream([{type:'PRIVATE_EVENT'}]),'unknown_event'],
  ['x'.repeat(2*1024*1024+1)+'\n','stream_size'],
  [eventStream([{type:'message_end',message:message()},{type:'message_update',assistantMessageEvent:{type:'text_start',contentIndex:0}}]),'event_order'],
  [eventStream([{type:'message_end',message:message()},{type:'turn_end',message:{role:'user'}}]),'turn_message'],
  [eventStream([{type:'message_end',message:message()},{type:'turn_end',message:message()},{type:'agent_end',messages:[]}]),'agent_messages'],
  [eventStream([{type:'turn_start'}]),'multiple_turns'],[eventStream([{type:'message_start',message:{role:'assistant'}}]),'multiple_assistant_starts'],
  [eventStream([{type:'message_end',message:{role:'toolResult'}}]),'tool_result'],
  [eventStream([{type:'message_update',assistantMessageEvent:{type:'toolcall_start'}}]),'tool_update'],
  [eventStream([{type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'PRIVATE_TEXT',PRIVATE_FIELD:true}}]),'text_update_schema'],
  [eventStream([{type:'message_end',message:message({completedAt:-1})}]),'completed_at'],
  [eventStream([{type:'message_end',message:message({responseId:null,timestamp:null})}]),'assistant_identity'],
  [eventStream([{type:'message_end',message:message({content:[{type:'thinking',text:'PRIVATE_TEXT'}]})}]),'assistant_content'],
  [eventStream([{type:'message_end',message:message({content:[]})}]),'final_content'],
  [eventStream([]),'missing_final_assistant'],
  [eventStream([{type:'message_end',message:{role:'PRIVATE_ROLE'}}]),'message_role'],
  [eventStream([{type:'message_end',message:message()},{type:'turn_end',message:message({duration:1})}]),'assistant_copy_mismatch'],
  [eventStream([{type:'message_end',message:message()},{type:'turn_end',message:message({responseId:'other'})}]),'multiple_assistant_messages'],
 ];
 for(const [stdout,check] of cases)assert.throws(()=>inspectOmpEvents(stdout,0),(error:unknown)=>{
  assert.ok(error instanceof OmpRunnerHold);assert.equal(error instanceof OmpAssessmentOutputRejected,false);
  assert.equal(error.decodeCheck,check);OmpDecodeCheckSchema.parse(error.decodeCheck);
  const versions=assessmentBridgeFailureVersions('synthetic-lease',error);
  assert.equal(versions.ompDecodeCheck,check);assert.doesNotMatch(JSON.stringify(versions),/PRIVATE_/);return true;
 });
});

test('output diagnostics bound issue cardinality and reject forged paths or prose',()=>{
 const text=JSON.stringify({...answer,assertions:Array.from({length:80},()=>({PRIVATE_FIELD:'PRIVATE_VALUE'}))});
 assert.throws(()=>inspectOmpEvents(eventStream([{type:'message_end',message:message({content:[{type:'text',text}]})}]),0),(error:unknown)=>{
  assert.ok(error instanceof OmpAssessmentOutputRejected);assert.equal(error.rejection.issues.length,32);assert.ok(error.rejection.issueCount>32);
  assert.doesNotMatch(JSON.stringify(error.rejection),/PRIVATE_/);
  const versions=assessmentBridgeFailureVersions('synthetic-lease',error);
  StepReceiptSchema.shape.versions.parse(versions);
  assert.deepEqual(ompOutputRejectionFromVersions(versions),error.rejection);
  assert.equal(OmpOutputRejectionSchema.safeParse({...error.rejection,issues:[{code:'invalid_type',path:'$.PRIVATE_FIELD'}],issueCount:1}).success,false);
  return true;
 });
});

test('omp argv and environment remain fixed and source-free',()=>{
 const args=OMP_EXECUTION_ARGS,env=OMP_CONTAINER_ENVIRONMENT;
 assert.equal(args.includes('--api-key'),false);assert.equal(args.some(value=>/source text|database_url|proxy|broker|api[_-]?key/i.test(value)),false);
 assert.equal(env.some(value=>/source text|database_url|proxy|broker|api[_-]?key/i.test(value)),false);
 assert.equal(env.includes('ANTHROPIC_OAUTH_TOKEN=undefined'),false);assert.equal(env.includes('PI_CONFIG_DIR=.omp'),true);assert.equal(args.includes('--no-tools'),true);
});

function fakeSpawn(outputs:{version?:string;lists:string[];token:string;tokenExit?:number;tokenStderr?:string;lateChunks?:boolean}):{spawn:(file:string,args:string[],options:SpawnOptions)=>ChildProcess;calls:Array<{file:string;args:string[];env:NodeJS.ProcessEnv}>;chunks:Buffer[]}{
 const calls:Array<{file:string;args:string[];env:NodeJS.ProcessEnv}>=[],chunks:Buffer[]=[];let listIndex=0;
 const spawn=(file:string,args:string[],options:SpawnOptions):ChildProcess=>{
  calls.push({file,args,env:options.env as NodeJS.ProcessEnv});const child=new EventEmitter() as ChildProcess;
  const stdin=new PassThrough(),stdout=new PassThrough(),stderr=new PassThrough();Object.assign(child,{stdin,stdout,stderr,kill:()=>true});
  let content='';if(args[0]==='--version')content=outputs.version??OMP_HOST_VERSION+'\n';
  else if(args[0]==='token'&&args[2]==='--list')content=outputs.lists[Math.min(listIndex++,outputs.lists.length-1)]??'';
  else if(args[0]==='token'&&args[2]==='--account')content=outputs.token;
  queueMicrotask(()=>{
   const out=Buffer.from(content),err=Buffer.from(args[2]==='--account'?outputs.tokenStderr??'':'');chunks.push(out,err);
   stdout.end(out);stderr.end(err);child.emit('close',args[2]==='--account'?outputs.tokenExit??0:0,null);
   if(outputs.lateChunks){const lateOut=Buffer.from('sk-ant-oat-late-stdout'),lateErr=Buffer.from('sk-ant-oat-late-stderr');chunks.push(lateOut,lateErr);stdout.emit('data',lateOut);stderr.emit('data',lateErr);}
  });
  return child;
 };
 return {spawn,calls,chunks};
}

type UnsafeHostMetadata='file-owner'|'file-group-write'|'file-world-write'|'file-symlink'|'file-links'|'parent-owner'|'parent-group-write'|'parent-world-write'|'parent-symlink';
async function withBinary(work:(binary:string,root:string)=>Promise<void>,unsafe?:UnsafeHostMetadata){
 const root=await mkdtemp(join(tmpdir(),'omp-runner-test-')),binary=join(root,'omp');
 const original=fsPromises.lstat;
 // Synthetic source-free metadata only: tests neither require root nor touch
 // the installed host resolver/credential store. No real executable is spawned.
 const metadata=mock.method(fsPromises,'lstat',async(path:string)=>{
  const actual=await original(path),value=Object.assign(Object.create(Object.getPrototypeOf(actual)),actual,{uid:0,mode:actual.isDirectory()?0o40755:actual.mode}) as Stats;
  if(path===(unsafe?.startsWith('parent-')?root:binary)){
   if(unsafe?.endsWith('-owner'))value.uid=1000;
   if(unsafe?.endsWith('-group-write'))value.mode|=0o020;
   if(unsafe?.endsWith('-world-write'))value.mode|=0o002;
   if(unsafe?.endsWith('-symlink'))value.isSymbolicLink=()=>true;
   if(unsafe==='file-links')value.nlink=2;
  }
  return value;
 });syncBuiltinESMExports();
 try{await writeFile(binary,'synthetic executable');await chmod(binary,0o500);await work(binary,root);}
 finally{metadata.mock.restore();syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
}
async function fileSha256(path:string){return createHash('sha256').update(await readFile(path)).digest('hex');}
async function hostReview(path:string){return {hostResolverBinarySha256:await fileSha256(path),hostResolverVersion:OMP_HOST_VERSION} as const;}

test('credential resolver accepts a stable single-account OAuth token without putting it in argv or env',async()=>withBinary(async(binary,root)=>{
 const mock=fakeSpawn({lists:['1. Max OAuth\n','1. Max OAuth\n'],token:'sk-ant-oat-synthetic\n'});
 const resolved=await resolveOmpCredential(mock.spawn,binary,root,await hostReview(binary));
 assert.equal(resolved.version,OMP_HOST_VERSION);assert.equal(resolved.token.toString(),'sk-ant-oat-synthetic');
 assert.deepEqual(mock.calls.map(call=>call.args),[['--version'],['token','anthropic','--list'],['token','anthropic','--account','1'],['token','anthropic','--list']]);
 for(const call of mock.calls){assert.deepEqual(call.env,{HOME:'/home/max',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'});assert.equal(call.args.includes(resolved.token.toString()),false);}
 resolved.token.fill(0);
}));

test('credential resolver holds for zero or multiple accounts, wrong version, non-OAuth token and a changed list',async()=>withBinary(async(binary,root)=>{
 const cases=[
  {lists:['',''],token:'sk-ant-oat-x'},
  {lists:['1. account one\n2. account two\n'],token:'sk-ant-oat-x'},
  {lists:['1. account one\n','1. account one\n'],token:'not-oauth'},
  {lists:['1. account one\n','1. changed account\n'],token:'sk-ant-oat-x'},
 ];
 for(const scenario of cases){const mock=fakeSpawn(scenario);await assert.rejects(resolveOmpCredential(mock.spawn,binary,root,await hostReview(binary)),OmpRunnerHold);}
 const wrongVersion=fakeSpawn({version:'omp/18.9.1',lists:['1. account one\n'],token:'sk-ant-oat-x'});
 await assert.rejects(resolveOmpCredential(wrongVersion.spawn,binary,root,await hostReview(binary)),OmpRunnerHold);
}));

test('omp runner fingerprint includes the canonical authority, lifecycle and every reviewed image profile file',async()=>{
 const files=['district-omp-b-runner.ts','district-b-native-model.ts','district-assessment-projection.ts','district-schema.ts','district-graph-claims.ts','district-omp-output-diagnostics.ts','district-subscription-limit.ts','district-execution-profile.ts','district-assessment.ts','district-assessment-context.ts','district-claims.ts','civic-docker.ts','civic-opt-out.ts','../docker/omp-b/Dockerfile','../docker/omp-b/settings.yml','../docker/omp-b/entry.sh','../docker/omp-b/natives.sha256','../scripts/build-omp-b-image.sh'];
 const control=ompAssessmentControl();
 const expected=semanticHash({version:OMP_RUNNER_VERSION,systemPromptSha256:control.systemPromptSha256,outputSchemaSha256:control.outputSchemaSha256,files:await Promise.all(files.map(async file=>({file,sha256:digest(await readFile(new URL('../src/'+file,import.meta.url)))})))});
 assert.equal(await ompRunnerContractSha256(),expected);
});

test('omp image inherits the reviewed runtime with only the POSIX token entrypoint replaced',async()=>{
 const dockerfile=await readFile(new URL('../docker/omp-b/Dockerfile',import.meta.url),'utf8');
 assert.deepEqual(dockerfile.split('\n').filter(line=>line&&!line.startsWith('#')),[
  'FROM sha256:e61fc2520bcfe87dd37586ab19b2d2b054abfc41335b3af2437a7b7175c6c169',
  'COPY entry.sh /opt/stadtstack/entry.sh',
 ]);
 assert.equal(await readFile(new URL('../docker/omp-b/entry.sh',import.meta.url),'utf8'),String.raw`#!/bin/sh
set -eu
# The host's frozen custody profile pins this bootstrap argv. Only this reviewed
# image translates model and thinking; no alternate bootstrap or fallback exists.
[ "$#" -ge 7 ] && [ "$1" = --print ] && [ "$2" = --mode ] \
  && [ "$3" = json ] && [ "$4" = --model ] \
  && [ "$5" = anthropic/claude-haiku-5-5 ] && [ "$6" = --thinking ] \
  && [ "$7" = off ] || exit 126
shift 7
IFS= read -r token || exit 126
[ -n "$token" ] || exit 126
export ANTHROPIC_OAUTH_TOKEN="$token"
unset token
exec omp --print --mode json --model anthropic/claude-sonnet-5-5 --thinking medium "$@"
`);
});

test('entry translates only the frozen bootstrap to Sonnet medium and preserves framed stdin',async t=>{
 const root=await mkdtemp(join(tmpdir(),'omp-medium-entry-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'omp'),'#!/bin/sh\n[ "${ANTHROPIC_OAUTH_TOKEN:+present}" = present ] || exit 129\nprintf "%s\\n" "$@"\nexec cat\n',{mode:0o555});
 const entry=new URL('../docker/omp-b/entry.sh',import.meta.url).pathname,body='Synthetic source-free payload\n';
 const invoke=(args:readonly string[])=>spawnSync('/bin/sh',[entry,...args],{cwd:root,env:{PATH:root+':/usr/bin:/bin',HOME:root},input:'synthetic-token\n'+body,encoding:'utf8'});
 const result=invoke(OMP_EXECUTION_ARGS);
 assert.equal(result.status,0);assert.equal(result.stderr,'');
 assert.equal(result.stdout,['--print','--mode','json','--model','anthropic/claude-sonnet-5-5','--thinking','medium',...OMP_EXECUTION_ARGS.slice(7)].join('\n')+'\n'+body);
 assert.doesNotMatch(result.stdout,/synthetic-token/);
 for(const args of [OMP_EXECUTION_ARGS.slice(0,5),OMP_EXECUTION_ARGS.map((arg,index)=>index===6?'medium':arg),OMP_EXECUTION_ARGS.map((arg,index)=>index===4?'anthropic/claude-sonnet-5-5':arg)]){
  const rejected=invoke(args);assert.equal(rejected.status,126);assert.equal(rejected.stdout,'');assert.equal(rejected.stderr,'');
 }
});

test('settings overlay contains only the reviewed registered paths and correctly typed scalar values',async()=>{
 const expected=`autoResume: false
extensions: []
workspace:
  additionalDirectories: []
retry:
  enabled: false
  modelFallback: false
  fallbackChains: {}
  waitForUsageReset: false
  usageAwareFallback: false
providers:
  anthropic:
    serverSideFallback: false
  cacheRetention: none
  cacheWarming: 'off'
model:
  loopGuard:
    enabled: false
    checkAssistantContent: false
    toolCallReminder: false
  toolCallLoopGuard:
    enabled: false
contextPromotion:
  enabled: false
prewalk:
  enabled: false
advisor:
  enabled: false
autolearn:
  enabled: false
  autoContinue: false
memory:
  backend: 'off'
features:
  unexpectedStopDetection: none
mcp:
  enableProjectConfig: false
plan:
  enabled: false
compaction:
  enabled: false
  midTurnEnabled: false
  asyncEnabled: false
  idleEnabled: false
  autoContinue: false
  experimentalContextManagement: false
  handoffSaveToDisk: false
startup:
  checkUpdate: false
marketplace:
  autoUpdate: 'off'
telemetry:
  otlpExportEnabled: false
contextFiles:
  extra: []
`;
 assert.equal(await readFile(new URL('../docker/omp-b/settings.yml',import.meta.url),'utf8'),expected);
});

test('CLI assessment manifest permits only the native transport and rejects historical or mixed contracts',()=>{
 const common={itemArtifactSha256:'a'.repeat(64),policyProofSha256:'b'.repeat(64),sourceScope:{publisherId:'fixture-publisher',sourceId:'fixture-source',municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'2026-10-11'}};
 const vm={...common,transport:'vm-omp'},mac={...common,transport:'mac-bridge',clientContractSha256:'c'.repeat(64)};
 assert.deepEqual(AssessmentBEnqueueManifestSchema.parse({jobs:[vm]}).jobs,[vm]);
 for(const job of [common,mac,{...common,transport:'mac-bridge'},{...vm,clientContractSha256:'c'.repeat(64)},{...mac,runnerContractSha256:'d'.repeat(64)},{...vm,transport:'unknown'}])assert.throws(()=>AssessmentBEnqueueManifestSchema.parse({jobs:[job]}));
 assert.throws(()=>AssessmentBEnqueueManifestSchema.parse({jobs:[]}));
});

test('only the stock LF version terminator is accepted',async()=>withBinary(async(binary,root)=>{
 for(const version of [OMP_HOST_VERSION,OMP_HOST_VERSION+'\r\n',OMP_HOST_VERSION+'\n\n',OMP_HOST_VERSION+'\nextra',' '+OMP_HOST_VERSION+'\n',OMP_VERSION+'\n']){
  const mock=fakeSpawn({version,lists:['1. OAuth\n'],token:'sk-ant-oat-synthetic\n'});
  await assert.rejects(resolveOmpCredential(mock.spawn,binary,root,await hostReview(binary)),OmpRunnerHold);
  assert.deepEqual(mock.calls.map(call=>call.args),[['--version']]);
 }
}));

test('response copies allow only completedAt enrichment, not conflicting substantive fields or distinct turns',()=>{
 const original=message(),final={...original,completedAt:1791800000100};
 for(const copy of [
  message({content:[{type:'text',text:JSON.stringify({...answer,rationale:'different'})}]}),
  message({usage:{...original.usage,input:8}}),
  message({model:'claude-sonnet-4'}),message({stopReason:'length'}),message({timestamp:1791800000001}),
  message({responseId:'msg-two'}),
 ])assert.throws(()=>inspectOmpEvents(eventStream([{type:'message_end',message:final},{type:'turn_end',message:copy,toolResults:[]}]),0));
 const withoutId=message({responseId:undefined});
 assert.doesNotThrow(()=>inspectOmpEvents(eventStream([{type:'message_end',message:{...withoutId,completedAt:1791800000100}},{type:'turn_end',message:withoutId,toolResults:[]},{type:'agent_end',messages:[withoutId]}]),0));
 assert.throws(()=>inspectOmpEvents(eventStream([{type:'turn_start'},{type:'message_end',message:final},{type:'turn_start'},{type:'agent_end',messages:[original]}]),0));
 assert.throws(()=>inspectOmpEvents(eventStream([{type:'message_start',message:{role:'assistant'}},{type:'message_start',message:{role:'assistant'}},{type:'message_end',message:final}]),0));
});

test('stock serialized nested text updates are accepted; tool/failure/malformed updates cannot be hidden by a later final',()=>{
 const updates=[{type:'start'},{type:'text_start',contentIndex:0},{type:'text_delta',contentIndex:0,delta:JSON.stringify(answer)},{type:'text_end',contentIndex:0,content:JSON.stringify(answer)},{type:'done',reason:'stop'}];
 assert.doesNotThrow(()=>inspectOmpEvents(eventStream([...updates.map(assistantMessageEvent=>({type:'message_update',assistantMessageEvent})),{type:'message_end',message:message()}]),0));
 for(const assistantMessageEvent of [
  {type:'error',reason:'error'},{type:'error',reason:'aborted'},{type:'done',reason:'length'},{type:'done',reason:'toolUse'},
  {type:'toolcall_start',contentIndex:0},{type:'toolcall_delta',contentIndex:0,delta:'{}'},{type:'toolcall_end',contentIndex:0,toolCall:{id:'tool-one',name:'shell',arguments:{}}},
  {type:'thinking_start',contentIndex:0},{type:'image_end',contentIndex:0,content:{}},{type:'text_delta',contentIndex:-1,delta:'x'},
  {type:'text_delta',contentIndex:0,delta:7},{type:'text_start'},{type:'start',partial:message()},{type:'unknown'},null,
 ])assert.throws(()=>inspectOmpEvents(eventStream([{type:'message_update',assistantMessageEvent},{type:'message_end',message:message()}]),0));
 assert.throws(()=>inspectOmpEvents(eventStream([{type:'message_update',assistantMessage:{stopReason:'stop'}},{type:'message_end',message:message()}]),0));
});

test('usage keeps normalized token buckets and only valid final-attempt cost estimates',()=>{
 assert.equal(inspectOmpEvents(eventStream([{type:'message_end',message:message({usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}}})}]),0).usage.cliEstimatedApiCostUsd,0);
 for(const total of [-1,null,'0.1']){
  const inspected=inspectOmpEvents(eventStream([{type:'message_end',message:message({usage:{input:7,output:3,cacheRead:5,cacheWrite:2,totalTokens:17,cost:{total}}})}]),0);
  assert.equal(inspected.usage.cliEstimatedApiCostUsd,null);assert.equal(inspected.usage.perModel['claude-sonnet-5-5']!.cliEstimatedApiCostUsd,undefined);
  assert.deepEqual(inspected.usage.topLevel,{inputTokens:7,outputTokens:3,cacheReadTokens:5,cacheCreationTokens:2});
 }
});

test('credential capture wipes original stdout/stderr chunks on success, nonzero exit, bounds and late data',async()=>withBinary(async(binary,root)=>{
 for(const failure of [null,'exit','bound','stderr-bound'] as const){
  const mock=fakeSpawn({lists:['1. OAuth\n','1. OAuth\n'],token:failure==='bound'?'sk-ant-oat-'+ 'x'.repeat(16384):'sk-ant-oat-synthetic\n',tokenExit:failure==='exit'?1:0,tokenStderr:failure==='stderr-bound'?'sk-ant-oat-'+ 'x'.repeat(16384):'sk-ant-oat-synthetic-stderr',lateChunks:true});
  if(failure===null){const auth=await resolveOmpCredential(mock.spawn,binary,root,await hostReview(binary));assert.equal(auth.token.toString(),'sk-ant-oat-synthetic');auth.token.fill(0);}
  else await assert.rejects(resolveOmpCredential(mock.spawn,binary,root,await hostReview(binary)),OmpRunnerHold);
  assert.ok(mock.chunks.length>0);for(const chunk of mock.chunks)assert.equal(chunk.every(byte=>byte===0),true);
 }
}));

test('delivered source-free control contains the exact serialized output schema without changing the base request prompt',()=>{
 const schema=z.toJSONSchema(assessmentOutputSchema),serialized=canonicalJson(schema),bundle=ompAssessmentControl(),control=bundle.prompt;
 const prefix=PROMPTS.B+'\n\nReturn only JSON matching this exact frozen assessment output schema:\n';
 assert.ok(control.startsWith(prefix+serialized+'\n\nAllowed output property names per object'));
 assert.deepEqual(JSON.parse(control.slice(prefix.length,prefix.length+serialized.length)),schema);
 let objects=0;
 function checkObjectKeys(node:Record<string,unknown>,path:string):void{
  const properties=node.properties as Record<string,Record<string,unknown>>|undefined;
  if(node.type==='object'){objects++;assert.ok(control.includes('- '+path+': '+Object.keys(properties??{}).join(', ')),path);}
  for(const [key,child] of Object.entries(properties??{}))checkObjectKeys(child,path+'.'+key);
  if(node.items&&!Array.isArray(node.items))checkObjectKeys(node.items as Record<string,unknown>,path+'[]');
  for(const kind of ['anyOf','oneOf','allOf'])if(Array.isArray(node[kind]))for(const branch of node[kind])checkObjectKeys(branch,path);
 }
 checkObjectKeys(schema,'$');assert.equal(objects,14);
 assert.ok(control.includes('Its first character must be { and its last character must be }'));
 assert.ok(control.includes('No Markdown, code fences, commentary, or surrounding text'));
 assert.ok(control.includes('Use ONLY the listed property names at every object level'));
 assert.equal(digest(serialized),assessmentDigest(schema));
 assert.equal(bundle.outputSchemaSha256,assessmentDigest(schema));assert.equal(bundle.systemPromptSha256,digest(control));
 assert.ok(control.startsWith(PROMPTS.B));assert.equal(control.includes('synthetic source, never an operational observation'),false);
 for(const rule of ['If outcome is abstain OR unresolved, scores.usefulness must be 0','value and unit must be both null or both non-null','Never invent a day for month/year/period precision','When date is null, dateRole may retain an attested role','Always include valueReview and criticalReview','every input claimId exactly once','data_missing must equal (missing.length > 0)','each criticalTarget claim exactly once'])assert.ok(control.includes(rule),rule);
 for(const rule of ['For compact r1-provider-propositions-v3 input','resolve $quote and other supplied references silently','no analysis, reference-resolution explanation, or other text before or after it, and no code fence'])assert.ok(control.includes(rule),rule);
 for(const rule of ['assess each proposition independently','a complete supplied locator quote may establish that label semantically','assert a classification only when their meaning actually establishes it','Never invent or upgrade a classification, stage or modality','Preserve assertions for supported propositions even when another required proposition is unresolved','supported still requires every input claimId to be supported'])assert.ok(control.includes(rule),rule);
 assert.ok(Buffer.byteLength(control)<=65536,'Reviewed control bind remains within its independent bound');
});
test('B encoding clarifications preserve unresolved judgment while satisfying the unchanged deterministic checker',()=>{
 const quote='Synthetic category with month precision 2026-10.',hash=digest(quote),rubric='Synthetic frozen rubric';
 const locator={id:'span',page:null,table:null,start:0,end:quote.length,quote};
 const evidence:OriginalEvidence=[{sourceId:'source',admittedSourceId:'source',url:'https://example.org/synthetic',originalSha256:hash,textSha256:hash,parserVersion:'synthetic',parserReceiptSha256:hash,admissionReceiptSha256:hash,ocrSuspected:false,text:quote,locators:[locator]}];
 const item=assessmentItemSchema.parse({version:'assessment-item-v1',itemId:'synthetic-encoding',question:'Synthetic independent review',claim:'Synthetic category/month proposition',rubric,rubricSha256:digest(rubric),sources:[{sourceId:'source',originalSha256:hash,textSha256:hash,parserVersion:'synthetic',parserReceiptSha256:hash,admissionReceiptSha256:hash,ocrSuspected:false,locators:[{id:locator.id,page:null,table:null,start:0,end:quote.length}]}],claimIds:['claim'],entityIds:[],constraints:[],criticalKinds:[]});
 const output=assessmentOutputSchema.parse({itemId:item.itemId,outcome:'unresolved',assertions:[{claimId:'claim',sourceId:'source',locatorId:'span',quote,subjectId:null,objectId:null,value:'Synthetic category',unit:null,date:'2026-10',dateRole:'source_reference',financialRole:'none',stage:null,modality:'unknown'}],scores:{correctness:1,sources:1,usefulness:1},holdReasons:[],rationale:'Synthetic encoding fixture; no operational observation.',valueReview:null,criticalReview:null});
 assert.deepEqual(deterministicChecks(item,evidence,output),['abstention_usefulness','calendar_date_role:claim','value_unit:claim']);
 const encoded=assessmentOutputSchema.parse({...output,scores:{...output.scores,usefulness:0},assertions:output.assertions.map(assertion=>({...assertion,value:null,unit:null,date:null}))});
 assert.deepEqual(deterministicChecks(item,evidence,encoded),[]);
 assert.equal(encoded.outcome,'unresolved');assert.equal(encoded.assertions[0].dateRole,'source_reference');assert.equal('quote' in encoded.assertions[0]&&encoded.assertions[0].quote,quote);
 const held=assessmentOutputSchema.parse({...encoded,holdReasons:['insufficient_evidence','critical_unsupported']});
 assert.deepEqual(deterministicChecks(item,evidence,held),['hold:critical_unsupported','hold:insufficient_evidence'],'Encoding never suppresses substantive holds');
});
test('independent classification encoding retains supported assertions but never admits uncovered claims',()=>{
 const quote='Public consultation on the draft development plan begins in October.',hash=digest(quote),rubric='Synthetic independent proposition fixture';
 assert.equal(quote.includes('development_plan'),false,'A normalized label is not necessarily literal source wording');
 const locator={id:'span',page:null,table:null,start:0,end:quote.length,quote};
 const evidence:OriginalEvidence=[{sourceId:'source',admittedSourceId:'source',url:'https://example.org/synthetic',originalSha256:hash,textSha256:hash,parserVersion:'synthetic',parserReceiptSha256:hash,admissionReceiptSha256:hash,ocrSuspected:false,text:quote,locators:[locator]}];
 const item=assessmentItemSchema.parse({version:'assessment-item-v1',itemId:'synthetic-classification',question:'Independently assess the source propositions',claim:'Normalized caseType development_plan',rubric,rubricSha256:digest(rubric),sources:[{sourceId:'source',originalSha256:hash,textSha256:hash,parserVersion:'synthetic',parserReceiptSha256:hash,admissionReceiptSha256:hash,ocrSuspected:false,locators:[{id:locator.id,page:null,table:null,start:0,end:quote.length}]}],claimIds:['classification'],entityIds:[],constraints:[],criticalKinds:[]});
 const supported=assessmentOutputSchema.parse({itemId:item.itemId,outcome:'supported',assertions:[{claimId:'classification',sourceId:'source',locatorId:'span',quote,subjectId:null,objectId:null,value:null,unit:null,date:null,dateRole:null,financialRole:'none',stage:null,modality:'unknown'}],scores:{correctness:1,sources:1,usefulness:1},holdReasons:[],rationale:'Synthetic encoding fixture, not a model observation.',valueReview:null,criticalReview:null});
 assert.deepEqual(deterministicChecks(item,evidence,supported),[]);
 const mixed=assessmentItemSchema.parse({...item,claimIds:['classification','approval']});
 const unresolved=assessmentOutputSchema.parse({...supported,outcome:'unresolved',scores:{...supported.scores,usefulness:0},holdReasons:['insufficient_evidence']});
 assert.deepEqual(deterministicChecks(mixed,evidence,unresolved),['hold:insufficient_evidence']);
 assert.equal(unresolved.assertions[0].claimId,'classification','Unresolved classification coverage does not erase other assertions');
 assert.deepEqual(deterministicChecks(mixed,evidence,supported),['missing_claim:approval'],'Partial assertions cannot become a supported item');
 assert.deepEqual(deterministicChecks(item,evidence,{...supported,assertions:[{...supported.assertions[0],quote:'A paraphrase is not an exact locator quote.'}]}),['quote_locator:classification']);
});

for(const failure of ['credential','unsafe-output'] as const)test('parallel A evidence reads survive B '+failure+' in its disjoint enrolled lane',async t=>{
 const fixture=await createCivicPolicyTestContext(t),cas=fixture.managedRoot,options={...fixture.policy,decisionId:fixture.decisionId,kind:'artifacts' as const},bytes=Buffer.from('Synthetic authenticated assessment original');
 await initializeManagedAcquisitionLane(cas,options);
 const binding={kind:'prepared_source' as const,url:'https://assessment.test/original',sourceSha256:digest(bytes),observationId:'synthetic-original',receiptSha256:digest('synthetic-admission')};
 await withManagedSourceWrite(cas,[{...binding,relativePath:'original.txt',contentSha256:digest(bytes),independentAllowed:false}],()=>writeFile(join(cas,'original.txt'),bytes,{mode:0o600}),fixture.policy);
 const root=ompAssessmentScratchRoot(cas);assert.equal(root,cas+'-omp-b-scratch');
 const ready=Promise.withResolvers<void>(),done=Promise.withResolvers<void>();
 const A=withManagedSourceScratch(cas,[binding],async scope=>{
  await writeFile(join(scope.directory,'schema.json'),'{}',{mode:0o600});ready.resolve();await done.promise;
  await scope.assertActive();await assertManagedSourceReadable(join(cas,'original.txt'),fixture.policy);assert.deepEqual(await readFile(join(cas,'original.txt')),bytes);
 },{...options,purpose:'openai'});
 void A.catch(ready.reject);await ready.promise;let scratch='';
 try{
  const B=withManagedSourceScratch(root,[binding],async scope=>{
   scratch=scope.directory;await mkdir(join(scratch,failure==='credential'?'host-control':'credentials'),{mode:0o700});
   if(failure==='unsafe-output')await writeFile(join(scratch,'credentials','token.json'),'Synthetic protected bytes',{mode:0o600});
   throw new OmpRunnerHold('credential_unavailable');
  },{...options,purpose:'artifact'});
  await assert.rejects(B,failure==='credential'?OmpRunnerHold:CivicPolicyStateError);
 }finally{done.resolve();await A;}
 const inventory=await readCivicPolicyInventory(fixture.policy);assert.equal(inventory.roots.find(r=>r.path===cas)!.complete,true);
 assert.equal(inventory.scratch.filter(lease=>lease.rootId===digest(root))[0].state,failure==='credential'?'closed':'partial');
 if(failure==='credential')await assert.rejects(lstat(scratch),{code:'ENOENT'});
 else assert.equal(await readFile(join(scratch,'credentials','token.json'),'utf8'),'Synthetic protected bytes');
});

test('broker preserves every controlled runner hold reason without retaining arbitrary messages',()=>{
 const reasons:OmpRunnerHold['reason'][]=['security_review_required','unavailable','credential_unavailable','request_rejected','resource_limit','provider_failed','event_stream','model_identity_mismatch'];
 for(const reason of reasons){
  const code=assessmentBridgeHoldReason(new OmpRunnerHold(reason));assert.equal(code,`omp_${reason}`);ReasonCodeSchema.parse(code);
 }
 assert.equal(assessmentBridgeHoldReason(new DistrictExecutionHold('owner_stopped')),'owner_stopped');
 assert.equal(assessmentBridgeHoldReason(Error('private credential/source message')),'execution_exception');
});

for(const unsafe of ['file-owner','file-group-write','file-world-write','file-symlink','file-links','parent-owner','parent-group-write','parent-world-write','parent-symlink'] as const)test('host credential resolver rejects unsafe metadata before any control call: '+unsafe,async()=>withBinary(async(binary,root)=>{
 const fake=fakeSpawn({lists:['1. OAuth\n'],token:'sk-ant-oat-synthetic\n'});
 await assert.rejects(resolveOmpCredential(fake.spawn,binary,root,await hostReview(binary)),{reason:'security_review_required'});
 assert.equal(fake.calls.length,0);
},unsafe));

test('host resolver review hash is separate from the image hash and mismatch stops before credential reads',async()=>withBinary(async(binary,root)=>{
 const fake=fakeSpawn({lists:['1. OAuth\n','1. OAuth\n'],token:'sk-ant-oat-synthetic\n'});
 await assert.rejects(resolveOmpCredential(fake.spawn,binary,root,{hostResolverBinarySha256:'0'.repeat(64),hostResolverVersion:OMP_HOST_VERSION}),{reason:'security_review_required'});
 assert.equal(fake.calls.length,0);
 const review={...await hostReview(binary),ompBinarySha256:'0'.repeat(64)};
 const auth=await resolveOmpCredential(fake.spawn,binary,root,review);assert.equal(auth.version,OMP_HOST_VERSION);auth.token.fill(0);
}));

test('review requires explicit current host resolver fields and keeps the container version unchanged',()=>{
 const review={version:OMP_RUNNER_VERSION,imageId:'sha256:'+'a'.repeat(64),runnerContractSha256:'b'.repeat(64),ompBinarySha256:'c'.repeat(64),
  hostResolverBinarySha256:'d'.repeat(64),hostResolverVersion:OMP_HOST_VERSION,dockerDaemonId:'synthetic-daemon',securityReviewId:'synthetic-review',reviewedBy:'synthetic-reviewer',reviewedAt:'2026-10-14T00:00:00Z',dockerSocket:'/run/docker.sock'};
 assert.deepEqual(OmpReviewSchema.parse(review),review);
 const {hostResolverBinarySha256,hostResolverVersion,...old}=review;assert.throws(()=>OmpReviewSchema.parse(old));
 assert.throws(()=>OmpReviewSchema.parse({...review,hostResolverVersion:OMP_VERSION}));
 assert.equal(OMP_HOST_BINARY,'/usr/local/lib/stadtstack/omp-b/omp-host-18.10.4');assert.equal(OMP_HOST_VERSION,'omp/18.10.4');assert.equal(OMP_VERSION,'omp/18.9.2');
});

test('image builder derives an offline entry-only candidate from hash-authenticated reviewed runtime content',async()=>{
 const script=await readFile(new URL('../scripts/build-omp-b-image.sh',import.meta.url),'utf8');
 assert.match(script,/SOURCE_IMAGE=sha256:e61fc2520bcfe87dd37586ab19b2d2b054abfc41335b3af2437a7b7175c6c169/);
 assert.match(script,/EXPECTED=647237242329897c3a7c0f3591fdd9cafe4a4e13872baa9bbdfe45b84f9d8992/);
 assert.match(script,/EXPECTED_ENTRY=e4d1cbae8698b3767d91ef8786f347bc6ad9db8abaa708c0dffe6215c0aa0bc0/);
 assert.match(script,/EXPECTED_SETTINGS=a6211ded7fb160dccb61e0f27dd80ab7e2a31c747e6661f54f4841c13f22ae0a/);
 assert.match(script,/EXPECTED_MANIFEST=e87e2ef469b318547b324a7f4a8a93621012f39024cb0a0e06c61fbc557c4d27/);
 assert.match(script,/--config "\$TMP\/docker-config" --host unix:\/\/\/run\/docker.sock/);
 assert.match(script,/-i HOME=\/home\/omp PATH=\/usr\/local\/bin:\/usr\/bin:\/bin/);
 assert.match(script,/--name "\$VERIFY_NAME" --network none --read-only/);
 assert.match(script,/\/bin\/sh -ec '/);
 assert.match(script,/sha256sum --strict --check -/);
 assert.match(script,/DOCKER_BUILDKIT=0 docker_local build --pull=false --network none/);
 assert.match(script,/verify_image "\$SOURCE_IMAGE"/);
 assert.match(script,/verify_image "\$IMAGE_ID"/);
 assert.match(script,/assert.deepEqual\(config\(candidate.Config\),config\(base.Config\)\)/);
 assert.match(script,/assert.equal\(candidate.Config.User,"65534:65534"\)/);
 assert.match(script,/assert.deepEqual\(candidate.RootFS.Layers.slice\(0,-1\),base.RootFS.Layers\)/);
 assert.doesNotMatch(script,/OMP_IMAGE_BINARY|\/home\/max\/\.local\/bin\/omp|omp-host-18\.10\.4/);
 const argv=script.match(/^set -- (.+)$/m)?.[1];assert.ok(argv);
 assert.deepEqual(argv.split(' '),OMP_EXECUTION_ARGS);
 const readiness=script.slice(script.indexOf('docker_local run --pull=never --name "$READY_NAME"'));
 for(const flags of ['--interactive --network none --ipc none --read-only','--cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 --workdir /work --stop-timeout 1','--memory 536870912 --memory-swap 536870912 --cpus 1 --pids-limit 32','--ulimit nofile=64:64 --ulimit nproc=32:32 --ulimit fsize=33554432:33554432 --ulimit core=0:0 --log-driver none'])assert.ok(readiness.includes(flags),flags);
 for(const path of ['/home/omp','/tmp','/work'])assert.ok(readiness.includes('--tmpfs '+path+':rw,noexec,nosuid,nodev,size=67108864,uid=65534,gid=65534,mode=0700'));
 assert.ok(readiness.includes('"$IMAGE_ID" "$@" --help'));
 assert.doesNotMatch(readiness,/--version|rw,exec/);
});

test('native image addons have explicit binary-derived hashes and immutable checked installation',async()=>{
 const manifest=await readFile(new URL('../docker/omp-b/natives.sha256',import.meta.url),'utf8');
 assert.match(manifest,/Source image: sha256:91c2c2c451fbc0273b97d25523bab3308b7077edca33efaaf26af923209711df/);
 assert.match(manifest,/Source executable SHA-256: 647237242329897c3a7c0f3591fdd9cafe4a4e13872baa9bbdfe45b84f9d8992/);
 assert.deepEqual(manifest.split('\n').filter(line=>line&&!line.startsWith('#')),[
  'a5c48a5718258a55be65410ae036fafb7af8bdf4643f44c83379af5d7a6cf584  pi_natives.linux-x64-baseline.node',
  'fa537a8c0765dc76e5199aae9dadb99cec9d69d41b3d36a47a032452196cb078  pi_natives.linux-x64-modern.node',
 ]);
 const script=await readFile(new URL('../scripts/build-omp-b-image.sh',import.meta.url),'utf8');
 for(const line of manifest.split('\n').filter(line=>line&&!line.startsWith('#'))){
  const [hash,file]=line.split('  ');assert.ok(script.includes(hash+' /usr/local/bin/'+file));
 }
 assert.match(script,/for file in \/usr\/local\/bin\/pi_natives/);
 assert.match(script,/\[ "\$\(stat -c %a "\$file"\)" = 444 \] \|\| exit 2/);
});
