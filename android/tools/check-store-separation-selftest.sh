#!/usr/bin/env bash
# Proves tools/check-store-separation.sh catches what it is meant to catch.
#
#   tools/check-store-separation-selftest.sh            (the debug APKs)
#   tools/check-store-separation-selftest.sh --release  (the release APKs and their R8 mappings)
#
# Runs the check on the real APKs (it must pass), then on copies of them with
# one violation planted at a time (each must fail, on the line that names
# it): another store's string in the resources (UTF-8 and UTF-16), in the
# app's own code and in another library's, another store's class, a Play
# Store dialog called from the app's code, and the other store's merged
# manifest. Needs javac, the SDK's
# d8, zip and unzip. Builds nothing of the app; writes only to a temporary
# directory.
#
# Exit status: 0 every case as expected, 1 a case was not caught (or the real
# APKs did not pass), 2 a usage or tool error.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android_dir="$(dirname "$here")"
check="$here/check-store-separation.sh"
outputs="$android_dir/app/build/outputs"

mode=debug
case "${1:-}" in
  "") ;;
  --release) mode=release ;;
  *) sed -n '2,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

if [[ $mode == release ]]; then
  bazaar_apk="$outputs/apk/bazaar/release/app-bazaar-release-unsigned.apk"
  play_apk="$outputs/apk/play/release/app-play-release-unsigned.apk"
  maps=(--bazaar-mapping "$outputs/mapping/bazaarRelease/mapping.txt" --play-mapping "$outputs/mapping/playRelease/mapping.txt")
else
  bazaar_apk="$outputs/apk/bazaar/debug/app-bazaar-debug.apk"
  play_apk="$outputs/apk/play/debug/app-play-debug.apk"
  maps=()
fi
for apk in "$bazaar_apk" "$play_apk"; do
  [[ -f "$apk" ]] || { echo "error: no APK at $apk (build it first)" >&2; exit 2; }
done

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk" && -f "$android_dir/local.properties" ]]; then
  sdk="$(sed -n 's/^sdk\.dir=//p' "$android_dir/local.properties" | tail -n 1)"
fi
d8="$(ls -d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1)d8"
[[ -x "$d8" ]] || { echo "error: d8 not found in \$ANDROID_HOME/build-tools" >&2; exit 2; }
for tool in javac zip unzip; do command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 2; }; done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A dex holding one class compiled from Java source: dex NAME SOURCE_FILE...
dex() {
  local name="$1"
  shift
  mkdir -p "$work/src-$name" "$work/classes-$name" "$work/dex-$name"
  javac -nowarn -source 8 -target 8 -d "$work/classes-$name" "$@" 2>/dev/null
  # Only the planted class: the stubs it was compiled against stay out of the dex.
  find "$work/classes-$name" -name '*.class' -not -path '*com/google/android/gms/*' > "$work/list-$name"
  "$d8" --min-api 24 --output "$work/dex-$name" $(cat "$work/list-$name") >/dev/null 2>&1
  echo "$work/dex-$name/classes.dex"
}

# A copy of APK with FILE added at PATH_IN_APK: plant APK OUT PATH_IN_APK FILE
plant() {
  local apk="$1" out="$2" path="$3" file="$4"
  cp "$apk" "$out"
  mkdir -p "$work/zip/$(dirname "$path")"
  cp "$file" "$work/zip/$path"
  (cd "$work/zip" && zip -q "$out" "$path")
  rm -rf "$work/zip"
}

# The APK's own manifest swapped for another APK's: swap APK OUT DONOR
swap_manifest() {
  local apk="$1" out="$2" donor="$3"
  cp "$apk" "$out"
  mkdir -p "$work/donor"
  unzip -q -o "$donor" AndroidManifest.xml -d "$work/donor"
  (cd "$work/donor" && zip -q "$out" AndroidManifest.xml)
  rm -rf "$work/donor"
}

failures=0

# expect NAME CODE PATTERN BAZAAR PLAY: the check exits CODE and (when CODE is 1) prints a FAIL line matching PATTERN
expect() {
  local name="$1" code="$2" pattern="$3" got=0
  bash "$check" "$4" "$5" "${maps[@]}" > "$work/out.txt" 2>&1 || got=$?
  if [[ $got -ne $code ]]; then
    echo "NOT CAUGHT: $name (exit $got, expected $code)"
    sed 's/^/  /' "$work/out.txt"
    failures=$((failures + 1))
  elif [[ $code -eq 1 ]] && ! grep -E "^FAIL: .*$pattern" "$work/out.txt" >/dev/null; then
    echo "WRONG REASON: $name (no FAIL line matching '$pattern')"
    sed 's/^/  /' "$work/out.txt"
    failures=$((failures + 1))
  else
    echo "as expected: $name${pattern:+ ($(grep -E "^FAIL: .*$pattern" "$work/out.txt" | head -n 1 | cut -c7-))}"
  fi
}

mkdir -p "$work/java/app/core" "$work/java/ir/cafebazaar/poolakey" "$work/java/com/google/android/gms/common" "$work/java/com/example/rate" "$work/apks"

cat > "$work/java/app/core/PlantedPlayLink.java" <<'EOF'
package app.core;
public final class PlantedPlayLink {
    public static String link() { return "https://play.google.com/store/apps/details?id=planted"; }
}
EOF
cat > "$work/java/app/core/PlantedBazaarLink.java" <<'EOF'
package app.core;
public final class PlantedBazaarLink {
    public static String link() { return "bazaar://details?id=planted"; }
}
EOF
cat > "$work/java/com/google/android/gms/common/GoogleApiAvailability.java" <<'EOF'
package com.google.android.gms.common;
public class GoogleApiAvailability {
    public static GoogleApiAvailability getInstance() { return null; }
    public Object getErrorDialog(Object activity, int code, int request) { return null; }
}
EOF
cat > "$work/java/app/core/PlantedDialog.java" <<'EOF'
package app.core;
import com.google.android.gms.common.GoogleApiAvailability;
public final class PlantedDialog {
    public static Object show(Object activity) { return GoogleApiAvailability.getInstance().getErrorDialog(activity, 1, 0); }
}
EOF
cat > "$work/java/ir/cafebazaar/poolakey/PlantedPayment.java" <<'EOF'
package ir.cafebazaar.poolakey;
public final class PlantedPayment {}
EOF
cat > "$work/java/com/example/rate/RateLink.java" <<'EOF'
package com.example.rate;
public final class RateLink {
    public static String link() { return "market://details?id=planted"; }
}
EOF

play_link_dex="$(dex playlink "$work/java/app/core/PlantedPlayLink.java")"
bazaar_link_dex="$(dex bazaarlink "$work/java/app/core/PlantedBazaarLink.java")"
dialog_dex="$(dex dialog "$work/java/app/core/PlantedDialog.java" "$work/java/com/google/android/gms/common/GoogleApiAvailability.java")"
poolakey_dex="$(dex poolakey "$work/java/ir/cafebazaar/poolakey/PlantedPayment.java")"
library_link_dex="$(dex librarylink "$work/java/com/example/rate/RateLink.java")"

printf 'open market://details?id=planted\n' > "$work/market.txt"
printf 'c\0a\0f\0e\0b\0a\0z\0a\0a\0r\0.\0i\0r\0' > "$work/bazaar16.txt"

echo "Store separation self-test ($mode APKs)"
expect "the real builds pass" 0 "" "$bazaar_apk" "$play_apk"

plant "$bazaar_apk" "$work/apks/b1.apk" res/raw/planted_link.txt "$work/market.txt"
expect "bazaar: market:// in a resource" 1 "bazaar APK's resources" "$work/apks/b1.apk" "$play_apk"

plant "$bazaar_apk" "$work/apks/b2.apk" classes99.dex "$play_link_dex"
expect "bazaar: a Play Store link in the app's own code" 1 "bazaar APK.s code" "$work/apks/b2.apk" "$play_apk"

plant "$bazaar_apk" "$work/apks/b3.apk" classes99.dex "$dialog_dex"
expect "bazaar: the app calls GoogleApiAvailability.getErrorDialog" 1 "Play Store dialogs" "$work/apks/b3.apk" "$play_apk"

plant "$bazaar_apk" "$work/apks/b5.apk" classes99.dex "$library_link_dex"
expect "bazaar: market:// in another library's class (R8 can merge app code into one)" 1 "bazaar APK.s code" "$work/apks/b5.apk" "$play_apk"

swap_manifest "$bazaar_apk" "$work/apks/b4.apk" "$play_apk"
expect "bazaar: the Play build's manifest (BILLING permission)" 1 "bazaar APK's merged manifest" "$work/apks/b4.apk" "$play_apk"

plant "$play_apk" "$work/apks/p1.apk" assets/planted.txt "$work/bazaar16.txt"
expect "play: cafebazaar.ir in an asset, as UTF-16" 1 "play APK's resources" "$bazaar_apk" "$work/apks/p1.apk"

plant "$play_apk" "$work/apks/p2.apk" classes99.dex "$bazaar_link_dex"
expect "play: bazaar:// in the dex" 1 "play APK's dex" "$bazaar_apk" "$work/apks/p2.apk"

plant "$play_apk" "$work/apks/p3.apk" classes99.dex "$poolakey_dex"
expect "play: a Poolakey class" 1 "play APK contains" "$bazaar_apk" "$work/apks/p3.apk"

swap_manifest "$play_apk" "$work/apks/p4.apk" "$bazaar_apk"
expect "play: the Bazaar build's manifest (PAY_THROUGH_BAZAAR, receiver)" 1 "play APK's merged manifest" "$bazaar_apk" "$work/apks/p4.apk"

if [[ $failures -eq 0 ]]; then
  echo "Self-test: every planted violation was caught, and the real builds pass."
  exit 0
fi
echo "Self-test: $failures case(s) not as expected."
exit 1
