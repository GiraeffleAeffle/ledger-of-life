import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PoliteFetcher,PoliteFetchError,type FixturePolicyInspection} from '../src/polite-fetch.ts';
import {withManagedSourceScratch,recordHostOptOut,assertHostNotOptedOut,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
import {ParserIsolationError,type ParserSandbox,type ParserSourceContext} from '../src/district-parser-isolation.ts';
import {inspectResourcePolicySandbox} from '../src/district-policy-inspection.ts';
import {classifyDocumentOrigin} from '../src/document-origin.ts';
import {inspectPdfTdmPolicy} from '../src/pdf-tdm-policy.ts';
import {hash} from '../src/common.ts';
import {politeTestOptions} from './fixtures/polite-lane.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import {metadataPdf,reservedXmp} from './fixtures/tdm-pdf.ts';

interface InspectionSeam {
 withInspectionSandbox(body:Buffer,context:ParserSourceContext,inspect:(sandbox?:ParserSandbox)=>Promise<void>):Promise<void>;
 wire(url:URL):Promise<{status:number;headers:Record<string,string>;body:Buffer}>;
}
interface ScopeRun {url:string;sha256:string;commands:string[]}
// Only synthetic representations and the existing pinned fixture inspection seam
// are used here. This is not a fake parser authorization or a Docker receipt.
const batchFixture:FixturePolicyInspection={
 async resource(url,headers,body,mimeType,context,sandbox?:ParserSandbox){
  return sandbox?JSON.parse((await sandbox.run('resource',[JSON.stringify({url,headers,mimeType})])).stdout):fixturePolicyInspection.resource(url,headers,body,mimeType,context);
 },
 async origin(input,options){
  const {bytes:_bytes,...metadata}=input;
  return options.sandbox?JSON.parse((await options.sandbox.run('origin',[JSON.stringify(metadata)])).stdout):fixturePolicyInspection.origin(input,options);
 },
 async pdf(bytes,sha256,cacheRoot,context,sandbox?:ParserSandbox){
  return sandbox?JSON.parse((await sandbox.run('pdf',[])).stdout):fixturePolicyInspection.pdf(bytes,sha256,cacheRoot,context);
 },
};
async function batchHarness(t:TestContext,root:string,body:Buffer,mimeType:string,headers:Record<string,string>={},afterCommand?:(command:string,context:ParserSourceContext)=>Promise<void>){
 const options=await politeTestOptions({cacheDir:root}),fetcher=new PoliteFetcher({...options,fixtureInspection:batchFixture}),runs:ScopeRun[]=[],controller=new AbortController();
 t.mock.method(fetcher as unknown as InspectionSeam,'withInspectionSandbox',async(bytes:Buffer,context:ParserSourceContext,inspect:(sandbox?:ParserSandbox)=>Promise<void>)=>{
  const scopeRun={url:context.bindings[0].url,sha256:hash(bytes),commands:[] as string[]},bindings=JSON.stringify(context.bindings);runs.push(scopeRun);
  assert.deepEqual(context.bindings,[{phase:'pre-admission',url:scopeRun.url,sourceSha256:scopeRun.sha256}]);
  await withManagedSourceScratch(context.root,context.bindings,async scope=>{
   await scope.writeSource('document',bytes);
   const sandbox:ParserSandbox={run:async(command,args)=>{
    await scope.assertActive();assert.equal(JSON.stringify(context.bindings),bindings);assert.equal(hash(bytes),scopeRun.sha256);
    scopeRun.commands.push(command);let result;
    if(command==='resource'){
     const metadata=JSON.parse(args[0]);result=await fixturePolicyInspection.resource(metadata.url,metadata.headers,bytes,metadata.mimeType,context);
    }else if(command==='origin')result=await fixturePolicyInspection.origin({...JSON.parse(args[0]),bytes},{scratch:context});
    else if(command==='pdf')result=await fixturePolicyInspection.pdf(bytes,hash(bytes),root,context);
    else throw Error('Unexpected synthetic inspection command');
    await afterCommand?.(command,context);await scope.assertActive();return {stdout:JSON.stringify(result),stderr:''};
   }};
   await inspect(sandbox);
  },{...context,signal:controller.signal});
 });
 let documents=0;
 t.mock.method(fetcher as unknown as InspectionSeam,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nAllow: /')};
  if(url.pathname==='/.well-known/tdmrep.json')return {status:200,headers:{'content-type':'application/json'},body:Buffer.from('[{"location":"/","tdm-reservation":0}]')};
  return ++documents===1?{status:200,headers:{'content-type':mimeType,etag:'"batch-fixture"',...headers},body}:{status:304,headers:{},body:Buffer.alloc(0)};
 });
 return {fetcher,runs,options,controller};
}
async function outcome(fetcher:PoliteFetcher,url:string){
 try{
  const document=await fetcher.fetch(url);return {state:'admitted',sha256:document.sha256,mimeType:document.mimeType,status:document.status,policy:document.policy};
 }catch(error){
  assert.ok(error instanceof PoliteFetchError);
  return {state:'held',failure:error.failure,message:error.message,phase:error.policyPhase,policy:error.policy,cause:error.cause};
 }
}

for(const fixture of [
 {name:'HTML',body:Buffer.from('<h1>Beschlussvorlage</h1><p>Herausgeber: Stadt Beispielstadt</p><p>Informationen zur Entwicklung des Quartiers und zur weiteren Beratung.</p>'),mimeType:'text/html',commands:['resource','origin']},
 {name:'PDF',body:metadataPdf(),mimeType:'application/pdf',commands:['resource','origin','pdf']},
 {name:'PDF reservation',body:metadataPdf(reservedXmp),mimeType:'application/pdf',commands:['resource','origin','pdf']},
 {name:'malformed PDF',body:Buffer.from('%PDF-invalid'),mimeType:'application/pdf',commands:['resource','origin','pdf']},
 {name:'access barrier',body:Buffer.from('<title>Login</title><form><input type="password"></form>'),mimeType:'text/html',commands:['resource']},
 {name:'invalid TDM reference',body:Buffer.from('<meta name="tdm-policy" content="javascript:bad"><p>Public information</p>'),mimeType:'text/html',commands:['resource']},
 {name:'early reservation',body:Buffer.from('<meta name="tdm-reservation" content="1"><p>Public information</p>'),mimeType:'text/html',commands:['resource']},
])test(`batched ${fixture.name} outcomes are byte-identical to separate fixture executions`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-13T12:00:00.000Z')});
 const root=await mkdtemp(join(tmpdir(),'batch-outcomes-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {fetcher:batched,runs}=await batchHarness(t,join(root,'batch'),fixture.body,fixture.mimeType);
 const separate=new PoliteFetcher({...await politeTestOptions({cacheDir:join(root,'separate')}),fixtureInspection:fixturePolicyInspection});
 let documents=0;
 t.mock.method(separate as unknown as InspectionSeam,'wire',async(url:URL)=>{
  if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nAllow: /')};
  if(url.pathname==='/.well-known/tdmrep.json')return {status:200,headers:{'content-type':'application/json'},body:Buffer.from('[{"location":"/","tdm-reservation":0}]')};
  return ++documents===1?{status:200,headers:{'content-type':fixture.mimeType,etag:'"batch-fixture"'},body:fixture.body}:{status:304,headers:{},body:Buffer.alloc(0)};
 });
 const url='https://stadt.de/document',expected=await outcome(separate,url),actual=await outcome(batched,url);
 assert.equal(JSON.stringify(actual),JSON.stringify(expected));
 assert.equal(runs.length,3);assert.deepEqual(runs.map(run=>run.commands),[['resource'],['resource'],fixture.commands]);
 assert.deepEqual(runs.map(run=>run.url),['https://stadt.de/robots.txt','https://stadt.de/.well-known/tdmrep.json',url]);
 if(actual.state==='admitted'){
  assert.equal(JSON.stringify(await outcome(batched,url)),JSON.stringify(await outcome(separate,url)));
  assert.equal(runs.length,4);assert.deepEqual(runs[3],{url,sha256:hash(fixture.body),commands:fixture.commands});
 }
});

for(const interruption of ['abort','objection','command failure'] as const)test(`${interruption} between batched commands stops downstream inspection and retention`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'batch-interruption-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const body=Buffer.from('<p>Synthetic public municipal document</p>'),url='https://stadt.de/document';
 const {fetcher,runs,options,controller}=await batchHarness(t,root,body,'text/html',{},async(command,context)=>{
  if(command!=='resource'||context.bindings[0].url!==url)return;
  if(interruption==='objection')await recordHostOptOut({host:'stadt.de',reason:'municipality_objection'},options.ownerPolicyLane!);
  else if(interruption==='abort')controller.abort(new DOMException('Synthetic command cancellation','AbortError'));
  else throw Error('Synthetic interrupted command');
 });
 await assert.rejects(fetcher.fetch(url),(error:unknown)=>error instanceof PoliteFetchError&&error.failure===(interruption==='objection'?'host_opted_out':'network_error'));
 assert.deepEqual(runs.at(-1)?.commands,['resource']);
 await assert.rejects(readFile(join(root,'sha256',hash(body))),{code:'ENOENT'});
 assert.deepEqual(await readdir(join(root,'scratch')),[]);
 const inventory=JSON.parse(await readFile(join(options.ownerPolicyLane!.stateDir!,'inventory.json'),'utf8'));
 assert.ok(inventory.scratch.every((lease:{state:string})=>lease.state==='closed'));
 if(interruption==='objection')await assert.rejects(assertHostNotOptedOut(url,options.ownerPolicyLane));
});

test('unbranded sandbox injection is rejected by every production inspection wrapper',async()=>{
 const bytes=Buffer.from('Synthetic source'),url='https://stadt.de/document',sha256=hash(bytes);
 const context:ParserSourceContext={root:'/unused',kind:'fetch',decisionId:CIVIC_ACQUISITION_DECISION_ID,purpose:'classification',bindings:[{phase:'pre-admission',url,sourceSha256:sha256}]};
 let commands=0;const sandbox:ParserSandbox={run:async()=>{commands++;throw Error('Injected parser must never execute');}};
 const rejected=(error:unknown)=>error instanceof ParserIsolationError&&error.reason==='request_rejected';
 await assert.rejects(inspectResourcePolicySandbox(url,{},bytes,'text/plain',context,sandbox),rejected);
 await assert.rejects(classifyDocumentOrigin({url,bytes,mimeType:'text/plain'},{scratch:context,sandbox}),rejected);
 await assert.rejects(inspectPdfTdmPolicy(bytes,sha256,'/unused',context,sandbox),rejected);
 assert.equal(commands,0);
});
