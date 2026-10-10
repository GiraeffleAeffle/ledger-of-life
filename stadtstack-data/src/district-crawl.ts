import {mkdir,writeFile,rename,open,unlink,realpath} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {PoliteFetcher,PoliteFetchError} from './polite-fetch.ts';
import {crawlHtmlSource,crawlOparlSource,crawlParticipationApi,crawlMvPlanningApi} from './district-source-adapters.ts';
import type {RegistryMunicipality,CrawlDocument,AdapterOptions,AdapterResult,CrawlCoverage,FrontierFailure} from './district-source-adapters.ts';
import {loadDistrictRegistry} from './district-registry.ts';

export interface CrawlCheck {
 municipalityId:string;sourceId:string;checkState:'checked'|'not_found'|'not_checked';checkedAt:string|null;
 httpStatus?:number;reason?:string;documentCount:number;outcome?:'documents_collected'|'no_documents'|'partial'|'blocked'|'failed'|'not_checked'|'registry_not_found';requests?:number;rounds?:number;coverage?:CrawlCoverage;blocked?:FrontierFailure[];
}
export interface DistrictCrawlIndex {schemaVersion:'stadtstack-crawl-index-v1';generatedAt:string;documents:CrawlDocument[];checks:CrawlCheck[]}
export interface CrawlRegistry {schemaVersion:'stadtstack-source-registry-v1';municipalities:RegistryMunicipality[]}
export async function crawlDistrictRegistry(registry:CrawlRegistry,fetcher:PoliteFetcher,options:AdapterOptions&{municipality?:string;maxRounds?:number;onSource?:(index:DistrictCrawlIndex)=>Promise<void>}):Promise<DistrictCrawlIndex>{
 if(options.municipality&&!registry.municipalities.some(city=>city.id===options.municipality))throw Error('Requested municipality is not in the registry');
 const index:DistrictCrawlIndex={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:new Date().toISOString(),documents:[],checks:[]};
 const work:Array<{city:RegistryMunicipality;source:RegistryMunicipality['sources'][number];checkIndex:number;totalRequests:number;done:boolean}>=[];
 for(const city of registry.municipalities){
  for(const source of city.sources){
   const base={municipalityId:city.id,sourceId:source.id,documentCount:0};
   if(options.municipality&&city.id!==options.municipality){index.checks.push({...base,checkState:'not_checked',checkedAt:null,outcome:'not_checked',reason:'Outside requested municipality slice'});continue;}
   const seeds=city.seedDocuments?.filter(seed=>seed.sourceId===source.id)??[];
   if(!source.url&&!source.api&&!seeds.length){index.checks.push({...base,checkState:source.checkState==='not_found'?'not_found':'not_checked',checkedAt:source.checkedAt,outcome:source.checkState==='not_found'?'registry_not_found':'not_checked',reason:source.reason??'No confirmed public endpoint in source registry'});continue;}
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
      result=source.vendor==='oparl'?await crawlOparlSource(fetcher,city,source,options):source.api?.format==='mv-bauleitplan'?await crawlMvPlanningApi(fetcher,city,source,options):source.api?await crawlParticipationApi(fetcher,city,source,options):await crawlHtmlSource(fetcher,city,source,options);
     }catch(error){
      const consumed=fetcher.requestCount-startedRequests,remaining=options.maxRequests-consumed;
      if(!source.api||!seeds.length||remaining<1)throw error;
      result=await crawlHtmlSource(fetcher,city,{...source,url:null},{...options,maxRequests:remaining},seeds);result.requests+=consumed;
      const failure:FrontierFailure={url:source.api.url,failure:error instanceof PoliteFetchError?error.failure:'api_error',reason:error instanceof Error?error.message:'API unavailable',checkedAt,...(error instanceof PoliteFetchError&&error.policy?{policy:error.policy}:{}),action:'ask_municipality'};
      (result.blocked??=[]).push(failure);
      if(result.coverage){result.coverage.blockedCount++;result.coverage.action='ask_municipality';if(result.coverage.state==='complete')result.coverage.state='blocked';}
      result.notes.unshift(`Observed API unavailable (${failure.failure}: ${failure.reason}); confirmed official-document fallback used without bypassing restrictions; ask municipality`);
     }
     item.totalRequests+=result.requests;
     index.documents=index.documents.filter(document=>document.municipalityId!==city.id||document.sourceId!==source.id);index.documents.push(...result.documents);
     const outcome=result.coverage?.state==='partial'?'partial':result.coverage?.state==='blocked'?'blocked':result.documents.length?'documents_collected':'no_documents';
     index.checks[checkIndex]={...base,checkState:'checked',checkedAt:result.checkedAt??null,documentCount:result.documents.length,requests:item.totalRequests,rounds:round,outcome,coverage:result.coverage,blocked:result.blocked,reason:[!source.api&&source.vendor!=='oparl'?'Official HTML/document fallback: no observed public API configured; API availability is not inferred':null,...result.notes].filter(Boolean).join('; ')};
     index.generatedAt=new Date().toISOString();await options.onSource?.(index);
     // Continue budgets automatically; zero work means retries are deferred or a prerequisite is inaccessible.
     if(result.coverage?.state!=='partial'||result.requests===0||result.coverage.runnableCount===0)item.done=true;
    }catch(error){
     const reason=error instanceof PoliteFetchError?`${error.failure}: ${error.message}; ask municipality`:(error instanceof Error?error.message:'Source adapter failed');
     index.checks[checkIndex]={...base,checkState:'checked',checkedAt,rounds:round,outcome:'blocked',reason,coverage:{state:'blocked',pendingCount:0,runnableCount:0,blockedCount:1,scope:'Configured source endpoint',action:'ask_municipality'},...(error instanceof PoliteFetchError&&error.status?{httpStatus:error.status}:{})};
     index.generatedAt=new Date().toISOString();await options.onSource?.(index);item.done=true;
    }
  }
  if(work.every(item=>item.done))break;
 }
 index.generatedAt=new Date().toISOString();return index;
}
async function main(){
 const {values}=parseArgs({options:{registry:{type:'string',default:'sources/district-registry.json'},out:{type:'string',default:'cache/districts/index.json'},cache:{type:'string',default:'cache/districts/raw'},municipality:{type:'string'},'max-documents':{type:'string',default:'8'},'max-pages':{type:'string',default:'3'},'max-requests':{type:'string',default:'24'},'max-rounds':{type:'string',default:'1000'},'revalidate-after-hours':{type:'string',default:'24'}}});
 const options:AdapterOptions={maxDocuments:Number(values['max-documents']),maxPages:Number(values['max-pages']),maxRequests:Number(values['max-requests'])};
 for(const [key,value] of Object.entries(options))if(!Number.isInteger(value)||value<1||value>200)throw Error(`${key} must be an integer from 1 to 200`);
 const maxRounds=Number(values['max-rounds']);if(!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>10000)throw Error('max-rounds must be an integer from 1 to 10000; a stopped frontier remains explicitly partial');
 const revalidateAfterMs=Number(values['revalidate-after-hours'])*60*60_000;
 if(!Number.isFinite(revalidateAfterMs)||revalidateAfterMs<=0||revalidateAfterMs>30*24*60*60_000)throw Error('revalidate-after-hours must be greater than zero and at most 720');
 const project=await realpath(fileURLToPath(new URL('../',import.meta.url))),cacheRoot=join(project,'cache'),cache=resolve(values.cache!),out=resolve(values.out!);
 const inside=(path:string)=>{const part=relative(cacheRoot,path);return part!==''&&!part.startsWith('..')&&!isAbsolute(part);};
 if(!inside(cache)||!inside(out))throw Error('Crawler raw bytes and index must remain beneath ignored stadtstack-data/cache/');
 await mkdir(cache,{recursive:true});await mkdir(dirname(out),{recursive:true});
 if(!inside(await realpath(cache))||!inside(await realpath(dirname(out))))throw Error('Cache symlinks may not escape ignored cache directory');
 const registry=await loadDistrictRegistry(resolve(values.registry!));
 // One crawler process owns the project's hosts. An interrupted run leaves an explicit operator-visible lock.
 const lock=join(cacheRoot,'district-crawl.lock');const handle=await open(lock,'wx').catch(()=>{throw Error('District crawler lock already exists; coordinate the active run or remove a confirmed abandoned cache/district-crawl.lock');});
 try{
  await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n');await handle.close();
  const persist=async(index:DistrictCrawlIndex)=>{await writeFile(out+'.tmp',JSON.stringify(index,null,2)+'\n');await rename(out+'.tmp',out);};
  const index=await crawlDistrictRegistry(registry,new PoliteFetcher({cacheDir:cache,policyTtlMs:Math.min(revalidateAfterMs,60*60_000)}),{...options,revalidateAfterMs,maxRounds,municipality:values.municipality,onSource:persist});
  await persist(index);
  console.log(JSON.stringify({index:out,documents:index.documents.length,municipalitiesWithDocuments:new Set(index.documents.map(document=>document.municipalityId)).size,checks:index.checks.map(check=>({municipalityId:check.municipalityId,sourceId:check.sourceId,outcome:check.outcome,coverage:check.coverage,documentCount:check.documentCount}))}));
 }finally{await handle.close().catch(()=>{});await unlink(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error instanceof Error?error.message:'District crawl failed');process.exitCode=1;});
