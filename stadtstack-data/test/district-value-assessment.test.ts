import test from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {candidateTransport,parseCandidateCollection,assessedValueReview,canonical,valueAssessmentTarget} from '../src/evaluate-pilot-value.ts';
import {buildValueAssessmentItem,ValueAssessmentEnqueueSchema} from '../src/district-assessment-jobs.ts';
import {assertValueAssessmentContext,valueAnswerUnit,valueWindows,boundedValueSource,assertValueSourceContext} from '../src/district-value-context.ts';
import {assertResidualAssessmentContext,originalEvidence,buildAssessmentPassInput,deterministicChecks,assessmentOutputSchema} from '../src/district-assessment.ts';
import {AssessmentContextHold,ASSESSMENT_CONTEXT_BYTES,ASSESSMENT_RECONCILIATION_BYTES} from '../src/district-assessment-context.ts';
import {syntheticAssessmentTriplet,syntheticAssessmentReceipt} from './district-assessment.fixture.ts';
import {valueAssessmentFixture,valueOutput,rebindValueFixtureRows} from './district-value-assessment.fixture.ts';
import {canonicalJson,digest as bytesHash} from '../src/district-adapter-contract.ts';
import {encodeStepReceipt,StepReceiptSchema} from '../src/district-step-receipt.ts';
import {digest as valueDigest} from '../src/evaluate-pilot-value.ts';

test('candidate stdio pins explicit data directory, release and policy without inheriting credentials',()=>{
 const transport=candidateTransport('/synthetic/code',{directory:'/synthetic/candidate',releaseId:'a'.repeat(64),policyStateDir:'/synthetic/policy'});
 assert.equal(transport.cwd,'/synthetic/code');assert.equal(transport.args[1],'/synthetic/code/src/mcp-candidate.ts');
 assert.equal(transport.env.STADTSTACK_CANDIDATE_DIRECTORY,'/synthetic/candidate');
 assert.equal(transport.env.STADTSTACK_CANDIDATE_RELEASE_ID,'a'.repeat(64));
 assert.equal(transport.env.STADTSTACK_CANDIDATE_POLICY_STATE_DIR,'/synthetic/policy');
 assert.deepEqual(Object.keys(transport.env).sort(),['NODE_NO_WARNINGS','PATH','STADTSTACK_CANDIDATE_DIRECTORY','STADTSTACK_CANDIDATE_POLICY_STATE_DIR','STADTSTACK_CANDIDATE_RELEASE_ID']);
 assert.throws(()=>candidateTransport('/synthetic/code',{directory:'/synthetic/candidate',releaseId:'mutable-latest',policyStateDir:'/synthetic/policy'}));
});
test('candidate input authenticates all 30 evidence rows and current graph inventory before queue import',async t=>{
 const f=await valueAssessmentFixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
 assert.equal(parseCandidateCollection(f.report).evaluations.length,30);
 for(const mutate of [
  (report:typeof f.report)=>{report.server.releaseId='e'.repeat(64);},
  (report:typeof f.report)=>{report.server.mode='sealed';},
  (report:typeof f.report)=>{report.server.tools[0]='invented';},
  (report:typeof f.report)=>{report.calls[0].response={invented:true};},
  (report:typeof f.report)=>{report.records['record:fixture'].statement='Changed evidence';},
 ]){const changed=structuredClone(f.report);mutate(changed);assert.throws(()=>parseCandidateCollection(changed));}
 assert.equal(ValueAssessmentEnqueueSchema.parse({reportPath:'/synthetic/report',sourceBindings:[f.source],custodyReceiptSha256:f.policyArtifact.sha256}).maxModelCalls,2);
 assert.throws(()=>ValueAssessmentEnqueueSchema.parse({reportPath:'/synthetic/report',sourceBindings:[],custodyReceiptSha256:f.policyArtifact.sha256,maxModelCalls:49}));
});
test('value contexts are a distinct strict bounded lane, with genuine three-pass fixture ingest',async t=>{
 const f=await valueAssessmentFixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const item=await buildValueAssessmentItem(f.report,'W01','withoutGraph',[f.source],f.policyArtifact.sha256,f.context);
 assertValueAssessmentContext(item);assert.throws(()=>assertResidualAssessmentContext(item),AssessmentContextHold);
 const evidence=await originalEvidence(item,f.context);assert.equal(evidence[0].text,null);
 const selected=evidence[0].selectedContext!;assert.equal(selected.spans.length,1);
 assert.equal(selected.spans[0].text,f.text.slice(4001-256,4001+f.quote.length+256));
 assert.equal(canonical(selected).includes(f.text),false);
 const A=buildAssessmentPassInput(item,evidence,'A'),B=buildAssessmentPassInput(item,evidence,'B');
 assert.equal(canonical(A.data),canonical(B.data));assert.equal(A.assessments,null);assert.equal(B.assessments,null);
 assert.ok(Buffer.byteLength(canonical(A.data))<=ASSESSMENT_CONTEXT_BYTES);
 const output=assessmentOutputSchema.parse(valueOutput(item,f.quote)),receipts=await syntheticAssessmentTriplet(item,output,f.context);
 const C=buildAssessmentPassInput(item,evidence,'C',receipts);assert.ok(Buffer.byteLength(canonical(C.data))<=ASSESSMENT_RECONCILIATION_BYTES);
 assert.equal(C.assessments?.A.receiptSha256,receipts.A.receiptSha256);assert.equal(C.assessments?.B.receiptSha256,receipts.B.receiptSha256);
 const assessed=await assessedValueReview(f.report,item,receipts,f.context);assert.equal(assessed.review.answer,output.valueReview?.answer);
 assert.equal(assessed.binding.receiptHashes.length,3);
 const noAssertion={...output,assertions:[]};assert.ok(deterministicChecks(item,evidence,noAssertion).includes('value_unassessed_citation'));
 for(const mutate of [
  (value:typeof item)=>{delete value.valueContext;},
  (value:typeof item)=>{value.valueContext!.targetSha256='f'.repeat(64);},
  (value:typeof item)=>{value.valueTarget!.releaseId='e'.repeat(64);},
 ]){const changed=structuredClone(item);mutate(changed);assert.throws(()=>assertValueAssessmentContext(changed));}
 const changed=structuredClone(item);changed.sources[0].contextSelection!.spans[0].start++;
 await assert.rejects(originalEvidence(changed,f.context),AssessmentContextHold);
 const changedEvidence=structuredClone(f.report);changedEvidence.records['record:fixture'].statement='Different publication';
 await assert.rejects(assessedValueReview(changedEvidence,item,receipts,f.context));
});
test('empty original evidence yields an honest assessed abstention, never a forced fact',async t=>{
 const f=await valueAssessmentFixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const item=await buildValueAssessmentItem(f.report,'W03','withGraph',[f.source],f.policyArtifact.sha256,f.context);
 assert.equal(item.sources.length,0);assert.equal(item.valueContext?.custodyReceiptSha256,f.policyArtifact.sha256);
 assert.equal((await originalEvidence(item,f.context)).length,0);
 const receipts=await syntheticAssessmentTriplet(item,valueOutput(item),f.context);
 const result=await assessedValueReview(f.report,item,receipts,f.context);assert.equal(result.review.kind,'abstention');assert.equal(result.review.usefulness.score,0);
 const same=await buildValueAssessmentItem(f.report,'W03','withoutGraph',[f.source],f.policyArtifact.sha256,f.context);
 assert.notEqual(item.valueContext?.answerUnitSha256,same.valueContext?.answerUnitSha256);
 const revised={...item.valueTarget!,evidenceSha256:'f'.repeat(64)};
 assert.equal(valueAnswerUnit(revised),item.valueContext?.answerUnitSha256,'per-answer cap cannot reset by changing retrieval evidence');
});
test('value byte ceilings hold rather than trimming originals or C receipts',async t=>{
 const f=await valueAssessmentFixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const item=await buildValueAssessmentItem(f.report,'W01','withoutGraph',[f.source],f.policyArtifact.sha256,f.context);
 const evidence=await originalEvidence(item,f.context),input=buildAssessmentPassInput(item,evidence,'A');
 const output=assessmentOutputSchema.parse({...valueOutput(item,f.quote),rationale:'x'.repeat(22000)});
 const A=syntheticAssessmentReceipt(item,'A',output,input.data),B=syntheticAssessmentReceipt(item,'B',output,input.data);
 assert.throws(()=>buildAssessmentPassInput(item,evidence,'C',{A,B}),{reasonCode:'assessment_context_exceeded'});
 const huge=structuredClone(f.report);huge.method.grading='x'.repeat(22000);
 await assert.rejects(buildValueAssessmentItem(huge,'W01','withoutGraph',[f.source],f.policyArtifact.sha256,f.context),{reasonCode:'assessment_context_exceeded'});
 const text='a'.repeat(300)+'😀'+'b'.repeat(300);assert.deepEqual(valueWindows(text,[{start:557,end:558}]),[{start:302,end:text.length}]);
 assert.throws(()=>valueWindows(text,[{start:301,end:302}]),AssessmentContextHold);
});
test('native value contexts authenticate exact parser locators without sending whole parser JSON',async t=>{
 const f=await valueAssessmentFixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const locator={sourceSha256:f.source.originalSha256,format:'csv' as const,nativeId:'fixture-1',path:'rows/1/amount',
  sheet:null,rowKey:'fixture-1',cells:['amount'],rawValue:'10',schemaHash:'b'.repeat(64),mappingVersion:'synthetic-fixture-v1'};
 const text=canonicalJson({evidence:[locator],unrelated:'x'.repeat(40000)});
 const parsed=await f.context.cas.put(Buffer.from(text),{kind:'parser_output',mimeType:'application/json'});
 const previous=StepReceiptSchema.parse(JSON.parse((await f.context.cas.read(f.parserArtifact.sha256)).toString('utf8')));
 const receipt=encodeStepReceipt({...previous,outputHashes:[parsed.sha256]});
 const parser=await f.context.cas.put(Buffer.from(receipt.bytes),{kind:'receipt',mimeType:'application/json'});
 const source={...f.source,textSha256:bytesHash(text),parserReceiptSha256:parser.sha256,locators:[],nativeLocators:[locator]};
 const report=structuredClone(f.report),record={id:'record:fixture',sourceIds:['source:fixture'],evidence:[locator]};
 report.records[record.id]=record;report.calls[0].response=record;report.calls[0].responseSha256=valueDigest(record);
 report.sources['source:fixture'].locators=[locator];
 report.calls[1].response=report.sources['source:fixture'];report.calls[1].responseSha256=valueDigest(report.sources['source:fixture']);
 const row=report.evaluations[0];row.evidenceSha256=valueDigest({question:row.question,records:[record],sources:[report.sources['source:fixture']],
  retrievalComplete:true,graph:row.graph,graphResponses:[]});
 const item=await buildValueAssessmentItem(report,'W01','withoutGraph',[source],f.policyArtifact.sha256,f.context);
 const evidence=await originalEvidence(item,f.context),input=buildAssessmentPassInput(item,evidence,'A');
 assert.equal(evidence[0].text,null);assert.deepEqual(evidence[0].nativeLocators,[locator]);
 assert.ok(Buffer.byteLength(canonical(input.data))<ASSESSMENT_CONTEXT_BYTES);assert.equal(canonical(input.data).includes(text),false);
 const output=assessmentOutputSchema.parse({...valueOutput(item,f.quote),assertions:[{claimId:item.claimIds[0],sourceId:'source:fixture',
  nativeEvidence:locator,subjectId:null,objectId:null,unit:'EUR',value:'10',date:null,dateRole:null,financialRole:'plan',stage:'planned',modality:'planned'}],
  valueReview:{...valueOutput(item,f.quote).valueReview,citations:[{kind:'structured',recordId:'record:fixture',sourceId:'source:fixture',url:f.policy.source.url,evidence:locator}]}});
 assert.deepEqual(deterministicChecks(item,evidence,output),[]);
 const receipts=await syntheticAssessmentTriplet(item,output,f.context);assert.equal((await assessedValueReview(report,item,receipts,f.context)).review.citations.length,1);
 const altered=structuredClone(item);altered.sources[0].nativeLocators![0].rawValue='100';
 await assert.rejects(originalEvidence(altered,f.context),AssessmentContextHold);
});
test('value text context is clipped to the immutable MCP prepared-text interval, not an operator-expanded document window',async t=>{
 const f=await valueAssessmentFixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const end=4002+f.quote.length,attribution={locator:`text-sha256:${f.source.textSha256};chars:4000-${end}`};
 const source=boundedValueSource(f.source,f.text,attribution);
 assert.deepEqual(source.contextSelection?.spans,[{start:4000,end}]);assertValueSourceContext(source,f.text,attribution);
 assert.throws(()=>boundedValueSource({...f.source,locators:[{id:'uncited',page:null,table:null,start:0,end:1}]},f.text,attribution),AssessmentContextHold);
 assert.throws(()=>boundedValueSource(f.source,f.text,{locator:`text-sha256:${'e'.repeat(64)};chars:0-${f.text.length}`}),AssessmentContextHold);
 const enlarged=structuredClone(source);enlarged.contextSelection!.spans[0].start--;
 assert.throws(()=>assertValueSourceContext(enlarged,f.text,attribution),AssessmentContextHold);
});
test('recomputed row hashes cannot widen served attribution or forge search/graph membership',async t=>{
 const f=await valueAssessmentFixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const forged=structuredClone(f.report);
 forged.sources['source:fixture'].locator=`text-sha256:${f.source.textSha256};chars:0-${f.text.length}`;
 rebindValueFixtureRows(forged);
 assert.throws(()=>parseCandidateCollection(forged));
 assert.throws(()=>valueAssessmentTarget(forged,forged.evaluations[0],'withoutGraph'));
 await assert.rejects(buildValueAssessmentItem(forged,'W01','withoutGraph',[f.source],f.policyArtifact.sha256,f.context));
 const item=await buildValueAssessmentItem(f.report,'W01','withoutGraph',[f.source],f.policyArtifact.sha256,f.context);
 const changed=structuredClone(item);changed.valueTarget!.sources=forged.sources;
 changed.valueContext!.targetSha256=valueDigest(changed.valueTarget);
 await assert.rejects(originalEvidence(changed,f.context));
 for(const mutate of [
  (report:typeof f.report)=>{report.calls.push({...structuredClone(report.calls[1]),id:report.calls.length});},
  (report:typeof f.report)=>{report.calls[0].tool='list_cities';},
  (report:typeof f.report)=>{report.evaluations[1].recordIds=['record:fixture'];},
  (report:typeof f.report)=>{report.evaluations.find(row=>row.question.id==='W03')!.graph.recordIds=['record:fixture'];},
  (report:typeof f.report)=>{report.evaluations[0].callIds.pop();},
 ]){
  const report=structuredClone(f.report);mutate(report);rebindValueFixtureRows(report);
  assert.throws(()=>parseCandidateCollection(report));
 }
});
test('served graph witnesses establish only the graph lane and require exact neighbor/path calls',async t=>{
 const f=await valueAssessmentFixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const report=structuredClone(f.report),row=report.evaluations.find(value=>value.question.id==='W03')!;
 const entity=report.calls[row.graph.callIds[0]];entity.response={items:[{id:'entity:1'},{id:'entity:2'}],nextCursor:null,complete:true};
 entity.responseSha256=valueDigest(entity.response);
 const append=(tool:string,selection:Record<string,unknown>,response:unknown)=>{
  const id=report.calls.length;report.calls.push({id,tool,selection,response,responseSha256:valueDigest(response)});row.graph.callIds.push(id);
 };
 for(const id of ['entity:1','entity:2'])append('graph_neighbors',{id,direction:'both',limit:50},
  {items:[{recordId:'record:fixture',municipalityId:row.question.cityIds[0]}],nextCursor:null,complete:true});
 append('graph_path',{fromId:'entity:1',toId:'entity:2',maxHops:5,limit:20},{paths:[],complete:true});
 row.graph.recordIds=['record:fixture'];rebindValueFixtureRows(report);parseCandidateCollection(report);
 assert.deepEqual(Object.keys(valueAssessmentTarget(report,row,'withoutGraph').records),[]);
 assert.deepEqual(Object.keys(valueAssessmentTarget(report,row,'withGraph').records),['record:fixture']);
 const changed=structuredClone(report);changed.calls.at(-1)!.selection.maxHops=4;
 assert.throws(()=>parseCandidateCollection(changed));
});
test('persisted opaque pagination re-derives completeness and rejects a missing continuation',async t=>{
 const f=await valueAssessmentFixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const report=structuredClone(f.report),row=report.evaluations[1],first=report.calls[row.callIds[0]],cursor='[opaque pagination cursor omitted]';
 first.response={items:[],nextCursor:cursor,complete:false};first.responseSha256=valueDigest(first.response);
 const response={items:[],nextCursor:null,complete:true},id=report.calls.length;
 report.calls.push({id,tool:first.tool,selection:{...first.selection,cursor},response,responseSha256:valueDigest(response)});row.callIds.push(id);
 rebindValueFixtureRows(report);parseCandidateCollection(report);
 row.retrievalComplete=false;rebindValueFixtureRows(report);assert.throws(()=>parseCandidateCollection(report));
 row.retrievalComplete=true;row.callIds.pop();rebindValueFixtureRows(report);assert.throws(()=>parseCandidateCollection(report));
});
