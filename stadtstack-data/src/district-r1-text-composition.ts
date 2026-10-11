import {z} from 'zod';
import {composeDistrictRelease,type DistrictReleaseComposition,type DistrictReleaseCompositionInput} from './district-release-composition.ts';
import {buildAuthenticatedTextRunLineage,textExtractionRunSchema,textSchemaProjectionSchema,type TextLineageArtifact,type TextRunContribution,type TextRecordSelection,type TextRunLineage} from './text-run-lineage.ts';
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
 contributions:z.array(z.discriminatedUnion('sourceArtifactKind',[
  z.object({...contributionPins,sourceArtifactKind:z.literal('native_extraction_output')}).strict(),
  z.object({...contributionPins,sourceArtifactKind:z.literal('retained_publication'),retainedPublication:z.object({manifest:artifactPinSchema,coverage:artifactPinSchema}).strict()}).strict(),
 ])).min(1),
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
  const artifacts={extractionRun,records,quarantine,crawl,registry,...(preparationPlan?{preparationPlan}:{})};
  const base={runId:contribution.runId,pins:contribution.pins,artifacts};
  if(contribution.sourceArtifactKind==='native_extraction_output')return {...base,sourceArtifactKind:'native_extraction_output'};
  const [manifest,coverage]=await Promise.all([load(contribution.retainedPublication.manifest),load(contribution.retainedPublication.coverage)]);
  return {...base,sourceArtifactKind:'retained_publication',retainedPublication:{manifest,coverage}};
 }));
 return {contributions,approvedRunOrder:input.approvedRunOrder,admissions:input.admissions,generatedAt:input.generatedAt};
}

/** Private source-bearing inputs; only textLineage is a public coverage field. */
export type R1TextCoverageContext={
 crawl:DistrictReleaseComposition['crawl'];
 quarantine:DistrictReleaseComposition['quarantine'];
 textLineage:TextRunLineage;
 runs:DistrictReleaseComposition['provenance']['runs'];
 selections:TextRecordSelection[];
};
export type R1TextCompositionContext={
 composition:DistrictReleaseComposition;
 knowledge:{schemaVersion:typeof KNOWLEDGE_SCHEMA_VERSION;generatedAt:string;records:DistrictKnowledgeRecord[];identityAssertions:IdentityAssertion[];identityAdmissions:IdentityAdmission[]};
 coverage:R1TextCoverageContext;
 replay:{
  generatedAt:string;
  approvedRunOrder:string[];
  admissions:DistrictReleaseCompositionInput['admissions'];
  runs:Array<{runId:string;pins:DistrictReleaseCompositionInput['contributions'][number]['pins'];sourceArtifactKind:DistrictReleaseCompositionInput['contributions'][number]['sourceArtifactKind'];artifacts:DistrictReleaseComposition['provenance']['runs'][number]['artifacts'];retainedPublication:DistrictReleaseComposition['provenance']['runs'][number]['retainedPublication']}>;
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
 const composition=composeDistrictRelease(input);
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
 if(composition.records.records.some(record=>record.kind!=='text_model'||record.verification.kind!=='text_model'))throw Error('R1 text composition requires explicit knowledge-v3 text markers; historical v2 needs an approved schemaProjection');
 const knowledge={schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt:input.generatedAt,records:composition.records.records,identityAssertions:[...assertions.values()],identityAdmissions:[...admissions.values()]};
 const replayPayload={
  generatedAt:input.generatedAt,
  approvedRunOrder:[...input.approvedRunOrder],
  admissions:input.admissions.map(admission=>({...admission,recordIds:[...admission.recordIds]})),
  runs:composition.provenance.runs.map(run=>({runId:run.runId,pins:run.pins,sourceArtifactKind:run.sourceArtifactKind,artifacts:run.artifacts,retainedPublication:run.retainedPublication})),
 };
 const dependencySha256=semanticHash(replayPayload);
 return {composition,knowledge,coverage:{crawl:composition.crawl,quarantine:composition.quarantine,textLineage:composition.lineage,runs:composition.provenance.runs,selections:composition.selections},replay:{...replayPayload,dependencySha256},dependencies:[{role:'text_composition',sha256:dependencySha256}]};
}

/** Rebind the public helper to the final admitted text subset after managed policy
 * checks. Every record must retain its selected original generation/judge receipts.
 * Native records are intentionally not accepted or charged to text group accounting.
 */
export function rebuildR1TextCoverageContext(context:R1TextCompositionContext,records:readonly DistrictKnowledgeRecord[],generatedAt:string):R1TextCoverageContext{
 const selected=new Map(context.composition.selections.map(selection=>[selection.recordId,selection]));
 const selections=records.map(record=>{
  if(record.kind!=='text_model'||record.verification.kind!=='text_model')throw Error('Native records cannot enter text lineage');
  const original=selected.get(record.id);
  if(!original)throw Error('Final text record has no selected original run');
  return {...original,projectedRecord:record};
 });
 const textLineage=buildAuthenticatedTextRunLineage(context.composition.provenance.runs,selections,generatedAt);
 return {...context.coverage,selections,textLineage};
}
