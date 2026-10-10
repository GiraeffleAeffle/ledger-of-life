import {TOPIC_VOCABULARY,TOPIC_VOCABULARY_VERSION,topicAncestors} from './topic-vocabulary.ts';

export const topicRegistryVersion=TOPIC_VOCABULARY_VERSION;
const additions:Record<string,RegExp>={
  waermeplanung:/fernw[äa]rme|w(?:ä|ae|a)rme(?:plan|netz)/iu,
  solarpark:/freifl(?:ä|ae|a)chen[ -]?(?:pv|photovoltaik|solaranlage)|agri[ -]?pv/iu,
  schule:/schul(?:bau|erweiterung|entwicklungsplan|standort|campus|sanierung)/iu,
};
export const topicRegistry=TOPIC_VOCABULARY.map(topic=>({...topic,ruleId:`${topicRegistryVersion}:${topic.id}`,additionalPattern:additions[topic.id]}));
export type TopicTag={id:string;parentId?:string|null;assignment:'rule'|'source'|'model'|'human';ruleId:string;evidence:string;sourceIds:string[];provenance?:'rule'|'model'|'human';confidence?:number;quote?:string};
export function topicMatches(id:string,requested:string):boolean {
  return id===requested||topicAncestors(id).includes(requested);
}
export function assertTopic(topic?:string) {
  if(topic!==undefined&&!topicRegistry.some(entry=>entry.id===topic))throw Error(`Unknown topic: ${topic}. Use list_topics; record types such as planning belong in recordTypes.`);
}
export function assignTopics(text:string,sourceIds:string[]):TopicTag[] {
  return topicRegistry.flatMap(topic=>{
    const match=topic.pattern?.exec(text)??topic.additionalPattern?.exec(text);
    if(!match)return [];
    const start=Math.max(0,match.index-60),end=Math.min(text.length,match.index+match[0].length+100);
    return [{id:topic.id,parentId:topic.parentId,assignment:'rule' as const,provenance:'rule' as const,ruleId:topic.ruleId,evidence:text.slice(start,end),quote:text.slice(start,end),sourceIds}];
  });
}
export function normaliseText(text:string) {
  return text.toLocaleLowerCase('de').replaceAll('ä','ae').replaceAll('ö','oe').replaceAll('ü','ue').replaceAll('ß','ss');
}
export function textMatches(text:string,query?:string) {
  const haystack=normaliseText(text);
  return normaliseText(query??'').split(/\s+/).filter(Boolean).every(term=>{
    if(term==='solar'||term==='photovoltaik'||term==='pv')return /solar|photovoltaik|(?:^|[^a-z])pv(?:[^a-z]|$)/.test(haystack);
    if(/^(waerme|fernwaerme|waermeplanung|waermeplan)$/.test(term))return /waerme(?:plan|netz|versorgung)|fernwaerme/.test(haystack);
    if(/^(kita|kindergarten|kindertagesstaette|kinderbetreuung)$/.test(term))return /kita|kindergarten|kindertagesstaette|kinderbetreuung/.test(haystack);
    if(/^(fahrrad|radweg|radverkehr)$/.test(term))return /fahrrad|radweg|radverkehr|radschnell/.test(haystack);
    if(/^(oepnv|nahverkehr)$/.test(term))return /oepnv|nahverkehr|busverkehr|buslinie|strassenbahn/.test(haystack);
    return haystack.includes(term);
  });
}
