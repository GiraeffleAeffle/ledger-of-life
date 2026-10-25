import {once} from 'node:events';
import {isMainThread,parentPort,workerData} from 'node:worker_threads';
import {reconstructCanonicalWorkerRequest} from './r1-step8-provenance.ts';
import {superviseReconstructionWorker} from './r1-step8-worker-supervisor.ts';

if(isMainThread){
 if(!process.send||!process.connected||process.argv.length!==2||process.env.STADTSTACK_STEP8_OFFLINE!=='1')throw Error('Canonical reconstruction requires trusted offline parent IPC');
 const parentGone=()=>process.exit(1);process.once('disconnect',parentGone);
 const [request]=await once(process,'message');process.removeListener('disconnect',parentGone);
 await superviseReconstructionWorker(request,new URL(import.meta.url));
}else{
 if(!parentPort)throw Error('Canonical reconstruction thread has no supervisor');
 parentPort.postMessage(await reconstructCanonicalWorkerRequest(workerData));parentPort.close();
}
