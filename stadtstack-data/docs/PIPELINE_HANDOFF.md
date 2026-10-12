# Civic pipeline: VM resume brief

Handoff: **12 October 2026, Berlin**. The owner stopped the Mac work and moved all continuation to the VM. **This branch is WIP, not an approved or deployable 0.3.2 release. Do not tag or deploy it.** No new 0.3.2 acquisition, preparation, model run, publication, image or rollout was performed.

## 1. What is live and where the work is

- Live endpoint: **https://mcp.stadtstack.eu/mcp**, version **0.3.1**, 20 read-only tools.
- Immutable live source: `47083b92ad18613763536ea79d4db1aaccaa6eea`.
- Live image: `ghcr.io/giraeffleaeffle/stadtstack-mcp:0.3.1@sha256:5efca884f0bcc453a9a9df0b8a543526ce42c74da82bb56a26a88fffe1dd7d98`.
- Live data ID: `25d99c9382ccbfeb3fbdef8541409950c8e4adc96852922f151e661d25c90eaf`; exact manifest bytes SHA: `89d48df832f0a7fc12875af715bfa5fc03bb9ea096fdf8667e056d37c895130b`.
- 228 published knowledge records, nine pilot towns, 169 graph entities and three edges. These are source statements, not human review or exhaustive coverage. `max`/`buzz` remain 300 authenticated HTTP requests/minute and eight concurrent; other identities 60/4. Credentials were not rotated.
- **Resume branch: `council-owner-override`** in `GiraeffleAeffle/ledger-of-life`. The commit containing this brief captures all current source/tests/docs and the completed merge of the immutable 0.3.1 source. Obtain its exact SHA with `git rev-parse HEAD` and compare to the final handoff SHA reported to Main. Package version 0.3.2 is only a source version: tracked `out/` still contains the sealed **0.3.1** data.
- Live-evidence branch: `civic-mcp-0.3.1-evidence`, `0ee1424c4584b4c1eb60805cfa40f5dbbdcdb83d`, [draft PR #8](https://github.com/GiraeffleAeffle/ledger-of-life/pull/8). Do not advance the immutable live source branch to a documentation commit. Its guide was integrated here, with current Lease/signing corrections.
- Reproducibility branch: `pilot-reproducibility`, `f1ce5a50562e9a3ea6ce6db3d4c136cb02a0ac24`, [PR #5](https://github.com/GiraeffleAeffle/ledger-of-life/pull/5). Runbook: `stadtstack-data/docs/PIPELINE_RUNBOOK.md`. Historical replay source `7f9b8f12ee7c5de5833088d029799db3ff7f83b6` rebuilt all 42 original 0.3.0 files and exact manifest offline with zero model calls. This is not a 0.3.2 replay claim.
- R1 is a **separate unverified WIP**: branch `rebuild-r1`, `ae1fb256e7b9c179832ff42eb66d60b08f3a84f7`, brief `stadtstack-data/docs/R1_STATUS.md`. Do not replace this v2 pipeline with that unfinished v3 branch or assume its read filters are wired. Its source families/queue/parser/assessment integration still need work.

The public identity, source pins, owner decisions and prior change baselines are in [handoff-0.3.2.json](../reports/handoff-0.3.2.json). Exact release/signing/acceptance details are in [handoff-release-0.3.2.json](../reports/handoff-release-0.3.2.json). No credentials or private signing material are in either file.

## 2. Stop state and verification truth

All Mac pipeline workers were told to finish only their current atomic edit, then freeze. Policy, Facts, Graph, retained-lineage/coverage, and signed-reader/graph workers have saved their work and reported no active jobs or model calls. No worker may resume from the Mac after this handoff. The release operator performed no 0.3.2 signing or cluster mutation.

A read-only VM process observation at **2026-10-11T22:34:25Z** found **zero named civic extraction/model/worker entrypoints** on `codex-workstation`. No new queue was started or modified. Historical extraction was already complete; unselected historical documents are not newly running jobs. Keep acquisition/native execution **OFF** until the VM lead explicitly resumes after the gates below; there is no invented queue-pause receipt.

**The current WIP has not been compiled or tested.** The last executed source gate, before the later repairs and new retained/read-view work, ran 56 files: **778 tests, 703 passed, 75 failed**. TypeScript passed before those later waves. Neither result establishes readiness of this handoff. Workers did not rerun tests. No final security/semantic approval covers the newest combined snapshot.

The complete old failure output is already on the VM, private mode 0600:

`/home/max/stadtstack-ops/civic-pipeline-handoff/source-gate-before-repairs.txt`

SHA-256: `6a7a7944e5428027d5c435e374ae238631cb015d33c6301cbb00d278e5427166`.

Reported failures were addressed in code/fixtures (authority contention and inode replacement, source-role ordering, canonical temporary paths, prompt size, registry evidence, Solarpark ranking, publication fixtures), but the fixes are **unverified**. New retained-only and signed-mask regressions were subsequently added. Fix real failures; do not suppress gates or weaken assertions just to obtain green output.

## 3. Decisions already made

- **0.3.2 production processing is VM-only and Codex-only.** Current code deliberately rejects Mac/native Haiku execution. Broader R1/OMP/Haiku planning is not permission to activate another provider in this lane. Do not copy authentication or print tokens, headers, requests or raw model logs.
- Authority ID: `owner-2026-10-11-codex-workstation`; state directory: `/home/max/.local/state/stadtstack-data/civic-policy`. Machine-ID **file bytes** SHA-256: `84e44b05b75fbed614c6a2e74690d2580c0035039055077acf22b6ba68f24dfd`. This task has **not provisioned** the new production policy authority. Missing, foreign or unavailable authority fails closed; never silently recreate lost inventory or objection state.
- Main explicitly authorized **unchanged authenticated 0.3.1 knowledge retention**, preserving original claims, gates and source/model/judge clocks, with current host/opt-out checks at publication. **Do not reacquire all 228 historical sources and do not invent prepared/HTTP/model receipts.** Fresh acquisition is only the bounded 0.3.2 targets below.
- One explicit `retainedPublication` baseline contains the real sealed manifest plus `knowledge/{records,coverage,registry}.json`, admitted record IDs and original evidence hashes. Publication admission rejects a supplied baseline when no record uses retained admission. It precedes actual native runs in approved order. A new withheld candidate does not erase an older admitted fact. Canonical derived identity projection is separate from original claims/gates. Retained-only republication needs no dummy model run.
- Native `textLineage` is separate and nullable. Retained lineage/historical coverage preserve real public member identities/counts/clocks. The cross-cohort unique document union is **unknown** without old private inventories; never add full frontiers or reconstruct them from the published subset.
- Hosted serving uses a sealed publication plus a signed administrative mask, **not** per-request VM policy RPC or filesystem reads. Opt-out republication within 24 hours is a target. Administrative withholding is not legal withdrawal, deletion or supersession.
- Storage backup purchase/provisioning remains **deferred**. No outreach to municipalities, Rateo, Kair, STIC or HANGAR was sent or authorized by this work.

## 4. Code map and current boundaries

- `civic-opt-out.ts`, `civic-docker.ts`: authoritative inventory, objection state, provenance roles, durable scratch/process/container lifecycle and honest partial purge. Actual Docker Engine behavior was not exercised here; only synthetic Engine tests were added.
- `polite-fetch.ts`, `source-policy.ts`, `source-observation.ts`, `district-source-adapters.ts`, `district-crawl.ts`: real immutable observations, source gates and exact scoped targets.
- `district-registry-config.ts`: Git-authenticated owner-approved bounded registry metadata. **Prepare/run/assemble/worker now require a pinned registry descriptor**, not an arbitrary/default registry file.
- `prepare-knowledge.ts`, `retained-knowledge-lineage.ts`, `retained-knowledge-coverage.ts`, `district-release-composition.ts`, `district-publication.ts`: explicit native/retained intake and honest coverage. Retained baseline uses only four public artifacts, not historical private crawl/run/quarantine/preparation inputs.
- `district-publication-policy.ts`, `district-publication-inputs.ts`, `district-publication-plan.ts`, `publish.ts`: exact source ancestry, native prepared vs retained-publication receipt kinds, immutable publication cohort, real predecessors and original clocks.
- `district-reassess-relations.ts`: current v2 controls preserve actual HTTP/prepared/operator-configuration ancestry. Retained/Git roles are not native control authority. Model scratch gets only selected prepared-text bindings; artifact ancestry remains complete. Historical v1 stays unchanged.
- `planning-stages.ts`, `case-supersession.ts`, `changes.ts`, `query-cases.ts`, regional statement modules: shared Sage semantics. `district-stage-evidence.ts` is the unchanged literal finalization predicate moved out of processing code, without a compatibility re-export.
- `civic-revocations.ts`, `mcp-revocation-config.ts`, `mcp-source-identity.ts`, `mcp-revocation-view.ts`, `mcp-read-view.ts`, query/graph/server modules: signed startup state and cached administrative views. All 17 nongraph routes plus graph routes have implementations and new **unrun** tests. Nested source provenance URLs (snapshots, robots/TDM policies and locators) participate in host withholding; no new source IDs are invented. Empty signed masks preserve content. Different mask identities invalidate cursors even when visible content is unchanged.
- Coverage checks compare named count fields, not substrings of serialized administrative views: digest strings may contain arbitrary decimal sequences. Unevaluated faithfulness clocks are nullable, but never match retained publication origins, whose original clocks remain required.
- `replay-pipeline.ts`: executable replay v2 uses explicit managed intake/publication plans, no models or implicit old-cache materialization. Historical generation/archive-v1 remains a read-only audit path.
- `corpus-manifest.ts`: supplied native corpus inventory is separate from retained public fact lineage. Retained-only inventory has no fabricated body rows, indexes or generations.

Legacy implicit live collectors/evaluators, API-key fallbacks and ungoverned old-cache adoption were retired. Pure parsers and authentic historical evidence remain. Do not restore the old paths as a shortcut.

## 5. VM state and first commands

Host aliases `codex-workstation` / `codex-netbird` refer to the same VM, user `max`. Installed Node used by this pipeline: `/home/max/.local/share/mise/installs/node/24.21.0/bin/node`.

Historical processing tree: `/home/max/civic-knowledge-slice/stadtstack-data`:

- `cache/districts/raw`: historical source bodies/observations.
- `cache/districts/prepared`: historical preparation, not automatically admitted into new lanes.
- `cache/district-joint`: historical native results/answers/work plans.
- `cache/repro-input` and `cache/reassessment-input`: historical proof inputs.
- **New code's fixed prepared root:** `cache/districts/owner-policy-2026-10-11/prepared` under that historical tree. Do not confuse this with the older prepared cache.

Historical fresh-clone proof checkout: `/home/max/civic-repro-7f9b8f1/stadtstack-data`. New raw/artifact/result roots must be explicit fresh managed roots under the new checkout's ignored `cache/`; do not adopt nonempty legacy roots. Preserve old bytes and receipts.

Private resume metadata was transferred to `/home/max/stadtstack-ops/civic-pipeline-handoff/`: the gate log, original Solarpark excerpt/offset metadata, prior member/blob pins, earlier-manifest absence proof, legacy change baseline and owner authority decision. These are evidence/planning metadata, **not ready-made native execution receipts or permission to read old private inputs**.

Use a new checkout; do not reset an existing user's tree:

```sh
export PATH=/home/max/.local/share/mise/installs/node/24.21.0/bin:$PATH
git clone --no-hardlinks --branch council-owner-override https://github.com/GiraeffleAeffle/ledger-of-life.git ~/civic-0.3.2-resume
cd ~/civic-0.3.2-resume/stadtstack-data
npm ci
npx tsc --noEmit
```

Then run the source-only gate (the real-data MCP tools gate comes later):

```sh
node --input-type=module <<'JS'
import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=readdirSync('test').filter(name=>name.endsWith('.test.ts')&&name!=='mcp-tools.test.ts').sort().map(name=>'test/'+name);
const result=spawnSync(process.execPath,['--experimental-strip-types','--test','--test-concurrency=1',...files],{stdio:'inherit'});
process.exit(result.status??1);
JS
```

Resolve failures, review the complete source boundary, then record a clean tested source SHA. The newest source/tests are unverified, so this is a required implementation/debugging step, not a ceremonial rerun. Do not start native jobs merely because a WIP commit exists.

After source acceptance, explicitly provision the policy authority once (or verify its real existing receipt without resetting it):

```sh
node --experimental-strip-types src/civic-opt-out.ts provision \
  --authority-id owner-2026-10-11-codex-workstation \
  --state-dir /home/max/.local/state/stadtstack-data/civic-policy
```

Retain the returned authority SHA in actual plans. Interrupted managed scratch is recovered only with the real pin:

```sh
node --experimental-strip-types src/civic-opt-out.ts recover-scratch \
  --authority-id owner-2026-10-11-codex-workstation \
  --state-dir /home/max/.local/state/stadtstack-data/civic-policy \
  --authority-sha256 "$AUTHORITY_SHA256"
```

## 6. Exact remaining 0.3.2 production steps

1. **Source gates and review** above, including retained-only intake/publication/replay and signed revocation read surfaces. No current green seal exists.
2. Build a genuine `operatorRegistryConfigImportSchema` descriptor from the approved committed `stadtstack-data/sources/district-registry.json`: actual commit/tree/blob proof, schema-contract SHA, owner approval and complete declared endpoints. Its managed configuration root must be separate from raw/output roots. `district-registry-config.ts` is the canonical codec; never manufacture Git object IDs or HTTP receipts.
3. Reacquire only these registered exact targets, one document/page/request/round per target:

| Municipality / source | Selector |
| --- | --- |
| `hoppegarten` / `hoppegarten-website` | `--page-root https://www.gemeinde-hoppegarten.de/news/1/1240589/nachrichten/kommunale-w%C3%A4rmeplanung-in-hoppegarten.html` |
| `ruedersdorf-bei-berlin` / `ruedersdorf-bei-berlin-website` | `--page-root https://www.ruedersdorf.de/meine-gemeinde/konzepte/kommunale-waermeplanung/` |
| `strausberg` / `strausberg-participation` | `--seed-document https://bb.beteiligung.diplanung.de/file/fnp-solarpark-flugplatz/e85e3cda-c72c-405f-9b66-bd1ac7d6c347` |

Invocation shape (variables must name newly prepared real descriptors/roots, not copied sample values):

```sh
node --experimental-strip-types src/district-crawl.ts \
  --registry-config-import "$REGISTRY_IMPORT_JSON" \
  --registry-config-import-sha256 "$REGISTRY_IMPORT_SHA256" \
  --policy-authority-sha256 "$AUTHORITY_SHA256" \
  --cache "$FRESH_RAW_ROOT" --output-root "$FRESH_INDEX_ROOT" \
  --municipality "$MUNICIPALITY" --source "$SOURCE_ID" \
  --page-root "$EXACT_REGISTERED_PAGE" \
  --max-documents 1 --max-pages 1 --max-requests 1 --max-rounds 1
```

Use `--seed-document` instead of `--page-root` for the PDF. Target results stay source-wide partial/not-assessed; do not claim full source completion.

4. Record the **actual new corpus SHA(s)** and obtain/record authorization for those exact scoped inputs. `district-corpus.ts` currently permits only the old two historical corpus hashes; a caller-selected new digest cannot bypass that guard. Add only actual approved new hashes after acquisition, review/commit the change, and use that tested code. No fake temporary allowlist or wildcard.
5. Prepare and extract using the pinned admitted registry input descriptor (raw Git-approved descriptor or managed operator pin), not `--registry`:

```sh
node --experimental-strip-types src/district-extract.ts prepare \
  --index "$NEW_INDEX" --corpus-sha256 "$ACTUAL_NEW_CORPUS_SHA256" \
  --raw-root "$FRESH_RAW_ROOT" \
  --registry-config "$REGISTRY_DESCRIPTOR_JSON" \
  --registry-config-sha256 "$REGISTRY_DESCRIPTOR_SHA256" \
  --max-documents-per-municipality 1
node --experimental-strip-types src/district-extract.ts run \
  --prepared-plan "$PREPARED_PLAN" --prepared-sha256 "$PREPARED_PLAN_SHA256" \
  --registry-config "$REGISTRY_DESCRIPTOR_JSON" \
  --registry-config-sha256 "$REGISTRY_DESCRIPTOR_SHA256" \
  --out "$FRESH_NATIVE_RESULT_ROOT"
```

Current text windows are contiguous 12,000 UTF-16 characters, overlap 800, absolute document budget 320,800. The larger window keeps the Solarpark header date and reduction passage together without stitching quotes or borrowing a date. Fresh generation/judgment must really pass; model/permission failures pause rather than silently retry or switch providers.

6. Import the authenticated old public baseline and retained city/core members into proper managed roles; compose with the actual admitted new native records. The old 228 need no fresh prepared receipts. Build pinned `prepareKnowledgeOptionsSchema` and `PublicationPlanSchema` inputs. Prior source is `47083b92…`; the earlier private signal snapshot is commit `67b6b3604d6ec19c7981fe0f1880e2fac11f7b2c`, which **has no release manifest** and uses authenticated Git snapshot proof solely for historical changes. Current city snapshot evidence is `ae44a163b96e5b8aca4a397b8e0f31268f6a7ee9`; preserve original change clock `2026-10-10T21:56:45.237Z`. Exact member/blob pins and observed diffs are in the handoff report. No old private row may enter public output by that role.

```sh
npm run knowledge:prepare -- --config "$INTAKE_PLAN" --config-sha256 "$INTAKE_PLAN_SHA256"
npm run publish -- --plan "$PUBLICATION_PLAN" --plan-sha256 "$PUBLICATION_PLAN_SHA256"
```

Publication writes a separately managed candidate, not historical `out/`. Preserve all original core facts byte-identically. Produce source-policy receipts and the actual publication-input cohort, then validate/replay the entire candidate and exact manifest.

7. Complete all named acceptance below, then run the full MCP tools gate against the actual new candidate:

```sh
export STADTSTACK_MCP_RELEASE_DIR="$ABSOLUTE_GOVERNED_CANDIDATE"
node --experimental-strip-types --test --test-concurrency=1 test/mcp-tools.test.ts
```

The tools test injects a real ephemeral signed test cohort for the actual release ID; this is not a production mask. Refresh the three graph-description example edge IDs if final identity/evidence projection changes them. Never invent a replacement record ID or a positive graph result.
8. Freeze reviewed source/data/image/signing inputs and obtain a fresh application GO. Only then follow the governed release procedure below. Preserve 0.3.1 until accepted cutover.

## 7. Sage acceptance and remaining backlog

Required before claiming 0.3.2:

- Solarpark furthest stage **draft, 2025-08-07**, not early consultation; stage date must be bound to that stage, not borrowed solely from a document-version date.
- [Fixed correction fixture](../reports/correction-solarpark-0.3.2.json): old record `knowledge:strausberg:312ccd92c53c6241c52e3349`, old evidence `a10003da8af7d63973ba0fc32a6ee6d9218a393afd2a17889dabc42bf6b838e6`; **68.6 → 41.5 ha**, scope `fnp:base:amendment:10`. Expected new PDF SHA `6b3d0a467c73bac1617dbcc88a692d9cc3319ec2d17ca22dbd3e5d91c764ea55`. Admit a real matching record, expose current/history, emit **superseded, not withdrawn**, and retain both source attributions across export filters/pages. Approximate 48 MWp is not a new completed-generation claim.
- Rüdersdorf facts, with exact source evidence: January 2024 start, about 18 months, EWE NETZ, two suitability areas, at least five measures in five years. Do not replace these with locators or invent a day for month-only precision.
- Hoppegarten: all five directed memberships (Hoppegarten, Neuenhagen, Altlandsberg, Fredersdorf-Vogelsdorf, Petershagen/Eggersdorf), energielenker separately as contractor, mid-2027 as a planned imprecise target. 27 May 2026 is the source-page date, not completion. See [heat source requirements](../reports/patch-0.3.2-heat-source-requirements.json).
- AGS-scoped council-body aliases for Parchim, Ludwigslust and Mölln, without merging different legal bodies/towns.
- `get_changes`: real reason, prior version/evidence hash, knowledge included; publication removal distinct from sourced legal withdrawal/supersession. Administrative mask changes are not civic events.
- Honest graph examples and all-source/mask read acceptance. Record/source/core/originalRecord/case history/changes/feed pointers/counts/cursors must not bypass masking.

Still open beyond this patch: broader municipality/source coverage (MOL pilot remains three of 45), useful register-backed operators/funding/membership graph relations, structured R1 sources and actual value test (target at least 30/60 versus the frozen 12/60), reliable decision-status/proposer attribution, location-based joins without street-name false matches, semantic search and alerts/subscriptions. The frozen seven graph comparisons showed zero incremental utility; do not relabel that result. R2 has evidence-as-choice/triage/batch and attributed Rateo heat/solar inbound; Kair/Braid inbound later. A receiving/second test instance and external correction-propagation test are not provisioned by this patch. Strausberg council collection now has the owner-policy code path, but no new council crawl or council publication was performed in this handoff; keep that acquisition scope explicit in future planning.

## 8. Robots and opt-out lane state

Owner decision of 11 October: registered public civic sources may override robots guidance, while retaining the observed allowed/disallowed/unavailable result and the separate owner decision. No auth, paywall, CAPTCHA, proxy/IP/UA evasion. User-agent includes the real Stadtstack contact URL. Defaults are two seconds, municipal hosts five seconds; one connection/host and persistent denial/backoff semantics.

Operational `official_work` classification can use the explicit owner TDM decision. Third-party/mixed/unknown documents remain excluded under disallowed robots or reserved TDM; unavailable/malformed TDM fails closed. Invalid 304 declarations cannot erase an earlier reservation. New excluded raw copies are discarded. Public output is facts and short quotes, not full source documents. These are operational policy labels, not legal clearance.

An objection stops new acquisition/cached reuse/model/preparation/reassessment/publication immediately. Managed raw/derived/scratch copies are inventoried for purge within seven days; incomplete purge remains **partial**, not falsely successful. Nonempty old caches are not automatically enrolled or claimed purged. The new authority/lane has not been run in production here. Tests do not prove real production purge or Docker recovery.

## 9. VM-only governed release and signing

Read `~/stadtstack-ops/MAIN_HANDOFF.md` first. Privileged cluster operations use **only**:

```sh
sudo stadtstack-session exec <reviewed-and-approved-application-command>
```

A busy Lease or incident means stop and coordinate. No manual directory lock, persistent/admin kubeconfig, original infra script, direct old Mac `deploy/mcp/session.sh` route, or replay of an earlier application GO. The checked-in deploy/chart/smoke code includes the old 0.3.1 operator path: **its VM/Lease adaptation and 0.3.2 data/cohort packaging still need review**. There is no approved final VM application command in this WIP; do not pretend the template above is deployment authorization.

The final image must contain only the validated public candidate at a separate path such as `/app/release`; `STADTSTACK_MCP_RELEASE_DIR` must be absolute and cannot select package `out/`. Do not copy ignored raw/model caches into an image or Git. Bind exact source SHA, literal version/tag, multiarch workflow result, tagged immutable image digest, whole-data manifest and public input cohort. Preserve bearer identities/digests and current limits. Run fresh governed exact-image acceptance before mutation, then public version/data acceptance and independent ReadyPod image identity correlation; preserve their different evidence scopes.

### Signer availability: superseding owner decision

Initially the signer was Mac-Keychain-only. **Main then explicitly authorized and CivicMCP actually provisioned an independent signer on the VM**, resolving that availability blocker without copying the Mac key:

- VM private key: `/var/lib/stadtstack-signer/revocation-signer.pem`, root-owned 0600, parent directory root-owned 0700. This is the specifically approved **root-only PEM option, not age encryption**. Never print, copy or commit its bytes.
- Public receipt: `/var/lib/stadtstack-signer/revocation-signer.public.json`.
- VM key ID: `ed25519:8393ad2b0087229073c57103c2e47a1b6f6e987c781b00bcbbaae060aa5ceebd`.
- Mac key remains solely in Keychain, service `org.stadtstack.mcp.revocation-signer`, account `max`; its ID is `ed25519:9a687b0082820b1df5743cd2faa1150bd38171fab50d8248d6cad28aca59ab1e`.
- **Trust must include both public pins** from [handoff-release-0.3.2.json](../reports/handoff-release-0.3.2.json), so either separately held key can sign. No production 0.3.2 payload/cohort has been signed yet.

Canonical signing API is `src/civic-revocations.ts`: `signRevocations(payload,keyId,privateKey:KeyObject)`, `revocationKeyId`, `compareRevocationTargets`, `revocationHostFromUrl`. Use a reviewed root-controlled signing invocation that loads the VM key internally; do not pass private material via arguments/env/stdout, install dependencies as root, or invent another serializer. The signed artifact has **no appended newline**. Pin the SHA of the **entire signed artifact**, not just the payload. Payload uses actual release ID, administrative UTC time/sequence, and explicitly approved sorted targets.

The required configuration cohort is:

```text
STADTSTACK_MCP_REVOCATION_TRUST_FILE=/run/config/mcp-revocations/trust.json
STADTSTACK_MCP_REVOCATIONS_FILE=/run/config/mcp-revocations/revocations.json
```

Both files must resolve into one governed read-only physical revision, separate from data and the bearer Secret. Startup verifies once, then serves from memory; update through a governed single-replica **Recreate** rollout. No mixed cohort, automatic permissive rollback or request-time policy filesystem read.

**Shipping without active revocations:** after checking current objections and receiving approval for no targets, a genuinely signed `targets:[]` cohort for the exact new release is supported. This is an empty *signed* mask, not an unsigned fallback. If no approved signing/cohort is available, **defer 0.3.2 and keep 0.3.1 live**. Do not silently disable signature requirements; that would require a separate explicit policy decision and reviewed code change.

## 10. Final handoff discipline

All three pipeline Mac worktrees must be represented on origin; generated `node_modules` symlinks are not source and are intentionally not committed. Restore dependencies with the lockfile. No native job, watcher or child from this pipeline is intended to remain running on the Mac. Continue from the VM lead, not by waking the stopped Mac workers. Keep failed evidence and original snapshots; do not rewrite historical reports to describe unperformed 0.3.2 work.
