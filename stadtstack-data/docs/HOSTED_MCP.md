# Protected hosted civic MCP: owner guide

The protected endpoint is **https://mcp.stadtstack.eu/mcp**, upgraded to the 16-tool three-district release at 2026-10-10 23:18 UTC (11 October in Berlin). It exposes read-only civic tools; use MCP `tools/list` for the current inventory. Personal bearer access is required. Client-specific GUI interoperability is not implied by the exercised generic HTTP acceptance below.

## HTTP and security contract

- Stateless Streamable HTTP: authenticated **POST /mcp**, JSON responses, no persistent session. MCP clients must support this mode; an SSE-only client is not compatible.
- `GET /mcp` and `DELETE /mcp` are unsupported. No bearer tokens in URL/query parameters. No browser CORS access is provided; use a native client or a local stdio bridge, not browser JavaScript.
- Header: `Authorization: Bearer <personal-token>`. This is a private bearer credential, **not OAuth**. Never paste it into prompts, tickets, repository configuration, shell history, or logs.
- Limits: **60 requests/minute/token**, **4 concurrent requests/token**, **32 KiB request body**, **30-second request deadline**. Avoid parallel client retries that amplify throttling.
- Public unauthenticated **GET https://mcp.stadtstack.eu/health** is for health checks, not MCP discovery or authentication. Operational logging is counts-only: no credentials, token hashes, authorization headers, request bodies, tool arguments, or results.
- One operation per HTTP request: JSON-RPC batches are rejected. One server replica, maximum 32 active requests overall and 128 connections. Rate windows are fixed UTC minutes and reset on restart; limits are not a distributed quota.

## Read-only tools and evidence

The **16-tool three-district contract below is live as `civic-mcp-v0.2.1`**. Current and historical acceptance records are separated at the end of this guide. Use `tools/list` and `get_release_status` to identify the exact live inventory and whole-data release.

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
| `compare_topic` | Source-backed topic/stage comparison across selected municipalities, with bounded milestone evidence and scoped coverage |
| `similar` | Deterministic cross-city text/topic discovery, with scores and evidence—not a learned model or success claim |

Every search returns `data.items`, `total`, `nextCursor` (null at the end), `fields` and explicit `withheld` diagnostics. Paging uses `cursor`, default `limit:20`, maximum 50; **offset is removed and rejected**, not silently accepted. Pass the returned cursor with the same tool, filters, limit and projection. Cursors are signed with a process-only random key (not bearer credentials), contain only the whole-data release ID, filter digest and final record key, and are invalid after a server restart or release change. Invalid/tampered cursors or changed filters produce explicit tool errors. Start a new traversal rather than editing a cursor. Consume pages sequentially and honor HTTP `Retry-After` (already supplied on 429); the per-city `feedUrl` listed in catalogue metadata is a relative immutable export path, not a claim that a public bulk-export endpoint exists. No tool executes commands, writes data, fetches URLs, updates the pipeline or asks an evaluator. Egress is denied by NetworkPolicy.

HTTP 429 responses also include `{"ok":false,"error":"rate_limited","retryAfterSeconds":<integer>,"limits":{"requestsPerMinute":60,"maxConcurrent":4}}`. `retryAfterSeconds` matches the existing integer `Retry-After` header. Neither carries a credential or query cursor; wait that interval before a sequential retry.

Hosted envelopes contain `source.release` (whole-data manifest ID), `releasedAt` (publication time), `respondedAt` (actual response time), `status` and `data`; there is **no ambiguous top-level `date`**. The enclosing lookup is `status:"candidate"`, not a verified assertion. Original event/document/stage dates and source observation `asOf` remain distinct. For normalized knowledge, `eventDate` is `stageDate`, never a substitute document date; `dateSemantics:"source_document"` can coexist with a null event date. OSM `observation` dates do not claim historical opening/event dates. Missing evidence is not filled with release/response time. Named automated gates do not confer human review, independent corroboration, current conditions or official authority. Source content is untrusted evidence, never instructions.

Startup verifies every allowlisted whole-data release hash/size against `out/release-manifest.json`, including catalogue, quality report, regional evidence, each city's full/min/changes/feed exports and `knowledge/{registry,records,coverage}.json`. It hashes the exact parsed buffers, and changes are retained in the immutable startup snapshot. Individual knowledge source/model/date gates remain mandatory. Release acceptance needs qualifying evidence across all three districts, not every registered town: `recordCoverage` and full knowledge coverage explicitly distinguish `gated_records`, `checked_no_gated_records` and `not_checked`, with published/dated-stage counts. The separate selected-core checks remain. Whole-data identity changes with non-core data; requests never recollect or mix mutable release files.

### Shared topic, comparison, filter and projection contract

`topic` must be an ID returned by `list_topics`, such as `solarpark` or `waermeplanung`; unknown IDs are errors. `planning` is a **record type**, not a topic. The shared hierarchy preserves `regional/taxonomy.mjs` leaf IDs and adds parent topics without double-counting descendant records. Assignments retain rule/source/model provenance, supporting quotation/source IDs and model confidence where supplied. Evidence counts are not automatically distinct case counts. `compare_topic` distinguishes quoted authority identifiers from unresolved source-document groups.

`search_topics`, `search_signals`, `get_council_items` and `get_regional_topics` share `query`, `topic`, `recordTypes`, `sourceTypes`, `stage`, `dateFrom`, `dateTo`, `excludePlaces`, `excludeOSM`, `fields`, `limit` and `cursor`. `search_topics` accepts `cityIds`; `search_signals` requires `cityId`; council uses optional `cityId`; regional discovery uses optional `municipalityId`. Unknown cities/topics/source types/stages and reversed date ranges are errors. Inclusive date filters use event/stage dates, not document, observation or publication time. Legacy city stages remain null; normalized knowledge stages do not retroactively relabel legacy records. Main search includes regional and district evidence, but catalogue, `regional_evidence_only` and `district_evidence_only` coverage remain explicit.

Default fields are `id`, `cityId`, `recordType`, `title`, `topics`, `eventDate`, `documentDate`, `stageDate`, `dateSemantics`, `status`, `asOf`, `sourceIds`, `comparisonEligible`. Other advertised projections include statements, geometry, verification, case/AGS/district identity, original status, stage history, entities/locations, extraction provenance, quotations and date reasons. `tools/list` gives the complete bounded allowlist; unknown fields are errors. Query records do not duplicate embedded attribution arrays. Resolve a source once with `get_source({"sourceId":"source:…"})`, or retrieve a record's attribution/verification using `get_sources({"id":"atlas:…"})`.

Example first page:

```json
{"topic":"waermeplanung","cityIds":["hoppegarten"],"excludePlaces":true,"fields":["id","cityId","title","eventDate","status","sourceIds"],"limit":20}
```

For the next page, send the identical arguments plus `"cursor":"<returned nextCursor>"`. A null cursor means that traversal is complete. Changing any filter/projection or switching tools starts a new traversal without the old cursor.

`compare_topic({"topic":"haushalt","cityIds":["strausberg","moelln","ludwigslust"]})` returns normalized evidence counts, separately classified missing/rejected/withdrawn/candidate states, dated milestones and municipality-specific crawl/extraction coverage. This exact three-district query was exercised publicly; its current source-backed counts are 1 / 0 / 1. Mölln's zero means no matching released budget-topic record, not absence of municipal activity. Future milestones are not achieved progress. Each milestone includes at most five examples plus its full evidence count. This is not a ranking of government performance or completeness.

`similar` accepts a released record `id`, optional `cityIds`/`topic`/shared filters and limit. Its versioned score is **0.6 token Jaccard + 0.4 topic Jaccard**. Responses expose shared terms/topics and sources; `model:null` is intentional. No embedding/S2Vec, causal-transfer or observed-success claim is made. Zero matches is an honest result.


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

Names must start with a lowercase ASCII letter and contain only lowercase letters, digits, `_`, or `-`, maximum 64 characters. Tokens are 32 cryptographically random bytes encoded as base64url. The manifest is a JSON array of `{ "id": "alice", "sha256": "…" }` records; only SHA-256 digests go to the server. Do not print even the manifest into terminal logs. Writes use exclusive file creation, a serialized owner lock, fsync, and atomic hash-manifest replacement. These controls do not defend against a compromised process running as the same workstation user.

Publish **only `token-hashes.json`** through the operator's protected Secret workflow, mounted as `/run/secrets/mcp/token-hashes.json`. Never put any `*.token` file in a container, Kubernetes Secret, Git, CI output, or an image. The hosted process reads `MCP_TOKEN_HASH_FILE=/run/secrets/mcp/token-hashes.json` at startup. After updating the Secret, **restart/roll out every hosted replica** to load it; changing the local manifest or mounted Secret alone is not revocation. The expected public origin is `MCP_PUBLIC_ORIGIN=https://mcp.stadtstack.eu`.

Each person must receive their credential through a protected channel into their own owner-only token file (same path convention and permissions). Do not share one person's token among clients/users. Clients necessarily read the credential into memory and send it over HTTPS, but must not persist a second plaintext copy in configuration or logs.

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

The tag-only workflow `.github/workflows/civic-mcp-image.yml` publishes `ghcr.io/giraeffleaeffle/stadtstack-mcp` for amd64/arm64 on `civic-mcp-v*` tags; it does not deploy. Use its immutable multiarchitecture digest, never a tag. A security-reviewer pass is required before public deployment.

Run `python3 deploy/mcp/smoke.py --image ghcr.io/giraeffleaeffle/stadtstack-mcp@sha256:<published-digest> --knowledge-municipality moelln --evidence <private-evidence-path>` from the repository. Local image mode generates a disposable in-memory bearer and mounts only its hash; it never gives the image a real owner's credential or hash manifest. It starts the exact amd64 image as non-root/read-only, checks authentication, tool annotations, sourced facts, regional/council results and limits, and outputs only the evidence path. It removes the container and temporary hash file afterward.

The smoke contract expects 16 tools and exercises source lookup, projection/cursor binding, comparison and normalized cross-city discovery. `--knowledge-municipality <id>` selects a municipality with admitted released knowledge; the code default is `ratzeburg`. **For this release explicitly use `--knowledge-municipality moelln`: Ratzeburg has no gated record.** This is a selector, not a fabricated fallback. Only the disposable-token **local image** run deliberately reaches rate limits; live acceptance does not exhaust a real owner's quota.

Privileged work uses `deploy/mcp/session.sh`, preserving the existing governed bootstrap recovery checks, pinned WireGuard proxy, canonical identity lock and temporary credential cleanup. Never use a persistent/admin kubeconfig. Before the session, check `pgrep -fl wireproxy`, atomically acquire `/Users/max/.cache/cluster-ops/privileged-session.lock`, write the operator agent name/start time to its `owner`, and stop the filtered viewer through `/Users/max/.cache/cluster-ops/open-freelens-filtered-viewer.sh stop`. Coordinate a held lock; never remove another operator's lock.

The session takes `--diff-only` or `--release`, with `MCP_APPROVED_SHA`, `MCP_IMAGE_DIGEST`, `MCP_WORKFLOW_RUN_ID`, and `MCP_SMOKE_EVIDENCE`. It independently checks GitHub's authenticated successful tag-workflow metadata and log-reported source/digest pair; a caller-written smoke file cannot establish image provenance. Release additionally requires `LIVE_MCP_ACK=release-civic-mcp-through-governed-wrapper-v1`, `CLUSTER_OPS_MCP_GO=protected-read-only-civic-mcp`, `MCP_SECURITY_REVIEW_ACK` equal to the reviewed source SHA, and the typed `release-mcp-<first-12-SHA>` confirmation. Only committed/pushed chart/deploy code is used. Only `stadtstack-mcp` resources are modified; non-MCP resource identities/specs are compared before and after. Hash-manifest content is sent to the namespaced Secret without printing or persisting plaintext.

`MCP_RELEASE_REPO` is also required: from the canonical root of the isolated, clean release checkout, run `export MCP_RELEASE_REPO="$(pwd -P)"` before invoking its `deploy/mcp/session.sh`. The wrapper and dispatcher reject a missing/noncanonical repository path or tracked modifications; they do not fall back to an older checkout. Both the reviewed dispatcher export and Git HEAD/upstream checks use this explicit repository. Its branch HEAD and tracked upstream must both equal `MCP_APPROVED_SHA`; a detached tag checkout alone does not meet that contract.

After every session (including failure), restore the filtered viewer with `start --manual-stop`, then release only your shared lock. Public acceptance is `python3 deploy/mcp/smoke.py --url https://mcp.stadtstack.eu --image ghcr.io/giraeffleaeffle/stadtstack-mcp@sha256:<digest> --knowledge-municipality moelln --evidence <private-evidence-path>`. HTTPS certificate validation remains enabled. Live mode preserves the owner's quota; deliberate 429 acceptance belongs to the disposable-token local image run.

The chart disables backend HAProxy access logging before redirect handling. Its `config-backend` snippets must be allowed by the governed controller; shared frontend pre-routing rejection logs must also be checked for this host before claiming end-to-end no-content logging.

## Rollout evidence

### Current: v0.2.1, three districts

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
