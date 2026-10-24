import {Worker} from 'node:worker_threads';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeSync} from 'node:fs';
import {z} from 'zod';
import {createCanonicalWitnessReadPool} from './r1-step8-provenance.ts';
import {CanonicalWorkerProgressSchema,canonicalWorkerDiagnostic,formatCanonicalWorkerDiagnostic,type CanonicalWorkerProgress,type CanonicalWorkerDiagnostic} from './r1-step8-worker-diagnostics.ts';

const Connection=z.object({host:z.string().refine(isAbsolute),database:z.string().min(1),user:z.string().min(1),port:z.number().int().min(1).max(65535)}).strict();

/** The fixed supervisor remains outside Core and terminates the WHOLE PID on
 * parent/PG/thread loss. Safe diagnostics are written synchronously even if IPC
 * has disappeared; a bounded IPC flush never leaves an orphan holding a lock. */
export async function superviseReconstructionWorker(request:unknown,workerModule:URL):Promise<void>{
 if(!process.send||!process.connected)throw Error('Reconstruction supervisor requires parent IPC');
 const head=z.object({nonce:z.uuid(),connection:Connection,indices:z.array(z.number().int().min(0).max(255)).optional()}).passthrough().parse(request),db=createCanonicalWitnessReadPool(head.connection);
 db.options.application_name='r1-reconstruction-liveness';
 db.options.connectionTimeoutMillis=2000;db.options.statement_timeout=2000;db.options.query_timeout=2000;
 let progress:CanonicalWorkerProgress={schemaVersion:'stadtstack-r1-canonical-progress-v1',nonce:head.nonce,phase:'opening-context'},failing=false,timer:NodeJS.Timeout|undefined;
 const fail=(reason:CanonicalWorkerDiagnostic['reason'],error?:unknown,extra:Pick<Partial<CanonicalWorkerDiagnostic>,'exitCode'|'signal'>={})=>{
  if(failing)return;failing=true;clearInterval(timer);
  const diagnostic=canonicalWorkerDiagnostic(head.nonce,reason,progress,error,extra);
  try{writeSync(2,formatCanonicalWorkerDiagnostic(diagnostic)+'\n');}catch{/* IPC still gets a bounded delivery attempt if stderr is unavailable. */}
  if(!process.connected||!process.send)process.exit(1);
  const deadline=setTimeout(()=>process.exit(1),100);deadline.unref();
  try{process.send(diagnostic,()=>process.exit(1));}catch{process.exit(1);}
 };
 const disconnected=()=>fail('parent-disconnected'),term=()=>fail('signal',undefined,{signal:'SIGTERM'}),interrupt=()=>fail('signal',undefined,{signal:'SIGINT'}),databaseError=(error:Error)=>fail('database-error',error);
 const stop=(message:unknown)=>{if(message&&typeof message==='object'&&(message as {stop?:unknown}).stop===true)fail('parent-stop');};
 process.once('disconnect',disconnected);process.once('SIGTERM',term);process.once('SIGINT',interrupt);process.on('message',stop);db.on('error',databaseError);
 try{
  await db.query('SELECT 1');
  const worker=new Worker(workerModule,{workerData:request,execArgv:['--experimental-strip-types','--require',fileURLToPath(new URL('../scripts/r1-step8-offline.cjs',import.meta.url))],resourceLimits:{maxOldGenerationSizeMb:1024}});
  let checking=false;
  timer=setInterval(()=>{
   if(checking||failing)return;checking=true;
   void db.query('SELECT 1').catch(error=>fail('heartbeat-failed',error)).finally(()=>{checking=false;});
  },1000);
  const reply=await new Promise<unknown>((accept)=>{
   let received=false,packet:unknown;
   worker.on('message',(message:unknown)=>{
    const event=CanonicalWorkerProgressSchema.safeParse(message);
    if(event.success){
     if(received||event.data.nonce!==head.nonce||event.data.index!==undefined&&head.indices&&!head.indices.includes(event.data.index)){fail('invalid-result');return;}
     progress=event.data;
     try{process.send!(event.data,error=>{if(error)fail('ipc-send-failed',error);});}catch(error){fail('ipc-send-failed',error);}return;
    }
    if(received){fail('duplicate-result');return;}received=true;packet=message;
   });
   worker.once('error',error=>fail('thread-error',error));
   worker.once('exit',code=>{if(code!==0||!received){fail('thread-exit',undefined,{exitCode:code});return;}accept(packet);});
  });
  if(!reply||typeof reply!=='object'||Array.isArray(reply)){fail('invalid-result');return;}
  clearInterval(timer);await db.end();
  process.removeListener('disconnect',disconnected);process.removeListener('SIGTERM',term);process.removeListener('SIGINT',interrupt);process.removeListener('message',stop);db.removeListener('error',databaseError);
  await new Promise<void>((accept,reject)=>process.send!(reply,error=>error?reject(error):accept()));
  process.exitCode=typeof (reply as {error?:unknown}).error==='string'?1:0;
  process.disconnect();
 }catch(error){fail('supervisor-exception',error);}
 finally{clearInterval(timer);}
}
