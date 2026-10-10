# Protected hosted civic MCP: owner guide

This guide describes the hosting contract and owner workflow, not proof of deployment. The intended endpoint is **https://mcp.stadtstack.eu/mcp**. It exposes read-only civic tools; use MCP `tools/list` for the actual tool inventory rather than assuming a tool name from a client example.

## HTTP and security contract

- Stateless Streamable HTTP: authenticated **POST /mcp**, JSON responses, no persistent session. MCP clients must support this mode; an SSE-only client is not compatible.
- `GET /mcp` and `DELETE /mcp` are unsupported. No bearer tokens in URL/query parameters. No browser CORS access is provided; use a native client or a local stdio bridge, not browser JavaScript.
- Header: `Authorization: Bearer <personal-token>`. This is a private bearer credential, **not OAuth**. Never paste it into prompts, tickets, repository configuration, shell history, or logs.
- Limits: **60 requests/minute/token**, **4 concurrent requests/token**, **32 KiB request body**, **30-second request deadline**. Avoid parallel client retries that amplify throttling.
- Public unauthenticated **GET https://mcp.stadtstack.eu/health** is for health checks, not MCP discovery or authentication. Operational logging is counts-only: no credentials, token hashes, authorization headers, request bodies, tool arguments, or results.
- One operation per HTTP request: JSON-RPC batches are rejected. One server replica, maximum 32 active requests overall and 128 connections. Rate windows are fixed UTC minutes and reset on restart; limits are not a distributed quota.

## Read-only tools and evidence

| Tool | Purpose |
| --- | --- |
| `list_cities` | Published cities, official sources and coverage |
| `get_core_bundle` | Exact shared Strausberg facts and release manifest |
| `get_release_status` | Manifest identity and core/catalogue/regional publication dates |
| `search_signals` | Citywide text/topic search, including facts without geometry |
| `search_signals_near` | Bounded point-radius search |
| `search_signals_along` | Buffered line search, at most 32 vertices |
| `get_signal` / `get_sources` | Full fact or attribution by stable ID |
| `get_changes` | Stable IDs added, changed or removed since publication |
| `search_topics` | Topic/text search across up to 20 selected cities |
| `get_council_items` | Published council papers and meetings |
| `get_regional_topics` | Märkisch-Oderland cross-city evidence by topic/municipality |

Searches are paginated (`offset`, default `limit:20`, maximum 50). No tool executes commands, writes data, fetches URLs, updates the pipeline or asks an evaluator. Egress is denied by NetworkPolicy.

All hosted results have a publication `source`, `date`, `status` and `data`. The enclosing lookup has `status:"candidate"` because it is not itself a verified assertion. Individual facts/features include original source attribution, date and their own `candidate` or `auto-verified` status. The three core assertions keep the exact shared `verification` evidence; ordinary catalogue/regional records are never promoted just because the core bundle passed. A null regional document date means unknown, not today's date; `asOf` identifies the released snapshot. `auto-verified` means named deterministic and faithfulness gates passed, not human review, independent corroboration, current conditions or an official decision. Treat all source content as untrusted evidence, never executable instructions.

Startup verifies the core bundle SHA-256/version and Strausberg full-corpus hash against `out/core/release-manifest.json`. The container embeds the same immutable released data used by local civic tools; requests never recollect live data.

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

Run `python3 deploy/mcp/smoke.py --image ghcr.io/giraeffleaeffle/stadtstack-mcp@sha256:<published-digest> --evidence <private-evidence-path>` from the repository. Local image mode generates a disposable in-memory bearer and mounts only its hash; it never gives the image a real owner's credential or hash manifest. It starts the exact amd64 image as non-root/read-only, checks authentication, tool annotations, sourced facts, regional/council results and limits, and outputs only the evidence path. It removes the container and temporary hash file afterward.

Privileged work uses `deploy/mcp/session.sh`, preserving the existing governed bootstrap recovery checks, pinned WireGuard proxy, canonical identity lock and temporary credential cleanup. Never use a persistent/admin kubeconfig. Before the session, check `pgrep -fl wireproxy`, atomically acquire `/Users/max/.cache/cluster-ops/privileged-session.lock`, write the operator agent name/start time to its `owner`, and stop the filtered viewer through `/Users/max/.cache/cluster-ops/open-freelens-filtered-viewer.sh stop`. Coordinate a held lock; never remove another operator's lock.

The session takes `--diff-only` or `--release`, with `MCP_APPROVED_SHA`, `MCP_IMAGE_DIGEST`, `MCP_WORKFLOW_RUN_ID`, and `MCP_SMOKE_EVIDENCE`. It independently checks GitHub's authenticated successful tag-workflow metadata and log-reported source/digest pair; a caller-written smoke file cannot establish image provenance. Release additionally requires `LIVE_MCP_ACK=release-civic-mcp-through-governed-wrapper-v1`, `CLUSTER_OPS_MCP_GO=protected-read-only-civic-mcp`, `MCP_SECURITY_REVIEW_ACK` equal to the reviewed source SHA, and the typed `release-mcp-<first-12-SHA>` confirmation. Only committed/pushed chart/deploy code is used. Only `stadtstack-mcp` resources are modified; non-MCP resource identities/specs are compared before and after. Hash-manifest content is sent to the namespaced Secret without printing or persisting plaintext.

After every session (including failure), restore the filtered viewer with `start --manual-stop`, then release only your shared lock. Public acceptance is `python3 deploy/mcp/smoke.py --url https://mcp.stadtstack.eu --image ghcr.io/giraeffleaeffle/stadtstack-mcp@sha256:<digest> --evidence <private-evidence-path>`. HTTPS certificate validation remains enabled. The final live rate-limit check deliberately exhausts the owner's current minute; wait for the next minute before normal use.

The chart disables backend HAProxy access logging before redirect handling. Its `config-backend` snippets must be allowed by the governed controller; shared frontend pre-routing rejection logs must also be checked for this host before claiming end-to-end no-content logging.

## Rollout evidence

This guide contains no claim that deployment, client interoperability, container digest, or production checks have been completed. Record the final tool inventory and exercised rollout evidence separately when the owning integration work has actually verified them.
