import {readFile,readdir,lstat,realpath,writeFile,mkdir,rename} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {Pool} from 'pg';
import {z} from 'zod';
import {canonicalJson,digest,HashSchema} from './district-adapter-contract.ts';
import {DistrictCas} from './district-cas.ts';
import {DistrictJobStore} from './district-jobs.ts';
import {exportRun} from './district-r1.ts';
import {QueueTextSealInputSchema} from './district-queue-text-run.ts';
import {r1TextCompositionInputSchema,loadR1TextCompositionInput,buildR1TextCompositionContext} from './district-r1-text-composition.ts';
import {authenticatePublicationProvenance,privatePublicationProvenanceSchema,type PrivatePublicationProvenance} from './district-publication-provenance.ts';
import {publicationPolicyReceiptInventorySchema} from './district-publication-policy.ts';
import {CriticalAssessmentInventorySchema} from './district-critical-assessment-contract.ts';
import {districtRegistrySchema} from './district-registry.ts';
import {withPreparedKnowledge} from './prepare-knowledge.ts';
import {publish} from './publish.ts';
import {priorReleaseSchema,loadPriorPublicationRelease,preloadPriorPublicationReleases} from './district-publication-predecessor.ts';
import {ReplayClocksSchema,ReplayReceiptSchema,readReplayPin,requiredReplayStaging,replayPipeline} from './replay-pipeline.ts';
import {verifyDataRelease} from './data-release.ts';
import {loadRelease} from './mcp-release.ts';
import {writeManagedSourceArtifact,type SourceArtifactBinding} from './district-private-io.ts';
import {assertCivicPolicyAuthority,CIVIC_ACQUISITION_DECISION_ID,assertSourceHostsNotOptedOut,initializeManagedAcquisitionLane,withManagedSourceScratch,withManagedSourceWrite} from './civic-opt-out.ts';
import {root,cacheDir} from './common.ts';
import {authenticateStep8Campaign,assertStep8ExportMembership,reserveStep8Generation,classifyStep8Exception} from './r1-step8-governance.ts';
import {Step8CurrentGenerationSchema} from './r1-step8-current-policy.ts';
import {auditStep8,recheckStep8Audit,relocateStep8AuditCampaign} from './r1-step8-audit.ts';
import {STEP8_ALLOWANCE_READ_PLAN} from './r1-step8-allowance-audit.ts';
import {NativeProvenancePinSchema,ProvenanceSupplementSelectionSchema,ReconstructionWorkersSchema,ReconstructionTimingSchema,createWitnessedProvenanceContext,assertCanonicalSealSelection,authenticateCanonicalSealProvenance,exportCanonicalTextContribution,canonicalManagedSourceAudit,type WitnessedProvenanceContext} from './r1-step8-provenance.ts';
import {Step8StagingAssemblySchema,prepareStep8Staging,commitStep8Staging,readPreparedStep8Campaign,type PreparedStep8Staging} from './r1-step8-staging.ts';
import {authenticateImportDispositions} from './r1-step8-import-dispositions.ts';

const Pin=z.object({path:z.string().refine(isAbsolute,'Operator paths must be absolute'),sha256:HashSchema}).strict();
const sealSchema=z.object({compositionArtifactSha256:HashSchema,privateProvenance:Pin.passthrough(),policyInventory:Pin.passthrough(),criticalInventory:Pin.passthrough()}).passthrough();
export const Step8InputSchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-step8-v1'),
 expectedSources:z.number().int().positive(),expectedDocuments:z.number().int().positive(),
 campaign:Pin,
 currentGeneration:Step8CurrentGenerationSchema,
 seals:z.array(QueueTextSealInputSchema.safeExtend({sealResult:Pin,provenanceSupplement:ProvenanceSupplementSelectionSchema.optional()})).min(1),
 nativeSealSelection:NativeProvenancePinSchema,reconstructionWorkers:ReconstructionWorkersSchema,reconstructionTiming:ReconstructionTimingSchema,
 importDispositionDecision:Pin.optional(),
 structuredRunIds:z.array(z.uuid()).min(1),registry:Pin,privateProvenance:Pin,
 staging:z.array(Pin.extend({destination:z.string().min(1)}).strict()).min(1),
 identityAssessments:Pin.optional(),criticalAssessments:Pin.optional(),regionalPolicyReceipts:Pin.optional(),
 priorRelease:priorReleaseSchema,legacyPreviousReleases:z.record(z.string(),priorReleaseSchema).optional(),
 asOf:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),clocks:ReplayClocksSchema,
 casRoot:z.string().refine(isAbsolute),outputRoot:z.string().refine(isAbsolute),
 policy:z.object({stateDir:z.string().refine(isAbsolute),authorityId:z.string().min(1),authoritySha256:HashSchema}).strict(),
}).strict();
export type Step8Input=z.infer<typeof Step8InputSchema>;
const Step8AssemblyExecutionSchema=Step8InputSchema.omit({campaign:true,registry:true,privateProvenance:true,staging:true,identityAssessments:true,criticalAssessments:true,regionalPolicyReceipts:true}).extend({stagingAssembly:Pin});
export const Step8OperatorInputSchema=z.union([Step8InputSchema,Step8AssemblyExecutionSchema]);
export type Step8OperatorInput=z.infer<typeof Step8OperatorInputSchema>;
const encoded=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const inside=(parent:string,path:string)=>{const child=relative(parent,path);return !!child&&!child.startsWith('..')&&!isAbsolute(child);};
const uniqueBindings=(bindings:SourceArtifactBinding[])=>[...new Map(bindings.map(binding=>[canonicalJson(binding),binding])).values()];

/** This is deliberately a plan, not a policy admission, cache export or job execution. */
export function step8ReadPlan(input:Step8OperatorInput){
 const staging='stagingAssembly' in input?{stagingAssembly:input.stagingAssembly}:{campaign:input.campaign,registry:input.registry,privateProvenance:input.privateProvenance,staging:input.staging,identityAssessments:input.identityAssessments,criticalAssessments:input.criticalAssessments,regionalPolicyReceipts:input.regionalPolicyReceipts};
 return {schemaVersion:'stadtstack-r1-step8-read-plan-v1',writes:[],network:false,providers:false,
  reconstruction:{passes:1,workers:input.reconstructionWorkers,timing:input.reconstructionTiming,workerBudgetBytes:1.5*1024**3,reserveBytes:4*1024**3,minimumMemAvailableBytes:(input.reconstructionWorkers*1.5+4)*1024**3,transport:'trusted child IPC; no passed-result files'},
  reads:{...staging,seals:input.seals,structuredRunIds:input.structuredRunIds,currentGeneration:input.currentGeneration,allowance:STEP8_ALLOWANCE_READ_PLAN,nativeSealSelection:input.nativeSealSelection,importDispositionDecision:input.importDispositionDecision,
   casRoot:input.casRoot,policy:input.policy,priorRelease:input.priorRelease,legacyPreviousReleases:input.legacyPreviousReleases,host:['/proc/meminfo'],
   database:['district_pipeline.jobs','district_pipeline.step_receipts','district_pipeline.artifacts','district_pipeline.r1_codex_documents','district_pipeline.r1_codex_call_intents','district_pipeline.r1_codex_call_authorizations','district_pipeline.r1_codex_allowance_intents','district_pipeline.preauthorizations','district_pipeline.assessment_bridge_leases'],
   transitive:'Every pinned assembly/retained member, seal provenance member, queue dependency, original policy/HTTP observation, generation archive, model answer, A/B/C receipt and native parser output; no provider cache miss fallback.'},
  wouldWrite:{managedRoot:input.outputRoot,generationClaim:input.outputRoot+'.claim',release:join(input.outputRoot,'release'),preparationRoot:input.outputRoot+'-preparation',replayWorkspace:input.outputRoot+'-replay',staging:'stagingAssembly' in input?'fresh managedRoot declared in pinned assembly':undefined,privateControls:'temporary metadata only, removed on exit',audit:'same-host canonical audit DB and managed CAS; execute only, never plan'},
  gates:['authenticated exports','current policy','quality','district coverage and action-stage slice','critical A/B/C','identity','all release members','exact manifest bytes and ID','vm_candidate loader'],
  notAuthorized:['model execution','source acquisition','hosted deployment','value acceptance (step 9)']};
}

async function resolveStep8OperatorInput(invocation:Step8OperatorInput,pool:Pool,context:WitnessedProvenanceContext){
 if(!('stagingAssembly' in invocation))return {input:invocation,prepared:undefined};
 const assembly=Step8StagingAssemblySchema.parse(JSON.parse((await readReplayPin(invocation.stagingAssembly,process.cwd())).toString('utf8')));
 if(canonicalJson(assembly.policy)!==canonicalJson(invocation.policy))throw Error('Staging assembly belongs to another policy authority');
 for(const candidate of [assembly.managedRoot,assembly.managedRoot+'.claim'])for(const output of [invocation.outputRoot,invocation.outputRoot+'.claim',invocation.outputRoot+'-preparation',invocation.outputRoot+'-replay'])if(candidate===output||inside(candidate,output)||inside(output,candidate))throw Error('Staging and candidate output roots overlap');
 const prepared=await prepareStep8Staging(assembly,pool,context);
 try{const {stagingAssembly:_,...base}=invocation;return {input:Step8InputSchema.parse({...base,...prepared.inputs}),prepared};}catch(error){await prepared.dispose();throw error;}
}

/** Standalone audit owns exactly one pass and never commits prepared staging. */
export async function auditStep8Operator(raw:unknown,pool:Pool){
 const invocation=Step8OperatorInputSchema.parse(raw),context=await createWitnessedProvenanceContext(invocation.nativeSealSelection,invocation.policy,{pool,casRoot:invocation.casRoot,catalogue:invocation.currentGeneration.catalogue,mode:'step8',workers:invocation.reconstructionWorkers,timing:invocation.reconstructionTiming,importDispositionDecision:invocation.importDispositionDecision});
 let prepared:PreparedStep8Staging|undefined;
 try{const resolved=await resolveStep8OperatorInput(invocation,pool,context);prepared=resolved.prepared;return await auditStep8(resolved.input,pool,context,prepared);}
 finally{try{await context.finish();}finally{await prepared?.dispose();}}
}

/** One invocation uses one canonical source pass for audit, union derivation,
 * staging preparation and export. Close that epoch before any managed write. */
export async function runStep8(raw:unknown,pool:Pool){
 const invocation=Step8OperatorInputSchema.parse(raw),output=resolve(invocation.outputRoot),cas=new DistrictCas(resolve(invocation.casRoot)),policy=invocation.policy;
 if(new Set(invocation.structuredRunIds).size!==invocation.structuredRunIds.length)throw Error('Duplicate native run selection');
 if(invocation.seals.length!==invocation.expectedSources)throw Error('Incomplete sealed source set');
 if(new Set(invocation.seals.flatMap(seal=>seal.jobKeys)).size!==invocation.seals.reduce((n,seal)=>n+seal.jobKeys.length,0))throw Error('Duplicate extraction jobs across source seals');
 if(!inside(await realpath(cacheDir),output)||output.split('/').some(part=>part==='out'||part==='release'))throw Error('Step8 requires a fresh candidate root beneath repository cache, never out/ or release/');
 try{await lstat(output);throw Error('Step8 candidate root already exists; use a fresh generation');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const parent=await realpath(dirname(output));if(parent!==await realpath(cacheDir)&&!inside(await realpath(cacheDir),parent))throw Error('Candidate parent escapes cache');
 await assertCivicPolicyAuthority(policy);
 const provenanceContext=await createWitnessedProvenanceContext(invocation.nativeSealSelection,policy,{pool,casRoot:invocation.casRoot,catalogue:invocation.currentGeneration.catalogue,mode:'step8',workers:invocation.reconstructionWorkers,timing:invocation.reconstructionTiming,importDispositionDecision:invocation.importDispositionDecision});
 let provenanceFinished=false,preparedStaging:PreparedStep8Staging|undefined;
 try{
 const resolved=await resolveStep8OperatorInput(invocation,pool,provenanceContext);let input=resolved.input;preparedStaging=resolved.prepared;
 let generationAudit=await auditStep8(input,pool,provenanceContext,preparedStaging);
 if(generationAudit.status!=='compatible')throw Error('Step8 read-only generation audit blocked: '+JSON.stringify(generationAudit.blockers));
 const claim=await reserveStep8Generation(output);
 let external=await authenticatePublicationProvenance(input.privateProvenance.path,input.privateProvenance.sha256,policy);
 const inventory=privatePublicationProvenanceSchema.parse(JSON.parse((await readReplayPin(input.privateProvenance,process.cwd())).toString('utf8')));
 for(const pin of [input.registry,...input.staging,input.identityAssessments,input.criticalAssessments,input.regionalPolicyReceipts])if(pin&&digest(await external.read(pin.path))!==pin.sha256)throw Error('Operator input differs from its independent pin');
 const pins=new Map<string,PrivatePublicationProvenance['inputs'][number]>();
 const addInventory=(entries:PrivatePublicationProvenance['inputs'],base:string)=>{for(const entry of entries){const pin={...entry,path:resolve(base,entry.path)},old=pins.get(pin.path);if(old&&(old.sha256!==pin.sha256||old.bytes!==pin.bytes))throw Error('Conflicting independent provenance pin');pins.set(pin.path,old?{...pin,bindings:uniqueBindings([...old.bindings,...pin.bindings])}:pin);}};
 addInventory(inventory.inputs,dirname(resolve(input.privateProvenance.path)));
 const producerBindings=(paths:Iterable<string>)=>uniqueBindings([...paths].flatMap(path=>{const pin=pins.get(path);if(!pin)throw Error('Missing authenticated producer pin: '+path);return pin.bindings.map(binding=>({...binding,independentAllowed:false}));}));
 const textProducerPaths=new Set<string>(),compositionArtifactPaths=new Set<string>(),assessmentProducers=new Map<string,string[]>();
 const campaignBytes=await (preparedStaging?readPreparedStep8Campaign(preparedStaging,input.campaign):external.read(input.campaign.path));if(digest(campaignBytes)!==input.campaign.sha256)throw Error('Campaign independent pin mismatch');
 const campaign=await authenticateStep8Campaign(JSON.parse(campaignBytes.toString('utf8')),path=>external.read(path),policy);
 if(campaign.sources.length!==input.expectedSources||campaign.sources.reduce((n,source)=>n+source.documents.length,0)!==input.expectedDocuments)throw Error('Campaign totals mismatch');
 const managed=canonicalManagedSourceAudit(provenanceContext);
 const importDispositions=await authenticateImportDispositions({decision:input.importDispositionDecision,nativeSealSelection:input.nativeSealSelection,catalogue:input.currentGeneration.catalogue,seals:input.seals,policy,control:pin=>readReplayPin(pin,process.cwd()),managed:pin=>managed.read(pin.path,pin.sha256)});
 const remainingSources=new Map(campaign.sources.map(source=>[source.corpus.sha256,source])),sourceDispositions:unknown[]=[],auditAssessments:Array<{recordId:string;item:string;A:string;B:string;C:string}>=[];
 const compositions:z.infer<typeof r1TextCompositionInputSchema>[]=[],policyInventories:z.infer<typeof publicationPolicyReceiptInventorySchema>[]=[],criticalInventories:z.infer<typeof CriticalAssessmentInventorySchema>[]=[];
 const exports=[],derivedSupplements:Array<{sourceSeal:typeof input.seals[number]['sealResult'];value:NonNullable<Awaited<ReturnType<typeof authenticateCanonicalSealProvenance>>['generatedSupplement']>}>=[];
 await assertCanonicalSealSelection(provenanceContext,input.seals.map(({sealResult,provenanceSupplement:_,...queue})=>({output:sealResult,queue})));
 for(const selected of input.seals){
  const seal=sealSchema.parse(JSON.parse((await readReplayPin(selected.sealResult,process.cwd())).toString('utf8')));
  const authenticated=await authenticateCanonicalSealProvenance(selected.sealResult,selected.provenanceSupplement,policy,provenanceContext),source=authenticated.reader;
  if(authenticated.generatedSupplement)derivedSupplements.push({sourceSeal:selected.sealResult,value:authenticated.generatedSupplement});
  addInventory(authenticated.inventory.inputs,dirname(resolve(selected.provenanceSupplement?.inventory.path??seal.privateProvenance.path)));
  const sourceBase=dirname(resolve(selected.provenanceSupplement?.inventory.path??seal.privateProvenance.path)),sourcePaths=authenticated.inventory.inputs.map(pin=>resolve(sourceBase,pin.path));
  for(const path of sourcePaths)textProducerPaths.add(path);
  const compositionPath=join(cas.root,'sha256',seal.compositionArtifactSha256.slice(0,2),seal.compositionArtifactSha256),bytes=await source.read(compositionPath);
  if(digest(bytes)!==seal.compositionArtifactSha256)throw Error('Sealed composition digest mismatch');
  const serialized=r1TextCompositionInputSchema.parse(JSON.parse(bytes.toString('utf8')));
  for(const contribution of serialized.contributions)for(const pin of Object.values(contribution.artifacts))if(pin)compositionArtifactPaths.add(pin.path);
  if(serialized.contributions.length!==1||serialized.retainedPublication)throw Error('Step8 source export requires one sealed native contribution');
  const composition=await loadR1TextCompositionInput(serialized,async pin=>{
   const path=join(cas.root,'sha256',pin.sha256.slice(0,2),pin.sha256);if(pin.path!==path)throw Error('Source seal escapes managed CAS');return source.read(path);
  });
  const exported=await exportCanonicalTextContribution(provenanceContext,selected.sealResult,selected.jobKeys,composition.contributions[0]);
  const extraction=JSON.parse(Buffer.from(exported.contribution.artifacts.extractionRun.bytes).toString('utf8'));
  const expectedSource=remainingSources.get(exported.contribution.pins.corpusSha256);if(!expectedSource)throw Error('Duplicate or unexpected sealed source');
  const imports=importDispositions.filter(entry=>entry.corpusSha256===expectedSource.corpus.sha256&&entry.municipalityId===expectedSource.municipalityId&&entry.sourceId===expectedSource.sourceId);
  assertStep8ExportMembership(expectedSource,exported.results,exported.terminalDocumentExceptions,extraction.queue.stepReceipts,imports);remainingSources.delete(expectedSource.corpus.sha256);
  for(const [key,schema] of [['terminalDocumentExceptions',QueueTextSealInputSchema.shape.terminalDocumentExceptions],['terminalAssessmentExceptions',QueueTextSealInputSchema.shape.terminalAssessmentExceptions]] as const){const actual=exported[key].filter(pin=>pin.reasonCode!=='duplicate_source_content').map(pin=>({documentId:pin.documentId,step:pin.step,jobKey:pin.jobKey,receiptId:pin.receiptId,receiptSha256:pin.receiptSha256,reasonCode:pin.reasonCode}));if(canonicalJson([...schema.parse(selected[key])].sort((a,b)=>a.jobKey.localeCompare(b.jobKey)))!==canonicalJson(actual))throw Error('Source terminal exception selection differs from seal');}
  const holdPins=exported.assessmentItemHolds.map(({preparationJobKey,itemBundleArtifactSha256,holdReceiptArtifactSha256})=>({preparationJobKey,itemBundleArtifactSha256,holdReceiptArtifactSha256}));
  if(canonicalJson([...selected.assessmentItemHolds].sort((a,b)=>a.holdReceiptArtifactSha256.localeCompare(b.holdReceiptArtifactSha256)))!==canonicalJson(holdPins))throw Error('Source item hold selection differs from authenticated seal');
  const cases=JSON.parse(Buffer.from(exported.contribution.artifacts.quarantine.bytes).toString('utf8')).cases,admittedRecords=JSON.parse(Buffer.from(exported.contribution.artifacts.records.bytes).toString('utf8')).records;
  const assessmentPins=z.array(z.object({recordId:z.string(),pins:CriticalAssessmentInventorySchema.shape.records.element.nullable()}).passthrough()).parse(extraction.queue.assessments);
  for(const result of exported.results){
   const documentCases=cases.filter((entry:{documentId?:string;sourceSha256?:string})=>entry.documentId===result.documentId||!entry.documentId&&entry.sourceSha256===result.result.sourceSha256),records=admittedRecords.filter((entry:{extraction:{inputSha256:string}})=>entry.extraction.inputSha256===result.result.sourceSha256);
   if(!records.length&&!documentCases.length)throw Error('Document has neither admission nor explicit disposition');
   const itemHolds=exported.assessmentItemHolds.filter(entry=>entry.documentId===result.documentId);
   sourceDispositions.push({municipalityId:expectedSource.municipalityId,sourceId:expectedSource.sourceId,documentId:result.documentId,sourceSha256:result.result.sourceSha256,jobKey:result.result.taskId,admittedRecordIds:records.map((entry:{id:string})=>entry.id),cases:documentCases,classification:classifyStep8Exception(documentCases),assessments:assessmentPins.filter(entry=>result.result.records.some(record=>record.id===entry.recordId)),terminalAssessmentExceptions:exported.terminalAssessmentExceptions.filter(entry=>entry.documentId===result.documentId),...(itemHolds.length?{assessmentItemHolds:itemHolds}:{}),queueEvidence:extraction.queue});
  }
  for(const exception of exported.terminalDocumentExceptions){const documentCases=cases.filter((entry:{documentId?:string})=>entry.documentId===exception.documentId);if(!documentCases.length)throw Error('Terminal document lacks explicit quarantine disposition');sourceDispositions.push({municipalityId:expectedSource.municipalityId,sourceId:expectedSource.sourceId,documentId:exception.documentId,sourceSha256:exception.sourceSha256,jobKey:exception.jobKey,admittedRecordIds:[],cases:documentCases,classification:{...classifyStep8Exception(documentCases),terminal:true},terminalDocumentException:exception,assessments:[],queueEvidence:extraction.queue});}
  for(const disposition of imports)sourceDispositions.push({municipalityId:disposition.municipalityId,sourceId:disposition.sourceId,documentId:disposition.documentId,sourceSha256:disposition.sourceSha256,admittedRecordIds:[],cases:[],classification:{critical:false,rights:disposition.reasonCode==='source_policy_stale',disagreement:false},importDisposition:disposition,assessments:[]});
  for(const entry of assessmentPins)if(entry.pins){const pathFor=(sha256:string)=>join(cas.root,'sha256',sha256.slice(0,2),sha256);auditAssessments.push({recordId:entry.recordId,item:pathFor(entry.pins.itemArtifactSha256),A:pathFor(entry.pins.AArtifactSha256),B:pathFor(entry.pins.BArtifactSha256),C:pathFor(entry.pins.CArtifactSha256)});assessmentProducers.set(entry.recordId,sourcePaths);}
  if(canonicalJson([...selected.reconciliationJobKeys].sort())!==canonicalJson(extraction.queue.reconciliationJobKeys))throw Error('Source reconciliation selection differs from seal');
  compositions.push(serialized);
  policyInventories.push(publicationPolicyReceiptInventorySchema.parse(JSON.parse((await source.read(seal.policyInventory.path)).toString('utf8'))));
  criticalInventories.push(CriticalAssessmentInventorySchema.parse(JSON.parse((await source.read(seal.criticalInventory.path)).toString('utf8'))));
  exports.push({compositionArtifactSha256:seal.compositionArtifactSha256,runId:exported.contribution.runId,committedDocuments:exported.results.length+exported.terminalDocumentExceptions.length,importRejectedDocuments:imports.length,jobKeys:selected.jobKeys,reconciliationJobKeys:selected.reconciliationJobKeys,terminalDocumentExceptions:exported.terminalDocumentExceptions,terminalAssessmentExceptions:exported.terminalAssessmentExceptions,importDispositions:imports,provenanceSupplement:selected.provenanceSupplement,...(exported.assessmentItemHolds.length?{assessmentItemHolds:exported.assessmentItemHolds}:{})});
 }
 await recheckStep8Audit(generationAudit);
 provenanceFinished=true;await provenanceContext.finish();
 if(exports.reduce((n,item)=>n+item.committedDocuments+item.importRejectedDocuments,0)!==input.expectedDocuments||exports.reduce((n,item)=>n+item.importRejectedDocuments,0)!==importDispositions.length)throw Error('Incomplete native/import-rejection document set');
 if(remainingSources.size||sourceDispositions.length!==input.expectedDocuments)throw Error('Campaign disposition inventory incomplete');
 let stagingAssemblyResult;
 if(preparedStaging){
  stagingAssemblyResult=await commitStep8Staging(preparedStaging);input={...input,...stagingAssemblyResult.inputs};
  const relocated=await relocateStep8AuditCampaign(generationAudit,input.campaign,input.privateProvenance,policy);generationAudit=relocated.audit;external=relocated.provenance;
  const inventory=privatePublicationProvenanceSchema.parse(JSON.parse((await readReplayPin(input.privateProvenance,process.cwd())).toString('utf8')));addInventory(inventory.inputs,dirname(input.privateProvenance.path));
 }
 // Native aggregates depend on their actual native producer closure, never on
 // unrelated retained city rows. Retained members keep their own exact custody.
 const textBindings=producerBindings(textProducerPaths),auditBindings=producerBindings(pins.keys());
 const write=async(name:string,value:unknown,artifactBindings:SourceArtifactBinding[],bytes?:Buffer)=>{
  await claim.assertOwned();
  const bindings=uniqueBindings(artifactBindings.map(binding=>({...binding,independentAllowed:false}))),body=bytes??encoded(value),path=join(output,name),sha256=await writeManagedSourceArtifact(output,path,body,bindings,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
  await claim.assertOwned();
  const pin={path,sha256,bytes:body.length,bindings};pins.set(path,pin);return {path,sha256};
 };
 // Reuse Core's existing multi-entry boundary: one closed public snapshot, one
 // source scratch, exact per-file entries, no direct inventory manipulation.
 const writeBatch=async(items:Array<{name:string;bytes:Buffer;bindings:SourceArtifactBinding[]}>)=>{
  const paths=new Set<string>(),rows=items.map(item=>{const path=resolve(output,item.name),relativePath=relative(output,path);if(!relativePath||relativePath.startsWith('..')||isAbsolute(relativePath)||paths.has(path))throw Error('Invalid/duplicate candidate batch path');paths.add(path);const bindings=uniqueBindings(item.bindings.map(binding=>({...binding,independentAllowed:false})));if(!bindings.length)throw Error('Candidate batch lacks producer bindings');return {...item,path,relativePath,bindings,sha256:digest(item.bytes)};});
  if(!rows.length)throw Error('Empty candidate batch');
  const options={...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts' as const},bindings=uniqueBindings(rows.flatMap(row=>row.bindings));
  await claim.assertOwned();await assertSourceHostsNotOptedOut(bindings.map(binding=>binding.url),policy);await initializeManagedAcquisitionLane(output,options);
  await withManagedSourceScratch(output,bindings.map(({independentAllowed:_,...binding})=>binding),async scope=>{
   await scope.assertActive();
   for(const [index,row] of rows.entries())await writeFile(join(scope.directory,'artifact-'+index),row.bytes,{mode:0o600,flag:'wx'});
   const entries=rows.flatMap(row=>row.bindings.map(binding=>({...binding,relativePath:row.relativePath,contentSha256:row.sha256})));
   await withManagedSourceWrite(output,entries,async()=>{for(const [index,row] of rows.entries()){await claim.assertOwned();await mkdir(dirname(row.path),{recursive:true,mode:0o700});await rename(join(scope.directory,'artifact-'+index),row.path);}},policy);
  },{...options,purpose:'artifact'});
  await claim.assertOwned();for(const row of rows)pins.set(row.path,{path:row.path,sha256:row.sha256,bytes:row.bytes.length,bindings:row.bindings});
 };
 const nativeProvenanceSupplements=[];
 for(const {sourceSeal,value} of derivedSupplements){
  const prefix='audit/native-provenance/'+sourceSeal.sha256,inventory=await write(prefix+'-inventory.json',undefined,textBindings,Buffer.from(value.inventoryBytes)),attestation=await write(prefix+'-attestation.json',undefined,textBindings,Buffer.from(value.attestationBytes));
  if(inventory.sha256!==value.inventorySha256||attestation.sha256!==value.attestationSha256)throw Error('Canonical supplemental evidence bytes changed');
  nativeProvenanceSupplements.push({sourceSeal,targets:value.targets,inventory,attestation});
 }
 const registryBytes=await external.read(input.registry.path);if(digest(registryBytes)!==input.registry.sha256)throw Error('Registry independent pin mismatch');
 const native=await exportRun(new DistrictJobStore(pool),cas,districtRegistrySchema.parse(JSON.parse(registryBytes.toString('utf8'))),{runIds:input.structuredRunIds},{generatedAt:input.clocks.recordsGeneratedAt,policy});
 if(!native)throw Error('Native export did not return an authenticated run');
 if(input.structuredRunIds.some(runId=>!native.receipts.some(row=>row.receipt.runId===runId)))throw Error('A selected native run has no committed structured receipt');
 const nativeBindings=uniqueBindings(native.bindings.map(binding=>({...binding,independentAllowed:false}))),knowledgeBindings=uniqueBindings([...textBindings,...nativeBindings,...producerBindings([input.identityAssessments?.path,input.criticalAssessments?.path].filter((path):path is string=>!!path))]);
 // Export committed native receipts to the same managed CAS contract used by the CLI.
 for(const row of native.receipts){await claim.assertOwned();const bytes=Buffer.from(canonicalJson(row.receipt));if(digest(bytes)!==row.sha256)throw Error('Native receipt digest mismatch');const bindings=nativeBindings.filter(binding=>binding.kind==='http_observation'&&row.receipt.inputHashes.includes(binding.receiptSha256));if(!bindings.length)throw Error('Native receipt lacks its exact producer bindings');await writeManagedSourceArtifact(cas.root,join(cas.root,'sha256',row.sha256.slice(0,2),row.sha256),bytes,bindings,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});await claim.assertOwned();}
 const sourceDispositionInventory=await write('source-dispositions.json',{schemaVersion:'stadtstack-r1-step8-source-dispositions-v1',status:'authenticated_not_released',generationNonce:claim.nonce,campaign:input.campaign,complete:true,sourceDispositions},textBindings);
 const generationAuditEvidence=await write('audit/current-generation.json',generationAudit,auditBindings);
 const registry=await write('inputs/registry.json',null,uniqueBindings([...nativeBindings,...producerBindings([input.registry.path])]),native.registryBytes),structuredRun=await write('inputs/structured-run.json',native.run,nativeBindings);
 const composition=r1TextCompositionInputSchema.parse({schemaVersion:'district-r1-text-composition-input-v1',generatedAt:input.clocks.recordsGeneratedAt,approvedRunOrder:compositions.flatMap(item=>item.approvedRunOrder),admissions:compositions.flatMap(item=>item.admissions),contributions:compositions.flatMap(item=>item.contributions)});
 const context=buildR1TextCompositionContext(await loadR1TextCompositionInput(composition,pin=>readReplayPin(pin,process.cwd())));
 const textComposition=await write('inputs/text-composition.json',composition,textBindings),candidateRecords=await write('inputs/records.json',context.knowledge,textBindings),candidateQuarantine=await write('inputs/quarantine.json',{...context.coverage.quarantine,generatedAt:input.clocks.quarantineGeneratedAt},textBindings),identityState=await write('inputs/identity.json',{identityAssertions:context.knowledge.identityAssertions,identityAdmissions:context.knowledge.identityAdmissions},textBindings);
 const currentAdmissionReceipts:Record<string,string>={};for(const item of policyInventories)for(const [original,current] of Object.entries(item.currentAdmissionReceipts??{})){if(currentAdmissionReceipts[original]&&currentAdmissionReceipts[original]!==current)throw Error('Conflicting source policy continuation');currentAdmissionReceipts[original]=current;}
 const nativePolicy=native.run.records.map(record=>({recordId:record.id,receipts:[record.source,...record.supportingSources].map(source=>({sourceUrl:source.url,sourceSha256:source.sha256,receiptSha256:source.policyReceiptSha256}))}));
 const policyReceipts=await write('inputs/policy.json',publicationPolicyReceiptInventorySchema.parse({records:[...policyInventories.flatMap(item=>item.records),...nativePolicy],currentAdmissionReceipts}),knowledgeBindings);
 if(input.criticalAssessments){const bytes=await external.read(input.criticalAssessments.path);if(digest(bytes)!==input.criticalAssessments.sha256)throw Error('Critical inventory pin mismatch');criticalInventories.push(CriticalAssessmentInventorySchema.parse(JSON.parse(bytes.toString('utf8'))));}
 const criticalAssessments=await write('inputs/critical.json',CriticalAssessmentInventorySchema.parse({records:criticalInventories.flatMap(item=>item.records)}),uniqueBindings([...textBindings,...producerBindings(input.criticalAssessments?[input.criticalAssessments.path]:[])]));
 const publicationPaths=[registry,structuredRun,textComposition,candidateRecords,candidateQuarantine,identityState,policyReceipts,criticalAssessments,...input.staging,...[input.identityAssessments,input.regionalPolicyReceipts].filter((pin):pin is NonNullable<typeof pin>=>!!pin)].map(pin=>pin.path).concat([...compositionArtifactPaths]);
 const saveProvenance=(publicationInputs?:{path:string;sha256:string})=>{const paths=new Set([...publicationPaths,...(publicationInputs?[publicationInputs.path]:[])]),inputs=[...paths].sort().map(path=>{const pin=pins.get(path);if(!pin)throw Error('Missing required publication/replay input: '+path);return pin;});return write('inputs/provenance.json',privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs}),producerBindings(paths));};
 let privateProvenance=await saveProvenance();
 const cataloguePin=input.staging.find(pin=>pin.destination==='catalogue.json');if(!cataloguePin)throw Error('Staged catalogue required');
 const catalogue=JSON.parse((await external.read(cataloguePin.path)).toString('utf8')),cities=z.array(z.string()).parse(catalogue.cities.map((city:{id:string})=>city.id));
 if(canonicalJson(input.staging.map(pin=>pin.destination).sort())!==canonicalJson(requiredReplayStaging(cities)))throw Error('Complete unique non-knowledge staging inventory required');
 const priorPaths=[...cities.flatMap(city=>[`cities/${city}/signals.geojson`,`cities/${city}/changes.json`]),'knowledge/records.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json'];
 const baseline=await loadPriorPublicationRelease(input.priorRelease,priorPaths,input.clocks.manifestGeneratedAt);
 const predecessors=await preloadPriorPublicationReleases([{prior:input.priorRelease,paths:priorPaths,targetGeneratedAt:input.clocks.manifestGeneratedAt},...Object.entries(input.legacyPreviousReleases??{}).map(([cityId,prior])=>({prior,paths:[`cities/${cityId}/signals.geojson`],targetGeneratedAt:baseline.manifest.generatedAt,targetReleaseId:baseline.manifest.id}))]);
 const preparation={registry:registry.path,records:candidateRecords.path,quarantine:candidateQuarantine.path,textComposition:textComposition.path,structuredRun:structuredRun.path,policyReceipts:policyReceipts.path,criticalAssessments:criticalAssessments.path,identityAssessments:input.identityAssessments?.path,privateProvenance,outputRoot:output+'-preparation',casRoot:cas.root,policyStateDir:policy.stateDir,policyAuthorityId:policy.authorityId,policyAuthoritySha256:policy.authoritySha256,coverageGeneratedAt:input.clocks.coverageGeneratedAt};
 const candidateDirectory=join(output,'release');
 const published=await withPreparedKnowledge(preparation,async prepared=>{
  const scratchOutput=join(prepared.scope.directory,'candidate');
  const manifest=await publish({stagingDir:prepared.stagingDir,outDir:scratchOutput,asOf:input.asOf,priorRelease:input.priorRelease,legacyPreviousReleases:input.legacyPreviousReleases,priorCityRoot:prepared.publication.priorDirectory,policyReceipts:policyReceipts.path,textComposition:textComposition.path,structuredRun:structuredRun.path,criticalAssessments:criticalAssessments.path,identityAssessments:input.identityAssessments?.path,regionalPolicyReceipts:input.regionalPolicyReceipts?.path,privateProvenance,casRoot:cas.root,policyStateDir:policy.stateDir,policyAuthorityId:policy.authorityId,policyAuthoritySha256:policy.authoritySha256,qualityGeneratedAt:input.clocks.qualityGeneratedAt,manifestGeneratedAt:input.clocks.manifestGeneratedAt},predecessors,prepared.publication);
  await verifyDataRelease(scratchOutput);
  const exceptionInventory={schemaVersion:'stadtstack-r1-step8-exceptions-v1',releaseId:manifest.id,campaign:input.campaign,sourceDispositionInventory,generationAuditEvidence,complete:true,sourceDispositions,native:{coverage:native.run.coverage,fieldHolds:native.fieldHolds},preparation:{publicationQuarantine:prepared.publicationQuarantine,criticalHolds:prepared.summary.criticalHolds,classification:classifyStep8Exception(prepared.publicationQuarantine)},assessments:auditAssessments};
  const staged=new Map(input.staging.map(pin=>[pin.destination,pin.path])),allPublicationBindings=producerBindings(publicationPaths);
  const stagedBindings=(destinations:string[])=>producerBindings(destinations.map(destination=>{const path=staged.get(destination);if(!path)throw Error('Missing release member producer: '+destination);return path;}));
  const releaseBindings=(member:string):SourceArtifactBinding[]=>{
   if(member.startsWith('knowledge/'))return knowledgeBindings;
   const city=/^cities\/([^/]+)\/(signals(?:\.min)?\.geojson|feed\.json|changes\.json)$/.exec(member);
   if(city)return stagedBindings([`cities/${city[1]}/signals.geojson`,...(city[2]==='feed.json'?[`cities/${city[1]}/feed.json`]:[])]);
   if(member.startsWith('core/'))return stagedBindings(['core/strausberg-facts.json','cities/strausberg/signals.geojson']);
   if(member==='regions/brandenburg-mol/topics.json')return uniqueBindings([...stagedBindings([member]),...producerBindings(input.regionalPolicyReceipts?[input.regionalPolicyReceipts.path]:[])]);
   if(member==='catalogue.json')return stagedBindings(['catalogue.json',...cities.map(city=>`cities/${city}/signals.geojson`)]);
   if(['quality-report.json','release-manifest.json','README.md'].includes(member))return allPublicationBindings;
   throw Error('Unknown release member producer: '+member);
  };
  const expected=new Map(manifest.files.map(file=>[file.path,file]));
  const files=await Promise.all([...expected.keys(),'release-manifest.json','README.md'].map(async member=>{
   const bytes=await readFile(join(scratchOutput,member)),pin=expected.get(member);
   if(pin&&(bytes.length!==pin.bytes||digest(bytes)!==pin.sha256))throw Error('Verified candidate member changed before snapshot: '+member);
   return {name:'release/'+member,bindings:releaseBindings(member),bytes};
  }));
  // Dependency controls contain native policy seals and authenticated stage
  // hashes, not retained city record values. Stage bytes remain separate exact
  // publication/replay inputs with their complete original binding sets.
  const publicationInputsBytes=files.find(file=>file.name==='release/knowledge/publication-inputs.json')?.bytes;if(!publicationInputsBytes)throw Error('Publication descriptor missing from verified manifest');
  return {manifest,exceptionInventory,files,publicationInputsBytes};
 },{staging:input.staging.map(pin=>({destination:pin.destination,pin})),prior:{release:input.priorRelease,paths:priorPaths,targetGeneratedAt:input.clocks.manifestGeneratedAt,targetReleaseId:'',cache:predecessors}});
 // Only verified public bytes leave the prepared scope. It is disposed before
 // outer managed writes; Core rechecks their exact live producers at persistence.
 const {manifest}=published;
 await write('exception-inventory.json',published.exceptionInventory,knowledgeBindings);
  const auditManifest=[];
  for(const [index,entry] of auditAssessments.entries()){const row:Record<string,string>={};for(const role of ['item','A','B','C'] as const){const bytes=await readFile(entry[role]),path=join(output,`audit/${index}-${role}.json`);if(digest(bytes)!==entry[role].split('/').at(-1))throw Error('Assessment handoff artifact hash mismatch');const producers=assessmentProducers.get(entry.recordId);if(!producers)throw Error('Missing assessment producer scope');await write(`audit/${index}-${role}.json`,null,producerBindings(producers),bytes);row[role]=path;}auditManifest.push(row);}
  await write('audit/assessments.json',auditManifest,textBindings);
 await writeBatch(published.files);
 const publicationInputs=await write('inputs/publication-inputs.json',null,knowledgeBindings,published.publicationInputsBytes);privateProvenance=await saveProvenance(publicationInputs);
 const pinFor=(name:string)=>{const pin=pins.get(join(output,name));if(!pin)throw Error('Missing persisted step8 artifact');return {path:pin.path,sha256:pin.sha256};};
 const locale=Intl.DateTimeFormat().resolvedOptions(),sourceFiles=(await readdir(join(root,'src'),{withFileTypes:true})).filter(file=>file.isFile()&&file.name.endsWith('.ts')).map(file=>'src/'+file.name).concat(['regional/taxonomy.mjs','package.json','scripts/r1-step8.ts','scripts/r1-step8.sh','scripts/r1-step8-offline.cjs']).sort();
 const receipt=ReplayReceiptSchema.parse({schemaVersion:'stadtstack-offline-replay-v2',mode:'retained_text_composition',registry,candidateRecords,candidateQuarantine,identityState,publicationInputs:pinFor('inputs/publication-inputs.json'),policyReceipts,criticalAssessments,identityAssessments:input.identityAssessments,regionalPolicyReceipts:input.regionalPolicyReceipts,privateProvenance,textComposition,structuredRun,clocks:input.clocks,staging:input.staging,priorRelease:input.priorRelease,legacyPreviousReleases:input.legacyPreviousReleases,expectedRelease:pinFor('release/release-manifest.json'),casRoot:cas.root,policyStateDir:policy.stateDir,policyAuthorityId:policy.authorityId,policyAuthoritySha256:policy.authoritySha256,workspace:output+'-replay',runtime:{node:process.versions.node,icu:process.versions.icu,unicode:process.versions.unicode,locale:locale.locale,timeZone:locale.timeZone,packageLockSha256:digest(await readFile(join(root,'package-lock.json'))),sourceFiles:await Promise.all(sourceFiles.map(async path=>({path,sha256:digest(await readFile(join(root,path)))})))}});
 const allPublicationBindings=producerBindings([...publicationPaths,publicationInputs.path]),replayReceipt=await write('replay-receipt.json',receipt,allPublicationBindings),proof=await replayPipeline(replayReceipt.path,replayReceipt.sha256);
 if(proof.comparison.releaseId!==manifest.id)throw Error('Exact replay bound another candidate');
 await write('replay-proof.json',proof,allPublicationBindings);
 const admitted=await loadRelease(candidateDirectory,{mode:'vm_candidate',policyOptions:policy});
 const exceptions=pinFor('exception-inventory.json'),assessmentManifestPin=pinFor('audit/assessments.json');
 const handoff=await write('step9-handoff.json',{schemaVersion:'stadtstack-r1-step9-handoff-v1',releaseId:manifest.id,candidateDirectory,exceptionInventory:exceptions,assessmentManifest:assessmentManifestPin,policy},allPublicationBindings);
 const gate={schemaVersion:'stadtstack-r1-step8-gate-v1',status:'passed',releaseId:manifest.id,manifestSha256:pinFor('release/release-manifest.json').sha256,candidateDirectory,campaign:input.campaign,generationNonce:claim.nonce,currentGeneration:input.currentGeneration,generationAuditEvidence,exceptionInventory:exceptions,step9Handoff:handoff,exports,nativeProvenanceSupplements,stagingAssembly:stagingAssemblyResult?.component,reconstruction:{canonicalPasses:1,sources:provenanceContext.witnesses,workers:provenanceContext.reconstructionWorkers},structuredRunIds:input.structuredRunIds,asOf:input.asOf,replayReceipt,replayAuditSha256:proof.persistence.auditSha256,checks:['current assessment generation','allowance accounting','native B purge acknowledgments','exact campaign membership','complete exception inventory','atomic generation ownership','native contributor custody','authenticated source exports','quality','coverage','critical assessments','identity admissions','current policy','every manifest member','exact manifest bytes and ID','vm_candidate loader'],knowledgeRecords:admitted.knowledge.records.length,valueAccepted:false,hostedReleaseAuthorized:false};
 await write('release-gate.json',gate,allPublicationBindings);return gate;
 }finally{try{if(!provenanceFinished)await provenanceContext.finish();}finally{await preparedStaging?.dispose();}}
}

/** Discover production inputs without invoking any managed reader (even read APIs
 * may take inventory locks). SQL is explicitly a read-only transaction. */
export async function discoverStep8Plan(repository:string,driverRoot:string,pool:Pool){
 const repositoryPath=await realpath(repository),driverPath=await realpath(driverRoot),sealResults:Array<{path:string;sha256:string}>=[];
 const visit=async(directory:string):Promise<void>=>{for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const path=join(directory,entry.name);if(entry.isDirectory())await visit(path);else if(entry.isFile()&&/seal.*\.json$/.test(entry.name)){try{const bytes=await readFile(path),value=JSON.parse(bytes.toString('utf8'));if(sealSchema.safeParse(value).success)sealResults.push({path,sha256:digest(bytes)});}catch(error){if(!(error instanceof SyntaxError))throw error;}}}};
 await visit(join(driverPath,'runs'));
 const client=await pool.connect();let runs;
 try{await client.query('BEGIN READ ONLY');runs=await client.query<{run_id:string;receipts:string}>(`SELECT run_id,count(*)::text AS receipts FROM district_pipeline.step_receipts WHERE run_id::text LIKE ANY($1::text[]) GROUP BY run_id ORDER BY run_id`,[['6a60345b%','f311d068%','5f582f17%','329d949b%','3fe33cb6%']]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 const bytes=await readFile(join(repositoryPath,'release/release-manifest.json')),manifest=JSON.parse(bytes.toString('utf8'));
 return {schemaVersion:'stadtstack-r1-step8-production-plan-v1',readOnly:true,writes:[],network:false,providers:false,selectionValidated:false,repository:repositoryPath,driverRoot:driverPath,structuredRuns:runs.rows,sealedSources:sealResults.sort((a,b)=>a.path.localeCompare(b.path)),allowance:STEP8_ALLOWANCE_READ_PLAN,authenticPriorRelease:{gitCommit:'57bddbbd8b84b0634229ad9cd45b689bda7271ea',directory:'release',manifestSha256:digest(bytes),releaseId:manifest.id},wouldRead:[join(driverPath,'catalogue.json'),join(repositoryPath,'cache/districts/cas'),join(repositoryPath,'cache/districts/r1-operator'),join(repositoryPath,'release'),'/home/max/stadtstack-ops/STATUS_0.3.2.md','explicit staged catalogue/city feeds/signals/regional topics','independently pinned current-generation processing review and allowance/cohort approvals','independently pinned source provenance and current policy/identity/critical controls','Git predecessor members and authentic legacy predecessor change state','same-host canonical jobs, step receipts, call accounting and authorizations'],missing:['No independently pinned, explicitly selected complete 27-source manifest was supplied to discovery; historical seal files are candidates only. No publication or replay was attempted.'],requires:'Complete pinned Step8InputSchema manifest, including one graph asOf, clocks and full non-knowledge staging/provenance. This discovery is not execution approval or a passing release gate.'};
}
