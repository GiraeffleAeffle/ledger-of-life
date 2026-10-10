import {isIP} from 'node:net';
import {signal} from './common.ts';
import {deduplicateCitySignals} from './dedupe.ts';
import type {Signal} from './schema.ts';
import {isPublicAddress} from './public-address.ts';

/** Lexical publication gate, not a DNS/SSRF firewall. Never echoes rejected URLs. */
export function publicUrlReason(value:string):string|null{
 let url:URL;try{url=new URL(value);}catch{return 'invalid_url';}
 if(!['https:','http:'].includes(url.protocol))return 'nonpublic_scheme';
 if(url.username||url.password)return 'credentials_in_url';
 for(const key of url.searchParams.keys())if(/^(?:token|access[-_]?token|refresh[-_]?token|(?:x[-_])?api[-_]?key|auth|authorization|password|passwd|secret|client[-_]?secret|signature|credential|x-amz-(?:signature|credential|security-token))$/i.test(key))return 'credentials_in_query';
 const host=url.hostname.toLowerCase().replace(/\.$/,'').replace(/^\[|\]$/g,'');
 if(!host||host==='localhost'||host.endsWith('.home.arpa')||!host.includes('.')&&isIP(host)!==6||/(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home|corp|private|onion|test|invalid|example)$/.test(host))return 'nonpublic_hostname';
 if(isIP(host)&&!isPublicAddress(host))return 'nonpublic_ip';
 return null;
}
export const isPublicUrl=(value:string)=>publicUrlReason(value)===null;
export type PublicUrlIssue={path:string;reason:string};
export function publicUrlIssues(value:unknown):PublicUrlIssue[]{
 const issues:PublicUrlIssue[]=[];
 const visit=(item:unknown,path:string,key:string)=>{
  if(typeof item==='string'){
   if(key==='feedUrl'&&/^cities\/[a-z0-9-]+\/feed[.]json$/.test(item)||key==='minUrl'&&/^cities\/[a-z0-9-]+\/signals[.]min[.]geojson$/.test(item))return;
   const candidates=/(?:url|uri|href|endpoint)$/i.test(key)?[item]:item.match(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+|\b(?:file|data|javascript):[^\s<>"']+/gi)??[];
   for(const candidate of candidates){const reason=publicUrlReason(candidate);if(reason)issues.push({path,reason});}
  }else if(Array.isArray(item))item.forEach((entry,index)=>visit(entry,`${path}[${index}]`,key));
  else if(item&&typeof item==='object')for(const [name,entry] of Object.entries(item))visit(entry,path?`${path}.${name}`:name,name);
 };
 visit(value,'','');return issues;
}
export function assertPublicUrls(value:unknown):void{
 const issues=publicUrlIssues(value);if(issues.length)throw Error(`Nonpublic publication URL at ${issues[0].path}: ${issues[0].reason} (${issues.length} issues)`);
}

/** Parse only a complete, valid source calendar day; numeric epochs require an explicit source unit. */
export function parseSourceDate(raw:unknown,epochUnit?:'milliseconds'|'seconds'):string|null{
 if(typeof raw==='number'){
  if(!epochUnit||!Number.isFinite(raw))return null;
  const date=new Date(raw*(epochUnit==='seconds'?1000:1));
  return Number.isFinite(date.getTime())?date.toISOString().slice(0,10):null;
 }
 if(typeof raw!=='string')return null;
 const text=raw.trim();
 const iso=text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:$|[T\s])/);
 const german=text.match(/^(\d{2})[.-](\d{2})[.-](\d{4})(?:$|[T\s])/);
 const parts=iso?[iso[1],iso[2],iso[3]]:german?[german[3],german[2],german[1]]:null;
 if(!parts)return null;
 const day=parts.join('-'),date=new Date(`${day}T00:00:00Z`);
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===day?day:null;
}

function sourceTemporal(raw:string|null):string|null{
 const day=parseSourceDate(raw);if(!day||!raw)return null;
 if(!raw.includes('T'))return day;
 // Keep sourced meeting precision and offset; do not turn a timed event into a day.
 return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(raw)&&Number.isFinite(Date.parse(raw))?raw:null;
}
export type QuarantinedSignal={id:string;cityId:string;reason:string};
/** Event/legal dates are mandatory for comparison signals; places retain observation/asOf semantics. */
export function normalizePublicationSignals(input:Signal[]):{features:Signal[];quarantined:QuarantinedSignal[];counts:{input:number;deduplicated:number;published:number;quarantined:number}}{
 assertPublicUrls(input);
 const valid:Signal[]=[],quarantined:QuarantinedSignal[]=[];
 for(const feature of input){
  const p=feature.properties,start=sourceTemporal(p.startDate),end=sourceTemporal(p.endDate);
  const observationReason=p.kind!=='place'?null:!p.asOf?'missing_observation_asof':!sourceTemporal(p.asOf)?'invalid_observation_asof':!p.sources.some(s=>sourceTemporal(s.retrievedAt))?'missing_sourced_observation_date':null;
  const reason=observationReason??(p.startDate!==null&&!start?'invalid_sourced_start_date':p.kind!=='place'&&!start?'missing_sourced_start_date':p.endDate!==null&&!end?'invalid_sourced_end_date':start&&end&&Date.parse(end)<Date.parse(start)?'end_before_start':null);
  if(reason){quarantined.push({id:p.id,cityId:p.cityId,reason});continue;}
  // Core versions are independently hash-bound by their release manifest.
  if(p.assertion&&p.verification){valid.push(feature);continue;}
  const {version:_,...properties}=p;
  valid.push(signal({...properties,startDate:start,endDate:end,temporalBasis:p.kind==='place'?'observation':'source_event'},feature.geometry));
 }
 const features=deduplicateCitySignals(valid);
 return {features,quarantined,counts:{input:input.length,deduplicated:features.length+quarantined.length,published:features.length,quarantined:quarantined.length}};
}
