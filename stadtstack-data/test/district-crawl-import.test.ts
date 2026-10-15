import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {promises as fsPromises} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {Pool,type QueryResult} from 'pg';
import {z} from 'zod';
import {digest,canonicalJson,semanticHash} from '../src/district-adapter-contract.ts';
import {DistrictCas} from '../src/district-cas.ts';
import {DistrictJobStore,DistrictExecutionHold,migrateDistrictJobs,runDistrictJobs,type JobHandler,type DistrictJobSpec} from '../src/district-jobs.ts';
import type {StepReceipt} from '../src/district-step-receipt.ts';
import {importCrawlCorpusForResidual} from '../src/district-crawl-import.ts';
import {withFixtureAuthorizedCorpus,authorizedPilotCorpusSchema,loadFrozenCorpusBytes,type CrawlDocument} from '../src/district-corpus.ts';
import {ResidualInputSchema,residualJobHandlersFor,enqueueResidualPreparation,enqueueCommittedResidualExtraction,loadResidualSource,captureResidualAnswers,exportResidualTextContribution} from '../src/district-residual-jobs.ts';
import {ObservationRequestSchema,persistCrawlRequestEvidence} from '../src/district-crawl-request.ts';
import {provisionCivicPolicyAuthority,initializeManagedAcquisitionLane,withManagedSourceWrite,assertManagedSourceBindings,recoverManagedSourceScratch,recordHostOptOut,CIVIC_ACQUISITION_DECISION_ID,CivicPolicyStateError} from '../src/civic-opt-out.ts';
import {createOperatorRegistryFixture,operatorRegistryFixtureValue} from './helpers/operator-registry-fixture.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';
import {enqueueCrawlPolicyRefresh,policyRefreshHandler,recheckResidualPolicy,recordedPolicyIdentity} from '../src/district-policy-refresh.ts';
import {createR1PublicFetcher} from '../src/district-r1.ts';
import {PoliteFetcher,type FetchObservation} from '../src/polite-fetch.ts';
import {fixturePolicyInspection} from './fixtures/polite-inspection.ts';
import {loadPolicyReceipt,recheckPolicyReceipt} from '../src/district-policy-receipt.ts';
import {prepareDocument,PreparedDocumentSchema} from '../src/district-prepared-document.ts';
import {parserOutputContractSha256,PARSER_ISOLATION_VERSION} from '../src/district-parser-isolation.ts';
import {assessmentItemSchema,originalEvidence,buildAssessmentPassInput,type AssessmentOutput,type AssessmentPassInput} from '../src/district-assessment.ts';
import {assessmentQueueHandlers,enqueueResidualAssessmentItems,enqueuePreparedAssessmentPass,enqueueAssessmentResolution} from '../src/district-assessment-jobs.ts';
import {buildPreparedAssessmentContext} from '../src/district-assessment-context.ts';
import {DistrictAssessmentBroker,enqueueAssessmentB} from '../src/district-assessment-broker.ts';
import {BridgeLeaseSchema,BridgeStatusSchema} from '../src/district-assessment-bridge-contract.ts';
import {DistrictExtractionClaimsSchema} from '../src/district-schema.ts';
import {PROVIDER_CONFIGS,EMPTY_USAGE,type ModelEvidence} from '../src/district-model-contract.ts';
import {answer} from './district-assessment.fixture.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {inferPreparedDocument,archiveJointExtractionContract} from '../src/district-inference.ts';
import {reserveR1CodexCall} from '../src/district-codex-accounting.ts';
import {sealQueueTextContribution,buildQueueTextRun,exportQueueTextContribution} from '../src/district-queue-text-run.ts';
import {loadR1TextCompositionInput,buildR1TextCompositionContext} from '../src/district-r1-text-composition.ts';
import {authenticatePublicationProvenance} from '../src/district-publication-provenance.ts';
import {prepareKnowledge} from '../src/prepare-knowledge.ts';
import {CriticalRecordTargetSchema} from '../src/district-critical-assessment-contract.ts';
import {readRegisteredRobotsAudit,REGISTERED_SOURCE_POLICY_VALIDITY_MS} from '../src/registered-source-policy.ts';
import type {BoundSourceObservation} from '../src/source-observation.ts';
import {MAX_POLICY_METADATA_EVIDENCE} from '../src/source-policy.ts';

const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
test('public request evidence excludes credential/header fields and binds selector bytes',()=>{
 const request={url:'https://example.org/list',method:'POST',contentType:'application/x-www-form-urlencoded',bodySha256:digest('name=public'),publicSelector:'name=public'};
 assert.deepEqual(ObservationRequestSchema.parse(request),request);
 for(const publicSelector of ['username=owner','password=secret','authorization=bearer','token=secret'])assert.throws(()=>ObservationRequestSchema.parse({...request,publicSelector,bodySha256:digest(publicSelector)}));
 assert.throws(()=>ObservationRequestSchema.parse({...request,headers:{username:'owner',password:'secret'}}));
 assert.throws(()=>ObservationRequestSchema.parse({...request,bodySha256:digest('tampered')}));
});
test('offline frozen crawl import preserves managed originals and produces enqueue-ready residual jobs',{skip:!connectionString,timeout:900000},async t=>{
 const endpoint=new URL(connectionString!);
 if(!['postgres:','postgresql:'].includes(endpoint.protocol)||!['localhost','127.0.0.1','[::1]',''].includes(endpoint.hostname))throw Error('Test refuses non-local PG');
 const host=endpoint.searchParams.get('host');if(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1'].includes(host))throw Error('Test refuses non-local PG host');
 const admin=new Pool({connectionString,max:2}),database='crawl_import_test_'+randomUUID().replaceAll('-','');
 const closeAdmin=poolShutdownBarrier(admin);
 let pool:Pool|undefined,closePool:(()=>Promise<void>)|undefined,root:string|undefined,created=false;
 t.after(async()=>{try{await closePool?.();if(created)await admin.query('DROP DATABASE "'+database+'"');}finally{await closeAdmin();if(root)await rm(root,{recursive:true,force:true});}});
 await admin.query('CREATE DATABASE "'+database+'"');created=true;endpoint.pathname='/'+database;
 pool=new Pool({connectionString:endpoint.href,max:4});closePool=poolShutdownBarrier(pool);await migrateDistrictJobs(pool);
 root=await mkdtemp(join(tmpdir(),'crawl-import-proof-'));
 const options={stateDir:join(root,'authority'),authorityId:`fixture:${randomUUID()}`},authority=await provisionCivicPolicyAuthority(options),policy={...options,authoritySha256:authority.authoritySha256};
 const value=operatorRegistryFixtureValue(),city=value.municipalities[0];
 city.id='strausberg';city.ags='12064472';value.inventory[0].ags=city.ags;
 city.name='Synthetic Strausberg fixture';
 const now=new Date(Date.now()-1000).toISOString(),source=city.sources.find(row=>row.id==='website')!;
 source.checkState='checked';source.checkedAt=now;source.evidence=[{url:source.url!,locator:'Synthetic observed source',sha256:digest('synthetic source evidence'),retrievedAt:now}];
 const registry=await createOperatorRegistryFixture(t,{context:{root,policy},value}),store=new DistrictJobStore(pool);
 const scope={publisherId:'synthetic-explicit-publisher',sourceId:source.id,municipalityId:city.id,ags:city.ags,tenant:null,observationWindow:'synthetic-bounded-window'};
 const bounds={maxDocuments:1 as const,maxChunks:4,maxModelCalls:8,paidMicroUsd:0 as const};
 async function fixture(label:string,config:{stale?:boolean;missingRequest?:boolean;post?:boolean;extra?:boolean;sameBytes?:boolean;selectExtra?:boolean;body?:Buffer;url?:string;casRoot?:string;robotsBody?:string;robotsAbsence?:404|410}={}){
  const rawRoot=join(root!,label+'-raw'),indexRoot=join(root!,label+'-index'),casRoot=config.casRoot??join(root!,label+'-cas');
  for(const [path,kind] of [[rawRoot,'fetch'],[indexRoot,'artifacts'],[casRoot,'artifacts']] as const)await initializeManagedAcquisitionLane(path,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind});
  const checkedAt=new Date(Date.now()-(config.stale?7200000:3000)).toISOString(),url=config.url??'https://example.org/'+label,bytes=config.body??Buffer.from('Synthetic civic fixture original '+label),sha256=digest(bytes),observationId=`${Date.now()}-${randomUUID()}.json`,observationPath=join(rawRoot,'observations',observationId);
  const publicSelector=config.post?'municipality=12064472':null;
  const observation={url,method:config.post?'POST':'GET',checkedAt,retrievedAt:checkedAt,state:'fetched',status:200,sha256,bytes:bytes.length,mimeType:'text/plain',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt',...(config.robotsAbsence?{}:{sha256:digest(config.robotsBody??'synthetic robots')}),checkedAt},tdm:{state:'not_declared',evidence:[{url:'https://example.org/.well-known/tdmrep.json',locator:'TDMRep standardized location HTTP absence',value:'404',checkedAt}]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
  const observationBytes=Buffer.from(JSON.stringify(observation,null,2)+'\n'),binding={kind:'http_observation' as const,url,sourceSha256:sha256,observationId,receiptSha256:digest(observationBytes)};
  const absenceId=`${Date.now()}-${randomUUID()}.json`,absenceBytes=Buffer.from(JSON.stringify({url:'https://example.org/robots.txt',method:'GET',checkedAt,retrievedAt:null,state:'failed',status:config.robotsAbsence,failure:'http_error'})+'\n');
  const robotsAbsencePin=config.robotsAbsence?{path:join(rawRoot,'observations',absenceId),observationId:absenceId,receiptSha256:digest(absenceBytes)}:undefined;
  await withManagedSourceWrite(rawRoot,[{...binding,relativePath:'sha256/'+sha256,contentSha256:sha256,independentAllowed:true}],async()=>{
   await mkdir(join(rawRoot,'sha256'),{recursive:true,mode:0o700});await mkdir(join(rawRoot,'observations'),{recursive:true,mode:0o700});
   await writeFile(join(rawRoot,'sha256',sha256),bytes,{mode:0o600});await writeFile(observationPath,observationBytes,{mode:0o600});
   if(robotsAbsencePin)await writeFile(robotsAbsencePin.path,absenceBytes,{mode:0o600});
  },policy);
  const path=join(indexRoot,'index.json'),document={id:label,municipalityId:city.id,ags:city.ags,districtId:city.districtId,sourceId:source.id,url,sha256,mimeType:'text/plain',retrievedAt:checkedAt,checkedAt,status:200,observationPath,documentDate:null,localPath:relative(indexRoot,join(rawRoot,'sha256',sha256)),adapter:'synthetic-test-only',metadata:{}};
  const documents=[document],observations=[{path:observationPath,sha256:digest(observationBytes)}],bindings=[binding];
  if(config.extra){
   const extraBody=config.sameBytes?bytes:Buffer.from('unselected fixture'),extra={...observation,url:url+'-unselected',sha256:digest(extraBody),bytes:extraBody.length},extraId=`${Date.now()}-${randomUUID()}.json`,extraBytes=Buffer.from(JSON.stringify(extra)+'\n'),extraPath=join(rawRoot,'observations',extraId),extraBinding={...binding,url:extra.url,sourceSha256:extra.sha256,observationId:extraId,receiptSha256:digest(extraBytes)};
   await withManagedSourceWrite(rawRoot,[{...extraBinding,relativePath:'sha256/'+extra.sha256,contentSha256:extra.sha256,independentAllowed:true}],async()=>{await writeFile(extraPath,extraBytes,{mode:0o600});await writeFile(join(rawRoot,'sha256',extra.sha256),extraBody,{mode:0o600});},policy);
   observations.push({path:extraPath,sha256:digest(extraBytes)});bindings.push(extraBinding);
   documents.push({...document,id:label+'-unselected',url:extra.url,sha256:extra.sha256,observationPath:extraPath,localPath:relative(indexRoot,join(rawRoot,'sha256',extra.sha256))});
  }
  const indexBytes=Buffer.from(JSON.stringify({schemaVersion:'stadtstack-crawl-index-v1',generatedAt:checkedAt,documents,checks:[{municipalityId:city.id,sourceId:source.id,checkState:'checked',checkedAt,documentCount:documents.length,coverage:{state:'partial',pendingCount:0,runnableCount:0,blockedCount:0,scope:'Synthetic bounded original observation',sourceCoverage:'not_assessed'}}]},null,2)+'\n'),indexHash=digest(indexBytes);
  await withManagedSourceWrite(indexRoot,[...registry.admitted.bindings,...bindings].map(binding=>({...binding,relativePath:'index.json',contentSha256:indexHash,independentAllowed:false})),()=>writeFile(path,indexBytes,{mode:0o600}),policy);
  const requestEvidence=config.missingRequest?undefined:await persistCrawlRequestEvidence(rawRoot,{schemaVersion:'stadtstack-crawl-request-evidence-v1',httpObservation:binding,request:{url,method:config.post?'POST':'GET',contentType:config.post?'application/x-www-form-urlencoded;charset=UTF-8':null,bodySha256:publicSelector===null?null:digest(publicSelector),publicSelector},redirectChain:[url]},policy);
  const manifest={index:{path,sha256:indexHash},rawRoot,registry:registry.registryPin,observations,documents:[{documentId:label,scope,permission:{kind:'facts_with_attribution' as const},bounds,requestEvidence}]};
  if(config.selectExtra){
   const extraBinding=bindings[1],extraEvidence=await persistCrawlRequestEvidence(rawRoot,{schemaVersion:'stadtstack-crawl-request-evidence-v1',httpObservation:extraBinding,request:{url:extraBinding.url,method:'GET',contentType:null,bodySha256:null,publicSelector:null},redirectChain:[extraBinding.url]},policy);
   manifest.documents.push({...manifest.documents[0],documentId:documents[1].id,requestEvidence:extraEvidence});
  }
  return {manifest,indexBytes,cas:new DistrictCas(casRoot),bytes,binding,observationBytes,document,robotsAbsencePin};
 }
 await t.test('legacy registered discovery is re-derived only from authenticated retained HTML edges',async st=>{
  const registeredValue=operatorRegistryFixtureValue(),registeredCity=registeredValue.municipalities[0],rootUrl='https://www.stadt-strausberg.de/bauleitplanung-2/',robotsBody='User-agent: *\nAllow: /\n';
  registeredCity.id='strausberg';registeredCity.ags='12064472';registeredValue.inventory[0].ags=registeredCity.ags;
  const registeredSource=registeredCity.sources.find(row=>row.kind==='participation')!;
  Object.assign(registeredSource,{id:'strausberg-planning',url:rootUrl,checkState:'checked',checkedAt:now,crawlScope:{pageRoots:[rootUrl],followLinkedDocuments:true},evidence:[{url:rootUrl,locator:'Synthetic registered-source configuration only',sha256:digest('synthetic registered source'),retrievedAt:now}]});
  const registered=await createOperatorRegistryFixture(st,{context:{root:root!,policy},value:registeredValue,label:'legacy-discovery-registry'});
  const registeredScope={...scope,sourceId:registeredSource.id};
  async function legacy(label:string,config:{absentLink?:boolean;missingParent?:boolean;tamperedParent?:boolean;foreignChild?:boolean;foreignParentScope?:boolean;reservedParent?:boolean;reservedChild?:boolean;multiHop?:boolean;expired?:boolean;cycle?:boolean;ambiguousParent?:boolean;scopedPrefix?:boolean;fresh?:boolean;evidenceRows?:number;parentEvidence?:'missing-policy'|'missing-robots-clock'|'missing-tdm-clock'|'invalid-policy-metadata'}={}){
   const rawRoot=join(root!,label+'-raw'),indexRoot=join(root!,label+'-index'),casRoot=join(root!,label+'-cas');
   for(const [path,kind] of [[rawRoot,'fetch'],[indexRoot,'artifacts'],[casRoot,'artifacts']] as const)await initializeManagedAcquisitionLane(path,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind});
   const checkedAt=new Date(Date.now()-(config.expired?8*86400000:config.fresh?3000:2*3600000)).toISOString(),childUrl=(config.foreignChild?'https://example.net':'https://www.stadt-strausberg.de')+'/wp-content/uploads/fixture/planunterlagen.txt',middleUrl=config.scopedPrefix?rootUrl+'unlinked/':'https://www.stadt-strausberg.de/archiv/planunterlagen.html';
   const documents:CrawlDocument[]=[],observations:Array<{path:string;sha256:string}>=[],bindings:Array<BoundSourceObservation['binding']>=[],originals:Array<{path:string;body:Buffer;observationPath:string;observationBytes:Buffer}>=[];
   async function original(id:string,url:string,body:Buffer,mimeType:string,from:string,reserved=false){
    const sha256=digest(body),observationId=`${Date.now()}-${randomUUID()}.json`,observationPath=join(rawRoot,'observations',observationId),sourcePolicy={robots:{state:'allowed' as const,url:'https://www.stadt-strausberg.de/robots.txt',sha256:digest(robotsBody),checkedAt},tdm:{state:reserved?'reserved' as const:'not_declared' as const,evidence:Array.from({length:config.evidenceRows??1},()=>({url:'https://www.stadt-strausberg.de/.well-known/tdmrep.json',locator:reserved?'W3C TDMRep origin rules':'TDMRep standardized location HTTP absence',value:reserved?'reservation=1':'404',checkedAt}))},access:'public' as const,legalClassification:'not_assessed' as const,publication:'facts_with_attribution_only' as const};
    const parentEvidence=id===label+'-root'?config.parentEvidence:undefined,observedPolicy=parentEvidence==='missing-policy'?undefined:parentEvidence==='missing-robots-clock'?{...sourcePolicy,robots:{...sourcePolicy.robots,checkedAt:undefined}}:parentEvidence==='missing-tdm-clock'?{...sourcePolicy,tdm:{...sourcePolicy.tdm,evidence:sourcePolicy.tdm.evidence.map(row=>({...row,checkedAt:undefined}))}}:parentEvidence==='invalid-policy-metadata'?{...sourcePolicy,tdm:{...sourcePolicy.tdm,evidence:Array.from({length:MAX_POLICY_METADATA_EVIDENCE+1},()=>sourcePolicy.tdm.evidence[0])}}:sourcePolicy;
    const observation={url,method:'GET',checkedAt,retrievedAt:checkedAt,state:'fetched',status:200,sha256,bytes:body.length,mimeType,policy:observedPolicy},observationBytes=Buffer.from(JSON.stringify(observation)+'\n'),binding:BoundSourceObservation['binding']={kind:'http_observation',url,sourceSha256:sha256,observationId,receiptSha256:digest(observationBytes)},path=join(rawRoot,'sha256',sha256);
    await withManagedSourceWrite(rawRoot,[{...binding,relativePath:'sha256/'+sha256,contentSha256:sha256,independentAllowed:!reserved}],async()=>{
     await mkdir(join(rawRoot,'sha256'),{recursive:true,mode:0o700});await mkdir(join(rawRoot,'observations'),{recursive:true,mode:0o700});await writeFile(path,body,{mode:0o600});await writeFile(observationPath,observationBytes,{mode:0o600});
    },policy);
    const document:CrawlDocument={id,municipalityId:registeredCity.id,ags:registeredCity.ags,districtId:registeredCity.districtId,sourceId:registeredSource.id,url,sha256,mimeType,retrievedAt:checkedAt,checkedAt,status:200,observationPath,documentDate:null,localPath:relative(indexRoot,path),adapter:'synthetic-old-crawl-fixture',metadata:{discoveredFrom:from},policy:sourcePolicy};
    documents.push(document);observations.push({path:observationPath,sha256:binding.receiptSha256});bindings.push(binding);originals.push({path,body,observationPath,observationBytes});return {document,binding};
   }
   let parent:CrawlDocument|undefined,middle:CrawlDocument|undefined;
   if(!config.missingParent){
    parent=(await original(label+'-root',rootUrl,Buffer.from(`<html><a href="${config.absentLink?'https://www.stadt-strausberg.de/other/planunterlagen.txt':config.multiHop?middleUrl:childUrl}">Synthetic planunterlagen</a></html>`),'text/html',rootUrl,config.reservedParent)).document;
    if(config.foreignParentScope)parent.sourceId='website';
    if(config.ambiguousParent)await original(label+'-other-root',rootUrl,Buffer.from(`<html><a href="${childUrl}">Another synthetic root observation</a></html>`),'text/html',rootUrl);
   }
   if(config.multiHop)middle=(await original(label+'-middle',middleUrl,Buffer.from(`<html><a href="${childUrl}">Synthetic planunterlagen</a>${config.cycle?`<a href="${middleUrl}">Cyclic synthetic planunterlagen</a>`:''}</html>`),'text/html',config.cycle?middleUrl:rootUrl)).document;
   const child=await original(label,childUrl,Buffer.from('Synthetic retained linked original; no real municipal claim'),'text/plain',config.multiHop?middleUrl:rootUrl,config.reservedChild);
   const path=join(indexRoot,'index.json'),indexBytes=Buffer.from(JSON.stringify({schemaVersion:'stadtstack-crawl-index-v1',generatedAt:checkedAt,documents})+'\n'),indexHash=digest(indexBytes);
   await withManagedSourceWrite(indexRoot,[...registered.admitted.bindings,...bindings].map(binding=>({...binding,relativePath:'index.json',contentSha256:indexHash,independentAllowed:false})),()=>writeFile(path,indexBytes,{mode:0o600}),policy);
   const requestEvidence=await persistCrawlRequestEvidence(rawRoot,{schemaVersion:'stadtstack-crawl-request-evidence-v1',httpObservation:child.binding,request:{url:childUrl,method:'GET',contentType:null,bodySha256:null,publicSelector:null},redirectChain:[childUrl]},policy);
   const manifest={index:{path,sha256:indexHash},rawRoot,registry:registered.registryPin,observations,documents:[{documentId:label,scope:registeredScope,permission:{kind:'facts_with_attribution' as const},bounds,requestEvidence}]};
   if(config.tamperedParent)await writeFile(originals[0].path,Buffer.from('Changed retained HTML bytes'),{mode:0o600});
   return {manifest,indexBytes,cas:new DistrictCas(casRoot),child:child.document,parent,middle,originals,checkedAt};
  }
  for(const multiHop of [false,true])await st.test(multiHop?'authenticated multi-hop parent retains the exact root anchor':'old direct-root link gets seven genuine days without a request',async()=>{
   const item=await legacy(multiHop?'registered-multi-hop':'registered-direct',{multiHop});
   await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
    const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.deepEqual(imported.holds,[]);assert.equal(imported.jobs.length,1);
    const job=imported.jobs[0],proof=await loadPolicyReceipt(item.cas,job.policyReceiptSha256),audit=readRegisteredRobotsAudit(proof.sourcePolicy.tdm.evidence,item.child.url)!;
    assert.equal(Date.parse(proof.expiresAt),Date.parse(item.checkedAt)+REGISTERED_SOURCE_POLICY_VALIDITY_MS);
    assert.equal(proof.registeredSourceEligibility!.discovery,undefined);assert.equal(audit.discovery!.from,multiHop?item.middle!.url:item.parent!.url);assert.equal(audit.discovery!.sha256,multiHop?item.middle!.sha256:item.parent!.sha256);
    assert.deepEqual(audit.discovery!.anchor,multiHop?{url:item.parent!.url,sha256:item.parent!.sha256}:undefined);
    assert.equal(proof.sourcePolicy.tdm.evidence[0].checkedAt,item.checkedAt);assert.deepEqual(proof.sourcePolicy.tdm.evidence.slice(1),(item.child.policy as BoundSourceObservation['policy']).tdm.evidence);
    assert.equal(proof.sourcePolicy.robots.checkedAt,item.checkedAt);assert.equal((await loadResidualSource(item.cas,job)).document.checkedAt,item.checkedAt);
    await enqueueResidualPreparation(store,item.cas,job);
    for(const original of item.originals){assert.deepEqual(await readFile(original.path),original.body);assert.deepEqual(await readFile(original.observationPath),original.observationBytes);}
    assert.deepEqual(await readFile(item.manifest.index.path),item.indexBytes);assert.equal(imported.coverage.acquisitionStepReceipts,0);
   });
  });
  for(const failure of [new CivicPolicyStateError('CIVIC_POLICY_BUSY'),new CivicPolicyStateError('CIVIC_POLICY_INVENTORY_UNAVAILABLE'),new SyntaxError('Synthetic lower-call state JSON parse failure'),new z.ZodError([{code:'custom',path:[],message:'Synthetic lower-call state schema parse failure'}]),Object.assign(new Error('Synthetic ancestor filesystem I/O failure'),{code:'EIO'}),Object.assign(new Error('Synthetic ancestor filesystem permission failure'),{code:'EACCES'}),new Error('Synthetic unrelated ancestor read failure')])await st.test('ancestor read propagates '+(failure instanceof CivicPolicyStateError?failure.code:failure.message),async rt=>{
   const item=await legacy('ancestor-failure-'+digest(failure instanceof CivicPolicyStateError?failure.code:failure.message).slice(0,8)),originalReadFile=fsPromises.readFile;
   let intercepted=0;
   rt.mock.method(fsPromises,'readFile',async(...args:Parameters<typeof fsPromises.readFile>)=>{
    if(String(args[0])===item.originals[0].path){intercepted++;throw failure;}
    return originalReadFile(...args);
   });syncBuiltinESMExports();
   try{
    await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>assert.rejects(importCrawlCorpusForResidual(store,item.cas,item.manifest),error=>error===failure));
    assert.equal(intercepted,1);
   }finally{rt.mock.restoreAll();syncBuiltinESMExports();}
   await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
    const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.deepEqual(imported.holds,[]);assert.equal(imported.jobs.length,1);
    assert.equal(Date.parse((await loadPolicyReceipt(item.cas,imported.jobs[0].policyReceiptSha256)).expiresAt),Date.parse(item.checkedAt)+REGISTERED_SOURCE_POLICY_VALIDITY_MS);
   });
  });
  for(const malformed of ['{','{}'])await st.test('parent managed authority '+(malformed==='{'?'JSON':'schema')+' corruption propagates instead of lineage fallback',async rt=>{
   const item=await legacy('parent-state-parse-'+digest(malformed).slice(0,8)),authorityPath=join(policy.stateDir,'authority.json'),authorityBytes=await readFile(authorityPath),originalOpen=fsPromises.open;
   let parentRead=false,injected=0;
   rt.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
    const path=String(args[0]);if(path===item.originals[0].path)parentRead=true;
    if(parentRead&&path===authorityPath&&injected===0&&new Error().stack?.includes('loadInventory')){
     injected++;await writeFile(authorityPath,malformed,{mode:0o600});
     const handle=await originalOpen(...args),close=handle.close.bind(handle);
     // Restore after the real bounded state reader captures invalid bytes, but
     // before its parser runs: later reads cannot create a misleading failure.
     handle.close=async()=>{try{await close();}finally{await writeFile(authorityPath,authorityBytes,{mode:0o600});}};
     return handle;
    }
    return originalOpen(...args);
   });syncBuiltinESMExports();
   try{
    await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>assert.rejects(importCrawlCorpusForResidual(store,item.cas,item.manifest),(error:unknown)=>error instanceof CivicPolicyStateError&&error.code==='CIVIC_POLICY_INVENTORY_UNAVAILABLE'));
    assert.equal(injected,1);
   }finally{rt.mock.restoreAll();syncBuiltinESMExports();await writeFile(authorityPath,authorityBytes,{mode:0o600});}
   assert.deepEqual(await readFile(authorityPath),authorityBytes);
   await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
    const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.deepEqual(imported.holds,[]);assert.equal(imported.jobs.length,1);
    assert.equal(Date.parse((await loadPolicyReceipt(item.cas,imported.jobs[0].policyReceiptSha256)).expiresAt),Date.parse(item.checkedAt)+REGISTERED_SOURCE_POLICY_VALIDITY_MS);
   });
  });
  await st.test('authenticated discovery survives authorized refresh and expired queued preparation continuation',async rt=>{
   const item=await legacy('registered-refresh'),seen:string[]=[];
   interface WireSeam {wire(url:URL):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>}
   rt.mock.method(PoliteFetcher.prototype as unknown as WireSeam,'wire',async(url:URL)=>{
    seen.push(url.pathname);
    if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from(robotsBody)};
    if(url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
    throw Error('Registered refresh must not refetch original or discovery parent');
   });
   await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
    const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.deepEqual(imported.holds,[]);
    const original=imported.jobs[0],pinned=await loadPolicyReceipt(item.cas,original.policyReceiptSha256),preparationKey=await enqueueResidualPreparation(store,item.cas,original);
    const nextTime=new Date(Date.parse(pinned.expiresAt)+1000);
    rt.mock.timers.enable({apis:['Date'],now:nextTime});
    try{await assert.rejects(recheckResidualPolicy(store,item.cas,original),(error:unknown)=>error instanceof DistrictExecutionHold&&error.reasonCode==='source_policy_stale');}finally{rt.mock.timers.reset();}
    const enqueued=await enqueueCrawlPolicyRefresh(store,item.cas,{manifest:item.manifest,maxRequests:4});assert.deepEqual(enqueued.holds,[]);assert.equal(enqueued.jobKeys.length,1);
    const jobKey=enqueued.jobKeys[0].jobKey,authorizationId=await store.authorize({approvalSha256:digest('Synthetic registered refresh authorization '+jobKey),approvedBy:'synthetic-fixture-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[jobKey],ags:[registeredScope.ags],maxJobs:1,maxElapsedMs:60000,category:'development'});
    const handler=policyRefreshHandler(store,(context,maxRequests)=>createR1PublicFetcher(store,context,{maxRequests,maxBytes:1024*1024,fixture:{fetchRoot:join(root!,'registered-refresh-fetch'),policy,inspection:fixturePolicyInspection}}));
    // Only policy-operation fixture time advances; queue leases/receipts use PG time.
    const run=await runDistrictJobs({store,cas:item.cas,handlers:{policy_refresh:async context=>{
     rt.mock.timers.enable({apis:['Date'],now:nextTime});
     try{return await handler(context);}finally{rt.mock.timers.reset();}
    }},authorizationId,ownerPresent:true,maxJobs:1,maxElapsedMs:60000,leaseMs:60000});
    const rows=await pool!.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE run_id=$1',[run.runId]),committed=rows.rows[0];
    assert.equal(committed.receipt.outcome,'succeeded');assert.deepEqual(seen,['/robots.txt','/.well-known/tdmrep.json']);
    const output=JSON.parse((await item.cas.read(committed.receipt.outputHashes[0])).toString('utf8')),current=await loadPolicyReceipt(item.cas,output.job.policyReceiptSha256);
    assert.equal(recordedPolicyIdentity(current.sourcePolicy),recordedPolicyIdentity(pinned.sourcePolicy));
    assert.deepEqual(current.sourcePolicy.tdm.evidence[0],pinned.sourcePolicy.tdm.evidence[0]);assert.equal(current.registeredSourceEligibility!.discovery,undefined);
    assert.equal(Date.parse(current.expiresAt),nextTime.getTime()+REGISTERED_SOURCE_POLICY_VALIDITY_MS);
    assert.deepEqual(output.job.httpObservation,original.httpObservation);
    const refreshSpec=(await pool!.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[jobKey])).rows[0].spec,refreshManifestPath=join(item.cas.root,'sha256',refreshSpec.selector.manifestSha256.slice(0,2),refreshSpec.selector.manifestSha256);
    rt.mock.timers.enable({apis:['Date'],now:nextTime});
    try{
     const originalOpen=fsPromises.open,failure=new CivicPolicyStateError('CIVIC_POLICY_BUSY');let intercepted=false;
     rt.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
      if(String(args[0])===refreshManifestPath){intercepted=true;throw failure;}
      return originalOpen(...args);
     });syncBuiltinESMExports();
     try{await assert.rejects(recheckResidualPolicy(store,item.cas,original),error=>error===failure);assert.equal(intercepted,true);}
     finally{rt.mock.restoreAll();syncBuiltinESMExports();}
     const checked=await recheckResidualPolicy(store,item.cas,original);assert.deepEqual(checked.receipt,pinned);assert.equal(checked.continuation!.refreshStepReceiptSha256,committed.receipt_sha256);
     const queued=await pool!.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[preparationKey]);
     assert.deepEqual(await residualJobHandlersFor(pool!).residual_prepare.currentPolicy!(queued.rows[0].spec as DistrictJobSpec,item.cas),checked.continuation);
     assert.equal((await loadResidualSource(item.cas,original,{store})).policyCheck.currentReceipt.checkedAt,current.checkedAt);
    }finally{rt.mock.timers.reset();}
    for(const entry of item.originals){assert.deepEqual(await readFile(entry.path),entry.body);assert.deepEqual(await readFile(entry.observationPath),entry.observationBytes);}
    assert.deepEqual(await readFile(item.manifest.index.path),item.indexBytes);
   });
  });
  await st.test('full policy metadata preserves all 64 rows and the fresh one-hour receipt',async()=>{
   const item=await legacy('registered-full-evidence',{fresh:true,evidenceRows:MAX_POLICY_METADATA_EVIDENCE});
   await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
    const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.deepEqual(imported.holds,[]);assert.equal(imported.jobs.length,1);
    const proof=await loadPolicyReceipt(item.cas,imported.jobs[0].policyReceiptSha256);
    assert.equal(proof.sourcePolicy.tdm.evidence.length,64);assert.deepEqual(proof.sourcePolicy,item.child.policy);
    assert.equal(readRegisteredRobotsAudit(proof.sourcePolicy.tdm.evidence,item.child.url),undefined);
    assert.equal(Date.parse(proof.expiresAt),Date.parse(item.checkedAt)+3600000);
    for(const entry of item.originals){assert.deepEqual(await readFile(entry.path),entry.body);assert.deepEqual(await readFile(entry.observationPath),entry.observationBytes);}
   });
  });
  for(const parentEvidence of ['missing-policy','missing-robots-clock','missing-tdm-clock','invalid-policy-metadata'] as const)for(const fresh of [false,true])await st.test(parentEvidence+' parent '+(parentEvidence==='invalid-policy-metadata'?'cannot pass complete corpus custody':fresh?'keeps the fresh one-hour child':'keeps the stale child hold'),async()=>{
   const item=await legacy('parent-evidence-'+parentEvidence+'-'+fresh,{parentEvidence,fresh});
   await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
    const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);
    if(parentEvidence==='invalid-policy-metadata'){
     // Over-cap metadata cannot pass the preceding complete custody admission;
     // it is not a parent-only lineage defect and must still hold the index.
     assert.equal(imported.jobs.length,0);assert.deepEqual(imported.holds,[{documentId:item.child.id,reasonCode:'corpus_ancestry_unavailable'}]);
    }else if(fresh){
     assert.deepEqual(imported.holds,[]);assert.equal(imported.jobs.length,1);
     const proof=await loadPolicyReceipt(item.cas,imported.jobs[0].policyReceiptSha256);
     assert.deepEqual(proof.sourcePolicy,item.child.policy);assert.equal(readRegisteredRobotsAudit(proof.sourcePolicy.tdm.evidence,item.child.url),undefined);
     assert.equal(Date.parse(proof.expiresAt),Date.parse(item.checkedAt)+3600000);
    }else{assert.equal(imported.jobs.length,0);assert.deepEqual(imported.holds,[{documentId:item.child.id,reasonCode:'source_policy_stale'}]);}
    for(const original of item.originals){assert.deepEqual(await readFile(original.path),original.body);assert.deepEqual(await readFile(original.observationPath),original.observationBytes);}
    assert.deepEqual(await readFile(item.manifest.index.path),item.indexBytes);
   });
  });
  for(const [label,config,reason] of [
   ['absent-link',{absentLink:true},'source_policy_stale'],
   ['missing-parent',{missingParent:true},'source_policy_stale'],
   ['changed-parent',{tamperedParent:true},'source_policy_stale'],
   ['foreign-parent-scope',{foreignParentScope:true},'source_policy_stale'],
   ['ambiguous-parent',{ambiguousParent:true},'source_policy_stale'],
   ['cyclic-parent',{multiHop:true,cycle:true},'source_policy_stale'],
   ['unlinked-parent-under-root-prefix',{multiHop:true,absentLink:true,scopedPrefix:true},'source_policy_stale'],
   ['foreign-child',{foreignChild:true},'scope_mismatch'],
   // Full ancestry rejects non-independent reserved originals before derivation.
   ['reserved-parent',{reservedParent:true},'corpus_ancestry_unavailable'],
   ['reserved-child',{reservedChild:true},'corpus_ancestry_unavailable'],
   ['expired-seven-days',{expired:true},'source_policy_stale'],
  ] as const)await st.test(label+' does not obtain registered linked-document eligibility',async()=>{
   const item=await legacy('registered-'+label,config);
   await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
    const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.equal(imported.jobs.length,0);assert.deepEqual(imported.holds,[{documentId:item.child.id,reasonCode:reason}]);
    for(const original of item.originals)assert.deepEqual(await readFile(original.observationPath),original.observationBytes);
   });
  });
 });
 await t.test('happy GET/POST imports preserve exact bytes/clocks and enqueue genuine preparation jobs',async()=>{
  for(const post of [false,true]){
   const item=await fixture(post?'happy-post':'happy-get',{post,extra:true});
   assert.equal(authorizedPilotCorpusSchema.safeParse(item.manifest.index.sha256).success,false);
   const initialReceipts=await pool!.query('SELECT COUNT(*)::int AS count FROM district_pipeline.step_receipts');
   await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
    assert.equal(loadFrozenCorpusBytes(item.indexBytes,item.manifest.index.sha256).documents.length,2);
    assert.throws(()=>loadFrozenCorpusBytes(Buffer.from('tampered'),item.manifest.index.sha256),/hash mismatch/);
    const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);
    assert.equal(imported.jobs.length,1);assert.deepEqual(imported.holds,[]);assert.equal(imported.coverage.acquisitionStepReceipts,0);
    const job=ResidualInputSchema.parse(imported.jobs[0]);
    assert.deepEqual(await item.cas.read(job.corpusSha256),item.indexBytes);assert.deepEqual(await item.cas.read(item.document.sha256),item.bytes);assert.deepEqual(await item.cas.read(job.httpObservation.receiptSha256),item.observationBytes);
    await assertManagedSourceBindings(join(item.cas.root,'sha256',job.corpusSha256.slice(0,2),job.corpusSha256),[...registry.admitted.bindings,...job.corpusObservations],policy);
    const loaded=await loadResidualSource(item.cas,job);assert.equal(loaded.document.retrievedAt,item.document.retrievedAt);assert.equal(loaded.receipt.sourcePolicy.robots.checkedAt,item.document.checkedAt);
    const key=await enqueueResidualPreparation(store,item.cas,job);assert.match(key,/^[a-f0-9]{64}$/);
    const queued=await pool!.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[key]);assert.equal(queued.rows[0].spec.step,'residual_prepare');assert.equal(queued.rows[0].spec.selector.bounds.maxDocuments,1);
    const audit=await pool!.query("SELECT payload_json FROM district_pipeline.r1_metadata_snapshots WHERE kind='http_observation' AND payload_json->>'origin'='imported'");assert.ok(audit.rows.some(row=>row.payload_json.observationId===item.binding.observationId));
    const receipts=await pool!.query('SELECT COUNT(*)::int AS count FROM district_pipeline.step_receipts');assert.equal(receipts.rows[0].count,initialReceipts.rows[0].count);
    await assert.rejects(loadResidualSource(item.cas,{...job,corpusObservations:job.corpusObservations.slice(0,1)}));
   });
   assert.equal(authorizedPilotCorpusSchema.safeParse(item.manifest.index.sha256).success,false);
  }
 });
 await t.test('identical originals retain both HTTP admissions and later reobservation leaves queued jobs executable',async()=>{
  const item=await fixture('shared-original',{extra:true,sameBytes:true,selectExtra:true});
  await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
   const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.deepEqual(imported.holds,[]);assert.equal(imported.jobs.length,2);
   const keys:string[]=[];
   for(const job of imported.jobs){const loaded=await loadResidualSource(item.cas,job);assert.equal(loaded.document.sha256,item.document.sha256);keys.push(await enqueueResidualPreparation(store,item.cas,job));}
   assert.notEqual(keys[0],keys[1]);assert.notEqual(imported.jobs[0].httpObservation.observationId,imported.jobs[1].httpObservation.observationId);
   const later=await fixture('reobserved-original',{body:item.bytes,url:item.document.url,casRoot:item.cas.root});
   await withFixtureAuthorizedCorpus(later.indexBytes,policy,async()=>{
    const reimported=await importCrawlCorpusForResidual(store,later.cas,later.manifest);assert.deepEqual(reimported.holds,[]);assert.equal(reimported.jobs.length,1);await enqueueResidualPreparation(store,later.cas,reimported.jobs[0]);
   });
   for(let index=0;index<keys.length;index++){
    const queued=await pool!.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[keys[index]]),loaded=await loadResidualSource(item.cas,queued.rows[0].spec.selector);
    assert.equal(loaded.sourceBinding.observationId,imported.jobs[index].httpObservation.observationId);assert.deepEqual(await item.cas.read(loaded.document.sha256),item.bytes);
   }
  });
 });
 await t.test('unauthorized synthetic index is not admitted outside the fixture capability',async()=>{
  const item=await fixture('unauthorized');await assert.rejects(importCrawlCorpusForResidual(store,item.cas,item.manifest),/owner-authorized/);
 });
 await t.test('tampered original cannot become a residual job',async()=>{
  const item=await fixture('tampered');await writeFile(join(item.manifest.rawRoot,'sha256',item.document.sha256),Buffer.from('changed'),{mode:0o600});
  await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.equal(imported.jobs.length,0);assert.equal(imported.holds[0].reasonCode,'original_observation_invalid');});
 });
 await t.test('stale actual source policy is held without refreshing its clocks',async()=>{
  const item=await fixture('stale',{stale:true});
  await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.deepEqual(imported.holds,[{documentId:'stale',reasonCode:'source_policy_stale'}]);assert.equal(imported.jobs.length,0);assert.deepEqual(await readFile(item.document.observationPath),item.observationBytes);});
 });
 await t.test('scope mismatch stays held',async()=>{
  const item=await fixture('scope');item.manifest.documents[0].scope={...scope,ags:'12064227'};
  await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.equal(imported.jobs.length,0);assert.equal(imported.holds[0].reasonCode,'scope_mismatch');});
 });
 await t.test('missing observation prevents partial-ancestry index duplication',async()=>{
  const item=await fixture('missing');await unlink(item.document.observationPath);
  await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.equal(imported.jobs.length,0);assert.equal(imported.holds[0].reasonCode,'corpus_ancestry_unavailable');await assert.rejects(item.cas.read(item.manifest.index.sha256));});
 });
 await t.test('legacy observations lacking original request/redirect evidence hold, never guessed GET selectors',async()=>{
  const item=await fixture('legacy',{missingRequest:true});
  await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{const imported=await importCrawlCorpusForResidual(store,item.cas,item.manifest);assert.equal(imported.jobs.length,0);assert.equal(imported.holds[0].reasonCode,'request_evidence_unavailable');});
 });
 for(const absence of [undefined,404] as const)await t.test(`durable authorized refresh admits stale originals (${absence??'robots body'}), preserves ancestry, and expires at its genuine new boundary`,async st=>{
  const robotsBody='User-agent: *\nAllow: /\n',item=await fixture('refresh-stale-'+(absence??'body'),{stale:true,robotsBody,robotsAbsence:absence}),seen:string[]=[];
  interface WireSeam {wire(url:URL,method:'GET'|'POST',body:string|undefined,validators:FetchObservation|undefined):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>}
  st.mock.method(PoliteFetcher.prototype as unknown as WireSeam,'wire',async (url:URL)=>{
   seen.push(url.pathname);
   if(url.pathname==='/robots.txt')return {status:absence??200,headers:{'content-type':'text/plain'},body:absence?Buffer.alloc(0):Buffer.from(robotsBody)};
   if(url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
   throw Error('Refresh must not refetch original body');
  });
  await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
   const queued=await enqueueCrawlPolicyRefresh(store,item.cas,{manifest:item.manifest,maxRequests:4});assert.deepEqual(queued.holds,[]);assert.equal(queued.jobKeys.length,1);
   const jobKey=queued.jobKeys[0].jobKey;
   const before=await importCrawlCorpusForResidual(store,item.cas,{...item.manifest,documents:item.manifest.documents.map(row=>({...row,policyRefreshJobKey:jobKey}))});assert.equal(before.jobs.length,0);
   const authorizationId=await store.authorize({approvalSha256:digest('Synthetic refresh fixture authorization '+jobKey),approvedBy:'synthetic-fixture-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[jobKey],ags:[scope.ags],maxJobs:1,maxElapsedMs:60000,category:'development'});
   const handler=policyRefreshHandler(store,(context,maxRequests)=>createR1PublicFetcher(store,context,{maxRequests,maxBytes:1024*1024,fixture:{fetchRoot:join(root!,'refresh-fetch'),policy,inspection:fixturePolicyInspection}}));
   const result=await runDistrictJobs({store,cas:item.cas,handlers:{policy_refresh:handler},authorizationId,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});assert.equal(result.jobsStarted,1);
   const row=await pool!.query('SELECT state FROM district_pipeline.jobs WHERE job_key=$1',[jobKey]);assert.equal(row.rows[0].state,'succeeded');
   assert.deepEqual(seen,['/robots.txt','/.well-known/tdmrep.json']);
   const receipts=await pool!.query('SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=$1',[result.runId]);
   const refreshOutput=JSON.parse((await item.cas.read(receipts.rows[0].receipt.outputHashes[0])).toString('utf8'));
   assert.deepEqual(refreshOutput.originalRobotsAbsence,item.robotsAbsencePin);
   const imported=await importCrawlCorpusForResidual(store,item.cas,{...item.manifest,documents:item.manifest.documents.map(row=>({...row,policyRefreshJobKey:jobKey}))});assert.deepEqual(imported.holds,[]);assert.equal(imported.jobs.length,1);
   const job=imported.jobs[0],source=await loadResidualSource(item.cas,job),proof=await loadPolicyReceipt(item.cas,job.policyReceiptSha256);
   assert.equal(source.document.checkedAt,item.document.checkedAt);assert.equal(source.document.retrievedAt,item.document.retrievedAt);assert.deepEqual(await readFile(item.document.observationPath),item.observationBytes);assert.deepEqual(await item.cas.read(item.document.sha256),item.bytes);
   assert.ok(Date.parse(proof.sourcePolicy.robots.checkedAt!)>Date.parse(item.document.checkedAt));
   assert.equal(Date.parse(proof.expiresAt),Math.min(Date.parse(proof.sourcePolicy.robots.checkedAt!),...proof.sourcePolicy.tdm.evidence.map(row=>Date.parse(row.checkedAt!)))+3600000);
   await enqueueResidualPreparation(store,item.cas,job);
   const mismatched={...item.manifest,documents:item.manifest.documents.map(row=>({...row,bounds:{...row.bounds,maxChunks:2},policyRefreshJobKey:jobKey}))};
   assert.equal((await importCrawlCorpusForResidual(store,item.cas,mismatched)).jobs.length,0);
   st.mock.timers.enable({apis:['Date'],now:new Date(proof.expiresAt)});
   await assert.rejects(recheckPolicyReceipt(proof,{...policy,evaluationAt:new Date().toISOString()}),/expired/);
   await assert.rejects(loadResidualSource(item.cas,job),(error:unknown)=>error instanceof DistrictExecutionHold&&error.reasonCode==='source_policy_stale');
   st.mock.timers.reset();
  });
 });
 await t.test('explicit receipt-bound generation renews an expired success without changing originals or bounds',async st=>{
  const robotsBody='User-agent: *\nAllow: /\n',item=await fixture('refresh-generation',{stale:true,robotsBody});
  interface WireSeam {wire(url:URL):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>}
  st.mock.method(PoliteFetcher.prototype as unknown as WireSeam,'wire',async(url:URL)=>{
   if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from(robotsBody)};
   if(url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
   throw Error('Generation must not refetch original body');
  });
  await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
   const handler=policyRefreshHandler(store,(context,maxRequests)=>createR1PublicFetcher(store,context,{maxRequests,maxBytes:1024*1024,fixture:{fetchRoot:join(root!,'generation-fetch'),policy,inspection:fixturePolicyInspection}}));
   const first=(await enqueueCrawlPolicyRefresh(store,item.cas,{manifest:item.manifest,maxRequests:4})).jobKeys[0].jobKey;
   const authorize=(jobKey:string)=>store.authorize({approvalSha256:digest('Synthetic generation authorization '+jobKey),approvedBy:'synthetic-fixture-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[jobKey],ags:[scope.ags],maxJobs:1,maxElapsedMs:60000,category:'development'});
   const firstAuthorization=await authorize(first);
   const firstRun=await runDistrictJobs({store,cas:item.cas,handlers:{policy_refresh:handler},authorizationId:firstAuthorization,ownerPresent:true,maxJobs:1,maxElapsedMs:60000,leaseMs:60000});
   const rows=await pool!.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE run_id=$1',[firstRun.runId]),firstReceipt=rows.rows[0];
   assert.equal(firstReceipt.receipt.outcome,'succeeded');
   const firstOutput=JSON.parse((await item.cas.read(firstReceipt.receipt.outputHashes[0])).toString('utf8')),firstProof=await loadPolicyReceipt(item.cas,firstOutput.job.policyReceiptSha256);
   const previous={documentId:item.document.id,jobKey:first,receiptSha256:firstReceipt.receipt_sha256},renewal={manifest:item.manifest,maxRequests:4,previousRefreshes:[previous]};
   await assert.rejects(enqueueCrawlPolicyRefresh(store,item.cas,{...renewal,previousRefreshes:[{...previous,receiptSha256:digest('forged predecessor pin')}]}),/StepReceipt pin/);
   const foreign=await fixture('foreign-generation',{stale:true,robotsBody});
   await withFixtureAuthorizedCorpus(foreign.indexBytes,policy,async()=>assert.rejects(enqueueCrawlPolicyRefresh(store,foreign.cas,{manifest:foreign.manifest,maxRequests:4,previousRefreshes:[{...previous,documentId:foreign.document.id}]}),/selected import/));
   const uncommitted=await fixture('uncommitted-generation',{stale:true,robotsBody});
   await withFixtureAuthorizedCorpus(uncommitted.indexBytes,policy,async()=>{
    const pending=(await enqueueCrawlPolicyRefresh(store,uncommitted.cas,{manifest:uncommitted.manifest,maxRequests:4})).jobKeys[0].jobKey;
    await assert.rejects(enqueueCrawlPolicyRefresh(store,uncommitted.cas,{manifest:uncommitted.manifest,maxRequests:4,previousRefreshes:[{documentId:uncommitted.document.id,jobKey:pending,receiptSha256:digest('no committed receipt')}]}),/not committed/);
   });
   const nextTime=new Date(Date.parse(firstProof.expiresAt)+1000);
   // Only the isolated public-policy fixture clock advances. Queue authorizations,
   // leases and StepReceipts continue to use their genuine disposable-PG clocks.
   st.mock.timers.enable({apis:['Date'],now:nextTime});
   let second:string;
   try{
    assert.equal((await importCrawlCorpusForResidual(store,item.cas,{...item.manifest,documents:item.manifest.documents.map(row=>({...row,policyRefreshJobKey:first}))})).jobs.length,0);
    second=(await enqueueCrawlPolicyRefresh(store,item.cas,renewal)).jobKeys[0].jobKey;
    assert.equal((await enqueueCrawlPolicyRefresh(store,item.cas,renewal)).jobKeys[0].jobKey,second);
   }finally{st.mock.timers.reset();}
   assert.notEqual(second,first);
   const secondAuthorization=await authorize(second);assert.notEqual(secondAuthorization,firstAuthorization);
   const secondRun=await runDistrictJobs({store,cas:item.cas,handlers:{policy_refresh:async context=>{
    st.mock.timers.enable({apis:['Date'],now:nextTime});
    try{return await handler(context);}finally{st.mock.timers.reset();}
   }},authorizationId:secondAuthorization,ownerPresent:true,maxJobs:1,maxElapsedMs:60000,leaseMs:60000});
   const secondRows=await pool!.query('SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=$1',[secondRun.runId]),secondReceipt=secondRows.rows[0].receipt;
   assert.equal(secondReceipt.outcome,'succeeded');assert.deepEqual(secondReceipt.dependencyReceiptIds,[firstReceipt.receipt.id]);
   const secondOutput=JSON.parse((await item.cas.read(secondReceipt.outputHashes[0])).toString('utf8'));
   assert.deepEqual(secondOutput.previousRefresh,{jobKey:first,receiptSha256:firstReceipt.receipt_sha256});
   st.mock.timers.enable({apis:['Date'],now:nextTime});
   try{
    const imported=await importCrawlCorpusForResidual(store,item.cas,{...item.manifest,documents:item.manifest.documents.map(row=>({...row,policyRefreshJobKey:second}))});
    assert.deepEqual(imported.holds,[]);assert.equal(imported.jobs.length,1);
    const current=await loadResidualSource(item.cas,imported.jobs[0]);assert.deepEqual(imported.jobs[0].bounds,bounds);assert.ok(Date.parse(current.receipt.expiresAt)>Date.parse(firstProof.expiresAt));
   }finally{st.mock.timers.reset();}
   assert.deepEqual(await readFile(item.document.observationPath),item.observationBytes);assert.deepEqual(await item.cas.read(item.document.sha256),item.bytes);
  });
 });
 await t.test('expired queued policy continues only through current unchanged committed refresh and records real rebinding',async st=>{
  const relationQuote='Synthetic Werk genehmigt Synthetic Projekt.';
  const caseText='Synthetic Strausberg fixture hat den Plan am 13.10.2026 als Satzung beschlossen. Stand: 13.10.2026.\n'+relationQuote;
  const robotsBody='User-agent: *\nAllow: /\n',item=await fixture('refresh-continuation',{stale:true,robotsBody,body:Buffer.from(caseText)});let stricter=false;
  interface WireSeam {wire(url:URL):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>}
  st.mock.method(PoliteFetcher.prototype as unknown as WireSeam,'wire',async(url:URL)=>{
   if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from(stricter?'User-agent: *\nDisallow: /\n':robotsBody)};
   if(url.pathname==='/.well-known/tdmrep.json')return {status:404,headers:{},body:Buffer.alloc(0)};
   throw Error('Continuation must not refetch original body');
  });
  await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
   const handler=policyRefreshHandler(store,(context,maxRequests)=>createR1PublicFetcher(store,context,{maxRequests,maxBytes:1024*1024,fixture:{fetchRoot:join(root!,'continuation-fetch'),policy,inspection:fixturePolicyInspection}}));
   const authorize=(jobKey:string,phase='initial',expiresAt=new Date(Date.now()+60000).toISOString(),maxElapsedMs=60000)=>store.authorize({approvalSha256:digest('Synthetic continuation authorization '+jobKey+' '+phase),approvedBy:'synthetic-fixture-owner',expiresAt,jobKeys:[jobKey],ags:[scope.ags],maxJobs:1,maxElapsedMs,category:'development'});
   const first=(await enqueueCrawlPolicyRefresh(store,item.cas,{manifest:item.manifest,maxRequests:4})).jobKeys[0].jobKey;
   const firstAuthorization=await authorize(first),historicalTime=new Date(Date.now()-3601000);
   // Genuine fixture policy observations are captured at this controlled earlier
   // fixture time, not rewritten later. Real queue/PG receipt clocks are untouched.
   const firstRun=await runDistrictJobs({store,cas:item.cas,handlers:{policy_refresh:async context=>{
    st.mock.timers.enable({apis:['Date'],now:historicalTime});
    try{return await handler(context);}finally{st.mock.timers.reset();}
   }},authorizationId:firstAuthorization,ownerPresent:true,maxJobs:1,maxElapsedMs:60000,leaseMs:60000});
   const firstRows=await pool!.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE run_id=$1',[firstRun.runId]),firstReceipt=firstRows.rows[0];
   assert.equal(firstReceipt.receipt.outcome,'succeeded');
   const firstOutput=JSON.parse((await item.cas.read(firstReceipt.receipt.outputHashes[0])).toString('utf8')),original=ResidualInputSchema.parse(firstOutput.job),pinned=await loadPolicyReceipt(item.cas,original.policyReceiptSha256);
   assert.ok(Date.parse(pinned.expiresAt)<Date.now());
   let preparationKey:string;
   st.mock.timers.enable({apis:['Date'],now:new Date(pinned.checkedAt)});
   try{preparationKey=await enqueueResidualPreparation(store,item.cas,original);}finally{st.mock.timers.reset();}
   const stale=(error:unknown)=>error instanceof DistrictExecutionHold&&error.reasonCode==='source_policy_stale';
   await assert.rejects(recheckResidualPolicy(store,item.cas,original),stale);
   const production=residualJobHandlersFor(pool!),deniedAuthorization=await authorize(preparationKey,'stale-hold');
   const denied=await runDistrictJobs({store,cas:item.cas,handlers:production,authorizationId:deniedAuthorization,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
   assert.equal(denied.jobsStarted,0);assert.equal(denied.reasonCode,'source_policy_stale');
   const foreign=await fixture('foreign-continuation',{stale:true,robotsBody,body:item.bytes,url:item.document.url,casRoot:item.cas.root});
   await withFixtureAuthorizedCorpus(foreign.indexBytes,policy,async()=>{
    const foreignKey=(await enqueueCrawlPolicyRefresh(store,foreign.cas,{manifest:foreign.manifest,maxRequests:4})).jobKeys[0].jobKey;
    const foreignAuthorization=await authorize(foreignKey);
    const foreignHandler=policyRefreshHandler(store,(context,maxRequests)=>createR1PublicFetcher(store,context,{maxRequests,maxBytes:1024*1024,fixture:{fetchRoot:join(root!,'foreign-continuation-fetch'),policy,inspection:fixturePolicyInspection}}));
    const foreignRun=await runDistrictJobs({store,cas:foreign.cas,handlers:{policy_refresh:foreignHandler},authorizationId:foreignAuthorization,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
    const state=await pool!.query('SELECT state FROM district_pipeline.jobs WHERE job_key=$1',[foreignKey]);assert.equal(state.rows[0].state,'succeeded');assert.equal(foreignRun.jobsStarted,1);
   });
   // Same URL, body bytes, realm and scope do not substitute a different original
   // observation/index: the foreign refresh above must not unblock this job.
   await assert.rejects(recheckResidualPolicy(store,item.cas,original),stale);
   const previous={documentId:item.document.id,jobKey:first,receiptSha256:firstReceipt.receipt_sha256},renewal={manifest:item.manifest,maxRequests:4,previousRefreshes:[previous]};
   await assert.rejects(enqueueCrawlPolicyRefresh(store,item.cas,{...renewal,maxRequests:5}),/request bounds/);
   const second=(await enqueueCrawlPolicyRefresh(store,item.cas,renewal)).jobKeys[0].jobKey,secondAuthorization=await authorize(second);
   const secondRun=await runDistrictJobs({store,cas:item.cas,handlers:{policy_refresh:handler},authorizationId:secondAuthorization,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
   const secondRows=await pool!.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE run_id=$1',[secondRun.runId]),secondReceipt=secondRows.rows[0];assert.equal(secondReceipt.receipt.outcome,'succeeded');
   const checked=await recheckResidualPolicy(store,item.cas,original);assert.equal(checked.receiptSha256,original.policyReceiptSha256);assert.deepEqual(checked.receipt,pinned);assert.equal(checked.continuation!.refreshStepReceiptSha256,secondReceipt.receipt_sha256);
   assert.deepEqual(checked.versions,{[`policyRebinding.${original.policyReceiptSha256}.${secondReceipt.receipt_sha256}`]:checked.admissibilityReceiptSha256});
   const loaded=await loadResidualSource(item.cas,original,{store});assert.deepEqual(loaded.receipt,pinned);assert.equal(loaded.policyCheck.admissibilityReceiptSha256,checked.admissibilityReceiptSha256);
   const textOutput:{parserSha256?:string;textSha256?:string}={};
   // Decode the real synthetic original text in-process, without Docker or a
   // parser review. Source contract/Node version are actual; the explicitly
   // synthetic image identity is fixture metadata, never authorization evidence.
   const fixtureToolVersions={node:process.versions.node,parser_contract:await parserOutputContractSha256(),parser_isolation:PARSER_ISOLATION_VERSION,parser_image:'sha256:'+digest('Synthetic policy-continuation fixture image; no Docker used')};
   const prepareFixture:JobHandler=async context=>{
    const selected=ResidualInputSchema.strip().parse(context.job.spec.selector),source=await loadResidualSource(context.cas,selected,{store}),bytes=await context.cas.read(source.document.sha256);
    const selector=context.job.spec.selector as {contract:{preparationSha256:string}};
    const prepared=await prepareDocument({bytes,municipalityId:source.municipality.id,references:[source.reference],mimeType:source.document.mimeType,extractorSha256:selector.contract.preparationSha256,toolVersions:fixtureToolVersions,managedRoot:join(context.cas.root,'continuation-prepared'),policy,sourceBindings:[source.sourceBinding],signal:context.signal},async()=>assert.fail('Plain-text fixture has no subprocess'));
    const persist=async(value:Buffer,kind:'parser_output'|'derived',mimeType:string)=>{
     const hash=digest(value),artifact=await withManagedSourceWrite(context.cas.root,[{...source.sourceBinding,relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,independentAllowed:true}],()=>context.cas.put(value,{kind,mimeType}),policy);
     await store.addArtifact(artifact);return artifact;
    };
    const parser=await persist(Buffer.from(canonicalJson(prepared)),'parser_output','application/json'),text=await persist(Buffer.from(prepared.text),'derived','text/plain');
    textOutput.parserSha256=parser.sha256;textOutput.textSha256=text.sha256;
    return {outcome:'succeeded',reasonCode:'completed',outputs:[parser,text],versions:{preparation:prepared.extractorSha256,...fixtureToolVersions,...source.policyCheck.versions},counts:{bytes:bytes.length}};
   };
   prepareFixture.currentPolicy=production.residual_prepare.currentPolicy;
   for(const code of ['CIVIC_POLICY_BUSY','CIVIC_POLICY_INVENTORY_UNAVAILABLE'])for(const phase of ['claim','finish'] as const)await st.test(phase+' continuation preserves '+code+' as an execution hold',async()=>{
    await store.resume(preparationKey);
    const before=(await pool!.query('SELECT attempt FROM district_pipeline.jobs WHERE job_key=$1',[preparationKey])).rows[0],failure=new CivicPolicyStateError(code);
    let hookCalls=0,handlerCalls=0;
    const guardedPrepare:JobHandler=async context=>{handlerCalls++;return prepareFixture(context);};
    guardedPrepare.currentPolicy=async(spec,cas)=>{
     const continuation=await production.residual_prepare.currentPolicy!(spec,cas);
     if(++hookCalls===(phase==='claim'?1:2))throw failure;
     return continuation;
    };
    const result=await runDistrictJobs({store,cas:item.cas,handlers:{residual_prepare:guardedPrepare},authorizationId:await authorize(preparationKey,code+'-'+phase),ownerPresent:true,maxJobs:1,maxElapsedMs:60000,leaseMs:60000});
    assert.equal(result.state,'held');assert.equal(result.reasonCode,'execution_exception');assert.equal(result.jobsStarted,phase==='claim'?0:1);
    assert.equal(hookCalls,phase==='claim'?1:2);assert.equal(handlerCalls,phase==='claim'?0:1);
    const after=(await pool!.query('SELECT state,reason_code,attempt,lease_owner FROM district_pipeline.jobs WHERE job_key=$1',[preparationKey])).rows[0];
    assert.equal(after.state,'held_execution');assert.equal(after.reason_code,'execution_exception');assert.equal(after.attempt,before.attempt+(phase==='claim'?0:1));assert.equal(after.lease_owner,null);
    const receipts=await pool!.query('SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=$1',[result.runId]);assert.equal(receipts.rowCount,phase==='claim'?0:1);
    for(const row of receipts.rows){assert.equal(row.receipt.outcome,'held_execution');assert.equal(row.receipt.reasonCode,'execution_exception');assert.deepEqual(row.receipt.outputHashes,[]);}
    assert.equal((await pool!.query("SELECT id FROM district_pipeline.step_receipts WHERE run_id=$1 AND (outcome='succeeded' OR receipt->>'reasonCode'='source_policy_stale')",[result.runId])).rowCount,0);
   });
   for(const bound of ['lease','authorization'] as const)await st.test(`finish continuation crossing ${bound} deadline cannot commit successful effects`,async()=>{
    await store.resume(preparationKey);
    const authorizationId=await authorize(preparationKey,'delayed-finish-'+bound,bound==='authorization'?new Date(Date.now()+30000).toISOString():undefined);
    let hookCalls=0;
    const guardedPrepare:JobHandler=context=>prepareFixture(context);
    guardedPrepare.currentPolicy=async(spec,cas)=>{
     const continuation=await production.residual_prepare.currentPolicy!(spec,cas);
     if(++hookCalls===2){
      // Wait against the actual persisted PG deadline. The hook does not move
      // clocks, mutate authority or invent a continuation/receipt.
      if(bound==='lease')await pool!.query(`SELECT pg_sleep(GREATEST(0,extract(epoch FROM(lease_expires_at-clock_timestamp())))+0.05) FROM district_pipeline.jobs WHERE job_key=$1`,[preparationKey]);
      else await pool!.query(`SELECT pg_sleep(GREATEST(0,extract(epoch FROM(expires_at-clock_timestamp())))+0.05) FROM district_pipeline.preauthorizations WHERE id=$1`,[authorizationId]);
     }
     return continuation;
    };
    const result=await runDistrictJobs({store,cas:item.cas,handlers:{residual_prepare:guardedPrepare},authorizationId,ownerPresent:true,maxJobs:1,maxElapsedMs:60000,leaseMs:5000});
    const reason=bound==='lease'?'lease_lost':'authorization_expired';
    assert.equal(hookCalls,2);assert.equal(result.jobsStarted,1);assert.equal(result.state,'held');assert.equal(result.reasonCode,reason);
    const rows=await pool!.query('SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=$1',[result.runId]);
    assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].receipt.outcome,'held_execution');assert.equal(rows.rows[0].receipt.reasonCode,reason);assert.deepEqual(rows.rows[0].receipt.outputHashes,[]);
    assert.equal((await pool!.query(`SELECT id FROM district_pipeline.step_receipts WHERE run_id=$1 AND outcome='succeeded'`,[result.runId])).rowCount,0);
   });
   await st.test('claim continuation crossing authorization deadline grants no lease or attempt',async()=>{
    await store.resume(preparationKey);
    const authorizationId=await authorize(preparationKey,'delayed-claim',new Date(Date.now()+15000).toISOString());
    const before=await pool!.query('SELECT attempt FROM district_pipeline.jobs WHERE job_key=$1',[preparationKey]);let hookCalls=0,handlerCalls=0;
    const guardedPrepare:JobHandler=async context=>{handlerCalls++;return prepareFixture(context);};
    guardedPrepare.currentPolicy=async(spec,cas)=>{
     const continuation=await production.residual_prepare.currentPolicy!(spec,cas);hookCalls++;
     await pool!.query(`SELECT pg_sleep(GREATEST(0,extract(epoch FROM(expires_at-clock_timestamp())))+0.05) FROM district_pipeline.preauthorizations WHERE id=$1`,[authorizationId]);
     return continuation;
    };
    const result=await runDistrictJobs({store,cas:item.cas,handlers:{residual_prepare:guardedPrepare},authorizationId,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
    assert.equal(hookCalls,1);assert.equal(handlerCalls,0);assert.equal(result.jobsStarted,0);assert.equal(result.state,'held');assert.equal(result.reasonCode,'authorization_expired');
    const after=await pool!.query('SELECT state,attempt,lease_owner FROM district_pipeline.jobs WHERE job_key=$1',[preparationKey]);
    assert.equal(after.rows[0].state,'queued');assert.equal(after.rows[0].attempt,before.rows[0].attempt);assert.equal(after.rows[0].lease_owner,null);
    assert.equal((await pool!.query('SELECT id FROM district_pipeline.step_receipts WHERE run_id=$1',[result.runId])).rowCount,0);
   });
   const preparationAuthorization=await authorize(preparationKey,'after-owner-resume',new Date(Date.now()+120000).toISOString(),120000);
   const preparedRun=await runDistrictJobs({store,cas:item.cas,handlers:{residual_prepare:prepareFixture},authorizationId:preparationAuthorization,ownerPresent:true,maxJobs:1,maxElapsedMs:120000});
   assert.equal(preparedRun.jobsStarted,1,canonicalJson(preparedRun));
   const preparationRows=await pool!.query('SELECT receipt FROM district_pipeline.step_receipts WHERE run_id=$1',[preparedRun.runId]),preparedReceipt=preparationRows.rows[0].receipt;
   assert.equal(preparedReceipt.outcome,'succeeded');assert.equal(preparedReceipt.policyProofSha256,original.policyReceiptSha256);
   assert.equal(preparedReceipt.versions[`policyRebinding.${original.policyReceiptSha256}.${secondReceipt.receipt_sha256}`],checked.admissibilityReceiptSha256);
   const prepared=JSON.parse((await item.cas.read(textOutput.parserSha256!)).toString('utf8')),rubric='Synthetic exact-original policy continuation fixture';
   const locators=[{id:'synthetic-original',page:null,table:null,start:0,end:prepared.text.length}];
   const assessmentContext=buildPreparedAssessmentContext(prepared.text,prepared.textSha256,{index:0,count:1,start:0,end:prepared.text.length},[`text-sha256:${prepared.textSha256};chars:0-${prepared.text.length}`],locators);
   const assessment=assessmentItemSchema.parse({version:'assessment-item-v1',itemId:'synthetic-continuation-item',question:'Is this exact original available?',claim:canonicalJson({quote:prepared.text}),rubric,rubricSha256:digest(rubric),sources:[{sourceId:scope.sourceId,originalSha256:item.document.sha256,textSha256:textOutput.textSha256,parserVersion:prepared.extractorSha256,parserReceiptSha256:textOutput.parserSha256,admissionReceiptSha256:original.policyReceiptSha256,ocrSuspected:false,locators,assessmentContext}],claimIds:['synthetic-original-claim'],entityIds:[],constraints:[],criticalKinds:[]});
   await assert.rejects(originalEvidence(assessment,{cas:item.cas,policyOptions:policy}),/expired/);
   const evidence=await originalEvidence(assessment,{cas:item.cas,policyOptions:policy,currentAdmissionReceipts:{[original.policyReceiptSha256]:checked.admissibilityReceiptSha256}});
   assert.equal(evidence[0].admissionReceiptSha256,original.policyReceiptSha256);assert.equal(evidence[0].locators[0].quote,prepared.text);
   // Genuine queue receipts link extraction -> preparation -> every assessment
   // stage. Native inference uses synthetic providers; no DocumentResult or model-answer cache envelope is hand-assembled.
   const extractionKey=await enqueueCommittedResidualExtraction(pool!,store,item.cas,preparationKey);
   let extractionFailure:unknown;
   const extractionFixture:JobHandler=async context=>{
    try{
    const selected=ResidualInputSchema.strip().parse(context.job.spec.selector),source=await loadResidualSource(context.cas,selected,{store});
    const putAssessment=async(value:unknown)=>{
     const bytes=value instanceof Buffer?value:Buffer.from(canonicalJson(value)),hash=digest(bytes);
     const artifact=await withManagedSourceWrite(context.cas.root,[{...source.sourceBinding,relativePath:`sha256/${hash.slice(0,2)}/${hash}`,contentSha256:hash,independentAllowed:true}],()=>context.cas.put(bytes,{kind:'derived',mimeType:'application/json'}),policy);
     await store.addArtifact(artifact);return artifact;
    };
    const selector=context.job.spec.selector as {contract:{extraction:{promptSha256:string;schemaSha256:string;extractorSha256:string}};preparationJobKey:string;preparationReceiptId:string;preparationReceiptSha256:string;preparedArtifactSha256:string};
    const prepared=PreparedDocumentSchema.parse(JSON.parse((await context.cas.read(selector.preparedArtifactSha256)).toString('utf8'))),supported=prepared.text.includes(caseText);
    const claims=DistrictExtractionClaimsSchema.parse({title:'Strausberg',titleQuote:'Strausberg',summary:caseText,summaryQuote:caseText,caseKey:null,caseKeyType:'source_document',caseQuote:null,caseType:'unknown',topics:[],stages:[],locations:[],municipalityQuote:city.name,stage:'adopted',stageQuote:'am 13.10.2026 als Satzung beschlossen',originalStatus:'als Satzung beschlossen',stageDate:'2026-10-13',stageDateQuote:'am 13.10.2026 als Satzung beschlossen',stageDateReason:null,documentDate:'2026-10-13',documentDateQuote:'Stand: 13.10.2026',documentDateReason:null,entities:[{mentionId:'werk',name:'Synthetic Werk',type:'organization',quote:relationQuote,identifiers:[]},{mentionId:'project',name:'Synthetic Projekt',type:'project',quote:relationQuote,identifiers:[]}],relations:[{fromMention:'werk',toMention:'project',type:'implements',quote:relationQuote,predicateQuote:'genehmigt',modality:'asserted',time:null,conditions:null}]});
    const out=join(root!,'synthetic-generation',context.job.jobKey),versions:Record<string,string>={};
    const generationArchive=await archiveJointExtractionContract(out,selector.contract.extraction,context.signal),archive=await putAssessment(await readFile(generationArchive.path));
    let identity:ModelEvidence|undefined,generationCalls=0;
    const result=await inferPreparedDocument({taskId:context.job.jobKey,groupId:semanticHash({municipalityId:source.municipality.id,sourceSha256:source.document.sha256}),provider:'openai-subscription',purpose:'production',municipality:source.municipality,prepared,expected:prepared,contract:selector.contract.extraction,out,policy,fixtureReadinessExecutor:async(_provider,args)=>({stdout:args[0]==='--version'?'codex-cli 0.0.0-synthetic-test-only':'Logged in using ChatGPT',stderr:'',code:0,failure:null}),usage:{
     ledgerPath:join(out,'usage.jsonl'),pausePath:join(out,'pause.json'),signal:context.signal,
     onModelIdentity:async evidence=>{identity=evidence;const stored=await putAssessment(evidence);versions['modelIdentity.'+evidence.modelIdentitySha256]=stored.sha256;},
     beforeSourceCall:request=>reserveR1CodexCall(pool!,context.job,source.document.sha256,request,selected.bounds.maxModelCalls).then(()=>{}),
     fixtureProvider:async(_provider,_system,_input,_schema,usage)=>{generationCalls++;assert.ok(identity);const value=usage.purpose==='extraction'?{record:supported?claims:null,reason:supported?'Synthetic grounded extraction fixture':'Synthetic narrative with no supported case'}:{score:0.95,reason:'Synthetic same-provider fixture judge, not independent gold',criticalUnsupported:false};return {value,evidence:identity,responseSha256:digest(canonicalJson(value)),requestedModel:identity.model,returnedModel:identity.model,reportedModels:[identity.model],runtimeWarnings:[],usage:{...EMPTY_USAGE,perModel:{}}};},
    }});
    assert.equal(generationCalls,supported?2:1);assert.equal(result.records.length,supported?1:0,canonicalJson(result.quarantine));
    assert.equal(result.chunks.length,result.records.length+result.quarantine.length);
    for(const hold of result.quarantine.filter(entry=>entry.reason==='Model input exceeds bounded context'))assert.deepEqual(result.chunks.find(chunk=>chunk.index===hold.chunk),{index:hold.chunk,outcome:'rejected',responseSha256:null,recordId:null});
    if(supported){
     assert.equal(result.records[0].relations[0].type,'approves');assert.equal(result.records[0].relations[0].modality,'decided');
     assert.equal(result.records[0].extraction.relationNormalization?.responseSha256,result.records[0].extraction.responseSha256);
     assert.equal(result.records[0].extraction.relationNormalization?.mappings[0].originalType,'implements');
    }
    Object.assign(versions,await captureResidualAnswers(out,prepared,policy,putAssessment));
    const envelope={schemaVersion:'district-residual-extraction-v1',documentId:selected.documentId,corpusSha256:selected.corpusSha256,registrySha256:selected.registrySha256,policyReceiptSha256:selected.policyReceiptSha256,preparationJobKey:selector.preparationJobKey,preparationReceiptId:selector.preparationReceiptId,preparationReceiptSha256:selector.preparationReceiptSha256,preparedArtifactSha256:selector.preparedArtifactSha256,result};
    return {outcome:supported?'succeeded':'no_supported_case',reasonCode:supported?'completed':'no_supported_case',outputs:[await putAssessment(envelope)],versions:{...source.policyCheck.versions,...versions,generationArchiveSha256:archive.sha256}};
    }catch(error){extractionFailure=error;throw error;}
   };
   extractionFixture.currentPolicy=production.residual_extract.currentPolicy;
   const extractionRun=await runDistrictJobs({store,cas:item.cas,handlers:{residual_extract:extractionFixture},authorizationId:await authorize(extractionKey,'synthetic-extraction'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
   assert.equal(extractionRun.state,'completed',canonicalJson(extractionRun)+(extractionFailure instanceof Error?'\n'+extractionFailure.stack:''));
   let modelCalls=0;
   const groundedAnswer=(input:AssessmentPassInput)=>{
    const response=answer(input),output=response.value as AssessmentOutput;
    const data=input.data as {criticalTarget?:unknown;evidence:{sourceId:string;locators:{id:string;quote:string}[]}[]};
    const target=CriticalRecordTargetSchema.strip().parse(data.criticalTarget);
    output.assertions=target.claims.map(claim=>({claimId:claim.claimId,sourceId:claim.sourceId,locatorId:data.evidence.find(source=>source.sourceId===claim.sourceId)!.locators.find(locator=>locator.quote===claim.quote)!.id,quote:claim.quote,subjectId:claim.subjectId,objectId:claim.objectId,value:null,unit:null,date:claim.date,dateRole:claim.dateRole,financialRole:claim.financialRoles[0],stage:claim.stage,modality:claim.modality}));
    output.criticalReview={recordId:target.recordId,recordEvidenceSha256:target.recordEvidenceSha256,claimProjectionSha256:target.claimProjectionSha256,claims:target.claims.map(claim=>({claimId:claim.claimId,claimSha256:claim.claimSha256,verdict:'supported',rationale:'Synthetic source-bound critical assessment; never independent gold.'}))};
    return {...response,value:output,responseSha256:digest(canonicalJson(output))};
   };
   const assessmentHandlers=assessmentQueueHandlers(pool!,{policyOptions:policy,fixtureProtocol:true,fixtureProvider:async input=>{modelCalls++;return groundedAnswer(input);}});
   const runAssessment=async(jobKey:string,phase:string,handlers:Readonly<Record<string,JobHandler>>=assessmentHandlers)=>runDistrictJobs({store,cas:item.cas,handlers,authorizationId:await authorize(jobKey,phase),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
   const assessmentPreparationKey=await enqueueResidualAssessmentItems(pool!,store,item.cas,extractionKey);
   const itemPreparation=await runAssessment(assessmentPreparationKey,'assessment-items');assert.equal(itemPreparation.state,'completed',canonicalJson(itemPreparation));
   const AJobKey=(await enqueuePreparedAssessmentPass(pool!,store,item.cas,assessmentPreparationKey,'A'))[0];
   const deniedA:JobHandler=context=>assessmentHandlers.assessment_a(context);
   deniedA.currentPolicy=async(spec,cas)=>{
    st.mock.timers.enable({apis:['Date'],now:new Date(checked.currentReceipt.expiresAt)});
    try{return await assessmentHandlers.assessment_a.currentPolicy!(spec,cas);}finally{st.mock.timers.reset();}
   };
   const noCurrent=await runAssessment(AJobKey,'assessment-stale-hold',{assessment_a:deniedA});
   assert.equal(noCurrent.reasonCode,'source_policy_stale');assert.equal(noCurrent.jobsStarted,0);assert.equal(modelCalls,0);
   await store.resume(AJobKey);
   assert.equal((await runAssessment(AJobKey,'assessment-newer-current-refresh')).state,'completed');
   const aSpec=(await pool!.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[AJobKey])).rows[0].spec;
   const assessmentItem=assessmentItemSchema.parse(JSON.parse((await item.cas.read(aSpec.selector.itemArtifactSha256)).toString('utf8')));
   const broker=new DistrictAssessmentBroker(pool!,item.cas,{policyOptions:policy,fixtureProtocol:true,currentAdmissionReceipts:{[original.policyReceiptSha256]:checked.admissibilityReceiptSha256}});
   const clientContractSha256=digest('synthetic governed continuation B client');
   const BJobKey=await enqueueAssessmentB(broker,{itemArtifactSha256:aSpec.selector.itemArtifactSha256,sourceScope:scope,policyProofSha256:original.policyReceiptSha256,transport:'mac-bridge',clientContractSha256});
   const BAuthorization=await authorize(BJobKey,'blind-B-current-refresh');
   const BApproval=await pool!.query<{expires_at:Date}>('SELECT expires_at FROM district_pipeline.preauthorizations WHERE id=$1',[BAuthorization]),readyDeadline=BApproval.rows[0].expires_at.getTime();
   const pendingB=runDistrictJobs({store,cas:item.cas,handlers:assessmentHandlers,authorizationId:BAuthorization,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
   for(;;){
    const ready=await pool!.query(`SELECT 1 FROM district_pipeline.assessment_bridge_leases b JOIN district_pipeline.jobs j ON j.id=b.job_id WHERE j.job_key=$1 AND b.state='ready'`,[BJobKey]);
    if(ready.rowCount)break;
    const disposition=await pool!.query('SELECT state,reason_code FROM district_pipeline.jobs WHERE job_key=$1',[BJobKey]);
    if(!['queued','leased'].includes(disposition.rows[0].state)||Date.now()>=readyDeadline)throw Error('Synthetic continuation B lease unavailable: '+canonicalJson(disposition.rows[0]));
    await delay(10);
   }
   const lease=BridgeLeaseSchema.parse(await broker.dispatch({operation:'claim',jobKey:BJobKey,clientId:'synthetic-continuation-client',clientContractSha256})),startedAt=new Date().toISOString();
   const blindInput=buildAssessmentPassInput(assessmentItem,await originalEvidence(assessmentItem,{cas:item.cas,policyOptions:policy,currentAdmissionReceipts:{[original.policyReceiptSha256]:checked.admissibilityReceiptSha256}}),'B');
   assert.equal(blindInput.assessments,null);
   const output=groundedAnswer(blindInput).value as AssessmentOutput,config=PROVIDER_CONFIGS['anthropic-subscription'];
   const identity={provider:'anthropic-subscription' as const,tool:'claude-cli' as const,toolVersion:'0.0.0-synthetic-test-only',model:config.model,modelIdentityBasis:config.modelIdentityBasis};
   const stdout=[{type:'system',subtype:'init',tools:[],mcp_servers:[],model:config.model},{type:'assistant',message:{id:'msg_synthetic_continuation',model:config.model,content:[]}},{type:'result',subtype:'success',is_error:false,model:config.model,request_id:'req_synthetic_continuation',structured_output:output,usage:{input_tokens:1,output_tokens:1}}].map(value=>JSON.stringify(value)).join('\n')+'\n';
   const finishedAt=new Date().toISOString(),completedAt=new Date().toISOString();
   const submitted=await broker.dispatch({operation:'submit',leaseId:lease.leaseId,inputSha256:lease.inputSha256,purgeAck:{sourceFiles:0,responseFiles:0,modelFileWritesDenied:true,completedAt},answer:{stdout,evidence:{...identity,modelIdentitySha256:digest(JSON.stringify(identity))},startedAt,finishedAt}});
   assert.equal(BridgeStatusSchema.parse(submitted).state,'submitted');assert.equal((await pendingB).state,'completed');
   const pair={AJobKey,BJobKey};
   const pendingKey=await enqueueAssessmentResolution(pool!,store,item.cas,pair,'reconcile',policy);
   assert.equal((await runAssessment(pendingKey,'third-pass-required')).state,'held');
   const held=await sealQueueTextContribution(pool!,item.cas,{jobKeys:[extractionKey],reconciliationJobKeys:[pendingKey]});
   assert.equal(held.records,0);assert.equal(held.heldRecords,1);
   const heldInput=await loadR1TextCompositionInput(JSON.parse((await item.cas.read(held.compositionArtifactSha256)).toString('utf8')),pin=>item.cas.read(pin.sha256));
   assert.equal((await exportResidualTextContribution(pool!,item.cas,[extractionKey],heldInput.contributions[0])).results.length,1);
   const heldCases=JSON.parse((await item.cas.read(held.artifacts.quarantine.sha256)).toString('utf8')).cases;
   assert.equal(heldCases.length,1);assert.equal(heldCases.find((entry:{candidate?:unknown})=>entry.candidate)?.reason,'assessment_held');
   const heldRow=(await pool!.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1) ORDER BY attempt DESC LIMIT 1',[pendingKey])).rows[0],terminalAssessment={documentId:item.document.id,step:'assessment_reconcile' as const,jobKey:pendingKey,receiptId:heldRow.receipt.id,receiptSha256:heldRow.receipt_sha256,reasonCode:heldRow.receipt.reasonCode};
   const exceptionInput={jobKeys:[extractionKey],reconciliationJobKeys:[pendingKey],terminalAssessmentExceptions:[terminalAssessment]},heldWithEvidence=await sealQueueTextContribution(pool!,item.cas,exceptionInput);
   assert.equal(heldWithEvidence.records,0);assert.equal(heldWithEvidence.committedDocuments,1);assert.equal(heldWithEvidence.terminalAssessmentExceptions.length,1);assert.equal(heldWithEvidence.terminalAssessmentExceptions[0].receiptSha256,heldRow.receipt_sha256);assert.equal(heldWithEvidence.terminalAssessmentExceptions[0].attemptHistory.length,1);
   const exceptionComposition=await loadR1TextCompositionInput(JSON.parse((await item.cas.read(heldWithEvidence.compositionArtifactSha256)).toString('utf8')),pin=>item.cas.read(pin.sha256));
   const exceptionExport=await exportQueueTextContribution(pool!,item.cas,[extractionKey],exceptionComposition.contributions[0]);assert.equal(exceptionExport.terminalAssessmentExceptions[0].reasonCode,heldRow.receipt.reasonCode);
   await assert.rejects(buildQueueTextRun(pool!,item.cas,{...exceptionInput,terminalAssessmentExceptions:[{...terminalAssessment,documentId:'foreign-document'}]}),/extracted document/);
   const CJobKey=await enqueueAssessmentResolution(pool!,store,item.cas,pair,'C',policy);
   assert.equal((await runAssessment(CJobKey,'third-pass-current-refresh')).state,'completed');
   const reconcileKey=await enqueueAssessmentResolution(pool!,store,item.cas,{...pair,CJobKey},'reconcile',policy);
   assert.equal((await runAssessment(reconcileKey,'deterministic-current-refresh')).state,'completed');assert.equal(modelCalls,2);
   for(const jobKey of [assessmentPreparationKey,AJobKey,BJobKey,CJobKey,reconcileKey]){
    const rows:QueryResult<{receipt:StepReceipt;spec:DistrictJobSpec}>=await pool!.query(`SELECT r.receipt,j.spec FROM district_pipeline.step_receipts r JOIN district_pipeline.jobs j ON j.id=r.job_id WHERE j.job_key=$1 AND r.outcome='succeeded'`,[jobKey]);
    assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].receipt.policyProofSha256,original.policyReceiptSha256);
    assert.equal(rows.rows[0].receipt.versions[`policyRebinding.${original.policyReceiptSha256}.${secondReceipt.receipt_sha256}`],checked.admissibilityReceiptSha256);
    assert.equal(rows.rows[0].spec.policyProofSha256,original.policyReceiptSha256);
   }
   const retainedItem=assessmentItemSchema.parse(JSON.parse((await item.cas.read(aSpec.selector.itemArtifactSha256)).toString('utf8')));
   assert.deepEqual(retainedItem,assessmentItem);assert.equal(retainedItem.sources[0].admissionReceiptSha256,original.policyReceiptSha256);
   const sealInput={jobKeys:[extractionKey],reconciliationJobKeys:[reconcileKey]};
   const sealed=await sealQueueTextContribution(pool!,item.cas,sealInput);
   assert.equal(sealed.records,1);assert.equal(sealed.heldRecords,0);
   const sealedBytes=await item.cas.read(sealed.compositionArtifactSha256);
   const provenance=await authenticatePublicationProvenance(sealed.privateProvenance.path,sealed.privateProvenance.sha256,policy);
   const composition=await loadR1TextCompositionInput(JSON.parse(sealedBytes.toString('utf8')),pin=>provenance.read(pin.path)),context=buildR1TextCompositionContext(composition);
   const exported=await exportResidualTextContribution(pool!,item.cas,[extractionKey],composition.contributions[0]);
   assert.equal(exported.contribution.runId,sealed.runId);assert.equal(context.knowledge.records.length,1);
   const inventory=JSON.parse((await item.cas.read(sealed.criticalInventory.sha256)).toString('utf8')),admissions=JSON.parse((await item.cas.read(sealed.criticalAdmissions.sha256)).toString('utf8'));
   assert.equal(inventory.records.length,1);assert.equal(admissions.admissions[0].labelProvenance,'ai_reconciled');
   const native=JSON.parse((await item.cas.read(sealed.runId)).toString('utf8'));
   assert.equal(native.quarantinedCases,0);assert.equal(context.composition.quarantine.cases.length,0);
   assert.equal(context.knowledge.records[0].extraction.relationNormalization?.mappings[0].originalType,'implements');
   assert.equal(native.queue.callAccounting.codex.length,4);assert.ok(native.queue.stepReceipts.some((row:{receipt:StepReceipt})=>row.receipt.versions[`policyRebinding.${original.policyReceiptSha256}.${secondReceipt.receipt_sha256}`]===checked.admissibilityReceiptSha256));
   const summary=await prepareKnowledge({registry:sealed.artifacts.registry.path,textComposition:sealed.path,records:sealed.artifacts.records.path,quarantine:sealed.artifacts.quarantine.path,criticalAssessments:sealed.criticalInventory.path,policyReceipts:sealed.policyInventory.path,privateProvenance:{path:sealed.privateProvenance.path,sha256:sealed.privateProvenance.sha256},casRoot:item.cas.root,policyStateDir:policy.stateDir,policyAuthorityId:policy.authorityId,policyAuthoritySha256:policy.authoritySha256,outputRoot:join(root!,'sealed-publication')});
   assert.equal(summary.records,1);assert.deepEqual(summary.criticalHolds,[]);
   const replayAt=Date.now()+70_000;assert.ok(replayAt<Date.parse(checked.currentReceipt.expiresAt));
   st.mock.timers.enable({apis:['Date'],now:new Date(replayAt)});
   try{
    const replayed=await sealQueueTextContribution(pool!,item.cas,sealInput);assert.deepEqual(replayed,sealed);
    assert.deepEqual(await item.cas.read(replayed.compositionArtifactSha256),sealedBytes);
   }finally{st.mock.timers.reset();}
   const tampered=JSON.parse((await item.cas.read(sealed.runId)).toString('utf8'));tampered.queue.stepReceipts[0].receipt.versions.forged='synthetic-tamper';
   const tamperedBytes=Buffer.from(canonicalJson(tampered)),tamperedHash=digest(tamperedBytes);
   await assert.rejects(exportResidualTextContribution(pool!,item.cas,[extractionKey],{...composition.contributions[0],runId:tamperedHash,artifacts:{...composition.contributions[0].artifacts,extractionRun:{bytes:tamperedBytes,sha256:tamperedHash}}}),/seal differs/);
   const finalPin=inventory.records[0].finalArtifactSha256,finalPath=join(item.cas.root,'sha256',finalPin.slice(0,2),finalPin),originalFinal=await readFile(finalPath);
   await writeFile(finalPath,Buffer.from('tampered synthetic final'),{mode:0o600});
   await assert.rejects(buildQueueTextRun(pool!,item.cas,sealInput));
   await writeFile(finalPath,originalFinal,{mode:0o600});
   await st.test('mixed queued document preserves budget-held and no-case chunks in a replay-identical native seal',async()=>{
    const mixed=await fixture('mixed-budget-seal',{body:Buffer.from('漢'.repeat(12000)+'\nSynthetic Strausberg narrative ohne belegten Vorgang.')});
    await withFixtureAuthorizedCorpus(mixed.indexBytes,policy,async()=>{
     const imported=await importCrawlCorpusForResidual(store,mixed.cas,mixed.manifest);assert.deepEqual(imported.holds,[]);
     const preparedKey=await enqueueResidualPreparation(store,mixed.cas,imported.jobs[0]);
     const preparedRun=await runDistrictJobs({store,cas:mixed.cas,handlers:{residual_prepare:prepareFixture},authorizationId:await authorize(preparedKey,'mixed-prepare'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
     assert.equal(preparedRun.state,'completed',canonicalJson(preparedRun));
     const key=await enqueueCommittedResidualExtraction(pool!,store,mixed.cas,preparedKey);
     const run=await runDistrictJobs({store,cas:mixed.cas,handlers:{residual_extract:extractionFixture},authorizationId:await authorize(key,'mixed-extract'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
     assert.equal(run.state,'completed',canonicalJson(run)+(extractionFailure instanceof Error?'\n'+extractionFailure.stack:''));
     const input={jobKeys:[key],reconciliationJobKeys:[]},sealedMixed=await sealQueueTextContribution(pool!,mixed.cas,input);
     assert.equal(sealedMixed.records,0);assert.equal(sealedMixed.heldRecords,0);assert.equal(sealedMixed.committedDocuments,1);
     const runValue=JSON.parse((await mixed.cas.read(sealedMixed.runId)).toString('utf8')),quarantine=JSON.parse((await mixed.cas.read(sealedMixed.artifacts.quarantine.sha256)).toString('utf8'));
     assert.equal(runValue.attemptedDocumentGroups,1);assert.equal(runValue.pendingDocumentGroups,0);assert.equal(runValue.quarantinedCases,2);
     assert.equal(runValue.queue.callAccounting.codex.length,1);
     assert.deepEqual(quarantine.cases.map((entry:{reason:string})=>entry.reason),['Model input exceeds bounded context','No supported case in source excerpt']);
     const compositionBytes=await mixed.cas.read(sealedMixed.compositionArtifactSha256);
     const inputValue=await loadR1TextCompositionInput(JSON.parse(compositionBytes.toString('utf8')),pin=>mixed.cas.read(pin.sha256));
     await exportResidualTextContribution(pool!,mixed.cas,[key],inputValue.contributions[0]);
     const replayed=await sealQueueTextContribution(pool!,mixed.cas,input);assert.deepEqual(replayed,sealedMixed);
     assert.deepEqual(await mixed.cas.read(replayed.compositionArtifactSha256),compositionBytes);
    });
   });
   await st.test('terminal assessment context and A/B holds retain receipt-authenticated source ancestry',async()=>{
    const terminal=await fixture('terminal-assessment-context',{body:item.bytes});
    await withFixtureAuthorizedCorpus(terminal.indexBytes,policy,async()=>{
     const imported=await importCrawlCorpusForResidual(store,terminal.cas,terminal.manifest),preparedKey=await enqueueResidualPreparation(store,terminal.cas,imported.jobs[0]);
     await runDistrictJobs({store,cas:terminal.cas,handlers:{residual_prepare:prepareFixture},authorizationId:await authorize(preparedKey,'terminal-assessment-prepare'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
     const extractionKey=await enqueueCommittedResidualExtraction(pool!,store,terminal.cas,preparedKey);await runDistrictJobs({store,cas:terminal.cas,handlers:{residual_extract:extractionFixture},authorizationId:await authorize(extractionKey,'terminal-assessment-extract'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
     const preparationKey=await enqueueResidualAssessmentItems(pool!,store,terminal.cas,extractionKey);
     const pin=async<S extends 'assessment_prepare'|'assessment_a'|'assessment_b'>(jobKey:string,step:S)=>{const row=(await pool!.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE job_id=(SELECT id FROM district_pipeline.jobs WHERE job_key=$1) ORDER BY attempt DESC LIMIT 1',[jobKey])).rows[0];return {documentId:terminal.document.id,step,jobKey,receiptId:row.receipt.id,receiptSha256:row.receipt_sha256,reasonCode:row.receipt.reasonCode};};
     const hold=async(jobKey:string,step:'assessment_prepare'|'assessment_a'|'assessment_b',reasonCode:'assessment_context_exceeded'|'execution_exception'|'isolation_unavailable')=>{const handler:JobHandler=async()=>({outcome:'held_execution',reasonCode});handler.currentPolicy=assessmentHandlers[step].currentPolicy;const run=await runDistrictJobs({store,cas:terminal.cas,handlers:{[step]:handler},authorizationId:await authorize(jobKey,'terminal-'+step),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});assert.equal(run.jobsStarted,1);};
     await hold(preparationKey,'assessment_prepare','assessment_context_exceeded');const contextPin=await pin(preparationKey,'assessment_prepare'),contextInput={jobKeys:[extractionKey],reconciliationJobKeys:[],terminalAssessmentExceptions:[contextPin]},contextSeal=await sealQueueTextContribution(pool!,terminal.cas,contextInput);
     assert.equal(contextSeal.records,0);assert.equal(contextSeal.committedDocuments,1);assert.equal(contextSeal.terminalAssessmentExceptions[0].reasonCode,'assessment_context_exceeded');
     const contextComposition=await loadR1TextCompositionInput(JSON.parse((await terminal.cas.read(contextSeal.compositionArtifactSha256)).toString('utf8')),pin=>terminal.cas.read(pin.sha256));
     await exportQueueTextContribution(pool!,terminal.cas,[extractionKey],contextComposition.contributions[0]);
     await store.resume(preparationKey);await runDistrictJobs({store,cas:terminal.cas,handlers:assessmentHandlers,authorizationId:await authorize(preparationKey,'resume-context'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
     await assert.rejects(exportQueueTextContribution(pool!,terminal.cas,[extractionKey],contextComposition.contributions[0]),/current committed held attempt/);
     const AKey=(await enqueuePreparedAssessmentPass(pool!,store,terminal.cas,preparationKey,'A'))[0];await hold(AKey,'assessment_a','execution_exception');
     const aSpec=(await pool!.query('SELECT spec FROM district_pipeline.jobs WHERE job_key=$1',[AKey])).rows[0].spec,terminalBroker=new DistrictAssessmentBroker(pool!,terminal.cas,{policyOptions:policy,fixtureProtocol:true}),BKey=await enqueueAssessmentB(terminalBroker,{itemArtifactSha256:aSpec.selector.itemArtifactSha256,sourceScope:aSpec.sourceScope,policyProofSha256:aSpec.policyProofSha256,transport:'mac-bridge',clientContractSha256:digest('synthetic terminal B client')});await hold(BKey,'assessment_b','isolation_unavailable');
     const input={jobKeys:[extractionKey],reconciliationJobKeys:[],terminalAssessmentExceptions:[await pin(AKey,'assessment_a'),await pin(BKey,'assessment_b')]},sealed=await sealQueueTextContribution(pool!,terminal.cas,input);
     assert.equal(sealed.records,0);assert.equal(sealed.committedDocuments,1);assert.equal(sealed.terminalAssessmentExceptions.length,2);
     const composition=await loadR1TextCompositionInput(JSON.parse((await terminal.cas.read(sealed.compositionArtifactSha256)).toString('utf8')),pin=>terminal.cas.read(pin.sha256));assert.equal((await exportQueueTextContribution(pool!,terminal.cas,[extractionKey],composition.contributions[0])).terminalAssessmentExceptions.length,2);
    });
   });
   await st.test('pre-beb7047 held_quality seal bytes remain exportable while enrichment is explicit',async()=>{
    const historical=await fixture('legacy-held-quality-seal',{body:Buffer.from('Synthetic Strausberg narrative ohne belegten Vorgang.')});
    await withFixtureAuthorizedCorpus(historical.indexBytes,policy,async()=>{
     const imported=await importCrawlCorpusForResidual(store,historical.cas,historical.manifest),preparedKey=await enqueueResidualPreparation(store,historical.cas,imported.jobs[0]);
     await runDistrictJobs({store,cas:historical.cas,handlers:{residual_prepare:prepareFixture},authorizationId:await authorize(preparedKey,'historical-held-prepare'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
     const key=await enqueueCommittedResidualExtraction(pool!,store,historical.cas,preparedKey),qualityHold:JobHandler=async context=>({...await extractionFixture(context),outcome:'held_quality',reasonCode:'quality_failed'});qualityHold.currentPolicy=extractionFixture.currentPolicy;
     await runDistrictJobs({store,cas:historical.cas,handlers:{residual_extract:qualityHold},authorizationId:await authorize(key,'historical-held-extract'),ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
     const selected={jobKeys:[key],reconciliationJobKeys:[]},enriched=await buildQueueTextRun(pool!,historical.cas,{...selected,attemptHistory:'committed-v1'}),enrichedRun=JSON.parse(Buffer.from(enriched.contribution.artifacts.extractionRun.bytes).toString('utf8'));
     assert.equal(enrichedRun.queue.attemptHistory,'committed-v1');assert.equal(enrichedRun.queue.extractionAttemptHistory.length,1);
     // Pre-beb7047 format has the same genuine committed outputs/receipts but
     // neither later queue history field. No extraction/receipt is invented.
     const preBebRun=structuredClone(enrichedRun);delete preBebRun.queue.attemptHistory;delete preBebRun.queue.extractionAttemptHistory;
     const legacyBytes=Buffer.from(canonicalJson(preBebRun)),legacySha256=digest(legacyBytes),legacyFixture={...enriched.contribution,runId:legacySha256,artifacts:{...enriched.contribution.artifacts,extractionRun:{bytes:legacyBytes,sha256:legacySha256}}};
     assert.equal((await exportQueueTextContribution(pool!,historical.cas,[key],legacyFixture)).contribution.runId,legacySha256);
     assert.equal((await exportResidualTextContribution(pool!,historical.cas,[key],legacyFixture)).contribution.runId,legacySha256);
     const legacy=await sealQueueTextContribution(pool!,historical.cas,selected);assert.equal(legacy.runId,legacySha256);assert.deepEqual(await historical.cas.read(legacy.runId),legacyBytes);assert.deepEqual(await sealQueueTextContribution(pool!,historical.cas,selected),legacy);
     const modern=await sealQueueTextContribution(pool!,historical.cas,{...selected,attemptHistory:'committed-v1'});assert.equal(modern.attemptHistory,'committed-v1');assert.notEqual(modern.runId,legacySha256);await exportQueueTextContribution(pool!,historical.cas,[key],enriched.contribution);
     // beb7047 emitted history without a marker: preserve that envelope too.
     const bebRun=structuredClone(enrichedRun);delete bebRun.queue.attemptHistory;const bebBytes=Buffer.from(canonicalJson(bebRun)),bebSha256=digest(bebBytes),bebFixture={...enriched.contribution,runId:bebSha256,artifacts:{...enriched.contribution.artifacts,extractionRun:{bytes:bebBytes,sha256:bebSha256}}};assert.equal((await exportQueueTextContribution(pool!,historical.cas,[key],bebFixture)).contribution.runId,bebSha256);
    });
   });
   st.mock.timers.enable({apis:['Date'],now:new Date(checked.currentReceipt.expiresAt)});
   try{await assert.rejects(recheckResidualPolicy(store,item.cas,original),stale);}finally{st.mock.timers.reset();}
   stricter=true;
   const changed=(await enqueueCrawlPolicyRefresh(store,item.cas,{manifest:item.manifest,maxRequests:4,previousRefreshes:[{documentId:item.document.id,jobKey:second,receiptSha256:secondReceipt.receipt_sha256}]})).jobKeys[0].jobKey,changedAuthorization=await authorize(changed);
   await runDistrictJobs({store,cas:item.cas,handlers:{policy_refresh:handler},authorizationId:changedAuthorization,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});
   const changedState=await pool!.query('SELECT state FROM district_pipeline.jobs WHERE job_key=$1',[changed]);assert.equal(changedState.rows[0].state,'blocked_policy');
   await assert.rejects(recheckResidualPolicy(store,item.cas,original),stale);
   assert.deepEqual(await readFile(item.document.observationPath),item.observationBytes);assert.deepEqual(await item.cas.read(item.document.sha256),item.bytes);
  });
 });
 for(const kind of ['robots_stricter','tdm_reserved','opt_out'] as const)await t.test(`durable refresh holds ${kind}`,async st=>{
  const robotsBody='User-agent: *\nAllow: /\n',item=await fixture('refresh-hold-'+kind,{stale:true,robotsBody});
  let requests=0;
  interface WireSeam {wire(url:URL):Promise<{status:number;headers:Record<string,string|undefined>;body:Buffer}>}
  st.mock.method(PoliteFetcher.prototype as unknown as WireSeam,'wire',async (url:URL)=>{
   requests++;
   if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from(kind==='robots_stricter'?'User-agent: *\nDisallow: /\n':robotsBody)};
   if(url.pathname==='/.well-known/tdmrep.json')return {status:200,headers:{'content-type':'application/json'},body:Buffer.from('[{"location":"/","tdm-reservation":1}]')};
   throw Error('Held refresh must not request original body');
  });
  await withFixtureAuthorizedCorpus(item.indexBytes,policy,async()=>{
   const queued=await enqueueCrawlPolicyRefresh(store,item.cas,{manifest:item.manifest,maxRequests:4}),jobKey=queued.jobKeys[0].jobKey;
   const authorizationId=await store.authorize({approvalSha256:digest('Synthetic held refresh authorization '+jobKey),approvedBy:'synthetic-fixture-owner',expiresAt:new Date(Date.now()+60000).toISOString(),jobKeys:[jobKey],ags:[scope.ags],maxJobs:1,maxElapsedMs:60000,category:'development'});
   if(kind==='opt_out')await recordHostOptOut({host:'example.org',reason:'rights_holder_objection'},policy);
   const handler=policyRefreshHandler(store,(context,maxRequests)=>createR1PublicFetcher(store,context,{maxRequests,maxBytes:1024*1024,fixture:{fetchRoot:join(root!,'refresh-held-fetch-'+kind),policy,inspection:fixturePolicyInspection}}));
   const result=await runDistrictJobs({store,cas:item.cas,handlers:{policy_refresh:handler},authorizationId,ownerPresent:true,maxJobs:1,maxElapsedMs:60000});assert.equal(result.state,'held');assert.equal(result.jobsStarted,1);
   const receipts=await pool!.query('SELECT receipt,receipt_sha256 FROM district_pipeline.step_receipts WHERE run_id=$1',[result.runId]);assert.deepEqual(receipts.rows[0].receipt.outputHashes,[]);
   if(kind==='opt_out'){
    // The canonical executor refuses the already purged/withdrawn input CAS
    // before dispatching the handler; it is an execution hold, not a refetch.
    assert.equal(receipts.rows[0].receipt.outcome,'held_execution');assert.equal(receipts.rows[0].receipt.reasonCode,'cas_unavailable');assert.equal(requests,0);
   }else{
    assert.equal(receipts.rows[0].receipt.outcome,'blocked_policy');
    await assert.rejects(enqueueCrawlPolicyRefresh(store,item.cas,{manifest:item.manifest,maxRequests:4,previousRefreshes:[{documentId:item.document.id,jobKey,receiptSha256:receipts.rows[0].receipt_sha256}]}),/not committed/);
    assert.deepEqual(await readFile(item.document.observationPath),item.observationBytes);
   }
  });
 });
});
test('request sidecars leave old observation bytes unchanged and remain recoverable/purgable managed artifacts',async t=>{
 const {root,policy}=await createCivicPolicyTestContext(t),rawRoot=join(root,'raw'),bytes=Buffer.from('Synthetic body for custody test'),sha256=digest(bytes),url='https://example.org/fixture',checkedAt=new Date().toISOString(),observationId=`${Date.now()}-${randomUUID()}.json`;
 const observationBytes=Buffer.from(JSON.stringify({url,method:'GET',checkedAt,retrievedAt:checkedAt,state:'fetched',status:200,sha256,bytes:bytes.length,mimeType:'text/plain'})+'\n'),binding={kind:'http_observation' as const,url,sourceSha256:sha256,observationId,receiptSha256:digest(observationBytes)};
 await initializeManagedAcquisitionLane(rawRoot,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind:'fetch'});
 await withManagedSourceWrite(rawRoot,[{...binding,relativePath:'sha256/'+sha256,contentSha256:sha256,independentAllowed:true}],async()=>{await mkdir(join(rawRoot,'sha256'),{recursive:true,mode:0o700});await mkdir(join(rawRoot,'observations'),{recursive:true,mode:0o700});await writeFile(join(rawRoot,'sha256',sha256),bytes,{mode:0o600});await writeFile(join(rawRoot,'observations',observationId),observationBytes,{mode:0o600});},policy);
 const evidence=await persistCrawlRequestEvidence(rawRoot,{schemaVersion:'stadtstack-crawl-request-evidence-v1',httpObservation:binding,request:{url,method:'GET',contentType:null,bodySha256:null,publicSelector:null},redirectChain:[url]},policy);
 assert.deepEqual(await readFile(join(rawRoot,'observations',observationId)),observationBytes);
 await assertManagedSourceBindings(evidence.path,[binding],policy);
 assert.equal((await recoverManagedSourceScratch(policy)).status,'complete');
 const withdrawn=await recordHostOptOut({host:'example.org',reason:'rights_holder_objection'},policy);
 assert.equal(withdrawn.purge.status,'purged');await assert.rejects(readFile(evidence.path),{code:'ENOENT'});
 let called=false;
 await assert.rejects(withFixtureAuthorizedCorpus(bytes,{...policy,authoritySha256:digest('wrong realm pin')},async()=>{called=true;}));assert.equal(called,false);
});
