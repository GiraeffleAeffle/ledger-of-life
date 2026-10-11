import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DistrictCas} from '../src/district-cas.ts';
import {canonicalJson,digest,observation,semanticHash,type AdapterScope} from '../src/district-adapter-contract.ts';
import {createPolicyReceipt,type PolicyReceipt} from '../src/district-policy-receipt.ts';
import {admitStructuredObservations} from '../src/district-structured-record.ts';
import {recheckPublicationPolicy,publicationPolicyReceiptInventorySchema} from '../src/district-publication-policy.ts';
import {recordHostOptOut,provisionCivicPolicyAuthority} from '../src/civic-opt-out.ts';

// Synthetic source and origin evidence exercise private receipt binding, never real source admission.
const bytes=Buffer.from('synthetic policy publication row'),sourceSha256=digest(bytes),url='https://example.org/synthetic-policy.csv';
const scope:AdapterScope={publisherId:'synthetic-publisher',sourceId:'synthetic-source',municipalityId:'synthetic-town',ags:'12064472',tenant:null,observationWindow:'synthetic fixture'};
async function fixture(directory:string){
 const cas=new DistrictCas(join(directory,'cas')),stateDir=join(directory,'policy-state'),now=Date.now();
 const authority=await provisionCivicPolicyAuthority({stateDir,authorityId:'fixture:'+randomUUID()}),policyOptions={stateDir,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const checkedAt=new Date(now-1000).toISOString(),expiresAt=new Date(now+60_000).toISOString();
 const sourcePolicy={robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_reserved',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only',documentOrigin:{classification:'official_work',method:'rules',classifierVersion:'synthetic-fixture',url,sha256:sourceSha256,classifiedAt:checkedAt,evidence:[{locator:'synthetic fixture',value:'Synthetic official-work origin fixture; no civic evidence.'}]}};
 const admission=await createPolicyReceipt({source:{url,sha256:sourceSha256,mimeType:'text/csv'},sourcePolicy,permission:{kind:'official_work'},scope,checkedAt,expiresAt},policyOptions);
 await cas.put(Buffer.from(canonicalJson(admission.receipt)),{kind:'receipt',mimeType:'application/json'});
 await cas.put(bytes,{kind:'source_original',mimeType:'text/csv',admission:{state:'allowed',sourceSha256,policyProofSha256:admission.receiptSha256,checkedAt,expiresAt}});
 const native=observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId:'fixture-row',nativeVersion:null,kind:'StatisticalObservation',subject:'synthetic indicator',predicate:'fixture_value',value:1,unit:'persons',date:'2022-05-15',dateRole:'reference_date',financialRole:'none',geography:{ags:scope.ags,basis:'source_explicit',role:'administrative_area'},sourceReferenceDate:'2022-05-15',publishedAt:null,retrievedAt:checkedAt,evidence:[{sourceSha256,format:'csv',nativeId:'fixture-row',path:'/value',sheet:null,rowKey:'fixture-row',cells:['value'],rawValue:1,schemaHash:'1'.repeat(64),mappingVersion:'synthetic-v1'}],limitations:['Synthetic fixture.']});
 const records=await admitStructuredObservations({adapter:{id:'synthetic-fixture',version:'synthetic-v1'},adapterContractSha256:'2'.repeat(64),snapshot:{bytes,sourceSha256,url,mimeType:'text/csv',retrievedAt:checkedAt,policyReceiptSha256:admission.receiptSha256,sourceVersion:null},scope,districtId:'synthetic-district',candidates:[native],replayInSandbox:async()=>({observations:[native],coverage:{state:'complete',scope:'synthetic fixture',reason:'Synthetic row.',checkedAt,nextCursor:null,observedRows:1,limitations:['Synthetic fixture.']}}),checkCurrentPolicy:async()=>({allowed:true,receiptSha256:admission.receiptSha256,sourceSha256,scopeSha256:semanticHash(scope),checkedAt})});
 const inventory={records:[{recordId:records[0].id,receipts:[{sourceUrl:url,sourceSha256,receiptSha256:admission.receiptSha256}]}]};
 return {cas,stateDir,policyOptions,admission,records,inventory};
}

test('publication resolves real private receipt bytes and retains original policy binding on replay',async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'stadtstack-publication-policy-'));
 try{
  const {cas,stateDir,records,inventory,admission}=await fixture(directory);
  const first=await recheckPublicationPolicy(records,inventory,cas,{stateDir,evaluationAt:new Date().toISOString()});
  assert.equal(first.policy.receipts[0].receiptSha256,admission.receiptSha256);
  const replay=await recheckPublicationPolicy(records,inventory,cas,{stateDir,evaluationAt:new Date().toISOString(),originalPolicy:first.policy});
  assert.deepEqual(replay.policy,first.policy);
  assert.equal(replay.inventorySha256,first.inventorySha256);
  const rebound={records:[{...inventory.records[0],receipts:[{...inventory.records[0].receipts[0],sourceSha256:'3'.repeat(64)}]}]};
  await assert.rejects(recheckPublicationPolicy(records,rebound,cas,{stateDir,evaluationAt:new Date().toISOString()}),/binding mismatch/);
  await assert.rejects(recheckPublicationPolicy(records,{records:[]},cas,{stateDir,evaluationAt:new Date().toISOString()}),/actual policy receipts/);
  await assert.rejects(recheckPublicationPolicy(records,inventory,cas,{stateDir,evaluationAt:'2022-05-15T12:00:00.000Z'}),/historical clock|expired|revalidation/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('expired original receipt needs actual same-source current proof without altering its provenance',async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'stadtstack-expired-publication-policy-'));
 try{
  const {cas,stateDir,admission,records,inventory}=await fixture(directory),now=Date.now();
  const expired:PolicyReceipt={...admission.receipt,checkedAt:new Date(now-120_000).toISOString(),expiresAt:new Date(now-60_000).toISOString()};
  const originalHash=semanticHash(expired);await cas.put(Buffer.from(canonicalJson(expired)),{kind:'receipt',mimeType:'application/json'});
  // Rebind synthetic records through their public verification hash, not a production migration.
  const record=structuredClone(records[0]);record.source.policyReceiptSha256=originalHash;record.verification.policyReceiptSha256=originalHash;
  const {verification,...claims}=record,{evidenceHash,...gates}=verification;record.verification.evidenceHash=semanticHash({...claims,verification:gates});
  const originalInventory={records:[{recordId:record.id,receipts:[{...inventory.records[0].receipts[0],receiptSha256:originalHash}]}]};
  await assert.rejects(recheckPublicationPolicy([record],originalInventory,cas,{stateDir,evaluationAt:new Date().toISOString()}),/expired|revalidation/);
  const withProof={records:[{...originalInventory.records[0],receipts:[{...originalInventory.records[0].receipts[0],currentReceiptSha256:admission.receiptSha256}]}]};
  const current=await recheckPublicationPolicy([record],withProof,cas,{stateDir,evaluationAt:new Date().toISOString()});
  assert.equal(current.policy.receipts[0].receiptSha256,originalHash);
  const originalBinding={snapshotSha256:'4'.repeat(64),receipts:current.policy.receipts};
  const replay=await recheckPublicationPolicy([record],withProof,cas,{stateDir,evaluationAt:new Date().toISOString(),originalPolicy:originalBinding});
  assert.deepEqual(replay.policy,originalBinding);
  assert.equal(replay.inventorySha256,current.inventorySha256);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('publication private receipt inventory never accepts a boolean approval substitute',()=>{
 assert.equal(publicationPolicyReceiptInventorySchema.safeParse({records:[{recordId:'synthetic',approved:true,receipts:[]}]}).success,false);
});

test('current optout blocks exact replay even with unchanged original receipt hashes',async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'stadtstack-revoked-publication-policy-'));
 try{
  const {cas,stateDir,policyOptions,records,inventory}=await fixture(directory);
  const original=await recheckPublicationPolicy(records,inventory,cas,{stateDir,evaluationAt:new Date().toISOString()});
  await recordHostOptOut({host:'example.org',reason:'rights_holder_objection'},policyOptions);
  await assert.rejects(recheckPublicationPolicy(records,inventory,cas,{stateDir,evaluationAt:new Date().toISOString(),originalPolicy:original.policy}),{code:'HOST_OPTED_OUT'});
 }finally{await rm(directory,{recursive:true,force:true});}
});
