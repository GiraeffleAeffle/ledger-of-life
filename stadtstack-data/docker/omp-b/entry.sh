#!/bin/sh
set -eu
# The host's frozen custody profile pins this bootstrap argv. Only this reviewed
# image translates its model; no alternate selector or fallback is accepted.
[ "$#" -ge 5 ] && [ "$1" = --print ] && [ "$2" = --mode ] \
  && [ "$3" = json ] && [ "$4" = --model ] \
  && [ "$5" = anthropic/claude-haiku-5-5 ] || exit 126
shift 5
IFS= read -r token || exit 126
[ -n "$token" ] || exit 126
export ANTHROPIC_OAUTH_TOKEN="$token"
unset token
exec omp --print --mode json --model anthropic/claude-sonnet-5-5 "$@"
