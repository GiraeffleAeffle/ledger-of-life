import {spawn as nodeSpawn,type ChildProcess, type SpawnOptions} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants,type Stats} from 'node:fs';
import {lstat,open,mkdir,chmod,readFile} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {z} from 'zod';
import type {Writable} from 'node:stream';
import {canonicalDockerSocket,dockerDaemonIdentity} from './civic-docker.ts';
import {OMP_B_MODEL_MAX_TIME_SECONDS} from './district-execution-profile.ts';
import {canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {withManagedSourceScratch,type ManagedSourceContext,type ManagedDockerContainer} from './civic-opt-out.ts';
import {assessmentOutputSchema,PROMPTS} from './district-assessment.ts';
import {modelIdentitySha256,type ModelAnswer,type ReportedUsage,type TokenCounts} from './district-model-contract.ts';
import {assertAssessmentContextBound} from './district-assessment-context.ts';
import {NATIVE_B_MODEL,assertNativeBResponseIdentity} from './district-b-native-model.ts';
import {ompSubscriptionLimit,type SubscriptionLimit,type OmpLimitFailureProof} from './district-subscription-limit.ts';
import {OmpContainerExitCodeSchema,OmpDecodeCheckSchema,type OmpDecodeCheck,type OmpFailureKind} from './district-exception-diagnostics.ts';
import {describeOmpOutput,exactOmpJsonFence,OmpOutputStructureSchema,ompOutputStructureVersions,ompOutputStructureFromVersions,type OmpOutputStructure,type OmpOutputDelivery,type OmpStdinDelivery} from './district-omp-output-diagnostics.ts';
export interface OmpParsedEvents {value:unknown;responseSha256:string;returnedModel:string;reportedModels:string[];usage:ReportedUsage;outputStructure:OmpOutputStructure;outputNormalization?:OmpOutputNormalization}

export const OMP_VERSION='omp/18.9.2';
export const OMP_HOST_BINARY='/usr/local/lib/stadtstack/omp-b/omp-host-18.10.4';
export const OMP_HOST_VERSION='omp/18.10.4';
export const OMP_REVIEW_PATH='/etc/stadtstack/omp-b-review.json';
export const OMP_RUNNER_VERSION='district-omp-b-runner-v1';
export const OMP_LIMITS=Object.freeze({walltimeMs:240_000,modelMaxTimeSeconds:OMP_B_MODEL_MAX_TIME_SECONDS,inputBytes:512*1024,outputBytes:2*1024*1024,stderrBytes:16*1024,tokenBytes:16*1024});
const hash=z.string().regex(/^[a-f0-9]{64}$/),image=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const OmpReviewSchema=z.object({version:z.literal(OMP_RUNNER_VERSION),imageId:image,runnerContractSha256:hash,ompBinarySha256:hash,hostResolverBinarySha256:hash,hostResolverVersion:z.literal(OMP_HOST_VERSION),dockerDaemonId:z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/),securityReviewId:z.string().min(1).max(200),reviewedBy:z.string().min(1).max(200),reviewedAt:z.iso.datetime(),dockerSocket:z.string().regex(/^\/run\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.sock$/)}).strict();
export type OmpReview=z.infer<typeof OmpReviewSchema>;
export class OmpRunnerHold extends Error {
 readonly reason:'security_review_required'|'unavailable'|'credential_unavailable'|'request_rejected'|'resource_limit'|'provider_failed'|'event_stream'|'model_identity_mismatch';
 readonly subscriptionLimit?:SubscriptionLimit;
 readonly noOutput:boolean;
 readonly failureProof?:OmpLimitFailureProof;
 readonly failureKind?:OmpFailureKind;
 /** Present only after an actual container completion, never a guessed code. */
 readonly containerExitCode?:number;
 readonly decodeCheck?:OmpDecodeCheck;
 readonly controlMode?:'0444';
 constructor(reason:OmpRunnerHold['reason'],limit?:{limit:SubscriptionLimit;noOutput:boolean;failureProof:OmpLimitFailureProof},failureKind?:OmpFailureKind,containerExitCode?:number,decodeCheck?:OmpDecodeCheck,controlMode?:'0444'){super('Native omp assessment held');this.name='OmpRunnerHold';this.reason=reason;this.subscriptionLimit=limit?.limit;this.noOutput=limit?.noOutput??false;this.failureProof=limit?.failureProof;this.failureKind=reason==='provider_failed'?(failureKind??'exception_other'):undefined;const exit=OmpContainerExitCodeSchema.safeParse(containerExitCode);this.containerExitCode=exit.success?exit.data:undefined;const check=OmpDecodeCheckSchema.safeParse(decodeCheck);this.decodeCheck=check.success?check.data:undefined;this.controlMode=controlMode==='0444'?controlMode:undefined;}
}
export type OmpSpawn=(file:string,args:string[],options:SpawnOptions)=>ChildProcess;
export interface OmpRunnerDependencies {spawn?:OmpSpawn;reviewPath?:string;beforeHandoff?:()=>Promise<void>}
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
// Only frozen-schema paths enter diagnostics; record keys/indices become wildcards.
const outputJsonSchema=object(z.toJSONSchema(assessmentOutputSchema));
const approvedOutputPaths=new Set<string>();
const outputObjectKeys:{path:string;keys:string[]}[]=[];
function collectOutputPaths(schema:Record<string,unknown>,path:string,depth=0):void{
 if(Buffer.byteLength(JSON.stringify(path))>200)return;
 approvedOutputPaths.add(path);if(depth>=12)return;
 if(schema.type==='object')outputObjectKeys.push({path,keys:Object.keys(object(schema.properties))});
 if(typeof schema.$ref==='string'&&schema.$ref.startsWith('#/')){
  let target:unknown=outputJsonSchema;for(const key of schema.$ref.slice(2).split('/'))target=object(target)[key.replaceAll('~1','/').replaceAll('~0','~')];
  collectOutputPaths(object(target),path,depth+1);
 }
 for(const [key,value] of Object.entries(object(schema.properties)))collectOutputPaths(object(value),path+'.'+key,depth+1);
 if(schema.items&&typeof schema.items==='object')collectOutputPaths(object(schema.items),path+'[]',depth+1);
 if(schema.additionalProperties&&typeof schema.additionalProperties==='object')collectOutputPaths(object(schema.additionalProperties),path+'.*',depth+1);
 for(const kind of ['anyOf','oneOf','allOf'])if(Array.isArray(schema[kind]))for(const branch of schema[kind])collectOutputPaths(object(branch),path,depth+1);
}
collectOutputPaths(outputJsonSchema,'$');
const OmpOutputIssueCodeSchema=z.enum(['invalid_json','invalid_type','too_big','too_small','invalid_format','not_multiple_of','unrecognized_keys','invalid_union','invalid_key','invalid_element','invalid_value','custom','other']);
const OmpOutputPathSchema=z.enum([...approvedOutputPaths] as [string,...string[]]);
const OmpOutputObjectPathSchema=z.enum([...new Set(outputObjectKeys.map(({path})=>path))] as [string,...string[]]);
const OmpV1OutputIssueSchema=z.object({code:OmpOutputIssueCodeSchema,path:OmpOutputPathSchema}).strict();
const OmpV2OutputIssueSchema=z.discriminatedUnion('code',[
 z.object({code:z.literal('unrecognized_keys'),path:OmpOutputObjectPathSchema,keyCount:z.number().int().positive().max(96*1024)}).strict(),
 z.object({code:OmpOutputIssueCodeSchema.exclude(['unrecognized_keys']),path:OmpOutputPathSchema}).strict(),
]);
export const OmpOutputNormalizationSchema=z.literal('single-json-fence-v1');
export type OmpOutputNormalization=z.infer<typeof OmpOutputNormalizationSchema>;
// Immutable historical proofs keep their original strict fields and hashes.
const OmpV1OutputRejectionSchema=z.object({
 version:z.literal('omp-output-rejection-v1'),check:z.enum(['output_json','output_schema']),streamSha256:hash,outputSha256:hash,
 issueCount:z.number().int().positive(),issues:z.array(OmpV1OutputIssueSchema).min(1).max(32),
}).strict();
const OmpV2OutputRejectionSchema=z.object({
 version:z.literal('omp-output-rejection-v2'),check:z.enum(['output_json','output_schema']),streamSha256:hash,outputSha256:hash,
 issueCount:z.number().int().positive(),issues:z.array(OmpV2OutputIssueSchema).min(1).max(32),
 outputNormalization:OmpOutputNormalizationSchema.optional(),
}).strict();
const OmpV3OutputRejectionSchema=OmpV2OutputRejectionSchema.extend({version:z.literal('omp-output-rejection-v3'),structure:OmpOutputStructureSchema}).strict();
export const OmpOutputRejectionSchema=z.discriminatedUnion('version',[OmpV1OutputRejectionSchema,OmpV2OutputRejectionSchema,OmpV3OutputRejectionSchema])
 .refine(value=>value.issues.length===Math.min(value.issueCount,32));
export type OmpOutputRejection=z.infer<typeof OmpOutputRejectionSchema>;
export class OmpAssessmentOutputRejected extends OmpRunnerHold{
 readonly rejection:OmpOutputRejection;
 constructor(rejection:OmpOutputRejection,controlMode?:'0444'){const checked=OmpOutputRejectionSchema.parse(rejection);super('event_stream',undefined,undefined,0,checked.check,controlMode);this.rejection=checked;}
}
/** Each receipt version value must fit the existing 256-byte identifier codec. */
export function ompOutputRejectionVersions(input:OmpOutputRejection):Record<string,string>{
 const proof=OmpOutputRejectionSchema.parse(input);
 const versions:Record<string,string>={ompOutputRejectionVersion:proof.version,ompDecodeCheck:proof.check,ompOutputStreamSha256:proof.streamSha256,ompOutputSha256:proof.outputSha256,ompOutputIssueCount:String(proof.issueCount)};
 if(proof.version!=='omp-output-rejection-v1'&&proof.outputNormalization)versions.ompOutputNormalization=proof.outputNormalization;
 if(proof.version==='omp-output-rejection-v3')Object.assign(versions,ompOutputStructureVersions(proof.structure));
 proof.issues.forEach((issue,index)=>{versions['ompOutputIssue'+index]=canonicalJson(issue);});
 return versions;
}
export function ompOutputRejectionFromVersions(versions:Record<string,string>):OmpOutputRejection|null{
 if(!['omp-output-rejection-v1','omp-output-rejection-v2','omp-output-rejection-v3'].includes(versions.ompOutputRejectionVersion??''))return null;
 const count=Number(versions.ompOutputIssueCount);
 if(!Number.isSafeInteger(count)||count<1||String(count)!==versions.ompOutputIssueCount)return null;
 const length=Math.min(count,32),issues:unknown[]=[];
 for(const key of Object.keys(versions))if(/^ompOutputIssue\d+$/.test(key)){
  const index=Number(key.slice('ompOutputIssue'.length));if(index>=length||key!=='ompOutputIssue'+index)return null;
 }
 for(let index=0;index<length;index++){
  const encoded=versions['ompOutputIssue'+index];if(typeof encoded!=='string'||Buffer.byteLength(encoded)>256)return null;
  try{issues.push(JSON.parse(encoded));}catch{return null;}
 }
 const proof=OmpOutputRejectionSchema.safeParse({version:versions.ompOutputRejectionVersion,check:versions.ompDecodeCheck,streamSha256:versions.ompOutputStreamSha256,outputSha256:versions.ompOutputSha256,issueCount:count,issues,...versions.ompOutputRejectionVersion!=='omp-output-rejection-v1'&&versions.ompOutputNormalization!==undefined?{outputNormalization:versions.ompOutputNormalization}:{},...versions.ompOutputRejectionVersion==='omp-output-rejection-v3'?{structure:ompOutputStructureFromVersions(versions)}:{}});
 return proof.success?proof.data:null;
}
function outputIssuePath(parts:readonly PropertyKey[]):string{
 let path='$';
 for(const part of parts){
  const candidate=typeof part==='number'?path+'[]':typeof part==='string'?path+'.'+part:'';
  if(approvedOutputPaths.has(candidate))path=candidate;
  else if(typeof part==='string'&&approvedOutputPaths.has(path+'.*'))path+='.*';
  else break;
 }
 return path;
}
function outputRejection(stdout:string,text:string,structure:OmpOutputStructure,check:OmpOutputRejection['check'],issues?:readonly z.core.$ZodIssue[],outputNormalization?:OmpOutputNormalization):OmpAssessmentOutputRejected{
 const diagnostics:z.infer<typeof OmpV2OutputIssueSchema>[]=[];let issueCount=0;
 function collect(found:readonly z.core.$ZodIssue[]):void{
  for(const issue of found){
   if(issue.code==='invalid_union'&&issue.errors.some(branch=>branch.length)){for(const branch of issue.errors)collect(branch);continue;}
   issueCount++;if(diagnostics.length>=32)continue;
   const code=OmpOutputIssueCodeSchema.safeParse(issue.code),path=outputIssuePath(issue.path);
   if(issue.code==='unrecognized_keys')diagnostics.push({code:'unrecognized_keys',path,keyCount:issue.keys.length});
   else diagnostics.push({code:code.success&&code.data!=='unrecognized_keys'?code.data:'other',path});
  }
 }
 if(issues)collect(issues);else{issueCount=1;diagnostics.push({code:'invalid_json',path:'$'});}
 return new OmpAssessmentOutputRejected({version:'omp-output-rejection-v3',check,streamSha256:sha(stdout),outputSha256:sha(text),issueCount,issues:diagnostics,structure,...outputNormalization?{outputNormalization}:{}});
}
export interface OmpAssessmentControl {prompt:string;systemPromptSha256:string;outputSchemaSha256:string}
/** Delivered control bytes, separate from the historical source request hash. */
export function ompAssessmentControl():OmpAssessmentControl{
 const schema=canonicalJson(outputJsonSchema),keys=outputObjectKeys.map(({path,keys})=>'- '+path+': '+keys.join(', ')).join('\n');
 const prompt=PROMPTS.B+'\n\nReturn only JSON matching this exact frozen assessment output schema:\n'+schema
  +'\n\nAllowed output property names per object (repeated paths are alternative key sets):\n'+keys
  +'\n\nReturn exactly one JSON object. Its first character must be { and its last character must be }. No Markdown, code fences, commentary, or surrounding text. Use ONLY the listed property names at every object level. For alternative key sets select one complete schema branch; never combine branches. Do not add input metadata or JSON-Schema keywords as output properties. Required fields, values and nullability must match the frozen schema exactly.\n'
  +'\nOutput encoding rules only: do not change a source-bound judgment, erase uncertainty, or remove applicable holdReasons to satisfy formatting.\n'
  +'- Copy itemId exactly. Every assertion claimId must belong to input claimIds and occur at most once. If outcome is supported and valueTarget is absent, include every input claimId exactly once. Supported output requires an assertion unless valueReview.kind is abstention.\n'
  +'- If outcome is abstain OR unresolved, scores.usefulness must be 0. This also applies to any valueReview.kind of abstention. It is an encoding rule, not a direction to choose any outcome.\n'
  +'- Assertion value and unit must be both null or both non-null. Use only source-attested units; never invent a unit to satisfy the pair. A nonquantitative proposition with no applicable unit can be verified through its claimId and exact locator quote with both fields null. Never erase an evidenced quantity or its uncertainty merely to satisfy this encoding.\n'
  +'- A non-null assertion date must be a real calendar day encoded exactly YYYY-MM-DD and must have a non-null source-attested dateRole. Never invent a day for month/year/period precision: keep date null and preserve the partial precision in the claim-bound exact quote. When date is null, dateRole may retain an attested role; the checker does not require dateRole to be null.\n'
  +'- Assertion sourceId and locatorId must identify the supplied original evidence, and quote must equal the complete selected locator quote, not a substring or paraphrase. Native assertions must copy one complete supplied nativeLocator into nativeEvidence with its exact original sourceSha256. Non-null subjectId/objectId must belong to input entityIds; if that list is empty both must be null.\n'
  +'- Always include valueReview and criticalReview. When the corresponding valueTarget or criticalTarget is absent, use explicit null, not an empty object, invented review, or omitted property. When present, use its complete schema branch and exact supplied binding IDs/hashes.\n'
  +'- For valueReview, its correctness.score, sourcing.score and usefulness.score must equal output scores.correctness, scores.sources and scores.usefulness. data_missing must equal (missing.length > 0); kind substantive requires data_missing false. Citation record/source IDs, URL and source hashes must resolve to the exact supplied record and original attribution; copy evidence rather than inventing aliases.\n'
  +'- A criticalReview must cover each criticalTarget claim exactly once, with no extra or duplicate claimIds and exact claimSha256 values, recordId, recordEvidenceSha256 and claimProjectionSha256. If output outcome is supported, every criticalReview claim verdict must be supported; otherwise do not alter verdicts to fit this conditional rule.\n';
 return {prompt,systemPromptSha256:sha(prompt),outputSchemaSha256:sha(schema)};
}
/** The reviewed stock CLI drops update/error payloads but retains errorStatus
 * and errorId on final assistant copies. Inspect those typed fields only. */
function typedOmpProviderFailure(value:Record<string,unknown>):OmpFailureKind|undefined {
 const error=object(value.error),status=value.errorStatus??error.status??error.statusCode??value.status??value.statusCode;
 if(typeof status==='number'&&Number.isInteger(status)&&status>=400&&status<=599){
  if(status===401||status===403)return 'provider_error_auth';
  if(status===429)return 'provider_error_rate_limit';
  if(status===529)return 'provider_error_overloaded';
  if(status===404)return 'provider_error_not_found';
  if(status===408)return 'provider_error_network';
  return status>=500?'provider_error_server':'provider_error_invalid_request';
 }
 const type=value.errorType??error.type??value.type;
 switch(type){
  case 'authentication_error':case 'permission_error':return 'provider_error_auth';
  case 'rate_limit_error':return 'provider_error_rate_limit';
  case 'overloaded_error':return 'provider_error_overloaded';
  case 'invalid_request_error':return 'provider_error_invalid_request';
  case 'not_found_error':return 'provider_error_not_found';
  case 'api_error':case 'internal_server_error':return 'provider_error_server';
  case 'connection_error':case 'network_error':case 'timeout_error':return 'provider_error_network';
 }
 const code=error.code??value.code;
 if(typeof code==='string'&&['ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT'].includes(code))return 'provider_error_network';
 // v18.9.2 AIError.Flag values: AuthFailed/OAuthExpiry, UsageLimit, Timeout.
 // A generic Transient flag alone does not establish a network failure.
 const id=value.errorId;
 if(typeof id==='number'&&Number.isSafeInteger(id)&&id>0&&id<=0xffffffff){
  if(id&(0x01000000|0x40000000))return 'provider_error_auth';
  if(id&0x00080000)return 'provider_error_rate_limit';
  if(id&0x00040000)return 'provider_error_network';
  return 'provider_error_unknown';
 }
 if(typeof type==='string')return 'provider_error_unknown';
}
function typedOmpAssistantFailure(value:unknown):OmpFailureKind|undefined {
 const message=object(value);
 if(message.role==='assistant'&&['error','aborted','failed'].includes(String(message.stopReason)))return typedOmpProviderFailure(message);
}
function ompProviderFailure(stdout:string):OmpFailureKind|undefined {
 if(Buffer.byteLength(stdout)>OMP_LIMITS.outputBytes||!stdout.endsWith('\n'))return;
 let found:OmpFailureKind|undefined,index=0;
 // This diagnostic-only scan runs on an already-rejected provider path. It
 // cannot admit output, grant a retry, change accounting or loosen framing.
 for(const line of stdout.slice(0,-1).split('\n')){
  let event:Record<string,unknown>;try{event=object(JSON.parse(line));}catch{return;}
  if(typeof event.type!=='string'||index++===0&&event.type!=='session')return;
  if(found&&found!=='provider_error_unknown')continue;
  let candidate:OmpFailureKind|undefined;
  if(['message_end','turn_end'].includes(event.type))candidate=typedOmpAssistantFailure(event.message);
  else if(event.type==='agent_end'&&Array.isArray(event.messages)){
   for(const message of event.messages){
    const kind=typedOmpAssistantFailure(message);
    if(kind)candidate=kind;
    if(candidate&&candidate!=='provider_error_unknown')break;
   }
  }else if(event.type==='message_update'){
   const update=object(event.assistantMessageEvent);
   if(update.type==='error')candidate=typedOmpProviderFailure(object(update.error));
  }else if(event.type==='error')candidate=typedOmpProviderFailure(event);
  if(candidate)found=candidate;
 }
 return found;
}
function ompProviderHold(stdout:string,fallback:OmpFailureKind,exitCode:number):OmpRunnerHold {
 return new OmpRunnerHold('provider_failed',undefined,ompProviderFailure(stdout)??fallback,exitCode);
}
export function inspectOmpEvents(stdout:string,exitCode:number,delivery:OmpOutputDelivery,expectedModel:typeof NATIVE_B_MODEL|'claude-haiku-5-5'=NATIVE_B_MODEL){
 if(exitCode!==0)throw ompProviderHold(stdout,'exit_nonzero',exitCode);
 function fail(check:OmpDecodeCheck):never{throw new OmpRunnerHold('event_stream',undefined,undefined,exitCode,check);}
 if(Buffer.byteLength(stdout)>OMP_LIMITS.outputBytes)fail('stream_size');
 if(!stdout.length)fail('empty_stream');
 if(!stdout.endsWith('\n'))fail('final_newline');
 const lines=stdout.split('\n');lines.pop();
 let final:Record<string,unknown>|undefined,finalLine='',turns=0,assistantStarts=0,agentStarted=false,assistantEnded=false,turnEnded=false,agentEnded=false;
 let openMessage:'user'|'assistant'|undefined;
 const assistantMessages=new Map<string,string>();
 const textUpdates=new Map<number,{deltas:string[];text?:string}>();
 const rejectAssistant=(message:Record<string,unknown>)=>{
  if(message.role!=='assistant')return;
  const reason=String(message.stopReason??'');
  if(['length','toolUse','error','aborted','failed'].includes(reason))throw ompProviderHold(stdout,reason==='length'?'stop_length':reason==='error'?'stop_error':'stop_other',exitCode);
  if(message.completedAt!==undefined&&tokenCount(message.completedAt)===undefined)fail('completed_at');
  const {completedAt:_completedAt,...substantive}=message;
  // The session enriches only the message_end clone with completedAt. Every
  // other field, including content, timestamp, route, stop state and usage,
  // must agree across copies of one stable logical response.
  const responseId=typeof message.responseId==='string'&&message.responseId.length>0?message.responseId:null;
  if(responseId===null&&tokenCount(message.timestamp)===undefined)fail('assistant_identity');
  const identity=responseId===null?'timestamp:'+String(message.timestamp):'response:'+responseId,encoded=canonicalJson(substantive),previous=assistantMessages.get(identity);
  if(previous!==undefined&&previous!==encoded)fail('assistant_copy_mismatch');
  assistantMessages.set(identity,encoded);if(assistantMessages.size>1)fail('multiple_assistant_messages');
  const content=Array.isArray(message.content)?message.content:[];
  if(content.some(block=>object(block).type!=='text'||typeof object(block).text!=='string'))fail('assistant_content');
 };
 for(let i=0;i<lines.length;i++){
  const line=lines[i]!;let event:Record<string,unknown>;try{event=object(JSON.parse(line));}catch{fail('event_json');}
  if(!Object.keys(event).length||typeof event.type!=='string')fail('event_envelope');
  if(i===0){if(event.type!=='session')fail('session_header');continue;}
  if(['tool_call','tool_result','tool_use','tool_progress','permission_request','error','aborted'].includes(event.type))fail('forbidden_event');
  if(!['turn_start','turn_end','message_start','message_update','message_end','agent_start','agent_end'].includes(event.type))fail('unknown_event');
  if(event.type==='agent_start'){if(agentStarted||i!==1)fail('event_order');agentStarted=true;continue;}
  if(event.type==='turn_start'){if(++turns>1)fail('multiple_turns');if(!agentStarted||turnEnded)fail('event_order');continue;}
  if(event.type==='message_start'&&object(event.message).role==='assistant'&&++assistantStarts>1)fail('multiple_assistant_starts');
  if(['message_start','message_end'].includes(event.type)){
   const role=object(event.message).role;if(role==='toolResult')fail('tool_result');
   if(role!=='user'&&role!=='assistant')fail('message_role');
   if(!agentStarted||turns!==1||turnEnded||assistantEnded&&event.type==='message_start')fail('event_order');
   if(event.type==='message_start'){
    if(openMessage||role==='user'&&assistantStarts!==0)fail('event_order');openMessage=role;
   }else{
    if(openMessage!==role)fail('event_order');openMessage=undefined;
   }
  }
  if(event.type==='message_update'){
   const update=object(event.assistantMessageEvent);
   if(update.type==='error')throw ompProviderHold(stdout,'stream_update_error',exitCode);
   if(update.type==='done'&&update.reason!=='stop')throw ompProviderHold(stdout,update.reason==='length'?'stop_length':update.reason==='error'?'stop_error':'stop_other',exitCode);
   if(typeof update.type==='string'&&update.type.startsWith('toolcall_'))fail('tool_update');
   const checkedUpdate=OmpTextUpdateSchema.safeParse(update);
   if(!checkedUpdate.success)fail('text_update_schema');
   if(openMessage!=='assistant'||assistantStarts!==1||assistantEnded||turnEnded)fail('event_order');
   const textUpdate=checkedUpdate.data;
   if(textUpdate.type==='text_start'){
    if(textUpdates.has(textUpdate.contentIndex))fail('text_update_order');
    textUpdates.set(textUpdate.contentIndex,{deltas:[]});
   }else if(textUpdate.type==='text_delta'||textUpdate.type==='text_end'){
    const block=textUpdates.get(textUpdate.contentIndex);
    if(!block||block.text!==undefined)fail('text_update_order');
    if(textUpdate.type==='text_delta')block.deltas.push(textUpdate.delta);
    else{
     if(block.deltas.join('')!==textUpdate.content)fail('text_update_mismatch');
     block.text=textUpdate.content;block.deltas.length=0;
    }
   }
  }
  if(event.type==='turn_end'){
   if(event.reason&&event.reason!=='stop')throw ompProviderHold(stdout,'turn_reason',exitCode);
   rejectAssistant(object(event.message));
   if(object(event.message).role!=='assistant')fail('turn_message');
   if(openMessage||!assistantEnded||turnEnded)fail('event_order');turnEnded=true;
   if(Array.isArray(event.toolResults)&&event.toolResults.length)fail('tool_result');
  }
  if(event.type==='agent_end'){
   if(event.reason&&event.reason!=='stop')throw ompProviderHold(stdout,'agent_reason',exitCode);
   if(!Array.isArray(event.messages))fail('agent_messages');
   let assistants=0;for(const message of event.messages){
    const copy=object(message);if(copy.role==='toolResult')fail('tool_result');
    if(!['user','assistant'].includes(String(copy.role)))fail('message_role');
    if(copy.role==='assistant')assistants++;rejectAssistant(copy);
   }
   if(assistants!==1)fail('agent_messages');
   if(!turnEnded||agentEnded||i!==lines.length-1)fail('event_order');agentEnded=true;
  }
  if(event.type==='message_end'){
   const message=object(event.message);if(message.role!=='assistant')continue;
   rejectAssistant(message);
   if(assistantStarts!==1||assistantEnded)fail('event_order');assistantEnded=true;
   if(message.provider!=='anthropic'||message.api!=='anthropic-messages'||message.model!==expectedModel||message.stopReason!=='stop')throw new OmpRunnerHold('model_identity_mismatch');
   if(message.upstreamModel!==undefined&&message.upstreamModel!==expectedModel)throw new OmpRunnerHold('model_identity_mismatch');
   const content=Array.isArray(message.content)?message.content:[];
   if(!content.length||content.some(block=>object(block).type!=='text'))fail('final_content');
   if(!final){final=message;finalLine=line;}
  }
 }
 if(!final)fail('missing_final_assistant');
 if(textUpdates.size){
  const content=final.content as Array<Record<string,unknown>>;
  if(textUpdates.size!==content.length)fail('text_update_mismatch');
  for(let index=0;index<content.length;index++){
   const block=textUpdates.get(index);
   if(!block)fail('text_update_mismatch');
   if(block.text===undefined)fail('text_update_order');
   if(block.text!==content[index]!.text)fail('text_update_mismatch');
  }
 }
 if(!agentStarted||turns!==1||assistantStarts!==1||!assistantEnded||!turnEnded||!agentEnded)fail('incomplete_lifecycle');
 const text=(final.content as Array<Record<string,unknown>>).map(block=>String(block.text)).join('');
 if(Buffer.byteLength(text)>96*1024)throw new OmpRunnerHold('resource_limit');
 const outputStructure=describeOmpOutput(text,delivery,object(final.usage).output),fence=exactOmpJsonFence(text);
 const outputNormalization=fence!==undefined?'single-json-fence-v1' as const:undefined;
 const jsonText=fence??text;
 let raw:unknown;try{raw=JSON.parse(jsonText);}catch{throw outputRejection(stdout,text,outputStructure,'output_json',undefined,outputNormalization);}
 const decoded=assessmentOutputSchema.safeParse(raw);if(!decoded.success)throw outputRejection(stdout,text,outputStructure,'output_schema',decoded.error.issues,outputNormalization);
 const value=decoded.data;
 const usageRaw=object(final.usage),finalUsage=counts(usageRaw);
 const cost=object(usageRaw.cost).total,estimatedCost=typeof cost==='number'&&Number.isFinite(cost)&&cost>=0?cost:null;
 const usage:ReportedUsage={topLevel:Object.keys(finalUsage).length?finalUsage:null,perModel:{[expectedModel]:{...finalUsage,...(estimatedCost===null?{}:{cliEstimatedApiCostUsd:estimatedCost})}},cliEstimatedApiCostUsd:estimatedCost};
 return {value,responseSha256:sha(finalLine),returnedModel:String(final.model),reportedModels:[String(final.model)],usage,outputStructure,...outputNormalization?{outputNormalization}:{}};
}
/** Preserve limit metadata on failure, but certify retry only for the normal,
 * completely framed provider-failure path rejected by the successful decoder. */
export function inspectOmpLimitFailure(stdout:string,stderr:string,observedAt:string,exitCode:number,error:unknown,expectedModel:typeof NATIVE_B_MODEL|'claude-haiku-5-5'='claude-haiku-5-5'):OmpRunnerHold|null{
 const evidence=ompSubscriptionLimit(stdout,stderr,observedAt,exitCode,expectedModel);
 if(!evidence)return null;
 if(!(error instanceof OmpRunnerHold)||error.reason!=='provider_failed')evidence.noOutput=false;
 return new OmpRunnerHold('provider_failed',evidence,error instanceof OmpRunnerHold?error.failureKind:undefined,exitCode,error instanceof OmpRunnerHold?error.decodeCheck:undefined,error instanceof OmpRunnerHold?error.controlMode:undefined);
}
/** Upstream resolvePromptInput warns and then uses the literal path on EACCES.
 * Inspect transport logs only, never warning-looking source/assistant content. */
function unavailableOmpSystemPrompt(stdout:string,stderr:string):boolean{
 const warnings=['Could not read system prompt file','Could not read append system prompt file'];
 if(warnings.some(warning=>stderr.includes(warning)))return true;
 for(const line of stdout.split('\n')){
  let log:Record<string,unknown>;
  try{log=object(JSON.parse(line));}catch{if(warnings.some(warning=>line.includes(warning)))return true;continue;}
  if(log.level==='warn'&&warnings.includes(String(log.message)))return true;
 }
 return false;
}
/** Prompt-control failures preempt quality settlement even for a normal exit.
 * Preserve governed usage holds without granting no-output retry certification. */
export function inspectOmpAssessmentCompletion(stdout:string,stderr:string,exitCode:number,delivery:OmpOutputDelivery,observedAt:string,controlMode?:'0444'):OmpParsedEvents{
 try{
  if(unavailableOmpSystemPrompt(stdout,stderr))throw new OmpRunnerHold('request_rejected',undefined,undefined,exitCode,'control_prompt_unavailable',controlMode);
  return inspectOmpEvents(stdout,exitCode,delivery);
 }catch(error){
  if(error instanceof OmpAssessmentOutputRejected)throw new OmpAssessmentOutputRejected(error.rejection,controlMode);
  throw inspectOmpLimitFailure(stdout,stderr,observedAt,exitCode,error,NATIVE_B_MODEL)??error;
 }
}
async function reviewFile(path:string,contract:string):Promise<OmpReview>{
 if(process.platform!=='linux')throw new OmpRunnerHold('unavailable');
 try{for(const p of ['/','/etc','/etc/stadtstack',path]){const s=await lstat(p);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0||(p===path?!s.isFile()||s.size>4096:!s.isDirectory()))throw new OmpRunnerHold('security_review_required');}
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let value:OmpReview;try{const st=await f.stat();if(st.uid!==0||(st.mode&0o022)!==0||st.size>4096)throw new OmpRunnerHold('security_review_required');value=OmpReviewSchema.parse(JSON.parse(await f.readFile('utf8')));}finally{await f.close();}
  if(value.runnerContractSha256!==contract||Date.parse(value.reviewedAt)>Date.now())throw new OmpRunnerHold('security_review_required');return value;
 }catch(e){if(e instanceof OmpRunnerHold)throw e;throw new OmpRunnerHold('security_review_required');}
}
/** Read-only reviewed image metadata for the guarded installer; no credential or Docker access. */
export async function readOmpRunnerReview():Promise<OmpReview>{
 return reviewFile(OMP_REVIEW_PATH,await ompRunnerContractSha256());
}
export async function ompRunnerContractSha256(hash?:(file:string)=>Promise<string>):Promise<string>{
 const files=['district-omp-b-runner.ts','district-b-native-model.ts','district-assessment-projection.ts','district-schema.ts','district-graph-claims.ts','district-omp-output-diagnostics.ts','district-subscription-limit.ts','district-execution-profile.ts','district-assessment.ts','district-assessment-context.ts','district-claims.ts','civic-docker.ts','civic-opt-out.ts','../docker/omp-b/Dockerfile','../docker/omp-b/settings.yml','../docker/omp-b/entry.sh','../docker/omp-b/natives.sha256','../scripts/build-omp-b-image.sh'];
 const control=ompAssessmentControl();
 return semanticHash({version:OMP_RUNNER_VERSION,systemPromptSha256:control.systemPromptSha256,outputSchemaSha256:control.outputSchemaSha256,files:await Promise.all(files.map(async file=>({file,sha256:hash?await hash(file):digest(await readFile(new URL(file,import.meta.url)))})))});
}
/** Selector/lease identity excludes the independently reviewed host authority.
 * The mixed runner remains semantic for model framing, event decoding and CLI
 * arguments. runVmOmpAssessment still validates the live security contract. */
export async function ompRunnerOutputContractSha256(hash?:(file:string)=>Promise<string>):Promise<string>{
 const files=['district-omp-b-runner.ts','district-b-native-model.ts','district-assessment-projection.ts','district-schema.ts','district-graph-claims.ts','district-omp-output-diagnostics.ts','district-subscription-limit.ts','district-execution-profile.ts','district-assessment.ts','district-assessment-context.ts','district-claims.ts','../docker/omp-b/Dockerfile','../docker/omp-b/settings.yml','../docker/omp-b/entry.sh','../docker/omp-b/natives.sha256','../scripts/build-omp-b-image.sh'];
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
export async function resolveOmpCredential(spawn:OmpSpawn,binary:string,jobRoot:string,review:Pick<OmpReview,'hostResolverBinarySha256'|'hostResolverVersion'>,signal?:AbortSignal):Promise<ResolvedOmpCredential>{
 const env={HOME:'/home/max',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'};
 // No user-writable harness path or symlinked ancestor may supply this trusted
 // credential reader. The deployed entrypoint itself is a fixed reviewed path.
 if(binary!==resolve(binary)||review.hostResolverVersion!==OMP_HOST_VERSION)throw new OmpRunnerHold('security_review_required');
 let initial:Stats;
 try{
  for(let parent=dirname(binary);;parent=dirname(parent)){
   const metadata=await lstat(parent);
   if(!metadata.isDirectory()||metadata.isSymbolicLink()||metadata.uid!==0||(metadata.mode&0o022)!==0)throw new OmpRunnerHold('security_review_required');
   if(parent===dirname(parent))break;
  }
  initial=await lstat(binary);
  if(!initial.isFile()||initial.isSymbolicLink()||initial.uid!==0||initial.nlink!==1||(initial.mode&0o022)!==0||(initial.mode&0o111)===0)throw new OmpRunnerHold('security_review_required');
 }catch{throw new OmpRunnerHold('security_review_required');}
 const binarySha256=sha(await readFile(binary));
 if(binarySha256!==review.hostResolverBinarySha256)throw new OmpRunnerHold('security_review_required');
 const version=await capture(spawn,binary,['--version'],{cwd:jobRoot,env,stdio:['pipe','pipe','pipe'],windowsHide:true},Buffer.alloc(0),1024,5000,signal);
 const versionMatches=version.code===0&&version.stdout.equals(Buffer.from(review.hostResolverVersion+'\n'));version.stdout.fill(0);version.stderr.fill(0);
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
 return {token,version:review.hostResolverVersion,binarySha256,accountLabelSha256};
}
/** Produced only after container absence and canonical scratch closure have both
 * completed. This is not the Mac client's stronger file-write-denial assertion. */
export const OmpNativeCleanupSchema=z.object({version:z.literal('omp-native-cleanup-v1'),requestSha256:hash,responseSha256:hash,runnerContractSha256:hash,imageId:image,scratchId:z.uuid(),containerId:hash,containerRemoved:z.literal(true),managedScratchClosed:z.literal(true),completedAt:z.iso.datetime()}).strict();
export type OmpNativeCleanup=z.infer<typeof OmpNativeCleanupSchema>;
export interface OmpRunnerResult {answer:ModelAnswer;stdout:string;startedAt:string;finishedAt:string;imageId:string;settingsSha256:string;systemPromptSha256:string;outputSchemaSha256:string;controlMode:'0444';accountLabelSha256:string;runnerContractSha256:string;toolVersion:string;outputStructure:OmpOutputStructure;outputNormalization?:OmpOutputNormalization;cleanup:OmpNativeCleanup}
/** A failed control/provider lease must not quarantine the shared evidence CAS.
 * The sibling is separately enrolled with the same authority/source bindings. */
export function ompAssessmentScratchRoot(root:string):string{
 const path=resolve(root);return join(dirname(path),basename(path)+'-omp-b-scratch');
}
export interface OmpControlFileIdentity {readonly uid:number;readonly gid:number;readonly dev:number;readonly ino:number;readonly bytes:number;readonly sha256:string;readonly mode:'0444'}
function controlFileHold():OmpRunnerHold{return new OmpRunnerHold('request_rejected',undefined,undefined,undefined,'control_file');}
/** Creation permissions are masked by umask; fchmod, not open's mode, makes
 * this source-free control readable by the reviewed container's uid 65534. */
export async function createOmpAssessmentControl(directory:string,prompt:Buffer):Promise<OmpControlFileIdentity>{
 try{
  await mkdir(directory,{mode:0o700});
  const file=await open(join(directory,'system-prompt.md'),'wx',0o444);
  let identity:OmpControlFileIdentity;
  try{
   await file.writeFile(prompt);await file.chmod(0o444);await file.sync();
   const stat=await file.stat();
   if(!stat.isFile()||(stat.mode&0o7777)!==0o444||stat.nlink!==1||stat.size!==prompt.length)throw controlFileHold();
   identity={uid:stat.uid,gid:stat.gid,dev:stat.dev,ino:stat.ino,bytes:prompt.length,sha256:sha(prompt),mode:'0444'};
  }finally{await file.close();}
  await chmod(directory,0o755);
  await assertOmpAssessmentControl(directory,identity);
  return identity;
 }catch(error){if(error instanceof OmpRunnerHold)throw error;throw controlFileHold();}
}
/** Recheck the exact bind input immediately before source-bearing stdin.
 * No symlinks, replacement inode/owner, special modes, partial bytes or hashes. */
export async function assertOmpAssessmentControl(directory:string,identity:OmpControlFileIdentity):Promise<void>{
 const path=join(directory,'system-prompt.md');
 const matches=(stat:Stats)=>stat.isFile()&&(stat.mode&0o7777)===0o444&&stat.nlink===1&&stat.uid===identity.uid&&stat.gid===identity.gid&&stat.dev===identity.dev&&stat.ino===identity.ino&&stat.size===identity.bytes;
 try{
  const folder=await lstat(directory);
  if(!folder.isDirectory()||folder.isSymbolicLink()||(folder.mode&0o7777)!==0o755||folder.uid!==identity.uid||folder.gid!==identity.gid)throw controlFileHold();
  if(!matches(await lstat(path)))throw controlFileHold();
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   if(!matches(await file.stat()))throw controlFileHold();
   const bytes=await file.readFile();
   try{if(bytes.length!==identity.bytes||sha(bytes)!==identity.sha256)throw controlFileHold();}finally{bytes.fill(0);}
   if(!matches(await file.stat())||!matches(await lstat(path)))throw controlFileHold();
  }finally{await file.close();}
 }catch(error){if(error instanceof OmpRunnerHold)throw error;throw controlFileHold();}
}
/** One managed write checks authority once for the whole credential/request frame.
 * Counts/hashes describe the request portion only; credentials never enter proofs.
 * A stream write is not a kernel atomicity guarantee: the CLI still reads to EOF. */
export async function handoffOmpAssessmentInput(stdin:Writable,token:Buffer,payload:Buffer,signal?:AbortSignal):Promise<OmpStdinDelivery>{
 const offset=token.length+1,frame=Buffer.allocUnsafe(offset+payload.length),intendedBytes=payload.length;
 token.copy(frame);frame[token.length]=10;payload.copy(frame,offset);
 const abort=()=>stdin.destroy(signal?.reason instanceof Error?signal.reason:new OmpRunnerHold('resource_limit'));
 try{
  await new Promise<void>((resolve,reject)=>{
   const error=(failure:Error)=>{stdin.removeListener('finish',finish);reject(failure);};
   const finish=()=>{stdin.removeListener('error',error);resolve();};
   stdin.once('error',error);stdin.once('finish',finish);
   signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted){abort();return;}
   // end(frame) performs one write followed by EOF, with no token/payload gap.
   stdin.end(frame);
  });
  return {intendedBytes,deliveredBytes:frame.length-offset,deliveredSha256:sha(frame.subarray(offset)),frameBytes:frame.length};
 }finally{signal?.removeEventListener('abort',abort);frame.fill(0);token.fill(0);payload.fill(0);}
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
  const {scratchId,containerId,...run}=await withManagedSourceScratch(ompAssessmentScratchRoot(context.root),context.bindings,async scope=>{
   let container:ManagedDockerContainer|undefined,token:Buffer|undefined,payload:Buffer|undefined;
   const output:Buffer[]=[],errors:Buffer[]=[];let outputBytes=0,errorBytes=0;
   const aborted=Promise.withResolvers<never>(),onAbort=()=>aborted.reject(scope.signal.reason);
   void aborted.promise.catch(()=>{});scope.signal.addEventListener('abort',onAbort,{once:true});
   try{
    await scope.assertActive();
    const credentialCwd=join(scope.directory,'host-control');await mkdir(credentialCwd,{mode:0o700});
    const auth=await resolveOmpCredential(deps.spawn??nodeSpawn,OMP_HOST_BINARY,credentialCwd,review,scope.signal);token=auth.token;
    const controlContract=ompAssessmentControl(),settings=await readFile(new URL('../docker/omp-b/settings.yml',import.meta.url)),prompt=Buffer.from(controlContract.prompt);
    payload=Buffer.from(canonicalJson(data));
    if(payload.length>OMP_LIMITS.inputBytes)throw new OmpRunnerHold('request_rejected');
    const delivery={requestSha256:sha(payload),systemPromptSha256:sha(prompt)};
    await scope.assertActive();
    const control=join(scope.directory,'control'),controlIdentity=await createOmpAssessmentControl(control,prompt);
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
    await assertOmpAssessmentControl(control,controlIdentity);scope.signal.throwIfAborted();
    const startedAt=new Date().toISOString();
    const stdinDelivery=await Promise.race([handoffOmpAssessmentInput(session.stdin,token,payload,scope.signal),aborted.promise,streamFailure.promise]);
    token=undefined;payload=undefined;
    const result=await Promise.race([session.completion,aborted.promise,streamFailure.promise]);
    await scope.assertActive();
    const finishedAt=new Date().toISOString(),bytes=Buffer.concat(output,outputBytes),stdout=bytes.toString('utf8');bytes.fill(0);
    const stderrBytes=Buffer.concat(errors,errorBytes);
    let parsed:OmpParsedEvents;
    try{parsed=inspectOmpAssessmentCompletion(stdout,stderrBytes.toString('utf8'),result.exitCode,{...delivery,stdin:stdinDelivery},finishedAt,controlIdentity.mode);}finally{stderrBytes.fill(0);}
    const modelEvidence={provider:'anthropic-subscription' as const,tool:'omp-cli' as const,model:NATIVE_B_MODEL,toolVersion:OMP_VERSION+' sha256:'+review.ompBinarySha256,modelIdentitySha256:'',modelIdentityBasis:'reported-cli-model-and-tool-version' as const};
    modelEvidence.modelIdentitySha256=modelIdentitySha256(modelEvidence);
    const {outputNormalization,outputStructure,...modelResult}=parsed;
    const answer:ModelAnswer={...modelResult,evidence:modelEvidence,requestedModel:NATIVE_B_MODEL,runtimeWarnings:[]};assertNativeBResponseIdentity(answer);
    return {answer,stdout,startedAt,finishedAt,imageId:review.imageId,settingsSha256:sha(settings),systemPromptSha256:controlContract.systemPromptSha256,outputSchemaSha256:controlContract.outputSchemaSha256,controlMode:controlIdentity.mode,accountLabelSha256:auth.accountLabelSha256,runnerContractSha256:contract,toolVersion:OMP_VERSION+' sha256:'+review.ompBinarySha256,outputStructure,...outputNormalization?{outputNormalization}:{},scratchId:basename(scope.directory),containerId:container.id};
   }finally{
    scope.signal.removeEventListener('abort',onAbort);
    // Removal is independently supervised by the canonical authority. An
    // unconfirmed removal keeps the lease partial and its scratch inventoried.
    try{await container?.remove();}finally{token?.fill(0);payload?.fill(0);for(const chunk of output)chunk.fill(0);for(const chunk of errors)chunk.fill(0);}
   }
  },{...context,purpose:'artifact',signal:runSignal});
  // Both the callback's supervised removal and the scope's final cleanScratch
  // must resolve before this acknowledgement exists; a failed cleanup throws.
  return {...run,cleanup:OmpNativeCleanupSchema.parse({version:'omp-native-cleanup-v1',requestSha256:run.outputStructure.delivery.requestSha256,responseSha256:run.answer.responseSha256,runnerContractSha256:contract,imageId:review.imageId,scratchId,containerId,containerRemoved:true,managedScratchClosed:true,completedAt:new Date().toISOString()})};
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
