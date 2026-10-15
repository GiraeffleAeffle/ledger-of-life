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
lock, exports a receipt, or connects to PostgreSQL. `execute` has real managed
CAS/authority/audit writes: **do not run it against production as a dry run**.
The implementation exercise uses only a disposable PG database and isolated
fixture authority. Production processing and historical `out/` and `release/`
are not modified by this work.

The wrapper strips the environment (including provider tokens, proxies and
`NODE_OPTIONS`), and preloads `r1-step8-offline.cjs` before application imports.
The guard denies HTTP/fetch, DNS, UDP, HTTP/2, TLS/TCP and arbitrary child processes/model
CLIs. Only Unix-domain sockets (the same-host PG audit connection) and the
predecessor reader's bounded `git --no-replace-objects show COMMIT:./out|release/MEMBER`
are permitted. Git lazy fetch and prompts are disabled by the predecessor
reader. This is an enforced Node transport/process guard for trusted replay,
**not a claim of OS/network-namespace isolation**. There is no cache-miss model,
readiness, acquisition or live fallback. The replay proof retains its existing
honest `networkIsolation` wording; the wrapper's guard is tested separately.

## Complete input contract

`src/r1-step8.ts` exports the strict `Step8InputSchema`. Its version is
`stadtstack-r1-step8-v1`. Unknown fields fail closed. Required fields:

- `expectedSources`: **27** and `expectedDocuments`: **208** for this production
  campaign. The command rejects an incomplete count or duplicate extraction
  jobs; the isolated synthetic fixture declares its own 1-source/1-document scope.
- `seals`: in explicitly approved source/run order. Each element contains
  `sealResult: {path, sha256}`, `jobKeys` (extraction keys), and
  `reconciliationJobKeys` from that source's completed seal inputs/results.
  The result must contain the real composition hash and pinned private
  provenance, policy inventory and critical inventory emitted by
  `seal-text-contribution`. No aggregate rows, invented lineage or substituted
  model receipts are accepted. The declared reconciliation set is checked
  against the extraction-run queue closure.
- `structuredRunIds`: the committed K1/K2 runs listed below. They are exported
  together, not merged by title or relabeled as text-model work.
- `registry: {path, sha256}`: the admitted registry artifact against which the
  selected native runs are exported; native checked-source evidence produces
  a new bound registry artifact, preserving the originals.
- `privateProvenance: {path, sha256}`: existing
  `stadtstack-private-publication-provenance-v1` inventory for every external
  staging/control member. This is the existing managed provenance contract,
  not a path-based permission assertion. Seal inventories are authenticated and
  combined with it. Original native raw bytes, policy receipts and parser outputs
  must already be in managed CAS with their actual custody.
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
  Preparation and replay use the disjoint sibling managed lanes
  `OUTPUT_ROOT-preparation` and `OUTPUT_ROOT-replay`; nested registered roots are
  never created inside the persistent candidate artifacts lane.

The input file is an operator control artifact: generate it from real completed
seal results and admitted staging provenance, then independently pin its digest.
Do not fill missing campaign results with empty arrays or invented predecessors.

### Native runs found read-only in the canonical DB

The explicit `BEGIN READ ONLY` query found these exact committed run IDs:

| Lane | Run ID |
| --- | --- |
| K1 | `3fe33cb6-fb63-4151-b56d-e94271c0d0af` |
| K2 PEGELONLINE | `6a60345b-850c-4130-9105-aa6b89e99cf3` |
| K2 PEGELONLINE | `f311d068-1f14-47f2-856f-d3213098821a` |
| K2 PEGELONLINE | `5f582f17-d494-4fd5-8aea-a6c7a2a22dcc` |
| K2 PEGELONLINE | `329d949b-e87f-4942-98d2-767188cf1947` |

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

1. `knowledge:r1 export-text-contribution`'s actual
   `exportResidualTextContribution` authenticates each source's whole committed
   queue closure, including original generation/judge/A/B/C and reconciliation.
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
   **manifest bytes, digest and ID**. It records actual artifact/proof metadata
   in the isolated/same-host canonical audit DB and managed CAS. New execution
   clocks are only in receipts, not substituted into publication artifacts.
7. `loadRelease(..., {mode: 'vm_candidate', policyOptions})` checks the candidate
   serving/read-view contracts and current policy. Only then is
   `OUTPUT_ROOT/release-gate.json` written with `status: "passed"`, exact directory,
   release ID, manifest SHA, replay receipt/audit hash and explicit checks.
   No gate file is issued on failure. It explicitly states
   `valueAccepted: false` and `hostedReleaseAuthorized: false`.

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

The control manifest now also requires `campaign: {path, sha256}`, itself present
in the authenticated private provenance. Its `stadtstack-r1-step8-campaign-v1`
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
