import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {QueryIndex,querySchema,exportRecordsSchema,queryFields,type KnowledgeQueryData,type Regional} from '../src/mcp-query.ts';
import {admitStructuredObservations} from '../src/district-structured-record.ts';
import {digest,semanticHash,observation,type StructuredObservation,type StructuredAdapter,type AdapterScope} from '../src/district-adapter-contract.ts';
import {sourceStageDate} from '../src/query-cases.ts';
import {server} from '../src/mcp.ts';
import {loadRelease} from '../src/mcp-release.ts';
import type {Catalogue} from '../src/schema.ts';
import {changesSchema,diff,knowledgeChangeRecord} from '../src/changes.ts';

// Entirely synthetic admitted bytes/mapping/policy fixtures, never publisher facts or release output.
const retrievedAt='2026-10-11T00:00:00.000Z';
const fixtureScope:AdapterScope={publisherId:'synthetic-publisher',sourceId:'synthetic-source',municipalityId:'ratzeburg',ags:'01053100',tenant:null,observationWindow:'2026-10-11'};
const catalogue:Catalogue={schemaVersion:'stadtstack-signals-v1',generatedAt:retrievedAt,publisher:'Synthetic fixture',cities:[]};
const regional:Regional={schemaVersion:'stadtstack-regional-topics-v1',generatedAt:retrievedAt,asOf:'2026-10-11',region:{id:'fixture',name:'Synthetic'},municipalities:[],topics:[]};
type FixtureNativeRow={id:string;kind:string;predicate:string;value:StructuredObservation['value'];date:string|null;dateRole:string|null;financialRole:StructuredObservation['financialRole'];nativeId?:string;nativeVersion?:string|null;subject?:string};
async function fixture(scope:AdapterScope=fixtureScope,councilKinds:string[]=[],extraDates:string[]=[],withSupport=false,extraRows:FixtureNativeRow[]=[]){
 const rows=[
  {id:'context',kind:'StatisticalObservation',predicate:'modeled_heat_demand',value:100,date:'2022-05-15',dateRole:'reference_date',financialRole:'none'},
  {id:'plan',kind:'FiscalObservation',predicate:'appropriation',value:200,date:'2023-01-01',dateRole:'fiscal_year',financialRole:'plan'},
  {id:'approval',kind:'FundingOperation',predicate:'approved_cost',value:200,date:'2023-06-12',dateRole:'approval_date',financialRole:'approval'},
  {id:'payment',kind:'Payment',predicate:'paid_amount',value:150,date:'2025-02-20',dateRole:'payment_date',financialRole:'payment'},
  {id:'actual',kind:'FiscalObservation',predicate:'actual_expenditure',value:175,date:'2025-12-31',dateRole:'accounting_period_end',financialRole:'actual'},
  {id:'undated',kind:'EnergyUnit',predicate:'rated_capacity',value:12,date:null,dateRole:null,financialRole:'none'},
 ] as const;
 const councilRows=councilKinds.map(kind=>({id:`council:${kind}`,kind,predicate:'name',value:'Synthetic council item',date:null,dateRole:null,financialRole:'none' as const}));
 const dateRows=extraDates.map((date,index)=>({id:`precision:${index}`,kind:'StatisticalObservation',predicate:'reference_period',value:1,date,dateRole:'reference_period',financialRole:'none' as const}));
 const nativeRows:FixtureNativeRow[]=[...rows,...councilRows,...dateRows,...extraRows];
 const bytes=Buffer.from(JSON.stringify(nativeRows));
 const snapshot={bytes,sourceSha256:digest(bytes),url:'https://example.org/synthetic-export.json',mimeType:'application/json',retrievedAt,policyReceiptSha256:digest('synthetic-policy'),sourceVersion:'fixture-1'};
 const supportBytes=Buffer.from(JSON.stringify({ags:scope.ags}));
 const supportingSources=withSupport?[{id:'synthetic-join-source',url:'https://example.org/synthetic-municipality-join.json',sha256:digest(supportBytes),mimeType:'application/json',retrievedAt,policyReceiptSha256:digest('synthetic-support-policy'),scopeSha256:semanticHash(scope),role:'municipality_join' as const}]:[];
 const supportingEvidence=withSupport?[{role:'municipality_join' as const,locator:{sourceSha256:digest(supportBytes),format:'json' as const,nativeId:scope.municipalityId,path:'$.ags',sheet:null,rowKey:scope.municipalityId,cells:[],rawValue:scope.ags,schemaHash:digest('synthetic-join-schema'),mappingVersion:'synthetic-v1'}}]:[];
 const candidates=nativeRows.map((row,index)=>observation({publisherId:scope.publisherId,sourceId:scope.sourceId,nativeId:row.nativeId??row.id,nativeVersion:row.nativeVersion===undefined?'fixture-1':row.nativeVersion,kind:row.kind,subject:row.subject??'Wärmeplanung fixture',predicate:row.predicate,value:row.value,unit:typeof row.value==='string'?null:row.financialRole==='none'?'kW':'EUR',date:row.date,dateRole:row.dateRole,financialRole:row.financialRole,geography:{ags:scope.ags,basis:withSupport?'verified_join':'source_explicit',role:'administrative_area'},sourceReferenceDate:'2022-05-15',publishedAt:'2026-01-01',retrievedAt,evidence:[{sourceSha256:snapshot.sourceSha256,format:'json',nativeId:row.nativeId??row.id,path:`$[${index}].value`,sheet:null,rowKey:row.nativeId??row.id,cells:[],rawValue:row.value,schemaHash:digest('synthetic-schema'),mappingVersion:'synthetic-v1'}],supportingEvidence,limitations:['Synthetic fixture only; no actual project identity or outcome evidence.']}));
 const coverage={state:'complete' as const,scope:'synthetic fixture rows',reason:'Fixture exhausted',checkedAt:retrievedAt,nextCursor:null,observedRows:nativeRows.length,limitations:[]};
 const adapter:StructuredAdapter={id:'synthetic-native',version:'synthetic-v1',discover:()=>({resources:[],coverage}),parse:()=>({observations:candidates,coverage})};
 const records=await admitStructuredObservations({adapter,adapterContractSha256:digest('synthetic-contract'),snapshot,scope,districtId:'herzogtum-lauenburg',candidates,checkCurrentPolicy:async()=>({receiptSha256:snapshot.policyReceiptSha256,sourceSha256:snapshot.sourceSha256,scopeSha256:semanticHash(scope),allowed:true,checkedAt:retrievedAt}),replayInSandbox:async()=>adapter.parse(snapshot,scope),supportingSources,checkSupportingPolicies:async()=>supportingSources.map(source=>({receiptSha256:source.policyReceiptSha256,sourceSha256:source.sha256,scopeSha256:source.scopeSha256,allowed:true,checkedAt:retrievedAt}))});
 const knowledge:KnowledgeQueryData={records,municipalities:[{id:scope.municipalityId,name:'Ratzeburg',ags:scope.ags,districtId:'herzogtum-lauenburg',sources:[]}],coverage:{municipalities:[{id:scope.municipalityId,status:'gated_records',documents:1,publishedRecords:records.length,datedStagedRecords:0,quarantinedRecords:0}]}};
 return {records,index:new QueryIndex(digest('synthetic-release'),retrievedAt,[],regional,catalogue,knowledge)};
}

test('native union projection preserves fields and locators without model or quotation inventions',async()=>{
 const {index,records}=await fixture();
 const page=index.page({kinds:['structured'],fields:[...queryFields]},'search_topics');
 assert.equal(page.total,records.length);
 for(const projected of page.items){
  const original=records.find(record=>record.id===projected.id)!;
  assert.equal(projected.kind,'structured');assert.deepEqual(projected.observation,original.observation);assert.deepEqual(projected.evidence,original.observation.evidence);
  assert.equal(projected.stage,null);assert.equal(projected.stageDate,null);assert.equal(projected.documentDate,null);assert.equal(projected.stageQuote,undefined);assert.equal(projected.titleQuote,undefined);assert.equal(projected.extraction,undefined);
  assert.equal('faithfulness' in (projected.verification as object),false);
  assert.equal(sourceStageDate(index.records.find(record=>record.id===projected.id)!),null);
 }
 const exported=index.exportRecords({kinds:['structured'],limit:1});
 assert.deepEqual(exported.items[0].originalRecord,records.find(record=>record.id===exported.items[0].id));
 assert.deepEqual(exported.sources[0].locators,exported.items[0].evidence);assert.equal(exported.sources[0].sha256,records[0].source.sha256);
 assert.equal(exported.sources[0].locator,undefined);
});

test('native date and financial roles filter independently and do not become project milestones',async()=>{
 const {index}=await fixture();
 for(const financialRole of ['plan','approval','payment','actual'] as const){
  const page=index.page({financialRole},'search_topics');assert.equal(page.total,1);assert.equal(index.records.find(record=>record.id===page.items[0].id)!.financialRole,financialRole);
 }
 assert.equal(index.page({dateRole:'payment_date',dateFrom:'2025-02-20',dateTo:'2025-02-20'},'search_topics').total,1);
 assert.equal(index.page({financialRole:'approval',dateRole:'payment_date'},'search_topics').total,0);
 assert.equal(index.page({observationKinds:['StatisticalObservation']},'search_topics').total,1);
 assert.equal(index.page({observationKinds:['EnergyUnit'],dateFrom:'2026-01-01'},'search_topics').total,0);
 const compared=index.compareTopic('waermeplanung',['ratzeburg']).cities[0];
 assert.equal(compared.recordCount,6);assert.equal(compared.observationCount,6);assert.equal(compared.caseCount,0);assert.equal(compared.identifiedCaseCount,0);assert.equal(compared.unknownStageCount,0);assert.equal(compared.furthestPositiveMilestone,null);assert.equal(compared.latestStageDate,null);
 const exported=index.exportRecords();assert.equal(exported.totalCases,0);assert.equal(exported.observationCount,6);assert.ok(exported.items.every(item=>item.caseId===undefined&&item.caseIdentity?.status==='not_applicable'));
});

test('native filters and full evidence pagination remain projection/tool/release bound',async()=>{
 const {index}=await fixture();
 assert.equal(querySchema.safeParse({kinds:['structured'],observationKinds:['Payment'],financialRole:'payment',dateRole:'payment_date',fields:['observation','evidence']}).success,true);
 assert.equal(querySchema.safeParse({financialRole:'paid'}).success,false);assert.equal(querySchema.safeParse({kinds:['model']}).success,false);
 assert.equal(exportRecordsSchema.safeParse({kinds:['structured'],observationKinds:['Payment'],financialRole:'payment'}).success,true);
 const first=index.exportRecords({kinds:['structured'],limit:1});assert.ok(first.nextCursor);
 for(const change of [{kinds:['text_model'] as const},{observationKinds:['Payment']},{financialRole:'payment' as const},{dateRole:'payment_date'}])assert.throws(()=>index.exportRecords({limit:1,cursor:first.nextCursor!,...change,kinds:change.kinds?[...change.kinds]:['structured']}),/mismatch/);
 const seen:string[]=[];let cursor:string|undefined;
 do{const page=index.exportRecords({kinds:['structured'],limit:1,cursor});seen.push(...page.items.map(record=>record.id));assert.deepEqual(page.sources.map(source=>source.id),page.items[0].sourceIds);cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(new Set(seen).size,6);assert.equal(seen.length,6);
});

test('MCP exposes native filter schemas, full evidence and separate observation counts',async()=>{
 const {index}=await fixture(),loaded=await loadRelease();
 const mcp=server({release:{...loaded,index}}),client=new Client({name:'synthetic-native-reader-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const tools=await client.listTools();
  for(const name of ['search_topics','export_records','compare_topic']){const tool=tools.tools.find(tool=>tool.name===name)!;assert.ok(tool.inputSchema.properties?.financialRole);assert.match(tool.description!,/native|structured/i);}
  const response=await client.callTool({name:'search_topics',arguments:{kinds:['structured'],financialRole:'payment',fields:['id','kind','dateRole','financialRole','observation','evidence','verification']}});
  assert.equal(response.isError,undefined);
  const data=response.structuredContent as {items:Array<{id:string;observation:StructuredObservation;verification:Record<string,unknown>}>};
  assert.equal(data.items.length,1);assert.equal(data.items[0].observation.dateRole,'payment_date');assert.equal('faithfulness' in data.items[0].verification,false);
  const sourceResult=await client.callTool({name:'get_sources',arguments:{id:data.items[0].id}});
  const source=sourceResult.structuredContent as Record<string,unknown>;assert.equal(source.financialRole,'payment');assert.deepEqual(source.evidence,data.items[0].observation.evidence);assert.equal(source.stageDate,null);
  const exported=await client.callTool({name:'export_records',arguments:{kinds:['structured'],limit:1}});const page=exported.structuredContent as {totalCases:number;observationCount:number;nextCursor:string};assert.equal(page.totalCases,0);assert.equal(page.observationCount,6);assert.ok(page.nextCursor);
  assert.equal((await client.callTool({name:'export_records',arguments:{kinds:['structured'],financialRole:'payment',limit:1,cursor:page.nextCursor}})).isError,true);
 }finally{await client.close();await mcp.close();}
});

test('native similarity discovers observations without grouping them as cases or projects',async()=>{
 const first=await fixture(),second=await fixture({...fixtureScope,municipalityId:'moelln',ags:'01053090'});
 const index=new QueryIndex(digest('synthetic-shared-release'),retrievedAt,[],regional,catalogue,{records:[...first.records,...second.records],municipalities:[...first.index.knowledge!.municipalities,...second.index.knowledge!.municipalities],coverage:{municipalities:[]}});
 const result=index.similar(first.records[0].id,{kinds:['structured']});
 assert.equal(result.target.kind,'observation');assert.equal(result.totalCases,0);assert.equal(result.totalObservations,6);
 for(const item of result.items){
  assert.equal(item.kind,'observation');
  if(item.kind!=='observation')assert.fail('Native match must remain an observation');
  assert.equal(item.identityStatus,'not_applicable');assert.deepEqual(item.evidence,second.records.find(record=>record.id===item.id)!.observation.evidence);assert.equal(item.financialRole,item.observation!.financialRole);
 }
});

test('council lookup includes native item kinds without promoting attached metadata to resolutions',async()=>{
 const {index}=await fixture(fixtureScope,['Meeting','AgendaItem','Paper','Body','Organization','File','System']),loaded=await loadRelease();
 const mcp=server({release:{...loaded,index}}),client=new Client({name:'synthetic-native-council-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const result=await client.callTool({name:'get_council_items',arguments:{kinds:['structured'],fields:['id','observationKind','observation','stage','stageDate','evidence']}});
  assert.equal(result.isError,undefined);
  const page=result.structuredContent as {items:Array<{observationKind:string;stage:null;stageDate:null;evidence:unknown[]}>};
  assert.deepEqual(page.items.map(item=>item.observationKind).sort(),['AgendaItem','Body','Meeting','Paper']);
  assert.ok(page.items.every(item=>item.stage===null&&item.stageDate===null&&item.evidence.length));
 }finally{await client.close();await mcp.close();}
});

test('native calendar year/month overlap is explicit while school/planning periods remain unguessed',async()=>{
 const {index}=await fixture(fixtureScope,[],['2023','2023-12','2024-02','2025/26']);
 const year=index.records.find(record=>record.nativeDate==='2023')!,month=index.records.find(record=>record.nativeDate==='2023-12')!,leap=index.records.find(record=>record.nativeDate==='2024-02')!,school=index.records.find(record=>record.nativeDate==='2025/26')!;
 assert.equal(year.eventDate,null);assert.equal(year.datePrecision,'year');assert.equal(year.stageDate,null);assert.equal(year.calendarRange?.basis,'derived_calendar_range');assert.deepEqual([year.calendarRange?.from,year.calendarRange?.to],['2023-01-01','2023-12-31']);
 assert.equal(month.eventDate,null);assert.equal(month.datePrecision,'month');assert.deepEqual([month.calendarRange?.from,month.calendarRange?.to],['2023-12-01','2023-12-31']);
 assert.equal(leap.calendarRange?.to,'2024-02-29');
 assert.equal(school.eventDate,null);assert.equal(school.datePrecision,'period');assert.equal(school.nativeDate,'2025/26');assert.equal(school.calendarRange,null);
 const search=(dateFrom:string,dateTo:string)=>index.page({dateRole:'reference_period',dateFrom,dateTo,fields:['id','nativeDate','datePrecision','calendarRange','eventDate','stageDate']},'search_topics');
 assert.deepEqual(search('2023-12-15','2023-12-15').items.map(item=>item.nativeDate).sort(),['2023','2023-12']);
 assert.deepEqual(search('2023-11-30','2023-11-30').items.map(item=>item.nativeDate),['2023']);
 assert.equal(search('2024-01-01','2024-01-31').total,0);assert.equal(search('2024-02-29','2024-02-29').total,1);
 assert.equal(search('2025-01-01','2026-12-31').total,0,'School year notation does not license guessed dates');
 assert.equal(index.page({dateRole:'reference_period',fields:['nativeDate']},'search_topics').total,4);
 const exported=index.exportRecords({dateRole:'reference_period',dateFrom:'2023-12-31',dateTo:'2023-12-31'});assert.equal(exported.totalRecords,2);
 const first=index.exportRecords({dateRole:'reference_period',dateFrom:'2023-12-01',dateTo:'2023-12-31',limit:1});assert.ok(first.nextCursor);
 assert.throws(()=>index.exportRecords({dateRole:'reference_period',dateFrom:'2023-12-15',dateTo:'2023-12-31',limit:1,cursor:first.nextCursor!}),/mismatch/);
});

test('supporting locators preserve separate byte/policy/scope source bindings in query and MCP attribution',async()=>{
 const {index,records}=await fixture(fixtureScope,[],[],true);
 const exported=index.exportRecords({limit:1}),item=exported.items[0],original=records.find(record=>record.id===item.id)!;
 assert.equal(item.sourceIds.length,2);assert.equal(exported.sources.length,2);assert.deepEqual(item.supportingEvidence,original.observation.supportingEvidence);
 const primary=exported.sources.find(source=>source.sha256===original.source.sha256)!,support=exported.sources.find(source=>source.sha256===original.supportingSources[0].sha256)!;
 assert.deepEqual(primary.locators,original.observation.evidence);assert.deepEqual(support.locators,original.observation.supportingEvidence.map(evidence=>evidence.locator));
 assert.notEqual(primary.sha256,support.sha256);assert.equal(support.policyReceiptSha256,original.supportingSources[0].policyReceiptSha256);assert.equal(support.scopeSha256,original.supportingSources[0].scopeSha256);assert.equal(support.role,'municipality_join');assert.equal(support.publisher,undefined);assert.equal(support.locator,undefined);
 const loaded=await loadRelease(),mcp=server({release:{...loaded,index}}),client=new Client({name:'synthetic-supporting-reader-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const response=await client.callTool({name:'get_sources',arguments:{id:item.id}});assert.equal(response.isError,undefined);
  const data=response.structuredContent as {supportingEvidence:unknown;sources:Array<Record<string,unknown>>};assert.deepEqual(data.supportingEvidence,original.observation.supportingEvidence);assert.equal(data.sources.length,2);
  const supporting=data.sources.find(source=>source.role==='municipality_join')!;assert.equal(supporting.sha256,original.supportingSources[0].sha256);assert.equal(supporting.policyReceiptSha256,original.supportingSources[0].policyReceiptSha256);
 }finally{await client.close();await mcp.close();}
});

test('native knowledge change feeds preserve reasons and revisions without invented withdrawal or quotes',async()=>{
 const {index,records}=await fixture(),loaded=await loadRelease();
 const rows=records.map(knowledgeChangeRecord),changes=diff([],rows,retrievedAt);
 assert.equal(changes.schemaVersion,'stadtstack-changes-v2');assert.equal(changes.events.length,records.length);
 for(const event of changes.events){
  assert.equal(event.recordType,'knowledge');assert.equal(event.kind,'added');assert.ok(event.reason);assert.equal(event.previous,null);assert.equal(event.evidence,null);assert.equal(event.targetRevision,null);
  const original=records.find(record=>record.id===event.id)!;assert.equal(event.current?.evidenceHash,original.verification.evidenceHash);assert.ok(event.current?.sourceHashes.includes(original.source.sha256));
 }
 const removed=diff(rows,[],retrievedAt);assert.ok(removed.events.every(event=>event.kind==='removed'&&event.evidence===null&&event.previous?.evidenceHash&&event.current===null&&event.targetRevision===null));
 const mcp=server({release:{...loaded,index,changes:{...loaded.changes,ratzeburg:changes}}}),client=new Client({name:'synthetic-native-changes-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const result=await client.callTool({name:'get_changes',arguments:{cityId:'ratzeburg'}});assert.equal(result.isError,undefined);assert.deepEqual(changesSchema.parse(result.structuredContent),changes);
  const tools=await client.listTools();assert.match(tools.tools.find(tool=>tool.name==='get_changes')!.description!,/removal is not source withdrawal or supersession/);
  assert.ok(index.records.every(record=>record.supersession?.status==='not_established'&&!record.supersession.currentValues.length),'Numeric native values alone do not establish metric replacement or current-value election');
 }finally{await client.close();await mcp.close();}
});

test('native field search borrows only exact record context while retaining amount/date/role evidence',async()=>{
 const binding={nativeId:'operation-42',nativeVersion:'v1',subject:'funding-operation:42'};
 const label:FixtureNativeRow={...binding,id:'label',kind:'FundingOperation',predicate:'operation_name',value:'Solarpark Schulcampus',date:null,dateRole:null,financialRole:'none'};
 const amount:FixtureNativeRow={...binding,id:'amount',kind:'FundingOperation',predicate:'approved_amount',value:82000,date:null,dateRole:null,financialRole:'approval'};
 const date:FixtureNativeRow={...binding,id:'approval-date',kind:'FundingOperation',predicate:'approval_date',value:'2025-08-07',date:'2025-08-07',dateRole:'approval_date',financialRole:'none'};
 const extraRows=[label,amount,date,{...amount,id:'different-id',nativeId:'operation-99',value:91000},{...amount,id:'different-version',nativeVersion:'v2',value:92000},{...amount,id:'different-subject',subject:'funding-operation:other',value:93000}];
 const {index,records}=await fixture(fixtureScope,[],[],false,extraRows);
 const projected=index.records.find(record=>record.observation?.value===82000)!;
 assert.equal(projected.eventDate,null);assert.equal(projected.financialRole,'approval');assert.equal(projected.canonicalStage,null);assert.equal(projected.stageQuote,undefined);assert.equal(projected.nativeRecordContext?.memberRecordIds.length,3);
 assert.equal(projected.nativeRecordContext?.binding.nativeId,'operation-42');assert.equal(projected.nativeRecordContext?.binding.nativeVersion,'v1');
 const page=index.page({query:'Solar',topic:'solarpark',financialRole:'approval',fields:['id','observation','evidence','financialRole','nativeRecordContext','eventDate','stageQuote']},'search_topics');
 assert.equal(page.total,1);assert.equal(page.items[0].id,projected.id);assert.deepEqual(page.items[0].evidence,records.find(record=>record.id===projected.id)!.observation.evidence);
 assert.equal(index.page({query:'Schulcampus',financialRole:'approval'},'search_topics').total,1);
 assert.equal(index.page({query:'Solar',dateRole:'approval_date',dateFrom:'2025-08-07',dateTo:'2025-08-07'},'search_topics').total,1);
 assert.equal(index.page({query:'Solar',financialRole:'approval',dateFrom:'2025-08-07'},'search_topics').total,0,'A sibling date is not copied into the amount field');
 assert.ok(projected.topics.every(topic=>!('quote' in topic)&&!('confidence' in topic)),'Native topic context is a rule/provenance link, not an invented text quote');
 const exported=index.exportRecords({financialRole:'approval'});assert.ok(exported.items.every(record=>!('nativeSearchText' in record)));
 assert.equal(exported.totalCases,0);assert.equal(exported.identifiedProjectCount,0);
 const loaded=await loadRelease(),mcp=server({release:{...loaded,index}}),client=new Client({name:'native-field-context-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);await client.connect(clientTransport);
 try{
  const result=await client.callTool({name:'search_topics',arguments:{query:'Solar',topic:'solarpark',financialRole:'approval',fields:['id','observation','evidence','nativeRecordContext','financialRole']}});
  assert.equal(result.isError,undefined);const data=result.structuredContent as {items:Array<{id:string;nativeRecordContext:{memberRecordIds:string[]}}>};assert.equal(data.items.length,1);assert.equal(data.items[0].id,projected.id);assert.equal(data.items[0].nativeRecordContext.memberRecordIds.length,3);
 }finally{await client.close();await mcp.close();}
 const otherScope=await fixture({...fixtureScope,municipalityId:'moelln',ags:'01053090'},[],[],false,extraRows);
 const otherBytes=await fixture(fixtureScope,[],[],false,[amount]);
 const merged=new QueryIndex(digest('context-isolation-release'),retrievedAt,[],regional,catalogue,{records:[...records,...otherScope.records,...otherBytes.records],municipalities:[...index.knowledge!.municipalities,...otherScope.index.knowledge!.municipalities],coverage:{municipalities:[]}});
 assert.equal(merged.page({query:'Solar',financialRole:'approval'},'search_topics').total,2);
 const matches=merged.records.filter(record=>record.observation?.value===82000);
 assert.equal(new Set(matches.map(record=>record.nativeRecordContext!.id)).size,3,'Different scopes or source bytes do not share field context');
});
