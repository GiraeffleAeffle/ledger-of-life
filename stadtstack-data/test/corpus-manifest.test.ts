import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {buildCorpusManifest,verifyCorpusManifest,CorpusManifestRecordSchema,type CorpusManifestOptions} from '../src/corpus-manifest.ts';
import {sha256,knowledgeEvidenceHash,DistrictKnowledgeRecordSchema,type DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {districtRegistrySchema} from '../src/district-registry.ts';
import {ownerRobotsOverrideFor} from '../src/source-policy.ts';
import {createWorkPlan} from '../src/district-work-plan.ts';
import {documentResultSchema} from '../src/district-inference.ts';
import {deterministicChecks} from '../src/district-claims.ts';
import {PROVIDER_CONFIGS} from '../src/district-model-contract.ts';
import {publishDataRelease} from '../src/data-release.ts';

// Synthetic fixtures only: no civic statements, model calls, network or real caches.
const at='2026-10-10T12:00:00.000Z',later='2026-10-11T12:00:00.000Z';
const text='Stadt Beispielstadt\nWärmeplanung\nDer Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.\nStand: 10.10.2026';
const sourceHash=sha256(text),url='https://example.org/document';
const policy={robots:{state:'allowed' as const,url:'https://example.org/robots.txt'},tdm:{state:'not_declared' as const,evidence:[]},access:'public' as const,legalClassification:'not_assessed' as const,publication:'facts_with_attribution_only' as const};
const municipality={id:'strausberg',name:'Beispielstadt',ags:'12064001',districtId:'unit-district'};
const registry=districtRegistrySchema.parse({schemaVersion:'stadtstack-source-registry-v1',generatedAt:at,
 districts:[{id:'unit-district',name:'Synthetic district',ags:'12064',state:'Brandenburg',inventorySources:[{url:'https://example.org/inventory',locator:'synthetic'}],inventoryAsOf:'2026-10-10',inventoryComplete:true}],
 municipalities:[{...municipality,districtAgs:'12064',amt:null,administrativeStatus:'amtsfrei',administrativeEvidence:[{url:'https://example.org/identity',locator:'synthetic'}],identitySources:[{url:'https://example.org/identity',locator:'synthetic',sha256:sha256('identity'),retrievedAt:at}],
  sources:['council','participation','gazette','website'].map(kind=>({id:'unit-'+kind,kind,url:'https://example.org/'+kind,vendor:'unknown',checkState:'checked',checkedAt:at,evidence:[{url:'https://example.org/'+kind,locator:'synthetic'}]})),
  seedDocuments:[{url,sourceId:'unit-website',title:'Synthetic source',documentDate:'2026-10-10',evidence:[{url,locator:'synthetic'}]}]}],
 inventory:[{ags:municipality.ags,name:municipality.name,districtId:municipality.districtId,identitySourceUrl:'https://example.org/identity',pilot:true,sourceCheckState:'checked',reason:'Synthetic fixture'}],notes:[]});
const reference={id:'unit-website',url,sha256:sourceHash,retrievedAt:at,locator:`document-sha256:${sourceHash}`,mimeType:'text/plain',sourceType:'website',policy};
function knowledgeRecord():DistrictKnowledgeRecord{
 const claims={title:'Wärmeplanung',titleQuote:'Wärmeplanung',summary:'Der Entwurf der Wärmeplanung wurde veröffentlicht.',summaryQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',municipalityQuote:'Stadt Beispielstadt',caseKey:null,caseKeyType:'source_document' as const,caseQuote:null,caseType:'planning' as const,documentDate:'2026-10-10',documentDateQuote:'Stand: 10.10.2026',documentDateReason:null,topics:[{id:'waermeplanung',parentId:'energie',provenance:'model' as const,confidence:0.9,quote:'Wärmeplanung'}],stage:'draft' as const,stageDate:'2026-10-09',stageDateQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stageDateReason:null,originalStatus:'Entwurf',stageQuote:'Der Entwurf der Wärmeplanung wurde am 09.10.2026 veröffentlicht.',stages:[],entities:[],relations:[],locations:[]};
 const config=PROVIDER_CONFIGS['openai-subscription'];
 const value={...claims,id:'knowledge:synthetic',municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,caseKey:`source_document:${sourceHash}`,sources:[{...reference,locator:`text-sha256:${sourceHash};chars:0-${text.length}`}],
  extraction:{extractorVersion:'synthetic-test',extractorSha256:sha256('extractor'),model:config.model,provider:'openai-subscription',tool:config.tool,toolVersion:'synthetic-test',modelIdentitySha256:sha256('synthetic-model'),modelIdentityBasis:config.modelIdentityBasis,returnedModel:null,promptVersion:'synthetic-test',promptSha256:sha256('prompt'),judgePromptVersion:'synthetic-test',judgePromptSha256:sha256('judge'),inputSha256:sourceHash,textSha256:sourceHash,responseSha256:sha256('answer'),ocrUsed:false,textMethod:'text',cacheKey:sha256('cache'),extractedAt:at,chunk:{index:0,count:3,start:0,end:text.length}},
  verification:{status:'auto-verified',deterministic:deterministicChecks(claims,text,municipality.name),faithfulness:{score:0.9,threshold:0.8,model:config.model,provider:'openai-subscription',tool:config.tool,toolVersion:'synthetic-test',modelIdentitySha256:sha256('synthetic-model'),returnedModel:null,reason:'Synthetic test, not model evidence',evaluatedAt:at,responseSha256:sha256('judge-answer'),sameModel:true,limitation:'Same-model judgment is not independent verification.'},evidenceHash:''}};
 value.verification.evidenceHash=knowledgeEvidenceHash(value);return DistrictKnowledgeRecordSchema.parse(value);
}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'stadtstack-corpus-manifest-')),rawRoot=join(root,'raw'),releaseRoot=join(root,'release'),resultRoot=join(root,'results');
 for(const path of [join(rawRoot,'sha256'),join(rawRoot,'observations'),join(rawRoot,'requests'),releaseRoot,resultRoot])await mkdir(path,{recursive:true});
 const pin=async(name:string,value:unknown)=>{const path=join(root,name),bytes=JSON.stringify(value,null,2)+'\n';await writeFile(path,bytes);return {path,sha256:sha256(bytes)};};
 await writeFile(join(rawRoot,'sha256',sourceHash),text);
 const newerHash=sha256('Synthetic newer source bytes');await writeFile(join(rawRoot,'sha256',newerHash),'Synthetic newer source bytes');
 const pendingHash=sha256('Synthetic pending body');await writeFile(join(rawRoot,'sha256',pendingHash),'Synthetic pending body');
 const heldHash=sha256('Synthetic preparation hold');await writeFile(join(rawRoot,'sha256',heldHash),'Synthetic preparation hold');
 const unselectedHash=sha256('Synthetic unselected body');await writeFile(join(rawRoot,'sha256',unselectedHash),'Synthetic unselected body');
 const observation={url,method:'GET',checkedAt:at,retrievedAt:at,state:'fetched',status:200,sha256:sourceHash,bytes:Buffer.byteLength(text),mimeType:'text/plain',etag:'"historical"',lastModified:'Fri, 09 Oct 2026 12:00:00 GMT',headers:{authorization:'PRIVATE-HEADER-MUST-NOT-EXPORT'}};
 await writeFile(join(rawRoot,'observations','historical.json'),JSON.stringify(observation)+'\n');
 await writeFile(join(rawRoot,'observations','revalidated.json'),JSON.stringify({...observation,checkedAt:later,state:'not_modified',status:304,etag:'"revalidated"'})+'\n');
 await writeFile(join(rawRoot,'requests','mutable.json'),JSON.stringify({...observation,etag:'"MUTABLE-NOT-EVIDENCE"'}));
 const document={id:'document-synthetic',municipalityId:municipality.id,ags:municipality.ags,districtId:municipality.districtId,sourceId:'unit-website',url,sha256:sourceHash,mimeType:'text/plain',retrievedAt:at,documentDate:'2026-10-10',localPath:'/old/private/sha256/'+sourceHash,adapter:'synthetic',metadata:{title:'PRIVATE-SOURCE-SNIPPET'},policy,checkedAt:at,status:200,observationPath:'/old/private/observations/historical.json'};
 const excluded={...document,id:'document-excluded',sourceId:'unit-council',url:'https://example.org/excluded',observationPath:'/old/private/observations/missing.json'};
 const pending={...document,id:'document-pending',sha256:pendingHash,url:'https://example.org/pending',observationPath:undefined};
 const held={...document,id:'document-held',sha256:heldHash,url:'https://example.org/held',observationPath:undefined};
 const unselected={...document,id:'document-unselected',sha256:unselectedHash,url:'https://example.org/unselected',observationPath:undefined};
 const baseline=await pin('baseline.json',{schemaVersion:'stadtstack-crawl-index-v1',documents:[document,excluded,pending,held,unselected]});
 const cached=await pin('cached.json',{schemaVersion:'stadtstack-crawl-index-v1',documents:[document,{...document,sha256:newerHash,retrievedAt:later,checkedAt:later,observationPath:undefined},{...document,checkedAt:later,status:304,observationPath:'/old/private/observations/revalidated.json'}]});
 const pinnedRegistry=await pin('registry.json',registry),extractorSha256=sha256('synthetic-text-extractor');
 const group={municipality,documentIds:[document.id,excluded.id],expected:{receiptSha256:sha256('receipt'),municipalityId:municipality.id,sourceSha256:sourceHash,extractorSha256,references:[reference],toolVersions:{node:'synthetic'}},referenceWarnings:[{documentId:excluded.id,sourceId:excluded.sourceId,reason:'PRIVATE-REJECTION-DETAIL'}]};
 const pendingGroup={municipality,documentIds:[pending.id],expected:{...group.expected,receiptSha256:sha256('pending-receipt'),sourceSha256:pendingHash,references:[{...reference,url:pending.url,sha256:pendingHash,locator:`document-sha256:${pendingHash}`}]},referenceWarnings:[]};
 const preparation={schemaVersion:'stadtstack-preparation-plan-v1',generatedAt:at,corpusSha256:baseline.sha256,registrySha256:pinnedRegistry.sha256,extractorSha256,maxDocumentsPerMunicipality:3,availableDocumentGroups:4,selectedDocumentGroups:3,selectedRepresentations:4,municipalities:[{...municipality,availableDocumentGroups:4,selectedDocumentGroups:3,selectedRepresentations:4}],groups:[group,pendingGroup],quarantine:[{documentId:held.id,municipalityId:municipality.id,sourceId:held.sourceId,sourceSha256:heldHash,chunk:null,reason:'PRIVATE-PREPARATION-DETAIL'}]};
 const plan=createWorkPlan([group,pendingGroup].map(item=>({municipalityId:municipality.id,sourceSha256:item.expected.sourceSha256,preparedSha256:item.expected.receiptSha256})),{promptSha256:sha256('joint-prompt'),schemaSha256:sha256('schema'),extractorSha256:sha256('extractor')},'codex-only');
 const task=plan.tasks.find(item=>item.group.sourceSha256===sourceHash)!,record=knowledgeRecord();
 const result=documentResultSchema.parse({schemaVersion:'stadtstack-document-result-v2',taskId:task.id,groupId:task.groupId,provider:task.provider,purpose:'production',municipalityId:municipality.id,sourceSha256:sourceHash,preparedSha256:group.expected.receiptSha256,promptSha256:plan.promptSha256,schemaSha256:plan.schemaSha256,generatedAt:at,records:[record],quarantine:[{documentId:document.id,municipalityId:municipality.id,sourceId:document.sourceId,sourceSha256:sourceHash,chunk:1,reason:'PRIVATE-REJECTED-ANSWER'},{documentId:document.id,municipalityId:municipality.id,sourceId:document.sourceId,sourceSha256:sourceHash,chunk:2,reason:'No supported case'}],chunks:[{index:0,outcome:'admitted',responseSha256:record.extraction.responseSha256,recordId:record.id},{index:1,outcome:'rejected',responseSha256:sha256('rejected'),recordId:null},{index:2,outcome:'no_case',responseSha256:sha256('no-case'),recordId:null}]});
 const resultBytes=JSON.stringify(result)+'\n';await writeFile(join(resultRoot,task.id+'.json'),resultBytes);task.state='completed';task.attempts=1;task.resultSha256=sha256(resultBytes);
 const preparationPin=await pin('preparation.json',preparation),workPlanPin=await pin('work-plan.json',plan);
 const releasePaths=['catalogue.json','quality-report.json','core/strausberg-facts.json','core/release-manifest.json','core/handover-draft.json','regions/brandenburg-mol/topics.json','knowledge/registry.json','knowledge/records.json','knowledge/coverage.json','knowledge/graph.json'];
 for(const path of releasePaths){await mkdir(dirname(join(releaseRoot,path)),{recursive:true});await writeFile(join(releaseRoot,path),'{}\n');}
 await writeFile(join(releaseRoot,'knowledge/registry.json'),JSON.stringify(registry)+'\n');
 await writeFile(join(releaseRoot,'knowledge/records.json'),JSON.stringify({schemaVersion:'stadtstack-knowledge-v2',generatedAt:later,records:[record]})+'\n');
 await writeFile(join(releaseRoot,'knowledge/coverage.json'),JSON.stringify({extractionRun:{corpusSha256:baseline.sha256,registrySha256:pinnedRegistry.sha256,promptContractSha256:plan.promptSha256,schemaSha256:plan.schemaSha256}})+'\n');
 const release=await publishDataRelease(releaseRoot,releasePaths,{publishedRecords:1,quarantinedRecords:2,cities:1},later);
 const config:CorpusManifestOptions={indexes:[{name:'baseline',...baseline},{name:'cached',...cached}],registry:pinnedRegistry,rawRoot,preparationPlan:preparationPin,workPlan:workPlanPin,resultRoot,releaseRoot,out:join(root,'corpus-manifest.jsonl'),summaryOut:join(root,'summary.json')};
 return {root,rawRoot,config,document,baseline,cached,observation,result,task,plan,preparation,release,releasePaths,pin,record};
}

test('hash-pinned union preserves versions, observation contexts and exact citations without private bodies',async()=>{
 const f=await fixture();try{
  assert.notEqual(f.preparation.extractorSha256,f.plan.extractorSha256);
  const summary=await buildCorpusManifest(f.config),verified=await verifyCorpusManifest(f.config.out,f.rawRoot);
  assert.equal(summary.manifestSha256,verified.manifestSha256);assert.equal(summary.recordCount,7);assert.equal(summary.distinctBodies,5);
  assert.equal(summary.boundObservations,2);assert.equal(summary.releasedCitations,1);
  const original=verified.records.find(row=>row.url===url&&row.checkedAt===at)!;
  assert.deepEqual(original.memberships.map(item=>item.name),['baseline','cached']);assert.equal(original.fetchedAt,at);assert.equal(original.http.etag,'"historical"');assert.equal(original.http.status,200);
  assert.equal(original.sizeBytes,Buffer.byteLength(text));assert.equal(original.casPath,'sha256/'+sourceHash);
  assert.deepEqual(original.extraction.chunkCounts,{admitted:1,rejected:1,no_case:1,quarantined:2});assert.equal(original.extraction.status,'completed');
  assert.deepEqual(original.releasedRecords,[{id:f.record.id,releaseId:f.release.id,sourceLocator:f.record.sources[0].locator,evidenceHash:f.record.verification.evidenceHash}]);
  const revalidated=verified.records.find(row=>row.http.status===304)!;assert.equal(revalidated.fetchedAt,at);assert.equal(revalidated.checkedAt,later);assert.equal(revalidated.http.observationState,'not_modified');
  const excluded=verified.records.find(row=>row.sourceId==='unit-council')!;
  assert.equal(excluded.extraction.status,'reference_excluded');assert.equal(excluded.extraction.referenceIncluded,false);assert.deepEqual(excluded.releasedRecords,[]);assert.equal(excluded.http.status,null);assert.equal(excluded.http.missingReason,'observation_missing');
  assert.equal(verified.records.find(row=>row.url.endsWith('/pending'))!.extraction.status,'pending');
  assert.equal(verified.records.find(row=>row.url.endsWith('/held'))!.extraction.status,'preparation_hold');
  assert.equal(verified.records.find(row=>row.url.endsWith('/unselected'))!.extraction.status,'not_selected');
  const encoded=await readFile(f.config.out,'utf8');
  const lines=encoded.trimEnd().split('\n'),header=JSON.parse(lines[0]);
  assert.deepEqual(header,{schemaVersion:'stadtstack-corpus-manifest-header-v2',type:'metadata',inputs:verified.inputs});
  assert.equal(lines.length,verified.recordCount+1);
  for(const line of lines.slice(1))assert.equal(CorpusManifestRecordSchema.safeParse(JSON.parse(line)).success,true);
  for(const privateValue of [text,'PRIVATE-','MUTABLE-NOT-EVIDENCE','/old/private',f.root,'authorization'])assert.equal(encoded.includes(privateValue),false);
  const next={...f.config,indexes:[...f.config.indexes].reverse(),out:join(f.root,'again.jsonl'),summaryOut:join(f.root,'again-summary.json')};
  await buildCorpusManifest(next);assert.equal(await readFile(next.out,'utf8'),encoded);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('HTTP metadata is null on historical mismatch, absent index fields, and unsafe observation paths',async()=>{
 for(const change of ['mismatch','no-index-evidence','unsafe-path'] as const){
  const f=await fixture();try{
   const index=JSON.parse(await readFile(f.baseline.path,'utf8'));
   // Keep the production source membership, but remove the cached duplicate so this context is unambiguous.
   f.config.indexes=f.config.indexes.filter(item=>item.name==='baseline');
   if(change==='mismatch')await writeFile(join(f.rawRoot,'observations','historical.json'),JSON.stringify({...f.observation,sha256:sha256('other')}));
   if(change==='no-index-evidence')delete index.documents[0].status;
   if(change==='unsafe-path')index.documents[0].observationPath='/old/observations/../requests/mutable.json';
   const pin=await f.pin('baseline.json',index);f.config.indexes=[{name:'baseline',...pin}];
   f.preparation.corpusSha256=pin.sha256;f.config.preparationPlan=await f.pin('preparation.json',f.preparation);
   const coveragePath=join(f.config.releaseRoot,'knowledge/coverage.json'),coverage=JSON.parse(await readFile(coveragePath,'utf8'));coverage.extractionRun.corpusSha256=pin.sha256;await writeFile(coveragePath,JSON.stringify(coverage));
   await publishDataRelease(f.config.releaseRoot,f.releasePaths,{publishedRecords:1,quarantinedRecords:2,cities:1},later);
   await buildCorpusManifest(f.config);const verified=await verifyCorpusManifest(f.config.out,f.rawRoot),row=verified.records.find(row=>row.url===url)!;
   assert.equal(row.http.status,null);assert.equal(row.http.etag,null);assert.equal(row.http.lastModified,null);
   assert.equal(row.http.missingReason,change==='mismatch'?'observation_mismatch':change==='no-index-evidence'?'index_evidence_missing':'unsafe_observation_path');
  }finally{await rm(f.root,{recursive:true,force:true});}
 }
});

test('missing or altered CAS fails closed in both build and verification',async()=>{
 const f=await fixture();try{
  await buildCorpusManifest(f.config);await writeFile(join(f.rawRoot,'sha256',sourceHash),'tampered body');
  await assert.rejects(verifyCorpusManifest(f.config.out,f.rawRoot),/CAS body hash mismatch/);
  await assert.rejects(buildCorpusManifest({...f.config,out:join(f.root,'bad.json')}),/CAS body hash mismatch/);
  await rm(join(f.rawRoot,'sha256',sourceHash));await assert.rejects(verifyCorpusManifest(f.config.out,f.rawRoot));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('CAS and observation symlinks cannot escape the supplied raw root',async()=>{
 const f=await fixture();try{
  const outside=join(f.root,'outside');await writeFile(outside,text);await rm(join(f.rawRoot,'sha256',sourceHash));await symlink(outside,join(f.rawRoot,'sha256',sourceHash));
  await assert.rejects(buildCorpusManifest(f.config),/escapes its root/);
  await rm(join(f.rawRoot,'sha256',sourceHash));await writeFile(join(f.rawRoot,'sha256',sourceHash),text);
  await writeFile(outside,JSON.stringify(f.observation));await rm(join(f.rawRoot,'observations/historical.json'));await symlink(outside,join(f.rawRoot,'observations/historical.json'));
  await assert.rejects(buildCorpusManifest(f.config),/containment/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('verification requires bound historical observation bytes, never mutable request pointers',async()=>{
 const f=await fixture();try{
  await buildCorpusManifest(f.config);await rm(join(f.rawRoot,'observations/historical.json'));
  await assert.rejects(verifyCorpusManifest(f.config.out,f.rawRoot),/Bound historical observation missing/);
  await writeFile(join(f.rawRoot,'observations/relocated-name.json'),JSON.stringify(f.observation)+'\n');
  assert.equal((await verifyCorpusManifest(f.config.out,f.rawRoot)).recordCount,7);
  const lines=(await readFile(f.config.out,'utf8')).trimEnd().split('\n'),records=lines.slice(1).map(line=>JSON.parse(line)),bound=records.find(row=>row.http.status===200);
  bound.http.etag='"forged"';await writeFile(f.config.out,[lines[0],...records.map(record=>JSON.stringify(record))].join('\n')+'\n');
  await assert.rejects(verifyCorpusManifest(f.config.out,f.rawRoot),/Historical observation binding mismatch/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('pinned index, result, release and production run bindings reject corruption',async()=>{
 const f=await fixture();try{
  await assert.rejects(buildCorpusManifest({...f.config,indexes:[{...f.config.indexes[0],sha256:sha256('wrong')}]}),/Preparation input binding mismatch|Pinned input hash mismatch/);
  const resultPath=join(f.config.resultRoot,f.task.id+'.json'),saved=await readFile(resultPath);await writeFile(resultPath,'{}');
  await assert.rejects(buildCorpusManifest(f.config),/Pinned input hash mismatch/);await writeFile(resultPath,saved);
  f.result.purpose='agreement';const bytes=JSON.stringify(f.result);await writeFile(resultPath,bytes);f.task.resultSha256=sha256(bytes);f.config.workPlan=await f.pin('work-plan.json',f.plan);
  await assert.rejects(buildCorpusManifest(f.config),/source\/provider\/contract mismatch/);
  await writeFile(join(f.config.releaseRoot,'catalogue.json'),'corrupt');await assert.rejects(buildCorpusManifest(f.config),/Release file mismatch/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('unsafe URLs and missing exact released citation joins fail rather than publish a partial manifest',async()=>{
 for(const unsafe of [false,true]){
  const f=await fixture();try{
   const index=JSON.parse(await readFile(f.baseline.path,'utf8'));
   index.documents[0].url=unsafe?'https://example.org/document?token=PRIVATE-CREDENTIAL':'https://example.org/not-the-released-source';
   const pin=await f.pin('baseline.json',index);f.config.indexes=[{name:'baseline',...pin}];f.preparation.corpusSha256=pin.sha256;f.config.preparationPlan=await f.pin('preparation.json',f.preparation);
   const coveragePath=join(f.config.releaseRoot,'knowledge/coverage.json'),coverage=JSON.parse(await readFile(coveragePath,'utf8'));coverage.extractionRun.corpusSha256=pin.sha256;await writeFile(coveragePath,JSON.stringify(coverage));
   await publishDataRelease(f.config.releaseRoot,f.releasePaths,{publishedRecords:1,quarantinedRecords:2,cities:1},later);
   await assert.rejects(buildCorpusManifest(f.config),unsafe?/Unsafe public URL/:/Released source citation missing/);
  }finally{await rm(f.root,{recursive:true,force:true});}
 }
});

test('strict record schema rejects paths, unknown metadata, unbound validators and forged membership scopes',async()=>{
 const f=await fixture();try{
  await buildCorpusManifest(f.config);const lines=(await readFile(f.config.out,'utf8')).trimEnd().split('\n'),record=JSON.parse(lines[1]);
  assert.equal(CorpusManifestRecordSchema.safeParse({...record,casPath:'/workstation/private'}).success,false);
  assert.equal(CorpusManifestRecordSchema.safeParse({...record,body:'source body'}).success,false);
  assert.equal(CorpusManifestRecordSchema.safeParse({...record,http:{...record.http,bindingStatus:'missing',missingReason:'not_recorded',etag:'"invented"'}}).success,false);
  record.memberships[0].indexSha256=sha256('forged');lines[1]=JSON.stringify(record);await writeFile(f.config.out,lines.join('\n')+'\n');
  await assert.rejects(verifyCorpusManifest(f.config.out,f.rawRoot),/Index membership binding mismatch/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('JSONL rejects blank or malformed rows, missing or misplaced metadata, and obsolete envelopes',async()=>{
 const f=await fixture();try{
  await buildCorpusManifest(f.config);
  const encoded=await readFile(f.config.out,'utf8'),lines=encoded.trimEnd().split('\n');
  const header=JSON.parse(lines[0]),records=lines.slice(1).map(line=>JSON.parse(line));
  for(const malformed of [
   '', '\n', encoded+'\n', '\n'+encoded, [lines[0],' ',...lines.slice(1)].join('\n'),
   [lines[0],'{broken',...lines.slice(1)].join('\n'),
   [lines[0],lines[0],...lines.slice(1)].join('\n'),
   [...lines.slice(1),lines[0]].join('\n'),
   lines.slice(1).join('\n'),
   JSON.stringify({schemaVersion:'stadtstack-corpus-manifest-v2',inputs:header.inputs,records}),
  ]){
   await writeFile(f.config.out,malformed);
   await assert.rejects(verifyCorpusManifest(f.config.out,f.rawRoot));
  }
  await writeFile(f.config.out,encoded.slice(0,-1));
  assert.equal((await verifyCorpusManifest(f.config.out,f.rawRoot)).recordCount,records.length);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('manifest v2 exposes declaration evidence and rejects forged or unbound owner audit',async()=>{
 const f=await fixture();try{
  await buildCorpusManifest(f.config);const lines=(await readFile(f.config.out,'utf8')).trimEnd().split('\n'),record=JSON.parse(lines[1]);
  assert.ok(Object.hasOwn(record,'robots'));assert.ok(Object.hasOwn(record,'ownerRobotsOverride'));assert.equal(record.override,null);
  const target='https://strausberg.allris.cloud/document',decision=ownerRobotsOverrideFor(target)!;
  const bound={...record,url:target,documentOrigin:{classification:'official_work',method:'rules',classifierVersion:'document-origin-rules-v1',url:target,sha256:record.sha256,classifiedAt:at,evidence:[]},robots:{state:'blocked',url:'https://strausberg.allris.cloud/robots.txt',sha256:'a'.repeat(64),checkedAt:at},robotsStatus:'disallowed',override:'owner-approved 2026-10-11',ownerRobotsOverride:decision,http:{status:200,etag:null,lastModified:null,observationSha256:'b'.repeat(64),observationState:'fetched',bindingStatus:'bound',missingReason:null},checkedAt:at};
  assert.equal(CorpusManifestRecordSchema.safeParse(bound).success,true);
  for(const change of [
   {robots:{...bound.robots,state:'allowed'}},
   {robots:{...bound.robots,sha256:undefined}},
   {ownerRobotsOverride:{...decision,host:'other.stadt.de'}},
   {robotsStatus:'allowed'},
   {http:{...bound.http,status:null,observationState:null,bindingStatus:'missing',missingReason:'not_recorded'}},
   {schemaVersion:'stadtstack-corpus-manifest-v1'},
  ])assert.equal(CorpusManifestRecordSchema.safeParse({...bound,...change}).success,false);
  lines[0]=JSON.stringify({...JSON.parse(lines[0]),schemaVersion:'stadtstack-corpus-manifest-header-v1'});
  await writeFile(f.config.out,lines.join('\n')+'\n');await assert.rejects(verifyCorpusManifest(f.config.out,f.rawRoot));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('excluded manifest rows verify their tombstone observation, explicitly skipping absent raw bytes',async()=>{
 const f=await fixture();try{
  await buildCorpusManifest(f.config);const lines=(await readFile(f.config.out,'utf8')).trimEnd().split('\n'),base=JSON.parse(lines[1]);
  const target='https://stadt.de/excluded',sourceSha256=sha256('Excluded bytes are deliberately not retained'),decision=ownerRobotsOverrideFor(target)!;
  const documentOrigin={classification:'unknown',method:'rules',classifierVersion:'document-origin-rules-v1',url:target,sha256:sourceSha256,classifiedAt:later,evidence:[]};
  const robots={state:'blocked',url:'https://stadt.de/robots.txt',sha256:sha256('Synthetic actual robots denial'),checkedAt:later};
  const exclusion={reason:'non_official_restricted',excludedAt:later,previousManagedCopy:'not_managed'};
  const observedPolicy={robots,tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only',documentOrigin,ownerRobotsOverride:decision,override:'owner-approved 2026-10-11',robotsStatus:'disallowed'};
  const observation={url:target,method:'GET',checkedAt:later,retrievedAt:later,state:'excluded',status:200,sha256:sourceSha256,bytes:123,mimeType:'text/html',policy:observedPolicy,exclusion};
  const observationBytes=JSON.stringify(observation)+'\n';await writeFile(join(f.rawRoot,'observations','excluded.json'),observationBytes);
  const excluded={...base,id:sha256('excluded representation'),url:target,fetchedAt:later,checkedAt:later,sha256:sourceSha256,sizeBytes:123,contentType:'text/html',casPath:null,bodyState:'excluded',exclusion,robots,robotsStatus:'disallowed',override:'owner-approved 2026-10-11',ownerRobotsOverride:decision,documentOrigin,tdmState:'not_declared',tdmOverride:null,ownerTdmOverride:null,http:{status:200,etag:null,lastModified:null,observationSha256:sha256(observationBytes),observationState:'excluded',bindingStatus:'bound',missingReason:null},extraction:{...base.extraction,status:'source_excluded',preparationStatus:'not_selected',taskStates:[],chunkCounts:{admitted:0,rejected:0,no_case:0,quarantined:0},referenceIncluded:false},releasedRecords:[]};
  assert.equal(CorpusManifestRecordSchema.safeParse(excluded).success,true);
  await writeFile(f.config.out,[...lines,JSON.stringify(excluded)].join('\n')+'\n');
  const verified=await verifyCorpusManifest(f.config.out,f.rawRoot);assert.equal(verified.skippedBodyVerifications,1);assert.equal(verified.distinctBodies,5);assert.equal(verified.records.at(-1)?.bodyState,'excluded');
  await assert.rejects(readFile(join(f.rawRoot,'sha256',sourceSha256)),{code:'ENOENT'});
  await writeFile(join(f.rawRoot,'observations','excluded.json'),JSON.stringify({...observation,policy:{...observedPolicy,documentOrigin:{...documentOrigin,classification:'official_work'}}}));
  await assert.rejects(verifyCorpusManifest(f.config.out,f.rawRoot),/observation missing/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
