import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {prepareKnowledge,prepareKnowledgeOptionsSchema,knowledgeSourcePinSchema,knowledgePreparedSourcePinSchema,knowledgeRetainedPublicationSourcePinSchema} from '../src/prepare-knowledge.ts';
import type {PrepareKnowledgeOptions,KnowledgeSourcePin,KnowledgeRetainedPublicationSourcePin} from '../src/prepare-knowledge.ts';
import {knowledgePublicationHold,knowledgePublicationQuarantineCase,quarantineReasonHistogram} from '../src/district-publication.ts';
import {sha256,knowledgeEvidenceHash,DistrictKnowledgeRecordSchema,REQUIRED_DETERMINISTIC_CHECKS,KNOWLEDGE_SCHEMA_VERSION} from '../src/district-schema.ts';
import type {DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {GRAPH_DETERMINISTIC_CHECKS} from '../src/district-graph-claims.ts';
import {PROVIDER_CONFIGS} from '../src/district-model-contract.ts';
import {prepareDocument,cachePreparedDocument,preparedSourceBindings} from '../src/district-prepared-document.ts';
import type {PreparedSourceReference} from '../src/district-prepared-document.ts';
import {writeManagedSourceJson,writeManagedSourceArtifact,writePrivateJson} from '../src/district-private-io.ts';
import {assertManagedSourceReadable,recordHostOptOut,HostOptedOutError} from '../src/civic-opt-out.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {knowledgePreparationInputsSchema} from '../src/district-publication-inputs.ts';
import {importOperatorRegistryConfig} from '../src/district-registry-config.ts';
import {registryDescriptor} from './fixtures/operator-registry.ts';
import {authorizedPilotCorpusSchema} from '../src/district-corpus.ts';
import {retainedPublicationSources,importRetainedPublicationMember} from '../src/district-retained-import.ts';
import {dataReleaseId,type DataRelease} from '../src/data-release.ts';

const at='2026-10-11T12:00:00.000Z',earlier='2026-10-01T12:00:00.000Z';
// Synthetic source/model/judge receipts below exercise intake only, never a native model or network.
async function intakeFixture(t:TestContext){
 const fixture=await createCivicPolicyTestContext(t),url='https://example.org/source';
 const text='Synthetic town. Synthetic heat plan. Der synthetische Wärmeplan liegt als Entwurf vor. Document date 2026-10-01. This source is invented exclusively for an offline regression fixture; it does not describe an actual municipality or establish real planning progress.';
 const reference:PreparedSourceReference={id:'website',url,sha256:sha256(text),retrievedAt:at,locator:'complete synthetic text',mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt',checkedAt:at},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
 const prepared=await prepareDocument({bytes:Buffer.from(text),municipalityId:'synthetic-town',references:[reference],mimeType:'text/plain',extractorSha256:sha256('synthetic preparation'),toolVersions:{node:'synthetic-fixture'},managedRoot:join(fixture.root,'prepared'),policy:fixture.policy});
 const managed={decisionId:fixture.decisionId,...fixture.policy},bindings=preparedSourceBindings(prepared.references,prepared.receiptSha256);
 const preparedPath=await cachePreparedDocument(join(fixture.root,'prepared'),prepared,managed),preparedBytes=await readFile(preparedPath);
 const preparedPin=knowledgePreparedSourcePinSchema.parse({path:preparedPath,sha256:sha256(preparedBytes),bytes:preparedBytes.length,bindings});
 const sourcePin=async(name:string,value:unknown):Promise<KnowledgeSourcePin>=>{
  const path=join(fixture.managedRoot,name+'.json'),bytes=Buffer.byteLength(JSON.stringify(value,null,2)+'\n');
  return knowledgeSourcePinSchema.parse({path,sha256:await writeManagedSourceJson(fixture.managedRoot,path,value,bindings,managed),bytes,bindings});
 };
 const evidence={url,locator:'synthetic registry evidence',sha256:sha256(text),retrievedAt:earlier};
 const registry={schemaVersion:'stadtstack-source-registry-v1',generatedAt:earlier,districts:[{id:'synthetic-district',name:'Synthetic district',ags:'12064',state:'Brandenburg',inventorySources:[evidence],inventoryAsOf:'2026-10-01',inventoryComplete:true}],municipalities:[{id:'synthetic-town',name:'Synthetic town',ags:'12064001',districtId:'synthetic-district',districtAgs:'12064',amt:null,administrativeStatus:'amtsfrei',administrativeEvidence:[evidence],identitySources:[evidence],sources:['website','council','participation','gazette'].map(kind=>({id:kind,kind,url,vendor:'unknown',checkState:kind==='website'?'checked':'not_checked',checkedAt:kind==='website'?earlier:null,evidence:kind==='website'?[evidence]:[],reason:'Synthetic source configuration'})),seedDocuments:[{url,sourceId:'website',title:'Synthetic heat plan',documentDate:'2026-10-01',evidence:[evidence]}]}],inventory:[{ags:'12064001',name:'Synthetic town',districtId:'synthetic-district',identitySourceUrl:url,pilot:true,sourceCheckState:'not_checked',reason:'Synthetic fixture'}],notes:['Synthetic registry only']};
 const descriptor=await registryDescriptor(fixture,registry);
 const registryPin=await importOperatorRegistryConfig({...descriptor,managedRoot:fixture.managedRoot,destinationPath:'registry.json'},fixture.policy),config=PROVIDER_CONFIGS['openai-subscription'],identity=sha256('synthetic model identity');
 function record(label:string,clock:string):DistrictKnowledgeRecord{
  const row={id:'synthetic-record',municipalityId:'synthetic-town',ags:'12064001',districtId:'synthetic-district',title:'Synthetic heat plan',titleQuote:'Synthetic heat plan',summary:'Der synthetische Wärmeplan liegt als Entwurf vor.',summaryQuote:'Der synthetische Wärmeplan liegt als Entwurf vor.',municipalityQuote:'Synthetic town',caseKeyType:'source_document',caseKey:`source_document:${reference.sha256}`,caseQuote:null,caseType:'planning',documentDate:'2026-10-01',documentDateQuote:'Document date 2026-10-01',documentDateReason:null,stage:'draft',stageDate:null,stageDateQuote:null,stageDateReason:'No separate event date',originalStatus:'Entwurf',stageQuote:'als Entwurf',stages:[],topics:[],locations:[],entities:[],relations:[],sources:[{...reference,retrievedAt:earlier,policy:{...reference.policy,robots:{...reference.policy.robots,checkedAt:earlier}}}],extraction:{extractorVersion:'synthetic-extractor',extractorSha256:sha256('synthetic-extractor'),model:config.model,provider:'openai-subscription',tool:config.tool,toolVersion:'synthetic-tool',modelIdentitySha256:identity,modelIdentityBasis:config.modelIdentityBasis,returnedModel:null,runtimeWarnings:[],promptVersion:'synthetic-prompt',promptSha256:sha256('synthetic-prompt'),judgePromptVersion:'synthetic-judge',judgePromptSha256:sha256('synthetic-judge'),inputSha256:reference.sha256,textSha256:prepared.textSha256,responseSha256:sha256(label),ocrUsed:false,textMethod:'text',cacheKey:sha256('cache:'+label),extractedAt:clock,chunk:{index:0,count:1,start:0,end:prepared.textLength}},verification:{status:'auto-verified',deterministic:{passed:true,checks:[...REQUIRED_DETERMINISTIC_CHECKS,...GRAPH_DETERMINISTIC_CHECKS].map(id=>({id,passed:true,reason:'Synthetic fixture gate'}))},faithfulness:{score:0.9,threshold:0.8,model:config.model,provider:'openai-subscription',tool:config.tool,toolVersion:'synthetic-tool',modelIdentitySha256:identity,returnedModel:null,reason:'Synthetic fixture, not an actual model judgment',evaluatedAt:clock,responseSha256:sha256('judge:'+label),sameModel:true,limitation:'Same-model judgment is not independent verification.'},evidenceHash:''}};
  row.verification.evidenceHash=knowledgeEvidenceHash(row);return DistrictKnowledgeRecordSchema.parse(row);
 }
 const runs:PrepareKnowledgeOptions['runs']=[],originals:DistrictKnowledgeRecord[]=[];
 for(const [label,clock] of [['first','2026-10-02T12:00:00.000Z'],['second',earlier]]){
  const original=record(label,clock);originals.push(original);
  const crawl=await sourcePin(label+'-crawl',{schemaVersion:'stadtstack-crawl-index-v1',generatedAt:clock,documents:[{id:'synthetic-document',municipalityId:'synthetic-town',sourceId:'website',sha256:reference.sha256,url,retrievedAt:clock}],checks:[{municipalityId:'synthetic-town',sourceId:'website',checkState:'checked',checkedAt:clock,documentCount:1,coverage:{state:'partial',pendingCount:0,runnableCount:0,blockedCount:0,sourceCoverage:'not_assessed',targetScope:{kind:'page_roots',state:'complete',urls:[url],pendingCount:0,runnableCount:0,blockedCount:0}}}]});
  const pins={corpusSha256:crawl.sha256,registrySha256:registryPin.sha256,promptContractSha256:sha256('synthetic-contract'),schemaSha256:sha256('synthetic-schema')};
  const run={schemaVersion:'stadtstack-extraction-run-v2',generatedAt:clock,assignmentMode:'codex-only',...pins,scope:'all_fetched_documents',maxDocumentsPerMunicipality:null,availableDocumentGroups:1,attemptedDocumentGroups:1,pendingDocumentGroups:0,municipalities:[{id:'synthetic-town',selectedDocumentGroups:1,preparedDocumentGroups:1,attemptedDocumentGroups:1}]};
  const runPath=join(fixture.root,label+'-run.json'),runHash=await writePrivateJson(runPath,run);
  runs.push({runId:runHash,pins,sourceArtifactKind:'native_extraction_output',artifacts:{extractionRun:{path:runPath,sha256:runHash,bytes:Buffer.byteLength(JSON.stringify(run,null,2)+'\n')},records:await sourcePin(label+'-records',{schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt:clock,records:[original]}),quarantine:await sourcePin(label+'-quarantine',{schemaVersion:'stadtstack-quarantine-v1',generatedAt:clock,cases:[]}),crawl,registry:registryPin},admissions:[{recordId:original.id,prepared:[preparedPin]}]});
 }
 const approved=new Set(runs.map(run=>run.pins.corpusSha256)),parseCorpus=authorizedPilotCorpusSchema.parse.bind(authorizedPilotCorpusSchema);
 t.mock.method(authorizedPilotCorpusSchema,'parse',(value:unknown)=>typeof value==='string'&&approved.has(value)?value:parseCorpus(value));
 const options=prepareKnowledgeOptionsSchema.parse({schemaVersion:'stadtstack-managed-knowledge-intake-v1',policy:fixture.policy,registry:registryPin,runs,approvedRunOrder:runs.map(run=>run.runId),generatedAt:at,minimumPerDistrict:1,output:{root:join(fixture.root,'output'),stagingDir:join(fixture.root,'output','knowledge'),auditDir:join(fixture.root,'audit')}});
 return {...fixture,options,originals,prepared,preparedPin,sourcePin};
}

async function retainedFixture(t:TestContext){
 const f=await intakeFixture(t),firstRun=f.options.runs[0];
 // Seal an actual synthetic intake result; this is not a manifest invented for a historical real commit.
 const first=await prepareKnowledge({...f.options,runs:[firstRun],approvedRunOrder:[firstRun.runId]}),publicationRoot=join(f.root,'published-baseline'),managedRoot=join(f.root,'retained-members'),managed={decisionId:f.decisionId,...f.policy};
 const names=['registry','records','coverage'] as const,files:DataRelease['files']=[];
 for(const [index,pin] of first.outputs.entries()){
  const path='knowledge/'+names[index]+'.json',bytes=await readFile(pin.path);
  await writeManagedSourceArtifact(publicationRoot,join(publicationRoot,path),bytes,pin.bindings,managed);
  files.push({path,sha256:sha256(bytes),bytes:bytes.length});
 }
 const manifest:DataRelease={schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt:at,files,quality:{publishedRecords:first.records,quarantinedRecords:0,cities:1}};
 const manifestPath=join(publicationRoot,'release-manifest.json'),manifestBytes=JSON.stringify(manifest,null,2)+'\n',manifestSha=await writeManagedSourceArtifact(publicationRoot,manifestPath,manifestBytes,first.outputs[0].bindings,managed);
 const members={} as Record<typeof names[number],KnowledgeRetainedPublicationSourcePin>;
 for(const name of names){
  const value=JSON.parse(await readFile(join(publicationRoot,'knowledge',name+'.json'),'utf8'));
  const imported=await importRetainedPublicationMember({publicationRoot,manifestSha256:manifestSha,releaseId:manifest.id,memberPath:'knowledge/'+name+'.json',declaredSources:retainedPublicationSources(value),managedRoot,destinationPath:'knowledge/'+name+'.json'},f.policy);
  members[name]=knowledgeRetainedPublicationSourcePinSchema.parse({path:imported.path,sha256:imported.sha256,bytes:imported.bytes,bindings:imported.bindings});
 }
 const options=prepareKnowledgeOptionsSchema.parse({...f.options,runs:[],approvedRunOrder:[],retainedPublication:{artifacts:{manifest:{path:manifestPath,sha256:manifestSha,bytes:Buffer.byteLength(manifestBytes)},...members},admissions:[{recordId:f.originals[0].id,originalEvidenceHash:f.originals[0].verification.evidenceHash}]},generatedAt:'2026-10-12T12:00:00.000Z',output:{root:join(f.root,'republished'),stagingDir:join(f.root,'republished','knowledge'),auditDir:join(f.root,'republished-audit')}});
 return {f,first,manifest,options,members};
}

test('managed source pins without operator configuration provenance cannot authorize the current registry',async t=>{
 const fixture=await intakeFixture(t),value=JSON.parse(await readFile(fixture.options.registry.path,'utf8'));
 const source=await fixture.sourcePin('not-operator-configuration',value);
 await assert.rejects(prepareKnowledge({...fixture.options,registry:source} as unknown as PrepareKnowledgeOptions));
 const options=structuredClone(fixture.options);options.runs[0].artifacts.registry=source as typeof options.registry;
 await assert.rejects(prepareKnowledge(options));
 await assert.rejects(lstat(fixture.options.output.root),{code:'ENOENT'});
});
test('self-consistent native runs over an unapproved corpus are rejected at intake',async t=>{
 const fixture=await intakeFixture(t);
 t.mock.restoreAll();
 await assert.rejects(prepareKnowledge(fixture.options),/Invalid option/);
 await assert.rejects(lstat(fixture.options.output.stagingDir),{code:'ENOENT'});
});
test('explicit intake schema retains mandatory district acceptance and rejects legacy fallback options',()=>{
 for(const minimumPerDistrict of [0,-1,1.5,NaN])assert.equal(prepareKnowledgeOptionsSchema.safeParse({minimumPerDistrict}).success,false);
 assert.equal(prepareKnowledgeOptionsSchema.safeParse({registry:'out/knowledge/registry.json',records:'out/knowledge/records.json'}).success,false);
});
test('managed multirun intake authenticates original clocks and records real preparation dependencies',async t=>{
 const fixture=await intakeFixture(t),result=await prepareKnowledge(fixture.options);
 assert.equal(result.records,1);
 const records=JSON.parse(await readFile(result.outputs[1].path,'utf8'));
 assert.equal(records.records[0].stage,'draft');assert.equal(records.records[0].originalStatus,'Entwurf');
 assert.ok(fixture.prepared.text.includes(records.records[0].stageQuote));assert.ok(fixture.prepared.text.includes(records.records[0].summaryQuote));
 assert.deepEqual(records.records[0].extraction,fixture.originals[1].extraction);
 assert.deepEqual(records.records[0].sources,fixture.originals[1].sources,'fresh source-policy observation must not rewrite original source clocks');
 const coverage=JSON.parse(await readFile(result.outputs[2].path,'utf8'));
 assert.deepEqual(coverage.textLineage.runs.map((run:{runId:string})=>run.runId),fixture.options.approvedRunOrder);
 for(const pin of [...result.outputs,...Object.values(result.privateArtifacts)]){
  await assertManagedSourceReadable(pin.path,fixture.policy);
  const bytes=await readFile(pin.path);assert.equal(sha256(bytes),pin.sha256);assert.equal(bytes.length,pin.bytes);
 }
 const receipt=knowledgePreparationInputsSchema.parse(JSON.parse(await readFile(result.preparationReceipt.path,'utf8')));
 assert.equal(receipt.dependencies.find(item=>item.role==='registry')?.sha256,fixture.options.registry.sha256);
 assert.equal(receipt.dependencies.find(item=>item.role==='candidate_records')?.sha256,result.privateArtifacts['candidate-records'].sha256);
 assert.equal(receipt.dependencies.find(item=>item.role==='candidate_quarantine')?.sha256,result.privateArtifacts['candidate-quarantine'].sha256);
 assert.deepEqual(receipt.outputs.map(item=>item.sha256),result.outputs.map(item=>item.sha256));
 const audit=await readFile(result.audit['current-admissions'].path,'utf8');assert.equal(audit.includes(fixture.originals[0].summary),false);assert.equal(audit.includes(fixture.originals[0].sources[0].url),false);
});
test('unapproved order and wrong original artifact pins fail before staging',async t=>{
 const fixture=await intakeFixture(t);
 const reversed=structuredClone(fixture.options);reversed.approvedRunOrder.reverse();
 await assert.rejects(prepareKnowledge(reversed),/approved input order/);
 const wrong=structuredClone(fixture.options);wrong.runs[0].artifacts.records.sha256=sha256('different bytes');
 await assert.rejects(prepareKnowledge(wrong),/byte hash/);
 await assert.rejects(lstat(fixture.options.output.root),{code:'ENOENT'});
});
test('unmanaged copies and active objections cannot be admitted from valid old receipts',async t=>{
 const fixture=await intakeFixture(t),copy=join(fixture.root,'unenrolled.json'),original=fixture.options.runs[0].artifacts.records;
 await writeFile(copy,await readFile(original.path),{mode:0o600});
 const unmanaged=structuredClone(fixture.options);unmanaged.runs[0].artifacts.records.path=copy;
 await assert.rejects(prepareKnowledge(unmanaged));
 await recordHostOptOut({host:'example.org',reason:'municipality_objection',reference:'synthetic-intake-objection'},fixture.policy);
 await assert.rejects(prepareKnowledge(fixture.options),/objection/);
 await assert.rejects(lstat(fixture.options.output.root),{code:'ENOENT'});
});
test('current prepared references must cover original source identities without changing source policy clocks',async t=>{
 const fixture=await intakeFixture(t);
 const missing=structuredClone(fixture.options);missing.runs[0].admissions[0].prepared=[];
 await assert.rejects(prepareKnowledge(missing));
 const raw=structuredClone(fixture.prepared);raw.textSha256=sha256('mismatched prepared text');
 const invalid=await fixture.sourcePin('invalid-prepared',raw),wrong=structuredClone(fixture.options);wrong.runs[0].admissions[0].prepared=[knowledgePreparedSourcePinSchema.parse(invalid)];
 await assert.rejects(prepareKnowledge(wrong),/Prepared receipt hash mismatch|text hash/);
 await assert.rejects(lstat(fixture.options.output.root),{code:'ENOENT'});
});

test('preparation carries structured date and URL holds into one source-bound quarantine entry',()=>{
 const record={id:'synthetic-held-record',municipalityId:'synthetic-town',sources:[{id:'synthetic-source'}],extraction:{inputSha256:'1'.repeat(64)},documentDate:null,stageDate:null,stages:[],summaryQuote:'Withheld source evidence file:///private/1998-04-03'};
 const original=structuredClone(record),hold=knowledgePublicationHold(record)!;
 const item=knowledgePublicationQuarantineCase(record,hold);
 assert.equal(item.recordId,record.id);assert.equal(item.municipalityId,record.municipalityId);assert.equal(item.sourceId,record.sources[0].id);assert.equal(item.sourceSha256,record.extraction.inputSha256);
 assert.deepEqual(item.publicationReasons,['missing_sourced_date','nonpublic_evidence_url']);
 assert.deepEqual(quarantineReasonHistogram([item]),{categories:[{reason:'missing_sourced_date',count:1},{reason:'nonpublic_evidence_url',count:1}],failedDeterministicChecks:[]});
 assert.equal(JSON.stringify(item).includes('file:///'),false);assert.equal(JSON.stringify(item).includes('1998-04-03'),false);assert.deepEqual(record,original);
 const dated={...record,documentDate:'1998-04-03'},datedItem=knowledgePublicationQuarantineCase(dated,knowledgePublicationHold(dated)!);
 assert.deepEqual(quarantineReasonHistogram([datedItem]).categories,[{reason:'nonpublic_evidence_url',count:1}]);assert.equal(JSON.stringify(datedItem).includes('1998-04-03'),false);
});

test('a new composition clock cannot replace an original frozen corpus binding',async t=>{
 const fixture=await intakeFixture(t),options=structuredClone(fixture.options);
 const crawl=JSON.parse(await readFile(options.runs[0].artifacts.crawl.path,'utf8'));crawl.generatedAt='2030-01-01T00:00:00.000Z';
 options.runs[0].artifacts.crawl=await fixture.sourcePin('changed-corpus',crawl);options.generatedAt='2030-01-02T00:00:00.000Z';
 await assert.rejects(prepareKnowledge(options),/Original registry\/corpus artifact pin mismatch/);
 await assert.rejects(lstat(options.output.root),{code:'ENOENT'});
});

test('minimum district acceptance and current reference membership remain mandatory',async t=>{
 const fixture=await intakeFixture(t);
 for(const minimumPerDistrict of [0,-1,1.5,NaN])await assert.rejects(prepareKnowledge({...fixture.options,minimumPerDistrict}));
 const prepared=await prepareDocument({bytes:Buffer.from(fixture.prepared.text),municipalityId:fixture.prepared.municipalityId,references:fixture.prepared.references.map(reference=>({...reference,id:'another-source'})),mimeType:fixture.prepared.mimeType,extractorSha256:fixture.prepared.extractorSha256,toolVersions:fixture.prepared.toolVersions,managedRoot:join(fixture.root,'another-prepared'),policy:fixture.policy});
 const path=await cachePreparedDocument(join(fixture.root,'another-prepared'),prepared,{decisionId:fixture.decisionId,...fixture.policy}),bytes=await readFile(path);
 const pin=knowledgePreparedSourcePinSchema.parse({path,sha256:sha256(bytes),bytes:bytes.length,bindings:preparedSourceBindings(prepared.references,prepared.receiptSha256)});
 const options=structuredClone(fixture.options);options.runs[0].admissions[0].prepared=[pin];
 await assert.rejects(prepareKnowledge(options),/Current prepared references do not cover every original source identity/);
 await assert.rejects(lstat(options.output.root),{code:'ENOENT'});
});

test('declared source pins cannot relabel or add provenance beyond the authoritative ledger',async t=>{
 const fixture=await intakeFixture(t),pin=fixture.options.runs[0].artifacts.records,original=pin.bindings[0];
 assert.equal(original.kind,'prepared_source');
 if(original.kind!=='prepared_source')throw Error('Synthetic fixture requires prepared provenance');
 const forgeries:KnowledgeSourcePin['bindings'][]=[
  [{...original,url:'https://never-enrolled.test/source'}],
  [{...original,sourceSha256:sha256('unrelated source')}],
  [{...original,receiptSha256:sha256('fabricated prepared receipt')}],
  [original,{...original,observationId:'unobserved-source'}],
  [{kind:'retained_publication',url:original.url,sourceSha256:original.sourceSha256,independentAllowed:false,publication:{manifestSha256:sha256('unobserved manifest'),releaseId:sha256('unobserved release'),memberPath:'knowledge/records.json',memberSha256:pin.sha256,memberBytes:pin.bytes}}],
 ];
 for(const bindings of forgeries){
  const options=structuredClone(fixture.options);options.runs[0].artifacts.records.bindings=bindings;
  await assert.rejects(prepareKnowledge(options));await assert.rejects(lstat(options.output.root),{code:'ENOENT'});
 }
});

test('Git-bound current operator registry bootstraps without repainting original run registry pins',async t=>{
 const fixture=await intakeFixture(t),options=structuredClone(fixture.options);
 const value=JSON.parse(await readFile(options.registry.path,'utf8'));value.notes.push('Synthetic explicitly approved current configuration amendment');
 const registry=await registryDescriptor(fixture,value,'amended-registry-code');options.registry=registry;
 const result=await prepareKnowledge(options),receipt=JSON.parse(await readFile(result.preparationReceipt.path,'utf8')),coverage=JSON.parse(await readFile(result.outputs[2].path,'utf8'));
 assert.equal(receipt.dependencies.find((entry:{role:string})=>entry.role==='registry').sha256,registry.sha256);
 assert.deepEqual(coverage.textLineage.runs.map((run:{pins:{registrySha256:string}})=>run.pins.registrySha256),options.runs.map(run=>run.pins.registrySha256));
 assert.ok(result.outputs.every(pin=>pin.bindings.some(binding=>binding.kind==='operator_registry_config'&&binding.configurationSha256===registry.sha256)));
 const materialized=join(options.output.root,'intake/configuration',registry.sha256+'.json');assert.deepEqual(await readFile(materialized),await readFile(registry.path));await assertManagedSourceReadable(materialized,fixture.policy);
 assert.equal(prepareKnowledgeOptionsSchema.safeParse({...options,runs:options.runs.map(run=>({...run,admissions:[{recordId:'synthetic-record',prepared:[result.outputs[0]]}]}))}).success,false,'derived control metadata cannot authorize prepared source admission');
});

test('sealed retained-only intake needs no private native or prepared artifacts and preserves original evidence clocks',async t=>{
 const {f,options,manifest,members}=await retainedFixture(t);
 const unavailable=new Set([f.preparedPin.path,...f.options.runs.flatMap(run=>Object.values(run.artifacts).flatMap(pin=>pin&&pin.path!==options.registry.path?[pin.path]:[]))]);
 for(const path of unavailable)await unlink(path);
 t.mock.restoreAll(); // Retained admission must not depend on the synthetic corpus authorization seam.
 const result=await prepareKnowledge(options),records=JSON.parse(await readFile(result.outputs[1].path,'utf8')),coverage=JSON.parse(await readFile(result.outputs[2].path,'utf8'));
 assert.deepEqual(records.records,[f.originals[0]]);
 assert.equal(coverage.textLineage,null);assert.equal(coverage.retainedPublication.releaseId,manifest.id);
 assert.equal(coverage.historicalCoverage.publication.generatedAt,at);
 assert.equal(coverage.historicalCoverage.publication.nativeRuns[0].runId,f.options.runs[0].runId);
 assert.equal(coverage.coverageScope.crossCohortUniqueDocumentGroups,'unknown');
 assert.equal(coverage.municipalities[0].documents,0);assert.equal(coverage.municipalities[0].checked,false);assert.equal(coverage.municipalities[0].status,'gated_records');
 const audit=JSON.parse(await readFile(result.audit['current-admissions'].path,'utf8'));
 assert.equal(audit.schemaVersion,'stadtstack-knowledge-current-admissions-v2');assert.equal(audit.records.length,1);
 assert.equal(audit.records[0].basis,'retained_publication');assert.equal(audit.records[0].originalEvidenceHash,f.originals[0].verification.evidenceHash);
 assert.equal(audit.records[0].publication.releaseId,manifest.id);assert.equal(audit.records[0].publication.memberSha256,members.records.sha256);
 assert.equal('runId' in audit.records[0],false);assert.equal('preparedReceiptSha256s' in audit.records[0],false);
 assert.equal(JSON.parse(await readFile(result.audit['text-lineage'].path,'utf8')),null);
 const provenance=JSON.parse(await readFile(result.privateArtifacts.provenance.path,'utf8'));
 assert.deepEqual(provenance.runs,[]);assert.deepEqual(Object.keys(provenance.retainedPublication.baseline.input.artifacts).sort(),['coverage','manifest','records','registry']);
 const quarantine=JSON.parse(await readFile(result.privateArtifacts['candidate-quarantine'].path,'utf8'));
 assert.deepEqual(quarantine.runs,[]);assert.equal(quarantine.retainedPublication.privateQuarantineAvailability,'not_supplied');
 assert.ok(result.outputs.every(pin=>pin.bindings.some(binding=>binding.kind==='retained_publication')&&pin.bindings.some(binding=>binding.kind==='operator_registry_config')));
});

test('retained baseline precedes admitted native revisions without using generation clocks as release order',async t=>{
 const {f,options}=await retainedFixture(t),native=f.options.runs[1];
 options.runs=[native];options.approvedRunOrder=[native.runId];
 const result=await prepareKnowledge(options),records=JSON.parse(await readFile(result.outputs[1].path,'utf8')),coverage=JSON.parse(await readFile(result.outputs[2].path,'utf8'));
 assert.deepEqual(records.records,[f.originals[1]]);assert.ok(f.originals[1].extraction.extractedAt<f.originals[0].extraction.extractedAt);
 assert.equal(coverage.textLineage.runs.length,1);assert.equal(coverage.textLineage.runs[0].runId,native.runId);
 assert.deepEqual(coverage.retainedPublication.selectedRecordOrigins,[]);
 const audit=JSON.parse(await readFile(result.audit['current-admissions'].path,'utf8'));
 assert.deepEqual(audit.records.map((record:{basis:string})=>record.basis),['retained_publication','native_prepared']);
});

test('an unadmitted native revision does not erase an authenticated retained record',async t=>{
 const {f,options}=await retainedFixture(t),native={...f.options.runs[1],admissions:[]};
 options.runs=[native];options.approvedRunOrder=[native.runId];
 const result=await prepareKnowledge(options),records=JSON.parse(await readFile(result.outputs[1].path,'utf8')),coverage=JSON.parse(await readFile(result.outputs[2].path,'utf8'));
 assert.deepEqual(records.records,[f.originals[0]]);assert.equal(coverage.retainedPublication.selectedRecordOrigins.length,1);
 assert.deepEqual(coverage.textLineage.selectedRecordOrigins,[]);
});

test('retained admission requires the exact original evidence hash and forbids synthetic native/prepared substitutes',async t=>{
 const {f,options}=await retainedFixture(t),wrong=structuredClone(options);
 wrong.retainedPublication!.admissions[0].originalEvidenceHash=sha256('not the original evidence');
 await assert.rejects(prepareKnowledge(wrong),/original evidence hash mismatch/);
 await assert.rejects(lstat(options.output.root),{code:'ENOENT'});
 const retained=options.retainedPublication!;
 assert.equal(prepareKnowledgeOptionsSchema.safeParse({...options,retainedPublication:{...retained,admissions:[{...retained.admissions[0],prepared:[f.preparedPin]}]}}).success,false);
 assert.equal(prepareKnowledgeOptionsSchema.safeParse({...options,retainedPublication:undefined,runs:[{...f.options.runs[0],sourceArtifactKind:'retained_publication'}],approvedRunOrder:[f.options.runs[0].runId]}).success,false);
 const duplicate=structuredClone(options);duplicate.retainedPublication!.admissions.push({...duplicate.retainedPublication!.admissions[0]});
 await assert.rejects(prepareKnowledge(duplicate),/unique exact original record IDs/);
});

test('retained publication current objections and exact member ancestry gate before a new publication copy',async t=>{
 const {f,options}=await retainedFixture(t),wrong=structuredClone(options);
 wrong.retainedPublication!.artifacts.records.bindings[0].publication.manifestSha256=sha256('another manifest');
 await assert.rejects(prepareKnowledge(wrong));await assert.rejects(lstat(options.output.root),{code:'ENOENT'});
 await recordHostOptOut({host:'example.org',reason:'rights_holder_objection',reference:'synthetic-retained-intake-objection'},f.policy);
 await assert.rejects(prepareKnowledge(options),HostOptedOutError);await assert.rejects(lstat(options.output.root),{code:'ENOENT'});
});
