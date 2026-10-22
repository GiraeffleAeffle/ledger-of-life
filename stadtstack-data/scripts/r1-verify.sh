#!/usr/bin/env bash
# R1 step-5 coordinated verification: typecheck plus the full test suite against a
# disposable local PostgreSQL cluster (never production civic_r1). Uses an explicit
# CPU set; the disposable cluster is stopped and removed, including on failure.
# Usage: scripts/r1-verify.sh [typecheck|tests|all|candidate] [extra node --test args...]
#   tests/all run every source test; real retained staging is a mandatory exclusive phase.
#   candidate runs test/mcp-tools.test.ts against STADTSTACK_MCP_RELEASE_DIR, an actual
#   governed candidate release (never the historical tracked out/ snapshot).
set -euo pipefail
umask 022
mode=${1:-all}; shift || true
cd "$(dirname "$0")/.."
export PATH=/home/max/.local/share/mise/installs/node/24.22.1/bin:/usr/bin:/bin
PG_BIN=/usr/lib/postgresql/16/bin
log_root=${R1_VERIFY_LOG_ROOT:-$HOME/.local/state/stadtstack-data/r1-verify}
mkdir -p -m 0700 "$log_root"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
cpus=(taskset -c "${R1_VERIFY_CPUS:-0-3}" nice -n 10)

if [[ $mode == typecheck || $mode == all ]]; then
  "${cpus[@]}" node_modules/.bin/tsc --noEmit >"$log_root/tsc-$stamp.log" 2>&1 && echo "tsc=0" || { echo "tsc=failed log=$log_root/tsc-$stamp.log"; [[ $mode == all ]] || exit 1; }
fi
if [[ $mode == candidate ]]; then
  : "${STADTSTACK_MCP_RELEASE_DIR:?actual governed candidate release directory required}"
  status=0
  "${cpus[@]}" node --experimental-strip-types --test --test-concurrency=1 --test-reporter=tap "$@" test/mcp-tools.test.ts >"$log_root/candidate-$stamp.tap" 2>&1 || status=$?
  grep -E '^# (tests|pass|fail|skipped|cancelled|todo) ' "$log_root/candidate-$stamp.tap" || true
  echo "candidate_exit=$status log=$log_root/candidate-$stamp.tap"
  exit "$status"
fi
[[ $mode == tests || $mode == all ]] || exit 0
source_tests=()
integration_tests=(test/r1-step8-staging.test.ts)
for file in test/*.test.ts; do
  [[ $file == test/mcp-tools.test.ts || $file == "${integration_tests[0]}" ]] || source_tests+=("$file")
done

test_pg=$(mktemp -d /tmp/civic-r1-pg.XXXXXX)
cleanup() {
  "$PG_BIN/pg_ctl" -D "$test_pg/data" -m fast stop >/dev/null 2>&1 || true
  rm -rf -- "$test_pg"
}
trap cleanup EXIT
# Cancellation is not a failed ordinary test: never launch the exclusive phase.
trap 'exit 130' INT
trap 'exit 143' TERM
"$PG_BIN/initdb" -D "$test_pg/data" --auth-local=trust --auth-host=reject --no-locale >"$log_root/initdb-$stamp.log" 2>&1
"$PG_BIN/pg_ctl" -D "$test_pg/data" -l "$test_pg/postgres.log" -o "-h '' -k $test_pg -p 55432" -w start >/dev/null
export DISTRICT_TEST_DATABASE_URL="postgresql:///postgres?host=$test_pg&port=55432"
unset DATABASE_URL
source_status=0
"${cpus[@]}" node --experimental-strip-types --test --test-concurrency=2 --test-reporter=tap "$@" "${source_tests[@]}" >"$log_root/tests-$stamp.tap" 2>&1 || source_status=$?
grep -E '^# (tests|pass|fail|skipped|cancelled|todo) ' "$log_root/tests-$stamp.tap" || true
echo "tests_exit=$source_status log=$log_root/tests-$stamp.tap"
# The full19-member plan/publication/replay/handoff test is never concurrent with
# other test files and is never omitted, even when the ordinary phase fails.
integration_status=0
"${cpus[@]}" node --experimental-strip-types --test --test-concurrency=1 --test-reporter=tap "$@" "${integration_tests[@]}" >"$log_root/integration-$stamp.tap" 2>&1 || integration_status=$?
grep -E '^# (tests|pass|fail|skipped|cancelled|todo) ' "$log_root/integration-$stamp.tap" || true
echo "integration_exit=$integration_status log=$log_root/integration-$stamp.tap"
[[ $source_status == 0 ]] || exit "$source_status"
exit "$integration_status"
