import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cacheDir,hash} from './common.ts';
import {canonicalOparlUrl} from './dedupe.ts';
import {beginCouncilTraversal,bodyIdMatchesCity,mergeCouncilRecords,parseOparlList,selectCouncilBody} from './council-oparl.ts';
import type {CouncilCheckpoint,CouncilEvidence,CouncilKind,OparlBody,OparlRecord,StoredCouncilRecord} from './council-oparl.ts';
import {PoliteFetcher,PoliteFetchError,sourceContentBinding} from './polite-fetch.ts';
import type {FetchedDocument,ExcludedDocument,FetchOptions,SourceContentBinding,FixturePolicyInspection} from './polite-fetch.ts';
import {cities,type City} from './cities.ts';
import {APPROVED_OWNER_ROBOTS_OVERRIDE,ownerRobotsOverrideFor} from './source-policy.ts';
import {writePrivateJson} from './district-private-io.ts';
import {HostOptedOutError,CivicPolicyStateError,CIVIC_POLICY_AUTHORITY,type CivicPolicyOptions} from './civic-opt-out.ts';

export interface CouncilSegment {records:OparlRecord[];evidence:CouncilEvidence;withdrawnIds?:string[]}
export interface CouncilStorage {
 load():Promise<CouncilCheckpoint|undefined>;
 readSegment(index:number):Promise<CouncilSegment>;
 checkpoint(state:CouncilCheckpoint,segment?:CouncilSegment):Promise<void>;
}
export type CouncilLoader=(url:string)=>Promise<CouncilEvidence&{data:unknown}>;
/** Shared loader: no stale fallback or hidden reconnect loop; durable traversal owns resume. */
export function createPoliteCouncilLoader(fetcher:PoliteFetcher,options:FetchOptions&{maxRequests:number;oparlBody?:{id:string;name:string};onDocument?:(document:FetchedDocument)=>void|Promise<void>;onExcluded?:(document:ExcludedDocument)=>void|Promise<void>}):CouncilLoader {
 const startedRequests=fetcher.requestCount;
 return async url=>{
  await fetcher.initialize();
  if(fetcher.requestCount-startedRequests>=options.maxRequests)throw Error('OParl request budget exhausted');
  try{
   const response=await fetcher.fetch(url,{ownerRobotsOverride:options.ownerRobotsOverride,registeredSourceUrl:options.registeredSourceUrl,machinePolicyUrls:options.machinePolicyUrls,hostProfile:options.hostProfile??'municipal',municipalityName:options.municipalityName,...(options.oparlBody?{oparlContext:{bodyId:options.oparlBody.id,bodyName:options.oparlBody.name,apiUrl:url}}:{})});
   await fetcher.assertSourceReadable(response.localPath,response.url);
   await fetcher.assertSourceBindingsAllowed([sourceContentBinding(response)]);
   const bytes=await readFile(response.localPath);
   if(hash(bytes)!==response.sha256)throw Error('Council source cache digest mismatch');
   await fetcher.assertSourceReadable(response.localPath,response.url);
   const data:unknown=JSON.parse(bytes.toString('utf8'));
   await options.onDocument?.(response);
   return {url:response.url,sha256:response.sha256,retrievedAt:response.retrievedAt,checkedAt:response.checkedAt,data};
  }catch(error){if(error instanceof PoliteFetchError&&error.excludedDocument)await options.onExcluded?.(error.excludedDocument);throw error;}
 };
}
export interface CouncilAcquisition {
 cityId:string;registeredSourceUrl:string;fetcher:PoliteFetcher;loadJson:CouncilLoader;
 loadText(url:string):Promise<CouncilEvidence&{text:string}>;
 bindBody(body:OparlBody):void;
 storage(bodyId:string,kind:CouncilKind):CouncilStorage;
 persistCollection(name:'collection.json'|'signals.geojson',value:unknown):Promise<string>;
}
/** The City registry—not a caller-selected host or directory name—supplies civic context. */
export function createCouncilAcquisition(city:City,options:{cacheRoot?:string;policy?:CivicPolicyOptions;fixtureInspection?:FixturePolicyInspection}={}):CouncilAcquisition {
 const registered=cities.find(item=>item.id===city.id);
 if(!registered?.endpoint||!city.endpoint||canonicalOparlUrl(city.endpoint)!==canonicalOparlUrl(registered.endpoint))throw Error('Council acquisition requires a registered City endpoint');
 const registeredSourceUrl=canonicalOparlUrl(registered.endpoint),ownerRobotsOverride=ownerRobotsOverrideFor(registeredSourceUrl);
 if(!ownerRobotsOverride)throw Error('Council acquisition endpoint is not a public source');
 const fetcher=new PoliteFetcher({cacheDir:options.cacheRoot??join(cacheDir,'council','owner-policy-2026-10-11'),timeoutMs:45000,ownerPolicyLane:{decisionId:APPROVED_OWNER_ROBOTS_OVERRIDE.id,...(options.policy??CIVIC_POLICY_AUTHORITY)},fixtureInspection:options.fixtureInspection});
 const observed=new Map<string,SourceContentBinding>(),scope:FetchOptions={registeredSourceUrl,ownerRobotsOverride,hostProfile:'municipal',municipalityName:registered.name};
 const loaderOptions:Parameters<typeof createPoliteCouncilLoader>[1]={...scope,maxRequests:100_000,onDocument:document=>{observed.set(document.url+'\n'+document.sha256,sourceContentBinding(document));}};
 const loadJson=createPoliteCouncilLoader(fetcher,loaderOptions);
 return {
  cityId:registered.id,registeredSourceUrl,fetcher,
  loadJson:url=>loadJson(canonicalOparlUrl(url)),
  bindBody(body){selectCouncilBody([body],registered);loaderOptions.oparlBody={id:body.id,name:body.name};},
  async loadText(url){
   await fetcher.initialize();
   // Body publisher evidence is for its typed OParl API, not unrelated licence pages.
   const response=await fetcher.fetch(url,scope);
   await fetcher.assertSourceReadable(response.localPath,response.url);
   await fetcher.assertSourceBindingsAllowed([sourceContentBinding(response)]);
   const bytes=await readFile(response.localPath);
   if(hash(bytes)!==response.sha256)throw Error('Council source cache digest mismatch');
   await fetcher.assertSourceReadable(response.localPath,response.url);
   observed.set(response.url+'\n'+response.sha256,sourceContentBinding(response));
   return {url:response.url,retrievedAt:response.retrievedAt,checkedAt:response.checkedAt,sha256:response.sha256,text:bytes.toString('utf8')};
  },
  async persistCollection(name,value){
   const path=join(fetcher.cacheDir,'collections',registered.id+'-'+name);
   await fetcher.persistDerivedJson(path,value,[...observed.values()]);
   return path;
  },
  storage(bodyId,kind){
   if(!bodyIdMatchesCity(bodyId,registered))throw Error('Council cache Body differs from the registered City');
   const folder=join(fetcher.cacheDir,'oparl',hash(canonicalOparlUrl(bodyId)),kind),statePath=join(folder,'checkpoint.json');
   return {
    async load(){
     await fetcher.initialize();await fetcher.assertHostAllowed(registeredSourceUrl);await fetcher.assertHostAllowed(bodyId);
     try{
      const state=JSON.parse(await readFile(statePath,'utf8')) as CouncilCheckpoint;
      if(state.schemaVersion!==1||canonicalOparlUrl(state.bodyId)!==canonicalOparlUrl(bodyId)||state.kind!==kind)throw Error('Council checkpoint source binding mismatch');
      await fetcher.assertHostAllowed(state.baseUrl);return state;
     }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    },
    async readSegment(index){
     await fetcher.initialize();await fetcher.assertHostAllowed(registeredSourceUrl);await fetcher.assertHostAllowed(bodyId);
     if(!Number.isInteger(index)||index<0)throw Error('Invalid council cache segment index');
     const path=join(folder,`page-${index}.json`);
     await fetcher.assertSourceReadable(path);
     const segment=JSON.parse(await readFile(path,'utf8')) as CouncilSegment&{sourceBindings?:SourceContentBinding[]};
     if(!Array.isArray(segment.records)||!segment.sourceBindings?.length||!segment.sourceBindings.some(binding=>binding.url===segment.evidence?.url&&binding.sha256===segment.evidence?.sha256))throw new PoliteFetchError('cache_missing','Council segment lacks bound managed provenance');
     await fetcher.assertSourceBindingsAllowed(segment.sourceBindings);
     await fetcher.assertSourceReadable(path);
     for(const binding of segment.sourceBindings)observed.set(binding.url+'\n'+binding.sha256,binding);
     return segment;
    },
    async checkpoint(state,segment){
     await fetcher.initialize();await fetcher.assertHostAllowed(registeredSourceUrl);await fetcher.assertHostAllowed(bodyId);
     if(canonicalOparlUrl(state.bodyId)!==canonicalOparlUrl(bodyId)||state.kind!==kind)throw Error('Council checkpoint source binding mismatch');
     // A managed page is durable before its metadata cursor; interruption replays it.
     if(segment){
      const binding=observed.get(segment.evidence.url+'\n'+segment.evidence.sha256);
      if(!binding)throw new PoliteFetchError('cache_missing','Council segment has no immutable source observation');
      await fetcher.persistDerivedJson(join(folder,`page-${state.segments-1}.json`),{...segment,sourceBindings:[binding]},[binding]);
     }
     await writePrivateJson(statePath,state);
    },
   };
  },
 };
}
export async function loadCouncilIndex(storage:CouncilStorage,state:CouncilCheckpoint):Promise<Map<string,StoredCouncilRecord>> {
 const records=new Map<string,StoredCouncilRecord>();
 for(let index=0;index<state.segments;index++){
  const segment=await storage.readSegment(index);mergeCouncilRecords(records,segment.records,segment.evidence);
  for(const id of segment.withdrawnIds??[])records.delete(id);
 }
 return records;
}
export interface CouncilTraversalResult {state:CouncilCheckpoint;records:Map<string,StoredCouncilRecord>;fetchedPages:number;fetchedRecords:number}
/** Permission loss must never become an availability-only partial-results fallback. */
export function isCouncilPermissionFailure(error:unknown):boolean {
 if(error instanceof HostOptedOutError||error instanceof CivicPolicyStateError)return true;
 if(error instanceof AggregateError)return error.errors.some(isCouncilPermissionFailure);
 return error instanceof PoliteFetchError&&(error.policyPhase!==null||['robots_blocked','robots_unavailable','tdm_reserved','tdm_unavailable','access_barrier','document_excluded','host_opted_out','host_state_unsafe','unsafe_url','cross_host_redirect'].includes(error.failure)||error.status===401||error.status===403);
}
export async function traverseCouncilList(body:OparlBody,kind:CouncilKind,storage:CouncilStorage,loader:CouncilLoader,options:{maxPages?:number;now?:string;reuseCompleteMs?:number}={}):Promise<CouncilTraversalResult> {
 const base=body[kind];if(!base)throw Error(`Missing ${kind} list for ${body.id}`);
 const maxPages=options.maxPages??50;if(!Number.isInteger(maxPages)||maxPages<1)throw Error('Council page budget must be a positive integer');
 let state=await storage.load();
 if(state&&(state.schemaVersion!==1||canonicalOparlUrl(state.bodyId)!==canonicalOparlUrl(body.id)||canonicalOparlUrl(state.baseUrl)!==canonicalOparlUrl(base)||state.kind!==kind))throw Error(`Council cache binding mismatch for ${body.id}/${kind}`);
 state??={schemaVersion:1,bodyId:body.id,baseUrl:base,kind,backfillComplete:false,watermark:null,active:null,segments:0,pages:0,rawRecordCount:0,lastCheckedAt:null};
 const records=await loadCouncilIndex(storage,state),now=options.now??new Date().toISOString();
 const reuse=options.reuseCompleteMs??0,age=state.lastCheckedAt?Date.parse(now)-Date.parse(state.lastCheckedAt):Infinity;
 if(!Number.isFinite(reuse)||reuse<0)throw Error('Invalid completed-inventory reuse policy');
 if(reuse>0&&state.backfillComplete&&!state.active&&!state.error&&age>=0&&age<reuse)return {state,records,fetchedPages:0,fetchedRecords:0};
 if(state.active&&!state.active.seenIds){
  // Resume checkpoints made before full-refresh accounting was introduced.
  const priorSeen=new Set<string>();state.active.seenCount=0;
  for(let index=state.segments-state.active.visited.length;index<state.segments;index++){
   const segment=await storage.readSegment(index);state.active.seenCount+=segment.records.length;
   for(const record of segment.records)priorSeen.add(canonicalOparlUrl(record.id));
  }
  state.active.seenIds=[...priorSeen];
 }
 beginCouncilTraversal(state,now);delete state.error;
 let fetchedPages=0,fetchedRecords=0;
 let seen=new Set(state.active!.seenIds??[]);
 while(state.active&&fetchedPages<maxPages){
  const active=state.active,url=active.nextUrl;
  try{
   if(active.visited.includes(url))throw Error(`OParl pagination cycle at ${url}`);
   const response=await loader(url),page=parseOparlList<OparlRecord>(response.data,url,kind==='paper'?'Paper':'Meeting');
   if(active.mode==='incremental'&&state.watermark){
    const since=Date.parse(state.watermark)-1000;
    if(page.records.some(record=>!Number.isFinite(Date.parse(record.modified??''))||Date.parse(record.modified!)<since)){
     state.filterSupport='unsupported';state.watermark=null;state.lastCheckedAt=response.checkedAt??response.retrievedAt;
     state.filterSupportReason='Source ignores standard modified_since (older/undated modifications returned)';
     state.active={mode:'refresh',startedAt:now,nextUrl:canonicalOparlUrl(base),visited:[],seenIds:[],seenCount:0,expectedTotal:null};
     seen.clear();fetchedPages++;await storage.checkpoint(state);continue;
    }
   }
   for(const record of page.records){
    if(record.body&&canonicalOparlUrl(record.body)!==canonicalOparlUrl(body.id))throw Error(`Wrong Body ${record.body} on ${record.id}; expected ${body.id}`);
    if(new URL(canonicalOparlUrl(record.id)).origin!==new URL(canonicalOparlUrl(body.id)).origin)throw Error(`Foreign council object ${record.id} on ${body.id}`);
   }
   if(page.next&&new URL(page.next).origin!==new URL(canonicalOparlUrl(base)).origin)throw Error(`Foreign council pagination link ${page.next}`);
   if(page.next&&active.visited.includes(page.next))throw Error(`OParl pagination cycle at ${page.next}`);
   const evidence={url:response.url,retrievedAt:response.retrievedAt,checkedAt:response.checkedAt,sha256:response.sha256};
   mergeCouncilRecords(records,page.records,evidence);active.visited.push(url);
   for(const record of page.records){const id=canonicalOparlUrl(record.id);if(!seen.has(id)){seen.add(id);(active.seenIds??=[]).push(id);}}
   active.seenCount=(active.seenCount??0)+page.records.length;if(page.total!==null)active.expectedTotal=page.total;
   state.segments++;state.pages++;state.rawRecordCount+=page.records.length;state.lastCheckedAt=response.checkedAt??response.retrievedAt;
   fetchedPages++;fetchedRecords+=page.records.length;
   let withdrawnIds:string[]|undefined;
   if(page.next)active.nextUrl=page.next;
   else if(active.mode!=='incremental'&&(active.seenCount!==seen.size||active.expectedTotal!=null&&seen.size!==active.expectedTotal)){
    // Repeated IDs can conceal omitted objects even when raw row counts match.
    state.error=`Full-list count changed or truncated: observed ${active.seenCount} rows/${seen.size} unique IDs, advertised ${active.expectedTotal}; retained prior rows and restarted bounded traversal.`;
    state.active={mode:active.mode,startedAt:now,nextUrl:canonicalOparlUrl(base),visited:[],seenIds:[],seenCount:0,expectedTotal:null};
   }else{
    if(active.mode!=='incremental'){
     withdrawnIds=[...records.keys()].filter(id=>!seen.has(id));
     for(const id of withdrawnIds)records.delete(id);
     state.withdrawnIds=[...new Set([...(state.withdrawnIds??[]).filter(id=>!seen.has(id)),...withdrawnIds])];
    }else if(active.mode==='incremental')state.filterSupport='supported';
    state.backfillComplete=true;state.watermark=active.mode==='refresh'?null:active.startedAt;state.active=null;
   }
   await storage.checkpoint(state,{records:page.records,evidence,...(withdrawnIds?{withdrawnIds}:{})});
   if(state.error)break;
  }catch(error){
   if(isCouncilPermissionFailure(error)){
    records.clear();state.error='Current source permission blocks council records and cached reuse';
    try{await storage.checkpoint(state);}
    catch(checkpointError){throw new AggregateError([error,checkpointError],'Council permission denial could not be checkpointed');}
    throw error;
   }
   if(active.mode==='incremental'&&/\bHTTP (?:400|404|405|422|501)\b/.test(String(error))){
    // A rejected filter is never an empty list. Reconcile the verified base list instead.
    state.filterSupport='unsupported';state.filterSupportReason=`Standard modified_since request rejected: ${String(error)}; not interpreted as empty`;
    state.watermark=null;state.active={mode:'refresh',startedAt:now,nextUrl:canonicalOparlUrl(base),visited:[],seenIds:[],seenCount:0,expectedTotal:null};
    seen.clear();fetchedPages++;await storage.checkpoint(state);continue;
   }
   state.error=String(error);await storage.checkpoint(state);break;
  }
 }
 return {state,records,fetchedPages,fetchedRecords};
}
