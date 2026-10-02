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

## Tests

```sh
cd home-node
node --test connector.test.mjs home-node.test.mjs
```

Connector regressions cover invitation consumption, exact signed bytes, bounded jobs/results, wake deadlines, redirects, permissions, revocation handling and heartbeats during inference. Home Node regressions cover identity-preserving configuration and permission migration, refusal of permissive/symlink/foreign-owned secret paths, MCP file-path/public-origin refusal, credential origin binding, protocol round trips, sensor-local date/DST boundaries, signed pushes, live configuration reload and secret redaction. Also run `npx --yes -p node@22 node --test connector.test.mjs home-node.test.mjs` for the minimum supported Node version. See [ADR 0015](../docs/adr/0015-home-node.md) for the cutover decision.
