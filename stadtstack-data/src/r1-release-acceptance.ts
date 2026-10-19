import {createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {HashSchema,canonicalJson} from './district-adapter-contract.ts';
import {classifyStep8Exception,Step8CampaignSchema} from './r1-step8-governance.ts';
import {dataReleaseSchema,verifyDataRelease} from './data-release.ts';
import {writeImmutable} from './district-assessment.ts';
import {ReasonCodeSchema,JobOutcomeSchema} from './district-step-receipt.ts';
import {RELEASE_ACCEPTANCE_RULES,readCandidateMaterialContext,bindReleaseExceptionContext,type CandidateMaterialContext} from './r1-release-context.ts';
import {Step8CurrentGenerationSchema} from './r1-step8-current-policy.ts';
import {ImportRejectionDispositionSchema} from './r1-step8-import-disposition-contract.ts';

export const OPTION_B_APPROVAL_SHA256='865e80d2aad2ec23250b83b50c012639d0b04f068fc64d42eabe1b36a82b35f5';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const semanticHash=(value:unknown)=>hash(canonicalJson(value));
export const AcceptancePinSchema=z.object({path:z.string().refine(isAbsolute),sha256:HashSchema}).strict();
export const Step8AcceptancePinsSchema=z.object({gate:AcceptancePinSchema,exceptions:AcceptancePinSchema,handoff:AcceptancePinSchema}).strict();
export type Step8AcceptancePins=z.infer<typeof Step8AcceptancePinsSchema>;
const gateSchema=z.object({schemaVersion:z.literal('stadtstack-r1-step8-gate-v1'),status:z.string(),releaseId:HashSchema,
  manifestSha256:HashSchema,candidateDirectory:z.string().refine(isAbsolute),campaign:AcceptancePinSchema,
  currentGeneration:Step8CurrentGenerationSchema,generationAuditEvidence:AcceptancePinSchema,
  exceptionInventory:AcceptancePinSchema,step9Handoff:AcceptancePinSchema,replayReceipt:AcceptancePinSchema,
  replayAuditSha256:HashSchema,checks:z.array(z.string()),generationNonce:z.string().min(1)}).passthrough();
const handoffSchema=z.object({schemaVersion:z.literal('stadtstack-r1-step9-handoff-v1'),releaseId:HashSchema,
  candidateDirectory:z.string().refine(isAbsolute),exceptionInventory:AcceptancePinSchema,assessmentManifest:AcceptancePinSchema,policy:z.unknown()}).strict();
const classificationSchema=z.object({critical:z.boolean(),rights:z.boolean(),disagreement:z.boolean(),terminal:z.boolean().optional()}).strict();
const nativeDispositionSchema=z.object({municipalityId:z.string(),sourceId:z.string(),documentId:z.string(),sourceSha256:HashSchema,jobKey:HashSchema,
  admittedRecordIds:z.array(z.string()),cases:z.array(z.unknown()),classification:classificationSchema,assessments:z.array(z.unknown()),
  terminalDocumentException:z.unknown().optional(),terminalAssessmentExceptions:z.array(z.unknown()).optional(),assessmentItemHolds:z.array(z.unknown()).optional(),queueEvidence:z.unknown()}).strict();
const importDispositionSchema=z.object({municipalityId:z.string(),sourceId:z.string(),documentId:z.string(),sourceSha256:HashSchema,
  admittedRecordIds:z.tuple([]),cases:z.tuple([]),classification:classificationSchema,assessments:z.tuple([]),importDisposition:ImportRejectionDispositionSchema}).strict().superRefine((entry,ctx)=>{
  if(entry.municipalityId!==entry.importDisposition.municipalityId||entry.sourceId!==entry.importDisposition.sourceId||entry.documentId!==entry.importDisposition.documentId||entry.sourceSha256!==entry.importDisposition.sourceSha256
    ||entry.classification.critical||entry.classification.disagreement||entry.classification.terminal!==undefined||entry.classification.rights!==(entry.importDisposition.reasonCode==='source_policy_stale'))ctx.addIssue({code:'custom',message:'Import disposition identity or classification mismatch'});
});
const dispositionSchema=z.union([nativeDispositionSchema,importDispositionSchema]);
export const Step8ExceptionInventorySchema=z.object({schemaVersion:z.literal('stadtstack-r1-step8-exceptions-v1'),releaseId:HashSchema,
  campaign:AcceptancePinSchema,sourceDispositionInventory:AcceptancePinSchema.optional(),complete:z.boolean(),sourceDispositions:z.array(dispositionSchema),
  generationAuditEvidence:AcceptancePinSchema.optional(),
  native:z.object({coverage:z.array(z.unknown()),fieldHolds:z.record(z.string(),z.unknown())}).strict(),
  preparation:z.object({publicationQuarantine:z.object({schemaVersion:z.literal('stadtstack-publication-quarantine-v1'),records:z.array(z.unknown())}).strict(),
    criticalHolds:z.array(z.unknown()),classification:classificationSchema}).strict(),assessments:z.array(z.unknown())}).strict();
export interface ReleaseExceptionItem {
  itemId:string;evidenceSha256:string;origin:string;classification:'negative'|'known_gap'|'privacy_excluded'|'superseded_assessment'|'execution_history'|'rights'|'critical'|'legal'|'disagreement'|'unknown'|'withheld_in_candidate';
  riskClassification:ReleaseExceptionItem['classification'];ownerAuditPriority:'high'|'normal';
  blocking:boolean;recordIds:string[];evidence:unknown;independentlyValidated:false;
  candidateAffected?:boolean|null;sourceContributes?:boolean|null;sourceLevel?:boolean;
}
export async function readAcceptancePin(pinInput:unknown){
  const pin=AcceptancePinSchema.parse(pinInput),stat=await lstat(pin.path);
  if(!stat.isFile()||stat.size>512*1024*1024)throw Error('Acceptance input must be a bounded regular file');
  const bytes=await readFile(pin.path);if(hash(bytes)!==pin.sha256)throw Error('Acceptance input hash mismatch');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
function record(value:unknown):Record<string,unknown>{return z.record(z.string(),z.unknown()).parse(value);}
function identifiers(value:unknown):string[]{
  const ids=new Set<string>();
  const visit=(node:unknown):void=>{
    if(Array.isArray(node)){node.forEach(visit);return;}
    if(!node||typeof node!=='object')return;
    for(const [key,child] of Object.entries(node)){
      if(['recordId','claimId','id'].includes(key)&&typeof child==='string')ids.add(child);
      else if(key==='recordIds'&&Array.isArray(child)){for(const id of child)if(typeof id==='string')ids.add(id);}
      else if(key==='candidate'||key==='record'||key==='records'||key==='exception')visit(child);
    }
  };visit(value);return [...ids].sort();
}
/** Only explicit known non-admissions are nonblocking. Unknown classes are never cleared by an operator label. */
export function classifyReleaseException(value:unknown):ReleaseExceptionItem['classification']{
  const normalized:unknown[]=[];const reasons:string[]=[];let knownGap=false,unknownReasonCode=false;
  const visit=(node:unknown):void=>{
    if(Array.isArray(node)){node.forEach(visit);return;}
    if(!node||typeof node!=='object')return;
    const entry=z.record(z.string(),z.unknown()).parse(node);
    if(['held_quality','held_execution','failed_execution','blocked_access'].includes(String(entry.outcome))&&ReasonCodeSchema.safeParse(entry.reasonCode).success)knownGap=true;
    if(['partial','not_checked','held_quality','held_execution','failed_execution','blocked_access'].includes(String(entry.state)))knownGap=true;
    for(const [key,child] of Object.entries(node)){
      if(['reason','reasonCode','holdReasons','criticalKinds'].includes(key)){
        const strings=Array.isArray(child)?child.filter((entry):entry is string=>typeof entry==='string'):typeof child==='string'?[child]:[];
        reasons.push(...strings);normalized.push({[key==='reasonCode'?'reason':key]:child});
        if(key==='reasonCode'&&!ReasonCodeSchema.safeParse(child).success)unknownReasonCode=true;
        if(key==='reasonCode'&&ReasonCodeSchema.safeParse(child).success&&!['completed','no_supported_case'].includes(String(child)))knownGap=true;
        if(key==='reason'&&typeof child==='string'){
          const code=child.replace(/^(?:terminal_(?:document|assessment)_exception|assessment_item_hold):/,'');
          if(ReasonCodeSchema.safeParse(code).success&&!['completed','no_supported_case'].includes(code))knownGap=true;
          if((child.startsWith('terminal_')||child.startsWith('assessment_item_hold:'))&&!ReasonCodeSchema.safeParse(code).success)unknownReasonCode=true;
          if(['narrative_requires_text_model','source_literal_exceeds_short_quote'].includes(child))knownGap=true;
        }
      }else visit(child);
    }
  };visit(value);
  const flags=classifyStep8Exception(normalized),text=reasons.join(' ').toLowerCase();
  if(unknownReasonCode)return 'unknown';
  if(flags.rights)return 'rights';
  if(flags.critical)return 'critical';
  if(/legal|copyright|permission|privacy|contact|origin_unresolved/.test(text)&&!reasons.every(reason=>reason==='contact_field'))return 'legal';
  if(flags.disagreement)return 'disagreement';
  if(reasons.length&&reasons.every(reason=>reason==='no_supported_case'))return 'negative';
  if(reasons.length&&reasons.every(reason=>reason==='contact_field'))return 'privacy_excluded';
  if(knownGap)return 'known_gap';
  return 'unknown';
}
export function inventoryExceptionItems(input:unknown):ReleaseExceptionItem[]{
  const inventory=Step8ExceptionInventorySchema.parse(input),items:ReleaseExceptionItem[]=[];
  const append=(origin:string,evidence:unknown,force?:ReleaseExceptionItem['classification'])=>{
    const classification=force??classifyReleaseException(evidence),content={origin,classification,evidence};
    items.push({itemId:'step8:'+semanticHash(content),evidenceSha256:semanticHash(content),origin,classification,riskClassification:classification,
      ownerAuditPriority:['rights','critical','legal','disagreement','unknown'].includes(classification)?'high':'normal',
      blocking:!['negative','known_gap','privacy_excluded','superseded_assessment','execution_history'].includes(classification),recordIds:identifiers(evidence),evidence,independentlyValidated:false});
  };
  if(!inventory.complete)append('complete',{reason:'exception_inventory_incomplete'},'unknown');
  for(const [index,source] of inventory.sourceDispositions.entries()){
    if('importDisposition' in source){
      append(`sourceDispositions/${index}/importDisposition`,source.importDisposition,source.importDisposition.reasonCode==='source_policy_stale'?'rights':'known_gap');
      continue;
    }
    const terminalSchema=z.object({recordIds:z.array(z.string()).min(1),reasonCode:ReasonCodeSchema}).passthrough();
    const selectedSchema=z.object({recordId:z.string(),pins:z.object({itemArtifactSha256:HashSchema,AArtifactSha256:HashSchema,BArtifactSha256:HashSchema,CArtifactSha256:HashSchema,finalArtifactSha256:HashSchema}).passthrough()}).passthrough();
    const selected=source.assessments.flatMap(raw=>{const parsed=selectedSchema.safeParse(raw);return parsed.success?[parsed.data]:[];});
    const queue=z.record(z.string(),z.unknown()).safeParse(source.queueEvidence);
    const currentSchema=z.array(z.object({receipt:z.object({jobKey:HashSchema,step:z.string(),outcome:JobOutcomeSchema,reasonCode:ReasonCodeSchema}).passthrough()}).passthrough());
    const receipts=currentSchema.safeParse(queue.success?queue.data.stepReceipts:undefined);
    const current=receipts.success?receipts.data.filter(entry=>entry.receipt.jobKey===source.jobKey&&['residual_prepare','residual_extract'].includes(entry.receipt.step)):[];
    const terminals=(source.terminalAssessmentExceptions??[]).map(item=>{
      const parsed=terminalSchema.safeParse(item),kind=classifyReleaseException(item);
      const superseded=parsed.success&&['known_gap','critical','disagreement'].includes(kind)&&parsed.data.recordIds.every(id=>source.admittedRecordIds.includes(id)&&selected.some(pin=>pin.recordId===id));
      return {item,superseded,reasonCode:parsed.success?parsed.data.reasonCode:null};
    });
    for(const [caseIndex,item] of source.cases.entries()){
      const parsed=z.object({reason:z.string()}).passthrough().safeParse(item);
      const superseded=parsed.success&&terminals.some(entry=>entry.superseded&&parsed.data.reason==='terminal_assessment_exception:'+entry.reasonCode);
      const evidence=superseded?{exception:item,selectedAdmission:selected}:current.length===1&&!['succeeded','no_supported_case'].includes(current[0].receipt.outcome)?{exception:item,currentExtractionReceipt:current[0]}:item;
      append(`sourceDispositions/${index}/cases/${caseIndex}`,evidence,superseded?'superseded_assessment':classifyReleaseException(item)==='unknown'?'unknown':undefined);
    }
    if(source.terminalDocumentException)append(`sourceDispositions/${index}/terminalDocumentException`,source.terminalDocumentException);
    for(const [terminalIndex,entry] of terminals.entries())append(`sourceDispositions/${index}/terminalAssessmentExceptions/${terminalIndex}`,
      entry.superseded?{exception:entry.item,selectedAdmission:selected}:entry.item,entry.superseded?'superseded_assessment':undefined);
    for(const [holdIndex,entry] of (source.assessmentItemHolds??[]).entries())append(`sourceDispositions/${index}/assessmentItemHolds/${holdIndex}`,entry);
    if(queue.success&&queue.data.extractionAttemptHistory!==undefined)append(`sourceDispositions/${index}/queueEvidence/extractionAttemptHistory`,queue.data.extractionAttemptHistory,'execution_history');
    if(current.length!==1)append(`sourceDispositions/${index}/currentExtractionReceipt`,{reason:'current_extraction_receipt_missing_or_ambiguous'},'unknown');
    else if(!['succeeded','no_supported_case'].includes(current[0].receipt.outcome))append(`sourceDispositions/${index}/currentExtractionReceipt`,current[0]);
    const flags=classifyStep8Exception(source.cases);
    if(flags.critical!==source.classification.critical||flags.rights!==source.classification.rights||flags.disagreement!==source.classification.disagreement)
      append(`sourceDispositions/${index}/classification`,source,'unknown');
    if(!source.admittedRecordIds.length&&!source.cases.length)append(`sourceDispositions/${index}/missingDisposition`,source,'unknown');
  }
  for(const [index,item] of inventory.preparation.publicationQuarantine.records.entries())append(`preparation/publicationQuarantine/records/${index}`,item);
  for(const [index,item] of inventory.preparation.criticalHolds.entries())append(`preparation/criticalHolds/${index}`,item,'critical');
  for(const [index,raw] of inventory.native.coverage.entries()){
    const coverage=record(raw),state=record(coverage.coverage).state;
    if(!['complete','empty','not_applicable'].includes(String(state)))append(`native/coverage/${index}`,raw);
  }
  const fields=inventory.native.fieldHolds,counts=record(fields.counts);
  const total=z.number().int().nonnegative().parse(fields.unpublishedObservations);
  let known=0;
  for(const [reason,countInput] of Object.entries(counts)){
    const count=z.number().int().nonnegative().parse(countInput);known+=count;
    if(count)append('native/fieldHolds/'+reason,{reason,count});
  }
  if(total!==known)append('native/fieldHolds/otherUnpublishedObservations',{reason:'unknown_native_unpublished',total,known},'unknown');
  const expected=classifyStep8Exception(inventory.preparation.publicationQuarantine),given=inventory.preparation.classification;
  if(expected.critical!==given.critical||expected.rights!==given.rights||expected.disagreement!==given.disagreement)append('preparation/classification',given,'unknown');
  return items;
}
const assessmentRoles=['item','A','B','C'] as const;
export const AuditAssessmentManifestSchema=z.array(z.object({item:z.string().min(1),A:z.string().min(1),B:z.string().min(1),C:z.string().min(1),exceptionMinutes:z.number().finite().positive().optional()}).strict());
export type AssessmentContentHashes=Record<typeof assessmentRoles[number],string>;
export interface RequiredStep8Assessment {recordId:string;artifactSha256:AssessmentContentHashes;contentSha256:AssessmentContentHashes}
async function readHandoffAssessments(pin:z.infer<typeof AcceptancePinSchema>,inventory:z.infer<typeof Step8ExceptionInventorySchema>):Promise<RequiredStep8Assessment[]>{
  const manifest=AuditAssessmentManifestSchema.parse(await readAcceptancePin(pin));
  const rows=z.array(z.object({recordId:z.string().min(1),item:z.string(),A:z.string(),B:z.string(),C:z.string()}).strict()).parse(inventory.assessments);
  if(manifest.length!==rows.length)throw Error('Step8 assessment handoff omits or adds inventory triplets');
  const selectionSchema=z.object({recordId:z.string().min(1),pins:z.object({itemArtifactSha256:HashSchema,AArtifactSha256:HashSchema,
    BArtifactSha256:HashSchema,CArtifactSha256:HashSchema,finalArtifactSha256:HashSchema}).passthrough().nullable()}).passthrough();
  const selected=new Map<string,AssessmentContentHashes>();
  for(const source of inventory.sourceDispositions)for(const raw of source.assessments){
    const row=selectionSchema.parse(raw);if(!row.pins)continue;
    const hashes={item:row.pins.itemArtifactSha256,A:row.pins.AArtifactSha256,B:row.pins.BArtifactSha256,C:row.pins.CArtifactSha256};
    const prior=selected.get(row.recordId);
    if(prior&&canonicalJson(prior)!==canonicalJson(hashes))throw Error('Conflicting selected Step8 assessment triplets');
    selected.set(row.recordId,hashes);
  }
  const seen=new Set<string>(),required:RequiredStep8Assessment[]=[];
  for(const [index,row] of rows.entries()){
    const artifactSha256=selected.get(row.recordId);if(!artifactSha256)throw Error('Step8 handoff triplet lacks selected assessment pins');
    const contentSha256={} as AssessmentContentHashes;
    for(const role of assessmentRoles){
      if(row[role].split('/').at(-1)!==artifactSha256[role])throw Error('Step8 assessment inventory disagrees with selected artifact pins');
      const artifact=await readAcceptancePin({path:manifest[index][role],sha256:artifactSha256[role]});
      contentSha256[role]=semanticHash(artifact);
      if(role==='item'){
        const item=record(artifact),target=item.criticalTarget&&typeof item.criticalTarget==='object'?record(item.criticalTarget):{};
        if(item.itemId!==row.recordId&&target.recordId!==row.recordId)throw Error('Step8 handoff item belongs to another selected record');
      }
    }
    if(!seen.has(row.recordId)){required.push({recordId:row.recordId,artifactSha256,contentSha256});seen.add(row.recordId);}
  }
  if(seen.size!==selected.size)throw Error('Step8 assessment inventory omits selected triplets');
  return required.sort((a,b)=>a.recordId.localeCompare(b.recordId));
}
export interface Step8AssessmentCoverage {
  assessmentManifest:z.infer<typeof AcceptancePinSchema>;required:number;included:number;bindingsSha256:string;pass:boolean;
}
export function requireStep8AssessmentCoverage(bundle:Step8ExceptionBundle,included:AssessmentContentHashes[]):Step8AssessmentCoverage{
  const present=new Set(included.map(semanticHash));
  for(const required of bundle.requiredAssessments)if(!present.has(semanticHash(required.contentSha256)))throw Error('Step8 handed-off assessment triplet missing from owner packet: '+required.recordId);
  return {assessmentManifest:bundle.assessmentManifest,required:bundle.requiredAssessments.length,included:bundle.requiredAssessments.length,
    bindingsSha256:semanticHash(bundle.requiredAssessments),pass:true};
}
export interface Step8ExceptionBundle {
  version:'r1-step8-exception-bundle-v1';releaseId:string;manifestSha256:string;pins:Step8AcceptancePins;
  inventory:z.infer<typeof Step8ExceptionInventorySchema>;candidateContext:CandidateMaterialContext;items:ReleaseExceptionItem[];
  assessmentManifest:z.infer<typeof AcceptancePinSchema>;requiredAssessments:RequiredStep8Assessment[];
}
export async function loadStep8ExceptionBundle(pinsInput:unknown,expectedReleaseId?:string){
  const pins=Step8AcceptancePinsSchema.parse(pinsInput),gate=gateSchema.parse(await readAcceptancePin(pins.gate));
  const handoff=handoffSchema.parse(await readAcceptancePin(pins.handoff)),inventory=Step8ExceptionInventorySchema.parse(await readAcceptancePin(pins.exceptions));
  if(expectedReleaseId&&gate.releaseId!==expectedReleaseId)throw Error('Step8 bundle binds another release');
  if(gate.releaseId!==handoff.releaseId||gate.releaseId!==inventory.releaseId||gate.candidateDirectory!==handoff.candidateDirectory
    ||canonicalJson(gate.exceptionInventory)!==canonicalJson(pins.exceptions)||canonicalJson(handoff.exceptionInventory)!==canonicalJson(pins.exceptions)
    ||canonicalJson(gate.step9Handoff)!==canonicalJson(pins.handoff)||canonicalJson(gate.campaign)!==canonicalJson(inventory.campaign))throw Error('Step8 gate/inventory/handoff binding mismatch');
  const campaign=Step8CampaignSchema.parse(await readAcceptancePin(gate.campaign));
  const expected=campaign.sources.flatMap(source=>source.documents.map(document=>canonicalJson([source.municipalityId,source.sourceId,document.documentId,document.sha256,
    'jobKey' in document?document.jobKey:['import_rejection',document.importDisposition.decisionSha256,document.importDisposition.reasonCode]]))).sort();
  const actual=inventory.sourceDispositions.map(source=>canonicalJson([source.municipalityId,source.sourceId,source.documentId,source.sourceSha256,
    'jobKey' in source?source.jobKey:['import_rejection',source.importDisposition.decision.sha256,source.importDisposition.reasonCode]])).sort();
  if(canonicalJson(expected)!==canonicalJson(actual))throw Error('Exception inventory omits or duplicates campaign documents');
  const generationAudit=z.object({schemaVersion:z.literal('stadtstack-r1-step8-read-only-audit-v1'),status:z.literal('compatible'),
    currentGeneration:Step8CurrentGenerationSchema,campaign:AcceptancePinSchema,blockers:z.array(z.unknown()).length(0),
    writes:z.array(z.unknown()).length(0),network:z.literal(false),providers:z.literal(false),publicationExecuted:z.literal(false),
    sources:z.array(z.object({municipalityId:z.string(),sourceId:z.string(),corpusSha256:HashSchema,admittedRecordIds:z.array(z.string())}).passthrough()),
    allowance:z.object({schemaVersion:z.literal('stadtstack-r1-step8-allowance-evidence-v1')}).passthrough(),purgeAcknowledgements:z.array(z.unknown())}).passthrough().parse(await readAcceptancePin(gate.generationAuditEvidence));
  if(canonicalJson(generationAudit.currentGeneration)!==canonicalJson(gate.currentGeneration)||canonicalJson(generationAudit.campaign)!==canonicalJson(gate.campaign)
    ||!inventory.generationAuditEvidence||canonicalJson(inventory.generationAuditEvidence)!==canonicalJson(gate.generationAuditEvidence))throw Error('Current generation audit binding mismatch');
  const expectedSources=campaign.sources.map(source=>canonicalJson([source.municipalityId,source.sourceId,source.corpus.sha256])).sort();
  if(canonicalJson(expectedSources)!==canonicalJson(generationAudit.sources.map(source=>canonicalJson([source.municipalityId,source.sourceId,source.corpusSha256])).sort()))throw Error('Current generation audit source coverage mismatch');
  for(const source of generationAudit.sources){
    const admitted=[...new Set(inventory.sourceDispositions.filter(entry=>entry.municipalityId===source.municipalityId&&entry.sourceId===source.sourceId).flatMap(entry=>entry.admittedRecordIds))].sort();
    if(canonicalJson(admitted)!==canonicalJson([...source.admittedRecordIds].sort()))throw Error('Current generation audit admission mismatch');
    const imports=inventory.sourceDispositions.filter(entry=>entry.municipalityId===source.municipalityId&&entry.sourceId===source.sourceId).flatMap(entry=>'importDisposition' in entry?[entry.importDisposition]:[]);
    const audited=z.object({importDispositions:z.array(ImportRejectionDispositionSchema).default([])}).passthrough().parse(source);
    if(canonicalJson(imports)!==canonicalJson(audited.importDispositions))throw Error('Current generation audit import disposition mismatch');
  }
  if(inventory.sourceDispositionInventory){
    const sourceInventory=record(await readAcceptancePin(inventory.sourceDispositionInventory));
    if(sourceInventory.schemaVersion!=='stadtstack-r1-step8-source-dispositions-v1'||sourceInventory.complete!==true||sourceInventory.generationNonce!==gate.generationNonce
      ||canonicalJson(sourceInventory.sourceDispositions)!==canonicalJson(inventory.sourceDispositions)||canonicalJson(sourceInventory.campaign)!==canonicalJson(gate.campaign))throw Error('Terminal source disposition inventory binding mismatch');
  }
  const requiredAssessments=await readHandoffAssessments(handoff.assessmentManifest,inventory);
  const manifest=dataReleaseSchema.parse(await readAcceptancePin({path:join(gate.candidateDirectory,'release-manifest.json'),sha256:gate.manifestSha256}));
  const verified=await verifyDataRelease(gate.candidateDirectory);
  if(manifest.id!==gate.releaseId||verified.id!==gate.releaseId)throw Error('Candidate manifest differs from release gate');
  const candidateContext=await readCandidateMaterialContext(gate.candidateDirectory,manifest,gate.manifestSha256);
  const items=bindReleaseExceptionContext(inventoryExceptionItems(inventory),candidateContext,inventory.sourceDispositions);
  const bundle:Step8ExceptionBundle={version:'r1-step8-exception-bundle-v1',releaseId:gate.releaseId,manifestSha256:gate.manifestSha256,pins,inventory,candidateContext,items,
    assessmentManifest:handoff.assessmentManifest,requiredAssessments};
  return {bundle,gate,handoff,manifest};
}
const scoreGate=z.object({actual:z.number().int().nonnegative().max(60),pass:z.boolean()}).passthrough();
const pairScore=z.number().int().min(0).max(2);
const valueVerdictSchema=z.object({version:z.literal('pilot-value-r1-verdict-v1'),releaseId:HashSchema,reportSha256:HashSchema,packetSha256:HashSchema,
  step8:Step8AcceptancePinsSchema,manifestSha256:HashSchema,
  step8AssessmentCoverage:z.object({assessmentManifest:AcceptancePinSchema,required:z.number().int().nonnegative(),included:z.number().int().nonnegative(),bindingsSha256:HashSchema,pass:z.boolean()}).strict(),
  frozenInputs:z.object({questionBankSha256:z.literal('2e74ab25477c83ed58a34e1a57ae76c16ed7f524fe7e6865106bfcc32bad18cc'),
    rebuildPlanSha256:z.literal('cec8d20a8f443db49744e1b8ce51be6283184526e0895aa0010abcf8b0c2bdf2'),
    statusCheckpointSha256:z.literal('643fe639b7c87cc285a2a84960aef34f7f2c36fac1606f93296c438feaa3969a'),optionBApprovalSha256:z.literal(OPTION_B_APPROVAL_SHA256)}).strict(),
  verdict:z.enum(['pass','fail']),blockingReasons:z.array(z.string()),pending_owner_audit:z.boolean(),ownerAuditPolicy:z.literal('option_B_post_release_sample_only'),
  gates:z.object({questions:scoreGate.extend({denominator:z.literal(30),reviewed:z.number().int().nonnegative().max(30)}),
    usefulness:scoreGate.extend({denominator:z.literal(60),minimum:z.literal(30),lane:z.literal('withoutGraph')}),
    completeAnswers:scoreGate.extend({minimum:z.literal(8)}),correctness:scoreGate.extend({denominator:z.literal(60),required:z.literal(60)}),
    sources:scoreGate.extend({denominator:z.literal(60),minimum:z.literal(46)}),
    graphPairs:scoreGate.extend({required:z.literal(7),minimumGain:z.literal(2),gain:z.number().int(),correctnessLosses:z.number().int(),pairs:z.array(z.object({id:z.string(),reviewed:z.boolean(),
      usefulnessWithout:pairScore,usefulnessWith:pairScore.nullable(),gain:z.number().int().nullable(),correctnessWithout:pairScore,correctnessWith:pairScore.nullable()}).strict())}),
    unresolvedCriticalAndRights:scoreGate.extend({required:z.literal(0)}),ownerWorkload:z.object({plannedMinutes:z.number().nonnegative(),maximumMinutes:z.literal(120),pass:z.boolean()}).passthrough(),
    ownerFindings:z.object({blockingFindings:z.array(z.string()),pass:z.boolean()}).passthrough()}).strict()}).passthrough();
export const ReleaseAcceptanceInputSchema=z.object({step8:Step8AcceptancePinsSchema,valueVerdict:AcceptancePinSchema,ownerApproval:AcceptancePinSchema}).strict();
export async function computeReleaseAcceptance(input:unknown){
  const selected=ReleaseAcceptanceInputSchema.parse(input),{bundle,gate,manifest}=await loadStep8ExceptionBundle(selected.step8);
  const blockers:string[]=[...bundle.candidateContext.materialBlockers];
  if(gate.status!=='passed')blockers.push('technical_gate_not_passed');
  if(!bundle.inventory.complete)blockers.push('exception_inventory_incomplete');
  const requiredChecks=['current assessment generation','allowance accounting','native B purge acknowledgments','exact campaign membership','complete exception inventory','atomic generation ownership','native contributor custody','authenticated source exports','quality','coverage','critical assessments','identity admissions','current policy','every manifest member','exact manifest bytes and ID','vm_candidate loader'];
  if(requiredChecks.some(check=>!gate.checks.includes(check)))blockers.push('technical_gate_checks_incomplete');
  if(selected.ownerApproval.sha256!==OPTION_B_APPROVAL_SHA256)blockers.push('owner_option_B_approval_not_pinned');
  await readAcceptancePin(selected.ownerApproval);
  const receipt=record(await readAcceptancePin(gate.replayReceipt));
  const expectedRelease=AcceptancePinSchema.parse(receipt.expectedRelease);
  if(expectedRelease.sha256!==gate.manifestSha256)blockers.push('replay_expected_manifest_mismatch');
  const casRoot=z.string().refine(isAbsolute).parse(receipt.casRoot);
  const auditPin={path:join(casRoot,'sha256',gate.replayAuditSha256.slice(0,2),gate.replayAuditSha256),sha256:gate.replayAuditSha256};
  const audit=record(await readAcceptancePin(auditPin)),comparison=record(audit.comparison);
  if(audit.schemaVersion!=='district-replay-proof-audit-v1'||audit.receiptSha256!==gate.replayReceipt.sha256||comparison.releaseId!==gate.releaseId
    ||comparison.manifestSha256!==gate.manifestSha256||canonicalJson(comparison.files)!==canonicalJson(manifest.files))blockers.push('exact_replay_binding_failed');
  const artifactSchema=z.object({path:z.string(),sha256:HashSchema,storageKey:z.string()}).passthrough();
  const proofArtifacts=z.array(artifactSchema).parse(audit.artifacts).filter(artifact=>artifact.path==='proof.json');
  if(proofArtifacts.length!==1)throw Error('Exact replay proof artifact is absent or ambiguous');
  const artifact=proofArtifacts[0];
  if(artifact.storageKey!==`sha256/${artifact.sha256.slice(0,2)}/${artifact.sha256}`)throw Error('Replay proof storage binding changed');
  const proof=record(await readAcceptancePin({path:join(casRoot,artifact.storageKey),sha256:artifact.sha256}));
  const execution=record(proof.execution);
  if(proof.schemaVersion!=='stadtstack-offline-replay-proof-v2'||execution.modelCalls!==0||execution.readinessCalls!==0||execution.liveFallback!=='forbidden'
    ||canonicalJson(proof.comparison)!==canonicalJson(audit.comparison))blockers.push('exact_replay_not_passed');
  const value=valueVerdictSchema.parse(await readAcceptancePin(selected.valueVerdict));
  const pairs=value.gates.graphPairs.pairs,ids=['W03','W04','E03','B03','K03','M03','H03'];
  if(value.releaseId!==gate.releaseId)blockers.push('value_verdict_release_mismatch');
  if(canonicalJson(value.step8)!==canonicalJson(selected.step8)||value.manifestSha256!==gate.manifestSha256)blockers.push('value_verdict_step8_binding_mismatch');
  const assessmentCoverage=requireStep8AssessmentCoverage(bundle,bundle.requiredAssessments.map(required=>required.contentSha256));
  if(canonicalJson(value.step8AssessmentCoverage)!==canonicalJson(assessmentCoverage))blockers.push('value_verdict_step8_assessment_coverage_mismatch');
  if(value.verdict!=='pass'||value.blockingReasons.length||Object.values(value.gates).some(result=>!result.pass)
    ||value.gates.questions.actual!==30||value.gates.questions.reviewed!==30||value.gates.usefulness.actual<30||value.gates.completeAnswers.actual<8||value.gates.correctness.actual!==60||value.gates.sources.actual<46
    ||value.gates.unresolvedCriticalAndRights.actual!==0||value.gates.ownerFindings.blockingFindings.length||value.gates.ownerWorkload.plannedMinutes>120
    ||value.gates.graphPairs.actual!==7||value.gates.graphPairs.gain<2||value.gates.graphPairs.correctnessLosses!==0
    ||pairs.length!==7||ids.some(id=>pairs.filter(pair=>pair.id===id).length!==1)||pairs.some(pair=>!pair.reviewed||pair.correctnessWith===null||pair.correctnessWith<pair.correctnessWithout
      ||pair.usefulnessWith===null||pair.gain!==pair.usefulnessWith-pair.usefulnessWithout)
    ||pairs.reduce((sum,pair)=>sum+(pair.gain??0),0)!==value.gates.graphPairs.gain)blockers.push('frozen_value_gate_not_passed');
  for(const item of bundle.items)if(item.blocking)blockers.push('exception:'+item.classification+':'+item.itemId);
  return {schemaVersion:'stadtstack-r1-release-acceptance-v1',releaseId:gate.releaseId,manifestSha256:gate.manifestSha256,
    accepted:blockers.length===0,blockers:[...new Set(blockers)].sort(),inputs:selected,replayAudit:auditPin,
    valueReportSha256:value.reportSha256,valuePacketSha256:value.packetSha256,
    step8AssessmentCoverage:assessmentCoverage,
    exceptionRuleSet:RELEASE_ACCEPTANCE_RULES,
    exceptionItems:bundle.items.map(({evidence,...item})=>item),
    ownerPolicy:'option_B_all_gates_before_release_sample_audit_afterwards',pending_owner_audit:blockers.length===0&&value.pending_owner_audit,
    ownerReviewed:false,independentlyValidated:false};
}
export async function runReleaseAcceptance(options:Map<string,string>){
  const input=options.get('input'),output=options.get('output');if(!input||!output)throw Error('release-acceptance requires --input and --output');
  const result=await computeReleaseAcceptance(JSON.parse(await readFile(input,'utf8')));
  await writeImmutable(output,result);console.log(JSON.stringify(result));if(!result.accepted)process.exitCode=1;
}
export async function r1ReleaseAcceptanceMain(args:string[]=process.argv.slice(2)){
  if(args[0]==='--help'||args[0]==='help'){console.log('Usage: r1-release-acceptance.ts --input FILE --output FILE');return;}
  const options=new Map<string,string>();
  for(let index=0;index<args.length;index+=2){
    if(!args[index]?.startsWith('--')||!args[index+1]||args[index+1].startsWith('--'))throw Error('Expected named option and value');
    options.set(args[index].slice(2),args[index+1]);
  }
  await runReleaseAcceptance(options);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))r1ReleaseAcceptanceMain().catch(()=>{
  console.error('Release acceptance failed; inspect pinned inputs and immutable output paths. No deployment was performed.');process.exitCode=1;
});
