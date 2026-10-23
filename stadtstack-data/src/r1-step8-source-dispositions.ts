import {z} from 'zod';
import {step8DocumentDisposition,Step8AssessmentSelectionSchema,type Step8SourceIdentity} from './r1-step8-export-projection.ts';
import {step8QueueEvidence} from './r1-step8-queue-evidence.ts';
import {classifyStep8Exception} from './r1-step8-governance.ts';
import type {ResidualExtractionSchema} from './district-residual-jobs.ts';
import type {DistrictKnowledgeRecord} from './district-schema.ts';

/** Shared by the pre-pass and execution: identical document joins and bytes. */
export function step8SourceDispositions(input:{source:Step8SourceIdentity;results:readonly z.infer<typeof ResidualExtractionSchema>[];records:readonly DistrictKnowledgeRecord[];cases:readonly unknown[];queue:unknown;extractionRun:{path:string;sha256:string};assessmentItemHolds?:readonly unknown[]}){
 const {records,cases}=input,source={municipalityId:input.source.municipalityId,sourceId:input.source.sourceId},extractionRun={path:input.extractionRun.path,sha256:input.extractionRun.sha256};
 const queue=z.object({assessments:z.array(Step8AssessmentSelectionSchema),terminalDocumentExceptions:z.array(z.object({documentId:z.string(),sourceSha256:z.string(),jobKey:z.string()}).passthrough()).default([]),terminalAssessmentExceptions:z.array(z.object({documentId:z.string()}).passthrough()).default([]),assessmentItemHolds:z.array(z.unknown()).default([])}).passthrough().parse(input.queue);
 const assessmentPins=queue.assessments.map(({recordId,pins})=>({recordId,pins}));
 const output=input.results.map(result=>{
  const document=step8DocumentDisposition(source,result,records,cases),itemHolds=(input.assessmentItemHolds??queue.assessmentItemHolds).filter(raw=>z.object({documentId:z.string()}).passthrough().parse(raw).documentId===result.documentId);
  return {...source,documentId:result.documentId,sourceSha256:result.result.sourceSha256,jobKey:result.result.taskId,admittedRecordIds:document.records.map(record=>record.id),cases:document.cases,classification:classifyStep8Exception(document.cases),assessments:assessmentPins.filter(entry=>result.result.records.some(record=>record.id===entry.recordId)),terminalAssessmentExceptions:queue.terminalAssessmentExceptions.filter(entry=>entry.documentId===result.documentId),...(itemHolds.length?{assessmentItemHolds:itemHolds}:{}),queueEvidence:step8QueueEvidence(extractionRun,input.queue,result.documentId,result.result.taskId)};
 });
 const terminals=queue.terminalDocumentExceptions.map(exception=>{
  const documentCases=cases.filter(value=>z.object({documentId:z.string().optional()}).passthrough().parse(value).documentId===exception.documentId);
  if(!documentCases.length)throw Error('Terminal document lacks explicit quarantine disposition');
  return {...source,documentId:exception.documentId,sourceSha256:exception.sourceSha256,jobKey:exception.jobKey,admittedRecordIds:[],cases:documentCases,classification:{...classifyStep8Exception(documentCases),terminal:true},terminalDocumentException:exception,assessments:[],queueEvidence:step8QueueEvidence(extractionRun,input.queue,exception.documentId,exception.jobKey)};
 });
 return [...output,...terminals];
}
