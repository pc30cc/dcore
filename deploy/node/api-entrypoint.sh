#!/bin/sh
# API container entrypoint (runs under tini). When the deployment supplies the
# brand as BRAND_JSON_BASE64, writes it to a writable brands folder and points
# BRANDS_DIR at it; otherwise the image's brands/ (from the repository) is used.
set -eu

if [ -n "${BRAND_JSON_BASE64:-}" ]; then
  BRANDS_DIR=/tmp/brands
  export BRANDS_DIR
  /usr/local/bin/brand.sh
  unset BRAND_JSON_BASE64
fi

exec "$@"
