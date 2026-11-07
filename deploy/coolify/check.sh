#!/bin/sh
# Static checks of docker-compose.yml without Coolify or a Docker daemon (the
# docker CLI with its compose plugin is enough):
#
#   deploy/coolify/check.sh
#
#   1. `docker compose config` accepts the file as Coolify runs it: the
#      repository root as the project directory, the variables of
#      .env.example, and without `exclude_from_hc`, a key of Coolify's own
#      that it removes before it calls compose.
#   2. Every ${VAR} of the file is listed in .env.example and every variable
#      of .env.example is used by the file.
#   3. Only livekit publishes host ports; everything else is reached through
#      Coolify's proxy or the stack's network.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
compose="$here/docker-compose.yml"
example="$here/.env.example"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
status=0

sed '/^[[:space:]]*exclude_from_hc:/d' "$compose" > "$work/compose.yml"
if docker compose --project-directory "$root" -f "$work/compose.yml" --env-file "$example" config > "$work/rendered.yml" 2> "$work/err"; then
  echo "check: compose file is valid"
else
  grep -v 'level=warning' "$work/err" >&2 || true
  echo "check: compose file is NOT valid" >&2
  status=1
fi

grep -o '\${[A-Z0-9_]*' "$compose" | sed 's/^\${//' | sort -u > "$work/used"
grep -E '^[A-Z0-9_]+=' "$example" | cut -d= -f1 | sort -u > "$work/listed"
missing=$(comm -23 "$work/used" "$work/listed")
unused=$(comm -13 "$work/used" "$work/listed")
if [ -n "$missing" ]; then
  echo "check: used but not in .env.example: $(echo $missing)" >&2
  status=1
fi
if [ -n "$unused" ]; then
  echo "check: in .env.example but not used: $(echo $unused)" >&2
  status=1
fi
[ -n "$missing$unused" ] || echo "check: .env.example lists exactly the variables the file uses"

# Services with a top-level `ports:` key, from the rendered file.
published=$(awk '
  /^services:/ { in_services = 1; next }
  in_services && /^[^ ]/ { in_services = 0 }
  in_services && /^  [a-z0-9_-]+:$/ { svc = $1; sub(":", "", svc) }
  in_services && /^    ports:/ { print svc }
' "$work/rendered.yml" | sort -u | tr '\n' ' ')
if [ "$published" = "livekit " ]; then
  echo "check: only livekit publishes host ports"
else
  echo "check: services publishing host ports: ${published:-none} (expected: livekit)" >&2
  status=1
fi

exit "$status"
