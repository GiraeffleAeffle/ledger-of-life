import {readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import type {Pool} from 'pg';
import {z} from 'zod';
import {canonicalJson,digest,HashSchema,semanticHash} from './district-adapter-contract.ts';
import {canonicalJobIdentity,type DistrictJobSpec} from './district-jobs.ts';
import {StepReceiptSchema,encodeStepReceipt,type StepReceipt} from './district-step-receipt.ts';
import {DistrictCas,type CasPutOptions} from './district-cas.ts';
import {Step8CampaignSchema,authenticateStep8Campaign,assertStep8ExportMembership} from './r1-step8-governance.ts';
import {r1TextCompositionInputSchema} from './district-r1-text-composition.ts';
import {authenticateTextRunContribution,type TextRunContribution} from './text-run-lineage.ts';
import {privatePublicationProvenanceSchema,authenticatePublicationProvenance} from './district-publication-provenance.ts';
import {publicationPolicyReceiptInventorySchema} from './district-publication-policy.ts';
import {PolicyReceiptSchema,recheckPolicyReceipt} from './district-policy-receipt.ts';
import {ResidualExtractionSchema} from './district-residual-jobs.ts';
import {PreparedDocumentSchema,verifyPreparedDocument} from './district-prepared-document.ts';
import {assessmentItemSchema,validateReceipt,verifyPinnedAssessment} from './district-assessment.ts';
import {reconstructResidualAssessmentItem} from './district-assessment-jobs.ts';
import {AssessmentItemHoldPinSchema,AssessmentItemBundleSchema,AssessmentItemHoldReceiptSchema} from './district-assessment-item-holds.ts';
import {CriticalAssessmentInventorySchema} from './district-critical-assessment-contract.ts';
import {OmpNativeCleanupSchema} from './district-omp-b-runner.ts';
import {authenticateScopedGeneration,verifyCachedGeneration,verifyReplayAnswer,requiredReplayStaging} from './replay-pipeline.ts';
import {ModelEvidenceSchema} from './district-model-contract.ts';
import {StructuredJobResultSchema} from './district-structured-jobs.ts';
import {loadPriorPublicationRelease} from './district-publication-predecessor.ts';
import {assertStep8ProcessingPin,assertStep8NativeBStep,STEP8_STRUCTURED_RUN_IDS,STEP8_PRIOR_RELEASE} from './r1-step8-current-policy.ts';
import {auditStep8Allowance} from './r1-step8-allowance-audit.ts';
import {TerminalDocumentExceptionSchema,TerminalAssessmentExceptionSchema,loadTerminalException} from './district-terminal-exceptions.ts';
import {DuplicateSourceContentExceptionSchema} from './district-duplicate-source-content.ts';
import type {Step8Input} from './r1-step8.ts';
import {createWitnessedProvenanceContext,assertCanonicalSealSelection,authenticateCanonicalSealProvenance,canonicalManagedSourceAudit,type WitnessedProvenanceContext} from './r1-step8-provenance.ts';
import {readPreparedStep8Campaign,readPreparedStep8Provenance,type PreparedStep8Staging} from './r1-step8-staging.ts';
import {authenticateImportDispositions} from './r1-step8-import-dispositions.ts';
import type {ImportRejectionDisposition} from './r1-step8-import-disposition-contract.ts';

const requireThat=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const pinSchema=z.object({path:z.string(),sha256:HashSchema}).passthrough();
const auditRechecks=new WeakMap<object,()=>Promise<void>>();
export async function recheckStep8Audit(report:object){const check=auditRechecks.get(report);if(!check)throw Error('Fresh audit recheck requires its trusted live result');await check();}
const itemPins=CriticalAssessmentInventorySchema.shape.records.element;
const queueSchema=z.object({stepReceipts:z.array(z.object({spec:z.unknown(),receipt:StepReceiptSchema,sha256:HashSchema})),
 reconciliationJobKeys:z.array(HashSchema),assessments:z.array(z.object({jobKey:HashSchema,recordId:z.string(),outcome:z.string(),pins:itemPins.nullable()}).passthrough()),
 terminalDocumentExceptions:z.array(z.union([TerminalDocumentExceptionSchema.passthrough().extend({sourceSha256:HashSchema,corpusSha256:HashSchema,municipalityId:z.string(),sourceId:z.string()}),DuplicateSourceContentExceptionSchema])).default([]),terminalAssessmentExceptions:z.array(TerminalAssessmentExceptionSchema.passthrough()).default([]),assessmentItemHolds:z.array(AssessmentItemHoldPinSchema.passthrough()).default([])}).passthrough();
interface AuditStep {spec:DistrictJobSpec;receipt:StepReceipt;sha256:string}
/** Read-only adapter: inherited filesystem CAS initialization is never invoked. */
class AuditCas extends DistrictCas {
 private readonly readExisting:(path:string,hash:string)=>Promise<Buffer>;
 constructor(root:string,readExisting:(path:string,hash:string)=>Promise<Buffer>){super(root);this.readExisting=readExisting;}
 override read(hash:string){HashSchema.parse(hash);return this.readExisting(join(this.root,'sha256',hash.slice(0,2),hash),hash);}
 override async put(_bytes:Uint8Array,_options:CasPutOptions):Promise<never>{throw Error('Step8 audit CAS is read-only');}
}
const selector=(step:AuditStep)=>z.record(z.string(),z.unknown()).parse(step.spec.selector);
export function assertStep8AdmissionProfile(policy:Step8Input['currentGeneration'],item:unknown,steps:AuditStep[]){
 const parsed=assessmentItemSchema.parse(item);requireThat(parsed.sourceRecord?.version===policy.projectionVersion&&!parsed.valueTarget,'Admitting item is not source-record v2');
 for(const step of steps){
  if(step.spec.step==='assessment_b'){
   assertStep8NativeBStep(policy,step.spec,step.receipt.versions);
  }else requireThat(step.spec.semanticContractSha256===policy.assessmentQueueContractSha256,'Admitting assessment closure is outside approved queue contract');
 }
}

/** No source writes, provider, readiness, CAS initialization or fallback.
 * Exact declared-binding authentication uses only Core's built-in read locks;
 * bulk reads retain the lock-free inventory/objection epoch fence. */
export async function auditStep8(input:Step8Input,pool:Pool,borrowedContext?:WitnessedProvenanceContext,preparedStaging?:PreparedStep8Staging){
 const blockers:Array<{scope:string;message:string}>=[],sources:Array<Record<string,unknown>>=[],reads:Array<{path:string;sha256:string}>=[],originals=new Set<string>(),purgeAcknowledgements:unknown[]=[];
 const callRequirements:Array<{originalSha256:string;requestSha256:string;jobKey?:string;runId?:string}>=[];
 const predecessors:Array<Awaited<ReturnType<typeof loadPriorPublicationRelease>>['priorRelease']>=[];
 const plainPins=new Map<string,{path:string;sha256:string}>(),purgeStates:Array<{id:string;jobKey:string;rows:unknown[]}>=[];
 const attempt=async(scope:string,work:()=>Promise<void>)=>{try{await work();}catch(error){blockers.push({scope,message:error instanceof Error?error.message:String(error)});}};
 const plain=async(pin:{path:string;sha256:string})=>{const bytes=await readFile(pin.path);requireThat(digest(bytes)===pin.sha256,'Operator control pin mismatch: '+pin.path);reads.push(pin);plainPins.set(pin.path,{...pin});return bytes;};
 const provenanceContext=borrowedContext??await createWitnessedProvenanceContext(input.nativeSealSelection,input.policy,{pool,casRoot:input.casRoot,catalogue:input.currentGeneration.catalogue,mode:'step8',workers:input.reconstructionWorkers,timing:input.reconstructionTiming,importDispositionDecision:input.importDispositionDecision});
 let provenanceFinished=!!borrowedContext;
 try{
 await assertCanonicalSealSelection(provenanceContext,input.seals.map(({sealResult,provenanceSupplement:_,...queue})=>({output:sealResult,queue})));
 reads.push(input.nativeSealSelection);
 const reader=canonicalManagedSourceAudit(provenanceContext),cas=new AuditCas(input.casRoot,async(path,hash)=>{const bytes=await reader.read(path,hash);reads.push({path,sha256:hash});return bytes;});
 const json=async(hash:string)=>JSON.parse((await cas.read(hash)).toString('utf8'));
 const managed=async(pin:{path:string;sha256:string})=>{const bytes=await reader.read(pin.path,pin.sha256);reads.push(pin);return bytes;};
 const readImports=()=>authenticateImportDispositions({decision:input.importDispositionDecision,nativeSealSelection:input.nativeSealSelection,catalogue:input.currentGeneration.catalogue,seals:input.seals,policy:input.policy,control:plain,managed});
 let importDispositions:ImportRejectionDisposition[]=[];
 await attempt('import-dispositions',async()=>{importDispositions=await readImports();for(const disposition of importDispositions)originals.add(disposition.sourceSha256);});
 const client=await pool.connect();let allowance:Awaited<ReturnType<typeof auditStep8Allowance>>|undefined;
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let campaign:z.infer<typeof Step8CampaignSchema>|undefined;
  await attempt('selection',async()=>{
   requireThat(input.seals.length===input.expectedSources,'Incomplete explicit sealed source set');
   requireThat(new Set(input.seals.map(source=>source.sealResult.sha256)).size===input.seals.length,'Duplicate selected seal generation');
   const catalogue=JSON.parse((await plain(input.currentGeneration.catalogue)).toString('utf8')),review=JSON.parse((await plain(input.currentGeneration.processingReview)).toString('utf8'));
   assertStep8ProcessingPin(input.currentGeneration,catalogue,review);
   if(reader.authority.mode!=='isolated-fixture')requireThat(input.expectedSources===27&&input.expectedDocuments===208,'Production requires the frozen 27-source campaign');
   if(reader.authority.mode!=='isolated-fixture')requireThat(canonicalJson([...input.structuredRunIds].sort())===canonicalJson([...STEP8_STRUCTURED_RUN_IDS].sort())&&canonicalJson(input.priorRelease)===canonicalJson(STEP8_PRIOR_RELEASE),'Production requires the five committed K1/K2 runs and authentic released 0.3.2 predecessor');
   campaign=await authenticateStep8Campaign(JSON.parse((await (preparedStaging?readPreparedStep8Campaign(preparedStaging,input.campaign):managed(input.campaign))).toString('utf8')),async path=>reader.read(path),input.policy);
   requireThat(campaign.sources.length===input.expectedSources&&campaign.sources.reduce((n,source)=>n+source.documents.length,0)===input.expectedDocuments,'Campaign totals mismatch');
   requireThat(catalogue.rows.length===campaign.sources.length,'Catalogue source count mismatch');
   for(const source of campaign.sources){const row=catalogue.rows.find((row:{scope:{sourceId:string;municipalityId:string}})=>row.scope.sourceId===source.sourceId&&row.scope.municipalityId===source.municipalityId);requireThat(row,'Campaign source outside active catalogue');requireThat(canonicalJson(row.originals.map((document:{documentId:string;sha256:string})=>[document.documentId,document.sha256]).sort())===canonicalJson(source.documents.map(document=>[document.documentId,document.sha256]).sort()),'Catalogue document membership mismatch');}
  });
  const seen=new Set<string>();
  for(const selected of input.seals)await attempt('seal:'+selected.sealResult.sha256,async()=>{
   const seal=JSON.parse((await plain(selected.sealResult)).toString('utf8'));
   await managed(seal.privateProvenance);
   const authenticatedProvenance=await authenticateCanonicalSealProvenance(selected.sealResult,selected.provenanceSupplement,input.policy,provenanceContext),provenance=authenticatedProvenance.inventory;
   if(selected.provenanceSupplement)reads.push(selected.provenanceSupplement.inventory,selected.provenanceSupplement.attestation);
   for(const pin of provenance.inputs)await managed({...pin,path:resolve(dirname(selected.provenanceSupplement?.inventory.path??seal.privateProvenance.path),pin.path)});
   const composition=r1TextCompositionInputSchema.parse(await json(HashSchema.parse(seal.compositionArtifactSha256)));requireThat(composition.contributions.length===1&&!composition.retainedPublication,'Expected one native source contribution');
   const raw=composition.contributions[0],artifacts={} as TextRunContribution['artifacts'];
   for(const [kind,value] of Object.entries(raw.artifacts)){if(!value)continue;const pin=pinSchema.parse(value);requireThat(pin.path===join(cas.root,'sha256',pin.sha256.slice(0,2),pin.sha256),'Seal artifact escapes CAS');(artifacts as Record<string,unknown>)[kind]={bytes:await cas.read(pin.sha256),sha256:pin.sha256};}
   const contribution={...raw,artifacts},authenticated=authenticateTextRunContribution(contribution),queue=queueSchema.parse(authenticated.extractionRun.queue),steps=new Map<string,AuditStep>();
   const db=(await client.query('SELECT j.spec,j.state,j.attempt,r.receipt,r.receipt_sha256 FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id WHERE r.id=ANY($1::uuid[])',[queue.stepReceipts.map(entry=>entry.receipt.id)])).rows;
   for(const entry of queue.stepReceipts){const identity=canonicalJobIdentity(entry.spec as DistrictJobSpec),encoded=encodeStepReceipt(entry.receipt),actual=db.find(row=>row.receipt.id===entry.receipt.id);requireThat(encoded.sha256===entry.sha256&&identity.jobKey===entry.receipt.jobKey&&actual&&actual.receipt_sha256===entry.sha256&&canonicalJson(actual.spec)===canonicalJson(identity.spec)&&canonicalJson(actual.receipt)===canonicalJson(entry.receipt),'Sealed StepReceipt differs from canonical DB custody');requireThat(!steps.has(entry.receipt.jobKey),'Conflicting sealed attempts');steps.set(entry.receipt.jobKey,{spec:identity.spec,receipt:entry.receipt,sha256:entry.sha256});}
   for(const entry of steps.values())requireThat(entry.spec.step===entry.receipt.step&&entry.spec.policyProofSha256===entry.receipt.policyProofSha256&&entry.spec.sourceScope.sourceId===entry.receipt.sourceId&&entry.spec.sourceScope.municipalityId===entry.receipt.municipalityId&&canonicalJson([...entry.spec.inputArtifactHashes].sort())===canonicalJson([...entry.receipt.inputHashes].sort()),'StepReceipt input/scope/policy differs from canonical job');
   for(const entry of steps.values()){for(const id of entry.receipt.dependencyReceiptIds){const dependency=[...steps.values()].find(step=>step.receipt.id===id);requireThat(dependency&&dependency.receipt.outcome==='succeeded','Incomplete or held dependency in sealed closure');}for(const hash of [...entry.receipt.inputHashes,...entry.receipt.outputHashes])await cas.read(hash);}
   for(const key of [...selected.jobKeys,...selected.reconciliationJobKeys,...selected.terminalDocumentExceptions.map(pin=>pin.jobKey),...selected.terminalAssessmentExceptions.map(pin=>pin.jobKey),...selected.assessmentItemHolds.map(pin=>pin.preparationJobKey)]){const entry=steps.get(key),actual=db.find(row=>row.receipt.id===entry?.receipt.id);requireThat(entry&&actual&&actual.state===entry.receipt.outcome&&actual.attempt===entry.receipt.attempt,'Selected generation is no longer the current committed attempt');}
   requireThat(canonicalJson([...selected.reconciliationJobKeys].sort())===canonicalJson(queue.reconciliationJobKeys),'Reconciliation selection differs from seal');
   for(const field of ['terminalDocumentExceptions','terminalAssessmentExceptions'] as const){const pins=queue[field].filter(pin=>pin.reasonCode!=='duplicate_source_content').map(({documentId,step,jobKey,receiptId,receiptSha256,reasonCode})=>({documentId,step,jobKey,receiptId,receiptSha256,reasonCode}));requireThat(canonicalJson([...selected[field]].sort((a,b)=>a.jobKey.localeCompare(b.jobKey)))===canonicalJson(pins.sort((a,b)=>a.jobKey.localeCompare(b.jobKey))),'Terminal selection differs from seal');}
   const policy=publicationPolicyReceiptInventorySchema.parse(JSON.parse((await managed(seal.policyInventory)).toString('utf8'))),results=[];
   for(const field of ['terminalDocumentExceptions','terminalAssessmentExceptions'] as const)for(const pin of queue[field].filter(pin=>pin.reasonCode!=='duplicate_source_content')){
    const actual=await loadTerminalException(client,pin);requireThat(canonicalJson(actual.attemptHistory)===canonicalJson(pin.attemptHistory),'Terminal exception attempt history differs from committed receipts');
   }
   for(const entry of steps.values())if(entry.spec.policyProofSha256){
    const hash=entry.spec.policyProofSha256,proof=PolicyReceiptSchema.parse(await json(hash)),current=policy.currentAdmissionReceipts?.[hash];
    requireThat(canonicalJson(proof.scope)===canonicalJson(entry.spec.sourceScope),'Step policy scope mismatch');
    await recheckPolicyReceipt(proof,{...input.policy,evaluationAt:new Date().toISOString(),currentProof:current?await json(current):proof});
   }
   for(const exception of queue.terminalDocumentExceptions){originals.add(exception.sourceSha256);await cas.read(exception.sourceSha256);requireThat(selector(steps.get(exception.jobKey)!).documentId===exception.documentId,'Terminal document selector mismatch');}
   for(const key of selected.jobKeys){const extraction=steps.get(key)!;requireThat(extraction.spec.step==='residual_extract'&&extraction.receipt.outputHashes.length===1,'Extraction is not a native committed output');const result=ResidualExtractionSchema.parse(await json(extraction.receipt.outputHashes[0]));requireThat(result.result.taskId===key,'Extraction output job mismatch');originals.add(result.result.sourceSha256);results.push(result);
    const prepared=PreparedDocumentSchema.parse(await json(result.preparedArtifactSha256)),parser=steps.get(result.preparationJobKey);verifyPreparedDocument(prepared,{...prepared,receiptSha256:result.result.preparedSha256},await cas.read(result.result.sourceSha256));
    requireThat(parser&&parser.spec.step==='residual_prepare'&&parser.receipt.id===result.preparationReceiptId&&parser.sha256===result.preparationReceiptSha256&&extraction.receipt.dependencyReceiptIds.includes(parser.receipt.id)&&parser.receipt.outputHashes.includes(result.preparedArtifactSha256)&&parser.receipt.outputHashes.includes(prepared.textSha256)&&extraction.spec.policyProofSha256===result.policyReceiptSha256,'Extraction parser/prepared/policy ancestry mismatch');
    const historical=await authenticateScopedGeneration(await json(HashSchema.parse(extraction.receipt.versions.generationArchiveSha256))),answers=new Map(),identities=[];
    for(const [name,hash] of Object.entries(extraction.receipt.versions)){if(name.startsWith('modelAnswer.')){const answer=verifyReplayAnswer(await json(hash));requireThat(name==='modelAnswer.'+answer.binding&&!answers.has(answer.binding),'Model answer identity mismatch');answers.set(answer.binding,answer);}if(name.startsWith('modelIdentity.'))identities.push(ModelEvidenceSchema.parse(await json(hash)));}
    const city=JSON.parse((await cas.read(result.registrySha256)).toString('utf8')).municipalities.find((entry:{id:string})=>entry.id===result.result.municipalityId),municipality={id:city.id,name:city.name,ags:city.ags,districtId:city.districtId};
    verifyCachedGeneration({result:result.result,prepared,municipality,historical,identities,answers});
    for(const answer of answers.values())callRequirements.push({originalSha256:result.result.sourceSha256,requestSha256:semanticHash(answer.binding)});
    const proof=PolicyReceiptSchema.parse(await json(result.policyReceiptSha256)),current=policy.currentAdmissionReceipts?.[result.policyReceiptSha256];await recheckPolicyReceipt(proof,{...input.policy,evaluationAt:new Date().toISOString(),currentProof:current?await json(current):proof});
   }
   const source=campaign?.sources.find(source=>source.corpus.sha256===raw.pins.corpusSha256);requireThat(source&&!seen.has(source.corpus.sha256),'Duplicate/unexpected source generation');if(!source)throw Error('Missing campaign source');seen.add(source.corpus.sha256);
   const duplicates=queue.terminalDocumentExceptions.filter(pin=>pin.reasonCode==='duplicate_source_content').map(pin=>DuplicateSourceContentExceptionSchema.parse(pin)),duplicateKeys=new Set(duplicates.map(pin=>pin.jobKey)),canonicalResults=results.filter(result=>!duplicateKeys.has(result.result.taskId));
   const imports=importDispositions.filter(entry=>entry.corpusSha256===source.corpus.sha256&&entry.municipalityId===source.municipalityId&&entry.sourceId===source.sourceId);
   assertStep8ExportMembership(source,canonicalResults,queue.terminalDocumentExceptions,queue.stepReceipts,imports);
   for(const duplicate of duplicates){
    const result=results.find(result=>result.result.taskId===duplicate.jobKey);requireThat(result&&result.documentId===duplicate.documentId,'Duplicate disposition lacks its native extraction');
    requireThat(canonicalJson(duplicate.excludedRecords)===canonicalJson(result!.result.records.map(record=>({recordId:record.id,evidenceSha256:record.verification.evidenceHash}))),'Duplicate disposition changes excluded native records');
    const history=(await client.query('SELECT r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id WHERE j.job_key=$1 ORDER BY r.attempt,r.id',[duplicate.jobKey])).rows.map(row=>({receipt:row.receipt,sha256:row.receipt_sha256}));
    requireThat(canonicalJson(history)===canonicalJson(duplicate.attemptHistory),'Duplicate disposition attempt history differs from committed receipts');
    const excluded=new Set<string>();
    const preparations=[...steps.values()].filter(step=>step.spec.step==='assessment_prepare'&&z.object({extraction:z.object({jobKey:HashSchema}).passthrough()}).passthrough().parse(step.spec.selector).extraction.jobKey===duplicate.jobKey);
    for(const preparation of preparations){
     for(const key of selected.reconciliationJobKeys){const reconciliation=steps.get(key)!,control=selector(reconciliation);if(typeof control.itemArtifactSha256!=='string'||!preparation.receipt.outputHashes.includes(control.itemArtifactSha256))continue;
      excluded.add(preparation.receipt.jobKey);excluded.add(key);for(const role of ['A','B','C'])if(typeof control[role+'JobKey']==='string')excluded.add(control[role+'JobKey'] as string);
     }
     for(const terminal of queue.terminalAssessmentExceptions.filter(pin=>pin.documentId===duplicate.documentId)){const step=steps.get(terminal.jobKey)!,control=selector(step);
      if(step.receipt.jobKey===preparation.receipt.jobKey||typeof control.itemArtifactSha256==='string'&&preparation.receipt.outputHashes.includes(control.itemArtifactSha256)){excluded.add(preparation.receipt.jobKey);excluded.add(terminal.jobKey);}
     }
     if(queue.assessmentItemHolds.some(pin=>pin.preparationJobKey===preparation.receipt.jobKey))excluded.add(preparation.receipt.jobKey);
    }
    for(const terminal of queue.terminalAssessmentExceptions.filter(pin=>pin.documentId===duplicate.documentId))excluded.add(terminal.jobKey);
    requireThat(canonicalJson([...excluded].sort())===canonicalJson(duplicate.excludedAssessmentJobKeys),'Duplicate disposition changes excluded assessment custody');
   }
   const records=JSON.parse(Buffer.from(artifacts.records.bytes).toString('utf8')).records as Array<{id:string}>,admitted=new Set(records.map(record=>record.id)),profiles=[];
   const checkPurge=async(b:AuditStep,receiptArtifactSha256:string)=>{
    const item=assessmentItemSchema.parse(await json(HashSchema.parse(selector(b).itemArtifactSha256))),receipt=validateReceipt(await json(receiptArtifactSha256),item,'B');
    const ackHash=HashSchema.parse(b.receipt.versions.ompPurgeAckSha256);requireThat(b.receipt.outputHashes.includes(ackHash),'Native B purge acknowledgment is not committed output');
    const ack=z.object({version:z.literal('assessment-vm-omp-purge-ack-v1'),leaseId:z.uuid(),inputSha256:HashSchema,cleanup:OmpNativeCleanupSchema}).strict().parse(await json(ackHash));
    const leases=(await client.query('SELECT input_sha256,request_sha256,purge_ack_sha256,receipt_sha256,state,run_id::text,fencing_token::text,item_sha256,client_id FROM district_pipeline.assessment_bridge_leases WHERE id=$1 AND job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$2)',[ack.leaseId,b.receipt.jobKey])).rows;
    requireThat(leases.length===1&&leases[0].state==='submitted'&&leases[0].run_id===b.receipt.runId&&leases[0].fencing_token===b.receipt.leaseToken&&leases[0].client_id==='vm-omp-docker'&&leases[0].item_sha256===selector(b).itemArtifactSha256&&leases[0].input_sha256===ack.inputSha256&&leases[0].purge_ack_sha256===ackHash&&leases[0].receipt_sha256===receiptArtifactSha256&&leases[0].request_sha256===ack.cleanup.requestSha256&&receipt.requestSha256===ack.cleanup.requestSha256,'Native B purge acknowledgment lease/request binding mismatch');
    requireThat(ack.cleanup.responseSha256===receipt.responseSha256&&ack.cleanup.runnerContractSha256===b.receipt.versions.runnerContractSha256&&ack.cleanup.imageId===b.receipt.versions.imageId&&Date.parse(ack.cleanup.completedAt)>=Date.parse(receipt.finishedAt)&&Date.parse(ack.cleanup.completedAt)<=Date.parse(b.receipt.finishedAt),'Native B cleanup response/runner/time mismatch');
    purgeAcknowledgements.push({recordId:item.itemId,jobKey:b.receipt.jobKey,artifactSha256:ackHash,acknowledgment:ack,receiptArtifactSha256,stepReceiptSha256:b.sha256,lease:leases[0]});
    purgeStates.push({id:ack.leaseId,jobKey:b.receipt.jobKey,rows:structuredClone(leases)});
   };
   for(const step of steps.values())if(step.spec.step==='assessment_b')for(const hash of step.receipt.outputHashes){let value;try{value=await json(hash);}catch(error){if(error instanceof SyntaxError)continue;throw error;}if(value.version==='assessment-receipt-v2')await checkPurge(step,hash);}
   for(const assessment of queue.assessments){if(!admitted.has(assessment.recordId))continue;const pins=assessment.pins;requireThat(pins&&assessment.outcome==='succeeded','Admission lacks complete selected final assessment');if(!pins)throw Error('Missing admission pins');
    const verified=await verifyPinnedAssessment(cas,pins.finalArtifactSha256,pins,{policyOptions:input.policy,currentAdmissionReceipts:policy.currentAdmissionReceipts}),item=verified.item;
    const pending=[steps.get(assessment.jobKey)!],closure:AuditStep[]=[],visited=new Set<string>();
    while(pending.length){const step=pending.pop()!;requireThat(step,'Missing admitting assessment dependency');if(visited.has(step.receipt.id))continue;visited.add(step.receipt.id);if(step.spec.step.startsWith('assessment_'))closure.push(step);for(const id of step.receipt.dependencyReceiptIds){const dependency=[...steps.values()].find(entry=>entry.receipt.id===id);requireThat(dependency,'Missing admitting closure dependency');pending.push(dependency!);}}
    assertStep8AdmissionProfile(input.currentGeneration,item,closure);
    const result=canonicalResults.find(result=>result.result.records.some(record=>record.id===assessment.recordId));requireThat(result,'Admission is not a canonical extracted record');if(!result)throw Error('Missing native admission');
    const candidate=result.result.records.find(record=>record.id===assessment.recordId)!,prepared=PreparedDocumentSchema.parse(await json(result.preparedArtifactSha256));reconstructResidualAssessmentItem(candidate,prepared,result.preparedArtifactSha256,result.policyReceiptSha256,item);
    requireThat(canonicalJson(records.find(record=>record.id===assessment.recordId))===canonicalJson(candidate),'Exported admission differs from its native extracted record');
    requireThat(verified.assessments.B.version===input.currentGeneration.B.receiptVersion&&verified.final.disposition==='ai_reconciled'&&!verified.final.blocksAffectedAdmission,'Historical or held B/final cannot admit');
    const b=closure.find(step=>step.spec.step==='assessment_b'&&step.receipt.outputHashes.includes(pins.BArtifactSha256));requireThat(b,'B receipt lacks selected committed native job');
    for(const role of ['A','C'] as const){const receipt=verified.assessments[role],pass=closure.find(step=>step.spec.step==='assessment_'+role.toLowerCase()&&step.receipt.outputHashes.includes(pins[(role+'ArtifactSha256') as 'AArtifactSha256'|'CArtifactSha256']));requireThat(pass&&selector(pass).itemArtifactSha256===pins.itemArtifactSha256,'Admission pass lacks matching selected item/queue custody');profiles.push({recordId:assessment.recordId,role,jobKey:pass!.receipt.jobKey,requestSha256:receipt.requestSha256,providerEncodingVersion:receipt.providerEncodingVersion});for(const source of item.sources)callRequirements.push({originalSha256:source.originalSha256,requestSha256:receipt.requestSha256,jobKey:pass!.receipt.jobKey,runId:pass!.receipt.runId});}
    profiles.push({recordId:assessment.recordId,role:'B',jobKey:b!.receipt.jobKey,version:verified.assessments.B.version,model:verified.assessments.B.requestedModel});
   }
   requireThat([...admitted].every(id=>queue.assessments.some(assessment=>assessment.recordId===id&&assessment.pins&&assessment.outcome==='succeeded')),'Admitted record missing selected assessment closure');
   const holdPins=queue.assessmentItemHolds.map(({preparationJobKey,itemBundleArtifactSha256,holdReceiptArtifactSha256})=>({preparationJobKey,itemBundleArtifactSha256,holdReceiptArtifactSha256}));requireThat(canonicalJson([...selected.assessmentItemHolds].sort((a,b)=>a.holdReceiptArtifactSha256.localeCompare(b.holdReceiptArtifactSha256)))===canonicalJson(holdPins.sort((a,b)=>a.holdReceiptArtifactSha256.localeCompare(b.holdReceiptArtifactSha256))),'Item hold selection differs from seal');
   for(const pin of holdPins){
    const preparation=steps.get(pin.preparationJobKey);requireThat(preparation?.receipt.outcome==='succeeded'&&preparation.receipt.outputHashes.includes(pin.itemBundleArtifactSha256)&&preparation.receipt.outputHashes.includes(pin.holdReceiptArtifactSha256),'Item hold preparation custody mismatch');
    const bundle=AssessmentItemBundleSchema.parse(await json(pin.itemBundleArtifactSha256)),hold=AssessmentItemHoldReceiptSchema.parse(await json(pin.holdReceiptArtifactSha256)),selected=z.object({version:z.literal('r1-assessment-item-job-v1'),extraction:z.object({jobKey:HashSchema,receiptId:z.uuid(),receiptSha256:HashSchema}).strict(),extractionArtifactSha256:HashSchema}).strict().parse(preparation!.spec.selector),extraction=steps.get(selected.extraction.jobKey);
    requireThat(bundle.version==='r1-assessment-items-v2'&&bundle.heldItems.filter(entry=>entry.holdReceiptArtifactSha256===pin.holdReceiptArtifactSha256&&entry.recordArtifactSha256===hold.recordArtifactSha256&&entry.itemArtifactSha256===hold.itemArtifactSha256).length===1&&hold.preparationJobKey===pin.preparationJobKey&&(duplicateKeys.has(selected.extraction.jobKey)||!admitted.has(hold.recordId))&&hold.assessmentProviderCalls===0,'Item hold cannot admit or fabricate provider use');
    requireThat(preparation!.spec.semanticContractSha256===hold.assessmentQueueContractSha256&&preparation!.spec.policyProofSha256===hold.policyReceiptSha256&&extraction&&extraction.receipt.id===selected.extraction.receiptId&&extraction.sha256===selected.extraction.receiptSha256&&preparation!.receipt.dependencyReceiptIds.includes(extraction.receipt.id)&&selected.extractionArtifactSha256===hold.extractionArtifactSha256&&extraction.receipt.outputHashes.includes(hold.extractionArtifactSha256),'Item hold extraction ancestry mismatch');
    const result=ResidualExtractionSchema.parse(await json(hold.extractionArtifactSha256)),record=await json(hold.recordArtifactSha256),prepared=PreparedDocumentSchema.parse(await json(hold.preparedArtifactSha256));
    requireThat(result.result.records.some(candidate=>candidate.id===hold.recordId&&canonicalJson(candidate)===canonicalJson(record))&&semanticHash(record)===hold.recordArtifactSha256&&result.result.sourceSha256===hold.originalSha256&&result.preparedArtifactSha256===hold.preparedArtifactSha256&&result.policyReceiptSha256===hold.policyReceiptSha256&&prepared.textSha256===hold.preparedTextSha256,'Item hold source/prepared record binding mismatch');
    requireThat(canonicalJson([...bundle.items,...(bundle.version==='r1-assessment-items-v2'?bundle.heldItems:[])].map(entry=>entry.recordArtifactSha256).sort())===canonicalJson(result.result.records.map(record=>semanticHash(record)).sort()),'Item hold bundle does not cover exact extraction');
    await cas.read(hold.originalSha256);requireThat((await cas.read(hold.preparedTextSha256)).toString('utf8')===prepared.text,'Item hold prepared text mismatch');
   }
   sources.push({municipalityId:source.municipalityId,sourceId:source.sourceId,corpusSha256:source.corpus.sha256,sealResult:selected.sealResult,documents:source.documents.length,admittedRecordIds:[...admitted],profiles,terminalDocuments:queue.terminalDocumentExceptions,terminalAssessments:queue.terminalAssessmentExceptions,itemHolds:queue.assessmentItemHolds,importDispositions:imports});
  });
  await attempt('complete-source-selection',async()=>{requireThat(seen.size===input.expectedSources&&sources.reduce((n,source)=>n+Number(source.documents),0)===input.expectedDocuments,'Incomplete current-generation source audit');});
  await attempt('complete-import-dispositions',async()=>{requireThat(sources.reduce((count,source)=>count+(source.importDispositions as ImportRejectionDisposition[]).length,0)===importDispositions.length,'Unused import disposition');});
  await attempt('external-inputs',async()=>{
   const provenance=privatePublicationProvenanceSchema.parse(JSON.parse((await (preparedStaging?readPreparedStep8Provenance(preparedStaging,input.privateProvenance):managed(input.privateProvenance))).toString('utf8')));for(const pin of provenance.inputs)await managed({...pin,path:resolve(dirname(input.privateProvenance.path),pin.path)});
   const authenticated=await authenticatePublicationProvenance(input.privateProvenance.path,input.privateProvenance.sha256,input.policy);for(const pin of provenance.inputs)await authenticated.read(resolve(dirname(input.privateProvenance.path),pin.path));
   const cataloguePin=input.staging.find(pin=>pin.destination==='catalogue.json');requireThat(cataloguePin,'Staged catalogue missing');const catalogue=JSON.parse((await managed(cataloguePin!)).toString('utf8')),cities=z.array(z.string()).parse(catalogue.cities.map((city:{id:string})=>city.id));requireThat(canonicalJson(input.staging.map(pin=>pin.destination).sort())===canonicalJson(requiredReplayStaging(cities)),'Incomplete/duplicate staging inventory');
   for(const pin of [input.registry,...input.staging,input.identityAssessments,input.criticalAssessments,input.regionalPolicyReceipts])if(pin)await managed(pin);
   const baseline=await loadPriorPublicationRelease(input.priorRelease,[...cities.flatMap(city=>[`cities/${city}/signals.geojson`,`cities/${city}/changes.json`]),'knowledge/records.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json'],input.clocks.manifestGeneratedAt);predecessors.push(baseline.priorRelease);
   for(const pin of input.staging.filter(pin=>pin.destination.startsWith('core/')))requireThat((await managed(pin)).equals(baseline.files.get(pin.destination)!),'Staged core differs from authentic released core');
   for(const [city,prior] of Object.entries(input.legacyPreviousReleases??{}))predecessors.push((await loadPriorPublicationRelease(prior,[`cities/${city}/signals.geojson`],baseline.manifest.generatedAt,baseline.manifest.id)).priorRelease);
  });
  await attempt('structured-runs',async()=>{requireThat(new Set(input.structuredRunIds).size===input.structuredRunIds.length,'Duplicate structured run');for(const run of input.structuredRunIds){const rows=(await client.query("SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id WHERE r.run_id=$1 AND j.step='structured_parse' AND r.outcome IN ('succeeded','no_supported_case','held_quality')",[run])).rows;requireThat(rows.length,'Selected structured run lacks committed outputs');for(const row of rows){const receipt=encodeStepReceipt(row.receipt);requireThat(receipt.sha256===row.receipt_sha256&&canonicalJobIdentity(row.spec).jobKey===receipt.receipt.jobKey,'Structured receipt custody mismatch');for(const hash of receipt.receipt.outputHashes){const result=StructuredJobResultSchema.parse(await json(hash));await cas.read(result.sourceSha256);for(const source of result.supportingSources){await cas.read(source.sha256);const proof=PolicyReceiptSchema.parse(await json(source.policyReceiptSha256));await recheckPolicyReceipt(proof,{...input.policy,evaluationAt:new Date().toISOString()});}const proof=PolicyReceiptSchema.parse(await json(result.policyReceiptSha256));await recheckPolicyReceipt(proof,{...input.policy,evaluationAt:new Date().toISOString()});}}}});
  await attempt('allowance-accounting',async()=>{
   const accounting=await auditStep8Allowance(client,[...originals],json);allowance=accounting;
   if(reader.authority.mode!=='isolated-fixture'){
    const selected=campaign?.sources.flatMap(source=>source.documents.map(document=>[source.municipalityId,source.sourceId,source.corpus.sha256,document.documentId,document.sha256])).sort(),frozen=accounting.cohort.documents.map(document=>[document.scope.municipalityId,document.scope.sourceId,document.corpusSha256,document.documentId,document.originalSha256]).sort();
    requireThat(canonicalJson(selected)===canonicalJson(frozen),'Production campaign differs from the approved frozen source/original cohort');
   }
   for(const required of callRequirements)requireThat(accounting.accounting.some(row=>row.intent.original_sha256===required.originalSha256&&row.intent.request_sha256===required.requestSha256&&row.authorization&&(!required.jobKey||row.jobKey===required.jobKey)&&(!required.runId||row.authorization.run_id===required.runId)),'Source model call lacks its authorized original/request/job/run accounting');
  });
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 await attempt('authority-epoch',async()=>{await reader.finish();});
 await attempt('native-provenance-epoch',async()=>{if(borrowedContext)await provenanceContext.checkpoint();else{provenanceFinished=true;await provenanceContext.finish();}});
 const report={schemaVersion:'stadtstack-r1-step8-read-only-audit-v1',status:blockers.length?'blocked':'compatible',writes:[],network:false,providers:false,publicationExecuted:false,valueAccepted:false,
  currentGeneration:input.currentGeneration,campaign:input.campaign,sources,blockers,reads:[...new Map(reads.map(pin=>[pin.path,pin])).values()],authority:{...reader.authority,inventorySha256:reader.inventorySha256,optOutSnapshotSha256:reader.optOutSnapshotSha256},allowance,purgeAcknowledgements,predecessors};
 if(borrowedContext&&!blockers.length)auditRechecks.set(report,async()=>{
  await provenanceContext.checkpoint();
  for(const pin of plainPins.values())requireThat(digest(await readFile(pin.path))===pin.sha256,'Audited operator control changed before managed writes');
  requireThat(canonicalJson(await readImports())===canonicalJson(importDispositions),'Audited import disposition changed before managed writes');
  if(preparedStaging)await readPreparedStep8Campaign(preparedStaging,input.campaign);
  const fresh=await pool.connect();
  try{
   await fresh.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await auditStep8Allowance(fresh,[...originals],json);
   for(const expected of purgeStates){
    const rows=(await fresh.query('SELECT input_sha256,request_sha256,purge_ack_sha256,receipt_sha256,state,run_id::text,fencing_token::text,item_sha256,client_id FROM district_pipeline.assessment_bridge_leases WHERE id=$1 AND job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$2)',[expected.id,expected.jobKey])).rows;
    requireThat(canonicalJson(rows)===canonicalJson(expected.rows),'Native B purge acknowledgment current lease changed');
   }
   await fresh.query('COMMIT');
  }catch(error){await fresh.query('ROLLBACK');throw error;}finally{fresh.release();}
  await provenanceContext.checkpoint();
 });
 return report;
 }finally{if(!provenanceFinished)await provenanceContext.finish();}
}
