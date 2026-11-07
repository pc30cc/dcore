# syntax=docker/dockerfile:1.7
#
# Static builds of the admin panel (Vite SPA) and the website (Astro), each
# served by unprivileged nginx on port 8080. Build context: the repository
# root. Targets: admin, web.
#
# Build arguments:
#   BRAND, BRAND_JSON_BASE64   the brand (brands/<BRAND>/ in the repository,
#                              or the base64 of its brand.json)
#   SITE_URL                   web: the website's public URL; its canonical
#                              links, sitemap and legal links are built for it
#   API_URL                    web: where the deletion forms post
#   LINKS_URL                  web: the app-links host (optional)
#   GOOGLE_WEB_CLIENT_ID       web: deletion page "signed in with Google"
#   DELETION_GRACE_DAYS        web: days before a deletion is final
#
# The admin panel takes no host at build time: its container writes
# /config.js (the API and CDN origins) and its CSP from the environment at
# every start (deploy/nginx/admin-runtime.sh).

ARG NODE_IMAGE=node:24.22-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.6-alpine

# ── Sources and dependencies of both sites ───────────────────────────────
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1
RUN corepack enable
WORKDIR /repo/server
COPY server/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline \
      --filter "@app/admin..." --filter "@app/web..."
COPY brands /repo/brands
COPY --chmod=0755 deploy/scripts/brand.sh /usr/local/bin/brand.sh
COPY deploy/scripts/public-urls.sh deploy/scripts/brand-hosts.mjs deploy/nginx/csp.mjs deploy/nginx/admin-index.mjs /usr/local/lib/deploy/
ARG BRAND=_template
ARG BRAND_JSON_BASE64=
ENV BRAND=${BRAND} \
    BRANDS_DIR=/repo/brands
RUN BRAND_JSON_BASE64="${BRAND_JSON_BASE64}" brand.sh \
 && test -f "/repo/brands/${BRAND}/brand.json"

# ── Admin panel ──────────────────────────────────────────────────────────
FROM build AS build-admin
# The workspace packages are built first: vite.config.ts imports them.
RUN pnpm --filter "@app/admin..." build \
 && find apps/admin/dist -name '*.map' -delete \
 && node /usr/local/lib/deploy/admin-index.mjs apps/admin/dist/index.html \
 && node /usr/local/lib/deploy/csp.mjs admin apps/admin/dist/index.html > /tmp/csp.template

FROM ${NGINX_IMAGE} AS admin
COPY deploy/nginx/headers.conf deploy/nginx/admin-headers.conf /etc/nginx/snippets/
COPY --from=build-admin /tmp/csp.template /etc/nginx/csp.template
COPY deploy/nginx/admin.conf /etc/nginx/conf.d/default.conf
COPY deploy/scripts/public-urls.sh /usr/local/lib/deploy/public-urls.sh
COPY --chmod=0755 deploy/nginx/admin-runtime.sh /docker-entrypoint.d/40-admin-runtime.sh
COPY --from=build-admin /repo/server/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

# ── Website ──────────────────────────────────────────────────────────────
FROM build AS build-web
ARG SITE_URL
ARG API_URL
ARG LINKS_URL=
ARG GOOGLE_WEB_CLIENT_ID=
ARG DELETION_GRACE_DAYS=30
RUN set -eu; \
    . /usr/local/lib/deploy/public-urls.sh; \
    site="$(url_origin "${SITE_URL:-}")"; \
    api="$(url_origin "${API_URL:-}")"; \
    [ -n "$site" ] || { echo 'SITE_URL build argument is required' >&2; exit 64; }; \
    [ -n "$api" ] || { echo 'API_URL build argument is required' >&2; exit 64; }; \
    PUBLIC_SITE_URL="$site" PUBLIC_API_URL="$api" PUBLIC_LINKS_URL="${LINKS_URL:-}" \
      node /usr/local/lib/deploy/brand-hosts.mjs "/repo/brands/${BRAND}/brand.json"; \
    PUBLIC_API_ORIGIN="$api" \
    PUBLIC_GOOGLE_WEB_CLIENT_ID="${GOOGLE_WEB_CLIENT_ID:-}" \
    PUBLIC_DELETION_GRACE_DAYS="${DELETION_GRACE_DAYS:-30}" \
      pnpm --filter @app/web build; \
    node /usr/local/lib/deploy/csp.mjs web > /tmp/csp.conf

FROM ${NGINX_IMAGE} AS web
COPY deploy/nginx/headers.conf deploy/nginx/web-headers.conf /etc/nginx/snippets/
COPY --from=build-web /tmp/csp.conf /etc/nginx/snippets/csp.conf
COPY deploy/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build-web /repo/server/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
