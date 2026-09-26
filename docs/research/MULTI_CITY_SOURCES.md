# Multi-city public sources and reuse without asking

**Checked 26 September 2026.** Read-only live probes used `User-Agent: LedgerOfLifeResearch/1.0`; status/counts below are response-time observations, not completeness guarantees. Existing context: [Strausberg source roadmap](ROADMAP_DATA_SOURCES_STRAUSBERG.md), [Atlas/CCF interfaces](STADTSTACK_ATLAS_AND_CCF_INTERFACES.md), [city-data vision](../VISION_CITY_DATA.md). A public URL is not a reuse licence. “Not verified” means the specified live probe did not establish access or rights, not that no source exists.

## Recommendation first

| Pilot | OParl | Planning geometry | Roadworks | Budget open data | OSM | Rationale / source |
|---|---|---|---|---|---|---|
| Berlin | ✗ in this sample | ✓ portal-listed B-Plan WFS, live service still unverified | ✗ city-feed not verified; Autobahn A10 is nearby but not municipal | ? GovData search only | ✓ OSM/ODbL | Strongest identified open-data starting point; Berlin’s dataset page states dl-de/zero-2.0 but warns updated 2004: [dataset](https://daten.berlin.de/datensaetze/bebauungsplanverfahren-in-berlin-wfs-4f574ea7), [MCP reference](https://github.com/technologiestiftung/open-data-mcps). |
| Köln | ✓ | ? no live layer verified | ? city roadworks not verified | ? | ✓ | OParl System live; city data/roadworks coverage requires targeted follow-up. [OParl](https://buergerinfo.stadt-koeln.de/oparl/system). |
| Münster | ✓ | ? no live layer verified | ? city roadworks not verified | ? | ✓ | OParl System in CCF verified list; Münster portal API hostname did not resolve in this probe. [OParl](https://oparl.stadt-muenster.de/system), [CCF](https://github.com/komma-systems/ccf/blob/main/jurisdictions/de/registry.yaml). |
| Wuppertal | ✓ | ? no live layer verified | ? city roadworks not verified | ? | ✓ | OParl System and existing CCF verification; useful council-data pilot. [OParl](https://oparl.wuppertal.de/oparl/system). |
| Strausberg | ✗ confirmed route probes failed in prior research | ✓ DiPlan procedure geometry exists; reuse licence unresolved | ✗ municipal feed not established | ✗ detailed plan not found online; ordinance has headline planned investment | ✓ | Visual/resident pilot, not a rights-cleared open-data pilot. Prior source checks and limitations: [roadmap](ROADMAP_DATA_SOURCES_STRAUSBERG.md), [vision](../VISION_CITY_DATA.md). |

These are a source-coverage shortlist, not five cities with all four requested machine feeds. **Best evidence-backed mix:** Berlin for discoverable open geodata and Köln/Münster/Wuppertal for OParl; Strausberg for the existing curated story. Do not label a city’s budget or municipal-roadworks feed available based only on a national catalogue hit.

## 1. OParl discovery and live sample

The broadest public endpoint list located was the community-maintained [OParl/resources `endpoints.yml`](https://github.com/OParl/resources/blob/main/endpoints.yml), which its [README](https://github.com/OParl/resources) describes as a directory, alongside OParl’s [project site](https://oparl.org/). CCF’s [German registry](https://github.com/komma-systems/ccf/blob/main/jurisdictions/de/registry.yaml) is a smaller hand-verified subset (four verified councils when the companion research was written). I fetched the resources YAML (HTTP 200, 17,828 bytes), took its first 20 title/URL entries as listed (including its duplicate Braunschweig entry), then GET each endpoint once with the research UA. **10/20 returned parseable JSON whose `type` was `https://schema.oparl.org/1.0/System` or `1.1/System`; 10 did not.** Transient errors, duplicate directory rows and legacy endpoint behavior make this a reproducible sample, not a national success rate.

| Listed council | GET endpoint | Result |
|---|---|---|
| Stadt Köln | [endpoint](https://buergerinfo.stadt-koeln.de/oparl/system) | 200, OParl 1.1 System |
| Landeshauptstadt Düsseldorf | [endpoint](https://ris-oparl.itk-rheinland.de/Oparl/system) | 200, OParl 1.1 System |
| Stadt Dresden | [endpoint](https://oparl.dresden.de/system) | 200, OParl 1.1 System |
| Stadt Wuppertal | [endpoint](https://oparl.wuppertal.de/oparl/system) | 200, OParl 1.1 System |
| Stadt Münster | [endpoint](https://oparl.stadt-muenster.de/system) | 200, OParl 1.1 System |
| Stadt Krefeld | [endpoint](https://ris.krefeld.de/webservice/oparl/v1.1/system) | 200, OParl 1.1 System |
| Stadt Freiburg | [endpoint](https://ris.freiburg.de/oparl) | 200, OParl 1.0 System |
| Klingenstadt Solingen | [endpoint](https://sdnetrim.kdvz-frechen.de/rim4957/webservice/oparl/v1.1/system) | 200, OParl 1.1 System |
| Stadt Castrop-Rauxel | [endpoint](https://castroprauxel.gremien.info/oparl) | 200, OParl 1.0 System |
| Kolpingstadt Kerpen | [endpoint](https://sdnetrim.kdvz-frechen.de/rim4770/webservice/oparl/v1.0/system) | 200, OParl 1.0 System |

The other ten entries were Bonn (HTTP 200 but non-JSON body), Aachen (404), Eschwege (400), duplicate Eschwege (400), Leipzig (500), duplicate Braunschweig entries (HTTP 200 but non-JSON body), Hagen (404), Ludwigslust-Parchim (DNS failure), and Ulm (404). Full sample URL provenance is the ordered list linked above. Vendors inferred only where endpoint hostname/path clearly identifies them: the working systems span ITK Rheinland (Düsseldorf), Dresden’s own host, Münster’s own host, RIS Freiburg, KDVZ Frechen/RIM (Solingen and Kerpen), plus the Cologne, Wuppertal, Krefeld and Castrop-Rauxel hosts; the latter are not reliably attributable to a vendor from URL alone. OParl JSON itself does not declare a dataset reuse licence. Larger working cities include Köln, Düsseldorf, Dresden, Münster and Freiburg; also Wuppertal, Krefeld and Solingen. Endpoint GET proves a System object, not current completeness, document access or permission to republish attachments.

## 2. Roads, closures and city roadworks

### Autobahn GmbH

Live GET [`/o/autobahn/`](https://verkehr.autobahn.de/o/autobahn/) returned HTTP 200 JSON, a `roads` array of **107** names (including a repeated/space-padded `A60` value in the response). Three roads were sampled, all requests HTTP 200:

| Endpoint | Response items | Trimmed observed item |
|---|---:|---|
| [`A1/services/roadworks`](https://verkehr.autobahn.de/o/autobahn/A1/services/roadworks) | 240 | `identifier=2026-048449…`, `future=true`, `extent=49.29987,6.96286,…`, `point=49.29987,6.96286…` |
| [`A1/services/closure`](https://verkehr.autobahn.de/o/autobahn/A1/services/closure) | 51 | `identifier=2026-000572…`, `future=true`, coordinate `extent` and `point` present |
| [`A10/services/roadworks`](https://verkehr.autobahn.de/o/autobahn/A10/services/roadworks) | 43 | `identifier=2026-047635…`, `future=true`, coordinate `extent` and `point` present |
| [`A10/services/closure`](https://verkehr.autobahn.de/o/autobahn/A10/services/closure) | 8 | `identifier=2026-047353…`, `future=true`, coordinate `extent` and `point` present |
| [`A40/services/roadworks`](https://verkehr.autobahn.de/o/autobahn/A40/services/roadworks) | 48 | `identifier=2026-041181…`, `future=false`, coordinate `extent` and `point` present |
| [`A40/services/closure`](https://verkehr.autobahn.de/o/autobahn/A40/services/closure) | 17 | `identifier=2023-001968…`, coordinate `extent` and `point` present |

Responses are JSON arrays under `roadworks`/`closure`; observed record keys include `identifier`, `icon`, `isBlocked`, `future`, `extent`, `point`. Counts are live and may change; not all fields or date/description fields were enumerated from the samples. Official API/docs: [Verkehrsinformationen API](https://verkehr.autobahn.de/). **Licence:** a reuse licence was not verified from the response/API page in this probe; do not assume open licensing. Freshness: returned records included scheduled identifiers as late as Oct 2026 and a past 2023 identifier still present, so filter dates/status rather than treating all returned entries as current.

### Municipal works and Mobilithek

[Mobilithek](https://mobilithek.info/) is the federal mobility data access platform and [MDM](https://www.mdm-portal.de/) is its predecessor; no authenticated/user-specific or dataset-specific roadworks API query was completed here, so no national city-feed coverage, count, licence or refresh claim is made. City checks: Köln landing-page guess `https://www.stadt-koeln.de/service/open-data` returned 404; Münster guessed CKAN API `https://opendata.muenster.de/api/3/action/package_search?q=Baustellen&rows=3` failed DNS; Hamburg guessed `https://daten.hamburg.de/api/3/action/package_search?q=Baustellen&rows=3` failed DNS; Berlin guessed `https://daten.berlin.de/api/3/action/package_search?q=Baustellen&rows=3` returned 403. These failed guesses do not establish absence. Dedicated municipal works endpoints, format, licence and freshness for Köln/Münster/Berlin/Hamburg therefore remain **not verified**.

## 3. Bauleitplanung geometry

| Jurisdiction/source | Live probe and observed result | Format/count/fields/licence/freshness |
|---|---|---|
| NRW | Candidate [Bebauungspläne NRW](https://www.geoportal.nrw/) / [Bauleitplanung NRW](https://bauleitplanung.nrw.de/) service; no exact live WFS URL successfully queried in this run. | Not verified; no feature count or licence claim. |
| Brandenburg | [DiPlan Beteiligung](https://bb.beteiligung.diplanung.de/) individual procedure pages and Strausberg geometries are known from [atlas research](STADTSTACK_ATLAS_AND_CCF_INTERFACES.md); no complete all-procedures API/index geometry response tested. | Not shown to be a statewide feature service; completeness and licence not verified. |
| Berlin | Portal listing: [Bebauungsplanverfahren in Berlin WFS](https://daten.berlin.de/datensaetze/bebauungsplanverfahren-in-berlin-wfs-4f574ea7), portal says `dl-de/zero-2.0`, updated 2004. GET guess `https://gdi.berlin.de/geoserver/wfs?service=WFS&version=2.0.0&request=GetCapabilities` returned HTTP 404. | Portal supports WFS claim, but this probe did not reach capabilities/GetFeature: counts, properties and live freshness unverified; stale portal update warning is material. |
| Hamburg | No service endpoint found and queried in this run. | Not verified. |
| Bayern | No service endpoint found and queried in this run. | Not verified. |

No XPlanung/INSPIRE feature count or fields (`plan name`, `status`, `dates`) are claimed absent a successful GetFeature response. State-level coverage needs exact service URLs from dataset metadata before selection; don’t infer it from a portal title.

## 4. GovData and budget discovery

Live GETs to CKAN [`package_search`](https://www.govdata.de/ckan/api/3/action/package_search) with `rows=0` returned HTTP 200 and these `result.count` values: `Baustellen` **163**, `Bebauungsplan` **25,068**, `Haushalt` **1,906**, `Haushaltsplan` **250**. These are full-text search-result counts, not unique city datasets or open-licensed resources. For `Baustellen&rows=3`, HTTP 200 response results included a record authored “Digitale Mobilität” with blank licence ID/title (`isopen=false`); sample confirms why catalogue hits are not rights evidence. Query links: [Baustellen](https://www.govdata.de/ckan/api/3/action/package_search?q=Baustellen&rows=0), [Bebauungsplan](https://www.govdata.de/ckan/api/3/action/package_search?q=Bebauungsplan&rows=0), [Haushalt](https://www.govdata.de/ckan/api/3/action/package_search?q=Haushalt&rows=0), [Haushaltsplan](https://www.govdata.de/ckan/api/3/action/package_search?q=Haushaltsplan&rows=0).

**Top ten city publishers by relevant datasets not established.** CKAN search `results` were deliberately not enumerated across cities, and catalogued publisher strings are not necessarily city entities. “OffenerHaushalt successor”/Doppik search and municipality-level dataset validation were not performed; no cities are asserted as budget open-data publishers from these counts alone. For a valid ranking, fetch all paginated records for several budget/works queries, normalize publisher/jurisdiction, de-duplicate dataset IDs, inspect each licence and resource availability. Catalogue root: [GovData](https://www.govdata.de/); its API schema is exposed at [`help_show`](https://ckan.govdata.de/api/3/action/help_show?name=package_search).

## 5. Legal basis and practical reuse rules

**This is a conservative research summary, not legal advice.** Primary law links: [UrhG §5](https://www.gesetze-im-internet.de/urhg/__5.html), [§51](https://www.gesetze-im-internet.de/urhg/__51.html), [§87a](https://www.gesetze-im-internet.de/urhg/__87a.html), [§87b](https://www.gesetze-im-internet.de/urhg/__87b.html), [§2](https://www.gesetze-im-internet.de/urhg/__2.html), [§4](https://www.gesetze-im-internet.de/urhg/__4.html), [§62](https://www.gesetze-im-internet.de/urhg/__62.html). Interpret each specific document and its components; publication to a portal does not itself make content public domain.

- **§5(1) official works:** statutes/ordinances and other official texts issued in the official interest for general knowledge (including laws, regulations, official decrees/notices) are not protected by copyright. A Bebauungsplan adopted as a municipal statute under [BauGB §10](https://www.gesetze-im-internet.de/bbaug/__10.html) and a Haushaltssatzung are strong candidates for §5(1), including their normative text. Officially issued Amtsblatt notices likewise generally qualify. A draft, explanatory report, map annex or attachment does not automatically become an official work merely because it accompanies a statute; assess authorship, publication purpose and third-party material separately. **Uncertain at component/boundary level.**
- **Council papers:** Beschlussvorlagen, staff reports, minutes and presentations are not automatically §5(1) official works. Whether a specific text qualifies depends on statutory character/public-interest issuance; ordinary administrative/councillor prose may remain protected. The [BGH, “Vorschaubilder III” (2017)](https://www.bundesgerichtshof.de/SharedDocs/Entscheidungen/DE/2017/07/urteil_v_21_09_2017_i_zr_11_16.html) concerns limits of §5(2) official-work status for court decisions/editorial headnotes; it illustrates that an official context does not erase independent editorial additions. Obtain advice for bulk verbatim council-document republication.
- **§5(2):** other official works may be protected, but may be reproduced/distributed/communicated in customary manner with source indication; changes are allowed only within §62’s narrow constraints. This is not a blanket “anything public” exemption. Quoting under [§51](https://www.gesetze-im-internet.de/urhg/__51.html) is purpose-bound (e.g., genuine explanatory/critical quotation), limited to justified extent and requires source identification; it is not a general dataset-copying licence. Facts/ideas are generally not protected as such, but original wording, photography, maps/graphics and selection/arrangement may be.
- **Third-party and database rights:** expert reports/Gutachten, commissioned studies, photos and third-party maps may be protected even inside a public council file. A database may have sui generis protection under §§87a–87e: substantial extraction/reuse, or repeated systematic extraction of insubstantial parts that conflicts with normal exploitation, is restricted. Public portal access is not consent to wholesale scraping. Do not republish full attachments or map tiles/layers until rights are identified.
- **Licences:** [Datenlizenz Deutschland](https://www.govdata.de/dl-de/by-2-0) `dl-de/zero-2.0` generally permits reuse without attribution, subject to licence conditions; `dl-de/by-2.0` requires attribution/source and change indication. Confirm the exact dataset’s current licence text/metadata and preserve attribution. No dataset-wide licence may be inferred from one layer or city portal. [GovData licence overview](https://www.govdata.de/web/guest/lizenzen).
- **OSM:** [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) requires attribution; public use of a derivative database can trigger share-alike for the derived database. Keep OSM-derived database outputs separable and provide the required notice/licence; independently authored facts and unrelated city records are not automatically ODbL. OSM data is not a verified official directory.
- **Terms/robots:** robots.txt is a crawler instruction, not an intellectual-property licence or legal permission. Terms of use can impose contractual/access conditions depending on assent and facts; technical/public accessibility alone settles neither. Check each portal’s terms and rate limits; prefer documented APIs and bulk downloads. Terms/robots for the listed RIS providers were not individually reviewed.

**Practical release rule:** without contacting a city, publish (1) independently worded factual summaries/measurements with source URL, exact page/field locator, source/retrieval date, jurisdiction, uncertainty and attribution; (2) statutory/official text only where §5 status and third-party inclusions are checked; and (3) machine data under a verified dataset licence, respecting attribution, conditions and database rights. When rights are unclear, publish a source index/link and short factual extraction rather than the source document, attachment, copied description or geometry. Do not redistribute Gutachten, photos, third-party maps, complete council-paper archives, or substantial database extracts absent a clear licence/statutory basis; §51 quotation is not a workaround for bulk copying. Preserve corrections and licence provenance.

## Probe gaps and evidence boundary

The required breadth was not fully achieved: only 20 OParl URLs and six highway feeds were live-probed; city-roadworks systems, Mobilithek dataset details, NRW/Brandenburg/Hamburg/Bayern WFS, Berlin GetFeature, GovData city ranking, and individual portal terms were not successfully established. The exact failed requests are recorded above. The resulting multi-city plan can start with OParl endpoints demonstrated here and Berlin’s portal-listed WFS only after service revalidation; it cannot yet claim a rights-cleared national planning/municipal-roadworks/budget pipeline.
