# Roadmap data sources: Strausberg

**Checked 26 September 2026.** Live endpoints below were queried read-only. A failed query is not evidence that the dataset does not exist. `read_only_live` means a live response was observed, not an endorsement of completeness or production suitability.

| Roadmap item | Source and observed reach | Reality |
|---|---|---|
| City budget | [Strausberg Amtsblatt 2024](https://www.stadt-strausberg.de/wp-content/uploads/2024/11/2024-Amtsblatt_07.pdf): ordinance notice, detailed plan by inspection; no plan totals from this notice. See [legal/access analysis](CITY_BUDGET_DATA_STRAUSBERG_BRANDENBURG.md#legal-obligations-and-where-the-plan-actually-is). | illustration |
| Where the money goes | Full city plan/line-item schedule was not found online. Regionalstatistik table 71231-01-03-5 is the candidate for tax revenue, not expenditure detail. | not available |
| Measurable city | sensor.community returned 8 readings from 5 distinct sensors; 4 returned readings are within an approximate 5 km radius. Bright Sky weather query also returned live weather (details below). | read_only_live |
| Council decisions | The old RIS redirects to ALLRIS at [Strausberg public portal](https://strausberg.allris.cloud/public/reset), with [public documents](https://strausberg.allris.cloud/public/dooeff) and [calendar](https://strausberg.allris.cloud/public/si010). No working public OParl system endpoint was confirmed by the checks below; these are link cards, not a meeting feed. | illustration |
| Welcome to your new city (clubs) | Overpass returned 29 OSM objects in the queried boundary; city Vereine/Sport pages and KSB-MOL member list are live sources (details below). | read_only_live |
| Invest in your own city (cooperatives) | Candidate providers require project/member-specific confirmation; no live evidence in this research establishes open membership or available shares. | not available |
| Real-time service charges (meters) | No public Strausberg household meter endpoint identified; private utility-meter data requires resident authorization/utility integration. | not available |

## 1. OpenStreetMap clubs and facilities

POST query to `https://overpass-api.de/api/interpreter` using a descriptive User-Agent and area selector `area["name"="Strausberg"]["boundary"="administrative"]["admin_level"="8"]` returned 29 objects: 11 nodes and 18 ways. The response included 5 named samples: Ewaldhof GbR - Jürgen & Kirsten Ewald (node 1361867450, sport=equestrian), Baggerteiche im Fasanenpark Strausberg (node 1414755949), FC Strausberg (node 5300513757, club=sport), Clever Fit (node 6025376571, leisure=fitness_centre), and Krafttankstelle (node 10894513598). The results can include other club types/sports (the query includes all `club=*` and named `sport=*` features); they are OSM contributions, not a vetted official directory. OSM data is under ODbL 1.0: https://www.openstreetmap.org/copyright . Query output was JSON. Overpass documentation: https://wiki.openstreetmap.org/wiki/Overpass_API .

On 26 September the default `overpass-api.de` sometimes returned HTTP 504 (busy dispatcher); a read-only POST to its documented `gall.openstreetmap.de` backend returned 29 named objects for the Places query. The app tries public mirrors with a per-instance timeout and a 24-hour last-good city cache; a mirror outage is not interpreted as an empty club directory.

## 2. Sensors and weather

### sensor.community

Live GET: `https://data.sensor.community/airrohr/v1/filter/area=52.58,13.88,5` (JSON). A repeat response contained 8 measurement objects representing 5 distinct `sensor.id` values; 4 objects (approximately 4 sensor locations) fell within 5 km of center 52.579, 13.887, using an equirectangular approximation of 111 km/degree latitude and 67 km/degree longitude. Two examples from the response: sensor id 44842 at 52.538, 13.82 (SDS011), timestamp `2026-09-26 15:08:11`; sensor id 78186 at 52.5819657, 13.8911656, timestamp `2026-09-26 15:07:35`. Counts are response-time dependent and may include multiple measurements per sensor.


Endpoint/API information: https://github.com/opendata-stuttgart/meta . This live response establishes nearby returned sensors, not that their locations lie inside Strausberg city limits or that measurements are calibrated. Project data is offered under CC BY-SA 4.0 per its project information; confirm attribution/terms for the current service before reuse: https://sensor.community/en/ .

### DWD via Bright Sky

Live GET: `https://api.brightsky.dev/current_weather?lat=52.58&lon=13.88` returned JSON with `weather` (station/source id 362528), timestamp `2026-09-26T14:30:00+00:00`, temperature 21.0 °C, condition `dry`, humidity 42%, cloud cover 88%, and wind speed (60-minute) 6.1 m/s. This is a point query with a station-backed/fallback response, not an official city observation. Bright Sky API/docs: https://brightsky.dev/docs/ ; project states data use follows DWD terms and its own attribution guidance: https://brightsky.dev/ . DWD data terms: https://www.dwd.de/EN/service/copyright/copyright_node.html .

## 3. Regionalstatistik / GENESIS and AGS

Official Destatis GV-ISys entry point: https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/_inhalt.html . Amt für Statistik Berlin-Brandenburg's official regional directory: https://statistik-berlin-brandenburg.de/regionales/gemeindeverzeichnis.asp?Kat=7121 . Strausberg's official AGS is **12064472**; its 12-digit ARS is **120640472472** (the latter also appears in an official Berlin-Brandenburg statistics publication: https://www.statistik-berlin-brandenburg.de/zensus/gdb/bev/bb/12/12064/120640472472_Strausberg_Stadt_bev.pdf). Guest GET to `.../genesisws/rest/2020/data/tablefile?...` returned HTTP 405; POST with GAST/GAST and table parameters returned HTTP 401 JSON Code 15 (“not authorized” / credentials or required headers not recognized). Thus no table data or Strausberg tax amounts/reference year were returned without credentials. API documentation: https://www.regionalstatistik.de/genesis/online?Menu=Webservice ; table browser: https://www.regionalstatistik.de/genesis/online?language=de&sequenz=statistikTabellen&selectionname=71231 .

Regionalstatistik presents **Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0)** for its data, but no export-specific metadata could be retrieved in the failed API calls; check the exact downloaded table metadata before production reuse. Licence information: https://www.regionalstatistik.de/genesis/online?operation=statistic&code=71231 .

## 4. Council decisions, feeds and CCF

The old [RIS URL](https://www.ratsinfo-online.de/strausberg-bi) serves a “page moved” notice pointing to [ALLRIS public portal](https://strausberg.allris.cloud/public/reset). The current portal links to [public documents](https://strausberg.allris.cloud/public/dooeff) and [meeting calendar](https://strausberg.allris.cloud/public/si010); `si010` is the calendar, **not** document search. On 26 September 2026, GET `/oparl/` and `/api/oparl` returned HTTP 404; `/public/oparl/system` returned HTTP 500, not an OParl 1.x JSON `system` object. No working public OParl endpoint was confirmed by these probes; a failed guessed route does not prove that ALLRIS offers no feed elsewhere. The portal offers mailto calendar sharing, but no RSS/iCal URL was found in its landing-page HTML. Search for decision BV-SVV-2024/0046 / 7 November 2024 did not retrieve a public record or Haushaltsplan attachment. The CCF registry raw file, https://raw.githubusercontent.com/komma-systems/ccf/main/jurisdictions/de/registry.yaml, contains **zero occurrences of “Strausberg”**. Registry absence means no listing in that file, not proof the RIS lacks a private API.

## 5. Cooperative / local investment candidates

No source query in this research verified current share availability or new-member acceptance, so the app must not imply that a user can invest. Starting points to investigate directly (candidate directories, not evidence of open offers):

- [Wohnungsbaugenossenschaft Aufbau Strausberg eG](https://www.wbg-aufbau.de/) — local housing cooperative; current admission/share offers **not verified**.
- [Energiegenossenschaft Märkisch-Oderland](https://www.eg-mol.de/) — regional citizen-energy lead; current membership/investment terms **not verified**.
- Community wind/solar projects near Strausberg: no specific operating project with documented public share offer verified in this run. Treat as not available for an invest-now flow pending direct provider confirmation and prospectus review.

## 6. Marktstammdatenregister / solar

The Bundesnetzagentur's Marktstammdatenregister public portal is https://www.marktstammdatenregister.de/MaStR . It supports public register search/download, but a Strausberg-filtered count or sample export was not obtained in this research; installed capacity/number therefore **not available**. Registry service information: https://www.marktstammdatenregister.de/MaStRHilfe . Data is subject to register reuse terms; no API endpoint or open-data licence was verified here. Do not scrape the interactive portal as a substitute for a documented, permitted export.

## 7. City services and newcomer information

Strausberg has live public [Vereine](https://www.stadt-strausberg.de/vereine/) and [Sport](https://www.stadt-strausberg.de/sport-2/) pages. The city search HTML exposes these pages, plus an [events calendar](https://www.stadt-strausberg.de/veranstaltungen/) and WordPress search RSS (`https://www.stadt-strausberg.de/search/Vereine/feed/rss2/`). These are web pages/feed links; completeness and a machine-readable structured directory were not established. Kreissportbund Märkisch-Oderland provides a live [Vereinsliste](https://www.ksb-mol.de/vereinsliste/); it is a district sports-club list, not limited to Strausberg. Its live HTML was fetched, but no count of Strausberg-based entries was derived.

## Practical boundary

The live evidence supports nearby sensor/weather tiles and club discovery pages, with source and time caveats. The budget line-item schedule, guest access to GENESIS tax values, the specific council attachment/feed, and current cooperative offers remain unavailable through the queries completed. Resident meter readings still require authorized utility integration.
