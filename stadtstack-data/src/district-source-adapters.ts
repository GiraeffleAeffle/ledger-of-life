import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {load} from 'cheerio';
import {hash} from './common.ts';
import {parseOparlList,selectCouncilBody,councilEventDate} from './council-oparl.ts';
import type {OparlBody,CouncilCheckpoint} from './council-oparl.ts';
import {traverseCouncilList} from './council-cache.ts';
import type {CouncilStorage,CouncilSegment,CouncilLoader} from './council-cache.ts';
import type {City} from './cities.ts';
import {publicUrl,PoliteFetcher,PoliteFetchError} from './polite-fetch.ts';
import type {FetchedDocument} from './polite-fetch.ts';
import type {SourceAccessPolicy} from './source-policy.ts';
import {PDF_TDM_POLICY_VERSION} from './pdf-tdm-policy.ts';

export interface RegistrySource {
 id:string;kind:'council'|'participation'|'gazette'|'website';url:string|null;vendor:string;
 checkState:'checked'|'not_found'|'not_checked';checkedAt:string|null;reason?:string;evidence:{url:string;locator:string}[];
 api?:{url:string;method?:'GET'|'POST';form?:Record<string,string>;format:'diplan-list'|'bobsh-list'|'mv-bauleitplan'};
 councilBodyId?:string;councilBodyAliases?:string[];
 crawlScope?:{pageRoots:string[];followLinkedDocuments:boolean};
 knownMachinePolicyUrls?:string[];
 legalBasis?:{classification:'section_5_official_act_candidate'|'section_44b_tdm_candidate'|'unassessed';reason?:string};
}
export interface SourceSeed {url:string;title?:string;documentDate?:string|null;sourceId:string;adapter?:string;metadata?:CrawlDocument['metadata']}
export interface RegistryMunicipality {id:string;name:string;ags:string;districtId:string;sources:RegistrySource[];seedDocuments?:SourceSeed[]}
export interface CrawlDocument extends FetchedDocument {
 id:string;municipalityId:string;ags:string;districtId:string;sourceId:string;documentDate:string|null;adapter:string;
 metadata:{title?:string;caseKey?:string;caseKeyType?:string;stage?:string;stageDate?:string;sourceType?:string;discoveredFrom?:string;oparlRecordId?:string;sourceVersion?:string;legalBasis?:string};
}
export interface CrawlCoverage {state:'complete'|'partial'|'blocked';pendingCount:number;runnableCount:number;blockedCount:number;frontierPath?:string;scope:string;action?:'ask_municipality'}
export interface AdapterResult {documents:CrawlDocument[];notes:string[];requests:number;checkedAt?:string|null;coverage?:CrawlCoverage;blocked?:FrontierFailure[]}
export const DEFAULT_SOURCE_REVALIDATE_MS=24*60*60_000;
export interface AdapterOptions {maxDocuments:number;maxPages:number;maxRequests:number;activeOparlRecordIds?:Set<string>;revalidateAfterMs?:number}
export interface DiscoveredLink {url:string;title:string;pdf:boolean;structured:boolean}
interface FrontierEntry extends SourceSeed {from:string;depth:number;revalidate?:boolean;previous?:CrawlDocument}
export interface FrontierFailure {url:string;failure:string;reason:string;checkedAt:string;status?:number;policy?:SourceAccessPolicy;retryAfter?:string;action:'ask_municipality'}
interface SourceFrontier {schemaVersion:1;municipalityId:string;sourceId:string;queue:FrontierEntry[];visited:string[];documents:CrawlDocument[];failures:FrontierFailure[];roots:string[];checkedUrls?:Record<string,{checkedAt:string;documentId:string}>;lastCheckedAt?:string|null}
export function discoverDocumentLinks(html:string,base:string):DiscoveredLink[]{
 const $=load(html),links=new Map<string,DiscoveredLink>();
 $('a[href],link[rel=alternate][href],iframe[src],object[data]').each((_,element)=>{
  const anchor=$(element),href=anchor.attr('href')??anchor.attr('src')??anchor.attr('data');if(!href)return;
  let url:URL;try{url=publicUrl(new URL(href,base).href);}catch{return;}
  const title=anchor.text().replace(/\s+/g,' ').trim().slice(0,500),mime=anchor.attr('type')??'';
  let decoded=url.href;try{decoded=decodeURIComponent(decoded);}catch{/* Match the literal URL when percent escapes are malformed. */}
  const pdf=/\.pdf(?:$|[?&#])/i.test(decoded)||/application\/pdf/i.test(mime)||/[?&](?:ext|type)=pdf(?:&|$)/i.test(decoded);
  const structured=/\.(?:gml|xml|zip)(?:$|[?&#])/i.test(decoded)||/application\/(?:gml\+xml|xml|zip)/i.test(mime)||/\bxplanung\b/i.test(title+' '+decoded);
  const download=pdf||structured||/\/(?:loadDocument|download)\.(?:php|phtml)(?:\?|$)/i.test(decoded);
  if(/abmelden|logout|login|registrier|warenkorb|mailto:/i.test(url.href))return;
  const relevant=download||/bekanntmach|amtsblatt|bebauungsplan|flächennutzungsplan|beteiligung|bauleitplan|\/verfahren\/|\/procedure\/|planunterlag|beschluss|niederschrift|download|dokument/i.test(url.href+' '+title);
  if(!relevant)return;
  // Do not expand site-wide navigation. Actual linked files remain in scope even on a public document host.
  const participationPortal=/(?:^|\.)beteiligung\.diplanung\.de$|(?:^|\.)bob-sh\.de$/i.test(url.hostname);
  if(!download&&(anchor.closest('nav,header,footer').length||url.origin!==new URL(base).origin&&!participationPortal))return;
  if(!links.has(url.href))links.set(url.href,{url:url.href,title,pdf,structured});
 });
 return [...links.values()].sort((a,b)=>(b.structured?2:b.pdf?1:0)-(a.structured?2:a.pdf?1:0));
}
export function sourceDocument(response:FetchedDocument,municipality:RegistryMunicipality,source:RegistrySource,adapter:string,metadata:CrawlDocument['metadata']={},documentDate:string|null=null):CrawlDocument {
 return {...response,id:'document-'+hash(municipality.id+'\n'+source.id+'\n'+response.url).slice(0,24),municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,sourceId:source.id,documentDate,adapter,metadata:{sourceType:source.kind,...metadata}};
}
export async function crawlHtmlSource(fetcher:PoliteFetcher,municipality:RegistryMunicipality,source:RegistrySource,options:AdapterOptions,seeds:SourceSeed[]=municipality.seedDocuments?.filter(seed=>seed.sourceId===source.id)??[]):Promise<AdapterResult>{
 const folder=join(fetcher.cacheDir,'frontiers');await mkdir(folder,{recursive:true});
 const frontierPath=join(folder,hash(municipality.id+'\n'+source.id)+'.json'),ttl=options.revalidateAfterMs??DEFAULT_SOURCE_REVALIDATE_MS;
 if(!Number.isFinite(ttl)||ttl<=0)throw Error('Source revalidation TTL must be positive');
 let frontier:SourceFrontier;
 try{frontier=JSON.parse(await readFile(frontierPath,'utf8')) as SourceFrontier;if(frontier.schemaVersion!==1||frontier.municipalityId!==municipality.id||frontier.sourceId!==source.id)throw Error('Frontier identity mismatch');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;frontier={schemaVersion:1,municipalityId:municipality.id,sourceId:source.id,queue:[],visited:[],documents:[],failures:[],roots:[]};}
 frontier.checkedUrls??={};
 for(const document of frontier.documents)frontier.checkedUrls[document.url]??={checkedAt:document.checkedAt,documentId:document.id};
 frontier.lastCheckedAt??=[...frontier.documents.map(document=>document.checkedAt),...frontier.failures.map(failure=>failure.checkedAt)].filter(value=>Number.isFinite(Date.parse(value))).sort().at(-1)??null;
 if(options.activeOparlRecordIds){
  frontier.documents=frontier.documents.filter(document=>!document.metadata.oparlRecordId||options.activeOparlRecordIds!.has(document.metadata.oparlRecordId));
  frontier.queue=frontier.queue.filter(item=>!item.metadata?.oparlRecordId||options.activeOparlRecordIds!.has(item.metadata.oparlRecordId));
 }
 const recordVersions=new Map(seeds.filter(seed=>seed.metadata?.oparlRecordId).map(seed=>[seed.metadata!.oparlRecordId!,seed.metadata!.sourceVersion]));
 const changedRecords=new Set(frontier.documents.filter(document=>document.metadata.oparlRecordId&&recordVersions.has(document.metadata.oparlRecordId)&&recordVersions.get(document.metadata.oparlRecordId)!==document.metadata.sourceVersion).map(document=>document.metadata.oparlRecordId!));
 if(changedRecords.size){
  const changedUrls=new Set(seeds.filter(seed=>seed.metadata?.oparlRecordId&&changedRecords.has(seed.metadata.oparlRecordId)).map(seed=>seed.url));
  frontier.documents=frontier.documents.filter(document=>!document.metadata.oparlRecordId||!changedRecords.has(document.metadata.oparlRecordId));
  frontier.visited=frontier.visited.filter(url=>!changedUrls.has(url));
 }
 const queued=new Set(frontier.queue.map(item=>item.url)),visited=new Set(frontier.visited),failed=new Set(frontier.failures.map(item=>item.url)),now=Date.now();
 const roots=[...new Set([...frontier.roots,...source.crawlScope?.pageRoots??[],...(source.url?[source.url]:[])].map(value=>publicUrl(value).href))];frontier.roots=roots;
 const rootSet=new Set(roots),documentsById=new Map(frontier.documents.map(document=>[document.id,document]));
 const scheduledDocumentIds=new Set<string>();
 for(const root of roots)if(visited.has(root)&&!frontier.checkedUrls[root])visited.delete(root);
 const expiredIds=new Set<string>(),refreshRoots:FrontierEntry[]=[],refreshDocuments:FrontierEntry[]=[];
 // Refresh roots first, but append other expired documents behind the existing unfinished frontier.
 // Old policy is withheld from the returned index until a real conditional request succeeds.
 for(const [url,observation] of Object.entries(frontier.checkedUrls).sort(([a],[b])=>Number(rootSet.has(b))-Number(rootSet.has(a)))){
  if(!rootSet.has(url)&&documentsById.get(observation.documentId)?.url!==url)continue;
  const previous=documentsById.get(observation.documentId);
  const obsoletePdfPolicy=previous?.mimeType==='application/pdf'&&!previous.policy?.tdm.evidence.some(evidence=>evidence.url===previous.url&&evidence.sha256===previous.sha256&&evidence.locator.startsWith('PDF.js ')&&evidence.locator.endsWith(` XMP metadata (${PDF_TDM_POLICY_VERSION})`)&&['0','no_tdm_reservation_field'].includes(evidence.value)&&!!evidence.checkedAt&&Number.isFinite(Date.parse(evidence.checkedAt)));
  const due=obsoletePdfPolicy||!Number.isFinite(Date.parse(observation.checkedAt))||now-Date.parse(observation.checkedAt)>=ttl;
  if(!due)continue;
  if(previous)expiredIds.add(previous.id);
  visited.delete(url);if(previous)visited.delete(previous.url);
  if(queued.has(url)||failed.has(url)||previous&&scheduledDocumentIds.has(previous.id))continue;
  const entry:FrontierEntry={url,sourceId:source.id,from:previous?.metadata.discoveredFrom??url,depth:0,revalidate:true,previous,adapter:previous?.adapter,metadata:previous?.metadata};
  (rootSet.has(url)?refreshRoots:refreshDocuments).push(entry);queued.add(url);
  if(previous)scheduledDocumentIds.add(previous.id);
 }
 frontier.documents=frontier.documents.filter(document=>!expiredIds.has(document.id));
 frontier.queue.unshift(...refreshRoots);frontier.queue.push(...refreshDocuments);
 for(const root of roots){
  if(!visited.has(root)&&!queued.has(root)&&!failed.has(root)){frontier.queue.push({url:root,sourceId:source.id,depth:0,from:root});queued.add(root);}
 }
 const seedEntries:FrontierEntry[]=[];
 for(const seed of seeds){const url=publicUrl(seed.url).href;if(!visited.has(url)&&!queued.has(url)&&!failed.has(url)){seedEntries.push({...seed,url,depth:0,from:source.url??url});queued.add(url);}}
 frontier.queue.unshift(...seedEntries);
 // Failed checks are retried only after their explicit backoff/TTL, never by bypassing their restriction.
 const deferred=frontier.failures.filter(item=>item.retryAfter?Date.parse(item.retryAfter)<=now:now-Date.parse(item.checkedAt)>=ttl);
 for(const item of deferred){
  if(!queued.has(item.url)){frontier.queue.push({url:item.url,sourceId:source.id,depth:0,from:item.url,revalidate:true});queued.add(item.url);}
  failed.delete(item.url);visited.delete(item.url);
 }
 frontier.failures=frontier.failures.filter(item=>!deferred.includes(item));
 const persist=async()=>{frontier.visited=[...visited];await writeFile(frontierPath+'.tmp',JSON.stringify(frontier));await rename(frontierPath+'.tmp',frontierPath);};
 await persist();
 let requests=0,processedDocuments=0,htmlPages=0;const notes:string[]=[];
 const discoveryOnly=source.crawlScope?.pageRoots.length===0&&source.crawlScope.followLinkedDocuments===false;
 if(discoveryOnly)notes.push('Endpoint discovery only: municipal procedure binding is not established; no statewide link expansion');
 while(frontier.queue.length&&requests<options.maxRequests&&processedDocuments<options.maxDocuments&&htmlPages<options.maxPages){
  const item=frontier.queue[0];if(visited.has(item.url)&&!item.revalidate){frontier.queue.shift();await persist();continue;}requests++;
  try{
   const response=await fetcher.fetch(item.url,{machinePolicyUrls:source.knownMachinePolicyUrls}),isHtml=/^(?:text\/html|application\/xhtml\+xml)$/.test(response.mimeType),isPdf=response.mimeType==='application/pdf';
   const isStructured=/xml|gml|zip/.test(response.mimeType)||/\.(?:xml|gml|zip)(?:$|[?])/i.test(response.url);
   if(!isHtml&&!isPdf&&!isStructured&&!response.mimeType.startsWith('text/')&&!response.mimeType.includes('json'))throw Error(`Unsupported representation ${response.mimeType}`);
   const html=isHtml?await readFile(response.localPath,'utf8'):null,sameBytes=item.previous?.sha256===response.sha256;
   const title=(item.revalidate?undefined:item.title)||(html?load(html)('h1').first().text().replace(/\s+/g,' ').trim().slice(0,500):sameBytes?item.previous?.metadata.title:undefined);
   const document=sourceDocument(response,municipality,source,item.adapter??(isStructured?'xplanung-document':isPdf?'official-pdf':'official-html'),{...(sameBytes?item.previous?.metadata:item.metadata),...(title?{title}:{}),discoveredFrom:item.from,legalBasis:source.legalBasis?.classification??'unassessed'},sameBytes?item.previous!.documentDate:item.documentDate??null);
   if(item.previous&&item.previous.id!==document.id)frontier.documents=frontier.documents.filter(previous=>previous.id!==item.previous!.id);
   const previousIndex=frontier.documents.findIndex(previous=>previous.id===document.id);
   if(previousIndex<0)frontier.documents.push(document);else frontier.documents[previousIndex]=document;
   processedDocuments++;frontier.lastCheckedAt=response.checkedAt;
   frontier.checkedUrls[item.url]={checkedAt:response.checkedAt,documentId:document.id};frontier.checkedUrls[response.url]={checkedAt:response.checkedAt,documentId:document.id};
   visited.add(item.url);visited.add(response.url);frontier.queue.shift();
   if(html&&!discoveryOnly){
    htmlPages++;
    for(const link of discoverDocumentLinks(html,response.url)){
     if(source.crawlScope?.followLinkedDocuments===false&&(link.pdf||link.structured))continue;
     if(visited.has(link.url)||queued.has(link.url)||failed.has(link.url))continue;
     frontier.queue.push({url:link.url,title:link.title,sourceId:source.id,depth:item.depth+1,from:response.url});queued.add(link.url);
    }
   }
  }catch(error){
   const failure=error instanceof PoliteFetchError?error.failure:'representation_error',status=error instanceof PoliteFetchError?error.status:undefined,checkedAt=new Date().toISOString();
   const transient=['timeout','network_error','dns_error','robots_unavailable','tdm_unavailable'].includes(failure)||status===429||status!==undefined&&status>=500;
   frontier.failures.push({url:item.url,failure,reason:error instanceof Error?error.message:'Source request failed',checkedAt,...(status?{status}:{}),...(error instanceof PoliteFetchError&&error.policy?{policy:error.policy}:{}),...(transient?{retryAfter:new Date(Date.now()+15*60_000).toISOString()}:{}),action:'ask_municipality'});
   if(item.previous)frontier.documents=frontier.documents.filter(document=>document.id!==item.previous!.id);
   frontier.lastCheckedAt=checkedAt;failed.add(item.url);frontier.queue.shift();
  }
  await persist();
 }
 const pendingCount=frontier.queue.length+frontier.failures.filter(item=>item.retryAfter).length,blockedCount=frontier.failures.filter(item=>!item.retryAfter).length;
 const state=pendingCount?'partial':blockedCount?'blocked':'complete';
 notes.push(`Scoped frontier ${state}: ${frontier.documents.length} documents, ${frontier.queue.length} queued links, ${frontier.failures.length} inaccessible links. Completion refers only to discovered scoped links, never all municipal documents.`);
 notes.push(`Conditional rediscovery and policy revalidation TTL ${ttl}ms; expired documents are withheld until checked; cached source checkedAt is not advanced without a request.`);
 if(frontier.failures.length)notes.push('Inaccessible/reserved resources: ask municipality; no contact was sent and no access restriction bypassed.');
 return {documents:frontier.documents,notes,requests,checkedAt:frontier.lastCheckedAt??null,coverage:{state,pendingCount,runnableCount:frontier.queue.length,blockedCount,frontierPath,scope:'Observed roots, relevant same-origin planning/archive pages and all their linked public document files',...(frontier.failures.length?{action:'ask_municipality' as const}:{})},blocked:frontier.failures};
}
const apiResponses=new WeakMap<PoliteFetcher,Map<string,{requestedAt:number;response:Promise<FetchedDocument>}>>();
async function observedApiResponse(fetcher:PoliteFetcher,source:RegistrySource,ttl:number):Promise<FetchedDocument>{
 if(!source.api)throw Error('No observed API descriptor');
 let responses=apiResponses.get(fetcher);if(!responses){responses=new Map();apiResponses.set(fetcher,responses);}
 const body=source.api.method==='POST'?new URLSearchParams(source.api.form??{}).toString():undefined,key=JSON.stringify([source.api.url,source.api.method??'GET',body]);
 let entry=responses.get(key);
 if(!entry||Date.now()-entry.requestedAt>=ttl){entry={requestedAt:Date.now(),response:fetcher.fetch(source.api.url,{method:source.api.method??'GET',body,machinePolicyUrls:source.knownMachinePolicyUrls})};responses.set(key,entry);}
 return entry.response;
}
/** API URLs/form fields must be observed in registry, never inferred from vendor names. */
export async function crawlParticipationApi(fetcher:PoliteFetcher,municipality:RegistryMunicipality,source:RegistrySource,options:AdapterOptions):Promise<AdapterResult>{
 if(!source.api)throw Error('No observed public API configured');
 const before=fetcher.requestCount,response=await observedApiResponse(fetcher,source,options.revalidateAfterMs??DEFAULT_SOURCE_REVALIDATE_MS),apiRequests=fetcher.requestCount-before;
 const data=JSON.parse(await readFile(response.localPath,'utf8')) as {success?:boolean;mapVars?:{procedureId:string;procedureUrl:string;externalName:string;publicParticipationStartDate?:string}[];responseHtml?:string;procedureCount?:number};
 if(data.success!==true||!Array.isArray(data.mapVars)||typeof data.responseHtml!=='string'||data.mapVars.length!==data.procedureCount)throw Error('Unexpected public participation list envelope; no empty-coverage inference');
 const $=load(data.responseHtml),names=new Map<string,string>();
 $('.c-procedurelist__item[data-procedure-id]').each((_,element)=>{const row=$(element);names.set(row.attr('data-procedure-id')!,row.text().replace(/\s+/g,' '));});
 const normalizedName=municipality.name.toLocaleLowerCase('de'),seeds:SourceSeed[]=[];
 for(const procedure of data.mapVars){
  const card=names.get(procedure.procedureId);if(!card||typeof procedure.externalName!=='string'||typeof procedure.procedureUrl!=='string')continue;
  // This is source discovery, not an identity gate: extraction must still bind exact municipal evidence.
  if(!(card+' '+procedure.externalName).toLocaleLowerCase('de').includes(normalizedName))continue;
  // A consultation start is not the document's publication or decision date.
  seeds.push({url:new URL(procedure.procedureUrl,response.url).href,title:procedure.externalName,sourceId:source.id,documentDate:null});
 }
 const result=await crawlHtmlSource(fetcher,municipality,source,{...options,maxRequests:Math.max(0,options.maxRequests-apiRequests)},[...seeds,...municipality.seedDocuments?.filter(seed=>seed.sourceId===source.id)??[]]);
 for(const document of result.documents){document.adapter=source.api.format;const seed=seeds.find(item=>item.url===document.url||item.url===document.metadata.discoveredFrom);const procedure=data.mapVars.find(item=>new URL(item.procedureUrl,response.url).href===seed?.url);if(procedure){document.metadata.caseKey=procedure.procedureId;document.metadata.caseKeyType=source.api.format==='diplan-list'?'diplan':'bobsh';}}
 result.requests+=apiRequests;result.checkedAt=[result.checkedAt,response.checkedAt].filter((value):value is string=>!!value).sort().at(-1)??null;result.notes.unshift(`Observed ${source.api.format} public list ${response.url}; sha256 ${response.sha256}; all ${data.procedureCount} listed procedures considered for municipal discovery`);return result;
}
/** MV Bauportal's documented geoportalsearch interface, scoped by exact official AGS. */
export async function crawlMvPlanningApi(fetcher:PoliteFetcher,municipality:RegistryMunicipality,source:RegistrySource,options:AdapterOptions):Promise<AdapterResult>{
 if(!source.api||source.api.format!=='mv-bauleitplan')throw Error('No observed MV Bauportal API configured');
 const folder=join(fetcher.cacheDir,'api-frontiers');await mkdir(folder,{recursive:true});const statePath=join(folder,hash(municipality.id+'\n'+source.id)+'-mv.json');
 interface ApiState {url:string;offset:number;total:number|null;complete:boolean;seeds:SourceSeed[];metadata:Record<string,{title:string;caseKey:string}>;evidence:{url:string;sha256:string;checkedAt:string}[]}
 let state:ApiState;
 try{state=JSON.parse(await readFile(statePath,'utf8')) as ApiState;if(state.url!==source.api.url)throw Error('MV API frontier binding changed');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;state={url:source.api.url,offset:0,total:null,complete:false,seeds:[],metadata:{},evidence:[]};}
 const priorApiCheck=state.evidence.at(-1)?.checkedAt;
 if(state.complete&&(!priorApiCheck||!Number.isFinite(Date.parse(priorApiCheck))||Date.now()-Date.parse(priorApiCheck)>=(options.revalidateAfterMs??DEFAULT_SOURCE_REVALIDATE_MS))){state.offset=0;state.total=null;state.complete=false;}
 const notes:string[]=[];let requests=0;
 for(let page=0;!state.complete&&page<options.maxPages&&requests<options.maxRequests;page++){
  const url=new URL(source.api.url);url.searchParams.set('offset',String(state.offset));url.searchParams.set('n','100');
  const response=await fetcher.fetch(url.href,{machinePolicyUrls:source.knownMachinePolicyUrls});requests++;
  const data=JSON.parse(await readFile(response.localPath,'utf8')) as {success?:boolean;total?:number;hits?:number;results?:unknown[][]};
  if(data.success!==true||!Number.isInteger(data.total)||!Array.isArray(data.results)||data.results.some(group=>!Array.isArray(group)))throw Error('Unexpected MV Bauportal response; no empty-coverage inference');
  const records=data.results.flat() as {title?:string;_resourceLinkId?:string;x_GKZ?:string[];x_dokumentURL?:string[]}[];state.total=data.total!;
  state.evidence.push({url:response.url,sha256:response.sha256,checkedAt:response.checkedAt});
  for(const record of records){
   if(!Array.isArray(record.x_GKZ)||!record.x_GKZ.includes(municipality.ags)||typeof record.title!=='string'||typeof record._resourceLinkId!=='string'||!Array.isArray(record.x_dokumentURL))continue;
   for(const link of record.x_dokumentURL){
    if(typeof link!=='string')continue;const documentUrl=publicUrl(link).href;if(state.metadata[documentUrl])continue;
    state.metadata[documentUrl]={title:record.title,caseKey:record._resourceLinkId};state.seeds.push({url:documentUrl,title:record.title,sourceId:source.id,documentDate:null});
   }
  }
  if(!records.length&&state.offset<state.total)throw Error('MV API returned an incomplete empty page; cursor retained');
  state.offset+=records.length;state.complete=state.offset>=state.total;
  await writeFile(statePath+'.tmp',JSON.stringify(state));await rename(statePath+'.tmp',statePath);
 }
 notes.push(`MV Bauportal durable API frontier: ${state.offset}/${state.total??'unknown'} records; ${state.complete?'complete':'partial'}; evidence ${state.evidence.map(item=>item.sha256).join(',')}`);
 const result=await crawlHtmlSource(fetcher,municipality,source,{...options,maxRequests:Math.max(0,options.maxRequests-requests)},[...state.seeds,...municipality.seedDocuments?.filter(seed=>seed.sourceId===source.id)??[]]);
 for(const document of result.documents){const item=state.metadata[document.url];if(item){document.adapter='mv-bauleitplan';document.metadata.caseKey=item.caseKey;document.metadata.caseKeyType='source_document';}}
 if(!state.complete&&result.coverage){result.coverage.state='partial';result.coverage.runnableCount=(result.coverage.runnableCount??0)+1;result.coverage.pendingCount+=Math.max(1,(state.total??state.offset+1)-state.offset);notes.push('API cursor remains resumable; no completeness assertion');}
 result.requests+=requests;result.checkedAt=[result.checkedAt,state.evidence.at(-1)?.checkedAt].filter((value):value is string=>!!value).sort().at(-1)??null;result.notes.unshift(...notes);return result;
}
/** Shared Phase A loader: no stale fallback, fresh 304 validation, and an optional evidence lifecycle callback. */
export function createPoliteCouncilLoader(fetcher:PoliteFetcher,options:{maxRequests:number;onDocument?:(document:FetchedDocument)=>void|Promise<void>}):CouncilLoader {
 const startedRequests=fetcher.requestCount;
 return async url=>{
  if(fetcher.requestCount-startedRequests>=options.maxRequests)throw Error('OParl request budget exhausted');
  const response=await fetcher.fetch(url),data:unknown=JSON.parse(await readFile(response.localPath,'utf8'));
  await options.onDocument?.(response);
  return {url:response.url,sha256:response.sha256,retrievedAt:response.retrievedAt,checkedAt:response.checkedAt,data};
 };
}
export async function crawlOparlSource(fetcher:PoliteFetcher,municipality:RegistryMunicipality,source:RegistrySource,options:AdapterOptions):Promise<AdapterResult>{
 if(!source.url)throw Error('No OParl endpoint');const startedRequests=fetcher.requestCount;
 let lastApiCheck:string|null=null;const loader=createPoliteCouncilLoader(fetcher,{maxRequests:options.maxRequests,onDocument:document=>{lastApiCheck=document.checkedAt;}});
 const system=await loader(source.url),value=system.data as {type?:string;body?:string};let bodies:OparlBody[]=[];
 if(/\/Body$/.test(value.type??''))bodies=[system.data as OparlBody];
 else{
  if(!/^https?:\/\/schema\.oparl\.org\/1\.[01]\/System$/.test(value.type??'')||typeof value.body!=='string')throw Error('Invalid OParl System');
  const folder=join(fetcher.cacheDir,'oparl-bodies');await mkdir(folder,{recursive:true});const path=join(folder,hash(source.url)+'.json');
  let inventory:{base:string;next:string|null;bodies:OparlBody[];visited:string[];checkedAt?:string};
  try{inventory=JSON.parse(await readFile(path,'utf8'));if(inventory.base!==value.body)throw Error('OParl Body inventory binding changed');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;inventory={base:value.body,next:value.body,bodies:[],visited:[]};}
  if(!inventory.next&&(!inventory.checkedAt||!Number.isFinite(Date.parse(inventory.checkedAt))||Date.now()-Date.parse(inventory.checkedAt)>=(options.revalidateAfterMs??DEFAULT_SOURCE_REVALIDATE_MS)))inventory={base:value.body,next:value.body,bodies:[],visited:[]};
  for(let page=0;inventory.next&&page<options.maxPages&&fetcher.requestCount-startedRequests<options.maxRequests;page++){
   const next=inventory.next;if(inventory.visited.includes(next)||new URL(next).origin!==new URL(source.url).origin)throw Error('Unsafe OParl Body pagination');
   const response=await loader(next),parsed=parseOparlList<OparlBody>(response.data,next,'Body');inventory.bodies.push(...parsed.records);inventory.visited.push(next);inventory.next=parsed.next;inventory.checkedAt=response.checkedAt??response.retrievedAt;
   await writeFile(path+'.tmp',JSON.stringify(inventory));await rename(path+'.tmp',path);
  }
  if(inventory.next)return {documents:[],notes:['OParl Body inventory incomplete; durable cursor retained, municipal binding withheld'],requests:fetcher.requestCount-startedRequests,checkedAt:lastApiCheck,coverage:{state:'partial',pendingCount:1,runnableCount:1,blockedCount:0,frontierPath:path,scope:'Observed OParl Body inventory'}};
  bodies=inventory.bodies;
 }
 // The shared selector only reads identity fields; geometry is intentionally absent, not fabricated.
 const body=selectCouncilBody(bodies,{id:municipality.id,name:municipality.name,councilBodyId:source.councilBodyId,councilBodyAliases:source.councilBodyAliases} as City);
 const seeds:SourceSeed[]=[],notes:string[]=[],activeOparlRecordIds=new Set<string>();let incompleteLists=0;
 for(const kind of ['paper','meeting'] as const){
  if(!body[kind])continue;
  const folder=join(fetcher.cacheDir,'oparl',hash(body.id),kind);await mkdir(folder,{recursive:true});
  const storage:CouncilStorage={
   async load(){try{return JSON.parse(await readFile(join(folder,'checkpoint.json'),'utf8')) as CouncilCheckpoint;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}},
   async readSegment(index){return JSON.parse(await readFile(join(folder,`page-${index}.json`),'utf8')) as CouncilSegment;},
   async checkpoint(state,segment){if(segment)await writeFile(join(folder,`page-${state.segments-1}.json`),JSON.stringify(segment));await writeFile(join(folder,'checkpoint.tmp'),JSON.stringify(state));await rename(join(folder,'checkpoint.tmp'),join(folder,'checkpoint.json'));},
  };
  const traversal=await traverseCouncilList(body,kind,storage,loader,{maxPages:options.maxPages,reuseCompleteMs:options.revalidateAfterMs??DEFAULT_SOURCE_REVALIDATE_MS});
  if(traversal.state.error)notes.push(traversal.state.error);if(traversal.state.active){incompleteLists++;notes.push(`OParl ${kind} traversal incomplete; durable cursor retained`);}
  for(const {record} of traversal.records.values()){
   if(record.deleted)continue;activeOparlRecordIds.add(record.id);
   const metadata:CrawlDocument['metadata']={title:record.name??record.title,caseKey:record.reference??record.id,caseKeyType:'paper_reference',oparlRecordId:record.id,sourceVersion:record.modified};
   const documentDate=councilEventDate(record,kind)?.slice(0,10)??null;
   for(const file of [record.mainFile,...record.auxiliaryFile??[]])if(file?.downloadUrl)seeds.push({url:file.downloadUrl,sourceId:source.id,title:file.name??record.name,documentDate,adapter:'oparl',metadata});
   seeds.push({url:record.id,sourceId:source.id,title:record.name,documentDate,adapter:'oparl',metadata});
  }
 }
 const consumed=fetcher.requestCount-startedRequests;
 const result=await crawlHtmlSource(fetcher,municipality,{...source,url:null,crawlScope:{pageRoots:[],followLinkedDocuments:true}},{...options,maxRequests:Math.max(0,options.maxRequests-consumed),activeOparlRecordIds},seeds);
 for(const document of result.documents)if(document.metadata.oparlRecordId)document.metadata.caseKeyType='paper_reference';
 if(incompleteLists&&result.coverage){result.coverage.state='partial';result.coverage.runnableCount=(result.coverage.runnableCount??0)+incompleteLists;result.coverage.pendingCount+=incompleteLists;}
 result.requests+=consumed;result.checkedAt=[result.checkedAt,lastApiCheck].filter((value):value is string=>!!value).sort().at(-1)??null;result.notes.unshift(...notes);return result;
}
