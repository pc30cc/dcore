#!/bin/sh
# Entrypoint of the API and worker containers (runs under tini). Derives the
# host-dependent settings from the public addresses the deployment hands over,
# prepares the brand, then runs the command.
#
# Public addresses (URL or bare host; see public-urls.sh):
#   PUBLIC_API_URL, PUBLIC_ADMIN_URL, PUBLIC_SITE_URL, PUBLIC_LINKS_URL,
#   PUBLIC_REALTIME_URL, PUBLIC_RTC_URL, PUBLIC_CDN_URL
# Settings filled from them only when not set explicitly:
#   CORS_ADMIN_ORIGINS   https://<admin host>
#   SITE_ORIGIN          https://<site host>
#   CENTRIFUGO_WS_URL    wss://<realtime host>/connection/websocket
#   S3_*, CDN_*          the bundled object store and media service
#                        (storage_defaults in public-urls.sh)
# Brand: BRAND_JSON_BASE64 (the base64 of a brand.json) replaces the
# repository's brands/<BRAND>/brand.json; the hosts in the brand are then
# rewritten from the public addresses (brand-hosts.mjs) into a writable copy.
set -eu

lib="${DEPLOY_LIB_DIR:-/usr/local/lib/deploy}"
. "$lib/public-urls.sh"

admin_origin=$(url_origin "${PUBLIC_ADMIN_URL:-}")
site_origin=$(url_origin "${PUBLIC_SITE_URL:-}")
realtime_host=$(url_host "${PUBLIC_REALTIME_URL:-}")

set_default CORS_ADMIN_ORIGINS "$admin_origin"
set_default SITE_ORIGIN "$site_origin"
if [ -n "$realtime_host" ]; then
  set_default CENTRIFUGO_WS_URL "wss://$realtime_host/connection/websocket"
fi
storage_defaults

brand="${BRAND:-_template}"
source_dir="${BRANDS_DIR:-/app/brands}"
runtime_dir="${BRANDS_RUNTIME_DIR:-/tmp/brands}"
umask 022
rm -rf "$runtime_dir"
mkdir -p "$runtime_dir"
if [ -d "$source_dir" ]; then
  cp -R "$source_dir/." "$runtime_dir/"
fi
if [ -n "${BRAND_JSON_BASE64:-}" ]; then
  BRANDS_DIR="$runtime_dir" "${BRAND_SH:-/usr/local/bin/brand.sh}"
fi
unset BRAND_JSON_BASE64
if [ -f "$runtime_dir/$brand/brand.json" ]; then
  node "$lib/brand-hosts.mjs" "$runtime_dir/$brand/brand.json"
fi
export BRANDS_DIR="$runtime_dir"

exec "$@"
