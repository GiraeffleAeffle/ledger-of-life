import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assignCaseIdentities,caseEvidence,furthestMilestone,knowledgeMetricRecord,stageClaims} from '../src/query-cases.ts';
import {milestoneRank,normalizePlanningStage,planningStages} from '../src/planning-stages.ts';
import {areaClaimsFromQuote,resolveMetricSupersession,MetricClaimSchema,MetricEvidenceSchema,type MetricClaim,type MetricRecord} from '../src/case-supersession.ts';
import type {QueryRecord} from '../src/mcp-query.ts';
import type {DistrictKnowledgeRecord} from '../src/district-schema.ts';

function record(id:string,stage:string,quote:string,date:string|null=null):QueryRecord {
 return {id,cityId:'strausberg',recordType:'planning',title:'Bebauungsplan Nr. 68/23',statement:quote,topics:[],eventDate:null,endDate:null,dateSemantics:'source_document',documentDate:'2025-08-07',stageDate:date,status:stage,stage,stageQuote:quote,asOf:'2026-10-11',sourceIds:['source:test'],sourceTypes:['pdf'],comparisonEligible:true,comparisonReason:null,geometry:null,origin:'city',category:'planning'};
}
const evidence={quote:'Geltungsbereich',sourceIds:['source:test']};
function metric(id:string,value:number,reportedAt:string,replaces?:number):MetricRecord {
 const claim:MetricClaim={metric:'plan_area',unit:'ha',value,scope:'fnp:base:amendment:10',scopeEvidence:evidence,instrument:'fnp:base:amendment:10',reportedAt,evidence};
 if(replaces!==undefined)claim.replaces={value:replaces,evidence:{...evidence,quote:`Geltungsbereich von ${replaces} ha auf ${value} ha reduziert.`}};
 return {id,municipalityId:'strausberg',metricClaims:[claim]};
}

test('BauGB ordering separates initiation, preliminary draft, early and formal participation',()=>{
 assert.deepEqual(planningStages,['initiation','pre_draft','early_consultation','draft','formal_consultation','evaluation','adopted','approved','in_force']);
 assert.equal(normalizePlanningStage({stage:'decision',quote:'Aufstellungsbeschluss am 10.01.2024'}),'initiation');
 assert.equal(normalizePlanningStage({stage:'draft',quote:'VORENTWURF'}),'pre_draft');
 assert.equal(normalizePlanningStage({stage:'draft',quote:'Die Stadt plant die Aufstellung eines Bebauungsplans'}),'planning');
 assert.equal(normalizePlanningStage({stage:'decision',quote:'Abwägungsbeschluss'}),'evaluation');
 assert.equal(normalizePlanningStage({stage:'decision',quote:'Feststellungsbeschluss'}),'adopted');
 assert.equal(normalizePlanningStage({stage:'decision',quote:'Die Genehmigung wurde erteilt.'}),'approved');
 assert.notEqual(normalizePlanningStage({stage:'decision',quote:'Die Genehmigung wurde nicht erteilt.'}),'approved');
 for(const quote of ['frühzeitige Beteiligung','§ 3 Abs. 1 BauGB','§4(1) BauGB'])assert.equal(normalizePlanningStage({stage:'consultation',quote}),'early_consultation');
 for(const quote of ['§ 3 Abs. 2 BauGB','§4(2) BauGB','öffentliche Auslegung des Entwurfs'])assert.equal(normalizePlanningStage({stage:'consultation',quote}),'formal_consultation');
 for(const quote of ['Stellungnahme vom 09.02.2024','Beteiligung','Vorentwurf öffentlich ausgelegt'])assert.equal(normalizePlanningStage({stage:'consultation',quote}),'consultation');
 assert.equal(milestoneRank('consultation',true),null);
 assert.ok(milestoneRank('implemented',false)!>milestoneRank('draft',false)!);
});

test('draft outranks early and unspecific consultation without borrowing document dates',()=>{
 const early=record('early','consultation','frühzeitige Beteiligung','2024-02-09');
 const draft=record('draft','draft','Entwurf\n7. August 2025','2025-08-07');
 const generic=record('generic','consultation','Stellungnahme','2026-01-01');
 assert.equal(furthestMilestone([early,draft,generic],'2026-10-11')?.stage,'draft');
 assert.equal(furthestMilestone([early,draft,generic],'2026-10-11')?.date,'2025-08-07');
 draft.stageDate=null;
 assert.equal(furthestMilestone([early,draft],'2026-10-11')?.date,null);
 assert.equal(furthestMilestone([early,record('future','draft','Entwurf','2027-01-01')],'2026-10-11')?.stage,'early_consultation');
 assert.equal(stageClaims([record('pre','draft','Vorentwurf')],'2026-10-11')[0].stage,'pre_draft');
});

test('released Solarpark draft is 2025-08-07 and old 312ccd92 metric is not silently superseded',async()=>{
 const published=JSON.parse(await readFile(new URL('../out/knowledge/records.json',import.meta.url),'utf8')) as {records:DistrictKnowledgeRecord[]};
 const selected=published.records.filter(row=>row.id.includes('027c1ea340173a5051062eee')||row.caseKey==='68/23'||row.title.includes('68/23'));
 const query=selected.map(row=>({...record(row.id,row.stage,row.stageQuote,row.stageDate),origin:'knowledge' as const,title:row.title,titleQuote:row.titleQuote,caseKey:row.caseKey,caseKeyType:row.caseKeyType,caseQuote:row.caseQuote,verification:row.verification,documentDate:row.documentDate,summaryQuote:row.summaryQuote,stages:row.stages}));
 assignCaseIdentities(query,new Map());
 const numberedConsultation=query.find(row=>row.id==='knowledge:strausberg:cc50ddbe50c55e47621863ec')!;
 assert.ok(numberedConsultation);
 assert.equal(numberedConsultation.caseIdentity?.instrument?.value,'untyped:68/23');
 assert.equal(stageClaims([numberedConsultation],'2026-10-11')[0].rankingContext,'baugb');
 const milestone=furthestMilestone(query,'2026-10-11');
 assert.equal(milestone?.stage,'draft');assert.equal(milestone?.date,'2025-08-07');
 const old=published.records.find(row=>row.id.includes('312ccd92'))!;
 assert.ok(old);assert.equal(knowledgeMetricRecord(old).metricClaims[0]?.value,68.6);
 const state=resolveMetricSupersession(published.records.map(knowledgeMetricRecord),'2026-10-11');
 assert.equal(state.records.get(old.id)?.status,'not_established');
 assert.equal(state.records.get(old.id)?.currentValues.length,0);
});

test('explicit same-scope metric reduction returns replacement and full preserved history',()=>{
 const old=metric('old',68.6,'2024-01-30'),next=metric('next',41.5,'2025-08-07',68.6);
 const resolved=resolveMetricSupersession([old,next],'2026-10-11');
 assert.equal(resolved.records.get('old')?.status,'superseded');
 assert.equal(resolved.records.get('old')?.currentValues[0].claim.value,41.5);
 assert.deepEqual(resolved.records.get('old')?.history.map(entry=>entry.claim.value),[68.6,41.5]);
 assert.equal(resolved.relationships[0].replacementRecordId,'next');
 assert.equal(resolveMetricSupersession([old,next],'2025-01-01').relationships.length,0);
 assert.equal(old.metricClaims[0].value,68.6);
 const query=[record('old','draft','Vorentwurf'),record('next','draft','Entwurf')];
 query[0].metricClaims=old.metricClaims;query[1].metricClaims=next.metricClaims;
 assignCaseIdentities(query,new Map());
 assert.equal(query[0].supersession?.status,'superseded');
 assert.equal(caseEvidence(query,'2026-10-11').currentValues[0].claim.value,41.5);
});

test('recency, different instruments, municipalities, units and missing source evidence never replace claims',()=>{
 const old=metric('old',68.6,'2024-01-30');
 for(const mutate of [(next:MetricRecord)=>delete next.metricClaims[0].replaces,(next:MetricRecord)=>{next.metricClaims[0].scope='bplan:68/23';},(next:MetricRecord)=>{next.municipalityId='other';},(next:MetricRecord)=>{next.metricClaims[0].unit='m2';},(next:MetricRecord)=>{next.metricClaims[0].replaces!.evidence={quote:'',sourceIds:[]};},(next:MetricRecord)=>{next.metricClaims[0].reportedAt=null;}]){
  const next=metric('next',41.5,'2025-08-07',68.6);mutate(next);
  assert.equal(resolveMetricSupersession([old,next],'2026-10-11').records.get('old')?.status,'not_established');
 }
});

test('terminal conflicts remain unresolved and explicit chains select their terminal value',()=>{
 const old=metric('old',68.6,'2024-01-30'),next=metric('next',41.5,'2025-08-07',68.6),latest=metric('latest',40,'2026-01-01',41.5);
 const chain=resolveMetricSupersession([latest,old,next],'2026-10-11');
 assert.deepEqual(chain.currentValues.map(entry=>entry.claim.value),[40]);
 const conflict=resolveMetricSupersession([old,next,metric('conflict',50,'2026-01-01',68.6)],'2026-10-11');
 assert.equal(conflict.currentValues.length,0);
});

test('native structured locators support explicit replacement without invented quotations',()=>{
 const old=metric('old',68.6,'2024-01-30'),next=metric('next',41.5,'2025-08-07',68.6);
 for(const row of [old,next]){
  const native={kind:'structured' as const,sourceIds:['native:table'],locator:{sheet:'Plan',row:2,field:'area'}};
  row.metricClaims[0].evidence=native;row.metricClaims[0].scopeEvidence=native;
  if(row.metricClaims[0].replaces)row.metricClaims[0].replaces!.evidence={...native,locator:{sheet:'Plan',row:2,field:'replaces'}};
 }
 assert.equal(resolveMetricSupersession([old,next],'2026-10-11').records.get('old')?.status,'superseded');
});

test('area extraction requires an explicit reduction and does not derive capacity from area',()=>{
 const input={sourceIds:['source:report'],scope:'fnp:base:amendment:10',scopeQuote:'10. Änderung des Flächennutzungsplans',instrument:'fnp:base:amendment:10',reportedAt:'2025-08-07'};
 const claims=areaClaimsFromQuote({...input,quote:'In der Konkretisierung des Projektes wurde nach dem Vorentwurf der Geltungsbereich von ca. 68,6 ha auf nunmehr ca. 41,5 ha im südlichen Bereich reduziert.'});
 assert.equal(claims[0].value,41.5);assert.equal(claims[0].replaces?.value,68.6);
 assert.equal(claims.length,1);assert.equal(claims[0].unit,'ha');
 assert.equal(areaClaimsFromQuote({...input,quote:'Gesamtfläche von ca. 41,5 ha'})[0].replaces,undefined);
});

test('future, negated, historical and mixed quotations never promote a decision milestone',()=>{
 for(const quote of ['Satzungsbeschluss geplant','Feststellungsbeschluss vorgesehen','Der Satzungsbeschluss wurde nicht gefasst.','Die Genehmigung wird erteilt.','Genehmigungsbescheid beantragt','Hinweis auf den Satzungsbeschluss','Die Stellungnahme erläutert den Genehmigungsbescheid.','Nach dem Aufstellungsbeschluss wurde der Satzungsbeschluss gefasst.','Rückblick: Die Genehmigung wurde erteilt.']){
  assert.equal(normalizePlanningStage({stage:'decision',quote}),'decision',quote);
  assert.equal(furthestMilestone([record('mixed','decision',quote,'2025-08-07')],'2026-10-11'),null,quote);
 }
 assert.equal(normalizePlanningStage({stage:'adopted',quote:'Satzungsbeschluss geplant'}),'unknown');
 for(const quote of ['Frühzeitige Beteiligung nach § 3 Abs. 1; öffentliche Auslegung nach § 3 Abs. 2.','§4(2) BauGB nach früherer Beteiligung gemäß §4(1) BauGB','frühzeitige Beteiligung vorgesehen']){
  assert.equal(normalizePlanningStage({stage:'consultation',quote}),'consultation',quote);
 }
 assert.equal(normalizePlanningStage({stage:'consultation',quote:'Der Vorentwurf wurde frühzeitig öffentlich ausgelegt.'}),'early_consultation');
});

test('proposed, future and negated reductions do not create replacement facts',()=>{
 const input={sourceIds:['source:report'],scope:'fnp:10',scopeQuote:'10. Änderung des FNP',instrument:'fnp:10',reportedAt:'2025-08-07'};
 for(const quote of ['Der Geltungsbereich soll von 68,6 ha auf 41,5 ha reduziert werden.','Der Geltungsbereich wurde von 68,6 ha auf 41,5 ha nicht reduziert.','Der Geltungsbereich wird von 68,6 ha auf 41,5 ha reduziert werden.','Geplant ist, den Geltungsbereich von 68,6 ha auf 41,5 ha zu reduzieren.']){
  const claims=areaClaimsFromQuote({...input,quote});
  assert.equal(claims.some(claim=>claim.replaces),false,quote);
  const resolved=resolveMetricSupersession([metric('old',68.6,'2024-01-30'),{id:'next',municipalityId:'strausberg',metricClaims:claims}],'2026-10-11');
  assert.equal(resolved.relationships.length,0);
 }
});

test('legal instrument participates in replacements, conflicts and complete history even for project scopes',()=>{
 const old=metric('old',68.6,'2024-01-30'),next=metric('next',41.5,'2025-08-07',68.6),other=metric('other',50,'2025-08-08',68.6);
 for(const item of [old,next,other])item.metricClaims[0].scope='project:solarpark';
 other.metricClaims[0].instrument='bplan:68/23';
 const complete=resolveMetricSupersession([old,next,other],'2026-10-11');
 assert.equal(complete.currentValues[0].claim.value,41.5);
 assert.deepEqual(complete.records.get('old')?.history.map(entry=>entry.recordId),['old','next']);
 assert.equal(complete.records.get('other')?.status,'not_established');
 next.metricClaims[0].instrument='bplan:68/23';
 assert.equal(resolveMetricSupersession([old,next],'2026-10-11').relationships.length,0);
});

test('filtered case summaries retain full conflict history and subsequent explicit replacements',()=>{
 const metrics=[metric('old',68.6,'2024-01-30'),metric('next',41.5,'2025-08-07',68.6),metric('conflict',50,'2025-08-08',68.6)];
 const records=metrics.map(item=>({...record(item.id,'draft','Entwurf'),metricClaims:item.metricClaims}));
 assignCaseIdentities(records,new Map());
 const page=caseEvidence(records.slice(0,2),'2026-10-11');
 assert.equal(page.currentValues.length,0);assert.equal(page.history.length,3);
 const filtered=caseEvidence([records[1]],'2026-10-11');
 assert.equal(filtered.currentValues.length,0);assert.equal(filtered.history.length,3);
 assert.equal(caseEvidence([records[1]],'2025-08-07').currentValues[0].claim.value,41.5);
 records[2].metricClaims=metric('conflict',40,'2025-08-08',41.5).metricClaims;
 assignCaseIdentities(records,new Map());
 assert.equal(caseEvidence(records.slice(0,2),'2026-10-11').currentValues[0].claim.value,40);
});

test('BauGB evidence never changes unrelated civic ranking contexts',()=>{
 const planning=record('plan','draft','Entwurf','2025-08-07');
 const civic={...record('civic','implemented','Fernwärmenetz fertiggestellt','2025-08-08'),title:'Fernwärmenetz'};
 assert.equal(furthestMilestone([planning,civic],'2026-10-11')?.stage,'implemented');
 assert.equal(furthestMilestone([planning,civic],'2026-10-11')?.evidence[0].milestone.rankingContext,'civic');
 const excluded={...planning,documentDate:null,stageDate:null,eventDate:null};
 assert.equal(furthestMilestone([excluded,{...civic,stage:'consultation'}],'2026-10-11')?.stage,'consultation');
});

test('future passive resolutions stay unranked and historical preliminary drafts do not borrow draft dates',()=>{
 for(const quote of ['Der Satzungsbeschluss wird am 01.12.2026 gefasst.','Der Plan wird am 01.12.2026 genehmigt.']){
  assert.equal(normalizePlanningStage({stage:'decision',quote}),'decision');
  assert.equal(furthestMilestone([record('future','decision',quote)],'2026-10-11'),null);
 }
 const quote='Entwurf vom 07.08.2025, überarbeitet gegenüber dem Vorentwurf vom 30.01.2024';
 const draft=record('draft','draft',quote,'2025-08-07');
 const milestone=furthestMilestone([draft,record('early','consultation','frühzeitige Beteiligung','2024-02-09')],'2026-10-11');
 assert.equal(milestone?.stage,'draft');assert.equal(milestone?.date,'2025-08-07');
 assert.equal(normalizePlanningStage({stage:'draft',quote:'Gegenüber dem Vorentwurf wurde der Entwurf überarbeitet.',originalStatus:'Entwurf'}),'draft');
 assert.equal(normalizePlanningStage({stage:'draft',quote:'Vorentwurf und Entwurf werden erläutert.'}),'unknown');
});

test('completion auxiliaries bind to the reduction predicate rather than unrelated questions',()=>{
 const input={sourceIds:['source:report'],scope:'fnp:10',scopeQuote:'10. Änderung des FNP',instrument:'fnp:10',reportedAt:'2025-08-07'};
 for(const quote of ['Es ist zu prüfen, ob der Geltungsbereich von 68,6 ha auf 41,5 ha reduziert werden kann.','Wenn der Geltungsbereich von 68,6 ha auf 41,5 ha reduziert wurde, folgt die Beratung.','Es wurde geprüft, ob der Geltungsbereich von 68,6 ha auf 41,5 ha reduziert werden kann.']){
  assert.deepEqual(areaClaimsFromQuote({...input,quote}),[],quote);
 }
 for(const quote of ['Der Geltungsbereich wurde von 68,6 ha auf 41,5 ha reduziert.','Der Geltungsbereich ist von 68,6 ha auf 41,5 ha reduziert.','In der Konkretisierung des Projektes wurde nach dem Vorentwurf der Geltungsbereich von ca. 68,6 ha auf nunmehr ca. 41,5 ha im südlichen Bereich reduziert.']){
  const claims=areaClaimsFromQuote({...input,quote});assert.equal(claims[0]?.value,41.5,quote);assert.equal(claims[0]?.replaces?.value,68.6,quote);
 }
});

test('conditional and prospective decision complements are not affirmative accomplished clauses',()=>{
 for(const quote of ['Wenn die Genehmigung erteilt wird, kann das Vorhaben beginnen.','Es ist zu prüfen, ob die Genehmigung erteilt wurde.','Wenn der Satzungsbeschluss gefasst wird, beginnt die nächste Phase.','Es ist zu prüfen, ob der Satzungsbeschluss gefasst werden kann.','Falls der Aufstellungsbeschluss gefasst wurde, ist die Verwaltung zuständig.']){
  assert.equal(normalizePlanningStage({stage:'decision',quote}),'decision',quote);
  assert.equal(furthestMilestone([record('conditional','decision',quote)],'2026-10-11'),null,quote);
 }
 assert.equal(normalizePlanningStage({stage:'decision',quote:'Die Genehmigung wurde erteilt.'}),'approved');
 assert.equal(normalizePlanningStage({stage:'decision',quote:'Der Satzungsbeschluss wurde gefasst.'}),'adopted');
 assert.equal(normalizePlanningStage({stage:'decision',quote:'Der Aufstellungsbeschluss wurde gefasst.'}),'initiation');
});

test('canonical metric snapshots validate bounded native and text evidence without inventing quotes',()=>{
 assert.equal(MetricClaimSchema.safeParse(metric('old',68.6,'2024-01-30').metricClaims[0]).success,true);
 assert.equal(MetricEvidenceSchema.safeParse({kind:'structured',sourceIds:['native:table'],locator:{row:1,field:'area'}}).success,true);
 assert.equal(MetricEvidenceSchema.safeParse({kind:'structured',sourceIds:['native:table']}).success,false);
 assert.equal(MetricEvidenceSchema.safeParse({sourceIds:['source:one']}).success,false);
 assert.equal(MetricEvidenceSchema.safeParse({quote:'x'.repeat(1801),sourceIds:['source:one']}).success,false);
 assert.equal(MetricEvidenceSchema.safeParse({kind:'structured',sourceIds:['native:table'],locator:{value:'x'.repeat(8193)}}).success,false);
 assert.equal(MetricClaimSchema.safeParse({...metric('old',68.6,'2024-01-30').metricClaims[0],reportedAt:'2025-08'}).success,false);
});

test('quoted development-plan context classifies an untyped numbered consultation without merging instruments',()=>{
 const untyped:QueryRecord={...record('untyped','consultation','Beteiligung Behörden und Träger öffentlicher Belange'),origin:'regional',title:'Solarpark',titleQuote:'Nr. 73/26 „Solarpark“',caseKey:'73/26',caseKeyType:'plan_number',caseQuote:'Nr. 73/26 „Solarpark“',summaryQuote:'Aus bauplanungsrechtlicher Sicht bestehen keine Einwände zum Entwurf des Vorhabenund Erschließungsplans.'};
 const draft=record('draft','draft','Entwurf\n7. August 2025','2025-08-07');
 const civic:QueryRecord={...record('civic','implemented','Fernwärmenetz fertiggestellt','2025-08-08'),title:'Fernwärmenetz'};
 assignCaseIdentities([untyped,draft,civic],new Map());
 assert.equal(untyped.caseIdentity?.instrument?.value,'untyped:73/26');
 assert.equal(stageClaims([untyped],'2026-10-11')[0].rankingContext,'baugb');
 assert.equal(stageClaims([untyped],'2026-10-11')[0].stage,'consultation');
 const milestone=furthestMilestone([untyped,draft],'2026-10-11');
 assert.equal(milestone?.stage,'draft');assert.equal(milestone?.date,'2025-08-07');
 assert.equal(furthestMilestone([untyped,draft,civic],'2026-10-11')?.stage,'implemented');
 assert.equal(untyped.stageDate,null);
});
