import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseError,type Pool} from 'pg';
import {EventEmitter} from 'node:events';
import type {DistrictCas} from '../src/district-cas.ts';
import {QueueTextSealInputSchema,buildQueueTextRun,sealQueueTextContribution} from '../src/district-queue-text-run.ts';
import {formatQueueTextSealException} from '../src/district-exception-diagnostics.ts';
import {formatR1Failure} from '../src/district-r1.ts';
import {z} from 'zod';
const key='a'.repeat(64),final='b'.repeat(64);

test('queue sealing selects committed jobs, never a caller-supplied run, clock, model or seal',()=>{
 const input={jobKeys:[key],reconciliationJobKeys:[final]};
 assert.deepEqual(QueueTextSealInputSchema.parse(input),{...input,terminalDocumentExceptions:[],terminalAssessmentExceptions:[],assessmentItemHolds:[]});
 assert.deepEqual(QueueTextSealInputSchema.parse({...input,reconciliationJobKeys:[]}),{jobKeys:[key],reconciliationJobKeys:[],terminalDocumentExceptions:[],terminalAssessmentExceptions:[],assessmentItemHolds:[]});
 assert.equal(QueueTextSealInputSchema.parse({...input,attemptHistory:'committed-v1'}).attemptHistory,'committed-v1');
 assert.throws(()=>QueueTextSealInputSchema.parse({...input,attemptHistory:'rewrite-legacy'}));
 const hold={preparationJobKey:key,itemBundleArtifactSha256:key,holdReceiptArtifactSha256:final};
 assert.deepEqual(QueueTextSealInputSchema.parse({...input,assessmentItemHolds:[hold]}).assessmentItemHolds,[hold]);
 assert.throws(()=>QueueTextSealInputSchema.parse({...input,assessmentItemHolds:[hold,hold]}));
 assert.throws(()=>QueueTextSealInputSchema.parse({...input,assessmentItemHolds:[{...hold,receipt:{outcome:'held_quality'}}]}));
 for(const extra of [{generatedAt:'2026-10-13T00:00:00Z'},{runId:key},{model:'gpt-6.1-sol'},{records:[]},{sealSha256:key},{policyApproved:true}])assert.throws(()=>QueueTextSealInputSchema.parse({...input,...extra}));
 for(const invalid of [{jobKeys:[],reconciliationJobKeys:[]},{...input,jobKeys:[key,key]},{...input,reconciliationJobKeys:[final,final]},{...input,jobKeys:['invented-output']}])assert.throws(()=>QueueTextSealInputSchema.parse(invalid));
});
test('an uncommitted extraction cannot become a native extraction run',async()=>{
 const pool=Object.assign(new EventEmitter(),{query:async()=>({rows:[]})}) as unknown as Pool;
 await assert.rejects(buildQueueTextRun(pool,{} as DistrictCas,{jobKeys:[key],reconciliationJobKeys:[]}),/not committed/);
});

test('a failed seal emits one content-free diagnostic and rethrows the exact database error',async t=>{
 const error=new DatabaseError('PRIVATE synthetic document and database detail',0,'error'),source=new URL('../src/district-queue-text-run.ts',import.meta.url);
 error.code='23514';error.stack=`error: PRIVATE synthetic document and database detail\n    at /private/node_modules/pg/client.js:1:1\n    at async ${source.href}:42:9`;
 const pool=Object.assign(new EventEmitter(),{query:async()=>{throw error;}}) as unknown as Pool,lines:string[]=[];
 t.mock.method(process.stderr,'write',(chunk:unknown)=>{lines.push(String(chunk));return true;});
 await assert.rejects(sealQueueTextContribution(pool,{} as DistrictCas,{jobKeys:[key],reconciliationJobKeys:[]}),caught=>caught===error);
 assert.deepEqual(lines,['R1_EXCEPTION command=seal-text-contribution class=DatabaseError code=23514 at=src/district-queue-text-run.ts:42\n']);
 assert.equal(formatR1Failure(error,'admission'),'R1_FAILURE phase=admission code=R1_COMMAND_FAILED\n');
});
test('a seal schema rejection emits its bounded class without input content or database access',async t=>{
 let queries=0;const pool=Object.assign(new EventEmitter(),{query:async()=>{queries++;throw Error('Unexpected synthetic query');}}) as unknown as Pool,lines:string[]=[];
 t.mock.method(process.stderr,'write',(chunk:unknown)=>{lines.push(String(chunk));return true;});
 await assert.rejects(sealQueueTextContribution(pool,{} as DistrictCas,{jobKeys:['PRIVATE synthetic input'],reconciliationJobKeys:[]}),error=>error instanceof z.ZodError);
 assert.equal(queries,0);assert.equal(lines.length,1);
 assert.match(lines[0],/^R1_EXCEPTION command=seal-text-contribution class=ZodError code=other at=src\/district-queue-text-run\.ts:[1-9]\d*\n$/);
 assert.ok(lines[0].length<512);assert.ok(!lines[0].includes('PRIVATE'));
});
test('a failed seal preserves the original rejection when diagnostic output also fails',async t=>{
 const error=new Error('PRIVATE synthetic original failure'),pool=Object.assign(new EventEmitter(),{query:async()=>{throw error;}}) as unknown as Pool;
 const write=t.mock.method(process.stderr,'write',()=>{throw Error('PRIVATE synthetic stderr failure');});
 await assert.rejects(sealQueueTextContribution(pool,{} as DistrictCas,{jobKeys:[key],reconciliationJobKeys:[]}),caught=>caught===error);
 assert.equal(write.mock.callCount(),1);
});
test('seal diagnostic fields retain the closed vocabulary and exclude multiline message frames',async()=>{
 const prefix='R1_EXCEPTION command=seal-text-contribution ',source=new URL('../src/district-queue-text-run.ts',import.meta.url);
 const injected=new Error(`PRIVATE synthetic message\n    at forged (${source.href}:42:9)`);
 assert.equal(await formatQueueTextSealException(injected),prefix+'class=Error code=other at=none\n');
 const hostile=new Proxy({},{get(){throw Error('PRIVATE synthetic accessor');},getPrototypeOf(){throw Error('PRIVATE synthetic prototype');}});
 for(const error of [hostile,{constructor:{name:'PRIVATE'},code:'PRIVATE\nCODE',stack:'PRIVATE'},null,'PRIVATE'])assert.equal(await formatQueueTextSealException(error),prefix+'class=other code=other at=none\n');
});
