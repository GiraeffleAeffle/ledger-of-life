#!/usr/bin/env bash
# Bounded release of Ledger of Life to the reviewed Talos cluster. On the owner's machine it runs inside
# strausberg-zk-residency's infra/hetzner-talos/scripts/apply-live-ledger-of-life.sh, which opens the session.
#
#   deploy/apply.sh --diff-only      read-only: what would change, and whether the Secret exists
#   deploy/apply.sh --namespace      first run only: create the namespace (so the Secret can be stored), nothing else
#   deploy/apply.sh --secret FILE    store Secret ledger-env from an owner-only KEY=VALUE file outside any repository
#   deploy/apply.sh --network-test   run the released NetworkPolicy probe Pods (helm test)
#   deploy/apply.sh                  the release: diff, typed confirmation, helmfile apply, rollout and status
#
# Every mode refuses a render without a real image digest and any cluster but the reviewed one. One kube context is
# resolved at the start and passed explicitly to every kubectl and helmfile call, so the cluster that was checked is
# the cluster that is changed. Nothing here reads back, decodes or prints a Secret value.
set -euo pipefail

# Connection overrides can redirect Helm away from the context kubectl verifies.
# Refuse even empty exported values before invoking any external command.
for override in HELM_KUBEAPISERVER HELM_KUBECAFILE HELM_KUBETOKEN \
  HELM_KUBEASUSER HELM_KUBEASGROUPS HELM_KUBEINSECURE_SKIP_TLS_VERIFY HELM_KUBETLS_SERVER_NAME; do
  if [[ "${!override+x}" == x ]]; then
    printf 'Refusing connection override %s; unset it before running.\n' "$override" >&2
    exit 1
  fi
done

usage() { printf 'Usage: deploy/apply.sh [--diff-only | --namespace | --secret FILE | --network-test]\n' >&2; }
mode='release'
secret_file=''
case "${1:-}" in
  "") ;;
  --diff-only) mode='diff' ;;
  --namespace) mode='namespace' ;;
  --network-test) mode='network-test' ;;
  --secret) mode='secret'; secret_file="${2:-}"; [[ -n "$secret_file" ]] || { usage; exit 2; } ;;
  *) usage; exit 2 ;;
esac
if [[ "$mode" == secret ]]; then (( $# == 2 )) || { usage; exit 2; }; elif (( $# > 1 )); then usage; exit 2; fi
# Resolve the Secret file's directory before the script changes directory. The file itself is opened exactly once,
# later, without following links.
if [[ -n "$secret_file" ]]; then
  secret_parent="$(cd -- "$(dirname -- "$secret_file")" 2>/dev/null && pwd -P)" || { printf 'Secret file directory not found: %s\n' "$secret_file" >&2; exit 1; }
  secret_file="${secret_parent}/$(basename -- "$secret_file")"
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"
KUBECTL="${KUBECTL:-kubectl}"
NAMESPACE=ledger-of-life
for binary in helmfile helm "$KUBECTL" curl python3; do
  command -v "$binary" >/dev/null || { printf 'Required binary missing: %s\n' "$binary" >&2; exit 1; }
done
if ! [[ "$(helm plugin list)" =~ (^|$'\n')diff[[:space:]] ]]; then
  printf 'Install the Helm diff plugin before proceeding.\n' >&2
  exit 1
fi

# 1. Render first: this is the missing-digest refusal, and it needs no cluster.
helmfile -f helmfile.yaml template >/dev/null

# 2. One context for everything. Helm and helmfile have their own context overrides; refuse any that disagree.
context="$("$KUBECTL" config current-context)"
[[ -n "$context" ]] || { printf 'No current kube context.\n' >&2; exit 1; }
for override in HELM_KUBECONTEXT HELMFILE_KUBE_CONTEXT; do
  if [[ -n "${!override:-}" && "${!override}" != "$context" ]]; then
    printf '%s is %s but kubectl uses %s; unset it or switch contexts.\n' "$override" "${!override}" "$context" >&2
    exit 1
  fi
done
kc() { "$KUBECTL" --context "$context" "$@"; }
hf() { helmfile --kube-context "$context" -f helmfile.yaml "$@"; }
server="$(kc config view --minify -o jsonpath='{.clusters[0].cluster.server}')"

# 3. The reviewed cluster only.
expected_uid=7bc769bc-e860-4d54-a0d5-d426f3a52420
actual_uid="$(kc get namespace kube-system -o jsonpath='{.metadata.uid}')"
if [[ "$actual_uid" != "$expected_uid" ]]; then
  printf 'Wrong cluster: kube-system UID does not match the reviewed Talos cluster (context %s).\n' "$context" >&2
  exit 1
fi
printf 'Cluster: context %s, API %s, kube-system UID verified.\n' "$context" "$server"

confirm() {
  printf 'Target: context %s, API %s, namespace %s.\n' "$context" "$server" "$NAMESPACE" >/dev/tty
  printf 'Type exactly "%s" to continue: ' "$1" >/dev/tty
  local answer
  IFS= read -r answer </dev/tty
  [[ "$answer" == "$1" ]] || { printf 'Confirmation did not match; nothing changed.\n' >&2; exit 1; }
}

# A preview must succeed: kubectl diff exits 0 (no change) or 1 (changes); anything else is an error, not a preview.
preview_namespace() {
  local status=0
  kc diff --server-side --field-manager=ledger-apply -f namespace.yaml || status=$?
  (( status <= 1 )) || { printf 'The namespace preview failed (kubectl diff exit %s); nothing changed.\n' "$status" >&2; exit 1; }
}

namespace_exists=false
kc get namespace "$NAMESPACE" >/dev/null 2>&1 && namespace_exists=true

if [[ "$mode" == namespace ]]; then
  preview_namespace
  confirm "create namespace $NAMESPACE"
  kc apply --server-side --field-manager=ledger-apply -f namespace.yaml
  printf 'Next: store the Secret with --secret FILE (see ledger-env.example), then run --diff-only.\n'
  exit 0
fi

if [[ "$mode" == secret ]]; then
  "$namespace_exists" || { printf 'Namespace %s does not exist yet. First run: --namespace\n' "$NAMESPACE" >&2; exit 1; }
  if git -C "$secret_parent" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'Secret file is inside a git work tree; keep it outside every repository.\n' >&2; exit 1
  fi
  # Open the file once without following links, check the open file (regular, yours, one link, mode 0600 or
  # stricter), validate those bytes and copy exactly them into a private snapshot. Only the snapshot reaches kubectl,
  # so the file cannot be swapped between the checks, the confirmation and the upload.
  snapshot_dir="$(mktemp -d "${TMPDIR:-/tmp}/ledger-secret.XXXXXX")"
  chmod 700 "$snapshot_dir"
  trap 'rm -rf -- "$snapshot_dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  status=0
  keys="$(python3 - "$secret_file" "$snapshot_dir/env" <<'PY'
import os, stat, sys
source, target = sys.argv[1], sys.argv[2]
try:
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
except OSError:
    raise SystemExit(2)
try:
    details = os.fstat(fd)
    if (not stat.S_ISREG(details.st_mode) or details.st_uid != os.getuid() or details.st_nlink != 1
            or stat.S_IMODE(details.st_mode) & 0o077):
        raise SystemExit(3)
    data = b''
    while chunk := os.read(fd, 65536):
        data += chunk
        if len(data) > 65536:
            raise SystemExit(4)
finally:
    os.close(fd)
values = {}
for line in data.decode('utf-8').splitlines():
    if not line.strip() or line.lstrip().startswith('#'):
        continue
    if '=' not in line:
        raise SystemExit(4)
    key, value = line.split('=', 1)
    values[key] = value
if not values.get('PRIVY_APP_SECRET') or not values.get('RECONCILE_SECRET'):
    raise SystemExit(5)
out = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(out, 'wb') as handle:
    handle.write(data)
print(' '.join(sorted(values)))
PY
)" || status=$?
  case "$status" in
    0) ;;
    2) printf 'Secret file cannot be opened, or it is a link.\n' >&2; exit 1 ;;
    3) printf 'Secret file must be a regular file with one link, owned by you and readable only by you (chmod 600).\n' >&2; exit 1 ;;
    5) printf 'Secret file needs values for PRIVY_APP_SECRET and RECONCILE_SECRET.\n' >&2; exit 1 ;;
    *) printf 'Secret file must hold KEY=VALUE lines (comments allowed) and stay under 64 KB.\n' >&2; exit 1 ;;
  esac
  printf 'Secret ledger-env will hold these keys: %s\n' "$keys"
  printf 'This replaces the whole Secret. If Deployment ledger-of-life exists, it will restart and wait for readiness (up to 180 seconds).\n' >/dev/tty
  confirm "store secret ledger-env"
  # The rendered Secret goes through a pipe from kubectl to kubectl; it is never printed.
  kc -n "$NAMESPACE" create secret generic ledger-env --from-env-file="$snapshot_dir/env" --dry-run=client -o yaml |
    kc apply --server-side --field-manager=ledger-apply -f -
  deployment="$(kc -n "$NAMESPACE" get deployment ledger-of-life --ignore-not-found -o name)"
  if [[ -n "$deployment" ]]; then
    kc -n "$NAMESPACE" rollout restart deployment/ledger-of-life
    kc -n "$NAMESPACE" rollout status deployment/ledger-of-life --timeout=180s
  fi
  printf 'Next: --diff-only, then the release.\n'
  exit 0
fi

if [[ "$mode" == network-test ]]; then
  "$namespace_exists" || { printf 'Namespace %s does not exist yet; release first.\n' "$NAMESPACE" >&2; exit 1; }
  # Show the deployed hooks, not the checkout's render. They contain no Secret values.
  hooks="$(helm --kube-context "$context" -n "$NAMESPACE" get hooks ledger-of-life)" ||
    { printf 'Release ledger-of-life is not deployed; run the release first.\n' >&2; exit 1; }
  grep -q 'name: ledger-of-life-netpol-2-isolated' <<<"$hooks" ||
    { printf 'The deployed revision has no network probe; release this commit first.\n' >&2; exit 1; }
  printf '%s\n' "$hooks"
  confirm "test network policies in $NAMESPACE"
  helm --kube-context "$context" -n "$NAMESPACE" test ledger-of-life --logs --timeout 3m
  exit 0
fi

# 4. The Secret must exist before a release: without it the pod never starts and the atomic release rolls back.
secret_ready=false
if "$namespace_exists"; then
  # Key NAMES only. Go-template variables belong to kubectl, not the shell.
  # shellcheck disable=SC2016
  keys="$(kc -n "$NAMESPACE" get secret ledger-env -o go-template='{{range $key, $value := .data}}{{printf "%s\n" $key}}{{end}}' 2>/dev/null)" || keys=""
  grep -qx PRIVY_APP_SECRET <<<"$keys" && grep -qx RECONCILE_SECRET <<<"$keys" && secret_ready=true
fi
secret_help() {
  if ! "$namespace_exists"; then
    printf 'Namespace %s does not exist yet. First run: deploy/apply.sh --namespace\n' "$NAMESPACE" >&2
  fi
  printf '%s\n' 'Secret ledger-env must contain PRIVY_APP_SECRET and RECONCILE_SECRET. Fill an owner-only file outside every repository (see ledger-env.example), then run --secret FILE.' >&2
}

# 5. Show exactly what would change.
if "$namespace_exists"; then
  preview_namespace
fi
hf diff --include-tests

if [[ "$mode" == diff ]]; then
  "$secret_ready" || secret_help
  exit 0
fi
"$secret_ready" || { secret_help; exit 1; }

# 6. The release, after a typed confirmation.
confirm "apply $NAMESPACE"
kc apply --server-side --field-manager=ledger-apply -f namespace.yaml
hf apply --include-tests
kc -n "$NAMESPACE" rollout status deployment/ledger-of-life --timeout=180s

# 7. The first certificate can take a minute or two. A release that is up but still waiting for it is not a failure.
host="$(kc -n "$NAMESPACE" get ingress ledger-of-life -o jsonpath='{.spec.rules[0].host}')"
tls_secret="$(kc -n "$NAMESPACE" get ingress ledger-of-life -o jsonpath='{.spec.tls[0].secretName}')"
ready=''
for _ in $(seq 1 24); do
  ready="$(kc -n "$NAMESPACE" get certificate "$tls_secret" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  [[ "$ready" == True ]] && break
  sleep 5
done
if [[ "$ready" != True ]]; then
  printf 'Release is running; the certificate for %s is not ready yet. Check: kubectl -n %s describe certificate %s\n' "$host" "$NAMESPACE" "$tls_secret"
  exit 0
fi
curl --fail --silent --show-error "https://${host}/api/status" |
  python3 -c 'import json,sys; s=json.load(sys.stdin); print(json.dumps({k:s[k] for k in ("storeAvailable","persistence")}))'
