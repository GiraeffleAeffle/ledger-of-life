import {readFile,lstat,realpath} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {z} from 'zod';
import {digest,ScopeSchema,HashSchema} from './district-adapter-contract.ts';
import {authorizedPilotCorpusSchema,loadFrozenCorpusBytes,corpusFixturePolicy,type CrawlDocument as ImportedDocument} from './district-corpus.ts';
import {operatorRegistryInputPinSchema,readOperatorRegistryInputPin,CrawlRegistryPinSchema,readCrawlOperatorRegistryInputPin} from './district-registry-config.ts';
import {SourceObservationSchema,sourceObservationMatches,readBoundSourceObservation} from './source-observation.ts';
import {HttpObservationProofSchema,authenticatedHttpBinding} from './district-http-observation.ts';
import {createPolicyReceipt,PolicyReceiptSchema} from './district-policy-receipt.ts';
import {ResidualInputSchema,ResidualBoundsSchema,residualMimeSupported} from './district-residual-jobs.ts';
import {CrawlRequestEvidenceSchema} from './district-crawl-request.ts';
import {persistOperatorRegistry,persistR1Representation} from './district-r1-state.ts';
import {assertCivicPolicyAuthority,assertManagedObservationReadable,assertManagedSourceReadable,assertManagedSourceBindings,initializeManagedAcquisitionLane,withManagedSourceWrite,CIVIC_ACQUISITION_DECISION_ID,type ManagedSourceBinding,type CivicPolicyOptions} from './civic-opt-out.ts';
import {R1_MUNICIPALITIES,type DistrictJobStore} from './district-jobs.ts';
import type {DistrictCas} from './district-cas.ts';
import {loadResidualSource} from './district-residual-jobs.ts';
import {readCommittedPolicyRefresh} from './district-policy-refresh.ts';
import type {BoundSourceObservation} from './source-observation.ts';
import type {DistrictRegistry} from './district-registry.ts';
import {sourcePolicyExpiresAt,registeredSourcePolicyApplies} from './source-policy.ts';
import {admittedRegisteredRobotsScopes,registeredRobotsAuditApplies,registeredRobotsEvidence,type RegisteredRobotsAudit} from './registered-source-policy.ts';
import {discoverDocumentLinks} from './district-source-adapters.ts';

export interface CrawlPolicyRefreshOperation {
 enqueue?:(manifest:z.infer<typeof CrawlCorpusImportSchema>,acquired:BoundSourceObservation,custody:{registrySha256:string;corpusObservations:z.infer<typeof ResidualInputSchema>['corpusObservations']})=>Promise<void>;
 refresh?:(acquired:BoundSourceObservation,source:DistrictRegistry['municipalities'][number]['sources'][number],registeredSourceEligibility?:RegisteredRobotsAudit)=>Promise<{sourcePolicy:BoundSourceObservation['policy'];expiresAt:string}>;
}

const observationPin=z.object({path:z.string().min(1),sha256:HashSchema}).strict();
export const CrawlCorpusImportSchema=z.object({
 index:z.object({path:z.string().min(1),sha256:authorizedPilotCorpusSchema}).strict(),rawRoot:z.string().min(1),registry:operatorRegistryInputPinSchema,crawlRegistry:CrawlRegistryPinSchema.optional(),
 observations:z.array(observationPin).min(1).max(10000),
 documents:z.array(z.object({documentId:z.string().min(1),scope:ScopeSchema,permission:PolicyReceiptSchema.shape.permission,bounds:z.lazy(()=>ResidualBoundsSchema),requestEvidence:observationPin.optional(),policyRefreshJobKey:HashSchema.optional()}).strict()).min(1).max(200),
}).strict().superRefine((input,ctx)=>{
 if(new Set(input.documents.map(row=>row.documentId)).size!==input.documents.length||new Set(input.observations.map(row=>row.path)).size!==input.observations.length)ctx.addIssue({code:'custom',message:'Import selections and original observation paths must be distinct'});
});
type HoldCode='corpus_ancestry_unavailable'|'scope_mismatch'|'original_observation_invalid'|'source_policy_stale'|'source_policy_refused'|'request_evidence_unavailable'|'unsupported_mime';
const MAX_IMPORTED_DISCOVERY_HOPS=32;
/** Reconstruct only byte-verified HTML edges in the authenticated frozen corpus.
 * A frontier/metadata parent URL is a lookup hint, never discovery authorization.
 * Multi-hop parents must reach a reviewed root/page through at most 32 such edges. */
function importedRegisteredPolicy(documents:readonly ImportedDocument[],rawRoot:string,policy:CivicPolicyOptions,observations:ReadonlyMap<string,{binding:BoundSourceObservation['binding'];observation:BoundSourceObservation['observation']}>){
 const byUrl=new Map<string,ImportedDocument|null>(),parents=new Map<string,Set<string>>();
 for(const document of documents)byUrl.set(document.url,byUrl.has(document.url)?null:document);
 return async(document:ImportedDocument,acquired:BoundSourceObservation,source:DistrictRegistry['municipalities'][number]['sources'][number],base:RegisteredRobotsAudit|undefined):Promise<BoundSourceObservation['policy']>=>{
  const original=acquired.policy;
  if(!base||registeredSourcePolicyApplies(original,document,{municipalityId:document.municipalityId,sourceId:document.sourceId,ags:document.ags},base))return original;
  const chain:Array<{child:ImportedDocument;parent:ImportedDocument}>=[],seen=new Set<string>();
  let child=document;
  try{
   while(child.url!==base.root&&!source.crawlScope?.pageRoots.includes(child.url)){
    if(chain.length>=MAX_IMPORTED_DISCOVERY_HOPS||seen.has(child.url))return original;
    seen.add(child.url);
    const from=child.metadata.discoveredFrom,parent=typeof from==='string'?byUrl.get(from):undefined;
    if(!parent||parent.municipalityId!==document.municipalityId||parent.ags!==document.ags||parent.districtId!==document.districtId||parent.sourceId!==document.sourceId||!/^(?:text\/html|application\/xhtml\+xml)$/.test(parent.mimeType))return original;
    let targets=parents.get(parent.url);
    if(!targets){
     const expected=parent.observationPath?observations.get(basename(parent.observationPath)):undefined;
     if(!expected||expected.observation.bytes>64*1024*1024)return original;
     const bound=await readBoundSourceObservation({rawRoot,document:parent,policy,registeredSource:source});
     if(JSON.stringify(expected.binding)!==JSON.stringify(bound.binding))return original;
     // Historical discovery need not be fresh, but its evidence clocks must be real.
     sourcePolicyExpiresAt(bound.policy,bound.observation.checkedAt,parent,{municipalityId:parent.municipalityId,sourceId:parent.sourceId,ags:parent.ags},base);
     targets=new Set(discoverDocumentLinks(bound.sourceBytes.toString('utf8'),parent.url).filter(link=>byUrl.has(link.url)).map(link=>link.url));
     parents.set(parent.url,targets);
    }
    if(!targets.has(child.url))return original;
    chain.push({child,parent});child=parent;
   }
  }catch{
   // Missing/changed/opted-out/reserved parent evidence cannot widen the old policy.
   return original;
  }
  let audit=base;
  for(let index=chain.length-1;index>=0;index--){
   const edge=chain[index],anchor=audit.discovery?.anchor??(audit.discovery?{url:audit.discovery.from,sha256:audit.discovery.sha256}:undefined);
   audit={...base,discovery:{from:edge.parent.url,sha256:edge.parent.sha256,...(anchor?{anchor}:{})}};
   if(!registeredRobotsAuditApplies(audit,edge.child.url))return original;
  }
  // Only this new R1 receipt policy gains the content-free decision. The original
  // observation and every existing policy clock stay byte-for-byte unchanged.
  return {...original,tdm:{...original.tdm,evidence:[registeredRobotsEvidence(audit,document.url,acquired.observation.checkedAt),...original.tdm.evidence]}};
 };
}
/** Default import is offline; the separate durable refresh path supplies explicit operations. */
export async function importCrawlCorpusForResidual(store:DistrictJobStore,cas:DistrictCas,rawInput:unknown,operation:CrawlPolicyRefreshOperation={}){
 const input=CrawlCorpusImportSchema.parse(rawInput),authority=await assertCivicPolicyAuthority(corpusFixturePolicy()),policy={...corpusFixturePolicy(),authorityId:authority.authorityId,authoritySha256:authority.authoritySha256};
 const migration=input.crawlRegistry?await readCrawlOperatorRegistryInputPin(input.crawlRegistry,input.registry,policy):undefined;
 const admitted=migration?.processing??await readOperatorRegistryInputPin(input.registry,policy),crawlBindings=migration?.crawl.bindings??admitted.bindings,rawRoot=await realpath(input.rawRoot);
 await assertManagedSourceReadable(input.index.path,policy);
 const indexStat=await lstat(input.index.path);if(!indexStat.isFile()||indexStat.isSymbolicLink()||indexStat.size>64*1024*1024)throw Error('Frozen corpus index file/bound rejected');
 const indexBytes=await readFile(input.index.path),corpus=loadFrozenCorpusBytes(indexBytes,input.index.sha256);
 if(corpus.documents.length+(corpus.excludedDocuments?.length??0)>10000)throw Error('Frozen corpus document bound exceeded');
 await assertManagedSourceBindings(input.index.path,crawlBindings,policy,'operator_registry_config');
 const holds:Array<{documentId:string;reasonCode:HoldCode}>=[],jobs:Array<z.infer<typeof ResidualInputSchema>>=[];
 const observations=new Map<string,{bytes:Buffer;observation:z.infer<typeof SourceObservationSchema>;binding:Extract<ManagedSourceBinding,{kind:'http_observation'}>}>();
 try{
  for(const pin of input.observations){
   const path=resolve(pin.path),name=basename(path),stat=await lstat(path);
   if(dirname(path)!==join(rawRoot,'observations')||!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024||await realpath(path)!==path)throw Error('Original observation location/bound rejected');
   await assertManagedObservationReadable(path,policy);
   const bytes=await readFile(path),observation=SourceObservationSchema.parse(JSON.parse(bytes.toString('utf8')));
   if(digest(bytes)!==pin.sha256)throw Error('Original observation pin differs');
   const binding:Extract<ManagedSourceBinding,{kind:'http_observation'}>={kind:'http_observation',url:observation.url,sourceSha256:observation.sha256,observationId:name,receiptSha256:pin.sha256};
   observations.set(name,{bytes,observation,binding});
  }
  for(const document of [...corpus.documents,...corpus.excludedDocuments??[]]){
   const evidence=document.observationPath?observations.get(basename(document.observationPath)):undefined;
   if(!evidence||resolve(document.observationPath!)!==join(rawRoot,'observations',evidence.binding.observationId)||!document.checkedAt||document.status===undefined||!sourceObservationMatches(evidence.observation,{...document,checkedAt:document.checkedAt,status:document.status,sizeBytes:'sizeBytes' in document?document.sizeBytes:evidence.observation.bytes,bodyState:'exclusion' in document?'excluded':'retained'}))throw Error('Full corpus original/negative ancestry is incomplete');
  }
  await assertManagedSourceBindings(input.index.path,[...crawlBindings,...[...observations.values()].map(row=>row.binding)],policy);
 }catch{
  // Never copy an index with only a selected subset of its actual dependencies.
  return {jobs,holds:input.documents.map(row=>({documentId:row.documentId,reasonCode:'corpus_ancestry_unavailable' as const})),coverage:{basis:'authenticated_imported_observations' as const,selected:input.documents.length,imported:0,held:input.documents.length,acquisitionStepReceipts:0}};
 }
 const registrySha256=await persistOperatorRegistry(store,cas,admitted,policy),corpusObservations=[...observations.values()].map(row=>row.binding);
 const registeredEligibility=admittedRegisteredRobotsScopes(admitted.registry,digest(admitted.bytes));
 const deriveRegisteredPolicy=importedRegisteredPolicy(corpus.documents,rawRoot,policy,observations);
 await initializeManagedAcquisitionLane(cas.root,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'artifacts'});
 // Preserve every exact observation, including excluded audit entries and discovery dependencies.
 for(const {bytes,binding} of observations.values()){
  const hash=binding.receiptSha256,artifact=await withManagedSourceWrite(cas.root,[{...binding,relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,independentAllowed:false}],()=>cas.put(bytes,{kind:'receipt',mimeType:'application/json'}),policy);
  await store.addArtifact(artifact);
 }
 await assertManagedSourceBindings(input.index.path,[...crawlBindings,...corpusObservations],policy);
 if(digest(await readFile(input.index.path))!==input.index.sha256)throw Error('Frozen corpus changed during import');
 const hash=input.index.sha256,indexArtifact=await withManagedSourceWrite(cas.root,[...(migration?crawlBindings:[]),...admitted.bindings,...corpusObservations].map(binding=>({...binding,relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,independentAllowed:false})),()=>cas.put(indexBytes,{kind:'derived',mimeType:'application/json'}),policy);
 await store.addArtifact(indexArtifact);
 for(const selected of input.documents){
  let reasonCode:HoldCode='scope_mismatch',committing=false,refreshing=false;
  try{
   const matches=corpus.documents.filter(row=>row.id===selected.documentId);if(matches.length!==1)throw Error('Selected ID must identify exactly one original');
   const document=matches[0],city=admitted.registry.municipalities.find(row=>row.id===selected.scope.municipalityId),source=city?.sources.find(row=>row.id===selected.scope.sourceId);
   if(!city||R1_MUNICIPALITIES[city.id]!==city.ags||city.ags!==selected.scope.ags||document.municipalityId!==city.id||document.ags!==city.ags||document.districtId!==city.districtId||!source?.url||source.id!==document.sourceId||source.checkState!=='checked')throw Error('Selected scope differs from registered original');
   const registeredSourceEligibility=registeredEligibility.find(row=>row.municipalityId===city.id&&row.sourceId===source.id&&row.ags===city.ags&&row.root===source.url);
   const roots=[source.url,...source.crawlScope?.pageRoots??[],...city.seedDocuments.filter(row=>row.sourceId===source.id).map(row=>row.url),...source.api?[source.api.url]:[]],origins=new Set(roots.map(url=>new URL(url).origin));
   if(!origins.has(new URL(document.url).origin))throw Error('Original URL lies outside registered source origins');
   reasonCode='unsupported_mime';if(!residualMimeSupported(document.mimeType))throw Error('Original MIME is unsupported');
   reasonCode='original_observation_invalid';
   if(resolve(dirname(resolve(input.index.path)),document.localPath)!==join(rawRoot,'sha256',document.sha256))throw Error('Frozen original path changes managed raw body');
   const acquired=await readBoundSourceObservation({rawRoot,document,policy,registeredSource:source}),evidence=observations.get(acquired.binding.observationId)!;
   if(digest(evidence.bytes)!==acquired.binding.receiptSha256)throw Error('Original observation changed');
   const httpObservation=HttpObservationProofSchema.parse({observationId:acquired.binding.observationId,receiptSha256:acquired.binding.receiptSha256,bytes:evidence.bytes.toString('utf8')});
   authenticatedHttpBinding(httpObservation,{url:document.url,sha256:document.sha256,mimeType:document.mimeType,retrievedAt:document.retrievedAt,fetchedAt:document.checkedAt});
   reasonCode='request_evidence_unavailable';
   if(!selected.requestEvidence)throw Error('Original request evidence is missing');
   const requestEvidencePath=resolve(selected.requestEvidence.path);
   if(requestEvidencePath!==join(rawRoot+'-request-evidence','requests',acquired.binding.observationId))throw Error('Original request evidence location differs');
   const requestStat=await lstat(requestEvidencePath);
   if(!requestStat.isFile()||requestStat.isSymbolicLink()||requestStat.size>1024*1024)throw Error('Original request evidence bound rejected');
   await assertManagedSourceBindings(requestEvidencePath,[acquired.binding],policy);
   const requestBytes=await readFile(requestEvidencePath),requestEvidence=CrawlRequestEvidenceSchema.parse(JSON.parse(requestBytes.toString('utf8')));
   if(digest(requestBytes)!==selected.requestEvidence.sha256||JSON.stringify(requestEvidence.httpObservation)!==JSON.stringify(acquired.binding))throw Error('Original request evidence binding changes');
   const {request,redirectChain}=requestEvidence;
   if(!request||!redirectChain||redirectChain[0]!==request.url||redirectChain.at(-1)!==document.url||redirectChain.some(url=>!origins.has(new URL(url).origin))||request.method==='POST'&&(request.publicSelector===null||request.bodySha256!==digest(request.publicSelector)))throw Error('Original request/redirect evidence cannot be recovered');
   reasonCode='source_policy_stale';
   const originalClocks=[acquired.observation.checkedAt,acquired.policy.robots.checkedAt,...acquired.policy.tdm.evidence.map(row=>row.checkedAt)];
   if(!acquired.policy.tdm.evidence.length||originalClocks.some(clock=>!clock||!Number.isFinite(Date.parse(clock))||Date.parse(clock)>Date.now()))throw Error('Original policy evidence clock is incomplete');
   if(operation.enqueue){
    if(selected.policyRefreshJobKey)throw Error('A refresh cannot refresh a previous refresh selection');
    committing=true;await operation.enqueue({...input,documents:[selected]},acquired,{registrySha256,corpusObservations});continue;
   }
   if(selected.policyRefreshJobKey){
    reasonCode='source_policy_stale';
    const job=await readCommittedPolicyRefresh(store,cas,selected.policyRefreshJobKey,{...input,documents:[selected]});
    await loadResidualSource(cas,job);jobs.push(job);continue;
   }
   reasonCode='source_policy_stale';
   let sourcePolicy=acquired.policy,expiresAt:string;
   if(operation.refresh){
    reasonCode='source_policy_refused';
    refreshing=true;const current=await operation.refresh(acquired,source,registeredSourceEligibility);refreshing=false;sourcePolicy=current.sourcePolicy;expiresAt=current.expiresAt;
   }else{
    sourcePolicy=await deriveRegisteredPolicy(document,acquired,source,registeredSourceEligibility);
    expiresAt=sourcePolicyExpiresAt(sourcePolicy,acquired.observation.checkedAt,document,selected.scope,registeredSourceEligibility);
   }
   if(Date.parse(expiresAt)<=Date.now())throw Error('Source policy is stale; separately authorized revalidation required');
   reasonCode='source_policy_refused';
   const proof=await createPolicyReceipt({source:{url:document.url,sha256:document.sha256,mimeType:document.mimeType},sourcePolicy,registeredSourceEligibility,permission:selected.permission,scope:selected.scope,checkedAt:new Date().toISOString(),expiresAt},policy);
   committing=true;
   const persisted=await persistR1Representation(store,cas,{bytes:acquired.sourceBytes,receipt:proof.receipt,request:{url:request.url,method:request.method,body:request.publicSelector,contentType:request.contentType},retrievedAt:document.retrievedAt,fetchedAt:acquired.observation.checkedAt,sourceVersion:null,redirectChain,httpObservation:{observationId:httpObservation.observationId,receiptSha256:httpObservation.receiptSha256,bytes:evidence.bytes},origin:'imported'},policy);
   const requestHash=selected.requestEvidence.sha256,requestArtifact=await withManagedSourceWrite(cas.root,[{...acquired.binding,relativePath:`sha256/${requestHash.slice(0,2)}/${requestHash}`,contentSha256:requestHash,independentAllowed:false}],()=>cas.put(requestBytes,{kind:'receipt',mimeType:'application/json'}),policy);await store.addArtifact(requestArtifact);
   jobs.push(ResidualInputSchema.parse({documentId:document.id,corpusSha256:input.index.sha256,corpusObservations,registrySha256,registry:input.registry,...(input.crawlRegistry?{crawlRegistry:input.crawlRegistry}:{}),policyReceiptSha256:persisted.receiptSha256,httpObservation:persisted.httpObservation,requestEvidenceSha256:requestArtifact.sha256,bounds:selected.bounds}));
  }catch(error){if(committing||refreshing)throw error;holds.push({documentId:selected.documentId,reasonCode});}
 }
 return {jobs,holds,coverage:{basis:'authenticated_imported_observations' as const,selected:input.documents.length,imported:jobs.length,held:holds.length,acquisitionStepReceipts:0}};
}
