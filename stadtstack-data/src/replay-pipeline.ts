import {readFile,writeFile,mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {root,cacheDir,outDir,hash} from './common.ts';
import {hashSchema,knowledgeEvidenceHash} from './district-schema.ts';
import type {DistrictKnowledgeRecord} from './district-schema.ts';
import {districtRegistrySchema} from './district-registry.ts';
import {verifyCorpusManifest} from './corpus-manifest.ts';
import {currentReassessmentContract,validateFrozenReassessment,mergeReassessmentDeltas,ReassessmentAnswerSchema} from './district-reassess-relations.ts';
import {verifyPreparedDocument,readAuthorizedSourceBytes} from './district-prepared-document.ts';
import type {PreparedDocument} from './district-prepared-document.ts';
import type {DocumentResult,MunicipalityBinding} from './district-inference.ts';
import type {ModelEvidence} from './district-model-contract.ts';
import {prepareKnowledge} from './prepare-knowledge.ts';
import {publish} from './publish.ts';
import {coreBundleSchema} from './core-schema.ts';
import {dataReleaseSchema,dataReleaseId,verifyDataRelease} from './data-release.ts';
import type {DataRelease} from './data-release.ts';
import type * as ClaimsModule from './district-claims.ts';
import type * as SchemaModule from './district-schema.ts';
import type * as GraphModule from './district-graph-claims.ts';
import type * as VocabularyModule from './topic-vocabulary.ts';
import type * as ModelModule from './district-model-contract.ts';
import type {DocumentChunk} from './district-claims.ts';
import type {WorkPlan} from './district-work-plan.ts';
import type {PreparationPlan} from './district-preparation-run.ts';

const Pin=z.object({path:z.string().min(1),sha256:hashSchema}).strict();
const Identity=z.object({provider:z.enum(['openai-subscription','anthropic-subscription']),tool:z.enum(['codex-cli','claude-cli']),toolVersion:z.string().min(1),model:z.string().min(1),modelIdentitySha256:hashSchema,modelIdentityBasis:z.enum(['configured-cli-model-and-tool-version','reported-cli-model-and-tool-version'])}).strict();
const stagePath=z.string().regex(/^(?:catalogue\.json|cities\/[a-z0-9-]+\/(?:signals\.geojson|feed\.json)|regions\/brandenburg-mol\/topics\.json|core\/strausberg-facts\.json)$/);
export const ReplayClocksSchema=z.object({recordsGeneratedAt:z.iso.datetime(),quarantineGeneratedAt:z.iso.datetime(),coverageGeneratedAt:z.iso.datetime(),qualityGeneratedAt:z.iso.datetime(),manifestGeneratedAt:z.iso.datetime()}).strict();
/** All paths except runtime.sourceFiles and coreEvidence are relative to the receipt.
 * Those two inventories are relative to repository root and its cache/ respectively.
 * expectedRelease is ONLY a manifest: no target member is read as an input.
 * The fresh workspace must be beneath this repository's cache/ (module resolution).
 * CLI: replay-pipeline.ts RECEIPT_JSON RECEIPT_SHA256
 * Historical model answers are checked, never regenerated. External network isolation
 * is recommended; this receipt does not assert that the operating system provided it.
 */
export const ReplayReceiptSchema=z.object({
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
export type ReplayReceipt=z.infer<typeof ReplayReceiptSchema>;
type Answer=z.infer<typeof ReassessmentAnswerSchema>;
const GenerationArchiveSchema=z.object({schemaVersion:z.literal('stadtstack-extraction-contract-archive-v1'),archivedAt:z.iso.datetime(),promptSha256:hashSchema,schemaSha256:hashSchema,extractorSha256:hashSchema,extractorVersion:z.literal('district-extractor-v8-joint-graph'),promptVersion:z.string().min(1),judgePromptVersion:z.string().min(1),judgePromptSha256:hashSchema,extractionInstructions:z.string().min(1),judgeInstructions:z.string().min(1),outputSchema:z.record(z.string(),z.unknown()),judgeSchema:z.record(z.string(),z.unknown()),sources:z.array(z.object({name:z.string(),sha256:hashSchema,code:z.string()}).strict())}).strict();
type GenerationArchive=z.infer<typeof GenerationArchiveSchema>;
export type HistoricalGeneration={archive:GenerationArchive;claims:typeof ClaimsModule;schema:typeof SchemaModule;graph:typeof GraphModule;vocabulary:typeof VocabularyModule;models:typeof ModelModule};
type CompletedReplayInputs={plan:WorkPlan;preparation:PreparationPlan;documents:{prepared:PreparedDocument;result:DocumentResult}[]};
const archiveFiles=['district-claims.ts','district-inference.ts','district-model.ts','district-claude.ts','district-model-contract.ts','district-model-usage.ts','district-model-diagnostics.ts','district-schema.ts','district-graph-claims.ts','topic-vocabulary.ts','../regional/taxonomy.mjs'];
const executableArchiveFiles:Record<string,true>={'district-claims.ts':true,'district-schema.ts':true,'district-graph-claims.ts':true,'district-model-contract.ts':true,'topic-vocabulary.ts':true,'../regional/taxonomy.mjs':true};
const jsonHash=(value:unknown)=>hash(JSON.stringify(value));
const encoded=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const execute=promisify(execFile);
function requireEqual(actual:unknown,expected:unknown,message:string){if(!isDeepStrictEqual(actual,expected))throw Error(message);}
function inside(parent:string,path:string){const name=relative(parent,path);return !!name&&!name.startsWith('..')&&!isAbsolute(name);}
async function privateFile(path:string,bytes:string|Uint8Array){await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600,flag:'wx'});}
async function absent(path:string){try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}throw Error('Replay workspace must not already exist');}

/** Diagnostics deliberately omit paths, values, model output and source text. */
export async function readReplayPin(pin:z.infer<typeof Pin>,base:string,allowTargetManifest=false):Promise<Buffer>{
 const path=await realpath(resolve(base,pin.path)),target=await realpath(outDir).catch(()=>resolve(outDir));
 if((path===target||inside(target,path))&&!(allowTargetManifest&&path===join(target,'release-manifest.json')))throw Error('Replay forbids target release members as reconstruction inputs');
 const metadata=await lstat(path);
 if(!metadata.isFile()||metadata.size>512*1024*1024)throw Error('Replay pinned artifact size/type rejected');
 const bytes=await readFile(path);
 if(hash(bytes)!==pin.sha256)throw Error('Replay pinned artifact digest mismatch');
 return bytes;
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
async function loadHistoricalGeneration(raw:unknown,directory:string):Promise<HistoricalGeneration>{
 const archive=verifyGenerationArchive(raw);
 // Only the archived pure schema/claims modules are importable. Never materialize
 // archived inference, model, readiness or transport implementations for execution.
 for(const source of archive.sources)if(Object.hasOwn(executableArchiveFiles,source.name))await privateFile(join(directory,'src',source.name),source.code);
 const load=(name:string)=>import(pathToFileURL(join(directory,'src',name)).href);
 const claims=await load('district-claims.ts') as HistoricalGeneration['claims'],schema=await load('district-schema.ts') as HistoricalGeneration['schema'],graph=await load('district-graph-claims.ts') as HistoricalGeneration['graph'],vocabulary=await load('topic-vocabulary.ts') as HistoricalGeneration['vocabulary'],models=await load('district-model-contract.ts') as HistoricalGeneration['models'];
 requireEqual([claims.EXTRACTOR_VERSION,claims.PROMPT_VERSION,claims.JUDGE_PROMPT_VERSION,claims.PROMPT_SHA256,claims.JUDGE_PROMPT_SHA256,claims.CLAIM_SCHEMA_SHA256,claims.EXTRACTION_INSTRUCTIONS,claims.JUDGE_INSTRUCTIONS,claims.outputJSONSchema,claims.judgeJSONSchema],[archive.extractorVersion,archive.promptVersion,archive.judgePromptVersion,archive.promptSha256,archive.judgePromptSha256,archive.schemaSha256,archive.extractionInstructions,archive.judgeInstructions,archive.outputSchema,archive.judgeSchema],'Replay archived prompt/schema exports mismatch');
 return {archive,claims,schema,graph,vocabulary,models};
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
export function requiredReplayStaging(cities:string[]):string[]{return ['catalogue.json','regions/brandenburg-mol/topics.json','core/strausberg-facts.json',...cities.flatMap(id=>[`cities/${id}/signals.geojson`,`cities/${id}/feed.json`])].sort();}
export async function readCommittedReleaseFile(commit:string,path:string):Promise<Buffer>{
 try{return (await execute('git',['--no-replace-objects','show',`${commit}:./out/${path}`],{cwd:root,encoding:'buffer',maxBuffer:512*1024*1024,env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'}})).stdout;}
 catch{throw Error('Replay prior committed release object missing; network fetch is forbidden');}
}
async function stagePriorRelease(receipt:ReplayReceipt,expected:DataRelease,cities:string[],directory:string){
 const prior=receipt.priorRelease,bytes=await readCommittedReleaseFile(prior.gitCommit,'release-manifest.json');
 if(hash(bytes)!==prior.manifestSha256)throw Error('Replay prior committed manifest digest mismatch');
 const manifest=dataReleaseSchema.parse(JSON.parse(bytes.toString('utf8')));
 if(manifest.id!==prior.releaseId||dataReleaseId(manifest.files)!==manifest.id||manifest.id===expected.id||Date.parse(manifest.generatedAt)>=Date.parse(expected.generatedAt)||new Set(manifest.files.map(file=>file.path)).size!==manifest.files.length)throw Error('Replay requires an authentic earlier city baseline, not the target release');
 for(const city of cities)for(const name of ['signals.geojson','changes.json']){
  const path=`cities/${city}/${name}`,file=manifest.files.find(file=>file.path===path);
  if(!file)throw Error('Replay prior city baseline member missing');
  const body=await readCommittedReleaseFile(prior.gitCommit,path);
  if(hash(body)!==file.sha256||body.length!==file.bytes)throw Error('Replay prior committed city member binding mismatch');
  await privateFile(join(directory,path),body);
 }
 return {gitCommit:prior.gitCommit,releaseId:manifest.id,manifestSha256:hash(bytes)};
}
async function checkRuntime(receipt:ReplayReceipt){
 const runtime=receipt.runtime;
 requireEqual([process.versions.node,process.versions.icu,process.versions.unicode],[runtime.node,runtime.icu,runtime.unicode],'Replay Node/ICU/Unicode version mismatch');
 const locale=Intl.DateTimeFormat().resolvedOptions();
 requireEqual([locale.locale,locale.timeZone],[runtime.locale,runtime.timeZone],'Replay publication locale/timezone mismatch');
 if(hash(await readFile(join(root,'package-lock.json')))!==runtime.packageLockSha256)throw Error('Replay dependency lock mismatch');
 const sources=(await readdir(join(root,'src'),{withFileTypes:true})).filter(item=>item.isFile()&&item.name.endsWith('.ts')).map(item=>'src/'+item.name);
 const required=[...sources,'regional/taxonomy.mjs','package.json'].sort();
 requireEqual(runtime.sourceFiles.map(pin=>pin.path).sort(),required,'Replay implementation source inventory mismatch');
 for(const pin of runtime.sourceFiles)await readReplayPin(pin,root);
}
function checkExtractionRun(run:Record<string,unknown>,validated:CompletedReplayInputs){
 const {plan,preparation,documents}=validated,attempted=new Set([...documents.map(item=>`${item.prepared.municipalityId}:${item.prepared.sourceSha256}`),...preparation.quarantine.map(item=>`${item.municipalityId}:${item.sourceSha256}`)]);
 z.iso.datetime().parse(run.generatedAt);
 const expected={schemaVersion:'stadtstack-extraction-run-v2',workPlanId:plan.id,assignmentMode:plan.assignmentMode,corpusSha256:preparation.corpusSha256,registrySha256:preparation.registrySha256,promptContractSha256:plan.promptSha256,schemaSha256:plan.schemaSha256,scope:preparation.maxDocumentsPerMunicipality===null?'all_fetched_documents':'bounded_per_municipality',maxDocumentsPerMunicipality:preparation.maxDocumentsPerMunicipality,availableDocumentGroups:preparation.availableDocumentGroups,attemptedDocumentGroups:attempted.size,pendingDocumentGroups:preparation.availableDocumentGroups-attempted.size,selectedDocuments:preparation.selectedRepresentations,promotedRecords:documents.reduce((n,item)=>n+item.result.records.length,0),quarantinedCases:preparation.quarantine.length+documents.reduce((n,item)=>n+item.result.quarantine.length,0)};
 for(const [key,value] of Object.entries(expected))requireEqual(run[key],value,'Replay original extraction-run binding mismatch');
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
 const pinned=async(pin:z.infer<typeof Pin>)=>readReplayPin(pin,base);
 const expectedBytes=await readReplayPin(receipt.expectedRelease,base,true),expected=dataReleaseSchema.parse(JSON.parse(expectedBytes.toString('utf8')));
 if(dataReleaseId(expected.files)!==expected.id||expected.generatedAt!==receipt.clocks.manifestGeneratedAt)throw Error('Replay expected release identity/clock mismatch');
 const registryBytes=await pinned(receipt.registry),registry=districtRegistrySchema.parse(JSON.parse(registryBytes.toString('utf8'))),indexBytes=await pinned(receipt.index);
 await pinned(receipt.corpusManifest);
 const corpus=await verifyCorpusManifest(resolve(base,receipt.corpusManifest.path),resolve(base,receipt.rawRoot));
 if(corpus.manifestSha256!==receipt.corpusManifest.sha256||corpus.inputs.registrySha256!==receipt.registry.sha256||!corpus.inputs.indexes.some(index=>index.sha256===receipt.index.sha256)||corpus.inputs.releaseId!==expected.id||corpus.inputs.releaseManifestSha256!==receipt.expectedRelease.sha256)throw Error('Replay corpus manifest input/release binding mismatch');
 const frozen=JSON.parse((await pinned(receipt.frozen)).toString('utf8')),contract=await currentReassessmentContract(),validated=validateFrozenReassessment(frozen,contract);
 if(validated.preparation.corpusSha256!==receipt.index.sha256||validated.preparation.registrySha256!==receipt.registry.sha256||corpus.inputs.preparationPlanSha256!==validated.frozen.preparationPlan.sha256||corpus.inputs.workPlanSha256!==validated.frozen.workPlan.sha256||corpus.inputs.workPlanId!==validated.plan.id)throw Error('Replay frozen preparation/work-plan/corpus binding mismatch');
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
 const core=coreBundleSchema.parse(JSON.parse(staging.get('core/strausberg-facts.json')!.toString('utf8'))),corePaths=[...new Set(core.facts.flatMap(fact=>[`pdf/${fact.source.sha256}.pdf`,`core-evidence/${fact.verification.faithfulness.evidenceHash}.json`]))].sort();
 requireEqual(receipt.coreEvidence.map(pin=>pin.path).sort(),corePaths,'Replay requires every private core PDF and actual judge receipt');
 for(const pin of receipt.coreEvidence)await readReplayPin(pin,cacheDir);
 await mkdir(workspace,{mode:0o700});
 const historical=await loadHistoricalGeneration(generationRaw,join(workspace,'historical-generation'));
 const sourceMembership=new Set(corpus.records.flatMap(record=>record.memberships.filter(membership=>membership.indexSha256===receipt.index.sha256).map(()=>JSON.stringify([record.municipalityId,record.sourceId,record.url,record.sha256,record.fetchedAt]))));
 let generationAnswers=0,judgeAnswers=0;
 for(const document of validated.documents){
  const {prepared,result,task}=document,municipality=validated.preparation.groups.find(group=>group.expected.receiptSha256===prepared.receiptSha256&&group.municipality.id===prepared.municipalityId)?.municipality;
  if(!municipality||!registry.municipalities.some(city=>city.id===municipality.id&&city.ags===municipality.ags&&city.districtId===municipality.districtId&&city.name===municipality.name))throw Error('Replay prepared municipality registry mismatch');
  for(const reference of prepared.references)if(!sourceMembership.has(JSON.stringify([prepared.municipalityId,reference.id,reference.url,prepared.sourceSha256,reference.retrievedAt])))throw Error('Replay prepared source absent from verified corpus observation membership');
  const bytes=await readAuthorizedSourceBytes(resolve(base,receipt.rawRoot),join(resolve(base,receipt.rawRoot),'sha256',prepared.sourceSha256),prepared.sourceSha256);verifyPreparedDocument(prepared,prepared,bytes);
  if(task.group.preparedSha256!==prepared.receiptSha256)throw Error('Replay completed task prepared receipt mismatch');
  const counts=verifyCachedGeneration({result,prepared,municipality,historical,identities:receipt.modelIdentities,answers:answerMap});generationAnswers+=counts.generationAnswers;judgeAnswers+=counts.judgeAnswers;
 }
 const merged=mergeReassessmentDeltas({frozen,frozenSha256:receipt.frozen.sha256,contract,deltas});
 const assembled=join(workspace,'assembled'),stage=join(workspace,'staging'),output=join(workspace,'release'),prior=join(workspace,'prior');
 const baseline=await stagePriorRelease(receipt,expected,cities,prior);
 for(const [path,bytes] of staging)await privateFile(join(stage,path),bytes);
 await privateFile(join(assembled,'registry.json'),registryBytes);await privateFile(join(assembled,'index.json'),indexBytes);
 await privateFile(join(assembled,'extraction-run.json'),runBytes);
 await privateFile(join(assembled,'records.json'),encoded({schemaVersion:'stadtstack-knowledge-v2',generatedAt:receipt.clocks.recordsGeneratedAt,records:merged.records}));
 await privateFile(join(assembled,'quarantine.json'),encoded({schemaVersion:'stadtstack-quarantine-v1',generatedAt:receipt.clocks.quarantineGeneratedAt,cases:merged.quarantine}));
 await privateFile(join(assembled,'reassessment-report.json'),encoded(merged.report));
 const knowledge=await prepareKnowledge({registry:join(assembled,'registry.json'),index:join(assembled,'index.json'),records:join(assembled,'records.json'),quarantine:join(assembled,'quarantine.json'),extractionRun:join(assembled,'extraction-run.json'),stagingDir:join(stage,'knowledge'),publicationQuarantinePath:join(assembled,'publication-quarantine.json'),coverageGeneratedAt:receipt.clocks.coverageGeneratedAt});
 await publish({stagingDir:stage,outDir:output,priorCityRoot:prior,qualityGeneratedAt:receipt.clocks.qualityGeneratedAt,manifestGeneratedAt:receipt.clocks.manifestGeneratedAt});
 const actual=await verifyDataRelease(output),comparison=compareReplayRelease(expectedBytes,await readFile(join(output,'release-manifest.json')),actual);
 const proof={schemaVersion:'stadtstack-offline-replay-proof-v1',receiptSha256,executedAt,completedAt:new Date().toISOString(),mode:'verified-completed-primary-result-cache-and-deterministic-reassessment',execution:{modelCalls:0,readinessCalls:0,liveFallback:'forbidden',networkIsolation:'external; not asserted by this proof'},historicalClocks:receipt.clocks,originalExtractionRunGeneratedAt:run.generatedAt,stagedCatalogueGeneratedAt:catalogue.generatedAt,runtime:{node:process.versions.node,icu:process.versions.icu,unicode:process.versions.unicode,locale:Intl.DateTimeFormat().resolvedOptions().locale,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,packageLockSha256:receipt.runtime.packageLockSha256},corpus:{manifestSha256:corpus.manifestSha256,records:corpus.recordCount,distinctBodies:corpus.distinctBodies,totalBodyBytes:corpus.totalBodyBytes},generation:{archiveSha256:receipt.generationContract.sha256,extractorVersion:historical.archive.extractorVersion,completedPrimaryResults:validated.documents.length,generationAnswers,judgeAnswers,modelIdentities:receipt.modelIdentities,preservedOriginalGeneration:true,rawProviderTranscripts:'not retained; sealed answer envelopes and response hash cross-bindings verified'},reassessment:{frozenSha256:receipt.frozen.sha256,deltaSha256s:receipt.deltas.map(pin=>pin.sha256),completedResultCacheReuse:true,modelsRerun:false},baseline,knowledge,comparison};
 await privateFile(join(workspace,'proof.json'),encoded(proof));
 return proof;
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false)){
 const [path,sha256,...extra]=process.argv.slice(2);
 if(!path||!sha256||extra.length){console.error('Usage: replay-pipeline.ts RECEIPT_JSON RECEIPT_SHA256');process.exitCode=1;}
 else replayPipeline(path,sha256).then(proof=>console.log(JSON.stringify({schemaVersion:proof.schemaVersion,releaseId:proof.comparison.releaseId,manifestSha256:proof.comparison.manifestSha256,files:proof.comparison.files.length}))).catch(()=>{console.error('Offline replay rejected: a pinned prerequisite, historical evidence binding or reconstructed release differs. No live fallback was attempted.');process.exitCode=1;});
}
