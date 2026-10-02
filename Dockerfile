# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# Ledger of Life. One image: the web app and the reconcile job (`node scripts/reconcile.mjs`).
#
#   docker build -t ledger-of-life \
#     --build-arg NEXT_PUBLIC_PRIVY_APP_ID=<public Privy app id> \
#     --build-arg NEXT_PUBLIC_PRIVY_CLIENT_ID=<public Privy app client id, optional> .
#
# The image holds code, the published city data and two public deployment manifests (Local stakes and the shared loan
# market on Robinhood Chain testnet: addresses, code hashes, parameters). Keys, the database and operator material are
# supplied at run time (see docs/DEPLOYMENT.md); nothing private is copied in, and `.dockerignore` is deny-by-default.

# Pinned by digest so a moved tag cannot change what builds and runs this image: node:24-bookworm-slim, Node 24.21.0,
# resolved on 30 Sep 2026. Update deliberately: `docker buildx imagetools inspect node:24-bookworm-slim`, then rebuild.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# --ignore-scripts matches CI and keeps install-time scripts of third-party packages from running in the build.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund

FROM base AS build
# NEXT_PUBLIC_* values are compiled into the browser bundle, so they are build arguments. They are public by design.
ARG NEXT_PUBLIC_PRIVY_APP_ID
ARG NEXT_PUBLIC_PRIVY_CLIENT_ID
ARG NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID \
    NEXT_PUBLIC_PRIVY_CLIENT_ID=$NEXT_PUBLIC_PRIVY_CLIENT_ID \
    NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL=$NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
# The public origin, needed at build time only because prerendered pages carry absolute link-preview URLs
# (metadataBase). It is not a secret, and it does not reach the runtime stage: the running server reads APP_ORIGIN from
# its own environment. Without it, previews on prerendered pages fall back to a localhost address.
ARG APP_ORIGIN
ENV APP_ORIGIN=$APP_ORIGIN
COPY --from=deps /app/node_modules ./node_modules
COPY package.json next.config.ts tsconfig.json ./
COPY app ./app
COPY src ./src
COPY scripts/copy-maplibre-worker.mjs ./scripts/copy-maplibre-worker.mjs
COPY public ./public
# Statically bundled reviewed pins: the share-deposit factory/implementation (Home and the wallet signing policy),
# the building revenue distributor (wallet signing policy) and the Local stakes units (building revenue reads).
COPY contracts/evm/deployments/share-deposit-46630.json ./contracts/evm/deployments/share-deposit-46630.json
COPY contracts/evm/deployments/building-revenue-46630.json ./contracts/evm/deployments/building-revenue-46630.json
COPY contracts/evm/deployments/local-investments-46630.json ./contracts/evm/deployments/local-investments-46630.json
# The public /replay page bundles the 1 October hosted evidence (public transaction hashes and amounts).
COPY docs/evidence/HOSTED_SHARE_DEPOSIT_ROBINHOOD_TESTNET_2026-10-01.json docs/evidence/HOSTED_LOAN_STAKES_ROBINHOOD_TESTNET_2026-10-01.json docs/evidence/HOSTED_PER_TOKEN_AI_ANSWER_ROBINHOOD_TESTNET_2026-10-01.json ./docs/evidence/
# The public /story page bundles the growing 2 October city story (public test accounts and receipts).
COPY docs/evidence/HOSTED_CITY_STORY_ROBINHOOD_TESTNET_2026-10-02.json ./docs/evidence/
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4175 \
    LOCAL_DATABASE_PATH=/data/rental.sqlite
# /data holds the database when no DATABASE_URL is set. Next also wants a cache directory: it exists so a read-only root
# filesystem starts cleanly, and can be mounted as an emptyDir if anything ever needs to write there.
RUN mkdir /data /app/.next /app/.next/cache && chown -R node:node /data /app/.next
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# Serve fonts, sample photos and the generated matching MapLibre worker modules.
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node stadtstack-data/out ./stadtstack-data/out
# Public testnet deployments read at their default paths: Local stakes and the AI desk's payee
# (src/server/local-investments.ts), the shared loan market and its price mirror (src/server/shared-market.ts,
# src/server/tsla-price-mirror.ts), share deposits (src/server/share-deposit-chain.ts) and the building revenue
# distributor (src/server/building-revenue.ts). The share, building and Local stakes manifests also enter the build
# stage, which bundles them statically. Rebuild the image when a deployment changes.
COPY --chown=node:node contracts/evm/deployments/local-investments-46630.json ./contracts/evm/deployments/local-investments-46630.json
COPY --chown=node:node contracts/evm/deployments/shared-market-46630.json ./contracts/evm/deployments/shared-market-46630.json
COPY --chown=node:node contracts/evm/deployments/share-deposit-46630.json ./contracts/evm/deployments/share-deposit-46630.json
COPY --chown=node:node contracts/evm/deployments/building-revenue-46630.json ./contracts/evm/deployments/building-revenue-46630.json
COPY --chown=node:node scripts/reconcile.mjs ./scripts/reconcile.mjs
COPY --chown=node:node home-node/home-node.mjs ./home-node/home-node.mjs
USER node
VOLUME /data
EXPOSE 4175
# Ready only when the store answers, not merely when the process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/status').then(r=>r.json()).then(s=>process.exit(s.storeAvailable?0:1)).catch(()=>process.exit(1))"
# Kubernetes and Docker set HOSTNAME to the pod or container name, which server.js would bind to; force all interfaces.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node server.js"]
