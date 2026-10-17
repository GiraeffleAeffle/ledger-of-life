import {readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {HashSchema,ScopeSchema,canonicalJson,digest} from './district-adapter-contract.ts';
import {DistrictExecutionHold,canonicalJobIdentity,type DistrictJobSpec} from './district-jobs.ts';
import {encodeStepReceipt,type StepReceipt} from './district-step-receipt.ts';
import {guardDistrictPool} from './district-database.ts';
import {assertCivicPolicyAuthority,type CivicPolicyOptions} from './civic-opt-out.ts';
import * as assessmentQueue from './district-assessment-jobs.ts';

const PARENT='2ac6267d17ed08452665a0b2de92ec4da89915fe8619b668b85585301327502b';
const DELEGATION='a527b02f4fd04487cf9eeb7314f539d83fd841cf0422cc8c2f69e411dd1d369f';
const COHORT='24c8629ec588f4898988c7ee7a61eb7e7b2809d0b0ab052fc34669512e789965';
export const CODEX_ASSESSMENT_ALLOWANCE_PIN=Object.freeze({id:'r1-codex-assessment-allowance-2026-10-17-r5',sha256:'12f110244241e0294148cafc5fe13319b627b692136dfbfe18d61022f5e9b7d2'});
const APPROVALS=new URL('../reports/approvals/',import.meta.url);
const ApprovalPinSchema=z.object({id:z.string(),sha256:HashSchema}).strict();
export const CodexAssessmentAllowanceSchema=z.object({
 schemaVersion:z.literal('r1-codex-assessment-allowance-v1'),id:z.literal('r1-codex-assessment-allowance-2026-10-17-r5'),issuedBy:z.literal('R1 VM lead (omp session in tmux on codex-workstation)'),issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
 parentApproval:ApprovalPinSchema.extend({id:z.literal('r1-nine-town-models-2026-10-13'),sha256:z.literal(PARENT)}),
 delegationApproval:ApprovalPinSchema.extend({id:z.literal('r1-b-model-sonnet-2026-10-17'),sha256:z.literal(DELEGATION)}),
 cohort:z.object({path:z.literal('stadtstack-data/reports/approvals/r1-frozen-assessment-cohort-2026-10-17.json'),sha256:HashSchema}).strict(),
 assessment:z.object({projectionVersion:z.literal('assessment-source-record-v2'),queueContractSha256:HashSchema,steps:z.tuple([z.literal('assessment_a'),z.literal('assessment_c')])}).strict(),
 bounds:z.object({baseMaxCallsPerOriginal:z.literal(48),maxExtraCallsPerOriginal:z.literal(24),maxExtraCallsCohort:z.literal(100),provider:z.literal('openai-subscription'),paidMicroUsd:z.literal(0),normalSubscriptionOnly:z.literal(true)}).strict(),scope:z.string().min(1)
}).strict().refine(record=>Date.parse(record.issuedAt)<Date.parse(record.expiresAt)&&Date.parse(record.expiresAt)<=Date.parse('2026-10-25T21:59:59Z'),'Allowance exceeds delegated lifetime');
const MemberSchema=z.object({source:z.string(),corpusSha256:HashSchema,documentId:z.string(),originalSha256:HashSchema,scope:ScopeSchema}).strict();
export const CohortSchema=z.object({schemaVersion:z.literal('r1-nine-town-frozen-assessment-cohort-v1'),purpose:z.string(),parentApproval:z.object({path:z.string(),sha256:z.literal(PARENT)}).strict(),catalogueSha256:HashSchema,sourceCount:z.number().int().positive(),documentCount:z.number().int().positive(),uniqueOriginalCount:z.number().int().positive(),sources:z.array(z.object({source:z.string(),corpusSha256:HashSchema,scope:ScopeSchema,documentCount:z.number().int().nonnegative()}).strict()),documents:z.array(MemberSchema)}).strict();
const PinSchema=z.object({jobKey:HashSchema,receiptId:z.uuid(),receiptSha256:HashSchema}).strict();
const PassSchema=z.object({version:z.literal('r1-assessment-pass-job-v1'),itemArtifactSha256:HashSchema,recordArtifactSha256:HashSchema,maxModelCalls:z.number().int().min(2).max(48),predecessors:z.array(PinSchema),AJobKey:HashSchema.optional(),BJobKey:HashSchema.optional(),CJobKey:HashSchema.optional()}).strict();
const PrepareSchema=z.object({version:z.literal('r1-assessment-item-job-v1'),extraction:PinSchema,extractionArtifactSha256:HashSchema}).strict();
const ResidualIdentitySchema=z.object({documentId:z.string(),corpusSha256:HashSchema,policyReceiptSha256:HashSchema,corpusObservations:z.array(z.object({sourceSha256:HashSchema}).passthrough()).min(1)}).passthrough();
type QueryClient=Pick<PoolClient,'query'>;
type Allowance=z.infer<typeof CodexAssessmentAllowanceSchema>;
type Cohort=z.infer<typeof CohortSchema>;
type JobRow={id:string;job_key:string;spec:DistrictJobSpec;created_at:Date;state:string};
type Committed=JobRow&{receipt:StepReceipt;pin:z.infer<typeof PinSchema>};
export interface CodexAllowanceFixture {policy:CivicPolicyOptions;recordBytes:Buffer|null;cohortBytes:Buffer}
export interface CodexAllowanceOptions {fixture?:CodexAllowanceFixture}
interface LoadedAllowance {record:Allowance;cohort:Cohort;pin:{id:string;sha256:string};originals:string[];observedAt:string}
export interface CodexCallCapacity {originalSha256:string;baseMaxCalls:number;lifetimeCalls:number;lifetimeExtraCalls:number;baseRemaining:number;extraRemaining:number;allowed:boolean;allowanceEligible:boolean;allowancePin:{id:string;sha256:string}|null;allowanceExpiresAt:string|null;allowanceCohortSha256:string|null;allowanceQueueContractSha256:string|null;cohortExtraCalls:number|null;cohortExtraRemaining:number|null}

function refused():never{throw new DistrictExecutionHold('source_limit_exceeded');}
function requireCondition(value:unknown):asserts value{if(!value)refused();}
async function pinnedBytes(name:string,sha256:string){const bytes=await readFile(new URL(name,APPROVALS));requireCondition(digest(bytes)===sha256);return bytes;}
async function loadAllowance(client:QueryClient,options:CodexAllowanceOptions):Promise<LoadedAllowance|null>{
 let recordBytes:Buffer,cohortBytes:Buffer,pin:{id:string;sha256:string};
 if(options.fixture){
  requireCondition((await assertCivicPolicyAuthority(options.fixture.policy)).mode==='isolated-fixture');
  if(options.fixture.recordBytes===null)return null;
  recordBytes=options.fixture.recordBytes;cohortBytes=options.fixture.cohortBytes;pin={id:CODEX_ASSESSMENT_ALLOWANCE_PIN.id,sha256:digest(recordBytes)};
 }else{
  try{
   recordBytes=await pinnedBytes(CODEX_ASSESSMENT_ALLOWANCE_PIN.id+'.json',CODEX_ASSESSMENT_ALLOWANCE_PIN.sha256);
   await pinnedBytes('r1-nine-town-models-2026-10-13.json',PARENT);await pinnedBytes('r1-b-model-sonnet-2026-10-17.json',DELEGATION);
   cohortBytes=await pinnedBytes('r1-frozen-assessment-cohort-2026-10-17.json',COHORT);pin=CODEX_ASSESSMENT_ALLOWANCE_PIN;
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 }
 const record=CodexAssessmentAllowanceSchema.parse(JSON.parse(recordBytes.toString('utf8'))),cohort=CohortSchema.parse(JSON.parse(cohortBytes.toString('utf8'))),originals=[...new Set(cohort.documents.map(member=>member.originalSha256))];
 requireCondition(record.cohort.sha256===digest(cohortBytes)&&(!options.fixture?record.cohort.sha256===COHORT:true));
 requireCondition(cohort.sourceCount===cohort.sources.length&&cohort.documentCount===cohort.documents.length&&cohort.uniqueOriginalCount===originals.length);
 const identities=new Set<string>(),sourceCounts=new Map<string,{expected:number;actual:number}>();
 for(const source of cohort.sources){const key=canonicalJson([source.source,source.corpusSha256,source.scope]);requireCondition(!sourceCounts.has(key));sourceCounts.set(key,{expected:source.documentCount,actual:0});}
 for(const member of cohort.documents){
  const identity=canonicalJson([member.source,member.corpusSha256,member.documentId,member.scope]);requireCondition(!identities.has(identity));identities.add(identity);
  const source=sourceCounts.get(canonicalJson([member.source,member.corpusSha256,member.scope]));requireCondition(source);source.actual++;
 }
 for(const source of sourceCounts.values())requireCondition(source.actual===source.expected);
 const clock=await client.query<{now:Date}>('SELECT clock_timestamp() AS now'),now=clock.rows[0].now.getTime();
 requireCondition(Date.parse(record.issuedAt)<=now&&now<Date.parse(record.expiresAt));
 requireCondition(record.assessment.queueContractSha256===await assessmentQueue.assessmentQueueContract());
 // A declared version in an approval is not a producer capability. The real
 // v2 reconstruction export must exist in production; only a provisioned
 // isolated fixture may model that attested producer on the legacy base.
 requireCondition(options.fixture||('reconstructResidualAssessmentItem' in assessmentQueue&&typeof assessmentQueue.reconstructResidualAssessmentItem==='function'));
 return {record,cohort,pin,originals,observedAt:clock.rows[0].now.toISOString()};
}
async function jobRow(client:QueryClient,jobKey:string):Promise<JobRow>{
 HashSchema.parse(jobKey);const result=await client.query<JobRow>('SELECT id,job_key,spec,created_at,state FROM district_pipeline.jobs WHERE job_key=$1',[jobKey]);requireCondition(result.rows.length===1);const row=result.rows[0];requireCondition(canonicalJobIdentity(row.spec).jobKey===jobKey);return row;
}
async function committed(client:QueryClient,pin:z.infer<typeof PinSchema>,step:string):Promise<Committed>{
 const row=await jobRow(client,pin.jobKey);requireCondition(row.spec.step===step&&row.state==='succeeded');
 const result=await client.query<{receipt:StepReceipt;receipt_sha256:string}>('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE id=$1 AND job_id=$2 AND outcome=$3',[pin.receiptId,row.id,'succeeded']);requireCondition(result.rows.length===1);
 const stored=result.rows[0],encoded=encodeStepReceipt(stored.receipt);requireCondition(encoded.sha256===pin.receiptSha256&&encoded.sha256===stored.receipt_sha256&&encoded.receipt.id===pin.receiptId&&encoded.receipt.jobKey===row.job_key&&encoded.receipt.step===step&&encoded.receipt.policyProofSha256===row.spec.policyProofSha256);
 requireCondition(encoded.receipt.outcome==='succeeded'&&encoded.receipt.sourceId===row.spec.sourceScope.sourceId&&encoded.receipt.municipalityId===row.spec.sourceScope.municipalityId&&encoded.receipt.inputHashes.length===row.spec.inputArtifactHashes.length&&encoded.receipt.inputHashes.every(hash=>row.spec.inputArtifactHashes.includes(hash)));
 return {...row,receipt:encoded.receipt,pin};
}
async function dependencies(client:QueryClient,row:JobRow|Committed,pins:z.infer<typeof PinSchema>[]){
 const result=await client.query<{job_key:string;expected_receipt_sha256:string|null}>('SELECT p.job_key,d.expected_receipt_sha256 FROM district_pipeline.job_dependencies d JOIN district_pipeline.jobs p ON p.id=d.predecessor_job_id WHERE d.job_id=$1 ORDER BY p.job_key',[row.id]);
 const expected=pins.map(pin=>({job_key:pin.jobKey,expected_receipt_sha256:pin.receiptSha256})).sort((a,b)=>a.job_key.localeCompare(b.job_key));requireCondition(canonicalJson(result.rows)===canonicalJson(expected));
 if('receipt' in row)requireCondition(row.receipt.dependencyReceiptIds.length===pins.length&&pins.every(pin=>row.receipt.dependencyReceiptIds.includes(pin.receiptId)));
}
function sameSource(a:DistrictJobSpec,b:DistrictJobSpec){requireCondition(a.policyProofSha256!==null&&a.policyProofSha256===b.policyProofSha256&&canonicalJson(a.sourceScope)===canonicalJson(b.sourceScope));}
/** The pinned v2 prepare producer attests the full source-record snapshot. This
 * deliberately reads no CAS or authority inventory: preflight is SELECT-only.
 * Actual A/C handlers additionally reopen/reconstruct that snapshot before reserve. */
async function eligibleOriginal(client:QueryClient,row:JobRow,loaded:LoadedAllowance):Promise<string>{
 const {record,cohort}=loaded;requireCondition((row.spec.step==='assessment_a'||row.spec.step==='assessment_c')&&row.spec.semanticContractSha256===record.assessment.queueContractSha256&&row.created_at.getTime()>=Date.parse(record.issuedAt));
 let selector=PassSchema.parse(row.spec.selector),A=row;requireCondition(selector.maxModelCalls===48&&row.spec.inputArtifactHashes.includes(selector.itemArtifactSha256)&&row.spec.inputArtifactHashes.includes(selector.recordArtifactSha256));
 await dependencies(client,row,selector.predecessors);
 if(row.spec.step==='assessment_c'){
  requireCondition(selector.AJobKey&&selector.BJobKey&&!selector.CJobKey&&selector.predecessors.length===2);
  const aPin=selector.predecessors.find(pin=>pin.jobKey===selector.AJobKey),bPin=selector.predecessors.find(pin=>pin.jobKey===selector.BJobKey);requireCondition(aPin&&bPin);
  A=await committed(client,aPin,'assessment_a');const B=await committed(client,bPin,'assessment_b');sameSource(row.spec,A.spec);sameSource(row.spec,B.spec);
  const previous=PassSchema.parse(A.spec.selector);requireCondition(previous.itemArtifactSha256===selector.itemArtifactSha256&&previous.recordArtifactSha256===selector.recordArtifactSha256);selector=previous;
  requireCondition(A.created_at.getTime()>=Date.parse(record.issuedAt)&&A.spec.semanticContractSha256===record.assessment.queueContractSha256);await dependencies(client,A,selector.predecessors);
 }
 requireCondition(selector.maxModelCalls===48&&selector.predecessors.length===1&&!selector.AJobKey&&!selector.BJobKey&&!selector.CJobKey);
 const preparation=await committed(client,selector.predecessors[0],'assessment_prepare');sameSource(A.spec,preparation.spec);
 requireCondition(preparation.spec.semanticContractSha256===record.assessment.queueContractSha256&&preparation.receipt.outputHashes.includes(selector.itemArtifactSha256)&&preparation.receipt.outputHashes.includes(selector.recordArtifactSha256));
 const prepare=PrepareSchema.parse(preparation.spec.selector);await dependencies(client,preparation,[prepare.extraction]);
 const extraction=await committed(client,prepare.extraction,'residual_extract');sameSource(preparation.spec,extraction.spec);
 requireCondition(extraction.receipt.outputHashes.includes(prepare.extractionArtifactSha256)&&preparation.spec.inputArtifactHashes.includes(prepare.extractionArtifactSha256));
 const residual=ResidualIdentitySchema.parse(extraction.spec.selector);requireCondition(residual.policyReceiptSha256===extraction.spec.policyProofSha256);
 const scope=canonicalJson(row.spec.sourceScope),member=cohort.documents.find(candidate=>candidate.source===row.spec.sourceScope.sourceId&&candidate.documentId===residual.documentId&&candidate.corpusSha256===residual.corpusSha256&&canonicalJson(candidate.scope)===scope);requireCondition(member&&residual.corpusObservations.some(observation=>observation.sourceSha256===member.originalSha256));
 return member.originalSha256;
}
async function cohortUsage(client:QueryClient,loaded:LoadedAllowance){
 const counts=await client.query<{original_sha256:string;total:string;attributed:string}>(`SELECT i.original_sha256,count(*) AS total,(SELECT count(*) FROM district_pipeline.r1_codex_allowance_intents a WHERE a.original_sha256=i.original_sha256) AS attributed FROM district_pipeline.r1_codex_call_intents i WHERE i.original_sha256=ANY($1::text[]) GROUP BY i.original_sha256`,[loaded.originals]);
 let total=0;for(const row of counts.rows){const excess=Math.max(0,Number(row.total)-48);requireCondition(excess<=24&&Number(row.attributed)===excess);total+=excess;}
 requireCondition(total<=100);
 // Attribution is append-only and records the actual pre-effect admission,
 // never an inference from UUID order, wall clocks or the current approval epoch.
 // Reissued records cannot erase historical failed/ambiguous allowance charges.
 const inconsistent=await client.query(`SELECT 1 FROM district_pipeline.r1_codex_allowance_intents a JOIN district_pipeline.r1_codex_call_intents i ON i.id=a.intent_id JOIN district_pipeline.jobs j ON j.id=i.job_id LEFT JOIN district_pipeline.r1_codex_call_authorizations c ON c.intent_id=i.id WHERE (a.cohort_sha256=$2 AND NOT a.original_sha256=ANY($1::text[])) OR (a.original_sha256=ANY($1::text[]) AND (a.cohort_sha256<>$2 OR a.original_sha256<>i.original_sha256 OR i.stage NOT IN ('assessment_a','assessment_c') OR j.step<>i.stage OR i.paid_micro_usd<>0 OR j.semantic_contract_sha256<>a.queue_contract_sha256 OR j.spec->>'semanticContractSha256'<>a.queue_contract_sha256 OR c.intent_id IS NULL)) LIMIT 1`,[loaded.originals,loaded.record.cohort.sha256]);requireCondition(!inconsistent.rowCount);
 return total;
}
/** Caller holds 18441/81 for admission; read-only preflight uses the identical
 * validator on one repeatable-read snapshot. This does not reserve capacity. */
export async function codexCallCapacity(client:QueryClient,jobKey:string,originalSha256:string,maxCalls:number,options:CodexAllowanceOptions={},checkEligibility=false):Promise<CodexCallCapacity>{
 HashSchema.parse(originalSha256);requireCondition(Number.isInteger(maxCalls)&&maxCalls>=2&&maxCalls<=48);
 const stored=await client.query<{max_calls:number;count:string}>('SELECT d.max_calls,(SELECT count(*) FROM district_pipeline.r1_codex_call_intents i WHERE i.original_sha256=d.original_sha256) AS count FROM district_pipeline.r1_codex_documents d WHERE d.original_sha256=$1',[originalSha256]);
 const baseMaxCalls=Math.min(maxCalls,stored.rows[0]?.max_calls??maxCalls),lifetimeCalls=Number(stored.rows[0]?.count??0),baseRemaining=Math.max(0,baseMaxCalls-lifetimeCalls);
 const result:CodexCallCapacity={originalSha256,baseMaxCalls,lifetimeCalls,lifetimeExtraCalls:Math.max(0,lifetimeCalls-48),baseRemaining,extraRemaining:0,allowed:baseRemaining>0,allowanceEligible:false,allowancePin:null,allowanceExpiresAt:null,allowanceCohortSha256:null,allowanceQueueContractSha256:null,cohortExtraCalls:null,cohortExtraRemaining:null};
 if(baseMaxCalls!==48||(!checkEligibility&&baseRemaining>0))return result;
 const row=await jobRow(client,jobKey);if(row.spec.step!=='assessment_a'&&row.spec.step!=='assessment_c')return result;
 try{
  const loaded=await loadAllowance(client,options);if(!loaded)return result;
  requireCondition(await eligibleOriginal(client,row,loaded)===originalSha256);
  const used=await cohortUsage(client,loaded);result.allowanceEligible=true;result.allowancePin=loaded.pin;result.allowanceExpiresAt=loaded.record.expiresAt;result.allowanceCohortSha256=loaded.record.cohort.sha256;result.allowanceQueueContractSha256=loaded.record.assessment.queueContractSha256;result.cohortExtraCalls=used;result.cohortExtraRemaining=Math.max(0,100-used);result.extraRemaining=Math.max(0,Math.min(24-result.lifetimeExtraCalls,100-used));result.allowed=baseRemaining>0||result.extraRemaining>0;return result;
 }catch(error){if(error instanceof z.ZodError)throw new DistrictExecutionHold('source_limit_exceeded',{cause:error});throw error;}
}
export async function codexAssessmentAllowancePreflight(pool:Pool,jobKeys:readonly string[],authenticatedPin:Readonly<{id:string;sha256:string}>,options:CodexAllowanceOptions={}){
 guardDistrictPool(pool);requireCondition(jobKeys.length>0&&new Set(jobKeys).size===jobKeys.length);
 const client=await pool.connect();try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const loaded=await loadAllowance(client,options);requireCondition(loaded&&canonicalJson(loaded.pin)===canonicalJson(authenticatedPin));
  const jobs:{jobKey:string;capacity:CodexCallCapacity}[]=[];
  for(const jobKey of jobKeys){const row=await jobRow(client,jobKey),original=await eligibleOriginal(client,row,loaded),capacity=await codexCallCapacity(client,jobKey,original,48,options,true);requireCondition(capacity.allowanceEligible&&capacity.allowed);jobs.push({jobKey,capacity});}
  const cohortExtraCalls=await cohortUsage(client,loaded);
  await client.query('COMMIT');return {observedAt:loaded.observedAt,allowancePin:loaded.pin,bounds:loaded.record.bounds,cohort:{uniqueOriginalCount:loaded.originals.length,extraCalls:cohortExtraCalls,extraRemaining:100-cohortExtraCalls},jobs};
 }catch(error){await client.query('ROLLBACK');if(error instanceof z.ZodError)throw new DistrictExecutionHold('source_limit_exceeded',{cause:error});throw error;}finally{client.release();}
}
