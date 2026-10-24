# R2 district acquisition security review and v3 release preparation

## Decision and scope

Owner choice C (#103), as reported by Main: close R1 and prepare approximately
100–140 new documents for R2. This branch starts at
`33fa1d3df5daa485b609be9a2ab904add3cfb649`; it neither reopens R1 nor extends
its processing/source pin. No source request, production DB/CLI write,
container build/start, service change or authorization issuance is performed.
The v2 security release was limited to the structured step8 continuation.
It is not permission for the district crawler or a new R2 corpus.

Draft: [`../reports/r2-district-source-fetch-security-release-v3.draft.json`](../reports/r2-district-source-fetch-security-release-v3.draft.json).
It has `issuedAt:""`, `approvedBy:null`, `sourceFetchStopLifted:false` and a
DRAFT-only schema/status. **It cannot clear the SS-01 stop.** Its runtime/image,
manifest, authority and executor prerequisites must be independently satisfied
before Main creates any genuinely issued release.

## Findings and dispositions

Severity describes security impact if a reachable condition occurs, not proof
that a source, host, parser or historical result was compromised.

| ID | Severity | Concrete finding | Disposition |
| --- | --- | --- | --- |
| R2-F01 | High, upstream advisory / release blocker | The root parser review still points at image08cbb520… and a pre-21October Node22 base. The image's exact current Node/package inventory is not established by that review. No patched rebuild/SBOM/new review is present. | Added a bounded source-free patched-Node check **before parser worker readiness**. The worker accepts only fixed22/24 LTS lines (22.23.4+/24.22.1+); old/unknown/prerelease lines fail. Changing worker bytes invalidates the old runner contract before Docker. **Still requires an independently verified patched base, rebuilt image, inventory, containment sentinels and new root-owned review.** No fabricated digest or image upgrade claim. |
| R2-F02 | High, conditional transport integrity | HTTPS requests relied on Node's default certificate verification, which an inherited `NODE_TLS_REJECT_UNAUTHORIZED=0` can disable. | Fixed: HTTPS options explicitly set `rejectUnauthorized:true` and `minVersion:'TLSv1.2'`; DNS pinning, URL hostname/SNI and `agent:false` remain. Synthetic test intercepts the transport constructor under the insecure environment and verifies exact options; no handshake or public host probe is claimed. |
| R2-F03 | Medium, source-integrity downgrade | A same-host HTTPS document redirect could change to HTTP; hostname equality alone did not preserve transport security. | Fixed before destination dispatch: HTTPS→HTTP is `invalid_redirect` for documents and standardized TDM policy redirects. HTTP→HTTPS and same-host HTTPS path changes remain; R2's exact allowlist itself contains HTTPS only. |
| R2-F04 | Medium, stale launcher / runtime drift | Identity-only body handling removed Brotli exposure but did not stop a stale launcher from using a Node runtime with the advisory's other HTTP/TLS/DNS flaws. | Fixed: live `wire()` requires a fixed22/24 LTS version before initialization/DNS/transport. Tests reject24.21.0,24.22.0,22.23.3,unknown majors and malformed/prerelease versions. v3 must additionally pin the actual24.22.1 binary/hash; the version floor is not a signed runtime review. |
| R2-F05 | High, authorization/budget prerequisite | Generic `crawlHtmlSource` can expand discovered links; its public `requestCount` and maxRequests count logical fetch calls, not every robots/TDM/redirect wire attempt. It has no run-wide byte ceiling and scheduling is exact-host, not a global42-source rate pool. | v3 stays unissued until the reviewed R2 executor enforces exact request membership and all-wire request/byte/global-rate/time limits. The draft supplies exact URLs and caps; the old R1 crawler CLI is **not** a substitute. No unexercised budget enforcement is claimed by this branch. |
| R2-F06 | High, SS-02 integrity / inference prerequisite | Exact quotes, strict schemas and same-model faithfulness do not establish source truth. Crawler digest replacement lacks an independent defacement/high-impact-change hold. | Not waived. Draft requires quarantine of changed known prior digests, anomalous MIME/template/mass-host changes and independent review of high-impact additions before inference. Acquisition approval gives zero model calls and no publication permission. A separately reviewed integrity gate/clearance is still required; no unimplemented semantic detector is claimed. |
| R2-F07 | Medium, representation-boundary prerequisite | Generic fetch supports several native/API/structured formats and may retain a representation before the HTML adapter later labels it unsupported. Generic MIME acceptance is broader than a district HTML/PDF campaign. Host-side HTML discovery still uses Cheerio. | v3 narrows document response types to HTML/XHTML/PDF, forbids archive/executable/unsupported outputs, and requires a reviewed executor's MIME/size admission before downstream use; policy JSON/directives remain separate. Unknown types must hold, never be treated as an empty successful crawl. PDFs/ZIP/XML still have their existing sandbox bounds. No JavaScript/browser execution path was found. |
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

The offline manifest was frozen byte-exactly at
`/home/max/.local/state/stadtstack-data/r2-fetch-security-evidence/R2_ACQUISITION_MANIFEST.snapshot.json`,
SHA256 `ea0478d57d7b68a105772fbe46b3bcc1e355c89bf5314aa96d6314388f2ffba5`.
It contains120 candidate source bindings but112 distinct HTTPS GET URLs, from18
selected source scopes on11hosts. The draft enumerates every document URL,
method, permitted document MIME and source/candidate binding, plus22 exact
robots/TDM policy URLs. No hostname wildcard, subtree prefix, query mutation,
automatic redirect target or discovery expansion is allowed. Unlisted policy
references also stop pending a genuine reviewed amendment.

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

Proposed, **not approved**, maxima:140documents; review after the first10;
600total actual network attempts including policy/redirect/failure requests;
22initial policy-probe requests;24MiB per HTTP body,2MiB HTML before host
discovery and1MiB policy bodies; a proposed1GiB controller memory boundary;
1GiB total HTTP-body bytes;
1GiB retained source bytes;8h campaign wall;25s DNS and25s wire;5redirects;
1global/host in-flight and at least5s global spacing (or longer robots delay);
zero automatic retries, zero model calls, zero paid micro-USD. The byte measure
is HTTP body bytes supplied by Node, not encrypted packet/TLS framing counts.
Parsing keeps the fixed sandbox caps. Stop rather than reset a consumed budget.

Monitoring proposal: private append-only per-attempt journal and30s aggregation
of exact/canonical request identity, status/failure, times, body byte counts,
Content-Encoding/MIME, Retry-After/cooldown, provenance/HTTP/policy hashes,
parser image/contract/outcome and remaining budgets. Alerts are content-free;
no source text, cookies, authorization/account material. Stop on unavailable
accounting, authority/runtime/manifest drift, any unsupported encoding/MIME,
network/security/access/policy failure, parser isolation/resource/protocol failure,
changed prior digest, operator interrupt, or disk below a proposed10GiB floor.
The journal/executor is a precondition, not something implemented or run here.

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

All14 actual contract functions were measured against33fa1d3. Seven changed:
preparationExtractor, residualPreparation, residualJob, acquisition,
structuredStateGauges, parserOutput, parserIsolation; seven are unchanged.
Evidence: `r2-fetch-security-evidence/contracts.json`, SHA256
`dd79a20c3f541d87abe3227fd1f55520194038a06ee338a99ba7e8a2971bc421`.
Acquisition is
`fe28346ef211d0cc025c8d65a9656f84ec2d4a5de2115b623f0a409b1599016c`;
parser isolation is
`0ea795fdf8b51ac6a40b889aa17181af0e65550a83eba561419af64e5f4e7268`.
These are prepared branch fingerprints, not integrated-image approvals.

## Exercised verification

Every Node check used
`flock /home/max/.local/state/stadtstack-data/test-cpu.lock taskset -c 2-7 nice -n 10`,
Node24.22.1 and umask022. `tsc --noEmit` completed exit0 with no output.
The combined focused run used `--test-concurrency=1 --test-isolation=none` for
polite-fetch, district-parser-worker and district-parser-isolation tests:
**117 total,92 passed,0 failed/cancelled,25 skipped**,39.63s test duration.
The25 skips are the non-Linux path and opt-in real-image/container sentinels;
`STADTSTACK_PARSER_SECURITY_TESTS=0` deliberately prevented production/Docker
sentinels. TLS testing intercepted constructor options and did not establish a
real handshake. The Python worker test mocked the bounded source-free version
probe and proved no readiness message on failure; it did not run the image.
The all14 measurement completed exit0 under the same lock.

Exact commands/results and limitations are in
`/home/max/.local/state/stadtstack-data/r2-fetch-security-evidence/checks.json`,
SHA256 `fe82293f67922769ce28fd31fa3f3566645f8ad4a84990db5697d1ab87298e76`.
The initial300s typecheck call timed out during shared-lock contention without
output; the successful retry used a3600s lock-inclusive deadline. No test or
compiler failure is inferred from that wait timeout. No live-source, real TLS,
parser build/SBOM, privileged review, production CLI/DB or full-suite check ran.

Root `docs/ontology.yaml` and `docs/ONTOLOGY.md` were read. No civic concept,
assessment truth claim or DocumentDisposition semantics changes here; both
ontology files are intentionally unchanged. A draft/authority remains distinct
from a source observation, actual processing receipt or independent validation.
