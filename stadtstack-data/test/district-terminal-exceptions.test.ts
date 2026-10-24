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
import {ompRunnerContractSha256,ompRunnerOutputContractSha256} from '../src/district-omp-b-runner.ts';
import {parserIsolationContractSha256,parserOutputContractSha256} from '../src/district-parser-isolation.ts';
import {acquisitionContract} from '../src/district-r1.ts';
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
// R2 source mappings (e962c1b) and the reviewed R2 acquisition executor (e8c67b6:
// guarded preparation/extraction reads, record-bound caps) advance the shared
// parser/preparation/extraction/acquisition/OMP-runner closures. These are the
// measured current identities (fresh Node 24.22.1 process), not a claim that
// frozen R1 receipts changed. Assessment queue/B, policy refresh, OMP output and
// parser output stay unchanged.
// Integrated GENESIS exact-wire custody advances only acquisition from 6ac22aa;
// fresh-process measurement leaves the other native/adapter identities unchanged.
test('terminal sealing preserves assessment identities across the measured R2 parser and acquisition cutover',async()=>{
 assert.deepEqual(await residualPreparationContract(),{preparationSha256:'c9aff861a533be4cc09ae2d9f032b17ad31329bdb9f90e47c9e5183639595d21'});
 assert.deepEqual(await residualJobContract(),{preparationSha256:'c9aff861a533be4cc09ae2d9f032b17ad31329bdb9f90e47c9e5183639595d21',extraction:{promptSha256:'11fed38a252dee91e01afebf3b593faad1c18a50c77c1535a0e1ad50ef27ffbe',schemaSha256:'1b42c79eac636f4bb32522f7912a6fd254abf80090d22e853d859b26bd0f8a54',extractorSha256:'8bca64ba7930ab103495ba06ed2e54dac886e4729cf269a2b25622d1b56b8506'},outputSha256:'6f8630a0caa782d84293fa4ff7ac4ab19b061e0dbf8384e053a87338199d11ae'});
 assert.equal(await assessmentQueueContract(),'0f8f88aaea6f4d1af62c0c4a3301f77d06ec584bc6e0b4ae24005aa964399ac9');assert.equal(await assessmentBJobContract(),'c69c8f53802e5441c9ec597f9ce7a3002986b252cafc8076e6db0a0db46b0fea');assert.equal(await policyRefreshContract(),'c8ac977c3e60522eb7bf53a5460177af3a91a8a9b8af65f788d38f12d8508884');assert.equal(await ompRunnerContractSha256(),'d1c85950dc871747b691edf6f4be82cccfb54f160ee28441c6230f9b812a0e0e');
 assert.equal(await ompRunnerOutputContractSha256(),'0dc9eca7d86d2f7cfa9ddd25140216a676c1a2a687d468cf303b8cfb37abe361');
 assert.equal(await parserIsolationContractSha256(),'281f2cabfe5fa16cc00553f92a053a822f7c65050ed1e3716d21cb8f283fbb73');assert.equal(await parserOutputContractSha256(),'3024a2b87f136379bf05fcb6d899707567f158f26c2cea0deef25dd0ae247599');
 assert.equal(await acquisitionContract(),'0a7bbfa29e22ec41bae105214b8ca85f9b8ea76272b0f5397607fed85a1e192d');
});
