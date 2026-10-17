#!/bin/sh
set -eu
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Content-hash-pinned executable from reviewed image e61fc252. This offline
# derivation inherits its complete runtime and replaces ONLY the reviewed entry.
SOURCE_IMAGE=sha256:e61fc2520bcfe87dd37586ab19b2d2b054abfc41335b3af2437a7b7175c6c169
EXPECTED=647237242329897c3a7c0f3591fdd9cafe4a4e13872baa9bbdfe45b84f9d8992
EXPECTED_ENTRY=417a59923ed3aef9e51ebdbdb7bfab19968122ad5a8a2281fa95d2ac77d30171
EXPECTED_SETTINGS=a6211ded7fb160dccb61e0f27dd80ab7e2a31c747e6661f54f4841c13f22ae0a
EXPECTED_MANIFEST=e87e2ef469b318547b324a7f4a8a93621012f39024cb0a0e06c61fbc557c4d27
DOCKER=/usr/bin/docker
NODE=/opt/node-v24.21.0-linux-x64/bin/node
TMP=$(mktemp -d)
VERIFY_NAME=r1-omp-b-verify-$(basename "$TMP")
READY_NAME=r1-omp-b-ready-$(basename "$TMP")
# An empty private CLI configuration and explicit local socket never consult the
# lead's Docker context/credentials or self-updating omp installation.
docker_local() { "$DOCKER" --config "$TMP/docker-config" --host unix:///run/docker.sock "$@"; }
cleanup() {
 docker_local rm --force "$VERIFY_NAME" "$READY_NAME" >/dev/null 2>&1 || true
 rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM
mkdir "$TMP/docker-config" "$TMP/control"
chmod 0755 "$TMP/control"
printf '%s\n' 'Synthetic image readiness only. Return OK.' >"$TMP/control/system-prompt.md"
chmod 0444 "$TMP/control/system-prompt.md"
for FILE in Dockerfile entry.sh; do cp "$ROOT/docker/omp-b/$FILE" "$TMP/$FILE"; done
[ "$(sha256sum "$TMP/entry.sh" | cut -d ' ' -f 1)" = "$EXPECTED_ENTRY" ] || { printf '%s\n' 'Pinned entrypoint hash mismatch' >&2; exit 2; }
chmod 0555 "$TMP/entry.sh"
# Refuse a missing source locally. Legacy local-ID resolution deliberately avoids
# registry/frontend discovery; no apt, pull, network or executable extraction.
[ "$(docker_local image inspect --format '{{.Id}}' "$SOURCE_IMAGE")" = "$SOURCE_IMAGE" ]
verify_image() {
 docker_local run --pull=never --name "$VERIFY_NAME" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true --user 65534:65534 \
  --memory 67108864 --memory-swap 67108864 --cpus 1 --pids-limit 16 --log-driver none \
  --tmpfs /home/omp:rw,noexec,nosuid,nodev,size=1048576,uid=65534,gid=65534,mode=0700 \
  --entrypoint /usr/bin/env "$1" -i HOME=/home/omp PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
  /bin/sh -ec '
   [ "$(id -u):$(id -g)" = 65534:65534 ]
   printf "%s  %s\n" "$1" /usr/local/bin/omp \
    a5c48a5718258a55be65410ae036fafb7af8bdf4643f44c83379af5d7a6cf584 /usr/local/bin/pi_natives.linux-x64-baseline.node \
    fa537a8c0765dc76e5199aae9dadb99cec9d69d41b3d36a47a032452196cb078 /usr/local/bin/pi_natives.linux-x64-modern.node \
    "$2" /opt/stadtstack/omp-b-settings.yml "$3" /opt/stadtstack/omp-b-natives.sha256 | sha256sum --strict --check -
   if [ -n "$4" ]; then printf "%s  %s\n" "$4" /opt/stadtstack/entry.sh | sha256sum --strict --check -; fi
   [ "$(stat -c %a /usr/local/bin/omp)" = 555 ]
   [ "$(stat -c %a /opt/stadtstack/entry.sh)" = 555 ]
   for file in /usr/local/bin/pi_natives.linux-x64-baseline.node /usr/local/bin/pi_natives.linux-x64-modern.node /opt/stadtstack/omp-b-settings.yml /opt/stadtstack/omp-b-natives.sha256; do
    [ "$(stat -c %a "$file")" = 444 ] || exit 2
   done
  ' sh "$EXPECTED" "$EXPECTED_SETTINGS" "$EXPECTED_MANIFEST" "${2:-}"
 docker_local rm "$VERIFY_NAME" >/dev/null
}
verify_image "$SOURCE_IMAGE"
DOCKER_BUILDKIT=0 docker_local build --pull=false --network none --file "$TMP/Dockerfile" --tag stadtstack-omp-b:sonnet-candidate "$TMP"
IMAGE_ID=$(docker_local image inspect --format '{{.Id}}' stadtstack-omp-b:sonnet-candidate)
verify_image "$IMAGE_ID" "$EXPECTED_ENTRY"
# Inheritance must preserve the entire image configuration and base layer prefix.
# Docker's legacy parent Image field is provenance, not effective configuration.
docker_local image inspect "$SOURCE_IMAGE" "$IMAGE_ID" >"$TMP/images.json"
"$NODE" --input-type=module -e '
 import {readFileSync} from "node:fs";import assert from "node:assert/strict";
 const [base,candidate]=JSON.parse(readFileSync(process.argv[1],"utf8"));
 const config=({Image:_,...value})=>value;
 assert.deepEqual(config(candidate.Config),config(base.Config));
 assert.equal(candidate.Config.User,"65534:65534");
 assert.deepEqual(candidate.RootFS.Layers.slice(0,-1),base.RootFS.Layers);
' "$TMP/images.json"
# Keep this literal equal to OMP_EXECUTION_ARGS (tested). Bare --help, like
# --version, takes a fast path; only the complete argv forces module loading.
set -- --print --mode json --model anthropic/claude-haiku-5-5 --thinking off --no-session --no-tools --no-lsp --no-pty --no-extensions --no-skills --no-rules --no-title --no-prewalk --config /opt/stadtstack/omp-b-settings.yml --system-prompt /control/system-prompt.md --max-time 150 --cwd /work
# Full-module readiness uses no credential or network; all inference filesystem,
# user, resource and hardening restrictions remain exactly as before.
if ! printf '%s\n' 'sk-ant-oat01-SYNTHETIC-INVALID-IMAGE-READINESS' | \
 docker_local run --pull=never --name "$READY_NAME" --interactive --network none --ipc none --read-only \
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
printf 'imageId=%s\nbaseImageId=%s\nentrySha256=%s\nompBinarySha256=%s\ndockerDaemonId=%s\nsettingsSha256=%s\nnativeAddonManifestSha256=%s\n' "$IMAGE_ID" "$SOURCE_IMAGE" "$EXPECTED_ENTRY" "$EXPECTED" "$DAEMON_ID" "$EXPECTED_SETTINGS" "$EXPECTED_MANIFEST"
