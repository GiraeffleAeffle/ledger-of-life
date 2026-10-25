# GENESIS31231: separate structured v3 issuance and native execution

## Status and scope

This is preparation, **not issuance or permission to fetch**. No source request,
credential read, parser-image launch or production DB mutation is performed by
preparing the drafts. The standing source-fetch stop remains in force until Main
reviews and genuinely issues this new scope. No command here issues, resumes or
retries an authority. Issue only in a **separate authority worktree**, never main.

Owner: `r2-authorities/stadtstack-data/reports/approvals/r2-owner-approval-2026-10-24.json`,
SHA256 `fc7f7acd93a7ab1c6a3044e24367bec52891a0b96b9b3852276079b7f37ce8e4`,
`approved.structuredSources.genesisHousing`, owner bound
`2026-11-30T22:59:59Z`. This is GENESIS table **31231-02-01**, exact municipal
GEMEIN selections for all nine registered AGS, requested year **2024**, existing
owner-account policy only. No MaStR, district document allowance, model, paid API,
new robots/TDM exemption, table suffix, publication or policy-TTL extension.

The combined `sources/r2-structured-request-plan.draft.json` remains research
inventory. The executable GENESIS-only inventory is
`reports/r2-genesis-31231-request-plan-v3.draft.json`; its SHA is embedded in
`reports/r2-genesis-structured-security-release-v3.draft.json`. Both are unissued.

## Executor choice and minimal Core impact

Use the existing **R1 native acquisition and structured parser**, under a new
GENESIS-only controller (`src/r2-genesis-release.ts`,
`src/r2-genesis-executor.ts`, `scripts/r2-genesis.ts`). Do not reuse R1 security v2.
The R2 district executor is intentionally GET/HTML/PDF-only, authenticates
`approved.acquisition`, and deduplicates by URL; nine distinct POST bodies at one
URL are not its contract. It remains unchanged.

The necessary Core additions are trusted optional `AcquisitionWireControl` in
`district-r1.ts` and a credential-free second argument to PoliteFetcher's
`beforeRequest`: actual method, body and effective public-operation profile.
Existing one-argument callbacks remain valid. A URL-only hook could otherwise
mistake a source-controlled GET policy link to an allowed POST endpoint for that
POST. The GENESIS guard checks the actual wire identity and logs only its body
hash; it never receives owner headers/secrets. GET has no effective POST profile.
Native permission/selector checks and shared PG host-lane admission still run
first; the controller only adds admission/chunk/result custody and increases
the native pacing floor. This path additionally refuses redirects.
Non-controller callers retain their defaults. Native acquisition (and any
dependent contract) must use the freshly measured identity, never relabel old
queued jobs or receipts. `readHttpObservation` is exported without changing its
validation. No parser/gauge mapping, source-policy, owner-account, policy-receipt
or export-fallback logic is changed. Consult the fresh before/after measurement
for actual identity propagation rather than assuming its boundaries.

## Exact requests and caps

There are **19 declared references**, not 19 independent primary actions:

| Role | Exact GET | Response cap |
|---|---|---:|
| automatic policy | `https://www.govdata.de/robots.txt` |64KiB|
| automatic policy | `https://www.govdata.de/.well-known/tdmrep.json` |256KiB|
| primary licence | `https://www.govdata.de/dl-de/by-2-0` |2MiB|
| automatic policy | `https://www.statistikportal.de/robots.txt` |64KiB|
| automatic policy | `https://www.statistikportal.de/.well-known/tdmrep.json` |256KiB|
| primary terms | `https://www.statistikportal.de/de/open-data` |2MiB|
| automatic policy | `https://www.regionalstatistik.de/robots.txt` |64KiB|
| automatic policy | `https://www.regionalstatistik.de/.well-known/tdmrep.json` |256KiB|
| primary capability | `https://www.regionalstatistik.de/genesisws/rest/2020/application.wadl` |1MiB|

PoliteFetcher makes the six policy probes as needed. **Do not manually fetch
robots/TDM URLs as documents**; that would duplicate probes and change their
classification. Repeated genuine policy checks for different native town jobs
still count. Redirects, new origins and new machine-policy URLs are not implicit
allowances; an unplanned target holds before dispatch.

Then one anonymous POST, cap1MiB, no GAST or owner credentials:

```text
POST https://www.regionalstatistik.de/genesisws/rest/2020/metadata/table
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
name=31231-02-01&area=free&language=de
```

After actual metadata review, nine POSTs to
`https://www.regionalstatistik.de/genesisws/rest/2020/data/table`, cap4MiB each,
with the same content type and each exact literal body in the draft:

```text
name=31231-02-01&area=free&language=de&regionalvariable=GEMEIN&regionalkey=12064472&startyear=2024&endyear=2024&compress=false&transpose=false&job=false&format=datencsv&quality=on
```

The other exact AGS are12064227,12064428,01053100,01053090,01053116,13076090,
13076108,13076060, paired with their frozen municipality IDs in the draft.
The native selector's legacy `publicOperation:genesis_guest` chooses the existing
Core profile; for these exact data endpoints **Core requires and injects the
existing owner account**, never falls back to GAST. Metadata is outside that
account/robots exemption. No credential enters a body, draft, CLI argument or log.

Hard campaign limits: **13 primary actions**, at most8 wire attempts per action
and **104 overall**, including policy/failure attempts;128MiB observed response
bodies; one in flight; at least5s **after the previous wire response finishes**
(stronger than5s start-to-start);2h overall/release wall window;0 redirects,
0 automatic retries, exactly9 first-attempt native acquisition jobs,0 model calls,
0 paid micro-USD. Reusing a primary or policy URL within one action refuses. The
last received chunk that crosses a byte boundary is durably counted as refused;
it is not stored/admitted and the phase stops. No undercount/reset on a hold.

The2h bound includes Main's metadata-review pause, not just data fetch time. A
120s reserve before every wire admission prevents starting an owner request too
near its deadline. Caps are conservative ceilings, **not measured duration or
availability**. A successful unchanged-policy campaign may need about37 wire
requests if both policy probes repeat for every town [INFERENCE, not a promise].

## First-request prerequisites

Before even the first public licence GET, the controller requires:

1. Main's genuinely committed ISSUED v3, exact owner/plan/runtime/code/registry
   bindings, current clocks and `sourceFetchStopLifted:true`; valid source/owner
   bounds. R1 v2 and district v3 are rejected.
2. A Main review-evidence pin whose actual JSON binds `approvedBy:Main`,
   `verdict:approved`, current `codeSha256` and `planSha256`.
3. Exact stock Node24.22.1 binary/path/SHA from the new draft. Use a clean Node
   environment, no custom loader/import or credential-bearing environment/logs.
4. Newly installed **root-owned current parser authorization**, pinned in the
   release, matching `runtime.contracts.parserIsolation`; a source-free sandbox
   readiness command must report Node `v24.22.1`. Real-image/security/cleanup
   gates must be reviewed by Main before installation/issuance. No old review
   is grandfathered in; no sandbox is launched by `prepare`.
5. A genuinely admitted registry descriptor for the draft's exact registry
   configuration SHA, all nine scopes and the current operator-registry contract.
6. Current public robots/TDM/origin policy for all involved hosts. The real fetch
   path observes it before primary requests. Regionalstatistik metadata/WADL may
   be blocked: the old owner API exemption does **not** authorize metadata, and
   no new exception is granted here. Stop, do not send a test data POST to bypass.

Owner credentials are loaded **only just in time by PoliteFetcher's existing
owner-account branch**, after selector/policy checks, for the nine exact data
POSTs, and cleared by that branch. The controller has no credential reader or
readiness probe. Anonymous preflight, metadata review, and rejected/non-attended
acquisition invocations do not read them; a missing account holds the applicable
data POST without a GAST fallback.

Read-only inspection during preparation found `/etc/stadtstack/parser-isolation-review.json`
still reviewed2026-10-17, image
`sha256:08cbb5205d0dd99f6518227b850f00c432f7dbe654cc10e59184dbf59bdfc2dc`, runner
`287e701cdbddef1c22b2d202b54983467651eccfe43ead8cb67365ead00a4942`.
This is **not** new GENESIS/R2 parser coverage. Main must replace it through the
reviewed gates; do not edit it here or claim its image is patched.

## Main-only sequence after review and issuance

Use the reviewed/integrated immutable checkout. Re-run `prepare` in a fresh
patched Node process if any code/registry/root differs from this review draft.
The source manifest covers src/scripts/docker, package/lock/Docker inputs and
host groups, in addition to the native contract and registry pins. Reports/docs
are not executable security code. Draft generation writes new files only; it
cannot overwrite an issued record.

```sh
NODE=/home/max/.local/share/mise/installs/node/24.22.1/bin/node
PKG=/home/max/.local/state/stadtstack-data/r2-genesis-release-code/stadtstack-data
"$NODE" --max-old-space-size=3072 --experimental-strip-types \
  "$PKG/scripts/r2-genesis.ts" prepare --output "$PKG/reports"
```

The delivered draft is already generated, so a subsequent preparation needs a
**new** private output directory. After review, Main copies the reviewed draft to
its separate authority worktree, supplies only genuine issuance clocks/review/
parser/registry evidence, removes `requiredIssuanceEvidence`, sets statusISSUED,
approvedByMain and the lifted-stop boolean, adds `validFrom`, `expiresAt`,
`reviewEvidence`, `parserAuthorization`, `registryDescriptor`, and commits it.
Its window is at most2h and cannot exceed the actual owner expiry. No issuance
helper or sample issued record is supplied.

The following paths are the planned new authority files, not claims that they
already exist. Only Main creates them. Derive SHA variables from actual bytes,
never paste a draft SHA as an issued SHA.

```sh
AUTHROOT=/home/max/.local/state/stadtstack-data/r2-genesis-authorities
RELEASE="$AUTHROOT/stadtstack-data/reports/approvals/r2-genesis-structured-security-release-2026-10-24-v3.json"
read -r RELEASE_SHA _ < <(sha256sum "$RELEASE")
"$NODE" --max-old-space-size=3072 --experimental-strip-types \
  "$PKG/scripts/r2-genesis.ts" preflight \
  --authority-root "$AUTHROOT" --release "$RELEASE" --release-sha256 "$RELEASE_SHA"
```

Preflight makes three content GETs plus automatic policies, then one metadata
POST. WADL XML and metadata JSON discovery run only through the fixed native
worker **inside the parser sandbox**, with genuine source bytes, actual HTTP
bindings and newly created policy receipts. WADL's complete bounded3-page
catalogue must evidence the exact housing metadata POST. Metadata sandbox
outputs must reproduce all9 exact bodies; district/unknown table/status/layout
outputs refuse before any data job. No raw XML/JSON source is host-parsed by the
controller. Accepted source-derived policy/discovery artifacts stay in their
managed source-bound lane; the control result retains only their pins.

Preflight writes one immutable `preflight.completed.json` under
`/home/max/.local/state/stadtstack-data/r2-genesis-execution/$RELEASE_SHA/` and stops.
Generate the **unissued** metadata-review record from those actual pins:

```sh
"$NODE" --max-old-space-size=3072 --experimental-strip-types \
  "$PKG/scripts/r2-genesis.ts" metadata-review-draft \
  --authority-root "$AUTHROOT" --release "$RELEASE" --release-sha256 "$RELEASE_SHA"
```

Main reviews actual licence/terms, complete sandbox WADL/metadata outputs,
GEMEIN and real evidence that2024 is available. Generated request parameters
alone do **not** prove year availability. Fill `yearAvailabilityEvidence` with
that metadata source SHA and a genuine locator; if missing, stop for review,
not a guessed endpoint/year/suffix. Issue/commit the metadata-review record in
AUTHROOT: statusISSUED, actual Main/issuedAt, the three review booleans true and
actual review notes. Preserve the actual preflight result pin and the9 exact
request hashes; the controller checks them. This is not permission to alter a
request body or reset time/bytes/attempts.

```sh
REVIEW="$AUTHROOT/stadtstack-data/reports/approvals/r2-genesis-metadata-review-2026-10-24.json"
read -r REVIEW_SHA _ < <(sha256sum "$REVIEW")
"$NODE" --max-old-space-size=3072 --experimental-strip-types \
  "$PKG/scripts/r2-genesis.ts" enqueue \
  --authority-root "$AUTHROOT" --release "$RELEASE" --release-sha256 "$RELEASE_SHA" \
  --metadata-review "$REVIEW" --metadata-review-sha256 "$REVIEW_SHA"
```

`enqueue` is a Main-only production DB mutation, not a fetch. It persists the
actual admitted registry, queues the9 canonical native specs, and prints the
exact native authorization input. Main uses the existing
`district-r1.ts authorize --registry-config DESCRIPTOR --registry-config-sha256 SHA`
with that `authorization` object on stdin. Take DESCRIPTOR/SHA from the issued
release's actual `registryDescriptor`, not the raw registry. This native command
returns `authorizationId`; use that actual UUID as AUTHORIZATION_ID below. No
notification channel or unattended grant is needed: this controller is attended
only. DATABASE_URL is required for these Main steps and never printed.

```sh
"$NODE" --max-old-space-size=3072 --experimental-strip-types \
  "$PKG/scripts/r2-genesis.ts" acquire \
  --authority-root "$AUTHROOT" --release "$RELEASE" --release-sha256 "$RELEASE_SHA" \
  --metadata-review "$REVIEW" --metadata-review-sha256 "$REVIEW_SHA" \
  --authorization-id "$AUTHORIZATION_ID"
```

Main must remain present in the TTY. Native Core handles EOF/signals, PG fencing,
leases and actual immutable receipts. The controller permits only a production,
attended, unused native authorization bound to the issued SHA and exactly those
nine canonical keys/AGS, maxJobs9, at most2h and no later expiry. Queue entries
must all be queued/attempt0. It runs one native job per bounded invocation and
stops before claiming another after any hold/unknown disposition. Descriptor
outputs are authenticated after the real native commit. Actual acquisition
run IDs are labelled **not structured runs**; never put them in step8's
`structuredRunIds`.

`data.completed.json` carries the genuine acquisition runs, nine authenticated
representation pins, `structuredParseManifest`, actual policy checkedAt/expiry
and inherited global counters. Main feeds that manifest to the existing
`district-r1.ts enqueue-structured` with the same admitted registry, then issues
its separate exact native **local parse** stage authorization. Successful
`structured_parse`/`structured_discover` results, not these acquisition IDs, are
the only candidates for a later structured selection. No parse/publication
authority or fake structured run is manufactured here.

## Currency, stops and recovery

This security release does **not** turn a one-hour public proof into a13h proof.
New registrations do not inherit the immutable R1 robots/7-day entitlement.
Native Core creates/rechecks actual per-scope policy receipts; actual expiries
are emitted. Parse promptly within those bounds. Any later long-pass input must
pass its existing static selection/type and full-horizon policy precheck before
its expensive pass. If the horizon does not fit, Main needs a genuinely reviewed
renewal/current-proof path, not a timestamp edit, old grant or silent fallback.

Before every dispatch the fixed-root hash-chained journal is fsynced; chunks,
failures and settled wire results are counted. Both phases inherit one campaign
budget and start clock. Exclusive operation lock plus durable O_EXCL phase
claims prevent concurrent/repeated source execution. Journal replacement/length
tampering, partial/crashed phase, release mutation, source refusal, byte/time
cap, absent review, native failure, credentials error, changed registry/runtime
or a `STOP` file at the execution root all hold. Create STOP to request a stop;
do not delete/rewrite a phase claim, journal or lock to retry. Ctrl-C/TTY loss
uses native shutdown. A stale lock/unknown wire result needs Main's explicit
incident review and a new separately issued decision; no source request resumes
automatically. Preserve genuine failed request custody for any later reviewed
offline admission; never re-fetch to manufacture a success.

## Offline verification

Run compilation, focused custody/GENESIS/native-contract fixtures, and
`scripts/r1-verify.sh ordinary` using the CPU-slot helper, one test at a time,
3072MiB old-space cap and a unique R1_VERIFY_LOG_ROOT. The ordinary harness uses a
fresh disposable test PG instance, unsets DATABASE_URL, and must clean it up.
This is not a production integration/image/source gate. Exact exercised results
and draft/fingerprint SHAs accompany the handoff; no live availability, metadata,
account success, payload counts or source coverage is asserted here.

### Pre-review cbf21bd evidence (historical)

Before security review, compilation `tsc --noEmit` exited0 and the custody file passed
**13/13**, zero failures/skips/cancellations (2,037.02688ms), using exact
Node24.22.1, the CPU-slot helper,3072MiB old-space, strip-only TypeScript,
isolation `none`, concurrency1 and30s per-test timeout. Preliminary syntax,
strip-only constructor and synthetic fence-fixture errors were corrected; no
production validator or safety check was relaxed.

`/home/max/.local/state/stadtstack-data/r2-genesis-release/contracts-0526d11.json`
is a fresh-process historical/current measurement, base
`0526d11216592b23465f89cd7d780c956edcddff`, SHA256
`653c3bafe98d8ab7fcce49f047819f0cf965558999e36966242d3cef78009550`.
It invokes14 native functions plus MaStR and GENESIS structured functions with
actual historical Git blobs/current file hashes. **Only acquisition changes**;
the other13 native and both adapter-specific identities remain unchanged.

| Pre-review cbf21bd identity | SHA256 |
|---|---|
| Acquisition |`fdb3a0f6abcfc57e8b7aaf2f52cf9f0e10cf379609b5321d21eb73c6c20e0aaa`|
| GENESIS adapter |`f63616d5041aa8f10f193b0262f956c747a410630bc687b5ee66870df23095cf`|
| GENESIS structured semantic |`dcdc91e2d9f78343c122a6a3bed0acb3bd72a70de36d408b70511c2c7bd24eb0`|
| Shared structured mapping |`d13ae43bb194a77dd1695ef3917b9bb48b99ff25b25451e4d71a04c7c6f5073a`|
| Parser output |`3024a2b87f136379bf05fcb6d899707567f158f26c2cea0deef25dd0ae247599`|
| Parser isolation/current required review runner |`281f2cabfe5fa16cc00553f92a053a822f7c65050ed1e3716d21cb8f283fbb73`|
| State gauges structured semantic |`c04e4a6e6726b7eda24381321d8946c3e29d94db7125ada2d8ebdd35d2eda003`|
| Operator registry contract |`0d421b9e717f2fb3156b939fc80597f7e2a0bc2445797286729bd6d742fe894a`|

The permanent measurement script in that private evidence directory is
`measure-contracts.mjs`, SHA256
`75d957a4940d5466053a4bf29dc447b74c10f144b035b465b5de026228bb45e1`.
The terminal-contract snapshot is updated only to the measured acquisition
identity; no frozen receipt or historical measurement is rewritten.

### Current integrated unissued pins

- `reports/r2-genesis-31231-request-plan-v3.draft.json`:
  `581c69fb0e97d37566317515176dcf875ddb9b23430dddbaebc632881d7ef542`.
- `reports/r2-genesis-structured-security-release-v3.draft.json`:
  `99872ca07e56e12d81e2d606281d972ca68e46adda0d62e26c751387bae17dd8`.
- Draft executable security-code manifest:
  `a0a9f1022b395b8754b825687c9131c7a338ef6195377a6f63f67264090d38b9`.
- Actual pinned Node24.22.1 binary:
  `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`.
- Exact registry configuration:
  `72ab4357cf2dbb49df8f3a66070097d71444af1f8253f27aa28de5b31fa0c957`.

These records have statusDRAFT, empty issuedAt, approvedBy null and the source
stop **not lifted**. No actual parser authorization or review is invented.
The fresh generation launched no parser/image, read no credentials, accessed no
DB and sent no source request.

After merging `rebuild-r1` at6ac22aa, the district draft's
**preparedPoliteFetch** and **unissued preparedContractsEvidence** now bind the
integrated bytes and `reports/r2-genesis-integrated-contract-measurement.json`,
SHA256 `64b19b06cc8940c28aa9eab856e185cd5a9774db585247a34771d6f1b13f3f5a`.
Its acquisition contract is
`0a7bbfa29e22ec41bae105214b8ca85f9b8ea76272b0f5397607fed85a1e192d`.
No prior measurement is relabelled and no image/review authority is created.
The district draft itself is
`df8f446709ddb47c2a7e28788dba0635cd55fcfe419ebb33cc235ebd760f2137`.
Any later source integration requires remeasurement/regeneration; prepared
hashes never silently authorize a different checkout.

### Pre-review ordinary correction and affected-fixture coverage

The first complete ordinary run, with a fresh disposable PG, recorded2,292
tests:2,227 passed,16 failed,1 cancelled and48 skipped. Preserve its actual TAP:
`/home/max/.local/state/stadtstack-data/r2-genesis-release/verify-ordinary/tests-20261024T193325Z.tap`,
SHA256 `c9e5143e01f3bdd9f9d4cf699d4bd8eb23334f0c0917ad3cad5360000f5b8848`.
This was a failed run, not a green gate.

Six failures exposed private scheduler fixture callers that still used the old
argument order. All19 direct fixture calls and their seam types now supply the
actual wire identity (GET/null for simulated policy scheduling, actual method/
body for the two R2 loopback transports). No compatibility default, test
assertion or production guard is weakened. Seven token CLI fixtures also found
the two newly created **owned checkout roots** were0775; those two directories
alone were secured to0755. Shared ancestors were already secure and untouched.
The first run also reported two Step8 topology directory guards and a120s
crawl-continuation timeout.

After these corrections, final package `tsc --noEmit` exited0 and the six-file
affected-fixture run passed **148/148**, zero skips/failures/cancellations,
79,779.167156ms. Files: `polite-fetch`, `r2-acquisition-executor`,
`r2-genesis-release`, `district-terminal-exceptions`, `genesis-adapter` and
`mcp-token-config`. CPU slot, Node24.22.1,3072MiB old-space, strip-only runtime,
isolation `none`, concurrency1 and120s timeout were used. Loopback synthetic
HTTP fixtures are not live source requests. These focused results do not
relabel the first failed full run.

### Pre-review complete ordinary gate (cbf21bd, historical)

Before FetchSecurityReview, the **complete** `scripts/r1-verify.sh ordinary` run exited0:
**2,300 tests,2,252 passed,0 failed,0 cancelled,48 skipped**, test duration
1,938,839.541227ms. It used a new disposable PostgreSQL cluster, CPU-slot
affinity, nice10,3072MiB Node old-space and concurrency1. Every ordinary test
remained selected; the per-test ceiling was5min so the complete nested
crawl-continuation case could finish rather than being cancelled at120s.
No assertion, source policy, lease/production bound or test was removed.

Pre-review TAP:
`/home/max/.local/state/stadtstack-data/r2-genesis-release/verify-ordinary-final/tests-20261024T213118Z.tap`,
SHA256 `af0c4ad0d1eb01dd43bd30a1474836fdc4f3018fd196f008790bc71f94d43a70`.
The private `run-ordinary-final.sh` retains the exact reproducible invocation.
The earlier failed log remains intact; it is not relabelled or replaced.

The pre-review district draft's prepared-contract dependency had SHA256
`f4f1ad4e845dc234a6ad5799aa81d53c61099e91ddb47b37b2053b3e7e9ce32f`.
That old pin and gate describe cbf21bd, not the post-review integrated tree.
The credential fix and integration deliberately advance the current GENESIS
security-code and draft pins. No production DB, live source, owner credential,
parser image, retained-staging/integration or hosted publication gate was
exercised. Main's reviewed matching parser authorization and genuine separate-
worktree issuance remain prerequisites before the first request.

## Security-review integration of rebuild-r1 6ac22aa

FetchSecurityReview's P3 eager credential reads are removed: the controller has
no credential import, helper or readiness call. Only the existing PoliteFetcher
owner-account branch loads credentials just in time, after selector/policy
checks, for an exact data POST. The dedicated architectural regression refuses
reintroduction of that controller reader/probe; existing anonymous/profile and
owner-child hook tests remain intact.

Merge parent: `6ac22aa95ab3108002e17386fed9dacaefb04a67`; merge commit prefix
`2aa7ad5`. The merged `polite-fetch.ts` differs from that parent only by the
credential-free actual wire identity interface and its propagation through
`scheduled`, the pre-dispatch hook and `wire`. The existing owner-child hook
pass-through remains intact. All `PolicySnapshot`, `policyContext`,
`policyFetchOptions`, immutable rules/receipt/snapshot integrity validation and
option projection in `policy`/`machinePolicy` are retained. The new policy-reuse
fixture's scheduler and callback seams now receive the same actual identity;
no snapshot assertion or source policy is weakened.

Fresh-process complete contract report:
`/home/max/.local/state/stadtstack-data/r2-genesis-release/contracts-6ac22aa-integrated.json`,
SHA256 `6212fe7b65ff696ed327c071703ecd05a92eaedaeec8c22ee67f4a47e8611fa3`.
Against6ac22aa, **only acquisition changes** among14 native functions plus
GENESIS/MaStR structured functions, from `016f95f21af2a132b8098356b195def10557f5934cd931ba563aef80ae1ad607`
to `0a7bbfa29e22ec41bae105214b8ca85f9b8ea76272b0f5397607fed85a1e192d`.
All other identities in the historical table above remain unchanged.

Current integrated `polite-fetch.ts` SHA256:
`afb3add27e0975b06c280a581720eb6cc64d5529cd491ccb68d4956db905942b`.
The regenerated request plan remains byte-identical; the security draft and
code manifest have the new integrated pins listed above. All records remain
DRAFT, issuedAt empty and sourceFetchStopLifted false.

Existing prepared parser-image evidence is preserved as evidence of its actual
image, not edited into current authorization. Its recorded runner/output
contracts `04edb466…`/`79999b46…` differ from the current checkout's
`281f2cab…`/`3024a2b8…`; installed historical authorization was also not current.
Main must use a genuinely matching reviewed image/authorization rather than
relabel either record. This branch performs no image build/install or request.

### Post-review focused verification

Package `tsc --noEmit` exited0. The integrated seven-file focused run passed
**153/153,0 failed,0 cancelled,0 skipped**, duration86,411.227328ms:
`district-terminal-exceptions`, `genesis-adapter`, `mcp-token-config`,
`polite-fetch`, `r2-acquisition-executor`, `r2-genesis-release` and
`r2-policy-reuse`. This includes the new no-eager-credential regression and the
four snapshot/reuse tests. It used Node24.22.1, the CPU-slot helper,3072MiB
old-space, strip-only TypeScript, module mocks, isolation `none`, concurrency1
and300s per-test timeout. The loopback/synthetic fixtures sent no live source
request, and the controller was not run against production or real credentials.

### Post-review complete ordinary gate (failed, not relabelled)

The new complete ordinary run exited1: **2,305 tests,2,253 passed,2 failed,
2 cancelled,48 skipped**, duration2,112,831.307159ms. It used its own disposable
PostgreSQL cluster, CPU slot,3072MiB old-space, concurrency1 and300s per-test
ceiling. The complete ordinary selection remained intact.

TAP:
`/home/max/.local/state/stadtstack-data/r2-genesis-release/verify-ordinary-integrated/tests-20261024T222752Z.tap`,
SHA256 `9ef37b08093bd07211f47f5c44abb962f05873985c8f0a9347e657b7a128130c`.
The reproducible wrapper is `run-ordinary-integrated.sh` in the same private
evidence directory.

The nested `district-crawl-import` unchanged-current-refresh case reached its
300s parent deadline, cancelling the final historical held-quality seal child
and failing its outer case. The worker-diagnostics error-mode test then observed
zero progress messages instead of one at `test/r1-step8-worker-diagnostics.test.ts:31`.
Main identifies the latter as the known base race corrected by slice2; this
branch does not alter that worker/test. These failures are genuine and remain
in the retained full log; the passing focused result is not a replacement.
No unrelated assertion, policy check, deadline or selected test was weakened.

### Main-requested isolated crawl comparison

The same complete `test/district-crawl-import.test.ts` file was run alone, with
the unchanged300s ceiling, sequentially on this integrated branch and on
detached base `d90de0e0ded5158cd40b45f015c45bee112d9c96`. Each run had a new
disposable PostgreSQL cluster, CPU slot,3072MiB old-space and `free -g` captured
immediately before Node. The created control worktree and its offline-installed
dependencies were removed afterwards; retained evidence is outside it.

| Run | Tests | Passed | Failed | Cancelled | Skipped | Duration |
|---|---:|---:|---:|---:|---:|---:|
| Integrated branch |66|63|1|2|0|440,818.115358ms|
| d90de0e control |66|66|0|0|0|400,586.943804ms|

The branch again reached the refresh parent's300s deadline
(300,000.380562ms), cancelling the final historical held-quality seal child.
The control's same parent finished in283,986.827361ms, including that final
child's17,341.790897ms. Branch isolation therefore **did not prove a
load-only timeout**. No crawl assertion or policy failure preceded its deadline;
the comparison alone does not establish a cause, particularly since the
control uses the newer Main base rather than6ac22aa.

`free -g`: both runs had15GiB total and no swap; branch6used/4free/5buff-cache/
9available, control5used/4free/6buff-cache/10available. These are start-of-run
snapshots, not claims about peak memory.

Evidence under
`/home/max/.local/state/stadtstack-data/r2-genesis-release/`:

- `crawl-isolated-branch/tests.tap`:
  `e4dac1ffa29d5a0669d19865af11efd2774fc834548a0ec084bcc995012a242d`.
- `crawl-isolated-branch/free-before.txt`:
  `4eb7fdb17baf847f8c9c542597abeb654af3cd715789f893fee1e799a3ecf764`.
- `crawl-isolated-d90de0e/tests.tap`:
  `bab9ce2f88091a2db61976be1ae717fa6abaff5bec8271c8c82e9e6b58287899`.
- `crawl-isolated-d90de0e/free-before.txt`:
  `04fd741a30de66645bb78db96e78b7d01828e1bfa9655184d68e9e61506d4379`.
- Reproducible `run-crawl-isolated.sh`:
  `543f6645503ce5ed6fda31907b2d2801d21b6d4512bd8e443cbcd61c5977f355`.

The full ordinary gate remains failed; neither isolated run rewrites that
outcome. Main subsequently requested the observer-only comparison below.

### Observer-only phase and IO comparison; no GENESIS regression

Without changing repository source, the isolated file was profiled on both
trees using private `profile-crawl.mjs`/`run-crawl-profile.sh`, the same300s
ceiling and CPU-slot/memory limits. The unchanged branch **passed66/66**
(410,499.189716ms). The control then hit the parent deadline: **66 tests,
64 passed,1 failed,1 cancelled,0 skipped** (423,065.018615ms). Together with
the uninstrumented runs, this demonstrates the near-deadline variability;
the failed complete ordinary run is still not relabelled green.

| Refresh-parent observer metric | Branch | d90de0e control |
|---|---:|---:|
| Duration |288,529.792334ms|300,001.197446ms|
| FileHandle.sync/datasync calls |9,313|9,295|
| Time in those calls |23,870.152142ms|23,411.908192ms|
| lstat calls |1,401,837|1,398,466|
| Time in lstat |83,571.454884ms|87,582.028756ms|
| Synthetic mocked policy-wire calls |7|6|
| Actual scheduled wire calls |0|0|
| Admission-hook calls |0|0|
| Writes to journal/progress-labelled paths |0|0|

These parent totals are **not work-equivalent**: the control's deadline
prevents final parent work. The retained matched14 direct-child phase table
provides individual durations and IO counts without attributing existing
authority/CAS fsyncs to network requests. Counts observe FileHandle APIs, not
strace kernel counters; journal/progress labels are path classifications.
There are zero actual admission-hook/reservation calls per synthetic policy
request, not zero existing authority durability operations.

The decisive boundary is `test/district-crawl-import.test.ts:464`: this entire
refresh case replaces `PoliteFetcher.prototype.wire` with synthetic robots/TDM
responses. Thus the real wire selector construction, scheduler and GENESIS
durable reservation cannot run. Whole-file CPU profiles on branch/control show
the same Core hotspots: `loadInventory`15.8%/15.4%, `directory`13.8%/13.6% and
GC10.7%/10.7% of on-CPU time. Main agreed this is the load-dependent,
near-deadline Core-v1 case, **not a GENESIS regression**. No speculative Core
permission cache, wire redesign, deadline increase or unrelated source edit
was made. The separately owned Core-v2 work is not claimed as included.

Full phase/counter comparison:
`/home/max/.local/state/stadtstack-data/r2-genesis-release/crawl-profile-comparison.json`,
SHA256 `8d33afada1b8fb0b507fe09bc92e608455d506bef63346323167454ff785f496`.
This includes all14 matched direct-child phase times, fsync/lstat counts and
hook/request/journal counts. Raw evidence in the same directory:

- `crawl-profile-branch/tests.tap`:
  `40db7de16963c6f5453aadb0cf64673b13b006958d2371b5ee4b4991ef86164f`.
- `crawl-profile-branch/profile-2277956.json`:
  `d0cfd677ebfaac362ebc9fc4e722a0e7cecb50a0c825cafc21a5bfd9e27d726f`.
- `crawl-profile-branch/cpu-2277956.cpuprofile`:
  `3888d6e2ed06fa62466bcd5ddfd5c9cb6cce57a2fc62c9a56b970b8aa1bfc11f`.
- `crawl-profile-d90de0e/tests.tap`:
  `cdddfc6f9ac33733ac2f0a356696123967897b97157c039310aed573eaa36b99`.
- `crawl-profile-d90de0e/profile-2279650.json`:
  `0bce9b493da2a0d38e027f4acdba0bdff3ab17bac2c8f7cdcd6b98dddf0860ed`.
- `crawl-profile-d90de0e/cpu-2279650.cpuprofile`:
  `ede3c262007c0dd232b229014686e054e2a974c07ccd4d5617cc60ccfb56093c`.

The observer and runner are pinned respectively by
`135aa07632ce0a2ddc3da31f6cf16ce2a86f8f0925441f8e29aba521d5e506c5`
and `8216a0a0842ee95f528c039648080019b3934d4794ee9d48346e9adef9c459a8`.
Both disposable control worktrees and their dependencies were removed after
their runs. All started jobs finished; no live source/credential/production
mutation or parser-image/issuance gate was performed.
