import type {QueryOptions,QueryRecord} from './mcp-query.ts';
import {normaliseText,textMatches,topicMatches} from './topics.ts';

export const positiveStages=['motion','draft','consultation','decision','adopted','in_force','implemented'] as const;
export const comparisonMethod={method:'source-evidenced-stage-summary',version:'district-comparison-v1',dateFilter:'source stage/event date (never document publication, retrieval or release time)',stageCounts:'Source-recorded normalized stages, not live municipal state; stages[] retains quoted history and future announcements separately.',meaning:'Counts describe released evidence records, not municipal performance, completeness, successful interventions or an inferred case history.'};
export const similarityMethod={method:'weighted-token-topic-jaccard',version:'district-similarity-v1',model:null,weights:{text:0.6,topics:0.4},text:'German-normalized title/summary token sets, stop words removed, augmented with canonical topic:<id> tokens; topic score uses directly assigned IDs.',dateFilter:'source stage/event date (never document publication, retrieval or release time)',meaning:'Deterministic discovery similarity, not S2Vec, causality, success or proof that two records describe the same case.'};
export type DistrictFilters=Pick<Partial<QueryOptions>,'query'|'topic'|'cityIds'|'recordTypes'|'sourceTypes'|'stage'|'dateFrom'|'dateTo'|'excludePlaces'|'excludeOSM'>;

export function matchesFilters(record:QueryRecord,options:DistrictFilters):boolean {
 return (!options.cityIds||options.cityIds.includes(record.cityId))&&(!options.topic||record.topics.some(tag=>topicMatches(tag.id,options.topic!)))&&(!options.recordTypes||options.recordTypes.includes(record.recordType as NonNullable<QueryOptions['recordTypes']>[number]))&&(!options.sourceTypes||record.sourceTypes.some(type=>options.sourceTypes!.includes(type)))&&(!options.stage||record.stage===options.stage)&&(!options.excludePlaces||record.recordType!=='place')&&(!options.excludeOSM||!record.sourceTypes.includes('osm'))&&(!options.dateFrom||record.eventDate!==null&&record.eventDate.slice(0,10)>=options.dateFrom)&&(!options.dateTo||record.eventDate!==null&&record.eventDate.slice(0,10)<=options.dateTo)&&textMatches(`${record.title}\n${record.statement}\n${record.category}\n${record.id}`,options.query);
}
function latest(dates:(string|null|undefined)[]):string|null {return dates.filter((date):date is string=>!!date).sort().at(-1)??null;}
function evidence(record:QueryRecord) {
 return {id:record.id,cityId:record.cityId,districtId:record.districtId,caseKey:record.caseKey,title:record.title,stage:record.stage,stageDate:record.stageDate??null,documentDate:record.documentDate??null,stageQuote:record.stageQuote??null,stages:record.stages??[],topics:record.topics,sourceIds:record.sourceIds,verification:record.verification,comparisonEligible:record.comparisonEligible,comparisonReason:record.comparisonReason};
}
export function compareDistrictTopic(records:QueryRecord[],cityIds:string[],options:DistrictFilters,coverageFor:(cityId:string)=>unknown,asOf:string) {
 const matching=records.filter(record=>record.origin==='knowledge'&&matchesFilters(record,options)),day=asOf.slice(0,10);
 return {topic:options.topic,asOf,method:comparisonMethod,cities:cityIds.map(cityId=>{
  const all=matching.filter(record=>record.cityId===cityId);
  const evidenced=all.filter(record=>record.comparisonEligible);
  const positive=evidenced.flatMap(record=>{
   const claims=[{stage:record.stage,date:record.stageDate??null,quote:record.stageQuote??''},...(record.stages??[])];
   return claims.filter(claim=>claim.quote&&(!claim.date||claim.date<=day)&&positiveStages.some(stage=>stage===claim.stage)).map(claim=>({record,stage:claim.stage,date:claim.date,quote:claim.quote}));
  });
  const furthest=[...positiveStages].reverse().find(stage=>positive.some(claim=>claim.stage===stage))??null;
  const stageCounts=Object.fromEntries([...positiveStages,'rejected','withdrawn','unknown'].map(stage=>[stage,evidenced.filter(record=>record.stage===stage).length]));
  const examples=[...all].sort((a,b)=>(b.documentDate??'').localeCompare(a.documentDate??'')||a.id.localeCompare(b.id)).slice(0,5).map(evidence);
  const milestoneEvidence=positive.filter(claim=>claim.stage===furthest).sort((a,b)=>(b.date??'').localeCompare(a.date??'')||a.record.id.localeCompare(b.record.id));
  return {
   cityId,coverage:coverageFor(cityId),recordCount:all.length,
   caseCount:new Set(all.filter(record=>record.caseKey&&record.caseKeyType!=='source_document').map(record=>`${record.caseKeyType}:${record.caseKey}`)).size,
   sourceDocumentGroupCount:new Set(all.filter(record=>record.caseKeyType==='source_document').map(record=>record.caseKey)).size,
   caseCountMeaning:'Quoted authority/case identifiers only; source-document fallbacks are counted separately, not invented civic cases.',
   sourceBackedRecordCount:evidenced.length,stageCounts,
   unknownStageCount:all.filter(record=>record.stage==='unknown'||record.stage===null).length,
   candidateCount:all.filter(record=>record.verification?.status!=='auto-verified').length,
   withheldCount:all.filter(record=>!record.comparisonEligible).length,
   rejectedCount:all.filter(record=>record.stage==='rejected').length,withdrawnCount:all.filter(record=>record.stage==='withdrawn').length,
   furthestPositiveMilestone:furthest?{stage:furthest,meaning:'Furthest explicitly quoted positive milestone at this release date, including source-stated history; not necessarily the current case status.',evidenceCount:milestoneEvidence.length,evidence:milestoneEvidence.slice(0,5).map(claim=>({...evidence(claim.record),milestone:{stage:claim.stage,date:claim.date,quote:claim.quote}}))}:null,
   latestStageDate:latest(evidenced.flatMap(record=>[record.stageDate,...(record.stages??[]).map(stage=>stage.date)])),
   latestSourceDate:latest(all.map(record=>record.documentDate)),examples,
   unknowns:[...(all.length?[]:['No matching normalized records in this release; not evidence of municipal inactivity.']),...(all.some(record=>record.documentDate===null)?['Some source dates are unknown.']:[]),...(all.some(record=>record.stageDate===null)?['Some stage dates are unknown; source/retrieval dates are not substituted.']:[])],
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
export function similarDistrictRecords(records:QueryRecord[],id:string,options:DistrictFilters={},limit=20) {
 const target=records.find(record=>record.id===id&&record.origin==='knowledge');
 if(!target)throw Error('Normalized knowledge record not found; use search_topics/get_regional_topics to discover knowledge IDs');
 const targetTerms=terms(target),targetTopics=new Set(target.topics.map(topic=>topic.id));
 const matches=records.filter(record=>record.origin==='knowledge'&&record.id!==id&&record.cityId!==target.cityId&&matchesFilters(record,options)).map(record=>{
  const text=jaccard(targetTerms,terms(record)),topics=jaccard(targetTopics,new Set(record.topics.map(topic=>topic.id)));
  return {record,score:0.6*text.score+0.4*topics.score,textScore:text.score,topicScore:topics.score,sharedTerms:text.shared,sharedTopics:topics.shared};
 }).filter(match=>match.score>0).sort((a,b)=>b.score-a.score||a.record.id.localeCompare(b.record.id));
 return {id,method:similarityMethod,target:evidence(target),total:matches.length,limit,items:matches.slice(0,limit).map(({record,...match})=>({...match,...evidence(record)})),unknowns:['Candidate and undated evidence may appear for discovery; comparisonEligible and verification are preserved.','Similarity does not establish implementation, outcomes or transferable success.']};
}
