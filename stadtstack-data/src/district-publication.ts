import {z} from 'zod';
import type {DistrictRegistry} from './district-registry.ts';
import type {DistrictKnowledgeRecord} from './district-schema.ts';
import {isPublicUrl} from './publication-quality.ts';

const count=z.number().int().nonnegative();
const checkState=z.enum(['checked','not_found','not_checked']);
const crawlCoverage=z.object({state:z.enum(['complete','partial','blocked','not_checked']),pendingCount:count,runnableCount:count,blockedCount:count,action:z.literal('ask_municipality').optional()}).strict();
const blockedEvidence=z.object({url:z.string().url().nullable(),failure:z.string(),checkedAt:z.string().datetime({offset:true}),action:z.literal('ask_municipality')}).strict();
const sourceCoverage=z.object({sourceId:z.string(),kind:z.string(),registryState:checkState,crawlState:checkState,checkedAt:z.string().datetime({offset:true}).nullable(),documentCount:count,publishedRecords:count,quarantinedRecords:count,coverage:crawlCoverage,failedLinkCount:count,failureExamples:z.array(blockedEvidence).max(3),reason:z.string().optional()}).strict().refine(value=>value.failureExamples.length<=value.failedLinkCount,'Failure examples exceed observed failure count');
const extractionCounts=z.object({fetchedDocumentGroups:count,attemptedDocumentGroups:count,pendingDocumentGroups:count,unavailableAttemptedDocumentGroups:count}).strict();
const extractionRunSchema=z.object({schemaVersion:z.literal('stadtstack-extraction-run-v1'),generatedAt:z.string().datetime({offset:true}),scope:z.enum(['all_fetched_documents','bounded_per_municipality']),maxDocumentsPerMunicipality:count.nullable(),availableDocumentGroups:count,attemptedDocumentGroups:count,pendingDocumentGroups:count}).passthrough();
export const districtCoverageSchema=z.object({
 schemaVersion:z.literal('stadtstack-district-coverage-v1'),generatedAt:z.string().datetime({offset:true}),
 districts:z.array(z.object({id:z.string(),ags:z.string().regex(/^\d{5}$/),municipalitiesRegistered:count,municipalitiesAttempted:count,municipalitiesWithRecords:count,municipalitiesWithDatedStages:count,documents:count,publishedRecords:count,quarantinedRecords:count}).strict()),
 municipalities:z.array(z.object({id:z.string(),ags:z.string().regex(/^\d{8}$/),districtId:z.string(),selectedForSlice:z.boolean(),status:z.enum(['gated_records','checked_no_gated_records','not_checked']),documents:count,publishedRecords:count,datedStagedRecords:count,quarantinedRecords:count,extraction:extractionCounts,sources:z.array(sourceCoverage)}).strict()),
 model:z.object({provider:z.literal('openai-subscription'),model:z.string().min(1),faithfulnessThreshold:z.literal(0.8)}).strict(),
 extractionRun:z.object({generatedAt:z.string().datetime({offset:true}),selection:z.enum(['all_at_run_start','bounded_per_municipality']),maxDocumentsPerMunicipality:count.nullable(),availableDocumentGroupsAtRunStart:count,attemptedDocumentGroups:count,pendingDocumentGroupsAtRunStart:count}).strict(),
}).strict();
export type DistrictCoverage=z.infer<typeof districtCoverageSchema>;
export const crawlSummarySchema=z.object({schemaVersion:z.literal('stadtstack-crawl-index-v1'),generatedAt:z.string(),documents:z.array(z.object({id:z.string(),municipalityId:z.string(),sourceId:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough()),checks:z.array(z.object({municipalityId:z.string(),sourceId:z.string(),checkState,checkedAt:z.string().nullable(),documentCount:count,reason:z.string().optional(),coverage:z.object({state:z.enum(['complete','partial','blocked']),pendingCount:count,runnableCount:count,blockedCount:count,action:z.literal('ask_municipality').optional()}).passthrough().optional(),blocked:z.array(z.object({url:z.string(),failure:z.string(),checkedAt:z.string()}).passthrough()).optional()}).passthrough())}).passthrough();
const quarantineSummarySchema=z.object({schemaVersion:z.literal('stadtstack-quarantine-v1'),cases:z.array(z.object({municipalityId:z.string(),sourceId:z.string(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string()}).passthrough())}).passthrough();

/** Public counts only: raw documents, failed model output, paths and credentials never enter this projection. */
export function buildDistrictCoverage(registry:DistrictRegistry,crawlInput:unknown,records:DistrictKnowledgeRecord[],quarantineInput:unknown,model:string,extractionInput:unknown):DistrictCoverage{
 const crawl=crawlSummarySchema.parse(crawlInput),quarantine=quarantineSummarySchema.parse(quarantineInput),run=extractionRunSchema.parse(extractionInput);
 const municipalities=registry.municipalities.map(city=>{
  const documents=crawl.documents.filter(doc=>doc.municipalityId===city.id),published=records.filter(record=>record.municipalityId===city.id),withheld=quarantine.cases.filter(item=>item.municipalityId===city.id);
  const checks=crawl.checks.filter(check=>check.municipalityId===city.id);
  const fetched=new Set(documents.map(document=>document.sha256));
  const attempted=new Set([...published.map(record=>record.extraction.inputSha256),...withheld.map(item=>item.sourceSha256)]);
  const present=[...attempted].filter(hash=>fetched.has(hash)).length;
  const extraction={fetchedDocumentGroups:fetched.size,attemptedDocumentGroups:present,pendingDocumentGroups:fetched.size-present,unavailableAttemptedDocumentGroups:attempted.size-present};
  const selectedForSlice=documents.length>0||checks.some(check=>check.checkedAt!==null);
  const datedStagedRecords=published.filter(record=>record.stage!=='unknown'&&(record.documentDate!==null||record.stageDate!==null||record.stages.some(event=>event.date!==null))).length;
  const status=published.length?'gated_records':selectedForSlice?'checked_no_gated_records':'not_checked';
  return {id:city.id,ags:city.ags,districtId:city.districtId,selectedForSlice,status,documents:documents.length,publishedRecords:published.length,datedStagedRecords,quarantinedRecords:withheld.length,extraction,sources:city.sources.map(source=>{
   const check=checks.find(item=>item.sourceId===source.id);
   const observed=check?.coverage;
   const coverage=observed?{state:observed.state,pendingCount:observed.pendingCount,runnableCount:observed.runnableCount,blockedCount:observed.blockedCount,...(observed.action?{action:observed.action}:{})}:{state:'not_checked' as const,pendingCount:0,runnableCount:0,blockedCount:0};
   const failures=check?.blocked??[],failureExamples=failures.slice(0,3).map(item=>({url:isPublicUrl(item.url)?item.url:null,failure:item.failure,checkedAt:item.checkedAt,action:'ask_municipality' as const}));
   return {sourceId:source.id,kind:source.kind,registryState:source.checkState,crawlState:check?.checkState??'not_checked' as const,checkedAt:check?.checkedAt??null,documentCount:documents.filter(doc=>doc.sourceId===source.id).length,publishedRecords:published.filter(record=>record.sources.some(item=>item.id===source.id)).length,quarantinedRecords:withheld.filter(item=>item.sourceId===source.id).length,coverage,failedLinkCount:failures.length,failureExamples,...(check?.reason||source.reason?{reason:check?.reason??source.reason}:{})};
  })};
 });
 const districts=registry.districts.map(district=>{
  const selected=municipalities.filter(city=>city.districtId===district.id);
  return {id:district.id,ags:district.ags,municipalitiesRegistered:registry.inventory.filter(city=>city.districtId===district.id).length,municipalitiesAttempted:selected.filter(city=>city.selectedForSlice).length,municipalitiesWithRecords:selected.filter(city=>city.publishedRecords>0).length,municipalitiesWithDatedStages:selected.filter(city=>city.datedStagedRecords>0).length,documents:selected.reduce((n,city)=>n+city.documents,0),publishedRecords:selected.reduce((n,city)=>n+city.publishedRecords,0),quarantinedRecords:selected.reduce((n,city)=>n+city.quarantinedRecords,0)};
 });
 const coverage=districtCoverageSchema.parse({schemaVersion:'stadtstack-district-coverage-v1',generatedAt:new Date().toISOString(),districts,municipalities,model:{provider:'openai-subscription',model,faithfulnessThreshold:0.8},extractionRun:{generatedAt:run.generatedAt,selection:run.scope==='all_fetched_documents'?'all_at_run_start':'bounded_per_municipality',maxDocumentsPerMunicipality:run.maxDocumentsPerMunicipality,availableDocumentGroupsAtRunStart:run.availableDocumentGroups,attemptedDocumentGroups:run.attemptedDocumentGroups,pendingDocumentGroupsAtRunStart:run.pendingDocumentGroups}});
 validateDistrictCoverage(coverage,registry,records);return coverage;
}
export function validateDistrictCoverage(coverage:DistrictCoverage,registry:DistrictRegistry,records:DistrictKnowledgeRecord[]){
 if(coverage.municipalities.length!==registry.municipalities.length||new Set(coverage.municipalities.map(city=>city.id)).size!==coverage.municipalities.length)throw Error('District coverage municipality inventory mismatch');
 for(const record of records)if(record.extraction.provider!==coverage.model.provider||record.extraction.model!==coverage.model.model)throw Error('District coverage model provenance mismatch');
 const run=coverage.extractionRun,totalAttempted=coverage.municipalities.reduce((n,city)=>n+city.extraction.attemptedDocumentGroups+city.extraction.unavailableAttemptedDocumentGroups,0);
 if(run.attemptedDocumentGroups!==totalAttempted||run.availableDocumentGroupsAtRunStart!==run.attemptedDocumentGroups+run.pendingDocumentGroupsAtRunStart)throw Error('Extraction run counts do not bind to actual source-bound outputs');
 if((run.selection==='bounded_per_municipality')!==(run.maxDocumentsPerMunicipality!==null)||run.maxDocumentsPerMunicipality===0)throw Error('Extraction selection policy mismatch');
 for(const city of coverage.municipalities){
  const registered=registry.municipalities.find(item=>item.id===city.id);
  if(!registered||registered.ags!==city.ags||registered.districtId!==city.districtId||city.publishedRecords!==records.filter(record=>record.municipalityId===city.id).length)throw Error(`District coverage record binding mismatch: ${city.id}`);
  const datedStagedRecords=records.filter(record=>record.municipalityId===city.id&&record.stage!=='unknown'&&(record.documentDate!==null||record.stageDate!==null||record.stages.some(event=>event.date!==null))).length;
  const status=city.publishedRecords?'gated_records':city.selectedForSlice?'checked_no_gated_records':'not_checked';
  if(city.status!==status||city.datedStagedRecords!==datedStagedRecords)throw Error(`Municipality admission coverage mismatch: ${city.id}`);
  const extraction=city.extraction,publishedGroups=new Set(records.filter(record=>record.municipalityId===city.id).map(record=>record.extraction.inputSha256)).size;
  if(extraction.fetchedDocumentGroups!==extraction.attemptedDocumentGroups+extraction.pendingDocumentGroups||extraction.fetchedDocumentGroups>city.documents||extraction.attemptedDocumentGroups<publishedGroups)throw Error(`Extraction coverage mismatch: ${city.id}`);
  if(run.maxDocumentsPerMunicipality!==null&&extraction.attemptedDocumentGroups+extraction.unavailableAttemptedDocumentGroups>run.maxDocumentsPerMunicipality)throw Error(`Extraction budget exceeded: ${city.id}`);
  if(city.sources.length!==registered.sources.length||new Set(city.sources.map(source=>source.sourceId)).size!==city.sources.length)throw Error(`District source coverage mismatch: ${city.id}`);
  for(const source of city.sources)if(!registered.sources.some(item=>item.id===source.sourceId&&item.kind===source.kind)||source.publishedRecords!==records.filter(record=>record.municipalityId===city.id&&record.sources.some(item=>item.id===source.sourceId)).length)throw Error(`District source record count mismatch: ${city.id}`);
 }
 if(coverage.districts.length!==registry.districts.length||new Set(coverage.districts.map(d=>d.id)).size!==coverage.districts.length)throw Error('District coverage identity mismatch');
 for(const district of coverage.districts){
  const registered=registry.districts.find(item=>item.id===district.id),cities=coverage.municipalities.filter(city=>city.districtId===district.id);
  if(!registered||registered.ags!==district.ags||district.municipalitiesRegistered!==registry.inventory.filter(city=>city.districtId===district.id).length||district.publishedRecords!==cities.reduce((n,city)=>n+city.publishedRecords,0)||district.municipalitiesWithRecords!==cities.filter(city=>city.publishedRecords>0).length||district.municipalitiesWithDatedStages!==cities.filter(city=>city.datedStagedRecords>0).length)throw Error(`District coverage totals mismatch: ${district.id}`);
 }
}

export type KnowledgeSliceEvidence=Pick<DistrictKnowledgeRecord,'id'|'districtId'|'municipalityId'|'documentDate'|'stageDate'|'stage'|'stages'>;
/** Individual date gates are unchanged; nine towns is an expansion target, not a fact-quality gate. */
export function assertKnowledgeSlice(registry:DistrictRegistry,records:KnowledgeSliceEvidence[],minimum=1){
 for(const record of records)if(record.documentDate===null&&record.stageDate===null&&!record.stages.some(event=>event.date!==null))throw Error(`Undated knowledge withheld from publication: ${record.id}`);
 for(const district of registry.districts){
  const municipalities=new Set(records.filter(record=>record.districtId===district.id&&record.stage!=='unknown').map(record=>record.municipalityId));
  if(municipalities.size<minimum)throw Error(`Dated, source-staged slice incomplete for ${district.id}: ${municipalities.size}/${minimum}`);
 }
}
