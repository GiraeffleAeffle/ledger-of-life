# R1 source-fetch security cutover — 2026-10-22

## Scope and hold

Addresses SS-01 from `/home/max/stadtstack-ops/reviews/scrape-safety-20261022.md`.
This change is prepared on `r1-fetch-identity`, based on runtime commit
`2af157bed33963171c06613a51d1dd9250615d89`, in a separate private worktree.
**It does not lift the acquisition hold or authorize production execution.**
Main applies the reviewed runtime and genuinely issues the security-release
record before the pending PEGEL request. No production DB/CLI, source-network,
Docker, systemd or installed runtime authorization was mutated by this slice.
The source campaign/catalogue pin remains
`5a9a14c105195043fda1c4f9aa8b9f6697e33c3d`; do not relabel it as the security fix.

## Transport cutover

`src/polite-fetch.ts:wireRequest` continues to send `Accept-Encoding: identity`.
Before reading a body or returning a successful wire result it rejects every
present Content-Encoding except case-insensitive `identity`, with typed
`PoliteFetchError('unsupported_encoding')`. Empty, br, gzip, deflate, stacked
and unknown values are refused. The zlib import and decoder branch are removed.
Identity wire bytes are representation bytes, so the existing Content-Length
and streaming maxBytes limits apply directly to both; there is no expansion.
Rejection settles before transport destruction, preventing an end/error race
from resolving an oversized or refused response. Other admission, DNS,
redirect, pacing, timeout, policy and custody gates are unchanged.
For encoded error responses, status and Retry-After are accounted header-only
before rejection. The scheduler persists403/429 cooldowns and5xx backoff/circuit
state even though the response cannot reach its successful onResult callback.
An absent body cannot be interpreted as a robots policy.
Failure observations may be retained by the ordinary failure path; refused
representation bytes never enter CAS or a successful observation.

The fixture uses a real loopback HTTP server through the existing private wire
seam (production URL/DNS admission is not relaxed), spies on all three zlib
decoder factories, checks refusal on200/302/404, absence/identity success,
no CAS/success observation, and declared/chunked byte bounds. Explicit cases
cover `' identity '` (HTTP OWS normalized by Node to identity) and `'identity,'`
(refused). A scheduled real-server regression verifies403/429+br cooldown,
503+gzip Retry-After/backoff and three-failure circuit, no successful callback,
and persisted restart refusal without a second network request.
Final fixed polite-fetch SHA256:
`1a9e6bd01fc01f1a3bb7883a466949400a369aa984895405cb0d9b52b2ce7da2`.

## Measured contract impact: all14 actual functions

Measurement uses the exact14 functions in window20/contracts.mjs, historical
blob hashes from2af157b and current worktree hashes, including complete object
return values, not selected leaves. Evidence:
`/home/max/.local/state/stadtstack-data/r1-fetch-safety-evidence/contracts-cooldown.json`
SHA256 `909e35356e6365174d1616f5e52efb066525bf57978f689a88bc113dc8e763c1`.
Its companion `measure.mjs` records the reproducible callback/hash method.

| Function | Result |
| --- | --- |
| `preparationExtractor` | unchanged |
| `residualPreparation` | unchanged |
| `residualJob` | unchanged |
| `jointExtraction` | unchanged |
| `assessmentQueue` | unchanged |
| `assessmentB` | unchanged |
| `acquisition` | CHANGED |
| `policyRefresh` | unchanged |
| `structuredStateGauges` | unchanged |
| `operatorRegistry` | unchanged |
| `parserOutput` | unchanged |
| `parserIsolation` | unchanged |
| `ompOutput` | unchanged |
| `ompRunner` | unchanged |

Exactly acquisition hashes polite-fetch.ts. Acquisition changes from
`9815cc1786e5a758f809a7c17d7958462a7b34a39ca353a0bbd1d53b9087e1fa`
to `b29c293b4ff6ee6c31a7039b45f8cf1e0f73dc68774552e5aa29de2951fec0d1`.
The13 other functions are equal, including parser, structured mapping,
assessmentQueue/B and OMP output/runner. Historical window20's
ff1980b1→9815cc17 transition stays historical, not rewritten.

### Minimal governed path and exact amendments

1. Main reviews/integrates this branch at a new runtime HEAD; separately retains
   the frozen source pin/catalogue/review and FULL/runtime43 bytes. Step8 is
   offline: `assertStep8ProcessingPin` in `src/r1-step8-current-policy.ts:45–54`
   checks confirmed catalogue/profile assessmentQueue/B/OMP identities, not an
   acquisition-equality assertion. The acquisition-only fix does not require
   changing that processingCommit. Existing sealed facts retain their lineage.
2. Old structured renewal `operator.mjs:14–19` in
   `r1-step8-structured-renewal-20261021/` requires acquisition equality with the
   old processing pin and therefore refuses this fix. Do not remove that check,
   rerun that used single-use controller, retag an old job, or invent a receipt.
   StructuredRenewal owns the replacement
   `continuation-20261022/{rest.mjs,security-gate.mjs,REST_RUNBOOK.md}` and the
   companion structured-selection changes. Its declared interface requires a
   separate-worktree committed `r1-step8-source-fetch-security-release-v1`,
   truthful Main fix review/gate summary pins, exact Node binary/hash, exact
   fixed polite-fetch hash and new acquisition hash. This document is not that
   approval. Main must review its implementation independently.
3. Pending PEGEL: retain the old held job/spec and its request history. Derive a
   **new canonical acquisition job** with the same exact approved selector under
   the new acquisition contract, within the genuine one-extra-PEGEL-request
   owner authority and existing bounds. No resume under a changed contract.
   Its fresh StepReceipt must carry the actual new semantic contract and fresh
   policy/HTTP/custody evidence. Structured parse/discovery contracts are
   unchanged; exact receipt dependencies, hashes, scope, policy currency and
   genuine current structured selection remain mandatory. The original
   `authenticateStep8StructuredSelection` checks exact ordered run/receipt
   membership plus issued renewal/owner controls, not acquisition equality to
   the historical source processingCommit. Never replace old receipt versions
   merely to make an ancestry check pass. Use the companion selection tooling
   to authenticate the new acquisition/security release and bind both K1/K2.
4. Finalize a fresh complete step8 input with that issued selection and ordered
   run IDs. Review its whole SHA and current clocks. Amend only
   `r1-step8-production/retry-v3.sh:EXPECTED_RUNTIME_HEAD` to the exact reviewed
   integration HEAD once known; the existing old literal is deliberately left
   fail-closed by this slice. Its `EXPECTED_PROCESSING_COMMIT` stays5a9a14c.
   Main runs the normal offline precheck/gates before managed execution.
5. Window20 refresh tooling is **not needed again**; its contracts.json,
   candidate/review/receipts and frozen source drivers remain byte-exact and
   drained. Do not run27 source-driver checks against the new runtime.
6. Step9 has a separate explicit blocker: private
   `r1-step9-production/window.mjs:34–36` still allows exactly four transitions
   against window20 and would refuse the additional acquisition change. A
   separate review must add this exact acquisition hash to EXPECTED in the14
   function ordering, amend its focused tooling tests/runbook, and produce fresh
   measured candidate/plan/activation records. Keep the old baseline and all
   unrelated equalities. This slice changes only its Node launchers, not that
   contract gate. Later model-runtime edits require their own measured amendment.

## Node inventory, implemented switches and pin boundaries

Node24.22.1 is installed under mise and actually ran the focused tests,
TypeScript and contract measurement. Exact executable:
`/home/max/.local/share/mise/installs/node/24.22.1/bin/node`, SHA256
`e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`.
No global mise configuration or installed24.21.0 directory was changed here.

| Reference family | Disposition / governing reason |
| --- | --- |
| Package `scripts/r1-verify.sh:13` | Switched to24.22.1 in this branch. It is an executable processing-distribution file, so integrate/approve the new runtime HEAD, not the old source pin. |
| Private `r1-step8-production/retry-v3.sh:10` | Switched to24.22.1; runtime HEAD gate retained pending Main review. Active RUNBOOK section documents the hold. |
| Private `r1-step9-production/main-sequence.sh:6–7` | Switched PATH and NODE to24.22.1. |
| Private `r1-step9-production/sequence.mjs` | Replaced imported historical NODE with local24.22.1 constant; `successful` still imports shared helper. Fresh window candidate pins sequence/shell/runbook bytes. |
| Structured renewal upcoming PEGEL controller | StructuredRenewal owns local24.22.1 binary/hash gate; no shared-helper repin. Old W/operator and C/recover plus their runbooks/started receipts are completed historical controls, not active launchers. |
| FULL `run-source.sh`, `run-campaign.sh`, `stage-lib.mjs`, README and runtime43 | Historical/inactive, unchanged. Main confirms no source drivers will run again; stop-campaign remains. Old source code guards intentionally refuse new runtime HEAD. |
| `r1-window16/files.mjs:10`, older windows10–19 files/helpers/runbooks and window20 RUNBOOK | Historical pinned controls, unchanged. New controllers must not import their old NODE constant. |
| `r1-step8-production/main-sequence.sh`, `retry-workers1.sh`, old RUNBOOK command blocks | Archival/inactive, unchanged. main-sequence explicitly refuses execution/sourcing before environment changes. |
| Old B diagnostic directories (model, v2, no-prose/r2, escalation, classification-reasoning, cross-locator), review3–7 stage-lib/run-source/run-campaign copies | Historical/parked, including `/opt/node-v24.21.0...` shebangs; unchanged and not authority to rerun. |
| `src/district-model.ts:120` | Deliberately unchanged per Main. Sanitized PATH for `/home/max/.local/bin/codex` provider-child execution, not municipal fetch. Measured consumers are **residualJob, jointExtraction, assessmentQueue**, not B/OMP. Changing it also breaks step9's protected producer-file check unless deliberately amended. Provider connection targets are owned by Codex/OpenAI CLI; exact endpoints are not fixed here. |
| `src/district-haiku-bridge.ts:162` | Deliberately unchanged per Main. Native Mac sandbox Claude provider, SSH bridge and source-free sandbox probe environment, not municipal fetch; none of measured14 funcs hashes it. Exact provider endpoint is delegated to Claude, SSH target is the configured bridge. Not used for current VM native Sonnet lane. |
| Package `scripts/build-omp-b-image.sh:13`, docker/omp-b Node pins | Reviewed immutable container build/runtime, not host fetch Node. Changing builder bytes alters assessmentB/OMP contracts; no image build or review rewrite here. |
| `/etc/stadtstack/omp-b-review.json` | Binds image/runner/binary/resolver/daemon/socket, no host Node version/path field. Host resolver runs reviewed executable with PATH `/usr/bin:/bin`. Unchanged. |
| `/etc/stadtstack/parser-isolation-review.json`, Dockerfile.parser | Root review binds immutable image/runner, not host Node. Image base is separate Node22; review flags possible affected image. No rebuild or privileged review change here. Host fix does not patch container Node. |
| Systemd/hwmon | No24.21.0 reference found in inspected `/etc/systemd/system`, user units or `/run/user/1000/systemd/transient`; hwmon starts `/usr/bin/python3`, not Node. No service reload/restart. |
| `docs/R1_STEP8_OPERATOR.md`, `docs/PIPELINE_HANDOFF.md` | Active runtime guidance switched; old observed receipts remain historical. `docs/R1_STATUS.md` observed24.21.0 statement remains historical. |
| `docs/HOSTED_MCP.md`, deploy/bootstrap/remote install pins | Separate hosted-release installation lane, not an active R1 acquisition launcher; reviewed binary/bootstrap/runtime changes need their own deployment review. Not executed or changed here. |
| Processing identities, started JSON, prior replay/parse/tool receipts, archived worktrees | Historical evidence; never replace version/path fields to claim a patched historical run. |

`FULL/processing-identity.mjs` hashes executable/config files including package
scripts but does not fingerprint host Node binary/version. Thus changing the
verification script participates in the new runtime distribution identity,
not an unnoticed host-only edit. Private launchers are outside that manifest.
`requiredReplayRuntimeSources` in `src/replay-pipeline.ts:345–361` pins all src
TypeScript, taxonomy, package.json and the explicit step8 operator script group;
it does not pin retry-v3, r1-verify or private step9 launcher paths. New step8
receipts record actual Node/ICU/Unicode; replay enforces those exact versions.
Existing24.21.0 receipts therefore cannot simply replay on24.22.1. Create a
fresh candidate under the new runtime, do not rewrite the old receipt.

## SS-01 retrospective: retained evidence cannot establish response encoding

Read-only scan of the actual production checkout cache (no endpoint contacted):
859 observation JSON files, all since2026-10-13; 525 request JSON files
(277 mutable caches,248 immutable request evidence), zero JSON parse errors.
Observation dates: Oct13=238, Oct14=232, Oct19=39, Oct20=342, Oct22=8.
This includes refresh19/20 and Oct22 PEGEL/GENESIS (four observations each).
**None records Content-Encoding.** selected wire headers are in memory only;
FetchObservation/SourceObservation and request evidence omit this field.
Thus zero *recorded* non-identity responses is not proof of zero exposure.
The exact br/gzip/deflate/non-identity count is **unknown for every host**.
Observation counts are not unique requests: policy/admission failures can exist
without a network response. Status count is merely rows with recorded status.

| Host | Observations | Status recorded | fetched | not_modified | Request records | Non-identity actual |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `bb.beteiligung.diplanung.de` | 67 | 67 | 39 | 6 | 73 | unknown |
| `bob-sh.de` | 42 | 39 | 10 | 9 | 13 | unknown |
| `epaper.wittich.de` | 41 | 39 | 14 | 12 | 26 | unknown |
| `m.pegelonline.wsv.de` | 7 | 7 | 1 | 0 | 1 | unknown |
| `mil.brandenburg.de` | 6 | 6 | 4 | 0 | 6 | unknown |
| `parchim.sitzung-mv.de` | 75 | 75 | 24 | 0 | 48 | unknown |
| `ratsinfo-online.net` | 12 | 12 | 4 | 3 | 6 | unknown |
| `ratsinfo.gemeinde-hoppegarten.de` | 5 | 5 | 3 | 0 | 4 | unknown |
| `ris.ludwigslust.de` | 6 | 6 | 1 | 0 | 2 | unknown |
| `session.ratzeburg.de` | 6 | 6 | 2 | 0 | 4 | unknown |
| `sessionnet.owl-it.de` | 3 | 2 | 1 | 0 | 1 | unknown |
| `strausberg.allris.cloud` | 9 | 9 | 3 | 2 | 4 | unknown |
| `www.gaia-mv.de` | 28 | 5 | 0 | 0 | 0 | unknown |
| `www.gemeinde-hoppegarten.de` | 22 | 22 | 14 | 0 | 15 | unknown |
| `www.hagenow.de` | 8 | 3 | 2 | 0 | 1 | unknown |
| `www.ludwigslust.de` | 82 | 80 | 23 | 21 | 43 | unknown |
| `www.moelln.de` | 78 | 78 | 24 | 0 | 48 | unknown |
| `www.moelln.sitzung-online.de` | 9 | 9 | 3 | 2 | 4 | unknown |
| `www.parchim.de` | 36 | 36 | 10 | 0 | 19 | unknown |
| `www.ratzeburg.de` | 108 | 106 | 36 | 33 | 68 | unknown |
| `www.regionalstatistik.de` | 25 | 24 | 5 | 10 | 5 | unknown |
| `www.ruedersdorf.de` | 37 | 36 | 13 | 0 | 26 | unknown |
| `www.schwarzenbek.de` | 42 | 42 | 22 | 3 | 38 | unknown |
| `www.stadt-strausberg.de` | 105 | 103 | 37 | 31 | 70 | unknown |

All rows have zero persisted encoding fields. Full content-free evidence,
source paths and digest-transition witnesses:
`/home/max/.local/state/stadtstack-data/r1-fetch-safety-evidence/forensics.json`,
SHA256 `7719f87d048262cfdd766fdb585e7813b8e0d39ec016025633aee9fc91c72ce2`.
This cannot certify the host was never exploited; no compromise was established.

## SS-02 applicability and proposal (not implemented)

Yes: retained evidence shows changed source bytes after Oct13 subsequently
used in inference. Cross-root GET observations for the same Ludwigslust public
notices URL show SHA9882e66c… at Oct14 01:55 and SHA428136f9… at02:36;
both retained bodies hash correctly (542616/542612 bytes). Seventeen cached
inference records extracted Oct16 cite the new428136f9 digest. Ratzeburg RSS
shows SHAa6566867… Oct13 19:34 → SHAc94e8c5d… Oct14 07:13, both bodies
hash correctly (14891/14802 bytes); one Oct16 inference record cites the latter.
The forensic JSON preserves full hashes, exact paths, times and record IDs.
These prove differing received bytes and inference use, **not defacement,
semantic falsity or final release admission**. No R1 release is asserted.
Cross-root copies can differ by template/session, so an anomaly review is
needed before labelling the cause. There are two additional same-root GET
digest transitions (Parchim website and Rüdersdorf participation), with no
matching admitted cache-record source digest in the321 scanned residual/
assessment `.record.json` files. No new GET digest transition on Oct19/20
was found in this observation inventory; that is not universal source stability.
GENESIS POST changes are not classified as defacement: request selectors/body
and structured retrieval are distinct from same-representation GET changes.

Proposed before-release gate: retain prior representation by canonical request
identity (URL, method and selector-body digest); compare new bytes before
inference. Quarantine unexpected template/CMS replacement, executable/archive
MIME changes, large semantic or mass same-host changes, and newly introduced
high-impact stage/amount/entity/identity claims. Bind content-free alert and a
bounded private diff to old/new hashes and acquisition receipts. Require
independent corroboration or genuine human review for changed high-impact
facts; same-model faithfulness is not independence. Historical candidate input
review should cover the positive witnesses above and any admitted successors.
Keep release held on a credible source-compromise suspicion until owner review
and out-of-band municipality/vendor confirmation. No gate implementation or
unfounded claim of compromise is included in this security patch.

## Exercised checks and remaining operator boundary

Actual Node24.22.1, CPUs2–7, nice10, umask022:
- `node node_modules/typescript/bin/tsc --noEmit`: exit0, no output,23.25s.
- `node --experimental-strip-types --test --test-concurrency=1 test/polite-fetch.test.ts`:
  **82 tests,82 pass,0 fail/cancelled/skipped**,42.93s.
- All14 contract measurement: exit0; acquisition only changed.

`r1-fetch-safety-evidence/checks-cooldown.json` is a truthful assistant summary
of the corrected runtime's tool results, not a native Core receipt or Main
review. The previous checks.json/contracts.json remain historical evidence for
the first fix. Their earlier attempts record fixture type/settlement repairs
and a wrong-umask failed run before the original81/81 pass. The final82/82 run
includes the review-requested status-accounting and whitespace regressions.
No safety gate was relaxed. Loopback fixture transport is not a live request.
Private launchers/step8/step9/production/database/parser images were not run.
Main still supplies real review/security-stop release and final runtime HEAD,
reviews the renewal companion and fresh input, applies ordinary gates, and
executes the single bounded PEGEL path. This preparation itself grants no GO.
