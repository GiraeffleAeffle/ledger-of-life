import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import {join,relative,dirname} from 'node:path';
import {userInfo} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {inspect} from 'node:util';
import {Pool} from 'pg';
import type {ParserSourceContext,ParserSandbox} from '../../src/district-parser-isolation.ts';
import type {AssessmentPassInput,AssessmentOutput} from '../../src/district-assessment.ts';
import type {ModelAnswer,ModelEvidence} from '../../src/district-model-contract.ts';

// Module seams exist only in this --experimental-test-module-mocks child. Every
// source-bearing parser/model operation still uses real isolated-authority scopes.
// Static project imports cannot work here: parser/model mocks must be installed
// before loading the real queue-handler dependency graph.
test('enrolled artifacts CAS survives real preparation/extraction and fixture A/B/C/seal/export',async t=>{
 const {digest:contractDigest,semanticHash}=await import('../../src/district-adapter-contract.ts');
 let extractionGeneration=0,preparationGeneration=0,toolProbes=0;
 // Module loading boundary: contract/archive readers see the same explicitly
 // synthetic source edit; physical checkout bytes are never changed by a test.
 // Capture before mocking: the offline bootstrap later synchronizes live ESM
 // builtin exports, which must not turn this delegate into self-recursion.
 const originalReadFile=readFile;
 const contractReadFile=(async(path:Parameters<typeof readFile>[0],options?:Parameters<typeof readFile>[1])=>{
  const bytes=await originalReadFile(path,options);
  const generation=path instanceof URL?path.pathname.endsWith('/src/district-model.ts')?extractionGeneration:path.pathname.endsWith('/src/district-document.ts')?preparationGeneration:0:0;
  if(!generation)return bytes;
  const suffix='\n// Synthetic topology contract generation '+generation+'\n';
  return typeof bytes==='string'?bytes+suffix:Buffer.concat([bytes,Buffer.from(suffix)]);
 }) as typeof readFile;
 t.mock.module('node:fs/promises',{namedExports:{...filesystem,readFile:contractReadFile}});
 const claimsModule=await import('../../src/district-claims.ts');
 let chunkFailure:'oversized'|'unexpected'|undefined;
 // Deterministic chunk-boundary seam, after genuine predecessor admission:
 // exercise the real 320,800-UTF-16 limit without altering frozen CAS artifacts.
 t.mock.module(new URL('../../src/district-claims.ts',import.meta.url),{namedExports:{...claimsModule,documentChunks:(text:string)=>{
  if(chunkFailure==='unexpected')throw TypeError('Synthetic unexpected chunk implementation failure');
  return claimsModule.documentChunks(chunkFailure==='oversized'?'x'.repeat(320801):text);
 }}});
 const sourceHashes=await import('../../src/district-contract-source.ts'),provenance=await import('../../src/district-host-provenance.ts');
 let hostGeneration=0;
 const currentHostHash:typeof sourceHashes.contractSourceHash=async file=>{
  const original=await sourceHashes.contractSourceHash(file);
  return ['civic-opt-out.ts','district-jobs.ts','source-policy.ts'].includes(file)&&hostGeneration?contractDigest(original+' synthetic host generation '+hostGeneration):original;
 };
 // Inject different host source hashes/manifests, not effects or fake real data.
 // Every queue/policy/custody transaction still uses the current real host code.
 t.mock.module(new URL('../../src/district-contract-source.ts',import.meta.url),{namedExports:{...sourceHashes,
  contractSourceHash:currentHostHash,
  contractSourceManifest:(files:readonly string[],hash= currentHostHash)=>sourceHashes.contractSourceManifest(files,hash),
 }});
 t.mock.module(new URL('../../src/district-host-provenance.ts',import.meta.url),{namedExports:{hostCodeVersions:async()=>{
  const versions={...await provenance.hostCodeVersions()};
  for(const file of ['civic-opt-out.ts','district-jobs.ts','source-policy.ts'])versions['hostCode.src/'+file]=await currentHostHash(file);
  const manifest=Object.entries(versions).filter(([key])=>key.startsWith('hostCode.')).map(([key,sha256])=>({file:key.slice('hostCode.'.length),sha256}));
  return {...versions,hostCodeManifestSha256:semanticHash(manifest)};
 }}});
 const {createCivicPolicyTestContext}=await import('./civic-policy.ts');
 const fixture=await createCivicPolicyTestContext(t),{policy,root}=fixture;
 const civic=await import('../../src/civic-opt-out.ts'),parser=await import('../../src/district-parser-isolation.ts');
 const {digest,canonicalJson}=await import('../../src/district-adapter-contract.ts');
 const requireFixture=async(options=policy)=>assert.equal((await civic.assertCivicPolicyAuthority(options)).mode,'isolated-fixture');
 const review={version:parser.PARSER_ISOLATION_VERSION,imageId:'sha256:'+digest('synthetic topology parser image'),runnerSha256:await parser.parserIsolationContractSha256(),securityReviewId:'synthetic-topology-only',reviewedBy:'synthetic-fixture',reviewedAt:new Date().toISOString(),dockerSocket:'/run/synthetic-topology.sock'};
 const parserRoots:string[]=[];
 t.mock.module(new URL('../../src/district-parser-isolation.ts',import.meta.url),{namedExports:{...parser,
  readParserReview:async()=>{await requireFixture();return {...review,runnerSha256:await parser.parserIsolationContractSha256()};},
  collectParserToolVersions:async(tools:readonly string[])=>{await requireFixture();toolProbes++;assert.deepEqual(tools,['node']);return {node:process.versions.node};},
  withParserSandbox:async(artifact:Uint8Array,consume:(sandbox:ParserSandbox)=>Promise<unknown>,context:ParserSourceContext)=>{
   await requireFixture(context);assert.ok(context);parserRoots.push(context.root);
   return civic.withManagedSourceScratch(context.root,context.bindings,async scope=>{
    await scope.writeSource('document',artifact);
    return consume({run:async(tool,args)=>{
     await scope.assertActive();assert.equal(tool,'node');assert.equal(args[1],'/opt/stadtstack/src/district-document-parser-worker.ts');
     const {extractDocumentText}=await import('../../src/district-document.ts');
     const document=await extractDocumentText(await readFile(join(scope.directory,'document')),args[3],undefined,async()=>assert.fail('Pure fixture decoder must not launch a subprocess'));
     return {stdout:JSON.stringify({ok:true,document}),stderr:''};
    }});
   },context);
  },
 }});
 const model=await import('../../src/district-model.ts');
 const {sourceFreeModelReadiness}=await import('../../src/district-model-readiness.ts');
 let identity:ModelEvidence|undefined,claims:unknown,modelCalls=0;
 const sourceModelRoots:string[]=[];
 t.mock.module(new URL('../../src/district-model.ts',import.meta.url),{namedExports:{...model,
  modelReadiness:async()=>{await requireFixture();identity=await sourceFreeModelReadiness('openai-subscription',async(_provider,args)=>({stdout:args[0]==='--version'?'codex-cli 0.0.0-synthetic-test-only':'Logged in using ChatGPT',stderr:'',code:0,failure:null}));return identity;},
  subscriptionChat:async(_provider:unknown,_system:unknown,_input:unknown,_schema:unknown,usage:{purpose:string;sourceContext:ParserSourceContext})=>{
   await requireFixture(usage.sourceContext);assert.ok(identity);sourceModelRoots.push(usage.sourceContext.root);
   return civic.withManagedSourceScratch(usage.sourceContext.root,usage.sourceContext.bindings,async scope=>{
    await scope.assertActive();modelCalls++;
    const value=usage.purpose==='extraction'?{record:claims,reason:'Synthetic grounded topology fixture'}:{score:0.95,reason:'Synthetic fixture judge, not independent gold',criticalUnsupported:false};
    return {value,evidence:identity!,responseSha256:digest(canonicalJson(value)),requestedModel:identity!.model,returnedModel:identity!.model,reportedModels:[identity!.model],runtimeWarnings:[],usage:{topLevel:null,perModel:{},cliEstimatedApiCostUsd:null}};
   },{...usage.sourceContext,purpose:'openai'});
  },
 }});
 const {DistrictCas}=await import('../../src/district-cas.ts');
 const {DistrictJobStore,migrateDistrictJobs,runDistrictJobs}=await import('../../src/district-jobs.ts');
 const {poolShutdownBarrier}=await import('../helpers/postgres-pool.ts');
 const {createOperatorRegistryFixture,operatorRegistryFixtureValue}=await import('../helpers/operator-registry-fixture.ts');
 const {persistCrawlRequestEvidence}=await import('../../src/district-crawl-request.ts');
 const {withFixtureAuthorizedCorpus}=await import('../../src/district-corpus.ts');
 const {importCrawlCorpusForResidual}=await import('../../src/district-crawl-import.ts');
 const residual=await import('../../src/district-residual-jobs.ts');
 const assessment=await import('../../src/district-assessment.ts');
 const assessments=await import('../../src/district-assessment-jobs.ts');
 const {DistrictAssessmentBroker,enqueueAssessmentB}=await import('../../src/district-assessment-broker.ts');
 const {BridgeLeaseSchema,BridgeStatusSchema}=await import('../../src/district-assessment-bridge-contract.ts');
 const {CriticalRecordTargetSchema}=await import('../../src/district-critical-assessment-contract.ts');
 const {DistrictExtractionClaimsSchema}=await import('../../src/district-schema.ts');
 const {PROVIDER_CONFIGS}=await import('../../src/district-model-contract.ts');
 const {authenticatePublicationProvenance}=await import('../../src/district-publication-provenance.ts');
 const {answer}=await import('../district-assessment.fixture.ts');
 const {sealQueueTextContribution,buildQueueTextRun,exportQueueTextContribution}=await import('../../src/district-queue-text-run.ts');
 const {loadR1TextCompositionInput}=await import('../../src/district-r1-text-composition.ts');
 const {appendFailureDiagnostic,pauseProvider}=await import('../../src/district-model-usage.ts');
 const {failureDiagnostic}=await import('../../src/district-model-diagnostics.ts');
 const url=new URL(process.env.DISTRICT_TEST_DATABASE_URL!);assert.notEqual(url.pathname,'/civic_r1');assert.ok(url.searchParams.get('host')?.startsWith('/tmp/'));
 const admin=new Pool({connectionString:url.href,user:userInfo().username,max:2}),closeAdmin=poolShutdownBarrier(admin),database='residual_topology_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE "'+database+'"');url.pathname='/'+database;
 const pool=new Pool({connectionString:url.href,user:userInfo().username,max:2}),closePool=poolShutdownBarrier(pool);
 let pendingBridge:Promise<unknown>|undefined,bridgeFailure:{error:unknown}|undefined;
 try{
  await migrateDistrictJobs(pool);const store=new DistrictJobStore(pool);
  const value=operatorRegistryFixtureValue(),city=value.municipalities[0];city.id='strausberg';city.ags='12064472';city.name='Synthetic Strausberg fixture';value.inventory[0].ags=city.ags;
  const now=new Date(Date.now()-1000).toISOString(),source=city.sources.find(row=>row.id==='website')!;source.checkState='checked';source.checkedAt=now;source.evidence=[{url:source.url!,locator:'Synthetic source configuration',sha256:digest('synthetic topology source'),retrievedAt:now}];
  const registry=await createOperatorRegistryFixture(t,{context:fixture,value,label:'topology-registry'}),rawRoot=join(root,'raw'),indexRoot=join(root,'index'),cas=new DistrictCas(join(root,'cas'));
  // This is the production topology: the whole CAS, not its hash subdirectory,
  // is enrolled as artifacts before any real residual queue handler runs.
  for(const [path,kind] of [[rawRoot,'fetch'],[indexRoot,'artifacts'],[cas.root,'artifacts']] as const)await civic.initializeManagedAcquisitionLane(path,{...policy,decisionId:civic.CIVIC_ACQUISITION_DECISION_ID,kind});
  const scope={publisherId:'synthetic-fixture-publisher',sourceId:source.id,municipalityId:city.id,ags:city.ags,tenant:null,observationWindow:'synthetic-topology'},text='Synthetic Strausberg fixture hat den Plan am 13.10.2026 als Satzung beschlossen. Stand: 13.10.2026.',body=Buffer.from(text),sha256=digest(body),originalUrl='https://example.org/topology-original',observationId=Date.now()+'-'+randomUUID()+'.json',observationPath=join(rawRoot,'observations',observationId);
  const sourcePolicy={robots:{state:'allowed',url:'https://example.org/robots.txt',sha256:digest('synthetic robots'),checkedAt:now},tdm:{state:'not_declared',evidence:[{url:'https://example.org/.well-known/tdmrep.json',locator:'TDMRep standardized location HTTP absence',value:'404',checkedAt:now}]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'},observationBytes=Buffer.from(JSON.stringify({url:originalUrl,method:'GET',checkedAt:now,retrievedAt:now,state:'fetched',status:200,sha256,bytes:body.length,mimeType:'text/plain',policy:sourcePolicy})+'\n');
  const binding={kind:'http_observation' as const,url:originalUrl,sourceSha256:sha256,observationId,receiptSha256:digest(observationBytes)},bodyPath=join(rawRoot,'sha256',sha256);
  await civic.withManagedSourceWrite(rawRoot,[{...binding,relativePath:'sha256/'+sha256,contentSha256:sha256,independentAllowed:true}],async()=>{await mkdir(join(rawRoot,'sha256'),{recursive:true,mode:0o700});await mkdir(join(rawRoot,'observations'),{recursive:true,mode:0o700});await writeFile(bodyPath,body,{mode:0o600});await writeFile(observationPath,observationBytes,{mode:0o600});},policy);
  const document={id:'synthetic-topology-original',municipalityId:city.id,ags:city.ags,districtId:city.districtId,sourceId:source.id,url:originalUrl,sha256,mimeType:'text/plain',retrievedAt:now,checkedAt:now,status:200,observationPath,documentDate:null,localPath:relative(indexRoot,bodyPath),adapter:'synthetic-topology-fixture',metadata:{}},indexBytes=Buffer.from(JSON.stringify({schemaVersion:'stadtstack-crawl-index-v1',generatedAt:now,documents:[document],checks:[{municipalityId:city.id,sourceId:source.id,checkState:'checked',checkedAt:now,documentCount:1,coverage:{state:'partial',pendingCount:0,runnableCount:0,blockedCount:0,scope:'Synthetic bounded topology fixture',sourceCoverage:'not_assessed'}}]})+'\n'),indexHash=digest(indexBytes),indexPath=join(indexRoot,'index.json');
  await civic.withManagedSourceWrite(indexRoot,[...registry.admitted.bindings,binding].map(item=>({...item,relativePath:'index.json',contentSha256:indexHash,independentAllowed:false})),()=>writeFile(indexPath,indexBytes,{mode:0o600}),policy);
  const requestEvidence=await persistCrawlRequestEvidence(rawRoot,{schemaVersion:'stadtstack-crawl-request-evidence-v1',httpObservation:binding,request:{url:originalUrl,method:'GET',contentType:null,bodySha256:null,publicSelector:null},redirectChain:[originalUrl]},policy);
  const bounds={maxDocuments:1 as const,maxChunks:12,maxModelCalls:48,paidMicroUsd:0 as const},manifest={index:{path:indexPath,sha256:indexHash},rawRoot,registry:registry.registryPin,observations:[{path:observationPath,sha256:binding.receiptSha256}],documents:[{documentId:document.id,scope,permission:{kind:'facts_with_attribution' as const},bounds,requestEvidence}]};
  claims=DistrictExtractionClaimsSchema.parse({title:'Strausberg',titleQuote:'Strausberg',summary:text,summaryQuote:text,caseKey:null,caseKeyType:'source_document',caseQuote:null,caseType:'unknown',topics:[],stages:[],locations:[],municipalityQuote:city.name,stage:'adopted',stageQuote:'am 13.10.2026 als Satzung beschlossen',originalStatus:'als Satzung beschlossen',stageDate:'2026-10-13',stageDateQuote:'am 13.10.2026 als Satzung beschlossen',stageDateReason:null,documentDate:'2026-10-13',documentDateQuote:'Stand: 13.10.2026',documentDateReason:null,entities:[],relations:[]});
  const complete=async()=>{const receipt=await civic.recoverManagedSourceScratch(policy);assert.equal(receipt.status,'complete',canonicalJson(receipt));const inventory=JSON.parse(await readFile(join(policy.stateDir!,'inventory.json'),'utf8'));assert.equal(inventory.roots.find((entry:{path:string})=>entry.path===cas.root).complete,true);return inventory;};
  const authorize=(jobKey:string,phase='initial')=>store.authorize({approvalSha256:digest('Synthetic topology authorization '+jobKey+' '+phase),approvedBy:'synthetic-fixture-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[jobKey],ags:[scope.ags],maxJobs:1,maxElapsedMs:60000,category:'development'});
  const run=async(jobKey:string,handlers:Parameters<typeof runDistrictJobs>[0]['handlers'])=>{const result=await runDistrictJobs({store,cas,handlers,authorizationId:await authorize(jobKey),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});assert.equal(result.state,'completed',canonicalJson(result));await complete();return result;};
  await withFixtureAuthorizedCorpus(indexBytes,policy,async()=>{
   const imported=await importCrawlCorpusForResidual(store,cas,manifest);assert.deepEqual(imported.holds,[]);assert.equal(imported.jobs.length,1);
   const handlers=residual.residualJobHandlersFor(pool),preparationKey=await residual.enqueueResidualPreparation(store,cas,imported.jobs[0]);
   const semanticBefore=await residual.residualJobContract();hostGeneration++;
   assert.deepEqual(await residual.residualJobContract(),semanticBefore);
   assert.equal(await residual.enqueueResidualPreparation(store,cas,imported.jobs[0]),preparationKey);
   extractionGeneration++;
   assert.notDeepEqual(await residual.residualJobContract(),semanticBefore);
   assert.equal(await residual.enqueueResidualPreparation(store,cas,imported.jobs[0]),preparationKey,'A queued preparation survives an extraction-only source edit before claim');
   await run(preparationKey,handlers);assert.deepEqual(parserRoots,[cas.root+'-residual-prepared']);await assert.rejects(lstat(join(cas.root,'residual-prepared')),{code:'ENOENT'});
   const inventory=await complete();assert.equal(inventory.roots.find((entry:{path:string})=>entry.path===cas.root+'-residual-prepared').kind,'prepared');
   const preparationReceipt=(await pool.query('SELECT receipt FROM district_pipeline.step_receipts WHERE receipt->>\'jobKey\'=$1',[preparationKey])).rows[0].receipt;
   assert.equal(preparationReceipt.versions['hostCode.src/civic-opt-out.ts'],await currentHostHash('civic-opt-out.ts'));
   const frozenPreparationBytes=await Promise.all(preparationReceipt.outputHashes.map((hash:string)=>cas.read(hash)));
   const priorSpec=(await pool.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[preparationKey])).rows[0].spec;
   // Real queue/receipt commits with the historical broad selector shape. This
   // synthetic fixture reuses actual produced parser artifacts, not invented text
   // or a fabricated success receipt; no production migration is performed.
   const oldContract=await residual.residualJobContract(),historicalKey=await store.enqueue({...priorSpec,semanticContractSha256:semanticHash(oldContract),selector:{...priorSpec.selector,contract:oldContract}});
   const historicalOutputs=(await pool.query('SELECT sha256,byte_length,kind,mime_type,storage_key FROM district_pipeline.artifacts WHERE sha256=ANY($1::text[])',[preparationReceipt.outputHashes])).rows;
   const historicalPrepare:typeof handlers.residual_prepare=async()=>({outcome:'succeeded',reasonCode:'completed',outputs:historicalOutputs.map(row=>({sha256:row.sha256,byteLength:Number(row.byte_length),kind:row.kind,mimeType:row.mime_type,storageKey:row.storage_key})),versions:preparationReceipt.versions});
   historicalPrepare.currentPolicy=handlers.residual_prepare.currentPolicy;
   await run(historicalKey,{...handlers,residual_prepare:historicalPrepare});
   const historicalReceipt=(await pool.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE receipt->>\'jobKey\'=$1',[historicalKey])).rows[0],frozenHistoricalReceipt=canonicalJson(historicalReceipt);
   const earlierExtraction=await residual.enqueueCommittedResidualExtraction(pool,store,cas,historicalKey);
   extractionGeneration++;hostGeneration++;
   assert.notDeepEqual(await residual.residualJobContract(),oldContract);
   assert.equal(await residual.enqueueResidualPreparation(store,cas,imported.jobs[0]),preparationKey);
   const extractionKey=await residual.enqueueCommittedResidualExtraction(pool,store,cas,historicalKey);
   assert.notEqual(extractionKey,earlierExtraction,'Changed extraction semantics create a new extraction, not a new preparation');
   const extractionSpec=(await pool.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[extractionKey])).rows[0].spec;
   assert.equal(extractionSpec.selector.preparationJobKey,historicalKey);
   assert.equal(extractionSpec.selector.preparationReceiptSha256,historicalReceipt.receipt_sha256);
   assert.deepEqual(extractionSpec.selector.contract,await residual.residualJobContract());
   assert.deepEqual(frozenPreparationBytes,await Promise.all(preparationReceipt.outputHashes.map((hash:string)=>cas.read(hash))));
   assert.equal(canonicalJson((await pool.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE receipt->>\'jobKey\'=$1',[historicalKey])).rows[0]),frozenHistoricalReceipt);
   preparationGeneration++;
   const changedPreparationKey=await residual.enqueueResidualPreparation(store,cas,imported.jobs[0]);
   assert.notEqual(changedPreparationKey,preparationKey);
   await assert.rejects(residual.enqueueCommittedResidualExtraction(pool,store,cas,historicalKey),/preparation semantic contract changed/);
   preparationGeneration=0;
   const stalePreparation=await runDistrictJobs({store,cas,handlers,authorizationId:await authorize(changedPreparationKey),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
   assert.equal(stalePreparation.state,'held');assert.equal(stalePreparation.reasonCode,'execution_exception');assert.equal(parserRoots.length,1);
   // Consuming frozen prepared text must not probe tools or require a new parser
   // review. Only the current semantic parser contract is compared offline.
   const probesBeforeExtraction=toolProbes;
   chunkFailure='oversized';
   const budgetRun=await runDistrictJobs({store,cas,handlers,authorizationId:await authorize(extractionKey,'chunk-budget'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
   assert.equal(budgetRun.state,'held');assert.equal(budgetRun.reasonCode,'quality_failed');await complete();
   const budgetReceipt=(await pool.query('SELECT receipt FROM district_pipeline.step_receipts WHERE receipt->>\'jobKey\'=$1 ORDER BY attempt DESC LIMIT 1',[extractionKey])).rows[0].receipt;
   assert.equal(budgetReceipt.outcome,'held_quality');assert.equal(budgetReceipt.reasonCode,'quality_failed');assert.equal(modelCalls,0);
   await store.resume(extractionKey);chunkFailure='unexpected';
   const unexpectedChunk=await runDistrictJobs({store,cas,handlers,authorizationId:await authorize(extractionKey,'unexpected-chunk-failure'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
   assert.equal(unexpectedChunk.state,'held');assert.equal(unexpectedChunk.reasonCode,'execution_exception');assert.equal(modelCalls,0);
   await store.resume(extractionKey);chunkFailure=undefined;
   await run(extractionKey,handlers);assert.equal(toolProbes,probesBeforeExtraction);assert.equal(parserRoots.length,1);assert.equal(modelCalls,2);assert.ok(sourceModelRoots.every(path=>path.startsWith(cas.root+'-residual-model/')&&!path.startsWith(cas.root+'/')));
   hostGeneration++; // Already produced prepared/extraction outputs remain admissible downstream.
   const groundedAnswer=(input:AssessmentPassInput):ModelAnswer=>{const response=answer(input),output=response.value as AssessmentOutput,data=input.data as {criticalTarget:unknown;evidence:{sourceId:string;locators:{id:string;quote:string}[]}[]},target=CriticalRecordTargetSchema.strip().parse(data.criticalTarget);output.assertions=[...output.assertions.filter(assertion=>!target.claims.some(claim=>claim.claimId===assertion.claimId)),...target.claims.map(claim=>({claimId:claim.claimId,sourceId:claim.sourceId,locatorId:data.evidence.find(entry=>entry.sourceId===claim.sourceId)!.locators.find(locator=>locator.quote===claim.quote)!.id,quote:claim.quote,subjectId:claim.subjectId,objectId:claim.objectId,value:null,unit:null,date:claim.date,dateRole:claim.dateRole,financialRole:claim.financialRoles[0],stage:claim.stage,modality:claim.modality}))];output.criticalReview={recordId:target.recordId,recordEvidenceSha256:target.recordEvidenceSha256,claimProjectionSha256:target.claimProjectionSha256,claims:target.claims.map(claim=>({claimId:claim.claimId,claimSha256:claim.claimSha256,verdict:'supported',rationale:'Synthetic topology fixture, not independent gold'}))};return {...response,value:output,responseSha256:digest(canonicalJson(output))};};
   const assessmentHandlers=assessments.assessmentQueueHandlers(pool,{policyOptions:policy,fixtureProtocol:true,fixtureProvider:async input=>groundedAnswer(input)}),assessmentPreparation=await assessments.enqueueResidualAssessmentItems(pool,store,cas,extractionKey);await run(assessmentPreparation,assessmentHandlers);
   const AJobKey=(await assessments.enqueuePreparedAssessmentPass(pool,store,cas,assessmentPreparation,'A'))[0];await run(AJobKey,assessmentHandlers);
   const aSpec=(await pool.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[AJobKey])).rows[0].spec,item=assessment.assessmentItemSchema.parse(JSON.parse((await cas.read(aSpec.selector.itemArtifactSha256)).toString('utf8'))),broker=new DistrictAssessmentBroker(pool,cas,{policyOptions:policy,fixtureProtocol:true}),clientContractSha256=digest('synthetic topology B client'),BJobKey=await enqueueAssessmentB(broker,{itemArtifactSha256:aSpec.selector.itemArtifactSha256,sourceScope:scope,policyProofSha256:imported.jobs[0].policyReceiptSha256,transport:'mac-bridge',clientContractSha256});
   hostGeneration++; // B was enqueued under an older host manifest.
   const pendingB=run(BJobKey,assessmentHandlers),deadline=Date.now()+50000;pendingBridge=pendingB;
   let bridgeFinished=false;
   // Observe immediately and drain before pool teardown; otherwise an early
   // fixture error is hidden by the worker's later endRun on a closed pool.
   void pendingB.then(()=>{bridgeFinished=true;},(error:unknown)=>{bridgeFailure={error};bridgeFinished=true;});
   for(;;){if(bridgeFailure)throw bridgeFailure.error;const ready=await pool.query("SELECT 1 FROM district_pipeline.assessment_bridge_leases b JOIN district_pipeline.jobs j ON j.id=b.job_id WHERE j.job_key=$1 AND b.state='ready'",[BJobKey]);if(ready.rowCount)break;if(bridgeFinished||Date.now()>deadline)throw Error('Synthetic B lease did not become ready: '+canonicalJson((await pool.query("SELECT receipt FROM district_pipeline.step_receipts WHERE receipt->>'jobKey'=$1",[BJobKey])).rows));await delay(10);}
   const lease=BridgeLeaseSchema.parse(await broker.dispatch({operation:'claim',jobKey:BJobKey,clientId:'synthetic-topology-client',clientContractSha256})),input=assessment.buildAssessmentPassInput(item,await assessment.originalEvidence(item,{cas,policyOptions:policy}),'B'),output=groundedAnswer(input).value,config=PROVIDER_CONFIGS['anthropic-subscription'],startedAt=new Date().toISOString(),evidence={provider:'anthropic-subscription' as const,tool:'claude-cli' as const,toolVersion:'0.0.0-synthetic-test-only',model:config.model,modelIdentityBasis:config.modelIdentityBasis};
   const stdout=[{type:'system',subtype:'init',tools:[],mcp_servers:[],model:config.model},{type:'assistant',message:{id:'msg_synthetic_topology',model:config.model,content:[]}},{type:'result',subtype:'success',is_error:false,model:config.model,request_id:'req_synthetic_topology',structured_output:output,usage:{input_tokens:1,output_tokens:1}}].map(value=>JSON.stringify(value)).join('\n')+'\n';
   const finishedAt=new Date().toISOString();
   const submitted=BridgeStatusSchema.parse(await broker.dispatch({operation:'submit',leaseId:lease.leaseId,inputSha256:lease.inputSha256,purgeAck:{sourceFiles:0,responseFiles:0,modelFileWritesDenied:true,completedAt:new Date().toISOString()},answer:{stdout,evidence:{...evidence,modelIdentitySha256:digest(JSON.stringify(evidence))},startedAt,finishedAt}}));
   assert.equal(submitted.state,'submitted',canonicalJson((await pool.query('SELECT state,reason_code FROM district_pipeline.assessment_bridge_leases WHERE id=$1',[lease.leaseId])).rows));await pendingB;
   const pendingReconcile=await assessments.enqueueAssessmentResolution(pool,store,cas,{AJobKey,BJobKey},'reconcile',policy);await runDistrictJobs({store,cas,handlers:assessmentHandlers,authorizationId:await authorize(pendingReconcile,'requires-C'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
   const pendingRow=(await pool.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1) ORDER BY attempt DESC LIMIT 1',[pendingReconcile])).rows[0],pendingAssessmentException={documentId:document.id,step:'assessment_reconcile' as const,jobKey:pendingReconcile,receiptId:pendingRow.receipt.id,receiptSha256:pendingRow.receipt_sha256,reasonCode:pendingRow.receipt.reasonCode};
   const CJobKey=await assessments.enqueueAssessmentResolution(pool,store,cas,{AJobKey,BJobKey},'C',policy);await run(CJobKey,assessmentHandlers);
   const reconcileKey=await assessments.enqueueAssessmentResolution(pool,store,cas,{AJobKey,BJobKey,CJobKey},'reconcile',policy);await run(reconcileKey,assessmentHandlers);
   // Exercise the actual usage/failure writers with the queue's shared path
   // builder: native failures must not leave untracked files in the CAS.
   const usage=assessments.assessmentModelUsagePaths(cas.root,AJobKey,'synthetic-failure-run');assert.equal(dirname(dirname(usage.ledgerPath)),cas.root+'-assessment-model');assert.ok(!usage.pausePath.startsWith(cas.root+'/'));
   await appendFailureDiagnostic(usage.ledgerPath+'.failures.jsonl',failureDiagnostic({callId:randomUUID(),provider:'openai-subscription',groupId:item.itemId,reason:'process',failureCategory:'process_failure',startedAt,attempted:true,exitCode:1,parserFailureCategory:null,toolEvidence:[],toolEvidenceTruncated:false}));await pauseProvider(usage.pausePath,'openai-subscription');await complete();
   const positiveInput={jobKeys:[extractionKey],reconciliationJobKeys:[reconcileKey],terminalAssessmentExceptions:[pendingAssessmentException]},sealed=await sealQueueTextContribution(pool,cas,positiveInput);assert.equal(sealed.records,1);
   const provenance=await authenticatePublicationProvenance(sealed.privateProvenance.path,sealed.privateProvenance.sha256,policy);
   const composition=await loadR1TextCompositionInput(JSON.parse((await cas.read(sealed.compositionArtifactSha256)).toString('utf8')),pin=>provenance.read(pin.path));assert.equal((await exportQueueTextContribution(pool,cas,[extractionKey],composition.contributions[0])).results.length,1);
   const heldPin=async<S extends 'residual_prepare'|'residual_extract'>(key:string,step:S)=>{const row=(await pool.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1) ORDER BY attempt DESC LIMIT 1',[key])).rows[0];return {documentId:document.id,step,jobKey:key,receiptId:row.receipt.id,receiptSha256:row.receipt_sha256,reasonCode:row.receipt.reasonCode};};
   const hold=async(key:string,step:'residual_prepare'|'residual_extract')=>{const handler:Parameters<typeof runDistrictJobs>[0]['handlers'][string]=async()=>({outcome:'held_execution',reasonCode:'isolation_unavailable'});handler.currentPolicy=handlers[step].currentPolicy;const result=await runDistrictJobs({store,cas,handlers:{[step]:handler},authorizationId:await authorize(key,'terminal-exception-'+randomUUID()),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});assert.equal(result.jobsStarted,1);await complete();};
   const terminalKey=await residual.enqueueResidualPreparation(store,cas,{...imported.jobs[0],bounds:{...imported.jobs[0].bounds,maxChunks:11}});await hold(terminalKey,'residual_prepare');
   const firstTerminalPin=await heldPin(terminalKey,'residual_prepare'),firstTerminalSeal=await sealQueueTextContribution(pool,cas,{jobKeys:[],reconciliationJobKeys:[],terminalDocumentExceptions:[firstTerminalPin]}),firstTerminalComposition=await loadR1TextCompositionInput(JSON.parse((await cas.read(firstTerminalSeal.compositionArtifactSha256)).toString('utf8')),pin=>cas.read(pin.sha256));
   for(let resume=0;resume<2;resume++){await store.resume(terminalKey);await hold(terminalKey,'residual_prepare');}
   await assert.rejects(exportQueueTextContribution(pool,cas,[],firstTerminalComposition.contributions[0]),/current committed held attempt/);
   const terminalPin=await heldPin(terminalKey,'residual_prepare'),terminalInput={jobKeys:[],reconciliationJobKeys:[],terminalDocumentExceptions:[terminalPin]},terminalSeal=await sealQueueTextContribution(pool,cas,terminalInput);
   assert.equal(terminalSeal.records,0);assert.equal(terminalSeal.committedDocuments,1);assert.equal(terminalSeal.terminalDocumentExceptions[0].attemptHistory.length,3);
   const terminalRun=JSON.parse((await cas.read(terminalSeal.runId)).toString('utf8'));assert.equal(terminalRun.attemptedDocumentGroups,1);assert.equal(terminalRun.municipalities.find((city:{id:string})=>city.id===scope.municipalityId).preparedDocumentGroups,0);assert.deepEqual(terminalRun.queue.generationArchiveSha256s,[]);
   await assert.rejects(buildQueueTextRun(pool,cas,{...terminalInput,terminalDocumentExceptions:[{...terminalPin,documentId:'foreign-original'}]}),/document or semantic contract/);
   const extractionPreparation=await residual.enqueueResidualPreparation(store,cas,{...imported.jobs[0],bounds:{...imported.jobs[0].bounds,maxChunks:10}});await run(extractionPreparation,handlers);
   const heldExtraction=await residual.enqueueCommittedResidualExtraction(pool,store,cas,extractionPreparation);await hold(heldExtraction,'residual_extract');
   const extractionException=await heldPin(heldExtraction,'residual_extract'),extractionExceptionSeal=await sealQueueTextContribution(pool,cas,{jobKeys:[],reconciliationJobKeys:[],terminalDocumentExceptions:[extractionException]});
   assert.equal(extractionExceptionSeal.records,0);assert.equal(extractionExceptionSeal.committedDocuments,1);
   const extractionExceptionRun=JSON.parse((await cas.read(extractionExceptionSeal.runId)).toString('utf8'));assert.equal(extractionExceptionRun.municipalities.find((city:{id:string})=>city.id===scope.municipalityId).preparedDocumentGroups,1);
   const extractionExceptionComposition=await loadR1TextCompositionInput(JSON.parse((await cas.read(extractionExceptionSeal.compositionArtifactSha256)).toString('utf8')),pin=>cas.read(pin.sha256));assert.equal((await exportQueueTextContribution(pool,cas,[],extractionExceptionComposition.contributions[0])).terminalDocumentExceptions.length,1);
   const {exerciseStep8}=await import('../helpers/step8-fixture.ts'),callsBeforeStep8=modelCalls,probesBeforeStep8=toolProbes;
   await exerciseStep8(t,{pool,cas,policy,fixtureRoot:root,sealed,jobKey:extractionKey,reconcileKey,sealInput:positiveInput,scope,binding:{...binding,independentAllowed:true},policyReceiptSha256:imported.jobs[0].policyReceiptSha256,body,retrievedAt:now}).catch((error:unknown)=>{throw new Error('Step 8 fixture: '+inspect(error,{depth:10}),{cause:error});});
   assert.equal(modelCalls,callsBeforeStep8);assert.equal(toolProbes,probesBeforeStep8);
   await exerciseStep8(t,{pool,cas,policy,fixtureRoot:join(root,'terminal-only-generation'),sealed:terminalSeal,jobKey:terminalKey,reconcileKey,sealInput:terminalInput,expectedTextRecords:0,expectedAssessments:0,expectDatedSliceHold:true,scope,binding:{...binding,independentAllowed:true},policyReceiptSha256:imported.jobs[0].policyReceiptSha256,body,retrievedAt:now}).catch((error:unknown)=>{throw new Error('Terminal-only step 8 fixture: '+inspect(error,{depth:10}),{cause:error});});
   assert.equal(modelCalls,callsBeforeStep8);assert.equal(toolProbes,probesBeforeStep8);
   await complete();assert.deepEqual(await readFile(bodyPath),body);assert.deepEqual(await readFile(observationPath),observationBytes);
  });
 }finally{await pendingBridge?.catch(()=>{});await closePool();await admin.query('DROP DATABASE "'+database+'"');await closeAdmin();}
});
