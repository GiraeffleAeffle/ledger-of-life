import {z} from 'zod';
import {composeDistrictRelease,type DistrictReleaseComposition,type DistrictReleaseCompositionInput} from './district-release-composition.ts';
import {buildAuthenticatedTextRunLineage,textExtractionRunSchema,textSchemaProjectionSchema,type TextLineageArtifact,type TextRunContribution,type TextRecordSelection,type TextRunLineage} from './text-run-lineage.ts';
import {authenticateRetainedKnowledgePublication,type RetainedKnowledgeComposition,type RetainedKnowledgeLineage,type RetainedKnowledgePublicationInput,projectKnowledgeRecordIdentity,retainedKnowledgeRecordOrigin,validateRetainedKnowledgeComposition} from './retained-knowledge-lineage.ts';
import {KnowledgeRecordsSchema,KNOWLEDGE_SCHEMA_VERSION,hashSchema,sha256,type DistrictKnowledgeRecord} from './district-schema.ts';
import {canonicalJson,semanticHash} from './district-adapter-contract.ts';
import type {IdentityAssertion,IdentityAdmission} from './district-entity-resolution.ts';

const artifactPinSchema=z.object({path:z.string().min(1),sha256:hashSchema}).strict();
const inputPinsSchema=textExtractionRunSchema.pick({corpusSha256:true,registrySha256:true,promptContractSha256:true,schemaSha256:true}).strict();
const contributionPins={runId:hashSchema,pins:inputPinsSchema,artifacts:z.object({extractionRun:artifactPinSchema,records:artifactPinSchema,quarantine:artifactPinSchema,crawl:artifactPinSchema,registry:artifactPinSchema,preparationPlan:artifactPinSchema.optional()}).strict()};
/** Private managed-I/O serialization only; all text semantics use canonical schemas. */
export const r1TextCompositionInputSchema=z.object({
 schemaVersion:z.literal('district-r1-text-composition-input-v1'),
 generatedAt:z.iso.datetime({offset:true}),
 approvedRunOrder:z.array(hashSchema).min(1),
 admissions:z.array(z.object({runId:hashSchema,recordIds:z.array(z.string().min(1)),schemaProjection:textSchemaProjectionSchema.optional()}).strict()).min(1),
 contributions:z.array(z.object({...contributionPins,sourceArtifactKind:z.literal('native_extraction_output')}).strict()).min(1),
 retainedPublication:z.object({manifest:artifactPinSchema,records:artifactPinSchema,coverage:artifactPinSchema,registry:artifactPinSchema,recordIds:z.array(z.string().min(1)).min(1),schemaProjection:textSchemaProjectionSchema.optional()}).strict().optional(),
}).strict();
export type R1TextCompositionArtifactPin=z.infer<typeof artifactPinSchema>;

/** The callback owns authorization and path confinement. This helper only binds
 * the bytes it receives to independently declared pins, without copying them.
 */
export async function loadR1TextCompositionInput(raw:unknown,loadArtifact:(pin:R1TextCompositionArtifactPin)=>Promise<string|Uint8Array>):Promise<DistrictReleaseCompositionInput>{
 const input=r1TextCompositionInputSchema.parse(raw);
 const load=async(pin:R1TextCompositionArtifactPin):Promise<TextLineageArtifact>=>{
  const bytes=await loadArtifact(pin);
  if(sha256(bytes)!==pin.sha256)throw Error('Text composition artifact pin mismatch');
  return {bytes,sha256:pin.sha256};
 };
 const contributions=await Promise.all(input.contributions.map(async(contribution):Promise<TextRunContribution>=>{
  const pins=contribution.artifacts;
  const [extractionRun,records,quarantine,crawl,registry,preparationPlan]=await Promise.all([load(pins.extractionRun),load(pins.records),load(pins.quarantine),load(pins.crawl),load(pins.registry),pins.preparationPlan?load(pins.preparationPlan):undefined]);
  return {runId:contribution.runId,pins:contribution.pins,sourceArtifactKind:'native_extraction_output',artifacts:{extractionRun,records,quarantine,crawl,registry,...(preparationPlan?{preparationPlan}:{})}};
 }));
 const retainedPublication:RetainedKnowledgePublicationInput|undefined=input.retainedPublication?{
  artifacts:{manifest:await load(input.retainedPublication.manifest),records:await load(input.retainedPublication.records),coverage:await load(input.retainedPublication.coverage),registry:await load(input.retainedPublication.registry)},
  recordIds:input.retainedPublication.recordIds,
  ...(input.retainedPublication.schemaProjection?{schemaProjection:input.retainedPublication.schemaProjection}:{})
 }:undefined;
 return {contributions,approvedRunOrder:input.approvedRunOrder,admissions:input.admissions,...(retainedPublication?{retainedPublication}:{}),generatedAt:input.generatedAt};
}

/** Canonical retained-publication loader shared by preparation and publication. */
export async function loadRetainedPublicationComposition(rawTextCompositionInput:unknown,loadArtifact:(pin:R1TextCompositionArtifactPin)=>Promise<string|Uint8Array>):Promise<RetainedKnowledgeComposition|null>{
 const input=r1TextCompositionInputSchema.parse(rawTextCompositionInput);
 if(!input.retainedPublication)return null;
 const pin=input.retainedPublication,load=async(artifactPin:R1TextCompositionArtifactPin):Promise<TextLineageArtifact>=>{
  const bytes=await loadArtifact(artifactPin);
  if(sha256(bytes)!==artifactPin.sha256)throw Error('Text composition artifact pin mismatch');
  return {bytes,sha256:artifactPin.sha256};
 };
 const baseline=authenticateRetainedKnowledgePublication({artifacts:{manifest:await load(pin.manifest),records:await load(pin.records),coverage:await load(pin.coverage),registry:await load(pin.registry)},recordIds:pin.recordIds,...(pin.schemaProjection?{schemaProjection:pin.schemaProjection}:{})});
 const selectedRecordOrigins=pin.recordIds.map(recordId=>{
  const localIndex=baseline.records.findIndex(record=>record.id===recordId);
  if(localIndex<0)throw Error('Retained selection references an absent original record');
  const projected=projectKnowledgeRecordIdentity(baseline.records[localIndex],baseline.input.schemaProjection);
  return retainedKnowledgeRecordOrigin(baseline,baseline.recordIndexes[localIndex],projected);
 });
 return validateRetainedKnowledgeComposition({baseline,selectedRecordOrigins});
}

/** Private source-bearing inputs; only textLineage and retainedPublication are public coverage fields. */
export type R1TextCoverageContext={
 crawl:DistrictReleaseComposition['crawl'];
 quarantine:DistrictReleaseComposition['quarantine'];
 textLineage:TextRunLineage;
 retainedPublication:RetainedKnowledgeLineage|null;
 runs:DistrictReleaseComposition['provenance']['runs'];
 selections:TextRecordSelection[];
};
export type R1TextCompositionContext={
 composition:DistrictReleaseComposition;
 retainedPublication:RetainedKnowledgeComposition|null;
 knowledge:{schemaVersion:typeof KNOWLEDGE_SCHEMA_VERSION;generatedAt:string;records:DistrictKnowledgeRecord[];identityAssertions:IdentityAssertion[];identityAdmissions:IdentityAdmission[]};
 coverage:R1TextCoverageContext;
 replay:{
  generatedAt:string;
  approvedRunOrder:string[];
  admissions:DistrictReleaseCompositionInput['admissions'];
  runs:Array<{runId:string;pins:DistrictReleaseCompositionInput['contributions'][number]['pins'];sourceArtifactKind:DistrictReleaseCompositionInput['contributions'][number]['sourceArtifactKind'];artifacts:DistrictReleaseComposition['provenance']['runs'][number]['artifacts'];retainedPublication:DistrictReleaseComposition['provenance']['runs'][number]['retainedPublication']}>;
  retainedPublication:DistrictReleaseCompositionInput['retainedPublication']|null;
  dependencySha256:string;
 };
 dependencies:Array<{role:'text_composition';sha256:string}>;
};

function mergeOriginal<T>(target:Map<string,T>,values:readonly T[],key:(value:T)=>string,label:string){
 for(const value of values){
  const id=key(value),previous=target.get(id);
  if(previous!==undefined&&canonicalJson(previous)!==canonicalJson(value))throw Error(`Conflicting original ${label}`);
  if(previous===undefined)target.set(id,value);
 }
}

/** Pure adapter over the shared authenticated composition. Managed callers still
 * authorize all reads and current policy; this neither reads files nor grants rights.
 * Root v3 identity histories are retained, never reconstructed from text claims.
 */
export function buildR1TextCompositionContext(input:DistrictReleaseCompositionInput):R1TextCompositionContext{
 const composition=composeDistrictRelease(input),retainedPublication=composition.retainedPublication;
 const assertions=new Map<string,IdentityAssertion>();
 const admissions=new Map<string,IdentityAdmission>();
 for(const run of composition.provenance.runs){
  if(run.recordsSchemaVersion!=='stadtstack-knowledge-v3')continue;
  const original=run.envelopeMetadata;
  if(original.identityAssertions===null||original.identityAdmissions===null)throw Error('Knowledge-v3 input requires authenticated original identity root arrays');
  const rootAssertions=KnowledgeRecordsSchema.shape.identityAssertions.parse(original.identityAssertions);
  const rootAdmissions=KnowledgeRecordsSchema.shape.identityAdmissions.parse(original.identityAdmissions);
  mergeOriginal(assertions,rootAssertions,value=>canonicalJson([value.id,value.version]),'identity assertion version');
  mergeOriginal(admissions,rootAdmissions,value=>canonicalJson([value.assertionId,value.assertionSha256,value.assessmentReceiptSha256]),'identity admission');
 }
 const nativeRecords=composition.records.records;
 if(nativeRecords.some(record=>record.kind!=='text_model'||record.verification.kind!=='text_model'))throw Error('R1 text composition requires explicit knowledge-v3 text markers; historical v2 needs an approved schemaProjection');
 const retainedRecords=retainedPublication?.selectedRecordOrigins.map(origin=>{const index=retainedPublication.baseline.recordIndexes.indexOf(origin.outputRecordIndex);if(index<0)throw Error('Retained origin references an absent output record');return projectKnowledgeRecordIdentity(retainedPublication.baseline.records[index],retainedPublication.baseline.input.schemaProjection);})??[];
 const recordById=new Map<string,DistrictKnowledgeRecord>();
 for(const record of [...retainedRecords,...nativeRecords])recordById.set(record.id,record);
 const knowledge={schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt:input.generatedAt,records:[...recordById.values()],identityAssertions:[...assertions.values()],identityAdmissions:[...admissions.values()]};
 const replayPayload={
  generatedAt:input.generatedAt,
  approvedRunOrder:[...input.approvedRunOrder],
  admissions:input.admissions.map(admission=>({...admission,recordIds:[...admission.recordIds]})),
  runs:composition.provenance.runs.map(run=>({runId:run.runId,pins:run.pins,sourceArtifactKind:run.sourceArtifactKind,artifacts:run.artifacts,retainedPublication:run.retainedPublication})),
  retainedPublication:input.retainedPublication??null,
 };
 const dependencySha256=semanticHash(replayPayload);
 return {composition,retainedPublication,knowledge,coverage:{crawl:composition.crawl,quarantine:composition.quarantine,textLineage:composition.lineage,retainedPublication:retainedPublication?{...retainedPublication.baseline.lineage,selectedRecordOrigins:retainedPublication.selectedRecordOrigins}:null,runs:composition.provenance.runs,selections:composition.selections},replay:{...replayPayload,dependencySha256},dependencies:[{role:'text_composition',sha256:dependencySha256}]};
}

/** Rebind the public helper to the final admitted text subset after managed policy
 * checks. Every record must retain its selected original generation/judge receipts.
 * Native records are intentionally not accepted or charged to text group accounting.
 */
export function rebuildR1TextCoverageContext(context:R1TextCompositionContext,records:readonly DistrictKnowledgeRecord[],generatedAt:string):R1TextCoverageContext{
 const nativeSelected=new Map(context.composition.selections.map(selection=>[selection.recordId,selection]));
 const retainedSelected=new Map(context.retainedPublication?.selectedRecordOrigins.map(origin=>[origin.recordId,origin])??[]);
 const nativeRecords=records.filter(record=>nativeSelected.has(record.id));
 const selections=nativeRecords.map(record=>{
  if(record.kind!=='text_model'||record.verification.kind!=='text_model')throw Error('Native records cannot enter text lineage');
  const original=nativeSelected.get(record.id)!;
  return {...original,projectedRecord:record};
 });
 if(records.some(record=>!nativeSelected.has(record.id)&&!retainedSelected.has(record.id)))throw Error('Final text record has no selected original contribution');
 const textLineage=buildAuthenticatedTextRunLineage(context.composition.provenance.runs,selections,generatedAt);
 const selectedRecordOrigins=context.composition.retainedPublication?.selectedRecordOrigins.flatMap(origin=>{
  const record=records.find(item=>item.id===origin.recordId);
  return record&&retainedSelected.has(record.id)?[retainedKnowledgeRecordOrigin(context.composition.retainedPublication!.baseline,origin.outputRecordIndex,record)]:[];
 })??[];
 const retainedPublication=context.composition.retainedPublication?{...context.composition.retainedPublication.baseline.lineage,selectedRecordOrigins}:null;
 return {...context.coverage,selections,textLineage,retainedPublication};
}
