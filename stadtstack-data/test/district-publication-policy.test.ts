import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {dirname,join} from 'node:path';
import {admitPublicationKnowledge,publicationAdmissionSchema,publicationPolicyReceiptsSchema,publicationRetainedBaselineSchema,readPublicationSourcePin,readPublicationAuditPin} from '../src/district-publication-policy.ts';
import type {PublicationAdmission,PublicationAuditPin,PublicationPolicyReceipts} from '../src/district-publication-policy.ts';
import {DistrictExtractionClaimsSchema,DistrictKnowledgeRecordSchema,knowledgeEvidenceHash,sha256} from '../src/district-schema.ts';
import {deterministicChecks} from '../src/district-claims.ts';
import {normalizeGraphClaims} from '../src/district-graph-claims.ts';
import {PROVIDER_CONFIGS} from '../src/district-model-contract.ts';
import {prepareDocument,cachePreparedDocument,preparedSourceBindings} from '../src/district-prepared-document.ts';
import type {PreparedSourceReference} from '../src/district-prepared-document.ts';
import {knowledgeSourcePinSchema,knowledgePreparedSourcePinSchema,knowledgeRetainedPublicationSourcePinSchema} from '../src/prepare-knowledge.ts';
import {recordHostOptOut,HostOptedOutError} from '../src/civic-opt-out.ts';
import {writePrivateJson} from '../src/district-private-io.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {dataReleaseId,type DataRelease} from '../src/data-release.ts';
import {importRetainedPublicationMember,retainedPublicationSources} from '../src/district-retained-import.ts';
import {projectKnowledgeRecordIdentity} from '../src/retained-knowledge-lineage.ts';

const at='2026-10-11T12:00:00.000Z';
// Synthetic source and model evidence only; real preparation, policy, authority and ledger gates run.
async function fixture(t:TestContext){
 const authority=await createCivicPolicyTestContext(t),text='Stadt Beispielstadt\nWärmeplanung\nDer Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.\nStand: 10.10.2026';
 const sourceSha256=sha256(text),reference:PreparedSourceReference={id:'synthetic-source',url:'https://example.org/publication-source',sha256:sourceSha256,retrievedAt:at,locator:'complete synthetic document',mimeType:'text/plain',sourceType:'website',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt',checkedAt:at},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}};
 const prepare=async(ref:PreparedSourceReference)=>{
  const root=join(authority.root,'prepared'),prepared=await prepareDocument({bytes:Buffer.from(text),municipalityId:'beispielstadt',references:[ref],mimeType:'text/plain',extractorSha256:sha256('synthetic preparation'),toolVersions:{node:'synthetic-fixture'},managedRoot:root,policy:authority.policy});
  const path=await cachePreparedDocument(root,prepared,{...authority.policy,decisionId:authority.decisionId}),bytes=await readFile(path);
  return {prepared,pin:knowledgePreparedSourcePinSchema.parse({path,sha256:sha256(bytes),bytes:bytes.length,bindings:preparedSourceBindings(prepared.references,prepared.receiptSha256)})};
 };
 const {prepared,pin}=await prepare(reference),config=PROVIDER_CONFIGS['openai-subscription'],modelIdentitySha256=sha256('synthetic model identity');
 const claims=DistrictExtractionClaimsSchema.parse({title:'Wärmeplanung',titleQuote:'Wärmeplanung',summary:'Der Entwurf der Wärmeplanung wurde veröffentlicht.',summaryQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',municipalityQuote:'Stadt Beispielstadt',caseKey:null,caseKeyType:'source_document',caseQuote:null,caseType:'planning',documentDate:'2026-10-10',documentDateQuote:'Stand: 10.10.2026',documentDateReason:null,topics:[],stage:'draft',stageDate:'2026-10-09',stageDateQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stageDateReason:null,originalStatus:'Entwurf',stageQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stages:[],entities:[],relations:[],locations:[]});
 const deterministic=deterministicChecks(claims,text,'Beispielstadt');assert.equal(deterministic.passed,true);
 const candidate={...claims,...normalizeGraphClaims(claims,{municipalityId:'beispielstadt',ags:'12064001',sourceSha256}),id:'knowledge:publication-policy-fixture',municipalityId:'beispielstadt',ags:'12064001',districtId:'synthetic-district',caseKey:'source_document:'+sourceSha256,sources:[reference],
  extraction:{extractorVersion:'synthetic-policy-fixture',extractorSha256:sha256('synthetic extractor'),model:config.model,provider:'openai-subscription',tool:config.tool,toolVersion:'synthetic',modelIdentitySha256,modelIdentityBasis:config.modelIdentityBasis,returnedModel:null,promptVersion:'synthetic-prompt',promptSha256:sha256('synthetic prompt'),judgePromptVersion:'synthetic-judge',judgePromptSha256:sha256('synthetic judge'),inputSha256:sourceSha256,textSha256:prepared.textSha256,responseSha256:sha256('synthetic response'),ocrUsed:false,textMethod:'text',cacheKey:sha256('synthetic cache'),extractedAt:at,chunk:{index:0,count:1,start:0,end:prepared.textLength}},
  verification:{status:'auto-verified',deterministic,faithfulness:{score:0.9,threshold:0.8,model:config.model,provider:'openai-subscription',tool:config.tool,toolVersion:'synthetic',modelIdentitySha256,returnedModel:null,reason:'Synthetic fixture, not an actual model judgment',evaluatedAt:at,responseSha256:sha256('synthetic judge response'),sameModel:true,limitation:'Same-model judgment is not independent verification.'},evidenceHash:''}};
 candidate.verification.evidenceHash=knowledgeEvidenceHash(candidate);const record=DistrictKnowledgeRecordSchema.parse(candidate);
 const admissions=[{recordId:record.id,prepared:[pin]}] satisfies PublicationAdmission[],auditDir=join(authority.root,'audit');
 return {...authority,text,reference,record,admissions,auditDir,prepare};
}

function preparedDecision(receipts:PublicationPolicyReceipts){
 const decision=receipts.records[0];
 assert.equal(decision.basis,'prepared_source');
 if(decision.basis!=='prepared_source')throw Error('Expected native prepared-source decision');
 return decision;
}

/** Synthetic original public cohort. Prepared files belong only to its old producer;
 * retained admission below receives four sealed public artifacts, not those files. */
async function retainedFixture(t:TestContext){
 const f=await fixture(t),original=structuredClone(f.record),evidence={url:f.reference.url,locator:'Synthetic published registry evidence',sha256:f.reference.sha256,retrievedAt:at};
 const registered=['website','council','participation','gazette'].map(kind=>({id:kind==='website'?f.reference.id:kind,kind,url:f.reference.url,vendor:'unknown',checkState:kind==='website'?'checked':'not_checked',checkedAt:kind==='website'?at:null,evidence:kind==='website'?[evidence]:[],reason:'Synthetic historical public inventory'}));
 const registry={schemaVersion:'stadtstack-source-registry-v1',generatedAt:at,districts:[{id:'synthetic-district',name:'Synthetic district',ags:'12064',state:'Brandenburg',inventorySources:[evidence],inventoryAsOf:'2026-10-11',inventoryComplete:true}],municipalities:[{id:'beispielstadt',name:'Beispielstadt',ags:'12064001',districtId:'synthetic-district',districtAgs:'12064',amt:null,administrativeStatus:'amtsfrei',administrativeEvidence:[evidence],identitySources:[evidence],sources:registered,seedDocuments:[{url:f.reference.url,sourceId:f.reference.id,title:original.title,documentDate:original.documentDate,evidence:[evidence]}]}],inventory:[{ags:'12064001',name:'Beispielstadt',districtId:'synthetic-district',identitySourceUrl:f.reference.url,pilot:true,sourceCheckState:'checked',reason:'Synthetic retained inventory'}],notes:['Synthetic public baseline; not live municipality evidence']};
 const emptyHistogram={categories:[],failedDeterministicChecks:[]},extraction={fetchedDocumentGroups:1,runSelectedDocumentGroups:1,preparedDocumentGroups:1,attemptedDocumentGroups:1,pendingDocumentGroups:0,unavailableAttemptedDocumentGroups:0};
 const sources=registered.map(source=>({sourceId:source.id,kind:source.kind,registryState:source.checkState,crawlState:source.checkState,checkedAt:source.checkedAt,documentCount:source.kind==='website'?1:0,publishedRecords:source.kind==='website'?1:0,quarantinedRecords:0,quarantineReasons:emptyHistogram,coverage:source.kind==='website'?{state:'partial',pendingCount:0,runnableCount:0,blockedCount:0,sourceCoverage:'not_assessed',targetScope:{kind:'page_roots',urls:[f.reference.url],state:'complete',pendingCount:0,runnableCount:0,blockedCount:0}}:{state:'not_checked',pendingCount:0,runnableCount:0,blockedCount:0},failedLinkCount:0}));
 const model=original.extraction;
 const coverage={schemaVersion:'stadtstack-district-coverage-v3',generatedAt:at,accounting:{registryMunicipalities:1,configuredMunicipalities:1,checkedMunicipalities:1,runSelectedMunicipalities:1,preparedMunicipalities:1,attemptedMunicipalities:1,publishedMunicipalities:1,checkedWithoutPublishedMunicipalities:0,unvisitedMunicipalities:0},districts:[{id:'synthetic-district',ags:'12064',municipalitiesRegistered:1,municipalitiesConfigured:1,municipalitiesChecked:1,municipalitiesAttempted:1,municipalitiesWithRecords:1,municipalitiesWithDatedStages:1,documents:1,publishedRecords:1,quarantinedRecords:0}],municipalities:[{id:'beispielstadt',ags:'12064001',districtId:'synthetic-district',checked:true,status:'gated_records',documents:1,publishedRecords:1,datedStagedRecords:1,quarantinedRecords:0,quarantineReasons:emptyHistogram,extraction,sources}],models:[{provider:model.provider,model:model.model,tool:model.tool,toolVersion:model.toolVersion,modelIdentitySha256:model.modelIdentitySha256,modelIdentityBasis:model.modelIdentityBasis,faithfulnessThreshold:0.8,publishedRecords:1}],extractionRun:{generatedAt:at,assignmentMode:'codex-only',corpusSha256:sha256('synthetic original corpus'),registrySha256:sha256(JSON.stringify(registry)),promptContractSha256:sha256('synthetic original contract'),schemaSha256:sha256('synthetic original schema'),selection:'all_at_run_start',maxDocumentsPerMunicipality:null,availableDocumentGroupsAtRunStart:1,attemptedDocumentGroups:1,pendingDocumentGroupsAtRunStart:0}};
 const seal=async(label:string,manifestClock=at,record=original)=>{
  const bodies={records:Buffer.from(JSON.stringify({schemaVersion:'stadtstack-knowledge-v2',generatedAt:at,records:[record]},null,2)+'\n'),coverage:Buffer.from(JSON.stringify(coverage,null,2)+'\n'),registry:Buffer.from(JSON.stringify(registry,null,2)+'\n')};
  const files=(['records','coverage','registry'] as const).map(kind=>({path:`knowledge/${kind}.json`,sha256:sha256(bodies[kind]),bytes:bodies[kind].length})),manifest:DataRelease={schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(files),generatedAt:manifestClock,files,quality:{publishedRecords:1,quarantinedRecords:0,cities:1}};
  const publicationRoot=join(f.root,label+'-publication'),manifestPath=join(publicationRoot,'release-manifest.json');await mkdir(publicationRoot,{mode:0o700});
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(manifestPath,manifestBytes,{mode:0o600});
  const pins:Record<string,unknown>={};
  for(const kind of ['records','coverage','registry'] as const){
   const memberPath=`knowledge/${kind}.json`,path=join(publicationRoot,memberPath);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bodies[kind],{mode:0o600});
   const imported=await importRetainedPublicationMember({publicationRoot,manifestSha256:sha256(manifestBytes),releaseId:manifest.id,memberPath,declaredSources:retainedPublicationSources(JSON.parse(bodies[kind].toString('utf8'))),managedRoot:join(f.root,label+'-imports'),destinationPath:memberPath},f.policy);
   pins[kind]=knowledgeRetainedPublicationSourcePinSchema.parse({path:imported.path,sha256:imported.sha256,bytes:imported.bytes,bindings:imported.bindings});
  }
  return publicationRetainedBaselineSchema.parse({manifest:{path:manifestPath,sha256:sha256(manifestBytes),bytes:manifestBytes.length},...pins});
 };
 const retainedPublication=await seal('original'),projected=projectKnowledgeRecordIdentity(original);
 const admissions=[{recordId:original.id,retainedPublication:{originalEvidenceHash:original.verification.evidenceHash}}] satisfies PublicationAdmission[];
 return {...f,original,projected,retainedPublication,retainedAdmissions:admissions,seal};
}

test('first publication admission records an exercised current check and only hash-bound source decisions',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(at)});
 const result=await admitPublicationKnowledge({records:[f.record],admissions:f.admissions,auditDir:f.auditDir},f.policy);
 assert.equal(result.receipts.records[0].checkedAt,at);assert.equal(result.receipts.records[0].evidenceHash,f.record.verification.evidenceHash);
 assert.equal(result.receipts.authorityId,f.policy.authorityId);assert.equal(result.receipts.authoritySha256,f.policy.authoritySha256);
 const bytes=await readPublicationAuditPin(result.pin,f.policy);assert.equal(sha256(bytes),result.pin.sha256);assert.equal(bytes.length,result.pin.bytes);
 assert.deepEqual(publicationPolicyReceiptsSchema.parse(JSON.parse(bytes.toString('utf8'))),result.receipts);
 const source=preparedDecision(result.receipts).sources[0];assert.equal(source.sourceSha256,f.reference.sha256);assert.equal(source.urlSha256,sha256(f.reference.url));assert.equal(source.preparedReceiptSha256,f.admissions[0].prepared[0].bindings[0].receiptSha256);
 assert.ok(result.bindings.every(binding=>binding.kind==='prepared_source'));
 assert.equal(result.retainedPublication,null);assert.equal(result.receipts.schemaVersion,'stadtstack-publication-policy-receipts-v2');
 assert.equal(bytes.toString('utf8').includes(f.text),false);assert.equal(bytes.toString('utf8').includes(f.reference.url),false);
});

test('explicit original policy receipt reuse preserves its real clock while fresh admission records the later check',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['Date'],now:Date.parse(at)});
 const input={records:[f.record],admissions:f.admissions,auditDir:f.auditDir},first=await admitPublicationKnowledge(input,f.policy);
 t.mock.timers.tick(60_000);
 const reused=await admitPublicationKnowledge({...input,auditDir:join(f.root,'unused-replay-audit'),policyReceipts:first.pin},f.policy);
 assert.deepEqual(reused.pin,first.pin);assert.deepEqual(reused.receipts,first.receipts);
 await assert.rejects(lstat(join(f.root,'unused-replay-audit')),{code:'ENOENT'});
 const fresh=await admitPublicationKnowledge(input,f.policy);
 assert.equal(fresh.receipts.records[0].checkedAt,'2026-10-11T12:01:00.000Z');assert.notEqual(fresh.pin.sha256,first.pin.sha256);
 assert.equal(first.receipts.records[0].checkedAt,at);
});

test('a real changed prepared policy cannot reuse a pinned earlier admission receipt',async t=>{
 const f=await fixture(t),input={records:[f.record],admissions:f.admissions,auditDir:f.auditDir},first=await admitPublicationKnowledge(input,f.policy);
 const changedReference=structuredClone(f.reference);changedReference.policy.tdm.state='not_reserved';
 const changed=await f.prepare(changedReference),admissions=[{recordId:f.record.id,prepared:[changed.pin]}];
 assert.notEqual(changed.prepared.receiptSha256,f.admissions[0].prepared[0].bindings[0].kind==='prepared_source'?f.admissions[0].prepared[0].bindings[0].receiptSha256:undefined);
 await assert.rejects(admitPublicationKnowledge({...input,admissions,policyReceipts:first.pin},f.policy),/do not match current admission/);
 const fresh=await admitPublicationKnowledge({...input,admissions},f.policy);assert.notEqual(preparedDecision(fresh.receipts).sources[0].policySha256,preparedDecision(first.receipts).sources[0].policySha256);
});

test('receipt authority contract record evidence and source decisions must remain bound even under a new file pin',async t=>{
 const f=await fixture(t),input={records:[f.record],admissions:f.admissions,auditDir:f.auditDir},first=await admitPublicationKnowledge(input,f.policy);
 for(const field of ['authoritySha256','contractSha256','evidenceHash','sourceSha256'] as const){
  const changed=structuredClone(first.receipts);
  if(field==='authoritySha256'||field==='contractSha256')changed[field]=sha256('changed '+field);
  else if(field==='evidenceHash')changed.records[0].evidenceHash=sha256('changed evidence');
  else changed.records[0].sources[0].sourceSha256=sha256('changed source');
  const path=join(f.root,field+'.json'),digest=await writePrivateJson(path,changed),pin:PublicationAuditPin={path,sha256:digest,bytes:Buffer.byteLength(JSON.stringify(changed,null,2)+'\n')};
  await assert.rejects(admitPublicationKnowledge({...input,policyReceipts:pin},f.policy),/do not match current admission/);
 }
 await assert.rejects(admitPublicationKnowledge({...input,policyReceipts:{...first.pin,sha256:sha256('wrong pin')}},f.policy),/bytes differ/);
});

test('current objections and unbound prepared contributors fail before any publication policy audit is written',async t=>{
 const f=await fixture(t),input={records:[f.record],admissions:f.admissions,auditDir:f.auditDir};
 await assert.rejects(admitPublicationKnowledge({...input,admissions:[]},f.policy),/exact current admission inventory/);
 await assert.rejects(admitPublicationKnowledge({...input,admissions:[...f.admissions,...f.admissions]},f.policy),/exact current admission inventory/);
 await assert.rejects(admitPublicationKnowledge({...input,admissions:[{recordId:f.record.id,prepared:[...f.admissions[0].prepared,...f.admissions[0].prepared]}]},f.policy),/one unambiguous current prepared receipt/);
 const changed=structuredClone(f.admissions[0].prepared[0]);changed.bindings[0].sourceSha256=sha256('foreign source');
 await assert.rejects(readPublicationSourcePin(changed,f.policy));
 await assert.rejects(lstat(f.auditDir),{code:'ENOENT'});
 await recordHostOptOut({host:'example.org',reason:'municipality_objection'},f.policy);
 await assert.rejects(admitPublicationKnowledge(input,f.policy),HostOptedOutError);
 await assert.rejects(lstat(f.auditDir),{code:'ENOENT'});
});

test('retained publication content cannot substitute for actual prepared-source claim admission',async t=>{
 const f=await fixture(t),actual=f.admissions[0].prepared[0];
 const retained=knowledgeSourcePinSchema.parse({...actual,bindings:[{kind:'retained_publication',url:f.reference.url,sourceSha256:f.reference.sha256,publication:{manifestSha256:sha256('synthetic manifest'),releaseId:sha256('synthetic release'),memberPath:'knowledge/records.json',memberSha256:actual.sha256,memberBytes:actual.bytes},independentAllowed:false}]});
 assert.equal(publicationAdmissionSchema.safeParse({recordId:f.record.id,prepared:[retained]}).success,false);
 await assert.rejects(lstat(f.auditDir),{code:'ENOENT'});
});

test('pinned receipts cannot ignore a changed current authority objection snapshot',async t=>{
 const f=await fixture(t),input={records:[f.record],admissions:f.admissions,auditDir:f.auditDir},first=await admitPublicationKnowledge(input,f.policy);
 await recordHostOptOut({host:'other.example.org',reason:'municipality_objection'},f.policy);
 await assert.rejects(admitPublicationKnowledge({...input,policyReceipts:first.pin},f.policy),/do not match current admission/);
 const current=await admitPublicationKnowledge(input,f.policy);
 assert.notEqual(current.receipts.snapshotSha256,first.receipts.snapshotSha256);
 assert.deepEqual(current.receipts.records[0].sources,first.receipts.records[0].sources);
});

test('retained public admission uses no prepared file and preserves original model clocks in v2 receipts',async t=>{
 const f=await retainedFixture(t),privatePaths=new Set(f.admissions.flatMap(admission=>admission.prepared.map(pin=>pin.path))),originalRead=fsPromises.readFile;let privateReads=0;
 const spy=t.mock.method(fsPromises,'readFile',(...args:Parameters<typeof fsPromises.readFile>)=>{
  if(privatePaths.has(String(args[0]))){privateReads++;throw Error('Retained admission must not read prepared producer files');}
  return originalRead(...args);
 });
 syncBuiltinESMExports();t.after(()=>{spy.mock.restore();syncBuiltinESMExports();});
 const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('Retained admission must not acquire sources');});
 t.mock.timers.enable({apis:['Date'],now:Date.parse(at)+60_000});
 const input={records:[f.projected],admissions:f.retainedAdmissions,retainedPublication:f.retainedPublication,auditDir:f.auditDir},first=await admitPublicationKnowledge(input,f.policy),decision=first.receipts.records[0];
 assert.equal(decision.basis,'retained_publication');
 if(decision.basis!=='retained_publication')throw Error('Expected retained-publication decision');
 assert.equal(first.receipts.schemaVersion,'stadtstack-publication-policy-receipts-v2');
 assert.equal(decision.publication.manifestSha256,f.retainedPublication.manifest.sha256);
 assert.equal(decision.publication.recordsSha256,f.retainedPublication.records.sha256);
 assert.equal(decision.publication.origin.originalEvidenceHash,f.original.verification.evidenceHash);
 assert.equal(decision.publication.origin.extractedAt,f.original.extraction.extractedAt);
 assert.equal(decision.publication.origin.evaluatedAt,f.original.verification.faithfulness.evaluatedAt);
 assert.ok(decision.sources.every(source=>!('preparedReceiptSha256' in source)&&!('textSha256' in source)));
 assert.ok(first.bindings.every(binding=>binding.kind==='retained_publication'&&binding.independentAllowed===false));
 assert.deepEqual(f.projected.extraction,f.original.extraction);
 assert.deepEqual(f.projected.verification.faithfulness,f.original.verification.faithfulness);
 assert.ok(first.retainedPublication);assert.equal(first.retainedPublication.selectedRecordOrigins.length,1);
 t.mock.timers.tick(60_000);
 const replay=await admitPublicationKnowledge({...input,policyReceipts:first.pin},f.policy);
 assert.deepEqual(replay.receipts,first.receipts);assert.deepEqual(replay.pin,first.pin);
 assert.equal(privateReads,0);assert.equal(network.mock.callCount(),0);
});

test('retained admission cannot alter claims scores source observations or original extraction and judge clocks',async t=>{
 const f=await retainedFixture(t),input={records:[f.projected],admissions:f.retainedAdmissions,retainedPublication:f.retainedPublication,auditDir:f.auditDir};
 for(const mutation of ['summary','score','extraction-clock','judge-clock','source-clock','deterministic-receipt'] as const){
  const changed=structuredClone(f.projected);
  if(mutation==='summary')changed.summary+=' Unsupported extra claim.';
  else if(mutation==='score')changed.verification.faithfulness.score=0.95;
  else if(mutation==='extraction-clock')changed.extraction.extractedAt='2026-10-12T12:00:00.000Z';
  else if(mutation==='judge-clock')changed.verification.faithfulness.evaluatedAt='2026-10-12T12:00:00.000Z';
  else if(mutation==='source-clock')changed.sources[0].retrievedAt='2026-10-12T12:00:00.000Z';
  else changed.verification.deterministic.checks[0].reason+=' rewritten';
  changed.verification.evidenceHash=knowledgeEvidenceHash(changed);
  await assert.rejects(admitPublicationKnowledge({...input,records:[changed]},f.policy),/changes original claims or receipts/);
 }
 await assert.rejects(admitPublicationKnowledge({...input,admissions:[{recordId:f.original.id,retainedPublication:{originalEvidenceHash:sha256('wrong original')}}]},f.policy),/original evidence binding mismatch/);
 await assert.rejects(lstat(f.auditDir),{code:'ENOENT'});
});

test('retained cohorts require all four exact public artifacts and cannot mix valid members from another seal',async t=>{
 const f=await retainedFixture(t),input={records:[f.projected],admissions:f.retainedAdmissions,retainedPublication:f.retainedPublication,auditDir:f.auditDir};
 await assert.rejects(admitPublicationKnowledge({...input,retainedPublication:undefined},f.policy),/authentic public publication baseline/);
 await assert.rejects(admitPublicationKnowledge({...input,admissions:f.admissions},f.policy),/Unused retained publication/);
 assert.equal(publicationAdmissionSchema.safeParse({...f.retainedAdmissions[0],prepared:f.admissions[0].prepared}).success,false);
 const wrongManifest=structuredClone(f.retainedPublication);wrongManifest.manifest.sha256=sha256('wrong manifest pin');
 await assert.rejects(admitPublicationKnowledge({...input,retainedPublication:wrongManifest},f.policy),/bytes differ/);
 const wrongMember=structuredClone(f.retainedPublication);wrongMember.coverage.sha256=sha256('wrong coverage pin');
 await assert.rejects(admitPublicationKnowledge({...input,retainedPublication:wrongMember},f.policy),/exact authenticated publication member bytes|bytes differ/);
 const foreign=await f.seal('foreign','2026-10-11T12:01:00.000Z');
 assert.equal(foreign.coverage.sha256,f.retainedPublication.coverage.sha256);
 assert.notEqual(foreign.manifest.sha256,f.retainedPublication.manifest.sha256);
 await assert.rejects(admitPublicationKnowledge({...input,retainedPublication:{...f.retainedPublication,coverage:foreign.coverage}},f.policy),/authentic public cohort/);
 await assert.rejects(lstat(f.auditDir),{code:'ENOENT'});
});

test('a public seal cannot upgrade originally failing retained gates or an original candidate',async t=>{
 const f=await retainedFixture(t);
 for(const mutation of ['score','deterministic','candidate'] as const){
  const original=structuredClone(f.original);
  if(mutation==='score')original.verification.faithfulness.score=0.79;
  else if(mutation==='deterministic'){original.verification.deterministic.passed=false;original.verification.deterministic.checks[0].passed=false;}
  else original.verification.status='candidate';
  original.verification.evidenceHash=knowledgeEvidenceHash(original);
  const retainedPublication=await f.seal('failed-'+mutation,at,original);
  await assert.rejects(admitPublicationKnowledge({records:[f.projected],admissions:[{recordId:original.id,retainedPublication:{originalEvidenceHash:original.verification.evidenceHash}}],retainedPublication,auditDir:f.auditDir},f.policy));
 }
 await assert.rejects(lstat(f.auditDir),{code:'ENOENT'});
});

test('current host objections deny unchanged retained facts without prepared or old-output fallback',async t=>{
 const f=await retainedFixture(t);
 await recordHostOptOut({host:'example.org',reason:'rights_holder_objection'},f.policy);
 await assert.rejects(admitPublicationKnowledge({records:[f.projected],admissions:f.retainedAdmissions,retainedPublication:f.retainedPublication,auditDir:f.auditDir},f.policy),HostOptedOutError);
 await assert.rejects(lstat(f.auditDir),{code:'ENOENT'});
});

test('retained admission permits only canonical derived identity changes while preserving every original receipt',async t=>{
 const f=await retainedFixture(t),original=structuredClone(f.original);
 // Synthetic historical mention is supported by the already declared source text.
 original.entities=normalizeGraphClaims({entities:[{mentionId:'municipality',name:'Beispielstadt',type:'municipality',quote:'Stadt Beispielstadt',identifiers:[]}],relations:[]},{municipalityId:original.municipalityId,sourceSha256:original.extraction.inputSha256}).entities;
 const entity=original.entities[0],legacyKey=JSON.stringify([entity.type,entity.name.toLocaleLowerCase('de'),original.municipalityId]);
 entity.entityId='entity:'+sha256(legacyKey);entity.identityBasis.key=legacyKey;
 original.verification.evidenceHash=knowledgeEvidenceHash(original);
 const retainedPublication=await f.seal('legacy-identity',at,original),projected=projectKnowledgeRecordIdentity(original);
 assert.notEqual(projected.entities[0].entityId,original.entities[0].entityId);
 assert.deepEqual(projected.extraction,original.extraction);assert.deepEqual(projected.verification.faithfulness,original.verification.faithfulness);assert.deepEqual(projected.verification.deterministic,original.verification.deterministic);
 const result=await admitPublicationKnowledge({records:[projected],admissions:[{recordId:original.id,retainedPublication:{originalEvidenceHash:original.verification.evidenceHash}}],retainedPublication,auditDir:f.auditDir},f.policy);
 assert.ok(result.retainedPublication);
 const origin=result.retainedPublication.selectedRecordOrigins[0];
 assert.equal(origin.originalEvidenceHash,original.verification.evidenceHash);assert.equal(origin.currentEvidenceHash,projected.verification.evidenceHash);
});
