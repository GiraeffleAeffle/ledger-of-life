import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {runDistrictJobsCli} from '../../src/district-jobs.ts';
import {canonicalJson,digest} from '../../src/district-adapter-contract.ts';
import {provisionCivicPolicyAuthority,withManagedSourceScratch,CIVIC_ACQUISITION_DECISION_ID} from '../../src/civic-opt-out.ts';

const [database,authorizationId,casRoot,directory,drainFile,approval,destination]=process.argv.slice(2);
process.env.DATABASE_URL=database;
await mkdir(directory,{mode:0o700});
const stateDir=join(directory,'policy'),authority=await provisionCivicPolicyAuthority({stateDir,authorityId:'fixture:'+randomUUID()}),policy={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
const source=Buffer.from('synthetic graceful drain source'),finish=Promise.withResolvers<void>();
process.on('message',(message:{finish?:boolean})=>{if(message.finish)finish.resolve();});
try{
 await runDistrictJobsCli({residual_extract:async({job,signal})=>withManagedSourceScratch(join(directory,'scratch-root'),[{phase:'pre-admission',url:'https://council.test/drain',sourceSha256:digest(source)}],async scope=>{
  process.send?.({entered:true,runId:job.runId});await finish.promise;
  signal.throwIfAborted();await scope.writeSource('document',source);await scope.assertActive();
  return {outcome:'succeeded' as const,reasonCode:'completed' as const};
 },{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'fetch',purpose:'classification',signal})},['run','--authorization-id',authorizationId,'--max-jobs','2','--max-seconds','60','--mode','bounded_unattended','--cas-root',casRoot,'--drain-file',drainFile],{
  notificationApprovalSha256:approval,destinationSha256:destination,provider:'ntfy',
  notifyOwner:async notification=>({provider:'ntfy',messageId:randomUUID(),notificationId:notification.id,payloadSha256:digest(canonicalJson(notification)),destinationSha256:destination,acknowledgedAt:new Date().toISOString()}),
 });
}finally{process.disconnect?.();}
