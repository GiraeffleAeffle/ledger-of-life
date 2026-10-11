import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest} from '../src/district-adapter-contract.ts';
import {CANONICALIZATION_VERSION,STEP_RECEIPT_VERSION,encodeStepReceipt,unknownReceiptCounts,type StepReceipt} from '../src/district-step-receipt.ts';

function fixture():StepReceipt {
  return {version:STEP_RECEIPT_VERSION,canonicalizationVersion:CANONICALIZATION_VERSION,id:randomUUID(),runId:randomUUID(),jobKey:digest('job'),step:'parse',lane:'cpu',sourceId:'synthetic',municipalityId:'strausberg',attempt:1,leaseToken:'1',category:'development',dependencyReceiptIds:[],enqueuedAt:'2026-10-11T00:00:00.000Z',startedAt:'2026-10-11T00:00:01.000Z',finishedAt:'2026-10-11T00:00:02.000Z',queueWaitMs:1000,elapsedMs:999.5,cpuUserMicros:null,cpuSystemMicros:null,outcome:'succeeded',reasonCode:'completed',inputHashes:[digest('input')],outputHashes:[digest('output')],policyProofSha256:digest('policy'),originProofSha256:null,versions:{parser:'v1'},cache:{disposition:'miss',originalGenerationReceiptId:null},provider:null,counts:{...unknownReceiptCounts}};
}
test('receipts hash canonical byte encoding and keep unknown usage and counts null',()=>{
  const receipt=fixture(),encoded=encodeStepReceipt(receipt);
  assert.equal(encoded.sha256,digest(encoded.bytes));assert.deepEqual(JSON.parse(encoded.bytes),receipt);
  assert.equal(encoded.receipt.counts.pages,null);assert.equal(encoded.receipt.cpuUserMicros,null);assert.equal(encoded.receipt.provider,null);
  assert.notEqual(encoded.sha256,encodeStepReceipt({...receipt,elapsedMs:1000}).sha256);
});
test('cache provenance, dependencies, fence and ordered clocks are mandatory',()=>{
  const receipt=fixture();
  assert.throws(()=>encodeStepReceipt({...receipt,cache:{disposition:'hit',originalGenerationReceiptId:null}}),/original/);
  assert.throws(()=>encodeStepReceipt({...receipt,inputHashes:[receipt.inputHashes[0],receipt.inputHashes[0]]}),/Duplicate/);
  assert.throws(()=>encodeStepReceipt({...receipt,leaseToken:'0'}));
  assert.throws(()=>encodeStepReceipt({...receipt,finishedAt:'2026-10-10T00:00:00.000Z'}),/clock/);
  assert.throws(()=>encodeStepReceipt({...receipt,reasonCode:'private-error-containing-document' as StepReceipt['reasonCode']}));
  assert.throws(()=>encodeStepReceipt({...receipt,privateSourceBody:'not metrics'} as StepReceipt));
});
test('provider receipts retain separate token/cost categories without invented billed zero or model identity',()=>{
  const receipt=fixture();
  receipt.provider={provider:'openai',endpoint:'/v1/responses',requestedModel:'pinned-snapshot',returnedModel:null,requestId:null,responseId:null,requestSha256:digest('request'),responseSha256:null,batchId:null,customId:null,submissionIntentSha256:digest('intent'),tokens:{standardInput:null,cacheWriteInput:null,cacheReadInput:null,output:null},actualBilledUsd:null,estimatedApiUsd:0.01,currency:'USD',rateCardDate:null,rateCardSha256:null,reservedMicroUsd:10000,subscriptionUsage:{availability:'unavailable',units:null}};
  const encoded=encodeStepReceipt(receipt);assert.equal(encoded.receipt.provider?.actualBilledUsd,null);assert.equal(encoded.receipt.provider?.returnedModel,null);
  assert.throws(()=>encodeStepReceipt({...receipt,provider:{...receipt.provider!,subscriptionUsage:{availability:'unavailable',units:0}}}),/zero-filled/);
});
