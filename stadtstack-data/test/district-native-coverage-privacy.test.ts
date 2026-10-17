import test from 'node:test';
import assert from 'node:assert/strict';
import {structuredCoverageReceiptSchema,structuredPublicCoverageReceiptSchema,projectStructuredCoverageReceipt} from '../src/district-structured-run.ts';
import {semanticHash} from '../src/district-adapter-contract.ts';

// Synthetic diagnostic metadata only: no parser run or acquisition is claimed.
const sentinel='PRIVATE_SENTINEL resident name, contact, coordinate, source fragment';
function privateRow(){return structuredCoverageReceiptSchema.parse({family:'synthetic-family',operation:'parse',adapterId:'synthetic-parser',adapterVersion:null,municipalityId:'synthetic-town',sourceId:'synthetic-source',scopeSha256:'1'.repeat(64),sourceSha256:null,policyReceiptSha256:null,stepReceiptSha256:'2'.repeat(64),additionalStepReceiptSha256s:[],coverage:{state:'held_quality',scope:sentinel,reason:'XML parse error: '+sentinel,checkedAt:'2026-10-11T12:00:00.000Z',nextCursor:sentinel,observedRows:0,limitations:[sentinel]}});}
test('native public coverage keeps failed state and hashed diagnostic, never raw parser fragments',()=>{
 const original=privateRow(),before=structuredClone(original),publicRow=projectStructuredCoverageReceipt(original);
 assert.equal(publicRow.operation,'parse');
 assert.equal(publicRow.coverage.state,'held_quality');
 assert.equal(publicRow.coverage.observedRows,0);
 assert.equal(publicRow.coverage.checkedAt,original.coverage.checkedAt);
 assert.equal(publicRow.coverage.reasonCode,'source_reported_held_quality');
 assert.equal(publicRow.coverage.diagnosticSha256,semanticHash(original.coverage));
 assert.equal(JSON.stringify(publicRow).includes('PRIVATE_SENTINEL'),false);
 for(const field of ['reason','scope','nextCursor','limitations'])assert.equal(Object.hasOwn(publicRow.coverage,field),false);
 assert.deepEqual(original,before);
 assert.equal(structuredPublicCoverageReceiptSchema.safeParse({...publicRow,coverage:{...publicRow.coverage,reason:sentinel}}).success,false);
});
test('changed private diagnostics remain distinguishable without exposing their content',()=>{
 const original=privateRow(),changed=structuredClone(original);changed.coverage.reason+=' another private source fragment';
 assert.notEqual(projectStructuredCoverageReceipt(original).coverage.diagnosticSha256,projectStructuredCoverageReceipt(changed).coverage.diagnosticSha256);
});
