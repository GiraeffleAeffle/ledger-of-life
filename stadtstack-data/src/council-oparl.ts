import type {City} from './cities.ts';
import {canonicalOparlUrl} from './dedupe.ts';

export type CouncilKind='paper'|'meeting';
export interface OparlListPage<T> {records:T[];next:string|null;total:number|null}
export interface OparlRecord {
 id:string; type?:string; body?:string; name?:string; title?:string; text?:string; description?:string;
 reference?:string; date?:string; start?:string; end?:string; created?:string; modified?:string; deleted?:boolean; license?:string;
 consultation?:{role?:string}[]; auxiliaryFile?:{mimeType?:string;downloadUrl?:string;name?:string}[];
 mainFile?:{mimeType?:string;downloadUrl?:string;name?:string}; location?:{description?:string};
}
export interface OparlBody {id:string;type?:string;name:string;paper?:string;meeting?:string;license?:string}
export interface OparlSystem {id?:string;type:string;body:string;name?:string;license?:string}
export interface CouncilEvidence {url:string;retrievedAt:string;checkedAt?:string;sha256:string}
export interface StoredCouncilRecord {record:OparlRecord;evidence:CouncilEvidence}
export interface CouncilWindow {start:string;end:string}
export function councilLicence(value?:string):{licence:string;reuse:'open_licence'|'facts_with_attribution'} {
 const licence=value&&/^https?:\/\//.test(value)?value:'unknown';
 const open=/^https?:\/\/(?:www\.)?govdata\.de\/dl-de\/(?:zero|by)-2-0\/?$/.test(licence)||/^https?:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/(?:2\.0|2\.5|3\.0|4\.0)|publicdomain\/zero\/1\.0)\/?$/.test(licence);
 return {licence,reuse:open?'open_licence':'facts_with_attribution'};
}
export interface CouncilCheckpoint {
 schemaVersion:1;bodyId:string;baseUrl:string;kind:CouncilKind;backfillComplete:boolean;
 // The watermark advances only when the entire (possibly resumed) traversal completes.
 watermark:string|null;filterSupport?:'unknown'|'supported'|'unsupported';filterSupportReason?:string;withdrawnIds?:string[];
 active:{mode:'backfill'|'incremental'|'refresh';startedAt:string;nextUrl:string;visited:string[];seenIds?:string[];seenCount?:number;expectedTotal?:number|null}|null;
 segments:number;pages:number;rawRecordCount:number;lastCheckedAt:string|null;error?:string;
}
const normalizedName=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('de');
export function bodyMatchesCity(bodyName:string,city:City):boolean {
 return [city.name,...city.councilBodyAliases??[]].some(name=>normalizedName(name)===normalizedName(bodyName));
}
export function bodyIdMatchesCity(bodyId:string,city:City):boolean {
 return !city.councilBodyId||canonicalOparlUrl(bodyId)===canonicalOparlUrl(city.councilBodyId);
}
export class CouncilBindingError extends Error {
 observedBodies:OparlBody[];
 constructor(city:City,bodies:OparlBody[]){
  super(`Council binding rejected for ${city.name}: expected exactly one matching Body; observed ${bodies.map(body=>`${body.name} (${body.id})`).join('; ')}`);
  this.name='CouncilBindingError';this.observedBodies=bodies;
 }
}
export function selectCouncilBody(bodies:OparlBody[],city:City):OparlBody {
 const matches=bodies.filter(body=>bodyMatchesCity(body.name,city)&&bodyIdMatchesCity(body.id,city));
 if(matches.length!==1)throw new CouncilBindingError(city,bodies);
 return matches[0];
}
export function councilWindow(now=new Date()):CouncilWindow {
 const start=new Date(now),month=start.getUTCMonth();start.setUTCMonth(month-24);
 if(start.getUTCMonth()!==month)start.setUTCDate(0); // Clamp leap day to February's actual final day.
 return {start:start.toISOString().slice(0,10),end:now.toISOString().slice(0,10)};
}
export function councilEventDate(record:OparlRecord,kind:CouncilKind):string|null {
 const value=kind==='meeting'?record.start:record.date;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value))return null;
 const day=value.slice(0,10),parsed=new Date(day+'T00:00:00Z');
 return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===day&&Number.isFinite(Date.parse(value))?value:null;
}
export function inCouncilWindow(record:OparlRecord,kind:CouncilKind,window:CouncilWindow):boolean {
 // Backfill has a two-year floor; retain already-published future announcements for the existing council calendar.
 const value=councilEventDate(record,kind);return !!value&&value.slice(0,10)>=window.start;
}
export function recordMatchesBody(record:OparlRecord,body:OparlBody):boolean {
 if(record.body)return canonicalOparlUrl(record.body)===canonicalOparlUrl(body.id);
 // A scoped object URL is useful for archive ownership; unscoped IDs need live-list membership instead.
 return canonicalOparlUrl(record.id).startsWith(canonicalOparlUrl(body.id)+'/');
}
export function parseOparlList<T extends {id:string;type?:string}>(value:unknown,url:string,kind:'Body'|'Paper'|'Meeting'):OparlListPage<T> {
 if(!value||typeof value!=='object'||!('data' in value)||!Array.isArray(value.data))throw Error(`Invalid OParl ${kind} list envelope at ${url}: data must be an array`);
 const envelope=value as {data:unknown[];links?:{next?:unknown};pagination?:{next?:unknown;currentPage?:number;totalPages?:number;totalElements?:number}};
 for(const record of envelope.data){
  if(!record||typeof record!=='object'||!('id' in record)||typeof record.id!=='string'||!('type' in record)||typeof record.type!=='string'||!new RegExp(`^https?://schema\\.oparl\\.org/1\\.[01]/${kind}$`).test(record.type))throw Error(`Invalid OParl ${kind} object at ${url}`);
  canonicalOparlUrl(record.id);
 }
 const link=envelope.links?.next??envelope.pagination?.next;
 if(link!==undefined&&link!==null&&typeof link!=='string')throw Error(`Invalid next-page URL at ${url}`);
 const next=typeof link==='string'&&link?canonicalOparlUrl(new URL(link,url).toString()):null;
 const pagination=envelope.pagination;
 if(!next&&pagination?.currentPage&&pagination.totalPages&&pagination.currentPage<pagination.totalPages)throw Error(`Missing next-page link before final page at ${url}`);
 return {records:envelope.data as T[],next,total:pagination?.totalElements??null};
}
export function incrementalCouncilUrl(base:string,watermark:string):string {
 const url=new URL(canonicalOparlUrl(base));
 // OParl 1.1 §2.7: include tombstones when modified_since is set. One-second overlap is idempotent.
 url.searchParams.set('modified_since',new Date(Date.parse(watermark)-1000).toISOString());
 return url.toString();
}
export function beginCouncilTraversal(state:CouncilCheckpoint,now:string):void {
 if(state.active)return;
 const mode=!state.backfillComplete?'backfill':state.filterSupport==='unsupported'?'refresh':'incremental';
 state.active={mode,startedAt:now,nextUrl:mode==='incremental'&&state.watermark?incrementalCouncilUrl(state.baseUrl,state.watermark):canonicalOparlUrl(state.baseUrl),visited:[],seenIds:[],seenCount:0,expectedTotal:null};
}
export function mergeCouncilRecords(target:Map<string,StoredCouncilRecord>,incoming:OparlRecord[],evidence:CouncilEvidence):void {
 for(const record of incoming){
  const key=canonicalOparlUrl(record.id),previous=target.get(key);
  const modified=Date.parse(record.modified??''),priorModified=Date.parse(previous?.record.modified??'');
  if(previous&&Number.isFinite(priorModified)&&(!Number.isFinite(modified)||modified<priorModified))continue;
  // Keep tombstones in the index: an older CCF archive must never resurrect a deleted object.
  target.set(key,{record,evidence});
 }
}
export function councilCoverage(records:Map<string,StoredCouncilRecord>,kind:CouncilKind,window:CouncilWindow,state:CouncilCheckpoint,checkedAt:string) {
 let recordCount=0,quarantined=0,futureRecordCount=0,observedStart:string|null=null,observedEnd:string|null=null;
 for(const {record} of records.values()){
  if(record.deleted)continue;
  const date=councilEventDate(record,kind);if(!date){quarantined++;continue;}
  if(!inCouncilWindow(record,kind,window))continue;
  recordCount++;const day=date.slice(0,10);if(day>window.end)futureRecordCount++;if(!observedStart||day<observedStart)observedStart=day;if(!observedEnd||day>observedEnd)observedEnd=day;
 }
 const reason=[state.error,state.filterSupport==='unsupported'?`${state.filterSupportReason??'Source ignores standard modified_since'}. Automatic full-list reconciliation, not incremental coverage; missing objects withdrawn only after a complete scan.`:null,state.active?`Resumable ${state.active.mode}: ${state.pages} pages fetched; cursor ${state.active.nextUrl}`:null,quarantined?`${quarantined} records quarantined: missing/invalid source event date (modified/retrieval time not substituted)`:null].filter(Boolean).join('; ');
 const coverageState=state.error&&records.size===0?'failed':state.error||state.active||!state.backfillComplete||quarantined?'partial':recordCount?'complete':'empty';
 return {recordCount,quarantined,coverage:{requestedStart:window.start,requestedEnd:window.end,includesScheduledFuture:true,futureRecordCount,observedStart,observedEnd,checkedAt,state:coverageState as 'failed'|'partial'|'complete'|'empty',...(reason?{reason}:{})}};
}
