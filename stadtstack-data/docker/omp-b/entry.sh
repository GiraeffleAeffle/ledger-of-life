#!/bin/sh
set -eu
# The host's frozen custody profile pins this bootstrap argv. Only this reviewed
# image translates model and thinking; no alternate bootstrap or fallback exists.
[ "$#" -ge 7 ] && [ "$1" = --print ] && [ "$2" = --mode ] \
  && [ "$3" = json ] && [ "$4" = --model ] \
  && [ "$5" = anthropic/claude-haiku-5-5 ] && [ "$6" = --thinking ] \
  && [ "$7" = off ] || exit 126
shift 7
IFS= read -r token || exit 126
[ -n "$token" ] || exit 126
export ANTHROPIC_OAUTH_TOKEN="$token"
unset token
exec omp --print --mode json --model anthropic/claude-sonnet-5-5 --thinking medium "$@"
