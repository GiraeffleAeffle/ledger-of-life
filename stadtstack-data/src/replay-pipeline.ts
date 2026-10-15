import {readFile,mkdir,lstat,realpath,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {Pool} from 'pg';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {root,cacheDir,outDir,hash} from './common.ts';
import {hashSchema,knowledgeEvidenceHash,KnowledgeRecordsSchema} from './district-schema.ts';
import type {DistrictKnowledgeRecord} from './district-schema.ts';
import {districtRegistrySchema} from './district-registry.ts';
import {verifyCorpusManifest} from './corpus-manifest.ts';
import {currentReassessmentContract,validateFrozenReassessment,mergeReassessmentDeltas,ReassessmentAnswerSchema} from './district-reassess-relations.ts';
import {verifyPreparedDocument,readAuthorizedSourceBytes,preparedCacheContext} from './district-prepared-document.ts';
import type {PreparedDocument,PreparedCacheContext} from './district-prepared-document.ts';
import {modelAnswerCacheBinding} from './district-answer-cache.ts';
import type {DocumentResult,MunicipalityBinding} from './district-inference.ts';
import {ModelEvidenceSchema,assertModelEvidenceIdentity,type ModelEvidence} from './district-model-contract.ts';
import {subscriptionInputWithinBound,MODEL_INPUT_BOUND_REASON} from './district-model.ts';
import {withPreparedKnowledge} from './prepare-knowledge.ts';
import {publish} from './publish.ts';
import {dataReleaseSchema,dataReleaseId,verifyDataRelease} from './data-release.ts';
import type {DataRelease} from './data-release.ts';
import * as ClaimsModule from './district-claims.ts';
import * as SchemaModule from './district-schema.ts';
import * as GraphModule from './district-graph-claims.ts';
import * as VocabularyModule from './topic-vocabulary.ts';
import * as ModelModule from './district-model-contract.ts';
import type {DocumentChunk} from './district-claims.ts';
import type {WorkPlan} from './district-work-plan.ts';
import type {PreparationPlan} from './district-preparation-run.ts';
import {IdentityAssertionSchema,IdentityAdmissionSchema} from './district-entity-resolution.ts';
import {publicationInputsSchema} from './district-publication-inputs.ts';
import {priorReleaseSchema,loadPriorPublicationRelease,preloadPriorPublicationReleases,type PriorReleaseCache} from './district-publication-predecessor.ts';
import {withManagedSourceScratch,withManagedSourceWrite,initializeManagedAcquisitionLane,CIVIC_ACQUISITION_DECISION_ID,type ManagedSourceScratch,type CivicPolicyOptions} from './civic-opt-out.ts';
import {DistrictCas} from './district-cas.ts';
import {canonicalJson,semanticHash} from './district-adapter-contract.ts';
import {insertR1MetadataSnapshot} from './district-jobs.ts';
import {RepresentationDescriptorSchema} from './district-r1.ts';
import {authenticatedHttpBinding} from './district-http-observation.ts';
import {authenticatePublicationProvenance,type AuthenticatedPublicationProvenance} from './district-publication-provenance.ts';
import type {SourceArtifactBinding} from './district-private-io.ts';

const Pin=z.object({path:z.string().min(1),sha256:hashSchema}).strict();
const Identity=ModelEvidenceSchema;
const stagePath=z.string().regex(/^(?:catalogue\.json|cities\/[a-z0-9-]+\/(?:signals\.geojson|feed\.json)|regions\/brandenburg-mol\/topics\.json|core\/strausberg-facts\.json)$/);
export const ReplayClocksSchema=z.object({recordsGeneratedAt:z.iso.datetime(),quarantineGeneratedAt:z.iso.datetime(),coverageGeneratedAt:z.iso.datetime(),qualityGeneratedAt:z.iso.datetime(),manifestGeneratedAt:z.iso.datetime()}).strict();
/** Artifact/control pins are relative to the receipt; runtime source files are
 * relative to repository root. Core facts are authenticated retained members,
 * not a request to read raw PDFs or run a new model/parser verification.
 * expectedRelease is ONLY a manifest: no target member is read as an input.
 * The fresh workspace must be beneath this repository's cache/ (module resolution).
 * CLI: replay-pipeline.ts RECEIPT_JSON RECEIPT_SHA256
 * Historical model answers are checked, never regenerated. External network isolation
 * is recommended; this receipt does not assert that the operating system provided it.
 */
const ReplayCommonSchema=z.object({
 schemaVersion:z.literal('stadtstack-offline-replay-v2'),registry:Pin,candidateRecords:Pin,candidateQuarantine:Pin,identityState:Pin,publicationInputs:Pin,policyReceipts:Pin,privateProvenance:Pin,acquisitionDescriptors:z.array(Pin).optional(),textComposition:Pin.optional(),identityAssessments:Pin.optional(),criticalAssessments:Pin.optional(),regionalPolicyReceipts:Pin.optional(),casRoot:z.string().min(1),policyStateDir:z.string().min(1).optional(),policyAuthorityId:z.string().min(1).optional(),policyAuthoritySha256:hashSchema.optional(),
 structuredRun:Pin.optional(),clocks:ReplayClocksSchema,
 staging:z.array(Pin.extend({destination:stagePath}).strict()).min(1),
 priorRelease:priorReleaseSchema,legacyPreviousReleases:z.record(z.string().regex(/^[a-z0-9-]+$/),priorReleaseSchema).optional(),expectedRelease:Pin,
 runtime:z.object({node:z.string().min(1),icu:z.string().min(1),unicode:z.string().min(1),locale:z.string().min(1),timeZone:z.string().min(1),packageLockSha256:hashSchema,sourceFiles:z.array(Pin).min(1)}).strict(),workspace:z.string().min(1),
}).strict();
export const ReplayReceiptSchema=z.discriminatedUnion('mode',[
 ReplayCommonSchema.extend({mode:z.literal('text_and_structured'),textComposition:Pin,textRegistry:Pin,corpusManifest:Pin,corpusIndexes:z.array(z.object({name:z.string().min(1),rawRoot:z.string().min(1)}).strict()).min(1),rawRoot:z.string().min(1),index:Pin,frozen:Pin,deltas:z.array(Pin),generationContract:Pin,answers:z.array(Pin),modelIdentities:z.array(Identity).min(1),extractionRun:Pin}).strict(),
 ReplayCommonSchema.extend({mode:z.literal('structured_only'),structuredRun:Pin}).strict(),
 ReplayCommonSchema.extend({mode:z.literal('retained_text_composition'),textComposition:Pin}).strict(),
]);
export type ReplayReceipt=z.infer<typeof ReplayReceiptSchema>;
export type ReplayAnswer=z.infer<typeof ReassessmentAnswerSchema>;
type Answer=ReplayAnswer;
const archiveSourceSchema=z.object({name:z.string(),sha256:hashSchema,code:z.string()}).strict();
const archiveBody={archivedAt:z.iso.datetime(),promptSha256:hashSchema,schemaSha256:hashSchema,extractorSha256:hashSchema,promptVersion:z.string().min(1),judgePromptVersion:z.string().min(1),judgePromptSha256:hashSchema,extractionInstructions:z.string().min(1),judgeInstructions:z.string().min(1),outputSchema:z.record(z.string(),z.unknown()),judgeSchema:z.record(z.string(),z.unknown()),sources:z.array(archiveSourceSchema)};
export const ScopedGenerationArchiveSchema=z.object({...archiveBody,schemaVersion:z.literal('stadtstack-extraction-contract-archive-v2'),extractorVersion:z.string().min(1),cacheBindingVersion:z.literal('prepared-source-scoped-v2'),cacheCodecSha256:hashSchema,cacheContextSource:archiveSourceSchema.extend({name:z.literal('district-prepared-document.ts')}).strict()}).strict();
export type ScopedGenerationArchive=z.infer<typeof ScopedGenerationArchiveSchema>;
const GenerationArchiveSchema=z.discriminatedUnion('schemaVersion',[
 z.object({...archiveBody,schemaVersion:z.literal('stadtstack-extraction-contract-archive-v1'),extractorVersion:z.literal('district-extractor-v8-joint-graph')}).strict(),
 ScopedGenerationArchiveSchema,
]);
type GenerationArchive=z.infer<typeof GenerationArchiveSchema>;
export type HistoricalGeneration={archive:GenerationArchive;claims:typeof ClaimsModule;schema:typeof SchemaModule;graph:typeof GraphModule;vocabulary:typeof VocabularyModule;models:typeof ModelModule};
type CompletedReplayInputs={plan:WorkPlan;preparation:PreparationPlan;documents:{prepared:PreparedDocument;result:DocumentResult}[]};
const archiveFiles=['district-claims.ts','district-inference.ts','district-model.ts','district-claude.ts','district-model-contract.ts','district-model-usage.ts','district-model-diagnostics.ts','district-schema.ts','district-graph-claims.ts','topic-vocabulary.ts','../regional/taxonomy.mjs'];
const executableArchiveFiles:Record<string,true>={'district-claims.ts':true,'district-schema.ts':true,'district-graph-claims.ts':true,'district-model-contract.ts':true,'topic-vocabulary.ts':true,'../regional/taxonomy.mjs':true};
const jsonHash=(value:unknown)=>hash(JSON.stringify(value));
const encoded=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
function requireEqual(actual:unknown,expected:unknown,message:string){if(!isDeepStrictEqual(actual,expected))throw Error(message);}
function inside(parent:string,path:string){const name=relative(parent,path);return !!name&&!name.startsWith('..')&&!isAbsolute(name);}
async function privateFile(path:string,bytes:string|Uint8Array,scope:ManagedSourceScratch){
 await scope.assertActive();if(!inside(scope.directory,resolve(path)))throw Error('Replay derived write escapes its source-owned scratch');
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
 await scope.assertActive();
}
async function absent(path:string){try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}throw Error('Replay workspace must not already exist');}

/** Diagnostics deliberately omit paths, values, model output and source text. */
export async function readReplayPin(pin:z.infer<typeof Pin>,base:string,allowTargetManifest=false):Promise<Buffer>{
 const path=await realpath(resolve(base,pin.path)),target=await realpath(outDir).catch(()=>resolve(outDir));
 if((path===target||inside(target,path))&&!(allowTargetManifest&&path===join(target,'release-manifest.json')))throw Error('Replay forbids target release members as reconstruction inputs');
 const metadata=await lstat(path);
 if(!metadata.isFile()||metadata.size>512*1024*1024)throw Error('Replay pinned artifact size/type rejected');
 const bytes=await readFile(path);
 if(bytes.length!==metadata.size||hash(bytes)!==pin.sha256)throw Error('Replay pinned artifact digest mismatch');
 return bytes;
}
type ReplayPin=z.infer<typeof Pin>;
interface ReplaySourceContext {
 scope:ManagedSourceScratch;
 predecessors:PriorReleaseCache;
 provenance:AuthenticatedPublicationProvenance;
 policy:CivicPolicyOptions;
 bindings:SourceArtifactBinding[];
 cas:DistrictCas;
 pinned:(pin:ReplayPin,location?:string)=>Promise<Buffer>;
 provenanceSha256:string;
}
async function authenticateReplayProvenance(receipt:ReplayReceipt,base:string){
 const policy:CivicPolicyOptions={...(receipt.policyStateDir?{stateDir:resolve(base,receipt.policyStateDir)}:{}),...(receipt.policyAuthorityId?{authorityId:receipt.policyAuthorityId}:{}),...(receipt.policyAuthoritySha256?{authoritySha256:receipt.policyAuthoritySha256}:{})};
 const provenance=await authenticatePublicationProvenance(resolve(base,receipt.privateProvenance.path),receipt.privateProvenance.sha256,policy);
 const pinned=async(pin:ReplayPin,location=base)=>{
  const bytes=await provenance.read(resolve(location,pin.path));if(hash(bytes)!==pin.sha256)throw Error('Replay independent artifact pin mismatch');return bytes;
 };
 const cas=new DistrictCas(resolve(base,receipt.casRoot)),bindings=provenance.bindings;
 const descriptors=[];
 for(const pin of receipt.acquisitionDescriptors??[]){
  const descriptor=RepresentationDescriptorSchema.parse(JSON.parse((await pinned(pin)).toString('utf8')));
  const binding=authenticatedHttpBinding(descriptor.httpObservation,{url:descriptor.snapshot.url,sha256:descriptor.snapshot.sourceSha256,mimeType:descriptor.snapshot.mimeType,retrievedAt:descriptor.snapshot.retrievedAt,fetchedAt:descriptor.fetchedAt});
  descriptors.push(binding);
 }
 return {policy,pinned,bindings,cas,provenance,provenanceSha256:receipt.privateProvenance.sha256};
}
const replayArtifactAuditSchema=z.object({schemaVersion:z.literal('district-replay-artifact-audit-v1'),path:z.string().min(1),sha256:hashSchema,bytes:z.number().int().nonnegative(),mimeType:z.string().min(1),kind:z.literal('derived'),storageKey:z.string().regex(/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/),inputBindingSha256:hashSchema}).strict();
async function persistReplayArtifacts(context:ReplaySourceContext,receiptSha256:string,proof:{comparison:{releaseId:string;manifestSha256:string;files:DataRelease['files']};executedAt:string;completedAt:string;asOf:string;publicationInputsSha256:string}){
 const dsn=process.env.DATABASE_URL;if(!dsn)throw Error('Replay requires the private same-host canonical audit database');
 const connection=new URL(dsn);
 const host=connection.searchParams.get('host')??connection.hostname;
 if(!['postgres:','postgresql:'].includes(connection.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(host)&&!isAbsolute(host))throw Error('Replay audit database must be same-host, not an external network dependency');
 const pool=new Pool({connectionString:dsn,max:1,connectionTimeoutMillis:5000,statement_timeout:10000,application_name:'stadtstack-r1-replay'});
 const artifacts:z.infer<typeof replayArtifactAuditSchema>[]=[];
 const put=async(bytes:Buffer,mimeType='application/json')=>{
  const sha256=hash(bytes),storageKey=`sha256/${sha256.slice(0,2)}/${sha256}`;
  await context.scope.assertActive();
  const artifact=await withManagedSourceWrite(context.cas.root,context.bindings.map(binding=>({...binding,relativePath:storageKey,contentSha256:sha256,independentAllowed:false})),()=>context.cas.put(bytes,{kind:'derived',mimeType}),context.policy);
  if(artifact.sha256!==sha256)throw Error('Replay managed CAS byte mismatch');return artifact;
 };
 try{
  await privateFile(join(context.scope.directory,'proof.json'),encoded(proof),context.scope);
  await initializeManagedAcquisitionLane(context.cas.root,{...context.policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
  const visit=async(directory:string):Promise<void>=>{
   for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(directory,entry.name);
    if(entry.isSymbolicLink())throw Error('Replay scratch cannot persist symlink artifacts');
    if(entry.isDirectory()){await visit(path);continue;}
    if(!entry.isFile()||artifacts.length>=512)throw Error('Replay scratch artifact inventory exceeds its governed bound');
    await context.scope.assertActive();const stat=await lstat(path);if(stat.size>context.cas.maxBytes)throw Error('Replay derived artifact exceeds private CAS byte bound');
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;try{bytes=await handle.readFile();}finally{await handle.close();}
    const sha256=hash(bytes),audit=replayArtifactAuditSchema.parse({schemaVersion:'district-replay-artifact-audit-v1',path:relative(context.scope.directory,path),sha256,bytes:bytes.length,mimeType:entry.name.endsWith('.ts')?'text/typescript':'application/json',kind:'derived',storageKey:`sha256/${sha256.slice(0,2)}/${sha256}`,inputBindingSha256:context.provenanceSha256});
    await insertR1MetadataSnapshot(pool,{kind:'replay_artifact',payload:audit});await put(bytes,audit.mimeType);await put(Buffer.from(canonicalJson(audit)));artifacts.push(audit);
   }
  };
  await visit(context.scope.directory);
  const audit=z.object({schemaVersion:z.literal('district-replay-proof-audit-v1'),receiptSha256:hashSchema,inputBindingSha256:hashSchema,publicationInputsSha256:hashSchema,executedAt:z.iso.datetime(),completedAt:z.iso.datetime(),asOf:z.string(),comparison:z.object({releaseId:hashSchema,manifestSha256:hashSchema,files:dataReleaseSchema.shape.files}).strict(),artifacts:z.array(replayArtifactAuditSchema)}).strict().parse({schemaVersion:'district-replay-proof-audit-v1',receiptSha256,inputBindingSha256:context.provenanceSha256,publicationInputsSha256:proof.publicationInputsSha256,executedAt:proof.executedAt,completedAt:proof.completedAt,asOf:proof.asOf,comparison:proof.comparison,artifacts});
  const auditSha256=await insertR1MetadataSnapshot(pool,{kind:'replay_proof',payload:audit}),artifact=await put(Buffer.from(canonicalJson(audit)));if(artifact.sha256!==auditSha256)throw Error('Replay canonical audit/CAS mismatch');
  return {auditSha256,auditStorageKey:artifact.storageKey,artifacts};
 }finally{await pool.end();}
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
 requireEqual(archive.sources.map(source=>source.name),archive.schemaVersion==='stadtstack-extraction-contract-archive-v1'?archiveFiles:ClaimsModule.EXTRACTOR_SOURCE_FILES,'Replay historical extractor source inventory mismatch');
 if(archive.sources.some(source=>hash(source.code)!==source.sha256)||archive.extractorSha256!==jsonHash({version:archive.extractorVersion,hashes:archive.sources.map(source=>source.sha256)})||archive.schemaSha256!==jsonHash(archive.outputSchema)||archive.judgePromptSha256!==jsonHash({system:archive.judgeInstructions,schema:archive.judgeSchema}))throw Error('Replay historical generation contract digest mismatch');
 if(archive.schemaVersion==='stadtstack-extraction-contract-archive-v2'){
  const answer=archive.sources.find(source=>source.name==='district-answer-cache.ts')!;
  if(hash(archive.cacheContextSource.code)!==archive.cacheContextSource.sha256||archive.cacheCodecSha256!==semanticHash({preparedContextSha256:archive.cacheContextSource.sha256,answerCacheSha256:answer.sha256}))throw Error('Replay prepared-source cache codec digest mismatch');
 }
 return archive;
}
/** Queue-native replay uses the same scoped archive authentication, with no
 * historical code materialization or provider/cache-miss path. */
export async function authenticateScopedGeneration(raw:unknown):Promise<HistoricalGeneration>{
 const archive=verifyGenerationArchive(raw);
 if(archive.schemaVersion!=='stadtstack-extraction-contract-archive-v2')throw Error('Queue replay requires its original scoped generation archive');
 for(const source of [...archive.sources,archive.cacheContextSource])if(hash(await readFile(new URL(source.name,import.meta.url)))!==source.sha256)throw Error('Scoped replay requires the exact original source/cache implementation');
 requireEqual([ClaimsModule.EXTRACTOR_VERSION,ClaimsModule.PROMPT_VERSION,ClaimsModule.JUDGE_PROMPT_VERSION,ClaimsModule.PROMPT_SHA256,ClaimsModule.JUDGE_PROMPT_SHA256,ClaimsModule.CLAIM_SCHEMA_SHA256],[archive.extractorVersion,archive.promptVersion,archive.judgePromptVersion,archive.promptSha256,archive.judgePromptSha256,archive.schemaSha256],'Scoped replay original contract mismatch');
 return {archive,claims:ClaimsModule,schema:SchemaModule,graph:GraphModule,vocabulary:VocabularyModule,models:ModelModule};
}
async function loadHistoricalGeneration(raw:unknown,directory:string,scope:ManagedSourceScratch):Promise<HistoricalGeneration>{
 const archive=verifyGenerationArchive(raw);
 if(archive.schemaVersion==='stadtstack-extraction-contract-archive-v2')return authenticateScopedGeneration(raw);
 // Only the archived pure schema/claims modules are importable. Never materialize
 // archived inference, model, readiness or transport implementations for execution.
 for(const source of archive.sources)if(Object.hasOwn(executableArchiveFiles,source.name))await privateFile(join(directory,'src',source.name),source.code,scope);
 const load=(name:string)=>import(pathToFileURL(join(directory,'src',name)).href);
 const claims=await load('district-claims.ts') as HistoricalGeneration['claims'],schema=await load('district-schema.ts') as HistoricalGeneration['schema'],graph=await load('district-graph-claims.ts') as HistoricalGeneration['graph'],vocabulary=await load('topic-vocabulary.ts') as HistoricalGeneration['vocabulary'],models=await load('district-model-contract.ts') as HistoricalGeneration['models'];
 requireEqual([claims.EXTRACTOR_VERSION,claims.PROMPT_VERSION,claims.JUDGE_PROMPT_VERSION,claims.PROMPT_SHA256,claims.JUDGE_PROMPT_SHA256,claims.CLAIM_SCHEMA_SHA256,claims.EXTRACTION_INSTRUCTIONS,claims.JUDGE_INSTRUCTIONS,claims.outputJSONSchema,claims.judgeJSONSchema],[archive.extractorVersion,archive.promptVersion,archive.judgePromptVersion,archive.promptSha256,archive.judgePromptSha256,archive.schemaSha256,archive.extractionInstructions,archive.judgeInstructions,archive.outputSchema,archive.judgeSchema],'Replay archived prompt/schema exports mismatch');
 return {archive,claims,schema,graph,vocabulary,models};
}
function checkIdentities(identities:ModelEvidence[],historical:HistoricalGeneration){
 if(new Set(identities.map(identity=>identity.modelIdentitySha256)).size!==identities.length)throw Error('Replay duplicate historical model identity');
 for(const identity of identities){
  assertModelEvidenceIdentity(identity);
  const {provider,tool,model,modelIdentityBasis}=identity,routes=historical.models.SUPPORTED_MODEL_ROUTES;
  if(routes){
   const route=routes[tool];
   if(!route||provider!==route.provider||model!==route.model&&(!('historicalModels' in route)||!route.historicalModels.some(historicalModel=>historicalModel===model))||modelIdentityBasis!==route.modelIdentityBasis)throw Error('Replay historical model identity mismatch');
  }else{
   // Pre-route archives retain their original exact tool; today's omp support
   // cannot relabel a historical Claude/Codex generation as a different run.
   const configured=historical.models.PROVIDER_CONFIGS[provider];
   if(!configured||model!==configured.model||tool!==configured.tool||modelIdentityBasis!==configured.modelIdentityBasis)throw Error('Replay historical model identity mismatch');
  }
 }
}
export function replayAnswerBinding(identity:ModelEvidence,system:string,input:unknown,schema:object,sourceContext?:PreparedCacheContext){return sourceContext?modelAnswerCacheBinding({provider:identity.provider,modelIdentitySha256:identity.modelIdentitySha256,system,input,schema,sourceContext}):jsonHash({provider:identity.provider,modelIdentitySha256:identity.modelIdentitySha256,system,input,schema});}
function boundAnswer(answers:Map<string,Answer>,identity:ModelEvidence,system:string,input:unknown,schema:object,sourceContext?:PreparedCacheContext):Answer{
 const binding=replayAnswerBinding(identity,system,input,schema,sourceContext),answer=answers.get(binding);
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
 const cacheContext=archive.schemaVersion==='stadtstack-extraction-contract-archive-v2'?preparedCacheContext(prepared.receiptSha256,prepared.references):undefined;
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
  const rejectWithoutCandidate=(reason:string,kind:'rejected'|'no_case')=>{
   if(record||outcome.recordId!==null||outcome.outcome!==kind)throw Error('Replay original withheld outcome mismatch');
   const quarantine=result.quarantine.filter(item=>item.chunk===chunk.index);
   if(quarantine.length!==1||quarantine[0].candidate||quarantine[0].reason!==reason)throw Error('Replay original explicit hold mismatch');
  };
  if(cacheContext&&!subscriptionInputWithinBound(sourceInput)){
   rejectWithoutCandidate(MODEL_INPUT_BOUND_REASON,'rejected');
   if(outcome.responseSha256!==null)throw Error('Replay pre-generation input-budget hold has a response');
   continue;
  }
  const possible=identities.filter(identity=>identity.provider===result.provider&&(!record||identity.modelIdentitySha256===record.extraction.modelIdentitySha256)).flatMap(identity=>{const answer=answers.get(replayAnswerBinding(identity,archive.extractionInstructions,sourceInput,archive.outputSchema,cacheContext));return answer&&answer.responseSha256===outcome.responseSha256?[{identity,answer}]:[];});
  if(possible.length!==1)throw Error('Replay bound historical extraction answer missing or ambiguous; live generation is forbidden');
  const {identity}=possible[0],answer=boundAnswer(answers,identity,archive.extractionInstructions,sourceInput,archive.outputSchema,cacheContext);generationAnswers++;
  const decoded=claims.extractionOutputSchema.safeParse(answer.value);
  if(!decoded.success){rejectWithoutCandidate('Structured output/schema validation failed','rejected');continue;}
  if(!decoded.data.record){rejectWithoutCandidate('No supported case in source excerpt','no_case');continue;}
  const restored=claims.restoreSourceQuotes(decoded.data.record,chunk.text,chunk.start);
  const action=cacheContext?graph.normalizeRelationActions(restored.claims):{claims:restored.claims,normalization:null};
  const candidateClaims=action.claims,relationNormalization=action.normalization,deterministic=claims.deterministicChecks(candidateClaims,chunk.text,municipality.name);
  let faithfulness:DistrictKnowledgeRecord['verification']['faithfulness']={score:null,threshold:0.8,model:identity.model,provider:identity.provider,tool:identity.tool,toolVersion:identity.toolVersion,modelIdentitySha256:identity.modelIdentitySha256,returnedModel:null,reason:'Not evaluated: deterministic gate failed',evaluatedAt:null,responseSha256:null,sameModel:true,limitation:claims.LIMITATION};
  if(deterministic.passed){
   const judgeInput={source:{text:chunk.text},candidate:candidateClaims};
   if(cacheContext&&!subscriptionInputWithinBound(judgeInput)){rejectWithoutCandidate(MODEL_INPUT_BOUND_REASON,'rejected');continue;}
   const judgment=boundAnswer(answers,identity,archive.judgeInstructions,judgeInput,archive.judgeSchema,cacheContext);judgeAnswers++;
   const judged=claims.judgeSchema.safeParse(judgment.value);
   if(judged.success){faithfulness={...faithfulness,score:judged.data.score,reason:judged.data.reason,evaluatedAt:judgment.receivedAt,responseSha256:judgment.responseSha256,returnedModel:judgment.returnedModel,runtimeWarnings:judgment.runtimeWarnings};if(judged.data.criticalUnsupported)deterministic.checks.push({id:'judge_critical_claims',passed:false,reason:'Actual model judge found a critically unsupported claim'});deterministic.passed=deterministic.checks.every(check=>check.passed);}
   else faithfulness.reason='Actual judge returned invalid structured output';
  }
  const passed=deterministic.passed&&faithfulness.score!==null&&faithfulness.score>=0.8&&faithfulness.responseSha256!==null;
  let rebuilt:DistrictKnowledgeRecord;
  try{
   const normalizedGraph=graph.normalizeGraphClaims(candidateClaims,{municipalityId:municipality.id,sourceSha256:prepared.sourceSha256,ags:municipality.ags}),caseKey=candidateClaims.caseKey??`source_document:${prepared.sourceSha256}`;
   const references=prepared.references.map(reference=>({...reference,locator:`text-sha256:${prepared.textSha256};chars:${chunk.start}-${chunk.end}`}));
   const cacheKey=claims.extractionCacheKey({provider:identity.provider,documentHash:prepared.sourceSha256,textHash:prepared.textSha256,extractorHash:archive.extractorSha256,modelIdentitySha256:identity.modelIdentitySha256,chunk:{index:chunk.index,start:chunk.start,end:chunk.end},municipalityId:municipality.id,sourceBinding:JSON.stringify(cacheContext?{municipality,sourceContext:cacheContext}:municipality)});
   const candidate={...candidateClaims,...normalizedGraph,kind:'text_model' as const,id:`knowledge:${municipality.id}:${hash(`${caseKey}\n${prepared.sourceSha256}\n${chunk.index}`).slice(0,24)}`,municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,caseKey,sources:references,
    extraction:{extractorVersion:archive.extractorVersion,extractorSha256:archive.extractorSha256,...identity,returnedModel:answer.returnedModel,runtimeWarnings:answer.runtimeWarnings,quoteNormalization:restored.normalization,...(relationNormalization?{relationNormalization:{...relationNormalization,sourceSha256:prepared.sourceSha256,textSha256:prepared.textSha256,responseSha256:answer.responseSha256}}:{}),promptVersion:archive.promptVersion,promptSha256:archive.promptSha256,judgePromptVersion:archive.judgePromptVersion,judgePromptSha256:archive.judgePromptSha256,inputSha256:prepared.sourceSha256,textSha256:prepared.textSha256,responseSha256:answer.responseSha256,ocrUsed:prepared.ocrUsed,textMethod:prepared.method,documentLimitations:[...prepared.limitations,historical.models.PROVIDER_CONFIGS[identity.provider].toolLimitation],cacheKey,extractedAt:answer.receivedAt,chunk:{index:chunk.index,count:chunk.count,start:chunk.start,end:chunk.end}},
    verification:{kind:'text_model' as const,status:passed?'auto-verified' as const:'candidate' as const,deterministic,faithfulness,evidenceHash:'',...(!passed?{reason:!deterministic.passed?deterministic.checks.filter(check=>!check.passed).map(check=>check.id).join(', '):'Faithfulness gate not passed'}:{})}};
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
export function requiredReplayStaging(cities:string[]):string[]{return ['catalogue.json','regions/brandenburg-mol/topics.json','core/strausberg-facts.json',...cities.flatMap(id=>[`cities/${id}/signals.geojson`,`cities/${id}/feed.json`])].sort();}
async function checkRuntime(receipt:ReplayReceipt){
 const runtime=receipt.runtime;
 requireEqual([process.versions.node,process.versions.icu,process.versions.unicode],[runtime.node,runtime.icu,runtime.unicode],'Replay Node/ICU/Unicode version mismatch');
 const locale=Intl.DateTimeFormat().resolvedOptions();
 requireEqual([locale.locale,locale.timeZone],[runtime.locale,runtime.timeZone],'Replay publication locale/timezone mismatch');
 if(hash(await readFile(join(root,'package-lock.json')))!==runtime.packageLockSha256)throw Error('Replay dependency lock mismatch');
 const sources=(await readdir(join(root,'src'),{withFileTypes:true})).filter(item=>item.isFile()&&item.name.endsWith('.ts')).map(item=>'src/'+item.name);
 // Standalone replay has no operator bootstrap; governed step-8 receipts bind
 // the complete entrypoint/guard trio, never a partial or arbitrary script set.
 const operator=['scripts/r1-step8.ts','scripts/r1-step8.sh','scripts/r1-step8-offline.cjs'];
 const required=[...sources,'regional/taxonomy.mjs','package.json',...(runtime.sourceFiles.some(pin=>operator.includes(pin.path))?operator:[])].sort();
 requireEqual(runtime.sourceFiles.map(pin=>pin.path).sort(),required,'Replay implementation source inventory mismatch');
 for(const pin of runtime.sourceFiles)await readReplayPin(pin,root);
}
function checkExtractionRun(run:Record<string,unknown>,validated:CompletedReplayInputs){
 const {plan,preparation,documents}=validated,attempted=new Set([...documents.map(item=>`${item.prepared.municipalityId}:${item.prepared.sourceSha256}`),...preparation.quarantine.map(item=>`${item.municipalityId}:${item.sourceSha256}`)]);
 z.iso.datetime().parse(run.generatedAt);
 const expected={schemaVersion:'stadtstack-extraction-run-v2',workPlanId:plan.id,assignmentMode:plan.assignmentMode,corpusSha256:preparation.corpusSha256,registrySha256:preparation.registrySha256,promptContractSha256:plan.promptSha256,schemaSha256:plan.schemaSha256,scope:preparation.maxDocumentsPerMunicipality===null?'all_fetched_documents':'bounded_per_municipality',maxDocumentsPerMunicipality:preparation.maxDocumentsPerMunicipality,availableDocumentGroups:preparation.availableDocumentGroups,attemptedDocumentGroups:attempted.size,pendingDocumentGroups:preparation.availableDocumentGroups-attempted.size,selectedDocuments:preparation.selectedRepresentations,promotedRecords:documents.reduce((n,item)=>n+item.result.records.length,0),quarantinedCases:preparation.quarantine.length+documents.reduce((n,item)=>n+item.result.quarantine.length,0)};
 for(const [key,value] of Object.entries(expected))requireEqual(run[key],value,'Replay original extraction-run binding mismatch');
}

type VerifiedTextReplay={registryBytes:Buffer;quarantine:unknown[];textGeneration:{generationAnswers:number;judgeAnswers:number;originalExtractionRunGeneratedAt:unknown}};
async function replayAdmittedPublication(receipt:ReplayReceipt,base:string,workspace:string,expectedBytes:Buffer,expected:DataRelease,context:ReplaySourceContext,receiptSha256:string,text?:VerifiedTextReplay){
 const executedAt=new Date().toISOString(),pinned=context.pinned;
 const registryBytes=text?.registryBytes??await pinned(receipt.registry),candidateBytes=await pinned(receipt.candidateRecords),quarantineBytes=await pinned(receipt.candidateQuarantine),identityBytes=await pinned(receipt.identityState),sealBytes=await pinned(receipt.publicationInputs);
 const candidate=KnowledgeRecordsSchema.parse(JSON.parse(candidateBytes.toString('utf8')));
 const identity=z.object({identityAssertions:z.array(IdentityAssertionSchema),identityAdmissions:z.array(IdentityAdmissionSchema)}).strict().parse(JSON.parse(identityBytes.toString('utf8')));
 requireEqual(candidate.identityAssertions,identity.identityAssertions,'Replay candidate identity assertions differ from authentic identity state');
 requireEqual(candidate.identityAdmissions,identity.identityAdmissions,'Replay candidate identity admissions differ from authentic identity state');
 if(candidate.generatedAt!==receipt.clocks.recordsGeneratedAt)throw Error('Replay candidate source clock mismatch');
 const original=publicationInputsSchema.parse(JSON.parse(sealBytes.toString('utf8')));
 const dependency=(role:string)=>original.dependencies.find(dependency=>dependency.role===role)?.sha256;
 if(dependency('registry')!==receipt.registry.sha256||dependency('candidate_records')!==receipt.candidateRecords.sha256||dependency('candidate_quarantine')!==receipt.candidateQuarantine.sha256||original.priorRelease.gitCommit!==receipt.priorRelease.gitCommit||original.priorRelease.manifestSha256!==receipt.priorRelease.manifestSha256||original.priorRelease.releaseId!==receipt.priorRelease.releaseId)throw Error('Replay original publication inputs do not bind supplied authentic prerequisites');
 if((original.priorRelease.directory??'out')!==(receipt.priorRelease.directory??'out'))throw Error('Replay predecessor directory differs from original publication');
 const quarantine=z.object({schemaVersion:z.literal('stadtstack-quarantine-v1'),generatedAt:z.iso.datetime().optional(),cases:z.array(z.unknown())}).passthrough().parse(JSON.parse(quarantineBytes.toString('utf8')));
 if(quarantine.generatedAt!==receipt.clocks.quarantineGeneratedAt)throw Error('Replay quarantine source clock mismatch');
 if(text)requireEqual(quarantine.cases,text.quarantine,'Replay original quarantine differs from verified cached reconstruction');
 if(receipt.mode==='structured_only'&&candidate.records.some(record=>record.kind==='text_model'))throw Error('Structured-only replay cannot bypass actual text generation receipts');
 const destinations=receipt.staging.map(pin=>pin.destination);
 if(new Set(destinations).size!==destinations.length)throw Error('Replay duplicate staging destination');
 const cataloguePin=receipt.staging.find(pin=>pin.destination==='catalogue.json');if(!cataloguePin)throw Error('Replay staged catalogue missing');
 const catalogue=z.object({cities:z.array(z.object({id:z.string().regex(/^[a-z0-9-]+$/)})).min(1)}).parse(JSON.parse((await pinned(cataloguePin)).toString('utf8'))),cities=catalogue.cities.map(city=>city.id);
 requireEqual([...destinations].sort(),requiredReplayStaging(cities),'Replay requires the complete non-knowledge staging inventory');
 const priorPaths=[...cities.flatMap(city=>[`cities/${city}/signals.geojson`,`cities/${city}/changes.json`]),'knowledge/records.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json'];
 if(receipt.textComposition)await pinned(receipt.textComposition);
 return withPreparedKnowledge({registry:resolve(base,receipt.registry.path),records:resolve(base,receipt.candidateRecords.path),quarantine:resolve(base,receipt.candidateQuarantine.path),textComposition:receipt.textComposition?resolve(base,receipt.textComposition.path):undefined,structuredRun:receipt.structuredRun?resolve(base,receipt.structuredRun.path):undefined,policyReceipts:resolve(base,receipt.policyReceipts.path),identityAssessments:receipt.identityAssessments?resolve(base,receipt.identityAssessments.path):undefined,criticalAssessments:receipt.criticalAssessments?resolve(base,receipt.criticalAssessments.path):undefined,privateProvenance:{path:resolve(base,receipt.privateProvenance.path),sha256:receipt.privateProvenance.sha256},outputRoot:resolve(base,receipt.workspace),casRoot:resolve(base,receipt.casRoot),policyStateDir:receipt.policyStateDir?resolve(base,receipt.policyStateDir):undefined,policyAuthorityId:receipt.policyAuthorityId,policyAuthoritySha256:receipt.policyAuthoritySha256,coverageGeneratedAt:receipt.clocks.coverageGeneratedAt},async prepared=>{
  const nested:ReplaySourceContext={...context,scope:prepared.scope},output=join(prepared.scope.directory,'release'),prior=prepared.publication.priorDirectory;
  if(!prior)throw Error('Replay requires its authenticated prepared predecessor directory');
  await publish({stagingDir:prepared.stagingDir,outDir:output,asOf:original.asOf,priorRelease:receipt.priorRelease,legacyPreviousReleases:receipt.legacyPreviousReleases,offlineReplay:true,priorCityRoot:prior,publicationInputs:resolve(base,receipt.publicationInputs.path),textComposition:receipt.textComposition?resolve(base,receipt.textComposition.path):undefined,policyReceipts:resolve(base,receipt.policyReceipts.path),identityAssessments:receipt.identityAssessments?resolve(base,receipt.identityAssessments.path):undefined,criticalAssessments:receipt.criticalAssessments?resolve(base,receipt.criticalAssessments.path):undefined,structuredRun:receipt.structuredRun?resolve(base,receipt.structuredRun.path):undefined,regionalPolicyReceipts:receipt.regionalPolicyReceipts?resolve(base,receipt.regionalPolicyReceipts.path):undefined,privateProvenance:{path:resolve(base,receipt.privateProvenance.path),sha256:receipt.privateProvenance.sha256},casRoot:resolve(base,receipt.casRoot),policyStateDir:receipt.policyStateDir?resolve(base,receipt.policyStateDir):undefined,policyAuthorityId:receipt.policyAuthorityId,policyAuthoritySha256:receipt.policyAuthoritySha256,qualityGeneratedAt:receipt.clocks.qualityGeneratedAt,manifestGeneratedAt:receipt.clocks.manifestGeneratedAt},context.predecessors,prepared.publication);
  const actual=await verifyDataRelease(output),comparison=compareReplayRelease(expectedBytes,await readFile(join(output,'release-manifest.json')),actual);
  const proof={schemaVersion:'stadtstack-offline-replay-proof-v2',mode:receipt.mode,executedAt,completedAt:new Date().toISOString(),execution:{modelCalls:0,readinessCalls:0,liveFallback:'forbidden',networkIsolation:'external; not asserted by this proof'},historicalClocks:receipt.clocks,asOf:original.asOf,priorRelease:receipt.priorRelease,publicationInputsSha256:receipt.publicationInputs.sha256,knowledge:prepared.summary,comparison,...(text?{textGeneration:text.textGeneration}:{})};
  return {...proof,persistence:await persistReplayArtifacts(nested,receiptSha256,proof)};
 },{staging:receipt.staging.map(pin=>({destination:pin.destination,pin:{path:resolve(base,pin.path),sha256:pin.sha256}})),prior:{release:receipt.priorRelease,paths:priorPaths,targetGeneratedAt:expected.generatedAt,targetReleaseId:expected.id,cache:context.predecessors}});
}

export async function replayPipeline(receiptPath:string,receiptSha256:string){
 const executedAt=new Date().toISOString(),base=dirname(resolve(receiptPath));
 hashSchema.parse(receiptSha256);
 const receipt=ReplayReceiptSchema.parse(JSON.parse((await readReplayPin({path:receiptPath,sha256:receiptSha256},process.cwd())).toString('utf8')));
 await checkRuntime(receipt);
 const workspace=resolve(base,receipt.workspace),cacheRoot=await realpath(cacheDir);
 if(!inside(cacheRoot,workspace)||inside(resolve(outDir),workspace))throw Error('Replay workspace must be a fresh directory beneath repository cache');
 await absent(workspace);
 // Existing parents must also be contained: lexical containment alone accepts symlinks.
 const parent=await realpath(dirname(workspace));if(parent!==cacheRoot&&!inside(cacheRoot,parent))throw Error('Replay workspace parent escapes repository cache');
 const source=await authenticateReplayProvenance(receipt,base),pinned=source.pinned;
 const expectedBytes=await readReplayPin(receipt.expectedRelease,base,true),expected=dataReleaseSchema.parse(JSON.parse(expectedBytes.toString('utf8')));
 if(dataReleaseId(expected.files)!==expected.id||expected.generatedAt!==receipt.clocks.manifestGeneratedAt)throw Error('Replay expected release identity/clock mismatch');
 const stagedCatalogue=receipt.staging.find(pin=>pin.destination==='catalogue.json');if(!stagedCatalogue)throw Error('Replay staged catalogue missing');
 const cities=z.object({cities:z.array(z.object({id:z.string().regex(/^[a-z0-9-]+$/)}))}).parse(JSON.parse((await pinned(stagedCatalogue)).toString('utf8'))).cities.map(city=>city.id);
 const priorPaths=[...cities.flatMap(city=>[`cities/${city}/signals.geojson`,`cities/${city}/changes.json`]),'knowledge/records.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json'],baseline=await loadPriorPublicationRelease(receipt.priorRelease,priorPaths,expected.generatedAt,expected.id);
 const predecessors=await preloadPriorPublicationReleases([{prior:receipt.priorRelease,paths:priorPaths,targetGeneratedAt:expected.generatedAt,targetReleaseId:expected.id},...Object.entries(receipt.legacyPreviousReleases??{}).map(([cityId,prior])=>({prior,paths:[`cities/${cityId}/signals.geojson`],targetGeneratedAt:baseline.manifest.generatedAt,targetReleaseId:baseline.manifest.id}))]);
 return withManagedSourceScratch(workspace,source.bindings.map(({independentAllowed:_flag,...binding})=>binding),async scope=>{
 const context:ReplaySourceContext={...source,scope,predecessors},workspace=scope.directory;
 if(receipt.mode!=='text_and_structured')return replayAdmittedPublication(receipt,base,workspace,expectedBytes,expected,context,receiptSha256);
 const registryBytes=await pinned(receipt.registry),registry=districtRegistrySchema.parse(JSON.parse(registryBytes.toString('utf8'))),textRegistryBytes=await pinned(receipt.textRegistry),indexBytes=await pinned(receipt.index);
 const manifestBytes=await pinned(receipt.corpusManifest);
 const corpus=await verifyCorpusManifest({manifest:{path:resolve(base,receipt.corpusManifest.path),sha256:receipt.corpusManifest.sha256},indexes:receipt.corpusIndexes.map(({name,rawRoot})=>({name,rawRoot:resolve(base,rawRoot)})),policy:context.policy});
 if(hash(manifestBytes)!==corpus.manifestSha256||!corpus.inputs.indexes.some(index=>index.sha256===receipt.index.sha256)||corpus.inputs.releaseId!==expected.id||corpus.inputs.releaseManifestSha256!==receipt.expectedRelease.sha256)throw Error('Replay corpus manifest input/release binding mismatch');
 const frozen=JSON.parse((await pinned(receipt.frozen)).toString('utf8')),contract=await currentReassessmentContract(),validated=validateFrozenReassessment(frozen,contract);
 const generations=corpus.inputs.generations.filter(generation=>generation.registrySha256===receipt.textRegistry.sha256&&generation.preparationPlanSha256===validated.frozen.preparationPlan.sha256&&generation.workPlanSha256===validated.frozen.workPlan.sha256&&generation.workPlanId===validated.plan.id);
 if(validated.preparation.corpusSha256!==receipt.index.sha256||validated.preparation.registrySha256!==receipt.textRegistry.sha256||generations.length!==1||!corpus.inputs.indexes.some(index=>index.runId===generations[0].runId&&index.sha256===receipt.index.sha256&&index.role==='original_run_corpus'))throw Error('Replay frozen preparation/work-plan/corpus binding mismatch');
 const originalRoot=receipt.corpusIndexes.find(root=>corpus.inputs.indexes.some(index=>index.name===root.name&&index.runId===generations[0].runId&&index.sha256===receipt.index.sha256));
 if(!originalRoot||await realpath(resolve(base,originalRoot.rawRoot))!==await realpath(resolve(base,receipt.rawRoot)))throw Error('Replay original corpus raw root differs from prepared-source root');
 const runBytes=await pinned(receipt.extractionRun),run=JSON.parse(runBytes.toString('utf8')) as Record<string,unknown>;
 checkExtractionRun(run,validated);
 const generationRaw=JSON.parse((await pinned(receipt.generationContract)).toString('utf8')),generationArchive=verifyGenerationArchive(generationRaw);
 if(validated.plan.extractorSha256!==generationArchive.extractorSha256)throw Error('Replay work plan original extractor mismatch');
 const answerMap=new Map<string,Answer>();
 const addAnswer=(raw:unknown)=>{const answer=verifyReplayAnswer(raw),previous=answerMap.get(answer.binding);if(previous)requireEqual(answer,previous,'Replay conflicting historical answer envelopes');else answerMap.set(answer.binding,answer);};
 for(const blob of validated.frozen.answers)addAnswer(JSON.parse(blob.bytes));
 for(const pin of receipt.answers)addAnswer(JSON.parse((await pinned(pin)).toString('utf8')));
 const deltas=await Promise.all(receipt.deltas.map(async pin=>JSON.parse((await pinned(pin)).toString('utf8'))));
 const staging=new Map<string,Buffer>();
 for(const pin of receipt.staging){if(staging.has(pin.destination))throw Error('Replay duplicate staging destination');staging.set(pin.destination,await pinned(pin));}
 const catalogueBytes=staging.get('catalogue.json');if(!catalogueBytes)throw Error('Replay staged catalogue missing');
 const catalogue=z.object({cities:z.array(z.object({id:z.string().regex(/^[a-z0-9-]+$/)})).min(1),generatedAt:z.iso.datetime()}).parse(JSON.parse(catalogueBytes.toString('utf8'))),cities=catalogue.cities.map(city=>city.id);
 if(new Set(cities).size!==cities.length)throw Error('Replay duplicate staged city');
 requireEqual([...staging.keys()].sort(),requiredReplayStaging(cities),'Replay requires the complete non-knowledge staging inventory');
 const historical=await loadHistoricalGeneration(generationRaw,join(workspace,'historical-generation'),scope);
 const sourceMembership=new Set(corpus.records.flatMap(record=>record.memberships.filter(membership=>membership.indexSha256===receipt.index.sha256).map(()=>JSON.stringify([record.municipalityId,record.sourceId,record.url,record.sha256,record.fetchedAt]))));
 let generationAnswers=0,judgeAnswers=0;
 for(const document of validated.documents){
  const {prepared,result,task}=document,municipality=validated.preparation.groups.find(group=>group.expected.receiptSha256===prepared.receiptSha256&&group.municipality.id===prepared.municipalityId)?.municipality;
  if(!municipality||!registry.municipalities.some(city=>city.id===municipality.id&&city.ags===municipality.ags&&city.districtId===municipality.districtId&&city.name===municipality.name))throw Error('Replay prepared municipality registry mismatch');
  for(const reference of prepared.references)if(!sourceMembership.has(JSON.stringify([prepared.municipalityId,reference.id,reference.url,prepared.sourceSha256,reference.retrievedAt])))throw Error('Replay prepared source absent from verified corpus observation membership');
  const bytes=await readAuthorizedSourceBytes(resolve(base,receipt.rawRoot),join(resolve(base,receipt.rawRoot),'sha256',prepared.sourceSha256),prepared.sourceSha256,{...(receipt.policyStateDir?{stateDir:resolve(base,receipt.policyStateDir)}:{}),...(receipt.policyAuthorityId?{authorityId:receipt.policyAuthorityId}:{}),...(receipt.policyAuthoritySha256?{authoritySha256:receipt.policyAuthoritySha256}:{})});verifyPreparedDocument(prepared,prepared,bytes);
  if(task.group.preparedSha256!==prepared.receiptSha256)throw Error('Replay completed task prepared receipt mismatch');
  const counts=verifyCachedGeneration({result,prepared,municipality,historical,identities:receipt.modelIdentities,answers:answerMap});generationAnswers+=counts.generationAnswers;judgeAnswers+=counts.judgeAnswers;
 }
 const merged=mergeReassessmentDeltas({frozen,frozenSha256:receipt.frozen.sha256,contract,deltas});
 const candidate=KnowledgeRecordsSchema.parse(JSON.parse((await pinned(receipt.candidateRecords)).toString('utf8')));
 requireEqual(candidate.records.filter(record=>record.kind==='text_model'),merged.records,'Replay original text candidate records differ from verified cached reconstruction');
 return replayAdmittedPublication(receipt,base,workspace,expectedBytes,expected,context,receiptSha256,{registryBytes,quarantine:merged.quarantine,textGeneration:{generationAnswers,judgeAnswers,originalExtractionRunGeneratedAt:run.generatedAt}});
 },{...source.policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',purpose:'artifact'});
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false)){
 const [path,sha256,...extra]=process.argv.slice(2);
 if(!path||!sha256||extra.length){console.error('Usage: replay-pipeline.ts RECEIPT_JSON RECEIPT_SHA256');process.exitCode=1;}
 else replayPipeline(path,sha256).then(proof=>console.log(JSON.stringify({schemaVersion:proof.schemaVersion,releaseId:proof.comparison.releaseId,manifestSha256:proof.comparison.manifestSha256,files:proof.comparison.files.length}))).catch(()=>{console.error('Offline replay rejected: a pinned prerequisite, historical evidence binding or reconstructed release differs. No live fallback was attempted.');process.exitCode=1;});
}
