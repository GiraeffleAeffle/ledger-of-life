import {open,unlink,realpath,readFile,lstat} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {PoliteFetcher,PoliteFetchError,type SourceContentBinding} from './polite-fetch.ts';
import type {PoliteFetcherOptions} from './polite-fetch.ts';
import {crawlHtmlSource,crawlOparlSource,crawlParticipationApi,crawlMvPlanningApi,sourceDocument,registeredSourceTargets,MunicipalIdentityBindingError} from './district-source-adapters.ts';
import type {RegistryMunicipality,CrawlDocument,CrawlExcludedDocument,AdapterOptions,AdapterResult,CrawlCoverage,FrontierFailure} from './district-source-adapters.ts';
import {operatorRegistryConfigImportSchema,importOperatorRegistryConfig,readOperatorRegistryConfigSourcePin} from './district-registry-config.ts';
import {readPinnedJson,writeManagedSourceJson,sourceArtifactUrls,type SourceArtifactBinding} from './district-private-io.ts';
import {isCouncilPermissionFailure} from './council-cache.ts';
import {APPROVED_OWNER_ROBOTS_OVERRIDE,documentOriginExcludes} from './source-policy.ts';
import {CIVIC_POLICY_AUTHORITY,assertCivicPolicyAuthority,initializeManagedAcquisitionLane,assertManagedObservationReadable} from './civic-opt-out.ts';
import {ContentFreeSourcePolicySchema,sha256} from './district-schema.ts';
import {SourceObservationSchema,sourceObservationMatches} from './source-observation.ts';
import {HostGroupsSchema} from './district-r1.ts';

/** The shared strict config fixes the floor; exact-host serialization remains in PoliteFetcher. */
export async function createDistrictCrawlFetcher(options:Omit<PoliteFetcherOptions,'minDelayMs'>,hostGroupsPath:string|URL=new URL('../sources/district-host-groups.json',import.meta.url)):Promise<PoliteFetcher>{
 const group=HostGroupsSchema.parse(JSON.parse(await readFile(hostGroupsPath,'utf8'))).serviceGroups[0];
 return new PoliteFetcher({...options,minDelayMs:group.minStartIntervalMs});
}

export interface CrawlCheck {
 municipalityId:string;sourceId:string;checkState:'checked'|'not_found'|'not_checked';checkedAt:string|null;
 httpStatus?:number;reason?:string;retryAfter?:string;documentCount:number;outcome?:'documents_collected'|'no_documents'|'partial'|'blocked'|'failed'|'not_checked'|'registry_not_found';requests?:number;rounds?:number;coverage?:CrawlCoverage;blocked?:FrontierFailure[];
}
export interface DistrictCrawlIndex {schemaVersion:'stadtstack-crawl-index-v1';generatedAt:string;documents:CrawlDocument[];excludedDocuments?:CrawlExcludedDocument[];checks:CrawlCheck[]}
export interface CrawlRegistry {schemaVersion:'stadtstack-source-registry-v1';municipalities:RegistryMunicipality[]}
export interface DistrictCrawlSelection {municipality?:string;sourceId?:string;pageRoots?:string[];seedDocumentUrls?:string[]}
export function validateDistrictCrawlSelection(registry:CrawlRegistry,selection:DistrictCrawlSelection):void {
 const cities=selection.municipality===undefined?[]:registry.municipalities.filter(city=>city.id===selection.municipality);
 if(selection.municipality!==undefined&&cities.length!==1)throw Error('Requested municipality is not uniquely registered');
 let source:RegistryMunicipality['sources'][number]|undefined;
 if(selection.sourceId!==undefined){
  if(cities.length!==1)throw Error('Source selection requires an explicit registered municipality');
  const sources=cities[0].sources.filter(source=>source.id===selection.sourceId);
  if(sources.length!==1)throw Error('Requested source is unknown or does not uniquely belong to the selected municipality');
  source=sources[0];
 }
 if(selection.pageRoots!==undefined||selection.seedDocumentUrls!==undefined){
  if(!source)throw Error('Exact target selection requires an explicit registered source');
  registeredSourceTargets(cities[0],source,selection);
 }
}
/** Configured primary dispatch only; fallbacks and document adapter labels are separate evidence. */
export function districtSourceAdapterKind(source:RegistryMunicipality['sources'][number]):'oparl'|'mv-bauleitplan'|'participation-api'|'html'{
 return source.vendor==='oparl'?'oparl':source.api?.format==='mv-bauleitplan'?'mv-bauleitplan':source.api?'participation-api':'html';
}
export async function crawlDistrictRegistry(registry:CrawlRegistry,fetcher:PoliteFetcher,options:AdapterOptions&DistrictCrawlSelection&{maxRounds?:number;onSource?:(index:DistrictCrawlIndex,bindings:SourceContentBinding[])=>Promise<void>}):Promise<DistrictCrawlIndex>{
 validateDistrictCrawlSelection(registry,options);
 await fetcher.initialize();
 const index:DistrictCrawlIndex={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:new Date().toISOString(),documents:[],excludedDocuments:[],checks:[]};
 const sourceBindings=new Map<string,SourceContentBinding[]>();
 const work:Array<{city:RegistryMunicipality;source:RegistryMunicipality['sources'][number];checkIndex:number;totalRequests:number;done:boolean}>=[];
 for(const city of registry.municipalities){
  for(const source of city.sources){
   const base={municipalityId:city.id,sourceId:source.id,documentCount:0};
   if(options.municipality!==undefined&&city.id!==options.municipality){index.checks.push({...base,checkState:'not_checked',checkedAt:null,outcome:'not_checked',reason:'Outside requested municipality slice'});continue;}
   if(options.sourceId!==undefined&&source.id!==options.sourceId){index.checks.push({...base,checkState:'not_checked',checkedAt:null,outcome:'not_checked',reason:'Outside requested registered source slice'});continue;}
   const seeds=city.seedDocuments?.filter(seed=>seed.sourceId===source.id)??[];
   if(!source.url&&!source.api&&!seeds.length&&!options.pageRoots?.length){index.checks.push({...base,checkState:source.checkState==='not_found'?'not_found':'not_checked',checkedAt:source.checkedAt,outcome:source.checkState==='not_found'?'registry_not_found':'not_checked',reason:source.reason??'No confirmed public endpoint in source registry'});continue;}
   const checkIndex=index.checks.length;index.checks.push({...base,checkState:'not_checked',checkedAt:null,outcome:'not_checked',reason:'Source traversal pending'});
   work.push({city,source,checkIndex,totalRequests:0,done:false});
  }
 }
 // Give every municipality one bounded turn before deep archives take another.
 for(let round=1;round<=(options.maxRounds??1000);round++){
  for(const item of work){
   if(item.done)continue;
   const {city,source,checkIndex}=item,base={municipalityId:city.id,sourceId:source.id,documentCount:0};
   const seeds=city.seedDocuments?.filter(seed=>seed.sourceId===source.id)??[];
   const checkedAt=new Date().toISOString();
    try{
     const startedRequests=fetcher.requestCount;let result:AdapterResult;
     try{
      const adapter=districtSourceAdapterKind(source);
      result=options.pageRoots!==undefined||options.seedDocumentUrls!==undefined?await crawlHtmlSource(fetcher,city,source,options):adapter==='oparl'?await crawlOparlSource(fetcher,city,source,options):adapter==='mv-bauleitplan'?await crawlMvPlanningApi(fetcher,city,source,options):adapter==='participation-api'?await crawlParticipationApi(fetcher,city,source,options):await crawlHtmlSource(fetcher,city,source,options);
     }catch(error){
      if(options.pageRoots!==undefined||options.seedDocumentUrls!==undefined)throw error;
      if(isCouncilPermissionFailure(error)||error instanceof PoliteFetchError&&(error.status===429||error.failure.startsWith('host_')))throw error;
      const consumed=fetcher.requestCount-startedRequests,remaining=options.maxRequests-consumed;
      if(source.api?.format==='bobsh-list'||!source.api||!seeds.length||remaining<1)throw error;
      result=await crawlHtmlSource(fetcher,city,{...source,registeredSourceUrl:source.registeredSourceUrl??source.url??source.api.url,url:null},{...options,maxRequests:remaining},seeds);result.requests+=consumed;
      const failure:FrontierFailure={url:source.api.url,failure:error instanceof PoliteFetchError?error.failure:'api_error',reason:error instanceof PoliteFetchError?error.failure:'api_error',checkedAt,...(error instanceof PoliteFetchError&&error.policy?{policy:error.policy}:{}),action:'ask_municipality'};
      (result.blocked??=[]).push(failure);
      if(result.coverage){result.coverage.blockedCount++;result.coverage.action='ask_municipality';if(result.coverage.state==='complete')result.coverage.state='blocked';}
      result.notes.unshift(`Observed API unavailable (${failure.failure}: ${failure.reason}); confirmed official-document fallback used without bypassing restrictions; ask municipality`);
     }
     item.totalRequests+=result.requests;
     sourceBindings.set(city.id+'\n'+source.id,result.sourceBindings??[]);
     index.documents=index.documents.filter(document=>document.municipalityId!==city.id||document.sourceId!==source.id);index.documents.push(...result.documents);
     index.excludedDocuments=index.excludedDocuments!.filter(document=>document.municipalityId!==city.id||document.sourceId!==source.id);index.excludedDocuments.push(...result.excludedDocuments??[]);
     const outcome=result.coverage?.state==='partial'?'partial':result.coverage?.state==='blocked'?'blocked':result.documents.length?'documents_collected':'no_documents';
     index.checks[checkIndex]={...base,checkState:'checked',checkedAt:result.checkedAt??null,documentCount:result.documents.length,requests:item.totalRequests,rounds:round,outcome,coverage:result.coverage,blocked:result.blocked,reason:[options.pageRoots!==undefined||options.seedDocumentUrls!==undefined?'Explicit registered targets only; configured API discovery and link traversal were not run':!source.api&&source.vendor!=='oparl'?'Official HTML/document fallback: no observed public API configured; API availability is not inferred':null,...result.notes].filter(Boolean).join('; ')};
     index.generatedAt=new Date().toISOString();
     // Continue budgets automatically; zero work means retries are deferred or a prerequisite is inaccessible.
     if(result.coverage?.state!=='partial'||result.requests===0||result.coverage.runnableCount===0)item.done=true;
    }catch(error){
     if(isCouncilPermissionFailure(error)||error instanceof MunicipalIdentityBindingError){index.documents=index.documents.filter(document=>document.municipalityId!==city.id||document.sourceId!==source.id);sourceBindings.delete(city.id+'\n'+source.id);}
     if(error instanceof PoliteFetchError&&error.excludedDocument){
      index.excludedDocuments!.push(sourceDocument(error.excludedDocument,city,source,districtSourceAdapterKind(source)));
      index.documents=index.documents.filter(document=>document.municipalityId!==city.id||document.sourceId!==source.id||document.url!==error.excludedDocument!.url);
     }
     const reason=error instanceof PoliteFetchError?`${error.failure}; ask municipality`:error instanceof MunicipalIdentityBindingError?error.message:isCouncilPermissionFailure(error)?'Source permission state unavailable; ask municipality':'Source adapter failed; ask municipality';
     const targets=registeredSourceTargets(city,source,options);
     const coverage:CrawlCoverage={state:targets?'partial':'blocked',pendingCount:0,runnableCount:0,blockedCount:1,scope:targets?'Selected registered targets blocked; source-wide traversal not assessed':'Configured source endpoint',action:'ask_municipality',...(targets?{sourceCoverage:'not_assessed' as const,targetScope:{kind:targets.kind==='pages'?'page_roots' as const:'seed_documents' as const,urls:targets.urls,state:'blocked' as const,pendingCount:0,runnableCount:0,blockedCount:1}}:{})};
     const failure=error instanceof PoliteFetchError?error.failure:error instanceof MunicipalIdentityBindingError?error.code:isCouncilPermissionFailure(error)?'source_permission_unavailable':'source_adapter_failed',failedUrl=error instanceof PoliteFetchError&&error.excludedDocument?error.excludedDocument.url:targets?.urls[0]??source.api?.url??source.url??seeds[0]?.url;
     const blocked:FrontierFailure[]|undefined=failedUrl?[{url:failedUrl,failure,reason:failure,checkedAt,action:'ask_municipality',...(error instanceof PoliteFetchError&&error.policy?{policy:error.policy}:{}),...(error instanceof PoliteFetchError&&error.status?{status:error.status}:{})}]:undefined;
     index.checks[checkIndex]={...base,checkState:'checked',checkedAt,rounds:round,outcome:'blocked',reason,coverage,blocked,...(error instanceof PoliteFetchError&&error.status?{httpStatus:error.status}:{}),...(error instanceof PoliteFetchError&&error.retryAfter?{retryAfter:error.retryAfter}:{})};
     index.generatedAt=new Date().toISOString();item.done=true;
    }
    await options.onSource?.(index,[...sourceBindings.values()].flat());
  }
  if(work.every(item=>item.done))break;
 }
 index.generatedAt=new Date().toISOString();return index;
}
/** No-body failures cannot borrow a fetched body's digest or invent target-host provenance. */
export function projectCrawlIndexDenials(index:DistrictCrawlIndex,registry:CrawlRegistry,boundHosts:ReadonlySet<string>):DistrictCrawlIndex{
 return {...index,checks:index.checks.map(check=>({...check,blocked:check.blocked?.map(failure=>{
  const urlBound=boundHosts.has(new URL(failure.url).hostname),policyBound=!failure.policy||sourceArtifactUrls(failure.policy).every(url=>boundHosts.has(new URL(url).hostname));
  if(urlBound&&policyBound)return failure;
  const city=registry.municipalities.find(city=>city.id===check.municipalityId),source=city?.sources.find(source=>source.id===check.sourceId),contextUrl=source?.api?.url??source?.url??city?.seedDocuments?.find(seed=>seed.sourceId===check.sourceId)?.url;
  if(!contextUrl||!boundHosts.has(new URL(contextUrl).hostname))throw Error('Denial audit has no authenticated registered source context');
  const {policy,...audit}=failure;
  return {...audit,...(!urlBound?{url:contextUrl,urlRole:'registered_source_context' as const,targetUrlSha256:sha256(failure.url)}:{}),...(policy?{policyAudit:{policySha256:sha256(JSON.stringify(policy)),sourceHostSha256:sha256(new URL(policy.robots.url).hostname),robotsState:policy.robots.state,robotsStatus:policy.robots.state==='blocked'?'disallowed' as const:policy.robots.state,override:policy.override??null,tdmState:policy.tdm.state,tdmReferenceStatus:policy.tdm.referenceStatus??null,tdmDeclarationStatus:policy.tdm.declarationStatus??null,access:policy.access}}:{})};
 })}))};
}
async function main(){
 const {values}=parseArgs({options:{'registry-config-import':{type:'string'},'registry-config-import-sha256':{type:'string'},'output-root':{type:'string'},out:{type:'string'},cache:{type:'string',default:'cache/districts/owner-policy-2026-10-11/raw'},municipality:{type:'string'},source:{type:'string'},'page-root':{type:'string',multiple:true},'seed-document':{type:'string',multiple:true},'policy-authority-sha256':{type:'string'},'max-documents':{type:'string',default:'8'},'max-pages':{type:'string',default:'3'},'max-requests':{type:'string',default:'24'},'max-rounds':{type:'string',default:'1000'},'revalidate-after-hours':{type:'string',default:'24'}}});
 if(!values['registry-config-import']||!values['registry-config-import-sha256']||!values['output-root'])throw Error('An authenticated registry-config import pin and explicit output-root are required');
 const options:AdapterOptions={maxDocuments:Number(values['max-documents']),maxPages:Number(values['max-pages']),maxRequests:Number(values['max-requests'])};
 for(const [key,value] of Object.entries(options))if(!Number.isInteger(value)||value<1||value>200)throw Error(`${key} must be an integer from 1 to 200`);
 const maxRounds=Number(values['max-rounds']);if(!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>10000)throw Error('max-rounds must be an integer from 1 to 10000; a stopped frontier remains explicitly partial');
 const revalidateAfterMs=Number(values['revalidate-after-hours'])*60*60_000;
 if(!Number.isFinite(revalidateAfterMs)||revalidateAfterMs<=0||revalidateAfterMs>30*24*60*60_000)throw Error('revalidate-after-hours must be greater than zero and at most 720');
 const project=await realpath(fileURLToPath(new URL('../',import.meta.url))),cacheRoot=join(project,'cache'),cache=resolve(values.cache!),outputRoot=resolve(values['output-root']),out=values.out?resolve(values.out):join(outputRoot,'index.json');
 const contains=(root:string,path:string)=>{const part=relative(root,path);return part!==''&&!part.startsWith('..')&&!isAbsolute(part);},inside=(path:string)=>contains(cacheRoot,path);
 if(!inside(cache)||!inside(outputRoot)||!contains(outputRoot,out)||cache===outputRoot||contains(cache,outputRoot)||contains(outputRoot,cache))throw Error('Separate crawler raw/artifact roots must remain beneath ignored cache; output must be inside its explicit artifact root');
 const importDescriptor=operatorRegistryConfigImportSchema.parse(await readPinnedJson(resolve(values['registry-config-import']),values['registry-config-import-sha256']));
 if(!inside(resolve(importDescriptor.managedRoot))||resolve(importDescriptor.managedRoot)===cache||contains(cache,resolve(importDescriptor.managedRoot))||contains(resolve(importDescriptor.managedRoot),cache))throw Error('Registry control import requires a separate ignored artifacts root');
 const requestedPolicy={...CIVIC_POLICY_AUTHORITY,...(values['policy-authority-sha256']!==undefined?{authoritySha256:values['policy-authority-sha256']}:{})},authority=await assertCivicPolicyAuthority(requestedPolicy);
 const policy={...requestedPolicy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},lane={decisionId:APPROVED_OWNER_ROBOTS_OVERRIDE.id,...policy};
 const fetcher=await createDistrictCrawlFetcher({cacheDir:cache,ownerPolicyLane:lane,policyTtlMs:Math.min(revalidateAfterMs,60*60_000)});
 const control=await importOperatorRegistryConfig(importDescriptor,policy),{registry}=await readOperatorRegistryConfigSourcePin(control,policy),selection:DistrictCrawlSelection={municipality:values.municipality,sourceId:values.source,pageRoots:values['page-root'],seedDocumentUrls:values['seed-document']};
 validateDistrictCrawlSelection(registry,selection);
 await fetcher.initialize();await initializeManagedAcquisitionLane(outputRoot,{...lane,kind:'artifacts'});
 if(!inside(await realpath(cache))||!inside(await realpath(outputRoot))||!inside(await realpath(importDescriptor.managedRoot)))throw Error('Cache symlinks may not escape ignored cache directory');
 // One crawler process owns the project's hosts. An interrupted run leaves an explicit operator-visible lock.
 const lock=join(cacheRoot,'district-crawl.lock'),handle=await open(lock,'wx',0o600).catch(()=>{throw Error('District crawler lock already exists; coordinate the active run or remove a confirmed abandoned lock');});
 try{
  await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n');await handle.close();
  let latestBindings:SourceContentBinding[]=[];
  const persist=async(index:DistrictCrawlIndex,bindings:SourceContentBinding[]=latestBindings)=>{
   latestBindings=bindings;await readOperatorRegistryConfigSourcePin(control,policy);
   const proofs=bindings.length?await fetcher.sourceBindingsForArtifact(bindings):[],audits:SourceArtifactBinding[]=[];
   for(const document of index.documents)if(!bindings.some(binding=>binding.url===document.url&&binding.sha256===document.sha256&&binding.observationPath===document.observationPath))throw Error('Crawl document is missing its actual source observation dependency');
   for(const document of index.excludedDocuments??[]){
    await fetcher.assertHostAllowed(document.url);
    const name=basename(document.observationPath),observationPath=join(cache,'observations',name);
    if(resolve(document.observationPath)!==observationPath||name.length>160||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name))throw Error('Excluded observation is outside the managed raw root');
    const metadata=await lstat(observationPath);
    if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>16*1024*1024||await realpath(observationPath)!==observationPath)throw Error('Excluded observation path/type/size rejected');
    await assertManagedObservationReadable(observationPath,policy);
    const bytes=await readFile(observationPath),observation=SourceObservationSchema.parse(JSON.parse(bytes.toString('utf8'))),observedPolicy=ContentFreeSourcePolicySchema.parse(observation.policy);
    await assertManagedObservationReadable(observationPath,policy);
    if(!sourceObservationMatches(observation,{...document,bodyState:'excluded'})||JSON.stringify(observation.exclusion)!==JSON.stringify(document.exclusion)||JSON.stringify(observedPolicy)!==JSON.stringify(ContentFreeSourcePolicySchema.parse(document.policy))||!observedPolicy.documentOrigin||observedPolicy.documentOrigin.classification==='official_work'||!documentOriginExcludes(observedPolicy,document))throw Error('Excluded metadata lacks an actual restricted non-official representation');
    audits.push({kind:'http_observation',url:document.url,sourceSha256:document.sha256,observationId:name,receiptSha256:sha256(bytes),independentAllowed:false});
   }
   const dependencies=[...control.bindings,...proofs,...audits],boundHosts=new Set(dependencies.map(binding=>new URL(binding.url).hostname));
   await writeManagedSourceJson(outputRoot,out,projectCrawlIndexDenials(index,registry,boundHosts),dependencies,{...lane,kind:'artifacts'});
   await readOperatorRegistryConfigSourcePin(control,policy);
  };
  const index=await crawlDistrictRegistry(registry,fetcher,{...options,...selection,revalidateAfterMs,maxRounds,onSource:persist});
  await persist(index);
  console.log(JSON.stringify({index:out,documents:index.documents.length,excludedDocuments:index.excludedDocuments?.length??0,municipalitiesWithDocuments:new Set(index.documents.map(document=>document.municipalityId)).size,checks:index.checks.map(check=>({municipalityId:check.municipalityId,sourceId:check.sourceId,outcome:check.outcome,coverage:check.coverage,documentCount:check.documentCount}))}));
 }finally{await handle.close().catch(()=>{});await unlink(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('District crawl failed; authority, input integrity, managed provenance or source policy rejected the operation.');process.exitCode=1;});
