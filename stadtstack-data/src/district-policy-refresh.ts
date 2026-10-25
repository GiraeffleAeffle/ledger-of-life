import {readFile,lstat} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {z} from 'zod';
import {HashSchema,ScopeSchema,canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {CrawlCorpusImportSchema,importCrawlCorpusForResidual} from './district-crawl-import.ts';
import {ResidualInputSchema,loadResidualSource} from './district-residual-jobs.ts';
import {corpusFixturePolicy} from './district-corpus.ts';
import {DistrictJobStore,canonicalJobIdentity,DistrictExecutionHold,policyContinuationVersions,type JobHandler,type JobHandlerResult,type JobPolicyContinuation} from './district-jobs.ts';
import {encodeStepReceipt} from './district-step-receipt.ts';
import {PolicyReceiptSchema,loadPolicyReceipt,recheckPolicyReceipt,type PolicyReceipt,type PolicyRecheckResult} from './district-policy-receipt.ts';
import {assertCivicPolicyAuthority,assertManagedSourceReadable,assertManagedSourceBindings,assertManagedObservationReadable,withManagedSourceWrite,initializeManagedAcquisitionLane,CIVIC_ACQUISITION_DECISION_ID,HostOptedOutError,CivicPolicyStateError} from './civic-opt-out.ts';
import type {DistrictCas} from './district-cas.ts';
import type {PoliteFetcher} from './polite-fetch.ts';
import {acquisitionFailureReason} from './district-r1.ts';

const VERSION='district-policy-refresh-v1';
const PreviousRefreshSchema=z.object({jobKey:HashSchema,receiptSha256:HashSchema}).strict();
const SelectorSchema=z.object({version:z.literal(VERSION),manifestSha256:HashSchema,scope:ScopeSchema,maxRequests:z.number().int().min(2).max(100),originalIdentitySha256:HashSchema,previousRefresh:PreviousRefreshSchema.optional()}).strict();
export const CrawlPolicyRefreshEnqueueSchema=z.object({manifest:z.lazy(()=>CrawlCorpusImportSchema),maxRequests:SelectorSchema.shape.maxRequests,previousRefreshes:z.array(PreviousRefreshSchema.extend({documentId:z.string().min(1)}).strict()).max(500).optional()}).strict();
const OriginalRobotsAbsencePinSchema=z.object({path:z.string().min(1),observationId:z.string().regex(/^[0-9]+-[a-f0-9-]{36}\.json$/),receiptSha256:HashSchema}).strict();
export async function policyRefreshContract(hash?:(file:string)=>Promise<string>){
 // Refresh jobs promise a receipt codec, not a frozen authorization decision.
 // They always evaluate current policy; decision inputs/results remain receipts.
 const files=['district-adapter-contract.ts','district-schema.ts'];
 return semanticHash({version:VERSION,receiptSchema:z.toJSONSchema(PolicyReceiptSchema),files:await Promise.all(files.map(async file=>({file,sha256:hash?await hash(file):digest(await readFile(new URL(file,import.meta.url)))})))});
}
/** Preflight is offline and may admit stale originals only for this network job.
 * It does not admit them to preparation or models and grants no fetch approval. */
export async function enqueueCrawlPolicyRefresh(store:DistrictJobStore,cas:DistrictCas,raw:unknown){
 const {manifest,maxRequests,previousRefreshes=[]}=CrawlPolicyRefreshEnqueueSchema.parse(raw);
 if(manifest.documents.some(row=>row.policyRefreshJobKey))throw Error('Refresh enqueue requires the unchanged original manifest, not a processed selection');
 const previousByDocument=new Map(previousRefreshes.map(({documentId,...previous})=>[documentId,previous]));
 if(previousByDocument.size!==previousRefreshes.length||previousRefreshes.some(row=>!manifest.documents.some(selected=>selected.documentId===row.documentId)))throw Error('Previous refresh pins must uniquely identify selected originals');
 // Historical committed evidence authorizes only a new identity, never processing
 // under an expired policy. All prior pins are checked before any jobs are queued.
 for(const [documentId,previous] of previousByDocument){
  const original={...manifest,documents:manifest.documents.filter(row=>row.documentId===documentId)};
  const prior=await authenticatePreviousRefresh(store,cas,previous,original);
  if(prior.selector.maxRequests!==maxRequests)throw Error('Refresh generation cannot change request bounds');
 }
 const contract=await policyRefreshContract(),policy=corpusFixturePolicy(),jobKeys:Array<{documentId:string;jobKey:string}>=[];
 const result=await importCrawlCorpusForResidual(store,cas,manifest,{enqueue:async(input,acquired,custody)=>{
  const bytes=Buffer.from(canonicalJson(input)),hash=digest(bytes),relativePath=`sha256/${hash.slice(0,2)}/${hash}`;
  const artifact=await withManagedSourceWrite(cas.root,[{...acquired.binding,relativePath,contentSha256:hash,independentAllowed:false}],()=>cas.put(bytes,{kind:'derived',mimeType:'application/json'}),policy);
  await store.addArtifact(artifact);
  const selected=input.documents[0],previousRefresh=previousByDocument.get(selected.documentId),prior=previousRefresh?await authenticatePreviousRefresh(store,cas,previousRefresh,input):undefined;
  if(prior)await assertManagedSourceBindings(join(cas.root,'sha256',prior.hash.slice(0,2),prior.hash),[acquired.binding],policy);
  const originalIdentitySha256=residualOriginalIdentity({documentId:selected.documentId,corpusSha256:input.index.sha256,corpusObservations:custody.corpusObservations,registrySha256:custody.registrySha256,registry:input.registry,...(input.crawlRegistry?{crawlRegistry:input.crawlRegistry}:{}),httpObservation:{observationId:acquired.binding.observationId,receiptSha256:acquired.binding.receiptSha256},requestEvidenceSha256:selected.requestEvidence!.sha256,bounds:selected.bounds});
  const selector=SelectorSchema.parse({version:VERSION,manifestSha256:hash,scope:selected.scope,maxRequests,originalIdentitySha256,...(previousRefresh?{previousRefresh}:{})});
  const jobKey=await store.enqueue({step:'policy_refresh',lane:'public_policy_refresh',semanticContractSha256:contract,inputArtifactHashes:[hash,input.index.sha256,...input.observations.map(row=>row.sha256),...(prior?[prior.hash]:[])],sourceScope:selected.scope,selector,policyProofSha256:null},{reservedMicroUsd:0,...(previousRefresh?{dependencies:[{jobKey:previousRefresh.jobKey,expectedReceiptSha256:previousRefresh.receiptSha256}]}:{})});
  jobKeys.push({documentId:selected.documentId,jobKey});
 }});
 return {jobKeys,holds:result.holds,coverage:{basis:'policy_refresh_preflight' as const,selected:manifest.documents.length,enqueued:jobKeys.length,held:result.holds.length}};
}
export function policyRefreshHandler(store:DistrictJobStore,createFetcher:(context:Parameters<JobHandler>[0],maxRequests:number)=>Promise<PoliteFetcher>):JobHandler{return async(context):Promise<JobHandlerResult>=>{
 const selector=SelectorSchema.parse(context.job.spec.selector),contract=await policyRefreshContract(),policy=corpusFixturePolicy();
 if(context.job.spec.step!=='policy_refresh'||context.job.spec.semanticContractSha256!==contract||semanticHash(context.job.spec.sourceScope)!==semanticHash(selector.scope)||context.job.spec.policyProofSha256!==null)throw Error('Policy refresh job contract differs');
 try{
  const path=join(context.cas.root,'sha256',selector.manifestSha256.slice(0,2),selector.manifestSha256);
  await assertManagedSourceReadable(path,policy);
  const bytes=await context.cas.read(selector.manifestSha256),manifest=CrawlCorpusImportSchema.parse(JSON.parse(bytes.toString('utf8')));
  if(digest(bytes)!==selector.manifestSha256||manifest.documents.length!==1||manifest.documents[0].policyRefreshJobKey||semanticHash(manifest.documents[0].scope)!==semanticHash(selector.scope))throw Error('Policy refresh manifest differs');
  const prior=selector.previousRefresh?await authenticatePreviousRefresh(store,context.cas,selector.previousRefresh,manifest):undefined;
  if(prior&&(!context.job.spec.inputArtifactHashes.includes(prior.hash)||!context.job.dependencyReceiptIds.includes(prior.receiptId)))throw Error('Refresh generation omits its prior committed output/dependency');
  const fetcher=await createFetcher(context,selector.maxRequests),observations:Array<{path:string;sha256:string}>=[];
  let originalRobotsAbsence:z.infer<typeof OriginalRobotsAbsencePinSchema>|undefined;
  const result=await importCrawlCorpusForResidual(store,context.cas,manifest,{refresh:async(acquired,source,registeredSourceEligibility)=>{
   context.signal.throwIfAborted();await assertManagedSourceBindings(path,[acquired.binding],policy);
   if(prior)await assertManagedSourceBindings(join(context.cas.root,'sha256',prior.hash.slice(0,2),prior.hash),[acquired.binding],policy);
   const current=await fetcher.refreshPolicyForOriginal({url:acquired.observation.url,sha256:acquired.observation.sha256},acquired.policy,{machinePolicyUrls:source.knownMachinePolicyUrls,originalPolicyRoot:manifest.rawRoot,scope:manifest.documents[0].scope,registeredSourceEligibility});
   originalRobotsAbsence=current.originalRobotsAbsence;
   for(const path of current.observations){await assertManagedObservationReadable(path,policy);const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Policy observation bound rejected');observations.push({path,sha256:digest(await readFile(path))});}
   context.signal.throwIfAborted();return current;
  }});
  if(result.jobs.length!==1)return {outcome:'blocked_policy',reasonCode:result.holds[0]?.reasonCode==='source_policy_stale'?'policy_expired':'source_policy_refused',versions:{policyRefresh:contract,policyRefreshOriginal:selector.originalIdentitySha256}};
  const job=result.jobs[0],loaded=await loadResidualSource(context.cas,job);
  if(residualOriginalIdentity(job)!==selector.originalIdentitySha256)throw Error('Policy refresh changes original custody identity');
  if(!observations.length)throw Error('Refresh lacks actual current observations');
  const output={version:VERSION,manifestSha256:selector.manifestSha256,observations,job,...(originalRobotsAbsence?{originalRobotsAbsence}:{}),...(selector.previousRefresh?{previousRefresh:selector.previousRefresh}:{})},outputBytes=Buffer.from(canonicalJson(output)),hash=digest(outputBytes);
  await initializeManagedAcquisitionLane(context.cas.root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
  const artifact=await withManagedSourceWrite(context.cas.root,[{...loaded.sourceBinding,relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,independentAllowed:false}],()=>context.cas.put(outputBytes,{kind:'derived',mimeType:'application/json'}),policy);
  await store.addArtifact(artifact);context.signal.throwIfAborted();await recheckPolicyReceipt(loaded.receipt,{...policy,evaluationAt:new Date().toISOString()});
  return {outcome:'succeeded',reasonCode:'completed',outputs:[artifact],versions:{policyRefresh:contract,policyRefreshOriginal:selector.originalIdentitySha256,policyRefreshReceipt:job.policyReceiptSha256},counts:{bytes:outputBytes.length}};
 }catch(error){
  context.signal.throwIfAborted();if(error instanceof DistrictExecutionHold)throw error;
  const reason=error instanceof HostOptedOutError?'policy_excluded':acquisitionFailureReason(error);
  if(reason&&reason!=='execution_exception')return {outcome:reason==='policy_excluded'||reason==='source_policy_refused'?'blocked_policy':'held_execution',reasonCode:reason,versions:{policyRefresh:contract,policyRefreshOriginal:selector.originalIdentitySha256}};
  throw error;
 }
};}
/** Historical committed refresh evidence is not current source admission. */
export async function readPolicyRefreshCommit(store:DistrictJobStore,cas:DistrictCas,key:string,original:z.infer<typeof CrawlCorpusImportSchema>){
 HashSchema.parse(key);
 if(original.documents.length!==1||original.documents[0].policyRefreshJobKey)throw Error('Refresh commitment requires the unchanged original selection');
 const selected=original.documents[0];
 const rows=await store.pool.query(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.job_key=$1 AND j.state='succeeded' AND j.step='policy_refresh' ORDER BY r.attempt DESC LIMIT 1`,[key]);
 if(rows.rowCount!==1)throw Error('Policy refresh is not committed');
 const row=rows.rows[0],selector=SelectorSchema.parse(row.spec.selector),receipt=encodeStepReceipt(row.receipt);
 if(canonicalJobIdentity(row.spec).jobKey!==key||receipt.sha256!==row.receipt_sha256||receipt.receipt.jobKey!==key||receipt.receipt.step!=='policy_refresh'||receipt.receipt.outputHashes.length!==1||selector.manifestSha256!==semanticHash(original))throw Error('Policy refresh receipt changes selected import');
 const hash=receipt.receipt.outputHashes[0],policy=corpusFixturePolicy();await assertManagedSourceReadable(join(cas.root,'sha256',hash.slice(0,2),hash),policy);
 const bytes=await cas.read(hash),result=z.object({version:z.literal(VERSION),manifestSha256:HashSchema,observations:z.array(z.object({path:z.string().min(1),sha256:HashSchema}).strict()).min(1).max(100),originalRobotsAbsence:OriginalRobotsAbsencePinSchema.optional(),previousRefresh:PreviousRefreshSchema.optional(),job:ResidualInputSchema}).strict().parse(JSON.parse(bytes.toString('utf8')));
 if(digest(bytes)!==hash||result.manifestSha256!==selector.manifestSha256||canonicalJson(result.previousRefresh??null)!==canonicalJson(selector.previousRefresh??null))throw Error('Policy refresh output binding differs');
 const proof=await loadPolicyReceipt(cas,result.job.policyReceiptSha256);
 await assertManagedSourceBindings(join(cas.root,'sha256',hash.slice(0,2),hash),[{kind:'http_observation',url:proof.source.url,sourceSha256:proof.source.sha256,...result.job.httpObservation}],policy);
 for(const observation of result.observations){await assertManagedObservationReadable(observation.path,policy);if(digest(await readFile(observation.path))!==observation.sha256)throw Error('Actual policy observation changed');}
 await assertCivicPolicyAuthority({...policy,authorityId:proof.authorityId,authoritySha256:proof.authoritySha256});
 if(!proof.sourcePolicy.robots.sha256&&!result.originalRobotsAbsence)throw Error('Hashless robots refresh lacks its authenticated original absence observation');
 if(result.originalRobotsAbsence){
  const original=result.originalRobotsAbsence;
  await assertManagedObservationReadable(original.path,policy);
  if(basename(original.path)!==original.observationId||digest(await readFile(original.path))!==original.receiptSha256)throw Error('Original robots absence observation changed');
 }
 if(result.job.documentId!==selected.documentId||result.job.corpusSha256!==original.index.sha256||canonicalJson(result.job.registry)!==canonicalJson(original.registry)||canonicalJson(result.job.crawlRegistry??null)!==canonicalJson(original.crawlRegistry??null)||semanticHash(proof.scope)!==semanticHash(selected.scope)||semanticHash(proof.permission)!==semanticHash(selected.permission)||semanticHash(result.job.bounds)!==semanticHash(selected.bounds))throw Error('Current proof changes original selection');
 if(residualOriginalIdentity(result.job)!==selector.originalIdentitySha256||receipt.receipt.versions.policyRefreshOriginal!==selector.originalIdentitySha256||receipt.receipt.versions.policyRefreshReceipt!==result.job.policyReceiptSha256)throw Error('Policy refresh receipt changes original/policy identity');
 return {job:result.job,selector,hash,receiptSha256:receipt.sha256,receiptId:receipt.receipt.id,dependencyReceiptIds:receipt.receipt.dependencyReceiptIds};
}
async function authenticatePreviousRefresh(store:DistrictJobStore,cas:DistrictCas,previous:z.infer<typeof PreviousRefreshSchema>,original:z.infer<typeof CrawlCorpusImportSchema>){
 const prior=await readPolicyRefreshCommit(store,cas,previous.jobKey,original);
 if(prior.receiptSha256!==previous.receiptSha256)throw Error('Previous refresh StepReceipt pin differs');
 return prior;
}
/** Only a real committed queue success with current source admission supplies proof. */
export async function readCommittedPolicyRefresh(store:DistrictJobStore,cas:DistrictCas,key:string,rawManifest:unknown){
 const manifest=CrawlCorpusImportSchema.parse(rawManifest);
 if(manifest.documents.length!==1||manifest.documents[0].policyRefreshJobKey!==key)throw Error('Refresh selection must name its committed job');
 const {policyRefreshJobKey,...selected}=manifest.documents[0],original={...manifest,documents:[selected]};
 const committed=await readPolicyRefreshCommit(store,cas,key,original);
 if(committed.selector.previousRefresh){
  const prior=await authenticatePreviousRefresh(store,cas,committed.selector.previousRefresh,original);
  if(!committed.dependencyReceiptIds.includes(prior.receiptId))throw Error('Refresh receipt omits its prior committed dependency');
 }
 await loadResidualSource(cas,committed.job);
 return committed.job;
}

type ResidualInput=z.infer<typeof ResidualInputSchema>;
export interface ResidualPolicyCheck extends PolicyRecheckResult {currentReceipt:PolicyReceipt;versions:Record<string,string>;continuation?:JobPolicyContinuation}
/** Exact immutable processing original; policy generations never alter this key. */
export function residualOriginalIdentity(input:ResidualInput|Omit<ResidualInput,'policyReceiptSha256'>){
 const {policyReceiptSha256,...original}=input as ResidualInput;
 return semanticHash(original);
}
export function recordedPolicyIdentity(policy:PolicyReceipt['sourcePolicy']){
 const {checkedAt,...robots}=policy.robots;
 const evidence=policy.tdm.evidence.map(row=>{
  if(row.locator!=='W3C TDMRep origin rules'&&row.locator!=='TDMRep matching location'&&!row.locator.startsWith('TDMRep standardized location HTTP absence'))return row;
  const {checkedAt,...fields}=row;return fields;
 });
 return semanticHash({...policy,robots,tdm:{...policy.tdm,evidence}});
}
/** Offline continuation only: no fetch, clock rewrite, receipt mutation or model
 * retry. A missing/expired/foreign/changed/held refresh remains a policy hold. */
export async function recheckResidualPolicy(store:DistrictJobStore|undefined,cas:DistrictCas,input:ResidualInput):Promise<ResidualPolicyCheck>{
 input=ResidualInputSchema.parse(input);
 const receipt=await loadPolicyReceipt(cas,input.policyReceiptSha256),policy={...corpusFixturePolicy(),authorityId:receipt.authorityId,authoritySha256:receipt.authoritySha256},evaluationAt=new Date().toISOString();
 if(Date.parse(receipt.expiresAt)>Date.now()){
  const checked=await recheckPolicyReceipt(receipt,{...policy,evaluationAt});
  return {...checked,currentReceipt:receipt,versions:{}};
 }
 if(!store||Date.parse(receipt.checkedAt)>Date.now())throw new DistrictExecutionHold('source_policy_stale');
 const identity=residualOriginalIdentity(input);
 const rows=await store.pool.query(`SELECT j.job_key,j.spec,r.outcome FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id WHERE j.step='policy_refresh' AND j.spec->'selector'->>'originalIdentitySha256'=$1 AND j.spec->'sourceScope'=$2::jsonb ORDER BY r.committed_at DESC,r.attempt DESC LIMIT 1`,[identity,canonicalJson(receipt.scope)]);
 if(rows.rowCount!==1||rows.rows[0].outcome!=='succeeded')throw new DistrictExecutionHold('source_policy_stale');
 try{
  const row=rows.rows[0],selector=SelectorSchema.parse(row.spec.selector),path=join(cas.root,'sha256',selector.manifestSha256.slice(0,2),selector.manifestSha256);
  await assertManagedSourceReadable(path,policy);
  const bytes=await cas.read(selector.manifestSha256),manifest=CrawlCorpusImportSchema.parse(JSON.parse(bytes.toString('utf8')));
  if(digest(bytes)!==selector.manifestSha256)throw Error('Refresh original manifest changed');
  const committed=await readPolicyRefreshCommit(store,cas,row.job_key,manifest);
  if(residualOriginalIdentity(committed.job)!==identity)throw Error('Refresh changes original custody');
  if(committed.selector.previousRefresh){
   const prior=await authenticatePreviousRefresh(store,cas,committed.selector.previousRefresh,manifest);
   if(!committed.dependencyReceiptIds.includes(prior.receiptId))throw Error('Refresh lineage changed');
  }
  const currentReceipt=await loadPolicyReceipt(cas,committed.job.policyReceiptSha256);
  if(Date.parse(currentReceipt.checkedAt)<=Date.parse(receipt.checkedAt)||semanticHash(currentReceipt.permission)!==semanticHash(receipt.permission)||recordedPolicyIdentity(currentReceipt.sourcePolicy)!==recordedPolicyIdentity(receipt.sourcePolicy))throw Error('Refresh changes recorded permission/policy');
  const checked=await recheckPolicyReceipt(receipt,{...policy,evaluationAt,currentProof:currentReceipt});
  const continuation={fromReceiptSha256:input.policyReceiptSha256,toReceiptSha256:committed.job.policyReceiptSha256,refreshStepReceiptSha256:committed.receiptSha256,refreshStepReceiptId:committed.receiptId,originalIdentitySha256:identity};
  return {...checked,currentReceipt,continuation,versions:policyContinuationVersions(continuation)};
 }catch(error){if(error instanceof CivicPolicyStateError)throw error;throw new DistrictExecutionHold('source_policy_stale');}
}
