import {test} from 'node:test';
import assert from 'node:assert/strict';
import {QueryIndex,type KnowledgeQueryData,type Regional} from '../src/mcp-query.ts';
import type {Catalogue} from '../src/schema.ts';
import {knowledgeEvidenceHash,REQUIRED_DETERMINISTIC_CHECKS,type DistrictKnowledgeRecord} from '../src/district-schema.ts';
import {matchesFilters} from '../src/district-query.ts';
import {textMatches} from '../src/topics.ts';

// Synthetic test evidence only; these fixtures are never written to the released corpus.
const municipalities=['strausberg','hoppegarten','ruedersdorf-bei-berlin','ratzeburg','moelln','schwarzenbek','ludwigslust','parchim','hagenow'].map((id,index)=>({id,name:id,ags:`0000000${index}`,districtId:['maerkisch-oderland','herzogtum-lauenburg','ludwigslust-parchim'][Math.floor(index/3)],sources:[]}));
const date='2026-10-10T12:00:00Z',digest='a'.repeat(64);
const regional:Regional={schemaVersion:'stadtstack-regional-topics-v1',generatedAt:date,asOf:'2026-10-10',region:{id:'brandenburg-mol',name:'MOL'},municipalities:[],topics:[]};
const catalogue:Catalogue={schemaVersion:'stadtstack-signals-v1',generatedAt:date,publisher:'Test',cities:[]};
function record(cityIndex:number,stage:DistrictKnowledgeRecord['stage']='draft',suffix=''):DistrictKnowledgeRecord {
 const city=municipalities[cityIndex],title='Kommunale Wärmeplanung und Fernwärmenetz';
 const fixture:DistrictKnowledgeRecord={id:`knowledge:${city.id}${suffix}`,municipalityId:city.id,ags:city.ags,districtId:city.districtId,caseKey:`case:${city.id}${suffix}`,caseKeyType:'plan_number',caseType:'planning',caseQuote:'Plan 1',title,titleQuote:title,summary:title,summaryQuote:title,municipalityQuote:city.id,documentDate:'2026-09-20',documentDateQuote:'20.09.2026',documentDateReason:null,topics:[{id:'waermeplanung',parentId:'energie',provenance:'model',confidence:0.9,quote:'Wärmeplanung'}],stage,stageDate:'2026-09-19',stageDateQuote:'19.09.2026',stageDateReason:null,originalStatus:stage,stageQuote:stage==='unknown'?'':stage,stages:[],entities:[],locations:[],sources:[{id:`registry:${city.id}`,url:`https://example.org/${city.id}${suffix}.pdf`,sha256:digest,retrievedAt:date,locator:'Seite 1',mimeType:'application/pdf',sourceType:'website',policy:{robots:{state:'allowed',url:'https://example.org/robots.txt',checkedAt:date},tdm:{state:'not_declared',evidence:[]},access:'public',legalClassification:'not_assessed',publication:'facts_with_attribution_only'}}],extraction:{extractorVersion:'test',extractorSha256:digest,model:'test-model',provider:'openai-subscription',tool:'codex-cli',toolVersion:'synthetic-fixture',modelIdentitySha256:digest,modelIdentityBasis:'configured-cli-model-and-tool-version',returnedModel:null,promptVersion:'test',promptSha256:digest,judgePromptVersion:'test',judgePromptSha256:digest,inputSha256:digest,textSha256:digest,responseSha256:digest,ocrUsed:false,textMethod:'pdf_text',cacheKey:digest,extractedAt:date,chunk:{index:0,count:1,start:0,end:100}},verification:{status:'auto-verified',deterministic:{passed:true,checks:REQUIRED_DETERMINISTIC_CHECKS.map(id=>({id,passed:true,reason:'synthetic query fixture'}))},faithfulness:{score:0.9,threshold:0.8,model:'test-model',provider:'openai-subscription',tool:'codex-cli',toolVersion:'synthetic-fixture',modelIdentitySha256:digest,returnedModel:null,reason:'fixture',evaluatedAt:date,responseSha256:digest,sameModel:true,limitation:'Same-model judgment is not independent verification.'},evidenceHash:digest}};
 fixture.sources[0].policy.tdm.evidence.push({url:fixture.sources[0].url,locator:'PDF.js 6.3.289 XMP metadata (pdf-tdm-v2)',value:'no_tdm_reservation_field',sha256:fixture.sources[0].sha256,checkedAt:date});
 fixture.verification.evidenceHash=knowledgeEvidenceHash(fixture);
 return fixture;
}
function index(records=municipalities.map((_,i)=>record(i))) {
 for(const item of records)item.verification.evidenceHash=knowledgeEvidenceHash(item);
 const coverage={schemaVersion:'test-only',municipalities:municipalities.map(city=>{const matching=records.filter(record=>record.municipalityId===city.id);return {id:city.id,status:matching.length?'gated_records':'checked_no_gated_records',documents:1,publishedRecords:matching.length,datedStagedRecords:matching.filter(record=>record.stage!=='unknown').length,quarantinedRecords:0};})};
 const knowledge:KnowledgeQueryData={records,municipalities,coverage};
 return new QueryIndex(digest,date,[],regional,catalogue,knowledge);
}
test('nine municipalities across three districts share search, hierarchy and source lookup',()=>{
 const query=index();
 assert.equal(query.page({topic:'energie'},'search_topics').total,9);
 assert.equal(query.listTopics().topics.find(topic=>topic.id==='energie')?.total,9);
 assert.equal(new Set(query.records.map(item=>item.districtId)).size,3);
 for(const item of query.records){assert.equal(item.topics[0].confidence,0.9);assert.equal(item.topics[0].quote,'Wärmeplanung');assert.equal(query.sources.get(item.sourceIds[0])?.registrySourceId,`registry:${item.cityId}`);}
 const comparison=query.compareTopic('waermeplanung',municipalities.map(city=>city.id));
 assert.equal(comparison.cities.length,9);assert.ok(comparison.cities.every(city=>city.recordCount===1&&city.furthestPositiveMilestone?.stage==='draft'));
});
test('rejected withdrawn unknown candidate and undated evidence never become positive progress',()=>{
 const rejected=record(0,'rejected'),withdrawn=record(1,'withdrawn'),unknown=record(2,'unknown'),candidate=record(3,'implemented'),undated=record(4,'implemented');
 candidate.verification.status='candidate';candidate.verification.faithfulness.score=null;
 undated.documentDate=null;undated.documentDateReason='Unknown';undated.stageDate=null;undated.stageDateReason='Unknown';
 const query=index([rejected,withdrawn,unknown,candidate,undated,record(5,'adopted'),record(5,'draft',':other')]);
 const result=query.compareTopic('energie',municipalities.map(city=>city.id));
 assert.equal(result.cities[0].stageCounts.rejected,1);assert.equal(result.cities[1].stageCounts.withdrawn,1);
 for(const city of result.cities.slice(0,5))assert.equal(city.furthestPositiveMilestone,null);
 assert.equal(result.cities[2].unknownStageCount,1);assert.equal(result.cities[3].candidateCount,1);assert.equal(result.cities[4].latestSourceDate,null);assert.equal(result.cities[4].latestStageDate,null);
 assert.equal(result.cities[5].furthestPositiveMilestone?.stage,'adopted');assert.equal(result.cities[5].recordCount,2);
 assert.equal(result.cities[6].recordCount,0);assert.match(result.cities[6].unknowns[0],/not evidence of municipal inactivity/);
 assert.equal(query.sources.size,7); // Same registry source, distinct source document IDs.
});
test('shared filters preserve German synonyms, date semantics and explicit OSM exclusion',()=>{
 const query=index();
 assert.equal(query.compareTopic('energie',['ratzeburg'],{query:'Fernwärme',sourceTypes:['website'],recordTypes:['planning'],dateFrom:'2026-09-19',dateTo:'2026-09-19'}).cities[0].recordCount,1);
 assert.equal(query.compareTopic('energie',['ratzeburg'],{dateFrom:'2026-09-20'}).cities[0].recordCount,0);
 assert.throws(()=>query.compareTopic('energie',['ratzeburg'],{dateFrom:'2026-10-01',dateTo:'2026-01-01'}),/dateFrom/);
 assert.throws(()=>query.compareTopic('planning',['ratzeburg']),/Unknown topic/);
 assert.throws(()=>query.compareTopic('energie',['missing']),/Unknown city/);
 assert.equal(matchesFilters({...query.records[0],sourceTypes:['osm']},{excludeOSM:true}),false);
 assert.equal(textMatches('Kindertagesstättenerweiterung','Kita'),true);
 assert.equal(textMatches('Fernwärmeleitungsbau','Wärmeplanung'),true);
 assert.equal(textMatches('Fahrradverbindung','Radweg'),true);
});
test('similarity is deterministic cross-city discovery with evidence and no invented model',()=>{
 const query=index(),id=query.records[0].id;
 const result=query.similar(id,{},50);
 assert.deepEqual(result,query.similar(id,{},50));assert.equal(result.items.length,8);
 assert.equal(result.method.model,null);assert.equal(result.method.version,'district-similarity-v1');
 assert.ok(result.items.every(item=>item.cityId!==result.target.cityId&&item.score>0&&item.score<=1&&item.sharedTopics.includes('waermeplanung')&&item.sourceIds.length));
 assert.equal(new Set(result.items.map(item=>item.districtId)).size,3);
 assert.equal(query.similar(id,{cityIds:['ratzeburg']}).items[0].cityId,'ratzeburg');
 assert.throws(()=>query.similar('missing'),/not found/);
 assert.throws(()=>query.similar(id,{},51),/limit/);
});

test('quoted historical milestones remain distinguishable from rejection and retrieval time',()=>{
 const item=record(0,'rejected');
 item.stages=[{stage:'adopted',date:'2026-08-01',dateQuote:'01.08.2026',originalStatus:'angenommen',quote:'angenommen'}];
 item.stageDate=null;item.stageDateQuote=null;item.stageDateReason='No date for rejection stated';
 const query=index([item]),city=query.compareTopic('waermeplanung',['strausberg']).cities[0];
 assert.equal(city.stageCounts.rejected,1);assert.equal(city.stageCounts.adopted,0);
 assert.equal(city.furthestPositiveMilestone?.stage,'adopted');
 assert.equal(city.furthestPositiveMilestone?.evidence[0].stage,'rejected');
 assert.equal(city.furthestPositiveMilestone?.evidence[0].milestone.quote,'angenommen');
 assert.equal(city.latestStageDate,'2026-08-01');assert.equal(city.latestSourceDate,'2026-09-20');
 const projected=query.page({fields:['id','stages','stageDateReason','documentDateQuote','extraction']},'search_topics').items[0];
 assert.deepEqual(projected.stages,item.stages);assert.equal(projected.stageDateReason,item.stageDateReason);assert.deepEqual(projected.extraction,item.extraction);
});
test('future announcements are not achieved positive progress and date roles remain distinct',()=>{
 const item=record(0,'in_force');item.stageDate='2027-01-01';item.stageDateQuote='01.01.2027';
 item.sources[0].retrievedAt='2026-10-09T12:00:00Z';
 item.caseType='infrastructure';
 const query=index([item]),projected=query.records[0];
 assert.equal(projected.recordType,'infrastructure');
 assert.equal(projected.eventDate,'2027-01-01');assert.equal(projected.documentDate,'2026-09-20');
 assert.notEqual(projected.asOf,query.releasedAt);
 assert.equal(query.compareTopic('waermeplanung',['strausberg']).cities[0].furthestPositiveMilestone,null);
});
test('comparison bounds milestone evidence and does not repeat whole-release coverage',()=>{
 const query=index(Array.from({length:12},(_,i)=>record(0,'adopted',`:${i}`)));
 const city=query.compareTopic('waermeplanung',['strausberg']).cities[0];
 assert.equal(city.furthestPositiveMilestone?.evidenceCount,12);
 assert.equal(city.furthestPositiveMilestone?.evidence.length,5);
 const coverage=city.coverage;assert.ok(coverage&&typeof coverage==='object'&&'sourceCoverage' in coverage);
 assert.equal('releaseCoverage' in coverage,false);
 const scoped=coverage.sourceCoverage;assert.ok(scoped&&typeof scoped==='object'&&'id' in scoped);
 assert.equal(scoped.id,'strausberg');
});
test('unresolved source-document groups are not reported as identified civic cases',()=>{
 const item=record(0);item.caseKeyType='source_document';item.caseKey=`source_document:${item.extraction.inputSha256}`;item.caseQuote=null;
 const city=index([item]).compareTopic('waermeplanung',['strausberg']).cities[0];
 assert.equal(city.recordCount,1);assert.equal(city.caseCount,0);assert.equal(city.sourceDocumentGroupCount,1);
});

test('Municipality discovery projects identities and source summaries, not full registry payloads',()=>{
 const source={id:'fixture-source',kind:'website',url:'https://example.org/',checkState:'checked' as const,evidence:[{locator:'Synthetic detailed policy evidence'}]};
 const city={...municipalities[0],administrativeStatus:'amtsfrei' as const,amt:null,sources:[source],seedDocuments:[{title:'Synthetic private ingestion detail'}]};
 const query=new QueryIndex(digest,date,[],regional,catalogue,{records:[],municipalities:[city],coverage:{municipalities:[{id:city.id,status:'checked_no_gated_records',documents:1,publishedRecords:0,datedStagedRecords:0,quarantinedRecords:0}]}});
 const projected=query.municipalities.get(city.id)!;
 assert.equal(projected.ags,city.ags);assert.equal(projected.administrativeStatus,'amtsfrei');assert.equal(projected.amt,null);
 assert.equal('seedDocuments' in projected,false);
 assert.deepEqual(projected.sources,[{id:source.id,kind:source.kind,url:source.url,checkState:source.checkState}]);
});

test('Checked towns without gated records remain explicit in topic and comparison discovery',()=>{
 const query=index([]);
 const topics=query.listTopics(['ratzeburg']);
 assert.equal(topics.cities[0].recordCoverage?.status,'checked_no_gated_records');
 assert.equal(topics.cities[0].recordCoverage?.publishedRecords,0);
 const compared=query.compareTopic('waermeplanung',['ratzeburg']).cities[0];
 assert.equal(compared.recordCount,0);
 const coverage=compared.coverage;assert.ok(coverage&&typeof coverage==='object'&&'sourceCoverage' in coverage);
 const source=coverage.sourceCoverage;assert.ok(source&&typeof source==='object'&&'status' in source);
 assert.equal(source.status,'checked_no_gated_records');
});
