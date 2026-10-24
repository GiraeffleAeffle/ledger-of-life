import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from '../src/district-adapter-contract.ts';
import {crawlDocumentSchema,withFixtureAuthorizedCorpus} from '../src/district-corpus.ts';
import {districtRegistrySchema} from '../src/district-registry.ts';
import {authenticateImportDispositions,recomputePermanentImportRejection,assertImportDispositionDecisionCurrent} from '../src/r1-step8-import-dispositions.ts';
import {ImportDispositionDecisionSchema,type ImportDispositionDecision,type ImportRejectionDisposition} from '../src/r1-step8-import-disposition-contract.ts';
import {assertStep8ExportMembership,Step8CampaignSchema} from '../src/r1-step8-governance.ts';
import {initializeManagedAcquisitionLane,withManagedSourceWrite,assertManagedSourceReadable,CIVIC_ACQUISITION_DECISION_ID} from '../src/civic-opt-out.ts';
import {persistCrawlRequestEvidence} from '../src/district-crawl-request.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {createOperatorRegistryFixture} from './helpers/operator-registry-fixture.ts';
import {Step8ExceptionInventorySchema,inventoryExceptionItems} from '../src/r1-release-acceptance.ts';

const actual=JSON.parse(await readFile(new URL('./fixtures/r1-permanent-import-holds.json',import.meta.url),'utf8'));
test('actual ZIP and external ministry PDF reproduce the two permanent importer reasons',()=>{
 const registry=districtRegistrySchema.parse(actual.registry);
 assert.equal(actual.documents.length,2);
 for(const row of actual.documents){
  const document=crawlDocumentSchema.parse(row.document),derived=recomputePermanentImportRejection(registry,document,row.scope);
  assert.equal(derived.reasonCode,row.reasonCode);
  assert.match(document.sha256,/^[a-f0-9]{64}$/);
  if(row.reasonCode==='scope_mismatch'){assert.equal(new URL(document.url).hostname,'mil.brandenburg.de');assert.equal(document.id,'document-2dec1b7b4e81cb2502e1f2cf');}
  else {assert.equal(document.mimeType,'application/zip');assert.equal(document.id,'document-f5f3c6cdc1afb34cef583a92');}
 }
});

test('authenticated read-only decisions reject changed reasons/identities and require explicit stale owner choice',async t=>{
 const context=await createCivicPolicyTestContext(t),{root,policy}=context;
 const registry=await createOperatorRegistryFixture(t,{context,value:actual.registry});
 const city=districtRegistrySchema.parse(registry.value).municipalities.find(row=>row.id==='strausberg')!,source=city.sources.find(row=>row.id==='strausberg-planning')!;
 const rawRoot=join(root,'raw'),indexRoot=join(root,'index');
 for(const [path,kind] of [[rawRoot,'fetch'],[indexRoot,'artifacts']] as const)await initializeManagedAcquisitionLane(path,{...policy,decisionId:CIVIC_ACQUISITION_DECISION_ID,kind});
 const checkedAt=new Date(Date.now()-2*3600_000).toISOString(),url='https://www.stadt-strausberg.de/synthetic-not-discovered/document.txt',body=Buffer.from('Synthetic isolated import-rejection fixture; not municipal content'),sha256=digest(body),observationId=Date.now()+'-'+randomUUID()+'.json',observationPath=join(rawRoot,'observations',observationId);
 const observation={url,method:'GET',checkedAt,retrievedAt:checkedAt,state:'fetched',status:200,sha256,bytes:body.length,mimeType:'text/plain',policy:{robots:{state:'allowed',url:'https://www.stadt-strausberg.de/robots.txt',sha256:digest('synthetic robots'),checkedAt},tdm:{state:'not_declared',evidence:[{url:'https://www.stadt-strausberg.de/.well-known/tdmrep.json',locator:'TDMRep standardized location HTTP absence',value:'404',checkedAt}]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
 const observationBytes=Buffer.from(JSON.stringify(observation)),binding={kind:'http_observation' as const,url,sourceSha256:sha256,observationId,receiptSha256:digest(observationBytes)};
 await withManagedSourceWrite(rawRoot,[{...binding,relativePath:'sha256/'+sha256,contentSha256:sha256,independentAllowed:true}],async()=>{await mkdir(join(rawRoot,'sha256'),{recursive:true,mode:0o700});await mkdir(join(rawRoot,'observations'),{recursive:true,mode:0o700});await writeFile(join(rawRoot,'sha256',sha256),body,{mode:0o600});await writeFile(observationPath,observationBytes,{mode:0o600});},policy);
 const document={id:'synthetic-import-held',municipalityId:city.id,ags:city.ags,districtId:city.districtId,sourceId:source.id,url,sha256,mimeType:'text/plain',retrievedAt:checkedAt,checkedAt,status:200,observationPath,documentDate:null,localPath:relative(indexRoot,join(rawRoot,'sha256',sha256)),adapter:'isolated-synthetic',metadata:{discoveredFrom:'https://www.stadt-strausberg.de/synthetic-missing-parent'}};
 const indexBytes=Buffer.from(JSON.stringify({schemaVersion:'stadtstack-crawl-index-v1',documents:[document]})),index={path:join(indexRoot,'index.json'),sha256:digest(indexBytes)};
 await withManagedSourceWrite(indexRoot,[...registry.admitted.bindings,binding].map(row=>({...row,relativePath:'index.json',contentSha256:index.sha256,independentAllowed:false})),()=>writeFile(index.path,indexBytes,{mode:0o600}),policy);
 const scope={publisherId:'synthetic',municipalityId:city.id,sourceId:source.id,ags:city.ags,tenant:null,observationWindow:'synthetic'};
 const requestEvidence=await persistCrawlRequestEvidence(rawRoot,{schemaVersion:'stadtstack-crawl-request-evidence-v1',httpObservation:binding,request:{url,method:'GET',contentType:null,bodySha256:null,publicSelector:null},redirectChain:[url]},policy);
 const control=async(name:string,value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value)),path=join(root,name+'.json');await writeFile(path,bytes,{mode:0o600});return {path,sha256:digest(bytes)};};
 const manifest=await control('manifest',{index,rawRoot,registry:registry.registryPin,observations:[{path:observationPath,sha256:digest(observationBytes)}],documents:[{documentId:document.id,scope,permission:{kind:'facts_with_attribution'},bounds:{maxDocuments:1,maxChunks:24,maxModelCalls:48,paidMicroUsd:0},requestEvidence}]});
 const importResult=await control('import-result',{jobs:[],holds:[{documentId:document.id,reasonCode:'source_policy_stale'}],coverage:{basis:'authenticated_imported_observations',selected:1,imported:0,held:1,acquisitionStepReceipts:0}});
 const sealResult=await control('seal',{artifacts:{registry:{path:registry.sourcePin.path,sha256:registry.registrySha256}}}),catalogue=await control('catalogue',{});
 const countedSeal={...sealResult,bytes:(await readFile(sealResult.path)).length},countedCatalogue={...catalogue,bytes:(await readFile(catalogue.path)).length};
 const selection=await control('selection',{catalogue:countedCatalogue,seals:[{municipalityId:city.id,sourceId:source.id,corpus:{...index,bytes:indexBytes.length},output:countedSeal}]}),issuance=await control('selection-issuance',{selection:{...selection,bytes:(await readFile(selection.path)).length}});
 const decision:ImportDispositionDecision={schemaVersion:'stadtstack-r1-import-disposition-decision-v1',id:'synthetic-only',issuedBy:'owner',issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),nativeSealSelection:selection,catalogue,policy:{kind:'include_expired_unregistered_discovery',enabledReasons:['unsupported_mime','scope_mismatch','source_policy_stale'],ownerDecision:'dispose_without_processing'},sources:[{municipalityId:city.id,sourceId:source.id,corpus:index,sealResult,manifest,importResult,documents:[{documentId:document.id,sourceSha256:sha256,reasonCode:'source_policy_stale'}]}]};
 const invoke=async(value:unknown=decision)=>withFixtureAuthorizedCorpus(indexBytes,policy,async()=>authenticateImportDispositions({decision:await control('decision',value),nativeSealSelection:issuance,catalogue:countedCatalogue,seals:[{sealResult:countedSeal}],policy,control:pin=>readFile(pin.path),managed:async pin=>{await assertManagedSourceReadable(pin.path,policy);return readFile(pin.path);}}));
 const dispositions=await invoke();assert.equal(dispositions.length,1);assert.equal(dispositions[0].processed,false);assert.deepEqual(dispositions[0].admittedRecordIds,[]);assert.equal(dispositions[0].reasonCode,'source_policy_stale');assert.equal('jobKey' in dispositions[0],false);assert.equal('receiptId' in dispositions[0],false);
 const campaignSource={municipalityId:city.id,sourceId:source.id,corpus:index,documents:[{documentId:document.id,sha256,importDisposition:{decisionSha256:dispositions[0].decision.sha256,reasonCode:'source_policy_stale' as const}}]};
 Step8CampaignSchema.parse({schemaVersion:'stadtstack-r1-step8-campaign-v1',sources:[campaignSource]});assert.doesNotThrow(()=>assertStep8ExportMembership(campaignSource,[],[],[],dispositions));
 assert.throws(()=>assertStep8ExportMembership(campaignSource,[],[],[],[]),/document\/job set/);
 assert.throws(()=>assertStep8ExportMembership(campaignSource,[],[],[],[...dispositions,...dispositions]),/document\/job set/);
 assert.throws(()=>assertStep8ExportMembership(campaignSource,[{documentId:document.id,corpusSha256:index.sha256,result:{taskId:'a'.repeat(64),municipalityId:city.id,sourceSha256:sha256}}],[],[],dispositions),/document\/job set/);
 const disposition={municipalityId:city.id,sourceId:source.id,documentId:document.id,sourceSha256:sha256,admittedRecordIds:[],cases:[],classification:{critical:false,rights:true,disagreement:false},assessments:[],importDisposition:dispositions[0]};
 const inventory={schemaVersion:'stadtstack-r1-step8-exceptions-v2',releaseId:'a'.repeat(64),campaign:index,complete:true,sourceDispositions:[disposition],native:{coverage:[],fieldHolds:{counts:{},unpublishedObservations:0}},preparation:{publicationQuarantine:{schemaVersion:'stadtstack-publication-quarantine-v1',records:[]},criticalHolds:[],classification:{critical:false,rights:false,disagreement:false}},assessments:[]};
 assert.doesNotThrow(()=>Step8ExceptionInventorySchema.parse(inventory));
 const items=inventoryExceptionItems(inventory);assert.equal(items.length,1);assert.equal(items[0].classification,'rights');assert.match(items[0].origin,/importDisposition$/);assert.equal(items[0].blocking,true);
 assert.throws(()=>Step8ExceptionInventorySchema.parse({...inventory,sourceDispositions:[{...disposition,jobKey:'a'.repeat(64)}]}));
 assert.throws(()=>Step8ExceptionInventorySchema.parse({...inventory,sourceDispositions:[{...disposition,admittedRecordIds:['fabricated-record']}]}));
 assert.throws(()=>Step8ExceptionInventorySchema.parse({...inventory,sourceDispositions:[{...disposition,classification:{critical:false,rights:false,disagreement:false}}]}));
 const permanent=structuredClone(decision);permanent.policy={kind:'permanent_only',enabledReasons:['unsupported_mime','scope_mismatch']};await assert.rejects(invoke(permanent),/explicit owner decision/);
 const changed=structuredClone(decision);changed.sources[0].documents[0].reasonCode='unsupported_mime';await assert.rejects(invoke(changed),/differs from authenticated/);
 const changedIdentity=structuredClone(decision);changedIdentity.sources[0].documents[0].sourceSha256='a'.repeat(64);await assert.rejects(invoke(changedIdentity),/identity mismatch/);
 const duplicate=structuredClone(decision);duplicate.sources[0].documents.push(duplicate.sources[0].documents[0]);await assert.rejects(invoke(duplicate),/Duplicate import disposition/);
 const draft={...decision,issuedAt:''};assert.throws(()=>ImportDispositionDecisionSchema.parse(draft));
 assert.throws(()=>assertImportDispositionDecisionCurrent({...decision,expiresAt:new Date(Date.now()-1000).toISOString()}),/expired/);
 const corrupt=structuredClone(decision);corrupt.sources[0].manifest.sha256='f'.repeat(64);await assert.rejects(invoke(corrupt),/evidence pin mismatch/);
});

test('208 synthetic frozen members remain exhaustive and disjoint across native results, terminal exceptions and import rejections',()=>{
 const pin={path:'/synthetic/fixture-control.json',sha256:digest('explicit synthetic control bytes')},corpus={path:'/synthetic/index.json',sha256:digest('explicit synthetic frozen corpus')},municipalityId='synthetic',sourceId='fixture';
 const originals=Array.from({length:208},(_,index)=>({documentId:'synthetic-document-'+index,sha256:digest('synthetic original '+index),jobKey:digest('synthetic native job '+index)}));
 const results=originals.slice(0,174).map(document=>({documentId:document.documentId,corpusSha256:corpus.sha256,result:{taskId:document.jobKey,municipalityId,sourceSha256:document.sha256}}));
 const exceptions=originals.slice(174,184).map(document=>({documentId:document.documentId,jobKey:document.jobKey,sourceSha256:document.sha256,municipalityId,sourceId,corpusSha256:corpus.sha256}));
 const imports:ImportRejectionDisposition[]=originals.slice(184).map(document=>({kind:'import_rejection',municipalityId,sourceId,corpusSha256:corpus.sha256,documentId:document.documentId,sourceSha256:document.sha256,reasonCode:'unsupported_mime',rule:'crawl_import_rejection_v1',decision:pin,sealResult:pin,manifest:pin,importResult:pin,registry:pin,processed:false,admittedRecordIds:[]}));
 const documents=[...originals.slice(0,184),...originals.slice(184).map(({documentId,sha256})=>({documentId,sha256,importDisposition:{decisionSha256:pin.sha256,reasonCode:'unsupported_mime' as const}}))],source={municipalityId,sourceId,corpus,documents};
 assert.doesNotThrow(()=>assertStep8ExportMembership(source,results,exceptions,[],imports));
 assert.throws(()=>assertStep8ExportMembership(source,results,exceptions,[],imports.slice(1)),/document\/job set/);
 assert.throws(()=>assertStep8ExportMembership(source,results,[...exceptions,exceptions[0]],[],imports),/document\/job set/);
 assert.throws(()=>assertStep8ExportMembership(source,results,exceptions,[],[...imports,imports[0]]),/document\/job set/);
 assert.throws(()=>assertStep8ExportMembership(source,results,exceptions,[],[{...imports[0],reasonCode:'scope_mismatch'},...imports.slice(1)]),/document\/job set/);
 assert.throws(()=>Step8CampaignSchema.parse({schemaVersion:'stadtstack-r1-step8-campaign-v1',sources:[{...source,documents:[{...documents[184],jobKey:pin.sha256}]}]}));
});
