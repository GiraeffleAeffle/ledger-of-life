# Ledger of Life on the Talos cluster: Helm release for review

**Live since 30 September** (Helm revision 1 from commit `090608b`; what was checked is in `docs/DEPLOYMENT.md`). Applying runs through `infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh` in `strausberg-zk-residency`, which opens the owner's rootless session and runs one mode of `deploy/apply.sh`; every change needs a typed confirmation. Test networks only; no real money. This is a bounded, digest-pinned release, not a claim of production readiness.

## Why helmfile

The app uses the same tool and defaults as the owner's platform: atomic, cleanupOnFail, historyMax 10, timeout 600, wait and waitForJobs. `helmfile diff` shows the exact change; Helm keeps release history and supports `helm rollback`. Atomic + wait roll back a failed release by themselves. Unlike platform defaults, `createNamespace` is false: the namespace must already carry its Pod Security labels and must survive uninstall.

## Files

| File | What it does |
|---|---|
| `helmfile.yaml` | One local-chart release `ledger-of-life` in `ledger-of-life`, with the platform defaults above. |
| `namespace.yaml` | Outside Helm: `restricted` enforce/audit/warn at v1.36. Created before the release and never deleted by uninstall. |
| `chart/Chart.yaml`, `chart/values.yaml` | Chart identity and defaults: host, digest, storage, resources, ingress and non-secret config. |
| `chart/templates/configmap.yaml` | Derives `APP_ORIGIN=https://<host>`; `ALLOW_LOCAL_STORE=1`, `LOCAL_AI_LIBRARY_ENABLED=0`. No operator tools, Home Assistant pull or GPU address. |
| `chart/templates/pvc.yaml` | 2 Gi ReadWriteOnce, `hcloud-volumes`, database at `/data`. `helm.sh/resource-policy: keep` preserves the claim on uninstall. |
| `chart/templates/deployment.yaml` | One replica, Recreate for SQLite. Non-root uid/gid 1000, fsGroup 1000, RuntimeDefault, read-only root, drop ALL, no service-account token. Writable data, Next cache and tmp volumes; readiness checks the status JSON's store availability. |
| `chart/templates/service.yaml` | ClusterIP 4175, unchanged immutable workload selectors. |
| `chart/templates/ingress.yaml` | HAProxy, letsencrypt-prod, HTTPS redirect, `ledger-of-life-tls`. |
| `chart/templates/cronjob.yaml` | Reconcile every minute, Forbid concurrency and bounded deadlines, same hardening, in-cluster Service origin. |
| `chart/templates/networkpolicy.yaml` | Four policies: default deny, HTTP-01 solver, web and reconcile. HAProxy sources and reconcile can reach the app; DNS and public HTTPS only, excluding private/link-local/CGNAT. |
| `values/ledger.stadtstack.eu.yaml` | Public host and the **one** image digest used by both workloads. Rendering refuses an empty/invalid digest or empty host. |
| `ledger-env.example` | Secret key names; no secret values. |
| `apply.sh` | Four modes, all behind the offline render (digest refusal) and the cluster UID guard, with one kube context bound to every kubectl and helmfile call. `--diff-only` changes nothing. `--namespace` creates only the namespace (first run). `--secret FILE` stores Secret `ledger-env` from an owner-only file outside every repository, checking keys by name only. The default mode requires the Secret, shows the diff, asks for a typed confirmation, applies, waits for the rollout and the certificate, then prints `storeAvailable` and `persistence`. Works from any cwd. |

Standard Helm labels are metadata only; selectors remain `app.kubernetes.io/name: ledger-of-life` and component `web` or `reconcile`.

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

1. **Public GHCR image.** `.github/workflows/image.yml` (manual) builds `ghcr.io/giraeffleaeffle/ledger-of-life` for linux/amd64 from a pushed commit, with the public build arguments `NEXT_PUBLIC_PRIVY_APP_ID` and `APP_ORIGIN` (repository variables, set on 30 Sep) and `NEXT_PUBLIC_PRIVY_CLIENT_ID` (repository variable, not set yet). A first push creates a private package: make it public once in the package settings, because the cluster pulls without a secret. The job summary prints the digest.
2. **Digest.** Paste that digest into `values/ledger.stadtstack.eu.yaml`. The empty default is intentional: neither rendering nor the script can proceed without `sha256:` plus 64 lowercase hex characters.
3. **Privy app client.** In the Privy dashboard (App settings > Clients > Add app client, web), create a client whose Allowed Origins is only `https://ledger.stadtstack.eu`, and set its id as the repository variable `NEXT_PUBLIC_PRIVY_CLIENT_ID`. A client keeps the same users as the development app; Privy has no API for this, so it is a dashboard step. Fill the private Secret file outside this repository.
4. **DNS is DONE.** `ledger` A → `77.42.11.9` was created 30 Sep 2026 and resolves to the public ingress load balancer. No AAAA; the apex address must not be copied. No CAA blocks Let's Encrypt.
5. **SQLite acceptance.** There is no backup or restore test, and this volume holds account identifiers, selected cities and test tenancy records. The owner's production model is PostgreSQL with backups. Keep this small; do not call it production.

## Order

Every external change requires the owner's approval. Nothing here was applied by the assistant.

1. DNS is done. Privy: `https://ledger.stadtstack.eu` is in the app's own Allowed Origins (30 Sep; the wallet iframe's `frame-ancestors` lists it), so no app client id is needed.
2. The image comes from `.github/workflows/image.yml`, run by pushing a tag `image-*` on a commit whose CI passed. Make the package public once, then paste the digest from the job summary into `deploy/values/ledger.stadtstack.eu.yaml`, commit and push.
3. In `strausberg-zk-residency`, stop the Freelens viewer (the session uses the same daily WireGuard identity), set the acknowledgement once, and run the wrapper. No sudo is needed:

   ```bash
   infra/hetzner-talos/scripts/open-freelens-filtered-viewer.sh stop
   export LIVE_LEDGER_OF_LIFE_ACK=release-ledger-of-life-through-deploy-apply-only-v1
   infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh --namespace          # first run only
   infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh --secret ~/ledger-env.local
   infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh --release            # shows the diff, then asks
   infra/hetzner-talos/scripts/open-freelens-filtered-viewer.sh start --manual-stop
   ```

   The wrapper runs only the pushed commit's `deploy/` tree and refuses any cluster but the reviewed one (kube-system UID `7bc769bc-e860-4d54-a0d5-d426f3a52420`). It refuses to start while another rootless tunnel runs and checks again just before applying, but the Freelens viewer does not take its shared lock yet, so **do not start the viewer until the wrapper has finished**: two tunnels on the same identity make both unreliable. `--release` waits up to 180 seconds for the rollout and up to 2 minutes for the certificate; if the certificate is still pending it says so and exits successfully, because the release itself is up.

Prerequisites: helmfile, Helm, the Helm diff plugin, kubectl, curl and Python 3. `KUBECTL` overrides the kubectl binary (for example `$HOME/.local/bin/kubectl-v1.36.0`). Secret checks fetch only `.data` key names, never values. Rendering happens before any cluster write, so missing digest stops safely.

## Check afterwards

- `kubectl -n ledger-of-life rollout status deploy/ledger-of-life`, then `get certificate` until Ready.
- Public `/api/status` reports `storeAvailable: true`, `persistence: local-sqlite`.
- `/welcome/strausberg` loads without third-party requests. `/` contacts Privy and WalletConnect by design (ADR 0012).
- `kubectl -n ledger-of-life get jobs` shows completed reconcile jobs about every minute.
- Localhost passkeys cannot be used on this domain (WebAuthn domain scoping).

## Roll back

- `helm history ledger-of-life -n ledger-of-life`, then `helm rollback ledger-of-life <revision> -n ledger-of-life`. Recreate means a short outage. Also restore the desired digest in the values file before the next helmfile apply. A failed atomic release rolls back automatically; database schema/data changes are not reversed by Helm.
- `helm uninstall ledger-of-life -n ledger-of-life` removes release resources but **keeps the namespace and PVC**. Inspect retained data and ownership before reinstalling. Namespace/PVC deletion is a separate, explicit decision; the example StorageClass says Retain, so the underlying Hetzner volume may remain billed until removed manually. Remove DNS separately if decommissioning.

## Offline verification and limits

The old Kustomize render (11 objects) and Helm render (10 plus the external Namespace) were compared semantically using a test digest: every field matches after removing only standard Helm metadata and the PVC keep annotation. Strict kubeconform Kubernetes 1.36 validation, both Pod Security restricted pod-spec checks, Bash syntax and ShellCheck were run offline. Missing digest rendering refuses deployment. The prior readiness command smoke covered an available store (exit 0), unavailable store (exit 1) and closed port (exit 1); the command is unchanged.

## Not verified

- **What the first release proved (30 September).** The wrapper's `--namespace`, `--secret` and `--release` modes against the live cluster; certificate issuance through the HTTP-01 solver policy; public readiness. The claim bound and the Hetzner volume attached (after one transient `FailedMount` while the device appeared), and the store opens on it as uid 1000, so `fsGroup` works: opening runs `CREATE TABLE`, and `/api/status` answers `storeAvailable: true`. A reconcile job completes every minute, and `scripts/reconcile.mjs` fails on any non-2xx answer, so the Secret, in-cluster DNS and the reconcile-to-web path work. Rollback was not exercised.
- **NetworkPolicy enforcement.** The `kube-flannel` pods run a `kube-network-policies` container, which Talos documents as what makes Flannel enforce policy. Enforcement was not probed. Unenforced policies would be accepted and ignored.
- **The HAProxy source addresses.** The site answers through the ingress, so there is no 504. That holds whether the addresses are right or policies are not enforced; probing enforcement tells the two apart.
- **The project atlas.** `STADTSTACK_ATLAS_URL` is unset, so it defaults to `localhost:4317`, which does not exist in a pod. City choice and the bundled city snapshots still work, and Places says the atlas is unavailable. Deploying the atlas, or setting that variable, is separate work.
- **Resource sizes** (request 192 Mi, limit 768 Mi) come from about 120 MB idle in Docker. They were not load tested.
- **No GPU path.** `LOCAL_AI_OLLAMA_URL` is unset, so the paid AI desk reports itself unconfigured. See `docs/DEPLOYMENT.md`, "The GPU".
