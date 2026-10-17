import assert from 'node:assert/strict';
import {readFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import type {TestContext} from 'node:test';
import type {Pool} from 'pg';
import type {DistrictCas} from '../../src/district-cas.ts';
import {DistrictJobStore,runDistrictJobs} from '../../src/district-jobs.ts';
import {digest,canonicalJson,semanticHash,observation,type AdapterScope} from '../../src/district-adapter-contract.ts';
import type {CivicPolicyOptions} from '../../src/civic-opt-out.ts';
import {writeManagedSourceArtifact,type SourceArtifactBinding} from '../../src/district-private-io.ts';
import {admitStructuredObservations} from '../../src/district-structured-record.ts';
import {STRUCTURED_WORKER_VERSION} from '../../src/district-structured-parser-worker.ts';
import {StructuredJobResultSchema} from '../../src/district-structured-jobs.ts';
import {privatePublicationProvenanceSchema} from '../../src/district-publication-provenance.ts';
import {runStep8,step8ReadPlan,Step8InputSchema} from '../../src/r1-step8.ts';
import {verifyDataRelease} from '../../src/data-release.ts';
import {root,cacheDir} from '../../src/common.ts';
import {readCommittedReleaseFile} from '../../src/district-publication-predecessor.ts';
import {districtRegistrySchema} from '../../src/district-registry.ts';
import {authenticateStep8Campaign} from '../../src/r1-step8-governance.ts';
import {userInfo} from 'node:os';
import type {TerminalDocumentException,TerminalAssessmentException} from '../../src/district-terminal-exceptions.ts';
import {auditStep8} from '../../src/r1-step8-audit.ts';
import {assessmentQueueContract} from '../../src/district-assessment-jobs.ts';
import {assessmentBJobContract} from '../../src/district-assessment-broker.ts';
import {OMP_NATIVE_STREAM_VERSION,ompRunnerContractSha256,ompRunnerOutputContractSha256} from '../../src/district-omp-b-runner.ts';

/** Synthetic admitted text/native queue + authentic retained 0.3.2 core. No live
 * facts, independent assessments or production writes are claimed by this test. */
export async function exerciseStep8(t:TestContext,input:{pool:Pool;cas:DistrictCas;policy:CivicPolicyOptions;fixtureRoot:string;sealed:{privateProvenance:{path:string;sha256:string};artifacts:{registry:{path:string;sha256:string};crawl:{path:string;sha256:string}}};legacyGeneration?:{sealed:unknown;reconcileKey:string};jobKey:string;reconcileKey:string;documentJobKeys?:Record<string,string>;sealInput?:{jobKeys:string[];reconciliationJobKeys:string[];terminalDocumentExceptions?:TerminalDocumentException[];terminalAssessmentExceptions?:TerminalAssessmentException[]};expectedTextRecords?:number;expectedAssessments?:number;expectDatedSliceHold?:boolean;scope:AdapterScope;binding:SourceArtifactBinding;policyReceiptSha256:string;body:Buffer;retrievedAt:string}){
 const {pool,cas,policy,sealed,scope,binding,body}=input,store=new DistrictJobStore(pool),fixtureRoot=join(input.fixtureRoot,'step8-inputs');
 if(binding.kind!=='http_observation')throw Error('Step8 fixture requires its actual original HTTP binding');
 const municipality=districtRegistrySchema.parse(JSON.parse((await cas.read(sealed.artifacts.registry.sha256)).toString('utf8'))).municipalities.find(city=>city.id===scope.municipalityId);
 assert.ok(municipality);
 const put=async(value:unknown)=>{
  const bytes=Buffer.from(canonicalJson(value)),sha256=digest(bytes),path=join(cas.root,'sha256',sha256.slice(0,2),sha256);
  await writeManagedSourceArtifact(cas.root,path,bytes,[binding],{...policy,decisionId:'owner-2026-10-11-public-civic-sources',kind:'artifacts'});
  const artifact={sha256,byteLength:bytes.length,kind:'parser_output' as const,mimeType:'application/json',storageKey:`sha256/${sha256.slice(0,2)}/${sha256}`};await store.addArtifact(artifact);return artifact;
 };
 const coverage={state:'complete' as const,scope:'Synthetic one-document native fixture',reason:'Exact source byte count; not municipal coverage',checkedAt:input.retrievedAt,nextCursor:null,observedRows:2,limitations:['Synthetic native adapter; not operational K1/K2 evidence']};
 const reference=/Stand: (\d{2})\.(\d{2})\.(\d{4})/.exec(body.toString('utf8'));assert.ok(reference,'native fixture requires its actual source-explicit reference date');
 const native=observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId:'synthetic-byte-count',nativeVersion:null,kind:'SourceObservation',subject:'Synthetic fixture document',predicate:'fixture_byte_length',value:body.length,unit:'bytes',date:null,dateRole:null,financialRole:'none',geography:{ags:scope.ags,basis:'source_explicit',role:'administrative_area'},sourceReferenceDate:`${reference[3]}-${reference[2]}-${reference[1]}`,publishedAt:null,retrievedAt:input.retrievedAt,evidence:[{sourceSha256:binding.sourceSha256!,format:'html',nativeId:'synthetic-byte-count',path:'/synthetic/document/byteLength',sheet:null,rowKey:null,cells:[],rawValue:body.length,schemaHash:digest('synthetic byte-count schema'),mappingVersion:'synthetic-byte-count-v1'},{sourceSha256:binding.sourceSha256!,format:'html',nativeId:'synthetic-byte-count',path:'/synthetic/document/Stand',sheet:null,rowKey:null,cells:[],rawValue:reference[0],schemaHash:digest('synthetic byte-count schema'),mappingVersion:'synthetic-byte-count-v1'}],limitations:['Synthetic byte-count test only; reference date is the source-explicit Stand field, not retrieval or an inferred action date']});
 const {id:_nativeId,...nativeInput}=native,undated=observation({...nativeInput,nativeId:'synthetic-undated-byte-count',sourceReferenceDate:null,evidence:native.evidence.filter(locator=>locator.path.endsWith('/byteLength')).map(locator=>({...locator,nativeId:'synthetic-undated-byte-count'}))}),observations=[native,undated];
 const snapshot={bytes:body,sourceSha256:binding.sourceSha256!,url:binding.url,mimeType:'text/plain',retrievedAt:input.retrievedAt,policyReceiptSha256:input.policyReceiptSha256,sourceVersion:null};
 const adapter={id:'synthetic-byte-count',version:'synthetic-byte-count-v1'},adapterContractSha256=digest('synthetic native contract');
 const records=await admitStructuredObservations({adapter,adapterContractSha256,snapshot,scope,districtId:municipality.districtId,candidates:observations,replayInSandbox:async()=>({observations,coverage}),checkCurrentPolicy:async()=>({allowed:true,receiptSha256:input.policyReceiptSha256,sourceSha256:snapshot.sourceSha256,scopeSha256:semanticHash(scope),checkedAt:input.retrievedAt})});
 assert.equal(records.length,2);
 const result=StructuredJobResultSchema.parse({schemaVersion:'district-structured-job-result-v2',requestSha256:digest('synthetic native request'),adapterId:adapter.id,adapterVersion:adapter.version,adapterContractSha256,parserContractSha256:digest('synthetic parser contract'),mappingContractSha256:digest('synthetic mapping contract'),scope,sourceSha256:snapshot.sourceSha256,policyReceiptSha256:input.policyReceiptSha256,supportingSources:[],result:{observations,coverage},page:null,records,unpublishedObservations:0});
 const httpBinding={kind:'http_observation' as const,url:binding.url,sourceSha256:binding.sourceSha256!,observationId:binding.observationId,receiptSha256:binding.receiptSha256};
 const artifact=await put(result),job=await store.enqueue({step:'structured_parse',lane:'cpu',semanticContractSha256:digest('synthetic native job'),inputArtifactHashes:[snapshot.sourceSha256,input.policyReceiptSha256,httpBinding.receiptSha256],sourceScope:scope,selector:{fixture:'step8-native-byte-count',sourceBindings:[httpBinding]},policyProofSha256:input.policyReceiptSha256});
 const authorizationId=await store.authorize({approvalSha256:digest('synthetic step8 native authorization '+fixtureRoot),approvedBy:'synthetic-fixture',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[job],ags:[scope.ags],maxJobs:1,maxElapsedMs:60000,category:'development'});
 const run=await runDistrictJobs({store,cas,authorizationId,ownerPresent:true,maxJobs:1,maxElapsedMs:60000,handlers:{structured_parse:async()=>({outcome:'succeeded',reasonCode:'completed',outputs:[artifact],versions:{worker:STRUCTURED_WORKER_VERSION,adapter:adapter.version,parser:result.parserContractSha256,mapping:result.mappingContractSha256},counts:{rows:2,acceptedFacts:2,heldFacts:0,distinctCases:0}})}});
 assert.equal(run.state,'completed');
 const nativeReceipt=(await pool.query('SELECT receipt FROM district_pipeline.step_receipts WHERE receipt->>\'jobKey\'=$1',[job])).rows[0].receipt;
 const priorRelease={gitCommit:'57bddbbd8b84b0634229ad9cd45b689bda7271ea',directory:'release' as const,manifestSha256:'85b9236328402364ee1211ffe274933d3eaf0ff52c976a39720920337cc866b8',releaseId:'4ceebf75374df54c51bcf4a212c73770186a1a6db502423be7f108b665096691'};
 const originalCatalogue=JSON.parse((await readCommittedReleaseFile(priorRelease.gitCommit,'catalogue.json',undefined,'release')).toString('utf8'));
 const originalCollection=JSON.parse((await readCommittedReleaseFile(priorRelease.gitCommit,'cities/strausberg/signals.geojson',undefined,'release')).toString('utf8'));
 const coreBytes=await readCommittedReleaseFile(priorRelease.gitCommit,'core/strausberg-facts.json',undefined,'release'),core=JSON.parse(coreBytes.toString('utf8')),coreIds=new Set(core.facts.map((fact:{id:string})=>fact.id));
 const collection={type:'FeatureCollection',features:originalCollection.features.filter((feature:{properties:{id:string}})=>coreIds.has(feature.properties.id))};
 const clock=new Date().toISOString(),catalogue={...originalCatalogue,generatedAt:clock,cities:originalCatalogue.cities.filter((city:{id:string})=>city.id==='strausberg').map((city:Record<string,unknown>)=>({...city,sources:[]}))};
 const stageValues=new Map<string,Buffer>([
  ['catalogue.json',Buffer.from(JSON.stringify(catalogue))],['cities/strausberg/signals.geojson',Buffer.from(JSON.stringify(collection))],['cities/strausberg/feed.json',Buffer.from(JSON.stringify({schemaVersion:'stadtstack-feed-v1',cityId:'strausberg',generatedAt:clock,sources:[],items:[]}))],
  ['regions/brandenburg-mol/topics.json',Buffer.from(JSON.stringify({schemaVersion:'stadtstack-regional-topics-v1',generatedAt:clock,asOf:clock.slice(0,10),region:{id:'brandenburg-mol',name:'Synthetic regional fixture'},coverage:{},municipalities:[],topics:[]}))],['core/strausberg-facts.json',coreBytes],
 ]);
 const provenance=privatePublicationProvenanceSchema.parse(JSON.parse((await cas.read(sealed.privateProvenance.sha256)).toString('utf8'))),staging=[];
 for(const [destination,bytes] of stageValues){const path=join(fixtureRoot,destination),sha256=await writeManagedSourceArtifact(fixtureRoot,path,bytes,[binding],{...policy,decisionId:'owner-2026-10-11-public-civic-sources',kind:'artifacts'});provenance.inputs.push({path,sha256,bytes:bytes.length,bindings:[binding]});staging.push({destination,path,sha256});}
 const corpus=JSON.parse((await cas.read(sealed.artifacts.crawl.sha256)).toString('utf8')),campaignBytes=Buffer.from(canonicalJson({schemaVersion:'stadtstack-r1-step8-campaign-v1',sources:[{municipalityId:scope.municipalityId,sourceId:scope.sourceId,corpus:sealed.artifacts.crawl,documents:corpus.documents.map((document:{id:string;sha256:string})=>({documentId:document.id,sha256:document.sha256,jobKey:input.documentJobKeys?.[document.id]??input.jobKey}))}]})),campaignPath=join(fixtureRoot,'campaign.json');
 const campaignSha256=await writeManagedSourceArtifact(fixtureRoot,campaignPath,campaignBytes,[{...binding,independentAllowed:false}],{...policy,decisionId:'owner-2026-10-11-public-civic-sources',kind:'artifacts'});provenance.inputs.push({path:campaignPath,sha256:campaignSha256,bytes:campaignBytes.length,bindings:[{...binding,independentAllowed:false}]});
 const campaignRaw=JSON.parse(campaignBytes.toString('utf8'));await assert.rejects(authenticateStep8Campaign({...campaignRaw,sources:[...campaignRaw.sources,{...campaignRaw.sources[0],corpus:{...campaignRaw.sources[0].corpus,sha256:'b'.repeat(64)}}]},path=>readFile(path),policy),/Duplicate campaign source identity/);
 const control=async(name:string,value:unknown)=>{const path=join(fixtureRoot,name),bytes=Buffer.from(canonicalJson(value)),sha256=await writeManagedSourceArtifact(fixtureRoot,path,bytes,[binding],{...policy,decisionId:'owner-2026-10-11-public-civic-sources',kind:'artifacts'});return {path,sha256};};
 const processingCommit='a'.repeat(40),queueContract=await assessmentQueueContract(),BContract=await assessmentBJobContract(),runnerContractSha256=await ompRunnerContractSha256(),runnerOutputContractSha256=await ompRunnerOutputContractSha256();
 const processingReview=await control('processing-review.json',{activation:'confirmed',to:{commit:processingCommit},contracts:{current:{assessmentQueue:queueContract},assessmentBJobContract:BContract,ompRunnerContract:runnerContractSha256,ompRunnerOutputContract:runnerOutputContractSha256}});
 const activeCatalogue=await control('active-catalogue.json',{processingCodeRevision:processingCommit.slice(0,7),processingPinReview:processingReview,rows:[{scope,originals:corpus.documents.map((document:{id:string;sha256:string})=>({documentId:document.id,sha256:document.sha256}))}]});
 const currentGeneration={processingCommit,catalogue:activeCatalogue,processingReview,assessmentQueueContractSha256:queueContract,projectionVersion:'assessment-source-record-v2',B:{jobContractSha256:BContract,runnerContractSha256,runnerOutputContractSha256,nativeStreamVersion:OMP_NATIVE_STREAM_VERSION,thinking:'medium',receiptVersion:'assessment-receipt-v2',selector:'anthropic/claude-sonnet-5-5',transport:'vm-omp'}};
 const provenanceBytes=Buffer.from(canonicalJson(provenance)),provenancePath=join(fixtureRoot,'provenance.json');await writeManagedSourceArtifact(fixtureRoot,provenancePath,provenanceBytes,[{...binding,independentAllowed:false}],{...policy,decisionId:'owner-2026-10-11-public-civic-sources',kind:'artifacts'});
 const sealBytes=Buffer.from(canonicalJson(sealed)),sealPath=join(fixtureRoot,'seal-result.json');await writeManagedSourceArtifact(fixtureRoot,sealPath,sealBytes,[{...binding,independentAllowed:false}],{...policy,decisionId:'owner-2026-10-11-public-civic-sources',kind:'artifacts'});
 const legacySealPin=input.legacyGeneration?await control('historical-haiku-seal-result.json',input.legacyGeneration.sealed):undefined;
 await mkdir(cacheDir,{recursive:true});const outputRoot=join(cacheDir,'step8-fixture-'+randomUUID());t.after(async()=>{for(const path of [outputRoot,outputRoot+'.claim',outputRoot+'-preparation',outputRoot+'-replay'])await rm(path,{recursive:true,force:true});});
 const manifest=Step8InputSchema.parse({schemaVersion:'stadtstack-r1-step8-v1',currentGeneration,campaign:{path:campaignPath,sha256:campaignSha256},expectedSources:1,expectedDocuments:corpus.documents.length,seals:[{sealResult:{path:sealPath,sha256:digest(sealBytes)},...(input.sealInput??{jobKeys:[input.jobKey],reconciliationJobKeys:[input.reconcileKey]})}],structuredRunIds:[nativeReceipt.runId],registry:sealed.artifacts.registry,privateProvenance:{path:provenancePath,sha256:digest(provenanceBytes)},staging,priorRelease,asOf:clock.slice(0,10),clocks:{recordsGeneratedAt:clock,quarantineGeneratedAt:clock,coverageGeneratedAt:clock,qualityGeneratedAt:clock,manifestGeneratedAt:clock},casRoot:cas.root,outputRoot,policy});
 assert.deepEqual(step8ReadPlan(manifest).writes,[]);
 const oldDatabase=process.env.DATABASE_URL;process.env.DATABASE_URL=pool.options.connectionString!.replace('postgresql:///','postgresql://'+encodeURIComponent(userInfo().username)+'@/');
 // Deliberate phase boundary: setup/extraction have completed. Exercise the
 // complete build/replay/gate under the operator's actual offline bootstrap.
 createRequire(import.meta.url)('../../scripts/r1-step8-offline.cjs');
 try{
  const inventoryBefore=await readFile(join(policy.stateDir!,'inventory.json')),counts=()=>pool.query('SELECT (SELECT count(*) FROM district_pipeline.jobs) AS jobs,(SELECT count(*) FROM district_pipeline.step_receipts) AS receipts,(SELECT count(*) FROM district_pipeline.artifacts) AS artifacts,(SELECT count(*) FROM district_pipeline.r1_codex_call_intents) AS intents,(SELECT count(*) FROM district_pipeline.assessment_bridge_leases) AS leases');
  const beforeCounts=(await counts()).rows,preflight=await auditStep8(manifest,pool);
  assert.equal(preflight.status,'compatible',JSON.stringify(preflight.blockers));assert.deepEqual(preflight.writes,[]);assert.equal(preflight.publicationExecuted,false);
  assert.deepEqual(await readFile(join(policy.stateDir!,'inventory.json')),inventoryBefore);assert.deepEqual((await counts()).rows,beforeCounts);await assert.rejects(readFile(join(outputRoot,'release-gate.json')),{code:'ENOENT'});
  if(legacySealPin&&input.legacyGeneration){
   const legacy=Step8InputSchema.parse({...manifest,seals:[{sealResult:legacySealPin,jobKeys:[input.jobKey],reconciliationJobKeys:[input.legacyGeneration.reconcileKey]}]});
   const rejected=await auditStep8(legacy,pool);assert.equal(rejected.status,'blocked');assert.ok(rejected.blockers.some(entry=>/native Sonnet profile/.test(entry.message)),JSON.stringify(rejected.blockers));
   await assert.rejects(runStep8(legacy,pool),/generation audit blocked/);await assert.rejects(readFile(outputRoot),{code:'ENOENT'});
   assert.deepEqual(await readFile(join(policy.stateDir!,'inventory.json')),inventoryBefore);assert.deepEqual((await counts()).rows,beforeCounts);
  }
  if(input.expectDatedSliceHold){await assert.rejects(runStep8(manifest,pool),/Dated, source-staged slice incomplete/);const inventory=JSON.parse(await readFile(join(outputRoot,'source-dispositions.json'),'utf8'));assert.equal(inventory.status,'authenticated_not_released');assert.equal(inventory.complete,true);assert.equal(inventory.sourceDispositions.length,1);for(const pin of input.sealInput?.terminalDocumentExceptions??[]){const disposition=inventory.sourceDispositions.find((entry:{documentId:string})=>entry.documentId===pin.documentId);assert.deepEqual(disposition.admittedRecordIds,[]);assert.equal(disposition.classification.terminal,true);assert.equal(disposition.terminalDocumentException.receiptSha256,pin.receiptSha256);assert.equal(disposition.terminalDocumentException.attemptHistory.length,3);}await assert.rejects(readFile(join(outputRoot,'release-gate.json')),{code:'ENOENT'});return;}
  const gate=await runStep8(manifest,pool);assert.equal(gate.status,'passed');assert.equal(gate.knowledgeRecords,1+(input.expectedTextRecords??1));assert.equal(gate.valueAccepted,false);assert.equal(gate.hostedReleaseAuthorized,false);
  const release=await verifyDataRelease(gate.candidateDirectory),proof=JSON.parse(await readFile(join(outputRoot,'replay-proof.json'),'utf8'));
  assert.equal(release.id,gate.releaseId);assert.equal(proof.comparison.releaseId,release.id);assert.equal(proof.comparison.manifestSha256,gate.manifestSha256);assert.deepEqual(proof.comparison.files,release.files);
  const receipt=JSON.parse(await readFile(join(outputRoot,'replay-receipt.json'),'utf8'));assert.equal(receipt.priorRelease.directory,'release');assert.equal(receipt.priorRelease.releaseId,priorRelease.releaseId);
  assert.ok(proof.persistence.artifacts.length>0);assert.equal(proof.execution.modelCalls,0);assert.equal(proof.execution.readinessCalls,0);
  const exceptions=JSON.parse(await readFile(gate.exceptionInventory.path,'utf8')),handoff=JSON.parse(await readFile(gate.step9Handoff.path,'utf8'));assert.equal(digest(await readFile(gate.exceptionInventory.path)),gate.exceptionInventory.sha256);assert.equal(exceptions.releaseId,gate.releaseId);assert.equal(exceptions.complete,true);assert.equal(exceptions.sourceDispositions.length,corpus.documents.length);assert.equal(exceptions.assessments.length,input.expectedAssessments??1);assert.deepEqual(handoff.exceptionInventory,gate.exceptionInventory);assert.equal(JSON.parse(await readFile(handoff.assessmentManifest.path,'utf8')).length,input.expectedAssessments??1);
  assert.deepEqual(exceptions.generationAuditEvidence,gate.generationAuditEvidence);const generation=JSON.parse(await readFile(gate.generationAuditEvidence.path,'utf8'));assert.equal(digest(await readFile(gate.generationAuditEvidence.path)),gate.generationAuditEvidence.sha256);
  assert.equal(generation.status,'compatible');assert.equal(generation.allowance.approvals.filter((pin:{path:string})=>/allowance/.test(pin.path)).length,5);assert.ok(generation.purgeAcknowledgements.length>0);assert.deepEqual(generation.currentGeneration,manifest.currentGeneration);
  for(const pin of input.sealInput?.terminalDocumentExceptions??[]){const disposition=exceptions.sourceDispositions.find((entry:{documentId:string})=>entry.documentId===pin.documentId);assert.deepEqual(disposition.admittedRecordIds,[]);assert.equal(disposition.classification.terminal,true);assert.equal(disposition.terminalDocumentException.receiptSha256,pin.receiptSha256);assert.ok(disposition.terminalDocumentException.attemptHistory.length>0);}
  for(const pin of input.sealInput?.terminalAssessmentExceptions??[]){const disposition=exceptions.sourceDispositions.find((entry:{documentId:string})=>entry.documentId===pin.documentId);if(disposition.terminalDocumentException?.reasonCode==='duplicate_source_content')assert.ok(disposition.terminalDocumentException.excludedAssessmentJobKeys.includes(pin.jobKey));else assert.equal(disposition.terminalAssessmentExceptions.find((entry:{jobKey:string})=>entry.jobKey===pin.jobKey).receiptSha256,pin.receiptSha256);}
  if(input.documentJobKeys){
   const canonicalDocumentId=Object.keys(input.documentJobKeys).sort()[0];
   for(const [documentId,jobKey] of Object.entries(input.documentJobKeys)){
    const disposition=exceptions.sourceDispositions.find((entry:{documentId:string})=>entry.documentId===documentId);assert.equal(disposition.jobKey,jobKey);
    if(documentId===canonicalDocumentId){assert.equal(disposition.admittedRecordIds.length,input.expectedTextRecords??1);continue;}
    assert.deepEqual(disposition.admittedRecordIds,[]);assert.equal(disposition.classification.terminal,true);assert.deepEqual(disposition.assessments,[]);
    assert.equal(disposition.terminalDocumentException.reasonCode,'duplicate_source_content');assert.equal(disposition.terminalDocumentException.canonical.documentId,canonicalDocumentId);assert.equal(disposition.terminalDocumentException.sourceSha256,binding.sourceSha256);
   }
  }
  assert.equal(exceptions.preparation.publicationQuarantine.records.length,1,'undated native preparation hold survives scratch cleanup');
  const changes=JSON.parse(await readFile(join(gate.candidateDirectory,'knowledge/changes.json'),'utf8'));
  assert.ok(changes.events.some((event:{kind:string})=>event.kind==='removed'),'in-scope historical removals remain visible');
  assert.ok(changes.events.every((event:{cityId:string})=>event.cityId===scope.municipalityId),'out-of-scope towns are not falsely reported absent');
  await assert.rejects(runStep8(manifest,pool),/already exists/);
  await assert.rejects(runStep8({...manifest,outputRoot:join(root,'out','forbidden')},pool),/fresh candidate root/);
 }finally{if(oldDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldDatabase;}
}
