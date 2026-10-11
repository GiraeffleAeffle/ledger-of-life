import {z} from 'zod';
import type {DistrictRegistry} from './district-registry.ts';
import {REQUIRED_DETERMINISTIC_CHECKS,type DistrictKnowledgeRecord} from './district-schema.ts';
import {GRAPH_DETERMINISTIC_CHECKS} from './district-graph-claims.ts';
import {isPublicUrl,publicUrlIssues,type PublicUrlIssue} from './publication-quality.ts';
import {PROVIDER_CONFIGS,type ModelEvidence} from './district-model-contract.ts';
import {textRunLineageSchema,textLineageRecordSha256,type TextRunLineage} from './text-run-lineage.ts';
import {RetainedKnowledgeLineageSchema,validateRetainedKnowledgeComposition,type RetainedKnowledgeComposition,type RetainedKnowledgeLineage} from './retained-knowledge-lineage.ts';
import {districtCoverageScopeSchema,retainedHistoricalCoverageSchema,projectRetainedHistoricalCoverage} from './retained-knowledge-coverage.ts';

const count=z.number().int().nonnegative();
const admittedModelSchema=z.object({provider:z.enum(['openai-subscription','anthropic-subscription']),model:z.string().min(1),tool:z.enum(['codex-cli','claude-cli']),toolVersion:z.string().min(1),modelIdentitySha256:z.string().regex(/^[a-f0-9]{64}$/),modelIdentityBasis:z.enum(['configured-cli-model-and-tool-version','reported-cli-model-and-tool-version']),faithfulnessThreshold:z.literal(0.8),publishedRecords:count}).strict();
function modelKey(model:ModelEvidence):string{return JSON.stringify([model.provider,model.model,model.tool,model.toolVersion,model.modelIdentitySha256,model.modelIdentityBasis]);}
const checkState=z.enum(['checked','not_found','not_checked']);
const publicCheckId=z.enum([...REQUIRED_DETERMINISTIC_CHECKS,...GRAPH_DETERMINISTIC_CHECKS,'judge_critical_claims']);
const quarantineReason=z.enum(['deterministic_gate_failed','faithfulness_gate_failed','no_supported_case','invalid_structured_output','document_limit','preparation_failed','extraction_failed','missing_sourced_date','nonpublic_evidence_url','source_binding_unknown','unknown']);
/** Counts are quarantine entries, not projects; one entry may have several reasons/check failures. */
export const quarantineReasonHistogramSchema=z.object({categories:z.array(z.object({reason:quarantineReason,count}).strict()),failedDeterministicChecks:z.array(z.object({id:publicCheckId,count}).strict())}).strict();
export type QuarantineReasonHistogram=z.infer<typeof quarantineReasonHistogramSchema>;
export const districtCoverageAccountingSchema=z.object({registryMunicipalities:count,configuredMunicipalities:count,checkedMunicipalities:count,runSelectedMunicipalities:count.nullable(),preparedMunicipalities:count.nullable(),attemptedMunicipalities:count,publishedMunicipalities:count,checkedWithoutPublishedMunicipalities:count,unvisitedMunicipalities:count}).strict();
const targetScope=z.object({kind:z.enum(['page_roots','seed_documents']),urls:z.array(z.url().nullable()),state:z.enum(['complete','partial','blocked']),pendingCount:count,runnableCount:count,blockedCount:count}).strict();
const crawlCoverage=z.object({state:z.enum(['complete','partial','blocked','not_checked']),pendingCount:count,runnableCount:count,blockedCount:count,scope:z.string().optional(),sourceCoverage:z.literal('not_assessed').optional(),targetScope:targetScope.optional(),action:z.literal('ask_municipality').optional()}).strict();
const blockedEvidence=z.object({url:z.string().url().nullable(),failure:z.string(),checkedAt:z.string().datetime({offset:true}),action:z.literal('ask_municipality')}).strict();
const sourceObservation=z.object({runId:z.string().regex(/^[a-f0-9]{64}$/).nullable(),crawlState:checkState,checkedAt:z.string().datetime({offset:true}).nullable(),documentCount:count,coverage:crawlCoverage,failedLinkCount:count,failureExamples:z.array(blockedEvidence).max(3),reason:z.string().optional()}).strict().refine(value=>value.failureExamples.length<=value.failedLinkCount,'Failure examples exceed observed failure count');
const sourceCoverage=z.object({sourceId:z.string(),kind:z.string(),registryState:checkState,crawlState:checkState,checkedAt:z.string().datetime({offset:true}).nullable(),documentCount:count,publishedRecords:count,quarantinedRecords:count,quarantineReasons:quarantineReasonHistogramSchema,coverage:crawlCoverage,coverageSelection:z.enum(['latest_non_targeted_observation','latest_targeted_observation','none']),observations:z.array(sourceObservation),failedLinkCount:count,failureExamples:z.array(blockedEvidence).max(3),reason:z.string().optional()}).strict().refine(value=>value.failureExamples.length<=value.failedLinkCount,'Failure examples exceed observed failure count');
const extractionCounts=z.object({fetchedDocumentGroups:count,runSelectedDocumentGroups:count.nullable(),preparedDocumentGroups:count.nullable(),attemptedDocumentGroups:count,pendingDocumentGroups:count,unavailableAttemptedDocumentGroups:count}).strict();
export const districtCoverageSchema=z.object({
 schemaVersion:z.literal('stadtstack-district-coverage-v4'),generatedAt:z.string().datetime({offset:true}),
 accounting:districtCoverageAccountingSchema,
 districts:z.array(z.object({id:z.string(),ags:z.string().regex(/^\d{5}$/),municipalitiesRegistered:count,municipalitiesConfigured:count,municipalitiesChecked:count,municipalitiesAttempted:count,municipalitiesWithRecords:count,municipalitiesWithDatedStages:count,documents:count,publishedRecords:count,quarantinedRecords:count}).strict()),
 municipalities:z.array(z.object({id:z.string(),ags:z.string().regex(/^\d{8}$/),districtId:z.string(),checked:z.boolean(),status:z.enum(['gated_records','checked_no_gated_records','not_checked']),documents:count,publishedRecords:count,datedStagedRecords:count,quarantinedRecords:count,quarantineReasons:quarantineReasonHistogramSchema,extraction:extractionCounts,sources:z.array(sourceCoverage)}).strict()),
 models:z.array(admittedModelSchema),
 textLineage:textRunLineageSchema.nullable(),
 retainedPublication:RetainedKnowledgeLineageSchema.nullable(),
 historicalCoverage:retainedHistoricalCoverageSchema.nullable(),
 coverageScope:districtCoverageScopeSchema,
}).strict();
export type DistrictCoverage=z.infer<typeof districtCoverageSchema>;
export type DistrictCoverageRecord=Pick<DistrictKnowledgeRecord,'id'|'municipalityId'|'documentDate'|'stageDate'|'stage'|'stages'>&{extraction:ModelEvidence&Pick<DistrictKnowledgeRecord['extraction'],'inputSha256'|'responseSha256'|'promptSha256'|'judgePromptSha256'>&{extractedAt?:string};verification:{evidenceHash:string;faithfulness:{responseSha256:string|null;evaluatedAt?:string}};sources:{id:string}[]};
export const crawlSummarySchema=z.object({schemaVersion:z.literal('stadtstack-crawl-index-v1'),generatedAt:z.string(),documents:z.array(z.object({id:z.string(),municipalityId:z.string(),sourceId:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough()),checks:z.array(z.object({municipalityId:z.string(),sourceId:z.string(),runId:z.string().regex(/^[a-f0-9]{64}$/).optional(),checkState,checkedAt:z.string().nullable(),documentCount:count,reason:z.string().optional(),coverage:crawlCoverage.passthrough().optional(),blocked:z.array(z.object({url:z.string(),failure:z.string(),checkedAt:z.string()}).passthrough()).optional()}).passthrough())}).passthrough();
const quarantineCandidateSchema=z.object({municipalityId:z.string(),extraction:z.object({inputSha256:z.string()}),sources:z.array(z.object({id:z.string(),sha256:z.string()})),verification:z.object({deterministic:z.object({passed:z.boolean(),checks:z.array(z.object({id:z.string(),passed:z.boolean()}))}),faithfulness:z.object({score:z.number().nullable(),threshold:z.number(),responseSha256:z.string().nullable()})})});
const quarantineCaseSummarySchema=z.object({municipalityId:z.string(),sourceId:z.string(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string(),candidate:quarantineCandidateSchema.optional(),publicationReasons:z.array(z.enum(['missing_sourced_date','nonpublic_evidence_url'])).optional()}).strip();
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
 return {accounting:coverage.accounting,districts:coverage.districts,municipalities:coverage.municipalities.map(({id,status,checked,publishedRecords,datedStagedRecords,quarantinedRecords,quarantineReasons,extraction})=>({id,status,checked,publishedRecords,datedStagedRecords,quarantinedRecords,quarantineReasons,extraction})),coverageScope:coverage.coverageScope,historicalCoverage:coverage.historicalCoverage};
}

export type KnowledgePublicationHoldReason='missing_sourced_date'|'nonpublic_evidence_url';
export type KnowledgePublicationHold={reasons:KnowledgePublicationHoldReason[];urlIssues:PublicUrlIssue[]};
/** Reject evidence as a whole; never repair or strip words from a source quotation. */
export function knowledgePublicationHold<T extends Pick<DistrictKnowledgeRecord,'documentDate'|'stageDate'|'stages'>>(record:T):KnowledgePublicationHold|null{
 const reasons:KnowledgePublicationHoldReason[]=[];
 if(record.documentDate===null&&record.stageDate===null&&!record.stages.some(event=>event.date!==null))reasons.push('missing_sourced_date');
 const urlIssues=publicUrlIssues(record);
 if(urlIssues.length)reasons.push('nonpublic_evidence_url');
 return reasons.length?{reasons,urlIssues}:null;
}
/** Retain structured publication reasons privately so public counts never need to parse evidence text. */
export function knowledgePublicationQuarantineCase(record:Pick<DistrictKnowledgeRecord,'id'|'municipalityId'>&{sources:{id:string}[];extraction:{inputSha256:string}},hold:KnowledgePublicationHold){
 return {municipalityId:record.municipalityId,sourceId:record.sources[0].id,sourceSha256:record.extraction.inputSha256,reason:`Publication withheld: ${hold.reasons.join(', ')}`,publicationReasons:hold.reasons,recordId:record.id};
}

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
function assertLineageRecords(lineage:TextRunLineage,records:DistrictCoverageRecord[]){
 const origins=new Map(lineage.selectedRecordOrigins.map(origin=>[origin.recordId,origin]));
 if(origins.size!==records.length||origins.size!==lineage.selectedRecordOrigins.length)throw Error('Text lineage selected-record inventory mismatch');
 const attempted=new Set(lineage.cumulative.groupBindings.attempted.map(group=>groupKey(group.municipalityId,group.sourceSha256)));
 const runs=new Map(lineage.runs.map(run=>[run.runId,run]));
 for(const record of records){
  const origin=origins.get(record.id),run=origin&&runs.get(origin.runId);
  if(!origin||!run||origin.municipalityId!==record.municipalityId||origin.sourceSha256!==record.extraction.inputSha256||origin.currentEvidenceHash!==record.verification.evidenceHash||modelKey(origin.model)!==modelKey(record.extraction)||origin.extractionResponseSha256!==record.extraction.responseSha256||origin.judgeResponseSha256!==record.verification.faithfulness.responseSha256||origin.promptSha256!==record.extraction.promptSha256||origin.judgePromptSha256!==record.extraction.judgePromptSha256||!attempted.has(groupKey(record.municipalityId,record.extraction.inputSha256)))throw Error('Text lineage record/generation binding mismatch');
  if(run.assignmentMode==='codex-only'&&record.extraction.provider!=='openai-subscription')throw Error('Codex-only assignment cannot claim another provider');
 }
}

function coverageScope(retained:boolean):DistrictCoverage['coverageScope']{
 return {publishedRecords:'selected_native_and_retained',sourceObservations:'native_contributions_only',documents:'native_contributions_only',extractionGroups:'native_contributions_only',quarantinedRecords:'native_contributions_only',crossCohortUniqueDocumentGroups:retained?'unknown':'native_only'};
}
const emptyNativeGroups={fetched:[],attempted:[],selected:[],prepared:[]} satisfies TextRunLineage['cumulative']['groupBindings'];
function assertPublicationOrigins(lineage:TextRunLineage|null,retained:RetainedKnowledgeLineage|null,registry:DistrictRegistry,records:DistrictCoverageRecord[]){
 if(!lineage&&!retained)throw Error('District coverage requires native or authenticated retained provenance');
 if(lineage?.runs.some(run=>run.sourceArtifactKind!=='native_extraction_output'))throw Error('Current native lineage cannot contain a retained publication contribution');
 if(lineage?.selectedRecordOrigins.some(origin=>origin.schemaProjection!==null)||retained!==null&&retained.schemaProjection!==null)throw Error('Knowledge-v2 coverage cannot admit a schema projection');
 const origins=new Map((retained?.selectedRecordOrigins??[]).map(origin=>[origin.recordId,origin]));
 const nativeIds=new Set(lineage?.selectedRecordOrigins.map(origin=>origin.recordId)??[]);
 if(new Set(records.map(record=>record.id)).size!==records.length||origins.size!==(retained?.selectedRecordOrigins.length??0)||[...origins.keys()].some(id=>nativeIds.has(id)))throw Error('Split publication provenance has duplicate selected records');
 const nativeRecords=records.filter(record=>!origins.has(record.id));
 if(lineage)assertLineageRecords(lineage,nativeRecords);
 else if(nativeRecords.length)throw Error('Retained publication omits selected-record provenance');
 if(origins.size!==records.length-nativeRecords.length)throw Error('Retained publication selected-record inventory mismatch');
 for(const record of records){
  const city=registry.municipalities.find(city=>city.id===record.municipalityId);
  if(!city||!record.sources.length||record.sources.some(source=>!city.sources.some(item=>item.id===source.id)))throw Error('Publication record municipality/source binding mismatch');
  const origin=origins.get(record.id);if(!origin)continue;
  const sourceIds=[...new Set(record.sources.map(source=>source.id))].sort();
  const registrySources=sourceIds.map(id=>{const source=city.sources.find(source=>source.id===id)!;return {id:source.id,kind:source.kind,url:source.url};});
  if(origin.schemaProjection!==null)throw Error('Knowledge-v2 coverage cannot admit a retained schema projection');
  if(origin.municipalityId!==record.municipalityId||origin.sourceSha256!==record.extraction.inputSha256||origin.currentEvidenceHash!==record.verification.evidenceHash||origin.currentRecordSha256!==textLineageRecordSha256(record)||JSON.stringify([...origin.sourceIds].sort())!==JSON.stringify(sourceIds)||origin.registrySourcesSha256!==textLineageRecordSha256(registrySources)||modelKey(origin.model)!==modelKey(record.extraction)||origin.extractionResponseSha256!==record.extraction.responseSha256||origin.judgeResponseSha256!==record.verification.faithfulness.responseSha256||origin.promptSha256!==record.extraction.promptSha256||origin.judgePromptSha256!==record.extraction.judgePromptSha256||origin.extractedAt!==record.extraction.extractedAt||origin.evaluatedAt!==record.verification.faithfulness.evaluatedAt)throw Error('Retained publication record/source/model binding mismatch');
 }
 return nativeRecords;
}

/** Public counts only: raw documents, failed model output, paths and credentials never enter this projection. */
export function buildDistrictCoverage(registry:DistrictRegistry,crawlInput:unknown,records:DistrictCoverageRecord[],quarantineInput:unknown,lineageInput:unknown,generatedAt=new Date().toISOString(),retainedInput:RetainedKnowledgeComposition|null=null):DistrictCoverage{
 const crawl=crawlSummarySchema.parse(crawlInput),quarantine=quarantineSummarySchema.parse(quarantineInput),textLineage=lineageInput===null?null:textRunLineageSchema.parse(lineageInput);
 const retained=retainedInput===null?null:validateRetainedKnowledgeComposition(retainedInput);
 const retainedPublication=retained===null?null:RetainedKnowledgeLineageSchema.parse({...retained.baseline.lineage,selectedRecordOrigins:retained.selectedRecordOrigins});
 const historicalCoverage=retained===null?null:projectRetainedHistoricalCoverage(retained.baseline.coverage);
 const nativeRecords=assertPublicationOrigins(textLineage,retainedPublication,registry,records),groups=textLineage?.cumulative.groupBindings??emptyNativeGroups;
 if(!textLineage&&(crawl.documents.length||crawl.checks.length||quarantine.cases.length))throw Error('Retained-only coverage cannot invent native observations or quarantined attempts');
 const municipalityIds=new Set(registry.municipalities.map(city=>city.id));
 for(const group of [...groups.fetched,...groups.attempted])if(!municipalityIds.has(group.municipalityId))throw Error('Text lineage municipality is outside the publication registry');
 for(const item of quarantine.cases)if(!registry.municipalities.some(city=>city.id===item.municipalityId&&city.sources.some(source=>source.id===item.sourceId)))throw Error('Quarantine municipality/source binding mismatch');
 const models=new Map<string,z.infer<typeof admittedModelSchema>>();
 for(const record of records){
  const {provider,model,tool,toolVersion,modelIdentitySha256,modelIdentityBasis}=record.extraction,key=modelKey(record.extraction),existing=models.get(key);
  if(existing)existing.publishedRecords++;
  else models.set(key,{provider,model,tool,toolVersion,modelIdentitySha256,modelIdentityBasis,faithfulnessThreshold:0.8,publishedRecords:1});
 }
 const municipalities=registry.municipalities.map(city=>{
  const documents=crawl.documents.filter(doc=>doc.municipalityId===city.id),published=records.filter(record=>record.municipalityId===city.id),withheld=quarantine.cases.filter(item=>item.municipalityId===city.id);
  const checks=crawl.checks.filter(check=>check.municipalityId===city.id);
  const fetched=new Set(documents.map(document=>document.sha256));
  const attempted=new Set(groups.attempted.filter(group=>group.municipalityId===city.id).map(group=>group.sourceSha256));
  for(const item of [...nativeRecords.filter(record=>record.municipalityId===city.id).map(record=>record.extraction.inputSha256),...withheld.map(item=>item.sourceSha256)])if(!attempted.has(item))throw Error('Text lineage omits a source-bound published or quarantined attempt');
  const present=[...attempted].filter(hash=>fetched.has(hash)).length;
  const extraction={fetchedDocumentGroups:fetched.size,runSelectedDocumentGroups:groups.selected===null?null:groups.selected.filter(group=>group.municipalityId===city.id).length,preparedDocumentGroups:groups.prepared===null?null:groups.prepared.filter(group=>group.municipalityId===city.id).length,attemptedDocumentGroups:present,pendingDocumentGroups:fetched.size-present,unavailableAttemptedDocumentGroups:attempted.size-present};
  const checked=documents.length>0||attempted.size>0||checks.some(check=>check.checkedAt!==null);
  const datedStagedRecords=published.filter(record=>record.stage!=='unknown'&&(record.documentDate!==null||record.stageDate!==null||record.stages.some(event=>event.date!==null))).length;
  const status=published.length?'gated_records' as const:checked?'checked_no_gated_records' as const:'not_checked' as const;
  return {id:city.id,ags:city.ags,districtId:city.districtId,checked,status,documents:documents.length,publishedRecords:published.length,datedStagedRecords,quarantinedRecords:withheld.length,quarantineReasons:quarantineReasonHistogram(withheld),extraction,sources:city.sources.map(source=>{
   const observations=checks.filter(item=>item.sourceId===source.id).map(publicSourceObservation);
   const {selected:check,coverageSelection}=selectSourceObservation(observations);
   const coverage=check?.coverage??{state:'not_checked' as const,pendingCount:0,runnableCount:0,blockedCount:0};
   const sourceWithheld=withheld.filter(item=>item.sourceId===source.id);
   return {sourceId:source.id,kind:source.kind,registryState:source.checkState,crawlState:check?.crawlState??'not_checked' as const,checkedAt:check?.checkedAt??null,documentCount:documents.filter(doc=>doc.sourceId===source.id).length,publishedRecords:published.filter(record=>record.sources.some(item=>item.id===source.id)).length,quarantinedRecords:sourceWithheld.length,quarantineReasons:quarantineReasonHistogram(sourceWithheld),coverage,coverageSelection,observations,failedLinkCount:check?.failedLinkCount??0,failureExamples:check?.failureExamples??[],...(check?.reason||source.reason?{reason:check?.reason??source.reason}:{})};
  })};
 });
 const districts=registry.districts.map(district=>{
  const selected=municipalities.filter(city=>city.districtId===district.id);
  return {id:district.id,ags:district.ags,municipalitiesRegistered:registry.inventory.filter(city=>city.districtId===district.id).length,municipalitiesConfigured:selected.length,municipalitiesChecked:selected.filter(city=>city.checked).length,municipalitiesAttempted:selected.filter(city=>city.extraction.attemptedDocumentGroups+city.extraction.unavailableAttemptedDocumentGroups>0).length,municipalitiesWithRecords:selected.filter(city=>city.publishedRecords>0).length,municipalitiesWithDatedStages:selected.filter(city=>city.datedStagedRecords>0).length,documents:selected.reduce((n,city)=>n+city.documents,0),publishedRecords:selected.reduce((n,city)=>n+city.publishedRecords,0),quarantinedRecords:selected.reduce((n,city)=>n+city.quarantinedRecords,0)};
 });
 const coverage=districtCoverageSchema.parse({schemaVersion:'stadtstack-district-coverage-v4',generatedAt,accounting:coverageAccounting(registry,municipalities),districts,municipalities,models:[...models.values()].sort((a,b)=>modelKey(a).localeCompare(modelKey(b))),textLineage,retainedPublication,historicalCoverage,coverageScope:coverageScope(retainedPublication!==null)});
 validateDistrictCoverage(coverage,registry,records);return coverage;
}
export function validateDistrictCoverage(coverage:DistrictCoverage,registry:DistrictRegistry,records:DistrictCoverageRecord[],retainedInput:RetainedKnowledgeComposition|null=null){
 const textLineage=coverage.textLineage===null?null:textRunLineageSchema.parse(coverage.textLineage);
 const retained=coverage.retainedPublication===null?null:RetainedKnowledgeLineageSchema.parse(coverage.retainedPublication);
 if(retainedInput!==null){
  const authenticated=validateRetainedKnowledgeComposition(retainedInput),expected={...authenticated.baseline.lineage,selectedRecordOrigins:authenticated.selectedRecordOrigins};
  if(textLineageRecordSha256(retained)!==textLineageRecordSha256(expected))throw Error('Retained publication member/origin proof mismatch');
 }
 if(retained===null?coverage.historicalCoverage!==null:coverage.historicalCoverage===null||textLineageRecordSha256(retainedHistoricalCoverageSchema.parse(coverage.historicalCoverage))!==retained.historicalCoverageSha256)throw Error('Retained historical coverage count/provenance mismatch');
 if(JSON.stringify(coverage.coverageScope)!==JSON.stringify(coverageScope(retained!==null)))throw Error('District coverage cohort scope mismatch');
 const nativeRecords=assertPublicationOrigins(textLineage,retained,registry,records);
 const groups=textLineage?.cumulative.groupBindings??emptyNativeGroups,knownRuns=new Set(textLineage?.runs.map(run=>run.runId)??[]),knownCities=new Set(registry.municipalities.map(city=>city.id));
 if([...groups.fetched,...groups.attempted,...(groups.selected??[]),...(groups.prepared??[])].some(group=>!knownCities.has(group.municipalityId)))throw Error('Text lineage municipality is outside the publication registry');
 if(coverage.municipalities.length!==registry.municipalities.length||new Set(coverage.municipalities.map(city=>city.id)).size!==coverage.municipalities.length)throw Error('District coverage municipality inventory mismatch');
 if(JSON.stringify(coverage.accounting)!==JSON.stringify(coverageAccounting(registry,coverage.municipalities)))throw Error('District coverage accounting mismatch');
 const admitted=new Map(coverage.models.map(model=>[modelKey(model),model]));
 if(admitted.size!==coverage.models.length)throw Error('Duplicate admitted model identity');
 for(const model of coverage.models){
  const configured=PROVIDER_CONFIGS[model.provider],actual=records.filter(record=>modelKey(record.extraction)===modelKey(model)).length;
  const native=nativeRecords.some(record=>modelKey(record.extraction)===modelKey(model));
  if(native&&(model.model!==configured.model||model.tool!==configured.tool||model.modelIdentityBasis!==configured.modelIdentityBasis)||model.publishedRecords!==actual||actual===0)throw Error('District coverage model provenance mismatch');
 }
 for(const record of records)if(!admitted.has(modelKey(record.extraction)))throw Error('Missing admitted model provenance');
 const totalAttempted=coverage.municipalities.reduce((n,city)=>n+city.extraction.attemptedDocumentGroups+city.extraction.unavailableAttemptedDocumentGroups,0);
 if((textLineage?.cumulative.groups.attemptedDocumentGroups??0)!==totalAttempted)throw Error('Extraction lineage counts do not bind to actual source-bound outputs');
 for(const city of coverage.municipalities){
  const registered=registry.municipalities.find(item=>item.id===city.id);
  if(!registered||registered.ags!==city.ags||registered.districtId!==city.districtId||city.publishedRecords!==records.filter(record=>record.municipalityId===city.id).length)throw Error(`District coverage record binding mismatch: ${city.id}`);
  const datedStagedRecords=records.filter(record=>record.municipalityId===city.id&&record.stage!=='unknown'&&(record.documentDate!==null||record.stageDate!==null||record.stages.some(event=>event.date!==null))).length;
  const status=city.publishedRecords?'gated_records':city.checked?'checked_no_gated_records':'not_checked';
  if(city.status!==status||city.datedStagedRecords!==datedStagedRecords)throw Error(`Municipality admission coverage mismatch: ${city.id}`);
  const extraction=city.extraction,publishedGroups=new Set(nativeRecords.filter(record=>record.municipalityId===city.id).map(record=>record.extraction.inputSha256)).size;
  if(extraction.fetchedDocumentGroups!==extraction.attemptedDocumentGroups+extraction.pendingDocumentGroups||extraction.fetchedDocumentGroups>city.documents||extraction.attemptedDocumentGroups+extraction.unavailableAttemptedDocumentGroups<publishedGroups)throw Error(`Extraction coverage mismatch: ${city.id}`);
  const attempts=extraction.attemptedDocumentGroups+extraction.unavailableAttemptedDocumentGroups;
  const expectedAttempts=groups.attempted.filter(group=>group.municipalityId===city.id).length,expectedSelected=groups.selected===null?null:groups.selected.filter(group=>group.municipalityId===city.id).length,expectedPrepared=groups.prepared===null?null:groups.prepared.filter(group=>group.municipalityId===city.id).length;
  if(attempts!==expectedAttempts||extraction.runSelectedDocumentGroups!==expectedSelected||extraction.preparedDocumentGroups!==expectedPrepared)throw Error(`Extraction lineage municipality binding mismatch: ${city.id}`);
  if((city.documents>0||attempts>0)&&!city.checked||extraction.runSelectedDocumentGroups!==null&&extraction.runSelectedDocumentGroups<attempts||extraction.preparedDocumentGroups!==null&&(extraction.runSelectedDocumentGroups===null||extraction.preparedDocumentGroups>extraction.runSelectedDocumentGroups))throw Error(`Extraction selection/preparation coverage mismatch: ${city.id}`);
  if(!textLineage&&(city.documents||city.quarantinedRecords||city.checked||city.sources.some(source=>source.documentCount||source.observations.length)))throw Error('Retained-only coverage cannot invent native observations or quarantined attempts');
  for(const entry of [city,...city.sources]){
   const histogram=entry.quarantineReasons;
   if(new Set(histogram.categories.map(row=>row.reason)).size!==histogram.categories.length||new Set(histogram.failedDeterministicChecks.map(row=>row.id)).size!==histogram.failedDeterministicChecks.length||histogram.categories.some(row=>row.count===0||row.count>entry.quarantinedRecords)||histogram.failedDeterministicChecks.some(row=>row.count===0||row.count>(histogram.categories.find(row=>row.reason==='deterministic_gate_failed')?.count??0))||histogram.categories.reduce((n,row)=>n+row.count,0)<entry.quarantinedRecords)throw Error('Quarantine reason histogram count mismatch');
  }
  if(city.quarantinedRecords!==city.sources.reduce((n,source)=>n+source.quarantinedRecords,0))throw Error('Quarantine source totals mismatch');
  for(const reason of quarantineReason.options)if((city.quarantineReasons.categories.find(row=>row.reason===reason)?.count??0)!==city.sources.reduce((n,source)=>n+(source.quarantineReasons.categories.find(row=>row.reason===reason)?.count??0),0))throw Error('Quarantine source reason totals mismatch');
  for(const id of publicCheckId.options)if((city.quarantineReasons.failedDeterministicChecks.find(row=>row.id===id)?.count??0)!==city.sources.reduce((n,source)=>n+(source.quarantineReasons.failedDeterministicChecks.find(row=>row.id===id)?.count??0),0))throw Error('Quarantine source check totals mismatch');
  if(city.sources.length!==registered.sources.length||new Set(city.sources.map(source=>source.sourceId)).size!==city.sources.length)throw Error(`District source coverage mismatch: ${city.id}`);
  for(const source of city.sources){
   if(!registered.sources.some(item=>item.id===source.sourceId&&item.kind===source.kind)||source.publishedRecords!==records.filter(record=>record.municipalityId===city.id&&record.sources.some(item=>item.id===source.sourceId)).length)throw Error(`District source record count mismatch: ${city.id}`);
   for(const observation of source.observations){
    if(observation.runId!==null&&!knownRuns.has(observation.runId))throw Error('Source observation refers to an unknown extraction contribution');
    if(observation.coverage.targetScope&&(observation.coverage.state!=='partial'||observation.coverage.sourceCoverage!=='not_assessed'))throw Error('Targeted crawl cannot establish source-wide completeness');
   }
   const {selected,coverageSelection}=selectSourceObservation(source.observations),expectedCoverage=selected?.coverage??{state:'not_checked',pendingCount:0,runnableCount:0,blockedCount:0};
   if(source.coverageSelection!==coverageSelection||source.crawlState!==(selected?.crawlState??'not_checked')||source.checkedAt!==(selected?.checkedAt??null)||JSON.stringify(source.coverage)!==JSON.stringify(expectedCoverage)||source.failedLinkCount!==(selected?.failedLinkCount??0)||JSON.stringify(source.failureExamples)!==JSON.stringify(selected?.failureExamples??[]))throw Error('Source coverage does not retain its selected scoped observation');
  }
 }
 if(coverage.districts.length!==registry.districts.length||new Set(coverage.districts.map(d=>d.id)).size!==coverage.districts.length)throw Error('District coverage identity mismatch');
 for(const district of coverage.districts){
  const registered=registry.districts.find(item=>item.id===district.id),cities=coverage.municipalities.filter(city=>city.districtId===district.id);
  if(!registered||registered.ags!==district.ags||district.municipalitiesRegistered!==registry.inventory.filter(city=>city.districtId===district.id).length||district.municipalitiesConfigured!==cities.length||district.publishedRecords!==cities.reduce((n,city)=>n+city.publishedRecords,0)||district.municipalitiesWithRecords!==cities.filter(city=>city.publishedRecords>0).length||district.municipalitiesWithDatedStages!==cities.filter(city=>city.datedStagedRecords>0).length)throw Error(`District coverage totals mismatch: ${district.id}`);
  if(district.municipalitiesChecked!==cities.filter(city=>city.checked).length||district.municipalitiesAttempted!==cities.filter(city=>city.extraction.attemptedDocumentGroups+city.extraction.unavailableAttemptedDocumentGroups>0).length||district.documents!==cities.reduce((n,city)=>n+city.documents,0)||district.quarantinedRecords!==cities.reduce((n,city)=>n+city.quarantinedRecords,0))throw Error(`District coverage attempt/quarantine totals mismatch: ${district.id}`);
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
