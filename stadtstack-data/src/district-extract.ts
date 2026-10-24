import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {cacheDir} from './common.ts';
import {operatorRegistryInputPinSchema,readOperatorRegistryInputPin,type OperatorRegistryInputPin} from './district-registry-config.ts';
import {KNOWLEDGE_SCHEMA_VERSION,KnowledgeRecordsSchema,validateKnowledgeRelease,hashSchema,sha256,type DistrictKnowledgeRecord} from './district-schema.ts';
import {modelReadiness} from './district-model.ts';
import {PROVIDER_CONFIGS,type ExtractorProvider} from './district-model-contract.ts';
import {readPreparedDocument,assertPreparedSourcesActive,assertPreparedReferenceMembership,preparedSourceBindings,type PreparedSourceReference} from './district-prepared-document.ts';
import {prepareFrozenCorpus,preparationPlanSchema,type PreparationPlan,type PreparationGroup} from './district-preparation-run.ts';
import {createWorkPlan,restoreWorkPlan,resumeWorkPlanProviders,runWorkPlan,WorkPlanSchema,WorkFailureSchema,classifyWorkFailure,RemoteWorkFailure,type WorkPlan,type WorkTask,type WorkerCapacity} from './district-work-plan.ts';
import {inferPreparedDocument,jointExtractionContract,archiveJointExtractionContract,documentResultSchema,type DocumentResult,type QuarantineCase} from './district-inference.ts';
import {summarizeAgreement} from './district-agreement.ts';
import {writePrivateJson,writeManagedSourceJson,readPinnedJson,acquirePrivateRunLock} from './district-private-io.ts';
import {readUsageLedger,hourlyUsage,isProviderStopped,providerIsPaused,writeOperatorPause,clearProviderFailurePause} from './district-model-usage.ts';
import {safeFailure} from './district-claims.ts';
import {startWorkerLease,finishWorkerLease,captureLocalDocumentWorker} from './district-worker-lease.ts';
import {CIVIC_POLICY_AUTHORITY,CIVIC_ACQUISITION_DECISION_ID,assertCivicPolicyAuthority,assertManagedSourceReadable,assertManagedSourceBindings,initializeManagedAcquisitionLane,type CivicPolicyOptions} from './civic-opt-out.ts';

const providerSchema=z.literal('openai-subscription');
const authoritySchema=z.object({stateDir:z.literal(CIVIC_POLICY_AUTHORITY.stateDir),authorityId:z.literal(CIVIC_POLICY_AUTHORITY.authorityId),authoritySha256:hashSchema,r2Integrity:z.object({journalPath:z.string().min(1),recordSha256:hashSchema,manifestSha256:hashSchema,changedSourceReleasePath:z.string().min(1).optional(),changedSourceReleaseSha256:hashSchema.optional()}).strict().optional()}).strict();
const receiptSchema=z.object({taskId:hashSchema,resultSha256:hashSchema,preparedSha256:hashSchema,promptSha256:hashSchema,schemaSha256:hashSchema,records:z.number().int().nonnegative(),quarantined:z.number().int().nonnegative(),authorityId:z.string(),authoritySha256:hashSchema}).strict();
function groupFor(plan:PreparationPlan,task:WorkTask):PreparationGroup{
 const group=plan.groups.find(group=>group.expected.municipalityId===task.group.municipalityId&&group.expected.sourceSha256===task.group.sourceSha256&&group.expected.receiptSha256===task.group.preparedSha256);
 if(!group)throw Error('Prepared work group is not bound to the frozen plan');return group;
}
export type DocumentResultBinding=Pick<DocumentResult,'taskId'|'groupId'|'provider'|'purpose'|'sourceSha256'|'municipalityId'|'preparedSha256'|'promptSha256'|'schemaSha256'>;
export function checkResult(result:DocumentResultBinding,task:WorkTask,plan:WorkPlan):void{
 if(result.taskId!==task.id||result.groupId!==task.groupId||result.provider!==task.provider||result.purpose!==task.purpose||result.sourceSha256!==task.group.sourceSha256||result.municipalityId!==task.group.municipalityId||result.preparedSha256!==task.group.preparedSha256||result.promptSha256!==plan.promptSha256||result.schemaSha256!==plan.schemaSha256)throw Error('Document result source/provider/contract mismatch');
}
function resultReferences(result:DocumentResult,group:PreparationGroup):PreparedSourceReference[]{
 assertPreparedReferenceMembership([...result.records.flatMap(record=>record.sources),...result.quarantine.flatMap(item=>item.candidate?.sources??[])],group.expected.references);
 return group.expected.references;
}
export async function readTaskResult(path:string,task:WorkTask,plan:WorkPlan,group:PreparationGroup,policy:CivicPolicyOptions):Promise<{result:DocumentResult;sha256:string}>{
 await assertPreparedSourcesActive(group.expected.references,policy);
 const bindings=preparedSourceBindings(group.expected.references,group.expected.receiptSha256);
 await assertManagedSourceBindings(path,bindings,policy);
 const bytes=await readFile(path),digest=sha256(bytes);
 if(task.resultSha256&&task.resultSha256!==digest)throw Error('Document result receipt hash mismatch');
 const result=documentResultSchema.parse(JSON.parse(bytes.toString('utf8')));checkResult(result,task,plan);
 await assertManagedSourceBindings(path,bindings,policy);
 await assertPreparedSourcesActive(resultReferences(result,group),policy);
 return {result,sha256:digest};
}
function taskReceipt(result:DocumentResult,resultSha256:string,authority:{authorityId:string;authoritySha256:string}){
 return receiptSchema.parse({taskId:result.taskId,resultSha256,preparedSha256:result.preparedSha256,promptSha256:result.promptSha256,schemaSha256:result.schemaSha256,records:result.records.length,quarantined:result.quarantine.length,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256});
}
export async function cacheTaskResult(contentRoot:string,result:DocumentResult,task:WorkTask,plan:WorkPlan,group:PreparationGroup,policy:CivicPolicyOptions){
 checkResult(result,task,plan);
 const references=resultReferences(result,group);await assertPreparedSourcesActive(references,policy);
 const authority=await assertCivicPolicyAuthority(policy),path=join(contentRoot,'results',task.id+'.json');
 const digest=await writeManagedSourceJson(contentRoot,path,result,preparedSourceBindings(references,result.preparedSha256),{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 return taskReceipt(result,digest,authority);
}
export async function runDocumentWorker():Promise<void>{
 if(process.platform!=='linux')throw Error('Codex document worker must run on the authoritative VM');
 const lease=startWorkerLease(process.stdin,raw=>z.object({preparationPath:z.string(),preparationSha256:hashSchema,registry:operatorRegistryInputPinSchema,out:z.string(),workPlanId:hashSchema,taskId:hashSchema,policy:authoritySchema}).strict().parse(raw));
 const locks:Array<()=>Promise<void>>=[];
 try{
  const request=await lease.control;lease.signal.throwIfAborted();const authority=await assertCivicPolicyAuthority(request.policy);
  const policy={...request.policy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
  await assertManagedSourceReadable(request.preparationPath,policy);
  const preparation=preparationPlanSchema.parse(await readPinnedJson(request.preparationPath,request.preparationSha256));
  if(JSON.stringify(request.policy.r2Integrity)!==JSON.stringify(preparation.r2Integrity))throw Error('Worker control R2 guard differs from hash-pinned preparation');
  policy.r2Integrity=preparation.r2Integrity;
  const registryAdmission=await readOperatorRegistryInputPin(request.registry,policy);
  if(sha256(registryAdmission.bytes)!==preparation.registrySha256)throw Error('Worker admitted registry differs from preparation');
  const contract=await jointExtractionContract(),plan=createWorkPlan(preparation.groups.map(group=>({municipalityId:group.expected.municipalityId,sourceSha256:group.expected.sourceSha256,preparedSha256:group.expected.receiptSha256})),contract,'codex-only');
  if(plan.id!==request.workPlanId)throw Error('Worker plan contract mismatch');
  const task=plan.tasks.find(task=>task.id===request.taskId);if(!task||task.provider!=='openai-subscription')throw Error('Invalid native Codex task assignment');
  const group=groupFor(preparation,task),out=resolve(request.out),contentRoot=join(out,'source-content'),resultPath=join(contentRoot,'results',task.id+'.json');
  await archiveJointExtractionContract(out,contract,lease.signal);
  await assertPreparedSourcesActive(group.expected.references,policy);
  await initializeManagedAcquisitionLane(contentRoot,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
  for(const key of ['task-'+task.id,'group-'+task.groupId])locks.push(await acquirePrivateRunLock(join(out,'locks',key+'.lock'),'authoritative Codex document inference'));
  lease.signal.throwIfAborted();
  try{
   const existing=await readTaskResult(resultPath,task,plan,group,policy);
   console.log(JSON.stringify(taskReceipt(existing.result,existing.sha256,authority)));return;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const prepared=await readPreparedDocument(group.expected,policy);lease.signal.throwIfAborted();
  const result=await inferPreparedDocument({taskId:task.id,groupId:task.groupId,purpose:task.purpose,provider:task.provider,municipality:group.municipality,prepared,expected:group.expected,contract,out,policy,usage:{ledgerPath:join(out,'openai-usage.jsonl'),pausePath:join(out,'operator-pause.json'),signal:lease.signal,policy}});
  lease.signal.throwIfAborted();console.log(JSON.stringify(await cacheTaskResult(contentRoot,result,task,plan,group,policy)));
 }catch(error){console.log(JSON.stringify({failure:classifyWorkFailure(lease.signal.aborted?lease.signal.reason:error)}));}
 finally{await finishWorkerLease(lease,locks);}
}
export async function assembleRun(preparation:PreparationPlan,plan:WorkPlan,out:string,registryInput:OperatorRegistryInputPin,policy:CivicPolicyOptions=CIVIC_POLICY_AUTHORITY){
 await assertCivicPolicyAuthority(policy);
 if(preparation.quarantine.some(item=>item.candidate))throw Error('Preparation quarantine candidate lacks an authenticated prepared receipt');
 const {registry,bytes:registryBytes}=await readOperatorRegistryInputPin(registryInput,policy);
 if(sha256(registryBytes)!==preparation.registrySha256)throw Error('Admitted registry differs from frozen extraction');
 const contentRoot=join(out,'source-content');
 await initializeManagedAcquisitionLane(contentRoot,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
 const results=new Map<string,DocumentResult>();
 for(const task of plan.tasks.filter(task=>task.state==='completed')){
  const {result}=await readTaskResult(join(contentRoot,'results',task.id+'.json'),task,plan,groupFor(preparation,task),policy);results.set(task.id,result);
 }
 const primary=plan.tasks.filter(task=>task.purpose==='production'&&results.has(task.id)),records:DistrictKnowledgeRecord[]=[],quarantine:QuarantineCase[]=[...preparation.quarantine];
 for(const task of primary){const result=results.get(task.id)!;records.push(...result.records);quarantine.push(...result.quarantine);}
 const generatedAt=new Date().toISOString(),envelope=validateKnowledgeRelease({schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt,records,identityAssertions:[],identityAdmissions:[]},registry);
 const attempted=new Set([...primary.map(task=>`${task.group.municipalityId}:${task.group.sourceSha256}`),...preparation.quarantine.map(item=>`${item.municipalityId}:${item.sourceSha256}`)]);
 const summary={schemaVersion:'stadtstack-extraction-run-v2',generatedAt,workPlanId:plan.id,assignmentMode:plan.assignmentMode,corpusSha256:preparation.corpusSha256,registrySha256:preparation.registrySha256,promptContractSha256:plan.promptSha256,schemaSha256:plan.schemaSha256,scope:preparation.maxDocumentsPerMunicipality===null?'all_fetched_documents':'bounded_per_municipality',maxDocumentsPerMunicipality:preparation.maxDocumentsPerMunicipality,availableDocumentGroups:preparation.availableDocumentGroups,attemptedDocumentGroups:attempted.size,pendingDocumentGroups:preparation.availableDocumentGroups-attempted.size,selectedDocuments:preparation.selectedRepresentations,promotedRecords:records.length,quarantinedCases:quarantine.length,
  providers:Object.entries(PROVIDER_CONFIGS).map(([provider,config])=>({provider,model:config.model,tool:config.tool,state:plan.providers[provider as ExtractorProvider],assignedGroups:plan.tasks.filter(task=>task.provider===provider&&task.purpose==='production').length,completedGroups:primary.filter(task=>task.provider===provider).length,agreementCompleted:plan.tasks.filter(task=>task.provider===provider&&task.purpose==='agreement'&&task.state==='completed').length,publishedCandidates:records.filter(record=>record.extraction.provider===provider).length,failures:plan.tasks.filter(task=>task.provider===provider&&task.state==='failed').map(task=>({taskId:task.id,category:task.failureCategory??task.failure,errorMessageSha256:task.errorMessageSha256}))})),
  municipalities:preparation.municipalities.map(city=>({...city,attemptedDocumentGroups:[...attempted].filter(key=>key.startsWith(city.id+':')).length,promotedRecords:records.filter(record=>record.municipalityId===city.id).length,quarantinedCases:quarantine.filter(item=>item.municipalityId===city.id).length,identifiedCases:new Set(records.filter(record=>record.municipalityId===city.id&&record.caseKeyType!=='source_document').map(record=>record.caseKeyType+':'+record.caseKey)).size,sourceDocumentGroups:new Set(records.filter(record=>record.municipalityId===city.id&&record.caseKeyType==='source_document').map(record=>record.extraction.inputSha256)).size})),
  limitations:['Counts are source evidence records, not distinct solved projects. Same-provider judgment is not independent verification. Agreement secondary records are not published. No new crawling or inferred municipal inactivity.']};
 const contributing=primary.flatMap(task=>resultReferences(results.get(task.id)!,groupFor(preparation,task)));
 await assertPreparedSourcesActive(contributing,policy);
 const bindings=primary.flatMap(task=>preparedSourceBindings(resultReferences(results.get(task.id)!,groupFor(preparation,task)),task.group.preparedSha256));
 if(!bindings.length)throw Error('Source-bearing assembly requires an admitted contributing source inventory');
 await writeManagedSourceJson(contentRoot,join(contentRoot,'records.json'),KnowledgeRecordsSchema.parse(envelope),bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 await writeManagedSourceJson(contentRoot,join(contentRoot,'quarantine.json'),{schemaVersion:'stadtstack-quarantine-v1',generatedAt,cases:quarantine},bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 await writePrivateJson(join(out,'extraction-run.json'),summary);
 await writeManagedSourceJson(contentRoot,join(contentRoot,'agreement.json'),summarizeAgreement(plan,results),bindings,{decisionId:CIVIC_ACQUISITION_DECISION_ID,...policy});
 await writePrivateJson(join(out,'openai-hourly.json'),hourlyUsage(await readUsageLedger(join(out,'openai-usage.jsonl'))));
 return summary;
}
export async function runCodexExtraction(options:{preparationPath:string;preparationSha256:string;registry:OperatorRegistryInputPin;out:string;resume?:boolean;policy?:CivicPolicyOptions}){
 if(process.platform!=='linux')throw Error('Source extraction runs only on the authoritative Codex VM');
 const selectedPolicy:CivicPolicyOptions=options.policy??CIVIC_POLICY_AUTHORITY,authority=await assertCivicPolicyAuthority(selectedPolicy),policy:CivicPolicyOptions={...CIVIC_POLICY_AUTHORITY,...selectedPolicy,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 authoritySchema.parse(policy);

 const out=resolve(options.out),contentRoot=join(out,'source-content');
 await initializeManagedAcquisitionLane(contentRoot,{decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts',...policy});
 const releaseLock=await acquirePrivateRunLock(join(out,'run.lock'),'authoritative Codex-only source extraction');
 const pausePath=join(out,'operator-pause.json'),controller=new AbortController(),interrupted=()=>controller.abort(Object.assign(Error('Coordinator interrupted'),{failureCategory:'operator_pause'}));
 for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const)process.on(signal,interrupted);
 const capacity:WorkerCapacity={'openai-subscription':1,'anthropic-subscription':0};
 try{
  await assertManagedSourceReadable(options.preparationPath,policy);
  const preparation=preparationPlanSchema.parse(await readPinnedJson(options.preparationPath,options.preparationSha256)),contract=await jointExtractionContract();
  if(preparation.r2Integrity)policy.r2Integrity=preparation.r2Integrity;
  await assertManagedSourceReadable(options.preparationPath,policy);
  const registryAdmission=await readOperatorRegistryInputPin(options.registry,policy);
  if(sha256(registryAdmission.bytes)!==preparation.registrySha256)throw Error('Admitted registry differs from trusted preparation');
  await assertPreparedSourcesActive(preparation.groups.flatMap(group=>group.expected.references),policy);
  const generationContract=await archiveJointExtractionContract(out,contract,controller.signal);
  const expected=createWorkPlan(preparation.groups.map(group=>({municipalityId:group.expected.municipalityId,sourceSha256:group.expected.sourceSha256,preparedSha256:group.expected.receiptSha256})),contract,'codex-only'),planPath=join(out,'plans',expected.id+'.json');
  let plan:WorkPlan;
  try{plan=restoreWorkPlan(JSON.parse(await readFile(planPath,'utf8')));if(plan.id!==expected.id)throw Error('Stored work plan mismatch');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;plan=expected;}
  if(plan.assignmentMode!=='codex-only'||plan.tasks.some(task=>task.provider!=='openai-subscription'))throw Error('Non-Codex execution is disabled pending shared R1 authority');
  plan.providers['anthropic-subscription']='paused';
  if(options.resume){resumeWorkPlanProviders(plan,['openai-subscription']);await clearProviderFailurePause(pausePath,'openai-subscription');}
  for(const task of plan.tasks.filter(task=>task.state==='completed'))await readTaskResult(join(contentRoot,'results',task.id+'.json'),task,plan,groupFor(preparation,task),policy);
  await writePrivateJson(join(out,'active-run.json'),{preparationPath:resolve(options.preparationPath),preparationSha256:options.preparationSha256,workPlanPath:planPath,workPlanId:plan.id,registry:{path:resolve(options.registry.path),sha256:options.registry.sha256},policy,generationContract});
  await runWorkPlan(plan,async(task,_contract,signal)=>{
   controller.signal.throwIfAborted();
   const group=groupFor(preparation,task),resultPath=join(contentRoot,'results',task.id+'.json');
   await assertPreparedSourcesActive(group.expected.references,policy);
   try{const existing=await readTaskResult(resultPath,task,plan,group,policy);return taskReceipt(existing.result,existing.sha256,authority);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   const response=z.union([receiptSchema,z.object({failure:WorkFailureSchema}).strict()]).parse(JSON.parse(await captureLocalDocumentWorker({preparationPath:resolve(options.preparationPath),preparationSha256:options.preparationSha256,registry:{path:resolve(options.registry.path),sha256:options.registry.sha256},out,workPlanId:plan.id,taskId:task.id,policy},signal)));
   if('failure' in response)throw new RemoteWorkFailure(response.failure);
   if(response.authorityId!==authority.authorityId||response.authoritySha256!==authority.authoritySha256)throw Error('Worker authority receipt mismatch');
   const {result,sha256:digest}=await readTaskResult(resultPath,task,plan,group,policy);
   if(response.resultSha256!==digest||response.taskId!==task.id||response.preparedSha256!==task.group.preparedSha256||response.promptSha256!==plan.promptSha256||response.schemaSha256!==plan.schemaSha256||response.records!==result.records.length||response.quarantined!==result.quarantine.length)throw Error('Worker result receipt mismatch');
   return response;
  },snapshot=>writePrivateJson(planPath,snapshot).then(()=>{}),provider=>controller.signal.aborted?Promise.resolve(true):isProviderStopped(pausePath,provider),{signal:controller.signal,capacity:()=>capacity});
  return await assembleRun(preparation,plan,out,options.registry,policy);
 }finally{
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const)process.off(signal,interrupted);
  await releaseLock();
 }
}
async function controlProvider(out:string,action:'pause'|'resume',policy:CivicPolicyOptions){
 await assertCivicPolicyAuthority(policy);
 const path=join(out,'operator-pause.json'),states:{'openai-subscription':boolean;'anthropic-subscription':boolean}={'openai-subscription':await providerIsPaused(path,'openai-subscription'),'anthropic-subscription':true};
 states['openai-subscription']=action==='pause';await writeOperatorPause(path,states);
 if(action==='resume')await clearProviderFailurePause(path,'openai-subscription');
}
async function main(){
 if(process.platform!=='linux')throw Error('Source pipeline requires the authoritative Codex VM; Mac execution and transfer are disabled');
 const command=process.argv[2];
 if(command==='worker'){await runDocumentWorker();return;}
 const {values}=parseArgs({args:process.argv.slice(3),options:{index:{type:'string'},'corpus-sha256':{type:'string'},'registry-config':{type:'string'},'registry-config-sha256':{type:'string'},'raw-root':{type:'string'},'prepared-plan':{type:'string'},'prepared-sha256':{type:'string'},out:{type:'string',default:join(cacheDir,'district-joint','owner-policy-2026-10-11')},'max-documents-per-municipality':{type:'string'},provider:{type:'string',default:'openai-subscription'},action:{type:'string'},resume:{type:'boolean',default:false},'after-seconds':{type:'string'}}});
 const out=resolve(values.out!),authority=await assertCivicPolicyAuthority(CIVIC_POLICY_AUTHORITY),policy={...CIVIC_POLICY_AUTHORITY,authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 providerSchema.parse(values.provider);
 if(command==='readiness'){console.log(JSON.stringify(await modelReadiness('openai-subscription',undefined,policy)));return;}
 if(command==='usage'){
  const seconds=Number(values['after-seconds']??0);if(!Number.isFinite(seconds)||seconds<0||seconds>3600)throw Error('Usage report delay must be0..3600seconds');
  if(seconds){const wait=Promise.withResolvers<void>();setTimeout(wait.resolve,seconds*1000);await wait.promise;}
  console.log(JSON.stringify(hourlyUsage(await readUsageLedger(join(out,'openai-usage.jsonl')))));return;
 }
 if(command==='control'){const action=z.enum(['pause','resume']).parse(values.action);await controlProvider(out,action,policy);console.log(JSON.stringify({provider:'openai-subscription',action,applied:true}));return;}
 if(command==='prepare'){
  if(!values.index||!values['corpus-sha256']||!values['raw-root']||!values['registry-config']||!values['registry-config-sha256'])throw Error('Usage: district-extract prepare --index PATH --corpus-sha256 HASH --raw-root PATH --registry-config DESCRIPTOR_PATH --registry-config-sha256 DESCRIPTOR_SHA256 [--max-documents-per-municipality N]');
  const registry=operatorRegistryInputPinSchema.parse({path:values['registry-config'],sha256:values['registry-config-sha256']});
  const {plan,planSha256,path}=await prepareFrozenCorpus({index:values.index,expectedIndexSha256:values['corpus-sha256'],registry,rawRoot:values['raw-root'],maxDocumentsPerMunicipality:values['max-documents-per-municipality']===undefined?undefined:Number(values['max-documents-per-municipality']),policy});
  console.log(JSON.stringify({planSha256,path,preparedGroups:plan.groups.length,quarantinedGroups:plan.quarantine.length,availableGroups:plan.availableDocumentGroups}));if(!plan.groups.length)process.exitCode=1;return;
 }
 if(command==='run'){
  if(!values['prepared-plan']||!values['prepared-sha256']||!values['registry-config']||!values['registry-config-sha256'])throw Error('Usage: district-extract run --prepared-plan PATH --prepared-sha256 HASH --registry-config DESCRIPTOR_PATH --registry-config-sha256 DESCRIPTOR_SHA256 [--out PATH] [--resume]');
  const registry=operatorRegistryInputPinSchema.parse({path:values['registry-config'],sha256:values['registry-config-sha256']});
  const summary=await runCodexExtraction({preparationPath:values['prepared-plan'],preparationSha256:values['prepared-sha256'],registry,out,resume:values.resume,policy});console.log(JSON.stringify(summary));if(!summary.promotedRecords)process.exitCode=1;return;
 }
 if(command==='assemble'){
  if(!values['registry-config']||!values['registry-config-sha256'])throw Error('Usage: district-extract assemble --registry-config PATH --registry-config-sha256 SHA [--out PATH]');
  const registry=operatorRegistryInputPinSchema.parse({path:values['registry-config'],sha256:values['registry-config-sha256']});
  const active=z.object({preparationPath:z.string(),preparationSha256:hashSchema,workPlanPath:z.string(),registry:operatorRegistryInputPinSchema,policy:authoritySchema}).passthrough().parse(JSON.parse(await readFile(join(out,'active-run.json'),'utf8')));
  await assertCivicPolicyAuthority(active.policy);
  if(resolve(registry.path)!==resolve(active.registry.path)||registry.sha256!==active.registry.sha256)throw Error('Registry descriptor differs from the authenticated active run');
  const preparation=preparationPlanSchema.parse(await readPinnedJson(active.preparationPath,active.preparationSha256)),plan=WorkPlanSchema.parse(JSON.parse(await readFile(active.workPlanPath,'utf8')));
  console.log(JSON.stringify(await assembleRun(preparation,plan,out,active.registry,active.policy)));return;
 }
 throw Error('Usage: district-extract prepare|run|worker|assemble|usage|control|readiness');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error instanceof Error&&error.message.startsWith('Usage:')?error.message:safeFailure(error));process.exitCode=1;});
