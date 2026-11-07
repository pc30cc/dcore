# syntax=docker/dockerfile:1.7
#
# Centrifugo v6 with the channel configuration of deploy/centrifugo/; the
# secrets, the Redis engine address and the allowed origins come from the
# environment at start (deploy/centrifugo/start.sh). Port 8000: client
# WebSocket (public, /connection/websocket); port 9000: server API and
# /health (internal only). Build context: the repository root.
ARG CENTRIFUGO_IMAGE=centrifugo/centrifugo:v6.10.2
FROM ${CENTRIFUGO_IMAGE}
COPY deploy/centrifugo/config.json /centrifugo/config.json
COPY --chmod=0755 deploy/centrifugo/start.sh /usr/local/bin/centrifugo-start
EXPOSE 8000 9000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:9000/health || exit 1
ENTRYPOINT ["/usr/local/bin/centrifugo-start"]
CMD []
