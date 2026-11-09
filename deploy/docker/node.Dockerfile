# syntax=docker/dockerfile:1.7
#
# Images of the server workspace's Node processes. Build context: the
# repository root. Targets:
#
#   api      Fastify API (port 8080, GET /healthz and /readyz)
#   worker   BullMQ queues and stream consumers (no port)
#   migrate  one-shot migration runner (packages/db), exits when done
#
# Each runtime image holds only `pnpm deploy --prod` output: compiled dist/,
# production node_modules, no sources of other packages, no dev tools.

ARG NODE_IMAGE=node:24.22-alpine

# ── Build ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1
# pnpm comes from server/package.json "packageManager" through corepack.
RUN corepack enable
WORKDIR /repo/server
COPY server/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline \
      --filter "@app/api..." --filter "@app/worker..." --filter "@app/db..."
RUN pnpm --filter "@app/api..." --filter "@app/worker..." build
# The workspace does not inject workspace packages, so deploy runs in legacy
# mode: workspace dependencies are copied with their "files" (dist/,
# migrations/, fixtures/), third-party packages are installed for production.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @app/api deploy --prod --legacy /out/api \
 && pnpm --filter @app/worker deploy --prod --legacy /out/worker \
 && pnpm --filter @app/db deploy --prod --legacy /out/migrate \
 && rm -rf /out/api/src /out/api/test /out/worker/src /out/worker/test /out/migrate/src /out/migrate/test \
 && find /out -maxdepth 2 \( -name 'tsconfig*.json' -o -name 'vitest.config.ts' -o -name '.env.example' \) -delete \
 && test -f /out/api/dist/main.js && test -f /out/worker/dist/main.js && test -f /out/migrate/dist/cli/migrate.js

# ── Common runtime ───────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
# tini is PID 1: it forwards SIGTERM to node and reaps children, so the
# processes' own graceful shutdown (drain, finish jobs) runs on `docker stop`.
RUN apk add --no-cache tini
ENV NODE_ENV=production \
    LOG_PRETTY=false
WORKDIR /app
STOPSIGNAL SIGTERM
# Application files stay owned by root and read-only for the process user.
USER node
ENTRYPOINT ["/sbin/tini", "--"]

# Shared by the API and the worker: public addresses to settings, brand.
FROM runtime AS node-service
COPY --chmod=0755 deploy/scripts/brand.sh /usr/local/bin/brand.sh
COPY --chmod=0644 deploy/scripts/public-urls.sh deploy/scripts/brand-hosts.mjs /usr/local/lib/deploy/
COPY --chmod=0755 deploy/node/entrypoint.sh /usr/local/bin/service-entrypoint
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/service-entrypoint"]

# ── API ──────────────────────────────────────────────────────────────────
# UV_THREADPOOL_SIZE: admin password hashes (Argon2, at most 2 at once) share
# libuv's thread pool with DNS lookups, file reads and SCRAM; 8 threads keep
# room for them while hashes run.
FROM node-service AS api
COPY --from=build /out/api /app
COPY brands /app/brands
ENV BRANDS_DIR=/app/brands \
    HOST=0.0.0.0 \
    PORT=8080 \
    UV_THREADPOOL_SIZE=8
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ── Worker ───────────────────────────────────────────────────────────────
FROM node-service AS worker
COPY --from=build /out/worker /app
COPY brands /app/brands
ENV BRANDS_DIR=/app/brands
COPY --chmod=0644 deploy/node/worker-health.mjs /app/health.mjs
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node /app/health.mjs || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ── Migrations ───────────────────────────────────────────────────────────
FROM runtime AS migrate
COPY --from=build /out/migrate /app
# MIGRATION_DATABASE_URL: a direct PostgreSQL URL of the schema owner (the
# runner takes a session advisory lock, so never PgBouncer).
CMD ["node", "--enable-source-maps", "dist/cli/migrate.js", "up"]
