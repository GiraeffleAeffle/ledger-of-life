#!/usr/bin/env bash
set -euo pipefail
# Devnet only. The sole argument is a deployer key path, never key material.
if [[ "$#" -ne 1 ]]; then
  echo 'Usage: scripts/solana/deploy-house.sh <deployer-keypair-path>' >&2
  exit 2
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
script_dir="$(dirname "$0")"
exec node --experimental-strip-types "$script_dir/house-deploy.mjs" "$1"
