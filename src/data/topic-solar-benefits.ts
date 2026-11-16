export const SOLAR_BENEFIT_SCOPE = 'Allgemein möglich · für B70 nicht zugesagt';
export const SOLAR_BENEFIT_RESEARCH_DATE = '2026-11-16';

// Editorial excerpts, not project forecasts. Dates refer to the source, not to B70.
export const SOLAR_BENEFIT_SOURCES = {
  climate: {
    label: 'UBA · Ökobilanz',
    title: 'Umweltbundesamt: Photovoltaik – Ökobilanzielle Betrachtung',
    url: 'https://www.umweltbundesamt.de/themen/klima-energie/erneuerbare-energien/photovoltaik',
    publishedAt: '2024-03-26',
    locator: 'Ökobilanzielle Betrachtung',
    quote: 'Die Herstellung und das Recycling sind diejenigen Lebensphasen einer Photovoltaikanlage, in denen Umweltwirkungen entstehen.',
    detail: 'Die Quelle bilanziert Lebenszyklus-Emissionen und die Verdrängung fossiler Stromerzeugung. Ihre allgemeinen Faktoren werden hier nicht auf B70 hochgerechnet.',
  },
  imports: {
    label: 'UBA · Energieimporte',
    title: 'Umweltbundesamt: Primärenergiegewinnung und -importe',
    url: 'https://www.umweltbundesamt.de/daten/umweltzustand-trends/energie/primaerenergiegewinnung-importe',
    publishedAt: '2025-12-18',
    locator: 'Importabhängigkeit verringern',
    quote: 'Um die Abhängigkeit von Energieimporten weiter zu verringern, sollten heimische erneuerbare Energien weiter ausgebaut und Lieferländer und Transportstrukturen diversifiziert werden.',
    detail: 'Energiesystem-Effekt, keine Zusicherung einer örtlichen Stromversorgung oder vollständiger Unabhängigkeit von Technik- und Rohstoffimporten.',
  },
  backup: {
    label: 'Verbraucherzentrale · Ersatzstrom',
    title: 'Verbraucherzentrale Bayern: Kann die eigene Solaranlage bei Stromausfall Energie liefern?',
    url: 'https://www.verbraucherzentrale.bayern/pressemitteilungen/albtraum-stromausfall-kann-die-eigene-solaranlage-trotzdem-energie-liefern-124278',
    publishedAt: '2026-07-22',
    locator: 'Warum PV-Anlagen bei Stromausfall meist abschalten; Not- und Ersatzstrom',
    quote: 'Standard-PV-Anlagen sind mit dem öffentlichen Stromnetz verbunden. Fällt das Netz aus, schalten sie sich automatisch ab.',
    detail: 'Die Quelle beschreibt Haustechnik: spezieller netzunabhängig arbeitsfähiger Wechselrichter, gegebenenfalls Umschalttechnik und möglichst Batteriespeicher. Sie belegt kein kommunales Inselnetz und kein B70-Versorgungskonzept.',
  },
  value: {
    label: 'IÖW · regionale Wertschöpfung',
    title: 'IÖW: Stärkung der regionalen Wertschöpfung durch Erneuerbare Energien',
    url: 'https://www.ioew.de/projekt/staerkung_der_regionalen_wertschoepfung_durch_erneuerbare_energien',
    publishedAt: null,
    locator: 'Forschungsauftrag; Wertschöpfungs- und Beschäftigungseffekte von Windenergie- und Photovoltaik-Anlagen',
    quote: 'Als wichtig wurde etwa die Einbindung zentraler regionaler Akteure und der Bevölkerung herausgestellt.',
    detail: 'Primärquelle des Forschungsinstituts zu regionalwirtschaftlichen Potenzialen. Lokale Aufträge und Beschäftigung sind Gestaltungsmöglichkeiten, keine belegten B70-Aufträge oder Arbeitsplatz-Zahlen.',
  },
  lease: {
    label: 'BGB · § 581',
    title: 'BGB § 581: Vertragstypische Pflichten beim Pachtvertrag',
    url: 'https://www.gesetze-im-internet.de/bgb/__581.html',
    publishedAt: null,
    locator: 'Absatz 1 Satz 2',
    quote: 'Der Pächter ist verpflichtet, dem Verpächter die vereinbarte Pacht zu entrichten.',
    detail: 'Privatrechtlich vereinbarte Pacht ist von kommunalen Steuern und EEG-Zuwendungen zu trennen. Die Gemeinde profitiert als Verpächterin nur, wenn sie selbst entsprechende Flächen verpachtet.',
  },
  profit: {
    label: 'GewStG · § 7',
    title: 'GewStG § 7: Gewerbeertrag',
    url: 'https://www.gesetze-im-internet.de/gewstg/__7.html',
    publishedAt: null,
    locator: 'Satz 1',
    quote: 'Gewerbeertrag ist der nach den Vorschriften des Einkommensteuergesetzes oder des Körperschaftsteuergesetzes zu ermittelnde Gewinn aus dem Gewerbebetrieb',
    detail: 'Auszug aus Satz 1; die gesetzliche Bemessung berücksichtigt außerdem Hinzurechnungen und Kürzungen. Installierte Leistung ist nicht selbst der steuerpflichtige Gewinn.',
  },
  allocation: {
    label: 'GewStG · § 29',
    title: 'GewStG § 29: Zerlegungsmaßstab',
    url: 'https://www.gesetze-im-internet.de/gewstg/__29.html',
    publishedAt: null,
    locator: 'Absatz 1 Nummer 2',
    quote: 'bei Betrieben, die ausschließlich Anlagen zur Erzeugung von Strom und anderen Energieträgern sowie Wärme aus Windenergie und solarer Strahlungsenergie betreiben',
    detail: 'Für die genannten Betriebe wird der Messbetrag grundsätzlich zu einem Zehntel nach Arbeitslöhnen und zu neun Zehnteln nach installierter Leistung aufgeteilt. Daraus folgt keine garantierte Steuerzahlung für B70.',
  },
  eeg: {
    label: 'EEG · § 6',
    title: 'EEG § 6: Finanzielle Beteiligung der Kommunen am Ausbau',
    url: 'https://www.gesetze-im-internet.de/eeg_2014/__6.html',
    publishedAt: null,
    locator: 'Absätze 1, 3 und 4',
    quote: 'Bei Freiflächenanlagen dürfen den betroffenen Gemeinden Beträge von insgesamt 0,2 Cent pro Kilowattstunde für die tatsächlich eingespeiste Strommenge angeboten werden.',
    detail: 'Optionales Angebot nach § 6 EEG; Vereinbarung und tatsächlich eingespeiste Menge erforderlich. Gegebenenfalls Aufteilung auf mehrere Standortgemeinden. Vereinbarungen unterliegen Absatz 4; ein Entwurfs-/Veröffentlichungsbeschluss belegt keine solche Vereinbarung. Andere landesrechtliche Beteiligungspflichten werden damit nicht bewertet.',
  },
  cooperative: {
    label: 'Verbraucherzentrale · Genossenschaft',
    title: 'Verbraucherzentrale: Energiegenossenschaften – Gemeinsam in die Energiewende investieren',
    url: 'https://www.verbraucherzentrale.de/wissen/geld-versicherungen/nachhaltige-geldanlage/energiegenossenschaften-gemeinsam-in-die-energiewende-investieren-11295',
    publishedAt: '2026-09-01',
    locator: 'Mitbestimmung; Dividende; Risiken einer Beteiligung',
    quote: 'Im Fall der Insolvenz muss mit dem Totalverlust des eingesetzten Kapitals gerechnet werden.',
    detail: 'Mitglieder können gemeinsam investieren und mitbestimmen; Dividenden können entfallen. Satzung und eine mögliche Nachschusspflicht prüfen. Eine Kapitalbeteiligung ist kein Stromliefervertrag und begründet hier keinen Ortstarif.',
  },
  agri: {
    label: 'Fraunhofer ISE · Agri-PV',
    title: 'Fraunhofer ISE: Agri-Photovoltaik',
    url: 'https://www.ise.fraunhofer.de/de/geschaeftsfelder/solarkraftwerke-und-integrierte-photovoltaik/integrierte-photovoltaik/agri-photovoltaik-agri-pv.html',
    publishedAt: null,
    locator: 'Einleitung; Strategieentwicklung; standortspezifische Machbarkeit',
    quote: 'Agri-Photovoltaik beschreibt ein Verfahren zur simultanen Nutzung landwirtschaftlicher Flächen für Nahrungsmittelproduktion und PV-Stromerzeugung.',
    detail: 'Das ISE unterscheidet Bewirtschaftung unter hoch aufgeständerten Modulen und zwischen bodennahen Reihen. Kultur, Arbeitsbreiten, Licht, Wasser und Ertrag müssen standortspezifisch untersucht werden.',
  },
  guide: {
    label: 'Fraunhofer ISE · Leitfaden',
    title: 'Fraunhofer ISE: Agri-Photovoltaik – Chance für Landwirtschaft und Energiewende',
    url: 'https://www.ise.fraunhofer.de/content/dam/ise/de/documents/publications/studies/APV-Leitfaden.pdf',
    publishedAt: '2025-06',
    locator: '4. Auflage; Kapitel 2.3 (S. 10–11), 2.4 (Dresden-Pillnitz) und 2.5 (vertikale Praxisanlagen)',
    quote: 'Die landwirtschaftliche Nutzung findet in diesem Fall unter den PV-Modulen statt, während in bodennahen Anlagen typischerweise die Flächen zwischen den PV-Modulen bewirtschaftet werden.',
    detail: 'Der Leitfaden beschreibt hoch aufgeständerte, bodennahe und vertikale Systeme sowie Nutzungskonzepte, landwirtschaftliche Referenzerträge und die Abgrenzung zu herkömmlichen PV-Freiflächenanlagen. Er unterscheidet pflanzenbezogene DIN SPEC 91434 von ergänzenden tierhaltungsbezogenen Anforderungen der DIN SPEC 91492. Die Illustrationen sind eigene vereinfachte Schemata, keine nachgezeichneten Quellenbilder.',
  },
  din: {
    label: 'DIN · SPEC 91434',
    title: 'DIN: Solarstrom vom Feld – DIN SPEC 91434',
    url: 'https://www.din.de/de/forschung-und-innovation/din-spec/solarstrom-vom-feld-858856',
    publishedAt: null,
    locator: 'Die DIN SPEC',
    quote: 'Die DIN SPEC 91434 legt Kriterien und Anforderungen an die landwirtschaftliche Hauptnutzung im Bereich Agri-Photovoltaik fest, zum Beispiel für Planung, Betrieb, Dokumentation und Betriebsüberwachung.',
    detail: 'Ein landwirtschaftliches Nutzungskonzept und nachprüfbare Kriterien sind erforderlich. Redaktionelle Einordnung: Das bloße Vorhandensein von Schafen, Grünpflege oder Pflanzen zwischen Modulen ist kein Konformitätsnachweis. Echte landwirtschaftliche Tierhaltung wird dadurch nicht pauschal ausgeschlossen.',
  },
  b70: {
    label: 'B70 · erfasste Ratsvorlage',
    title: 'Büchen: Bebauungsplan Nr. 70 „Solar-Freiflächenanlage“',
    url: 'https://sessionnet.amt-buechen.de/bi/vo0050.php?__kvonr=13682',
    publishedAt: null,
    locator: 'Lokal erfasste Quelle: src/data/topic-evidence.json; kein erneuter kommunaler Abruf',
    quote: 'Bebauungsplan Nr. 70 "Solar-Freiflächenanlage"',
    detail: 'Büchen, AGS 01053020. Hier kein Agri-PV-Nachweis. Tatsächliche B70-Leistung, Ertrag und Kosten sind in dieser Darstellung unbekannt; keine CO₂-, Versorgungs- oder Einkommensprognose.',
  },
  lichtenow: {
    label: 'Lichtenow · erfasste Planung',
    title: 'Rüdersdorf: B-Plan Nr. 56 „Agri-Photovoltaik-Anlage Lichtenow“ – Aufstellungsbeschluss',
    url: 'https://ratsinfo-online.net/ruedersdorf-bi/vo020.asp?VOLFDNR=1923',
    publishedAt: '2025-10-20',
    locator: 'BV-1612/2025; lokal erfasst in src/data/topic-comparison-evidence.json, Aussage 8',
    quote: 'Beschluss zum Bebauungsplan Nr. 56 "Agri-Photovoltaik-Anlage Lichtenow" - Aufstellungsbeschluss.',
    detail: 'Titel einer Planung, kein Beleg für Bau, Betrieb, DIN-Konformität oder Erfolg. Datum bezeichnet die eingebrachte Vorlage; kein Inbetriebnahmedatum. Kein erneuter kommunaler Abruf.',
  },
} as const;

export type SolarBenefitSourceId = keyof typeof SOLAR_BENEFIT_SOURCES;
export type SolarBenefitIcon = 'climate' | 'imports' | 'backup' | 'value' | 'lease' | 'tax' | 'eeg' | 'cooperative';

export const SOLAR_BENEFITS = [
  {
    icon: 'climate', title: 'Weniger Klimagase', audience: 'Für das Energiesystem',
    claim: 'Solarstrom kann fossile Stromerzeugung und ihre Emissionen verdrängen.',
    limit: 'Herstellung und Recycling zählen mit. Keine CO₂-Zahl für B70 belegt.',
    sources: ['climate'],
  },
  {
    icon: 'imports', title: 'Weniger fossile Importe', audience: 'Für das Energiesystem',
    claim: 'Heimische Sonnenenergie kann die Abhängigkeit von importierten Brennstoffen senken.',
    limit: 'Keine vollständige Unabhängigkeit; kein Versorgungsversprechen für Büchen.',
    sources: ['imports'],
  },
  {
    icon: 'backup', title: 'Resilienz braucht Extras', audience: 'Nur mit Versorgungskonzept',
    claim: 'Speicher plus insel-/ersatzstromfähige Technik können Versorgung bei Netzausfall ermöglichen.',
    limit: 'Netz-PV allein garantiert weder lokalen Strom noch Notstrom. Für B70 nicht belegt.',
    sources: ['backup'],
  },
  {
    icon: 'value', title: 'Aufträge vor Ort', audience: 'Für regionale Betriebe',
    claim: 'Planung, Installation und Betrieb können regionale Wertschöpfung schaffen.',
    limit: 'Nur mit regionaler Einbindung; keine lokalen Aufträge oder Jobs für B70 zugesagt.',
    sources: ['value'],
  },
  {
    icon: 'lease', title: 'Pacht für Eigentümer', audience: 'Für die Verpachtenden',
    claim: 'Wer Flächen verpachtet, kann vertraglich vereinbarte Pachteinnahmen erhalten.',
    limit: 'Private Pacht ist kein Gemeindeertrag. Vertrag und Eigentum entscheiden.',
    sources: ['lease'],
  },
  {
    icon: 'tax', title: 'Mögliche Gewerbesteuer', audience: 'Für die Gemeinde',
    claim: 'Steuerpflichtiger Gewerbeertrag kann Einnahmen für die Gemeinde bringen.',
    limit: 'Abhängig von Gewinn, Steuerregeln und örtlicher Zuordnung – nicht garantiert.',
    sources: ['profit', 'allocation'],
  },
  {
    icon: 'eeg', title: 'Kommunale Beteiligung', audience: 'Für die Standortgemeinde',
    claim: '§ 6 EEG ermöglicht ein freiwilliges Angebot von insgesamt 0,2 ct je eingespeister kWh.',
    limit: 'Nur mit Vereinbarung und tatsächlicher Einspeisung. Für B70 nicht zugesagt.',
    sources: ['eeg'],
  },
  {
    icon: 'cooperative', title: 'Gemeinsam beteiligen', audience: 'Für interessierte Bürger:innen',
    claim: 'Eine Energiegenossenschaft kann Mitbestimmung und Beteiligung an Gewinnen ermöglichen.',
    limit: 'Auch Verluste bis zum Kapitalverlust möglich. Kein automatisch günstiger Stromtarif.',
    sources: ['cooperative'],
  },
] as const satisfies readonly {
  icon: SolarBenefitIcon; title: string; audience: string; claim: string; limit: string;
  sources: readonly SolarBenefitSourceId[];
}[];

export const AGRI_PV_PANELS = [
  {
    kind: 'classic', label: 'Klassische Freiflächen-PV', title: 'Strom im Vordergrund',
    claim: 'Bodennahe Modulreihen; Grünpflege oder Beweidung können dazukommen.',
    limit: 'Schafe oder Mähen allein belegen keine Agri-PV-Konformität.',
    sources: ['guide', 'din'],
  },
  {
    kind: 'raised', label: 'Agri-PV · hoch aufgeständert', title: 'Ernte unter Modulen',
    claim: 'Höher montierte Module lassen Raum für landwirtschaftliche Bewirtschaftung darunter.',
    limit: 'Kultur, Licht und Maschinen müssen zum Anlagendesign passen.',
    sources: ['guide', 'din'],
  },
  {
    kind: 'vertical', label: 'Agri-PV · zwischen Reihen', title: 'Ernte neben Modulen',
    claim: 'Zum Beispiel vertikale Module mit landwirtschaftlich genutzten Streifen dazwischen.',
    limit: 'Reihenabstand und Ertrag brauchen ein standortspezifisches Konzept.',
    sources: ['guide', 'din'],
  },
] as const;
