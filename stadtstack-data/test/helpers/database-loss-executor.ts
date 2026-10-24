import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {runDistrictJobsCli} from '../../src/district-jobs.ts';
import {formatR1Failure} from '../../src/district-r1.ts';
import {guardDistrictPool,withDistrictDatabaseScope} from '../../src/district-database.ts';
import {canonicalJson,digest} from '../../src/district-adapter-contract.ts';
import {provisionCivicPolicyAuthority,initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID} from '../../src/civic-opt-out.ts';

const [database,authorizationId,casRoot,directory,approval,destination,mode]=process.argv.slice(2);
process.env.DATABASE_URL=database;
await mkdir(directory,{recursive:true,mode:0o700});
const stateDir=join(directory,'policy'),authority=await provisionCivicPolicyAuthority({stateDir,authorityId:'fixture:'+randomUUID()}),policy={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
const root=join(directory,'fetch'),text='Synthetic database-loss fixture content, not civic evidence.',sha256=digest(text);
await initializeManagedAcquisitionLane(root,{...policy,kind:'fetch',decisionId:CIVIC_ACQUISITION_DECISION_ID});
const entry={kind:'http_observation' as const,relativePath:'sha256/'+sha256,contentSha256:sha256,sourceSha256:sha256,url:'https://council.test/database-loss',observationId:sha256,receiptSha256:sha256,independentAllowed:false};
try{
 await withDistrictDatabaseScope(async()=>{
  const pool=guardDistrictPool(new Pool({connectionString:database,max:1,connectionTimeoutMillis:1000,statement_timeout:30000,application_name:'stadtstack-r1-loss-handler'}));
  try{
   await runDistrictJobsCli({verify_artifacts:async({signal,job})=>{
    try{
     return await withManagedSourceWrite(root,[entry],async()=>{
      await mkdir(join(root,'sha256'),{mode:0o700});await writeFile(join(root,entry.relativePath),text,{mode:0o600});
      const aborted=Promise.withResolvers<never>();
      signal.addEventListener('abort',()=>aborted.reject(signal.reason),{once:true});
      // The query variant must observe rejection even if the abort wins first.
      void aborted.promise.catch(()=>{});
      let client:PoolClient|undefined;
      try{
       let backendPid:number|undefined;
       if(mode!=='executor'){
        client=await pool.connect();backendPid=(await client.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        if(mode==='idle'){client.release();client=undefined;}
       }
       process.send?.({entered:true,stateDir,runId:job.runId,backendPid});
       signal.throwIfAborted();
       if(mode==='query')await client!.query('SELECT pg_sleep(30)');
       else await aborted.promise;
       return {outcome:'succeeded' as const,reasonCode:'completed' as const};
      }finally{
       // Simulate signal-aware handler cleanup still owning an inventory section.
       await delay(100);client?.release();
      }
     },policy);
    }finally{await writeFile(join(directory,'cleanup-finished'),'closed',{mode:0o600});}
   }},['run','--authorization-id',authorizationId,'--max-jobs','1','--max-seconds','180','--mode','bounded_unattended','--cas-root',casRoot],{
    notificationApprovalSha256:approval,destinationSha256:destination,provider:'ntfy',
    notifyOwner:async notification=>({provider:'ntfy',messageId:randomUUID(),notificationId:notification.id,payloadSha256:digest(canonicalJson(notification)),destinationSha256:destination,acknowledgedAt:new Date().toISOString()}),
   });
  }finally{await pool.end();}
 });
}catch(error){process.stderr.write(formatR1Failure(error,'execution'));process.exitCode=2;}
finally{process.disconnect?.();}
