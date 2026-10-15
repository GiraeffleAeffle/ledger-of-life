# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/stadtstack /home/omp/.omp/agent /home/omp/.config /home/omp/.local/share /home/omp/.local/state /home/omp/.cache /control /work /tmp
COPY --chmod=0555 omp /usr/local/bin/omp
# Immutable executable-directory fallbacks avoid extracting/loading native code
# in the bounded noexec HOME tmpfs. Assets come from this exact omp binary.
COPY --chmod=0444 pi_natives.linux-x64-baseline.node pi_natives.linux-x64-modern.node /usr/local/bin/
COPY --chmod=0444 natives.sha256 /opt/stadtstack/omp-b-natives.sha256
RUN cd /usr/local/bin && sha256sum --strict --check /opt/stadtstack/omp-b-natives.sha256
COPY --chmod=0444 settings.yml /opt/stadtstack/omp-b-settings.yml
COPY --chmod=0555 entry.sh /opt/stadtstack/entry.sh
# Copy the pinned runtime filesystem without inheriting its NODE_VERSION,
# YARN_VERSION or other image environment. The reviewed profile has a closed
# environment, not a filtered subset of base-image defaults.
FROM scratch
COPY --from=runtime / /
ENV PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/omp PI_CONFIG_DIR=.omp \
    PI_CODING_AGENT_DIR=/home/omp/.omp/agent XDG_CONFIG_HOME=/home/omp/.config \
    XDG_DATA_HOME=/home/omp/.local/share XDG_STATE_HOME=/home/omp/.local/state \
    XDG_CACHE_HOME=/home/omp/.cache TMPDIR=/tmp LANG=C.UTF-8 TZ=UTC PI_NO_TITLE=1 PI_NO_PTY=1
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/usr/bin/env","-i","PATH=/usr/local/bin:/usr/bin:/bin","HOME=/home/omp","PI_CONFIG_DIR=.omp","PI_CODING_AGENT_DIR=/home/omp/.omp/agent","XDG_CONFIG_HOME=/home/omp/.config","XDG_DATA_HOME=/home/omp/.local/share","XDG_STATE_HOME=/home/omp/.local/state","XDG_CACHE_HOME=/home/omp/.cache","TMPDIR=/tmp","LANG=C.UTF-8","TZ=UTC","PI_NO_TITLE=1","PI_NO_PTY=1","/opt/stadtstack/entry.sh"]
