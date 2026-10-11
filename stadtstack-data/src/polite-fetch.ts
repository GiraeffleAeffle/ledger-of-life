import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {mkdir,readFile,writeFile,rename,lstat} from 'node:fs/promises';
import {join,resolve,basename,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {hash,ua} from './common.ts';
import {parseTdmRules,tdmRuleForUrl,inspectResourcePolicy,matchesPolicyPattern,ownerRobotsOverrideFor,ownerRobotsOverrideApplies,effectiveRobotsPermission,documentOriginExcludes,effectiveSourcePermission,APPROVED_OWNER_ROBOTS_OVERRIDE} from './source-policy.ts';
import type {SourceAccessPolicy,PolicyEvidence,TdmRule,OwnerRobotsOverride} from './source-policy.ts';
import {acquirePrivateRunLock,writePrivateJson} from './district-private-io.ts';
import {inspectPdfTdmPolicy} from './pdf-tdm-policy.ts';
import {isPublicAddress} from './public-address.ts';
import {classifyDocumentOrigin} from './document-origin.ts';
import {assertHostNotOptedOut,HostOptedOutError,CivicPolicyStateError,initializeManagedAcquisitionLane,withManagedSourceWrite,relinquishManagedSourceContent} from './civic-opt-out.ts';

export type FetchFailure='unsafe_url'|'robots_blocked'|'robots_unavailable'|'tdm_reserved'|'tdm_unavailable'|'access_barrier'|'dns_error'|'timeout'|'network_error'|'http_error'|'too_large'|'redirect_limit'|'invalid_redirect'|'cache_missing'|'unsupported_encoding'|'host_busy'|'host_state_unsafe'|'host_cooldown'|'host_opted_out'|'document_excluded';
export interface FetchObservation {
 url:string;method:'GET'|'POST';checkedAt:string;retrievedAt:string|null;state:'fetched'|'not_modified'|'redirected'|'failed'|'excluded';
 status?:number;failure?:FetchFailure;retryAfter?:string;sha256?:string;bytes?:number;mimeType?:string;etag?:string;lastModified?:string;location?:string;policy?:SourceAccessPolicy;exclusion?:ExcludedDocument['exclusion'];
}
export interface FetchedDocument {url:string;sha256:string;localPath:string;mimeType:string;retrievedAt:string;checkedAt:string;status:number;observationPath:string;policy?:SourceAccessPolicy}
export interface ExcludedDocument {url:string;sha256:string;mimeType:string;retrievedAt:string;checkedAt:string;status:number;observationPath:string;policy:SourceAccessPolicy;sizeBytes:number;exclusion:{reason:'non_official_restricted';excludedAt:string;previousManagedCopy:'removed'|'retained_independent'|'not_managed'|'partial'}}
export interface SourceContentBinding {url:string;sha256:string;observationPath:string;independentAllowed:boolean}
export function sourceContentBinding(document:FetchedDocument):SourceContentBinding {
 return {url:document.url,sha256:document.sha256,observationPath:document.observationPath,independentAllowed:!!document.policy&&effectiveSourcePermission(document.policy,document)};
}
export class PoliteFetchError extends Error {
 failure:FetchFailure;status?:number;policy?:SourceAccessPolicy;retryAfter?:string;robotsEvidence?:PolicyEvidence;excludedDocument?:ExcludedDocument;
 constructor(failure:FetchFailure,message:string,status?:number,policy?:SourceAccessPolicy,retryAfter?:string){super(message);this.name='PoliteFetchError';this.failure=failure;this.status=status;this.policy=policy;this.retryAfter=retryAfter;}
}
interface RobotsGroup {agents:string[];rules:{allow:boolean;pattern:string}[];delay:number}
export interface RobotsPolicy {rules:{allow:boolean;pattern:string}[];delayMs:number;evidence?:PolicyEvidence}
export function parseRobots(text:string,product='StadtstackData'):RobotsPolicy {
 const meaningful=text.replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>line.split('#')[0].trim()).filter(Boolean);
 if(meaningful.some(line=>/^<\s*(?:!doctype|[a-z])/i.test(line))||meaningful.length&&!meaningful.some(line=>/^(?:user-agent|sitemap|host)\s*:/i.test(line)))throw new PoliteFetchError('robots_unavailable','Robots endpoint returned HTML or an uninterpretable policy; ask municipality');
 const groups:RobotsGroup[]=[];let group:RobotsGroup|undefined,hasDirectives=false;
 for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  const match=/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(line.split('#')[0]);if(!match)continue;
  const key=match[1].toLowerCase(),value=match[2];
  if(key==='user-agent'){
   if(!group||hasDirectives){group={agents:[],rules:[],delay:0};groups.push(group);hasDirectives=false;}
   if(value)group.agents.push(value.toLowerCase());
  }else if(group){
   hasDirectives=true;
   if((key==='allow'||key==='disallow')&&value.startsWith('/'))group.rules.push({allow:key==='allow',pattern:value});
   if(key==='crawl-delay'&&/^\d+(?:\.\d+)?$/.test(value))group.delay=Math.max(group.delay,Number(value)*1000);
  }
 }
 const specificity=(g:RobotsGroup)=>Math.max(-1,...g.agents.map(agent=>agent==='*'?0:product.toLowerCase().includes(agent)?agent.length:-1));
 const best=Math.max(-1,...groups.map(specificity)),selected=groups.filter(g=>specificity(g)===best&&best>=0);
 return {rules:selected.flatMap(g=>g.rules),delayMs:Math.max(0,...selected.map(g=>g.delay))};
}
function robotsPath(value:string):string {
 return value.replace(/%([0-9a-f]{2})/gi,(_,hex:string)=>{const char=String.fromCharCode(parseInt(hex,16));return /[A-Za-z0-9._~-]/.test(char)?char:'%'+hex.toUpperCase();}).replace(/[^\x00-\x7F]/gu,char=>encodeURIComponent(char));
}
export function robotsAllows(policy:RobotsPolicy,url:string):boolean {
 const u=new URL(url),path=robotsPath(u.pathname+u.search);let longest=-1,allowed=true;
 for(const rule of policy.rules){
  const pattern=robotsPath(rule.pattern),end=pattern.endsWith('$'),body=end?pattern.slice(0,-1):pattern;
  const length=Buffer.byteLength(body.replace(/\*/g,''));
  if(matchesPolicyPattern(pattern,path)&&(length>longest||length===longest&&rule.allow)){longest=length;allowed=rule.allow;}
 }
 return allowed;
}
export function publicUrl(input:string):URL {
 let url:URL;try{url=new URL(input);}catch{throw new PoliteFetchError('unsafe_url','Invalid public URL');}
 const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||host.endsWith('.')||url.port&&!['80','443'].includes(url.port)||!host.includes('.')&&!isIP(host)||/\.(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)||isIP(host)&&!isPublicAddress(host))throw new PoliteFetchError('unsafe_url','Non-public or noncanonical URL rejected');
 for(const key of url.searchParams.keys())if(/^(?:token|access_token|api_key|apikey|password|secret|authorization|sessionid|phpsessid)$/i.test(key))throw new PoliteFetchError('unsafe_url','Credential-bearing URL rejected');
 url.hash='';return url;
}
interface WireResponse {status:number;headers:Record<string,string|undefined>;body:Buffer}
export interface FetchOptions {method?:'GET'|'POST';body?:string;machinePolicyUrls?:string[];ownerRobotsOverride?:OwnerRobotsOverride;registeredSourceUrl?:string;hostProfile?:'default'|'municipal';title?:string;linkText?:string;municipalityName?:string;administrativeOriginEvidence?:string|string[]}
export interface PoliteFetcherOptions {cacheDir:string;minDelayMs?:number;timeoutMs?:number;maxBytes?:number;maxRedirects?:number;policyTtlMs?:number;ownerPolicyLane?:{decisionId:typeof APPROVED_OWNER_ROBOTS_OVERRIDE.id;stateDir?:string}}
const sleep=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
interface HostState {
 schemaVersion:1;host:string;lastStart:number;delayMs:number;nextAllowedAt:number;
 failures:number[];stop:null|{status:number;reason:string;checkedAt:string;until:number};
}
// A process-independent location, deliberately not configurable by cacheDir or caller.
// Locks are never stolen: an interrupted owner requires operator review.
const sharedHostQueues=new Map<string,Promise<void>>();
const HOST_COOLDOWN_MS=60*60_000,HOST_FAILURE_WINDOW_MS=10*60_000;
function retryAfterTime(value:string|undefined,now:number):number {
 if(!value)return 0;
 const time=/^\d+$/.test(value.trim())?Math.min(8.64e15,now+Number(value)*1000):Date.parse(value);
 return Number.isFinite(time)?Math.max(now,time):0;
}
export class PoliteFetcher {
 readonly cacheDir:string;readonly options:Required<Omit<PoliteFetcherOptions,'ownerPolicyLane'>>;
 private delays=new Map<string,number>();
 private robots=new Map<string,{expiresAt:number;response:Promise<RobotsPolicy>}>();
 private machinePolicies=new Map<string,{expiresAt:number;response:Promise<{rules:TdmRule[];evidence:PolicyEvidence}>}>();
 private fetchCount=0;
 private initialization?:Promise<void>;private readonly lane:PoliteFetcherOptions['ownerPolicyLane'];
 get requestCount():number{return this.fetchCount;}
 constructor(options:PoliteFetcherOptions){
  this.cacheDir=resolve(options.cacheDir);this.options={minDelayMs:2000,timeoutMs:25000,maxBytes:24*1024*1024,maxRedirects:5,policyTtlMs:60*60_000,...options};
  this.lane=options.ownerPolicyLane;
  for(const key of ['minDelayMs','timeoutMs','maxBytes','maxRedirects','policyTtlMs'] as const)if(!Number.isFinite(this.options[key])||this.options[key]<0)throw Error(`Invalid ${key}`);
  if(this.options.policyTtlMs===0)throw Error('Policy TTL must be positive');
 }
 async initialize():Promise<void>{
  if(!this.lane)throw new PoliteFetchError('host_state_unsafe','Explicit owner-policy acquisition lane context is required; legacy cache roots are not enrolled');
  this.initialization??=initializeManagedAcquisitionLane(this.cacheDir,this.lane).catch(()=>{throw new PoliteFetchError('host_state_unsafe','Acquisition lane marker, ownership or completeness rejected; legacy and nonempty unmarked roots are not modified');});
  await this.initialization;
 }
 private policyStateDirectory():string|undefined{return this.lane?.stateDir;}
 async assertHostAllowed(url:string):Promise<void>{
  try{await assertHostNotOptedOut(url,{stateDir:this.policyStateDirectory()});}
  catch(error){if(error instanceof HostOptedOutError)throw new PoliteFetchError('host_opted_out','Host objection is active; acquisition and cached-source reuse stopped');throw new PoliteFetchError('host_state_unsafe','Host objection state is unavailable; acquisition stopped');}
 }
 async persistDerivedJson(path:string,value:unknown,bindings:SourceContentBinding[]):Promise<void>{
  await this.initialize();
  if(!bindings.length)throw new PoliteFetchError('cache_missing','Derived source content has no immutable provenance');
  const relativePath=relative(this.cacheDir,resolve(path));
  if(!relativePath||relativePath.startsWith('..')||isAbsolute(relativePath))throw new PoliteFetchError('cache_missing','Derived source cache escapes managed root');
  for(const binding of bindings)await this.assertHostAllowed(binding.url);
  const contentSha256=hash(JSON.stringify(value,null,2)+'\n');
  const entries=await Promise.all(bindings.map(async binding=>{
   const name=basename(binding.observationPath),observationPath=join(this.cacheDir,'observations',name);
   if(resolve(binding.observationPath)!==observationPath)throw new PoliteFetchError('cache_missing','Derived observation is outside the managed root');
   const bytes=await readFile(observationPath),observation=JSON.parse(bytes.toString('utf8')) as FetchObservation;
   if(observation.url!==binding.url||observation.sha256!==binding.sha256||!['fetched','not_modified'].includes(observation.state))throw new PoliteFetchError('cache_missing','Derived source observation mismatch');
   const independentAllowed=!!observation.policy&&effectiveSourcePermission(observation.policy,binding);
   return {relativePath,contentSha256,sourceSha256:binding.sha256,url:binding.url,observationId:name,receiptSha256:hash(bytes),independentAllowed};
  }));
  await withManagedSourceWrite(this.cacheDir,entries,async()=>{await writePrivateJson(path,value);},{stateDir:this.policyStateDirectory()});
 }
 private hostStateDirectory():string{return join(homedir(),'.cache','stadtstack-data','host-lanes');}
 private async scheduled<T>(url:URL,work:()=>Promise<T>,onResult?:(result:T,state:HostState)=>void):Promise<T>{
  const host=url.hostname,prior=sharedHostQueues.get(host)??Promise.resolve();
  const {promise:gate,resolve:unlock}=Promise.withResolvers<void>();sharedHostQueues.set(host,gate);await prior;
  let release:(()=>Promise<void>)|undefined;
  try{
   const directory=this.hostStateDirectory(),uid=process.getuid?.();
   // Reject symlink components; the lane directory and its files must be owner-only.
   let current=resolve(directory).startsWith('/')?'/':'';
   for(const component of resolve(directory).split('/').filter(Boolean)){
    current=join(current,component);
    try{await mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const metadata=await lstat(current);
    if(!metadata.isDirectory()||metadata.isSymbolicLink()||current===directory&&(metadata.uid!==uid||(metadata.mode&0o077)!==0))throw new PoliteFetchError('host_state_unsafe','Shared host directory is not private or contains a symlink');
   }
   const path=join(directory,host+'.json'),lock=join(directory,host+'.lock');
   try{release=await acquirePrivateRunLock(lock,'exact-host polite request lane');}
   catch(error){throw new PoliteFetchError((error as NodeJS.ErrnoException).code==='EEXIST'?'host_busy':'host_state_unsafe','Shared host lane unavailable; do not steal or automatically remove its lock');}
   let state:HostState;
   try{
    const metadata=await lstat(path);
    if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==uid||(metadata.mode&0o077)!==0||metadata.size>16384)throw Error('Unsafe state');
    state=JSON.parse(await readFile(path,'utf8'));
    if(state.schemaVersion!==1||state.host!==host||![state.lastStart,state.delayMs,state.nextAllowedAt,...state.failures].every(value=>Number.isSafeInteger(value)&&value>=0)||state.delayMs<2000||state.failures.length>3||state.stop!==null&&(!Number.isInteger(state.stop.status)||![403,429].includes(state.stop.status)&&(state.stop.status<500||state.stop.status>599)||!Number.isSafeInteger(state.stop.until)||state.stop.until<0||state.stop.until>8.64e15||!Number.isFinite(Date.parse(state.stop.checkedAt))||typeof state.stop.reason!=='string'))throw Error('Invalid state');
   }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new PoliteFetchError('host_state_unsafe','Shared host pacing/circuit state rejected; operator review required');
    state={schemaVersion:1,host,lastStart:0,delayMs:2000,nextAllowedAt:0,failures:[],stop:null};
   }
   const now=Date.now();
   if(state.stop&&now<state.stop.until)throw new PoliteFetchError('host_cooldown',state.stop.reason,undefined,undefined,new Date(state.stop.until).toISOString());
   if(now<state.nextAllowedAt)throw new PoliteFetchError('host_cooldown','Host backoff remains active; no automatic retry',undefined,undefined,new Date(state.nextAllowedAt).toISOString());
   state.delayMs=Math.ceil(Math.min(8.64e15,Math.max(2000,state.delayMs,this.options.minDelayMs,this.delays.get(host)??0)));
   const pause=Math.max(0,state.lastStart+state.delayMs-now);
   if(!Number.isFinite(pause)||pause>60000)throw new PoliteFetchError('host_cooldown','Required host spacing exceeds bounded wait',undefined,undefined,new Date(Math.min(8.64e15,state.lastStart+state.delayMs)).toISOString());
   await sleep(pause);
   await this.assertHostAllowed(url.href);
   state.lastStart=Date.now();await writePrivateJson(path,state);
   await this.assertHostAllowed(url.href);
   // Persist before dispatch for crash safety, then retain the actual dispatch time.
   // An unsuccessful state commit leaves the owner lock in place, never a restart bypass.
   state.lastStart=Date.now();
   try{const result=await work();onResult?.(result,state);return result;}
   finally{try{await writePrivateJson(path,state);}catch(error){release=undefined;throw error;}}
  }catch(error){
   if(error instanceof PoliteFetchError)throw error;
   throw new PoliteFetchError('host_state_unsafe','Shared host state operation failed; no retry');
  }finally{
   try{await release?.();}finally{unlock();if(sharedHostQueues.get(host)===gate)sharedHostQueues.delete(host);}
  }
 }
 private recordHostResponse(url:URL,response:WireResponse,state:HostState):void {
  const now=Date.now(),status=response.status,retryAt=retryAfterTime(response.headers['retry-after'],now);
  state.failures=state.failures.filter(time=>now-time<HOST_FAILURE_WINDOW_MS);
  if(status===403||status===429){
   const until=Math.max(now+HOST_COOLDOWN_MS,retryAt);
   state.stop={status,reason:`HTTP ${status}; host cooldown; no automatic retry`,checkedAt:new Date(now).toISOString(),until};state.nextAllowedAt=until;
  }else if(status>=500&&status<=599){
   state.failures.push(now);
   state.nextAllowedAt=Math.max(now+Math.min(60_000,5000*2**(state.failures.length-1)),retryAt);
   if(state.failures.length>=3){const until=Math.max(now+HOST_COOLDOWN_MS,retryAt);state.stop={status,reason:'Three HTTP 5xx responses within ten minutes; host circuit stopped',checkedAt:new Date(now).toISOString(),until};state.nextAllowedAt=until;}
  }
  if(url.pathname==='/robots.txt'&&status===200){
   try{state.delayMs=Math.ceil(Math.min(8.64e15,Math.max(state.delayMs,parseRobots(response.body.toString('utf8')).delayMs)));}catch{/* Uninterpretable policy remains unavailable; never invent an allow. */}
  }
 }
 private async wire(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined):Promise<WireResponse>{
   await this.assertHostAllowed(url.href);
   await this.initialize();
   const host=url.hostname.replace(/^\[|\]$/g,'');
   let addresses:{address:string;family:number}[],dnsTimer:NodeJS.Timeout|undefined;
   try{addresses=await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(new PoliteFetchError('timeout','DNS deadline exceeded')),this.options.timeoutMs);})]);}
   catch(error){if(error instanceof PoliteFetchError)throw error;throw new PoliteFetchError('dns_error','Public DNS lookup failed');}
   finally{clearTimeout(dnsTimer);}
   if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)))throw new PoliteFetchError('unsafe_url','DNS resolved a non-public address');
   const pinned=addresses[0];
  return this.scheduled(url,()=>new Promise<WireResponse>((done,reject)=>{
    const headers:Record<string,string>={'User-Agent':ua,Accept:'application/json,text/html,application/pdf,text/plain;q=0.8','Accept-Encoding':'identity'};
    if(body!==undefined){headers['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';headers['Content-Length']=String(Buffer.byteLength(body));}
    if(method==='GET'&&validators?.etag)headers['If-None-Match']=validators.etag;
    if(method==='GET'&&validators?.lastModified)headers['If-Modified-Since']=validators.lastModified;
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method,headers,agent:false,family:pinned.family,lookup:(_name,_options,callback)=>callback(null,pinned.address,pinned.family)},response=>{
     const status=response.statusCode??0;
     const selected:Record<string,string|undefined>={};for(const key of ['content-type','content-length','content-encoding','etag','last-modified','location','tdm-reservation','tdm-policy','x-robots-tag','retry-after']){const value=response.headers[key];selected[key]=Array.isArray(value)?value[0]:value;}
     if(status>=300){response.destroy();clearTimeout(timer);done({status,headers:selected,body:Buffer.alloc(0)});return;}
     const encoding=selected['content-encoding']?.toLowerCase()??'identity';
     if(!['identity','gzip','deflate','br'].includes(encoding)){request.destroy(new PoliteFetchError('unsupported_encoding','Unsupported content encoding'));return;}
     if(Number(selected['content-length'])>this.options.maxBytes){request.destroy(new PoliteFetchError('too_large','Response exceeds byte bound'));return;}
     const decoder=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null;
     const stream=decoder?response.pipe(decoder):response,chunks:Buffer[]=[];let bytes=0,wireBytes=0;
     if(decoder)response.on('data',(chunk:Buffer)=>{wireBytes+=chunk.length;if(wireBytes>this.options.maxBytes)request.destroy(new PoliteFetchError('too_large','Encoded response exceeds byte bound'));});
     stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>this.options.maxBytes){request.destroy(new PoliteFetchError('too_large','Decoded response exceeds byte bound'));decoder?.destroy();return;}chunks.push(chunk);});
     stream.on('end',()=>{clearTimeout(timer);done({status,headers:selected,body:Buffer.concat(chunks,bytes)});});
     stream.on('error',(error:Error)=>{clearTimeout(timer);request.destroy();reject(error instanceof PoliteFetchError?error:new PoliteFetchError('network_error','Response stream failed'));});
     if(decoder)response.on('error',error=>decoder.destroy(error));
    });
    const timer=setTimeout(()=>request.destroy(new PoliteFetchError('timeout','Request deadline exceeded')),this.options.timeoutMs);
    request.on('error',error=>{clearTimeout(timer);reject(error instanceof PoliteFetchError?error:new PoliteFetchError('network_error','Public request failed'));});
    request.end(body);
   }),(response,state)=>this.recordHostResponse(url,response,state));
 }
 private async observation(value:FetchObservation,path=join(this.cacheDir,'observations',`${Date.now()}-${randomUUID()}.json`)):Promise<string>{
  await this.initialize();
  await mkdir(join(this.cacheDir,'observations'),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});return path;
 }
 private async policy(url:URL,hostProfile?:FetchOptions['hostProfile']):Promise<RobotsPolicy>{
  let cached=this.robots.get(url.origin);
  if(!cached||Date.now()>=cached.expiresAt){const pending=(async()=>{
   const attemptedAt=new Date().toISOString();let result:FetchedDocument|undefined;
   try{
    result=await this.fetchInternal(new URL('/robots.txt',url).href,{hostProfile},false,false);
    const policy=parseRobots(await readFile(result.localPath,'utf8'));policy.evidence={url:result.url,locator:'robots.txt applicable StadtstackData group',value:'checked',sha256:result.sha256,checkedAt:result.checkedAt};this.delays.set(url.hostname,Math.max(this.delays.get(url.hostname)??0,policy.delayMs));return policy;
   }catch(error){
    // RFC 9309 unavailable 404/410 allows access; 401/403/429 and failures fail closed.
    if(error instanceof PoliteFetchError&&(error.status===404||error.status===410))return {rules:[],delayMs:0,evidence:{url:new URL('/robots.txt',url).href,locator:'robots.txt HTTP absence',value:String(error.status),checkedAt:new Date().toISOString()}};
    if(error instanceof PoliteFetchError&&(error.failure==='access_barrier'||error.failure==='unsafe_url'||error.status===429||error.failure.startsWith('host_')))throw error;
    const failure=new PoliteFetchError('robots_unavailable',`Robots policy unavailable${error instanceof PoliteFetchError&&error.status?` (policy HTTP ${error.status})`:''}; source existence is unknown`,error instanceof PoliteFetchError?error.status:undefined,undefined,error instanceof PoliteFetchError?error.retryAfter:undefined);
    failure.robotsEvidence={url:new URL('/robots.txt',url).href,locator:'Actual robots retrieval/interpretation attempt unavailable',value:'unavailable',checkedAt:result?.checkedAt??attemptedAt,...(result?{sha256:result.sha256}:{})};throw failure;
   }
  })();cached={expiresAt:Date.now()+this.options.policyTtlMs,response:pending};this.robots.set(url.origin,cached);}
  return cached.response;
 }
 private async machinePolicy(url:URL,knownUrl?:string,ownerRobotsOverride?:OwnerRobotsOverride,hostProfile?:FetchOptions['hostProfile']):Promise<{rules:TdmRule[];evidence:PolicyEvidence}>{
  const policyUrl=knownUrl?publicUrl(knownUrl).href:new URL('/.well-known/tdmrep.json',url).href;
  const cacheKey=`${knownUrl?'required':'standard'}:${policyUrl}:${ownerRobotsOverrideApplies(policyUrl,ownerRobotsOverride)?ownerRobotsOverride!.id:'no-override'}`;
  let cached=this.machinePolicies.get(cacheKey);
  if(!cached||Date.now()>=cached.expiresAt){
   const pending=(async()=>{
    // Standardized location, not a guessed municipal API: W3C TDMRep 2024 §6.1.
    try{
     const response=await this.fetchInternal(policyUrl,{ownerRobotsOverride,hostProfile},true,false);
     if(!/json/.test(response.mimeType)){if(knownUrl)throw Error('Known machine policy has no interpretable JSON representation');return {rules:[],evidence:{url:policyUrl,locator:'TDMRep standardized location returned no JSON representation',value:'not_implemented',sha256:response.sha256,checkedAt:response.checkedAt}};}
     return {rules:parseTdmRules(JSON.parse(await readFile(response.localPath,'utf8'))),evidence:{url:policyUrl,locator:'W3C TDMRep origin rules',value:'checked',sha256:response.sha256,checkedAt:response.checkedAt}};
    }catch(error){
     if(!knownUrl&&error instanceof PoliteFetchError&&(error.status===404||error.status===410))return {rules:[],evidence:{url:policyUrl,locator:'TDMRep standardized location HTTP absence',value:String(error.status),checkedAt:new Date().toISOString()}};
     if(error instanceof PoliteFetchError&&(error.failure==='access_barrier'||error.failure==='unsafe_url'||error.status===429||error.failure.startsWith('host_')))throw error;
     throw new PoliteFetchError('tdm_unavailable',`Machine-readable TDM policy could not be checked${error instanceof PoliteFetchError&&error.status?` (policy HTTP ${error.status})`:''}; ask municipality`,error instanceof PoliteFetchError?error.status:undefined,undefined,error instanceof PoliteFetchError?error.retryAfter:undefined);
    }
   })();cached={expiresAt:Date.now()+this.options.policyTtlMs,response:pending};this.machinePolicies.set(cacheKey,cached);
  }
  return cached.response;
 }
 async fetch(url:string,options:FetchOptions={}):Promise<FetchedDocument>{await this.initialize();this.fetchCount++;return this.fetchInternal(url,options,true);}
 private async fetchInternal(input:string,options:FetchOptions,checkRobots:boolean,checkTdm=true):Promise<FetchedDocument>{
  let url=publicUrl(input),method=options.method??'GET',body=options.body;
  const registeredApproval=ownerRobotsOverrideApplies(options.registeredSourceUrl??input,options.ownerRobotsOverride);
  if(method==='POST'&&(!body||Buffer.byteLength(body)>65536))throw new PoliteFetchError('unsafe_url','Only bounded public form requests supported');
  if(body!==undefined)for(const key of new URLSearchParams(body).keys())if(/^(?:password|secret|authorization|access_token|api_key|apikey|sessionid|phpsessid|cookie)$/i.test(key))throw new PoliteFetchError('unsafe_url','Credential-bearing public form rejected');
  for(let redirects=0;redirects<=this.options.maxRedirects;redirects++){
   if(options.hostProfile==='municipal')this.delays.set(url.hostname,Math.max(5000,this.delays.get(url.hostname)??0));
   let checkedAt=new Date().toISOString();const observation:FetchObservation={url:url.href,method,checkedAt,retrievedAt:null,state:'failed'};
   const policy:SourceAccessPolicy={robots:{state:'unavailable',url:new URL('/robots.txt',url).href},tdm:{state:'unavailable',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'};
   observation.policy=policy;
   try{
    await this.assertHostAllowed(url.href);
    if(/\/(?:login|signin|auth|anmelden)(?:\/|$)/i.test(url.pathname)){policy.access='authentication';throw new PoliteFetchError('access_barrier','Authentication endpoint is outside public acquisition');}
    if(checkRobots){
     let robots:RobotsPolicy|undefined;
     try{robots=await this.policy(url,options.hostProfile);}
     catch(error){
      if(!(error instanceof PoliteFetchError)||error.failure!=='robots_unavailable'||!registeredApproval)throw error;
      policy.robots.checkedAt=error.robotsEvidence?.checkedAt;policy.robots.sha256=error.robotsEvidence?.sha256;
     }
     if(robots){policy.robots.url=robots.evidence?.url??policy.robots.url;policy.robots.sha256=robots.evidence?.sha256;policy.robots.checkedAt=robots.evidence?.checkedAt;policy.robots.state=robotsAllows(robots,url.href)?'allowed':'blocked';}
     if(policy.robots.state!=='allowed'){
      if(registeredApproval){
       policy.ownerRobotsOverride=ownerRobotsOverrideFor(url.href)!;policy.robotsStatus=policy.robots.state==='blocked'?'disallowed':'unavailable';policy.override='owner-approved 2026-10-11';
       if(!effectiveRobotsPermission(policy,url.href)){delete policy.ownerRobotsOverride;delete policy.robotsStatus;delete policy.override;}
      }
      if(!effectiveRobotsPermission(policy,url.href))throw new PoliteFetchError(policy.robots.state==='blocked'?'robots_blocked':'robots_unavailable','Robots policy does not permit request and no evidenced owner exception applies');
     }
    }
    if(checkTdm){
     policy.tdm.state='not_declared';
     const knownPolicies=(options.machinePolicyUrls??[]).filter(value=>{const candidate=publicUrl(value);return candidate.pathname!=='/robots.txt'&&candidate.origin===url.origin;});
     for(const knownUrl of [undefined,...knownPolicies]){
      let originPolicy:{rules:TdmRule[];evidence:PolicyEvidence};
      try{originPolicy=await this.machinePolicy(url,knownUrl,registeredApproval?ownerRobotsOverrideFor(url.href)??undefined:undefined,options.hostProfile);}catch(error){policy.tdm.state='unavailable';policy.tdm.evidence.push({url:knownUrl??new URL('/.well-known/tdmrep.json',url).href,locator:'Machine policy retrieval or interpretation failed',value:'inaccessible',checkedAt});throw error;}
      policy.tdm.evidence.push(originPolicy.evidence);const rule=tdmRuleForUrl(originPolicy.rules,url.href);
      if(rule){if(policy.tdm.state!=='reserved')policy.tdm.state=rule['tdm-reservation']===1?'reserved':'not_reserved';policy.tdm.evidence.push({...originPolicy.evidence,locator:`TDMRep matching location ${rule.location}`,value:String(rule['tdm-reservation'])});}
      if(policy.tdm.state==='reserved'&&!registeredApproval)throw new PoliteFetchError('tdm_reserved','Machine-readable TDM reservation; no owner-authorized official-work exception');
     }
    }
    const key=hash(method+' '+url.href+'\n'+(body??'')),meta=join(this.cacheDir,'requests',key+'.json');let previous:FetchObservation|undefined;
    try{previous=JSON.parse(await readFile(meta,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new PoliteFetchError('cache_missing','Invalid cache metadata');}
    const response=await this.wire(url,method,body,previous?.state==='excluded'?undefined:previous);checkedAt=new Date().toISOString();observation.checkedAt=checkedAt;observation.status=response.status;
    if([301,302,303,307,308].includes(response.status)){
     if(!response.headers.location)throw new PoliteFetchError('invalid_redirect','Missing redirect destination',response.status);
     const next=publicUrl(new URL(response.headers.location,url).href);observation.location=next.href;observation.state='redirected';
     if(/\/(?:login|signin|auth|anmelden)(?:\/|$)/i.test(next.pathname)){policy.access='authentication';throw new PoliteFetchError('access_barrier','Authentication redirect; ask municipality');}
     if(!checkRobots)throw new PoliteFetchError('invalid_redirect','Robots retrieval redirect cannot establish independently checked destination policy',response.status);
     await this.observation(observation);
     if(redirects===this.options.maxRedirects)throw new PoliteFetchError('redirect_limit','Redirect bound exceeded');
     if(method==='POST'&&next.origin!==url.origin)throw new PoliteFetchError('invalid_redirect','Cross-origin form redirect rejected');
     if(response.status===303||method==='POST'&&[301,302].includes(response.status)){method='GET';body=undefined;}
     url=next;continue;
    }
    const cooldown=ownerRobotsOverrideFor(url.href)&&(response.status===403||response.status===429)?new Date(Math.max(Date.now()+HOST_COOLDOWN_MS,retryAfterTime(response.headers['retry-after'],Date.now()))).toISOString():undefined;
    if([401,402,403].includes(response.status)){policy.access=response.status===402?'paywall':'authentication';throw new PoliteFetchError('access_barrier',`HTTP ${response.status} access barrier; ask municipality`,response.status,undefined,cooldown);}
    if(response.status===429)throw new PoliteFetchError('http_error','HTTP 429 rate limit; no automatic retry',429,undefined,cooldown);
    await this.assertHostAllowed(url.href);
    let representation:Buffer,sha256:string,retrievedAt:string,localPath:string,mimeType:string;
    if(response.status===304){
     if(!previous?.sha256||!previous.retrievedAt||previous.state==='excluded')throw new PoliteFetchError('cache_missing','304 without an eligible retained representation',304);
     sha256=previous.sha256;retrievedAt=previous.retrievedAt;localPath=join(this.cacheDir,'sha256',sha256);mimeType=previous.mimeType??'application/octet-stream';
     try{representation=await readFile(localPath);}catch{throw new PoliteFetchError('cache_missing','304 raw bytes missing',304);}
     if(hash(representation)!==sha256)throw new PoliteFetchError('cache_missing','304 raw digest mismatch',304);
     if(previous.policy?.tdm.evidence.some(item=>item.locator==='HTTP TDM-Reservation'&&item.value==='1'))response.headers['tdm-reservation']??='1';
     Object.assign(observation,previous,{url:url.href,method,checkedAt,state:'not_modified',status:304,policy});
    }else{
     if(response.status<200||response.status>=300)throw new PoliteFetchError('http_error',`HTTP ${response.status}`,response.status);
     representation=response.body;sha256=hash(representation);retrievedAt=checkedAt;
     const prefix=representation.subarray(0,256).toString('utf8').trimStart();
     mimeType=prefix.startsWith('%PDF-')?'application/pdf':representation.length>=4&&representation[0]===0x50&&representation[1]===0x4b&&[3,5,7].includes(representation[2])?'application/zip':(response.headers['content-type']??'application/octet-stream').split(';')[0].trim().toLowerCase();
     if((mimeType==='application/octet-stream'||mimeType==='text/plain')&&/^<\?xml\b|^<(?:gml|xplan|wfs):/i.test(prefix))mimeType='application/xml';
     localPath=join(this.cacheDir,'sha256',sha256);
     Object.assign(observation,{state:'fetched',sha256,retrievedAt,mimeType,bytes:representation.length});
    }
    const resourcePolicy=inspectResourcePolicy(url.href,response.headers,representation,mimeType);policy.access=resourcePolicy.access;policy.tdm.evidence.push(...resourcePolicy.evidence);
    if(resourcePolicy.reservation!==null&&policy.tdm.state!=='reserved')policy.tdm.state=resourcePolicy.reservation===1?'reserved':'not_reserved';
    if(policy.access!=='public')throw new PoliteFetchError('access_barrier',`${policy.access} barrier; ask municipality`);
    if(checkTdm&&policy.tdm.state==='reserved'&&!registeredApproval)throw new PoliteFetchError('tdm_reserved','Machine-readable TDM reservation; no owner-authorized official-work exception');
    if(checkTdm)policy.documentOrigin=await classifyDocumentOrigin({url:url.href,mimeType,bytes:representation,title:options.title,linkText:options.linkText,municipalityName:options.municipalityName,administrativeOriginEvidence:options.administrativeOriginEvidence});
    if(checkTdm&&mimeType==='application/pdf'){
     let pdfPolicy;
     try{pdfPolicy=await inspectPdfTdmPolicy(representation,sha256,this.cacheDir);}catch{
      const exclude=documentOriginExcludes(policy,{url:url.href,sha256});
      if(policy.tdm.state!=='reserved')policy.tdm.state='unavailable';
      policy.tdm.evidence.push({url:url.href,locator:'Bounded PDF TDM metadata parser',value:'parser_or_cache_unavailable',sha256,checkedAt});
      if(!exclude)throw new PoliteFetchError('tdm_unavailable','PDF TDM metadata could not be checked; ask municipality');
     }
     if(pdfPolicy){
      const finding=pdfPolicy.finding;
      policy.tdm.evidence.push({url:url.href,locator:`PDF.js ${pdfPolicy.pdfjsVersion} XMP metadata (${pdfPolicy.policyVersion})`,value:finding.state==='unavailable'?finding.reason:finding.reservation===null?'no_tdm_reservation_field':String(finding.reservation),sha256,checkedAt:pdfPolicy.checkedAt});
      if(finding.state==='unavailable'){
       const exclude=documentOriginExcludes(policy,{url:url.href,sha256});if(policy.tdm.state!=='reserved')policy.tdm.state='unavailable';
       if(!exclude)throw new PoliteFetchError('tdm_unavailable','PDF TDM metadata parsing unavailable; ask municipality');
      }else{
       if(finding.policyPresent)policy.tdm.evidence.push({url:url.href,locator:'PDF TDM namespace policy property',value:'present',sha256,checkedAt:pdfPolicy.checkedAt});
       if(finding.reservation!==null&&policy.tdm.state!=='reserved')policy.tdm.state=finding.reservation===1?'reserved':'not_reserved';
      }
     }
    }
    if(checkTdm&&policy.tdm.state==='reserved'&&!registeredApproval)throw new PoliteFetchError('tdm_reserved','PDF machine-readable TDM reservation; no owner-authorized official-work exception');
    await this.assertHostAllowed(url.href);
    if(checkTdm&&documentOriginExcludes(policy,{url:url.href,sha256})){
     const previousManagedCopy=(await relinquishManagedSourceContent(this.cacheDir,{url:url.href,sourceSha256:sha256},{stateDir:this.policyStateDirectory()})).disposition;
     const exclusion:ExcludedDocument['exclusion']={reason:'non_official_restricted',excludedAt:new Date().toISOString(),previousManagedCopy};
     Object.assign(observation,{state:'excluded',exclusion,sha256,retrievedAt,mimeType,bytes:representation.length});delete observation.etag;delete observation.lastModified;
     const observationPath=await this.observation(observation);await mkdir(join(this.cacheDir,'requests'),{recursive:true});
     const temporary=meta+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(observation),{mode:0o600,flag:'wx'});await rename(temporary,meta);
     const failure=new PoliteFetchError('document_excluded','Non-official or uncertain work excluded under robots denial or TDM reservation',response.status,policy);
     failure.excludedDocument={url:url.href,sha256,mimeType,retrievedAt,checkedAt,status:response.status,observationPath,policy,sizeBytes:representation.length,exclusion};throw failure;
    }
    if(checkTdm&&policy.tdm.state==='reserved'&&registeredApproval&&policy.documentOrigin?.classification==='official_work'){
     policy.ownerTdmOverride=ownerRobotsOverrideFor(url.href)!;policy.tdmOverride='owner-approved 2026-10-11';
    }
    if(checkTdm&&!effectiveSourcePermission(policy,{url:url.href,sha256}))throw new PoliteFetchError(policy.tdm.state==='reserved'?'tdm_reserved':'tdm_unavailable','Source policy does not authorize retaining this representation');
    observation.etag=response.headers.etag??observation.etag;observation.lastModified=response.headers['last-modified']??observation.lastModified;
    const observationPath=join(this.cacheDir,'observations',`${Date.now()}-${randomUUID()}.json`);
    const persist=async()=>{
     await this.assertHostAllowed(url.href);
     await mkdir(join(this.cacheDir,'sha256'),{recursive:true});await writeFile(localPath,representation,{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});
     await this.observation(observation,observationPath);await mkdir(join(this.cacheDir,'requests'),{recursive:true});const temporary=meta+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(observation),{mode:0o600,flag:'wx'});await rename(temporary,meta);
    };
    await withManagedSourceWrite(this.cacheDir,[{relativePath:'sha256/'+sha256,contentSha256:sha256,sourceSha256:sha256,url:url.href,observationId:basename(observationPath),receiptSha256:hash(JSON.stringify(observation,null,2)+'\n'),independentAllowed:checkTdm&&effectiveSourcePermission(policy,{url:url.href,sha256})}],persist,{stateDir:this.policyStateDirectory()});
    return {url:url.href,sha256,localPath,mimeType,retrievedAt,checkedAt,status:response.status,observationPath,policy};
   }catch(error){
    if(error instanceof PoliteFetchError&&error.excludedDocument)throw error;
    const failure=error instanceof PoliteFetchError?error:error instanceof HostOptedOutError?new PoliteFetchError('host_opted_out','Host objection is active; source retention stopped'):error instanceof CivicPolicyStateError?new PoliteFetchError('host_state_unsafe','Managed source inventory is incomplete or unavailable; use an explicitly registered safe acquisition lane'):new PoliteFetchError('network_error','Fetch or cache operation failed');failure.policy=policy;observation.state='failed';observation.failure=failure.failure;observation.retryAfter=failure.retryAfter;await this.observation(observation);throw failure;
   }
  }
  throw new PoliteFetchError('redirect_limit','Redirect bound exceeded');
 }
}
