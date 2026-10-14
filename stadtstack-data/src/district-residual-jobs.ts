import {readFile,readdir} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import type {Pool} from 'pg';
import {z} from 'zod';
import {HashSchema,canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {readOperatorRegistryInputPin,operatorRegistryInputPinSchema,CrawlRegistryPinSchema,readCrawlOperatorRegistryInputPin} from './district-registry-config.ts';
import {authorizedPilotCorpusSchema,loadFrozenCorpusBytes,corpusFixturePolicy,type CrawlDocument} from './district-corpus.ts';
import {HttpObservationProofSchema,authenticatedHttpBinding,HttpSourceBindingSchema} from './district-http-observation.ts';
import {SourceObservationSchema,sourceObservationMatches} from './source-observation.ts';
import {CrawlRequestEvidenceSchema} from './district-crawl-request.ts';
import type {PolicyReceipt} from './district-policy-receipt.ts';
import {PreparedDocumentSchema,prepareDocument,verifyPreparedDocument,preparationExtractorSha256,collectPreparationToolVersions,type PreparedSourceReference} from './district-prepared-document.ts';
import {inferPreparedDocument,jointExtractionContract,archiveJointExtractionContract,documentResultSchema,type MunicipalityBinding} from './district-inference.ts';
import {documentChunks} from './district-claims.ts';
import {readParserReview,ParserIsolationError} from './district-parser-isolation.ts';
import {DistrictJobStore,canonicalJobIdentity,type DistrictJobSpec,type JobHandlerContext,type JobHandler,type JobHandlerResult} from './district-jobs.ts';
import {encodeStepReceipt,type StepReceipt} from './district-step-receipt.ts';
import type {DistrictCas,CasArtifact} from './district-cas.ts';
import {authenticateTextRunContribution,type TextRunContribution} from './text-run-lineage.ts';
import {initializeManagedAcquisitionLane,withManagedSourceWrite,withManagedSourceScratch,assertManagedSourceReadable,assertManagedSourceBindings,assertManagedIndependentHttpSourceBinding,CIVIC_ACQUISITION_DECISION_ID,type CivicPolicyOptions} from './civic-opt-out.ts';
import {recheckResidualPolicy,type ResidualPolicyCheck} from './district-policy-refresh.ts';
import {registerR1CodexDocument,reserveR1CodexCall,holdR1CodexFailure} from './district-codex-accounting.ts';
import {buildQueueTextRun} from './district-queue-text-run.ts';
import {preparedSourceBindings,type PreparedDocument} from './district-prepared-document.ts';
import type {ModelEvidence} from './district-model-contract.ts';

export const ResidualBoundsSchema=z.object({maxDocuments:z.literal(1),maxChunks:z.number().int().min(1).max(24),maxModelCalls:z.number().int().min(2).max(48),paidMicroUsd:z.literal(0)}).strict();
const HttpObservationBindingSchema=z.object({observationId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/),receiptSha256:HashSchema}).strict();
export const ResidualInputSchema=z.object({documentId:z.string().min(1),corpusSha256:authorizedPilotCorpusSchema,corpusObservations:z.array(HttpSourceBindingSchema).min(1).max(10000),registrySha256:HashSchema,registry:operatorRegistryInputPinSchema,crawlRegistry:CrawlRegistryPinSchema.optional(),policyReceiptSha256:HashSchema,httpObservation:HttpObservationBindingSchema,requestEvidenceSha256:HashSchema,bounds:ResidualBoundsSchema}).strict();
const ContractSchema=z.object({preparationSha256:HashSchema,extraction:z.object({promptSha256:HashSchema,schemaSha256:HashSchema,extractorSha256:HashSchema}).strict(),outputSha256:HashSchema}).strict();
const PreparationSelectorSchema=ResidualInputSchema.extend({contract:ContractSchema}).strict();
const ExtractionSelectorSchema=PreparationSelectorSchema.extend({preparationJobKey:HashSchema,preparationReceiptId:z.uuid(),preparationReceiptSha256:HashSchema,preparedArtifactSha256:HashSchema}).strict();
export const ResidualExtractionSchema=z.object({schemaVersion:z.literal('district-residual-extraction-v1'),documentId:z.string(),corpusSha256:HashSchema,registrySha256:HashSchema,policyReceiptSha256:HashSchema,preparationJobKey:HashSchema,preparationReceiptId:z.uuid(),preparationReceiptSha256:HashSchema,preparedArtifactSha256:HashSchema,result:documentResultSchema.extend({provider:z.literal('openai-subscription'),purpose:z.literal('production')})}).strict();
export async function residualJobContract(hash?:(file:string)=>Promise<string>){
 // The wrapper is mixed: bounds, output schema/assembly and source selection.
 const files=['district-residual-jobs.ts','district-inference.ts','district-answer-cache.ts','district-model.ts'];
 return ContractSchema.parse({preparationSha256:await preparationExtractorSha256(hash),extraction:await jointExtractionContract(hash),outputSha256:semanticHash(await Promise.all(files.map(async file=>({file,sha256:hash?await hash(file):digest(await readFile(new URL(file,import.meta.url)))}))))});
}
export function residualMimeSupported(mimeType:string){return ['application/pdf','text/html','application/xhtml+xml','text/plain','application/json','application/xml','text/xml'].includes(mimeType.split(';')[0].trim().toLowerCase());}
export interface ResidualSourceOptions {store?:DistrictJobStore;onContinuation?:(check:ResidualPolicyCheck)=>void}
export interface LoadedResidualSource {document:CrawlDocument;municipality:MunicipalityBinding;receipt:PolicyReceipt;reference:PreparedSourceReference;sourceBinding:z.infer<typeof HttpSourceBindingSchema>;policyCheck:ResidualPolicyCheck}
interface ResidualJobContext extends JobHandlerContext {store:DistrictJobStore;recordPolicy:(check:ResidualPolicyCheck)=>void}
type ResidualHandler=(context:ResidualJobContext)=>Promise<JobHandlerResult>;
async function recheckJobPolicy(context:ResidualJobContext){
 const checked=await recheckResidualPolicy(context.store,context.cas,ResidualInputSchema.strip().parse(context.job.spec.selector));
 context.recordPolicy(checked);return checked;
}
/** Metadata narratives remain attached to their actual original; no synthetic text is generated here. */
export async function loadResidualSource(cas:DistrictCas,input:z.infer<typeof ResidualInputSchema>,options:ResidualSourceOptions={}):Promise<LoadedResidualSource>{
 input=ResidualInputSchema.strip().parse(input);
 // Defense at the byte-load boundary, even when an execution caller skipped parsing.
 authorizedPilotCorpusSchema.parse(input.corpusSha256);
 const initial=await recheckResidualPolicy(options.store,cas,input),receipt=initial.receipt;
 if(initial.continuation)options.onContinuation?.(initial);
 const migration=input.crawlRegistry?await readCrawlOperatorRegistryInputPin(input.crawlRegistry,input.registry,policyOptions(receipt)):undefined;
 const admittedRegistry=migration?.processing??await readOperatorRegistryInputPin(input.registry,policyOptions(receipt));
 if(digest(admittedRegistry.bytes)!==input.registrySha256)throw Error('Residual registry differs from authenticated operator configuration');
 const registryPath=join(cas.root,'sha256',input.registrySha256.slice(0,2),input.registrySha256);
 await assertManagedSourceBindings(registryPath,admittedRegistry.bindings,policyOptions(receipt));
 if(digest(await cas.read(input.registrySha256))!==digest(admittedRegistry.bytes))throw Error('Residual registry CAS copy changes admitted configuration');
 await assertManagedSourceBindings(registryPath,admittedRegistry.bindings,policyOptions(receipt));
 const registry=admittedRegistry.registry,corpusPath=join(cas.root,'sha256',input.corpusSha256.slice(0,2),input.corpusSha256);
 await assertManagedSourceBindings(corpusPath,[...admittedRegistry.bindings,...(migration?.crawl.bindings??[]),...input.corpusObservations],policyOptions(receipt));
 const corpus=loadFrozenCorpusBytes(await cas.read(input.corpusSha256),input.corpusSha256);
 const observations=new Map<string,z.infer<typeof SourceObservationSchema>>();
 for(const binding of input.corpusObservations){
  await assertManagedSourceReadable(join(cas.root,'sha256',binding.receiptSha256.slice(0,2),binding.receiptSha256),policyOptions(receipt));
  const bytes=await cas.read(binding.receiptSha256),observation=SourceObservationSchema.parse(JSON.parse(bytes.toString('utf8')));
  if(digest(bytes)!==binding.receiptSha256||observation.url!==binding.url||observation.sha256!==binding.sourceSha256||observations.has(binding.observationId))throw Error('Residual corpus observation ancestry mismatch');
  observations.set(binding.observationId,observation);
 }
 for(const row of [...corpus.documents,...corpus.excludedDocuments??[]]){
  const observed=row.observationPath?observations.get(basename(row.observationPath)):undefined;
  if(!observed||!row.checkedAt||row.status===undefined||!sourceObservationMatches(observed,{...row,checkedAt:row.checkedAt,status:row.status,sizeBytes:observed.bytes,bodyState:'exclusion' in row?'excluded':'retained'}))throw Error('Residual corpus omits an original or negative observation');
 }
 const matches=corpus.documents.filter(row=>row.id===input.documentId);if(matches.length!==1)throw Error('Residual document must identify one corpus original');
 const document=matches[0],municipality=registry.municipalities.find(row=>row.id===document.municipalityId),source=municipality?.sources.find(row=>row.id===document.sourceId);
 if(!municipality||municipality.ags!==document.ags||municipality.districtId!==document.districtId||!source||source.checkState!=='checked'||!source.url)throw Error('Residual original lacks registered municipality/source binding');
 if(!residualMimeSupported(document.mimeType))throw Error('Residual preparation requires an original PDF, HTML, text or narrative JSON/XML representation');
 if(receipt.source.url!==document.url||receipt.source.sha256!==document.sha256||receipt.source.mimeType!==document.mimeType||receipt.scope.sourceId!==document.sourceId||receipt.scope.municipalityId!==municipality.id||receipt.scope.ags!==municipality.ags)throw Error('Residual policy receipt changes registered original/scope');
 const observationBytes=await cas.read(input.httpObservation.receiptSha256);
 const sourceBinding=authenticatedHttpBinding(HttpObservationProofSchema.parse({...input.httpObservation,bytes:observationBytes.toString('utf8')}),{url:document.url,sha256:document.sha256,mimeType:document.mimeType,retrievedAt:document.retrievedAt,fetchedAt:document.checkedAt});
 if(!input.corpusObservations.some(binding=>canonicalJson(binding)===canonicalJson(sourceBinding))||input.httpObservation.observationId!==basename(document.observationPath??''))throw Error('Residual selected HTTP observation is not its frozen corpus original');
 await assertManagedIndependentHttpSourceBinding(join(cas.root,'sha256',document.sha256.slice(0,2),document.sha256),sourceBinding,policyOptions(receipt));
 await assertManagedSourceBindings(join(cas.root,'sha256',input.requestEvidenceSha256.slice(0,2),input.requestEvidenceSha256),[sourceBinding],policyOptions(receipt));
 const requestEvidence=CrawlRequestEvidenceSchema.parse(JSON.parse((await cas.read(input.requestEvidenceSha256)).toString('utf8')));
 if(canonicalJson(requestEvidence.httpObservation)!==canonicalJson(sourceBinding))throw Error('Residual original request evidence binding differs');
 const policyCheck=await recheckResidualPolicy(options.store,cas,input);
 if(policyCheck.continuation)options.onContinuation?.(policyCheck);
 const reference:PreparedSourceReference={id:source.id,url:document.url,sha256:document.sha256,retrievedAt:document.retrievedAt,locator:`document-sha256:${document.sha256}`,mimeType:document.mimeType,sourceType:source.kind,policy:receipt.sourcePolicy};
 return {document,municipality:{id:municipality.id,name:municipality.name,ags:municipality.ags,districtId:municipality.districtId},receipt,reference,sourceBinding,policyCheck};
}
const policyOptions=(receipt:PolicyReceipt)=>({...corpusFixturePolicy(),authorityId:receipt.authorityId,authoritySha256:receipt.authoritySha256});
async function persist(context:ResidualJobContext,receipt:PolicyReceipt,value:unknown,kind:'parser_output'|'derived',textBytes=false){
 await recheckJobPolicy(context);context.signal.throwIfAborted();
 const bytes=value instanceof Uint8Array?value:textBytes?Buffer.from(value as string,'utf8'):Buffer.from(canonicalJson(value)),hash=digest(bytes),relativePath=`sha256/${hash.slice(0,2)}/${hash}`,policy=policyOptions(receipt);
 await initializeManagedAcquisitionLane(context.cas.root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
 const selected=context.job.spec.step==='residual_extract'?ExtractionSelectorSchema.parse(context.job.spec.selector):PreparationSelectorSchema.parse(context.job.spec.selector);
 const source=await loadResidualSource(context.cas,selected,{store:context.store,onContinuation:context.recordPolicy});
 const artifact=await withManagedSourceWrite(context.cas.root,[{relativePath,contentSha256:hash,...source.sourceBinding,independentAllowed:true}],()=>context.cas.put(bytes,{kind,mimeType:textBytes?'text/plain':'application/json'}),policy);
 await recheckJobPolicy(context);return artifact;
}
/** Preserve complete original cache envelopes byte-for-byte, including cache hits. */
export async function captureResidualAnswers(out:string,prepared:PreparedDocument,policy:CivicPolicyOptions,put:(bytes:Buffer)=>Promise<CasArtifact>){
 const versions:Record<string,string>={},cache=join(out,'cache');
 let names:string[];
 try{names=await readdir(cache);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return versions;throw error;}
 for(const name of names.sort())if(/^[a-f0-9]{64}\.answer\.json$/.test(name)){
  const path=join(cache,name),bindings=preparedSourceBindings(prepared.references,prepared.receiptSha256);
  await assertManagedSourceBindings(path,bindings,policy);const bytes=await readFile(path);
  await assertManagedSourceBindings(path,bindings,policy);
  const stored=await put(bytes);versions['modelAnswer.'+name.slice(0,64)]=stored.sha256;
 }
 return versions;
}
async function admitted(context:ResidualJobContext,selector:z.infer<typeof PreparationSelectorSchema>){
 if(process.platform!=='linux')throw Error('Residual source execution requires the authorized Codex VM');
 if(canonicalJson(selector.contract)!==canonicalJson(await residualJobContract())||context.job.spec.semanticContractSha256!==semanticHash(selector.contract))throw Error('Residual preparation/extraction/code contract changed');
 const source=await loadResidualSource(context.cas,selector,{store:context.store,onContinuation:context.recordPolicy});
 if(context.job.spec.policyProofSha256!==selector.policyReceiptSha256||canonicalJson(context.job.spec.sourceScope)!==canonicalJson(source.receipt.scope))throw Error('Residual job scope or policy binding mismatch');
 for(const hash of [selector.corpusSha256,selector.registrySha256,selector.policyReceiptSha256,selector.httpObservation.receiptSha256,selector.requestEvidenceSha256,source.document.sha256,...selector.corpusObservations.map(binding=>binding.receiptSha256)])if(!context.job.spec.inputArtifactHashes.includes(hash))throw Error('Residual original/provenance omitted from job identity');
 await assertManagedSourceReadable(join(context.cas.root,'sha256',source.document.sha256.slice(0,2),source.document.sha256),{...policyOptions(source.receipt),sourceUrl:source.document.url});
 context.signal.throwIfAborted();return source;
}
const prepare:ResidualHandler=async context=>{
 const selector=PreparationSelectorSchema.parse(context.job.spec.selector);if(context.job.spec.step!=='residual_prepare')throw Error('Residual preparation step mismatch');
 try{
 const source=await admitted(context,selector),parserReview=await readParserReview(),toolVersions=await collectPreparationToolVersions(source.document.mimeType),bytes=await context.cas.read(source.document.sha256);
 await recheckJobPolicy(context);
 const input={bytes,municipalityId:source.municipality.id,references:[source.reference],mimeType:source.document.mimeType,extractorSha256:selector.contract.preparationSha256,toolVersions,managedRoot:join(dirname(context.cas.root),basename(context.cas.root)+'-residual-prepared'),policy:policyOptions(source.receipt),signal:context.signal,sourceBindings:[source.sourceBinding]};
 const prepared=await prepareDocument(input);context.signal.throwIfAborted();
 const chunks=documentChunks(prepared.text);if(chunks.length>selector.bounds.maxChunks||2*chunks.length>selector.bounds.maxModelCalls)return {outcome:'held_quality',reasonCode:'quality_failed'};
 return {outcome:'succeeded',reasonCode:'completed',outputs:[await persist(context,source.receipt,prepared,'parser_output'),await persist(context,source.receipt,prepared.text,'parser_output',true)],versions:{preparation:prepared.extractorSha256,...prepared.toolVersions,parserAuthorization:parserReview.runnerSha256},counts:{bytes:bytes.length,spans:chunks.length}};
 }catch(error){if(error instanceof ParserIsolationError)return {outcome:'held_execution',reasonCode:'isolation_unavailable'};if(error instanceof Error&&error.message==='Document exceeds model chunk limit')return {outcome:'held_quality',reasonCode:'quality_failed'};throw error;}
};
const extract=(pool:Pool):ResidualHandler=>async context=>{
 const selector=ExtractionSelectorSchema.parse(context.job.spec.selector);if(context.job.spec.step!=='residual_extract'||!context.job.dependencyReceiptIds.includes(selector.preparationReceiptId)||!context.job.spec.inputArtifactHashes.includes(selector.preparedArtifactSha256))throw Error('Residual extraction requires actual committed preparation output');
 const source=await admitted(context,selector);
 await assertManagedSourceReadable(join(context.cas.root,'sha256',selector.preparedArtifactSha256.slice(0,2),selector.preparedArtifactSha256),policyOptions(source.receipt));
 const prepared=PreparedDocumentSchema.parse(JSON.parse((await context.cas.read(selector.preparedArtifactSha256)).toString('utf8')));
 verifyPreparedDocument(prepared,{...prepared,municipalityId:source.municipality.id,sourceSha256:source.document.sha256,extractorSha256:selector.contract.preparationSha256,references:[source.reference],toolVersions:await collectPreparationToolVersions(source.document.mimeType)},await context.cas.read(source.document.sha256));
 const chunks=documentChunks(prepared.text);if(chunks.length>selector.bounds.maxChunks||2*chunks.length>selector.bounds.maxModelCalls)return {outcome:'held_quality',reasonCode:'quality_failed'};
 const out=join(dirname(context.cas.root),basename(context.cas.root)+'-residual-model',context.job.jobKey),policy=policyOptions(source.receipt);
 const modelVersions:Record<string,string>={};
 const options={taskId:context.job.jobKey,groupId:semanticHash({municipalityId:source.municipality.id,sourceSha256:source.document.sha256}),purpose:'production' as const,provider:'openai-subscription' as const,municipality:source.municipality,prepared,expected:prepared,contract:selector.contract.extraction,out,usage:{ledgerPath:join(out,'usage.jsonl'),pausePath:join(out,context.job.runId,'pause.json'),signal:context.signal,onModelIdentity:async(identity:ModelEvidence)=>{const stored=await persist(context,source.receipt,identity,'derived');modelVersions['modelIdentity.'+identity.modelIdentitySha256]=stored.sha256;},beforeSourceCall:async(requestSha256:string)=>{await reserveR1CodexCall(pool,context.job,source.document.sha256,requestSha256,selector.bounds.maxModelCalls);}},policy};
 const generationArchive=await archiveJointExtractionContract(out,selector.contract.extraction,context.signal);
 const archive=await persist(context,source.receipt,await readFile(generationArchive.path),'derived');
 const result=await inferPreparedDocument(options).catch(error=>holdR1CodexFailure(pool,context.job,source.document.sha256,error));context.signal.throwIfAborted();await recheckJobPolicy(context);
 Object.assign(modelVersions,await captureResidualAnswers(out,prepared,policy,bytes=>persist(context,source.receipt,bytes,'derived')));
 const envelope=ResidualExtractionSchema.parse({schemaVersion:'district-residual-extraction-v1',documentId:selector.documentId,corpusSha256:selector.corpusSha256,registrySha256:selector.registrySha256,policyReceiptSha256:selector.policyReceiptSha256,preparationJobKey:selector.preparationJobKey,preparationReceiptId:selector.preparationReceiptId,preparationReceiptSha256:selector.preparationReceiptSha256,preparedArtifactSha256:selector.preparedArtifactSha256,result});
 const rejected=result.chunks.some(chunk=>chunk.outcome==='rejected');
 return {outcome:result.records.length?'succeeded':rejected?'held_quality':'no_supported_case',reasonCode:result.records.length?'completed':rejected?'quality_failed':'no_supported_case',outputs:[await persist(context,source.receipt,envelope,'derived')],versions:{extractor:selector.contract.extraction.extractorSha256,prompt:result.promptSha256,schema:result.schemaSha256,generationArchiveSha256:archive.sha256,...modelVersions},counts:{spans:result.chunks.length,acceptedFacts:result.records.length,heldFacts:result.quarantine.length,distinctCases:new Set(result.records.map(row=>row.caseKey)).size}};
};
/** No source subprocess runs outside the existing reviewed parser/model APIs. */
function sourceScoped(store:DistrictJobStore,handler:ResidualHandler):JobHandler{
 const scoped:JobHandler=async context=>{
  const raw=context.job.spec.step==='residual_extract'?ExtractionSelectorSchema.parse(context.job.spec.selector):PreparationSelectorSchema.parse(context.job.spec.selector),selector=ResidualInputSchema.strip().parse(raw),versions:Record<string,string>={};
  const recordPolicy=(check:ResidualPolicyCheck)=>{Object.assign(versions,check.versions);},source=await loadResidualSource(context.cas,selector,{store,onContinuation:recordPolicy}),policy=policyOptions(source.receipt);
  return withManagedSourceScratch(context.cas.root,[source.sourceBinding],async scope=>{
   const residualContext={...context,store,recordPolicy,signal:scope.signal};
   await scope.assertActive();const result=await handler(residualContext);await scope.assertActive();
   await recheckJobPolicy(residualContext);return {...result,versions:{...result.versions,...versions}};
  },{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',purpose:context.job.spec.step==='residual_extract'?'openai':'document',signal:context.signal,...policy});
 };
 scoped.currentPolicy=async(spec,cas)=>(await recheckResidualPolicy(store,cas,ResidualInputSchema.strip().parse(spec.selector))).continuation;
 return scoped;
}
export function residualJobHandlersFor(pool:Pool):Readonly<Record<string,JobHandler>>{
 const store=new DistrictJobStore(pool);return {residual_prepare:sourceScoped(store,prepare),residual_extract:sourceScoped(store,extract(pool))};
}
export async function enqueueResidualPreparation(store:DistrictJobStore,cas:DistrictCas,input:z.infer<typeof ResidualInputSchema>){
 const selected=ResidualInputSchema.parse(input),source=await loadResidualSource(cas,selected,{store}),contract=await residualJobContract();
 await registerR1CodexDocument(store.pool,source.municipality.id,source.document.sha256,selected.bounds.maxModelCalls);
 const spec:DistrictJobSpec={step:'residual_prepare',lane:'residual_preparation',semanticContractSha256:semanticHash(contract),inputArtifactHashes:[...new Set([selected.corpusSha256,selected.registrySha256,selected.policyReceiptSha256,selected.httpObservation.receiptSha256,selected.requestEvidenceSha256,source.document.sha256,...selected.corpusObservations.map(binding=>binding.receiptSha256)])],sourceScope:source.receipt.scope,selector:{...selected,contract},policyProofSha256:selected.policyReceiptSha256};
 return store.enqueue(spec,{reservedMicroUsd:0});
}
export async function enqueueCommittedResidualExtraction(pool:Pool,store:DistrictJobStore,cas:DistrictCas,preparationJobKey:string){
 HashSchema.parse(preparationJobKey);
 const query=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.job_key=$1 AND j.state='succeeded' AND j.spec->>'step'='residual_prepare' ORDER BY r.attempt DESC LIMIT 1`,[preparationJobKey]);
 if(query.rows.length!==1)throw Error('Residual predecessor preparation is not committed');
 const row=query.rows[0],encoded=encodeStepReceipt(row.receipt),selector=PreparationSelectorSchema.parse(row.spec.selector);
 await loadResidualSource(cas,ResidualInputSchema.strip().parse(selector),{store});
 if(encoded.sha256!==row.receipt_sha256||encoded.receipt.jobKey!==preparationJobKey||canonicalJobIdentity(row.spec).jobKey!==preparationJobKey||encoded.receipt.outputHashes.length!==2)throw Error('Committed residual preparation receipt binding mismatch');
 const candidates:Array<{hash:string;prepared:z.infer<typeof PreparedDocumentSchema>}>=[];
 for(const hash of encoded.receipt.outputHashes){
  const bytes=await cas.read(hash);let raw;
  try{raw=JSON.parse(bytes.toString('utf8'));}catch(error){if(error instanceof SyntaxError)continue;throw error;}
  const parsed=PreparedDocumentSchema.safeParse(raw);if(parsed.success)candidates.push({hash,prepared:parsed.data});
 }
 if(candidates.length!==1)throw Error('Committed prepared artifact unavailable');
 const {hash:preparedArtifactSha256,prepared}=candidates[0];verifyPreparedDocument(prepared,prepared);
 if(!encoded.receipt.outputHashes.includes(prepared.textSha256))throw Error('Committed prepared text binding mismatch');
 await cas.verify(prepared.textSha256);
 const extractionSelector=ExtractionSelectorSchema.parse({...selector,preparationJobKey,preparationReceiptId:encoded.receipt.id,preparationReceiptSha256:encoded.sha256,preparedArtifactSha256});
 return store.enqueue({...row.spec,step:'residual_extract',lane:'residual_extraction',inputArtifactHashes:[...new Set([...row.spec.inputArtifactHashes,preparedArtifactSha256,prepared.textSha256])],selector:extractionSelector},{dependencies:[{jobKey:preparationJobKey,expectedReceiptSha256:encoded.sha256}],reservedMicroUsd:0});
}

/** Authenticate committed native queue outputs before assembly or export. */
export async function loadCommittedResidualOutputs(pool:Pool,cas:DistrictCas,jobKeys:readonly string[]){
 if(!jobKeys.length||new Set(jobKeys).size!==jobKeys.length)throw Error('Residual contribution requires distinct committed extraction jobs');
 const receipts:StepReceipt[]=[],results:z.infer<typeof ResidualExtractionSchema>[]=[],sources:LoadedResidualSource[]=[],selectors:z.infer<typeof ExtractionSelectorSchema>[]=[],store=new DistrictJobStore(pool);
 for(const jobKey of [...jobKeys].sort()){
  HashSchema.parse(jobKey);
  const committed=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.job_key=$1 AND j.spec->>'step'='residual_extract' AND j.state IN ('succeeded','no_supported_case','held_quality') ORDER BY r.attempt DESC LIMIT 1`,[jobKey]);
  if(committed.rows.length!==1)throw Error('Residual contribution extraction is not committed');
  const row=committed.rows[0],encoded=encodeStepReceipt(row.receipt),selector=ExtractionSelectorSchema.parse(row.spec.selector);
  if(encoded.sha256!==row.receipt_sha256||encoded.receipt.jobKey!==jobKey||canonicalJobIdentity(row.spec).jobKey!==jobKey||encoded.receipt.outputHashes.length!==1||!encoded.receipt.dependencyReceiptIds.includes(selector.preparationReceiptId))throw Error('Residual contribution StepReceipt binding mismatch');
  const source=await loadResidualSource(cas,selector,{store}),outputHash=encoded.receipt.outputHashes[0];
  await assertManagedSourceReadable(join(cas.root,'sha256',outputHash.slice(0,2),outputHash),policyOptions(source.receipt));
  const result=ResidualExtractionSchema.parse(JSON.parse((await cas.read(outputHash)).toString('utf8')));
  if(result.documentId!==selector.documentId||result.policyReceiptSha256!==selector.policyReceiptSha256||result.preparationJobKey!==selector.preparationJobKey||result.result.sourceSha256!==source.document.sha256||result.result.municipalityId!==source.municipality.id||result.result.taskId!==jobKey||result.preparationReceiptSha256!==selector.preparationReceiptSha256||result.preparationReceiptId!==selector.preparationReceiptId||result.preparedArtifactSha256!==selector.preparedArtifactSha256||result.corpusSha256!==selector.corpusSha256||result.registrySha256!==selector.registrySha256||result.result.promptSha256!==selector.contract.extraction.promptSha256||result.result.schemaSha256!==selector.contract.extraction.schemaSha256||encoded.receipt.policyProofSha256!==selector.policyReceiptSha256||semanticHash([...encoded.receipt.inputHashes].sort())!==semanticHash([...row.spec.inputArtifactHashes].sort()))throw Error('Residual contribution changes committed extraction lineage');
  receipts.push(encoded.receipt);results.push(result);sources.push(source);selectors.push(selector);
 }
 return {receipts,results,sources,selectors};
}

/** Queue export authenticates the entire sealed closure, not a caller-written aggregate. */
export async function exportResidualTextContribution(pool:Pool,cas:DistrictCas,jobKeys:readonly string[],contribution:TextRunContribution){
 if(!jobKeys.length||new Set(jobKeys).size!==jobKeys.length)throw Error('Residual contribution requires distinct committed extraction jobs');
 const authenticated=authenticateTextRunContribution(contribution);
 if(authenticated.sourceArtifactKind!=='native_extraction_output'||authenticated.extractionRun.assignmentMode!=='codex-only')throw Error('Residual contribution requires its genuine Codex-only native run');
 const queue=authenticated.extractionRun.queue as {reconciliationJobKeys?:unknown}|undefined;
 const reconciliationJobKeys=z.array(HashSchema).parse(queue?.reconciliationJobKeys);
 const expected=await buildQueueTextRun(pool,cas,{jobKeys:[...jobKeys],reconciliationJobKeys});
 for(const key of ['extractionRun','records','quarantine','crawl','registry'] as const)if(contribution.artifacts[key].sha256!==expected.contribution.artifacts[key].sha256)throw Error('Queue text seal differs from committed lineage');
 if(contribution.artifacts.preparationPlan?.sha256!==expected.contribution.artifacts.preparationPlan?.sha256)throw Error('Queue text preparation seal mismatch');
 return {contribution,stepReceipts:expected.committed.receipts,results:expected.committed.results};
}
