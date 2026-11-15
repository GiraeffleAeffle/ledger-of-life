export type TopicStageId = 'feed' | 'problem' | 'discussion' | 'proposal' | 'feedback' | 'decision' | 'trace';

export const TOPIC_FLOW_TITLE = 'Windenergienutzung · B-Plan Nr. 8 · Gemeinde Tramm';
export const TOPIC_FLOW_CASE_ID = 'case:831553f3615c84ee48a6f979492d8b88';
export const TOPIC_FLOW_SNAPSHOT = 'Live API · snapshot 20261115T194130Z';

export const TOPIC_SOURCES = [
  {
    id: 'paper',
    caseId: 'case:831553f3615c84ee48a6f979492d8b88',
    evidenceSourceId: 'html_sessionnet:council:destatis:01053:5318:01053126',
    authority: 'Ratsinformationssystem · Vorlage',
    title: 'Städtebaulicher Vertrag § 11 / Durchführungsvertrag § 12 BauGB · B-Plan 8 Windenergienutzung',
    url: 'https://sessionnet.amt-buechen.de/bi/vo0050.php?__kvonr=16057',
    dateLabel: 'Kein Vorlagen- oder Veröffentlichungsdatum im Datensatz · abgerufen 15. November 2026',
    fact: 'Die Vorlage betrifft die 9. Änderung des Flächennutzungsplans und den vorhabenbezogenen B-Plan Nr. 8 „Windenergienutzung“ in Tramm.',
    quote: null,
  },
  {
    id: 'minutes',
    caseId: 'case:831553f3615c84ee48a6f979492d8b88',
    evidenceSourceId: 'html_sessionnet:council:destatis:01053:5318:01053126',
    authority: 'Niederschrift · Gemeindevertretung Tramm',
    title: 'Öffentliche Sitzung · Tagesordnungspunkt 9',
    url: 'https://sessionnet.amt-buechen.de/bi/getfile.php?id=138904&type=do',
    dateLabel: 'Entscheidungsdatum 1. Juni 2026 · Niederschrift abgerufen 15. November 2026',
    fact: 'Die Gemeindevertretung beauftragte den Bürgermeister, den städtebaulichen Vertrag zur Übernahme der Bauleitplanungskosten abzuschließen. Im selben Beschlusstext trägt der Vorhabenträger die Rechtsanwaltskosten für die Ausarbeitung des Durchführungsvertrags.',
    quote: '„Ja: 7 · Nein: 1 · Enthaltung: 0“',
  },
  {
    id: 'roseburg',
    caseId: 'case:328e10d15b3b1c247aaa6a519b6e0a45',
    evidenceSourceId: 'html_sessionnet:council:destatis:01053:5318:01053104',
    authority: 'Vergleich · Gemeindevertretung Roseburg',
    title: 'B-Plan Nr. 7 Windenergienutzung Roseburg-Wotersen · Kostenübernahme',
    url: 'https://sessionnet.amt-buechen.de/bi/getfile.php?id=139268&type=do',
    dateLabel: 'Entscheidungsdatum 17. Juni 2026',
    fact: 'Die Fallähnlichkeit beruht auf gleichem Instrument, Wind-Thema und Kostenübernahme-Facette. Die Niederschrift beauftragt den Bürgermeister, den Vertrag zur Übernahme der Planungskosten zu schließen; der Vorhabenträger trägt die Kosten des Anwaltsbüros für den Durchführungsvertrag.',
    quote: '„Ja: 6 · Nein: 0 · Enthaltung: 0“',
  },
  {
    id: 'witzeeze',
    caseId: 'case:1151f6841ed231ec69be0f7a3c3a6566',
    evidenceSourceId: 'html_sessionnet:council:destatis:01053:5318:01053132',
    authority: 'Vergleich · Gemeindevertretung Witzeeze',
    title: 'B-Plan Nr. 13 Windenergienutzung Witzeeze · Planungskosten',
    url: 'https://sessionnet.amt-buechen.de/bi/getfile.php?id=134299&type=do',
    dateLabel: 'Entscheidungsdatum 16. Oktober 2025',
    fact: 'Die Fallähnlichkeit beruht auf gleichem Instrument, Wind-Thema und Kostenübernahme-Facette. Die Gemeindevertretung beauftragte den Bürgermeister, einen Vertrag zur Übernahme der Bauleitplanungskosten zu schließen.',
    quote: '„Ja: 9 · Nein: 0 · Enthaltung: 0“',
  },
] as const;

export const TOPIC_SOURCE_TIMELINE = [
  { date: '16. Oktober 2025', event: 'Witzeeze: dokumentierter Kostenübernahme-Beschluss bei einem ähnlichen Windenergie-Verfahren.', sourceId: 'witzeeze', reality: 'source' },
  { date: '1. Juni 2026', event: 'Gemeindevertretung Tramm: Entscheidung zum Abschluss eines städtebaulichen Vertrags für die Übernahme von Bauleitplanungskosten; Niederschrift nennt zusätzlich die Rechtsanwaltskosten des Durchführungsvertrags beim Vorhabenträger.', sourceId: 'minutes', reality: 'source' },
  { date: '17. Juni 2026', event: 'Roseburg: dokumentierter Kostenübernahme-Beschluss bei einem ähnlichen Windenergie-Verfahren.', sourceId: 'roseburg', reality: 'source' },
  { date: '15. November 2026 · Live-API-Snapshot', event: 'Fall- und Vergleichsdaten zuletzt gesammelt; keine Aussage über eine inzwischen erfolgte Unterzeichnung oder Umsetzung.', sourceId: 'paper', reality: 'snapshot' },
] as const;

export const TOPIC_DEMO_STAGES: readonly { id: TopicStageId; label: string; owner: string }[] = [
  { id: 'feed', label: 'Stadthinweis', owner: 'Quelle' },
  { id: 'problem', label: 'Problem', owner: 'Bürger:in · Beispiel, erfunden' },
  { id: 'discussion', label: 'Diskussion', owner: 'Bürger:innen · Beispiel, erfunden' },
  { id: 'proposal', label: 'KI-Vorschlag', owner: 'KI-Beispiel · offline erstellt, menschlich ungeprüft' },
  { id: 'feedback', label: 'Fachfeedback', owner: 'Fiktive Fachrollen · Beispiel, erfunden' },
  { id: 'decision', label: 'Entscheidung', owner: 'Rat oder beratendes Mitmachen' },
  { id: 'trace', label: 'Verlauf', owner: 'Öffentliche Nachverfolgung' },
];

export const TOPIC_CITIZEN_PROBLEM = {
  id: 'problem-tramm-status',
  date: 'Beispiel-Datum, erfunden · 20. November 2026',
  actor: 'Mara Beispiel · Bürgerin, erfunden',
  text: 'Wie lassen sich die belegten nächsten Schritte zum Beschluss nachvollziehen?',
} as const;

export const TOPIC_ARGUMENTS = [
  { id: 'pro-1', parent: null, side: 'Dafür', text: 'Eine nachvollziehbare öffentliche Statusanzeige könnte zeigen, welche Verfahrensschritte belegt sind.', sourceIds: ['minutes'], date: 'Beispiel-Datum, erfunden · 20. November 2026', actor: 'Mara Beispiel · Bürgerin, erfunden' },
  { id: 'pro-2', parent: 'pro-1', side: 'Dafür', text: 'Die Kostenregelung ließe sich als Vertragstext verlinken, ohne einen Eurobetrag zu erfinden.', sourceIds: ['minutes'], date: 'Beispiel-Datum, erfunden · 20. November 2026', actor: 'Mara Beispiel · Bürgerin, erfunden' },
  { id: 'con-1', parent: null, side: 'Dagegen', text: 'Eine zusätzliche Statuspflege kann Aufwand verursachen und beantwortet nicht, ob ein Schritt umgesetzt wurde.', sourceIds: ['paper'], date: 'Beispiel-Datum, erfunden · 20. November 2026', actor: 'Jan Beispiel · Bürger, erfunden' },
  { id: 'con-2', parent: 'con-1', side: 'Dagegen', text: 'Ohne Unterzeichnungs- oder Umsetzungsbeleg bleibt eine Fortschrittsanzeige lückenhaft.', sourceIds: ['minutes'], date: 'Beispiel-Datum, erfunden · 21. November 2026', actor: 'Jan Beispiel · Bürger, erfunden' },
] as const;

export const TOPIC_FEEDBACK_ROUNDS = [
  {
    id: 'reply-plan-r1', round: 1, date: 'Beispiel-Datum, erfunden · 20. November 2026',
    department: 'Fachbereich Planung · Rollenbeispiel, erfunden', actor: 'Lina Beispiel · Rollenfigur, erfunden',
    response: 'Die Anzeige sollte Beschluss, Vertragsschluss und Umsetzung getrennt benennen. Die vorliegende Quelle belegt nur den Beschlussauftrag.',
    sourceIds: ['minutes'], revision: 'proposal-v1 → proposal-v2 · Statusfelder für Ratsauftrag, Vertrag und Umsetzung getrennt',
    proposalId: 'proposal-v1', nextProposalId: 'proposal-v2',
  },
  {
    id: 'reply-budget-r1', round: 1, date: 'Beispiel-Datum, erfunden · 20. November 2026',
    department: 'Fachbereich Haushalt · Rollenbeispiel, erfunden', actor: 'Timo Beispiel · Rollenfigur, erfunden',
    response: 'Bitte keinen Betrag eintragen: die gelesenen Quellen nennen keine Euro-Summe. Die Vertragsregelung ersetzt keinen Kostennachweis.',
    sourceIds: ['minutes', 'paper'], revision: 'proposal-v1 → proposal-v2 · Betrag bleibt wie zuvor unbekannt',
    proposalId: 'proposal-v1', nextProposalId: 'proposal-v2',
  },
  {
    id: 'reply-plan-r2', round: 2, date: 'Beispiel-Datum, erfunden · 25. November 2026',
    department: 'Fachbereich Planung · Rollenbeispiel, erfunden', actor: 'Lina Beispiel · Rollenfigur, erfunden',
    response: 'Der Ratsauftrag bleibt als belegt sichtbar; Vertragsabschluss und Umsetzung sind weiterhin ungeklärt. Dafür ist keine weitere Statusänderung nötig.',
    sourceIds: ['minutes'], revision: 'proposal-v2 → proposal-v3 · Statusfelder unverändert beibehalten',
    proposalId: 'proposal-v2', nextProposalId: 'proposal-v3',
  },
  {
    id: 'reply-budget-r2', round: 2, date: 'Beispiel-Datum, erfunden · 25. November 2026',
    department: 'Fachbereich Haushalt · Rollenbeispiel, erfunden', actor: 'Timo Beispiel · Rollenfigur, erfunden',
    response: 'Vertragliche Kostenzuständigkeit und tatsächliche Kosten bleiben getrennte Felder; ein Beleg für tatsächliche Kosten fehlt.',
    sourceIds: ['minutes', 'paper'], revision: 'proposal-v2 → proposal-v3 · Kostenzuständigkeit und Betrag getrennt',
    proposalId: 'proposal-v2', nextProposalId: 'proposal-v3',
  },
] as const;

export const TOPIC_ADVISORY_OPTIONS = [
  'Beschluss, Vertragsschluss und Umsetzung getrennt nachweisen',
  'Zusätzlich tatsächliche Kosten veröffentlichen, sobald belegt',
  'Mir fehlen Informationen für eine Einschätzung',
] as const;
