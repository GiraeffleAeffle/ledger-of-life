# syntax=docker/dockerfile:1
# Build from stadtstack-data/, never the repository root. No collection at build time.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ARG RELEASE_VERSION
ARG SOURCE_REVISION
LABEL org.opencontainers.image.version="${RELEASE_VERSION}" \
      org.opencontainers.image.ref.name="${RELEASE_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
ENV NODE_ENV=production \
    MCP_TOKEN_HASH_FILE=/run/secrets/mcp/token-hashes.json \
    MCP_PUBLIC_ORIGIN=https://mcp.stadtstack.eu \
    STADTSTACK_MCP_RELEASE_DIR=/app/release \
    STADTSTACK_MCP_REVOCATION_TRUST_FILE=/run/config/mcp-revocations/trust.json \
    STADTSTACK_MCP_REVOCATIONS_FILE=/run/config/mcp-revocations/revocations.json
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY regional/taxonomy.mjs ./regional/taxonomy.mjs
COPY --chown=0:0 release/ ./release/
# Bind image metadata to the canonical package version before validating data.
RUN node --experimental-strip-types --input-type=module <<'NODE'
import {readFileSync, readdirSync, lstatSync} from 'node:fs';
import {verifyDataRelease} from './src/data-release.ts';
const {version} = JSON.parse(readFileSync('./package.json', 'utf8'));
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(process.env.RELEASE_VERSION) ||
    version !== process.env.RELEASE_VERSION || !/^[0-9a-f]{40}$/.test(process.env.SOURCE_REVISION)) {
  throw new Error('Image release version/revision metadata does not match the package');
}
if (!lstatSync('/app/release').isDirectory() || lstatSync('/app/release').isSymbolicLink()) {
  throw new Error('Release root must be a real directory');
}
const manifest = await verifyDataRelease('/app/release');
const members = new Set(['release-manifest.json', ...manifest.files.map(file => file.path)]);
const directories = new Set();
for (const member of members) {
  const parts = member.split('/');
  for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join('/'));
}
function checkPublicTree(path = '') {
  for (const entry of readdirSync('/app/release/' + path, {withFileTypes: true})) {
    const child = path ? path + '/' + entry.name : entry.name;
    if (entry.isDirectory() && directories.has(child)) checkPublicTree(child);
    else if (!entry.isFile() || !members.delete(child)) throw new Error('Unsealed or nonregular release member');
  }
}
checkPublicTree();
if (members.size) throw new Error('Missing public release member');
NODE
# Root-owned artifacts are not writable even without Kubernetes read-only-rootfs.
RUN chmod -R a-w /app
USER 1000:1000
EXPOSE 4318
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:4318/health'); if (!r.ok) process.exit(1)"]
CMD ["node", "--experimental-strip-types", "src/mcp-hosted.ts"]
