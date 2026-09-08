# syntax=docker/dockerfile:1

# The service is a long-lived process that spawns a native `anvil` and an MCP
# subprocess, holds an in-memory upgrade index and a gRPC stream. None of that
# survives a serverless or edge runtime, so it ships as an ordinary container.

# Anvil is copied from the Foundry image rather than installed with a piped
# shell script. A build that curls an installer downloads whatever is current
# that day, which is the opposite of what an image is for.
FROM ghcr.io/foundry-rs/foundry:v1.7.1 AS foundry

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first, so a source edit does not invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/
COPY packages/demo/package.json packages/demo/
COPY packages/gateway/package.json packages/gateway/
COPY packages/hedera/package.json packages/hedera/
COPY packages/ledger/package.json packages/ledger/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/operational-layer/package.json packages/operational-layer/
COPY packages/secrets/package.json packages/secrets/
COPY packages/service/package.json packages/service/
COPY packages/substreams/package.json packages/substreams/
COPY packages/verdict-engine/package.json packages/verdict-engine/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages packages
RUN npm run build -w @presign/service

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# ca-certificates for TLS to Alchemy, the gateway, Hedera and Substreams.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil

# The registry is installed at build time rather than fetched by `npx -y` on
# first use. Fetching at runtime makes the first verdict of a fresh container
# depend on npm being reachable, which turns a registry outage into a failed
# verdict instead of a failed build.
RUN npm install -g subgraph-registry-mcp@latest
ENV REGISTRY_COMMAND=subgraph-registry-mcp \
    REGISTRY_ARGS=""

COPY package.json package-lock.json ./
COPY packages/gateway/package.json packages/gateway/
COPY packages/hedera/package.json packages/hedera/
COPY packages/operational-layer/package.json packages/operational-layer/
COPY packages/secrets/package.json packages/secrets/
COPY packages/service/package.json packages/service/
COPY packages/substreams/package.json packages/substreams/
COPY packages/verdict-engine/package.json packages/verdict-engine/
RUN npm ci --omit=dev \
      -w @presign/service -w @presign/gateway -w @presign/hedera \
      -w @presign/operational-layer -w @presign/secrets \
      -w @presign/substreams -w @presign/verdict-engine \
 && npm cache clean --force

COPY --from=build /app/packages/gateway/dist packages/gateway/dist
COPY --from=build /app/packages/hedera/dist packages/hedera/dist
COPY --from=build /app/packages/operational-layer/dist packages/operational-layer/dist
COPY --from=build /app/packages/secrets/dist packages/secrets/dist
COPY --from=build /app/packages/service/dist packages/service/dist
COPY --from=build /app/packages/substreams/dist packages/substreams/dist
COPY --from=build /app/packages/verdict-engine/dist packages/verdict-engine/dist
# The .spkg sits beside dist, not inside it: the module resolves it as
# `dirname(import.meta.url)/../ethereum-common-v0.3.0.spkg`, so the layout has
# to be preserved rather than the file dropped anywhere convenient.
COPY packages/substreams/ethereum-common-v0.3.0.spkg packages/substreams/

# Secrets are never baked in. The resolver reads files first and the
# environment second, so a deployment injects them as environment variables
# and a mounted directory still wins if one is provided.
ENV PRESIGN_SECRETS_DIR=/run/secrets/presign \
    HOST=0.0.0.0 \
    PORT=4021 \
    NODE_ENV=production

# Unprivileged: nothing here needs root, and the process spawns child
# processes that should not have it either.
USER node

EXPOSE 4021

# /health answers without payment and reports data-source liveness, so it is
# the honest readiness signal: the process is up and can say what it can see.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4021)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/service/dist/bin.js"]
