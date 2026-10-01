# Ledger of Life on the Talos cluster: Helm release for review

**Live since 30 September.** Revision 1 from commit `090608b`; revision 2 from `ffb2d96` (image `sha256:6cbf8c0b…6193`) the same day. What was checked is in `docs/DEPLOYMENT.md`. Applying runs through `infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh` in `strausberg-zk-residency`, which opens the owner's rootless session and runs one mode of `deploy/apply.sh`; every change needs a typed confirmation. Test networks only; no real money. This is a bounded, digest-pinned release, not a claim of production readiness.

## Why helmfile

The app uses the same tool and defaults as the owner's platform: atomic, cleanupOnFail, historyMax 10, timeout 600, wait and waitForJobs. `helmfile diff` shows the exact change; Helm keeps release history and supports `helm rollback`. Atomic + wait roll back a failed release by themselves. Unlike platform defaults, `createNamespace` is false: the namespace must already carry its Pod Security labels and must survive uninstall.

## Files

| File | What it does |
|---|---|
| `helmfile.yaml` | One local-chart release `ledger-of-life` in `ledger-of-life`, with the platform defaults above. |
| `namespace.yaml` | Outside Helm: `restricted` enforce/audit/warn at v1.36. Created before the release and never deleted by uninstall. |
| `chart/Chart.yaml`, `chart/values.yaml` | Chart identity and defaults: host, digest, storage, resources, ingress and non-secret config. |
| `chart/templates/configmap.yaml` | Derives `APP_ORIGIN=https://<host>`; `ALLOW_LOCAL_STORE=1`, `LOCAL_AI_LIBRARY_ENABLED=0`. No operator tools, Home Assistant pull or GPU address. |
| `chart/templates/pvc.yaml` | Two 2 Gi ReadWriteOnce claims, `hcloud-volumes`: `ledger-data` for `/data` and `ledger-backups` for `/backups`. Both have `helm.sh/resource-policy: keep` for uninstall. |
| `chart/templates/deployment.yaml` | One replica, Recreate for SQLite. A checksum of the rendered ConfigMap rolls the pod when config changes. Non-root uid/gid 1000, fsGroup 1000, RuntimeDefault, read-only root, drop ALL, no service-account token. Writable data, Next cache and tmp volumes; readiness checks the status JSON's store availability. `ledger-backups` is mounted read-only at `/backups` and never read by the app: `hcloud-volumes` binds a claim only when a Pod first uses it, and the release's `wait` needs every claim Bound, so without this mount every release would wait until the next backup run. |
| `chart/templates/service.yaml` | ClusterIP 4175, unchanged immutable workload selectors. |
| `chart/templates/ingress.yaml` | HAProxy, letsencrypt-prod, HTTPS redirect, `ledger-of-life-tls`, 120 s server timeout for payout account creation (which can wait about 60 s for Solana confirmations). |
| `chart/templates/cronjob.yaml` | Reconcile every minute, Forbid concurrency and bounded deadlines, same hardening, in-cluster Service origin. |
| `chart/templates/backup-cronjob.yaml`, `backup-configmap.yaml`, `chart/files/backup.mjs` | Online SQLite backup every six hours using the app image and a ConfigMap-mounted Node command, verifies integrity before publishing, retains the newest 28 snapshots. Required affinity puts it on the web pod's node for ReadWriteOnce; same restricted hardening, no Secret or network allowances. |
| `chart/templates/networkpolicy.yaml` | Four policies: default deny, HTTP-01 solver, web and reconcile. HAProxy sources and reconcile can reach the app; DNS and public HTTPS only, excluding private/link-local/CGNAT. |
| `chart/templates/tests/network-policy-probe.yaml` | Two digest-pinned, restricted Helm test Pods on the web pod's node; created only by `helm test`, not the release. |
| `values/ledger.stadtstack.eu.yaml` | Public host, the **one** image digest used by workloads and probes, empty atlas URL and public pull-v2 devnet manifest. Rendering refuses an empty/invalid digest or empty host. |
| `ledger-env.example` | Secret key names and the public devnet RPC fallback; no private values. |
| `apply.sh` | Five modes, all behind the offline render (digest refusal) and cluster UID guard, with one kube context bound to every kubectl, Helm and helmfile call. `--diff-only` changes nothing. `--namespace` creates only the namespace. `--secret FILE` replaces `ledger-env` from an owner-only file outside every repository, checking keys by name only, then restarts the web Deployment if it exists and waits up to 180 s for readiness. `--network-test` prints deployed hooks, asks for typed confirmation and runs the enforcement probe. The default requires the Secret, shows the diff including test hooks, asks for typed confirmation, applies, waits for rollout and certificate, then prints `storeAvailable` and `persistence`. Works from any cwd. |

Standard Helm labels are metadata only; workload components are `web`, `reconcile` and `backup`. The backup component matches only the namespace-wide default-deny policy.

## Conventions copied, and where they were read

Read on 29 Sep 2026 through the read-only Freelens viewer, plus the owner's repository. Nothing was changed.

| Convention | Value | Source |
|---|---|---|
| Certificates | `cert-manager.io/cluster-issuer: letsencrypt-prod`; the load balancer serves Let's Encrypt certificates | Ingress `stadtstack-registry/stadtstack-registry-read-only`; `openssl s_client` against `77.42.11.9` |
| HTTPS redirect | `haproxy-ingress.github.io/ssl-redirect: "true"` | Ingress `agentcart-demo/woo-eur` |
| Storage | `hcloud-volumes`, `ReadWriteOnce`, 1 Gi and 10 Gi | StatefulSets in `agentcart-demo` (class object itself is not readable through the viewer) |
| Reclaim policy | `Retain` | `infra/hetzner-talos/platform/storageclass-hcloud-volumes.example.yaml` (the example, not the live object) |
| Pod security | `restricted`, version v1.36 | Namespace labels on `stadtstack-demo` and `flux-roebel-staging` |
| Pod hardening | non-root, `fsGroup`, `OnRootMismatch`, `RuntimeDefault` seccomp, drop ALL, `automountServiceAccountToken: false` | Deployment `stadtstack-demo/stadtstack-demo`; StatefulSet `agentcart-demo/woo-eur-db` |
| Network policy | `default-deny`, per-workload allow rules, 443 egress excluding private ranges, the HAProxy source addresses, and the HTTP-01 solver rule | NetworkPolicies `agentcart-demo/default-deny`, `woo-eur-storefront`, `cert-manager-http01` |
| Image references | `ghcr.io/giraeffleaeffle/<name>@sha256:…` with `IfNotPresent` and no pull secret; or `registry.agentcart.eu/…@sha256:…` with `imagePullPolicy: Never` | Deployments `stadtstack-roebel-staging-lab/public-mecky` and `stadtstack-demo/stadtstack-demo` |

| Release management | helmfile 1.5.2, Helm 3.17, helm-diff; atomic/cleanupOnFail, historyMax 10, timeout 600, wait/waitForJobs | Owner's platform helmfile and installed tooling (30 Sep 2026) |

## What you must supply or decide

1. **Public GHCR image.** `.github/workflows/image.yml` builds `ghcr.io/giraeffleaeffle/ledger-of-life` for linux/amd64 when a tag `image-*` is pushed, with the public build arguments `NEXT_PUBLIC_PRIVY_APP_ID` and `APP_ORIGIN` (repository variables, set on 30 Sep). The package is public, because the cluster pulls without a secret. The job summary prints the digest.
2. **Digest.** Paste that digest into `values/ledger.stadtstack.eu.yaml`. The empty default is intentional: neither rendering nor the script can proceed without `sha256:` plus 64 lowercase hex characters.
3. **Privy.** Not needed any more: the owner added `https://ledger.stadtstack.eu` to the app's own Allowed Origins on 30 Sep, so no app client id is set. Fill the private Secret file outside this repository.
4. **DNS is DONE.** `ledger` A → `77.42.11.9` was created 30 Sep 2026 and resolves to the public ingress load balancer. No AAAA; the apex address must not be copied. No CAA blocks Let's Encrypt.
5. **SQLite acceptance.** Six-hourly snapshots on a second cluster volume protect against database corruption and mistakes, not loss of the whole cluster. There is no off-site copy yet. These include account identifiers, wallet addresses, selected cities and test tenancy records; keep this small and do not call it production.

## Order

Every external change requires the owner's approval. Revision 1 was applied by the owner. Revision 2 (`--secret`, `--release`, `--network-test`) was run by the assistant through the same wrapper and typed confirmations, at the owner's explicit request, on 30 September.

1. DNS is done. Privy: `https://ledger.stadtstack.eu` is in the app's own Allowed Origins (30 Sep; the wallet iframe's `frame-ancestors` lists it), so no app client id is needed.
2. The image comes from `.github/workflows/image.yml`, run by pushing a tag `image-*` on a commit whose CI passed. Make the package public once, then paste the digest from the job summary into `deploy/values/ledger.stadtstack.eu.yaml`, commit and push.
3. In `strausberg-zk-residency`, stop the Freelens viewer (the session uses the same daily WireGuard identity), set the acknowledgement once, and run the wrapper. No sudo is needed:

   ```bash
   infra/hetzner-talos/scripts/open-freelens-filtered-viewer.sh stop
   export LIVE_LEDGER_OF_LIFE_ACK=release-ledger-of-life-through-deploy-apply-only-v1
   infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh --namespace          # first run only
   infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh --secret ~/ledger-env.local
   infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh --release            # shows the diff, then asks
   infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh --network-test       # after releasing the probe hooks
   infra/hetzner-talos/scripts/open-freelens-filtered-viewer.sh start --manual-stop
   ```

   The wrapper runs only the pushed commit's `deploy/` tree and refuses any cluster but the reviewed one (kube-system UID `7bc769bc-e860-4d54-a0d5-d426f3a52420`). It refuses to start while another rootless tunnel runs and checks again just before applying; the wrapper and Freelens supervisor now both atomically acquire the same per-user daily-identity lock, record their PID and hold it until their tunnel stops. The canonical path is `$(getconf DARWIN_USER_TEMP_DIR)stadtstack-wireguard-daily.${UID}.lock`, independent of the caller's `TMPDIR`; each launchd restart reacquires it, a live holder is named and refused, and only a recorded dead PID permits stale-lock reclamation. Offline smokes can redirect the lock with `STADTSTACK_WIREGUARD_DAILY_TEST_LOCK` only when `STADTSTACK_WIREGUARD_LOCK_TEST_MODE=1`; the former public `STADTSTACK_WIREGUARD_DAILY_LOCK` override is refused. `--release` waits up to 180 seconds for the rollout and up to 2 minutes for the certificate; if the certificate is still pending it says so and exits successfully, because the release itself is up.

Prerequisites: helmfile, Helm, the Helm diff plugin, kubectl, curl and Python 3. `KUBECTL` overrides the kubectl binary (for example `$HOME/.local/bin/kubectl-v1.36.0`). Secret checks fetch only `.data` key names, never values. Rendering happens before any cluster write, so missing digest stops safely.
Helm API-server, CA, token, impersonation and TLS connection environment overrides must be unset (even empty values are refused before any tool runs); context-name checks remain in place. Preview and apply both include test hooks in their change decision.

The private env file must hold **every key to keep**: `--secret` replaces the whole Secret. In addition to Privy and
reconcile credentials, set `SOLANA_RPC_URL` to a devnet HTTPS endpoint (a provider key embedded in its URL is secret;
`https://api.devnet.solana.com` works but is rate limited) and `SOLANA_SPONSOR_KEYPAIR` to a one-line JSON array of
64 integers, without surrounding quotes, from a fresh key used only by this host. Secret replacement restarts an
existing web Deployment; first-run storage before a Deployment exists does not try to restart one.

Hosted non-secret config supplies the public pull-v2 devnet manifest from
`docs/evidence/SOLANA_PULL_DEVNET_DEPLOYMENT_2026-09-25.json`, with a 15 s observation limit, a 10,000,000-lamport sponsor
ceiling and hosted base placeholders for per-tenancy setup. Test tokens have no real value. `STADTSTACK_ATLAS_URL`
is explicitly empty: there is no hosted project atlas (it is a local research prototype), so the app should say
nothing about it, not claim an outage. `SOLANA_TEST_SIGNER_MODE`, `ALLOW_OPERATOR_TEST_ACTIONS`,
`ALLOW_HOME_ASSISTANT_PULL` and `LOCAL_AI_OLLAMA_URL` remain unset. ConfigMap changes alter the
web pod template's `checksum/config`, so the next release replaces the pod instead of leaving stale environment values.

## Dedicated testnet price updater

Set `ROBINHOOD_PRICE_UPDATER_PRIVATE_KEY` in the private `ledger-env` file to a fresh key used **only** for the shared market's price mirror. It must match the immutable updater in `contracts/evm/deployments/shared-market-46630.json`. Its single power is the price push, bounded to 20% per hour on-chain; it cannot withdraw pool funds. Top up its address with **test ETH** at [Robinhood's faucet](https://faucet.testnet.chain.robinhood.com/).

The minute reconcile job includes the `price` scope. A missing key or deployment manifest returns `unconfigured` without disturbing the other scopes. Chainlink RHTSLA/USD on mainnet is the primary source; a fresh Jupiter TSLAx quote must agree within 5%. Missing, stale or divergent Jupiter quotes skip the push. Source pause and RPC chain-identity checks fail closed. Before signing, the job checks the feed's constructor-bounded first push and, thereafter, its one-hour minimum interval and ±20% movement cap relative to the previous answer. A longer outage never removes the cap. Because only one push per hour can be accepted, the copied price may lag a source update by up to an hour. Localhost uses the same hosted mirror and needs no second updater. Rotating the immutable updater requires redeploying the feed and pool.

Multiplier and pause reads use the mainnet **Tesla** token `0x322F0929c4625eD5bAd873c95208D54E1c003b2d`, not the SPY token in the older mainnet dependency manifest. The copied Chainlink token price is converted to the test token's multiplier: divide by the mainnet multiplier to get the share basis, then multiply by the testnet multiplier, rounding down at both steps. The journal and job result retain the raw answer, both multipliers and the converted answer. Jupiter checks the share basis. A test multiplier change during gas review skips the push; a later change makes the feed return price zero until the next source round is copied.

The scheduler attempts every scope independently, collecting failures and exiting non-zero only after all scopes have run; a failed tenancy or local-AI reconciliation cannot prevent the price job.

## NetworkPolicy enforcement probe

After releasing these hooks, `--network-test` prints `helm get hooks` for the deployed revision, asks for exactly
`test network policies in ledger-of-life`, and runs `helm test --logs --timeout 3m`. The wrapper still requires
the acknowledgement. Both Pods wait 5 s for policy discovery and run on the web pod's node using its pinned image.
The `reconcile` identity must receive DNS and HTTP 200 from the web Service, but time out connecting to
`api.privy.io:443`. The `isolated` identity must time out on both DNS and the web Service. A refusal or answer is
not a drop; a failed positive DNS/web check or public DNS error is inconclusive, not proof of enforcement.
Public host resolution has a separate 4 s deadline before the 4 s TCP drop timer starts; failed or stalled resolution reports `dns-error` and cannot count as a drop.

A PASS proves point-in-time enforcement for new connections on that node: default deny blocks DNS and same-node
Service egress, reconcile allows DNS/web and denies public HTTPS, and web ingress admits reconcile. Combined with
the site answering through HAProxy, it confirms a real ingress source is admitted there. It cannot prove web egress
(443-only/private-range exclusions), web ingress denial independently, which HAProxy clause admits traffic or
whether every configured source is needed, the other nodes, continuity during fail-open agent outages,
Pod-to-own-node host traffic, HTTP-01 enforcement, non-DNS UDP or IPv6. Neither probe becomes a Service endpoint.
The Pods have no Secret or service-account token; they stay completed until the next test so Helm can print logs.
They are not removed by `helm uninstall`. Each result includes a timestamp: if the first hook fails, Helm may
print the second hook's old logs from an earlier run.

## Check afterwards

- `kubectl -n ledger-of-life rollout status deploy/ledger-of-life`, then `get certificate` until Ready.
- Public `/api/status` reports `storeAvailable: true`, `persistence: local-sqlite`.
- `/welcome/strausberg` loads without third-party requests. `/` contacts Privy and WalletConnect by design (ADR 0012).
- `kubectl -n ledger-of-life get jobs` shows completed reconcile jobs about every minute.
- `kubectl -n ledger-of-life get cronjob ledger-of-life-backup` shows `0 */6 * * *` UTC; inspect backup Job logs after the first scheduled run for `Verified snapshot`. This checkout has only been verified offline, not released.
- Localhost passkeys cannot be used on this domain (WebAuthn domain scoping).

## Roll back

- `helm history ledger-of-life -n ledger-of-life`, then `helm rollback ledger-of-life <revision> -n ledger-of-life`. Recreate means a short outage. Also restore the desired digest in the values file before the next helmfile apply. A failed atomic release rolls back automatically; database schema/data changes are not reversed by Helm.
- **A release left pending.** If a helm process is interrupted mid-release (on 1 October the release terminal closed while `wait` was still holding), Helm marks that revision `pending-upgrade` and refuses every later upgrade with "another operation is in progress". `deploy/apply.sh` prints the release state in `--diff-only` and the release. Before its diff, the release rolls back to the last deployed revision with `--wait`, after a separate typed `recover ledger-of-life`. It refuses this while the pending revision is under 15 minutes old, because a helm process with its 600-second timeout may still be running. The release then continues with its own diff and confirmation.
- `helm uninstall ledger-of-life -n ledger-of-life` removes release resources but **keeps the namespace and both PVCs**. Inspect retained data and ownership before reinstalling. Namespace/PVC deletion is a separate, explicit decision; the example StorageClass says Retain, so the underlying Hetzner volumes may remain billed until removed manually. Remove DNS separately if decommissioning.

## SQLite snapshots and restore

`ledger-of-life-backup` runs at 00:00, 06:00, 12:00 and 18:00 UTC. It uses the pinned app image's `node:sqlite` online backup API against `/data/rental.sqlite`, including committed WAL pages while the app writes. A read-only SQLite connection still needs a writable data mount for WAL shared-memory bookkeeping. Required pod affinity schedules the Job on the web pod's node, so both can mount `ledger-data` (ReadWriteOnce). If the web pod is absent or volumes cannot attach, the Job cannot run and its 300-second deadline bounds the attempt. `Forbid`, no retries, one successful and two failed Job histories keep work bounded.

Snapshots live on the separate 2 Gi `hcloud-volumes` claim **`ledger-backups`**, mounted at `/backups`. The chart mounts `chart/files/backup.mjs` through `ledger-backup-script`; no new image or app secrets are needed. Files are `rental-<UTC timestamp>-<uuid>.sqlite`, mode 0600. Before verification/publication, every `local-ai:request:*` record is scrubbed using exactly the app retention fields: `request.prompt = ''`, `request.answer = null`, and `request.purgedAt = <UTC time>`. This applies regardless of age or state, including running/settling requests. The snapshot alone enables `secure_delete`, uses DELETE journal mode and is rebuilt with `VACUUM` so removed text cannot remain in free pages. It then must return `ok` from `PRAGMA integrity_check`; only then is its `.partial` file renamed and older snapshots pruned. The newest **28 successful snapshots** are kept (about seven days at four successes/day; failed runs can make the oldest older). Interrupted partials are removed on the next run; never restore or distribute a partial because it may be incomplete or not yet scrubbed. Size is not compressed or quota-managed: ensure 2 Gi accommodates 28 databases plus one in-progress copy and temporary space for VACUUM, and inspect failed Job logs for capacity or integrity errors. Both PVCs survive Helm uninstall.

Snapshots are sensitive database copies **excluding desk questions and answers**, not anonymised exports. Reviewing `src/server` found account identifiers, public wallet addresses, city and tenancy/listing records, the AI host registry (public keys and invitation hashes), usage counters and signed transaction/payment journals. API credentials, signing private keys and connector private keys are not written by those hosted flows; they stay in runtime secrets or on the connector. **Do not assume every possible database is secret-free:** `src/server/adapters.ts` can store a Home Assistant bearer token when local/explicit opt-in is enabled. The hosted configuration forbids new Home Assistant connections, but restoring old/local records can bring a token back. Published snapshots do not extend AI question/answer retention: the scrub affects the backup copy only, leaving the live desk's existing grace-period behavior unchanged. Usage, ownership, state and payment journals remain recoverable, but a restored desk cannot recover its former question/answer text. Treat both volumes as private and never print record bodies while inspecting them.

This protects against corruption and accidental changes **after a successful snapshot**, not losing the whole cluster or all its volumes. There is **no off-site copy yet**. A restore loses database changes since that snapshot and does not roll back test-chain transactions, Privy accounts or connector state; review pending operations and host pairings after recovery.

### List snapshots (owner's admin session)

The release wrapper only accepts the existing `deploy/apply.sh` modes. It cannot run arbitrary `kubectl exec`, scale, patch or maintenance Pods. **All commands in this section require the owner's separately authorised admin session** on the reviewed cluster, not the release wrapper or the filtered read-only viewer. No cluster changes were made while writing this runbook.

1. Record the ready web pod's node and the deployed image (public values), then create a hardened, network-isolated maintenance Pod on that node. Use it to list the backup PVC; no database content is printed.

   ```bash
   NS=ledger-of-life
   NODE=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=ledger-of-life,app.kubernetes.io/component=web --field-selector=status.phase=Running -o jsonpath='{.items[0].spec.nodeName}')
   IMAGE=$(kubectl -n "$NS" get deployment ledger-of-life -o jsonpath='{.spec.template.spec.containers[0].image}')
   test -n "$NODE" && test -n "$IMAGE" || exit 1
   kubectl -n "$NS" apply -f - <<EOF
   apiVersion: v1
   kind: Pod
   metadata:
     name: ledger-restore
     labels:
       app.kubernetes.io/name: ledger-of-life
       app.kubernetes.io/component: maintenance
   spec:
     nodeName: $NODE
     restartPolicy: Never
     automountServiceAccountToken: false
     enableServiceLinks: false
     securityContext:
       runAsNonRoot: true
       runAsUser: 1000
       runAsGroup: 1000
       fsGroup: 1000
       fsGroupChangePolicy: OnRootMismatch
       seccompProfile:
         type: RuntimeDefault
     containers:
       - name: restore
         image: $IMAGE
         command: ["node", "-e", "setInterval(() => {}, 60000)"]
         securityContext:
           allowPrivilegeEscalation: false
           readOnlyRootFilesystem: true
           capabilities:
             drop: ["ALL"]
         resources:
           requests: {cpu: 20m, memory: 64Mi}
           limits: {cpu: 500m, memory: 256Mi}
         volumeMounts:
           - {name: data, mountPath: /data}
           - {name: backups, mountPath: /backups, readOnly: true}
     volumes:
       - name: data
         persistentVolumeClaim: {claimName: ledger-data}
       - name: backups
         persistentVolumeClaim: {claimName: ledger-backups}
   EOF
   kubectl -n "$NS" wait --for=condition=Ready pod/ledger-restore --timeout=180s
   kubectl -n "$NS" exec ledger-restore -- node -e 'console.log(require("node:fs").readdirSync("/backups").filter(n => n.endsWith(".sqlite")).sort().join("\n"))'
   ```

   If only listing, delete `pod/ledger-restore` afterwards. If the web pod is already unavailable, recover its volume attachment node from the owner's storage inventory and deliberately set `NODE` instead; do not start a helper on a second node while a claim is still attached elsewhere.

### Restore (owner's admin session; outage required)

2. Keep the helper from step 1 running. Suspend scheduled backups, inspect active Jobs and wait for any running backup to finish before proceeding. Suspension does not stop an already-started Job; if a failed/stuck Job must be removed, review it and delete that specific Job in the admin session first. Ensure no backup Pod remains Running or Pending.

   ```bash
   kubectl -n "$NS" patch cronjob ledger-of-life-backup --type=merge -p '{"spec":{"suspend":true}}'
   kubectl -n "$NS" get jobs,pods -l app.kubernetes.io/component=backup
   # For each active Job: kubectl -n "$NS" wait --for=condition=complete job/<name> --timeout=330s
   ```

3. Scale the web Deployment to zero and wait until **all** its Pods terminate. Do not run a release or Secret replacement during this maintenance window.

   ```bash
   kubectl -n "$NS" scale deployment ledger-of-life --replicas=0
   kubectl -n "$NS" wait --for=delete pod -l app.kubernetes.io/name=ledger-of-life,app.kubernetes.io/component=web --timeout=180s
   ```

4. Choose one listed, verified `.sqlite` snapshot (never `.partial`). With the app and backup writers stopped, check it again, copy it over `/data/rental.sqlite`, set 0600 and remove old WAL/shared-memory sidecars. **Do not remove sidecars while the app is running.**

   ```bash
   SNAPSHOT='rental-<timestamp>-<uuid>.sqlite' # replace with an exact listed name
   kubectl -n "$NS" exec ledger-restore -- node -e '
     const fs = require("node:fs"), { DatabaseSync } = require("node:sqlite");
     const name = process.argv[1];
     if (!/^rental-[a-zA-Z0-9-]+\.sqlite$/.test(name)) throw Error("Invalid snapshot name");
     const path = "/backups/" + name, db = new DatabaseSync(path, {readOnly: true});
     const rows = db.prepare("PRAGMA integrity_check").all();
     db.close();
     if (rows.length !== 1 || rows[0].integrity_check !== "ok") throw Error("Invalid snapshot");
     fs.copyFileSync(path, "/data/rental.sqlite");
     fs.chmodSync("/data/rental.sqlite", 0o600);
     for (const suffix of ["-wal", "-shm"]) fs.rmSync("/data/rental.sqlite" + suffix, {force: true});
     console.log("Snapshot restored; stale WAL and SHM removed");
   ' "$SNAPSHOT"
   ```

   If the copy/check fails, leave the web scaled down, inspect the failure and retry with a known-good snapshot; never resume with a partly copied database.

5. Delete the helper before scaling back to one, check store readiness, review restored pending operations/pairings, and resume backups only after recovery is satisfactory.

   ```bash
   kubectl -n "$NS" delete pod ledger-restore --wait=true
   kubectl -n "$NS" scale deployment ledger-of-life --replicas=1
   kubectl -n "$NS" rollout status deployment/ledger-of-life --timeout=180s
   curl --fail --silent --show-error https://ledger.stadtstack.eu/api/status
   kubectl -n "$NS" patch cronjob ledger-of-life-backup --type=merge -p '{"spec":{"suspend":false}}'
   ```

## Offline verification and limits

The old Kustomize render (11 objects) and Helm render (10 plus the external Namespace) were compared semantically using a test digest: every field matches after removing only standard Helm metadata and the PVC keep annotation. Strict kubeconform Kubernetes 1.36 validation, both Pod Security restricted pod-spec checks, Bash syntax and ShellCheck were run offline. Missing digest rendering refuses deployment. The prior readiness command smoke covered an available store (exit 0), unavailable store (exit 1) and closed port (exit 1); the command is unchanged.

The current chart renders 13 release objects plus two test Pods (the Namespace is still external). Prior offline checks
cover the original four rendered Pod specs' restricted hardening, hosted manifest parsing and `solanaConfiguration`
acceptance without network calls, checksum changes when config changes, probe PASS/FAIL decisions with mock
transport outcomes, actual `--secret` restart/no-Deployment flows with stub binaries, missing-digest refusal before
kubectl, wrapper acknowledgement/argument refusal, Bash syntax and ShellCheck. These are not live network tests.
Kubeconform was not available locally for revalidating the new hooks against Kubernetes 1.36.0.

On 1 October, `helm template` with current hosted values passed; all five rendered workload Pod specs satisfy restricted hardening and the backup matches only default deny. The pinned amd64 app image ran read-only as uid 1000 with capabilities dropped and no network: a real app `LocalStore` WAL database was written continuously while a second container ran the exact rendered backup command. Integrity was `ok`, mode 0600, committed counter 1056 was captured while the writer advanced to 1168. Further smoke checks kept the newest 28 snapshots, cleaned an interrupted partial, preserved an unrelated file, rejected a corrupt source without publishing/pruning and restored the exact snapshot counter after stopping writes. Temporary containers, volume, newly pulled app image and smoke files were removed. Kubeconform is not installed, so this addition was not strictly schema-validated. Actual CronJob scheduling/affinity, Hetzner attachment, live backup and cluster restore remain unverified; nothing was applied to the cluster.

The privacy follow-up ran the updated rendered command against four real `LocalStore` desk records (`completed`, `ready`, `running`, `settling`) while another record was being written. All four snapshot records had empty prompts, null answers and a purge timestamp; their states, usage, ownership and payment journals survived, and integrity remained `ok`. Full-file byte checks found neither synthetic question nor answer marker in the published snapshot, while both markers remained in the live SQLite file and live queries returned unchanged text. The grep tool reported no snapshot matches but also missed known binary live-file matches, so the decisive byte evidence used Node `Buffer.includes` over the entire files. The follow-up container, pulled image and temporary files were removed.

## Not verified

- **What the first release proved (30 September).** The wrapper's `--namespace`, `--secret` and `--release` modes against the live cluster; certificate issuance through the HTTP-01 solver policy; public readiness. The claim bound and the Hetzner volume attached (after one transient `FailedMount` while the device appeared), and the store opens on it as uid 1000, so `fsGroup` works: opening runs `CREATE TABLE`, and `/api/status` answers `storeAvailable: true`. A reconcile job completes every minute, and `scripts/reconcile.mjs` fails on any non-2xx answer, so the Secret, in-cluster DNS and the reconcile-to-web path work. Rollback was not exercised.
- **NetworkPolicy enforcement: proven on 30 September** (revision 2, `--network-test`). On the web pod's node: the `reconcile` identity got DNS and HTTP 200 from the web Service and timed out connecting to `api.privy.io:443`; the `isolated` identity timed out on DNS and on the web Service. So default deny, the reconcile policy and the web policy's admission of the reconcile identity are enforced. The limits listed under "NetworkPolicy enforcement probe" still apply (one node, point in time, web egress not probed).
- **The HAProxy source addresses.** With enforcement proven on that node and the site answering through the ingress, HAProxy's real source is admitted there. Which clause admits it, and whether every listed address is needed, is still not known.
- **The project atlas.** No project atlas is deployed. Hosted values explicitly set `STADTSTACK_ATLAS_URL` empty; city choice and bundled snapshots remain separate from the local research prototype.
- **Resource sizes** (request 192 Mi, limit 768 Mi) come from about 120 MB idle in Docker. They were not load tested.
- **No GPU path.** `LOCAL_AI_OLLAMA_URL` is unset, so the paid AI desk reports itself unconfigured. See `docs/DEPLOYMENT.md`, "The GPU".
