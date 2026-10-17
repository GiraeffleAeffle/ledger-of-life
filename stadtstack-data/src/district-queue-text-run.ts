import {join} from 'node:path';
import type {Pool} from 'pg';
import {z} from 'zod';
import {HashSchema,canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {DistrictJobStore,canonicalJobIdentity,type DistrictJobSpec} from './district-jobs.ts';
import {encodeStepReceipt,type StepReceipt} from './district-step-receipt.ts';
import type {DistrictCas} from './district-cas.ts';
import {loadCommittedResidualOutputs,loadResidualSource,ResidualInputSchema,residualJobContract,exportResidualTextContribution} from './district-residual-jobs.ts';
import {PreparedDocumentSchema,verifyPreparedDocument} from './district-prepared-document.ts';
import {assessmentItemSchema,validateReceipt,verifyPinnedAssessment} from './district-assessment.ts';
import {reconstructResidualAssessmentItem} from './district-assessment-jobs.ts';
import {AssessmentItemHoldPinSchema,loadAssessmentItemHold} from './district-assessment-item-holds.ts';
import {CriticalAssessmentInventorySchema,CriticalAdmissionsSchema,CRITICAL_ADMISSIONS_VERSION,type CriticalAssessmentInventory} from './district-critical-assessment-contract.ts';
import {admitCriticalKnowledge} from './district-critical-assessment.ts';
import {criticalKnowledgeTarget} from './district-critical-assessment-public.ts';
import {KnowledgeRecordsSchema,type DistrictKnowledgeRecord} from './district-schema.ts';
import {authenticateTextRunContribution,type TextRunContribution} from './text-run-lineage.ts';
import {r1TextCompositionInputSchema} from './district-r1-text-composition.ts';
import {authenticateScopedGeneration,verifyCachedGeneration,verifyReplayAnswer,type ReplayAnswer} from './replay-pipeline.ts';
import {publicationPolicyReceiptInventorySchema} from './district-publication-policy.ts';
import {crawlSummarySchema} from './district-publication.ts';
import {privatePublicationProvenanceSchema} from './district-publication-provenance.ts';
import {readOperatorRegistryInputPin,readCrawlOperatorRegistryInputPin} from './district-registry-config.ts';
import {corpusFixturePolicy,type CrawlDocument} from './district-corpus.ts';
import {assertManagedSourceReadable,assertManagedSourceBindings,initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID} from './civic-opt-out.ts';
import type {SourceArtifactBinding} from './district-private-io.ts';
import {ModelEvidenceSchema,type ModelEvidence} from './district-model-contract.ts';
import {preparationPlanSchema,preparedExpectationSchema} from './district-preparation-run.ts';
import {districtRegistrySchema} from './district-registry.ts';
import {residualOriginalIdentity,readPolicyRefreshCommit,recordedPolicyIdentity} from './district-policy-refresh.ts';
import {loadPolicyReceipt} from './district-policy-receipt.ts';
import {CrawlCorpusImportSchema} from './district-crawl-import.ts';
import {TerminalDocumentExceptionSchema,TerminalAssessmentExceptionSchema,loadTerminalException,assertTerminalSourceScope} from './district-terminal-exceptions.ts';
import type {QuarantineCase} from './district-inference.ts';

export const QueueTextSealInputSchema=z.object({jobKeys:z.array(HashSchema).max(10000),reconciliationJobKeys:z.array(HashSchema).max(10000),attemptHistory:z.literal('committed-v1').optional(),terminalDocumentExceptions:z.array(TerminalDocumentExceptionSchema).max(10000).default([]),terminalAssessmentExceptions:z.array(TerminalAssessmentExceptionSchema).max(10000).default([]),assessmentItemHolds:z.array(AssessmentItemHoldPinSchema).max(10000).default([])}).strict().superRefine((value,ctx)=>{
 for(const keys of [value.jobKeys,value.reconciliationJobKeys,value.terminalDocumentExceptions.map(pin=>pin.jobKey),value.terminalAssessmentExceptions.map(pin=>pin.jobKey)])if(new Set(keys).size!==keys.length)ctx.addIssue({code:'custom',message:'Queue seal requires distinct committed jobs'});
 if(new Set(value.assessmentItemHolds.map(pin=>pin.holdReceiptArtifactSha256)).size!==value.assessmentItemHolds.length)ctx.addIssue({code:'custom',message:'Queue seal requires distinct item hold receipts'});
 if(!value.jobKeys.length&&!value.terminalDocumentExceptions.length)ctx.addIssue({code:'custom',message:'Queue seal requires an extraction or terminal document exception'});
 if(new Set(value.terminalDocumentExceptions.map(pin=>pin.documentId)).size!==value.terminalDocumentExceptions.length)ctx.addIssue({code:'custom',message:'Duplicate terminal document exception'});
 if(value.terminalDocumentExceptions.some(pin=>value.jobKeys.includes(pin.jobKey)))ctx.addIssue({code:'custom',message:'Terminal exception overlaps an admitted job selection'});
});
interface CommittedStep {spec:DistrictJobSpec;receipt:StepReceipt;sha256:string}
const pinSchema=z.object({jobKey:HashSchema,receiptId:z.uuid(),receiptSha256:HashSchema}).strict();
const reconciliationSelectorSchema=z.object({itemArtifactSha256:HashSchema,recordArtifactSha256:HashSchema,AJobKey:HashSchema,BJobKey:HashSchema,CJobKey:HashSchema.optional(),predecessors:z.array(pinSchema)}).passthrough();
const pathFor=(cas:DistrictCas,hash:string)=>join(cas.root,'sha256',hash.slice(0,2),hash);
const artifact=(value:unknown)=>{const bytes=Buffer.from(canonicalJson(value));return {bytes,sha256:digest(bytes)};};

/** No new clock, run UUID, work-plan assignment or model call is created here.
 * Original queue receipts are the execution authority; v2 is the native output
 * envelope. Recomputing this closure is also the export authentication gate. */
export async function buildQueueTextRun(pool:Pool,cas:DistrictCas,raw:unknown,serialization:{extractionAttemptHistory?:boolean}={}){
 const input=QueueTextSealInputSchema.parse(raw),store=new DistrictJobStore(pool),includeAttemptHistory=serialization.extractionAttemptHistory===true||input.attemptHistory!==undefined||input.terminalDocumentExceptions.length>0||input.terminalAssessmentExceptions.length>0||input.assessmentItemHolds.length>0;
 const committed:Awaited<ReturnType<typeof loadCommittedResidualOutputs>>=input.jobKeys.length?await loadCommittedResidualOutputs(pool,cas,input.jobKeys):{receipts:[],results:[],sources:[],selectors:[]};
 const terminalDocuments=await Promise.all([...input.terminalDocumentExceptions].sort((a,b)=>a.jobKey.localeCompare(b.jobKey)).map(async pin=>{
  const entry=await loadTerminalException(pool,pin),selector=ResidualInputSchema.passthrough().parse(entry.spec.selector);
  if(selector.documentId!==pin.documentId||entry.spec.semanticContractSha256!==semanticHash(selector.contract))throw Error('Terminal exception document or semantic contract mismatch');
  const source=await loadResidualSource(cas,ResidualInputSchema.strip().parse(selector),{store});assertTerminalSourceScope(entry.spec,source.receipt.scope,selector.policyReceiptSha256);
  if([source.document.sha256,selector.corpusSha256,selector.registrySha256,selector.policyReceiptSha256,selector.httpObservation.receiptSha256,selector.requestEvidenceSha256].some(hash=>!entry.spec.inputArtifactHashes.includes(hash)))throw Error('Terminal exception omits original custody inputs');
  if(pin.step==='residual_extract'&&entry.receipt.outputHashes.length)throw Error('Output-bearing extraction must use its native contribution, not a terminal exception');
  return {pin,entry,selector,source};
 }));
 const fallback=terminalDocuments[0],fallbackContract=fallback?await residualJobContract():undefined;
 const first=committed.selectors[0]??{...fallback!.selector,contract:{...fallbackContract!,preparationSha256:z.object({preparationSha256:HashSchema}).passthrough().parse(fallback!.selector.contract).preparationSha256}},source=committed.sources[0]??fallback!.source,policy={...corpusFixturePolicy(),authorityId:source.receipt.authorityId,authoritySha256:source.receipt.authoritySha256};
 const originals=[...committed.sources,...terminalDocuments.map(document=>document.source)],selectors=[...committed.selectors,...terminalDocuments.map(document=>document.selector)];
 const selectedGroups=new Set(committed.sources.map(original=>canonicalJson([original.municipality.id,original.document.sha256])));
 for(const document of terminalDocuments){const key=canonicalJson([document.source.municipality.id,document.source.document.sha256]);if(selectedGroups.has(key))throw Error('Terminal exception duplicates an extracted or terminal document group');selectedGroups.add(key);
  if(document.selector.corpusSha256!==first.corpusSha256||document.selector.registrySha256!==first.registrySha256||canonicalJson(document.selector.registry)!==canonicalJson(first.registry)||canonicalJson(document.selector.crawlRegistry??null)!==canonicalJson(first.crawlRegistry??null)||z.object({preparationSha256:HashSchema}).passthrough().parse(document.selector.contract).preparationSha256!==first.contract.preparationSha256||document.source.receipt.authorityId!==source.receipt.authorityId||document.source.receipt.authoritySha256!==source.receipt.authoritySha256)throw Error('Terminal exception changes source/control generation');
  if(document.source.document.sourceId!==source.document.sourceId||document.source.municipality.id!==source.municipality.id)throw Error('Terminal exception belongs to another source scope');
 }
 const steps=new Map<string,CommittedStep>(),byId=new Map<string,CommittedStep>();
 const read=async(hash:string)=>{HashSchema.parse(hash);await assertManagedSourceReadable(pathFor(cas,hash),policy);return cas.read(hash);};
 const json=async(hash:string)=>JSON.parse((await read(hash)).toString('utf8'));
 const remember=(row:{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}):CommittedStep=>{
  const encoded=encodeStepReceipt(row.receipt),receipt=encoded.receipt;
  if(encoded.sha256!==row.receipt_sha256||canonicalJobIdentity(row.spec).jobKey!==receipt.jobKey||receipt.step!==row.spec.step||receipt.policyProofSha256!==row.spec.policyProofSha256||semanticHash([...receipt.inputHashes].sort())!==semanticHash([...row.spec.inputArtifactHashes].sort())||receipt.municipalityId!==row.spec.sourceScope.municipalityId||receipt.sourceId!==row.spec.sourceScope.sourceId)throw Error('Queue seal committed StepReceipt binding mismatch');
  const entry={spec:row.spec,receipt,sha256:encoded.sha256},prior=steps.get(receipt.jobKey);
  if(prior&&prior.sha256!==entry.sha256)throw Error('Queue seal selects conflicting attempts');
  steps.set(receipt.jobKey,entry);byId.set(receipt.id,entry);return entry;
 };
 const load=async(jobKey:string,step:string)=>{
  const prior=steps.get(jobKey);if(prior){if(prior.spec.step!==step)throw Error('Queue seal predecessor step mismatch');return prior;}
  const rows=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.job_key=$1 AND j.step=$2 ORDER BY r.attempt DESC LIMIT 1`,[HashSchema.parse(jobKey),step]);
  if(rows.rows.length!==1)throw Error('Queue seal requires a committed terminal receipt');
  return remember(rows.rows[0]);
 };
 const closeDependencies=async(entry:CommittedStep):Promise<void>=>{
  for(const id of entry.receipt.dependencyReceiptIds){
   if(byId.has(id))continue;
   const rows=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id WHERE r.id=$1`,[id]);
   if(rows.rows.length!==1)throw Error('Queue seal predecessor receipt unavailable');
   const dependency=remember(rows.rows[0]);if(dependency.receipt.outcome!=='succeeded')throw Error('Queue seal predecessor was not admitted');
   await closeDependencies(dependency);
  }
  const pins=z.object({predecessors:z.array(pinSchema).optional()}).passthrough().parse(entry.spec.selector).predecessors;
  for(const pin of pins??[]){const dependency=byId.get(pin.receiptId);if(!dependency||dependency.sha256!==pin.receiptSha256||dependency.receipt.jobKey!==pin.jobKey||!entry.receipt.dependencyReceiptIds.includes(pin.receiptId))throw Error('Queue seal dependency pin mismatch');}
 };
 const prepared=new Map<string,z.infer<typeof PreparedDocumentSchema>>(),archives=new Set<string>(),currentAdmissionReceipts:Record<string,string>={};
 const callRequirements:Array<{originalSha256:string;requestSha256:string;jobKey?:string;runId?:string}>=[];
 const extractionAttemptHistory=[];
 for(let index=0;index<committed.results.length;index++){
  const result=committed.results[index],selector=committed.selectors[index],original=committed.sources[index];
  if(selector.corpusSha256!==first.corpusSha256||selector.registrySha256!==first.registrySha256||canonicalJson(selector.contract)!==canonicalJson(first.contract)||canonicalJson(selector.registry)!==canonicalJson(first.registry)||canonicalJson(selector.crawlRegistry??null)!==canonicalJson(first.crawlRegistry??null)||original.receipt.authorityId!==source.receipt.authorityId||original.receipt.authoritySha256!==source.receipt.authoritySha256)throw Error('Queue seal cannot merge different source/control generations');
  const extraction=await load(result.result.taskId,'residual_extract');await closeDependencies(extraction);
  if(includeAttemptHistory&&extraction.receipt.outcome==='held_quality'){const history=await loadTerminalException(pool,{documentId:result.documentId,step:'residual_extract',jobKey:extraction.receipt.jobKey,receiptId:extraction.receipt.id,receiptSha256:extraction.sha256,reasonCode:extraction.receipt.reasonCode});extractionAttemptHistory.push({documentId:result.documentId,jobKey:extraction.receipt.jobKey,attemptHistory:history.attemptHistory});}
  const predecessor=byId.get(result.preparationReceiptId);
  if(!predecessor||predecessor.spec.step!=='residual_prepare'||predecessor.receipt.jobKey!==result.preparationJobKey||predecessor.sha256!==result.preparationReceiptSha256||!predecessor.receipt.outputHashes.includes(result.preparedArtifactSha256))throw Error('Queue seal changes committed preparation lineage');
  const document=PreparedDocumentSchema.parse(await json(result.preparedArtifactSha256));
  verifyPreparedDocument(document,{...document,receiptSha256:result.result.preparedSha256,municipalityId:original.municipality.id,sourceSha256:original.document.sha256,extractorSha256:selector.contract.preparationSha256,references:[original.reference]},await read(original.document.sha256));
  if(!predecessor.receipt.outputHashes.includes(document.textSha256)||digest(await read(document.textSha256))!==document.textSha256)throw Error('Queue seal prepared text binding mismatch');
  prepared.set(result.result.taskId,document);
  const archiveHash=HashSchema.parse(extraction.receipt.versions.generationArchiveSha256),historical=await authenticateScopedGeneration(await json(archiveHash)),archive=historical.archive;
  if(archive.schemaVersion!=='stadtstack-extraction-contract-archive-v2'||archive.extractorSha256!==selector.contract.extraction.extractorSha256||archive.schemaSha256!==result.result.schemaSha256||digest(JSON.stringify({extraction:archive.promptSha256,judge:archive.judgePromptSha256,extractorSha256:archive.extractorSha256}))!==result.result.promptSha256||Date.parse(archive.archivedAt)>Date.parse(result.result.generatedAt))throw Error('Queue seal original generation archive mismatch');
  const answers=new Map<string,ReplayAnswer>(),identities:ModelEvidence[]=[];
  for(const [name,hash] of Object.entries(extraction.receipt.versions)){
   if(name.startsWith('modelAnswer.')){const answer=verifyReplayAnswer(await json(hash));if(name!=='modelAnswer.'+answer.binding||answers.has(answer.binding))throw Error('Queue seal model answer binding mismatch');answers.set(answer.binding,answer);}
   if(name.startsWith('modelIdentity.')){const identity=ModelEvidenceSchema.parse(await json(hash));if(name!=='modelIdentity.'+identity.modelIdentitySha256)throw Error('Queue seal model identity binding mismatch');identities.push(identity);}
  }
  verifyCachedGeneration({result:result.result,prepared:document,municipality:original.municipality,historical,identities,answers});
  for(const answer of answers.values())callRequirements.push({originalSha256:result.result.sourceSha256,requestSha256:semanticHash(answer.binding)});
  archives.add(archiveHash);
  currentAdmissionReceipts[selector.policyReceiptSha256]=original.policyCheck.admissibilityReceiptSha256;
 }
 const terminalDocumentExceptions=[];
 const terminalCase=(source:{document:CrawlDocument;municipality:{id:string}},reason:string):QuarantineCase=>({documentId:source.document.id,municipalityId:source.municipality.id,sourceId:source.document.sourceId,sourceSha256:source.document.sha256,chunk:null,reason});
 for(const document of terminalDocuments){
  remember({spec:document.entry.spec,receipt:document.entry.receipt,receipt_sha256:document.entry.sha256});await closeDependencies(steps.get(document.pin.jobKey)!);
  currentAdmissionReceipts[document.selector.policyReceiptSha256]=document.source.policyCheck.admissibilityReceiptSha256;
  if(document.pin.step==='residual_extract'){
   const selector=z.object({preparationJobKey:HashSchema,preparationReceiptId:z.uuid(),preparationReceiptSha256:HashSchema,preparedArtifactSha256:HashSchema}).passthrough().parse(document.selector),predecessor=byId.get(selector.preparationReceiptId);
   if(!predecessor||predecessor.spec.step!=='residual_prepare'||predecessor.receipt.jobKey!==selector.preparationJobKey||predecessor.sha256!==selector.preparationReceiptSha256||!predecessor.receipt.outputHashes.includes(selector.preparedArtifactSha256))throw Error('Terminal extraction changes preparation ancestry');
   const preparedDocument=PreparedDocumentSchema.parse(await json(selector.preparedArtifactSha256));verifyPreparedDocument(preparedDocument,{...preparedDocument,municipalityId:document.source.municipality.id,sourceSha256:document.source.document.sha256,extractorSha256:first.contract.preparationSha256,references:[document.source.reference]},await read(document.source.document.sha256));
   if(!predecessor.receipt.outputHashes.includes(preparedDocument.textSha256)||digest(await read(preparedDocument.textSha256))!==preparedDocument.textSha256)throw Error('Terminal extraction prepared text binding mismatch');
   prepared.set(document.pin.jobKey,preparedDocument);
  }
  terminalDocumentExceptions.push({...document.pin,municipalityId:document.source.municipality.id,sourceId:document.source.document.sourceId,sourceSha256:document.source.document.sha256,corpusSha256:document.selector.corpusSha256,outcome:document.entry.receipt.outcome,receipt:document.entry.receipt,attemptHistory:document.entry.attemptHistory});
 }
 const candidates=new Map<string,{record:DistrictKnowledgeRecord;index:number}>();
 committed.results.forEach((result,index)=>result.result.records.forEach(record=>{if(candidates.has(record.id))throw Error('Queue seal duplicate native record ID');candidates.set(record.id,{record,index});}));
 const inventory:CriticalAssessmentInventory={records:[]},admitted=new Set<string>(),assessments=[],assessed=new Set<string>();
 for(const key of [...input.reconciliationJobKeys].sort()){
  const entry=await load(key,'assessment_reconcile'),selector=reconciliationSelectorSchema.parse(entry.spec.selector);await closeDependencies(entry);
  const record=await json(selector.recordArtifactSha256),candidate=candidates.get(record.id);
  if(!candidate||canonicalJson(record)!==canonicalJson(candidate.record)||assessed.has(record.id))throw Error('Queue seal assessment record membership mismatch');assessed.add(record.id);
  const residual=committed.results[candidate.index],original=committed.sources[candidate.index];
  if(entry.spec.policyProofSha256!==residual.policyReceiptSha256||canonicalJson(entry.spec.sourceScope)!==canonicalJson(original.receipt.scope))throw Error('Queue seal assessment source scope mismatch');
  const item=assessmentItemSchema.parse(await json(selector.itemArtifactSha256)),expected=reconstructResidualAssessmentItem(candidate.record,prepared.get(residual.result.taskId)!,residual.preparedArtifactSha256,residual.policyReceiptSha256,item);
  if(canonicalJson(item)!==canonicalJson(expected))throw Error('Queue seal assessment item differs from original record/prepared evidence');
  // The item must have been actually emitted by this extraction's committed queue preparation.
  const itemPreparation=[...steps.values()].find(step=>step.spec.step==='assessment_prepare'&&step.receipt.outputHashes.includes(selector.itemArtifactSha256)&&step.receipt.outputHashes.includes(selector.recordArtifactSha256));
  const preparationSelector=z.object({extraction:pinSchema,extractionArtifactSha256:HashSchema}).passthrough().parse(itemPreparation?.spec.selector);
  const extraction=steps.get(residual.result.taskId)!;
  if(preparationSelector.extraction.jobKey!==residual.result.taskId||preparationSelector.extraction.receiptId!==extraction.receipt.id||preparationSelector.extraction.receiptSha256!==extraction.sha256||!extraction.receipt.outputHashes.includes(preparationSelector.extractionArtifactSha256))throw Error('Queue seal assessment preparation ancestry mismatch');
  const partialPins={recordId:record.id as string,recordEvidenceSha256:record.verification.evidenceHash as string,itemArtifactSha256:selector.itemArtifactSha256,finalArtifactSha256:entry.receipt.outputHashes[0]};
  const rolePins:Partial<Record<'AArtifactSha256'|'BArtifactSha256'|'CArtifactSha256',string>>={};
  for(const role of ['A','B','C'] as const){
   const jobKey=selector[role+'JobKey' as 'AJobKey'|'BJobKey'|'CJobKey'];if(!jobKey)continue;
   const pass=await load(jobKey,'assessment_'+role.toLowerCase());await closeDependencies(pass);
   if(!entry.receipt.dependencyReceiptIds.includes(pass.receipt.id)||pass.receipt.outcome!=='succeeded')throw Error('Queue seal assessment pass is not committed');
   const matches:string[]=[];
   // The committed B outputs also contain original JSONL stdout, not another JSON receipt.
   for(const hash of pass.receipt.outputHashes){let value;try{value=await json(hash);}catch(error){if(error instanceof SyntaxError)continue;throw error;}if(value.version==='assessment-receipt-v1'||value.version==='assessment-receipt-v2'){
    const receipt=validateReceipt(value,item,role);if(receipt.provider!==(role==='B'?'anthropic-subscription':'openai-subscription'))throw Error('Queue seal assessment provider mismatch');matches.push(hash);
    if(role!=='B')callRequirements.push({originalSha256:residual.result.sourceSha256,requestSha256:receipt.requestSha256,jobKey:pass.receipt.jobKey,runId:pass.receipt.runId});
   }}
   if(matches.length!==1)throw Error('Queue seal assessment receipt unavailable');rolePins[role+'ArtifactSha256' as 'AArtifactSha256'|'BArtifactSha256'|'CArtifactSha256']=matches[0];
  }
  const pins=selector.CJobKey&&entry.receipt.outputHashes.length===1?CriticalAssessmentInventorySchema.parse({records:[{...partialPins,...rolePins}]}).records[0]:null;
  const verified=pins?await verifyPinnedAssessment(cas,pins.finalArtifactSha256,pins,{policyOptions:policy,currentAdmissionReceipts}):null;
  if(entry.receipt.outcome==='succeeded'){
   if(!pins||!verified)throw Error('Queue seal admission lacks genuine final/C receipt');
   const output=verified.final.output;
   if(verified.final.disposition!=='ai_reconciled'||verified.final.blocksAffectedAdmission||!output||output.outcome!=='supported'||output.holdReasons.length||!item.claimIds.every(id=>output.assertions.some(assertion=>assertion.claimId===id)))throw Error('Queue seal succeeded reconciliation is not an admission');
   admitted.add(record.id);if(criticalKnowledgeTarget(candidate.record))inventory.records.push(pins);
  }
  assessments.push({jobKey:key,recordId:record.id,outcome:entry.receipt.outcome,pins:selector.CJobKey&&entry.receipt.outputHashes.length===1?pins:null});
 }
 const terminalAssessmentExceptions=[],terminalHeldRecords=new Set<string>();
 for(const pin of [...input.terminalAssessmentExceptions].sort((a,b)=>a.jobKey.localeCompare(b.jobKey))){
  const entry=await loadTerminalException(pool,pin),index=committed.results.findIndex(result=>result.documentId===pin.documentId);if(index<0)throw Error('Terminal assessment lacks an extracted document');
  const result=committed.results[index],original=committed.sources[index],extraction=steps.get(result.result.taskId)!;assertTerminalSourceScope(entry.spec,original.receipt.scope,result.policyReceiptSha256);
  remember({spec:entry.spec,receipt:entry.receipt,receipt_sha256:entry.sha256});await closeDependencies(steps.get(pin.jobKey)!);
  let recordIds:string[];
  if(pin.step==='assessment_prepare'){
   const selector=z.object({extraction:pinSchema,extractionArtifactSha256:HashSchema}).passthrough().parse(entry.spec.selector);
   if(selector.extraction.jobKey!==extraction.receipt.jobKey||selector.extraction.receiptId!==extraction.receipt.id||selector.extraction.receiptSha256!==extraction.sha256||!entry.receipt.dependencyReceiptIds.includes(extraction.receipt.id)||!extraction.receipt.outputHashes.includes(selector.extractionArtifactSha256)||!entry.spec.inputArtifactHashes.includes(selector.extractionArtifactSha256))throw Error('Terminal assessment preparation changes extraction ancestry');
   recordIds=result.result.records.map(record=>record.id);
  }else{
   const selector=z.object({itemArtifactSha256:HashSchema}).passthrough().parse(entry.spec.selector),item=assessmentItemSchema.parse(await json(selector.itemArtifactSha256)),record=result.result.records.find(record=>record.id===item.itemId);
   if(!record||!entry.spec.inputArtifactHashes.includes(selector.itemArtifactSha256)||canonicalJson(item)!==canonicalJson(reconstructResidualAssessmentItem(record,prepared.get(result.result.taskId)!,result.preparedArtifactSha256,result.policyReceiptSha256,item)))throw Error('Terminal assessment item differs from extracted original');
   const emitted=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id WHERE j.step='assessment_prepare' AND r.outcome='succeeded' AND r.receipt->'outputHashes' ? $1 AND r.receipt->'dependencyReceiptIds' ? $2`,[selector.itemArtifactSha256,extraction.receipt.id]);
   if(emitted.rows.length!==1)throw Error('Terminal assessment item lacks unique committed preparation ancestry');
   const preparation=remember(emitted.rows[0]);await closeDependencies(preparation);
   const preparationSelector=z.object({extraction:pinSchema,extractionArtifactSha256:HashSchema}).passthrough().parse(preparation.spec.selector);
   if(preparationSelector.extraction.jobKey!==extraction.receipt.jobKey||preparationSelector.extraction.receiptId!==extraction.receipt.id||preparationSelector.extraction.receiptSha256!==extraction.sha256||!extraction.receipt.outputHashes.includes(preparationSelector.extractionArtifactSha256))throw Error('Terminal assessment preparation pin mismatch');
   recordIds=[record.id];
  }
  for(const id of recordIds)terminalHeldRecords.add(id);
  terminalAssessmentExceptions.push({...pin,municipalityId:original.municipality.id,sourceId:original.document.sourceId,sourceSha256:original.document.sha256,corpusSha256:result.corpusSha256,outcome:entry.receipt.outcome,recordIds,receipt:entry.receipt,attemptHistory:entry.attemptHistory});
 }
 const assessmentItemHolds=[],itemHoldReasons=new Map<string,string>();
 for(const pin of [...input.assessmentItemHolds].sort((a,b)=>a.holdReceiptArtifactSha256.localeCompare(b.holdReceiptArtifactSha256))){
  const entry=await loadAssessmentItemHold(pool,cas,pin,policy),candidate=candidates.get(entry.record.id);
  if(!candidate||canonicalJson(entry.record)!==canonicalJson(candidate.record)||assessed.has(entry.record.id)||terminalHeldRecords.has(entry.record.id))throw Error('Item hold overlaps or lacks an extracted record');
  const result=committed.results[candidate.index],original=committed.sources[candidate.index],extraction=steps.get(result.result.taskId)!;
  if(entry.documentId!==result.documentId||entry.extraction.pin.jobKey!==extraction.receipt.jobKey||entry.extraction.pin.receiptId!==extraction.receipt.id||entry.extraction.pin.receiptSha256!==extraction.sha256||entry.hold.preparedArtifactSha256!==result.preparedArtifactSha256||entry.hold.originalSha256!==original.document.sha256)throw Error('Item hold changes selected extraction ancestry');
  assertTerminalSourceScope(entry.preparation.spec,original.receipt.scope,result.policyReceiptSha256);
  remember(entry.preparation);await closeDependencies(steps.get(pin.preparationJobKey)!);
  terminalHeldRecords.add(entry.record.id);
  itemHoldReasons.set(entry.record.id,entry.hold.reasonCode);
  assessmentItemHolds.push({...pin,documentId:result.documentId,municipalityId:original.municipality.id,sourceId:original.document.sourceId,sourceSha256:original.document.sha256,recordIds:[entry.record.id],outcome:entry.hold.outcome,reasonCode:entry.hold.reasonCode,assessmentProviderCalls:entry.hold.assessmentProviderCalls,receipt:entry.hold,preparationStepReceiptId:entry.preparation.receipt.id,preparationStepReceiptSha256:entry.preparation.receipt_sha256});
 }
 const critical=await admitCriticalKnowledge([...admitted].map(id=>candidates.get(id)!.record),inventory,cas,{policyOptions:policy,currentAdmissionReceipts});
 for(const hold of critical.holds)admitted.delete(hold.recordId);
 const records=committed.results.flatMap(result=>result.result.records.filter(record=>admitted.has(record.id)));
 const quarantine=committed.results.flatMap((result,index)=>{
  const cases=[...result.result.quarantine];
  for(const record of result.result.records)if(!admitted.has(record.id))cases.push({documentId:result.documentId,municipalityId:record.municipalityId,sourceId:record.sources[0].id,sourceSha256:result.result.sourceSha256,chunk:null,reason:itemHoldReasons.has(record.id)?'assessment_item_hold:'+itemHoldReasons.get(record.id):assessed.has(record.id)||terminalHeldRecords.has(record.id)?'assessment_held':'assessment_missing',candidate:record});
  // A real negative extraction still counts as an attempted group in v2 lineage.
  if(!result.result.records.length&&!cases.length)cases.push({documentId:result.documentId,municipalityId:result.result.municipalityId,sourceId:committed.sources[index].document.sourceId,sourceSha256:result.result.sourceSha256,chunk:null,reason:committed.receipts[index].outcome==='no_supported_case'?'no_supported_case':'extraction_held'});
  return cases;
 });
 quarantine.push(...terminalDocuments.map(document=>terminalCase(document.source,'terminal_document_exception:'+document.pin.reasonCode)),...terminalAssessmentExceptions.map((entry):QuarantineCase=>({documentId:entry.documentId,municipalityId:entry.municipalityId,sourceId:entry.sourceId,sourceSha256:entry.sourceSha256,chunk:null,reason:'terminal_assessment_exception:'+entry.reasonCode})));
 const orderedSteps=[...steps.values()].sort((a,b)=>a.receipt.jobKey<b.receipt.jobKey?-1:1);
 // Authenticate every historical rebinding from its immutable refresh receipt.
 const authenticatedRefreshes=new Set<string>();
 for(const step of orderedSteps)for(const [name,to] of Object.entries(step.receipt.versions))if(name.startsWith('policyRebinding.')){
  const parts=name.split('.');if(parts.length!==3||parts[1]!==step.receipt.policyProofSha256)throw Error('Queue seal policy continuation binding mismatch');
  const rows=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id WHERE r.receipt_sha256=$1`,[HashSchema.parse(parts[2])]);
  if(rows.rows.length!==1)throw Error('Queue seal continuation receipt unavailable');const refresh=remember(rows.rows[0]);
  if(refresh.receipt.step!=='policy_refresh'||refresh.receipt.outcome!=='succeeded'||refresh.receipt.versions.policyRefreshReceipt!==to)throw Error('Queue seal policy continuation receipt mismatch');
  for(const hash of refresh.receipt.outputHashes)await read(hash);await read(HashSchema.parse(to));
  const originalIndex=selectors.findIndex(selector=>selector.policyReceiptSha256===parts[1]);
  if(originalIndex<0||refresh.receipt.versions.policyRefreshOriginal!==residualOriginalIdentity(ResidualInputSchema.strip().parse(selectors[originalIndex])))throw Error('Queue seal continuation changes original custody');
  const historical=await loadPolicyReceipt(cas,parts[1]),proof=await loadPolicyReceipt(cas,to);
  if(!authenticatedRefreshes.has(parts[2])){
   const selector=z.object({manifestSha256:HashSchema}).passthrough().parse(refresh.spec.selector);
   const manifest=CrawlCorpusImportSchema.parse(await json(selector.manifestSha256));
   const authenticated=await readPolicyRefreshCommit(store,cas,refresh.receipt.jobKey,manifest);
   if(authenticated.receiptSha256!==parts[2]||authenticated.job.policyReceiptSha256!==to)throw Error('Queue seal historical refresh output differs from rebinding');
   authenticatedRefreshes.add(parts[2]);
  }
  // Historical validity is a pure custody/window assertion, never a current-check clock override.
  // Current authority, permission and freshness were independently checked while loading the originals.
  if(semanticHash(historical.source)!==semanticHash(proof.source)||semanticHash(historical.scope)!==semanticHash(proof.scope)||semanticHash(historical.permission)!==semanticHash(proof.permission)||historical.authorityId!==proof.authorityId||historical.authoritySha256!==proof.authoritySha256||recordedPolicyIdentity(historical.sourcePolicy)!==recordedPolicyIdentity(proof.sourcePolicy)||Date.parse(proof.checkedAt)<=Date.parse(historical.checkedAt)||Date.parse(step.receipt.startedAt)<Date.parse(proof.checkedAt)||Date.parse(step.receipt.finishedAt)>=Date.parse(proof.expiresAt))throw Error('Queue seal historical policy continuation changes identity/permission or lacks stage-time validity');
  await closeDependencies(refresh);
 }
 const allSteps=[...steps.values()].sort((a,b)=>a.receipt.jobKey<b.receipt.jobKey?-1:1),generatedAt=allSteps.map(step=>step.receipt.finishedAt).sort().at(-1)!;
 for(const step of allSteps)for(const hash of step.receipt.outputHashes)await read(hash);
 const accounting=await pool.query<{jobKey:string;intent:{original_sha256:string;request_sha256:string};authorization:{run_id:string};approval:unknown}>(`
  SELECT j.job_key AS \"jobKey\",to_jsonb(i) AS intent,to_jsonb(a) AS authorization,
   jsonb_build_object('id',p.id,'approvalSha256',p.approval_sha256,'approvedBy',p.approved_by,'approvedAt',p.approved_at,
    'expiresAt',p.expires_at,'jobKeys',p.allowed_job_keys,'ags',p.allowed_ags,'maxJobs',p.max_jobs,
    'maxElapsedMs',p.max_elapsed_ms,'category',p.category,'mode',p.execution_mode) AS approval
  FROM district_pipeline.r1_codex_call_intents i
  JOIN district_pipeline.r1_codex_call_authorizations a ON a.intent_id=i.id
  JOIN district_pipeline.preauthorizations p ON p.id=a.authorization_id
  JOIN district_pipeline.jobs j ON j.id=i.job_id
  WHERE i.original_sha256=ANY($1::text[]) AND i.created_at<=$2::timestamptz ORDER BY i.id
 `,[originals.map(source=>source.document.sha256),generatedAt]);
 for(const required of callRequirements)if(!accounting.rows.some(row=>row.intent.original_sha256===required.originalSha256&&row.intent.request_sha256===required.requestSha256&&(!required.jobKey||row.jobKey===required.jobKey)&&(!required.runId||row.authorization.run_id===required.runId)))throw Error('Queue seal source-bearing model call lacks committed accounting');
 const crawl={bytes:await read(first.corpusSha256),sha256:first.corpusSha256},registry={bytes:await read(first.registrySha256),sha256:first.registrySha256};
 const crawlValue=crawlSummarySchema.parse(JSON.parse(crawl.bytes.toString('utf8'))),registryValue=districtRegistrySchema.parse(JSON.parse(registry.bytes.toString('utf8')));
 const group=(municipalityId:string,sourceSha256:string)=>canonicalJson([municipalityId,sourceSha256]),fetched=new Set(crawlValue.documents.map(doc=>group(doc.municipalityId,doc.sha256))),attempted=new Set(originals.map(original=>group(original.municipality.id,original.document.sha256)));
 if(attempted.size!==originals.length)throw Error('Queue seal duplicate municipal-byte groups must be resolved before selection');
 const limit=Math.max(...registryValue.municipalities.map(city=>originals.filter(original=>original.municipality.id===city.id).length));
 const preparedOriginals=originals.filter((_original,index)=>index<committed.results.length||terminalDocuments[index-committed.results.length].pin.step==='residual_extract');
 const municipalities=registryValue.municipalities.map(city=>({id:city.id,availableDocumentGroups:new Set(crawlValue.documents.filter(doc=>doc.municipalityId===city.id).map(doc=>doc.sha256)).size,selectedDocumentGroups:originals.filter(original=>original.municipality.id===city.id).length,preparedDocumentGroups:preparedOriginals.filter(original=>original.municipality.id===city.id).length,attemptedDocumentGroups:originals.filter(original=>original.municipality.id===city.id).length}));
 const preparationPlan=artifact(preparationPlanSchema.parse({
  schemaVersion:'stadtstack-preparation-plan-v1',generatedAt,corpusSha256:first.corpusSha256,registrySha256:first.registrySha256,
  extractorSha256:first.contract.preparationSha256,maxDocumentsPerMunicipality:limit,availableDocumentGroups:fetched.size,
  selectedDocumentGroups:attempted.size,selectedRepresentations:originals.length,
  municipalities:municipalities.map(counts=>{
   const city=registryValue.municipalities.find(city=>city.id===counts.id)!;
   return {id:city.id,name:city.name,ags:city.ags,districtId:city.districtId,availableDocumentGroups:counts.availableDocumentGroups,selectedDocumentGroups:counts.selectedDocumentGroups,selectedRepresentations:counts.selectedDocumentGroups};
  }),
  groups:[...committed.results.map((result,index)=>({municipality:committed.sources[index].municipality,documentIds:[result.documentId],expected:preparedExpectationSchema.strip().parse(prepared.get(result.result.taskId)),referenceWarnings:[]})),...terminalDocuments.filter(document=>document.pin.step==='residual_extract').map(document=>({municipality:document.source.municipality,documentIds:[document.pin.documentId],expected:preparedExpectationSchema.strip().parse(prepared.get(document.pin.jobKey)),referenceWarnings:[]}))],
  quarantine:terminalDocuments.filter(document=>document.pin.step==='residual_prepare').map(document=>terminalCase(document.source,'terminal_document_exception:'+document.pin.reasonCode)),
 }));
 const extractionRun=artifact({schemaVersion:'stadtstack-extraction-run-v2',generatedAt,assignmentMode:'codex-only',corpusSha256:first.corpusSha256,registrySha256:first.registrySha256,promptContractSha256:first.contract.extraction.promptSha256,schemaSha256:first.contract.extraction.schemaSha256,scope:'bounded_per_municipality',maxDocumentsPerMunicipality:limit,availableDocumentGroups:fetched.size,attemptedDocumentGroups:attempted.size,pendingDocumentGroups:fetched.size-attempted.size,municipalities,promotedRecords:records.length,quarantinedCases:quarantine.length,queue:{...(input.attemptHistory?{attemptHistory:input.attemptHistory}:{}),...(extractionAttemptHistory.length?{extractionAttemptHistory}:{}),...(terminalDocumentExceptions.length?{terminalDocumentExceptions}:{}),...(terminalAssessmentExceptions.length?{terminalAssessmentExceptions}:{}),...(assessmentItemHolds.length?{assessmentItemHolds}:{}),reconciliationJobKeys:[...input.reconciliationJobKeys].sort(),stepReceipts:allSteps.map(step=>({spec:step.spec,receipt:step.receipt,sha256:step.sha256})),generationArchiveSha256s:[...archives].sort(),assessments,callAccounting:{basis:'committed_pre_effect_intents_not_wire_calls_or_invoices',codex:accounting.rows},criticalAdmissions:critical.admissions.filter(admission=>admitted.has(admission.recordId))}});
 const knowledge=KnowledgeRecordsSchema.parse({schemaVersion:'stadtstack-knowledge-v3',generatedAt,records,identityAssertions:[],identityAdmissions:[]});
 const contribution:TextRunContribution={runId:extractionRun.sha256,pins:{corpusSha256:first.corpusSha256,registrySha256:first.registrySha256,promptContractSha256:first.contract.extraction.promptSha256,schemaSha256:first.contract.extraction.schemaSha256},sourceArtifactKind:'native_extraction_output',artifacts:{extractionRun,records:artifact(knowledge),quarantine:artifact({schemaVersion:'stadtstack-quarantine-v1',generatedAt,cases:quarantine}),preparationPlan,crawl,registry}};
 authenticateTextRunContribution(contribution);
 const policyInventory=publicationPolicyReceiptInventorySchema.parse({records:records.map(record=>{const candidate=candidates.get(record.id)!,selector=committed.selectors[candidate.index],currentReceiptSha256=currentAdmissionReceipts[selector.policyReceiptSha256];return {recordId:record.id,receipts:record.sources.map(reference=>({sourceUrl:reference.url,sourceSha256:reference.sha256,receiptSha256:selector.policyReceiptSha256,...(currentReceiptSha256?{currentReceiptSha256}:{})}))};}),currentAdmissionReceipts});
 return {contribution,knowledge,committed,first,originals,...(input.attemptHistory?{attemptHistory:input.attemptHistory}:{}),terminalDocumentExceptions,terminalAssessmentExceptions,assessmentItemHolds,steps:allSteps,policy,criticalInventory:CriticalAssessmentInventorySchema.parse({records:inventory.records.filter(entry=>admitted.has(entry.recordId))}),criticalAdmissions:CriticalAdmissionsSchema.parse({schemaVersion:CRITICAL_ADMISSIONS_VERSION,admissions:critical.admissions.filter(admission=>admitted.has(admission.recordId))}),policyInventory,heldRecords:quarantine.filter(entry=>entry.candidate!==undefined).length};
}

/** Content-addressed immutable managed outputs. Existing current-policy/custody
 * writers own every byte; sealing does not authorize publication or invoke models. */
export async function sealQueueTextContribution(pool:Pool,cas:DistrictCas,input:unknown){
 const built=await buildQueueTextRun(pool,cas,input),store=new DistrictJobStore(pool);
 const bindings:SourceArtifactBinding[]=built.originals.map(source=>({...source.sourceBinding,independentAllowed:true}));
 const unique=[...new Map(bindings.map(binding=>[canonicalJson(binding),binding])).values()];
 await initializeManagedAcquisitionLane(cas.root,{...built.policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const persist=async(value:{bytes:string|Uint8Array;sha256:string},kind:'derived'|'receipt'='derived')=>{
  const relativePath=`sha256/${value.sha256.slice(0,2)}/${value.sha256}`;
  const stored=await withManagedSourceWrite(cas.root,unique.map(binding=>({...binding,relativePath,contentSha256:value.sha256})),()=>cas.put(typeof value.bytes==='string'?Buffer.from(value.bytes):value.bytes,{kind,mimeType:'application/json'}),built.policy);
  await store.addArtifact(stored);return {path:pathFor(cas,stored.sha256),sha256:stored.sha256,bytes:stored.byteLength,bindings:unique};
 };
 const pins:{path:string;sha256:string;bytes:number;bindings:SourceArtifactBinding[]}[]=[];
 const artifacts={} as Record<keyof TextRunContribution['artifacts'],{path:string;sha256:string}>;
 for(const key of ['extractionRun','records','quarantine','preparationPlan'] as const){const pin=await persist(built.contribution.artifacts[key]!);artifacts[key]={path:pin.path,sha256:pin.sha256};pins.push(pin);}
 const first=built.first,admitted=await readOperatorRegistryInputPin(first.registry,built.policy),migration=first.crawlRegistry?await readCrawlOperatorRegistryInputPin(first.crawlRegistry,first.registry,built.policy):undefined;
 for(const key of ['crawl','registry'] as const){const original=built.contribution.artifacts[key],bindings=key==='registry'?admitted.bindings:[...admitted.bindings,...migration?.crawl.bindings??[],...first.corpusObservations];const pin={path:pathFor(cas,original.sha256),sha256:original.sha256,bytes:original.bytes.length,bindings:bindings.map(binding=>({...binding,independentAllowed:false}))};await assertManagedSourceBindings(pin.path,pin.bindings,built.policy);pins.push(pin);artifacts[key]={path:pin.path,sha256:pin.sha256};}
 const composition=r1TextCompositionInputSchema.parse({schemaVersion:'district-r1-text-composition-input-v1',generatedAt:built.knowledge.generatedAt,approvedRunOrder:[built.contribution.runId],admissions:[{runId:built.contribution.runId,recordIds:built.knowledge.records.map(record=>record.id)}],contributions:[{runId:built.contribution.runId,pins:built.contribution.pins,sourceArtifactKind:'native_extraction_output',artifacts}]});
 const compositionPin=await persist(artifact(composition)),criticalInventory=await persist(artifact(built.criticalInventory)),criticalAdmissions=await persist(artifact(built.criticalAdmissions)),policyInventory=await persist(artifact(built.policyInventory));pins.push(compositionPin,criticalInventory,policyInventory,criticalAdmissions);
 for(const step of built.steps)await persist(artifact(step.receipt),'receipt');
 const provenance=await persist(artifact(privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:pins})));
 // A final offline current-policy/queue recheck prevents a changed cohort escaping.
 const final=await buildQueueTextRun(pool,cas,input);if(final.contribution.runId!==built.contribution.runId||semanticHash(final.policyInventory)!==semanticHash(built.policyInventory))throw Error('Queue seal inputs changed during managed persistence');
 return {runId:built.contribution.runId,compositionArtifactSha256:compositionPin.sha256,path:compositionPin.path,artifacts,criticalInventory,criticalAdmissions,policyInventory,privateProvenance:provenance,records:built.knowledge.records.length,heldRecords:built.heldRecords,committedDocuments:built.originals.length,...(built.attemptHistory?{attemptHistory:built.attemptHistory}:{}),terminalDocumentExceptions:built.terminalDocumentExceptions,terminalAssessmentExceptions:built.terminalAssessmentExceptions,assessmentItemHolds:built.assessmentItemHolds};
}

/** Preserve historical non-exception exports without changing their frozen job
 * implementation. Terminal exports authenticate the new complete queue closure. */
export async function exportQueueTextContribution(pool:Pool,cas:DistrictCas,jobKeys:readonly string[],contribution:TextRunContribution){
 const authenticated=authenticateTextRunContribution(contribution),queue=z.object({reconciliationJobKeys:z.array(HashSchema),attemptHistory:z.literal('committed-v1').optional(),extractionAttemptHistory:z.array(z.unknown()).optional(),terminalDocumentExceptions:z.array(TerminalDocumentExceptionSchema.strip()).default([]),terminalAssessmentExceptions:z.array(TerminalAssessmentExceptionSchema.strip()).default([]),assessmentItemHolds:z.array(AssessmentItemHoldPinSchema.strip()).default([])}).passthrough().parse(authenticated.extractionRun.queue);
 if(!queue.terminalDocumentExceptions.length&&!queue.terminalAssessmentExceptions.length&&!queue.assessmentItemHolds.length&&queue.attemptHistory===undefined&&queue.extractionAttemptHistory===undefined){const original=await exportResidualTextContribution(pool,cas,jobKeys,contribution);return {...original,terminalDocumentExceptions:[],terminalAssessmentExceptions:[],assessmentItemHolds:[]};}
 if(authenticated.sourceArtifactKind!=='native_extraction_output'||authenticated.extractionRun.assignmentMode!=='codex-only')throw Error('Terminal exception export requires a genuine native queue contribution');
 const expected=await buildQueueTextRun(pool,cas,{jobKeys:[...jobKeys],...queueSchemaInput(queue)},{extractionAttemptHistory:queue.extractionAttemptHistory!==undefined});
 for(const key of ['extractionRun','records','quarantine','crawl','registry','preparationPlan'] as const)if(contribution.artifacts[key]?.sha256!==expected.contribution.artifacts[key]?.sha256)throw Error('Queue text terminal exception seal differs from committed lineage');
 return {contribution,stepReceipts:expected.committed.receipts,results:expected.committed.results,terminalDocumentExceptions:expected.terminalDocumentExceptions,terminalAssessmentExceptions:expected.terminalAssessmentExceptions,assessmentItemHolds:expected.assessmentItemHolds};
}
function queueSchemaInput(queue:{reconciliationJobKeys:string[];attemptHistory?:'committed-v1';terminalDocumentExceptions:z.infer<typeof TerminalDocumentExceptionSchema>[];terminalAssessmentExceptions:z.infer<typeof TerminalAssessmentExceptionSchema>[];assessmentItemHolds:z.infer<typeof AssessmentItemHoldPinSchema>[]}){
 return {reconciliationJobKeys:queue.reconciliationJobKeys,...(queue.attemptHistory?{attemptHistory:queue.attemptHistory}:{}),terminalDocumentExceptions:queue.terminalDocumentExceptions,terminalAssessmentExceptions:queue.terminalAssessmentExceptions,assessmentItemHolds:queue.assessmentItemHolds};
}
