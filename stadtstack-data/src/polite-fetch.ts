import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {hash,ua} from './common.ts';
import {parseTdmRules,tdmRuleForUrl,inspectResourcePolicy,matchesPolicyPattern} from './source-policy.ts';
import type {SourceAccessPolicy,PolicyEvidence,TdmRule} from './source-policy.ts';
import {inspectPdfTdmPolicy} from './pdf-tdm-policy.ts';
import {isPublicAddress} from './public-address.ts';

export type FetchFailure='unsafe_url'|'robots_blocked'|'robots_unavailable'|'tdm_reserved'|'tdm_unavailable'|'access_barrier'|'dns_error'|'timeout'|'network_error'|'http_error'|'too_large'|'redirect_limit'|'invalid_redirect'|'cache_missing'|'unsupported_encoding';
export interface FetchObservation {
 url:string;method:'GET'|'POST';checkedAt:string;retrievedAt:string|null;state:'fetched'|'not_modified'|'redirected'|'failed';
 status?:number;failure?:FetchFailure;sha256?:string;bytes?:number;mimeType?:string;etag?:string;lastModified?:string;location?:string;policy?:SourceAccessPolicy;
}
export interface FetchedDocument {url:string;sha256:string;localPath:string;mimeType:string;retrievedAt:string;checkedAt:string;status:number;observationPath:string;policy?:SourceAccessPolicy}
export class PoliteFetchError extends Error {
 failure:FetchFailure;status?:number;policy?:SourceAccessPolicy;
 constructor(failure:FetchFailure,message:string,status?:number,policy?:SourceAccessPolicy){super(message);this.name='PoliteFetchError';this.failure=failure;this.status=status;this.policy=policy;}
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
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port&&!['80','443'].includes(url.port)||!host.includes('.')&&!isIP(host)||/\.(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)||isIP(host)&&!isPublicAddress(host))throw new PoliteFetchError('unsafe_url','Non-public URL rejected');
 for(const key of url.searchParams.keys())if(/^(?:token|access_token|api_key|apikey|password|secret|authorization|sessionid|phpsessid)$/i.test(key))throw new PoliteFetchError('unsafe_url','Credential-bearing URL rejected');
 url.hash='';return url;
}
interface WireResponse {status:number;headers:Record<string,string|undefined>;body:Buffer}
interface FetchOptions {method?:'GET'|'POST';body?:string;machinePolicyUrls?:string[]}
export interface PoliteFetcherOptions {cacheDir:string;minDelayMs?:number;timeoutMs?:number;maxBytes?:number;maxRedirects?:number;policyTtlMs?:number}
const sleep=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
export class PoliteFetcher {
 readonly cacheDir:string;readonly options:Required<PoliteFetcherOptions>;
 private queues=new Map<string,Promise<void>>();private lastStart=new Map<string,number>();private delays=new Map<string,number>();
 private robots=new Map<string,{expiresAt:number;response:Promise<RobotsPolicy>}>();
 private machinePolicies=new Map<string,{expiresAt:number;response:Promise<{rules:TdmRule[];evidence:PolicyEvidence}>}>();
 private fetchCount=0;
 get requestCount():number{return this.fetchCount;}
 constructor(options:PoliteFetcherOptions){
  this.cacheDir=resolve(options.cacheDir);this.options={minDelayMs:1000,timeoutMs:25000,maxBytes:24*1024*1024,maxRedirects:5,policyTtlMs:60*60_000,...options};
  for(const key of ['minDelayMs','timeoutMs','maxBytes','maxRedirects','policyTtlMs'] as const)if(!Number.isFinite(this.options[key])||this.options[key]<0)throw Error(`Invalid ${key}`);
  if(this.options.policyTtlMs===0)throw Error('Policy TTL must be positive');
 }
 private async scheduled<T>(url:URL,work:()=>Promise<T>):Promise<T>{
  const host=url.hostname,prior=this.queues.get(host)??Promise.resolve();
  const {promise:gate,resolve:unlock}=Promise.withResolvers<void>();this.queues.set(host,gate);await prior;
  try{
   const delay=Math.max(this.options.minDelayMs,this.delays.get(host)??0),pause=Math.max(0,(this.lastStart.get(host)??0)+delay-Date.now());
   if(!Number.isFinite(pause)||pause>60000)throw new PoliteFetchError('robots_unavailable','Required crawl delay exceeds bounded wait; source deferred without bypass');
   await sleep(pause);this.lastStart.set(host,Date.now());return await work();
  }finally{unlock();if(this.queues.get(host)===gate)this.queues.delete(host);}
 }
 private async wire(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined):Promise<WireResponse>{
  return this.scheduled(url,async()=>{
   const host=url.hostname.replace(/^\[|\]$/g,'');
   let addresses:{address:string;family:number}[],dnsTimer:NodeJS.Timeout|undefined;
   try{addresses=await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(new PoliteFetchError('timeout','DNS deadline exceeded')),this.options.timeoutMs);})]);}
   catch(error){if(error instanceof PoliteFetchError)throw error;throw new PoliteFetchError('dns_error','Public DNS lookup failed');}
   finally{clearTimeout(dnsTimer);}
   if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)))throw new PoliteFetchError('unsafe_url','DNS resolved a non-public address');
   const pinned=addresses[0];
   return new Promise<WireResponse>((done,reject)=>{
    const headers:Record<string,string>={'User-Agent':ua,Accept:'application/json,text/html,application/pdf,text/plain;q=0.8','Accept-Encoding':'identity'};
    if(body!==undefined){headers['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';headers['Content-Length']=String(Buffer.byteLength(body));}
    if(method==='GET'&&validators?.etag)headers['If-None-Match']=validators.etag;
    if(method==='GET'&&validators?.lastModified)headers['If-Modified-Since']=validators.lastModified;
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method,headers,agent:false,family:pinned.family,lookup:(_name,_options,callback)=>callback(null,pinned.address,pinned.family)},response=>{
     const status=response.statusCode??0;
     const selected:Record<string,string|undefined>={};for(const key of ['content-type','content-length','content-encoding','etag','last-modified','location','tdm-reservation','tdm-policy','x-robots-tag']){const value=response.headers[key];selected[key]=Array.isArray(value)?value[0]:value;}
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
   });
  });
 }
 private async observation(value:FetchObservation):Promise<string>{
  const folder=join(this.cacheDir,'observations');await mkdir(folder,{recursive:true});const path=join(folder,`${Date.now()}-${randomUUID()}.json`);await writeFile(path,JSON.stringify(value,null,2)+'\n');return path;
 }
 private async policy(url:URL):Promise<RobotsPolicy>{
  let cached=this.robots.get(url.origin);
  if(!cached||Date.now()>=cached.expiresAt){const pending=(async()=>{
   try{
    const result=await this.fetchInternal(new URL('/robots.txt',url).href,{},false,false);
    const policy=parseRobots(await readFile(result.localPath,'utf8'));policy.evidence={url:result.url,locator:'robots.txt applicable StadtstackData group',value:'checked',sha256:result.sha256,checkedAt:result.checkedAt};this.delays.set(url.hostname,Math.max(this.delays.get(url.hostname)??0,policy.delayMs));return policy;
   }catch(error){
    // RFC 9309 unavailable 404/410 allows access; 401/403/429 and failures fail closed.
    if(error instanceof PoliteFetchError&&(error.status===404||error.status===410))return {rules:[],delayMs:0,evidence:{url:new URL('/robots.txt',url).href,locator:'robots.txt HTTP absence',value:String(error.status),checkedAt:new Date().toISOString()}};
    throw new PoliteFetchError('robots_unavailable',`Robots policy unavailable${error instanceof PoliteFetchError&&error.status?` (policy HTTP ${error.status})`:''}; source existence is unknown`);
   }
  })();cached={expiresAt:Date.now()+this.options.policyTtlMs,response:pending};this.robots.set(url.origin,cached);}
  return cached.response;
 }
 private async machinePolicy(url:URL,knownUrl?:string):Promise<{rules:TdmRule[];evidence:PolicyEvidence}>{
  const policyUrl=knownUrl?publicUrl(knownUrl).href:new URL('/.well-known/tdmrep.json',url).href;
  const cacheKey=`${knownUrl?'required':'standard'}:${policyUrl}`;
  let cached=this.machinePolicies.get(cacheKey);
  if(!cached||Date.now()>=cached.expiresAt){
   const pending=(async()=>{
    // Standardized location, not a guessed municipal API: W3C TDMRep 2024 §6.1.
    try{
     const response=await this.fetchInternal(policyUrl,{},true,false);
     if(!/json/.test(response.mimeType)){if(knownUrl)throw Error('Known machine policy has no interpretable JSON representation');return {rules:[],evidence:{url:policyUrl,locator:'TDMRep standardized location returned no JSON representation',value:'not_implemented',sha256:response.sha256,checkedAt:response.checkedAt}};}
     return {rules:parseTdmRules(JSON.parse(await readFile(response.localPath,'utf8'))),evidence:{url:policyUrl,locator:'W3C TDMRep origin rules',value:'checked',sha256:response.sha256,checkedAt:response.checkedAt}};
    }catch(error){
     if(!knownUrl&&error instanceof PoliteFetchError&&(error.status===404||error.status===410))return {rules:[],evidence:{url:policyUrl,locator:'TDMRep standardized location HTTP absence',value:String(error.status),checkedAt:new Date().toISOString()}};
     throw new PoliteFetchError('tdm_unavailable',`Machine-readable TDM policy could not be checked${error instanceof PoliteFetchError&&error.status?` (policy HTTP ${error.status})`:''}; ask municipality`);
    }
   })();cached={expiresAt:Date.now()+this.options.policyTtlMs,response:pending};this.machinePolicies.set(cacheKey,cached);
  }
  return cached.response;
 }
 async fetch(url:string,options:FetchOptions={}):Promise<FetchedDocument>{this.fetchCount++;return this.fetchInternal(url,options,true);}
 private async fetchInternal(input:string,options:FetchOptions,checkRobots:boolean,checkTdm=true):Promise<FetchedDocument>{
  let url=publicUrl(input),method=options.method??'GET',body=options.body;
  if(method==='POST'&&(!body||Buffer.byteLength(body)>65536))throw new PoliteFetchError('unsafe_url','Only bounded public form requests supported');
  for(let redirects=0;redirects<=this.options.maxRedirects;redirects++){
   const checkedAt=new Date().toISOString(),observation:FetchObservation={url:url.href,method,checkedAt,retrievedAt:null,state:'failed'};
   const policy:SourceAccessPolicy={robots:{state:'allowed',url:new URL('/robots.txt',url).href},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'};
   observation.policy=policy;
   try{
    if(checkRobots){
     let robots:RobotsPolicy;
     try{robots=await this.policy(url);}catch(error){policy.robots.state='unavailable';throw error;}
     policy.robots.sha256=robots.evidence?.sha256;policy.robots.checkedAt=robots.evidence?.checkedAt;
     if(!robotsAllows(robots,url.href)){policy.robots.state='blocked';throw new PoliteFetchError('robots_blocked','Robots disallows request; ask municipality, not evidence of absence');}
    }
    if(checkTdm){
     const knownPolicies=(options.machinePolicyUrls??[]).filter(value=>{const candidate=publicUrl(value);return candidate.pathname!=='/robots.txt'&&candidate.origin===url.origin;});
     for(const knownUrl of [undefined,...knownPolicies]){
      let originPolicy:{rules:TdmRule[];evidence:PolicyEvidence};
      try{originPolicy=await this.machinePolicy(url,knownUrl);}catch(error){policy.tdm.state='unavailable';policy.tdm.evidence.push({url:knownUrl??new URL('/.well-known/tdmrep.json',url).href,locator:'Machine policy retrieval or interpretation failed',value:'inaccessible',checkedAt});throw error;}
      policy.tdm.evidence.push(originPolicy.evidence);const rule=tdmRuleForUrl(originPolicy.rules,url.href);
      if(rule){policy.tdm.state=rule['tdm-reservation']===1?'reserved':'not_reserved';policy.tdm.evidence.push({...originPolicy.evidence,locator:`TDMRep matching location ${rule.location}`,value:String(rule['tdm-reservation'])});}
      if(policy.tdm.state==='reserved')throw new PoliteFetchError('tdm_reserved','Machine-readable TDM reservation; ask municipality');
     }
    }
    const key=hash(method+' '+url.href+'\n'+(body??'')),meta=join(this.cacheDir,'requests',key+'.json');let previous:FetchObservation|undefined;
    try{previous=JSON.parse(await readFile(meta,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new PoliteFetchError('cache_missing','Invalid cache metadata');}
    const response=await this.wire(url,method,body,previous);observation.status=response.status;
    if([301,302,303,307,308].includes(response.status)){
     if(!response.headers.location)throw new PoliteFetchError('invalid_redirect','Missing redirect destination',response.status);
     const next=publicUrl(new URL(response.headers.location,url).href);observation.location=next.href;observation.state='redirected';
     if(/\/(?:login|signin|auth|anmelden)(?:\/|$)/i.test(next.pathname)){policy.access='authentication';throw new PoliteFetchError('access_barrier','Authentication redirect; ask municipality');}
     await this.observation(observation);
     if(redirects===this.options.maxRedirects)throw new PoliteFetchError('redirect_limit','Redirect bound exceeded');
     if(method==='POST'&&next.origin!==url.origin)throw new PoliteFetchError('invalid_redirect','Cross-origin form redirect rejected');
     if(response.status===303||method==='POST'&&[301,302].includes(response.status)){method='GET';body=undefined;}
     url=next;continue;
    }
    if([401,402,403].includes(response.status)){policy.access=response.status===402?'paywall':'authentication';throw new PoliteFetchError('access_barrier',`HTTP ${response.status} access barrier; ask municipality`,response.status);}
    let representation:Buffer,sha256:string,retrievedAt:string,localPath:string,mimeType:string;
    if(response.status===304){
     if(!previous?.sha256||!previous.retrievedAt)throw new PoliteFetchError('cache_missing','304 without cached representation',304);
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
    if(resourcePolicy.reservation!==null)policy.tdm.state=resourcePolicy.reservation===1?'reserved':'not_reserved';
    if(policy.access!=='public')throw new PoliteFetchError('access_barrier',`${policy.access} barrier; ask municipality`);
    if(checkTdm&&policy.tdm.state==='reserved')throw new PoliteFetchError('tdm_reserved','Machine-readable TDM reservation; ask municipality');
    if(checkTdm&&mimeType==='application/pdf'){
     let pdfPolicy;
     try{pdfPolicy=await inspectPdfTdmPolicy(representation,sha256,this.cacheDir);}catch{
      policy.tdm.state='unavailable';policy.tdm.evidence.push({url:url.href,locator:'Bounded PDF TDM metadata parser',value:'parser_or_cache_unavailable',sha256,checkedAt});
      throw new PoliteFetchError('tdm_unavailable','PDF TDM metadata could not be checked; ask municipality');
     }
     const finding=pdfPolicy.finding;
     policy.tdm.evidence.push({url:url.href,locator:`PDF.js ${pdfPolicy.pdfjsVersion} XMP metadata (${pdfPolicy.policyVersion})`,value:finding.state==='unavailable'?finding.reason:finding.reservation===null?'no_tdm_reservation_field':String(finding.reservation),sha256,checkedAt:pdfPolicy.checkedAt});
     if(finding.state==='unavailable'){policy.tdm.state='unavailable';throw new PoliteFetchError('tdm_unavailable','PDF TDM metadata parsing unavailable; ask municipality');}
     if(finding.policyPresent)policy.tdm.evidence.push({url:url.href,locator:'PDF TDM namespace policy property',value:'present',sha256,checkedAt:pdfPolicy.checkedAt});
     if(finding.reservation!==null)policy.tdm.state=finding.reservation===1?'reserved':'not_reserved';
     if(policy.tdm.state==='reserved')throw new PoliteFetchError('tdm_reserved','PDF machine-readable TDM reservation; ask municipality');
    }
    await mkdir(join(this.cacheDir,'sha256'),{recursive:true});await writeFile(localPath,representation,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    observation.etag=response.headers.etag??observation.etag;observation.lastModified=response.headers['last-modified']??observation.lastModified;
    const observationPath=await this.observation(observation);await mkdir(join(this.cacheDir,'requests'),{recursive:true});const temporary=meta+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(observation));await rename(temporary,meta);
    return {url:url.href,sha256,localPath,mimeType,retrievedAt,checkedAt,status:response.status,observationPath,policy};
   }catch(error){
    const failure=error instanceof PoliteFetchError?error:new PoliteFetchError('network_error','Fetch or cache operation failed');failure.policy=policy;observation.state='failed';observation.failure=failure.failure;observation.status??=failure.status;await this.observation(observation);throw failure;
   }
  }
  throw new PoliteFetchError('redirect_limit','Redirect bound exceeded');
 }
}
