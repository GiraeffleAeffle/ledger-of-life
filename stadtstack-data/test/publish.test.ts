import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import {ZodError} from 'zod';
import {dirname,join} from 'node:path';
import {PublicationPlanSchema,publish,historicalSignalChangeRecords} from '../src/publish.ts';
import {publicationPredecessorMemberSchema,encodePredecessorMetadata,type PublicationPlan} from '../src/district-publication-plan.ts';
import {outDir} from '../src/common.ts';
import {cities} from '../src/cities.ts';
import {coreBundleSchema} from '../src/core-schema.ts';
import {coreSignal,validateCore} from '../src/core.ts';
import {compactCollection} from '../src/min.ts';
import {diff,retainChanges,signalChangeRecord,knowledgeChanges} from '../src/changes.ts';
import {dataReleaseId,verifyDataRelease,type DataRelease} from '../src/data-release.ts';
import {DistrictExtractionClaimsSchema,DistrictKnowledgeRecordSchema,KNOWLEDGE_SCHEMA_VERSION,knowledgeEvidenceHash,sha256} from '../src/district-schema.ts';
import {deterministicChecks} from '../src/district-claims.ts';
import {normalizeGraphClaims} from '../src/district-graph-claims.ts';
import {PROVIDER_CONFIGS} from '../src/district-model-contract.ts';
import {prepareDocument,cachePreparedDocument,preparedSourceBindings} from '../src/district-prepared-document.ts';
import type {PreparedSourceReference} from '../src/district-prepared-document.ts';
import {prepareKnowledge,prepareKnowledgeOptionsSchema,knowledgeSourcePinSchema,knowledgePreparedSourcePinSchema,knowledgeRetainedPublicationSourcePinSchema,type KnowledgeSourcePin} from '../src/prepare-knowledge.ts';
import {writeManagedSourceArtifact,writePrivateJson,type SourceArtifactBinding} from '../src/district-private-io.ts';
import {importRetainedPublicationMember,retainedPublicationSources} from '../src/district-retained-import.ts';
import {assertManagedSourceReadable,recordHostOptOut,HostOptedOutError} from '../src/civic-opt-out.ts';
import {replayPipeline,type ReplayReceipt} from '../src/replay-pipeline.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {publicationRetainedBaselineSchema,publicationPolicyReceiptsSchema} from '../src/district-publication-policy.ts';

const at='2026-10-11T09:25:14.000Z',manifestAt='2026-10-11T09:25:14.460Z',earlier='2026-10-10T12:00:00.000Z';
const encoded=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');

/** Real managed preparation/composition plus exact retained core receipts; no mocked admission gates. */
async function publicationFixture(t:TestContext,legacyChanges=false){
 const fixture=await createCivicPolicyTestContext(t),managed={...fixture.policy,decisionId:fixture.decisionId};
 const text='Stadt Beispielstadt\nWärmeplanung\nDer Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.\nStand: 10.10.2026',url='https://example.org/synthetic-heat-plan';
 const reference:PreparedSourceReference={id:'website',url,sha256:sha256(text),retrievedAt:earlier,locator:'complete synthetic fixture text',mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt',checkedAt:earlier},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
 const preparedRoot=join(fixture.root,'prepared'),prepared=await prepareDocument({bytes:Buffer.from(text),municipalityId:'beispielstadt',references:[reference],mimeType:'text/plain',extractorSha256:sha256('synthetic preparation'),toolVersions:{node:'synthetic-fixture'},managedRoot:preparedRoot,policy:fixture.policy});
 const sourceBindings=preparedSourceBindings(prepared.references,prepared.receiptSha256),preparedPath=await cachePreparedDocument(preparedRoot,prepared,managed),preparedBytes=await readFile(preparedPath);
 const preparedPin=knowledgePreparedSourcePinSchema.parse({path:preparedPath,sha256:sha256(preparedBytes),bytes:preparedBytes.length,bindings:sourceBindings});
 const sourcePin=async(name:string,bytes:Buffer,bindings:SourceArtifactBinding[]=sourceBindings):Promise<KnowledgeSourcePin>=>{
  const path=join(fixture.managedRoot,name);const digest=await writeManagedSourceArtifact(fixture.managedRoot,path,bytes,bindings,managed);
  return knowledgeSourcePinSchema.parse({path,sha256:digest,bytes:bytes.length,bindings});
 };
 const auditPin=async(name:string,value:unknown)=>{const path=join(fixture.root,name),bytes=encoded(value);return {path,sha256:await writePrivateJson(path,value),bytes:bytes.length};};
 const claims=DistrictExtractionClaimsSchema.parse({title:'Wärmeplanung',titleQuote:'Wärmeplanung',summary:'Der Entwurf der Wärmeplanung wurde veröffentlicht.',summaryQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',municipalityQuote:'Stadt Beispielstadt',caseKey:null,caseKeyType:'source_document',caseQuote:null,caseType:'planning',documentDate:'2026-10-10',documentDateQuote:'Stand: 10.10.2026',documentDateReason:null,topics:[],stage:'draft',stageDate:'2026-10-09',stageDateQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stageDateReason:null,originalStatus:'Entwurf',stageQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stages:[],entities:[],relations:[],locations:[]});
 const deterministic=deterministicChecks(claims,text,'Beispielstadt');assert.equal(deterministic.passed,true);
 const config=PROVIDER_CONFIGS['openai-subscription'],modelIdentitySha256=sha256('synthetic model identity');
 const candidate={...claims,...normalizeGraphClaims(claims,{municipalityId:'beispielstadt',ags:'12064001',sourceSha256:reference.sha256}),id:'knowledge:synthetic-publication',municipalityId:'beispielstadt',ags:'12064001',districtId:'synthetic-district',caseKey:'source_document:'+reference.sha256,sources:[reference],
  extraction:{extractorVersion:'synthetic-publication-fixture',extractorSha256:sha256('synthetic extractor'),model:config.model,provider:'openai-subscription',tool:config.tool,toolVersion:'synthetic',modelIdentitySha256,modelIdentityBasis:config.modelIdentityBasis,returnedModel:null,promptVersion:'synthetic-prompt',promptSha256:sha256('synthetic prompt'),judgePromptVersion:'synthetic-judge',judgePromptSha256:sha256('synthetic judge'),inputSha256:reference.sha256,textSha256:prepared.textSha256,responseSha256:sha256('synthetic response'),ocrUsed:false,textMethod:'text',cacheKey:sha256('synthetic cache'),extractedAt:earlier,chunk:{index:0,count:1,start:0,end:prepared.textLength}},
  verification:{status:'auto-verified',deterministic,faithfulness:{score:0.9,threshold:0.8,model:config.model,provider:'openai-subscription',tool:config.tool,toolVersion:'synthetic',modelIdentitySha256,returnedModel:null,reason:'Synthetic fixture only; no model executed',evaluatedAt:earlier,responseSha256:sha256('synthetic judge response'),sameModel:true,limitation:'Same-model judgment is not independent verification.'},evidenceHash:''}};
 candidate.verification.evidenceHash=knowledgeEvidenceHash(candidate);const record=DistrictKnowledgeRecordSchema.parse(candidate),evidence={url,locator:'synthetic registry evidence',sha256:reference.sha256,retrievedAt:earlier};
 const registry={schemaVersion:'stadtstack-source-registry-v1',generatedAt:earlier,districts:[{id:'synthetic-district',name:'Synthetic district',ags:'12064',state:'Brandenburg',inventorySources:[evidence],inventoryAsOf:'2026-10-10',inventoryComplete:true}],municipalities:[{id:'beispielstadt',name:'Beispielstadt',ags:'12064001',districtId:'synthetic-district',districtAgs:'12064',amt:null,administrativeStatus:'amtsfrei',administrativeEvidence:[evidence],identitySources:[evidence],sources:['website','council','participation','gazette'].map(kind=>({id:kind,kind,url,vendor:'unknown',checkState:kind==='website'?'checked':'not_checked',checkedAt:kind==='website'?earlier:null,evidence:kind==='website'?[evidence]:[],reason:kind==='website'?'Synthetic website observation bound to the prepared fixture':'Synthetic source configuration; not checked'})),seedDocuments:[{url,sourceId:'website',title:'Wärmeplanung',documentDate:'2026-10-10',evidence:[evidence]}]}],inventory:[{ags:'12064001',name:'Beispielstadt',districtId:'synthetic-district',identitySourceUrl:url,pilot:true,sourceCheckState:'not_checked',reason:'Synthetic fixture'}],notes:['Synthetic registry only']};
 const registryPin=await sourcePin('input/registry.json',encoded(registry)),crawl=await sourcePin('input/crawl.json',encoded({schemaVersion:'stadtstack-crawl-index-v1',generatedAt:earlier,documents:[{id:'synthetic-document',municipalityId:'beispielstadt',sourceId:'website',sha256:reference.sha256,url,retrievedAt:earlier}],checks:[{municipalityId:'beispielstadt',sourceId:'website',checkState:'checked',checkedAt:earlier,documentCount:1,coverage:{state:'partial',sourceCoverage:'not_assessed',pendingCount:0,runnableCount:0,blockedCount:0,targetScope:{kind:'page_roots',urls:[url],state:'complete',pendingCount:0,runnableCount:0,blockedCount:0}}}]}));
 const pins={corpusSha256:crawl.sha256,registrySha256:registryPin.sha256,promptContractSha256:sha256('synthetic contract'),schemaSha256:sha256('synthetic schema')},run={schemaVersion:'stadtstack-extraction-run-v2',generatedAt:earlier,assignmentMode:'codex-only',...pins,scope:'all_fetched_documents',maxDocumentsPerMunicipality:null,availableDocumentGroups:1,attemptedDocumentGroups:1,pendingDocumentGroups:0,municipalities:[{id:'beispielstadt',selectedDocumentGroups:1,preparedDocumentGroups:1,attemptedDocumentGroups:1}]};
 const runPin=await auditPin('original-run.json',run),intake=prepareKnowledgeOptionsSchema.parse({schemaVersion:'stadtstack-managed-knowledge-intake-v1',policy:fixture.policy,registry:registryPin,runs:[{runId:runPin.sha256,pins,sourceArtifactKind:'native_extraction_output',artifacts:{extractionRun:runPin,records:await sourcePin('input/records.json',encoded({schemaVersion:KNOWLEDGE_SCHEMA_VERSION,generatedAt:earlier,records:[record]})),quarantine:await sourcePin('input/quarantine.json',encoded({schemaVersion:'stadtstack-quarantine-v1',generatedAt:earlier,cases:[]})),crawl,registry:registryPin},admissions:[{recordId:record.id,prepared:[preparedPin]}]}],approvedRunOrder:[runPin.sha256],generatedAt:at,minimumPerDistrict:1,output:{root:join(fixture.root,'composed'),stagingDir:join(fixture.root,'composed/knowledge'),auditDir:join(fixture.root,'composition-audit')}});
 const knowledge=await prepareKnowledge(intake),knowledgeRecords=JSON.parse((await readFile(knowledge.outputs.find(pin=>pin.path.endsWith('/records.json'))!.path)).toString('utf8'));
 // Frozen core is read, never changed or re-judged. All other fixture records are synthetic.
 const coreBytes=await readFile(join(outDir,'core/strausberg-facts.json')),core=coreBundleSchema.parse(JSON.parse(coreBytes.toString('utf8'))),collection={type:'FeatureCollection' as const,features:core.facts.map(coreSignal)};
 validateCore(core,collection);
 const signalsBytes=encoded(collection),coreManifest=JSON.parse(await readFile(join(outDir,'core/release-manifest.json'),'utf8'));
 coreManifest.corpus.fullSha256=sha256(signalsBytes);coreManifest.corpus.minSha256=sha256(Buffer.from(JSON.stringify(compactCollection(collection))+'\n'));
 const signalRecords=collection.features.map(signalChangeRecord),cityFeed=legacyChanges?{added:signalRecords.map(record=>record.id),changed:[],removed:[],generatedAt:earlier}:diff([],signalRecords,earlier,[],[{cityId:'strausberg',recordType:'signal'}]),cityChanges=Buffer.from(JSON.stringify(cityFeed,null,3)+'\n\n');
 const knowledgeChangesBytes=Buffer.from(JSON.stringify(knowledgeChanges([],knowledgeRecords.records,earlier,[{cityId:'beispielstadt',recordType:'knowledge'}]),null,3)+'\n\n');
 const priorBytes=new Map<string,Buffer>([['cities/strausberg/signals.geojson',signalsBytes],['cities/strausberg/changes.json',cityChanges],['knowledge/records.json',encoded({...knowledgeRecords,generatedAt:earlier})],['knowledge/changes.json',knowledgeChangesBytes],['core/strausberg-facts.json',coreBytes],['core/release-manifest.json',encoded(coreManifest)],['core/handover-draft.json',await readFile(join(outDir,'core/handover-draft.json'))]]);
 const publicationRoot=join(fixture.root,'prior-release'),files=[...priorBytes].map(([path,bytes])=>({path,sha256:sha256(bytes),bytes:bytes.length})).sort((a,b)=>a.path.localeCompare(b.path)),manifest:DataRelease={schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt:earlier,files,quality:{publishedRecords:4,quarantinedRecords:0,cities:1}};
 for(const [path,bytes] of priorBytes){await mkdir(dirname(join(publicationRoot,path)),{recursive:true,mode:0o700});await writeFile(join(publicationRoot,path),bytes,{mode:0o600});}
 const manifestBytes=encoded(manifest),manifestPath=join(publicationRoot,'release-manifest.json');await writeFile(manifestPath,manifestBytes,{mode:0o600});
 const predecessor:PublicationPlan['priorRelease']['members']=[];
 for(const [memberPath,bytes] of priorBytes){
  const declaredSources=retainedPublicationSources(JSON.parse(bytes.toString('utf8')));
  if(declaredSources.length){const imported=await importRetainedPublicationMember({publicationRoot,manifestSha256:sha256(manifestBytes),releaseId:manifest.id,memberPath,declaredSources,managedRoot:join(fixture.root,'prior-imports'),destinationPath:memberPath},fixture.policy);predecessor.push({memberPath,pin:knowledgeSourcePinSchema.parse({path:imported.path,sha256:imported.sha256,bytes:imported.bytes,bindings:imported.bindings})});}
  else{
   const handover=memberPath==='core/handover-draft.json',role=handover?'core_handover_draft':legacyChanges&&memberPath==='cities/strausberg/changes.json'?'legacy_city_changes':'changes_v2_metadata';
   predecessor.push({memberPath,pin:{path:join(fixture.root,'unavailable-metadata-locators',memberPath),sha256:sha256(bytes),bytes:bytes.length},metadata:{role,manifestSha256:sha256(manifestBytes),releaseId:manifest.id,encoding:{indent:handover?2:3,trailingNewlines:handover?1:2},value:JSON.parse(bytes.toString('utf8'))}});
  }
 }
 const retained=(path:string)=>{const pin=predecessor.find(member=>member.memberPath===path)!.pin;if(!('bindings' in pin))throw Error('Fixture requires a source-bound retained member');return pin;};
 const corePin=retained('core/strausberg-facts.json'),city=cities.find(city=>city.id==='strausberg')!;
 const catalogue={schemaVersion:'stadtstack-signals-v1',generatedAt:earlier,publisher:'Synthetic publication integration fixture',coreBundle:{path:'core/strausberg-facts.json',version:core.version,manifestPath:'core/release-manifest.json'},cities:[{id:city.id,name:city.name,state:city.state,center:city.center,bbox:city.bbox,sources:[...new Map(core.facts.map(fact=>[fact.source.url,{id:fact.id,kind:'core',publisher:fact.source.publisher,url:fact.source.url,licence:'unknown',reuse:'facts_with_attribution',retrievedAt:fact.source.retrievedAt,status:'ok'}])).values()],feedUrl:'cities/strausberg/feed.json'}]};
 const staging:PublicationPlan['staging']=[
  {...await sourcePin('staging/catalogue.json',encoded(catalogue),corePin.bindings),memberPath:'catalogue.json'},
  {...retained('cities/strausberg/signals.geojson'),memberPath:'cities/strausberg/signals.geojson'},
  {...await sourcePin('staging/feed.json',encoded({schemaVersion:'stadtstack-feed-v1',cityId:'strausberg',generatedAt:earlier,sources:[],items:[]}),corePin.bindings),memberPath:'cities/strausberg/feed.json'},
  {...await sourcePin('staging/regional.json',encoded({schemaVersion:'stadtstack-regional-topics-v1',generatedAt:earlier,asOf:'2026-10-10',coverage:{},topics:[]})),memberPath:'regions/brandenburg-mol/topics.json'},
  {...corePin,memberPath:'core/strausberg-facts.json'},
  ...knowledge.outputs.map((pin,index)=>({...pin,memberPath:(['knowledge/registry.json','knowledge/records.json','knowledge/coverage.json'] as const)[index]})),
 ];
 const plan=PublicationPlanSchema.parse({schemaVersion:'stadtstack-managed-publication-plan-v1',asOf:'2026-10-11',clocks:{qualityGeneratedAt:at,manifestGeneratedAt:manifestAt},output:{managedRoot:join(fixture.root,'publication'),releaseDir:join(fixture.root,'publication/release'),auditDir:join(fixture.root,'publication-audit')},staging,knowledgePreparation:knowledge.preparationReceipt,admissions:[{recordId:record.id,prepared:[preparedPin]}],priorRelease:{gitCommit:'a'.repeat(40),manifest:{path:manifestPath,sha256:sha256(manifestBytes),bytes:manifestBytes.length},releaseId:manifest.id,members:predecessor}});
 return {...fixture,plan,intake,record,sourcePin,auditPin,coreBytes,priorBytes,cityChanges,knowledgeChangesBytes,manifest};
}

test('strict publication requires explicit pinned plans and refuses legacy out or implicit fallback fields',async t=>{
 const f=await publicationFixture(t);
 assert.deepEqual(PublicationPlanSchema.parse(f.plan),f.plan);
 for(const key of ['staging','knowledgePreparation','priorRelease','clocks','output'])assert.equal(PublicationPlanSchema.safeParse({...f.plan,[key]:undefined}).success,false);
 for(const extra of [{fallback:true},{stagingDir:'legacy-cache'},{priorCityRoot:outDir},{allowLiveModel:true}])assert.equal(PublicationPlanSchema.safeParse({...f.plan,...extra}).success,false);
 await assert.rejects(publish({plan:{...f.plan,output:{...f.plan.output,managedRoot:outDir,releaseDir:join(outDir,'forbidden')}},policy:f.policy}),/legacy out is read-only/);
 for(const missing of ['regions/brandenburg-mol/topics.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json'])await assert.rejects(publish({plan:{...f.plan,staging:f.plan.staging.filter(pin=>pin.memberPath!==missing)},policy:f.policy}),/Missing explicit publication staging member/);
 await assert.rejects(lstat(f.plan.output.releaseDir),{code:'ENOENT'});
});

test('publisher authenticates predecessor identity every member pin and original retained-publication binding',async t=>{
 const f=await publicationFixture(t);
 await assert.rejects(publish({plan:{...f.plan,priorRelease:{...f.plan.priorRelease,releaseId:sha256('foreign release')}},policy:f.policy}),/predecessor manifest identity/);
 const wrongPin=structuredClone(f.plan);wrongPin.priorRelease.members[0].pin.sha256=sha256('wrong member');
 await assert.rejects(publish({plan:wrongPin,policy:f.policy}),/not bound to the authentic manifest/);
 const wrongProvenance=structuredClone(f.plan),member=wrongProvenance.priorRelease.members.find(member=>'bindings' in member.pin)!;
 if(!('bindings' in member.pin)||member.pin.bindings[0].kind!=='retained_publication')throw Error('Expected retained fixture');
 member.pin.bindings[0].publication.manifestSha256=sha256('foreign manifest');
 await assert.rejects(publish({plan:wrongProvenance,policy:f.policy}),/not the original sealed member/);
 const wrongStage=structuredClone(f.plan);wrongStage.staging[0].sha256=sha256('different stage');
 await assert.rejects(publish({plan:wrongStage,policy:f.policy}),/bytes differ from their pin/);
 await assert.rejects(lstat(f.plan.output.releaseDir),{code:'ENOENT'});
});

test('omitted predecessor bindings reject before reading a source host objected only in the historical member',async t=>{
 const f=await publicationFixture(t),untrusted=JSON.parse(JSON.stringify(f.plan)),memberPath='knowledge/records.json';
 const historical=JSON.parse(f.priorBytes.get(memberPath)!.toString('utf8'));
 historical.records[0].sources[0].url='https://previous-only.example.org/source';
 historical.records[0].sources[0].policy.robots.url='https://previous-only.example.org/robots.txt';
 historical.records[0].verification.evidenceHash=knowledgeEvidenceHash(historical.records[0]);
 const poisonedPath=join(f.root,'objected-predecessor.json'),bytes=encoded(historical);
 await writeFile(poisonedPath,bytes,{mode:0o600});
 const manifest=structuredClone(f.manifest),entry=manifest.files.find(file=>file.path===memberPath)!;
 entry.sha256=sha256(bytes);entry.bytes=bytes.length;manifest.id=dataReleaseId(manifest.files);
 untrusted.priorRelease.manifest=await f.auditPin('objected-predecessor-manifest.json',manifest);
 untrusted.priorRelease.releaseId=manifest.id;
 // This authentic target is first: current staging stays allowed, and no later
 // predecessor validation can mask a forbidden read through the old audit branch.
 untrusted.priorRelease.members=[{memberPath,pin:{path:poisonedPath,sha256:sha256(bytes),bytes:bytes.length}},...untrusted.priorRelease.members.filter((member:{memberPath:string})=>member.memberPath!==memberPath)];
 await recordHostOptOut({host:'previous-only.example.org',reason:'municipality_objection'},f.policy);
 const originalRead=fsPromises.readFile;let forbiddenReads=0;
 const spy=t.mock.method(fsPromises,'readFile',(...args:Parameters<typeof fsPromises.readFile>)=>{
  if(String(args[0])===poisonedPath){forbiddenReads++;throw Error('Forbidden predecessor source read');}
  return originalRead(...args);
 });
 syncBuiltinESMExports();t.after(()=>{spy.mock.restore();syncBuiltinESMExports();});
 await assert.rejects(publish({plan:untrusted,policy:f.policy}),ZodError);
 assert.equal(forbiddenReads,0);await assert.rejects(lstat(f.plan.output.releaseDir),{code:'ENOENT'});
});

test('predecessor metadata roles bind path exact bytes and authentic release before any member read',async t=>{
 const f=await publicationFixture(t),metadataMembers=f.plan.priorRelease.members.filter(member=>'metadata' in member);
 assert.equal(metadataMembers.length,3);
 for(const member of metadataMembers){
  if(!('metadata' in member))throw Error('Expected explicit metadata role');
  await assert.rejects(lstat(member.pin.path),{code:'ENOENT'});
  const bytes=encodePredecessorMetadata(member.metadata);
  assert.deepEqual(bytes,f.priorBytes.get(member.memberPath));assert.equal(sha256(bytes),member.pin.sha256);
  for(const memberPath of ['knowledge/records.json','cities/strausberg/signals.geojson'])assert.equal(publicationPredecessorMemberSchema.safeParse({...member,memberPath}).success,false);
  assert.equal(publicationPredecessorMemberSchema.safeParse({...member,pin:{...member.pin,sha256:sha256('foreign bytes')}}).success,false);
 }
 const forged=structuredClone(f.plan),member=forged.priorRelease.members.find(member=>'metadata' in member)!;
 if(!('metadata' in member))throw Error('Expected explicit metadata role');
 member.metadata.manifestSha256=sha256('foreign metadata authorization');
 await assert.rejects(publish({plan:forged,policy:f.policy}),/metadata authorization differs from the original sealed member/);
 await assert.rejects(lstat(f.plan.output.releaseDir),{code:'ENOENT'});
});

test('metadata roles cannot classify arbitrary source payloads or empty source envelopes as audit data',()=>{
 const value={added:['source:one'],changed:[],removed:[],generatedAt:earlier},metadata={role:'legacy_city_changes' as const,manifestSha256:sha256('manifest'),releaseId:sha256('release'),encoding:{indent:2,trailingNewlines:1},value},bytes=encodePredecessorMetadata(metadata);
 const member={memberPath:'cities/strausberg/changes.json',pin:{path:'/unavailable/legacy.json',sha256:sha256(bytes),bytes:bytes.length},metadata};
 assert.equal(publicationPredecessorMemberSchema.safeParse(member).success,true);
 for(const changed of [
  {...metadata,value:{...value,sourceText:'Private source body'}},
  {...metadata,value:{...value,added:['council:'+encodeURIComponent('https://objected.example.org/paper/1')]}},
  {...metadata,role:'core_handover_draft' as const},
 ])assert.throws(()=>encodePredecessorMetadata(changed));
 for(const [memberPath,empty] of [['knowledge/records.json',{schemaVersion:KNOWLEDGE_SCHEMA_VERSION,records:[]}],['cities/strausberg/signals.geojson',{type:'FeatureCollection',features:[]}] ] as const){
  const bytes=encoded(empty);
  assert.equal(publicationPredecessorMemberSchema.safeParse({memberPath,pin:{path:'/unavailable/source.json',sha256:sha256(bytes),bytes:bytes.length}}).success,false);
  assert.equal(publicationPredecessorMemberSchema.safeParse({...member,memberPath,metadata:{...metadata,value:empty}}).success,false);
 }
 const records=historicalSignalChangeRecords({type:'FeatureCollection',features:[{properties:{id:'source:one',cityId:'strausberg',version:sha256('version'),sources:[{sha256:sha256('source')}]}}]},'strausberg');
 const feed=diff([],records,earlier),sourceBearing=structuredClone(feed);sourceBearing.events[0].reason='Private quotation disguised as a change reason';
 assert.throws(()=>encodePredecessorMetadata({...metadata,role:'changes_v2_metadata',value:sourceBearing}),/Source-bearing change history/);
});

test('staging source bindings and active objections are mandatory before the first public output',async t=>{
 const f=await publicationFixture(t),forged=structuredClone(f.plan),binding=forged.staging[0].bindings[0];
 if(binding.kind!=='retained_publication')throw Error('Expected retained core staging provenance');
 binding.sourceSha256=sha256('unrelated source');
 await assert.rejects(publish({plan:forged,policy:f.policy}));await assert.rejects(lstat(f.plan.output.releaseDir),{code:'ENOENT'});
 await recordHostOptOut({host:'example.org',reason:'municipality_objection'},f.policy);
 await assert.rejects(publish({plan:f.plan,policy:f.policy}),HostOptedOutError);await assert.rejects(lstat(f.plan.output.releaseDir),{code:'ENOENT'});
});

test('new core bytes cannot replace the exact authenticated prior core even when JSON claims are unchanged',async t=>{
 const f=await publicationFixture(t),original=f.plan.staging.find(pin=>pin.memberPath==='core/strausberg-facts.json')!;
 const changed=await f.sourcePin('staging/changed-core.json',Buffer.concat([f.coreBytes,Buffer.from(' ')]),original.bindings);
 const plan={...f.plan,staging:f.plan.staging.map(pin=>pin.memberPath==='core/strausberg-facts.json'?{...changed,memberPath:pin.memberPath}:pin)};
 await assert.rejects(publish({plan,policy:f.policy}),/only the authenticated retained core is supported/);
 await assert.rejects(lstat(f.plan.output.releaseDir),{code:'ENOENT'});
});

test('managed full publication retains unchanged v2 feed bytes and strict replay reproduces its exact manifest',async t=>{
 const f=await publicationFixture(t),network=t.mock.method(globalThis,'fetch',async()=>{throw Error('Publication and replay must remain offline');});
 const result=await publish({plan:f.plan,policy:f.policy});assert.equal(result.release.generatedAt,manifestAt);
 assert.deepEqual(await readFile(join(f.plan.output.releaseDir,'cities/strausberg/changes.json')),f.cityChanges);
 assert.deepEqual(await readFile(join(f.plan.output.releaseDir,'knowledge/changes.json')),f.knowledgeChangesBytes);
 assert.deepEqual(await readFile(join(f.plan.output.releaseDir,'core/strausberg-facts.json')),f.coreBytes);
 assert.deepEqual(await verifyDataRelease(f.plan.output.releaseDir),result.release);
 for(const file of result.release.files)await assertManagedSourceReadable(join(f.plan.output.releaseDir,file.path),f.policy);
 const expectedPath=join(f.plan.output.releaseDir,'release-manifest.json'),expectedBytes=await readFile(expectedPath),intakePin=await f.auditPin('replay-intake.json',f.intake);
 const replayPlan={...f.plan,policyReceipts:result.policyReceipts,output:{managedRoot:join(f.root,'replayed-publication'),releaseDir:join(f.root,'replayed-publication/release'),auditDir:join(f.root,'replayed-audit')}},planPin=await f.auditPin('replay-plan.json',replayPlan);
 const receipt:ReplayReceipt={schemaVersion:'stadtstack-pipeline-replay-v2',knowledgeIntake:{path:intakePin.path,sha256:intakePin.sha256},publicationPlan:{path:planPin.path,sha256:planPin.sha256},expectedManifest:{path:expectedPath,sha256:sha256(expectedBytes)},clocks:{recordsGeneratedAt:at,quarantineGeneratedAt:at,coverageGeneratedAt:at,qualityGeneratedAt:at,manifestGeneratedAt:manifestAt}};
 const receiptPin=await f.auditPin('replay-receipt.json',receipt),proof=await replayPipeline(receiptPin.path,receiptPin.sha256,f.policy);
 assert.equal(proof.comparison.releaseId,result.release.id);assert.equal(proof.comparison.manifestSha256,sha256(expectedBytes));
 assert.deepEqual(await readFile(join(replayPlan.output.releaseDir,'release-manifest.json')),expectedBytes);
 assert.deepEqual(proof.policyReceipts,result.policyReceipts);assert.equal(network.mock.callCount(),0);
});

test('unchanged legacy city feeds require the authentic private baseline rather than fabricated previous revisions',async t=>{
 const f=await publicationFixture(t,true);
 await assert.rejects(publish({plan:f.plan,policy:f.policy}),/authentic private Git snapshot/);
 await assert.rejects(lstat(f.plan.output.releaseDir),{code:'ENOENT'});
});

test('historical Git baseline projection emits only identities versions and original source hashes',()=>{
 const version=sha256('old version'),sourceHash=sha256('original source'),privateText='PRIVATE HISTORICAL CONTENT MUST NOT LEAVE THE BASELINE';
 const raw={type:'FeatureCollection',features:[{geometry:{type:'Point',coordinates:[13,52]},properties:{id:'source:one',cityId:'strausberg',version,title:privateText,statement:privateText,summary:privateText,sources:[{url:'https://example.org/private-baseline',sha256:sourceHash},{url:'https://example.org/unfetched',sha256:null},{sha256:sourceHash}],unrelated:{body:privateText}}}]};
 const records=historicalSignalChangeRecords(raw,'strausberg');
 assert.deepEqual(records,[{id:'source:one',cityId:'strausberg',recordType:'signal',revision:{version,evidenceHash:null,sourceHashes:[sourceHash],metricClaims:[]},sources:[],semanticEvidence:[]}]);
 const serialized=JSON.stringify(records);for(const forbidden of [privateText,'https://','title','summary','statement','geometry','unrelated'])assert.equal(serialized.includes(forbidden),false);
 assert.throws(()=>historicalSignalChangeRecords(raw,'other-city'));
 const current=structuredClone(records);current[0].revision.version=sha256('current version');
 const legacy={added:[],changed:['source:one'],removed:[],generatedAt:earlier},scope=[{cityId:'strausberg',recordType:'signal' as const}];
 assert.throws(()=>retainChanges(legacy,current,undefined,scope),/authenticated earlier signal snapshot/);
 const feed=retainChanges(legacy,current,records,scope);assert.equal(feed.events[0].previous?.version,version);assert.equal(feed.events[0].current?.version,current[0].revision.version);
 assert.equal(JSON.stringify(feed).includes(privateText),false);assert.equal(JSON.stringify(feed).includes('https://'),false);
 assert.throws(()=>retainChanges({...legacy,changed:[]},current,records,scope),/do not match/);
});

test('retained-only knowledge publication and replay use the public cohort without old private producer inputs',async t=>{
 // Create the historical public fixture once; every operation after the read
 // barrier below must use its sealed public members, not this producer's files.
 const f=await publicationFixture(t),originalRelease=await publish({plan:f.plan,policy:f.policy});
 const publicationRoot=f.plan.output.releaseDir,manifestPath=join(publicationRoot,'release-manifest.json'),manifestBytes=await readFile(manifestPath),pins:Record<string,unknown>={};
 for(const kind of ['records','coverage','registry'] as const){
  const memberPath=`knowledge/${kind}.json`,bytes=await readFile(join(publicationRoot,memberPath)),declaredSources=retainedPublicationSources(JSON.parse(bytes.toString('utf8')));
  assert.ok(declaredSources.length,'Retained member needs its real published URL provenance');
  const imported=await importRetainedPublicationMember({publicationRoot,manifestSha256:sha256(manifestBytes),releaseId:originalRelease.release.id,memberPath,declaredSources,managedRoot:join(f.root,'retained-public-inputs'),destinationPath:memberPath},f.policy);
  pins[kind]=knowledgeRetainedPublicationSourcePinSchema.parse({path:imported.path,sha256:imported.sha256,bytes:imported.bytes,bindings:imported.bindings});
 }
 const baseline=publicationRetainedBaselineSchema.parse({manifest:{path:manifestPath,sha256:sha256(manifestBytes),bytes:manifestBytes.length},...pins});
 const original=DistrictKnowledgeRecordSchema.parse(JSON.parse((await readFile(baseline.records.path)).toString('utf8')).records[0]),retainedAt='2026-10-12T09:00:00.000Z',retainedManifestAt='2026-10-12T09:00:00.460Z';
 const intake=prepareKnowledgeOptionsSchema.parse({schemaVersion:'stadtstack-managed-knowledge-intake-v1',policy:f.policy,registry:baseline.registry,runs:[],approvedRunOrder:[],retainedPublication:{artifacts:baseline,admissions:[{recordId:original.id,originalEvidenceHash:original.verification.evidenceHash}]},generatedAt:retainedAt,minimumPerDistrict:1,output:{root:join(f.root,'retained-composition'),stagingDir:join(f.root,'retained-composition/knowledge'),auditDir:join(f.root,'retained-composition-audit')}});
 const privatePaths=new Set(f.intake.runs.flatMap(run=>[...Object.values(run.artifacts).flatMap(pin=>pin?[pin.path]:[]),...run.admissions.flatMap(admission=>admission.prepared.map(pin=>pin.path))])),originalRead=fsPromises.readFile;let privateReads=0;
 const spy=t.mock.method(fsPromises,'readFile',(...args:Parameters<typeof fsPromises.readFile>)=>{
  if(privatePaths.has(String(args[0]))){privateReads++;throw Error('Retained-only publication cannot reopen old private producer inputs');}
  return originalRead(...args);
 });
 let nativeCalls=0;
 const nativeSpies=(['spawn','spawnSync','execFile','execFileSync'] as const).map(method=>t.mock.method(childProcess,method,()=>{nativeCalls++;throw Error('Retained-only publication must not run model, readiness, Git or parser commands');}));
 syncBuiltinESMExports();t.after(()=>{spy.mock.restore();for(const native of nativeSpies)native.mock.restore();syncBuiltinESMExports();});
 const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('Retained-only publication must remain offline');});
 const knowledge=await prepareKnowledge(intake),memberPaths=['knowledge/registry.json','knowledge/records.json','knowledge/coverage.json'] as const;
 const current=DistrictKnowledgeRecordSchema.parse(JSON.parse((await readFile(knowledge.outputs[1].path)).toString('utf8')).records[0]),coverage=JSON.parse((await readFile(knowledge.outputs[2].path)).toString('utf8'));
 assert.deepEqual(current.extraction,original.extraction);assert.deepEqual(current.verification.faithfulness,original.verification.faithfulness);
 assert.equal(coverage.textLineage?.runs.length??0,0);assert.equal(coverage.retainedPublication.selectedRecordOrigins.length,1);
 assert.equal(coverage.retainedPublication.selectedRecordOrigins[0].originalEvidenceHash,original.verification.evidenceHash);
 const plan=PublicationPlanSchema.parse({...f.plan,asOf:'2026-10-12',clocks:{qualityGeneratedAt:retainedAt,manifestGeneratedAt:retainedManifestAt},output:{managedRoot:join(f.root,'retained-output'),releaseDir:join(f.root,'retained-output/release'),auditDir:join(f.root,'retained-policy-audit')},staging:f.plan.staging.map(pin=>{const index=memberPaths.findIndex(member=>member===pin.memberPath);return index<0?pin:{...knowledge.outputs[index],memberPath:pin.memberPath};}),knowledgePreparation:knowledge.preparationReceipt,admissions:[{recordId:original.id,retainedPublication:{originalEvidenceHash:original.verification.evidenceHash}}],retainedPublication:baseline});
 const result=await publish({plan,policy:f.policy}),policyReceipts=publicationPolicyReceiptsSchema.parse(JSON.parse((await readFile(result.policyReceipts.path)).toString('utf8')));
 assert.ok(policyReceipts.records.every(record=>record.basis==='retained_publication'));
 assert.equal(result.release.generatedAt,retainedManifestAt);
 const expectedPath=join(plan.output.releaseDir,'release-manifest.json'),expectedBytes=await readFile(expectedPath),intakePin=await f.auditPin('retained-replay-intake.json',intake);
 const replayPlan={...plan,policyReceipts:result.policyReceipts,output:{managedRoot:join(f.root,'retained-replay'),releaseDir:join(f.root,'retained-replay/release'),auditDir:join(f.root,'retained-replay-audit')}},planPin=await f.auditPin('retained-replay-plan.json',replayPlan);
 const receipt:ReplayReceipt={schemaVersion:'stadtstack-pipeline-replay-v2',knowledgeIntake:{path:intakePin.path,sha256:intakePin.sha256},publicationPlan:{path:planPin.path,sha256:planPin.sha256},expectedManifest:{path:expectedPath,sha256:sha256(expectedBytes)},clocks:{recordsGeneratedAt:retainedAt,quarantineGeneratedAt:retainedAt,coverageGeneratedAt:retainedAt,qualityGeneratedAt:retainedAt,manifestGeneratedAt:retainedManifestAt}};
 const receiptPin=await f.auditPin('retained-replay-receipt.json',receipt),proof=await replayPipeline(receiptPin.path,receiptPin.sha256,f.policy);
 assert.equal(proof.comparison.releaseId,result.release.id);assert.deepEqual(await readFile(join(replayPlan.output.releaseDir,'release-manifest.json')),expectedBytes);
 assert.deepEqual(proof.policyReceipts,result.policyReceipts);assert.equal(privateReads,0);assert.equal(network.mock.callCount(),0);assert.equal(nativeCalls,0);
 assert.equal(proof.execution.modelCalls,0);assert.equal(proof.execution.readinessCalls,0);assert.equal(proof.execution.archiveExecutions,0);
});
