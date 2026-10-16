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
import type {ChildProcess,SpawnOptions} from 'node:child_process';
import {inspectOmpEvents,resolveOmpCredential,ompAssessmentControl,ompRunnerContractSha256,ompAssessmentScratchRoot,OMP_RUNNER_VERSION,OMP_VERSION,OMP_HOST_VERSION,OMP_HOST_BINARY,OmpReviewSchema,OmpRunnerHold,OmpAssessmentOutputRejected,OmpOutputRejectionSchema,ompOutputRejectionFromVersions} from '../src/district-omp-b-runner.ts';
import {OMP_CONTAINER_ENVIRONMENT,OMP_EXECUTION_ARGS,OMP_PROCESS} from '../src/district-execution-profile.ts';
import {semanticHash,digest,canonicalJson} from '../src/district-adapter-contract.ts';
import {AssessmentBEnqueueManifestSchema} from '../src/district-r1.ts';
import {assessmentOutputSchema,PROMPTS,digest as assessmentDigest} from '../src/district-assessment.ts';
import {z} from 'zod';
import {withManagedSourceScratch,withManagedSourceWrite,initializeManagedAcquisitionLane,assertManagedSourceReadable,readCivicPolicyInventory,CivicPolicyStateError} from '../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {assessmentBridgeHoldReason,assessmentBridgeFailureVersions} from '../src/district-assessment-broker.ts';
import {DistrictExecutionHold} from '../src/district-jobs.ts';
import {ReasonCodeSchema,StepReceiptSchema} from '../src/district-step-receipt.ts';
import {OmpFailureKindSchema,OmpDecodeCheckSchema} from '../src/district-exception-diagnostics.ts';

const answer={itemId:'synthetic',outcome:'supported',assertions:[],scores:{correctness:1,sources:1,usefulness:1},holdReasons:[],rationale:'synthetic',valueReview:null};
function message(overrides:Record<string,unknown>={}){return {responseId:'msg-one',timestamp:1791800000000,role:'assistant',provider:'anthropic',api:'anthropic-messages',model:'claude-haiku-5-5',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}],usage:{input:7,output:3,cacheRead:5,cacheWrite:2,totalTokens:17,cost:{input:0.01,output:0.02,cacheRead:0.03,cacheWrite:0.04,total:0.1}},...overrides};}
function eventStream(events:Record<string,unknown>[]=[{type:'message_end',message:message()}]){
 const final=events.find(event=>event.type==='message_end'&&(event.message as {role?:string})?.role==='assistant')?.message;
 const suffix:Record<string,unknown>[]=[];
 if(final&&!events.some(event=>event.type==='turn_end'))suffix.push({type:'turn_end',message:final,toolResults:[],reason:'stop'});
 if(final&&!events.some(event=>event.type==='agent_end'))suffix.push({type:'agent_end',messages:[final],reason:'stop'});
 return [{type:'session',id:'session-one'},{type:'agent_start'},{type:'turn_start'},{type:'message_start',message:{role:'assistant'}},...events,...suffix].map(event=>JSON.stringify(event)).join('\n')+'\n';
}

test('omp event inspection accepts a completed text-only message and repeated copies',()=>{
 const original=message(),final={...original,completedAt:1791800000100};
 const inspected=inspectOmpEvents(eventStream([{type:'message_end',message:final},{type:'turn_end',message:original,toolResults:[],reason:'stop'},{type:'agent_end',messages:[original],reason:'stop'}]),0);
 assert.equal(inspected.returnedModel,'claude-haiku-5-5');assert.deepEqual(inspected.usage.topLevel,{inputTokens:7,outputTokens:3,cacheReadTokens:5,cacheCreationTokens:2});
 assert.equal(inspected.usage.cliEstimatedApiCostUsd,0.1);
 assert.equal(inspected.usage.perModel['claude-haiku-5-5']!.cliEstimatedApiCostUsd,0.1);
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

test('settled output rejection requires a complete single-response stream and keeps only closed diagnostics',()=>{
 for(const [text,check] of [['PRIVATE_INVALID_JSON sk-ant-oat-secret','output_json'],[JSON.stringify({...answer,scores:{correctness:'PRIVATE_VALUE',sources:1,usefulness:1},PRIVATE_FIELD:'PRIVATE_VALUE'}),'output_schema']] as const){
  const stdout=eventStream([{type:'message_end',message:message({content:[{type:'text',text}]})}]);
  let rejected:OmpAssessmentOutputRejected|undefined;
  assert.throws(()=>inspectOmpEvents(stdout,0),(error:unknown)=>{assert.ok(error instanceof OmpAssessmentOutputRejected);rejected=error;return true;});
  assert.ok(rejected);assert.equal(rejected.decodeCheck,check);assert.equal(rejected.containerExitCode,0);
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
 const files=['district-omp-b-runner.ts','district-subscription-limit.ts','district-execution-profile.ts','district-assessment.ts','district-assessment-context.ts','district-claims.ts','civic-docker.ts','civic-opt-out.ts','../docker/omp-b/Dockerfile','../docker/omp-b/settings.yml','../docker/omp-b/entry.sh','../docker/omp-b/natives.sha256','../scripts/build-omp-b-image.sh'];
 const control=ompAssessmentControl();
 const expected=semanticHash({version:OMP_RUNNER_VERSION,systemPromptSha256:control.systemPromptSha256,outputSchemaSha256:control.outputSchemaSha256,files:await Promise.all(files.map(async file=>({file,sha256:digest(await readFile(new URL('../src/'+file,import.meta.url)))})))});
 assert.equal(await ompRunnerContractSha256(),expected);
});

test('omp image uses the pinned parser runtime without inherited environment and a POSIX first-line token entrypoint',async()=>{
 const dockerfile=await readFile(new URL('../docker/omp-b/Dockerfile',import.meta.url),'utf8'),parser=await readFile(new URL('../Dockerfile.parser',import.meta.url),'utf8');
 const base=parser.match(/^FROM (.+)$/m)?.[1];assert.ok(base);assert.ok(dockerfile.includes('FROM '+base+' AS runtime'));
 assert.match(dockerfile,/^FROM scratch$/m);assert.match(dockerfile,/^COPY --from=runtime \/ \/$/m);assert.match(dockerfile,/^USER 65534:65534$/m);
 const entrypoint=dockerfile.match(/^ENTRYPOINT (.+)$/m)?.[1];assert.ok(entrypoint);
 assert.deepEqual(JSON.parse(entrypoint),OMP_PROCESS.Entrypoint);
 const environment=dockerfile.match(/^ENV ([\s\S]*?)^USER /m)?.[1];assert.ok(environment);
 assert.deepEqual(environment.replace(/\\\n\s*/g,' ').trim().split(/\s+/),OMP_CONTAINER_ENVIRONMENT);
 assert.equal(await readFile(new URL('../docker/omp-b/entry.sh',import.meta.url),'utf8'),'#!/bin/sh\nset -eu\nIFS= read -r token || exit 126\n[ -n \"$token\" ] || exit 126\nexport ANTHROPIC_OAUTH_TOKEN=\"$token\"\nunset token\nexec omp \"$@\"\n');
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

test('CLI assessment manifest parses both explicit transports and rejects ambiguous or mixed contracts',()=>{
 const common={itemArtifactSha256:'a'.repeat(64),policyProofSha256:'b'.repeat(64),sourceScope:{publisherId:'fixture-publisher',sourceId:'fixture-source',municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'2026-10-11'}};
 const vm={...common,transport:'vm-omp'},mac={...common,transport:'mac-bridge',clientContractSha256:'c'.repeat(64)};
 assert.deepEqual(AssessmentBEnqueueManifestSchema.parse({jobs:[vm,mac]}).jobs,[vm,mac]);
 for(const job of [common,{...common,transport:'mac-bridge'},{...vm,clientContractSha256:'c'.repeat(64)},{...mac,runnerContractSha256:'d'.repeat(64)},{...vm,transport:'unknown'}])assert.throws(()=>AssessmentBEnqueueManifestSchema.parse({jobs:[job]}));
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
 const updates=[{type:'start'},{type:'text_start',contentIndex:0},{type:'text_delta',contentIndex:0,delta:'{}'},{type:'text_end',contentIndex:0,content:JSON.stringify(answer)},{type:'done',reason:'stop'}];
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
  assert.equal(inspected.usage.cliEstimatedApiCostUsd,null);assert.equal(inspected.usage.perModel['claude-haiku-5-5']!.cliEstimatedApiCostUsd,undefined);
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
 assert.equal(control,PROMPTS.B+'\n\nReturn only JSON matching this exact frozen assessment output schema:\n'+serialized+'\n');
 assert.deepEqual(JSON.parse(control.slice(control.lastIndexOf('\n',control.length-2)+1,-1)),schema);
 assert.equal(digest(serialized),assessmentDigest(schema));
 assert.equal(bundle.outputSchemaSha256,assessmentDigest(schema));assert.equal(bundle.systemPromptSha256,digest(control));
 assert.ok(control.startsWith(PROMPTS.B));assert.equal(control.includes('synthetic source, never an operational observation'),false);
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

test('image builder derives pinned native addons from the reviewed image without host credentials',async()=>{
 const script=await readFile(new URL('../scripts/build-omp-b-image.sh',import.meta.url),'utf8');
 assert.match(script,/SOURCE_IMAGE=sha256:91c2c2c451fbc0273b97d25523bab3308b7077edca33efaaf26af923209711df/);
 assert.match(script,/EXPECTED=647237242329897c3a7c0f3591fdd9cafe4a4e13872baa9bbdfe45b84f9d8992/);
 assert.match(script,/docker_local cp "\$SOURCE_NAME:\/usr\/local\/bin\/omp" "\$TMP\/omp"/);
 assert.match(script,/--config "\$TMP\/docker-config" --host unix:\/\/\/run\/docker.sock/);
 assert.match(script,/-i HOME=\/extract-home PATH=\/usr\/local\/bin:\/usr\/bin:\/bin/);
 assert.match(script,/--name "\$EXTRACT_NAME" --network none --read-only/);
 assert.match(script,/sha256sum --strict --check natives.sha256/);
 assert.doesNotMatch(script,/OMP_IMAGE_BINARY|\/home\/max\/\.local\/bin\/omp|omp-host-18\.10\.4/);
 const argv=script.match(/^set -- (.+)$/m)?.[1];assert.ok(argv);
 assert.deepEqual(argv.split(' '),OMP_EXECUTION_ARGS);
 const readiness=script.slice(script.indexOf('docker_local run --pull=never --name "$READY_NAME"'));
 for(const flags of ['--interactive --network bridge --ipc none --read-only','--cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 --workdir /work --stop-timeout 1','--memory 536870912 --memory-swap 536870912 --cpus 1 --pids-limit 32','--ulimit nofile=64:64 --ulimit nproc=32:32 --ulimit fsize=33554432:33554432 --ulimit core=0:0 --log-driver none'])assert.ok(readiness.includes(flags),flags);
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
 const dockerfile=await readFile(new URL('../docker/omp-b/Dockerfile',import.meta.url),'utf8');
 assert.match(dockerfile,/COPY --chmod=0444 pi_natives.linux-x64-baseline.node pi_natives.linux-x64-modern.node \/usr\/local\/bin\//);
 assert.match(dockerfile,/sha256sum --strict --check \/opt\/stadtstack\/omp-b-natives.sha256/);
});
