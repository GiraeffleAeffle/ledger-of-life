# Outbound GPU host connector

A standalone Node.js **22 or newer**, ESM, zero-dependency connector. It opens no listening socket. The public app receives signed outbound requests; Ollama and optional Home Assistant remain reachable only from this device. No npm install, app build, browser, shell execution, tools or model downloads are involved.

## Owner setup on Linux

Run as a dedicated unprivileged user on the GPU device, or on an always-on device that can reach the GPU's configured Ollama endpoint. Install/copy this directory somewhere that user can read, such as `/opt/stadtstack/host-connector`. Node must be on the device already.

Create an owner-private configuration directory and save `config.json` there:

```sh
install -d -m 700 "$HOME/.config/stadtstack-host"
install -d -m 700 "$HOME/.local/state/stadtstack-host"
```

```json
{
  "appOrigin": "https://your-app.example",
  "ollamaUrl": "http://127.0.0.1:11434",
  "name": "My GPU",
  "models": ["your-installed-model:tag"],
  "stateDirectory": "/home/gpu-owner/.local/state/stadtstack-host"
}
```

Replace the model tag and absolute state path. Relative file/directory paths resolve relative to the configuration file. Endpoints must be origin-only HTTP(S) URLs: no user/password, path, query or fragment. The **app requires HTTPS**; `http://localhost` is the only development exception. An HTTP app URL using `127.0.0.1` is intentionally rejected. Ollama and Home Assistant can use configured LAN/loopback HTTP origins; prefer HTTPS wherever the network is not trusted. Redirects are rejected for every endpoint, including model discovery, pairing, generation and wake.

```sh
chmod 600 "$HOME/.config/stadtstack-host/config.json"
node /opt/stadtstack/host-connector/connector.mjs \
  --config "$HOME/.config/stadtstack-host/config.json"
```

First run generates an Ed25519 PKCS#8 PEM `private-key.pem` with mode `0600`, derives the base64 DER/SPKI public key, and saves `host-state.json` with mode `0600`. The state directory must be owner-only (`0700` recommended); private files must have no group/other permissions, belong to the running user and not be symlinks. Unsafe existing permissions are rejected, not silently repaired. State binds the key to one app origin. The private key, pairing state and any Home Assistant token remain local. Questions and answers are never saved to this directory or printed in logs.

The connector prints an eight-character pairing code, not its key/token. Log in to the app's host desk as an allowed host owner and approve that code with an eligible verified payout wallet. Wallet ownership and the app's owner allowlist are server-side requirements; possessing a code alone cannot approve a host. Polling returns `403` until approval. The code is single-use and expires after ten minutes; if it expires, restart the connector to request another code. Keep the device clock synchronized: signed calls require timestamps within 60 seconds of server time and fresh random nonces. Pairing endpoints are rate-limited; do not continually restart to request codes.

Server pairing limits are five attempts per source address and 30 globally per ten-minute window, with at most 128 pending/active hosts. Expired pending registrations are purged; revocation history retains the latest 32 records. Host names are at most 80 characters. The server stores at most 256 live nonces per host, expiring each at its signed timestamp plus 60 seconds; running multiple copies against one host key is unsupported.

### Optional Home Assistant wake

Only configure this if the always-on connector device can reach Home Assistant and has permission to invoke the specific wake script. Add:

```json
"homeAssistant": {
  "url": "https://your-home-assistant.example",
  "tokenFile": "/home/gpu-owner/.config/stadtstack-host/ha-token"
}
```

Save the token directly into that local file without adding it to command arguments, environment variables, configuration JSON or this repository. Set mode `0600`; the connector checks ownership, file type and permissions before reading it. The token is sent **only** to the configured Home Assistant origin and never to the app or Ollama. HTTP Home Assistant exposes the token on that LAN, so use HTTPS unless that transport is trusted. Use the least-privileged Home Assistant account your installation supports; this connector does not claim its token is restricted by Home Assistant to one service.

The one allowed call is `POST /api/services/script/desktop_ai_wake_gpu_host` with `{}`. Its existence and meaning were verified read-only against the owner homelab's `home-ops/DESKTOP-AI-OLLAMA.md` and `home-ops/packages/desktop_ai_ollama.yaml`: the script sends the desktop's Wake-on-LAN magic packet. The connector does **not** invoke prepare, warm, gaming, shell-command or arbitrary Home Assistant services and does not embed that owner's IP/MAC. Your installation must supply this script and arrange for Ollama to start after wake. No owner endpoint was contacted during implementation or tests.

With Home Assistant configured, heartbeat `canWake` is true, allowing the app to route to a recent asleep host. An unreachable API is reported as asleep, not proof the machine is physically sleeping. On first boot while Ollama is offline, the configured model allowlist is advertised as an **unverified host claim** so a wake job can be assigned. Successful `/api/tags` discovery narrows advertisement to the intersection of installed and configured names. That last subset is persisted and retained while asleep; models outside the configured allowlist are never advertised or used. The actual requested model is checked again after wake. Wake, repeated tag discovery and generation share the job's deadline; wake does not extend it or load/download a missing model.

### The owner's NUC and Windows desktop

Use a dedicated unprivileged Linux service user on an always-on device in the home LAN (the planned NUC-side Linux guest). Do not install onto or reconfigure the active validator, Proxmox host, or Home Assistant just to run this connector. For `/home/ledger-host/.config/stadtstack-host/config.json`, the owner's documented endpoints are:

```json
{
  "appOrigin": "https://ledger.stadtstack.eu",
  "ollamaUrl": "http://192.168.178.72:11434",
  "name": "Owner desktop GPU",
  "models": ["qwen3.8:27b-ud-q3-k-xl"],
  "stateDirectory": "/home/ledger-host/.local/state/stadtstack-host",
  "homeAssistant": {
    "url": "http://192.168.178.135:8123",
    "tokenFile": "/home/ledger-host/.config/stadtstack-host/ha-token"
  }
}
```

These addresses come from the read-only homelab `home-ops/DESKTOP-AI-OLLAMA.md`, `REMOTE-ACCESS.md` and `README.md`; they were not contacted. The desktop is native Windows Ollama, not WSL. The `:11435` endpoint mentioned in the homelab is an Ollama-facing desktop endpoint, **not** the Home Assistant REST server. The optional wake script only sends Wake-on-LAN; Ollama must already be arranged to start/resume on Windows, and the connector waits for `/api/tags` rather than running any preparation shell. The owner must supply the HA token locally and accept that these LAN HTTP transports are unencrypted. Use the systemd unit below with this service user's paths, then approve the printed code on the public site's Money host desk. No GPU port forwarding, cluster LAN route, Tailscale operator, or cluster-held HA credential is involved.


### User systemd service

Install a user unit at `~/.config/systemd/user/stadtstack-host.service` (adjust paths and Node location):

```ini
[Unit]
Description=Stadtstack outbound AI host connector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/stadtstack/host-connector/connector.mjs --config %h/.config/stadtstack-host/config.json
Restart=on-failure
RestartSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=%h/.local/state/stadtstack-host

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now stadtstack-host.service
journalctl --user -u stadtstack-host.service -f
```

Enable lingering for this service user if it must run without a logged-in session (an administrator can use `loginctl enable-linger gpu-owner`). Run only one connector instance per state directory. Keep service logs private: the initial short pairing code appears there. `SIGINT`/`SIGTERM` abort active network requests, including local generation.

## Bounds and failure behavior

- Poll requests allow a server wait of at most 25 seconds. Independent heartbeat/discovery runs approximately every 20 seconds, unaffected by long-polls, wake waits or generation. The server considers a reachable host online only with a heartbeat at most 75 seconds old.
- The server owns one lease per host, a 30-second pickup window and a 90-second total job lifetime. All local wake/discovery/generation requests are bounded by the supplied expiry; an expired job is not turned into a completed answer.
- At most 16 configured model names, each at most 128 characters. Jobs allow 1–8 text-only system/user/assistant messages, at most 4,000 characters each and 12,000 total. Unknown job/message/option fields, images, tools and unadvertised models are rejected before forwarding.
- `/api/chat` is constructed locally with `stream:false`, `think:false`, and only `num_ctx` (1–8192), `num_predict` (16–192), and `temperature` (0–1). Jobs cannot supply an endpoint, arbitrary Ollama options, or capabilities.
- Answers require a matching model, `done:true`, `done_reason:"stop"`, and nonempty assistant text of at most 16,000 characters, without an error or tool/image output. Truncated, failed and incomplete replies produce an error result, not an answer. Response bodies are size-bounded. Error logs/results do not echo endpoint bodies, prompts or credentials.
- A Home Assistant token does not make a host trustworthy. A host operator sees submitted question text, and the app cannot prove which model actually ran or whether the operator kept a copy. City-host use must be an explicitly public question. This contest system is test-money-only, not a production paid inference service.

## Revoke and rotate

Revoke a host from its authenticated owner's app host desk. The app disables the paired key immediately; subsequent signed requests are rejected. Stop/disable its service locally too. A connector that has observed approval exits on authorization rejection instead of silently re-pairing a revoked identity; systemd's restart policy will not bypass revocation.

For key rotation, first revoke the old host, stop its connector, choose a **new owner-private state directory**, update the configuration/unit writable path, then restart and approve the newly generated code. Old quotes/jobs remain bound to the old host/key; rotation is a new registration, not a key-swapping alias. Protect or securely dispose of retired local keys/tokens according to your device policy. Changing app origins also requires a fresh state directory and new approval. There is no remote command execution, automatic cloud fallback, LAN exposure, or remote credential recovery.

## Scoped verification

```sh
cd host-connector
npm test
```

The permanent Node behavioral tests use disposable files and synthetic `localhost` HTTP servers only. They cover URL/shape boundaries, persistent key and token permissions, configured/discovered/asleep model advertisement, redirect credential containment, fixed Ollama requests, incomplete-answer rejection, wake service restrictions, deadline/shutdown cancellation, and the actual CLI pairing/signature flow with an independent heartbeat during a held-open inference. No real Ollama or Home Assistant endpoint is required.
