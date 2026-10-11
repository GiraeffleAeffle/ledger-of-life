import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {cacheDir,root} from './common.ts';
import {loadDistrictRegistry} from './district-registry.ts';
import {KnowledgeRecordsSchema,validateKnowledgeRelease,hashSchema,sha256,type DistrictKnowledgeRecord} from './district-schema.ts';
import {modelReadiness} from './district-model.ts';
import {PROVIDER_CONFIGS,type ExtractorProvider} from './district-model-contract.ts';
import {PREPARED_VM_ROOT,fetchPreparedDocument,verifyPreparedDocument,assertPreparedSourcesActive} from './district-prepared-document.ts';
import {prepareFrozenCorpus,preparationPlanSchema,VM_PROJECT,VM_NODE,VM_RESULT_ROOT,type PreparationPlan,type PreparationGroup} from './district-preparation-run.ts';
import {createWorkPlan,restoreWorkPlan,resumeWorkPlanProviders,runWorkPlan,workerCapacity,WorkPlanSchema,WorkFailureSchema,AssignmentModeSchema,classifyWorkFailure,RemoteWorkFailure,type WorkPlan,type WorkTask,type AssignmentMode,type WorkerCapacity} from './district-work-plan.ts';
import {inferPreparedDocument,jointExtractionContract,documentResultSchema,type DocumentResult,type QuarantineCase} from './district-inference.ts';
import {summarizeAgreement} from './district-agreement.ts';
import {writePrivateJson,readPinnedJson,acquirePrivateRunLock} from './district-private-io.ts';
import {recordExercisedReadinessProbe,readUsageLedger,hourlyUsage,isProviderStopped,providerIsPaused,writeOperatorPause,clearProviderFailurePause,pauseProvider} from './district-model-usage.ts';
import {safeFailure} from './district-claims.ts';
import {startWorkerLease,finishWorkerLease,startWorkerHeartbeat,captureLocalDocumentWorker} from './district-worker-lease.ts';
import {startQuotaMonitor,type QuotaMonitor} from './district-worker-quota.ts';

const providerSchema=z.enum(['openai-subscription','anthropic-subscription']);
const receiptSchema=z.object({taskId:hashSchema,resultSha256:hashSchema,preparedSha256:hashSchema,promptSha256:hashSchema,schemaSha256:hashSchema,records:z.number().int().nonnegative(),quarantined:z.number().int().nonnegative()}).strict();
const shellQuote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
async function remoteCapture(argv:string[],input?:unknown,timeoutMs=3_600_000,workerLease=false,signal?:AbortSignal):Promise<string>{
 signal?.throwIfAborted();
 const {promise,resolve:done,reject}=Promise.withResolvers<string>();
 const child=spawn('/usr/bin/ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','codex-workstation',argv.map(shellQuote).join(' ')],{stdio:['pipe','pipe','pipe']});
 const chunks:Buffer[]=[];let bytes=0,failure:Error|undefined,stopHeartbeat:(()=>void)|undefined,killTimer:NodeJS.Timeout|undefined;
 const stop=(message:string)=>{
  if(failure)return;failure=Object.assign(Error(message),{failureCategory:'transport'});
  stopHeartbeat?.();child.stdin.destroy();child.kill('SIGTERM');
  killTimer=setTimeout(()=>child.kill('SIGKILL'),5_000);killTimer.unref();
 };
 const interrupted=()=>stop('Authenticated extraction connection interrupted');
 const timer=setTimeout(()=>stop('Authenticated extraction worker timed out'),timeoutMs);
 const cancelled=()=>stop('Authenticated extraction worker cancelled');
 signal?.addEventListener('abort',cancelled,{once:true});if(signal?.aborted)cancelled();
 for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const)process.on(signal,interrupted);
 const stdout=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>32*1024*1024)stop('Authenticated worker output exceeded bound');else if(!failure)chunks.push(chunk);};
 const stderr=()=>{}; // Remote diagnostics may contain source material; never forward them.
 const unavailable=()=>stop('Authenticated extraction worker unavailable'),inputFailed=()=>stop('Authenticated extraction connection input failed');
 child.stdout.on('data',stdout);child.stderr.on('data',stderr);
 child.once('error',unavailable);child.stdin.on('error',inputFailed);
 child.once('close',code=>{if(failure)reject(failure);else if(code!==0)reject(Object.assign(Error('Authenticated extraction worker failed'),{failureCategory:'transport'}));else done(Buffer.concat(chunks).toString('utf8'));});
 try{
  try{
   if(workerLease)stopHeartbeat=startWorkerHeartbeat(child.stdin,input,()=>stop('Authenticated extraction heartbeat failed'));
   else child.stdin.end(input===undefined?'':JSON.stringify(input));
  }catch{stop('Authenticated extraction control input failed');}
  return await promise;
 }finally{
  clearTimeout(timer);clearTimeout(killTimer);stopHeartbeat?.();
  signal?.removeEventListener('abort',cancelled);
  child.stdout.off('data',stdout);child.stderr.off('data',stderr);child.off('error',unavailable);child.stdin.off('error',inputFailed);
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const)process.off(signal,interrupted);
 }
}
function groupFor(plan:PreparationPlan,task:WorkTask):PreparationGroup{
 const group=plan.groups.find(group=>group.expected.municipalityId===task.group.municipalityId&&group.expected.sourceSha256===task.group.sourceSha256&&group.expected.receiptSha256===task.group.preparedSha256);
 if(!group)throw Error('Prepared work group is not bound to the frozen plan');return group;
}
export function checkResult(result:DocumentResult,task:WorkTask,plan:WorkPlan):void{
 if(result.taskId!==task.id||result.groupId!==task.groupId||result.provider!==task.provider||result.purpose!==task.purpose||result.sourceSha256!==task.group.sourceSha256||result.municipalityId!==task.group.municipalityId||result.preparedSha256!==task.group.preparedSha256||result.promptSha256!==plan.promptSha256||result.schemaSha256!==plan.schemaSha256)throw Error('Document result source/provider/contract mismatch');
}
async function taskReceipt(path:string,result:DocumentResult){
 const resultSha256=await writePrivateJson(path,result);
 return receiptSchema.parse({taskId:result.taskId,resultSha256,preparedSha256:result.preparedSha256,promptSha256:result.promptSha256,schemaSha256:result.schemaSha256,records:result.records.length,quarantined:result.quarantine.length});
}
export async function runRemoteDocumentWorker():Promise<void>{
 if(process.platform!=='linux')throw Error('Codex document worker must run on authorized VM');
 const lease=startWorkerLease(process.stdin,raw=>z.object({preparationPlanSha256:hashSchema,taskId:hashSchema,assignmentMode:AssignmentModeSchema}).strict().parse(raw));
 let releaseLock:(()=>Promise<void>)|undefined;
 try{
  const request=await lease.control;lease.signal.throwIfAborted();
  const preparation=preparationPlanSchema.parse(await readPinnedJson(join(PREPARED_VM_ROOT,'plans',request.preparationPlanSha256+'.json'),request.preparationPlanSha256));
  if(sha256(await readFile(join(VM_PROJECT,'sources','district-registry.json')))!==preparation.registrySha256)throw Error('Worker registry differs from preparation');
  const contract=await jointExtractionContract(),plan=createWorkPlan(preparation.groups.map(group=>({municipalityId:group.expected.municipalityId,sourceSha256:group.expected.sourceSha256,preparedSha256:group.expected.receiptSha256})),contract,request.assignmentMode);
  const task=plan.tasks.find(task=>task.id===request.taskId);if(!task||task.provider!=='openai-subscription')throw Error('Invalid native Codex task assignment');
  const group=groupFor(preparation,task);
  await assertPreparedSourcesActive(group.expected.references);
  const prepared=verifyPreparedDocument(JSON.parse(await readFile(join(PREPARED_VM_ROOT,group.expected.receiptSha256+'.json'),'utf8')),group.expected);
  const out=join(VM_PROJECT,'cache','district-joint','owner-policy-2026-10-11');lease.signal.throwIfAborted();
  releaseLock=await acquirePrivateRunLock(join(out,'openai-worker.lock'),'source-bound Codex document inference');
  const result=await inferPreparedDocument({taskId:task.id,groupId:task.groupId,purpose:task.purpose,provider:task.provider,municipality:group.municipality,prepared,expected:group.expected,contract,out,usage:{ledgerPath:join(out,'anthropic-usage.jsonl'),pausePath:join(out,'operator-pause.json'),signal:lease.signal}});
  lease.signal.throwIfAborted();
  console.log(JSON.stringify(await taskReceipt(join(VM_RESULT_ROOT,task.id+'.json'),result)));
 }catch(error){
  console.log(JSON.stringify({failure:classifyWorkFailure(lease.signal.aborted?lease.signal.reason:error)}));
 }finally{
  await finishWorkerLease(lease,releaseLock?[releaseLock]:[]);
 }
}
export async function runLocalDocumentWorker():Promise<void>{
 if(process.platform!=='darwin')throw Error('Claude document worker must run on authorized Mac');
 const lease=startWorkerLease(process.stdin,raw=>z.object({preparationPath:z.string(),preparationSha256:hashSchema,registry:z.string(),out:z.string(),workPlanId:hashSchema,taskId:hashSchema,assignmentMode:AssignmentModeSchema}).strict().parse(raw));
 const locks:Array<()=>Promise<void>>=[];
 try{
  const request=await lease.control;lease.signal.throwIfAborted();
  const preparation=preparationPlanSchema.parse(await readPinnedJson(request.preparationPath,request.preparationSha256));
  if(sha256(await readFile(request.registry))!==preparation.registrySha256)throw Error('Worker registry differs from preparation');
  const contract=await jointExtractionContract(),plan=createWorkPlan(preparation.groups.map(group=>({municipalityId:group.expected.municipalityId,sourceSha256:group.expected.sourceSha256,preparedSha256:group.expected.receiptSha256})),contract,request.assignmentMode);
  if(plan.id!==request.workPlanId)throw Error('Local worker plan contract mismatch');
  const task=plan.tasks.find(task=>task.id===request.taskId);if(!task||task.provider!=='anthropic-subscription')throw Error('Invalid native Claude task assignment');
  const group=groupFor(preparation,task),out=resolve(request.out),resultPath=join(out,'results',task.id+'.json');
  for(const key of ['task-'+task.id,'group-'+task.groupId])locks.push(await acquirePrivateRunLock(join(out,'locks',key+'.lock'),'source-bound Claude document inference'));
  lease.signal.throwIfAborted();
  let result:DocumentResult|undefined;
  try{result=documentResultSchema.parse(JSON.parse(await readFile(resultPath,'utf8')));checkResult(result,task,plan);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!result){
   const prepared=await fetchPreparedDocument(group.expected);lease.signal.throwIfAborted();
   result=await inferPreparedDocument({taskId:task.id,groupId:task.groupId,purpose:task.purpose,provider:task.provider,municipality:group.municipality,prepared,expected:group.expected,contract,out,usage:{ledgerPath:join(out,'anthropic-usage.jsonl'),pausePath:join(out,'operator-pause.json'),signal:lease.signal}});
  }
  checkResult(result,task,plan);lease.signal.throwIfAborted();
  console.log(JSON.stringify(await taskReceipt(resultPath,result)));
 }catch(error){
  console.log(JSON.stringify({failure:classifyWorkFailure(lease.signal.aborted?lease.signal.reason:error)}));
 }finally{
  await finishWorkerLease(lease,locks);
 }
}
async function assembleRun(preparation:PreparationPlan,plan:WorkPlan,out:string,registryPath:string){
 const registry=await loadDistrictRegistry(registryPath);
 if(sha256(await readFile(registryPath))!==preparation.registrySha256)throw Error('Registry changed during frozen extraction');
 const results=new Map<string,DocumentResult>();
 for(const task of plan.tasks.filter(task=>task.state==='completed')){
  const result=documentResultSchema.parse(await readPinnedJson(join(out,'results',task.id+'.json'),task.resultSha256!));checkResult(result,task,plan);results.set(task.id,result);
 }
 const primary=plan.tasks.filter(task=>task.purpose==='production'&&results.has(task.id)),records:DistrictKnowledgeRecord[]=[],quarantine:QuarantineCase[]=[...preparation.quarantine];
 for(const task of primary){const result=results.get(task.id)!;records.push(...result.records);quarantine.push(...result.quarantine);}
 const generatedAt=new Date().toISOString(),envelope=validateKnowledgeRelease({schemaVersion:'stadtstack-knowledge-v2',generatedAt,records},registry);
 const attempted=new Set([...primary.map(task=>`${task.group.municipalityId}:${task.group.sourceSha256}`),...preparation.quarantine.map(item=>`${item.municipalityId}:${item.sourceSha256}`)]);
 const summary={schemaVersion:'stadtstack-extraction-run-v2',generatedAt,workPlanId:plan.id,assignmentMode:plan.assignmentMode,corpusSha256:preparation.corpusSha256,registrySha256:preparation.registrySha256,promptContractSha256:plan.promptSha256,schemaSha256:plan.schemaSha256,scope:preparation.maxDocumentsPerMunicipality===null?'all_fetched_documents':'bounded_per_municipality',maxDocumentsPerMunicipality:preparation.maxDocumentsPerMunicipality,availableDocumentGroups:preparation.availableDocumentGroups,attemptedDocumentGroups:attempted.size,pendingDocumentGroups:preparation.availableDocumentGroups-attempted.size,selectedDocuments:preparation.selectedRepresentations,promotedRecords:records.length,quarantinedCases:quarantine.length,
  providers:Object.entries(PROVIDER_CONFIGS).map(([provider,config])=>({provider,model:config.model,tool:config.tool,state:plan.providers[provider as ExtractorProvider],assignedGroups:plan.tasks.filter(task=>task.provider===provider&&task.purpose==='production').length,completedGroups:primary.filter(task=>task.provider===provider).length,agreementCompleted:plan.tasks.filter(task=>task.provider===provider&&task.purpose==='agreement'&&task.state==='completed').length,publishedCandidates:records.filter(record=>record.extraction.provider===provider).length,failures:plan.tasks.filter(task=>task.provider===provider&&task.state==='failed').map(task=>({taskId:task.id,category:task.failureCategory??task.failure,errorMessageSha256:task.errorMessageSha256}))})),
  municipalities:preparation.municipalities.map(city=>({...city,attemptedDocumentGroups:[...attempted].filter(key=>key.startsWith(city.id+':')).length,promotedRecords:records.filter(record=>record.municipalityId===city.id).length,quarantinedCases:quarantine.filter(item=>item.municipalityId===city.id).length,identifiedCases:new Set(records.filter(record=>record.municipalityId===city.id&&record.caseKeyType!=='source_document').map(record=>record.caseKeyType+':'+record.caseKey)).size,sourceDocumentGroups:new Set(records.filter(record=>record.municipalityId===city.id&&record.caseKeyType==='source_document').map(record=>record.extraction.inputSha256)).size})),
  limitations:['Counts are source evidence records, not distinct solved projects. Same-provider judgment is not independent verification. Agreement secondary records are not published. No new crawling or inferred municipal inactivity.']};
 await writePrivateJson(join(out,'records.json'),KnowledgeRecordsSchema.parse(envelope));
 await writePrivateJson(join(out,'quarantine.json'),{schemaVersion:'stadtstack-quarantine-v1',generatedAt,cases:quarantine});
 await writePrivateJson(join(out,'extraction-run.json'),summary);
 await writePrivateJson(join(out,'agreement.json'),summarizeAgreement(plan,results));
 await writePrivateJson(join(out,'anthropic-hourly.json'),hourlyUsage(await readUsageLedger(join(out,'anthropic-usage.jsonl'))));
 return summary;
}
export async function runDualExtraction(options:{preparationPath:string;preparationSha256:string;registry:string;out:string;assignmentMode?:AssignmentMode;resumeProviders?:ExtractorProvider[];anthropicWorkers?:number;ownerWatchesQuota?:boolean}){
 if(process.platform!=='darwin')throw Error('Dual-provider coordinator uses authenticated Mac Claude and VM Codex');
 const requestedCapacity=workerCapacity(options.anthropicWorkers);
 const out=resolve(options.out);await mkdir(join(out,'results'),{recursive:true,mode:0o700});
 const releaseLock=await acquirePrivateRunLock(join(out,'run.lock'),'frozen pilot dual-provider joint graph extraction');
 const pausePath=join(out,'operator-pause.json'),ledgerPath=join(out,'anthropic-usage.jsonl');
 const controller=new AbortController(),interrupted=()=>controller.abort(Object.assign(Error('Coordinator interrupted'),{failureCategory:'operator_pause'}));
 for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const)process.on(signal,interrupted);
 let monitor:QuotaMonitor|undefined;
 const peak:WorkerCapacity={'openai-subscription':0,'anthropic-subscription':0};
 try{
  const preparation=preparationPlanSchema.parse(await readPinnedJson(options.preparationPath,options.preparationSha256)),contract=await jointExtractionContract();
  if(sha256(await readFile(options.registry))!==preparation.registrySha256)throw Error('Local registry differs from trusted VM preparation');
  const expected=createWorkPlan(preparation.groups.map(group=>({municipalityId:group.expected.municipalityId,sourceSha256:group.expected.sourceSha256,preparedSha256:group.expected.receiptSha256})),contract,options.assignmentMode??'balanced'),planPath=join(out,'plans',expected.id+'.json');
  let plan:WorkPlan;
  try{plan=restoreWorkPlan(JSON.parse(await readFile(planPath,'utf8')));if(plan.id!==expected.id)throw Error('Stored work plan mismatch');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;plan=expected;}
  const resumeProviders=[...new Set((options.resumeProviders??[]).map(provider=>providerSchema.parse(provider)))];
  resumeWorkPlanProviders(plan,resumeProviders);
  for(const provider of resumeProviders){await clearProviderFailurePause(pausePath,provider);if(provider==='openai-subscription')await remoteCapture([VM_NODE,VM_PROJECT+'/src/district-extract.ts','control','--provider',provider,'--action','resume'],undefined,60_000,false,controller.signal);}
  // Validate every completed receipt before starting any new calls, including resumed runs.
  for(const task of plan.tasks.filter(task=>task.state==='completed'))checkResult(documentResultSchema.parse(await readPinnedJson(join(out,'results',task.id+'.json'),task.resultSha256!)),task,plan);
  if(plan.providers['anthropic-subscription']==='ready'&&plan.tasks.some(task=>task.provider==='anthropic-subscription'&&task.state==='pending')){
   monitor=await startQuotaMonitor({requestedWorkers:requestedCapacity['anthropic-subscription'],ownerWatchesQuota:options.ownerWatchesQuota,signal:controller.signal,pause:()=>pauseProvider(pausePath,'anthropic-subscription'),persist:summary=>writePrivateJson(join(out,'worker-quota.json'),summary).then(()=>{})});
  }
  await recordExercisedReadinessProbe(ledgerPath);
  await writePrivateJson(join(out,'active-run.json'),{preparationPath:resolve(options.preparationPath),preparationSha256:options.preparationSha256,workPlanPath:planPath,workPlanId:plan.id,registry:resolve(options.registry)});
  await runWorkPlan(plan,async(task,_workContract,signal)=>{
   controller.signal.throwIfAborted();
   groupFor(preparation,task);const resultPath=join(out,'results',task.id+'.json');
   try{const existing=documentResultSchema.parse(JSON.parse(await readFile(resultPath,'utf8')));checkResult(existing,task,plan);return await taskReceipt(resultPath,existing);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   let result:DocumentResult;
   if(task.provider==='anthropic-subscription'){
    const response=z.union([receiptSchema,z.object({failure:WorkFailureSchema}).strict()]).parse(JSON.parse(await captureLocalDocumentWorker({preparationPath:resolve(options.preparationPath),preparationSha256:options.preparationSha256,registry:resolve(options.registry),out,workPlanId:plan.id,taskId:task.id,assignmentMode:plan.assignmentMode},signal)));
    if('failure' in response)throw new RemoteWorkFailure(response.failure);
    if(response.taskId!==task.id||response.preparedSha256!==task.group.preparedSha256||response.promptSha256!==plan.promptSha256||response.schemaSha256!==plan.schemaSha256)throw Error('Local task receipt contract mismatch');
    result=documentResultSchema.parse(await readPinnedJson(resultPath,response.resultSha256));
    if(response.records!==result.records.length||response.quarantined!==result.quarantine.length)throw Error('Local task receipt counts mismatch');
   }else{
    controller.signal.throwIfAborted();
    const response=z.union([receiptSchema,z.object({failure:WorkFailureSchema}).strict()]).parse(JSON.parse(await remoteCapture([VM_NODE,VM_PROJECT+'/src/district-extract.ts','worker'],{preparationPlanSha256:options.preparationSha256,taskId:task.id,assignmentMode:plan.assignmentMode},3_600_000,true,signal)));
    if('failure' in response)throw new RemoteWorkFailure(response.failure);
    const receipt=response;
    if(receipt.taskId!==task.id||receipt.preparedSha256!==task.group.preparedSha256||receipt.promptSha256!==plan.promptSha256||receipt.schemaSha256!==plan.schemaSha256)throw Error('Remote task receipt contract mismatch');
    const text=await remoteCapture(['cat','--',VM_RESULT_ROOT+'/'+task.id+'.json'],undefined,60_000,false,signal);
    if(sha256(text)!==receipt.resultSha256)throw Error('Remote task result hash mismatch');
    result=documentResultSchema.parse(JSON.parse(text));
    if(receipt.records!==result.records.length||receipt.quarantined!==result.quarantine.length)throw Error('Remote task receipt counts mismatch');
   }
   checkResult(result,task,plan);return taskReceipt(resultPath,result);
  },snapshot=>writePrivateJson(planPath,snapshot).then(()=>{}),provider=>controller.signal.aborted?Promise.resolve(true):isProviderStopped(pausePath,provider),{anthropicWorkers:options.anthropicWorkers,signal:controller.signal,capacity:()=>monitor?.capacity()??requestedCapacity,onCapacity:active=>{for(const provider of ['openai-subscription','anthropic-subscription'] as const)peak[provider]=Math.max(peak[provider],active[provider]);}});
  await monitor?.dispose();
  const capacity=monitor?.capacity()??requestedCapacity;
  await writePrivateJson(join(out,'worker-capacity.json'),{requested:requestedCapacity,effective:{'openai-subscription':plan.providers['openai-subscription']==='ready'?capacity['openai-subscription']:0,'anthropic-subscription':plan.providers['anthropic-subscription']==='ready'?capacity['anthropic-subscription']:0},peakActive:peak,quota:monitor?.summary()??null});
  return await assembleRun(preparation,plan,out,options.registry);
 }finally{
  await monitor?.dispose();
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'] as const)process.off(signal,interrupted);
  await releaseLock();
 }
}
async function controlProvider(out:string,provider:ExtractorProvider,action:'pause'|'resume'){
 const path=join(out,'operator-pause.json'),states:{'openai-subscription':boolean;'anthropic-subscription':boolean}={'openai-subscription':await providerIsPaused(path,'openai-subscription'),'anthropic-subscription':await providerIsPaused(path,'anthropic-subscription')};
 states[provider]=action==='pause';await writeOperatorPause(path,states);
 if(action==='resume')await clearProviderFailurePause(path,provider);
 if(process.platform==='darwin'&&provider==='openai-subscription')await remoteCapture([VM_NODE,VM_PROJECT+'/src/district-extract.ts','control','--provider',provider,'--action',action]);
}
async function main(){
 const command=process.argv[2];
 if(command==='worker'){await runRemoteDocumentWorker();return;}
 if(command==='local-worker'){await runLocalDocumentWorker();return;}
 const {values}=parseArgs({args:process.argv.slice(3),options:{index:{type:'string'},'corpus-sha256':{type:'string'},registry:{type:'string',default:join(root,'sources','district-registry.json')},'raw-root':{type:'string'},'prepared-plan':{type:'string'},'prepared-sha256':{type:'string'},out:{type:'string',default:join(cacheDir,'district-joint','owner-policy-2026-10-11')},'max-documents-per-municipality':{type:'string'},provider:{type:'string'},action:{type:'string'},'assignment-mode':{type:'string',default:'balanced'},'resume-provider':{type:'string',multiple:true},'anthropic-workers':{type:'string',default:'1'},'owner-watches-quota':{type:'boolean',default:false},'after-seconds':{type:'string'}}});
 const out=resolve(values.out!);
 if(command==='readiness'){console.log(JSON.stringify(await modelReadiness(providerSchema.parse(values.provider))));return;}
 if(command==='usage'){
  const seconds=Number(values['after-seconds']??0);if(!Number.isFinite(seconds)||seconds<0||seconds>3600)throw Error('Usage report delay must be0..3600seconds');
  if(seconds){const wait=Promise.withResolvers<void>();setTimeout(wait.resolve,seconds*1000);await wait.promise;}
  console.log(JSON.stringify(hourlyUsage(await readUsageLedger(join(out,'anthropic-usage.jsonl')))));return;
 }
 if(command==='control'){
  const provider=providerSchema.parse(values.provider),action=z.enum(['pause','resume']).parse(values.action);
  await controlProvider(out,provider,action);console.log(JSON.stringify({provider,action,applied:true}));return;
 }
 if(command==='prepare'){
  if(!values.index||!values['corpus-sha256']||!values['raw-root'])throw Error('Usage: district-extract prepare --index PATH --corpus-sha256 HASH --raw-root PATH [--registry PATH] [--max-documents-per-municipality N]');
  const {plan,planSha256,path}=await prepareFrozenCorpus({index:values.index,expectedIndexSha256:values['corpus-sha256'],registry:values.registry!,rawRoot:values['raw-root'],maxDocumentsPerMunicipality:values['max-documents-per-municipality']===undefined?undefined:Number(values['max-documents-per-municipality'])});
  console.log(JSON.stringify({planSha256,path,preparedGroups:plan.groups.length,quarantinedGroups:plan.quarantine.length,availableGroups:plan.availableDocumentGroups}));if(!plan.groups.length)process.exitCode=1;return;
 }
 if(command==='run'){
  if(!values['prepared-plan']||!values['prepared-sha256'])throw Error('Usage: district-extract run --prepared-plan PATH --prepared-sha256 HASH [--assignment-mode balanced|codex-only] [--registry PATH] [--out PATH] [--anthropic-workers 1..4] [--owner-watches-quota] [--resume-provider PROVIDER ...]');
  const summary=await runDualExtraction({preparationPath:values['prepared-plan'],preparationSha256:values['prepared-sha256'],registry:values.registry!,out,assignmentMode:AssignmentModeSchema.parse(values['assignment-mode']),resumeProviders:(values['resume-provider']??[]).map(provider=>providerSchema.parse(provider)),anthropicWorkers:Number(values['anthropic-workers']),ownerWatchesQuota:values['owner-watches-quota']});console.log(JSON.stringify(summary));if(!summary.promotedRecords)process.exitCode=1;return;
 }
 if(command==='assemble'){
  const active=z.object({preparationPath:z.string(),preparationSha256:hashSchema,workPlanPath:z.string(),registry:z.string()}).passthrough().parse(JSON.parse(await readFile(join(out,'active-run.json'),'utf8')));
  const preparation=preparationPlanSchema.parse(await readPinnedJson(active.preparationPath,active.preparationSha256)),plan=WorkPlanSchema.parse(JSON.parse(await readFile(active.workPlanPath,'utf8')));
  console.log(JSON.stringify(await assembleRun(preparation,plan,out,active.registry)));return;
 }
 throw Error('Usage: district-extract prepare|run|worker|assemble|usage|control|readiness');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error instanceof Error&&error.message.startsWith('Usage:')?error.message:safeFailure(error));process.exitCode=1;});
