# R1 step 8: governed candidate and exact replay

This is the executable operator procedure for step 8, not a change to the frozen
`CIVIC_PIPELINE_REBUILD.md` plan or permission to deploy. The owner option-B gates
still require step 9's frozen value test before hosted release.

## One command

From `stadtstack-data`, with Node 24.21.0 selected:

```sh
DATABASE_URL='postgresql://max@/civic_r1?host=/var/run/postgresql' \
  ./scripts/r1-step8.sh plan /absolute/path/step8-input.json INPUT_SHA256

# Only in an explicitly authorized execution realm, after the full seal set exists:
DATABASE_URL='postgresql://OPERATOR@/ISOLATED_DATABASE?host=/absolute/socket-directory' \
  ./scripts/r1-step8.sh execute /absolute/path/step8-input.json INPUT_SHA256
```

The input hash is independently pinned by the operator; it is not read from a
neighboring mutable checksum file. Every path in the input must be absolute.
`plan` only reads that input file and prints the complete declared read set and
would-write destinations. It never calls a managed reader, takes an authority
lock, exports a receipt, or connects to PostgreSQL. It is not a readiness audit.
`audit` validates the selected generation without writes; see below.
`execute` has real managed CAS/authority/audit writes: **do not run it against production as a dry run**.
The implementation exercise uses only a disposable PG database and isolated
fixture authority. Production processing and historical `out/` and `release/`
are not modified by this work.

The wrapper strips the environment (including provider tokens, proxies and
`NODE_OPTIONS`), and preloads `r1-step8-offline.cjs` before application imports.
The guard denies HTTP/fetch, DNS, UDP, HTTP/2, TLS/TCP and arbitrary child processes/model
CLIs. Only Unix-domain sockets (the same-host PG audit connection), the fixed
offline reconstruction child over inherited IPC, the predecessor reader's bounded
`git --no-replace-objects show COMMIT:./out|release/MEMBER`, and Core's exact
`/usr/bin/flock --exclusive --nonblock 3` inherited-fd recovery mutex are permitted.
The latter requires a zero-byte, private, owned, unaliased `inventory.break.lock`
descriptor; no flock command-execution form or arbitrary spawn is allowed.
The child cannot choose a preload, runtime, provider process or cache file. Git
lazy fetch and prompts are disabled by the predecessor reader.
This is an enforced Node transport/process guard for trusted replay,
**not a claim of OS/network-namespace isolation**. There is no cache-miss model,
readiness, acquisition or live fallback. The replay proof retains its existing
honest `networkIsolation` wording; the wrapper's guard is tested separately.

### One canonical pass and bounded reconstruction

`execute` creates one opaque in-process canonical context. Its actual Core
`buildQueueTextRun` results are reused by the embedded generation audit, source
authentication, witnessed-union derivation, read-only staging preparation and
text export. The standalone exporter is not invoked again. No operator-authored
“passed” cache or persisted result can replace this context.

`reconstructionWorkers` defaults to **3** and accepts only **1–3**. Before startup,
Linux `MemAvailable` must be at least `workers × 1.5 GiB + 4 GiB`: respectively
5.5, 7 or 8.5 GiB. This uses available memory, not `MemFree`. Each worker owns a
real independent same-host PG pool and checked-out client, with a server-checked
repeatable-read **READ ONLY** transaction for each source. Worker results arrive
only through parent-created IPC; all workers must share the authority/inventory/
objection epoch. The parent joins the entire batch, restores issued frame order,
and checks one common current receipt/spec set. Any worker or epoch failure
rejects the whole batch. Child PIDs preserve Core's existing lock-owner safety.
Each child keeps a small supervisor event loop separate from its CPU-bound Core
thread, plus one scalar-configured read-only PG liveness connection. IPC parent
loss/stop, SIGTERM/SIGINT, connection loss or a failed one-second heartbeat
(two-second connection/query bounds) exits the **whole child PID**. A busy Core
thread cannot hide those signals. Only killing a thread while its PID stays alive
would strand a live-owner lock, so that is never the shutdown mechanism.

The issued frame and catalogue are runtime inputs, not compiled campaign-window
hashes. A later re-issued final27 selection with genuine re-sealed sources uses
the same path; omitted import holds still fail the unchanged exact-membership
gate and must be resolved through their separately governed disposition.

`reconstructionTiming` is a strict optional object containing positive integer
`estimatedDurationSeconds` (1–604800) and `expiryMarginSeconds` (60–86400).
Its defaults are **43200 + 3600 seconds** (12 hours plus one hour). These are
conservative planning inputs, **not a measured ETA**. Before starting any
canonical builder or worker, the context authenticates the selected run's exact
policy proofs and sealed continuation mapping. Every current proof must remain
valid strictly beyond the current time plus estimate plus margin. An insufficient
horizon fails before expensive reconstruction and requires genuine renewal,
re-sealing and a newly issued exact selection; shortening a clock or silently
substituting unsealed proofs is not a continuation mechanism.

Reusing immutable reconstruction is not reusing permission. Source policy
clocks, actual current proofs, issuance expiry, operator control pins, allowance
accounting, native B purge lease state, selected current attempts, authority and
inventory/objection epochs are rechecked. The source epoch must finish
successfully, including segment/root validation, **before the first managed
candidate/staging write**. Staging commit then authenticates current rights and
bytes again through unchanged Core.

Staging copies the campaign to its managed control root. Before persisting the
generation audit, execute relocates its campaign pin using only the unchanged
trusted in-process staging audit after successful source-epoch finish. Core
authenticates the committed copy; its bytes must equal the audited snapshot.
The persisted `stadtstack-r1-step8-campaign-relocation-v1` binding records the old
pin, new pin and identical SHA256. The exception loader still requires exact
audit/gate/inventory campaign-pin equality; staged gates additionally require a
valid relocation binding targeting that exact campaign. Relocation changes no
campaign membership, generation, policy verdict or audit status.

Publication custody is producer-scoped, not the Cartesian product of every
retained row and every newly generated artifact:

- Text/native aggregates use their authenticated canonical source producer
  closures; structured exports use their authenticated committed HTTP producers.
  Each exported native receipt selects only its own committed input HTTP proofs.
- Retained staging inputs keep their complete exact original binding sets.
  Published city members use that city's signals/feed producers, core members use
  the retained core/corpus producers, regional members retain their regional
  inputs, and whole-release summaries retain the complete publication group.
- Native dependency controls reference authenticated staging hashes, not copied
  retained city record values. Those bytes remain separately and completely
  pinned with their retained bindings; a control reference is not collection or
  independent publication authority.
- Two disjoint inventories contain every direct publication/replay input and
  every artifact referenced by each native text contribution (including optional
  preparation plans). The primary inventory contains native/control inputs;
  the staging inventory contains the exact retained members. Independent
  audit/exception/handoff artifacts remain separate. Hash-addressed policy,
  assessment and structured dependencies still undergo their existing Core CAS
  and committed-receipt checks.

Neither the16MiB provenance guard nor any exact binding-set check is relaxed.
In particular, canonical seal authentication and the complete witnessed union
for shared empty critical artifacts are unchanged; projection happens only after
those proofs pass. Omitting a required producer binding still yields Core's
`CONTENT_PROVENANCE_MISMATCH`, rather than authorizing a smaller declared set.

The publisher's prepared source scope is closed before outer candidate
persistence. Its public members are snapshotted in memory after every manifest
member's size/SHA is verified (the measured real19 fixture has55,073,022
manifest-member bytes, plus its manifest/README). No private scope capability
escapes. Final members are persisted using Core's existing
multi-entry write transaction and one registered source scratch. Every target
has its own producer entries; the scratch's union is not applied as each file's
custody. Enrollment precedes temporary bytes, the generation claim is checked
throughout, Core checks current opt-outs/authority on both sides of writes, and
the normal exact replay plus candidate loader still precede the passed gate.
This avoids repeatedly loading/saving the entire authority inventory for every
member without introducing a second inventory writer or relaxing Core checks.

Historical, pre-partition real19 fixture measurement: one-source provenance was
8,582,540bytes with34inputs and12,517retained bindings. Its old27-source scaling
model was not a production gate and must not authorize the renewed campaign.
The actual27-source native corpus metadata alone exceeded16MiB before family
normalization; even normalized fixed publication inputs left insufficient
headroom for the generated aggregates. The governed cutover therefore partitions
metadata, not evidence, and computes the current input's complete bounds below.

### Automatic static pre-pass and two-inventory publication

Both `audit` and `execute` run `requireStep8Preflight` **before** constructing the
expensive canonical context. `scripts/r1-step8-precheck.mjs` performs the same
read-only refusal pass independently:

```sh
node --experimental-strip-types --require ./scripts/r1-step8-offline.cjs \
  ./scripts/r1-step8-precheck.mjs /absolute/input.json ACTUAL_INPUT_SHA256
```

It inspects the exact campaign/catalogue/review/seal controls, all native and
staging input metadata, current managed binding sets, authentic retained member
bytes, issued structured selection and committed receipts, and the pinned policy
proofs through the estimated pass end plus margin. Reads are fenced by the
existing lock-free authority/inventory/segment/objection epoch; no authority
locks, reconstruction, provider, network, CAS write or metadata export occurs.
A blocked report cannot authorize execution.

Registry families may be reduced only by unchanged Core's existing rule:
same configuration SHA and identical complete endpoint-digest set. Select the
lexically smallest complete descriptor deterministically; keep every
non-equivalent family and **all** non-registry/HTTP bindings. Each resulting
inventory is authenticated independently by unchanged Core. No native seal,
existing CAS blob,16MiB guard, codec or witnessed shared-content union is changed.
Original campaign corpus paths remain valid: provide a separately reviewed
control-only inventory for those actual paths, rather than substituting CAS paths
or uniting all native inventories into an unrelated staging artifact. The
optional `--emit-control-inventory` emits an unissued private metadata proposal
only; it never grants rights, writes authority or repairs a missing declared
binding.

The preparation/commit and publication/replay partitions are disjoint and
exhaustive. Missing input, duplicate/overlapping input, conflicting bytes or
missing required binding refuses. Exact fixed metadata and retained19-member
wire sizes are computed before the pass. All nine generated publication rows
have conservative bounds from their actual producer sets and output paths,
64-character SHA width and the existing512MiB artifact-length cap. **Each**
inventory must remain strictly below16MiB minus a1MiB safety margin. Execute
checks actual publication sizes against that independent bound again.

Replay receipts pin `privateProvenance`, `stagingProvenance` and the complete
`provenanceInputs` set. Proof/audit pins cover both inventories; replay
authenticates both again and compares every release member and the manifest
byte-for-byte. The private step9 handoff adds
`provenanceInventories: {primary, staging}`; the exception/acceptance loader checks
these against the receipt and exact replay proof. Ops must retain both private
metadata files with the bundle. Public release members, manifest format,
candidate serving loader and hosted MCP query interfaces are unchanged.
Standalone publisher callers must now supply both
`--private-provenance`/`--private-provenance-sha256` and
`--staging-provenance`/`--staging-provenance-sha256`. Standalone knowledge
preparation without external staging still uses its genuine primary inventory.

Runtime and processing identities are separate: the reviewed operator HEAD may
advance beyond `5a9a14c105195043fda1c4f9aa8b9f6697e33c3d`, while the input's
`currentGeneration.processingCommit`, catalogue and confirmed processing review
stay at that campaign pin. `assertStep8ProcessingPin` checks those authenticated
controls, not equality with runtime HEAD. All14 processing contracts and the
sealed extraction archive's source/cache-context files must remain byte-identical.
The receipt pins the actual new runtime sources separately. Keep that reviewed
runtime HEAD frozen throughout precheck/build/replay; never relabel the campaign
processing commit to the operator commit.

`audit` remains a standalone validating operation with its own canonical pass.
Do **not** run it separately before a governed `execute` just to repeat the same
expensive work: execute embeds it. `plan` remains the cheap, non-authorizing dry run.


## Complete input contract

`src/r1-step8.ts` exports strict `Step8OperatorInputSchema` (the ready-component
`Step8InputSchema` or an assembly invocation). Its version remains
`stadtstack-r1-step8-v1`; unknown/mixed fields fail closed. Common required fields:

- `expectedSources`: **27** and `expectedDocuments`: **208** for this production
  campaign. The command rejects an incomplete count or duplicate extraction
  jobs; the isolated synthetic fixture declares its own 1-source/1-document scope.
- `nativeSealSelection`: the independently pinned **issued lead-action record**,
  not its bare strict frame. It selects the exact ordered 27 published seals and
  the same current catalogue; see “Witnessed shared-content provenance supplements”.
- `reconstructionWorkers` is optional, defaults to **3**, and is bounded **1–3**.
  Use 1 for constrained hosts and isolated fixtures with in-process seams.
- `currentGeneration`: pins the active catalogue and its immutable processing
  approval, independently of the runtime HEAD used for publication/replay.
  Follow `catalogue.processingPinReview.path` (relative to the catalogue when
  relative), verify its `sha256`, and require that review's `activation` is
  `confirmed`. Populate the production profile from those exact pinned bytes:

  | Input field | Value from the active confirmed processing review |
  | --- | --- |
  | `processingCommit` | `to.commit` (full 40-character Git identity) |
  | `catalogue` | Independently pinned active driver catalogue path and digest |
  | `processingReview` | The catalogue-pointed review's absolute path and digest |
  | `assessmentQueueContractSha256` | `contracts.current.assessmentQueue` |
  | `B.jobContractSha256` | `contracts.assessmentBJobContract` |
  | `B.runnerContractSha256` | `contracts.ompRunnerContract` |
  | `B.runnerOutputContractSha256` | `contracts.ompRunnerOutputContract` |

  The remaining semantic fields are `projectionVersion: "assessment-source-record-v2"`,
  `B.receiptVersion: "assessment-receipt-v2"`, `B.selector: "anthropic/claude-sonnet-5-5"`,
  `B.transport: "vm-omp"`, `B.nativeStreamVersion: "omp-native-stream-v2"` and
  `B.thinking: "medium"`. The stream version is bound to the runner's exported
  `OMP_NATIVE_STREAM_VERSION`, not guessed from a receipt version.

  No processing commit, B contract or review digest is compiled into step 8.
  A reviewed processing-window cutover requires a freshly independently pinned
  input, not another code edit. The audit verifies the catalogue's review path
  **and** digest, confirmed commit, queue contract, B job contract, runner contract
  and output contract. Every admitting B step must match that exact job/selector/
  runner identity and explicitly attest the required stream version and medium
  thinking; missing/legacy stream markers and fenced-output normalization fail.
  Do not compute replacement worker hashes from publication/replay HEAD or repin
  sealed campaign generations to accommodate an operator code change. All 14
  processing contracts must remain byte-identical to the active processing pin.

  The production catalogue still has exactly 27 source scopes and 208 original
  document memberships. The isolated fixture instead supplies synthetic control
  records bound to its actual worker contracts and explicitly isolated authority;
  those records are not production approvals.
- `seals`: in explicitly approved source/run order. Each element contains
  `sealResult: {path, sha256}`, `jobKeys` (extraction keys), and
  `reconciliationJobKeys` from that source's completed seal inputs/results.
  The result must contain the real composition hash and pinned private
  provenance, policy inventory and critical inventory emitted by
  `seal-text-contribution`. No aggregate rows, invented lineage or substituted
  model receipts are accepted. The declared reconciliation set is checked
  against the extraction-run queue closure.
- Optional `importDispositionDecision: {path, sha256}` pins an **issued owner**
  import-rejection decision. Omission enables no importer exceptions. An unissued
  draft, expired/future record, changed reason or changed evidence is refused.
  This pin is common to ready and staging-assembly invocations.
- `structuredRunIds`: the exact ordered parser/discovery run IDs in the issued
  `structuredSelection` control. An acquisition run is never a structured export.
  The runs are exported together, not merged by title or relabeled as text-model work.
- `structuredSelection: {path, sha256}` is optional only for the explicit isolated
  fixture realm; production requires an independently pinned issued
  `stadtstack-r1-step8-structured-selection-v1` record. It pins every selected
  parser receipt, its source/municipality, the issued renewal action and the genuine
  renewed owner decision. No compiled historical run-ID list or mutable “latest”
  proof lookup can substitute for this control. All selected original/supporting
  policy proofs must survive the same reconstruction horizon before any canonical
  builder starts. The refusal-only validator is
  `scripts/r1-step8-structured-precheck.mjs`; it also rejects stale attempts,
  acquisition-only selections, legacy output codecs and missing/overlapping pages.
- `registry: {path, sha256}`: the admitted registry artifact against which the
  selected native runs are exported; native checked-source evidence produces
  a new bound registry artifact, preserving the originals.
- `privateProvenance: {path, sha256}`: existing
  `stadtstack-private-publication-provenance-v1` inventory for external
  campaign/corpus/registry/optional controls.
- `stagingProvenance: {path, sha256}`: a separate inventory of precisely the
  declared non-knowledge staging inputs. Both use the unchanged managed
  provenance contract, not path-based permission. They must be disjoint and
  exhaustive. Native seal inventories are authenticated separately; all original
  native bytes, policy receipts and parser outputs must already have real custody.
- `staging`: independently pinned `{path, sha256, destination}` for precisely
  `catalogue.json`, `regions/brandenburg-mol/topics.json`,
  `core/strausberg-facts.json`, and **each staged catalogue city's**
  `cities/ID/signals.geojson` and `cities/ID/feed.json`. No target output member
  is used as reconstruction input. The core must equal the authentic prior core.
- Optional pinned `identityAssessments`, `criticalAssessments` (additional native
  claims), and `regionalPolicyReceipts` use the existing original-evidence
  contracts. Missing mandatory evidence holds/rejects admission; omission is not
  a bypass. Source-seal critical inventories are always included.
- `priorRelease` and, when necessary for unchanged legacy change feeds,
  `legacyPreviousReleases`: authentic Git commit, release-manifest digest and
  data release ID. A new optional `directory: "release" | "out"` identifies the
  **committed** release tree. Existing historical callers default to `out`.
  Directory selection is bound in publication dependencies and replay and in
  authenticated predecessor cache keys, never inferred from the mutable target.
  Both initial publication and replay preload supplied legacy predecessors before
  entering managed source scopes; a missing earlier snapshot is never guessed.
- `asOf`: one graph day. `clocks` contains explicit
  `recordsGeneratedAt`, `quarantineGeneratedAt`, `coverageGeneratedAt`,
  `qualityGeneratedAt`, `manifestGeneratedAt`. Original generation/assessment
  clocks in sealed members are never rewritten.
- `casRoot`, `policy: {stateDir, authorityId, authoritySha256}`, and `outputRoot`.
  The latter must be a **new** real-directory generation below this package's
  `cache/`, with an existing real parent. It cannot contain an `out` or `release`
  path component. Existing/partial generations are rejected, not reused.
  Preparation, replay computation and replay evidence use disjoint sibling lanes
  `OUTPUT_ROOT-preparation`, `OUTPUT_ROOT-replay` and
  `OUTPUT_ROOT-replay-artifacts`; the last is a fresh evidence CAS derived from
  the pinned replay workspace. None is nested inside the persistent candidate
  artifacts lane or the canonical source CAS.

The input file is an operator control artifact: generate it from real completed
seal results and admitted staging provenance, then independently pin its digest.
Do not fill missing campaign results with empty arrays or invented predecessors.

For the one-command staging path, supply `stagingAssembly: {path, sha256}` instead
of the ready-component fields `campaign`, `registry`, `privateProvenance`,
`staging`, `identityAssessments`, `criticalAssessments`, `regionalPolicyReceipts`.
The pinned `stadtstack-r1-step8-staging-assembly-v1` request supplies those real
dependencies (see below); no placeholder output pins are accepted. Its read-only
preparation borrows the same canonical context and checks every authentic
retained member and managed dependency. A private campaign control is accepted
only through that opaque verified preparation; after source-epoch completion its
exact bytes are copied as a non-independent managed derivative and checked
through Core before publication. The fresh staging root/claim must be disjoint
from candidate, preparation and replay roots/claims.


### Import rejections are not processed documents

The campaign remains the complete 208-document frozen set. A native document
has `{documentId, sha256, jobKey}`. A rejected import instead has the strict shape
`{documentId, sha256, importDisposition: {decisionSha256, reasonCode}}`; never
invent an extraction job key or residual `StepReceipt` for it.

The decision schema is `stadtstack-r1-import-disposition-decision-v1`. It pins
the immutable native-selection **JSON** (the lead-action record independently
pins that same selection), catalogue, selected seal, corpus and exact historical
`import-crawl-corpus.json` / `import-result.json` per affected source. Each member
also binds document ID and original SHA-256. Consumers authenticate the admitted
registry against the selected seal, original observation ancestry, retained raw
bytes and managed bindings, then recompute importer precedence:

1. `scope_mismatch`: original URL origin is outside registered roots/page roots,
   source seed documents and API origins.
2. `unsupported_mime`: scope passes but the shared residual MIME rule refuses it.
3. `source_policy_stale`: scope/MIME, original HTTP and request/redirect evidence
   pass; authenticated frozen HTML discovery cannot derive registered-source
   eligibility and the ordinary policy has expired. No refreshed selection,
   incomplete clock or operational/authority failure becomes this disposition.

All reasons require an issued owner record. `policy.kind: "permanent_only"`
enables only the first two permanent classes. The alternative
`"include_expired_unregistered_discovery"` additionally requires
`ownerDecision: "dispose_without_processing"` and explicitly enables the stale
class. Processing those 22 originals instead remains possible; select their
genuine native results/terminal exceptions and do not select import dispositions
for them.

Review-only drafts (both have empty `issuedAt`, hence authorize nothing):

- `reports/approvals/r1-import-dispositions-permanent-2026-10-19.draft.json` — 2
  permanent documents; the remaining 22 still require processing.
- `reports/approvals/r1-import-dispositions-owner-stale-2026-10-19.draft.json` — 24
  import rejections, conditional on the owner's still-pending stale-class choice.

These drafts pin the collected final27 seal selection. A genuinely renewed seal
or new selection requires regenerated exact pins and fresh issuance, not a
hash/clock substitution in an existing issued record. Both execute and audit use
the same authentication and exact disjoint-membership checks. Native committed
counts and import-rejected counts remain separate; together with terminal native
exceptions they account for all 208 documents exactly once. Import dispositions
have `processed:false`, no admitted records, no job and no receipt. Step-9
exception material preserves the distinct variant; stale-policy exclusions remain
rights-classified, not processed negatives or a rights override.
Standalone audit re-reads the pinned issued decision after the authority/native
epoch checks and immediately before reporting compatibility. A decision that
expires during the audit blocks that report, just as it blocks execute.

## Validating read-only audit

```sh
DATABASE_URL='postgresql://max@/civic_r1?host=/var/run/postgresql' \
  ./scripts/r1-step8.sh audit /absolute/path/step8-input.json INPUT_SHA256
```

The input must explicitly select exactly one completed seal generation per
campaign source, not every historical seal in a directory. `audit` uses a
repeatable-read **read-only** PG transaction. Bulk reads retain the lock-free
managed-reader factory; exact declared-binding authentication now also uses
Core's built-in read locks. Audit does not initialize CAS, register roots,
refresh policy, write receipts, export artifacts, or invoke providers.
Inventory inode/digest, authority, source-root identities, every captured immutable
entry/scratch segment pin and objection snapshot are checked around the batch.
Finalization reloads the pinned inventory inside the epoch fence: segment removal,
corruption or unsafe replacement cannot be hidden by a warm logical snapshot.
Concurrent publication/detachment invalidates the whole result; rerun on a stable
epoch instead of using a partial mixed view.

The JSON report lists actual hashed reads, selected sources and blockers.
`status: compatible` exits 0; `blocked` (including initialization failures)
exits 1. Neither status claims publication, replay or value acceptance. Source
checks authenticate canonical DB receipts and selected current attempts,
dependencies and CAS inputs/outputs, original/prepared/archive/model cache
bindings, catalogue membership, current source policy and predecessor inputs.
Admitting assessment closures must use source-record projection v2, the approved
A/C/preparation/reconciliation queue contract, and native Sonnet B receipt v2.
Historical v1/Haiku receipts may remain in audited exception/history branches;
they cannot supply an admitting B closure.

For same-source identical bytes, the audit authenticates every selected native
extraction and its model-call accounting before considering the derived
`duplicate_source_content` dispositions. These are not caller-supplied terminal
holds. Full document/job membership remains exact (including excluded documents);
the smallest-document-ID canonical extraction alone can supply admission evidence.
Derived own/canonical extraction pins, excluded native records, attempt histories
and excluded assessment custody are checked against the sealed DB-backed closure.
An item hold is scoped to its selected extraction, not a global record ID:
an authenticated excluded duplicate may retain a zero-provider-call child hold
even when the canonical extraction legitimately admits the same logical ID.
The hold's native preparation, extraction, bundle and evidence pins still must
authenticate exactly.

The audit reads migration-009 lifetime intents and immutable allowance
attributions, retaining the real r1–r5 approval pins, frozen cohort, ordinals,
queue/original/scope membership, stage authorization and zero-paid constraints.
Historical failed/ambiguous calls are counted, never refunded or renumbered.
Only authorized base-48 A/C calls may use the 24-per-original / 100-cohort
supplement. Native B purge-ack payloads are checked against their actual lease,
request, response, runner/image and completion clocks, not merely their presence.
Production additionally requires the independently issued exact current K1/K2
structured selection and authentic released0.3.2 predecessor. All selected
source/corpus/document/original memberships must equal the pinned frozen cohort.

`execute` runs this audit **before** claiming or creating a candidate generation.
On success it writes supplementary managed `audit/current-generation.json`
evidence, pinned by both the release gate and exception inventory. This carries
the accounting and purge evidence without enriching or rewriting any historical
source seal. Release acceptance requires this exact compatible evidence and its
current-generation/campaign/admission bindings.

The sealed extraction archive compares exact source bytes for
`district-claims.ts`, `district-stage-evidence.ts`, `district-public-fields.ts`,
`district-inference.ts`, `district-answer-cache.ts`, `district-model.ts`,
`district-claude.ts`, `district-model-contract.ts`,
`district-prepared-document.ts`, `district-schema.ts`,
`district-graph-claims.ts`, `topic-vocabulary.ts`, and
`../regional/taxonomy.mjs`; cache-context bytes are
`district-prepared-document.ts` again. None is changed by this operator cutover.
The lock-free bulk reader is in `r1-step8-managed-read-view.ts`, used by the
step-8 audit and witnessed-provenance epoch fencing. `civic-opt-out.ts` remains
byte-identical to the active processing baseline. Declared binding-set checks
are performed by unchanged Core, not approximated by the bulk reader's byte-only
managed reads. The bounded strict v1 inventory/segment adapter itself remains
lock-free; authoritative declared-binding checks may acquire Core read locks.


### Native runs found read-only in the canonical DB

The explicit `BEGIN READ ONLY` inventory identified the following **historical**
runs. This table is not an execution selection:

| Lane / actual step | Run ID |
| --- | --- |
| K1 `structured_parse` | `3fe33cb6-fb63-4151-b56d-e94271c0d0af` |
| K2 `acquire_representation` — not exportable | `6a60345b-850c-4130-9105-aa6b89e99cf3` |
| K2 `structured_parse`, page 0–1565 | `f311d068-1f14-47f2-856f-d3213098821a` |
| K2 `structured_parse`, page 1565–3129 | `5f582f17-d494-4fd5-8aea-a6c7a2a22dcc` |
| K2 `structured_parse`, page 3129–3816 | `329d949b-e87f-4942-98d2-767188cf1947` |

The three K2 parse pages are already the acquisition's successors; adding another
“replacement fifth run” would duplicate evidence. Their original policy
`2272404a…` expired `2026-10-13T11:25:27.535Z`, and their legacy v1 outputs lack
the current mapping contract. K1 policy `4d26208b…` expires
`2026-10-21T19:56:51.150Z`. Neither cohort can survive a new 13-hour pass unchanged.

The no-Core-change renewal path is two genuinely authorized fresh acquisitions
of the same exact K1/K2 requests, followed by fresh parses of their committed
representations and every PEGEL output page. Both roots are already in
`registered-source-policy.ts`'s reviewed registry scopes; unchanged acquisition
can therefore issue seven-day proofs from genuine current policy evidence.
Rechecking an expired original does not renew it. The existing `policy_refresh`
job is a crawl-corpus/residual-original mechanism, not a structured descriptor
renewal API; `exportRun` implements no implicit current-proof lookup.

Original K1/K2 request/job approvals expired and their data-request allowances
were consumed. The nine-town model approval #81 does **not** expand to these
non-corpus originals. A genuine renewed exact request decision is required;
autonomous release permission is not a new source-fetch approval.

The private reviewed proposal, read-only inventory, unissued action/owner drafts,
Main-only executor and issuance commands are in
`/home/max/.local/state/stadtstack-data/r1-step8-structured-renewal-20261021/RUNBOOK.md`.
All drafts leave `issuedAt` empty; only Main issues records in a separate
authority worktree. No renewed production run IDs or receipts are asserted here.

### Authentic live 0.3.2 predecessor

`/home/max/stadtstack-ops/STATUS_0.3.2.md` identifies the live source as
`57bddbbd8b84b0634229ad9cd45b689bda7271ea`. Its committed **release/** manifest is:

```json
{
  "gitCommit": "57bddbbd8b84b0634229ad9cd45b689bda7271ea",
  "directory": "release",
  "manifestSha256": "85b9236328402364ee1211ffe274933d3eaf0ff52c976a39720920337cc866b8",
  "releaseId": "4ceebf75374df54c51bcf4a212c73770186a1a6db502423be7f108b665096691"
}
```

The same commit's **out/** manifest has a different SHA-256
(`89d48df832f0a7fc12875af715bfa5fc03bb9ea096fdf8667e056d37c895130b`).
Using it would not authenticate the actually released 0.3.2 predecessor. This
was a genuine implementation gap: the old reader hardcoded `out/`.

The authentic release also contains v2 `municipality_scoped_name` entity bases.
The historical changes reader now validates that archived representation using
a temporary validation view, while returning the original records and evidence
hashes unchanged. This is not current identity admission: the current public
record schema still rejects the old grouping, and no historical record enters
the new knowledge/graph slice merely because it existed in 0.3.2.
Changes compare the authenticated archive only within the new release's explicit
knowledge registry scope. In-scope removals remain visible; a municipality not
covered by the new release is not reported absent. The candidate loader's strict
change-scope gate is unchanged.

## Existing machinery, now wired together

No new extraction or publication engine is introduced:

1. The existing queue export's unchanged Core `buildQueueTextRun` reconstructs
   each source exactly once, including its committed original generation/judge/
   A/B/C/reconciliation closure. The operator exports the validated result from
   the opaque context, checking every contribution byte rather than rebuilding.
2. `knowledge:r1 export`'s `exportRun` now also exposes the same native grouping,
   page/coverage and checked-registry assembly without its CLI persistence side
   effects. The operator persists exact native StepReceipts in managed CAS.
3. The shared composition and private provenance contracts bind all contributions;
   the command writes managed candidate records, quarantine, policy/critical and
   identity state. Native rows remain a separate structured run.
4. `knowledge:prepare`'s `withPreparedKnowledge` performs the real current policy,
   quality, coverage/action-stage, critical and identity gates within an actual
   managed scratch lease. `publish` builds the full candidate against its
   authenticated earlier predecessor and complete non-knowledge staging.
5. Public members are copied into `OUTPUT_ROOT/release/` through managed writes.
   The exact publication-input seal and independently pinned replay receipt are
   saved outside it. Target release members are excluded from reconstruction
   provenance; the manifest alone is the expected comparison target.
6. `knowledge:replay`'s `replayPipeline` reconstructs in a separate fresh leased
   workspace, verifies **every member digest and byte count**, and compares the
   **manifest bytes, digest and ID**. Actual artifact/proof metadata is recorded
   in the isolated/same-host canonical audit DB and the separate fresh
   `OUTPUT_ROOT-replay-artifacts` CAS, never rebound into the source CAS. New
   execution clocks are only in receipts, not substituted into publication artifacts.
7. `loadRelease(..., {mode: 'vm_candidate', policyOptions})` checks the candidate
   serving/read-view contracts and current policy. Only then is
   `OUTPUT_ROOT/release-gate.json` written with `status: "passed"`, exact directory,
   release ID, manifest SHA, replay receipt/audit hash and explicit checks.
   No gate file is issued on failure. It explicitly states
   `valueAccepted: false` and `hostedReleaseAuthorized: false`.

### Replay evidence and reconstructible input pins

The replay proof and its audit contain `stadtstack-replay-input-pins-v1`: exact
receipt/provenance pins; every authenticated dependency's path, SHA, byte length
and binding-set hash; all staging pins; expected manifest/member references;
authenticated predecessor Git commit/directory/manifest/member pins; and runtime
source/lock pins. Transitive CAS hashes remain in those pinned typed bodies,
with their explicit source-CAS root and hash-path convention. This is a
reconstructible input graph, not a fabricated trace of every OS file open.
Prior Git remains **preload-only historical reconstruction evidence**, never
independent general source admission.

Persistence archives the proof and **all compared release members plus the
manifest**, not duplicate staging or predecessor trees. Each artifact keeps its
actual producer binding set, selected by the same pure member resolver used by
candidate persistence. Duplicate output hashes combine all of their producers.
Core's unchanged multi-entry write primitive records the exact per-artifact
entries in one registered scratch/batch; audit metadata additionally records the
producer-binding-set hash.

The evidence CAS is atomically reserved as a new directory. Existing/partial
evidence roots are refused. Canonical source CAS blobs are never rebound or
changed by replay; the fixture snapshots shared empty control bytes **and their
full binding entries** before and after execution. The acceptance reader derives
the evidence root from the pinned workspace and has no source-CAS fallback.
Neither byte-exact comparison, Core's exact binding checks nor the16MiB
publication provenance guard is relaxed.

`release-gate.json.phaseTimings` reports measured reconstruction, staging
preparation/commit, audit/export, publication, candidate persistence, replay total,
replay rebuild/persistence and final persistence/load intervals. The final gate
JSON write itself is excluded, avoiding self-referential timing evidence. These
are fixture/run measurements, not a certified27-source production ETA.


Hand step 9 the exact `candidateDirectory`, `releaseId` and policy realm, not a
mutable `out/` alias. Its actual MCP/value harness owns value acceptance.

## Production discovery without production writes

The following command was exercised read-only from the isolated worktree:

```sh
PATH=/home/max/.local/share/mise/installs/node/24.21.0/bin:/usr/bin:/bin \
DATABASE_URL='postgresql://max@/civic_r1?host=/var/run/postgresql' \
./scripts/r1-step8.sh discover \
  /home/max/civic-rebuild-r1/stadtstack-data \
  /home/max/.local/state/stadtstack-data/r1-operator-inputs/nine-town-2026-10-13/full
```

Observed: all five selected runs exist, with one committed receipt each; the
inspected driver `runs/` tree contained **zero completed seal-result files** at
that observation. Its output lists the real release ID/digest above, the driver
catalogue, managed CAS/operator registry roots, released predecessor tree,
external staging/provenance/control requirements and exact native run IDs.
`writes: []`, no managed authority reader, source acquisition, model call,
publication or replay was invoked. This is a time-specific discovery, not a
claim that processing subsequently remained at that state. An initial invocation
without an explicit DSN user failed before reading the DB because the scrubbed
environment deliberately has no `USER`; the documented explicit-user DSN succeeds.

## Fixture and verification

`test/fixtures/residual-production-topology.ts` extends the real disposable-PG,
isolated-authority preparation/extraction/A/B/C/seal/export fixture through
`test/helpers/step8-fixture.ts` into this command's shared execution function.
It uses explicitly synthetic queue/native evidence, the **authentic retained
0.3.2 core**, real managed preparation/publication, real offline replay and audit
persistence, and the actual `vm_candidate` loader. It checks all member evidence,
manifest identity and replay proof, and that no additional model/readiness calls
occur. No production rights, civic source coverage or independent human review
are inferred from the synthetic fixture. Separate tests exercise the closed
operator plan, offline guard, distinct `release/` vs `out/` authentication and
cache separation, missing prerequisites and target-as-predecessor rejection.

The operator's actual offline bootstrap is installed at the build/replay phase
boundary after fixture extraction. Its code and both operator entrypoints are
runtime-pinned in the replay receipt. The native byte-count fixture retains its
source-explicit `Stand:` reference date and locator, not an invented retrieval-
as-event date.

Run the coordinated gate only once all slice edits have landed:

```sh
umask 022
PYTHONDONTWRITEBYTECODE=1 \
PATH=/home/max/.local/share/mise/installs/node/24.21.0/bin:$PATH \
R1_VERIFY_CPUS=6-7 taskset -c 6-7 nice -n 10 ./scripts/r1-verify.sh all
```

Observed final gate (`tests-20261015T033555Z.tap` under the operator's
`r1-verify` state directory), after merging `d4dc169`: TypeScript passed;
1,827 tests, 1,779 passed, **0 failed, 0 cancelled**, 48 skipped; exit 0.
The full guarded text/native publication/replay/candidate-loader fixture passed,
including exact campaign authentication, retained preparation quarantine and
step-9 assessment handoff. Focused regression execution also passed:
`tests-20261015T033306Z.tap`, 139 passed, no failures/cancellations; exit 0.
The final full gate includes the added explicit critical-kind regression.
These are synthetic isolated-authority/disposable-PG results, not a production
candidate receipt or hosted-release authorization.

No production candidate was executed here. Producing it requires the complete
27-source, 208-document seal set and authenticated full staging/control
provenance. This command does not waive any processing, replay, quality,
identity, policy or value acceptance gate and never performs hosted rollout.

## Review cutover: mandatory campaign, custody and exception handoff

Ready-component inputs require `campaign: {path, sha256}` in authenticated private
provenance. An assembly invocation obtains that managed derivative at commit,
after validating the private declarative control against genuine managed corpora.
Its `stadtstack-r1-step8-campaign-v1`
document has `sources: [{municipalityId, sourceId, corpus: {path, sha256},
documents: [{documentId, sha256, jobKey}]}]`. Outside an isolated fixture realm,
its corpus hashes must equal the entire frozen
`R1_NINE_TOWN_2026_10_13_CORPUS_SHA256` set. Each original frozen document group
must have exactly one selected extraction job. Exported document IDs, hashes,
job keys, corpus and source identities must match exactly. Splitting one source
into multiple authentic seals cannot replace another source. Held and negative
documents remain explicit dispositions.

A generation is reserved by atomic directory creation before exports, with an
exclusive sibling `.claim` control file and nonce. Every candidate/derived writer
checks ownership; an existing or competing claimant cannot reuse the lane.
Native primary and supporting HTTP contributors are authenticated from the
committed job's source bindings and immutable original HTTP proofs. All their
bindings join the text/staging bindings before any derived native/candidate write.

`exception-inventory.json` persists authenticated source dispositions, original
queue evidence, available A/B/C pins, native coverage/field holds and the exact
preparation publication quarantine/critical holds before scratch cleanup. Its
hash and release ID are bound by `release-gate.json` and `step9-handoff.json`.
The handoff also pins `audit/assessments.json`, whose entries use the step-9
`{item,A,B,C}` manifest contract and point to retained, hash-checked artifacts.
Missing assessments stay explicit in the inventory; no triplet is invented and
this command does not perform or waive the owner exception audit.

The CLI and replay audit writer parse socket connection strings with
`pg-connection-string`, preserving the original DSN passed to `Pool`. Thus the
documented `postgresql://OPERATOR@/DB?host=/absolute/socket-directory` works;
the operator command rejects network hosts and relative socket directories.

## Terminal document and assessment exceptions

`seal-text-contribution` additionally accepts these two optional arrays (default
empty). Both use exactly six input fields:

```json
{
  "jobKeys": [],
  "reconciliationJobKeys": [],
  "terminalDocumentExceptions": [
    {
      "documentId": "the-frozen-document-id",
      "step": "residual_prepare",
      "jobKey": "ACTUAL_HELD_JOB_SHA256",
      "receiptId": "ACTUAL_COMMITTED_RECEIPT_UUID",
      "receiptSha256": "ACTUAL_COMMITTED_RECEIPT_SHA256",
      "reasonCode": "isolation_unavailable"
    }
  ],
  "terminalAssessmentExceptions": []
}
```

The uppercase values above describe required operator inputs, not usable pins.
Document-exception steps are `residual_prepare` and `residual_extract`;
assessment-exception steps are `assessment_prepare`, `assessment_a`,
`assessment_b`, `assessment_c`, and `assessment_reconcile`. Permitted outcomes
are `held_origin`, `held_quality`, `held_execution`, `blocked_policy`,
`blocked_access`, and `failed_execution`. Deferred, cancelled, superseded,
successful and no-case jobs cannot be terminal exceptions.

Each pin must identify the job's **current committed held attempt**: canonical
receipt hash, SQL row identities, run/attempt/fencing/outcome, job identity,
scope, policy and selected reason must agree. Resumed/leased jobs, old attempt
pins, later successful attempts, foreign documents and conflicting selections
fail closed. Frozen original custody and current policy are still independently
checked; an exception is not permission to bypass a source denial.

A document is exactly one extracted/negative group or one terminal-document
exception, never both. `jobKeys` may be empty only with at least one authenticated
terminal document. An output-bearing held-quality extraction stays in `jobKeys`;
its committed attempt history is retained when enrichment is requested. An
output-less terminal extraction must also authenticate its genuine successful
preparation predecessor. A failed preparation contributes no prepared document,
native extraction result, generation archive or knowledge record.

Assessment exceptions require an extracted document and authenticate the exact
committed extraction dependency or an assessment item actually emitted by its
committed preparation. They add no document and admit no record. A selected
genuine final assessment still controls its own admission: historical held
side paths do not manufacture or replace its A/B/C evidence. One held
reconciliation receipt may appear in both `reconciliationJobKeys` and
`terminalAssessmentExceptions`; it is one closure step. Do not select two
reconciliations for the same record in `reconciliationJobKeys`.

Seal/export results and the immutable extraction queue retain enriched exception
evidence, including real committed `attemptHistory` receipts. These are not
invented manual-resume events; separate verified operator resume decisions remain
the operator audit's responsibility. `export-text-contribution` recovers and
re-authenticates the pinned exceptions from the sealed queue envelope.

Step-8 `seals` accepts the same two six-field arrays and checks they equal the
authenticated export. In the frozen campaign's `documents`, `jobKey` names the
actual selected extraction job, or the actual held preparation/extraction job
for a terminal document. Never insert a nonexistent extraction key. Exact
campaign membership is checked over the disjoint union. The release-bound
exception inventory retains full document/assessment receipt evidence and
classification; terminal documents have no admitted record IDs.

Terminal sealing/export changes deliberately live outside the frozen residual
job implementation. A regression pins all six measured running-campaign
contracts at `93b967d`: residual preparation/extraction, assessment queue/B,
policy refresh and OMP runner. This cutover must not re-key running jobs.

After complete source/native authentication, step 8 durably writes
`source-dispositions.json` with `status: authenticated_not_released`, its
generation nonce, campaign pin and complete source dispositions. This remains
available if subsequent knowledge preparation or quality gates fail; it is not
a release receipt. Successful publication pins this inventory from the
release-bound `exception-inventory.json`.

An all-terminal **source** is sealable and exportable. An entire candidate with
no genuine dated/staged case must still fail the existing district slice gate.
The fixture asserts that independent failure, retains the authenticated terminal
document evidence, and verifies that no passed release gate is written. A
separate positive full publication/replay fixture retains an authentic held
assessment side path alongside its genuine selected final A/B/C admission.
Neither test manufactures a staged fact or relaxes the release gate.

Terminal-exception cutover verification: the complete gate passed with
`umask 022; PYTHONDONTWRITEBYTECODE=1 PATH=/home/max/.local/share/mise/installs/node/24.21.0/bin:$PATH R1_VERIFY_CPUS=4-5 taskset -c 4-5 nice -n 10 ./scripts/r1-verify.sh all`.
Receipt `tests-20261015T113436Z.tap`: TypeScript exit 0; 1,898 tests,
1,850 passed, 0 failed, 0 cancelled, 48 skipped; test exit 0. This includes the
six unchanged running-campaign contract assertions, real committed terminal
preparation/extraction and assessment ancestry/history checks, exact guarded
publication/replay with a retained assessment exception, and the expected
all-terminal candidate slice hold with durable source-disposition evidence.
No production writes, real provider calls or hosted rollout were exercised.

### Historical ordinary seal compatibility

Ordinary seals with no terminal exceptions retain their pre-`beb7047` bytes and
run IDs by default, including native-output `held_quality` extractions. New
seals can explicitly request `attemptHistory: "committed-v1"` at the seal-input
root; this marker is retained in the sealed queue and seal result. Nonempty
terminal exception arrays also enable history collection.

Export reconstructs the serialization actually authenticated by the envelope:
legacy seals without history retain legacy bytes; explicit marked seals retain
their marker/history; existing `beb7047` history-bearing seals without a marker
are also reproduced by field presence. It does not silently enrich or rewrite a
historical immutable seal. Current receipt/source/policy authentication still
applies in every format, and the frozen residual implementation is untouched.

The held-quality regression starts from a real committed synthetic worker output,
constructs the pre-`beb7047` queue serialization with unchanged genuine receipts,
and checks export, byte-for-byte default resealing, explicit enrichment, and the
already-produced unmarked `beb7047` history format.

Historical-seal compatibility verification used the same complete gate command
above. Receipt `tests-20261015T120425Z.tap`: TypeScript exit 0; 1,899 tests,
1,851 passed, 0 failed, 0 cancelled, 48 skipped; test exit 0. This includes the
held-quality serialization regression and all six frozen running-campaign
contract assertions. No production seal was exported or rewritten by this test.

## Current-generation audit verification

Post-fix verification on `r1-step8-current` used the disposable-PG harness and
the following explicitly targeted command, as authorized by the integration owner:

```sh
umask 022
PYTHONDONTWRITEBYTECODE=1 \
PATH=/home/max/.local/share/mise/installs/node/24.21.0/bin:$PATH \
R1_VERIFY_CPUS=6-7 taskset -c 6-7 nice -n 10 ./scripts/r1-verify.sh all \
  --test-name-pattern='^(lock-free audit|pinned Codex assessment allowance|real residual queue handlers|operator plan|offline bootstrap|authentic live 0.3.2|acceptance requires)'
```

Receipt `tests-20261017T140812Z.tap`: TypeScript exit 0; 186 reported tests,
186 passed, 0 failed/cancelled/skipped; test exit 0. This includes the real-PG
production-topology fixture's complete guarded source export → preparation →
publication → exact replay → candidate gate, genuine committed historical
Haiku-admission rejection before candidate writes, and retained terminal history.
Native Sonnet event bytes are explicitly synthetic fixture inputs; the receipt,
lease, purge acknowledgment and accounting custody are exercised through real
queue handlers and isolated authority, without invoking any real provider.
The read-only preflight asserts unchanged inventory bytes and DB row counts.
All ten entry/scratch segment finalization regressions pass, alongside stable
epoch/no-lock/no-write checks and real-PG allowance accounting rejection cases.

The earlier unfiltered `tests-20261017T132331Z.tap` was not green: it exposed
the now-fixed strip-only runtime/type/error-matcher issues and the separate
120-second B-broker aggregate fixture timeout. This targeted receipt is not
represented as a passing unfiltered full gate. The final integrated HEAD still
requires its complete gate and exact compatibility with the active security-review contracts.

Production discovery was exercised again read-only on 2026-10-17 using the
documented `discover` command. All five exact selected native runs still had one
committed receipt each. The driver tree now contained historical/repeated seal
generations, including some `355691be` results. Those paths are only discovery
candidates, not a complete explicitly approved selection. The discovery contract
now says `selectionValidated: false` regardless of raw file count: 27 copied or
historical files do not prove 27 current source generations. Its `wouldRead` list named the actual
driver catalogue, CAS/operator roots, authentic released predecessor, staging and
policy/identity/critical provenance, Git predecessor members and canonical DB
custody. It returned `writes: []`, `network: false`, `providers: false` and did
not publish or replay. These historical candidates are not an approved selection
and are not a successful production generation audit.

### Window-independent processing-pin cutover

After rebasing onto `b32bc962e617c876763f34c9734908f59116a00a`, the authorized
focused verification command was:

```sh
umask 022
PYTHONDONTWRITEBYTECODE=1 \
PATH=/home/max/.local/share/mise/installs/node/24.21.0/bin:$PATH \
R1_VERIFY_CPUS=6-7 taskset -c 6-7 nice -n 10 ./scripts/r1-verify.sh all \
  --test-name-pattern='^(lock-free audit|pinned Codex assessment allowance|real residual queue handlers|operator |offline bootstrap|authentic live 0.3.2|acceptance requires|terminal sealing preserves)'
```

Receipt `/home/max/.local/state/stadtstack-data/r1-verify/tests-20261017T163249Z.tap`:
TypeScript exit 0; 190 reported tests, 190 passed, 0 failed/cancelled/skipped;
test exit 0. The genuine isolated queue/candidate/exact-replay fixture now uses
synthetic native stream-v2 events with thinking/text content and medium-thinking
runner metadata. Independent negatives reject a stale B job contract, output
contract, runner contract, empty/v1 stream marker, wrong thinking level, model
fallback, pending review and a mismatched catalogue review path/digest. A second
synthetic confirmed commit/contract set is accepted without changing code.
The unchanged scoped extraction contract assertions also passed.

A separate read-only control-chain check, under the same offline bootstrap and
CPU 6–7 restriction, read only the active driver `full/catalogue.json` and its
pointed `processing-pin-b32bc96.json`. It validated their exact digest/commit/
contract relationship with the production policy function and exited 0:

- Catalogue SHA-256: `c67e4566d36fd89d3633b1f47092ab80930ab41da17fbee981eb0b22b4ac8974`.
- Confirmed review SHA-256: `61dd9b1c5414fb4d1e54f589d58348da25f61beaab82457959f13ac4c751d1c8`.
- B job: `c69c8f53802e5441c9ec597f9ce7a3002986b252cafc8076e6db0a0db46b0fea`.
- Processing runner: `95265109e3d853c290b3e0f2720b9e278a89b2863cf52659d612487b049f43c2`.
- Processing output: `0dc9eca7d86d2f7cfa9ddd25140216a676c1a2a687d468cf303b8cfb37abe361`.

These are observed receipt values, **not compiled policy constants** or approval
of a production source selection. The check reported `selectionValidated: false`,
`publicationExecuted: false`, `writes: []`, `network: false`, `providers: false`.
It did not connect to production PG, read selected source closures, publish,
replay or run value acceptance. No unfiltered full gate was run for this cutover;
the final integrated gate and confirmation of existing security-review eligibility
remain the integration owner's responsibility.

### Processing-contract-neutral managed reader

The integration owner required all fourteen exported processing contracts to
remain identical to the active window-14 baseline, including security contracts.
The `ce69f9e` implementation did not meet this condition: twelve contracts matched,
but adding the factory to `civic-opt-out.ts` changed parser isolation to
`5ed076bac8718b46202c13b8341328caa7be43c4de2646fed2a6850d60e049fe`
and the OMP runner to
`e7aa21a60788f717dd1bf2581e8d4fe418fc069f01c71469a138cd3b08cf7ba7`.

The factory now lives solely in `r1-step8-managed-read-view.ts`; the processing
authority module and its original private inventory loader are restored.
The adapter independently decodes the existing strict inventory/segment v1
envelope, delegates source proof validation to `ManagedSourceBindingSchema`,
and retains the live authority/objection checks. It validates chain and retired-root
semantics, source/root/lease identities, safe inode metadata and exact segment
digests. Finalization reopens and validates every captured segment inside the
manifest/objection fence. Epoch hashing streams through a 64-KiB buffer rather
than retaining a second inventory-sized buffer. No writing lock API is called.

The decoded `publication`, `snapshot`, `code` and `approval` proof objects use
the public codec's parsed values, not raw wire objects. This mirrors the private
inventory decoder's nested key ordering before its JSON-stringification-sensitive
entry-ID check: reordered wire keys with the original canonical ID remain valid,
but an ID recomputed from raw nested key order fails closed. Validation does not
rewrite the source inventory or sealed segment bytes.

Using the actual fourteen exported functions (the same set as the processing
cutover comparison), archived `b32bc96` and `ce69f9e` bytes were supplied through
their supported hash callbacks; the restored runtime used normal filesystem
reads. All fourteen final results equal `b32bc962e617c876763f34c9734908f59116a00a`:
preparation extractor, residual preparation, residual job, joint extraction,
assessment queue, assessment B, acquisition, policy refresh, structured state
gauges, operator registry config, parser output, parser isolation, OMP output,
and OMP runner. In particular, parser isolation is again
`287e701cdbddef1c22b2d202b54983467651eccfe43ead8cb67365ead00a4942`
and the OMP runner is again
`95265109e3d853c290b3e0f2720b9e278a89b2863cf52659d612487b049f43c2`.
The test expectations were restored to those active pins, not updated to bless
a new contract.

The focused command from the preceding subsection was then run again on CPUs
6–7, using disposable PG and isolated authority. Receipt
`/home/max/.local/state/stadtstack-data/r1-verify/tests-20261017T164739Z.tap`:
TypeScript exit 0; 190 tests, 190 passed, 0 failed/cancelled/skipped; test exit 0.
This includes all ten captured-segment finalization regressions and the full
guarded candidate/exact-replay fixture using the standalone reader.
No full gate or production publication was run.

The nested-proof normalization correction was verified with the same focused
CPU 6–7 command. Receipt
`/home/max/.local/state/stadtstack-data/r1-verify/tests-20261017T165726Z.tap`:
TypeScript exit 0; 198 tests, 198 passed, 0 failed/cancelled/skipped; test exit 0.
Eight added oracle-conformance cases cover `publication`, `snapshot`, `code`
and `approval` in both hot inventories and sealed segments. Each accepts reordered
wire keys with the writer's original canonical ID in both readers, then rejects
an ID forged from raw nested key order in both readers. The audit leaves the
forged inventory bytes untouched. Recomputing all fourteen exported runtime
contracts after this correction again found no differences from `b32bc96`.

## Offline retained staging assembly

Step 8 now has an explicit producer for its non-knowledge staging and external
provenance input. This carries forward the **exact released 0.3.2 bytes**; it does
not acquire municipal sources, refresh policy, admit new claims or authorize
release. The read-only plan checks the fixed predecessor Git commit, manifest
SHA/ID, catalogue city set and every selected on-disk member against those Git
bytes. Embedded attribution is decoded with the existing retained importer;
absent original source hashes stay null.

```sh
# From stadtstack-data, with the pinned Node PATH and private umask:
./scripts/r1-step8.sh retained-plan /home/max/civic-rebuild-r1/stadtstack-data/release
```

Capture that JSON privately as `retained-plan.json` and independently hash its
exact bytes. It is a collect-compatible `stadtstack-retained-import-plan-v1`
targeting the existing `RETAINED_PUBLICATION_ROOT`. Its exact set is catalogue,
regional topics, authentic core, and both feed and signals for all eight released
catalogue cities: **19 members**. No knowledge, graph, coverage or target manifest
member is used as reconstruction input. The plan makes no managed/DB writes and
does not even open the authority inventory.

Only in Main's authorized production write window, after campaign drain, import
the authentic retained copies through the existing governed importer:

```sh
npm run collect -- /absolute/retained-plan.json RETAINED_PLAN_SHA256
```

`collect` is not a network collector. Current opt-outs apply. Then pin the
assembly request below in the operator manifest's `stagingAssembly` and invoke
`execute` once; it prepares the assembly inside its single source pass and
commits only after the source epoch finishes. The standalone
`assemble-staging INPUT SHA256` remains available for independently requested
staging, but is not a prerequisite extra canonical pass for execute. Missing
imported copies are never silently collected. The strict assembly input is:

```json
{
  "schemaVersion": "stadtstack-r1-step8-staging-assembly-v1",
  "retainedPlan": {"path": "/absolute/retained-plan.json", "sha256": "actual plan digest"},
  "provenances": [{"path": "/absolute/sealed-source-provenance.json", "sha256": "actual inventory digest"}],
  "campaign": {"path": "/absolute/final-campaign.json", "sha256": "actual campaign digest"},
  "registry": {"path": "/absolute/already-managed-registry.json", "sha256": "actual registry digest"},
  "managedRoot": "/home/max/civic-rebuild-r1/stadtstack-data/cache/r1-step8-staging-UNIQUE",
  "policy": {
    "stateDir": "/home/max/.local/state/stadtstack-data/civic-policy",
    "authorityId": "owner-2026-10-11-codex-workstation",
    "authoritySha256": "actual authority pin"
  }
}
```

The explanatory digest strings above are not executable pins. Supply the final
27-source/208-document campaign and all sealed-source provenance pins needed to
authenticate its exact corpus paths and the registry. Optional
`identityAssessments`, `criticalAssessments`, `regionalPolicyReceipts` are path/hash
pins and must already occur in genuine authenticated supplied provenance.
Historical Git membership is never accepted as general source custody.

No new source-enrollment authority is introduced. Campaign identity/hash/job
membership is validated against the actual frozen managed corpora. The campaign
is then copied byte-for-byte through existing `writeManagedSourceArtifact` as a
derivative with its authentic contributing corpus bindings and
`independentAllowed:false`. Registry and optional controls are **not** enrolled
from a bare operator file; they must already be readable with real managed
bindings in the supplied provenance. The primary control inventory includes all
required corpora, registry, optional inputs and the managed campaign; the separate
staging inventory keeps every retained copy and its complete binding set.
Retained copies are checked against authentic bytes and actual custody.

The assembly root must be fresh beneath this package's real cache directory.
Both the root and its claim must be disjoint from all enrolled managed roots;
the existing read-only inventory API checks this before any reservation and again
immediately before claim creation. Refusal leaves no nested directory/claim
debris and preserves ancestor inventory completeness.
Atomic generation reservation plus sibling `.claim` fencing prevents concurrent
assemblers mixing outputs. Assembly writes `campaign.json`,
`private-publication-provenance.json`, `staging-publication-provenance.json` and
`staging-component.json` in that new managed control root. Its stdout pins the
component and returns `inputs`: `campaign`, `registry`, `privateProvenance`,
`stagingProvenance`, exact `staging`, and supplied optional pins. Merge those
**input fields**, not the result envelope, into a ready input and recompute its
digest; the preferred one-command assembly invocation does this itself.
Execute embeds precheck and validating audit; do not repeat its canonical pass
with a separate audit merely as a prerequisite. Changed/revoked dependencies
fail closed. Existing/partial roots are never repaired or reused.
The result envelope is `stadtstack-r1-step8-staging-result-v2`, whose
`publicationExecuted:false` distinguishes staging writes from candidate
publication. No v1 result compatibility shim is retained.

`test/r1-step8-staging.test.ts` includes the real operator retained-plan CLI and
an opt-in disposable-PG topology child. The latter imports all 19 actual released
Git members using isolated authority, rejects incomplete plans/changed source
declarations/unbound registry controls, assembles real managed provenance, and
reaches compatible read-only Step8 audit while asserting unchanged inventory/DB
counts during that audit. Native text/assessment evidence remains explicitly
synthetic fixture material. This is not production publication or value proof.

Focused staging verification on branch `r1-step8-staging` (base `478b3e3`) used
CPUs 6–7, a fresh socket-only disposable PostgreSQL cluster and isolated policy
authority. `test/r1-step8-staging.test.ts`, `test/r1-step8-governance.test.ts` and
`test/r1-step8.test.ts`: **12 passed, 0 failed/cancelled/skipped**, exit 0.
The real-member topology child reached compatible audit with all 19 authentic
members and unchanged inventory/DB counts during audit. Its first run exposed a
fixture-only strict-pin projection error, fixed before this passing run.
All fourteen actual exported processing-contract calculations still equal
`b32bc96` (zero differences). The disposable cluster stopped cleanly and was
removed. No full gate, production import/assembly, publication or value test ran.

After the managed-root-overlap review correction, the same focused suite passed
**13/13**, zero failed/cancelled/skipped, exit 0. The new refusal regression
asserts absent output directory and claim, byte-identical inventory, and complete
ancestor state even after canonical reconciliation. The real-member child also
asserts the v2 envelope and `publicationExecuted:false`. All fourteen actual
processing contract results again had zero differences from `b32bc96`.
Disposable PG stopped with exit 0 and its directory was removed; no production
write or full gate was performed.

## Witnessed shared-content provenance supplements

Different native source seals can write identical derived CAS bytes, notably
empty critical inventories/admissions. Their managed CAS entry accumulates the
union of source bindings while each immutable native manifest retains only its
own cohort. Core deliberately requires complete derived ancestry
(`civic-opt-out.ts:1205`); neither a reader subset exception nor an empty-blob
special case is permitted. The old audit's byte-only checks could miss this
execute-time failure.

The single step8-only implementation is `src/r1-step8-provenance.ts`. It accepts
an independently reviewed and **issued** `stadtstack-r1-operator-action-record-v1`
action `select-governed-native-seals`, not arbitrary witness files. This record
pins a strict `stadtstack-r1-native-seal-selection-v1` frame, the current
catalogue, collection evidence and collector implementation. The frame's ordered
`seals` entries contain `municipalityId`, `sourceId`, `corpus`, `output`,
`admission` (`published` or `adoption_candidate`), and the exact saved
`QueueTextSealInput`. Issuance/expiry, frozen parent approval and zero execution/
spending bounds are checked. A draft or bare frame grants no authority.

Production step8 requires the complete live catalogue: **27 published entries**,
each source exactly once. Previously issued partial25/candidate selections are
historical records, not publication authority. Adoption now uses ordinary native
outer-proof acceptance separately; there is **no adoption reconstruction mode**
in this module. Its mandatory full27 witnessed-union/Core check occurs once in
step8. Audit/execute must match the exact ordered outputs and queues; duplicates,
omissions, unlisted sources and other catalogues refuse.

**Custody is not producer authentication:** unchanged Core `buildQueueTextRun`
reconstructs every native seal from actual canonical PostgreSQL receipts, in a
repeatable-read read-only transaction. The source/document/corpus cohort, all
six artifacts, composition, all three ancillary roles, full ten-member private
provenance body/hash and native output metadata must match the canonical producer.
Enrolling invented JSON, or combining a real run with fabricated ancillary roles,
does not pass. The CAS facade only reads existing epoch-fenced members: no
initialization/put. Its independent one-connection pool accepts only scalar local
Unix-socket settings, not caller Client/stream/hooks or DSN GUC overrides.
Password authentication is prohibited; this is a local peer/trust path.

The deterministic binding-union inventory has a mandatory **v2 attestation**
binding the issuance/frame pins, exact ordered source/output/provenance/run/queue/
receipt identities, target list and inventory digest/size. Extra no-op witnesses,
omissions, reordered sets and copied aliases cannot reuse an attestation even
when union bytes are identical. Targets must exist and grow; their path/hash/size
and non-target members remain unchanged. Every added binding is a canonical
original HTTP observation with `independentAllowed:true`. Unchanged Core then
authenticates exact live binding sets and reads every input. Native seals and
receipts are never rewritten; missing contributors and revocations stay failures.

Step8 input requires `nativeSealSelection` (the **issued-record** Pin).
Optional per-seal `provenanceSupplement` now has the strict shape
`{inventory: Pin, attestation: Pin, targets: Hash[]}`; a bare union pin is invalid.
The read plan includes these controls. Audit and execute share authentication;
replay receives the complete authenticated publication/replay input inventory,
without duplicating unrelated independent audit/exception artifacts.

Standalone native staging uses `nativeSealSelection`, `nativeSealCatalogue`,
`nativeCasRoot` and the canonical socket database. Optional explicitly supplied
`provenanceSupplements: [{nativeOutput, nativeProvenance, supplement}]` must match
its `provenances` controls. Execute instead lends its existing context. Complete
ordinary provenance still authenticates through unchanged Core.

For each selected native inventory, step8 derives all and only growing shared
HTTP-binding unions from the already canonical complete frame. It does not catch
a failed Core proof and invent a fallback. Private inventory/attestation control
metadata is temporary and removed at context close; candidate evidence preserves
the exact generated bytes under `audit/native-provenance/`. Optional independently
pinned supplements are still checked byte-for-byte against that derivation.
Missing or foreign contributors still fail Core's exact-binding check at
`civic-opt-out.ts:1205`; neither that rule nor any processing closure is changed.

All runtime Core entry modules come from the explicitly selected active
`coreRoot`; `WITNESSED_PROVENANCE_CORE_DEPENDENCIES` enumerates them. No protected
processing/archive source changes are required. Cached decoding is not cached
authorization: file identity/realpath, authority, issuance expiry, live selected
job/receipt state, inventory/objection epochs and final segment/root integrity
remain mandatory. Changed views fail closed, without silent reselection.
Final writes still require the governed quiescent window.

Focused regressions are in `r1-step8-provenance.test.ts` and the real disposable-
PG `residual-production-topology` fixture, including native publication/exact
replay and `helpers/step8-provenance-fixture.ts`. Distinct source cohorts use
genuine canonical held queue receipts, including a real no-op binding witness.
Tests cover ancillary forgery, exact-set/alias changes, unchanged-inode parent
aliases, epoch changes and unchanged DB/inventory state. Merely enrolled
native-looking synthetic JSON is deliberately not a positive fixture.

The private witness pool accepts the ordinary
`postgresql:///civic_r1?host=/var/run/postgresql` DSN: an omitted URL port
normalizes to the configured port or PostgreSQL's default `5432`. Explicit
nondefault ports are preserved; invalid zero ports are rejected. Caller Client
constructors and DSN read-write GUC overrides are not inherited.

Returned attestation, inventory and provenance-pin metadata are detached
snapshots, not writable references into cached canonical authority. Caller
mutation cannot change a later build/authentication in the same context; the
reader capability itself remains the genuine unchanged-Core capability.

## Integrated one-pass verification

The earlier integrated focused run used Node24.21.0, `umask022`, one test file at
a time, CPUs1–5 and nice10, with a fresh Unix-socket-only disposable PostgreSQL16
cluster and isolated fixture authority:

```sh
taskset -c 1-5 nice -n 10 node --experimental-strip-types \
  --test --test-concurrency=1 --test-reporter=tap \
  test/r1-step8-provenance.test.ts \
  test/district-publication-provenance.test.ts \
  test/r1-step8.test.ts \
  test/r1-step8-governance.test.ts \
  test/district-residual-topology.test.ts \
  test/r1-step8-staging.test.ts \
  test/r1-step8-import-dispositions.test.ts \
  test/r1-step8-audit-expiry.test.ts
```

Observed result: **30 tests,30 passed,0 failed/cancelled/skipped**,773.32s TAP
duration (774.27s including disposable-cluster setup/teardown). The separate
`taskset -c1-5 nice -n10 node_modules/.bin/tsc --noEmit` check exited0 in21.25s.
All fourteen actual exported processing-contract functions were recomputed
against `aceb0a658c48f2e683e79316f4ddd2d13689b36e`: **zero differences**.

The run exercises genuine canonical producer reconstruction with two/three
workers, whole-PID exit during a CPU-starved thread after parent/PG loss, exact
Core inherited-fd mutex subprocess form under the offline guard, one canonical build per
source through embedded audit/export, zero builder calls on insufficient pinned
proof lifetime, all-member candidate/exact replay, real19-member0.3.2 staging,
authenticated import rejection and the final standalone-audit expiry boundary.
The short synthetic proofs are unchanged; their explicitly declared fixture
planning estimate is ten minutes plus a sixty-second margin, not production's
conservative default planning estimate.

PostgreSQL stopped with exit0, its temporary directory was removed, and an actual
`pgrep` found no test/fixture/reconstruction actors. Fixture subprocesses use
`--test-isolation=none`, so a runner timeout cannot strand a hidden test child.
The earlier timed-out isolated fixture was identified and removed; no production
authority/CAS/DB data was changed.

These are focused implementation checks, not a full `r1-verify.sh all` result or
a successful production generation audit/publication. Final issued selection,
genuine policy-renewed seals, any explicit owner import-disposition decision,
step9's frozen value test and hosted-release authority remain separate gates.
No direct before/after production reconstruction benchmark is claimed; retained
pre-repack producer timings are historical proxies, not a measured final ETA.

## Real19 staged handoff and isolated replay evidence verification

After the custody cutover, the following authorized focused runs used the same
Node24.21.0/PG16, `umask022`, CPUs1–5, nice10 and single-file concurrency:

```sh
taskset -c 1-5 nice -n 10 node --experimental-strip-types \
  --test --test-concurrency=1 --test-reporter=tap \
  test/replay-pipeline.test.ts test/r1-release-acceptance.test.ts \
  test/r1-step8.test.ts test/r1-step8-provenance.test.ts

taskset -c 1-5 nice -n 10 node --experimental-strip-types \
  --test --test-concurrency=1 --test-reporter=tap \
  test/district-residual-topology.test.ts

taskset -c 1-5 nice -n 10 node --experimental-strip-types \
  --test --test-concurrency=1 --test-reporter=tap \
  test/r1-release-acceptance.test.ts test/r1-step8-staging.test.ts
```

Observed results, respectively: **56/56**, **2/2**, **25/25** passed, with no
failures/cancellations/skips. The genuine native/duplicate run took338.37s;
the final real19/acceptance run took3025.35s including disposable-cluster
setup/teardown. This last fixture uses all19 authentic retained0.3.2 members
and duplicate-byte originals, one actual canonical reconstruction per selected
source during execute, all-member/manifest byte-exact replay, a passed step8
gate, successful `loadStep8ExceptionBundle`, and rejection of campaign tampering.
Both shared empty native controls retain byte-identical content and exactly the
same complete source-CAS inventory binding sets before/after execute. Omitting
a required original producer binding is refused by unchanged Core. Replay
evidence cannot fall back to the source CAS.

Measured execute intervals in that real19 fixture:

| Interval | Seconds |
| --- | ---: |
| Canonical reconstruction | 15.580 |
| Staging preparation | 27.192 |
| Audit and export | 65.923 |
| Staging commit | 111.054 |
| Initial export persistence | 143.621 |
| Publication | 248.783 |
| Candidate persistence | 245.784 |
| Replay total | 1267.934 |
| Replay rebuild and exact comparison (within replay total) | 641.015 |
| Replay evidence persistence (within replay total) | 357.045 |
| Final persistence and candidate load | 255.130 |

These measured fixture intervals are not a production27-source ETA; the replay
subintervals must not be added again to replay total. The final gate JSON write
is excluded. The separate final TypeScript check exited0 in20.80s, and all14
actual exported processing-contract functions still match `aceb0a6` exactly.
PostgreSQL stopped with exit0 and each temporary cluster was removed; the final
process check found no remaining test, reconstruction or disposable-PG actor.
No production state was written. The integration owner still runs the complete
gate and independent reviews before production use.

## Canonical worker failure diagnostics

Fork stderr is inherited by the governed command. Supervisor failures emit one
bounded `R1_CANONICAL_WORKER` JSON line synchronously before whole-PID exit and
attempt a bounded100ms IPC flush. Reasons distinguish parent stop/disconnection,
signal, database/heartbeat failure, worker-thread error/exit, invalid/duplicate
result and IPC/supervisor failure. Error metadata contains only a validated runtime
code, allowlisted name, fixed classification and up to4 relative source/builtin
frame locations: never arbitrary error messages, PostgreSQL detail, source bodies,
requests, URLs or connection configuration.

`R1_CANONICAL_PROGRESS` lines record parent worker index/PID, exact shard indices,
opening/source-started/source-completed/finishing/serialization phase and validated
source routing IDs. These progress events do not authorize source results and
never count as a result packet. Parent nonce/shard/cardinality/epoch checks remain;
the first actual observed failure is retained rather than replaced by a lower-
indexed sibling's subsequent abort.

Both process and reconstruction-thread heaps retain their existing1024MiB caps.
`ERR_WORKER_OUT_OF_MEMORY` is a Node worker-heap error and need not produce a
Linux/system OOM event. It is not proof that any particular unexplained historical
exit was an OOM. The previous supervisor discarded its underlying error before
`process.exit(1)`; a legacy generic1/null exit alone cannot establish its cause,
last source or original failing shard after the fact.

When construction of the canonical context rejects, `runStep8` has not reserved
the candidate/staging generation or begun managed publication/replay persistence.
Confirm actual destinations, inventory epoch/lock/leases and canonical DB sessions/
metadata before deciding recovery. Old unrelated partial leases are not evidence
that this attempt created scratch; never run blanket recovery merely to clear a
generic error. No new execute follows automatically: Main approves fresh output
destinations and rechecks current proof/epoch gates after inspection.

Focused diagnostics verification used Node24.21.0, CPUs2–7, nice10, umask022,
one test file at a time and a fresh socket-only disposable PG16 cluster:
`test/r1-step8-worker-diagnostics.test.ts`, `test/r1-step8-provenance.test.ts` and
`test/district-residual-topology.test.ts`: **15/15 passed**, no failures,
cancellations or skips,366.95s including cluster setup/teardown. This includes a
real Node worker heap error using a bounded16MiB nested fixture, safe error/exit/
success IPC, parent/PG-loss whole-PID cleanup, actual two/three-worker canonical
source reconstruction and original-failure retention for either shard index.
The genuine native and duplicate-source Step8 publication/replay fixtures remain
green. TypeScript exited0; all14 actual processing-contract exports match the
active `5a9a14c` pin exactly. Disposable PG stopped exit0 and its directory was
removed. These focused checks do not establish the cause of the historical
production exit or authorize a new production execute.

## Two-inventory publication cutover verification

The authorized focused checks used Node24.21.0, `umask022`, CPUs2–7,
nice10, one test process at a time and fresh Unix-socket-only disposable PG16
clusters. No production authority/CAS/database writes, network or model calls
were performed. All14 exported processing fingerprints matched the5a9a14c
baseline exactly; `node ./node_modules/typescript/bin/tsc --noEmit` exited0.

The clean final unit/supervisor group passed **86/86**, with zero skips or
cancellations. Its command was:

```sh
taskset -c 2-7 nice -n 10 node --experimental-strip-types \
  --experimental-test-module-mocks --test --test-concurrency=1 \
  --test-reporter=tap \
  test/publication-provenance-partition.test.ts \
  test/r1-step8-publication-bounds.test.ts \
  test/r1-canonical-query-queue.test.ts \
  test/r1-step8-structured-precheck.test.mjs \
  test/prepare-knowledge.test.ts test/publish.test.ts \
  test/replay-pipeline.test.ts test/r1-release-acceptance.test.ts \
  test/r1-step8.test.ts test/r1-step8-provenance.test.ts \
  test/r1-step8-worker-diagnostics.test.ts \
  test/district-publication-provenance.test.ts
```

Using the same resource controls and disposable-PG setup, the native/duplicate
topology group passed **2/2**, and `test/r1-step8-staging.test.ts` passed
**3/3**, including the complete real19 flow through compatible audit, publication,
every-member/manifest exact replay, candidate loader, exception handoff and
tamper refusal. Existing shared empty CAS blobs **and a pre-existing genuine
structured receipt** retained identical bytes and complete binding sets.
Missing HTTP/non-equivalent registry proof, omitted/overlapping partition input,
and incomplete operator runtime source inventory remain refusals.

The measured real19 fixture retains all12,517bindings in its staging inventory:
**6,564,614bytes/19inputs**. Its primary inventory is **21,044bytes/15inputs**;
the independent pre-pass upper bound was21,089bytes. Both unchanged Core readers
accepted the inventories. Native queue/assessment data in this fixture is
explicitly synthetic; the retained0.3.2 members are authentic.

Measured execute subphases in that fixture, not production estimates:

| Phase | Seconds |
| --- | ---: |
| Automatic static pre-pass | 4.41 |
| Canonical reconstruction | 15.88 |
| Staging preparation | 26.51 |
| Embedded audit/export | 66.11 |
| Staging commit | 114.52 |
| Initial export persistence | 192.84 |
| Publication | 300.66 |
| Candidate persistence | 296.75 |
| Exact replay total | 1,360.48 |
| Replay rebuild (inside total) | 716.56 |
| Replay persistence (inside total) | 367.78 |
| Final persistence and candidate load | 262.74 |

The production precheck was exercised read-only against the pinned oldw1 input
(`f5ea79ff…`) and the actual27 seals/194 native inputs/19 retained copies.
Its95.37s report inspected155 fixed publication inputs and bounded all9 generated
rows: primary **12,765,118bytes upper bound**, staging **6,564,861bytes exact**,
each below the15,728,640-byte exclusive safety threshold. Prepared control
inventories were9,230,539/6,564,861bytes; committed controls
9,642,652/6,564,861bytes. This is current-input sizing, not source-count scaling.
The old input correctly refused before reconstruction: its supplied inventories
omit all27 original-path corpus controls and it has no issued current structured
selection. A reviewed original-path control inventory and genuinely renewed,
independently issued structured selection are required for a fresh retry.

These checks are step8 fixture/static evidence, not a production candidate,
frozen value-test result, hosted approval or claim that Main's full integration
gate has run. Every owned disposable PG cluster was stopped and removed; the
post-run process search found no owned fixture/worker/PG actor.
