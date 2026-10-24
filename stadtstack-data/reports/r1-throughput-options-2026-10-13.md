# R1 nine-town throughput options — 13 October 2026

## Decision summary

**Recommend reducing complete lifecycle executions first, then coalescing only redundant inventory transactions. Do not relax source custody, full save validation, live objections, or fsync.**

1. Combine resource-policy and document-origin inspection of the **same exact representation and bindings** in one `withParserSandbox` callback. For PDFs, execute metadata/version inspection in that same source-owned container where needed. The existing sandbox already supports sequential tool commands. This removes whole enrollment/create/start/remove/close cycles rather than trying to make unsafe cycles cheaper.
2. Preserve lane-marker and completeness checks, but combine the initialization inventory transaction with the planned-lease transaction. Combine successful daemon-removal persistence with the final scratch-close commit while still proving removal before unlink. These two changes can remove two load/save pairs per normal sandbox without changing the v1 disk format.
3. Treat closed-lease archival as a coordinated custody/audit change, **not an immediate `scratch=[]` production edit**. Its potential is real: this fixture's save fell from **4.342 s to 2.578 s** when 93 MB of terminal scratch records was excluded. The reduced fixture is only a cost bound; no archive implementation or compaction correctness was exercised.
4. R1 acquisition currently creates a **new PoliteFetcher per job**. Robots/TDM caches therefore do not amortize across jobs, even if the worker process survives. Reuse is real in the long-lived crawler, not in today's R1 single-representation job handler. A job-safe reusable policy cache has large potential but requires review of request accounting, permission context and source-scope boundaries.

The supplied production observation is the baseline, not a measurement made here: about 93 s before the validated-bytes cache, with 8 full loads / 9 saves; about 55 s per sandbox is the post-cache planning assumption. The fixture produced a modeled **50.571 s** normal sandbox budget using its measured warm-load/save medians plus the supplied approximately 1 s Docker/command overhead. This is consistent in scale, but **not a new production sandbox timing**.

### Material sizing correction

The current registry has **42** sources across the nine named towns: **41 non-structured sources and one structured GENESIS source**. Of the 41 non-structured sources, **37** have `followLinkedDocuments:true`; three bob-sh discovery-only registrations and the Hagenow publisher PDF have it false. Their root URLs span **22 distinct HTTPS origins**. Consequently, “41 sources all follow linked documents” is not the current registry's literal content.

This was computed read-only from `sources/district-registry.json`; municipality sections start at lines **63, 510, 818, 1157, 1566, 1930, 2335, 2646, 5595**. The structured source is at **424–460**; the four non-following registrations are at **1444–1467, 1852–1875, 2215–2238, 5620–5708**. No access or successful crawling is inferred from registration. The throughput scenarios below exclude structured GENESIS and retain those four roots as single representations.

## Scope, evidence and restrictions

Only this report was created in the repository. No `src/` or `test/` edit, production authority access, database access, public network request, Docker execution, build, test suite, linter or formatter was performed. Source inspection and the explicitly requested **isolated synthetic fixture benchmark** were performed.

File:line references below are relative to `stadtstack-data/`, unless stated otherwise. Source references describe the working files read during this analysis; `civic-opt-out.ts` used by the benchmark had SHA-256 **`8d7c5e84c1d6462efec7697a910c1785c74c39e360c5928393b3ed37116ad62d`**. Also inspected the local immutable Git tag with `git show 0.3.2:stadtstack-data/src/civic-opt-out.ts`; this is a local code read, not a deployed-process probe.

`[INFERENCE]` denotes cost extrapolation, a proposed design, or a statically identified execution possibility not exercised here. Tests cited below were **read, not run**.

## 1. Exact inventory work in one source-owned parser lifecycle

### Entry and normal path

`withParserSandbox` reads the review before Docker effects (`src/district-parser-isolation.ts:126–133`). With a `ParserSourceContext`, it delegates to `withManagedSourceScratch` at **295–298**. It snapshots one artifact, fsyncs it and chmods it read-only (**183–197**), then calls `scope.createContainer` and `container.start` (**205–208**). Its `finally` explicitly calls `container.remove` before returning to scope teardown (**267–271**).

The table enumerates the **normal intended 8 `loadInventory` / 9 `saveInventory` path**, counting initialization even for an already initialized root. Initialization is not a cached success: `laneInitializations` serializes concurrent calls, then deletes its gate (`src/civic-opt-out.ts:636,651,660`).

| Step | Full inventory load | Inventory save | Effect and guarantee | Classification |
|---|---|---|---|---|
| 1. Validate/enroll acquisition lane | `initializeManagedAcquisitionLane:653–658` → `enrollRoot:625` | `enrollRoot:628` | Reads/validates marker, root identity and reconciles completeness; writes changed entries/root/completeness before acquisition is allowed. Comment **637–640**, README **201,203**, orphan/completeness tests `test/civic-opt-out.test.ts:135–144,396–401`. | **Coalescable**, not skippable checks. Existing unchanged root need not be rewritten solely because another scratch callback starts. Prefer one locked initialization + planned-lease transaction; a failed reconciliation must still durably record `complete:false` as the existing test requires. New/changed enrollment must be committed by the next pre-effect barrier. |
| 2. Register planned lease | **867** | **870** | Persists UUID/directory, exact source contributors, owner and purpose before `mkdir` of the owned lease directory (**871**). README **203**; recovery **1035–1047**; scratch tests **532–544,594–601**. | **Required barrier for crash ownership/recovery**, but can carry step 1's changes. Do not simply create an unregistered directory and rely on later cleanup. |
| 3. Activate lease with inode | No additional load: same locked inventory as step 2 | **872** | Persists actual `(dev,ino)` before callback/source writes. `writeSource` enforces source digest and fsync (**888–893**); `inspectScratchTree` rejects nonempty identity-null scratch (**796–803**). Test **535–538** sees an active enrolled lease before source bytes. | **Required before source bytes/native work**. Coalescing it with step 2 by writing only after `mkdir` would lose automatic ownership of the pre-commit crash directory. That is a recovery-semantic change, not a free redundant-save deletion. |
| 4. Reserve Docker resource | **945** | **945** | Durable unique name/nonce, local daemon, image/contract/config hash and immutable input hash. Nothing creates the container yet. README **142**; `test/civic-docker.test.ts:158–170`. | **Reservation must be durable before create**. The separate `reserved` snapshot can potentially be merged with step 5, but only after reviewing the never-requested-create recovery distinction described below. |
| 5. Record create intent | `persist:939`, called at **959** | `persist:941`, called at **959** | `create_requested` is written before Engine create at **960** / `src/civic-docker.ts:144–149`. A timed-out request may create later. `test/civic-docker.test.ts:199–219` explicitly preserves an unknown create outcome. | **Required intent barrier before create**. Retaining only `reserved` during an external create is unsafe: its absence is accepted as removable, whereas an unknown create may arrive late. Can carry reservation in the same commit, subject to the recovery distinction. |
| 6. Commit inspected CID | `persist:939`, called at **960** | `persist:941`, called at **960** | Actual ID comes from Engine create and an inspected stopped container. Inspection proves name/image/nonce/labels/config/mounts (`src/civic-docker.ts:109–149`). README **142** requires inspect and commit before start. | **CID must be durable before start**. Its *separate* `created` commit might be combined with step 7 for an immediate-create-and-start parser API, but generic callers can return without starting, and a known CID changes absence recovery. Needs review; do not globally drop it. |
| 7. Record start intent | `persist:939`, called at **969** | `persist:941`, called at **969** | Rechecks immutable input/control, attaches, durably writes `start_requested`, then issues Engine start. Test **161–162** observes the CID and `start_requested` at the actual start request. | **Required pre-start barrier** under the documented state machine. A combined CID/start-intent commit must still be after inspection and before start, preferably before attach; attach-before-start remains mandatory. |
| 8. Confirm container removal | `persist:939`, called at **952** | `persist:941`, called at **952** | `container.remove()` closes attachment/wait, revalidates authority, removes by verified identity and proves absence. `src/civic-docker.ts:151–157`; parser **271**; README **142**; removal-failure tests `test/civic-docker.test.ts:174–195`, `test/civic-opt-out-docker.test.ts:49–75`. | **Removal proof required before unlink**, but a separate whole-inventory success save is **coalescable with step 9**. Keep the prior durable known CID until the combined close commit; a crash after confirmed removal is recoverable because a known CID plus actual absence is accepted. Never translate an unconfirmed removal into `removed`. |
| 9. Close scratch | **989** | **989** | Under lock sets `closing`, calls `cleanScratch`, re-proves daemon cleanup before tree deletion, marks `closed` or `partial`, and commits settled groups/resource states/tombstones. `cleanScratch:820–844`. `closing` is only in-memory: there is **not another closing save**. | **Required durable completion/partial result** before returning. Carries step 8's successful removal state if coalesced. Tests **543–544**, README **203**; failure cannot be reported as completed purge. |

### Important non-normal and additional reads/writes

* **Every save itself reads the entire previous inventory file again.** `saveInventory:480–483` performs full strict codec validation, one stringify, byte cap, `atomicJson`, then canonical-byte cache hashing. `atomicJson:244` calls `fileBytes(path,MAX_STATE,true)` before replacement. Thus the 8/9 baseline includes **17 complete inventory file reads**, not just eight disk reads: eight loads plus nine safe prior-file reads inside saves. This latter read does not parse the previous inventory.
* `loadInventory:454–474` performs the safe bounded read/digest, fresh JSON parse and authority-marker/inventory-ID comparison. Only exact canonical validated bytes skip schema/structural checks. The cache does not remove the read, digest or parse. README **211** is explicit.
* Authority validation also opens **the inventory prefix**, not the whole inventory: `assertCivicPolicyAuthority:308–320` → `requireInventoryEpoch:248–264`. This happens in initial authority checks, live host checks, lock preflight/post-acquisition (`locked:409,424`), `assertActive:879–882`, source writes, Docker removal and the filesystem watchers (**981**). The number is event/command dependent; these are **not additional `loadInventory` calls**. The same inventory epoch/owner/mode bounds remain live.
* `scope.spawn` is **not used for the source-owned Docker parser controller**. When used by another callback it adds one full load/save at **908 for every gated child**, before gate release at **909**. Comment **846–847** and test **583–590** require process-group identity durable before executing native code. Container commands run inside the already enrolled container, so issuing two sequential `sandbox.run` commands does not add child-registration inventory writes.
* `createContainer` failures write `uncertain` at **961** through `persist`; removal failures write `uncertain` at **953**. Teardown may write `partial` at **989**. These failure commits retain the recoverable resource; they are not success-path redundant saves and cannot be dismissed as telemetry.
* **The explicit-removal path can schedule another removal persistence.** `daemonRemovers.add(remove)` at **957** is never undone; successful `remove` clears its in-flight promise at **954**. Scope teardown calls `controller.abort` at **984**, which invokes `stopDaemons:876` before its abort listener is removed at **988**. If the explicit parser removal has already completed, this can issue another proof/removal and `persist` (**952**) as well as `cleanScratch`'s proof. `[INFERENCE]` This can add a ninth load/tenth save, with timing-dependent ordering, or a swallowed redundant-cleanup error. **8/9 is the intended/measured baseline supplied by the assignment, not a universal maximum.** Removing the finished callback or retaining an idempotent completed removal promise can avoid the redundant persistence; actual daemon absence proof must remain. This was traced, not benchmarked with Docker.
* `cleanScratch` calls daemon removal/proof directly (**825–829**) and mutates resource states without calling `persist` for each resource; its enclosing close/recovery/purge save commits all those results. Source file unlink and tombstone insertion are at **835–841**. There is no per-file inventory save.
* A callback may additionally invoke managed final writes. `withManagedSourceWrite` loads once at **1001**, commits source entries at **1023 before the write callback**, then verifies bytes/live hosts after it (**1024–1027**). That barrier is independently required by comment **993–997** and the in-flight-objection test **90–103**; it cannot be moved after publication.
* Initialization preamble failures before the callback, interrupted lock ownership, opt-outs and unconfirmed daemon responses do not necessarily execute the complete nine-save success path. No estimate assumes they do.

### Safe transaction reduction versus changed recovery semantics

**Two clean candidates:** (a) lane reconciliation + planned registration in one lock/load/commit, preserving the planned/active split; (b) successful removal + close in one final commit, with actual daemon removal before scratch unlink and durable CID available until commit. Both preserve full codec, v1 JSON and source contributors. `[INFERENCE]` Together they reduce the intended path from **8/9 to 6/7 loads/saves**, saving about **11.31 fixture seconds**, or **12 planning seconds**, per normal sandbox. Do not hold the inventory lock through the entire parser command; objections publish independently and participating purge still needs the lock.

**Not equally free:** `removeManagedDocker:154` accepts absence when a resource has a known CID, or has null CID in `reserved`/`removed`; null CID in `create_requested`/`uncertain` remains pending. Combining reserved/create-requested widens the conservative partial-recovery window before any request was actually sent. Delaying the created/CID save until start widens the same window after a confirmed create. Those alternatives can still fail closed, but alter recovery completeness and generic container API semantics. They need explicit state-machine review, not a claim that all intermediate states are disposable.

## 2. PoliteFetcher: actual fetch and sandbox multiplicity

### Successful document trace

1. `fetch:372` initializes the explicitly authorized lane (**141–150**) then calls `fetchInternal(...,'document')`. Each redirect repeats applicable checks (**373–416**); cross-host transfer is refused before destination retention (**432–435**).
2. For each origin, `policy:321–343` retrieves `/robots.txt` through `fetchInternal(...,'robots')` (**326**). A successful representation gets **resource-policy inspection at 489–490**, then UTF-8/directive validation and `parseRobots` (**510–520**), but no document-origin or PDF inspection because `checkTdm` is false. This is **one source-owned sandbox**, not a separate sandbox for `parseRobots`.
3. `machinePolicy:345–370` retrieves the standardized `/.well-known/tdmrep.json`, plus registered same-origin known policy URLs from **408–411**, through `fetchInternal(...,'tdm')` (**354**). TDM retrieval checks robots but not recursively TDM (`checkRobots/checkTdm:374`). A successful representation gets **one resource-policy sandbox** and then strict UTF-8 JSON/TDM rule parsing (**521–525**), not a document-origin sandbox.
4. The document request uses conditional metadata at **417–420**. On 200, decoded bytes are hashed and MIME sniffed (**479–486**). On 304, retained bytes and current source permission are checked again (**449–459**), and omitted header evidence is preserved (**460–476**).
5. The real document always gets **one resource-policy sandbox** at **489–490**. `src/district-policy-inspection.ts:10–20` verifies the exact pre-admission URL/hash binding and invokes `withParserSandbox(body,...)`; its worker parses downloaded representation policy.
6. A document passing the preceding gate gets **one document-origin sandbox** at **529**. `src/document-origin.ts:9–18` invokes another `withParserSandbox` for the **same bytes, same URL and classification context**, validating result URL/hash/classifier version. There is no origin cache here, including on 304.
7. For PDF MIME, **533** calls `inspectPdfTdmPolicy`. This may add a cold process **version probe** and/or **artifact metadata sandbox**; see below.
8. Policy/origin are projected and permission is checked (**547–563**). Excluded documents follow relinquishment/exclusion metadata, not raw retention (**551–558**). Admitted CAS bytes plus immutable observation are enrolled through `withManagedSourceWrite` (**566–572**). That contributes **one inventory load/save per successful representation**, separate from parser sandboxes. Successful robots and TDM representations have their own admission writes too; a cold HTML document with both policies present therefore has three such writes, in addition to its parser cycles.

404/410 standardized policy absence is evidence without representation inspection (`policy:331–332`, `machinePolicy:359`): **zero sandbox for that absent endpoint**. HTTP/auth/redirect/transport failure may stop before inspection. An interpretation or document refusal may stop after only a subset of the commands. No blanket four-sandbox count is correct for every document.

### Cache scope — precise answer

| Cache | Key/lifetime | Reused within fetcher/job? | Reused across fetchers in one process? | Across processes? |
|---|---|---|---|---|
| Robots result including pending/rejected promise | `this.robots`, **126**; **origin**, **322,342**; default TTL one hour (**136**) | Yes, until TTL. Repeated same-host requests with another scheme/port are different origins. | **No** | No |
| TDM rules/evidence including pending/rejected promise | `this.machinePolicies`, **127**; **required/standard + exact policy URL + applicable owner override ID**, **346–348,368** | Yes for the same cache key until TTL; each distinct registered policy URL adds a key. | **No** | No |
| Polite scheduling | module `sharedHostQueues:113`, on-disk host state/locks | Yes | Scheduling coordination only; **not a policy/classification cache** | On-disk pacing survives; not parsed-policy reuse |
| PDF tool version promise | module `versions`, `src/pdf-tdm-policy.ts:11,22–33`; **reviewed image ID + runner hash**; rejection evicted | Yes | **Yes**, for that image/contract. A cold probe still supplies the calling source context at **29**, so it enrolls a source-owned scope even with null artifact. | No |
| Successful PDF metadata finding | disk key **policy version + actual PDF.js version + reviewed image + contract + source SHA**, **36–49,73–76** | Yes | Yes, same cache root/key and live permission checks | Yes, but a new process first resolves its actual tool-version promise |
| Resource policy / document origin | None in these wrappers | No, re-inspected even on 304 | No | No |

Robots/TDM maps do **not** bypass objections: fetch checks live host policy before request/inspection/retention, and sandbox `assertActive` checks all actual contributor hosts. Their promise failures remain cached until expiry; they are not reattempted on every same-instance document. PDF caches only a checked result, never unavailable/transient permission (`pdf-tdm-policy.ts:73–76`).

**Job ownership matters:**

* The crawler creates one fetcher for the crawl (`src/district-crawl.ts:139`) and passes it through registry traversal (**42–44**). Reuse can span sources that share an origin during that instance's TTL.
* Council acquisition creates one fetcher per `createCouncilAcquisition` call (`src/council-cache.ts:53–56`), then reuses it through its loaders.
* **R1 `acquisitionHandler` constructs a fetcher inside each handler invocation** (`src/district-r1.ts:241–266`), and fetches one selected representation. Its earlier `initializeManagedAcquisitionLane:248` and the fetcher's `initialize:148` each additionally reconcile/save the lane. Today's handler therefore starts with cold robots/TDM maps on each acquisition job; process reuse alone does not fix this. Job-scoped `beforeRequest` captures `context`, request count, host-lane admission and cancellation (**251–264**), so sharing the whole fetcher across jobs without refactoring is unsafe.

### Counting formula and examples

For successful documents, define:

* `N`: document representations reaching both resource and origin inspection;
* `R`: successful robots representations inspected after cache misses/expiry;
* `T`: successful TDM representations inspected after misses/expiry, including distinct known-policy keys;
* `P`: PDF artifact inspections not served by checked-result cache;
* `V`: cold PDF tool-version probes, one per reviewed image/contract per process on successful resolution.

Then **`B = 2N + R + T + P + V` source-owned parser sandboxes**. A 304 still contributes its two document inspections; a cached PDF finding removes `P`, not origin/resource. Refusals or oversized/empty PDF inputs require branch-specific counts.

| Successful fetch case | Source-owned parser sandboxes |
|---|---:|
| HTML/JSON/text, warm same fetcher robots/TDM | 2 |
| HTML, new fetcher, robots and standardized TDM both return inspectable 200 representations | 4 |
| HTML, both standardized policy endpoints genuinely 404/410 | 2 |
| PDF with warm version, new checked-finding miss, warm fetcher policies | 3 |
| First PDF for image/contract in process, finding miss, cold successful robots/TDM | 6 = 2 document + 2 host-policy + 1 version + 1 PDF metadata |
| PDF checked-finding hit, version already known, warm fetcher policies | 2 |

Each additional successful known machine-policy key adds one on first retrieval, not one on every same-fetcher document. Origin expiry, process restarts and separate jobs repeat their applicable costs. Later document preparation, frontier parsing and derived artifact writes are **outside** these fetch-only counts.

### Batching that preserves scope and isolation

**Best candidate:** one `withParserSandbox(representation,...)` owns exactly the document's pre-admission bindings and executes resource inspection first, validates its result and early gates, then origin, then PDF version/metadata where required. The existing callback and `sandbox.run` protocol are sequential and have a single pending request (`src/district-parser-isolation.ts:240–265`); multiple tool commands are already supported. Extract result validation from the two wrappers without running original-byte parsers on the host. The mount remains one immutable selected artifact, classification remains classification, and each command gets the existing live active checks. No invented acquisition receipt or combined municipality scope is needed.

* HTML: **2 → 1** document sandboxes, saving one full cycle per document.
* New PDF metadata: **3 → 1** with warm version; a cold version can also be queried within that one reviewed container. Keep actual version/result validation and its 15-second ready-command deadline, not a guessed image-to-version mapping.
* Policy endpoints remain their own representations/scopes. Resource inspection and robots/TDM directive validation could share that endpoint's existing one container if validation is moved, but this **does not eliminate another sandbox today**.
* Never batch a policy endpoint's bytes and a document by mounting a larger host directory, never share a mutable long-lived container among different source scopes, and never drop any contributor from a genuinely derived bundle. README **128,138–142** and parser comment **125** require one selected read-only artifact/job. The existing authorization model supports genuinely bound multi-original bundles, not ad hoc host-wide pooling.
* Retain gate order: a resource access barrier/reservation failure must stop before downstream work; no eager all-findings run that continues processing rejected source. Keep per-command limits and the unchanged 180-second whole-container limit. One combined job has one whole-job deadline rather than the sum of several container budgets; review liveness for representative inputs, not a raised limit.
* The source-free tool-version design documented in README **142** cannot justify an ungoverned source-derived process pool. The current PDF version call explicitly carries a source scope; co-location can remove it without pretending it never did.

## 3. Production-sized synthetic fixture benchmark

### Method and provenance

Ran the explicitly requested fixture benchmark once, with six measured samples (three full, three reduced) after per-mode save warm-up. Command:

```sh
umask 022 && taskset -c 0-3 nice -n 10 \
  /home/max/.local/share/mise/installs/node/24.21.0/bin/node \
  --experimental-strip-types /tmp/r1-throughput-benchmark-20261013.mjs
```

Runtime **Node v24.21.0**; command wall time **46.06 s**. A realpath/mkdtemp realm under `/tmp/r1-throughput-fixture-*` was provisioned as `fixture:<UUID>` with the normal fixture authority API and three explicit fetch/prepared/artifact lanes. All inventory operations used that full pinned fixture authority and normal lock discipline; no default production policy API was invoked.

A disposable `/tmp` copy of the exact `civic-opt-out.ts` was instrumented, resolving its dependencies to the repository's existing modules. Instrumentation exposed only internal fixture helpers and added `performance.now()` timers around the original save/atomic operations. It did not alter the repository or replace validation/fsync. Lock wait/acquisition and their preflight are excluded from stage totals; each sample executes under the real `locked()` boundary. The save cache is warm for measured loads. No Docker daemon/mock daemon or source command was executed.

Generation reused the approach in `reports/inventory-validated-bytes-benchmark.json:5–20` and `test/civic-opt-out.test.ts:18–38`: real SHA-256 synthetic identities, `makeEntry` for typed entries, UUID authority and canonical v1 JSON. Counts and sizes:

| Fixture property | Value |
|---|---:|
| Entries | 145,743 |
| HTTP observation / prepared / retained-publication distribution | 58,298 / 58,297 / 29,148 |
| Terminal scratch leases | 616, all `closed` |
| Original scratch bindings | 158,000, synthetically generated prepared-source proofs |
| Full canonical bytes, including trailing newline | **224,981,962** (224.982 decimal MB) |
| Serialized scratch array | **93,000,000** bytes |
| Reduced canonical bytes, same entries/roots, empty scratch array | **131,981,964** |

Production's counts/93 MB split are supplied context, not read from production here. Synthetic kind distribution is not a claim about production. To fit both byte targets without unknown schema fields, generated retained-publication member locators were lengthened within their existing bound, their entry IDs recomputed, and scratch observation IDs/host strings lengthened within the closed shapes. Source bodies were not loaded or retained. This measures codec/string/file cost for a matched-size synthetic shape, not authentic publication or source receipt admission.

Both fixtures passed the **actual full save codec** and canonical publication. Warm loads follow those canonical saves. No cold-load structural benchmark, uninstrumented independent total, archive verifier or compatibility execution was run here. The earlier 115.94 MB benchmark does measure cold validation separately; this report does not extrapolate its cold number as production timing.

Cleanup was executed by the benchmark's `finally`; output confirmed **“removed disposable fixture realm and benchmark script”**. No fixture directories or helper scripts were intentionally retained.

### Measured results

Milliseconds; median of three samples. Independent stage medians need not sum to the median total. **Atomic is a parent total** containing temporary publication, prior safe read, rename and fsync; its subset rows must not be added again.

| Stage | Full 224.982 MB | Reduced 131.982 MB | Full-share / interpretation |
|---|---:|---:|---|
| Warm `loadInventory`, total | **1,311.891** | **819.303** | Safe read + SHA + fresh parse + marker check |
| `saveInventory`, total | **4,341.730** | **2,578.356** | **1,763.374 ms less/save (40.61%)** |
| Full strict schema parse | 1,821.445 | 1,027.243 | 41.95% of full save |
| Single stringify | 855.769 | 504.480 | 19.71% |
| Serialized byte-length cap | 78.295 | 47.244 | 1.80% |
| Atomic replacement, total | 1,117.654 | 744.400 | 25.74%; includes subsets below |
| ↳ temporary-file write | 646.479 | 430.723 | Includes conversion/write, not just physical device bandwidth |
| ↳ file fsync | 98.014 | 65.694 | 2.26% of full save |
| ↳ old inventory safe full read | 285.497 | 175.110 | Redundant bytes with respect to a prior load, but current safety contract remains |
| ↳ rename | 42.466 | 45.352 | Not a stable size-proportional gain |
| ↳ directory fsync | 9.905 | 2.601 | 0.23% of full save |
| Canonical save-cache SHA (string + newline) | 450.835 | 269.274 | 10.38%; includes string processing/encoding |

Raw sample receipt summary, also in milliseconds:

| Mode/sample | Warm load | Save total | Schema | Stringify | Byte cap | Atomic | Cache SHA | Write | File fsync | Prior safe read | Rename | Dir fsync |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| full/0 | 1491.519 | 4288.630 | 1786.334 | 846.328 | 78.160 | 1126.857 | 450.835 | 646.442 | 87.915 | 346.118 | 42.466 | 2.185 |
| full/1 | 1284.605 | 4376.290 | 1886.869 | 864.718 | 78.295 | 1089.408 | 456.956 | 646.479 | 101.798 | 285.497 | 44.166 | 9.905 |
| full/2 | 1311.891 | 4341.730 | 1821.445 | 855.769 | 96.744 | 1117.654 | 450.077 | 714.229 | 98.014 | 252.272 | 41.296 | 10.305 |
| reduced/0 | 844.216 | 2563.038 | 1027.243 | 479.670 | 47.244 | 744.400 | 264.412 | 430.723 | 54.651 | 224.918 | 23.525 | 1.954 |
| reduced/1 | 786.190 | 2578.356 | 1018.984 | 510.982 | 68.639 | 710.368 | 269.274 | 410.006 | 65.694 | 175.110 | 47.387 | 2.601 |
| reduced/2 | 819.303 | 2707.106 | 1123.430 | 504.480 | 46.766 | 760.634 | 271.747 | 458.808 | 72.359 | 160.537 | 45.352 | 11.058 |

### What these numbers support

For the intended nine-save/eight-load cycle, `[INFERENCE]`:

```text
C_full    = 8 × 1.311891 + 9 × 4.341730 + 1.0 = 50.570696 s
C_reduced = 8 × 0.819303 + 9 × 2.578356 + 1.0 = 30.759628 s
saving if terminal scratch entirely leaves hot inventory = 19.811068 s/cycle
one eliminated load/save pair = 5.653621 s/cycle
```

The 1 s term is the supplied Docker/command estimate, not measured here. The reduced-cycle gain is about **39.17% of the modeled full cycle**, before archive lookup/commit overhead. A v1-compatible compact terminal stub retaining some metadata would obtain **less** than this empty-array bound.

Deleting fsync would save only about **0.97 s across nine saves** on this fixture and violate durable publication: reject. Skipping the full codec would remove approximately **16.39 s of schema work across nine saves**, but violates README **211** and is not an authorized optimization. Reusing the previous safe-read bytes or a single exact canonical UTF-8 buffer could target some of the roughly **6.63 s/cycle** represented by old-file reads plus cache SHA; that is an **upper target, not measured attainable gain**, and must preserve all file identity/authority checks and avoid excessive extra memory. It is less valuable than eliminating complete cycles.

## 4. Closed-lease compaction and cross-lane compatibility

### Who reads terminal scratch records today?

| Consumer | Current behavior and why history matters |
|---|---|
| Inventory load/save | Full scratch codec (**59–66**) runs on cold loads/saves; structural load checks root/UUID/directory/contributor host/purpose/resource binding (**468–471**). Terminal records inflate all hot serializations even though their work has ended. |
| Root reconciliation | Matches every actual `scratch/<uuid>` directory to its lease (**537–544**). A closed/purged directory unexpectedly present makes ordinary reconciliation incomplete; retirement permits it only after inspecting an empty safe tree. Archive removal must not silently make restored leftovers trusted or sweep them. |
| Host purge | Reconciles every root, then scans source hosts but cleans **only nonclosed/nonpurged leases** (**1175–1186**, especially **1183**). Full source lists in terminal leases are not currently needed to select live purge work. Actual entry tombstones and `hosts/` objections remain separately essential. |
| Recovery | Skips closed/purged leases (**1042–1044**), cleans active/planned/partial ones and reconciles roots (**1046**). A terminal lease is not re-opened solely because its archive exists. |
| Root retirement | Collects all root leases, refuses any nonterminal lease (**1061–1062**), and includes terminal leases in `removedScratchLeases` before removing that root's entire inventory (**1104–1105**). Removing records changes receipt counts unless terminal-history ownership is explicitly included. |
| Audit/forensics | `cleanScratch` records **path hash, content hash, byte count** of removed files (**838**), plus complete source proof/lease identity/resources/groups. Closed-lease evidence is retained in inventory; README **203** and test **66–75,532–544** establish content-free audit and ownership, not an automatic expiry permission. Recovery/purge/retirement attempt files contain receipts/counts, **not a replacement for all lease source arrays and tombstones**. |
| Active callbacks | `persist:939–941` resolves a lease by UUID; async removal callbacks can survive into close. A compactor must exclude unsettled callbacks/operations, not just observe a string state and race their final updates. |

Global source search found direct inventory/scratch consumers concentrated in `civic-opt-out.ts`, with tests inspecting its output; no existing archive reader/manifest/hash-chain implementation was found. This is not a claim about external operator tooling, which was not inspected.

**Never confuse scratch history with entry tombstones.** `src/civic-opt-out.ts:699–701` retains contributor hosts on deleted entry references and enforces objections before omitted-ancestor reads. Those entries cannot be dropped merely because bytes are gone. The safe archive candidate is fully settled terminal scratch leases, not active source entries, objections, pending daemon resources or arbitrary root inventories.

### Could a hash-chained archive preserve the guarantees?

**Yes in principle, with coordinated readers/writers and an explicit audit contract; not by simply deleting 93 MB.** `[INFERENCE]` A viable design must:

1. Select only durable terminal records with settled groups, proven removed daemon resources, absent owned tree, and no in-flight callback capable of updating them. Never archive `planned`, `active`, `closing`, `partial`, `uncertain`, or unknown ownership as terminal.
2. Copy each **complete immutable original lease** into bounded append-only segments, with authority ID/hash, inventory epoch, root ID, lease UUID, ordered source proofs/resources/tombstones, canonical record bytes, sequence, previous-record/segment hash and record hash. No raw source body or manufactured receipt.
3. Fsync archive bytes and publish/fsync the committed segment/head **before** atomically removing hot records. Crash between archive publication and inventory replacement leaves duplicates; recovery must deduplicate by epoch/lease ID and exact record hash, not lose records or double count retirement receipts.
4. Bind the archive's expected head/count to a trusted committed checkpoint. A hash chain alone does **not** prevent truncation, whole-chain substitution, rollback or a rewritten history by an actor able to replace both chain and head. The checkpoint also needs the current authority and safe-file/ownership discipline.
5. Validate bounded segments lazily for audit/retirement rather than concatenating all archived records into every hot load; otherwise the cost is merely relocated. Preserve explicit root-to-archive ownership and historical retirement counts. Missing/corrupt/foreign archive needed for those claims must fail closed, never yield a fake complete audit/retirement.
6. Keep live host objections and source-entry checks exactly where they are. Restored scratch directories still produce a hold/incomplete state; an archive is not blanket permission to erase newly present files.
7. Coordinate all authority users and delayed writers. Preserve the shared `inventory.lock` discipline; no stale materialized view may let an old process create/start/write source content that is present only in a journal the old process cannot read.

This adds a second custody store and atomic cutover protocol. Its recovery/audit implementation burden exceeds a small parser batching change.

### 0.3.2 constraints

Local tag **0.3.2** uses strict v1 inventory and strict scratch objects (`0.3.2:src/civic-opt-out.ts:62–69`); `sources` remains **min(1)** and `resources` defaults to `[]`. Its loader at **455 onward** validates the whole inventory and root/resource bindings. Current R1 retains v1 JSON (`src/civic-opt-out.ts:59–66`; README **211**). Therefore:

* Adding `archiveHead`, `archiveRef` or a new discriminant to the strict inventory/lease objects, emitting source-empty closed stubs, changing `schemaVersion`, or replacing the JSON file with a journal is **not readable by unmodified 0.3.2**.
* Removing whole terminal records while leaving valid v1 roots/entries/scratch is **syntactically readable by 0.3.2**, but that alone does not preserve its audit/retirement history and special closed-directory ownership handling. Its subsequent saves cannot persist new unknown checkpoint fields and it cannot validate/use a sidecar archive. Readability is necessary, not sufficient.
* A compact closed stub containing one genuine original binding and the original lease identity/resource/tombstone information can fit the old codec, but **silently truncates the recorded contributor set** unless full history and external checkpoint semantics are explicitly coordinated. Do not invent a synthetic “archive” source or relabel original provenance to make it fit. Such stubs are only a reviewed compatibility strategy, not an already safe proposal.
* An append-only archive kept entirely in a sidecar while every full original lease remains in inventory has no hot-size benefit. It may provide a migration checkpoint, not throughput relief.
* A live WAL/delta store that old 0.3.2 ignores can expose a stale source-ownership view. **Uncoordinated cutover is rejected**. Either retain the exact readable authoritative materialization for every old participant, or pause/drain all old writers and deploy coordinated readers/writers before changing the authoritative format.
* Cross-lane resource compatibility already has a separate constraint: 0.3.2 imports only `DockerParserResourceSchema`, whereas R1 accepts `ManagedDockerResourceSchema` and `omp-b` records (`src/civic-docker.ts:18 onward`). Do not claim that every new R1 resource variant is readable by the old parser-only codec merely because the top-level version is still 1. This analysis did not run old code against a real shared inventory or activate assessor B; any archive rollout must inventory the actual participating code/resource variants with Main.

## 5. Nine-town scenarios and ranked options

### Transparent model, not crawl permission

Let `D` count successful document representations **including the root** per one of the 37 follow-linked scopes, while the four non-following roots contribute one each:

```text
N = 37D + 4
H = 22 root origins
B_crawler_html = 2N + 2H = 2N + 44
B_fresh_job_html = 4N
```

`[INFERENCE]` Assumes one TTL window, all robots and standardized TDM endpoints successfully return inspectable representations, no extra known-policy keys, no redirected new origins, and no PDFs for this HTML comparison. Actual 404/410 policy absence reduces it; PDFs, expiry, additional endpoints, repeats and later preparation increase it. Some registered discovery-only sources may never fetch an admissible root; this is a computational scenario, **not a promise of source access or completed coverage**. The shared service group serializes actual R1 admission (`district-r1.ts:255–264`); neither more parser workers nor 22 origins means 22 independent acquisition lanes.

| Scenario | N | Long-lived crawler B | Crawler parser budget at 55 s | Fresh R1 jobs B | Fresh-job parser budget at 55 s |
|---|---:|---:|---:|---:|---:|
| Roots only, D=1 | 41 | 126 | 1.93 h | 164 | 2.51 h |
| D=10 | 374 | 792 | 12.10 h | 1,496 | 22.86 h |
| D=50 | 1,854 | 3,752 | 57.32 h | 7,416 | 113.30 h |

These are **parser-only**, excluding HTTP pacing, managed admission writes, repeated root reconciliation, durable job/CAS writes, extraction, models, assessment and publication. They do not restate a “roots only = 37 min” estimate: even warm HTML requires two document inspections; cold policies can add two more. If one uses the older uniform hypothetical `N=41D`, the familiar fresh-job D=10/50 budgets are 25.06/125.28 h, but that implicitly expands the four non-following registrations too.

### Ranked options table

All gains are `[INFERENCE]` except measured fixture phase differences. Nine-town column gives **D=10** (374 documents), followed by **D=50** (1,854); `crawler / fresh` denotes the two current cache ownership models. **Do not sum rows indiscriminately**: batching, caching, reduced inventory and transaction elimination overlap.

| Rank / change | Guarantee impact | Expected per-sandbox or document gain | Nine-town parser gain, D=10; D=50 | Risk | Effort |
|---|---|---|---|---|---|
| **1. Same-source resource + origin, optionally PDF, one container** | **None**, conditional on same complete source bindings, unchanged result validation/gate order/deadlines/isolation | HTML saves **one cycle ≈55 s/document**; new PDF metadata saves **two cycles ≈110 s/PDF**, plus a cold version cycle if integrated | HTML: **5.71 h; 28.33 h**, in either cache model. Add **55 s for each PDF artifact inspection eliminated beyond HTML**, and each eliminated cold version cycle. | Modest host API/result refactor; cumulative job deadline and cache-hit handling need review. No source pooling. | Medium; wrappers and fetch callsite, exact protocol/security fixtures |
| **2. Coalesce lane reconciliation + planned lease** | **None**, if checks and changed/incomplete-root persistence retained | Removes one load/save pair: **5.65 fixture s**, **≈6 planning s/sandbox** | **1.32 / 2.49 h; 6.25 / 12.36 h** | Accidental cached-marker shortcut or nested lock deadlock; preserve failed reconciliation semantics | Small–medium canonical lifecycle refactor |
| **3. Coalesce successful removal + final close** | **None**, if known CID retained, removal proved before unlink, failed removal remains durable partial | Same **≈6 s/sandbox**; can also prevent the extra abort-triggered success persistence where present, not included in base gain | **1.32 / 2.49 h; 6.25 / 12.36 h**; extra callback saving unquantified | Must await/drain ownership callbacks, not merely omit `remove`; failure path cannot lose resource | Medium lifecycle change with crash windows |
| **4. Reuse validated robots/TDM cache across R1 jobs in a worker/permission context** | **Needs review**: cache semantics already exist per instance, but job accounting/context does not | No change to one cycle; removes up to **two policy cycles ≈110 s** on later same-origin jobs within TTL | Fresh → long-lived model: **10.76 h; 55.98 h** at current 55 s, before batching; gain for existing long-lived crawler **0** | Reusing old `beforeRequest`/signal/source scope; stale permissions; concurrent promise custody and TTL; host-group accounting | Medium–large explicit cache/context separation; no global mutable fetcher shortcut |
| **5. Archive fully settled terminal scratch, coordinated custody/audit cutover** | **Needs review**; format-compatible removal is not complete semantic compatibility | Empty-array cost bound: **19.81 fixture s/sandbox**, or 39.17% modeled cycle; actual stubs/archive overhead reduce this | Cost-bound **4.36 / 8.23 h; 20.65 / 40.81 h** | Two-store crash consistency, history loss/truncation, old writers, restored directories, cross-lane resource codecs | Large; archive reader/checkpoint/recovery/retirement/operator migration |
| **6. CID + start-intent commit for immediate-start parser only** | **Needs review**, preserves pre-start identity but changes recovery windows/API | At most another **≈6 s/sandbox** on eligible immediate-start paths | Upper eligible bound **1.32 / 2.49 h; 6.25 / 12.36 h** | Known versus unknown CID absence recovery; create-without-start callers | Medium; explicit immediate-start API and caller migration |
| **7. Reserve + create-intent in one commit** | **Needs review**, never-requested-create recovery becomes conservatively pending | At most another **≈6 s/sandbox** | Same upper bound as rank 6 | Cannot leave `reserved` while create is in flight; unknown late create test must still hold | Medium state-machine review; lower priority than same-source batching |
| **8. Exact UTF-8 save buffer / avoid repeated old-file bytes with equivalent safe replacement proof** | **Needs review**; keep full codec, identity/bounds/authority and durable write semantics | Target **0–6.63 fixture s/sandbox** for old-file read + cache-SHA phases combined; not measured attainable. A buffer can share encoding, not delete SHA work. | Upper target **0–1.46 / 2.75 h; 0–6.91 / 13.65 h** | Peak memory/string cap, unsafe inode replacement, allocation/GC tradeoffs; a bare stat/mtime cache is not equivalent | Medium; narrowly benchmark and preserve safe-file contract |
| **Reject: drop active/planned/process/create barriers, skip full save codec, remove fsync, host-wide source container pool, uncoordinated live WAL** | **Weakens → reject** | Attractive theoretical gains do not justify broken custody. Skipping schema alone ≈16.39 fixture s/cycle; removing both fsyncs ≈0.97 s/cycle | Not an eligible gain | Unknown late create, unowned content, missed objection, corrupt/torn authority, cross-source contamination | Not applicable |

### Recommendation in operational terms

Prioritize **rank 1 + ranks 2/3**, preserving v1 serialization and all existing full validation. At the supplied planning cost, the two safe transaction reductions alone take a normal cycle from **55 → approximately 43 s**. For warm HTML, same-source batching then takes document classification from **2×55 =110 s → approximately 43 s**, saving **67 s/document**; host-policy cycles also become cheaper. `[INFERENCE]` For a D=10 long-lived crawler, this combination changes `(2N+44)×55` to `(N+44)×43`, about **12.10 → 4.99 parser-hours**, a **7.11 h** reduction before other work. For fresh jobs without shared policy caches it changes `4N×55` to `3N×43`, about **22.86 → 13.40 h**, a **9.45 h** reduction. These are modeled normal paths, not measured post-implementation results.

Do not rely on inventory compaction or worker concurrency to make tomorrow's pass honest. A bounded first acquisition remains bounded and access-dependent. The next large gain for per-representation R1 jobs is policy-cache context separation, while closed-lease archival is a coordinated durability/audit project. None of these conclusions authorizes source collection, model execution, deployment or altered operator approvals.

## 6. Verification hand-off / remaining interfaces

Only synthetic codec/load/save benchmarking was exercised. Main should select/review an implementation before running its verification once. Relevant existing coverage to retain:

* `test/civic-opt-out.test.ts`: pre-byte active lease, process gate, interrupted scratch recovery, concurrent initialization/completeness, canonical-byte tampering/defaults and full save cap;
* `test/civic-docker.test.ts`: durable create intent/CID before effects, late create, exact daemon/nonce/config, removal-before-unlink and unknown removal;
* `test/civic-opt-out-docker.test.ts`: parser/omp-b resource separation, interrupted removal and objection/recovery;
* `test/polite-fetch.test.ts`, `test/document-origin.test.ts`, `test/pdf-tdm-policy.test.ts`: gate ordering, 304 preserved findings, nonofficial restriction, cache identities and runtime failures rather than fabricated policy absence;
* opt-in reviewed-image source custody/isolation fixtures for any parser execution-contract change, after the appropriate review authorization—not as a benchmark run here.

New implementation acceptance should exercise crashes between every merged boundary, objection arrival during each command, cancellation during removal, no false complete purge with late create, and exact source/result identity through a combined callback. Archive acceptance additionally needs head truncation/substitution, duplicate segment after crash, retirement counts, restored directories, stale participants and a coordinated **0.3.2 reader/writer compatibility decision**.

Remaining cross-slice interfaces are: Main's choice of long-lived crawler versus current one-representation R1 jobs; parser wrapper/API ownership; canonical scratch/Docker lifecycle ownership; shared-policy/host-lane request accounting; and authority steward approval for any archive or deployed-code cutover. No code/interface migration was made in this analysis.
