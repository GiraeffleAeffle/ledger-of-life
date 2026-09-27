# Reusable pipeline components (research, 2026-09-27)

Stars are GitHub API `stargazers_count` observed 2026-09-27; last release is latest tagged GitHub release checked on that date (no release means none surfaced, not proof no version). Hosting means operational footprint, not vendor claims. Links are the primary-source evidence; projects' release/license pages can change.

## 1. Existing civic/document pipelines

| Option | Licence; language; maturity checked | Hosting | Fit / effort |
|---|---|---|---|
| [Meine Stadt Transparent](https://github.com/meine-stadt-transparent/meine-stadt-transparent) | MIT; PHP/JS; 46★; pushed 2023-07-10; GitHub Releases: none surfaced | Self-host web app + database/search; [docs](https://github.com/meine-stadt-transparent/meine-stadt-transparent/tree/main/docs) | Closest German OParl civic product: imports council data, search/notifications. Reuse its user-facing council concepts, not pipeline: separate full application/data model, significant adaptation; keep our normalized signals, provenance, geo outputs. |
| [Politik bei uns](https://github.com/politik-bei-uns) / [web-old](https://github.com/politik-bei-uns/politik-bei-uns-web-old) | BSD-3-Clause on web-old; PHP; maturity/releases not reliably enumerated in current project organization | Legacy web/indexing stack and database | Relevant OParl precedent, but older coupled application rather than extractable TypeScript ETL; inspect individual repo before any code reuse. |
| [CCF](https://github.com/komma-systems/ccf) | Source checkout is already used by our pipeline; verify exact upstream repository metadata before redistribution. GitHub lookup for `civictechwr/ccf` returned 404 (wrong guessed owner; no stars/release asserted). | We currently shallow-checkout and parse CCF OParl export | Keep adapter, pin/version checkout, clarify upstream license and attribution; CCF is a council data source/export, not end-to-end pipeline. |
| [Council Data Project](https://github.com/CouncilDataProject) / [cdptools_v2](https://github.com/CouncilDataProject/cdptools_v2) | cdptools_v2 BSD-3-Clause; Python; project reports customizable pipelines | Hosted instance requires storage/indexing and media/transcription services | Useful video/meeting ingest patterns, but US council-video focus; not replace German OParl/document/geo pipeline. |

## 2. Browser and crawl collection

| Option | Licence; language; checked maturity | Hosting | Fit / effort |
|---|---|---|---|
| [Playwright](https://github.com/microsoft/playwright) | Apache-2.0; TS/JS and others; 96,727★; latest release page: [releases](https://github.com/microsoft/playwright/releases) | Browser binaries/worker; can run locally or CI | Best low-level browser for sites lacking feeds; small TS integration, retain our polite cache/retry/source snapshot logic. |
| [Scrapy](https://github.com/scrapy/scrapy) | BSD-3-Clause; Python; 64,496★; [releases](https://github.com/scrapy/scrapy/releases) | Python worker; persistent job store optional | Mature static crawl; separate runtime and duplicate HTTP/cache model, moderate bridge effort; prefer direct HTTP before browser. |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Apache-2.0; Python; GitHub API old guessed path returned 404; see current [repo](https://github.com/unclecode/crawl4ai) | Python + browser/container | LLM-ready extraction is extra complexity; candidate only after feed/API discovery fails. |
| [Firecrawl](https://github.com/firecrawl/firecrawl) | AGPL-3.0; TS; 185,260★; [releases](https://github.com/firecrawl/firecrawl/releases) | Self-host multi-service stack or hosted service | Powerful crawl/API but AGPL obligations and hosted lock-in make it poor default; avoid importing a whole crawler for a few city pages. |
| [Stagehand](https://github.com/browserbase/stagehand) / [Browser Use](https://github.com/browser-use/browser-use) | Stagehand Apache-2.0, Browser Use MIT; TS/Python; Browser Use 116,447★, Stagehand metadata [here](https://github.com/browserbase/stagehand) | Browser + model/provider; Browser Use can use hosted browsers | Agentic browser is nondeterministic/LLM-costly; not a reliable unattended primary collector; use Playwright deterministic selectors instead. |

## 3. Document extraction

| Option | Licence; language; checked maturity | Hosting | Fit / effort |
|---|---|---|---|
| [Docling](https://github.com/docling-project/docling) | MIT; Python; 68,017★; [releases](https://github.com/docling-project/docling/releases) | Python environment; heavier models for layout/OCR | Strong layout/table extraction; would replace PDF.js page-one extraction with Python service/CLI bridge. Pilot on German council PDFs; retain source snapshots and citations. |
| [Unstructured](https://github.com/Unstructured-IO/unstructured) | Apache-2.0; Python; 15,504★; [releases](https://github.com/Unstructured-IO/unstructured/releases) | Python dependencies; hosted API optional | Broad parsing, larger dependency footprint; fit if mixed formats become material. |
| [Marker](https://github.com/datalab-to/marker) | GPL-3.0; Python; [repo/releases](https://github.com/datalab-to/marker) | GPU beneficial; model downloads | High-quality conversion but GPL/model terms and compute weigh against small pipeline; verify current license and model terms before reuse. |
| [pdfplumber](https://github.com/jsvine/pdfplumber) / [pdfminer.six](https://github.com/pdfminer/pdfminer.six) | MIT; Python; [pdfplumber releases](https://github.com/jsvine/pdfplumber/releases) | Lightweight Python | Text/layout fallback; less OCR/layout automation than Docling. Existing `pdfjs-dist` avoids new runtime; change only if measured extraction quality warrants. |
| [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) | MPL-2.0; Python; 34,878★; [releases](https://github.com/ocrmypdf/OCRmyPDF/releases) | Tesseract + Ghostscript; CPU | Practical scanned-PDF OCR; German language pack `deu` required. Add only scanned-document detection, then feed searchable PDF into current extractor. |

## 4. LLM evaluation

| Option | Licence; language; checked maturity | Hosting / capabilities |
|---|---|---|
| [DeepEval](https://github.com/confident-ai/deepeval) | Apache-2.0; Python; 18,458★; [releases](https://github.com/confident-ai/deepeval/releases) | Existing FaithfulnessMetric + custom model/provider support; local CI works. Confident AI is optional hosted observability, not required for evaluator. Keep current calibrated threshold and explicit caveat that faithfulness is not truth/completeness. |
| [Ragas](https://github.com/explodinggradients/ragas) | Apache-2.0; Python; 15,857★; [releases](https://github.com/explodinggradients/ragas/releases) | Faithfulness and custom LLM adapters; CI/library use; useful if retrieval QA grows, otherwise duplicate evaluation stack. |
| [TruLens](https://github.com/truera/trulens) | MIT; Python; [repo/releases](https://github.com/truera/trulens) | Feedback functions include groundedness; local or hosted observability; additional instrumentation/storage. |
| [promptfoo](https://github.com/promptfoo/promptfoo) | MIT; TS; [repo/releases](https://github.com/promptfoo/promptfoo/releases) | CI-friendly YAML/CLI eval and many provider adapters; supports RAG/faithfulness assertions, but not a drop-in replacement for our Python calibrated FaithfulnessMetric. |

## 5. Human review queue

| Option | Licence; language; checked maturity | Can statement + excerpt + score, accept/reject, reviewer/time? / effort |
|---|---|---|
| [Argilla](https://github.com/argilla-io/argilla) | Apache-2.0; Python; 5,123★; [releases](https://github.com/argilla-io/argilla/releases) | Flexible text fields/metadata and annotation responses; can represent evidence and score as fields and capture user/submission metadata. Self-host server + DB; configure dataset/workflow/export adapter. |
| [Label Studio](https://github.com/HumanSignal/label-studio) | Apache-2.0 core; Python; [releases](https://github.com/HumanSignal/label-studio/releases) | UI can show arbitrary evidence/score and accept/reject; task annotations identify annotator/time. Self-host app + DB; integration/export work. Enterprise features differ. |
| [Doccano](https://github.com/doccano/doccano) | MIT; Python; [releases](https://github.com/doccano/doccano/releases) | Text classification supports accept/reject and users; source excerpt/score can be rendered as task text/metadata but workflow is simpler. Self-host app + DB. |
| Tiny custom queue | Project license; existing Node/GeoJSON | Exact fit: show `statement`, source excerpt, Faithfulness score, and persist decision/reviewer/timestamp. | Low-to-medium effort given existing `reviewState` (`candidate/auto_checked/reviewed/rejected`); add authenticated local UI/API and append-only decision record. Best option if tightly scoped; do not mislabel auto-check as review. |

## 6. Orchestration and provenance

| Option | Licence; language; checked maturity | Hosting / fit |
|---|---|---|
| [Dagster](https://github.com/dagster-io/dagster) | Apache-2.0; Python; 16,206★; [releases](https://github.com/dagster-io/dagster/releases) | Daemon + metadata DB/UI; strong asset lineage/versioning. Python conversion and operational overhead unjustified for current three commands. |
| [Prefect](https://github.com/PrefectHQ/prefect) | Apache-2.0; Python; 23,939★; [releases](https://github.com/PrefectHQ/prefect/releases) | Worker/server or cloud; retries/scheduling/observability; some hosted features create lock-in. Adds Python orchestration around Node commands. |
| Cron / GitHub Actions | cron system license / Actions service terms; shell/YAML; not a comparable GitHub-star project | Cron needs always-on host; Actions hosted runner + secrets/artifact retention | Keep current explicit collect/evaluate/publish steps and content-hash/source snapshots. Add schedule only when operational owner and human-review gates defined; Actions is simplest scheduled runner, but cache/output persistence and credentials need deliberate setup. |

## 7. Publishing and metadata

| Option | Licence; language; maturity | Hosting / fit |
|---|---|---|
| [Datasette](https://github.com/simonw/datasette) | Apache-2.0; Python; project/release metadata [here](https://github.com/simonw/datasette/releases) | Self-host web app or static publishing; ideal exploratory SQLite, less suitable replacement for current GeoJSON + MCP contracts. |
| [Frictionless Data Package](https://frictionlessdata.io/) / [frictionless-py](https://github.com/frictionlessdata/frictionless-py) | MIT library; Python; 844★; [releases](https://github.com/frictionlessdata/frictionless-py/releases) | No service required; adopt manifest/schema conventions around files with modest effort. |
| [CKAN](https://github.com/ckan/ckan), [DKAN](https://github.com/GetDKAN/dkan), [Piveau](https://github.com/piveau) | CKAN AGPL-3.0; DKAN GPL-2.0; Piveau components vary (check each) | Full portal and database/search stack | Integrate via dataset/API export if publishing to a municipal portal; not needed for personal app. Copyleft and ops review required. |
| [DCAT-AP.de](https://www.dcat-ap.de/) | German application profile/specification, not a software license | Metadata serialization only | Add catalog metadata mapping; keep existing catalogue as source of truth and publish mapping, not new platform. |
| [open-data-mcps](https://github.com/technologiestiftung/open-data-mcps) | Repo-specific license/maturity check required; [project](https://github.com/technologiestiftung/open-data-mcps) | MCP server deployment | Compare tool/resource contract; our read-only file-backed MCP already serves city signals/changes/sources, so reuse ideas rather than substitute. |

## 8. City cockpits / urban platforms

| Option | Licence / maturity | Reuse for personal resident cockpit? |
|---|---|---|
| [Masterportal](https://github.com/masterportal/masterportal) (Hamburg-origin) | Apache-2.0; large geospatial web client; [releases](https://github.com/masterportal/masterportal/releases) | Reusable map UI/data connectors, but institutional GIS product; too heavyweight for personal feed and does not provide individualized private location filtering by itself. |
| [COSI — Cockpit für städtische Infrastruktur](https://www.cosia.de/) | Public project information does not establish reusable open-source license/repository | City infrastructure cockpit, not a confirmed code package; cannot recommend copying without license/source confirmation. |
| [DKSR Open Urban Platform](https://www.dksr.city/) | Vendor/platform; open components and terms vary by module | Data integration/reference architecture, but deployment/contract model not equivalent to local resident app; verify module licenses. |
| [FIWARE](https://www.fiware.org/) / [Orion-LD](https://github.com/FIWARE/context.Orion-LD) | FIWARE components vary; Orion-LD AGPL-3.0, 69★ | Context broker useful for live city IoT, not news/events aggregation. AGPL and service operations are unnecessary for static feeds. |

## Recommended stack

| Stage | Recommendation |
|---|---|
| City/council pipeline | **Keep ours**: existing source adapters, normalized GeoJSON, provenance, diffs, read-only MCP. Reuse CCF/OParl interchange; do not adopt a monolithic portal. |
| Browser collection | **Adopt Playwright only as needed** behind source adapter; first prefer documented RSS/API/iCal and ordinary HTTP. |
| PDFs | **Keep PDF.js**; benchmark Docling and OCRmyPDF on scanned/complex German papers before replacing or adding. |
| Faithfulness | **Keep DeepEval** and local Codex provider; CI smoke the evaluator contract; no hosted Confident AI dependency. |
| Human approval | **Later: tiny custom review UI/queue** over current states; Argilla if annotation volume/team grows. `auto_checked` must remain distinct from `reviewed`. |
| Scheduling/lineage | **Later: cron or GitHub Actions**, only after ownership/retention/review policy. Current hashes/snapshots already supply practical provenance. |
| Publishing | **Keep GeoJSON/catalogue/change files/MCP**; add Frictionless + DCAT-AP.de metadata mapping if downstream portal requests it. |
| Personal city cockpit | Reuse individual feeds/data schemas and perhaps map components; do not adopt institutional GIS cockpit wholesale. |

## Can `stadtstack-data` be extracted?

**Likely yes, as a Node package/repository with a clean boundary, not yet as a zero-edit copy.** Its README calls it standalone Node ≥22, says no Next.js dependency, and exposes collect/evaluate/publish/MCP commands; output is already a documented consumer contract. Internal pipeline files (`src/cities.ts`, source adapters, schema, publisher, changes, MCP) are concentrated under `stadtstack-data/src/`. The root product currently consumes its `out/` files through `/api/signals` and retains separate `/api/atlas/<city>` sources ([README](../../stadtstack-data/README.md)). Extraction checklist: identify actual imports outside `stadtstack-data`; move package-owned scripts/config/lockfile and tests; make output/cache paths explicit; resolve provider/model config and CCF checkout location; publish stable package API/CLI; rename product-branded `Stadtstack` atlas references and package/binary; preserve city IDs, schemas and output contract; document data rights. Before moving, use import search—README's “standalone” claim is evidence of intent, not proof of zero coupling. No runtime/repo dependency graph was executed for this research.

## Risks

- **Copyleft:** Firecrawl AGPL, CKAN AGPL, DKAN GPL, Orion-LD AGPL and Marker GPL can impose source-sharing obligations depending on use/distribution; obtain legal review, do not assume network use is exempt. OCRmyPDF MPL has file-level obligations. Check transitive/model licenses too.
- **Rights are source-specific:** the upstream dataset/license, not collector license, governs republishing. Existing README records Autobahn API license unknown; retain attribution and do not imply blanket open licensing. OParl availability is not blanket document reuse permission.
- **Hosted lock-in/privacy:** hosted crawl/eval/orchestration can expose city interest, source text, and potentially coordinates; keep resident-home filtering client-side, consistent with current design.
- **Operational complexity:** Python services, GPU/OCR, browsers, databases and workflow servers are substantial vs current scheduled CLI. Do not add them without measured failure/volume need.
- **Quality:** faithfulness checks passage support, not truth, completeness, legal status or correct geography; explicit human decision log remains necessary for consequential claims.

### Maturity-check note

GitHub API returned the star counts quoted above on 2026-09-27. For relevant release checks, linked releases pages are the source; this quick pass did not reliably retrieve latest release timestamps for every project, so where no date is written no release date is asserted. The GitHub repository lookups for two guessed CCF/CDP repository names returned 404 and were not treated as evidence that those projects do not exist.
