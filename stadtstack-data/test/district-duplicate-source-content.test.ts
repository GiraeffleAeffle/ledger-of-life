import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {encodeStepReceipt,unknownReceiptCounts,type StepReceipt} from '../src/district-step-receipt.ts';
import {DuplicateSourceContentExceptionSchema,assertDuplicateSourceContentReceipt} from '../src/district-duplicate-source-content.ts';
import {assertStep8ExportMembership} from '../src/r1-step8-governance.ts';
import {QueueTextSealInputSchema} from '../src/district-queue-text-run.ts';
const original='a'.repeat(64),corpus='b'.repeat(64),canonicalJob='c'.repeat(64),duplicateJob='d'.repeat(64),output='e'.repeat(64),otherOutput='f'.repeat(64);
function receipt(jobKey:string,artifact:string){
 const clock='2026-10-17T00:00:00.000Z',value:StepReceipt={version:'district-step-receipt-v1',canonicalizationVersion:'district-json-v1',id:randomUUID(),runId:randomUUID(),jobKey,step:'residual_extract',lane:'residual_extraction',sourceId:'website',municipalityId:'synthetic',attempt:1,leaseToken:'1',category:'development',dependencyReceiptIds:[],enqueuedAt:clock,startedAt:clock,finishedAt:clock,queueWaitMs:0,elapsedMs:0,cpuUserMicros:null,cpuSystemMicros:null,outcome:'succeeded',reasonCode:'completed',inputHashes:[original],outputHashes:[artifact],policyProofSha256:null,originProofSha256:null,versions:{fixture:'synthetic-only'},cache:{disposition:'not_applicable',originalGenerationReceiptId:null},provider:null,counts:unknownReceiptCounts};
 return encodeStepReceipt(value);
}
function fixture(){
 const canonical=receipt(canonicalJob,output),duplicate=receipt(duplicateJob,otherOutput),pin=(documentId:string,entry:ReturnType<typeof receipt>)=>({documentId,jobKey:entry.receipt.jobKey,receiptId:entry.receipt.id,receiptSha256:entry.sha256,extractionArtifactSha256:entry.receipt.outputHashes[0],sourceSha256:original});
 const exception=DuplicateSourceContentExceptionSchema.parse({...pin('z-duplicate',duplicate),step:'residual_extract',reasonCode:'duplicate_source_content',selectionRule:'smallest_document_id_v1',municipalityId:'synthetic',sourceId:'website',corpusSha256:corpus,sourceUrl:'https://example.org/duplicate',canonical:pin('a-canonical',canonical),outcome:duplicate.receipt.outcome,receipt:duplicate.receipt,attemptHistory:[{receipt:duplicate.receipt,sha256:duplicate.sha256}],excludedRecords:[{recordId:'synthetic-record',evidenceSha256:original}],excludedAssessmentJobKeys:[]});
 const source={municipalityId:'synthetic',sourceId:'website',corpus:{path:'/synthetic/index',sha256:corpus},documents:[{documentId:'z-duplicate',sha256:original,jobKey:duplicateJob},{documentId:'a-canonical',sha256:original,jobKey:canonicalJob}]},result={documentId:'a-canonical',corpusSha256:corpus,result:{taskId:canonicalJob,municipalityId:'synthetic',sourceSha256:original}};
 return {source,result,exception,steps:[canonical,duplicate]};
}
test('all-document membership admits exactly one smallest-ID native result plus a pinned duplicate disposition',()=>{
 const {source,result,exception,steps}=fixture();assert.doesNotThrow(()=>assertStep8ExportMembership(source,[result],[exception],steps));
 assert.doesNotThrow(()=>assertStep8ExportMembership({...source,documents:[...source.documents].reverse()},[result],[exception],steps));
 assert.equal(exception.reasonCode,'duplicate_source_content');assert.equal(exception.receipt.reasonCode,'completed');
 assert.equal(QueueTextSealInputSchema.safeParse({jobKeys:[canonicalJob],reconciliationJobKeys:[],terminalDocumentExceptions:[exception]}).success,false,'derived dispositions are never caller-supplied job holds');
});
test('duplicate membership rejects missing dispositions, duplicate admissions and divergent canonical choice',()=>{
 const {source,result,exception,steps}=fixture();
 assert.throws(()=>assertStep8ExportMembership(source,[result],[],steps),/document\/job set/);
 const duplicateResult={...result,documentId:exception.documentId,result:{...result.result,taskId:duplicateJob}};
 assert.throws(()=>assertStep8ExportMembership(source,[result,duplicateResult],[],steps));
 const wrong={...exception,documentId:result.documentId,jobKey:canonicalJob,canonical:{...exception.canonical,documentId:exception.documentId,jobKey:duplicateJob}};
 assert.throws(()=>assertStep8ExportMembership(source,[duplicateResult],[wrong],steps),/canonical native document/);
});
test('duplicate membership rejects nonidentical bytes, unrelated receipt/output pins and foreign scope',()=>{
 const {source,result,exception,steps}=fixture();
 const mismatchedBytes={...exception,canonical:{...exception.canonical,sourceSha256:otherOutput}},mismatchedPin={...exception,canonical:{...exception.canonical,receiptSha256:otherOutput}};
 assert.throws(()=>assertStep8ExportMembership(source,[result],[{...exception,sourceSha256:otherOutput}],steps),/document\/job set/);
 assert.throws(()=>assertStep8ExportMembership(source,[result],[mismatchedBytes],steps),/binding mismatch/);
 assert.throws(()=>assertDuplicateSourceContentReceipt({...exception,extractionArtifactSha256:output}),/binding mismatch/);
 assert.throws(()=>assertStep8ExportMembership(source,[result],[mismatchedPin],steps),/not in the authenticated seal/);
 assert.throws(()=>assertStep8ExportMembership(source,[result],[exception],[]),/not in the authenticated seal/);
 assert.throws(()=>assertStep8ExportMembership(source,[result],[{...exception,sourceId:'foreign'}],steps),/source scope/);
 const uniqueSource={...source,documents:source.documents.map(document=>document.documentId===exception.documentId?{...document,sha256:otherOutput}:document)};
 assert.throws(()=>assertStep8ExportMembership(uniqueSource,[result],[{...exception,sourceSha256:otherOutput}],steps),/canonical native document/);
});
