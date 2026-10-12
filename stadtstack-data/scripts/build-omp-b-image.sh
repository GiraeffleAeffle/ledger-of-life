#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OMP=${OMP_BINARY:-/home/max/.local/bin/omp}
DOCKER=${DOCKER_BINARY:-/usr/bin/docker}
[ -x "$OMP" ] || { printf '%s\n' 'Pinned omp binary unavailable' >&2; exit 2; }
[ -x "$DOCKER" ] || { printf '%s\n' 'Docker binary unavailable' >&2; exit 2; }
EXPECTED=$(sha256sum "$OMP" | cut -d ' ' -f 1)
VERSION=$("$OMP" --version)
[ "$VERSION" = 'omp/18.9.2' ] || { printf '%s\n' 'Pinned omp version mismatch' >&2; exit 2; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
cp "$ROOT/docker/omp-b/Dockerfile" "$TMP/Dockerfile"
cp "$ROOT/docker/omp-b/settings.yml" "$TMP/settings.yml"
cp "$ROOT/docker/omp-b/entry.sh" "$TMP/entry.sh"
cp "$OMP" "$TMP/omp"
chmod 0555 "$TMP/omp" "$TMP/entry.sh"
ACTUAL=$(sha256sum "$TMP/omp" | cut -d ' ' -f 1)
[ "$EXPECTED" = "$ACTUAL" ] || { printf '%s\n' 'omp binary changed during image preparation' >&2; exit 2; }
"$DOCKER" build --pull=false --file "$TMP/Dockerfile" --tag stadtstack-omp-b:review "$TMP"
IMAGE_ID=$("$DOCKER" image inspect --format '{{.Id}}' stadtstack-omp-b:review)
AFTER=$(sha256sum "$OMP" | cut -d ' ' -f 1)
[ "$EXPECTED" = "$AFTER" ] || { printf '%s\n' 'omp binary changed during image build' >&2; exit 2; }
DAEMON_ID=$("$DOCKER" info --format '{{.ID}}')
SETTINGS_SHA256=$(sha256sum "$TMP/settings.yml" | cut -d ' ' -f 1)
printf 'imageId=%s\nompBinarySha256=%s\ndockerDaemonId=%s\nsettingsSha256=%s\n' "$IMAGE_ID" "$ACTUAL" "$DAEMON_ID" "$SETTINGS_SHA256"
