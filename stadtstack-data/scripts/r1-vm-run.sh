#!/bin/sh
# A bounded invocation, never a daemon or automatic authorization renewal.
# SECONDS is the OS hard deadline for the whole process. The executor's own job budget
# (--max-seconds) ends cleanup_seconds earlier so an aborted job can close its managed
# source scope (each shared-inventory load/save takes seconds) before TERM/KILL; a KILL
# mid-save would leave inventory.lock and uncertain leases behind.
# Each invocation needs its own authorization. Provider concurrency defaults to 1;
# pass --codex-concurrency / --omp-b-concurrency or set R1_CODEX_CONCURRENCY /
# R1_OMP_B_CONCURRENCY identically for the concurrent cohort (range 1..64).
set -eu
cleanup_seconds=120
seconds=${1-}
case "$seconds" in ''|*[!0-9]*) printf '%s\n' 'Usage: r1-vm-run.sh SECONDS --authorization-id UUID --max-jobs N [--mode attended --owner-present | --mode bounded_unattended]' >&2; exit 2;; esac
if [ "${#seconds}" -gt 5 ] || [ "$seconds" -le "$cleanup_seconds" ] || [ "$seconds" -gt 86400 ]; then
  printf '%s\n' "Executor walltime must be $((cleanup_seconds + 1))..86400 seconds (includes ${cleanup_seconds}s cleanup reserve)." >&2
  exit 2
fi
shift
if [ ! -x /usr/bin/timeout ]; then
  printf '%s\n' 'GNU timeout is required; no unbounded fallback.' >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
node=$(command -v node) || { printf '%s\n' 'node is required on PATH.' >&2; exit 2; }
exec /usr/bin/timeout --signal=TERM --kill-after=10s "${seconds}s" "$node" --experimental-strip-types "$root/src/district-r1.ts" run --max-seconds "$((seconds - cleanup_seconds))" "$@"
