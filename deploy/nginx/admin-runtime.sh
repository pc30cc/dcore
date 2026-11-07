#!/bin/sh
# Start-up step of the admin panel's container (nginx's /docker-entrypoint.d,
# runs as the nginx user before nginx starts). Writes what depends on the
# deployment's hosts, so one image serves any domain:
#
#   /tmp/runtime/config.js    window.__APP_CONFIG__ = { apiOrigin, cdnOrigin }
#   /tmp/runtime/config.json  the same object, for readers that fetch it
#   /tmp/runtime/csp.conf     the Content-Security-Policy header, from the
#                             build's template with the origins filled in
#
# Environment: PUBLIC_API_URL (required), CDN_BASE_URL or BUNDLED_CDN_URL
# (optional, for photos the panel shows). A missing or malformed API address
# stops the container instead of serving a panel that cannot reach the API.
set -eu

. "${DEPLOY_LIB_DIR:-/usr/local/lib/deploy}/public-urls.sh"

out="${RUNTIME_DIR:-/tmp/runtime}"
template="${CSP_TEMPLATE:-/etc/nginx/csp.template}"

api_origin=$(url_origin "${PUBLIC_API_URL:-}")
if [ -z "$api_origin" ]; then
  echo "admin-runtime: PUBLIC_API_URL is not set" >&2
  exit 1
fi
cdn_source="${CDN_BASE_URL:-${BUNDLED_CDN_URL:-}}"
cdn_origin=$(url_origin "$cdn_source")

mkdir -p "$out"
umask 022
json=$(printf '{"apiOrigin":"%s","cdnOrigin":"%s"}' "$api_origin" "$cdn_origin")
printf '%s\n' "$json" > "$out/config.json.tmp"
printf 'window.__APP_CONFIG__ = Object.freeze(%s);\n' "$json" > "$out/config.js.tmp"
# The origins were checked to be scheme://host with [a-z0-9.-] only, so no
# character that sed or nginx would read specially reaches the template.
sed -e "s#@API_ORIGIN@#$api_origin#g" -e "s#@CDN_ORIGIN@#$cdn_origin#g" "$template" > "$out/csp.conf.tmp"
mv "$out/config.json.tmp" "$out/config.json"
mv "$out/config.js.tmp" "$out/config.js"
mv "$out/csp.conf.tmp" "$out/csp.conf"
echo "admin-runtime: API $api_origin${cdn_origin:+, CDN $cdn_origin}" >&2
