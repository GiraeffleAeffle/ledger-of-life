import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {HashSchema,ScopeSchema,canonicalJson,digest,semanticHash} from './district-adapter-contract.ts';
import {CrawlCorpusImportSchema,importCrawlCorpusForResidual} from './district-crawl-import.ts';
import {ResidualInputSchema,loadResidualSource} from './district-residual-jobs.ts';
import {corpusFixturePolicy} from './district-corpus.ts';
import {DistrictJobStore,canonicalJobIdentity,DistrictExecutionHold,type JobHandler} from './district-jobs.ts';
import {encodeStepReceipt} from './district-step-receipt.ts';
import {loadPolicyReceipt,recheckPolicyReceipt} from './district-policy-receipt.ts';
import {assertCivicPolicyAuthority,assertManagedSourceReadable,assertManagedSourceBindings,assertManagedObservationReadable,withManagedSourceWrite,initializeManagedAcquisitionLane,CIVIC_ACQUISITION_DECISION_ID,HostOptedOutError} from './civic-opt-out.ts';
import type {DistrictCas} from './district-cas.ts';
import type {PoliteFetcher} from './polite-fetch.ts';
import {acquisitionFailureReason} from './district-r1.ts';

const VERSION='district-policy-refresh-v1';
const SelectorSchema=z.object({version:z.literal(VERSION),manifestSha256:HashSchema,scope:ScopeSchema,maxRequests:z.number().int().min(2).max(100)}).strict();
export async function policyRefreshContract(){
 const files=['district-policy-refresh.ts','district-crawl-import.ts','district-residual-jobs.ts','district-registry-config.ts','district-r1.ts','polite-fetch.ts','district-policy-receipt.ts','source-policy.ts','civic-opt-out.ts'];
 return semanticHash({version:VERSION,files:await Promise.all(files.map(async file=>({file,sha256:digest(await readFile(new URL(file,import.meta.url)))}))),hostGroupsSha256:digest(await readFile(new URL('../sources/district-host-groups.json',import.meta.url)))});
}
/** Preflight is offline and may admit stale originals only for this network job.
 * It does not admit them to preparation or models and grants no fetch approval. */
export async function enqueueCrawlPolicyRefresh(store:DistrictJobStore,cas:DistrictCas,raw:unknown){
 const {manifest,maxRequests}=z.object({manifest:CrawlCorpusImportSchema,maxRequests:SelectorSchema.shape.maxRequests}).strict().parse(raw);
 if(manifest.documents.some(row=>row.policyRefreshJobKey))throw Error('Refresh enqueue cannot consume a previous refresh');
 const contract=await policyRefreshContract(),policy=corpusFixturePolicy(),jobKeys:Array<{documentId:string;jobKey:string}>=[];
 const result=await importCrawlCorpusForResidual(store,cas,manifest,{enqueue:async(input,acquired)=>{
  const bytes=Buffer.from(canonicalJson(input)),hash=digest(bytes),relativePath=`sha256/${hash.slice(0,2)}/${hash}`;
  const artifact=await withManagedSourceWrite(cas.root,[{...acquired.binding,relativePath,contentSha256:hash,independentAllowed:false}],()=>cas.put(bytes,{kind:'derived',mimeType:'application/json'}),policy);
  await store.addArtifact(artifact);
  const selected=input.documents[0],selector=SelectorSchema.parse({version:VERSION,manifestSha256:hash,scope:selected.scope,maxRequests});
  const jobKey=await store.enqueue({step:'policy_refresh',lane:'public_policy_refresh',semanticContractSha256:contract,inputArtifactHashes:[hash,input.index.sha256,...input.observations.map(row=>row.sha256)],sourceScope:selected.scope,selector,policyProofSha256:null},{reservedMicroUsd:0});
  jobKeys.push({documentId:selected.documentId,jobKey});
 }});
 return {jobKeys,holds:result.holds,coverage:{basis:'policy_refresh_preflight' as const,selected:manifest.documents.length,enqueued:jobKeys.length,held:result.holds.length}};
}
export function policyRefreshHandler(store:DistrictJobStore,createFetcher:(context:Parameters<JobHandler>[0],maxRequests:number)=>Promise<PoliteFetcher>):JobHandler{return async context=>{
 const selector=SelectorSchema.parse(context.job.spec.selector),contract=await policyRefreshContract(),policy=corpusFixturePolicy();
 if(context.job.spec.step!=='policy_refresh'||context.job.spec.semanticContractSha256!==contract||semanticHash(context.job.spec.sourceScope)!==semanticHash(selector.scope)||context.job.spec.policyProofSha256!==null)throw Error('Policy refresh job contract differs');
 try{
  const path=join(context.cas.root,'sha256',selector.manifestSha256.slice(0,2),selector.manifestSha256);
  await assertManagedSourceReadable(path,policy);
  const bytes=await context.cas.read(selector.manifestSha256),manifest=CrawlCorpusImportSchema.parse(JSON.parse(bytes.toString('utf8')));
  if(digest(bytes)!==selector.manifestSha256||manifest.documents.length!==1||manifest.documents[0].policyRefreshJobKey||semanticHash(manifest.documents[0].scope)!==semanticHash(selector.scope))throw Error('Policy refresh manifest differs');
  const fetcher=await createFetcher(context,selector.maxRequests),observations:Array<{path:string;sha256:string}>=[];
  const result=await importCrawlCorpusForResidual(store,context.cas,manifest,{refresh:async(acquired,source)=>{
   context.signal.throwIfAborted();await assertManagedSourceBindings(path,[acquired.binding],policy);
   const current=await fetcher.refreshPolicyForOriginal({url:acquired.observation.url,sha256:acquired.observation.sha256},acquired.policy,{machinePolicyUrls:source.knownMachinePolicyUrls});
   for(const path of current.observations){await assertManagedObservationReadable(path,policy);const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Policy observation bound rejected');observations.push({path,sha256:digest(await readFile(path))});}
   context.signal.throwIfAborted();return current;
  }});
  if(result.jobs.length!==1)return {outcome:'blocked_policy',reasonCode:result.holds[0]?.reasonCode==='source_policy_stale'?'policy_expired':'source_policy_refused',versions:{policyRefresh:contract}};
  const job=result.jobs[0],loaded=await loadResidualSource(context.cas,job);
  if(!observations.length)throw Error('Refresh lacks actual current observations');
  const output={version:VERSION,manifestSha256:selector.manifestSha256,observations,job},outputBytes=Buffer.from(canonicalJson(output)),hash=digest(outputBytes);
  await initializeManagedAcquisitionLane(context.cas.root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
  const artifact=await withManagedSourceWrite(context.cas.root,[{...loaded.sourceBinding,relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,independentAllowed:false}],()=>context.cas.put(outputBytes,{kind:'derived',mimeType:'application/json'}),policy);
  await store.addArtifact(artifact);context.signal.throwIfAborted();await recheckPolicyReceipt(loaded.receipt,{...policy,evaluationAt:new Date().toISOString()});
  return {outcome:'succeeded',reasonCode:'completed',outputs:[artifact],versions:{policyRefresh:contract},counts:{bytes:outputBytes.length}};
 }catch(error){
  context.signal.throwIfAborted();if(error instanceof DistrictExecutionHold)throw error;
  const reason=error instanceof HostOptedOutError?'policy_excluded':acquisitionFailureReason(error);
  if(reason&&reason!=='execution_exception')return {outcome:reason==='policy_excluded'||reason==='source_policy_refused'?'blocked_policy':'held_execution',reasonCode:reason,versions:{policyRefresh:contract}};
  throw error;
 }
};}
/** Only a real committed queue success can supply a replacement proof. */
export async function readCommittedPolicyRefresh(store:DistrictJobStore,cas:DistrictCas,key:string,rawManifest:unknown){
 HashSchema.parse(key);
 const manifest=CrawlCorpusImportSchema.parse(rawManifest);
 if(manifest.documents.length!==1||manifest.documents[0].policyRefreshJobKey!==key)throw Error('Refresh selection must name its committed job');
 const {policyRefreshJobKey,...selected}=manifest.documents[0],original={...manifest,documents:[selected]};
 const rows=await store.pool.query(`SELECT j.spec,r.receipt,r.receipt_sha256 FROM district_pipeline.jobs j JOIN district_pipeline.step_receipts r ON r.job_id=j.id AND r.outcome=j.state WHERE j.job_key=$1 AND j.state='succeeded' AND j.step='policy_refresh' ORDER BY r.attempt DESC LIMIT 1`,[key]);
 if(rows.rowCount!==1)throw Error('Policy refresh is not committed');
 const row=rows.rows[0],selector=SelectorSchema.parse(row.spec.selector),receipt=encodeStepReceipt(row.receipt);
 if(canonicalJobIdentity(row.spec).jobKey!==key||receipt.sha256!==row.receipt_sha256||receipt.receipt.jobKey!==key||receipt.receipt.step!=='policy_refresh'||receipt.receipt.outputHashes.length!==1||selector.manifestSha256!==semanticHash(original))throw Error('Policy refresh receipt changes selected import');
 const hash=receipt.receipt.outputHashes[0],policy=corpusFixturePolicy();await assertManagedSourceReadable(join(cas.root,'sha256',hash.slice(0,2),hash),policy);
 const bytes=await cas.read(hash),result=z.object({version:z.literal(VERSION),manifestSha256:HashSchema,observations:z.array(z.object({path:z.string().min(1),sha256:HashSchema}).strict()).min(1).max(100),job:ResidualInputSchema}).strict().parse(JSON.parse(bytes.toString('utf8')));
 if(digest(bytes)!==hash||result.manifestSha256!==selector.manifestSha256)throw Error('Policy refresh output binding differs');
 const source=await loadResidualSource(cas,result.job);await assertManagedSourceBindings(join(cas.root,'sha256',hash.slice(0,2),hash),[source.sourceBinding],policy);
 for(const observation of result.observations){await assertManagedObservationReadable(observation.path,policy);if(digest(await readFile(observation.path))!==observation.sha256)throw Error('Actual policy observation changed');}
 const proof=await loadPolicyReceipt(cas,result.job.policyReceiptSha256);await assertCivicPolicyAuthority({...policy,authorityId:proof.authorityId,authoritySha256:proof.authoritySha256});
 if(result.job.documentId!==selected.documentId||result.job.corpusSha256!==original.index.sha256||canonicalJson(result.job.registry)!==canonicalJson(original.registry)||canonicalJson(result.job.crawlRegistry??null)!==canonicalJson(original.crawlRegistry??null)||semanticHash(proof.scope)!==semanticHash(selected.scope)||semanticHash(proof.permission)!==semanticHash(selected.permission)||semanticHash(result.job.bounds)!==semanticHash(selected.bounds))throw Error('Current proof changes original selection');
 return result.job;
}
