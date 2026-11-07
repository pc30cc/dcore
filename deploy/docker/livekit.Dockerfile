# syntax=docker/dockerfile:1.7
#
# LiveKit server whose configuration (deploy/livekit/livekit.yaml) is filled
# from the environment at start (deploy/livekit/start.sh). Build context: the
# repository root.
ARG LIVEKIT_IMAGE=livekit/livekit-server:v1.13.11
FROM ${LIVEKIT_IMAGE}
COPY deploy/livekit/livekit.yaml /etc/livekit/livekit.yaml.tpl
COPY --chmod=0755 deploy/livekit/start.sh /usr/local/bin/livekit-start
# Unprivileged: every port it binds is above 1024.
USER 65534:65534
EXPOSE 7880
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:7880/ || exit 1
ENTRYPOINT ["/usr/local/bin/livekit-start"]
