import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {test,type TestContext} from 'node:test';
import {PoliteFetcher,PoliteFetchError,RequestAdmissionInterruption,type FetchObservation,type PoliteFetcherOptions,type WireRequestIdentity} from '../src/polite-fetch.ts';
import {recordHostOptOut} from '../src/civic-opt-out.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import {ownerRobotsOverrideFor} from '../src/source-policy.ts';
import {politeTestOptions} from './fixtures/polite-lane.ts';

type WireResult={status:number;headers:Record<string,string|undefined>;body:Buffer;conditionalRequestSent?:boolean};
type HostState={schemaVersion:1;host:string;lastStart:number;delayMs:number;nextAllowedAt:number;failures:number[];stop:null};
interface FetchSeam{
 scheduled<T>(url:URL,request:WireRequestIdentity,work:(state:HostState)=>Promise<T>,onResult?:(result:T,state:HostState)=>void):Promise<T>;
 wireRequest(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined,pinned:{address:string;family:number},headers:Record<string,string>,onRefusedHeaders?:unknown,accountingUrl?:string):Promise<WireResult>;
 onWireAttemptResult?:(url:string,status:number|null,failure:string|null)=>Promise<void>;
 beforeRequest?:(url:string,request:WireRequestIdentity)=>Promise<void>;
 wire(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined,operation?:WireRequestIdentity['publicOperation'],credentials?:unknown):Promise<WireResult>;
}
interface Fixture{fetcher:PoliteFetcher;requests:string[];lane:NonNullable<PoliteFetcherOptions['ownerPolicyLane']>;root:string}
async function fixture(t:TestContext,mode:'allow'|'failure'|'redirect'='allow',hooks:Pick<PoliteFetcherOptions,'beforeRequest'>={}):Promise<Fixture>{
 const root=await mkdtemp(join(tmpdir(),'r2-policy-reuse-'));t.after(()=>rm(root,{recursive:true,force:true}));const currentMode=mode;const requests:string[]=[];
 const server=createServer((request,response)=>{
  const path=request.url??'/';requests.push(`${request.headers.host}${path}`);
  if(path==='/robots.txt'){response.writeHead(200,{'content-type':'text/plain'});setTimeout(()=>response.end('User-agent: *\nAllow: /\n'),20);return;}
  if(path==='/.well-known/tdmrep.json'){
   if(currentMode==='failure'){response.writeHead(503,{'content-type':'text/plain'});setTimeout(()=>response.end('unavailable'),20);return;}
   if(currentMode==='redirect'){response.writeHead(302,{location:'https://off-list.example/.well-known/tdmrep.json'});setTimeout(()=>response.end(),20);return;}
   response.writeHead(200,{'content-type':'application/json'});setTimeout(()=>response.end('[]'),20);return;
  }
  response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end('<!doctype html><html><body><h1>Municipal planning information</h1></body></html>');
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());}));
 const address=server.address();assert.ok(address&&typeof address==='object');
 const pendingOptions=await politeTestOptions({cacheDir:join(root,'cache'),fixtureInspection:fixturePolicyInspection,minDelayMs:0,policyTtlMs:60_000,...hooks});
 const lane={...pendingOptions.ownerPolicyLane!,r2Integrity:{journalPath:join(root,'progress.jsonl'),recordSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64)}};
 const fetcher=new PoliteFetcher({...pendingOptions,ownerPolicyLane:lane});const seam=fetcher as unknown as FetchSeam;
 const scheduler=t.mock.method(seam,'scheduled',async function<T>(this:FetchSeam,_url:URL,request:WireRequestIdentity,work:(state:HostState)=>Promise<T>,onResult?:(result:T,state:HostState)=>void):Promise<T>{const state:HostState={schemaVersion:1,host:_url.hostname,lastStart:Date.now(),delayMs:2000,nextAllowedAt:0,failures:[],stop:null};try{await this.beforeRequest?.(_url.href,request);}catch(error){throw new RequestAdmissionInterruption(error);}const result=await work(state);onResult?.(result,state);return result;});
 const wire=t.mock.method(seam,'wire',async function(this:FetchSeam,url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined,operation?:WireRequestIdentity['publicOperation']):Promise<WireResult>{
  const fixtureUrl=new URL(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`);
  return this.scheduled(url,{method,body:body??null,publicOperation:method==='POST'?operation??null:null},async()=>{const result=await this.wireRequest(fixtureUrl,method,body,validators,{address:'127.0.0.1',family:4},{},undefined,url.href);await this.onWireAttemptResult?.(url.href,result.status,result.status>=400?`http_${result.status}`:null);return result;});
 });
 t.after(()=>{wire.mock.restore();scheduler.mock.restore();});
 return {fetcher,requests,lane,root};
}
const sameSource={registeredSourceUrl:'https://www.ludwigslust.de/',registeredMunicipalityId:'ludwigslust',registeredSourceId:'ludwigslust-gazette'};

test('job-bound policy snapshots hit only for identical source and permission context',async t=>{
 const f=await fixture(t);
 const baselineStarted=performance.now();await f.fetcher.fetch('https://www.ludwigslust.de/baseline-a',sameSource);await f.fetcher.fetch('https://www.ludwigslust.de/baseline-b',{...sameSource,registeredSourceId:'ludwigslust-website'});const baselineMs=performance.now()-baselineStarted,baselineRequests=f.requests.length,baselinePolicyRequests=f.requests.filter(url=>url.endsWith('/robots.txt')||url.endsWith('/.well-known/tdmrep.json')).length;
 const reuseStart=f.requests.length,reuseStarted=performance.now();await f.fetcher.fetch('https://www.ludwigslust.de/a',sameSource);await f.fetcher.fetch('https://www.ludwigslust.de/b',sameSource);const reuseMs=performance.now()-reuseStarted,reuseRequests=f.requests.length-reuseStart,reusePolicyRequests=f.requests.slice(reuseStart).filter(url=>url.endsWith('/robots.txt')||url.endsWith('/.well-known/tdmrep.json')).length;
 t.diagnostic(`policy fixture: baseline ${baselinePolicyRequests} policy requests / ${baselineMs.toFixed(1)}ms; same-source reuse ${reusePolicyRequests} policy requests / ${reuseMs.toFixed(1)}ms; saved ${baselinePolicyRequests-reusePolicyRequests} policy requests and ${(baselineMs-reuseMs).toFixed(1)}ms`);
 assert.equal(baselinePolicyRequests,4);assert.equal(reusePolicyRequests,2);assert.equal(baselineRequests,6);assert.equal(reuseRequests,4);assert.ok(baselineMs>reuseMs+15);
 await f.fetcher.fetch('https://www.ludwigslust.de/c',{...sameSource,registeredSourceId:'ludwigslust-website'});
 assert.equal(f.requests.filter(url=>url.endsWith('/robots.txt')||url.endsWith('/.well-known/tdmrep.json')).length,8);
 await f.fetcher.fetch('https://www.ludwigslust.de/d',{...sameSource,ownerRobotsOverride:ownerRobotsOverrideFor('https://www.ludwigslust.de/d')!});
 assert.equal(f.requests.filter(url=>url.endsWith('/robots.txt')||url.endsWith('/.well-known/tdmrep.json')).length,10);
 await f.fetcher.fetch('https://www.moelln.de/e',{registeredSourceUrl:'https://www.moelln.de/',registeredMunicipalityId:'moelln',registeredSourceId:'moelln-gazette'});
 assert.equal(f.requests.filter(url=>url.endsWith('/robots.txt')||url.endsWith('/.well-known/tdmrep.json')).length,12);
 assert.equal(f.requests.length,19);
});

test('policy snapshots fail closed on rule/receipt tampering and refetch after expiry',async t=>{
 const f=await fixture(t);await f.fetcher.fetch('https://www.ludwigslust.de/a',sameSource);
 type Snapshot={value:{rules:unknown[];evidence:unknown};receiptSha256:string;snapshotSha256:string};type Entry={expiresAt:number;response:Promise<Snapshot>};
 const seam=f.fetcher as unknown as {machinePolicies:Map<string,Entry>;robots:Map<string,Entry>};
 const machine=[...seam.machinePolicies.entries()][0];assert.ok(machine);const [machineKey,machineEntry]=machine;const valid=await machineEntry.response;
 machineEntry.response=Promise.resolve({...valid,value:{...valid.value,rules:[{location:'/a','tdm-reservation':1}]}});
 await assert.rejects(f.fetcher.fetch('https://www.ludwigslust.de/b',sameSource),error=>error instanceof PoliteFetchError&&error.failure==='tdm_unavailable');
 seam.machinePolicies.delete(machineKey);await f.fetcher.fetch('https://www.ludwigslust.de/b',sameSource);
 const robots=[...seam.robots.entries()][0];assert.ok(robots);const [robotsKey,robotsEntry]=robots,robotsSnapshot=await robotsEntry.response;
 robotsEntry.response=Promise.resolve({...robotsSnapshot,receiptSha256:'0'.repeat(64)});
 await assert.rejects(f.fetcher.fetch('https://www.ludwigslust.de/c',sameSource),error=>error instanceof PoliteFetchError&&error.failure==='robots_unavailable');
 seam.robots.delete(robotsKey);const before=f.requests.length;const [key,entry]=[...seam.machinePolicies.entries()][0]!;entry.expiresAt=Date.now()-1;
 await f.fetcher.fetch('https://www.ludwigslust.de/c',sameSource);assert.ok(f.requests.length>=before+3);assert.ok(seam.machinePolicies.has(key));
});

test('live objection and per-document cancellation are checked despite a policy hit',async t=>{
 let cancelled=false;const f=await fixture(t,'allow',{beforeRequest:async url=>{if(cancelled&&url.endsWith('/cancelled'))throw new Error('cancelled');}});
 await f.fetcher.fetch('https://www.ludwigslust.de/first',sameSource);cancelled=true;const before=f.requests.length;
 await assert.rejects(f.fetcher.fetch('https://www.ludwigslust.de/cancelled',sameSource),/cancelled/);assert.equal(f.requests.length,before);
 await recordHostOptOut({host:'www.ludwigslust.de',reason:'municipality_objection'},f.lane);
 await assert.rejects(f.fetcher.fetch('https://www.ludwigslust.de/after-objection',sameSource),error=>error instanceof PoliteFetchError&&error.failure==='host_opted_out');
});

test('failed policy fetch stays held and off-origin TDM redirects are refused before destination dispatch',async t=>{
 const failed=await fixture(t,'failure');
 await assert.rejects(failed.fetcher.fetch('https://www.ludwigslust.de/a',sameSource),error=>error instanceof PoliteFetchError&&error.failure==='tdm_unavailable');const requests=failed.requests.length;
 await assert.rejects(failed.fetcher.fetch('https://www.ludwigslust.de/b',sameSource),error=>error instanceof PoliteFetchError&&error.failure==='tdm_unavailable');assert.equal(failed.requests.length,requests);assert.equal(failed.requests.some(url=>url.endsWith('/a')||url.endsWith('/b')),false);
 const redirected=await fixture(t,'redirect');await assert.rejects(redirected.fetcher.fetch('https://www.ludwigslust.de/a',sameSource),error=>error instanceof PoliteFetchError&&error.failure==='unsafe_url');assert.equal(redirected.requests.length,2);assert.equal(redirected.requests.some(url=>url.startsWith('off-list.example')),false);
});
