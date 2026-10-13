import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {z} from 'zod';
import {HashSchema,canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {DistrictJobStore,DistrictExecutionHold,canonicalJobIdentity,type DistrictJobSpec,type JobHandlerContext,type JobHandler} from './district-jobs.ts';
import {encodeStepReceipt,type StepReceipt} from './district-step-receipt.ts';
import {DistrictCas,type CasArtifact} from './district-cas.ts';
import {assessmentItemSchema,originalEvidence,buildAssessmentPassInput,runAssessmentPass,createAssessmentReceipt,reconcile,validateReceipt,type AssessmentItem,type AssessmentReceipt,type AssessmentEvidenceContext,type AssessmentPassInput} from './district-assessment.ts';
import {prepareCriticalAssessment} from './district-critical-assessment.ts';
import {criticalKnowledgeTarget} from './district-critical-assessment-public.ts';
import {PreparedDocumentSchema,verifyPreparedDocument,assertPreparedReferenceMembership,type PreparedDocument} from './district-prepared-document.ts';
import {ResidualExtractionSchema,ResidualInputSchema,loadResidualSource,residualJobContract} from './district-residual-jobs.ts';
import {loadPolicyReceipt,recheckPolicyReceipt} from './district-policy-receipt.ts';
import {assessmentEvidenceArtifactHashes,DistrictAssessmentBroker,enqueueAssessmentB} from './district-assessment-broker.ts';
import {reserveR1CodexCall,holdR1CodexFailure} from './district-codex-accounting.ts';
import {assertCivicPolicyAuthority,assertManagedSourceReadable,initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID,type CivicPolicyOptions} from './civic-opt-out.ts';
import type {ModelAnswer} from './district-model-contract.ts';

export const R1_ASSESSMENT_RUBRIC='Assess only the admissible original evidence. Verify exact source quotations, claim and entity identity, date and date role, stage and modality, and financial plan/approval/payment/actual roles. Hold missing evidence, suspected OCR and unsupported critical claims. Score correctness, sources and usefulness 0–2. Abstention has zero usefulness. AI agreement is not independent validation.';
const PredecessorSchema=z.object({jobKey:HashSchema,receiptId:z.uuid(),receiptSha256:HashSchema}).strict();
const ItemSelectorSchema=z.object({version:z.literal('r1-assessment-item-job-v1'),extraction:PredecessorSchema,extractionArtifactSha256:HashSchema}).strict();
const PassSelectorSchema=z.object({version:z.literal('r1-assessment-pass-job-v1'),itemArtifactSha256:HashSchema,recordArtifactSha256:HashSchema,maxModelCalls:z.number().int().min(2).max(48),predecessors:z.array(PredecessorSchema),AJobKey:HashSchema.optional(),BJobKey:HashSchema.optional(),CJobKey:HashSchema.optional()}).strict();
const ItemBundleSchema=z.object({version:z.literal('r1-assessment-items-v1'),items:z.array(z.object({itemArtifactSha256:HashSchema,recordArtifactSha256:HashSchema,maxModelCalls:z.number().int().min(2).max(48)}).strict())}).strict();
export async function assessmentQueueContract(){
 const files=['district-assessment-jobs.ts','district-codex-accounting.ts','district-assessment.ts','district-critical-assessment.ts','district-critical-assessment-public.ts','district-residual-jobs.ts','district-inference.ts','district-jobs.ts','district-model.ts','district-model-contract.ts','district-model-usage.ts','district-model-diagnostics.ts','district-policy-receipt.ts','civic-opt-out.ts'];
 return semanticHash(await Promise.all(files.map(async file=>({file,sha256:digest(await readFile(new URL(file,import.meta.url)))}))));
}
async function committed(pool:Pool,jobKey:string,step:string){
 HashSchema.parse(jobKey);
 const result=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.job_key=$1 AND j.step=$2 AND j.state='succeeded' ORDER BY r.attempt DESC LIMIT 1`,[jobKey,step]);
 if(result.rows.length!==1)throw new DistrictExecutionHold('dependency_uncommitted');
 const row=result.rows[0],encoded=encodeStepReceipt(row.receipt);
 if(encoded.sha256!==row.receipt_sha256||encoded.receipt.jobKey!==jobKey||encoded.receipt.step!==step||canonicalJobIdentity(row.spec).jobKey!==jobKey||encoded.receipt.policyProofSha256!==row.spec.policyProofSha256)throw new DistrictExecutionHold('quality_failed');
 return {...row,receipt:encoded.receipt,pin:{jobKey,receiptId:encoded.receipt.id,receiptSha256:encoded.sha256}};
}
async function json(cas:DistrictCas,hash:string){return JSON.parse((await cas.read(HashSchema.parse(hash))).toString('utf8'));}
async function persist(store:DistrictJobStore,cas:DistrictCas,item:AssessmentItem,value:unknown,policy:CivicPolicyOptions,kind:'derived'|'receipt'='derived'){
 const bytes=Buffer.from(canonicalJson(value)),hash=digest(bytes),relativePath=`sha256/${hash.slice(0,2)}/${hash}`;
 const receipts=await Promise.all(item.sources.map(source=>loadPolicyReceipt(cas,source.admissionReceiptSha256)));
 for(const receipt of receipts)await recheckPolicyReceipt(receipt,{...policy,evaluationAt:new Date().toISOString()});
 await initializeManagedAcquisitionLane(cas.root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const artifact=await withManagedSourceWrite(cas.root,receipts.map(receipt=>({kind:'prepared_source' as const,relativePath,contentSha256:hash,url:receipt.source.url,sourceSha256:receipt.source.sha256,observationId:receipt.scope.sourceId,receiptSha256:semanticHash(receipt),independentAllowed:false})),()=>cas.put(bytes,{kind,mimeType:'application/json'}),policy);
 for(const receipt of receipts)await recheckPolicyReceipt(receipt,{...policy,evaluationAt:new Date().toISOString()});
 await store.addArtifact(artifact);return artifact;
}
/** Quotes are reopened in the actual UTF-16 prepared text; model semantics are never constraints. */
export function residualAssessmentItem(record:z.infer<typeof ResidualExtractionSchema>['result']['records'][number],prepared:PreparedDocument,preparedArtifactSha256:string,policyReceiptSha256:string):AssessmentItem{
 assertPreparedReferenceMembership(record.sources,prepared.references);
 if(record.sources.length!==1||record.sources[0].sha256!==prepared.sourceSha256||record.municipalityId!==prepared.municipalityId)throw new DistrictExecutionHold('quality_failed');
 const quotes=new Set<string>();
 const visit=(value:unknown):void=>{if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')for(const [key,member] of Object.entries(value)){if(key==='quote'&&typeof member==='string'&&member.length)quotes.add(member);else visit(member);}};
 // Only actual candidate claims, never previous judge rationale or extraction metadata.
 for(const value of [record.entities,record.relations,record.stages])visit(value);
 for(const quote of [record.titleQuote,record.summaryQuote,record.municipalityQuote,record.caseQuote,record.documentDateQuote,record.stageDateQuote,record.stageQuote])if(quote)quotes.add(quote);
 const target=criticalKnowledgeTarget(record);if(target)for(const claim of target.claims)quotes.add(claim.quote);
 const locators:AssessmentItem['sources'][number]['locators']=[];
 for(const quote of quotes){let start=prepared.text.indexOf(quote);if(start<0)throw new DistrictExecutionHold('quality_failed');while(start>=0){locators.push({id:'span:'+start+':'+(start+quote.length),page:null,table:null,start,end:start+quote.length});start=prepared.text.indexOf(quote,start+1);}}
 if(!locators.length)locators.push({id:'document',page:null,table:null,start:0,end:prepared.text.length});
 const unique=[...new Map(locators.map(locator=>[locator.id,locator])).values()].sort((a,b)=>a.start-b.start||a.end-b.end);
 const base=assessmentItemSchema.parse({version:'assessment-item-v1',itemId:record.id,question:'Which source-bound claims does the original establish, and which require abstention?',claim:'Verify the original evidence; do not infer unsupported stage, financial or identity semantics.',rubric:R1_ASSESSMENT_RUBRIC,rubricSha256:digest(R1_ASSESSMENT_RUBRIC),sources:[{sourceId:prepared.references[0].id,mcpSourceId:record.sources[0].id,originalSha256:prepared.sourceSha256,textSha256:prepared.textSha256,parserVersion:prepared.extractorSha256,parserReceiptSha256:preparedArtifactSha256,admissionReceiptSha256:policyReceiptSha256,ocrSuspected:prepared.ocrUsed,locators:unique}],claimIds:[record.id],entityIds:[...new Set([record.id,...record.entities.map(entity=>entity.entityId)])],constraints:[],criticalKinds:prepared.ocrUsed?['ocr']:[]});
 return target?prepareCriticalAssessment(record,base):base;
}
export async function enqueueResidualAssessmentItems(pool:Pool,store:DistrictJobStore,cas:DistrictCas,extractionJobKey:string){
 const row=await committed(pool,extractionJobKey,'residual_extract');if(row.receipt.outputHashes.length!==1)throw new DistrictExecutionHold('quality_failed');
 const selector=ItemSelectorSchema.parse({version:'r1-assessment-item-job-v1',extraction:row.pin,extractionArtifactSha256:row.receipt.outputHashes[0]});
 await cas.verify(selector.extractionArtifactSha256);
 return store.enqueue({...row.spec,step:'assessment_prepare',lane:'assessment',semanticContractSha256:await assessmentQueueContract(),selector,inputArtifactHashes:[...row.spec.inputArtifactHashes,selector.extractionArtifactSha256]},{dependencies:[{jobKey:extractionJobKey,expectedReceiptSha256:row.pin.receiptSha256}]});
}
async function checkedItem(pool:Pool,context:JobHandlerContext,selector:z.infer<typeof PassSelectorSchema>,options:Omit<AssessmentEvidenceContext,'cas'>){
 for(const pin of selector.predecessors){
  const steps=await pool.query<{step:string}>('SELECT step FROM district_pipeline.jobs WHERE job_key=$1',[pin.jobKey]);
  const row=await committed(pool,pin.jobKey,steps.rows[0]?.step??'');
  if(canonicalJson(row.pin)!==canonicalJson(pin)||!context.job.dependencyReceiptIds.includes(pin.receiptId))throw new DistrictExecutionHold('quality_failed');
 }
 const item=assessmentItemSchema.parse(await json(context.cas,selector.itemArtifactSha256));
 for(const hash of [selector.itemArtifactSha256,selector.recordArtifactSha256,...assessmentEvidenceArtifactHashes(item)]){
  if(!context.job.spec.inputArtifactHashes.includes(hash))throw new DistrictExecutionHold('quality_failed');
  await assertManagedSourceReadable(join(context.cas.root,'sha256',hash.slice(0,2),hash),options.policyOptions);
 }
 const primary=await loadPolicyReceipt(context.cas,context.job.spec.policyProofSha256!);
 if(!item.sources.some(source=>source.admissionReceiptSha256===semanticHash(primary))||canonicalJson(primary.scope)!==canonicalJson(context.job.spec.sourceScope))throw new DistrictExecutionHold('policy_excluded');
 const record=await json(context.cas,selector.recordArtifactSha256);
 if(record.id!==item.itemId)throw new DistrictExecutionHold('quality_failed');
 if(criticalKnowledgeTarget(record)&&canonicalJson(prepareCriticalAssessment(record,item))!==canonicalJson(item))throw new DistrictExecutionHold('quality_failed');
 const evidence=await originalEvidence(item,{cas:context.cas,...options});
 return {item,evidence};
}
async function assessmentFromJob(pool:Pool,cas:DistrictCas,jobKey:string,role:'A'|'B'|'C',item:AssessmentItem,policy:CivicPolicyOptions={}){
 const row=await committed(pool,jobKey,'assessment_'+role.toLowerCase());
 const receipts:AssessmentReceipt[]=[];
 for(const hash of row.receipt.outputHashes){
  await assertManagedSourceReadable(join(cas.root,'sha256',hash.slice(0,2),hash),policy);
  let raw;
  try{raw=await json(cas,hash);}catch(error){if(error instanceof SyntaxError)continue;throw error;}
  if(raw.version==='assessment-receipt-v1')receipts.push(validateReceipt(raw,item,role));
 }
 if(receipts.length!==1||row.spec.policyProofSha256!==item.sources[0].admissionReceiptSha256)throw new DistrictExecutionHold('quality_failed');
 const receipt=receipts[0];if(receipt.provider!==(role==='B'?'anthropic-subscription':'openai-subscription'))throw new DistrictExecutionHold('quality_failed');
 if(role==='B'&&(await assertCivicPolicyAuthority(policy)).mode!=='isolated-fixture'){
  const transport=z.object({transport:z.literal('vm-omp')}).passthrough().parse(row.spec.selector);
  if(transport.transport!=='vm-omp'||receipt.modelEvidence.tool!=='omp-cli')throw new DistrictExecutionHold('authorization_revoked');
 }
 return {row,receipt};
}
export function assessmentQueueHandlers(pool:Pool,options:Omit<AssessmentEvidenceContext,'cas'>&{fixtureProvider?:(input:AssessmentPassInput)=>Promise<ModelAnswer>}={}):Readonly<Record<string,JobHandler>>{
 const store=new DistrictJobStore(pool);
 const guarded=(handler:JobHandler):JobHandler=>async context=>{
  if(context.job.spec.semanticContractSha256!==await assessmentQueueContract())throw new DistrictExecutionHold('quality_failed');
  return handler(context);
 };
 return {
  assessment_prepare:guarded(async context=>{
   const selector=ItemSelectorSchema.parse(context.job.spec.selector),row=await committed(pool,selector.extraction.jobKey,'residual_extract');
   const contract=await residualJobContract();
   if(row.spec.semanticContractSha256!==semanticHash(contract))throw new DistrictExecutionHold('quality_failed');
   if(canonicalJson(row.pin)!==canonicalJson(selector.extraction)||!context.job.dependencyReceiptIds.includes(row.pin.receiptId)||row.receipt.outputHashes[0]!==selector.extractionArtifactSha256)throw new DistrictExecutionHold('quality_failed');
   const residual=ResidualInputSchema.strip().parse(row.spec.selector),source=await loadResidualSource(context.cas,residual);
   const envelope=ResidualExtractionSchema.parse(await json(context.cas,selector.extractionArtifactSha256));
   if(envelope.documentId!==residual.documentId||envelope.corpusSha256!==residual.corpusSha256||envelope.registrySha256!==residual.registrySha256||envelope.result.taskId!==row.pin.jobKey||envelope.policyReceiptSha256!==residual.policyReceiptSha256||envelope.result.sourceSha256!==source.document.sha256||envelope.result.promptSha256!==contract.extraction.promptSha256||envelope.result.schemaSha256!==contract.extraction.schemaSha256||context.job.spec.policyProofSha256!==semanticHash(source.receipt)||canonicalJson(context.job.spec.sourceScope)!==canonicalJson(source.receipt.scope))throw new DistrictExecutionHold('quality_failed');
   const preparation=await committed(pool,envelope.preparationJobKey,'residual_prepare');
   if(preparation.pin.receiptId!==envelope.preparationReceiptId||preparation.pin.receiptSha256!==envelope.preparationReceiptSha256||!preparation.receipt.outputHashes.includes(envelope.preparedArtifactSha256)||!row.receipt.dependencyReceiptIds.includes(preparation.pin.receiptId))throw new DistrictExecutionHold('quality_failed');
   const prepared=PreparedDocumentSchema.parse(await json(context.cas,envelope.preparedArtifactSha256));
   verifyPreparedDocument(prepared,{...prepared,receiptSha256:envelope.result.preparedSha256,sourceSha256:source.document.sha256,municipalityId:source.municipality.id,extractorSha256:contract.preparationSha256,references:[source.reference]},await context.cas.read(source.document.sha256));
   if(!preparation.receipt.outputHashes.includes(prepared.textSha256)||digest(await context.cas.read(prepared.textSha256))!==prepared.textSha256)throw new DistrictExecutionHold('quality_failed');
   const outputs:CasArtifact[]=[],items:z.infer<typeof ItemBundleSchema>['items']=[];
   const policy={...options.policyOptions,authorityId:source.receipt.authorityId,authoritySha256:source.receipt.authoritySha256};
   let first:AssessmentItem|undefined;
   for(const record of envelope.result.records){
    context.signal.throwIfAborted();const item=residualAssessmentItem(record,prepared,envelope.preparedArtifactSha256,residual.policyReceiptSha256);
    await originalEvidence(item,{cas:context.cas,policyOptions:policy});
    const itemArtifact=await persist(store,context.cas,item,item,policy),recordArtifact=await persist(store,context.cas,item,record,policy);first??=item;
    outputs.push(itemArtifact,recordArtifact);items.push({itemArtifactSha256:itemArtifact.sha256,recordArtifactSha256:recordArtifact.sha256,maxModelCalls:residual.bounds.maxModelCalls});
   }
   if(!first)return {outcome:'no_supported_case',reasonCode:'no_supported_case'};
   outputs.push(await persist(store,context.cas,first,ItemBundleSchema.parse({version:'r1-assessment-items-v1',items}),policy));
   return {outcome:'succeeded',reasonCode:'completed',outputs,counts:{candidates:items.length}};
  }),
  ...Object.fromEntries((['A','C'] as const).map(role=>['assessment_'+role.toLowerCase(),guarded(async context=>{
   const selector=PassSelectorSchema.parse(context.job.spec.selector),authority=await assertCivicPolicyAuthority(options.policyOptions);
   if(authority.mode!==(options.fixtureProvider?'isolated-fixture':'codex-workstation-local')||(options.fixtureProvider&&!options.policyOptions?.authorityId?.startsWith('fixture:')))throw new DistrictExecutionHold('authorization_revoked');
   const {item,evidence}=await checkedItem(pool,context,selector,options);
   let previous:{A:AssessmentReceipt;B:AssessmentReceipt}|undefined;
   if(role==='C')previous={A:(await assessmentFromJob(pool,context.cas,selector.AJobKey!,'A',item,options.policyOptions)).receipt,B:(await assessmentFromJob(pool,context.cas,selector.BJobKey!,'B',item,options.policyOptions)).receipt};
   else if(selector.AJobKey||selector.BJobKey||selector.CJobKey)throw new DistrictExecutionHold('quality_failed');
   const input=buildAssessmentPassInput(item,evidence,role,previous);
   if(item.sources.length!==1)throw new DistrictExecutionHold('quality_failed');
   const requestArtifact=await persist(store,context.cas,item,input.data,options.policyOptions??{});
   await reserveR1CodexCall(pool,context.job,item.sources[0].originalSha256,input.requestSha256,selector.maxModelCalls);
   const policies=await Promise.all(item.sources.map(source=>loadPolicyReceipt(context.cas,source.admissionReceiptSha256)));
   const sourceContext={root:context.cas.root,kind:'artifacts' as const,decisionId:CIVIC_ACQUISITION_DECISION_ID,...options.policyOptions,bindings:policies.map(receipt=>({kind:'prepared_source' as const,url:receipt.source.url,sourceSha256:receipt.source.sha256,observationId:receipt.scope.sourceId,receiptSha256:semanticHash(receipt)}))};
   const out=join(context.cas.root,'assessment-model',context.job.jobKey);
   const startedAt=new Date().toISOString();
   const receipt=await (options.fixtureProvider
    ? options.fixtureProvider(input).then(answer=>createAssessmentReceipt(item,role,answer,{startedAt,finishedAt:new Date().toISOString()},evidence,input))
    : runAssessmentPass(item,role,'openai-subscription',{ledgerPath:join(out,'usage.jsonl'),pausePath:join(out,'pause.json'),signal:context.signal},previous,{cas:context.cas,...options,sourceContext})).catch(error=>holdR1CodexFailure(pool,item.sources[0].originalSha256,error));
   context.signal.throwIfAborted();await originalEvidence(item,{cas:context.cas,...options});
   return {outcome:'succeeded',reasonCode:'completed',outputs:[requestArtifact,await persist(store,context.cas,item,receipt,options.policyOptions??{},'receipt')]};
  })])),
  assessment_reconcile:guarded(async context=>{
   try{
    const selector=PassSelectorSchema.parse(context.job.spec.selector),{item,evidence}=await checkedItem(pool,context,selector,options);
    const A=(await assessmentFromJob(pool,context.cas,selector.AJobKey!,'A',item,options.policyOptions)).receipt,B=(await assessmentFromJob(pool,context.cas,selector.BJobKey!,'B',item,options.policyOptions)).receipt;
    const input=buildAssessmentPassInput(item,evidence,'C',{A,B});
    // Technical/deterministic failures remain holds, never a majority vote.
    if(!selector.CJobKey&&!input.discrepancies!.A.length&&!input.discrepancies!.B.length){
     const pending={version:'r1-assessment-reconciliation-pending-v1',itemArtifactSha256:selector.itemArtifactSha256,requiresThirdPass:true,reasonCode:'dependency_uncommitted',receiptHashes:[A.receiptSha256,B.receiptSha256]};
     return {outcome:'held_execution',reasonCode:'dependency_uncommitted',outputs:[await persist(store,context.cas,item,pending,options.policyOptions??{})]};
    }
    const C=selector.CJobKey?(await assessmentFromJob(pool,context.cas,selector.CJobKey,'C',item,options.policyOptions)).receipt:undefined;
    const final=C?await reconcile(item,{A,B,C},{cas:context.cas,...options}):null;
    const admitted=final?.disposition==='ai_reconciled'&&final.output?.outcome==='supported'&&!final.output.holdReasons.length;
    return {outcome:admitted?'succeeded':'held_quality',reasonCode:admitted?'completed':'quality_failed',outputs:final?[await persist(store,context.cas,item,final,options.policyOptions??{})]:[],counts:{acceptedFacts:admitted?1:0,heldFacts:admitted?0:1}};
   }catch(error){if(error instanceof DistrictExecutionHold&&error.reasonCode!=='quality_failed')throw error;return {outcome:'held_quality',reasonCode:'quality_failed'};}
  }),
 };
}
export async function enqueuePreparedAssessmentPass(pool:Pool,store:DistrictJobStore,cas:DistrictCas,preparationJobKey:string,role:'A'|'B',broker?:DistrictAssessmentBroker){
 const row=await committed(pool,preparationJobKey,'assessment_prepare'),bundles:z.infer<typeof ItemBundleSchema>[]=[];
 for(const hash of row.receipt.outputHashes){const raw=await json(cas,hash);if(raw.version==='r1-assessment-items-v1')bundles.push(ItemBundleSchema.parse(raw));}
 if(bundles.length!==1)throw new DistrictExecutionHold('quality_failed');
 const jobKeys:string[]=[];
 for(const entry of bundles[0].items){
  if(!row.receipt.outputHashes.includes(entry.itemArtifactSha256)||!row.receipt.outputHashes.includes(entry.recordArtifactSha256))throw new DistrictExecutionHold('quality_failed');
  const item=assessmentItemSchema.parse(await json(cas,entry.itemArtifactSha256)),proof=await loadPolicyReceipt(cas,item.sources[0].admissionReceiptSha256);
  if(semanticHash(proof)!==row.spec.policyProofSha256||canonicalJson(proof.scope)!==canonicalJson(row.spec.sourceScope))throw new DistrictExecutionHold('policy_excluded');
  if(role==='B'){if(!broker)throw new DistrictExecutionHold('handler_missing');jobKeys.push(await enqueueAssessmentB(broker,{itemArtifactSha256:entry.itemArtifactSha256,sourceScope:proof.scope,policyProofSha256:semanticHash(proof),transport:'vm-omp'}));continue;}
  const selector=PassSelectorSchema.parse({version:'r1-assessment-pass-job-v1',...entry,predecessors:[row.pin]});
  jobKeys.push(await store.enqueue({step:'assessment_a',lane:'assessment',semanticContractSha256:await assessmentQueueContract(),inputArtifactHashes:[entry.itemArtifactSha256,entry.recordArtifactSha256,...assessmentEvidenceArtifactHashes(item)],sourceScope:proof.scope,selector,policyProofSha256:semanticHash(proof)},{dependencies:[{jobKey:row.pin.jobKey,expectedReceiptSha256:row.pin.receiptSha256}]}));
 }
 return jobKeys;
}
export async function enqueueAssessmentResolution(pool:Pool,store:DistrictJobStore,cas:DistrictCas,input:{AJobKey:string;BJobKey:string;CJobKey?:string},stage:'C'|'reconcile',policy:CivicPolicyOptions={}){
 const A=await committed(pool,input.AJobKey,'assessment_a'),selector=PassSelectorSchema.parse(A.spec.selector),item=assessmentItemSchema.parse(await json(cas,selector.itemArtifactSha256));
 const B=await assessmentFromJob(pool,cas,input.BJobKey,'B',item,policy);await assessmentFromJob(pool,cas,input.AJobKey,'A',item,policy);
 const C=input.CJobKey?await assessmentFromJob(pool,cas,input.CJobKey,'C',item,policy):undefined;
 if(stage==='C'&&C)throw new DistrictExecutionHold('quality_failed');
 const predecessors=[A.pin,B.row.pin,...C?[C.row.pin]:[]];
 const next=PassSelectorSchema.parse({...selector,...input,predecessors});
 const hashes=[...A.spec.inputArtifactHashes,...B.row.receipt.outputHashes,...A.receipt.outputHashes,...C?C.row.receipt.outputHashes:[]];
 return store.enqueue({...A.spec,step:stage==='C'?'assessment_c':'assessment_reconcile',semanticContractSha256:await assessmentQueueContract(),selector:next,inputArtifactHashes:[...new Set(hashes)]},{dependencies:predecessors.map(pin=>({jobKey:pin.jobKey,expectedReceiptSha256:pin.receiptSha256}))});
}
/** Content-free offline handoff; source-bearing values remain in managed CAS. */
export async function exportAssessmentResults(pool:Pool,cas:DistrictCas,jobKeys:readonly string[],policy:CivicPolicyOptions={}){
 const results=[];
 for(const jobKey of jobKeys){
  HashSchema.parse(jobKey);
  const rows=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.job_key=$1 AND j.step IN ('assessment_prepare','assessment_a','assessment_b','assessment_c','assessment_reconcile') ORDER BY r.attempt DESC LIMIT 1`,[jobKey]);
  if(rows.rows.length!==1)throw new DistrictExecutionHold('dependency_uncommitted');
  const row=rows.rows[0],encoded=encodeStepReceipt(row.receipt);
  if(encoded.sha256!==row.receipt_sha256||canonicalJobIdentity(row.spec).jobKey!==jobKey||encoded.receipt.jobKey!==jobKey)throw new DistrictExecutionHold('quality_failed');
  const receipts:Array<{role:string;artifactSha256:string;receiptSha256:string;itemSha256:string}>=[],items:z.infer<typeof ItemBundleSchema>['items']=[];
  for(const hash of row.receipt.outputHashes){
   await assertManagedSourceReadable(join(cas.root,'sha256',hash.slice(0,2),hash),policy);
   let raw;try{raw=await json(cas,hash);}catch(error){if(error instanceof SyntaxError)continue;throw error;}
   if(raw.version==='r1-assessment-items-v1')items.push(...ItemBundleSchema.parse(raw).items);
   if(raw.version==='assessment-receipt-v1'){
    const selected=z.object({itemArtifactSha256:HashSchema}).passthrough().parse(row.spec.selector);
    const item=assessmentItemSchema.parse(await json(cas,selected.itemArtifactSha256));
    const role=z.enum(['A','B','C']).parse(raw.role),receipt=validateReceipt(raw,item,role);
    receipts.push({role,artifactSha256:hash,receiptSha256:receipt.receiptSha256,itemSha256:receipt.itemSha256});
   }
  }
  results.push({jobKey,step:row.spec.step,outcome:row.receipt.outcome,reasonCode:row.receipt.reasonCode,stepReceiptId:row.receipt.id,stepReceiptSha256:encoded.sha256,inputHashes:row.receipt.inputHashes,outputHashes:row.receipt.outputHashes,selector:row.spec.step==='assessment_prepare'?null:PassSelectorSchema.safeParse(row.spec.selector).success?PassSelectorSchema.parse(row.spec.selector):{itemArtifactSha256:z.object({itemArtifactSha256:HashSchema}).passthrough().parse(row.spec.selector).itemArtifactSha256},receipts,items});
 }
 return {version:'r1-assessment-results-v1',results};
}
