import {readFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import type {Pool} from 'pg';
import {z} from 'zod';
import {HashSchema,canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {readOperatorRegistryInputPin,operatorRegistryInputPinSchema} from './district-registry-config.ts';
import {authorizedPilotCorpusSchema,loadFrozenCorpusBytes,corpusFixturePolicy} from './district-corpus.ts';
import {HttpObservationProofSchema,authenticatedHttpBinding,HttpSourceBindingSchema} from './district-http-observation.ts';
import {SourceObservationSchema,sourceObservationMatches} from './source-observation.ts';
import {CrawlRequestEvidenceSchema} from './district-crawl-request.ts';
import {loadPolicyReceipt,recheckPolicyReceipt,type PolicyReceipt} from './district-policy-receipt.ts';
import {PreparedDocumentSchema,prepareDocument,verifyPreparedDocument,preparationExtractorSha256,collectPreparationToolVersions,type PreparedSourceReference} from './district-prepared-document.ts';
import {inferPreparedDocument,jointExtractionContract,documentResultSchema} from './district-inference.ts';
import {documentChunks} from './district-claims.ts';
import {readParserReview,ParserIsolationError} from './district-parser-isolation.ts';
import {DistrictJobStore,canonicalJobIdentity,type DistrictJobSpec,type JobHandlerContext,type JobHandler} from './district-jobs.ts';
import {encodeStepReceipt,type StepReceipt} from './district-step-receipt.ts';
import type {DistrictCas} from './district-cas.ts';
import {authenticateTextRunContribution,type TextRunContribution} from './text-run-lineage.ts';
import {initializeManagedAcquisitionLane,withManagedSourceWrite,withManagedSourceScratch,assertManagedSourceReadable,assertManagedSourceBindings,CIVIC_ACQUISITION_DECISION_ID} from './civic-opt-out.ts';

export const ResidualBoundsSchema=z.object({maxDocuments:z.literal(1),maxChunks:z.number().int().min(1).max(24),maxModelCalls:z.number().int().min(2).max(48),paidMicroUsd:z.literal(0)}).strict();
const HttpObservationBindingSchema=z.object({observationId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/),receiptSha256:HashSchema}).strict();
export const ResidualInputSchema=z.object({documentId:z.string().min(1),corpusSha256:authorizedPilotCorpusSchema,corpusObservations:z.array(HttpSourceBindingSchema).min(1).max(10000),registrySha256:HashSchema,registry:operatorRegistryInputPinSchema,policyReceiptSha256:HashSchema,httpObservation:HttpObservationBindingSchema,requestEvidenceSha256:HashSchema,bounds:ResidualBoundsSchema}).strict();
const ContractSchema=z.object({preparationSha256:HashSchema,extraction:z.object({promptSha256:HashSchema,schemaSha256:HashSchema,extractorSha256:HashSchema}).strict(),hostSha256:HashSchema}).strict();
const PreparationSelectorSchema=ResidualInputSchema.extend({contract:ContractSchema}).strict();
const ExtractionSelectorSchema=PreparationSelectorSchema.extend({preparationJobKey:HashSchema,preparationReceiptId:z.uuid(),preparationReceiptSha256:HashSchema,preparedArtifactSha256:HashSchema}).strict();
export const ResidualExtractionSchema=z.object({schemaVersion:z.literal('district-residual-extraction-v1'),documentId:z.string(),corpusSha256:HashSchema,registrySha256:HashSchema,policyReceiptSha256:HashSchema,preparationJobKey:HashSchema,preparationReceiptId:z.uuid(),preparationReceiptSha256:HashSchema,preparedArtifactSha256:HashSchema,result:documentResultSchema.extend({provider:z.literal('openai-subscription'),purpose:z.literal('production')})}).strict();
export async function residualJobContract(){
 const files=['district-residual-jobs.ts','district-corpus.ts','district-crawl-request.ts','district-http-observation.ts','source-observation.ts','district-inference.ts','district-answer-cache.ts','district-model.ts','district-policy-receipt.ts','civic-opt-out.ts','district-jobs.ts'];
 return ContractSchema.parse({preparationSha256:await preparationExtractorSha256(),extraction:await jointExtractionContract(),hostSha256:semanticHash(await Promise.all(files.map(async file=>({file,sha256:digest(await readFile(new URL(file,import.meta.url)))}))))});
}
export function residualMimeSupported(mimeType:string){return ['application/pdf','text/html','application/xhtml+xml','text/plain','application/json','application/xml','text/xml'].includes(mimeType.split(';')[0].trim().toLowerCase());}
/** Metadata narratives remain attached to their actual original; no synthetic text is generated here. */
export async function loadResidualSource(cas:DistrictCas,input:z.infer<typeof ResidualInputSchema>){
 input=ResidualInputSchema.strip().parse(input);
 // Defense at the byte-load boundary, even when an execution caller skipped parsing.
 authorizedPilotCorpusSchema.parse(input.corpusSha256);
 const receipt=await loadPolicyReceipt(cas,input.policyReceiptSha256);
 await recheckPolicyReceipt(receipt,{...policyOptions(receipt),evaluationAt:new Date().toISOString()});
 const admittedRegistry=await readOperatorRegistryInputPin(input.registry,policyOptions(receipt));
 if(digest(admittedRegistry.bytes)!==input.registrySha256)throw Error('Residual registry differs from authenticated operator configuration');
 await assertManagedSourceReadable(join(cas.root,'sha256',input.registrySha256.slice(0,2),input.registrySha256),policyOptions(receipt));
 if(digest(await cas.read(input.registrySha256))!==digest(admittedRegistry.bytes))throw Error('Residual registry CAS copy changes admitted configuration');
 const registry=admittedRegistry.registry,corpusPath=join(cas.root,'sha256',input.corpusSha256.slice(0,2),input.corpusSha256);
 await assertManagedSourceBindings(corpusPath,[...admittedRegistry.bindings,...input.corpusObservations],policyOptions(receipt));
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
 await assertManagedSourceBindings(join(cas.root,'sha256',document.sha256.slice(0,2),document.sha256),[sourceBinding],policyOptions(receipt));
 await assertManagedSourceBindings(join(cas.root,'sha256',input.requestEvidenceSha256.slice(0,2),input.requestEvidenceSha256),[sourceBinding],policyOptions(receipt));
 const requestEvidence=CrawlRequestEvidenceSchema.parse(JSON.parse((await cas.read(input.requestEvidenceSha256)).toString('utf8')));
 if(canonicalJson(requestEvidence.httpObservation)!==canonicalJson(sourceBinding))throw Error('Residual original request evidence binding differs');
 await recheckPolicyReceipt(receipt,{...policyOptions(receipt),evaluationAt:new Date().toISOString()});
 const reference:PreparedSourceReference={id:source.id,url:document.url,sha256:document.sha256,retrievedAt:document.retrievedAt,locator:`document-sha256:${document.sha256}`,mimeType:document.mimeType,sourceType:source.kind,policy:receipt.sourcePolicy};
 return {document,municipality:{id:municipality.id,name:municipality.name,ags:municipality.ags,districtId:municipality.districtId},receipt,reference,sourceBinding};
}
const policyOptions=(receipt:PolicyReceipt)=>({...corpusFixturePolicy(),authorityId:receipt.authorityId,authoritySha256:receipt.authoritySha256});
async function persist(context:JobHandlerContext,receipt:PolicyReceipt,value:unknown,kind:'parser_output'|'derived'){
 await recheckPolicyReceipt(receipt,{...policyOptions(receipt),evaluationAt:new Date().toISOString()});context.signal.throwIfAborted();
 const bytes=Buffer.from(canonicalJson(value)),hash=digest(bytes),relativePath=`sha256/${hash.slice(0,2)}/${hash}`,policy=policyOptions(receipt);
 await initializeManagedAcquisitionLane(context.cas.root,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
 const selected=context.job.spec.step==='residual_extract'?ExtractionSelectorSchema.parse(context.job.spec.selector):PreparationSelectorSchema.parse(context.job.spec.selector);
 const source=await loadResidualSource(context.cas,selected);
 const artifact=await withManagedSourceWrite(context.cas.root,[{relativePath,contentSha256:hash,...source.sourceBinding,independentAllowed:true}],()=>context.cas.put(bytes,{kind,mimeType:'application/json'}),policy);
 await recheckPolicyReceipt(receipt,{...policyOptions(receipt),evaluationAt:new Date().toISOString()});return artifact;
}
async function admitted(context:JobHandlerContext,selector:z.infer<typeof PreparationSelectorSchema>){
 if(process.platform!=='linux')throw Error('Residual source execution requires the authorized Codex VM');
 if(canonicalJson(selector.contract)!==canonicalJson(await residualJobContract())||context.job.spec.semanticContractSha256!==semanticHash(selector.contract))throw Error('Residual preparation/extraction/code contract changed');
 const source=await loadResidualSource(context.cas,selector);
 if(context.job.spec.policyProofSha256!==selector.policyReceiptSha256||canonicalJson(context.job.spec.sourceScope)!==canonicalJson(source.receipt.scope))throw Error('Residual job scope or policy binding mismatch');
 for(const hash of [selector.corpusSha256,selector.registrySha256,selector.policyReceiptSha256,selector.httpObservation.receiptSha256,selector.requestEvidenceSha256,source.document.sha256,...selector.corpusObservations.map(binding=>binding.receiptSha256)])if(!context.job.spec.inputArtifactHashes.includes(hash))throw Error('Residual original/provenance omitted from job identity');
 await assertManagedSourceReadable(join(context.cas.root,'sha256',source.document.sha256.slice(0,2),source.document.sha256),{...policyOptions(source.receipt),sourceUrl:source.document.url});
 await readParserReview();context.signal.throwIfAborted();return source;
}
const prepare:JobHandler=async context=>{
 const selector=PreparationSelectorSchema.parse(context.job.spec.selector);if(context.job.spec.step!=='residual_prepare')throw Error('Residual preparation step mismatch');
 try{
 const source=await admitted(context,selector),toolVersions=await collectPreparationToolVersions(source.document.mimeType),bytes=await context.cas.read(source.document.sha256);
 await recheckPolicyReceipt(source.receipt,{...policyOptions(source.receipt),evaluationAt:new Date().toISOString()});
 const input={bytes,municipalityId:source.municipality.id,references:[source.reference],mimeType:source.document.mimeType,extractorSha256:selector.contract.preparationSha256,toolVersions,managedRoot:join(context.cas.root,'residual-prepared'),policy:policyOptions(source.receipt),signal:context.signal,sourceBindings:[source.sourceBinding]};
 const prepared=await prepareDocument(input);context.signal.throwIfAborted();
 const chunks=documentChunks(prepared.text);if(chunks.length>selector.bounds.maxChunks||2*chunks.length>selector.bounds.maxModelCalls)return {outcome:'held_quality',reasonCode:'quality_failed'};
 return {outcome:'succeeded',reasonCode:'completed',outputs:[await persist(context,source.receipt,prepared,'parser_output')],versions:{preparation:prepared.extractorSha256,...prepared.toolVersions},counts:{bytes:bytes.length,spans:chunks.length}};
 }catch(error){if(error instanceof ParserIsolationError)return {outcome:'held_execution',reasonCode:'isolation_unavailable'};if(error instanceof Error&&error.message==='Document exceeds model chunk limit')return {outcome:'held_quality',reasonCode:'quality_failed'};throw error;}
};
const extract:JobHandler=async context=>{
 const selector=ExtractionSelectorSchema.parse(context.job.spec.selector);if(context.job.spec.step!=='residual_extract'||!context.job.dependencyReceiptIds.includes(selector.preparationReceiptId)||!context.job.spec.inputArtifactHashes.includes(selector.preparedArtifactSha256))throw Error('Residual extraction requires actual committed preparation output');
 const source=await admitted(context,selector);
 await assertManagedSourceReadable(join(context.cas.root,'sha256',selector.preparedArtifactSha256.slice(0,2),selector.preparedArtifactSha256),policyOptions(source.receipt));
 const prepared=PreparedDocumentSchema.parse(JSON.parse((await context.cas.read(selector.preparedArtifactSha256)).toString('utf8')));
 verifyPreparedDocument(prepared,{...prepared,municipalityId:source.municipality.id,sourceSha256:source.document.sha256,extractorSha256:selector.contract.preparationSha256,references:[source.reference],toolVersions:await collectPreparationToolVersions(source.document.mimeType)},await context.cas.read(source.document.sha256));
 const chunks=documentChunks(prepared.text);if(chunks.length>selector.bounds.maxChunks||2*chunks.length>selector.bounds.maxModelCalls)return {outcome:'held_quality',reasonCode:'quality_failed'};
 const out=join(context.cas.root,'residual-model',context.job.jobKey),policy=policyOptions(source.receipt);
 const options={taskId:context.job.jobKey,groupId:semanticHash({municipalityId:source.municipality.id,sourceSha256:source.document.sha256}),purpose:'production' as const,provider:'openai-subscription' as const,municipality:source.municipality,prepared,expected:prepared,contract:selector.contract.extraction,out,usage:{ledgerPath:join(out,'usage.jsonl'),pausePath:join(out,'pause.json'),signal:context.signal},policy};
 const result=await inferPreparedDocument(options);context.signal.throwIfAborted();await recheckPolicyReceipt(source.receipt,{...policyOptions(source.receipt),evaluationAt:new Date().toISOString()});
 const envelope=ResidualExtractionSchema.parse({schemaVersion:'district-residual-extraction-v1',documentId:selector.documentId,corpusSha256:selector.corpusSha256,registrySha256:selector.registrySha256,policyReceiptSha256:selector.policyReceiptSha256,preparationJobKey:selector.preparationJobKey,preparationReceiptId:selector.preparationReceiptId,preparationReceiptSha256:selector.preparationReceiptSha256,preparedArtifactSha256:selector.preparedArtifactSha256,result});
 const rejected=result.chunks.some(chunk=>chunk.outcome==='rejected');
 return {outcome:result.records.length?'succeeded':rejected?'held_quality':'no_supported_case',reasonCode:result.records.length?'completed':rejected?'quality_failed':'no_supported_case',outputs:[await persist(context,source.receipt,envelope,'derived')],versions:{extractor:selector.contract.extraction.extractorSha256,prompt:result.promptSha256,schema:result.schemaSha256},counts:{spans:result.chunks.length,acceptedFacts:result.records.length,heldFacts:result.quarantine.length,distinctCases:new Set(result.records.map(row=>row.caseKey)).size}};
};
/** No source subprocess runs outside the existing reviewed parser/model APIs. */
function sourceScoped(handler:JobHandler):JobHandler{return async context=>{
 const raw=context.job.spec.step==='residual_extract'?ExtractionSelectorSchema.parse(context.job.spec.selector):PreparationSelectorSchema.parse(context.job.spec.selector);
 const selector={documentId:raw.documentId,corpusSha256:raw.corpusSha256,corpusObservations:raw.corpusObservations,registrySha256:raw.registrySha256,registry:raw.registry,policyReceiptSha256:raw.policyReceiptSha256,httpObservation:raw.httpObservation,requestEvidenceSha256:raw.requestEvidenceSha256,bounds:raw.bounds,contract:raw.contract};
 const source=await loadResidualSource(context.cas,selector),policy=policyOptions(source.receipt);
 return withManagedSourceScratch(context.cas.root,[source.sourceBinding],async scope=>{
  await scope.assertActive();const result=await handler({...context,signal:scope.signal});await scope.assertActive();
  await recheckPolicyReceipt(source.receipt,{...policyOptions(source.receipt),evaluationAt:new Date().toISOString()});return result;
 },{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',purpose:context.job.spec.step==='residual_extract'?'openai':'document',signal:context.signal,...policy});
};}
export const residualJobHandlers:Readonly<Record<string,JobHandler>>={residual_prepare:sourceScoped(prepare),residual_extract:sourceScoped(extract)};
export async function enqueueResidualPreparation(store:DistrictJobStore,cas:DistrictCas,input:z.infer<typeof ResidualInputSchema>){
 const selected=ResidualInputSchema.parse(input),source=await loadResidualSource(cas,selected),contract=await residualJobContract();
 const spec:DistrictJobSpec={step:'residual_prepare',lane:'residual_preparation',semanticContractSha256:semanticHash(contract),inputArtifactHashes:[...new Set([selected.corpusSha256,selected.registrySha256,selected.policyReceiptSha256,selected.httpObservation.receiptSha256,selected.requestEvidenceSha256,source.document.sha256,...selected.corpusObservations.map(binding=>binding.receiptSha256)])],sourceScope:source.receipt.scope,selector:{...selected,contract},policyProofSha256:selected.policyReceiptSha256};
 return store.enqueue(spec,{reservedMicroUsd:0});
}
export async function enqueueCommittedResidualExtraction(pool:Pool,store:DistrictJobStore,cas:DistrictCas,preparationJobKey:string){
 HashSchema.parse(preparationJobKey);
 const query=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.job_key=$1 AND j.state='succeeded' AND j.spec->>'step'='residual_prepare' ORDER BY r.attempt DESC LIMIT 1`,[preparationJobKey]);
 if(query.rows.length!==1)throw Error('Residual predecessor preparation is not committed');
 const row=query.rows[0],encoded=encodeStepReceipt(row.receipt),selector=PreparationSelectorSchema.parse(row.spec.selector);
 if(encoded.sha256!==row.receipt_sha256||encoded.receipt.jobKey!==preparationJobKey||canonicalJobIdentity(row.spec).jobKey!==preparationJobKey||encoded.receipt.outputHashes.length!==1)throw Error('Committed residual preparation receipt binding mismatch');
 const preparedArtifactSha256=encoded.receipt.outputHashes[0];await cas.verify(preparedArtifactSha256);
 const prepared=PreparedDocumentSchema.parse(JSON.parse((await cas.read(preparedArtifactSha256)).toString('utf8')));verifyPreparedDocument(prepared,prepared);
 const extractionSelector=ExtractionSelectorSchema.parse({...selector,preparationJobKey,preparationReceiptId:encoded.receipt.id,preparationReceiptSha256:encoded.sha256,preparedArtifactSha256});
 return store.enqueue({...row.spec,step:'residual_extract',lane:'residual_extraction',inputArtifactHashes:[...row.spec.inputArtifactHashes,preparedArtifactSha256],selector:extractionSelector},{dependencies:[{jobKey:preparationJobKey,expectedReceiptSha256:encoded.sha256}],reservedMicroUsd:0});
}

/** Export only a genuine sealed run artifact. Per-document receipts never become
 * a fabricated aggregate model identity or a replacement for a missing run. */
export async function exportResidualTextContribution(pool:Pool,cas:DistrictCas,jobKeys:readonly string[],contribution:TextRunContribution){
 if(!jobKeys.length||new Set(jobKeys).size!==jobKeys.length)throw Error('Residual contribution requires distinct committed extraction jobs');
 const authenticated=authenticateTextRunContribution(contribution),receipts:StepReceipt[]=[],results:z.infer<typeof ResidualExtractionSchema>[]=[];
 if(authenticated.sourceArtifactKind!=='native_extraction_output'||authenticated.extractionRun.assignmentMode!=='codex-only')throw Error('Residual contribution requires its genuine Codex-only native run');
 for(const jobKey of jobKeys){
  HashSchema.parse(jobKey);
  const committed=await pool.query<{spec:DistrictJobSpec;receipt:StepReceipt;receipt_sha256:string}>(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.job_key=$1 AND j.spec->>'step'='residual_extract' AND j.state IN ('succeeded','no_supported_case','held_quality') ORDER BY r.attempt DESC LIMIT 1`,[jobKey]);
  if(committed.rows.length!==1)throw Error('Residual contribution extraction is not committed');
  const row=committed.rows[0],encoded=encodeStepReceipt(row.receipt),selector=ExtractionSelectorSchema.parse(row.spec.selector);
  if(encoded.sha256!==row.receipt_sha256||encoded.receipt.jobKey!==jobKey||canonicalJobIdentity(row.spec).jobKey!==jobKey||encoded.receipt.outputHashes.length!==1||!encoded.receipt.dependencyReceiptIds.includes(selector.preparationReceiptId))throw Error('Residual contribution StepReceipt binding mismatch');
  const source=await loadResidualSource(cas,selector),outputHash=encoded.receipt.outputHashes[0];
  await assertManagedSourceReadable(join(cas.root,'sha256',outputHash.slice(0,2),outputHash),policyOptions(source.receipt));
  const result=ResidualExtractionSchema.parse(JSON.parse((await cas.read(outputHash)).toString('utf8')));
  if(result.documentId!==selector.documentId||result.policyReceiptSha256!==selector.policyReceiptSha256||result.preparationJobKey!==selector.preparationJobKey||result.result.sourceSha256!==source.document.sha256||result.result.municipalityId!==source.municipality.id||result.result.taskId!==jobKey||result.preparationReceiptSha256!==selector.preparationReceiptSha256||result.preparationReceiptId!==selector.preparationReceiptId||result.preparedArtifactSha256!==selector.preparedArtifactSha256||result.corpusSha256!==authenticated.pins.corpusSha256||result.registrySha256!==authenticated.pins.registrySha256||result.result.promptSha256!==authenticated.pins.promptContractSha256||result.result.schemaSha256!==authenticated.pins.schemaSha256)throw Error('Residual contribution original run/provenance mismatch');
  receipts.push(encoded.receipt);results.push(result);
 }
 const records=results.flatMap(row=>row.result.records),quarantine=results.flatMap(row=>row.result.quarantine);
 if(semanticHash(records)!==semanticHash(authenticated.records)||semanticHash(quarantine)!==semanticHash(authenticated.quarantine.cases))throw Error('Residual contribution rewrites or omits native outputs');
 const groups=new Set(results.map(row=>canonicalJson({municipalityId:row.result.municipalityId,sourceSha256:row.result.sourceSha256})));
 if(groups.size!==results.length||groups.size!==authenticated.groups.attempted.length||authenticated.groups.attempted.some(group=>!groups.has(canonicalJson(group))))throw Error('Residual contribution attempt accounting differs from committed groups');
 return {contribution,stepReceipts:receipts,results};
}
