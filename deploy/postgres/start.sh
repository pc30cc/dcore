#!/usr/bin/env bash
# Entrypoint of the PostgreSQL container. Runs the image's own entrypoint
# (first-time initdb, then the server) as a child, waits until the real
# server accepts TCP connections (the temporary server of a first start
# listens on the socket only), applies roles.sh, and only then marks the
# container ready for the health check. Stop signals go to the server.
set -Eeuo pipefail

ready_marker=/tmp/pg-roles.ok
rm -f "$ready_marker"

docker-entrypoint.sh "$@" &
server_pid=$!

forward() {
  kill -s "$1" "$server_pid" 2>/dev/null || true
}
trap 'forward INT' INT
trap 'forward TERM' TERM
trap 'forward QUIT' QUIT

(
  for _ in $(seq 1 600); do
    if pg_isready -q -h 127.0.0.1 -p "${PGPORT:-5432}" -U "${POSTGRES_USER:-postgres}"; then
      if /usr/local/bin/pg-roles; then
        touch "$ready_marker"
        exit 0
      fi
    fi
    sleep 1
  done
  echo "start.sh: roles were not applied within 10 minutes; the container stays unhealthy" >&2
) &
sync_pid=$!

set +e
wait "$server_pid"
status=$?
# A trapped signal interrupts wait before the server has stopped.
while kill -0 "$server_pid" 2>/dev/null; do
  wait "$server_pid"
  status=$?
done
kill "$sync_pid" 2>/dev/null
exit "$status"
