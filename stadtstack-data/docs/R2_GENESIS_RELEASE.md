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

### Exercised fresh-process evidence

Compilation `tsc --noEmit` exited0. The final focused custody file passed
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

| Current identity | SHA256 |
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

### Generated unissued pins

- `reports/r2-genesis-31231-request-plan-v3.draft.json`:
  `581c69fb0e97d37566317515176dcf875ddb9b23430dddbaebc632881d7ef542`.
- `reports/r2-genesis-structured-security-release-v3.draft.json`:
  `d5356274f5423d6912607d5808ea4d60f1dd4217f4c0854f74ce08dfc73eb465`.
- Draft executable security-code manifest:
  `0fc31594c3c81e8f0afa1d69967ef6e209ef92b5a3cb1c7e910a88db83aad4b1`.
- Actual pinned Node24.22.1 binary:
  `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`.
- Exact registry configuration:
  `72ab4357cf2dbb49df8f3a66070097d71444af1f8253f27aa28de5b31fa0c957`.

These records have statusDRAFT, empty issuedAt, approvedBy null and the source
stop **not lifted**. No actual parser authorization or review is invented.
The fresh generation launched no parser/image, read no credentials, accessed no
DB and sent no source request.

The shared native acquisition dependency also makes the existing district
draft's old prepared-contract pin stale. With the district executor owner's
agreement, only that **unissued preparedContractsEvidence** block is advanced to
`reports/r2-genesis-acquisition-contract-measurement.json`, SHA256
`fc1b09cc8b6e7dff828f9c76f24fd768517a832540be644cdb8e4f31c2b8e767`.
It binds the actual full measurement above and current parser values, not a new
runtime/image approval. `reports/r2-acquisition-contract-measurement.json` and all
issued/historical records stay unchanged. Other prepared district evidence is
still historical. Main must remeasure and regenerate on the **integrated head**
after merging the independent policy-reuse/codec slices; neither branch's
prepared SHA may silently authorize another checkout.

### Ordinary-gate correction and affected-fixture coverage

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

### Final complete ordinary gate

The final **complete** `scripts/r1-verify.sh ordinary` run exited0:
**2,300 tests,2,252 passed,0 failed,0 cancelled,48 skipped**, test duration
1,938,839.541227ms. It used a new disposable PostgreSQL cluster, CPU-slot
affinity, nice10,3072MiB Node old-space and concurrency1. Every ordinary test
remained selected; the per-test ceiling was5min so the complete nested
crawl-continuation case could finish rather than being cancelled at120s.
No assertion, source policy, lease/production bound or test was removed.

Final TAP:
`/home/max/.local/state/stadtstack-data/r2-genesis-release/verify-ordinary-final/tests-20261024T213118Z.tap`,
SHA256 `af0c4ad0d1eb01dd43bd30a1474836fdc4f3018fd196f008790bc71f94d43a70`.
The private `run-ordinary-final.sh` retains the exact reproducible invocation.
The earlier failed log remains intact; it is not relabelled or replaced.

The branch-local district draft's prepared-contract-only dependency update has
SHA256 `f4f1ad4e845dc234a6ad5799aa81d53c61099e91ddb47b37b2053b3e7e9ce32f`.
The GENESIS draft and security-code pins above are unchanged by fixture-only
migration, checkout permission corrections or documentation/report updates.

This is ready for Main's **review**, not issuance/execution. No production DB,
live source, owner credential, parser image, retained-staging/integration or
hosted publication gate was exercised. Main must review/merge, remeasure the
integrated immutable checkout, install the current matching patched parser
authorization through its real gates, and issue in the separate authority
worktree before the first request.
