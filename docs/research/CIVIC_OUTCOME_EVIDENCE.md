# Civic outcome evidence for the four-view city story

**Original five cases checked 27 September 2026; Münster case checked 28 September 2026.** This small source-grounded sample presents the same place as built, measured, discussed, and changed. It does not assign a success score or infer impact from project status. The six typed UI-ready records are in [`src/data/civic-outcome-evidence.ts`](../../src/data/civic-outcome-evidence.ts).

## What can be shown now

| Place / signal | What the source establishes | What it does not establish |
|---|---|---|
| **Strausberg Kulturpark, phase 2** (`atlas:kulturpark`) | [City news permalink](https://www.stadt-strausberg.de/aktuelles/kulturpark-strausberg-zweiter-bauabschnitt-wird-zum-monatsende-fertiggestellt/), from the existing news feed, resolves to the stable archive anchor `Aktuelles#post-30386`; published 24 September 2026, “Kulturpark Strausberg: Zweiter Bauabschnitt wird zum Monatsende fertiggestellt”: says phase 2 is due to finish at the end of September and the sports area and bathing area are to open 3 October. It lists a mini field for football/basketball, calisthenics equipment, two table-tennis tables and a path to the lakeshore. Phase 1 is described as already having a volleyball court, playground, garden niches and barrier-free connecting paths. | At the 27 September evidence check the phase-2 opening/completion dates were still in the future: treat those as **planned**, not accomplished outputs. The city …
| **Strausberg Solarpark am Flugplatz** (`atlas:solarpark-flugplatz`) | [DiPlan procedure](https://bb.beteiligung.diplanung.de/verfahren/solarpark-flugplatz/public/detail), heading “Bebauungsplan Nr. 68/23 ‘Solarpark am Flugplatz’,” section “Planungsanlass”: approximately **41.5 ha** plan area and intended **48 MWp** nominal capacity for at least 25 years; public participation ran 24 Nov 2025–12 Jan 2026. | These are **planned** area/capacity, not an operating plant or metered output. No annual-generation estimate is stated on the inspected page. No final adoption, construction, commissioning, actual land take, or generation is confirmed there. MWp must not be displayed as MWh produced. |
| **Rüdersdorf municipal heat plan** (no exact signal ID currently mapped) | [Municipal page](https://www.ruedersdorf.de/meine-gemeinde/konzepte/kommunale-waermeplanung/), heading “Wärmeplan beschlossen”: council adoption reported **22 July 2025**. It identifies two areas for further investigation (Rüdersdorf centre; Wohngebiet Albrecht-Thaer in Hennickendorf) and says the municipality commits to implement at least five proposed measures within five years after publication. | Adoption, identified suitability areas and a future implementation commitment do not establish completed heat networks, delivered measures, lower emissions, warmer homes or household savings. The page does not quantify a baseline or measured change. The named areas are not verified boundaries in this work. |
| **Strausberg municipal heat-plan process** (no exact signal ID currently mapped) | [City page](https://www.stadt-strausberg.de/stadtentwicklung-2/kommunale-waermeplanung/), heading “Öffentlichkeitsbeteiligung abgeschlossen…”: consultation 11 Mar–12 Apr 2026, final report prepared after weighing submissions; page says committee discussion was planned for calendar week 18 and council adoption for **21 May 2026**. | The inspected page does not confirm the later vote/adoption. Treat this as the page’s reported process and planned decision, not proof of adoption or implementation. No quantified baseline, delivered measure or heat/emissions outcome appears in this page. |
| **Strausberg investment budget, 2025 vs 2026** (`budget:investment-outlays-2025`, `budget:investment-outlays-2026`) | [Household ordinance PDF](https://www.stadt-strausberg.de/wp-content/uploads/2025/04/2024-11-07_Haushaltssatzung_2025_2026.pdf), PDF page 1, §1, row “Auszahlungen aus Investitionstätigkeit”: **€17,941,270** for 2025 and **€12,609,320** for 2026. | These are planned annual investment disbursements in the ordinance, not actual spend, free/disposable municipal cash, project allocation, tax gains, jobs or delivered outcomes. The planned-year comparison is not an outcome comparison. |

The Strausberg IDs above were verified against `stadtstack-data/out/cities/strausberg/signals.geojson`; the budget IDs are `budget:investment-outlays-2025` and `budget:investment-outlays-2026`. The Rüdersdorf record uses the regional municipality slug `ruedersdorf-bei-berlin` and intentionally has no signal IDs because the inspected Strausberg feed contains no matching Rüdersdorf project signal. Strausberg heat planning likewise has no exact matching signal ID; both heat records use `signalIds: []`.

The typed record now uses `outputs[]`: each reported or planned output carries its own basis, source URL, exact locator and date (`null` when a delivery date is not established). Kulturpark's already-reported phase-one facilities and scheduled phase-two opening are separate entries from the same article; its planned two-table quantity remains a sourced metric, not a delivered count. Each case also names its missing benefit indicator on that record, with the fuller missing-evidence list retained for disclosure. Neither absence in these reviewed sources nor a source-backed physical output proves failure, no measurement elsewhere, or measured social benefit.

## 28 September 2026 · measured-project gate: Münster bus-priority trial

**Gate passed for one historical before/during observation, not a causal benefit series.** The
[Stadt Münster evaluation report](https://www.stadt-muenster.de/fileadmin/user_upload/stadt-muenster/61_verkehrsplanung/pdf/verkehrsversuche2021_endbericht.pdf),
*Endbericht zur Evaluierung der Verkehrsversuche Münster 2021*, describes about **500 m of
added bus-only lane** on an approximately 1 km trial corridor (executive summary, PDF p. 12).
The trial began **2 August 2021**, initially planned for eight weeks and then continued
(§4.1.3, PDF p. 125). Its report does not establish the current lane status or a publication date.

| Evidence | Exact report locator | Scope |
|---|---|---|
| Stadt Münster's Amt für Mobilität und Tiefbau steered the project; Fachstelle Verkehrsplanung coordinated evaluation; Ordnungsamt and Polizei Münster coordinated traffic rules. Stadtwerke Münster supplied bus GPS observations and LK Argus evaluated bus running times. | Municipal actor/coordination roles §4.1.4, PDF pp. 126–127; GPS method §4.2.1, pp. 130–131 and p. 135 footnote; named staff PDF p. 2. | Documented roles and data flow, **not** a causal funding→jobs→tax chain. |
| **€60,000** expenditure forecast for marking, signs, evaluation and communication; about **€42,000** actually spent by year-end 2021. | §4.1.3, **Kosten** paragraph, PDF p. 126, immediately before the §4.1.4 heading. | The trial continued: €42,000 is provisional, **not** final cost or a proven €18,000 saving. Funding source/appropriation are not established. |
| Mean **full-route** north/east-bound bus running time, buses traversing Ludgeriplatz → Hauptbahnhof → Eisenbahnstraße: **251 s (4:11)** in **17–30 June 2019** versus **235 s (3:55)** in **23 August–5 September 2021**; 16 s (~6.4%) lower during the trial. | GPS arrivals/dwell/departures and window choice §4.2.1, PDF pp. 130–131; complete-trip means §4.3.1, pp. 136 and 138; 16 s discussion p. 141. | Each sample covers 12 Monday–Saturday days outside summer holidays, **not 12 bus trips**; number of trips unspecified. This is bus running time, not passenger door-to-door time. |

Tables 6/7 (PDF pp. 135/137) sum separate segment means to **247→227 s**; these
aggregates are **not the complete-trip cohort** and must not replace 251→235 s or suggest
a 20-second full-route change. The periods differ by two years, spanning pandemic-era
conditions, other traffic trials and roadworks (PDF pp. 125, 169–170); no control route
isolates the bus lane's effect. The report also describes initial station-area car queues
and variable longer car journeys that eased after weeks (summary, pp. 12–13), without a
reusable numerical car effect. Do not multiply 16 s by daily ridership or monetise a
passenger-wide benefit. There is no measured current-2026 outcome or proven net gain.

The canonical Münster case intentionally has **`signalIds: []`**: no matching published
Münster CitySignal geometry was verified. The official PDF maps give route context,
but drawing an invented line/point, affected area or neighbouring signal would
misrepresent the map. Places can explore the city and inspect this report separately
without changing a person's chosen city or local home/work pins. The original five
27 September cases above still name missing benefit indicators.

## Visual use and evidence boundaries

A compact interface can show a planned-versus-reported-output badge and source date beside a capacity/area figure, a planned annual-budget comparison, and the stages of the two heat plans. On the map, distinguish a verified/project area from approximate place context and city-wide quantities. In particular, the Solarpark geometry is a proposed planning area; Rüdersdorf's two named suitability areas are not licensed as drawn boundaries by this check; municipal budget values have no project location. Dotted/scenario links can express a future proposal, while solid links should mean only that the cited source reports the relevant status—not that impact is proven.

Do not claim “successful”, emissions saved, actual tax gains, jobs created, warmer homes, visitor benefit, or energy generated unless an appropriate source measures it. Plan adoption, participation, planned capacity, construction outputs and outcomes are separate evidence states. Keep publisher measurements separate from any derived calculation; these records contain no derived impacts and no invented zeros for unknown values.

A defensible later impact assessment would need at least: final costs; comparable service measures with dates and coverage plus a control where attributing effects; for PV, commissioning and metered MWh by period; for heat planning, dated fuel/emissions baselines, follow-ups and delivered-measure records; for city budgets, actual year-end accounts linked to completed projects. Geographic claims further need authoritative boundaries and a clear observation scale. The original five cases lack corresponding outcome series; Münster has one short bus-time comparison but no control route or final cost.

## Source and reuse note

This brief states short attributed facts with direct source links and locators; it does not reproduce source PDFs, imagery, or full article text. The retrieved public pages establish the cited facts, not a blanket reuse licence. Attribute factual summaries to their publishers. The original five municipal/DiPlan sources were checked 27 September 2026; Münster's official report was checked 28 September 2026.
