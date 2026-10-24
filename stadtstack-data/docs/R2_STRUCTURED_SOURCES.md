# R2 structured sources: offline implementation and request review

This work sends **no requests**, reads no owner credentials, issues no authority, and makes no production DB/network/CLI mutation. The request draft has empty `issuedAt`. Source catalogue entries remain `not_checked`: registration, a parser and owner approval in principle are not policy admission or evidence of town coverage.

**Execution priority:** GENESIS31231 comes first: its nine owner-account POSTs
follow only its own reviewed policy/metadata prerequisites. The combined draft
is a request inventory, not an instruction to execute MaStR first or require its
bulk parser before GENESIS. MaStR national bulk remains preparation only and
requires a later, separate reviewed issuance, cap and streaming ZIP/XML sandbox.

## Authority and source registration

Owner record: `/home/max/.local/state/stadtstack-data/r2-authorities/stadtstack-data/reports/approvals/r2-owner-approval-2026-10-24.json`, SHA256 `fc7f7acd93a7ab1c6a3044e24367bec52891a0b96b9b3852276079b7f37ce8e4`, `approved.structuredSources`. It permits a narrow public nine-town solar/wind slice and GENESIS table31231-02-01 via the existing owner account, subject to exact plans, source rights and security coverage. It does not establish a particular export URL, payload schema or unlimited national-download budget.

`sources/district-registry.json` registers `mastr` and `regionalstatistik-genesis` for all9 exact municipality/AGS pairs (17 additional entries; Strausberg GENESIS already existed). MaStR's root is the official download landing; GENESIS retains the existing `data/table` root. No follow-all-links, seeds, checked licence claim or robots override is added. **Do not extend the immutable R1 registered-source robots decision** to these additions. The old `registered-source-policy.ts` list is intentionally unchanged: catalogue admission alone gives none of the new scopes that old exception/7-day proof entitlement. Any new policy authority or longer validity needs its own review; a one-hour public proof cannot silently become permission for a longer processing horizon.

| Municipality | AGS |
|---|---|
| Strausberg |12064472|
| Hoppegarten |12064227|
| Rüdersdorf bei Berlin |12064428|
| Ratzeburg |01053100|
| Mölln |01053090|
| Schwarzenbek |01053116|
| Ludwigslust |13076090|
| Parchim |13076108|
| Hagenow |13076060|

## MaStR route comparison and decision

| Criterion | Official Gesamtdatenexport | Extended public unit overview/export |
|---|---|---|
| Documented entry point | `https://www.marktstammdatenregister.de/MaStR/Datendownload` | `https://www.marktstammdatenregister.de/MaStR/Einheit/Einheiten/ErweiterteOeffentlicheEinheitenuebersicht` |
| Stability / reproducibility | Prefer a single publisher-advertised versioned static ZIP, retained by actual SHA256 with immutable HTTP/version evidence. Do not guess a filename or silently follow a mutable latest alias. | Interactive CSV export/session/anti-forgery flow is explicitly unverified in the existing source contract. Session tokens and capped slices make exact replay/coverage fragile. |
| Requests | One data-file GET after common policy/terms/landing review; no per-town query/session. | Per-scope export and possibly multiple slices; exact filter/session requests are unknown offline. Do not invent a 9/18-export guarantee or continuation. |
| Licence clarity | Main confirms the documented dl-de/by-2-0 bulk route; still pin current legal/distribution markings and any exceptions. | Existing inspected legal notice explicitly covers CSV/XLS; still distribution-specific review and privacy requirements. |
| Size | **Exceeds the district release's1GiB cap** (Main's stated prerequisite); actual current compressed/expanded sizes are unknown here. Requires separate structured authority, not reuse of the district allowance. | Current/extended export documentation records5,000/25,000-row caps; existing CSV adapter accepts at most16MiB. Neither cap proves all-town completeness. |
| Parser | ZIP and XML must stream inside a newly reviewed parser sandbox. Current whole-buffer Core is not a national bulk reader. | Existing bounded native CSV/XLS mapping can be fixture-tested. CSV discovery is not an implemented session driver. |

**Recommend the official static Gesamtdatenexport**, on documented stability, licence clarity, fewest data requests, no session handling and reproducibility—not on smaller bytes. The extended overview is not an automatic fallback. If bulk size, rights, native schema or sandbox gates fail, stop for a new decision; do not scrape the UI or relax caps.

### Integrity evidence and missing native prerequisites

There is no admitted current download-page snapshot in this assignment. The exact ZIP href, advertised version/date/size, publisher hash availability, member layout and public-operator XML schema are therefore **unknown**, not invented. PhaseA is an exact bounded preflight; phaseB must be separately resolved and issued by Main from its genuine results.

`discoverMastr` records a ZIP reference only when advertised as Gesamtdatenexport on the exact official landing (same-host scope remains conservative). It does not download, inspect or admit the archive. Discovery runs through the existing structured parser sandbox. `planR2MastrBulkRequest` consumes pinned native discovery references, **not host-parsed source HTML**, refuses missing/incomplete/ambiguous/session-signed references and returns only a review-required GET proposal. Main must authenticate the committed discovery receipt/output and replay those references. An external download/redirect host not covered by this conservative discovery needs a reviewed new explicit host/reference policy, never an inferred allow.

Bulk selection additionally requires `resources.length === coverage.observedRows`
from the authenticated native discovery result. `nextCursor === null` proves
only that a page is terminal: MaStR discovery has at most32 references per page
while `observedRows` counts the complete landing's reference set. A terminal
page omitting earlier candidates therefore refuses, even when it contains just
one ZIP. This planner does not combine or authenticate a cursor chain; accepting
a multi-page aggregate would need its own complete authenticated reference-set
contract. The existing successful single-page path and ambiguity refusal remain.

Before issuing that one GET, retain byte-pinned landing/manifest and exact quotes/locators for the actual href, filename/version, advertised compressed bytes and any publisher checksum. If the publisher provides no checksum, record that evidenced absence explicitly after review; the locally calculated download SHA256 plus authentic HTTPS/HTTP custody is **not** an independent publisher digest. Do not use ETag as a cryptographic checksum or filename date as a publication/event date. Pin actual HTTP Content-Length/version/redirect metadata and refuse a changed manifest or an oversized response.

### Separate bulk transport and sandbox requirements

Proposed caps (not observed file sizes): one ZIP, **8GiB compressed**, **8GiB+128MiB total response bodies** including the known small requests and repeated policies/failures,64GiB aggregate expanded bytes,16GiB per member,2,048 members, ratio100,16MiB minimized output,768MiB worker memory,2h campaign wall cap. All are hard bounds; if current metadata exceeds them, refuse before starting and seek a new explicit cap decision. Approval must also cover the unavoidable private national public-source original required for replay, not pretend that whole-country input is a nine-town HTTP response. No public republication of the raw dump or unnecessary operator data.

Current boundaries remain intact: `AcquisitionSelectorSchema.maxBytes` is64MiB; `MASTR_LIMITS.bytes` is16MiB; structured input JSON has a90MiB source-string transport bound. **Do not raise those generic limits.** Bulk needs a separate reviewed streaming fetch-to-private-original/CAS path and direct read-only source-file input to the parser sandbox, with incremental actual byte counting/SHA256 and atomic admission/tombstone cleanup. It cannot pass a multi-GiB Buffer/base64/JSON value through Node or unzip/XML-parse on the host.

The ZIP/XML review must bind the exact image, worker/source/dependency hashes and resource controls. Stream member reads without extraction; reject traversal/absolute/NUL/duplicate names, symlinks/devices, encrypted or unsupported members, bad CRC/truncated archives, overlapping/inconsistent headers, expansion/ratio/record/text limits and malformed encodings. Disable DTD/entities, XInclude and external I/O; no network, credentials, shell or writable host mounts. Pin native schemas first—CSV headers do not establish native XML field names or publicness flags. Stream solar/wind records, filter exact AGS first, retain only approved fields, and join operators only on explicit public organization classification plus native ABR ID. Do not load a national actor map into memory. Bind minimized output to original ZIP SHA, exact member, native SEE/ABR IDs and field paths; a generated CSV is not a replacement source original. Unknown/redacted/natural-person operators yield no identifier/name/relation. New real-image confinement/overflow/ZIP/XML/entity/privacy sentinels are required before bulk execution.

**Bulk fetching/parsing is not implemented by the bounded CSV reader.** It explicitly returns `held_quality` for ZIP/XML. Implementing/authorizing the large-file route requires the missing genuine versioned artifact/schema evidence; this assignment does not fabricate that evidence or claim bulk readiness.

## Narrow implemented MaStR mapping

`src/adapters/mastr.ts`, mapping `mastr-public-export-v2`, accepts only the exact `mastr` source and canonical9-town municipality/AGS pair, and explicit solar/wind electricity carrier rows. The implemented native CSV/SpreadsheetML projection keeps:

- SEE unit ID and explicit8-digit AGS; operating status and carrier as source qualifiers;
- original commissioning date (not planned/site/registration/decommissioning date);
- rated solar gross kWp or wind gross kW, and net kW; never energy generation;
- ABR operator ID and the explicit **organization-only** disclosed name together; otherwise an unknown operator qualification without ABR leakage.

Storage, system/planning/registration/decommissioning/update facts, addresses, contacts and generic/private operator-name fields are excluded even from observation evidence. Native source version comes from admitted snapshot metadata; record update/retrieval never creates an operator effective interval. `nativeStructuredIdentityGraph` recognizes the new mapping version and binds `organization --operates--> energy_unit` only to explicit native identifiers and original cell evidence. Modality is `asserted`, interval/date unknown; source-scoped MaStR identity is not independent legal-entity verification or confirmed-current operation.

Frozen questions: **E03** gains only those qualified operator/unit candidate edges, not municipal ownership or a heat-network operator; **E05** gains source-listed status/commissioning/rated capacity, not measured yield, benefit or a complete town inventory. `docs/ontology.yaml` and `docs/ONTOLOGY.md` already have the correct concepts: unit/capacity as **Output**, disclosed actor as **Organization**, qualified edge as **RelationEvidence**. No financial Asset, natural Person or new ontology concept is introduced. R2 source admission remains prototype/unverified, not a newly claimed live feed.

## GENESIS housing plan and mapping

Table `31231-02-01` was already in `GENESIS_TABLES`; this change makes its municipal JSON selection and reference-year contract explicit (`regionalstatistik-datencsv-v3`) and registers/tests all9 AGS. Use **2024** as an explicit bounded comparable year, not a claim that it is the latest available year. Metadata must genuinely confirm the table, GE/GEMEIN and that year before data requests. If the endpoint corrects to an unknown depth suffix/variable, returns Status104 or a different layout, stop for review; do not copy the population table's `-5` suffix or add fallback requests.

One anonymous metadata POST (owner-account authorization currently covers data endpoints, not metadata):

```text
POST https://www.regionalstatistik.de/genesisws/rest/2020/metadata/table
Content-Type: application/x-www-form-urlencoded
name=31231-02-01&area=free&language=de
```

Then one existing-owner-account POST per exact AGS, with credentials injected only by Core's existing header policy, never copied into bodies/plans/logs:

```text
POST https://www.regionalstatistik.de/genesisws/rest/2020/data/table
Content-Type: application/x-www-form-urlencoded
name=31231-02-01&area=free&language=de&regionalvariable=GEMEIN&regionalkey=<exact AGS from the nine frozen records>&startyear=2024&endyear=2024&compress=false&transpose=false&job=false&format=datencsv&quality=on
```

The actual draft contains all9 literal bodies, not the notation above. Metadata is still subject to current robots/TDM/public access: account permission does not expand to it. Any block stops the plan. No password/token read occurs in this implementation, no GAST fallback, no `data/tablefile` retry and no background source jobs. Each data response cap is4MiB, metadata1MiB. Successful JSON parsing requires corrected `Parameter.regionalkey` equal to the requested town, GEMEIN `Structure.Rows` selected exactly once, datencsv format and exact reference year. District aggregates are held rather than assigned to a town.

Building/dwelling counts and explicit area units remain statistical context. The date is **31 December2024**, `statistical_reference_date`, never retrieval/publication, construction completion, occupancy, ownership or causal impact. Source signs/suppression, decimal/unit semantics and exact original cell provenance remain unchanged.

## Exact draft requests, budget and security v2 → v3

`sources/r2-structured-request-plan.draft.json` and pure `buildR2StructuredRequestPlan` agree byte-semantically. There are15 fixed policy/terms/landing/WADL GETs,1 metadata POST and9 literal data POSTs: **25 known primary requests**, then at most **one separately resolved/issued static ZIP GET**. Maximum26 primary requests; hard total**208 network attempts** (8 per resource, conservatively including repeated policy probes, redirects, failures and the bulk request), no automatic retry. These are caps, not a claim of26 wire requests: existing per-job fetchers can repeat policy probes. One in flight, at least5s between starts; every request/response/failure consumes the same ledger. No paid API/model calls. Additional discovery hosts, requests, page continuation or a second ZIP require new review/issuance. Wall cap2h is not an unmeasured throughput estimate.

The issued R1 structured release is `r1-step8-source-fetch-security-release-2026-10-22-v2.json` (schema `r1-step8-source-fetch-security-release-v1`). It lifts the old stop **only for the reviewed step8 continuation**, binds Node24.22.1, polite-fetch SHA `1a9e6bd01fc01f1a3bb7883a466949400a369aa984895405cb0d9b52b2ce7da2`, acquisition contract `b29c293b4ff6ee6c31a7039b45f8cf1e0f73dc68774552e5aa29de2951fec0d1`, review and gate receipts. It does not authorize R2 sources, tables, new bytes, caps or a streaming ZIP parser. The district R2 release's1GiB allowance is also not this separate authority.

A new **structured v3** review/issuance must machine-bind, rather than merely mention in scope prose:

1. Actual owner record/SHA/structured section, exact unissued request-plan SHA, all9 AGS, table/year/fields and the separately approved national-original/cap/privacy footprint.
2. A preflight-only initial phase; genuine pinned outputs/HTTP receipts/terms/policy evidence and canonical discovery replay before a separate exact one-file GET pin is issued. No preflight observation can silently authorize that data request.
3. Exact installed safe Node binary/path/hash; current fixed fetch and **integrated** acquisition contract; source executor/global-ledger hashes, one-in-flight/5s pacing and no retries. New redirect/download hosts must be explicit reviewed bindings.
4. Fresh-process before/after contract measurement, including `structuredStateGauges`, MaStR, GENESIS, parser isolation/output, preparation/residual/assessment. Adapter changes propagate through the shared parser closure; old parser review/image or structured proofs cannot be relabelled.
5. Newly reviewed/installed streaming bulk path and parser image with genuine fixture and real-image sentinels, native XML schemas/publicness semantics, input/output/CPU/RAM/disk/time caps and cleanup receipts. Existing whole-buffer transport remains closed to bulk.
6. Genuine issuance clocks/expiry and owner/source proofs covering the actual complete execution horizon; authenticate exact records from the separate authority worktree, never issue or edit old authority on main. Until Main issues this, **no preflight or data request is permitted**. Passing fixture tests is not a security release.

## Offline checks and remaining evidence

Behavioral fixtures cover narrow field/privacy/fuel/geography semantics, typed ABR/SEE relations with unknown validity, native discovery refusal, exact25-request draft equality, unchanged old robots scope, and all9 municipal housing bodies/reference dates/selection failures. No test uses a production DB or requests sources. Main must remeasure the integrated tree and run the combined gates before issuing v3.

### Exercised offline evidence

Offline install used `npm ci --offline --ignore-scripts`, no `npx`. Checks used `/home/max/.local/bin/stadtstack-cpu-slot /bin/bash -c 'umask 022; …'`, the exact24.22.1 Node executable, `--max-old-space-size=3072`, and test isolation `none`/concurrency1 (one test Node process). No full/exclusive gate or source request ran here.

- Package TypeScript `--noEmit`: **exit0** (50.40s), after restarting the old CPU-lease wait. The earlier1800s invocation timed out with no result while the old helper was queued only for slotA; it was not a compiler failure/pass.
- Eight-file fixture gate (`district-contract-split`, `district-entity-resolution`, `district-registry`, `district-terminal-exceptions`, `genesis-adapter`, `mastr-adapter`, `r2-structured-request-plan`, `structured-tables`): **103/104 passed**, one failing old cursor fixture (2,827.93481ms test duration). Narrow scope validation now refused its mismatched Ratzeburg/Mölln pair before reaching the cursor check.
- Corrected only that fixture to a valid Mölln municipality/AGS pair; the complete MaStR file then passed **12/12**, zero skips/cancellations (693.904022ms). No code or safety check was weakened. Other92 tests had already passed; this is not a claim of a second combined104-test run.
- Fresh-process contract measurement completed **exit0**,5.29s, against `46adf2e9defae9173ce8f38085f9082cbf5050c6`. Earlier queue-only attempts timed out/cancelled without a measurement file; no old process was reused.

The measurement invokes the unchanged exported contract functions with historical Git blob hashes versus current file hashes, not an inferred file-diff classification. It measures14 native functions plus the2 adapter-specific structured functions. **6/14 native functions change**: preparation extractor, residual preparation/job, structured state gauges, parser output and parser isolation. MaStR and GENESIS structured functions also change. Joint extraction, both assessment contracts, acquisition, policy refresh, operator registry and both OMP functions stay unchanged from the base.

| Current identity | SHA256 |
|---|---|
| Preparation extractor / residual preparation |`44f6a0be6f20759add538f1f7ee41a9a954d85340f8b256ca7cdbc09db7f1389`|
| Parser output |`3024a2b87f136379bf05fcb6d899707567f158f26c2cea0deef25dd0ae247599`|
| Parser isolation |`fa81c5332b9ec0ebc7be7c252d9ac8fb9fbfd0eb609e69a1f376305fb0b86255`|
| Structured mapping |`d13ae43bb194a77dd1695ef3917b9bb48b99ff25b25451e4d71a04c7c6f5073a`|
| `structuredStateGauges` semantic |`c04e4a6e6726b7eda24381321d8946c3e29d94db7125ada2d8ebdd35d2eda003`|
| MaStR structured semantic |`039caba553ca15131c3e9964a23f8e1df5201bc1d6ffc5921cc035e79279af3d`|
| GENESIS structured semantic |`dcdc91e2d9f78343c122a6a3bed0acb3bd72a70de36d408b70511c2c7bd24eb0`|
| Acquisition, unchanged from46adf2e |`fe28346ef211d0cc025c8d65a9656f84ec2d4a5de2115b623f0a409b1599016c`|

The existing terminal-contract snapshot assertions now use these actually measured current identities; no frozen R1 receipt is rewritten. Note that the acquisition identity already differs from structured releasev2's historical `b29c293b…` **at the base**, independently of this source change: reuse of that old release is not current security coverage.

Review pins:

- Committed request draft `sources/r2-structured-request-plan.draft.json`: `8f8afddd5c6b7b67d47aa0f7ae6747048beba7943f49cf19e393c73eaa91f280`.
- `/home/max/.local/state/stadtstack-data/r2-structured-sources/contracts-46adf2e.json`: `8febc1b9e90c6b715c545ccd2322eee2bcbe0b66fa7f816f1e4930f839db4f7b` (full before/after values and exact source closures).
- Same directory, permanent `measure-contracts.mjs`: `b509adb84f8c99eb80c6df4da3544a62b2915abc4e2b87a1d79be9574dbfa83b`.

No actual housing/ZIP payload, credential use, source-coverage proof, live throughput/size/hash observation, streaming bulk parser image/sentinel gate, security release or production integration gate is asserted. The missing exact native artifact/schema/publicness and separate transport authority remain explicit prerequisites, not fabricated receipts or an unimplemented success path.

### Bulk completeness review correction

The review regression constructs33 advertised references: a ZIP on the first
32-reference page,31 CSV links and a different ZIP on the terminal page. Both
native pages refuse selection; a null successor never hides the earlier ZIP.
The six-test request-plan fixture file passed **6/6**, zero failures, skips or
cancellations (910.414821ms test duration), using the CPU-slot helper, umask022,
Node24.22.1,3072MiB old-space cap, isolation `none`, concurrency1 and
`--test-timeout=30000`. No source requests or production actions were performed.
This focused correction did not rerun typecheck, the full gate or real discovery;
GENESIS remains the first execution priority and MaStR bulk remains later/separate.
