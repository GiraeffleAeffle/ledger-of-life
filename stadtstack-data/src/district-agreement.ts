import {type DocumentResult} from './district-inference.ts';
import {type WorkPlan} from './district-work-plan.ts';
import {type DistrictKnowledgeRecord} from './district-schema.ts';

function claimKey(record:DistrictKnowledgeRecord):string{
 return record.caseKeyType==='source_document'?`chunk:${record.extraction.chunk.index}:${record.title.normalize('NFKC').toLocaleLowerCase('de').replace(/\s+/gu,' ').trim()}`:`chunk:${record.extraction.chunk.index}:${record.caseKeyType}:${record.caseKey}`;
}
function comparedFields(record:DistrictKnowledgeRecord){
 return {stage:record.stage,stageDate:record.stageDate,documentDate:record.documentDate,topics:record.topics.map(topic=>topic.id).sort(),entities:record.entities.map(entity=>entity.entityId).sort(),relations:record.relations.map(relation=>JSON.stringify([relation.fromId,relation.type,relation.toId,relation.modality,relation.time])).sort()};
}
export function summarizeAgreement(plan:WorkPlan,results:ReadonlyMap<string,DocumentResult>){
 const samples=plan.tasks.filter(task=>task.purpose==='agreement').map(task=>{
  const primary=plan.tasks.find(other=>other.groupId===task.groupId&&other.purpose==='production')!;
  const first=results.get(primary.id),second=results.get(task.id);
  if(!first||!second)return {groupId:task.groupId,municipalityId:task.group.municipalityId,sourceSha256:task.group.sourceSha256,status:'pending' as const};
  if(first.preparedSha256!==second.preparedSha256||first.promptSha256!==second.promptSha256||first.schemaSha256!==second.schemaSha256)throw Error('Agreement sample does not share exact input/contract');
  const left=new Map(first.records.map(record=>[claimKey(record),record])),right=new Map(second.records.map(record=>[claimKey(record),record]));
  const aligned=[...left].filter(([key])=>right.has(key)).map(([key,record])=>{
   const other=right.get(key)!,a=comparedFields(record),b=comparedFields(other);
   return {key,primaryRecordId:record.id,secondaryRecordId:other.id,differentFields:Object.keys(a).filter(field=>JSON.stringify(a[field as keyof typeof a])!==JSON.stringify(b[field as keyof typeof b]))};
  });
  return {groupId:task.groupId,municipalityId:task.group.municipalityId,sourceSha256:task.group.sourceSha256,status:'completed' as const,primaryProvider:first.provider,secondaryProvider:second.provider,primaryAdmitted:first.records.length,secondaryAdmitted:second.records.length,primaryRejected:first.quarantine.length,secondaryRejected:second.quarantine.length,alignedCases:aligned,primaryOnly:[...left.keys()].filter(key=>!right.has(key)),secondaryOnly:[...right.keys()].filter(key=>!left.has(key))};
 });
 return {schemaVersion:'stadtstack-extractor-agreement-v1',generatedAt:new Date().toISOString(),method:'Same prepared bytes and joint prompt/schema. Compare source-identified cases or explicit title/chunk selections; different selected cases are not automatically contradictions. Secondary sample records are not published.',limitation:'Cross-model agreement on one source is not independent source corroboration; same-provider self-judgment scores are not interchangeable calibrated quality measurements.',requested:samples.length,completed:samples.filter(sample=>sample.status==='completed').length,samples};
}
