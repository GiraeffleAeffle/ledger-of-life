# Deployment

How to run Ledger of Life somewhere other than the owner's laptop. Test networks only; nothing here moves real money. Where a step was not run, it says so.

## The image

`Dockerfile` builds one image that serves the web app (`node server.js`) and runs the reconcile job (`node scripts/reconcile.mjs`). It holds code and the published city data (`stadtstack-data/out`, 94 MB). It holds **no** keys, database, env files or contract artifacts: `.dockerignore` is deny-by-default, and the image was checked for them.

```bash
docker build -t ledger-of-life \
  --build-arg NEXT_PUBLIC_PRIVY_APP_ID=<public Privy app id> \
  --build-arg NEXT_PUBLIC_PRIVY_CLIENT_ID=<public Privy app client id, optional> \
  --build-arg APP_ORIGIN=https://ledger.stadtstack.eu .
```

- `NEXT_PUBLIC_*` values are compiled into the browser bundle, so they are build arguments (`NEXT_PUBLIC_PRIVY_APP_ID`, and optionally `NEXT_PUBLIC_PRIVY_CLIENT_ID`, `NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL` and `NEXT_PUBLIC_DEMO_SKIP_RECOVERY`). A malformed Privy ID fails the build at prerender, which is the intended failure.
- `APP_ORIGIN` is also a build argument, only because prerendered pages carry absolute link-preview URLs; without it their preview image points at localhost. It stays in the build stage. The running server still reads `APP_ORIGIN` from its own environment.
- The base image and the Dockerfile syntax are pinned by digest (Node 24.21.0, resolved on 30 September), so a moved tag cannot change what builds and runs the image. The Dockerfile says how to update the pin.
- Privy: on 30 September the owner added `https://ledger.stadtstack.eu` to the app's own Allowed Origins (Privy's wallet iframe now allows `http://localhost:4175` and `https://ledger.stadtstack.eu` as frame ancestors), so the hosted build needs no app client and `NEXT_PUBLIC_PRIVY_CLIENT_ID` stays empty. A client, with its own allowed origins and the same users, remains possible later. Privy has no API for app settings.
- `.github/workflows/image.yml` builds the hosted image: `linux/amd64`, pushed to `ghcr.io/giraeffleaeffle/ledger-of-life`, actions pinned to commit SHAs, and the job summary prints the digest to pin. It runs from the Actions tab once the file is on the default branch, or by pushing a tag `image-*` on a commit whose CI passed. It reads its public build values from repository variables (`NEXT_PUBLIC_PRIVY_APP_ID`, `APP_ORIGIN`). **First run on 30 September:** tag `image-20260930-92b952c`, about 6½ minutes on a cold cache, digest `sha256:49ebff60…7559` (pinned in `deploy/values/ledger.stadtstack.eu.yaml`). The package is public: an anonymous pull by digest works. That exact image was run read-only on amd64 with all capabilities dropped: healthy, `/api/status` reports the store on the volume, the front page and `/welcome/strausberg` answer with link previews on `https://ledger.stadtstack.eu`, an unknown city answers 404, no server errors.
- Build for the CPU of the nodes that will run it. The Hetzner nodes are `amd64`, and a `linux/amd64` image (`docker buildx build --platform linux/amd64`) was built in 144 s under emulation and run read-only with all capabilities dropped: healthy in 8 s, pages and the reconcile route answering, no errors. A `linux/arm64` image was also built and run.
- A build with a warm npm cache took about 25 s; the first build also downloads the dependencies. The image is 580 MB. The build uses `npm ci --ignore-scripts`, as CI does. The lockfile used to be missing two optional packages (`@emnapi/core`, `@emnapi/runtime`), which made `npm ci` fail on Linux, and so likely CI's install as well.
- **`npm run build` fails in the working tree on the owner's Mac (found 30 September); CI and the image are not affected.** Turbopack stops with "Symlink stadtstack-data/cache/venv-jev/bin/python … points out of the filesystem root". Two server modules read a manifest by a computed path (`readFile(resolve(process.env.LOCAL_INVESTMENTS_MANIFEST_FILE || …))` in `src/server/local-investments.ts` and `src/server/local-ai-runtime.ts`), so Turbopack scans the whole project, and the city-data pipeline's Python virtualenv (git-ignored, created 27 September) links to the system Python outside it. CI checks out without that cache, and the image's build stage copies only `app` and `src`. A clean copy of the build inputs built successfully on 30 September. Fix, owner's choice: move that virtualenv out of the project tree, or make those reads static enough that Turbopack does not scan the project.

## Running it

Verified with `docker run --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`, as user `node` (uid 1000).

| Setting | Meaning |
|---|---|
| `APP_ORIGIN` | The exact public HTTPS origin. Required in production; same-origin checks and passkeys depend on it. |
| Storage | Either `ALLOW_LOCAL_STORE=1` with a volume at `/data` (SQLite; the operator test tools stay possible), or `DATABASE_URL` (Postgres; the test tools switch off). |
| `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY` | Server-side Privy configuration. |
| `RECONCILE_SECRET` | Bearer secret for `/api/jobs/reconcile`. |
| Chains, AI | The rest of `.env.example`. |
| `STADTSTACK_ATLAS_URL` | Optional. The separate project atlas that `/api/city` and the map centre read. Unset it is `http://localhost:4317`; on a host without an atlas Places says so, and the bundled city snapshots still load. |

- The server writes only to `/data`. `/app/.next/cache` exists so a read-only root filesystem starts cleanly; nothing needs to write there.
- `HOSTNAME` is forced to `0.0.0.0` by the start command. `server.js` binds to whatever `HOSTNAME` holds, and container runtimes normally set it to the container or pod name. It was confirmed that the server then answers from another container on the network; what Kubernetes sets was not observed.
- `GET /api/status` answers with `storeAvailable`. The image's health check fails when it is false. `SIGTERM` stops the server in about 0.25 s.
- With a named Docker volume, `/data` inherits the image's ownership. A Kubernetes volume needs `fsGroup: 1000`; `deploy/chart/templates/deployment.yaml` sets it, and pods already running on the cluster use the same pattern. Not tried for this app.

## The scheduler

Run `node scripts/reconcile.mjs` about once a minute (for example a Kubernetes `CronJob` from the same image) with `APP_ORIGIN` and `RECONCILE_SECRET`. The route checks the secret, not the origin, so `APP_ORIGIN` for the job may be the in-cluster address. It walks three scopes:

- `robinhood` and `solana`: reconcile pending operations against the chain; they answer `unconfigured` until the chain settings exist.
- `local-ai`: removes stored questions and answers after `LOCAL_AI_TEXT_GRACE_SECONDS` (600 by default) and truncates the SQLite write-ahead log. Both are needed: without them the removed text stays in the database file and the log (checked: 20 copies remained; with the fix, none). Postgres keeps dead rows until autovacuum, which this job does not force.

## Secrets and operator material

Supplied when the container runs, never built in.

- Key files (`LOCAL_AI_FACILITATOR_KEY_FILE`, `ROBINHOOD_TEST_KEYS_DIR`, `SOLANA_TEST_SIGNER_DIR`). The fee-signer key must be owner-only (the code rejects any group or other permission bit) and readable by uid 1000. A plain Kubernetes Secret volume may not satisfy both; copying the file in an init container with mode 0600 is the likely answer. Not tried on a cluster.
- `contracts/evm/out` and `contracts/evm/deployments/*.json`, mounted under `/app/contracts/evm/`. Only the Robinhood operator tools that deploy contracts need them. Without them the pages load and those routes fail when used.

## What a production build refuses by default

- **Home Assistant.** A production build never fetches an address a person entered unless `ALLOW_HOME_ASSISTANT_PULL=1`. Local setup sets it. On a shared host, leave it off: the address check cannot be relied on, because DNS is resolved again when the request is made.
- **Operator test tools.** Off unless `SOLANA_TEST_SIGNER_MODE=1` and `ALLOW_OPERATOR_TEST_ACTIONS=1`, and only without `DATABASE_URL`.
- **The free library desk.** Off unless `LOCAL_AI_LIBRARY_ENABLED=1`. Switched on, anyone who can reach the site can use it until its shared 30 answers a day are gone.

## The GPU

The hosted app uses the [outbound host connector](../host-connector/README.md), not a VPN or an inbound home-network connection ([ADR 0013](adr/0013-outbound-host-connector.md)). Ollama has no authentication and must stay private. The always-on Linux device initiates HTTPS to `https://ledger.stadtstack.eu` and signs polls/results/heartbeats with its local Ed25519 key. The owner's default wake sends a tokenless UDP magic packet locally to desktop MAC `34:5A:60:69:E2:73`, broadcast `192.168.178.255`, port 9 (recorded read-only in the homelab package). Optional Home Assistant invokes only `script.desktop_ai_wake_gpu_host`, with a dedicated non-admin local token; HTTPS is required unless `homeAssistant.DANGEROUS_ALLOW_PLAINTEXT_HTTP_ON_TRUSTED_LAN` is explicitly `true` in the connector's JSON configuration.

Hosted release requirements (the connector implementation does not modify `deploy/`):

| Setting/material | Required hosted value |
|---|---|
| `APP_ORIGIN` | `https://ledger.stadtstack.eu`; exact same-origin invitation/revocation boundary. |
| `LOCAL_AI_OLLAMA_URL` | Empty/unset. Setting a direct URL intentionally selects local mode instead of connectors. |
| `LOCAL_AI_HOST_OWNER_WALLETS` | Comma-separated verified EVM addresses of accounts allowed to create host invitations for the contest; empty disables invitations. |
| `LOCAL_AI_MODEL` | Exact advertised model name, owner `qwen3.8:27b-ud-q3-k-xl`. Third-party paid answers cost 10000 atomic tUSDG; own-host compute has no payment. |
| `LOCAL_AI_LIBRARY_ENABLED` | `0` on the public release. The isolated smoke enabled it only for synthetic, zero-cost requests. |
| `LOCAL_AI_TEXT_GRACE_SECONDS` | `600` by default; keep the reconcile job's `local-ai` scope running. |
| `LOCAL_AI_FACILITATOR_KEY_FILE` | Path of a dedicated funded Robinhood-testnet fee key, separate from payer and host payout. Copy the mounted Secret into a private volume using an init container, owner uid/gid 1000 and mode `0600`; mount that volume read-only into the app at this path. A group-readable Secret mount is rejected. Never put this key in the connector or image. |
| App storage/replicas | Existing persistent SQLite volume (`ALLOW_LOCAL_STORE=1`, `LOCAL_DATABASE_PATH=/data/rental.sqlite`), exactly one app replica. Registry is durable; bounded jobs and leases are process-local and fail without charging after restart. |
| Ingress timeout | At least 120 s. Connector polls are at most 25 s; pickup expires at 30 s and answer at 90 s, including wake time. |

No cluster egress change, Tailscale operator, home-LAN ACL, public Ollama port, Home Assistant credential or connector private key is needed on the cluster. Existing Privy configuration remains required. Third-party paid answers need the dedicated facilitator key and testnet gas; own-host compute needs neither. `LOCAL_AI_PAY_TO` applies only to the direct local path; third-party connector quotes use their registered payout wallet.

Local mode keeps `LOCAL_AI_OLLAMA_URL` and its existing direct inference lease; its UI hides connector controls. For hosted onboarding, an eligible signed-in owner creates a private invitation in Money → Devices & income → Pair hosts & income, selects their verified payout wallet, and copies the twelve-character code into private connector configuration. The app shows it once, stores only its hash, expires it in ten minutes and consumes it atomically with registration. Unauthenticated pairing cannot spend shared invitation or host capacity without that capability. Invitation creation uses the existing verified session, not a new per-action passkey challenge. Revoke in the same view, stop the connector, and rotate its key as described in the README. Own-host questions work with one verified EVM wallet, no token balances, no facilitator and no receipt.

Checked again on 30 September after security/code review: isolated dev app (`localhost:4185`), fresh SQLite under `~/.cache`, synthetic Ollama HTTP (`localhost:11487`), loopback-only UDP wake receiver (`:11488`) and the actual connector. An owner invitation was created by the same function as the route (synthetic identity, not a Privy session). Signed heartbeat reported an asleep wake-capable host; the exact 102-byte magic packet woke the stub; chat returned `HTTP 200` with a complete **synthetic** answer. Stalled unsigned bodies were rejected before reading (`403`, 10 ms); well-shaped headers with a stalled body hit the three-second deadline (`400`, 3005 ms). Restart without an invitation answered a new request in 139 ms, proving the abandoned poll did not claim or block it. Visitor clear removed both text fields. Full checks: `npm run lint`, root `npm test` (351 tests, now includes connector CI coverage) and connector package tests (15) passed. Browser component smoke proved invitation UI, own free ready→completed with no signing, direct-mode controls hidden and asleep styling against fixture API/wallet. No real GPU, Home Assistant, LAN broadcast, Privy authentication or paid chain transfer was exercised; all smoke processes were stopped and disposable material removed.

Limits: the host reads every assigned question in clear; city routing requires an explicitly public question. LAN HTTP Ollama also lets anyone able to observe or alter that transport read questions or forge a complete answer. Completion-gated payment cannot prove a model or authenticate that plaintext hop; use authenticated TLS or accept the trusted-LAN boundary. Ed25519 proves paired key possession, not model/timing truth or host erasure. Public status exposes active host availability and caller-relative ownership, not owner DIDs, pending or revoked hosts. Clearing a desk cancels its connector jobs and fences late storage writes, but cannot make a host forget already-received text. Actual owner wake and third-party paid settlement through hosted ingress remain unverified, and the prototype is not independently audited.

## Public pages

`/welcome/<city>` is a public page for newcomers. It sits outside the `(wallet)` route group, so the wallet SDK never loads there ([ADR 0012](adr/0012-public-pages-outside-the-wallet-group.md)). Checked in a production build from a clean cache: 15 requests, all to the app's own origin, and no cookies. It reads the published city feed at request time, so the image needs `stadtstack-data/out`, which it already contains.

## On the owner's cluster

`deploy/` releases the app to the owner's Talos cluster at `ledger.stadtstack.eu` as one Helm release managed by **helmfile**, with the same defaults as the cluster's platform helmfile (atomic, wait, history 10). The chart holds the ConfigMap, a 2 Gi volume for SQLite (kept on uninstall), the Deployment, the reconcile `CronJob`, the Service, the HAProxy Ingress with the cluster's Let's Encrypt issuer and four network policies. The namespace, with Pod Security `restricted`, sits outside Helm so an uninstall never removes it. `deploy/apply.sh` is the bounded wrapper: it refuses a render without a real image digest and any cluster but the reviewed one (by the `kube-system` UID); `--diff-only` changes nothing; a release needs a typed confirmation. [deploy/README.md](../deploy/README.md) lists the order and what the owner supplies.

- **DNS: done on 30 September.** `ledger.stadtstack.eu` A `77.42.11.9` (the cluster's public ingress load balancer), created through the Hetzner Cloud DNS API in the zone `stadtstack.eu`; all three authoritative nameservers answer it. No `AAAA`.
- **Storage: SQLite on the volume, no backup.** Accepted by the owner for the contest window (30 September). The database holds account identifiers, chosen cities and test records; wallets live with Privy and on the test chains, so losing it means setting up again, not losing assets.
- **How it is applied.** In `strausberg-zk-residency`, `infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh` opens the owner's rootless WireGuard session (no sudo, credentials only in a private temporary directory), exports the pushed commit's `deploy/` tree and runs one mode of that `apply.sh`: `--namespace`, `--secret FILE`, `--diff-only` or `--release`. It refuses unpushed commits and a `wireproxy` that fails its pinned checksum, and refuses to start while another tunnel on the daily identity runs. The Freelens viewer does not take its shared lock yet, so it must stay stopped until the wrapper finishes (making the viewer take the lock would close that gap).
- **Live since 30 September.** The owner ran the wrapper from commit `090608b`: namespace, Secret, then Helm revision 1, installed in 45 s. Checked from outside the same morning: every public resolver answers `77.42.11.9`, plain HTTP redirects to HTTPS, the certificate is Let's Encrypt's for `ledger.stadtstack.eu` (valid to 29 December), the pages, the manifest, the icon and both link-preview cards answer, an unknown city answers 404, the pod runs with no restarts and the reconcile job completes every minute. A passkey sign-up on the hosted origin works (the step after it, the backup email, needs a real inbox and was not driven). The only warning was a transient `FailedMount` while the Hetzner volume attached.
- **Known wrong on the live build:** `/api/status` reports `"identity": false` although sign-in is configured (the server rejects a bad token as unverified, not as unconfigured). The route read the public app id from the runtime environment, where the image does not set it; it now reads it the way the sign-in code does. The fix ships with the next image.

## Checked, and not

Checked in a container built from this tree: the pages, the store on a volume, the reconcile route's `local-ai` scope with and without the secret (and an unknown scope), non-root and read-only operation, shutdown on `SIGTERM`, the absence of secrets and contract artifacts, and the whole retention path against a stub model (question asked, text removed after the grace period and on "Finish & clear this desk", usage counts kept, no copy left in the database file or log).

Not checked: the Tailscale path, the backup-email step of hosted sign-up, the real GPU (the desktop was asleep), Postgres, and whether the network policies block what they should (the allowed paths demonstrably work).
