import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {PoliteFetcher,PoliteFetchError,publicUrl} from './polite-fetch.ts';

const url=z.string().url().refine(value=>{try{publicUrl(value);return true;}catch{return false;}},'Expected a public, credential-free HTTP URL');
const timestamp=z.string().datetime({offset:true});
const evidenceSchema=z.object({url,locator:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),retrievedAt:timestamp.optional()});
const checkState=z.enum(['checked','not_found','not_checked']);
const kind=z.enum(['council','participation','gazette','website']);
export const districtSourceSchema=z.object({
 id:z.string().min(1),kind,url:url.nullable(),vendor:z.enum(['oparl','allris','sessionnet','somacos','other','unknown']),
 checkState,checkedAt:timestamp.nullable(),evidence:z.array(evidenceSchema),reason:z.string().optional(),
 api:z.object({url,method:z.enum(['GET','POST']).optional(),form:z.record(z.string(),z.string()).optional(),format:z.enum(['diplan-list','bobsh-list','mv-bauleitplan'])}).optional(),
 rights:z.object({licence:z.string(),reuse:z.literal('facts_with_attribution'),checkState,checkedAt:timestamp.nullable(),evidence:z.array(evidenceSchema),reason:z.string().optional()}).optional(),
 robots:z.object({url,checkState,checkedAt:timestamp.nullable(),evidence:z.array(evidenceSchema),reason:z.string().optional()}).optional(),
 contentCheck:z.object({checkState,checkedAt:timestamp.nullable(),evidence:z.array(evidenceSchema),reason:z.string()}).optional(),
 legalBasis:z.object({classification:z.enum(['section_5_official_act_candidate','section_44b_tdm_candidate','unassessed']),checkState,checkedAt:timestamp.nullable(),evidence:z.array(evidenceSchema),reason:z.string()}).optional(),
 tdm:z.object({status:z.enum(['not_checked','reservation_detected','none_detected','inaccessible']),checkedAt:timestamp.nullable(),evidence:z.array(evidenceSchema),reason:z.string()}).optional(),
 knownMachinePolicyUrls:z.array(url).optional(),
 crawlScope:z.object({pageRoots:z.array(url),followLinkedDocuments:z.boolean()}).optional(),
}).superRefine((source,ctx)=>{
 if(source.checkState==='checked'&&(!source.url||!source.checkedAt||!source.evidence.length))ctx.addIssue({code:'custom',message:'Checked sources require URL, timestamp and evidence'});
 if(source.checkState==='not_found'&&(!source.checkedAt||!source.reason||!source.evidence.length))ctx.addIssue({code:'custom',message:'Not-found requires a scoped search reason and evidence; fetch failures are not absence'});
 if(source.checkState==='not_checked'&&!source.reason)ctx.addIssue({code:'custom',message:'Unchecked sources require a reason'});
});
const municipalitySchema=z.object({
 id:z.string().min(1),name:z.string().min(1),ags:z.string().regex(/^\d{8}$/),districtId:z.string().min(1),districtAgs:z.string().regex(/^\d{5}$/),
 amt:z.object({id:z.string().min(1),name:z.string().min(1),sourceUrl:url}).nullable(),
 administrativeStatus:z.enum(['amtsfrei','amtsangehoerig']),administrativeEvidence:z.array(evidenceSchema).min(1),
 identitySources:z.array(evidenceSchema.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/),retrievedAt:timestamp})).min(1),
 sources:z.array(districtSourceSchema).min(4),
 seedDocuments:z.array(z.object({url,sourceId:z.string().min(1),title:z.string().min(1),documentDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),dateReason:z.string().optional(),evidence:z.array(evidenceSchema).min(1)})).min(1),
}).superRefine((m,ctx)=>{
 if(m.ags.slice(0,5)!==m.districtAgs)ctx.addIssue({code:'custom',message:'Municipality AGS does not belong to district'});
 if((m.amt===null)!==(m.administrativeStatus==='amtsfrei'))ctx.addIssue({code:'custom',message:'Amt membership contradicts administrative status'});
 const ids=new Set(m.sources.map(s=>s.id));
 if(ids.size!==m.sources.length)ctx.addIssue({code:'custom',message:'Duplicate source ID'});
 for(const k of kind.options)if(!m.sources.some(s=>s.kind===k))ctx.addIssue({code:'custom',message:`Missing explicit ${k} source category`});
 for(const seed of m.seedDocuments){
  if(!ids.has(seed.sourceId))ctx.addIssue({code:'custom',message:`Unbound seed ${seed.sourceId}`});
  if(seed.documentDate===null&&!seed.dateReason)ctx.addIssue({code:'custom',message:'Unknown document dates need a reason; retrieval time is not document time'});
 }
});
export const districtRegistrySchema=z.object({
 schemaVersion:z.literal('stadtstack-source-registry-v1'),generatedAt:timestamp,
 districts:z.array(z.object({id:z.string().min(1),name:z.string().min(1),ags:z.string().regex(/^\d{5}$/),state:z.string().min(1),inventorySources:z.array(evidenceSchema).min(1),inventoryAsOf:z.string(),inventoryComplete:z.boolean(),inventoryReason:z.string().optional()})).min(1),
 municipalities:z.array(municipalitySchema).min(1),
 inventory:z.array(z.object({ags:z.string().regex(/^\d{8}$/),name:z.string().min(1),districtId:z.string(),identitySourceUrl:url,administrativeLabel:z.string().optional(),pilot:z.boolean(),sourceCheckState:checkState,reason:z.string()})),
 notes:z.array(z.string()),
}).superRefine((registry,ctx)=>{
 const districts=new Map(registry.districts.map(d=>[d.id,d]));
 if(districts.size!==registry.districts.length)ctx.addIssue({code:'custom',message:'Duplicate district ID'});
 for(const field of ['id','ags'] as const)if(new Set(registry.municipalities.map(m=>m[field])).size!==registry.municipalities.length)ctx.addIssue({code:'custom',message:`Duplicate municipality ${field}`});
 const inventoryAgs=new Set<string>();
 for(const item of registry.inventory){
  if(inventoryAgs.has(item.ags)||!districts.has(item.districtId)||item.ags.slice(0,5)!==districts.get(item.districtId)?.ags)ctx.addIssue({code:'custom',message:`Invalid inventory identity ${item.ags}`});
  inventoryAgs.add(item.ags);
 }
 for(const m of registry.municipalities){
  if(districts.get(m.districtId)?.ags!==m.districtAgs||!registry.inventory.some(i=>i.ags===m.ags&&i.pilot&&i.districtId===m.districtId))ctx.addIssue({code:'custom',message:`Unbound municipality ${m.id}`});
 }
});
export type DistrictRegistry=z.infer<typeof districtRegistrySchema>;
export async function loadDistrictRegistry(path='sources/district-registry.json'):Promise<DistrictRegistry>{return districtRegistrySchema.parse(JSON.parse(await readFile(path,'utf8')));}

/** Refreshes configured endpoints only. It does not infer municipal absence from a failed request,
 * discover OParl by guessing paths, or turn registry reachability into extracted-fact approval. */
export async function refreshDistrictRegistry(registry:DistrictRegistry,cacheDir='cache/registry-refresh'):Promise<DistrictRegistry>{
 const next=structuredClone(registry),fetcher=new PoliteFetcher({cacheDir});
 for(const municipality of next.municipalities)for(const source of municipality.sources){
  if(!source.url)continue;
  try{
   const observed=await fetcher.fetch(source.url);
   source.evidence=[...source.evidence.filter(e=>!e.locator.startsWith('Endpoint refresh:')),{
    url:observed.url,locator:`Endpoint refresh: HTTP ${observed.status}; configured ${source.kind} endpoint retrieved; no content licence or extraction approval inferred`,sha256:observed.sha256,retrievedAt:observed.retrievedAt,
   }];
   source.checkedAt=observed.checkedAt;
   // Reachability alone cannot establish a municipality's use of a generic portal
   // or turn an ALLRIS login page into a public proceedings archive.
   if(source.checkState==='checked')source.reason='Configured endpoint retrieved through robots-aware, bounded public fetch. Documentary evidence and source category remain separately attributed.';
  }catch(error){
   source.checkState='not_checked';source.checkedAt=new Date().toISOString();
   source.reason=error instanceof PoliteFetchError?`Refresh inaccessible: ${error.failure}${error.status?` (HTTP ${error.status})`:''}; not evidence that the source does not exist`:'Refresh failed; prior discovery evidence retained, source existence not disproved';
  }
 }
 next.generatedAt=new Date().toISOString();return districtRegistrySchema.parse(next);
}
async function main(){
 const args=process.argv.slice(2),command=args.shift()??'validate';
 if(!['validate','refresh'].includes(command))throw Error('Usage: district-registry.ts validate|refresh [--registry PATH] [--out PATH] [--cache PATH]');
 const options:Record<string,string>={};
 while(args.length){const key=args.shift()!,value=args.shift();if(!['--registry','--out','--cache'].includes(key)||!value)throw Error('Invalid registry option');options[key]=value;}
 const registry=await loadDistrictRegistry(options['--registry']);
 if(command==='refresh'){
  const refreshed=await refreshDistrictRegistry(registry,options['--cache']),target=resolve(options['--out']??'cache/registry-refresh/registry.json');
  await mkdir(dirname(target),{recursive:true});const temporary=target+`.${process.pid}.tmp`;await writeFile(temporary,JSON.stringify(refreshed,null,2)+'\n');await rename(temporary,target);
  console.log(JSON.stringify({schemaVersion:refreshed.schemaVersion,municipalities:refreshed.municipalities.length,out:target}));
 }else console.log(JSON.stringify({schemaVersion:registry.schemaVersion,districts:registry.districts.length,municipalities:registry.municipalities.length,inventory:registry.inventory.length,sources:registry.municipalities.reduce((n,m)=>n+m.sources.length,0)}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error instanceof z.ZodError?error.message:error instanceof Error?error.message:'Registry command failed');process.exitCode=1;});
