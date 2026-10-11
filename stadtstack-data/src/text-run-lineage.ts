import {z} from 'zod';
import {hashSchema,knowledgeEvidenceHash,sha256,type DistrictKnowledgeRecord} from './district-schema.ts';
import {dataReleaseSchema,dataReleaseId,requireReleaseFiles} from './data-release.ts';
import {ModelEvidenceSchema,SupportedModelRouteSchema} from './district-model-contract.ts';

const count=z.number().int().nonnegative();
const pinsSchema=z.object({corpusSha256:hashSchema,registrySha256:hashSchema,promptContractSha256:hashSchema,schemaSha256:hashSchema}).strict();
const modelSchema=ModelEvidenceSchema;
const municipalityRunSchema=z.object({id:z.string().min(1),availableDocumentGroups:count.optional(),selectedDocumentGroups:count,preparedDocumentGroups:count.optional(),attemptedDocumentGroups:count}).strip();
/** Original v2 semantics: attempted includes source-bound preparation quarantines. */
export const textExtractionRunSchema=z.object({schemaVersion:z.literal('stadtstack-extraction-run-v2'),generatedAt:z.string().datetime({offset:true}),assignmentMode:z.enum(['balanced','codex-only']),...pinsSchema.shape,scope:z.enum(['all_fetched_documents','bounded_per_municipality']),maxDocumentsPerMunicipality:count.nullable(),availableDocumentGroups:count,attemptedDocumentGroups:count,pendingDocumentGroups:count,municipalities:z.array(municipalityRunSchema).optional()}).passthrough();
export const textSourceGroupSchema=z.object({municipalityId:z.string().min(1),sourceSha256:hashSchema}).strict();
export type TextSourceGroup=z.infer<typeof textSourceGroupSchema>;
export type TextLineageArtifact={sha256:string;bytes:string|Uint8Array};
/** Native outputs and already sealed retained publication members are distinct sources.
 * A retained member preserves its actual reassessment/generation/judge receipts; it
 * is never relabelled as the original model output or required to share its clock. */
export type TextRunContribution={
 runId:string;
 pins:z.infer<typeof pinsSchema>;
 artifacts:{extractionRun:TextLineageArtifact;records:TextLineageArtifact;quarantine:TextLineageArtifact;crawl:TextLineageArtifact;registry:TextLineageArtifact;preparationPlan?:TextLineageArtifact};
}&({sourceArtifactKind:'native_extraction_output';retainedPublication?:never}|{sourceArtifactKind:'retained_publication';retainedPublication:{manifest:TextLineageArtifact;coverage:TextLineageArtifact}});
export const textSchemaProjectionSchema=z.object({version:z.literal('knowledge-v2-to-v3-text-model-v1')}).strict();
const recordsSchemaVersionSchema=z.enum(['stadtstack-knowledge-v2','stadtstack-knowledge-v3']);
export type TextRecordSelection={runId:string;recordId:string;originalEvidenceHash:string;projectedRecord:DistrictKnowledgeRecord;schemaProjection?:z.infer<typeof textSchemaProjectionSchema>};
const crawlSchema=z.object({schemaVersion:z.literal('stadtstack-crawl-index-v1'),generatedAt:z.string(),documents:z.array(z.object({id:z.string(),municipalityId:z.string(),sourceId:z.string(),sha256:hashSchema}).passthrough()),checks:z.array(z.object({municipalityId:z.string(),sourceId:z.string()}).passthrough())}).passthrough();
const quarantineSchema=z.object({schemaVersion:z.literal('stadtstack-quarantine-v1'),generatedAt:z.string().optional(),cases:z.array(z.object({municipalityId:z.string(),sourceId:z.string(),sourceSha256:hashSchema,candidate:z.unknown().optional()}).passthrough())}).passthrough();
const registrySchema=z.object({generatedAt:z.string().optional(),municipalities:z.array(z.object({id:z.string(),sources:z.array(z.object({id:z.string()}))}))});
const recordBindingSchema=z.object({id:z.string().min(1),kind:z.literal('text_model').optional(),municipalityId:z.string().min(1),sources:z.array(z.object({id:z.string(),sha256:hashSchema}).passthrough()).min(1),extraction:modelSchema.safeExtend({inputSha256:hashSchema,responseSha256:hashSchema,promptSha256:hashSchema,judgePromptSha256:hashSchema}).passthrough(),verification:z.object({kind:z.literal('text_model').optional(),evidenceHash:hashSchema,faithfulness:SupportedModelRouteSchema.safeExtend({toolVersion:z.string(),modelIdentitySha256:hashSchema,responseSha256:hashSchema.nullable()}).passthrough()}).passthrough()}).passthrough();
const providerRunSchema=SupportedModelRouteSchema.safeExtend({assignedGroups:count,completedGroups:count,agreementCompleted:count,publishedCandidates:count}).strip();
const uniqueCountSchema=z.object({state:z.enum(['exact','unknown']),count:count.nullable()}).strict().refine(value=>(value.state==='unknown')===(value.count===null),'Unknown group counts must be null');
const groupAccountingSchema=z.object({fetchedDocumentGroups:count,selectedDocumentGroups:uniqueCountSchema,preparedDocumentGroups:uniqueCountSchema,attemptedDocumentGroups:count,pendingFetchedDocumentGroups:count,unavailableAttemptedDocumentGroups:count}).strict();
const groupBindingsSchema=z.object({fetched:z.array(textSourceGroupSchema),attempted:z.array(textSourceGroupSchema),selected:z.array(textSourceGroupSchema).nullable(),prepared:z.array(textSourceGroupSchema).nullable()}).strict();
const artifactPinsSchema=z.object({extractionRun:hashSchema,records:hashSchema,quarantine:hashSchema,crawl:hashSchema,registry:hashSchema,preparationPlan:hashSchema.nullable()}).strict();
const artifactClocksSchema=z.object({extractionRun:z.string(),records:z.string(),quarantine:z.string().nullable(),crawl:z.string(),registry:z.string().nullable(),preparationPlan:z.string().nullable()}).strict();
const sourceArtifactKindSchema=z.enum(['native_extraction_output','retained_publication']);
const retainedPublicationSchema=z.object({manifestSha256:hashSchema,releaseId:hashSchema,coverageSha256:hashSchema,generatedAt:z.string(),coverageGeneratedAt:z.string()}).strict();
const originSchema=z.object({runId:hashSchema,sourceArtifactKind:sourceArtifactKindSchema,schemaProjection:textSchemaProjectionSchema.nullable(),recordId:z.string(),outputRecordIndex:count,outputArtifactSha256:hashSchema,originalRecordSha256:hashSchema,originalEvidenceHash:hashSchema,projectedEvidenceHash:hashSchema,currentEvidenceHash:hashSchema,municipalityId:z.string(),sourceSha256:hashSchema,model:modelSchema,extractionResponseSha256:hashSchema,judgeResponseSha256:hashSchema.nullable(),promptSha256:hashSchema,judgePromptSha256:hashSchema}).strict();
/** Content-free public lineage. Frontier observations remain per-run, never additive. */
export const textRunLineageSchema=z.object({
 schemaVersion:z.literal('stadtstack-text-run-lineage-v1'),generatedAt:z.string().datetime({offset:true}),
 runs:z.array(z.object({runId:hashSchema,sourceArtifactKind:sourceArtifactKindSchema,recordsSchemaVersion:recordsSchemaVersionSchema,retainedPublication:retainedPublicationSchema.nullable(),generatedAt:z.string().datetime({offset:true}),assignmentMode:z.enum(['balanced','codex-only']),pins:pinsSchema,artifacts:artifactPinsSchema,artifactClocks:artifactClocksSchema,scope:z.enum(['all_fetched_documents','bounded_per_municipality']),maxDocumentsPerMunicipality:count.nullable(),availableDocumentGroups:count,attemptedDocumentGroups:count,pendingDocumentGroups:count,municipalities:z.array(municipalityRunSchema).nullable(),providers:z.array(providerRunSchema).nullable(),groups:groupAccountingSchema}).strict()),
 selectedRecordOrigins:z.array(originSchema),
 cumulative:z.object({attemptsAcrossRuns:count,groups:groupAccountingSchema,groupBindings:groupBindingsSchema,municipalities:z.array(z.object({id:z.string(),...groupAccountingSchema.shape}).strict()),frontierUnion:z.literal('unknown')}).strict(),
}).strict().superRefine((lineage,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 const bindings=lineage.cumulative.groupBindings,municipalityIds=new Set(lineage.cumulative.municipalities.map(city=>city.id));
 for(const groups of Object.values(bindings))if(groups!==null&&JSON.stringify(groups)!==JSON.stringify(uniqueGroups(groups)))fail('Cumulative group identities must be unique and canonically ordered');
 if(textLineageRecordSha256(lineage.cumulative.groups)!==textLineageRecordSha256(accounting(bindings)))fail('Cumulative group counts do not bind exact identities');
 if(municipalityIds.size!==lineage.cumulative.municipalities.length)fail('Duplicate cumulative municipality identity');
 for(const groups of Object.values(bindings))if(groups?.some(group=>!municipalityIds.has(group.municipalityId)))fail('Missing cumulative municipality accounting');
 for(const {id,...counts} of lineage.cumulative.municipalities){
  const expected=accounting({fetched:bindings.fetched.filter(group=>group.municipalityId===id),attempted:bindings.attempted.filter(group=>group.municipalityId===id),selected:bindings.selected?.filter(group=>group.municipalityId===id)??null,prepared:bindings.prepared?.filter(group=>group.municipalityId===id)??null});
  if(textLineageRecordSha256(counts)!==textLineageRecordSha256(expected))fail('Cumulative municipality counts do not bind exact identities');
 }
 const runs=new Map(lineage.runs.map(run=>[run.runId,run]));
 if(!runs.size||runs.size!==lineage.runs.length)fail('Text lineage needs distinct original runs');
 if(lineage.cumulative.attemptsAcrossRuns!==lineage.runs.reduce((sum,run)=>sum+run.attemptedDocumentGroups,0)||bindings.attempted.length>lineage.cumulative.attemptsAcrossRuns)fail('Cumulative attempt totals mismatch');
 for(const kind of ['selected','prepared'] as const)if((bindings[kind]===null)!==lineage.runs.some(run=>run.groups[kind==='selected'?'selectedDocumentGroups':'preparedDocumentGroups'].state==='unknown'))fail('Cumulative group metadata availability mismatch');
 const groupCount=(groups:z.infer<typeof groupAccountingSchema>,kind:'fetched'|'attempted'|'selected'|'prepared')=>kind==='fetched'?groups.fetchedDocumentGroups:kind==='attempted'?groups.attemptedDocumentGroups:kind==='selected'?groups.selectedDocumentGroups.count:groups.preparedDocumentGroups.count;
 const checkUnionBounds=(actual:number|null,counts:(number|null)[],label:string)=>{
  if(actual===null)return;
  const known=counts.filter((value):value is number=>value!==null);
  if(actual<Math.max(0,...known)||known.length===counts.length&&actual>known.reduce((sum,value)=>sum+value,0))fail(`Cumulative ${label} union bounds mismatch`);
 };
 for(const kind of ['fetched','attempted','selected','prepared'] as const){
  checkUnionBounds(groupCount(lineage.cumulative.groups,kind),lineage.runs.map(run=>groupCount(run.groups,kind)),kind);
  for(const city of lineage.cumulative.municipalities){
   const counts=lineage.runs.map(run=>{
    if(groupCount(run.groups,kind)===0)return 0;
    if(run.municipalities===null)return null;
    const original=run.municipalities.find(item=>item.id===city.id);
    if(!original)return 0;
    return kind==='fetched'?original.availableDocumentGroups??null:kind==='attempted'?original.attemptedDocumentGroups:kind==='selected'?original.selectedDocumentGroups:original.preparedDocumentGroups??null;
   });
   checkUnionBounds(groupCount(city,kind),counts,`${city.id} ${kind}`);
  }
 }
 for(const run of lineage.runs){
  if((run.sourceArtifactKind==='retained_publication')!==(run.retainedPublication!==null))fail('Retained publication provenance mismatch');
  if(run.runId!==run.artifacts.extractionRun||run.pins.corpusSha256!==run.artifacts.crawl||run.pins.registrySha256!==run.artifacts.registry)fail('Original run artifact binding mismatch');
  if(run.artifactClocks.extractionRun!==run.generatedAt)fail('Original run clock projection mismatch');
  if(run.availableDocumentGroups!==run.attemptedDocumentGroups+run.pendingDocumentGroups||run.groups.attemptedDocumentGroups!==run.attemptedDocumentGroups||run.groups.fetchedDocumentGroups!==run.availableDocumentGroups)fail('Original run accounting mismatch');
  if((run.scope==='bounded_per_municipality')!==(run.maxDocumentsPerMunicipality!==null)||run.maxDocumentsPerMunicipality===0)fail('Original extraction selection policy mismatch');
  if(run.groups.pendingFetchedDocumentGroups!==run.pendingDocumentGroups||run.groups.unavailableAttemptedDocumentGroups!==0)fail('Original run pending/available group mismatch');
  const selected=run.groups.selectedDocumentGroups.count,prepared=run.groups.preparedDocumentGroups.count;
  if(selected!==null&&(selected<run.attemptedDocumentGroups||selected>run.availableDocumentGroups)||prepared!==null&&(selected===null||prepared>selected))fail('Original selected/prepared group counts mismatch');
  if(run.municipalities!==null){
   if(new Set(run.municipalities.map(city=>city.id)).size!==run.municipalities.length||run.municipalities.some(city=>!municipalityIds.has(city.id)))fail('Original run municipality inventory mismatch');
   const attemptedSum=run.municipalities.reduce((sum,city)=>sum+city.attemptedDocumentGroups,0),selectedSum=run.municipalities.reduce((sum,city)=>sum+city.selectedDocumentGroups,0);
   if(attemptedSum!==run.attemptedDocumentGroups||selectedSum>run.availableDocumentGroups||selected!==null&&selected!==selectedSum)fail('Original municipality group totals mismatch');
   if(prepared!==null&&run.municipalities.every(city=>city.preparedDocumentGroups!==undefined)&&prepared!==run.municipalities.reduce((sum,city)=>sum+city.preparedDocumentGroups!,0))fail('Original municipality prepared totals mismatch');
   for(const city of run.municipalities){
    if(city.attemptedDocumentGroups>city.selectedDocumentGroups||city.preparedDocumentGroups!==undefined&&city.preparedDocumentGroups>city.selectedDocumentGroups)fail('Original municipality selected/prepared/attempted counts mismatch');
    if(city.availableDocumentGroups!==undefined&&city.selectedDocumentGroups>city.availableDocumentGroups)fail('Original municipality available/selected counts mismatch');
    if(run.maxDocumentsPerMunicipality!==null&&(city.selectedDocumentGroups>run.maxDocumentsPerMunicipality||city.attemptedDocumentGroups>run.maxDocumentsPerMunicipality))fail('Original municipality extraction budget exceeded');
   }
  }
  if(run.municipalities?.every(city=>city.availableDocumentGroups!==undefined)&&run.municipalities.reduce((sum,city)=>sum+city.availableDocumentGroups!,0)!==run.availableDocumentGroups)fail('Original municipality fetched totals mismatch');
  const origins=lineage.selectedRecordOrigins.filter(origin=>origin.runId===run.runId);
  if(new Set(origins.map(groupKey)).size>run.attemptedDocumentGroups)fail('Selected origins exceed their original run attempts');
  for(const city of run.municipalities??[])if(new Set(origins.filter(origin=>origin.municipalityId===city.id).map(groupKey)).size>city.attemptedDocumentGroups)fail('Selected origins exceed their original municipality attempts');
  if(run.providers!==null){
   if(new Set(run.providers.map(provider=>provider.provider)).size!==run.providers.length)fail('Duplicate original provider summary');
   for(const provider of run.providers){
    if(provider.completedGroups>provider.assignedGroups)fail('Original provider summary mismatch');
    if(run.assignmentMode==='codex-only'&&provider.provider!=='openai-subscription'&&(provider.assignedGroups||provider.completedGroups||provider.agreementCompleted||provider.publishedCandidates))fail('Codex-only run claims another provider activity');
    if(run.sourceArtifactKind==='native_extraction_output'){
     const selected=origins.filter(origin=>origin.model.provider===provider.provider);
     if(selected.some(origin=>origin.model.tool!==provider.tool||origin.model.model!==provider.model))fail('Original provider summary identity mismatch');
     if(selected.length>provider.publishedCandidates||new Set(selected.map(groupKey)).size>provider.completedGroups)fail('Selected origins exceed native provider output counts');
    }
   }
  }
 }
 if(new Set(lineage.selectedRecordOrigins.map(origin=>origin.recordId)).size!==lineage.selectedRecordOrigins.length)fail('Duplicate selected record origin');
 const attempted=new Set(bindings.attempted.map(groupKey)),fetched=new Set(bindings.fetched.map(groupKey));
 if(bindings.attempted.some(group=>!fetched.has(groupKey(group)))||bindings.selected?.some(group=>!fetched.has(groupKey(group)))||bindings.prepared?.some(group=>!fetched.has(groupKey(group))))fail('Cumulative group is absent from original corpora');
 if(bindings.selected){const selected=new Set(bindings.selected.map(groupKey));if(bindings.attempted.some(group=>!selected.has(groupKey(group)))||bindings.prepared?.some(group=>!selected.has(groupKey(group))))fail('Cumulative group is absent from authenticated selection');}
 for(const origin of lineage.selectedRecordOrigins){
  const run=runs.get(origin.runId);
  if(!run||run.sourceArtifactKind!==origin.sourceArtifactKind||run.artifacts.records!==origin.outputArtifactSha256||origin.currentEvidenceHash!==origin.projectedEvidenceHash||!attempted.has(groupKey(origin)))fail('Selected record origin binding mismatch');
  if(run?.assignmentMode==='codex-only'&&origin.model.provider!=='openai-subscription')fail('Codex-only selected origin provider mismatch');
  if(origin.schemaProjection!==null&&run?.recordsSchemaVersion!=='stadtstack-knowledge-v2')fail('Text schema projection requires an authenticated knowledge-v2 source');
  if(run){
   const city=run.municipalities?.find(city=>city.id===origin.municipalityId);
   if(run.attemptedDocumentGroups===0||run.municipalities!==null&&(!city||city.attemptedDocumentGroups===0||city.selectedDocumentGroups===0))fail('Selected origin lacks its own run municipality activity');
   if(run.providers!==null){
    const provider=run.providers.find(provider=>provider.provider===origin.model.provider);
    if(!provider||provider.model!==origin.model.model||provider.tool!==origin.model.tool)fail('Selected origin original provider/model/tool mismatch');
   }
  }
 }
});
export type TextRunLineage=z.infer<typeof textRunLineageSchema>;
export type AuthenticatedTextRunContribution={
 runId:string;extractionRun:z.infer<typeof textExtractionRunSchema>;pins:z.infer<typeof pinsSchema>;
 sourceArtifactKind:z.infer<typeof sourceArtifactKindSchema>;retainedPublication:z.infer<typeof retainedPublicationSchema>|null;
 records:DistrictKnowledgeRecord[];recordsSchemaVersion:z.infer<typeof recordsSchemaVersionSchema>;outputRecordIndexes:number[];quarantine:z.infer<typeof quarantineSchema>;crawl:z.infer<typeof crawlSchema>;
 /** Private parsed root metadata; native/identity admission remains the consumer's job. */
 envelopeMetadata:{schemaVersion:z.infer<typeof recordsSchemaVersionSchema>;generatedAt:string;identityAssertions:unknown[]|null;identityAdmissions:unknown[]|null};
 municipalityIds:string[];artifacts:z.infer<typeof artifactPinsSchema>;artifactClocks:z.infer<typeof artifactClocksSchema>;
 groups:{fetched:TextSourceGroup[];attempted:TextSourceGroup[];selected:TextSourceGroup[]|null;prepared:TextSourceGroup[]|null};
 providers:z.infer<typeof providerRunSchema>[]|null;
};

/** Integrity only: the managed caller must authorize reads and authenticate expected pins. */
export function readTextLineageArtifact(artifact:TextLineageArtifact):unknown{
 hashSchema.parse(artifact.sha256);
 if(sha256(artifact.bytes)!==artifact.sha256)throw Error('Text lineage artifact hash mismatch');
 return JSON.parse(typeof artifact.bytes==='string'?artifact.bytes:new TextDecoder('utf-8',{fatal:true}).decode(artifact.bytes));
}
function canonical(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonical);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
 return value;
}
export function textLineageRecordSha256(record:unknown):string{return sha256(JSON.stringify(canonical(record)));}
function groupKey(group:TextSourceGroup):string{return JSON.stringify([group.municipalityId,group.sourceSha256]);}
function uniqueGroups(groups:TextSourceGroup[]):TextSourceGroup[]{
 return [...new Map(groups.map(group=>[groupKey(group),group])).values()].sort((a,b)=>a.municipalityId<b.municipalityId?-1:a.municipalityId>b.municipalityId?1:a.sourceSha256<b.sourceSha256?-1:a.sourceSha256>b.sourceSha256?1:0);
}
function assertSubset(groups:TextSourceGroup[],superset:TextSourceGroup[],message:string){const keys=new Set(superset.map(groupKey));if(groups.some(group=>!keys.has(groupKey(group))))throw Error(message);}
function exactGroups(groups:TextSourceGroup[]|null){return groups===null?{state:'unknown' as const,count:null}:{state:'exact' as const,count:groups.length};}
function accounting(groups:AuthenticatedTextRunContribution['groups']):z.infer<typeof groupAccountingSchema>{
 const fetched=new Set(groups.fetched.map(groupKey)),attempted=new Set(groups.attempted.map(groupKey));
 const present=groups.attempted.filter(group=>fetched.has(groupKey(group))).length;
 return {fetchedDocumentGroups:fetched.size,selectedDocumentGroups:exactGroups(groups.selected),preparedDocumentGroups:exactGroups(groups.prepared),attemptedDocumentGroups:attempted.size,pendingFetchedDocumentGroups:fetched.size-present,unavailableAttemptedDocumentGroups:attempted.size-present};
}
function validateRecord(raw:unknown,run:z.infer<typeof textExtractionRunSchema>,sources:Map<string,Set<string>>):DistrictKnowledgeRecord{
 const record=recordBindingSchema.parse(raw),extraction=record.extraction,judge=record.verification.faithfulness;
 if(record.verification.evidenceHash!==knowledgeEvidenceHash(raw as DistrictKnowledgeRecord))throw Error('Original record evidence hash mismatch');
 if(record.sources.some(source=>!sources.get(record.municipalityId)?.has(source.id)||source.sha256!==extraction.inputSha256))throw Error('Original record source binding mismatch');
 if(run.assignmentMode==='codex-only'&&extraction.provider!=='openai-subscription')throw Error('Codex-only run contains another provider');
 for(const key of ['provider','model','tool','toolVersion','modelIdentitySha256'] as const)if(extraction[key]!==judge[key])throw Error('Original model/judge binding mismatch');
 return raw as DistrictKnowledgeRecord;
}

/** A sealed prior publication authenticates admitted evidence, not native candidate counts. */
function authenticateRetainedPublication(input:Extract<TextRunContribution,{sourceArtifactKind:'retained_publication'}>,run:z.infer<typeof textExtractionRunSchema>,outputRecords:unknown[],outputSchemaVersion:'stadtstack-knowledge-v2'|'stadtstack-knowledge-v3'):{provenance:z.infer<typeof retainedPublicationSchema>;recordIndexes:number[]}{
 const {manifest:manifestArtifact,coverage:coverageArtifact}=input.retainedPublication;
 const manifest=dataReleaseSchema.parse(readTextLineageArtifact(manifestArtifact));
 if(manifest.id!==dataReleaseId(manifest.files))throw Error('Retained publication manifest identity mismatch');
 requireReleaseFiles(manifest,['knowledge/records.json','knowledge/coverage.json']);
 for(const [path,artifact] of [['knowledge/records.json',input.artifacts.records],['knowledge/coverage.json',coverageArtifact]] as const){
  const member=manifest.files.find(file=>file.path===path)!;
  const bytes=typeof artifact.bytes==='string'?Buffer.byteLength(artifact.bytes,'utf8'):artifact.bytes.byteLength;
  if(member.sha256!==artifact.sha256||member.bytes!==bytes)throw Error('Retained publication member binding mismatch');
 }
 const rawCoverage=readTextLineageArtifact(coverageArtifact),header=z.object({schemaVersion:z.enum(['stadtstack-district-coverage-v3','stadtstack-district-coverage-v4','stadtstack-district-coverage-v5']),generatedAt:z.string()}).parse(rawCoverage);
 if(header.schemaVersion==='stadtstack-district-coverage-v5'&&outputSchemaVersion!=='stadtstack-knowledge-v3')throw Error('Retained v5 coverage requires its actual knowledge-v3 member');
 const provenance={manifestSha256:manifestArtifact.sha256,releaseId:manifest.id,coverageSha256:coverageArtifact.sha256,generatedAt:manifest.generatedAt,coverageGeneratedAt:header.generatedAt};
 const modelKey=(model:z.infer<typeof modelSchema>)=>JSON.stringify([model.provider,model.model,model.tool,model.toolVersion,model.modelIdentitySha256,model.modelIdentityBasis]);
 if(header.schemaVersion!=='stadtstack-district-coverage-v3'){
  const {textLineage}=z.object({textLineage:textRunLineageSchema}).parse(rawCoverage);
  const priorRun=textLineage.runs.find(item=>item.runId===input.runId);
  if(!priorRun||priorRun.generatedAt!==run.generatedAt||priorRun.assignmentMode!==run.assignmentMode||textLineageRecordSha256(priorRun.pins)!==textLineageRecordSha256(input.pins)||priorRun.scope!==run.scope||priorRun.maxDocumentsPerMunicipality!==run.maxDocumentsPerMunicipality||priorRun.availableDocumentGroups!==run.availableDocumentGroups||priorRun.attemptedDocumentGroups!==run.attemptedDocumentGroups||priorRun.pendingDocumentGroups!==run.pendingDocumentGroups)throw Error('Retained publication original run binding mismatch');
  const recordIndexes=new Map<string,number>(),textRecordIds=new Set<string>();
  outputRecords.forEach((record,index)=>{
   const identity=header.schemaVersion==='stadtstack-district-coverage-v5'?z.object({id:z.string(),kind:z.enum(['text_model','structured'])}).parse(record):z.object({id:z.string(),kind:z.literal('text_model').optional()}).parse(record);
   if(recordIndexes.has(identity.id))throw Error('Duplicate retained publication record ID');
   recordIndexes.set(identity.id,index);
   if(identity.kind!=='structured')textRecordIds.add(identity.id);
  });
  if(textRecordIds.size!==textLineage.selectedRecordOrigins.length)throw Error('Retained publication text record inventory mismatch');
  const selected:number[]=[];
  for(const origin of textLineage.selectedRecordOrigins){
   const index=recordIndexes.get(origin.recordId);
   if(index===undefined||!textRecordIds.has(origin.recordId))throw Error('Retained publication lineage text record is missing');
   const record=recordBindingSchema.parse(outputRecords[index]),extraction=record.extraction;
   if(origin.currentEvidenceHash!==record.verification.evidenceHash||record.verification.evidenceHash!==knowledgeEvidenceHash(outputRecords[index] as DistrictKnowledgeRecord)||origin.municipalityId!==record.municipalityId||origin.sourceSha256!==extraction.inputSha256||modelKey(origin.model)!==modelKey(extraction)||origin.extractionResponseSha256!==extraction.responseSha256||origin.judgeResponseSha256!==record.verification.faithfulness.responseSha256||origin.promptSha256!==extraction.promptSha256||origin.judgePromptSha256!==extraction.judgePromptSha256)throw Error('Retained publication lineage evidence binding mismatch');
   if(origin.runId===input.runId)selected.push(index);
  }
  return {provenance,recordIndexes:selected.sort((a,b)=>a-b)};
 }
 const coverage=z.object({
  extractionRun:z.object({generatedAt:z.string(),assignmentMode:z.enum(['balanced','codex-only']),...pinsSchema.shape,selection:z.enum(['all_at_run_start','bounded_per_municipality']),maxDocumentsPerMunicipality:count.nullable(),availableDocumentGroupsAtRunStart:count,attemptedDocumentGroups:count,pendingDocumentGroupsAtRunStart:count}),
  municipalities:z.array(z.object({id:z.string(),publishedRecords:count})),
  models:z.array(modelSchema.safeExtend({publishedRecords:count,faithfulnessThreshold:z.literal(0.8)})),
 }).parse(rawCoverage);
 const expected={generatedAt:run.generatedAt,assignmentMode:run.assignmentMode,corpusSha256:run.corpusSha256,registrySha256:run.registrySha256,promptContractSha256:run.promptContractSha256,schemaSha256:run.schemaSha256,selection:run.scope==='all_fetched_documents'?'all_at_run_start':'bounded_per_municipality',maxDocumentsPerMunicipality:run.maxDocumentsPerMunicipality,availableDocumentGroupsAtRunStart:run.availableDocumentGroups,attemptedDocumentGroups:run.attemptedDocumentGroups,pendingDocumentGroupsAtRunStart:run.pendingDocumentGroups};
 if(textLineageRecordSha256(coverage.extractionRun)!==textLineageRecordSha256(expected))throw Error('Retained publication original run binding mismatch');
 const records=outputRecords.map(record=>recordBindingSchema.parse(record)),cities=new Map(coverage.municipalities.map(city=>[city.id,city]));
 if(cities.size!==coverage.municipalities.length||records.some(record=>!cities.has(record.municipalityId))||coverage.municipalities.some(city=>city.publishedRecords!==records.filter(record=>record.municipalityId===city.id).length))throw Error('Retained publication record accounting mismatch');
 const models=new Map(coverage.models.map(model=>[modelKey(model),model]));
 if(models.size!==coverage.models.length||records.some(record=>!models.has(modelKey(record.extraction)))||coverage.models.some(model=>model.publishedRecords===0||model.publishedRecords!==records.filter(record=>modelKey(record.extraction)===modelKey(model)).length))throw Error('Retained publication model receipt binding mismatch');
 return {provenance,recordIndexes:outputRecords.map((_,index)=>index)};
}

/** Decode each original artifact once; no filesystem/network operations or current-source authority. */
export function authenticateTextRunContribution(input:TextRunContribution):AuthenticatedTextRunContribution{
 const sourceArtifactKind=sourceArtifactKindSchema.parse(input.sourceArtifactKind);
 if((sourceArtifactKind==='retained_publication')!==(input.retainedPublication!==undefined))throw Error('Retained publication requires explicit manifest and coverage artifacts');
 const pins=pinsSchema.parse(input.pins),run=textExtractionRunSchema.parse(readTextLineageArtifact(input.artifacts.extractionRun));
 if(input.runId!==input.artifacts.extractionRun.sha256)throw Error('Extraction run ID does not bind original artifact');
 for(const key of Object.keys(pins) as (keyof typeof pins)[])if(run[key]!==pins[key])throw Error(`Original extraction run pin mismatch: ${key}`);
 if(input.artifacts.registry.sha256!==pins.registrySha256||input.artifacts.crawl.sha256!==pins.corpusSha256)throw Error('Original registry/corpus artifact pin mismatch');
 const registry=registrySchema.parse(readTextLineageArtifact(input.artifacts.registry));
 const municipalityIds=registry.municipalities.map(city=>city.id),sources=new Map(registry.municipalities.map(city=>[city.id,new Set(city.sources.map(source=>source.id))]));
 if(sources.size!==municipalityIds.length||registry.municipalities.some(city=>sources.get(city.id)!.size!==city.sources.length))throw Error('Duplicate original registry identity');
 const crawl=crawlSchema.parse(readTextLineageArtifact(input.artifacts.crawl)),quarantine=quarantineSchema.parse(readTextLineageArtifact(input.artifacts.quarantine));
 const output=z.discriminatedUnion('schemaVersion',[
  z.object({schemaVersion:z.literal('stadtstack-knowledge-v2'),generatedAt:z.string().datetime({offset:true}),records:z.array(z.unknown())}),
  z.object({schemaVersion:z.literal('stadtstack-knowledge-v3'),generatedAt:z.string().datetime({offset:true}),records:z.array(z.unknown()),identityAssertions:z.array(z.unknown()),identityAdmissions:z.array(z.unknown())}),
 ]).parse(readTextLineageArtifact(input.artifacts.records));
 if(output.schemaVersion==='stadtstack-knowledge-v3')for(const raw of output.records){
  const record=z.object({kind:z.enum(['text_model','structured']),verification:z.object({kind:z.enum(['text_model','structured'])})}).parse(raw);
  if(record.kind!==record.verification.kind)throw Error('Knowledge-v3 record/verification kind mismatch');
 }
 const artifactClocks={extractionRun:run.generatedAt,records:output.generatedAt,quarantine:quarantine.generatedAt??null,crawl:crawl.generatedAt,registry:registry.generatedAt??null,preparationPlan:null as string|null};
 if(sourceArtifactKind==='native_extraction_output'&&(run.promotedRecords!==undefined&&count.parse(run.promotedRecords)!==output.records.length||run.quarantinedCases!==undefined&&count.parse(run.quarantinedCases)!==quarantine.cases.length))throw Error('Original output artifact record counts mismatch');
 const retained=input.sourceArtifactKind==='retained_publication'?authenticateRetainedPublication(input,run,output.records,output.schemaVersion):null;
 const outputRecordIndexes=retained?.recordIndexes??output.records.map((_,index)=>index);
 const records=outputRecordIndexes.map(index=>validateRecord(output.records[index],run,sources)),retainedPublication=retained?.provenance??null;
 if(new Set(records.map(record=>record.id)).size!==records.length)throw Error('Duplicate output record ID in original run');
 for(const item of [...crawl.documents,...crawl.checks,...quarantine.cases])if(!sources.get(item.municipalityId)?.has(item.sourceId))throw Error('Original source/registry binding mismatch');
 for(const item of quarantine.cases)if(item.candidate!==undefined){const candidate=validateRecord(item.candidate,run,sources);if(candidate.municipalityId!==item.municipalityId||candidate.extraction.inputSha256!==item.sourceSha256||!candidate.sources.some(source=>source.id===item.sourceId))throw Error('Quarantine candidate binding mismatch');}
 const fetched=uniqueGroups(crawl.documents.map(doc=>({municipalityId:doc.municipalityId,sourceSha256:doc.sha256})));
 let attempted=uniqueGroups([...records.map(record=>({municipalityId:record.municipalityId,sourceSha256:record.extraction.inputSha256})),...quarantine.cases.map(item=>({municipalityId:item.municipalityId,sourceSha256:item.sourceSha256}))]);
 if(run.availableDocumentGroups!==fetched.length||run.availableDocumentGroups!==run.attemptedDocumentGroups+run.pendingDocumentGroups)throw Error('Original extraction run counts do not bind outputs/corpus');
 assertSubset(attempted,fetched,'Original attempted group is absent from corpus');
 if((run.scope==='bounded_per_municipality')!==(run.maxDocumentsPerMunicipality!==null)||run.maxDocumentsPerMunicipality===0)throw Error('Original extraction selection policy mismatch');
 if(run.maxDocumentsPerMunicipality!==null&&municipalityIds.some(id=>attempted.filter(group=>group.municipalityId===id).length>run.maxDocumentsPerMunicipality!))throw Error('Original municipality attempt budget exceeded');
 let selected:TextSourceGroup[]|null=null,prepared:TextSourceGroup[]|null=null;
 if(input.artifacts.preparationPlan){
  const plan=z.object({schemaVersion:z.literal('stadtstack-preparation-plan-v1'),generatedAt:z.string().optional(),corpusSha256:hashSchema,registrySha256:hashSchema,maxDocumentsPerMunicipality:count.nullable(),availableDocumentGroups:count,selectedDocumentGroups:count,municipalities:z.array(z.object({id:z.string(),selectedDocumentGroups:count})),groups:z.array(z.object({expected:textSourceGroupSchema.passthrough()})),quarantine:z.array(textSourceGroupSchema.passthrough())}).parse(readTextLineageArtifact(input.artifacts.preparationPlan));
  artifactClocks.preparationPlan=plan.generatedAt??null;
  if(plan.corpusSha256!==pins.corpusSha256||plan.registrySha256!==pins.registrySha256||plan.maxDocumentsPerMunicipality!==run.maxDocumentsPerMunicipality||plan.availableDocumentGroups!==run.availableDocumentGroups)throw Error('Preparation plan original run binding mismatch');
  prepared=plan.groups.map(({expected:{municipalityId,sourceSha256}})=>({municipalityId,sourceSha256}));
  if(uniqueGroups(prepared).length!==prepared.length)throw Error('Duplicate prepared group identity');
  selected=uniqueGroups([...prepared,...plan.quarantine.map(({municipalityId,sourceSha256})=>({municipalityId,sourceSha256}))]);
  if(selected.length!==plan.selectedDocumentGroups)throw Error('Preparation selected group identity metadata incomplete');
  assertSubset(selected,fetched,'Preparation selected group absent from original corpus');
  assertSubset(attempted,selected,'Attempted group absent from authenticated selection');
  if(new Set(plan.municipalities.map(city=>city.id)).size!==municipalityIds.length||plan.municipalities.length!==municipalityIds.length||plan.municipalities.some(city=>!sources.has(city.id)))throw Error('Preparation municipality inventory mismatch');
  for(const city of plan.municipalities){
   const actual=selected.filter(group=>group.municipalityId===city.id).length,runCity=run.municipalities?.find(item=>item.id===city.id);
   if(city.selectedDocumentGroups!==actual||runCity&&(runCity.selectedDocumentGroups!==actual||runCity.preparedDocumentGroups!==undefined&&runCity.preparedDocumentGroups!==prepared.filter(group=>group.municipalityId===city.id).length))throw Error('Preparation municipality group count mismatch');
   if(run.maxDocumentsPerMunicipality!==null&&actual>run.maxDocumentsPerMunicipality)throw Error('Preparation municipality selection budget exceeded');
  }
 }
 // Only a fully attempted, authenticated selection determines missing historic group
 // identities. A partial retained record subset alone never establishes the union.
 if(sourceArtifactKind==='retained_publication'&&attempted.length!==run.attemptedDocumentGroups&&selected!==null&&selected.length===run.attemptedDocumentGroups)attempted=selected;
 if(attempted.length!==run.attemptedDocumentGroups)throw Error('Original attempt group identities are unavailable or do not bind source outputs');
 if(run.municipalities){
  if(new Set(run.municipalities.map(city=>city.id)).size!==run.municipalities.length||run.municipalities.length!==municipalityIds.length||run.municipalities.some(city=>!sources.has(city.id)))throw Error('Original run municipality inventory mismatch');
  for(const city of run.municipalities){
   const actual=attempted.filter(group=>group.municipalityId===city.id).length,available=fetched.filter(group=>group.municipalityId===city.id).length;
   if(city.availableDocumentGroups!==undefined&&city.availableDocumentGroups!==available)throw Error('Original municipality fetched counts do not bind corpus');
   if(city.attemptedDocumentGroups!==actual||city.selectedDocumentGroups<actual||city.selectedDocumentGroups>available||city.preparedDocumentGroups!==undefined&&city.preparedDocumentGroups>city.selectedDocumentGroups)throw Error('Original municipality selected/prepared/attempted counts mismatch');
   if(run.maxDocumentsPerMunicipality!==null&&city.selectedDocumentGroups>run.maxDocumentsPerMunicipality)throw Error('Original municipality selection budget exceeded');
  }
 }
 const providers=run.providers===undefined?null:z.array(providerRunSchema).parse(run.providers);
 if(providers){
  if(new Set(providers.map(row=>row.provider)).size!==providers.length)throw Error('Duplicate original provider summary');
  for(const row of providers){
   const matching=records.filter(record=>record.extraction.provider===row.provider);
   if(sourceArtifactKind==='native_extraction_output'&&row.publishedCandidates!==matching.length||row.completedGroups>row.assignedGroups||matching.some(record=>record.extraction.model!==row.model||record.extraction.tool!==row.tool))throw Error('Original provider output binding mismatch');
   if(run.assignmentMode==='codex-only'&&row.provider!=='openai-subscription'&&(row.assignedGroups||row.completedGroups||row.agreementCompleted||row.publishedCandidates))throw Error('Codex-only run claims another provider activity');
  }
  if(records.some(record=>!providers.some(row=>row.provider===record.extraction.provider)))throw Error('Missing original output provider');
 }
 const artifacts={extractionRun:input.artifacts.extractionRun.sha256,records:input.artifacts.records.sha256,quarantine:input.artifacts.quarantine.sha256,crawl:input.artifacts.crawl.sha256,registry:input.artifacts.registry.sha256,preparationPlan:input.artifacts.preparationPlan?.sha256??null};
 const envelopeMetadata={schemaVersion:output.schemaVersion,generatedAt:output.generatedAt,identityAssertions:output.schemaVersion==='stadtstack-knowledge-v3'?output.identityAssertions:null,identityAdmissions:output.schemaVersion==='stadtstack-knowledge-v3'?output.identityAdmissions:null};
 const authenticated={runId:input.runId,sourceArtifactKind,retainedPublication,extractionRun:run,pins,records,recordsSchemaVersion:output.schemaVersion,envelopeMetadata,outputRecordIndexes,quarantine,crawl,municipalityIds,artifacts,artifactClocks,groups:{fetched,attempted,selected,prepared},providers};
 freezeReceipt(authenticated);
 authenticatedRuns.add(authenticated);
 return authenticated;
}

function projectionInvariant(record:DistrictKnowledgeRecord):unknown{
 const {evidenceHash:_hash,...verification}=record.verification;
 return {...record,verification,entities:record.entities.map(({entityId:_id,identityBasis:_basis,...claims})=>claims),relations:record.relations.map(({fromId:_from,toId:_to,...claims})=>claims)};
}
/** Authenticated decoded receipts cannot be mutated or replaced before composition. */
function freezeReceipt(value:unknown):void{
 if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeReceipt(child);Object.freeze(value);}
}
const authenticatedRuns=new WeakSet<AuthenticatedTextRunContribution>();
export function buildTextRunLineage(inputs:readonly TextRunContribution[],selections:readonly TextRecordSelection[],generatedAt:string):TextRunLineage{
 return buildAuthenticatedTextRunLineage(inputs.map(authenticateTextRunContribution),selections,generatedAt);
}
/** Internal receipts avoid duplicate decoding when composition already authenticated every input. */
export function buildAuthenticatedTextRunLineage(runs:readonly AuthenticatedTextRunContribution[],selections:readonly TextRecordSelection[],generatedAt:string):TextRunLineage{
 if(runs.some(run=>!authenticatedRuns.has(run)))throw Error('Text lineage requires authenticated original contributions');
 if(!runs.length||new Set(runs.map(run=>run.runId)).size!==runs.length)throw Error('Text lineage needs distinct original runs');
 const byId=new Map(runs.map(run=>[run.runId,run])),recordIds=new Set<string>();
 const origins=selections.map(selection=>{
  const run=byId.get(selection.runId),index=run?.records.findIndex(record=>record.id===selection.recordId)??-1;
  if(!run||index<0)throw Error('Selected record does not bind original run/output');
  const original=run.records[index],projected=selection.projectedRecord;
  if(recordIds.has(selection.recordId))throw Error('Duplicate selected record origin');recordIds.add(selection.recordId);
  if(selection.originalEvidenceHash!==original.verification.evidenceHash||projected.id!==original.id||projected.verification.evidenceHash!==knowledgeEvidenceHash(projected))throw Error('Selected record evidence hash binding mismatch');
  const schemaProjection=selection.schemaProjection===undefined?null:textSchemaProjectionSchema.parse(selection.schemaProjection);
  let comparable=projected;
  if(schemaProjection!==null){
   if(run.recordsSchemaVersion!=='stadtstack-knowledge-v2'||Object.hasOwn(original,'kind')||Object.hasOwn(original.verification,'kind'))throw Error('Text schema projection requires an unmarked authenticated knowledge-v2 record');
   const {kind,...claims}=projected as DistrictKnowledgeRecord&{kind?:unknown};
   const {kind:verificationKind,...verification}=projected.verification as DistrictKnowledgeRecord['verification']&{kind?:unknown};
   if(kind!=='text_model'||verificationKind!=='text_model')throw Error('Text schema projection requires both explicit text_model markers');
   comparable={...claims,verification};
  }
  if(textLineageRecordSha256(projectionInvariant(original))!==textLineageRecordSha256(projectionInvariant(comparable)))throw Error('Selected record changes original claims or generation/judge receipts');
  const extraction=original.extraction;
  return {runId:run.runId,sourceArtifactKind:run.sourceArtifactKind,schemaProjection,recordId:original.id,outputRecordIndex:run.outputRecordIndexes[index],outputArtifactSha256:run.artifacts.records,originalRecordSha256:textLineageRecordSha256(original),originalEvidenceHash:original.verification.evidenceHash,projectedEvidenceHash:projected.verification.evidenceHash,currentEvidenceHash:projected.verification.evidenceHash,municipalityId:original.municipalityId,sourceSha256:extraction.inputSha256,model:modelSchema.parse({provider:extraction.provider,model:extraction.model,tool:extraction.tool,toolVersion:extraction.toolVersion,modelIdentitySha256:extraction.modelIdentitySha256,modelIdentityBasis:extraction.modelIdentityBasis}),extractionResponseSha256:extraction.responseSha256,judgeResponseSha256:original.verification.faithfulness.responseSha256,promptSha256:extraction.promptSha256,judgePromptSha256:extraction.judgePromptSha256};
 });
 const union=(kind:'fetched'|'attempted')=>uniqueGroups(runs.flatMap(run=>run.groups[kind]));
 const maybeUnion=(kind:'selected'|'prepared')=>runs.some(run=>run.groups[kind]===null)?null:uniqueGroups(runs.flatMap(run=>run.groups[kind]!));
 const groups={fetched:union('fetched'),attempted:union('attempted'),selected:maybeUnion('selected'),prepared:maybeUnion('prepared')};
 const municipalities=[...new Set(runs.flatMap(run=>run.municipalityIds))].sort().map(id=>({id,...accounting({fetched:groups.fetched.filter(group=>group.municipalityId===id),attempted:groups.attempted.filter(group=>group.municipalityId===id),selected:groups.selected?.filter(group=>group.municipalityId===id)??null,prepared:groups.prepared?.filter(group=>group.municipalityId===id)??null})}));
 return textRunLineageSchema.parse({schemaVersion:'stadtstack-text-run-lineage-v1',generatedAt,runs:runs.map(run=>({runId:run.runId,sourceArtifactKind:run.sourceArtifactKind,recordsSchemaVersion:run.recordsSchemaVersion,retainedPublication:run.retainedPublication,generatedAt:run.extractionRun.generatedAt,assignmentMode:run.extractionRun.assignmentMode,pins:run.pins,artifacts:run.artifacts,artifactClocks:run.artifactClocks,scope:run.extractionRun.scope,maxDocumentsPerMunicipality:run.extractionRun.maxDocumentsPerMunicipality,availableDocumentGroups:run.extractionRun.availableDocumentGroups,attemptedDocumentGroups:run.extractionRun.attemptedDocumentGroups,pendingDocumentGroups:run.extractionRun.pendingDocumentGroups,municipalities:run.extractionRun.municipalities??null,providers:run.providers,groups:accounting(run.groups)})),selectedRecordOrigins:origins,cumulative:{attemptsAcrossRuns:runs.reduce((sum,run)=>sum+run.extractionRun.attemptedDocumentGroups,0),groups:accounting(groups),groupBindings:groups,municipalities,frontierUnion:'unknown'}});
}
