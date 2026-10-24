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

The owner description says42sources; the actual registry and registered robots
scope table have43entries. All selected scopes must still be reconciled during
issuance; the universe mismatch is not silent approval of43sources. The final
manifest's 221 URL/source pairs are unique; `alsoListedUnder` entries are
informational only. Final R1 inventory bytes must bind every exact URL/source
pair, including known previous representations.

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

The historical all14-contract report below is not a fresh integrated-runtime
measurement for this executor branch. The acquisition contract was freshly
measured in a separate Node24.22.1 process using this worktree's
`src/district-r1.ts`: SHA256
`b61fad1f140fed5a869038021eab3aea77c031a8d2cbdf4c196e3b79d148d2dd`.
Measurement record `reports/r2-acquisition-contract-measurement.json` SHA256
`e5173c09a7fba90883dc7747091656bbc525567a8496823faa9b6f84706ec9b6`.
Other preparation/parser contracts, installed image/runtime review and the
integrated 14-contract set remain for the main integration review before
issuance.

## Exercised verification

`tsc --noEmit` passed. The focused executor suite reports **9 total, 9 passed,
0 failed/cancelled/skipped**. It covered localhost fake HTTP, exact allowlist
and redirect rejection, duplicate manifest URL refusal, budget stops, policy
attempt accounting, ten-document review pause, changed-R1 quarantine, crash
resume and stop-file handling. The fixture used explicit test-only localhost
wire substitution and isolated fixture authority; no civic source was fetched.
The suite ran under `/home/max/.local/bin/stadtstack-cpu-slot` with
`umask 022`, Node24.22.1 and worktree-local dependencies.


No live-source fetch, issuance, source-fetch-stop lift, parser build/SBOM,
privileged review, production CLI/DB write or full-suite check was run. The
executor implementation is an unissued gate only; the main integration review
must still verify the full affected contract set and runtime/image boundary.

Root `docs/ontology.yaml` and `docs/ONTOLOGY.md` were read. No civic concept,
assessment truth claim or DocumentDisposition semantics changes here; both
ontology files are intentionally unchanged. A draft/authority remains distinct
from a source observation, actual processing receipt or independent validation.
