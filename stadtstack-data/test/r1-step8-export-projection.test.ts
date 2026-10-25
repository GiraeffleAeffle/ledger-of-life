import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {districtRegistrySchema} from '../src/district-registry.ts';
import {knowledgeEvidenceHash,type DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {canonicalJson,digest} from '../src/district-adapter-contract.ts';
import {ResidualExtractionSchema} from '../src/district-residual-jobs.ts';
import {buildR1TextCompositionContext} from '../src/district-r1-text-composition.ts';
import {projectStep8PublicationIntake,selectStep8PublicationPolicy,step8DocumentDisposition,step8AssessmentIdentity,withheldStep8PublicationIntake} from '../src/r1-step8-export-projection.ts';
import {syntheticTextRecord,syntheticTextContribution} from './helpers/text-publication-fixture.ts';

// Synthetic schema fixtures, never provider/civic/policy execution evidence.
const at='2026-10-10T12:00:00.000Z',hash=digest(Buffer.from('synthetic original bytes'));
const full=districtRegistrySchema.parse(JSON.parse(await readFile(new URL('../sources/district-registry.json',import.meta.url),'utf8'))),city=full.municipalities.find(city=>city.sources.some(source=>source.kind==='website'))!;
const website=city.sources.find(source=>source.kind==='website')!,registry={...full,municipalities:[{...city,sources:[website]}],districts:full.districts.filter(district=>district.id===city.districtId)};
const source={municipalityId:city.id,sourceId:website.id};
const record=(id='synthetic-record')=>syntheticTextRecord(registry,id,hash);
function result(records:DistrictKnowledgeRecord[]=[]){return ResidualExtractionSchema.parse({schemaVersion:'district-residual-extraction-v1',documentId:'document-crawler-identity',corpusSha256:hash,registrySha256:hash,policyReceiptSha256:hash,preparationJobKey:hash,preparationReceiptId:randomUUID(),preparationReceiptSha256:hash,preparedArtifactSha256:hash,result:{schemaVersion:'stadtstack-document-result-v2',taskId:hash,groupId:hash,provider:'openai-subscription',purpose:'production',municipalityId:city.id,sourceSha256:hash,preparedSha256:hash,promptSha256:hash,schemaSha256:hash,generatedAt:at,records,quarantine:[],chunks:[]}});}
function contribution(row:DistrictKnowledgeRecord,label:string){const scoped={...registry,municipalities:[{...registry.municipalities[0],sources:[{...website,id:row.sources[0].id}]}]},crawl={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:at,documents:[{id:'synthetic-'+label,municipalityId:city.id,sourceId:row.sources[0].id,sha256:hash}],checks:[]};return syntheticTextContribution(scoped,crawl,[row],[],{label});}
function input(runs:ReturnType<typeof contribution>[]){return {generatedAt:at,contributions:runs,approvedRunOrder:runs.map(run=>run.runId),admissions:runs.map(run=>({runId:run.runId,recordIds:JSON.parse(String(run.artifacts.records.bytes)).records.map((row:{id:string})=>row.id)}))};}

test('document dispositions accept only exact scoped crawler/native aliases or scoped absent IDs',()=>{
 const native=result(),base={...source,sourceSha256:hash,chunk:0,reason:'No supported case in source excerpt'};
 for(const documentId of [native.documentId,'document:'+hash,undefined])assert.equal(step8DocumentDisposition(source,native,[],[{...base,...(documentId===undefined?{}:{documentId})}]).cases.length,1);
 for(const patch of [{municipalityId:'wrong-city'},{sourceId:'wrong-source'},{sourceSha256:'f'.repeat(64)},{documentId:'unrelated-nonempty-id'}])assert.throws(()=>step8DocumentDisposition(source,native,[],[{...base,documentId:'document:'+hash,...patch}]),/neither admission nor explicit disposition/);
 assert.throws(()=>step8DocumentDisposition(source,native,[],[]),/neither admission nor explicit disposition/);
 assert.throws(()=>step8DocumentDisposition(source,native,[],[{...base,sourceId:'wrong-source'}]),/neither admission/);
});

test('admitted records bind original bytes and the exact native record, not prepared text or ID alone',()=>{
 const row=record(),native=result([row]);assert.notEqual(row.extraction.textSha256,hash);
 assert.deepEqual(step8DocumentDisposition(source,native,[row],[]).records,[row]);
 const altered=structuredClone(row);altered.title='Changed';altered.verification.evidenceHash=knowledgeEvidenceHash(altered);
 assert.throws(()=>step8DocumentDisposition(source,native,[altered],[]),/exact native result/);
 const wrongHash=structuredClone(row);wrongHash.extraction.inputSha256=row.extraction.textSha256;
 assert.throws(()=>step8DocumentDisposition(source,native,[wrongHash],[]),/neither admission/);
});

test('publication intake withholds canonical date holds, preserving native envelopes and original admissions',()=>{
 const undated=record('synthetic-undated');undated.documentDate=null;undated.documentDateQuote=null;undated.documentDateReason='Synthetic missing sourced date';undated.verification.evidenceHash=knowledgeEvidenceHash(undated);
 const dated=record('synthetic-dated'),runs=[contribution(undated,'undated'),contribution(dated,'dated')],original=input(runs),bytes=canonicalJson(original);
 assert.throws(()=>buildR1TextCompositionContext(original),/publication-withheld record/);
 const projected=projectStep8PublicationIntake(original);
 assert.equal(canonicalJson(original),bytes);assert.deepEqual(original.admissions[0].recordIds,[undated.id]);
 assert.deepEqual(projected.input.admissions[0].recordIds,[]);assert.deepEqual(projected.context.knowledge.records.map(row=>row.id),[dated.id]);
 assert.equal(projected.holds.length,1);assert.deepEqual(projected.holds[0].hold.reasons,['missing_sourced_date']);
 const carried=withheldStep8PublicationIntake(projected.context);assert.equal(carried.length,1);assert.equal(carried[0].quarantine.recordId,undated.id);assert.equal(carried[0].quarantine.sourceSha256,hash);
 assert.deepEqual(projected.input.contributions,original.contributions);
});

test('intake cannot promote original candidates or tolerate changed source artifact bytes',()=>{
 const row=record();row.verification.status='candidate';row.verification.evidenceHash=knowledgeEvidenceHash(row);
 assert.throws(()=>projectStep8PublicationIntake(input([contribution(row,'candidate')])),/cannot promote an original candidate/);
 const good=input([contribution(record(),'good')]);good.contributions[0].artifacts.records.bytes=String(good.contributions[0].artifacts.records.bytes)+' ';
 assert.throws(()=>projectStep8PublicationIntake(good),/artifact hash mismatch/);
});

test('policy custody follows the exact composition-selected run and evidence, never recordId deduplication',()=>{
 const first=record('synthetic-shared-id'),second=structuredClone(first);second.sources[0].id='synthetic-alias';second.verification.evidenceHash=knowledgeEvidenceHash(second);
 const runs=[contribution(first,'first'),contribution(second,'second')],projected=projectStep8PublicationIntake(input(runs)),receipt=(row:DistrictKnowledgeRecord,proof:string)=>({recordId:row.id,receipts:row.sources.map(source=>({sourceUrl:source.url,sourceSha256:source.sha256,receiptSha256:proof}))});
 const sources=runs.map((run,index)=>({runId:run.runId,inventory:{records:[receipt(index?second:first,(index?'b':'a').repeat(64))]}}));
 const selected=selectStep8PublicationPolicy(projected.context,sources);assert.equal(selected.records.length,1);assert.equal(selected.records[0].receipts[0].receiptSha256,'b'.repeat(64));
 assert.throws(()=>selectStep8PublicationPolicy(projected.context,sources.slice(0,1)),/exact original run\/record\/evidence custody/);
 assert.throws(()=>selectStep8PublicationPolicy(projected.context,[sources[0],{...sources[1],inventory:{records:[...sources[1].inventory.records,...sources[1].inventory.records]}}]),/Duplicate publication policy record/);
 const wrong=structuredClone(sources);wrong[1].inventory.records[0].receipts[0].sourceUrl='https://example.org/other';assert.throws(()=>selectStep8PublicationPolicy(projected.context,wrong),/source membership differs/);
 const conflict=structuredClone(sources).map((source,index)=>({...source,inventory:{...source.inventory,currentAdmissionReceipts:{['c'.repeat(64)]:(index?'e':'d').repeat(64)}}}));assert.throws(()=>selectStep8PublicationPolicy(projected.context,conflict),/Conflicting source policy continuation/);
});

test('immutable assessment identities distinguish source scope, original evidence and every bundle pin',()=>{
 const pins={recordId:'shared-record',recordEvidenceSha256:hash,finalArtifactSha256:hash,itemArtifactSha256:hash,AArtifactSha256:hash,BArtifactSha256:hash,CArtifactSha256:hash},identity=step8AssessmentIdentity(source,pins);
 assert.deepEqual(step8AssessmentIdentity(source,pins),identity);
 assert.notEqual(step8AssessmentIdentity({...source,sourceId:'other-source'},pins).assessmentId,identity.assessmentId);
 for(const key of ['recordEvidenceSha256','finalArtifactSha256','itemArtifactSha256','AArtifactSha256','BArtifactSha256','CArtifactSha256'] as const)assert.notEqual(step8AssessmentIdentity(source,{...pins,[key]:'f'.repeat(64)}).assessmentId,identity.assessmentId);
});

test('the automatic export pre-pass refuses before opening an unavailable authority fence',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'step8-prefence-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const save=async(name:string,value:unknown)=>{const bytes=Buffer.from(canonicalJson(value)),path=join(directory,name+'.json');await writeFile(path,bytes,{mode:0o600});return {path,sha256:digest(bytes)};};
 const seal=await save('invalid-seal',{}),corpus=await save('synthetic-corpus',{fixture:'unissued negative controls, never civic evidence'}),campaign=await save('campaign',{schemaVersion:'stadtstack-r1-step8-campaign-v1',sources:[{...source,corpus,documents:[{documentId:'synthetic-doc',sha256:hash,jobKey:hash}]}]});
 const frame=await save('frame',{schemaVersion:'stadtstack-r1-native-seal-selection-v1',catalogue:campaign,seals:[{...source,corpus,output:seal,admission:'published',queue:{}}]}),action=await save('unissued-action',{selection:frame});
 const policy={stateDir:join(directory,'unavailable-authority'),authorityId:'synthetic-only',authoritySha256:hash},currentGeneration={processingCommit:'a'.repeat(40),catalogue:campaign,processingReview:campaign,assessmentQueueContractSha256:hash,projectionVersion:'assessment-source-record-v2',B:{jobContractSha256:hash,runnerContractSha256:hash,runnerOutputContractSha256:hash,nativeStreamVersion:'omp-native-stream-v2',thinking:'medium',receiptVersion:'assessment-receipt-v2',selector:'anthropic/claude-sonnet-5-5',transport:'vm-omp'}};
 const input={schemaVersion:'stadtstack-r1-step8-v1',expectedSources:1,expectedDocuments:1,campaign,currentGeneration,seals:[{sealResult:seal,jobKeys:[hash],reconciliationJobKeys:[]}],nativeSealSelection:action,structuredRunIds:[randomUUID()],registry:campaign,privateProvenance:campaign,stagingProvenance:campaign,staging:[{...campaign,destination:'catalogue.json'}],priorRelease:{gitCommit:'b'.repeat(40),directory:'release',releaseId:hash,manifestSha256:hash},asOf:'2026-10-10',clocks:{recordsGeneratedAt:at,quarantineGeneratedAt:at,coverageGeneratedAt:at,qualityGeneratedAt:at,manifestGeneratedAt:at},casRoot:join(directory,'cas'),outputRoot:join(directory,'candidate'),policy};
 const {precheckStep8Publication}=await import(new URL('../scripts/r1-step8-precheck.mjs',import.meta.url).href),{report}=await precheckStep8Publication(input);
 assert.equal(report.status,'blocked');assert.ok(report.blockers.some((entry:{code:string})=>entry.code==='SEALED_EXPORT_PROJECTION'));assert.equal(report.exportProjection.canonicalPasses,0);
 await assert.rejects(lstat(policy.stateDir),{code:'ENOENT'});await assert.rejects(lstat(input.outputRoot),{code:'ENOENT'});
});

test('an older intake date hold never removes a later dated admission of the same record identity',()=>{
 const old=record('synthetic-corrected-date');old.documentDate=null;old.documentDateQuote=null;old.documentDateReason='Synthetic old missing date';old.verification.evidenceHash=knowledgeEvidenceHash(old);
 const current=record(old.id),runs=[contribution(old,'older-undated'),contribution(current,'later-dated')],projection=projectStep8PublicationIntake(input(runs));
 assert.deepEqual(projection.context.knowledge.records,[current]);
 const carried=withheldStep8PublicationIntake(projection.context);assert.equal(carried.length,1);assert.equal(carried[0].record.verification.evidenceHash,old.verification.evidenceHash);
 assert.notEqual(carried[0].record.verification.evidenceHash,projection.context.knowledge.records[0].verification.evidenceHash);
});
