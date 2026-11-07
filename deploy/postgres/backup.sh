#!/usr/bin/env bash
# Logical backup of the application database, run inside the PostgreSQL
# container (a scheduled task, or by hand):
#
#   pg-backup
#
# pg_dump in custom format, encrypted with BACKUP_PASSPHRASE (OpenPGP
# symmetric, AES-256), written to BACKUP_DIR (a volume; default /backups),
# copies older than BACKUP_KEEP_DAYS (default 14) removed. When BACKUP_S3_URL
# is set (https://<endpoint>/<bucket>/<prefix>), the encrypted file is also
# uploaded there with AWS Signature V4 (BACKUP_S3_ACCESS_KEY_ID,
# BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_REGION): the copy off this server.
#
# Restore: gpg --decrypt <file> | pg_restore -d <database> (see the owner's
# guide). This is a daily logical copy; point-in-time recovery needs WAL
# archiving, which this image does not configure.
set -Eeuo pipefail

db="${PG_DATABASE:-app}"
dir="${BACKUP_DIR:-/backups}"
keep_days="${BACKUP_KEEP_DAYS:-14}"
passphrase="${BACKUP_PASSPHRASE:-}"

if [ "${#passphrase}" -lt 20 ]; then
  echo "pg-backup: BACKUP_PASSPHRASE must be set (at least 20 characters)" >&2
  exit 64
fi
case "$keep_days" in '' | *[!0-9]*) echo "pg-backup: BACKUP_KEEP_DAYS must be a number" >&2; exit 64 ;; esac

mkdir -p "$dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$dir/$db-$stamp.dump.gpg"
partial="$file.partial"

umask 077
# The passphrase goes through a file descriptor, never the command line.
pg_dump --host "${PGHOST_SOCKET:-/var/run/postgresql}" --username "${POSTGRES_USER:-postgres}" \
    --dbname "$db" --format custom --compress 6 --no-password \
  | gpg --batch --yes --quiet --no-tty --pinentry-mode loopback --passphrase-fd 3 \
      --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 \
      --compress-algo none --output "$partial" 3<<<"$passphrase"
mv "$partial" "$file"
size="$(stat -c %s "$file")"
echo "pg-backup: wrote $file ($size bytes)"

if [ -n "${BACKUP_S3_URL:-}" ]; then
  : "${BACKUP_S3_ACCESS_KEY_ID:?BACKUP_S3_ACCESS_KEY_ID is required with BACKUP_S3_URL}"
  : "${BACKUP_S3_SECRET_ACCESS_KEY:?BACKUP_S3_SECRET_ACCESS_KEY is required with BACKUP_S3_URL}"
  region="${BACKUP_S3_REGION:-us-east-1}"
  target="${BACKUP_S3_URL%/}/$(basename "$file")"
  # The credentials reach curl through a config on stdin, not its arguments.
  printf 'user = "%s:%s"\n' "$BACKUP_S3_ACCESS_KEY_ID" "$BACKUP_S3_SECRET_ACCESS_KEY" \
    | curl --fail --silent --show-error --config - \
        --aws-sigv4 "aws:amz:$region:s3" \
        --header "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
        --upload-file "$file" "$target"
  echo "pg-backup: uploaded to ${target%%\?*}"
fi

find "$dir" -maxdepth 1 -type f -name "$db-*.dump.gpg" -mtime +"$keep_days" -print -delete \
  | sed 's/^/pg-backup: removed /'
find "$dir" -maxdepth 1 -type f -name '*.partial' -mmin +360 -delete
