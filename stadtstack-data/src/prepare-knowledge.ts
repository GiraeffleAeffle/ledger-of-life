import {realpath,mkdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {districtRegistrySchema} from './district-registry.ts';
import {authorizedPilotCorpusSchema} from './district-corpus.ts';
import {KnowledgeRecordsSchema,validateKnowledgeRelease} from './district-schema.ts';
import {buildDistrictCoverage,knowledgePublicationHold,knowledgePublicationQuarantineCase,projectDistrictCoverage,assertKnowledgeSlice,type DistrictCoverage} from './district-publication.ts';
import {structuredRunSchema,validateStructuredRun,verifyStructuredRunReceipts} from './district-structured-run.ts';
import {graphIdentityInputs} from './district-graph.ts';
import {admitPublicationIdentities} from './district-publication-identity.ts';
import {recheckPublicationPolicy,publicationPolicyReceiptInventorySchema} from './district-publication-policy.ts';
import {knowledgePreparationInputsSchema,publicationStagingPathSchema,type PublicationDependency} from './district-publication-inputs.ts';
import {canonicalJson} from './district-adapter-contract.ts';
import {DistrictCas} from './district-cas.ts';
import {assertPublicUrls} from './publication-quality.ts';
import {cacheDir,root,hash} from './common.ts';
import {loadR1TextCompositionInput,buildR1TextCompositionContext,rebuildR1TextCoverageContext,type R1TextCompositionContext} from './district-r1-text-composition.ts';
import {admitCriticalKnowledge} from './district-critical-assessment.ts';
import {CriticalAdmissionsSchema,CRITICAL_ADMISSIONS_VERSION} from './district-critical-assessment-contract.ts';
import {assertCriticalAdmissionsBound} from './district-critical-assessment-public.ts';
import {authenticatePublicationProvenance,type AuthenticatedPublicationProvenance} from './district-publication-provenance.ts';
import {writeManagedSourceArtifact} from './district-private-io.ts';
import {readCivicOptOutSnapshot,withManagedSourceScratch,CIVIC_ACQUISITION_DECISION_ID,type CivicPolicyOptions,type ManagedSourceScratch} from './civic-opt-out.ts';
import {loadPriorPublicationRelease,type PriorRelease,type PriorReleaseCache} from './district-publication-predecessor.ts';
const preparedBindingSchema=z.object({kind:z.literal('prepared_source'),url:z.url(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),observationId:z.string().min(1),receiptSha256:z.string().regex(/^[a-f0-9]{64}$/),independentAllowed:z.boolean()}).strict();
export const knowledgePreparedSourcePinSchema=z.object({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative().max(512*1024*1024),bindings:z.array(preparedBindingSchema).min(1)}).strict();
export type KnowledgePreparedSourcePin=z.infer<typeof knowledgePreparedSourcePinSchema>;

export type PrepareKnowledgeOptions={registry:string;textComposition?:string;records:string;quarantine:string;structuredRun?:string;policyReceipts?:string;identityAssessments?:string;criticalAssessments?:string;privateProvenance?:{path:string;sha256:string};outputRoot?:string;casRoot?:string;policyStateDir?:string;policyAuthorityId?:string;policyAuthoritySha256?:string;minimum?:number;stagingDir?:string;publicationQuarantinePath?:string;coverageGeneratedAt?:string};
export interface PreparedKnowledgeSummary {schemaVersion:string;records:number;textModelRecords:number;structuredRecords:number;criticalHolds:readonly {recordId:string;reason:string}[];municipalities:number;accounting:DistrictCoverage['accounting'];districts:DistrictCoverage['districts'];municipalityCoverage:Array<Pick<DistrictCoverage['municipalities'][number],'id'|'status'|'checked'|'publishedRecords'|'textModelRecords'|'structuredRecords'|'datedStagedRecords'|'quarantinedRecords'|'quarantineReasons'|'extraction'>>;dependencies:PublicationDependency[]}
export interface AuthenticatedPreparedPublication {
 readonly provenance:AuthenticatedPublicationProvenance;
 readonly stagingDir:string;
 readonly priorDirectory:string|undefined;
 read(path:string):Promise<Buffer>;
}
const preparedPublications=new WeakSet<object>();
export function assertAuthenticatedPreparedPublication(value:AuthenticatedPreparedPublication):void{
 if(!preparedPublications.has(value))throw Error('Publication requires an authenticated preparation lease capability');
}
export type PreparedPublicationInputs={
 staging:readonly {destination:string;pin:{path:string;sha256:string}}[];
 prior?:{release:PriorRelease;paths:readonly string[];targetGeneratedAt:string;targetReleaseId:string;cache:PriorReleaseCache};
};
/** Original generation clocks and snapshots remain immutable; current admissibility is checked separately. */
function preparationPolicy(options:PrepareKnowledgeOptions):CivicPolicyOptions{return {...(options.policyStateDir?{stateDir:options.policyStateDir}:{}),...(options.policyAuthorityId?{authorityId:options.policyAuthorityId}:{}),...(options.policyAuthoritySha256?{authoritySha256:options.policyAuthoritySha256}:{})};}
async function preparationInputs(options:PrepareKnowledgeOptions){
 const minimum=options.minimum??1;if(!Number.isInteger(minimum)||minimum<1)throw Error('Release acceptance requires at least one evidenced municipality in each district; individual record gates remain mandatory');
 if(!options.privateProvenance)throw Error('Knowledge preparation requires its exact independently pinned private provenance inventory');
 return authenticatePublicationProvenance(options.privateProvenance.path,options.privateProvenance.sha256,preparationPolicy(options));
}
async function assembleKnowledge(options:PrepareKnowledgeOptions,provenance:AuthenticatedPublicationProvenance){
 const minimum=options.minimum??1,policyOptions=preparationPolicy(options);
 const registryBytes=await provenance.read(options.registry),registry=districtRegistrySchema.parse(JSON.parse(registryBytes.toString('utf8')));
 const recordBytes=await provenance.read(options.records),quarantineBytes=await provenance.read(options.quarantine);
 const knowledge=KnowledgeRecordsSchema.parse(JSON.parse(recordBytes.toString('utf8'))),quarantine=JSON.parse(quarantineBytes.toString('utf8'));
 if(!Array.isArray(quarantine.cases))throw Error('Missing actual extraction quarantine evidence');
 const dependencies:PublicationDependency[]=[{role:'registry',sha256:hash(registryBytes)},{role:'candidate_records',sha256:hash(recordBytes)},{role:'candidate_quarantine',sha256:hash(quarantineBytes)}];
 let composition:R1TextCompositionContext|undefined,retainedPublication:R1TextCompositionContext['retainedPublication']=null;
 if(options.textComposition){
  const path=await realpath(resolve(options.textComposition)),base=dirname(path),inputBytes=await provenance.read(path),raw=JSON.parse(inputBytes.toString('utf8'));
  const loadArtifact=async(pin:{path:string;sha256:string})=>{
   const actual=await realpath(resolve(base,pin.path)),child=relative(base,actual);
   const fixedCasPath=join(resolve(options.casRoot??join(cacheDir,'districts','cas')),'sha256',pin.sha256.slice(0,2),pin.sha256);
   if(actual.split(/[\\/]/).includes('out')||actual!==fixedCasPath&&(!child||child.startsWith('..')||isAbsolute(child)))throw Error('Text composition artifact escapes its managed private input root');
   // Queue-native members occupy different CAS shards. The fixed hash path is
   // not a custody bypass: this capability still requires an exact inventory pin.
   const bytes=await provenance.read(actual);if(hash(bytes)!==pin.sha256)throw Error('Text composition independent artifact pin mismatch');return bytes;
  };
  const input=await loadR1TextCompositionInput(raw,loadArtifact);
  for(const contribution of input.contributions)authorizedPilotCorpusSchema.parse(contribution.pins.corpusSha256);
  composition=buildR1TextCompositionContext(input);
  retainedPublication=composition.retainedPublication;
  const supplied=knowledge.records.filter(record=>record.kind==='text_model');
  if(canonicalJson(supplied)!==canonicalJson(composition.knowledge.records))throw Error('Candidate text rows differ from authenticated ordered composition');
  dependencies.push(...composition.dependencies.filter(dependency=>dependency.role!=='text_composition'));
  if(!dependencies.some(dependency=>dependency.role==='text_composition'))dependencies.push({role:'text_composition',sha256:hash(inputBytes)});
 }
 const structuredBytes=options.structuredRun?await provenance.read(options.structuredRun):undefined,structured=structuredBytes?structuredRunSchema.parse(JSON.parse(structuredBytes.toString('utf8'))):undefined;
 if(structured){
  validateStructuredRun(structured,registry,structured.records,hash(registryBytes));
  const ids=new Map(knowledge.records.map(record=>[record.id,record]));
  for(const record of structured.records){const existing=ids.get(record.id);if(existing&&canonicalJson(existing)!==canonicalJson(record))throw Error('Conflicting structured record in candidate and actual run');if(!existing){knowledge.records.push(record);ids.set(record.id,record);}}
  dependencies.push({role:'structured_run',sha256:hash(structuredBytes!)},{role:'question_disposition',sha256:structured.questionDispositionSha256},{role:'adapter_contract',sha256:structured.adapterContractSha256});
 }else if(knowledge.records.some(record=>record.kind==='structured'))throw Error('Structured records require their actual structured run');
 const text=knowledge.records.filter(record=>record.kind==='text_model');
 let crawlInput:unknown={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:knowledge.generatedAt,documents:[],checks:[]};
 if(!composition&&(text.length||quarantine.cases.some((entry:{kind?:string})=>entry.kind!=='structured')))throw Error('Text outputs require explicit authenticated ordered text composition');
 if(composition){crawlInput=composition.coverage.crawl;if(canonicalJson(quarantine.cases)!==canonicalJson(composition.coverage.quarantine.cases))throw Error('Candidate quarantine differs from authenticated text contributions');}
 validateKnowledgeRelease(knowledge,registry);
 const originalMentionIds=new Set(graphIdentityInputs({...knowledge,identityAssertions:[],identityAdmissions:[]}).mentions.map(mention=>mention.id));
 if(!options.policyReceipts)throw Error('Knowledge publication requires actual private current-policy receipts');
 const policyInventory=publicationPolicyReceiptInventorySchema.parse(JSON.parse((await provenance.read(options.policyReceipts)).toString('utf8'))),cas=new DistrictCas(options.casRoot??join(cacheDir,'districts','cas'));
 const preparationEpoch=await readCivicOptOutSnapshot(policyOptions);
 const retainedLineage=retainedPublication?{...retainedPublication.baseline.lineage,selectedRecordOrigins:retainedPublication.selectedRecordOrigins}:null;
 const policy=await recheckPublicationPolicy(knowledge.records,policyInventory,cas,{...policyOptions,evaluationAt:new Date().toISOString(),retainedPublication:retainedLineage});
 dependencies.push({role:'policy_receipts',sha256:policy.inventorySha256});
 if(structured){const checked=await verifyStructuredRunReceipts(structured,cas,{...policyOptions,evaluationAt:new Date().toISOString(),currentAdmissionReceipts:policy.currentAdmissionReceipts});dependencies.push({role:'structured_receipts',sha256:checked.dependencySha256});}
 const criticalInventory=options.criticalAssessments?JSON.parse((await provenance.read(options.criticalAssessments)).toString('utf8')):{records:[]};
 const critical=await admitCriticalKnowledge(knowledge.records,criticalInventory,cas,{policyOptions,currentAdmissionReceipts:policy.currentAdmissionReceipts,retainedPublication});
 dependencies.push({role:'critical_assessments',sha256:critical.dependencySha256});
 const criticalIds=new Set(critical.holds.map(hold=>hold.recordId));
 if(critical.holds.some(hold=>retainedPublication?.baseline.input.recordIds.includes(hold.recordId)))throw Error('Held native revision cannot remove an admitted retained fact; resubmit composition with that native admission withheld');
 for(const record of knowledge.records)if(record.kind==='text_model'&&criticalIds.has(record.id))quarantine.cases.push({kind:'text_model',recordId:record.id,municipalityId:record.municipalityId,sourceId:record.sources[0].id,sourceSha256:record.extraction.inputSha256,reason:critical.holds.find(hold=>hold.recordId===record.id)!.reason});
 knowledge.records=knowledge.records.filter(record=>!criticalIds.has(record.id));
 const holds=knowledge.records.flatMap(record=>{const hold=knowledgePublicationHold(record);return hold?[{record,hold}]:[];}),withheldIds=new Set(holds.map(({record})=>record.id));
 for(const {record,hold} of holds)quarantine.cases.push(knowledgePublicationQuarantineCase(record,hold));
 knowledge.records=knowledge.records.filter(record=>!withheldIds.has(record.id));
 if(holds.some(({record})=>retainedPublication?.baseline.input.recordIds.includes(record.id)))throw Error('Withheld native revision cannot remove an admitted retained fact; resubmit composition with that native admission withheld');
 const present=new Set(graphIdentityInputs({...knowledge,identityAssertions:[],identityAdmissions:[]}).mentions.map(mention=>mention.id));
 const applicable=(assertion:{leftMentionId:string;rightMentionId:string})=>present.has(assertion.leftMentionId)&&present.has(assertion.rightMentionId);
 const originalAssertions=composition?.knowledge.identityAssertions??[],historical=new Set(originalAssertions.map(assertion=>canonicalJson(assertion)));
 for(const assertion of originalAssertions.filter(applicable))if(!knowledge.identityAssertions.some(candidate=>canonicalJson(candidate)===canonicalJson(assertion)))throw Error('Applicable original identity assertion was removed or rewritten');
 knowledge.identityAssertions=knowledge.identityAssertions.filter(assertion=>applicable(assertion)||!historical.has(canonicalJson(assertion))&&!(originalMentionIds.has(assertion.leftMentionId)&&originalMentionIds.has(assertion.rightMentionId)));
 const assertionHashes=new Set(knowledge.identityAssertions.map(assertion=>hash(canonicalJson(assertion))));
 for(const admission of composition?.knowledge.identityAdmissions??[])if(assertionHashes.has(admission.assertionSha256)&&!knowledge.identityAdmissions.some(candidate=>canonicalJson(candidate)===canonicalJson(admission)))throw Error('Applicable original identity admission seal was removed or rewritten');
 knowledge.identityAdmissions=knowledge.identityAdmissions.filter(admission=>assertionHashes.has(admission.assertionSha256));
 const identity=graphIdentityInputs(knowledge);
 const assessmentInventory=options.identityAssessments?JSON.parse((await provenance.read(options.identityAssessments)).toString('utf8')):{assertions:[]};
 const reviewed=await admitPublicationIdentities({assertions:identity.assertions,mentions:identity.mentions,additionalSourceHashes:identity.additionalSourceHashes,inventoryInput:assessmentInventory,cas,policyOptions,currentAdmissionReceipts:policy.currentAdmissionReceipts,...(knowledge.identityAdmissions.length?{originalAdmissions:knowledge.identityAdmissions}:{})});
 knowledge.identityAdmissions=reviewed.admissions;dependencies.push({role:'identity_assessments',sha256:reviewed.dependencySha256});
 assertKnowledgeSlice(registry,knowledge.records,minimum);
 if(!knowledge.records.length)throw Error('No passing knowledge records');
 const finalText=knowledge.records.filter(record=>record.kind==='text_model'),textCoverage=composition?rebuildR1TextCoverageContext(composition,finalText,options.coverageGeneratedAt??knowledge.generatedAt):null;
 if(!composition&&finalText.length)throw Error('Text publication requires explicit authenticated text composition');
 const coverage=buildDistrictCoverage(registry,textCoverage?.crawl??crawlInput,knowledge.records,quarantine,textCoverage?.textLineage??null,options.coverageGeneratedAt??knowledge.generatedAt,structured,textCoverage?.retainedPublication??null);
 assertPublicUrls({registry,records:knowledge,coverage});
 const finalEpoch=await readCivicOptOutSnapshot({...policyOptions,authorityId:preparationEpoch.authorityId,authoritySha256:preparationEpoch.authoritySha256});
 if(policy.optOutSnapshotSha256!==preparationEpoch.sha256||finalEpoch.sha256!==preparationEpoch.sha256)throw Error('Current policy changed during knowledge preparation');
 const criticalProjection=CriticalAdmissionsSchema.parse({schemaVersion:CRITICAL_ADMISSIONS_VERSION,admissions:critical.admissions.filter(admission=>knowledge.records.some(record=>record.id===admission.recordId))});
 assertCriticalAdmissionsBound(knowledge.records,criticalProjection.admissions,coverage.retainedPublication);
 const staged=[['registry',registry],['records',knowledge],['coverage',coverage],['assessment-admissions',criticalProjection]] as const;
 const outputs=staged.map(([name,data])=>({path:`knowledge/${name}.json` as 'knowledge/registry.json'|'knowledge/records.json'|'knowledge/coverage.json'|'knowledge/assessment-admissions.json',bytes:Buffer.from(JSON.stringify(data,null,2)+'\n')}));
 const handoff=knowledgePreparationInputsSchema.parse({schemaVersion:'stadtstack-knowledge-preparation-inputs-v1',dependencies,outputs:outputs.map(({path,bytes})=>({path,sha256:hash(bytes),bytes:bytes.length}))});
 const publicationQuarantine={schemaVersion:'stadtstack-publication-quarantine-v1',records:[...critical.holds,...holds.map(({record,hold})=>({id:record.id,municipalityId:record.municipalityId,...hold}))]};
 const summary:PreparedKnowledgeSummary={schemaVersion:knowledge.schemaVersion,records:knowledge.records.length,textModelRecords:knowledge.records.filter(record=>record.kind==='text_model').length,structuredRecords:knowledge.records.filter(record=>record.kind==='structured').length,criticalHolds:critical.holds,municipalities:coverage.accounting.publishedMunicipalities,accounting:coverage.accounting,districts:coverage.districts,municipalityCoverage:projectDistrictCoverage(coverage).municipalities,dependencies};
 return {outputs,handoff,publicationQuarantine,summary};
}
export async function prepareKnowledge(options:PrepareKnowledgeOptions){
 const provenance=await preparationInputs(options),prepared=await assembleKnowledge(options,provenance),outputRoot=resolve(options.outputRoot??join(cacheDir,'districts','r1-knowledge-preparation')),stagingDir=resolve(options.stagingDir??join(outputRoot,'staging','knowledge')),policy=preparationPolicy(options),managed={...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts' as const};
 const handoffPath=join(stagingDir,'preparation-inputs.json'),handoffBytes=Buffer.from(JSON.stringify(prepared.handoff,null,2)+'\n'),outputPins=[];
 for(const output of prepared.outputs){const path=join(stagingDir,output.path.slice('knowledge/'.length));const sha256=await writeManagedSourceArtifact(outputRoot,path,output.bytes,provenance.bindings,managed);outputPins.push({path,sha256,bytes:output.bytes.length,bindings:provenance.bindings});}
 const handoffSha256=await writeManagedSourceArtifact(outputRoot,handoffPath,handoffBytes,provenance.bindings,managed);outputPins.push({path:handoffPath,sha256:handoffSha256,bytes:handoffBytes.length,bindings:provenance.bindings});
 await writeManagedSourceArtifact(outputRoot,resolve(options.publicationQuarantinePath??join(outputRoot,'publication-quarantine.json')),JSON.stringify(prepared.publicationQuarantine,null,2)+'\n',provenance.bindings,managed);
 return {...prepared.summary,outputPins};
}
/** The consumer runs inside a real nested canonical lease; no caller scope/boolean is accepted. */
export async function withPreparedKnowledge<T>(options:PrepareKnowledgeOptions,consume:(prepared:{summary:PreparedKnowledgeSummary;publicationQuarantine:{schemaVersion:string;records:unknown[]};stagingDir:string;scope:ManagedSourceScratch;outputPins:Array<{path:string;sha256:string;bytes:number}>;publication:AuthenticatedPreparedPublication})=>Promise<T>,publicationInputs?:PreparedPublicationInputs):Promise<T>{
 const provenance=await preparationInputs(options),policy=preparationPolicy(options),outputRoot=resolve(options.outputRoot??join(cacheDir,'districts','r1-knowledge-preparation'));
 return withManagedSourceScratch(outputRoot,provenance.bindings.map(({independentAllowed:_flag,...binding})=>binding),async scope=>{
  const assertActive=scope.assertActive.bind(scope),leaseDirectory=scope.directory;
  const prepared=await assembleKnowledge(options,provenance),stagingDir=join(leaseDirectory,'staging'),outputPins=prepared.outputs.map(output=>({path:join(stagingDir,output.path),sha256:hash(output.bytes),bytes:output.bytes.length}));
  const handoffPath=join(stagingDir,'knowledge/preparation-inputs.json'),handoffBytes=Buffer.from(JSON.stringify(prepared.handoff,null,2)+'\n');
  outputPins.push({path:handoffPath,sha256:hash(handoffBytes),bytes:handoffBytes.length});
  const pins=new Map(outputPins.map(pin=>[pin.path,{sha256:pin.sha256,bytes:pin.bytes}]));
  const write=async(path:string,bytes:string|Uint8Array)=>{await assertActive();await mkdir(dirname(path),{recursive:true,mode:0o700});const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await assertActive();};
  for(const output of prepared.outputs)await write(join(stagingDir,output.path),output.bytes);
  await write(handoffPath,handoffBytes);
  await write(join(leaseDirectory,'publication-quarantine.json'),JSON.stringify(prepared.publicationQuarantine,null,2)+'\n');
  for(const entry of publicationInputs?.staging??[]){
   publicationStagingPathSchema.parse(entry.destination);
   if(entry.destination.startsWith('knowledge/'))throw Error('External staging cannot replace authenticated knowledge preparation');
   const path=join(stagingDir,entry.destination);if(pins.has(path))throw Error('Duplicate prepared publication staging member');
   const bytes=await provenance.read(entry.pin.path);if(hash(bytes)!==entry.pin.sha256)throw Error('Prepared publication staging independent pin mismatch');
   pins.set(path,{sha256:entry.pin.sha256,bytes:bytes.length});await write(path,bytes);
  }
  let priorDirectory:string|undefined;
  if(publicationInputs?.prior){
   const prior=publicationInputs.prior,baseline=await loadPriorPublicationRelease(prior.release,prior.paths,prior.targetGeneratedAt,prior.targetReleaseId,prior.cache);
   priorDirectory=join(leaseDirectory,'prior');
   for(const [member,bytes] of baseline.files){const path=join(priorDirectory,member);pins.set(path,{sha256:hash(bytes),bytes:bytes.length});await write(path,bytes);}
  }
  let active=true;
  const publication:AuthenticatedPreparedPublication=Object.freeze({provenance,stagingDir,priorDirectory,async read(path:string){
   if(!active)throw Error('Prepared publication lease has ended');
   await assertActive();const absolute=resolve(path),pin=pins.get(absolute);
   if(!pin||await realpath(absolute)!==absolute)throw Error('Publication input lacks its authenticated preparation output pin');
   const file=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
   try{const metadata=await file.stat();if(!metadata.isFile()||metadata.size!==pin.bytes)throw Error('Prepared publication lease member size/type mismatch');bytes=await file.readFile();}finally{await file.close();}
   if(bytes.length!==pin.bytes||hash(bytes)!==pin.sha256)throw Error('Prepared publication lease member differs from authenticated output');
   await assertActive();if(!active)throw Error('Prepared publication lease has ended');return bytes;
  }});
  preparedPublications.add(publication);
  try{return await consume({summary:prepared.summary,publicationQuarantine:prepared.publicationQuarantine,stagingDir,scope,outputPins,publication});}
  finally{active=false;preparedPublications.delete(publication);}
 },{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',purpose:'artifact'});
}
if(process.argv[1]&&await realpath(process.argv[1]).then(entry=>import.meta.url===pathToFileURL(entry).href,()=>false)){
 const {values}=parseArgs({options:{registry:{type:'string',default:join(root,'sources','district-registry.json')},'text-composition':{type:'string'},records:{type:'string',default:join(cacheDir,'district-joint','owner-policy-2026-10-11','source-content','records.json')},quarantine:{type:'string',default:join(cacheDir,'district-joint','owner-policy-2026-10-11','source-content','quarantine.json')},'private-provenance':{type:'string'},'private-provenance-sha256':{type:'string'},'output-root':{type:'string'},'structured-run':{type:'string'},'policy-receipts':{type:'string'},'identity-assessments':{type:'string'},'critical-assessments':{type:'string'},'cas-root':{type:'string'},'policy-state-dir':{type:'string'},'policy-authority-id':{type:'string'},'policy-authority-sha256':{type:'string'},'minimum-per-district':{type:'string',default:'1'},'coverage-generated-at':{type:'string'}}});
 if(!values['private-provenance']||!values['private-provenance-sha256'])throw Error('Knowledge preparation requires --private-provenance and its independent --private-provenance-sha256');
 console.log(JSON.stringify(await prepareKnowledge({registry:values.registry!,textComposition:values['text-composition'],records:values.records!,quarantine:values.quarantine!,privateProvenance:{path:values['private-provenance'],sha256:values['private-provenance-sha256']},outputRoot:values['output-root'],structuredRun:values['structured-run'],policyReceipts:values['policy-receipts'],identityAssessments:values['identity-assessments'],criticalAssessments:values['critical-assessments'],casRoot:values['cas-root'],policyStateDir:values['policy-state-dir'],policyAuthorityId:values['policy-authority-id'],policyAuthoritySha256:values['policy-authority-sha256'],minimum:Number(values['minimum-per-district']),coverageGeneratedAt:values['coverage-generated-at']})));
}
