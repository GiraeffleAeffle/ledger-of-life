import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {R2AcquisitionExecutor,R2ExecutorError,type R2ManifestItem} from '../src/r2-acquisition-executor.ts';
import {PoliteFetcher,sourceContentBinding} from '../src/polite-fetch.ts';
import {readBoundSourceObservation} from '../src/source-observation.ts';
import {politeTestOptions} from './fixtures/polite-lane.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import type {FetchObservation,FetchedDocument,PoliteFetcherOptions,WireRequestIdentity} from '../src/polite-fetch.ts';
import {REVIEWED_REGISTERED_ROBOTS_SCOPES} from '../src/registered-source-policy.ts';
import {assertR2ReferencesReleased} from '../src/r2-acquisition-integrity.ts';
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const draft=JSON.parse(await readFile(new URL('../reports/r2-district-source-fetch-security-release-v3.draft.json',import.meta.url),'utf8')) as Record<string,unknown>;
const sourcePriority:Readonly<Record<string,number>>={council:0,gazette:1,participation:2,website:3,structured:4};
function manifestRows(duplicateUrl=false):R2ManifestItem[]{const rows=draft.exactDocumentRequestAllowlist as Array<{url:string;candidateBindings:Array<{municipalityId:string;sourceId:string}>}>;return rows.map(row=>{const bindings=row.candidateBindings.map(binding=>{const scope=REVIEWED_REGISTERED_ROBOTS_SCOPES.find(candidate=>candidate.municipalityId===binding.municipalityId&&candidate.sourceId===binding.sourceId);assert.ok(scope,`missing frozen test source ${binding.sourceId}`);return {url:row.url,sourceId:binding.sourceId,scope:{municipalityId:binding.municipalityId,sourceId:binding.sourceId,ags:scope.ags},priority:sourcePriority[scope.kind]??99};}).sort((a,b)=>a.priority-b.priority||a.sourceId.localeCompare(b.sourceId));const {priority:_rank,...chosen}=bindings[0]!;return chosen;}).flatMap(item=>duplicateUrl&&item.url===rows[0]!.url?[item,item]:[item]);}
type ExecutorFixture={recordPath:string;recordSha256:string;manifestPath:string;manifest:R2ManifestItem[];manifestSha256:string;r1DigestInventoryPath:string;r1DigestInventorySha256:string;fetcherOptions:PoliteFetcherOptions;journalPath:string;stopFile:string};
async function options(root:string,issued:boolean,priorR1:Readonly<Record<string,string>>={},duplicateUrl=false):Promise<ExecutorFixture>{const manifest=manifestRows(duplicateUrl),manifestBytes=Buffer.from(JSON.stringify(manifest)),manifestPath=join(root,'manifest.json');await writeFile(manifestPath,manifestBytes);const urls=[...new Set(manifest.map(item=>item.url))],inventory={schemaVersion:'r2-r1-digest-inventory-v1',entries:urls.map(url=>({url,sourceIds:[...new Set(manifest.filter(item=>item.url===url).map(item=>item.sourceId))],sha256:priorR1[url]??null}))},inventoryBytes=Buffer.from(JSON.stringify(inventory)),r1DigestInventoryPath=join(root,'r1-digest-inventory.json');await writeFile(r1DigestInventoryPath,inventoryBytes);const approval={schemaVersion:'stadtstack-r1-owner-approval-record-v1',approved:{acquisition:{manifest:{sha256:sha(manifestBytes)}}}},approvalBytes=Buffer.from(JSON.stringify(approval)),approvalRecordPath=join(root,'owner-approval.json');await writeFile(approvalRecordPath,approvalBytes);const record={...draft,...(issued?{status:'ISSUED',issuedAt:new Date().toISOString(),approver:'fixture reviewer',sourceFetchStopLifted:true,validFrom:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),ownerApprovalReference:{sha256:sha(manifestBytes),approvalRecordPath,approvalRecordSha256:sha(approvalBytes)},r1DigestInventoryReference:{sha256:sha(inventoryBytes)}}:{})},recordBytes=Buffer.from(JSON.stringify(record));await writeFile(join(root,'release.json'),recordBytes);return {recordPath:join(root,'release.json'),recordSha256:sha(recordBytes),manifestPath,manifest,manifestSha256:sha(manifestBytes),r1DigestInventoryPath,r1DigestInventorySha256:sha(inventoryBytes),fetcherOptions:{cacheDir:join(root,'cache')},journalPath:join(root,'progress.jsonl'),stopFile:join(root,'STOP')};}
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`:JSON.stringify(value);
function journalState(input:ExecutorFixture,overrides:Record<string,unknown>={}){return {schemaVersion:'r2-acquisition-progress-v4',sequence:0,previousRecordHash:null,recordHash:'',recordSha256:input.recordSha256,manifestSha256:input.manifestSha256,startedAt:new Date().toISOString(),attempts:[],completed:{},quarantined:{},appliedChangedReleases:[],retainedBytes:0,wireBytes:0,documentsSinceReview:0,paused:false,stopped:false,checkpoint:null,consumedReviews:[],...overrides};}
async function writeJournal(path:string,state:Record<string,unknown>){const payload:Record<string,unknown>={...state,sequence:1,previousRecordHash:null};delete payload['recordHash'];const row={...payload,recordHash:sha(canonical(payload))};await writeFile(path,JSON.stringify(row)+'\n');return row;}

test('R2 executor refuses the draft without issuing or lifting the stop',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-draft-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=await options(root,false);
 await assert.rejects(R2AcquisitionExecutor.open(input),error=>error instanceof R2ExecutorError&&error.code==='RELEASE_INVALID');
});
test('R2 executor refuses a manifest with duplicate URL bindings',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-duplicate-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=await options(root,true,{},true);
 await assert.rejects(R2AcquisitionExecutor.open(input),error=>error instanceof R2ExecutorError&&error.code==='MANIFEST_DUPLICATE_URL');
});

test('R2 executor binds raw issued record and manifest bytes and honors the stop file before networking',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-stop-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=await options(root,true);await writeFile(input.stopFile,'stop\n');
 const executor=await R2AcquisitionExecutor.open(input);
 await assert.rejects(executor.run(),error=>error instanceof R2ExecutorError&&error.code==='STOP_FILE');
 const journal=(await readFile(input.journalPath,'utf8')).trimEnd().split('\n').map(row=>JSON.parse(row));
 assert.equal(journal.at(-1).stopped,true);assert.equal(journal.at(-1).attempts.length,0);
});

test('R2 executor stops before request and wire-byte budget overflow',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=await options(root,true),executor=await R2AcquisitionExecutor.open(input);
 type BudgetJournal={attempts:Array<{url:string;startedAt:string;bytes:number;status:number|null;failure:string|null;state:'started'|'succeeded'|'failed'}>;wireBytes:number;[key:string]:unknown};
 type ExecutorInternals={current:BudgetJournal;beforeRequest(url:string):Promise<void>;onChunk(url:string,bytes:number):Promise<void>};
 const docUrl=input.manifest[0]!.url,policyUrl=(draft.exactPolicyRequestAllowlist as Array<{url:string}>)[0]!.url;
 const seam=executor as unknown as ExecutorInternals,seamJournal=journalState(input) as BudgetJournal;seam.current=seamJournal;
 seamJournal.attempts=Array.from({length:1200},()=>({url:docUrl,startedAt:new Date().toISOString(),bytes:0,status:200,failure:null,state:'succeeded'}));
 await assert.rejects(seam.beforeRequest(docUrl),error=>error instanceof R2ExecutorError&&error.code==='REQUEST_BUDGET');
 const policyExecutor=await R2AcquisitionExecutor.open({...input,journalPath:join(root,'policy-progress.jsonl')}),policySeam=policyExecutor as unknown as ExecutorInternals,policyJournal=journalState(input) as BudgetJournal;policySeam.current=policyJournal;
 policyJournal.attempts=Array.from({length:1200},()=>({url:policyUrl,startedAt:new Date().toISOString(),bytes:0,status:200,failure:null,state:'succeeded'}));
 await assert.rejects(policySeam.beforeRequest(policyUrl),error=>error instanceof R2ExecutorError&&error.code==='REQUEST_BUDGET');
 const bodyExecutor=await R2AcquisitionExecutor.open({...input,journalPath:join(root,'body-progress.jsonl')}),bodySeam=bodyExecutor as unknown as ExecutorInternals,bodyJournal=journalState(input) as BudgetJournal;bodySeam.current=bodyJournal;
 bodyJournal.attempts=[{url:docUrl,startedAt:new Date().toISOString(),bytes:25_165_823,status:200,failure:null,state:'succeeded'}];bodyJournal.wireBytes=25_165_823;
 await assert.rejects(bodySeam.onChunk(docUrl,2),error=>error instanceof R2ExecutorError&&error.code==='BODY_BUDGET');
 const policyBodyExecutor=await R2AcquisitionExecutor.open({...input,journalPath:join(root,'policy-body-progress.jsonl')}),policyBodySeam=policyBodyExecutor as unknown as ExecutorInternals,policyBodyJournal=journalState(input) as BudgetJournal;policyBodySeam.current=policyBodyJournal;
 policyBodyJournal.attempts=[{url:policyUrl,startedAt:new Date().toISOString(),bytes:25_165_823,status:200,failure:null,state:'succeeded'}];policyBodyJournal.wireBytes=25_165_823;
 await assert.rejects(policyBodySeam.onChunk(policyUrl,2),error=>error instanceof R2ExecutorError&&error.code==='BODY_BUDGET');
 const totalExecutor=await R2AcquisitionExecutor.open({...input,journalPath:join(root,'total-progress.jsonl')}),totalSeam=totalExecutor as unknown as ExecutorInternals,totalJournal=journalState(input) as BudgetJournal;totalSeam.current=totalJournal;
 totalJournal.attempts=Array.from({length:107},()=>({url:docUrl,startedAt:new Date().toISOString(),bytes:25_000_000,status:200,failure:null,state:'succeeded'}));totalJournal.attempts.push({url:docUrl,startedAt:new Date().toISOString(),bytes:0,status:200,failure:null,state:'succeeded'});totalJournal.wireBytes=2_684_354_559;
 await assert.rejects(totalSeam.onChunk(docUrl,2),error=>error instanceof R2ExecutorError&&error.code==='WIRE_BUDGET');
 const elapsedExecutor=await R2AcquisitionExecutor.open({...input,journalPath:join(root,'elapsed-progress.jsonl')});await writeJournal(join(root,'elapsed-progress.jsonl'),journalState(input,{startedAt:new Date(Date.now()-57_600_001).toISOString()}));
 await assert.rejects(elapsedExecutor.run(),error=>error instanceof R2ExecutorError&&error.code==='TIME_BUDGET');
 const documentPath=join(root,'document-progress.jsonl'),documentExecutor=await R2AcquisitionExecutor.open({...input,journalPath:documentPath});
 await writeJournal(documentPath,journalState(input,{completed:Object.fromEntries(Array.from({length:250},(_,index)=>[`completed-${index}`,{sha256:'0'.repeat(64),bytes:0,localPath:'',sourceId:'fixture'}]))}));
 await assert.rejects(documentExecutor.run(),error=>error instanceof R2ExecutorError&&error.code==='DOCUMENT_BUDGET');
 const retainedPathJournal=join(root,'retained-progress.jsonl'),retainedExecutor=await R2AcquisitionExecutor.open({...input,journalPath:retainedPathJournal}),retainedPath=join(root,'retained.html'),retainedBody=Buffer.from('x');await writeFile(retainedPath,retainedBody);
 await writeJournal(retainedPathJournal,journalState(input,{completed:{'already-retained':{sha256:'0'.repeat(64),bytes:2_684_354_560,localPath:'fixture',sourceId:'fixture'}},retainedBytes:2_684_354_560}));
 const retainedFetcher=(retainedExecutor as unknown as {fetcher:PoliteFetcher}).fetcher,retainedMock=t.mock.method(retainedFetcher,'fetch',async(url:string):Promise<FetchedDocument>=>({url,sha256:sha(retainedBody),localPath:retainedPath,mimeType:'text/html',retrievedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),status:200,observationPath:retainedPath}));
 await assert.rejects(retainedExecutor.run(),error=>error instanceof R2ExecutorError&&error.code==='RETAINED_BYTE_BUDGET');retainedMock.mock.restore();
 const htmlExecutor=await R2AcquisitionExecutor.open({...input,journalPath:join(root,'html-progress.jsonl')}),htmlFetcher=(htmlExecutor as unknown as {fetcher:PoliteFetcher}).fetcher,htmlBody=Buffer.alloc(2_097_153),htmlPath=join(root,'oversized.html');await writeFile(htmlPath,htmlBody);
 const htmlMock=t.mock.method(htmlFetcher,'fetch',async(url:string):Promise<FetchedDocument>=>({url,sha256:sha(htmlBody),localPath:htmlPath,mimeType:'text/html',retrievedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),status:200,observationPath:htmlPath}));
 await assert.rejects(htmlExecutor.run(),error=>error instanceof R2ExecutorError&&error.code==='HTML_BUDGET');htmlMock.mock.restore();
});

test('R2 executor refuses an off-list redirect before dispatch to localhost fixture',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-redirect-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=createServer((request,response)=>{if(request.url==='/robots.txt'){response.writeHead(200,{'content-type':'text/plain'});response.end('User-agent: *\nAllow: /\n');return;}if(request.url==='/.well-known/tdmrep.json'){response.writeHead(404);response.end();return;}response.writeHead(302,{location:'/not-listed'});response.end();});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());}));
 const address=server.address();assert.ok(address&&typeof address==='object');
 const input=await options(root,true);input.fetcherOptions=await politeTestOptions({cacheDir:join(root,'cache'),fixtureInspection:fixturePolicyInspection});
 interface FixtureWire {
  hostStateDirectory():string;
  scheduled<T>(url:URL,request:WireRequestIdentity,work:(state:unknown)=>Promise<T>,onResult?:(result:T,state:unknown)=>void):Promise<T>;
  wireRequest(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined,pinned:{address:string;family:number},headers:Record<string,string>,onRefusedHeaders?:unknown,accountingUrl?:string):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>;
  onWireAttemptResult(url:string,status:number|null,failure:string|null):Promise<void>;
 }
 const requests:string[]=[];
 const hostLane=t.mock.method(PoliteFetcher.prototype as unknown as FixtureWire,'hostStateDirectory',()=>join(root,'host-lanes'));
 const patch=t.mock.method(PoliteFetcher.prototype as unknown as {wire:(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined)=>Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>},'wire',async function(this:FixtureWire,url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined){
  const fixtureUrl=new URL(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`);
  return this.scheduled(url,{method,body:body??null,publicOperation:null},async()=>{requests.push(url.href);const response=await this.wireRequest(fixtureUrl,method,body,validators,{address:'127.0.0.1',family:4},{},undefined,url.href);await this.onWireAttemptResult(url.href,response.status,response.status>=400?`http_${response.status}`:null);return response;});
 });
 t.after(()=>{patch.mock.restore();hostLane.mock.restore();});
 const executor=await R2AcquisitionExecutor.open(input);
 await assert.rejects(executor.run(),error=>error instanceof R2ExecutorError&&error.code==='URL_NOT_ALLOWLISTED');
 const allowed=new URL(input.manifest[0]!.url),offList=[new URL(`${allowed.pathname}/other`,allowed),new URL(`${allowed.href}?extra=1`),new URL(allowed.href.replace(allowed.hostname,'www.'+allowed.hostname))];
 // Test the executor's private admission hook directly to prove exact URL matching without another wire.
 interface AdmissionSeam{beforeRequest(url:string):Promise<void>}
 const admission=executor as unknown as AdmissionSeam;
 for(const url of offList)await assert.rejects(admission.beforeRequest(url.href),error=>error instanceof R2ExecutorError&&error.code==='URL_NOT_ALLOWLISTED');
 const journal=(await readFile(input.journalPath,'utf8')).trimEnd().split('\n').map(row=>JSON.parse(row));
 assert.deepEqual(journal.at(-1).attempts.map((row:{url:string})=>new URL(row.url).pathname),['/robots.txt','/.well-known/tdmrep.json',new URL(manifestRows()[0]!.url).pathname]);
 assert.deepEqual(journal.at(-1).attempts.map((row:{status:number|null;failure:string|null;state:string})=>[row.status,row.failure,row.state]),[[200,null,'succeeded'],[404,'http_404','failed'],[302,null,'succeeded']]);
});
test('R2 fetch persists record-derived integrity through managed CAS and bound preparation reads',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-provenance-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=createServer((request,response)=>{if(request.url==='/robots.txt'){response.writeHead(200,{'content-type':'text/plain'});response.end('User-agent: *\nAllow: /\n');return;}if(request.url==='/.well-known/tdmrep.json'){response.writeHead(404);response.end();return;}response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end('<!doctype html><html><body><p>Fixture civic source</p></body></html>');});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());}));
 const address=server.address();assert.ok(address&&typeof address==='object');
 const input=await options(root,true),policyOptions=await politeTestOptions({cacheDir:join(root,'cache'),fixtureInspection:fixturePolicyInspection});input.fetcherOptions=policyOptions;
 interface HostLaneFixture{hostStateDirectory():string}
 const hostLane=t.mock.method(PoliteFetcher.prototype as unknown as HostLaneFixture,'hostStateDirectory',()=>join(root,'host-lanes'));
 t.after(()=>hostLane.mock.restore());
 interface ExecutorInternals{documents:Map<string,R2ManifestItem>;fetcher:PoliteFetcher}
 const executor=await R2AcquisitionExecutor.open(input),internals=executor as unknown as ExecutorInternals,item=input.manifest[0]!,url=item.url;internals.documents.clear();internals.documents.set(url,item);
 interface FixtureWire {
  scheduled<T>(url:URL,request:WireRequestIdentity,work:(state:unknown)=>Promise<T>,onResult?:(result:T,state:unknown)=>void):Promise<T>;
  wireRequest(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined,pinned:{address:string;family:number},headers:Record<string,string>,onRefusedHeaders?:unknown,accountingUrl?:string):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>;
  onWireAttemptResult(url:string,status:number|null,failure:string|null):Promise<void>;
 }
 const patch=t.mock.method(PoliteFetcher.prototype as unknown as {wire:(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined)=>Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>},'wire',async function(this:FixtureWire,requestUrl:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined){
  const fixtureUrl=new URL(`http://127.0.0.1:${address.port}${requestUrl.pathname}${requestUrl.search}`);
  return this.scheduled(requestUrl,{method,body:body??null,publicOperation:null},async()=>{const response=await this.wireRequest(fixtureUrl,method,body,validators,{address:'127.0.0.1',family:4},{},undefined,requestUrl.href);await this.onWireAttemptResult(requestUrl.href,response.status,response.status>=400?`http_${response.status}`:null);return response;});
 });
 t.after(()=>patch.mock.restore());
 const original=internals.fetcher.fetch.bind(internals.fetcher),fetched:FetchedDocument[]=[],capture=t.mock.method(internals.fetcher,'fetch',async(...args:Parameters<PoliteFetcher['fetch']>)=>{const document=await original(...args);fetched.push(document);return document;});
 const run=await executor.run();assert.equal(run.completed,1);assert.equal(fetched.length,1);
 const document=fetched[0]!,guard=document.r2Integrity;assert.ok(guard);assert.equal(guard.recordSha256,input.recordSha256);assert.equal(guard.manifestSha256,input.manifestSha256);assert.equal(guard.journalPath,input.journalPath);
 const checked=await (internals.fetcher as unknown as {checkedSourceBindings(bindings:ReturnType<typeof sourceContentBinding>[]):Promise<Array<{r2Integrity?:typeof guard}>>}).checkedSourceBindings([sourceContentBinding({...document,r2Integrity:undefined})]);
 assert.deepEqual(checked[0]?.r2Integrity,guard);
 const bound=await readBoundSourceObservation({rawRoot:input.fetcherOptions.cacheDir,document:{url:document.url,sha256:document.sha256,mimeType:document.mimeType,retrievedAt:document.retrievedAt,checkedAt:document.checkedAt,status:document.status,observationPath:document.observationPath},policy:input.fetcherOptions.ownerPolicyLane});
 assert.deepEqual(bound.binding.r2Integrity,guard);
 await assertR2ReferencesReleased([{id:item.sourceId,url:document.url,sha256:document.sha256}],bound.binding.r2Integrity);
 await assert.rejects(assertR2ReferencesReleased([{id:'caller-injected-source',url:document.url,sha256:document.sha256}],bound.binding.r2Integrity));
 await assert.rejects(readBoundSourceObservation({rawRoot:input.fetcherOptions.cacheDir,document:{url:document.url,sha256:document.sha256,mimeType:document.mimeType,retrievedAt:document.retrievedAt,checkedAt:document.checkedAt,status:document.status,observationPath:document.observationPath},policy:{...input.fetcherOptions.ownerPolicyLane,r2Integrity:{...guard,recordSha256:'0'.repeat(64)}}}));
 capture.mock.restore();
});

test('R2 executor pauses after ten and quarantines changed R1 bytes without release',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-review-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=await options(root,true),body=Buffer.from('<html>fixture</html>'),bodyPath=join(root,'body.html');await writeFile(bodyPath,body);
 const executor=await R2AcquisitionExecutor.open(input),fetcher=(executor as unknown as {fetcher:PoliteFetcher}).fetcher,calls:string[]=[];
 const fetchMock=t.mock.method(fetcher,'fetch',async(url:string):Promise<FetchedDocument>=>{calls.push(url);return {url,sha256:sha(body),localPath:bodyPath,mimeType:'text/html',retrievedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),status:200,observationPath:bodyPath};});
 const batch=await executor.run();assert.equal(batch.completed,10);assert.equal(batch.paused,true);assert.equal(calls.length,10);
 assert.equal((await executor.run()).paused,true);assert.equal(calls.length,10);fetchMock.mock.restore();
 const changedRoot=join(root,'changed');await mkdir(changedRoot,{mode:0o700});
 const changedUrl=manifestRows()[0]!.url,changedInput=await options(changedRoot,true,{[changedUrl]:'0'.repeat(64)});changedInput.fetcherOptions=await politeTestOptions({cacheDir:join(changedRoot,'cache'),fixtureInspection:fixturePolicyInspection});const changedExecutor=await R2AcquisitionExecutor.open(changedInput),changedFetcher=(changedExecutor as unknown as {fetcher:PoliteFetcher}).fetcher,checkedAt=new Date().toISOString(),newSha256=sha(body),changedObservation:FetchObservation={url:changedUrl,method:'GET',checkedAt,retrievedAt:checkedAt,state:'fetched',status:200,sha256:newSha256,bytes:body.length,mimeType:'text/html',policy:{robots:{state:'allowed',url:new URL('/robots.txt',changedUrl).href,checkedAt},tdm:{state:'not_reserved',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
 const changedMock=t.mock.method(changedFetcher,'fetch',async(url:string):Promise<FetchedDocument>=>{await (changedExecutor as unknown as {onValidatedRepresentation(url:string,body:Buffer,observation:FetchObservation):Promise<void>}).onValidatedRepresentation(url,body,changedObservation);throw new Error('validated changed representation unexpectedly admitted');});
 await assert.rejects(changedExecutor.run(),error=>error instanceof R2ExecutorError&&error.code==='CHANGED_SINCE_R1');
 const changedState=changedExecutor as unknown as {current:{attempts:Array<{url:string;startedAt:string;bytes:number;status:number|null;failure:string|null;state:'started'|'succeeded'|'failed'}>;wireBytes:number};save():Promise<void>};changedState.current.attempts.push({url:changedUrl,startedAt:new Date().toISOString(),bytes:body.length,status:200,failure:null,state:'succeeded'});changedState.current.wireBytes+=body.length;await changedState.save();
 assert.equal((await changedExecutor.run()).paused,true);
 const sourceId=changedInput.manifest[0]!.sourceId,r1Sha256='0'.repeat(64),baseRelease={schemaVersion:'r2-changed-source-release-v1',id:'r2-changed-source-release',reviewedBy:'fixture reviewer',reviewedAt:new Date().toISOString(),reason:'Independent fixture review',representations:[{url:changedUrl,sourceId,sha256:newSha256,r1Sha256}]};
 await assert.rejects(assertR2ReferencesReleased([{id:sourceId,url:changedUrl,sha256:newSha256}],{journalPath:changedInput.journalPath,recordSha256:changedInput.recordSha256,manifestSha256:changedInput.manifestSha256}));
 for(const [index,representation] of [{...baseRelease.representations[0],url:changedUrl+'?different=1'},{...baseRelease.representations[0],sourceId:'wrong-source'},{...baseRelease.representations[0],sha256:'1'.repeat(64)},{...baseRelease.representations[0],r1Sha256:'2'.repeat(64)}].entries()){
  const release={...baseRelease,representations:[representation]},releasePath=join(changedRoot,`release-${index}.json`),releaseBytes=Buffer.from(JSON.stringify(release));await writeFile(releasePath,releaseBytes);
  const refused=await R2AcquisitionExecutor.open({...changedInput,changedReleasePath:releasePath,changedReleaseSha256:sha(releaseBytes)});
  await assert.rejects(refused.run(),error=>error instanceof R2ExecutorError&&error.code==='CHANGED_RELEASE_MISMATCH');
 }
 const releaseBytes=Buffer.from(JSON.stringify(baseRelease)),releasePath=join(changedRoot,'exact-release.json');await writeFile(releasePath,releaseBytes);
 const released=await R2AcquisitionExecutor.open({...changedInput,changedReleasePath:releasePath,changedReleaseSha256:sha(releaseBytes)}),promotedRun=await released.run();assert.equal(promotedRun.paused,true);assert.equal(promotedRun.completed,1);
 const heldJournal=JSON.parse((await readFile(changedInput.journalPath,'utf8')).trimEnd().split('\n').at(-1)!) as {checkpoint:{sequence:number;recordHash:string;digestSet:Record<string,string>}};
 assert.equal(heldJournal.checkpoint!==null,true);
 await new Promise(resolveDelay=>setTimeout(resolveDelay,3));
 const resume={schemaVersion:'r2-acquisition-review-v1',releaseSha256:changedInput.recordSha256,manifestSha256:changedInput.manifestSha256,action:'resume',reviewedBy:'fixture reviewer',issuedAt:new Date().toISOString(),checkpointSequence:heldJournal.checkpoint.sequence,checkpointRecordHash:heldJournal.checkpoint.recordHash,digestSetSha256:sha(canonical(heldJournal.checkpoint.digestSet))},resumeBytes=Buffer.from(JSON.stringify(resume)),resumePath=join(changedRoot,'resume-review.json');await writeFile(resumePath,resumeBytes);
 const resumed=await R2AcquisitionExecutor.open({...changedInput,changedReleasePath:releasePath,changedReleaseSha256:sha(releaseBytes),reviewPath:resumePath,reviewSha256:sha(resumeBytes)}),resumedFetcher=(resumed as unknown as {fetcher:PoliteFetcher}).fetcher,releasedCalls:string[]=[],resumedMock=t.mock.method(resumedFetcher,'fetch',async(url:string):Promise<FetchedDocument>=>{releasedCalls.push(url);return {url,sha256:newSha256,localPath:bodyPath,mimeType:'text/html',retrievedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),status:200,observationPath:bodyPath};});
 const releasedRun=await resumed.run();assert.equal(releasedRun.paused,true);assert.equal(releasedRun.completed,10);assert.equal(releasedCalls.length,9);
 const journal=JSON.parse((await readFile(changedInput.journalPath,'utf8')).trimEnd().split('\n').at(-1)!) as {quarantined:Record<string,{reviewed:boolean}>;completed:Record<string,{sha256:string;sourceId:string;observationPath:string;localPath:string}>};
 assert.equal(journal.quarantined[changedUrl]?.reviewed,true);assert.equal(journal.completed[changedUrl]?.sha256,newSha256);changedMock.mock.restore();resumedMock.mock.restore();
 const bound=await readBoundSourceObservation({rawRoot:changedInput.fetcherOptions.cacheDir,document:{url:changedUrl,sha256:newSha256,mimeType:'text/html',retrievedAt:checkedAt,checkedAt,status:200,observationPath:journal.completed[changedUrl]!.observationPath},policy:changedInput.fetcherOptions.ownerPolicyLane});
 assert.deepEqual(Object.keys(bound.binding.r2Integrity??{}).sort(),['journalPath','manifestSha256','recordSha256']);
 const ordinary=Object.entries(journal.completed).find(([url])=>url!==changedUrl)!;await assertR2ReferencesReleased([{id:sourceId,url:changedUrl,sha256:newSha256},{id:ordinary[1].sourceId,url:ordinary[0],sha256:ordinary[1].sha256}],bound.binding.r2Integrity);
 await assert.rejects(assertR2ReferencesReleased([{id:'wrong-source',url:changedUrl,sha256:newSha256}],bound.binding.r2Integrity));
 await assert.rejects(assertR2ReferencesReleased([{id:sourceId,url:changedUrl,sha256:'1'.repeat(64)}],bound.binding.r2Integrity));
});

test('R2 executor resumes a crash only after a checkpoint-bound review and skips completed URLs',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-resume-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const base=await options(root,true),reviewPath=join(root,'review.json'),input=base;
 const body=Buffer.from('<html>resumed</html>'),bodyPath=join(root,'resumed.html');await writeFile(bodyPath,body);
 const firstUrl=input.manifest[0]!.url,journalPath=input.journalPath;
 await writeJournal(journalPath,journalState(input,{attempts:[{url:firstUrl,startedAt:new Date().toISOString(),bytes:0,status:null,failure:null,state:'started'}],completed:{[firstUrl]:{sha256:sha(body),bytes:body.length,localPath:bodyPath,sourceId:input.manifest[0]!.sourceId}},retainedBytes:body.length,documentsSinceReview:1}));
 const crashed=await R2AcquisitionExecutor.open(input),fetcher=(crashed as unknown as {fetcher:PoliteFetcher}).fetcher,calls:string[]=[];
 const fetchMock=t.mock.method(fetcher,'fetch',async(url:string):Promise<FetchedDocument>=>{calls.push(url);return {url,sha256:sha(body),localPath:bodyPath,mimeType:'text/html',retrievedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),status:200,observationPath:bodyPath};});
 assert.equal((await crashed.run()).paused,true);assert.equal(calls.length,0);
 const checkpointJournal=JSON.parse((await readFile(journalPath,'utf8')).trimEnd().split('\n').at(-1)!) as {checkpoint:{sequence:number;recordHash:string;createdAt:string;digestSet:Record<string,string>}};
 // The reviewed timestamp must be strictly later than the fsynced checkpoint and no later than the real wall clock.
 await new Promise(resolveDelay=>setTimeout(resolveDelay,3));
 const review={schemaVersion:'r2-acquisition-review-v1',releaseSha256:input.recordSha256,manifestSha256:input.manifestSha256,action:'resume',reviewedBy:'fixture reviewer',issuedAt:new Date().toISOString(),checkpointSequence:checkpointJournal.checkpoint.sequence,checkpointRecordHash:checkpointJournal.checkpoint.recordHash,digestSetSha256:sha(canonical(checkpointJournal.checkpoint.digestSet))},reviewBytes=Buffer.from(JSON.stringify(review));await writeFile(reviewPath,reviewBytes);
 const resumed=await R2AcquisitionExecutor.open({...base,reviewPath,reviewSha256:sha(reviewBytes)}),resumedFetcher=(resumed as unknown as {fetcher:PoliteFetcher}).fetcher,resumeMock=t.mock.method(resumedFetcher,'fetch',async(url:string):Promise<FetchedDocument>=>{calls.push(url);return {url,sha256:sha(body),localPath:bodyPath,mimeType:'text/html',retrievedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),status:200,observationPath:bodyPath};});
 const continued=await resumed.run();assert.equal(continued.completed,10);assert.equal(continued.paused,true);assert.equal(calls.length,9);assert.equal(calls.includes(firstUrl),false);fetchMock.mock.restore();resumeMock.mock.restore();
});

test('R2 executor excludes a second instance on the same bound journal',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-lock-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=await options(root,true),body=Buffer.from('<html>lock</html>'),bodyPath=join(root,'lock.html');await writeFile(bodyPath,body);
 const first=await R2AcquisitionExecutor.open(input);
 const fetcher=(first as unknown as {fetcher:PoliteFetcher}).fetcher;let enter!:()=>void,unlock!:()=>void,waiting=true;
 const entered=new Promise<void>(resolveEntered=>{enter=resolveEntered}),gate=new Promise<void>(resolveGate=>{unlock=resolveGate});
 const mock=t.mock.method(fetcher,'fetch',async(url:string):Promise<FetchedDocument>=>{if(waiting){waiting=false;enter();await gate;}return {url,sha256:sha(body),localPath:bodyPath,mimeType:'text/html',retrievedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),status:200,observationPath:bodyPath};});
 const active=first.run();await entered;
 const script=`import {pathToFileURL} from 'node:url';const {R2AcquisitionExecutor}=await import(pathToFileURL(process.cwd()+'/src/r2-acquisition-executor.ts'));const executor=await R2AcquisitionExecutor.open(JSON.parse(process.env.R2_EXECUTOR_OPTIONS));executor.fetcher.fetch=async()=>{throw Error('unexpected network seam invocation')};try{await executor.run();console.log('RUN_COMPLETED')}catch(error){console.log(error.code??error.message)}`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,R2_EXECUTOR_OPTIONS:JSON.stringify(input)},stdio:['ignore','pipe','pipe']});
 const outcome=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolveChild,rejectChild)=>{let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);child.once('error',rejectChild);child.once('exit',code=>resolveChild({code,stdout,stderr}));});
 try{assert.equal(outcome.code,0,outcome.stderr);assert.equal(outcome.stdout.trim(),'RUN_LOCKED');}finally{unlock();}
 await active;mock.mock.restore();
});
