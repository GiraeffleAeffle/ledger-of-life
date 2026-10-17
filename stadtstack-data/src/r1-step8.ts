import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {Pool} from 'pg';
import {z} from 'zod';
import {canonicalJson,digest,HashSchema} from './district-adapter-contract.ts';
import {DistrictCas} from './district-cas.ts';
import {DistrictJobStore} from './district-jobs.ts';
import {exportRun} from './district-r1.ts';
import {exportQueueTextContribution,QueueTextSealInputSchema} from './district-queue-text-run.ts';
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
import {assertCivicPolicyAuthority,CIVIC_ACQUISITION_DECISION_ID} from './civic-opt-out.ts';
import {root,cacheDir} from './common.ts';
import {authenticateStep8Campaign,assertStep8ExportMembership,reserveStep8Generation,classifyStep8Exception} from './r1-step8-governance.ts';

const Pin=z.object({path:z.string().refine(isAbsolute,'Operator paths must be absolute'),sha256:HashSchema}).strict();
const sealSchema=z.object({compositionArtifactSha256:HashSchema,privateProvenance:Pin.passthrough(),policyInventory:Pin.passthrough(),criticalInventory:Pin.passthrough()}).passthrough();
export const Step8InputSchema=z.object({
 schemaVersion:z.literal('stadtstack-r1-step8-v1'),
 expectedSources:z.number().int().positive(),expectedDocuments:z.number().int().positive(),
 campaign:Pin,
 seals:z.array(QueueTextSealInputSchema.safeExtend({sealResult:Pin})).min(1),
 structuredRunIds:z.array(z.uuid()).min(1),registry:Pin,privateProvenance:Pin,
 staging:z.array(Pin.extend({destination:z.string().min(1)}).strict()).min(1),
 identityAssessments:Pin.optional(),criticalAssessments:Pin.optional(),regionalPolicyReceipts:Pin.optional(),
 priorRelease:priorReleaseSchema,legacyPreviousReleases:z.record(z.string(),priorReleaseSchema).optional(),
 asOf:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),clocks:ReplayClocksSchema,
 casRoot:z.string().refine(isAbsolute),outputRoot:z.string().refine(isAbsolute),
 policy:z.object({stateDir:z.string().refine(isAbsolute),authorityId:z.string().min(1),authoritySha256:HashSchema}).strict(),
}).strict();
export type Step8Input=z.infer<typeof Step8InputSchema>;
const encoded=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const inside=(parent:string,path:string)=>{const child=relative(parent,path);return !!child&&!child.startsWith('..')&&!isAbsolute(child);};
const uniqueBindings=(bindings:SourceArtifactBinding[])=>[...new Map(bindings.map(binding=>[canonicalJson(binding),binding])).values()];

/** This is deliberately a plan, not a policy admission, cache export or job execution. */
export function step8ReadPlan(input:Step8Input){
 return {schemaVersion:'stadtstack-r1-step8-read-plan-v1',writes:[],network:false,providers:false,
  reads:{campaign:input.campaign,seals:input.seals,structuredRunIds:input.structuredRunIds,registry:input.registry,privateProvenance:input.privateProvenance,
   staging:input.staging,identityAssessments:input.identityAssessments,criticalAssessments:input.criticalAssessments,regionalPolicyReceipts:input.regionalPolicyReceipts,
   casRoot:input.casRoot,policy:input.policy,priorRelease:input.priorRelease,legacyPreviousReleases:input.legacyPreviousReleases,
   database:['district_pipeline.jobs','district_pipeline.step_receipts','district_pipeline.artifacts','district_pipeline.r1_codex_call_intents','district_pipeline.r1_codex_call_authorizations','district_pipeline.preauthorizations'],
   transitive:'Every seal provenance member, queue dependency, original policy/HTTP observation, generation archive, model answer, A/B/C receipt and native parser output referenced by those immutable pins; no provider cache miss fallback.'},
  wouldWrite:{managedRoot:input.outputRoot,generationClaim:input.outputRoot+'.claim',release:join(input.outputRoot,'release'),preparationRoot:input.outputRoot+'-preparation',replayWorkspace:input.outputRoot+'-replay',audit:'same-host canonical audit DB and managed CAS; execute only, never plan'},
  gates:['authenticated exports','current policy','quality','district coverage and action-stage slice','critical A/B/C','identity','all release members','exact manifest bytes and ID','vm_candidate loader'],
  notAuthorized:['model execution','source acquisition','hosted deployment','value acceptance (step 9)']};
}

/** One invocation binds all source exports before preparing, publishing and replaying.
 * The caller supplies the existing independently authenticated staging provenance;
 * this command never manufactures a rights proof from a path or a run label. */
export async function runStep8(raw:unknown,pool:Pool){
 const input=Step8InputSchema.parse(raw),output=resolve(input.outputRoot),cas=new DistrictCas(resolve(input.casRoot)),policy=input.policy;
 if(new Set(input.structuredRunIds).size!==input.structuredRunIds.length)throw Error('Duplicate native run selection');
 if(input.seals.length!==input.expectedSources)throw Error('Incomplete sealed source set');
 if(new Set(input.seals.flatMap(seal=>seal.jobKeys)).size!==input.seals.reduce((n,seal)=>n+seal.jobKeys.length,0))throw Error('Duplicate extraction jobs across source seals');
 if(!inside(await realpath(cacheDir),output)||output.split('/').some(part=>part==='out'||part==='release'))throw Error('Step8 requires a fresh candidate root beneath repository cache, never out/ or release/');
 try{await lstat(output);throw Error('Step8 candidate root already exists; use a fresh generation');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const parent=await realpath(dirname(output));if(parent!==await realpath(cacheDir)&&!inside(await realpath(cacheDir),parent))throw Error('Candidate parent escapes cache');
 await assertCivicPolicyAuthority(policy);
 const claim=await reserveStep8Generation(output);
 const external=await authenticatePublicationProvenance(input.privateProvenance.path,input.privateProvenance.sha256,policy);
 const inventory=privatePublicationProvenanceSchema.parse(JSON.parse((await readReplayPin(input.privateProvenance,process.cwd())).toString('utf8')));
 for(const pin of [input.registry,...input.staging,input.identityAssessments,input.criticalAssessments,input.regionalPolicyReceipts])if(pin&&digest(await external.read(pin.path))!==pin.sha256)throw Error('Operator input differs from its independent pin');
 const pins=new Map<string,PrivatePublicationProvenance['inputs'][number]>();
 const addInventory=(entries:PrivatePublicationProvenance['inputs'],base:string)=>{for(const entry of entries){const pin={...entry,path:resolve(base,entry.path)},old=pins.get(pin.path);if(old&&(old.sha256!==pin.sha256||old.bytes!==pin.bytes))throw Error('Conflicting independent provenance pin');pins.set(pin.path,old?{...pin,bindings:uniqueBindings([...old.bindings,...pin.bindings])}:pin);}};
 addInventory(inventory.inputs,dirname(resolve(input.privateProvenance.path)));
 const campaignBytes=await external.read(input.campaign.path);if(digest(campaignBytes)!==input.campaign.sha256)throw Error('Campaign independent pin mismatch');
 const campaign=await authenticateStep8Campaign(JSON.parse(campaignBytes.toString('utf8')),path=>external.read(path),policy);
 if(campaign.sources.length!==input.expectedSources||campaign.sources.reduce((n,source)=>n+source.documents.length,0)!==input.expectedDocuments)throw Error('Campaign totals mismatch');
 const remainingSources=new Map(campaign.sources.map(source=>[source.corpus.sha256,source])),sourceDispositions:unknown[]=[],auditAssessments:Array<{recordId:string;item:string;A:string;B:string;C:string}>=[];
 const compositions:z.infer<typeof r1TextCompositionInputSchema>[]=[],policyInventories:z.infer<typeof publicationPolicyReceiptInventorySchema>[]=[],criticalInventories:z.infer<typeof CriticalAssessmentInventorySchema>[]=[];
 const exports=[];
 for(const selected of input.seals){
  const seal=sealSchema.parse(JSON.parse((await readReplayPin(selected.sealResult,process.cwd())).toString('utf8')));
  const source=await authenticatePublicationProvenance(seal.privateProvenance.path,seal.privateProvenance.sha256,policy);
  const sourceInventory=privatePublicationProvenanceSchema.parse(JSON.parse((await readReplayPin(seal.privateProvenance,process.cwd())).toString('utf8')));
  addInventory(sourceInventory.inputs,dirname(resolve(seal.privateProvenance.path)));
  const compositionPath=join(cas.root,'sha256',seal.compositionArtifactSha256.slice(0,2),seal.compositionArtifactSha256),bytes=await source.read(compositionPath);
  if(digest(bytes)!==seal.compositionArtifactSha256)throw Error('Sealed composition digest mismatch');
  const serialized=r1TextCompositionInputSchema.parse(JSON.parse(bytes.toString('utf8')));
  if(serialized.contributions.length!==1||serialized.retainedPublication)throw Error('Step8 source export requires one sealed native contribution');
  const composition=await loadR1TextCompositionInput(serialized,async pin=>{
   const path=join(cas.root,'sha256',pin.sha256.slice(0,2),pin.sha256);if(pin.path!==path)throw Error('Source seal escapes managed CAS');return source.read(path);
  });
  const exported=await exportQueueTextContribution(pool,cas,selected.jobKeys,composition.contributions[0]);
  const extraction=JSON.parse(Buffer.from(exported.contribution.artifacts.extractionRun.bytes).toString('utf8'));
  const expectedSource=remainingSources.get(exported.contribution.pins.corpusSha256);if(!expectedSource)throw Error('Duplicate or unexpected sealed source');
  assertStep8ExportMembership(expectedSource,exported.results,exported.terminalDocumentExceptions,extraction.queue.stepReceipts);remainingSources.delete(expectedSource.corpus.sha256);
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
  for(const entry of assessmentPins)if(entry.pins){const pathFor=(sha256:string)=>join(cas.root,'sha256',sha256.slice(0,2),sha256);auditAssessments.push({recordId:entry.recordId,item:pathFor(entry.pins.itemArtifactSha256),A:pathFor(entry.pins.AArtifactSha256),B:pathFor(entry.pins.BArtifactSha256),C:pathFor(entry.pins.CArtifactSha256)});}
  if(canonicalJson([...selected.reconciliationJobKeys].sort())!==canonicalJson(extraction.queue.reconciliationJobKeys))throw Error('Source reconciliation selection differs from seal');
  compositions.push(serialized);
  policyInventories.push(publicationPolicyReceiptInventorySchema.parse(JSON.parse((await source.read(seal.policyInventory.path)).toString('utf8'))));
  criticalInventories.push(CriticalAssessmentInventorySchema.parse(JSON.parse((await source.read(seal.criticalInventory.path)).toString('utf8'))));
  exports.push({compositionArtifactSha256:seal.compositionArtifactSha256,runId:exported.contribution.runId,committedDocuments:exported.results.length+exported.terminalDocumentExceptions.length,jobKeys:selected.jobKeys,reconciliationJobKeys:selected.reconciliationJobKeys,terminalDocumentExceptions:exported.terminalDocumentExceptions,terminalAssessmentExceptions:exported.terminalAssessmentExceptions,...(exported.assessmentItemHolds.length?{assessmentItemHolds:exported.assessmentItemHolds}:{})});
 }
 if(exports.reduce((n,item)=>n+item.committedDocuments,0)!==input.expectedDocuments)throw Error('Incomplete committed document set');
 if(remainingSources.size||sourceDispositions.length!==input.expectedDocuments)throw Error('Campaign disposition inventory incomplete');
 // A multi-source derivative is never independently allowed as an original.
 let bindings=uniqueBindings([...pins.values()].flatMap(pin=>pin.bindings.map(binding=>({...binding,independentAllowed:false}))));
 const write=async(name:string,value:unknown,bytes?:Buffer)=>{
  await claim.assertOwned();
  const body=bytes??encoded(value),path=join(output,name),sha256=await writeManagedSourceArtifact(output,path,body,bindings,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
  await claim.assertOwned();
  const pin={path,sha256,bytes:body.length,bindings};pins.set(path,pin);return {path,sha256};
 };
 const registryBytes=await external.read(input.registry.path);if(digest(registryBytes)!==input.registry.sha256)throw Error('Registry independent pin mismatch');
 const native=await exportRun(new DistrictJobStore(pool),cas,districtRegistrySchema.parse(JSON.parse(registryBytes.toString('utf8'))),{runIds:input.structuredRunIds},{generatedAt:input.clocks.recordsGeneratedAt,policy});
 if(!native)throw Error('Native export did not return an authenticated run');
 if(input.structuredRunIds.some(runId=>!native.receipts.some(row=>row.receipt.runId===runId)))throw Error('A selected native run has no committed structured receipt');
 bindings=uniqueBindings([...bindings,...native.bindings.map(binding=>({...binding,independentAllowed:false}))]);
 // Export committed native receipts to the same managed CAS contract used by the CLI.
 for(const row of native.receipts){await claim.assertOwned();const bytes=Buffer.from(canonicalJson(row.receipt));if(digest(bytes)!==row.sha256)throw Error('Native receipt digest mismatch');await writeManagedSourceArtifact(cas.root,join(cas.root,'sha256',row.sha256.slice(0,2),row.sha256),bytes,bindings,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});await claim.assertOwned();}
 const sourceDispositionInventory=await write('source-dispositions.json',{schemaVersion:'stadtstack-r1-step8-source-dispositions-v1',status:'authenticated_not_released',generationNonce:claim.nonce,campaign:input.campaign,complete:true,sourceDispositions});
 const registry=await write('inputs/registry.json',null,native.registryBytes),structuredRun=await write('inputs/structured-run.json',native.run);
 const composition=r1TextCompositionInputSchema.parse({schemaVersion:'district-r1-text-composition-input-v1',generatedAt:input.clocks.recordsGeneratedAt,approvedRunOrder:compositions.flatMap(item=>item.approvedRunOrder),admissions:compositions.flatMap(item=>item.admissions),contributions:compositions.flatMap(item=>item.contributions)});
 const context=buildR1TextCompositionContext(await loadR1TextCompositionInput(composition,pin=>readReplayPin(pin,process.cwd())));
 const textComposition=await write('inputs/text-composition.json',composition),candidateRecords=await write('inputs/records.json',context.knowledge),candidateQuarantine=await write('inputs/quarantine.json',{...context.coverage.quarantine,generatedAt:input.clocks.quarantineGeneratedAt}),identityState=await write('inputs/identity.json',{identityAssertions:context.knowledge.identityAssertions,identityAdmissions:context.knowledge.identityAdmissions});
 const currentAdmissionReceipts:Record<string,string>={};for(const item of policyInventories)for(const [original,current] of Object.entries(item.currentAdmissionReceipts??{})){if(currentAdmissionReceipts[original]&&currentAdmissionReceipts[original]!==current)throw Error('Conflicting source policy continuation');currentAdmissionReceipts[original]=current;}
 const nativePolicy=native.run.records.map(record=>({recordId:record.id,receipts:[record.source,...record.supportingSources].map(source=>({sourceUrl:source.url,sourceSha256:source.sha256,receiptSha256:source.policyReceiptSha256}))}));
 const policyReceipts=await write('inputs/policy.json',publicationPolicyReceiptInventorySchema.parse({records:[...policyInventories.flatMap(item=>item.records),...nativePolicy],currentAdmissionReceipts}));
 if(input.criticalAssessments){const bytes=await external.read(input.criticalAssessments.path);if(digest(bytes)!==input.criticalAssessments.sha256)throw Error('Critical inventory pin mismatch');criticalInventories.push(CriticalAssessmentInventorySchema.parse(JSON.parse(bytes.toString('utf8'))));}
 const criticalAssessments=await write('inputs/critical.json',CriticalAssessmentInventorySchema.parse({records:criticalInventories.flatMap(item=>item.records)}));
 const saveProvenance=()=>write('inputs/provenance.json',privatePublicationProvenanceSchema.parse({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:[...pins.values()].filter(pin=>pin.path!==join(output,'inputs/provenance.json')&&!inside(join(output,'release'),pin.path))}));
 let privateProvenance=await saveProvenance();
 const cataloguePin=input.staging.find(pin=>pin.destination==='catalogue.json');if(!cataloguePin)throw Error('Staged catalogue required');
 const catalogue=JSON.parse((await external.read(cataloguePin.path)).toString('utf8')),cities=z.array(z.string()).parse(catalogue.cities.map((city:{id:string})=>city.id));
 if(canonicalJson(input.staging.map(pin=>pin.destination).sort())!==canonicalJson(requiredReplayStaging(cities)))throw Error('Complete unique non-knowledge staging inventory required');
 const priorPaths=[...cities.flatMap(city=>[`cities/${city}/signals.geojson`,`cities/${city}/changes.json`]),'knowledge/records.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json'];
 const baseline=await loadPriorPublicationRelease(input.priorRelease,priorPaths,input.clocks.manifestGeneratedAt);
 const predecessors=await preloadPriorPublicationReleases([{prior:input.priorRelease,paths:priorPaths,targetGeneratedAt:input.clocks.manifestGeneratedAt},...Object.entries(input.legacyPreviousReleases??{}).map(([cityId,prior])=>({prior,paths:[`cities/${cityId}/signals.geojson`],targetGeneratedAt:baseline.manifest.generatedAt,targetReleaseId:baseline.manifest.id}))]);
 const preparation={registry:registry.path,records:candidateRecords.path,quarantine:candidateQuarantine.path,textComposition:textComposition.path,structuredRun:structuredRun.path,policyReceipts:policyReceipts.path,criticalAssessments:criticalAssessments.path,identityAssessments:input.identityAssessments?.path,privateProvenance,outputRoot:output+'-preparation',casRoot:cas.root,policyStateDir:policy.stateDir,policyAuthorityId:policy.authorityId,policyAuthoritySha256:policy.authoritySha256,coverageGeneratedAt:input.clocks.coverageGeneratedAt};
 const candidateDirectory=join(output,'release');
 const manifest=await withPreparedKnowledge(preparation,async prepared=>{
  const scratchOutput=join(prepared.scope.directory,'candidate');
  const manifest=await publish({stagingDir:prepared.stagingDir,outDir:scratchOutput,asOf:input.asOf,priorRelease:input.priorRelease,legacyPreviousReleases:input.legacyPreviousReleases,priorCityRoot:prepared.publication.priorDirectory,policyReceipts:policyReceipts.path,textComposition:textComposition.path,structuredRun:structuredRun.path,criticalAssessments:criticalAssessments.path,identityAssessments:input.identityAssessments?.path,regionalPolicyReceipts:input.regionalPolicyReceipts?.path,privateProvenance,casRoot:cas.root,policyStateDir:policy.stateDir,policyAuthorityId:policy.authorityId,policyAuthoritySha256:policy.authoritySha256,qualityGeneratedAt:input.clocks.qualityGeneratedAt,manifestGeneratedAt:input.clocks.manifestGeneratedAt},predecessors,prepared.publication);
  await verifyDataRelease(scratchOutput);
  await write('exception-inventory.json',{schemaVersion:'stadtstack-r1-step8-exceptions-v1',releaseId:manifest.id,campaign:input.campaign,sourceDispositionInventory,complete:true,sourceDispositions,native:{coverage:native.run.coverage,fieldHolds:native.fieldHolds},preparation:{publicationQuarantine:prepared.publicationQuarantine,criticalHolds:prepared.summary.criticalHolds,classification:classifyStep8Exception(prepared.publicationQuarantine)},assessments:auditAssessments});
  const auditManifest=[];
  for(const [index,entry] of auditAssessments.entries()){const row:Record<string,string>={};for(const role of ['item','A','B','C'] as const){const bytes=await readFile(entry[role]),path=join(output,`audit/${index}-${role}.json`);if(digest(bytes)!==entry[role].split('/').at(-1))throw Error('Assessment handoff artifact hash mismatch');await write(`audit/${index}-${role}.json`,null,bytes);row[role]=path;}auditManifest.push(row);}
  await write('audit/assessments.json',auditManifest);
  for(const member of [...manifest.files.map(file=>file.path),'release-manifest.json','README.md'])await write('release/'+member,null,await readFile(join(scratchOutput,member)));
  await write('inputs/publication-inputs.json',null,await readFile(join(scratchOutput,'knowledge/publication-inputs.json')));
  return manifest;
 },{staging:input.staging.map(pin=>({destination:pin.destination,pin})),prior:{release:input.priorRelease,paths:priorPaths,targetGeneratedAt:input.clocks.manifestGeneratedAt,targetReleaseId:'',cache:predecessors}});
 privateProvenance=await saveProvenance();
 const pinFor=(name:string)=>{const pin=pins.get(join(output,name));if(!pin)throw Error('Missing persisted step8 artifact');return {path:pin.path,sha256:pin.sha256};};
 const locale=Intl.DateTimeFormat().resolvedOptions(),sourceFiles=(await readdir(join(root,'src'),{withFileTypes:true})).filter(file=>file.isFile()&&file.name.endsWith('.ts')).map(file=>'src/'+file.name).concat(['regional/taxonomy.mjs','package.json','scripts/r1-step8.ts','scripts/r1-step8.sh','scripts/r1-step8-offline.cjs']).sort();
 const receipt=ReplayReceiptSchema.parse({schemaVersion:'stadtstack-offline-replay-v2',mode:'retained_text_composition',registry,candidateRecords,candidateQuarantine,identityState,publicationInputs:pinFor('inputs/publication-inputs.json'),policyReceipts,criticalAssessments,identityAssessments:input.identityAssessments,regionalPolicyReceipts:input.regionalPolicyReceipts,privateProvenance,textComposition,structuredRun,clocks:input.clocks,staging:input.staging,priorRelease:input.priorRelease,legacyPreviousReleases:input.legacyPreviousReleases,expectedRelease:pinFor('release/release-manifest.json'),casRoot:cas.root,policyStateDir:policy.stateDir,policyAuthorityId:policy.authorityId,policyAuthoritySha256:policy.authoritySha256,workspace:output+'-replay',runtime:{node:process.versions.node,icu:process.versions.icu,unicode:process.versions.unicode,locale:locale.locale,timeZone:locale.timeZone,packageLockSha256:digest(await readFile(join(root,'package-lock.json'))),sourceFiles:await Promise.all(sourceFiles.map(async path=>({path,sha256:digest(await readFile(join(root,path)))})))}});
 const replayReceipt=await write('replay-receipt.json',receipt),proof=await replayPipeline(replayReceipt.path,replayReceipt.sha256);
 if(proof.comparison.releaseId!==manifest.id)throw Error('Exact replay bound another candidate');
 await write('replay-proof.json',proof);
 const admitted=await loadRelease(candidateDirectory,{mode:'vm_candidate',policyOptions:policy});
 const exceptions=pinFor('exception-inventory.json'),auditManifest=pinFor('audit/assessments.json');
 const handoff=await write('step9-handoff.json',{schemaVersion:'stadtstack-r1-step9-handoff-v1',releaseId:manifest.id,candidateDirectory,exceptionInventory:exceptions,assessmentManifest:auditManifest,policy});
 const gate={schemaVersion:'stadtstack-r1-step8-gate-v1',status:'passed',releaseId:manifest.id,manifestSha256:pinFor('release/release-manifest.json').sha256,candidateDirectory,campaign:input.campaign,generationNonce:claim.nonce,exceptionInventory:exceptions,step9Handoff:handoff,exports,structuredRunIds:input.structuredRunIds,asOf:input.asOf,replayReceipt,replayAuditSha256:proof.persistence.auditSha256,checks:['exact campaign membership','complete exception inventory','atomic generation ownership','native contributor custody','authenticated source exports','quality','coverage','critical assessments','identity admissions','current policy','every manifest member','exact manifest bytes and ID','vm_candidate loader'],knowledgeRecords:admitted.knowledge.records.length,valueAccepted:false,hostedReleaseAuthorized:false};
 await write('release-gate.json',gate);return gate;
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
 return {schemaVersion:'stadtstack-r1-step8-production-plan-v1',readOnly:true,writes:[],network:false,providers:false,repository:repositoryPath,driverRoot:driverPath,structuredRuns:runs.rows,sealedSources:sealResults.sort((a,b)=>a.path.localeCompare(b.path)),authenticPriorRelease:{gitCommit:'57bddbbd8b84b0634229ad9cd45b689bda7271ea',directory:'release',manifestSha256:digest(bytes),releaseId:manifest.id},wouldRead:[join(driverPath,'catalogue.json'),join(repositoryPath,'cache/districts/cas'),join(repositoryPath,'cache/districts/r1-operator'),join(repositoryPath,'release'),'/home/max/stadtstack-ops/STATUS_0.3.2.md','explicit staged catalogue/city feeds/signals/regional topics','independently pinned source provenance and current policy/identity/critical controls','Git predecessor members and authentic legacy predecessor change state','same-host canonical jobs, step receipts, call accounting and authorizations'],missing:sealResults.length===27?[]:['Complete 27-source seal set is not available in the inspected driver tree; no publication or replay was attempted.'],requires:'Complete pinned Step8InputSchema manifest, including one graph asOf, clocks and full non-knowledge staging/provenance. This discovery is not execution approval or a passing release gate.'};
}
