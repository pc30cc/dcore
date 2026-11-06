#!/usr/bin/env bash
# Proves the two store builds carry only their own store's SDK.
#
#   tools/check-store-separation.sh BAZAAR_APK PLAY_APK
#   tools/check-store-separation.sh              (the debug APKs under app/build/outputs/apk)
#
# Builds nothing. Reads every classes*.dex of each APK with the SDK's dexdump
# and fails when:
#   - the Google Play APK holds any class under ir/cafebazaar/ or com/farsitel/
#     (Cafe Bazaar's Poolakey and the Bazaar app's own packages), or
#   - the Cafe Bazaar APK holds any class under com/android/billingclient/ or
#     com/google/android/play/ (Play Billing and Play Core: review, updates,
#     integrity).
# Each store reviews for the other's billing: Play rejects an app with another
# store's payment SDK, Cafe Bazaar one with Google's.
#
# It also checks that each APK DOES hold its own store's SDK, so a dexdump
# that read nothing, or a wrong file, cannot pass as clean.
#
# dexdump is found under $ANDROID_HOME (or $ANDROID_SDK_ROOT, or sdk.dir in
# local.properties), newest build-tools first.
#
# Exit status: 0 clean, 1 a violation, 2 a usage or tool error.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android_dir="$(dirname "$here")"

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

if [[ $# -eq 0 ]]; then
  bazaar_apk="$android_dir/app/build/outputs/apk/bazaar/debug/app-bazaar-debug.apk"
  play_apk="$android_dir/app/build/outputs/apk/play/debug/app-play-debug.apk"
elif [[ $# -eq 2 ]]; then
  bazaar_apk="$1"
  play_apk="$2"
else
  usage
fi

for apk in "$bazaar_apk" "$play_apk"; do
  [[ -f "$apk" ]] || { echo "error: no APK at $apk (build it first: ./gradlew :app:assembleBazaarDebug :app:assemblePlayDebug)" >&2; exit 2; }
done

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk" && -f "$android_dir/local.properties" ]]; then
  sdk="$(sed -n 's/^sdk\.dir=//p' "$android_dir/local.properties" | tail -n 1)"
fi
[[ -n "$sdk" && -d "$sdk/build-tools" ]] || { echo "error: Android SDK not found: set ANDROID_HOME" >&2; exit 2; }
dexdump="$(ls -d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1)dexdump"
[[ -x "$dexdump" ]] || { echo "error: dexdump not found in $sdk/build-tools" >&2; exit 2; }
command -v unzip >/dev/null || { echo "error: unzip is required" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Every class descriptor in an APK, one per line, as a path: ir/cafebazaar/poolakey/Payment
classes_of() {
  local apk="$1" out="$work/$2"
  mkdir -p "$out"
  unzip -q -o "$apk" 'classes*.dex' -d "$out" || { echo "error: no classes*.dex in $apk" >&2; exit 2; }
  local dex
  for dex in "$out"/classes*.dex; do
    "$dexdump" "$dex" 2>/dev/null | sed -n "s/^  Class descriptor  : 'L\(.*\);'$/\1/p"
  done | sort -u
}

bazaar_classes="$(classes_of "$bazaar_apk" bazaar)"
play_classes="$(classes_of "$play_apk" play)"

status=0

# check NAME CLASSES REGEX MESSAGE: fails when any class matches
forbid() {
  local name="$1" classes="$2" pattern="$3" what="$4" hits
  hits="$(grep -E "$pattern" <<<"$classes" || true)"
  if [[ -n "$hits" ]]; then
    echo "FAIL: the $name APK contains $(wc -l <<<"$hits") $what class(es), e.g.:"
    head -n 10 <<<"$hits" | sed 's/^/  /'
    status=1
  else
    echo "ok:   the $name APK has no $what classes"
  fi
}

# require NAME CLASSES REGEX MESSAGE: fails when no class matches (the check would be vacuous)
require() {
  local name="$1" classes="$2" pattern="$3" what="$4" count
  count="$(grep -cE "$pattern" <<<"$classes" || true)"
  if [[ "$count" -eq 0 ]]; then
    echo "FAIL: the $name APK has no $what classes at all: wrong APK, or dexdump read nothing"
    status=1
  else
    echo "ok:   the $name APK has its own $what ($count classes)"
  fi
}

bazaar_sdk='^(ir/cafebazaar/|com/farsitel/)'
play_sdk='^(com/android/billingclient/|com/google/android/play/)'

echo "Cafe Bazaar APK: $bazaar_apk ($(wc -l <<<"$bazaar_classes") classes)"
require bazaar "$bazaar_classes" '^ir/cafebazaar/poolakey/' "Poolakey"
forbid bazaar "$bazaar_classes" "$play_sdk" "Google Play (com.android.billingclient, com.google.android.play)"

echo "Google Play APK: $play_apk ($(wc -l <<<"$play_classes") classes)"
require play "$play_classes" '^com/android/billingclient/' "Play Billing"
forbid play "$play_classes" "$bazaar_sdk" "Cafe Bazaar (ir.cafebazaar, com.farsitel)"

if [[ $status -eq 0 ]]; then
  echo "Store separation: clean."
else
  echo "Store separation: FAILED. A store SDK reached the other store's build: check that it is a"
  echo "bazaarImplementation / playImplementation dependency and that src/main does not import it."
fi
exit $status
