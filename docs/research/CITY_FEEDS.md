# Pilot-city morning feeds (checked 2026-09-27)

Polite GET requests used `User-Agent: LedgerOfLifeResearch/1.0`, 12-second timeout and small response reads. A page returning 200 is **not** a feed. Counts/newest-item dates are reported only when visible in the fetched response; HTML listing pages are not asserted to be complete or machine-readable. For RSS/Atom/iCal discovery, checked the official index/pages and links surfaced there; no feed URL is invented. Terms/licences are source-specific; an accessible page does not grant republication rights.

## Strausberg

| Feed/type | URL and observed response | Rights / assessment |
|---|---|---|
| Official events listing (HTML) | [Stadt Strausberg events](https://www.stadt-strausberg.de/veranstaltungen/): GET 200, `text/html`, page mentions events dated 2026-08-14–16; item count/newest complete listing cannot be determined from bounded HTML response. No RSS/iCal URL confirmed on this probe. | No open reuse license established on listing; link out with attribution, obtain terms. |
| News listing (HTML) | [Aktuelles](https://www.stadt-strausberg.de/aktuelles/): search result identifies official archive, but this URL was not separately fetched; no feed URL confirmed. | Not verified. |
| Transit | [VBB GTFS-RT](https://production.gtfsrt.vbb.de/data): GET 200, `application/protobuf`, valid-looking protobuf response (first 5,000 bytes); no item count/newest item extracted because protobuf was not decoded. Potential regional transit source for Strausberg; feed/license/terms need confirmation at [VBB](https://www.vbb.de/). | Feed is technically live, but not confirmed as disruption-only; decode GTFS-RT entities and check terms before use. |
| Nostr | Search tried official city domain + Nostr; no evidence of city/civic-project publishing found. CCF's publisher is planned, not proof this city uses Nostr ([CCF](https://github.com/komma-systems/ccf)). | No feed endpoint to probe. |

## Köln

| Feed/type | URL and observed response | Rights / assessment |
|---|---|---|
| RSS discovery | [koeln.de feeds page](https://www.koeln.de/feeds/): GET 200, `text/html`, 1,885 bytes; page errored (“interner Datenfehler”) in search result; no verified RSS endpoint/item count/date. [instructions](https://www.koeln.de/feeds/einbauanleitung) describe configurable feeds, but endpoint requires selecting a channel and was not established. | koeln.de is city portal, not necessarily Stadt Köln official communications; check channel terms. |
| Events | [koeln.de events](https://www.koeln.de/events/): site advertises iCalendar / Outlook / `.ics` export; HTML page itself not fetched in this probe, so no HTTP/item/date claims for an ICS URL. No concrete ICS URL listed because export is generated per selection. | Export terms need review; do not assume open data. |
| Transit | [KVB open data](https://www.kvb.koeln/service/open_data.html): GET 200, HTML; no real-time disruption feed URL/count/date extracted. Search found [VRS real-time GTFS-RT OpenService](https://open.nrw/dataset/ist-daten-bus-und-bahn-opnv-realtime-bn), but access requires usage agreement; endpoint not independently probed. | Obtain agreement and technical endpoint; KVB page primarily documents open-data offerings. |
| Nostr | Search found no evidence of a Köln city/civic Nostr publisher; [CCF planned Nostr publisher](https://github.com/komma-systems/ccf) is roadmap context only. | None found. |

## Münster

| Feed/type | URL and observed response | Rights / assessment |
|---|---|---|
| Press/news | [City press service](https://www.stadt-muenster.de/aktuelles/fuer-die-medien): GET 200, `text/html`, redirected from older media URL; official page says press releases accessible to interested parties, but feed URL/item count/newest date not identified. | No feed licence established; inspect page terms before republication. |
| Events | [City events calendar](https://www.stadt-muenster.de/veranstaltungskalender): GET 200, `text/html`; no ICS/RSS endpoint or item/date count extracted. | Link to source until calendar export/terms verified. |
| Transit | [Stadtwerke Busradar API](https://api.busradar.conterra.de/): GET 200, HTML API-doc/demo landing page; [Open Data Münster dataset](https://opendata.stadt-muenster.de/dataset/%C3%B6pnv-busradar-bus-live-positionsdaten.xml) documents bus positions and GTFS-RT availability, but feed endpoint itself not probed/decoded. | Dataset/API terms apply; confirm update/service agreement. Candidate live bus status, not necessarily planned disruption alerts. |
| Nostr | Search of city/civic project results found no confirmed publisher. [CCF](https://github.com/komma-systems/ccf) Nostr output is planned only. | None found. |

## Wuppertal

| Feed/type | URL and observed response | Rights / assessment |
|---|---|---|
| City news | [Aktuelle Meldungen](https://www.wuppertal.de/presse/aktuelle-meldungen.php): GET 200, `text/html`, 92,965 bytes; current dated headlines present, but exact item count/newest date not extracted and no RSS endpoint established. | No reuse license confirmed. |
| Events | City [events search/listing](https://www.wuppertal.de/): official homepage was not separately probed for a calendar export; no ICS/RSS endpoint confirmed. | Not verified. |
| Transit | [WSW mobil](https://www.wsw-online.de/wsw-mobil/): no documented GTFS-RT disruption endpoint surfaced in searches; no endpoint was listed/probed. | Not found: searched WSW and GTFS-RT/disruption API documentation. |
| Nostr | No city/civic Nostr publishing evidence found in search; CCF Nostr publisher is planned ([CCF](https://github.com/komma-systems/ccf)). | None found. |

## Castrop-Rauxel

| Feed/type | URL and observed response | Rights / assessment |
|---|---|---|
| City news | [News](https://www.castrop-rauxel.de/news): GET 200, `text/html`, 120,000 bytes read; page shows current news, but count/newest date not extracted and no RSS endpoint confirmed. | No open content license established. |
| Events | Official events/calendar feed URL not located; [city site](https://www.castrop-rauxel.de/) is the starting point, not a tested feed. | Not found: searched city domain for calendar/RSS/iCal/event feed. |
| Transit | Local operator [DSW21](https://www.bus-und-bahn.de/) / VRR serve area; no documented open GTFS-RT disruption endpoint confirmed in this research. | Not found: searched local transit and GTFS-RT/open-data documentation; no feed listed. |
| Nostr | No evidence found for city/civic Nostr publisher; see [CCF](https://github.com/komma-systems/ccf) planned feature only. | None found. |

## Düsseldorf

| Feed/type | URL and observed response | Rights / assessment |
|---|---|---|
| City news | [Düsseldorf news](https://www.duesseldorf.de/aktuelles/news): GET 200, `text/html`, 86,230 bytes; listing page, item count/newest date not extracted; no RSS URL confirmed. | City site content terms not checked; do not republish full text by default. |
| Events | [Düsseldorf events](https://www.duesseldorf.de/): official site starting point; no concrete iCal/RSS export URL confirmed/probed. | Not found in this pass. |
| Transit | Rheinbahn/VRS regional offerings: [VRS GTFS-RT OpenService dataset](https://open.nrw/dataset/ist-daten-bus-und-bahn-opnv-realtime-bn) requires a usage agreement; direct endpoint not tested. | Potential candidate with access conditions, not anonymous open feed confirmed. |
| Nostr | Search found no verified city/civic Nostr source; [CCF](https://github.com/komma-systems/ccf) feature planned only. | None found. |

## Dresden

| Feed/type | URL and observed response | Rights / assessment |
|---|---|---|
| Press releases | [City press releases](https://www.dresden.de/de/rathaus/aktuelles/pressemitteilungen.php): GET 200, redirected to [search results](https://www.dresden.de/suche/pressemitteilungen.itl), HTML; item count/newest date not extracted, no RSS endpoint confirmed. | Check Dresden reuse/press terms. |
| Events | City events/calendar machine-readable endpoint not found in this pass; [Dresden city site](https://www.dresden.de/) searched. | Not found: searched city events and iCal/RSS. |
| Transit | DVB real-time information: search located a SIRI-ET feed via [Mobilithek](https://mobilithek.info/), including DVB/regional operators, but exact dataset URL and terms were not pinned/probed. No item count/date available. | Candidate only; obtain dataset identifier, access terms, decode and test freshness before integration. |
| Nostr | No city/civic Nostr publisher confirmed by search; CCF's Nostr publisher is planned ([CCF](https://github.com/komma-systems/ccf)). | None found. |

## Freiburg im Breisgau

| Feed/type | URL and observed response | Rights / assessment |
|---|---|---|
| Press releases | [Freiburg press releases](https://www.freiburg.de/pressemitteilungen/index.html): GET 200, `text/html`, 1,479 bytes; HTML response extremely small (likely dynamic/blocked shell), no count/newest item or feed URL established. | City press terms/reuse not established. |
| Events | [City events calendar](https://www.freiburg.de/): no concrete RSS/iCal feed URL found/probed. | Not found: searched city site for calendar export. |
| Transit | [VAG Freiburg GTFS downloads](https://www.vag-freiburg.de/service-infos/downloads/gtfs-daten): GET 200, HTML; documents static GTFS and attribution requirement (“Datensatz der VAG Freiburg”), but no GTFS-RT endpoint found/probed. | Static schedule is not disruption feed. VAG attribution required per page. |
| Nostr | No city/civic-project Nostr publishing evidence found in search; CCF publisher remains planned ([CCF](https://github.com/komma-systems/ccf)). | None found. |

## Cross-city summary

- **Reliably machine-readable in this probe:** VBB Strausberg GTFS-RT returned HTTP 200 protobuf, but entity count/freshness and terms still need decoder + license check. Münster has a documented Busradar/GTFS-RT offering, but its actual feed endpoint was not retrieved. VRS real-time feeds are documented as agreement-based, not frictionless open feeds.
- **News/event sources:** official HTML pages are available for several cities, but this pass did **not** establish verified RSS/Atom or direct `.ics` URLs for them. Köln advertises configurable RSS and calendar export, but the RSS index returned an error page and the export requires channel/event selection. Avoid scraping until checking robots/terms and stable selectors.
- **Freshness/count evidence:** no item counts or newest-entry dates are claimed for HTML pages where the inspected bounded response did not yield a reliable complete listing. Most city pages returned 200; Freiburg's response was only 1,479 bytes and likely not a usable listing. This is a research gap, not evidence that no feed exists.
- **Nostr:** no confirmed Nostr city or civic publisher identified for the eight pilots. Search was for city/civic project Nostr feeds; CCF's planned publisher is not an operational city feed. Public relay presence alone would not establish city authorship or trust.
- **Suggested next step:** source registry entries should distinguish `official_feed`, `official_html`, `regional_transit`, rights/terms and last-success time; do not present third-party local news as official. Request explicit dataset/API details from transit operators where docs describe access agreements.
