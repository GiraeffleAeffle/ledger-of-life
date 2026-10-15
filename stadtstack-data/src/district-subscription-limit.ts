import {z} from 'zod';

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
function errorLimit(provider:SubscriptionLimit['provider'],raw:unknown,observedAt:string):SubscriptionLimit|null{
 const error=object(raw),nested=object(error.error);
 const code=[nested.code,error.code,nested.type,error.codex_error_info,error.type].find(value=>['usage_limit_reached','usage_limit','rate_limit_error','rate_limit_exceeded'].includes(String(value)));
 const message=typeof raw==='string'?raw:typeof error.message==='string'?error.message:typeof nested.message==='string'?nested.message:'';
 // Exact CLI usage-limit wording is provider output, not an inferred HTTP window.
 const usage=code==='usage_limit_reached'||code==='usage_limit'||provider==='openai-subscription'&&/^You've hit your usage limit\b/.test(message),rate=code==='rate_limit_error'||code==='rate_limit_exceeded';
 if(!usage&&!rate)return null;
 const resets=new Set<string>();
 for(const obj of [error,nested,object(error.headers)])for(const key of ['resets_at','reset_at','resetAt','anthropic-ratelimit-unified-reset','x-ratelimit-reset']){
  const reset=resetTimestamp(obj[key]);if(reset)resets.add(reset);
 }
 // Accept only an explicit absolute provider clock, never a local delay/time-of-day guess.
 for(const match of message.matchAll(/\breset(?:s)?(?: at|_at|At)?[\s:=]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/gi)){
  const reset=resetTimestamp(match[1]);if(reset)resets.add(reset);
 }
 return SubscriptionLimitSchema.parse({provider,limitKind:usage?'usage_limit':'rate_limit',resetAt:resets.size===1?[...resets][0]:null,observedAt});
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
  if(limit)limits.push({...limit,resetAt:limit.resetAt??snapshotReset});
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
/** An omp failure is retryable only when the COMPLETE bounded stream proves no
 * model content/tool output was produced. Unknown/truncated events fail closed. */
export function ompSubscriptionLimit(stdout:string,stderr:string,observedAt=new Date().toISOString()):{limit:SubscriptionLimit;noOutput:boolean}|null{
 if(!stdout.endsWith('\n'))return null;
 const limits:SubscriptionLimit[]=[];let noOutput=true,session=false;
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
  const messages=[event.message,...(Array.isArray(event.messages)?event.messages:[])].map(object);
  for(const message of messages){
   if(message.role&&message.role!=='assistant')return null;
   if(message.provider!==undefined&&message.provider!=='anthropic'||message.model!==undefined&&message.model!=='claude-haiku-5-5')return null;
   if(message.content!==undefined&&(!Array.isArray(message.content)||message.content.length!==0))noOutput=false;
   const usage=object(message.usage);if(Object.values(usage).some(value=>typeof value==='number'&&value>0))noOutput=false;
   if(message.errorMessage){let raw:unknown;try{raw=JSON.parse(String(message.errorMessage).replace(/^429\s+(?=\{)/,''));}catch{raw=null;}
    inspectOutput(raw);
    const limit=errorLimit('anthropic-subscription',raw,observedAt);if(limit)limits.push(limit);}
  }
  const update=object(event.assistantMessageEvent);
  if(event.type==='message_update'&&!['start','error'].includes(String(update.type)))noOutput=false;
  for(const raw of [event.error,update.error]){
   let error=raw;
   if(typeof raw==='string'){try{error=JSON.parse(raw.replace(/^429\s+(?=\{)/,''));}catch{continue;}}
   inspectOutput(error);
   const limit=errorLimit('anthropic-subscription',error,observedAt);if(limit)limits.push(limit);
  }
 }
 // stderr is untrusted prose unless it is one complete typed provider JSON error.
 if(stderr.trim()){
  try{
   const error:unknown=JSON.parse(stderr.replace(/^429\s+(?=\{)/,''));
   inspectOutput(error);
   const limit=errorLimit('anthropic-subscription',error,observedAt);if(limit)limits.push(limit);
  }catch{noOutput=false;} // Unclassified stderr cannot prove an empty failure.
 }
 const limit=combine(limits);return session&&limit?{limit,noOutput}:null;
}
