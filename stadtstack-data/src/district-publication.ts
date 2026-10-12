import {z} from 'zod';
import type {DistrictRegistry} from './district-registry.ts';
import {REQUIRED_DETERMINISTIC_CHECKS,type DistrictKnowledgeRecord} from './district-schema.ts';
import {GRAPH_DETERMINISTIC_CHECKS} from './district-graph-claims.ts';
import {isPublicUrl,publicUrlIssues,type PublicUrlIssue} from './publication-quality.ts';
import {ModelEvidenceSchema,type ModelEvidence} from './district-model-contract.ts';
import {structuredRunSchema,structuredPublicCoverageReceiptSchema,projectStructuredCoverageReceipt,validateStructuredRun,structuredReceiptMatches,structuredRecordHasSourcedDate,structuredRecordHasSourcedAction} from './district-structured-run.ts';
import type {StructuredKnowledgeRecord} from './district-structured-record.ts';
import {textRunLineageSchema,type TextRunLineage,textLineageRecordSha256} from './text-run-lineage.ts';
import {RetainedKnowledgeLineageSchema,type RetainedKnowledgeLineage} from './retained-knowledge-lineage.ts';
const count=z.number().int().nonnegative();
const admittedModelSchema=ModelEvidenceSchema.safeExtend({faithfulnessThreshold:z.literal(0.8),publishedRecords:count}).strict();
function modelKey(model:ModelEvidence):string{return JSON.stringify([model.provider,model.model,model.tool,model.toolVersion,model.modelIdentitySha256,model.modelIdentityBasis]);}
const checkState=z.enum(['checked','not_found','not_checked']);
const publicCheckId=z.enum([...REQUIRED_DETERMINISTIC_CHECKS,...GRAPH_DETERMINISTIC_CHECKS,'judge_critical_claims']);
const quarantineReason=z.enum(['deterministic_gate_failed','faithfulness_gate_failed','no_supported_case','invalid_structured_output','document_limit','preparation_failed','extraction_failed','missing_sourced_date','nonpublic_evidence_url','source_binding_unknown','critical_assessment_missing','critical_assessment_held','critical_assessment_binding','original_gates_not_admitted','unknown']);
/** Counts are quarantine entries, not projects; one entry may have several reasons/check failures. */
export const quarantineReasonHistogramSchema=z.object({categories:z.array(z.object({reason:quarantineReason,count}).strict()),failedDeterministicChecks:z.array(z.object({id:publicCheckId,count}).strict())}).strict();
export type QuarantineReasonHistogram=z.infer<typeof quarantineReasonHistogramSchema>;
export const districtCoverageAccountingSchema=z.object({registryMunicipalities:count,configuredMunicipalities:count,checkedMunicipalities:count,runSelectedMunicipalities:count.nullable(),preparedMunicipalities:count.nullable(),attemptedMunicipalities:count,publishedMunicipalities:count,checkedWithoutPublishedMunicipalities:count,unvisitedMunicipalities:count}).strict();
const targetScope=z.object({kind:z.enum(['page_roots','seed_documents']),urls:z.array(z.url().nullable()),state:z.enum(['complete','partial','blocked']),pendingCount:count,runnableCount:count,blockedCount:count}).strict();
const crawlCoverage=z.object({state:z.enum(['complete','partial','blocked','not_checked']),pendingCount:count,runnableCount:count,blockedCount:count,scope:z.string().optional(),sourceCoverage:z.literal('not_assessed').optional(),targetScope:targetScope.optional(),action:z.literal('ask_municipality').optional()}).strict();
const blockedEvidence=z.object({url:z.string().url().nullable(),failure:z.string(),checkedAt:z.string().datetime({offset:true}),action:z.literal('ask_municipality')}).strict();
const sourceObservation=z.object({runId:z.string().regex(/^[a-f0-9]{64}$/).nullable(),crawlState:checkState,checkedAt:z.string().datetime({offset:true}).nullable(),documentCount:count,coverage:crawlCoverage,failedLinkCount:count,failureExamples:z.array(blockedEvidence).max(3),reason:z.string().optional()}).strict().refine(value=>value.failureExamples.length<=value.failedLinkCount,'Failure examples exceed observed failure count');
const sourceCoverage=z.object({sourceId:z.string(),kind:z.string(),registryState:checkState,crawlState:checkState,checkedAt:z.string().datetime({offset:true}).nullable(),documentCount:count,publishedRecords:count,textModelRecords:count,structuredRecords:count,quarantinedRecords:count,quarantineReasons:quarantineReasonHistogramSchema,coverage:crawlCoverage,coverageSelection:z.enum(['latest_non_targeted_observation','latest_targeted_observation','none']),observations:z.array(sourceObservation),failedLinkCount:count,failureExamples:z.array(blockedEvidence).max(3),reason:z.string().optional()}).strict().refine(value=>value.failureExamples.length<=value.failedLinkCount,'Failure examples exceed observed failure count');
const extractionCounts=z.object({fetchedDocumentGroups:count,runSelectedDocumentGroups:count.nullable(),preparedDocumentGroups:count.nullable(),attemptedDocumentGroups:count,pendingDocumentGroups:count,unavailableAttemptedDocumentGroups:count}).strict();
export const districtCoverageSchema=z.object({
 schemaVersion:z.literal('stadtstack-district-coverage-v5'),generatedAt:z.string().datetime({offset:true}),
 accounting:districtCoverageAccountingSchema,
 districts:z.array(z.object({id:z.string(),ags:z.string().regex(/^\d{5}$/),municipalitiesRegistered:count,municipalitiesConfigured:count,municipalitiesChecked:count,municipalitiesAttempted:count,municipalitiesWithRecords:count,municipalitiesWithDatedStages:count,documents:count,publishedRecords:count,textModelRecords:count,structuredRecords:count,quarantinedRecords:count}).strict()),
 municipalities:z.array(z.object({id:z.string(),ags:z.string().regex(/^\d{8}$/),districtId:z.string(),checked:z.boolean(),status:z.enum(['gated_records','checked_no_gated_records','not_checked']),documents:count,publishedRecords:count,textModelRecords:count,structuredRecords:count,datedStagedRecords:count,quarantinedRecords:count,quarantineReasons:quarantineReasonHistogramSchema,extraction:extractionCounts,sources:z.array(sourceCoverage)}).strict()),
 models:z.array(admittedModelSchema),
 adapters:z.array(structuredPublicCoverageReceiptSchema.extend({publishedRecords:count})),
 textLineage:textRunLineageSchema.nullable(),
 retainedPublication:RetainedKnowledgeLineageSchema.nullable(),
}).strict();
export type DistrictCoverage=z.infer<typeof districtCoverageSchema>;
export type TextCoverageRecord=Pick<DistrictKnowledgeRecord,'kind'|'id'|'municipalityId'|'documentDate'|'stageDate'|'stage'|'stages'>&{extraction:ModelEvidence&Pick<DistrictKnowledgeRecord['extraction'],'inputSha256'|'responseSha256'|'promptSha256'|'judgePromptSha256'>;verification:{evidenceHash:string;faithfulness:{responseSha256:string|null}};sources:{id:string}[]};
export type DistrictCoverageRecord=TextCoverageRecord|StructuredKnowledgeRecord;
export const crawlSummarySchema=z.object({schemaVersion:z.literal('stadtstack-crawl-index-v1'),generatedAt:z.string(),documents:z.array(z.object({id:z.string(),municipalityId:z.string(),sourceId:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough()),checks:z.array(z.object({municipalityId:z.string(),sourceId:z.string(),runId:z.string().regex(/^[a-f0-9]{64}$/).optional(),checkState,checkedAt:z.string().nullable(),documentCount:count,reason:z.string().optional(),coverage:crawlCoverage.passthrough().optional(),blocked:z.array(z.object({url:z.string(),failure:z.string(),checkedAt:z.string()}).passthrough()).optional()}).passthrough())}).passthrough();
const quarantineCandidateSchema=z.object({municipalityId:z.string(),extraction:z.object({inputSha256:z.string()}),sources:z.array(z.object({id:z.string(),sha256:z.string()})),verification:z.object({deterministic:z.object({passed:z.boolean(),checks:z.array(z.object({id:z.string(),passed:z.boolean()}))}),faithfulness:z.object({score:z.number().nullable(),threshold:z.number(),responseSha256:z.string().nullable()})})});
const quarantineCaseSummarySchema=z.object({kind:z.enum(['text_model','structured']).optional(),municipalityId:z.string(),sourceId:z.string(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string(),candidate:quarantineCandidateSchema.optional(),publicationReasons:z.array(z.enum(['missing_sourced_date','nonpublic_evidence_url'])).optional()}).strip();
const quarantineSummarySchema=z.object({schemaVersion:z.literal('stadtstack-quarantine-v1'),cases:z.array(quarantineCaseSummarySchema)}).strip();

/** Read only fixed producer reason strings and allowlisted check IDs; never export free text. */
export function quarantineReasonHistogram(input:unknown[]):QuarantineReasonHistogram{
 const categories=new Map<z.infer<typeof quarantineReason>,number>(),failedChecks=new Map<z.infer<typeof publicCheckId>,number>();
 const knownReasons:Record<string,z.infer<typeof quarantineReason>>={
  'No supported case in source excerpt':'no_supported_case','Structured output/schema validation failed':'invalid_structured_output',
  'Document exceeds model chunk limit; entire document quarantined before model readiness (no truncation or model calls)':'document_limit',
  'Faithfulness gate not passed':'faithfulness_gate_failed','previous_judge_failed_or_unknown':'faithfulness_gate_failed','current_actual_judge_failed':'faithfulness_gate_failed',
  'deterministic_gate_failed':'deterministic_gate_failed','date_missing':'missing_sourced_date',
  'source_binding_unknown':'source_binding_unknown','source_chunk_binding_unknown':'source_binding_unknown',
  'Extraction failed; see source-bound quarantine identity':'extraction_failed',
  'critical_assessment_missing':'critical_assessment_missing','critical_assessment_held':'critical_assessment_held','critical_assessment_binding':'critical_assessment_binding','original_gates_not_admitted':'original_gates_not_admitted',
 };
 for(const raw of input){
  const item=quarantineCaseSummarySchema.parse(raw),reasons=new Set<z.infer<typeof quarantineReason>>(item.publicationReasons),ids=new Set<z.infer<typeof publicCheckId>>();
  const candidate=item.candidate;
  if(candidate){
   if(candidate.municipalityId!==item.municipalityId||candidate.extraction.inputSha256!==item.sourceSha256||!candidate.sources.some(source=>source.id===item.sourceId&&source.sha256===item.sourceSha256))throw Error('Quarantine candidate source binding mismatch');
   for(const check of candidate.verification.deterministic.checks)if(!check.passed){
    reasons.add('deterministic_gate_failed');
    const id=publicCheckId.safeParse(check.id);if(id.success)ids.add(id.data);else reasons.add('unknown');
   }
   const faithfulness=candidate.verification.faithfulness;
   if(candidate.verification.deterministic.passed&&(faithfulness.score===null||faithfulness.score<faithfulness.threshold||faithfulness.responseSha256===null))reasons.add('faithfulness_gate_failed');
  }
  const reason=Object.hasOwn(knownReasons,item.reason)?knownReasons[item.reason]:undefined;
  if(reason)reasons.add(reason);
  else if(!candidate&&!item.publicationReasons?.length){
   const checks=item.reason.split(', ').map(id=>publicCheckId.safeParse(id));
   if(checks.length&&checks.every(check=>check.success)){reasons.add('deterministic_gate_failed');for(const check of checks)if(check.success)ids.add(check.data);}
   else if(/^(Missing document prerequisite:|Document command failed:|PDF |Unsupported document|Document path|Prepared |Frozen |Source |Unbound )/.test(item.reason))reasons.add('preparation_failed');
   else if(/^Document (exceeds|has) /.test(item.reason))reasons.add('document_limit');
  }
  if(!reasons.size)reasons.add('unknown');
  for(const reason of reasons)categories.set(reason,(categories.get(reason)??0)+1);
  for(const id of ids)failedChecks.set(id,(failedChecks.get(id)??0)+1);
 }
 return {categories:[...categories].sort(([a],[b])=>a.localeCompare(b)).map(([reason,count])=>({reason,count})),failedDeterministicChecks:[...failedChecks].sort(([a],[b])=>a.localeCompare(b)).map(([id,count])=>({id,count}))};
}

function coverageAccounting(registry:DistrictRegistry,municipalities:DistrictCoverage['municipalities']):DistrictCoverage['accounting']{
 const checkedMunicipalities=municipalities.filter(city=>city.checked).length;
 return {registryMunicipalities:registry.inventory.length,configuredMunicipalities:municipalities.length,checkedMunicipalities,
  runSelectedMunicipalities:municipalities.some(city=>city.extraction.runSelectedDocumentGroups===null)?null:municipalities.filter(city=>city.extraction.runSelectedDocumentGroups!>0).length,
  preparedMunicipalities:municipalities.some(city=>city.extraction.preparedDocumentGroups===null)?null:municipalities.filter(city=>city.extraction.preparedDocumentGroups!>0).length,
  attemptedMunicipalities:municipalities.filter(city=>city.extraction.attemptedDocumentGroups+city.extraction.unavailableAttemptedDocumentGroups>0).length,
  publishedMunicipalities:municipalities.filter(city=>city.publishedRecords>0).length,checkedWithoutPublishedMunicipalities:municipalities.filter(city=>city.checked&&city.publishedRecords===0).length,unvisitedMunicipalities:registry.inventory.length-checkedMunicipalities};
}

/** Safe release/list projection: no held candidate, date, URL, quote or producer reason text. */
export function projectDistrictCoverage(coverage:DistrictCoverage){
 return {accounting:coverage.accounting,districts:coverage.districts,models:coverage.models,adapters:coverage.adapters.map(({family,operation,adapterId,adapterVersion,municipalityId,sourceId,coverage,publishedRecords})=>({family,operation,adapterId,adapterVersion,municipalityId,sourceId,coverage,publishedRecords})),municipalities:coverage.municipalities.map(({id,status,checked,publishedRecords,textModelRecords,structuredRecords,datedStagedRecords,quarantinedRecords,quarantineReasons,extraction})=>({id,status,checked,publishedRecords,textModelRecords,structuredRecords,datedStagedRecords,quarantinedRecords,quarantineReasons,extraction}))};
}

export type KnowledgePublicationHoldReason='missing_sourced_date'|'nonpublic_evidence_url';
export type KnowledgePublicationHold={reasons:KnowledgePublicationHoldReason[];urlIssues:PublicUrlIssue[]};
/** Reject evidence as a whole; never repair or strip words from a source quotation. */
export function knowledgePublicationHold<T extends Pick<DistrictKnowledgeRecord,'documentDate'|'stageDate'|'stages'>|StructuredKnowledgeRecord>(record:T):KnowledgePublicationHold|null{
 const reasons:KnowledgePublicationHoldReason[]=[];
 if('kind' in record&&record.kind==='structured'?!structuredRecordHasSourcedDate(record):record.documentDate===null&&record.stageDate===null&&!record.stages.some(event=>event.date!==null))reasons.push('missing_sourced_date');
 const urlIssues=publicUrlIssues(record);
 if(urlIssues.length)reasons.push('nonpublic_evidence_url');
 return reasons.length?{reasons,urlIssues}:null;
}
/** Retain structured publication reasons privately so public counts never need to parse evidence text. */
export function knowledgePublicationQuarantineCase(record:(Pick<DistrictKnowledgeRecord,'id'|'municipalityId'>&{sources:{id:string}[];extraction:{inputSha256:string}})|StructuredKnowledgeRecord,hold:KnowledgePublicationHold){
 const structured='kind' in record&&record.kind==='structured';
 return {kind:structured?'structured' as const:'text_model' as const,municipalityId:record.municipalityId,sourceId:structured?record.source.id:record.sources[0].id,sourceSha256:structured?record.source.sha256:record.extraction.inputSha256,reason:`Publication withheld: ${hold.reasons.join(', ')}`,publicationReasons:hold.reasons,recordId:record.id};
}

export function knowledgeRecordHasSourcedAction(record:Pick<DistrictKnowledgeRecord,'kind'|'stage'|'documentDate'|'stageDate'|'stages'>|StructuredKnowledgeRecord):boolean{
 return record.kind==='structured'?structuredRecordHasSourcedAction(record):record.stage!=='unknown'&&(record.documentDate!==null||record.stageDate!==null||record.stages.some(event=>event.date!==null));
}
function recordUsesSource(record:DistrictCoverageRecord,sourceId:string):boolean{
 return record.kind==='structured'?record.source.id===sourceId||record.supportingSources.some(source=>source.id===sourceId):record.sources.some(source=>source.id===sourceId);
}
/** Public counts only: raw documents, failed model output, paths and credentials never enter this projection. */
type CrawlCheck=z.infer<typeof crawlSummarySchema>['checks'][number];
function publicSourceObservation(check:CrawlCheck):z.infer<typeof sourceObservation>{
 const observed=check.coverage;
 const coverage:z.infer<typeof crawlCoverage>=observed?{state:observed.state,pendingCount:observed.pendingCount,runnableCount:observed.runnableCount,blockedCount:observed.blockedCount,...(observed.scope?{scope:observed.scope}:{}),...(observed.sourceCoverage?{sourceCoverage:observed.sourceCoverage}:{}),...(observed.targetScope?{targetScope:{...observed.targetScope,urls:observed.targetScope.urls.map(url=>url!==null&&isPublicUrl(url)?url:null)}}:{}),...(observed.action?{action:observed.action}:{})}:{state:'not_checked',pendingCount:0,runnableCount:0,blockedCount:0};
 if(coverage.targetScope&&(coverage.state!=='partial'||coverage.sourceCoverage!=='not_assessed'))throw Error('Targeted crawl cannot establish source-wide completeness');
 const failures=check.blocked??[];
 return sourceObservation.parse({runId:check.runId??null,crawlState:check.checkState,checkedAt:check.checkedAt,documentCount:check.documentCount,coverage,failedLinkCount:failures.length,failureExamples:failures.slice(0,3).map(item=>({url:isPublicUrl(item.url)?item.url:null,failure:item.failure,checkedAt:item.checkedAt,action:'ask_municipality'})),...(check.reason?{reason:check.reason}:{})});
}
function selectSourceObservation(observations:z.infer<typeof sourceObservation>[]){
 const ordered=observations.map((observation,index)=>({observation,index})).sort((a,b)=>(a.observation.checkedAt===null?-Infinity:Date.parse(a.observation.checkedAt))-(b.observation.checkedAt===null?-Infinity:Date.parse(b.observation.checkedAt))||a.index-b.index);
 const broader=ordered.filter(({observation})=>observation.checkedAt!==null&&!observation.coverage.targetScope&&observation.coverage.sourceCoverage!=='not_assessed');
 const selected=(broader.length?broader:ordered).at(-1)?.observation;
 return {selected,coverageSelection:!selected?'none' as const:selected.coverage.targetScope||selected.coverage.sourceCoverage==='not_assessed'?'latest_targeted_observation' as const:'latest_non_targeted_observation' as const};
}
const groupKey=(municipalityId:string,sourceSha256:string)=>JSON.stringify([municipalityId,sourceSha256]);
function assertLineageRecords(lineage:TextRunLineage,records:TextCoverageRecord[]){
 const origins=new Map(lineage.selectedRecordOrigins.map(origin=>[origin.recordId,origin]));
 if(origins.size!==records.length||origins.size!==lineage.selectedRecordOrigins.length)throw Error('Text lineage selected-record inventory mismatch');
 const attempted=new Set(lineage.cumulative.groupBindings.attempted.map(group=>groupKey(group.municipalityId,group.sourceSha256))),runs=new Map(lineage.runs.map(run=>[run.runId,run]));
 for(const record of records){
  const origin=origins.get(record.id),run=origin&&runs.get(origin.runId);
  if(!origin||!run||origin.municipalityId!==record.municipalityId||origin.sourceSha256!==record.extraction.inputSha256||origin.currentEvidenceHash!==record.verification.evidenceHash||modelKey(origin.model)!==modelKey(record.extraction)||origin.extractionResponseSha256!==record.extraction.responseSha256||origin.judgeResponseSha256!==record.verification.faithfulness.responseSha256||origin.promptSha256!==record.extraction.promptSha256||origin.judgePromptSha256!==record.extraction.judgePromptSha256||!attempted.has(groupKey(record.municipalityId,record.extraction.inputSha256)))throw Error('Text lineage record/generation binding mismatch');
  if(run.assignmentMode==='codex-only'&&record.extraction.provider!=='openai-subscription')throw Error('Codex-only assignment cannot claim another provider');
 }
}
export function buildDistrictCoverage(registry:DistrictRegistry,crawlInput:unknown,records:DistrictCoverageRecord[],quarantineInput:unknown,lineageInput:unknown,generatedAt?:string,structuredInput?:unknown,retainedPublicationInput:RetainedKnowledgeLineage|null=null):DistrictCoverage{
 const crawl=crawlSummarySchema.parse(crawlInput),quarantine=quarantineSummarySchema.parse(quarantineInput),textLineage=lineageInput==null?null:textRunLineageSchema.parse(lineageInput),retainedPublication=retainedPublicationInput===null?null:RetainedKnowledgeLineageSchema.parse(retainedPublicationInput),structured=structuredInput===undefined?null:structuredRunSchema.parse(structuredInput);
 const textRecords=records.filter((record):record is TextCoverageRecord=>record.kind==='text_model'),structuredRecords=records.filter((record):record is StructuredKnowledgeRecord=>record.kind==='structured');
 const retainedIds=new Set(retainedPublication?.selectedRecordOrigins.map(origin=>origin.recordId)??[]);
 if(structured)validateStructuredRun(structured,registry,structuredRecords);else if(structuredRecords.length)throw Error('Structured records require their bound structured run');
 if(!textLineage&&(textRecords.some(record=>!retainedIds.has(record.id))||quarantine.cases.some(item=>item.kind!=='structured')))throw Error('Text outputs require their authentic text lineage');
 if(new Set(retainedPublication?.selectedRecordOrigins.map(origin=>origin.recordId)??[]).size!==(retainedPublication?.selectedRecordOrigins.length??0)||[...retainedIds].some(id=>!records.some(record=>record.id===id)))throw Error('Retained publication origin inventory mismatch');
 for(const origin of retainedPublication?.selectedRecordOrigins??[]){
  const record=records.find(item=>item.id===origin.recordId)!;
  if(origin.currentEvidenceHash!==record.verification.evidenceHash||origin.currentRecordSha256!==textLineageRecordSha256(record)||origin.municipalityId!==record.municipalityId||origin.sourceSha256!==record.extraction.inputSha256)throw Error('Retained publication record/origin binding mismatch');
 }
 const models=new Map<string,z.infer<typeof admittedModelSchema>>();
 for(const record of textRecords){
  const {provider,model,tool,toolVersion,modelIdentitySha256,modelIdentityBasis}=record.extraction,key=modelKey(record.extraction),existing=models.get(key);
  if(existing)existing.publishedRecords++;
  else models.set(key,{provider,model,tool,toolVersion,modelIdentitySha256,modelIdentityBasis,faithfulnessThreshold:0.8,publishedRecords:1});
 }
 const municipalities=registry.municipalities.map(city=>{
  const documents=crawl.documents.filter(doc=>doc.municipalityId===city.id),published=records.filter(record=>record.municipalityId===city.id),withheld=quarantine.cases.filter(item=>item.municipalityId===city.id);
  const checks=crawl.checks.filter(check=>check.municipalityId===city.id);
  const fetched=new Set(documents.map(document=>document.sha256));
  const attempted=new Set(textLineage?.cumulative.groupBindings.attempted.filter(group=>group.municipalityId===city.id).map(group=>group.sourceSha256)??[]);
  for(const hash of [...published.filter((record):record is TextCoverageRecord=>record.kind==='text_model'&&!retainedIds.has(record.id)).map(record=>record.extraction.inputSha256),...withheld.filter(item=>item.kind!=='structured'&&!(item.recordId&&retainedIds.has(item.recordId))).map(item=>item.sourceSha256)])if(!attempted.has(hash))throw Error('Text lineage omits a source-bound published or quarantined attempt');
  const present=[...attempted].filter(hash=>fetched.has(hash)).length;
  const groups=textLineage?.cumulative.groupBindings;
  const extraction={fetchedDocumentGroups:fetched.size,runSelectedDocumentGroups:groups?.selected==null?null:groups.selected.filter(group=>group.municipalityId===city.id).length,preparedDocumentGroups:groups?.prepared==null?null:groups.prepared.filter(group=>group.municipalityId===city.id).length,attemptedDocumentGroups:present,pendingDocumentGroups:fetched.size-present,unavailableAttemptedDocumentGroups:attempted.size-present};
  const checked=documents.length>0||attempted.size>0||checks.some(check=>check.checkedAt!==null)||!!structured?.coverage.some(receipt=>receipt.municipalityId===city.id&&receipt.coverage.checkedAt!==null);
  const datedStagedRecords=published.filter(knowledgeRecordHasSourcedAction).length;
  const status=published.length?'gated_records' as const:checked?'checked_no_gated_records' as const:'not_checked' as const;
  const textModelRecords=published.filter(record=>record.kind==='text_model').length,structuredCount=published.length-textModelRecords;
  return {id:city.id,ags:city.ags,districtId:city.districtId,checked,status,documents:documents.length,publishedRecords:published.length,textModelRecords,structuredRecords:structuredCount,datedStagedRecords,quarantinedRecords:withheld.length,quarantineReasons:quarantineReasonHistogram(withheld),extraction,sources:city.sources.map(source=>{
   const observations=checks.filter(item=>item.sourceId===source.id).map(publicSourceObservation);
   const {selected:check,coverageSelection}=selectSourceObservation(observations);
   const coverage=check?.coverage??{state:'not_checked' as const,pendingCount:0,runnableCount:0,blockedCount:0};
   const sourceWithheld=withheld.filter(item=>item.sourceId===source.id);
   const sourceRecords=published.filter(record=>recordUsesSource(record,source.id)),textModelRecords=sourceRecords.filter(record=>record.kind==='text_model').length;
   return {sourceId:source.id,kind:source.kind,registryState:source.checkState,crawlState:check?.crawlState??'not_checked' as const,checkedAt:check?.checkedAt??null,documentCount:documents.filter(doc=>doc.sourceId===source.id).length,publishedRecords:sourceRecords.length,textModelRecords,structuredRecords:sourceRecords.length-textModelRecords,quarantinedRecords:sourceWithheld.length,quarantineReasons:quarantineReasonHistogram(sourceWithheld),coverage,coverageSelection,observations,failedLinkCount:check?.failedLinkCount??0,failureExamples:check?.failureExamples??[],...(check?.reason||source.reason?{reason:check?.reason??source.reason}:{})};
  })};
 });
 const districts=registry.districts.map(district=>{
  const selected=municipalities.filter(city=>city.districtId===district.id);
  return {id:district.id,ags:district.ags,municipalitiesRegistered:registry.inventory.filter(city=>city.districtId===district.id).length,municipalitiesConfigured:selected.length,municipalitiesChecked:selected.filter(city=>city.checked).length,municipalitiesAttempted:selected.filter(city=>city.extraction.attemptedDocumentGroups+city.extraction.unavailableAttemptedDocumentGroups>0).length,municipalitiesWithRecords:selected.filter(city=>city.publishedRecords>0).length,municipalitiesWithDatedStages:selected.filter(city=>city.datedStagedRecords>0).length,documents:selected.reduce((n,city)=>n+city.documents,0),publishedRecords:selected.reduce((n,city)=>n+city.publishedRecords,0),textModelRecords:selected.reduce((n,city)=>n+city.textModelRecords,0),structuredRecords:selected.reduce((n,city)=>n+city.structuredRecords,0),quarantinedRecords:selected.reduce((n,city)=>n+city.quarantinedRecords,0)};
 });
 const adapters=structured?.coverage.map(receipt=>({...projectStructuredCoverageReceipt(receipt),publishedRecords:structuredRecords.filter(record=>structuredReceiptMatches(record,receipt)).length}))??[];
 const coverage=districtCoverageSchema.parse({schemaVersion:'stadtstack-district-coverage-v5',generatedAt:generatedAt??textLineage?.generatedAt??structured?.generatedAt,accounting:coverageAccounting(registry,municipalities),districts,municipalities,models:[...models.values()].sort((a,b)=>modelKey(a).localeCompare(modelKey(b))),adapters,structuredRun:structured?{generatedAt:structured.generatedAt,registrySha256:structured.registrySha256,questionDispositionSha256:structured.questionDispositionSha256,adapterContractSha256:structured.adapterContractSha256}:null,textLineage,retainedPublication});
 validateDistrictCoverage(coverage,registry,records);return coverage;
}
export function validateDistrictCoverage(coverage:DistrictCoverage,registry:DistrictRegistry,records:DistrictCoverageRecord[]){
 if(coverage.municipalities.length!==registry.municipalities.length||new Set(coverage.municipalities.map(city=>city.id)).size!==coverage.municipalities.length)throw Error('District coverage municipality inventory mismatch');
 if(JSON.stringify(coverage.accounting)!==JSON.stringify(coverageAccounting(registry,coverage.municipalities)))throw Error('District coverage accounting mismatch');
 const textRecords=records.filter((record):record is TextCoverageRecord=>record.kind==='text_model'),structuredRecords=records.filter((record):record is StructuredKnowledgeRecord=>record.kind==='structured');
 const textLineage=coverage.textLineage===null?null:textRunLineageSchema.parse(coverage.textLineage),retainedPublication=coverage.retainedPublication===null?null:RetainedKnowledgeLineageSchema.parse(coverage.retainedPublication);
 const retainedIds=new Set(retainedPublication?.selectedRecordOrigins.map(origin=>origin.recordId)??[]),nativeTextRecords=textRecords.filter(record=>!retainedIds.has(record.id));
 if(new Set(retainedPublication?.selectedRecordOrigins.map(origin=>origin.recordId)??[]).size!==(retainedPublication?.selectedRecordOrigins.length??0))throw Error('Duplicate retained publication origin');
 for(const origin of retainedPublication?.selectedRecordOrigins??[]){
  const record=records.find(item=>item.id===origin.recordId);
  if(!record||origin.currentEvidenceHash!==record.verification.evidenceHash||origin.currentRecordSha256!==textLineageRecordSha256(record)||origin.municipalityId!==record.municipalityId||origin.sourceSha256!==record.extraction.inputSha256)throw Error('Retained publication record/origin binding mismatch');
 }
 if(textLineage)assertLineageRecords(textLineage,nativeTextRecords);else if(nativeTextRecords.length)throw Error('Missing authentic text lineage');
 const groups=textLineage?.cumulative.groupBindings,knownRuns=new Set(textLineage?.runs.map(run=>run.runId)??[]),knownCities=new Set(registry.municipalities.map(city=>city.id));
 if(!coverage.structuredRun&&(structuredRecords.length||coverage.adapters.length))throw Error('Missing structured run provenance');
 for(const adapter of coverage.adapters){
  if(!registry.municipalities.some(city=>city.id===adapter.municipalityId&&city.sources.some(source=>source.id===adapter.sourceId)))throw Error('Structured adapter registry binding mismatch');
  const actual=structuredRecords.filter(record=>structuredReceiptMatches(record,adapter)).length;
  if(adapter.publishedRecords!==actual||actual>0&&(!adapter.stepReceiptSha256||!['complete','partial'].includes(adapter.coverage.state)))throw Error('Structured adapter published record binding mismatch');
 }
 for(const record of structuredRecords)if(coverage.adapters.filter(adapter=>structuredReceiptMatches(record,adapter)).length!==1)throw Error('Missing or duplicated structured adapter provenance');
 const admitted=new Map(coverage.models.map(model=>[modelKey(model),model]));
 if(admitted.size!==coverage.models.length)throw Error('Duplicate admitted model identity');
 for(const model of coverage.models){
  const actual=textRecords.filter(record=>modelKey(record.extraction)===modelKey(model)).length;
  if(model.publishedRecords!==actual||actual===0)throw Error('District coverage model provenance mismatch');
 }
 for(const record of textRecords)if(!admitted.has(modelKey(record.extraction)))throw Error('Missing admitted model provenance');
 const totalAttempted=coverage.municipalities.reduce((n,city)=>n+city.extraction.attemptedDocumentGroups+city.extraction.unavailableAttemptedDocumentGroups,0);
 if((textLineage?.cumulative.groups.attemptedDocumentGroups??0)!==totalAttempted)throw Error('Extraction lineage counts do not bind to actual source-bound outputs');
 for(const city of coverage.municipalities){
  const registered=registry.municipalities.find(item=>item.id===city.id);
  if(!registered||registered.ags!==city.ags||registered.districtId!==city.districtId||city.publishedRecords!==records.filter(record=>record.municipalityId===city.id).length)throw Error(`District coverage record binding mismatch: ${city.id}`);
  const cityRecords=records.filter(record=>record.municipalityId===city.id),datedStagedRecords=cityRecords.filter(knowledgeRecordHasSourcedAction).length,textModelRecords=cityRecords.filter(record=>record.kind==='text_model').length;
  if(city.textModelRecords!==textModelRecords||city.structuredRecords!==cityRecords.length-textModelRecords)throw Error('Municipality record kind count mismatch');
  const status=city.publishedRecords?'gated_records':city.checked?'checked_no_gated_records':'not_checked';
  if(city.status!==status||city.datedStagedRecords!==datedStagedRecords)throw Error(`Municipality admission coverage mismatch: ${city.id}`);
  const extraction=city.extraction,publishedGroups=new Set(textRecords.filter(record=>record.municipalityId===city.id).map(record=>record.extraction.inputSha256)).size;
  if(extraction.fetchedDocumentGroups!==extraction.attemptedDocumentGroups+extraction.pendingDocumentGroups||extraction.fetchedDocumentGroups>city.documents||extraction.attemptedDocumentGroups<publishedGroups)throw Error(`Extraction coverage mismatch: ${city.id}`);
  const attempts=extraction.attemptedDocumentGroups+extraction.unavailableAttemptedDocumentGroups;
  const expectedAttempts=groups?.attempted.filter(group=>group.municipalityId===city.id).length??0,expectedSelected=groups?.selected==null?null:groups.selected.filter(group=>group.municipalityId===city.id).length,expectedPrepared=groups?.prepared==null?null:groups.prepared.filter(group=>group.municipalityId===city.id).length;
  if(attempts!==expectedAttempts||extraction.runSelectedDocumentGroups!==expectedSelected||extraction.preparedDocumentGroups!==expectedPrepared)throw Error(`Extraction lineage municipality binding mismatch: ${city.id}`);
  if((city.documents>0||attempts>0)&&!city.checked||extraction.runSelectedDocumentGroups!==null&&extraction.runSelectedDocumentGroups<attempts||extraction.preparedDocumentGroups!==null&&(extraction.runSelectedDocumentGroups===null||extraction.preparedDocumentGroups>extraction.runSelectedDocumentGroups))throw Error(`Extraction selection/preparation coverage mismatch: ${city.id}`);
  for(const entry of [city,...city.sources]){
   const histogram=entry.quarantineReasons;
   if(new Set(histogram.categories.map(row=>row.reason)).size!==histogram.categories.length||new Set(histogram.failedDeterministicChecks.map(row=>row.id)).size!==histogram.failedDeterministicChecks.length||histogram.categories.some(row=>row.count===0||row.count>entry.quarantinedRecords)||histogram.failedDeterministicChecks.some(row=>row.count===0||row.count>(histogram.categories.find(row=>row.reason==='deterministic_gate_failed')?.count??0))||histogram.categories.reduce((n,row)=>n+row.count,0)<entry.quarantinedRecords)throw Error('Quarantine reason histogram count mismatch');
  }
  if(city.quarantinedRecords!==city.sources.reduce((n,source)=>n+source.quarantinedRecords,0))throw Error('Quarantine source totals mismatch');
  for(const reason of quarantineReason.options)if((city.quarantineReasons.categories.find(row=>row.reason===reason)?.count??0)!==city.sources.reduce((n,source)=>n+(source.quarantineReasons.categories.find(row=>row.reason===reason)?.count??0),0))throw Error('Quarantine source reason totals mismatch');
  for(const id of publicCheckId.options)if((city.quarantineReasons.failedDeterministicChecks.find(row=>row.id===id)?.count??0)!==city.sources.reduce((n,source)=>n+(source.quarantineReasons.failedDeterministicChecks.find(row=>row.id===id)?.count??0),0))throw Error('Quarantine source check totals mismatch');
  if(city.sources.length!==registered.sources.length||new Set(city.sources.map(source=>source.sourceId)).size!==city.sources.length)throw Error(`District source coverage mismatch: ${city.id}`);
  for(const source of city.sources){
   const sourceRecords=cityRecords.filter(record=>recordUsesSource(record,source.sourceId)),textModelRecords=sourceRecords.filter(record=>record.kind==='text_model').length;
   if(!registered.sources.some(item=>item.id===source.sourceId&&item.kind===source.kind)||source.publishedRecords!==sourceRecords.length||source.textModelRecords!==textModelRecords||source.structuredRecords!==sourceRecords.length-textModelRecords)throw Error(`District source record count mismatch: ${city.id}`);
   for(const observation of source.observations){if(observation.runId!==null&&!knownRuns.has(observation.runId))throw Error('Source observation refers to an unknown text contribution');if(observation.coverage.targetScope&&(observation.coverage.state!=='partial'||observation.coverage.sourceCoverage!=='not_assessed'))throw Error('Targeted crawl cannot establish source-wide completeness');}
   const {selected,coverageSelection}=selectSourceObservation(source.observations),expectedCoverage=selected?.coverage??{state:'not_checked',pendingCount:0,runnableCount:0,blockedCount:0};
   if(source.coverageSelection!==coverageSelection||source.crawlState!==(selected?.crawlState??'not_checked')||source.checkedAt!==(selected?.checkedAt??null)||JSON.stringify(source.coverage)!==JSON.stringify(expectedCoverage)||source.failedLinkCount!==(selected?.failedLinkCount??0)||JSON.stringify(source.failureExamples)!==JSON.stringify(selected?.failureExamples??[]))throw Error('Source coverage does not retain its selected scoped observation');
  }
 }
 if(coverage.districts.length!==registry.districts.length||new Set(coverage.districts.map(d=>d.id)).size!==coverage.districts.length)throw Error('District coverage identity mismatch');
 for(const district of coverage.districts){
  const registered=registry.districts.find(item=>item.id===district.id),cities=coverage.municipalities.filter(city=>city.districtId===district.id);
  if(!registered||registered.ags!==district.ags||district.municipalitiesRegistered!==registry.inventory.filter(city=>city.districtId===district.id).length||district.municipalitiesConfigured!==cities.length||district.publishedRecords!==cities.reduce((n,city)=>n+city.publishedRecords,0)||district.municipalitiesWithRecords!==cities.filter(city=>city.publishedRecords>0).length||district.municipalitiesWithDatedStages!==cities.filter(city=>city.datedStagedRecords>0).length)throw Error(`District coverage totals mismatch: ${district.id}`);
  if(district.textModelRecords!==cities.reduce((n,city)=>n+city.textModelRecords,0)||district.structuredRecords!==cities.reduce((n,city)=>n+city.structuredRecords,0))throw Error('District record kind count mismatch');
  if(district.municipalitiesChecked!==cities.filter(city=>city.checked).length||district.municipalitiesAttempted!==cities.filter(city=>city.extraction.attemptedDocumentGroups+city.extraction.unavailableAttemptedDocumentGroups>0).length||district.documents!==cities.reduce((n,city)=>n+city.documents,0)||district.quarantinedRecords!==cities.reduce((n,city)=>n+city.quarantinedRecords,0))throw Error(`District coverage attempt/quarantine totals mismatch: ${district.id}`);
 }
}

export type KnowledgeSliceEvidence=Pick<DistrictKnowledgeRecord,'kind'|'id'|'districtId'|'municipalityId'|'documentDate'|'stageDate'|'stage'|'stages'>|StructuredKnowledgeRecord;
/** Individual date gates are unchanged; nine towns is an expansion target, not a fact-quality gate. */
export function assertKnowledgeSlice(registry:DistrictRegistry,records:KnowledgeSliceEvidence[],minimum=1){
 for(const record of records)if(record.kind==='structured'?!structuredRecordHasSourcedDate(record):record.documentDate===null&&record.stageDate===null&&!record.stages.some(event=>event.date!==null))throw Error(`Undated knowledge withheld from publication: ${record.id}`);
 for(const district of registry.districts){
  const municipalities=new Set(records.filter(record=>record.districtId===district.id&&knowledgeRecordHasSourcedAction(record)).map(record=>record.municipalityId));
  if(municipalities.size<minimum)throw Error(`Dated, source-staged slice incomplete for ${district.id}: ${municipalities.size}/${minimum}`);
 }
}
