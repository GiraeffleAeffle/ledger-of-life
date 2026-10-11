#!/bin/sh
# A bounded invocation, never a daemon or automatic authorization renewal.
set -eu
seconds=${1-}
case "$seconds" in ''|*[!0-9]*) printf '%s\n' 'Usage: r1-vm-run.sh SECONDS --authorization-id UUID --max-jobs N [--mode attended --owner-present | --mode bounded_unattended]' >&2; exit 2;; esac
if [ "${#seconds}" -gt 5 ] || [ "$seconds" -lt 1 ] || [ "$seconds" -gt 86400 ]; then
  printf '%s\n' 'Executor walltime must be 1..86400 seconds.' >&2
  exit 2
fi
shift
if [ ! -x /usr/bin/timeout ]; then
  printf '%s\n' 'GNU timeout is required; no unbounded fallback.' >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
node=$(command -v node)
exec /usr/bin/timeout --signal=TERM --kill-after=5s "${seconds}s" "$node" --experimental-strip-types "$root/src/district-r1.ts" run --max-seconds "$seconds" "$@"
