import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import type {Signal} from './schema.ts';
export const root = new URL('../',import.meta.url).pathname;
export const cacheDir=join(root,'cache');
export const outDir=join(root,'out');
export const ua='StadtstackData/0.1 (public-data research; https://github.com/komma-systems/ccf; contact: data@stadtstack.org)';
export const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
export async function save(path:string,content:string|Uint8Array){await mkdir(dirname(path),{recursive:true});await writeFile(path,content);}
export async function jsonFile<T>(path:string):Promise<T|undefined>{try{return JSON.parse(await readFile(path,'utf8')) as T;}catch{return undefined;}}
export interface ResponseEvidence {body:Uint8Array;retrievedAt:string;sha256:string;url:string}
export const staleFetches:{url:string;error:string}[]=[];
export async function cachedFetch(url:string,ttlMs=86400000,options?:{method?:string;body?:string;timeout?:number}):Promise<ResponseEvidence>{
 const key=hash((options?.method??'GET')+url+(options?.body??''));const location=join(cacheDir,'http',key+'.json');const prior=await jsonFile<{body:string;retrievedAt:string;sha256:string}>(location);if(prior&&Date.now()-Date.parse(prior.retrievedAt)<ttlMs)return {body:Buffer.from(prior.body,'base64'),retrievedAt:prior.retrievedAt,sha256:prior.sha256,url};
 try{const res=await fetch(url,{method:options?.method??'GET',body:options?.body,headers:{'User-Agent':ua,...(options?.method==='POST'?{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'}:{})},signal:AbortSignal.timeout(options?.timeout??15000)});if(!res.ok)throw Error(`HTTP ${res.status} ${url}`);const body=new Uint8Array(await res.arrayBuffer());const record={body:Buffer.from(body).toString('base64'),retrievedAt:new Date().toISOString(),sha256:hash(body)};await save(location,JSON.stringify(record));return {body,retrievedAt:record.retrievedAt,sha256:record.sha256,url};}catch(error){if(prior){staleFetches.push({url,error:String(error)});return {body:Buffer.from(prior.body,'base64'),retrievedAt:prior.retrievedAt,sha256:prior.sha256,url};}throw error;}
}
export async function cachedJson<T>(url:string,ttl=86400000,options?:{method?:string;body?:string;timeout?:number}) {const evidence=await cachedFetch(url,ttl,options);return {...evidence,data:JSON.parse(Buffer.from(evidence.body).toString('utf8')) as T};}
export function signal(properties:Omit<Signal['properties'],'version'>,geometry:Signal['geometry']):Signal{
 const version=hash(JSON.stringify({id:properties.id,geometry,kind:properties.kind,category:properties.category,title:properties.title,statement:properties.statement,status:properties.status,startDate:properties.startDate,endDate:properties.endDate,nextStep:properties.nextStep,unknowns:properties.unknowns,scale:properties.scale,geometryPrecision:properties.geometryPrecision,sources:properties.sources.map(s=>({url:s.url,locator:s.locator,sha256:s.sha256,licence:s.licence,reuse:s.reuse}))}));return {type:'Feature',geometry,properties:{...properties,version}};
}
export function sourceFrom(e:ResponseEvidence,title:string,publisher:string,locator:string,licence='unknown',reuse:'open_licence'|'official_work'|'facts_with_attribution'|'unknown'='facts_with_attribution'){return {url:e.url,snapshotUrl:e.url,title,publisher,locator,retrievedAt:e.retrievedAt,sha256:e.sha256,snapshot:true,licence,reuse};}
export function sourceStatus(id:string,kind:string,publisher:string,url:string,reuse:'open_licence'|'official_work'|'facts_with_attribution'|'unknown',retrievedAt:string,status='ok',error?:string,licence='unknown'){return {id,kind,publisher,url,reuse,licence,retrievedAt,status,...(error?{error}:{})};}
