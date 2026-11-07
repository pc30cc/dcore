#!/bin/sh
# Starts Centrifugo with deploy/centrifugo/config.json and the secrets and
# addresses from the environment (Centrifugo v6 reads CENTRIFUGO_* variables
# over the file):
#
#   CENTRIFUGO_TOKEN_HMAC_SECRET  HS256 secret of connection tokens (32+ chars)
#   CENTRIFUGO_API_KEY            server API key (16+ chars)
#   KV_RT_PASSWORD                password of the engine's Valkey (kv-rt)
#   KV_RT_ADDRESS                 its host:port (default kv-rt:6379)
#   CENTRIFUGO_ALLOWED_ORIGINS    optional, comma-separated browser origins;
#                                 native apps send no Origin and need none
set -eu

fail() {
  echo "centrifugo start: $*" >&2
  exit 64
}

secret="${CENTRIFUGO_TOKEN_HMAC_SECRET:-}"
api_key="${CENTRIFUGO_API_KEY:-}"
kv_password="${KV_RT_PASSWORD:-}"
kv_address="${KV_RT_ADDRESS:-kv-rt:6379}"
[ "${#secret}" -ge 32 ] || fail "CENTRIFUGO_TOKEN_HMAC_SECRET must be at least 32 characters"
[ "${#api_key}" -ge 16 ] || fail "CENTRIFUGO_API_KEY must be at least 16 characters"
case "$kv_password" in '' | *[!A-Za-z0-9_-]*) fail "KV_RT_PASSWORD must be letters, digits, _ or -" ;; esac
case "$kv_address" in '' | *[!A-Za-z0-9.:-]*) fail "KV_RT_ADDRESS must be host:port" ;; esac

export CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY="$secret"
export CENTRIFUGO_HTTP_API_KEY="$api_key"
export CENTRIFUGO_ENGINE_REDIS_ADDRESS="redis://:$kv_password@$kv_address/0"
origins=$(printf '%s' "${CENTRIFUGO_ALLOWED_ORIGINS:-}" | tr ',' ' ' | tr -s ' ')
origins=${origins# }
origins=${origins% }
if [ -n "$origins" ]; then
  case "$origins" in *[!A-Za-z0-9.:/\ *-]*) fail "CENTRIFUGO_ALLOWED_ORIGINS has unexpected characters" ;; esac
  export CENTRIFUGO_CLIENT_ALLOWED_ORIGINS="$origins"
fi
# Inputs under the CENTRIFUGO_ prefix that v6 does not know are removed, so it
# reads only its own keys.
unset CENTRIFUGO_TOKEN_HMAC_SECRET CENTRIFUGO_API_KEY CENTRIFUGO_ALLOWED_ORIGINS KV_RT_PASSWORD

exec centrifugo --config=/centrifugo/config.json
