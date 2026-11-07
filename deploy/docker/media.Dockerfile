# syntax=docker/dockerfile:1.7
#
# Media origin in front of the bundled object store: nginx with njs checks
# each link's signature (deploy/media/verify.js) before it fetches the
# object. A CDN may sit in front of it. Build context: the repository root.
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.6-alpine
FROM ${NGINX_IMAGE}
COPY deploy/media/nginx.conf /etc/nginx/nginx.conf
COPY deploy/media/media.conf.template /etc/nginx/media.conf.template
COPY deploy/media/verify.js /etc/nginx/njs/verify.js
COPY --chmod=0755 deploy/media/media-runtime.sh /docker-entrypoint.d/40-media-runtime.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
