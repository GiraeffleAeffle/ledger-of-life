import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest,semanticHash} from '../src/district-adapter-contract.ts';
import {StepReceiptSchema,unknownReceiptCounts} from '../src/district-step-receipt.ts';
import {canonicalJobIdentity} from '../src/district-jobs.ts';
import type {DistrictJobSpec} from '../src/district-jobs.ts';
import type {StepReceipt} from '../src/district-step-receipt.ts';
import {RepresentationDescriptorSchema} from '../src/district-r1.ts';
import {assertHistoricalStructuredExecution,authenticateStructuredExecutionEvidence} from '../src/r1-step8-structured-execution.ts';

// Every record below is synthetic test-only authority/receipt material.
function fixture(approved=true){
 const files=new Map<string,Buffer>(),cas=new Map<string,Buffer>(),descriptorHashes=new Set<string>();
 const native=new Map<string,{receipt_sha256:string;receipt:StepReceipt;spec:DistrictJobSpec;job_key:string;state:string;current_attempt:number}>();
 const store=(name:string,value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),pin={path:'/synthetic/'+name+'.json',sha256:digest(bytes)};files.set(pin.path,bytes);return pin;};
 const put=(value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),hash=digest(bytes);cas.set(hash,bytes);return hash;};
 const baseAuthority={path:'/synthetic/base.json',sha256:'a'.repeat(64)},oldPegelKey='b'.repeat(64),issuedAt='2020-01-01T00:00:10Z',expiresAt='2020-01-01T00:01:30Z',contract='f'.repeat(64);
 const selector={version:'district-r1-acquisition-v1',scope:{publisherId:'wsv',sourceId:'pegelonline',municipalityId:'hagenow',ags:'13076060',tenant:null,observationWindow:'inventory'},discovery:null,root:'https://example.org/synthetic-stations.json',request:{url:'https://example.org/synthetic-stations.json',method:'GET',body:null,contentType:null,publicOperation:null},permission:{kind:'facts_with_attribution'},maxRequests:8,maxBytes:1024,sourceVersion:null};
 const genesisSelector={...selector,scope:{...selector.scope,publisherId:'genesis',sourceId:'regionalstatistik-genesis',municipalityId:'strausberg',ags:'12064472'},root:'https://example.org/synthetic-genesis.json',request:{...selector.request,url:'https://example.org/synthetic-genesis.json'}};
 const acquisitionSpec=(value:typeof selector)=>canonicalJobIdentity({step:'acquire_representation',lane:'acquisition',semanticContractSha256:contract,inputArtifactHashes:[],sourceScope:value.scope,selector:value,policyProofSha256:null});
 const target=acquisitionSpec(selector).jobKey,genesisKey=acquisitionSpec(genesisSelector).jobKey;
 const acquisition=store('acquisition',{jobs:[selector]}),politeFetch={path:'/synthetic/polite-fetch.ts',sha256:'1'.repeat(64)},node={path:'/synthetic/node24.22.1',version:'v24.22.1',sha256:'2'.repeat(64)};
 const fixReview=store('fix-review',{verdict:'approved',reviewedBy:'Main',cve:'CVE-2026-111497',politeFetchSha256:politeFetch.sha256}),gateEvidence=store('gate-evidence',{passed:true,nodeVersion:'v24.22.1',politeFetchSha256:politeFetch.sha256,acquisitionContractSha256:contract});
 const securityRelease=store('security-release',{schemaVersion:'r1-step8-source-fetch-security-release-v1',issuedAt:'2020-01-01T00:00:07Z',sourceFetchStopLifted:true,approvedBy:'Main',cve:'CVE-2026-111497',node,politeFetch,fixReview,gateEvidence,acquisitionContractSha256:contract});
 const ownerDraft={schemaVersion:'stadtstack-r1-owner-approval-record-v1',id:'synthetic-owner',issuedAt:'',approved:false,approver:'Max (owner)',ownerStatementsVerbatim:[] as string[],baseAuthority,request:{action:'one-additional-exact-pegel-attempt-and-remaining-local-structured-parses',jobKey:oldPegelKey,acquisition,securityStop:{cve:'CVE-2026-111497',requiresIssuedPostStopRelease:true,requiresReviewedPoliteFetchFix:true,requiresNodeVersion:'v24.22.1',noLiveFetchUntilAllGatesPass:true},additionalAcquisitionAttempts:1,additionalPegelDataRequests:1,additionalHttpRequestCeiling:8,wholeOperationHttpCeilingIncludingHistory:20,wholeOperationAcquisitionAttemptCeilingIncludingHistory:3,wholeOperationJobCeilingIncludingHistory:8,maxRemainingLocalParseJobs:5,maxPegelParserPages:4,maxModelCalls:0,paidMicroUsd:0,wallBudgetExtension:true,expiresAt}};
 const ownerDecision=store('owner',{...ownerDraft,issuedAt:'2020-01-01T00:00:06Z',approved,ownerStatementsVerbatim:['SYNTHETIC TEST ONLY; not real owner approval']});
 const continuation=store('continuation',{schemaVersion:'r1-step8-structured-rest-continuation-v1',issuedAt,expiresAt,baseAuthority,ownerDecision,ownerDraftSha256:digest(JSON.stringify(ownerDraft,null,2)+'\n'),securityRelease,acquisitionSelector:selector,acquisitionContractSha256:contract,resolution:{action:'one-pegel-attempt-then-all-remaining-local-parses',mode:'new_contract_job',priorJobKey:oldPegelKey,acquisitionJobKey:target,pegelAttemptBefore:1,pegelAttemptAfter:1,additionalHttpRequestCeiling:8,wholeOperationHttpCeilingIncludingHistory:20,maxNewAcquisitionJobs:1,maxLocalParseJobs:5,maxPegelPages:4,maxNewJobs:6,maxWholeOperationJobs:8,maxModelCalls:0,paidMicroUsd:0}});
 const receipt=(identity:{jobKey:string;spec:DistrictJobSpec},prior=false)=>StepReceiptSchema.parse({version:'district-step-receipt-v1',canonicalizationVersion:'district-json-v1',id:randomUUID(),runId:randomUUID(),jobKey:identity.jobKey,step:identity.spec.step,lane:identity.spec.lane,sourceId:identity.spec.sourceScope.sourceId,municipalityId:identity.spec.sourceScope.municipalityId,attempt:1,leaseToken:'1',category:'production',dependencyReceiptIds:[],enqueuedAt:'2020-01-01T00:00:00Z',startedAt:prior?'2020-01-01T00:00:00Z':identity.spec.step==='structured_parse'?'2020-01-01T00:00:45Z':'2020-01-01T00:00:30Z',finishedAt:prior?'2020-01-01T00:00:05Z':identity.spec.step==='structured_parse'?'2020-01-01T00:00:55Z':'2020-01-01T00:00:40Z',queueWaitMs:0,elapsedMs:1,cpuUserMicros:null,cpuSystemMicros:null,outcome:'succeeded',reasonCode:'completed',inputHashes:identity.spec.inputArtifactHashes,outputHashes:[],policyProofSha256:identity.spec.policyProofSha256,originProofSha256:null,versions:identity.spec.step==='acquire_representation'?{acquisition:contract}:{},cache:{disposition:'not_applicable',originalGenerationReceiptId:null},provider:null,counts:{...unknownReceiptCounts}});
 function remember(identity:{jobKey:string;spec:DistrictJobSpec},value:StepReceipt){
  const hash=semanticHash(value);native.set(hash,{receipt_sha256:hash,receipt:structuredClone(value),spec:structuredClone(identity.spec),job_key:identity.jobKey,state:'succeeded',current_attempt:value.attempt});return value;
 }
 function acquired(value:typeof selector,prior=false){
  const identity=acquisitionSpec(value),result=receipt(identity,prior),sourceHash=put({syntheticSource:value.scope.sourceId}),policyHash=put({syntheticPolicy:value.scope.sourceId});
  const fetchedAt=prior?'2020-01-01T00:00:02Z':'2020-01-01T00:00:32Z',admittedAt=prior?'2020-01-01T00:00:03Z':'2020-01-01T00:00:35Z';
  const observation={url:value.request.url,method:'GET',checkedAt:fetchedAt,retrievedAt:fetchedAt,state:'fetched',status:200,sha256:sourceHash,bytes:cas.get(sourceHash)!.length,mimeType:'application/json'},observationHash=put(observation);
  const snapshot={sourceSha256:sourceHash,url:value.request.url,mimeType:'application/json',retrievedAt:fetchedAt,policyReceiptSha256:policyHash,sourceVersion:null,request:{method:'GET',body:null,contentType:null}};
  const descriptor=RepresentationDescriptorSchema.parse({version:'district-r1-representation-v1',scope:value.scope,root:value.root,snapshotId:randomUUID(),policyDecisionId:randomUUID(),receiptSha256:policyHash,sourceArtifact:{sha256:sourceHash,byteLength:cas.get(sourceHash)!.length,kind:'source_original',mimeType:'application/json',storageKey:'sha256/'+sourceHash.slice(0,2)+'/'+sourceHash},snapshot,httpObservation:{observationId:`1577836800000-${randomUUID()}.json`,receiptSha256:observationHash,bytes:cas.get(observationHash)!.toString('utf8')},fetchedAt,admittedAt,redirectChain:[]});
  const descriptorHash=put(descriptor);descriptorHashes.add(descriptorHash);result.outputHashes=[sourceHash,policyHash,observationHash,descriptorHash];
  return {receipt:remember(identity,result),descriptor};
 }
 const genesis=acquired(genesisSelector,true),pegel=acquired(selector),prior=genesis.receipt;
 const priorPin=store('prior-genesis',{issuedAt:'2019-12-31T23:58:00Z',expiresAt:'2020-01-01T00:00:09Z',baseAuthority,resolution:{action:'fresh-authority-for-unattempted-genesis-only',jobKeys:[genesisKey]}});
 function parsed(value:typeof genesis){
  const {snapshot,scope,httpObservation}=value.descriptor,binding={kind:'http_observation',url:snapshot.url,sourceSha256:snapshot.sourceSha256,observationId:httpObservation.observationId,receiptSha256:httpObservation.receiptSha256};
  const worker={version:'district-structured-worker-v1',operation:'parse',adapter:scope.sourceId==='pegelonline'?'gauges':'genesis',options:{},scope,cursor:null,snapshot,inputArtifactSha256:snapshot.sourceSha256,auxiliary:[]};
  const identity=canonicalJobIdentity({step:'structured_parse',lane:'structured',semanticContractSha256:contract,inputArtifactHashes:[digest('synthetic registry'),snapshot.sourceSha256,snapshot.policyReceiptSha256,httpObservation.receiptSha256],sourceScope:scope,selector:{worker,registrySha256:digest('synthetic registry'),supportingSources:[],sourceBindings:[binding]},policyProofSha256:snapshot.policyReceiptSha256});
  return remember(identity,receipt(identity));
 }
 const actual=[pegel.receipt,parsed(genesis),parsed(pegel)];
 const steps=actual.map((receipt,index)=>({sha256:semanticHash(receipt),receipt,stageAuthority:store('stage-'+index,{schemaVersion:'stadtstack-r1-stage-authorization-record-v1',issuedAt:'2020-01-01T00:00:20Z',expiresAt,parentContinuation:continuation,stage:{step:receipt.step,jobKeys:[receipt.jobKey],ags:[receipt.sourceId==='pegelonline'?'13076060':'12064472'],maxJobs:1,maxElapsedMs:540000,category:'production',mode:'bounded_unattended'}})}));
 const evidence={schemaVersion:'r1-step8-structured-execution-evidence-v1',continuation,ownerDecision,baseAuthority,securityRelease,nodeVersion:'v24.22.1',nodePath:node.path,startedAt:'2020-01-01T00:00:15Z',finishedAt:'2020-01-01T00:01:00Z',priorGenesis:{continuation:priorPin,sha256:semanticHash(prior),receipt:prior},steps,stageAuthorities:steps.map(row=>row.stageAuthority),wholeOperationHttpCeilingIncludingHistory:20,newAcquisitionAttempts:1,newParseJobs:2};
 const receipts=steps.filter(row=>row.receipt.step==='structured_parse').map(({sha256,receipt})=>({sha256,runId:receipt.runId,step:receipt.step,municipalityId:receipt.municipalityId,sourceId:receipt.sourceId}));
 const custody={
  async query(sql:string,values?:unknown[]){
   if(sql==='SHOW transaction_read_only')return {rows:[{transaction_read_only:'on'}]};
   if(sql.includes('JOIN district_pipeline.jobs')){
    const [hash,id,runId,jobKey]=values as string[],row=native.get(hash);
    return {rows:row&&row.receipt.id===id&&row.receipt.runId===runId&&row.job_key===jobKey?[row]:[]};
   }
   assert.ok(sql.includes('district_pipeline.artifacts'),'Unexpected fixture custody query');
   return {rows:(values![0] as string[]).filter(hash=>descriptorHashes.has(hash)).map(sha256=>({sha256}))};
  },
  async readCas(hash:string){const value=cas.get(hash);assert.ok(value,'Missing synthetic CAS object');return value;},
 };
 return {evidence,store,native,cas,descriptorHashes,options:{evidence:store('evidence',evidence),baseAuthority,selectionIssuedAt:'2020-01-01T00:02:00Z',receipts,custody,readControl:async(pin:{path:string;sha256:string})=>{const value=files.get(pin.path);assert.ok(value);return value;}}};
}
test('completed execution inside a past authority window remains historical evidence',()=>{assertHistoricalStructuredExecution({issuedAt:'2020-01-01T00:00:00Z',expiresAt:'2020-01-01T01:00:00Z'},'2020-01-01T00:01:00Z','2020-01-01T00:02:00Z');});
test('execution after deadline or before genuine issuance is rejected',()=>{assert.throws(()=>assertHistoricalStructuredExecution({issuedAt:'2020-01-01T00:00:00Z',expiresAt:'2020-01-01T01:00:00Z'},'2020-01-01T00:01:00Z','2020-01-01T01:00:01Z'));assert.throws(()=>assertHistoricalStructuredExecution({issuedAt:'2020-01-01T00:01:00Z',expiresAt:'2020-01-01T01:00:00Z'},'2020-01-01T00:00:00Z','2020-01-01T00:02:00Z'));});
test('historical owner/continuation/stage chain binds exact selected parser receipts',async()=>{const f=fixture();const actual=await authenticateStructuredExecutionEvidence(f.options);assert.equal(actual.newParseJobs,2);assert.equal(actual.newAcquisitionAttempts,1);});
test('unapproved owner, changed receipt set and completion after deadline fail closed',async()=>{await assert.rejects(authenticateStructuredExecutionEvidence(fixture(false).options));const f=fixture();await assert.rejects(authenticateStructuredExecutionEvidence({...f.options,receipts:f.options.receipts.slice(1)}),/selected parser receipts/);const late={...f.evidence,finishedAt:'2020-01-01T02:00:00Z'};await assert.rejects(authenticateStructuredExecutionEvidence({...f.options,evidence:f.store('late',late)}),/execution window/);});
test('missing security release or vulnerable runtime cannot become execution evidence',async()=>{const f=fixture();await assert.rejects(authenticateStructuredExecutionEvidence({...f.options,evidence:f.store('old-runtime',{...f.evidence,nodeVersion:'v24.21.0'})}));await assert.rejects(authenticateStructuredExecutionEvidence({...f.options,evidence:f.store('missing-release',{...f.evidence,securityRelease:undefined})}));});
test('copied PEGEL receipt cannot claim a new contract/time with recomputed evidence hashes',async()=>{
 const f=fixture(),forged=structuredClone(f.evidence),entry=forged.steps[0];
 // Native custody retains only an old contract/job/clock. Copying it and
 // relabelling all three in the self-hashed evidence must not create custody.
 const row=f.native.get(entry.sha256)!,oldIdentity=canonicalJobIdentity({...row.spec,semanticContractSha256:'0'.repeat(64)}),oldReceipt={...row.receipt,jobKey:oldIdentity.jobKey,versions:{acquisition:oldIdentity.spec.semanticContractSha256},startedAt:'2019-12-31T23:00:00Z',finishedAt:'2019-12-31T23:00:10Z'},oldHash=semanticHash(oldReceipt);
 f.native.delete(entry.sha256);f.native.set(oldHash,{...row,receipt_sha256:oldHash,receipt:oldReceipt,spec:oldIdentity.spec,job_key:oldIdentity.jobKey});
 entry.receipt.startedAt='2020-01-01T00:00:31Z';entry.receipt.finishedAt='2020-01-01T00:00:41Z';entry.sha256=semanticHash(entry.receipt);
 await assert.rejects(authenticateStructuredExecutionEvidence({...f.options,evidence:f.store('forged-pegel',forged)}),/canonical committed DB receipt/);
});
test('copied prior GENESIS acquisition cannot invent a new historical completion',async()=>{
 const f=fixture(),forged=structuredClone(f.evidence);
 forged.priorGenesis.receipt.finishedAt='2020-01-01T00:00:04Z';forged.priorGenesis.sha256=semanticHash(forged.priorGenesis.receipt);
 await assert.rejects(authenticateStructuredExecutionEvidence({...f.options,evidence:f.store('forged-genesis',forged)}),/canonical committed DB receipt/);
});
test('native acquisition job contract and complete receipt must agree with canonical identity',async()=>{
 const f=fixture(),entry=f.evidence.steps[0],row=f.native.get(entry.sha256)!;
 row.spec.semanticContractSha256='3'.repeat(64);
 await assert.rejects(authenticateStructuredExecutionEvidence(f.options),/canonical DB custody/);
});
test('canonical parser receipt cannot select a different source than its acquired original',async()=>{
 const f=fixture(),entry=f.evidence.steps[2],row=f.native.get(entry.sha256)!;
 const selector=structuredClone(row.spec.selector) as {worker:{snapshot:{sourceSha256:string};inputArtifactSha256:string}};
 selector.worker.snapshot.sourceSha256='4'.repeat(64);selector.worker.inputArtifactSha256='4'.repeat(64);
 const identity=canonicalJobIdentity({...row.spec,selector}),changed={...entry.receipt,jobKey:identity.jobKey},changedHash=semanticHash(changed);
 const stage=JSON.parse((await f.options.readControl(entry.stageAuthority)).toString('utf8'));stage.stage.jobKeys=[identity.jobKey];
 entry.receipt=changed;entry.sha256=changedHash;entry.stageAuthority=f.store('changed-parser-stage',stage);f.evidence.stageAuthorities=f.evidence.steps.map(item=>item.stageAuthority);
 f.native.delete(row.receipt_sha256);f.native.set(changedHash,{...row,spec:identity.spec,job_key:identity.jobKey,receipt_sha256:changedHash,receipt:changed});
 const receipts=f.evidence.steps.filter(item=>item.receipt.step==='structured_parse').map(({sha256,receipt})=>({sha256,runId:receipt.runId,step:receipt.step,municipalityId:receipt.municipalityId,sourceId:receipt.sourceId}));
 await assert.rejects(authenticateStructuredExecutionEvidence({...f.options,evidence:f.store('changed-parser-input',f.evidence),receipts}),/input differs from authenticated acquisition/);
});
test('execution custody refuses a writable DB transaction and tampered descriptor bytes',async()=>{
 const f=fixture();
 await assert.rejects(authenticateStructuredExecutionEvidence({...f.options,custody:{...f.options.custody,query:async()=>({rows:[{transaction_read_only:'off'}]})}}));
 const descriptor=[...f.descriptorHashes][0];f.cas.set(descriptor,Buffer.from('SYNTHETIC CORRUPTION'));
 await assert.rejects(authenticateStructuredExecutionEvidence(f.options),/descriptor CAS digest mismatch/);
});
