import {spawn as nodeSpawn,type ChildProcess, type SpawnOptions} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,mkdir,chmod,readFile} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {z} from 'zod';
import {canonicalDockerSocket,dockerDaemonIdentity} from './civic-docker.ts';
import {OMP_B_MODEL_MAX_TIME_SECONDS} from './district-execution-profile.ts';
import {canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {withManagedSourceScratch,type ManagedSourceContext,type ManagedDockerContainer} from './civic-opt-out.ts';
import {assessmentOutputSchema,PROMPTS} from './district-assessment.ts';
import {modelIdentitySha256,type ModelAnswer,type ReportedUsage,type TokenCounts,assertModelResponseIdentity} from './district-model-contract.ts';
import {assertAssessmentContextBound} from './district-assessment-context.ts';

export const OMP_VERSION='omp/18.9.2';
export const OMP_BINARY='/home/max/.local/bin/omp';
export const OMP_REVIEW_PATH='/etc/stadtstack/omp-b-review.json';
export const OMP_RUNNER_VERSION='district-omp-b-runner-v1';
export const OMP_LIMITS=Object.freeze({walltimeMs:240_000,modelMaxTimeSeconds:OMP_B_MODEL_MAX_TIME_SECONDS,inputBytes:512*1024,outputBytes:2*1024*1024,stderrBytes:16*1024,tokenBytes:16*1024});
const hash=z.string().regex(/^[a-f0-9]{64}$/),image=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const OmpReviewSchema=z.object({version:z.literal(OMP_RUNNER_VERSION),imageId:image,runnerContractSha256:hash,ompBinarySha256:hash,dockerDaemonId:z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/),securityReviewId:z.string().min(1).max(200),reviewedBy:z.string().min(1).max(200),reviewedAt:z.iso.datetime(),dockerSocket:z.string().regex(/^\/run\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.sock$/)}).strict();
export type OmpReview=z.infer<typeof OmpReviewSchema>;
export class OmpRunnerHold extends Error {
 readonly reason:'security_review_required'|'unavailable'|'credential_unavailable'|'request_rejected'|'resource_limit'|'provider_failed'|'event_stream'|'model_identity_mismatch';
 constructor(reason:OmpRunnerHold['reason']){super('Native omp assessment held');this.name='OmpRunnerHold';this.reason=reason;}
}
export type OmpSpawn=(file:string,args:string[],options:SpawnOptions)=>ChildProcess;
export interface OmpRunnerDependencies {spawn?:OmpSpawn;binary?:string;reviewPath?:string;beforeHandoff?:()=>Promise<void>}
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const oauthMarker=Buffer.from('sk-ant-oat','ascii');
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const tokenCount=(v:unknown):number|undefined=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:undefined;
function hasPrintableOAuthMarker(token:Buffer):boolean{
 if(token.indexOf(oauthMarker)<0)return false;
 for(const byte of token)if(byte<0x20||byte>0x7e)return false;
 return true;
}
function counts(v:unknown):TokenCounts{const x=object(v);return Object.fromEntries(Object.entries({inputTokens:tokenCount(x.input),outputTokens:tokenCount(x.output),cacheReadTokens:tokenCount(x.cacheRead),cacheCreationTokens:tokenCount(x.cacheWrite)}).filter(([,n])=>n!==undefined));}
const OmpTextUpdateSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('start')}).strict(),
 z.object({type:z.literal('text_start'),contentIndex:z.number().int().nonnegative()}).strict(),
 z.object({type:z.literal('text_delta'),contentIndex:z.number().int().nonnegative(),delta:z.string()}).strict(),
 z.object({type:z.literal('text_end'),contentIndex:z.number().int().nonnegative(),content:z.string()}).strict(),
 z.object({type:z.literal('done'),reason:z.literal('stop')}).strict(),
]);
export interface OmpAssessmentControl {prompt:string;systemPromptSha256:string;outputSchemaSha256:string}
/** Delivered control bytes, separate from the historical source request hash. */
export function ompAssessmentControl():OmpAssessmentControl{
 const schema=canonicalJson(z.toJSONSchema(assessmentOutputSchema)),prompt=PROMPTS.B+'\n\nReturn only JSON matching this exact frozen assessment output schema:\n'+schema+'\n';
 return {prompt,systemPromptSha256:sha(prompt),outputSchemaSha256:sha(schema)};
}
export function inspectOmpEvents(stdout:string,exitCode:number){
 if(exitCode!==0)throw new OmpRunnerHold('provider_failed');
 if(Buffer.byteLength(stdout)>OMP_LIMITS.outputBytes||!stdout.endsWith('\n'))throw new OmpRunnerHold('event_stream');
 const lines=stdout.split('\n');lines.pop();if(!lines.length)throw new OmpRunnerHold('event_stream');
 let final:Record<string,unknown>|undefined,finalLine='',turns=0,assistantStarts=0;const assistantMessages=new Map<string,string>();
 const rejectAssistant=(message:Record<string,unknown>)=>{
  if(message.role!=='assistant')return;
  const reason=String(message.stopReason??'');
  if(['length','toolUse','error','aborted','failed'].includes(reason))throw new OmpRunnerHold('provider_failed');
  if(message.completedAt!==undefined&&tokenCount(message.completedAt)===undefined)throw new OmpRunnerHold('event_stream');
  const {completedAt:_completedAt,...substantive}=message;
  // The session enriches only the message_end clone with completedAt. Every
  // other field, including content, timestamp, route, stop state and usage,
  // must agree across copies of one stable logical response.
  const responseId=typeof message.responseId==='string'&&message.responseId.length>0?message.responseId:null;
  if(responseId===null&&tokenCount(message.timestamp)===undefined)throw new OmpRunnerHold('event_stream');
  const identity=responseId===null?'timestamp:'+String(message.timestamp):'response:'+responseId,encoded=canonicalJson(substantive),previous=assistantMessages.get(identity);
  if(previous!==undefined&&previous!==encoded)throw new OmpRunnerHold('event_stream');
  assistantMessages.set(identity,encoded);if(assistantMessages.size>1)throw new OmpRunnerHold('event_stream');
  const content=Array.isArray(message.content)?message.content:[];
  if(content.some(block=>object(block).type!=='text'||typeof object(block).text!=='string'))throw new OmpRunnerHold('event_stream');
 };
 for(let i=0;i<lines.length;i++){
  const line=lines[i]!;let event:Record<string,unknown>;try{event=object(JSON.parse(line));}catch{throw new OmpRunnerHold('event_stream');}
  if(!Object.keys(event).length||typeof event.type!=='string')throw new OmpRunnerHold('event_stream');
  if(i===0){if(event.type!=='session')throw new OmpRunnerHold('event_stream');continue;}
  if(['tool_call','tool_result','tool_use','tool_progress','permission_request','error','aborted'].includes(event.type))throw new OmpRunnerHold('event_stream');
  if(!['turn_start','turn_end','message_start','message_update','message_end','agent_start','agent_end'].includes(event.type))throw new OmpRunnerHold('event_stream');
  if(event.type==='turn_start'&&++turns>1)throw new OmpRunnerHold('event_stream');
  if(event.type==='message_start'&&object(event.message).role==='assistant'&&++assistantStarts>1)throw new OmpRunnerHold('event_stream');
  if(['message_start','message_end'].includes(event.type)&&object(event.message).role==='toolResult')throw new OmpRunnerHold('event_stream');
  if(event.type==='message_update'){
   const update=object(event.assistantMessageEvent);
   if(update.type==='error'||update.type==='done'&&update.reason!=='stop')throw new OmpRunnerHold('provider_failed');
   if(typeof update.type==='string'&&update.type.startsWith('toolcall_'))throw new OmpRunnerHold('event_stream');
   if(!OmpTextUpdateSchema.safeParse(update).success)throw new OmpRunnerHold('event_stream');
  }
  if(event.type==='turn_end'){
   rejectAssistant(object(event.message));
   if(event.reason&&event.reason!=='stop')throw new OmpRunnerHold('provider_failed');
   if(Array.isArray(event.toolResults)&&event.toolResults.length)throw new OmpRunnerHold('event_stream');
  }
  if(event.type==='agent_end'){
   if(event.reason&&event.reason!=='stop')throw new OmpRunnerHold('provider_failed');
   if(Array.isArray(event.messages))for(const message of event.messages)rejectAssistant(object(message));
  }
  if(event.type==='message_end'){
   const message=object(event.message);if(message.role!=='assistant')continue;
   rejectAssistant(message);
   if(message.provider!=='anthropic'||message.api!=='anthropic-messages'||message.model!=='claude-haiku-5-5'||message.stopReason!=='stop')throw new OmpRunnerHold('model_identity_mismatch');
   if(message.upstreamModel!==undefined&&message.upstreamModel!=='claude-haiku-5-5')throw new OmpRunnerHold('model_identity_mismatch');
   const content=Array.isArray(message.content)?message.content:[];
   if(!content.length||content.some(block=>object(block).type!=='text'))throw new OmpRunnerHold('event_stream');
   if(!final){final=message;finalLine=line;}
  }
 }
 if(!final)throw new OmpRunnerHold('event_stream');
 const text=(final.content as Array<Record<string,unknown>>).map(block=>String(block.text)).join('');
 if(Buffer.byteLength(text)>96*1024)throw new OmpRunnerHold('resource_limit');
 let value:unknown;try{value=assessmentOutputSchema.parse(JSON.parse(text));}catch{throw new OmpRunnerHold('event_stream');}
 const usageRaw=object(final.usage),finalUsage=counts(usageRaw);
 const cost=object(usageRaw.cost).total,estimatedCost=typeof cost==='number'&&Number.isFinite(cost)&&cost>=0?cost:null;
 const usage:ReportedUsage={topLevel:Object.keys(finalUsage).length?finalUsage:null,perModel:{'claude-haiku-5-5':{...finalUsage,...(estimatedCost===null?{}:{cliEstimatedApiCostUsd:estimatedCost})}},cliEstimatedApiCostUsd:estimatedCost};
 return {value,responseSha256:sha(finalLine),returnedModel:'claude-haiku-5-5',reportedModels:['claude-haiku-5-5'],usage};
}
async function reviewFile(path:string,contract:string):Promise<OmpReview>{
 if(process.platform!=='linux')throw new OmpRunnerHold('unavailable');
 try{for(const p of ['/','/etc','/etc/stadtstack',path]){const s=await lstat(p);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0||(p===path?!s.isFile()||s.size>4096:!s.isDirectory()))throw new OmpRunnerHold('security_review_required');}
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let value:OmpReview;try{const st=await f.stat();if(st.uid!==0||(st.mode&0o022)!==0||st.size>4096)throw new OmpRunnerHold('security_review_required');value=OmpReviewSchema.parse(JSON.parse(await f.readFile('utf8')));}finally{await f.close();}
  if(value.runnerContractSha256!==contract||Date.parse(value.reviewedAt)>Date.now())throw new OmpRunnerHold('security_review_required');return value;
 }catch(e){if(e instanceof OmpRunnerHold)throw e;throw new OmpRunnerHold('security_review_required');}
}
export async function ompRunnerContractSha256(hash?:(file:string)=>Promise<string>):Promise<string>{
 const files=['district-omp-b-runner.ts','district-execution-profile.ts','district-assessment.ts','district-assessment-context.ts','district-claims.ts','civic-docker.ts','civic-opt-out.ts','../docker/omp-b/Dockerfile','../docker/omp-b/settings.yml','../docker/omp-b/entry.sh','../scripts/build-omp-b-image.sh'];
 const control=ompAssessmentControl();
 return semanticHash({version:OMP_RUNNER_VERSION,systemPromptSha256:control.systemPromptSha256,outputSchemaSha256:control.outputSchemaSha256,files:await Promise.all(files.map(async file=>({file,sha256:hash?await hash(file):digest(await readFile(new URL(file,import.meta.url)))})))});
}
/** Selector/lease identity excludes the independently reviewed host authority.
 * The mixed runner remains semantic for model framing, event decoding and CLI
 * arguments. runVmOmpAssessment still validates the live security contract. */
export async function ompRunnerOutputContractSha256(hash?:(file:string)=>Promise<string>):Promise<string>{
 const files=['district-omp-b-runner.ts','district-execution-profile.ts','district-assessment.ts','district-assessment-context.ts','district-claims.ts','../docker/omp-b/Dockerfile','../docker/omp-b/settings.yml','../docker/omp-b/entry.sh','../scripts/build-omp-b-image.sh'];
 const control=ompAssessmentControl();
 return semanticHash({version:OMP_RUNNER_VERSION,systemPromptSha256:control.systemPromptSha256,outputSchemaSha256:control.outputSchemaSha256,files:await Promise.all(files.map(async file=>({file,sha256:hash?await hash(file):digest(await readFile(new URL(file,import.meta.url)))})))});
}
function capture(spawn:OmpSpawn,file:string,args:string[],options:SpawnOptions,input:Buffer,limit:number,timeoutMs:number,signal?:AbortSignal):Promise<{stdout:Buffer;stderr:Buffer;code:number}>{
 const {promise,resolve,reject}=Promise.withResolvers<{stdout:Buffer;stderr:Buffer;code:number}>();
 let child:ChildProcess;try{child=spawn(file,args,{...options,signal,killSignal:'SIGKILL'});}catch{reject(new OmpRunnerHold('unavailable'));return promise;}
 const out:Buffer[]=[],errors:Buffer[]=[];let bytes=0,errorBytes=0,done=false;
 const finish=(error?:Error,code=1)=>{if(done)return;done=true;clearTimeout(timer);if(error){for(const chunk of out)chunk.fill(0);for(const chunk of errors)chunk.fill(0);reject(error);}else{const stdout=Buffer.concat(out,bytes),stderr=Buffer.concat(errors,errorBytes);for(const chunk of out)chunk.fill(0);for(const chunk of errors)chunk.fill(0);resolve({stdout,stderr,code});}};
 const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new OmpRunnerHold('resource_limit'));},timeoutMs);
 child.stdout?.on('data',(b:Buffer)=>{try{if(done)return;bytes+=b.length;if(bytes>limit){child.kill('SIGKILL');finish(new OmpRunnerHold('resource_limit'));}else out.push(Buffer.from(b));}finally{b.fill(0);}});
 child.stderr?.on('data',(b:Buffer)=>{try{if(done)return;errorBytes+=b.length;if(errorBytes>OMP_LIMITS.stderrBytes){child.kill('SIGKILL');finish(new OmpRunnerHold('resource_limit'));}else errors.push(Buffer.from(b));}finally{b.fill(0);}});
 child.on('error',()=>finish(new OmpRunnerHold('unavailable')));child.on('close',(code)=>finish(undefined,code??1));
 if(!child.stdin){child.kill('SIGKILL');finish(new OmpRunnerHold('unavailable'));return promise;}
 child.stdin.on('error',()=>{});child.stdin.end(input);return promise;
}
export interface ResolvedOmpCredential {token:Buffer;version:string;binarySha256:string;accountLabelSha256:string}
export async function resolveOmpCredential(spawn:OmpSpawn,binary:string,jobRoot:string,expectedBinarySha256:string,signal?:AbortSignal):Promise<ResolvedOmpCredential>{
 const env={HOME:'/home/max',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'};
 const initial=await lstat(binary).catch(()=>null);
 if(!initial||!initial.isFile()||initial.isSymbolicLink()||(initial.mode&0o022)!==0)throw new OmpRunnerHold('credential_unavailable');
 const binarySha256=sha(await readFile(binary));
 if(binarySha256!==expectedBinarySha256)throw new OmpRunnerHold('security_review_required');
 const version=await capture(spawn,binary,['--version'],{cwd:jobRoot,env,stdio:['pipe','pipe','pipe'],windowsHide:true},Buffer.alloc(0),1024,5000,signal);
 const versionMatches=version.code===0&&version.stdout.equals(Buffer.from(OMP_VERSION+'\n'));version.stdout.fill(0);version.stderr.fill(0);
 if(!versionMatches)throw new OmpRunnerHold('credential_unavailable');
 const list=async()=>capture(spawn,binary,['token','anthropic','--list'],{cwd:jobRoot,env,stdio:['pipe','pipe','pipe'],windowsHide:true},Buffer.alloc(0),16*1024,10_000,signal);
 const first=await list();if(first.code!==0){first.stdout.fill(0);first.stderr.fill(0);throw new OmpRunnerHold('credential_unavailable');}
 const text=first.stdout.toString('utf8'),accountList=Buffer.from(first.stdout),labels=text.split(/\r?\n/).filter(line=>line.trim());
 if(labels.length!==1||!/^1\. .+$/.test(labels[0]!)){accountList.fill(0);first.stdout.fill(0);first.stderr.fill(0);throw new OmpRunnerHold('credential_unavailable');}
 const accountLabelSha256=sha(labels[0]!);first.stdout.fill(0);first.stderr.fill(0);
 const tokenResult=await capture(spawn,binary,['token','anthropic','--account','1'],{cwd:jobRoot,env,stdio:['pipe','pipe','pipe'],windowsHide:true},Buffer.alloc(0),OMP_LIMITS.tokenBytes,10_000,signal);
 if(tokenResult.code!==0){tokenResult.stdout.fill(0);tokenResult.stderr.fill(0);throw new OmpRunnerHold('credential_unavailable');}
 let token=Buffer.from(tokenResult.stdout);tokenResult.stdout.fill(0);tokenResult.stderr.fill(0);
 if(token.length&&token[token.length-1]===10)token=token.subarray(0,token.length-1);
 if(token.length&&token[token.length-1]===13)token=token.subarray(0,token.length-1);
 if(token.includes(10)||token.includes(13)||!token.length||!hasPrintableOAuthMarker(token)){token.fill(0);throw new OmpRunnerHold('credential_unavailable');}
 const second=await list().catch(error=>{token.fill(0);accountList.fill(0);throw error;}),sameAccounts=second.code===0&&second.stdout.equals(accountList);accountList.fill(0);second.stdout.fill(0);second.stderr.fill(0);
 if(!sameAccounts){token.fill(0);throw new OmpRunnerHold('credential_unavailable');}
 const after=await lstat(binary).catch(()=>null);let afterSha:string;
 try{afterSha=sha(await readFile(binary));}catch{token.fill(0);throw new OmpRunnerHold('credential_unavailable');}
 if(!after||after.dev!==initial.dev||after.ino!==initial.ino||after.size!==initial.size||after.mtimeMs!==initial.mtimeMs||after.ctimeMs!==initial.ctimeMs||afterSha!==binarySha256){token.fill(0);throw new OmpRunnerHold('credential_unavailable');}
 return {token,version:OMP_VERSION,binarySha256,accountLabelSha256};
}
export interface OmpRunnerResult {answer:ModelAnswer;stdout:string;startedAt:string;finishedAt:string;imageId:string;settingsSha256:string;systemPromptSha256:string;outputSchemaSha256:string;accountLabelSha256:string;runnerContractSha256:string;toolVersion:string}
/** A failed control/provider lease must not quarantine the shared evidence CAS.
 * The sibling is separately enrolled with the same authority/source bindings. */
export function ompAssessmentScratchRoot(root:string):string{
 const path=resolve(root);return join(dirname(path),basename(path)+'-omp-b-scratch');
}
/** Only the trusted, source-free credential resolver runs on the host. All
 * assessment input/output and child writes belong to the registered lease. */
export async function runVmOmpAssessment(data:Record<string,unknown>,context:ManagedSourceContext,signal?:AbortSignal,deps:OmpRunnerDependencies={}):Promise<OmpRunnerResult>{
 assertAssessmentContextBound(data);
 const deadline=new AbortController(),started=Date.now(),timer=setTimeout(()=>deadline.abort(new OmpRunnerHold('resource_limit')),OMP_LIMITS.walltimeMs);
 const runSignal=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
 try{
  const contract=await ompRunnerContractSha256(),review=await reviewFile(deps.reviewPath??OMP_REVIEW_PATH,contract);
  runSignal.throwIfAborted();
  const socket=await canonicalDockerSocket(review.dockerSocket);
  if(await dockerDaemonIdentity(socket,runSignal)!==review.dockerDaemonId)throw new OmpRunnerHold('security_review_required');
  return await withManagedSourceScratch(ompAssessmentScratchRoot(context.root),context.bindings,async scope=>{
   let container:ManagedDockerContainer|undefined,token:Buffer|undefined,payload:Buffer|undefined;
   const output:Buffer[]=[],errors:Buffer[]=[];let outputBytes=0,errorBytes=0;
   const aborted=Promise.withResolvers<never>(),onAbort=()=>aborted.reject(scope.signal.reason);
   void aborted.promise.catch(()=>{});scope.signal.addEventListener('abort',onAbort,{once:true});
   try{
    await scope.assertActive();
    const credentialCwd=join(scope.directory,'host-control');await mkdir(credentialCwd,{mode:0o700});
    const auth=await resolveOmpCredential(deps.spawn??nodeSpawn,deps.binary??OMP_BINARY,credentialCwd,review.ompBinarySha256,scope.signal);token=auth.token;
    const controlContract=ompAssessmentControl(),settings=await readFile(new URL('../docker/omp-b/settings.yml',import.meta.url)),prompt=Buffer.from(controlContract.prompt);
    payload=Buffer.from(canonicalJson(data));
    if(payload.length>OMP_LIMITS.inputBytes)throw new OmpRunnerHold('request_rejected');
    await scope.assertActive();
    const control=join(scope.directory,'control');await mkdir(control,{mode:0o700});
    const file=await open(join(control,'system-prompt.md'),'wx',0o444);
    try{await file.writeFile(prompt);await file.sync();}finally{await file.close();}
    await chmod(control,0o755);
    container=await scope.createContainer({profile:'omp-b',socketPath:socket,daemonId:review.dockerDaemonId,imageId:review.imageId,contractSha256:contract,controlSha256:controlContract.systemPromptSha256,controlBytes:prompt.length});
    const session=await container.start(),streamFailure=Promise.withResolvers<never>();
    void streamFailure.promise.catch(()=>{});
    session.stdout.on('data',(chunk:Buffer)=>{
     try{outputBytes+=chunk.length;
      if(outputBytes>OMP_LIMITS.outputBytes){streamFailure.reject(new OmpRunnerHold('resource_limit'));deadline.abort(new OmpRunnerHold('resource_limit'));}
      else output.push(Buffer.from(chunk));
     }finally{chunk.fill(0);}
    });
    session.stderr.on('data',(chunk:Buffer)=>{
     try{errorBytes+=chunk.length;
      if(errorBytes>OMP_LIMITS.stderrBytes){streamFailure.reject(new OmpRunnerHold('resource_limit'));deadline.abort(new OmpRunnerHold('resource_limit'));}
      else errors.push(Buffer.from(chunk));
     }finally{chunk.fill(0);}
    });
    session.stdout.on('error',error=>streamFailure.reject(error));
    session.stderr.on('error',error=>streamFailure.reject(error));
    // This check is deliberately last, after attach/start and immediately before
    // the first source-bearing write; the broker rechecks fencing and policy.
    await Promise.race([deps.beforeHandoff?.()??Promise.resolve(),aborted.promise,streamFailure.promise]);
    await scope.assertActive();scope.signal.throwIfAborted();
    const startedAt=new Date().toISOString();
    const write=(bytes:Buffer)=>new Promise<void>((resolve,reject)=>session.stdin.write(bytes,error=>error?reject(error):resolve()));
    await Promise.race([write(token),aborted.promise,streamFailure.promise]);token.fill(0);token=undefined;
    await Promise.race([write(Buffer.from('\n')),aborted.promise,streamFailure.promise]);
    await Promise.race([new Promise<void>((resolve,reject)=>{session.stdin.once('error',reject);session.stdin.end(payload,()=>resolve());}),aborted.promise,streamFailure.promise]);
    payload.fill(0);payload=undefined;
    const result=await Promise.race([session.completion,aborted.promise,streamFailure.promise]);
    await scope.assertActive();
    const finishedAt=new Date().toISOString(),bytes=Buffer.concat(output,outputBytes),stdout=bytes.toString('utf8');bytes.fill(0);
    const parsed=inspectOmpEvents(stdout,result.exitCode);
    const modelEvidence={provider:'anthropic-subscription' as const,tool:'omp-cli' as const,model:'claude-haiku-5-5',toolVersion:auth.version+' sha256:'+auth.binarySha256,modelIdentitySha256:'',modelIdentityBasis:'reported-cli-model-and-tool-version' as const};
    modelEvidence.modelIdentitySha256=modelIdentitySha256(modelEvidence);
    const answer:ModelAnswer={...parsed,evidence:modelEvidence,requestedModel:'claude-haiku-5-5',runtimeWarnings:[]};assertModelResponseIdentity(answer);
    return {answer,stdout,startedAt,finishedAt,imageId:review.imageId,settingsSha256:sha(settings),systemPromptSha256:controlContract.systemPromptSha256,outputSchemaSha256:controlContract.outputSchemaSha256,accountLabelSha256:auth.accountLabelSha256,runnerContractSha256:contract,toolVersion:auth.version+' sha256:'+auth.binarySha256};
   }finally{
    scope.signal.removeEventListener('abort',onAbort);
    // Removal is independently supervised by the canonical authority. An
    // unconfirmed removal keeps the lease partial and its scratch inventoried.
    try{await container?.remove();}finally{token?.fill(0);payload?.fill(0);for(const chunk of output)chunk.fill(0);for(const chunk of errors)chunk.fill(0);}
   }
  },{...context,purpose:'artifact',signal:runSignal});
 }catch(error){
  if(error instanceof OmpRunnerHold)throw error;
  if(deadline.signal.aborted)throw new OmpRunnerHold('resource_limit');
  // Keep typed authority/fencing failures for the broker's held disposition.
  if(error instanceof Error&&('reasonCode' in error||'code' in error))throw error;
  throw new OmpRunnerHold('provider_failed');
 }finally{
  clearTimeout(timer);
  if(Date.now()-started>OMP_LIMITS.walltimeMs)throw new OmpRunnerHold('resource_limit');
 }
}
