# Pilot-city morning feeds (targeted discovery, 2026-09-27)

Requests used `User-Agent: LedgerOfLifeResearch/1.0`, small bounded reads (up to 2 MB), and 8–20 second timeouts. News/events HTML was fetched and parsed for `<link rel="alternate">` of RSS/Atom/calendar types and anchors mentioning RSS/feed/Atom/iCal/ICS/calendar subscription. Discovered links and common WordPress/Events Calendar patterns were probed. Feed counts/titles/dates below come from parsed response bodies; RSS “newest” is maximum parsed publication timestamp, ICS “newest” is maximum DTSTART. Dates are the content timestamp, not necessarily retrieval time. No feed licence is inferred from HTTP access.

## Working feed inventory

| City | URL / status / format | Count; newest item; first two titles | Rights / terms |
|---|---|---|---|
| Strausberg — news | [official WordPress news RSS](https://www.stadt-strausberg.de/aktuelles/feed/), GET 200, `application/rss+xml; charset=UTF-8` | 10; 2026-09-24 12:15 UTC; “Strausberger Altstadtfest am 3. Oktober: Ein Tag voller Kultur und Gemeinschaft”; “Kulturpark Strausberg: Zweiter Bauabschnitt wird zum Monatsende fertiggestellt” | No explicit feed license found on page; link/attribute, avoid reproducing full article absent permission. |
| Strausberg — events | [official events RSS](https://www.stadt-strausberg.de/veranstaltungen/feed/), GET 200, `application/rss+xml; charset=UTF-8` | 10; 2026-09-23 10:23 UTC; “Der Seniorenbeirat Bärbel Gesell berichtet über Ziele und Ergebnisse der Arbeit des Seniorenbeirates”; “Ein Vortrag von und mit Gerd-Ulrich Herrmann Thema: „Siedlungsgeschichte einer märkischen Stadt – Vom Wachsen der Stadt“” | No explicit feed license found. |
| Köln — events | [koeln.de events ICS](https://www.koeln.de/events/?ical=1), GET 200, `text/calendar; charset=UTF-8` | 30 VEVENTs; max DTSTART 2026-09-27 14:00 local (`Die Königs vom Kiez`); first two feed entries: “Porzer Weinfest”, “Dellbrücker Festmeile” (DTSTART 2025-03-30 and 2025-10-26 respectively; calendar contains past/recurrent entries as well as future). | Calendar is koeln.de, not necessarily Stadt Köln government; no reuse license stated on feed. Filter by DTSTART/DTEND and link through. |
| Münster — press | [Presse-Service RSS, publisher parameter 77](https://www.presse-service.de/rss.aspx?p=77), GET 200, `text/xml` | 21; max publication date 2026-09-25 11:00 GMT; “Friedenspreis-Verleihung: Rathaus gesperrt, Stadthaus geöffnet - Sicherheitsmaßnahmen am 1. Oktober / Zugang zu Geschäften am Prinzipalmarkt möglich”; “Haushaltskrise: Stadt spart beim Personal” | Official [Münster press page](https://www.stadt-muenster.de/aktuelles/fuer-die-medien) links this press service. Feed contains copyright notice; no open licence stated. Use links/headlines, not full text without permission. |
| Wuppertal — news | [official press RSS](https://www.wuppertal.de/presse/aktuelle-meldungen.php?sp%3Aout=rss), GET 200, `application/rss+xml; charset=utf-8` | 30; max publication date 2026-09-25 15:26 +0200; “Kontrollaktion des Städtenetzwerks der Gemeinsamen Koordinierungsstelle Rhein-Wupper”; “Denkmalgerecht saniert: Jakobstreppe offiziell eröffnet” | RSS contains copyright metadata; no open licence identified. Attribute/link, avoid republishing article body absent terms. |
| Dresden — press | [official press RSS](https://www.dresden.de/konfiguration/rss/rss-feed-pressemitteilungen.rss), GET 200, `application/x-rss+xml` | 118; RSS order begins 2026-09-25; max parsed publication date is 2026-09-25 00:00 +0200; first two titles: “Stadtrat beschließt städtischen Wärmeplan”; “Neustadt: Verkehrseinschränkungen auf der Königsbrücker Straße ab 28. September” | RSS contains copyright metadata, no open licence identified; use attribution and source links, check city press terms before republishing text. |

## Venue and date enrichment · 28 September 2026

The current Strausberg publication joins event RSS records to the city's
[October calendar](https://www.stadt-strausberg.de/veranstaltungen/2026-10-01/oktober-2026/)
using publisher post ID and title. Event time and venue remain nullable; publication time
is never substituted. `publisherRecordId`, venue, point/precision and location provenance
now travel through `stadtstack-feed-v1` and the app's event detail.

Record **30366**, “Kürbisfest”, is **30 October 2026, 15:00 Europe/Berlin**
(`2026-10-30T14:00:00Z`), in front of Marienkirche, Predigerstr. 2.
Its point `[13.8804803, 52.5801295]` is the **approximate church footprint centre** from
[OSM way 38496130](https://www.openstreetmap.org/way/38496130), not an exact event standing point.
The separate record **30334**, “2. Strausberger Kürbisfest”, has a different time and is not
merged with this record or automatically given its geometry.

The published feed was regenerated and the actual browser selected this venue on the
existing 3D map. Other event cards retain sourced dates/venue text where available and
stay unlocated when no coordinate source is established.

## Per-city discovery and non-feed findings

### Strausberg

| Surface | Probe / result |
|---|---|
| News HTML | [Aktuelles](https://www.stadt-strausberg.de/aktuelles/) GET 200 HTML; extracted alternate `https://www.stadt-strausberg.de/aktuelles/feed/`, now verified above. |
| Events HTML | [Veranstaltungen](https://www.stadt-strausberg.de/veranstaltungen/) GET 200 HTML; alternate `https://www.stadt-strausberg.de/veranstaltungen/feed/`, verified above. |
| Standard paths tested | `/feed/` returned 200 RSS but 0 items; `/search/Vereine/feed/rss2/` returned 200 RSS, 10 items (community search-specific, not city-news feed); `/category/aktuelles/feed/` and `/veranstaltungen/liste/?ical=1` returned 404; `/veranstaltungen/?ical=1` returned HTML (200), not a calendar; `/events/?ical=1` returned 404. |
| Transit | [VBB GTFS-RT](https://production.gtfsrt.vbb.de/data) decoded from live protobuf, GET 200 `application/protobuf`; 6,485 `trip_update`, 0 `vehicle`, 0 `alert` entities; feed header timestamp 2026-09-27 (Unix 1790499108). There are no alert entities, so no sample alert can honestly be given. This snapshot cannot itself provide disruption alerts; trip updates may expose delay data. VBB’s [feed page](https://production.gtfsrt.vbb.de/) states CC BY 4.0 and unauthenticated limit 60 requests/minute; it recommends its Atom status feed. Attribution required. |
| Nostr | No confirmed city/civic publisher found. Search was city/civic Nostr; CCF’s publisher is planned, not operational ([CCF](https://github.com/komma-systems/ccf)). |

### Köln

| Surface | Probe / result |
|---|---|
| News HTML | Official [Stadt Köln press page](https://www.stadt-koeln.de/politik-und-verwaltung/presse/pressemitteilungen) guessed from city navigation returned 404. [koeln.de feeds overview](https://www.koeln.de/feeds/) returned 200 HTML (1,885 bytes), but reported internal data error and exposed no usable RSS URL. No verified official-city press RSS in this pass. |
| Events HTML | [koeln.de events](https://www.koeln.de/events/) GET 200, alternate `text/calendar` points to working ICS above. Page anchors exposed `/events/liste/?ical=1` and Outlook export; these aliases also returned the same 30-event ICS. Google/Outlook subscription helper URLs are not feeds. |
| Open-data discovery | Tried [offenedaten-koeln.de](https://offenedaten-koeln.de/) and CKAN `api/3/action/package_search?q=event`; TLS handshake timed out on both. Thus event-data availability not established, not a “no datasets” conclusion. |
| Transit | [KVB open-data page](https://www.kvb.koeln/service/open_data.html) GET 200 HTML; no disruption feed extracted. VRS describes agreement-based real-time GTFS-RT at [Open.NRW](https://open.nrw/dataset/ist-daten-bus-und-bahn-opnv-realtime-bn); no endpoint was retrieved. |
| Nostr | No confirmed city/civic publisher found; CCF planned feature only. |

### Münster

| Surface | Probe / result |
|---|---|
| News HTML | [City press service](https://www.stadt-muenster.de/aktuelles/fuer-die-medien) GET 200 HTML; anchor points to working [Presse-Service RSS](https://www.presse-service.de/rss.aspx?p=77), detailed above. |
| Events HTML | [City events calendar](https://www.stadt-muenster.de/veranstaltungskalender) GET 200 HTML; no alternate/link containing RSS/feed/Atom/iCal/ICS/calendar subscription found. |
| Common pattern | `https://www.stadt-muenster.de/aktuelles/fuer-die-medien/feed/` returned 404; `/feed/` was not promoted as an official endpoint. |
| Open data | Tried [Münster Open Data](https://opendata.stadt-muenster.de/) and CKAN `api/3/action/package_search?q=veranstaltung`; TLS handshake timed out. Events dataset/feed not established. Existing [Busradar dataset](https://opendata.stadt-muenster.de/dataset/%C3%B6pnv-busradar-bus-live-positionsdaten.xml) documents live bus positions/GTFS-RT; actual realtime endpoint was not decoded here. |
| Nostr | No confirmed city/civic publisher found; CCF planned feature only. |

### Wuppertal

| Surface | Probe / result |
|---|---|
| News HTML | [Aktuelle Meldungen](https://www.wuppertal.de/presse/aktuelle-meldungen.php) GET 200 HTML; anchor `?sp%3Aout=rss` resolves to working 30-item RSS above. |
| Events HTML | Tried [Wuppertal events path](https://www.wuppertal.de/veranstaltungen/), GET 403. No alternate or RSS/iCal link extractable from that blocked response; this is not proof none exists. |
| Transit | No documented WSW GTFS-RT disruption endpoint confirmed; operator entry point [WSW mobil](https://www.wsw-online.de/wsw-mobil/). |
| Nostr | No confirmed city/civic publisher found; CCF planned feature only. |

### Castrop-Rauxel

| Surface | Probe / result |
|---|---|
| News HTML | [News](https://www.castrop-rauxel.de/news) GET 200 HTML; no alternate feed link or matching RSS/feed/Atom/iCal/ICS anchor found. |
| Events HTML | [Tourismus/Veranstaltungen](https://www.castrop-rauxel.de/tourismus/veranstaltungen) GET 200 HTML; no alternate feed link or matching calendar subscription anchor found. |
| Common patterns / open data | No WordPress path inferred for this site. No documented city event dataset endpoint verified. |
| Transit | No documented open real-time disruption feed identified for DSW21/VRR in this pass ([DSW21](https://www.bus-und-bahn.de/)). |
| Nostr | No confirmed city/civic publisher found; CCF planned feature only. |

### Düsseldorf

| Surface | Probe / result |
|---|---|
| News HTML | [News](https://www.duesseldorf.de/aktuelles/news) GET 200 HTML; no alternate RSS/Atom or matching RSS/feed anchor found. |
| Events HTML | Tried `https://www.duesseldorf.de/veranstaltungen`, GET 404; no ICS/RSS endpoint obtained. |
| Open data | Tried [Open Data Düsseldorf](https://opendata.duesseldorf.de/) and CKAN `api/3/action/package_search?q=veranstaltung`; TLS handshake timed out, so cannot conclude whether an event dataset exists. |
| Transit | [VRS real-time GTFS-RT dataset description](https://open.nrw/dataset/ist-daten-bus-und-bahn-opnv-realtime-bn) says OpenService with usage agreement; no direct endpoint/feed probe. |
| Nostr | No confirmed city/civic publisher found; CCF planned feature only. |

### Dresden

| Surface | Probe / result |
|---|---|
| News HTML | Official press route [Pressemitteilungen](https://www.dresden.de/de/rathaus/aktuelles/pressemitteilungen.php) redirects to search results; fetched page exposes alternate `/konfiguration/rss/rss-feed-pressemitteilungen.rss`, verified working above. |
| Events HTML | Tried [Dresden event calendar path](https://www.dresden.de/de/kultur/veranstaltungen/veranstaltungskalender.php), GET 404; no event calendar ICS/RSS URL verified. |
| Open data | Tried `https://opendata.dresden.de/`, GET 200 HTML (390 bytes; no usable catalog/API found). No events dataset established. |
| Transit | Search identified DVB SIRI-ET via [Mobilithek](https://mobilithek.info/), but dataset URL/terms not pinned or probed; not counted as usable feed. |
| Nostr | No confirmed city/civic publisher found; CCF planned feature only. |

### Freiburg im Breisgau

| Surface | Probe / result |
|---|---|
| News HTML | [Press releases](https://www.freiburg.de/pressemitteilungen/index.html) GET 200 HTML (1,479 bytes); no alternate feed or matching anchor in returned body. |
| Events HTML | Tried `https://www.freiburg.de/pb/,Lde/233797.html`, GET 404; no event feed verified. |
| Transit | [VAG GTFS download page](https://www.vag-freiburg.de/service-infos/downloads/gtfs-daten) GET 200; static GTFS documented, not a live disruption feed. VAG requires attribution “Datensatz der VAG Freiburg.” |
| Nostr | No confirmed city/civic publisher found; CCF planned feature only. |

## What a morning feed can reliably use today

- **Strausberg:** use official news RSS + events RSS. VBB real-time is technically live and CC BY 4.0, but this observed feed had trip updates only and zero alerts/vehicle positions; do not label as service-alert coverage.
- **Köln:** use koeln.de event ICS (30 VEVENTs) with aggressive past-event filtering and source links; an official City of Köln press feed and anonymous event open-data API were not verified. koeln.de feed ownership/terms differ from city-government publication.
- **Münster:** use City-linked Presse-Service RSS for headlines and publication times; events remain HTML-only in this probe. Busradar is a lead for live bus locations, not verified disruption alerts here.
- **Wuppertal:** use official press RSS; events and open transit alerts remain unresolved.
- **Castrop-Rauxel:** only HTML news/events verified; no reliable machine feed identified.
- **Düsseldorf:** only HTML news verified; Open Data portal timed out and VRS real-time needs agreement; no feed yet.
- **Dresden:** use official press RSS. Events feed not established; DVB SIRI-ET is a follow-up candidate, not yet an operational integration source.
- **Freiburg:** no machine-readable news/events feed established; VAG provides static transit schedules, not disruptions.

All 5 working feeds' counts/titles/dates are in the inventory. RSS/ICS full text licensing is not explicitly stated on those responses; treat them as discovery/notification sources, link to publisher and seek permission before republishing full text. No verified Nostr city/civic feed was found among the eight; CCF's proposed Nostr publisher is not a currently available feed.
