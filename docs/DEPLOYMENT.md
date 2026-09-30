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
- `.github/workflows/image.yml` builds the hosted image: `linux/amd64`, pushed to `ghcr.io/giraeffleaeffle/ledger-of-life`, actions pinned to commit SHAs, and the job summary prints the digest to pin. It runs from the Actions tab once the file is on the default branch, or by pushing a tag `image-*` on a commit whose CI passed. It reads its public build values from repository variables (`NEXT_PUBLIC_PRIVY_APP_ID`, `APP_ORIGIN`). **First run on 30 September:** tag `image-20260930-92b952c`, about 6½ minutes on a cold cache, digest `sha256:49ebff60…7559`. The package is public: an anonymous pull by digest works. That exact image was run read-only on amd64 with all capabilities dropped: healthy, `/api/status` reports the store on the volume, the front page and `/welcome/strausberg` answer with link previews on `https://ledger.stadtstack.eu`, an unknown city answers 404, no server errors. **Second image, same day:** tag `image-20260930-6010e5c`, digest `sha256:6cbf8c0b…6193` (pinned in `deploy/values/ledger.stadtstack.eu.yaml`), CI green on that commit. Run the same way: `/api/status` reports `identity: true` with the app id compiled in, the Local-stakes manifest is at its path and the AI desk's payee resolves from it, every page carries the anti-framing headers, uid 1000, no errors.
- Build for the CPU of the nodes that will run it. The Hetzner nodes are `amd64`, and a `linux/amd64` image (`docker buildx build --platform linux/amd64`) was built in 144 s under emulation and run read-only with all capabilities dropped: healthy in 8 s, pages and the reconcile route answering, no errors. A `linux/arm64` image was also built and run.
- A build with a warm npm cache took about 25 s; the first build also downloads the dependencies. The image is 580 MB. The build uses `npm ci --ignore-scripts`, as CI does. The lockfile used to be missing two optional packages (`@emnapi/core`, `@emnapi/runtime`), which made `npm ci` fail on Linux, and so likely CI's install as well.
- **`npm run build` in the working tree works again (fixed 30 September).** Turbopack had stopped with "Symlink stadtstack-data/cache/venv-jev/bin/python … points out of the filesystem root": server modules that read files by a path chosen at run time made it scan the whole project, including the city-data pipeline's git-ignored Python virtualenv, which links outside it. Those path expressions now carry `/* turbopackIgnore: true */` (comments only, in 11 `src/server` modules; runtime behaviour and the env overrides are unchanged). Checked: a reproduction failed before and built after, a standalone build still starts and serves `/api/status`, and the real `npm run build` in the working tree passes. CI and the image were never affected.

## Running it

Verified with `docker run --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`, as user `node` (uid 1000).

| Setting | Meaning |
|---|---|
| `APP_ORIGIN` | The exact public HTTPS origin. Required in production; same-origin checks and passkeys depend on it. |
| Storage | Either `ALLOW_LOCAL_STORE=1` with a volume at `/data` (SQLite; the operator test tools stay possible), or `DATABASE_URL` (Postgres; the test tools switch off). |
| `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY` | Server-side Privy configuration. |
| `RECONCILE_SECRET` | Bearer secret for `/api/jobs/reconcile`. |
| Chains, AI | The rest of `.env.example`. |
| Solana on the hosted demo | `SOLANA_RPC_URL` (a keyed devnet URL is secret, because the key sits in the URL) and `SOLANA_SPONSOR_KEYPAIR` (a key used only by this host; it pays network fees and rent and can never act as a party) go in the Secret; `SOLANA_DEPLOYMENT_MANIFEST` (the public pull-v2 devnet deployment, one line of JSON) is a chart value. The sponsor needs devnet SOL: top it up at https://faucet.solana.com. |
| `STADTSTACK_ATLAS_URL` | Optional. The separate project atlas that `/api/city` and the map centre read. Unset it is `http://localhost:4317`. Empty means this deployment has no atlas: the hosted demo sets it so, because the atlas is a local research prototype; the city, the bundled snapshots and the map still work, and nothing claims an outage. |

- The server writes only to `/data`. `/app/.next/cache` exists so a read-only root filesystem starts cleanly; nothing needs to write there.
- `HOSTNAME` is forced to `0.0.0.0` by the start command. `server.js` binds to whatever `HOSTNAME` holds, and container runtimes normally set it to the container or pod name. It was confirmed that the server then answers from another container on the network; what Kubernetes sets was not observed.
- `GET /api/status` answers with `storeAvailable`. The image's health check fails when it is false. `SIGTERM` stops the server in about 0.25 s.
- Every response forbids framing by other sites (`Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`) and sends `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` (`next.config.ts`). Privy's wallet frame is Privy's own page inside the app, so it is not affected.
- With a named Docker volume, `/data` inherits the image's ownership. A Kubernetes volume needs `fsGroup: 1000`; `deploy/chart/templates/deployment.yaml` sets it, and the first release on the cluster proved it (the store opens and writes on the volume).

## The scheduler

Run `node scripts/reconcile.mjs` about once a minute (for example a Kubernetes `CronJob` from the same image) with `APP_ORIGIN` and `RECONCILE_SECRET`. The route checks the secret, not the origin, so `APP_ORIGIN` for the job may be the in-cluster address. It walks three scopes:

- `robinhood` and `solana`: reconcile pending operations against the chain; they answer `unconfigured` until the chain settings exist.
- `local-ai`: removes stored questions and answers after `LOCAL_AI_TEXT_GRACE_SECONDS` (600 by default) and truncates the SQLite write-ahead log. Both are needed: without them the removed text stays in the database file and the log (checked: 20 copies remained; with the fix, none). Postgres keeps dead rows until autovacuum, which this job does not force.

## Secrets and operator material

Supplied when the container runs, never built in, with one exception: the image contains the public Local-stakes manifest `contracts/evm/deployments/local-investments-46630.json` (addresses and code hashes on Robinhood Chain testnet), because Local stakes and the AI desk's payee read it at that path. Rebuild the image when that deployment changes.

- Key files (`LOCAL_AI_FACILITATOR_KEY_FILE`, `ROBINHOOD_TEST_KEYS_DIR`, `SOLANA_TEST_SIGNER_DIR`). The fee-signer key must be owner-only (the code rejects any group or other permission bit) and readable by uid 1000. A plain Kubernetes Secret volume may not satisfy both; copying the file in an init container with mode 0600 is the likely answer. Not tried on a cluster.
- `contracts/evm/out` and the other deployment manifests, mounted under `/app/contracts/evm/`. Only the operator test tools need them; the hosted demo keeps those off.

## What a production build refuses by default

- **Home Assistant.** A production build never fetches an address a person entered unless `ALLOW_HOME_ASSISTANT_PULL=1`. Local setup sets it. On a shared host, leave it off: the address check cannot be relied on, because DNS is resolved again when the request is made.
- **Operator test tools.** Off unless `SOLANA_TEST_SIGNER_MODE=1` and `ALLOW_OPERATOR_TEST_ACTIONS=1`, and only without `DATABASE_URL`. They let server-held keys act for someone else: a private market per wallet with a fake test stock, the landlord and arbitrator in Home, price and yield levers. **The owner decided on 30 September that the public site runs real flows only**, so they stay off there and remain for rehearsals on localhost. Visitors get test money themselves instead: their own wallet mints test dollars (tUSDG, no value), and Robinhood's and Circle's public faucets give test ETH, the official test TSLA and devnet USDC.
- **The free library desk.** Off unless `LOCAL_AI_LIBRARY_ENABLED=1`. Switched on, anyone who can reach the site can use it until its shared 30 answers a day are gone.

## The GPU

Ollama has no authentication, so it is never published. The app is the only public door and the payment gate; it runs the inference over a private link. `LOCAL_AI_OLLAMA_URL` is an ordinary `http://` address, so no code change is needed for a tunnel. The app supports **exactly one** GPU host this way: one URL, one model, one price and payee, and one lease that serialises inference.

That direct route suits the owner's own GPU, a Windows desktop. It sleeps and is woken by Wake-on-LAN through Home Assistant, so it should **not** join the tailnet (it would drop off whenever it sleeps). `pve-strausberg`, an always-on node, already advertises the home LAN as a subnet route, and the tailnet approves it (checked on 29 September). What remains is on the cluster and needs the owner's approval:

1. On the cluster, run the [Tailscale Kubernetes operator](https://tailscale.com/docs/kubernetes-operator) with an egress `ProxyGroup`, and create an `ExternalName` Service annotated with `tailscale.com/tailnet-ip` set to the desktop's LAN address (see [Access a tailnet device from your cluster](https://tailscale.com/docs/kubernetes-operator/egress/access-tailnet-service); the annotation accepts an address exposed by a subnet router).
2. Point `LOCAL_AI_OLLAMA_URL` at that Service, for example `http://gpu.<namespace>.svc.cluster.local:11434`.
3. In the tailnet policy, allow only the app's tag to reach port 11434 of that one address. The subnet route otherwise exposes the whole home LAN to every permitted tailnet device.
4. Provide a way to wake the desktop on demand, for example a small relay on the always-on node that only sends the magic packet. Do not hand the app the full-power Home Assistant token for this.

Not run: the Tailscale operator, the ACL and the wake relay. The desktop was asleep during this work, so the path was not exercised. The model host sees each question in clear while it runs; only the app's stored copy is bounded.

**Hosts other than the owner's are a different problem, and this route does not solve it.** Nobody else can join the owner's tailnet or have the cluster's operator and ACL edited for them, and an app that fetches addresses hosts supply has the same bypassable-address problem as Home Assistant pull. The proposed design (not built; [roadmap D3](ROADMAP.md)) reverses the direction: a small **host connector** next to Ollama (a relay program, not an AI agent) connects **out** to the app, proves itself with a key made on the host, and takes jobs from a queue. That needs no VPN, no open port and no cluster change, and it lets the cluster's network policy keep blocking private ranges. For the owner it would replace steps 1, 3 and 4 above: the connector runs on the always-on node and wakes the desktop itself.

## Public pages

`/welcome/<city>` is a public page for newcomers. It sits outside the `(wallet)` route group, so the wallet SDK never loads there ([ADR 0012](adr/0012-public-pages-outside-the-wallet-group.md)). Checked in a production build from a clean cache: 15 requests, all to the app's own origin, and no cookies. It reads the published city feed at request time, so the image needs `stadtstack-data/out`, which it already contains.

## On the owner's cluster

`deploy/` releases the app to the owner's Talos cluster at `ledger.stadtstack.eu` as one Helm release managed by **helmfile**, with the same defaults as the cluster's platform helmfile (atomic, wait, history 10). The chart holds the ConfigMap, a 2 Gi volume for SQLite (kept on uninstall), the Deployment, the reconcile `CronJob`, the Service, the HAProxy Ingress with the cluster's Let's Encrypt issuer and four network policies. The namespace, with Pod Security `restricted`, sits outside Helm so an uninstall never removes it. `deploy/apply.sh` is the bounded wrapper: it refuses a render without a real image digest and any cluster but the reviewed one (by the `kube-system` UID); `--diff-only` changes nothing; a release needs a typed confirmation. [deploy/README.md](../deploy/README.md) lists the order and what the owner supplies.

- **DNS: done on 30 September.** `ledger.stadtstack.eu` A `77.42.11.9` (the cluster's public ingress load balancer), created through the Hetzner Cloud DNS API in the zone `stadtstack.eu`; all three authoritative nameservers answer it. No `AAAA`.
- **Storage: SQLite on the volume, no backup.** Accepted by the owner for the contest window (30 September). The database holds account identifiers, chosen cities and test records; wallets live with Privy and on the test chains, so losing it means setting up again, not losing assets.
- **How it is applied.** In `strausberg-zk-residency`, `infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh` opens the owner's rootless WireGuard session (no sudo, credentials only in a private temporary directory), exports the pushed commit's `deploy/` tree and runs one mode of that `apply.sh`: `--namespace`, `--secret FILE`, `--diff-only`, `--release` or `--network-test`. It refuses unpushed commits and a `wireproxy` that fails its pinned checksum, and refuses to start while another tunnel on the daily identity runs. The wrapper and Freelens filtered supervisor now atomically acquire the same canonical per-user daily-identity lock, independent of the caller's `TMPDIR`, and record their PID; each holds it until its tunnel stops and releases it in its exit trap. Every launchd restart reacquires that lock before starting wireproxy, live holders are refused with their PID, and stale locks are reclaimed only when their recorded PID is no longer running.
- **Live since 30 September.** The owner ran the wrapper from commit `090608b`: namespace, Secret, then Helm revision 1, installed in 45 s. Checked from outside the same morning: every public resolver answers `77.42.11.9`, plain HTTP redirects to HTTPS, the certificate is Let's Encrypt's for `ledger.stadtstack.eu` (valid to 29 December), the pages, the manifest, the icon and both link-preview cards answer, an unknown city answers 404, the pod runs with no restarts and the reconcile job completes every minute. A passkey sign-up on the hosted origin works (the step after it, the backup email, needs a real inbox and was not driven). The only warning was a transient `FailedMount` while the Hetzner volume attached.
- **Fixed in the second image:** `/api/status` reported `"identity": false` on the first live build although sign-in worked; the route now reads the compiled-in public app id the way the sign-in code does.

## Checked, and not

Checked in a container built from this tree: the pages, the store on a volume, the reconcile route's `local-ai` scope with and without the secret (and an unknown scope), non-root and read-only operation, shutdown on `SIGTERM`, the absence of secrets and contract artifacts, and the whole retention path against a stub model (question asked, text removed after the grace period and on "Finish & clear this desk", usage counts kept, no copy left in the database file or log).

Not checked: the Tailscale path, the backup-email step of hosted sign-up, the real GPU (the desktop was asleep), Postgres, and whether the network policies block what they should (the allowed paths demonstrably work).
