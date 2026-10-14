import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,digest,semanticHash} from '../src/district-adapter-contract.ts';
import {PIPELINE_NOTIFICATION_ENDPOINT,PIPELINE_NOTIFICATION_APPROVAL,pipelineNotificationConfig,sendPipelineNotification} from '../src/district-notifications.ts';
import type {OwnerNotification} from '../src/district-jobs.ts';
import {NotificationAmbiguousError,NotificationTransientError} from '../src/district-jobs.ts';

const token='synthetic_publisher_token_not_a_secret';
const notification:OwnerNotification={id:'00000000-0000-4000-8000-000000000001',phase:'startup',runId:'00000000-0000-4000-8000-000000000002',authorizationId:'00000000-0000-4000-8000-000000000003',state:'running',reasonCode:null,jobsStarted:0,receiptIds:[],notificationApprovalSha256:semanticHash(PIPELINE_NOTIFICATION_APPROVAL),destinationSha256:semanticHash(PIPELINE_NOTIFICATION_ENDPOINT),provider:'ntfy'};
const message=(input:OwnerNotification)=>canonicalJson({notificationId:input.id,payloadSha256:digest(canonicalJson(input)),phase:input.phase,state:input.state,reasonCode:input.reasonCode,jobsStarted:input.jobsStarted});
const ack=(body:string,patch:Record<string,unknown>={})=>new Response(JSON.stringify({id:'synthetic-message-1',event:'message',topic:'pipeline',message:body,time:Math.floor(Date.now()/1000),...patch}),{status:200});

for(const phase of ['startup','disposition'] as const)test(`ntfy ${phase} uses fixed approved destination and payload-bound provider acknowledgement`,async()=>{
 const input:OwnerNotification={...notification,phase,state:phase==='startup'?'running':'held',jobsStarted:phase==='startup'?0:3};
 let reads=0,sends=0;
 const result=await sendPipelineNotification(input,{readToken:async()=>{reads++;return token;},send:async(url,init)=>{
  sends++;assert.equal(url,'https://ntfy.stadtstack.eu/pipeline');assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
  const headers=new Headers(init?.headers);assert.equal(headers.get('Authorization'),`Bearer ${token}`);assert.equal(headers.get('Content-Type'),'text/plain; charset=utf-8');assert.equal(headers.get('Title'),phase==='startup'?'Civic pipeline bounded run':'Civic pipeline disposition');
  assert.ok(init?.signal instanceof AbortSignal);assert.equal(init.signal.aborted,false);assert.equal(init?.body,message(input));
  assert.equal(String(init?.body).includes(token),false);assert.equal(String(init?.body).includes(input.authorizationId),false);assert.equal(String(init?.body).includes(input.runId),false);
  return ack(String(init?.body));
 }});
 assert.equal(reads,1);assert.equal(sends,1);
 assert.deepEqual(result,{provider:'ntfy',messageId:'synthetic-message-1',notificationId:input.id,payloadSha256:digest(canonicalJson(input)),destinationSha256:semanticHash(PIPELINE_NOTIFICATION_ENDPOINT),acknowledgedAt:result.acknowledgedAt});
 assert.ok(Math.abs(Date.now()-Date.parse(result.acknowledgedAt))<2000);assert.equal(JSON.stringify(result).includes(token),false);
 assert.equal(pipelineNotificationConfig.destinationSha256,result.destinationSha256);assert.equal(pipelineNotificationConfig.notificationApprovalSha256,input.notificationApprovalSha256);
});

test('approval, destination and provider mismatches fail before credential access or sending',async()=>{
 for(const patch of [{provider:'other'},{destinationSha256:digest('https://example.org/other')},{notificationApprovalSha256:digest('unapproved')}]){
  let reads=0,sends=0;
  await assert.rejects(sendPipelineNotification({...notification,...patch},{readToken:async()=>{reads++;return token;},send:async()=>{sends++;return ack(message(notification));}}),/approval mismatch/);
  assert.equal(reads,0);assert.equal(sends,0);
 }
});

test('ntfy rejects wrong payload/topic/event, malformed, missing, old and future acknowledgements',async()=>{
 for(const patch of [{message:message({...notification,jobsStarted:1})},{topic:'other'},{event:'open'},{id:''},{time:0},{time:Math.floor(Date.now()/1000)-120},{time:Math.floor(Date.now()/1000)+120}])await assert.rejects(sendPipelineNotification(notification,{readToken:async()=>token,send:async()=>ack(message(notification),patch)}),/acknowledgement rejected|acknowledgement mismatch/);
 for(const response of [new Response('not-json'),new Response('{}'),new Response(null,{status:204}),new Response('forbidden',{status:403}),new Response(null,{status:302,headers:{Location:'https://example.org/other'}})])await assert.rejects(sendPipelineNotification(notification,{readToken:async()=>token,send:async()=>response}),/delivery failed|acknowledgement rejected/);
});

test('acknowledgement stream is bounded even when length is undeclared',async()=>{
 let cancelled=false;
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(8192));controller.enqueue(new Uint8Array(8193));},cancel(){cancelled=true;}});
 await assert.rejects(sendPipelineNotification(notification,{readToken:async()=>token,send:async()=>new Response(body)}),/acknowledgement rejected/);
 assert.equal(cancelled,true);
});

test('errored ACK stream remains ambiguous when cancellation rejects with the stored error',async()=>{
 const body=new ReadableStream<Uint8Array>({start(controller){controller.error(new DOMException('timeout','TimeoutError'));}});
 await assert.rejects(sendPipelineNotification(notification,{readToken:async()=>token,send:async()=>new Response(body)}),NotificationAmbiguousError);
});

test('oversized ACK remains non-retryable even when cleanup cancellation fails',async()=>{
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(16385));},cancel(){throw new DOMException('cleanup timeout','TimeoutError');}});
 await assert.rejects(sendPipelineNotification(notification,{readToken:async()=>token,send:async()=>new Response(body)}),error=>error instanceof Error&&error.message==='Pipeline notification acknowledgement rejected'&&!(error instanceof NotificationAmbiguousError));
});

test('redirect, HTTP transport error and timeout exceptions are generic without token argv or logs',async(t)=>{
 const argv=[...process.argv];
 const logs:unknown[][]=[];
 for(const method of ['log','warn','error'] as const)t.mock.method(console,method,(...args:unknown[])=>{logs.push(args);});
 for(const error of [new TypeError(`redirect denied ${token}`),new Error(`HTTP failed ${token}`),new DOMException(`timeout ${token}`,'TimeoutError')]){
  await assert.rejects(sendPipelineNotification(notification,{readToken:async()=>token,send:async()=>{throw error;}}),(failure:unknown)=>{
   assert.ok(failure instanceof NotificationAmbiguousError);assert.equal(failure.message,'Pipeline notification delivery failed');assert.equal(String(failure).includes(token),false);return true;
  });
 }
 assert.deepEqual(process.argv,argv);assert.equal(process.argv.some(arg=>arg.includes(token)),false);assert.deepEqual(logs,[]);
});

test('transport/timeouts are ambiguous, retryable HTTP failures transient, and invalid ACKs strict',async()=>{
 for(const status of [429,500,503])await assert.rejects(sendPipelineNotification(notification,{readToken:async()=>token,send:async()=>new Response('unavailable',{status})}),NotificationTransientError);
 await assert.rejects(sendPipelineNotification(notification,{readToken:async()=>token,send:async()=>new Response('forbidden',{status:403})}),error=>error instanceof Error&&!(error instanceof NotificationTransientError));
 const controller=new AbortController();controller.abort();
 await assert.rejects(sendPipelineNotification(notification,{readToken:async()=>token,send:async(_url,init)=>{assert.equal(init?.signal?.aborted,true);throw new DOMException('timed out','TimeoutError');}},controller.signal),NotificationAmbiguousError);
});
