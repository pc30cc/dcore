#!/bin/sh
# The in-country media relay: coturn on a server inside the country whose
# mobile networks cannot reach the media server abroad. Phones there reach
# this server domestically; it forwards their audio and video, over UDP, to
# LiveKit's node and to nothing else. The API hands it (URLs and one
# credential per participant and call: 6 hours by default, renewed only
# shortly before it runs out, never valid past the call's 12-hour guard) only
# to participants whose own network is in the relay countries of the admin
# panel's RTC settings.
#
#   phone ──UDP/TCP 3478──▶ relay ──UDP──▶ LiveKit node (its UDP media range)
#
# A new server, in this order (as root):
#   1. install -D -m 0644 10-relay-ready.conf /etc/systemd/system/coturn.service.d/10-relay-ready.conf
#      (the package would otherwise start coturn with its own open defaults)
#   2. apt-get install coturn
#   3. install -d -m 0700 /etc/relay && (umask 077; openssl rand -hex 24 > /etc/relay/secret)
#   4. PUBLIC_IP=<this server> PEER_IPS="<LiveKit node IP>" ./configure.sh
#   5. the firewall (below), then probe.py, then the URLs, the same secret
#      and the countries in the admin panel (RTC settings), which stores the
#      secret sealed and shows its fingerprint:
#        printf %s "$(tr -d '\r\n' < /etc/relay/secret)" | sha256sum | cut -c1-12
#
# Settings (environment):
#   PUBLIC_IP     this server's public IPv4 (required; on an interface, no NAT)
#   PUBLIC_IP6    its public IPv6 (optional)
#   PEER_IPS      the only addresses the relay may send to: LiveKit's node IP(s),
#                 space-separated. When LiveKit moves, run this again with the
#                 new address, or every relayed call loses its media.
#   PORT          client port, UDP and TCP (default 3478)
#   MIN_PORT, MAX_PORT  relay port range (default 49160-49999)
#   MAX_BPS       bytes per second per session, each direction (default 1000000)
#   TOTAL_QUOTA   concurrent allocations on the server (default 3000)
#   USER_QUOTA    concurrent allocations per username, that is per participant
#                 credential (default 32; never 0, see below)
#   REALM         the TURN realm (default "relay"; a name, not a brand)
#   SECRET_FILE   the shared secret (default /etc/relay/secret, root, 0600). It
#                 is never printed. Rotate it here and in the admin panel back
#                 to back, at a quiet hour: calls relayed at that moment drop.
#   CONF          where the configuration goes (default /etc/turnserver.conf)
#   CONFIG_ONLY   set: write CONF and stop (no ownership change, no restart)
#
# Firewall of this server:
#   - 3478 UDP and TCP inbound from anywhere (IPv4 and IPv6): the callers;
#   - MIN_PORT-MAX_PORT UDP inbound only from PEER_IPS: LiveKit's answers to
#     the relayed ports (coturn drops packets of peers without a permission;
#     the firewall keeps everyone else off those ports too);
#   - outbound UDP to PEER_IPS (LiveKit's UDP media range, and the port the
#     probe's STUN responder listens on while you check);
#   - nothing else: no 5349 (no TLS until there is a domain), no TCP relay.
# Firewall of the LiveKit host: its UDP media range must accept this server's
# address (a rule that narrows the range to known networks must keep it).
set -eu

PUBLIC_IP=${PUBLIC_IP:?set PUBLIC_IP (this server public IPv4)}
PUBLIC_IP6=${PUBLIC_IP6:-}
PEER_IPS=${PEER_IPS:?set PEER_IPS (the LiveKit node IP)}
PORT=${PORT:-3478}
MIN_PORT=${MIN_PORT:-49160}
MAX_PORT=${MAX_PORT:-49999}
MAX_BPS=${MAX_BPS:-1000000}
TOTAL_QUOTA=${TOTAL_QUOTA:-3000}
USER_QUOTA=${USER_QUOTA:-32}
REALM=${REALM:-relay}
SECRET_FILE=${SECRET_FILE:-/etc/relay/secret}
CONF=${CONF:-/etc/turnserver.conf}

fail() {
  echo "relay configure: $*" >&2
  exit 1
}

number() {
  case "$2" in '' | *[!0-9]*) fail "$1 must be a number" ;; esac
}
ipv4() {
  case "$2" in '' | *[!0-9.]* | .* | *. | *..*) fail "$1: \"$2\" is not an IPv4 address" ;; esac
}
number PORT "$PORT"
number MIN_PORT "$MIN_PORT"
number MAX_PORT "$MAX_PORT"
number MAX_BPS "$MAX_BPS"
number TOTAL_QUOTA "$TOTAL_QUOTA"
number USER_QUOTA "$USER_QUOTA"
[ "$USER_QUOTA" -gt 0 ] || fail "USER_QUOTA must be above 0"
[ "$MIN_PORT" -ge 1024 ] && [ "$MIN_PORT" -lt "$MAX_PORT" ] && [ "$MAX_PORT" -le 65535 ] || fail "MIN_PORT-MAX_PORT must be a range within 1024-65535"
[ "$PORT" -lt "$MIN_PORT" ] || [ "$PORT" -gt "$MAX_PORT" ] || fail "PORT must be outside the relay range"
ipv4 PUBLIC_IP "$PUBLIC_IP"
case "$PUBLIC_IP6" in *[!0-9A-Fa-f:]*) fail "PUBLIC_IP6 is not an IPv6 address" ;; esac
for ip in $PEER_IPS; do ipv4 PEER_IPS "$ip"; done
case "$REALM" in '' | *[!A-Za-z0-9.-]*) fail "REALM must be letters, digits, dots or hyphens" ;; esac
[ -s "$SECRET_FILE" ] || fail "missing $SECRET_FILE"
secret=$(tr -d '\r\n' < "$SECRET_FILE")
[ "${#secret}" -ge 32 ] || fail "the shared secret must be at least 32 characters"
case "$secret" in *[!A-Za-z0-9_.~+/=-]*) fail "the shared secret may hold only letters, digits and _ . ~ + / = -" ;; esac

if [ -z "${CONFIG_ONLY:-}" ]; then
  [ "$(id -u)" = 0 ] || fail "run as root"
  command -v turnserver > /dev/null || fail "coturn is not installed"
  id turnserver > /dev/null
fi

umask 027
tmp=$(mktemp "$CONF.XXXXXX")
trap 'rm -f "$tmp"' EXIT
{
  echo "# The in-country media relay. Written by configure.sh on $(date -u +%FT%TZ)."
  echo "# Do not edit by hand: change the settings and run configure.sh again."
  echo "listening-port=$PORT"
  echo "listening-ip=$PUBLIC_IP"
  echo "relay-ip=$PUBLIC_IP"
  if [ -n "$PUBLIC_IP6" ]; then
    echo "listening-ip=$PUBLIC_IP6"
    echo "relay-ip=$PUBLIC_IP6"
  fi
  echo "min-port=$MIN_PORT"
  echo "max-port=$MAX_PORT"
  echo "realm=$REALM"
  echo "fingerprint"
  # Time-limited credentials minted by the API (the TURN REST scheme): the
  # username is <expiry>:r<16 random hex>, the password base64(HMAC-SHA1(
  # secret, username)). The username names nothing: it is all the log shows.
  echo "use-auth-secret"
  echo "static-auth-secret=$secret"
  echo "stale-nonce=600"
  # Plain UDP and TCP on the client side; TLS needs a domain.
  echo "no-tls"
  echo "no-dtls"
  echo "no-cli"
  echo "no-tcp-relay"
  echo "no-multicast-peers"
  echo "no-software-attribute"
  # Relay only to the media server: every peer denied, then LiveKit allowed.
  echo "denied-peer-ip=0.0.0.0-255.255.255.255"
  echo "denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
  for ip in $PEER_IPS; do echo "allowed-peer-ip=$ip"; done
  echo "max-bps=$MAX_BPS"
  # Allocations per username, that is per participant credential (valid for
  # hours; the API hands a participant the same one on every token request of
  # the call). Without a cap one credential could hold every relay port long
  # after its call ended; the peer rules keep it from reaching anything but
  # LiveKit, not from filling the port range. A connect takes about one
  # allocation per TURN URL for each of LiveKit's two peer connections, and
  # each network change allocates again while the old ones run out (below):
  # 32 is several changes within that time.
  echo "user-quota=$USER_QUOTA"
  # An allocation nobody refreshes (left on a network the phone moved off)
  # is gone within 10 minutes, so it frees its place in the quota soon.
  echo "max-allocate-lifetime=600"
  # Server-wide: the relay port range runs out first.
  echo "total-quota=$TOTAL_QUOTA"
  echo "syslog"
  echo "simple-log"
  echo "no-stdout-log"
} > "$tmp"
chmod 640 "$tmp"
if [ -n "${CONFIG_ONLY:-}" ]; then
  mv "$tmp" "$CONF"
  trap - EXIT
  exit 0
fi
chown root:turnserver "$tmp"
mv "$tmp" "$CONF"
trap - EXIT

install -d -m 0755 /etc/relay
touch /etc/relay/ready
systemctl daemon-reload
systemctl enable coturn > /dev/null 2>&1
systemctl restart coturn
sleep 2
systemctl is-active coturn
ss -lnup "sport = :$PORT" | tail -n +2
ss -lntp "sport = :$PORT" | tail -n +2
