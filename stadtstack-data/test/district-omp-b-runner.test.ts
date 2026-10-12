import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,chmod,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ChildProcess,SpawnOptions} from 'node:child_process';
import {inspectOmpEvents,resolveOmpCredential,ompRunnerContractSha256,OMP_RUNNER_VERSION,OMP_VERSION,OmpRunnerHold} from '../src/district-omp-b-runner.ts';
import {ompContainerEnvironment,ompExecutionArgs} from '../src/civic-docker.ts';
import {semanticHash,digest} from '../src/district-adapter-contract.ts';

const answer={itemId:'synthetic',outcome:'supported',assertions:[],scores:{correctness:1,sources:1,usefulness:1},holdReasons:[],rationale:'synthetic',valueReview:null};
function message(overrides:Record<string,unknown>={}){return {id:'msg-one',role:'assistant',provider:'anthropic',api:'anthropic-messages',model:'claude-haiku-5-5',stopReason:'stop',content:[{type:'text',text:JSON.stringify(answer)}],usage:{input_tokens:7,output_tokens:3},...overrides};}
function eventStream(events:unknown[]=[{type:'message_end',message:message()}]){return [{type:'session',id:'session-one'},...events].map(event=>JSON.stringify(event)).join('\n')+'\n';}

test('omp event inspection accepts a completed text-only message and repeated copies',()=>{
 const final=message();const inspected=inspectOmpEvents(eventStream([{type:'message_end',message:final},{type:'turn_end',message:final,toolResults:[],reason:'stop'},{type:'agent_end',messages:[final],reason:'stop'}]),0);
 assert.equal(inspected.returnedModel,'claude-haiku-5-5');assert.deepEqual(inspected.usage.topLevel,{inputTokens:7,outputTokens:3});
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
  eventStream([{type:'message_end',message:message()},{type:'message_end',message:message({id:'msg-two'})}]),
  '{bad json}\n',
  eventStream([]),
 ];
 for(const stdout of invalid)assert.throws(()=>inspectOmpEvents(stdout,0));
 assert.throws(()=>inspectOmpEvents(eventStream(),1));
});

test('omp argv and environment remain fixed and source-free',()=>{
 const args=ompExecutionArgs(),env=ompContainerEnvironment();
 assert.equal(args.includes('--api-key'),false);assert.equal(args.some(value=>/source text|database_url|proxy|broker|api[_-]?key/i.test(value)),false);
 assert.equal(env.some(value=>/source text|database_url|proxy|broker|api[_-]?key/i.test(value)),false);
 assert.equal(env.includes('ANTHROPIC_OAUTH_TOKEN=undefined'),false);assert.equal(env.includes('PI_CONFIG_DIR=.omp'),true);assert.equal(args.includes('--no-tools'),true);
});

function fakeSpawn(outputs:{version?:string;lists:string[];token:string;tokenExit?:number}):{spawn:(file:string,args:string[],options:SpawnOptions)=>ChildProcess;calls:Array<{file:string;args:string[];env:NodeJS.ProcessEnv}>}{
 const calls:Array<{file:string;args:string[];env:NodeJS.ProcessEnv}>=[];let listIndex=0;
 const spawn=(file:string,args:string[],options:SpawnOptions):ChildProcess=>{
  calls.push({file,args,env:options.env as NodeJS.ProcessEnv});const child=new EventEmitter() as ChildProcess;
  const stdin=new PassThrough(),stdout=new PassThrough(),stderr=new PassThrough();Object.assign(child,{stdin,stdout,stderr,kill:()=>true});
  let content='';if(args[0]==='--version')content=outputs.version??OMP_VERSION;
  else if(args[0]==='token'&&args[2]==='--list')content=outputs.lists[Math.min(listIndex++,outputs.lists.length-1)]??'';
  else if(args[0]==='token'&&args[2]==='--account')content=outputs.token;
  queueMicrotask(()=>{stdout.end(Buffer.from(content));stderr.end();child.emit('close',args[2]==='--account'?outputs.tokenExit??0:0,null);});
  return child;
 };
 return {spawn,calls};
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
 const files=['district-omp-b-runner.ts','district-assessment.ts','civic-docker.ts','civic-opt-out.ts','../docker/omp-b/Dockerfile','../docker/omp-b/settings.yml','../docker/omp-b/entry.sh','../scripts/build-omp-b-image.sh'];
 const expected=semanticHash({version:OMP_RUNNER_VERSION,files:await Promise.all(files.map(async file=>({file,sha256:digest(await readFile(new URL('../src/'+file,import.meta.url)))})))});
 assert.equal(await ompRunnerContractSha256(),expected);
});

test('omp image uses the pinned parser runtime without inherited environment and a POSIX first-line token entrypoint',async()=>{
 const dockerfile=await readFile(new URL('../docker/omp-b/Dockerfile',import.meta.url),'utf8'),parser=await readFile(new URL('../Dockerfile.parser',import.meta.url),'utf8');
 const base=parser.match(/^FROM (.+)$/m)?.[1];assert.ok(base);assert.ok(dockerfile.includes('FROM '+base+' AS runtime'));
 assert.match(dockerfile,/^FROM scratch$/m);assert.match(dockerfile,/^COPY --from=runtime \/ \/$/m);assert.match(dockerfile,/^USER 65534:65534$/m);
 const entrypoint=dockerfile.match(/^ENTRYPOINT (.+)$/m)?.[1];assert.ok(entrypoint);
 assert.deepEqual(JSON.parse(entrypoint),['/usr/bin/env','-i',...ompContainerEnvironment(),'/opt/stadtstack/entry.sh']);
 const environment=dockerfile.match(/^ENV ([\s\S]*?)^USER /m)?.[1];assert.ok(environment);
 assert.deepEqual(environment.replace(/\\\n\s*/g,' ').trim().split(/\s+/),ompContainerEnvironment());
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
