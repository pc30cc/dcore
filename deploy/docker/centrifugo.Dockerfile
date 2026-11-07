# syntax=docker/dockerfile:1.7
#
# Centrifugo v6 with the channel configuration of deploy/centrifugo/. The
# secrets, the Redis engine address and the allowed origins come from the
# environment (CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY, CENTRIFUGO_HTTP_API_KEY,
# CENTRIFUGO_ENGINE_REDIS_ADDRESS, CENTRIFUGO_CLIENT_ALLOWED_ORIGINS), which
# Centrifugo reads over the file. Port 8000: client WebSocket (public);
# port 9000: server API and /health (internal only). Build context: the
# repository root.
ARG CENTRIFUGO_IMAGE=centrifugo/centrifugo:v6.10.2
FROM ${CENTRIFUGO_IMAGE}
COPY deploy/centrifugo/config.json /centrifugo/config.json
EXPOSE 8000 9000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:9000/health || exit 1
CMD ["centrifugo", "--config=/centrifugo/config.json"]
