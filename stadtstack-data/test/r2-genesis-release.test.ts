import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {GENESIS_CAPS,GENESIS_NODE,GENESIS_OWNER,GenesisReleaseDraftSchema,GenesisReleaseSchema,genesisRequestPlan,genesisDataSelectors,validateGenesisRelease,initialGenesisBudget,reserveGenesisAttempt,accountGenesisChunk,assertGenesisWireIdentity,checkGenesisMetadataReply,GenesisWireCustody,withGenesisOperation} from '../src/r2-genesis-release.ts';
import type {GenesisRelease} from '../src/r2-genesis-release.ts';
import {genesisPreflight,genesisMetadataReviewDraft,genesisEnqueue,genesisAcquire,genesisAcquisitionSpecs} from '../src/r2-genesis-executor.ts';
import {digest,semanticHash} from '../src/district-adapter-contract.ts';
import {genesisAdapter,GENESIS_BASE,GENESIS_VERSION} from '../src/adapters/genesis.ts';
import {StructuredWorkerRequestSchema} from '../src/district-structured-parser-worker.ts';
import {nativePublicRequestHeaders} from '../src/district-native-request.ts';
import {ownerGenesisAccessFor} from '../src/source-policy.ts';
import {PARSER_REVIEW_PATH} from '../src/district-parser-isolation.ts';
import {createR1PublicFetcher} from '../src/district-r1.ts';
import type {DistrictJobStore,JobHandlerContext} from '../src/district-jobs.ts';
import {DistrictCas} from '../src/district-cas.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {PoliteFetcher} from '../src/polite-fetch.ts';
import type {FetchedDocument,WireRequestIdentity} from '../src/polite-fetch.ts';
import type {R2StructuredRequest} from '../src/r2-structured-request-plan.ts';

// Every authority/proof below is a SYNTHETIC unit fixture, not an observed source,
// an installed parser review, an issued production grant or a replacement receipt.
const hash=digest('synthetic GENESIS release unit fixture'),contract={adapterContractSha256:hash,parserContractSha256:hash,mappingContractSha256:hash,semanticContractSha256:hash};
function release(root='/synthetic-genesis-unit-execution'):GenesisRelease{
 const now=Date.now(),plan=genesisRequestPlan();
 return GenesisReleaseSchema.parse({schemaVersion:'r2-genesis-structured-security-release-v3',id:'synthetic-unit-only',status:'ISSUED',issuedAt:new Date(now-1000).toISOString(),validFrom:new Date(now-1000).toISOString(),expiresAt:new Date(now+1800000).toISOString(),approvedBy:'Main',sourceFetchStopLifted:true,plan,planSha256:digest(JSON.stringify(plan,null,2)+'\n'),ownerApproval:GENESIS_OWNER,runtime:{packageRoot:'/synthetic-unit-code',node:{path:GENESIS_NODE,version:'v24.22.1',sha256:hash},codeSha256:hash,registryConfigurationSha256:hash,contracts:{acquisition:hash,genesis:contract,parserIsolation:hash,operatorRegistry:hash},policy:{stateDir:'/synthetic-unit-policy',authorityId:'fixture:synthetic',authoritySha256:hash},parserReviewPath:PARSER_REVIEW_PATH,requiredParserNodeVersion:'v24.22.1'},executionRoot:root,stopConditions:['synthetic unit fixture'],reviewEvidence:{path:'/synthetic-review',sha256:hash},parserAuthorization:{path:PARSER_REVIEW_PATH,sha256:hash},registryDescriptor:{path:'/synthetic-registry',sha256:hash}});
}
async function temporary(t:{after:(fn:()=>Promise<void>)=>void}){const root=await mkdtemp(join(tmpdir(),'r2-genesis-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const request=genesisRequestPlan().requests.find(row=>row.phase==='genesis_data')!,start=1_000_000,end=start+7_000_000;
function wireFor(row:R2StructuredRequest):WireRequestIdentity{return {method:row.method,body:row.body,publicOperation:row.credentials==='existing_owner_headers'?'genesis_guest':null};}
test('wire identity refuses a GET policy link to a POST endpoint and any altered body/profile',()=>{
 assert.doesNotThrow(()=>assertGenesisWireIdentity(request.url,wireFor(request),request));
 for(const changed of [{method:'GET' as const,body:null,publicOperation:null},{...wireFor(request),body:request.body+'&unapproved=1'},{...wireFor(request),publicOperation:null}])assert.throws(()=>assertGenesisWireIdentity(request.url,changed,request),/wire selector/u);
 const metadata=genesisRequestPlan().requests.find(row=>row.phase==='genesis_metadata')!,policy='https://www.regionalstatistik.de/robots.txt';assert.doesNotThrow(()=>assertGenesisWireIdentity(policy,{method:'GET',body:null,publicOperation:null},metadata));
 assert.throws(()=>assertGenesisWireIdentity(policy,{method:'GET',body:request.body,publicOperation:null},metadata),/wire selector/u);
 assert.throws(()=>assertGenesisWireIdentity(metadata.url,{...wireFor(metadata),publicOperation:'genesis_guest'},metadata),/wire selector/u);
});

test('GENESIS-only plan contains exactly six automatic policy GETs, three preflight GETs, one anonymous metadata POST and nine owner POSTs',()=>{
 const plan=genesisRequestPlan(),policy=plan.requests.filter(row=>/\/(?:robots\.txt|\.well-known\/tdmrep\.json)$/u.test(new URL(row.url).pathname));
 assert.equal(plan.requests.length,19);assert.equal(policy.length,6);assert.equal(plan.requests.filter(row=>row.phase==='preflight').length,9);assert.equal(plan.requests.filter(row=>row.phase==='genesis_metadata').length,1);assert.equal(plan.requests.filter(row=>row.phase==='genesis_data').length,9);
 assert(plan.requests.every(row=>row.sourceId!=='mastr'&&!row.url.includes('marktstammdatenregister')));assert.equal(plan.caps.maxNetworkAttempts,13*8);assert.equal(plan.caps.minSpacingMs,5000);assert.equal(plan.caps.maxInFlight,1);assert.equal(plan.caps.automaticRetries,0);
 for(const row of plan.requests.filter(row=>row.phase==='genesis_data')){const body=new URLSearchParams(row.body!);assert.equal(body.get('name'),'31231-02-01');assert.equal(body.get('regionalvariable'),'GEMEIN');assert.equal(body.get('startyear'),'2024');assert.equal(body.get('endyear'),'2024');assert.equal(row.credentials,'existing_owner_headers');assert(ownerGenesisAccessFor(row.url));}
 const metadata=plan.requests.find(row=>row.phase==='genesis_metadata')!;assert.equal(metadata.credentials,'none');assert.deepEqual(nativePublicRequestHeaders(new URL(metadata.url),'POST',metadata.body!),{'Content-Type':metadata.contentType});
});
test('new selection consists only of nine exact native acquisition specs, never treats acquisition as structured output',()=>{
 const selectors=genesisDataSelectors(),specs=genesisAcquisitionSpecs(release());assert.equal(selectors.length,9);assert.equal(new Set(selectors.map(row=>row.scope.ags)).size,9);
 for(const [index,selector] of selectors.entries()){assert.equal(selector.request.publicOperation,'genesis_guest');assert.equal(selector.discovery,null);assert.equal(selector.root,GENESIS_BASE+'data/table');assert.equal(selector.request.contentType,'application/x-www-form-urlencoded;charset=UTF-8');assert.equal(selector.maxBytes,4*1024**2);assert.equal(specs[index].step,'acquire_representation');assert.deepEqual(specs[index].selector,selector);assert.deepEqual(specs[index].sourceScope,selector.scope);}
});
test('strict v3 refuses draft, old scope, lifted-stop false, changed requests/caps/owner and bad clocks',()=>{
 const record=release();assert.equal(validateGenesisRelease(record).id,record.id);
 for(const mutate of [(v:Record<string,unknown>)=>{v.status='DRAFT';v.issuedAt='';},(v:Record<string,unknown>)=>{v.schemaVersion='r1-step8-source-fetch-security-release-v1';},(v:Record<string,unknown>)=>{v.sourceFetchStopLifted=false;},(v:Record<string,unknown>)=>{v.plan={...genesisRequestPlan(),year:'2023'};},(v:Record<string,unknown>)=>{v.ownerApproval={...GENESIS_OWNER,sha256:hash};},(v:Record<string,unknown>)=>{v.issuedAt=new Date(Date.now()+60000).toISOString();},(v:Record<string,unknown>)=>{v.expiresAt=new Date(Date.now()-1).toISOString();},(v:Record<string,unknown>)=>{v.expiresAt=new Date(Date.now()+8_000_000).toISOString();}]){const changed:Record<string,unknown>=structuredClone(record);mutate(changed);assert.throws(()=>validateGenesisRelease(changed));}
});
test('pure wire reservations enforce global/per-action caps, one in flight, exact URLs, spacing, clocks and no retry',()=>{
 const state=initialGenesisBudget(start),first=reserveGenesisAttempt(state,request.url,request,[],start,end);assert.equal(first.attempts,1);assert.equal(first.active,request.url);
 assert.throws(()=>reserveGenesisAttempt(first,request.url,request,[],start+5000,end),/busy/u);
 assert.throws(()=>reserveGenesisAttempt({...state,attempts:GENESIS_CAPS.maxNetworkAttempts},request.url,request,[],start,end),/cap/u);
 assert.throws(()=>reserveGenesisAttempt({...state,actionAttempts:8},request.url,request,[],start,end),/cap/u);
 assert.throws(()=>reserveGenesisAttempt(state,request.url+'?unexpected=1',request,[],start,end),/allowlist/u);
 assert.throws(()=>reserveGenesisAttempt({...state,lastFinishedAt:start},request.url,request,[],start+4999,end),/spacing/u);
 assert.throws(()=>reserveGenesisAttempt({...state,lastFinishedAt:start+1},request.url,request,[],start,end),/clock/u);
 assert.throws(()=>reserveGenesisAttempt({...state,primaryAttempts:1},request.url,request,[],start,end),/retried/u);
 assert.throws(()=>reserveGenesisAttempt(state,request.url,request,[],end-120000,end),/deadline/u);
 assert.throws(()=>reserveGenesisAttempt({...state,stopped:true},request.url,request,[],start,end),/stopped/u);
});
test('wire body accounting includes failed-response bytes and refuses per-response/global/time/identity overruns',()=>{
 const active=reserveGenesisAttempt(initialGenesisBudget(start),request.url,request,[],start,end),counted=accountGenesisChunk(active,request.url,1024,0,4096,start,end);assert.equal(counted.bytes,1024);
 assert.throws(()=>accountGenesisChunk(counted,request.url,4096,1024,4096,start,end),/accounting/u);
 assert.throws(()=>accountGenesisChunk({...active,bytes:GENESIS_CAPS.maxTotalBodyBytes},request.url,1,0,4096,start,end),/accounting/u);
 assert.throws(()=>accountGenesisChunk(active,request.url,1,0,4096,end,end),/accounting/u);
 assert.throws(()=>accountGenesisChunk(active,'https://www.govdata.de/robots.txt',1,0,4096,start,end),/accounting/u);
 for(const value of [-1,0.5,NaN])assert.throws(()=>accountGenesisChunk(active,request.url,value,0,4096,start,end));
});
function reply(municipalityIndex=0,geography='Gemeinden',table='31231-02-01'){
 const selector=genesisDataSelectors()[municipalityIndex],bytes=Buffer.from(JSON.stringify({Ident:{Service:'metadata',Method:'table'},Status:{Code:0,Type:'Information',Content:'synthetic fixture'},Object:{Code:table,Structure:{Rows:[{Code:geography==='Gemeinden'?'GEMEIN':'KREIS',Content:geography,Selected:null}]}}}));
 const snapshot={sourceSha256:digest(bytes),url:GENESIS_BASE+'metadata/table',mimeType:'application/json',retrievedAt:'2026-10-24T00:00:00Z',policyReceiptSha256:hash,sourceVersion:null,request:{method:'POST' as const,body:'name=31231-02-01&area=free&language=de',contentType:'application/x-www-form-urlencoded;charset=UTF-8'}};
 const worker=StructuredWorkerRequestSchema.parse({version:'district-structured-worker-v1',operation:'discover',adapter:'genesis',options:{},scope:selector.scope,cursor:null,snapshot,inputArtifactSha256:snapshot.sourceSha256,auxiliary:[]});
 const discovered=genesisAdapter.discover({...snapshot,bytes},selector.scope,null),output={version:'district-structured-worker-v1',requestSha256:semanticHash(worker),adapterId:'regionalstatistik-genesis',adapterVersion:GENESIS_VERSION,result:discovered,page:null};return {worker,output};
}
test('sandbox reply gate matches all nine exact municipal requests and rejects district/table/binding/extra reference changes',()=>{
 for(let index=0;index<9;index++){const {worker,output}=reply(index);assert.equal(checkGenesisMetadataReply(worker,JSON.stringify(output)).body,genesisDataSelectors()[index].request.body);}
 for(const args of [[0,'Kreise','31231-02-01'],[0,'Gemeinden','12411-06-01']] as const){const {worker,output}=reply(args[0],args[1],args[2]);assert.throws(()=>checkGenesisMetadataReply(worker,JSON.stringify(output)));}
 const {worker,output}=reply();assert.throws(()=>checkGenesisMetadataReply(worker,JSON.stringify({...output,requestSha256:digest('another synthetic request')})));
 assert.throws(()=>checkGenesisMetadataReply(worker,JSON.stringify({...output,result:{...output.result,resources:[...output.result.resources,...output.result.resources]}})));
 const altered=structuredClone(output);altered.result.resources[0].body+='&unapproved=1';assert.throws(()=>checkGenesisMetadataReply(worker,JSON.stringify(altered)));
});
test('durable custody refuses concurrent operations, phase reuse, unreviewed data budget and explicit stop without dispatch',async t=>{
 const root=await temporary(t),record=release(root),path=join(root,'synthetic-unit-release.json'),bytes=JSON.stringify(record);await writeFile(path,bytes);const pin={path,sha256:digest(bytes)};
 await withGenesisOperation(record,pin,async()=>{await assert.rejects(withGenesisOperation(record,pin,async()=>{}),/EEXIST/u);});
 const action=genesisRequestPlan().requests.find(row=>row.phase==='genesis_metadata')!,custody=await GenesisWireCustody.open(record,pin,'preflight');await custody.begin(action);await custody.wire.beforeRequest(action.url,wireFor(action));await custody.wire.onResponseChunk(action.url,16);await custody.wire.onWireAttemptResult(action.url,200,null);await custody.finish({synthetic:true});const budget=custody.snapshot();await custody.close();assert.equal(budget.attempts,1);assert.equal(budget.bytes,16);
 await assert.rejects(GenesisWireCustody.open(record,pin,'preflight'),/EEXIST/u);await assert.rejects(GenesisWireCustody.open(record,pin,'data'),/inherit/u);
 const inherited=await GenesisWireCustody.open(record,pin,'data',budget);assert.equal(inherited.snapshot().attempts,1);assert.equal(inherited.snapshot().bytes,16);await writeFile(join(inherited.root,'STOP'),'synthetic stop');await assert.rejects(inherited.begin(request),/stop/u);await inherited.close();
 const lines=(await readFile(join(root,pin.sha256,'preflight.journal.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));let previous='';for(const event of lines){const {sha256,...payload}=event;assert.equal(payload.previous,previous);assert.equal(sha256,semanticHash(payload));previous=sha256;}
});
test('custody logs the last refused chunk and cannot retry policy URLs or switch a phase to data',async t=>{
 const root=await temporary(t),record=release(root),path=join(root,'synthetic-byte-limit-release.json'),bytes=JSON.stringify(record);await writeFile(path,bytes);const pin={path,sha256:digest(bytes)},custody=await GenesisWireCustody.open(record,pin,'preflight'),action=genesisRequestPlan().requests.find(row=>row.phase==='genesis_metadata')!;
 await assert.rejects(custody.begin(request),/phase/u);await custody.begin(action);await custody.wire.beforeRequest(action.url,wireFor(action));await assert.rejects(custody.wire.onResponseChunk(action.url,action.maxBodyBytes+1),/accounting/u);assert.throws(()=>custody.snapshot(),/stopped/u);await custody.close();
 const lines=(await readFile(join(root,pin.sha256,'preflight.journal.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)),last=lines.at(-1);assert.equal(last.kind,'wire_chunk_refused');assert.equal(last.bytes,action.maxBodyBytes+1);assert.equal(last.totalBytes,action.maxBodyBytes+1);
 const otherRoot=join(root,'policy'),other=release(otherRoot),otherPath=join(root,'synthetic-policy-release.json'),otherBytes=JSON.stringify(other);await writeFile(otherPath,otherBytes);const controller=await GenesisWireCustody.open(other,{path:otherPath,sha256:digest(otherBytes)},'preflight');await controller.begin(action);const policy='https://www.regionalstatistik.de/robots.txt',identity:WireRequestIdentity={method:'GET',body:null,publicOperation:null};await controller.wire.beforeRequest(policy,identity);await controller.wire.onWireAttemptResult(policy,404,'http_404');await assert.rejects(controller.wire.beforeRequest(policy,identity),/retry/u);await controller.stop();await controller.close();
});
test('journal tampering holds before any dispatch',async t=>{
 const root=await temporary(t),record=release(root),path=join(root,'synthetic-journal-release.json'),bytes=JSON.stringify(record);await writeFile(path,bytes);const pin={path,sha256:digest(bytes)},custody=await GenesisWireCustody.open(record,pin,'preflight');await writeFile(join(root,pin.sha256,'preflight.journal.jsonl'),'synthetic tamper');
 await assert.rejects(custody.begin(genesisRequestPlan().requests.find(row=>row.phase==='genesis_metadata')!),/journal/u);await custody.close();
});
test('all effectful commands refuse a genuinely committed DRAFT before credentials, parser, DB, source state or HTTP',async t=>{
 const root=await temporary(t),approvals=join(root,'stadtstack-data/reports/approvals');await mkdir(approvals,{recursive:true});const fixture=release(join(root,'must-not-exist')),record:Record<string,unknown>={...fixture,status:'DRAFT',issuedAt:'',approvedBy:null,sourceFetchStopLifted:false};for(const key of ['validFrom','expiresAt','reviewEvidence','parserAuthorization','registryDescriptor'])delete record[key];record.requiredIssuanceEvidence=['synthetic unit draft'];GenesisReleaseDraftSchema.parse(record);
 const path=join(approvals,'synthetic-draft.json'),bytes=JSON.stringify(record);await writeFile(path,bytes);execFileSync('/usr/bin/git',['init','--quiet',root]);execFileSync('/usr/bin/git',['-C',root,'add','stadtstack-data/reports/approvals/synthetic-draft.json']);execFileSync('/usr/bin/git',['-C',root,'-c','user.name=Synthetic unit fixture','-c','user.email=fixture@invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic unissued fixture, not authority']);const pin={path,sha256:digest(bytes)};
 for(const action of [()=>genesisPreflight(pin,root),()=>genesisMetadataReviewDraft(pin,root),()=>genesisEnqueue(pin,root,pin),()=>genesisAcquire(pin,root,pin,randomUUID())])await assert.rejects(action());
 await assert.rejects(lstat(fixture.executionRoot),{code:'ENOENT'});
});
test('trusted Core hooks preserve native admission and request cap while strengthening pacing/redirects',async t=>{
 const fixture=await createCivicPolicyTestContext(t),selector=genesisDataSelectors()[0],order:string[]=[],job={id:randomUUID(),jobKey:hash,spec:{step:'acquire_representation',lane:'acquisition',semanticContractSha256:hash,inputArtifactHashes:[],sourceScope:selector.scope,selector,policyProofSha256:null},attempt:1,fencingToken:'1',runId:randomUUID(),enqueuedAt:new Date().toISOString(),startedAt:new Date().toISOString(),leaseExpiresAt:new Date(Date.now()+60000).toISOString(),dependencyReceiptIds:[],category:'development' as const};
 const store={pool:{query:async(sql:string)=>{if(sql.startsWith('INSERT')){order.push('native-configuration');return {rows:[{normalized_host:'*',shared_service_group:'r1-public-acquisition',max_in_flight:1,min_start_interval_ms:2500}],rowCount:1};}order.push('native-timing');return {rows:[{paused_reason:null,wait_ms:'0'}],rowCount:1};}}} as unknown as DistrictJobStore;
 const context:JobHandlerContext={job,signal:new AbortController().signal,cas:new DistrictCas(join(fixture.root,'cas')),acquireHostLane:async()=>{order.push('native-lane');}},wire={minDelayMs:5000,beforeRequest:async(_url:string,identity:WireRequestIdentity)=>{assert.deepEqual(identity,wireFor(request));order.push('controller');},onResponseChunk:async()=>{order.push('chunk');},onWireAttemptResult:async()=>{order.push('settled');}};
 const fetcher=await createR1PublicFetcher(store,context,{maxRequests:1,maxBytes:4096,fixture:{fetchRoot:join(fixture.root,'fetch'),policy:fixture.policy},wire});assert.equal(fetcher.options.minDelayMs,5000);assert.equal(fetcher.options.maxRedirects,0);
 const hooks=fetcher as unknown as {beforeRequest:(url:string,identity:WireRequestIdentity)=>Promise<void>;onResponseChunk:(url:string,bytes:number)=>Promise<void>;onWireAttemptResult:(url:string,status:number|null,failure:string|null)=>Promise<void>};await hooks.beforeRequest(request.url,wireFor(request));assert.deepEqual(order,['native-configuration','native-timing','native-lane','controller']);await assert.rejects(hooks.beforeRequest(request.url,wireFor(request)));assert.equal(order.length,4);await hooks.onResponseChunk(request.url,1);await hooks.onWireAttemptResult(request.url,200,null);assert.deepEqual(order.slice(-2),['chunk','settled']);
 await assert.rejects(createR1PublicFetcher(store,context,{maxRequests:1,maxBytes:4096,fixture:{fetchRoot:join(fixture.root,'fetch'),policy:fixture.policy},wire:{...wire,minDelayMs:NaN}}),/spacing/u);
});
test('native existing-owner child retains all controller hooks without a credential read or request',async t=>{
 const fixture=await createCivicPolicyTestContext(t),events:string[]=[];
 const prototype=PoliteFetcher.prototype as unknown as {fetchInternal(url:string):Promise<FetchedDocument>};
 t.mock.method(prototype,'fetchInternal',async function(this:PoliteFetcher,url:string):Promise<FetchedDocument>{
  assert(this.cacheDir.endsWith('-genesis-owner-account'));
  const hooks=this as unknown as {beforeRequest:(url:string,identity:WireRequestIdentity)=>Promise<void>;onResponseChunk:(url:string,bytes:number)=>Promise<void>;onWireAttemptResult:(url:string,status:number|null,failure:string|null)=>Promise<void>};
  await hooks.beforeRequest(url,wireFor(request));await hooks.onResponseChunk(url,8);await hooks.onWireAttemptResult(url,200,null);
  return {url,sha256:hash,localPath:join(fixture.root,'synthetic-no-body-read'),mimeType:'application/json',retrievedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),status:200,observationPath:join(fixture.root,'synthetic-no-observation')};
 });
 const fetcher=new PoliteFetcher({cacheDir:join(fixture.root,'owner-hooks'),ownerPolicyLane:{...fixture.policy,decisionId:fixture.decisionId},beforeRequest:async(url,identity)=>{assertGenesisWireIdentity(url,identity,request);events.push('admission');},onResponseChunk:async()=>{events.push('chunk');},onWireAttemptResult:async()=>{events.push('settled');}});
 await fetcher.fetch(request.url,{method:'POST',body:request.body!,publicOperation:'genesis_guest'});assert.deepEqual(events,['admission','chunk','settled']);
});
