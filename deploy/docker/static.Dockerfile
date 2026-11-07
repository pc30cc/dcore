# syntax=docker/dockerfile:1.7
#
# Static builds of the admin panel (Vite SPA) and the website (Astro), each
# served by unprivileged nginx on port 8080. Build context: the repository
# root. Targets: admin, web.
#
# Build arguments (the brand and public URLs are fixed at build time):
#   BRAND, BRAND_JSON_BASE64   the brand (brands/<BRAND>/ in the repository,
#                              or the base64 of its brand.json)
#   API_ORIGIN                 https://api.<domain>; the admin's API and the
#                              website's deletion forms
#   CDN_ORIGIN                 https://cdn.<domain>; images the admin may show
#   GOOGLE_WEB_CLIENT_ID       website deletion page ("signed in with Google")
#   DELETION_GRACE_DAYS        days before a deletion is final (as app_config)

ARG NODE_IMAGE=node:24.22.1-alpine3.24
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
COPY deploy/nginx/csp.mjs /usr/local/lib/csp.mjs
ARG BRAND=_template
ARG BRAND_JSON_BASE64=
ENV BRAND=${BRAND}
RUN BRANDS_DIR=/repo/brands BRAND_JSON_BASE64="${BRAND_JSON_BASE64}" brand.sh

# ── Admin panel ──────────────────────────────────────────────────────────
FROM build AS build-admin
ARG API_ORIGIN
ARG CDN_ORIGIN=
RUN test -n "${API_ORIGIN}" || { echo 'API_ORIGIN build argument is required' >&2; exit 64; }
ENV VITE_API_BASE_URL=${API_ORIGIN}
RUN pnpm --filter @app/admin build \
 && find apps/admin/dist -name '*.map' -delete \
 && node /usr/local/lib/csp.mjs admin apps/admin/dist/index.html "${API_ORIGIN}" "${CDN_ORIGIN}" > /tmp/csp.conf

FROM ${NGINX_IMAGE} AS admin
COPY deploy/nginx/headers.conf /etc/nginx/snippets/headers.conf
COPY --from=build-admin /tmp/csp.conf /etc/nginx/snippets/csp.conf
COPY deploy/nginx/admin.conf /etc/nginx/conf.d/default.conf
COPY --from=build-admin /repo/server/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

# ── Website ──────────────────────────────────────────────────────────────
FROM build AS build-web
ARG API_ORIGIN
ARG GOOGLE_WEB_CLIENT_ID=
ARG DELETION_GRACE_DAYS=30
RUN test -n "${API_ORIGIN}" || { echo 'API_ORIGIN build argument is required' >&2; exit 64; }
ENV PUBLIC_API_ORIGIN=${API_ORIGIN} \
    PUBLIC_GOOGLE_WEB_CLIENT_ID=${GOOGLE_WEB_CLIENT_ID} \
    PUBLIC_DELETION_GRACE_DAYS=${DELETION_GRACE_DAYS} \
    BRANDS_DIR=/repo/brands
RUN pnpm --filter @app/web build \
 && node /usr/local/lib/csp.mjs web > /tmp/csp.conf

FROM ${NGINX_IMAGE} AS web
COPY deploy/nginx/headers.conf /etc/nginx/snippets/headers.conf
COPY --from=build-web /tmp/csp.conf /etc/nginx/snippets/csp.conf
COPY deploy/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build-web /repo/server/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
