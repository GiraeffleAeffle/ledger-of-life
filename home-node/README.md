# Ledger Home Node

A local app for joining Ledger of Life with your own Ollama GPU/CPU worker, selected Home Assistant solar readings, public validator identifiers and Wake-on-LAN. One file, no runtime dependencies, **Node 22 or newer**. All hosted communication is outbound, signed HTTPS; the hosted app never pulls from your LAN. The MCP stdio server lets a local LLM client guide setup without opening a port.

This is a test-network prototype. tUSDG and tHOME are fictional units with no monetary value or legal rights. Solar feed-in income is **simulated**, not a utility payment. Validator identifiers are announcements, not validator operation or verified yield. No legal or investment advice.

## Install

Install Node ≥22 from a trusted source first. You do not need npm install.

### Download with a checksum

The app serves the exact reviewed single file and a SHA-256 response header. In Money → Devices & income, use its download link, or:

```sh
mkdir -p "$HOME/.local/share/ledger-home-node"
cd "$HOME/.local/share/ledger-home-node"
curl --fail --silent --show-error --dump-header download.headers \
  https://ledger.stadtstack.eu/api/home-node/download -o home-node.mjs
# Compare this hash with x-content-sha256 in download.headers (case-insensitive header name).
shasum -a 256 home-node.mjs
```

Do not execute the file if the hashes differ. Both file and header come over the same HTTPS connection: this catches corruption, not a compromised server. For independent provenance, compare with a reviewed git checkout. The download endpoint exists after the corresponding app release; a 404 is not a reason to run unverified bytes.

### Git checkout

```sh
git clone https://github.com/GiraeffleAeffle/ledger-of-life.git
cd ledger-of-life
git switch develop
node home-node/home-node.mjs setup
```

`develop` contains this work before release; `main` is the live release. Pin a reviewed revision for a long-running installation.

## Set up and pair

```sh
node home-node.mjs setup
# Or choose a config location explicitly:
node home-node.mjs setup --config "$HOME/.config/ledger-home-node/config.json"
```

Setup detects Ollama at `127.0.0.1:11434`, its installed models and NVIDIA hardware if `nvidia-smi` is available. CPU/other GPUs supported by Ollama do not need NVIDIA tools. Choose installed models, a public host name and the app origin (default `https://ledger.stadtstack.eu`). No models means a readings/validator-only node.

In the hosted app sign in and verify an EVM wallet. Create a private pairing code in **Money → Devices & income** and enter it into setup. Codes expire in ten minutes and are single-use. Any verified account may pair up to two active hosts, within the global fifty-host cap. Allowlisted operator hosts are labelled separately; operators may suspend a community host. Revocation stays in the app.
Before creating the code, choose **My wallet** (one verified EVM wallet) or **The building (tHOME stakers)** for future paid GPU answers. The invitation saves that payee, and the paired host starts with it; operator/community status still comes from the verified identity, not the payout choice. Each device shows its saved destination and when it changed (legacy dates may be unknown). To keep GPU income going to the house, leave **GPU payouts to the building** enabled in Devices & income: the choice is stored on the server until you change it or remove the device, and restarting the node or site does not reset it. Payments already reviewed keep their original payee; building receipts stream over seven days to staked fictional tHOME, not to unstaked holders automatically.

Optional setup asks for a Home Assistant origin, hidden long-lived token, selected sensor ids, public validator ids and either tokenless Wake-on-LAN or the existing HA script `desktop_ai_wake_gpu_host`. HA tokens and the Ed25519 private key are stored only locally, owner-only (0600 files, 0700 directories). Prefer a dedicated non-admin HA user with access only to what the node needs.

**Solar energy must be a daily sensor accumulating kWh since local midnight**, not a lifetime meter. Set the Home Node computer's time zone to match the Home Assistant counter's reset timezone before selecting it (for a service, a reviewed `TZ=Europe/Berlin` environment setting is one example). Each observation includes its ISO UTC timestamp, local calendar date and IANA device timezone; day rollover follows the sensor-local date, including daylight-saving changes. W/kW power and Wh/kWh/MWh energy are normalized locally. Invalid/unavailable energy readings are not pushed; unavailable power becomes null. Readings are pushed every minute. Income is a conservative lower-bound estimate from accepted observations, not a verified meter bill, and requires the explicit **assign solar to building** opt-in in the app; it is off until you choose it. Simulated tariff and daily cap are displayed by the hosted app. Hosts choose their own verified GPU payout wallet or explicitly opt into the building distributor in the app, never by supplying a private key to the node.

For site-paid simulated solar income, declare your installation's peak capacity in **kWp** when assigning it in the app and wait for **manual operator approval**. Assignment can be unassigned, pending, approved, rejected or paused. The daily ceiling is `min(peak kWp × 8, 100)` kWh per sensor-local day; above-ceiling readings flag an anomaly and pause income. Selecting sensors or pairing this node does not approve income, verify a meter or guarantee a payout.

Plain HTTP beyond this device is unsafe: LAN peers can read/alter prompts or steal HA bearer tokens. Use HTTPS; the setup CLI requires an explicit trusted-LAN opt-in for plaintext. Never forward Ollama or HA ports to the Internet.

For an already saved config:

```sh
node home-node.mjs pair ABCDEFGH2345 --config /absolute/path/config.json
node home-node.mjs status --config /absolute/path/config.json
node home-node.mjs doctor --config /absolute/path/config.json
node home-node.mjs run --config /absolute/path/config.json
```

Prefer interactive setup for the pairing code so it does not enter shell history. `doctor` checks local Ollama, NVIDIA detection, HA access and identity file permissions without returning tokens. `status` describes configuration and pairing, not a promise that a separate service process is running. Stop with Ctrl-C/SIGTERM.

### Existing connector installations

Keep your existing configuration, `stateDirectory`, `private-key.pem` and `host-state.json`. **Stop the old worker first**, then run the explicit permission migration:

```sh
node home-node.mjs migrate-permissions --config /the/existing/config.json
node home-node.mjs --config /the/existing/config.json
```

Migration tightens current-user-owned regular config/key/token files to 0600 and their private directories to 0700, without replacing the Ed25519 key or host identity. A legacy HA token is copied into the fixed `stateDirectory/home-assistant-token` file and bound to the configured HA origin; the old token file remains an owner-only backup for you to remove after reviewing the upgrade. Symlinks and foreign-owned paths are refused rather than followed or reassigned: replace them with regular paths owned by the service user. Normal run/status/MCP do not silently accept permissive legacy files or directories, and errors name this migration command. Existing Ollama, HA wake and pairing/poll/result/heartbeat protocols remain compatible; no new invitation is needed. **Do not run the old worker and Home Node simultaneously against one identity.**

The service reloads capabilities, model selection, HA configuration and validator identifiers after config changes (next heartbeat, normally twenty seconds). MCP and the service use the same config and identity files. Changing the app origin or identity directory requires stopping and restarting the service. Polling, model preload and generation never block GPU heartbeats. Jobs remain bounded text-only chat, with no browsing, tools, shell or image execution.

## systemd user service

Copy the reviewed file to `$HOME/.local/share/ledger-home-node/home-node.mjs`. Save this unit as `$HOME/.config/systemd/user/ledger-home-node.service` (replace `/usr/bin/node` if your Node binary differs):

```ini
[Unit]
Description=Ledger Home Node outbound worker and readings
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node %h/.local/share/ledger-home-node/home-node.mjs run --config %h/.config/ledger-home-node/config.json
Restart=on-failure
RestartSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.config/ledger-home-node

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now ledger-home-node.service
journalctl --user -u ledger-home-node.service
```

If you chose a different state/token directory, add it to `ReadWritePaths`. A user service normally stops when you log out; a system administrator can enable lingering for the dedicated service user. It needs local network access to your chosen Ollama/HA devices, optional UDP broadcast for WOL, and outbound HTTPS to the app—not broad inbound access or privileged execution.

## MCP with an LLM client

MCP is **stdio**, newline-delimited JSON-RPC 2.0, not an HTTP server. It runs only when your client launches it. No MCP network port is opened. Run the separate systemd service for ongoing jobs/readings. Use **absolute paths** in client configuration; `~` is not expanded in JSON arguments. Each client must run on the same device (or use its own explicitly configured remote stdio transport); a desktop client cannot read the home node's local files through the hosted site.

The [current MCP revision is 2026-07-28](https://modelcontextprotocol.io/specification/versioning): it uses `server/discover` and per-request protocol/capability metadata, which this node supports. Existing clients can still use `initialize`, `notifications/initialized` and negotiated 2025-11-25/earlier handshake revisions. Current-version replies include `resultType: "complete"`; unsupported versions return the supported-version error.

Tools, in order:

1. `home_node_status` → `detect_devices`.
2. `configure_gpu` → `test_gpu` (or disable GPU for a readings-only node).
3. `pair_home_node` with the private invitation from the app.
4. Prefer interactive setup for HA so its token never enters chat. Alternatively, `connect_home_assistant` accepts a **token value**, never a file path, and writes it to the fixed private state-directory file. Then `list_home_assistant_sensors`; select power and daily energy entity ids and align the node timezone with the counter's local-midnight reset.
5. Optionally `add_validator` with a public identifier only.
6. `push_readings_now` to prove the signed push, then run the service. Respect the server's thirty-second reading limit.

Entering a token into an LLM tool argument exposes it to that client/provider even though the node never echoes or uploads it; use interactive setup when that is unacceptable. MCP never accepts secret file paths. HA/Ollama device URLs in MCP must be loopback, RFC 1918, link-local, `.local` or `.home.arpa`; a public HA origin requires explicit confirmation in interactive setup. MCP cannot change the app origin. Tokens are bound to the configured HA origin, and redirects are refused, so a running service cannot reuse them for a different destination after reconfiguration. There is no arbitrary shell, file-read or general URL-fetch tool; owners should still review local-network configuration requests.

### Claude Desktop

Add to `claude_desktop_config.json` (on macOS, `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ledger-home-node": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/home-node.mjs", "mcp", "--config", "/absolute/path/config.json"]
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude Code

```sh
claude mcp add --transport stdio ledger-home-node -- \
  /absolute/path/to/node /absolute/path/home-node.mjs mcp --config /absolute/path/config.json
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.ledger-home-node]
command = "/absolute/path/to/node"
args = ["/absolute/path/home-node.mjs", "mcp", "--config", "/absolute/path/config.json"]
```

## Privacy and boundaries

What leaves the house: bounded GPU answers and reported token/timing counts for assigned questions; your public host name, installed model names you choose, public validator ids and selected sensor ids; numeric power/daily energy readings, their ISO UTC observation timestamps, local calendar dates and IANA device timezone; the public Ed25519 key and signed heartbeat status. The host receives its assigned questions in cleartext; never send confidential questions to an untrusted community host. Signatures prove possession of a paired key, not model attestation or accurate meter readings.

What does **not** leave through this app: HA token, private Ed25519 key, local HA/Ollama URL, unrelated HA entities/attributes, validator signing keys, wallet private keys. The hosted app cannot pull LAN URLs. Logs and MCP failures use generic messages rather than endpoint bodies, prompts or credentials. Local LLM clients have their own privacy policies; do not paste secrets into chat. Protect backups of the local config/state/token files and review updates before running them.

## Separate local information and AI server (Node 24+)

This is a **different command and process**, not a mode of the online paired worker above.
It serves one account-free city page over local plain HTTP, with dated public information and
direct local Ollama chat. It never reads pairing configuration, private keys, accounts, payments,
Home Assistant credentials or hosted Ledger APIs. Keep the existing online worker running if
desired; its pairing and polling behavior is unchanged. The processes may compete for the same
GPU, so choose a model and machine with sufficient capacity.

From a reviewed repository checkout, with **Node 24 or newer**:

```sh
node home-node/offline-server.mjs
```

Open **http://127.0.0.1:4318/** directly. Default binding is loopback only; default model is
`qwen3:4b` at `http://127.0.0.1:11434`. This does not install Ollama or a model. Install them
from trusted sources and download your chosen model while online first. The information page
works even when Ollama is stopped. Chat reports model failure rather than fabricating an answer.
The readiness console prints only the nonsecret bound page URLs; it is not a model-health claim.
Stop this separate process with Ctrl-C.

Keep `offline-server.mjs`, `offline-public.mjs`, `offline.css` and `offline-client.js` together.
There are no npm packages, external fonts, map tiles, hosted API calls, service workers or
browser caches in this server. No internet is needed once Node, these files, Ollama and the
model are installed, provided the browser can reach this computer and it can reach the model.
An operator-configured local hostname also needs functioning local DNS. Opening source websites still
need internet; telephone numbers still need working phone service.

### Choose the model and trusted local network

```sh
node home-node/offline-server.mjs \
  --bind 127.0.0.1 --port 4318 --city strausberg \
  --ollama-url http://127.0.0.1:11434 --model qwen3:4b
```

`--city` only accepts an actually supplied pack: currently `strausberg`. Unknown cities fail
closed; no nearby-town facts are generated or borrowed. The public-only snapshot is selected
from `src/data/arrival/strausberg-contacts.ts` and `strausberg-steps.ts`. It contains medical
emergency guidance, public contacts, key places and first-weeks welcome steps, with the
**original 2026-09-29 source checks**, not a claim of review on the 2026-10-09 packaging date.
It excludes personal data, live feeds, events, current opening hours and unsourced nearby data.
Update the selected pack and version deliberately after editorial review; there is no updater.

On a Mac, find the current LAN IP and the existing local hostname:

```sh
networksetup -listallhardwareports
# Match the active Wi-Fi/Ethernet device above; en0 is only an example:
ipconfig getifaddr en0
scutil --get LocalHostName
```

For example, **only if those commands really report** `192.168.50.10` and `My-Mac`:

```sh
node home-node/offline-server.mjs \
  --bind 192.168.50.10 --port 4318 --trusted-lan --hostname my-mac.local \
  --ollama-url http://127.0.0.1:11434 --model qwen3:4b
```

On a phone on the same trusted Wi-Fi, open **http://192.168.50.10:4318/** or, if the Mac's
system mDNS advertisement resolves there, **http://my-mac.local:4318/**. Substitute your
actual IP/name; these are examples, not discovered hosts. `--hostname` only admits that
already advertised `.local` name in the Host guard. The server does **not** publish Bonjour
records or manufacture a hostname. Use the IP if mDNS is unavailable. A phone's `localhost`
is the phone, not the Mac. Open the HTTP URL as a top-level page, never embedded in hosted
Ledger or fetched from its HTTPS page.

Prefer binding the specific private LAN IP. `--bind 0.0.0.0 --trusted-lan` (or `::`) is an
explicit all-interface option, **not a security boundary or a claim of safe public binding**.
Only private/loopback interface addresses present at startup are admitted as Host values;
restart after a network change. Configure the macOS/router firewall to allow only the intended
trusted LAN; do not expose the port through forwarding, tunnels or public reverse proxies.
Client isolation on guest Wi-Fi may intentionally prevent access. Do not disable browser
security or the firewall broadly to make it work.

**Plain HTTP is visible and alterable on the network.** Anyone admitted to that LAN can use
the unauthenticated local service and consume its shared question budget. The gateway operator,
model operator and network peers may see prompts and answers. This server writes no chat,
account or IP logs and sets no cookies; the browser keeps only bounded tab-memory history.
Reload/Clear removes that history, not logs a separate Ollama operator may keep. Do not enter
private information. Host/Origin/DNS guards and a firewall are not encryption or user identity.

### Desktop example and optional Wake-on-LAN

The following is an **example only**, not a discovered or authorized device. Replace the
hostname, MAC and broadcast with your own explicitly authorized local settings:

```sh
node home-node/offline-server.mjs \
  --bind 127.0.0.1 --port 4318 --city strausberg --trusted-lan \
  --ollama-url http://example-desktop.home.arpa:11434 \
  --model qwen3.8:27b-ud-q3-k-xl \
  --context-tokens 32768 --model-timeout-ms 120000 \
  --wake-mac 02:00:00:00:00:01 --wake-broadcast 192.168.50.255 \
  --wake-budget-ms 90000
```

This is **not evidence of a completed live model/wake test**.
For phone access replace `--bind` with the Mac's actual private LAN IP and optionally add its
real `--hostname ...local`. The node does not change your desktop or router configuration.
Use a subnet-appropriate directed broadcast: `.255` is only appropriate when the actual
network uses that broadcast address. Wake capability must already be enabled on the desktop.

Ollama origins are restricted to literal loopback/RFC1918/private-IPv6 addresses, `localhost`,
or an operator-configured `.local`, `.home.arpa` or `.fritz.box` hostname. Before each
model/readiness attempt, every resolved address must be private LAN, then the HTTP connection
uses a pinned numeric address. Public/mixed DNS results, other DNS suffixes, credentials,
URL paths/queries and redirects are refused. Information reads do not require local DNS.
Local DNS failure is an explicit error, never a public-provider fallback. A changed private IP requires
operator trust in the local DNS/device, not an assertion of authenticated model identity.

Wake is optional and requires both `--wake-mac` and `--wake-broadcast` plus `--trusted-lan`.
Only a valid, same-origin **explicit chat question** checks `/api/tags`; if unreachable, it
sends one bounded UDP magic packet and polls the fixed Ollama origin for at most the wake
budget. The page shows “Waking the local AI…” while waiting. No model is downloaded, no
shell is run, and page loads/status reads never wake the desktop. A reachable Ollama without
the configured installed model fails explicitly. Generation starts only after readiness, with
its own timeout; a failed wake leaves public information working.

### Bounds and offline acceptance

One chat request at a time; a shared 12-attempt/minute budget (no IP identity tracking);
32 HTTP connections; 12 KiB request bodies; 5-second body deadline; 2,000 UTF-8-byte questions;
at most three complete history pairs totaling 6,000 bytes. Output is capped at 384 requested
tokens, 8,000 answer bytes and 64 KiB upstream response bytes. Context defaults to 4,096
tokens and accepts an operator-set maximum of 32,768 via `--context-tokens`; model timeout
defaults to 90 seconds with a 120-second maximum. Wake budget defaults/maxes at 90 seconds.
Cancellation closes upstream work. The model may be wrong even within these limits.

Chat requires exact same-origin JSON POST and matching local Host/Origin; cross-origin
requests, form posts, arbitrary model/URL/options fields, system/tool history and oversized
payloads are refused. No CORS is enabled. Model/user text is rendered as text, not HTML or
clickable model-generated links. The page identifies the configured model, source dates and
local gateway, with an AI-generated/can-be-wrong label on every answer.

For an acceptance check, disconnect WAN (and phone cellular fallback) **without losing LAN**,
reload the direct node URL at 390 px, open the dated public sections and ask a new local-model
question. Browser-only WAN blocking must still permit the node origin, while the Node process
needs its authorized private DNS/Ollama/UDP route. Separately stop the model and verify the
honest unavailable/timeout state. Model fixture tests do not establish this live proof.

Bluetooth PAN and Reticulum/LXMF transport remain later work, not implemented browser radio
access. Nothing here makes online Ledger sign-in, tenancy, wallets or payments work offline.

Node 24 fixture suite (real loopback HTTP servers; explicit example model/DNS responses and
stubbed wake UDP, not live AI or hardware evidence):

```sh
node --test home-node/offline-server.test.mjs
```

## Tests

```sh
cd home-node
node --test connector.test.mjs home-node.test.mjs
```

Connector regressions cover invitation consumption, exact signed bytes, bounded jobs/results, wake deadlines, redirects, permissions, revocation handling and heartbeats during inference. Home Node regressions cover identity-preserving configuration and permission migration, refusal of permissive/symlink/foreign-owned secret paths, MCP file-path/public-origin refusal, credential origin binding, protocol round trips, sensor-local date/DST boundaries, signed pushes, live configuration reload and secret redaction. Also run `npx --yes -p node@22 node --test connector.test.mjs home-node.test.mjs` for the minimum supported Node version. See [ADR 0015](../docs/adr/0015-home-node.md) for the cutover decision.
