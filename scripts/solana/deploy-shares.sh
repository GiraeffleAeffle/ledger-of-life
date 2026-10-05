#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 ]]; then
  printf '%s\n' 'Usage: scripts/solana/deploy-shares.sh /absolute/deployer-keypair.json' >&2
  exit 2
fi
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
exec node --experimental-strip-types scripts/solana/shares-deploy.mjs "$1" "$HOME/.config/solana/shares-program.json" "$HOME/.config/solana/shares-buffer.json"
