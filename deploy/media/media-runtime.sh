#!/bin/sh
# Start-up step of the media origin (nginx's /docker-entrypoint.d, runs as
# the nginx user before nginx starts): writes /tmp/runtime/media.conf.
#
#   CDN_SIGNING_KEY      the key the API signs media links with (16+ chars)
#   S3_BUCKET_MEDIA      the media bucket
#   MEDIA_ORIGIN         the object store, host:port (default minio:9000)
#   MEDIA_ORIGIN_SECRET  sent as Referer; the bucket policy serves anonymous
#                        reads only with it (letters, digits, _ and -, 32+)
set -eu

fail() {
  echo "media-runtime: $*" >&2
  exit 1
}

key="${CDN_SIGNING_KEY:-}"
[ "${#key}" -ge 16 ] || fail "CDN_SIGNING_KEY must be set (16+ characters)"
bucket="${S3_BUCKET_MEDIA:-}"
case "$bucket" in '' | *[!a-z0-9.-]*) fail "S3_BUCKET_MEDIA must be an S3 bucket name" ;; esac
origin="${MEDIA_ORIGIN:-minio:9000}"
case "$origin" in '' | *[!A-Za-z0-9.:-]* | :* | *:) fail "MEDIA_ORIGIN must be host:port" ;; esac
secret="${MEDIA_ORIGIN_SECRET:-}"
case "$secret" in '' | *[!A-Za-z0-9_-]*) fail "MEDIA_ORIGIN_SECRET must be letters, digits, _ or -" ;; esac
[ "${#secret}" -ge 32 ] || fail "MEDIA_ORIGIN_SECRET must be at least 32 characters"

out="${RUNTIME_DIR:-/tmp/runtime}"
mkdir -p "$out"
umask 077
sed -e "s#@ORIGIN@#$origin#g" -e "s#@BUCKET@#$bucket#g" -e "s#@ORIGIN_SECRET@#$secret#g" \
  "${MEDIA_TEMPLATE:-/etc/nginx/media.conf.template}" > "$out/media.conf.tmp"
mv "$out/media.conf.tmp" "$out/media.conf"
echo "media-runtime: bucket $bucket at $origin" >&2
