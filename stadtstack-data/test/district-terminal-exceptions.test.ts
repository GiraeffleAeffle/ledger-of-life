import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {digest} from '../src/district-adapter-contract.ts';
import {canonicalJobIdentity,type DistrictJobSpec} from '../src/district-jobs.ts';
import {encodeStepReceipt,unknownReceiptCounts,type StepReceipt} from '../src/district-step-receipt.ts';
import {loadTerminalException,TerminalDocumentExceptionSchema,TerminalAssessmentExceptionSchema} from '../src/district-terminal-exceptions.ts';
import {QueueTextSealInputSchema} from '../src/district-queue-text-run.ts';
import {assertStep8ExportMembership} from '../src/r1-step8-governance.ts';
import {residualPreparationContract,residualJobContract} from '../src/district-residual-jobs.ts';
import {assessmentQueueContract} from '../src/district-assessment-jobs.ts';
import {assessmentBJobContract} from '../src/district-assessment-broker.ts';
import {policyRefreshContract} from '../src/district-policy-refresh.ts';
import {ompRunnerContractSha256} from '../src/district-omp-b-runner.ts';
const a=digest('synthetic original'),b=digest('synthetic policy'),scope={publisherId:'synthetic',sourceId:'website',municipalityId:'strausberg',ags:'12064472',tenant:null,observationWindow:'synthetic terminal fixture'};
const spec:DistrictJobSpec={step:'residual_prepare',lane:'residual_preparation',semanticContractSha256:digest('synthetic semantic contract'),inputArtifactHashes:[a,b],sourceScope:scope,selector:{synthetic:true},policyProofSha256:b},jobKey=canonicalJobIdentity(spec).jobKey;
function row(attempt=1){
 const clock='2026-10-15T00:00:00.000Z',receipt:StepReceipt={version:'district-step-receipt-v1',canonicalizationVersion:'district-json-v1',id:randomUUID(),runId:randomUUID(),jobKey,step:spec.step,lane:spec.lane,sourceId:scope.sourceId,municipalityId:scope.municipalityId,attempt,leaseToken:String(attempt),category:'development',dependencyReceiptIds:[],enqueuedAt:clock,startedAt:clock,finishedAt:clock,queueWaitMs:0,elapsedMs:0,cpuUserMicros:null,cpuSystemMicros:null,outcome:'held_execution',reasonCode:'isolation_unavailable',inputHashes:spec.inputArtifactHashes,outputHashes:[],policyProofSha256:b,originProofSha256:null,versions:{fixture:'synthetic-only'},cache:{disposition:'not_applicable',originalGenerationReceiptId:null},provider:null,counts:unknownReceiptCounts},encoded=encodeStepReceipt(receipt),id=randomUUID();
 return {job_id:id,job_key:jobKey,job_step:spec.step,spec,state:receipt.outcome,reason_code:receipt.reasonCode,current_attempt:attempt,receipt_id:receipt.id,receipt_job_id:id,run_id:receipt.runId,attempt,fencing_token:receipt.leaseToken,outcome:receipt.outcome,receipt,receipt_sha256:encoded.sha256};
}
const pin=(value:ReturnType<typeof row>)=>TerminalDocumentExceptionSchema.parse({documentId:'original',step:'residual_prepare',jobKey,receiptId:value.receipt.id,receiptSha256:value.receipt_sha256,reasonCode:value.receipt.reasonCode});
const pool=(rows:unknown[])=>({query:async()=>({rows})}) as unknown as Pool;
test('terminal exception authenticates current held receipt and retains actual attempt history',async()=>{
 const first=row(),current=row(2);first.current_attempt=2;first.job_id=current.job_id;first.receipt_job_id=current.job_id;
 const value=await loadTerminalException(pool([first,current]),pin(current));assert.equal(value.attemptHistory.length,2);assert.deepEqual(value.attemptHistory.map(entry=>entry.receipt.id),[first.receipt.id,current.receipt.id]);
 for(const mutation of [{state:'queued'},{current_attempt:3},{receipt_sha256:a},{receipt_id:randomUUID()},{receipt_job_id:randomUUID()},{outcome:'succeeded'},{run_id:randomUUID()},{fencing_token:'999'},{reason_code:'execution_exception'}])await assert.rejects(loadTerminalException(pool([{...current,...mutation}]),pin(current)),/Terminal exception/);
 await assert.rejects(loadTerminalException(pool([first,current]),pin(first)),/current committed held attempt/);
 await assert.rejects(loadTerminalException(pool([current]),{...pin(current),reasonCode:'execution_exception'}),/current committed held attempt/);
});
test('terminal source membership is exact extracted/negative/exception disjoint union',()=>{
 const value=row(),exception={...pin(value),municipalityId:scope.municipalityId,sourceId:scope.sourceId,sourceSha256:a,corpusSha256:b},source={municipalityId:scope.municipalityId,sourceId:scope.sourceId,corpus:{path:'/synthetic',sha256:b},documents:[{documentId:'original',sha256:a,jobKey}]};
 assert.doesNotThrow(()=>assertStep8ExportMembership(source,[],[exception]));assert.throws(()=>assertStep8ExportMembership(source,[],[]),/document\/job set/);assert.throws(()=>assertStep8ExportMembership(source,[],[exception,exception]),/document\/job set/);assert.throws(()=>assertStep8ExportMembership(source,[],[{...exception,sourceId:'other'}]),/source scope/);
 assert.throws(()=>assertStep8ExportMembership(source,[{documentId:'original',corpusSha256:b,result:{taskId:jobKey,municipalityId:scope.municipalityId,sourceSha256:a}}],[exception]),/document\/job set/);
});
test('seal permits all-terminal documents but rejects empty, duplicate and overlapping selections',()=>{
 const exception=pin(row());assert.doesNotThrow(()=>QueueTextSealInputSchema.parse({jobKeys:[],reconciliationJobKeys:[],terminalDocumentExceptions:[exception]}));
 for(const value of [{jobKeys:[],reconciliationJobKeys:[]},{jobKeys:[],reconciliationJobKeys:[],terminalDocumentExceptions:[exception,exception]},{jobKeys:[jobKey],reconciliationJobKeys:[],terminalDocumentExceptions:[exception]}])assert.equal(QueueTextSealInputSchema.safeParse(value).success,false);
 assert.equal(TerminalAssessmentExceptionSchema.safeParse({...exception,step:'assessment_b'}).success,true);assert.equal(TerminalDocumentExceptionSchema.safeParse({...exception,step:'assessment_b'}).success,false);
});
// The four non-B scoped contracts remain at the running campaign's 93b967d
// cutover. B/runner pins advance for native diagnostics, unlocked evidence,
// immutable native image addons, settled decoder rejection and physical inventory repacking;
// terminal sealing adds no semantic change.
test('terminal sealing preserves four scoped contracts with the explicit B decoder cutover',async()=>{
 assert.deepEqual(await residualPreparationContract(),{preparationSha256:'be383e7da40ef2d686702d626bf060ab9cd88c80b159a1fb46582054e53d0eaa'});
 assert.deepEqual(await residualJobContract(),{preparationSha256:'be383e7da40ef2d686702d626bf060ab9cd88c80b159a1fb46582054e53d0eaa',extraction:{promptSha256:'2ee1b59defd3506bf861190724079aaa2ff8f77a5b137d33550195a9a6ed64f9',schemaSha256:'1b42c79eac636f4bb32522f7912a6fd254abf80090d22e853d859b26bd0f8a54',extractorSha256:'cb8bf07b9944205dc8e3eb5484a0a612a2b606665f56331d0273e786f9074ef9'},outputSha256:'6f8630a0caa782d84293fa4ff7ac4ab19b061e0dbf8384e053a87338199d11ae'});
 assert.equal(await assessmentQueueContract(),'9b8c4cf4534a32bc98190310d591935cbf515a0cb8aed12ba9efeb4b5bbd56de');assert.equal(await assessmentBJobContract(),'ae20e04ffd9102d787dd0dd04ce63cc6ea9e238c545e6d80ac0a5ce388d50449');assert.equal(await policyRefreshContract(),'c8ac977c3e60522eb7bf53a5460177af3a91a8a9b8af65f788d38f12d8508884');assert.equal(await ompRunnerContractSha256(),'43d8de04fc0a63e351200771c5f64c4ed9ea0c6425b3124bae0d9c392cfa50f6');
});
