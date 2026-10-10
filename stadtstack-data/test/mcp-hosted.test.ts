import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {request} from 'node:http';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {CallToolResultSchema,InitializeResultSchema,JSONRPCResponseSchema,ListToolsResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {createHostedHttp} from '../src/mcp-hosted.ts';

async function fixture(run:(url:string,token:string)=>Promise<void>, active=0) {
  const token=randomBytes(32).toString('base64url');
  const http=createHostedHttp([{id:'test',digest:createHash('sha256').update(token).digest(),window:0,requests:0,active}],()=>{
    const mcp=new McpServer({name:'test',version:'1'});
    // McpServer installs tools/list and advertises tools only after registration.
    mcp.registerTool('fixture_read',{inputSchema:{},annotations:{readOnlyHint:true}},()=>({content:[{type:'text',text:'fixture'}]}));
    return mcp;
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const address=http.address(); assert.ok(address && typeof address==='object');
  try {await run(`http://127.0.0.1:${address.port}`,token);}
  finally {http.closeAllConnections();await new Promise<void>((resolve,reject)=>http.close(error=>error?reject(error):resolve()));}
}
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}};
const headers=(token:string)=>({'authorization':`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'});

test('protects exact route, authentication, browser origin and host',async()=>fixture(async(url,token)=>{
  assert.equal((await fetch(url+'/health')).status,200);
  assert.equal((await fetch(url+'/mcp')).status,401);
  assert.equal((await fetch(url+'/mcp?token=redacted')).status,404);
  assert.equal((await fetch(url+'/mcp-more')).status,404);
  assert.equal((await fetch(url+'/mcp',{headers:headers('x'.repeat(43))})).status,401);
  assert.equal((await fetch(url+'/mcp',{headers:{...headers(token),origin:'https://evil.invalid'}})).status,403);
  // Fetch can discard Host overrides; node:http sends the actual hostile Host.
  const hostileHostStatus=await new Promise<number|undefined>((resolve,reject)=>{
    const req=request(url+'/mcp',{headers:{...headers(token),host:'evil.invalid'}},response=>{
      response.resume();
      response.once('end',()=>resolve(response.statusCode));
      response.once('error',reject);
    });
    req.once('error',reject);
    req.end();
  });
  assert.equal(hostileHostStatus,403);
  assert.equal((await fetch(url+'/mcp',{headers:headers(token)})).status,405);
}));
test('supports stateless initialize/list and rejects oversized, compressed and batched bodies',async()=>fixture(async(url,token)=>{
  const init=await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:JSON.stringify(initialize)});
  const initEnvelope=JSONRPCResponseSchema.parse(await init.json());assert.ok('result' in initEnvelope);
  const initBody=InitializeResultSchema.parse(initEnvelope.result);
  assert.equal(init.status,200);assert.equal(initBody.serverInfo.name,'test');
  assert.ok(initBody.capabilities.tools);
  assert.equal(init.headers.get('mcp-session-id'),null);
  const list=await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})});
  const listEnvelope=JSONRPCResponseSchema.parse(await list.json());assert.ok('result' in listEnvelope);
  const listBody=ListToolsResultSchema.parse(listEnvelope.result);
  assert.equal(list.status,200);
  assert.deepEqual(listBody.tools.map(tool=>({name:tool.name,readOnlyHint:tool.annotations?.readOnlyHint})),[{name:'fixture_read',readOnlyHint:true}]);
  const call=await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'fixture_read',arguments:{}}})});
  const callEnvelope=JSONRPCResponseSchema.parse(await call.json());assert.ok('result' in callEnvelope);
  const callBody=CallToolResultSchema.parse(callEnvelope.result);
  assert.equal(call.status,200);assert.deepEqual(callBody.content,[{type:'text',text:'fixture'}]);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:'x'.repeat(32769)})).status,413);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:'{'})).status,400);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:JSON.stringify([initialize])})).status,400);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{...headers(token),'content-encoding':'gzip'},body:'x'})).status,415);
}));
test('rate limits independently for each token without storing unknown tokens',async()=>fixture(async(url,token)=>{
  for(let i=0;i<60;i++)assert.equal((await fetch(url+'/mcp',{headers:headers(token)})).status,405);
  const limited=await fetch(url+'/mcp',{headers:headers(token)});
  assert.equal(limited.status,429);
  const retryAfterSeconds=Number(limited.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfterSeconds)&&retryAfterSeconds>=1&&retryAfterSeconds<=60);
  assert.deepEqual(await limited.json(),{ok:false,error:'rate_limited',retryAfterSeconds,limits:{requestsPerMinute:60,maxConcurrent:4}});
  assert.equal((await fetch(url+'/mcp',{headers:headers('z'.repeat(43))})).status,401);
}));

test('concurrency limit exposes the same guidance in its header and JSON body',async()=>fixture(async(url,token)=>{
  const limited=await fetch(url+'/mcp',{headers:headers(token)});
  assert.equal(limited.status,429);
  const retryAfterSeconds=Number(limited.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfterSeconds)&&retryAfterSeconds>=1&&retryAfterSeconds<=60);
  assert.deepEqual(await limited.json(),{ok:false,error:'rate_limited',retryAfterSeconds,limits:{requestsPerMinute:60,maxConcurrent:4}});
  assert.equal((await fetch(url+'/mcp')).status,401);
},4));
