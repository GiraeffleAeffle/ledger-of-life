import { TOPICS } from '../regional/taxonomy.mjs';

export const TOPIC_VOCABULARY_VERSION = 'stadtstack-topics-v2';
const parents = [
  { id: 'energie', label: 'Energie', summary: 'Energieversorgung und Erzeugung.' },
  { id: 'siedlung', label: 'Siedlungsentwicklung', summary: 'Wohnen, Gewerbe und Flächennutzung.' },
  { id: 'daseinsvorsorge', label: 'Daseinsvorsorge', summary: 'Öffentliche Einrichtungen und Versorgung.' },
  { id: 'mobilitaet', label: 'Mobilität', summary: 'Straßen, Radverkehr und öffentlicher Verkehr.' },
  { id: 'verwaltung', label: 'Verwaltung und Finanzen', summary: 'Kommunale Finanzen.' },
  { id: 'umwelt', label: 'Umwelt und Klima', summary: 'Klimaschutz, Anpassung und Hochwasserschutz.' },
];
const parentByLeaf: Record<string, string> = {
  waermeplanung: 'energie', solarpark: 'energie', windenergie: 'energie', bioenergie: 'energie',
  wohnbau: 'siedlung', gewerbe: 'siedlung', kita: 'daseinsvorsorge', schule: 'daseinsvorsorge',
  feuerwehr: 'daseinsvorsorge', sport: 'daseinsvorsorge', aerzte: 'daseinsvorsorge',
  radverkehr: 'mobilitaet', strassenverkehr: 'mobilitaet', oepnv: 'mobilitaet',
  haushalt: 'verwaltung', hochwasser: 'umwelt', klimaschutz: 'umwelt',
};
export type VocabularyTopic = { id: string; label: string; summary: string; parentId: string | null; pattern?: RegExp };
// Leaf definitions remain owned by the regional taxonomy; hierarchy is an overlay, not a second vocabulary.
export const TOPIC_VOCABULARY: readonly VocabularyTopic[] = [
  ...parents.map(topic => ({ ...topic, parentId: null })),
  ...TOPICS.map(topic => ({ ...topic, parentId: parentByLeaf[topic.id] ?? null })),
];
export function getTopic(id: string): VocabularyTopic | undefined {
  return TOPIC_VOCABULARY.find(topic => topic.id === id);
}
export function topicAncestors(id: string): string[] {
  const parent = getTopic(id)?.parentId;
  return parent ? [parent, ...topicAncestors(parent)] : [];
}
