import type {QueryOptions,QueryRecord} from './mcp-query.ts';
import {normaliseText,textMatches,topicMatches} from './topics.ts';
import {canonicalRecordStage,canonicalRecordStageAssertions,caseEvidence,comparisonEligibility,furthestMilestone,groupCases,hasKnownStage,sourceStageDate,scopedCases} from './query-cases.ts';
import {matchesStageDateAssertions,positiveStages,stageSemanticsVersion} from './planning-stages.ts';
import {caseSemanticsVersion} from './case-supersession.ts';

export const comparisonMethod = { stageSemanticsVersion, caseSemanticsVersion, method:'source-evidenced-case-summary',version:'district-comparison-v3',dateFilter:'Text: source stage/event date, never document publication/retrieval/release time. Native: exact day/instant or labelled derived calendarRange overlap for calendar year/month; arbitrary periods are not guessed. Date precision, dateRole and financialRole remain separate.',stageCounts:'Distinct source-publication bundles per source-recorded member stage; one bundle can appear in multiple stage buckets. Native observations are separate, never promoted to projects or milestones.',meaning:'Source-publication bundles are discovery only. Canonical nativeCases group admitted scoped procedures/events, excluding document buckets; neither kind establishes enduring projects, municipal performance, legal equivalence or completeness.' }
export const similarityMethod = { stageSemanticsVersion, caseSemanticsVersion, method:'weighted-token-topic-jaccard',version:'district-similarity-v3',model:null,weights:{text:0.6,topics:0.4},text:'Union of German-normalized case member title/summary token sets and canonical topic:<id> tokens; repeated text chunks do not add weight. Native observations remain separate evidence items, not cases or projects.',dateFilter:'Text source stage/event date; native exact day/instant or labelled calendar year/month range overlap. Unknown school/planning periods are not guessed; nativeDate/datePrecision/dateRole/financialRole remain explicit.',meaning:'Deterministic cross-municipality evidence discovery, not S2Vec, causality, success or proof of case/project equivalence.' }
export type DistrictFilters=Pick<Partial<QueryOptions>,'query'|'topic'|'cityIds'|'recordTypes'|'kinds'|'observationKinds'|'dateRole'|'financialRole'|'sourceTypes'|'stage'|'dateFrom'|'dateTo'|'excludePlaces'|'excludeOSM'>;
/** Calendar-only search range; never a legal/stage date or inferred period convention. */
export function structuredDates(observation:NonNullable<QueryRecord['observation']>):Pick<QueryRecord,'eventDate'|'dateSemantics'|'nativeDate'|'datePrecision'|'calendarRange'> {
 const {date,datePrecision}=observation;
 let calendarRange:QueryRecord['calendarRange']=null;
 if(date!==null&&datePrecision==='year')calendarRange={from:`${date}-01-01`,to:`${date}-12-31`,precision:'year',basis:'derived_calendar_range',meaning:'Calendar overlap for retrieval only; not an event, legal validity or stage date.'};
 else if(date!==null&&datePrecision==='month'){
  const end=new Date(`${date}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);
  calendarRange={from:`${date}-01`,to:end.toISOString().slice(0,10),precision:'month',basis:'derived_calendar_range',meaning:'Calendar overlap for retrieval only; not an event, legal validity or stage date.'};
 }
 return {eventDate:datePrecision==='day'||datePrecision==='instant'?date:null,dateSemantics:date?'source_observation':'unknown',nativeDate:date,datePrecision,calendarRange};
}
function matchesDates(record:QueryRecord,options:DistrictFilters):boolean {
 if(options.stage)return matchesStageDateAssertions(canonicalRecordStageAssertions(record),options.stage,options.dateFrom,options.dateTo);
 if(!options.dateFrom&&!options.dateTo)return true;
 if(record.kind==='structured'&&record.calendarRange)return (!options.dateFrom||record.calendarRange.to>=options.dateFrom)&&(!options.dateTo||record.calendarRange.from<=options.dateTo);
 return record.eventDate!==null&&(!options.dateFrom||record.eventDate.slice(0,10)>=options.dateFrom)&&(!options.dateTo||record.eventDate.slice(0,10)<=options.dateTo);
}

export function matchesFilters(record:QueryRecord,options:DistrictFilters):boolean {
 if(options.kinds&&!options.kinds.some(kind=>kind===record.kind))return false;
 if(options.observationKinds&&(!record.observationKind||!options.observationKinds.includes(record.observationKind)))return false;
 if(options.dateRole&&record.dateRole!==options.dateRole)return false;
 if(options.financialRole&&record.financialRole!==options.financialRole)return false;
 return (!options.cityIds||options.cityIds.includes(record.cityId))&&(!options.topic||record.topics.some(tag=>topicMatches(tag.id,options.topic!)))&&(!options.recordTypes||options.recordTypes.includes(record.recordType as NonNullable<QueryOptions['recordTypes']>[number]))&&(!options.sourceTypes||record.sourceTypes.some(type=>options.sourceTypes!.includes(type)))&&(!options.excludePlaces||record.recordType!=='place')&&(!options.excludeOSM||!record.sourceTypes.includes('osm'))&&matchesDates(record,options)&&textMatches(`${record.title}\n${record.statement}\n${record.category}\n${record.id}\n${record.nativeSearchText??''}`,options.query);
}
function latest(dates:(string|null|undefined)[]):string|null {return dates.filter((date):date is string=>!!date).sort().at(-1)??null;}
function evidence(record:QueryRecord) {
 return {id:record.id,cityId:record.cityId,districtId:record.districtId,caseKey:record.caseKey,title:record.title,kind:record.kind,observationKind:record.observationKind,observation:record.observation,nativeRecordContext:record.nativeRecordContext,evidence:record.evidence,supportingEvidence:record.supportingEvidence,supersession:record.supersession,nativeDate:record.nativeDate,datePrecision:record.datePrecision,calendarRange:record.calendarRange,dateRole:record.dateRole,financialRole:record.financialRole,stage:record.stage,canonicalStage:canonicalRecordStage(record),stageDate:record.stageDate??null,documentDate:record.documentDate??null,stageQuote:record.stageQuote,stages:record.stages,topics:record.topics,sourceIds:record.sourceIds,verification:record.verification,comparisonEligible:record.comparisonEligible,comparisonReason:record.comparisonReason};
}
export function compareDistrictTopic(records:QueryRecord[],cityIds:string[],options:DistrictFilters,coverageFor:(cityId:string)=>unknown,asOf:string) {
 const matching=records.filter(record=>matchesFilters(record,options));
 return {topic:options.topic,asOf,method:comparisonMethod,cities:cityIds.map(cityId=>{
  const all=matching.filter(record=>record.cityId===cityId);
  const evidenced=all.filter(record=>comparisonEligibility(record).comparisonEligible);
  const groups=groupCases(all),cases=groups.map(records=>caseEvidence(records,asOf));
  const nativeCases=scopedCases(all),documentBuckets=scopedCases(all,true).filter(identity=>identity.kind==='document_bucket');
  const stagesByRecord=new Map(all.map(record=>[record,canonicalRecordStage(record)??'unknown']));
  const stages=[...new Set([...positiveStages,'rejected','withdrawn','unknown',...stagesByRecord.values()])];
  const stageCounts=Object.fromEntries(stages.map(stage=>[stage,groups.filter(group=>group.some(record=>comparisonEligibility(record).comparisonEligible&&stagesByRecord.get(record)===stage)).length]));
  const examples=[...all].sort((a,b)=>(b.documentDate??b.eventDate??'').localeCompare(a.documentDate??a.eventDate??'')||a.id.localeCompare(b.id)).slice(0,5).map(evidence);
  return {
   cityId,coverage:coverageFor(cityId),recordCount:all.length,caseCount:cases.length,
   observationCount:all.filter(record=>record.caseIdentity?.status==='not_applicable').length,
   identifiedCaseCount:nativeCases.length,identifiedProjectCount:0,procedureCount:nativeCases.filter(identity=>identity.kind==='procedure').length,eventCount:nativeCases.filter(identity=>identity.kind==='event').length,documentBucketCount:documentBuckets.length,nativeCases,
   unresolvedCaseCount:cases.filter(item=>item.identityStatus==='unresolved').length,
   sourceDocumentGroupCount:new Set(all.filter(record=>record.caseKeyType==='source_document').map(record=>record.caseKey)).size,
   caseCountMeaning:'caseCount/cases retain explicit source-publication bundle discovery, not canonical identity or project counts. nativeCases/identifiedCaseCount group only admitted scoped procedure/event IDs; document buckets are separate and no enduring projects are inferred. Legal instruments retain distinct milestones; context/entity observations are not projects.',
   sourceBackedRecordCount:evidenced.length,sourceBackedCaseCount:cases.filter(item=>item.comparisonEligible).length,stageCounts,cases,
   unknownStageCount:groups.filter(group=>!group.some(hasKnownStage)).length,
   candidateCount:all.filter(record=>record.verification&&record.verification.status!=='auto-verified').length,
   withheldCount:all.length-evidenced.length,
   rejectedCount:stageCounts.rejected,withdrawnCount:stageCounts.withdrawn,
   furthestPositiveMilestone:furthestMilestone(evidenced,asOf),
   latestStageDate:latest(evidenced.flatMap(record=>[sourceStageDate(record),...(record.stages??[]).map(stage=>stage.date)])),
   latestSourceDate:latest(all.map(record=>record.documentDate)),examples,
   unknowns:[...(all.length?[]:['No matching records in this release; not evidence of municipal inactivity.']),...(all.some(record=>record.kind!=='structured'&&!record.documentDate)?['Some document dates are unknown.']:[]),...(all.some(record=>record.kind!=='structured'&&!record.stageDate)?['Some stage dates are unknown; source/retrieval dates are not substituted.']:[]),...(all.some(record=>record.kind==='structured')?['Source-native observations retain their own date and financial roles; they do not establish project identity, a legal milestone or implementation.']:[])],
  };
 })};
}
const stopWords:Record<string,true>=Object.fromEntries('der die das ein eine einer eines und oder zum zur von des den fuer bei mit nr stadt gemeinde amt landkreis nach gem baugb beschluss vorlage sitzung beraten wird werden wurde wurden ist sind dem im in am an auf zu'.split(' ').map(word=>[word,true]));
function terms(record:QueryRecord):Set<string> {
 const text=normaliseText(`${record.title}\n${record.statement}\n${record.nativeSearchText??''}`);
 const words=new Set((text.match(/[a-z]{3,}/g)??[]).filter(word=>!stopWords[word]));
 // Canonical subject tokens preserve German synonyms and compound matches.
 for(const tag of record.topics)words.add(`topic:${tag.id}`);
 return words;
}
function jaccard(left:Set<string>,right:Set<string>) {
 const shared=[...left].filter(term=>right.has(term)).sort();
 return {score:left.size+right.size-shared.length?shared.length/(left.size+right.size-shared.length):0,shared};
}
function discoveryEvidence(records:QueryRecord[],asOf:string) {
 const first=records[0];
 if(first.kind!=='structured')return {...caseEvidence(records,asOf),kind:'case' as const};
 return {kind:'observation' as const,id:first.id,cityId:first.cityId,districtId:first.districtId,title:first.title,memberRecordIds:[first.id],recordCount:1,comparisonEligible:first.comparisonEligible,comparisonReason:first.comparisonReason,identityStatus:'not_applicable',sourceIds:first.sourceIds,topics:first.topics,observation:first.observation,nativeRecordContext:first.nativeRecordContext,evidence:first.evidence,supportingEvidence:first.supportingEvidence,supersession:first.supersession,verification:first.verification,graph:first.graph,nativeDate:first.nativeDate,datePrecision:first.datePrecision,calendarRange:first.calendarRange,dateRole:first.dateRole,financialRole:first.financialRole,unknowns:first.unknowns};
}
export function similarDistrictRecords(records:QueryRecord[],id:string,options:DistrictFilters,limit:number,asOf:string) {
 const groups=[...groupCases(records),...records.filter(record=>record.kind==='structured').map(record=>[record])],target=groups.find(group=>group.some(record=>record.id===id||record.caseId===id));
 if(!target)throw Error('Record or case not found; use search_topics/get_regional_topics to discover IDs');
 const caseTerms=(group:QueryRecord[])=>new Set(group.flatMap(record=>[...terms(record)]));
 const caseTopics=(group:QueryRecord[])=>new Set(group.flatMap(record=>record.topics.map(topic=>topic.id)));
 const targetTerms=caseTerms(target),targetTopics=caseTopics(target);
 const matches=groups.filter(group=>group[0].cityId!==target[0].cityId&&group.some(record=>matchesFilters(record,options))).map(group=>{
  const text=jaccard(targetTerms,caseTerms(group)),topics=jaccard(targetTopics,caseTopics(group));
  return {group,score:0.6*text.score+0.4*topics.score,textScore:text.score,topicScore:topics.score,sharedTerms:text.shared,sharedTopics:topics.shared};
 }).filter(match=>match.score>0).sort((a,b)=>b.score-a.score||(a.group[0].caseId??a.group[0].id).localeCompare(b.group[0].caseId??b.group[0].id));
 return {id,method:similarityMethod,target:discoveryEvidence(target,asOf),total:matches.length,totalCases:matches.filter(match=>match.group[0].kind!=='structured').length,totalObservations:matches.filter(match=>match.group[0].kind==='structured').length,totalRecords:matches.reduce((total,match)=>total+match.group.length,0),limit,items:matches.slice(0,limit).map(({group,...match})=>({...match,...discoveryEvidence(group,asOf)})),unknowns:['Candidate and undated evidence may appear for discovery; member eligibility and original evidence remain available through export_records.','Native observations are standalone evidence items, not identified cases or projects.','Similarity does not establish implementation, outcomes or transferable success.']};
}
