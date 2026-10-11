import {readFile, readdir, lstat, mkdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {DistrictKnowledgeRecordSchema, DistrictExtractionClaimsSchema, hashSchema, sha256, knowledgeEvidenceHash, REQUIRED_DETERMINISTIC_CHECKS, type DistrictKnowledgeRecord, type DistrictExtractionClaims} from './district-schema.ts';
import {normalizeRelationActions, normalizeGraphClaims, GRAPH_DETERMINISTIC_CHECKS, type RelationActionNormalization} from './district-graph-claims.ts';
import {documentChunks, restoreSourceQuotes, deterministicChecks, extractionOutputSchema, judgeSchema, judgeJSONSchema, JUDGE_INSTRUCTIONS, JUDGE_PROMPT_VERSION, JUDGE_PROMPT_SHA256, LIMITATION, type DocumentChunk} from './district-claims.ts';
import {documentResultSchema, type DocumentResult} from './district-inference.ts';
import {preparationPlanSchema, type PreparationPlan} from './district-preparation-run.ts';
import {WorkPlanSchema, restoreWorkPlan, classifyWorkFailure, WorkFailureSchema, type WorkPlan, type WorkTask} from './district-work-plan.ts';
import {verifyPreparedDocument, fetchPreparedDocument, type PreparedDocument} from './district-prepared-document.ts';
import {writePrivateJson, readPinnedJson, acquirePrivateRunLock} from './district-private-io.ts';
import {modelReadiness, subscriptionChat} from './district-model.ts';
import {isProviderStopped} from './district-model-usage.ts';
import {PROVIDER_CONFIGS, SubscriptionRuntimeError, type ExtractorProvider, type ModelEvidence, type ModelAnswer, type UsageContext} from './district-model-contract.ts';

// These artifacts are private replay evidence, not public source-text exports.
export const REASSESSMENT_VERSION = 'district-relation-reassessment-v1';
const Provider = z.enum(['openai-subscription', 'anthropic-subscription']);
const Identity = z.object({provider:Provider, tool:z.enum(['codex-cli','claude-cli']), toolVersion:z.string().min(1), model:z.string().min(1), modelIdentitySha256:hashSchema, modelIdentityBasis:z.enum(['configured-cli-model-and-tool-version','reported-cli-model-and-tool-version'])}).strict();
const Blob = z.object({sha256:hashSchema, bytes:z.string()}).strict();
type Blob = z.infer<typeof Blob>;
const AnswerBody = z.object({binding:hashSchema, modelIdentitySha256:hashSchema, receivedAt:z.iso.datetime(), value:z.unknown(), responseSha256:hashSchema, returnedModel:z.string().nullable(), runtimeWarnings:z.array(z.string())}).strict();
export const ReassessmentAnswerSchema = AnswerBody.extend({cacheSha256:hashSchema}).strict();
type Answer = z.infer<typeof ReassessmentAnswerSchema>;
const Contract = z.object({version:z.literal(REASSESSMENT_VERSION), judgePromptVersion:z.string(), judgePromptSha256:hashSchema, judgeSchemaSha256:hashSchema, assessorSha256:hashSchema, threshold:z.literal(0.8)}).strict();
export type ReassessmentContract = z.infer<typeof Contract>;
export const FrozenReassessmentSchema = z.object({
  version:z.literal(REASSESSMENT_VERSION), frozenAt:z.iso.datetime(), contract:Contract,
  workPlan:Blob, preparationPlan:Blob,
  documents:z.array(z.object({taskId:hashSchema, result:Blob, prepared:Blob}).strict()),
  answers:z.array(Blob),
}).strict();
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
export const FreezeReassessmentOptionsSchema = z.object({
  workPlan:Pin, preparationPlan:Pin, resultRoot:z.string().min(1),
  // null uses the existing authenticated, hash-pinned VM receipt transport.
  preparedRoot:z.string().min(1).nullable(), cacheRoots:z.array(z.string().min(1)), out:z.string().min(1),
}).strict();
export const JudgePassOptionsSchema = z.object({frozen:Pin, provider:Provider, out:z.string().min(1), ledgerPath:z.string().min(1), pausePath:z.string().min(1)}).strict();
export const MergeReassessmentOptionsSchema = z.object({frozen:Pin, deltas:z.array(Pin), out:z.string().min(1)}).strict();

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
  const {modelIdentitySha256,...body}=identity, config=PROVIDER_CONFIGS[identity.provider];
  if(!config||identity.model!==config.model||identity.tool!==config.tool||identity.modelIdentityBasis!==config.modelIdentityBasis||modelIdentitySha256!==jsonHash(body))throw Error('Reassessment model identity binding mismatch');
}
export function assertNativeReassessmentHost(provider:ExtractorProvider, platform:NodeJS.Platform=process.platform) {
  if(platform!==(provider==='openai-subscription'?'linux':'darwin'))throw Error('Reassessment judge must run on its authorized native host');
}
export async function currentReassessmentContract():Promise<ReassessmentContract> {
  const files=['district-reassess-relations.ts','district-claims.ts','district-schema.ts','district-graph-claims.ts','district-model.ts','district-model-contract.ts','district-claude.ts','district-model-usage.ts','district-model-diagnostics.ts','district-private-io.ts','district-prepared-document.ts'];
  const hashes=await Promise.all(files.map(async name=>({name,sha256:sha256(await readFile(new URL(name,import.meta.url)))})));
  return {version:REASSESSMENT_VERSION,judgePromptVersion:JUDGE_PROMPT_VERSION,judgePromptSha256:JUDGE_PROMPT_SHA256,judgeSchemaSha256:jsonHash(judgeJSONSchema),assessorSha256:jsonHash(hashes),threshold:0.8};
}
function checkContract(contract:ReassessmentContract, current:ReassessmentContract) {
  if(!equal(contract,current)||contract.judgePromptVersion!==JUDGE_PROMPT_VERSION||contract.judgePromptSha256!==JUDGE_PROMPT_SHA256||contract.judgeSchemaSha256!==jsonHash(judgeJSONSchema))throw Error('Reassessment current fact judge contract mismatch');
}
async function pinnedBlob(pin:z.infer<typeof Pin>):Promise<Blob> {
  await readPinnedJson(pin.path,pin.sha256,512*1024*1024);
  const bytes=await readFile(pin.path,'utf8');
  if(sha256(bytes)!==pin.sha256)throw Error('Reassessment pinned file changed during read');
  return {sha256:pin.sha256,bytes};
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
export function validateFrozenReassessment(input:unknown,current:ReassessmentContract):Validated {
  const frozen=FrozenReassessmentSchema.parse(input);checkContract(frozen.contract,current);
  const plan=WorkPlanSchema.parse(decode(frozen.workPlan)),preparation=preparationPlanSchema.parse(decode(frozen.preparationPlan));
  if(plan.tasks.some(task=>task.state==='running'))throw Error('Reassessment requires a stopped frozen work plan');
  restoreWorkPlan(plan); // Validate derived assignments without rewriting the frozen plan.
  const tasks=plan.tasks.filter(task=>task.purpose==='production'&&task.state==='completed');
  if(tasks.length!==frozen.documents.length||new Set(frozen.documents.map(item=>item.taskId)).size!==tasks.length)throw Error('Reassessment completed primary inventory mismatch');
  const documents=frozen.documents.map(item=>{
    const task=tasks.find(task=>task.id===item.taskId);
    if(!task||task.resultSha256!==item.result.sha256)throw Error('Reassessment completed result receipt mismatch');
    const result=documentResultSchema.parse(decode(item.result));checkResult(result,task,plan);
    const prepared=verifyPreparedDocument(decode(item.prepared),taskGroup(preparation,task).expected);
    let chunks:DocumentChunk[];
    try { chunks=documentChunks(prepared.text); }
    catch(error) {
      if(!(error instanceof Error)||error.message!=='Document exceeds model chunk limit')throw error;
      const expected={documentId:'document:'+prepared.sourceSha256,municipalityId:prepared.municipalityId,sourceId:prepared.references[0].id,sourceSha256:prepared.sourceSha256,chunk:null,reason:'Document exceeds model chunk limit; entire document quarantined before model readiness (no truncation or model calls)'};
      if(result.records.length||result.chunks.length||!equal(result.quarantine,[expected]))throw Error('Reassessment whole-document budget evidence mismatch');
      return {task,result,prepared};
    }
    if(result.chunks.length!==chunks.length||new Set(result.chunks.map(chunk=>chunk.index)).size!==chunks.length||result.chunks.some(chunk=>!chunks.some(source=>source.index===chunk.index)))throw Error('Reassessment original chunk coverage mismatch');
    return {task,result,prepared};
  });
  const answers=frozen.answers.map(blob=>checkedAnswer(decode(blob)));
  if(new Set(answers.map(answer=>answer.binding)).size!==answers.length)throw Error('Reassessment duplicate answer binding');
  return {frozen,plan,preparation,documents,answers};
}
export async function freezeReassessment(raw:unknown):Promise<{path:string;sha256:string}> {
  const options=FreezeReassessmentOptionsSchema.parse(raw);await fresh(options.out);
  const workPlan=await pinnedBlob(options.workPlan),preparationPlan=await pinnedBlob(options.preparationPlan);
  const plan=WorkPlanSchema.parse(decode(workPlan)),preparation=preparationPlanSchema.parse(decode(preparationPlan));
  if(plan.tasks.some(task=>task.state==='running'))throw Error('Reassessment cannot freeze an active work plan');
  restoreWorkPlan(plan);
  const documents:FrozenReassessment['documents']=[],responses=new Set<string>();
  for(const task of plan.tasks.filter(task=>task.purpose==='production'&&task.state==='completed')) {
    if(!task.resultSha256)throw Error('Reassessment completed task lacks a result hash');
    const result=await pinnedBlob({path:join(options.resultRoot,task.id+'.json'),sha256:task.resultSha256});
    const parsed=documentResultSchema.parse(decode(result));checkResult(parsed,task,plan);
    for(const chunk of parsed.chunks)if(chunk.responseSha256)responses.add(chunk.responseSha256);
    const expected=taskGroup(preparation,task).expected;
    let prepared:Blob;
    if(options.preparedRoot)prepared=await fileBlob(join(options.preparedRoot,expected.receiptSha256+'.json'));
    else {const receipt=await fetchPreparedDocument(expected),bytes=JSON.stringify(receipt);prepared={bytes,sha256:sha256(bytes)};}
    verifyPreparedDocument(decode(prepared),expected);documents.push({taskId:task.id,result,prepared});
  }
  const answers=new Map<string,Blob>();
  for(const root of options.cacheRoots)for(const entry of await readdir(root,{withFileTypes:true})) {
    if(!entry.isFile()||!entry.name.endsWith('.answer.json'))continue;
    const blob=await fileBlob(join(root,entry.name)),answer=checkedAnswer(decode(blob));
    if(!responses.has(answer.responseSha256)&&!judgeSchema.safeParse(answer.value).success)continue;
    const previous=answers.get(answer.binding);
    if(previous&&!equal(decode(previous),decode(blob)))throw Error('Reassessment conflicting original answer cache');
    answers.set(answer.binding,blob);
  }
  const frozen:FrozenReassessment={version:REASSESSMENT_VERSION,frozenAt:new Date().toISOString(),contract:await currentReassessmentContract(),workPlan,preparationPlan,documents,answers:[...answers.values()]};
  validateFrozenReassessment(frozen,frozen.contract);
  return {path:options.out,sha256:await writePrivateJson(options.out,frozen)};
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
  deterministic:ReturnType<typeof deterministicChecks>|null; changed:boolean; newlyPassed:boolean;
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
export function reassessmentJudgeBinding(provider:ExtractorProvider,identity:ModelEvidence,input:unknown):string {
  return jsonHash({provider,modelIdentitySha256:identity.modelIdentitySha256,system:JUDGE_INSTRUCTIONS,input,schema:judgeJSONSchema});
}
export function assessExistingRelation(input:{key:string;record:DistrictKnowledgeRecord;prepared:PreparedDocument;municipalityName:string;answers:Answer[]}):RelationAssessment {
  const {record,prepared}=input;
  const base:RelationAssessment={key:input.key,original:record,claims:null,normalization:null,quoteNormalization:record.extraction.quoteNormalization,deterministic:null,changed:false,newlyPassed:false,dateEligible:false,needsJudge:false,hold:null,judgeInput:null,judgeBinding:null,claimsSha256:null};
  const hold=(reason:string)=>({...base,hold:reason});
  if(record.extraction.inputSha256!==prepared.sourceSha256||record.extraction.textSha256!==prepared.textSha256||record.municipalityId!==prepared.municipalityId)return hold('source_binding_unknown');
  const chunk=documentChunks(prepared.text).find(chunk=>chunk.index===record.extraction.chunk.index);
  if(!chunk||!equal(record.extraction.chunk,{index:chunk.index,count:chunk.count,start:chunk.start,end:chunk.end}))return hold('source_chunk_binding_unknown');
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
    judgeInput,judgeBinding:reassessmentJudgeBinding(record.extraction.provider,identityOf(record),judgeInput),claimsSha256:jsonHash(claims)};
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
  readiness:(provider:ExtractorProvider,signal?:AbortSignal)=>Promise<ModelEvidence>;
  judge:(provider:ExtractorProvider,system:string,input:unknown,schema:unknown,usage:UsageContext)=>Promise<ModelAnswer>;
  stopped:(path:string,provider:ExtractorProvider)=>Promise<boolean>;
};
const nativeRuntime:JudgeOnlyRuntime={readiness:modelReadiness,judge:subscriptionChat,stopped:isProviderStopped};
export async function executeReassessmentPass(options:{frozen:unknown;frozenSha256:string;contract:ReassessmentContract;provider:ExtractorProvider;usage:Omit<UsageContext,'purpose'>;platform?:NodeJS.Platform;runtime?:JudgeOnlyRuntime;load?:(key:string)=>Promise<ReassessmentJudgeEvidence|null>;save?:(key:string,evidence:ReassessmentJudgeEvidence)=>Promise<void>}):Promise<ReassessmentDelta> {
  assertNativeReassessmentHost(options.provider,options.platform);hashSchema.parse(options.frozenSha256);
  const validated=validateFrozenReassessment(options.frozen,options.contract),runtime=options.runtime??nativeRuntime;
  const entries:ReassessmentDelta['entries']=[];
  let identity:ModelEvidence|null=null,stopped=false;
  for(const item of locatedRecords(validated).filter(item=>item.task.provider===options.provider)) {
    const assessment=assessLocated(item,validated.answers);
    const entry:z.infer<typeof PassEntry>={key:item.key,oldEvidenceHash:item.record.verification.evidenceHash,claimsSha256:assessment.claimsSha256,judge:null,judgeAttempted:false,failure:null};
    entries.push(entry);
    if(!assessment.needsJudge||stopped)continue;
    entry.judge=cachedJudge(assessment,validated.answers,options.contract);
    if(entry.judge)continue;
    const saved=await options.load?.(item.key);
    if(saved){checkJudge(saved,assessment,options.contract);entry.judge=saved;entry.judgeAttempted=saved.origin==='new';continue;}
    try {
      options.usage.signal?.throwIfAborted();
      if(await runtime.stopped(options.usage.pausePath,options.provider))throw Object.assign(Error('Reassessment operator paused'),{failureCategory:'operator_pause'});
      identity??=await runtime.readiness(options.provider,options.usage.signal);checkIdentity(identity);
      options.usage.signal?.throwIfAborted();
      if(!equal(identity,identityOf(item.record)))throw Object.assign(Error('Reassessment native model identity mismatch'),{failureCategory:'model_identity_mismatch'});
      entry.judgeAttempted=true;
      const answer=await runtime.judge(options.provider,JUDGE_INSTRUCTIONS,assessment.judgeInput,judgeJSONSchema,{...options.usage,purpose:'judge',groupId:item.task.groupId});
      if(!equal(answer.evidence,identity)||answer.requestedModel!==identity.model||answer.returnedModel!==null&&answer.returnedModel!==identity.model||answer.reportedModels.some(model=>model!==identity!.model))throw Object.assign(Error('Reassessment returned model identity mismatch'),{failureCategory:'model_identity_mismatch'});
      const body=AnswerBody.parse({binding:assessment.judgeBinding,modelIdentitySha256:identity.modelIdentitySha256,receivedAt:new Date().toISOString(),value:answer.value,responseSha256:answer.responseSha256,returnedModel:answer.returnedModel,runtimeWarnings:answer.runtimeWarnings});
      entry.judge={contract:options.contract,inputSha256:jsonHash(assessment.judgeInput),identity,answer:sealAnswer(body),origin:'new'};
      checkJudge(entry.judge,assessment,options.contract);
      await options.save?.(item.key,entry.judge);
    }catch(error){
      if(error instanceof SubscriptionRuntimeError&&error.diagnostic)entry.judgeAttempted=error.diagnostic.attempted;
      entry.judge=null;entry.failure=classifyWorkFailure(error);stopped=true;
    }
  }
  const body={version:REASSESSMENT_VERSION as typeof REASSESSMENT_VERSION,frozenSha256:options.frozenSha256,contract:options.contract,provider:options.provider,host:PROVIDER_CONFIGS[options.provider].host,generatedAt:new Date().toISOString(),entries};
  return ReassessmentDeltaSchema.parse({...body,deltaSha256:reassessmentDeltaHash(body)});
}

function heldRecord(record:DistrictKnowledgeRecord,reason:string):DistrictKnowledgeRecord {
  const result={...record,verification:{...record.verification,status:'candidate' as const,reason,evidenceHash:''}};
  result.verification.evidenceHash=knowledgeEvidenceHash(result);return DistrictKnowledgeRecordSchema.parse(result);
}
export function materializeReassessment(assessment:RelationAssessment,evidence:ReassessmentJudgeEvidence|null,contract:ReassessmentContract):{record:DistrictKnowledgeRecord;admitted:boolean;hold:string|null;judgePassed:boolean|null} {
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
  let graph:ReturnType<typeof normalizeGraphClaims>;
  try{graph=normalizeGraphClaims(claims,{municipalityId:original.municipalityId,sourceSha256:original.extraction.inputSha256});}
  catch{return {record:heldRecord(original,'graph_identity_unknown'),admitted:false,hold:'graph_identity_unknown',judgePassed};}
  const admitted=!hold&&deterministic.passed&&assessment.dateEligible&&(!assessment.needsJudge||judgePassed===true);
  const candidate={...original,...claims,...graph,caseKey:original.caseKey,
    extraction:{...original.extraction,quoteNormalization:assessment.quoteNormalization,...(assessment.normalization?{relationNormalization:{...assessment.normalization,sourceSha256:original.extraction.inputSha256,textSha256:original.extraction.textSha256,responseSha256:original.extraction.responseSha256}}:{})},
    verification:{status:admitted?'auto-verified' as const:'candidate' as const,deterministic,faithfulness,evidenceHash:'',...(!admitted?{reason:hold??'reassessment_withheld'}:{})}};
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
  const decisions=new Map<string,ReturnType<typeof materializeReassessment>>();
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
  const frozen=await readPinnedJson(options.frozen.path,options.frozen.sha256,512*1024*1024),contract=await currentReassessmentContract();
  const out=resolve(options.out);await mkdir(out,{recursive:true,mode:0o700});
  const release=await acquirePrivateRunLock(join(out,'judge-pass.lock'),'native judge-only cached relation reassessment');
  const controller=new AbortController(),interrupt=()=>controller.abort(Object.assign(Error('Reassessment operator pause'),{failureCategory:'operator_pause'}));
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  try {
    const delta=await executeReassessmentPass({frozen,frozenSha256:options.frozen.sha256,contract,provider:options.provider,usage:{ledgerPath:options.ledgerPath,pausePath:options.pausePath,signal:controller.signal},
      load:async key=>{try{return JudgeEvidence.parse(JSON.parse(await readFile(join(out,key+'.judge.json'),'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},
      save:async(key,evidence)=>{await writePrivateJson(join(out,key+'.judge.json'),evidence);}});
    const path=join(out,'delta.json');return {path,sha256:await writePrivateJson(path,delta),deltaSha256:delta.deltaSha256};
  }finally{process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);await release();}
}
export async function mergeReassessment(raw:unknown) {
  const options=MergeReassessmentOptionsSchema.parse(raw);await fresh(options.out);
  const frozen=await readPinnedJson(options.frozen.path,options.frozen.sha256,512*1024*1024),contract=await currentReassessmentContract();
  const deltas=await Promise.all(options.deltas.map(pin=>readPinnedJson(pin.path,pin.sha256,512*1024*1024)));
  const merged=mergeReassessmentDeltas({frozen,frozenSha256:options.frozen.sha256,contract,deltas});
  await mkdir(options.out,{recursive:false,mode:0o700});
  const artifacts=[];
  for(const result of merged.results){const path=join(options.out,'results',result.taskId+'.json');artifacts.push({path,sha256:await writePrivateJson(path,result)});}
  for(const name of ['records','quarantine','provenance'] as const){const path=join(options.out,name+'.json');artifacts.push({path,sha256:await writePrivateJson(path,merged[name])});}
  const path=join(options.out,'report.json'),sha256=await writePrivateJson(path,{...merged.report,artifacts});return {path,sha256,artifacts};
}
export async function reassessmentMain(argv:string[]) {
  const [command,configPath,configSha256,...extra]=argv;
  if(!['freeze','judge-pass','merge'].includes(command)||!configPath||!configSha256||extra.length)throw Error('Usage: district-reassess-relations.ts freeze|judge-pass|merge CONFIG_JSON CONFIG_SHA256');
  const config=await readPinnedJson(configPath,configSha256);
  const result=command==='freeze'?await freezeReassessment(config):command==='judge-pass'?await judgeReassessmentPass(config):await mergeReassessment(config);
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)reassessmentMain(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({failure:classifyWorkFailure(error)}));process.exitCode=1;});
