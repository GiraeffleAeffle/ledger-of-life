# syntax=docker/dockerfile:1
# Build from stadtstack-data/, never the repository root. No collection at build time.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ENV NODE_ENV=production \
    MCP_TOKEN_HASH_FILE=/run/secrets/mcp/token-hashes.json \
    MCP_PUBLIC_ORIGIN=https://mcp.stadtstack.eu
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY regional/taxonomy.mjs ./regional/taxonomy.mjs
COPY out/ ./out/
# Verify the exact shared core manifest/bundle/corpus and all published schemas.
RUN node --experimental-strip-types --input-type=module -e "import {loadRelease} from './src/mcp-tools.ts'; await loadRelease()"
# Root-owned artifacts are not writable even without Kubernetes read-only-rootfs.
RUN chmod -R a-w /app
USER 1000:1000
EXPOSE 4318
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:4318/health'); if (!r.ok) process.exit(1)"]
CMD ["node", "--experimental-strip-types", "src/mcp-hosted.ts"]
