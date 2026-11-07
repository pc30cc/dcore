#!/bin/sh
# Writes LiveKit's configuration from the environment and starts the server.
#
#   LIVEKIT_API_KEY, LIVEKIT_API_SECRET   the API key pair (secret >= 32 chars)
#   LIVEKIT_WEBHOOK_URL                   where room events are posted
#   LIVEKIT_NODE_IP                       the public IPv4 to announce; empty:
#                                         found at start through STUN
set -eu

fail() {
  echo "livekit start: $*" >&2
  exit 64
}

key="${LIVEKIT_API_KEY:-}"
secret="${LIVEKIT_API_SECRET:-}"
webhook="${LIVEKIT_WEBHOOK_URL:-}"
node_ip="${LIVEKIT_NODE_IP:-}"

case "$key" in '' | *[!A-Za-z0-9_-]*) fail "LIVEKIT_API_KEY must be letters, digits, _ or -" ;; esac
case "$secret" in '' | *[!A-Za-z0-9_-]*) fail "LIVEKIT_API_SECRET must be letters, digits, _ or -" ;; esac
[ "${#secret}" -ge 32 ] || fail "LIVEKIT_API_SECRET must be at least 32 characters"
case "$webhook" in
  http://* | https://*) ;;
  *) fail "LIVEKIT_WEBHOOK_URL must be an http(s) URL" ;;
esac
case "$webhook" in *[!A-Za-z0-9:/._~%-]*) fail "LIVEKIT_WEBHOOK_URL has characters outside a plain URL" ;; esac

case "$node_ip" in *[!0-9.]*) fail "LIVEKIT_NODE_IP must be an IPv4 address" ;; esac

umask 077
out="${LIVEKIT_CONFIG_OUT:-/tmp/livekit.yaml}"
# Every value was checked above: no quote, backslash, & or line break can
# reach the file.
awk -v key="$key" -v secret="$secret" -v webhook="$webhook" -v nodeip="$node_ip" '
  /^@NODE_IP_LINES@$/ {
    if (nodeip != "") { print "  use_external_ip: false"; print "  node_ip: " nodeip }
    else print "  use_external_ip: true"
    next
  }
  { gsub(/@API_KEY@/, key); gsub(/@API_SECRET@/, secret); gsub(/@WEBHOOK_URL@/, webhook); print }
' "${LIVEKIT_TEMPLATE:-/etc/livekit/livekit.yaml.tpl}" > "$out"

if [ -n "${LIVEKIT_CONFIG_ONLY:-}" ]; then
  exit 0
fi
exec /livekit-server --config "$out"
