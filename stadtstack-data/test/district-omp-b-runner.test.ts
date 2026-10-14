import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,chmod,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ChildProcess,SpawnOptions} from 'node:child_process';
import {inspectOmpEvents,resolveOmpCredential,ompAssessmentControl,ompRunnerContractSha256,OMP_RUNNER_VERSION,OMP_VERSION,OmpRunnerHold} from '../src/district-omp-b-runner.ts';
import {OMP_CONTAINER_ENVIRONMENT,OMP_EXECUTION_ARGS,OMP_PROCESS} from '../src/district-execution-profile.ts';
import {semanticHash,digest,canonicalJson} from '../src/district-adapter-contract.ts';
import {AssessmentBEnqueueManifestSchema} from '../src/district-r1.ts';
import {assessmentOutputSchema,PROMPTS,digest as assessmentDigest} from '../src/district-assessment.ts';
import {z} from 'zod';

const answer={itemId:'synthetic',outcome:'supported',assertions:[],scores:{correctness:1,sources:1,usefulness:1},holdReasons:[],rationale:'synthetic',valueReview:null};
function message(overrides:Record<string,unknown>={}){return {responseId:'msg-one',timestamp:1791800000000,role:'assistant',provider:'anthropic',api:'anthropic-messages',model:'claude-haiku-5-5',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}],usage:{input:7,output:3,cacheRead:5,cacheWrite:2,totalTokens:17,cost:{input:0.01,output:0.02,cacheRead:0.03,cacheWrite:0.04,total:0.1}},...overrides};}
function eventStream(events:unknown[]=[{type:'message_end',message:message()}]){return [{type:'session',id:'session-one'},...events].map(event=>JSON.stringify(event)).join('\n')+'\n';}

test('omp event inspection accepts a completed text-only message and repeated copies',()=>{
 const original=message(),final={...original,completedAt:1791800000100};
 const inspected=inspectOmpEvents(eventStream([{type:'message_end',message:final},{type:'turn_end',message:original,toolResults:[],reason:'stop'},{type:'agent_end',messages:[original],reason:'stop'}]),0);
 assert.equal(inspected.returnedModel,'claude-haiku-5-5');assert.deepEqual(inspected.usage.topLevel,{inputTokens:7,outputTokens:3,cacheReadTokens:5,cacheCreationTokens:2});
 assert.equal(inspected.usage.cliEstimatedApiCostUsd,0.1);
 assert.equal(inspected.usage.perModel['claude-haiku-5-5']!.cliEstimatedApiCostUsd,0.1);
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
  let content='';if(args[0]==='--version')content=outputs.version??OMP_VERSION+'\n';
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

async function withBinary(work:(binary:string,root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'omp-runner-test-')),binary=join(root,'omp');try{await writeFile(binary,'synthetic executable');await chmod(binary,0o500);await work(binary,root);}finally{await rm(root,{recursive:true,force:true});}}
async function fileSha256(path:string){return createHash('sha256').update(await readFile(path)).digest('hex');}

test('credential resolver accepts a stable single-account OAuth token without putting it in argv or env',async()=>withBinary(async(binary,root)=>{
 const mock=fakeSpawn({lists:['1. Max OAuth\n','1. Max OAuth\n'],token:'sk-ant-oat-synthetic\n'});
 const resolved=await resolveOmpCredential(mock.spawn,binary,root,await fileSha256(binary));
 assert.equal(resolved.version,OMP_VERSION);assert.equal(resolved.token.toString(),'sk-ant-oat-synthetic');
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
 for(const scenario of cases){const mock=fakeSpawn(scenario);await assert.rejects(resolveOmpCredential(mock.spawn,binary,root,await fileSha256(binary)),OmpRunnerHold);}
 const wrongVersion=fakeSpawn({version:'omp/18.9.1',lists:['1. account one\n'],token:'sk-ant-oat-x'});
 await assert.rejects(resolveOmpCredential(wrongVersion.spawn,binary,root,await fileSha256(binary)),OmpRunnerHold);
}));

test('omp runner fingerprint includes the canonical authority, lifecycle and every reviewed image profile file',async()=>{
 const files=['district-omp-b-runner.ts','district-execution-profile.ts','district-assessment.ts','district-assessment-context.ts','district-claims.ts','civic-docker.ts','civic-opt-out.ts','../docker/omp-b/Dockerfile','../docker/omp-b/settings.yml','../docker/omp-b/entry.sh','../scripts/build-omp-b-image.sh'];
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
 for(const version of [OMP_VERSION,OMP_VERSION+'\r\n',OMP_VERSION+'\n\n',OMP_VERSION+'\nextra',' '+OMP_VERSION+'\n']){
  const mock=fakeSpawn({version,lists:['1. OAuth\n'],token:'sk-ant-oat-synthetic\n'});
  await assert.rejects(resolveOmpCredential(mock.spawn,binary,root,await fileSha256(binary)),OmpRunnerHold);
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
 assert.doesNotThrow(()=>inspectOmpEvents(eventStream([{type:'message_end',message:{...withoutId,completedAt:1791800000100}},{type:'agent_end',messages:[withoutId]}]),0));
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
  if(failure===null){const auth=await resolveOmpCredential(mock.spawn,binary,root,await fileSha256(binary));assert.equal(auth.token.toString(),'sk-ant-oat-synthetic');auth.token.fill(0);}
  else await assert.rejects(resolveOmpCredential(mock.spawn,binary,root,await fileSha256(binary)),OmpRunnerHold);
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
