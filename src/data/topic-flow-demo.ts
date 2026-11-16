export type TopicStageId = 'feed' | 'problem' | 'discussion' | 'proposal' | 'feedback' | 'decision' | 'trace';

export interface TopicSource {
  id: string;
  caseId: string | null;
  evidenceSourceId: string;
  authority: string;
  title: string;
  url: string;
  dateLabel: string;
  fact: string;
  quote: string | null;
}

export interface TopicFeedItem {
  id: string;
  title: string;
  text: string;
  sourceIds: readonly string[];
  kind: 'source' | 'example';
  dateLabel: string;
}

export interface TopicComparable {
  id: string;
  municipality: string;
  title: string;
  decision: string;
  date: string;
  sourceIds: readonly string[];
  caveat: string;
}

export const TOPIC_FLOW_TITLE = 'Solar-Freiflächenanlage · B-Plan Nr. 70 · Gemeinde Büchen';
export const TOPIC_FLOW_CASE_ID = 'case:032e2ba5ba8566598bdd0e335406fcf2';
export const TOPIC_FLOW_SNAPSHOT = 'Live-API-Erfassung · 16. November 2026 · Datenversion 20261116T043011Z · kein Ereignisdatum';

const COUNCIL_SOURCE_ID = 'html_sessionnet:council:destatis:01053:5318:01053020';
const LEGACY_CAVEAT = 'Gespeichertes Ergebnis mit unbekannter Verfahrensrolle; keine rekonstruierte Beschlusskette und kein erfasster verabschiedeter Text. Der Vorlagentitel belegt keinen Beschlussinhalt oder Betrieb.';

export const TOPIC_SOURCES: readonly TopicSource[] = [
  {
    id: 'paper', caseId: TOPIC_FLOW_CASE_ID, evidenceSourceId: COUNCIL_SOURCE_ID,
    authority: 'Ratsinformationssystem · Vorlage der Gemeinde Büchen',
    title: 'B-Plan Nr. 70 · Abwägung, Erweiterung, Entwurfs- und Veröffentlichungsbeschluss',
    url: 'https://sessionnet.amt-buechen.de/bi/vo0050.php?__kvonr=13682',
    dateLabel: 'Vorlagendatum unbekannt · Beobachtungsstand 16. November 2026',
    fact: 'Die Vorlage betrifft den B-Plan Nr. 70 „Solar-Freiflächenanlage“ der Gemeinde Büchen (AGS 01053020), nicht das Amt als Gemeinde. Das Plangebiet liegt nördlich und südlich der Bahnlinie Büchen–Hamburg.',
    quote: null,
  },
  {
    id: 'minutes', caseId: TOPIC_FLOW_CASE_ID, evidenceSourceId: COUNCIL_SOURCE_ID,
    authority: 'Niederschrift · Gemeindevertretung Büchen',
    title: 'B-Plan Nr. 70 · Beschluss vom 14. Oktober 2025',
    url: 'https://sessionnet.amt-buechen.de/bi/getfile.php?id=130299&type=do',
    dateLabel: 'Entscheidungsdatum 14. Oktober 2025',
    fact: '11 Ja, 5 Nein, 0 Enthaltungen: Stellungnahmen wurden abgewogen; der Bürgermeister soll die Einreichenden begründet informieren. Der Geltungsbereich wird um Ausgleichsfläche A2 (Flurstück 97 teilweise, Flur 2, Gemarkung Nüssau) erweitert. Entwurf und Begründung mit Umweltbericht werden gebilligt; Internetveröffentlichung, zusätzliche öffentliche Auslegung, Bekanntmachung und Beteiligung von Behörden, Nachbargemeinden und Naturschutzverbänden sind vorgesehen. Sämtliche Bauleitplanungskosten trägt laut Beschlusstext die Projektträgerin gemäß geschlossenem städtebaulichem Vertrag. Das ist kein finaler Satzungsbeschluss, keine Baugenehmigung und kein Betriebsnachweis.',
    quote: 'Sämtliche Bauleitplanungskosten werden von der Projektträgerin gemäß dem geschlossenen städtebaulichen Vertrag zur Übernahme der Bauleitplanungskosten übernommen.',
  },
  {
    id: 'access', caseId: TOPIC_FLOW_CASE_ID, evidenceSourceId: COUNCIL_SOURCE_ID,
    authority: 'Niederschrift · Bau-, Wege- und Umweltausschuss der Gemeinde Büchen',
    title: 'Anregung auf ein Gehrecht zugunsten der Allgemeinheit',
    url: 'https://sessionnet.amt-buechen.de/bi/getfile.php?id=128897&type=do',
    dateLabel: 'Entscheidungsdatum 16. Juni 2025',
    fact: 'Mit 7 Ja, 0 Nein und 1 Enthaltung beschloss der Ausschuss, der Anregung vom 29. Mai 2025 auf ein öffentliches Gehrecht im B-Plan 70 nicht zu folgen. Bei künftigen Solar-Bebauungsplänen soll über eine erneute Anregung gesondert entschieden werden. Die sieben Ja-Stimmen gelten der Nichtaufnahme, nicht der Einrichtung des Gehrechts.',
    quote: 'wird nicht gefolgt.',
  },
  {
    id: 'recommendation', caseId: TOPIC_FLOW_CASE_ID, evidenceSourceId: COUNCIL_SOURCE_ID,
    authority: 'Niederschrift · Bau-, Wege- und Umweltausschuss der Gemeinde Büchen',
    title: 'B-Plan Nr. 70 · Ausschussempfehlung',
    url: 'https://sessionnet.amt-buechen.de/bi/getfile.php?id=130008&type=do',
    dateLabel: 'Sitzungsdatum 29. September 2025 · kein separates Entscheidungsdatum erfasst',
    fact: 'Der Ausschuss empfahl die Abwägung, Erweiterung sowie den Entwurfs- und Veröffentlichungsbeschluss mit 6 Ja, 2 Nein, 0 Enthaltungen. Diese Empfehlung ist vom späteren Beschluss der Gemeindevertretung zu unterscheiden.',
    quote: null,
  },
  {
    id: 'farmland', caseId: TOPIC_FLOW_CASE_ID, evidenceSourceId: COUNCIL_SOURCE_ID,
    authority: 'Vorlagenunterlage · automatisch extrahierte Textstelle, Aussage 22',
    title: 'Bisherige landwirtschaftliche Nutzung',
    url: 'https://sessionnet.amt-buechen.de/bi/getfile.php?id=129851&type=do',
    dateLabel: 'Dokument- und Ereignisdatum der Textstelle unbekannt',
    fact: 'Die erfasste Vorlagenunterlage beschreibt das Gelände als bisher landwirtschaftlich genutzt. Die zukunftsbezogene Formulierung ist kein Nachweis einer tatsächlich errichteten Anlage.',
    quote: 'Die Anlage wird auf einem bisher landwirtschaftlich genutztem Gelände errichtet',
  },
  {
    id: 'energy', caseId: null, evidenceSourceId: 'mastr',
    authority: 'Bundesnetzagentur · Marktstammdatenregister · Gemeindekontext',
    title: 'Registrierte Solareinheiten in Büchen',
    url: 'https://download.marktstammdatenregister.de/Gesamtdatenexport_20261115_26.2.zip',
    dateLabel: 'Export 15. November 2026 · erfasst 15. November 2026, 22:25 UTC',
    fact: 'Die erfassten Solar-Zeilen für Büchen summieren sich im Status in Betrieb auf 691 registrierte Einheiten und 5.463,705 kW Nettoleistung; 8 geplante Einheiten umfassen 958,93 kW. Das sind Gemeinderegisterdaten, keine Zuordnung zum B-Plan 70 und keine Stromerzeugung.',
    quote: null,
  },
  {
    id: 'profile', caseId: null, evidenceSourceId: 'destatis-gv',
    authority: 'Destatis · Gemeindeverzeichnis · Gemeindekontext',
    title: 'Gemeinde Büchen · AGS 01053020',
    url: 'https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/Administrativ/Archiv/GVAuszugQ/AuszugGV3QAktuell.xlsx?__blob=publicationFile&v=22',
    dateLabel: 'Bevölkerung und Fläche: 31. Dezember 2025 · Gebietsstand: 30. September 2026',
    fact: 'Die Gemeinde Büchen im Kreis Herzogtum Lauenburg hat laut erfasstem Gemeindeverzeichnis 6.783 Einwohner:innen und 16,85 km² Fläche. Diese Gemeindewerte beschreiben weder das Amt noch die Fläche des Solarprojekts.',
    quote: null,
  },
  {
    id: 'broethen',
    caseId: 'legacy-paper:html_sessionnet:council:destatis:01053:5318:01053015|https://sessionnet.amt-buechen.de/bi/vo0050.php?__kvonr=13622',
    evidenceSourceId: 'html_sessionnet:council:destatis:01053:5318:01053015',
    authority: 'Vergleich · gespeichertes Ratsergebnis · Gemeinde Bröthen',
    title: 'B-Plan Nr. 5 „PV-Freiflächenanlage“ · Vorlage zum Aufstellungsbeschluss',
    url: 'https://sessionnet.amt-buechen.de/bi/to0050.php?__ktonr=159365',
    dateLabel: 'Gespeichertes Ergebnisdatum 22. Juli 2025',
    fact: `Das gespeicherte Ergebnis lautet „einstimmig beschlossen“. ${LEGACY_CAVEAT}`,
    quote: 'einstimmig beschlossen',
  },
  {
    id: 'lichtenow',
    caseId: 'legacy-paper:html_allris:council:destatis:12064:0428|https://ratsinfo-online.net/ruedersdorf-bi/vo020.asp?VOLFDNR=1923',
    evidenceSourceId: 'html_allris:council:destatis:12064:0428',
    authority: 'Vergleich · gespeichertes Ratsergebnis · Rüdersdorf bei Berlin',
    title: 'B-Plan Nr. 56 „Agri-Photovoltaik-Anlage Lichtenow“ · Vorlage zum Aufstellungsbeschluss',
    url: 'https://ratsinfo-online.net/ruedersdorf-bi/vo020.asp?VOLFDNR=1923',
    dateLabel: 'Gespeichertes Ergebnisdatum 18. Dezember 2025',
    fact: `Das gespeicherte Ergebnis lautet „ungeändert beschlossen / empfohlen“. ${LEGACY_CAVEAT}`,
    quote: 'ungeändert beschlossen / empfohlen',
  },
  {
    id: 'gruenelinde',
    caseId: 'legacy-paper:html_allris:council:destatis:12064:0428|https://ratsinfo-online.net/ruedersdorf-bi/vo020.asp?VOLFDNR=1760',
    evidenceSourceId: 'html_allris:council:destatis:12064:0428',
    authority: 'Vergleich · gespeichertes Ratsergebnis · Rüdersdorf bei Berlin',
    title: 'B-Plan Nr. 56 „Photovoltaikanlage Grünelinde“ · Vorlage zum Aufstellungsbeschluss',
    url: 'https://ratsinfo-online.net/ruedersdorf-bi/vo020.asp?VOLFDNR=1760',
    dateLabel: 'Gespeichertes Ergebnisdatum 13. Februar 2025',
    fact: `Das gespeicherte Ergebnis lautet „abgelehnt / keine Empfehlung“. ${LEGACY_CAVEAT}`,
    quote: 'abgelehnt / keine Empfehlung',
  },
];

export const TOPIC_SOURCE_TIMELINE: readonly { date: string; event: string; sourceId: string; reality: 'source' | 'snapshot' }[] = [
  { date: '16. Juni 2025', event: 'Ausschuss folgt der Anregung auf ein öffentliches Gehrecht nicht: 7 Ja, 0 Nein, 1 Enthaltung.', sourceId: 'access', reality: 'source' },
  { date: '29. September 2025 · Sitzungsdatum', event: 'Ausschussempfehlung zu Abwägung, Erweiterung und Entwurf/Veröffentlichung: 6 Ja, 2 Nein, 0 Enthaltungen.', sourceId: 'recommendation', reality: 'source' },
  { date: '14. Oktober 2025', event: 'Gemeindevertretung beschließt Abwägung, zusätzliche Ausgleichsfläche sowie Entwurf und Veröffentlichung: 11 Ja, 5 Nein, 0 Enthaltungen. Kein finaler Satzungs- oder Baubeschluss.', sourceId: 'minutes', reality: 'source' },
  { date: 'Datum unbekannt', event: 'Vorlagenunterlage beschreibt das Gelände als bisher landwirtschaftlich genutzt; keine datierte Umsetzungsmeldung.', sourceId: 'farmland', reality: 'source' },
  { date: '16. November 2026 · Beobachtungsstand', event: 'Fall-, Vergleichs- und Gemeindekontext aus der Live-API erfasst. Das Erfassungsdatum ist kein neuer kommunaler Beschluss.', sourceId: 'paper', reality: 'snapshot' },
];

export const TOPIC_DEMO_STAGES: readonly { id: TopicStageId; label: string; owner: string }[] = [
  { id: 'feed', label: 'Ortsfeed', owner: 'Veröffentlichte Quellen' },
  { id: 'problem', label: 'Anliegen', owner: 'Bürger:in · Beispiel, erfunden' },
  { id: 'discussion', label: 'Stimmen', owner: 'Bürger:innen · Beispiel, erfunden' },
  { id: 'proposal', label: 'Vorschlag', owner: 'KI-Beispiel · Beispiel, erfunden · offline erstellt, menschlich ungeprüft' },
  { id: 'feedback', label: 'Prüfung', owner: 'Fiktive Fachrollen · Beispiel, erfunden' },
  { id: 'decision', label: 'Votum', owner: 'Belegter Rat / beratendes Mitmachen · Beispiel, erfunden' },
  { id: 'trace', label: 'Spur', owner: 'Quellen und Beispielschritte getrennt' },
];

export const TOPIC_CITIZEN_PROBLEM = {
  id: 'problem-buechen-b70',
  date: 'Beispiel-Datum, erfunden · 17. November 2026',
  actor: 'Mara Beispiel · Bürgerin · Beispiel, erfunden',
  text: 'Solarpark statt Acker – was bringt das unserem Dorf?',
  body: 'Beispiel, erfunden: Wir wohnen mit unseren Kindern in der Nähe und gehen dort spazieren. Ich will sauberen Strom – aber auch verstehen, was aus dem Acker wird. Können Menschen ohne eigenes Dach mitmachen? Bleiben Wege nutzbar? Und wer kümmert sich später um Boden, Natur und Rückbau? Ich möchte nicht einfach dafür oder dagegen sein, bevor wir diese Fragen gemeinsam geklärt haben.',
} as const;

export const TOPIC_FEED_ITEMS: readonly TopicFeedItem[] = [
  { id: 'feed-access', kind: 'source', dateLabel: '16. Juni 2025', title: 'Öffentliches Gehrecht nicht aufgenommen', text: 'Der Ausschuss folgt der nachträglichen Anregung nicht. 7 Ja, 0 Nein, 1 Enthaltung gelten der Ablehnung der Aufnahme, nicht einem beschlossenen Weg.', sourceIds: ['access'] },
  { id: 'feed-recommendation', kind: 'source', dateLabel: '29. September 2025 · Sitzungsdatum', title: 'Ausschuss empfiehlt nächsten Planungsschritt', text: '6 Ja, 2 Nein, 0 Enthaltungen für die Empfehlung zu Abwägung, Erweiterung und Entwurf/Veröffentlichung; noch kein Ratsbeschluss.', sourceIds: ['recommendation'] },
  { id: 'feed-council', kind: 'source', dateLabel: '14. Oktober 2025', title: 'Rat beschließt Entwurf und Veröffentlichung', text: '11 Ja, 5 Nein, 0 Enthaltungen: Abwägung, Erweiterung um Ausgleichsfläche A2, gebilligter Entwurf und Beteiligung. Laut Text übernimmt die Projektträgerin die Bauleitplanungskosten. Kein finaler Satzungsbeschluss und kein Betriebsnachweis.', sourceIds: ['minutes', 'paper'] },
  { id: 'feed-farmland', kind: 'source', dateLabel: 'Datum der Textstelle unbekannt', title: 'Landwirtschaftliche Vornutzung dokumentiert', text: 'Eine Vorlagenunterlage beschreibt das Gelände als bisher landwirtschaftlich genutzt. Das ist Planungskontext, kein Nachweis einer bereits errichteten Anlage.', sourceIds: ['farmland'] },
  { id: 'feed-energy', kind: 'source', dateLabel: 'Registerexport 15. November 2026', title: 'Solarkontext der Gemeinde, nicht des Projekts', text: '691 registrierte Solareinheiten im Status in Betrieb mit zusammen 5.463,705 kW Nettoleistung. Keine Aussage über Leistung, Ertrag oder Umsetzung des B-Plans 70.', sourceIds: ['energy', 'profile'] },
  { id: 'feed-citizen', kind: 'example', dateLabel: TOPIC_CITIZEN_PROBLEM.date, title: 'Bürgerfrage · Beispiel, erfunden', text: TOPIC_CITIZEN_PROBLEM.text, sourceIds: ['access', 'farmland', 'minutes'] },
];

export const TOPIC_COMPARABLES: readonly TopicComparable[] = [
  { id: 'broethen', municipality: 'Bröthen', title: 'B-Plan Nr. 5 „PV-Freiflächenanlage“ · Vorlage zum Aufstellungsbeschluss', decision: 'einstimmig beschlossen', date: '22. Juli 2025', sourceIds: ['broethen'], caveat: LEGACY_CAVEAT },
  { id: 'lichtenow', municipality: 'Rüdersdorf bei Berlin', title: 'B-Plan Nr. 56 „Agri-Photovoltaik-Anlage Lichtenow“ · Vorlage zum Aufstellungsbeschluss', decision: 'ungeändert beschlossen / empfohlen', date: '18. Dezember 2025', sourceIds: ['lichtenow'], caveat: LEGACY_CAVEAT },
  { id: 'gruenelinde', municipality: 'Rüdersdorf bei Berlin', title: 'B-Plan Nr. 56 „Photovoltaikanlage Grünelinde“ · Vorlage zum Aufstellungsbeschluss', decision: 'abgelehnt / keine Empfehlung', date: '13. Februar 2025', sourceIds: ['gruenelinde'], caveat: LEGACY_CAVEAT },
];

export const TOPIC_ENERGY = {
  summary: 'Büchen: 691 registrierte Solareinheiten in Betrieb · 5.463,705 kW Nettoleistung',
  detail: 'Gemeinde Büchen, AGS 01053020; MaStR-Export vom 15. November 2026. Aus den erfassten Solar-Zeilen summiert: in Betrieb 691 Einheiten / 5.463,705 kW, geplant 8 / 958,93 kW. In diesen Zeilen fehlen keine Leistungswerte. Inbetriebnahme-Jahrgänge beschreiben heute noch betriebene Einheiten, keinen historischen Bestand oder jährlichen Bruttozubau; das laufende Jahr ist unvollständig. Fehlende Zeilen bedeuten unbekannt, nicht null. Keine Zuordnung zum B-Plan 70, kein Erzeugungswert, keine Aussage zu dessen Bau oder Betrieb.',
  sourceIds: ['energy', 'profile'],
} as const;

export const TOPIC_COUNCIL = {
  summary: 'Beschlossen sind Abwägung, Erweiterung um Ausgleichsfläche A2, Billigung des Entwurfs mit Begründung und Umweltbericht sowie Veröffentlichung und Beteiligung. Einreichende sollen begründet informiert werden. Der Beschlusstext nennt die Übernahme sämtlicher Bauleitplanungskosten durch die Projektträgerin gemäß geschlossenem städtebaulichem Vertrag.',
  limits: 'Kein finaler Satzungsbeschluss, keine Baugenehmigung, kein Nachweis von Bau, Betrieb oder tatsächlich entstandenen Kosten. Die Veröffentlichung und Beteiligung werden beschlossen; ihre Durchführung ist damit nicht nachgewiesen. Der separate Gehrecht-Beschluss vom Juni und die Ausschussempfehlung vom September bleiben eigene Schritte.',
  votes: '11 dafür · 5 dagegen · 0 Enthaltungen',
  date: '14. Oktober 2025',
  body: 'Gemeindevertretung Büchen',
  sourceIds: ['minutes', 'recommendation', 'access'],
} as const;
