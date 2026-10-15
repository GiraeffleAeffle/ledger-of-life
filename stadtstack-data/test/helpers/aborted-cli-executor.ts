import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runDistrictJobsCli} from '../../src/district-jobs.ts';
import {canonicalJson,digest} from '../../src/district-adapter-contract.ts';
import {provisionCivicPolicyAuthority,withManagedSourceScratch,CIVIC_ACQUISITION_DECISION_ID} from '../../src/civic-opt-out.ts';

const [database,authorizationId,casRoot,directory,approval,destination,mode]=process.argv.slice(2);
process.env.DATABASE_URL=database;
await mkdir(directory,{mode:0o700});
const stateDir=join(directory,'policy'),authority=await provisionCivicPolicyAuthority({stateDir,authorityId:'fixture:'+randomUUID()}),policy={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
const root=join(directory,'scratch-root'),sourceSha256=createHash('sha256').update('synthetic CLI source').digest('hex');
try{
 await runDistrictJobsCli({verify_artifacts:async({signal})=>{
  // This timer is deliberately real: it represents a live handler-owned handle
  // in an independent CLI process, not a mocked in-process timer assertion.
  const live=setInterval(()=>{},1000);
  try{
   return await withManagedSourceScratch(root,[{phase:'pre-admission',url:'https://council.test/cli',sourceSha256}],async()=>{
    const aborted=Promise.withResolvers<never>();signal.addEventListener('abort',()=>aborted.reject(signal.reason),{once:true});
    process.send?.({entered:true,stateDir});signal.throwIfAborted();await aborted.promise;
    return {outcome:'succeeded' as const,reasonCode:'completed' as const};
   },{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'fetch',purpose:'classification',signal});
  }finally{clearInterval(live);await writeFile(join(directory,'cleanup-finished'),'closed',{mode:0o600});}
 }},['run','--authorization-id',authorizationId,'--max-jobs','1','--max-seconds',mode==='max-time'?'2':'60','--mode','bounded_unattended','--cas-root',casRoot],{
  notificationApprovalSha256:approval,destinationSha256:destination,provider:'ntfy',
  notifyOwner:async notification=>({provider:'ntfy',messageId:randomUUID(),notificationId:notification.id,payloadSha256:digest(canonicalJson(notification)),destinationSha256:destination,acknowledgedAt:new Date().toISOString()}),
 });
}finally{process.disconnect?.();}
