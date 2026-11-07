# Shell helpers (POSIX sh, sourced) that turn the public addresses handed to
# a container into the exact values the processes expect.
#
# The deployment passes each public address as a variable whose value is a
# URL or a bare host (https://api.example.com, api.example.com, a list such as
# "https://a.example.com,https://b.example.com", or empty). Public endpoints
# are always served on 443 behind the reverse proxy, so a port in the value
# names the container port the proxy forwards to and is dropped.

# url_host <value>: the first host of the value, lower case, or nothing.
# Fails when the value is set but does not hold a host name.
url_host() {
  _v=$(printf '%s' "${1:-}" | tr -d '\r\n')
  _v=${_v%%,*}
  _v=$(printf '%s' "$_v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$_v" ] || return 0
  _v=${_v#*://}
  _v=${_v%%/*}
  _v=${_v%%\?*}
  _v=${_v%%:*}
  _v=$(printf '%s' "$_v" | tr 'A-Z' 'a-z')
  case "$_v" in
    '' | -* | *[!a-z0-9.-]* | *..* | .* | *.)
      echo "public-urls: \"${1}\" is not a host name or URL" >&2
      return 1
      ;;
  esac
  case "$_v" in *.*) ;; localhost) ;; *)
    echo "public-urls: \"${1}\" is not a fully qualified host name" >&2
    return 1
    ;;
  esac
  printf '%s' "$_v"
}

# url_origin <value> [scheme]: https://<host> (or <scheme>://<host>), or nothing.
url_origin() {
  _h=$(url_host "${1:-}") || return 1
  [ -n "$_h" ] || return 0
  printf '%s://%s' "${2:-https}" "$_h"
}

# set_default <NAME> <value>: exports NAME=value when NAME is unset or empty
# and value is not empty.
set_default() {
  eval "_cur=\${$1:-}"
  if [ -z "$_cur" ] && [ -n "${2:-}" ]; then
    export "$1=$2"
  fi
}

# storage_defaults: when S3_ENDPOINT is empty, points S3_* at the bundled
# object store (BUNDLED_S3_URL, BUNDLED_S3_ACCESS_KEY_ID,
# BUNDLED_S3_SECRET_ACCESS_KEY) and, when CDN_BASE_URL is empty too, CDN_* at
# the bundled media service (BUNDLED_CDN_URL, BUNDLED_CDN_SIGNING_KEY). The
# media service reads the bundled store only, so an external S3_ENDPOINT
# never gets it as its CDN: that store needs its own CDN_BASE_URL and
# CDN_SIGNING_KEY. An explicitly configured S3_ENDPOINT or CDN_BASE_URL
# always wins.
storage_defaults() {
  _bundled_s3=
  if [ -z "${S3_ENDPOINT:-}" ] && [ -n "${BUNDLED_S3_URL:-}" ]; then
    _s3=$(url_origin "$BUNDLED_S3_URL") || return 1
    export S3_ENDPOINT="$_s3"
    export S3_ACCESS_KEY_ID="${BUNDLED_S3_ACCESS_KEY_ID:-}"
    export S3_SECRET_ACCESS_KEY="${BUNDLED_S3_SECRET_ACCESS_KEY:-}"
    export S3_REGION="${BUNDLED_S3_REGION:-us-east-1}"
    export S3_PATH_STYLE=true
    _bundled_s3=1
  fi
  if [ -n "$_bundled_s3" ] && [ -z "${CDN_BASE_URL:-}" ] && [ -n "${BUNDLED_CDN_URL:-}" ]; then
    _cdn=$(url_origin "$BUNDLED_CDN_URL") || return 1
    export CDN_BASE_URL="$_cdn"
    export CDN_SIGNING_KEY="${BUNDLED_CDN_SIGNING_KEY:-}"
    export CDN_SIGNING_SCHEME=hmac
  fi
  unset BUNDLED_S3_ACCESS_KEY_ID BUNDLED_S3_SECRET_ACCESS_KEY BUNDLED_CDN_SIGNING_KEY
}
