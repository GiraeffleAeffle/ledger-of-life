import {readFile,mkdir,writeFile,rename,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {load} from 'cheerio';
import {hash} from './common.ts';
import {parseOparlList,selectCouncilBody,councilEventDate} from './council-oparl.ts';
import type {OparlBody,CouncilCheckpoint} from './council-oparl.ts';
import {traverseCouncilList,createPoliteCouncilLoader,isCouncilPermissionFailure} from './council-cache.ts';
import type {CouncilStorage,CouncilSegment} from './council-cache.ts';
import type {City} from './cities.ts';
import {publicUrl,PoliteFetcher,PoliteFetchError,sourceContentBinding} from './polite-fetch.ts';
import type {FetchedDocument,ExcludedDocument,FetchOptions,SourceContentBinding} from './polite-fetch.ts';
import type {SourceAccessPolicy,OwnerRobotsOverride} from './source-policy.ts';
import {PDF_TDM_POLICY_VERSION} from './pdf-tdm-policy.ts';
import { DOCUMENT_ORIGIN_CLASSIFIER_VERSION } from './document-origin-contract.ts'
import {writePrivateJson} from './district-private-io.ts';
import {CrawlRequestEvidenceCaptureError} from './district-crawl-request.ts';
import type {ParserIsolationReason} from './district-parser-isolation.ts';

export interface RegistrySource {
 id:string;kind:'council'|'participation'|'gazette'|'website'|'structured';url:string|null;vendor:string;
 checkState:'checked'|'not_found'|'not_checked';checkedAt:string|null;reason?:string;evidence:{url:string;locator:string}[];
 api?:{url:string;method?:'GET'|'POST';form?:Record<string,string>;format:'diplan-list'|'bobsh-list'|'mv-bauleitplan'};
 councilBodyId?:string;councilBodyAliases?:string[];
 crawlScope?:{pageRoots:string[];followLinkedDocuments:boolean};
 knownMachinePolicyUrls?:string[];
 ownerRobotsOverride?:OwnerRobotsOverride;robotsStatus?:'allowed'|'disallowed'|'unavailable';override?:'owner-approved 2026-10-11';hostProfile?:'municipal'|'default';
 /** Original configured URL retained when an adapter suppresses root discovery. */
 registeredSourceUrl?:string;
 registeredMunicipalityId?:string;
 legalBasis?:{classification:'section_5_official_act_candidate'|'section_44b_tdm_candidate'|'unassessed';reason?:string};
}
function sourceFetchOptions(source:RegistrySource):FetchOptions {
 const registeredSourceUrl=source.registeredSourceUrl??source.url??source.api?.url;
 return {registeredSourceUrl,registeredMunicipalityId:source.registeredMunicipalityId,registeredSourceId:source.id,ownerRobotsOverride:source.ownerRobotsOverride,machinePolicyUrls:source.knownMachinePolicyUrls,hostProfile:source.hostProfile??'municipal'};
}
/** Safe coded scope evidence; never includes source-controlled procedure text. */
export class MunicipalIdentityBindingError extends Error {
 readonly code='municipal_identity_unbound';
 constructor(){super('BOB municipal code missing or conflicting; no empty-coverage inference');this.name='MunicipalIdentityBindingError';}
}
export interface SourceSeed {url:string;title?:string;documentDate?:string|null;sourceId:string;adapter?:string;metadata?:CrawlDocument['metadata']}
export interface RegistryMunicipality {id:string;name:string;ags:string;districtId:string;sources:RegistrySource[];seedDocuments?:SourceSeed[]}
export interface CrawlDocument extends FetchedDocument {
 id:string;municipalityId:string;ags:string;districtId:string;sourceId:string;documentDate:string|null;adapter:string;
 metadata:{title?:string;caseKey?:string;caseKeyType?:string;stage?:string;stageDate?:string;sourceType?:string;discoveredFrom?:string;oparlRecordId?:string;sourceVersion?:string;legalBasis?:string};
}
export type CrawlExcludedDocument=ExcludedDocument&Pick<CrawlDocument,'id'|'municipalityId'|'ags'|'districtId'|'sourceId'|'documentDate'|'adapter'|'metadata'>;
export interface CrawlTargetScope {kind:'page_roots'|'seed_documents';urls:string[];state:'complete'|'partial'|'blocked';pendingCount:number;runnableCount:number;blockedCount:number}
export interface CrawlCoverage {state:'complete'|'partial'|'blocked';pendingCount:number;runnableCount:number;blockedCount:number;frontierPath?:string;scope:string;action?:'ask_municipality';sourceCoverage?:'not_assessed';targetScope?:CrawlTargetScope}
export interface AdapterResult {documents:CrawlDocument[];excludedDocuments?:CrawlExcludedDocument[];notes:string[];requests:number;checkedAt?:string|null;coverage?:CrawlCoverage;blocked?:FrontierFailure[];sourceBindings?:SourceContentBinding[]}
export const DEFAULT_SOURCE_REVALIDATE_MS=24*60*60_000;
export interface AdapterOptions {maxDocuments:number;maxPages:number;maxRequests:number;activeOparlRecordIds?:Set<string>;revalidateAfterMs?:number;pageRoots?:string[];seedDocumentUrls?:string[];discoveryBindings?:SourceContentBinding[]}
export interface DiscoveredLink {url:string;title:string;pdf:boolean;structured:boolean}
interface FrontierEntry extends SourceSeed {from:string;depth:number;revalidate?:boolean;previous?:CrawlDocument}
export interface FrontierFailure {url:string;from?:string;depth?:number;failure:string;reason:string;inspectionReason?:ParserIsolationReason;checkedAt:string;status?:number;policy?:SourceAccessPolicy;retryAfter?:string;action:'ask_municipality';urlRole?:'registered_source_context';targetUrlSha256?:string;policyAudit?:{policySha256:string;sourceHostSha256:string;robotsState:SourceAccessPolicy['robots']['state'];robotsStatus:'allowed'|'disallowed'|'unavailable';override:'owner-approved 2026-10-11'|null;tdmState:SourceAccessPolicy['tdm']['state'];tdmReferenceStatus:'unavailable'|null;tdmDeclarationStatus?:'unavailable'|null;access:SourceAccessPolicy['access']}}
interface SourceFrontier {schemaVersion:1;municipalityId:string;sourceId:string;queue:FrontierEntry[];visited:string[];documents:CrawlDocument[];excludedDocuments?:CrawlExcludedDocument[];failures:FrontierFailure[];roots:string[];checkedUrls?:Record<string,{checkedAt:string;documentId:string}>;lastCheckedAt?:string|null;sourceBindings?:SourceContentBinding[]}
/** Explicit target selection never inherits unrelated roots, seeds or API discovery. */
export function registeredSourceTargets(municipality:RegistryMunicipality,source:RegistrySource,options:Pick<AdapterOptions,'pageRoots'|'seedDocumentUrls'>):{kind:'pages'|'seeds';urls:string[];seeds:SourceSeed[]}|undefined {
 if(options.pageRoots!==undefined&&options.seedDocumentUrls!==undefined)throw Error('Page-root and seed-document selections are mutually exclusive');
 const requested=options.pageRoots??options.seedDocumentUrls;
 if(requested===undefined)return undefined;
 if(requested.length<1||requested.length>200)throw Error('Select between 1 and 200 exact registered targets');
 const urls=requested.map(value=>publicUrl(value).href);
 if(new Set(urls).size!==urls.length)throw Error('Duplicate registered target selection');
 if(options.pageRoots!==undefined){
  if(source.api||source.vendor==='oparl')throw Error('Page-root selection requires an HTML source; use registered seed documents for an API source');
  const registered=new Set((source.crawlScope?.pageRoots??[]).map(value=>publicUrl(value).href));
  if(urls.some(url=>!registered.has(url)))throw Error('Requested page root is not registered for the selected source');
  return {kind:'pages',urls,seeds:[]};
 }
 const registered=new Map((municipality.seedDocuments??[]).filter(seed=>seed.sourceId===source.id).map(seed=>[publicUrl(seed.url).href,seed]));
 if(urls.some(url=>!registered.has(url)))throw Error('Requested seed document is not registered for the selected municipality/source');
 return {kind:'seeds',urls,seeds:urls.map(url=>({...registered.get(url)!,url}))};
}
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
export function sourceDocument<T extends FetchedDocument|ExcludedDocument>(response:T,municipality:RegistryMunicipality,source:RegistrySource,adapter:string,metadata:CrawlDocument['metadata']={},documentDate:string|null=null):T&Pick<CrawlDocument,'id'|'municipalityId'|'ags'|'districtId'|'sourceId'|'documentDate'|'adapter'|'metadata'> {
 return {...response,id:'document-'+hash(municipality.id+'\n'+source.id+'\n'+response.url).slice(0,24),municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,sourceId:source.id,documentDate,adapter,metadata:{sourceType:source.kind,...metadata}};
}
async function readSourceText(fetcher:PoliteFetcher,document:FetchedDocument):Promise<string>{
 await fetcher.assertSourceBindingsAllowed([sourceContentBinding(document)]);
 await fetcher.assertSourceReadable(document.localPath,document.url);
 const text=await readFile(document.localPath,'utf8');
 await fetcher.assertSourceReadable(document.localPath,document.url);return text;
}
async function readDerivedText(fetcher:PoliteFetcher,path:string):Promise<string>{
 await lstat(path);
 await fetcher.assertSourceReadable(path);
 const text=await readFile(path,'utf8');
 await fetcher.assertSourceReadable(path);return text;
}
function mergeSourceBindings(...groups:SourceContentBinding[][]):SourceContentBinding[]{
 const bindings=new Map<string,SourceContentBinding>();
 for(const group of groups)for(const binding of group)bindings.set(JSON.stringify([binding.url,binding.sha256]),binding);
 return [...bindings.values()];
}
export async function crawlHtmlSource(fetcher:PoliteFetcher,municipality:RegistryMunicipality,source:RegistrySource,options:AdapterOptions,seeds:SourceSeed[]=municipality.seedDocuments?.filter(seed=>seed.sourceId===source.id)??[],boundProcedureRoots?:string[]):Promise<AdapterResult>{
 const targets=registeredSourceTargets(municipality,source,options);
 if(targets&&boundProcedureRoots)throw Error('Exact registered targets cannot be combined with procedure traversal');
 await fetcher.initialize();
 const folder=join(fetcher.cacheDir,'frontiers');await mkdir(folder,{recursive:true});
 const boundRoots=boundProcedureRoots?.map(value=>publicUrl(value)),scopeKey=targets?`\nregistered-${targets.kind}-v1\n`+JSON.stringify([...targets.urls].sort()):boundRoots?'\nbound-procedures-v1\n'+JSON.stringify(boundRoots.map(url=>url.href).sort()):'';
 const frontierPath=join(folder,hash(municipality.id+'\n'+source.id+scopeKey)+'.json'),ttl=options.revalidateAfterMs??DEFAULT_SOURCE_REVALIDATE_MS;
 if(!Number.isFinite(ttl)||ttl<=0)throw Error('Source revalidation TTL must be positive');
 let frontier:SourceFrontier;
 try{frontier=JSON.parse(await readDerivedText(fetcher,frontierPath)) as SourceFrontier;if(frontier.schemaVersion!==1||frontier.municipalityId!==municipality.id||frontier.sourceId!==source.id)throw Error('Frontier identity mismatch');if(frontier.sourceBindings?.length)await fetcher.assertSourceBindingsAllowed(frontier.sourceBindings);else if(frontier.documents.length||frontier.queue.some(item=>item.title||item.metadata||item.previous))throw new PoliteFetchError('host_state_unsafe','Source-bearing frontier lacks immutable discovery provenance');}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;frontier={schemaVersion:1,municipalityId:municipality.id,sourceId:source.id,queue:[],visited:[],documents:[],failures:[],roots:[]};}
 frontier.checkedUrls??={};
 frontier.excludedDocuments??=[];
 frontier.sourceBindings=mergeSourceBindings(frontier.sourceBindings??[],options.discoveryBindings??[]);
 const configuredSeeds=new Map((municipality.seedDocuments??[]).filter(seed=>seed.sourceId===source.id).map(seed=>[publicUrl(seed.url).href,seed]));
 for(const item of frontier.queue){
  const seed=configuredSeeds.get(item.url);if(!seed)continue;
  item.title??=seed.title;item.metadata={...seed.metadata,...item.metadata};item.documentDate??=seed.documentDate;item.adapter??=seed.adapter;
 }
 for(const document of frontier.documents){
  const seed=configuredSeeds.get(document.url);if(!seed)continue;
  document.metadata={...seed.metadata,...(seed.title?{title:seed.title}:{}),...document.metadata};document.documentDate??=seed.documentDate??null;
 }
 const persistedMetadata=(url:string,metadata:CrawlDocument['metadata']|undefined):CrawlDocument['metadata']|undefined=>{
  if(!metadata)return undefined;const copy={...metadata},seed=configuredSeeds.get(url);
  if(seed){if(copy.title===seed.title)delete copy.title;for(const field of Object.keys(seed.metadata??{}) as Array<keyof CrawlDocument['metadata']>)if(copy[field]===seed.metadata![field])delete copy[field];}
  return copy;
 };
 const persistedDocument=(document:CrawlDocument):CrawlDocument=>({...document,metadata:persistedMetadata(document.url,document.metadata)??{},documentDate:document.documentDate===configuredSeeds.get(document.url)?.documentDate?null:document.documentDate});
 if(targets){
  const allowed=new Set(targets.urls);
  if(frontier.roots.some(url=>!allowed.has(url))||frontier.queue.some(item=>!allowed.has(item.url))||frontier.failures.some(item=>!allowed.has(item.url))||[...frontier.documents,...frontier.excludedDocuments].some(document=>!allowed.has(document.metadata.discoveredFrom??document.url)))throw Error('Stored target frontier contains entries outside the exact registered selection');
 }
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
 const roots=targets?.urls??(boundRoots?[]:[...new Set([...frontier.roots,...source.crawlScope?.pageRoots??[],...(source.url?[source.url]:[])].map(value=>publicUrl(value).href))]);frontier.roots=roots;
 const rootSet=new Set(roots),documentsById=new Map(frontier.documents.map(document=>[document.id,document]));
 const scheduledDocumentIds=new Set<string>();
 for(const root of roots)if(visited.has(root)&&!frontier.checkedUrls[root])visited.delete(root);
 const expiredIds=new Set<string>(),refreshRoots:FrontierEntry[]=[],refreshDocuments:FrontierEntry[]=[];
 // Refresh roots first, but append other expired documents behind the existing unfinished frontier.
 // Old policy is withheld from the returned index until a real conditional request succeeds.
 for(const [url,observation] of Object.entries(frontier.checkedUrls).sort(([a],[b])=>Number(rootSet.has(b))-Number(rootSet.has(a)))){
  if(targets&&!rootSet.has(url))continue;
  if(!rootSet.has(url)&&documentsById.get(observation.documentId)?.url!==url)continue;
  const previous=documentsById.get(observation.documentId);
  const obsoletePdfPolicy=previous?.mimeType==='application/pdf'&&!previous.policy?.tdm.evidence.some(evidence=>evidence.url===previous.url&&evidence.sha256===previous.sha256&&evidence.locator.startsWith('PDF.js ')&&evidence.locator.endsWith(` XMP metadata (${PDF_TDM_POLICY_VERSION})`)&&(['0','no_tdm_reservation_field'].includes(evidence.value)||evidence.value==='1'&&previous.policy?.tdmOverride==='owner-approved 2026-10-11')&&!!evidence.checkedAt&&Number.isFinite(Date.parse(evidence.checkedAt)));
  const obsoleteOrigin=source.ownerRobotsOverride&&previous&&previous.policy?.documentOrigin?.classifierVersion!==DOCUMENT_ORIGIN_CLASSIFIER_VERSION;
  const due=obsoletePdfPolicy||obsoleteOrigin||!Number.isFinite(Date.parse(observation.checkedAt))||now-Date.parse(observation.checkedAt)>=ttl;
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
  if(!visited.has(root)&&!queued.has(root)&&!failed.has(root)){const seed=targets?.seeds.find(seed=>seed.url===root);frontier.queue.push({...seed,url:root,sourceId:source.id,depth:0,from:root});queued.add(root);}
 }
 const seedEntries:FrontierEntry[]=[];
 if(!targets)for(const seed of seeds){const url=publicUrl(seed.url).href;if(!visited.has(url)&&!queued.has(url)&&!failed.has(url)){seedEntries.push({...seed,url,depth:0,from:source.url??url});queued.add(url);}}
 frontier.queue.unshift(...seedEntries);
 // Failed checks are retried only after their explicit backoff/TTL, never by bypassing their restriction.
 const deferred=frontier.failures.filter(item=>item.retryAfter?Date.parse(item.retryAfter)<=now:now-Date.parse(item.checkedAt)>=ttl);
 for(const item of deferred){
  if(!queued.has(item.url)){frontier.queue.push({url:item.url,sourceId:source.id,depth:item.depth??0,from:item.from??item.url,revalidate:true});queued.add(item.url);}
  failed.delete(item.url);visited.delete(item.url);
 }
 frontier.failures=frontier.failures.filter(item=>!deferred.includes(item));
 const persist=async()=>{
  frontier.visited=[...visited];
  const value={...frontier,documents:frontier.documents.map(persistedDocument),queue:frontier.queue.map(item=>{
   const seed=configuredSeeds.get(item.url),metadata=persistedMetadata(item.url,item.metadata);
   return {url:item.url,sourceId:item.sourceId,from:item.from,depth:item.depth,revalidate:item.revalidate,title:seed&&item.title===seed.title?undefined:item.title,documentDate:seed&&item.documentDate===seed.documentDate?undefined:item.documentDate,adapter:seed&&item.adapter===seed.adapter?undefined:item.adapter,metadata:metadata&&Object.keys(metadata).length?metadata:undefined,previous:item.previous?persistedDocument(item.previous):undefined};
  }),sourceBindings:frontier.sourceBindings!.length?frontier.sourceBindings:undefined};
  if(frontier.sourceBindings!.length)await fetcher.persistDerivedJson(frontierPath,value,frontier.sourceBindings!);
  else await writePrivateJson(frontierPath,value);
 };
 await persist();
 let requests=0,processedDocuments=0,htmlPages=0,hostStopped=false;const notes:string[]=[];
 const discoveryOnly=!targets&&!boundRoots&&source.crawlScope?.pageRoots.length===0&&source.crawlScope.followLinkedDocuments===false;
 if(discoveryOnly)notes.push('Endpoint discovery only: municipal procedure binding is not established; no statewide link expansion');
 while(frontier.queue.length&&requests<options.maxRequests&&processedDocuments<options.maxDocuments&&htmlPages<options.maxPages){
  const item=frontier.queue[0];if(visited.has(item.url)&&!item.revalidate){frontier.queue.shift();await persist();continue;}requests++;
  try{
   if(item.from!==item.url&&fetcher.hasRegisteredSourceDecision(sourceFetchOptions(source))){
    const parent=frontier.documents.find(row=>row.url===item.from);
    if(parent&&/^(?:text\/html|application\/xhtml\+xml)$/.test(parent.mimeType)&&discoverDocumentLinks(await readSourceText(fetcher,parent),parent.url).some(link=>link.url===item.url))await fetcher.recordDiscoveredSourceLinks(sourceFetchOptions(source),parent,[item.url]);
   }
   const response=await fetcher.fetch(item.url,{...sourceFetchOptions(source),title:item.title,linkText:item.title,municipalityName:municipality.name}),isHtml=/^(?:text\/html|application\/xhtml\+xml)$/.test(response.mimeType),isPdf=response.mimeType==='application/pdf';
   frontier.sourceBindings=mergeSourceBindings(frontier.sourceBindings!,[sourceContentBinding(response)]);
   const isStructured=/xml|gml|zip/.test(response.mimeType)||/\.(?:xml|gml|zip)(?:$|[?])/i.test(response.url);
   if(!isHtml&&!isPdf&&!isStructured&&!response.mimeType.startsWith('text/')&&!response.mimeType.includes('json'))throw Error(`Unsupported representation ${response.mimeType}`);
   const html=isHtml?await readSourceText(fetcher,response):null,sameBytes=item.previous?.sha256===response.sha256;
   const title=(item.revalidate?undefined:item.title)||(html?load(html)('h1').first().text().replace(/\s+/g,' ').trim().slice(0,500):sameBytes?item.previous?.metadata.title:undefined);
   const document=sourceDocument(response,municipality,source,item.adapter??(isStructured?'xplanung-document':isPdf?'official-pdf':'official-html'),{...(sameBytes?item.previous?.metadata:item.metadata),...(title?{title}:{}),discoveredFrom:item.from,legalBasis:source.legalBasis?.classification??'unassessed'},sameBytes?item.previous!.documentDate:item.documentDate??null);
   if(item.previous&&item.previous.id!==document.id)frontier.documents=frontier.documents.filter(previous=>previous.id!==item.previous!.id);
   const previousIndex=frontier.documents.findIndex(previous=>previous.id===document.id);
   if(previousIndex<0)frontier.documents.push(document);else frontier.documents[previousIndex]=document;
   processedDocuments++;frontier.lastCheckedAt=response.checkedAt;
   frontier.checkedUrls[item.url]={checkedAt:response.checkedAt,documentId:document.id};frontier.checkedUrls[response.url]={checkedAt:response.checkedAt,documentId:document.id};
   visited.add(item.url);visited.add(response.url);frontier.queue.shift();
   if(html)htmlPages++;
   if(html&&!discoveryOnly&&!targets){
    const discovered:string[]=[];
    for(const link of discoverDocumentLinks(html,response.url)){
     if(boundRoots&&!link.pdf&&!link.structured&&!/\/(?:loadDocument|download)\.(?:php|phtml)(?:\?|$)/i.test(link.url)){
      const candidate=new URL(link.url);
      if(!boundRoots.some(root=>candidate.origin===root.origin&&(candidate.pathname===root.pathname||candidate.pathname.startsWith(root.pathname.slice(0,root.pathname.lastIndexOf('/')+1)))))continue;
     }
     if(!boundRoots&&source.crawlScope?.followLinkedDocuments===false&&(link.pdf||link.structured))continue;
     discovered.push(link.url);
     if(visited.has(link.url)||queued.has(link.url)||failed.has(link.url))continue;
     frontier.queue.push({url:link.url,title:link.title,sourceId:source.id,depth:item.depth+1,from:response.url});queued.add(link.url);
    }
    await fetcher.recordDiscoveredSourceLinks(sourceFetchOptions(source),response,discovered);
   }
  }catch(error){
   if(error instanceof CrawlRequestEvidenceCaptureError)throw error;
   if(isCouncilPermissionFailure(error)){frontier.documents=[];frontier.queue=[];throw error;}
   const failure=error instanceof PoliteFetchError?error.failure:'representation_error',status=error instanceof PoliteFetchError?error.status:undefined,checkedAt=new Date().toISOString();
   const transient=['timeout','network_error','dns_error','robots_unavailable','tdm_unavailable','host_cooldown','host_busy'].includes(failure)||status===429||status!==undefined&&status>=500;
   const retryAfter=error instanceof PoliteFetchError?error.retryAfter:undefined;
   frontier.failures.push({url:item.url,from:item.from,depth:item.depth,failure,reason:failure,checkedAt,...(status?{status}:{}),...(error instanceof PoliteFetchError&&error.policy?{policy:error.policy}:{}),...(retryAfter?{retryAfter}:transient?{retryAfter:new Date(Date.now()+15*60_000).toISOString()}:{}),action:'ask_municipality'});
   hostStopped=status===403||status===429||failure.startsWith('host_');
   if(item.previous)frontier.documents=frontier.documents.filter(document=>document.id!==item.previous!.id);
   frontier.lastCheckedAt=checkedAt;failed.add(item.url);frontier.queue.shift();
  }
  await persist();
  if(hostStopped)break;
 }
 const pendingCount=frontier.queue.length+frontier.failures.filter(item=>item.retryAfter).length,blockedCount=frontier.failures.filter(item=>!item.retryAfter).length;
 const state=pendingCount?'partial':blockedCount?'blocked':'complete';
 const runnableCount=hostStopped?0:frontier.queue.length;
 const targetScope:CrawlTargetScope|undefined=targets?{kind:targets.kind==='pages'?'page_roots':'seed_documents',urls:targets.urls,state,pendingCount,runnableCount,blockedCount}:undefined;
 notes.push(`Scoped frontier ${state}: ${frontier.documents.length} documents, ${frontier.queue.length} queued links, ${frontier.failures.length} inaccessible links. Completion refers only to discovered scoped links, never all municipal documents.`);
 notes.push(`Conditional rediscovery and policy revalidation TTL ${ttl}ms; expired documents are withheld until checked; cached source checkedAt is not advanced without a request.`);
 if(targets)notes.push('Only the explicit registered target selection was assessed; source-wide traversal remains not assessed, including any broader pending work.');
 if(frontier.failures.length)notes.push('Inaccessible, excluded or reserved resources retain explicit policy evidence; no contact or access-barrier bypass occurred.');
 for(const document of frontier.documents)await fetcher.assertHostAllowed(document.url);
 return {documents:frontier.documents,excludedDocuments:frontier.excludedDocuments,sourceBindings:frontier.sourceBindings,notes,requests,checkedAt:frontier.lastCheckedAt??null,coverage:{state:targets?'partial':state,pendingCount,runnableCount,blockedCount,frontierPath,scope:targets?`Exactly selected registered ${targets.kind==='pages'?'page roots':'seed documents'}; no API discovery or link traversal`:boundRoots?'Exactly bound procedure pages and their actual linked document downloads; no statewide roots or other procedures':'Observed roots, relevant same-origin planning/archive pages and all their linked public document files',...(targetScope?{sourceCoverage:'not_assessed' as const,targetScope}:{}),...(frontier.failures.length?{action:'ask_municipality' as const}:{})},blocked:frontier.failures};
}
const apiResponses=new WeakMap<PoliteFetcher,Map<string,{requestedAt:number;response:Promise<FetchedDocument>}>>();
async function observedApiResponse(fetcher:PoliteFetcher,source:RegistrySource,ttl:number):Promise<FetchedDocument>{
 if(!source.api)throw Error('No observed API descriptor');
 await fetcher.initialize();
 await fetcher.assertHostAllowed(source.api.url);
 let responses=apiResponses.get(fetcher);if(!responses){responses=new Map();apiResponses.set(fetcher,responses);}
 const body=source.api.method==='POST'?new URLSearchParams(source.api.form??{}).toString():undefined,key=JSON.stringify([source.api.url,source.api.method??'GET',body,source.ownerRobotsOverride??null,source.knownMachinePolicyUrls??[]]);
 let entry=responses.get(key);
 if(!entry||Date.now()-entry.requestedAt>=ttl){entry={requestedAt:Date.now(),response:fetcher.fetch(source.api.url,{...sourceFetchOptions(source),method:source.api.method??'GET',body})};responses.set(key,entry);}
 const response=await entry.response;await fetcher.assertHostAllowed(response.url);return response;
}
/** API URLs/form fields must be observed in registry, never inferred from vendor names. */
export async function crawlParticipationApi(fetcher:PoliteFetcher,municipality:RegistryMunicipality,source:RegistrySource,options:AdapterOptions):Promise<AdapterResult>{
 if(!source.api)throw Error('No observed public API configured');
 const before=fetcher.requestCount,ttl=options.revalidateAfterMs??DEFAULT_SOURCE_REVALIDATE_MS,response=await observedApiResponse(fetcher,source,ttl);
 const data=JSON.parse(await readSourceText(fetcher,response)) as {success?:boolean;mapVars?:{procedureId:string;procedureUrl:string;externalName:string;publicParticipationStartDate?:string}[];responseHtml?:string;procedureCount?:number};
 if(data.success!==true||!Array.isArray(data.mapVars)||typeof data.responseHtml!=='string'||data.mapVars.length!==data.procedureCount)throw Error('Unexpected public participation list envelope; no empty-coverage inference');
 const $=load(data.responseHtml),names=new Map<string,string>();
 $('.c-procedurelist__item[data-procedure-id]').each((_,element)=>{const row=$(element);names.set(row.attr('data-procedure-id')!,row.text().replace(/\s+/g,' '));});
 const normalizedName=municipality.name.toLocaleLowerCase('de'),seeds:SourceSeed[]=[];
 const bob=source.api.format==='bobsh-list',bindings=new Map<string,string|null>();let inventory:FetchedDocument|undefined;
 const boundProcedures:Array<{procedureId:string;procedureUrl:string}>=[];
 if(bob){
  if(!source.url||!/^\d{8}$/.test(municipality.ags))throw Error('BOB discovery requires a registered inventory root and exact eight-digit AGS');
  if(fetcher.requestCount-before>=options.maxRequests)return {documents:[],sourceBindings:[sourceContentBinding(response)],notes:['BOB municipal identity inventory deferred by request budget; no empty-coverage inference'],requests:fetcher.requestCount-before,checkedAt:response.checkedAt,coverage:{state:'partial',pendingCount:1,runnableCount:1,blockedCount:0,scope:'Public BOB inventory and exact municipal-code bindings'}};
  inventory=await observedApiResponse(fetcher,{...source,api:{url:source.url,format:'bobsh-list'}},ttl);
  // Discovery-only tokenization follows completed HTML5 policy inspection.
  // Never execute the script or run a repeated-alternation regex over its literal.
  const root=load(await readSourceText(fetcher,inventory),{xml:{xmlMode:false}}),literals:string[]=[];
  for(const element of root('script:not([src])').toArray()){
   const script=root(element).text(),prefix=/\bvar\s+initialProcedures\s*=\s*JSON\.parse\('/g;
   for(const match of script.matchAll(prefix)){
    const start=match.index+match[0].length;let end=start;
    while(end<script.length){
     if(script[end]==='\\'){end+=2;continue;}
     if(script[end]==="'")break;
     end++;
    }
    if(end>=script.length||script[end+1]!==')')throw Error('Malformed BOB initialProcedures literal; no empty-coverage inference');
    literals.push(script.slice(start,end));
   }
  }
  if(literals.length!==1)throw Error('BOB initialProcedures inventory missing or ambiguous; no empty-coverage inference');
  // Decode only the observed JSON string literal, never execute upstream JavaScript.
  const rows:unknown=JSON.parse(JSON.parse('"'+literals[0].replace(/"/g,'\\"')+'"'));
  if(!Array.isArray(rows))throw Error('Unexpected BOB municipal identity inventory');
  for(const row of rows){
   if(!row||typeof row!=='object'||typeof row.id!=='string')throw Error('Malformed BOB procedure identity');
   const code=row.municipalCode,ars=row.ars,hasCode=code!==undefined&&code!==null&&code!=='',hasArs=ars!==undefined&&ars!==null&&ars!=='';
   const ags=typeof code==='string'&&/^\d{8}$/.test(code)?code:null;
   // ARS is Land(2), Kreis(3), Gemeindeverband(4), Gemeinde(3), not an AGS prefix.
   const arsAgs=typeof ars==='string'&&/^\d{12}$/.test(ars)?ars.slice(0,5)+ars.slice(9):null;
   const binding=hasCode&&!ags||hasArs&&!arsAgs||ags&&arsAgs&&ags!==arsAgs?null:ags??arsAgs;
   bindings.set(row.id,bindings.has(row.id)&&bindings.get(row.id)!==binding?null:binding);
  }
 }
 for(const procedure of data.mapVars){
  const card=names.get(procedure.procedureId);
  if(bob){
   const binding=bindings.get(procedure.procedureId);
   if(!binding)throw new MunicipalIdentityBindingError();
   if(binding!==municipality.ags)continue;
   if(!card||typeof procedure.externalName!=='string'||typeof procedure.procedureUrl!=='string')throw Error('Incomplete exact-bound BOB procedure; no empty-coverage inference');
  }else{
   if(!card||typeof procedure.externalName!=='string'||typeof procedure.procedureUrl!=='string')continue;
   // DiPlan discovery retains its existing name-based behavior; extraction still binds exact evidence.
   if(!(card+' '+procedure.externalName).toLocaleLowerCase('de').includes(normalizedName))continue;
  }
  // A consultation start is not the document's publication or decision date.
  seeds.push({url:new URL(procedure.procedureUrl,response.url).href,title:procedure.externalName,sourceId:source.id,documentDate:null});
  if(bob)boundProcedures.push({procedureId:procedure.procedureId,procedureUrl:seeds.at(-1)!.url});
 }
 const apiRequests=fetcher.requestCount-before;
 if(bob&&inventory)await fetcher.recordExactMunicipalBobDiscoveries(sourceFetchOptions(source),response,inventory,municipality.ags,boundProcedures);
 await fetcher.recordDiscoveredSourceLinks(sourceFetchOptions(source),response,seeds.map(seed=>seed.url));
 const result=await crawlHtmlSource(fetcher,municipality,source,{...options,maxRequests:Math.max(0,options.maxRequests-apiRequests),discoveryBindings:mergeSourceBindings(options.discoveryBindings??[],[sourceContentBinding(response)],inventory?[sourceContentBinding(inventory)]:[])},bob?seeds:[...seeds,...municipality.seedDocuments?.filter(seed=>seed.sourceId===source.id)??[]],bob?seeds.map(seed=>seed.url):undefined);
 for(const document of result.documents){document.adapter=source.api.format;const seed=seeds.find(item=>item.url===document.url||item.url===document.metadata.discoveredFrom);const procedure=data.mapVars.find(item=>new URL(item.procedureUrl,response.url).href===seed?.url);if(procedure){document.metadata.caseKey=procedure.procedureId;document.metadata.caseKeyType=source.api.format==='diplan-list'?'diplan':'bobsh';}}
 result.requests+=apiRequests;result.checkedAt=[result.checkedAt,response.checkedAt,inventory?.checkedAt].filter((value):value is string=>!!value).sort().at(-1)??null;result.notes.unshift(`Observed ${source.api.format} public list ${response.url}; sha256 ${response.sha256}; all ${data.procedureCount} listed procedures considered for municipal discovery`);
 if(inventory)result.notes.push(`BOB exact municipalCode/ARS binding against ${inventory.url}; sha256 ${inventory.sha256}; ${seeds.length} exact-bound procedures. Empty means this public scoped list only, never absence of municipal activity or unlisted procedures.`);
 return result;
}
/** MV Bauportal's documented geoportalsearch interface, scoped by exact official AGS. */
export async function crawlMvPlanningApi(fetcher:PoliteFetcher,municipality:RegistryMunicipality,source:RegistrySource,options:AdapterOptions):Promise<AdapterResult>{
 if(!source.api||source.api.format!=='mv-bauleitplan')throw Error('No observed MV Bauportal API configured');
 await fetcher.initialize();
 await fetcher.assertHostAllowed(source.api.url);
 const folder=join(fetcher.cacheDir,'api-frontiers');await mkdir(folder,{recursive:true});const statePath=join(folder,hash(municipality.id+'\n'+source.id)+'-mv.json');
 interface ApiState {url:string;offset:number;total:number|null;complete:boolean;seeds:SourceSeed[];metadata:Record<string,{title:string;caseKey:string}>;evidence:{url:string;sha256:string;checkedAt:string}[];sourceBindings:SourceContentBinding[]}
 let state:ApiState;
 try{state=JSON.parse(await readDerivedText(fetcher,statePath)) as ApiState;if(state.url!==source.api.url||!Array.isArray(state.sourceBindings))throw new PoliteFetchError('host_state_unsafe','MV API cache requires managed provenance; use a fresh acquisition lane');await fetcher.assertSourceBindingsAllowed(state.sourceBindings);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;state={url:source.api.url,offset:0,total:null,complete:false,seeds:[],metadata:{},evidence:[],sourceBindings:[]};}
 if(state.seeds.length&&fetcher.hasRegisteredSourceDecision(sourceFetchOptions(source))){
  for(const binding of state.sourceBindings){
   const rawPath=join(fetcher.cacheDir,'sha256',binding.sha256);await fetcher.assertSourceReadable(rawPath,binding.url);
   const bytes=await readFile(rawPath);if(hash(bytes)!==binding.sha256)throw new PoliteFetchError('host_state_unsafe','MV discovery body binding mismatch');
   await fetcher.assertSourceBindingsAllowed([binding]);
   const data=JSON.parse(bytes.toString('utf8')) as {success?:boolean;results?:unknown[][]};
   if(data.success!==true||!Array.isArray(data.results)||data.results.some(group=>!Array.isArray(group)))throw Error('Unexpected retained MV discovery response');
   const links:string[]=[];
   for(const row of data.results.flat()){
    if(!row||typeof row!=='object')continue;const record=row as {title?:unknown;_resourceLinkId?:unknown;x_GKZ?:unknown;x_dokumentURL?:unknown};
    if(!Array.isArray(record.x_GKZ)||!record.x_GKZ.includes(municipality.ags)||typeof record.title!=='string'||typeof record._resourceLinkId!=='string'||!Array.isArray(record.x_dokumentURL))continue;
    for(const link of record.x_dokumentURL)if(typeof link==='string')links.push(publicUrl(link).href);
   }
   fetcher.authorizeRegisteredSourceDiscovery(sourceFetchOptions(source),binding,links);
  }
 }
 const priorApiCheck=state.evidence.at(-1)?.checkedAt;
 if(state.complete&&(!priorApiCheck||!Number.isFinite(Date.parse(priorApiCheck))||Date.now()-Date.parse(priorApiCheck)>=(options.revalidateAfterMs??DEFAULT_SOURCE_REVALIDATE_MS))){state.offset=0;state.total=null;state.complete=false;}
 const notes:string[]=[];let requests=0;
 for(let page=0;!state.complete&&page<options.maxPages&&requests<options.maxRequests;page++){
  const url=new URL(source.api.url);url.searchParams.set('offset',String(state.offset));url.searchParams.set('n','100');
  const response=await fetcher.fetch(url.href,sourceFetchOptions(source));requests++;
  const data=JSON.parse(await readSourceText(fetcher,response)) as {success?:boolean;total?:number;hits?:number;results?:unknown[][]};
  if(data.success!==true||!Number.isInteger(data.total)||!Array.isArray(data.results)||data.results.some(group=>!Array.isArray(group)))throw Error('Unexpected MV Bauportal response; no empty-coverage inference');
  const records=data.results.flat() as {title?:string;_resourceLinkId?:string;x_GKZ?:string[];x_dokumentURL?:string[]}[];state.total=data.total!;
  state.evidence.push({url:response.url,sha256:response.sha256,checkedAt:response.checkedAt});
  state.sourceBindings.push(sourceContentBinding(response));
  for(const record of records){
   if(!Array.isArray(record.x_GKZ)||!record.x_GKZ.includes(municipality.ags)||typeof record.title!=='string'||typeof record._resourceLinkId!=='string'||!Array.isArray(record.x_dokumentURL))continue;
   for(const link of record.x_dokumentURL){
    if(typeof link!=='string')continue;const documentUrl=publicUrl(link).href;if(state.metadata[documentUrl])continue;
    await fetcher.recordDiscoveredSourceLinks(sourceFetchOptions(source),response,[documentUrl]);
    state.metadata[documentUrl]={title:record.title,caseKey:record._resourceLinkId};state.seeds.push({url:documentUrl,title:record.title,sourceId:source.id,documentDate:null});
   }
  }
  if(!records.length&&state.offset<state.total)throw Error('MV API returned an incomplete empty page; cursor retained');
  state.offset+=records.length;state.complete=state.offset>=state.total;
  await fetcher.persistDerivedJson(statePath,state,state.sourceBindings);
 }
 notes.push(`MV Bauportal durable API frontier: ${state.offset}/${state.total??'unknown'} records; ${state.complete?'complete':'partial'}; evidence ${state.evidence.map(item=>item.sha256).join(',')}`);
 const result=await crawlHtmlSource(fetcher,municipality,source,{...options,maxRequests:Math.max(0,options.maxRequests-requests),discoveryBindings:mergeSourceBindings(options.discoveryBindings??[],state.sourceBindings)},[...state.seeds,...municipality.seedDocuments?.filter(seed=>seed.sourceId===source.id)??[]]);
 for(const document of result.documents){const item=state.metadata[document.url];if(item){document.adapter='mv-bauleitplan';document.metadata.caseKey=item.caseKey;document.metadata.caseKeyType='source_document';}}
 if(!state.complete&&result.coverage){result.coverage.state='partial';result.coverage.runnableCount=(result.coverage.runnableCount??0)+1;result.coverage.pendingCount+=Math.max(1,(state.total??state.offset+1)-state.offset);notes.push('API cursor remains resumable; no completeness assertion');}
 result.requests+=requests;result.checkedAt=[result.checkedAt,state.evidence.at(-1)?.checkedAt].filter((value):value is string=>!!value).sort().at(-1)??null;result.notes.unshift(...notes);return result;
}
export async function crawlOparlSource(fetcher:PoliteFetcher,municipality:RegistryMunicipality,source:RegistrySource,options:AdapterOptions):Promise<AdapterResult>{
 if(!source.url)throw Error('No OParl endpoint');const startedRequests=fetcher.requestCount;
 await fetcher.initialize();
 const observed=new Map<string,SourceContentBinding>(),excludedDocuments:CrawlExcludedDocument[]=[];
 let lastApiCheck:string|null=null;
 const loaderOptions:Parameters<typeof createPoliteCouncilLoader>[1]={...sourceFetchOptions(source),municipalityName:municipality.name,maxRequests:options.maxRequests,onDocument:document=>{lastApiCheck=document.checkedAt;observed.set(document.url+'\n'+document.sha256,sourceContentBinding(document));},onExcluded:document=>{lastApiCheck=document.checkedAt;excludedDocuments.push(sourceDocument(document,municipality,source,'oparl'));}};
 const loader=createPoliteCouncilLoader(fetcher,loaderOptions);
 const system=await loader(source.url),value=system.data as {type?:string;body?:string};let bodies:OparlBody[]=[];
 if(/\/Body$/.test(value.type??''))bodies=[system.data as OparlBody];
 else{
  if(!/^https?:\/\/schema\.oparl\.org\/1\.[01]\/System$/.test(value.type??'')||typeof value.body!=='string')throw Error('Invalid OParl System');
  const folder=join(fetcher.cacheDir,'oparl-bodies');await mkdir(folder,{recursive:true});const path=join(folder,hash(source.url)+'.json');
  let inventory:{base:string;next:string|null;bodies:OparlBody[];visited:string[];checkedAt?:string;sourceBindings:SourceContentBinding[]};
  try{inventory=JSON.parse(await readDerivedText(fetcher,path));if(inventory.base!==value.body||!Array.isArray(inventory.sourceBindings))throw new PoliteFetchError('host_state_unsafe','OParl Body inventory requires managed provenance');await fetcher.assertSourceBindingsAllowed(inventory.sourceBindings);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;inventory={base:value.body,next:value.body,bodies:[],visited:[],sourceBindings:[]};}
  if(!inventory.next&&(!inventory.checkedAt||!Number.isFinite(Date.parse(inventory.checkedAt))||Date.now()-Date.parse(inventory.checkedAt)>=(options.revalidateAfterMs??DEFAULT_SOURCE_REVALIDATE_MS)))inventory={base:value.body,next:value.body,bodies:[],visited:[],sourceBindings:[]};
  for(let page=0;inventory.next&&page<options.maxPages&&fetcher.requestCount-startedRequests<options.maxRequests;page++){
   const next=inventory.next;if(inventory.visited.includes(next)||new URL(next).origin!==new URL(source.url).origin)throw Error('Unsafe OParl Body pagination');
   const response=await loader(next),parsed=parseOparlList<OparlBody>(response.data,next,'Body');inventory.bodies.push(...parsed.records);inventory.visited.push(next);inventory.next=parsed.next;inventory.checkedAt=response.checkedAt??response.retrievedAt;
   const binding=observed.get(response.url+'\n'+response.sha256);if(!binding)throw new PoliteFetchError('cache_missing','OParl Body page has no immutable observation');inventory.sourceBindings.push(binding);
   await fetcher.persistDerivedJson(path,inventory,inventory.sourceBindings);
  }
  for(const binding of inventory.sourceBindings)observed.set(binding.url+'\n'+binding.sha256,binding);
  if(inventory.next)return {documents:[],sourceBindings:[...observed.values()],notes:['OParl Body inventory incomplete; durable cursor retained, municipal binding withheld'],requests:fetcher.requestCount-startedRequests,checkedAt:lastApiCheck,coverage:{state:'partial',pendingCount:1,runnableCount:1,blockedCount:0,frontierPath:path,scope:'Observed OParl Body inventory'}};
  bodies=inventory.bodies;
 }
 // The shared selector only reads identity fields; geometry is intentionally absent, not fabricated.
 const body=selectCouncilBody(bodies,{id:municipality.id,name:municipality.name,councilBodyId:source.councilBodyId,councilBodyAliases:source.councilBodyAliases} as City);
 // Actual selected Body publisher context belongs only to its structured API,
 // never to independently fetched third-party attachments.
 loaderOptions.oparlBody={id:body.id,name:body.name};
 const seeds:SourceSeed[]=[],notes:string[]=[],activeOparlRecordIds=new Set<string>();let incompleteLists=0;
 for(const kind of ['paper','meeting'] as const){
  if(!body[kind])continue;
  await fetcher.assertHostAllowed(body[kind]!);
  const folder=join(fetcher.cacheDir,'oparl',hash(body.id),kind);await mkdir(folder,{recursive:true});
  const storage:CouncilStorage={
   async load(){try{return JSON.parse(await readFile(join(folder,'checkpoint.json'),'utf8')) as CouncilCheckpoint;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}},
   async readSegment(index){
    const segment=JSON.parse(await readDerivedText(fetcher,join(folder,`page-${index}.json`))) as CouncilSegment&{sourceBindings?:SourceContentBinding[]};
    if(!segment.sourceBindings?.length)throw new PoliteFetchError('host_state_unsafe','OParl segment lacks managed provenance');
    await fetcher.assertSourceBindingsAllowed(segment.sourceBindings);for(const binding of segment.sourceBindings)observed.set(binding.url+'\n'+binding.sha256,binding);return segment;
   },
   async checkpoint(state,segment){
    if(segment){
     const binding=observed.get(segment.evidence.url+'\n'+segment.evidence.sha256);if(!binding)throw new PoliteFetchError('cache_missing','OParl segment has no immutable source observation');
     await fetcher.persistDerivedJson(join(folder,`page-${state.segments-1}.json`),{...segment,sourceBindings:[binding]},[binding]);
    }
    await writeFile(join(folder,'checkpoint.tmp'),JSON.stringify(state));await rename(join(folder,'checkpoint.tmp'),join(folder,'checkpoint.json'));
   },
  };
  const excludedBefore=excludedDocuments.length;
  const traversal=await traverseCouncilList(body,kind,storage,loader,{maxPages:options.maxPages,reuseCompleteMs:options.revalidateAfterMs??DEFAULT_SOURCE_REVALIDATE_MS});
  if(traversal.state.error)notes.push(traversal.state.error);if(traversal.state.active){incompleteLists++;notes.push(`OParl ${kind} traversal incomplete; durable cursor retained`);}
  if(excludedDocuments.length>excludedBefore)continue;
  for(const {record} of traversal.records.values()){
   if(record.deleted)continue;activeOparlRecordIds.add(record.id);
   const metadata:CrawlDocument['metadata']={title:record.name??record.title,caseKey:record.reference??record.id,caseKeyType:'paper_reference',oparlRecordId:record.id,sourceVersion:record.modified};
   const documentDate=councilEventDate(record,kind)?.slice(0,10)??null;
   for(const file of [record.mainFile,...record.auxiliaryFile??[]])if(file?.downloadUrl)seeds.push({url:file.downloadUrl,sourceId:source.id,title:file.name??record.name,documentDate,adapter:'oparl',metadata});
   seeds.push({url:record.id,sourceId:source.id,title:record.name,documentDate,adapter:'oparl',metadata});
  }
 }
 const consumed=fetcher.requestCount-startedRequests;
 const result=await crawlHtmlSource(fetcher,municipality,{...source,registeredSourceUrl:source.registeredSourceUrl??source.url,url:null,crawlScope:{pageRoots:[],followLinkedDocuments:true}},{...options,maxRequests:Math.max(0,options.maxRequests-consumed),activeOparlRecordIds,discoveryBindings:mergeSourceBindings(options.discoveryBindings??[],[...observed.values()])},seeds);
 result.excludedDocuments=[...result.excludedDocuments??[],...excludedDocuments];
 for(const document of result.documents)if(document.metadata.oparlRecordId)document.metadata.caseKeyType='paper_reference';
 if(incompleteLists&&result.coverage){result.coverage.state='partial';result.coverage.runnableCount=(result.coverage.runnableCount??0)+incompleteLists;result.coverage.pendingCount+=incompleteLists;}
 result.requests+=consumed;result.checkedAt=[result.checkedAt,lastApiCheck].filter((value):value is string=>!!value).sort().at(-1)??null;result.notes.unshift(...notes);return result;
}
