# Roadmap data sources: Strausberg

**Checked 26 September 2026.** Live endpoints below were queried read-only. A failed query is not evidence that the dataset does not exist. `read_only_live` means a live response was observed, not an endorsement of completeness or production suitability.

| Roadmap item | Source and observed reach | Reality |
|---|---|---|
| City budget | [Strausberg Amtsblatt 2024](https://www.stadt-strausberg.de/wp-content/uploads/2024/11/2024-Amtsblatt_07.pdf): ordinance notice, detailed plan by inspection; no plan totals from this notice. See [legal/access analysis](CITY_BUDGET_DATA_STRAUSBERG_BRANDENBURG.md#legal-obligations-and-where-the-plan-actually-is). | illustration |
| Where the money goes | Full city plan/line-item schedule was not found online. Regionalstatistik table 71231-01-03-5 is the candidate for tax revenue, not expenditure detail. | not available |
| Measurable city | sensor.community live area response and Bright Sky weather endpoint both responded (details below). | read_only_live |
| Council decisions | [Strausberg RIS](https://www.ratsinfo-online.de/strausberg-bi) is available via browser; guessed `/oparl` path returned HTTP 404. No API/feed verified. | illustration |
| Welcome to your new city (clubs) | OSM query attempted at Overpass public API and alternate instance; first returned HTTP 406, alternate timed out. No item count/samples verified. | not available |
| Invest in your own city (cooperatives) | Candidate providers require project/member-specific confirmation; no live evidence in this research establishes open membership or available shares. | not available |
| Real-time service charges (meters) | No public Strausberg household meter endpoint identified; private utility-meter data requires resident authorization/utility integration. | not available |

## 1. OpenStreetMap clubs and facilities

Requested query: Overpass QL against an area selected by `name=Strausberg` and `admin_level=8`, returning named `club=*` objects plus `leisure=sports_centre|pitch|fitness_centre` objects. Endpoint attempted: `https://overpass-api.de/api/interpreter` with JSON output. It returned HTTP 406 HTML (“Not Acceptable”). Retried `https://overpass.kumi.systems/api/interpreter` with a client User-Agent; it timed out after 30 seconds without a body. Consequently **no count, examples, or boundary match was verified**; do not substitute guessed entities. Overpass documentation/API: https://wiki.openstreetmap.org/wiki/Overpass_API . OSM data is under ODbL 1.0: https://www.openstreetmap.org/copyright . A working query can use an explicitly checked boundary relation and preserve OSM attribution.

## 2. Sensors and weather

### sensor.community

Live GET: `https://data.sensor.community/airrohr/v1/filter/area=52.58,13.88,5` (JSON). It returned a JSON array of sensor measurements. The returned body was truncated in tool display, so a defensible total/count of sensors is **not available**. Two visible records:

- sensor record `30833359588`, sensor SDS011, location `52.538, 13.82`, timestamp `2026-09-26 15:00:53`; P1 and P2 both `0.20` (units as represented in API payload).
- sensor record `30833355455`, location record `86430`; temperature `23.23`, pressure `101586.44`, humidity `46.41` in the returned `sensordatavalues` (API-provided values; confirm field conventions before display).

Endpoint/API information: https://github.com/opendata-stuttgart/meta . This live response establishes nearby returned sensors, not that their locations lie inside Strausberg city limits or that measurements are calibrated. Project data is offered under CC BY-SA 4.0 per its project information; confirm attribution/terms for the current service before reuse: https://sensor.community/en/ .

### DWD via Bright Sky

Live GET: `https://api.brightsky.dev/current_weather?lat=52.58&lon=13.88` returned JSON with `weather` (station/source id 362528), timestamp `2026-09-26T14:30:00+00:00`, temperature 21.0 °C, condition `dry`, humidity 42%, cloud cover 88%, and wind speed (60-minute) 6.1 m/s. This is a point query with a station-backed/fallback response, not an official city observation. Bright Sky API/docs: https://brightsky.dev/docs/ ; project states data use follows DWD terms and its own attribution guidance: https://brightsky.dev/ . DWD data terms: https://www.dwd.de/EN/service/copyright/copyright_node.html .

## 3. Regionalstatistik / GENESIS and AGS

Strausberg's official municipal site identifies the city and district but the table-specific AGS lookup was not completed from an official statistical municipality directory in this run. **AGS not independently verified here; do not submit an assumed code.** Candidate API endpoint is Regionalstatistik GENESIS web service, documentation/access: https://www.regionalstatistik.de/genesis/online?operation=statistic&code=71231 and https://www.regionalstatistik.de/genesis/online?Menu=Webservice . Table `71231-01-03-5` is indexed as Realsteuervergleich; the question of unauthenticated API access and retrieval for Strausberg was **not confirmed by a successful API response**. Table browser: https://www.regionalstatistik.de/genesis/online?language=de&sequenz=statistikTabellen&selectionname=71231 .

Regionalstatistik's site describes use under **Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0)** on its terms/licence information: https://www.regionalstatistik.de/genesis/online?operation=statistic&code=71231 (licence statement should be checked against the exact export/metadata before production attribution). No extracted Strausberg values are reported.

## 4. Council decisions, feeds and CCF

RIS landing page: https://www.ratsinfo-online.de/strausberg-bi . A direct HEAD request to `https://www.ratsinfo-online.de/strausberg-bi/oparl` returned HTTP 404. Common feeds `/rss`, `/feed`, `/ical`, `/calendar`, `/oparl/v1.0` were not successfully queried, so RSS/iCal absence is **not verified**. The RIS likely uses a dynamic interface; no machine-readable API response or sample decision object obtained. CCF registry: https://github.com/komma-systems/ccf/blob/main/jurisdictions/de/registry.yaml ; Strausberg membership was not independently verified from the registry during this run. Decision BV-SVV-2024/0046 is referenced in the city's official notice; attachment retrieval remains unverified (see budget file).

## 5. Cooperative / local investment candidates

No source query in this research verified current share availability or new-member acceptance, so the app must not imply that a user can invest. Starting points to investigate directly (candidate directories, not evidence of open offers):

- [Wohnungsbaugenossenschaft Aufbau Strausberg eG](https://www.wbg-aufbau.de/) — local housing cooperative; current admission/share offers **not verified**.
- [Energiegenossenschaft Märkisch-Oderland](https://www.eg-mol.de/) — regional citizen-energy lead; current membership/investment terms **not verified**.
- Community wind/solar projects near Strausberg: no specific operating project with documented public share offer verified in this run. Treat as not available for an invest-now flow pending direct provider confirmation and prospectus review.

## 6. Marktstammdatenregister / solar

The Bundesnetzagentur's Marktstammdatenregister public portal is https://www.marktstammdatenregister.de/MaStR . It supports public register search/download, but a Strausberg-filtered count or sample export was not obtained in this research; installed capacity/number therefore **not available**. Registry service information: https://www.marktstammdatenregister.de/MaStRHilfe . Data is subject to register reuse terms; no API endpoint or open-data licence was verified here. Do not scrape the interactive portal as a substitute for a documented, permitted export.

## 7. City services and newcomer information

City starting point: https://www.stadt-strausberg.de/ . The city site and [associations/volunteer landing search](https://www.stadt-strausberg.de/?s=Vereinsverzeichnis) were not verified to expose a maintained, complete Vereinsverzeichnis or machine-readable feed. Events/calendar URL and RSS/iCal feed were not confirmed. These are **not available as verified structured sources** in this pass; use city contact/official web pages rather than inventing completeness.

## Practical boundary

The live evidence supports weather and nearby sensor tiles, with timestamps and provenance. Budget line items, current council decisions via API, verified club listings, current cooperative offerings, and resident meter readings need additional access/permission or direct source validation. Keep each displayed value attached to source URL, observation time, licence and geographic/measurement caveats.
