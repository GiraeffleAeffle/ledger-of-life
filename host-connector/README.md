# Outbound GPU host connector

A standalone Node.js **22 or newer**, ESM, zero-dependency connector. It opens no listening service. The public app receives signed outbound requests; Ollama and optional Home Assistant remain reachable only from this device. Tokenless direct Wake-on-LAN uses an ephemeral outbound UDP socket. No npm install, app build, browser, shell execution, tools or model downloads are involved.

## What a paid answer earns

The app pays the host’s payout wallet in test tUSDG through x402 `upto`: 0.0001 tUSDG (100 atomic) per output token, at most 192 tokens (0.0192 tUSDG) per answer, and only when the model finishes a complete answer. Own-host and free public answers earn nothing. This is test money; the connector itself never touches payments.

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

Replace the model tag and absolute state path. Relative file/directory paths resolve relative to the configuration file. Endpoints must be origin-only HTTP(S) URLs: no user/password, path, query or fragment. The **app requires HTTPS**; `http://localhost` is the only development exception. An HTTP app URL using `127.0.0.1` is intentionally rejected. Ollama may use LAN/loopback HTTP, but an untrusted LAN observer can **read submitted questions and forge model answers**; HTTPS or loopback is needed outside a trusted network. Home Assistant requires HTTPS unless the explicit dangerous opt-in below is set. Redirects are rejected for every endpoint, including model discovery, pairing, generation and wake.

```sh
chmod 600 "$HOME/.config/stadtstack-host/config.json"
node /opt/stadtstack/host-connector/connector.mjs \
  --config "$HOME/.config/stadtstack-host/config.json"
```

First run generates an Ed25519 PKCS#8 PEM `private-key.pem` with mode `0600`, derives the base64 DER/SPKI public key, and saves `host-state.json` with mode `0600`. The state directory must be owner-only (`0700` recommended); private files must have no group/other permissions, belong to the running user and not be symlinks. Unsafe existing permissions are rejected, not silently repaired. State binds the key to one app origin. The private key, pairing state and any Home Assistant token remain local. Questions and answers are never saved to this directory or printed in logs.

Before first registration, log in to the app's host desk as an allowed host owner and create an invitation, optionally selecting an eligible verified payout wallet. The app displays the **12-character code once**; copy it into a `"pairingCode"` field in the owner-private configuration, then start the connector within ten minutes. The code is single-use, stored only as a hash by the server, and bound to the creating account and selected payout wallet. Treat it as a short-lived credential: do not put it in command arguments, logs or source control. The connector consumes it with `POST /api/local-ai/hosts/pair` (`{code, publicKey, name}`) and receives `{hostId}`; the host becomes active immediately. It never prints the invitation, creates its own code, or waits for a second approval. On successful registration, remove `"pairingCode"` from the configuration; subsequent starts use the saved host ID and key and do not need a code. If an unused invitation expires, create a new one in the app rather than restarting to request a connector-issued code.

Keep the device clock synchronized: signed calls require timestamps within 60 seconds of server time and fresh random nonces. Pairing uses a bounded per-source attempt limit, not a shared global request budget. Malformed unauthenticated requests cannot consume host or invitation capacity. Host names are at most 80 characters. Running multiple copies against one host key is unsupported.

### Tokenless direct Wake-on-LAN

An always-on connector on the GPU's trusted LAN can send the wake packet itself, without Home Assistant or any token:

```json
"wakeOnLan": {
  "mac": "34:5A:60:69:E2:73",
  "broadcastAddress": "192.168.178.255",
  "port": 9
}
```

Replace these owner-specific example values for another network. The connector validates a colon-separated unicast device MAC, an IPv4 destination literal (no DNS or URL), and an integer UDP port from 1 to 65535; port defaults to 9. Configure the actual subnet broadcast address. The only packet is the standard fixed 102-byte magic packet: six `FF` bytes followed by sixteen repetitions of the configured MAC. A job cannot change its target or payload. This is an unauthenticated LAN wake mechanism, not a remote command channel; keep it inside the intended trusted LAN and do not expose UDP wake ports publicly. Choose either `wakeOnLan` or `homeAssistant`, never both.

### Optional Home Assistant wake

Only configure this if the always-on connector device can reach Home Assistant and has permission to invoke the specific wake script. Add:

```json
"homeAssistant": {
  "url": "https://your-home-assistant.example",
  "tokenFile": "/home/gpu-owner/.config/stadtstack-host/ha-token"
}
```

Save the token directly into that local file without adding it to command arguments, environment variables, configuration JSON or this repository. Set mode `0600`; the connector checks ownership, file type and permissions before reading it. Create a **dedicated non-admin Home Assistant user** and a long-lived token for that user; do not reuse an administrator token. The token is sent **only** to the configured Home Assistant origin and never to the app or Ollama. This connector does not claim Home Assistant restricts the token to one service: a stolen token can exercise that user's other permissions.

HTTPS is required by default, even for loopback. Only if you deliberately trust the entire LAN path may you add `"DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN": true` inside `homeAssistant`. **Plaintext HTTP exposes the bearer token to network observers and permits tampering with the wake call.** This loud opt-in is not an encryption substitute; prefer tokenless direct Wake-on-LAN where possible.

The one allowed call is `POST /api/services/script/desktop_ai_wake_gpu_host` with `{}`. Its existence and meaning were verified read-only against the owner homelab's `home-ops/DESKTOP-AI-OLLAMA.md` and `home-ops/packages/desktop_ai_ollama.yaml`: the script sends the desktop's Wake-on-LAN magic packet. The connector does **not** invoke prepare, warm, gaming, shell-command or arbitrary Home Assistant services. Your installation must supply this script and arrange for Ollama to start after wake. No owner endpoint was contacted during implementation or tests.

With either wake mode configured, heartbeat `canWake` is true, allowing the app to route to a recent asleep host. An unreachable API is reported as asleep, not proof the machine is physically sleeping. On first boot while Ollama is offline, the configured model allowlist is advertised as an **unverified host claim** so a wake job can be assigned. Successful `/api/tags` discovery narrows advertisement to the intersection of installed and configured names. That last subset is persisted and retained while asleep; models outside the configured allowlist are never advertised or used. The actual requested model is checked again after wake. Wake, repeated tag discovery and generation share the job's locally bounded deadline; wake does not extend it or load/download a missing model.

### The owner's NUC and Windows desktop

Use a dedicated unprivileged Linux service user on an always-on device in the home LAN (the planned NUC-side Linux guest). Do not install onto or reconfigure the active validator, Proxmox host, or Home Assistant just to run this connector. For `/home/ledger-host/.config/stadtstack-host/config.json`, the owner's documented endpoints are:

```json
{
  "appOrigin": "https://ledger.stadtstack.eu",
  "ollamaUrl": "http://192.168.178.72:11434",
  "DANGEROUS_ALLOW_PLAINTEXT_OLLAMA_ON_TRUSTED_LAN": true,
  "name": "Owner desktop GPU",
  "models": ["qwen3.8:27b-ud-q3-k-xl"],
  "stateDirectory": "/home/ledger-host/.local/state/stadtstack-host",
  "wakeOnLan": {
    "mac": "34:5A:60:69:E2:73",
    "broadcastAddress": "192.168.178.255",
    "port": 9
  }
}
```

These addresses and wake parameters come from the read-only homelab documentation and `home-ops/packages/desktop_ai_ollama.yaml`; they were not contacted. The desktop is native Windows Ollama, not WSL. This default uses tokenless direct UDP Wake-on-LAN; no HA token is needed. Ollama must already be arranged to start/resume on Windows, and the connector waits for `/api/tags` rather than running any preparation shell. The owner must accept that this LAN HTTP Ollama transport allows question disclosure and forged answers on an untrusted LAN. Use the systemd unit below with this service user's paths. For first registration, create an invitation on the public site's Money host desk, add it locally as `"pairingCode"`, and remove it after registration. No GPU port forwarding, cluster LAN route, Tailscale operator, or cluster-held HA credential is involved.


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

Enable lingering for this service user if it must run without a logged-in session (an administrator can use `loginctl enable-linger gpu-owner`). Run only one connector instance per state directory. Logs omit invitation codes, private keys, tokens, questions and answers. `SIGINT`/`SIGTERM` abort active network requests, including local generation.

## Bounds and failure behavior

- Connector poll requests allow a server wait of at most 25 seconds. Independent heartbeat/discovery runs approximately every 20 seconds, unaffected by long-polls, wake waits, model loading or generation. The server considers a reachable host online only with a heartbeat at most 75 seconds old. Separately, the app saves an in-flight question and returns its running state promptly; browser HTTP requests are not held open through wake/loading/inference, and the app polls the saved request for its result.
- The server owns one lease per host, a 30-second pickup window and a four-minute (240-second) total job lifetime. The connector requires a valid future server expiry and clamps the local deadline to `min(server expiry, local now + 240 seconds)`. Clock skew may put the server expiry beyond four local minutes, but cannot extend local execution. Wake, reachability discovery, model preload, chat and successful result submission share that deadline; an expired job is not turned into a completed answer.
- At most 16 configured model names, each at most 128 characters. Jobs allow 1–8 text-only system/user/assistant messages, at most 4,000 characters each and 12,000 total. Unknown job/message/option fields, images, tools and unadvertised models are rejected before forwarding.
- After Ollama becomes reachable and the requested model is installed, the connector preloads it with `POST /api/generate` containing only `{ "model": "<requested model>", "keep_alive": "5m", "stream": false }`: no prompt or generation options. Loading is bounded by the remaining total deadline. The response must identify the matching model, have `done:true`, an empty `response`, no error, and either omit `done_reason` (older Ollama) or report `"load"` or `"stop"` before any question is sent.
- `/api/chat` is independently bounded to at most 90 seconds and the remaining total deadline. It is constructed locally with `stream:false`, `think:false`, and only `num_ctx` (1–8192), `num_predict` (16–192), and `temperature` (0–1). Jobs cannot supply an endpoint, arbitrary Ollama options, or capabilities.
- Answers require a matching model, `done:true`, `done_reason:"stop"`, and nonempty assistant text of at most 16,000 characters, without an error or tool/image output. Truncated, failed and incomplete replies produce an error result, not an answer. Response bodies are size-bounded. Error logs/results do not echo endpoint bodies, prompts or credentials.
- A Home Assistant token does not make a host trustworthy. A host operator sees submitted question text, and the app cannot prove which model actually ran or whether the operator kept a copy. City-host use must be an explicitly public question. This contest system is test-money-only, not a production paid inference service.

## Revoke and rotate

Revoke a host from its authenticated owner's app host desk. The app disables the paired key immediately; subsequent signed requests are rejected. Stop/disable its service locally too. Every registered connector exits on authorization rejection instead of silently re-pairing a revoked identity; systemd's restart policy will not bypass revocation.

For key rotation, first revoke the old host and stop its connector. Create a new invitation in the app, choose a **new owner-private state directory**, update the configuration/unit writable path, add the invitation as `"pairingCode"`, then start and remove that field after successful registration. Old quotes/jobs remain bound to the old host/key; rotation is a new registration, not a key-swapping alias. Protect or securely dispose of retired local keys/tokens according to your device policy. Changing app origins also requires a fresh state directory and a new invitation. State from the retired connector-issued-code/approval protocol is not supported: revoke that registration and use this rotation procedure. There is no remote command execution, automatic cloud fallback, LAN exposure, or remote credential recovery.

## Scoped verification

```sh
cd host-connector
npm test
```

The permanent Node behavioral tests use disposable files and synthetic loopback HTTP/UDP servers only. They cover URL/shape boundaries, persistent key and token permissions, configured/discovered/asleep model advertisement, redirect credential containment, fixed Ollama requests, preload completion and expiry, incomplete-answer rejection, the exact tokenless 102-byte magic packet, wake service restrictions, explicit plaintext HA opt-in, skew-tolerant four-minute deadlines, the independent 90-second chat ceiling, shutdown cancellation, and the actual CLI invitation/signature flow with independent heartbeats during held-open preload and chat. A sleeping-host regression advances the clock through 70 seconds of reachability delay and 80 seconds of cold loading before completing its first answer. Registered restart requires no invitation and invitations are absent from logs and saved host state. No real Ollama, Home Assistant or owner endpoint is required.
