import {Worker,parentPort,workerData} from 'node:worker_threads';
import assert from 'node:assert/strict';

assert.ok(parentPort);
parentPort.postMessage({schemaVersion:'stadtstack-r1-canonical-progress-v1',nonce:workerData.nonce,phase:'source-started',index:0});
if(workerData.mode==='error')throw new TypeError('DO_NOT_LEAK_PASSWORD_OR_SOURCE_BODY https://user:secret@example.invalid/private');
if(workerData.mode==='exit')process.exit(7);
if(workerData.mode==='heap'){
 // A real Node heap-limit error, bounded to16MiB rather than exhausting the
 // production supervisor's1GiB worker limit or relying on a Linux/system OOM.
 const nested=new Worker('const retained=[];for(;;)retained.push(new Array(1000000).fill(1));',{eval:true,resourceLimits:{maxOldGenerationSizeMb:16}});
 await new Promise<never>((_accept,reject)=>{nested.once('error',reject);nested.once('exit',code=>reject(Error('Nested heap worker exited '+code)));});
}
parentPort.postMessage({nonce:workerData.nonce,epoch:'explicit-isolated-supervisor-fixture',native:[],steps:[],files:[]});
parentPort.close();
