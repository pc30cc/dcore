#!/usr/bin/env bash
# Runs once, when the postgres volume is created (docker-entrypoint-initdb.d).
# Creates the application role and databases, and sets the role's timeouts:
# behind PgBouncer in transaction mode a client cannot set them per session,
# so every server connection opened for this role gets them from here.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres \
  -v app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE app LOGIN CREATEDB PASSWORD :'app_password';
ALTER ROLE app SET statement_timeout = '5s';
ALTER ROLE app SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE app SET lock_timeout = '3s';
CREATE DATABASE app_dev OWNER app;
CREATE DATABASE app_test OWNER app;
SQL

# Extensions need a superuser; created ahead so migrations' CREATE EXTENSION
# IF NOT EXISTS run as the owner role. This image has PostGIS (and pgcrypto,
# citext from contrib), not pgvector.
for db in app_dev app_test; do
  psql -v ON_ERROR_STOP=1 --username postgres --dbname "$db" <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
SQL
done
