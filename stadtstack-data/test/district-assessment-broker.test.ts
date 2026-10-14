import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {assessmentItemSchema,assessmentProviderInput,validateReceipt,type OriginalEvidence,type AssessmentOutput} from '../src/district-assessment.ts';
import {assessmentBridgeReceipt,AssessmentBSelectorSchema,assessmentEvidenceArtifactHashes} from '../src/district-assessment-broker.ts';
import {ASSESSMENT_BRIDGE_VERSION,BridgeAnswerSchema,BridgeRequestSchema,BridgeLeaseSchema,bridgeInputHash} from '../src/district-assessment-bridge-contract.ts';
import {canonicalJson,digest} from '../src/district-adapter-contract.ts';

// Synthetic immutable source and actual-format CLI events only. No providers,
// network, databases, source collection, sandbox process or credentials involved.
const text='Plan 2025: 100 EUR. Beschluss am 28.02.2025.';
const hash='a'.repeat(64),rubric='Frozen synthetic rubric: 0–2, abstention usefulness zero.';
const item=assessmentItemSchema.parse({version:'assessment-item-v1',itemId:'bridge-fixture',question:'Was this a payment?',claim:'100 EUR planned',rubric,rubricSha256:digest(rubric),sources:[{sourceId:'source1',originalSha256:digest(text),textSha256:digest(text),parserVersion:'synthetic-parser-v1',parserReceiptSha256:hash,admissionReceiptSha256:'b'.repeat(64),ocrSuspected:false,locators:[{id:'page1',page:1,table:null,start:0,end:text.length}]}],claimIds:['claim1'],entityIds:['town','project'],constraints:[],criticalKinds:['finance']});
const evidence:OriginalEvidence=[{sourceId:'source1',admittedSourceId:'source1',url:'https://example.org/synthetic.txt',originalSha256:digest(text),textSha256:digest(text),parserVersion:'synthetic-parser-v1',parserReceiptSha256:hash,admissionReceiptSha256:'b'.repeat(64),ocrSuspected:false,text,locators:[{id:'page1',page:1,table:null,start:0,end:text.length,quote:text}]}];
const output:AssessmentOutput={itemId:item.itemId,outcome:'supported',assertions:[{claimId:'claim1',sourceId:'source1',locatorId:'page1',quote:text,subjectId:'town',objectId:'project',unit:'EUR',value:'100',date:'2025-02-28',dateRole:'approval',financialRole:'plan',stage:'adopted',modality:'confirmed'}],scores:{correctness:2,sources:2,usefulness:1},holdReasons:[],rationale:'Synthetic fixture, never civic evidence.',valueReview:null};
const identity={provider:'anthropic-subscription' as const,tool:'claude-cli' as const,toolVersion:'0.0.0-synthetic-test-only',model:'claude-haiku-5-5' as const,modelIdentityBasis:'reported-cli-model-and-tool-version' as const};
const modelEvidence={...identity,modelIdentitySha256:createHash('sha256').update(JSON.stringify(identity)).digest('hex')};
const clocks={startedAt:'2026-10-11T00:00:01.000Z',finishedAt:'2026-10-11T00:00:02.000Z'};
const window={claimedAt:'2026-10-11T00:00:00.000Z',deadlineAt:'2026-10-11T00:02:00.000Z',receivedAt:'2026-10-11T00:00:03.000Z'};
function providerStream(value:unknown=output,options:{model?:string;tools?:string[];success?:boolean;duplicate?:boolean}={}){
 const model=options.model??identity.model;
 const init=JSON.stringify({type:'system',subtype:'init',tools:options.tools??[],mcp_servers:[],model});
 const message=JSON.stringify({type:'assistant',message:{id:'msg_synthetic',model,content:[]}});
 const result=JSON.stringify({type:'result',subtype:options.success===false?'error':'success',is_error:options.success===false,model,request_id:'req_synthetic',structured_output:value,usage:{input_tokens:29,output_tokens:14,cache_read_input_tokens:3},total_cost_usd:0.005,modelUsage:{[model]:{inputTokens:29,outputTokens:14,costUSD:0.005}}});
 return {stdout:[init,message,result,...(options.duplicate?[result]:[])].join('\n')+'\n',result};
}

test('VM constructs B receipt from actual pinned event bytes and original clocks',()=>{
 const stream=providerStream(),data=assessmentProviderInput(item,evidence);
 const recorded=assessmentBridgeReceipt(item,evidence,data,{stdout:stream.stdout,evidence:modelEvidence,...clocks},window);
 assert.equal(recorded.receipt.provider,'anthropic-subscription');assert.equal(recorded.receipt.role,'B');
 assert.equal(recorded.receipt.requestedModel,'claude-haiku-5-5');assert.equal(recorded.receipt.returnedModel,'claude-haiku-5-5');
 assert.equal(recorded.receipt.responseSha256,digest(stream.result));
 assert.equal(recorded.receipt.startedAt,clocks.startedAt);assert.equal(recorded.receipt.finishedAt,clocks.finishedAt);
 assert.equal(recorded.receipt.estimatedApiUsd,0.005);assert.equal(recorded.receipt.actualBilledUsd,null);
 assert.deepEqual(recorded.receipt.dependencies,[]);assert.deepEqual(recorded.receipt.deterministicIssues,[]);
 assert.equal(recorded.providerRequestId,'req_synthetic');assert.equal(recorded.providerResponseId,'msg_synthetic');
 assert.deepEqual(validateReceipt(recorded.receipt,item,'B'),recorded.receipt);
});

test('bare assessment, wrong provider/model, tool attempts and malformed events cannot become receipts',()=>{
 const data=assessmentProviderInput(item,evidence),answer={stdout:providerStream().stdout,evidence:modelEvidence,...clocks};
 assert.throws(()=>assessmentBridgeReceipt(item,evidence,data,output,window));
 for(const options of [{model:'claude-sonnet-latest'},{tools:['Bash']},{success:false},{duplicate:true}])assert.throws(()=>assessmentBridgeReceipt(item,evidence,data,{...answer,stdout:providerStream(output,options).stdout},window));
 assert.throws(()=>assessmentBridgeReceipt(item,evidence,data,{...answer,evidence:{...modelEvidence,provider:'openai-subscription'}},window));
 assert.throws(()=>assessmentBridgeReceipt(item,evidence,data,{...answer,evidence:{...modelEvidence,modelIdentitySha256:'c'.repeat(64)}},window));
 assert.throws(()=>assessmentBridgeReceipt(item,evidence,data,{...answer,stdout:'not-json\n'},window));
 assert.throws(()=>assessmentBridgeReceipt(item,evidence,data,{...answer,stdout:providerStream({itemId:item.itemId}).stdout},window));
});

test('receipt requires exact frozen request, original evidence and claimed lease clocks',()=>{
 const data=assessmentProviderInput(item,evidence),answer={stdout:providerStream().stdout,evidence:modelEvidence,...clocks};
 assert.throws(()=>assessmentBridgeReceipt(item,evidence,{...data,assessments:{A:'must remain blind'}},answer,window));
 assert.throws(()=>assessmentBridgeReceipt(item,[{...evidence[0],text:'altered source'}],data,answer,window));
 for(const altered of [{startedAt:'2026-10-10T23:59:59.000Z'},{finishedAt:'2026-10-11T00:03:00.000Z'},{finishedAt:'2026-10-11T00:00:00.000Z'}])assert.throws(()=>assessmentBridgeReceipt(item,evidence,data,{...answer,...altered},window));
 assert.throws(()=>assessmentBridgeReceipt(item,evidence,data,answer,{...window,receivedAt:'2026-10-11T00:00:01.500Z'}));
});

test('a completed provider response cannot overrule deterministic quotation or calendar contradictions',()=>{
 const contradicted={...output,assertions:[{...output.assertions[0],quote:'invented quotation',date:'2025-02-30'}]};
 const recorded=assessmentBridgeReceipt(item,evidence,assessmentProviderInput(item,evidence),{stdout:providerStream(contradicted).stdout,evidence:modelEvidence,...clocks},window);
 assert.ok(recorded.receipt.deterministicIssues.length>0);
 assert.equal(recorded.receipt.output.assertions[0].date,'2025-02-30','retain actual rejected assertion, never silently correct it');
});

test('strict bridge requests bind exact input, pinned B route and actual purge acknowledgement',()=>{
 const binding={jobKey:hash,authorityId:randomUUID(),authoritySha256:'b'.repeat(64),policySnapshotSha256:'c'.repeat(64),role:'B' as const,provider:'anthropic-subscription' as const,requestedModel:'claude-haiku-5-5' as const,system:'fixed synthetic system',data:{evidence:text},outputSchema:{type:'object'},clientContractSha256:'d'.repeat(64)};
 const lease={version:ASSESSMENT_BRIDGE_VERSION,leaseId:randomUUID(),...binding,inputSha256:bridgeInputHash(binding),expiresAt:window.deadlineAt};
 assert.deepEqual(BridgeLeaseSchema.parse(lease),lease);
 assert.throws(()=>BridgeLeaseSchema.parse({...lease,data:{evidence:'different'}}));
 assert.throws(()=>BridgeLeaseSchema.parse({...lease,role:'A'}));
 assert.throws(()=>BridgeLeaseSchema.parse({...lease,requestedModel:'latest'}));
 const request={operation:'submit',leaseId:lease.leaseId,inputSha256:lease.inputSha256,purgeAck:{sourceFiles:0,responseFiles:0,modelFileWritesDenied:true,completedAt:window.receivedAt},answer:{stdout:providerStream().stdout,evidence:modelEvidence,...clocks}};
 assert.equal(BridgeRequestSchema.parse(request).operation,'submit');
 for(const purgeAck of [{...request.purgeAck,sourceFiles:1},{...request.purgeAck,responseFiles:1},{...request.purgeAck,modelFileWritesDenied:false}])assert.throws(()=>BridgeRequestSchema.parse({...request,purgeAck}));
 assert.throws(()=>BridgeRequestSchema.parse({...request,purgeAck:undefined}));
 assert.throws(()=>BridgeRequestSchema.parse({...request,sourceAuthority:{allowed:true}}));
 assert.throws(()=>BridgeAnswerSchema.parse({...request.answer,stdout:'é'.repeat(60*1024)}));
 const mac=AssessmentBSelectorSchema.parse({version:ASSESSMENT_BRIDGE_VERSION,transport:'mac-bridge',role:'B',provider:'anthropic-subscription',requestedModel:'claude-haiku-5-5',itemArtifactSha256:hash,clientContractSha256:hash});
 const vm=AssessmentBSelectorSchema.parse({version:ASSESSMENT_BRIDGE_VERSION,transport:'vm-omp',role:'B',provider:'anthropic-subscription',requestedModel:'claude-haiku-5-5',itemArtifactSha256:hash,runnerOutputContractSha256:'c'.repeat(64)});
 assert.equal(mac.transport,'mac-bridge');assert.equal(vm.transport,'vm-omp');assert.equal('clientContractSha256' in vm,false);
 assert.throws(()=>AssessmentBSelectorSchema.parse({version:ASSESSMENT_BRIDGE_VERSION,transport:'vm-omp',role:'B',provider:'anthropic-subscription',requestedModel:'claude-haiku-5-5',itemArtifactSha256:hash,runnerOutputContractSha256:'c'.repeat(64),clientContractSha256:hash}));
 assert.deepEqual(assessmentEvidenceArtifactHashes(item),[digest(text),hash,'b'.repeat(64)].sort());
 assert.equal(canonicalJson(request).includes('DATABASE_URL'),false);
});
