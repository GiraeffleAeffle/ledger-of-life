export const TOPIC_AI = {
  model: 'openai-codex/gpt-6.1-sol',
  operator: 'Stadtstack · Prototyp im Auftrag von Max',
  whereRan: 'Assistenzsitzung · externes Modell; nicht auf kommunaler oder lokaler Hardware',
  generatedAt: '2026-11-16',
  mode: 'Gespeicherter KI-Entwurf. Keine Live-Inferenz, keine menschliche oder kommunale Freigabe.',
  localBoundary: 'Lokale-KI-Arbeitsplatz: Interface-Beispiel. Diese Texte wurden vom genannten Assistenzmodell verfasst, nicht auf einem kommunalen oder lokalen Modell ausgeführt.',
} as const;

export const TOPIC_OPTIONS = [
  { id: 'conditions', title: 'Mit Bedingungen weiterprüfen', brief: 'Boden, Natur und einen fairen Dorfnutzen vor dem nächsten Schritt klären.', text: 'Bodenqualität, Artenschutz, Rückbau und einen nachvollziehbaren Nutzen für das Dorf gemeinsam klären. Bürgerbeteiligung und ein möglicher Genossenschaftsanteil wären zu verhandeln, nicht zugesagt.', sourceIds: ['minutes', 'farmland'], argumentIds: ['conditions-mayor', 'village-coop'] },
  { id: 'alternatives', title: 'Flächen & Mitnutzung vergleichen', brief: 'Dächer, vorbelastete Flächen und Agri-PV als unterschiedliche Optionen prüfen.', text: 'Dächer, versiegelte Flächen und eine landwirtschaftliche Doppelnutzung als Alternativen prüfen. Die erfassten Quellen belegen hier weder verfügbare Dachpotenziale noch die technische Eignung für Agri-PV.', sourceIds: ['farmland'], argumentIds: ['alternatives-roofs', 'alternatives-farm'] },
  { id: 'pause', title: 'Erst Antworten, dann Unterstützung', brief: 'Ohne Antworten zu Boden, Natur und Nutzen kein positives beratendes Votum.', text: 'Bis zu belastbaren Unterlagen zu Boden, Natur und lokalem Nutzen kein positives beratendes Votum abgeben. Das ist eine Demooption, kein beschlossener Verfahrensstopp.', sourceIds: ['minutes'], argumentIds: ['soil-farmer', 'everyday-trust'] },
] as const;

export const TOPIC_REVISIONS = [
  { id: 'revision-plan', department: 'Bauamt', field: 'Wege & Verfahren', beforeBrief: 'Öffentlichen Rundweg einplanen', afterBrief: 'Alternative Wege prüfen · Gehrecht wurde abgelehnt', before: 'Ein öffentlich zugänglicher Rundweg soll Teil des Solarparks werden.', after: 'Eine alternative Wegeführung soll geprüft werden. Der Ausschuss hat das angeregte öffentliche Gehrecht am 16. Juni 2025 nicht aufgenommen. Der Beschluss vom 14. Oktober 2025 betrifft Entwurf und Veröffentlichung, keine abschließende Satzung.', reason: 'Keine bereits abgelehnte Anregung als zugesagtes Recht darstellen; Verfahrensstufen sauber trennen.', sourceIds: ['access', 'minutes'] },
  { id: 'revision-environment', department: 'Umwelt', field: 'Natur & Boden', beforeBrief: 'Blühstreifen als Ausgleich ansehen', afterBrief: 'Boden, Arten und Kontrollziele erst nachweisen', before: 'Blühstreifen sollen den Verlust von Ackerfläche ausgleichen.', after: 'Bodenqualität, Artenbestand, Pflegekonzept und überprüfbare Ausgleichsziele sollen offengelegt werden. Eine ökologische Verbesserung ist nicht nachgewiesen. Die beschlossene Erweiterung um Ausgleichsfläche A2 ist ein Planungsschritt, kein Wirkungsnachweis.', reason: 'Eine gewünschte Maßnahme ist noch keine nachgewiesene Kompensation.', sourceIds: ['farmland', 'minutes'] },
  { id: 'revision-finance', department: 'Finanzen', field: 'Kosten & Dorfnutzen', beforeBrief: 'Bürgerstrom und Dorf-Einnahmen vereinbaren', afterBrief: 'Erträge offen · Planungskosten trägt die Projektträgerin', before: 'Ein Bürgerstromtarif und Einnahmen für das Dorf sollen vereinbart werden.', after: 'Bürgerstromtarif, Beteiligungsmodell und kommunale Einnahmen sind offene Verhandlungsfragen. Belegt ist nur: Die Projektträgerin übernimmt laut Niederschrift sämtliche Bauleitplanungskosten gemäß geschlossenem Vertrag. Investitionssumme, Strompreis und kommunaler Nettoertrag sind unbekannt.', reason: 'Keine Rendite oder Vergünstigung versprechen; belegte Kostenträgerschaft von unbekannten Beträgen trennen.', sourceIds: ['minutes'] },
] as const;

export const TOPIC_DEPARTMENTS = [
  { id: 'department-plan', department: 'Bauamt', initials: 'BA', person: 'Lea · erfundene Fachrolle', focus: 'Was lässt sich überhaupt planen?', draft: 'Bitte den öffentlichen Weg nicht als gesichert aufführen. Die Gehrecht-Anregung wurde am 16. Juni 2025 abgelehnt; alternative Wege sind als neue Prüfoption zu kennzeichnen. Der spätere Ratsbeschluss ist ein Entwurfs- und Veröffentlichungsbeschluss.', response: 'Wir würden den Vorschlag nur mit getrennten Angaben zu bestehendem Beschluss und neuer Wege-Prüfung weitergeben.', sourceIds: ['access', 'minutes'], revisionId: 'revision-plan', round2: 'v2 trennt Wege-Prüfung und Rechtsstatus. Eine neue Wegeplanung bleibt zu klären; keine Freigabe oder erneute Behördenentscheidung.' },
  { id: 'department-environment', department: 'Umwelt', initials: 'UM', person: 'Nora · erfundene Fachrolle', focus: 'Was bedeutet das für Boden und Arten?', draft: 'Die landwirtschaftliche Vornutzung ist belegt. Der Rat erweitert um Ausgleichsfläche A2. Daraus folgt noch kein messbarer Naturgewinn. Verlange eine standortbezogene Prüfung und nachvollziehbare Pflege- und Kontrollziele.', response: 'Wir würden Boden, Artenschutz und Kontrolle als offene Nachweise aufnehmen, statt Blühstreifen pauschal als Ausgleich zu bewerten.', sourceIds: ['farmland', 'minutes'], revisionId: 'revision-environment', round2: 'v2 fordert überprüfbare Ziele statt eines behaupteten Ausgleichserfolgs. Fachgutachten und Prüfung bleiben offen.' },
  { id: 'department-finance', department: 'Finanzen', initials: 'FI', person: 'Timo · erfundene Fachrolle', focus: 'Wer bezahlt – und was bleibt hier?', draft: 'Übernimm nur die belegte Finanzierung der Bauleitplanung durch die Projektträgerin. Für Investitionskosten, Vergünstigungen oder Nettoerträge der Gemeinde liegen in den verwendeten Belegen keine belastbaren Eurobeträge vor.', response: 'Wir würden Bürgerstrom und Beteiligung als Verhandlungsfragen führen. Keine Einnahme darf bereits als Deckung im Haushalt erscheinen.', sourceIds: ['minutes'], revisionId: 'revision-finance', round2: 'v2 unterscheidet Kostenträgerschaft, unbekannte Kosten und erhofften Dorfnutzen. Eine Wirtschaftlichkeitsprüfung ist damit nicht erfolgt.' },
] as const;

export const TOPIC_OPEN_QUESTIONS = [
  'Welche Böden und landwirtschaftlichen Nutzungen sind konkret betroffen?',
  'Welche Artenschutz- und Ausgleichsziele lassen sich später überprüfen?',
  'Kann ein alternatives Wegenetz mit Eigentümern und Projektträgerin vereinbart werden?',
  'Welche Beteiligung ist für Haushalte ohne eigenes Dach und ohne großes Kapital möglich?',
  'Wer trägt Rückbau, Sicherheiten und Folgekosten – in welcher belegten Höhe?',
] as const;

export const TOPIC_ADVISORY = [
  { id: 'conditions', label: 'Weiterprüfen – mit Bedingungen für Natur und Dorfnutzen', count: 84, percent: 60 },
  { id: 'alternatives', label: 'Erst Dächer und Flächenalternativen vergleichen', count: 35, percent: 25 },
  { id: 'pause', label: 'Noch keine Unterstützung – zu viele Fragen offen', count: 21, percent: 15 },
] as const;
