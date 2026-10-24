#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
# Use an allowlisted environment: no provider tokens, proxy settings, NODE_OPTIONS,
# model homes or external service credentials reach offline reconstruction.
exec env -i HOME="$HOME" PATH="$PATH" LANG="${LANG:-C.UTF-8}" TZ="${TZ:-UTC}" \
  DATABASE_URL="${DATABASE_URL:-}" \
  node --require ./scripts/r1-step8-offline.cjs --experimental-strip-types ./scripts/r1-step8.ts "$@"
