import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,semanticHash} from '../src/district-adapter-contract.ts';
import {createPolicyReceipt,recheckPolicyReceipt,loadPolicyReceipt,PolicyReceiptSchema} from '../src/district-policy-receipt.ts';
import {recordHostOptOut,provisionCivicPolicyAuthority} from '../src/civic-opt-out.ts';

const source={url:'https://example.org/fixture.csv',sha256:digest('native fixture'),mimeType:'text/csv'};
const scope={publisherId:'fixture',sourceId:'fixture',municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'2026-10-11'};
const sourcePolicy={robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'};
const permission={kind:'distribution_licence' as const,distributionUrl:source.url,licenceId:'synthetic-test-only',termsUrl:'https://example.org/fixture-terms',termsSha256:digest('fixture terms'),approvalSha256:digest('fixture approval')};

test('policy receipts bind exact bytes, scope, licence and current optout without changing original provenance',async()=>{
 const root=await mkdtemp(join(tmpdir(),'r1-policy-'));
 try{
  const stateDir=join(root,'policy'),authority=await provisionCivicPolicyAuthority({stateDir,authorityId:`fixture:${randomUUID()}`}),policy={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
  const now=Date.now(),created=await createPolicyReceipt({source,scope,sourcePolicy,permission,checkedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60_000).toISOString()},policy);
  const checked=await recheckPolicyReceipt(created.receipt,{...policy,evaluationAt:new Date().toISOString()});
  assert.equal(checked.receiptSha256,created.receiptSha256);assert.deepEqual(checked.receipt,created.receipt);
  const cas={read:async()=>Buffer.from(JSON.stringify(created.receipt))};
  assert.deepEqual(await loadPolicyReceipt(cas,created.receiptSha256),created.receipt);
  await assert.rejects(loadPolicyReceipt(cas,digest('different')),/binding/);
  assert.equal(PolicyReceiptSchema.safeParse({...created.receipt,source:{...source,sha256:digest('changed')}}).success,false);
  await assert.rejects(recheckPolicyReceipt(created.receipt,{...policy,evaluationAt:'2020-01-01T00:00:00.000Z'}),/expired|historical/);
  const ordinary={source,scope,sourcePolicy,permission:{kind:'facts_with_attribution' as const},checkedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60_000).toISOString()};
  const ordinaryReceipt=await createPolicyReceipt(ordinary,policy);
  assert.equal(ordinaryReceipt.receipt.permission.kind,'facts_with_attribution');
  await assert.rejects(createPolicyReceipt({...ordinary,permission:{kind:'official_work'}},policy),/classification/);
  await assert.rejects(createPolicyReceipt({...ordinary,sourcePolicy:{...sourcePolicy,tdm:{state:'reserved',evidence:[]}}},policy),/blocks|excludes/);
  await assert.rejects(createPolicyReceipt({...ordinary,sourcePolicy:{...sourcePolicy,access:'authentication'}},policy),/blocks|excludes/);
  await assert.rejects(createPolicyReceipt({...ordinary,sourcePolicy:{...sourcePolicy,tdm:{state:'not_declared',evidence:[{url:source.url,locator:'RAW_SOURCE_FRAGMENT',value:'Synthetic document prose must not enter immutable policy audit.'}]}}},policy),/metadata|evidence/);
  await recordHostOptOut({host:'example.org',reason:'rights_holder_objection',reference:'fixture'},policy);
  await assert.rejects(recheckPolicyReceipt(created.receipt,{...policy,evaluationAt:new Date().toISOString()}));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('fresh admissibility can support expired generation receipt only for unchanged original bytes and scope',async()=>{
 const root=await mkdtemp(join(tmpdir(),'r1-policy-replay-'));
 try{
  const stateDir=join(root,'policy'),authority=await provisionCivicPolicyAuthority({stateDir,authorityId:`fixture:${randomUUID()}`}),policy={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
  const now=Date.now(),fresh=await createPolicyReceipt({source,scope,sourcePolicy,permission,checkedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60_000).toISOString()},policy);
  const original={...fresh.receipt,checkedAt:new Date(now-120_000).toISOString(),expiresAt:new Date(now-60_000).toISOString()};
  await assert.rejects(recheckPolicyReceipt(original,{...policy,evaluationAt:new Date().toISOString()}),/expired/);
  const result=await recheckPolicyReceipt(original,{...policy,evaluationAt:new Date().toISOString(),currentProof:fresh.receipt});
  assert.equal(result.receiptSha256,semanticHash(original));assert.equal(result.admissibilityReceiptSha256,fresh.receiptSha256);
  const other=await createPolicyReceipt({source,scope:{...scope,tenant:'different'},sourcePolicy,permission,checkedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60_000).toISOString()},policy);
  await assert.rejects(recheckPolicyReceipt(original,{...policy,evaluationAt:new Date().toISOString(),currentProof:other.receipt}),/changes original/);
 }finally{await rm(root,{recursive:true,force:true});}
});
