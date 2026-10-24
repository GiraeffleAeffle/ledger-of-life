import {mkdir,open,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {Pool} from 'pg';
import {z} from 'zod';
import {canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {DistrictCas} from './district-cas.ts';
import {DistrictJobStore,canonicalJobIdentity,runDistrictJobsCli} from './district-jobs.ts';
import type {DistrictJobSpec,JobHandler} from './district-jobs.ts';
import {guardDistrictPool,withDistrictDatabaseScope} from './district-database.ts';
import {readOperatorRegistryInputPin} from './district-registry-config.ts';
import {acquisitionHandler,readFetchedBytes,readHttpObservation,loadDescriptor} from './district-r1.ts';
import {persistOperatorRegistry} from './district-r1-state.ts';
import {PoliteFetcher} from './polite-fetch.ts';
import type {FetchedDocument} from './polite-fetch.ts';
import {createPolicyReceipt,PolicyReceiptSchema} from './district-policy-receipt.ts';
import {PUBLIC_SOURCE_POLICY_VALIDITY_MS} from './source-policy.ts';
import {authenticatedHttpBinding} from './district-http-observation.ts';
import {withParserSandbox} from './district-parser-isolation.ts';
import {StructuredWorkerRequestSchema} from './district-structured-parser-worker.ts';
import {CIVIC_ACQUISITION_DECISION_ID,initializeManagedAcquisitionLane,withManagedSourceWrite,withCivicPolicyShutdown} from './civic-opt-out.ts';
import {GENESIS_CAPS,GENESIS_PACKAGE_ROOT,GenesisWireCustody,checkedPin,committedPin,genesisDataSelectors,genesisRequestPlan,loadGenesisRelease,withGenesisOperation,checkGenesisMetadataReply,readGenesisDiscoveryReply,syncGenesisDirectory} from './r2-genesis-release.ts';
import type {ControlPin,GenesisRelease,GenesisBudgetState} from './r2-genesis-release.ts';

const casRoot=join(GENESIS_PACKAGE_ROOT,'cache/districts/cas');
async function newJson(path:string,value:unknown){const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}await syncGenesisDirectory(dirname(path));return {path,sha256:digest(await readFile(path))};}
export function genesisAcquisitionSpecs(record:GenesisRelease):DistrictJobSpec[]{return genesisDataSelectors().map(selector=>({step:'acquire_representation',lane:'acquisition',semanticContractSha256:record.runtime.contracts.acquisition,inputArtifactHashes:[],sourceScope:selector.scope,selector,policyProofSha256:null}));}
async function registry(record:GenesisRelease){const admitted=await readOperatorRegistryInputPin(record.registryDescriptor,record.runtime.policy);if(digest(admitted.bytes)!==record.runtime.registryConfigurationSha256)throw Error('GENESIS admitted registry bytes do not match issued configuration');return admitted;}
async function managedJson(root:string,binding:ReturnType<typeof authenticatedHttpBinding>,value:unknown,kind:string,record:GenesisRelease){
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),sha256=digest(bytes),part=kind+'/'+sha256+'.json',path=join(root,part);
 await withManagedSourceWrite(root,[{...binding,relativePath:part,contentSha256:sha256,independentAllowed:false}],async()=>{await mkdir(join(root,kind),{recursive:true,mode:0o700});await newJson(path,value);},record.runtime.policy);
 return {path,sha256:digest(await readFile(path))};
}
async function metadataReplies(record:GenesisRelease,root:string,response:FetchedDocument){
 const bytes=await readFetchedBytes(root,response.localPath,response.sha256,1024**2),http=await readHttpObservation(response,root,record.runtime.policy),binding=authenticatedHttpBinding(http,{url:response.url,sha256:response.sha256,mimeType:response.mimeType,retrievedAt:response.retrievedAt,fetchedAt:response.checkedAt});
 const replies=[];
 for(const selector of genesisDataSelectors()){
  const proof=await createPolicyReceipt({source:{url:response.url,sha256:response.sha256,mimeType:response.mimeType},sourcePolicy:response.policy,scope:selector.scope,permission:{kind:'facts_with_attribution'},checkedAt:response.checkedAt,expiresAt:new Date(Math.min(Date.parse(record.expiresAt),Date.parse(response.checkedAt)+PUBLIC_SOURCE_POLICY_VALIDITY_MS)).toISOString()},record.runtime.policy);
  const policyPin=await managedJson(root,binding,proof.receipt,'metadata-policy',record);
  const request=StructuredWorkerRequestSchema.parse({version:'district-structured-worker-v1',operation:'discover',adapter:'genesis',options:{},scope:selector.scope,cursor:null,snapshot:{sourceSha256:response.sha256,url:response.url,mimeType:response.mimeType,retrievedAt:response.retrievedAt,policyReceiptSha256:proof.receiptSha256,sourceVersion:null,request:{method:'POST',body:'name=31231-02-01&area=free&language=de',contentType:'application/x-www-form-urlencoded;charset=UTF-8'}},inputArtifactSha256:response.sha256,auxiliary:[]});
  const result=await withParserSandbox(bytes,sandbox=>sandbox.run('node',['--experimental-strip-types','/opt/stadtstack/src/district-structured-parser-worker.ts','/input/document',canonicalJson(request)]),{root,kind:'fetch',decisionId:CIVIC_ACQUISITION_DECISION_ID,bindings:[binding],purpose:'document',...record.runtime.policy});
  const resource=checkGenesisMetadataReply(request,result.stdout),outputPin=await managedJson(root,binding,JSON.parse(result.stdout),'metadata-discovery',record);
  replies.push({municipalityId:selector.scope.municipalityId,requestSha256:semanticHash(request),expectedDataRequestSha256:semanticHash(resource),policyPin,outputPin});
 }
 return {sourceSha256:response.sha256,httpObservationSha256:http.receiptSha256,replies};
}
async function wadlCapabilities(record:GenesisRelease,root:string,response:FetchedDocument){
 const bytes=await readFetchedBytes(root,response.localPath,response.sha256,1024**2),http=await readHttpObservation(response,root,record.runtime.policy),binding=authenticatedHttpBinding(http,{url:response.url,sha256:response.sha256,mimeType:response.mimeType,retrievedAt:response.retrievedAt,fetchedAt:response.checkedAt}),scope=genesisDataSelectors()[0].scope;
 const proof=await createPolicyReceipt({source:{url:response.url,sha256:response.sha256,mimeType:response.mimeType},sourcePolicy:response.policy,scope,permission:{kind:'facts_with_attribution'},checkedAt:response.checkedAt,expiresAt:new Date(Math.min(Date.parse(record.expiresAt),Date.parse(response.checkedAt)+PUBLIC_SOURCE_POLICY_VALIDITY_MS)).toISOString()},record.runtime.policy);
 const policyPin=await managedJson(root,binding,proof.receipt,'wadl-policy',record),pages=[];let cursor:string|null=null,found=false;
 for(let page=0;page<3;page++){
  const request=StructuredWorkerRequestSchema.parse({version:'district-structured-worker-v1',operation:'discover',adapter:'genesis',options:{},scope,cursor,snapshot:{sourceSha256:response.sha256,url:response.url,mimeType:response.mimeType,retrievedAt:response.retrievedAt,policyReceiptSha256:proof.receiptSha256,sourceVersion:null,request:{method:'GET',body:null,contentType:null}},inputArtifactSha256:response.sha256,auxiliary:[]});
  const output=await withParserSandbox(bytes,sandbox=>sandbox.run('node',['--experimental-strip-types','/opt/stadtstack/src/district-structured-parser-worker.ts','/input/document',canonicalJson(request)]),{root,kind:'fetch',decisionId:CIVIC_ACQUISITION_DECISION_ID,bindings:[binding],purpose:'document',...record.runtime.policy}),result=readGenesisDiscoveryReply(request,output.stdout);
  if(result.resources.length!==1)throw Error('GENESIS WADL capability page count changed');
  const resource=result.resources[0],expected=genesisRequestPlan().requests.find(row=>row.phase==='genesis_metadata')!;
  if(resource.url===expected.url&&resource.method==='POST'&&resource.body===expected.body&&resource.parentId===response.url)found=true;
  pages.push(await managedJson(root,binding,JSON.parse(output.stdout),'wadl-discovery',record));cursor=result.coverage.nextCursor;if(cursor===null)break;
 }
 if(!found||cursor!==null)throw Error('GENESIS WADL does not completely evidence the approved housing metadata operation');
 return {sourceSha256:response.sha256,policyPin,pages};
}
export async function genesisPreflight(pin:ControlPin,authorityRoot:string){
 const record=await loadGenesisRelease(pin,authorityRoot);await registry(record);
 return withCivicPolicyShutdown(()=>withGenesisOperation(record,pin,async()=>{
  const custody=await GenesisWireCustody.open(record,pin,'preflight'),root=join(custody.root,'fetch');
  try{
   await initializeManagedAcquisitionLane(root,{...record.runtime.policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'fetch'});
   const fetcher=new PoliteFetcher({cacheDir:root,maxBytes:2*1024**2,maxRedirects:0,timeoutMs:25000,ownerPolicyLane:{...record.runtime.policy,decisionId:CIVIC_ACQUISITION_DECISION_ID},minDelayMs:GENESIS_CAPS.minSpacingMs,beforeRequest:custody.wire.beforeRequest,onResponseChunk:custody.wire.onResponseChunk,onWireAttemptResult:custody.wire.onWireAttemptResult});
   const actions=genesisRequestPlan().requests.filter(row=>row.phase==='genesis_metadata'||row.phase==='preflight'&&!row.url.endsWith('/robots.txt')&&!row.url.endsWith('/.well-known/tdmrep.json')),fetched=[];let metadata:Awaited<ReturnType<typeof metadataReplies>>|undefined,wadl:Awaited<ReturnType<typeof wadlCapabilities>>|undefined;
   for(const action of actions){
    await custody.begin(action);
    const response=await fetcher.fetch(action.url,{method:action.method,body:action.body??undefined});
    if(response.url!==action.url||response.status!==200)throw Error('GENESIS preflight unexpected redirect/status');
    const observation=await readHttpObservation(response,root,record.runtime.policy);
    if(action.url.endsWith('/application.wadl'))wadl=await wadlCapabilities(record,root,response);
    if(action.phase==='genesis_metadata')metadata=await metadataReplies(record,root,response);
    await custody.finish({sourceSha256:response.sha256,httpObservationSha256:observation.receiptSha256});
    fetched.push({id:action.id,url:response.url,sourceSha256:response.sha256,httpObservationSha256:observation.receiptSha256,checkedAt:response.checkedAt});
   }
   if(!metadata||!wadl)throw Error('GENESIS preflight metadata/WADL missing');
   await custody.check();return await newJson(join(custody.root,'preflight.completed.json'),{schemaVersion:'r2-genesis-preflight-result-v1',releaseSha256:pin.sha256,planSha256:record.planSha256,fetched,wadl,metadata,budget:custody.snapshot(),finishedAt:new Date().toISOString(),requiresMainMetadataReview:true});
  }catch(error){await custody.stop();throw error;}finally{await custody.close();}
 }));
}
const MetadataReview=z.object({schemaVersion:z.literal('r2-genesis-metadata-review-v1'),status:z.literal('ISSUED'),approvedBy:z.literal('Main'),issuedAt:z.iso.datetime(),releaseSha256:z.string().regex(/^[a-f0-9]{64}$/u),preflightResult:z.object({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict(),table:z.literal('31231-02-01'),regionalVariable:z.literal('GEMEIN'),year:z.literal('2024'),yearAvailabilityEvidence:z.object({sourceSha256:z.string().regex(/^[a-f0-9]{64}$/u),locator:z.string().min(1).max(500)}).strict(),approvedDataRequestHashes:z.array(z.string().regex(/^[a-f0-9]{64}$/u)).length(9),licenceAndTermsReviewed:z.literal(true),wadlReviewed:z.literal(true),metadataReviewed:z.literal(true),notes:z.string().min(1)}).strict();
async function metadataReview(record:GenesisRelease,pin:ControlPin,reviewPin:ControlPin,authorityRoot:string){
 const review=MetadataReview.parse(await committedPin(reviewPin,authorityRoot));
 if(review.releaseSha256!==pin.sha256||Date.parse(review.issuedAt)>Date.now()||Date.parse(review.issuedAt)<Date.parse(record.issuedAt)||review.preflightResult.path!==join(record.executionRoot,pin.sha256,'preflight.completed.json'))throw Error('GENESIS metadata review is not for this issued execution');
 const result=JSON.parse((await checkedPin(review.preflightResult)).toString('utf8')) as {releaseSha256:string;planSha256:string;finishedAt:string;metadata:{sourceSha256:string;replies:{expectedDataRequestSha256:string}[]};budget:GenesisBudgetState};
 if(result.releaseSha256!==pin.sha256||result.planSha256!==record.planSha256||Date.parse(review.issuedAt)<Date.parse(z.iso.datetime().parse(result.finishedAt))||review.yearAvailabilityEvidence.sourceSha256!==result.metadata.sourceSha256||canonicalJson([...review.approvedDataRequestHashes].sort())!==canonicalJson(result.metadata.replies.map(row=>row.expectedDataRequestSha256).sort()))throw Error('GENESIS metadata review differs from actual completed preflight');
 return result;
}
/** Materializes only observed preflight pins, never an approval or source proof. */
export async function genesisMetadataReviewDraft(pin:ControlPin,authorityRoot:string){
 const record=await loadGenesisRelease(pin,authorityRoot),path=join(record.executionRoot,pin.sha256,'preflight.completed.json'),bytes=await readFile(path),preflightResult={path,sha256:digest(bytes)};
 const result=JSON.parse((await checkedPin(preflightResult)).toString('utf8')) as {releaseSha256:string;planSha256:string;metadata:{replies:{expectedDataRequestSha256:string}[]}};
 if(result.releaseSha256!==pin.sha256||result.planSha256!==record.planSha256||result.metadata.replies.length!==9)throw Error('GENESIS completed preflight binding/count mismatch');
 return {schemaVersion:'r2-genesis-metadata-review-v1',status:'DRAFT',approvedBy:null,issuedAt:'',releaseSha256:pin.sha256,preflightResult,table:'31231-02-01',regionalVariable:'GEMEIN',year:'2024',yearAvailabilityEvidence:null,approvedDataRequestHashes:result.metadata.replies.map(row=>row.expectedDataRequestSha256),licenceAndTermsReviewed:false,wadlReviewed:false,metadataReviewed:false,notes:'Unissued: Main must review actual licence/terms, complete sandbox WADL/metadata outputs and a genuine metadata locator confirming 2024 availability. A generated 2024 request is not evidence of available data.'};
}
export async function genesisEnqueue(pin:ControlPin,authorityRoot:string,reviewPin:ControlPin){
 const record=await loadGenesisRelease(pin,authorityRoot);await metadataReview(record,pin,reviewPin,authorityRoot);const admitted=await registry(record);
 return withDistrictDatabaseScope(()=>withCivicPolicyShutdown(()=>withGenesisOperation(record,pin,async()=>{
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required for native GENESIS queue');
  const pool=guardDistrictPool(new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:5000,statement_timeout:10000}));
  try{const store=new DistrictJobStore(pool);await persistOperatorRegistry(store,new DistrictCas(casRoot),admitted);const jobs=[];for(const spec of genesisAcquisitionSpecs(record))jobs.push(await store.enqueue(spec));return {jobKeys:jobs,authorization:{approvalSha256:pin.sha256,approvedBy:'Main',expiresAt:record.expiresAt,jobKeys:jobs,ags:Object.values(genesisRequestPlan().municipalities),maxJobs:9,maxElapsedMs:7200000,category:'production',mode:'attended'}};}
  finally{await pool.end();}
 })));
}
export async function genesisAcquire(pin:ControlPin,authorityRoot:string,reviewPin:ControlPin,authorizationId:string){
 const record=await loadGenesisRelease(pin,authorityRoot),review=await metadataReview(record,pin,reviewPin,authorityRoot),admitted=await registry(record);z.uuid().parse(authorizationId);
 if(!process.stdin.isTTY)throw Error('GENESIS acquisition requires Main attended in a TTY');
 return withDistrictDatabaseScope(database=>withCivicPolicyShutdown(()=>withGenesisOperation(record,pin,async()=>{
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required for native GENESIS execution');
  const pool=guardDistrictPool(new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:5000,statement_timeout:10000}));let custody:GenesisWireCustody|undefined;
  try{
   const store=new DistrictJobStore(pool),specs=genesisAcquisitionSpecs(record),keys=specs.map(spec=>canonicalJobIdentity(spec).jobKey);
   const authorization=await pool.query<{approval_sha256:string;approved_by:string;allowed_job_keys:string[];allowed_ags:string[];max_jobs:number;max_elapsed_ms:number;jobs_started:number;category:string;execution_mode:string;state:string;expires_at:Date}>('SELECT * FROM district_pipeline.preauthorizations WHERE id=$1',[authorizationId]),auth=authorization.rows[0];
   if(!auth||auth.approval_sha256!==pin.sha256||auth.approved_by!=='Main'||canonicalJson([...auth.allowed_job_keys].sort())!==canonicalJson([...keys].sort())||canonicalJson([...auth.allowed_ags].sort())!==canonicalJson(Object.values(genesisRequestPlan().municipalities).sort())||auth.max_jobs!==9||auth.jobs_started!==0||auth.max_elapsed_ms>7200000||auth.category!=='production'||auth.execution_mode!=='attended'||auth.state!=='approved'||auth.expires_at.getTime()>Date.parse(record.expiresAt))throw Error('GENESIS native preauthorization does not match exact nine first attempts');
   const jobs=await pool.query<{job_key:string;state:string;attempt:number;spec:DistrictJobSpec}>('SELECT job_key,state,attempt,spec FROM district_pipeline.jobs WHERE job_key=ANY($1::text[])',[keys]);
   if(jobs.rows.length!==9||jobs.rows.some(row=>row.state!=='queued'||row.attempt!==0||!specs.some(spec=>canonicalJson(canonicalJobIdentity(spec).spec)===canonicalJson(row.spec))))throw Error('GENESIS queue is missing/changed/already attempted');
   custody=await GenesisWireCustody.open(record,pin,'data',review.budget);const control=custody,underlying=acquisitionHandler(store,admitted.registry,undefined,digest(admitted.bytes),control.wire),cas=new DistrictCas(casRoot);let count=0,descriptorCandidate:string|undefined;
   const handler:JobHandler=async context=>{
    const request=genesisRequestPlan().requests.find(row=>row.phase==='genesis_data'&&row.municipalityId===context.job.spec.sourceScope.municipalityId);
    if(!request||!keys.includes(context.job.jobKey)||context.job.attempt!==1)throw Error('GENESIS unexpected native job/attempt');
    await control.begin(request);const result=await underlying(context);if(result.outcome!=='succeeded')return result;
    const descriptors=result.outputs?.filter(output=>output.kind==='derived');if(descriptors?.length!==1)throw Error('GENESIS native descriptor output is not unique');descriptorCandidate=descriptors[0].sha256;
    await control.finish({jobKey:context.job.jobKey,runId:context.job.runId,outputHashes:result.outputs?.map(item=>item.sha256)});count++;return result;
   };
   const runs=[],structuredParseManifest:{jobs:{representationSha256:string;adapter:'genesis';operation:'parse';options:Record<string,unknown>;cursor:null;auxiliary:[]}[]}={jobs:[]},policyCurrency=[];
   for(let index=0;index<9;index++){
    await control.check();descriptorCandidate=undefined;const before=count,seconds=Math.max(1,Math.floor(Math.min(900,(Date.parse(record.expiresAt)-Date.now())/1000))),result=await runDistrictJobsCli({acquire_representation:handler},['run','--authorization-id',authorizationId,'--max-jobs','1','--max-seconds',String(seconds),'--mode','attended','--owner-present','--cas-root',casRoot]);
    if(result?.state!=='completed'||count!==before+1)throw Error('GENESIS native run failed/held/drained before its one job committed');runs.push(result);
    if(!descriptorCandidate)throw Error('GENESIS committed acquisition lacks its native descriptor');
    const descriptor=await loadDescriptor(store,cas,descriptorCandidate,record.runtime.policy),proof=PolicyReceiptSchema.parse(JSON.parse((await cas.read(descriptor.receiptSha256)).toString('utf8')));
    structuredParseManifest.jobs.push({representationSha256:descriptorCandidate,adapter:'genesis',operation:'parse',options:{},cursor:null,auxiliary:[]});
    policyCurrency.push({municipalityId:descriptor.scope.municipalityId,policyReceiptSha256:descriptor.receiptSha256,checkedAt:proof.checkedAt,expiresAt:proof.expiresAt});
   }
   return await newJson(join(control.root,'data.completed.json'),{schemaVersion:'r2-genesis-acquisition-result-v1',releaseSha256:pin.sha256,metadataReview:reviewPin,jobKeys:keys,acquisitionRuns:runs,structuredParseManifest,policyCurrency,budget:control.snapshot(),finishedAt:new Date().toISOString(),notStructuredRuns:true});
  }catch(error){await custody?.stop();throw error;}finally{await custody?.close();await pool.end();}
 }),database.signal));
}
