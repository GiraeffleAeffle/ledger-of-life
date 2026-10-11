import {createHash, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {pathToFileURL} from 'node:url';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {hostedServer} from './mcp-tools.ts';
import {loadRelease} from './mcp-release.ts';
import {governedReleaseDirectory} from './governed-release-directory.ts';
import {DEFAULT_TOKEN_LIMITS,validateTokenRecords,type TokenLimits} from './mcp-token-config.mjs';

export const limits = Object.freeze({requestsPerMinute:DEFAULT_TOKEN_LIMITS.requestsPerMinute, concurrentPerToken:DEFAULT_TOKEN_LIMITS.maxConcurrent, bodyBytes:32768, deadlineMs:30000, concurrentTotal:32});
export interface TokenState {
  readonly id:string;
  readonly digest:Buffer;
  readonly limits:Readonly<TokenLimits>;
  window:number;
  requests:number;
  active:number;
}
export async function loadTokens(path:string):Promise<TokenState[]> {
  const records=validateTokenRecords(JSON.parse(await readFile(path,'utf8')));
  // Configuration is a startup snapshot. Secret changes require a controlled restart.
  return records.map(record=>({
    id:record.id,digest:Buffer.from(record.sha256,'hex'),
    limits:Object.freeze(record.limits??DEFAULT_TOKEN_LIMITS),window:0,requests:0,active:0,
  }));
}
function reply(res:ServerResponse,status:number,headers:Record<string,string>={},payload:unknown={ok:status===200}) {
  if (res.headersSent) {res.destroy();return;}
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','connection':'close',...headers});
  res.end(JSON.stringify(payload));
}
async function body(req:IncomingMessage):Promise<unknown> {
  const chunks:Buffer[]=[]; let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>limits.bodyBytes) throw Object.assign(Error('body too large'),{status:413});
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {throw Object.assign(Error('invalid JSON'),{status:400});}
}
export function createHostedHttp(tokens:TokenState[], factory=hostedServer, origin='https://mcp.stadtstack.eu', now:()=>number=Date.now) {
  const publicUrl=new URL(origin);
  if(publicUrl.protocol!=='https:' || publicUrl.pathname!=='/' || publicUrl.search || publicUrl.hash) throw Error('HTTPS public origin required');
  let active=0;
  const counts={requests:0,unauthorized:0,limited:0,errors:0};
  const http=createServer({maxHeaderSize:8192,requestTimeout:limits.deadlineMs,headersTimeout:10000,keepAliveTimeout:5000},async(req,res)=>{
    counts.requests++;
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    const authorization=req.headers.authorization;
    let token:TokenState|undefined;
    if(authorization && /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) {
      const digest=createHash('sha256').update(authorization.slice(7)).digest();
      for(const candidate of tokens) if(timingSafeEqual(digest,candidate.digest)) token=candidate;
    }
    if(token) {
      const nowMs=now(),minute=Math.floor(nowMs/60000);
      if(token.window!==minute) {token.window=minute;token.requests=0;}
      // Count authenticated HTTP requests, not just useful tool calls. Invalid
      // routes, protocol messages and concurrency rejections consume the budget.
      const rateExceeded=token.requests>=token.limits.requestsPerMinute;
      if(!rateExceeded)token.requests++;
      if(rateExceeded || token.active>=token.limits.maxConcurrent) {
        counts.limited++;
        const retryAfterSeconds=token.requests>=token.limits.requestsPerMinute ? 60-Math.floor(nowMs/1000)%60 : 1;
        reply(res,429,{'retry-after':String(retryAfterSeconds)},{ok:false,error:'rate_limited',retryAfterSeconds,limits:token.limits});
        return;
      }
    }
    if(req.url==='/health' && req.method==='GET') {reply(res,200);return;}
    if(req.url!=='/mcp') {reply(res,404);return;}
    // Query-string credentials, arbitrary browser origins and forwarded host trust are deliberately unsupported.
    if(req.headers.origin && req.headers.origin!==publicUrl.origin) {reply(res,403);return;}
    const host=req.headers.host??'';
    if(host!==publicUrl.host && !/^127\.0\.0\.1(?::\d+)?$/.test(host) && !/^localhost(?::\d+)?$/.test(host)) {reply(res,403);return;}
    if(!token) {counts.unauthorized++;reply(res,401,{'www-authenticate':'Bearer realm="stadtstack-mcp"'});return;}
    if(req.method!=='POST') {reply(res,405,{'allow':'POST'});return;}
    if(active>=limits.concurrentTotal) {counts.limited++;reply(res,503,{'retry-after':'1'});return;}
    if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']??'') || req.headers['content-encoding']) {reply(res,415);return;}
    const length=req.headers['content-length'];
    if(length && (!/^\d+$/.test(length) || Number(length)>limits.bodyBytes)) {reply(res,413);return;}
    token.active++; active++;
    let instance:McpServer|undefined;
    let transport:StreamableHTTPServerTransport|undefined;
    let released=false;
    const cleanup=()=>{
      if(released)return;
      released=true;clearTimeout(deadline);token!.active--;active--;
      void transport?.close().catch(()=>{});void instance?.close().catch(()=>{});
    };
    const deadline=setTimeout(()=>{counts.errors++;reply(res,408);req.destroy();cleanup();},limits.deadlineMs);
    res.once('close',cleanup);
    try {
      const parsed=await body(req);
      if(res.destroyed || released)return;
      // Batches are disallowed; the quota counts each authenticated HTTP request.
      if(Array.isArray(parsed)) {reply(res,400);return;}
      instance=factory();
      transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      await instance.connect(transport);
      await transport.handleRequest(req,res,parsed);
    } catch(error) {
      counts.errors++;
      const status=error instanceof Error && 'status' in error ? error.status : undefined;
      reply(res,status===413||status===400?status:500);
    } finally {cleanup();}
  });
  http.maxConnections=128;
  const metrics=setInterval(()=>{
    // Aggregate counts only: no IPs, token identifiers, URLs, prompts, bodies or errors.
    console.info(JSON.stringify(counts));
    counts.requests=counts.unauthorized=counts.limited=counts.errors=0;
  },60000).unref();
  http.once('close',()=>clearInterval(metrics));
  return http;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    await loadRelease(governedReleaseDirectory(),{mode:'sealed'});
    const tokens=await loadTokens(process.env.MCP_TOKEN_HASH_FILE??'/run/secrets/mcp/token-hashes.json');
    const http=createHostedHttp(tokens,hostedServer,process.env.MCP_PUBLIC_ORIGIN);
    http.listen(Number(process.env.STADTSTACK_MCP_PORT??4318),'0.0.0.0');
    for(const signal of ['SIGTERM','SIGINT'] as const) process.once(signal,()=>{http.close();http.closeAllConnections();});
  } catch {console.error('MCP startup configuration invalid');process.exitCode=1;}
}
