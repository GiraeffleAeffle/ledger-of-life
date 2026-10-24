import {z} from 'zod';
import {districtRegistrySchema,type DistrictRegistry} from './district-registry.ts';
import {readCsv} from './adapters/structured-tables.ts';
import {digest} from './district-adapter-contract.ts';

export const STRUCTURED_REGISTRY_VERSION='district-structured-registry-v1';
const familyAdapter:Record<number,string>={1:'genesis',2:'mastr',3:'zensus',4:'gtfs',5:'planning-wfs',6:'state-statistics',7:'education',8:'funding-operations',9:'procurement',10:'energy-atlas',11:'gauges',12:'council',13:'permit-notices',14:'municipal-finance',15:'sector-plans'};
const pilotAgs:Record<string,true>={'12064472':true,'12064227':true,'12064428':true,'01053100':true,'01053090':true,'01053116':true,'13076090':true,'13076108':true,'13076060':true};
export interface StructuredCatalogRoute {family:number;adapter:string;sourceId:string;municipalityId:string;ags:string;endpoint:string|null;catalogSha256:string;state:'not_checked';reason:string}
/** Catalog scope authorizes discovery targets only. It never assigns source rows to a town or grants distribution rights. */
export function registerStructuredCatalog(registryInput:unknown,catalogBytes:Uint8Array):{registry:DistrictRegistry;routes:StructuredCatalogRoute[];catalogSha256:string} {
 const registry=districtRegistrySchema.parse(registryInput),catalog=readCsv(catalogBytes,{delimiter:','}),header=catalog.rows[0].map(cell=>cell.raw),catalogSha256=digest(catalogBytes);
 for(const name of ['id','priority','ags','endpoint','licence','evidence_urls'])if(!header.includes(name))throw Error('Structured source catalog header mismatch');
 const rows=catalog.rows.slice(1).map(row=>Object.fromEntries(header.map((name,index)=>[name,row[index]?.raw??''])));
 const next=structuredClone(registry),routes:StructuredCatalogRoute[]=[];
 for(const row of rows){
  if(!/^([1-9]|1[0-5])$/.test(row.priority))continue;
  const family=Number(row.priority),agsScopes=row.ags.split(';').map(value=>value.trim()).filter(value=>/^(?:\d{2}|\d{5}|\d{8})$/.test(value));
  let endpoint:string|null=null;
  try{const url=new URL(row.endpoint.trim());if(!/\s/.test(row.endpoint.trim())&&!url.username&&!url.password&&['https:','http:'].includes(url.protocol))endpoint=url.href;}catch{/* A catalog discovery gap is not an invented endpoint. */}
  const evidenceUrls=row.evidence_urls.split(/;\s*(?=https?:\/\/)/).map(value=>value.trim()).filter(value=>z.url().safeParse(value).success);
  for(const city of next.municipalities){
   if(!pilotAgs[city.ags]||!agsScopes.some(prefix=>city.ags.startsWith(prefix)))continue;
   const reason=`R1 catalog family ${family}: discovery route only; exact distribution access, origin, schema and municipal completeness not checked by this run.`;
   routes.push({family,adapter:familyAdapter[family],sourceId:row.id,municipalityId:city.id,ags:city.ags,endpoint,catalogSha256,state:'not_checked',reason});
   if(city.sources.some(source=>source.id===row.id))continue;
   const source={id:row.id,kind:'structured',url:endpoint,vendor:'other',checkState:'not_checked',checkedAt:null,evidence:evidenceUrls.map(url=>({url,locator:`Catalog family ${family}; discovery evidence only; catalog sha256:${catalogSha256}`})),reason,rights:{licence:row.licence,reuse:'facts_with_attribution',checkState:'not_checked',checkedAt:null,evidence:[],reason:'Catalog description is not document-specific admission.'},crawlScope:{pageRoots:[],followLinkedDocuments:false}};
   // Parse the complete new registry below; do not cast an unchecked row into the live source schema.
   (city.sources as unknown[]).push(source);
  }
 }
 return {registry:districtRegistrySchema.parse(next),routes:routes.sort((a,b)=>a.family-b.family||a.municipalityId.localeCompare(b.municipalityId)||a.sourceId.localeCompare(b.sourceId)),catalogSha256};
}
