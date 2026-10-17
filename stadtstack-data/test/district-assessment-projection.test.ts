import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {canonicalJson,digest,semanticHash} from '../src/district-adapter-contract.ts';
import {knowledgeEvidenceHash} from '../src/district-schema.ts';
import {modelIdentitySha256} from '../src/district-model-contract.ts';
import {normalizeGraphClaims} from '../src/district-graph-claims.ts';
import {residualAssessmentItem,residualRecordPropositions,reconstructResidualAssessmentItem} from '../src/district-assessment-jobs.ts';
import {assessmentBlindProjection,assessmentItemSchema,assessmentOutputSchema,assertSourceRecordProjection,assessmentProviderInput,buildAssessmentPassInput,createAssessmentReceipt,validateReceipt,deterministicChecks,runAssessmentPass} from '../src/district-assessment.ts';
import type {OriginalEvidence} from '../src/district-assessment.ts';
import type {PreparedDocument} from '../src/district-prepared-document.ts';
import {NATIVE_B_MODEL} from '../src/district-b-native-model.ts';
import {admittedAssessmentFixture,recordFor,answer,syntheticAssessmentReceipt,historicalResidualAssessmentItem} from './district-assessment.fixture.ts';
import {compactSourceProviderData,assertCompactSourceProviderData,resolveProviderQuoteReferences} from '../src/district-assessment-projection.ts';

async function fixture(t:TestContext,text='Strausberg prüft den Entwurf. Beschlussvorlage 123 vom 17.10.2026.'){
 const f=await admittedAssessmentFixture(text);t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const record=recordFor(f,text);record.documentDateReason='PRIVATE_GENERATED_ABSENCE_REASON';record.verification.evidenceHash=knowledgeEvidenceHash(record);
 const prepared:PreparedDocument={version:'district-prepared-v2',municipalityId:record.municipalityId,sourceSha256:f.source.originalSha256,sourceBytes:Buffer.byteLength(text),mimeType:'text/plain',references:record.sources,extractorSha256:digest('synthetic parser'),toolVersions:{fixture:'synthetic'},text,textSha256:f.source.textSha256,offsetUnit:'utf16_code_units',textLength:text.length,method:'text',ocrUsed:false,limitations:[],receiptSha256:digest('synthetic prepared receipt')};
 const item=residualAssessmentItem(record,prepared,digest('synthetic prepared artifact'),f.policyArtifact.sha256);
 // Synthetic projection-only evidence. Authenticated reopening is exercised by
 // the separate context and real-PG queue fixtures; no provider is invoked here.
 const source=item.sources[0],evidence:OriginalEvidence=[{sourceId:source.mcpSourceId!,admittedSourceId:source.sourceId,url:f.policy.source.url,
  originalSha256:source.originalSha256,textSha256:source.textSha256,parserVersion:source.parserVersion,parserReceiptSha256:source.parserReceiptSha256,
  admissionReceiptSha256:source.admissionReceiptSha256,ocrSuspected:false,text:null,assessmentContext:source.assessmentContext,
  locators:source.locators.map(locator=>({...locator,quote:text.slice(locator.start,locator.end)}))}];
 return {...f,text,record,prepared,item,evidence};
}
test('source projection v2 separates genuine statements from generated identity and unset qualifications',async t=>{
 const f=await fixture(t),projection=residualRecordPropositions(f.record);
 assert.equal(projection.version,'r1-record-propositions-v2');
 assert.deepEqual(projection.propositions.map(p=>p.selector),['/summary','/title']);
 for(const selector of ['/caseKey','/caseKeyType']){
  const binding=projection.bindings.find(value=>value.selector===selector)!;
  assert.equal(binding.basis,'source_document_sha256');assert.equal(binding.valueSha256,semanticHash(binding.value));
 }
 for(const selector of ['/stage','/stageDate','/documentDate','/originalStatus','/caseType','/stages','/entities'])assert.ok(projection.qualifications.some(value=>value.selector===selector));
 assert.deepEqual(f.item.sourceRecord?.record,f.record);assert.equal(f.item.sourceRecord?.recordSha256,semanticHash(f.record));
 const data=assessmentProviderInput(f.item,f.evidence),wire=canonicalJson(data);
 assert.equal('sourceRecord' in data,false);assert.equal(wire.includes('PRIVATE_GENERATED_ABSENCE_REASON'),false);
 assert.equal(wire.includes('faithfulness'),false);assert.equal(wire.includes('r1-provider-propositions-v3'),true);
 assert.equal(canonicalJson(data),canonicalJson(buildAssessmentPassInput(f.item,f.evidence,'B').data));
 const output=assessmentOutputSchema.parse(answer(buildAssessmentPassInput(f.item,f.evidence,'A')).value);
 assert.deepEqual(deterministicChecks(f.item,f.evidence,output),[]);
 assert.ok(deterministicChecks(f.item,f.evidence,{...output,assertions:output.assertions.slice(1)}).some(issue=>issue.startsWith('missing_claim:')));
 const textualValue=structuredClone(output);textualValue.assertions[0].value='a whole non-quantitative statement';textualValue.assertions[0].unit='text';
 assert.ok(deterministicChecks(f.item,f.evidence,textualValue).some(issue=>issue.startsWith('non_quantitative_value:')));
 const changed=structuredClone(f.item);changed.sourceRecord!.record.caseKey='source_document:'+ 'a'.repeat(64);
 assert.throws(()=>assertSourceRecordProjection(changed));
 const removed=structuredClone(f.item);removed.claimIds.pop();assert.throws(()=>assertSourceRecordProjection(removed));
 const identities=structuredClone(f.item);identities.entityIds.push('invented:source-identity');assert.throws(()=>assertSourceRecordProjection(identities));
});
test('positive classifications and actual dates/stages keep their explicit source quote associations',async t=>{
 const f=await fixture(t),record=structuredClone(f.record);
 Object.assign(record,{caseKey:'123',caseKeyType:'paper_reference',caseType:'council_paper',caseQuote:'Beschlussvorlage 123',
  documentDate:'2026-10-17',documentDateQuote:'17.10.2026',documentDateReason:null,
  stage:'draft',originalStatus:'Entwurf',stageQuote:'prüft den Entwurf'});
 record.verification.evidenceHash=knowledgeEvidenceHash(record);
 const projection=residualRecordPropositions(record);
 for(const [selector,quote] of [['/caseKey','Beschlussvorlage 123'],['/caseKeyType','Beschlussvorlage 123'],['/caseType','Beschlussvorlage 123'],
  ['/originalStatus','prüft den Entwurf'],['/stage','prüft den Entwurf'],['/documentDate','17.10.2026']]){
  const proposition=projection.propositions.find(value=>value.selector===selector)!;assert.ok(proposition);assert.equal(proposition.quote,quote);
  assert.deepEqual(proposition.assertionEncoding,{value:null,unit:null});
 }
 assert.equal(projection.bindings.some(value=>value.selector==='/caseKeyType'),false,'positive identifier classification is not authenticated as mere bookkeeping');
 const noQuote=structuredClone(record);noQuote.caseQuote=null;
 assert.equal(residualRecordPropositions(noQuote).propositions.find(value=>value.selector==='/caseType')!.quote,null,'missing grounding is not silently accepted or suppressed');
 const literal=structuredClone(record);literal.summary='unknown';literal.summaryQuote='unknown';
 assert.equal(residualRecordPropositions(literal).propositions.find(value=>value.selector==='/summary')!.asserted,'unknown','source text is not an enum placeholder');
});
test('nested generated graph identities and unlocated geometry remain authenticated non-propositions',async t=>{
 const f=await fixture(t),record=structuredClone(f.record);
 const graph=normalizeGraphClaims({entities:[{mentionId:'town',name:'Strausberg',type:'municipality',quote:'Strausberg',identifiers:[]}],relations:[]},{municipalityId:record.municipalityId,sourceSha256:record.extraction.inputSha256,ags:record.ags});
 record.entities=graph.entities;record.locations=[{label:'Strausberg',quote:'Strausberg',geometry:null,precision:'none'}];record.verification.evidenceHash=knowledgeEvidenceHash(record);
 const item=residualAssessmentItem(record,f.prepared,digest('synthetic prepared artifact'),f.policyArtifact.sha256),projection=assertSourceRecordProjection(item)!;
 const entity=projection.propositions.find(value=>value.selector==='/entities/0')!;
 assert.deepEqual(entity.asserted,{name:'Strausberg',type:'municipality',quote:'Strausberg'});
 for(const key of ['entityId','identityBasis'])assert.ok(projection.bindings.some(value=>value.selector==='/entities/0/'+key&&value.valueSha256===semanticHash(value.value)));
 assert.ok(projection.context.some(value=>value.selector==='/entities/0/mentionId'&&value.value==='town'));
 const location=projection.propositions.find(value=>value.selector==='/locations/0')!;
 assert.deepEqual(location.asserted,{label:'Strausberg',quote:'Strausberg'});
 for(const key of ['geometry','precision'])assert.ok(projection.qualifications.some(value=>value.selector==='/locations/0/'+key));
 assert.deepEqual(item.sourceRecord?.record,record);assert.ok(item.entityIds.includes(graph.entities[0].entityId));
});
test('ordinary relation propositions preserve source direction, not just endpoint co-occurrence',async t=>{
 const text='Stadtwerk betreibt das Museum in Strausberg.',f=await fixture(t,text),record=structuredClone(f.record);
 const entities=[{mentionId:'operator',name:'Stadtwerk',type:'organization' as const,quote:text,identifiers:[]},{mentionId:'facility',name:'Museum',type:'facility' as const,quote:text,identifiers:[]}];
 const relations=[{fromMention:'operator',toMention:'facility',type:'operates' as const,quote:text,predicateQuote:'betreibt',modality:'asserted' as const,time:null,conditions:null}];
 const graph=normalizeGraphClaims({entities,relations},{municipalityId:record.municipalityId,sourceSha256:record.extraction.inputSha256,ags:record.ags});
 record.entities=graph.entities;record.relations=graph.relations;record.verification.evidenceHash=knowledgeEvidenceHash(record);
 const item=residualAssessmentItem(record,f.prepared,digest('synthetic prepared artifact'),f.policyArtifact.sha256),projection=assertSourceRecordProjection(item)!;
 assert.equal(item.criticalTarget,undefined,'operates/asserted is an ordinary source relation, not a critical-only escape hatch');
 const proposition=projection.propositions.find(value=>value.selector==='/relations/0')!,asserted=proposition.asserted as Record<string,unknown>;
 assert.equal(asserted.fromMention,'operator');assert.equal(asserted.toMention,'facility');
 assert.deepEqual(asserted.subject,{mentionId:'operator',name:'Stadtwerk',type:'organization'});assert.deepEqual(asserted.object,{mentionId:'facility',name:'Museum',type:'facility'});
 for(const key of ['fromMention','toMention'])assert.equal(projection.bindings.some(value=>value.selector==='/relations/0/'+key),false);
 const reversed=structuredClone(record);Object.assign(reversed.relations[0],{fromMention:'facility',toMention:'operator',fromId:graph.entities[1].entityId,toId:graph.entities[0].entityId});reversed.verification.evidenceHash=knowledgeEvidenceHash(reversed);
 const reverseProposition=residualRecordPropositions(reversed).propositions.find(value=>value.selector==='/relations/0')!;
 assert.notEqual(reverseProposition.claimId,proposition.claimId);assert.notDeepEqual(reverseProposition.asserted,proposition.asserted);
 assert.equal((proposition.asserted as {modality:string}).modality,'asserted');assert.equal(proposition.assertionEncoding.modality,'confirmed');
 assert.equal(proposition.assertionEncoding.subjectId,graph.relations[0].fromId);assert.equal(proposition.assertionEncoding.objectId,graph.relations[0].toId);
 const source=item.sources[0],evidence:OriginalEvidence=[{...f.evidence[0],assessmentContext:source.assessmentContext,locators:source.locators.map(locator=>({...locator,quote:text.slice(locator.start,locator.end)}))}];
 const output=assessmentOutputSchema.parse(answer(buildAssessmentPassInput(item,evidence,'A')).value);
 for(const [raw,wire] of [['asserted','confirmed'],['decided','confirmed'],['implemented','confirmed'],['planned','planned'],['proposed','planned'],['conditional','conditional'],['negated','negated'],['historical','historical']] as const){
  const variant=structuredClone(record);variant.relations[0].modality=raw;variant.verification.evidenceHash=knowledgeEvidenceHash(variant);
  const encoded=residualRecordPropositions(variant).propositions.find(value=>value.selector==='/relations/0')!;
  assert.equal((encoded.asserted as {modality:string}).modality,raw,'wire encoding cannot rewrite the source modality');
  assert.equal(encoded.assertionEncoding.modality,wire);
  // Codec coverage is not a claim that these altered modalities are supported
  // by this source, nor a substitute for their separate critical review.
  const response=structuredClone(output);response.assertions.find(value=>value.claimId===proposition.claimId)!.modality=wire;
  assert.doesNotThrow(()=>assessmentOutputSchema.parse(response));
 }
 assert.deepEqual(deterministicChecks(item,evidence,output),[]);
 const wrong=structuredClone(output),relation=wrong.assertions.find(value=>value.claimId===proposition.claimId)!;
 [relation.subjectId,relation.objectId]=[relation.objectId,relation.subjectId];
 assert.ok(deterministicChecks(item,evidence,wrong).includes('relation_direction:'+proposition.claimId));
 relation.subjectId=null;relation.objectId=null;relation.modality='unknown';
 assert.ok(deterministicChecks(item,evidence,wrong).includes('relation_direction:'+proposition.claimId));
 assert.ok(deterministicChecks(item,evidence,wrong).includes('relation_modality:'+proposition.claimId));
});
test('historical reconstruction authenticates the persisted version while new preparation remains v2 only',async t=>{
 const f=await fixture(t);
 for(const critical of [false,true]){
  const record=structuredClone(f.record);if(critical)Object.assign(record,{stage:'draft',stageQuote:'prüft den Entwurf',originalStatus:'Entwurf'});
  record.verification.evidenceHash=knowledgeEvidenceHash(record);
  const current=residualAssessmentItem(record,f.prepared,digest('synthetic prepared artifact'),f.policyArtifact.sha256),legacy=historicalResidualAssessmentItem(record,current);
  assert.equal(legacy.sourceRecord,undefined);assert.ok(current.sourceRecord);
  assert.deepEqual(reconstructResidualAssessmentItem(record,f.prepared,digest('synthetic prepared artifact'),f.policyArtifact.sha256,legacy),legacy);
  assert.deepEqual(reconstructResidualAssessmentItem(record,f.prepared,digest('synthetic prepared artifact'),f.policyArtifact.sha256,current),current);
  const tampered=structuredClone(legacy);tampered.question+=' forged history';assert.throws(()=>reconstructResidualAssessmentItem(record,f.prepared,digest('synthetic prepared artifact'),f.policyArtifact.sha256,tampered));
  const downgrade=structuredClone(current);delete downgrade.sourceRecord;assert.throws(()=>reconstructResidualAssessmentItem(record,f.prepared,digest('synthetic prepared artifact'),f.policyArtifact.sha256,downgrade));
 }
});
test('legacy projection and v1 receipts remain readable; native Sonnet B alone uses receipt v2',async t=>{
 const f=await fixture(t),projection=residualRecordPropositions(f.record),{sourceRecord:ignored,...base}=f.item;
 const legacyProjection={version:'r1-record-propositions-v1',recordId:f.record.id,projectionSha256:semanticHash(assessmentBlindProjection(f.record)),sources:projection.sources,
  propositions:[{selector:'/summary',value:f.record.summary,quote:f.record.summaryQuote,sources:projection.sources,claimId:'legacy:summary'}]};
 const legacy=assessmentItemSchema.parse({...base,claim:canonicalJson(legacyProjection),claimIds:['legacy:summary']});
 const legacyInput=buildAssessmentPassInput(legacy,f.evidence,'B'),legacyOutput=assessmentOutputSchema.parse(answer(legacyInput).value);
 const old=syntheticAssessmentReceipt(legacy,'B',legacyOutput,legacyInput.data);
 assert.equal(validateReceipt(old,legacy,'B').version,'assessment-receipt-v1');
 const input=buildAssessmentPassInput(f.item,f.evidence,'B'),provider=answer(input);
 const identity={provider:'anthropic-subscription' as const,tool:'omp-cli' as const,toolVersion:'synthetic-only',model:NATIVE_B_MODEL,modelIdentityBasis:'reported-cli-model-and-tool-version' as const};
 const native={...provider,evidence:{...identity,modelIdentitySha256:modelIdentitySha256(identity)},requestedModel:NATIVE_B_MODEL,returnedModel:NATIVE_B_MODEL,reportedModels:[NATIVE_B_MODEL]};
 const clocks={startedAt:'2026-10-17T00:00:00Z',finishedAt:'2026-10-17T00:00:01Z'};
 const receipt=createAssessmentReceipt(f.item,'B',native,clocks,f.evidence,input);
 assert.equal(receipt.version,'assessment-receipt-v2');assert.equal(validateReceipt(receipt,f.item,'B').requestedModel,NATIVE_B_MODEL);
 assert.throws(()=>createAssessmentReceipt(f.item,'A',native,clocks,f.evidence));
 const downgraded={...receipt,version:'assessment-receipt-v1'};assert.throws(()=>validateReceipt(downgraded,f.item,'B'));
 const wrongTool={...native,evidence:{...native.evidence,tool:'claude-cli' as const}};
 assert.throws(()=>createAssessmentReceipt(f.item,'B',wrongTool,clocks,f.evidence));
});
test('standalone assessment cannot route B through VM Codex',async t=>{
 const f=await fixture(t);
 await assert.rejects(runAssessmentPass(f.item,'B','openai-subscription',{ledgerPath:'not-created-by-guard',pausePath:'not-created-by-guard'},undefined,f.context),/B requires the reviewed VM omp runner/);
 await assert.rejects(runAssessmentPass(f.item,'B','anthropic-subscription',{ledgerPath:'not-created-by-guard',pausePath:'not-created-by-guard'},undefined,f.context),/B requires the reviewed VM omp runner/);
});

test('compact provider encoding re-derives exact quotes and private partition without transmitting bookkeeping values',async t=>{
 const f=await fixture(t),projection=assertSourceRecordProjection(f.item)!,encoded=compactSourceProviderData(projection,f.evidence);
 assert.equal(encoded.claim.bindingsSha256,semanticHash(projection.bindings));assert.equal('bindings' in encoded.claim,false);
 assert.deepEqual(encoded.claim.qualifications,projection.qualifications.map(({selector,value})=>[selector,value]));
 assert.deepEqual(resolveProviderQuoteReferences(encoded.claim.context,f.evidence),projection.context.map(({selector,value})=>[selector,value]));
 assert.deepEqual(resolveProviderQuoteReferences(encoded.claim.propositions,f.evidence),projection.propositions);
 assert.deepEqual(assertCompactSourceProviderData(encoded,projection,f.evidence),encoded);
 assert.equal(f.item.claim,canonicalJson(projection),'private complete partition and its original hashes stay unchanged');
 const critical={claimProjection:{summaryQuote:f.text},claims:[{quote:f.text,claimId:'synthetic-critical',context:{dateQuote:f.text}}]};
 const criticalEncoding=compactSourceProviderData(projection,f.evidence,critical);
 assert.deepEqual(resolveProviderQuoteReferences(criticalEncoding.criticalTarget,f.evidence),critical);
 for(const forged of [{$quote:[[-1,0]]},{$quote:[[0,9999]]},{$quote:[[0,0.5]]},{$quote:[]},{$quote:[[0,0],[0,0]]},{$quote:[[0,0]],extra:true}]){
  assert.throws(()=>resolveProviderQuoteReferences(forged,f.evidence));
 }
 const mixed=[{...f.evidence[0],locators:[f.evidence[0].locators[0],{...f.evidence[0].locators[0],quote:'different exact quote'}]}];
 assert.throws(()=>resolveProviderQuoteReferences({$quote:[[0,0],[0,1]]},mixed),'different quote contents cannot share one reference');
 const repeated=[...f.evidence,{...f.evidence[0]}],allOccurrences=compactSourceProviderData(projection,repeated);
 const missingOccurrence=JSON.parse(JSON.stringify(allOccurrences));missingOccurrence.claim.propositions[0].quote.$quote.pop();
 assert.throws(()=>assertCompactSourceProviderData(missingOccurrence,projection,repeated),'even a same-content locator omission is rejected');
 const altered=structuredClone(encoded);altered.claim.propositions=[];
 assert.throws(()=>assertCompactSourceProviderData(altered,projection,f.evidence));
 const ambiguous=structuredClone(projection);ambiguous.propositions[0].asserted={$quote:[[0,0]]};
 assert.throws(()=>compactSourceProviderData(ambiguous,f.evidence));
 const missing=structuredClone(projection);missing.propositions[0].quote='not a supplied literal quote';
 assert.throws(()=>compactSourceProviderData(missing,f.evidence));
});
