import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {digest} from '../src/district-adapter-contract.ts';
import {CODEX_ASSESSMENT_ALLOWANCE_PIN,CodexAssessmentAllowanceSchema,CohortSchema} from '../src/district-codex-allowance.ts';

const approvals=new URL('../reports/approvals/',import.meta.url);
test('committed lead allowance authenticates both owner records and the exact frozen membership',async()=>{
 const bytes=await readFile(new URL(CODEX_ASSESSMENT_ALLOWANCE_PIN.id+'.json',approvals));assert.equal(digest(bytes),CODEX_ASSESSMENT_ALLOWANCE_PIN.sha256);
 const record=CodexAssessmentAllowanceSchema.parse(JSON.parse(bytes.toString('utf8')));assert.equal(record.id,CODEX_ASSESSMENT_ALLOWANCE_PIN.id);assert.equal(record.expiresAt,'2026-10-25T21:59:59Z');
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
