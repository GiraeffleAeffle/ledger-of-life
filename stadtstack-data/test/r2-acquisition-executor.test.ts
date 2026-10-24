import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {R2AcquisitionExecutor,R2ExecutorError,type R2ManifestItem} from '../src/r2-acquisition-executor.ts';
import {PoliteFetcher} from '../src/polite-fetch.ts';
import {politeTestOptions} from './fixtures/polite-lane.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import type {FetchObservation,PoliteFetcherOptions} from '../src/polite-fetch.ts';
import {REVIEWED_REGISTERED_ROBOTS_SCOPES} from '../src/registered-source-policy.ts';

const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const draft=JSON.parse(await readFile(new URL('../reports/r2-district-source-fetch-security-release-v3.draft.json',import.meta.url),'utf8')) as Record<string,unknown>;
function manifestRows():R2ManifestItem[]{const rows=draft.exactDocumentRequestAllowlist as Array<{url:string;candidateBindings:Array<{municipalityId:string;sourceId:string}>}>;return rows.flatMap(row=>row.candidateBindings.map(binding=>{const scope=REVIEWED_REGISTERED_ROBOTS_SCOPES.find(candidate=>candidate.municipalityId===binding.municipalityId&&candidate.sourceId===binding.sourceId);assert.ok(scope,`missing frozen test source ${binding.sourceId}`);return {url:row.url,sourceId:binding.sourceId,scope:{municipalityId:binding.municipalityId,sourceId:binding.sourceId,ags:scope.ags}};}));}
async function options(root:string,issued:boolean){const manifest=manifestRows(),manifestBytes=Buffer.from(JSON.stringify(manifest));await writeFile(join(root,'manifest.json'),manifestBytes);const record={...draft,...(issued?{status:'ISSUED',issuedAt:new Date().toISOString(),approver:'fixture reviewer',sourceFetchStopLifted:true,validFrom:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),ownerApprovalReference:{sha256:sha(manifestBytes)}}:{})},recordBytes=Buffer.from(JSON.stringify(record));await writeFile(join(root,'release.json'),recordBytes);return {recordPath:join(root,'release.json'),recordSha256:sha(recordBytes),manifestPath:join(root,'manifest.json'),manifest,manifestSha256:sha(manifestBytes),fetcherOptions:{cacheDir:join(root,'cache')},journalPath:join(root,'progress.jsonl'),stopFile:join(root,'STOP')};}

test('R2 executor refuses the draft without issuing or lifting the stop',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-draft-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=await options(root,false);
 await assert.rejects(R2AcquisitionExecutor.open(input),error=>error instanceof R2ExecutorError&&error.code==='RELEASE_INVALID');
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
 type Journal={attempts:Array<{url:string;startedAt:string;bytes:number;status:number|null;failure:string|null}>;wireBytes:number;[key:string]:unknown};
 type ExecutorInternals={journal:Promise<Journal>;current:Journal;beforeRequest(url:string):Promise<void>;onChunk(url:string,bytes:number):Promise<void>};
 const seam=executor as unknown as ExecutorInternals,seamJournal=await seam.journal;seam.current=seamJournal;
 const docUrl=input.manifest[0]!.url,policyUrl=(draft.exactPolicyRequestAllowlist as Array<{url:string}>)[0]!.url;
 seamJournal.attempts=Array.from({length:600},()=>({url:docUrl,startedAt:new Date().toISOString(),bytes:0,status:null,failure:null}));
 await assert.rejects(seam.beforeRequest(docUrl),error=>error instanceof R2ExecutorError&&error.code==='REQUEST_BUDGET');
 const policyExecutor=await R2AcquisitionExecutor.open({...input,journalPath:join(root,'policy-progress.jsonl')}),policySeam=policyExecutor as unknown as ExecutorInternals,policyJournal=await policySeam.journal;policySeam.current=policyJournal;
 policyJournal.attempts=Array.from({length:22},()=>({url:policyUrl,startedAt:new Date().toISOString(),bytes:0,status:null,failure:null}));
 await assert.rejects(policySeam.beforeRequest(policyUrl),error=>error instanceof R2ExecutorError&&error.code==='POLICY_REQUEST_BUDGET');
 const bodyExecutor=await R2AcquisitionExecutor.open({...input,journalPath:join(root,'body-progress.jsonl')}),bodySeam=bodyExecutor as unknown as ExecutorInternals,bodyJournal=await bodySeam.journal;bodySeam.current=bodyJournal;
 bodyJournal.attempts=[{url:docUrl,startedAt:new Date().toISOString(),bytes:25_165_823,status:200,failure:null}];bodyJournal.wireBytes=25_165_823;
 await assert.rejects(bodySeam.onChunk(docUrl,2),error=>error instanceof R2ExecutorError&&error.code==='BODY_BUDGET');
 const policyBodyExecutor=await R2AcquisitionExecutor.open({...input,journalPath:join(root,'policy-body-progress.jsonl')}),policyBodySeam=policyBodyExecutor as unknown as ExecutorInternals,policyBodyJournal=await policyBodySeam.journal;policyBodySeam.current=policyBodyJournal;
 policyBodyJournal.attempts=[{url:policyUrl,startedAt:new Date().toISOString(),bytes:1_048_575,status:200,failure:null}];policyBodyJournal.wireBytes=1_048_575;
 await assert.rejects(policyBodySeam.onChunk(policyUrl,2),error=>error instanceof R2ExecutorError&&error.code==='POLICY_BODY_BUDGET');
});

test('R2 executor refuses an off-list redirect before dispatch to localhost fixture',async t=>{
 const root=await mkdtemp(join(tmpdir(),'r2-executor-redirect-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=createServer((request,response)=>{if(request.url==='/robots.txt'){response.writeHead(200,{'content-type':'text/plain'});response.end('User-agent: *\nAllow: /\n');return;}if(request.url==='/.well-known/tdmrep.json'){response.writeHead(404);response.end();return;}response.writeHead(302,{location:'/not-listed'});response.end();});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());}));
 const address=server.address();assert.ok(address&&typeof address==='object');
 const input=await options(root,true);input.fetcherOptions=await politeTestOptions({cacheDir:join(root,'cache'),fixtureInspection:fixturePolicyInspection});
 interface FixtureWire {
  scheduled<T>(url:URL,work:(state:unknown)=>Promise<T>,onResult?:(result:T,state:unknown)=>void):Promise<T>;
  wireRequest(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined,pinned:{address:string;family:number},headers:Record<string,string>,onRefusedHeaders?:unknown,accountingUrl?:string):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>;
 }
 const requests:string[]=[];
 const patch=t.mock.method(PoliteFetcher.prototype as unknown as {wire:(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined)=>Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>},'wire',async function(this:FixtureWire,url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined){
  const fixtureUrl=new URL(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`);
  return this.scheduled(url,async()=>{requests.push(url.href);return this.wireRequest(fixtureUrl,method,body,validators,{address:'127.0.0.1',family:4},{},undefined,url.href);});
 });
 t.after(()=>patch.mock.restore());
 const executor=await R2AcquisitionExecutor.open(input);
 await assert.rejects(executor.run(),error=>error instanceof R2ExecutorError&&error.code==='URL_NOT_ALLOWLISTED');
 const allowed=new URL(input.manifest[0]!.url),offList=[new URL(`${allowed.pathname}/other`,allowed),new URL(`${allowed.href}?extra=1`),new URL(allowed.href.replace(allowed.hostname,'www.'+allowed.hostname))];
 // Test the executor's private admission hook directly to prove exact URL matching without another wire.
 interface AdmissionSeam{beforeRequest(url:string):Promise<void>}
 const admission=executor as unknown as AdmissionSeam;
 for(const url of offList)await assert.rejects(admission.beforeRequest(url.href),error=>error instanceof R2ExecutorError&&error.code==='URL_NOT_ALLOWLISTED');
 const journal=(await readFile(input.journalPath,'utf8')).trimEnd().split('\n').map(row=>JSON.parse(row));
 assert.deepEqual(journal.at(-1).attempts.map((row:{url:string})=>new URL(row.url).pathname),['/robots.txt','/.well-known/tdmrep.json',new URL(manifestRows()[0]!.url).pathname]);
});
