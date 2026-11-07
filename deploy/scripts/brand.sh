#!/bin/sh
# Writes <BRANDS_DIR>/<BRAND>/brand.json from BRAND_JSON_BASE64 (the base64 of
# a brand.json), so a brand can be supplied by the deployment instead of the
# repository. Does nothing when BRAND_JSON_BASE64 is empty: the brand then
# comes from the repository's brands/<BRAND>/ folder.
#
#   BRANDS_DIR=/path BRAND=<id> BRAND_JSON_BASE64=<base64> brand.sh
set -eu

if [ -z "${BRAND_JSON_BASE64:-}" ]; then
  exit 0
fi

brand="${BRAND:-}"
case "$brand" in
  '' | _template | -* | *[!a-z0-9_-]*)
    echo "brand.sh: BRAND must be a brand id (a-z, 0-9, _ and -, not _template) when BRAND_JSON_BASE64 is set" >&2
    exit 64
    ;;
esac
if [ "${#brand}" -gt 40 ]; then
  echo "brand.sh: BRAND is longer than 40 characters" >&2
  exit 64
fi

dir="${BRANDS_DIR:?BRANDS_DIR is not set}/$brand"
mkdir -p "$dir"
# Whitespace and line breaks are allowed in the variable (some UIs wrap long values).
if ! printf '%s' "$BRAND_JSON_BASE64" | tr -d ' \t\r\n' | base64 -d > "$dir/brand.json.tmp" 2>/dev/null; then
  rm -f "$dir/brand.json.tmp"
  echo "brand.sh: BRAND_JSON_BASE64 is not valid base64" >&2
  exit 65
fi
if [ "$(head -c 1 "$dir/brand.json.tmp")" != '{' ]; then
  rm -f "$dir/brand.json.tmp"
  echo "brand.sh: BRAND_JSON_BASE64 does not decode to a JSON object" >&2
  exit 65
fi
mv "$dir/brand.json.tmp" "$dir/brand.json"
echo "brand.sh: wrote $dir/brand.json" >&2
