import {join} from 'node:path';
import {z} from 'zod';
import {canonicalJson,digest,HashSchema} from './district-adapter-contract.ts';
import {ResidualExtractionSchema} from './district-residual-jobs.ts';
import {encodeStepReceipt,StepReceiptSchema} from './district-step-receipt.ts';
import {loadR1TextCompositionInput,r1TextCompositionInputSchema} from './district-r1-text-composition.ts';
import {KnowledgeRecordsSchema,DistrictKnowledgeRecordSchema} from './district-schema.ts';
import {publicationPolicyReceiptInventorySchema} from './district-publication-policy.ts';
import {CriticalAssessmentInventorySchema,CriticalAdmissionsSchema} from './district-critical-assessment-contract.ts';
import {QueueTextSealInputSchema} from './district-queue-text-run.ts';
import {Step8CampaignSchema,assertStep8ExportMembership} from './r1-step8-governance.ts';
import {ImportDispositionDecisionSchema,ImportRejectionDispositionSchema} from './r1-step8-import-disposition-contract.ts';
import {projectStep8PublicationIntake,selectStep8PublicationPolicy,step8DocumentDisposition,step8AssessmentIdentity,Step8AssessmentSelectionSchema} from './r1-step8-export-projection.ts';
import type {Step8OperatorInput} from './r1-step8.ts';
import {step8SourceDispositions} from './r1-step8-source-dispositions.ts';
import {step8JsonBytes} from './r1-step8-json-budget.ts';

type Pin={path:string;sha256:string};
const pinSchema=z.object({path:z.string(),sha256:HashSchema}).passthrough();
const sealSchema=z.object({compositionArtifactSha256:HashSchema,policyInventory:pinSchema,criticalInventory:pinSchema,criticalAdmissions:pinSchema}).passthrough();
const terminalSchema=z.object({documentId:z.string(),jobKey:HashSchema,sourceSha256:HashSchema,municipalityId:z.string(),sourceId:z.string(),corpusSha256:HashSchema,reasonCode:z.string()}).passthrough();
const queueSchema=z.object({stepReceipts:z.array(z.object({receipt:StepReceiptSchema,sha256:HashSchema}).passthrough()),assessments:z.array(Step8AssessmentSelectionSchema),reconciliationJobKeys:z.array(HashSchema),terminalDocumentExceptions:z.array(terminalSchema).default([]),terminalAssessmentExceptions:z.array(z.unknown()).default([]),assessmentItemHolds:z.array(z.object({preparationJobKey:HashSchema,itemBundleArtifactSha256:HashSchema,holdReceiptArtifactSha256:HashSchema}).passthrough()).default([])}).passthrough();

/** Early refusal only. Hash-bound inspection is never a publication authority. */
export async function precheckStep8Exports(input:Step8OperatorInput,campaignRaw:unknown,readPin:(pin:Pin)=>Promise<Uint8Array>){
 const campaign=Step8CampaignSchema.parse(campaignRaw),blockers:Array<{code:string;sourceId?:string;documentId?:string;message:string}>=[],reads:Pin[]=[],sources:Array<{municipalityId:string;sourceId:string;documents:number;nativeRecords:number}>=[],compositions=[],loadedContributions=[],policies=[];
 const sourceDispositions:unknown[]=[],assessmentArtifactSizes:Array<{path:string;bytes:number}>=[];let sourceAuditPayloadBytes=0,assessmentPayloadBytes=0;
 const read=async(pin:Pin)=>{const bytes=Buffer.from(await readPin(pin));if(digest(bytes)!==pin.sha256)throw Error('Static export input digest mismatch: '+pin.path);reads.push(pin);return bytes;};
 const json=async(pin:Pin)=>JSON.parse((await read(pin)).toString('utf8'));
 const casPin=(sha256:string)=>({path:join(input.casRoot,'sha256',HashSchema.parse(sha256).slice(0,2),sha256),sha256});
 const cas=async(pin:Pin)=>{const expected=casPin(pin.sha256);if(pin.path!==expected.path)throw Error('Static export artifact escapes fixed source CAS');return read(expected);};
 const imports=input.importDispositionDecision?ImportDispositionDecisionSchema.parse(await json(input.importDispositionDecision)):undefined;
 const assessmentIds=new Set<string>();let documents=0,assessmentBundles=0;
 for(const selected of input.seals){
  let sourceId:string|undefined;
  try{
   const seal=sealSchema.parse(await json(selected.sealResult)),composition=r1TextCompositionInputSchema.parse(await json(casPin(seal.compositionArtifactSha256)));
   if(composition.contributions.length!==1||composition.retainedPublication)throw Error('Static export requires one native source contribution');
   const contribution=composition.contributions[0],source=campaign.sources.find(source=>source.corpus.sha256===contribution.pins.corpusSha256);if(!source)throw Error('Static export source corpus absent from campaign');sourceId=source.sourceId;
   if(sources.some(entry=>entry.sourceId===source.sourceId&&entry.municipalityId===source.municipalityId))throw Error('Duplicate static export source');
   const loaded=await loadR1TextCompositionInput(composition,cas),native=loaded.contributions[0];
   const extraction=JSON.parse(Buffer.from(native.artifacts.extractionRun.bytes).toString('utf8')),queue=queueSchema.parse(extraction.queue),records=z.array(DistrictKnowledgeRecordSchema).parse(KnowledgeRecordsSchema.parse(JSON.parse(Buffer.from(native.artifacts.records.bytes).toString('utf8'))).records),cases=z.array(z.unknown()).parse(JSON.parse(Buffer.from(native.artifacts.quarantine.bytes).toString('utf8')).cases);
   const steps=queue.stepReceipts.map(row=>{const encoded=encodeStepReceipt(row.receipt);if(encoded.sha256!==row.sha256)throw Error('Static export StepReceipt hash mismatch');return {receipt:encoded.receipt,sha256:row.sha256};});
   const duplicateJobs=new Set(queue.terminalDocumentExceptions.filter(entry=>entry.reasonCode==='duplicate_source_content').map(entry=>entry.jobKey));
   const results=[];
   for(const jobKey of [...selected.jobKeys].sort()){
    const matching=steps.filter(row=>row.receipt.jobKey===jobKey&&row.receipt.step==='residual_extract');if(matching.length!==1||matching[0].receipt.outputHashes.length!==1)throw Error('Missing/ambiguous selected static extraction receipt');
    const result=ResidualExtractionSchema.parse(await json(casPin(matching[0].receipt.outputHashes[0])));
    if(result.result.taskId!==jobKey||result.result.municipalityId!==source.municipalityId||result.corpusSha256!==source.corpus.sha256)throw Error('Static extraction changes selected job/source identity');
    if(duplicateJobs.has(jobKey))continue;
    try{step8DocumentDisposition(source,result,records,cases);}catch(error){blockers.push({code:'DOCUMENT_DISPOSITION',sourceId,documentId:result.documentId,message:(error as Error).message});}
    results.push(result);
   }
   const importSource=imports?.sources.find(entry=>entry.sourceId===source.sourceId&&entry.municipalityId===source.municipalityId&&entry.corpus.sha256===source.corpus.sha256);
   const dispositions=importSource?.documents.map(document=>ImportRejectionDispositionSchema.parse({kind:'import_rejection',...document,municipalityId:source.municipalityId,sourceId:source.sourceId,corpusSha256:source.corpus.sha256,rule:'crawl_import_rejection_v1',decision:input.importDispositionDecision,sealResult:importSource.sealResult,manifest:importSource.manifest,importResult:importSource.importResult,registry:contribution.artifacts.registry,processed:false,admittedRecordIds:[]}))??[];
   assertStep8ExportMembership(source,results,queue.terminalDocumentExceptions,steps,dispositions);
   sourceDispositions.push(...step8SourceDispositions({source,results,records,cases,queue:extraction.queue,extractionRun:contribution.artifacts.extractionRun}));
   for(const disposition of dispositions)sourceDispositions.push({municipalityId:disposition.municipalityId,sourceId:disposition.sourceId,documentId:disposition.documentId,sourceSha256:disposition.sourceSha256,admittedRecordIds:[],cases:[],classification:{critical:false,rights:disposition.reasonCode==='source_policy_stale',disagreement:false},importDisposition:disposition,assessments:[]});
   sourceAuditPayloadBytes+=step8JsonBytes({terminalDocuments:queue.terminalDocumentExceptions,terminalAssessments:queue.terminalAssessmentExceptions,itemHolds:queue.assessmentItemHolds,admittedRecordIds:records.map(record=>record.id)},'source audit fields',undefined,2);
   for(const exception of queue.terminalDocumentExceptions)if(!cases.some(value=>z.object({documentId:z.string().optional()}).passthrough().parse(value).documentId===exception.documentId))throw Error('Terminal document lacks explicit quarantine disposition');
   for(const [key,schema] of [['terminalDocumentExceptions',QueueTextSealInputSchema.shape.terminalDocumentExceptions],['terminalAssessmentExceptions',QueueTextSealInputSchema.shape.terminalAssessmentExceptions]] as const){const fields=z.object({documentId:z.string(),step:z.string(),jobKey:HashSchema,receiptId:z.uuid(),receiptSha256:HashSchema,reasonCode:z.string()}),actual=schema.parse(queue[key].filter((entry)=>!(typeof entry==='object'&&entry!==null&&'reasonCode' in entry&&entry.reasonCode==='duplicate_source_content')).map(entry=>fields.parse(entry))),expected=schema.parse(selected[key]);if(canonicalJson(actual.sort((a,b)=>a.jobKey.localeCompare(b.jobKey)))!==canonicalJson(expected.sort((a,b)=>a.jobKey.localeCompare(b.jobKey))))throw Error('Static terminal exception selection differs from seal');}
   if(canonicalJson([...selected.reconciliationJobKeys].sort())!==canonicalJson(queue.reconciliationJobKeys))throw Error('Static reconciliation selection differs from seal');
   const holds=queue.assessmentItemHolds.map(({preparationJobKey,itemBundleArtifactSha256,holdReceiptArtifactSha256})=>({preparationJobKey,itemBundleArtifactSha256,holdReceiptArtifactSha256}));if(canonicalJson([...selected.assessmentItemHolds].sort((a,b)=>a.holdReceiptArtifactSha256.localeCompare(b.holdReceiptArtifactSha256)))!==canonicalJson(holds))throw Error('Static assessment hold selection differs from seal');
   for(const assessment of queue.assessments)if(assessment.pins){if(assessment.recordId!==assessment.pins.recordId)throw Error('Static assessment target differs from pins');const identity=step8AssessmentIdentity(source,assessment.pins);if(assessmentIds.has(identity.assessmentId))throw Error('Duplicate immutable static assessment identity');assessmentIds.add(identity.assessmentId);for(const hash of [assessment.pins.itemArtifactSha256,assessment.pins.AArtifactSha256,assessment.pins.BArtifactSha256,assessment.pins.CArtifactSha256,assessment.pins.finalArtifactSha256]){const pin=casPin(hash),bytes=await read(pin);assessmentPayloadBytes+=bytes.length;assessmentArtifactSizes.push({path:pin.path,bytes:bytes.length});}assessmentBundles++;}
   const policy=publicationPolicyReceiptInventorySchema.parse(await json(seal.policyInventory));CriticalAssessmentInventorySchema.parse(await json(seal.criticalInventory));CriticalAdmissionsSchema.parse(await json(seal.criticalAdmissions));
   compositions.push(composition);loadedContributions.push(native);policies.push({runId:contribution.runId,inventory:policy});documents+=results.length+queue.terminalDocumentExceptions.length+dispositions.length;
   sources.push({municipalityId:source.municipalityId,sourceId:source.sourceId,documents:results.length+queue.terminalDocumentExceptions.length+dispositions.length,nativeRecords:records.length});
  }catch(error){blockers.push({code:'SEALED_EXPORT_PROJECTION',sourceId,message:(error as Error).message});}
 }
 let publication,jsonArtifacts;
 try{
  if(sources.length!==input.expectedSources||documents!==input.expectedDocuments)throw Error('Static export campaign inventory incomplete');
  const projection=projectStep8PublicationIntake({generatedAt:input.clocks.recordsGeneratedAt,approvedRunOrder:compositions.flatMap(value=>value.approvedRunOrder),admissions:compositions.flatMap(value=>value.admissions),contributions:loadedContributions});
  const policy=selectStep8PublicationPolicy(projection.context,policies);
  publication={records:projection.context.knowledge.records.length,intakeHolds:projection.holds.map(({runId,recordId,recordEvidenceSha256,hold})=>({runId,recordId,recordEvidenceSha256,...hold})),policyRecords:policy.records.length};
  jsonArtifacts={sourceDispositionArrayBytes:step8JsonBytes(sourceDispositions,'source disposition array'),sourceAuditPayloadBytes,assessmentPayloadBytes,assessmentArtifactSizes,publicationRecordsBytes:step8JsonBytes(projection.context.knowledge),publicationQuarantineBytes:step8JsonBytes(projection.context.coverage.quarantine),publicationPolicyBytes:step8JsonBytes(policy),textCompositionBytes:step8JsonBytes({schemaVersion:'district-r1-text-composition-input-v1',generatedAt:input.clocks.recordsGeneratedAt,approvedRunOrder:compositions.flatMap(value=>value.approvedRunOrder),admissions:projection.input.admissions,contributions:compositions.flatMap(value=>value.contributions)})};
 }catch(error){blockers.push({code:'PUBLICATION_EXPORT_PROJECTION',message:(error as Error).message});}
 return {schemaVersion:'stadtstack-r1-step8-export-precheck-v1' as const,status:blockers.length?'blocked':'passed',readOnly:true,writes:[],canonicalPasses:0,sources,documents,assessmentBundles,publication,jsonArtifacts,blockers,reads};
}
