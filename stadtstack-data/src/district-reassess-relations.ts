import {readFile, lstat} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {DistrictKnowledgeRecordSchema, DistrictExtractionClaimsSchema, hashSchema, sha256, knowledgeEvidenceHash, REQUIRED_DETERMINISTIC_CHECKS, type DistrictKnowledgeRecord, type DistrictExtractionClaims} from './district-schema.ts';
import {normalizeRelationActions, normalizeGraphClaims, GRAPH_DETERMINISTIC_CHECKS, type RelationActionNormalization} from './district-graph-claims.ts';
import {restoreSourceQuotes, deterministicChecks, extractionOutputSchema, judgeSchema, judgeJSONSchema, JUDGE_INSTRUCTIONS, JUDGE_PROMPT_VERSION, JUDGE_PROMPT_SHA256, LIMITATION, type DocumentChunk} from './district-claims.ts';
import {documentResultSchema, type DocumentResult} from './district-inference.ts';
import {preparationPlanSchema, type PreparationPlan} from './district-preparation-run.ts';
import {WorkPlanSchema, restoreWorkPlan, classifyWorkFailure, WorkFailureSchema, type WorkPlan, type WorkTask} from './district-work-plan.ts';
import {verifyPreparedDocument, readPreparedDocument, assertPreparedSourcesActive, assertPreparedReferenceMembership, preparedSourceBindings, preparedCacheContext, type PreparedDocument, type PreparedSourceReference} from './district-prepared-document.ts';
import {writeManagedSourceJson, writeManagedSourceArtifact, readPinnedJson, acquirePrivateRunLock} from './district-private-io.ts';
import {modelReadiness, subscriptionChat} from './district-model.ts';
import {isProviderStopped} from './district-model-usage.ts';
import {PROVIDER_CONFIGS, ModelEvidenceSchema, assertModelEvidenceIdentity, SubscriptionRuntimeError, type ExtractorProvider, type ModelEvidence, type ModelAnswer, type UsageContext} from './district-model-contract.ts';
import {CIVIC_POLICY_AUTHORITY,CIVIC_ACQUISITION_DECISION_ID,assertCivicPolicyAuthority,assertHostNotOptedOut,assertManagedSourceBindings,parseContentFreePreparationPlan,initializeManagedAcquisitionLane,HostOptedOutError,CivicPolicyStateError,type CivicPolicyOptions,type ManagedSourceContext} from './civic-opt-out.ts';
import {modelAnswerCacheBinding} from './district-answer-cache.ts';
import {knowledgePreparedSourcePinSchema,type KnowledgePreparedSourcePin} from './prepare-knowledge.ts';
import {artifactBindingSchema} from './district-publication-provenance.ts';

// These artifacts are private replay evidence, not public source-text exports.
export const REASSESSMENT_VERSION = 'district-relation-reassessment-v2';
const Provider = z.enum(['openai-subscription', 'anthropic-subscription']);
const Identity = ModelEvidenceSchema;
const Blob = z.object({sha256:hashSchema, bytes:z.string()}).strict();
type Blob = z.infer<typeof Blob>;
const AnswerBody = z.object({binding:hashSchema, modelIdentitySha256:hashSchema, receivedAt:z.iso.datetime(), value:z.unknown(), responseSha256:hashSchema, returnedModel:z.string().nullable(), runtimeWarnings:z.array(z.string())}).strict();
export const ReassessmentAnswerSchema = AnswerBody.extend({cacheSha256:hashSchema}).strict();
type Answer = z.infer<typeof ReassessmentAnswerSchema>;
const Contract = z.object({version:z.literal(REASSESSMENT_VERSION), judgePromptVersion:z.string(), judgePromptSha256:hashSchema, judgeSchemaSha256:hashSchema, assessorSha256:hashSchema, threshold:z.literal(0.8)}).strict();
export type ReassessmentContract = z.infer<typeof Contract>;
const FrozenBodySchema = z.object({
  frozenAt:z.iso.datetime(),workPlan:Blob,preparationPlan:Blob,
  documents:z.array(z.object({taskId:hashSchema,result:Blob,prepared:Blob}).strict()),answers:z.array(Blob),
}).strict();
/** Pure historical codec only; never accepted by current filesystem/model entrypoints. */
export const HistoricalFrozenReassessmentSchema=FrozenBodySchema.extend({version:z.literal('district-relation-reassessment-v1'),contract:Contract.extend({version:z.literal('district-relation-reassessment-v1')})}).strict();
export const reassessmentArtifactPinSchema=z.object({path:z.string().min(1),sha256:hashSchema,bytes:z.number().int().nonnegative().max(512*1024*1024),bindings:z.array(artifactBindingSchema).min(1)}).strict();
export type ReassessmentArtifactPin=z.infer<typeof reassessmentArtifactPinSchema>;
const ControlBindingsSchema=z.object({workPlan:z.array(reassessmentArtifactPinSchema.shape.bindings.element).max(100_000),preparationPlan:z.array(reassessmentArtifactPinSchema.shape.bindings.element).max(100_000)}).strict();
export const FrozenReassessmentSchema=FrozenBodySchema.extend({version:z.literal(REASSESSMENT_VERSION),contract:Contract,controlBindings:ControlBindingsSchema}).strict();
export type FrozenReassessment = z.infer<typeof FrozenReassessmentSchema>;
const JudgeEvidence = z.object({contract:Contract, inputSha256:hashSchema, identity:Identity, answer:ReassessmentAnswerSchema, origin:z.enum(['cache','new'])}).strict();
export type ReassessmentJudgeEvidence = z.infer<typeof JudgeEvidence>;
const PassEntry = z.object({key:hashSchema, oldEvidenceHash:hashSchema, claimsSha256:hashSchema.nullable(), judge:JudgeEvidence.nullable(), judgeAttempted:z.boolean(), failure:WorkFailureSchema.nullable()}).strict();
export const ReassessmentDeltaSchema = z.object({
  version:z.literal(REASSESSMENT_VERSION), frozenSha256:hashSchema, contract:Contract,
  provider:Provider, host:z.enum(['codex-workstation','Mac']), generatedAt:z.iso.datetime(),
  entries:z.array(PassEntry), deltaSha256:hashSchema,
}).strict();
export type ReassessmentDelta = z.infer<typeof ReassessmentDeltaSchema>;
const Pin = z.object({path:z.string().min(1), sha256:hashSchema}).strict();
const MetadataEncodingSchema=z.object({indent:z.number().int().min(0).max(8),trailingNewlines:z.number().int().min(0).max(2)}).strict();
const ControlMetadataPinSchema=Pin.extend({bytes:z.number().int().nonnegative().max(16*1024*1024),metadata:z.object({role:z.enum(['work_plan_metadata','preparation_plan_metadata']),encoding:MetadataEncodingSchema,value:z.unknown()}).strict()}).strict();
export type ReassessmentControlPin=z.infer<typeof ControlMetadataPinSchema>|ReassessmentArtifactPin;
type ControlPlanRole=z.infer<typeof ControlMetadataPinSchema>['metadata']['role'];
const PolicyOptions=z.object({stateDir:z.string().min(1).optional(),authorityId:z.string().min(1).optional(),authoritySha256:hashSchema.optional()}).strict();
export const FreezeReassessmentOptionsSchema = z.object({
  workPlan:z.union([ControlMetadataPinSchema.extend({metadata:ControlMetadataPinSchema.shape.metadata.extend({role:z.literal('work_plan_metadata')}).strict()}),reassessmentArtifactPinSchema]),
  preparationPlan:z.union([ControlMetadataPinSchema.extend({metadata:ControlMetadataPinSchema.shape.metadata.extend({role:z.literal('preparation_plan_metadata')}).strict()}),reassessmentArtifactPinSchema]),resultRoot:z.string().min(1),
  // null reads the existing managed receipt on the authoritative VM; never SSH/Mac.
  preparedRoot:z.string().min(1).nullable(),answers:z.array(knowledgePreparedSourcePinSchema),out:z.string().min(1),policy:PolicyOptions.optional(),
}).strict();
export const JudgePassOptionsSchema = z.object({frozen:reassessmentArtifactPinSchema,provider:z.literal('openai-subscription'),out:z.string().min(1),ledgerPath:z.string().min(1),pausePath:z.string().min(1),policy:PolicyOptions.optional()}).strict();
export const MergeReassessmentOptionsSchema = z.object({frozen:reassessmentArtifactPinSchema,deltas:z.array(reassessmentArtifactPinSchema),out:z.string().min(1),policy:PolicyOptions.optional()}).strict();

const jsonHash = (value:unknown) => sha256(JSON.stringify(value));
const equal = (a:unknown,b:unknown) => canonical(a) === canonical(b);
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export function reassessmentDeltaHash(body:Omit<ReassessmentDelta,'deltaSha256'>):string {return sha256(canonical(body));}
function decode(blob:Blob):unknown {
  if(sha256(blob.bytes)!==blob.sha256)throw Error('Reassessment artifact byte binding mismatch');
  return JSON.parse(blob.bytes);
}
function sealAnswer(body:z.infer<typeof AnswerBody>):Answer {return {...body,cacheSha256:jsonHash(body)};}
function checkedAnswer(raw:unknown):Answer {
  // Check the ORIGINAL property order used by district-inference.cachedAnswer.
  if(raw===null||typeof raw!=='object'||Array.isArray(raw))throw Error('Reassessment answer schema mismatch');
  const {cacheSha256,...body}=raw as Record<string,unknown>;
  if(cacheSha256!==jsonHash(body))throw Error('Reassessment answer cache hash mismatch');
  return ReassessmentAnswerSchema.parse(raw);
}
function identityOf(record:DistrictKnowledgeRecord):ModelEvidence {
  const {provider,tool,toolVersion,model,modelIdentitySha256,modelIdentityBasis}=record.extraction;
  return {provider,tool,toolVersion,model,modelIdentitySha256,modelIdentityBasis};
}
function checkIdentity(identity:ModelEvidence) {
  try { assertModelEvidenceIdentity(identity); }
  catch { throw Error('Reassessment model identity binding mismatch'); }
}
export function assertNativeReassessmentHost(provider:ExtractorProvider, platform:NodeJS.Platform=process.platform) {
  if(provider!=='openai-subscription'||platform!=='linux')throw Error('Reassessment judge requires the authoritative native Codex-only VM');
}
export async function currentReassessmentContract():Promise<ReassessmentContract> {
  const files=['district-reassess-relations.ts','district-work-plan.ts','district-preparation-run.ts','prepare-knowledge.ts','district-claims.ts','district-schema.ts','source-policy.ts','document-origin.ts','document-origin-rules.ts','document-origin-contract.ts','civic-opt-out.ts','district-answer-cache.ts','district-graph-claims.ts','district-model.ts','district-model-contract.ts','district-claude.ts','district-model-usage.ts','district-model-diagnostics.ts','district-private-io.ts','district-prepared-document.ts'];
  const hashes=await Promise.all(files.map(async name=>({name,sha256:sha256(await readFile(new URL(name,import.meta.url)))})));
  return {version:REASSESSMENT_VERSION,judgePromptVersion:JUDGE_PROMPT_VERSION,judgePromptSha256:JUDGE_PROMPT_SHA256,judgeSchemaSha256:jsonHash(judgeJSONSchema),assessorSha256:jsonHash(hashes),threshold:0.8};
}
function checkContract(contract:ReassessmentContract, current:ReassessmentContract) {
  if(!equal(contract,current)||contract.judgePromptVersion!==JUDGE_PROMPT_VERSION||contract.judgePromptSha256!==JUDGE_PROMPT_SHA256||contract.judgeSchemaSha256!==jsonHash(judgeJSONSchema))throw Error('Reassessment current fact judge contract mismatch');
}
async function pinnedBlob(pin:z.infer<typeof Pin>,expectedBytes?:number):Promise<Blob> {
  const metadata=await lstat(pin.path);
  if(!metadata.isFile()||metadata.size>512*1024*1024||expectedBytes!==undefined&&metadata.size!==expectedBytes)throw Error('Reassessment pinned file type or length mismatch');
  const raw=await readFile(pin.path);
  if(sha256(raw)!==pin.sha256||expectedBytes!==undefined&&raw.length!==expectedBytes)throw Error('Reassessment pinned file changed during read');
  return {sha256:pin.sha256,bytes:new TextDecoder('utf-8',{fatal:true}).decode(raw)};
}
async function reassessmentArtifactBlob(pin:ReassessmentArtifactPin,policy:CivicPolicyOptions):Promise<Blob>{
  reassessmentArtifactPinSchema.parse(pin);
  await assertManagedSourceBindings(pin.path,pin.bindings,policy);
  const blob=await pinnedBlob(pin,pin.bytes);
  await assertManagedSourceBindings(pin.path,pin.bindings,policy);
  return blob;
}
async function validateControlMetadata(value:unknown,role:ControlPlanRole):Promise<void>{
 if(role==='preparation_plan_metadata'){await parseContentFreePreparationPlan(value);return;}
 const parsed=WorkPlanSchema.parse(value);
 if(parsed.tasks.length>100_000||!equal(value,parsed))throw Error('Work-plan metadata contains unknown or normalized fields');
}
async function readControlPlan(pin:ReassessmentControlPin,role:ControlPlanRole,policy:CivicPolicyOptions):Promise<{blob:Blob;bindings:ReassessmentArtifactPin['bindings']}>{
 if('bindings' in pin)return {blob:await reassessmentArtifactBlob(pin,policy),bindings:pin.bindings};
 const metadata=ControlMetadataPinSchema.parse(pin);
 if(metadata.metadata.role!==role)throw Error('Reassessment control metadata role mismatch');
 const {encoding,value}=metadata.metadata,bytes=JSON.stringify(value,null,encoding.indent)+'\n'.repeat(encoding.trailingNewlines);
 if(Buffer.byteLength(bytes)!==metadata.bytes||sha256(bytes)!==metadata.sha256)throw Error('Reassessment control metadata byte binding mismatch');
 await validateControlMetadata(value,role);
 // The original locator is provenance only: no untyped control-plan file is opened.
 return {blob:{bytes,sha256:metadata.sha256},bindings:[]};
}
function bindingSet(bindings:KnowledgePreparedSourcePin['bindings']):string {
  return canonical([...new Set(bindings.map(binding=>canonical(binding)))].sort());
}
async function writeReassessmentArtifact(root:string,path:string,value:unknown,bindings:ReassessmentArtifactPin['bindings'],policy:CivicPolicyOptions):Promise<ReassessmentArtifactPin>{
  const content=JSON.stringify(value,null,2)+'\n',bytes=Buffer.byteLength(content),digest=await writeManagedSourceArtifact(root,path,content,bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
  return reassessmentArtifactPinSchema.parse({path,sha256:digest,bytes,bindings});
}
async function fileBlob(path:string):Promise<Blob> {
  const metadata=await lstat(path);
  if(!metadata.isFile()||metadata.size>32*1024*1024)throw Error('Reassessment private input size/type rejected');
  const bytes=await readFile(path,'utf8');return {sha256:sha256(bytes),bytes};
}
async function fresh(path:string) {
  try {await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  throw Error('Reassessment output must be a new artifact');
}
function taskGroup(preparation:PreparationPlan,task:WorkTask) {
  const matches=preparation.groups.filter(group=>group.expected.municipalityId===task.group.municipalityId&&group.expected.sourceSha256===task.group.sourceSha256&&group.expected.receiptSha256===task.group.preparedSha256);
  if(matches.length!==1)throw Error('Reassessment preparation group binding mismatch');
  return matches[0];
}
function checkResult(result:DocumentResult,task:WorkTask,plan:WorkPlan) {
  if(result.purpose!=='production'||task.purpose!=='production'||result.taskId!==task.id||result.groupId!==task.groupId||result.provider!==task.provider||result.municipalityId!==task.group.municipalityId||result.sourceSha256!==task.group.sourceSha256||result.preparedSha256!==task.group.preparedSha256||result.promptSha256!==plan.promptSha256||result.schemaSha256!==plan.schemaSha256)throw Error('Reassessment completed primary result binding mismatch');
}
type Validated = {frozen:FrozenReassessment; plan:WorkPlan; preparation:PreparationPlan; documents:Array<{task:WorkTask; result:DocumentResult; prepared:PreparedDocument}>; answers:Answer[]};
/** Historical candidates carry their original source-bound span. Reassessment
 * does not rerun today's window algorithm against yesterday's chunk indices.
 * Complete generation coverage is proved separately by the archived generation
 * codec, including its original whole-document budget rule. */
function recordedSourceChunk(record:DistrictKnowledgeRecord,prepared:PreparedDocument):DocumentChunk|null {
  const span=record.extraction.chunk;
  if(record.extraction.inputSha256!==prepared.sourceSha256||record.extraction.textSha256!==prepared.textSha256||
    ![span.index,span.count,span.start,span.end].every(Number.isSafeInteger)||span.index<0||span.count<1||span.index>=span.count||
    span.start<0||span.end<=span.start||span.end>prepared.text.length)return null;
  return {...span,text:prepared.text.slice(span.start,span.end)};
}
export function validateFrozenReassessment(input:unknown,current:ReassessmentContract):Validated {
  const frozen=FrozenReassessmentSchema.parse(input);checkContract(frozen.contract,current);
  const plan=WorkPlanSchema.parse(decode(frozen.workPlan)),preparation=preparationPlanSchema.parse(decode(frozen.preparationPlan));
  for(const item of preparation.quarantine)if(item.candidate)for(const source of item.candidate.sources)if(!frozen.controlBindings.preparationPlan.some(binding=>(binding.kind==='http_observation'||binding.kind==='prepared_source')&&binding.url===source.url&&binding.sourceSha256===source.sha256&&binding.observationId===source.id))throw Error('Preparation quarantine candidate lacks an actual control-source receipt');
  if(plan.tasks.some(task=>task.state==='running'))throw Error('Reassessment requires a stopped frozen work plan');
  restoreWorkPlan(plan); // Validate derived assignments without rewriting the frozen plan.
  const tasks=plan.tasks.filter(task=>task.purpose==='production'&&task.state==='completed');
  if(tasks.length!==frozen.documents.length||new Set(frozen.documents.map(item=>item.taskId)).size!==tasks.length)throw Error('Reassessment completed primary inventory mismatch');
  const documents=frozen.documents.map(item=>{
    const task=tasks.find(task=>task.id===item.taskId);
    if(!task||task.resultSha256!==item.result.sha256)throw Error('Reassessment completed result receipt mismatch');
    const result=documentResultSchema.parse(decode(item.result));checkResult(result,task,plan);
    const prepared=verifyPreparedDocument(decode(item.prepared),taskGroup(preparation,task).expected);
    const candidates=[...result.records,...result.quarantine.flatMap(item=>item.candidate?[item.candidate]:[])];
    assertPreparedReferenceMembership(candidates.flatMap(record=>record.sources),prepared.references);
    if(result.chunks.some((chunk,index)=>chunk.index!==index)||new Set(result.chunks.map(chunk=>chunk.index)).size!==result.chunks.length)throw Error('Reassessment original chunk coverage mismatch');
    for(const record of candidates){
      const chunk=recordedSourceChunk(record,prepared);
      if(!chunk||chunk.count!==result.chunks.length||!result.chunks.some(outcome=>outcome.index===chunk.index&&outcome.recordId===record.id&&outcome.responseSha256===record.extraction.responseSha256))throw Error('Reassessment original source-span binding mismatch');
    }
    if(!result.chunks.length&&result.quarantine.some(item=>item.reason==='Document exceeds model chunk limit; entire document quarantined before model readiness (no truncation or model calls)')){
      const expected={documentId:'document:'+prepared.sourceSha256,municipalityId:prepared.municipalityId,sourceId:prepared.references[0].id,sourceSha256:prepared.sourceSha256,chunk:null,reason:'Document exceeds model chunk limit; entire document quarantined before model readiness (no truncation or model calls)'};
      if(result.records.length||!equal(result.quarantine,[expected]))throw Error('Reassessment whole-document budget evidence mismatch');
    }
    return {task,result,prepared};
  });
  const answers=frozen.answers.map(blob=>checkedAnswer(decode(blob)));
  if(new Set(answers.map(answer=>answer.binding)).size!==answers.length)throw Error('Reassessment duplicate answer binding');
  return {frozen,plan,preparation,documents,answers};
}
function reassessmentReferences(validated:Validated):PreparedSourceReference[]{
 return [...validated.preparation.groups.flatMap(group=>group.expected.references),...validated.documents.flatMap(item=>[...item.prepared.references,...item.result.records.flatMap(record=>record.sources),...item.result.quarantine.flatMap(entry=>entry.candidate?.sources??[])]),...validated.preparation.quarantine.flatMap(item=>item.candidate?.sources??[])];
}
function reassessmentBindings(validated:Validated):ReassessmentArtifactPin['bindings']{
 const inventory=new Map<string,ReassessmentArtifactPin['bindings'][number]>();
 for(const binding of [...validated.frozen.controlBindings.workPlan,...validated.frozen.controlBindings.preparationPlan,...validated.documents.flatMap(item=>preparedSourceBindings(item.prepared.references,item.prepared.receiptSha256))]){
  const {independentAllowed,...proof}=binding,key=canonical(proof),prior=inventory.get(key);
  if(prior)prior.independentAllowed=prior.independentAllowed&&independentAllowed;
  else inventory.set(key,{...binding});
 }
 return [...inventory].sort(([left],[right])=>left<right?-1:left>right?1:0).map(([,binding])=>binding);
}
export async function assertFrozenReassessmentActive(input:unknown,current:ReassessmentContract,policy:CivicPolicyOptions=CIVIC_POLICY_AUTHORITY):Promise<Validated>{
 await assertCivicPolicyAuthority(policy);
 const validated=validateFrozenReassessment(input,current);
 if(!validated.frozen.controlBindings.workPlan.length)await validateControlMetadata(decode(validated.frozen.workPlan),'work_plan_metadata');
 if(!validated.frozen.controlBindings.preparationPlan.length)await validateControlMetadata(decode(validated.frozen.preparationPlan),'preparation_plan_metadata');
 for(const binding of reassessmentBindings(validated))await assertHostNotOptedOut(binding.url,policy);
 await assertPreparedSourcesActive(reassessmentReferences(validated),policy);return validated;
}
async function readValidatedFrozen(pin:ReassessmentArtifactPin,contract:ReassessmentContract,policy:CivicPolicyOptions):Promise<Validated>{
 const blob=await reassessmentArtifactBlob(pin,policy),validated=await assertFrozenReassessmentActive(decode(blob),contract,policy);
 await assertManagedSourceBindings(pin.path,reassessmentBindings(validated),policy);
 return validated;
}
export async function freezeReassessment(raw:unknown):Promise<ReassessmentArtifactPin> {
  const options=FreezeReassessmentOptionsSchema.parse(raw),selectedPolicy=options.policy??CIVIC_POLICY_AUTHORITY,authority=await assertCivicPolicyAuthority(selectedPolicy),policy={...selectedPolicy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
  if(authority.mode!=='isolated-fixture'&&process.platform!=='linux')throw Error('Source freezing requires the authoritative Codex VM');
  await fresh(options.out);
  const work=await readControlPlan(options.workPlan,'work_plan_metadata',policy),preparationInput=await readControlPlan(options.preparationPlan,'preparation_plan_metadata',policy),workPlan=work.blob,preparationPlan=preparationInput.blob;
  const plan=WorkPlanSchema.parse(decode(workPlan)),preparation=preparationPlanSchema.parse(decode(preparationPlan));
  if(plan.tasks.some(task=>task.state==='running'))throw Error('Reassessment cannot freeze an active work plan');
  restoreWorkPlan(plan);
  await assertPreparedSourcesActive(preparation.groups.flatMap(group=>group.expected.references),policy);
  const documents:FrozenReassessment['documents']=[],responses=new Set<string>(),contexts=new Set<string>();
  for(const task of plan.tasks.filter(task=>task.purpose==='production'&&task.state==='completed')) {
    if(!task.resultSha256)throw Error('Reassessment completed task lacks a result hash');
    const expected=taskGroup(preparation,task).expected,resultPath=join(options.resultRoot,task.id+'.json'),bindings=preparedSourceBindings(expected.references,expected.receiptSha256),contextKey=bindingSet(bindings);
    contexts.add(contextKey);
    await assertPreparedSourcesActive(expected.references,policy);await assertManagedSourceBindings(resultPath,bindings,policy);
    const result=await pinnedBlob({path:resultPath,sha256:task.resultSha256}),parsed=documentResultSchema.parse(decode(result));checkResult(parsed,task,plan);
    await assertManagedSourceBindings(resultPath,bindings,policy);
    assertPreparedReferenceMembership([...parsed.records.flatMap(record=>record.sources),...parsed.quarantine.flatMap(item=>item.candidate?.sources??[])],expected.references);
    await assertPreparedSourcesActive(expected.references,policy);
    for(const chunk of parsed.chunks)if(chunk.responseSha256)responses.add(jsonHash({responseSha256:chunk.responseSha256,contextKey}));
    for(const record of [...parsed.records,...parsed.quarantine.flatMap(item=>item.candidate?[item.candidate]:[])])if(record.verification.faithfulness.responseSha256)responses.add(jsonHash({responseSha256:record.verification.faithfulness.responseSha256,contextKey}));
    let prepared:Blob;
    if(options.preparedRoot){const path=join(options.preparedRoot,expected.receiptSha256+'.json');await assertManagedSourceBindings(path,bindings,policy);prepared=await fileBlob(path);await assertManagedSourceBindings(path,bindings,policy);}
    else {const receipt=await readPreparedDocument(expected,policy),bytes=JSON.stringify(receipt);prepared={bytes,sha256:sha256(bytes)};}
    const checked=verifyPreparedDocument(decode(prepared),expected);await assertPreparedSourcesActive(checked.references,policy);documents.push({taskId:task.id,result,prepared});
  }
  const answers=new Map<string,Blob>(),found=new Set<string>();
  for(const pin of options.answers){
    const contextKey=bindingSet(pin.bindings);
    if(!contexts.has(contextKey))throw Error('Reassessment answer pin differs from every selected prepared context');
    const blob=await reassessmentArtifactBlob(pin,policy),answer=checkedAnswer(decode(blob)),responseKey=jsonHash({responseSha256:answer.responseSha256,contextKey});
    if(!responses.has(responseKey))throw Error('Reassessment answer does not belong to its selected prepared-result receipt');
    const previous=answers.get(answer.binding);
    if(previous&&!equal(decode(previous),decode(blob)))throw Error('Reassessment conflicting original answer cache');
    answers.set(answer.binding,blob);found.add(responseKey);
  }
  if([...responses].some(response=>!found.has(response)))throw Error('Reassessment requires every selected original answer receipt; no cache-directory scan or live fallback');
  const frozen:FrozenReassessment={version:REASSESSMENT_VERSION,frozenAt:new Date().toISOString(),contract:await currentReassessmentContract(),workPlan,preparationPlan,controlBindings:{workPlan:work.bindings,preparationPlan:preparationInput.bindings},documents,answers:[...answers.values()]};
  const validated=await assertFrozenReassessmentActive(frozen,frozen.contract,policy);
  return writeReassessmentArtifact(dirname(resolve(options.out)),options.out,frozen,reassessmentBindings(validated),policy);
}

export function relationDateEligible(claims:Pick<DistrictExtractionClaims,'documentDate'|'stageDate'|'stages'>):boolean {
  return claims.documentDate!==null||claims.stageDate!==null||claims.stages.some(event=>event.date!==null);
}
function recordClaims(record:DistrictKnowledgeRecord):DistrictExtractionClaims {
  return DistrictExtractionClaimsSchema.parse(Object.fromEntries(Object.keys(DistrictExtractionClaimsSchema.shape).map(key=>[key,key==='caseKey'&&record.caseKeyType==='source_document'?null:key==='entities'?record.entities.map(({entityId:_id,identityBasis:_basis,...mention})=>mention):key==='relations'?record.relations.map(({fromId:_from,toId:_to,...relation})=>relation):record[key as keyof DistrictKnowledgeRecord]])));
}
type Located = {key:string; task:WorkTask; result:DocumentResult; prepared:PreparedDocument; record:DistrictKnowledgeRecord; location:'record'|'quarantine'; index:number; municipalityName:string};
export type RelationAssessment = {
  key:string; original:DistrictKnowledgeRecord; claims:DistrictExtractionClaims|null;
  normalization:RelationActionNormalization|null; quoteNormalization:DistrictKnowledgeRecord['extraction']['quoteNormalization'];
  deterministic:DistrictKnowledgeRecord['verification']['deterministic']|null; changed:boolean; newlyPassed:boolean;
  dateEligible:boolean; needsJudge:boolean; hold:string|null; judgeInput:unknown|null; judgeBinding:string|null; claimsSha256:string|null;
};
function locatedRecords(validated:Validated):Located[] {
  const located:Located[]=[];
  for(const {task,result,prepared} of validated.documents) {
    const municipality=taskGroup(validated.preparation,task).municipality;
    const add=(record:DistrictKnowledgeRecord,location:Located['location'],index:number)=>{
      if(!record.relations.length)return;
      const key=jsonHash({taskId:task.id,location,index,recordId:record.id,oldEvidenceHash:record.verification.evidenceHash});
      located.push({key,task,result,prepared,record,location,index,municipalityName:municipality.name});
    };
    result.records.forEach((record,index)=>add(record,'record',index));
    result.quarantine.forEach((item,index)=>{if(item.candidate)add(item.candidate,'quarantine',index);});
  }
  return located;
}
export function reassessmentJudgeBinding(provider:ExtractorProvider,identity:ModelEvidence,input:unknown,prepared:PreparedDocument):string {
  return modelAnswerCacheBinding({provider,modelIdentitySha256:identity.modelIdentitySha256,system:JUDGE_INSTRUCTIONS,input,schema:judgeJSONSchema,sourceContext:preparedCacheContext(prepared.receiptSha256,prepared.references)});
}
export function assessExistingRelation(input:{key:string;record:DistrictKnowledgeRecord;prepared:PreparedDocument;municipalityName:string;answers:Answer[]}):RelationAssessment {
  const {record,prepared}=input;
  const base:RelationAssessment={key:input.key,original:record,claims:null,normalization:null,quoteNormalization:record.extraction.quoteNormalization,deterministic:null,changed:false,newlyPassed:false,dateEligible:false,needsJudge:false,hold:null,judgeInput:null,judgeBinding:null,claimsSha256:null};
  const hold=(reason:string)=>({...base,hold:reason});
  if(record.extraction.inputSha256!==prepared.sourceSha256||record.extraction.textSha256!==prepared.textSha256||record.municipalityId!==prepared.municipalityId)return hold('source_binding_unknown');
  const chunk=recordedSourceChunk(record,prepared);
  if(!chunk)return hold('source_chunk_binding_unknown');
  const expectedReferences=prepared.references.map(reference=>({...reference,locator:`text-sha256:${prepared.textSha256};chars:${chunk.start}-${chunk.end}`}));
  if(!equal(record.sources,expectedReferences))return hold('source_reference_binding_unknown');
  const rawAnswers=input.answers.filter(answer=>answer.responseSha256===record.extraction.responseSha256&&answer.modelIdentitySha256===record.extraction.modelIdentitySha256&&answer.receivedAt===record.extraction.extractedAt);
  if(rawAnswers.length!==1)return hold('raw_generation_evidence_missing_or_ambiguous');
  const decoded=extractionOutputSchema.safeParse(rawAnswers[0].value);
  if(!decoded.success||!decoded.data.record||!decoded.data.record.relations.length)return hold('raw_relation_candidate_unknown');
  const restored=restoreSourceQuotes(decoded.data.record,chunk.text,chunk.start);
  // Do not reconstruct omitted triples from summaries, nor overwrite unrelated corrected facts.
  if(!equal(restored.claims,recordClaims(record)))return hold('raw_candidate_record_mismatch');
  const normalized=normalizeRelationActions(restored.claims),claims=normalized.claims;
  const deterministic=deterministicChecks(claims,chunk.text,input.municipalityName);
  if(![...REQUIRED_DETERMINISTIC_CHECKS,...GRAPH_DETERMINISTIC_CHECKS].every(id=>deterministic.checks.some(check=>check.id===id)))throw Error('Reassessment omitted a required original gate');
  const changed=!equal(claims,recordClaims(record)),dateEligible=relationDateEligible(claims);
  const originalDeterministicPassed=[...REQUIRED_DETERMINISTIC_CHECKS,...GRAPH_DETERMINISTIC_CHECKS].every(id=>record.verification.deterministic.checks.some(check=>check.id===id&&check.passed));
  const newlyPassed=deterministic.passed&&!originalDeterministicPassed;
  const judgeInput={source:{text:chunk.text},candidate:claims};
  return {...base,claims,normalization:normalized.normalization,quoteNormalization:restored.normalization,deterministic,changed,newlyPassed,dateEligible,
    needsJudge:deterministic.passed&&dateEligible&&(changed||newlyPassed),
    hold:!deterministic.passed?'deterministic_gate_failed':!dateEligible?'date_missing':!changed&&!newlyPassed&&record.verification.status!=='auto-verified'?'previous_judge_failed_or_unknown':null,
    judgeInput,judgeBinding:reassessmentJudgeBinding(record.extraction.provider,identityOf(record),judgeInput,prepared),claimsSha256:jsonHash(claims)};
}
function assessLocated(item:Located,answers:Answer[]):RelationAssessment {
  const chunk=item.result.chunks.find(chunk=>chunk.index===item.record.extraction.chunk.index);
  const quarantine=item.location==='quarantine'?item.result.quarantine[item.index]:null;
  if(!chunk||chunk.recordId!==item.record.id||chunk.responseSha256!==item.record.extraction.responseSha256||item.record.extraction.provider!==item.task.provider||quarantine&&(quarantine.chunk!==chunk.index||quarantine.sourceSha256!==item.prepared.sourceSha256||quarantine.municipalityId!==item.record.municipalityId))throw Error('Reassessment candidate/result chunk binding mismatch');
  return assessExistingRelation({key:item.key,record:item.record,prepared:item.prepared,municipalityName:item.municipalityName,answers});
}
function checkJudge(evidence:ReassessmentJudgeEvidence,assessment:RelationAssessment,contract:ReassessmentContract) {
  checkContract(evidence.contract,contract);checkIdentity(evidence.identity);
  if(!assessment.needsJudge||!assessment.judgeInput||evidence.inputSha256!==jsonHash(assessment.judgeInput)||!equal(evidence.identity,identityOf(assessment.original)))throw Error('Reassessment judge input/identity mismatch');
  const answer=checkedAnswer(evidence.answer);
  if(answer.binding!==assessment.judgeBinding||answer.modelIdentitySha256!==evidence.identity.modelIdentitySha256||answer.returnedModel!==null&&answer.returnedModel!==evidence.identity.model)throw Error('Reassessment actual judge binding mismatch');
  return judgeSchema.safeParse(answer.value);
}
function cachedJudge(assessment:RelationAssessment,answers:Answer[],contract:ReassessmentContract):ReassessmentJudgeEvidence|null {
  if(!assessment.needsJudge)return null;
  const answer=answers.find(answer=>answer.binding===assessment.judgeBinding);
  if(!answer)return null;
  const evidence:ReassessmentJudgeEvidence={contract,inputSha256:jsonHash(assessment.judgeInput),identity:identityOf(assessment.original),answer,origin:'cache'};
  // Invalid or critical cached actual judgments remain failed, never trigger a favorable retry.
  checkJudge(evidence,assessment,contract);return evidence;
}
export type JudgeOnlyRuntime = {
  readiness:(provider:ExtractorProvider,signal?:AbortSignal,policy?:CivicPolicyOptions)=>Promise<ModelEvidence>;
  judge:(provider:ExtractorProvider,system:string,input:unknown,schema:unknown,usage:UsageContext)=>Promise<ModelAnswer>;
  stopped:(path:string,provider:ExtractorProvider)=>Promise<boolean>;
};
const nativeRuntime:JudgeOnlyRuntime={readiness:modelReadiness,judge:subscriptionChat,stopped:isProviderStopped};
export async function executeReassessmentPass(options:{frozen:unknown;frozenSha256:string;contract:ReassessmentContract;provider:ExtractorProvider;usage:Omit<UsageContext,'purpose'>;managedRoot:string;policy?:CivicPolicyOptions;platform?:NodeJS.Platform;runtime?:JudgeOnlyRuntime;load?:(key:string)=>Promise<ReassessmentJudgeEvidence|null>;save?:(key:string,evidence:ReassessmentJudgeEvidence)=>Promise<void>}):Promise<ReassessmentDelta> {
  assertNativeReassessmentHost(options.provider,options.platform);hashSchema.parse(options.frozenSha256);
  const selectedPolicy=options.policy??options.usage.policy??CIVIC_POLICY_AUTHORITY,authority=await assertCivicPolicyAuthority(selectedPolicy),policy={...selectedPolicy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
  const validated=await assertFrozenReassessmentActive(options.frozen,options.contract,policy),runtime=options.runtime??nativeRuntime;
  await initializeManagedAcquisitionLane(options.managedRoot,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
  const entries:ReassessmentDelta['entries']=[];
  let identity:ModelEvidence|null=null,stopped=false;
  for(const item of locatedRecords(validated).filter(item=>item.task.provider===options.provider)) {
    await assertPreparedSourcesActive([...item.prepared.references,...item.record.sources],policy);
    const assessment=assessLocated(item,validated.answers);
    const entry:z.infer<typeof PassEntry>={key:item.key,oldEvidenceHash:item.record.verification.evidenceHash,claimsSha256:assessment.claimsSha256,judge:null,judgeAttempted:false,failure:null};
    entries.push(entry);
    if(!assessment.needsJudge||stopped)continue;
    entry.judge=cachedJudge(assessment,validated.answers,options.contract);
    if(entry.judge)continue;
    await assertPreparedSourcesActive([...item.prepared.references,...item.record.sources],policy);
    const saved=await options.load?.(item.key);
    if(saved){checkJudge(saved,assessment,options.contract);entry.judge=saved;entry.judgeAttempted=saved.origin==='new';continue;}
    try {
      options.usage.signal?.throwIfAborted();
      if(await runtime.stopped(options.usage.pausePath,options.provider))throw Object.assign(Error('Reassessment operator paused'),{failureCategory:'operator_pause'});
      await assertPreparedSourcesActive([...item.prepared.references,...item.record.sources],policy);
      identity??=await runtime.readiness(options.provider,options.usage.signal,policy);checkIdentity(identity);
      options.usage.signal?.throwIfAborted();
      if(!equal(identity,identityOf(item.record)))throw Object.assign(Error('Reassessment native model identity mismatch'),{failureCategory:'model_identity_mismatch'});
      entry.judgeAttempted=true;
      await assertPreparedSourcesActive([...item.prepared.references,...item.record.sources],policy);
      const sourceContext:ManagedSourceContext={root:options.managedRoot,kind:'artifacts',decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy,bindings:preparedSourceBindings(item.prepared.references,item.prepared.receiptSha256).map(({independentAllowed:_independent,...binding})=>binding)};
      const answer=await runtime.judge(options.provider,JUDGE_INSTRUCTIONS,assessment.judgeInput,judgeJSONSchema,{...options.usage,purpose:'judge',groupId:item.task.groupId,policy,sourceContext});
      if(!equal(answer.evidence,identity)||answer.requestedModel!==identity.model||answer.returnedModel!==null&&answer.returnedModel!==identity.model||answer.reportedModels.some(model=>model!==identity!.model))throw Object.assign(Error('Reassessment returned model identity mismatch'),{failureCategory:'model_identity_mismatch'});
      const body=AnswerBody.parse({binding:assessment.judgeBinding,modelIdentitySha256:identity.modelIdentitySha256,receivedAt:new Date().toISOString(),value:answer.value,responseSha256:answer.responseSha256,returnedModel:answer.returnedModel,runtimeWarnings:answer.runtimeWarnings});
      entry.judge={contract:options.contract,inputSha256:jsonHash(assessment.judgeInput),identity,answer:sealAnswer(body),origin:'new'};
      checkJudge(entry.judge,assessment,options.contract);
      await assertPreparedSourcesActive([...item.prepared.references,...item.record.sources],policy);
      await options.save?.(item.key,entry.judge);
    }catch(error){
      if(error instanceof HostOptedOutError||error instanceof CivicPolicyStateError)throw error;
      if(error instanceof SubscriptionRuntimeError&&error.diagnostic)entry.judgeAttempted=error.diagnostic.attempted;
      entry.judge=null;entry.failure=classifyWorkFailure(error);stopped=true;
    }
  }
  await assertPreparedSourcesActive(reassessmentReferences(validated),policy);
  const body={version:REASSESSMENT_VERSION as typeof REASSESSMENT_VERSION,frozenSha256:options.frozenSha256,contract:options.contract,provider:options.provider,host:PROVIDER_CONFIGS[options.provider].host,generatedAt:new Date().toISOString(),entries};
  return ReassessmentDeltaSchema.parse({...body,deltaSha256:reassessmentDeltaHash(body)});
}

function heldRecord(record:DistrictKnowledgeRecord,reason:string):DistrictKnowledgeRecord {
  const result={...record,verification:{...record.verification,status:'candidate' as const,reason,evidenceHash:''}};
  result.verification.evidenceHash=knowledgeEvidenceHash(result);return DistrictKnowledgeRecordSchema.parse(result);
}
export type MaterializedReassessment={record:DistrictKnowledgeRecord;admitted:boolean;hold:string|null;judgePassed:boolean|null};
export function materializeReassessment(assessment:RelationAssessment,evidence:ReassessmentJudgeEvidence|null,contract:ReassessmentContract):MaterializedReassessment {
  const original=assessment.original;
  if(!assessment.claims||!assessment.deterministic)return {record:heldRecord(original,assessment.hold??'reassessment_unknown'),admitted:false,hold:assessment.hold??'reassessment_unknown',judgePassed:null};
  let hold=assessment.hold,judgePassed:boolean|null=null;
  let faithfulness=original.verification.faithfulness;
  const deterministic=structuredClone(assessment.deterministic);
  if(assessment.needsJudge) {
    if(!evidence)hold='current_actual_judge_missing';
    else {
      const judged=checkJudge(evidence,assessment,contract);
      judgePassed=judged.success&&judged.data.score>=0.8&&!judged.data.criticalUnsupported;
      const answer=evidence.answer;
      faithfulness={...original.verification.faithfulness,threshold:0.8,score:judged.success?judged.data.score:null,returnedModel:answer.returnedModel,runtimeWarnings:answer.runtimeWarnings,reason:judged.success?judged.data.reason:'Actual reassessment judge returned invalid structured output',evaluatedAt:answer.receivedAt,responseSha256:answer.responseSha256,sameModel:true,limitation:LIMITATION};
      if(judged.success&&judged.data.criticalUnsupported){deterministic.checks.push({id:'judge_critical_claims',passed:false,reason:'Actual model judge found a critically unsupported claim'});deterministic.passed=false;}
      if(!judgePassed)hold='current_actual_judge_failed';
    }
  }
  if(!assessment.changed&&!assessment.needsJudge&&!hold)return {record:original,admitted:true,hold:null,judgePassed:null};
  // Scores on a changed claim cannot inherit the old candidate's judgment.
  if(assessment.changed&&!evidence)faithfulness={...original.verification.faithfulness,threshold:0.8,score:null,returnedModel:null,reason:'Not evaluated: reassessed claim requires an actual current judgment',evaluatedAt:null,responseSha256:null,sameModel:true,limitation:LIMITATION};
  const claims=assessment.claims;
  let graph:Pick<DistrictKnowledgeRecord,'entities'|'relations'>;
  try{graph=normalizeGraphClaims(claims,{municipalityId:original.municipalityId,sourceSha256:original.extraction.inputSha256,ags:original.ags});}
  catch{return {record:heldRecord(original,'graph_identity_unknown'),admitted:false,hold:'graph_identity_unknown',judgePassed};}
  const admitted=!hold&&deterministic.passed&&assessment.dateEligible&&(!assessment.needsJudge||judgePassed===true);
  const candidate={...original,...claims,...graph,caseKey:original.caseKey,
    extraction:{...original.extraction,quoteNormalization:assessment.quoteNormalization,...(assessment.normalization?{relationNormalization:{...assessment.normalization,sourceSha256:original.extraction.inputSha256,textSha256:original.extraction.textSha256,responseSha256:original.extraction.responseSha256}}:{})},
    verification:{kind:'text_model' as const,status:admitted?'auto-verified' as const:'candidate' as const,deterministic,faithfulness,evidenceHash:'',...(!admitted?{reason:hold??'reassessment_withheld'}:{})}};
  candidate.verification.evidenceHash=knowledgeEvidenceHash(candidate);
  return {record:DistrictKnowledgeRecordSchema.parse(candidate),admitted,hold:admitted?null:hold??'reassessment_withheld',judgePassed};
}
type CountRow={reusedUnchanged:number;normalized:number;deterministicNewlyPassed:number;judgeCalls:number;judgePasses:number;judgeFails:number;dateEligible:number;stillWithheld:number};
const counts=():CountRow=>({reusedUnchanged:0,normalized:0,deterministicNewlyPassed:0,judgeCalls:0,judgePasses:0,judgeFails:0,dateEligible:0,stillWithheld:0});
export function mergeReassessmentDeltas(options:{frozen:unknown;frozenSha256:string;contract:ReassessmentContract;deltas:unknown[]}) {
  hashSchema.parse(options.frozenSha256);
  const validated=validateFrozenReassessment(options.frozen,options.contract),located=locatedRecords(validated),entries=new Map<string,z.infer<typeof PassEntry>>(),providers=new Set<string>();
  for(const raw of options.deltas) {
    const delta=ReassessmentDeltaSchema.parse(raw),{deltaSha256,...body}=delta;
    if(deltaSha256!==reassessmentDeltaHash(body)||delta.frozenSha256!==options.frozenSha256||delta.host!==PROVIDER_CONFIGS[delta.provider].host||providers.has(delta.provider))throw Error('Reassessment delta manifest/host binding mismatch');
    checkContract(delta.contract,options.contract);providers.add(delta.provider);
    const expected=located.filter(item=>item.task.provider===delta.provider);
    if(delta.entries.length!==expected.length)throw Error('Reassessment delta candidate coverage mismatch');
    for(const entry of delta.entries) {
      const item=expected.find(item=>item.key===entry.key);
      if(!item||entries.has(entry.key)||entry.oldEvidenceHash!==item.record.verification.evidenceHash)throw Error('Reassessment delta candidate binding mismatch');
      const assessment=assessLocated(item,validated.answers);
      if(entry.claimsSha256!==assessment.claimsSha256)throw Error('Reassessment delta normalized claim mismatch');
      if(entry.judge){checkJudge(entry.judge,assessment,options.contract);if(entry.failure)throw Error('Reassessment delta has contradictory judge evidence');}
      if(entry.judge?.origin==='cache'&&!validated.answers.some(answer=>equal(answer,entry.judge!.answer)))throw Error('Reassessment reused judgment absent from frozen evidence');
      entries.set(entry.key,entry);
    }
  }
  const results=new Map(validated.documents.map(item=>[item.task.id,structuredClone(item.result)]));
  const totals=counts(),byTypeModality:Record<string,CountRow>={},provenance:unknown[]=[];
  // Replace by identity only after collecting decisions, so original quarantine indices stay stable.
  const decisions=new Map<string,MaterializedReassessment>();
  for(const item of located) {
    const assessment=assessLocated(item,validated.answers),entry=entries.get(item.key);
    const evidence=entry?.judge??cachedJudge(assessment,validated.answers,options.contract);
    const decision=materializeReassessment(assessment,evidence,options.contract);decisions.set(item.key,decision);
    const increment=(row:CountRow)=>{
      if(!assessment.changed&&decision.admitted)row.reusedUnchanged++;
      if(assessment.normalization)row.normalized++;
      if(assessment.newlyPassed)row.deterministicNewlyPassed++;
      if(evidence?.origin==='new'||entry?.judgeAttempted)row.judgeCalls++;
      if(entry?.failure)row.judgeFails++;
      if(decision.judgePassed===true)row.judgePasses++;
      if(decision.judgePassed===false)row.judgeFails++;
      if(assessment.dateEligible)row.dateEligible++;
      if(!decision.admitted)row.stillWithheld++;
    };
    increment(totals);
    for(const relation of assessment.claims?.relations??item.record.relations){const key=relation.type+':'+relation.modality;increment(byTypeModality[key]??=(counts()));}
    provenance.push({version:REASSESSMENT_VERSION,key:item.key,taskId:item.task.id,sourceSha256:item.prepared.sourceSha256,preparedSha256:item.prepared.receiptSha256,
      originalResultSha256:item.task.resultSha256,originalEvidenceHash:item.record.verification.evidenceHash,outputEvidenceHash:decision.record.verification.evidenceHash,
      originalGeneration:item.record.extraction,claimsSha256:assessment.claimsSha256,normalization:assessment.normalization,
      judge:evidence,judgeFailure:entry?.failure??null,hold:decision.hold,admitted:decision.admitted});
  }
  for(const {task,result} of validated.documents) {
    const output=results.get(task.id)!,items=located.filter(item=>item.task.id===task.id);
    output.records=[];output.quarantine=[];
    const lookup=(location:Located['location'],index:number)=>{const item=items.find(item=>item.location===location&&item.index===index);return item?decisions.get(item.key):undefined;};
    result.records.forEach((record,index)=>{
      const decision=lookup('record',index);
      if(!decision||decision.admitted)output.records.push(decision?.record??record);
      else output.quarantine.push({documentId:'document:'+result.sourceSha256,municipalityId:record.municipalityId,sourceId:record.sources[0].id,sourceSha256:result.sourceSha256,chunk:record.extraction.chunk.index,reason:decision.hold!,candidate:decision.record});
    });
    result.quarantine.forEach((quarantine,index)=>{
      const decision=lookup('quarantine',index);
      if(decision?.admitted)output.records.push(decision.record);
      else output.quarantine.push(decision?{...quarantine,reason:decision.hold!,candidate:decision.record}:quarantine);
    });
    for(const item of items){const decision=decisions.get(item.key)!,chunk=output.chunks.find(chunk=>chunk.index===item.record.extraction.chunk.index)!;chunk.outcome=decision.admitted?'admitted':'rejected';}
    // generatedAt/prompt/schema refer to original generation; reassessment time lives outside it.
    documentResultSchema.parse(output);
  }
  const outputResults=[...results.values()],records=outputResults.flatMap(result=>result.records),quarantine=[...validated.preparation.quarantine,...outputResults.flatMap(result=>result.quarantine)];
  const outputHashes=outputResults.map(result=>({taskId:result.taskId,sha256:sha256(JSON.stringify(result,null,2)+'\n')}));
  const report={version:REASSESSMENT_VERSION,generatedAt:new Date().toISOString(),frozenSha256:options.frozenSha256,contract:options.contract,
    input:{workPlanSha256:validated.frozen.workPlan.sha256,preparationPlanSha256:validated.frozen.preparationPlan.sha256,corpusSha256:validated.preparation.corpusSha256,registrySha256:validated.preparation.registrySha256,resultSha256s:validated.documents.map(item=>({taskId:item.task.id,sha256:item.task.resultSha256})),deltaSha256s:options.deltas.map(raw=>ReassessmentDeltaSchema.parse(raw).deltaSha256)},
    output:{results:outputHashes,recordsSha256:jsonHash(records),quarantineSha256:jsonHash(quarantine),provenanceSha256:jsonHash(provenance)},
    counts:totals,byTypeModality,
    preserved:{workPlan:validated.plan,preparationCounts:{availableDocumentGroups:validated.preparation.availableDocumentGroups,selectedDocumentGroups:validated.preparation.selectedDocumentGroups,selectedRepresentations:validated.preparation.selectedRepresentations,municipalities:validated.preparation.municipalities},completedPrimary:validated.documents.length,agreementExcluded:validated.plan.tasks.filter(task=>task.purpose==='agreement').length,noCaseChunks:validated.documents.reduce((n,item)=>n+item.result.chunks.filter(chunk=>chunk.outcome==='no_case').length,0),unaffectedRecords:validated.documents.reduce((n,item)=>n+item.result.records.filter(record=>!record.relations.length).length,0),unknownCandidateQuarantine:validated.documents.reduce((n,item)=>n+item.result.quarantine.filter(entry=>!entry.candidate&&entry.reason!=='No supported case in source excerpt').length,0)},
    countUnits:{counts:'relation-bearing records; one judge call covers the whole candidate',byTypeModality:'relation occurrences; shared candidate judgment counted for each affected relation, not additive calls'},
    districtSliceAcceptance:'Individual date eligibility only; publication must separately enforce the existing district source-staged slice check.'};
  return {report,results:outputResults,records,quarantine,provenance};
}

export async function judgeReassessmentPass(raw:unknown) {
  const options=JudgePassOptionsSchema.parse(raw);assertNativeReassessmentHost(options.provider);
  const selectedPolicy=options.policy??CIVIC_POLICY_AUTHORITY,authority=await assertCivicPolicyAuthority(selectedPolicy),policy={...selectedPolicy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
  const contract=await currentReassessmentContract(),validated=await readValidatedFrozen(options.frozen,contract,policy),frozen=validated.frozen;
  const out=resolve(options.out),contentRoot=join(out,'source-content'),bindings=reassessmentBindings(validated);
  const judgeBindings=new Map(locatedRecords(validated).map(item=>[item.key,bindings]));
  await initializeManagedAcquisitionLane(contentRoot,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
  const release=await acquirePrivateRunLock(join(out,'judge-pass.lock'),'authoritative Codex judge-only reassessment');
  const controller=new AbortController(),interrupt=()=>controller.abort(Object.assign(Error('Reassessment operator pause'),{failureCategory:'operator_pause'}));
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  try {
    const delta=await executeReassessmentPass({frozen,frozenSha256:options.frozen.sha256,contract,provider:options.provider,managedRoot:contentRoot,policy,usage:{ledgerPath:options.ledgerPath,pausePath:options.pausePath,signal:controller.signal,policy},
      load:async key=>{const path=join(contentRoot,key+'.judge.json'),sourceBindings=judgeBindings.get(key);if(!sourceBindings)throw Error('Judge cache lacks its exact prepared context');try{await assertManagedSourceBindings(path,sourceBindings,policy);const evidence=JudgeEvidence.parse(JSON.parse(await readFile(path,'utf8')));await assertManagedSourceBindings(path,sourceBindings,policy);return evidence;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},
      save:async(key,evidence)=>{const sourceBindings=judgeBindings.get(key);if(!sourceBindings)throw Error('Judge cache lacks its exact prepared context');await assertPreparedSourcesActive(reassessmentReferences(validated),policy);await writeManagedSourceJson(contentRoot,join(contentRoot,key+'.judge.json'),evidence,sourceBindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});}});
    await assertPreparedSourcesActive(reassessmentReferences(validated),policy);
    const path=join(contentRoot,'delta.json');return {...await writeReassessmentArtifact(contentRoot,path,delta,bindings,policy),deltaSha256:delta.deltaSha256};
  }finally{process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);await release();}
}
export async function mergeReassessment(raw:unknown) {
  const options=MergeReassessmentOptionsSchema.parse(raw),selectedPolicy=options.policy??CIVIC_POLICY_AUTHORITY,authority=await assertCivicPolicyAuthority(selectedPolicy),policy={...selectedPolicy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
  if(authority.mode!=='isolated-fixture'&&process.platform!=='linux')throw Error('Source reassessment merge requires the authoritative Codex VM');
  await fresh(options.out);
  const contract=await currentReassessmentContract(),validated=await readValidatedFrozen(options.frozen,contract,policy),frozen=validated.frozen,bindings=reassessmentBindings(validated);
  const deltas=[];
  for(const pin of options.deltas){await assertPreparedSourcesActive(reassessmentReferences(validated),policy);await assertManagedSourceBindings(pin.path,bindings,policy);const blob=await reassessmentArtifactBlob(pin,policy);await assertManagedSourceBindings(pin.path,bindings,policy);deltas.push(decode(blob));}
  const merged=mergeReassessmentDeltas({frozen,frozenSha256:options.frozen.sha256,contract,deltas}),contentRoot=resolve(options.out);
  await initializeManagedAcquisitionLane(contentRoot,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
  const artifacts:ReassessmentArtifactPin[]=[];
  for(const result of merged.results){await assertPreparedSourcesActive(reassessmentReferences(validated),policy);artifacts.push(await writeReassessmentArtifact(contentRoot,join(contentRoot,'results',result.taskId+'.json'),result,bindings,policy));}
  for(const name of ['records','quarantine','provenance'] as const){await assertPreparedSourcesActive(reassessmentReferences(validated),policy);artifacts.push(await writeReassessmentArtifact(contentRoot,join(contentRoot,name+'.json'),merged[name],bindings,policy));}
  return {...await writeReassessmentArtifact(contentRoot,join(contentRoot,'report.json'),{...merged.report,artifacts},bindings,policy),artifacts};
}
export async function reassessmentMain(argv:string[]) {
  const [command,configPath,configSha256,...extra]=argv;
  if(!['freeze','judge-pass','merge'].includes(command)||!configPath||!configSha256||extra.length)throw Error('Usage: district-reassess-relations.ts freeze|judge-pass|merge CONFIG_JSON CONFIG_SHA256');
  if(process.platform!=='linux')throw Error('Reassessment CLI requires the authoritative Codex VM');
  const config=await readPinnedJson(configPath,configSha256);
  const selected=z.object({policy:PolicyOptions.optional()}).passthrough().parse(config).policy??CIVIC_POLICY_AUTHORITY;
  const authority=await assertCivicPolicyAuthority(selected);
  if(authority.mode!=='codex-workstation-local')throw Error('Reassessment CLI forbids fixture authority');
  const result=command==='freeze'?await freezeReassessment(config):command==='judge-pass'?await judgeReassessmentPass(config):await mergeReassessment(config);
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)reassessmentMain(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({failure:classifyWorkFailure(error)}));process.exitCode=1;});
