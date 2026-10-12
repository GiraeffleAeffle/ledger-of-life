import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {buildCorpusManifest,verifyCorpusManifest,parseManifestJsonl,CorpusManifestRecordSchema,type CorpusManifestOptions,type CorpusManifestSummary} from '../src/corpus-manifest.ts';
import {sha256,knowledgeEvidenceHash,DistrictKnowledgeRecordSchema,type DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {districtRegistrySchema} from '../src/district-registry.ts';
import {ownerRobotsOverrideFor,type SourceAccessPolicy} from '../src/source-policy.ts';
import {DOCUMENT_ORIGIN_CLASSIFIER_VERSION} from '../src/document-origin-contract.ts';
import {createWorkPlan,type WorkPlan,type WorkTask} from '../src/district-work-plan.ts';
import {deterministicChecks} from '../src/district-claims.ts';
import {PROVIDER_CONFIGS} from '../src/district-model-contract.ts';
import {publishDataRelease,dataReleaseId} from '../src/data-release.ts';
import {buildTextRunLineage,textLineageRecordSha256,type TextLineageArtifact,type TextRunContribution} from '../src/text-run-lineage.ts';
import {initializeManagedAcquisitionLane,withManagedSourceWrite,recordHostOptOut,type ManagedSourceBinding} from '../src/civic-opt-out.ts';
import {writeManagedSourceJson,type SourceArtifactBinding} from '../src/district-private-io.ts';
import {createCivicPolicyTestContext} from './fixtures/civic-policy.ts';
import {buildDistrictCoverage} from '../src/district-publication.ts';
import {authenticateRetainedKnowledgePublication,retainedKnowledgeRecordOrigin} from '../src/retained-knowledge-lineage.ts';

// Synthetic bytes and receipts only. No real caches, HTTP, parsers or model calls.
const at='2026-10-10T12:00:00.000Z',later='2026-10-11T12:00:00.000Z';
const text='Stadt Beispielstadt\nWärmeplanung\nDer Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.\nStand: 10.10.2026';
const newText='Synthetic newer representation\n'+text,sourceHash=sha256(text),newHash=sha256(newText),url='https://example.org/document';
const sourcePolicy:SourceAccessPolicy={robots:{state:'allowed',url:'https://example.org/robots.txt'},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'};
const municipality={id:'strausberg',name:'Beispielstadt',ags:'12064001',districtId:'unit-district'};
const registry=districtRegistrySchema.parse({schemaVersion:'stadtstack-source-registry-v1',generatedAt:at,
 districts:[{id:'unit-district',name:'Synthetic district',ags:'12064',state:'Brandenburg',inventorySources:[{url:'https://example.org/inventory',locator:'synthetic'}],inventoryAsOf:'2026-10-10',inventoryComplete:true}],
 municipalities:[{...municipality,districtAgs:'12064',amt:null,administrativeStatus:'amtsfrei',administrativeEvidence:[{url:'https://example.org/identity',locator:'synthetic'}],identitySources:[{url:'https://example.org/identity',locator:'synthetic',sha256:sha256('identity'),retrievedAt:at}],sources:['council','participation','gazette','website'].map(kind=>({id:'unit-'+kind,kind,url:'https://example.org/'+kind,vendor:'unknown',checkState:'checked',checkedAt:at,evidence:[{url:'https://example.org/'+kind,locator:'synthetic'}]})),seedDocuments:[{url,sourceId:'unit-website',title:'Synthetic source',documentDate:'2026-10-10',evidence:[{url,locator:'synthetic'}]}]}],
 inventory:[{ags:municipality.ags,name:municipality.name,districtId:municipality.districtId,identitySourceUrl:'https://example.org/identity',pilot:true,sourceCheckState:'checked',reason:'Synthetic fixture'}],notes:[]});
function knowledgeRecord(id:string,body:string,sourceUrl:string,clock:string,chunks:number):DistrictKnowledgeRecord{
 const bodySha256=sha256(body),claims={title:'Wärmeplanung',titleQuote:'Wärmeplanung',summary:'Der Entwurf der Wärmeplanung wurde veröffentlicht.',summaryQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',municipalityQuote:'Stadt Beispielstadt',caseKey:null,caseKeyType:'source_document' as const,caseQuote:null,caseType:'planning' as const,documentDate:'2026-10-10',documentDateQuote:'Stand: 10.10.2026',documentDateReason:null,topics:[{id:'waermeplanung',parentId:'energie',provenance:'model' as const,confidence:0.9,quote:'Wärmeplanung'}],stage:'draft' as const,stageDate:'2026-10-09',stageDateQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stageDateReason:null,originalStatus:'Entwurf',stageQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stages:[],entities:[],relations:[],locations:[]},model=PROVIDER_CONFIGS['openai-subscription'];
 const value={...claims,kind:'text_model',id,municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,caseKey:`source_document:${bodySha256}`,sources:[{id:'unit-website',url:sourceUrl,sha256:bodySha256,retrievedAt:clock,locator:`text-sha256:${bodySha256};chars:0-${body.length}`,mimeType:'text/plain',sourceType:'website',policy:sourcePolicy}],extraction:{extractorVersion:'synthetic-test',extractorSha256:sha256('extractor'),model:model.model,provider:'openai-subscription',tool:model.tool,toolVersion:'synthetic-test',modelIdentitySha256:sha256('synthetic-model'),modelIdentityBasis:model.modelIdentityBasis,returnedModel:null,promptVersion:'synthetic-test',promptSha256:sha256('prompt'),judgePromptVersion:'synthetic-test',judgePromptSha256:sha256('judge'),inputSha256:bodySha256,textSha256:bodySha256,responseSha256:sha256('answer '+id),ocrUsed:false,textMethod:'text',cacheKey:sha256('cache '+id),extractedAt:clock,chunk:{index:0,count:chunks,start:0,end:body.length}},verification:{kind:'text_model',status:'auto-verified',deterministic:deterministicChecks(claims,body,municipality.name),faithfulness:{score:0.9,threshold:0.8,model:model.model,provider:'openai-subscription',tool:model.tool,toolVersion:'synthetic-test',modelIdentitySha256:sha256('synthetic-model'),returnedModel:null,reason:'Synthetic test, not model evidence',evaluatedAt:clock,responseSha256:sha256('judge-answer '+id),sameModel:true,limitation:'Same-model judgment is not independent verification.'},evidenceHash:''}};
 value.verification.evidenceHash=knowledgeEvidenceHash(value);return DistrictKnowledgeRecordSchema.parse(value);
}
function artifact(value:unknown):TextLineageArtifact{const bytes=JSON.stringify(value,null,2)+'\n';return {bytes,sha256:sha256(bytes)};}
type NativeFixtureRecord=Omit<DistrictKnowledgeRecord,'entities'|'relations'>&{entities:unknown[];relations:unknown[]};
function resultFor(task:WorkTask,plan:WorkPlan,record:NativeFixtureRecord,clock:string,threeChunks=false){
 const quarantine=threeChunks?[{documentId:'document:'+record.extraction.inputSha256,municipalityId:municipality.id,sourceId:'unit-website',sourceSha256:record.extraction.inputSha256,chunk:1,reason:'PRIVATE-REJECTED-ANSWER'},{documentId:'document:'+record.extraction.inputSha256,municipalityId:municipality.id,sourceId:'unit-website',sourceSha256:record.extraction.inputSha256,chunk:2,reason:'No supported case'}]:[];
 return {schemaVersion:'stadtstack-document-result-v2',taskId:task.id,groupId:task.groupId,provider:task.provider,purpose:task.purpose,municipalityId:municipality.id,sourceSha256:task.group.sourceSha256,preparedSha256:task.group.preparedSha256,promptSha256:plan.promptSha256,schemaSha256:plan.schemaSha256,generatedAt:clock,records:[record],quarantine,chunks:[{index:0,outcome:'admitted',responseSha256:record.extraction.responseSha256,recordId:record.id},...(threeChunks?[{index:1,outcome:'rejected',responseSha256:sha256('rejected'),recordId:null},{index:2,outcome:'no_case',responseSha256:sha256('no-case'),recordId:null}]:[])]};
}
async function fixture(){
 const context=await createCivicPolicyTestContext(),{root,policy,decisionId}=context,artifactsRoot=join(root,'artifacts'),oldRaw=join(root,'old-raw'),newRaw=join(root,'new-raw'),releaseRoot=join(root,'release');
 const lane={...policy,decisionId};
 for(const raw of [oldRaw,newRaw]){await initializeManagedAcquisitionLane(raw,{...lane,kind:'fetch'});await mkdir(join(raw,'sha256'),{mode:0o700});await mkdir(join(raw,'observations'),{mode:0o700});}
 const pin=async(name:string,value:unknown)=>{const encoded=artifact(value),path=join(root,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,encoded.bytes);return {path,sha256:encoded.sha256};};
 const sourcePin=async(name:string,value:unknown,bindings:SourceArtifactBinding[])=>{const path=join(artifactsRoot,name),digest=await writeManagedSourceJson(artifactsRoot,path,value,bindings,{...lane,kind:'artifacts'});return {path,sha256:digest};};
 const observe=async(raw:string,name:string,body:string,sourceUrl:string,checkedAt=at,status=200)=>{
  const sourceSha256=sha256(body),observation={url:sourceUrl,method:'GET',checkedAt,retrievedAt:sourceUrl===url+'/new'?later:at,state:status===304?'not_modified':'fetched',status,sha256:sourceSha256,bytes:Buffer.byteLength(body),mimeType:'text/plain',etag:status===304?'"revalidated"':'"historical"',policy:sourcePolicy},encoded=artifact(observation),binding:Extract<ManagedSourceBinding,{kind:'http_observation'}>={kind:'http_observation',url:sourceUrl,sourceSha256,observationId:name,receiptSha256:encoded.sha256};
  await writeFile(join(raw,'observations',name),encoded.bytes,{mode:0o600});
  await withManagedSourceWrite(raw,[{...binding,relativePath:'sha256/'+sourceSha256,contentSha256:sourceSha256,independentAllowed:true}],async()=>{await writeFile(join(raw,'sha256',sourceSha256),body,{mode:0o600});},policy);
  return {...binding,independentAllowed:true};
 };
 const oldBindings:SourceArtifactBinding[]=[];
 oldBindings.push(await observe(oldRaw,'historical.json',text,url),await observe(oldRaw,'alias.json',text,'https://example.org/alias'),await observe(oldRaw,'revalidated.json',text,url,later,304),await observe(oldRaw,'extra-alias.json',text,'https://example.org/additional-alias'),await observe(oldRaw,'new.json',newText,url+'/new',later));
 const pendingBody='Synthetic pending body',heldBody='Synthetic preparation hold',unselectedBody='Synthetic unselected body';
 for(const [name,body] of [['pending',pendingBody],['held',heldBody],['unselected',unselectedBody]])oldBindings.push(await observe(oldRaw,name+'.json',body,'https://example.org/'+name));
 const newBindings:SourceArtifactBinding[]=[await observe(newRaw,'historical.json',text,url),await observe(newRaw,'new.json',newText,url+'/new',later)];
 const document=(id:string,body:string,sourceUrl:string,name?:string,clock=at)=>({id,municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,sourceId:'unit-website',url:sourceUrl,sha256:sha256(body),mimeType:'text/plain',retrievedAt:clock,documentDate:'2026-10-10',localPath:'/old/private/sha256/'+sha256(body),adapter:'synthetic',metadata:{title:'PRIVATE-SOURCE-SNIPPET'},policy:sourcePolicy,checkedAt:clock,status:200,...(name?{observationPath:'/old/private/observations/'+name}:{})});
 const oldDocument=document('document-old',text,url,'historical.json'),alias={...document('document-alias',text,'https://example.org/alias','alias.json'),sourceId:'unit-council'},newDocument=document('document-new',newText,url+'/new','new.json',later),pending=document('document-pending',pendingBody,'https://example.org/pending'),held=document('document-held',heldBody,'https://example.org/held'),unselected=document('document-unselected',unselectedBody,'https://example.org/unselected');
 const revalidated={...oldDocument,checkedAt:later,status:304,observationPath:'/old/private/observations/revalidated.json'},additional=document('document-extra-alias',text,'https://example.org/additional-alias','extra-alias.json');
 const newerRegistry=structuredClone(registry);newerRegistry.generatedAt=later;newerRegistry.notes=['Synthetic second registry generation'];
 const website=newerRegistry.municipalities[0].sources.find(source=>source.id==='unit-website')!;website.ownerRobotsOverride=ownerRobotsOverrideFor(website.url!)!;website.override='owner-approved 2026-10-11';
 const target='https://example.org/excluded',excludedHash=sha256('Excluded synthetic bytes are not retained'),exclusion={reason:'non_official_restricted' as const,excludedAt:later,previousManagedCopy:'not_managed' as const};
 const excludedPolicy:SourceAccessPolicy={...sourcePolicy,robots:{state:'blocked',url:'https://example.org/robots.txt',sha256:sha256('actual synthetic denial'),checkedAt:later},robotsStatus:'disallowed',override:'owner-approved 2026-10-11',ownerRobotsOverride:ownerRobotsOverrideFor(target)!,documentOrigin:{classification:'third_party',method:'rules',classifierVersion:DOCUMENT_ORIGIN_CLASSIFIER_VERSION,url:target,sha256:excludedHash,classifiedAt:later,evidence:[]}};
 const excludedDocument={id:'document-excluded',municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,sourceId:'unit-website',url:target,sha256:excludedHash,mimeType:'text/html',retrievedAt:later,checkedAt:later,status:200,observationPath:'/old/private/observations/excluded.json',documentDate:null,adapter:'excluded-source',metadata:{},policy:excludedPolicy,sizeBytes:123,exclusion};
 const excludedObservation=artifact({url:target,method:'GET',checkedAt:later,retrievedAt:later,state:'excluded',status:200,sha256:excludedHash,bytes:123,mimeType:'text/html',policy:excludedPolicy,exclusion});await writeFile(join(newRaw,'observations','excluded.json'),excludedObservation.bytes,{mode:0o600});
 newBindings.push({kind:'http_observation',url:target,sourceSha256:excludedHash,observationId:'excluded.json',receiptSha256:excludedObservation.sha256,independentAllowed:false});
 const oldIndex={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:at,documents:[oldDocument,alias,pending,held,unselected],checks:[]},cachedIndex={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:later,documents:[oldDocument,revalidated,additional,newDocument],checks:[]},newIndex={schemaVersion:'stadtstack-crawl-index-v1',generatedAt:later,documents:[newDocument,oldDocument],excludedDocuments:[excludedDocument],checks:[]};
 const oldIndexPin=await sourcePin('old-index.json',oldIndex,oldBindings),cachedIndexPin=await sourcePin('old-cached.json',cachedIndex,oldBindings),newIndexPin=await sourcePin('new-index.json',newIndex,newBindings),oldRegistryPin=await pin('old-registry.json',registry),newRegistryPin=await pin('new-registry.json',newerRegistry);
 const reference=(doc:typeof oldDocument)=>({id:doc.sourceId,url:doc.url,sha256:doc.sha256,retrievedAt:doc.retrievedAt,locator:'document-sha256:'+doc.sha256,mimeType:doc.mimeType,sourceType:'website' as const,policy:sourcePolicy}),extractorSha256=sha256('synthetic-text-extractor');
 const group=(doc:typeof oldDocument)=>({municipality,documentIds:[doc.id],expected:{receiptSha256:sha256('receipt '+doc.sha256),municipalityId:municipality.id,sourceSha256:doc.sha256,extractorSha256,references:[reference(doc)],toolVersions:{node:'synthetic'}},referenceWarnings:[] as Array<{documentId:string;sourceId:string;reason:string}>});
 const oldGroup=group(oldDocument),pendingGroup=group(pending),newGroup=group(newDocument);oldGroup.documentIds.push(alias.id);oldGroup.referenceWarnings.push({documentId:alias.id,sourceId:alias.sourceId,reason:'PRIVATE-REFERENCE-REJECTION'});
 const hold={documentId:held.id,municipalityId:municipality.id,sourceId:held.sourceId,sourceSha256:held.sha256,chunk:null,reason:'PRIVATE-PREPARATION-HOLD'};
 const oldPreparation={schemaVersion:'stadtstack-preparation-plan-v1',generatedAt:at,corpusSha256:oldIndexPin.sha256,registrySha256:oldRegistryPin.sha256,extractorSha256,maxDocumentsPerMunicipality:3,availableDocumentGroups:4,selectedDocumentGroups:3,selectedRepresentations:4,municipalities:[{...municipality,availableDocumentGroups:4,selectedDocumentGroups:3,selectedRepresentations:4}],groups:[oldGroup,pendingGroup],quarantine:[hold]};
 const newPreparation={...oldPreparation,generatedAt:later,corpusSha256:newIndexPin.sha256,registrySha256:newRegistryPin.sha256,availableDocumentGroups:2,selectedDocumentGroups:1,selectedRepresentations:1,municipalities:[{...municipality,availableDocumentGroups:2,selectedDocumentGroups:1,selectedRepresentations:1}],groups:[newGroup],quarantine:[]};
 const oldPreparationPin=await sourcePin('old-preparation.json',oldPreparation,oldBindings),newPreparationPin=await sourcePin('new-preparation.json',newPreparation,newBindings);
 const contract={promptSha256:sha256(JSON.stringify({extraction:sha256('prompt'),judge:sha256('judge'),extractorSha256:sha256('extractor')})),schemaSha256:sha256('schema'),extractorSha256:sha256('extractor')};
 const planFor=(groups:typeof oldPreparation.groups)=>createWorkPlan(groups.map(group=>({municipalityId:municipality.id,sourceSha256:group.expected.sourceSha256,preparedSha256:group.expected.receiptSha256})),contract,'codex-only');
 const oldPlan=planFor(oldPreparation.groups),newPlan=planFor(newPreparation.groups),oldTask=oldPlan.tasks.find(task=>task.group.sourceSha256===sourceHash)!,newTask=newPlan.tasks[0];
 const retainedRecord=knowledgeRecord('knowledge:retained-old',text,url,at,3),newRecord=knowledgeRecord('knowledge:native-new',newText,url+'/new',later,1);
 const oldNative:NativeFixtureRecord={...structuredClone(retainedRecord),entities:[{entityId:'legacy-local-identity',legacyLabel:'PRIVATE-LEGACY-GRAPH'}]};oldNative.verification.evidenceHash=knowledgeEvidenceHash(oldNative);
 const oldResult=resultFor(oldTask,oldPlan,oldNative,at,true),newResult=resultFor(newTask,newPlan,newRecord,later);
 const oldResultRoot=join(artifactsRoot,'old-results'),newResultRoot=join(artifactsRoot,'new-results');
 const oldResultPin=await sourcePin('old-results/'+oldTask.id+'.json',oldResult,oldBindings),newResultPin=await sourcePin('new-results/'+newTask.id+'.json',newResult,newBindings);
 for(const [task,result] of [[oldTask,oldResultPin],[newTask,newResultPin]] as const){task.state='completed';task.attempts=1;task.resultSha256=result.sha256;}
 // This deliberately opaque original plan ID must not be rebuilt using today's provider config.
 oldPlan.id=sha256('Original historical model configuration no longer installed');
 const oldPlanPin=await pin('old-plan.json',oldPlan),newPlanPin=await pin('new-plan.json',newPlan),model=PROVIDER_CONFIGS['openai-subscription'];
 const runFor=(clock:string,corpusSha256:string,registrySha256:string,available:number,attempted:number,selected:number,prepared:number)=>({schemaVersion:'stadtstack-extraction-run-v2',generatedAt:clock,assignmentMode:'codex-only',corpusSha256,registrySha256,promptContractSha256:contract.promptSha256,schemaSha256:contract.schemaSha256,scope:'bounded_per_municipality',maxDocumentsPerMunicipality:3,availableDocumentGroups:available,attemptedDocumentGroups:attempted,pendingDocumentGroups:available-attempted,municipalities:[{id:municipality.id,availableDocumentGroups:available,selectedDocumentGroups:selected,preparedDocumentGroups:prepared,attemptedDocumentGroups:attempted}],providers:[{provider:'openai-subscription',model:model.model,tool:model.tool,assignedGroups:prepared,completedGroups:1,agreementCompleted:0,publishedCandidates:1}]});
 const oldRun=runFor(at,oldIndexPin.sha256,oldRegistryPin.sha256,4,2,3,2),newRun=runFor(later,newIndexPin.sha256,newRegistryPin.sha256,2,1,1,1),oldRunArtifact=artifact(oldRun),newRunArtifact=artifact(newRun),retainedArtifact=artifact({schemaVersion:'stadtstack-knowledge-v3',generatedAt:later,records:[retainedRecord],identityAssertions:[],identityAdmissions:[]});
 const oldPins={corpusSha256:oldIndexPin.sha256,registrySha256:oldRegistryPin.sha256,promptContractSha256:contract.promptSha256,schemaSha256:contract.schemaSha256},newPins={...oldPins,corpusSha256:newIndexPin.sha256,registrySha256:newRegistryPin.sha256};
 const histogram={categories:[],failedDeterministicChecks:[]};
 const retainedCoverage=artifact({
  schemaVersion:'stadtstack-district-coverage-v3',generatedAt:later,
  accounting:{registryMunicipalities:1,configuredMunicipalities:1,checkedMunicipalities:1,runSelectedMunicipalities:1,preparedMunicipalities:1,attemptedMunicipalities:1,publishedMunicipalities:1,checkedWithoutPublishedMunicipalities:0,unvisitedMunicipalities:0},
  districts:[{id:municipality.districtId,ags:'12064',municipalitiesRegistered:1,municipalitiesConfigured:1,municipalitiesChecked:1,municipalitiesAttempted:1,municipalitiesWithRecords:1,municipalitiesWithDatedStages:1,documents:5,publishedRecords:1,quarantinedRecords:0}],
  municipalities:[{id:municipality.id,ags:municipality.ags,districtId:municipality.districtId,checked:true,status:'gated_records',documents:5,publishedRecords:1,datedStagedRecords:1,quarantinedRecords:0,quarantineReasons:histogram,
   extraction:{fetchedDocumentGroups:4,runSelectedDocumentGroups:3,preparedDocumentGroups:2,attemptedDocumentGroups:2,pendingDocumentGroups:2,unavailableAttemptedDocumentGroups:0},
   sources:registry.municipalities[0].sources.map(source=>({sourceId:source.id,kind:source.kind,registryState:'checked',crawlState:'checked',checkedAt:at,documentCount:source.id==='unit-website'?4:source.id==='unit-council'?1:0,publishedRecords:source.id==='unit-website'?1:0,quarantinedRecords:0,quarantineReasons:histogram,coverage:{state:'partial',pendingCount:2,runnableCount:2,blockedCount:0},failedLinkCount:0,failureExamples:[]}))}],
  extractionRun:{generatedAt:at,assignmentMode:'codex-only',...oldPins,selection:'bounded_per_municipality',maxDocumentsPerMunicipality:3,availableDocumentGroupsAtRunStart:4,attemptedDocumentGroups:2,pendingDocumentGroupsAtRunStart:2},
  models:[{provider:'openai-subscription',model:model.model,tool:model.tool,toolVersion:retainedRecord.extraction.toolVersion,modelIdentitySha256:retainedRecord.extraction.modelIdentitySha256,modelIdentityBasis:model.modelIdentityBasis,publishedRecords:1,faithfulnessThreshold:0.8}],
 });
 const retainedRegistry=artifact(registry),retainedFiles=[['records',retainedArtifact],['coverage',retainedCoverage],['registry',retainedRegistry]].map(([name,value])=>({path:`knowledge/${name}.json`,sha256:(value as TextLineageArtifact).sha256,bytes:Buffer.byteLength((value as TextLineageArtifact).bytes)}));
 const retainedManifest=artifact({schemaVersion:'stadtstack-data-release-v1',id:dataReleaseId(retainedFiles),generatedAt:later,files:retainedFiles,quality:{publishedRecords:1,quarantinedRecords:0,cities:1}});
 const baseline=authenticateRetainedKnowledgePublication({artifacts:{manifest:retainedManifest,records:retainedArtifact,coverage:retainedCoverage,registry:retainedRegistry},recordIds:[retainedRecord.id]});
 const retainedPublication={baseline,selectedRecordOrigins:[retainedKnowledgeRecordOrigin(baseline,0,retainedRecord)]};
 const oldContribution:TextRunContribution={runId:oldRunArtifact.sha256,sourceArtifactKind:'native_extraction_output',pins:oldPins,artifacts:{extractionRun:oldRunArtifact,records:artifact({schemaVersion:'stadtstack-knowledge-v2',generatedAt:at,records:[oldNative]}),quarantine:artifact({schemaVersion:'stadtstack-quarantine-v1',generatedAt:at,cases:[...oldResult.quarantine,hold]}),crawl:artifact(oldIndex),registry:artifact(registry),preparationPlan:artifact(oldPreparation)}};
 const newContribution:TextRunContribution={runId:newRunArtifact.sha256,sourceArtifactKind:'native_extraction_output',pins:newPins,artifacts:{extractionRun:newRunArtifact,records:artifact({schemaVersion:'stadtstack-knowledge-v2',generatedAt:later,records:[newRecord]}),quarantine:artifact({schemaVersion:'stadtstack-quarantine-v1',generatedAt:later,cases:[]}),crawl:artifact(newIndex),registry:artifact(newerRegistry),preparationPlan:artifact(newPreparation)}};
 const lineage=buildTextRunLineage([oldContribution,newContribution],[{runId:newContribution.runId,recordId:newRecord.id,originalEvidenceHash:newRecord.verification.evidenceHash,projectedRecord:newRecord}],later);
 const coverage=buildDistrictCoverage(newerRegistry,{schemaVersion:'stadtstack-crawl-index-v1',generatedAt:later,documents:[...oldIndex.documents,newDocument],checks:[],excludedDocuments:[excludedDocument]},[retainedRecord,newRecord],{schemaVersion:'stadtstack-quarantine-v1',generatedAt:later,cases:[...oldResult.quarantine,hold]},lineage,later,undefined,retainedPublication);
 const releasePaths=['catalogue.json','quality-report.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json','regions/brandenburg-mol/topics.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json','knowledge/graph.json','knowledge/changes.json','knowledge/publication-inputs.json','knowledge/assessment-admissions.json'];
 for(const path of releasePaths){await mkdir(dirname(join(releaseRoot,path)),{recursive:true});await writeFile(join(releaseRoot,path),'{}\n');}
 await writeFile(join(releaseRoot,'knowledge/registry.json'),artifact(newerRegistry).bytes);await writeFile(join(releaseRoot,'knowledge/records.json'),artifact({schemaVersion:'stadtstack-knowledge-v3',generatedAt:later,records:[retainedRecord,newRecord],identityAssertions:[],identityAdmissions:[]}).bytes);await writeFile(join(releaseRoot,'knowledge/coverage.json'),artifact(coverage).bytes);
 const release=await publishDataRelease(releaseRoot,releasePaths,{publishedRecords:2,quarantinedRecords:3,cities:1},later);
 const config:CorpusManifestOptions={releaseRoot,releaseManifestSha256:sha256(await readFile(join(releaseRoot,'release-manifest.json'))),generations:[{runId:oldContribution.runId,registryPin:oldRegistryPin,preparationPlan:oldPreparationPin,workPlan:oldPlanPin,resultRoot:oldResultRoot},{runId:newContribution.runId,registryPin:newRegistryPin,preparationPlan:newPreparationPin,workPlan:newPlanPin,resultRoot:newResultRoot}],indexes:[{name:'old-original',...oldIndexPin,runId:oldContribution.runId,rawRoot:oldRaw},{name:'old-cached',...cachedIndexPin,runId:oldContribution.runId,rawRoot:oldRaw},{name:'new-original',...newIndexPin,runId:newContribution.runId,rawRoot:newRaw}],out:join(root,'manifest.jsonl'),summaryOut:join(root,'summary.json'),policy};
 const verify=(summary:CorpusManifestSummary)=>verifyCorpusManifest({manifest:{path:config.out,sha256:summary.manifestSha256},indexes:config.indexes.map(({name,rawRoot})=>({name,rawRoot})),policy});
 return {root,policy,dispose:context.dispose,oldRaw,newRaw,config,verify,pin,sourcePin,oldBindings,newBindings,oldDocument,newDocument,cachedIndex,cachedIndexPin,oldPlan,newPlan,oldTask,newTask,oldResult,newResult,oldResultPin,newResultPin,oldNative,retainedRecord,newRecord,lineage,release,releasePaths,oldRunId:oldContribution.runId,newRunId:newContribution.runId,excludedDocument,retainedPublication,newerRegistry};
}

test('multigeneration inventory keeps historical native proof separate from a retained public baseline',async t=>{
 const f=await fixture();t.after(f.dispose);const originalBytes=await readFile(f.oldResultPin.path);
 assert.equal(DistrictKnowledgeRecordSchema.safeParse(f.oldNative).success,false,'Historical local graph IDs are deliberately inadmissible today');
 const summary=await buildCorpusManifest(f.config),verified=await f.verify(summary);
 assert.equal(summary.recordCount,9);assert.equal(summary.distinctBodies,5);assert.equal(summary.verifiedBodyCopies,7);assert.equal(summary.skippedBodyVerifications,1);assert.equal(summary.boundObservations,6);assert.equal(summary.releasedCitations,1);assert.equal(summary.retainedPublishedRecords,1);
 assert.deepEqual(await readFile(f.oldResultPin.path),originalBytes);assert.equal(sha256(originalBytes),f.oldTask.resultSha256);
 const original=verified.records.find(row=>row.url===url&&row.checkedAt===at)!,old=original.processing.find(item=>item.runId===f.oldRunId)!,newer=original.processing.find(item=>item.runId===f.newRunId)!;
 assert.equal(original.memberships.length,3);assert.equal(original.http.etag,'"historical"');assert.equal(original.http.observationId,'historical.json');assert.equal(old.status,'completed');assert.equal(old.published.basis,null);assert.equal(old.nativeStatus,'completed');assert.deepEqual(old.chunkCounts,{admitted:1,rejected:1,no_case:1,quarantined:2});assert.equal(newer.status,'not_selected');
 const origin=verified.inputs.retainedPublication!.selectedRecordOrigins.find(item=>item.recordId===f.retainedRecord.id)!;
 assert.notEqual(origin.originalRecordSha256,textLineageRecordSha256(f.oldNative),'Retained reassessment is not relabelled as original native output');assert.equal(verified.inputs.textLineage!.selectedRecordOrigins.some(item=>item.recordId===f.retainedRecord.id),false);
 const fresh=verified.records.find(row=>row.sha256===newHash)!;assert.equal(fresh.processing.find(item=>item.runId===f.oldRunId)!.status,'outside_original_corpus');assert.equal(fresh.processing.find(item=>item.runId===f.newRunId)!.status,'native_published');assert.equal(fresh.releasedRecords[0].basis,'original_native_result_and_sealed_release_lineage');
 const alias=verified.records.find(row=>row.url.endsWith('/alias'))!;assert.equal(alias.processing.find(item=>item.runId===f.oldRunId)!.status,'reference_excluded');assert.equal(alias.processing.find(item=>item.runId===f.oldRunId)!.referenceIncluded,false);assert.deepEqual(alias.releasedRecords,[]);
 assert.equal(verified.records.find(row=>row.url.endsWith('/additional-alias'))!.processing.find(item=>item.runId===f.oldRunId)!.status,'outside_original_corpus');
 for(const [suffix,status] of [['pending','pending'],['held','preparation_hold'],['unselected','not_selected']])assert.equal(verified.records.find(row=>row.url.endsWith('/'+suffix))!.processing.find(item=>item.runId===f.oldRunId)!.status,status);
 const excluded=verified.records.find(row=>row.bodyState==='excluded')!;assert.ok(excluded.processing.every(item=>item.status==='source_excluded'&&!item.referenceIncluded));assert.deepEqual(excluded.releasedRecords,[]);await assert.rejects(readFile(join(f.newRaw,'sha256',excluded.sha256)),{code:'ENOENT'});
 assert.equal(verified.inputs.indexes.find(index=>index.name==='old-cached')!.role,'additional_inventory');assert.notEqual(verified.inputs.generations[0].registrySha256,verified.inputs.generations[1].registrySha256);
 const encoded=await readFile(f.config.out,'utf8');assert.equal(JSON.parse(encoded.split('\n')[0]).schemaVersion,'stadtstack-corpus-manifest-header-v3');
 for(const privateValue of [text,'PRIVATE-','/old/private',f.root])assert.equal(encoded.includes(privateValue),false);
 const repeat={...f.config,generations:[...f.config.generations].reverse(),indexes:[...f.config.indexes].reverse(),out:join(f.root,'repeat.jsonl'),summaryOut:join(f.root,'repeat-summary.json')};await buildCorpusManifest(repeat);assert.equal(await readFile(repeat.out,'utf8'),encoded);
});

test('retained-only public inventory needs no raw root, model result or invented generation',async t=>{
 const f=await fixture();t.after(f.dispose);
 const coverage=buildDistrictCoverage(f.newerRegistry,{schemaVersion:'stadtstack-crawl-index-v1',generatedAt:later,documents:[],checks:[]},[f.retainedRecord],{schemaVersion:'stadtstack-quarantine-v1',generatedAt:later,cases:[]},null,later,undefined,f.retainedPublication);
 await writeFile(join(f.config.releaseRoot,'knowledge/records.json'),artifact({schemaVersion:'stadtstack-knowledge-v3',generatedAt:later,records:[f.retainedRecord],identityAssertions:[],identityAdmissions:[]}).bytes);
 await writeFile(join(f.config.releaseRoot,'knowledge/coverage.json'),artifact(coverage).bytes);
 await publishDataRelease(f.config.releaseRoot,f.releasePaths,{publishedRecords:1,quarantinedRecords:0,cities:1},later);
 await rm(f.oldRaw,{recursive:true});await rm(f.newRaw,{recursive:true});await rm(dirname(f.oldResultPin.path),{recursive:true});await rm(dirname(f.newResultPin.path),{recursive:true});
 const config={...f.config,generations:[],indexes:[],releaseManifestSha256:sha256(await readFile(join(f.config.releaseRoot,'release-manifest.json')))};
 const summary=await buildCorpusManifest(config);
 const verified=await verifyCorpusManifest({manifest:{path:config.out,sha256:summary.manifestSha256},indexes:[],policy:f.policy});
 assert.equal(summary.recordCount,0);assert.equal(summary.distinctBodies,0);assert.equal(summary.releasedCitations,0);assert.equal(summary.retainedPublishedRecords,1);
 assert.deepEqual(verified.records,[]);assert.deepEqual(verified.inputs.generations,[]);assert.deepEqual(verified.inputs.indexes,[]);assert.equal(verified.inputs.textLineage,null);
 assert.equal(verified.inputs.inventoryScope,'supplied_text_run_corpora_only');
 assert.equal(verified.inputs.retainedPublication!.selectedRecordOrigins[0].originalEvidenceHash,f.retainedRecord.verification.evidenceHash);
 const metadata=JSON.parse((await readFile(config.out,'utf8')).trim());
 metadata.inputs.retainedPublication.selectedRecordOrigins[0].currentEvidenceHash=sha256('tampered retained evidence');
 assert.throws(()=>parseManifestJsonl(Buffer.from(JSON.stringify(metadata)+'\n')),/retained|hash|evidence/i);
});

test('missing old raw root never falls back to identical bytes in the new lane',async t=>{
 const f=await fixture();t.after(f.dispose);const summary=await buildCorpusManifest(f.config);await rm(f.oldRaw,{recursive:true});
 assert.equal(sha256(await readFile(join(f.newRaw,'sha256',sourceHash))),sourceHash);
 await assert.rejects(f.verify(summary));await assert.rejects(buildCorpusManifest({...f.config,out:join(f.root,'missing.jsonl')}));
});

test('all generations require their original corpus even when additional inventories contain the same source',async t=>{
 const f=await fixture();t.after(f.dispose);
 await assert.rejects(buildCorpusManifest({...f.config,indexes:f.config.indexes.filter(index=>index.name!=='old-original')}),/Original run corpus is missing/);
 await assert.rejects(buildCorpusManifest({...f.config,generations:[f.config.generations[1]]}),/every original text generation/);
 const summary=await buildCorpusManifest(f.config);
 await assert.rejects(verifyCorpusManifest({manifest:{path:f.config.out,sha256:summary.manifestSha256},indexes:[{name:'new-original',rawRoot:f.newRaw}],policy:f.policy}),/Every named index/);
});

test('missing or changed body, task, index, observation and release pins fail closed',async t=>{
 for(const target of ['body','task','index','observation','release'] as const){
  const f=await fixture();t.after(f.dispose);const summary=await buildCorpusManifest(f.config);
  const path=target==='body'?join(f.oldRaw,'sha256',sourceHash):target==='task'?f.oldResultPin.path:target==='index'?f.cachedIndexPin.path:target==='observation'?join(f.oldRaw,'observations/historical.json'):join(f.config.releaseRoot,'catalogue.json');
  await writeFile(path,'corrupted synthetic artifact',{mode:0o600});
  if(target==='body'||target==='observation')await assert.rejects(f.verify(summary));
  await assert.rejects(buildCorpusManifest({...f.config,out:join(f.root,'corrupt.jsonl'),summaryOut:join(f.root,'corrupt-summary.json')}));
 }
});

test('immutable observation names remain explicit and cannot be replaced by mutable pointers or other roots',async t=>{
 const f=await fixture();t.after(f.dispose);const summary=await buildCorpusManifest(f.config),path=join(f.oldRaw,'observations/historical.json'),bytes=await readFile(path);await rm(path);
 await writeFile(join(f.oldRaw,'observations/another-name.json'),bytes,{mode:0o600});await assert.rejects(f.verify(summary));
 await writeFile(path,bytes,{mode:0o600});assert.equal((await f.verify(summary)).manifestSha256,summary.manifestSha256);
 await assert.rejects(verifyCorpusManifest({manifest:{path:f.config.out,sha256:sha256('untrusted')},indexes:f.config.indexes.map(({name,rawRoot})=>({name,rawRoot})),policy:f.policy}),/Pinned manifest hash mismatch/);
});

test('source and observation symlinks cannot escape a declared lane',async t=>{
 for(const kind of ['body','observation'] as const){const f=await fixture();t.after(f.dispose);const path=kind==='body'?join(f.oldRaw,'sha256',sourceHash):join(f.oldRaw,'observations/historical.json'),outside=join(f.root,'outside-'+kind);await writeFile(outside,await readFile(path));await rm(path);await symlink(outside,path);await assert.rejects(buildCorpusManifest(f.config),/escapes|CONTENT|SOURCE|ROOT|CIVIC/);}
});

test('additional inventory keeps missing historical HTTP evidence explicit without inventing a request',async t=>{
 for(const kind of ['no-index-evidence','unsafe-path','missing-observation','mismatch'] as const){
  const f=await fixture();t.after(f.dispose);const changed=structuredClone(f.cachedIndex),document=changed.documents.find(doc=>doc.status===304)!;
  if(kind==='no-index-evidence')Reflect.deleteProperty(document,'status');
  if(kind==='unsafe-path')document.observationPath='/old/observations/../requests/current.json';
  if(kind==='missing-observation')document.observationPath='/old/observations/not-present.json';
  if(kind==='mismatch')document.status=200;
  const pin=await f.sourcePin('old-cached.json',changed,f.oldBindings);Object.assign(f.config.indexes.find(index=>index.name==='old-cached')!,pin);
  const verified=await f.verify(await buildCorpusManifest(f.config)),row=verified.records.find(row=>row.url===url&&row.checkedAt===later)!;
  assert.equal(row.http.status,null);assert.equal(row.http.etag,null);assert.equal(row.http.missingReason,kind==='no-index-evidence'?'index_evidence_missing':kind==='unsafe-path'?'unsafe_observation_path':kind==='missing-observation'?'observation_missing':'observation_mismatch');
 }
});

test('original task envelope and chunk receipts remain binding even without current graph decoding',async t=>{
 for(const change of ['task','source','chunk','prompt','evidence'] as const){
  const f=await fixture();t.after(f.dispose);const result=structuredClone(f.oldResult);
  if(change==='task')result.taskId=sha256('another task');
  if(change==='source')result.records[0].sources[0].url='https://example.org/not-prepared';
  if(change==='chunk')result.chunks[0].responseSha256=sha256('forged response');
  if(change==='prompt')result.records[0].extraction.promptSha256=sha256('different prompt');
  if(change==='evidence')result.records[0].verification.evidenceHash=sha256('wrong evidence');
  if(change==='source'||change==='prompt')result.records[0].verification.evidenceHash=knowledgeEvidenceHash(result.records[0]);
  const pin=await f.sourcePin('old-results/'+f.oldTask.id+'.json',result,f.oldBindings);f.oldTask.resultSha256=pin.sha256;f.config.generations.find(generation=>generation.runId===f.oldRunId)!.workPlan=await f.pin('old-plan.json',f.oldPlan);
  await assert.rejects(buildCorpusManifest(f.config),/binding|mismatch/);
 }
});

test('retained origin attestation never excuses a changed native result file',async t=>{
 const f=await fixture();t.after(f.dispose);await writeFile(f.oldResultPin.path,'{}',{mode:0o600});await assert.rejects(buildCorpusManifest(f.config));
});

test('manifest parsing is strict and public metadata cannot forge generation or membership identities',async t=>{
 const f=await fixture();t.after(f.dispose);await buildCorpusManifest(f.config);const encoded=await readFile(f.config.out,'utf8'),lines=encoded.trimEnd().split('\n'),parsed=parseManifestJsonl(Buffer.from(encoded)),row=parsed.records[0];
 assert.equal(CorpusManifestRecordSchema.safeParse({...row,body:'private text'}).success,false);assert.equal(CorpusManifestRecordSchema.safeParse({...row,casPath:'/private/source'}).success,false);
 for(const value of ['',encoded+'\n','\n'+encoded,[lines[0],'{broken',...lines.slice(1)].join('\n'),[lines[0],lines[0],...lines.slice(1)].join('\n'),lines.slice(1).join('\n'),JSON.stringify({...JSON.parse(lines[0]),schemaVersion:'stadtstack-corpus-manifest-header-v2'})+'\n'+lines.slice(1).join('\n')])assert.throws(()=>parseManifestJsonl(Buffer.from(value)));
 const forged=structuredClone(parsed);forged.records[0].memberships[0].indexSha256=sha256('wrong membership');assert.throws(()=>parseManifestJsonl(Buffer.from([JSON.stringify({schemaVersion:'stadtstack-corpus-manifest-header-v3',type:'metadata',inputs:forged.inputs}),...forged.records.map(record=>JSON.stringify(record))].join('\n')+'\n')),/membership/);
 assert.equal(parseManifestJsonl(Buffer.from(encoded.slice(0,-1))).records.length,parsed.records.length);
});

test('owner exclusion audit cannot be relabelled official or attach published/model admission',async t=>{
 const f=await fixture();t.after(f.dispose);const verified=await f.verify(await buildCorpusManifest(f.config)),row=verified.records.find(record=>record.bodyState==='excluded')!;
 assert.equal(row.robotsStatus,'disallowed');assert.equal(row.override,'owner-approved 2026-10-11');assert.equal(row.observedPermission,'not_permitted');
 for(const change of [{documentOrigin:{...row.documentOrigin,classification:'official_work'}},{casPath:'sha256/'+row.sha256},{robotsStatus:'allowed'},{ownerRobotsOverride:{...row.ownerRobotsOverride,host:'other.example.org'}},{processing:row.processing.map(item=>({...item,referenceIncluded:true}))}])assert.equal(CorpusManifestRecordSchema.safeParse({...row,...change}).success,false);
});

test('current authority and opt-out apply to historical verification without new enrollment or cache fallback',async t=>{
 const f=await fixture();t.after(f.dispose);const summary=await buildCorpusManifest(f.config);await recordHostOptOut({host:'example.org',reason:'municipality_objection'},f.policy);
 await assert.rejects(f.verify(summary));await assert.rejects(buildCorpusManifest({...f.config,out:join(f.root,'after-objection.jsonl')}));
 const other=await createCivicPolicyTestContext();t.after(other.dispose);
 await assert.rejects(verifyCorpusManifest({manifest:{path:f.config.out,sha256:summary.manifestSha256},indexes:f.config.indexes.map(({name,rawRoot})=>({name,rawRoot})),policy:other.policy}),/authority binding/);
});
