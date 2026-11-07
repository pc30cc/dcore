# syntax=docker/dockerfile:1.7
#
# One-shot set-up job of the bundled object store (deploy/storage/bootstrap.sh).
# Build context: the repository root.
ARG MC_IMAGE=pgsty/mc:RELEASE.2026-10-26T00-00-00Z
FROM ${MC_IMAGE}
COPY --chmod=0755 deploy/storage/bootstrap.sh /usr/local/bin/storage-bootstrap
USER 65534:65534
ENTRYPOINT ["/bin/sh", "/usr/local/bin/storage-bootstrap"]
