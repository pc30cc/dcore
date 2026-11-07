# syntax=docker/dockerfile:1.7
#
# PostgreSQL 17 with PostGIS 3.7, the role and database setup the
# migrations expect (applied on every start, before the container reports
# healthy) and the logical backup command `pg-backup`. Build context: the
# repository root.
ARG POSTGIS_IMAGE=postgis/postgis:17-3.7
FROM ${POSTGIS_IMAGE}

# gnupg encrypts backups; curl uploads them to S3-compatible storage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gnupg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0700 /backups

COPY --chmod=0755 deploy/postgres/roles.sh /usr/local/bin/pg-roles
COPY --chmod=0755 deploy/postgres/start.sh /usr/local/bin/pg-start
COPY --chmod=0755 deploy/postgres/backup.sh /usr/local/bin/pg-backup

STOPSIGNAL SIGINT
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD test -f /tmp/pg-roles.ok && pg_isready -q -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}" -d "${PG_DATABASE:-app}" || exit 1
ENTRYPOINT ["pg-start"]
CMD ["postgres"]
