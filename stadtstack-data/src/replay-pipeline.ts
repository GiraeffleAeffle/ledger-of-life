import {readFile,lstat,realpath} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {outDir,hash} from './common.ts';
import {hashSchema,knowledgeEvidenceHash} from './district-schema.ts';
import type {DistrictKnowledgeRecord} from './district-schema.ts';
import {ReassessmentAnswerSchema} from './district-reassess-relations.ts';
import type {PreparedDocument} from './district-prepared-document.ts';
import type {DocumentResult,MunicipalityBinding} from './district-inference.ts';
import type {ModelEvidence} from './district-model-contract.ts';
import {prepareKnowledge,prepareKnowledgeOptionsSchema,type KnowledgeSourcePin,type KnowledgeAuditPin} from './prepare-knowledge.ts';
import {publish} from './publish.ts';
import {PublicationPlanSchema,type PublicationPlan} from './district-publication-plan.ts';
import {assertCivicPolicyAuthority,assertManagedSourceReadable,CIVIC_POLICY_AUTHORITY,type CivicPolicyOptions} from './civic-opt-out.ts';
import {dataReleaseSchema,dataReleaseId,verifyDataRelease} from './data-release.ts';
import type {DataRelease} from './data-release.ts';
import type * as ClaimsModule from './district-claims.ts';
import type * as SchemaModule from './district-schema.ts';
import type * as GraphModule from './district-graph-claims.ts';
import type * as VocabularyModule from './topic-vocabulary.ts';
import type * as ModelModule from './district-model-contract.ts';
import type {DocumentChunk} from './district-claims.ts';

const Pin=z.object({path:z.string().min(1),sha256:hashSchema}).strict();
export type ReplayPin=z.infer<typeof Pin>;
const Identity=z.object({provider:z.enum(['openai-subscription','anthropic-subscription']),tool:z.enum(['codex-cli','claude-cli']),toolVersion:z.string().min(1),model:z.string().min(1),modelIdentitySha256:hashSchema,modelIdentityBasis:z.enum(['configured-cli-model-and-tool-version','reported-cli-model-and-tool-version'])}).strict();
const stagePath=z.string().regex(/^(?:catalogue\.json|cities\/[a-z0-9-]+\/(?:signals\.geojson|feed\.json)|regions\/brandenburg-mol\/topics\.json|core\/strausberg-facts\.json)$/);
export const ReplayClocksSchema=z.object({recordsGeneratedAt:z.iso.datetime(),quarantineGeneratedAt:z.iso.datetime(),coverageGeneratedAt:z.iso.datetime(),qualityGeneratedAt:z.iso.datetime(),manifestGeneratedAt:z.iso.datetime()}).strict();
export type ReplayClocks=z.infer<typeof ReplayClocksSchema>;
/** Historical v1 receipts remain inspectable audit data, never executable input. */
export const HistoricalReplayReceiptSchema=z.object({
 schemaVersion:z.literal('stadtstack-offline-replay-v1'),
 corpusManifest:Pin,rawRoot:z.string().min(1),registry:Pin,index:Pin,
 frozen:Pin,deltas:z.array(Pin),generationContract:Pin,answers:z.array(Pin),modelIdentities:z.array(Identity).min(1),extractionRun:Pin,
 clocks:ReplayClocksSchema,
 staging:z.array(Pin.extend({destination:stagePath}).strict()).min(1),
 coreEvidence:z.array(z.object({path:z.string().regex(/^(?:pdf\/[a-f0-9]{64}\.pdf|core-evidence\/[a-f0-9]{64}\.json)$/),sha256:hashSchema}).strict()).min(1),
 priorRelease:z.object({gitCommit:z.string().regex(/^[a-f0-9]{40}$/),manifestSha256:hashSchema,releaseId:hashSchema}).strict(),
 expectedRelease:Pin,
 runtime:z.object({node:z.string().min(1),icu:z.string().min(1),unicode:z.string().min(1),locale:z.string().min(1),timeZone:z.string().min(1),packageLockSha256:hashSchema,sourceFiles:z.array(Pin).min(1)}).strict(),
 workspace:z.string().min(1),
}).strict();
export type HistoricalReplayReceipt=z.infer<typeof HistoricalReplayReceiptSchema>;
export const ReplayReceiptSchema=z.object({
 schemaVersion:z.literal('stadtstack-pipeline-replay-v2'),
 knowledgeIntake:Pin,publicationPlan:Pin,expectedManifest:Pin,clocks:ReplayClocksSchema,
}).strict();
export type ReplayReceipt=z.infer<typeof ReplayReceiptSchema>;
type Answer=z.infer<typeof ReassessmentAnswerSchema>;
const GenerationArchiveSchema=z.object({schemaVersion:z.literal('stadtstack-extraction-contract-archive-v1'),archivedAt:z.iso.datetime(),promptSha256:hashSchema,schemaSha256:hashSchema,extractorSha256:hashSchema,extractorVersion:z.literal('district-extractor-v8-joint-graph'),promptVersion:z.string().min(1),judgePromptVersion:z.string().min(1),judgePromptSha256:hashSchema,extractionInstructions:z.string().min(1),judgeInstructions:z.string().min(1),outputSchema:z.record(z.string(),z.unknown()),judgeSchema:z.record(z.string(),z.unknown()),sources:z.array(z.object({name:z.string(),sha256:hashSchema,code:z.string()}).strict())}).strict();
type GenerationArchive=z.infer<typeof GenerationArchiveSchema>;
export type HistoricalGeneration={archive:GenerationArchive;claims:typeof ClaimsModule;schema:typeof SchemaModule;graph:typeof GraphModule;vocabulary:typeof VocabularyModule;models:typeof ModelModule};
const archiveFiles=['district-claims.ts','district-inference.ts','district-model.ts','district-claude.ts','district-model-contract.ts','district-model-usage.ts','district-model-diagnostics.ts','district-schema.ts','district-graph-claims.ts','topic-vocabulary.ts','../regional/taxonomy.mjs'];
const jsonHash=(value:unknown)=>hash(JSON.stringify(value));
function requireEqual(actual:unknown,expected:unknown,message:string){if(!isDeepStrictEqual(actual,expected))throw Error(message);}
function inside(parent:string,path:string){const name=relative(parent,path);return !!name&&!name.startsWith('..')&&!isAbsolute(name);}

/** Pinned metadata only; each caller immediately parses its strict receipt/plan/manifest schema. */
async function readReplayMetadataPin(pin:ReplayPin,base:string,policy:CivicPolicyOptions,expectedManifest=false):Promise<Buffer>{
 await assertCivicPolicyAuthority(policy);
 hashSchema.parse(pin.sha256);
 const path=await realpath(resolve(base,pin.path)),target=await realpath(outDir).catch(()=>resolve(outDir));
 if((path===target||inside(target,path))&&!(expectedManifest&&path===join(target,'release-manifest.json')))throw Error('Replay forbids target release members as reconstruction inputs');
 const metadata=await lstat(path);
 if(!metadata.isFile()||metadata.size>32*1024*1024)throw Error('Replay pinned metadata size/type rejected');
 const bytes=await readFile(path);
 if(bytes.length!==metadata.size||hash(bytes)!==pin.sha256)throw Error('Replay pinned artifact digest mismatch');
 await assertCivicPolicyAuthority(policy);
 return bytes;
}

/** Source-bearing pins are readable only under their actual managed provenance and current authority. */
export async function readReplayPin(pin:ReplayPin,base:string,policy:CivicPolicyOptions):Promise<Buffer>{
 await assertCivicPolicyAuthority(policy);
 const path=await realpath(resolve(base,pin.path)),target=await realpath(outDir).catch(()=>resolve(outDir));
 if(path===target||inside(target,path))throw Error('Replay forbids target release members as reconstruction inputs');
 await assertManagedSourceReadable(path,policy);
 const metadata=await lstat(path);if(!metadata.isFile()||metadata.size>512*1024*1024)throw Error('Replay pinned artifact size/type rejected');
 const bytes=await readFile(path);
 if(bytes.length!==metadata.size||hash(bytes)!==pin.sha256)throw Error('Replay pinned artifact digest mismatch');
 await assertManagedSourceReadable(path,policy);
 return bytes;
}

function replayJson(bytes:Uint8Array):unknown{
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('Replay pinned JSON invalid');}
}
export function verifyReplayAnswer(raw:unknown):Answer{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Replay answer envelope invalid');
 const {cacheSha256,...body}=raw as Record<string,unknown>;
 // The historical cache seal uses the ORIGINAL JSON field order, not canonical JSON.
 if(cacheSha256!==jsonHash(body))throw Error('Replay answer envelope digest mismatch');
 return ReassessmentAnswerSchema.parse(raw);
}
export function verifyGenerationArchive(raw:unknown):GenerationArchive{
 const archive=GenerationArchiveSchema.parse(raw);
 requireEqual(archive.sources.map(source=>source.name),archiveFiles,'Replay historical extractor source inventory mismatch');
 if(archive.sources.some(source=>hash(source.code)!==source.sha256)||archive.extractorSha256!==jsonHash({version:archive.extractorVersion,hashes:archive.sources.map(source=>source.sha256)})||archive.schemaSha256!==jsonHash(archive.outputSchema)||archive.judgePromptSha256!==jsonHash({system:archive.judgeInstructions,schema:archive.judgeSchema}))throw Error('Replay historical generation contract digest mismatch');
 return archive;
}
function checkIdentities(identities:ModelEvidence[],historical:HistoricalGeneration){
 if(new Set(identities.map(identity=>identity.modelIdentitySha256)).size!==identities.length)throw Error('Replay duplicate historical model identity');
 for(const identity of identities){
  const {provider,tool,toolVersion,model,modelIdentityBasis}=identity,configured=historical.models.PROVIDER_CONFIGS[provider];
  if(!configured||model!==configured.model||tool!==configured.tool||modelIdentityBasis!==configured.modelIdentityBasis||identity.modelIdentitySha256!==jsonHash({provider,tool,toolVersion,model,modelIdentityBasis}))throw Error('Replay historical model identity mismatch');
 }
}
export function replayAnswerBinding(identity:ModelEvidence,system:string,input:unknown,schema:object){return jsonHash({provider:identity.provider,modelIdentitySha256:identity.modelIdentitySha256,system,input,schema});}
function boundAnswer(answers:Map<string,Answer>,identity:ModelEvidence,system:string,input:unknown,schema:object):Answer{
 const binding=replayAnswerBinding(identity,system,input,schema),answer=answers.get(binding);
 if(!answer)throw Error('Replay bound historical answer missing; live generation is forbidden');
 if(answer.modelIdentitySha256!==identity.modelIdentitySha256||answer.returnedModel!==null&&answer.returnedModel!==identity.model)throw Error('Replay answer model binding mismatch');
 return answer;
}

/** Verify completed results against the ORIGINAL generation implementation and actual
 * sealed answers. This is not inferPreparedDocument: no readiness/cache-miss path exists.
 * Nothing from this check replaces original record metadata or factual dates.
 */
export function verifyCachedGeneration(input:{result:DocumentResult;prepared:PreparedDocument;municipality:MunicipalityBinding;historical:HistoricalGeneration;identities:ModelEvidence[];answers:Map<string,Answer>}):{generationAnswers:number;judgeAnswers:number}{
 const {result,prepared,municipality,historical,identities,answers}=input,{claims,schema,graph,archive}=historical;
 checkIdentities(identities,historical);
 if(result.promptSha256!==jsonHash({extraction:archive.promptSha256,judge:archive.judgePromptSha256,extractorSha256:archive.extractorSha256})||result.schemaSha256!==archive.schemaSha256||result.municipalityId!==municipality.id||prepared.municipalityId!==municipality.id||result.sourceSha256!==prepared.sourceSha256||result.preparedSha256!==prepared.receiptSha256)throw Error('Replay original result contract binding mismatch');
 let chunks:DocumentChunk[];
 try{chunks=claims.documentChunks(prepared.text);}catch(error){
  if(!(error instanceof Error)||error.message!=='Document exceeds model chunk limit'||result.chunks.length||result.records.length||result.quarantine.length!==1||result.quarantine[0].reason!=='Document exceeds model chunk limit; entire document quarantined before model readiness (no truncation or model calls)')throw Error('Replay original chunk budget evidence mismatch');
  return {generationAnswers:0,judgeAnswers:0};
 }
 if(result.chunks.length!==chunks.length)throw Error('Replay historical chunk coverage mismatch');
 let generationAnswers=0,judgeAnswers=0;
 const candidates=[...result.records,...result.quarantine.flatMap(item=>item.candidate?[item.candidate]:[])];
 if(candidates.some(record=>!chunks.some(chunk=>chunk.index===record.extraction.chunk.index))||result.quarantine.some(item=>item.municipalityId!==municipality.id||item.sourceSha256!==prepared.sourceSha256||item.sourceId!==prepared.references[0].id||item.documentId!=='document:'+prepared.sourceSha256||!chunks.some(chunk=>chunk.index===item.chunk))||result.quarantine.length!==result.chunks.filter(chunk=>chunk.outcome!=='admitted').length)throw Error('Replay original candidate/quarantine inventory mismatch');
 for(const chunk of chunks){
  const outcomes=result.chunks.filter(item=>item.index===chunk.index),found=candidates.filter(record=>record.extraction.chunk.index===chunk.index);
  if(outcomes.length!==1||found.length>1)throw Error('Replay original chunk result inventory mismatch');
  const outcome=outcomes[0],record=found[0],sourceInput={municipality:{id:municipality.id,name:municipality.name},vocabulary:historical.vocabulary.TOPIC_VOCABULARY.map(({pattern:_pattern,...topic})=>topic),source:{text:chunk.text}};
  const possible=identities.filter(identity=>identity.provider===result.provider&&(!record||identity.modelIdentitySha256===record.extraction.modelIdentitySha256)).flatMap(identity=>{const answer=answers.get(replayAnswerBinding(identity,archive.extractionInstructions,sourceInput,archive.outputSchema));return answer&&answer.responseSha256===outcome.responseSha256?[{identity,answer}]:[];});
  if(possible.length!==1)throw Error('Replay bound historical extraction answer missing or ambiguous; live generation is forbidden');
  const {identity}=possible[0],answer=boundAnswer(answers,identity,archive.extractionInstructions,sourceInput,archive.outputSchema);generationAnswers++;
  const decoded=claims.extractionOutputSchema.safeParse(answer.value);
  const rejectWithoutCandidate=(reason:string,kind:'rejected'|'no_case')=>{
   if(record||outcome.recordId!==null||outcome.outcome!==kind)throw Error('Replay original withheld outcome mismatch');
   const quarantine=result.quarantine.filter(item=>item.chunk===chunk.index);
   if(quarantine.length!==1||quarantine[0].candidate||quarantine[0].reason!==reason)throw Error('Replay original explicit hold mismatch');
  };
  if(!decoded.success){rejectWithoutCandidate('Structured output/schema validation failed','rejected');continue;}
  if(!decoded.data.record){rejectWithoutCandidate('No supported case in source excerpt','no_case');continue;}
  const restored=claims.restoreSourceQuotes(decoded.data.record,chunk.text,chunk.start),candidateClaims=restored.claims,deterministic=claims.deterministicChecks(candidateClaims,chunk.text,municipality.name);
  let faithfulness:DistrictKnowledgeRecord['verification']['faithfulness']={score:null,threshold:0.8,model:identity.model,provider:identity.provider,tool:identity.tool,toolVersion:identity.toolVersion,modelIdentitySha256:identity.modelIdentitySha256,returnedModel:null,reason:'Not evaluated: deterministic gate failed',evaluatedAt:null,responseSha256:null,sameModel:true,limitation:claims.LIMITATION};
  if(deterministic.passed){
   const judgment=boundAnswer(answers,identity,archive.judgeInstructions,{source:{text:chunk.text},candidate:candidateClaims},archive.judgeSchema);judgeAnswers++;
   const judged=claims.judgeSchema.safeParse(judgment.value);
   if(judged.success){faithfulness={...faithfulness,score:judged.data.score,reason:judged.data.reason,evaluatedAt:judgment.receivedAt,responseSha256:judgment.responseSha256,returnedModel:judgment.returnedModel,runtimeWarnings:judgment.runtimeWarnings};if(judged.data.criticalUnsupported)deterministic.checks.push({id:'judge_critical_claims',passed:false,reason:'Actual model judge found a critically unsupported claim'});deterministic.passed=deterministic.checks.every(check=>check.passed);}
   else faithfulness.reason='Actual judge returned invalid structured output';
  }
  const passed=deterministic.passed&&faithfulness.score!==null&&faithfulness.score>=0.8&&faithfulness.responseSha256!==null;
  let rebuilt:DistrictKnowledgeRecord;
  try{
   const normalizedGraph=graph.normalizeGraphClaims(candidateClaims,{municipalityId:municipality.id,sourceSha256:prepared.sourceSha256}),caseKey=candidateClaims.caseKey??`source_document:${prepared.sourceSha256}`;
   const references=prepared.references.map(reference=>({...reference,locator:`text-sha256:${prepared.textSha256};chars:${chunk.start}-${chunk.end}`}));
   const cacheKey=claims.extractionCacheKey({provider:identity.provider,documentHash:prepared.sourceSha256,textHash:prepared.textSha256,extractorHash:archive.extractorSha256,modelIdentitySha256:identity.modelIdentitySha256,chunk:{index:chunk.index,start:chunk.start,end:chunk.end},municipalityId:municipality.id,sourceBinding:JSON.stringify(municipality)});
   const candidate={...candidateClaims,...normalizedGraph,id:`knowledge:${municipality.id}:${hash(`${caseKey}\n${prepared.sourceSha256}\n${chunk.index}`).slice(0,24)}`,municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,caseKey,sources:references,
    extraction:{extractorVersion:archive.extractorVersion,extractorSha256:archive.extractorSha256,...identity,returnedModel:answer.returnedModel,runtimeWarnings:answer.runtimeWarnings,quoteNormalization:restored.normalization,promptVersion:archive.promptVersion,promptSha256:archive.promptSha256,judgePromptVersion:archive.judgePromptVersion,judgePromptSha256:archive.judgePromptSha256,inputSha256:prepared.sourceSha256,textSha256:prepared.textSha256,responseSha256:answer.responseSha256,ocrUsed:prepared.ocrUsed,textMethod:prepared.method,documentLimitations:[...prepared.limitations,historical.models.PROVIDER_CONFIGS[identity.provider].toolLimitation],cacheKey,extractedAt:answer.receivedAt,chunk:{index:chunk.index,count:chunk.count,start:chunk.start,end:chunk.end}},
    verification:{status:passed?'auto-verified' as const:'candidate' as const,deterministic,faithfulness,evidenceHash:'',...(!passed?{reason:!deterministic.passed?deterministic.checks.filter(check=>!check.passed).map(check=>check.id).join(', '):'Faithfulness gate not passed'}:{})}};
   candidate.verification.evidenceHash=schema.knowledgeEvidenceHash(candidate);
   rebuilt=claims.rebindSourceReferences(schema.DistrictKnowledgeRecordSchema.parse(candidate),references);
  }catch(error){rejectWithoutCandidate(claims.safeFailure(error),'rejected');continue;}
  if(!record||record.id!==outcome.recordId||outcome.outcome!==(passed?'admitted':'rejected')||passed!==result.records.some(item=>item.id===record.id))throw Error('Replay original admission outcome mismatch');
  requireEqual(record,rebuilt,'Replay completed candidate differs from original cached generation/judgment');
  if(!passed){const withheld=result.quarantine.filter(item=>item.chunk===chunk.index);if(withheld.length!==1||withheld[0].reason!==rebuilt.verification.reason)throw Error('Replay original candidate hold mismatch');}
  if(record.verification.evidenceHash!==knowledgeEvidenceHash(record))throw Error('Replay original record evidence hash mismatch');
 }
 return {generationAnswers,judgeAnswers};
}

export function compareReplayRelease(expectedBytes:Uint8Array,actualBytes:Uint8Array,actual:DataRelease){
 const expected=dataReleaseSchema.parse(JSON.parse(Buffer.from(expectedBytes).toString('utf8')));
 if(dataReleaseId(expected.files)!==expected.id||new Set(expected.files.map(file=>file.path)).size!==expected.files.length)throw Error('Replay expected release manifest invalid');
 requireEqual(actual.files,expected.files,'Replay release member digest/size inventory mismatch');
 if(actual.id!==expected.id||hash(actualBytes)!==hash(expectedBytes)||!Buffer.from(actualBytes).equals(Buffer.from(expectedBytes)))throw Error('Replay release manifest bytes/identity mismatch');
 return {releaseId:actual.id,manifestSha256:hash(actualBytes),files:actual.files};
}
/** No substituted registry/records/coverage or unrelated preparation receipt may reach publication. */
export function assertReplayCompositionBindings(outputs:readonly KnowledgeSourcePin[],preparationReceipt:KnowledgeAuditPin,plan:Pick<PublicationPlan,'staging'|'knowledgePreparation'>){
 const members=['knowledge/registry.json','knowledge/records.json','knowledge/coverage.json'];
 if(outputs.length!==members.length||new Set(outputs.map(pin=>resolve(pin.path))).size!==members.length)throw Error('Replay requires exactly three unique knowledge outputs');
 for(const member of members){
  const matches=plan.staging.filter(pin=>pin.memberPath===member);
  if(matches.length!==1)throw Error('Replay publication knowledge staging inventory mismatch');
  const {memberPath:_member,...expected}=matches[0],actual=outputs.find(pin=>resolve(pin.path)===resolve(expected.path));
  if(!actual)throw Error('Replay generated knowledge output path mismatch');
  requireEqual(actual,expected,'Replay generated knowledge source pin differs from publication staging');
 }
 requireEqual(preparationReceipt,plan.knowledgePreparation,'Replay knowledge preparation receipt differs from publication plan');
}

export function assertReplayClocks(clocks:ReplayClocks,intakeGeneratedAt:string,publicationClocks:PublicationPlan['clocks']){
 ReplayClocksSchema.parse(clocks);
 if([clocks.recordsGeneratedAt,clocks.quarantineGeneratedAt,clocks.coverageGeneratedAt].some(clock=>clock!==intakeGeneratedAt)||clocks.qualityGeneratedAt!==publicationClocks.qualityGeneratedAt||clocks.manifestGeneratedAt!==publicationClocks.manifestGeneratedAt)throw Error('Replay clocks differ from canonical intake/publication plans');
}

/** Current replay composes the canonical managed intake and publisher; historical audit helpers are not called. */
export async function replayPipeline(receiptPath:string,receiptSha256:string,policy:CivicPolicyOptions=CIVIC_POLICY_AUTHORITY){
 const authority=await assertCivicPolicyAuthority(policy),executedAt=new Date().toISOString(),base=dirname(resolve(receiptPath));
 const receipt=ReplayReceiptSchema.parse(replayJson(await readReplayMetadataPin({path:receiptPath,sha256:receiptSha256},process.cwd(),policy)));
 const intake=prepareKnowledgeOptionsSchema.parse(replayJson(await readReplayMetadataPin(receipt.knowledgeIntake,base,policy)));
 const plan=PublicationPlanSchema.parse(replayJson(await readReplayMetadataPin(receipt.publicationPlan,base,policy)));
 if(!plan.policyReceipts)throw Error('Replay requires authentic pinned publication policy receipts');
 if(intake.policy.authorityId!==authority.authorityId||intake.policy.authoritySha256!==authority.authoritySha256||resolve(intake.policy.stateDir)!==resolve(policy.stateDir??CIVIC_POLICY_AUTHORITY.stateDir))throw Error('Replay knowledge intake authority differs from execution authority');
 assertReplayClocks(receipt.clocks,intake.generatedAt,plan.clocks);
 const expectedPath=await realpath(resolve(base,receipt.expectedManifest.path)),output=resolve(plan.output.releaseDir);
 if(expectedPath===output||inside(output,expectedPath))throw Error('Replay expected manifest cannot be reconstructed output');
 const expectedBytes=await readReplayMetadataPin(receipt.expectedManifest,base,policy,true),expected=dataReleaseSchema.parse(replayJson(expectedBytes));
 if(expected.generatedAt!==receipt.clocks.manifestGeneratedAt||expected.id!==dataReleaseId(expected.files)||new Set(expected.files.map(file=>file.path)).size!==expected.files.length)throw Error('Replay expected release identity/clock mismatch');
 const knowledge=await prepareKnowledge(intake);
 assertReplayCompositionBindings(knowledge.outputs,knowledge.preparationReceipt,plan);
 for(const pin of knowledge.outputs){const bytes=await readReplayPin(pin,process.cwd(),policy);if(bytes.length!==pin.bytes)throw Error('Replay generated knowledge byte size mismatch');}
 const published=await publish({plan,policy});
 await assertCivicPolicyAuthority(policy);
 for(const file of published.release.files)await assertManagedSourceReadable(join(output,file.path),policy);
 const actual=await verifyDataRelease(output);
 requireEqual(actual,published.release,'Replay publisher result differs from release bytes');
 const comparison=compareReplayRelease(expectedBytes,await readFile(join(output,'release-manifest.json')),actual);
 for(const file of actual.files)await assertManagedSourceReadable(join(output,file.path),policy);
 await assertCivicPolicyAuthority(policy);
 return {schemaVersion:'stadtstack-pipeline-replay-proof-v2' as const,receiptSha256,executedAt,completedAt:new Date().toISOString(),execution:{modelCalls:0,readinessCalls:0,archiveExecutions:0,liveFallback:'forbidden'},clocks:receipt.clocks,authority:{authorityId:authority.authorityId,authoritySha256:authority.authoritySha256},inputs:{knowledgeIntake:receipt.knowledgeIntake,publicationPlan:receipt.publicationPlan,expectedManifest:receipt.expectedManifest},knowledge:{outputs:knowledge.outputs.map(({bindings:_bindings,...pin})=>pin),preparationReceipt:knowledge.preparationReceipt},publicationInputSha256:published.publicationInputs.inputSha256,policyReceipts:published.policyReceipts,comparison};
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false)){
 const [path,sha256,...extra]=process.argv.slice(2);
 if(!path||!sha256||extra.length){console.error('Usage: replay-pipeline.ts RECEIPT_JSON RECEIPT_SHA256');process.exitCode=1;}
 else replayPipeline(path,sha256).then(proof=>console.log(JSON.stringify({schemaVersion:proof.schemaVersion,releaseId:proof.comparison.releaseId,manifestSha256:proof.comparison.manifestSha256,files:proof.comparison.files.length}))).catch(()=>{console.error('Managed replay rejected: a pinned prerequisite, current source policy, composition binding or reconstructed release differs. No live fallback was attempted.');process.exitCode=1;});
}
