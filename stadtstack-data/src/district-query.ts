import type {QueryOptions,QueryRecord} from './mcp-query.ts';
import {normaliseText,textMatches,topicMatches} from './topics.ts';
import {caseEvidence,comparisonEligibility,furthestMilestone,groupCases,hasKnownStage,positiveStages,sourceStageDate} from './query-cases.ts';

export const comparisonMethod={method:'source-evidenced-case-summary',version:'district-comparison-v2',dateFilter:'source stage/event date (never document publication, retrieval or release time)',stageCounts:'Distinct cases per source-recorded member stage; one case can appear in multiple stage buckets. Instrument milestones remain separate; no inferred current state.',meaning:'Counts describe source-identified cases/publication bundles and explicit unresolved record fallbacks, not municipal performance, legal equivalence or completeness.'};
export const similarityMethod={method:'weighted-token-topic-jaccard',version:'district-similarity-v2',model:null,weights:{text:0.6,topics:0.4},text:'Union of German-normalized member title/summary token sets and canonical topic:<id> tokens; repeated chunks do not add weight.',dateFilter:'source stage/event date (never document publication, retrieval or release time)',meaning:'Deterministic cross-municipality case discovery, not S2Vec, causality, success or proof of case equivalence.'};
export type DistrictFilters=Pick<Partial<QueryOptions>,'query'|'topic'|'cityIds'|'recordTypes'|'sourceTypes'|'stage'|'dateFrom'|'dateTo'|'excludePlaces'|'excludeOSM'>;

export function matchesFilters(record:QueryRecord,options:DistrictFilters):boolean {
 return (!options.cityIds||options.cityIds.includes(record.cityId))&&(!options.topic||record.topics.some(tag=>topicMatches(tag.id,options.topic!)))&&(!options.recordTypes||options.recordTypes.includes(record.recordType as NonNullable<QueryOptions['recordTypes']>[number]))&&(!options.sourceTypes||record.sourceTypes.some(type=>options.sourceTypes!.includes(type)))&&(!options.stage||record.stage===options.stage)&&(!options.excludePlaces||record.recordType!=='place')&&(!options.excludeOSM||!record.sourceTypes.includes('osm'))&&(!options.dateFrom||record.eventDate!==null&&record.eventDate.slice(0,10)>=options.dateFrom)&&(!options.dateTo||record.eventDate!==null&&record.eventDate.slice(0,10)<=options.dateTo)&&textMatches(`${record.title}\n${record.statement}\n${record.category}\n${record.id}`,options.query);
}
function latest(dates:(string|null|undefined)[]):string|null {return dates.filter((date):date is string=>!!date).sort().at(-1)??null;}
function evidence(record:QueryRecord) {
 return {id:record.id,cityId:record.cityId,districtId:record.districtId,caseKey:record.caseKey,title:record.title,stage:record.stage,stageDate:record.stageDate??null,documentDate:record.documentDate??null,stageQuote:record.stageQuote??null,stages:record.stages??[],topics:record.topics,sourceIds:record.sourceIds,verification:record.verification,comparisonEligible:record.comparisonEligible,comparisonReason:record.comparisonReason};
}
export function compareDistrictTopic(records:QueryRecord[],cityIds:string[],options:DistrictFilters,coverageFor:(cityId:string)=>unknown,asOf:string) {
 const matching=records.filter(record=>matchesFilters(record,options));
 return {topic:options.topic,asOf,method:comparisonMethod,cities:cityIds.map(cityId=>{
  const all=matching.filter(record=>record.cityId===cityId);
  const evidenced=all.filter(record=>comparisonEligibility(record).comparisonEligible);
  const groups=groupCases(all),cases=groups.map(records=>caseEvidence(records,asOf));
  const stages=[...new Set([...positiveStages,'rejected','withdrawn','unknown',...all.map(record=>record.stage??'unknown')])];
  const stageCounts=Object.fromEntries(stages.map(stage=>[stage,groups.filter(group=>group.some(record=>comparisonEligibility(record).comparisonEligible&&(record.stage??'unknown')===stage)).length]));
  const examples=[...all].sort((a,b)=>(b.documentDate??b.eventDate??'').localeCompare(a.documentDate??a.eventDate??'')||a.id.localeCompare(b.id)).slice(0,5).map(evidence);
  return {
   cityId,coverage:coverageFor(cityId),recordCount:all.length,caseCount:cases.length,
   identifiedCaseCount:cases.filter(item=>item.identityStatus==='source_identified').length,
   unresolvedCaseCount:cases.filter(item=>item.identityStatus==='unresolved').length,
   sourceDocumentGroupCount:new Set(all.filter(record=>record.caseKeyType==='source_document').map(record=>record.caseKey)).size,
   caseCountMeaning:'Distinct cases/publication bundles plus explicit record-scoped unresolved identities; legal instruments are not merged. Source-document groups are provenance, not extra cases.',
   sourceBackedRecordCount:evidenced.length,sourceBackedCaseCount:cases.filter(item=>item.comparisonEligible).length,stageCounts,cases,
   unknownStageCount:groups.filter(group=>!group.some(hasKnownStage)).length,
   candidateCount:all.filter(record=>record.verification&&record.verification.status!=='auto-verified').length,
   withheldCount:all.length-evidenced.length,
   rejectedCount:stageCounts.rejected,withdrawnCount:stageCounts.withdrawn,
   furthestPositiveMilestone:furthestMilestone(evidenced,asOf),
   latestStageDate:latest(evidenced.flatMap(record=>[sourceStageDate(record),...(record.stages??[]).map(stage=>stage.date)])),
   latestSourceDate:latest(all.map(record=>record.documentDate)),examples,
   unknowns:[...(all.length?[]:['No matching records in this release; not evidence of municipal inactivity.']),...(all.some(record=>!record.documentDate)?['Some document dates are unknown.']:[]),...(all.some(record=>!record.stageDate)?['Some stage dates are unknown; source/retrieval dates are not substituted.']:[])],
  };
 })};
}
const stopWords:Record<string,true>=Object.fromEntries('der die das ein eine einer eines und oder zum zur von des den fuer bei mit nr stadt gemeinde amt landkreis nach gem baugb beschluss vorlage sitzung beraten wird werden wurde wurden ist sind dem im in am an auf zu'.split(' ').map(word=>[word,true]));
function terms(record:QueryRecord):Set<string> {
 const text=normaliseText(`${record.title}\n${record.statement}`);
 const words=new Set((text.match(/[a-z]{3,}/g)??[]).filter(word=>!stopWords[word]));
 // Canonical subject tokens preserve German synonyms and compound matches.
 for(const tag of record.topics)words.add(`topic:${tag.id}`);
 return words;
}
function jaccard(left:Set<string>,right:Set<string>) {
 const shared=[...left].filter(term=>right.has(term)).sort();
 return {score:left.size+right.size-shared.length?shared.length/(left.size+right.size-shared.length):0,shared};
}
export function similarDistrictRecords(records:QueryRecord[],id:string,options:DistrictFilters,limit:number,asOf:string) {
 const groups=groupCases(records),target=groups.find(group=>group.some(record=>record.id===id||record.caseId===id));
 if(!target)throw Error('Record or case not found; use search_topics/get_regional_topics to discover IDs');
 const caseTerms=(group:QueryRecord[])=>new Set(group.flatMap(record=>[...terms(record)]));
 const caseTopics=(group:QueryRecord[])=>new Set(group.flatMap(record=>record.topics.map(topic=>topic.id)));
 const targetTerms=caseTerms(target),targetTopics=caseTopics(target);
 const matches=groups.filter(group=>group[0].cityId!==target[0].cityId&&group.some(record=>matchesFilters(record,options))).map(group=>{
  const text=jaccard(targetTerms,caseTerms(group)),topics=jaccard(targetTopics,caseTopics(group));
  return {group,score:0.6*text.score+0.4*topics.score,textScore:text.score,topicScore:topics.score,sharedTerms:text.shared,sharedTopics:topics.shared};
 }).filter(match=>match.score>0).sort((a,b)=>b.score-a.score||(a.group[0].caseId??a.group[0].id).localeCompare(b.group[0].caseId??b.group[0].id));
 return {id,method:similarityMethod,target:caseEvidence(target,asOf),total:matches.length,totalCases:matches.length,totalRecords:matches.reduce((total,match)=>total+match.group.length,0),limit,items:matches.slice(0,limit).map(({group,...match})=>({...match,...caseEvidence(group,asOf)})),unknowns:['Candidate and undated evidence may appear for discovery; member eligibility and original evidence remain available through export_records.','Similarity does not establish implementation, outcomes or transferable success.']};
}
