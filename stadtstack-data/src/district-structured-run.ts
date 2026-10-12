import {z} from 'zod';
import {CoverageSchema,HashSchema,canonicalJson,semanticHash,digest,type AdapterCoverage} from './district-adapter-contract.ts';
import {StructuredKnowledgeRecordSchema,type StructuredKnowledgeRecord} from './district-structured-record.ts';
import type {DistrictRegistry} from './district-registry.ts';
import {identityDaySchema} from './district-entity-resolution.ts';
import {StepReceiptSchema,type JobOutcome} from './district-step-receipt.ts';
import {StructuredJobResultSchema,type StructuredJobResult} from './district-structured-jobs.ts';
import {STRUCTURED_WORKER_VERSION} from './district-structured-parser-worker.ts';
import {loadPolicyReceipt,recheckPolicyReceipt} from './district-policy-receipt.ts';
import type {DistrictCas} from './district-cas.ts';
import type {CivicPolicyOptions} from './civic-opt-out.ts';

export function structuredCoverageStateForNoOutput(outcome:JobOutcome):AdapterCoverage['state']{
 if(outcome==='succeeded')throw Error('Succeeded structured step requires its actual output');
 const parsed=CoverageSchema.shape.state.safeParse(outcome);return parsed.success?parsed.data:'not_checked';
}
export const structuredCoverageReceiptSchema=z.object({family:z.string().min(1),operation:z.enum(['parse','discover']),adapterId:z.string().min(1),adapterVersion:z.string().min(1).nullable(),municipalityId:z.string().min(1),sourceId:z.string().min(1),scopeSha256:HashSchema,sourceSha256:HashSchema.nullable(),policyReceiptSha256:HashSchema.nullable(),stepReceiptSha256:HashSchema.nullable(),additionalStepReceiptSha256s:z.array(HashSchema),coverage:CoverageSchema}).strict();
const publicCoverageReasonSchema=z.enum(['source_reported_complete','source_reported_empty','source_reported_not_applicable','source_reported_not_checked','source_reported_partial','source_reported_blocked_policy','source_reported_blocked_access','source_reported_held_origin','source_reported_held_quality','source_reported_held_execution','source_reported_failed_execution']);
const publicCoverageCaveat='Source-native scope only; row counts are not projects or a complete municipal inventory.' as const;
export const structuredPublicCoverageReceiptSchema=structuredCoverageReceiptSchema.omit({coverage:true}).extend({coverage:z.object({state:CoverageSchema.shape.state,checkedAt:CoverageSchema.shape.checkedAt,observedRows:CoverageSchema.shape.observedRows,reasonCode:publicCoverageReasonSchema,caveat:z.literal(publicCoverageCaveat),diagnosticSha256:HashSchema}).strict()}).strict();
export type StructuredPublicCoverageReceipt=z.infer<typeof structuredPublicCoverageReceiptSchema>;
export function projectStructuredCoverageReceipt(input:StructuredCoverageReceipt):StructuredPublicCoverageReceipt{
 const row=structuredCoverageReceiptSchema.parse(input),{coverage,...identity}=row;
 return structuredPublicCoverageReceiptSchema.parse({...identity,coverage:{state:coverage.state,checkedAt:coverage.checkedAt,observedRows:coverage.observedRows,reasonCode:`source_reported_${coverage.state}`,caveat:publicCoverageCaveat,diagnosticSha256:semanticHash(coverage)}});
}
export const structuredRunSchema=z.object({schemaVersion:z.literal('district-structured-run-v1'),generatedAt:z.iso.datetime(),registrySha256:HashSchema,questionDispositionSha256:HashSchema,adapterContractSha256:HashSchema,records:z.array(StructuredKnowledgeRecordSchema),coverage:z.array(structuredCoverageReceiptSchema)}).strict().superRefine((run,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 const recordIds=new Set<string>(),receiptIds=new Set<string>();
 for(const receipt of run.coverage){
  const key=structuredReceiptKey(receipt);
  if(receiptIds.has(key))fail('Duplicate structured coverage receipt');receiptIds.add(key);
  if(receipt.coverage.state==='not_checked'&&receipt.coverage.checkedAt!==null)fail('Unchecked structured coverage cannot claim an observation clock');
  if(receipt.coverage.state!=='not_checked'&&receipt.coverage.checkedAt===null)fail('Checked structured coverage requires an observation clock');
 }
 for(const record of run.records){
  if(recordIds.has(record.id))fail('Duplicate structured run record');recordIds.add(record.id);
  const receipts=run.coverage.filter(receipt=>structuredReceiptMatches(record,receipt));
  if(receipts.length!==1||!receipts[0].stepReceiptSha256||!['complete','partial'].includes(receipts[0].coverage.state))fail('Structured record lacks its actual admitted parser coverage receipt');
 }
});
export type StructuredRun=z.infer<typeof structuredRunSchema>;
export type StructuredCoverageReceipt=z.infer<typeof structuredCoverageReceiptSchema>;
export function structuredReceiptKey(receipt:Omit<StructuredCoverageReceipt,'coverage'>):string{return JSON.stringify([receipt.family,receipt.operation,receipt.adapterId,receipt.adapterVersion,receipt.municipalityId,receipt.sourceId,receipt.scopeSha256,receipt.sourceSha256]);}
export function structuredReceiptMatches(record:StructuredKnowledgeRecord,receipt:Omit<StructuredCoverageReceipt,'coverage'>):boolean{
 return receipt.operation==='parse'&&receipt.municipalityId===record.municipalityId&&receipt.sourceId===record.source.id&&receipt.sourceSha256===record.source.sha256&&receipt.scopeSha256===record.verification.scopeSha256&&receipt.policyReceiptSha256===record.verification.policyReceiptSha256&&receipt.adapterId===record.verification.adapterId&&receipt.adapterVersion===record.verification.mappingVersion;
}
export function validateStructuredRun(run:StructuredRun,registry:DistrictRegistry,records:readonly StructuredKnowledgeRecord[],registrySha256?:string){
 structuredRunSchema.parse(run);
 if(registrySha256!==undefined&&run.registrySha256!==registrySha256)throw Error('Structured run registry byte binding mismatch');
 const originals=new Map(run.records.map(record=>[record.id,canonicalJson(record)]));
 if(records.some(record=>originals.get(record.id)!==canonicalJson(record)))throw Error('Published structured record differs from bound structured run');
 for(const receipt of run.coverage){
  const city=registry.municipalities.find(city=>city.id===receipt.municipalityId);
  if(!city||!city.sources.some(source=>source.id===receipt.sourceId))throw Error('Structured coverage municipality/source registry binding mismatch');
 }
 for(const record of run.records){
  const city=registry.municipalities.find(city=>city.id===record.municipalityId);
  if(!city||city.ags!==record.ags||city.districtId!==record.districtId||!city.sources.some(source=>source.id===record.source.id&&source.url!==null&&source.checkState==='checked'))throw Error('Structured record municipality/source registry binding mismatch');
 }
}
/** Native reference/publication dates qualify attributed observations, never action-stage completeness. */
export function structuredRecordHasSourcedDate(record:StructuredKnowledgeRecord):boolean{
 return record.observation.date!==null||record.observation.sourceReferenceDate!==null||record.observation.publishedAt!==null||record.graph.relations.some(relation=>relation.eventDate!==null);
}
const actionEventRoles:Record<string,readonly string[]>={decides:['decides','decision','adoption'],approves:['approves','approval','award_decision'],implements:['implements','implementation','commissioning'],amends:['amends','amendment'],adopts:['adopts','adoption'],authorizes:['authorizes','permit_issued'],awarded_to:['awarded_to','award_decision'],paid_to:['paid_to','payment']};
export function structuredRecordHasSourcedAction(record:StructuredKnowledgeRecord):boolean{
 const observation=record.observation;
 if(observation.kind==='Resolution'&&observation.predicate==='adopts_plan'&&observation.dateRole==='adoption'&&identityDaySchema.safeParse(observation.date).success)return true;
 return record.graph.relations.some(relation=>relation.modality==='asserted'&&relation.eventDateRole!==null&&actionEventRoles[relation.predicate]?.includes(relation.eventDateRole)===true&&identityDaySchema.safeParse(relation.eventDate).success);
}

/** Operational coverage is backed by original committed receipts and exact sandbox output artifacts. */
export async function verifyStructuredRunReceipts(run:StructuredRun,cas:DistrictCas,options:CivicPolicyOptions&{evaluationAt:string;currentAdmissionReceipts?:Readonly<Record<string,string>>}):Promise<{dependencySha256:string}>{
 structuredRunSchema.parse(run);
 const contracts=new Set<string>(),dependencies=new Set<string>(),verifiedRecords=new Set<string>();
 for(const row of run.coverage){
  const hashes=row.stepReceiptSha256?[row.stepReceiptSha256,...row.additionalStepReceiptSha256s]:row.additionalStepReceiptSha256s;
  const expectedRecords=run.records.filter(record=>structuredReceiptMatches(record,row));
  if(!row.stepReceiptSha256){
   if(hashes.length||expectedRecords.length||['complete','partial','empty','not_applicable'].includes(row.coverage.state))throw Error('Operational structured coverage requires actual step receipts');
   continue;
  }
  if(new Set(hashes).size!==hashes.length)throw Error('Duplicate structured page step receipt');
  const outputs:StructuredJobResult[]=[];
  for(const hash of hashes){
   const bytes=await cas.read(hash),receipt=StepReceiptSchema.parse(JSON.parse(bytes.toString('utf8')));
   if(digest(canonicalJson(receipt))!==hash||receipt.sourceId!==row.sourceId||receipt.municipalityId!==row.municipalityId||receipt.step!==`structured_${row.operation}`||receipt.provider!==null||receipt.policyProofSha256!==row.policyReceiptSha256)throw Error('Structured committed receipt source binding mismatch');
   dependencies.add(hash);
   if(!receipt.outputHashes.length){
    const state=structuredCoverageStateForNoOutput(receipt.outcome);
    if(expectedRecords.length||row.coverage.state!==state||row.coverage.checkedAt!==(state==='not_checked'?null:receipt.finishedAt)||row.coverage.observedRows!==0||row.coverage.nextCursor!==null||row.adapterVersion!==null)throw Error('Missing structured output cannot change its actual committed technical outcome');
    continue;
   }
   if(receipt.outputHashes.length!==1||!row.sourceSha256||!row.policyReceiptSha256||!receipt.inputHashes.includes(row.sourceSha256)||!receipt.inputHashes.includes(row.policyReceiptSha256))throw Error('Structured parser input/output binding mismatch');
   const policy=await loadPolicyReceipt(cas,row.policyReceiptSha256),currentHash=options.currentAdmissionReceipts?.[row.policyReceiptSha256],currentProof=currentHash?await loadPolicyReceipt(cas,currentHash):undefined;
   if(policy.source.sha256!==row.sourceSha256||semanticHash(policy.scope)!==row.scopeSha256||policy.scope.sourceId!==row.sourceId||policy.scope.municipalityId!==row.municipalityId)throw Error('Structured parser policy scope mismatch');
   await recheckPolicyReceipt(policy,{...options,...(currentProof?{currentProof}:{})});
   await cas.verify(row.sourceSha256);
   const outputHash=receipt.outputHashes[0],output=StructuredJobResultSchema.parse(JSON.parse((await cas.read(outputHash)).toString('utf8')));
   dependencies.add(outputHash);contracts.add(output.adapterContractSha256);
   if(output.sourceSha256!==row.sourceSha256||output.policyReceiptSha256!==row.policyReceiptSha256||semanticHash(output.scope)!==row.scopeSha256||output.adapterId!==row.adapterId||output.adapterVersion!==row.adapterVersion||receipt.versions.worker!==STRUCTURED_WORKER_VERSION||receipt.versions.adapter!==output.adapterVersion||receipt.versions.parser!==output.parserContractSha256||receipt.versions.host!==output.hostContractSha256)throw Error('Structured sandbox contract binding mismatch');
   for(const source of output.supportingSources){
    if(!receipt.inputHashes.includes(source.sha256)||!receipt.inputHashes.includes(source.policyReceiptSha256))throw Error('Unbound supporting parser input');
    const proof=await loadPolicyReceipt(cas,source.policyReceiptSha256),freshHash=options.currentAdmissionReceipts?.[source.policyReceiptSha256],fresh=freshHash?await loadPolicyReceipt(cas,freshHash):undefined;
    if(proof.source.sha256!==source.sha256||proof.source.url!==source.url||proof.source.mimeType!==source.mimeType||semanticHash(proof.scope)!==source.scopeSha256)throw Error('Supporting parser policy binding mismatch');
    await recheckPolicyReceipt(proof,{...options,...(fresh?{currentProof:fresh}:{})});await cas.verify(source.sha256);
   }
   if(receipt.counts.rows!==output.result.coverage.observedRows||receipt.counts.acceptedFacts!==output.records.length||'observations' in output.result&&output.unpublishedObservations!==output.result.observations.length-output.records.length)throw Error('Structured parser receipt counts mismatch');
   const operational=['complete','partial','empty','not_applicable'].includes(output.result.coverage.state);
   if(operational!==(receipt.outcome==='succeeded')||!operational&&output.records.length)throw Error('Structured parser outcome provenance mismatch');
   if(receipt.step==='structured_discover'&&output.records.length||receipt.step==='structured_parse'&&!('observations' in output.result))throw Error('Structured parser operation mismatch');
   if('observations' in output.result){
    const observations=new Map(output.result.observations.map(observation=>[observation.id,canonicalJson(observation)]));
    for(const record of output.records){
     if(record.verification.adapterContractSha256!==output.adapterContractSha256||canonicalJson(record.supportingSources)!==canonicalJson(output.supportingSources)||observations.get(record.observation.id)!==canonicalJson(record.observation))throw Error('Structured record differs from actual sandbox output');
    }
   }
   outputs.push(output);
  }
  if(!outputs.length)continue;
  const paged=outputs.filter(output=>output.page!==null);
  if(paged.length&&paged.length!==outputs.length)throw Error('Cannot mix paged and unpaged structured output');
  let actualCoverage=outputs[0].result.coverage;
  if(paged.length){
   const pages=paged.map(output=>output.page!).sort((a,b)=>a.offset-b.offset),first=pages[0];
   let end=0,contiguous=true;
   for(const page of pages){
    if(page.bindingSha256!==first.bindingSha256||page.total!==first.total||canonicalJson(page.sourceCoverage)!==canonicalJson(first.sourceCoverage)||page.offset<end)throw Error('Structured output pages have incompatible binding, source coverage or overlapping rows');
    if(page.offset!==end)contiguous=false;
    end=page.end;
   }
   const complete=contiguous&&end===first.total;
   if(!complete&&row.coverage.state!=='partial')throw Error('Incomplete structured pages cannot claim complete coverage');
   actualCoverage=complete?first.sourceCoverage:{...first.sourceCoverage,state:'partial',nextCursor:pages.at(-1)!.nextCursor};
   if(canonicalJson(row.coverage)!==canonicalJson(actualCoverage))throw Error('Structured page coverage binding mismatch');
  }else if(outputs.length!==1||canonicalJson(row.coverage)!==canonicalJson(actualCoverage))throw Error('Structured coverage differs from actual parser result');
  const originals=new Map<string,string>();
  for(const output of outputs)for(const record of output.records){if(originals.has(record.id))throw Error('Duplicate structured record across actual pages');originals.set(record.id,canonicalJson(record));}
  if(originals.size!==expectedRecords.length||expectedRecords.some(record=>originals.get(record.id)!==canonicalJson(record)))throw Error('Structured run records differ from actual committed parser results');
  for(const record of expectedRecords){verifiedRecords.add(record.id);contracts.add(record.verification.adapterContractSha256);}
 }
 if(verifiedRecords.size!==run.records.length)throw Error('Unverified structured run record');
 if(run.adapterContractSha256!==semanticHash([...contracts].sort()))throw Error('Structured run adapter contract aggregate mismatch');
 return {dependencySha256:semanticHash([...dependencies].sort())};
}
