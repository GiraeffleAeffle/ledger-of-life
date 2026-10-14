import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {rm,readFile,writeFile,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonicalJson,digest} from '../src/district-adapter-contract.ts';
import {canonical,PROMPTS,assessmentItemSchema,assessmentOutputSchema,originalEvidence,buildAssessmentPassInput,reconcile,verifyPinnedAssessment,type AssessmentItem} from '../src/district-assessment.ts';
import {residualAssessmentItem} from '../src/district-assessment-jobs.ts';
import {ASSESSMENT_CONTEXT_BYTES,ASSESSMENT_RECONCILIATION_BYTES,ASSESSMENT_NEIGHBOUR_CODE_UNITS,AssessmentContextHold,assertAssessmentContextBound,buildPreparedAssessmentContext,verifyAssessmentContext} from '../src/district-assessment-context.ts';
import {BridgeLeaseSchema,bridgeInputHash,ASSESSMENT_BRIDGE_VERSION,BRIDGE_LIMITS} from '../src/district-assessment-bridge-contract.ts';
import {documentChunks} from '../src/district-claims.ts';
import {MAX_SUBSCRIPTION_INPUT_BYTES,encodeSubscriptionInput,codexResponseSchema} from '../src/district-model.ts';
import {OMP_LIMITS,runVmOmpAssessment} from '../src/district-omp-b-runner.ts';
import {verifyPreparedDocument,type PreparedDocument} from '../src/district-prepared-document.ts';
import {knowledgeEvidenceHash} from '../src/district-schema.ts';
import {withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
import {admittedAssessmentFixture,recordFor,answer,syntheticAssessmentReceipt} from './district-assessment.fixture.ts';

async function largeItem(t:TestContext){
 // Many chunks, one independently extraction-cited chunk; irrelevant duplicate
 // quotations elsewhere must not broaden the context or bind another chunk.
 const quote='Strausberg synthetic source statement. ÄÖÜ 😀';
 const text='Uncited document-only prefix.\n'+quote+'\n'+'x'.repeat(56000)+'\n'+quote+'\n'+'x'.repeat(70000);
 const f=await admittedAssessmentFixture(text,true);t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const chunks=documentChunks(text),chunk=chunks.find(c=>c.start>0&&c.text.includes(quote))!;
 const record=recordFor(f,quote);record.extraction.chunk={index:chunk.index,count:chunk.count,start:chunk.start,end:chunk.end};
 record.sources[0].locator=`text-sha256:${f.source.textSha256};chars:${chunk.start}-${chunk.end}`;
 record.topics=[{id:'siedlung',parentId:null,provenance:'model',confidence:0.8,quote:'source statement'}];
 record.locations=[{label:'Strausberg',quote:'Strausberg',geometry:null,precision:'none'}];
 record.verification.evidenceHash=knowledgeEvidenceHash(record);
 const body={version:'district-prepared-v2' as const,municipalityId:'strausberg',sourceSha256:f.source.originalSha256,sourceBytes:Buffer.byteLength(text),mimeType:'text/plain',references:record.sources,extractorSha256:digest('synthetic parser'),toolVersions:{fixture:'synthetic'},text,textSha256:f.source.textSha256,offsetUnit:'utf16_code_units' as const,textLength:text.length,method:'text' as const,ocrUsed:false,limitations:[]};
 const prepared:PreparedDocument={...body,receiptSha256:digest(canonical(body))};verifyPreparedDocument(prepared,prepared,Buffer.from(text));
 const put=async(value:unknown)=>{
  const bytes=Buffer.from(canonicalJson(value)),hash=digest(bytes);
  return withManagedSourceWrite(f.context.cas.root,[{kind:'http_observation',relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,url:f.policy.source.url,sourceSha256:f.source.originalSha256,observationId:'synthetic-context',receiptSha256:f.policyArtifact.sha256,independentAllowed:false}],()=>f.context.cas.put(bytes,{kind:'derived',mimeType:'application/json'}),f.context.policyOptions);
 };
 const parser=await put(prepared),item=residualAssessmentItem(record,prepared,parser.sha256,f.policyArtifact.sha256);
 return {...f,text,quote,chunk,chunks,record,prepared,parser,item,put};
}

test('100+ KB multichunk prepared original yields bounded byte-exact blind A/B/C contexts and seal replay',async t=>{
 const f=await largeItem(t);assert.ok(Buffer.byteLength(f.text)>100000);assert.ok(f.chunks.length>4);
 const evidence=await originalEvidence(f.item,f.context),context=f.item.sources[0].assessmentContext!;
 assert.equal(evidence[0].text,null);assert.equal(context.preparedTextSha256,digest(f.text));
 assert.equal(context.neighbourCodeUnits,ASSESSMENT_NEIGHBOUR_CODE_UNITS);
 assert.ok(context.spans.reduce((bytes,span)=>bytes+Buffer.byteLength(span.excerpt),0)<2000);
 for(const span of context.spans){assert.equal(span.excerpt,f.text.slice(span.start,span.end));assert.equal(span.excerptSha256,digest(span.excerpt));assert.ok(span.start>=f.chunk.start&&span.end<=f.chunk.end);}
 assert.ok(f.item.sources[0].locators.every(l=>l.start>=f.chunk.start&&l.end<=f.chunk.end));
 verifyAssessmentContext(context,f.text,f.prepared.textSha256,f.item.sources[0].locators);
 const AInput=buildAssessmentPassInput(f.item,evidence,'A'),BInput=buildAssessmentPassInput(f.item,evidence,'B');assert.equal(canonicalJson(AInput.data),canonicalJson(BInput.data));
 const projected=JSON.parse(JSON.stringify(AInput.data.claim));
 assert.equal(projected.version,'r1-provider-propositions-v1');
 const restored={...projected,version:'r1-record-propositions-v1',propositions:projected.propositions.map(({sourceIds,...p}:Record<string,unknown>&{sourceIds:string[]})=>({...p,sources:sourceIds.map(id=>projected.sources.find((source:{id:string})=>source.id===id))}))};
 assert.deepEqual(restored,JSON.parse(f.item.claim));
 const output=assessmentOutputSchema.parse(answer(AInput).value);
 const A=syntheticAssessmentReceipt(f.item,'A',output,AInput.data),B=syntheticAssessmentReceipt(f.item,'B',output,BInput.data);
 const CInput=buildAssessmentPassInput(f.item,evidence,'C',{A,B});assert.equal(canonicalJson(CInput.data.evidence),canonicalJson(AInput.data.evidence));
 for(const input of [AInput,BInput,CInput]){
  const bytes=Buffer.byteLength(canonicalJson(input.data));assert.ok(bytes<=(input.role==='C'?ASSESSMENT_RECONCILIATION_BYTES:ASSESSMENT_CONTEXT_BYTES));if(input.role!=='C')assert.ok(bytes<BRIDGE_LIMITS.evidenceContextBytes);assert.ok(bytes<MAX_SUBSCRIPTION_INPUT_BYTES);assert.ok(bytes<OMP_LIMITS.inputBytes);
  assert.ok(Buffer.byteLength(PROMPTS[input.role])<8000);
  assert.ok(Buffer.byteLength(encodeSubscriptionInput(PROMPTS[input.role],input.data))<MAX_SUBSCRIPTION_INPUT_BYTES);
  assert.equal(canonicalJson(input.data).includes(f.text),false);
 }
 const binding={version:ASSESSMENT_BRIDGE_VERSION,leaseId:randomUUID(),jobKey:digest('synthetic job'),authorityId:f.authority.authorityId,authoritySha256:f.authority.authoritySha256,policySnapshotSha256:digest('synthetic snapshot'),expiresAt:new Date(Date.now()+60000).toISOString(),role:'B' as const,provider:'anthropic-subscription' as const,requestedModel:'claude-haiku-5-5' as const,system:'Synthetic source-free prompt',data:BInput.data,outputSchema:{},clientContractSha256:digest('synthetic client')};
 assert.ok(BridgeLeaseSchema.safeParse({...binding,inputSha256:bridgeInputHash(binding)}).success);
 const C=syntheticAssessmentReceipt(f.item,'C',output,CInput.data,CInput.dependencies),final=await reconcile(f.item,{A,B,C},f.context);
 const [item,AArtifact,BArtifact,CArtifact,finalArtifact]=await Promise.all([f.put(f.item),f.put(A),f.put(B),f.put(C),f.put(final)]);
 const replay=await verifyPinnedAssessment(f.context.cas,finalArtifact.sha256,{itemArtifactSha256:item.sha256,AArtifactSha256:AArtifact.sha256,BArtifactSha256:BArtifact.sha256,CArtifactSha256:CArtifact.sha256},f.context);
 assert.equal(replay.item.sources[0].assessmentContext!.spans[0].excerptSha256,context.spans[0].excerptSha256);
});

test('tampered excerpt, hash, offset, chunk id and missing quote coverage are rejected on authenticated reopen',async t=>{
 const f=await largeItem(t),source=f.item.sources[0];
 const mutations:((item:AssessmentItem)=>void)[]=[
  item=>{item.sources[0].assessmentContext!.spans[0].excerpt+='forged';},
  item=>{const span=item.sources[0].assessmentContext!.spans[0];span.excerpt+='forged';span.excerptSha256=digest(span.excerpt);},
  item=>{item.sources[0].assessmentContext!.spans[0].excerptSha256=digest('forged');},
  item=>{item.sources[0].assessmentContext!.chunks[0].start++;},
  item=>{item.sources[0].assessmentContext!.spans[0].start++;},
  item=>{item.sources[0].assessmentContext!.spans[0].chunkId='chunk:foreign';},
  item=>{item.sources[0].assessmentContext!.chunks[0].id='chunk:forged';},
  item=>{item.sources[0].locators[0].start=0;},
  item=>{const projection=JSON.parse(item.claim);projection.propositions.push({quote:'claim never present in cited context'});item.claim=canonicalJson(projection);},
 ];
 for(const mutate of mutations){const item=structuredClone(f.item);mutate(item);await assert.rejects(originalEvidence(assessmentItemSchema.parse(item),f.context),AssessmentContextHold);}
 const wrong=structuredClone(f.record);wrong.summaryQuote='Uncited document-only prefix.';wrong.verification.evidenceHash=knowledgeEvidenceHash(wrong);assert.throws(()=>residualAssessmentItem(wrong,f.prepared,f.parser.sha256,f.policyArtifact.sha256),AssessmentContextHold);
 const wrongChunk=structuredClone(f.record);wrongChunk.extraction.chunk.start++;wrongChunk.verification.evidenceHash=knowledgeEvidenceHash(wrongChunk);assert.throws(()=>residualAssessmentItem(wrongChunk,f.prepared,f.parser.sha256,f.policyArtifact.sha256),AssessmentContextHold);
 const absent=structuredClone(source.assessmentContext!);absent.preparedTextSha256=digest('foreign prepared text');assert.throws(()=>verifyAssessmentContext(absent,f.text,f.prepared.textSha256,source.locators),AssessmentContextHold);
});

test('minimal over-cap context and C review envelope have a distinct pre-effect quality hold, never truncation',async t=>{
 const f=await largeItem(t),wideText=f.text.replaceAll('x','漢'),textSha256=digest(wideText);
 assert.throws(()=>buildPreparedAssessmentContext(wideText,textSha256,f.record.extraction.chunk,[`text-sha256:${textSha256};chars:${f.chunk.start}-${f.chunk.end}`],[{start:f.chunk.start,end:f.chunk.end}]),{reasonCode:'assessment_context_exceeded'});
 const evidence=await originalEvidence(f.item,f.context),input=buildAssessmentPassInput(f.item,evidence,'A');
 const output=assessmentOutputSchema.parse({itemId:f.item.itemId,outcome:'abstain',assertions:[],scores:{correctness:0,sources:0,usefulness:0},holdReasons:[],rationale:'x'.repeat(11000)});
 const A=syntheticAssessmentReceipt(f.item,'A',output,input.data),B=syntheticAssessmentReceipt(f.item,'B',output,input.data);
 const CInput=buildAssessmentPassInput(f.item,evidence,'C',{A,B});assert.ok(Buffer.byteLength(canonicalJson(CInput.data))>ASSESSMENT_CONTEXT_BYTES);assert.ok(Buffer.byteLength(encodeSubscriptionInput(PROMPTS.C,CInput.data))<=ASSESSMENT_RECONCILIATION_BYTES);
 const huge={...output,rationale:'x'.repeat(22000)},hugeA=syntheticAssessmentReceipt(f.item,'A',huge,input.data),hugeB=syntheticAssessmentReceipt(f.item,'B',huge,input.data);
 assert.throws(()=>buildAssessmentPassInput(f.item,evidence,'C',{A:hugeA,B:hugeB}),{reasonCode:'assessment_context_exceeded'});
});

test('shared request bound is UTF-8/canonical-envelope exact and rejects native B before review or credentials',async()=>{
 const exact={text:'x'.repeat(ASSESSMENT_CONTEXT_BYTES-Buffer.byteLength(canonicalJson({text:''})))};
 assert.equal(Buffer.byteLength(canonicalJson(exact)),ASSESSMENT_CONTEXT_BYTES);assertAssessmentContextBound(exact);
 assert.throws(()=>assertAssessmentContextBound({text:exact.text+'x'}),{reasonCode:'assessment_context_exceeded'});
 const exactC={text:'x'.repeat(ASSESSMENT_RECONCILIATION_BYTES-Buffer.byteLength(canonicalJson({text:''})))};
 assertAssessmentContextBound(exactC,'C');assert.throws(()=>assertAssessmentContextBound({text:exactC.text+'x'},'C'),{reasonCode:'assessment_context_exceeded'});
 await assert.rejects(runVmOmpAssessment({text:'x'.repeat(ASSESSMENT_CONTEXT_BYTES)},{} as never),{reasonCode:'assessment_context_exceeded'});
});

test('fixed windows merge, clip to cited chunks and preserve byte-exact Unicode boundaries',()=>{
 const text='a'.repeat(300)+'😀'+'b'.repeat(300),textSha256=digest(text),chunk=documentChunks(text)[0];
 const source=[`text-sha256:${textSha256};chars:${chunk.start}-${chunk.end}`],locators=[{start:557,end:558},{start:558,end:559}];
 const context=buildPreparedAssessmentContext(text,textSha256,chunk,source,locators);
 assert.equal(context.spans.length,1);assert.equal(context.spans[0].start,302);assert.equal(context.spans[0].end,text.length);
 assert.equal(Buffer.from(context.spans[0].excerpt).toString('utf8'),context.spans[0].excerpt);
 verifyAssessmentContext(context,text,textSha256,locators);
 const edges=[{start:0,end:1},{start:text.length-1,end:text.length}],clipped=buildPreparedAssessmentContext(text,textSha256,chunk,source,edges);
 assert.equal(clipped.spans[0].start,0);assert.equal(clipped.spans.at(-1)!.end,text.length);
 assert.throws(()=>buildPreparedAssessmentContext(text,textSha256,chunk,source,[{start:301,end:302}]),AssessmentContextHold);
});

test('legacy residual and prepared-text items cannot expose whole documents without governed context',async t=>{
 const f=await largeItem(t),legacy=structuredClone(f.item);delete legacy.sources[0].assessmentContext;
 await assert.rejects(originalEvidence(legacy,f.context),AssessmentContextHold);
 // A legacy critical/other prepared-text question has no projection marker;
 // its authenticated prepared-document parser receipt still identifies text.
 legacy.claim='Legacy independently assessed text question';
 await assert.rejects(originalEvidence(legacy,f.context),AssessmentContextHold);
});

test('standalone C authenticates its oversized request before intent and records a typed quality hold',async t=>{
 const f=await largeItem(t),evidence=await originalEvidence(f.item,f.context),input=buildAssessmentPassInput(f.item,evidence,'A');
 const output=assessmentOutputSchema.parse({itemId:f.item.itemId,outcome:'abstain',assertions:[],scores:{correctness:0,sources:0,usefulness:0},holdReasons:[],rationale:'x'.repeat(22000)});
 const A=syntheticAssessmentReceipt(f.item,'A',output,input.data),B=syntheticAssessmentReceipt(f.item,'B',output,input.data);
 const itemArtifact=await f.put(f.item),itemPath=join(f.context.cas.root,itemArtifact.storageKey),aPath=join(f.directory,'cli-A.json'),bPath=join(f.directory,'cli-B.json'),sourcePath=join(f.directory,'cli-source-context.json'),result=join(f.directory,'cli-C.json'),ledger=join(f.directory,'cli-ledger.jsonl'),pause=join(f.directory,'cli-pause.json');
 const sourceContext={root:f.context.cas.root,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...f.context.policyOptions,bindings:[{kind:'http_observation',url:f.policy.source.url,sourceSha256:f.source.originalSha256,observationId:'synthetic-context',receiptSha256:f.policyArtifact.sha256}]};
 await Promise.all([[sourcePath,sourceContext],[aPath,A],[bPath,B]].map(([path,value])=>writeFile(path as string,canonicalJson(value),{mode:0o600})));
 let stderr='';await assert.rejects(promisify(execFile)(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('../src/district-assessment.ts',import.meta.url)),'pass',itemPath,'C','openai-subscription',result,ledger,pause,aPath,bPath,'--cas-root',f.context.cas.root,'--source-context',sourcePath],{timeout:15000}),error=>{
  if(!(error instanceof Error)||!('stderr' in error)||typeof error.stderr!=='string'||!('code' in error))return false;
  stderr=error.stderr;return error.code===1;
 });
 const held=JSON.parse(await readFile(result,'utf8').catch(error=>{throw new Error(stderr,{cause:error});}));assert.equal(held.disposition,'held_quality');assert.equal(held.reason,'assessment_context_exceeded');assert.equal(held.fallbackAttempted,false);
 for(const path of [result+'.intent.json',ledger,pause])await assert.rejects(lstat(path),{code:'ENOENT'});
});

test('pilot-shaped multichunk A/C assessments use strict complete nullable-review response objects',async t=>{
 const f=await largeItem(t),evidence=await originalEvidence(f.item,f.context),input=buildAssessmentPassInput(f.item,evidence,'A');
 const original=z.toJSONSchema(assessmentOutputSchema);
 assert.ok(original.properties);assert.ok(original.required);
 assert.ok('valueReview' in original.properties&&'criticalReview' in original.properties);
 assert.equal(original.required.includes('valueReview'),false);assert.equal(original.required.includes('criticalReview'),false);
 let objects=0;
 const strict=(node:unknown):void=>{
  if(node===null||typeof node!=='object')return;
  if('type' in node&&node.type==='object'){
   assert.ok('properties' in node&&node.properties&&typeof node.properties==='object');
   assert.ok('required' in node&&Array.isArray(node.required));
   assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());
   assert.ok('additionalProperties' in node&&node.additionalProperties===false);objects++;
  }
  for(const value of Object.values(node))strict(value);
 };
 const wire=codexResponseSchema(original);strict(wire);assert.ok(objects>10);
 assert.deepEqual(codexResponseSchema(wire),wire);
 const output=assessmentOutputSchema.parse({...assessmentOutputSchema.parse(answer(input).value),valueReview:null,criticalReview:null});
 const A=syntheticAssessmentReceipt(f.item,'A',output,input.data),B=syntheticAssessmentReceipt(f.item,'B',output,input.data);
 const C=buildAssessmentPassInput(f.item,evidence,'C',{A,B});assert.equal(C.role,'C');
 assert.ok(Buffer.byteLength(encodeSubscriptionInput(PROMPTS.C,C.data))<ASSESSMENT_RECONCILIATION_BYTES);
 assert.deepEqual(JSON.parse(f.item.claim).propositions.map((p:{claimId:string})=>p.claimId),f.item.claimIds);
});
