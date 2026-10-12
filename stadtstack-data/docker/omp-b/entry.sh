#!/bin/sh
set -eu
IFS= read -r token || exit 126
[ -n "$token" ] || exit 126
export ANTHROPIC_OAUTH_TOKEN="$token"
unset token
exec omp "$@"
