#!/usr/bin/env bash
# Creates or updates, as the superuser, everything the migrations and the
# processes expect before the first migration: the roles, the database and
# its extensions. Idempotent: it runs on every start of the container (from
# start.sh), so a password changed in the environment is applied on the next
# start, and a role added here appears without a new volume.
#
# Roles:
#   app_owner    LOGIN   owns the database and the schema; migrations only,
#                        direct connection (never through PgBouncer)
#   app_rw       NOLOGIN DML group (grants come from the migrations)
#   app_ro       NOLOGIN read-only group (column grants in the migrations)
#   app_maint    NOLOGIN partition maintenance (EXECUTE grants in migrations)
#   app_api      LOGIN   member of app_rw; the API, through PgBouncer
#   app_worker   LOGIN   member of app_rw and app_maint; the worker
#   app_analyst  LOGIN   member of app_ro; only when PG_ANALYST_PASSWORD is set
#
# Behind PgBouncer in transaction mode a client cannot set session settings,
# so each login role carries its own timeouts.
#
# Environment: PG_DATABASE (default app), PG_OWNER_PASSWORD, PG_API_PASSWORD,
# PG_WORKER_PASSWORD, optional PG_ANALYST_PASSWORD, PG_EXTENSIONS (default
# "postgis pg_stat_statements"). Connects through the local socket.
set -Eeuo pipefail

db="${PG_DATABASE:-app}"
extensions="${PG_EXTENSIONS:-postgis pg_stat_statements}"

need() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    echo "pg-roles: $name is not set" >&2
    exit 64
  fi
  if [ "${#value}" -lt 16 ]; then
    echo "pg-roles: $name must be at least 16 characters" >&2
    exit 64
  fi
}
need PG_OWNER_PASSWORD
need PG_API_PASSWORD
need PG_WORKER_PASSWORD
if [ -n "${PG_ANALYST_PASSWORD:-}" ]; then need PG_ANALYST_PASSWORD; fi

case "$db" in
  '' | *[!a-z0-9_]*) echo "pg-roles: PG_DATABASE must be lowercase letters, digits and _" >&2; exit 64 ;;
esac

psql_super() {
  psql -X -q -v ON_ERROR_STOP=1 \
    --host "${PGHOST_SOCKET:-/var/run/postgresql}" --port "${PGPORT:-5432}" \
    --username "${POSTGRES_USER:-postgres}" "$@"
}

# Passwords travel as psql variables (quoted by psql). The session keeps the
# statements out of the server log and out of pg_stat_statements.
psql_super --dbname postgres \
  -v owner_password="$PG_OWNER_PASSWORD" \
  -v api_password="$PG_API_PASSWORD" \
  -v worker_password="$PG_WORKER_PASSWORD" \
  -v db="$db" <<'SQL'
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET pg_stat_statements.track_utility = off;

SELECT format('CREATE ROLE %I NOLOGIN', r)
  FROM unnest(ARRAY['app_rw', 'app_ro', 'app_maint']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

SELECT format('CREATE ROLE %I LOGIN', r)
  FROM unnest(ARRAY['app_owner', 'app_api', 'app_worker']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

ALTER ROLE app_owner  LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD :'owner_password';
ALTER ROLE app_api    LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD :'api_password';
ALTER ROLE app_worker LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD :'worker_password';

GRANT app_rw TO app_api;
GRANT app_rw, app_maint TO app_worker;

ALTER ROLE app_api    SET statement_timeout = '3s';
ALTER ROLE app_api    SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE app_api    SET lock_timeout = '2s';
ALTER ROLE app_worker SET statement_timeout = '30s';
ALTER ROLE app_worker SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE app_worker SET lock_timeout = '5s';

SELECT format('CREATE DATABASE %I OWNER app_owner ENCODING ''UTF8'' TEMPLATE template0', :'db')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO app_owner', :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO app_owner, app_rw, app_ro', :'db') \gexec
SQL

# The analyst login exists only while a password is configured; without one
# an existing analyst role loses LOGIN.
if [ -n "${PG_ANALYST_PASSWORD:-}" ]; then
  psql_super --dbname postgres -v analyst_password="$PG_ANALYST_PASSWORD" <<'SQL'
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET pg_stat_statements.track_utility = off;
SELECT 'CREATE ROLE app_analyst LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_analyst') \gexec
ALTER ROLE app_analyst LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION PASSWORD :'analyst_password';
GRANT app_ro TO app_analyst;
ALTER ROLE app_analyst SET statement_timeout = '60s';
ALTER ROLE app_analyst SET default_transaction_read_only = on;
SQL
else
  psql_super --dbname postgres <<'SQL'
SELECT 'ALTER ROLE app_analyst NOLOGIN'
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_analyst') \gexec
SQL
fi

# Extensions that are not trusted need the superuser, in the database itself;
# the migrations' CREATE EXTENSION IF NOT EXISTS then finds them.
for ext in $extensions; do
  case "$ext" in *[!a-z0-9_]*) echo "pg-roles: bad extension name $ext" >&2; exit 64 ;; esac
  psql_super --dbname "$db" -c "CREATE EXTENSION IF NOT EXISTS \"$ext\""
done

echo "pg-roles: roles, database $db and extensions ($extensions) are in place" >&2
