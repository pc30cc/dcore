#!/bin/sh
# Starts one Valkey instance in the role KV_ROLE (core, cache or rt) with the
# role's configuration plus, from the environment:
#
#   KV_PASSWORD   the instance's password (required, 16+ characters of
#                 letters, digits, _ and -, so it can sit in a redis:// URL)
#   KV_MAXMEMORY  memory cap (default per role: core 2gb, cache 1gb, rt 512mb)
#
# The configuration with the password is written to a file only the process
# user can read; the password never appears on a command line.
set -eu

fail() {
  echo "kv start: $*" >&2
  exit 64
}

role="${KV_ROLE:-}"
case "$role" in
  core) default_memory=2gb ;;
  cache) default_memory=1gb ;;
  rt) default_memory=512mb ;;
  *) fail "KV_ROLE must be core, cache or rt" ;;
esac

password="${KV_PASSWORD:-}"
case "$password" in '' | *[!A-Za-z0-9_-]*) fail "KV_PASSWORD must be letters, digits, _ or -" ;; esac
[ "${#password}" -ge 16 ] || fail "KV_PASSWORD must be at least 16 characters"

memory="${KV_MAXMEMORY:-$default_memory}"
case "$memory" in '' | *[!0-9kmgbKMGB]* | [!0-9]*) fail "KV_MAXMEMORY must look like 512mb or 2gb" ;; esac

umask 077
conf="${KV_CONFIG_OUT:-/tmp/valkey.conf}"
{
  cat "${KV_CONFIG_DIR:-/etc/valkey}/kv-$role.conf"
  printf '\nmaxmemory %s\nrequirepass %s\n' "$memory" "$password"
} > "$conf"

if [ -n "${KV_CONFIG_ONLY:-}" ]; then
  exit 0
fi
exec valkey-server "$conf"
