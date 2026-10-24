# R2 district acquisition security review and v3 release preparation

## Decision and scope

Owner choice C (#103), as reported by Main: close R1 and prepare approximately
100–140 new documents for R2. The executor work branches from `rebuild-r1`
at `f2876ef`; earlier v3 hardening evidence was measured against
`33fa1d3df5daa485b609be9a2ab904add3cfb649`. It neither reopens R1 nor extends
its processing/source pin. No source request, production DB/CLI write,
container build/start, service change or authorization issuance is performed.
The v2 security release was limited to the structured step8 continuation.
It is not permission for the district crawler or a new R2 corpus.

Draft: [`../reports/r2-district-source-fetch-security-release-v3.draft.json`](../reports/r2-district-source-fetch-security-release-v3.draft.json).
It has `issuedAt:""`, `approvedBy:null`, `sourceFetchStopLifted:false` and a
DRAFT-only schema/status. **It cannot clear the SS-01 stop.** Its runtime/image,
manifest, authority and executor prerequisites must be independently satisfied
before Main creates any genuinely issued release.

### Executor record-binding contract

The executor accepts no draft as authorization. Its release input is an
authority-worktree record path plus the expected SHA-256 of its complete raw
bytes. The record must exactly match this v3 draft's schema and values, with
only these issuance fields added/replaced: `status:"ISSUED"`,
RFC3339 `issuedAt`, non-empty `approver`, RFC3339 `validFrom` and `expiresAt`,
`sourceFetchStopLifted:true`, and
`ownerApprovalReference:{sha256:<exact acquisition-manifest SHA-256>,
approvalRecordPath:<authority-worktree path>,
approvalRecordSha256:<owner-approval raw-file SHA-256>}` plus
`r1DigestInventoryReference:{sha256:<final R1 inventory raw-file SHA-256>}`.
The owner-approval file must itself be a regular non-symlink v1 approval record
whose `approved.acquisition.manifest.sha256` equals the pinned manifest digest.
The separately supplied final R1 inventory is a raw-hash-pinned
`r2-r1-digest-inventory-v1` JSON file with unique canonical `{url,sourceIds,
sha256}` entries; every exact manifest URL/source binding must be covered and
`sha256:null` means no sealed R1 original was recorded for that URL. Its path
and expected SHA-256 are explicit executor arguments and the record's inventory
digest must match. The executor binds to SHA-256 of the complete raw issued
record file and rejects schema drift, hash mismatch, a not-yet-valid/expired
window, or a manifest/inventory hash other than the issued reference. In
addition, `runtimeRequirements.preparedContractsEvidence.acquisitionContractSha256`
must equal the digest returned by the running `district-r1.ts` acquisition
contract in a fresh process. `open()` checks that digest before constructing the
fetcher; the complete raw issued-record hash consequently pins this runtime
contract requirement together with the exact v3 draft values. Paths and
expected hashes are explicit inputs, never inferred. The draft's
`approvedBy:null`, empty issuance clock and `sourceFetchStopLifted:false` do not
meet this contract. This describes the required later issuance record; it does
not issue one, authorize a fetch, or lift the current stop.

Changed bytes are durably recorded in the executor's append-only journal as
`changed_since_r1` representations, with their source ID, R1/new digests, and
quarantined CAS representation. A changed representation is never treated as
completed/admitted until a separately reviewed record with
`schemaVersion:"r2-changed-source-release-v1"`, `id:"r2-changed-source-release"`,
`reviewedBy`, RFC3339 `reviewedAt`, non-empty `reason`, and
`representations:[{url,sourceId,sha256,r1Sha256}]` is supplied with its expected
raw-file SHA-256. It releases only exact listed tuples and never waives MIME,
body/HTML, retained-byte, or document budgets; the held CAS bytes are rehashed
and rechecked against those limits immediately before release. The `r2Integrity`
provenance is included in authenticated source references and managed-source
bindings; preparation, inference, cache reads/writes and worker re-entry derive
the integrity gate from those source references rather than trusting a caller
option. The executor derives this guard from the bound record/manifest/journal
and forces it into PoliteFetcher; managed raw and observation admissions plus
request-evidence bindings persist it in their inventory identity. Reads
rederive the marker from authenticated inventory, require each reference to
match the latest completed journal URL/source ID/digest, and require the exact
changed release for a previously quarantined tuple. A caller cannot introduce
or substitute the guard. Mixed, absent or mismatched R2 provenance is refused.
A missing release keeps the representation held. Neither acquisition approval
nor the ten-document batch review releases changed bytes.
The ten-document checkpoint binds journal
sequence, record hash and the complete digest set; a raw-hash-pinned review
issued after that checkpoint is single-use. This mechanism covers already-known
R1 original digests; it does not claim a semantic detector for anomalous
MIME/template/mass-host changes or independent review of high-impact additions.
The executor journal is fsynced after each attempt-state transition and each
response byte, binds its record/manifest hashes, and is protected by a
cross-process exclusive lock. Budget usage is reconstructed from the journal
on resume; completed URLs are not refetched. A torn or mismatched journal and a
second concurrent executor fail closed.

## Findings and dispositions

Severity describes security impact if a reachable condition occurs, not proof
that a source, host, parser or historical result was compromised.

| ID | Severity | Concrete finding | Disposition |
| --- | --- | --- | --- |
| R2-F01 | High, upstream advisory / release blocker | The root parser review still points at image08cbb520… and a pre-21October Node22 base. The image's exact current Node/package inventory is not established by that review. No patched rebuild/SBOM/new review is present. | Added a bounded source-free patched-Node check **before parser worker readiness**. The worker accepts only fixed22/24 LTS lines (22.23.4+/24.22.1+); old/unknown/prerelease lines fail. Changing worker bytes invalidates the old runner contract before Docker. **Still requires an independently verified patched base, rebuilt image, inventory, containment sentinels and new root-owned review.** No fabricated digest or image upgrade claim. |
| R2-F02 | High, conditional transport integrity | HTTPS requests relied on Node's default certificate verification, which an inherited `NODE_TLS_REJECT_UNAUTHORIZED=0` can disable. | Fixed: HTTPS options explicitly set `rejectUnauthorized:true` and `minVersion:'TLSv1.2'`; DNS pinning, URL hostname/SNI and `agent:false` remain. Synthetic test intercepts the transport constructor under the insecure environment and verifies exact options; no handshake or public host probe is claimed. |
| R2-F03 | Medium, source-integrity downgrade | A same-host HTTPS document redirect could change to HTTP; hostname equality alone did not preserve transport security. | Fixed before destination dispatch: HTTPS→HTTP is `invalid_redirect` for documents and standardized TDM policy redirects. HTTP→HTTPS and same-host HTTPS path changes remain; R2's exact allowlist itself contains HTTPS only. |
| R2-F04 | Medium, stale launcher / runtime drift | Identity-only body handling removed Brotli exposure but did not stop a stale launcher from using a Node runtime with the advisory's other HTTP/TLS/DNS flaws. | Fixed: live `wire()` requires a fixed22/24 LTS version before initialization/DNS/transport. Tests reject24.21.0,24.22.0,22.23.3,unknown majors and malformed/prerelease versions. v3 must additionally pin the actual24.22.1 binary/hash; the version floor is not a signed runtime review. |
| R2-F05 | High, authorization/budget prerequisite | Generic `crawlHtmlSource` can expand discovered links; its public `requestCount` and maxRequests count logical fetch calls, not every robots/TDM/redirect wire attempt. It has no run-wide byte ceiling and scheduling is exact-host, not a global42-source rate pool. | Implemented by the separate `R2AcquisitionExecutor`, not the R1 CLI: exact HTTPS document/policy URL admission, every wire attempt counted, global request serialization/spacing, no retries/model calls, all-wire body and retained-byte/time/document limits, batch pause, durable resume journal and cross-process exclusion. Behavioral tests use only the explicit localhost test seam. The v3 record remains unissued; this executor does not lift the live-source stop. |
| R2-F06 | High, SS-02 integrity / inference prerequisite | Exact quotes, strict schemas and same-model faithfulness do not establish source truth. Crawler digest replacement lacks an independent defacement/high-impact-change hold. | Implemented known-R1-digest quarantine: representation and `changed_since_r1` state are durably recorded before downstream admission, and preparation/extraction recheck the exact URL/source/new/R1 tuple against a separate reviewer/date/reason release. No semantic detector for anomalous MIME/template/mass-host changes or review mechanism for high-impact additions is claimed; those remain independent review requirements. Acquisition approval gives zero model calls and no publication permission. |
| R2-F07 | Medium, representation-boundary prerequisite | Generic fetch supports several native/API/structured formats and may retain a representation before the HTML adapter later labels it unsupported. Generic MIME acceptance is broader than a district HTML/PDF campaign. Host-side HTML discovery still uses Cheerio. | The executor admits only the reviewed document representation types and body caps before downstream use; policy JSON/directives remain separate. Unknown types must hold, never be treated as an empty successful crawl. PDFs/ZIP/XML still have their existing sandbox bounds. No JavaScript/browser execution path was found. |
| R2-F08 | Low / defense in depth | The image contract does not explicitly pin custom seccomp/AppArmor profiles; Debian package versions/SBOM are absent from the old review. Original HTTP encoding is not retained in historical observation/request records. | Preserve all current containment checks; require actual inventory/review and monitoring metadata in the new R2 run. No claim that Docker defaults equal an independently reviewed profile, or that historical unknown encodings were identity. |

## Current controls versus scrape-safety-20261022

Source report: `/home/max/stadtstack-ops/reviews/scrape-safety-20261022.md`,
SS-01/SS-02 and its parser advisory/inventory sections.

### HTTP representations, decompression and size

Commits2a013a0/9e79524 are present in the33fa1d3 baseline. `wireRequest` sends
`Accept-Encoding: identity` and rejects every other present encoding, including
stacked/empty/unknown forms, before body handling or decoder construction. No
zlib decoder remains in that path. Normal HTTP optional whitespace is parsed
by Node; `' identity '` becomes identity while `'identity,'` is refused.
Header-only403/429/5xx/Retry-After accounting survives encoding refusal and is
persisted even though successful onResult does not run.

The default body cap remains24MiB, checked against Content-Length and streamed
HTTP body bytes. Identity means wire-body and representation bytes are equal.
It does **not** eliminate PDF/ZIP internal compression: those bytes belong to
the parser sandbox with separate expansion/text/page/resource bounds. Native
parser input infrastructure permits64MiB, but district document parsing is
24MiB; the v3 proposal does not lift the latter. HTTP error/redirect bodies are
discarded, not decoded or admitted. No response-body limit is a native memory
safety fix; the patched runtime and no-decoder boundary are both required.

### URL, DNS, redirects and TLS

Public URL validation rejects credentials, sensitive query keys, private/local
names/addresses and nonstandard ports. All DNS answers must be public; the
selected address is pinned to the actual socket. No keep-alive agent reuse.
Cross-host source redirects, authentication redirects and excessive redirects
remain denied. The new downgrade veto applies before any insecure destination
request. Standardized TDM redirects keep their stricter origin/loop rules.

New TLS certificate/min-version options are explicit, not inherited defaults.
The original URL hostname still supplies ordinary Node hostname verification
and SNI when DNS is pinned; no custom `checkServerIdentity` or permissive CA
fallback was added. v3 additionally requires a sanitized launch environment and
reviewed binary. This is ordinary PKI, not certificate/public-key pinning; no
current remote certificate or handshake state was probed.

### Timeouts, pacing and stops

Default DNS and wire deadlines are25s each; they are separate stages, not one
25s end-to-end guarantee. The old exact BOB inventory GET has90s and the old
owner GENESIS table POST has120s defaults; neither is in this R2 document
allowlist. Explicit25s v3 settings supersede those defaults for this campaign.
Persistent exact-host locks serialize requests and enforce at least2s; municipal
profiles use at least5s and respect longer robots delays.403/429 impose at
least1h cooldown plus longer Retry-After;5xx backs off and three failures in10min
open the persistent circuit. Never convert a hold into automatic retries.
Global all-source5s/one-in-flight and total request/byte/time budgets require the
new executor; existing host locks alone do not prove those proposed caps.

### Content and PDF isolation

PDF magic and ZIP magic override misleading content labels. XML sniffing is
bounded. Robots validates real UTF-8 directives even under a misleading media
label so a genuine denial cannot become a permissive absence. TDM endpoints
require JSON with the expected schema. Per-representation headers, document
origin and PDF XMP inspection remain mandatory and happen through the reviewed
classification sandbox before success retention. Access/CAPTCHA/paywall/login
fail closed. HTML discovery does not execute scripts, but Cheerio remains a
host-side parser; bound HTML intake and controller memory in the R2 executor.

`withParserSandbox` authenticates a root-owned immutable image/runner review
before Docker. It asserts network/IPC isolation, non-root65534, read-only root
and exact source bind, no capabilities, no-new-privileges,512MiB RAM/no extra
swap,1CPU,32PIDs,120CPU seconds,180s wall,128MiB noexec/nosuid/nodev scratch,
file/descriptor/core bounds and bounded protocol/stdout/stderr. The worker
rechecks actual namespace/cgroup/privilege invariants and kills tool process
groups. PDF page/text/OCR limits and ZIP/XML safety checks remain unchanged.
The new readiness gate probes only fixed `node --version`, under those same
bounded tool execution rules, before any document command. It does not make
the current old installed image patched or authorized for the changed worker.

## Exact draft scope and caps

The current unissued scope references the V2 manifest at
`/home/max/.local/state/stadtstack-data/r2-planning/R2_ACQUISITION_MANIFEST_V2_DRAFT.json`,
SHA256 `c23a739b27dd85e2a67cef0d14826f2c1c5407e1caf7c5049b7c451262543e1c`.
It contains221 unique candidate URLs, each bound to exactly one admitted
sourceId, and17 selected source scopes. The 8 duplicate URL/source listings
were resolved by deterministic precedence (council, gazette, participation,
website, structured; ties use alphabetically first sourceId); other listings
are informational `alsoListedUnder`, never admitted or policy-checked. The
draft enumerates every document URL, method, permitted document MIME and exact
candidate/source binding, plus22 exact robots/TDM policy URLs. No hostname
wildcard, subtree prefix, query mutation, automatic redirect target or dynamic
discovery expansion is allowed. The changed manifest hash requires separate
owner approval; the release draft remains unissued with the source-fetch stop
set.

The source count is reconciled: **43 total registered routes =41 district
document registrations +2 structured routes**. The wording42was outdated:
GENESIS increased41→42 in `ae49124d132539650feb183aa2246bde4ee51581`
(12October21:48:30UTC); PEGELONLINE increased42→43 in
`96e34c49891d9be3762b5ae181df7c0a32682cc1` (13October06:27:21UTC).
The latter was initially a proposal, then merged in
`7b9ab165398f8229c0cf0db4c85d3c6926695235` (13October10:21:10UTC)
under the genuine K2 owner approval committed in
`45bea58e919d810d49db2eb8d6ecc49845a765c4`.

The43rd source is `pegelonline`, municipality `hagenow`, AGS13076060, exact
WSV station-list endpoint
`https://m.pegelonline.wsv.de/webservices/rest-api/v2/stations.json`.
The [K2 owner record](../reports/approvals/r1-k2-and-genesis-owner-account-2026-10-13.json)
records the owner's `"1. yes 2. C"`, pins this registry commit/hash and permits
exactly one station-list GET plus policy requests, within5jobs/25min, expiring
16October. That historical permission is not current R2 fetch authority.
Its licence field is explicitly a catalog declaration, not verified licence
terms or a new source agreement. `R1_STATUS.md:35,40` records both the initial
proposal and subsequent approved successful K2 batch; those dated statements
remain historical, not contradictory current instructions.

FULL's frozen catalogue uses the96e34c4 processing-registry descriptor
(`registry-96e34c4-code-3a1e1b1/operator-registry-config.json`), with configuration
SHA256 `e471ba1fecc2be15f81e109dc8eb82360d85cebaa1a54ef1f3da3b1427399134`;
its27text-source corpus rows are a different count from the43-route registry.
The current18selected R2 scopes include neither `pegelonline` nor
`regionalstatistik-genesis`, and the v3 draft expressly excludes GENESIS/PEGEL
native acquisitions. **No selected scope or URL needs adding/removing for this
count correction.** The numerical discrepancy is no longer an issuance
blocker; final exact registry/manifest pins and genuine R2 approvals still are.
The selected112URLs must be deduplicated against the final frozen R1 corpus
and current content:120bindings is not120new documents or a completeness claim.
The three candidate cached hashes are retained as known prior baselines, not
current source-policy/admission receipts. Other previously known representations
must also be bound during final review, not silently treated as new identities.

Since merge `e962c1b` (r2-structured-sources) the registry has **44 routes**:
the 43 above plus the discovery-only `mastr` registration, which grants no
fetch right. The final V2 manifest's 221 URL/source pairs are unique (one
admitted sourceId per URL; `alsoListedUnder` entries are informational only)
and supersede the 112-URL/18-scope v1 selection described above once the owner
approves V2. Final R1 inventory bytes must bind every exact URL/source pair,
including known previous representations.

#### Issuance record schema for the later issuer

Issuance is a separate owner action; the executor only reads this record. The
issuer starts from this exact v3 draft and adds the following strict fields
(no additional or omitted issuance fields):

```json
{
  "status": "ISSUED",
  "issuedAt": "<RFC3339 timestamp>",
  "approver": "<non-empty owner approver>",
  "sourceFetchStopLifted": true,
  "validFrom": "<RFC3339 timestamp>",
  "expiresAt": "<RFC3339 timestamp>",
  "ownerApprovalReference": {
    "sha256": "<sha256 of exact acquisition manifest bytes>",
    "approvalRecordPath": "<absolute path to owner approval record>",
    "approvalRecordSha256": "<sha256 of raw owner approval record bytes>"
  },
  "r1DigestInventoryReference": {
    "sha256": "<sha256 of exact R1 digest inventory bytes>"
  }
}
```

`ownerApprovalReference.sha256` must equal the CLI-bound manifest SHA-256 and
the approved manifest hash inside the independently hashed approval record.
The record also contains `executorCaps` exactly as the unissued draft. The
executor CLI requires record path and expected SHA-256, manifest path and
expected SHA-256, and R1 digest inventory path and expected SHA-256; none is
inferred. It validates the raw record file digest, strict issuance fields,
approval/inventory binding, current time within `validFrom`/`expiresAt`, and
byte-for-byte equivalence to the draft after issuance-only fields are removed.
Draft records, missing approvers, false stop-lift fields, not-yet-valid or
expired records, manifest mismatch and unlisted URLs fail closed. Issuing this
record and lifting the stop are not performed by this executor change.

`executorCaps` is a strict record-bound object with exactly
`maxDocuments`, `maxNetworkAttemptsIncludingPolicyRedirectFailure`,
`maxTotalBodyBytes`, `maxBodyBytes`, `maxHtmlBytes`, `maxCampaignHours`,
`maxInFlight`, `minSpacingSeconds`, `maxRedirects`, `automaticRetries`,
`reviewAfterFirstDocuments`, `modelCalls`, and `paidMicroUsd`. The V2 draft
sets them to250,1200,2684354560,25165824,2097152,16,1,5,5,0,10,0,0. Code enforces
hard ceilings of300 documents,1500 attempts,3GiB total body bytes,24MiB per
response,2MiB HTML,24 hours,one in-flight request,at least5s spacing, exactly5
redirects, zero retries/model calls/spend, and review after exactly10 documents.
The one per response cap applies to policy and document bodies alike. Total
body bytes count all response-body bytes observed on policy, redirect, failed,
and document attempts; they do not measure encrypted packet/TLS framing.
Parsing keeps its separate fixed sandbox caps. Stop rather than reset a consumed budget.

The executor adds a private append-only, fsync-per-entry journal of attempted
wire URLs, timestamps, response-body byte counts, HTTP statuses/failures,
completed and quarantined representation digests, applied changed-source
release hashes and tuples, plus retained/wire byte counters. Budgets derive
from this journal on resume; torn or inconsistent records fail closed. A
changed-source review is appended and hash-chained into the journal, not added
to the stable `{journalPath,recordSha256,manifestSha256}` source guard.

## Required approvals and receipts before acquisition

1. **Before any network request, including robots/TDM:** genuine owner-approved
   R2 corpus/manifest scope, exact final registry/source set, caps and policy-only
   bootstrap authority; separate security review and genuinely issued v3 stop
   release; patched parser build/inventory/root review and actual gate evidence;
   pinned new R2 runtime, read/write realm and reviewed budget/allowlist executor.
   Choice C/#103 is decision context, not automatically all these permissions.
   The R1 source generation/owners/seals/receipts remain frozen and drained.
2. **Before the first document request:** current authenticated robots directive
   or evidenced404/410 absence, standardized TDM JSON or evidenced404/410 absence,
   required already-known machine-policy references and actual registered-source
   eligibility for that exact URL/scope. If proofs need refreshing, only the
   explicitly approved policy-only phase may fetch them first. A generic owner
   statement cannot manufacture observations or bypass an access barrier.
3. **Seven-day eligibility:** `sourcePolicyValidityMs` grants604800000ms only
   when registered-source scope/discovery/audit/registry identity genuinely
   matches. Other public sources retain3600000ms. `sourcePolicyExpiresAt` uses
   the oldest real relevant source/robots/TDM clock; never issuance time, a
   future/absent clock or a fresh wrapper around old evidence. Recheck actual
   authority, opt-out, receipt scope/hash/current eligibility and required
   execution horizon. Do not assume every old Oct20 receipt remains valid for
   every R2 URL or that a registered hostname alone grants seven days.
4. **After receiving original bytes, before admission/processing:** exact source
   digest and immutable HTTP observation, original dispatched method/URL and
   redirect evidence, source-specific policy receipt, document-origin and
   per-representation HTTP/HTML/PDF-XMP TDM findings, all managed custody bindings.
   A receipt for a not-yet-fetched document cannot exist beforehand. Retain
   prior/changed hashes for quarantine; no inference under this acquisition-only
   approval. Current valid proofs may be reused only through normal exact
   recheck, not by rewriting their clocks or receipt bodies.
5. **Owner rights decisions:** any robots-disallowed/unavailable or TDM-reserved
   official-work exception needs the genuine applicable owner decision and
   source/discovery/origin evidence, explicitly adopted for R2 where required.
   #103 is not municipal permission, a redistribution licence, login consent or
   an exemption for non-official/uncertain work. No autonomous contact or bypass.
6. **Later inference/publication:** separately approved new immutable R2 corpus,
   processing/model/prompt/schema/assessment pins and spending/custody, plus
   independent high-impact changed-fact review and normal release/value gates.
   Neither v3 nor same-model judging supplies this independence.

## Contract and evidence boundary

polite-fetch changes affect acquisition; parser-worker changes intentionally
change parser isolation/output and dependent preparation/structured closures.
This is a new R2 processing distribution, not an acquisition-only R1 repin.
The installed old parser review must fail against the new runner contract.
No root review or historical fingerprint/receipt was edited. Main must measure
all affected contracts in the actual integrated runtime before issuing v3.

The prior all14-contract report is not a fresh integrated-runtime measurement
for this regression-repair branch. The acquisition contract was freshly
measured in a separate Node24.22.1 process using this worktree's
`src/district-r1.ts` after the fetch-guard and response-accounting repairs:
SHA256 `b356e7e86d24504b8460c0f055c0e6aa20b23750182755d281b82ece48aa72f5`.
Measurement record `reports/r2-acquisition-contract-measurement.json` SHA256
`1744396cf6c85030a45cf092992f7c5e3d952413328a7860bfdd4036068fdf41`.
Other preparation/parser contracts, installed image/runtime review and the
integrated 14-contract set remain for the main integration review before
issuance.

## Exercised verification

`tsc --noEmit` passed. The six required suites (`council`, `polite-fetch`,
`registered-source-policy`, `genesis-owner-credentials`,
`r2-acquisition-executor`, `district-terminal-exceptions`) report **142 total,
142 passed, 0 failed/cancelled/skipped**. This includes all five previously
reported regressions. The executor suite alone reports **9/9 passed**, covering
localhost fake HTTP, exact allowlist and redirect rejection, duplicate manifest
URL refusal, budget stops, policy attempt accounting, ten-document review
pause, changed-R1 quarantine, crash resume and stop-file handling. The fixture
used the explicit test-only localhost wire seam and isolated fixture authority;
no civic source was fetched. All checks ran under
`/home/max/.local/bin/stadtstack-cpu-slot` with `umask 022`, Node24.22.1 and
worktree-local dependencies.
The contract-cutover transition suite reports **6 tests: 5 passed, 0 failed,
1 skipped**; the skip is the explicitly pending Core v2 migration/old-reader
integration and is not a passing gate. `tsc --noEmit` also passed after these
cutover changes.

No live-source fetch, issuance, source-fetch-stop lift, parser build/SBOM,
privileged review or production CLI/DB write was run. The executor
implementation is an unissued gate only; the main integration review must
still verify the full affected contract set and runtime/image boundary.

Root `docs/ontology.yaml` and `docs/ONTOLOGY.md` were read. No civic concept,
assessment truth claim or DocumentDisposition semantics changes here; both
ontology files are intentionally unchanged. A draft/authority remains distinct
from a source observation, actual processing receipt or independent validation.

## R2 code-freeze operations

This is a lead-operated sequence for a future freeze, not an authorization,
production cutover, source-fetch approval, or record issuance. The generators
write only private drafts/reports. They never read or write `/etc/stadtstack`.
Do not merge from this branch; the integration lead merges the independently
reviewed R2 SDK, fetch-hardening, executor, structured-mapping, extraction,
step-8 replay, and v2-codec slices before the freeze run.

Follow this order:

1. **Merge slices.** Merge the reviewed branches into the designated
   `rebuild-r1` integration tree, including the v2 codec before measuring final
   fingerprints. Keep each slice's review, tests and commit identity. Stop for
   unresolved conflicts or a dirty/uncommitted integration tree.
2. **Measure all fourteen contracts twice from fresh processes.** From the
   clean integrated `stadtstack-data` root, keep output outside the checkout:

   ```sh
   umask 077
   set -eu
   STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/stadtstack-data"
   mkdir -p -m 0700 "$STATE_ROOT"
   RUN_DIR=$(mktemp -d "$STATE_ROOT/r2-contract-freeze.XXXXXX")
   node --experimental-strip-types scripts/r2-contract-fingerprints.mjs "$PWD" >"$RUN_DIR/contracts-1.json"
   node --experimental-strip-types scripts/r2-contract-fingerprints.mjs "$PWD" >"$RUN_DIR/contracts-2.json"
   cmp -- "$RUN_DIR/contracts-1.json" "$RUN_DIR/contracts-2.json"
   ```

   Each invocation launches a new Node process per exported contract. The
   versioned report contains every complete contract hash, exported value,
   sorted source-file closure and closure-file SHA-256, the source revision,
   clean-tree flag and full-set digest. Require exactly fourteen families,
   `sourceTreeClean:true`, identical complete reports and no missing/empty
   closure. Preserve both exact reports and their SHA-256 outside the source
   tree; never copy one into an input tree before computing the clean-tree
   identity.
3. **Rebuild the parser image if needed.** The prepared candidate
   `sha256:4feb00e1d9fa7802c523e9b6af16b8ab72014e0bf812d1b345b7a155eb608046`
   is usable for review only if the final parser isolation and parser-output
   contracts still match its recorded image evidence in the unissued v3 draft.
   In particular, a changed `district-parser-worker.py` means the image must be
   rebuilt. Rebuild from the final committed inputs using the approved offline
   build procedure, then record the actual immutable image ID and refreshed
   SBOM/image evidence. Do not relabel the old digest or pull an unreviewed
   image. An unchanged image ID is not authorization.
4. **Review.** Independently review the final parser image/runtime and
   isolation boundary, and the final OMP-B image, binary, host resolver,
   daemon/socket and runner. Review metadata must be real, final and
   non-future-dated. Prepare one strict input document for
   `scripts/r2-review-pin-drafts.mjs` using exactly
   `schemaVersion:"stadtstack-r2-review-pin-draft-input-v1"`,
   `parser:{imageId,securityReviewId,reviewedBy,reviewedAt,dockerSocket}` and
   `omp:{imageId,ompBinarySha256,hostResolverBinarySha256,dockerDaemonId,securityReviewId,reviewedBy,reviewedAt,dockerSocket}`.
   The identities, image/binary/daemon hashes and review time come from the
   real independent review and host inspection; do not use synthetic/example
   values for issuance. The generator accepts only the current user's dedicated
   owner-private root, not arbitrary directories or managed policy/CAS/cache
   state:

   ```sh
   DRAFT_DIR="$HOME/.local/state/stadtstack-data/r2-review-pin-drafts"
   install -d -m 0700 "$DRAFT_DIR"
   node --experimental-strip-types scripts/r2-review-pin-drafts.mjs "$REVIEW_INPUT" "$DRAFT_DIR"
   sha256sum "$DRAFT_DIR/parser-isolation-review.draft.json" "$DRAFT_DIR/omp-b-review.draft.json"
   ```

   The generator hashes the current exported runner contracts and validates
   the exact exported `ParserReviewSchema` and `OmpReviewSchema`. A candidate
   parser image is refused when its recorded parser isolation/output
   fingerprints no longer match. The output files are drafts, not reviews or
   authorizations; retain their exact bytes and hashes with the external review
   record.
5. **Lead authorization install.** Only the authorized lead, after review, may
   install those exact approved bytes. The generator must never be pointed at
   `/etc/stadtstack`; do not use this worktree or a script run as root to
   create/modify authorization. After independent approval, install and verify:

   ```sh
   sudo install -o root -g root -m 0644 "$DRAFT_DIR/parser-isolation-review.draft.json" /etc/stadtstack/parser-isolation-review.json
   sudo install -o root -g root -m 0644 "$DRAFT_DIR/omp-b-review.draft.json" /etc/stadtstack/omp-b-review.json
   cmp -- "$DRAFT_DIR/parser-isolation-review.draft.json" /etc/stadtstack/parser-isolation-review.json
   cmp -- "$DRAFT_DIR/omp-b-review.draft.json" /etc/stadtstack/omp-b-review.json
   sudo stat -c '%U:%G %a %n' /etc/stadtstack/parser-isolation-review.json /etc/stadtstack/omp-b-review.json
   ```

   Confirm both byte-for-byte comparisons succeed and the displayed
   ownership/mode is `root:root 644`; both readers also reject unsafe ancestry,
   symlinks, future review times, schema drift and stale runner hashes.
6. **Sentinels and compatibility gates.** First read each installed review
   through the production reader, which checks the exact current contract
   without launching Docker, reading credentials or writing authority:

   ```sh
   node --experimental-strip-types --input-type=module -e '
   import {readParserReview} from "./src/district-parser-isolation.ts";
   const review=await readParserReview();
   console.log(JSON.stringify({imageId:review.imageId,runnerSha256:review.runnerSha256}));
   '
   node --experimental-strip-types --input-type=module -e '
   import {readOmpRunnerReview} from "./src/district-omp-b-runner.ts";
   const review=await readOmpRunnerReview();
   console.log(JSON.stringify({imageId:review.imageId,runnerContractSha256:review.runnerContractSha256}));
   '
   ```

   Then run parser isolation sentinels on the reviewed Linux image, with the
   existing authorized fixture authority and no downloaded document:

   ```sh
   STADTSTACK_PARSER_SECURITY_TESTS=1 node --experimental-strip-types --test --test-concurrency=1 \
     test/district-parser-isolation.test.ts test/document-origin.test.ts test/pdf-tdm-policy.test.ts
   ```

   Run source-free OMP-B runner/output fixtures and the strict old-R1-reader
   /new-R2-pin transition fixtures:

   ```sh
   node --experimental-strip-types --test --test-concurrency=1 \
     test/district-omp-b-runner.test.ts test/district-omp-output-diagnostics.test.ts \
     test/r2-contract-transition.test.ts
   ```

   The v2-reader compatibility case is a conditional pending integration test:
   it must run (not skip) after the Core codec/migration source is merged. It
   provisions a fixture authority, commits a valid manifest through Core's
   exported v2 migration, verifies the v2 reader accepts the same inventory ID,
   then verifies the R1 reader rejects without rewriting it. Do not count its
   current pre-merge skip as a passing compatibility gate.

   These are not model calls or a substitute for a real image review. The
   parser environment flag enables tests; it does not authorize the sandbox.
   For the inventory boundary, include the deployed 0.3.2 tools, old R1 tools,
   every Core consumer, active scratch/daemon callbacks, and any inventory
   writer/reader in a genuine, exhaustive process/old-reader-marker census.
   The observation JSON pins `stateDir`, `authorityId`, `authoritySha256`,
   `observedAt`, `drainProofPath`, `activeLeases` and `oldReaderMarkers`.
   Independently hash-pin both the complete observation JSON and exact Core
   drain-proof bytes; neither expected hash may be taken from the file it pins.
   The drain and census `observedAt` values must match, and the evidence must be
   no more than 60 seconds old at check time. Run:

   ```sh
   node --experimental-strip-types scripts/r2-cutover-check.mjs \
     "$DRAIN_OBSERVATION" "$OBSERVATION_SHA256" "$DRAIN_SHA256"
   ```

   The checker invokes Core's merged `migrateCivicPolicyInventoryV2` with
   `dryRun:true`. Core takes/releases its exclusive inventory lock, verifies
   the current authority and raw inventory hash against the independently
   pinned drain proof under that fence, and refuses live inventory leases or
   writers; it does not migrate or replace the inventory. The checker also
   refuses a stale/future/replayed drain timestamp or any non-empty
   hash-pinned lease/old-reader census. A missing Core v2 validator fails
   closed. Stop on every lease or marker; never retry using a fabricated empty
   census.
   This readiness result is a point-in-time preflight, not a lease or reusable
   authorization. Any actual migration must repeat its checks under its own
   lock.
7. **Issue the R2 district v3 record separately.** Main/lead must resolve the
   source-fetch security review, exact final source/manifest and registry
   membership, genuine owner approval, final R1 digest inventory, real current
   runtime/image evidence and current processing generation before the v3
   record is issued. The current draft remains unissued and does not lift the
   stop. The fingerprint and review-pin generators do not issue v3 or perform
   a fetch.
8. **Issue GENESIS authorization separately.** GENESIS is a distinct structured
   source plan and owner/source authorization, not a side effect of district
   v3 issuance or the old R1 approval. Main/lead must complete the structured
   v3 review and exact nine-AGS/request-plan/owner-proof requirements in
   [`R2_STRUCTURED_SOURCES.md`](R2_STRUCTURED_SOURCES.md) before any preflight
   or data request. No GENESIS request or issuance is performed by these tools.

### Still open until code freeze

- The listed R2 slices must be merged, reviewed together and committed as one
  clean integrated source revision; this branch does not merge them.
- The fourteen-contract fingerprint tool is implemented, but the exact final
  report still must be generated twice on the clean integrated tree, reconciled,
  retained externally and used to mint the current generation pin.
- The pure R1/R2 pin validators must be wired into the merged job/receipt
  boundary: authenticated historical R1 jobs use their exact recorded pin set,
  and every newly admitted R2 job must pass the current-generation check. The
  focused fixtures prove validator behavior, not live queue integration.
- Core's v2 codec/migration source is not merged in this branch. The checker
  fails closed until Core exposes its locked migration dry-run, and the valid
  committed-v2 compatibility test is explicitly pending/skipped until that
  source exists; after merge it must run and pass without a skip.
- The parser image must be rebuilt if its final image inputs/worker differ from
  the candidate, then independently reviewed with current real image/SBOM
  identity. The OMP runner/image/resolver/daemon review and both root-owned
  installed files remain a lead action.
- Installed-review readback, parser image sentinels, OMP source-free
  compatibility tests, Core's live fenced dry-run and a genuine externally
  hash-pinned lease/old-reader census must all pass on the freeze host.
- R2 v3 and the separate structured GENESIS v3 each need genuine owner/source
  proofs and explicit Main/lead issuance. Neither current draft status nor
  these offline tests imply permission to fetch or use GENESIS credentials.
- This worktree's ordinary phase passed: **2,293 tests, 2,244 passed, 0 failed,
  0 cancelled and 49 skipped**. One skip is the pending Core v2 integration
  above; rerun ordinary on the clean integrated tree before freeze.
