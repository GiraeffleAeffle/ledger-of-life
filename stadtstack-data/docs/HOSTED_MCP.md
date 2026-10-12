# Protected hosted civic MCP: owner guide

The protected endpoint is **https://mcp.stadtstack.eu/mcp**, upgraded to the 20-tool **0.3.1** release on 11 October 2026 at 13:41 UTC (15:41 Berlin). It exposes read-only civic tools; use MCP `tools/list` for the current inventory. Personal bearer access is required. Client-specific GUI interoperability is not implied by the exercised generic HTTP acceptance below.

## HTTP and security contract

- Stateless Streamable HTTP: authenticated **POST /mcp**, JSON responses, no persistent session. MCP clients must support this mode; an SSE-only client is not compatible.
- `GET /mcp` and `DELETE /mcp` are unsupported. No bearer tokens in URL/query parameters. No browser CORS access is provided; use a native client or a local stdio bridge, not browser JavaScript.
- Header: `Authorization: Bearer <personal-token>`. This is a private bearer credential, **not OAuth**. Never paste it into prompts, tickets, repository configuration, shell history, or logs.
- Default limits: **60 authenticated HTTP/RPC requests/minute/token**, **4 concurrent requests/token**. The existing `max` and `buzz` identities now have explicit operator profiles of **300/minute and 8 concurrent**; their credentials were not rotated. Names alone never elevate access. The **32 KiB request body** and **30-second request deadline** are unchanged. Avoid parallel client retries that amplify throttling.
- Public unauthenticated **GET https://mcp.stadtstack.eu/health** is for health checks, not MCP discovery or authentication. Operational logging is counts-only: no credentials, token hashes, authorization headers, request bodies, tool arguments, or results.
- One operation per HTTP request: JSON-RPC batches are rejected. One server replica, maximum 32 active requests overall and 128 connections. Rate windows are fixed UTC minutes and reset on restart; limits are not a distributed quota.
- Quota counts authenticated HTTP requests, including initialization, discovery, retries and invalid authenticated requests—not just useful tool calls. Multiple clients using one token share its budget. An observation of roughly 35 useful calls therefore does not establish that only 35 HTTP requests occurred. Configuration is validated and frozen at startup; changing a file does not hot-reload limits or reset counters on ordinary requests.

## Read-only tools and evidence

The **20-tool contract below is live with literal Git tag, image tag and MCP version `0.3.1`**. Current and historical acceptance records are separated at the end of this guide. Use `tools/list` and `get_release_status` to identify the exact live inventory and whole-data release.

| Tool | Purpose |
| --- | --- |
| `list_cities` | Published catalogue cities plus separately labelled regional-evidence-only municipalities |
| `list_topics` | Shared hierarchical topic registry, auditable provenance and per-city eligible/withheld counts |
| `get_core_bundle` | Exact shared Strausberg facts and separate core release manifest |
| `get_release_status` | Whole-data release identity/quality and preserved core manifest |
| `search_signals` | Shared-topic/text search for one city or regional municipality, including null geometry |
| `search_signals_near` | Bounded point-radius search using the same record projection/cursor |
| `search_signals_along` | Buffered line search, at most 32 vertices, using the same projection/cursor |
| `get_signal` | Full query record by fact/record ID, with source IDs and original verification evidence |
| `get_sources` | Original attribution by **fact/record ID**; retains fact verification semantics |
| `get_source` | One original attribution object by **source ID**, not a fact ID |
| `get_changes` | Catalogue stable IDs added, changed or removed since publication |
| `search_topics` | Shared-topic/text search across up to 50 selected cities/regional municipalities |
| `get_council_items` | Published council papers, meetings and regional council-agenda evidence |
| `get_regional_topics` | Regional-evidence discovery by shared topic/municipality |
| `compare_topic` | Case-based topic/stage comparison, with separate record, identified-case and unresolved-case counts, milestone evidence and scoped coverage |
| `similar` | Deterministic cross-city case discovery, with scores and member evidence—not a learned model or success claim |
| `entity_search` | Source-quoted entity groups, identifiers and explicit identity uncertainty |
| `graph_neighbors` | Typed quoted relationships with source evidence, modality and path eligibility |
| `graph_path` | Bounded directed source-evidence paths; never causal, spending or success proof |
| `export_records` | Cursor-paged full normalized/original records, page-only sources and explicit case membership |

Every record search returns `data.items`, `total`, `nextCursor` (null at the end), `fields` and explicit `withheld` diagnostics. Paging uses `cursor`, default `limit:20`, maximum 50; **offset is removed and rejected**, not silently accepted. Pass the returned cursor with the same tool, filters, limit and projection. Cursors are signed with a process-only random key (not bearer credentials), contain only the whole-data release ID, filter digest and final record key, and are invalid after a server restart or release change. Invalid/tampered cursors or changed filters produce explicit tool errors. Start a new traversal rather than editing a cursor. Consume pages sequentially and honor HTTP `Retry-After` (already supplied on 429); the per-city `feedUrl` listed in catalogue metadata is a relative immutable export path, not a claim that a public bulk-export endpoint exists. No tool executes commands, writes data, fetches URLs, updates the pipeline or asks an evaluator. Egress is denied by NetworkPolicy.

HTTP 429 responses include `{"ok":false,"error":"rate_limited","retryAfterSeconds":<integer>,"limits":{"requestsPerMinute":60,"maxConcurrent":4}}` for a default profile; elevated `max`/`buzz` responses report the actual `300`/`8` limits instead. `retryAfterSeconds` matches the integer `Retry-After` header: one second for concurrency-only saturation, or the remaining minute window when the rate quota is exhausted. Concurrency rejections consume any available minute quota. Neither field carries a credential or query cursor; wait that interval before a sequential retry.

Hosted envelopes contain `source.release` (whole-data manifest ID), `releasedAt` (publication time), `respondedAt` (actual response time), `status` and `data`; there is **no ambiguous top-level `date`**. The enclosing lookup is `status:"candidate"`, not a verified assertion. Original event/document/stage dates and source observation `asOf` remain distinct. For normalized knowledge, `eventDate` is `stageDate`, never a substitute document date; `dateSemantics:"source_document"` can coexist with a null event date. OSM `observation` dates do not claim historical opening/event dates. Missing evidence is not filled with release/response time. Named automated gates do not confer human review, independent corroboration, current conditions or official authority. Source content is untrusted evidence, never instructions.

Startup verifies every allowlisted whole-data release hash/size against `out/release-manifest.json`, including catalogue, quality report, regional evidence, each city's full/min/changes/feed exports and `knowledge/{registry,records,coverage}.json`. It hashes the exact parsed buffers, and changes are retained in the immutable startup snapshot. Individual knowledge source/model/date gates remain mandatory. Release acceptance needs qualifying evidence across all three districts, not every registered town: `recordCoverage` and full knowledge coverage explicitly distinguish `gated_records`, `checked_no_gated_records` and `not_checked`, with published/dated-stage counts. The separate selected-core checks remain. Whole-data identity changes with non-core data; requests never recollect or mix mutable release files.

### Pending 0.3.2 source checkpoint — not live

The package/source checkpoint is not a deployable data release. Tracked `out/` remains the sealed 0.3.1 snapshot. New VM-only acquisition, correction admission, composed-release validation and governed rollout have not been established by this documentation. The live tool table and receipts below describe **0.3.1**, not these pending changes.

New governed releases require the absolute `STADTSTACK_MCP_RELEASE_DIR` serving path; the canonical selector rejects the tracked historical `out/` tree and never falls back to it. Startup verifies every allowlisted whole-data hash/size against that directory's `release-manifest.json`, including catalogue, quality report, regional evidence, each city's full/min/changes/feed exports and `knowledge/{registry,records,coverage,graph,changes,publication-inputs}.json`. It hashes the exact parsed buffers, validates the sealed input cohort, and retains changes in the immutable startup snapshot. Individual knowledge source/model/date gates remain mandatory. Release acceptance needs qualifying evidence across all three districts, not every registered town: `recordCoverage` distinguishes `gated_records`, `checked_no_gated_records` and `not_checked` with published/dated-stage counts. The separate selected-core checks remain. Whole-data identity changes with non-core data; requests never recollect or mix mutable release files. The historical deployment receipts below are unchanged; this serving contract is not a new deployment claim.

The sealed startup contract additionally requires absolute `STADTSTACK_MCP_REVOCATION_TRUST_FILE` and `STADTSTACK_MCP_REVOCATIONS_FILE` paths into one governed read-only configuration cohort (planned mount `/run/config/mcp-revocations/`). Startup authenticates the exact signed artifact, release ID and pinned Ed25519 public key; missing, unsafe or mismatched configuration fails closed. The verified mask stays in memory. This source contract is not evidence that a production mask or the complete filtered reader has been deployed.

The signed payload's `releaseId` is the 64-character lowercase SHA-256 `dataManifest.id`, derived by `dataReleaseId` from the sorted publication members' exact paths, hashes and byte lengths—not the server version or a descriptive release label. Synthetic graph-mask fixtures use that same codec over their actual graph and record bytes; masks for another publication must fail the release-identity check.

Administrative graph views first validate the complete original graph against the sealed record bytes, then remove every record with a blocked contributor and rebuild only the surviving derived graph. Removed aliases, preferred names, identifiers, mentions and edge/path evidence cannot remain through a shared entity. Responses retain the original sealed `releaseId`/`recordsSha256` and separately identify `administrativeView`; this is not a newly published dataset or a legal withdrawal. Graph cursors bind the exact signed-cohort view identity, even when a different mask happens to leave identical visible records. Existing search budgets and incomplete-result labels still apply.

Pending `get_changes` behavior: Canonical v2 signal/knowledge events per catalogue or registry municipality: reasons, previous/current versions or evidence hashes, and source hashes; publication removal is distinct from explicitly sourced withdrawal or supersession.

Pending graph contract: Graph pages also bind cursors to the release, exact record bytes, filters and budgets. They expose `complete`, `truncated`, explicit status and lower bounds rather than claiming an exhaustive empty result after a budget stop. Budgets are 10,000 searched nodes, 2,000 visited nodes, 10,000 examined edges, 100 paths and 20,000 path-enumeration steps. A zero-hop self-path is identity, not evidence of a municipal relationship; no path is not absence of activity. Types are `operates`, `funds`, `implements`, `plans`, `decides`, `approves`, `amends`, `located_in`, `cooperates_with`, `member_of` and `cites`. Membership points from each explicitly named member to its association/body; a contractor, cooperating town or shared plan is not thereby a member. Paths admit asserted non-action relations (including membership), `decides/decided`, `approves/decided` and `implements/implemented`; `plans` never qualifies. Planned/proposed/conditional/negated/historical relations remain labelled in neighbors. Path responses expose the actual returned-edge `modalities` (empty for a zero-hop path) and `pathEligibility`, not the removed scalar `modality`. Exact `Stadtvertretung <locality>` / `Stadtvertretung der Stadt <locality>` aliases share one council body only within the supplied AGS, retaining original names and quotes. No municipality, legal form, distinct body or complete identifier boundary is erased. Name-based grouping is not independent legal-entity verification; paths establish neither causality, actual spending nor success. Coverage is sparse: the tool description names three committed 0.3.1 operation edges, not a complete relationship inventory or proof of membership coverage. Their edge IDs are release-specific output IDs, not the entity input IDs returned by `entity_search`.

#### Revocation-list signing custody

The owner-authorized dedicated **Ed25519** revocation-list key has been provisioned in the owner's **Mac Keychain**, service `org.stadtstack.mcp.revocation-signer`, account `max`. Its private material is stored only there, not in repository files, images, the cluster, process arguments, environment variables or logs. The public-only provisioning receipt is `~/.cache/cluster-ops/mcp-revocation-signer-public.json`. Key provisioning alone does **not** mean a signed revocation list has been deployed or that the pending release is admitted.

The Mac key still requires the owner's travelling Mac. **A later explicit owner authorization provisioned a separate VM-generated Ed25519 signer** on `codex-workstation`: root-owned mode `0600` at `/var/lib/stadtstack-signer/revocation-signer.pem`, inside a root-owned `0700` directory. This is the approved root-only PEM option, **not age encryption**; no Mac private key was copied. Its public-only receipt is `/var/lib/stadtstack-signer/revocation-signer.public.json`, key ID `ed25519:8393ad2b0087229073c57103c2e47a1b6f6e987c781b00bcbbaae060aa5ceebd`. The governed trust cohort must pin **both** independent Mac and VM public keys. No 0.3.2 artifact has been signed or deployed: a sealed release ID, approved target decision and canonical signing step remain required. Expedited opt-out republication within **24 hours** remains a target, not an availability guarantee. See [the VM resume brief](PIPELINE_HANDOFF.md) and [public handoff pins](../reports/handoff-release-0.3.2.json).

### Live source-bound graph tools

These three tools are part of the live **20-tool 0.3.1** release. Their successful retrieval/acceptance does not establish added answer utility: the frozen 0.3.0 evaluation's seven graph comparisons measured no incremental benefit. That evaluation was not rerun or relabelled for this patch.

The live version is **`0.3.1`**, taken from `stadtstack-data/package.json`: literal Git tag, image tag, OCI version/ref-name metadata and MCP `serverInfo.version` agree. `get_release_status` returns `release: {version, dataManifestId}` alongside the full `dataManifest`; its ID matches `dataManifest.id`. The older v0.2.1 deployment incorrectly reported `serverInfo.version:0.3.0`, so that old value alone never proved a 19-tool rollout. Local/governed image checks establish artifact provenance; public checks establish endpoint/version/data behavior. Running-image identity is evidenced separately by the governed ReadyPod imageID, not by the MCP response.

| Tool | Arguments and evidence |
| --- | --- |
| `entity_search` | Required `query`, optional `type`, `limit` and `cursor`; returns source-quoted entities, identifiers and explicit identity-basis uncertainty |
| `graph_neighbors` | Required returned entity `id`; optional `relationTypes`, `direction` (`in`, `out`, `both`), `limit`, `cursor`; preserves predicate, endpoints, modality, time, conditions and source-record attribution |
| `graph_path` | Required returned `fromId`, `toId`, and `maxHops` (1–5), plus optional `limit`/`cursor`; bounded directed shortest paths over asserted non-action relations and explicitly decided/implemented actions under the returned `pathEligibility` policy |

Graph pages also bind cursors to the release, exact record bytes, filters and budgets. They expose `complete`, `truncated`, explicit status and lower bounds rather than claiming an exhaustive empty result after a budget stop. Budgets are 10,000 searched nodes, 2,000 visited nodes, 10,000 examined edges, 100 paths and 20,000 path-enumeration steps. A zero-hop self-path is identity, not evidence of a municipal relationship; no path is not absence of activity. Types are `operates`, `funds`, `implements`, `plans`, `decides`, `approves`, `amends`, `located_in`, `cooperates_with` and `cites`. Paths admit asserted non-action relations, `decides/decided`, `approves/decided` and `implements/implemented`; `plans` never qualifies. Planned/proposed/conditional/negated/historical relations remain labelled in neighbors. Path responses expose the actual returned-edge `modalities` (empty for a zero-hop path) and `pathEligibility`, not the removed scalar `modality`. Name-based grouping is not independent legal-entity verification; paths establish neither causality, actual spending nor success.

Startup additionally requires `knowledge/graph.json`, bound to and recomputed from the exact admitted v2 record bytes. Facts and graph claims come from the same extraction pass with the original gates plus quoted relation/identity checks. Public coverage reports actual admitted provider/model identities and frozen input/prompt/schema bindings. There is no online graph construction, new crawling, external entity lookup or community detection in MCP.

Graph v2 groups the same source-scoped normalized named entity independently of its original mention type, while retaining the original typed mentions. The live `Stadtwerke Strausberg` lookup returns one company node with three mentions spanning `company` and `organization`, not three independently verified legal entities. Identity-derived IDs changed; rediscover IDs with `entity_search` rather than reusing old graph IDs.

### Shared topic, comparison, filter and projection contract

`topic` must be an ID returned by `list_topics`, such as `solarpark` or `waermeplanung`; unknown IDs are errors. `planning` is a **record type**, not a topic. The shared hierarchy preserves `regional/taxonomy.mjs` leaf IDs and adds parent topics without double-counting descendant records. Assignments retain rule/source/model provenance, supporting quotation/source IDs and model confidence where supplied. Evidence counts are not automatically distinct case counts. `compare_topic` distinguishes quoted authority identifiers from unresolved source-document groups.

`search_topics`, `search_signals`, `get_council_items` and `get_regional_topics` share `query`, `topic`, `recordTypes`, `sourceTypes`, `stage`, `dateFrom`, `dateTo`, `excludePlaces`, `excludeOSM`, `fields`, `limit` and `cursor`. `search_topics` accepts `cityIds`; `search_signals` requires `cityId`; council uses optional `cityId`; regional discovery uses optional `municipalityId`. Unknown cities/topics/source types/stages and reversed date ranges are errors. Inclusive date filters use event/stage dates, not document, observation or publication time. Legacy city stages remain null; normalized knowledge stages do not retroactively relabel legacy records. Main search includes regional and district evidence, but catalogue, `regional_evidence_only` and `district_evidence_only` coverage remain explicit.

Default fields are `id`, `cityId`, `recordType`, `title`, `topics`, `eventDate`, `documentDate`, `stageDate`, `dateSemantics`, `status`, `asOf`, `sourceIds`, `comparisonEligible`. Other advertised projections include statements, geometry, verification, case/AGS/district identity, original status, stage history, entities/locations, extraction provenance, quotations and date reasons. `tools/list` gives the complete bounded allowlist; unknown fields are errors. Query records do not duplicate embedded attribution arrays. Resolve a source once with `get_source({"sourceId":"source:…"})`, or retrieve a record's attribution/verification using `get_sources({"id":"atlas:…"})`.

Example first page:

```json
{"topic":"waermeplanung","cityIds":["hoppegarten"],"excludePlaces":true,"fields":["id","cityId","title","eventDate","status","sourceIds"],"limit":20}
```

For the next page, send the identical arguments plus `"cursor":"<returned nextCursor>"`. A null cursor means that traversal is complete. Changing any filter/projection or switching tools starts a new traversal without the old cursor.

`compare_topic({"topic":"haushalt","cityIds":["strausberg","moelln","ludwigslust"]})` now uses the same eligibility definition as search and returns separate record/case counts, identified/unresolved cases, classified statuses, source-supported milestones and municipality-specific coverage. The live patch query returned **3 / 12 / 19 records and cases**, but only **1 / 0 / 1 identified cases** respectively; the remainder are explicitly unresolved record-based fallback cases, not proven distinct projects. `caseCountMeaning` makes that distinction explicit. Future milestones are not achieved progress, and absent positive milestones do not turn a known rejected/withdrawn status into unknown. Unsupported stage dates remain null rather than inheriting publication dates.

`similar` accepts a released record `id`, optional `cityIds`/`topic`/shared filters and limit, and returns case-based matches with member-record evidence. Its deterministic score is **0.6 token Jaccard + 0.4 topic Jaccard**. Responses expose shared terms/topics and sources; `model:null` is intentional. Grouped cases and unresolved fallback cases are distinguished, not treated as independently identified projects. No embedding/S2Vec, causal-transfer or observed-success claim is made. Zero matches is an honest result.

For bulk analysis, use `export_records({"municipality":"strausberg","limit":20})`, optionally adding `topic` and then the returned `cursor`. The default page has 20 records, maximum 50. It includes full normalized records, `originalRecord`, only the sources referenced by that page, and page-scoped case evidence; `caseId` joins members across pages without claiming that one page contains the full case. A live limit-one probe returned one record plus three sources, with totals of 189 records / 152 cases and a next cursor. This avoids many individual attribution calls; totals remain release/filter scoped, not completeness guarantees about the municipality.


## Issue and publish personal access

From `stadtstack-data`, with Node 22+ on a POSIX workstation:

```sh
node scripts/mcp-token.mjs issue alice
node scripts/mcp-token.mjs hashes
```

`issue` prints only the personal token file path and the hash-manifest path. `hashes` prints only the manifest path, never its contents. Plaintext is written exclusively to:

```
~/.config/stadtstack/mcp-tokens/alice.token
```

The private `stadtstack` and `mcp-tokens` directories are mode `0700`; the token and `token-hashes.json` files are `0600`. Newly created `.config` is also `0700`; an existing `.config` may be less restrictive provided it is not group/world writable. The CLI requires an owner-controlled, non-symlink directory chain with no group/world-writable ancestors (ancestors may be root-owned). It refuses unsafe ownership, file permissions, hard links, symlinks, malformed manifest entries, duplicate IDs/digests, and overwriting an existing personal token file. It does not silently repair unsafe existing paths.

Names must start with a lowercase ASCII letter and contain only lowercase letters, digits, `_`, or `-`, maximum 64 characters. Tokens are 32 cryptographically random bytes encoded as base64url. The manifest is a JSON array of `{ "id": "alice", "sha256": "…" }` records with an optional `limits: {requestsPerMinute, maxConcurrent}` profile; only digests and configuration go to the server. Absent limits retain 60/4 defaults. Explicit limits must be positive safe integers, bounded by 300/minute and 8 concurrent; unknown fields and duplicate IDs/digests are rejected. Do not print even the manifest into terminal logs. Writes use exclusive file creation, a serialized owner lock, fsync, and atomic hash-manifest replacement. These controls do not defend against a compromised process running as the same workstation user.

Publish **only `token-hashes.json`** through the operator's protected Secret workflow, mounted as `/run/secrets/mcp/token-hashes.json`. Never put any `*.token` file in a container, Kubernetes Secret, Git, CI output, or an image. The hosted process reads `MCP_TOKEN_HASH_FILE=/run/secrets/mcp/token-hashes.json` at startup. After updating the Secret, **restart/roll out every hosted replica** to load it; changing the local manifest or mounted Secret alone is not revocation. The expected public origin is `MCP_PUBLIC_ORIGIN=https://mcp.stadtstack.eu`.

Each person must receive their credential through a protected channel into their own owner-only token file (same path convention and permissions). Do not share one person's token among clients/users. Clients necessarily read the credential into memory and send it over HTTPS, but must not persist a second plaintext copy in configuration or logs.

### Update limits without replacing credentials

From `stadtstack-data`, the reviewed CLI updates only an existing identity's explicit profile and prints only the protected manifest path:

```sh
node scripts/mcp-token.mjs set-limits max 300 8
node scripts/mcp-token.mjs set-limits buzz 300 8
```

It preserves IDs/digests and never issues replacement credentials. The **0.3.1 governed release is deliberately limit-only**: it requires those two profiles, retains 60/4 for other identities, validates the existing Secret's complete ID-to-digest map against the desired map before any mutation, and atomically tests Secret UID/resourceVersion while replacing only the named hash-data key. It then performs a controlled restart. It cannot publish newly issued, revoked or rotated identities: those lifecycle changes require a separately authorized governed credential update, not this quota-patch release. Local CLI changes alone never activate or revoke access.

### Revoke and rotate

```sh
node scripts/mcp-token.mjs revoke alice
```

This removes Alice's hash and prints only the manifest path. Publish the updated hash-only Secret and restart every replica; until those replicas reload, the old token may still work. The personal plaintext file is deliberately retained. Its owner may remove it after revocation and client shutdown.

For rotation without overwriting a file, issue a new ID such as `alice-2026`, publish and restart, configure Alice's clients to read that new file, then revoke `alice`, publish and restart again. For suspected compromise, revoke and roll out first, accepting the temporary interruption before issuing a replacement. Existing token files always block reissue under the same ID until the owner explicitly removes them. If issuance fails after creating a file, it remains private but may not be active: resolve the failure and remove that unpublished file yourself before retrying; the CLI never overwrites it.

Commands serialize using `.token-lock`. A crashed process can leave a stale lock; first establish that no token command is running, then inspect/remove only that owner-controlled empty lock directory. Do not delete a live lock or edit the hash manifest to work around malformed-state errors; restore a known-valid protected copy instead.

## Claude Code: dynamic file-backed header

Use a recent Claude Code version supporting [`headersHelper`](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication). The helper reads the file at connection time, so neither the JSON configuration nor command line contains the token. Register at user scope (replace `alice` with your issued ID):

```sh
claude mcp add-json --scope user stadtstack '{"type":"http","url":"https://mcp.stadtstack.eu/mcp","headersHelper":"python3 -c '\''import json,pathlib; t=(pathlib.Path.home()/\".config/stadtstack/mcp-tokens/alice.token\").read_text().strip(); print(json.dumps({\"Authorization\": \"Bearer \"+t}))'\''"}'
```

The shell quoting above keeps Python code inside the stored helper command. Claude captures the helper's JSON stdout as a header; **do not run that inner helper manually**, because its required output contains the credential. Do not enable shell tracing (`set -x`), capture helper stdout in diagnostics, or use the simpler `--header "Bearer $(cat ...)"` approach, which places the credential in process arguments and persisted configuration. Use `/mcp` in Claude Code to reconnect after changing the file path. Availability of `python3` in Claude's environment and helper support in your installed version are prerequisites.

## Claude Desktop: remote integration caveat and local bridge

Desktop's remote integrations may require OAuth and may not permit a custom Authorization header. Do **not** treat this bearer-only endpoint as a native OAuth connector. Where local stdio servers are supported, the maintained third-party [`sparfenyuk/mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy#1-stdio-to-ssestreamablehttp) explicitly supports Streamable HTTP and the `API_ACCESS_TOKEN` bearer environment variable. This is a local bridge option, not a claim of native remote compatibility.

Install a reviewed/pinned release using the proxy's documented `uv tool install mcp-proxy` or `pipx install mcp-proxy` workflow. In Desktop's local MCP configuration, use a shell wrapper to read the personal file into the child environment without printing it:

```json
{
  "mcpServers": {
    "stadtstack": {
      "command": "/bin/sh",
      "args": [
        "-c",
        "set +x; API_ACCESS_TOKEN=$(cat \"$HOME/.config/stadtstack/mcp-tokens/alice.token\") || exit; test -n \"$API_ACCESS_TOKEN\" || exit 1; export API_ACCESS_TOKEN; exec \"/absolute/path/to/mcp-proxy\" --transport=streamablehttp https://mcp.stadtstack.eu/mcp"
      ]
    }
  }
}
```

Replace the proxy path with its installed absolute path and the person ID with yours. This passes no secret in proxy arguments and stores only a token-file path in configuration. The proxy necessarily receives the bearer token in its environment; processes with equivalent OS permissions can inspect it. Do not enable proxy debug/HTTP tracing or publish Desktop logs containing headers. Desktop policy, local-server support, proxy version, and stateless HTTP behavior must be checked on the actual client before relying on the bridge.

## Cursor: environment interpolation, not remote envFile

[Cursor documents remote headers and `${env:NAME}` interpolation](https://cursor.com/docs/mcp#config-interpolation). Use a personal/global `~/.cursor/mcp.json` entry containing no credential:

```json
{
  "mcpServers": {
    "stadtstack": {
      "url": "https://mcp.stadtstack.eu/mcp",
      "headers": { "Authorization": "Bearer ${env:STADTSTACK_MCP_TOKEN}" }
    }
  }
}
```

Start Cursor from a shell that reads the private file, without echoing it:

```sh
set +x
STADTSTACK_MCP_TOKEN=$(cat "$HOME/.config/stadtstack/mcp-tokens/alice.token") || exit
export STADTSTACK_MCP_TOKEN
cursor .
unset STADTSTACK_MCP_TOKEN
```

Quit an already-running Cursor instance first; a reused process may not inherit the new environment. A GUI launch may also miss shell environment variables. Cursor's `envFile` is documented **only for stdio servers**, not remote HTTP; do not claim the remote header can read a file directly. If environment inheritance cannot be made reliable, use the same local stdio proxy configuration above in Cursor instead. No plaintext token belongs in `mcp.json`, a shell profile, or a committed `.env`. An enterprise allowlist may prohibit custom MCP servers. Client version/transport support still matters.

## Generic Python HTTP example

This standard-library example sends an MCP initialization request, reads the personal file, and outputs only an HTTP status. It is not a complete MCP client: for tool use, complete the initialized notification and `tools/list`/`tools/call` flow using a maintained MCP SDK. Never dump request headers or exception objects into shared logs.

```python
import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPRedirectHandler

class NoRedirect(HTTPRedirectHandler):
    # Never forward the bearer credential to a redirected endpoint.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

token = (Path.home() / '.config/stadtstack/mcp-tokens/alice.token').read_text().strip()
payload = {
    'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
    'params': {
        'protocolVersion': '2025-03-26', 'capabilities': {},
        'clientInfo': {'name': 'owner-example', 'version': '1.0'},
    },
}
request = Request(
    'https://mcp.stadtstack.eu/mcp',
    data=json.dumps(payload).encode(), method='POST',
    headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    },
)
try:
    with build_opener(NoRedirect()).open(request, timeout=30) as response:
        print('HTTP', response.status)
except HTTPError as error:
    print('HTTP', error.code)
except URLError:
    print('Connection failed')
```

## ChatGPT native connectors

Do not advertise this endpoint as compatible with ChatGPT's native OAuth connector flow. This service supplies neither OAuth discovery nor authorization/token endpoints. Native connector onboarding that requires OAuth needs a separate, real OAuth implementation; a bearer token is not a client secret or an OAuth access-token exchange. The generic HTTP example or a separately supported developer MCP client does not establish native ChatGPT compatibility.

## Governed release procedure

Current privileged work requires the **Lease-enabled governance session**: on the owner’s Mac, `governance/session.py run -- …`; on the VM, `sudo stadtstack-session …`. Releases are coordinated through the CivicMCP operator using the reviewed source/data/image seal. The former directory-lock route and direct `deploy/mcp/session.sh` invocation are not current authorization paths. Never use a persistent/admin kubeconfig or restore an old procedure from historical receipts.

The tag-only `.github/workflows/civic-mcp-image.yml` publishes immutable amd64/arm64 images; it does not deploy. A package version or source checkpoint alone is not a release. The approved Git revision/tag, complete data manifest, tagged image digest, OCI identity, chart version and governed acceptance must agree. Source/security review and fresh governed exact-image acceptance precede mutation; public endpoint version/data evidence remains separate from running-image provenance.

The pending signed revocation cohort must be verified at startup and mounted through the governed configuration update, with its public trust pin and exact signed-artifact SHA together. A revision-triggered single-replica Recreate rollout replaces the in-memory mask; no policy RPC, per-request filesystem read or stale-mask rollback is authorized. Key provisioning does not authorize a deployment.

The chart disables backend HAProxy access logging before redirect handling. Its snippets must be allowed by the governed controller; shared frontend pre-routing rejection logs must also be checked for this host before claiming end-to-end no-content logging.

## Rollout evidence

### Current: 0.3.1, case semantics, entity aliases and analyst access

- Deployed source: `47083b92ad18613763536ea79d4db1aaccaa6eea`; literal Git tag, image tag, initialize `serverInfo.version` and release-status version all **`0.3.1`**.
- Image: `ghcr.io/giraeffleaeffle/stadtstack-mcp:0.3.1@sha256:5efca884f0bcc453a9a9df0b8a543526ce42c74da82bb56a26a88fffe1dd7d98`.
- [Successful amd64/arm64 publication](https://github.com/GiraeffleAeffle/ledger-of-life/actions/runs/38143467613); [source PR #6](https://github.com/GiraeffleAeffle/ledger-of-life/pull/6).
- Data manifest: `25d99c9382ccbfeb3fbdef8541409950c8e4adc96852922f151e661d25c90eaf`. The patch retains 228 published knowledge records across nine pilot towns and three graph edges; graph v2 has 169 entity groups. No new extraction or judge calls were made. The 831-candidate identity migration retained original claims/judge evidence; frozen 0.3.0 value/replay reports remain unchanged. See [the patch report](../reports/PATCH_0_3_1.md).
- Parent verification supplied **400 passing Node tests plus TypeScript**, eight negative boundary tests and shell syntax checks. Final release-security and semantic reviews had no remaining findings; these source checks were not redundantly rerun by the release operator.
- Disposable exact-image diagnostics observed both legacy named profiles at 60/4, then explicit `max`/`buzz` profiles at 300/8 after restart, isolated budgets and no hot reload. The final cgroup peak reading was **320,958,464 bytes (about 306 MiB)**, with no OOM and 1 GiB/one CPU unchanged. Because the smoke restarts its container, this reading is not asserted as a peak across prior cgroup lifetimes; it is advisory container accounting, not live-pod heap or deployment authorization.
- The governed dispatcher independently exported and executed the approved SHA's smoke into fresh private evidence before mutation. Producer exit, nonce, script/receipt hashes and approved manifest identity matched. The existing Secret UID and every ID-to-digest binding were preserved while explicit `max`/`buzz` 300/8 activated through compare-and-swap plus controlled restart; other identities remained 60/4.
- Public HTTPS acceptance listed all **20 read-only tools**; the main and bounded supplemental runs together invoked all 20. No live quota saturation was attempted. Sampled spatial `along` returned zero honestly; Ratzeburg retained a genuine one-hop source-asserted graph path.
- Live heat comparisons matched search eligibility: Strausberg and Hoppegarten each returned one eligible record / one case at `draft` and `planning`, with unsupported stage dates null; Rüdersdorf retained one `adopted` case dated `2025-07-22`. These are released source statements, not a new assessment of today's implementation.
- Live Solarpark/Flugplatz comparison returned **18 matching records / one case**. Its linked procedure bundle retains legally distinct instruments; one case is not proof of one completed project. Stadtwerke Strausberg returned one company node with three original typed mentions. Bulk export returned page-only attribution and a valid next cursor.
- Public coverage v3 reports **319 registered municipalities / nine published / 310 unvisited**. Strausberg reports **39 published / 384 quarantined**. Its safe diagnostic categories include deterministic gate 142, faithfulness 8, structured-output 55, missing sourced date 87, no supported case 90 and preparation 3; categories overlap and must not be summed as disjoint cases. No private judge bodies are exposed.
- **Evidence scopes remain separate:** public receipts remain `public_endpoint_version_data` with both image-attestation flags false. Independently governed ReadyPod `imageID` matched the approved digest; the correlation receipt records this equality without rewriting the public scope.
- Non-MCP resource identities/specs were unchanged. Filtered preflight found all three nodes and HAProxy replicas Ready, and only the viewer tunnel before lock acquisition. Temporary governed credentials/tunnel were cleaned, the filtered viewer was restored/status-verified, and the shared lock was released. No further privileged session was needed.
- Under `~/.cache/cluster-ops/`: `mcp-0.3.1-reviewed-source.json`, `mcp-0.3.1-advisory-smoke.json`, `mcp-0.3.1-memory.json`, `mcp-0.3.1-public-smoke.json`, `mcp-0.3.1-public-semantics.json`, `mcp-0.3.1-identity-correlation.json`, and `mcp-release-47083b92ad18-20261011T134018Z/` (runtime producer/receipt, token profiles, workflow identity, render/dry-run, rollout and ReadyPod evidence).
- Token paths and OAuth/client limitations remain unchanged; native client GUI sessions were not exercised. Global acquisition/robots/opt-out work remains in the separate 0.3.2 lane, not this image. Governed rollback/redeployment uses the unchanged clean `civic-mcp-0.3.1` source branch at the approved SHA, not a later documentation commit.

### Historical: 0.3.0, 19 tools and nine pilot towns

- Deployed source: `4cdf3a0231cc1d07dc8a501be44f8463ff69aeb5`; literal Git tag and image tag: **`0.3.0`**. Both initialize `serverInfo.version` and release-status `release.version` returned exactly `0.3.0`.
- Image: `ghcr.io/giraeffleaeffle/stadtstack-mcp:0.3.0@sha256:bfe96e50fa26f8424329bdae1cc8bd306530761e338cefb97cba8fa71cd7f0a6`.
- [Successful amd64/arm64 publication](https://github.com/GiraeffleAeffle/ledger-of-life/actions/runs/38130058619); [source PR](https://github.com/GiraeffleAeffle/ledger-of-life/pull/4).
- Data manifest: `f434203c14c82ea6b6814662e9b1e209d81d7921bee97aeefcd2269d83330415`. This release contains 14,621 records overall, including **228 dated admitted knowledge records across all nine pilot towns**, eight retained city snapshots, 170 entity groups and three admitted `operates` edges. Records are not unique projects, and the pilot is not exhaustive municipal coverage.
- Parent verification supplied 318 passing tests plus TypeScript, four negative acceptance regressions and shell syntax checks. Final static release-security and reassessment reviews had no remaining findings. The frozen evaluation/replay reports remain unchanged.
- Independent exact-image diagnostics passed under non-root/read-only-rootfs, one CPU and 1 GiB. Local cgroup peak was **310,136,832 bytes (about 296 MiB)**, including the short metrics-reader process; no OOM. This measurement is advisory and is neither deployment authorization nor a live-pod heap profile.
- Crucially, the governed dispatcher independently exported and executed the **approved SHA's** smoke implementation into fresh private evidence before mutation. Its process exited 0; the source/script/receipt hashes, nonce and approved data-manifest identity matched. It did not trust the earlier diagnostic JSON.
- Public HTTPS endpoint acceptance passed with all 19 tools listed read-only and version/data identity aligned. The main smoke plus a bounded supplemental run invoked all 19 tools. Spatial `along` truthfully returned zero matches for its sampled line; no positive result was invented.
- The Ratzeburg graph query returned two entity groups, one eligible neighboring relation and a genuine one-hop source-asserted path. The three-district `haushalt` comparison returned **1 / 12 / 19** source-backed records for Strausberg/Mölln/Ludwigslust. These are retrieval results, not independent identity, present-operation, causal or success guarantees.
- **Evidence scopes remain separate:** the public receipt is `public_endpoint_version_data`, with image-provenance/running-image flags false and only an unverified supplied-image hint. Separately obtained governed ReadyPod evidence reported the exact approved digest as `imageID`; the independent correlation receipt records that equality without changing the public receipt's scope.
- Non-MCP resource identities/specs were unchanged. A foreign owner's session was neither contacted nor stopped: rollout waited for it to finish and rechecked before acquiring the lock. All three nodes and HAProxy replicas were Ready in filtered preflight; CRD inspection was forbidden by the filtered viewer and is not claimed. After rollout/acceptance, temporary governed credentials/tunnel were cleaned, the filtered viewer was restored and status-verified, and the shared lock was released.
- Under `~/.cache/cluster-ops/`: `mcp-0.3.0-reviewed-source.json`, `mcp-0.3.0-advisory-smoke.json`, `mcp-0.3.0-memory.json`, `mcp-0.3.0-public-smoke.json`, `mcp-0.3.0-remaining-tools.json`, `mcp-0.3.0-identity-correlation.json`, and `mcp-release-4cdf3a0231cc-20261011T101422Z/` (including generated `runtime-smoke.json`, `smoke-execution.json`, workflow identity, render/dry-run, rollout and ReadyPod evidence).
- The fixed 30-question assessment reports **1 complete, 10 partial and 19 abstaining answers**; all seven graph utility deltas are zero. More data improved coverage, but no incremental graph answer benefit is claimed. See [the frozen pilot report](../reports/PILOT_VALUE_REPORT.md).
- At that release, token paths, protection limits and OAuth/client caveats were unchanged from v0.2.1. Native Claude/Cursor/Desktop GUI sessions were not exercised. Use the exact release's clean source checkout for governed operations; later documentation commits do not change that deployed image.

### Historical: v0.2.1, 16-tool three-district release

- Deployed source: `ca92aa7ccda470d09564889db3edaeaea5e4f578`; tag: `civic-mcp-v0.2.1`.
- Image: `ghcr.io/giraeffleaeffle/stadtstack-mcp@sha256:642ccd06c0e39221bf6314e66020600a3e12c6fab830516aa26e41c34c01688e`.
- [Successful source-bound amd64/arm64 workflow](https://github.com/GiraeffleAeffle/ledger-of-life/actions/runs/38094316300); [source PR](https://github.com/GiraeffleAeffle/ledger-of-life/pull/3).
- Whole-data manifest: `cdd0e350be842c040dc77d13cc73bf2267cd0b9ae9bbf0a471a267b47938b6f4`, published at `2026-10-10T22:51:55.864Z`: 41 bound files / 54,973,252 bytes, 14,402 records and eight retained city snapshots. Core bundle identity remains unchanged.
- The nine-town extraction slice admits **nine gated knowledge records from six towns**, two towns in each district: Märkisch-Oderland 4 records, Herzogtum Lauenburg 2, Ludwigslust-Parchim 3. Rüdersdorf, Ratzeburg and Parchim explicitly have no gated records. This is neither complete nine-town coverage nor complete district coverage; pending, withheld and inaccessible sources remain visible.
- Parent verification: TypeScript and all **173 tests passed** (`artifact://10046`). Static ingress/security and release-correctness findings were closed; the final three-file operator-path delta passed shell/Python syntax and inline static review. MCP SDK is pinned to 1.31.0.
- Exact final amd64 image acceptance passed under non-root/read-only-rootfs, 1 GiB and one CPU. Docker samples reached 240.2 MiB; cgroup peak was **297,390,080 bytes (about 284 MiB)**, including a short metrics-reader process. No OOM; existing resource limits retained. This is container accounting, not a JavaScript heap profile or live-pod memory measurement.
- Authenticated public HTTPS acceptance passed using normal DNS and full TLS verification: 16 read-only tools, date/source contracts, stable release identity, advancing response times, source lookup, projection/cursor binding, comparison/similarity and body/batch protections. Mölln's sampled normalized case returned three cross-city similarity matches; this is discovery, not a success or transferability claim.
- Public `compare_topic` for `haushalt` across Strausberg/MOL, Mölln/RZ and Ludwigslust/LUP returned source-backed counts **1 / 0 / 1**, with all three distinct district identities preserved. No positive shared-topic match across all three districts is claimed.
- Rate-limit and matching JSON/`Retry-After` acceptance used only the local disposable token. Public acceptance deliberately did **not** exhaust the owner's quota.
- The Ready pod's desired image and runtime imageID matched the final digest. Non-MCP resource identities/specs were unchanged. The governed wrapper removed temporary credentials/tunnel, restored and verified the filtered viewer, then released the shared lock.
- Evidence under `~/.cache/cluster-ops/`: `mcp-quality-final-review.json`, `mcp-v0.2.1-image-smoke.json`, `mcp-v0.2.1-memory.json`, `mcp-v0.2.1-public-smoke.json` and `mcp-release-ca92aa7ccda4-20261010T231822Z/`. Token paths and client/OAuth limitations above are unchanged; native client GUIs were not exercised.
- The original dirty `/Users/max/Code/civic-mcp-hosted` checkout was preserved untouched. Release used `/Users/max/Code/civic-mcp-release-20261011` with explicit `MCP_RELEASE_REPO`. Redeployment requires a clean branch whose HEAD and tracked upstream match the approved source; do not pair a later documentation-only HEAD with this image.

### Historical: v0.1.0, initial 12-tool release

- Release tag: `civic-mcp-v0.1.0`; deployed source: `5835267aa798fe134ff587c1f503563586205487`.
- Image: `ghcr.io/giraeffleaeffle/stadtstack-mcp@sha256:9c0774cef10ee1037b15983b026587719b6590507edb85be1f8affa92173c858`.
- To redeploy this exact release, use a clean checkout of the deployed source/tag, not a later documentation-only HEAD with the old image digest: the source-binding gate deliberately rejects that mismatch.
- [Successful amd64/arm64 publication workflow](https://github.com/GiraeffleAeffle/ledger-of-life/actions/runs/38041303228), bound to the source/digest by the governed deploy.
- Namespace/release: `stadtstack-mcp` / `civic-mcp`. The Ready pod's desired image and runtime imageID matched that digest; non-MCP resource identities/specs were unchanged. The filtered viewer was restored and the shared privileged-session lock released.
- Security reviewer: final static **PASS**, no surviving findings, after workflow provenance binding, base-image pinning, controller-selector tightening and disposable smoke-credential fixes.
- Exact amd64 image acceptance passed with non-root/read-only runtime, 401 for missing/wrong bearer, exact-path and Origin rejection, initialization, all 12 read-only tools, three shared auto-verified core facts, sourced/dated council/regional lookups, 32 KiB/batch rejection and 429 per-token quota.
- Authenticated public HTTPS acceptance passed the same protocol/data/protection checks. TLS 1.3 verified `mcp.stadtstack.eu`, issued by Let's Encrypt YR2, valid through 8 January 2027.
- DNS `mcp` A record is `77.42.11.9`, confirmed through resolver `1.1.1.1`. At acceptance time the workstation's default resolver retained an earlier NXDOMAIN for approximately 48 minutes. Public acceptance therefore used that independently observed address while retaining hostname/SNI/certificate validation; TLS verification was never disabled. Other clients with cached NXDOMAIN must allow their negative cache to expire or use a fresh resolver.
- Owner's issued personal file: `~/.config/stadtstack/mcp-tokens/max.token`; hash-only manifest: `~/.config/stadtstack/mcp-tokens/token-hashes.json`. Neither value is printed here.
- Workstation evidence: `~/.cache/cluster-ops/mcp-security-review.json`, `mcp-image-smoke.json`, `mcp-public-smoke.json`, `mcp-tls-evidence.json`, and `mcp-release-5835267aa798-20261010T093041Z/` (workflow identity, render/dry-run, rollout, pod identities and protected before/after boundary).
- The smoke driver was adjusted for transient startup connection resets and desktop-Docker shared temporary paths after the image build; these operator-only changes do not alter the deployed image. Unit tests were added but not run; native Claude/Cursor/Desktop sessions were not exercised.
