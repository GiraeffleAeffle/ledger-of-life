import {rename,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cacheDir,hash,jsonFile,save} from './common.ts';
import {canonicalOparlUrl} from './dedupe.ts';
import {beginCouncilTraversal,mergeCouncilRecords,parseOparlList} from './council-oparl.ts';
import type {CouncilCheckpoint,CouncilEvidence,CouncilKind,OparlBody,OparlRecord,StoredCouncilRecord} from './council-oparl.ts';
import {PoliteFetcher,PoliteFetchError} from './polite-fetch.ts';

export interface CouncilSegment {records:OparlRecord[];evidence:CouncilEvidence;withdrawnIds?:string[]}
export interface CouncilStorage {
 load():Promise<CouncilCheckpoint|undefined>;
 readSegment(index:number):Promise<CouncilSegment>;
 checkpoint(state:CouncilCheckpoint,segment?:CouncilSegment):Promise<void>;
}
export type CouncilLoader=(url:string)=>Promise<CouncilEvidence&{data:unknown}>;
const councilFetcher=new PoliteFetcher({cacheDir:join(cacheDir,'council-fetch'),timeoutMs:45000});
export const loadCouncilJson:CouncilLoader=async url=>{
 for(let attempt=0;;attempt++){
  try{
   const response=await councilFetcher.fetch(canonicalOparlUrl(url));
   const body=await readFile(response.localPath);
   if(hash(body)!==response.sha256)throw Error('Council source cache digest mismatch');
   return {url:response.url,retrievedAt:response.retrievedAt,checkedAt:response.checkedAt,sha256:response.sha256,data:JSON.parse(body.toString('utf8'))};
  }catch(error){
   // Reconnect interrupted public GETs only. Policy, HTTP and integrity failures
   // remain failures; exhausted transient attempts leave the durable cursor intact.
   if(!(error instanceof PoliteFetchError)||!['network_error','timeout'].includes(error.failure)||attempt>=2)throw error;
   const pause=Promise.withResolvers<void>();setTimeout(pause.resolve,15_000*2**attempt);await pause.promise;
  }
 }
};
export function councilStorage(bodyId:string,kind:CouncilKind):CouncilStorage {
 const folder=join(cacheDir,'council',hash(canonicalOparlUrl(bodyId)),kind),statePath=join(folder,'checkpoint.json');
 return {
  load:()=>jsonFile<CouncilCheckpoint>(statePath),
  async readSegment(index){
   const segment=await jsonFile<CouncilSegment>(join(folder,`page-${index}.json`));
   if(!segment)throw Error(`Missing council cache segment ${index} for ${bodyId}/${kind}`);
   return segment;
  },
  async checkpoint(state,segment){
   // A page is durable before its cursor. An interrupted write replays that same page, never skips it.
   if(segment)await save(join(folder,`page-${state.segments-1}.json`),JSON.stringify(segment));
   await save(statePath+'.tmp',JSON.stringify(state));await rename(statePath+'.tmp',statePath);
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
export async function traverseCouncilList(body:OparlBody,kind:CouncilKind,storage:CouncilStorage,loader:CouncilLoader=loadCouncilJson,options:{maxPages?:number;now?:string;reuseCompleteMs?:number}={}):Promise<CouncilTraversalResult> {
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
