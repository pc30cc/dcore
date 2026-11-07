#!/bin/sh
# Writes PgBouncer's configuration and userlist from the environment, then
# runs it in the foreground. The userlist holds the login roles' passwords
# in plain text so PgBouncer can answer SCRAM for clients and log in to
# PostgreSQL with the same password; the file is readable by its user only.
#
# Environment: PG_HOST (default postgres), PG_PORT (5432), PG_DATABASE (app),
# PG_API_PASSWORD, PG_WORKER_PASSWORD, PGBOUNCER_DEFAULT_POOL_SIZE (20),
# PGBOUNCER_MAX_CLIENT_CONN (2000), PGBOUNCER_MAX_DB_CONNECTIONS (60).
set -eu

conf_dir="${PGBOUNCER_CONF_DIR:-/etc/pgbouncer}"
template="${PGBOUNCER_TEMPLATE:-/etc/pgbouncer/pgbouncer.ini.tpl}"

fail() {
  echo "pgbouncer entrypoint: $*" >&2
  exit 64
}

check_password() {
  name="$1"
  eval "value=\${$name:-}"
  [ -n "$value" ] || fail "$name is not set"
  case "$value" in *'"'* | *'\'* | *"
"*) fail "$name contains a quote, a backslash or a line break" ;; esac
}

check_int() {
  case "$2" in '' | *[!0-9]*) fail "$1 must be a whole number" ;; esac
}

check_password PG_API_PASSWORD
check_password PG_WORKER_PASSWORD

pg_host="${PG_HOST:-postgres}"
pg_port="${PG_PORT:-5432}"
pg_database="${PG_DATABASE:-app}"
pool="${PGBOUNCER_DEFAULT_POOL_SIZE:-20}"
clients="${PGBOUNCER_MAX_CLIENT_CONN:-2000}"
db_conns="${PGBOUNCER_MAX_DB_CONNECTIONS:-60}"
check_int PG_PORT "$pg_port"
check_int PGBOUNCER_DEFAULT_POOL_SIZE "$pool"
check_int PGBOUNCER_MAX_CLIENT_CONN "$clients"
check_int PGBOUNCER_MAX_DB_CONNECTIONS "$db_conns"
case "$pg_host" in '' | *[!A-Za-z0-9.-]*) fail "PG_HOST must be a host name" ;; esac
case "$pg_database" in '' | *[!a-z0-9_]*) fail "PG_DATABASE must be lowercase letters, digits and _" ;; esac

umask 077
sed -e "s/@PG_HOST@/$pg_host/g" \
    -e "s/@PG_PORT@/$pg_port/g" \
    -e "s/@PG_DATABASE@/$pg_database/g" \
    -e "s/@DEFAULT_POOL_SIZE@/$pool/g" \
    -e "s/@MAX_CLIENT_CONN@/$clients/g" \
    -e "s/@MAX_DB_CONNECTIONS@/$db_conns/g" \
    "$template" > "$conf_dir/pgbouncer.ini"
printf '"%s" "%s"\n"%s" "%s"\n' \
  app_api "$PG_API_PASSWORD" \
  app_worker "$PG_WORKER_PASSWORD" > "$conf_dir/userlist.txt"
sed -i "s#^auth_file = .*#auth_file = $conf_dir/userlist.txt#" "$conf_dir/pgbouncer.ini"

exec pgbouncer "$conf_dir/pgbouncer.ini"
