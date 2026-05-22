# syntax=docker/dockerfile:1.7

# ── Stage 1: Build ──────────────────────────────────────────────────
#
# We use a full Debian base for the builder so native deps (ssh2's
# cpu-features) have python3 + a working C toolchain. The runtime
# stage drops to slim and copies only what's needed.
FROM node:24-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Corepack picks the pnpm version from package.json's `packageManager`
# field — keep it the single source of truth.
RUN corepack enable

WORKDIR /build

# Copy manifest + lockfile first for layer caching: dependency installs
# only re-run when these change, not on every source edit.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Compile TypeScript.
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Drop dev-only deps so the runtime stage's node_modules is minimal.
RUN pnpm prune --prod

# ── Stage 2: Runtime ────────────────────────────────────────────────
#
# Slim image, non-root user, only the compiled JS + production deps.
# No build tools, no source TS, no tests.
FROM node:24-slim AS runtime

LABEL org.opencontainers.image.title="querybridge-mcp" \
      org.opencontainers.image.description="MCP server connecting Claude (and other MCP clients) to MySQL — supports SSH tunnels and multiple databases" \
      org.opencontainers.image.source="https://github.com/MahmoudHassanMustafa/querybridge-mcp" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# package.json stays in the image so the binary's --version reflects
# the right release (the in-code version is read from this file at
# runtime via createRequire).
COPY --from=builder --chown=node:node /build/package.json ./package.json
COPY --from=builder --chown=node:node /build/node_modules ./node_modules
COPY --from=builder --chown=node:node /build/dist ./dist

# Run as non-root. node:24-slim ships with the `node` user (UID 1000).
USER node

# Config is supplied by the operator at runtime, never baked in.
# Three options (pick one):
#   1. -v /host/config.json:/config/config.json:ro -e QUERYBRIDGE_MCP_CONFIG=/config/config.json
#   2. -e QUERYBRIDGE_MCP_CONFIG_JSON='{"connections":[...]}'
#   3. -e MYSQL_HOST=... -e MYSQL_USER=... etc.
# We deliberately do not set QUERYBRIDGE_MCP_CONFIG by default — doing
# so would short-circuit the inline-JSON and env-var paths.
ENV NODE_ENV=production

# Default port for the optional HTTP transport. Only listens when
# the container is started with `--transport=http`; harmless otherwise.
EXPOSE 8080

# MCP uses stdio by default — clients connect by piping into the
# container's stdin/stdout. Run with `docker run -i --rm`.
#
# For HTTP transport instead, pass the flag and publish the port:
#   docker run --rm -p 8080:8080 \
#     -e QUERYBRIDGE_MCP_CONFIG_JSON='...' \
#     -e QUERYBRIDGE_MCP_HTTP_TOKEN=... \
#     ghcr.io/<owner>/querybridge-mcp:latest \
#     --transport=http --host=0.0.0.0 --allowed-hosts=localhost
ENTRYPOINT ["node", "dist/server/index.js"]
