import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {request} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {CallToolResultSchema,InitializeResultSchema,JSONRPCResponseSchema,ListToolsResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {createHostedHttp,loadTokens,limits,type TokenState} from '../src/mcp-hosted.ts';
import {DEFAULT_TOKEN_LIMITS,MAX_TOKEN_LIMITS,type TokenHashRecord} from '../src/mcp-token-config.mjs';

interface FixtureContext {
  identities:Record<string,{value:string;state:TokenState}>;
  clock:{nowMs:number};
  manifestPath:string;
  records:TokenHashRecord[];
}
async function fixture(run:(url:string,token:string,context:FixtureContext)=>Promise<void>, active=0, factory?:()=>McpServer) {
  const directory=await mkdtemp(join(tmpdir(),'mcp-hosted-limits-'));
  try {
    const values=new Map<string,string>();
    const records:TokenHashRecord[]=['test','other','max','buzz'].map(id=>{
      const value=randomBytes(32).toString('base64url');values.set(id,value);
      return {id,sha256:createHash('sha256').update(value).digest('hex'),...(['max','buzz'].includes(id)?{limits:MAX_TOKEN_LIMITS}:{})};
    });
    const manifestPath=join(directory,'token-hashes.json');
    await writeFile(manifestPath,JSON.stringify(records),{mode:0o600});
    const states=await loadTokens(manifestPath);
    const identities:FixtureContext['identities']={};
    for(const state of states) {
      const value=values.get(state.id);assert.ok(value);
      identities[state.id]={value,state};
    }
    identities.test.state.active=active;
    const clock={nowMs:70000};
    const http=createHostedHttp(states,factory??(()=>{
      const mcp=new McpServer({name:'test',version:'1'});
      // McpServer installs tools/list and advertises tools only after registration.
      mcp.registerTool('fixture_read',{inputSchema:{},annotations:{readOnlyHint:true}},()=>({content:[{type:'text',text:'fixture'}]}));
      return mcp;
    }),undefined,()=>clock.nowMs);
    await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',resolve);});
    const address=http.address(); assert.ok(address && typeof address==='object');
    try {await run(`http://127.0.0.1:${address.port}`,identities.test.value,{identities,clock,manifestPath,records});}
    finally {http.closeAllConnections();await new Promise<void>((resolve,reject)=>http.close(error=>error?reject(error):resolve()));}
  } finally {await rm(directory,{recursive:true,force:true});}
}
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}};
const headers=(token:string)=>({'authorization':`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'});

test('protects exact route, authentication, browser origin and host',async()=>fixture(async(url,token,{identities})=>{
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
  assert.equal(identities.test.state.requests,3,'Invalid authenticated origin/host requests also consume quota');
}));
test('supports stateless initialize/list and rejects oversized, compressed and batched bodies',async()=>fixture(async(url,token,{identities})=>{
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
  assert.equal(identities.test.state.requests,7,'Protocol, tool and invalid authenticated requests each consume one unit');
}));
test('default budget is isolated from other authenticated token identities',async()=>fixture(async(url,token,{identities})=>{
  for(let i=0;i<60;i++)assert.equal((await fetch(url+'/mcp',{headers:headers(token)})).status,405);
  const limited=await fetch(url+'/mcp',{headers:headers(token)});
  assert.equal(limited.status,429);
  const retryAfterSeconds=Number(limited.headers.get('retry-after'));
  assert.equal(retryAfterSeconds,50);
  assert.deepEqual(await limited.json(),{ok:false,error:'rate_limited',retryAfterSeconds,limits:{requestsPerMinute:60,maxConcurrent:4}});
  assert.equal((await fetch(url+'/mcp',{headers:headers('z'.repeat(43))})).status,401);
  assert.equal(identities.test.state.requests,60);
  assert.equal(identities.other.state.requests,0);
  assert.equal((await fetch(url+'/mcp',{headers:headers(identities.other.value)})).status,405);
  assert.equal(identities.other.state.requests,1);
  const spoofed=await fetch(url+'/mcp',{headers:{...headers(token),'x-token-id':'max','x-mcp-requests-per-minute':'300'}});
  assert.equal(spoofed.status,429);
  assert.deepEqual(await spoofed.json(),{ok:false,error:'rate_limited',retryAfterSeconds:50,limits:DEFAULT_TOKEN_LIMITS});
  assert.equal(identities.max.state.requests,0);
  assert.equal(identities.buzz.state.requests,0);
}));

test('concurrency rejections count requests and truthfully switch to minute Retry-After',async()=>fixture(async(url,token,{identities,clock})=>{
  const limited=await fetch(url+'/mcp',{headers:headers(token)});
  assert.equal(limited.status,429);
  const retryAfterSeconds=Number(limited.headers.get('retry-after'));
  assert.equal(retryAfterSeconds,1);
  assert.deepEqual(await limited.json(),{ok:false,error:'rate_limited',retryAfterSeconds,limits:{requestsPerMinute:60,maxConcurrent:4}});
  assert.equal((await fetch(url+'/mcp')).status,401);
  assert.equal(identities.test.state.requests,1);
  identities.test.state.requests=59;
  const lastBudgetUnit=await fetch(url+'/mcp',{headers:headers(token)});
  assert.equal(lastBudgetUnit.status,429);
  assert.equal(lastBudgetUnit.headers.get('retry-after'),'50');
  assert.deepEqual(await lastBudgetUnit.json(),{ok:false,error:'rate_limited',retryAfterSeconds:50,limits:DEFAULT_TOKEN_LIMITS});
  assert.equal(identities.test.state.requests,60);
  clock.nowMs+=60000;
  const nextWindow=await fetch(url+'/mcp',{headers:headers(token)});
  assert.equal(nextWindow.status,429);
  assert.equal(nextWindow.headers.get('retry-after'),'1');
  assert.equal(identities.test.state.requests,1);
  assert.equal(identities.test.state.active,4,'A minute rollover must not release active requests');
},4));

test('explicit max and buzz profiles independently allow exactly 300 requests per fixed window',async()=>fixture(async(url,token,{identities})=>{
  assert.deepEqual(MAX_TOKEN_LIMITS,{requestsPerMinute:300,maxConcurrent:8});
  for(const id of ['max','buzz']) {
    const identity=identities[id];
    for(let i=0;i<300;i++)assert.equal((await fetch(url+'/mcp',{headers:headers(identity.value)})).status,405);
    assert.equal(identity.state.requests,300);
    const limited=await fetch(url+'/mcp',{headers:headers(identity.value)});
    assert.equal(limited.status,429);
    assert.equal(limited.headers.get('retry-after'),'50');
    assert.deepEqual(await limited.json(),{ok:false,error:'rate_limited',retryAfterSeconds:50,limits:{requestsPerMinute:300,maxConcurrent:8}});
  }
  assert.equal(identities.test.state.requests,0);
  assert.equal((await fetch(url+'/mcp',{headers:headers(token)})).status,405);
  assert.equal(identities.test.state.requests,1);
}));

test('authenticated invalid routes and health requests cannot bypass accounting',async()=>fixture(async(url,token,{identities})=>{
  assert.equal((await fetch(url+'/health')).status,200);
  assert.equal(identities.test.state.requests,0);
  assert.equal((await fetch(url+'/health',{headers:headers(token)})).status,200);
  assert.equal((await fetch(url+'/mcp?invalid=1',{headers:headers(token)})).status,404);
  assert.equal((await fetch(url+'/not-mcp',{headers:headers(token)})).status,404);
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:{...headers(token),'content-type':'text/plain'},body:'invalid'})).status,415);
  assert.equal(identities.test.state.requests,4);
  const initAsMax={...initialize,params:{...initialize.params,clientInfo:{name:'max',version:'1'}}};
  assert.equal((await fetch(url+'/mcp',{method:'POST',headers:headers(token),body:JSON.stringify(initAsMax)})).status,200);
  assert.equal(identities.test.state.requests,5);
  assert.equal(identities.max.state.requests,0,'Client names must not select the authenticated token identity');
  assert.deepEqual(identities.test.state.limits,DEFAULT_TOKEN_LIMITS);
}));

test('ordinary requests retain counters until the fixed minute changes',async()=>fixture(async(url,token,{identities,clock})=>{
  for(let i=0;i<3;i++) {
    assert.equal((await fetch(url+'/mcp',{headers:headers(token)})).status,405);
    assert.equal(identities.test.state.requests,i+1);
  }
  assert.equal((await fetch(url+'/mcp',{headers:headers(identities.other.value)})).status,405);
  clock.nowMs=119999;
  assert.equal((await fetch(url+'/mcp',{headers:headers(token)})).status,405);
  assert.equal(identities.test.state.requests,4);
  clock.nowMs=120000;
  assert.equal((await fetch(url+'/mcp',{headers:headers(token)})).status,405);
  assert.equal(identities.test.state.requests,1);
  assert.equal(identities.other.state.requests,1,'One token rolling over must not mutate another token state');
}));

test('legacy max and buzz names alone retain the default policy',async()=>fixture(async(_url,_token,{manifestPath,records})=>{
  const legacy=records.map(record=>({id:record.id,sha256:record.sha256}));
  await writeFile(manifestPath,JSON.stringify(legacy),{mode:0o600});
  const loaded=await loadTokens(manifestPath);
  for(const state of loaded) {
    assert.deepEqual(state.limits,{requestsPerMinute:60,maxConcurrent:4});
    assert.ok(Object.isFrozen(state.limits));
  }
}));

test('hash-manifest changes activate only through an explicit fresh startup load',async()=>fixture(async(url,_token,{identities,manifestPath,records})=>{
  const identity=identities.max;
  assert.equal((await fetch(url+'/mcp',{headers:headers(identity.value)})).status,405);
  const changed=records.map(record=>record.id==='max'?{...record,limits:{requestsPerMinute:2,maxConcurrent:1}}:record);
  await writeFile(manifestPath,JSON.stringify(changed),{mode:0o600});
  for(let i=0;i<3;i++)assert.equal((await fetch(url+'/mcp',{headers:headers(identity.value)})).status,405);
  assert.equal(identity.state.requests,4);
  assert.deepEqual(identity.state.limits,{requestsPerMinute:300,maxConcurrent:8});
  const restarted=(await loadTokens(manifestPath)).find(state=>state.id==='max');
  assert.ok(restarted);
  assert.deepEqual(restarted.limits,{requestsPerMinute:2,maxConcurrent:1});
  assert.equal(restarted.requests,0);
  assert.equal(restarted.active,0);
  assert.ok(restarted.digest.equals(identity.state.digest),'Changing only limits must preserve the token digest');
  assert.equal((await fetch(url+'/mcp',{headers:headers(identity.value)})).status,405);
  assert.equal(identity.state.requests,5,'Loading replacement configuration must not reset the existing server');
}));

test('real in-flight requests enforce 4/8 concurrency per token and release slots independently',async()=>{
  for(const id of ['test','max','buzz']) {
    const expected=id==='test'?DEFAULT_TOKEN_LIMITS:MAX_TOKEN_LIMITS;
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    let held=0;
    const factory=()=>{
      const mcp=new McpServer({name:'test',version:'1'});
      mcp.registerTool('fixture_hold',{inputSchema:{},annotations:{readOnlyHint:true}},async()=>{
        held++;
        if(held===expected.maxConcurrent)entered.resolve();
        await release.promise;
        return {content:[{type:'text',text:'released'}]};
      });
      return mcp;
    };
    await fixture(async(url,_token,{identities})=>{
      const identity=identities[id];
      const pending=Array.from({length:expected.maxConcurrent},(_,index)=>fetch(url+'/mcp',{method:'POST',headers:headers(identity.value),body:JSON.stringify({jsonrpc:'2.0',id:index+1,method:'tools/call',params:{name:'fixture_hold',arguments:{}}})}));
      const returnedBeforeRelease=Promise.race(pending).then(response=>{throw new Error(`A held request returned before the expected slots were occupied (HTTP ${response.status})`);});
      try {
        await Promise.race([entered.promise,returnedBeforeRelease]);
        assert.equal(identity.state.active,expected.maxConcurrent);
        const limited=await fetch(url+'/mcp',{headers:headers(identity.value)});
        assert.equal(limited.status,429);
        assert.equal(limited.headers.get('retry-after'),'1');
        assert.deepEqual(await limited.json(),{ok:false,error:'rate_limited',retryAfterSeconds:1,limits:expected});
        assert.equal((await fetch(url+'/mcp',{headers:headers(identities.other.value)})).status,405);
        assert.equal(identities.other.state.active,0);
        assert.equal(identity.state.requests,expected.maxConcurrent+1);
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
      }
      for(const response of await Promise.all(pending)) {
        assert.equal(response.status,200);
        const envelope=JSONRPCResponseSchema.parse(await response.json());assert.ok('result' in envelope);
        assert.deepEqual(CallToolResultSchema.parse(envelope.result).content,[{type:'text',text:'released'}]);
      }
      assert.equal(identity.state.active,0);
      assert.equal((await fetch(url+'/mcp',{headers:headers(identity.value)})).status,405);
      assert.equal(identity.state.requests,expected.maxConcurrent+2);
    },0,factory);
  }
});

test('global and input protection bounds are unchanged',()=>{
  assert.equal(limits.concurrentTotal,32);
  assert.equal(limits.bodyBytes,32768);
  assert.equal(limits.deadlineMs,30000);
});
