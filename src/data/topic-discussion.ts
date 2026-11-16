export type DiscussionSide = 'support' | 'weigh' | 'concern';
export type DiscussionSourceId = 'paper' | 'minutes' | 'access' | 'recommendation' | 'farmland' | 'energy' | 'profile';
export interface TopicArgument {
  id: string;
  side: DiscussionSide;
  themeId: string;
  parentId?: string;
  voice: string;
  role: string;
  title: string;
  text: string;
  sourceIds: readonly DiscussionSourceId[];
}
export const DISCUSSION_SIDES = [
  { id: 'support', label: 'Dafür', color: '#39745b' },
  { id: 'weigh', label: 'Abwägen', color: '#bf922b' },
  { id: 'concern', label: 'Bedenken', color: '#c36c55' },
] as const;
export const DISCUSSION_THEMES = [
  { id: 'future', side: 'support', label: 'Energie & Zukunft' },
  { id: 'participation', side: 'support', label: 'Nutzen im Dorf' },
  { id: 'conditions', side: 'weigh', label: 'Klare Bedingungen' },
  { id: 'alternatives', side: 'weigh', label: 'Flächen vergleichen' },
  { id: 'soil', side: 'concern', label: 'Acker & Natur' },
  { id: 'everyday', side: 'concern', label: 'Alltag & Vertrauen' },
] as const;

/** Every identity and opinion is invented. Sources provide context, not evidence of endorsement. */
export const TOPIC_ARGUMENTS: readonly TopicArgument[] = [
  { id: 'future-power', side: 'support', themeId: 'future', voice: 'Nele', role: 'Jugendliche', title: 'Unsere Zukunft braucht saubere Energie', text: 'Ich wünsche mir, dass wir vor Ort Verantwortung übernehmen. Aber ich möchte auch verstehen, was dieser Solarpark tatsächlich beitragen könnte.', sourceIds: ['energy', 'paper'] },
  { id: 'future-family', side: 'support', themeId: 'future', parentId: 'future-power', voice: 'Samira', role: 'Junge Mutter', title: 'Für unsere Kinder langfristig denken', text: 'Als junge Familie finde ich die Richtung gut. Einen günstigeren Stromtarif würde ich aber erst einplanen, wenn es dafür ein konkretes Angebot gibt.', sourceIds: ['energy'] },
  { id: 'future-trades', side: 'support', themeId: 'future', parentId: 'future-power', voice: 'Henrik', role: 'Elektrohandwerker', title: 'Lokales Können einbeziehen', text: 'Ich fände es gut, wenn örtliche Betriebe fair mitbieten könnten. Aufträge oder Arbeitsplätze sind für mich bisher eine Hoffnung, keine Zusage.', sourceIds: [] },
  { id: 'village-coop', side: 'support', themeId: 'participation', voice: 'Jona', role: 'Genossenschaftsinteressierter', title: 'Mitmachen statt nur zuschauen', text: 'Ich wünsche mir eine verständliche Beteiligungsmöglichkeit. Ob eine Genossenschaft hier überhaupt mitmachen könnte, müsste erst geklärt werden.', sourceIds: ['paper'] },
  { id: 'village-renter', side: 'support', themeId: 'participation', parentId: 'village-coop', voice: 'Aylin', role: 'Mieterin', title: 'Auch ohne eigenes Dach teilhaben', text: 'Solarstrom interessiert mich gerade, weil ich kein eigenes Dach habe. Beteiligung sollte nicht nur für Menschen mit viel Erspartem gedacht werden.', sourceIds: [] },
  { id: 'village-club', side: 'support', themeId: 'participation', parentId: 'village-coop', voice: 'Piet', role: 'Vereinsaktiver', title: 'Gemeinsamen Nutzen offen besprechen', text: 'Ich würde gern öffentlich besprechen, was dem Dorf zugutekommen soll. Unser Verein sollte dabei keine versprochenen Einnahmen vorweg verplanen.', sourceIds: ['minutes'] },
  { id: 'conditions-mayor', side: 'weigh', themeId: 'conditions', voice: 'Klara', role: 'Fiktive Bürgermeisterinnenrolle, keine Amtsperson', title: 'Erst Bedingungen, dann Zustimmung', text: 'In dieser erfundenen Rolle würde ich Zuständigkeiten, Kosten und Kontrollpunkte verständlich festhalten lassen. Eine Diskussion hier ersetzt keinen Ratsbeschluss.', sourceIds: ['minutes', 'recommendation'] },
  { id: 'conditions-budget', side: 'weigh', themeId: 'conditions', parentId: 'conditions-mayor', voice: 'Robert', role: 'Haushaltsinteressierter', title: 'Nicht mit unsicheren Einnahmen rechnen', text: 'Ich möchte eine Rechnung mit offen benannten Annahmen sehen: Was könnte bei der Gemeinde ankommen, welche Kosten und Risiken blieben?', sourceIds: ['paper'] },
  { id: 'conditions-access', side: 'weigh', themeId: 'conditions', parentId: 'conditions-mayor', voice: 'Derya', role: 'Bürgerin mit Mobilitätseinschränkung', title: 'Beteiligung muss erreichbar sein', text: 'Unterlagen sollten verständlich und ohne unnötige Hürden zugänglich sein. Für eine Rückfrage möchte ich nicht zwingend zu einer Abendveranstaltung kommen müssen.', sourceIds: ['access'] },
  { id: 'alternatives-roofs', side: 'weigh', themeId: 'alternatives', voice: 'Mats', role: 'Architekturstudent', title: 'Dächer und Freiflächen vergleichen', text: 'Mich würde ein nachvollziehbarer Vergleich interessieren: Welche Dach-, Parkplatz- oder Freiflächenoptionen gibt es, und welche Grenzen haben sie?', sourceIds: ['energy', 'farmland'] },
  { id: 'alternatives-farm', side: 'weigh', themeId: 'alternatives', parentId: 'alternatives-roofs', voice: 'Wiebke', role: 'Landwirtin', title: 'Landwirtschaft nicht nur als Restfläche sehen', text: 'Ich würde gern prüfen lassen, ob eine landwirtschaftliche Mitnutzung sinnvoll möglich wäre. Das ist eine Frage, keine Aussage über die vorliegende Planung.', sourceIds: ['farmland', 'paper'] },
  { id: 'alternatives-grid', side: 'weigh', themeId: 'alternatives', parentId: 'alternatives-roofs', voice: 'Tobias', role: 'Technikinteressierter Pendler', title: 'Netz und Speicher mitdenken', text: 'Für meine Abwägung fehlen mir Antworten zu Netzanschluss und möglichen Speichern. Ich möchte wissen, welche Fragen schon geklärt sind und welche nicht.', sourceIds: ['energy'] },
  { id: 'soil-farmer', side: 'concern', themeId: 'soil', voice: 'Hauke', role: 'Ackerbauer', title: 'Acker bleibt eine wichtige Grundlage', text: 'Ich habe Sorge, dass landwirtschaftliche Flächen immer stärker unter Druck geraten. Für diesen Standort möchte ich Bodenqualität und Alternativen nachvollziehen können.', sourceIds: ['farmland'] },
  { id: 'soil-nature', side: 'concern', themeId: 'soil', parentId: 'soil-farmer', voice: 'Frieda', role: 'Naturbeobachterin', title: 'Naturwirkung nicht einfach voraussetzen', text: 'Ein Zaun mit Grün drumherum ist für mich noch kein Naturschutzkonzept. Ich wünsche mir konkrete Pflegeziele und eine spätere Überprüfung.', sourceIds: ['paper', 'recommendation'] },
  { id: 'soil-return', side: 'concern', themeId: 'soil', parentId: 'soil-farmer', voice: 'Enno', role: 'Gartenbau-Auszubildender', title: 'Was bleibt nach dem Rückbau?', text: 'Ich möchte verstehen, wie Rückbau und anschließende Bodennutzung abgesichert werden sollen, bevor wir uns langfristig festlegen.', sourceIds: ['paper'] },
  { id: 'everyday-neighbor', side: 'concern', themeId: 'everyday', voice: 'Birgit', role: 'Anwohnerin', title: 'Die Aussicht gehört auch zum Alltag', text: 'Mich beschäftigen Blickbeziehungen und mögliche Blendung. Ich wünsche mir anschauliche Darstellungen aus verschiedenen Richtungen statt pauschaler Beruhigung.', sourceIds: ['paper'] },
  { id: 'everyday-paths', side: 'concern', themeId: 'everyday', parentId: 'everyday-neighbor', voice: 'Luis', role: 'Radfahrer', title: 'Wege und Bauverkehr klären', text: 'Ich möchte wissen, wie vertraute Wege während Bau und Betrieb nutzbar bleiben sollen. Das sollte man vor Ort erklären können.', sourceIds: ['access'] },
  { id: 'everyday-trust', side: 'concern', themeId: 'everyday', parentId: 'everyday-neighbor', voice: 'Gesa', role: 'Ruheständlerin', title: 'Fragen brauchen sichtbare Antworten', text: 'Ich bin skeptisch, wenn nach einer Beteiligung niemand mehr hört, was aus den Einwänden wurde. Eine öffentliche Antwortliste würde mir helfen.', sourceIds: ['minutes', 'profile'] },
];
