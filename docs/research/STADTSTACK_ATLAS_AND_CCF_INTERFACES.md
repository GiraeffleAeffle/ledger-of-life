# Stadtstack Atlas, CCF and open-data MCP interfaces

Research snapshot: 2026-09-26. Repository paths below refer to `/Users/max/Code/strausberg-project-atlas` unless they begin `/tmp/atlas-ccf` or `/tmp/atlas-open-data-mcps`.

## Findings at a glance

- The running atlas is `/Users/max/Code/strausberg-project-atlas`; PID 62223 serves port 4317 using `node .../vinext dev --host 127.0.0.1 --port 4317` (observed via `lsof`/`ps`). Source map: `README.md`, `app/api/atlas/[city]/route.ts`, `app/api/atlas/[city]/map/route.ts`, `lib/cities.ts`, `lib/projects.ts`, `lib/map-projection.ts`, `lib/project-map.ts`, `data/project-register.json`, `data/regional-projects.json`, and `public/` exports.
- It is a TypeScript/React Next-style application running through Vite-based Vinext; `package.json`, `vite.config.ts`, `next.config.ts` and the observed Vinext process support that characterization. README describes the app as an independent prototype, not a confirmed complete municipal register (`README.md`).
- Four jurisdiction IDs are configured: `strausberg`, `roebel-mueritz`, `herzogtum-lauenburg`, `ludwigslust-parchim`; counts are 24, 6, 3, 2 projects respectively (35 total) (`lib/cities.ts`, `data/regional-projects.json`, `README.md`).
- Core API is municipality-scoped `GET /api/atlas/{city}` with schema `atlas-city-read-model-v1`; map API is `GET /api/atlas/{city}/map` with schema `project-atlas-map-v1`. Both return SHA-256 ETags, honor `If-None-Match` with 304, and unknown city with 404 (`app/api/atlas/[city]/route.ts`, `app/api/atlas/[city]/map/route.ts`, `research/VERIFICATION.md`).
- Project records distinguish plan/consultation from construction and preserve source locators, unknowns, next steps and review state; locations may be approximate. The schema intentionally does not imply a complete inventory (`lib/projects.ts`, `lib/cities.ts`, `data/project-register.json`).
- `planning-catalogue.json` and `projects.geojson` are static public files. Catalogue is a lightweight list of 40 planning procedures; GeoJSON contains five published DiPlan boundaries, all flagged pending review (`public/planning-catalogue.json`, `public/projects.geojson`, `README.md`).
- Research was assembled by human source review and local scripts/cache, not automatic publication: source collection/cache scripts and manifest exist; README explicitly says scripts are utilities, not an automated publication/review pipeline (`scripts/collect_sources.py`, `scripts/build_inventory.py`, `research/source-manifest.json`, `README.md`, `research/VERIFICATION.md`).
- No MCP server, DCAT catalogue export, or general open-data licence declaration was found in the examined atlas repo/README. OSM facility data explicitly preserves ODbL attribution; municipal geometry reuse requires checking its applicable licence (`README.md`, `research/VERIFICATION.md`).
- CCF currently verifies four German OParl councils—Köln, Münster, Wuppertal and Castrop-Rauxel. Its working integration is git-cloned, correction-aware JSON, not REST/MCP; Nostr is explicitly unimplemented (`/tmp/atlas-ccf/README.md`, `/tmp/atlas-ccf/jurisdictions/de/registry.yaml`, `/tmp/atlas-ccf/src/publish/nostr.rs`).
- Berlin's reference MCP offers metadata discovery, CKAN search, dataset fetching, aggregation, geodata/WFS querying and downloads against `daten.berlin.de`; repo README supports local stdio or Streamable HTTP (`/tmp/atlas-open-data-mcps/berlin-open-data-mcp/README.md`).
- Main integration gap: establish stable source-record identity/provenance and licence/review metadata independently of project summaries, then publish filtered versioned JSON/GeoJSON and expose matching read-only MCP tools; keep CCF source records distinct from the atlas's curated project interpretation (`lib/projects.ts`, `/tmp/atlas-ccf/src/normalise.rs`, `/tmp/atlas-ccf/README.md`).

## Atlas location, stack and source map

The service process working directory is `/Users/max/Code/strausberg-project-atlas` (PID 62223, `lsof -a -p 62223 -d cwd -Fn`). Its command is `node /Users/max/Code/strausberg-project-atlas/node_modules/.bin/vinext dev --host 127.0.0.1 --port 4317` (`ps -o command= -p 62223`). The package/config files to inspect for the exact stack are `package.json`, `vite.config.ts`, `next.config.ts`; the live command is Vinext, a Vite-based Next-compatible runtime.

| Concern | File |
|---|---|
| City IDs, coverage dates, jurisdiction type and scope caveats | `lib/cities.ts` |
| Project TypeScript schema and stage vocabulary | `lib/projects.ts` |
| Strausberg curated project source data | `data/project-register.json` |
| Other jurisdiction project data | `data/regional-projects.json` |
| Read model API / validators, ETag behavior | `app/api/atlas/[city]/route.ts` |
| Map API / projection assembly | `app/api/atlas/[city]/map/route.ts`, `lib/project-map.ts`, `lib/map-projection.ts` |
| Published plan boundary FeatureCollection | `public/projects.geojson` |
| 40-entry planning catalogue | `public/planning-catalogue.json` |
| OSM daily-service location dataset | `data/facilities-strausberg.json`, `lib/facilities.ts` |
| Data collection and build scripts | `scripts/collect_sources.py`, `scripts/build_inventory.py`, `scripts/build-regional-inventory.py`, `scripts/prepare-facilities.py` |
| Methods / source and review evidence | `research/PROJECT_BRIEF.md`, `research/PROJECT_INVENTORY.md`, `research/VERIFICATION.md`, `research/source-manifest.json`, `research/REGIONAL_FINDINGS_20260906.md` |

## Atlas model and public endpoints

### Read model: `GET /api/atlas/{city}`

The top level returned by `lib/cities.ts:getCityRegister` is `{schemaVersion:'atlas-city-read-model-v1', municipalityId, jurisdictionType, asOf, reviewState, fullMunicipalInventory, coverage, projects}`. `municipalityId` is the configured city/district ID; `jurisdictionType` is `Stadt` or `Landkreis`; current global review state is `pending_review`; inventory completeness is false (`lib/cities.ts`). Coverage elements contain `family`, state (`partial|index|unavailable|missing`), `checkedAt`, optional `url`, and explanatory `detail` (`lib/cities.ts`).

Each project has `id`, `title`, `category`, `place`, `stage`, `status`, `summary`, `next`, `unknowns[]`, `responsibilities[]`, `sources[]`, `milestones[]`, `latest`, `location|null`; optional `consultation`, `dependencies[]`, `note`, `municipalityId`, `asOf`, `reviewState` (`lib/projects.ts`). `stage` is one of `consultation`, `planning`, `announced`, `construction`, `partial`, `completed`, `unknown`, `cancelled`. Source objects include `id`, `title`, `url`, optional `locator`, `retrievedAt`; milestones have date/label/detail/kind/source. A location holds `[longitude, latitude]`, precision description, and source identifier. Example in source data:

```json
{"id":"altstadt-quartier","title":"Altstadt Quartier","stage":"consultation","status":"Entwurf liegt öffentlich aus","next":"Stellungnahmen bis 20.09.2026; anschließend Abwägung und weitere Entscheidung der Stadtverordnetenversammlung.","unknowns":["Verbindlicher Baubeginn und Fertigstellungstermin","Aktuell terminbestimmende Abhängigkeit"],"location":{"coordinates":[13.8830082,52.5813511],"precision":"Verfahrensgebiet aus DiPlan; keine Baukörperplanung","source":"diplan"},"consultation":{"start":"2026-08-17","end":"2026-09-20","url":"https://bb.beteiligung.diplanung.de/verfahren/altstadtquartier-srb/public/detail"},"reviewState":"pending_review","sources":[{"id":"reason","title":"Planbegründung · Entwurf Juni 2026","url":"https://www.stadt-strausberg.de/wp-content/uploads/2026/08/20260600_BP67-22_Entwurf_Begruendung.pdf","locator":"65 PDF-Seiten; S. 1–2, 9, 26–27, 58, 60"}]}
```
Sample fields from `data/project-register.json`; record includes further milestones, sources and explanatory notes. The sample `reviewState` is the project convention (source data); API-level default is also `pending_review` (`lib/cities.ts`, `lib/projects.ts`).

### Map endpoint: `GET /api/atlas/{city}/map`

Returns `project-atlas-map-v1`, built by `buildProjectMapProjection` from city/project data and for Strausberg published area polygons (`lib/project-map.ts`, `lib/map-projection.ts`). Each project's point is separated from procedure areas; location precision, review, source, city scope and project identifiers are retained. It reuses the same jurisdiction project data, with geometry areas included for Strausberg only (`lib/project-map.ts`, `research/VERIFICATION.md`). Short real geometry sample from its area feature source:

```json
{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[13.8841385,52.581485],[13.8837245,52.5815469],[13.8835144,52.5817769],[13.8820951,52.5818625],[13.8817578,52.5809974],[13.8841385,52.581485]]]},"properties":{"id":"altstadt-quartier","source":"https://bb.beteiligung.diplanung.de/verfahren/altstadtquartier-srb/public/detail","precision":"published_procedure_boundary","review":"pending_review"}}
```
This is a trimmed real feature in `public/projects.geojson`; API route delegates serialization/projection to the versioned model, not direct passthrough (`app/api/atlas/[city]/map/route.ts`, `lib/project-map.ts`).

### Static exports

| Endpoint / file | Shape and scope | Trimmed real sample |
|---|---|---|
| `/planning-catalogue.json` (`public/planning-catalogue.json`) | JSON array, 40 Strausberg planning catalogue entries. Fields: `title`, `sourceClassification`, `constructionStatus`, `sourceUrl`, `checkedAt`. Catalogue classification explicitly does not establish construction (`README.md`, catalogue file). | `{"title":"Bebauungsplan Nr. 72/25 \"Wohnbebauung Ernst-Thälmann-Straße Nord-West\"","sourceClassification":"in_preparation","constructionStatus":"not_established_by_plan","sourceUrl":"https://www.stadt-strausberg.de/bauleitplanung-2/#rb_dasl_accordion_2_collapse1","checkedAt":"2026-09-05"}` |
| `/projects.geojson` (`public/projects.geojson`) | GeoJSON FeatureCollection of five Strausberg published procedure boundaries. Feature properties: `id`, `source`, `precision`, `review`; coordinates are published boundaries, not invented polygons (`README.md`, `research/VERIFICATION.md`). | `{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[13.8841385,52.581485],[13.8837245,52.5815469],[13.8835144,52.5817769],[13.8820951,52.5818625],[13.8817578,52.5809974],[13.8841385,52.581485]]]},"properties":{"id":"altstadt-quartier","source":"https://bb.beteiligung.diplanung.de/verfahren/altstadtquartier-srb/public/detail","precision":"published_procedure_boundary","review":"pending_review"}}` |

These static paths are public-directory assets. No route implements other API endpoints in the reviewed atlas route tree beyond the two `/api/atlas` handlers; observed as `GET` on static assets, rather than a separately versioned API (`public/`, `app/api/atlas/[city]/route.ts`, `app/api/atlas/[city]/map/route.ts`).

### Research method, review and publication status

Strausberg scope is seven of seven planning procedures listed as in preparation plus selected additional projects, not a complete investment register. Budget, ALLRIS and municipal-enterprise reconciliation remains marked missing (`lib/cities.ts`). Project evidence combines public planning portal and municipal web/PDFs, construction/news and procurement; an example's five source links and pinpoint PDF locators are in `data/project-register.json`. Cache/index metadata with source URL, retrieval time and content hash is in `research/source-manifest.json`; scripts include `scripts/collect_sources.py`, `scripts/build_inventory.py`, `scripts/validate-inventory.mjs`. README states raw document caches are local/ignored and scripts are research utilities, not a production ingestion/review pipeline (`README.md`).

Review is still pending: all records remain subject to editorial/municipal review; approximate OSM points are not project boundaries; outdated target dates are not treated as completion. The verification note says one source upload was rejected, no source push or deployment succeeded, and local data remained for review (`research/VERIFICATION.md`). Thus collection and record curation are evidenced; a recurrent, authorized publication pipeline is not.

**Not found** in atlas files inspected: an MCP implementation/server, DCAT metadata, or a general dataset licence statement. To reach this conclusion I checked the repo tree (`README.md`, `package.json`, `app/api`, `public/`, `scripts/`, `docs/`, `research/`) and searched source signatures/documentation; absence from this checkout is not proof no external unpublished implementation exists. README says municipal geometry reuse requires verifying its licence; OSM facility selection retains ODbL attribution (`README.md`, `research/VERIFICATION.md`).

## CCF interfaces

CCF repository: https://github.com/komma-systems/ccf (shallow clone examined at `/tmp/atlas-ccf`). Its `NormalisedRecord` is camelCase-serialized Rust struct with `council_id: String`, `record_type: RecordType`, `source_id: String`, `modified_at: String`, `deleted_at: Option<String>`, and `data: serde_json::Value`; record-type enum serializes camelCase values `meeting`, `paper`, `agendaItem`, `file`, `organization`, `body` (`src/normalise.rs`). It does not store jurisdiction per record; CCF publisher comments note this explicitly (`src/publish/nostr.rs`).

Registry YAML is a `{councils: [...]}` object; each entry has `id`, `name`, `source_format`, `endpoint_url`, `status`; statuses are `pending|verified|stale|dead`, formats currently OParl/ModernGov (`src/registry.rs`, `jurisdictions/de/registry.yaml`). German registry has four verified entries: Köln, Münster, Wuppertal, Castrop-Rauxel (registry URL above). UK registry has a pending placeholder and no verified coverage; the ModernGov example uses synthetic input only (`README.md`, `jurisdictions/uk/registry.yaml`).

Example meeting record (trimmed; real checked-in snapshot):

```json
{"council_id":"wuppertal","record_type":"meeting","source_id":"http://oparl.wuppertal.de/oparl/bodies/0001/meetings/25716","modified_at":"2026-08-10T15:36:47+02:00","deleted_at":null,"data":{"id":"http://oparl.wuppertal.de/oparl/bodies/0001/meetings/25716","name":"nicht öffentliche Sitzung des Gestaltungsbeirates","start":"2027-09-02T15:00:00+02:00","end":"2027-09-02T00:00:00+02:00","type":"https://schema.oparl.org/1.1/Meeting"}}
```
Source: `/tmp/atlas-ccf/data/de/wuppertal/meeting/oparl_wuppertal_de_oparl_bodies_0001_meetings_25716.json`.

Example paper:

```json
{"council_id":"wuppertal","record_type":"paper","source_id":"http://oparl.wuppertal.de/oparl/bodies/0001/papers/vo/36339","modified_at":"2026-09-16T12:12:56+02:00","deleted_at":null,"data":{"id":"http://oparl.wuppertal.de/oparl/bodies/0001/papers/vo/36339","name":"Digitale Parkraumkontrolle; gemeinsamer Antrag der Fraktionen von SPD und CDU","reference":"VO/1129/26","date":"2026-09-16","consultation":[{"meeting":"http://oparl.wuppertal.de/oparl/bodies/0001/meetings/24642","role":"Entscheidung"}],"auxiliaryFile":[{"name":"Gemeinsamer Antrag Rat","mimeType":"application/pdf","downloadUrl":"http://oparl.wuppertal.de/oparl/bodies/0001/downloadfiles/00370148.pdf"}]}}
```
Source: `/tmp/atlas-ccf/data/de/wuppertal/paper/oparl_wuppertal_de_oparl_bodies_0001_papers_vo_36339.json`.

CCF's intended publisher would emit NIP-33 parameterized replaceable events, kind 30818, keyed by council/type/source; source-of-truth remains git. But `publish()` currently returns `NotImplemented`, requiring a Nostr client and test relay (`src/publish/nostr.rs`, `README.md`). README describes git-clone consumption as the only wired integration; REST and MCP are future/intended, not implemented (`README.md`). Records are stored under `data/<jurisdiction>/<council-id>/<record-type>/<source-id>.json`; corrections are new git commits at the same path (`README.md`).

## Berlin Open Data MCP reference

The two requested sources are [`berlin-open-data-mcp/README.md`](https://github.com/technologiestiftung/open-data-mcps/blob/main/berlin-open-data-mcp/README.md) and [ODIS's MCP-server announcement](https://odis-berlin.de/aktuelles/2026-06-29-mcp-server/). The repo README documents 11 tools: `get_portal_stats`, `list_all_datasets`, `search_berlin_datasets`, `get_dataset_details`, `list_geo_layers`, `fetch_geo_features`, `fetch_dataset_data`, `download_dataset`, `aggregate_dataset`, `get_facets`, `list_tags`. Capabilities include CKAN catalog search, data preview/cache, downloadable files, server-side aggregation, GeoJSON/KML/WFS, CQL-filtered WFS features and pagination (`berlin-open-data-mcp/README.md`).

It targets Berlin's CKAN-based portal at `daten.berlin.de`; WFS geodata is often on `gdi.berlin.de` (`berlin-open-data-mcp/README.md`). README supports stdio (`npm start`) and optional HTTP (`npm run start:http`) with `/mcp` Streamable HTTP and `/health`; says standalone operation with compatible clients, and notes optional Puppeteer for JS-rendered downloads. It does not identify a deployed instance/hosting provider; that line is blank in README (`berlin-open-data-mcp/README.md`). ODIS announcement frames the MCP as open-source experimental exploration of its Open Data Portal; data discoverability depends on metadata quality, and complex evaluation remains human-expertise work ([ODIS announcement](https://odis-berlin.de/aktuelles/2026-06-29-mcp-server/)).

The consulted README names backend/API but does not state an explicit licence for either MCP code or individual Berlin datasets. Dataset-specific licences remain source metadata to preserve, not infer; no blanket licence conclusion made. Other repo projects worth surveying: `masterportal-mcp/` (Masterportal-specific MCP) and `interface-prototype/` (MCP interface prototype) are present in the repository tree; neither is a drop-in atlas data backend based on names alone (`https://github.com/technologiestiftung/open-data-mcps/tree/main/masterportal-mcp`, `https://github.com/technologiestiftung/open-data-mcps/tree/main/interface-prototype`). The accessible tree also contains supporting media, not evidence of more portals. The root listing/search did not establish additional portal connectors; mark additional connectors **not found** in the paths examined (`https://github.com/technologiestiftung/open-data-mcps`).

## Gap list: atlas as source-agnostic open-data interface

### (a) CCF council records

1. Add an intake adapter that reads CCF's versioned store (or a future API) and preserves upstream council ID, jurisdiction, record type, source ID/URI, modified/deleted markers and original OParl JSON; CCF already supplies these except jurisdiction on each record (`/tmp/atlas-ccf/src/normalise.rs`, `/tmp/atlas-ccf/README.md`).
2. Represent meeting, agenda-item, paper and file as source records linked to project concepts, not force each into the project lifecycle schema. Preserve many-to-many paper/meeting/consultation relations and original record types (`/tmp/atlas-ccf/src/normalise.rs`, sample CCF paper record above).
3. Define stable IDs, crosswalk/link semantics, deduplication and correction/tombstone behavior; a source correction should update evidence and trigger editorial re-review, not silently rewrite a project status (`/tmp/atlas-ccf/README.md`, `lib/projects.ts`).
4. Store retrieval time, original source modification time, source URI/document locator, publisher attribution/licence, jurisdiction and review/derivation provenance. Atlas currently has source URL/locator/retrievedAt and project-level review, but no general policy/licence/source-record envelope (`lib/projects.ts`).
5. Make CCF integration explicit as experimental for Strausberg until its OParl endpoint appears in CCF's verified registry; none of the four current councils is Strausberg (`/tmp/atlas-ccf/jurisdictions/de/registry.yaml`).

### (b) Other collected sources, open data and MCP

1. Generalize ingestion around typed sources/adapters for OSM POIs, city pages, PDFs and spatial layers; persist immutable source snapshots/hash, retrieval/check dates and extraction locator, then bind curated claims to evidence. Existing scripts/cache do not constitute a continuing pipeline (`scripts/collect_sources.py`, `research/source-manifest.json`, `README.md`).
2. Separate raw source records, extracted assertions, curated project read model and geometry products. Keep confidence/precision, status semantics, pending review and incomplete coverage explicit; keep OSM approximate point distinct from official project polygon (`lib/projects.ts`, `public/projects.geojson`, `research/VERIFICATION.md`).
3. Add a rights/attribution registry per dataset/resource (licence URI, attribution, terms, allowed redistribution, source owner). Obtain/verify municipal and document reuse rights; carry ODbL attribution and share-alike conditions for OSM-derived exports. Existing README calls for licence verification and only mentions ODbL for facilities (`README.md`).
4. Publish machine-readable stable dataset metadata (DCAT-AP/DCAT-AP.de where appropriate), schema/version, publisher, temporal/spatial coverage, update frequency, provenance, licence, contact and distribution links; the examined repo currently has no DCAT files/API (**not found** in `public/`, `app/api/`, README).
5. Provide validated bulk distributions (JSON/GeoJSON; optionally CSV for tabular catalogue), stable identifiers, filtering/pagination, update timestamps and ETag/Last-Modified; retain the existing read-model and map endpoints as compatible consumer surfaces (`app/api/atlas/[city]/route.ts`, `app/api/atlas/[city]/map/route.ts`).
6. Implement read-only MCP tools mirroring open-data tasks: catalogue/dataset search, dataset/record details, project/source lookup, spatial/time filters, bounded GeoJSON feature retrieval, and resource download/preview. Expose the same licence/provenance and uncertainty users get in exports; Berlin MCP offers a proven capability checklist, not reusable atlas code by assertion (`berlin-open-data-mcp/README.md`).
7. Operate MCP over stdio for local personal use and optionally Streamable HTTP for remote clients with explicit auth/rate limits; publish health/status and document hosting. Berlin README documents both transports but does not document deployed hosting (`berlin-open-data-mcp/README.md`).
8. Add a reproducible review/publication gate and correction log: automatically collected/extracted data remains unpublished until reviewed; output updates should be auditable and trace to source version. This is especially important because atlas items currently remain pending review and its scripts are not a publication pipeline (`research/VERIFICATION.md`, `README.md`).
