// Synthetic disposable-PG fixture only; no production authority or providers.
import {Pool} from 'pg';
import {DistrictCas} from '../../src/district-cas.ts';
import {DistrictJobStore,runDistrictJobs} from '../../src/district-jobs.ts';
const [connectionString,authorizationId,casRoot,wait]=process.argv.slice(2);
const pool=new Pool({connectionString,max:4,statement_timeout:10000});
try {
 const result=await runDistrictJobs({store:new DistrictJobStore(pool),cas:new DistrictCas(casRoot),authorizationId,ownerPresent:true,maxJobs:1,maxElapsedMs:30000,handlers:{process_fixture:async()=>{
  process.send?.({entered:true});
  if(wait==='wait'){
   const {promise,resolve}=Promise.withResolvers<void>();
   process.once('message',()=>resolve());await promise;
  }
  return {outcome:'succeeded',reasonCode:'completed'};
 }}});
 process.send?.({result});
} finally {await pool.end();process.disconnect?.();}
