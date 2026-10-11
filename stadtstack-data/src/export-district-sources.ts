import {readFile,readdir,realpath,mkdir,writeFile,lstat} from 'node:fs/promises';
import {resolve,join,dirname,basename,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {districtRegistrySchema} from './district-registry.ts';
import type {DistrictRegistry} from './district-registry.ts';
import {districtSourceAdapterKind} from './district-crawl.ts';
import {publicUrl} from './polite-fetch.ts';
import {publicUrlReason} from './publication-quality.ts';

const stamp=z.string().datetime({offset:true});
const policySchema=z.object({robots:z.object({state:z.enum(['allowed','blocked','unavailable'])}),tdm:z.object({state:z.enum(['reserved','not_reserved','not_declared','unavailable'])})});
const indexSchema=z.object({schemaVersion:z.literal('stadtstack-crawl-index-v1'),generatedAt:stamp,
 documents:z.array(z.object({municipalityId:z.string(),sourceId:z.string(),url:z.string(),adapter:z.string()})),
 checks:z.array(z.object({municipalityId:z.string(),sourceId:z.string(),checkState:z.enum(['checked','not_found','not_checked']),checkedAt:stamp.nullable(),documentCount:z.number().int().nonnegative(),outcome:z.enum(['documents_collected','no_documents','partial','blocked','failed','not_checked','registry_not_found']).optional(),coverage:z.object({state:z.enum(['complete','partial','blocked'])}).optional(),blocked:z.array(z.object({url:z.string()})).optional()}))});
const observationSchema=z.object({url:z.string(),checkedAt:stamp,retrievedAt:stamp.nullable(),state:z.enum(['fetched','not_modified','redirected','failed']),status:z.number().int().optional(),failure:z.string().optional(),policy:policySchema.optional()});
type Observation=z.infer<typeof observationSchema>;
export interface SourceExportRow {
 rowType:'url_occurrence'|'source'|'fetch_observation';pointer:string;occurrence:number|null;role:string;url:string|null;
 districtId:string;municipalityId:string;ags:string;sourceId:string;configuredAdapter:string;registryCheck:string;registryCheckedAt:string;
 districtName:string;districtAgs:string;municipalityName:string;administrativeStatus:string;administrativeLabel:string;amtId:string;amtName:string;amtEvidenceLevel:string;
 sourceKind:string;sourceVendor:string;apiFormat:string;
 crawlCheck:string;crawlOutcome:string;crawlCheckedAt:string;coverage:string;documentCount:number|null;observedAdapters:string;
 robotsDiscovery:string;tdmRegistry:string;observationState:string;observationCheckedAt:string;httpStatus:number|null;failure:string;robotsPathState:string;tdmRuntimeState:string;
}
export interface SourceExportResult {markdown:string;csv:string;rows:SourceExportRow[];counts:{municipalities:number;agsObjects:number;urlOccurrences:number;wholeStringUrlOccurrences:number;distinctUrls:number};}
export interface SourceExportOptions {registry:string;crawlIndex:string;rawRoot:string;markdown:string;csv:string;}
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
function safeUrl(value:string):string{
 try{publicUrl(value);if(publicUrlReason(value)||value.includes('#')&&/(?:token|secret|password|credential|authorization|api[-_]?key)\s*[=:]/i.test(decodeURIComponent(value.slice(value.indexOf('#')+1))))throw Error();}
 catch{throw Error('Source export rejected unsafe public URL evidence');}
 return value;
}
function safeText(value:string):string{
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||/(?:bearer\s+|(?:password|secret|token|authorization|api[-_]?key)\s*[=:])/i.test(value))throw Error('Source export rejected unsafe metadata');
 for(const match of value.matchAll(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi))safeUrl(match[0]);
 return value;
}
function markdown(value:string):string{
 return safeText(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()#!|]/g,'\\$&').replace(/\r?\n/g,'<br>');
}
function csvCell(value:unknown):string{
 let text=value===null||value===undefined?'':safeText(String(value));
 if(/^[\s]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
 return '"'+text.replace(/"/g,'""')+'"';
}
function emptyRow():SourceExportRow{
 return {rowType:'url_occurrence',pointer:'',occurrence:null,role:'',url:null,districtId:'',municipalityId:'',ags:'',sourceId:'',districtName:'',districtAgs:'',municipalityName:'',administrativeStatus:'',administrativeLabel:'',amtId:'',amtName:'',amtEvidenceLevel:'',sourceKind:'',sourceVendor:'',apiFormat:'',configuredAdapter:'',registryCheck:'',registryCheckedAt:'',crawlCheck:'',crawlOutcome:'',crawlCheckedAt:'',coverage:'',documentCount:null,observedAdapters:'',robotsDiscovery:'',tdmRegistry:'',observationState:'',observationCheckedAt:'',httpStatus:null,failure:'',robotsPathState:'',tdmRuntimeState:''};
}
function urlRole(parts:string[]):string{
 const path=parts.join('/');
 if(/^municipalities\/\d+\/sources\/\d+\/url$/.test(path))return 'configured_endpoint';
 if(/^municipalities\/\d+\/sources\/\d+\/api\/url$/.test(path))return 'configured_api';
 if(/\/api\/form\//.test(path))return 'unclassified_request_reference';
 if(/^districts\/\d+\/inventorySources\/\d+\/url$/.test(path))return 'inventory_evidence';
 if(/^inventory\/\d+\/identitySourceUrl$/.test(path)||/\/identitySources\/\d+\/url$/.test(path))return 'identity_evidence';
 if(/\/amt\/sourceUrl$/.test(path)||/\/administrativeEvidence\/\d+\/url$/.test(path))return 'administrative_evidence';
 if(/\/seedDocuments\/\d+\/url$/.test(path))return 'seed_document';
 if(/\/seedDocuments\/\d+\/evidence\/\d+\/url$/.test(path))return 'seed_evidence';
 if(/\/robots\/url$/.test(path))return 'robots_discovery';
 if(/\/knownMachinePolicyUrls\/\d+$/.test(path))return 'machine_policy_candidate';
 if(/\/crawlScope\/pageRoots\/\d+$/.test(path))return 'crawl_root';
 const policy=path.match(/\/(rights|robots|contentCheck|legalBasis|tdm)\/evidence\/\d+\/url$/);
 if(policy)return policy[1]+'_evidence';
 if(/^municipalities\/\d+\/sources\/\d+\/evidence\/\d+\/url$/.test(path))return 'source_evidence';
 return 'unclassified_url';
}
/** Pure rendering from raw registry JSON: unknown fields survive URL accounting, never object dumping. */
export function renderDistrictSources(raw:unknown,crawlInput:unknown,observations:readonly unknown[]=[]):SourceExportResult{
 const parsed=districtRegistrySchema.safeParse(raw),crawl=indexSchema.safeParse(crawlInput);
 if(!parsed.success||!crawl.success)throw Error('Source export input schema validation failed');
 const registry=parsed.data,index=crawl.data,rows:SourceExportRow[]=[],sourceRows=new Map<string,SourceExportRow>();
 const key=(municipalityId:string,sourceId:string)=>JSON.stringify([municipalityId,sourceId]);
 for(const city of registry.municipalities)for(const source of city.sources){
  const checks=index.checks.filter(c=>c.municipalityId===city.id&&c.sourceId===source.id);
  if(checks.length>1)throw Error('Source export requires a single crawl snapshot check per source');
  const check=checks[0],documents=index.documents.filter(d=>d.municipalityId===city.id&&d.sourceId===source.id);
  const row:SourceExportRow={...emptyRow(),rowType:'source',role:'configured_source',url:source.url,districtId:city.districtId,municipalityId:city.id,ags:city.ags,sourceId:source.id,configuredAdapter:districtSourceAdapterKind(source),registryCheck:source.checkState,registryCheckedAt:source.checkedAt??'',crawlCheck:check?.checkState??'missing',crawlOutcome:check?.outcome??'unavailable',crawlCheckedAt:check?.checkedAt??'',coverage:check?.coverage?.state??'unavailable',documentCount:check?.documentCount??null,observedAdapters:[...new Set(documents.map(d=>d.adapter))].sort(compare).join('; '),robotsDiscovery:source.robots?.checkState??'unavailable',tdmRegistry:source.tdm?.status??'unavailable'};
  if(row.url)safeUrl(row.url);rows.push(row);sourceRows.set(key(city.id,source.id),row);
 }
 for(const check of index.checks)if(!sourceRows.has(key(check.municipalityId,check.sourceId)))throw Error('Source export found an unbound crawl check');
 let agsObjects=0,wholeStringUrlOccurrences=0;
 function visit(value:unknown,parts:string[]):void{
  if(Array.isArray(value)){value.forEach((item,i)=>visit(item,[...parts,String(i)]));return;}
  if(value&&typeof value==='object'){
   if('ags' in value&&typeof value.ags==='string'&&/^\d{5}(?:\d{3})?$/.test(value.ags))agsObjects++;
   for(const [field,item] of Object.entries(value))visit(item,[...parts,field]);return;
  }
  if(typeof value!=='string')return;
  const matches=[...value.matchAll(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi)];
  for(const [occurrence,match] of matches.entries()){
   const whole=match[0]===value;if(whole)wholeStringUrlOccurrences++;
   const row=emptyRow();row.pointer='/'+parts.map(p=>p.replace(/~/g,'~0').replace(/\//g,'~1')).join('/');row.occurrence=occurrence;row.url=safeUrl(match[0]);row.role=whole?urlRole(parts):'text_reference';
   if(parts[0]==='districts')row.districtId=registry.districts[Number(parts[1])]?.id??'';
   if(parts[0]==='inventory'){
    const town=registry.inventory[Number(parts[1])];if(town){row.districtId=town.districtId;row.ags=town.ags;row.municipalityId=registry.municipalities.find(m=>m.ags===town.ags)?.id??'';}
   }
   if(parts[0]==='municipalities'){
    const city=registry.municipalities[Number(parts[1])];if(city){row.districtId=city.districtId;row.municipalityId=city.id;row.ags=city.ags;
     const sourceId=parts[2]==='sources'?city.sources[Number(parts[3])]?.id:parts[2]==='seedDocuments'?city.seedDocuments[Number(parts[3])]?.sourceId:undefined;
     if(sourceId){const context=sourceRows.get(key(city.id,sourceId));if(context)Object.assign(row,{...context,rowType:row.rowType,pointer:row.pointer,occurrence:row.occurrence,role:row.role,url:row.url});}
    }
   }
   rows.push(row);
  }
 }
 visit(raw,[]);
 const districtsById=new Map(registry.districts.map(district=>[district.id,district]));
 const inventoryByAgs=new Map(registry.inventory.map(town=>[town.ags,town]));
 const pilotsByAgs=new Map(registry.municipalities.map(city=>[city.ags,city]));
 // Bind retained observation metadata by exact URL only, never claim request-form or document-byte binding.
 const urlSources=new Map<string,Set<string>>();
 for(const row of rows)if(row.url&&row.sourceId){const owners=urlSources.get(row.url)??new Set<string>();owners.add(key(row.municipalityId,row.sourceId));urlSources.set(row.url,owners);}
 for(const item of [...index.documents,...index.checks.flatMap(c=>(c.blocked??[]).map(b=>({...b,municipalityId:c.municipalityId,sourceId:c.sourceId})))]){
  safeUrl(item.url);const owner=key(item.municipalityId,item.sourceId);if(!sourceRows.has(owner))throw Error('Source export found an unbound crawl source');
  const owners=urlSources.get(item.url)??new Set<string>();owners.add(owner);urlSources.set(item.url,owners);
 }
 for(const input of observations){
  const parsedObservation=observationSchema.safeParse(input);if(!parsedObservation.success)throw Error('Source export observation schema validation failed');
  const observation=parsedObservation.data;safeUrl(observation.url);
  for(const owner of urlSources.get(observation.url)??[]){
   rows.push({...sourceRows.get(owner)!,rowType:'fetch_observation',pointer:'',occurrence:null,role:'retained_observation_url_match_only',url:observation.url,observationState:observation.state,observationCheckedAt:observation.checkedAt,httpStatus:observation.status??null,failure:observation.failure??'',robotsPathState:observation.policy?.robots.state??'unavailable',tdmRuntimeState:observation.policy?.tdm.state??'unavailable'});
  }
 }
 for(const row of rows){
  const district=districtsById.get(row.districtId),town=inventoryByAgs.get(row.ags),pilot=pilotsByAgs.get(row.ags);
  row.districtName=district?.name??'';row.districtAgs=district?.ags??'';
  row.municipalityName=pilot?.name??town?.name??'';
  row.administrativeLabel=town?.administrativeLabel??'';
  row.administrativeStatus=pilot?.administrativeStatus??(town?'unknown':'');
  row.amtId=pilot?.amt?.id??'';row.amtName=pilot?.amt?.name??'';
  row.amtEvidenceLevel=pilot?(pilot.amt?'pilot_administrative_evidence':'pilot_amtsfrei_evidence'):town?(town.administrativeLabel?'inventory_label_only':'unknown'):'';
  const source=pilot?.sources.find(source=>source.id===row.sourceId);
  row.sourceKind=source?.kind??'';row.sourceVendor=source?.vendor??'';row.apiFormat=source?.api?.format??'';
  for(const value of Object.values(row))if(typeof value==='string')safeText(value);
 }
 rows.sort((a,b)=>compare(JSON.stringify(Object.values(a)),JSON.stringify(Object.values(b))));
 const occurrences=rows.filter(r=>r.rowType==='url_occurrence');
 const counts={municipalities:new Set(registry.inventory.map(m=>m.ags)).size,agsObjects,urlOccurrences:occurrences.length,wholeStringUrlOccurrences,distinctUrls:new Set(occurrences.map(r=>r.url)).size};
 const columns=Object.keys(emptyRow()) as (keyof SourceExportRow)[];
 const csv=[columns.map(csvCell).join(','),...rows.map(row=>columns.map(column=>csvCell(row[column])).join(','))].join('\r\n')+'\r\n';
 const observationRows=rows.filter(row=>row.rowType==='fetch_observation');
 const lines=['# District source inventory','',`Registry snapshot: ${markdown(registry.generatedAt)}. Crawl snapshot: ${markdown(index.generatedAt)}.`, '',`${counts.municipalities} unique municipality identities; ${counts.agsObjects} AGS-bearing raw objects (includes duplicates and districts).`,`${counts.urlOccurrences} raw URL token occurrences; ${counts.wholeStringUrlOccurrences} whole-string URL occurrences; ${counts.distinctUrls} distinct exact URL tokens. Counts are computed, not a historical delta.`, '',
 '## Interpretation','',
 `CSV preserves every raw registry URL token and JSON pointer, including unknown fields and text references; repeated tokens retain an occurrence ordinal. A token ends at whitespace, quotes or angle brackets; punctuation is retained verbatim. Source rows additionally retain null endpoints. Only URL tokens from request forms or narratives are retained, never the surrounding fields/objects. Headers and source bodies are not exported. Retained observation input records: ${observations.length}; source-bound observation rows: ${observationRows.length}. Sources without matching retained observations have unavailable runtime policy evidence.`,
 'Configured primary dispatch is not an observed adapter success. Observed adapters come only from crawl document labels. Missing crawl checks/observations are unavailable, not no-documents or not-found. Registry robots discovery is not path permission; TDM none_detected/not_declared is not a grant of permission. Retained observation rows match exact URLs only (not method/form or bytes), can cover incomplete policy stages, and do not claim complete history. Coverage complete means only the configured frontier scope.',
 'Pilot Amt identities/status use administrative evidence. Inventory labels are unverified administrative labels, not canonical Amt identities; Amt ARS identifiers are not names and are retained only in administrativeLabel, not promoted to amtId. Missing labels remain unknown, never amtsfrei. Nonpilot administrativeStatus remains unknown even when an inventory label is supplied. Blank fields mean unavailable or no applicable binding; pilot amtsfrei status explicitly explains blank Amt identity fields. District inventory dates and evidence delimit the inventory claim. CSV escaping prefixes spreadsheet formula-like cells with an apostrophe; URL text is otherwise preserved.', '', '## District → administration → municipality',''];
 for(const district of [...registry.districts].sort((a,b)=>compare(a.id,b.id))){
  lines.push(`### ${markdown(district.name)} (${district.ags})`,'',`Inventory as of ${markdown(district.inventoryAsOf)}; declared complete: ${district.inventoryComplete}.`,...district.inventorySources.map(e=>`- Inventory evidence: ${markdown(e.url)}`),'');
  const groups=new Map<string,DistrictRegistry['inventory']>();
  for(const town of registry.inventory.filter(t=>t.districtId===district.id)){
   const pilot=registry.municipalities.find(m=>m.ags===town.ags);
   const label=pilot?(pilot.administrativeStatus==='amtsfrei'?'amtsfrei — evidenced pilot':`Amt ${pilot.amt!.name} (${pilot.amt!.id}) — evidenced pilot`):town.administrativeLabel?`Administrative label (not canonical Amt): ${town.administrativeLabel}`:'Administration unknown — no per-town Amt mapping';
   const members=groups.get(label)??[];members.push(town);groups.set(label,members);
  }
  for(const [label,towns] of [...groups].sort(([a],[b])=>compare(a,b))){
   lines.push(`#### ${markdown(label)}`,'');
   for(const town of towns.sort((a,b)=>compare(a.ags,b.ags))){
    const pilot=registry.municipalities.find(m=>m.ags===town.ags);
    lines.push(`- **${markdown(town.name)} (${town.ags})** — inventory source check: ${town.sourceCheckState}; identity: ${markdown(town.identitySourceUrl)}`);
    if(pilot){for(const e of pilot.administrativeEvidence)lines.push(`  - Administrative evidence: ${markdown(e.url)}`);
     for(const source of pilot.sources){const row=sourceRows.get(key(pilot.id,source.id))!;lines.push(`  - ${markdown(source.id)} [${source.kind}; vendor ${source.vendor}; API format ${source.api?.format??'not configured'}]: ${source.url?markdown(source.url):'null endpoint'}; registry ${source.checkState}; configured ${row.configuredAdapter}; observed adapters ${markdown(row.observedAdapters||'unavailable')}; crawl ${row.crawlCheck}/${row.crawlOutcome}; robots discovery ${row.robotsDiscovery}; TDM registry ${row.tdmRegistry}`);}
    }
   }
   lines.push('');
  }
 }
 lines.push('## Configured versus observed adapters','');
 for(const adapter of [...new Set([...sourceRows.values()].map(r=>r.configuredAdapter))].sort(compare))lines.push(`- Configured ${markdown(adapter)}: ${[...sourceRows.values()].filter(r=>r.configuredAdapter===adapter).length} sources.`);
 for(const adapter of [...new Set(index.documents.map(d=>d.adapter))].sort(compare))lines.push(`- Observed ${markdown(adapter)}: ${index.documents.filter(d=>d.adapter===adapter).length} documents.`);
 return {markdown:lines.join('\n')+'\n',csv,rows,counts};
}

/** Reads only registry/index and retained observation JSON, never CAS bodies or mutable request pointers. */
export async function exportDistrictSources(options:SourceExportOptions):Promise<SourceExportResult>{
 const rawRoot=await realpath(options.rawRoot),observations:Observation[]=[];
 let entries:string[]=[];
 const folder=join(rawRoot,'observations');
 try{entries=await readdir(folder);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Source export cannot read retained observations');}
 for(const name of entries.sort(compare)){
  if(!name.endsWith('.json'))continue;
  const path=await realpath(join(folder,name)),part=relative(rawRoot,path);
  if(part.startsWith('..')||isAbsolute(part))throw Error('Source export observation escapes raw root');
  const parsed=observationSchema.safeParse(JSON.parse(await readFile(path,'utf8')));if(!parsed.success)throw Error('Source export observation schema validation failed');observations.push(parsed.data);
 }
 const result=renderDistrictSources(JSON.parse(await readFile(options.registry,'utf8')),JSON.parse(await readFile(options.crawlIndex,'utf8')),observations);
 const outputs=[resolve(options.markdown),resolve(options.csv)],inputs=await Promise.all([options.registry,options.crawlIndex].map(path=>realpath(path)));
 for(const path of outputs)await mkdir(dirname(path),{recursive:true});
 const canonicalOutputs=await Promise.all(outputs.map(async path=>join(await realpath(dirname(path)),basename(path))));
 if(canonicalOutputs[0]===canonicalOutputs[1]||canonicalOutputs.some(path=>inputs.includes(path)||!relative(rawRoot,path).startsWith('..')&&!isAbsolute(relative(rawRoot,path))))throw Error('Source export output collides with an input');
 for(const path of outputs){
  const stat=await lstat(path).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw Error('Source export cannot inspect output');});
  if(stat&&(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1))throw Error('Source export rejects linked or non-file outputs');
 }
 await writeFile(outputs[0],result.markdown);await writeFile(outputs[1],result.csv);return result;
}
async function main(){
 const {values}=parseArgs({options:{registry:{type:'string'},'crawl-index':{type:'string'},'raw-root':{type:'string'},markdown:{type:'string'},csv:{type:'string'}}});
 if(!values.registry||!values['crawl-index']||!values['raw-root']||!values.markdown||!values.csv)throw Error('All five source export paths are required');
 const result=await exportDistrictSources({registry:values.registry,crawlIndex:values['crawl-index'],rawRoot:values['raw-root'],markdown:values.markdown,csv:values.csv});
 console.log(JSON.stringify(result.counts));
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false))main().catch(()=>{console.error('Source export failed; input validation or local file operation rejected (details withheld)');process.exitCode=1;});
