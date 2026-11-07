# syntax=docker/dockerfile:1.7
#
# Valkey with the three roles of the key-value layer (deploy/valkey/): one
# image, the role chosen at start with KV_ROLE (core, cache, rt). Build
# context: the repository root.
ARG VALKEY_IMAGE=valkey/valkey:8.1.11-alpine
FROM ${VALKEY_IMAGE}
COPY deploy/valkey/kv-core.conf deploy/valkey/kv-cache.conf deploy/valkey/kv-rt.conf /etc/valkey/
COPY --chmod=0755 deploy/valkey/start.sh /usr/local/bin/kv-start
# The image's /data belongs to the valkey user, and a new named volume takes
# that ownership over.
USER valkey
WORKDIR /data
EXPOSE 6379
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD REDISCLI_AUTH="$KV_PASSWORD" valkey-cli -p 6379 ping | grep -q PONG || exit 1
ENTRYPOINT ["tini", "--", "/usr/local/bin/kv-start"]
CMD []
