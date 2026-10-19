import {Worker} from 'node:worker_threads';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {createCanonicalWitnessReadPool} from './r1-step8-provenance.ts';

const Connection=z.object({host:z.string().refine(isAbsolute),database:z.string().min(1),user:z.string().min(1),port:z.number().int().min(1).max(65535)}).strict();

/** The module URL is fixed by trusted code, never supplied in the operator/IPC
 * request. Keep this event loop outside Core: a CPU-bound reconstruction must
 * not prevent parent-loss or database-loss shutdown. Terminate the WHOLE PID,
 * not merely its lock-owning thread; unchanged Core can recover a dead owner. */
export async function superviseReconstructionWorker(request:unknown,workerModule:URL):Promise<void>{
 if(!process.send||!process.connected)throw Error('Reconstruction supervisor requires parent IPC');
 const connection=Connection.parse(z.object({connection:z.unknown()}).passthrough().parse(request).connection),db=createCanonicalWitnessReadPool(connection);
 db.options.application_name='r1-reconstruction-liveness';
 db.options.connectionTimeoutMillis=2000;db.options.statement_timeout=2000;db.options.query_timeout=2000;
 const fail=()=>process.exit(1),stop=(message:unknown)=>{if(message&&typeof message==='object'&&(message as {stop?:unknown}).stop===true)fail();};
 process.once('disconnect',fail);process.once('SIGTERM',fail);process.once('SIGINT',fail);process.on('message',stop);db.on('error',fail);
 let timer:NodeJS.Timeout|undefined;
 try{
  await db.query('SELECT 1');
  const worker=new Worker(workerModule,{workerData:request,execArgv:['--experimental-strip-types','--require',fileURLToPath(new URL('../scripts/r1-step8-offline.cjs',import.meta.url))],resourceLimits:{maxOldGenerationSizeMb:1024}});
  let checking=false;
  timer=setInterval(()=>{
   if(checking)return;checking=true;
   void db.query('SELECT 1').catch(fail).finally(()=>{checking=false;});
  },1000);
  const reply=await new Promise<unknown>((accept)=>{
   let received=false,packet:unknown;
   worker.on('message',(message:unknown)=>{if(received)fail();received=true;packet=message;});
   worker.once('error',fail);
   worker.once('exit',code=>{if(code!==0||!received)fail();accept(packet);});
  });
  if(!reply||typeof reply!=='object'||Array.isArray(reply))fail();
  clearInterval(timer);await db.end();
  process.removeListener('disconnect',fail);process.removeListener('SIGTERM',fail);process.removeListener('SIGINT',fail);process.removeListener('message',stop);
  await new Promise<void>((accept,reject)=>process.send!(reply,error=>error?reject(error):accept()));
  process.exitCode=reply&&typeof reply==='object'&&typeof (reply as {error?:unknown}).error==='string'?1:0;
  process.disconnect();
 }catch{fail();}
 finally{clearInterval(timer);}
}
