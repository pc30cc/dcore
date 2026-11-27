#!/bin/sh
# Start-up step of the admin panel's container (nginx's /docker-entrypoint.d,
# runs as the nginx user before nginx starts). Writes what depends on the
# deployment, so one image serves any domain and any default language:
#
#   /tmp/runtime/config.js    window.__APP_CONFIG__ = { apiOrigin, cdnOrigin,
#                             persianFontCss, persianFontFamily, defaultLocale }
#   /tmp/runtime/config.json  the same object, for readers that fetch it
#   /tmp/runtime/index.html   the build's page of the default language
#                             (index.<locale>.html: its <html lang dir> and
#                             <title>), which nginx serves for every route
#   /tmp/runtime/csp.conf     the Content-Security-Policy header, from the
#                             build's template with the origins filled in
#
# Environment: PUBLIC_API_URL (required), CDN_BASE_URL or BUNDLED_CDN_URL
# (optional, for photos the panel shows), ADMIN_PERSIAN_FONT_CSS_URL and
# ADMIN_PERSIAN_FONT_FAMILY (optional, together: a stylesheet of a licensed
# font kept outside the image, and the family it declares),
# ADMIN_DEFAULT_LOCALE (optional: the language the panel opens in for anyone
# who has not picked one in its menu, a language code of this build; empty:
# fa), HTML_DIR (the built pages; default /usr/share/nginx/html). A missing or
# malformed API address, a malformed font setting or a language the build
# does not have stops the container instead of serving a panel that cannot
# reach the API, loads the wrong file or opens in no language of its own.
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

font_css=$(printf '%s' "${ADMIN_PERSIAN_FONT_CSS_URL:-}" | tr -d '\r\n')
font_family=$(printf '%s' "${ADMIN_PERSIAN_FONT_FAMILY:-}" | tr -d '\r\n')
font_origin=
if [ -n "$font_css" ] || [ -n "$font_family" ]; then
  # https://host/path only: no query, fragment, credentials or characters
  # that JSON, sed or nginx would read specially.
  case "$font_css" in
    https://*) ;;
    *) echo "admin-runtime: ADMIN_PERSIAN_FONT_CSS_URL must be an https URL" >&2; exit 1 ;;
  esac
  case "${font_css#https://}" in
    '' | */ | *[!A-Za-z0-9._~/%-]* | */../* | */..) echo "admin-runtime: ADMIN_PERSIAN_FONT_CSS_URL must be https://host/path (letters, digits, . _ ~ / % - only)" >&2; exit 1 ;;
    */*) ;;
    *) echo "admin-runtime: ADMIN_PERSIAN_FONT_CSS_URL names no stylesheet path" >&2; exit 1 ;;
  esac
  case "$font_family" in
    '' | *[!A-Za-z0-9\ _-]*) echo "admin-runtime: ADMIN_PERSIAN_FONT_FAMILY must be a family name (letters, digits, space, _ -)" >&2; exit 1 ;;
  esac
  font_origin=$(url_origin "$font_css")
  [ -n "$font_origin" ] || { echo "admin-runtime: ADMIN_PERSIAN_FONT_CSS_URL names no host" >&2; exit 1; }
  font_host=${font_css#https://}
  font_css="$font_origin/${font_host#*/}"
fi

html_dir="${HTML_DIR:-/usr/share/nginx/html}"
locale=$(printf '%s' "${ADMIN_DEFAULT_LOCALE:-}" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
[ -n "$locale" ] || locale=fa
# Two lower-case letters only: no character that JSON, a path or nginx would read specially.
case "$locale" in
  [a-z][a-z]) ;;
  *) echo "admin-runtime: ADMIN_DEFAULT_LOCALE must be a language code such as fa, en or tr" >&2; exit 1 ;;
esac
if [ ! -f "$html_dir/index.$locale.html" ]; then
  available=
  for page in "$html_dir"/index.??.html; do
    [ -f "$page" ] || continue
    name=${page##*/index.}
    available="$available ${name%.html}"
  done
  echo "admin-runtime: ADMIN_DEFAULT_LOCALE=$locale is not a language of this panel (it has:${available:- none}); unset means fa, so a panel without Persian must set it" >&2
  exit 1
fi

mkdir -p "$out"
umask 022
json=$(printf '{"apiOrigin":"%s","cdnOrigin":"%s","persianFontCss":"%s","persianFontFamily":"%s","defaultLocale":"%s"}' "$api_origin" "$cdn_origin" "$font_css" "$font_family" "$locale")
printf '%s\n' "$json" > "$out/config.json.tmp"
printf 'window.__APP_CONFIG__ = Object.freeze(%s);\n' "$json" > "$out/config.js.tmp"
cp "$html_dir/index.$locale.html" "$out/index.html.tmp"
# The origins were checked to be scheme://host with [a-z0-9.-] only, so no
# character that sed or nginx would read specially reaches the template.
sed -e "s#@API_ORIGIN@#$api_origin#g" -e "s#@CDN_ORIGIN@#$cdn_origin#g" -e "s#@FONT_ORIGIN@#$font_origin#g" "$template" > "$out/csp.conf.tmp"
mv "$out/config.json.tmp" "$out/config.json"
mv "$out/config.js.tmp" "$out/config.js"
mv "$out/csp.conf.tmp" "$out/csp.conf"
mv "$out/index.html.tmp" "$out/index.html"
echo "admin-runtime: API $api_origin${cdn_origin:+, CDN $cdn_origin}${font_origin:+, Persian font from $font_origin}, panel language $locale" >&2
