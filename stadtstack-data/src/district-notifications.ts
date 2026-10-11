import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {z} from 'zod';
import {canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {type NotificationConfig,type OwnerNotification,type NotificationAcknowledgement} from './district-jobs.ts';

export const PIPELINE_NOTIFICATION_ENDPOINT='https://ntfy.stadtstack.eu/pipeline';
export const PIPELINE_NOTIFICATION_APPROVAL=Object.freeze({version:'pipeline-notification-approval-v1',approvedBy:'owner',approvedAt:'2026-10-11',via:'Main',endpoint:PIPELINE_NOTIFICATION_ENDPOINT,topic:'pipeline',purpose:'generic holds checkpoints and failures only',credential:'VM write-only publisher token; governed ACL provisioning'});
const TOKEN_PATH='/home/max/.config/stadtstack/ntfy/pipeline-publisher.token';
const acknowledgementSchema=z.object({id:z.string().min(1).max(128),event:z.literal('message'),topic:z.literal('pipeline'),message:z.string(),time:z.number().int().positive()}).passthrough();

async function readPublisherToken():Promise<string>{
 const metadata=await lstat(TOKEN_PATH);
 if(!metadata.isFile()||metadata.isSymbolicLink()||(metadata.mode&0o777)!==0o600||metadata.uid!==process.getuid?.()||metadata.size<8||metadata.size>4096)throw Error('Pipeline notification credential unavailable');
 const file=await open(TOKEN_PATH,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==metadata.uid||stat.ino!==metadata.ino||(stat.mode&0o777)!==0o600||stat.size>4096)throw Error('Pipeline notification credential unavailable');const token=(await file.readFile('utf8')).trim();if(!/^[A-Za-z0-9_-]{8,4096}$/.test(token))throw Error('Pipeline notification credential unavailable');return token;}finally{await file.close();}
}
export async function sendPipelineNotification(notification:OwnerNotification,dependencies:{readToken:()=>Promise<string>;send:typeof fetch}={readToken:readPublisherToken,send:fetch}):Promise<NotificationAcknowledgement>{
 const destinationSha256=semanticHash(PIPELINE_NOTIFICATION_ENDPOINT),approvalSha256=semanticHash(PIPELINE_NOTIFICATION_APPROVAL);
 if(notification.provider!=='ntfy'||notification.destinationSha256!==destinationSha256||notification.notificationApprovalSha256!==approvalSha256)throw Error('Pipeline notification approval mismatch');
 const payloadSha256=digest(canonicalJson(notification));
 const message=canonicalJson({notificationId:notification.id,payloadSha256,phase:notification.phase,state:notification.state,reasonCode:notification.reasonCode,jobsStarted:notification.jobsStarted});
 const token=await dependencies.readToken();
 let response:Response;
 try{response=await dependencies.send(PIPELINE_NOTIFICATION_ENDPOINT,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'text/plain; charset=utf-8',Title:notification.phase==='startup'?'Civic pipeline bounded run':'Civic pipeline disposition'},body:message,signal:AbortSignal.timeout(8000)});}catch{throw Error('Pipeline notification delivery failed');}
 if(!response.ok||!response.body)throw Error('Pipeline notification delivery failed');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;if(length>16384)throw Error('Pipeline notification acknowledgement rejected');chunks.push(chunk.value);}}finally{await reader.cancel();}
 let ack:z.infer<typeof acknowledgementSchema>;
 try{ack=acknowledgementSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{throw Error('Pipeline notification acknowledgement rejected');}
 if(ack.message!==message||Math.abs(Date.now()-ack.time*1000)>60_000)throw Error('Pipeline notification acknowledgement mismatch');
 return {provider:'ntfy',messageId:ack.id,notificationId:notification.id,payloadSha256,destinationSha256,acknowledgedAt:new Date(ack.time*1000).toISOString()};
}
export const pipelineNotificationConfig:NotificationConfig={provider:'ntfy',destinationSha256:semanticHash(PIPELINE_NOTIFICATION_ENDPOINT),notificationApprovalSha256:semanticHash(PIPELINE_NOTIFICATION_APPROVAL),notifyOwner:sendPipelineNotification};
