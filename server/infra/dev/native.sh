#!/usr/bin/env bash
# Run PostgreSQL 17 + PostGIS and Redis natively, without Docker.
#
# For development containers and CI runners on Debian or Ubuntu where no Docker
# daemon is available. On a machine with Docker, use infra/docker-compose.yml.
#
#   infra/dev/native.sh install   add apt.postgresql.org, install PostgreSQL 17,
#                                 PostGIS 3, pgvector, PgBouncer, redis-server and coturn (root;
#                                 coturn only for the relay tests, which start their own)
#   infra/dev/native.sh start     create (once) and start the dev cluster, PgBouncer
#                                 (transaction mode) and redis
#   infra/dev/native.sh stop      stop both
#   infra/dev/native.sh status    show what is running
#   infra/dev/native.sh env       print the environment variables to export
#   infra/dev/native.sh up        install when missing, then start (default)
#
# Everything listens on 127.0.0.1 only, on ports chosen not to collide with a
# system PostgreSQL (5432) or Redis (6379). The passwords are development
# defaults: never reuse them anywhere else.
set -euo pipefail

PG_MAJOR=17
PG_CLUSTER="${PG_CLUSTER:-appdev}"
PG_PORT="${PG_PORT:-54317}"
PG_SUPERUSER_PASSWORD="${PG_SUPERUSER_PASSWORD:-postgres}"
APP_DB_USER="${APP_DB_USER:-app}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-app}"
APP_DATABASES="${APP_DATABASES:-app_dev app_test}"
# Extensions created ahead of the migrations, as superuser, so a migration that
# says CREATE EXTENSION IF NOT EXISTS runs as the (non-superuser) owner role.
# An extension whose package is not installed is skipped with a warning.
PG_EXTENSIONS="${PG_EXTENSIONS:-postgis vector pgcrypto citext pg_stat_statements}"
REDIS_PORT="${REDIS_PORT:-63790}"
PGBOUNCER_PORT="${PGBOUNCER_PORT:-64320}"
STATE_DIR="${STATE_DIR:-/var/tmp/app-dev}"
REDIS_DIR="$STATE_DIR/redis"
PGBOUNCER_DIR="$STATE_DIR/pgbouncer"
PG_BIN="/usr/lib/postgresql/$PG_MAJOR/bin"

log() { printf '[native] %s\n' "$*" >&2; }
die() { printf '[native] error: %s\n' "$*" >&2; exit 1; }

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

as_postgres() {
  if [ "$(id -un)" = postgres ]; then "$@"
  elif [ "$(id -u)" -eq 0 ]; then runuser -u postgres -- "$@"
  else sudo -u postgres "$@"; fi
}

apt_get() {
  # Another process may hold the dpkg lock for a while (unattended upgrades,
  # a parallel job); wait for it instead of failing.
  as_root env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 "$@"
}

cmd_install() {
  command -v apt-get >/dev/null || die "apt-get not found: this script supports Debian and Ubuntu only"
  # shellcheck disable=SC1091
  . /etc/os-release
  local codename="${VERSION_CODENAME:?no VERSION_CODENAME in /etc/os-release}"
  local keyring=/etc/apt/keyrings/apt.postgresql.org.asc
  local list=/etc/apt/sources.list.d/pgdg.list

  apt_get update -qq
  apt_get install -y -qq ca-certificates curl gnupg lsb-release >/dev/null
  if [ ! -s "$keyring" ]; then
    log "adding the apt.postgresql.org signing key"
    as_root install -d -m 0755 /etc/apt/keyrings
    local tmp
    tmp="$(mktemp)"
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o "$tmp" \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc
    grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$tmp" || die "the downloaded signing key is not a PGP key"
    as_root install -m 0644 "$tmp" "$keyring"
    rm -f "$tmp"
  fi
  if [ ! -s "$list" ]; then
    log "adding the apt.postgresql.org repository for $codename"
    echo "deb [signed-by=$keyring] https://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main" \
      | as_root tee "$list" >/dev/null
  fi
  apt_get update -qq
  log "installing PostgreSQL $PG_MAJOR, PostGIS 3, pgvector, PgBouncer, redis-server and coturn"
  # The relay tests run their own turnserver; the package's service must
  # never run on a development machine with the package's open defaults.
  if [ -d /run/systemd/system ] && [ ! -f /etc/systemd/system/coturn.service.d/10-dev-off.conf ]; then
    as_root install -d -m 0755 /etc/systemd/system/coturn.service.d
    printf '[Unit]\nConditionPathExists=/nonexistent/dev-machine-never-runs-the-relay\n' \
      | as_root tee /etc/systemd/system/coturn.service.d/10-dev-off.conf >/dev/null
    as_root systemctl daemon-reload || true
  fi
  apt_get install -y -qq \
    "postgresql-$PG_MAJOR" \
    "postgresql-$PG_MAJOR-postgis-3" \
    "postgresql-$PG_MAJOR-pgvector" \
    "postgresql-client-$PG_MAJOR" \
    pgbouncer \
    redis-server \
    coturn >/dev/null
  log "installed: $("$PG_BIN/postgres" --version), $(redis-server --version | cut -d' ' -f1-3)"
}

pg_cluster_exists() {
  pg_lsclusters --no-header 2>/dev/null | awk '{print $1"/"$2}' | grep -qx "$PG_MAJOR/$PG_CLUSTER"
}

pg_cluster_online() {
  pg_lsclusters --no-header 2>/dev/null | awk -v c="$PG_MAJOR/$PG_CLUSTER" '$1"/"$2==c {print $4}' | grep -q online
}

psql_super() {
  as_postgres "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h /var/run/postgresql -p "$PG_PORT" -d "${1:-postgres}" "${@:2}"
}

start_postgres() {
  [ -x "$PG_BIN/postgres" ] || die "PostgreSQL $PG_MAJOR is not installed: run '$0 install' first"
  as_root install -d -o postgres -g postgres -m 2775 /var/run/postgresql
  if ! pg_cluster_exists; then
    log "creating cluster $PG_MAJOR/$PG_CLUSTER on 127.0.0.1:$PG_PORT"
    as_root pg_createcluster "$PG_MAJOR" "$PG_CLUSTER" --port "$PG_PORT" \
      -- --auth-local=peer --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 >/dev/null
    local conf="/etc/postgresql/$PG_MAJOR/$PG_CLUSTER/conf.d/10-dev.conf"
    as_root tee "$conf" >/dev/null <<EOF
# Development cluster written by infra/dev/native.sh.
listen_addresses = '127.0.0.1'
port = $PG_PORT
max_connections = 200
shared_buffers = 256MB
fsync = on
log_min_duration_statement = 250ms
log_lock_waits = on
EOF
  fi
  # Statement statistics (pg_stat_statements): how many statements each test
  # or load run really sent. Loaded at server start only, so a cluster made
  # before this setting existed is restarted once.
  local stats="/etc/postgresql/$PG_MAJOR/$PG_CLUSTER/conf.d/20-statements.conf"
  if [ ! -s "$stats" ]; then
    as_root tee "$stats" >/dev/null <<EOF
# Written by infra/dev/native.sh: per-statement counts and timings.
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 10000
pg_stat_statements.track = top
track_io_timing = on
EOF
  fi
  if ! pg_cluster_online; then
    log "starting cluster $PG_MAJOR/$PG_CLUSTER"
    as_root pg_ctlcluster "$PG_MAJOR" "$PG_CLUSTER" start
  elif ! psql_super postgres -tAc 'SHOW shared_preload_libraries' | grep -q pg_stat_statements; then
    log "restarting cluster $PG_MAJOR/$PG_CLUSTER to load pg_stat_statements"
    as_root pg_ctlcluster "$PG_MAJOR" "$PG_CLUSTER" restart -m fast
  fi
  provision_postgres
}

provision_postgres() {
  psql_super postgres -c "ALTER ROLE postgres PASSWORD '$PG_SUPERUSER_PASSWORD'"
  psql_super postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_DB_USER') THEN
    CREATE ROLE "$APP_DB_USER" LOGIN CREATEDB PASSWORD '$APP_DB_PASSWORD';
  END IF;
END
\$\$;
-- Behind PgBouncer in transaction mode a client cannot set these per session;
-- every server connection opened for the role gets them from here.
ALTER ROLE "$APP_DB_USER" SET statement_timeout = '5s';
ALTER ROLE "$APP_DB_USER" SET idle_in_transaction_session_timeout = '10s';
SQL
  local db ext
  for db in $APP_DATABASES; do
    if [ -z "$(psql_super postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'")" ]; then
      log "creating database $db"
      psql_super postgres -c "CREATE DATABASE \"$db\" OWNER \"$APP_DB_USER\""
    fi
    for ext in $PG_EXTENSIONS; do
      if [ -n "$(psql_super "$db" -tAc "SELECT 1 FROM pg_available_extensions WHERE name = '$ext'")" ]; then
        psql_super "$db" -c "CREATE EXTENSION IF NOT EXISTS \"$ext\"" 2>/dev/null
      else
        log "warning: extension $ext is not installed, skipped in $db"
      fi
    done
  done
}

start_redis() {
  command -v redis-server >/dev/null || die "redis-server is not installed: run '$0 install' first"
  mkdir -p "$REDIS_DIR"
  if redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping >/dev/null 2>&1; then return; fi
  log "starting redis on 127.0.0.1:$REDIS_PORT"
  # No persistence: this instance is for development and tests only.
  # maxmemory-policy noeviction is what BullMQ requires.
  redis-server \
    --bind 127.0.0.1 --port "$REDIS_PORT" --protected-mode yes \
    --daemonize yes --dir "$REDIS_DIR" \
    --pidfile "$REDIS_DIR/redis.pid" --logfile "$REDIS_DIR/redis.log" \
    --save '' --appendonly no --maxmemory-policy noeviction
  local i
  for i in $(seq 1 50); do
    redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping >/dev/null 2>&1 && return
    sleep 0.1
  done
  die "redis did not answer on port $REDIS_PORT (see $REDIS_DIR/redis.log)"
}

pgbouncer_running() {
  [ -f "$PGBOUNCER_DIR/pgbouncer.pid" ] && kill -0 "$(cat "$PGBOUNCER_DIR/pgbouncer.pid")" 2>/dev/null
}

start_pgbouncer() {
  command -v pgbouncer >/dev/null || { log "pgbouncer is not installed: skipped (run '$0 install')"; return; }
  if pgbouncer_running; then return; fi
  as_root install -d -o postgres -g postgres -m 0700 "$PGBOUNCER_DIR"
  local db databases=""
  for db in $APP_DATABASES; do databases+="$db = host=127.0.0.1 port=$PG_PORT dbname=$db"$'\n'; done
  printf '"%s" "%s"\n' "$APP_DB_USER" "$APP_DB_PASSWORD" | as_postgres tee "$PGBOUNCER_DIR/userlist.txt" >/dev/null
  as_postgres tee "$PGBOUNCER_DIR/pgbouncer.ini" >/dev/null <<INI
; Development PgBouncer written by infra/dev/native.sh, in transaction mode
; like production. infra/pgbouncer/pgbouncer.ini explains the settings.
[databases]
$databases
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = $PGBOUNCER_PORT
unix_socket_dir =
auth_type = scram-sha-256
auth_file = $PGBOUNCER_DIR/userlist.txt
pool_mode = transaction
default_pool_size = 10
max_client_conn = 500
max_prepared_statements = 0
query_wait_timeout = 10
idle_transaction_timeout = 30
logfile = $PGBOUNCER_DIR/pgbouncer.log
pidfile = $PGBOUNCER_DIR/pgbouncer.pid
INI
  log "starting pgbouncer (transaction mode) on 127.0.0.1:$PGBOUNCER_PORT"
  as_postgres pgbouncer -d -q "$PGBOUNCER_DIR/pgbouncer.ini"
}

stop_pgbouncer() {
  if pgbouncer_running; then
    log "stopping pgbouncer"
    kill "$(cat "$PGBOUNCER_DIR/pgbouncer.pid")" 2>/dev/null || true
  fi
}

cmd_start() { start_postgres; start_pgbouncer; start_redis; cmd_status; }

cmd_stop() {
  stop_pgbouncer
  if pg_cluster_online; then
    log "stopping cluster $PG_MAJOR/$PG_CLUSTER"
    as_root pg_ctlcluster "$PG_MAJOR" "$PG_CLUSTER" stop -m fast
  fi
  if redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    log "stopping redis"
    redis-cli -h 127.0.0.1 -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  fi
}

cmd_status() {
  if pg_cluster_online; then
    log "postgres: online on 127.0.0.1:$PG_PORT ($(psql_super postgres -tAc 'SHOW server_version'))"
  else
    log "postgres: not running"
  fi
  if pgbouncer_running; then
    log "pgbouncer: online on 127.0.0.1:$PGBOUNCER_PORT (transaction mode)"
  else
    log "pgbouncer: not running"
  fi
  if redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    log "redis: online on 127.0.0.1:$REDIS_PORT"
  else
    log "redis: not running"
  fi
}

cmd_env() {
  local first_db="${APP_DATABASES%% *}"
  cat <<EOF
export DATABASE_URL=postgres://$APP_DB_USER:$APP_DB_PASSWORD@127.0.0.1:$PG_PORT/$first_db
export MIGRATION_DATABASE_URL=postgres://$APP_DB_USER:$APP_DB_PASSWORD@127.0.0.1:$PG_PORT/$first_db
# The tests create a database per file, PostGIS in it and the grant roles: superuser.
export TEST_DATABASE_URL=postgres://postgres:$PG_SUPERUSER_PASSWORD@127.0.0.1:$PG_PORT/postgres
export TEST_PGBOUNCER_URL=postgres://$APP_DB_USER:$APP_DB_PASSWORD@127.0.0.1:$PGBOUNCER_PORT/app_test
export REDIS_URL=redis://127.0.0.1:$REDIS_PORT/0
export TEST_REDIS_URL=redis://127.0.0.1:$REDIS_PORT/15
EOF
}

cmd_up() {
  if [ ! -x "$PG_BIN/postgres" ] || ! command -v redis-server >/dev/null || ! command -v pgbouncer >/dev/null \
     || ! command -v turnserver >/dev/null \
     || [ ! -d "/usr/share/postgresql/$PG_MAJOR/extension" ] \
     || [ ! -f "/usr/share/postgresql/$PG_MAJOR/extension/postgis.control" ]; then
    cmd_install
  fi
  cmd_start
}

case "${1:-up}" in
  install) cmd_install ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  env) cmd_env ;;
  up) cmd_up ;;
  *) die "unknown command '$1' (install, start, stop, status, env, up)" ;;
esac
