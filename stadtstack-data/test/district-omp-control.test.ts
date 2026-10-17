import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,lstat,chmod,writeFile,rename,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOmpAssessmentControl,assertOmpAssessmentControl,inspectOmpAssessmentCompletion,inspectOmpEvents,OmpRunnerHold,OmpAssessmentOutputRejected,OmpOutputRejectionSchema,ompOutputRejectionVersions,ompOutputRejectionFromVersions,type OmpControlFileIdentity} from '../src/district-omp-b-runner.ts';
import {assessmentBridgeHoldReason,assessmentBridgeFailureVersions} from '../src/district-assessment-broker.ts';
import {formatDistrictBFailure} from '../src/district-exception-diagnostics.ts';
import {canonicalJson,digest} from '../src/district-adapter-contract.ts';

const execute=promisify(execFile),observedAt='2026-10-16T10:00:00.000Z';
const prompt=Buffer.from('Synthetic source-free assessment rubric.\n');
const delivery={requestSha256:digest('Synthetic request'),systemPromptSha256:digest(prompt),stdin:{intendedBytes:17,deliveredBytes:17,deliveredSha256:digest('Synthetic request'),frameBytes:42}};
const answer={itemId:'synthetic',outcome:'supported',assertions:[],scores:{correctness:1,sources:1,usefulness:1},holdReasons:[],rationale:'Synthetic assessment.',valueReview:null};
function stream(text=JSON.stringify(answer),overrides:Record<string,unknown>={}){
 const message={responseId:'synthetic-response',timestamp:1,role:'assistant',provider:'anthropic',api:'anthropic-messages',model:'claude-sonnet-5-5',stopReason:'stop',content:[{type:'text',text}],usage:{input:1,output:17},...overrides};
 return [{type:'session'},{type:'agent_start'},{type:'turn_start'},{type:'message_start',message:{role:'assistant'}},{type:'message_end',message},{type:'turn_end',message,toolResults:[]},{type:'agent_end',messages:[message]}].map(value=>JSON.stringify(value)).join('\n')+'\n';
}
async function fixture(work:(directory:string,identity:OmpControlFileIdentity)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'r1-omp-control-')),directory=join(root,'control');
 try{await work(directory,await createOmpAssessmentControl(directory,prompt));}finally{await rm(root,{recursive:true,force:true});}
}
function infrastructure(error:unknown):boolean{
 assert.ok(error instanceof OmpRunnerHold);assert.ok(!(error instanceof OmpAssessmentOutputRejected));
 assert.equal(error.reason,'request_rejected');assert.equal(error.decodeCheck,'control_file');
 assert.equal(error.containerExitCode,undefined);assert.equal(error.controlMode,undefined);
 assert.equal(assessmentBridgeHoldReason(error),'omp_request_rejected');return true;
}

test('B creates an exactly 0444 regular control under umask 077 without changing that umask',async()=>{
 const root=await mkdtemp(join(tmpdir(),'r1-omp-control-umask-')),directory=join(root,'control');
 try{
  const module=new URL('../src/district-omp-b-runner.ts',import.meta.url).href;
  const script=`import {createOmpAssessmentControl,assertOmpAssessmentControl} from ${JSON.stringify(module)};process.umask(0o077);const identity=await createOmpAssessmentControl(${JSON.stringify(directory)},Buffer.from(${JSON.stringify(prompt.toString())}));await assertOmpAssessmentControl(${JSON.stringify(directory)},identity);console.log(JSON.stringify({identity,umask:process.umask()}));`;
  const result=await execute(process.execPath,['--experimental-strip-types','--input-type=module','--eval',script],{env:{PATH:process.env.PATH},maxBuffer:4096});
  const {identity,umask}=JSON.parse(result.stdout),stat=await lstat(join(directory,'system-prompt.md'));
  assert.equal(umask,0o077);assert.equal(stat.mode&0o7777,0o444);assert.ok(stat.isFile());
  assert.equal(identity.mode,'0444');assert.equal(identity.uid,stat.uid);assert.equal(identity.gid,stat.gid);
  assert.equal(identity.bytes,prompt.length);assert.equal(identity.sha256,digest(prompt));
  assert.equal((await lstat(directory)).mode&0o7777,0o755);
 }finally{await rm(root,{recursive:true,force:true});}
});

for(const mode of [0o000,0o400,0o440,0o644,0o446,0o2444])test('B rejects control mode '+mode.toString(8)+' as infrastructure before source handoff',async()=>fixture(async(directory,identity)=>{
 await chmod(join(directory,'system-prompt.md'),mode);
 await assert.rejects(assertOmpAssessmentControl(directory,identity),infrastructure);
}));

test('B rechecks exact control bytes rather than accepting equal length and safe permissions',async()=>fixture(async(directory,identity)=>{
 const path=join(directory,'system-prompt.md'),changed=Buffer.alloc(prompt.length,0x78);
 await chmod(path,0o600);await writeFile(path,changed);await chmod(path,0o444);
 await assert.rejects(assertOmpAssessmentControl(directory,identity),infrastructure);
}));

test('B rejects a replacement inode even with the expected bytes and mode',async()=>fixture(async(directory,identity)=>{
 const path=join(directory,'system-prompt.md');await rename(path,path+'.previous');
 await writeFile(path,prompt,{mode:0o444});await chmod(path,0o444);
 await assert.rejects(assertOmpAssessmentControl(directory,identity),infrastructure);
}));

test('B rejects a symlink instead of following a readable control lookalike',async()=>fixture(async(directory,identity)=>{
 const path=join(directory,'system-prompt.md');await rename(path,path+'.previous');await symlink(path+'.previous',path);
 await assert.rejects(assertOmpAssessmentControl(directory,identity),infrastructure);
}));

test('B checks control ownership and container-traversable parent permissions',async()=>fixture(async(directory,identity)=>{
 await assert.rejects(assertOmpAssessmentControl(directory,{...identity,uid:identity.uid+1}),infrastructure);
 await assert.rejects(assertOmpAssessmentControl(directory,{...identity,gid:identity.gid+1}),infrastructure);
 await chmod(directory,0o700);await assert.rejects(assertOmpAssessmentControl(directory,identity),infrastructure);
}));

for(const text of [JSON.stringify(answer),'Synthetic prose, not an assessment JSON object.'])for(const channel of ['stderr','stream-log','raw-log'] as const)test('prompt fallback warning preempts '+(text.startsWith('{')?'valid':'invalid')+' output via '+channel,()=>{
 const warning='Could not read system prompt file',privateDetail='PRIVATE_ERROR sk-ant-oat-synthetic /private/account';
 const log=JSON.stringify({level:'warn',message:warning,path:'/control/system-prompt.md',error:privateDetail});
 const stdout=(channel==='stream-log'?log+'\n':channel==='raw-log'?'WARN '+warning+' '+privateDetail+'\n':'')+stream(text),stderr=channel==='stderr'?log:'';
 assert.throws(()=>inspectOmpAssessmentCompletion(stdout,stderr,0,delivery,observedAt,'0444'),(error:unknown)=>{
  assert.ok(error instanceof OmpRunnerHold);assert.ok(!(error instanceof OmpAssessmentOutputRejected));assert.equal(error.reason,'request_rejected');assert.equal(error.decodeCheck,'control_prompt_unavailable');
  assert.equal(assessmentBridgeHoldReason(error),'omp_request_rejected');
  const versions=assessmentBridgeFailureVersions('synthetic-lease',error);
  assert.equal(versions.ompControlMode,'0444');assert.equal(versions.ompOutputRejectionVersion,undefined);
  const diagnostic=formatDistrictBFailure('a'.repeat(64),'assessment_b',{outcome:'held_execution',reasonCode:'omp_request_rejected',versions});
  assert.match(diagnostic!,/kind=control_prompt_unavailable exit=0 check=control_prompt_unavailable control_mode=0444/);
  assert.doesNotMatch(JSON.stringify(versions)+diagnostic,/PRIVATE_ERROR|sk-ant-oat|private\/account|system-prompt\.md/);return true;
 });
});

test('prompt warning text inside a real assistant answer is not a transport warning',()=>{
 const value={...answer,rationale:'Could not read system prompt file'};
 assert.deepEqual(inspectOmpAssessmentCompletion(stream(JSON.stringify(value)),'',0,delivery,observedAt,'0444').value,value);
});

test('a prompt fallback keeps a genuine usage hold but cannot certify a safe no-output retry',()=>{
 const error={type:'rate_limit_error',reset_at:'2026-10-16T11:00:00Z',message:'PRIVATE_PROVIDER_ERROR'};
 const stdout=stream('',{stopReason:'error',content:[],errorMessage:'429 '+JSON.stringify(error)});
 assert.throws(()=>inspectOmpAssessmentCompletion(stdout,'Could not read system prompt file',0,delivery,observedAt,'0444'),(failure:unknown)=>{
  assert.ok(failure instanceof OmpRunnerHold);assert.ok(!(failure instanceof OmpAssessmentOutputRejected));
  assert.equal(assessmentBridgeHoldReason(failure),'budget_paused');assert.ok(failure.subscriptionLimit);
  assert.equal(failure.noOutput,false);assert.equal(failure.decodeCheck,'control_prompt_unavailable');assert.equal(failure.controlMode,'0444');return true;
 });
});

test('v1 v2 and v3 immutable rejection proofs retain their original canonical bytes without a control-mode prerequisite',()=>{
 let current:unknown;
 try{inspectOmpEvents(stream('Synthetic non-JSON answer.'),0,delivery);}catch(error){assert.ok(error instanceof OmpAssessmentOutputRejected);current=error.rejection;}
 const base={check:'output_json',streamSha256:digest('Historical synthetic stream'),outputSha256:digest('Historical synthetic output'),issueCount:1,issues:[{code:'invalid_json',path:'$'}]};
 for(const value of [{...base,version:'omp-output-rejection-v1'},{...base,version:'omp-output-rejection-v2'},current]){
  const proof=OmpOutputRejectionSchema.parse(value),before=canonicalJson(proof),versions=ompOutputRejectionVersions(proof);
  assert.equal(versions.ompControlMode,undefined);
  for(const metadata of [versions,{...versions,ompControlMode:'0444'}]){
   const decoded=ompOutputRejectionFromVersions(metadata);assert.equal(canonicalJson(decoded),before);assert.equal(digest(canonicalJson(decoded)),digest(before));
  }
 }
});
