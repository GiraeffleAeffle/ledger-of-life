import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request,type Server} from 'node:http';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {MCP_HTTP_BODY_BYTES,MCP_MAX_TOOL_INPUT_ELEMENTS,createLocalHttp,server} from '../src/mcp.ts';
import {createHostedHttp,limits,type TokenState} from '../src/mcp-hosted.ts';
import {DEFAULT_TOKEN_LIMITS} from '../src/mcp-token-config.mjs';
import {queryFields} from '../src/mcp-query.ts';
import {syntheticRelease} from './fixtures/mcp-release.ts';

for(const shape of ['array','record'] as const)test(`rejects oversized ${shape} before schema parsing or tool execution`,async()=>{
 let parsed=0,executed=0;
 const mcp=server(),client=new Client({name:'input-limit-test',version:'1'});
 mcp.registerTool('limit_probe',{inputSchema:z.object({value:z.unknown().superRefine(()=>{parsed++;})})},()=>{executed++;return {content:[]};});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const value=shape==='array'?Array(MCP_MAX_TOOL_INPUT_ELEMENTS).fill(0):Object.fromEntries(Array.from({length:MCP_MAX_TOOL_INPUT_ELEMENTS},(_,i)=>['key'+i,0]));
  const rejected=await client.callTool({name:'limit_probe',arguments:{value}});
  assert.equal(rejected.isError,true);
  assert.match(JSON.stringify(rejected.content),/more than the maximum of 256 elements/);
  assert.equal(parsed,0,'The SDK guard must run before Zod');assert.equal(executed,0);
  const accepted=await client.callTool({name:'limit_probe',arguments:{value:Array(MCP_MAX_TOOL_INPUT_ELEMENTS-1).fill(0)}});
  assert.notEqual(accepted.isError,true);assert.equal(parsed,1);assert.equal(executed,1,'The exact 256-element boundary is inclusive');
 }finally{await client.close();await mcp.close();}
});

test('all advertised tool schemas fit below the element ceiling',async()=>{
 const mcp=server(),client=new Client({name:'schema-budget-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 await mcp.connect(serverTransport);await client.connect(clientTransport);
 type InputSchema={type?:string;properties?:Record<string,InputSchema>;items?:InputSchema|InputSchema[];prefixItems?:InputSchema[];maxItems?:number};
 function maximum(schema:InputSchema):number{
  if(schema.type==='object')return Object.keys(schema.properties??{}).length+Object.values(schema.properties??{}).reduce((sum,child)=>sum+maximum(child),0);
  if(schema.type==='array'){
   const tuple=schema.prefixItems??(Array.isArray(schema.items)?schema.items:undefined);
   if(tuple)return tuple.length+tuple.reduce((sum,child)=>sum+maximum(child),0);
   assert.equal(typeof schema.maxItems,'number','Every tool array must have an explicit bound');
   assert.ok(schema.items&&!Array.isArray(schema.items));
   return schema.maxItems!*(1+maximum(schema.items));
  }
  assert.ok(['string','number','integer','boolean'].includes(schema.type??''),`Unaccounted schema type: ${JSON.stringify(schema)}`);
  return 0;
 }
 try{
  const {tools}=await client.listTools();assert.equal(tools.length,20);
  const budgets=Object.fromEntries(tools.map(tool=>[tool.name,maximum(tool.inputSchema as InputSchema)]));
  assert.equal(budgets.search_signals_along,190);assert.equal(budgets.search_topics,189);
  for(const [name,elements] of Object.entries(budgets))assert.ok(elements<MCP_MAX_TOOL_INPUT_ELEMENTS,`${name}: ${elements}`);
 }finally{await client.close();await mcp.close();}
});

test('32 vertices with maximal kinds and projection execute a real spatial tool',async()=>{
 let executed=0;
 const release=syntheticRelease(),mcp=server({release,transformResult:data=>{executed++;return {content:[{type:'text',text:JSON.stringify(data)}]};}}),client=new Client({name:'maximal-line-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const line=Array.from({length:32},(_,i)=>[13.8+i/1000,52.5+i/1000]);
  const result=await client.callTool({name:'search_signals_along',arguments:{cityId:'strausberg',line,buffer_m:50000,kinds:Array(20).fill('council_paper'),limit:50,fields:[...queryFields]}});
  assert.notEqual(result.isError,true,JSON.stringify(result.content));assert.equal(executed,1);
  const content=z.array(z.object({type:z.literal('text'),text:z.string()})).parse(result.content);
  const output=z.object({fields:z.array(z.string()),items:z.array(z.unknown())}).parse(JSON.parse(content[0].text));
  assert.deepEqual(output.fields,[...queryFields].sort());assert.deepEqual(output.items,[],'Synthetic fixture features have null geometry');
 }finally{await client.close();await mcp.close();}
});

async function listening(http:Server,run:(url:string)=>Promise<void>){
 await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',resolve);});
 const address=http.address();assert.ok(address&&typeof address==='object');
 try{await run(`http://127.0.0.1:${address.port}/mcp`);}
 finally{http.closeAllConnections();await new Promise<void>((resolve,reject)=>http.close(error=>error?reject(error):resolve()));}
}
const headers={'content-type':'application/json',accept:'application/json, text/event-stream'};
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'body-limit-test',version:'1'}}};

test('local HTTP rejects oversized declared and chunked bodies before parsing or server creation',async()=>{
 let created=0;
 await listening(createLocalHttp(()=>{created++;return server();}),async(url)=>{
  assert.equal((await fetch(url,{method:'POST',headers,body:'x'.repeat(MCP_HTTP_BODY_BYTES+1)})).status,413);
  assert.equal(created,0);
  const streamed=await new Promise<number|undefined>((resolve,reject)=>{
   const req=request(url,{method:'POST',headers:{...headers,'transfer-encoding':'chunked'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));res.once('error',reject);});
   req.once('error',reject);
   req.write('x'.repeat(MCP_HTTP_BODY_BYTES));req.end('x');
  });
  assert.equal(streamed,413,'Chunked bodies cannot bypass the byte cap');assert.equal(created,0);
  assert.equal((await fetch(url,{method:'POST',headers,body:'{'})).status,400);assert.equal(created,0);
  const exact=JSON.stringify(initialize).padEnd(MCP_HTTP_BODY_BYTES,' ');
  const accepted=await fetch(url,{method:'POST',headers,body:exact});
  assert.equal(accepted.status,200);await accepted.text();assert.equal(created,1);
 });
});

test('hosted HTTP uses the same body cap and protected server factory',async()=>{
 const token='a'.repeat(43),state:TokenState={id:'synthetic',digest:createHash('sha256').update(token).digest(),limits:DEFAULT_TOKEN_LIMITS,window:0,requests:0,active:0};
 let created=0,parsed=0,executed=0;
 await listening(createHostedHttp([state],()=>{
  created++;const mcp=server();
  mcp.registerTool('limit_probe',{inputSchema:z.object({value:z.unknown().superRefine(()=>{parsed++;})})},()=>{executed++;return {content:[]};});
  return mcp;
 }),async(url)=>{
  assert.equal(limits.bodyBytes,MCP_HTTP_BODY_BYTES);
  const authorized={...headers,authorization:`Bearer ${token}`};
  const oversized=await fetch(url,{method:'POST',headers:authorized,body:'x'.repeat(MCP_HTTP_BODY_BYTES+1)});
  assert.equal(oversized.status,413);assert.equal(created,0);
  const response=await fetch(url,{method:'POST',headers:authorized,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'limit_probe',arguments:{value:Array(MCP_MAX_TOOL_INPUT_ELEMENTS).fill(0)}}})});
  assert.equal(response.status,200);
  const result=z.object({result:z.object({isError:z.literal(true),content:z.array(z.object({type:z.literal('text'),text:z.string()}))})}).parse(await response.json());
  assert.match(result.result.content[0].text,/more than the maximum of 256 elements/);
  assert.equal(created,1);assert.equal(parsed,0);assert.equal(executed,0);
 });
});
