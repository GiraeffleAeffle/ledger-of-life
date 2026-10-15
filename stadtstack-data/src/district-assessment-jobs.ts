import {readFile} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import type {Pool} from 'pg';
import {z} from 'zod';
import {HashSchema,canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {DistrictJobStore,DistrictExecutionHold,canonicalJobIdentity,type DistrictJobSpec,type JobHandlerContext,type JobHandler,type JobHandlerResult} from './district-jobs.ts';
import {encodeStepReceipt,type StepReceipt} from './district-step-receipt.ts';
import {DistrictCas,type CasArtifact} from './district-cas.ts';
import {assessmentBlindProjection,assessmentItemSchema,assertResidualAssessmentContext,originalEvidence,buildAssessmentPassInput,runAssessmentPass,createAssessmentReceipt,reconcile,validateReceipt,type AssessmentItem,type AssessmentReceipt,type AssessmentEvidenceContext,type AssessmentPassInput} from './district-assessment.ts';
import {prepareCriticalAssessment} from './district-critical-assessment.ts';
import {criticalKnowledgeTarget} from './district-critical-assessment-public.ts';
import {PreparedDocumentSchema,verifyPreparedDocument,assertPreparedReferenceMembership,type PreparedDocument} from './district-prepared-document.ts';
import {ResidualExtractionSchema,ResidualInputSchema,loadResidualSource,residualJobContract} from './district-residual-jobs.ts';
import {loadPolicyReceipt,recheckPolicyReceipt} from './district-policy-receipt.ts';
import {assessmentEvidenceArtifactHashes,DistrictAssessmentBroker,assessmentBJobHandler,enqueueAssessmentB} from './district-assessment-broker.ts';
import {reserveR1CodexCall,holdR1CodexFailure} from './district-codex-accounting.ts';
import {assertCivicPolicyAuthority,assertManagedSourceReadable,initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID,CivicPolicyStateError,type CivicPolicyOptions} from './civic-opt-out.ts';
import type {ModelAnswer} from './district-model-contract.ts';
import {recheckResidualPolicy} from './district-policy-refresh.ts';
import {buildPreparedAssessmentContext,AssessmentContextHold} from './district-assessment-context.ts';
import {assertValueAssessmentContext} from './district-value-context.ts';
import {bankSchema,parseCandidateCollection,prepareValueAssessment,bindCandidateValueContext,valueAssessmentTarget,canonical as valueCanonical,type Report} from './evaluate-pilot-value.ts';

export const R1_ASSESSMENT_RUBRIC='Assess only the admissible original evidence. Verify exact source quotations, claim and entity identity, date and date role, stage and modality, and financial plan/approval/payment/actual roles. Hold missing evidence, suspected OCR and unsupported critical claims. Score correctness, sources and usefulness 0–2. Abstention has zero usefulness. AI agreement is not independent validation.';
const PredecessorSchema=z.object({jobKey:HashSchema,receiptId:z.uuid(),receiptSha256:HashSchema}).strict();
const ItemSelectorSchema=z.object({version:z.literal('r1-assessment-item-job-v1'),extraction:PredecessorSchema,extractionArtifactSha256:HashSchema}).strict();
const PassSelectorSchema=z.object({version:z.literal('r1-assessment-pass-job-v1'),itemArtifactSha256:HashSchema,recordArtifactSha256:HashSchema,maxModelCalls:z.number().int().min(2).max(48),predecessors:z.array(PredecessorSchema),AJobKey:HashSchema.optional(),BJobKey:HashSchema.optional(),CJobKey:HashSchema.optional()}).strict();
const ItemBundleSchema=z.object({version:z.literal('r1-assessment-items-v1'),items:z.array(z.object({itemArtifactSha256:HashSchema,recordArtifactSha256:HashSchema,maxModelCalls:z.number().int().min(2).max(48)}).strict())}).strict();
export async function assessmentQueueContract(hash?:(file:string)=>Promise<string>){
 // Item building, evidence context, reconciliation and model framing are semantic.
 const files=['district-assessment-jobs.ts','district-assessment-context.ts','district-value-context.ts','pilot-value-transcript.ts','evaluate-pilot-value.ts','../evaluation/pilot-questions.json','district-claims.ts','district-assessment.ts','district-critical-assessment.ts','district-critical-assessment-public.ts','district-residual-jobs.ts','district-inference.ts','district-model.ts','district-model-contract.ts'];
 return semanticHash(await Promise.all(files.map(async file=>({file,sha256:hash?await hash(file):digest(await readFile(new URL(file,import.meta.url)))}))));
}
/** Operational usage/failure metadata is not CAS content or a nested managed lane. */
export function assessmentModelUsagePaths(casRoot:string,jobKey:string,runId:string){
 const out=join(dirname(casRoot),basename(casRoot)+'-assessment-model',jobKey);
 return {ledgerPath:join(out,'usage.jsonl'),pausePath:join(out,runId,'pause.json')};
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
async function persist(store:DistrictJobStore,cas:DistrictCas,item:AssessmentItem,value:unknown,options:Omit<AssessmentEvidenceContext,'cas'>,kind:'derived'|'receipt'='derived'){
 const bytes=Buffer.from(canonicalJson(value)),hash=digest(bytes),relativePath=`sha256/${hash.slice(0,2)}/${hash}`,policy=options.policyOptions??{};
 const proofs=[...new Set([...item.sources.map(source=>source.admissionReceiptSha256),...(item.valueContext?[item.valueContext.custodyReceiptSha256]:[])])];
 const originals=await Promise.all(proofs.map(hash=>loadPolicyReceipt(cas,hash)));
 const receipts=await Promise.all(proofs.map((hash,index)=>options.currentAdmissionReceipts?.[hash]?loadPolicyReceipt(cas,options.currentAdmissionReceipts[hash]):originals[index]));
 const recheck=async()=>{for(let index=0;index<originals.length;index++)await recheckPolicyReceipt(originals[index],{...policy,evaluationAt:new Date().toISOString(),currentProof:receipts[index]});};
 await recheck();
 await initializeManagedAcquisitionLane(cas.root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 const artifact=await withManagedSourceWrite(cas.root,receipts.map(receipt=>({kind:'prepared_source' as const,relativePath,contentSha256:hash,url:receipt.source.url,sourceSha256:receipt.source.sha256,observationId:receipt.scope.sourceId,receiptSha256:semanticHash(receipt),independentAllowed:false})),()=>cas.put(bytes,{kind,mimeType:'application/json'}),policy);
 await recheck();
 await store.addArtifact(artifact);return artifact;
}
/** The same hint-free projection used by critical reviews, without expanding their taxonomy. */
export function residualRecordPropositions(record:z.infer<typeof ResidualExtractionSchema>['result']['records'][number]){
 const {extraction:_generation,verification:_judgment,sources,...claims}=record;
 const sourceProjection=sources.map(source=>({id:source.id,url:source.url,sha256:source.sha256}));
 const projection=z.record(z.string(),z.unknown()).parse(assessmentBlindProjection({...claims,sources:sourceProjection}));
 const metadata=new Set(['id','kind','municipalityId','ags','districtId','sources']);
 const propositions=Object.entries(projection).sort(([left],[right])=>left<right?-1:left>right?1:0).filter(([field])=>!metadata.has(field)&&!field.endsWith('Quote')).flatMap(([field,value])=>{
  const claim=(selector:string,member:unknown)=>{
   const quote=member&&typeof member==='object'&&'quote' in member?member.quote:projection[field+'Quote']??null;
   const body={selector,value:member,quote,sources:sourceProjection};
   return {...body,claimId:'proposition:'+semanticHash({recordId:record.id,...body})};
  };
  return Array.isArray(value)?value.map((member,index)=>claim('/'+field+'/'+index,member)):[claim('/'+field,value)];
 });
 if(!propositions.length)throw new DistrictExecutionHold('quality_failed');
 return {version:'r1-record-propositions-v1',recordId:record.id,projectionSha256:semanticHash(projection),sources:sourceProjection,propositions};
}
/** Quotes are reopened in the actual UTF-16 prepared text; model semantics are never constraints. */
export function residualAssessmentItem(record:z.infer<typeof ResidualExtractionSchema>['result']['records'][number],prepared:PreparedDocument,preparedArtifactSha256:string,policyReceiptSha256:string):AssessmentItem{
 assertPreparedReferenceMembership(record.sources,prepared.references);
 if(record.sources.length!==1||record.sources[0].sha256!==prepared.sourceSha256||record.municipalityId!==prepared.municipalityId)throw new DistrictExecutionHold('quality_failed');
 if(record.extraction.textSha256!==prepared.textSha256)throw new AssessmentContextHold();
 const cited=record.extraction.chunk;
 const citedText=prepared.text.slice(cited.start,cited.end);
 const quotes=new Set<string>();
 const visit=(value:unknown):void=>{if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')for(const [key,member] of Object.entries(value)){if((key==='quote'||key.endsWith('Quote'))&&typeof member==='string'&&member.length)quotes.add(member);else visit(member);}};
 // Complete blind claim projection includes nested predicate, location and
 // identifier quotes, but excludes previous judgment and extraction metadata.
 const projection=residualRecordPropositions(record);visit(projection);
 // These extraction quote fields bind case/municipality identity even though
 // those metadata selectors do not become independent assessed propositions.
 for(const quote of [record.titleQuote,record.summaryQuote,record.municipalityQuote,record.caseQuote,record.documentDateQuote,record.stageDateQuote,record.stageQuote])if(quote)quotes.add(quote);
 const target=criticalKnowledgeTarget(record);if(target)visit(target);
 const locators:AssessmentItem['sources'][number]['locators']=[];
 for(const quote of quotes){
  let local=citedText.indexOf(quote);if(local<0)throw new AssessmentContextHold();
  while(local>=0){const start=cited.start+local;locators.push({id:'span:'+start+':'+(start+quote.length),page:null,table:null,start,end:start+quote.length});local=citedText.indexOf(quote,local+1);}
 }
 if(!locators.length)throw new AssessmentContextHold();
 const unique=[...new Map(locators.map(locator=>[locator.id,locator])).values()].sort((a,b)=>a.start-b.start||a.end-b.end);
 const assessmentContext=buildPreparedAssessmentContext(prepared.text,prepared.textSha256,cited,record.sources.map(source=>source.locator),unique);
 const base=assessmentItemSchema.parse({version:'assessment-item-v1',itemId:record.id,question:'Independently verify every source-bound proposition in the supplied record projection. Return supported only with an evidence assertion for every claimId; otherwise abstain or mark unresolved.',claim:canonicalJson(projection),rubric:R1_ASSESSMENT_RUBRIC,rubricSha256:digest(R1_ASSESSMENT_RUBRIC),sources:[{sourceId:prepared.references[0].id,mcpSourceId:record.sources[0].id,originalSha256:prepared.sourceSha256,textSha256:prepared.textSha256,parserVersion:prepared.extractorSha256,parserReceiptSha256:preparedArtifactSha256,admissionReceiptSha256:policyReceiptSha256,ocrSuspected:prepared.ocrUsed,locators:unique,assessmentContext}],claimIds:projection.propositions.map(proposition=>proposition.claimId),entityIds:[...new Set([record.id,...record.entities.map(entity=>entity.entityId)])],constraints:[],criticalKinds:prepared.ocrUsed?['ocr']:[]});
 return target?prepareCriticalAssessment(record,base):base;
}
export async function enqueueResidualAssessmentItems(pool:Pool,store:DistrictJobStore,cas:DistrictCas,extractionJobKey:string){
 const row=await committed(pool,extractionJobKey,'residual_extract');if(row.receipt.outputHashes.length!==1)throw new DistrictExecutionHold('quality_failed');
 const selector=ItemSelectorSchema.parse({version:'r1-assessment-item-job-v1',extraction:row.pin,extractionArtifactSha256:row.receipt.outputHashes[0]});
 await cas.verify(selector.extractionArtifactSha256);
 return store.enqueue({...row.spec,step:'assessment_prepare',lane:'assessment',semanticContractSha256:await assessmentQueueContract(),selector,inputArtifactHashes:[...row.spec.inputArtifactHashes,selector.extractionArtifactSha256]},{dependencies:[{jobKey:extractionJobKey,expectedReceiptSha256:row.pin.receiptSha256}]});
}
export const ValueAssessmentEnqueueSchema=z.object({reportPath:z.string().min(1),
  sourceBindings:assessmentItemSchema.shape.sources,custodyReceiptSha256:HashSchema,
  maxModelCalls:z.number().int().min(2).max(48).default(2)}).strict();
export async function buildValueAssessmentItem(report:Report,questionId:string,lane:'withoutGraph'|'withGraph',
  bindings:AssessmentItem['sources'],custodyReceiptSha256:string,context:AssessmentEvidenceContext){
 const row=report.evaluations.find(row=>row.question.id===questionId);if(!row)throw new AssessmentContextHold();
 const target=valueAssessmentTarget(report,row,lane),sources:AssessmentItem['sources']=[];
 for(const [id,attribution] of Object.entries(target.sources)){
  const matches=bindings.filter(source=>source.mcpSourceId===id);
  if(matches.length!==1||matches[0].originalSha256!==attribution.sha256)throw new AssessmentContextHold();
  const source=matches[0];
  const proof=await loadPolicyReceipt(context.cas,source.admissionReceiptSha256);
  if(!row.question.cityIds.includes(proof.scope.municipalityId))throw new AssessmentContextHold();
  sources.push(source);
 }
 const rubric=z.string().parse(report.method.grading);
 const claimLocators=sources.flatMap(source=>[
  ...source.locators.map(locator=>({claimId:'value-claim:'+semanticHash({sourceId:source.mcpSourceId,locatorId:locator.id}),sourceId:source.mcpSourceId,locatorId:locator.id})),
  ...(source.nativeLocators??[]).map(locator=>({claimId:'value-claim:'+semanticHash({sourceId:source.mcpSourceId,nativeEvidence:locator}),sourceId:source.mcpSourceId,nativeEvidence:locator}))]);
 const entityIds=new Set<string>();
 const visit=(value:unknown):void=>{
  if(Array.isArray(value))value.forEach(visit);
  else if(value&&typeof value==='object')for(const [key,member] of Object.entries(value)){
   if(typeof member==='string'&&['id','subjectId','objectId','fromId','toId'].includes(key)&&member.startsWith('entity:'))entityIds.add(member);
   else visit(member);
  }
 };
 visit(target);
 const item=prepareValueAssessment(report,{version:'assessment-item-v1',itemId:questionId,question:row.question.question,
  claim:canonicalJson({instruction:'Answer the frozen question from this lane only. Assess every material stage, finance and identity claim with typed evidence assertions. Use the supplied claimId for each cited locator; omitted evidence is unavailable, never inferred.',claimLocators}),
  rubric,rubricSha256:digest(rubric),sources,claimIds:claimLocators.length?claimLocators.map(claim=>claim.claimId):['question:'+questionId],entityIds:[...entityIds].sort(),constraints:[],
  criticalKinds:sources.length?['stage','finance','identity',...(sources.some(source=>source.ocrSuspected)?['ocr']:[])]:[]},lane);
 return bindCandidateValueContext(item,context,custodyReceiptSha256);
}
export async function enqueueValueAssessments(pool:Pool,store:DistrictJobStore,cas:DistrictCas,input:unknown,
 options:Omit<AssessmentEvidenceContext,'cas'>={}){
 const manifest=ValueAssessmentEnqueueSchema.parse(input);
 const reportBytes=await readFile(manifest.reportPath);if(reportBytes.length>64*1024*1024)throw new AssessmentContextHold('assessment_context_exceeded');
 const report=parseCandidateCollection(JSON.parse(reportBytes.toString('utf8')));
 const bytes=await readFile(new URL('../evaluation/pilot-questions.json',import.meta.url)),bank=bankSchema.parse(JSON.parse(bytes.toString('utf8')));
 const release=z.object({id:HashSchema}).passthrough().parse(report.releaseStatus.dataManifest);
 if(report.questionBankSha256!==digest(bytes)||report.server.mode!=='vm_candidate'||report.server.toolCount!==20
  ||report.server.releaseId!==release.id||valueCanonical(report.evaluations.map(row=>row.question))!==valueCanonical(bank.questions)
  ||report.evaluations.some(row=>row.review))throw new AssessmentContextHold();
 const sourceIds=Object.keys(report.sources);
 if(manifest.sourceBindings.length!==sourceIds.length||new Set(manifest.sourceBindings.map(source=>source.mcpSourceId)).size!==sourceIds.length
  ||manifest.sourceBindings.some(source=>!source.mcpSourceId||report.sources[source.mcpSourceId]?.sha256!==source.originalSha256
    ||report.sources[source.mcpSourceId]?.registrySourceId!==source.sourceId))throw new AssessmentContextHold();
 const items:AssessmentItem[]=[];
 for(const row of report.evaluations)for(const lane of row.question.graphDependent?['withoutGraph','withGraph'] as const:['withoutGraph'] as const)
  items.push(await buildValueAssessmentItem(report,row.question.id,lane,manifest.sourceBindings,manifest.custodyReceiptSha256,{cas,...options}));
 // Validate the complete 37-lane bounded frame before enqueueing any jobs.
 const broker=new DistrictAssessmentBroker(pool,cas,options),jobs=[];
 const transcript=await persist(store,cas,{...items[0],sources:manifest.sourceBindings},report,options);
 for(const item of items){
  const proof=await loadPolicyReceipt(cas,item.valueContext!.custodyReceiptSha256);
  const artifact=await persist(store,cas,item,item,options);
  const selector=PassSelectorSchema.parse({version:'r1-assessment-pass-job-v1',itemArtifactSha256:artifact.sha256,
    recordArtifactSha256:transcript.sha256,maxModelCalls:manifest.maxModelCalls,predecessors:[]});
  const AJobKey=await store.enqueue({step:'assessment_a',lane:'assessment',semanticContractSha256:await assessmentQueueContract(),
    inputArtifactHashes:[artifact.sha256,transcript.sha256,proof.source.sha256,...assessmentEvidenceArtifactHashes(item)],sourceScope:proof.scope,
    selector,policyProofSha256:semanticHash(proof)});
  const BJobKey=await enqueueAssessmentB(broker,{itemArtifactSha256:artifact.sha256,sourceScope:proof.scope,
    policyProofSha256:semanticHash(proof),transport:'vm-omp'});
  jobs.push({questionId:item.itemId,lane:item.valueTarget!.lane,itemArtifactSha256:artifact.sha256,
    reportArtifactSha256:transcript.sha256,answerUnitSha256:item.valueContext!.answerUnitSha256,AJobKey,BJobKey});
 }
 return {version:'r1-value-assessment-jobs-v1',releaseId:report.server.releaseId,maxModelCalls:manifest.maxModelCalls,jobs};
}
async function checkedItem(pool:Pool,context:JobHandlerContext,selector:z.infer<typeof PassSelectorSchema>,options:Omit<AssessmentEvidenceContext,'cas'>){
 for(const pin of selector.predecessors){
  const steps=await pool.query<{step:string}>('SELECT step FROM district_pipeline.jobs WHERE job_key=$1',[pin.jobKey]);
  const row=await committed(pool,pin.jobKey,steps.rows[0]?.step??'');
  if(canonicalJson(row.pin)!==canonicalJson(pin)||!context.job.dependencyReceiptIds.includes(pin.receiptId))throw new DistrictExecutionHold('quality_failed');
 }
 const item=assessmentItemSchema.parse(await json(context.cas,selector.itemArtifactSha256));
 if(item.valueTarget)assertValueAssessmentContext(item);else assertResidualAssessmentContext(item);
 for(const hash of [selector.itemArtifactSha256,selector.recordArtifactSha256,...assessmentEvidenceArtifactHashes(item)]){
  if(!context.job.spec.inputArtifactHashes.includes(hash))throw new DistrictExecutionHold('quality_failed');
  await assertManagedSourceReadable(join(context.cas.root,'sha256',hash.slice(0,2),hash),options.policyOptions);
 }
 const primary=await loadPolicyReceipt(context.cas,context.job.spec.policyProofSha256!);
 if((item.valueContext?item.valueContext.custodyReceiptSha256!==semanticHash(primary):!item.sources.some(source=>source.admissionReceiptSha256===semanticHash(primary)))||canonicalJson(primary.scope)!==canonicalJson(context.job.spec.sourceScope))throw new DistrictExecutionHold('policy_excluded');
 const record=await json(context.cas,selector.recordArtifactSha256);
 if(item.valueTarget){
  const report=parseCandidateCollection(record),row=report.evaluations.find(row=>row.question.id===item.itemId);
  if(!row||valueCanonical(valueAssessmentTarget(report,row,item.valueTarget.lane))!==valueCanonical(item.valueTarget))throw new DistrictExecutionHold('quality_failed');
 }else{
  if(record.id!==item.itemId)throw new DistrictExecutionHold('quality_failed');
  if(criticalKnowledgeTarget(record)&&canonicalJson(prepareCriticalAssessment(record,item))!==canonicalJson(item))throw new DistrictExecutionHold('quality_failed');
  if(!criticalKnowledgeTarget(record)){
   const projection=residualRecordPropositions(record);
   if(item.claim!==canonicalJson(projection)||canonicalJson(item.claimIds)!==canonicalJson(projection.propositions.map(proposition=>proposition.claimId)))throw new DistrictExecutionHold('quality_failed');
  }
 }
 const evidence=await originalEvidence(item,{cas:context.cas,...options});
 return {item,evidence};
}
async function assessmentFromJob(pool:Pool,cas:DistrictCas,jobKey:string,role:'A'|'B'|'C',item:AssessmentItem,policy:CivicPolicyOptions={}){
 const row=await committed(pool,jobKey,'assessment_'+role.toLowerCase());
 const receipts:Array<{receipt:AssessmentReceipt;artifactSha256:string}>=[];
 for(const hash of row.receipt.outputHashes){
  await assertManagedSourceReadable(join(cas.root,'sha256',hash.slice(0,2),hash),policy);
  let raw;
  try{raw=await json(cas,hash);}catch(error){if(error instanceof SyntaxError)continue;throw error;}
  if(raw.version==='assessment-receipt-v1')receipts.push({receipt:validateReceipt(raw,item,role),artifactSha256:hash});
 }
 if(receipts.length!==1||row.spec.policyProofSha256!==(item.valueContext?.custodyReceiptSha256??item.sources[0].admissionReceiptSha256))throw new DistrictExecutionHold('quality_failed');
 const {receipt,artifactSha256}=receipts[0];if(receipt.provider!==(role==='B'?'anthropic-subscription':'openai-subscription'))throw new DistrictExecutionHold('quality_failed');
 if(role==='B'&&(await assertCivicPolicyAuthority(policy)).mode!=='isolated-fixture'){
  const transport=z.object({transport:z.literal('vm-omp')}).passthrough().parse(row.spec.selector);
  if(transport.transport!=='vm-omp'||receipt.modelEvidence.tool!=='omp-cli')throw new DistrictExecutionHold('authorization_revoked');
 }
 return {row,receipt,artifactSha256};
}
async function assessmentResidualInput(pool:Pool,spec:DistrictJobSpec):Promise<z.infer<typeof ResidualInputSchema>>{
 let preparation;
 if(spec.step==='assessment_prepare'){
  const selector=ItemSelectorSchema.parse(spec.selector),extraction=await committed(pool,selector.extraction.jobKey,'residual_extract');
  if(canonicalJson(extraction.pin)!==canonicalJson(selector.extraction)||!extraction.receipt.outputHashes.includes(selector.extractionArtifactSha256))throw new DistrictExecutionHold('source_policy_stale');
  return ResidualInputSchema.strip().parse(extraction.spec.selector);
 }
 if(spec.step==='assessment_b'){
  const selector=z.object({itemArtifactSha256:HashSchema}).passthrough().parse(spec.selector);
  const matches=await pool.query<{job_key:string}>(`SELECT j.job_key FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.step='assessment_prepare' AND j.state='succeeded' AND r.receipt->'outputHashes' ? $1`,[selector.itemArtifactSha256]);
  if(matches.rows.length!==1)throw new DistrictExecutionHold('source_policy_stale');
  preparation=await committed(pool,matches.rows[0].job_key,'assessment_prepare');
 }else{
  const selector=PassSelectorSchema.parse(spec.selector);
  if(selector.AJobKey){
   const A=await committed(pool,selector.AJobKey,'assessment_a'),previous=PassSelectorSchema.parse(A.spec.selector);
   if(previous.itemArtifactSha256!==selector.itemArtifactSha256||previous.recordArtifactSha256!==selector.recordArtifactSha256||!selector.predecessors.some(pin=>canonicalJson(pin)===canonicalJson(A.pin)))throw new DistrictExecutionHold('source_policy_stale');
   return assessmentResidualInput(pool,A.spec);
  }
  if(selector.predecessors.length!==1)throw new DistrictExecutionHold('source_policy_stale');
  preparation=await committed(pool,selector.predecessors[0].jobKey,'assessment_prepare');
  if(canonicalJson(preparation.pin)!==canonicalJson(selector.predecessors[0])||!preparation.receipt.outputHashes.includes(selector.itemArtifactSha256)||!preparation.receipt.outputHashes.includes(selector.recordArtifactSha256))throw new DistrictExecutionHold('source_policy_stale');
 }
 return assessmentResidualInput(pool,preparation.spec);
}
async function currentAssessmentPolicy(store:DistrictJobStore,cas:DistrictCas,spec:DistrictJobSpec,policyOptions:CivicPolicyOptions={}){
 if(!spec.policyProofSha256)throw new DistrictExecutionHold('source_policy_stale');
 const historical=await loadPolicyReceipt(cas,spec.policyProofSha256);
 if(canonicalJson(historical.scope)!==canonicalJson(spec.sourceScope))throw new DistrictExecutionHold('policy_excluded');
 if(Date.parse(historical.expiresAt)>Date.now()){
  const checked=await recheckPolicyReceipt(historical,{...policyOptions,authorityId:historical.authorityId,authoritySha256:historical.authoritySha256,evaluationAt:new Date().toISOString()});
  return {...checked,currentReceipt:historical,versions:{},continuation:undefined};
 }
 try{
  const residual=await assessmentResidualInput(store.pool,spec);
  if(residual.policyReceiptSha256!==spec.policyProofSha256)throw new DistrictExecutionHold('source_policy_stale');
  return await recheckResidualPolicy(store,cas,residual);
 }catch(error){if(error instanceof CivicPolicyStateError||error instanceof DistrictExecutionHold&&error.reasonCode==='policy_excluded')throw error;throw new DistrictExecutionHold('source_policy_stale');}
}
export function assessmentQueueHandlers(pool:Pool,options:Omit<AssessmentEvidenceContext,'cas'>&{fixtureProvider?:(input:AssessmentPassInput)=>Promise<ModelAnswer>;fixtureProtocol?:true}={}):Readonly<Record<string,JobHandler>>{
 const store=new DistrictJobStore(pool);
 const guarded=(handler:(context:JobHandlerContext,evidenceOptions:Omit<AssessmentEvidenceContext,'cas'>)=>Promise<JobHandlerResult>,queueContract=true):JobHandler=>{
  const wrapped:JobHandler=async context=>{
   if(queueContract&&context.job.spec.semanticContractSha256!==await assessmentQueueContract())throw new DistrictExecutionHold('quality_failed');
   const checked=await currentAssessmentPolicy(store,context.cas,context.job.spec,options.policyOptions);
   const evidenceOptions={...options,currentAdmissionReceipts:{[context.job.spec.policyProofSha256!]:checked.admissibilityReceiptSha256}};
   let result:JobHandlerResult;
   try{result=await handler(context,evidenceOptions);}catch(error){
    if(!(error instanceof AssessmentContextHold))throw error;
    result={outcome:'held_quality',reasonCode:error.reasonCode,counts:{heldFacts:1}};
   }
   const finished=await currentAssessmentPolicy(store,context.cas,context.job.spec,options.policyOptions);
   return {...result,versions:{...result.versions,...checked.versions,...finished.versions}};
  };
  wrapped.currentPolicy=async(spec,cas)=>(await currentAssessmentPolicy(store,cas,spec,options.policyOptions)).continuation;
  return wrapped;
 };
 return {
  assessment_prepare:guarded(async(context,evidenceOptions)=>{
   const selector=ItemSelectorSchema.parse(context.job.spec.selector),row=await committed(pool,selector.extraction.jobKey,'residual_extract');
   const contract=await residualJobContract();
   if(row.spec.semanticContractSha256!==semanticHash(contract))throw new DistrictExecutionHold('quality_failed');
   if(canonicalJson(row.pin)!==canonicalJson(selector.extraction)||!context.job.dependencyReceiptIds.includes(row.pin.receiptId)||row.receipt.outputHashes[0]!==selector.extractionArtifactSha256)throw new DistrictExecutionHold('quality_failed');
   const residual=ResidualInputSchema.strip().parse(row.spec.selector),source=await loadResidualSource(context.cas,residual,{store});
   const envelope=ResidualExtractionSchema.parse(await json(context.cas,selector.extractionArtifactSha256));
   if(envelope.documentId!==residual.documentId||envelope.corpusSha256!==residual.corpusSha256||envelope.registrySha256!==residual.registrySha256||envelope.result.taskId!==row.pin.jobKey||envelope.policyReceiptSha256!==residual.policyReceiptSha256||envelope.result.sourceSha256!==source.document.sha256||envelope.result.promptSha256!==contract.extraction.promptSha256||envelope.result.schemaSha256!==contract.extraction.schemaSha256||context.job.spec.policyProofSha256!==semanticHash(source.receipt)||canonicalJson(context.job.spec.sourceScope)!==canonicalJson(source.receipt.scope))throw new DistrictExecutionHold('quality_failed');
   const preparation=await committed(pool,envelope.preparationJobKey,'residual_prepare');
   if(preparation.pin.receiptId!==envelope.preparationReceiptId||preparation.pin.receiptSha256!==envelope.preparationReceiptSha256||!preparation.receipt.outputHashes.includes(envelope.preparedArtifactSha256)||!row.receipt.dependencyReceiptIds.includes(preparation.pin.receiptId))throw new DistrictExecutionHold('quality_failed');
   const prepared=PreparedDocumentSchema.parse(await json(context.cas,envelope.preparedArtifactSha256));
   verifyPreparedDocument(prepared,{...prepared,receiptSha256:envelope.result.preparedSha256,sourceSha256:source.document.sha256,municipalityId:source.municipality.id,extractorSha256:contract.preparationSha256,references:[source.reference]},await context.cas.read(source.document.sha256));
   if(!preparation.receipt.outputHashes.includes(prepared.textSha256)||digest(await context.cas.read(prepared.textSha256))!==prepared.textSha256)throw new DistrictExecutionHold('quality_failed');
   const outputs:CasArtifact[]=[],items:z.infer<typeof ItemBundleSchema>['items']=[];
   const policy={...evidenceOptions.policyOptions,authorityId:source.receipt.authorityId,authoritySha256:source.receipt.authoritySha256},preparationEvidence={...evidenceOptions,policyOptions:policy};
   let first:AssessmentItem|undefined;
   for(const record of envelope.result.records){
    context.signal.throwIfAborted();const item=residualAssessmentItem(record,prepared,envelope.preparedArtifactSha256,residual.policyReceiptSha256);
    const evidence=await originalEvidence(item,{cas:context.cas,...preparationEvidence});buildAssessmentPassInput(item,evidence,'A');
    const itemArtifact=await persist(store,context.cas,item,item,preparationEvidence),recordArtifact=await persist(store,context.cas,item,record,preparationEvidence);first??=item;
    outputs.push(itemArtifact,recordArtifact);items.push({itemArtifactSha256:itemArtifact.sha256,recordArtifactSha256:recordArtifact.sha256,maxModelCalls:residual.bounds.maxModelCalls});
   }
   if(!first)return {outcome:'no_supported_case',reasonCode:'no_supported_case'};
   outputs.push(await persist(store,context.cas,first,ItemBundleSchema.parse({version:'r1-assessment-items-v1',items}),preparationEvidence));
   return {outcome:'succeeded',reasonCode:'completed',outputs,counts:{candidates:items.length}};
  }),
  assessment_b:guarded(async(context,evidenceOptions)=>{
   if(process.platform!=='linux')throw new DistrictExecutionHold('isolation_unavailable');
   const broker=new DistrictAssessmentBroker(pool,context.cas,{...evidenceOptions,fixtureProtocol:options.fixtureProtocol});
   return assessmentBJobHandler(broker)(context);
  },false),
  ...Object.fromEntries((['A','C'] as const).map(role=>['assessment_'+role.toLowerCase(),guarded(async(context,evidenceOptions)=>{
   const selector=PassSelectorSchema.parse(context.job.spec.selector),authority=await assertCivicPolicyAuthority(options.policyOptions);
   if(authority.mode!==(options.fixtureProvider?'isolated-fixture':'codex-workstation-local')||(options.fixtureProvider&&!options.policyOptions?.authorityId?.startsWith('fixture:')))throw new DistrictExecutionHold('authorization_revoked');
   const {item,evidence}=await checkedItem(pool,context,selector,evidenceOptions);
   let previous:{A:AssessmentReceipt;B:AssessmentReceipt}|undefined;
   if(role==='C')previous={A:(await assessmentFromJob(pool,context.cas,selector.AJobKey!,'A',item,options.policyOptions)).receipt,B:(await assessmentFromJob(pool,context.cas,selector.BJobKey!,'B',item,options.policyOptions)).receipt};
   else if(selector.AJobKey||selector.BJobKey||selector.CJobKey)throw new DistrictExecutionHold('quality_failed');
   const input=buildAssessmentPassInput(item,evidence,role,previous);
   if(!item.valueTarget&&item.sources.length!==1)throw new DistrictExecutionHold('quality_failed');
   const requestArtifact=await persist(store,context.cas,item,input.data,evidenceOptions);
   const accountingOriginal=item.valueContext?.answerUnitSha256??item.sources[0].originalSha256;
   await reserveR1CodexCall(pool,context.job,accountingOriginal,input.requestSha256,selector.maxModelCalls);
   const proofs=item.sources.length?item.sources.map(source=>source.admissionReceiptSha256):[item.valueContext!.custodyReceiptSha256];
   const policies=await Promise.all(proofs.map(hash=>loadPolicyReceipt(context.cas,evidenceOptions.currentAdmissionReceipts?.[hash]??hash)));
   const sourceContext={root:context.cas.root,kind:'artifacts' as const,decisionId:CIVIC_ACQUISITION_DECISION_ID,...options.policyOptions,bindings:policies.map(receipt=>({kind:'prepared_source' as const,url:receipt.source.url,sourceSha256:receipt.source.sha256,observationId:receipt.scope.sourceId,receiptSha256:semanticHash(receipt)}))};
   const paths=assessmentModelUsagePaths(context.cas.root,context.job.jobKey,context.job.runId);
   const startedAt=new Date().toISOString();
   const receipt=await (options.fixtureProvider
    ? options.fixtureProvider(input).then(answer=>createAssessmentReceipt(item,role,answer,{startedAt,finishedAt:new Date().toISOString()},evidence,input))
    : runAssessmentPass(item,role,'openai-subscription',{...paths,signal:context.signal},previous,{cas:context.cas,...evidenceOptions,sourceContext})).catch(error=>holdR1CodexFailure(pool,context.job,accountingOriginal,error));
   context.signal.throwIfAborted();await originalEvidence(item,{cas:context.cas,...evidenceOptions});
   return {outcome:'succeeded',reasonCode:'completed',outputs:[requestArtifact,await persist(store,context.cas,item,receipt,evidenceOptions,'receipt')]};
  })])),
  assessment_reconcile:guarded(async(context,evidenceOptions)=>{
   try{
    const selector=PassSelectorSchema.parse(context.job.spec.selector),{item,evidence}=await checkedItem(pool,context,selector,evidenceOptions);
    const A=(await assessmentFromJob(pool,context.cas,selector.AJobKey!,'A',item,options.policyOptions)).receipt,B=(await assessmentFromJob(pool,context.cas,selector.BJobKey!,'B',item,options.policyOptions)).receipt;
    const input=buildAssessmentPassInput(item,evidence,'C',{A,B});
    // Technical/deterministic failures remain holds, never a majority vote.
    if(!selector.CJobKey&&!input.discrepancies!.A.length&&!input.discrepancies!.B.length){
     const pending={version:'r1-assessment-reconciliation-pending-v1',itemArtifactSha256:selector.itemArtifactSha256,requiresThirdPass:true,reasonCode:'dependency_uncommitted',receiptHashes:[A.receiptSha256,B.receiptSha256]};
     return {outcome:'held_execution',reasonCode:'dependency_uncommitted',outputs:[await persist(store,context.cas,item,pending,evidenceOptions)]};
    }
    const C=selector.CJobKey?(await assessmentFromJob(pool,context.cas,selector.CJobKey,'C',item,options.policyOptions)).receipt:undefined;
    const final=C?await reconcile(item,{A,B,C},{cas:context.cas,...evidenceOptions}):null;
    const admitted=final?.disposition==='ai_reconciled'&&!final.output?.holdReasons.length&&(item.valueTarget
      ?!!final.output?.valueReview
      :final.output?.outcome==='supported'&&item.claimIds.every(id=>final.output!.assertions.some(assertion=>assertion.claimId===id)));
    return {outcome:admitted?'succeeded':'held_quality',reasonCode:admitted?'completed':'quality_failed',outputs:final?[await persist(store,context.cas,item,final,evidenceOptions)]:[],counts:{acceptedFacts:admitted?1:0,heldFacts:admitted?0:1}};
   }catch(error){if(error instanceof CivicPolicyStateError||error instanceof DistrictExecutionHold&&error.reasonCode!=='quality_failed')throw error;return {outcome:'held_quality',reasonCode:'quality_failed'};}
  }),
 };
}
export async function enqueuePreparedAssessmentPass(pool:Pool,store:DistrictJobStore,cas:DistrictCas,preparationJobKey:string,role:'A'|'B',broker?:DistrictAssessmentBroker){
 const row=await committed(pool,preparationJobKey,'assessment_prepare'),bundles:z.infer<typeof ItemBundleSchema>[]=[];
 if(row.spec.semanticContractSha256!==await assessmentQueueContract())throw new AssessmentContextHold();
 for(const hash of row.receipt.outputHashes){const raw=await json(cas,hash);if(raw.version==='r1-assessment-items-v1')bundles.push(ItemBundleSchema.parse(raw));}
 if(bundles.length!==1)throw new DistrictExecutionHold('quality_failed');
 const jobKeys:string[]=[];
 for(const entry of bundles[0].items){
  if(!row.receipt.outputHashes.includes(entry.itemArtifactSha256)||!row.receipt.outputHashes.includes(entry.recordArtifactSha256))throw new DistrictExecutionHold('quality_failed');
  const item=assessmentItemSchema.parse(await json(cas,entry.itemArtifactSha256)),proof=await loadPolicyReceipt(cas,item.sources[0].admissionReceiptSha256);
  assertResidualAssessmentContext(item);
  if(semanticHash(proof)!==row.spec.policyProofSha256||canonicalJson(proof.scope)!==canonicalJson(row.spec.sourceScope))throw new DistrictExecutionHold('policy_excluded');
  if(role==='B'){if(!broker)throw new DistrictExecutionHold('handler_missing');jobKeys.push(await enqueueAssessmentB(broker,{itemArtifactSha256:entry.itemArtifactSha256,sourceScope:proof.scope,policyProofSha256:semanticHash(proof),transport:'vm-omp'}));continue;}
  const selector=PassSelectorSchema.parse({version:'r1-assessment-pass-job-v1',...entry,predecessors:[row.pin]});
  jobKeys.push(await store.enqueue({step:'assessment_a',lane:'assessment',semanticContractSha256:await assessmentQueueContract(),inputArtifactHashes:[entry.itemArtifactSha256,entry.recordArtifactSha256,...assessmentEvidenceArtifactHashes(item)],sourceScope:proof.scope,selector,policyProofSha256:semanticHash(proof)},{dependencies:[{jobKey:row.pin.jobKey,expectedReceiptSha256:row.pin.receiptSha256}]}));
 }
 return jobKeys;
}
export async function enqueueAssessmentResolution(pool:Pool,store:DistrictJobStore,cas:DistrictCas,input:{AJobKey:string;BJobKey:string;CJobKey?:string},stage:'C'|'reconcile',policy:CivicPolicyOptions={}){
 const A=await committed(pool,input.AJobKey,'assessment_a'),selector=PassSelectorSchema.parse(A.spec.selector),item=assessmentItemSchema.parse(await json(cas,selector.itemArtifactSha256));
 if(item.valueTarget)assertValueAssessmentContext(item);else assertResidualAssessmentContext(item);
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
/** Export only committed value reconciliation chains, as private CAS file references. */
export async function exportValueAssessmentResults(pool:Pool,cas:DistrictCas,jobKeys:readonly string[],policy:CivicPolicyOptions={}){
 const entries=[];
 for(const jobKey of jobKeys){
  const final=await committed(pool,jobKey,'assessment_reconcile'),selector=PassSelectorSchema.parse(final.spec.selector);
  const item=assessmentItemSchema.parse(await json(cas,selector.itemArtifactSha256));assertValueAssessmentContext(item);
  if(!selector.CJobKey)throw new DistrictExecutionHold('dependency_uncommitted');
  const roles=await Promise.all((['A','B','C'] as const).map(async role=>{
   const key=role==='A'?selector.AJobKey:role==='B'?selector.BJobKey:selector.CJobKey;
   const selected=await assessmentFromJob(pool,cas,key!,role,item,policy);
   return selected.artifactSha256;
  }));
  for(const hash of [selector.itemArtifactSha256,...roles,...final.receipt.outputHashes])await assertManagedSourceReadable(join(cas.root,'sha256',hash.slice(0,2),hash),policy);
  const original=await originalEvidence(item,{cas,policyOptions:policy});
  const A=validateReceipt(await json(cas,roles[0]),item,'A'),B=validateReceipt(await json(cas,roles[1]),item,'B'),C=validateReceipt(await json(cas,roles[2]),item,'C');
  buildAssessmentPassInput(item,original,'C',{A,B});
  const disposition=await reconcile(item,{A,B,C},{cas,policyOptions:policy});
  if(disposition.disposition!=='ai_reconciled'||!final.receipt.outputHashes.includes(semanticHash(disposition)))throw new DistrictExecutionHold('quality_failed');
  const paths=[selector.itemArtifactSha256,...roles].map(hash=>join(cas.root,'sha256',hash.slice(0,2),hash));
  entries.push({item:paths[0],A:paths[1],B:paths[2],C:paths[3]});
 }
 return entries;
}
