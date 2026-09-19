# syntax=docker/dockerfile:1.7
# =============================================================================
# Multi-stage build.
#
#   deps    → production node_modules only (cached independently of source)
#   build   → full toolchain, compiles TypeScript to dist/
#   runtime → distroless-ish slim image: no compiler, no dev deps, non-root
#
# The final image carries neither the TypeScript sources nor the build
# toolchain, which keeps both the attack surface and the pull time down.
# =============================================================================

# ----------------------------------------------------------------- deps
FROM node:20-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
# `npm ci` is reproducible; omitting dev deps keeps the runtime layer small.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------- build
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY tsconfig.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
RUN npm run build && npm prune --omit=dev

# -------------------------------------------------------------- runtime
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# dumb-init reaps zombies and forwards SIGTERM, so Nest's shutdown hooks
# actually run and in-flight requests drain during a rolling deploy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=768" \
    PORT=3000

# Run as an unprivileged user. node:20 ships a `node` user (uid 1000).
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/scripts ./scripts

# Writable location for generated PDFs when no object store is configured.
RUN mkdir -p /app/storage && chown -R node:node /app/storage
VOLUME ["/app/storage"]

USER node
EXPOSE 3000

# Compose/ECS health checks hit the liveness probe, which does no I/O.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/main.js"]
