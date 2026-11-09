#!/bin/sh
# Writes Centrifugo's configuration from deploy/centrifugo/config.json and the
# environment, then starts the server. The whole configuration is in the
# written file (no setting is left to Centrifugo's own environment mapping),
# so what runs is exactly what the template and these values say:
#
#   CENTRIFUGO_TOKEN_HMAC_SECRET  HS256 secret of connection tokens (32+ chars;
#                                 the API signs with the same value)
#   CENTRIFUGO_API_KEY            server API key (16+ chars; internal port only)
#   KV_RT_PASSWORD                password of the engine's Valkey (kv-rt)
#   KV_RT_ADDRESS                 its host:port (default kv-rt:6379)
#   KV_RT_DB                      its database number (default 0)
#   CENTRIFUGO_ALLOWED_ORIGINS    optional, comma- or space-separated browser
#                                 origins (scheme://host[:port]); native apps
#                                 send no Origin and need none; "*" is refused
#
#   CENTRIFUGO_TEMPLATE           the template (default /centrifugo/config.json)
#   CENTRIFUGO_CONFIG_OUT         where the configuration is written
#                                 (default /tmp/centrifugo.json, mode 0600)
#   CENTRIFUGO_CONFIG_ONLY        set: write the file and exit (checks, tests)
set -eu
# No pathname expansion: the origins are split on spaces below, and "*" must stay "*".
set -f

fail() {
  echo "centrifugo start: $*" >&2
  exit 64
}

secret="${CENTRIFUGO_TOKEN_HMAC_SECRET:-}"
api_key="${CENTRIFUGO_API_KEY:-}"
kv_password="${KV_RT_PASSWORD:-}"
kv_address="${KV_RT_ADDRESS:-kv-rt:6379}"
kv_db="${KV_RT_DB:-0}"

# Values end up inside JSON strings: only characters that need no escaping.
token_chars() {
  case "$2" in *[!A-Za-z0-9_.~+/=-]*) fail "$1 may hold only letters, digits and _ . ~ + / = -" ;; esac
}
token_chars CENTRIFUGO_TOKEN_HMAC_SECRET "$secret"
token_chars CENTRIFUGO_API_KEY "$api_key"
[ "${#secret}" -ge 32 ] || fail "CENTRIFUGO_TOKEN_HMAC_SECRET must be at least 32 characters"
[ "${#api_key}" -ge 16 ] || fail "CENTRIFUGO_API_KEY must be at least 16 characters"
[ "$secret" != "$api_key" ] || fail "CENTRIFUGO_API_KEY must differ from CENTRIFUGO_TOKEN_HMAC_SECRET"
case "$kv_password" in '' | *[!A-Za-z0-9_-]*) fail "KV_RT_PASSWORD must be letters, digits, _ or -" ;; esac
case "$kv_address" in '' | *[!A-Za-z0-9.:-]* | *:*:* | :* | *:) fail "KV_RT_ADDRESS must be host:port" ;; esac
case "$kv_address" in *:*) ;; *) fail "KV_RT_ADDRESS must be host:port" ;; esac
case "$kv_db" in '' | *[!0-9]*) fail "KV_RT_DB must be a number" ;; esac
[ "$kv_db" -le 15 ] || fail "KV_RT_DB must be between 0 and 15"

# Allowed origins: each scheme://host[:port], no path, no wildcard.
origins=""
for origin in $(printf '%s' "${CENTRIFUGO_ALLOWED_ORIGINS:-}" | tr ',' ' '); do
  case "$origin" in
    http://* | https://*) ;;
    *) fail "CENTRIFUGO_ALLOWED_ORIGINS: \"$origin\" is not an http(s) origin (\"*\" is refused: name each origin)" ;;
  esac
  host_port=${origin#*://}
  case "$host_port" in
    '' | *[!A-Za-z0-9.:-]* | *:*:* | .* | *:) fail "CENTRIFUGO_ALLOWED_ORIGINS: \"$origin\" must be scheme://host[:port] with no path" ;;
  esac
  origins="${origins:+$origins, }\"$origin\""
done

umask 077
template="${CENTRIFUGO_TEMPLATE:-/centrifugo/config.json}"
out="${CENTRIFUGO_CONFIG_OUT:-/tmp/centrifugo.json}"
[ -r "$template" ] || fail "the template $template cannot be read"
# Every value was checked above: no quote, backslash, & or line break can
# reach the file.
awk -v secret="$secret" -v key="$api_key" -v engine="redis://:$kv_password@$kv_address/$kv_db" -v origins="$origins" '
  {
    gsub(/"@ALLOWED_ORIGINS@"/, origins)
    gsub(/@TOKEN_HMAC_SECRET@/, secret)
    gsub(/@API_KEY@/, key)
    gsub(/@ENGINE_REDIS_ADDRESS@/, engine)
    print
  }
' "$template" > "$out"
if grep -q '@[A-Z_]*@' "$out"; then
  rm -f "$out"
  fail "the template has a placeholder this script does not fill"
fi

if [ -n "${CENTRIFUGO_CONFIG_ONLY:-}" ]; then
  exit 0
fi
# Inputs under the CENTRIFUGO_ prefix are removed, so Centrifugo reads only
# the file (it maps CENTRIFUGO_* variables onto its own keys).
unset CENTRIFUGO_TOKEN_HMAC_SECRET CENTRIFUGO_API_KEY CENTRIFUGO_ALLOWED_ORIGINS KV_RT_PASSWORD CENTRIFUGO_TEMPLATE CENTRIFUGO_CONFIG_OUT CENTRIFUGO_CONFIG_ONLY
exec centrifugo --config="$out"
