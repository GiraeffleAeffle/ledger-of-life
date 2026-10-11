import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,realpath,lstat,readdir} from 'node:fs/promises';
import {dirname,join,relative,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {crawlDocumentSchema,excludedCrawlDocumentSchema} from './district-corpus.ts';
import {districtRegistrySchema} from './district-registry.ts';
import {preparationPlanSchema,type PreparationGroup} from './district-preparation-run.ts';
import {WorkPlanSchema,restoreWorkPlan,type WorkTask} from './district-work-plan.ts';
import {documentResultSchema,type DocumentResult} from './district-inference.ts';
import {checkResult} from './district-extract.ts';
import {hashSchema,sha256,validateKnowledgeRelease,OwnerRobotsOverrideSchema,SourceAccessPolicySchema} from './district-schema.ts';
import {verifyDataRelease,readReleaseFile} from './data-release.ts';
import {isPublicUrl} from './publication-quality.ts';
import {effectiveRobotsPermission,ownerRobotsOverrideApplies} from './source-policy.ts';
import {DocumentOriginSchema} from './document-origin.ts';

const VERSION='stadtstack-corpus-manifest-v2' as const;
const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/).max(300);
const timestamp=z.string().datetime({offset:true});
const count=z.number().int().nonnegative();
const publicUrl=z.string().url().refine(isPublicUrl,'Unsafe public URL');
const mime=z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/);
const header=z.string().max(4096).refine(value=>!/[\u0000-\u001f\u007f]/u.test(value),'Invalid HTTP scalar');
const MissingReason=z.enum(['not_recorded','unsafe_observation_path','observation_missing','observation_invalid','index_evidence_missing','observation_mismatch']);
const HttpSchema=z.object({
 status:z.number().int().min(100).max(599).nullable(),etag:header.nullable(),lastModified:header.nullable(),
 observationSha256:hashSchema.nullable(),observationState:z.enum(['fetched','not_modified','excluded']).nullable(),
 bindingStatus:z.enum(['bound','missing','mismatch']),missingReason:MissingReason.nullable(),
}).strict();
const limitations=[
 'Content type is normalized/sniffed; original wire Content-Type and Content-Length are not retained. Size is decoded representation bytes; excluded representations are not verified against CAS.',
 'Historical observations do not establish a complete redirect chain or request history; mutable request pointers are not used.',
 'Chunk counts describe the pinned production result before final reassessment/publication; released citations are joined separately.',
 'Excluded representations retain bound metadata, not a raw-copy or deletion claim; independent permitted provenance may retain shared bytes.',
] as const;
const ExtractionSchema=z.object({
 scopeWorkPlanId:hashSchema,status:z.enum(['not_selected','source_excluded','preparation_hold','reference_excluded','pending','running','failed','completed']),
 preparationStatus:z.enum(['not_selected','held','prepared']),
 taskStates:z.array(z.object({taskId:hashSchema,state:z.enum(['pending','running','completed','failed']),resultSha256:hashSchema.nullable()}).strict()),
 chunkCounts:z.object({admitted:count,rejected:count,no_case:count,quarantined:count}).strict(),
 referenceIncluded:z.boolean(),limitations:z.array(z.enum([...limitations,'Reference excluded from prepared input; same-byte group counts do not confer eligibility.','Preparation hold reason is retained privately, not exported as source text.'])),
}).strict();
export const CorpusManifestRecordSchema=z.object({
 schemaVersion:z.literal(VERSION),id:hashSchema,municipalityId:identifier,ags:z.string().regex(/^\d{8}$/),districtId:identifier,sourceId:identifier,
 sourceEndpoint:publicUrl.nullable(),url:publicUrl,fetchedAt:timestamp,checkedAt:timestamp.nullable(),sha256:hashSchema,sizeBytes:count,
 contentType:mime,casPath:z.string().regex(/^sha256\/[a-f0-9]{64}$/).nullable(),bodyState:z.enum(['retained','excluded']),exclusion:excludedCrawlDocumentSchema.shape.exclusion.nullable(),http:HttpSchema,
 robots:z.object({state:z.enum(['allowed','blocked','unavailable']),url:publicUrl,sha256:hashSchema.optional(),checkedAt:timestamp.optional()}).strict().nullable(),
 robotsStatus:z.enum(['allowed','disallowed','unavailable']).nullable(),override:z.literal('owner-approved 2026-10-11').nullable(),ownerRobotsOverride:OwnerRobotsOverrideSchema.nullable(),
 documentOrigin:DocumentOriginSchema.nullable(),tdmState:z.enum(['reserved','not_reserved','not_declared','unavailable']).nullable(),tdmOverride:z.literal('owner-approved 2026-10-11').nullable(),ownerTdmOverride:OwnerRobotsOverrideSchema.nullable(),
 memberships:z.array(z.object({name:identifier,indexSha256:hashSchema,documentId:identifier}).strict()).min(1),extraction:ExtractionSchema,
 releasedRecords:z.array(z.object({id:identifier,releaseId:hashSchema,sourceLocator:z.string().regex(/^text-sha256:[a-f0-9]{64};chars:\d+-\d+$/),evidenceHash:hashSchema}).strict()),
}).strict().superRefine((record,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(record.bodyState==='retained'?(record.casPath!==`sha256/${record.sha256}`||record.exclusion!==null):(record.casPath!==null||record.exclusion===null||record.http.observationState!=='excluded'||record.http.bindingStatus!=='bound'||record.extraction.status!=='source_excluded'||record.releasedRecords.length!==0))fail('Representation retention/exclusion binding mismatch');
 if(record.documentOrigin&&(record.documentOrigin.url!==record.url||record.documentOrigin.sha256!==record.sha256))fail('Origin classification byte/URL binding mismatch');
 if(record.bodyState==='excluded'&&(!record.documentOrigin||record.documentOrigin.classification==='official_work'||record.robots?.state!=='blocked'&&record.tdmState!=='reserved'))fail('Exclusion requires a bound non-official restricted representation');
 if(record.bodyState==='retained'&&record.ownerRobotsOverride&&(!record.documentOrigin||record.robots?.state==='blocked'&&record.documentOrigin.classification!=='official_work'))fail('Retained owner acquisition requires bound origin classification');
 if(record.robotsStatus!==(record.robots?.state==='blocked'?'disallowed':record.robots?.state??null))fail('Robots declaration projection mismatch');
 if(record.override!==null||record.ownerRobotsOverride!==null){
  if(record.override!=='owner-approved 2026-10-11'||!ownerRobotsOverrideApplies(record.url,record.ownerRobotsOverride)||!record.robots||record.robots.state==='allowed'||record.robots.state==='blocked'&&!record.robots.sha256||!record.robots.checkedAt||record.robots.url!==new URL('/robots.txt',record.url).href||record.http.bindingStatus!=='bound')fail('Owner exception requires exact decision and bound actual robots declaration');
 }
 if(record.tdmOverride!==null||record.ownerTdmOverride!==null)if(record.tdmState!=='reserved'||record.tdmOverride!=='owner-approved 2026-10-11'||!ownerRobotsOverrideApplies(record.url,record.ownerTdmOverride)||record.documentOrigin?.classification!=='official_work'||record.http.bindingStatus!=='bound')fail('TDM exception requires a bound official-work decision and actual reservation');
 if(record.http.bindingStatus==='bound'){
  if(!record.http.observationSha256||!record.http.observationState||!record.checkedAt||record.http.status===null||record.http.missingReason!==null)fail('Incomplete bound observation');
 }else if(record.http.status!==null||record.http.etag!==null||record.http.lastModified!==null||record.http.observationState!==null||record.http.missingReason===null)fail('Unbound HTTP metadata');
 if(record.extraction.referenceIncluded!== (record.extraction.preparationStatus==='prepared'&&record.extraction.status!=='reference_excluded'))fail('Reference eligibility mismatch');
 if(record.extraction.taskStates.length>1)fail('Multiple primary tasks');
 const task=record.extraction.taskStates[0];
 if(task&&(task.state==='completed')!==(task.resultSha256!==null))fail('Task result state mismatch');
 if(!task||task.state!=='completed')if(Object.values(record.extraction.chunkCounts).some(value=>value!==0))fail('Counts require a completed primary result');
 if(record.extraction.status==='completed'&&task?.state!=='completed')fail('Completed status requires primary result');
 if(new Set(record.memberships.map(item=>JSON.stringify(item))).size!==record.memberships.length)fail('Duplicate membership');
 if(new Set(record.releasedRecords.map(item=>JSON.stringify(item))).size!==record.releasedRecords.length)fail('Duplicate released citation');
});
export type CorpusManifestRecord=z.infer<typeof CorpusManifestRecordSchema>;
const InputsSchema=z.object({indexes:z.array(z.object({name:identifier,sha256:hashSchema}).strict()).min(1),registrySha256:hashSchema,preparationPlanSha256:hashSchema,workPlanSha256:hashSchema,workPlanId:hashSchema,releaseId:hashSchema,releaseManifestSha256:hashSchema}).strict();
export type CorpusManifestInputs=z.infer<typeof InputsSchema>;
export const CorpusManifestHeaderSchema=z.object({schemaVersion:z.literal('stadtstack-corpus-manifest-header-v2'),type:z.literal('metadata'),inputs:InputsSchema}).strict();
const ManifestSchema=z.object({schemaVersion:z.literal(VERSION),inputs:InputsSchema,records:z.array(CorpusManifestRecordSchema)}).strict();
const PinSchema=z.object({path:z.string().min(1),sha256:hashSchema}).strict();
const OptionsSchema=z.object({indexes:z.array(PinSchema.extend({name:identifier})).min(1),registry:PinSchema,rawRoot:z.string().min(1),preparationPlan:PinSchema,workPlan:PinSchema,resultRoot:z.string().min(1),releaseRoot:z.string().min(1),out:z.string().min(1),summaryOut:z.string().min(1)}).strict();
export type CorpusManifestOptions=z.infer<typeof OptionsSchema>;
export interface CorpusManifestSummary {schemaVersion:typeof VERSION;manifestSha256:string;inputs:CorpusManifestInputs;recordCount:number;distinctBodies:number;totalBodyBytes:number;skippedBodyVerifications:number;boundObservations:number;unboundObservations:number;releasedCitations:number;limitations:readonly string[]}
export interface CorpusManifestVerification {manifestSha256:string;inputs:CorpusManifestInputs;records:CorpusManifestRecord[];recordCount:number;distinctBodies:number;totalBodyBytes:number;skippedBodyVerifications:number}
const IndexDocumentSchema=crawlDocumentSchema.extend({policy:SourceAccessPolicySchema.optional(),checkedAt:timestamp.optional(),status:z.number().int().min(100).max(599).optional(),observationPath:z.string().optional()});
type IndexDocument=z.infer<typeof IndexDocumentSchema>|z.infer<typeof excludedCrawlDocumentSchema>;
function isExcludedDocument(document:IndexDocument):document is z.infer<typeof excludedCrawlDocumentSchema>{return document.exclusion!==undefined;}
const IndexSchema=z.object({schemaVersion:z.literal('stadtstack-crawl-index-v1'),documents:z.array(IndexDocumentSchema),excludedDocuments:z.array(excludedCrawlDocumentSchema).optional()});
// Metadata inventory is not authorization to execute extraction on another corpus.
// Retain the preparation contract, but accept any externally hash-pinned snapshot.
const InventoryPreparationSchema=preparationPlanSchema.extend({corpusSha256:hashSchema});
const ObservationSchema=z.object({url:publicUrl,method:z.enum(['GET','POST']),checkedAt:timestamp,retrievedAt:timestamp,state:z.enum(['fetched','not_modified','excluded']),status:z.number().int().min(100).max(599),sha256:hashSchema,bytes:count,mimeType:mime,etag:header.optional(),lastModified:header.optional(),policy:SourceAccessPolicySchema.optional(),exclusion:excludedCrawlDocumentSchema.shape.exclusion.optional()});
type Observation=z.infer<typeof ObservationSchema>;
const key=(...parts:string[])=>JSON.stringify(parts);
const groupKey=(municipalityId:string,sha:string)=>key(municipalityId,sha);
const citationKey=(municipalityId:string,sourceId:string,url:string,sha:string)=>key(municipalityId,sourceId,url,sha);
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
async function pinnedJson(pin:z.infer<typeof PinSchema>):Promise<unknown>{
 const bytes=await readFile(pin.path);if(sha256(bytes)!==pin.sha256)throw Error('Pinned input hash mismatch');
 return JSON.parse(bytes.toString('utf8'));
}
async function containedFile(root:string,path:string):Promise<string>{
 const actualRoot=await realpath(root),candidate=await realpath(path),part=relative(actualRoot,candidate);
 if(!part||part.startsWith('..')||isAbsolute(part)||!(await lstat(candidate)).isFile())throw Error('Evidence path escapes its root');
 return candidate;
}
async function bodySize(rawRoot:string,sha:string):Promise<number>{
 const path=await containedFile(rawRoot,join(rawRoot,'sha256',hashSchema.parse(sha))),hash=createHash('sha256');let bytes=0;
 for await(const chunk of createReadStream(path)){hash.update(chunk);bytes+=chunk.length;}
 if(hash.digest('hex')!==sha)throw Error('CAS body hash mismatch');return bytes;
}
function relocatedObservation(path:string):string|null{
 // Never resolve an old absolute path and never consult requests/*.json.
 const match=/(?:^|\/)observations\/([^/]+\.json)$/.exec(path);
 return match&&/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(match[1])&&!path.split('/').includes('..')?match[1]:null;
}
function observationMatches(observation:Observation,record:{url:string;sha256:string;fetchedAt:string;checkedAt:string|null;contentType:string;sizeBytes:number;bodyState:'retained'|'excluded'},status:number|null):boolean{
 return observation.url===record.url&&observation.sha256===record.sha256&&observation.retrievedAt===record.fetchedAt&&observation.checkedAt===record.checkedAt&&observation.mimeType===record.contentType&&observation.bytes===record.sizeBytes&&observation.status===status&&
  (record.bodyState==='excluded'?observation.state==='excluded'&&(observation.status===304||observation.status>=200&&observation.status<300):observation.state==='not_modified'?observation.status===304:observation.state==='fetched'&&observation.status>=200&&observation.status<300);
}
async function bindObservation(rawRoot:string,document:IndexDocument,sizeBytes:number):Promise<CorpusManifestRecord['http']>{
 const missing=(missingReason:z.infer<typeof MissingReason>,observationSha256:string|null=null):CorpusManifestRecord['http']=>({status:null,etag:null,lastModified:null,observationSha256,observationState:null,bindingStatus:missingReason==='observation_mismatch'||missingReason==='observation_invalid'?'mismatch':'missing',missingReason});
 if(!document.observationPath)return missing('not_recorded');
 const name=relocatedObservation(document.observationPath);if(!name)return missing('unsafe_observation_path');
 let bytes:Buffer;
 try{bytes=await readFile(await containedFile(join(rawRoot,'observations'),join(rawRoot,'observations',name)));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return missing('observation_missing');throw Error('Historical observation containment/read failure');}
 const digest=sha256(bytes);let observation:Observation;
 try{observation=ObservationSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{return missing('observation_invalid',digest);}
 if(document.checkedAt===undefined||document.status===undefined)return missing('index_evidence_missing',digest);
 if(!observationMatches(observation,{url:document.url,sha256:document.sha256,fetchedAt:document.retrievedAt,checkedAt:document.checkedAt,contentType:document.mimeType,sizeBytes,bodyState:isExcludedDocument(document)?'excluded':'retained'},document.status))return missing('observation_mismatch',digest);
 if((document.policy?.documentOrigin||document.policy?.ownerRobotsOverride||document.policy?.ownerTdmOverride)&&JSON.stringify(observation.policy)!==JSON.stringify(document.policy))return missing('observation_mismatch',digest);
 if(isExcludedDocument(document)&&JSON.stringify(observation.exclusion)!==JSON.stringify(document.exclusion))return missing('observation_mismatch',digest);
 return {status:observation.status,etag:observation.etag??null,lastModified:observation.lastModified??null,observationSha256:digest,observationState:observation.state,bindingStatus:'bound',missingReason:null};
}
function extractionFor(document:IndexDocument,planId:string,group:PreparationGroup|undefined,held:boolean,task:WorkTask|undefined,result:DocumentResult|undefined):CorpusManifestRecord['extraction']{
 if(isExcludedDocument(document))return {scopeWorkPlanId:planId,status:'source_excluded',preparationStatus:'not_selected',taskStates:[],chunkCounts:{admitted:0,rejected:0,no_case:0,quarantined:0},referenceIncluded:false,limitations:[...limitations]};
 const referenceIncluded=!!group&&group.documentIds.includes(document.id)&&!group.referenceWarnings.some(warning=>warning.documentId===document.id&&warning.sourceId===document.sourceId)&&group.expected.references.some(reference=>reference.id===document.sourceId&&reference.url===document.url&&reference.sha256===document.sha256&&reference.retrievedAt===document.retrievedAt&&reference.mimeType===document.mimeType);
 const chunkCounts={admitted:0,rejected:0,no_case:0,quarantined:result?.quarantine.length??0};
 for(const chunk of result?.chunks??[])chunkCounts[chunk.outcome]++;
 return {scopeWorkPlanId:planId,status:group?referenceIncluded?(task?.state??'pending'):'reference_excluded':held?'preparation_hold':'not_selected',preparationStatus:group?'prepared':held?'held':'not_selected',taskStates:task?[{taskId:task.id,state:task.state,resultSha256:task.resultSha256}]:[],chunkCounts,referenceIncluded,limitations:[...limitations,...(group&&!referenceIncluded?['Reference excluded from prepared input; same-byte group counts do not confer eligibility.' as const]:[]),...(held?['Preparation hold reason is retained privately, not exported as source text.' as const]:[])]};
}
function validateManifest(raw:unknown){
 const manifest=ManifestSchema.parse(raw),names=new Map(manifest.inputs.indexes.map(index=>[index.name,index.sha256]));
 if(names.size!==manifest.inputs.indexes.length)throw Error('Duplicate index name');
 const ids=new Set<string>();
 for(const record of manifest.records){
  if(ids.has(record.id))throw Error('Duplicate representation identity');ids.add(record.id);
  if(record.extraction.scopeWorkPlanId!==manifest.inputs.workPlanId)throw Error('Extraction scope mismatch');
  for(const member of record.memberships)if(names.get(member.name)!==member.indexSha256)throw Error('Index membership binding mismatch');
  for(const citation of record.releasedRecords)if(citation.releaseId!==manifest.inputs.releaseId)throw Error('Released citation scope mismatch');
 }
 return manifest;
}
function parseManifestJsonl(bytes:Uint8Array){
 const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\n');
 if(lines.at(-1)==='')lines.pop(); // One final line terminator is not an empty row.
 if(!lines.length||lines.some(line=>line.trim()===''))throw Error('Blank or missing corpus manifest JSONL row');
 const values=lines.map((line,index)=>{
  try{return JSON.parse(line) as unknown;}catch{throw Error(`Malformed corpus manifest JSONL row ${index+1}`);}
 });
 const header=CorpusManifestHeaderSchema.parse(values[0]);
 // The strict record schema rejects a second header anywhere after the first row.
 return validateManifest({schemaVersion:VERSION,inputs:header.inputs,records:values.slice(1)});
}

/** Build public metadata only. All input paths are private and never serialized. */
export async function buildCorpusManifest(options:CorpusManifestOptions):Promise<CorpusManifestSummary>{
 const config=OptionsSchema.parse(options);
 if(resolve(config.out)===resolve(config.summaryOut))throw Error('Manifest and summary paths must differ');
 const registry=districtRegistrySchema.parse(await pinnedJson(config.registry));
 const preparation=InventoryPreparationSchema.parse(await pinnedJson(config.preparationPlan));
 const plan=WorkPlanSchema.parse(await pinnedJson(config.workPlan));
 restoreWorkPlan(structuredClone(plan)); // Validate assignments without relabeling historical running tasks.
 // Preparation fingerprints the text/OCR pipeline; the work plan fingerprints model extraction.
 if(preparation.registrySha256!==config.registry.sha256||!config.indexes.some(index=>index.sha256===preparation.corpusSha256))throw Error('Preparation input binding mismatch');
 if(new Set(config.indexes.map(index=>index.name)).size!==config.indexes.length)throw Error('Duplicate index name');
 const release=await verifyDataRelease(config.releaseRoot);
 const releaseBytes=await readFile(join(config.releaseRoot,'release-manifest.json'));
 if(JSON.parse(releaseBytes.toString('utf8')).id!==release.id)throw Error('Release changed during manifest build');
 const releaseRegistry=districtRegistrySchema.parse(JSON.parse((await readReleaseFile(config.releaseRoot,release,'knowledge/registry.json')).toString('utf8')));
 if(JSON.stringify(releaseRegistry)!==JSON.stringify(registry))throw Error('Released registry differs from pinned registry');
 const released=validateKnowledgeRelease(JSON.parse((await readReleaseFile(config.releaseRoot,release,'knowledge/records.json')).toString('utf8')),releaseRegistry);
 const coverage=z.object({extractionRun:z.object({corpusSha256:hashSchema,registrySha256:hashSchema,promptContractSha256:hashSchema,schemaSha256:hashSchema})}).parse(JSON.parse((await readReleaseFile(config.releaseRoot,release,'knowledge/coverage.json')).toString('utf8')));
 if(coverage.extractionRun.corpusSha256!==preparation.corpusSha256||coverage.extractionRun.registrySha256!==config.registry.sha256||coverage.extractionRun.promptContractSha256!==plan.promptSha256||coverage.extractionRun.schemaSha256!==plan.schemaSha256)throw Error('Release extraction scope mismatch');
 const groups=new Map<string,PreparationGroup>(),holds=new Set(preparation.quarantine.map(item=>groupKey(item.municipalityId,item.sourceSha256)));
 for(const group of preparation.groups){
  const id=groupKey(group.municipality.id,group.expected.sourceSha256),city=registry.municipalities.find(city=>city.id===group.municipality.id);
  if(groups.has(id)||holds.has(id)||!city||city.ags!==group.municipality.ags||city.districtId!==group.municipality.districtId||group.expected.municipalityId!==city.id||group.expected.extractorSha256!==preparation.extractorSha256)throw Error('Preparation group binding mismatch');
  groups.set(id,group);
 }
 const tasks=new Map<string,WorkTask>(),results=new Map<string,DocumentResult>();
 for(const task of plan.tasks.filter(task=>task.purpose==='production')){
  const id=groupKey(task.group.municipalityId,task.group.sourceSha256),group=groups.get(id);
  if(tasks.has(id)||!group||group.expected.receiptSha256!==task.group.preparedSha256)throw Error('Primary task preparation binding mismatch');tasks.set(id,task);
  if(task.state==='completed'){
   const result=documentResultSchema.parse(await pinnedJson({path:await containedFile(config.resultRoot,join(config.resultRoot,task.id+'.json')),sha256:task.resultSha256!}));
   checkResult(result,task,plan);
   if(new Set(result.chunks.map(chunk=>chunk.index)).size!==result.chunks.length||result.records.some(record=>record.municipalityId!==task.group.municipalityId||record.extraction.inputSha256!==task.group.sourceSha256)||result.quarantine.some(item=>item.municipalityId!==task.group.municipalityId||item.sourceSha256!==task.group.sourceSha256))throw Error('Result chunk/source binding mismatch');
   const admitted=new Map(result.records.map(record=>[record.id,record]));
   for(const chunk of result.chunks)if(chunk.outcome==='admitted'){
    const record=chunk.recordId===null?undefined:admitted.get(chunk.recordId);
    if(!record||record.extraction.chunk.index!==chunk.index||record.extraction.responseSha256!==chunk.responseSha256)throw Error('Admitted chunk record binding mismatch');
    admitted.delete(record.id);
   }
   if(admitted.size)throw Error('Result record missing admitted chunk');
   results.set(id,result);
  }
 }
 for(const id of groups.keys())if(!tasks.has(id))throw Error('Prepared group missing primary task');
 const bodies=new Map<string,number>(),rows=new Map<string,CorpusManifestRecord>(),citations=new Map<string,CorpusManifestRecord['releasedRecords']>(),seenCitations=new Set<string>();
 for(const record of released.records)for(const source of record.sources){
  publicUrl.parse(source.url);
  const id=citationKey(record.municipalityId,source.id,source.url,source.sha256),list=citations.get(id)??[];
  const citation={id:record.id,releaseId:release.id,sourceLocator:source.locator,evidenceHash:record.verification.evidenceHash};
  if(!list.some(item=>JSON.stringify(item)===JSON.stringify(citation)))list.push(citation);citations.set(id,list);
 }
 for(const index of [...config.indexes].sort((a,b)=>compare(a.name,b.name))){
  const corpus=IndexSchema.parse(await pinnedJson(index));
  for(const document of [...corpus.documents,...corpus.excludedDocuments??[]]){
   publicUrl.parse(document.url);mime.parse(document.mimeType);
   const city=registry.municipalities.find(city=>city.id===document.municipalityId),source=city?.sources.find(source=>source.id===document.sourceId);
   if(!city||city.ags!==document.ags||city.districtId!==document.districtId||!source)throw Error('Index municipality/source binding mismatch');
   if(source.url!==null)publicUrl.parse(source.url);
   const excluded=isExcludedDocument(document);
   let size=excluded?document.sizeBytes:bodies.get(document.sha256);if(size===undefined){size=await bodySize(config.rawRoot,document.sha256);bodies.set(document.sha256,size);}
   const http=await bindObservation(config.rawRoot,document,size);
   const policy=document.policy??null;
   if(policy?.ownerRobotsOverride&&(!effectiveRobotsPermission(policy,document.url)||!ownerRobotsOverrideApplies(source.url??source.api?.url??'',source.ownerRobotsOverride)||http.bindingStatus!=='bound'))throw Error('Owner exception missing registered decision or bound observation');
   if((policy?.ownerTdmOverride||excluded)&&(!ownerRobotsOverrideApplies(source.url??source.api?.url??'',source.ownerRobotsOverride)||http.bindingStatus!=='bound'))throw Error('TDM exception or exclusion missing registered source or bound observation');
   const identity=sha256(key(document.id,document.municipalityId,document.ags,document.districtId,document.sourceId,document.url,document.sha256,document.mimeType,document.retrievedAt,document.checkedAt??'',String(document.status??''),document.observationPath??'',JSON.stringify(policy),excluded?JSON.stringify(document.exclusion):'retained'));
   const membership={name:index.name,indexSha256:index.sha256,documentId:document.id};
   const existing=rows.get(identity);
   if(existing){if(!existing.memberships.some(item=>JSON.stringify(item)===JSON.stringify(membership)))existing.memberships.push(membership);continue;}
   const id=groupKey(city.id,document.sha256),citation=citationKey(city.id,document.sourceId,document.url,document.sha256);
   if(!excluded&&citations.has(citation))seenCitations.add(citation);
   rows.set(identity,CorpusManifestRecordSchema.parse({schemaVersion:VERSION,id:identity,municipalityId:city.id,ags:city.ags,districtId:city.districtId,sourceId:source.id,sourceEndpoint:source.url,url:document.url,fetchedAt:document.retrievedAt,checkedAt:document.checkedAt??null,sha256:document.sha256,sizeBytes:size,contentType:document.mimeType,casPath:excluded?null:`sha256/${document.sha256}`,bodyState:excluded?'excluded':'retained',exclusion:excluded?document.exclusion:null,http,robots:policy?.robots??null,robotsStatus:policy?.robots.state==='blocked'?'disallowed':policy?.robots.state??null,override:policy?.override??null,ownerRobotsOverride:policy?.ownerRobotsOverride??null,documentOrigin:policy?.documentOrigin??null,tdmState:policy?.tdm.state??null,tdmOverride:policy?.tdmOverride??null,ownerTdmOverride:policy?.ownerTdmOverride??null,memberships:[membership],extraction:extractionFor(document,plan.id,groups.get(id),holds.has(id),tasks.get(id),results.get(id)),releasedRecords:excluded?[]:citations.get(citation)??[]}));
  }
 }
 if(seenCitations.size!==citations.size)throw Error('Released source citation missing from supplied indexes');
 const inputs:CorpusManifestInputs={indexes:config.indexes.map(({name,sha256})=>({name,sha256})).sort((a,b)=>compare(a.name,b.name)),registrySha256:config.registry.sha256,preparationPlanSha256:config.preparationPlan.sha256,workPlanSha256:config.workPlan.sha256,workPlanId:plan.id,releaseId:release.id,releaseManifestSha256:sha256(releaseBytes)};
 const records=[...rows.values()].sort((a,b)=>compare(a.id,b.id));
 for(const record of records){record.memberships.sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b)));record.releasedRecords.sort((a,b)=>compare(JSON.stringify(a),JSON.stringify(b)));}
 const manifest=validateManifest({schemaVersion:VERSION,inputs,records});
 const header=CorpusManifestHeaderSchema.parse({schemaVersion:'stadtstack-corpus-manifest-header-v2',type:'metadata',inputs:manifest.inputs});
 const encoded=[JSON.stringify(header),...manifest.records.map(record=>JSON.stringify(record))].join('\n')+'\n';
 const summary:CorpusManifestSummary={schemaVersion:VERSION,manifestSha256:sha256(encoded),inputs,recordCount:records.length,distinctBodies:bodies.size,totalBodyBytes:[...bodies.values()].reduce((a,b)=>a+b,0),skippedBodyVerifications:records.filter(record=>record.bodyState==='excluded').length,boundObservations:records.filter(record=>record.http.bindingStatus==='bound').length,unboundObservations:records.filter(record=>record.http.bindingStatus!=='bound').length,releasedCitations:[...citations.values()].reduce((sum,items)=>sum+items.length,0),limitations:[...limitations,'Verification of this export requires a trusted external manifest digest; self-contained metadata is not independent proof of index, plan or release provenance.']};
 await mkdir(dirname(resolve(config.out)),{recursive:true});await mkdir(dirname(resolve(config.summaryOut)),{recursive:true});
 await writeFile(config.out,encoded,{flag:'wx'});await writeFile(config.summaryOut,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
 return summary;
}

/** Recheck CAS and bound historical observations. Callers must separately pin the returned manifest digest and input digests. */
export async function verifyCorpusManifest(path:string,rawRoot:string):Promise<CorpusManifestVerification>{
 const bytes=await readFile(path),manifest=parseManifestJsonl(bytes),bodies=new Map<string,number>();
 for(const record of manifest.records){
  if(record.bodyState==='excluded')continue;
  let size=bodies.get(record.sha256);if(size===undefined){size=await bodySize(rawRoot,record.sha256);bodies.set(record.sha256,size);}
  if(size!==record.sizeBytes)throw Error('CAS body size mismatch');
 }
 const needed=new Map<string,CorpusManifestRecord[]>();
 for(const record of manifest.records)if(record.http.observationSha256!==null){
  const digest=record.http.observationSha256!,list=needed.get(digest)??[];list.push(record);needed.set(digest,list);
 }
 if(needed.size){
  const root=join(rawRoot,'observations');
  for(const entry of await readdir(root,{withFileTypes:true})){
   if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
   const observationBytes=await readFile(await containedFile(root,join(root,entry.name))),digest=sha256(observationBytes),records=needed.get(digest);
   if(!records)continue;
   const bound=records.filter(record=>record.http.bindingStatus==='bound');
   if(bound.length){
    const observation=ObservationSchema.parse(JSON.parse(observationBytes.toString('utf8')));
    for(const record of bound)if(!observationMatches(observation,record,record.http.status)||observation.state!==record.http.observationState||(observation.etag??null)!==record.http.etag||(observation.lastModified??null)!==record.http.lastModified)throw Error('Historical observation binding mismatch');
    for(const record of bound){
     if(record.ownerRobotsOverride&&(JSON.stringify(record.robots)!==JSON.stringify(observation.policy?.robots)||JSON.stringify(record.ownerRobotsOverride)!==JSON.stringify(observation.policy?.ownerRobotsOverride)||record.override!==observation.policy?.override||record.robotsStatus!==observation.policy?.robotsStatus))throw Error('Historical owner override audit binding mismatch');
     if(record.documentOrigin&&JSON.stringify(record.documentOrigin)!==JSON.stringify(observation.policy?.documentOrigin))throw Error('Historical origin classification binding mismatch');
     if(record.ownerTdmOverride&&(JSON.stringify(record.ownerTdmOverride)!==JSON.stringify(observation.policy?.ownerTdmOverride)||record.tdmOverride!==observation.policy?.tdmOverride||record.tdmState!==observation.policy?.tdm.state))throw Error('Historical TDM decision binding mismatch');
     if(record.bodyState==='excluded'&&(JSON.stringify(record.exclusion)!==JSON.stringify(observation.exclusion)||record.tdmState!==observation.policy?.tdm.state))throw Error('Historical exclusion binding mismatch');
    }
   }
   needed.delete(digest);if(!needed.size)break;
  }
  if(needed.size)throw Error('Bound historical observation missing');
 }
 return {manifestSha256:sha256(bytes),inputs:manifest.inputs,records:manifest.records,recordCount:manifest.records.length,distinctBodies:bodies.size,totalBodyBytes:[...bodies.values()].reduce((a,b)=>a+b,0),skippedBodyVerifications:manifest.records.filter(record=>record.bodyState==='excluded').length};
}
async function main(){
 const [command,path,last,...extra]=process.argv.slice(2);
 if(extra.length||!path||!last||!['build','verify'].includes(command))throw Error('Usage: corpus-manifest.ts build CONFIG_JSON CONFIG_SHA256 | verify MANIFEST_PATH RAW_ROOT');
 if(command==='build')console.log(JSON.stringify(await buildCorpusManifest(OptionsSchema.parse(await pinnedJson({path,sha256:hashSchema.parse(last)})))));
 else{const {records:_records,...summary}=await verifyCorpusManifest(path,last);console.log(JSON.stringify(summary));}
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false))main().catch(()=>{console.error('Corpus manifest command failed; input integrity, schema, containment or public-metadata gate rejected evidence.');process.exitCode=1;});
