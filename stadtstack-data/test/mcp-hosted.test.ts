import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {createHostedHttp} from '../src/mcp-hosted.ts';

async function fixture(run:(url:string,token:string)=>Promise<void>) {
  const token=randomBytes(32).toString('base64url');
  const http=createHostedHttp([{id:'test',digest:createHash('sha256').update(token).digest(),window:0,requests:0,active:0}],()=>new McpServer({name:'test',version:'1'}));
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
  assert.equal((await fetch(url+'/mcp',{headers:{...headers(token),host:'evil.invalid'}})).status,403);
  assert.equal((await fetch(url+'/mcp',{headers:headers(token)})).status,405);
}));
test('supports stateless initialize/list and rejects oversized, compressed and batched bodies',async()=>fixture(async(url,token)=>{
  const init=await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:JSON.stringify(initialize)});
  assert.equal(init.status,200); assert.equal((await init.json()).result.serverInfo.name,'test');
  assert.equal(init.headers.get('mcp-session-id'),null);
  const list=await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})});
  assert.equal(list.status,200);assert.deepEqual((await list.json()).result.tools,[]);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:'x'.repeat(32769)})).status,413);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:'{'})).status,400);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:JSON.stringify([initialize])})).status,400);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{...headers(token),'content-encoding':'gzip'},body:'x'})).status,415);
}));
test('rate limits independently for each token without storing unknown tokens',async()=>fixture(async(url,token)=>{
  for(let i=0;i<60;i++)assert.equal((await fetch(url+'/mcp',{headers:headers(token)})).status,405);
  const limited=await fetch(url+'/mcp',{headers:headers(token)});
  assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);
  assert.equal((await fetch(url+'/mcp',{headers:headers('z'.repeat(43))})).status,401);
}));
