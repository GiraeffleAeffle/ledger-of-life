import {createReadStream} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {lstat,mkdir,open,readFile,readdir,realpath,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {HashSchema,canonicalJson,digest,semanticHash,CoverageSchema} from './district-adapter-contract.ts';
import {buildR2StructuredRequestPlan,R2_HOUSING_YEAR} from './r2-structured-request-plan.ts';
import type {R2StructuredRequest} from './r2-structured-request-plan.ts';
import {acquisitionContract,AcquisitionSelectorSchema} from './district-r1.ts';
import type {AcquisitionWireControl} from './district-r1.ts';
import {structuredJobContract} from './district-structured-jobs.ts';
import {parserIsolationContractSha256,PARSER_REVIEW_PATH,readParserReview,collectParserToolVersions} from './district-parser-isolation.ts';
import {operatorRegistryConfigContractSha256} from './district-registry-config.ts';
import {CIVIC_POLICY_AUTHORITY,assertCivicPolicyAuthority} from './civic-opt-out.ts';
import {GENESIS_VERSION} from './adapters/genesis.ts';
import type {StructuredWorkerRequest} from './district-structured-parser-worker.ts';
import type {WireRequestIdentity} from './polite-fetch.ts';

export const GENESIS_PACKAGE_ROOT=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/u,'');
export const GENESIS_OWNER={path:'/home/max/.local/state/stadtstack-data/r2-authorities/stadtstack-data/reports/approvals/r2-owner-approval-2026-10-24.json',sha256:'fc7f7acd93a7ab1c6a3044e24367bec52891a0b96b9b3852276079b7f37ce8e4'};
export const GENESIS_NODE='/home/max/.local/share/mise/installs/node/24.22.1/bin/node';
export const GENESIS_CAPS=Object.freeze({maxNetworkAttempts:104,maxAttemptsPerAction:8,maxTotalBodyBytes:128*1024**2,maxInFlight:1,minSpacingMs:5000,maxElapsedSeconds:7200,wireReserveMs:120000,maxRedirects:0,automaticRetries:0,maxDataPostAttempts:9,maxNativeAcquisitionJobs:9,modelCalls:0,paidMicroUsd:0});
const Pin=z.object({path:z.string().refine(isAbsolute),sha256:HashSchema}).strict();
const Contract=z.object({adapterContractSha256:HashSchema,parserContractSha256:HashSchema,mappingContractSha256:HashSchema,semanticContractSha256:HashSchema}).strict();
const Runtime=z.object({packageRoot:z.string().refine(isAbsolute),node:z.object({path:z.literal(GENESIS_NODE),version:z.literal('v24.22.1'),sha256:HashSchema}).strict(),codeSha256:HashSchema,registryConfigurationSha256:HashSchema,contracts:z.object({acquisition:HashSchema,genesis:Contract,parserIsolation:HashSchema,operatorRegistry:HashSchema}).strict(),policy:z.object({stateDir:z.string().refine(isAbsolute),authorityId:z.string(),authoritySha256:HashSchema}).strict(),parserReviewPath:z.literal(PARSER_REVIEW_PATH),requiredParserNodeVersion:z.literal('v24.22.1')}).strict();
export function genesisRequestPlan(){
 const source=buildR2StructuredRequestPlan(),requests=source.requests.filter(row=>row.sourceId!=='mastr').map(row=>({...row,contentType:row.method==='POST'?'application/x-www-form-urlencoded;charset=UTF-8':null}));
 return {schemaVersion:'r2-genesis-31231-request-plan-v3',sourceId:'regionalstatistik-genesis',table:'31231-02-01',year:R2_HOUSING_YEAR,municipalities:source.municipalities,requests,caps:GENESIS_CAPS,policyGetsAreAutomatic:true,executionOrder:['licence/terms/WADL with automatic policy probes','one anonymous metadata POST and sandbox discovery','STOP for separately committed Main metadata review','nine exact existing-owner-account POSTs through native Core'],noMastr:true};
}
const RecordBase=z.object({schemaVersion:z.literal('r2-genesis-structured-security-release-v3'),id:z.string().regex(/^[a-z0-9-]+$/u),plan:z.unknown(),planSha256:HashSchema,ownerApproval:Pin,runtime:Runtime,executionRoot:z.string().refine(isAbsolute),stopConditions:z.array(z.string().min(1)).min(1)}).strict();
export const GenesisReleaseDraftSchema=RecordBase.extend({status:z.literal('DRAFT'),issuedAt:z.literal(''),approvedBy:z.null(),sourceFetchStopLifted:z.literal(false),requiredIssuanceEvidence:z.array(z.string()).min(1)}).strict();
export const GenesisReleaseSchema=RecordBase.extend({status:z.literal('ISSUED'),issuedAt:z.iso.datetime(),validFrom:z.iso.datetime(),expiresAt:z.iso.datetime(),approvedBy:z.literal('Main'),sourceFetchStopLifted:z.literal(true),reviewEvidence:Pin,parserAuthorization:Pin,registryDescriptor:Pin}).strict();
export type GenesisRelease=z.infer<typeof GenesisReleaseSchema>;
export interface ControlPin {path:string;sha256:string}
export function validateGenesisRelease(raw:unknown,now=Date.now()){
 const record=GenesisReleaseSchema.parse(raw),plan=genesisRequestPlan();
 if(canonicalJson(record.plan)!==canonicalJson(plan)||record.planSha256!==digest(JSON.stringify(plan,null,2)+'\n')||canonicalJson(record.ownerApproval)!==canonicalJson(GENESIS_OWNER))throw Error('GENESIS release changes exact approved source/request/owner scope');
 const issued=Date.parse(record.issuedAt),from=Date.parse(record.validFrom),end=Date.parse(record.expiresAt);
 if(from>issued||issued>now||now>=end||end-issued>GENESIS_CAPS.maxElapsedSeconds*1000||end<=issued)throw Error('GENESIS release is unissued, future, expired or exceeds its wall window');
 return record;
}
export async function checkedPin(pin:ControlPin,maxBytes=8*1024**2){
 Pin.parse(pin);const metadata=await lstat(pin.path);
 if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>maxBytes||await realpath(pin.path)!==pin.path)throw Error('GENESIS control path is not a bounded regular canonical file');
 const bytes=await readFile(pin.path);if(digest(bytes)!==pin.sha256)throw Error('GENESIS control digest mismatch');return bytes;
}
export async function committedPin(pin:ControlPin,authorityRoot:string){
 if(!isAbsolute(authorityRoot)||await realpath(authorityRoot)!==authorityRoot||authorityRoot==='/home/max/civic-rebuild-r1')throw Error('Separate canonical authority worktree required');
 const bytes=await checkedPin(pin),part=relative(authorityRoot,pin.path);
 if(!part.startsWith('stadtstack-data/reports/approvals/')||part.includes('..'))throw Error('GENESIS authority record is outside the approval worktree');
 if(!execFileSync('/usr/bin/git',['-C',authorityRoot,'--no-replace-objects','show','HEAD:'+part]).equals(bytes))throw Error('GENESIS authority record is not genuinely committed');
 return JSON.parse(bytes.toString('utf8')) as unknown;
}
async function fileHash(path:string){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
export async function genesisSecurityCodeSha256(){
 const files:string[]=[];
 async function visit(part:string){for(const item of await readdir(join(GENESIS_PACKAGE_ROOT,part),{withFileTypes:true})){if(item.isSymbolicLink())throw Error('GENESIS security code refuses symlinks');const file=part+'/'+item.name;if(item.isDirectory())await visit(file);else if(item.isFile())files.push(file);}}
 for(const root of ['src','scripts','docker'])await visit(root);
 files.push('package.json','package-lock.json','Dockerfile.parser','Dockerfile.parser.dockerignore','.dockerignore','sources/district-host-groups.json');
 return semanticHash(await Promise.all(files.sort().map(async file=>({file,sha256:await fileHash(join(GENESIS_PACKAGE_ROOT,file))}))));
}
export async function genesisRuntime(){
 const authority=await assertCivicPolicyAuthority();
 return {packageRoot:GENESIS_PACKAGE_ROOT,node:{path:GENESIS_NODE,version:'v24.22.1' as const,sha256:await fileHash(GENESIS_NODE)},codeSha256:await genesisSecurityCodeSha256(),registryConfigurationSha256:await fileHash(join(GENESIS_PACKAGE_ROOT,'sources/district-registry.json')),contracts:{acquisition:await acquisitionContract(),genesis:await structuredJobContract('genesis'),parserIsolation:await parserIsolationContractSha256(),operatorRegistry:await operatorRegistryConfigContractSha256()},policy:{...CIVIC_POLICY_AUTHORITY,authoritySha256:authority.authoritySha256},parserReviewPath:PARSER_REVIEW_PATH,requiredParserNodeVersion:'v24.22.1' as const};
}
export async function genesisReleaseDraft(){
 const plan=genesisRequestPlan();
 return GenesisReleaseDraftSchema.parse({schemaVersion:'r2-genesis-structured-security-release-v3',id:'r2-genesis-31231-2026-10-24-v3',status:'DRAFT',issuedAt:'',approvedBy:null,sourceFetchStopLifted:false,plan,planSha256:digest(JSON.stringify(plan,null,2)+'\n'),ownerApproval:GENESIS_OWNER,runtime:await genesisRuntime(),executionRoot:'/home/max/.local/state/stadtstack-data/r2-genesis-execution',stopConditions:['Missing/changed/unissued/expired release, owner, parser, registry or code review','Any URL, body, source, town, year, credential profile or redirect outside the exact plan','Current robots/TDM/origin/account policy refuses or is unavailable; no new exception','Metadata sandbox does not reproduce the exact nine data requests, or Main review absent','Any HTTP/native/parser hold, unknown result, budget/time/stop-file event or crash; no retry/resume','No MaStR, model, paid API, automatic refresh, publication or guessed table suffix'],requiredIssuanceEvidence:['Genuine Main code/security review pin binding codeSha256 and planSha256','New current root-owned parser authorization pin matching runtime.contracts.parserIsolation and a patched24.22.1 image','Admitted registry descriptor pin for runtime.registryConfigurationSha256','Main issuance clocks bounded by owner expiry; metadata review separately before data']});
}
export async function loadGenesisRelease(pin:ControlPin,authorityRoot:string){
 const record=validateGenesisRelease(await committedPin(pin,authorityRoot));
 const owner=JSON.parse((await checkedPin(record.ownerApproval)).toString('utf8')) as {approved:{expiresAt:string;structuredSources:{genesisHousing:string}}};
 if(!owner.approved.structuredSources.genesisHousing.includes('31231-02-01')||Date.parse(record.expiresAt)>Date.parse(owner.approved.expiresAt))throw Error('GENESIS release exceeds actual owner approval');
 if(process.version!==record.runtime.node.version||await realpath(process.execPath)!==record.runtime.node.path||canonicalJson(await genesisRuntime())!==canonicalJson(record.runtime))throw Error('GENESIS runtime, code, registry or current contracts differ from the issued release');
 const review=JSON.parse((await checkedPin(record.reviewEvidence)).toString('utf8')) as {approvedBy?:string;verdict?:string;codeSha256?:string;planSha256?:string};
 if(review.approvedBy!=='Main'||review.verdict!=='approved'||review.codeSha256!==record.runtime.codeSha256||review.planSha256!==record.planSha256)throw Error('GENESIS actual code/security review missing');
 if(record.parserAuthorization.path!==PARSER_REVIEW_PATH)throw Error('GENESIS parser authorization path mismatch');await checkedPin(record.parserAuthorization);
 const parser=await readParserReview();if(parser.runnerSha256!==record.runtime.contracts.parserIsolation)throw Error('GENESIS current parser authorization differs');
 const versions=await collectParserToolVersions(['node']);if(versions.node!==record.runtime.requiredParserNodeVersion)throw Error('GENESIS parser image runtime is not the required patched Node');
 await checkedPin(record.parserAuthorization);
 return record;
}
export interface GenesisBudgetState {startedAt:number;lastFinishedAt:number;active:string|null;attempts:number;bytes:number;actionAttempts:number;primaryAttempts:number;stopped:boolean}
const BudgetSchema=z.object({startedAt:z.number().int().nonnegative(),lastFinishedAt:z.number().int().nonnegative(),active:z.url().nullable(),attempts:z.number().int().min(1).max(GENESIS_CAPS.maxNetworkAttempts),bytes:z.number().int().nonnegative().max(GENESIS_CAPS.maxTotalBodyBytes),actionAttempts:z.number().int().nonnegative().max(8),primaryAttempts:z.number().int().nonnegative().max(1),stopped:z.boolean()}).strict();
export function initialGenesisBudget(now:number):GenesisBudgetState{return {startedAt:now,lastFinishedAt:0,active:null,attempts:0,bytes:0,actionAttempts:0,primaryAttempts:0,stopped:false};}
/** Pure transitions are independently testable; production persists each event
 * before dispatch and never resumes an interrupted phase. */
export function reserveGenesisAttempt(state:GenesisBudgetState,url:string,primary:R2StructuredRequest,allowedPolicyUrls:readonly string[],now:number,end:number){
 if(state.stopped||state.active||now<state.lastFinishedAt||now+GENESIS_CAPS.wireReserveMs>=end||now-state.startedAt+GENESIS_CAPS.wireReserveMs>=GENESIS_CAPS.maxElapsedSeconds*1000)throw Error('GENESIS stopped, busy, clock or deadline boundary');
 if(url!==primary.url&&!allowedPolicyUrls.includes(url))throw Error('GENESIS wire URL/redirect is outside exact action/policy allowlist');
 if(state.attempts>=GENESIS_CAPS.maxNetworkAttempts||state.actionAttempts>=GENESIS_CAPS.maxAttemptsPerAction)throw Error('GENESIS network attempt cap');
 if(now<state.lastFinishedAt+GENESIS_CAPS.minSpacingMs)throw Error('GENESIS global five-second spacing');
 if(url===primary.url&&state.primaryAttempts>=1)throw Error('GENESIS primary request cannot be retried');
 return {...state,active:url,attempts:state.attempts+1,actionAttempts:state.actionAttempts+1,primaryAttempts:state.primaryAttempts+(url===primary.url?1:0)};
}
export function assertGenesisWireIdentity(url:string,wire:WireRequestIdentity,primary:R2StructuredRequest){
 const expected=url===primary.url?{method:primary.method,body:primary.body,publicOperation:primary.credentials==='existing_owner_headers'?'genesis_guest':null}:{method:'GET',body:null,publicOperation:null};
 if(!wire||wire.method!==expected.method||wire.body!==expected.body||wire.publicOperation!==expected.publicOperation)throw Error('GENESIS actual wire selector differs from the exact method/body/profile');
}
export function accountGenesisChunk(state:GenesisBudgetState,url:string,size:number,attemptBytes:number,responseCap:number,now:number,end:number){
 if(state.stopped||state.active!==url||!Number.isSafeInteger(size)||size<0||now>=end||now-state.startedAt>=GENESIS_CAPS.maxElapsedSeconds*1000||attemptBytes+size>responseCap||state.bytes+size>GENESIS_CAPS.maxTotalBodyBytes)throw Error('GENESIS body/global-byte/time accounting refuses this response');
 return {...state,bytes:state.bytes+size};
}
export function genesisDataSelectors(){
 const plan=genesisRequestPlan(),towns:Readonly<Record<string,string>>=plan.municipalities;
 return plan.requests.filter(row=>row.phase==='genesis_data').map(row=>AcquisitionSelectorSchema.parse({
  version:'district-r1-acquisition-v1',
  scope:{publisherId:'statistische-aemter-bund-laender',sourceId:'regionalstatistik-genesis',municipalityId:row.municipalityId,ags:towns[row.municipalityId!],tenant:null,observationWindow:R2_HOUSING_YEAR},
  root:row.url,request:{url:row.url,method:'POST',body:row.body,contentType:row.contentType,publicOperation:'genesis_guest'},
  permission:{kind:'facts_with_attribution'},maxRequests:GENESIS_CAPS.maxAttemptsPerAction,maxBytes:row.maxBodyBytes,
  sourceVersion:null,discovery:null,
 }));
}
const Resource=z.object({url:z.url(),nativeId:z.string(),parentId:z.string().nullable(),method:z.enum(['GET','POST']),body:z.string().nullable(),format:z.string()}).strict();
export function readGenesisDiscoveryReply(request:StructuredWorkerRequest,stdout:string){
 const output=z.object({version:z.literal('district-structured-worker-v1'),requestSha256:HashSchema,adapterId:z.literal('regionalstatistik-genesis'),adapterVersion:z.literal(GENESIS_VERSION),result:z.object({resources:z.array(Resource),coverage:CoverageSchema}).strict(),page:z.null()}).strict().parse(JSON.parse(stdout));
 if(request.operation!=='discover'||request.adapter!=='genesis'||output.requestSha256!==semanticHash(request)||output.result.coverage.state!=='partial')throw Error('GENESIS sandbox discovery binding/admission mismatch');
 return output.result;
}
export function checkGenesisMetadataReply(request:StructuredWorkerRequest,stdout:string){
 const output=readGenesisDiscoveryReply(request,stdout),expected=genesisRequestPlan().requests.find(row=>row.phase==='genesis_data'&&row.municipalityId===request.scope.municipalityId),resource=output.resources[0];
 if(!expected||output.resources.length!==1||resource.url!==expected.url||resource.method!==expected.method||resource.body!==expected.body||resource.parentId!=='31231-02-01:metadata/table')throw Error('GENESIS metadata does not reproduce the exact approved municipal request');
 return resource;
}

export async function syncGenesisDirectory(path:string){const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}}

export class GenesisWireCustody {
 private state:GenesisBudgetState;private primary:R2StructuredRequest|undefined;private attemptBytes=0;private tail=Promise.resolve();private chain='';private journalBytes=0;private lastFinishMono=Number.NEGATIVE_INFINITY;private readonly mono=performance.now();private readonly actionUrls=new Set<string>();
 readonly record:GenesisRelease;readonly releasePin:ControlPin;readonly root:string;readonly phase:'preflight'|'data';private readonly journal:Awaited<ReturnType<typeof open>>;
 private constructor(record:GenesisRelease,releasePin:ControlPin,root:string,phase:'preflight'|'data',journal:Awaited<ReturnType<typeof open>>,startedAt:number){
  this.record=record;this.releasePin=releasePin;this.root=root;this.phase=phase;this.journal=journal;this.state=initialGenesisBudget(startedAt);
 }
 static async open(record:GenesisRelease,releasePin:ControlPin,phase:'preflight'|'data',prior?:GenesisBudgetState){
  if((phase==='data')!==Boolean(prior))throw Error('GENESIS data must inherit its reviewed preflight budget');
  if(prior)prior=BudgetSchema.parse(prior);
  if(prior&&(prior.active!==null||prior.stopped||prior.startedAt>Date.now()||prior.startedAt<Date.parse(record.issuedAt)||prior.lastFinishedAt<prior.startedAt||prior.lastFinishedAt>Date.now()))throw Error('GENESIS invalid preflight budget');
  const root=join(record.executionRoot,releasePin.sha256);await mkdir(root,{recursive:true,mode:0o700});if(await realpath(root)!==root)throw Error('GENESIS execution root aliases another path');
  const handle=await open(join(root,phase+'.started.json'),'wx',0o600);const startedAt=prior?.startedAt??Date.now();try{await handle.writeFile(JSON.stringify({releasePin,phase,startedAt:new Date(startedAt).toISOString(),inheritedBudget:prior??null,oneShot:true})+'\n');await handle.sync();}finally{await handle.close();}
  await syncGenesisDirectory(root);
  const journal=await open(join(root,phase+'.journal.jsonl'),'wx',0o600),custody=new GenesisWireCustody(record,releasePin,root,phase,journal,startedAt);
  try{await journal.sync();await syncGenesisDirectory(root);}catch(error){await journal.close();throw error;}
  if(prior)custody.state={...prior,active:null,actionAttempts:0,primaryAttempts:0};return custody;
 }
 async check(){
  validateGenesisRelease(this.record);await checkedPin(this.releasePin);
  if(this.state.stopped||performance.now()-this.mono>=GENESIS_CAPS.maxElapsedSeconds*1000)throw Error('GENESIS operation stopped or expired');
  try{await lstat(join(this.root,'STOP'));throw Error('GENESIS operator stop requested');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 private async append(event:Record<string,unknown>){
  const current=await lstat(join(this.root,this.phase+'.journal.jsonl')),held=await this.journal.stat();
  if(!current.isFile()||current.isSymbolicLink()||current.ino!==held.ino||current.dev!==held.dev||current.size!==this.journalBytes)throw Error('GENESIS journal identity/length changed');
  const payload={...event,previous:this.chain},sha256=semanticHash(payload),line=JSON.stringify({...payload,sha256})+'\n';await this.journal.writeFile(line);await this.journal.sync();this.chain=sha256;this.journalBytes+=Buffer.byteLength(line);
 }
 async begin(request:R2StructuredRequest){
  await this.check();if(this.primary||this.state.active)throw Error('GENESIS action concurrency');
  if(!genesisRequestPlan().requests.some(row=>canonicalJson(row)===canonicalJson(request))||(this.phase==='data')!==(request.phase==='genesis_data')||request.url.endsWith('/robots.txt')||request.url.endsWith('/.well-known/tdmrep.json'))throw Error('GENESIS action is outside the exact phase/request plan');
  this.primary=request;this.actionUrls.clear();this.state={...this.state,actionAttempts:0,primaryAttempts:0};await this.append({kind:'action',id:request.id,method:request.method,bodySha256:request.body?digest(request.body):null});
 }
 async finish(details:Record<string,unknown>){await this.check();if(this.state.active)throw Error('GENESIS unfinished wire attempt');await this.append({kind:'completed_action',id:this.primary!.id,...details});this.primary=undefined;}
 snapshot(){if(this.state.active||this.primary||this.state.stopped)throw Error('GENESIS cannot complete a stopped/unfinished phase');return {...this.state};}
 readonly wire:AcquisitionWireControl={minDelayMs:GENESIS_CAPS.minSpacingMs,beforeRequest:async(url,identity)=>{
  await this.check();if(!this.primary)throw Error('GENESIS request without selected action');assertGenesisWireIdentity(url,identity,this.primary);
  if(this.actionUrls.has(url))throw Error('GENESIS action cannot retry a primary or policy URL');this.actionUrls.add(url);
  const wait=Math.max(0,this.state.lastFinishedAt+GENESIS_CAPS.minSpacingMs-Date.now(),this.lastFinishMono+GENESIS_CAPS.minSpacingMs-performance.now());if(wait)await delay(wait);await this.check();
  const policies=genesisRequestPlan().requests.filter(row=>row.url.endsWith('/robots.txt')||row.url.endsWith('/.well-known/tdmrep.json')).map(row=>row.url);
  this.state=reserveGenesisAttempt(this.state,url,this.primary,policies,Date.now(),Date.parse(this.record.expiresAt));this.attemptBytes=0;
  await this.append({kind:'wire_started',url,method:identity.method,bodySha256:identity.body===null?null:digest(identity.body),publicOperation:identity.publicOperation,attempt:this.state.attempts,startedAt:new Date().toISOString()});
 },onResponseChunk:async(url,size)=>{
  const apply=async()=>{
   if(!Number.isSafeInteger(size)||size<0)throw Error('GENESIS invalid wire chunk size');
   const observedTotal=this.state.bytes+size,observedAttempt=this.attemptBytes+size;
   try{await this.check();const cap=genesisRequestPlan().requests.find(row=>row.url===url)?.maxBodyBytes;if(cap===undefined)throw Error('GENESIS unknown response URL');this.state=accountGenesisChunk(this.state,url,size,this.attemptBytes,cap,Date.now(),Date.parse(this.record.expiresAt));this.attemptBytes=observedAttempt;await this.append({kind:'wire_chunk',url,bytes:size,totalBytes:this.state.bytes});}
   catch(error){this.state={...this.state,bytes:observedTotal,stopped:true};this.attemptBytes=observedAttempt;await this.append({kind:'wire_chunk_refused',url,bytes:size,totalBytes:observedTotal});throw error;}
  };
  this.tail=this.tail.then(apply);await this.tail;
 },onWireAttemptResult:async(url,status,failure)=>{await this.tail;if(this.state.active!==url)throw Error('GENESIS wire settlement mismatch');this.lastFinishMono=performance.now();this.state={...this.state,active:null,lastFinishedAt:Date.now()};await this.append({kind:'wire_finished',url,status,failure,finishedAt:new Date().toISOString()});}};
 async stop(){this.state.stopped=true;await this.append({kind:'stopped',at:new Date().toISOString()});}
 async close(){await this.journal.close();}
}

/** An exclusive operation lock covers both phase commands. A stale lock is a
 * stop/review condition, never an automatic restart or allowance reset. */
export async function withGenesisOperation<T>(record:GenesisRelease,pin:ControlPin,work:()=>Promise<T>){
 const root=join(record.executionRoot,pin.sha256);await mkdir(root,{recursive:true,mode:0o700});if(await realpath(root)!==root)throw Error('GENESIS operation root is not canonical');
 await syncGenesisDirectory(dirname(root));await syncGenesisDirectory(dirname(record.executionRoot));
 const path=join(root,'operation.lock'),lock=await open(path,'wx',0o600),identity=await lock.stat();
 try{await lock.writeFile(JSON.stringify({pid:process.pid,release:pin.sha256})+'\n');await lock.sync();await syncGenesisDirectory(root);return await work();}
 finally{await lock.close();const current=await lstat(path);if(current.ino!==identity.ino||current.dev!==identity.dev||current.isSymbolicLink())throw Error('GENESIS operation lock changed');await unlink(path);await syncGenesisDirectory(root);}
}
