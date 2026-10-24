import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {digest} from '../src/district-adapter-contract.ts';
import {CODEX_ASSESSMENT_ALLOWANCE_PIN,CodexAssessmentAllowanceSchema,CohortSchema} from '../src/district-codex-allowance.ts';
import {assessmentQueueContract} from '../src/district-assessment-jobs.ts';

const approvals=new URL('../reports/approvals/',import.meta.url);
test('committed r5 lead allowance authenticates the current queue, both owner records and frozen membership',async()=>{
 const bytes=await readFile(new URL(CODEX_ASSESSMENT_ALLOWANCE_PIN.id+'.json',approvals));assert.equal(digest(bytes),CODEX_ASSESSMENT_ALLOWANCE_PIN.sha256);
 const record=CodexAssessmentAllowanceSchema.parse(JSON.parse(bytes.toString('utf8')));assert.equal(record.id,CODEX_ASSESSMENT_ALLOWANCE_PIN.id);assert.equal(record.expiresAt,'2026-10-25T21:59:59Z');
 assert.equal(record.assessment.queueContractSha256,await assessmentQueueContract());
 for(const [id,sha256] of [
  ['r1-codex-assessment-allowance-2026-10-17','fe20dffb70f1521b90deca2b5070fcf37a3c468fbad386820b12a6e040a6055a'],
  ['r1-codex-assessment-allowance-2026-10-17-r2','8e246c5736c0a556b7d27f87e72e38ece1fe946e66a5fef13023e36cae0fef8d'],
  ['r1-codex-assessment-allowance-2026-10-17-r3','2e38add3bff06319566fdfcdf21cda85566deda77e07f5c8a7984e74fa9fea2d'],
  ['r1-codex-assessment-allowance-2026-10-17-r4','2d468d0967b122cf2c679586a37016bedb8d5a5f05220b5f47935557168110fd']
 ]){
  const historicalBytes=await readFile(new URL(id+'.json',approvals));assert.equal(digest(historicalBytes),sha256);
  const historicalRecord=JSON.parse(historicalBytes.toString('utf8'));assert.equal(CodexAssessmentAllowanceSchema.safeParse(historicalRecord).success,false);
  if(id==='r1-codex-assessment-allowance-2026-10-17-r3'){
   assert.equal(historicalRecord.assessment.queueContractSha256,'ec919ead603d2ab647adce1ebb2b3d17e78d0f4ba4ff928d7e44c9f8150d6bb2');
   assert.notEqual(historicalRecord.assessment.queueContractSha256,record.assessment.queueContractSha256);
  }
 }
 assert.equal(CodexAssessmentAllowanceSchema.safeParse({...record,id:record.id+'-other'}).success,false);
 for(const owner of [record.parentApproval,record.delegationApproval])assert.equal(digest(await readFile(new URL(owner.id+'.json',approvals))),owner.sha256);
 const cohortBytes=await readFile(new URL('r1-frozen-assessment-cohort-2026-10-17.json',approvals));assert.equal(digest(cohortBytes),record.cohort.sha256);assert.equal(record.cohort.sha256,'24c8629ec588f4898988c7ee7a61eb7e7b2809d0b0ab052fc34669512e789965');
 const cohort=CohortSchema.parse(JSON.parse(cohortBytes.toString('utf8')));
 assert.equal(cohort.sourceCount,27);assert.equal(cohort.documentCount,208);assert.equal(cohort.uniqueOriginalCount,193);
 assert.equal(cohort.sources.length,27);assert.equal(cohort.documents.length,208);assert.equal(new Set(cohort.documents.map(member=>member.originalSha256)).size,193);
 assert.equal(CodexAssessmentAllowanceSchema.safeParse({...record,issuedAt:''}).success,false);
 assert.equal(CodexAssessmentAllowanceSchema.safeParse({...record,expiresAt:'2026-10-26T00:00:00Z'}).success,false);
 assert.equal(CodexAssessmentAllowanceSchema.safeParse({...record,bounds:{...record.bounds,maxExtraCallsPerOriginal:25}}).success,false);
 assert.equal(CodexAssessmentAllowanceSchema.safeParse({...record,bounds:{...record.bounds,maxExtraCallsCohort:101}}).success,false);
 assert.equal(CodexAssessmentAllowanceSchema.safeParse({...record,bounds:{...record.bounds,paidMicroUsd:1}}).success,false);
 assert.equal(CodexAssessmentAllowanceSchema.safeParse({...record,assessment:{...record.assessment,projectionVersion:'assessment-source-record-v1'}}).success,false);
});
