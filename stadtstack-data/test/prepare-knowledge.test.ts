import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {prepareKnowledge,withPreparedKnowledge,assertAuthenticatedPreparedPublication} from '../src/prepare-knowledge.ts';
import {KNOWLEDGE_SCHEMA_VERSION,knowledgeEvidenceHash} from '../src/district-schema.ts';
import {knowledgePublicationHold,knowledgePublicationQuarantineCase,quarantineReasonHistogram} from '../src/district-publication.ts';
import {root,hash} from '../src/common.ts';
import {districtRegistrySchema} from '../src/district-registry.ts';
import {writeManagedSourceArtifact} from '../src/district-private-io.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {createPolicyReceipt} from '../src/district-policy-receipt.ts';
import {DistrictCas} from '../src/district-cas.ts';
import {canonicalJson,semanticHash,observation,type AdapterCoverage} from '../src/district-adapter-contract.ts';
import {syntheticTextRecord,syntheticTextContribution} from './helpers/text-publication-fixture.ts';
import {buildR1TextCompositionContext} from '../src/district-r1-text-composition.ts';
import {admitStructuredObservations} from '../src/district-structured-record.ts';
import {randomUUID} from 'node:crypto';
import {encodeStepReceipt,unknownReceiptCounts} from '../src/district-step-receipt.ts';
import {STRUCTURED_WORKER_VERSION} from '../src/district-structured-parser-worker.ts';

const at='2026-10-10T12:00:00.000Z';
test('importable knowledge preparation retains the mandatory district acceptance gate',async()=>{
 for(const minimum of [0,-1,1.5,NaN])await assert.rejects(prepareKnowledge({registry:'not-read',records:'not-read',quarantine:'not-read',minimum}),/at least one evidenced municipality/);
});
test('a replay clock cannot substitute implicit lineage for original ordered text contributions or write staging on failure',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'stadtstack-knowledge-replay-'));
 try{
  const policy=await createCivicPolicyTestContext(t),registry=join(root,'sources','district-registry.json'),registryBytes=await readFile(registry),city=districtRegistrySchema.parse(JSON.parse(registryBytes.toString('utf8'))).municipalities.find(city=>city.sources.length>0)!;
  const inputs={records:{schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt:at,records:[],identityAssertions:[],identityAdmissions:[]},quarantine:{schemaVersion:'stadtstack-quarantine-v1',generatedAt:at,cases:[{kind:'text_model',municipalityId:city.id,sourceId:city.sources[0].id,sourceSha256:hash('synthetic no-case source bytes'),reason:'No supported case in source excerpt'}]}};
  const artifacts:Record<string,Buffer>={registry:registryBytes,records:Buffer.from(JSON.stringify(inputs.records)),quarantine:Buffer.from(JSON.stringify(inputs.quarantine))},pins:{path:string;sha256:string;bytes:number;bindings:{kind:'prepared_source';url:string;sourceSha256:string;observationId:string;receiptSha256:string;independentAllowed:boolean}[]}[]=[];
  for(const [name,bytes] of Object.entries(artifacts)){const path=join(policy.managedRoot,'inputs',`${name}.json`),binding={kind:'prepared_source' as const,url:`https://example.org/synthetic-${name}`,sourceSha256:hash(`synthetic ${name} source`),observationId:`synthetic-${name}`,receiptSha256:hash(`synthetic ${name} receipt`),independentAllowed:true};await writeManagedSourceArtifact(policy.managedRoot,path,bytes,[binding],{...policy.policy,decisionId:policy.decisionId,kind:'artifacts'});pins.push({path:relative(directory,path),sha256:hash(bytes),bytes:bytes.length,bindings:[binding]});}
  const privateProvenance=join(directory,'private-provenance.json'),inventory={schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:pins};await writeFile(privateProvenance,JSON.stringify(inventory));
  const stagingDir=join(directory,'staging'),publicationQuarantinePath=join(directory,'publication-quarantine.json');
  await assert.rejects(prepareKnowledge({registry:join(policy.managedRoot,'inputs','registry.json'),records:join(policy.managedRoot,'inputs','records.json'),quarantine:join(policy.managedRoot,'inputs','quarantine.json'),privateProvenance:{path:privateProvenance,sha256:hash(JSON.stringify(inventory))},policyStateDir:policy.policy.stateDir,policyAuthorityId:policy.policy.authorityId,policyAuthoritySha256:policy.policy.authoritySha256,coverageGeneratedAt:'2026-10-11T09:25:12.545Z',stagingDir,publicationQuarantinePath}),/explicit authenticated ordered text composition/);
  await assert.rejects(lstat(stagingDir),{code:'ENOENT'});await assert.rejects(lstat(publicationQuarantinePath),{code:'ENOENT'});
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('preparation carries text date and URL holds into one source-bound quarantine entry',()=>{
 const record={kind:'text_model' as const,id:'synthetic-held-record',municipalityId:'synthetic-town',sources:[{id:'synthetic-source'}],extraction:{inputSha256:'1'.repeat(64)},documentDate:null,stageDate:null,stages:[],summaryQuote:'Withheld source evidence file:///private/1998-04-03'};
 const original=structuredClone(record),hold=knowledgePublicationHold(record)!;
 const item=knowledgePublicationQuarantineCase(record,hold);
 assert.equal(item.recordId,record.id);
 assert.equal(item.municipalityId,record.municipalityId);
 assert.equal(item.sourceId,record.sources[0].id);
 assert.equal(item.sourceSha256,record.extraction.inputSha256);
 assert.deepEqual(item.publicationReasons,['missing_sourced_date','nonpublic_evidence_url']);
 assert.deepEqual(quarantineReasonHistogram([item]),{categories:[{reason:'missing_sourced_date',count:1},{reason:'nonpublic_evidence_url',count:1}],failedDeterministicChecks:[]});
 assert.equal(JSON.stringify(item).includes('file:///'),false);
 assert.equal(JSON.stringify(item).includes('1998-04-03'),false);
 assert.deepEqual(record,original);
 const dated={...record,documentDate:'1998-04-03'};
 const datedItem=knowledgePublicationQuarantineCase(dated,knowledgePublicationHold(dated)!);
 assert.deepEqual(quarantineReasonHistogram([datedItem]).categories,[{reason:'nonpublic_evidence_url',count:1}]);
 assert.equal(JSON.stringify(datedItem).includes('1998-04-03'),false);
});

test('managed native text intake rejects a corpus outside the exact owner allowlist before publication',async t=>{
 const context=await createCivicPolicyTestContext(t),full=districtRegistrySchema.parse(JSON.parse(await readFile(join(root,'sources','district-registry.json'),'utf8'))),city=full.municipalities[0];
 const registry=districtRegistrySchema.parse({...full,districts:full.districts.filter(district=>district.id===city.districtId),municipalities:[city],inventory:full.inventory.filter(item=>item.ags===city.ags)});
 const source=city.sources.find(source=>source.kind==='website')!,sourceBytes=Buffer.from('Synthetic original source, no model or civic fact asserted.'),record=syntheticTextRecord(registry,'synthetic-native-lease',hash(sourceBytes));
 record.sources[0].id=source.id;record.verification.evidenceHash=knowledgeEvidenceHash(record);
 const cas=new DistrictCas(join(context.root,'cas')),now=Date.now(),checkedAt=new Date(now-1000).toISOString(),expiresAt=new Date(now+300_000).toISOString(),reference=record.sources[0];
 const proof=await createPolicyReceipt({source:{url:reference.url,sha256:reference.sha256,mimeType:reference.mimeType},scope:{publisherId:city.id,sourceId:source.id,municipalityId:city.id,ags:city.ags,tenant:null,observationWindow:at},sourcePolicy:reference.policy,permission:{kind:'distribution_licence',distributionUrl:reference.url,licenceId:'synthetic-test-only',termsUrl:'https://example.org/terms',termsSha256:hash('synthetic terms'),approvalSha256:hash('synthetic approval')},checkedAt,expiresAt},context.policy);
 const receipt=await cas.put(Buffer.from(canonicalJson(proof.receipt)),{kind:'receipt',mimeType:'application/json'});
 await cas.put(sourceBytes,{kind:'source_original',mimeType:reference.mimeType,admission:{state:'allowed',sourceSha256:reference.sha256,policyProofSha256:receipt.sha256,checkedAt,expiresAt}});
 const crawl={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:at,documents:[{id:'synthetic-native-document',municipalityId:city.id,sourceId:source.id,sha256:reference.sha256}],checks:[]},run=syntheticTextContribution(registry,crawl,[record],[]),composition=buildR1TextCompositionContext({contributions:[run],approvedRunOrder:[run.runId],admissions:[{runId:run.runId,recordIds:[record.id]}],generatedAt:at});
 const inputRoot=join(context.managedRoot,'inputs'),artifacts=new Map<string,Buffer>();
 for(const [name,value] of Object.entries(run.artifacts))artifacts.set(`native/${name}.json`,typeof value.bytes==='string'?Buffer.from(value.bytes):Buffer.from(value.bytes));
 const textComposition={schemaVersion:'district-r1-text-composition-input-v1',generatedAt:at,approvedRunOrder:[run.runId],admissions:[{runId:run.runId,recordIds:[record.id]}],contributions:[{runId:run.runId,pins:run.pins,sourceArtifactKind:'native_extraction_output',artifacts:Object.fromEntries(Object.entries(run.artifacts).map(([name,value])=>[name,{path:`native/${name}.json`,sha256:value.sha256}]))}]};
 for(const [name,value] of Object.entries({registry,records:composition.knowledge,quarantine:composition.coverage.quarantine,composition:textComposition,policy:{records:[{recordId:record.id,receipts:[{sourceUrl:reference.url,sourceSha256:reference.sha256,receiptSha256:receipt.sha256}]}]},catalogue:{synthetic:'pinned staging'}}))artifacts.set(`${name}.json`,Buffer.from(JSON.stringify(value)));
 const binding={kind:'prepared_source' as const,url:reference.url,sourceSha256:reference.sha256,observationId:'synthetic-native-lease',receiptSha256:hash('synthetic prepared receipt'),independentAllowed:true},pins=[];
 for(const [name,bytes] of artifacts){const path=join(inputRoot,name);await writeManagedSourceArtifact(context.managedRoot,path,bytes,[binding],{...context.policy,decisionId:context.decisionId,kind:'artifacts'});pins.push({path,sha256:hash(bytes),bytes:bytes.length,bindings:[binding]});}
 const privateProvenancePath=join(context.root,'provenance.json'),encoded=JSON.stringify({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:pins});await writeFile(privateProvenancePath,encoded);
 const options={registry:join(inputRoot,'registry.json'),records:join(inputRoot,'records.json'),quarantine:join(inputRoot,'quarantine.json'),textComposition:join(inputRoot,'composition.json'),policyReceipts:join(inputRoot,'policy.json'),privateProvenance:{path:privateProvenancePath,sha256:hash(encoded)},outputRoot:join(context.root,'prepared-publication'),casRoot:cas.root,policyStateDir:context.policy.stateDir,policyAuthorityId:context.policy.authorityId,policyAuthoritySha256:context.policy.authoritySha256,coverageGeneratedAt:at};
 let entered=false;
 await assert.rejects(withPreparedKnowledge(options,async()=>{entered=true;}),/Invalid option: expected one of/);
 assert.equal(entered,false);
});

test('prepared publication readers bind native structured outputs and staged pins to the actual managed lease',async t=>{
 const context=await createCivicPolicyTestContext(t),full=districtRegistrySchema.parse(JSON.parse(await readFile(join(root,'sources','district-registry.json'),'utf8'))),originalCity=full.municipalities[0];
 const registry=districtRegistrySchema.parse({...full,districts:full.districts.filter(district=>district.id===originalCity.districtId),municipalities:[originalCity],inventory:full.inventory.filter(item=>item.ags===originalCity.ags)});
 const city=registry.municipalities[0],sourceId='synthetic-native-lease',url='https://example.org/native-resolution.csv';
 city.sources.push({id:sourceId,kind:'structured',url,vendor:'other',checkState:'checked',checkedAt:at,evidence:[{url,locator:'Synthetic test only.'}]});
 const sourceBytes=Buffer.from('synthetic adopted plan native row'),sourceSha256=hash(sourceBytes),scope={publisherId:city.id,sourceId,municipalityId:city.id,ags:city.ags,tenant:null,observationWindow:at};
 const cas=new DistrictCas(join(context.root,'cas')),now=Date.now(),checkedAt=new Date(now-1000).toISOString(),expiresAt=new Date(now+300_000).toISOString();
 const proof=await createPolicyReceipt({source:{url,sha256:sourceSha256,mimeType:'text/csv'},scope,sourcePolicy:{robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'},permission:{kind:'facts_with_attribution'},checkedAt,expiresAt},context.policy);
 const receipt=await cas.put(Buffer.from(canonicalJson(proof.receipt)),{kind:'receipt',mimeType:'application/json'});
 await cas.put(sourceBytes,{kind:'source_original',mimeType:'text/csv',admission:{state:'allowed',sourceSha256,policyProofSha256:receipt.sha256,checkedAt,expiresAt}});
 const native=observation({publisherId:scope.publisherId,sourceId,nativeId:'synthetic-resolution',nativeVersion:null,kind:'Resolution',subject:'synthetic plan',predicate:'adopts_plan',value:'synthetic adopted plan',unit:null,date:'2026-10-10',dateRole:'adoption',financialRole:'none',geography:{ags:city.ags,basis:'source_explicit',role:'administrative_area'},sourceReferenceDate:null,publishedAt:null,retrievedAt:at,evidence:[{sourceSha256,format:'csv',nativeId:'synthetic-resolution',path:'/adoption',sheet:null,rowKey:'synthetic-resolution',cells:['adoption'],rawValue:'synthetic adopted plan',schemaHash:hash('synthetic native schema'),mappingVersion:'synthetic-v1'}],limitations:['Synthetic test only; no civic evidence.']});
 const coverage:AdapterCoverage={state:'complete',scope:'synthetic fixture',reason:'Synthetic native row.',checkedAt:at,nextCursor:null,observedRows:1,limitations:['Synthetic test only.']},adapter={id:'synthetic-native-lease',version:'synthetic-v1'},adapterContractSha256=hash('synthetic adapter contract');
 const records=await admitStructuredObservations({adapter,adapterContractSha256,snapshot:{bytes:sourceBytes,sourceSha256,url,mimeType:'text/csv',retrievedAt:at,policyReceiptSha256:receipt.sha256,sourceVersion:null},scope,districtId:city.districtId,candidates:[native],replayInSandbox:async()=>({observations:[native],coverage}),checkCurrentPolicy:async()=>({allowed:true,receiptSha256:receipt.sha256,sourceSha256,scopeSha256:semanticHash(scope),checkedAt})});
 const parserContractSha256=hash('synthetic parser contract'),hostContractSha256=hash('synthetic host contract');
 const output=await cas.put(Buffer.from(canonicalJson({schemaVersion:'district-structured-job-result-v1',requestSha256:hash('synthetic parser request'),adapterId:adapter.id,adapterVersion:adapter.version,adapterContractSha256,parserContractSha256,hostContractSha256,scope,sourceSha256,policyReceiptSha256:receipt.sha256,supportingSources:[],result:{observations:[native],coverage},page:null,records,unpublishedObservations:0})),{kind:'receipt',mimeType:'application/json'});
 const step=encodeStepReceipt({version:'district-step-receipt-v1',canonicalizationVersion:'district-json-v1',id:randomUUID(),runId:randomUUID(),jobKey:hash('synthetic native parse job'),step:'structured_parse',lane:'cpu',sourceId,municipalityId:city.id,attempt:1,leaseToken:'1',category:'development',dependencyReceiptIds:[],enqueuedAt:checkedAt,startedAt:checkedAt,finishedAt:checkedAt,queueWaitMs:0,elapsedMs:null,cpuUserMicros:null,cpuSystemMicros:null,outcome:'succeeded',reasonCode:'completed',inputHashes:[sourceSha256,receipt.sha256],outputHashes:[output.sha256],policyProofSha256:receipt.sha256,originProofSha256:null,versions:{worker:STRUCTURED_WORKER_VERSION,adapter:adapter.version,parser:parserContractSha256,host:hostContractSha256},cache:{disposition:'miss',originalGenerationReceiptId:null},provider:null,counts:{...unknownReceiptCounts,rows:1,acceptedFacts:1}});
 await cas.put(Buffer.from(step.bytes),{kind:'receipt',mimeType:'application/json'});
 const structured={schemaVersion:'district-structured-run-v1',generatedAt:at,registrySha256:hash(JSON.stringify(registry)),questionDispositionSha256:hash('synthetic question disposition'),adapterContractSha256:semanticHash([adapterContractSha256]),records,coverage:[{family:'synthetic-fixture',operation:'parse',adapterId:adapter.id,adapterVersion:adapter.version,municipalityId:city.id,sourceId,scopeSha256:semanticHash(scope),sourceSha256,policyReceiptSha256:receipt.sha256,stepReceiptSha256:step.sha256,additionalStepReceiptSha256s:[],coverage}]};
 const knowledge={schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt:at,records,identityAssertions:[],identityAdmissions:[]},quarantine={schemaVersion:'stadtstack-quarantine-v1',generatedAt:at,cases:[]};
 const inputRoot=join(context.managedRoot,'inputs'),artifacts=new Map<string,Buffer>();
 for(const [name,value] of Object.entries({registry,records:knowledge,quarantine,structured,policy:{records:[{recordId:records[0].id,receipts:[{sourceUrl:url,sourceSha256,receiptSha256:receipt.sha256}]}]},catalogue:{synthetic:'pinned staging'}}))artifacts.set(`${name}.json`,Buffer.from(JSON.stringify(value)));
 const binding={kind:'prepared_source' as const,url,sourceSha256,observationId:'synthetic-native-lease',receiptSha256:hash('synthetic prepared receipt'),independentAllowed:true},pins=[];
 for(const [name,bytes] of artifacts){const path=join(inputRoot,name);await writeManagedSourceArtifact(context.managedRoot,path,bytes,[binding],{...context.policy,decisionId:context.decisionId,kind:'artifacts'});pins.push({path,sha256:hash(bytes),bytes:bytes.length,bindings:[binding]});}
 const privateProvenancePath=join(context.root,'provenance.json'),encoded=JSON.stringify({schemaVersion:'stadtstack-private-publication-provenance-v1',inputs:pins});await writeFile(privateProvenancePath,encoded);
 const options={registry:join(inputRoot,'registry.json'),records:join(inputRoot,'records.json'),quarantine:join(inputRoot,'quarantine.json'),structuredRun:join(inputRoot,'structured.json'),policyReceipts:join(inputRoot,'policy.json'),privateProvenance:{path:privateProvenancePath,sha256:hash(encoded)},outputRoot:join(context.root,'prepared-publication'),casRoot:cas.root,policyStateDir:context.policy.stateDir,policyAuthorityId:context.policy.authorityId,policyAuthoritySha256:context.policy.authoritySha256,coverageGeneratedAt:at};
 let expiredPath='';
 const ended=await withPreparedKnowledge(options,async prepared=>{
  expiredPath=join(prepared.stagingDir,'knowledge/records.json');
  assert.doesNotThrow(()=>assertAuthenticatedPreparedPublication(prepared.publication));
  assert.equal(Object.isFrozen(prepared.publication),true);
  assert.deepEqual(JSON.parse((await prepared.publication.read(expiredPath)).toString('utf8')),knowledge);
  const actualCoverage=JSON.parse((await prepared.publication.read(join(prepared.stagingDir,'knowledge/coverage.json'))).toString('utf8'));
  assert.equal(actualCoverage.retainedPublication,null);
  assert.equal(actualCoverage.textLineage,null);
  assert.equal(actualCoverage.accounting.publishedMunicipalities,1);
  assert.deepEqual(JSON.parse((await prepared.publication.read(join(prepared.stagingDir,'catalogue.json'))).toString('utf8')),{synthetic:'pinned staging'});
  await assert.rejects(prepared.publication.read(join(inputRoot,'records.json')));
  prepared.outputPins[0].sha256=hash('tampered output pin');
  await writeFile(expiredPath,'tampered');await assert.rejects(prepared.publication.read(expiredPath));
  return prepared.publication;
 },{staging:[{destination:'catalogue.json',pin:{path:join(inputRoot,'catalogue.json'),sha256:hash(artifacts.get('catalogue.json')!)}}]});
 assert.throws(()=>assertAuthenticatedPreparedPublication(ended));
 await assert.rejects(ended.read(expiredPath));
});
