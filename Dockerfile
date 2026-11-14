# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.service.json ./
COPY sdk/ ./sdk/
COPY server/ ./server/
COPY scripts/ ./scripts/
RUN npm run build:service

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY THIRD_PARTY_NOTICES.md ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/service ./dist/service
COPY scripts/start-service.mjs scripts/index-maintenance.mjs scripts/organization-maintenance.mjs scripts/organization-invoice-keys.mjs scripts/service-health.mjs ./scripts/
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production CORE_DATA_DIR=/data CORE_API_HOST=0.0.0.0 CORE_SERVICE_NETWORK=testnet PORT=3001 CORE_API_REQUIRE_INDEX=true
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=6s --start-period=120s --retries=3 CMD ["node", "scripts/service-health.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/start-service.mjs"]
