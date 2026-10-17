import {z} from 'zod';
import {canonicalJson,digest} from './district-adapter-contract.ts';

/** Only provider error fields are projected; never retain messages, headers or model text. */
export const SubscriptionLimitSchema=z.object({
 provider:z.enum(['openai-subscription','anthropic-subscription']),
 limitKind:z.enum(['usage_limit','rate_limit']),resetAt:z.iso.datetime().nullable(),observedAt:z.iso.datetime(),
}).strict();
export type SubscriptionLimit=z.infer<typeof SubscriptionLimitSchema>;
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function resetTimestamp(value:unknown):string|null{
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<253402300800)return new Date(value*1000).toISOString();
 if(typeof value==='string'&&/^\d{10}$/.test(value))return resetTimestamp(Number(value));
 if(typeof value==='string'&&z.iso.datetime({offset:true}).safeParse(value).success)return new Date(value).toISOString();
 return null;
}
interface ParsedLimit {limit:SubscriptionLimit;resetEvidence:'absent'|'stated'|'unusable'}
function errorLimit(provider:SubscriptionLimit['provider'],raw:unknown,observedAt:string):ParsedLimit|null{
 const error=object(raw),nested=object(error.error);
 const code=[nested.code,error.code,nested.type,error.codex_error_info,error.type].find(value=>['usage_limit_reached','usage_limit','rate_limit_error','rate_limit_exceeded'].includes(String(value)));
 const message=typeof raw==='string'?raw:typeof error.message==='string'?error.message:typeof nested.message==='string'?nested.message:'';
 // Exact CLI usage-limit wording is provider output, not an inferred HTTP window.
 const usage=code==='usage_limit_reached'||code==='usage_limit'||provider==='openai-subscription'&&/^You've hit your usage limit\b/.test(message),rate=code==='rate_limit_error'||code==='rate_limit_exceeded';
 if(!usage&&!rate)return null;
 const resets=new Set<string>();let unusable=false;
 for(const obj of [error,nested,object(error.headers)])for(const key of ['resets_at','reset_at','resetAt','anthropic-ratelimit-unified-reset','x-ratelimit-reset']){
  if(obj[key]===undefined)continue;
  const reset=resetTimestamp(obj[key]);if(reset)resets.add(reset);else unusable=true;
 }
 // Accept only an explicit absolute provider clock, never a local delay/time-of-day guess.
 for(const match of message.matchAll(/\breset(?:s)?(?: at|_at|At)?[\s:=]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/gi)){
  const reset=resetTimestamp(match[1]);if(reset)resets.add(reset);else unusable=true;
 }
 if(/\bresets?\b/i.test(message)&&resets.size===0)unusable=true;
 const resetEvidence=unusable||resets.size>1?'unusable':resets.size===1?'stated':'absent';
 return {limit:SubscriptionLimitSchema.parse({provider,limitKind:usage?'usage_limit':'rate_limit',resetAt:resetEvidence==='stated'?[...resets][0]:null,observedAt}),resetEvidence};
}
/** The JSON error envelope is interpreted independently of successful-output decoding. */
export function codexSubscriptionLimit(stdout:string,observedAt=new Date().toISOString()):SubscriptionLimit|null{
 const limits:SubscriptionLimit[]=[];let snapshotReset:string|null=null;
 for(const line of stdout.split('\n')){
  if(!line.trim())continue;
  let event:Record<string,unknown>;try{event=object(JSON.parse(line));}catch{return null;}
  const payload=event.type==='event_msg'?object(event.payload):event;
  if(payload.type==='token_count'){
   // Installed 0.160.0 protocol: primary/secondary windows have used_percent
   // and absolute Unix resets_at. Percent alone is never a reset clock.
   const rates=object(payload.rate_limits),exhausted=[object(rates.primary),object(rates.secondary)].filter(window=>typeof window.used_percent==='number'&&window.used_percent>=100);
   const resets=exhausted.map(window=>resetTimestamp(window.resets_at));
   snapshotReset=resets.length&&resets.every(reset=>reset!==null)?resets.reduce((latest,reset)=>reset!>latest!?reset:latest):null;
   continue;
  }
  if(!['error','turn.failed'].includes(String(payload.type)))continue;
  const limit=errorLimit('openai-subscription',payload.error??payload,observedAt);
  if(limit)limits.push({...limit.limit,resetAt:limit.resetEvidence==='absent'?snapshotReset:limit.limit.resetAt});
 }
 return combine(limits);
}
export function codexSubscriptionNoOutput(stdout:string):boolean{
 if(!stdout.endsWith('\n'))return false;
 for(const line of stdout.split('\n').filter(Boolean)){
  let event:Record<string,unknown>;try{event=object(JSON.parse(line));}catch{return false;}
  const payload=event.type==='event_msg'?object(event.payload):event;
  if(!['thread.started','turn.started','error','turn.failed','token_count'].includes(String(payload.type)))return false;
  if(payload.type==='token_count'){
   const info=object(payload.info);
   if([object(info.total_token_usage),object(info.last_token_usage)].some(usage=>typeof usage.output_tokens==='number'&&usage.output_tokens>0))return false;
  }
 }
 return true;
}
function combine(limits:SubscriptionLimit[]):SubscriptionLimit|null{
 if(!limits.length)return null;
 const resets=new Set(limits.map(limit=>limit.resetAt));
 return {...limits[0],resetAt:resets.size===1?limits[0].resetAt:null};
}
export const OmpLimitFailureProofSchema=z.object({
 version:z.literal('omp-provider-limit-failure-v1'),exitCode:z.number().int(),
 streamSha256:z.string().regex(/^[a-f0-9]{64}$/),
 terminalFrame:z.enum(['assistant_turn_agent_error','incomplete']),
 terminalMessageSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export type OmpLimitFailureProof=z.infer<typeof OmpLimitFailureProofSchema>;
export function retryableOmpFailureProof(value:unknown):boolean{
 const parsed=OmpLimitFailureProofSchema.safeParse(value);
 return parsed.success&&parsed.data.exitCode===0&&parsed.data.terminalFrame==='assistant_turn_agent_error'&&parsed.data.terminalMessageSha256!==null;
}
/** An omp failure is retryable only when the COMPLETE bounded stream proves no
 * model content/tool output was produced. Unknown/truncated events fail closed. */
export function ompSubscriptionLimit(stdout:string,stderr:string,observedAt:string,exitCode:number,expectedModel:'claude-haiku-5-5'|'claude-sonnet-5-5'='claude-haiku-5-5'):{limit:SubscriptionLimit;noOutput:boolean;failureProof:OmpLimitFailureProof}|null{
 if(expectedModel!=='claude-haiku-5-5'&&expectedModel!=='claude-sonnet-5-5')return null;
 if(!stdout.endsWith('\n'))return null;
 const limits:SubscriptionLimit[]=[];let noOutput=true,session=false;
 let stage:'session'|'agent'|'turn'|'message'|'message_end'|'turn_end'|'agent_end'='session',framing=true,terminalMessage:string|null=null;
 const terminal=(raw:unknown):string|null=>{
  const message=object(raw),{completedAt:_completedAt,...body}=message;
  if(message.role!=='assistant'||message.provider!=='anthropic'||message.api!=='anthropic-messages'||message.model!==expectedModel||message.stopReason!=='error'||!Array.isArray(message.content)||message.content.length!==0)return null;
  if(!(typeof message.responseId==='string'&&message.responseId.length>0)&&!(typeof message.timestamp==='number'&&Number.isSafeInteger(message.timestamp)&&message.timestamp>=0))return null;
  let error:unknown;try{error=JSON.parse(String(message.errorMessage).replace(/^429\s+(?=\{)/,''));}catch{return null;}
  return errorLimit('anthropic-subscription',error,observedAt)?canonicalJson(body):null;
 };
  const inspectOutput=(value:unknown):void=>{
   if(Array.isArray(value)){value.forEach(inspectOutput);return;}
   if(value===null||typeof value!=='object')return;
   for(const [key,member] of Object.entries(value)){
    if(['content','toolResults'].includes(key)&&(!Array.isArray(member)||member.length>0))noOutput=false;
    if(['text','thinking','delta'].includes(key)&&member!==''&&member!==undefined)noOutput=false;
    if(key==='usage'&&Object.values(object(member)).some(count=>typeof count==='number'&&count>0))noOutput=false;
    inspectOutput(member);
   }
  };
 for(const line of stdout.split('\n').filter(Boolean)){
  let event:Record<string,unknown>;try{event=object(JSON.parse(line));}catch{return null;}
  inspectOutput(event);
  if(!session){if(event.type!=='session')return null;session=true;continue;}
  if(!['agent_start','agent_end','turn_start','turn_end','message_start','message_update','message_end','error'].includes(String(event.type)))return null;
  switch(event.type){
   case 'agent_start':if(stage!=='session')framing=false;stage='agent';break;
   case 'turn_start':if(stage!=='agent')framing=false;stage='turn';break;
   case 'message_start':if(stage!=='turn'||object(event.message).role!=='assistant')framing=false;stage='message';break;
   case 'message_update':if(stage!=='message')framing=false;break;
   case 'message_end':if(stage!=='message')framing=false;terminalMessage=terminal(event.message);if(!terminalMessage)framing=false;stage='message_end';break;
   case 'turn_end':if(stage!=='message_end'||!terminalMessage||terminal(event.message)!==terminalMessage||!Array.isArray(event.toolResults)||event.toolResults.length!==0||event.reason!==undefined&&event.reason!=='error')framing=false;stage='turn_end';break;
   case 'agent_end':if(stage!=='turn_end'||!Array.isArray(event.messages)||event.messages.length!==1||!terminalMessage||terminal(event.messages[0])!==terminalMessage||event.reason!==undefined&&event.reason!=='error')framing=false;stage='agent_end';break;
   default:framing=false;
  }
  const messages=[event.message,...(Array.isArray(event.messages)?event.messages:[])].map(object);
  for(const message of messages){
   if(message.role&&message.role!=='assistant')return null;
   if(message.provider!==undefined&&message.provider!=='anthropic'||message.model!==undefined&&message.model!==expectedModel)return null;
   if(message.content!==undefined&&(!Array.isArray(message.content)||message.content.length!==0))noOutput=false;
   const usage=object(message.usage);if(Object.values(usage).some(value=>typeof value==='number'&&value>0))noOutput=false;
   if(message.errorMessage){let raw:unknown;try{raw=JSON.parse(String(message.errorMessage).replace(/^429\s+(?=\{)/,''));}catch{raw=null;}
    inspectOutput(raw);
    const limit=errorLimit('anthropic-subscription',raw,observedAt);if(limit)limits.push(limit.limit);}
  }
  const update=object(event.assistantMessageEvent);
  if(event.type==='message_update'&&!['start','error'].includes(String(update.type)))noOutput=false;
  for(const raw of [event.error,update.error]){
   let error=raw;
   if(typeof raw==='string'){try{error=JSON.parse(raw.replace(/^429\s+(?=\{)/,''));}catch{continue;}}
   inspectOutput(error);
   const limit=errorLimit('anthropic-subscription',error,observedAt);if(limit)limits.push(limit.limit);
  }
 }
 // stderr is untrusted prose unless it is one complete typed provider JSON error.
 if(stderr.trim()){
  try{
   const error:unknown=JSON.parse(stderr.replace(/^429\s+(?=\{)/,''));
   inspectOutput(error);
   const limit=errorLimit('anthropic-subscription',error,observedAt);if(limit)limits.push(limit.limit);
  }catch{noOutput=false;} // Unclassified stderr cannot prove an empty failure.
 }
 const complete=framing&&stage==='agent_end'&&terminalMessage!==null;
 const failureProof=OmpLimitFailureProofSchema.parse({version:'omp-provider-limit-failure-v1',exitCode,streamSha256:digest(stdout),terminalFrame:complete?'assistant_turn_agent_error':'incomplete',terminalMessageSha256:complete?digest(terminalMessage!):null});
 const limit=combine(limits);return session&&limit?{limit,noOutput:noOutput&&retryableOmpFailureProof(failureProof),failureProof}:null;
}
