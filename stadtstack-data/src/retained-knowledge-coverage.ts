import {z} from 'zod';
import {hashSchema,REQUIRED_DETERMINISTIC_CHECKS} from './district-schema.ts';
import {GRAPH_DETERMINISTIC_CHECKS} from './district-graph-claims.ts';
import {textRunLineageSchema} from './text-run-lineage.ts';

const count=z.number().int().nonnegative(),clock=z.string().datetime({offset:true}),checkState=z.enum(['checked','not_found','not_checked']);
const reasons=z.enum(['deterministic_gate_failed','faithfulness_gate_failed','no_supported_case','invalid_structured_output','document_limit','preparation_failed','extraction_failed','missing_sourced_date','nonpublic_evidence_url','source_binding_unknown','unknown']);
const histogram=z.object({categories:z.array(z.object({reason:reasons,count}).strict()),failedDeterministicChecks:z.array(z.object({id:z.enum([...REQUIRED_DETERMINISTIC_CHECKS,...GRAPH_DETERMINISTIC_CHECKS,'judge_critical_claims']),count}).strict())}).strict();
const accounting=z.object({registryMunicipalities:count,configuredMunicipalities:count,checkedMunicipalities:count,runSelectedMunicipalities:count.nullable(),preparedMunicipalities:count.nullable(),attemptedMunicipalities:count,publishedMunicipalities:count,checkedWithoutPublishedMunicipalities:count,unvisitedMunicipalities:count}).strict();
const extraction=z.object({fetchedDocumentGroups:count,runSelectedDocumentGroups:count.nullable(),preparedDocumentGroups:count.nullable(),attemptedDocumentGroups:count,pendingDocumentGroups:count,unavailableAttemptedDocumentGroups:count}).strict();
const target=z.object({kind:z.enum(['page_roots','seed_documents']),state:z.enum(['complete','partial','blocked']),pendingCount:count,runnableCount:count,blockedCount:count}).strict();
const frontier=z.object({state:z.enum(['complete','partial','blocked','not_checked']),pendingCount:count,runnableCount:count,blockedCount:count,sourceCoverage:z.literal('not_assessed').optional(),targetScope:target.optional()}).strict();
const observation=z.object({runId:hashSchema.nullable(),crawlState:checkState,checkedAt:clock.nullable(),documentCount:count,coverage:frontier,failedLinkCount:count}).strict();
const source=z.object({sourceId:z.string(),kind:z.string(),registryState:checkState,crawlState:checkState,checkedAt:clock.nullable(),documentCount:count,publishedRecords:count,quarantinedRecords:count,quarantineReasons:histogram,coverage:frontier,failedLinkCount:count,coverageSelection:z.enum(['latest_non_targeted_observation','latest_targeted_observation','none']).optional(),observations:z.array(observation).optional()}).strict();
const municipality=z.object({id:z.string(),ags:z.string().regex(/^\d{8}$/),districtId:z.string(),checked:z.boolean(),status:z.enum(['gated_records','checked_no_gated_records','not_checked']),documents:count,publishedRecords:count,datedStagedRecords:count,quarantinedRecords:count,quarantineReasons:histogram,extraction,sources:z.array(source)}).strict();
const inputFrontier=frontier.extend({targetScope:target.strip().optional()}).strip();
const inputSource=source.extend({coverage:inputFrontier,observations:z.array(observation.extend({coverage:inputFrontier}).strip()).optional()}).strip();
const inputMunicipality=municipality.extend({sources:z.array(inputSource)}).strip();
const district=z.object({id:z.string(),ags:z.string().regex(/^\d{5}$/),municipalitiesRegistered:count,municipalitiesConfigured:count,municipalitiesChecked:count,municipalitiesAttempted:count,municipalitiesWithRecords:count,municipalitiesWithDatedStages:count,documents:count,publishedRecords:count,quarantinedRecords:count}).strict();
const model=z.object({provider:z.enum(['openai-subscription','anthropic-subscription']),model:z.string(),tool:z.enum(['codex-cli','claude-cli']),toolVersion:z.string(),modelIdentitySha256:hashSchema,modelIdentityBasis:z.enum(['configured-cli-model-and-tool-version','reported-cli-model-and-tool-version']),faithfulnessThreshold:z.literal(0.8),publishedRecords:count}).strict();
const extractionRun=z.object({generatedAt:clock,assignmentMode:z.enum(['balanced','codex-only']),corpusSha256:hashSchema,registrySha256:hashSchema,promptContractSha256:hashSchema,schemaSha256:hashSchema,selection:z.enum(['all_at_run_start','bounded_per_municipality']),maxDocumentsPerMunicipality:count.nullable(),availableDocumentGroupsAtRunStart:count,attemptedDocumentGroups:count,pendingDocumentGroupsAtRunStart:count}).strict();
const nativeRun=textRunLineageSchema.shape.runs.element.pick({runId:true,sourceArtifactKind:true,recordsSchemaVersion:true,retainedPublication:true,generatedAt:true,assignmentMode:true,pins:true,artifacts:true,artifactClocks:true,scope:true,maxDocumentsPerMunicipality:true,availableDocumentGroups:true,attemptedDocumentGroups:true,pendingDocumentGroups:true,municipalities:true,providers:true,groups:true}).strict();
const nativeCumulative=textRunLineageSchema.shape.cumulative.omit({groupBindings:true}).strict();
export const districtCoverageScopeSchema=z.object({publishedRecords:z.literal('selected_native_and_retained'),sourceObservations:z.literal('native_contributions_only'),documents:z.literal('native_contributions_only'),extractionGroups:z.literal('native_contributions_only'),quarantinedRecords:z.literal('native_contributions_only'),crossCohortUniqueDocumentGroups:z.enum(['unknown','native_only'])}).strict();
const snapshot=z.object({coverageSchemaVersion:z.enum(['stadtstack-district-coverage-v3','stadtstack-district-coverage-v4']),generatedAt:clock,accounting,districts:z.array(district),municipalities:z.array(municipality),models:z.array(model),extractionRun:extractionRun.nullable(),nativeLineageGeneratedAt:clock.nullable(),nativeRuns:z.array(nativeRun),nativeCumulative:nativeCumulative.nullable(),coverageScope:districtCoverageScopeSchema.nullable()}).strict().superRefine((value,ctx)=>{
 const fail=()=>ctx.addIssue({code:'custom',message:'Retained historical coverage counts do not bind their publication cohort'});
 const cities=value.municipalities,a=value.accounting,checked=cities.filter(city=>city.checked).length;
 if(new Set(cities.map(city=>city.id)).size!==cities.length||new Set(value.districts.map(district=>district.id)).size!==value.districts.length||a.configuredMunicipalities!==cities.length||a.checkedMunicipalities!==checked||a.publishedMunicipalities!==cities.filter(city=>city.publishedRecords>0).length||a.checkedWithoutPublishedMunicipalities!==cities.filter(city=>city.checked&&city.publishedRecords===0).length||a.unvisitedMunicipalities!==a.registryMunicipalities-checked)fail();
 const selected=cities.some(city=>city.extraction.runSelectedDocumentGroups===null)?null:cities.filter(city=>city.extraction.runSelectedDocumentGroups!>0).length;
 const prepared=cities.some(city=>city.extraction.preparedDocumentGroups===null)?null:cities.filter(city=>city.extraction.preparedDocumentGroups!>0).length;
 const attempted=cities.filter(city=>city.extraction.attemptedDocumentGroups+city.extraction.unavailableAttemptedDocumentGroups>0).length;
 if(a.runSelectedMunicipalities!==selected||a.preparedMunicipalities!==prepared||a.attemptedMunicipalities!==attempted||value.districts.reduce((n,district)=>n+district.municipalitiesRegistered,0)!==a.registryMunicipalities)fail();
 if(value.models.reduce((n,model)=>n+model.publishedRecords,0)!==cities.reduce((n,city)=>n+city.publishedRecords,0))fail();
 for(const city of cities){
  const e=city.extraction;
  if(!value.districts.some(district=>district.id===city.districtId)||city.datedStagedRecords>city.publishedRecords||city.status!==(city.publishedRecords?'gated_records':city.checked?'checked_no_gated_records':'not_checked')||e.fetchedDocumentGroups!==e.attemptedDocumentGroups+e.pendingDocumentGroups||e.fetchedDocumentGroups>city.documents||new Set(city.sources.map(source=>source.sourceId)).size!==city.sources.length||city.quarantinedRecords!==city.sources.reduce((n,source)=>n+source.quarantinedRecords,0))fail();
  for(const entry of [city,...city.sources]){
   const h=entry.quarantineReasons;
   if(new Set(h.categories.map(row=>row.reason)).size!==h.categories.length||new Set(h.failedDeterministicChecks.map(row=>row.id)).size!==h.failedDeterministicChecks.length||h.categories.some(row=>row.count===0||row.count>entry.quarantinedRecords)||h.categories.reduce((n,row)=>n+row.count,0)<entry.quarantinedRecords||h.failedDeterministicChecks.some(row=>row.count===0||row.count>(h.categories.find(row=>row.reason==='deterministic_gate_failed')?.count??0)))fail();
  }
  for(const source of city.sources)for(const coverage of [source.coverage,...(source.observations??[]).map(observation=>observation.coverage)])if(coverage.targetScope&&(coverage.state!=='partial'||coverage.sourceCoverage!=='not_assessed'))fail();
 }
 for(const district of value.districts){
  const selected=cities.filter(city=>city.districtId===district.id);
  if(district.municipalitiesConfigured!==selected.length||district.municipalitiesChecked!==selected.filter(city=>city.checked).length||district.municipalitiesAttempted!==selected.filter(city=>city.extraction.attemptedDocumentGroups+city.extraction.unavailableAttemptedDocumentGroups>0).length||district.municipalitiesWithRecords!==selected.filter(city=>city.publishedRecords>0).length||district.municipalitiesWithDatedStages!==selected.filter(city=>city.datedStagedRecords>0).length||district.documents!==selected.reduce((n,city)=>n+city.documents,0)||district.publishedRecords!==selected.reduce((n,city)=>n+city.publishedRecords,0)||district.quarantinedRecords!==selected.reduce((n,city)=>n+city.quarantinedRecords,0))fail();
 }
 if(value.extractionRun&&value.extractionRun.availableDocumentGroupsAtRunStart!==value.extractionRun.attemptedDocumentGroups+value.extractionRun.pendingDocumentGroupsAtRunStart)fail();
 if((value.coverageSchemaVersion==='stadtstack-district-coverage-v3')!==(value.extractionRun!==null)||value.coverageSchemaVersion==='stadtstack-district-coverage-v3'&&value.nativeRuns.length)fail();
});
/** Publication snapshots are separate cohorts, never additive document-group inventories. */
export const retainedHistoricalCoverageSchema=z.object({schemaVersion:z.literal('stadtstack-retained-historical-coverage-v1'),publication:snapshot,priorPublications:z.array(snapshot)}).strict();
export type RetainedHistoricalCoverage=z.infer<typeof retainedHistoricalCoverageSchema>;

/** Drops all source URLs, quotes, free-text reasons and private paths, preserving factual clocks/counts. */
export function projectRetainedHistoricalCoverage(raw:unknown):RetainedHistoricalCoverage{
 const input=z.object({schemaVersion:z.enum(['stadtstack-district-coverage-v3','stadtstack-district-coverage-v4']),generatedAt:clock,accounting,districts:z.array(district),municipalities:z.array(inputMunicipality),models:z.array(model),extractionRun:extractionRun.optional(),textLineage:textRunLineageSchema.nullable().optional(),coverageScope:districtCoverageScopeSchema.optional(),historicalCoverage:retainedHistoricalCoverageSchema.nullable().optional()}).passthrough().parse(raw);
 if(input.schemaVersion==='stadtstack-district-coverage-v3'&&!input.extractionRun)throw Error('Historical v3 coverage requires its sealed extraction summary');
 if(input.schemaVersion==='stadtstack-district-coverage-v4'&&!input.textLineage&&!input.historicalCoverage)throw Error('Historical v4 coverage requires sealed native or retained provenance');
 const nativeRuns=(input.textLineage?.runs??[]).map(run=>nativeRun.strip().parse(run));
 const cumulative=input.textLineage?nativeCumulative.strip().parse(input.textLineage.cumulative):null;
 return retainedHistoricalCoverageSchema.parse({schemaVersion:'stadtstack-retained-historical-coverage-v1',publication:{coverageSchemaVersion:input.schemaVersion,generatedAt:input.generatedAt,accounting:input.accounting,districts:input.districts,municipalities:input.municipalities,models:input.models,extractionRun:input.extractionRun??null,nativeLineageGeneratedAt:input.textLineage?.generatedAt??null,nativeRuns,nativeCumulative:cumulative,coverageScope:input.coverageScope??null},priorPublications:input.historicalCoverage?[input.historicalCoverage.publication,...input.historicalCoverage.priorPublications]:[]});
}
