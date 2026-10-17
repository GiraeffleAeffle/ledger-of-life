import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import type {Signal} from './schema.ts';
export const root = new URL('../',import.meta.url).pathname;
export const cacheDir=join(root,'cache');
export const outDir=join(root,'out');
export const ua='StadtstackData (civic public-data research; contact: https://stadtstack.eu/kontakt)';
export const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
export async function save(path:string,content:string|Uint8Array){await mkdir(dirname(path),{recursive:true});await writeFile(path,content);}
export async function jsonFile<T>(path:string):Promise<T|undefined>{try{return JSON.parse(await readFile(path,'utf8')) as T;}catch{return undefined;}}
export interface ResponseEvidence {body:Uint8Array;retrievedAt:string;sha256:string;url:string}
export function signal(properties:Omit<Signal['properties'],'version'>,geometry:Signal['geometry']):Signal{
 const version=hash(JSON.stringify({id:properties.id,geometry,kind:properties.kind,category:properties.category,title:properties.title,statement:properties.statement,status:properties.status,startDate:properties.startDate,endDate:properties.endDate,nextStep:properties.nextStep,unknowns:properties.unknowns,scale:properties.scale,geometryPrecision:properties.geometryPrecision,sources:properties.sources.map(s=>({url:s.url,locator:s.locator,sha256:s.sha256,licence:s.licence,reuse:s.reuse}))}));return {type:'Feature',geometry,properties:{...properties,version}};
}
export function sourceFrom(e:ResponseEvidence,title:string,publisher:string,locator:string,licence='unknown',reuse:'open_licence'|'official_work'|'facts_with_attribution'|'unknown'='facts_with_attribution'){return {url:e.url,snapshotUrl:e.url,title,publisher,locator,retrievedAt:e.retrievedAt,sha256:e.sha256,snapshot:true,licence,reuse};}
export function sourceStatus(id:string,kind:string,publisher:string,url:string,reuse:'open_licence'|'official_work'|'facts_with_attribution'|'unknown',retrievedAt:string,status='ok',error?:string,licence='unknown'){return {id,kind,publisher,url,reuse,licence,retrievedAt,status,...(error?{error}:{})};}
