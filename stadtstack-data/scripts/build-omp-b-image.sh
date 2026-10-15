#!/bin/sh
set -eu
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE_IMAGE=sha256:91c2c2c451fbc0273b97d25523bab3308b7077edca33efaaf26af923209711df
EXPECTED=647237242329897c3a7c0f3591fdd9cafe4a4e13872baa9bbdfe45b84f9d8992
DOCKER=/usr/bin/docker
TMP=$(mktemp -d)
SOURCE_NAME=r1-omp-b-source-$(basename "$TMP")
EXTRACT_NAME=r1-omp-b-extract-$(basename "$TMP")
READY_NAME=r1-omp-b-ready-$(basename "$TMP")
# An empty private CLI configuration and explicit local socket never consult the
# lead's Docker context/credentials or self-updating omp installation.
docker_local() { "$DOCKER" --config "$TMP/docker-config" --host unix:///run/docker.sock "$@"; }
cleanup() {
 docker_local rm --force "$SOURCE_NAME" "$EXTRACT_NAME" "$READY_NAME" >/dev/null 2>&1 || true
 rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM
mkdir "$TMP/docker-config" "$TMP/extracted" "$TMP/control"
chmod 0755 "$TMP/control"
printf '%s\n' 'Synthetic image readiness only. Return OK.' >"$TMP/control/system-prompt.md"
chmod 0444 "$TMP/control/system-prompt.md"
for FILE in Dockerfile settings.yml entry.sh natives.sha256; do cp "$ROOT/docker/omp-b/$FILE" "$TMP/$FILE"; done
# This source container is never started. The only accepted executable comes
# from the immutable reviewed image, then is independently hash-authenticated.
docker_local create --pull=never --name "$SOURCE_NAME" --network none --entrypoint /usr/bin/true "$SOURCE_IMAGE" >/dev/null
docker_local cp "$SOURCE_NAME:/usr/local/bin/omp" "$TMP/omp"
docker_local rm "$SOURCE_NAME" >/dev/null
[ "$(sha256sum "$TMP/omp" | cut -d ' ' -f 1)" = "$EXPECTED" ] || { printf '%s\n' 'Pinned image executable hash mismatch' >&2; exit 2; }
chmod 0555 "$TMP/omp" "$TMP/entry.sh"
# Keep this literal equal to OMP_EXECUTION_ARGS (tested). Bare --help, like
# --version, takes a fast path; only the complete argv forces module loading.
set -- --print --mode json --model anthropic/claude-haiku-5-5 --thinking off --no-session --no-tools --no-lsp --no-pty --no-extensions --no-skills --no-rules --no-title --no-prewalk --config /opt/stadtstack/omp-b-settings.yml --system-prompt /control/system-prompt.md --max-time 150 --cwd /work
UID_NUMBER=$(id -u)
GID_NUMBER=$(id -g)
# Build-only extraction: empty HOME, no credentials/network, bounded relaxed
# file/memory limits and executable scratch. Runtime restrictions below do NOT
# change. Both embedded 18.9.2 variants are exported, never downloaded at runtime.
if ! docker_local run --pull=never --name "$EXTRACT_NAME" --network none --read-only \
 --cap-drop ALL --security-opt no-new-privileges:true --user "$UID_NUMBER:$GID_NUMBER" \
 --memory 2147483648 --memory-swap 2147483648 --cpus 2 --pids-limit 128 \
 --ulimit nofile=1024:1024 --ulimit fsize=1073741824:1073741824 --log-driver none \
 --tmpfs "/extract-home:rw,exec,nosuid,nodev,size=1073741824,uid=$UID_NUMBER,gid=$GID_NUMBER,mode=0700" \
 --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=134217728,uid=$UID_NUMBER,gid=$GID_NUMBER,mode=0700" \
 --mount "type=bind,src=$TMP/extracted,dst=/extracted" \
 --mount "type=bind,src=$TMP/control,dst=/control,readonly,bind-propagation=rprivate" \
 --entrypoint /usr/bin/env "$SOURCE_IMAGE" -i HOME=/extract-home PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp LANG=C.UTF-8 TZ=UTC \
 /bin/sh -c 'omp "$@" --help >/dev/null && cp /extract-home/.omp/natives/18.9.2/pi_natives.linux-x64-baseline.node /extract-home/.omp/natives/18.9.2/pi_natives.linux-x64-modern.node /extracted/' sh "$@" 2>/dev/null; then
 printf '%s\n' 'Pinned native addon extraction failed' >&2; exit 2
fi
docker_local rm "$EXTRACT_NAME" >/dev/null
cp "$TMP/extracted/pi_natives.linux-x64-baseline.node" "$TMP/extracted/pi_natives.linux-x64-modern.node" "$TMP/"
chmod 0444 "$TMP/"*.node
(cd "$TMP" && sha256sum --strict --check natives.sha256)
docker_local build --pull=false --file "$TMP/Dockerfile" --tag stadtstack-omp-b:review "$TMP"
IMAGE_ID=$(docker_local image inspect --format '{{.Id}}' stadtstack-omp-b:review)
# Full-module readiness, with the exact inference security profile and frozen
# image environment/entrypoint. Dummy stdin is not a credential; --help makes
# no inference request. Never use --version as an image-readiness substitute.
if ! printf '%s\n' 'sk-ant-oat01-SYNTHETIC-INVALID-IMAGE-READINESS' | \
 docker_local run --pull=never --name "$READY_NAME" --interactive --network bridge --ipc none --read-only \
 --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 --workdir /work --stop-timeout 1 \
 --memory 536870912 --memory-swap 536870912 --cpus 1 --pids-limit 32 \
 --ulimit nofile=64:64 --ulimit nproc=32:32 --ulimit fsize=33554432:33554432 --ulimit core=0:0 --log-driver none \
 --tmpfs /home/omp:rw,noexec,nosuid,nodev,size=67108864,uid=65534,gid=65534,mode=0700 \
 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=67108864,uid=65534,gid=65534,mode=0700 \
 --tmpfs /work:rw,noexec,nosuid,nodev,size=67108864,uid=65534,gid=65534,mode=0700 \
 --mount "type=bind,src=$TMP/control,dst=/control,readonly,bind-propagation=rprivate" \
 "$IMAGE_ID" "$@" --help >/dev/null 2>&1; then
 printf '%s\n' 'Full-profile omp image readiness failed' >&2; exit 2
fi
docker_local rm "$READY_NAME" >/dev/null
DAEMON_ID=$(docker_local info --format '{{.ID}}')
SETTINGS_SHA256=$(sha256sum "$TMP/settings.yml" | cut -d ' ' -f 1)
NATIVE_MANIFEST_SHA256=$(sha256sum "$TMP/natives.sha256" | cut -d ' ' -f 1)
printf 'imageId=%s\nompBinarySha256=%s\ndockerDaemonId=%s\nsettingsSha256=%s\nnativeAddonManifestSha256=%s\n' "$IMAGE_ID" "$EXPECTED" "$DAEMON_ID" "$SETTINGS_SHA256" "$NATIVE_MANIFEST_SHA256"
