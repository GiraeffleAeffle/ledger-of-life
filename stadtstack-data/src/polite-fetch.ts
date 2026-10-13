import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {mkdir,readFile,writeFile,rename,lstat,realpath,readdir} from 'node:fs/promises';
import {join,resolve,basename,dirname,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import {z} from 'zod';
import {hash,ua} from './common.ts';
import {parseTdmRules,parseTdmReservation,tdmRuleForUrl,matchesPolicyPattern,ownerRobotsOverrideFor,ownerRobotsOverrideApplies,effectiveRobotsPermission,documentOriginExcludes,effectiveSourcePermission,projectSourcePolicyMetadata} from './source-policy.ts';
import type {SourceAccessPolicy,PolicyEvidence,TdmRule,OwnerRobotsOverride} from './source-policy.ts';
import {acquirePrivateRunLock,writePrivateJson} from './district-private-io.ts';
import {inspectPdfTdmPolicy} from './pdf-tdm-policy.ts';
import {inspectResourcePolicySandbox} from './district-policy-inspection.ts';
import {withParserSandbox,type ParserSourceContext,type ParserSandbox} from './district-parser-isolation.ts';
import {isPublicAddress} from './public-address.ts';
import type {PdfTdmPolicyResult} from './pdf-tdm-policy.ts';
import type {ResourcePolicyInspection} from './source-policy.ts';
import type {DocumentOriginOptions} from './document-origin.ts';
import type {DocumentOriginInput} from './document-origin-contract.ts';
import type {DocumentOriginClassification} from './document-origin-contract.ts';
import {classifyDocumentOrigin} from './document-origin.ts';
import type {OParlOriginContext} from './document-origin-contract.ts';
import {assertHostNotOptedOut,assertCivicPolicyAuthority,assertManagedSourceReadable,assertManagedSourceBindings,assertManagedObservationReadable,assertManagedRawSourceBinding,HostOptedOutError,CivicPolicyStateError,initializeManagedAcquisitionLane,withManagedSourceWrite,withManagedSourceScratch,relinquishManagedSourceContent} from './civic-opt-out.ts';
import type {CivicPolicyOptions,CivicPolicyAuthorityReceipt,ManagedAcquisitionLaneOptions,ManagedSourceBinding} from './civic-opt-out.ts';
import {ContentFreeSourcePolicySchema,hashSchema} from './district-schema.ts';
import {SourceObservationSchema,sourceObservationMatches,type SourceObservation} from './source-observation.ts';
import {nativePublicRequestHeaders,type NativePublicOperation} from './district-native-request.ts';
import {ownerGenesisAccessFor,ownerGenesisRobotsDecisionFor} from './source-policy.ts';
import {readGenesisOwnerCredentials,type GenesisOwnerCredentials} from './genesis-owner-credentials.ts';
import {genesisOwnerAccountRoot,readGenesisOwnerRepresentation} from './genesis-owner-acquisition.ts';
import {persistCrawlRequestEvidence,CrawlRequestEvidenceCaptureError} from './district-crawl-request.ts';
import {semanticHash} from './district-adapter-contract.ts';
import {admittedRegisteredRobotsScopes,registeredRobotsAuditApplies,registeredRobotsEvidence,readRegisteredRobotsAudit,registeredRobotsScope,REGISTERED_SOURCE_POLICY_VALIDITY_MS,PUBLIC_SOURCE_POLICY_VALIDITY_MS,type RegisteredRobotsAudit,type RegisteredSourceConfiguration} from './registered-source-policy.ts';
import {sourcePolicyValidityMs,registeredSourcePolicyContextUrls,isOriginTdmEvidence} from './source-policy.ts';

export type FetchFailure='unsafe_url'|'robots_blocked'|'robots_unavailable'|'tdm_reserved'|'tdm_unavailable'|'access_barrier'|'credential_unavailable'|'dns_error'|'timeout'|'network_error'|'http_error'|'too_large'|'redirect_limit'|'invalid_redirect'|'cross_host_redirect'|'cache_missing'|'unsupported_encoding'|'host_busy'|'host_state_unsafe'|'host_cooldown'|'host_opted_out'|'document_excluded'|'host_admission_deferred';
class RequestAdmissionInterruption extends Error {readonly admissionError:unknown;constructor(error:unknown){super('Public request admission held');this.admissionError=error;}}
export interface FetchObservation {
 url:string;method:'GET'|'POST';checkedAt:string;retrievedAt:string|null;state:'fetched'|'not_modified'|'redirected'|'failed'|'excluded';
 status?:number;failure?:FetchFailure;retryAfter?:string;sha256?:string;bytes?:number;mimeType?:string;etag?:string;lastModified?:string;location?:string;policy?:SourceAccessPolicy;exclusion?:ExcludedDocument['exclusion'];
}
export interface FetchedDocument {url:string;sha256:string;localPath:string;mimeType:string;retrievedAt:string;checkedAt:string;status:number;observationPath:string;policy?:SourceAccessPolicy}
type ValidatedPolicy={kind:'robots';value:RobotsPolicy}|{kind:'tdm';value:TdmRule[]};
export interface ExcludedDocument {url:string;sha256:string;mimeType:string;retrievedAt:string;checkedAt:string;status:number;observationPath:string;policy:SourceAccessPolicy;sizeBytes:number;exclusion:{reason:'non_official_restricted';excludedAt:string;previousManagedCopy:'removed'|'retained_independent'|'not_managed'|'partial'}}
export interface SourceContentBinding {url:string;sha256:string;observationPath:string;independentAllowed:boolean}
export function sourceContentBinding(document:FetchedDocument):SourceContentBinding {
 return {url:document.url,sha256:document.sha256,observationPath:document.observationPath,independentAllowed:!!document.policy&&effectiveSourcePermission(document.policy,document)};
}
export class PoliteFetchError extends Error {
 failure:FetchFailure;status?:number;policy?:SourceAccessPolicy;retryAfter?:string;robotsEvidence?:PolicyEvidence;excludedDocument?:ExcludedDocument;
 observationCheckedAt?:string;
 policyPhase:'robots'|'tdm'|null=null;
 constructor(failure:FetchFailure,message:string,status?:number,policy?:SourceAccessPolicy,retryAfter?:string,cause?:unknown){super(message,cause===undefined?undefined:{cause});this.name='PoliteFetchError';this.failure=failure;this.status=status;this.policy=policy;this.retryAfter=retryAfter;}
}
// Closed source-metadata findings from the existing PDF worker protocol.
// Protocol/version/timeout/input/unknown failures are runtime failures, not source refusals.
const pdfSourceMetadataFailures:Readonly<Record<string,true>>={size_limit:true,encrypted_pdf:true,parse_error:true,metadata_parse_error:true,metadata_unreadable:true,metadata_size_limit:true,invalid_xml_reference:true,invalid_tdm_reservation:true,metadata_structure_limit:true};
interface RobotsGroup {agents:string[];rules:{allow:boolean;pattern:string}[];delay:number}
export interface RobotsPolicy {rules:{allow:boolean;pattern:string}[];delayMs:number;evidence?:PolicyEvidence}
const RobotsAbsenceObservationSchema=z.object({
 url:z.url(),method:z.literal('GET'),checkedAt:z.iso.datetime(),retrievedAt:z.null(),state:z.literal('failed'),status:z.union([z.literal(404),z.literal(410)]),failure:z.literal('http_error'),policy:ContentFreeSourcePolicySchema.optional(),
}).strict();
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
interface WireResponse {status:number;headers:Record<string,string|undefined>;body:Buffer;conditionalRequestSent?:boolean}
export interface FetchOptions {method?:'GET'|'POST';body?:string;machinePolicyUrls?:string[];ownerRobotsOverride?:OwnerRobotsOverride;registeredSourceUrl?:string;registeredMunicipalityId?:string;registeredSourceId?:string;hostProfile?:'default'|'municipal';title?:string;linkText?:string;municipalityName?:string;oparlContext?:OParlOriginContext;publicOperation?:NativePublicOperation}
export interface FixturePolicyInspection {
 resource(url:string,headers:Record<string,string|undefined>,body:Buffer,mimeType:string,context:ParserSourceContext):Promise<ResourcePolicyInspection>;
 origin(input:DocumentOriginInput,options:DocumentOriginOptions):Promise<DocumentOriginClassification>;
 pdf(bytes:Buffer,sha256:string,cacheRoot:string,context:ParserSourceContext):Promise<PdfTdmPolicyResult>;
}
export interface PoliteFetcherOptions {cacheDir:string;minDelayMs?:number;timeoutMs?:number;maxBytes?:number;maxRedirects?:number;policyTtlMs?:number;ownerPolicyLane?:Omit<ManagedAcquisitionLaneOptions,'kind'>;fixtureInspection?:FixturePolicyInspection;beforeRequest?:(url:string)=>Promise<void>;onRedirect?:(event:{requestUrl:string;from:string;to:string;status:number})=>void}
const sleep=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
const representationPolicyLocators={
 'tdm-reservation':'HTTP TDM-Reservation',
 'tdm-policy':'HTTP TDM-Policy',
 'x-robots-tag':'HTTP X-Robots-Tag',
} as const;
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
 readonly cacheDir:string;readonly options:Required<Omit<PoliteFetcherOptions,'ownerPolicyLane'|'fixtureInspection'|'beforeRequest'|'onRedirect'>>;
 private readonly fixtureInspection:FixturePolicyInspection|undefined;
 private readonly beforeRequest:PoliteFetcherOptions['beforeRequest'];
 private readonly onRedirect:PoliteFetcherOptions['onRedirect'];
 private delays=new Map<string,number>();
 private robots=new Map<string,{expiresAt:number;response:Promise<RobotsPolicy>}>();
 private machinePolicies=new Map<string,{expiresAt:number;response:Promise<{rules:TdmRule[];evidence:PolicyEvidence}>}>();
 private fetchCount=0;
 private initialization?:Promise<void>;private readonly lane:PoliteFetcherOptions['ownerPolicyLane'];private activeLane?:NonNullable<PoliteFetcherOptions['ownerPolicyLane']>;
 private authorityMode?:CivicPolicyAuthorityReceipt['mode'];
 private ownerAccountFetcher?:PoliteFetcher;
 private readonly publicPolicyFetcher?:PoliteFetcher;
 private policyObservationPaths:string[]|undefined;
 private policyRefreshOriginalUrl:string|undefined;
 private registeredScopes=new Map<string,RegisteredRobotsAudit>();
 private registeredDiscoveries=new Map<string,RegisteredRobotsAudit>();
 /** Host controller only, after the existing pinned operator-registry admission. */
 registerRegisteredSources(registry:RegisteredSourceConfiguration,registrySha256:string):void {
  this.registeredScopes.clear();this.registeredDiscoveries.clear();
  for(const audit of admittedRegisteredRobotsScopes(registry,registrySha256))this.registeredScopes.set(this.registeredKey(audit),audit);
 }
 hasRegisteredSourceDecision(options:FetchOptions):boolean {
  const audit=this.registeredScopes.get(this.registeredKey({municipalityId:options.registeredMunicipalityId,sourceId:options.registeredSourceId,root:options.registeredSourceUrl}));
  return !!audit&&!!registeredRobotsScope(audit.municipalityId,audit.sourceId,audit.root)?.followLinkedDocuments;
 }
 private registeredKey(scope:{municipalityId?:string;sourceId?:string;root?:string}):string{return JSON.stringify([scope.municipalityId,scope.sourceId,scope.root]);}
 private registeredAudit(url:string,options:FetchOptions):RegisteredRobotsAudit|undefined {
  if(this.publicPolicyFetcher)return this.publicPolicyFetcher.registeredAudit(url,options);
  const key=this.registeredKey({municipalityId:options.registeredMunicipalityId,sourceId:options.registeredSourceId,root:options.registeredSourceUrl});
  const audit=this.registeredDiscoveries.get(key+'\n'+url)??this.registeredScopes.get(key);
  return audit&&registeredRobotsAuditApplies(audit,url)?audit:undefined;
 }
 /** Targets must come from an authenticated committed discovery, or the adapter's
  * actual parsed admitted response. No request, response or policy is fabricated. */
 authorizeRegisteredSourceDiscovery(options:FetchOptions,from:{url:string;sha256:string;policy?:SourceAccessPolicy},targets:readonly string[]):void {
  const key=this.registeredKey({municipalityId:options.registeredMunicipalityId,sourceId:options.registeredSourceId,root:options.registeredSourceUrl}),base=this.registeredScopes.get(key);
  if(!base||!/^[a-f0-9]{64}$/.test(from.sha256))return;
  const prior=this.registeredAudit(from.url,options)??readRegisteredRobotsAudit(from.policy?.tdm.evidence??[],from.url);
  if(!prior||this.registeredKey(prior)!==key)return;
  const anchor=prior.discovery?.anchor??(prior.discovery?{url:prior.discovery.from,sha256:prior.discovery.sha256}:undefined);
  for(const target of targets){
   if(registeredRobotsAuditApplies(base,target))continue;
   const candidate={...base,discovery:{from:from.url,sha256:from.sha256,...(anchor?{anchor}:{})}};
   if(!registeredRobotsAuditApplies(candidate,target))continue;
   if((target+'#'+encodeURIComponent(JSON.stringify(candidate))).length<=8192)this.registeredDiscoveries.set(key+'\n'+target,candidate);
  }
 }
 async recordDiscoveredSourceLinks(options:FetchOptions,from:FetchedDocument,targets:readonly string[]|(()=>readonly string[])):Promise<void> {
  if(!this.hasRegisteredSourceDecision(options))return;
  const observedTargets=typeof targets==='function'?targets():targets;if(!observedTargets.length)return;
  await this.assertSourceReadable(from.localPath,from.url);await this.assertSourceBindingsAllowed([sourceContentBinding(from)]);
  this.authorizeRegisteredSourceDiscovery(options,from,observedTargets);
 }
 get requestCount():number{return this.fetchCount;}
 constructor(options:PoliteFetcherOptions,publicPolicyFetcher?:PoliteFetcher){
  if(options.fixtureInspection&&(!options.ownerPolicyLane?.authorityId?.startsWith('fixture:')||!options.ownerPolicyLane.authoritySha256||!options.ownerPolicyLane.stateDir))throw new PoliteFetchError('host_state_unsafe','Injected inspection requires a fully pinned isolated fixture authority');
  this.fixtureInspection=options.fixtureInspection;
  this.beforeRequest=options.beforeRequest;this.onRedirect=options.onRedirect;
  this.cacheDir=resolve(options.cacheDir);this.options={minDelayMs:2000,timeoutMs:25000,maxBytes:24*1024*1024,maxRedirects:5,policyTtlMs:PUBLIC_SOURCE_POLICY_VALIDITY_MS,...options};
  this.lane=options.ownerPolicyLane;
  this.publicPolicyFetcher=publicPolicyFetcher;
  if(publicPolicyFetcher&&this.cacheDir!==genesisOwnerAccountRoot(publicPolicyFetcher.cacheDir))throw new PoliteFetchError('host_state_unsafe','Owner account lane routing rejected');
  for(const key of ['minDelayMs','timeoutMs','maxBytes','maxRedirects','policyTtlMs'] as const)if(!Number.isFinite(this.options[key])||this.options[key]<0)throw Error(`Invalid ${key}`);
  if(this.options.policyTtlMs===0)throw Error('Policy TTL must be positive');
 }
 async initialize():Promise<void>{
  const lane=this.lane;
  if(!lane)throw new PoliteFetchError('host_state_unsafe','Explicit owner-policy acquisition lane context is required; legacy cache roots are not enrolled');
  this.initialization??=(async()=>{
   const authority=await assertCivicPolicyAuthority(lane);
   if(this.fixtureInspection&&authority.mode!=='isolated-fixture')throw new PoliteFetchError('host_state_unsafe','Production authority cannot use injected inspection');
   const context={...lane,...(lane.stateDir?{stateDir:resolve(lane.stateDir)}:{}),authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
   await initializeManagedAcquisitionLane(this.cacheDir,{...context,...(this.publicPolicyFetcher?{kind:'artifacts' as const}:{})});this.activeLane=context;this.authorityMode=authority.mode;
  })().catch(()=>{throw new PoliteFetchError('host_state_unsafe','Policy authority, acquisition marker, ownership or completeness rejected; no implicit provisioning or legacy enrollment');});
  await this.initialization;
 }
 private async withInspectionSandbox(body:Buffer,context:ParserSourceContext,inspect:(sandbox?:ParserSandbox)=>Promise<void>):Promise<void>{
  if(this.fixtureInspection){await inspect();return;}
  let inspection:Promise<void>|undefined;
  try{await withParserSandbox(body,sandbox=>inspection=inspect(sandbox),context);}
  catch(error){
   // A command timeout also rejects the sandbox supervisor race. Let the PDF
   // metadata wrapper finish its existing timeout→runtime-finding projection,
   // rather than changing the fetch hold reason just because it is co-located.
   if(error instanceof Error&&error.name==='TimeoutError'&&inspection)await inspection;
   throw error;
  }
 }
 private policyOptions():CivicPolicyOptions{return this.activeLane??this.lane??{};}
 async assertHostAllowed(url:string):Promise<void>{
  try{await assertHostNotOptedOut(url,this.policyOptions());}
  catch(error){if(error instanceof HostOptedOutError)throw new PoliteFetchError('host_opted_out','Host objection is active; acquisition and cached-source reuse stopped');throw new PoliteFetchError('host_state_unsafe','Host objection state is unavailable; acquisition stopped');}
 }
 async assertSourceReadable(path:string,sourceUrl?:string):Promise<void>{
  await this.initialize();await assertManagedSourceReadable(path,{...this.policyOptions(),...(sourceUrl!==undefined?{sourceUrl}:{})});
 }
 private async checkedSourceBindings(bindings:SourceContentBinding[]):Promise<Array<Extract<ManagedSourceBinding,{kind:'http_observation'}>>>{
  await this.initialize();
  if(!Array.isArray(bindings)||!bindings.length||bindings.some(binding=>!binding||typeof binding.url!=='string'||typeof binding.observationPath!=='string'))throw new PoliteFetchError('host_state_unsafe','Source content has no valid immutable provenance');
  const result:Array<Extract<ManagedSourceBinding,{kind:'http_observation'}>>=[];
  for(const binding of bindings){
   if(!hashSchema.safeParse(binding.sha256).success)throw new PoliteFetchError('host_state_unsafe','Invalid source binding digest');
   publicUrl(binding.url);
   await this.assertHostAllowed(binding.url);
   if(dirname(resolve(binding.observationPath))===join(genesisOwnerAccountRoot(this.cacheDir),'observations')){
    await assertManagedSourceReadable(binding.observationPath,{...this.policyOptions(),sourceUrl:binding.url});
    const observed=SourceObservationSchema.parse(JSON.parse(await readFile(binding.observationPath,'utf8')));
    if(observed.url!==binding.url||observed.sha256!==binding.sha256)throw new PoliteFetchError('host_state_unsafe','Owner account source binding mismatch');
    const document:FetchedDocument={...observed,policy:observed.policy,localPath:join(genesisOwnerAccountRoot(this.cacheDir),'sha256',binding.sha256.slice(0,2),binding.sha256),observationPath:binding.observationPath};
    const checked=await readGenesisOwnerRepresentation(this.cacheDir,document,this.policyOptions(),this.options.maxBytes);
    result.push({kind:'http_observation',url:document.url,sourceSha256:document.sha256,observationId:checked.httpObservation.observationId,receiptSha256:checked.httpObservation.receiptSha256});continue;
   }
   const name=basename(binding.observationPath),observationPath=join(this.cacheDir,'observations',name),rawPath=join(this.cacheDir,'sha256',binding.sha256);
   if(resolve(binding.observationPath)!==observationPath||name.length>160||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name))throw new PoliteFetchError('host_state_unsafe','Source observation is outside the managed root or invalid');
   await this.assertSourceReadable(rawPath,binding.url);
   let bytes:Buffer,observation:SourceObservation;
   try{
    const metadata=await lstat(observationPath);
    if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>16*1024*1024||await realpath(observationPath)!==observationPath)throw Error('Observation path/type/size rejected');
    await assertManagedObservationReadable(observationPath,this.policyOptions());
    bytes=await readFile(observationPath);observation=SourceObservationSchema.parse(JSON.parse(bytes.toString('utf8')));
    await assertManagedObservationReadable(observationPath,this.policyOptions());
   }
   catch(error){if(error instanceof HostOptedOutError||error instanceof CivicPolicyStateError)throw error;throw new PoliteFetchError('host_state_unsafe','Immutable source observation is missing or invalid');}
   if(!sourceObservationMatches(observation,{url:binding.url,sha256:binding.sha256,mimeType:observation.mimeType,retrievedAt:observation.retrievedAt,checkedAt:observation.checkedAt,status:observation.status,sizeBytes:(await lstat(rawPath)).size,bodyState:'retained'}))throw new PoliteFetchError('host_state_unsafe','Immutable source observation binding mismatch');
   const proof:Extract<ManagedSourceBinding,{kind:'http_observation'}>={kind:'http_observation',url:binding.url,sourceSha256:binding.sha256,observationId:name,receiptSha256:hash(bytes)};
   await assertManagedRawSourceBinding(rawPath,proof,this.policyOptions());
   const parsed=ContentFreeSourcePolicySchema.safeParse(observation.policy);
   if(!parsed.success)throw new PoliteFetchError('host_state_unsafe','Stored source policy is not safe complete metadata');
   if(!effectiveSourcePermission(parsed.data,binding))throw new PoliteFetchError('document_excluded','Stored source policy no longer permits derived-content reuse',undefined,parsed.data);
   for(const url of registeredSourcePolicyContextUrls(parsed.data,binding))await this.assertHostAllowed(url);
   result.push(proof);
  }
  return result;
 }
 async assertSourceBindingsAllowed(bindings:SourceContentBinding[]):Promise<void>{
  await this.checkedSourceBindings(bindings);
 }
 async persistDerivedJson(path:string,value:unknown,bindings:SourceContentBinding[]):Promise<void>{
  await this.initialize();
  const proofs=await this.checkedSourceBindings(bindings);
  const relativePath=relative(this.cacheDir,resolve(path));
  if(!relativePath||relativePath.startsWith('..')||isAbsolute(relativePath))throw new PoliteFetchError('cache_missing','Derived source cache escapes managed root');
  const bytes=JSON.stringify(value,null,2)+'\n',contentSha256=hash(bytes);
  const entries=proofs.map(proof=>({...proof,relativePath,contentSha256,independentAllowed:true}));
  await withManagedSourceScratch(this.cacheDir,proofs,async scope=>{
   await scope.assertActive();const temporary=join(scope.directory,'derived.json');
   await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});
   await withManagedSourceWrite(this.cacheDir,entries,async()=>{await mkdir(dirname(resolve(path)),{recursive:true,mode:0o700});await rename(temporary,resolve(path));},this.policyOptions());
  },{...this.activeLane!,kind:'fetch',purpose:'artifact'});
 }
 async sourceBindingsForArtifact(bindings:SourceContentBinding[]):Promise<Array<Extract<ManagedSourceBinding,{kind:'http_observation'}>&{independentAllowed:true}>>{
  return (await this.checkedSourceBindings(bindings)).map(proof=>({...proof,independentAllowed:true}));
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
   try{await this.beforeRequest?.(url.href);}catch(error){throw new RequestAdmissionInterruption(error);}
   await this.assertHostAllowed(url.href);
   // Persist before dispatch for crash safety, then retain the actual dispatch time.
   // An unsuccessful state commit leaves the owner lock in place, never a restart bypass.
   state.lastStart=Date.now();
   try{const result=await work();onResult?.(result,state);return result;}
   finally{try{await writePrivateJson(path,state);}catch(error){release=undefined;throw error;}}
  }catch(error){
   if(error instanceof PoliteFetchError||error instanceof RequestAdmissionInterruption)throw error;
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
 private async wire(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined,operation?:NativePublicOperation,credentials?:GenesisOwnerCredentials):Promise<WireResponse>{
   await this.initialize();
   if(this.authorityMode!=='codex-workstation-local')throw new PoliteFetchError('host_state_unsafe','Live HTTP acquisition requires the canonical production authority');
   await this.assertHostAllowed(url.href);
   const host=url.hostname.replace(/^\[|\]$/g,'');
   let addresses:{address:string;family:number}[],dnsTimer:NodeJS.Timeout|undefined;
   try{addresses=await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(new PoliteFetchError('timeout','DNS deadline exceeded')),this.options.timeoutMs);})]);}
   catch(error){if(error instanceof PoliteFetchError)throw error;throw new PoliteFetchError('dns_error','Public DNS lookup failed');}
   finally{clearTimeout(dnsTimer);}
   if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)))throw new PoliteFetchError('unsafe_url','DNS resolved a non-public address');
   const pinned=addresses[0];
   const nativeHeaders=credentials?credentials.requestHeaders(url,method,body,operation):nativePublicRequestHeaders(url,method,body,operation);
   return this.scheduled(url,()=>this.wireRequest(url,method,body,validators,pinned,nativeHeaders),(response,state)=>this.recordHostResponse(url,response,state));
 }
 /** Current-proof validators must come from the actual immutable observation,
  * not only the mutable request cache. Legacy observations remain usable. */
 private async currentPolicyValidators(url:URL,method:'GET'|'POST',previous:FetchObservation|undefined):Promise<FetchObservation|undefined>{
  if(method!=='GET'||!previous||previous.state==='excluded'||!previous.etag&&!previous.lastModified)return undefined;
  const expected=SourceObservationSchema.safeParse(previous);
  if(!expected.success||expected.data.url!==url.href)return undefined;
  const matches=await this.policyObservations(this.cacheDir,url.href,Date.parse(expected.data.checkedAt),Date.parse(expected.data.checkedAt));
  for(const match of matches){
   const observed=SourceObservationSchema.safeParse(match.observation);
   if(!observed.success||semanticHash(observed.data)!==semanticHash(expected.data))continue;
   // The canonical raw entry pins its actual observation ID/hash. Policy bodies
   // are retained dependencies, not independent document/model admissions.
   // Authenticate the complete byte-sharing custody set with the existing codec.
   const retained=await this.policyObservations(this.cacheDir,undefined,0,Date.now()),bindings:Array<Extract<ManagedSourceBinding,{kind:'http_observation'}>>=[];
   for(const row of retained){
    const parsed=SourceObservationSchema.safeParse(row.observation);
    if(!parsed.success||parsed.data.state==='excluded'||parsed.data.sha256!==observed.data.sha256)continue;
    bindings.push({kind:'http_observation',url:parsed.data.url,sourceSha256:parsed.data.sha256,observationId:basename(row.path),receiptSha256:hash(row.bytes)});
   }
   await assertManagedSourceBindings(join(this.cacheDir,'sha256',observed.data.sha256),bindings,{...this.policyOptions(),sourceUrl:url.href});
   return {...previous,etag:observed.data.etag,lastModified:observed.data.lastModified};
  }
  return undefined;
 }
 /** Bounded metadata lookup inside an already-managed fetch root; no body
  * fetch, legacy enrollment, timestamp rewrite or inferred status. */
 private async policyObservations(rawRoot:string,url:string|undefined,from:number,to:number,recordedBefore=Date.now()){
  const root=await realpath(rawRoot),directory=join(root,'observations');
  let names:string[];try{names=await readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  if(names.length>100000)throw new PoliteFetchError('host_state_unsafe','Policy observation lookup bound exceeded');
  const matches:Array<{path:string;bytes:Buffer;observation:Record<string,unknown>}>=[];
  let totalBytes=0;
  for(const name of names){
   if(!/^[0-9]+-[a-f0-9-]{36}\.json$/.test(name))continue;
   const recordedAt=Number(name.slice(0,name.indexOf('-')));
   if(recordedAt<from||recordedAt>recordedBefore)continue;
   const path=join(directory,name),stat=await lstat(path);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024||await realpath(path)!==path)throw new PoliteFetchError('host_state_unsafe','Policy observation file bound rejected');
   totalBytes+=stat.size;if(totalBytes>64*1024*1024)throw new PoliteFetchError('host_state_unsafe','Policy observation byte lookup bound exceeded');
   await assertManagedObservationReadable(path,this.policyOptions());
   const bytes=await readFile(path),after=await lstat(path);
   if(bytes.length!==stat.size||after.ino!==stat.ino||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new PoliteFetchError('host_state_unsafe','Policy observation changed during lookup');
   await assertManagedObservationReadable(path,this.policyOptions());
   const observation=JSON.parse(bytes.toString('utf8')) as Record<string,unknown>;
   if(url!==undefined&&observation.url!==url||typeof observation.checkedAt!=='string')continue;
   const checkedAt=Date.parse(observation.checkedAt);
   if(!Number.isFinite(checkedAt)||checkedAt<from||checkedAt>to)continue;
   matches.push({path,bytes,observation});
  }
  return matches;
 }
 /** Legacy absence clocks were stamped after writing the failed observation.
  * The reviewed association window is closed at 60 seconds; ambiguous status
  * never becomes an inferred absence. Prefer exact clock matches. */
 private async originalRobotsAbsence(rawRoot:string,robots:SourceAccessPolicy['robots']){
  const evidenceAt=Date.parse(robots.checkedAt??'');
  if(robots.sha256||!Number.isFinite(evidenceAt)||evidenceAt>Date.now())throw new PoliteFetchError('robots_unavailable','Original robots absence clock cannot be established');
  const matches=await this.policyObservations(rawRoot,robots.url,evidenceAt-60000,evidenceAt);
  const exact=matches.filter(row=>row.observation.checkedAt===robots.checkedAt),candidates=exact.length?exact:matches;
  if(!candidates.length)throw new PoliteFetchError('robots_unavailable','Original robots absence observation is unavailable');
  let status:404|410|undefined;
  for(const candidate of candidates){
   const observed=RobotsAbsenceObservationSchema.safeParse(candidate.observation);
   if(!observed.success||status!==undefined&&status!==observed.data.status)throw new PoliteFetchError('robots_unavailable','Original robots absence observations are ambiguous');
   status=observed.data.status;
  }
  candidates.sort((left,right)=>Date.parse(String(right.observation.checkedAt))-Date.parse(String(left.observation.checkedAt))||left.path.localeCompare(right.path));
  const selected=candidates[0];
  return {status:status!,proof:{path:selected.path,observationId:basename(selected.path),receiptSha256:hash(selected.bytes)}};
 }
 /** Transport seam used by disposable fixture servers; production reaches this
  * only through the authority, DNS pinning and exact-host scheduler above. */
 private wireRequest(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined,pinned:{address:string;family:number},nativeHeaders:Record<string,string>):Promise<WireResponse>{
  return new Promise<WireResponse>((done,reject)=>{
    const headers:Record<string,string>={'User-Agent':ua,Accept:'application/json,text/html,application/pdf,text/plain;q=0.8','Accept-Encoding':'identity'};
    if(body!==undefined){Object.assign(headers,nativeHeaders);headers['Content-Length']=String(Buffer.byteLength(body));}
    if(method==='GET'&&validators?.etag)headers['If-None-Match']=validators.etag;
    if(method==='GET'&&validators?.lastModified)headers['If-Modified-Since']=validators.lastModified;
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method,headers,agent:false,family:pinned.family,lookup:(_name,_options,callback)=>callback(null,pinned.address,pinned.family)},response=>{
     const status=response.statusCode??0;
     const selected:Record<string,string|undefined>={};for(const key of ['content-type','content-length','content-encoding','etag','last-modified','location','tdm-reservation','tdm-policy','x-robots-tag','retry-after']){const value=response.headers[key];selected[key]=Array.isArray(value)?value[0]:value;}
     if(status>=300){response.destroy();clearTimeout(timer);done({status,headers:selected,body:Buffer.alloc(0),conditionalRequestSent:Object.hasOwn(headers,'If-None-Match')||Object.hasOwn(headers,'If-Modified-Since')});return;}
     const encoding=selected['content-encoding']?.toLowerCase()??'identity';
     if(!['identity','gzip','deflate','br'].includes(encoding)){request.destroy(new PoliteFetchError('unsupported_encoding','Unsupported content encoding'));return;}
     if(Number(selected['content-length'])>this.options.maxBytes){request.destroy(new PoliteFetchError('too_large','Response exceeds byte bound'));return;}
     const decoder=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null;
     const stream=decoder?response.pipe(decoder):response,chunks:Buffer[]=[];let bytes=0,wireBytes=0;
     if(decoder)response.on('data',(chunk:Buffer)=>{wireBytes+=chunk.length;if(wireBytes>this.options.maxBytes)request.destroy(new PoliteFetchError('too_large','Encoded response exceeds byte bound'));});
     stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>this.options.maxBytes){request.destroy(new PoliteFetchError('too_large','Decoded response exceeds byte bound'));decoder?.destroy();return;}chunks.push(chunk);});
     stream.on('end',()=>{clearTimeout(timer);done({status,headers:selected,body:Buffer.concat(chunks,bytes),conditionalRequestSent:Object.hasOwn(headers,'If-None-Match')||Object.hasOwn(headers,'If-Modified-Since')});});
     stream.on('error',(error:Error)=>{clearTimeout(timer);request.destroy();reject(error instanceof PoliteFetchError?error:new PoliteFetchError('network_error','Response stream failed'));});
     if(decoder)response.on('error',error=>decoder.destroy(error));
    });
    const timer=setTimeout(()=>request.destroy(new PoliteFetchError('timeout','Request deadline exceeded')),this.options.timeoutMs);
    request.on('error',error=>{clearTimeout(timer);reject(error instanceof PoliteFetchError?error:new PoliteFetchError('network_error','Public request failed'));});
    request.end(body);
   });
 }
 private encodeObservation(value:FetchObservation):string{
  if(value.policy)value.policy=projectSourcePolicyMetadata(value.policy);
  return JSON.stringify(value,null,2)+'\n';
 }
 private async observation(value:FetchObservation,path=join(this.cacheDir,'observations',`${Date.now()}-${randomUUID()}.json`),bytes=this.encodeObservation(value),alreadyManaged=false):Promise<string>{
  await this.initialize();
  const persist=async()=>{await mkdir(join(this.cacheDir,'observations'),{recursive:true});await writeFile(path,bytes,{flag:'wx',mode:0o600});return path;};
  this.policyObservationPaths?.push(path);
  if(!this.publicPolicyFetcher||alreadyManaged)return persist();
  // A denial's actual observation bytes are inventoried as their OWN content
  // for custody/purge only, never as a fetched representation or admissible proof.
  const contentSha256=hash(bytes),sourceSha256=value.sha256??contentSha256;
  return withManagedSourceWrite(this.cacheDir,[{kind:'http_observation',relativePath:relative(this.cacheDir,path),contentSha256,sourceSha256,url:value.url,observationId:basename(path),receiptSha256:contentSha256,independentAllowed:false}],persist,this.policyOptions());
 }
 private async policy(url:URL,hostProfile?:FetchOptions['hostProfile'],ttl=this.options.policyTtlMs):Promise<RobotsPolicy>{
  if(this.publicPolicyFetcher)return this.publicPolicyFetcher.policy(url,hostProfile,ttl);
  const cacheKey=url.origin+':'+ttl;let cached=this.robots.get(cacheKey);
  if(!cached||Date.now()>=cached.expiresAt){const pending=(async()=>{
   const attemptedAt=new Date().toISOString();let result:(FetchedDocument&{validatedPolicy?:ValidatedPolicy})|undefined;
   try{
    result=await this.fetchInternal(new URL('/robots.txt',url).href,{hostProfile},'robots');
    if(result.validatedPolicy?.kind!=='robots')throw new PoliteFetchError('robots_unavailable','Validated robots policy missing');
    const policy=result.validatedPolicy.value;policy.evidence={url:result.url,locator:'robots.txt applicable StadtstackData group',value:'checked',sha256:result.sha256,checkedAt:result.checkedAt};this.delays.set(url.hostname,Math.max(this.delays.get(url.hostname)??0,policy.delayMs));return policy;
   }catch(error){
    if(error instanceof RequestAdmissionInterruption)throw error;
    // RFC 9309 unavailable 404/410 allows access; 401/403/429 and failures fail closed.
    if(error instanceof PoliteFetchError&&error.failure==='http_error'&&(error.status===404||error.status===410))return {rules:[],delayMs:0,evidence:{url:new URL('/robots.txt',url).href,locator:'robots.txt HTTP absence',value:String(error.status),checkedAt:error.observationCheckedAt??new Date().toISOString()}};
    // Transport/runtime errors (including network_error) and unknown exceptions
    // are not evidence that a fetched policy is unavailable or invalid.
    const failure=error instanceof PoliteFetchError?error:new PoliteFetchError('network_error','Robots policy check failed',undefined,undefined,undefined,error);
    failure.policyPhase??='robots';
    if(failure.status===429||(failure.failure!=='http_error'&&failure.failure!=='robots_unavailable'))throw failure;
    const unavailable=new PoliteFetchError('robots_unavailable',`Robots policy unavailable${failure.status?` (policy HTTP ${failure.status})`:''}; source existence is unknown`,failure.status,undefined,failure.retryAfter,failure);
    unavailable.policyPhase=failure.policyPhase;
    unavailable.robotsEvidence=failure.robotsEvidence??{url:new URL('/robots.txt',url).href,locator:'Actual robots retrieval/interpretation attempt unavailable',value:'unavailable',checkedAt:result?.checkedAt??attemptedAt,...(result?{sha256:result.sha256}:{})};throw unavailable;
   }
  })();cached={expiresAt:Date.now()+ttl,response:pending};this.robots.set(cacheKey,cached);}
  return cached.response;
 }
 private async machinePolicy(url:URL,knownUrl?:string,ownerRobotsOverride?:OwnerRobotsOverride,hostProfile?:FetchOptions['hostProfile'],ttl=this.options.policyTtlMs):Promise<{rules:TdmRule[];evidence:PolicyEvidence}>{
  if(this.publicPolicyFetcher)return this.publicPolicyFetcher.machinePolicy(url,knownUrl,ownerRobotsOverride,hostProfile,ttl);
  const policyUrl=knownUrl?publicUrl(knownUrl).href:new URL('/.well-known/tdmrep.json',url).href;
  const cacheKey=`${knownUrl?'required':'standard'}:${policyUrl}:${ownerRobotsOverrideApplies(policyUrl,ownerRobotsOverride)?ownerRobotsOverride!.id:'no-override'}:${ttl}`;
  let cached=this.machinePolicies.get(cacheKey);
  if(!cached||Date.now()>=cached.expiresAt){
   const pending=(async()=>{
    // Standardized location, not a guessed municipal API: W3C TDMRep 2024 §6.1.
    const redirectChain=knownUrl?undefined:[policyUrl];
    try{
     const response=await this.fetchInternal(policyUrl,{ownerRobotsOverride,hostProfile},'tdm',redirectChain);
     if(response.validatedPolicy?.kind!=='tdm')throw new PoliteFetchError('tdm_unavailable','Validated TDM policy missing');
     return {rules:response.validatedPolicy.value,evidence:{url:response.url,locator:'W3C TDMRep origin rules',value:'checked',sha256:response.sha256,checkedAt:response.checkedAt}};
    }catch(error){
     if(error instanceof RequestAdmissionInterruption)throw error;
     if(!knownUrl&&error instanceof PoliteFetchError&&error.failure==='http_error'&&(error.status===404||error.status===410))return {rules:[],evidence:{url:redirectChain?.at(-1)??policyUrl,locator:`TDMRep standardized location HTTP absence${redirectChain&&redirectChain.length>1?' after same-host redirect':''}`,value:String(error.status),checkedAt:new Date().toISOString()}};
     // Only actual HTTP/policy-representation failures become policy unavailability.
     // Preserve network_error, DNS/timeout, cache/limit/redirect and unknown errors.
     const failure=error instanceof PoliteFetchError?error:new PoliteFetchError('network_error','TDM policy check failed',undefined,undefined,undefined,error);
     failure.policyPhase??='tdm';
     if(failure.status===429||(failure.failure!=='http_error'&&failure.failure!=='tdm_unavailable'))throw failure;
     const unavailable=new PoliteFetchError('tdm_unavailable',`Machine-readable TDM policy could not be checked${failure.status?` (policy HTTP ${failure.status})`:''}; ask municipality`,failure.status,undefined,failure.retryAfter,failure);
     unavailable.policyPhase=failure.policyPhase;throw unavailable;
    }
   })();cached={expiresAt:Date.now()+ttl,response:pending};this.machinePolicies.set(cacheKey,cached);
  }
  return cached.response;
 }
 /** Authorized current-proof operation: policy endpoints only, never the original body.
  * A new operation bypasses in-memory TTLs, but retains genuine HTTP validators.
  * Even a permissive policy change is a hold; old body-specific findings stay old. */
 async refreshPolicyForOriginal(source:{url:string;sha256:string},original:SourceAccessPolicy,options:Pick<FetchOptions,'machinePolicyUrls'|'hostProfile'>&{originalPolicyRoot?:string;scope?:{municipalityId:string;sourceId:string;ags:string}}={}){
  const input=source.url;
  await this.initialize();await this.assertHostAllowed(input);
  const url=publicUrl(input);
  if(this.publicPolicyFetcher||original.access!=='public'||this.policyObservationPaths)throw new PoliteFetchError('host_state_unsafe','Policy refresh requires an exclusive public policy lane');
  this.robots.clear();this.machinePolicies.clear();this.policyObservationPaths=[];
  this.policyRefreshOriginalUrl=url.origin+url.pathname+url.search;
  try{
   const absence=original.robots.sha256===undefined?await this.originalRobotsAbsence(options.originalPolicyRoot??this.cacheDir,original.robots):undefined;
   const robots=await this.policy(url,options.hostProfile);
   const currentRobots={state:robotsAllows(robots,input)?'allowed' as const:'blocked' as const,url:robots.evidence!.url,...(robots.evidence!.sha256?{sha256:robots.evidence!.sha256}:{}),checkedAt:robots.evidence!.checkedAt};
   const withoutClock=(value:PolicyEvidence|SourceAccessPolicy['robots'])=>{const {checkedAt,...fields}=value;return semanticHash(fields);};
   if(withoutClock(currentRobots)!==withoutClock(original.robots))throw new PoliteFetchError('robots_blocked','Robots policy changed; original held');
   if(absence&&robots.evidence!.value!==String(absence.status))throw new PoliteFetchError('robots_blocked','Robots absence status changed; original held');
   const originEvidence:PolicyEvidence[]=[];
   const knownPolicies=[...new Set((options.machinePolicyUrls??[]).map(value=>publicUrl(value)).filter(candidate=>candidate.pathname!=='/robots.txt'&&candidate.origin===url.origin).map(candidate=>candidate.href))];
   for(const knownUrl of [undefined,...knownPolicies]){
    const current=await this.machinePolicy(url,knownUrl,original.ownerRobotsOverride,options.hostProfile);
    originEvidence.push(current.evidence);
    const rule=tdmRuleForUrl(current.rules,input);
    if(rule)originEvidence.push({...current.evidence,locator:'TDMRep matching location',value:String(rule['tdm-reservation'])});
   }
   const isOrigin=isOriginTdmEvidence;
   const oldOrigin=original.tdm.evidence.filter(isOrigin);
   if(!oldOrigin.length||JSON.stringify(oldOrigin.map(withoutClock))!==JSON.stringify(originEvidence.map(withoutClock)))throw new PoliteFetchError('tdm_reserved','TDMRep policy changed; original held');
   const sourcePolicy={...original,robots:currentRobots,tdm:{...original.tdm,evidence:[...original.tdm.evidence.filter(row=>!isOrigin(row)),...originEvidence]}};
   if(!effectiveSourcePermission(sourcePolicy,source))throw new PoliteFetchError('tdm_reserved','Current source policy refuses original');
   const clocks=[currentRobots.checkedAt,...originEvidence.map(row=>row.checkedAt)];
   if(clocks.some(clock=>!clock||!Number.isFinite(Date.parse(clock))||Date.parse(clock)>Date.now()))throw new PoliteFetchError('host_state_unsafe','Current policy clock is incomplete');
   await this.assertHostAllowed(input);
   return {sourcePolicy,expiresAt:new Date(Math.min(...clocks.map(clock=>Date.parse(clock!)))+sourcePolicyValidityMs(sourcePolicy,source,options.scope)).toISOString(),observations:[...this.policyObservationPaths],...(absence?{originalRobotsAbsence:absence.proof}:{})};
  }catch(error){if(error instanceof RequestAdmissionInterruption)throw error.admissionError;throw error;}finally{this.policyObservationPaths=undefined;this.policyRefreshOriginalUrl=undefined;}
 }
 async fetch(url:string,options:FetchOptions={}):Promise<FetchedDocument>{
  await this.initialize();this.fetchCount++;
  try{
   if(!this.publicPolicyFetcher&&options.method==='POST'&&options.publicOperation==='genesis_guest'&&ownerGenesisAccessFor(url)){
    this.ownerAccountFetcher??=new PoliteFetcher({...this.options,cacheDir:genesisOwnerAccountRoot(this.cacheDir),ownerPolicyLane:this.activeLane,fixtureInspection:this.fixtureInspection,beforeRequest:this.beforeRequest,onRedirect:this.onRedirect},this);
    await this.ownerAccountFetcher.initialize();
    return await this.ownerAccountFetcher.fetchInternal(url,options,'document');
   }
   return await this.fetchInternal(url,options,'document');
  }catch(error){if(error instanceof RequestAdmissionInterruption)throw error.admissionError;throw error;}
 }
 private async fetchInternal(input:string,options:FetchOptions,resource:'document'|'robots'|'tdm',standardTdmChain?:string[]):Promise<FetchedDocument&{validatedPolicy?:ValidatedPolicy}>{
  const checkRobots=resource!=='robots',checkTdm=resource==='document';
  let url=publicUrl(input),method=options.method??'GET',body=options.body;
  const registeredAudit=this.registeredAudit(url.href,options);
  const registeredApproval=Boolean(registeredAudit)||ownerRobotsOverrideApplies(options.registeredSourceUrl??input,options.ownerRobotsOverride);
  const registeredOwnerAccount=this.publicPolicyFetcher&&options.registeredSourceId==='regionalstatistik-genesis'&&ownerGenesisRobotsDecisionFor(url.href)&&this.publicPolicyFetcher.registeredScopes.has(this.registeredKey({municipalityId:options.registeredMunicipalityId,sourceId:options.registeredSourceId,root:options.registeredSourceUrl}));
  const policyTtlMs=registeredAudit||registeredOwnerAccount?REGISTERED_SOURCE_POLICY_VALIDITY_MS:this.options.policyTtlMs;
  if(method==='POST'&&(!body||Buffer.byteLength(body)>65536))throw new PoliteFetchError('unsafe_url','Only bounded public form requests supported');
  if(body!==undefined)for(const key of new URLSearchParams(body).keys())if(/^(?:password|secret|authorization|access_token|api_key|apikey|sessionid|phpsessid|cookie)$/i.test(key))throw new PoliteFetchError('unsafe_url','Credential-bearing public form rejected');
  const redirectLimit=standardTdmChain?Math.min(5,this.options.maxRedirects):this.options.maxRedirects;
  const actualRedirectChain=[url.href],originalMethod=method,originalBody=body;
  for(let redirects=0;redirects<=redirectLimit;redirects++){
   if(options.hostProfile==='municipal')this.delays.set(url.hostname,Math.max(5000,this.delays.get(url.hostname)??0));
   let checkedAt=new Date().toISOString();const observation:FetchObservation={url:url.href,method,checkedAt,retrievedAt:null,state:'failed'};
   const policy:SourceAccessPolicy={robots:{state:'unavailable',url:new URL('/robots.txt',url).href},tdm:{state:'unavailable',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'};
   observation.policy=policy;
   let requestMetadataPath:string|undefined;
   let policyPhase:PoliteFetchError['policyPhase']=resource==='document'?null:resource;
   let ownerCredentials:GenesisOwnerCredentials|undefined;
   try{
    await this.assertHostAllowed(url.href);
    if(registeredAudit)for(const contextUrl of [registeredAudit.root,registeredAudit.discovery?.from,registeredAudit.discovery?.anchor?.url])if(contextUrl&&new URL(contextUrl).hostname!==url.hostname)await this.assertHostAllowed(contextUrl);
    if(/\/(?:login|signin|auth|anmelden)(?:\/|$)/i.test(url.pathname)){policy.access='authentication';throw new PoliteFetchError('access_barrier','Authentication endpoint is outside public acquisition');}
    if(checkRobots){
     let robots:RobotsPolicy|undefined;
     try{robots=await this.policy(url,options.hostProfile,policyTtlMs);}
     catch(error){
      if(!(error instanceof PoliteFetchError)||error.failure!=='robots_unavailable'||!registeredApproval)throw error;
      if(error.robotsEvidence?.checkedAt)policy.robots.checkedAt=error.robotsEvidence.checkedAt;if(error.robotsEvidence?.sha256)policy.robots.sha256=error.robotsEvidence.sha256;
     }
     if(robots){policy.robots.url=robots.evidence?.url??policy.robots.url;if(robots.evidence?.sha256)policy.robots.sha256=robots.evidence.sha256;if(robots.evidence?.checkedAt)policy.robots.checkedAt=robots.evidence.checkedAt;policy.robots.state=robotsAllows(robots,url.href)?'allowed':'blocked';}
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
     const knownPolicies=[...new Set((options.machinePolicyUrls??[]).map(value=>publicUrl(value)).filter(candidate=>candidate.pathname!=='/robots.txt'&&candidate.origin===url.origin).map(candidate=>candidate.href))];
     for(const knownUrl of [undefined,...knownPolicies]){
      let originPolicy:{rules:TdmRule[];evidence:PolicyEvidence};
      try{originPolicy=await this.machinePolicy(url,knownUrl,registeredApproval?ownerRobotsOverrideFor(url.href)??undefined:undefined,options.hostProfile,policyTtlMs);}catch(error){policy.tdm.state='unavailable';policy.tdm.evidence.push({url:knownUrl??new URL('/.well-known/tdmrep.json',url).href,locator:'Machine policy retrieval or interpretation failed',value:'inaccessible',checkedAt});throw error;}
      policy.tdm.evidence.push(originPolicy.evidence);const rule=tdmRuleForUrl(originPolicy.rules,url.href);
      if(rule){if(policy.tdm.state!=='reserved')policy.tdm.state=rule['tdm-reservation']===1?'reserved':'not_reserved';policy.tdm.evidence.push({...originPolicy.evidence,locator:'TDMRep matching location',value:String(rule['tdm-reservation'])});}
      if(policy.tdm.state==='reserved'&&!registeredApproval)throw new PoliteFetchError('tdm_reserved','Machine-readable TDM reservation; no owner-authorized official-work exception');
     }
    }
    const key=hash(method+' '+url.href+'\n'+(body??'')+(options.publicOperation?'\npublic-operation:'+options.publicOperation:'')),meta=join(this.cacheDir,'requests',key+'.json');let previous:FetchObservation|undefined;
    if(!this.publicPolicyFetcher){
     requestMetadataPath=meta;
     try{previous=JSON.parse(await readFile(meta,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new PoliteFetchError('cache_missing','Invalid cache metadata');}
    }
    const ownerDecision=resource==='document'&&options.publicOperation==='genesis_guest'&&method==='POST'?ownerGenesisAccessFor(url.href):null;
    if(ownerDecision&&this.publicPolicyFetcher){
     policy.access='authentication';
     try{ownerCredentials=await readGenesisOwnerCredentials();}catch{throw new PoliteFetchError('credential_unavailable','credential_unavailable');}
     if(ownerCredentials.contains(url.href)||ownerCredentials.contains(body??''))throw new PoliteFetchError('credential_unavailable','credential_unavailable');
     policy.access='authenticated_owner_account';policy.ownerAccountAccess={decisionId:ownerDecision.id,credentialKind:ownerCredentials.kind};
     if(policy.robots.state==='blocked'){
      const robotsDecision=ownerGenesisRobotsDecisionFor(url.href,policy.ownerAccountAccess);
      if(robotsDecision)policy.ownerAccountAccess.robotsDecisionId=robotsDecision.id;
     }
    }
    if(this.policyRefreshOriginalUrl===url.origin+url.pathname+url.search)throw new PoliteFetchError('host_state_unsafe','Policy refresh must not request the original body URL');
    const requestValidators=this.policyObservationPaths&&resource!=='document'?await this.currentPolicyValidators(url,method,previous):previous?.state==='excluded'?undefined:previous;
    const response=await this.wire(url,method,body,requestValidators,options.publicOperation,ownerCredentials);checkedAt=new Date().toISOString();observation.checkedAt=checkedAt;observation.status=response.status;
    if(ownerCredentials)try{ownerCredentials.screenResponse(response.body,response.headers,response.status);}catch{throw new PoliteFetchError('access_barrier','Authenticated response withheld');}
    if([301,302,303,307,308].includes(response.status)){
     if(!response.headers.location)throw new PoliteFetchError('invalid_redirect','Missing redirect destination',response.status);
     const next=publicUrl(new URL(response.headers.location,url).href);observation.location=next.href;observation.state='redirected';
     if(ownerCredentials)throw new PoliteFetchError(next.hostname!==url.hostname?'cross_host_redirect':'invalid_redirect','Authenticated source redirects are refused',response.status);
     if(/\/(?:login|signin|auth|anmelden)(?:\/|$)/i.test(next.pathname)){policy.access='authentication';throw new PoliteFetchError('access_barrier','Authentication redirect; ask municipality');}
     if(resource!=='document'&&!standardTdmChain)throw new PoliteFetchError('invalid_redirect','Policy-resource redirects are not authorized as policy representations',response.status);
     if(standardTdmChain){
      const sameOrigin=next.origin===url.origin;
      const secureUpgrade=url.protocol==='http:'&&next.protocol==='https:'&&next.hostname===url.hostname&&next.port===url.port;
      if(!sameOrigin&&!secureUpgrade)throw new PoliteFetchError('cross_host_redirect','Standardized TDM policy redirect must preserve origin or upgrade HTTP to HTTPS',response.status);
      if(standardTdmChain.includes(next.href))throw new PoliteFetchError('redirect_limit','Standardized TDM policy redirect loop',response.status);
     }
     // Host-keyed provenance cannot safely transfer an origin's contribution
     // to a different host; refuse before any destination request or retention.
     if(next.hostname!==url.hostname)throw new PoliteFetchError('cross_host_redirect','Cross-host source redirect cannot preserve registered-source provenance',response.status);
     await this.observation(observation);
     if(redirects===redirectLimit)throw new PoliteFetchError('redirect_limit','Redirect bound exceeded');
     standardTdmChain?.push(next.href);
     if(method==='POST'&&next.origin!==url.origin)throw new PoliteFetchError('invalid_redirect','Cross-origin form redirect rejected');
     this.onRedirect?.({requestUrl:input,from:url.href,to:next.href,status:response.status});
     actualRedirectChain.push(next.href);
     if(response.status===303||method==='POST'&&[301,302].includes(response.status)){method='GET';body=undefined;}
     url=next;continue;
    }
    const cooldown=ownerRobotsOverrideFor(url.href)&&(response.status===403||response.status===429)?new Date(Math.max(Date.now()+HOST_COOLDOWN_MS,retryAfterTime(response.headers['retry-after'],Date.now()))).toISOString():undefined;
    if([401,402,403].includes(response.status)){policy.access=response.status===402?'paywall':'authentication';throw new PoliteFetchError('access_barrier',`HTTP ${response.status} access barrier; ask municipality`,response.status,undefined,cooldown);}
    if(response.status===429)throw new PoliteFetchError('http_error','HTTP 429 rate limit; no automatic retry',429,undefined,cooldown);
    await this.assertHostAllowed(url.href);
    let representation:Buffer,sha256:string,retrievedAt:string,localPath:string,mimeType:string;
    let retainedPolicyEvidence:PolicyEvidence[]|undefined;
    if(response.status===304){
     if(this.policyObservationPaths&&resource!=='document'&&(!requestValidators||!response.conditionalRequestSent))throw new PoliteFetchError('cache_missing','Current policy 304 lacks an authenticated dispatched validator',304);
     if(!previous?.sha256||!previous.retrievedAt||previous.state==='excluded')throw new PoliteFetchError('cache_missing','304 without an eligible retained representation',304);
     sha256=previous.sha256;retrievedAt=previous.retrievedAt;localPath=join(this.cacheDir,'sha256',sha256);mimeType=previous.mimeType??'application/octet-stream';
     try{
      await assertManagedSourceReadable(localPath,{...this.policyOptions(),sourceUrl:url.href});representation=await readFile(localPath);
      await assertManagedSourceReadable(localPath,{...this.policyOptions(),sourceUrl:url.href});
     }catch(error){
      if(error instanceof HostOptedOutError||error instanceof CivicPolicyStateError&&!['ENOENT','CONTENT_BINDING_MISMATCH','CONTENT_PROVENANCE_MISSING','CONTENT_REFERENCE_REVOKED'].includes(error.code))throw error;
      throw new PoliteFetchError('cache_missing','304 retained representation is not currently readable',304);
     }
     if(hash(representation)!==sha256)throw new PoliteFetchError('cache_missing','304 raw digest mismatch',304);
     // Omitted 304 fields retain their original structured finding and digest.
     // A policy-reference sentinel is never fabricated into a wire header.
     const retained:PolicyEvidence[]=[];
     for(const [header,locator] of Object.entries(representationPolicyLocators)){
      const prior=previous.policy?.tdm.evidence.filter(item=>item.url===url.href&&item.locator===locator)??[];
      if(header==='tdm-reservation'){
       const update=parseTdmReservation(response.headers[header]);if(update.state==='valid')continue;
       const declaration=prior.findLast(item=>item.value==='1')??prior.findLast(item=>item.value==='0');
       if(declaration)retained.push(declaration);
       const invalid=update.state==='absent'?prior.findLast(item=>item.value==='invalid_reservation_declaration'):undefined;
       if(invalid)retained.push(invalid);
      }else{
       if(response.headers[header]!==undefined)continue;
       const evidence=prior.at(-1);if(evidence)retained.push(evidence);
      }
     }
     if(previous.policy&&retained.length)retainedPolicyEvidence=projectSourcePolicyMetadata({...previous.policy,tdm:{...previous.policy.tdm,evidence:retained}}).tdm.evidence;
     Object.assign(observation,previous,{url:url.href,method,checkedAt,state:'not_modified',status:304,policy,bytes:representation.length,etag:response.headers.etag??previous.etag,lastModified:response.headers['last-modified']??previous.lastModified});
     delete observation.failure;delete observation.retryAfter;delete observation.exclusion;
    }else{
     if(response.status<200||response.status>=300)throw new PoliteFetchError('http_error',`HTTP ${response.status}`,response.status);
     representation=response.body;sha256=hash(representation);retrievedAt=checkedAt;
     const prefix=representation.subarray(0,256).toString('utf8').trimStart();
     mimeType=prefix.startsWith('%PDF-')?'application/pdf':representation.length>=4&&representation[0]===0x50&&representation[1]===0x4b&&[3,5,7].includes(representation[2])?'application/zip':(response.headers['content-type']??'application/octet-stream').split(';')[0].trim().toLowerCase();
     if((mimeType==='application/octet-stream'||mimeType==='text/plain')&&/^<\?xml\b|^<(?:gml|xplan|wfs):/i.test(prefix))mimeType='application/xml';
     localPath=this.publicPolicyFetcher?join(this.cacheDir,'sha256',sha256.slice(0,2),sha256):join(this.cacheDir,'sha256',sha256);
     Object.assign(observation,{state:'fetched',sha256,retrievedAt,mimeType,bytes:representation.length});
    }
    if(checkTdm)policyPhase='tdm';
    const inspectionContext:ParserSourceContext={...this.activeLane!,root:this.cacheDir,kind:this.publicPolicyFetcher?'artifacts':'fetch',purpose:'classification',bindings:[{phase:'pre-admission',url:url.href,sourceSha256:sha256}]};
    let validatedPolicy:ValidatedPolicy|undefined;
    const inspect=async(sandbox?:ParserSandbox)=>{
    const resourcePolicy=await (this.fixtureInspection?.resource??inspectResourcePolicySandbox)(url.href,response.headers,representation,mimeType,inspectionContext,sandbox);
    resourcePolicy.evidence=resourcePolicy.evidence.map(row=>({...row,checkedAt}));
    if(retainedPolicyEvidence){
     for(const evidence of retainedPolicyEvidence){
      if(evidence.locator==='HTTP TDM-Reservation'&&evidence.value==='1'||evidence.locator==='HTTP X-Robots-Tag'&&/(?:^|,)(?:noai|noimageai)(?:,|$)/.test(evidence.value))resourcePolicy.reservation=1;
      else if(evidence.locator==='HTTP TDM-Reservation'&&evidence.value==='0'&&resourcePolicy.reservation!==1)resourcePolicy.reservation=0;
      if(evidence.locator==='HTTP TDM-Policy'&&evidence.value==='invalid_policy_reference'){resourcePolicy.referenceUnavailable=true;resourcePolicy.unavailable=true;}
      if(evidence.locator==='HTTP TDM-Reservation'&&evidence.value==='invalid_reservation_declaration'){resourcePolicy.declarationUnavailable=true;resourcePolicy.unavailable=true;}
     }
     resourcePolicy.evidence.unshift(...retainedPolicyEvidence);
    }
    policy.access=ownerCredentials&&resourcePolicy.access==='public'?'authenticated_owner_account':resourcePolicy.access;
    if(policy.access!=='authenticated_owner_account')delete policy.ownerAccountAccess;
    // Representation headers remain ahead of potentially numerous origin rules
    // so bounded metadata cannot lose the fields needed for the next 304.
    policy.tdm.evidence.unshift(...resourcePolicy.evidence);
    if(checkTdm&&registeredAudit&&registeredRobotsAuditApplies(registeredAudit,url.href))policy.tdm.evidence.unshift(registeredRobotsEvidence(registeredAudit,url.href,checkedAt));
    if(resourcePolicy.reservation!==null&&policy.tdm.state!=='reserved')policy.tdm.state=resourcePolicy.reservation===1?'reserved':'not_reserved';
    if(resourcePolicy.referenceUnavailable)policy.tdm.referenceStatus='unavailable';
    if(resourcePolicy.declarationUnavailable){policy.tdm.declarationStatus='unavailable';if(policy.tdm.state!=='reserved')policy.tdm.state='unavailable';}
    if(policy.access!=='public'&&policy.access!=='authenticated_owner_account')throw new PoliteFetchError('access_barrier',`${policy.access} barrier; ask municipality`);
    if(checkTdm&&(policy.tdm.referenceStatus==='unavailable'||policy.tdm.declarationStatus==='unavailable'))throw new PoliteFetchError('tdm_unavailable','Machine-readable TDM declaration or policy reference is unavailable; source withheld');
    if(resource==='robots'){
     try{
      // Validate actual UTF-8 directives; a mislabeled text response must not
      // downgrade a real Disallow declaration into an owner-bypassable absence.
      const text=new TextDecoder('utf-8',{fatal:true}).decode(representation);
      if(text.replace(/^\uFEFF/,'').split(/\r?\n/).some(line=>{const directive=line.split('#')[0].trim();return directive!==''&&!/^[a-z-]+\s*:/i.test(directive);}))throw Error('Non-policy robots content');
      validatedPolicy={kind:'robots',value:parseRobots(text)};
     }catch{
      const failure=new PoliteFetchError('robots_unavailable','Robots response is not a validated policy representation',response.status);
      failure.robotsEvidence={url:url.href,locator:'Robots representation rejected before raw retention',value:'unavailable',sha256,checkedAt};throw failure;
     }
    }else if(resource==='tdm'){
     try{
      if(!/^(?:application|text)\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(mimeType))throw Error('Unexpected TDM representation');
      validatedPolicy={kind:'tdm',value:parseTdmRules(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(representation)))};
     }catch{throw new PoliteFetchError('tdm_unavailable','TDM response is not a validated policy representation',response.status);}
    }
    if(checkTdm&&policy.tdm.state==='reserved'&&!registeredApproval)throw new PoliteFetchError('tdm_reserved','Machine-readable TDM reservation; no owner-authorized official-work exception');
    const oparlContext=options.oparlContext&&options.oparlContext.apiUrl===url.href&&/^(?:application|text)\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(mimeType)?options.oparlContext:undefined;
    if(checkTdm)policy.documentOrigin=await (this.fixtureInspection?.origin??classifyDocumentOrigin)({url:url.href,mimeType,bytes:representation,title:options.title,linkText:options.linkText,municipalityName:options.municipalityName,oparlContext},{scratch:inspectionContext,...(sandbox?{sandbox}:{})});
    if(checkTdm&&mimeType==='application/pdf'){
     // A returned unavailable finding describes the source metadata below.
     // Inspection/cache/runtime exceptions are not source-policy findings.
     const pdfPolicy=await (this.fixtureInspection?.pdf??inspectPdfTdmPolicy)(representation,sha256,this.cacheDir,inspectionContext,sandbox);
     if(pdfPolicy){
      const finding=pdfPolicy.finding;
      if(finding.state==='unavailable'&&!Object.hasOwn(pdfSourceMetadataFailures,finding.reason))throw new PoliteFetchError('network_error','PDF policy inspection runtime unavailable',undefined,undefined,undefined,{kind:'pdf_policy_runtime',reason:finding.reason});
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
    };
    // Policy endpoints remain distinct representations/scopes. A document runs
    // resource gates, origin and (when needed) PDF commands sequentially here.
    await this.withInspectionSandbox(representation,inspectionContext,inspect);
    Object.assign(policy,projectSourcePolicyMetadata(policy));
    if(checkTdm&&(policy.tdm.referenceStatus==='unavailable'||policy.tdm.declarationStatus==='unavailable'))throw new PoliteFetchError('tdm_unavailable','Machine-readable TDM declaration or policy reference is unavailable; source withheld');
    if(checkTdm&&policy.tdm.state==='reserved'&&!registeredApproval)throw new PoliteFetchError('tdm_reserved','PDF machine-readable TDM reservation; no owner-authorized official-work exception');
    await this.assertHostAllowed(url.href);
    if(checkTdm&&documentOriginExcludes(policy,{url:url.href,sha256})){
     const previousManagedCopy=this.publicPolicyFetcher?'not_managed':(await relinquishManagedSourceContent(this.cacheDir,{url:url.href,sourceSha256:sha256},this.policyOptions())).disposition;
     const exclusion:ExcludedDocument['exclusion']={reason:'non_official_restricted',excludedAt:new Date().toISOString(),previousManagedCopy};
     Object.assign(observation,{state:'excluded',exclusion,sha256,retrievedAt,mimeType,bytes:representation.length});delete observation.etag;delete observation.lastModified;
     const observationPath=await this.observation(observation);
     if(!this.publicPolicyFetcher){await mkdir(join(this.cacheDir,'requests'),{recursive:true});const temporary=meta+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(observation),{mode:0o600,flag:'wx'});await rename(temporary,meta);}
     const failure=new PoliteFetchError('document_excluded','Non-official or uncertain work excluded under robots denial or TDM reservation',response.status,observation.policy);
     failure.excludedDocument={url:url.href,sha256,mimeType,retrievedAt,checkedAt,status:response.status,observationPath,policy:observation.policy!,sizeBytes:representation.length,exclusion};throw failure;
    }
    if(checkTdm&&policy.tdm.state==='reserved'&&registeredApproval&&policy.documentOrigin?.classification==='official_work'){
     policy.ownerTdmOverride=ownerRobotsOverrideFor(url.href)!;policy.tdmOverride='owner-approved 2026-10-11';
    }
    if(checkTdm&&!effectiveSourcePermission(policy,{url:url.href,sha256}))throw new PoliteFetchError(policy.tdm.state==='reserved'?'tdm_reserved':'tdm_unavailable','Source policy does not authorize retaining this representation');
    policyPhase=null;
    observation.etag=response.headers.etag??observation.etag;observation.lastModified=response.headers['last-modified']??observation.lastModified;
    const observationPath=join(this.cacheDir,'observations',`${Date.now()}-${randomUUID()}.json`),observationBytes=this.encodeObservation(observation);
    const persist=async()=>{
     await this.assertHostAllowed(url.href);
     await mkdir(dirname(localPath),{recursive:true});await writeFile(localPath,representation,{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});
     await this.observation(observation,observationPath,observationBytes,!!this.publicPolicyFetcher);
     if(!this.publicPolicyFetcher){await mkdir(join(this.cacheDir,'requests'),{recursive:true});const temporary=meta+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(observation),{mode:0o600,flag:'wx'});await rename(temporary,meta);}
    };
    const sourceEntry={kind:'http_observation' as const,relativePath:relative(this.cacheDir,localPath),contentSha256:sha256,sourceSha256:sha256,url:url.href,observationId:basename(observationPath),receiptSha256:hash(observationBytes),independentAllowed:checkTdm&&effectiveSourcePermission(policy,{url:url.href,sha256})};
    await withManagedSourceWrite(this.cacheDir,[sourceEntry,...(this.publicPolicyFetcher?[{...sourceEntry,relativePath:relative(this.cacheDir,observationPath),contentSha256:hash(observationBytes),independentAllowed:false}]:[])],persist,this.policyOptions());
    if(checkTdm){
     try{
      const publicSelector=originalBody!==undefined&&![...new URLSearchParams(originalBody).keys()].some(key=>/^(?:username|user|password|secret|authorization|access_token|api_key|apikey|token|sessionid|phpsessid|cookie)$/i.test(key))&&String(policy.access)!=='authenticated_owner_account'?originalBody:null;
      await persistCrawlRequestEvidence(this.cacheDir,{schemaVersion:'stadtstack-crawl-request-evidence-v1',httpObservation:{kind:'http_observation',url:url.href,sourceSha256:sha256,observationId:basename(observationPath),receiptSha256:hash(observationBytes)},request:{url:actualRedirectChain[0],method:originalMethod,contentType:originalBody===undefined?null:nativePublicRequestHeaders(publicUrl(actualRedirectChain[0]),originalMethod,originalBody,options.publicOperation)['Content-Type']??null,bodySha256:originalBody===undefined?null:hash(originalBody),publicSelector},redirectChain:actualRedirectChain},this.policyOptions());
     }catch{throw new CrawlRequestEvidenceCaptureError();}
    }
    return {url:url.href,sha256,localPath,mimeType,retrievedAt,checkedAt,status:response.status,observationPath,policy:observation.policy,...(validatedPolicy?{validatedPolicy}:{})};
   }catch(error){
    if(error instanceof CrawlRequestEvidenceCaptureError)throw error;
    if(error instanceof RequestAdmissionInterruption){Object.assign(policy,projectSourcePolicyMetadata(policy));observation.policy=policy;observation.state='failed';observation.failure='host_admission_deferred';await this.observation(observation);throw error;}
    if(error instanceof PoliteFetchError&&error.excludedDocument)throw error;
    Object.assign(policy,projectSourcePolicyMetadata(policy));observation.policy=policy;
    if(policy.access!=='authenticated_owner_account')delete policy.ownerAccountAccess;
    const original=error instanceof PoliteFetchError?error:error instanceof HostOptedOutError?new PoliteFetchError('host_opted_out','Host objection is active; source retention stopped'):error instanceof CivicPolicyStateError?new PoliteFetchError('host_state_unsafe','Managed source inventory is incomplete or unavailable; use an explicitly registered safe acquisition lane'):new PoliteFetchError('network_error','Fetch or cache operation failed',undefined,undefined,undefined,ownerCredentials?undefined:error);
    // An authenticated failure has no remote strings, causes, paths or headers.
    const failure=ownerCredentials?new PoliteFetchError(original.failure,'Authenticated GENESIS request held',original.status):original;
    failure.policyPhase??=policyPhase;failure.policy=policy;observation.state='failed';observation.failure=failure.failure;observation.retryAfter=ownerCredentials?undefined:failure.retryAfter;await this.observation(observation);failure.observationCheckedAt=observation.checkedAt;
    // A failed admission does not undo a 304's representation-header update.
    if(observation.status===304&&observation.sha256&&observation.retrievedAt&&requestMetadataPath){
     await mkdir(join(this.cacheDir,'requests'),{recursive:true});const temporary=requestMetadataPath+'.'+randomUUID()+'.tmp';
     await writeFile(temporary,JSON.stringify(observation),{mode:0o600,flag:'wx'});await rename(temporary,requestMetadataPath);
    }
    throw failure;
   }finally{ownerCredentials?.clear();}
  }
  throw new PoliteFetchError('redirect_limit','Redirect bound exceeded');
 }
}
