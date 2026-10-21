import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {canonicalWorkerError,canonicalWorkerDiagnostic,formatCanonicalWorkerDiagnostic,CanonicalWorkerDiagnosticSchema,CanonicalWorkerProgressSchema} from '../src/r1-step8-worker-diagnostics.ts';

const secret='DO_NOT_LEAK_PASSWORD_OR_SOURCE_BODY';
test('worker diagnostics expose bounded runtime cause/location, never raw messages or source/connection data',()=>{
 const error=Object.assign(new Error(secret+' postgresql://user:password@host/private'),{code:'ERR_WORKER_OUT_OF_MEMORY',detail:secret});
 error.stack='Error: '+secret+'\n    at phase (file:///private/package/src/r1-step8-provenance.ts:12:3)\n    at internal (node:internal/worker:34:5)';
 const diagnostic=canonicalWorkerDiagnostic(randomUUID(),'thread-error',{schemaVersion:'stadtstack-r1-canonical-progress-v1',nonce:randomUUID(),phase:'source-started',index:4},error);
 assert.deepEqual(diagnostic.error,{name:'Error',code:'ERR_WORKER_OUT_OF_MEMORY',classification:'heap-limit',frames:['src/r1-step8-provenance.ts:12:3','node:internal/worker:34:5']});
 const wire=formatCanonicalWorkerDiagnostic(diagnostic);assert.ok(!wire.includes(secret));assert.ok(!wire.includes('password@'));assert.ok(wire.length<4096);
 assert.equal(canonicalWorkerError(Error('Query read timeout '+secret)).classification,'timeout');
 assert.equal(canonicalWorkerError(Object.assign(Error(secret),{code:'57P01'})).classification,'connection-closed');
 assert.equal(canonicalWorkerError(Object.assign(Error(secret),{code:'CIVIC_POLICY_STATE_UNSAFE'})).code,'CIVIC_POLICY_STATE_UNSAFE');
 assert.equal(canonicalWorkerError(Object.assign(Error(secret),{code:secret})).code,undefined);
 assert.throws(()=>CanonicalWorkerProgressSchema.parse({...diagnostic,connection:{password:secret}}));
});
for(const mode of ['error','exit','heap','success'] as const)test(`real supervisor preserves ${mode} outcome and last source without an orphan`,{skip:!process.env.DISTRICT_TEST_DATABASE_URL,timeout:20000},async()=>{
 const url=new URL(process.env.DISTRICT_TEST_DATABASE_URL!);assert.notEqual(url.pathname,'/civic_r1');assert.ok(url.searchParams.get('host')?.startsWith('/tmp/'));
 const {NODE_TEST_CONTEXT:_,...env}=process.env;
 const child=fork(fileURLToPath(new URL('./fixtures/step8-diagnostic-supervisor.ts',import.meta.url)),[mode],{execArgv:['--experimental-strip-types'],env,stdio:['ignore','ignore','pipe','ipc']});
 const messages:unknown[]=[];let stderr='',timer:NodeJS.Timeout|undefined;
 child.on('message',message=>messages.push(message));child.stderr!.on('data',chunk=>{stderr+=chunk.toString('utf8');});
 try{
  const [code,signal]=await Promise.race([once(child,'close'),new Promise<never>((_accept,reject)=>{timer=setTimeout(()=>reject(Error('Supervisor diagnostic deadline')),15000);})]);
  assert.equal(signal,null);assert.equal(code,mode==='success'?0:1);assert.ok(stderr.length<16384);assert.ok(!stderr.includes(secret));assert.ok(!JSON.stringify(messages).includes(secret));
  const progress=messages.map(message=>CanonicalWorkerProgressSchema.safeParse(message)).filter(result=>result.success);assert.equal(progress.length,1);assert.equal(progress[0].data.index,0);
  const diagnostics=messages.map(message=>CanonicalWorkerDiagnosticSchema.safeParse(message)).filter(result=>result.success);
  if(mode==='success'){assert.equal(diagnostics.length,0);assert.equal(messages.length,2);}
  else{
   assert.equal(diagnostics.length,1);const diagnostic=diagnostics[0].data;
   assert.equal(diagnostic.index,0);assert.equal(diagnostic.phase,'source-started');assert.equal(diagnostic.pid,child.pid);assert.ok(stderr.includes(formatCanonicalWorkerDiagnostic(diagnostic)));
   if(mode==='exit'){assert.equal(diagnostic.reason,'thread-exit');assert.equal(diagnostic.exitCode,7);}
   else{assert.equal(diagnostic.reason,'thread-error');assert.equal(diagnostic.error?.name,mode==='error'?'TypeError':'Error');if(mode==='heap'){assert.equal(diagnostic.error?.code,'ERR_WORKER_OUT_OF_MEMORY');assert.equal(diagnostic.error?.classification,'heap-limit');}}
  }
  assert.throws(()=>process.kill(child.pid!,0),{code:'ESRCH'});
 }finally{
  clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill('SIGKILL');await closed;}
 }
});
