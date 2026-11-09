#!/bin/sh
# Writes LiveKit's configuration from the environment and starts the server.
#
#   LIVEKIT_API_KEY, LIVEKIT_API_SECRET   the API key pair (secret >= 32 chars);
#                                         webhooks are signed with this key
#   LIVEKIT_WEBHOOK_URL                   where room events are posted (the
#                                         API's /v1/webhooks/livekit)
#   LIVEKIT_NODE_IP                       the public IPv4 to announce, or
#                                         empty / "auto": found at every start
#                                         (an HTTP lookup by IP, then LiveKit's
#                                         own STUN), never the container's
#   LIVEKIT_NODE_IP_DETECT                "0": skip the HTTP lookup (STUN only)
#   LIVEKIT_NODE_IP_PRIVATE_OK            "1": a pinned private address is
#                                         accepted (development machines only)
#   LIVEKIT_RTC_TCP_PORT                  ICE over TCP (default 7891)
#   LIVEKIT_RTC_UDP_START, _END           UDP media range (default 51000-51100)
#
#   LIVEKIT_TEMPLATE                      default /etc/livekit/livekit.yaml.tpl
#   LIVEKIT_CONFIG_OUT                    default /tmp/livekit.yaml (mode 0600)
#   LIVEKIT_CONFIG_ONLY                   set: write the file and exit
set -eu
set -f

fail() {
  echo "livekit start: $*" >&2
  exit 64
}

key="${LIVEKIT_API_KEY:-}"
secret="${LIVEKIT_API_SECRET:-}"
webhook="${LIVEKIT_WEBHOOK_URL:-}"
node_ip="${LIVEKIT_NODE_IP:-auto}"
tcp_port="${LIVEKIT_RTC_TCP_PORT:-7891}"
udp_start="${LIVEKIT_RTC_UDP_START:-51000}"
udp_end="${LIVEKIT_RTC_UDP_END:-51100}"

case "$key" in '' | *[!A-Za-z0-9_-]*) fail "LIVEKIT_API_KEY must be letters, digits, _ or -" ;; esac
case "$secret" in '' | *[!A-Za-z0-9_-]*) fail "LIVEKIT_API_SECRET must be letters, digits, _ or -" ;; esac
[ "${#secret}" -ge 32 ] || fail "LIVEKIT_API_SECRET must be at least 32 characters"
case "$webhook" in
  http://* | https://*) ;;
  *) fail "LIVEKIT_WEBHOOK_URL must be an http(s) URL" ;;
esac
case "$webhook" in *[!A-Za-z0-9:/._~%-]*) fail "LIVEKIT_WEBHOOK_URL has characters outside a plain URL" ;; esac

# A public IPv4: four octets up to 255, none of the private, loopback,
# link-local or carrier-grade NAT ranges.
is_public_ipv4() {
  case "$1" in
    '' | *[!0-9.]* | .* | *. | *..*) return 1 ;;
    0.* | 10.* | 127.* | 169.254.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 1 ;;
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 1 ;;
  esac
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086
  set -- $1
  IFS=$old_ifs
  [ $# -eq 4 ] || return 1
  for octet in "$@"; do
    [ "${#octet}" -le 3 ] && [ "$octet" -le 255 ] || return 1
  done
}

# The host's public address as the internet sees it, over plain HTTP to an
# IP first (neither DNS nor TLS has to work for it).
detect_node_ip() {
  [ "${LIVEKIT_NODE_IP_DETECT:-1}" != 0 ] || return 1
  command -v wget > /dev/null 2>&1 || return 1
  for source in http://1.1.1.1/cdn-cgi/trace https://api.ipify.org; do
    found=$(wget -q -T 5 -O- "$source" 2> /dev/null | sed -n 's/^ip=//p;/^[0-9][0-9.]*$/p' | head -n 1) || found=
    if is_public_ipv4 "$found"; then
      echo "$found"
      return 0
    fi
  done
  return 1
}

if [ "$node_ip" = auto ]; then
  if found=$(detect_node_ip); then
    node_ip=$found
    echo "livekit start: node IP $node_ip (found at start)" >&2
  else
    node_ip=
    echo "livekit start: node IP left to LiveKit's STUN (no lookup answered)" >&2
  fi
elif [ "${LIVEKIT_NODE_IP_PRIVATE_OK:-}" = 1 ]; then
  case "$node_ip" in *[!0-9.]* | .* | *. | *..*) fail "LIVEKIT_NODE_IP must be an IPv4 address" ;; esac
else
  is_public_ipv4 "$node_ip" || fail "LIVEKIT_NODE_IP must be a public IPv4 address, or auto"
fi

port_ok() {
  case "$2" in '' | *[!0-9]*) fail "$1 must be a port number" ;; esac
  [ "$2" -ge 1024 ] && [ "$2" -le 65535 ] || fail "$1 must be between 1024 and 65535"
}
port_ok LIVEKIT_RTC_TCP_PORT "$tcp_port"
port_ok LIVEKIT_RTC_UDP_START "$udp_start"
port_ok LIVEKIT_RTC_UDP_END "$udp_end"
[ "$udp_start" -lt "$udp_end" ] || fail "LIVEKIT_RTC_UDP_START must be below LIVEKIT_RTC_UDP_END"
[ "$tcp_port" -ne 7880 ] || fail "LIVEKIT_RTC_TCP_PORT must differ from the signalling port 7880"
if [ "$tcp_port" -ge "$udp_start" ] && [ "$tcp_port" -le "$udp_end" ]; then
  fail "LIVEKIT_RTC_TCP_PORT must be outside the UDP range"
fi

umask 077
out="${LIVEKIT_CONFIG_OUT:-/tmp/livekit.yaml}"
template="${LIVEKIT_TEMPLATE:-/etc/livekit/livekit.yaml.tpl}"
[ -r "$template" ] || fail "the template $template cannot be read"
# Every value was checked above: no quote, backslash, & or line break can
# reach the file. With an address LiveKit's STUN lookup stays off
# (use_external_ip would win over node_ip).
awk -v key="$key" -v secret="$secret" -v webhook="$webhook" -v nodeip="$node_ip" \
    -v tcp="$tcp_port" -v udpstart="$udp_start" -v udpend="$udp_end" '
  /^@NODE_IP_LINES@$/ {
    if (nodeip != "") { print "  use_external_ip: false"; print "  node_ip: " nodeip }
    else print "  use_external_ip: true"
    next
  }
  {
    gsub(/@API_KEY@/, key); gsub(/@API_SECRET@/, secret); gsub(/@WEBHOOK_URL@/, webhook)
    gsub(/@TCP_PORT@/, tcp); gsub(/@UDP_START@/, udpstart); gsub(/@UDP_END@/, udpend)
    print
  }
' "$template" > "$out"
if grep -q '@[A-Z_]*@' "$out"; then
  rm -f "$out"
  fail "the template has a placeholder this script does not fill"
fi

if [ -n "${LIVEKIT_CONFIG_ONLY:-}" ]; then
  exit 0
fi
exec /livekit-server --config "$out"
