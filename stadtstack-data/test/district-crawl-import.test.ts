import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {Pool} from 'pg';
import {digest} from '../src/district-adapter-contract.ts';
import {DistrictCas} from '../src/district-cas.ts';
import {DistrictJobStore,migrateDistrictJobs} from '../src/district-jobs.ts';
import {importCrawlCorpusForResidual} from '../src/district-crawl-import.ts';
import {withFixtureAuthorizedCorpus,authorizedPilotCorpusSchema,loadFrozenCorpusBytes} from '../src/district-corpus.ts';
import {ResidualInputSchema,enqueueResidualPreparation,loadResidualSource} from '../src/district-residual-jobs.ts';
import {ObservationRequestSchema,persistCrawlRequestEvidence} from '../src/district-crawl-request.ts';
import {provisionCivicPolicyAuthority,initializeManagedAcquisitionLane,withManagedSourceWrite,assertManagedSourceBindings,recoverManagedSourceScratch,recordHostOptOut,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
import {createOperatorRegistryFixture,operatorRegistryFixtureValue} from './helpers/operator-registry-fixture.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {poolShutdownBarrier} from './helpers/postgres-pool.ts';

const connectionString=process.env.DISTRICT_TEST_DATABASE_URL;
test('public request evidence excludes credential/header fields and binds selector bytes',()=>{
 const request={url:'https://example.org/list',method:'POST',contentType:'application/x-www-form-urlencoded',bodySha256:digest('name=public'),publicSelector:'name=public'};
 assert.deepEqual(ObservationRequestSchema.parse(request),request);
 for(const publicSelector of ['username=owner','password=secret','authorization=bearer','token=secret'])assert.throws(()=>ObservationRequestSchema.parse({...request,publicSelector,bodySha256:digest(publicSelector)}));
 assert.throws(()=>ObservationRequestSchema.parse({...request,headers:{username:'owner',password:'secret'}}));
 assert.throws(()=>ObservationRequestSchema.parse({...request,bodySha256:digest('tampered')}));
});
test('offline frozen crawl import preserves managed originals and produces enqueue-ready residual jobs',{skip:!connectionString,timeout:120000},async t=>{
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
 async function fixture(label:string,config:{stale?:boolean;missingRequest?:boolean;post?:boolean;extra?:boolean}={}){
  const rawRoot=join(root!,label+'-raw'),indexRoot=join(root!,label+'-index'),casRoot=join(root!,label+'-cas');
  for(const [path,kind] of [[rawRoot,'fetch'],[indexRoot,'artifacts'],[casRoot,'artifacts']] as const)await initializeManagedAcquisitionLane(path,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind});
  const checkedAt=new Date(Date.now()-(config.stale?7200000:3000)).toISOString(),url='https://example.org/'+label,bytes=Buffer.from('Synthetic civic fixture original '+label),sha256=digest(bytes),observationId=`${Date.now()}-${randomUUID()}.json`,observationPath=join(rawRoot,'observations',observationId);
  const publicSelector=config.post?'municipality=12064472':null;
  const observation={url,method:config.post?'POST':'GET',checkedAt,retrievedAt:checkedAt,state:'fetched',status:200,sha256,bytes:bytes.length,mimeType:'text/plain',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt',sha256:digest('synthetic robots'),checkedAt},tdm:{state:'not_declared',evidence:[{url:'https://example.org/.well-known/tdmrep.json',locator:'TDMRep standardized location HTTP absence',value:'404',checkedAt}]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
  const observationBytes=Buffer.from(JSON.stringify(observation,null,2)+'\n'),binding={kind:'http_observation' as const,url,sourceSha256:sha256,observationId,receiptSha256:digest(observationBytes)};
  await withManagedSourceWrite(rawRoot,[{...binding,relativePath:'sha256/'+sha256,contentSha256:sha256,independentAllowed:true}],async()=>{await mkdir(join(rawRoot,'sha256'),{recursive:true,mode:0o700});await mkdir(join(rawRoot,'observations'),{recursive:true,mode:0o700});await writeFile(join(rawRoot,'sha256',sha256),bytes,{mode:0o600});await writeFile(observationPath,observationBytes,{mode:0o600});},policy);
  const path=join(indexRoot,'index.json'),document={id:label,municipalityId:city.id,ags:city.ags,districtId:city.districtId,sourceId:source.id,url,sha256,mimeType:'text/plain',retrievedAt:checkedAt,checkedAt,status:200,observationPath,documentDate:null,localPath:relative(indexRoot,join(rawRoot,'sha256',sha256)),adapter:'synthetic-test-only',metadata:{}};
  const documents=[document],observations=[{path:observationPath,sha256:digest(observationBytes)}],bindings=[binding];
  if(config.extra){
   const extraBody=Buffer.from('unselected fixture'),extra={...observation,url:url+'-unselected',sha256:digest(extraBody),bytes:extraBody.length},extraId=`${Date.now()}-${randomUUID()}.json`,extraBytes=Buffer.from(JSON.stringify(extra)+'\n'),extraPath=join(rawRoot,'observations',extraId),extraBinding={...binding,url:extra.url,sourceSha256:extra.sha256,observationId:extraId,receiptSha256:digest(extraBytes)};
   await withManagedSourceWrite(rawRoot,[{...extraBinding,relativePath:'sha256/'+extra.sha256,contentSha256:extra.sha256,independentAllowed:true}],async()=>{await writeFile(extraPath,extraBytes,{mode:0o600});await writeFile(join(rawRoot,'sha256',extra.sha256),extraBody,{mode:0o600});},policy);
   observations.push({path:extraPath,sha256:digest(extraBytes)});bindings.push(extraBinding);
   documents.push({...document,id:label+'-unselected',url:extra.url,sha256:extra.sha256,observationPath:extraPath,localPath:relative(indexRoot,join(rawRoot,'sha256',extra.sha256))});
  }
  const indexBytes=Buffer.from(JSON.stringify({schemaVersion:'stadtstack-crawl-index-v1',documents,checks:[{municipalityId:city.id,sourceId:source.id,outcome:'partial',coverage:'partial',documentCount:documents.length}]},null,2)+'\n'),indexHash=digest(indexBytes);
  await withManagedSourceWrite(indexRoot,[...registry.admitted.bindings,...bindings].map(binding=>({...binding,relativePath:'index.json',contentSha256:indexHash,independentAllowed:false})),()=>writeFile(path,indexBytes,{mode:0o600}),policy);
  const requestEvidence=config.missingRequest?undefined:await persistCrawlRequestEvidence(rawRoot,{schemaVersion:'stadtstack-crawl-request-evidence-v1',httpObservation:binding,request:{url,method:config.post?'POST':'GET',contentType:config.post?'application/x-www-form-urlencoded;charset=UTF-8':null,bodySha256:publicSelector===null?null:digest(publicSelector),publicSelector},redirectChain:[url]},policy);
  const manifest={index:{path,sha256:indexHash},rawRoot,registry:registry.registryPin,observations,documents:[{documentId:label,scope,permission:{kind:'facts_with_attribution' as const},bounds,requestEvidence}]};
  return {manifest,indexBytes,cas:new DistrictCas(casRoot),bytes,binding,observationBytes,document};
 }
 await t.test('happy GET/POST imports preserve exact bytes/clocks and enqueue genuine preparation jobs',async()=>{
  for(const post of [false,true]){
   const item=await fixture(post?'happy-post':'happy-get',{post,extra:true});
   assert.equal(authorizedPilotCorpusSchema.safeParse(item.manifest.index.sha256).success,false);
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
    const receipts=await pool!.query('SELECT COUNT(*)::int AS count FROM district_pipeline.step_receipts');assert.equal(receipts.rows[0].count,0);
    await assert.rejects(loadResidualSource(item.cas,{...job,corpusObservations:job.corpusObservations.slice(0,1)}));
   });
   assert.equal(authorizedPilotCorpusSchema.safeParse(item.manifest.index.sha256).success,false);
  }
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
