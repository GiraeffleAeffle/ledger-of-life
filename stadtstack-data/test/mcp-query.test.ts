import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {signal,sourceFrom,hash,outDir} from '../src/common.ts';
import {catalogueSchema,collectionSchema,type Catalogue,type Signal} from '../src/schema.ts';
import {QueryIndex,regionalSchema,querySchema,queryFields,publicData,exportRecordsSchema,type Regional} from '../src/mcp-query.ts';
import {assignTopics,assertTopic} from '../src/topics.ts';
import {searchText} from '../src/mcp.ts';
import {assignCaseIdentities} from '../src/query-cases.ts';

const catalogue:Catalogue={schemaVersion:'stadtstack-signals-v1',generatedAt:'2026-10-10T12:00:00Z',publisher:'Test',cities:[{id:'strausberg',name:'Strausberg',state:'Brandenburg',center:[13.88,52.58],bbox:[13,52,14,53],sources:[]}]};
const regional:Regional={schemaVersion:'stadtstack-regional-topics-v1',generatedAt:'2026-10-09T12:00:00Z',asOf:'2026-10-09',region:{id:'brandenburg-mol',name:'Märkisch-Oderland'},municipalities:[{id:'hoppegarten',name:'Hoppegarten',ags:'12064227'},{id:'strausberg',name:'Strausberg',ags:'12064472'}],topics:[{id:'waermeplanung',label:'Kommunale Wärmeplanung',municipalities:[{municipalityId:'hoppegarten',stage:'planning',items:[{title:'Kommunale Wärmeplanung in Hoppegarten',url:'https://www.gemeinde-hoppegarten.de/news/1/1240589/nachrichten/kommunale-w%C3%A4rmeplanung-in-hoppegarten.html',date:'2026-05-27',sourceType:'cityWebsite',locator:'Veröffentlichung: 27. Mai 2026',stage:'planning'},{title:'Wärmeplanung und Wärmenetz: Datum offen',url:'https://www.gemeinde-hoppegarten.de/seite/864034/kommunale-w%C3%A4rmeplanung.html',date:null,sourceType:'cityWebsite',locator:'Planung; kein dokumentiertes Datum',stage:'planning'}]}]}]};
function feature(id:string,title:string,kind:Signal['properties']['kind']='planning',date:string|null='2026-09-01') {
  const bytes=new Uint8Array([1]);
  return signal({id:`test:${id}`,cityId:'strausberg',kind,category:'Verkehr & Infrastruktur',title,statement:title,status:'Quelle prüfen',startDate:date,endDate:null,nextStep:'Quelle prüfen',unknowns:[],scale:'city',geometryPrecision:'none',sources:[sourceFrom({body:bytes,sha256:hash(bytes),retrievedAt:'2026-10-09',url:'https://example.org/source'},'Document','Publisher',`item ${id}`)],extraction:{method:'structured'},reviewState:'candidate',asOf:'2026-10-09'},null);
}
function index() {
  return new QueryIndex('a'.repeat(64),'2026-10-10T12:00:00Z',[feature('solar','Solarpark am Flugplatz'),feature('heat','Am Biotop · Fernwärmeleitung'),feature('pv','Photovoltaik auf kommunalen Gebäuden','council_paper'),feature('undated','Solarpark ohne Quelldatum','planning',null),feature('place','Solar Sportplatz','place',null)],regional,catalogue);
}

test('shared topics match subject text, not category or planning record type',()=>{
  const query=index();
  assert.equal(query.page({topic:'solarpark'},'search_topics').total,1);
  assert.equal(query.page({topic:'waermeplanung'},'search_topics').total,2);
  assert.equal(query.page({query:'Solar'},'search_topics').total,3);
  assert.equal(query.page({query:'Solar',excludePlaces:true},'search_topics').total,2);
  assert.deepEqual(searchText([feature('heat','Am Biotop · Fernwärmeleitung')],undefined,'waermeplanung').map(item=>item.properties.id),['test:heat']);
  assert.throws(()=>assertTopic('planning'),/record types/);
  assert.throws(()=>query.page({topic:'does-not-exist'},'search_topics'),/Unknown topic/);
  assert.throws(()=>query.page({cityIds:['does-not-exist']},'search_topics'),/Unknown city/);
  const tag=assignTopics('Fernwärmeleitung Am Biotop',['source:one'])[0];
  assert.equal(tag.id,'waermeplanung');assert.equal(tag.assignment,'rule');assert.ok(tag.evidence.includes('Fernwärmeleitung'));assert.deepEqual(tag.sourceIds,['source:one']);assert.equal('confidence' in tag,false);
});
test('regional municipalities appear in main search without invented catalogue coverage',()=>{
  const query=index();
  const page=query.page({cityIds:['hoppegarten'],topic:'waermeplanung'},'search_topics');
  assert.equal(page.total,1);assert.equal(page.items[0].cityId,'hoppegarten');assert.match(String(page.items[0].id),/^regional:[a-f0-9]{64}$/);
  assert.equal(query.municipalities.get('hoppegarten')?.coverage,'regional_evidence_only');
  assert.equal(query.listTopics(['hoppegarten']).topics.find(topic=>topic.id==='waermeplanung')?.perCity[0].count,1);
  assert.equal(query.listTopics(['hoppegarten']).topics.find(topic=>topic.id==='waermeplanung')?.perCity[0].withheldCount,1);
  const discovery=query.page({cityIds:['hoppegarten'],fields:['id','eventDate','asOf','comparisonEligible','comparisonReason']},'get_regional_topics',query.records.filter(item=>item.origin==='regional'),null,true);
  assert.equal(discovery.total,2);assert.ok(discovery.items.some(item=>item.eventDate===null&&item.comparisonEligible===false&&item.asOf==='2026-10-09'));
  assert.equal(query.page({cityIds:['hoppegarten'],dateFrom:'2026-01-01'},'get_regional_topics',query.records.filter(item=>item.origin==='regional'),null,true).total,0);
});
test('cursor is signed and bound to whole release, tool, filters, limit and projection',()=>{
  const query=index(),options={limit:1,fields:['id','sourceIds'] as ('id'|'sourceIds')[]};
  const first=query.page(options,'search_topics'),firstCursor=first.nextCursor;assert.ok(firstCursor);
  const second=query.page({...options,cursor:firstCursor},'search_topics');assert.notEqual(first.items[0].id,second.items[0].id);
  assert.throws(()=>query.page({...options,cursor:firstCursor,query:'Solar'},'search_topics'),/mismatch/);
  assert.throws(()=>query.page({...options,cursor:firstCursor,limit:2},'search_topics'),/mismatch/);
  assert.throws(()=>query.page({...options,cursor:firstCursor,fields:['title']},'search_topics'),/mismatch/);
  assert.throws(()=>query.page({...options,cursor:firstCursor},'get_council_items'),/mismatch/);
  assert.throws(()=>new QueryIndex('b'.repeat(64),query.releasedAt,[],regional,catalogue).page({...options,cursor:firstCursor},'search_topics'),/mismatch/);
  const [payload,signature]=firstCursor.split('.');
  const tampered=`${payload}.${signature[0]==='A'?'B':'A'}${signature.slice(1)}`;
  assert.throws(()=>query.page({...options,cursor:tampered},'search_topics'),/Invalid/);
  for(const cursor of ['bad','{}','a.b.c'])assert.throws(()=>query.page({...options,cursor},'search_topics'),/Invalid/);
  const decoded=JSON.parse(Buffer.from(payload,'base64url').toString());assert.deepEqual(Object.keys(decoded).sort(),['after','binding','release','v']);assert.equal(decoded.release,'a'.repeat(64));
  const seen:string[]=[];let cursor:string|null=null;
  do {const page=query.page({...options,cursor:cursor??undefined},'search_topics');seen.push(...page.items.map(item=>String(item.id)));cursor=page.nextCursor;}while(cursor);
  assert.equal(new Set(seen).size,seen.length);assert.equal(seen.length,query.page({},'search_topics').total);
});
test('bounded projections and separate source IDs avoid duplicate attribution payloads',()=>{
  const query=index(),page=query.page({fields:['id','sourceIds']},'search_topics');
  assert.deepEqual(Object.keys(page.items[0]).sort(),['id','sourceIds']);
  for(const record of query.records)for(const sourceId of record.sourceIds)assert.ok(query.sources.get(sourceId));
  assert.equal(JSON.stringify(query.page({fields:[...queryFields]},'search_topics')).includes('"sources":'),false);
  assert.equal(querySchema.safeParse({offset:1}).success,false);
  assert.equal(querySchema.safeParse({fields:['sources']}).success,false);
  assert.equal(querySchema.safeParse({limit:51}).success,false);
  assert.equal(querySchema.safeParse({dateFrom:'2026-02-30'}).success,false);
  assert.throws(()=>query.page({dateFrom:'2026-10-10',dateTo:'2026-01-01'},'search_topics'),/dateFrom/);
  assert.deepEqual(publicData({url:'http://localhost:4317/private',safe:'https://www.stadt-strausberg.de/'}),{url:null,safe:'https://www.stadt-strausberg.de/'});
  assert.deepEqual(publicData({id:'atlas:solarpark',url:'javascript:alert(1)',snapshotUrl:'https://example.org/?access_token=not-a-credential',feedUrl:'cities/strausberg/feed.json'}),{id:'atlas:solarpark',url:null,snapshotUrl:null,feedUrl:'cities/strausberg/feed.json'});
  const measurement=new QueryIndex('a'.repeat(64),'2026-10-10T12:00:00Z',[feature('measurement','Historische Messung','measurement','2026-09-14')],regional,catalogue).records.find(record=>record.recordType==='measurement')!;
  assert.equal(measurement.dateSemantics,'source_event');assert.equal(measurement.eventDate,'2026-09-14');
  const place=query.records.find(record=>record.recordType==='place')!;assert.equal(place.dateSemantics,'observation');assert.equal(place.eventDate,null);assert.equal(place.comparisonEligible,true);
});
test('source families remain distinct from record types',()=>{
  const plan=feature('plan','Bebauungsplan');plan.properties.id='koeln-bplan:fixture';
  const road=feature('road','Baustelle','roadworks');road.properties.id='autobahn:fixture';
  const query=new QueryIndex('a'.repeat(64),'2026-10-10T12:00:00Z',[plan,road],regional,catalogue);
  assert.deepEqual(query.records.find(record=>record.id===plan.properties.id)!.sourceTypes,['arcgis-rest']);
  assert.equal(query.page({sourceTypes:['arcgis-rest'],recordTypes:['planning']},'search_topics').total,1);
  assert.equal(query.page({sourceTypes:['autobahn']},'search_topics').total,1);
  assert.throws(()=>query.page({sourceTypes:['planning']},'search_topics'),/Unknown source type/);
});
test('source-derived regional identities are stable across topic arrays and never collapse by title',()=>{
  const item=regional.topics[0].municipalities[0].items[0];
  const extra:Regional={...regional,topics:[...regional.topics,{id:'solarpark',label:'Solarpark',municipalities:[{municipalityId:'hoppegarten',stage:item.stage,items:[item,{...item,url:'https://www.gemeinde-hoppegarten.de/news/other'}]}]}]};
  const query=new QueryIndex('a'.repeat(64),'2026-10-10T12:00:00Z',[],extra,catalogue);
  assert.equal(query.records.length,3);
  const first=query.records.find(record=>record.sourceIds.includes(index().records.find(record=>record.origin==='regional'&&record.documentDate!==null)!.sourceIds[0]))!;
  assert.deepEqual(first.topics.map(topic=>topic.id).sort(),['solarpark','waermeplanung']);
});
test('released JSON supports known subjects and Hoppegarten in shared search',async()=>{
  const cat=catalogueSchema.parse(JSON.parse(await readFile(join(outDir,'catalogue.json'),'utf8'))),features:Signal[]=[];
  for(const city of cat.cities)features.push(...collectionSchema.parse(JSON.parse(await readFile(join(outDir,'cities',city.id,'signals.geojson'),'utf8'))).features);
  const region=regionalSchema.parse(JSON.parse(await readFile(join(outDir,'regions/brandenburg-mol/topics.json'),'utf8')));
  const query=new QueryIndex('c'.repeat(64),cat.generatedAt,features,region,cat);
  assert.ok(query.page({topic:'solarpark'},'search_topics').total>0);
  assert.ok(query.page({topic:'waermeplanung'},'search_topics').total>0);
  assert.ok(query.page({cityIds:['hoppegarten']},'search_topics').total>0);
  assert.throws(()=>query.page({topic:'planning'},'search_topics'),/Unknown topic/);
});

test('Strausberg Hoppegarten and adopted Rüdersdorf heat evidence share search and comparison eligibility',()=>{
 const towns=[
  {id:'strausberg',name:'Strausberg',stage:'draft',date:'2026-04-12',title:'Kommunale Wärmeplanung: Abschlussbericht zur Beratung',url:'https://www.stadt-strausberg.de/stadtentwicklung-2/kommunale-waermeplanung/',locator:'Abschnitt Öffentlichkeitsbeteiligung abgeschlossen'},
  {id:'hoppegarten',name:'Hoppegarten',stage:'planning',date:'2026-05-27',title:'Kommunale Wärmeplanung in Hoppegarten',url:'https://www.gemeinde-hoppegarten.de/news/1/1240589/nachrichten/kommunale-w%C3%A4rmeplanung-in-hoppegarten.html',locator:'Abschnitt zum Planungsverbund; Veröffentlichung'},
  {id:'ruedersdorf-bei-berlin',name:'Rüdersdorf bei Berlin',stage:'adopted',date:'2025-07-22',title:'Kommunale Wärmeplanung: Wärmeplan beschlossen',url:'https://www.ruedersdorf.de/meine-gemeinde/konzepte/kommunale-waermeplanung/',locator:'Abschnitt Wärmeplan beschlossen, erster Absatz'},
 ];
 const evidence:Regional={...regional,municipalities:towns.map(({id,name})=>({id,name})),topics:[{id:'waermeplanung',label:'Kommunale Wärmeplanung',municipalities:towns.map(town=>({municipalityId:town.id,stage:town.stage,items:[{title:town.title,url:town.url,date:town.date,stage:town.stage,sourceType:'cityWebsite',locator:town.locator}]}))}]};
 const query=new QueryIndex('a'.repeat(64),catalogue.generatedAt,[feature('heat','Fernwärmeleitung')],evidence,catalogue);
 for(const record of query.records.filter(record=>record.origin==='regional')){
  assert.equal(record.statement,'');assert.equal(record.statementStatus,'not_extracted');
  assert.equal(record.stageQuote,towns.find(town=>town.id===record.cityId)!.locator);
  assert.equal(record.locator,record.stageQuote);
 }
 const search=query.page({topic:'waermeplanung',fields:['id','cityId','comparisonEligible','caseId']},'search_topics');
 const comparison=query.compareTopic('waermeplanung',towns.map(town=>town.id));
 assert.equal(search.total,4);
 for(const city of comparison.cities){
  const eligible=search.items.filter(item=>item.cityId===city.cityId);
  assert.equal(city.sourceBackedRecordCount,eligible.length);
  assert.ok(eligible.every(item=>city.cases.some(row=>row.memberRecordIds.includes(String(item.id)))));
  assert.equal(city.furthestPositiveMilestone?.stage,towns.find(town=>town.id===city.cityId)!.stage);
  assert.equal(city.furthestPositiveMilestone?.evidence[0].milestone.evidenceBasis,'released_structured_stage');
 }
 const adopted=comparison.cities.find(city=>city.cityId==='ruedersdorf-bei-berlin')!;
 assert.equal(adopted.furthestPositiveMilestone?.date,'2025-07-22');
 assert.equal(adopted.cases[0].furthestSupportedDate,'2025-07-22');
 const hoppegarten=comparison.cities.find(city=>city.cityId==='hoppegarten')!;
 assert.equal(hoppegarten.cases[0].furthestSupportedStage,'planning');assert.equal(hoppegarten.cases[0].furthestSupportedDate,null);
 assert.equal(hoppegarten.latestStageDate,null);assert.equal(hoppegarten.latestSourceDate,'2026-05-27');assert.equal(hoppegarten.unknownStageCount,0);
 const exported=query.exportRecords({topic:'waermeplanung',municipality:'hoppegarten'});
 assert.equal(exported.items[0].documentDate,'2026-05-27');assert.equal(exported.items[0].eventDate,null);assert.equal(exported.items[0].stageDate,null);
 assert.equal(exported.items[0].dateSemantics,'source_document');assert.equal(exported.items[0].comparisonEligible,true);
 assert.equal(exported.cases[0].furthestSupportedDate,null);
 assert.equal(query.similar(exported.items[0].id).target.furthestSupportedDate,null);
 assert.equal(query.similar(query.records.find(record=>record.cityId==='hoppegarten')!.id).totalCases,3);
});

test('export includes complete evidence and only page source metadata with signed filter-bound cursors',()=>{
 const query=index(),first=query.exportRecords({limit:1});
 assert.equal(first.totalRecords,query.records.length);
 assert.ok(first.items[0].originalRecord);assert.equal(typeof first.items[0].statement,'string');assert.ok(first.items[0].caseIdentity);
 if(first.items[0].origin==='regional'&&first.items[0].statementStatus==='not_extracted'){assert.equal(first.items[0].statement,'');assert.ok(first.items[0].locator);assert.equal(first.items[0].stageQuote,first.items[0].locator);}
 assert.deepEqual(first.sources.map(source=>source.id).sort(),first.items[0].sourceIds.slice().sort());
 assert.ok(first.nextCursor);
 assert.throws(()=>query.exportRecords({limit:2,cursor:first.nextCursor!}),/mismatch/);
 assert.throws(()=>query.exportRecords({limit:1,municipality:'strausberg',cursor:first.nextCursor!}),/mismatch/);
 assert.throws(()=>query.exportRecords({limit:1,topic:'waermeplanung',cursor:first.nextCursor!}),/mismatch/);
 assert.throws(()=>new QueryIndex('b'.repeat(64),catalogue.generatedAt,[],regional,catalogue).exportRecords({limit:1,cursor:first.nextCursor!}),/mismatch/);
 assert.throws(()=>query.page({limit:1,cursor:first.nextCursor!},'search_topics'),/mismatch/);
 const [payload,signature]=first.nextCursor!.split('.');
 assert.throws(()=>query.exportRecords({limit:1,cursor:`${payload}.${signature[0]==='A'?'B':'A'}${signature.slice(1)}`}),/Invalid/);
 const records:typeof first.items=[],cases=new Set<string>();let cursor:string|undefined;
 do{const page=query.exportRecords({limit:1,cursor});records.push(...page.items);for(const record of page.items)cases.add(record.caseId!);assert.deepEqual(new Set(page.sources.map(source=>source.id)),new Set(page.items.flatMap(record=>record.sourceIds)));cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(new Set(records.map(record=>record.id)).size,query.records.length);
 assert.equal(cases.size,first.totalCases);
 assert.ok(records.some(record=>!record.comparisonEligible&&record.comparisonReason));
 assert.equal(query.exportRecords({topic:'waermeplanung',municipality:'hoppegarten'}).totalRecords,2);
 for(const input of [{limit:51},{limit:0},{limit:1.5},{municipality:'Invalid Town'},{fields:['id']},{offset:1}])assert.equal(exportRecordsSchema.safeParse(input).success,false);
 assert.throws(()=>query.exportRecords({municipality:'missing'}),/Unknown city/);
 assert.throws(()=>query.exportRecords({topic:'missing'}),/Unknown topic/);
});

test('city and regional plan records join via source numbers, not their common title',()=>{
 const plan=feature('plan','Bebauungsplan Nr. 68/23 Solarpark am Flugplatz');
 const item={title:'Bebauungsplan Nr. 68/23 Solarpark am Flugplatz',url:'https://bb.beteiligung.diplanung.de/verfahren/solarpark-flugplatz/public/detail',date:'2026-09-01',stage:'consultation',sourceType:'planningProcedure',locator:'DiPlan mapVars[procedureId=procedure-68]: externalName, publicParticipationStartDate 2026-09-01'};
 const evidence:Regional={...regional,topics:[{id:'solarpark',label:'Solarpark',municipalities:[{municipalityId:'strausberg',stage:'consultation',items:[item]}]}]};
 const query=new QueryIndex('a'.repeat(64),catalogue.generatedAt,[plan,feature('unknown','Solarpark am Flugplatz')],evidence,catalogue);
 const compared=query.compareTopic('solarpark',['strausberg']).cities[0];
 assert.equal(compared.recordCount,3);assert.equal(compared.caseCount,2);
 const identified=compared.cases.find(row=>row.identityStatus==='source_identified')!;
 assert.equal(identified.recordCount,2);
 assert.ok(identified.identityBasis.some(basis=>basis.type==='diplan'&&basis.value.endsWith(':procedure-68')));
 assert.equal(identified.furthestSupportedStage,null);
 assert.equal(identified.furthestSupportedDate,null);
 const participation=query.records.find(row=>row.origin==='regional')!;
 assert.equal(participation.stage,'consultation');
 assert.equal(participation.stageDate,'2026-09-01');
 assert.equal(compared.cases.find(row=>row.identityStatus==='unresolved')!.furthestSupportedStage,null);
});

test('city authoritative plan keys retain amendment suffixes and explicit legal-date stages',()=>{
 const plans=['base','base','amendment-1'].map((suffix,i)=>{
  const item=feature(`plan-${i}`,'Bebauungsplan 68/23 – Solarpark am Flugplatz');
  item.properties.id=`koeln-bplan:fixture-${i}`;
  item.properties.caseKey=`koeln-bplan:68/23:${suffix}`;
  item.properties.status='rechtskräftig seit 2026-09-01';
  item.properties.sources[0].locator=`layer[oid=${i}]; authoritative plan id=${item.properties.caseKey}; source legal date rechtskr=2026-09-01; properties and geometry`;
  return item;
 });
 const query=new QueryIndex('a'.repeat(64),catalogue.generatedAt,plans,{...regional,topics:[]},catalogue);
 const city=query.compareTopic('solarpark',['strausberg']).cities[0];
 assert.equal(city.caseCount,2);assert.equal(city.recordCount,3);
 assert.equal(city.cases.find(row=>row.recordCount===2)?.furthestSupportedStage,'in_force');
 assert.equal(city.cases.find(row=>row.recordCount===2)?.furthestSupportedDate,'2026-09-01');
 assert.ok(city.cases.every(row=>row.identityBasis.some(basis=>basis.quote.includes('authoritative plan id='))));
});

test('city and regional council records share an explicit paper reference',()=>{
 const paper=feature('paper','Vorlage BV/2026/17 Kommunale Wärmeplanung','council_paper');
 const item={title:paper.properties.title,url:'https://example.org/council/BV-2026-17',date:'2026-09-01',stage:'agenda',sourceType:'councilAgenda',locator:'Vorlage BV/2026/17'};
 const evidence:Regional={...regional,topics:[{id:'waermeplanung',label:'Wärmeplanung',municipalities:[{municipalityId:'strausberg',stage:'agenda',items:[item]}]}]};
 const query=new QueryIndex('a'.repeat(64),catalogue.generatedAt,[paper],evidence,catalogue);
 const city=query.compareTopic('waermeplanung',['strausberg']).cities[0];
 assert.equal(city.recordCount,2);assert.equal(city.caseCount,1);
 assert.ok(city.cases[0].identityBasis.some(basis=>basis.type==='paper_reference'&&basis.value==='bv/2026/17'));
});

test('regional consultation milestones use their own date roles, never publication or unrelated start dates',()=>{
 const base={title:'Bebauungsplan Nr. 68/23 Solarpark am Flugplatz',date:'2025-11-24',sourceType:'planningProcedure',locator:'DiPlan mapVars[procedureId=procedure-68]: publicParticipationStartDate 2025-11-24, publicParticipationEndDate 2026-01-12',participationEnd:'2026-01-12'};
 const items=[
  {...base,url:'https://example.org/closed',stage:'consultation_closed'},
  {...base,title:'Bebauungsplan Nr. 69/23 Solarpark',url:'https://example.org/open',stage:'consultation'},
  {...base,title:'Bebauungsplan Nr. 70/23 Solarpark',url:'https://example.org/evaluation',stage:'evaluation'},
  {...base,title:'Bebauungsplan Nr. 71/23 Solarpark',url:'https://example.org/missing-end',stage:'consultation_closed',participationEnd:undefined},
 ];
 const evidence:Regional={...regional,topics:[{id:'solarpark',label:'Solarpark',municipalities:[{municipalityId:'strausberg',stage:'evaluation',items}]}]};
 const query=new QueryIndex('a'.repeat(64),catalogue.generatedAt,[],evidence,catalogue);
 const exported=query.exportRecords({topic:'solarpark'});
 const closed=exported.items.find(item=>item.title===base.title)!;
 const open=exported.items.find(item=>item.title.includes('69/23'))!;
 const evaluation=exported.items.find(item=>item.title.includes('70/23'))!;
 const missingEnd=exported.items.find(item=>item.title.includes('71/23'))!;
 assert.equal(closed.stageDate,'2026-01-12');assert.equal(closed.eventDate,'2026-01-12');
 assert.ok(closed.originalRecord&&typeof closed.originalRecord==='object'&&'date' in closed.originalRecord);
 assert.equal(closed.originalRecord.date,'2025-11-24');
 assert.equal(open.stageDate,'2025-11-24');
 assert.equal(evaluation.eventDate,'2025-11-24');assert.equal(evaluation.stageDate,null);
 assert.equal(evaluation.stage,'evaluation');assert.equal(evaluation.canonicalStage,'unknown');
 // Participation locators do not establish an Abwägung event merely because the
 // regional item carries a coarse evaluation label.
 assert.equal(missingEnd.stageDate,null);assert.equal(missingEnd.comparisonEligible,true);
 const city=query.compareTopic('solarpark',['strausberg']).cities[0];
 assert.equal(city.latestStageDate,'2026-01-12');assert.equal(city.unknownStageCount,1);
 assert.equal(city.cases.find(row=>row.memberRecordIds.includes(closed.id))!.furthestSupportedStage,null);
 assert.equal(city.cases.find(row=>row.memberRecordIds.includes(closed.id))!.furthestSupportedDate,null);
 assert.equal(city.cases.find(row=>row.memberRecordIds.includes(evaluation.id))!.furthestSupportedDate,null);
 assert.equal(city.cases.find(row=>row.memberRecordIds.includes(missingEnd.id))!.furthestSupportedDate,null);
 assert.equal(query.compareTopic('solarpark',['strausberg'],{stage:'consultation',dateFrom:'2026-01-12',dateTo:'2026-01-12'}).cities[0].recordCount,1);
 assert.equal(closed.stage,'consultation_closed');assert.equal(closed.canonicalStage,'consultation');
 assert.equal(query.similar(closed.id).target.furthestSupportedStage,null);
 assert.equal(query.similar(closed.id).target.furthestSupportedDate,null);
});

test('a city event date without stage-specific evidence does not become a milestone date',()=>{
 const item=feature('known-stage','Kommunale Wärmeplanung');
 item.properties.status='draft';
 const query=new QueryIndex('a'.repeat(64),catalogue.generatedAt,[item],{...regional,topics:[]},catalogue);
 const city=query.compareTopic('waermeplanung',['strausberg']).cities[0];
 assert.equal(city.furthestPositiveMilestone?.stage,'draft');assert.equal(city.furthestPositiveMilestone?.date,null);
 assert.equal(city.latestStageDate,null);assert.equal(city.unknownStageCount,0);
});

test('single-record export includes source metadata for full-context metric history',()=>{
 const query=new QueryIndex('a'.repeat(64),catalogue.generatedAt,[feature('old-area','Synthetic plan area baseline'),feature('new-area','Synthetic plan area revision')],{...regional,topics:[]},catalogue);
 const old=query.records.find(record=>record.id==='test:old-area')!,next=query.records.find(record=>record.id==='test:new-area')!;
 old.metricClaims=[{metric:'plan_area',unit:'ha',value:68.6,scope:'fnp:synthetic',instrument:'fnp:synthetic',reportedAt:'2024-01-30',scopeEvidence:{quote:'Synthetic plan scope',sourceIds:old.sourceIds},evidence:{quote:'Synthetic baseline: 68.6 ha',sourceIds:old.sourceIds}}];
 next.metricClaims=[{metric:'plan_area',unit:'ha',value:41.5,scope:'fnp:synthetic',instrument:'fnp:synthetic',reportedAt:'2025-08-07',scopeEvidence:{quote:'Synthetic plan scope',sourceIds:next.sourceIds},evidence:{quote:'Synthetic revision: 41.5 ha',sourceIds:next.sourceIds},replaces:{value:68.6,evidence:{quote:'Synthetic reduction from 68.6 ha to 41.5 ha',sourceIds:next.sourceIds}}}];
 assignCaseIdentities(query.records,query.sources);
 const page=query.exportRecords({municipality:'strausberg',limit:1});
 assert.equal(page.items.length,1);assert.equal(page.cases[0].history.length,2);
 assert.deepEqual(page.sources.map(source=>source.id).sort(),[...old.sourceIds,...next.sourceIds].sort());
 assert.deepEqual(page.cases[0].metricEvidenceSourceIds.sort(),[...old.sourceIds,...next.sourceIds].sort());
 assert.ok(page.sources.some(source=>!page.items[0].sourceIds.includes(String(source.id))));
});
