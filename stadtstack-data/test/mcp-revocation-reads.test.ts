import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {signal,sourceFrom,hash} from '../src/common.ts';
import {QueryIndex,type Regional,type KnowledgeQueryData} from '../src/mcp-query.ts';
import type {Catalogue,Signal} from '../src/schema.ts';
import type {CoreBundle} from '../src/core-schema.ts';
import {server} from '../src/mcp.ts';
import {prepareReleaseReadView,type ReleasedData} from '../src/mcp-release.ts';
import {GraphIndex} from '../src/district-graph-query.ts';
import {buildKnowledgeGraph} from '../src/district-graph.ts';
import {mcpSourceId,knowledgeSourceDescriptors} from '../src/mcp-source-identity.ts';
import {regionalRecordId,regionalSource,visibleChanges,visibleCore} from '../src/mcp-read-view.ts';
import {diff,signalChangeRecord,type Changes} from '../src/changes.ts';
import {knowledgeEvidenceHash,REQUIRED_DETERMINISTIC_CHECKS,type DistrictKnowledgeRecord} from '../src/district-schema.ts';
import type {RevocationTarget,VerifiedRevocations} from '../src/civic-revocations.ts';
import {verifiedMask} from './fixtures/revocations.ts';

const releaseId='a'.repeat(64),date='2026-10-10T12:00:00Z',city='strausberg';
function feature(id:string,host='allowed.example'):Signal {
 const bytes=new TextEncoder().encode(id);
 return signal({id:`test:${id}`,cityId:city,kind:'council_paper',category:'planning',title:`Solarpark Plan 68/23 ${id}`,statement:`Solarpark Plan 68/23 ${id}`,status:'draft',startDate:'2026-09-01',endDate:null,nextStep:'Source evidence',unknowns:[],scale:'city',geometryPrecision:'exact',sources:[sourceFrom({body:bytes,sha256:hash(bytes),retrievedAt:date,url:`https://${host}/${id}`},id,'Publisher',`Plan 68/23 ${id}`)],extraction:{method:'structured'},reviewState:'candidate',asOf:date},{type:'Point',coordinates:[13.88,52.58]});
}
const allowed=feature('allowed'),blocked=feature('BLOCKED_CANARY','blocked.example'),second=feature('second');
const catalogue:Catalogue={schemaVersion:'stadtstack-signals-v1',generatedAt:date,publisher:'Test',coreBundle:{path:'core/strausberg-facts.json',version:releaseId,manifestPath:'core/release-manifest.json'},cities:[{id:city,name:'Strausberg',state:'Brandenburg',center:[13.88,52.58],bbox:[13,52,14,53],feedUrl:'cities/strausberg/feed.json',minUrl:'cities/strausberg/signals.min.geojson',fullBytes:100,minBytes:50,sources:[allowed,blocked].map(feature=>({id:feature.properties.id,kind:'website',publisher:'Publisher',url:feature.properties.sources[0].url,licence:'unknown',reuse:'facts_with_attribution',retrievedAt:date,recordCount:99,publishedRecordCount:99,error:feature.properties.title}))}]};
const item={title:'Solarpark REGIONAL_CANARY',url:'https://regional.example/evidence',date:'2026-09-01',sourceType:'councilAgenda',locator:'Vorlage 68/23 REGIONAL_CANARY',stage:'draft'};
const regional:Regional={schemaVersion:'stadtstack-regional-topics-v1',generatedAt:date,asOf:'2026-10-10',region:{id:'region',name:'Region'},municipalities:[{id:city,name:'Strausberg'}],topics:[{id:'solarpark',label:'Solarpark',municipalities:[{municipalityId:city,stage:'draft',items:[item]}]}]};
function query(mask?:VerifiedRevocations,features=[allowed,blocked,second],knowledge?:KnowledgeQueryData){return new QueryIndex(releaseId,date,features,regional,catalogue,knowledge,mask);}
function bundle():CoreBundle {
 // Core admission is tested separately; the read-view contract needs the original fact/source identities.
 return {schemaVersion:'stadtstack-core-facts-v1',cityId:city,version:releaseId,generatedAt:date,facts:[{id:blocked.properties.id,version:releaseId,topic:'budget',statement:blocked.properties.statement,source:{...blocked.properties.sources[0],sha256:hash('core'),publisher:'Stadt Strausberg',documentDate:'2026-09-01'},assertion:{value:1,unit:'EUR'}}]} as CoreBundle;
}
function release(mask:VerifiedRevocations):ReleasedData {
 const bytes=JSON.stringify({schemaVersion:'stadtstack-knowledge-v2',generatedAt:date,records:[]});
 return {mode:'sealed',revocations:mask,dataManifest:{id:releaseId,generatedAt:date},manifest:{bundleSha256:hash('core'),bundleVersion:releaseId},bundle:bundle(),catalogue,features:[allowed,blocked,second],regional,index:query(),graph:new GraphIndex(releaseId,buildKnowledgeGraph(bytes),bytes,undefined,mask),changes:{[city]:diff([],[allowed,blocked,second].map(signalChangeRecord),date)}} as ReleasedData;
}

test('record, host and exact MCP attribution targets filter contributors before every derived query view',()=>{
 const multi=feature('multi');multi.properties.sources.push(blocked.properties.sources[0]);
 for(const targets of [[{type:'record',recordId:blocked.properties.id}],[{type:'host',host:'blocked.example'}],[{type:'mcp_source',mcpSourceId:mcpSourceId(blocked.properties.sources[0])}]] satisfies RevocationTarget[][]){
  const index=query(verifiedMask(releaseId,targets),[allowed,blocked,second,multi]);
  assert.equal(index.records.some(record=>record.id===blocked.properties.id),false);
  if(targets[0].type!=='record')assert.equal(index.records.some(record=>record.id===multi.properties.id),false);
  const exported=index.exportRecords();assert.equal(exported.totalRecords,index.records.length);
  for(const record of exported.items)assert.ok(record.originalRecord);
  assert.equal(index.sources.has(mcpSourceId(blocked.properties.sources[0])),targets[0].type==='record');
  if(targets[0].type!=='record')for(const surface of [exported,index.listTopics(),index.compareTopic('solarpark',[city]),index.similar(allowed.properties.id),index.page({},'search_topics')])assert.equal(JSON.stringify(surface).includes('BLOCKED_CANARY'),false);
 }
});

test('regional opaque record IDs and attribution IDs are unchanged and revocable',()=>{
 const id=regionalRecordId(city,item),sourceId=mcpSourceId(regionalSource(item,regional.asOf));
 assert.ok(query(verifiedMask(releaseId)).records.some(record=>record.id===id&&record.sourceIds.includes(sourceId)));
 for(const target of [{type:'record',recordId:id},{type:'mcp_source',mcpSourceId:sourceId},{type:'host',host:'regional.example'}] satisfies RevocationTarget[]){
  const index=query(verifiedMask(releaseId,[target]));assert.equal(JSON.stringify(index.exportRecords()).includes('REGIONAL_CANARY'),false);assert.equal(index.sources.has(sourceId),false);
 }
});

test('empty verified cohorts preserve data and cursor reuse is bound to exact mask identity in one process',()=>{
 const empty=query(verifiedMask(releaseId)),unmasked=query();
 assert.deepEqual(empty.records,unmasked.records);assert.deepEqual([...empty.sources],[...unmasked.sources]);
 const page=empty.page({limit:1},'search_topics');assert.ok(page.nextCursor);
 const changed=query(verifiedMask(releaseId,[],1));assert.throws(()=>changed.page({limit:1,cursor:page.nextCursor!},'search_topics'),/mismatch/);
 const exported=empty.exportRecords({limit:1});assert.ok(exported.nextCursor);
 assert.throws(()=>changed.exportRecords({limit:1,cursor:exported.nextCursor!}),/mismatch/);
 assert.throws(()=>query({...verifiedMask(releaseId)}),/verified|verification|authentic/i);
 assert.throws(()=>query(verifiedMask('b'.repeat(64))),/release mismatch/);
});

test('core facts use city attribution as well as their own source and registry/feed pointers omit unverifiable counts',()=>{
 const mask=verifiedMask(releaseId,[{type:'mcp_source',mcpSourceId:mcpSourceId(blocked.properties.sources[0])}]);
 assert.equal(visibleCore(bundle(),[allowed,blocked],mask).facts.length,0);
 const input=release(mask),view=prepareReleaseReadView(input);assert.equal(prepareReleaseReadView(input),view);assert.equal(prepareReleaseReadView(view),view);
 assert.equal(view.features.length,2);assert.equal(view.catalogue.cities[0].feedUrl,undefined);assert.equal(view.catalogue.cities[0].minUrl,undefined);assert.equal(view.catalogue.coreBundle,undefined);
 assert.equal(view.catalogue.cities[0].sources[0].recordCount,undefined);assert.equal(JSON.stringify(view.catalogue).includes('BLOCKED_CANARY'),false);
 assert.throws(()=>prepareReleaseReadView({...input,revocations:undefined as unknown as VerifiedRevocations}));
 assert.throws(()=>prepareReleaseReadView({...input,revocations:verifiedMask(releaseId)}),/Graph administrative read-view mismatch/);
});

test('historical removals fail closed only under relevant unresolved source ancestry; witnesses and revisions cannot leak',()=>{
 const historical=feature('HISTORICAL_CANARY','historical.example'),feed=diff([signalChangeRecord(historical)],[signalChangeRecord(allowed),signalChangeRecord(blocked)],date);
 const withWitness:Changes={...feed,events:[...feed.events,{id:allowed.properties.id,cityId:city,recordType:'signal',kind:'superseded',reason:'WITNESS_CANARY',previous:signalChangeRecord(allowed).revision,current:null,targetRevision:'previous',evidence:{kind:'text_model',recordId:blocked.properties.id,sourceUrl:blocked.properties.sources[0].url,sourceHash:blocked.properties.sources[0].sha256!,replacementRecordId:second.properties.id,quote:'WITNESS_CANARY'}}]};
 for(const target of [{type:'host',host:'blocked.example'},{type:'mcp_source',mcpSourceId:mcpSourceId(blocked.properties.sources[0])},{type:'registry_source',municipalityId:city,registrySourceId:'unknown-registry'}] satisfies RevocationTarget[]){
  const visible=visibleChanges({[city]:withWitness},[allowed,blocked,second],undefined,verifiedMask(releaseId,[target]))[city];
  assert.equal(visible.events.some(event=>event.id===historical.properties.id),false);
  if(target.type!=='registry_source')assert.equal(JSON.stringify(visible).includes('WITNESS_CANARY'),false);
  assert.deepEqual(visible.snapshots,feed.snapshots);
 }
 const recordMask=verifiedMask(releaseId,[{type:'record',recordId:blocked.properties.id}]);
 const visible=visibleChanges({[city]:withWitness},[allowed,blocked,second],undefined,recordMask)[city];
 assert.ok(visible.events.some(event=>event.id===historical.properties.id));assert.equal(JSON.stringify(visible).includes('WITNESS_CANARY'),false);
 const irrelevant=verifiedMask(releaseId,[{type:'registry_source',municipalityId:'other-town',registrySourceId:'unknown-registry'}]);
 assert.ok(visibleChanges({[city]:feed},[allowed,blocked],undefined,irrelevant)[city].events.some(event=>event.id===historical.properties.id));
});

function knowledgeRecord(municipalityId:string,id:string,registryId:string):DistrictKnowledgeRecord {
 const digest=hash(id),title=`Solarpark ${id}`;
 const record:DistrictKnowledgeRecord={id,municipalityId,ags:'12064472',districtId:'maerkisch-oderland',caseKey:'Plan 68/23',caseKeyType:'plan_number',caseType:'planning',caseQuote:'Plan 68/23',title,titleQuote:title,summary:title,summaryQuote:title,municipalityQuote:municipalityId,documentDate:'2026-09-20',documentDateQuote:'20.09.2026',documentDateReason:null,topics:[{id:'solarpark',parentId:'energie',provenance:'model',confidence:0.9,quote:'Solarpark'}],stage:'draft',stageDate:'2026-09-19',stageDateQuote:'19.09.2026',stageDateReason:null,originalStatus:'draft',stageQuote:'draft',stages:[],entities:[],relations:[],locations:[],sources:[{id:registryId,url:`https://knowledge.example/${id}`,sha256:digest,retrievedAt:date,locator:'Seite 1',mimeType:'application/pdf',sourceType:'website',policy:{robots:{state:'allowed',url:'https://knowledge.example/robots.txt',checkedAt:date},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}}],extraction:{extractorVersion:'test',extractorSha256:digest,model:'test-model',provider:'openai-subscription',tool:'codex-cli',toolVersion:'synthetic-fixture',modelIdentitySha256:digest,modelIdentityBasis:'configured-cli-model-and-tool-version',returnedModel:null,promptVersion:'test',promptSha256:digest,judgePromptVersion:'test',judgePromptSha256:digest,inputSha256:digest,textSha256:digest,responseSha256:digest,ocrUsed:false,textMethod:'pdf_text',cacheKey:digest,extractedAt:date,chunk:{index:0,count:1,start:0,end:100}},verification:{status:'auto-verified',deterministic:{passed:true,checks:REQUIRED_DETERMINISTIC_CHECKS.map(id=>({id,passed:true,reason:'synthetic query fixture'}))},faithfulness:{score:0.9,threshold:0.8,model:'test-model',provider:'openai-subscription',tool:'codex-cli',toolVersion:'synthetic-fixture',modelIdentitySha256:digest,returnedModel:null,reason:'fixture',evaluatedAt:date,responseSha256:digest,sameModel:true,limitation:'Same-model judgment is not independent verification.'},evidenceHash:digest}};
 record.verification.evidenceHash=knowledgeEvidenceHash(record);return record;
}
test('registry IDs are municipality scoped and every contributor withholds the complete knowledge record and history',()=>{
 const registryId='Opaque Registry ID  ',hidden=knowledgeRecord(city,'KNOWLEDGE_CANARY',registryId),safe=knowledgeRecord(city,'knowledge-visible','safe-registry'),other=knowledgeRecord('other-town','knowledge-other',registryId),multi=knowledgeRecord(city,'MULTI_CANARY','safe-registry');multi.sources.push(hidden.sources[0]);
 const records=[hidden,safe,other,multi],municipalities=[city,'other-town'].map(id=>({id,name:id,ags:'12064472',districtId:'maerkisch-oderland',sources:[registryId,'safe-registry'].map(sourceId=>({id:sourceId,kind:'website',url:'https://knowledge.example',checkState:'checked' as const}))}));
 const knowledge={records,municipalities,coverage:{municipalities:municipalities.map(({id})=>({id,status:'gated_records',documents:99,publishedRecords:99,datedStagedRecords:99,quarantinedRecords:0}))}};
 for(const target of [{type:'registry_source',municipalityId:city,registrySourceId:registryId},{type:'mcp_source',mcpSourceId:knowledgeSourceDescriptors(hidden)[0].mcpSourceId!}] satisfies RevocationTarget[]){
  const index=query(verifiedMask(releaseId,[target]),[],knowledge),exported=index.exportRecords();
  assert.ok(index.records.some(record=>record.id===other.id));assert.ok(index.records.some(record=>record.id===safe.id));
  for(const output of [exported,index.compareTopic('solarpark',[city]),index.similar(safe.id),index.listTopics(),index.knowledge]){const json=JSON.stringify(output);assert.equal(json.includes('KNOWLEDGE_CANARY'),false);assert.equal(json.includes('MULTI_CANARY'),false);}
  assert.equal(index.municipalities.get(city)?.recordCoverage,null);
  assert.equal(index.municipalities.get(city)?.sources?.some(source=>source.id===registryId),false);
  assert.equal(JSON.stringify(index.knowledge?.coverage).includes('99'),false);
 }
});

test('all seventeen nongraph MCP routes share the materialized verified view, including injected releases',async()=>{
 const mask=verifiedMask(releaseId,[{type:'host',host:'blocked.example'}]),input=release(mask),mcp=server({release:input}),client=new Client({name:'signed-read-views',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const sourceId=mcpSourceId(allowed.properties.sources[0]);
  const calls:[string,Record<string,unknown>][]=[['export_records',{}],['compare_topic',{topic:'solarpark',cityIds:[city]}],['similar',{id:allowed.properties.id}],['list_cities',{}],['list_topics',{}],['get_core_bundle',{}],['get_release_status',{}],['search_signals',{cityId:city}],['search_topics',{}],['get_council_items',{cityId:city}],['get_regional_topics',{}],['search_signals_near',{cityId:city,lon:13.88,lat:52.58,radius_m:500}],['search_signals_along',{cityId:city,line:[[13.87,52.58],[13.89,52.58]],buffer_m:100}],['get_signal',{id:allowed.properties.id}],['get_sources',{id:allowed.properties.id}],['get_source',{sourceId}],['get_changes',{cityId:city}]];
  assert.equal(calls.length,17);
  for(const [name,args] of calls){const response=await client.callTool({name,arguments:args});assert.notEqual(response.isError,true,name);const output=response.structuredContent!;assert.equal(JSON.stringify(output).includes('BLOCKED_CANARY'),false,name);assert.deepEqual(output.administrativeView,input.graph.administrativeView,name);assert.equal(JSON.stringify(output).includes('ed25519:'),false,name);assert.equal(Object.hasOwn(output,'targets'),false,name);if(name==='get_core_bundle'){assert.equal(Object.hasOwn(output,'manifest'),false);assert.equal(Object.hasOwn(output.bundle as object,'version'),false);}if(name==='get_changes'){assert.equal(Object.hasOwn(output,'snapshots'),false);assert.ok(output.sealedSnapshots);}}
  for(const [name,args] of [['get_signal',{id:blocked.properties.id}],['get_sources',{id:blocked.properties.id}],['get_source',{sourceId:mcpSourceId(blocked.properties.sources[0])}]] as const)assert.equal((await client.callTool({name,arguments:args})).isError,true);
 }finally{await client.close();await mcp.close();}
});

test('auxiliary provenance URLs cannot leak through source objects, original records, core or regional evidence',()=>{
 const mask=verifiedMask(releaseId,[{type:'host',host:'auxiliary.example'}]),cityRecord=feature('auxiliary');
 cityRecord.properties.sources[0].snapshotUrl='https://auxiliary.example/snapshot';
 assert.equal(query(mask,[cityRecord]).records.some(record=>record.id===cityRecord.properties.id),false);
 const regionalInput={...regional,topics:[{...regional.topics[0],municipalities:[{municipalityId:city,stage:'draft',items:[{...item,locator:'Source mirror https://auxiliary.example/evidence'}]}]}]};
 assert.equal(new QueryIndex(releaseId,date,[],regionalInput,catalogue,undefined,mask).records.length,0);
 const core=bundle();core.facts[0].source.locator='Quote provenance https://auxiliary.example/core';
 assert.equal(visibleCore(core,[],mask).facts.length,0);
 const record=knowledgeRecord(city,'auxiliary-knowledge','registry');record.sources[0].policy.robots.url='https://auxiliary.example/robots.txt';
 const knowledge={records:[record],municipalities:[{id:city,name:city,ags:'12064472',districtId:'maerkisch-oderland',sources:[]}],coverage:{municipalities:[]}};
 assert.equal(query(mask,[],knowledge).records.some(row=>row.id===record.id),false);
 assert.equal(JSON.stringify(query(mask,[],knowledge).exportRecords()).includes('auxiliary-knowledge'),false);
});

test('previous revision metric quotes are withheld when their source ancestry is blocked',()=>{
 const previous={...signalChangeRecord(blocked).revision,metricClaims:[{metric:'area',unit:'ha',value:12,scope:'Plan 68/23',scopeEvidence:{quote:'REVISION_METRIC_CANARY',sourceIds:[mcpSourceId(blocked.properties.sources[0])]},instrument:null,reportedAt:'2026-09-01',evidence:{quote:'REVISION_METRIC_CANARY',sourceIds:[mcpSourceId(blocked.properties.sources[0])]}}]};
 const feed:Changes={schemaVersion:'stadtstack-changes-v2',generatedAt:date,snapshots:[],events:[{id:allowed.properties.id,cityId:city,recordType:'signal',kind:'changed',reason:'Published revision',previous,current:signalChangeRecord(allowed).revision,evidence:null,targetRevision:null}]};
 for(const target of [{type:'host',host:'blocked.example'},{type:'mcp_source',mcpSourceId:mcpSourceId(blocked.properties.sources[0])}] satisfies RevocationTarget[]){
  const result=visibleChanges({[city]:feed},[allowed,blocked],undefined,verifiedMask(releaseId,[target]))[city];
  assert.deepEqual(result.events,[]);assert.equal(JSON.stringify(result).includes('REVISION_METRIC_CANARY'),false);
 }
});

test('case identity, supersession, metric history and comparison counts are rebuilt from visible members',()=>{
 const old=knowledgeRecord(city,'history-old','old-registry'),next=knowledgeRecord(city,'history-new','new-registry');
 for(const record of [old,next]){record.title=record.titleQuote=record.caseQuote='Bebauungsplan Nr. 68/23 Solarpark';record.caseKey='68/23';}
 old.summary=old.summaryQuote='Der Geltungsbereich umfasst 68,6 ha.';old.documentDate='2024-01-30';
 next.summary=next.summaryQuote='Der Geltungsbereich wurde von 68,6 ha auf 41,5 ha reduziert.';next.documentDate='2025-08-07';
 for(const record of [old,next])record.verification.evidenceHash=knowledgeEvidenceHash(record);
 const knowledge={records:[old,next],municipalities:[{id:city,name:city,ags:'12064472',districtId:'maerkisch-oderland',sources:[]}],coverage:{municipalities:[{id:city,status:'gated_records',documents:2,publishedRecords:2,datedStagedRecords:2,quarantinedRecords:0}]}};
 const baseline=query(verifiedMask(releaseId),[],knowledge),filtered=query(verifiedMask(releaseId,[{type:'record',recordId:old.id}]),[],knowledge);
 assert.ok(baseline.exportRecords().cases.some(row=>row.history.some(entry=>entry.recordId===old.id)));
 const exported=filtered.exportRecords();assert.equal(exported.totalRecords,baseline.exportRecords().totalRecords-1);
 assert.equal(JSON.stringify(exported).includes(old.id),false);
 assert.equal(filtered.sources.has(knowledgeSourceDescriptors(old)[0].mcpSourceId!),false);
 assert.ok(exported.cases.every(row=>row.history.every(entry=>entry.recordId!==old.id)));
 assert.equal(filtered.compareTopic('solarpark',[city]).cities[0].recordCount,baseline.compareTopic('solarpark',[city]).cities[0].recordCount-1);
 assert.equal(filtered.listTopics([city]).topics.find(topic=>topic.id==='solarpark')!.total,baseline.listTopics([city]).topics.find(topic=>topic.id==='solarpark')!.total-1);
 assert.throws(()=>filtered.similar(old.id),/not found/);
});
