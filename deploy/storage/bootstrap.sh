#!/bin/sh
# One-shot set-up of the bundled object store (MinIO), safe to run on every
# deploy: it converges to the same state each time.
#
#   - the private bucket (uploads) and the media bucket (processed variants),
#     neither publicly listable or writable;
#   - a lifecycle rule on the private bucket: u/ objects expire after a day;
#   - the application's own access key, limited to those two buckets;
#   - anonymous reads of the media bucket only with the media origin's secret
#     Referer, so objects are reachable through the signed media origin and
#     not straight from the store's public address.
#
# Environment: MINIO_URL (default http://minio:9000), MINIO_ROOT_USER,
# MINIO_ROOT_PASSWORD, S3_BUCKET_PRIVATE, S3_BUCKET_MEDIA, APP_S3_ACCESS_KEY_ID,
# APP_S3_SECRET_ACCESS_KEY, MEDIA_ORIGIN_SECRET.
set -eu

fail() {
  echo "storage bootstrap: $*" >&2
  exit 64
}

need() {
  eval "_v=\${$1:-}"
  [ -n "$_v" ] || fail "$1 is not set"
}

url="${MINIO_URL:-http://minio:9000}"
for name in MINIO_ROOT_USER MINIO_ROOT_PASSWORD S3_BUCKET_PRIVATE S3_BUCKET_MEDIA \
  APP_S3_ACCESS_KEY_ID APP_S3_SECRET_ACCESS_KEY MEDIA_ORIGIN_SECRET; do
  need "$name"
done
for bucket in "$S3_BUCKET_PRIVATE" "$S3_BUCKET_MEDIA"; do
  case "$bucket" in *[!a-z0-9.-]* | ?) fail "bad bucket name $bucket" ;; esac
done
[ "$S3_BUCKET_PRIVATE" != "$S3_BUCKET_MEDIA" ] || fail "S3_BUCKET_PRIVATE and S3_BUCKET_MEDIA must differ"
case "$MEDIA_ORIGIN_SECRET" in *[!A-Za-z0-9_-]*) fail "MEDIA_ORIGIN_SECRET must be letters, digits, _ or -" ;; esac
case "$APP_S3_ACCESS_KEY_ID" in *[!A-Za-z0-9_-]*) fail "APP_S3_ACCESS_KEY_ID must be letters, digits, _ or -" ;; esac
[ "${#APP_S3_SECRET_ACCESS_KEY}" -ge 8 ] || fail "APP_S3_SECRET_ACCESS_KEY must be at least 8 characters"

export MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/.mc}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077

tries=0
until mc alias set store "$url" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || fail "the object store at $url did not answer within 2 minutes"
  sleep 2
done

mc mb --ignore-existing "store/$S3_BUCKET_PRIVATE" "store/$S3_BUCKET_MEDIA"

cat > "$work/lifecycle.json" <<JSON
{"Rules":[{"ID":"expire-uploads","Status":"Enabled","Filter":{"Prefix":"u/"},"Expiration":{"Days":1}}]}
JSON
mc ilm import "store/$S3_BUCKET_PRIVATE" < "$work/lifecycle.json"

mc anonymous set none "store/$S3_BUCKET_PRIVATE"
cat > "$work/media-read.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"AWS": ["*"]},
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET_MEDIA/*"],
      "Condition": {"StringEquals": {"aws:Referer": ["$MEDIA_ORIGIN_SECRET"]}}
    }
  ]
}
JSON
mc anonymous set-json "$work/media-read.json" "store/$S3_BUCKET_MEDIA"

cat > "$work/app-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET_PRIVATE", "arn:aws:s3:::$S3_BUCKET_MEDIA"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET_PRIVATE/*", "arn:aws:s3:::$S3_BUCKET_MEDIA/*"]
    }
  ]
}
JSON
mc admin policy create store app-storage "$work/app-policy.json"
# Adding an existing user sets its secret again, so a changed secret applies.
mc admin user add store "$APP_S3_ACCESS_KEY_ID" "$APP_S3_SECRET_ACCESS_KEY" >/dev/null
if ! out=$(mc admin policy attach store app-storage --user "$APP_S3_ACCESS_KEY_ID" 2>&1); then
  case "$out" in
    *already*) ;;
    *) printf '%s\n' "$out" >&2; fail "could not attach the application policy" ;;
  esac
fi

echo "storage bootstrap: buckets $S3_BUCKET_PRIVATE and $S3_BUCKET_MEDIA ready" >&2
