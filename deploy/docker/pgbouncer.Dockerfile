# syntax=docker/dockerfile:1.7
#
# PgBouncer (transaction mode) whose configuration and userlist are written
# from the environment at start (deploy/pgbouncer/). Build context: the
# repository root.
ARG PGBOUNCER_IMAGE=edoburu/pgbouncer:v1.26.1-p0
FROM ${PGBOUNCER_IMAGE}

COPY deploy/pgbouncer/pgbouncer.ini /etc/pgbouncer/pgbouncer.ini.tpl
COPY --chmod=0755 deploy/pgbouncer/entrypoint.sh /usr/local/bin/pgbouncer-entrypoint
# The image runs as postgres, which owns /etc/pgbouncer.
USER postgres
EXPOSE 6432
# pg_isready only needs an answer to the startup packet, not a login.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD pg_isready -q -h 127.0.0.1 -p 6432 -U app_api -d "${PG_DATABASE:-app}" || exit 1
ENTRYPOINT ["/usr/local/bin/pgbouncer-entrypoint"]
CMD []
