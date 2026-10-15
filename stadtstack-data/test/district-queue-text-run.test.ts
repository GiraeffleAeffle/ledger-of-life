import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {EventEmitter} from 'node:events';
import type {DistrictCas} from '../src/district-cas.ts';
import {QueueTextSealInputSchema,buildQueueTextRun} from '../src/district-queue-text-run.ts';
const key='a'.repeat(64),final='b'.repeat(64);

test('queue sealing selects committed jobs, never a caller-supplied run, clock, model or seal',()=>{
 const input={jobKeys:[key],reconciliationJobKeys:[final]};
 assert.deepEqual(QueueTextSealInputSchema.parse(input),{...input,terminalDocumentExceptions:[],terminalAssessmentExceptions:[]});
 assert.deepEqual(QueueTextSealInputSchema.parse({...input,reconciliationJobKeys:[]}),{jobKeys:[key],reconciliationJobKeys:[],terminalDocumentExceptions:[],terminalAssessmentExceptions:[]});
 for(const extra of [{generatedAt:'2026-10-13T00:00:00Z'},{runId:key},{model:'gpt-6.1-sol'},{records:[]},{sealSha256:key},{policyApproved:true}])assert.throws(()=>QueueTextSealInputSchema.parse({...input,...extra}));
 for(const invalid of [{jobKeys:[],reconciliationJobKeys:[]},{...input,jobKeys:[key,key]},{...input,reconciliationJobKeys:[final,final]},{...input,jobKeys:['invented-output']}])assert.throws(()=>QueueTextSealInputSchema.parse(invalid));
});
test('an uncommitted extraction cannot become a native extraction run',async()=>{
 const pool=Object.assign(new EventEmitter(),{query:async()=>({rows:[]})}) as unknown as Pool;
 await assert.rejects(buildQueueTextRun(pool,{} as DistrictCas,{jobKeys:[key],reconciliationJobKeys:[]}),/not committed/);
});
