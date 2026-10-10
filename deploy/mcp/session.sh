#!/usr/bin/env bash

# Deploy protected civic MCP through the governed rootless cluster session.
# Keep the daily identity lock, pinned wireproxy, verified bootstrap recovery,
# loopback transport and temporary-credential cleanup unchanged.
# Only approved pushed deploy/mcp code is exported by deploy.py.
# Only namespace stadtstack-mcp is changed. Tokens remain hash-only in-cluster.
# --diff-only cannot dispatch a release.

set -euo pipefail
umask 077

script_dir="/Users/max/.cache/cluster-ops"
repo_root="/Users/max/Code/strausberg-zk-residency"
operator_root="${repo_root}/.secrets/hetzner-talos"
bundle_dir="${CURRENT_BOOTSTRAP_BUNDLE:-${operator_root}/bootstrap/20260716T2142Z-final-provisional}"
operator_age_identity="${OPERATOR_AGE_IDENTITY:-${operator_root}/age.key}"
wireproxy_bin="${STADTSTACK_WIREPROXY_BIN:-${HOME}/.local/bin/wireproxy-v1.1.3}"
wireproxy_sha256="${STADTSTACK_WIREPROXY_SHA256:-37889c2f0ea4a9f2f59fc1bfefc372b24ffc4e56e2e34a0188aabe3a4e8c1ec3}"
endpoints=('10.255.240.11' '10.255.240.12' '10.255.240.13')
node_names=('stadtstack-talos-cp-1' 'stadtstack-talos-cp-2' 'stadtstack-talos-cp-3')
public_ips=('95.217.232.29' '65.21.109.240' '204.168.149.174')
expected_ack='release-civic-mcp-through-governed-wrapper-v1'
# Shared with the Freelens supervisor; never derived from the caller's TMPDIR.
identity_lock=''

fail() {
  printf 'live ledger-of-life release: %s\n' "$1" >&2
  exit 1
}

# The guard serializes PID publication, stale reclamation and release. Keep it
# in place: unlinking a flock file would allow contenders to lock different inodes.
resolve_identity_lock() {
  [[ -z "${STADTSTACK_WIREGUARD_DAILY_LOCK+x}" ]] || fail 'STADTSTACK_WIREGUARD_DAILY_LOCK is not supported; the daily identity lock is canonical'
  if [[ "${STADTSTACK_WIREGUARD_LOCK_TEST_MODE:-}" == 1 ]]; then
    [[ "${STADTSTACK_WIREGUARD_DAILY_TEST_LOCK:-}" == /* ]] || fail 'test mode requires an absolute STADTSTACK_WIREGUARD_DAILY_TEST_LOCK'
    identity_lock="${STADTSTACK_WIREGUARD_DAILY_TEST_LOCK}"
  else
    [[ -z "${STADTSTACK_WIREGUARD_DAILY_TEST_LOCK+x}" ]] || fail 'test lock override requires STADTSTACK_WIREGUARD_LOCK_TEST_MODE=1'
    local user_temp
    user_temp="$(/usr/bin/getconf DARWIN_USER_TEMP_DIR)" || fail 'cannot resolve the canonical per-user temporary directory'
    [[ "${user_temp}" == /* ]] || fail 'canonical per-user temporary directory is invalid'
    identity_lock="${user_temp%/}/stadtstack-wireguard-daily.${UID}.lock"
  fi
}
identity_lock_operation() { python3 - "${identity_lock}" "$1" "$$" <<'PY'
from pathlib import Path
import errno, fcntl, os, stat, sys

lock = Path(sys.argv[1])
operation, own_pid = sys.argv[2], sys.argv[3]
def refuse(reason):
    raise SystemExit(f"daily WireGuard identity lock {lock}: {reason}")
def private(path, directory=False):
    s = path.lstat()
    if s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) & 0o077 or (
        not stat.S_ISDIR(s.st_mode) if directory else not stat.S_ISREG(s.st_mode) or s.st_nlink != 1
    ):
        refuse(f"unsafe ownership, mode or type: {path}")

private(lock.parent, directory=True)
fd = os.open(str(lock) + ".guard", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "r+") as guard:
    s = os.fstat(guard.fileno())
    if s.st_uid != os.getuid() or not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) & 0o077:
        refuse("unsafe reclamation guard")
    fcntl.flock(guard, fcntl.LOCK_EX)
    if lock.exists() or lock.is_symlink():
        private(lock, directory=True)
        try:
            private(lock / "pid")
            holder = (lock / "pid").read_text().strip()
        except FileNotFoundError:
            refuse("holder PID is missing; refusing to reclaim an unverified lock")
        if not holder.isascii() or not holder.isdecimal() or int(holder) < 1:
            refuse("holder PID is invalid; refusing to reclaim an unverified lock")
        if operation == "release":
            if holder != own_pid:
                refuse(f"held by PID {holder}, not releasing another session's lock")
        else:
            try:
                os.kill(int(holder), 0)
            except OSError as error:
                if error.errno != errno.ESRCH:
                    refuse(f"held by PID {holder} (alive or not signalable)")
            else:
                refuse(f"held by PID {holder}; wait for that session to end")
            if operation == "check":
                sys.exit(0)
        (lock / "pid").unlink()
        lock.rmdir()
    if operation == "acquire":
        lock.mkdir(mode=0o700)
        (lock / "pid").write_text(own_pid + "\n")
        (lock / "pid").chmod(0o600)
PY
}
acquire_identity_lock() {
  local reason
  reason="$(identity_lock_operation acquire 2>&1)" || fail "${reason}"
}
release_identity_lock() { identity_lock_operation release; }

resolve_identity_lock

usage() {
  cat <<'EOF'
Usage: mcp-session.sh --diff-only | --release

  --diff-only  Render the approved upgrade and server dry-run; change no resources.
  --release    Install/upgrade civic MCP; typed source approval required.

--release requires LIVE_MCP_ACK=release-civic-mcp-through-governed-wrapper-v1
and CLUSTER_OPS_MCP_GO=protected-read-only-civic-mcp.
Both require explicit MCP_RELEASE_REPO (canonical clean checkout),
MCP_APPROVED_SHA and MCP_IMAGE_DIGEST. No repository-path fallback is used.
Stop the filtered viewer first and restore it after this session cleans up.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

find_talosctl() {
  if [[ -n "${TALOSCTL:-}" ]]; then printf '%s\n' "${TALOSCTL}"; return; fi
  if [[ -x "${HOME}/.local/bin/talosctl-v1.13.2" ]]; then
    printf '%s\n' "${HOME}/.local/bin/talosctl-v1.13.2"; return
  fi
  command -v talosctl || true
}

find_kubectl() {
  if [[ -n "${KUBECTL:-}" ]]; then printf '%s\n' "${KUBECTL}"; return; fi
  if [[ -x "${HOME}/.local/bin/kubectl-v1.36.0" ]]; then
    printf '%s\n' "${HOME}/.local/bin/kubectl-v1.36.0"; return
  fi
  command -v kubectl || true
}

# The pinned-executable check of open-freelens-filtered-viewer.sh: regular file, not a link, yours, one link, not group
# or world writable, executable by you, and the pinned SHA-256.
assert_owned_executable_digest() { python3 - "$1" "$2" <<'PY'
from pathlib import Path
import hashlib, os, stat, sys
p=Path(sys.argv[1]); expected=sys.argv[2]
try: s=p.lstat()
except FileNotFoundError: raise SystemExit(1)
if p.is_symlink() or not p.is_file() or s.st_uid != os.getuid() or s.st_nlink != 1:
    raise SystemExit(1)
mode=stat.S_IMODE(s.st_mode)
if mode & 0o022 or not mode & stat.S_IXUSR:
    raise SystemExit(1)
observed=hashlib.sha256(p.read_bytes()).hexdigest()
if observed != expected:
    raise SystemExit(1)
PY
}

other_wireproxy_running() {
  local pid
  while IFS= read -r pid; do
    [[ -n "${pid}" && "${pid}" != "${proxy_pid:-}" ]] && return 0
  done < <(pgrep -f 'wireproxy' || true)
  return 1
}

mode="${1:-}"
case "${mode}" in
  --diff-only|--release) [[ "$#" -eq 1 ]] || { usage >&2; exit 2; } ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
if [[ "${mode}" != '--diff-only' ]]; then
  [[ "${LIVE_MCP_ACK:-}" == "${expected_ack}" ]] ||
    fail "set LIVE_MCP_ACK=${expected_ack}"
fi
[[ -t 0 ]] || fail 'run it from an interactive terminal; changes need typed confirmations'

for command_name in age git helm nc pgrep python3 tar; do require_command "${command_name}"; done
: "${MCP_RELEASE_REPO:?Explicit isolated release checkout required}"
release_repo="${MCP_RELEASE_REPO}"
[[ "${release_repo}" == /* && -d "${release_repo}" && ! -L "${release_repo}" ]] ||
  fail 'release repository must be an absolute non-symlink checkout'
[[ "$(git -C "${release_repo}" rev-parse --show-toplevel)" == "${release_repo}" ]] ||
  fail 'release repository must be its canonical Git worktree root'
[[ -z "$(git -C "${release_repo}" status --porcelain --untracked-files=no)" ]] ||
  fail 'release checkout has tracked modifications; use a fresh clone'
[[ "${wireproxy_sha256}" =~ ^[0-9a-f]{64}$ ]] || fail 'rootless wireproxy checksum is invalid'
assert_owned_executable_digest "${wireproxy_bin}" "${wireproxy_sha256}" ||
  fail 'pinned rootless wireproxy is unavailable or differs'
talosctl_bin="$(find_talosctl)"
kubectl_bin="$(find_kubectl)"
[[ -x "${talosctl_bin}" && -x "${kubectl_bin}" ]] || fail 'pinned talosctl or kubectl is unavailable'
[[ "$("${talosctl_bin}" version --client --short 2>&1)" == *'Talos v1.13.2'* ]] || fail 'talosctl is not v1.13.2'
[[ "$("${kubectl_bin}" version --client -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["clientVersion"]["gitVersion"])')" == 'v1.36.0' ]] ||
  fail 'kubectl is not v1.36.0'

for input in \
  "${bundle_dir}" \
  "${operator_age_identity}" \
  "${bundle_dir}/wireguard-daily.conf.age" \
  "${bundle_dir}/talosconfig.yaml.age" \
  "${script_dir}/verify-live-bootstrap-bundle.sh"; do
  [[ -e "${input}" && ! -L "${input}" ]] ||
    fail "required operator input is missing or linked: ${input}"
done

if ! python3 - "${operator_age_identity}" <<'PY'
from pathlib import Path
import os
import stat
import sys
path = Path(sys.argv[1])
details = path.stat()
if (
    not path.is_file()
    or path.is_symlink()
    or details.st_uid != os.getuid()
    or details.st_nlink != 1
    or stat.S_IMODE(details.st_mode) & 0o077
):
    raise SystemExit(1)
PY
then
  fail 'operator age identity ownership or permissions differ'
fi

"${script_dir}/verify-live-bootstrap-bundle.sh" \
  --require-valid-recovery "${bundle_dir}" >/dev/null ||
  fail 'bootstrap bundle lacks the verified recovery posture'

for public_ip in "${public_ips[@]}"; do
  for port in 50000 6443; do
    if nc -G 1 -z "${public_ip}" "${port}" >/dev/null 2>&1; then
      fail "public management port is unexpectedly open: ${public_ip}:${port}"
    fi
  done
done

# The daily identity lock also serializes releases; a separate TMPDIR-based
# release lock would split ownership across caller environments.
tmp_dir=''
proxy_pid=''
identity_lock_held=false
cleanup() {
  status="$?"
  trap - EXIT INT TERM
  if [[ -n "${proxy_pid}" ]]; then
    kill "${proxy_pid}" >/dev/null 2>&1 || true
    wait "${proxy_pid}" >/dev/null 2>&1 || true
  fi
  [[ -z "${tmp_dir}" ]] || /bin/rm -rf -- "${tmp_dir}"
  [[ "${identity_lock_held}" == false ]] || release_identity_lock
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

acquire_identity_lock; identity_lock_held=true
# Defence in depth for tunnels started by scripts that do not take this lock.
other_wireproxy_running &&
  fail 'another rootless WireGuard session is running; stop it first: infra/hetzner-talos/scripts/open-freelens-filtered-viewer.sh stop'
tmp_dir="$(mktemp -d "${TMPDIR:-/private/tmp}/stadtstack-live-ledger-of-life.XXXXXX")"
chmod 700 "${tmp_dir}"

# Run only a private, re-verified copy of the pinned wireproxy.
cp "${wireproxy_bin}" "${tmp_dir}/wireproxy"
chmod 500 "${tmp_dir}/wireproxy"
assert_owned_executable_digest "${tmp_dir}/wireproxy" "${wireproxy_sha256}" ||
  fail 'the private wireproxy copy differs from its checksum'

proxy_port="$(python3 - <<'PY'
import socket
with socket.socket() as value:
    value.bind(("127.0.0.1", 0))
    print(value.getsockname()[1])
PY
)"

age --decrypt --identity "${operator_age_identity}" \
  "${bundle_dir}/wireguard-daily.conf.age" >"${tmp_dir}/wireguard.conf" ||
  fail 'daily WireGuard configuration could not be decrypted'
age --decrypt --identity "${operator_age_identity}" \
  "${bundle_dir}/talosconfig.yaml.age" >"${tmp_dir}/talosconfig" ||
  fail 'daily talosconfig could not be decrypted'
chmod 600 "${tmp_dir}/wireguard.conf" "${tmp_dir}/talosconfig"
printf 'WGConfig = %s\n\n[http]\nBindAddress = 127.0.0.1:%s\n' \
  "${tmp_dir}/wireguard.conf" "${proxy_port}" >"${tmp_dir}/wireproxy.conf"
"${tmp_dir}/wireproxy" -n -c "${tmp_dir}/wireproxy.conf" >/dev/null ||
  fail 'rootless WireGuard proxy configuration differs'
"${tmp_dir}/wireproxy" -s -c "${tmp_dir}/wireproxy.conf" \
  >"${tmp_dir}/wireproxy.log" 2>&1 &
proxy_pid="$!"
for _ in $(seq 1 30); do
  nc -G 1 -z 127.0.0.1 "${proxy_port}" >/dev/null 2>&1 && break
  kill -0 "${proxy_pid}" >/dev/null 2>&1 ||
    fail 'rootless WireGuard proxy exited'
  sleep 1
done
nc -G 1 -z 127.0.0.1 "${proxy_port}" >/dev/null 2>&1 ||
  fail 'rootless WireGuard proxy did not become ready'
rootless_proxy="http://127.0.0.1:${proxy_port}"

for index in 0 1 2; do
  HTTPS_PROXY="${rootless_proxy}" NO_PROXY='' "${talosctl_bin}" \
    --talosconfig "${tmp_dir}/talosconfig" \
    --endpoints "${endpoints[$index]}" --nodes "${endpoints[$index]}" \
    version >/dev/null ||
    fail "Talos access failed at ${node_names[$index]}"
done
HTTPS_PROXY="${rootless_proxy}" NO_PROXY='' "${talosctl_bin}" \
  --talosconfig "${tmp_dir}/talosconfig" \
  --endpoints "${endpoints[0]}" --nodes "${endpoints[0]}" \
  kubeconfig "${tmp_dir}/kubeconfig" --force --merge=false >/dev/null ||
  fail 'kubeconfig generation failed'
chmod 600 "${tmp_dir}/kubeconfig"
cluster_name="$("${kubectl_bin}" --kubeconfig "${tmp_dir}/kubeconfig" \
  config view -o jsonpath='{.contexts[0].context.cluster}')"
# The proxy is set in the kubeconfig itself, so kubectl, Helm and helm-diff all use the tunnel, while the final public
# status check in deploy/apply.sh goes straight to the internet.
"${kubectl_bin}" --kubeconfig "${tmp_dir}/kubeconfig" config set-cluster \
  "${cluster_name}" --server="https://${endpoints[0]}:6443" \
  --proxy-url="${rootless_proxy}" >/dev/null
[[ "$("${kubectl_bin}" --kubeconfig "${tmp_dir}/kubeconfig" \
  --request-timeout=10s get --raw=/readyz)" == ok ]] ||
  fail 'Kubernetes API is not ready'

# A tunnel started meanwhile by a script that does not take the identity lock would make this one flap.
other_wireproxy_running &&
  fail 'another rootless WireGuard session started meanwhile; stop it and run again'

export KUBECONFIG="${tmp_dir}/kubeconfig" KUBECTL="${kubectl_bin}"
export MCP_RELEASE_MODE="${mode}"
: "${MCP_IMAGE_DIGEST:?Explicit approved immutable image digest required}"
: "${MCP_APPROVED_SHA:?Explicit approved pushed source required}"
[[ "${MCP_APPROVED_SHA}" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid approved source revision'
git -C "${release_repo}" show "${MCP_APPROVED_SHA}:deploy/mcp/deploy.py" >"${tmp_dir}/deploy.py"
python3 "${tmp_dir}/deploy.py"
