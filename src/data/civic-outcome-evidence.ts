export type EvidenceBasis = 'observed' | 'reported_output' | 'planned' | 'estimate';

export type CivicOutputEvidence = {
  id: string; label: string; value: number | string; unit?: string; basis: EvidenceBasis;
  date: string | null; sourceUrl: string; locator: string;
};
export type CivicSourceFact = { from: string; predicate: string; to: string; basis: 'observed' | 'planned'; date: string | null; sourceUrl: string; locator: string };
export type CivicIndicator = {
  label: string; unit: 'seconds'; boundary: string; method: string; caveat: string;
  baseline: { value: number; period: string; sourceUrl: string; locator: string };
  followUp: { value: number; period: string; sourceUrl: string; locator: string };
};

export type CivicOutcomeEvidence = {
  id: string;
  cityId: string;
  signalIds: string[];
  title: string;
  topic: string;
  sourceTitle?: string;
  outputs: CivicOutputEvidence[];
  /** Source-reported relationships and spend do not establish the funding source or causal effects. */
  relations?: CivicSourceFact[];
  spending?: { planned: Omit<CivicOutputEvidence, 'id'>; recorded: Omit<CivicOutputEvidence, 'id'>; caveat: string };
  indicator?: CivicIndicator;
  metrics: {
    id: string;
    label: string;
    value: number;
    unit: string;
    basis: EvidenceBasis;
    period: string | null;
    sourceUrl: string;
    locator: string;
  }[];
  benefitIndicatorMissing: string;
  missingEvidence: string[];
  comparisonCaveat: string;
  geometryNote: string;
  checkedAt: string;
};

const checkedAt = '2026-09-27';
const cultureSource = 'https://www.stadt-strausberg.de/aktuelles/kulturpark-strausberg-zweiter-bauabschnitt-wird-zum-monatsende-fertiggestellt/';
const heatRuedersdorfSource = 'https://www.ruedersdorf.de/meine-gemeinde/konzepte/kommunale-waermeplanung/';
const heatStrausbergSource = 'https://www.stadt-strausberg.de/stadtentwicklung-2/kommunale-waermeplanung/';
const budgetSource = 'https://www.stadt-strausberg.de/wp-content/uploads/2025/04/2024-11-07_Haushaltssatzung_2025_2026.pdf';

export const MUNSTER_BUS_TRIAL_ID = 'muenster-bus-priority-2021';
const muensterReport = 'https://www.stadt-muenster.de/fileadmin/user_upload/stadt-muenster/61_verkehrsplanung/pdf/verkehrsversuche2021_endbericht.pdf';
export const civicOutcomeEvidence: readonly CivicOutcomeEvidence[] = [
  {
    id: MUNSTER_BUS_TRIAL_ID,
    cityId: 'muenster',
    signalIds: [],
    title: 'Bus priority trial · Ludgeriplatz to Landeshaus (2021)',
    topic: 'public-transport',
    sourceTitle: 'Stadt Münster · trial evaluation report',
    outputs: [{
      id: 'bus-lane-reported-500m',
      label: 'Added bus-only lane within the roughly 1 km test corridor',
      value: 500, unit: 'm', basis: 'reported_output', date: null,
      sourceUrl: muensterReport,
      locator: 'Executive summary, PDF p. 12 (500 m added bus-only lane); §4.1.3, PDF p. 125 (trial began 2 August 2021, initially eight weeks and later continued)',
    }],
    relations: [
      { from: 'Amt für Mobilität und Tiefbau', predicate: 'steered', to: '2021 bus-priority trial', basis: 'observed', date: null, sourceUrl: muensterReport, locator: '§4.1.4, PDF pp. 126–127; municipal planning staff on PDF p. 2' },
      { from: 'Fachstelle Verkehrsplanung', predicate: 'coordinated', to: 'evaluation', basis: 'observed', date: null, sourceUrl: muensterReport, locator: '§4.1.4, PDF pp. 126–127' },
      { from: 'Ordnungsamt + Polizei Münster', predicate: 'coordinated', to: 'traffic rules', basis: 'observed', date: null, sourceUrl: muensterReport, locator: '§4.1.4, PDF pp. 126–127' },
      { from: 'Stadtwerke Münster', predicate: 'supplied', to: 'bus GPS data', basis: 'observed', date: null, sourceUrl: muensterReport, locator: '§4.2.1, PDF pp. 130–131; PDF p. 135 footnote' },
      { from: 'LK Argus', predicate: 'evaluated', to: 'bus running times', basis: 'observed', date: null, sourceUrl: muensterReport, locator: '§4.2.1, PDF pp. 130–131; evaluation staff on PDF p. 2' },
    ],
    spending: {
      planned: { label: 'Forecast trial expenditure · marking, signage, evaluation, communication', value: 60000, unit: 'EUR', basis: 'planned', date: null, sourceUrl: muensterReport, locator: '§4.1.3, PDF p. 126, Kosten: forecast expenditure' },
      recorded: { label: 'Approximate expenditure through year-end 2021 · NOT final trial cost', value: 'about €42,000', basis: 'reported_output', date: '2021-12-31', sourceUrl: muensterReport, locator: '§4.1.3, PDF p. 126, Kosten: actual spending at year-end 2021; report says trial continued' },
      caveat: 'The trial continued after 2021: this is not a final underspend. Funding source and appropriation are not established in this report.',
    },
    indicator: {
      label: 'Mean full-route bus running time · Ludgeriplatz → Hauptbahnhof → Eisenbahnstraße',
      unit: 'seconds',
      boundary: 'The same complete north/east-bound route, about 1 km; buses traversing the entire route, not summed segment means.',
      method: 'Stadtwerke bus GPS stop arrival, dwell and departure timestamps; 12 Monday–Saturday days in each window, outside summer holidays. Number of bus trips was not supplied.',
      caveat: 'Before/during association, not an isolated lane effect or passenger door-to-door time. The samples are in different years (2019 and 2021), with pandemic-era conditions, simultaneous trials and roadworks. The report notes initial station-area car queues and variable longer car journeys, easing after weeks; no numeric car effect is inferred. No control route, 2026 lane status or passenger-wide benefit established.',
      baseline: { value: 251, period: '17–30 June 2019', sourceUrl: muensterReport, locator: '§4.2.1, PDF pp. 130–131 (method); §4.3.1, PDF p. 136 (whole-route 4:11 mean)' },
      followUp: { value: 235, period: '23 August–5 September 2021', sourceUrl: muensterReport, locator: '§4.3.1, PDF p. 138 (whole-route 3:55 mean); p. 141 confirms approximately 16-second difference' },
    },
    metrics: [],
    benefitIndicatorMissing: 'Longer-term passenger outcomes and causal attribution were not measured in this comparison',
    missingEvidence: ['Control/counterfactual for the bus-lane effect', 'Number of whole-route bus trips in each sample', 'Comparable longer-term bus and car observations', 'Final trial cost and funding source', 'Current bus-lane status'],
    comparisonCaveat: 'The full-route 251 s → 235 s comparison is from complete-trip buses; sums of separate segment averages (247 s → 227 s) are not the same cohort. The 16-second (~6.4%) lower mean is an observed difference, not a proven effect of the lane.',
    geometryNote: 'Münster report names the corridor and includes maps; no matching published CitySignal geometry is verified. The city map is context only, not the trial route or an affected area.',
    checkedAt: '2026-09-28',
  },
  {
    id: 'strausberg-kulturpark-phase-2',
    cityId: 'strausberg',
    signalIds: ['atlas:kulturpark'],
    title: 'Kulturpark · Bauabschnitt 2',
    topic: 'public-space',
    outputs: [
      {
        id: 'kulturpark-phase-one-facilities',
        label: 'Phase 1 · reported present',
        value: 'Volleyball court · playground · barrier-free connecting paths',
        basis: 'reported_output',
        date: null,
        sourceUrl: cultureSource,
        locator: 'Article “Kulturpark Strausberg: Zweiter Bauabschnitt wird zum Monatsende fertiggestellt”, paragraph describing the first construction phase as already having the volleyball court, playground and barrier-free connecting paths',
      },
      {
        id: 'kulturpark-phase-two-scheduled-opening',
        label: 'Sportbereich und Badestelle zur Freigabe angekündigt',
        value: '3 October 2026',
        basis: 'planned',
        date: '2026-10-03',
        sourceUrl: cultureSource,
        locator: 'Article “Kulturpark Strausberg: Zweiter Bauabschnitt wird zum Monatsende fertiggestellt”; publication 24 September 2026; says phase scheduled for completion end September and sport area/bathing area to open from 3 October',
      },
    ],
    metrics: [
      { id: 'kulturpark-ping-pong-tables', label: 'Planned new table-tennis tables in phase 2', value: 2, unit: 'tables', basis: 'planned', period: 'phase 2; article published 24 September 2026', sourceUrl: cultureSource, locator: 'Paragraph “Zu den neuen Attraktionen des zweiten Bauabschnitts”' },
    ],
    benefitIndicatorMissing: 'Actual park use and accessible experience · no measured values in reviewed sources',
    missingEvidence: ['Confirmation after scheduled opening and completion', 'Actual use/visitor counts', 'Accessibility audit or user experience', 'Final completion/acceptance record (article says acceptance initially excludes planting)', 'Project actual cost'],
    comparisonCaveat: 'As of the 24 September report, phase-2 completion/opening are near-future plans, not achieved outputs; no use or social impact is measured. Initial acceptance excludes planned planting.',
    geometryNote: 'Use the linked Kulturpark signal geometry as approximate project/place context, not a surveyed works boundary.',
    checkedAt,
  },
  {
    id: 'strausberg-solarpark-flugplatz',
    cityId: 'strausberg',
    signalIds: ['atlas:solarpark-flugplatz'],
    title: 'Solarpark am Flugplatz',
    topic: 'solar-energy',
    outputs: [{
      id: 'solarpark-proposed-capacity',
      label: 'Proposed photovoltaic park capacity',
      value: 48,
      unit: 'MWp',
      basis: 'planned',
      date: null,
      sourceUrl: 'https://bb.beteiligung.diplanung.de/verfahren/solarpark-flugplatz/public/detail',
      locator: 'Planungsanlass: solar park is intended to provide nominal capacity of 48 MWp for at least 25 years',
    }],
    metrics: [
      { id: 'solarpark-area', label: 'Plan area', value: 41.5, unit: 'ha', basis: 'planned', period: null, sourceUrl: 'https://bb.beteiligung.diplanung.de/verfahren/solarpark-flugplatz/public/detail', locator: 'Planungsanlass: “Fläche von ca. 41,5 ha”' },
      { id: 'solarpark-nominal-capacity', label: 'Intended nominal capacity', value: 48, unit: 'MWp', basis: 'planned', period: 'intended minimum operating duration: 25 years', sourceUrl: 'https://bb.beteiligung.diplanung.de/verfahren/solarpark-flugplatz/public/detail', locator: 'Planungsanlass: “für mindestens 25 Jahre eine Nennleistung von 48 Megawatt Peak (MWp)”' },
    ],
    benefitIndicatorMissing: 'Actual annual generation (MWh) · no measured value in reviewed sources',
    missingEvidence: ['Final plan/adoption and construction status', 'Commissioning date', 'Metered annual generation (MWh)', 'Actual land take and operating period'],
    comparisonCaveat: '48 MWp and approximately 41.5 ha are planning claims, not built capacity or energy produced; no annual-generation forecast or metered output is stated on the inspected page.',
    geometryNote: 'DiPlan identifies the proposed plan area south and east of Strausberg airfield; map it as a proposed area only, not a built footprint.',
    checkedAt,
  },
  {
    id: 'ruedersdorf-heat-plan',
    cityId: 'ruedersdorf-bei-berlin',
    signalIds: [],
    title: 'Kommunale Wärmeplanung · adopted plan and next steps',
    topic: 'heat-planning',
    outputs: [{
      id: 'ruedersdorf-heat-adoption',
      label: 'Municipal heat plan adopted',
      value: '22 July 2025',
      basis: 'reported_output',
      date: '2025-07-22',
      sourceUrl: heatRuedersdorfSource,
      locator: 'Heading “Wärmeplan beschlossen”; states Gemeindevertretung adopted plan on 22 July 2025',
    }],
    metrics: [
      { id: 'ruedersdorf-heat-suitable-areas', label: 'Heat-suitability areas identified for further investigation', value: 2, unit: 'areas', basis: 'reported_output', period: null, sourceUrl: heatRuedersdorfSource, locator: 'Section “Wärmeplan beschlossen”; Rüdersdorf centre and Wohngebiet Albrecht-Thaer in Hennickendorf' },
      { id: 'ruedersdorf-measures-commitment', label: 'Proposed measures municipality commits to implement within five years after plan publication', value: 5, unit: 'measures (at least)', basis: 'planned', period: 'five years after publication', sourceUrl: heatRuedersdorfSource, locator: 'Section “Der Weg zur Erstellung der Kommunalen Wärmeplanung”; commitment to implement at least five proposed measures' },
    ],
    benefitIndicatorMissing: 'Heat demand and emissions before/after · no measured values in reviewed sources',
    missingEvidence: ['Which measures were selected and delivered', 'Measured heat demand/fuel baseline and follow-up', 'Emissions before and after', 'Household costs or comfort outcomes'],
    comparisonCaveat: 'Adoption and a future implementation commitment are planning/governance outputs, not emissions saved, warmer homes, or completed measures.',
    geometryNote: 'The page names two neighbourhood areas; no verified boundary geometry was inspected here, so do not draw invented polygons.',
    checkedAt,
  },
  {
    id: 'strausberg-heat-plan',
    cityId: 'strausberg',
    signalIds: [],
    title: 'Kommunale Wärmeplanung · final report / decision status',
    topic: 'heat-planning',
    outputs: [{
      id: 'strausberg-heat-consultation-ended',
      label: 'Public consultation period ended',
      value: '12 April 2026',
      basis: 'reported_output',
      date: '2026-04-12',
      sourceUrl: heatStrausbergSource,
      locator: 'Opening text: participation ran from 11 March through 12 April 2026; page says final report was basis for further political deliberation and council adoption was planned for 21 May 2026',
    }],
    metrics: [],
    benefitIndicatorMissing: 'Heat demand and emissions before/after · no measured values in reviewed sources',
    missingEvidence: ['Later authoritative confirmation of council adoption/status', 'Published baseline and target values from plan', 'Measures delivered', 'Measured heat/emissions outcomes'],
    comparisonCaveat: 'Inspected city page describes the final report and planned 21 May 2026 vote, but does not confirm the vote occurred; do not compare as an adopted plan without an updated decision source.',
    geometryNote: 'No heat-planning boundary geometry was verified; show only city-level status unless authoritative areas are linked.',
    checkedAt,
  },
  {
    id: 'strausberg-investment-budget-2025-2026',
    cityId: 'strausberg',
    signalIds: ['budget:investment-outlays-2025', 'budget:investment-outlays-2026'],
    title: 'Planned investment disbursements · 2025 and 2026',
    topic: 'municipal-budget',
    outputs: [],
    metrics: [
      { id: 'budget-investment-2025', label: 'Budgeted investment disbursements', value: 17941270, unit: 'EUR', basis: 'planned', period: '2025 fiscal year', sourceUrl: budgetSource, locator: 'PDF page 1, § 1, row “Auszahlungen aus Investitionstätigkeit”, 2025 column' },
      { id: 'budget-investment-2026', label: 'Budgeted investment disbursements', value: 12609320, unit: 'EUR', basis: 'planned', period: '2026 fiscal year', sourceUrl: budgetSource, locator: 'PDF page 1, § 1, row “Auszahlungen aus Investitionstätigkeit”, 2026 column' },
    ],
    benefitIndicatorMissing: 'Actual disbursement and public-service results · no measured values in reviewed sources',
    missingEvidence: ['Actual disbursements and year-end accounts', 'Project-level allocation and delivery', 'Resulting public-service or asset outcomes'],
    comparisonCaveat: 'These are budget ordinance plans for investment disbursements, not actual spending, unrestricted cash, revenue/tax gains, or outcomes; annual plan values are not a like-for-like impact measure.',
    geometryNote: 'City-wide budget amounts have no project location; do not map them as neighbourhood expenditure.',
    checkedAt,
  },
];
