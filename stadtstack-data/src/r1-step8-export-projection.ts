import {z} from 'zod';
import {HashSchema,canonicalJson,semanticHash} from './district-adapter-contract.ts';
import {KnowledgeRecordsSchema,DistrictKnowledgeRecordSchema,type DistrictKnowledgeRecord} from './district-schema.ts';
import {knowledgePublicationHold,knowledgePublicationQuarantineCase} from './district-publication.ts';
import {buildR1TextCompositionContext,type R1TextCompositionContext} from './district-r1-text-composition.ts';
import type {DistrictReleaseCompositionInput} from './district-release-composition.ts';
import {CriticalAssessmentInventorySchema} from './district-critical-assessment-contract.ts';
import {publicationPolicyReceiptInventorySchema} from './district-publication-policy.ts';
import type {ResidualExtractionSchema} from './district-residual-jobs.ts';

export interface Step8SourceIdentity {municipalityId:string;sourceId:string}
type ResidualResult=z.infer<typeof ResidualExtractionSchema>;
type PublicationPolicyInventory=z.infer<typeof publicationPolicyReceiptInventorySchema>;
type AssessmentPins=z.infer<typeof CriticalAssessmentInventorySchema>['records'][number];
export const Step8AssessmentSelectionSchema=z.object({recordId:z.string().min(1),pins:CriticalAssessmentInventorySchema.shape.records.element.nullable()}).passthrough();
export const Step8AssessmentIdentitySchema=z.object({assessmentId:HashSchema,municipalityId:z.string().min(1),sourceId:z.string().min(1),recordId:z.string().min(1),finalArtifactSha256:HashSchema}).strict();
export type Step8AssessmentIdentity=z.infer<typeof Step8AssessmentIdentitySchema>;
export const Step8AuditAssessmentSchema=Step8AssessmentIdentitySchema.extend({item:z.string().min(1),A:z.string().min(1),B:z.string().min(1),C:z.string().min(1)}).strict();
export const Step8AssessmentManifestRowSchema=z.object({assessmentId:HashSchema,item:z.string().min(1),A:z.string().min(1),B:z.string().min(1),C:z.string().min(1)}).strict();

/** A record ID can have different genuine assessments in different source runs. */
export function step8AssessmentIdentity(source:Step8SourceIdentity,raw:AssessmentPins):Step8AssessmentIdentity {
 const pins=CriticalAssessmentInventorySchema.shape.records.element.parse(raw);
 return Step8AssessmentIdentitySchema.parse({assessmentId:semanticHash({municipalityId:source.municipalityId,sourceId:source.sourceId,pins}),municipalityId:source.municipalityId,sourceId:source.sourceId,recordId:pins.recordId,finalArtifactSha256:pins.finalArtifactSha256});
}

/** Only the two actual producer namespaces (or an absent legacy ID) are admitted. */
export function step8DocumentDisposition(source:Step8SourceIdentity,result:ResidualResult,records:readonly DistrictKnowledgeRecord[],cases:readonly unknown[]){
 if(result.result.municipalityId!==source.municipalityId)throw Error('Step8 document municipality differs from source');
 const original=result.result.sourceSha256,native=new Map(result.result.records.map(record=>[record.id,record]));
 const admitted=records.filter(record=>record.extraction.inputSha256===original);
 for(const record of admitted){const candidate=native.get(record.id);if(record.municipalityId!==source.municipalityId||!record.sources.some(reference=>reference.id===source.sourceId&&reference.sha256===original)||!candidate||canonicalJson(candidate)!==canonicalJson(record))throw Error('Step8 document admission differs from its exact native result');}
 const shape=z.object({documentId:z.string().optional(),municipalityId:z.string(),sourceId:z.string(),sourceSha256:HashSchema}).passthrough();
 const documentCases=cases.filter(value=>{const entry=shape.parse(value);return entry.municipalityId===source.municipalityId&&entry.sourceId===source.sourceId&&entry.sourceSha256===original&&(entry.documentId===result.documentId||entry.documentId==='document:'+original||entry.documentId===undefined);});
 if(!admitted.length&&!documentCases.length)throw Error(`Document has neither admission nor explicit disposition: ${source.municipalityId}/${source.sourceId}/${result.documentId}/${result.result.taskId}`);
 return {records:admitted,cases:documentCases};
}

/** The original envelopes remain immutable; only explicit publication admissions change. */
export function projectStep8PublicationIntake(input:DistrictReleaseCompositionInput){
 const holds:Array<{runId:string;recordId:string;recordEvidenceSha256:string;record:DistrictKnowledgeRecord;hold:NonNullable<ReturnType<typeof knowledgePublicationHold>>}>=[];
 const byRun=new Map(input.contributions.map(contribution=>[contribution.runId,z.array(DistrictKnowledgeRecordSchema).parse(KnowledgeRecordsSchema.parse(JSON.parse(Buffer.from(contribution.artifacts.records.bytes).toString('utf8'))).records)]));
 const admissions=input.admissions.map(admission=>{
  if(new Set(admission.recordIds).size!==admission.recordIds.length)throw Error('Duplicate record in publication intake admission');
  const records=byRun.get(admission.runId);if(!records)throw Error('Publication intake references an absent original run');
  const byId=new Map(records.map(record=>[record.id,record]));
  return {...admission,recordIds:admission.recordIds.filter(id=>{const record=byId.get(id);if(!record)throw Error('Publication intake references an absent original record');if(record.verification.status!=='auto-verified')throw Error('Publication intake cannot promote an original candidate');const hold=knowledgePublicationHold(record);if(!hold)return true;holds.push({runId:admission.runId,recordId:id,recordEvidenceSha256:record.verification.evidenceHash,record,hold});return false;})};
 });
 const projected={...input,admissions},context=buildR1TextCompositionContext(projected);
 return {input:projected,context,holds};
}

/** Preparation re-derives, rather than trusts, the holds behind omitted original rows. */
export function withheldStep8PublicationIntake(context:R1TextCompositionContext){
 return context.composition.provenance.withheldRecords.flatMap(({runId,record})=>{const omitted=context.composition.audit.records.some(entry=>entry.runId===runId&&entry.recordId===record.id&&entry.disposition==='withheld_by_intake'),hold=omitted&&record.verification.status==='auto-verified'?knowledgePublicationHold(record):null;return hold?[{record,hold,quarantine:knowledgePublicationQuarantineCase(record,hold)}]:[];});
}

export function selectStep8PublicationPolicy(context:R1TextCompositionContext,sources:readonly {runId:string;inventory:PublicationPolicyInventory}[]){
 const byRun=new Map<string,PublicationPolicyInventory>(),currentAdmissionReceipts:Record<string,string>={};
 for(const source of sources){if(byRun.has(source.runId))throw Error('Duplicate publication policy run');const inventory=publicationPolicyReceiptInventorySchema.parse(source.inventory),ids=new Set<string>();for(const entry of inventory.records){if(ids.has(entry.recordId))throw Error('Duplicate publication policy record inside original run');ids.add(entry.recordId);}byRun.set(source.runId,inventory);for(const [original,current] of Object.entries(inventory.currentAdmissionReceipts??{})){if(currentAdmissionReceipts[original]&&currentAdmissionReceipts[original]!==current)throw Error('Conflicting source policy continuation');currentAdmissionReceipts[original]=current;}}
 const originals=new Map(context.composition.provenance.runs.map(run=>[run.runId,run.records]));
 const records=context.composition.selections.map(selection=>{
  const original=originals.get(selection.runId)?.find(record=>record.id===selection.recordId),entry=byRun.get(selection.runId)?.records.find(record=>record.recordId===selection.recordId);
  if(!original||original.verification.evidenceHash!==selection.originalEvidenceHash||!entry)throw Error('Selected publication policy lacks exact original run/record/evidence custody');
  const expected=original.sources.map(source=>canonicalJson([source.url,source.sha256])).sort(),actual=entry.receipts.map(receipt=>canonicalJson([receipt.sourceUrl,receipt.sourceSha256])).sort();
  if(canonicalJson(expected)!==canonicalJson(actual))throw Error('Selected publication policy source membership differs');
  return entry;
 });
 return publicationPolicyReceiptInventorySchema.parse({records,currentAdmissionReceipts});
}
