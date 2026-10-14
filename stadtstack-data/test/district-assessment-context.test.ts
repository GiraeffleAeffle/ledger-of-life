import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {canonicalJson,digest} from '../src/district-adapter-contract.ts';
import {canonical,assessmentItemSchema,assessmentOutputSchema,originalEvidence,buildAssessmentPassInput,reconcile,verifyPinnedAssessment,type AssessmentItem} from '../src/district-assessment.ts';
import {residualAssessmentItem} from '../src/district-assessment-jobs.ts';
import {ASSESSMENT_CONTEXT_BYTES,AssessmentContextHold,assertAssessmentContextBound,buildPreparedAssessmentContext,verifyAssessmentContext} from '../src/district-assessment-context.ts';
import {BridgeLeaseSchema,bridgeInputHash,ASSESSMENT_BRIDGE_VERSION,BRIDGE_LIMITS} from '../src/district-assessment-bridge-contract.ts';
import {documentChunks} from '../src/district-claims.ts';
import {MAX_SUBSCRIPTION_INPUT_BYTES} from '../src/district-model.ts';
import {OMP_LIMITS,runVmOmpAssessment} from '../src/district-omp-b-runner.ts';
import {verifyPreparedDocument,type PreparedDocument} from '../src/district-prepared-document.ts';
import {knowledgeEvidenceHash} from '../src/district-schema.ts';
import {CIVIC_ACQUISITION_DECISION_ID,withManagedSourceWrite} from '../src/civic-opt-out.ts';
import {admittedAssessmentFixture,recordFor,syntheticAssessmentReceipt} from './district-assessment.fixture.ts';

async function largeItem(t:TestContext){
 // Many chunks, one independently extraction-cited chunk; irrelevant duplicate
 // quotations elsewhere must not broaden the context or bind another chunk.
 const quote='Strausberg synthetic source statement. ÄÖÜ 😀';
 const text=quote+'\n'+'x'.repeat(56000)+'\n'+quote+'\n'+'x'.repeat(70000);
 const f=await admittedAssessmentFixture(text,true);t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const chunks=documentChunks(text),chunk=chunks.find(c=>c.start>0&&c.text.includes(quote))!;
 const record=recordFor(f,quote);record.extraction.chunk={index:chunk.index,count:chunk.count,start:chunk.start,end:chunk.end};
 record.sources[0].locator=`text-sha256:${f.source.textSha256};chars:${chunk.start}-${chunk.end}`;
 record.verification.evidenceHash=knowledgeEvidenceHash(record);
 const body={version:'district-prepared-v2' as const,municipalityId:'strausberg',sourceSha256:f.source.originalSha256,sourceBytes:Buffer.byteLength(text),mimeType:'text/plain',references:record.sources,extractorSha256:digest('synthetic parser'),toolVersions:{fixture:'synthetic'},text,textSha256:f.source.textSha256,offsetUnit:'utf16_code_units' as const,textLength:text.length,method:'text' as const,ocrUsed:false,limitations:[]};
 const prepared:PreparedDocument={...body,receiptSha256:digest(canonical(body))};verifyPreparedDocument(prepared,prepared,Buffer.from(text));
 const put=async(value:unknown)=>{
  const bytes=Buffer.from(canonicalJson(value)),hash=digest(bytes);
  return withManagedSourceWrite(f.context.cas.root,[{kind:'http_observation',relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,url:f.policy.source.url,sourceSha256:f.source.originalSha256,observationId:'synthetic-context',receiptSha256:f.policyArtifact.sha256,independentAllowed:false}],()=>f.context.cas.put(bytes,{kind:'derived',mimeType:'application/json'}),{...f.context.policyOptions,decisionId:CIVIC_ACQUISITION_DECISION_ID});
 };
 const parser=await put(prepared),item=residualAssessmentItem(record,prepared,parser.sha256,f.policyArtifact.sha256);
 return {...f,text,quote,chunk,chunks,record,prepared,parser,item,put};
}

test('100+ KB multichunk prepared original yields bounded byte-exact blind A/B/C contexts and seal replay',async t=>{
 const f=await largeItem(t);assert.ok(Buffer.byteLength(f.text)>100000);assert.ok(f.chunks.length>4);
 const evidence=await originalEvidence(f.item,f.context),context=f.item.sources[0].assessmentContext!;
 assert.equal(evidence[0].text,null);assert.equal(context.preparedTextSha256,digest(f.text));
 assert.equal(context.chunks[0].excerpt,f.text.slice(f.chunk.start,f.chunk.end));assert.equal(context.chunks[0].excerptSha256,digest(context.chunks[0].excerpt));
 assert.ok(f.item.sources[0].locators.every(l=>l.start>=f.chunk.start&&l.end<=f.chunk.end));
 verifyAssessmentContext(context,f.text,f.prepared.textSha256,f.item.sources[0].locators);
 const AInput=buildAssessmentPassInput(f.item,evidence,'A'),BInput=buildAssessmentPassInput(f.item,evidence,'B');assert.equal(canonicalJson(AInput.data),canonicalJson(BInput.data));
 const output=assessmentOutputSchema.parse({itemId:f.item.itemId,outcome:'abstain',assertions:[],scores:{correctness:0,sources:0,usefulness:0},holdReasons:['insufficient_evidence'],rationale:'Synthetic abstention only; no actual model assessment.'});
 const A=syntheticAssessmentReceipt(f.item,'A',output,AInput.data),B=syntheticAssessmentReceipt(f.item,'B',output,BInput.data);
 const CInput=buildAssessmentPassInput(f.item,evidence,'C',{A,B});assert.equal(canonicalJson(CInput.data.evidence),canonicalJson(AInput.data.evidence));
 for(const input of [AInput,BInput,CInput]){
  const bytes=Buffer.byteLength(canonicalJson(input.data));assert.ok(bytes<=ASSESSMENT_CONTEXT_BYTES);assert.ok(bytes<BRIDGE_LIMITS.evidenceContextBytes);assert.ok(bytes<MAX_SUBSCRIPTION_INPUT_BYTES);assert.ok(bytes<OMP_LIMITS.inputBytes);
  assert.equal(canonicalJson(input.data).includes(f.text),false);
 }
 const binding={version:ASSESSMENT_BRIDGE_VERSION,leaseId:randomUUID(),jobKey:digest('synthetic job'),authorityId:f.authority.authorityId,authoritySha256:f.authority.authoritySha256,policySnapshotSha256:digest('synthetic snapshot'),expiresAt:new Date(Date.now()+60000).toISOString(),role:'B' as const,provider:'anthropic-subscription' as const,requestedModel:'claude-haiku-5-5' as const,system:'Synthetic source-free prompt',data:BInput.data,outputSchema:{},clientContractSha256:digest('synthetic client')};
 assert.ok(BridgeLeaseSchema.safeParse({...binding,inputSha256:bridgeInputHash(binding)}).success);
 const C=syntheticAssessmentReceipt(f.item,'C',output,CInput.data,CInput.dependencies),final=await reconcile(f.item,{A,B,C},f.context);
 const [item,AArtifact,BArtifact,CArtifact,finalArtifact]=await Promise.all([f.put(f.item),f.put(A),f.put(B),f.put(C),f.put(final)]);
 const replay=await verifyPinnedAssessment(f.context.cas,finalArtifact.sha256,{itemArtifactSha256:item.sha256,AArtifactSha256:AArtifact.sha256,BArtifactSha256:BArtifact.sha256,CArtifactSha256:CArtifact.sha256},f.context);
 assert.equal(replay.item.sources[0].assessmentContext!.chunks[0].excerptSha256,context.chunks[0].excerptSha256);
});

test('tampered excerpt, hash, offset, chunk id and missing quote coverage are rejected on authenticated reopen',async t=>{
 const f=await largeItem(t),source=f.item.sources[0];
 const mutations:((item:AssessmentItem)=>void)[]=[
  item=>{item.sources[0].assessmentContext!.chunks[0].excerpt+='forged';},
  item=>{const span=item.sources[0].assessmentContext!.chunks[0];span.excerpt+='forged';span.excerptSha256=digest(span.excerpt);},
  item=>{item.sources[0].assessmentContext!.chunks[0].excerptSha256=digest('forged');},
  item=>{item.sources[0].assessmentContext!.chunks[0].start++;},
  item=>{item.sources[0].assessmentContext!.chunks[0].id='chunk:forged';},
  item=>{item.sources[0].locators[0].start=0;},
  item=>{const projection=JSON.parse(item.claim);projection.propositions.push({quote:'claim never present in cited context'});item.claim=canonicalJson(projection);},
 ];
 for(const mutate of mutations){const item=structuredClone(f.item);mutate(item);await assert.rejects(originalEvidence(assessmentItemSchema.parse(item),f.context),AssessmentContextHold);}
 const wrong=structuredClone(f.record);wrong.summaryQuote=f.text.slice(0,13000);assert.throws(()=>residualAssessmentItem(wrong,f.prepared,f.parser.sha256,f.policyArtifact.sha256),AssessmentContextHold);
 const wrongChunk=structuredClone(f.record);wrongChunk.extraction.chunk.start++;assert.throws(()=>residualAssessmentItem(wrongChunk,f.prepared,f.parser.sha256,f.policyArtifact.sha256),AssessmentContextHold);
 const absent=structuredClone(source.assessmentContext!);absent.preparedTextSha256=digest('foreign prepared text');assert.throws(()=>verifyAssessmentContext(absent,f.text,f.prepared.textSha256,source.locators),AssessmentContextHold);
});

test('minimal over-cap context and C review envelope have a distinct pre-effect quality hold, never truncation',async t=>{
 const f=await largeItem(t),wideText=f.text.replaceAll('x','漢'),textSha256=digest(wideText);
 assert.throws(()=>buildPreparedAssessmentContext(wideText,textSha256,f.record.extraction.chunk,[`text-sha256:${textSha256};chars:${f.chunk.start}-${f.chunk.end}`]),{reasonCode:'assessment_context_exceeded'});
 const evidence=await originalEvidence(f.item,f.context),input=buildAssessmentPassInput(f.item,evidence,'A');
 const output=assessmentOutputSchema.parse({itemId:f.item.itemId,outcome:'abstain',assertions:[],scores:{correctness:0,sources:0,usefulness:0},holdReasons:[],rationale:'x'.repeat(7000)});
 const A=syntheticAssessmentReceipt(f.item,'A',output,input.data),B=syntheticAssessmentReceipt(f.item,'B',output,input.data);
 assert.throws(()=>buildAssessmentPassInput(f.item,evidence,'C',{A,B}),{reasonCode:'assessment_context_exceeded'});
});

test('shared request bound is UTF-8/canonical-envelope exact and rejects native B before review or credentials',async()=>{
 const exact={text:'x'.repeat(ASSESSMENT_CONTEXT_BYTES-Buffer.byteLength(canonicalJson({text:''})))};
 assert.equal(Buffer.byteLength(canonicalJson(exact)),ASSESSMENT_CONTEXT_BYTES);assertAssessmentContextBound(exact);
 assert.throws(()=>assertAssessmentContextBound({text:exact.text+'x'}),{reasonCode:'assessment_context_exceeded'});
 await assert.rejects(runVmOmpAssessment({text:'x'.repeat(ASSESSMENT_CONTEXT_BYTES)},{} as never),{reasonCode:'assessment_context_exceeded'});
});
