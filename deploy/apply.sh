#!/usr/bin/env bash
# Bounded release of Ledger of Life to the reviewed Talos cluster. Run it in the owner's admin session.
#
#   deploy/apply.sh --diff-only   read-only: what would change, and whether the Secret exists
#   deploy/apply.sh --namespace   first run only: create the namespace (so the Secret can be created), nothing else
#   deploy/apply.sh               the release: diff, typed confirmation, helmfile apply, rollout and status
#
# Every mode refuses a render without a real image digest and any cluster but the reviewed one. One kube context is
# resolved at the start and passed explicitly to every kubectl and helmfile call, so the cluster that was checked is
# the cluster that is changed. Nothing here reads, decodes or prints a Secret value.
set -euo pipefail

usage() { printf 'Usage: deploy/apply.sh [--diff-only | --namespace]\n' >&2; }
mode='release'
case "${1:-}" in
  "") ;;
  --diff-only) mode='diff' ;;
  --namespace) mode='namespace' ;;
  *) usage; exit 2 ;;
esac
if (( $# > 1 )); then usage; exit 2; fi

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

namespace_exists=false
kc get namespace "$NAMESPACE" >/dev/null 2>&1 && namespace_exists=true

if [[ "$mode" == namespace ]]; then
  kc diff --server-side --field-manager=ledger-apply -f namespace.yaml || true
  confirm "create namespace $NAMESPACE"
  kc apply --server-side --field-manager=ledger-apply -f namespace.yaml
  printf 'Now create the Secret (see ledger-env.example), then run deploy/apply.sh --diff-only.\n'
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
  printf '%s\n' 'Secret ledger-env must contain PRIVY_APP_SECRET and RECONCILE_SECRET. Fill a file outside the repository, then run:' >&2
  # Printed literally, without expanding the operator's HOME.
  # shellcheck disable=SC2016
  printf '%s\n' '  kubectl create secret generic ledger-env --namespace ledger-of-life --from-env-file="$HOME/ledger-env.local"' >&2
}

# 5. Show exactly what would change.
if "$namespace_exists"; then
  kc diff --server-side --field-manager=ledger-apply -f namespace.yaml || true
fi
hf diff

if [[ "$mode" == diff ]]; then
  "$secret_ready" || secret_help
  exit 0
fi
"$secret_ready" || { secret_help; exit 1; }

# 6. The release, after a typed confirmation.
confirm "apply $NAMESPACE"
kc apply --server-side --field-manager=ledger-apply -f namespace.yaml
hf apply
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
