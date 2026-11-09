#!/usr/bin/env bash
# Proves the two store builds carry only their own store's SDK, links and texts.
#
#   tools/check-store-separation.sh BAZAAR_APK PLAY_APK [--bazaar-mapping FILE] [--play-mapping FILE]
#   tools/check-store-separation.sh              (the debug APKs under app/build/outputs/apk)
#   tools/check-store-separation.sh --release    (the minified release APKs and their R8 mappings)
#
# Builds nothing. Reads each APK's dex (the SDK's dexdump), merged manifest
# (aapt2) and resources (res/, resources.arsc, assets/, as UTF-8 and UTF-16)
# and fails when:
#   - the Google Play APK holds any class under ir/cafebazaar/ or com/farsitel/
#     (Poolakey, the Bazaar app's packages); its merged manifest names
#     com.farsitel.bazaar.permission.PAY_THROUGH_BAZAAR, a com.farsitel.bazaar
#     package or Poolakey's receiver; or its dex or resources hold the strings
#     ir.cafebazaar, com.farsitel.bazaar, cafebazaar.ir or bazaar://;
#   - the Cafe Bazaar APK holds any class under com/android/billingclient/ or
#     com/google/android/play/ (Play Billing, Play Core) or Google sign-in
#     (googleid, androidx.credentials, app/core/store/GoogleSignIn); its merged
#     manifest has the com.android.vending.BILLING permission or the strings
#     play.google.com/store or market://; its code (the app's own, app/core,
#     and every other library's) or its resources hold play.google.com/store
#     or market://; or code outside Play services' own classes references
#     GoogleApiAvailability.getErrorDialog, makeGooglePlayServicesAvailable or
#     showErrorDialogFragment (their dialogs open the Play Store).
# The string scan of the Bazaar APK does not read Play services' own classes:
# com/google/android/gms/** internals (GoogleApiAvailabilityLight's
# market://, which push brings) are allowed. It reads every other class,
# because R8 merges classes across packages in a release build: a string of
# app/core can end up in a class named after a library's. A minified APK is
# read through its R8 mapping (found next to the build's outputs, or
# passed); without it Play services' classes cannot be told apart and the
# check refuses to run.
#
# Each APK must also hold its own store's SDK, so a dexdump that read nothing,
# or a wrong file, cannot pass as clean.
#
# Exit status: 0 clean, 1 a violation, 2 a usage or tool error.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android_dir="$(dirname "$here")"
outputs="$android_dir/app/build/outputs"

usage() {
  sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

bazaar_apk=""
play_apk=""
bazaar_mapping=""
play_mapping=""
positional=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      bazaar_apk="$outputs/apk/bazaar/release/app-bazaar-release-unsigned.apk"
      [[ -f "$bazaar_apk" ]] || bazaar_apk="$outputs/apk/bazaar/release/app-bazaar-release.apk"
      play_apk="$outputs/apk/play/release/app-play-release-unsigned.apk"
      [[ -f "$play_apk" ]] || play_apk="$outputs/apk/play/release/app-play-release.apk"
      shift
      ;;
    --bazaar-mapping) bazaar_mapping="${2:-}"; shift 2 ;;
    --play-mapping) play_mapping="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) positional+=("$1"); shift ;;
  esac
done
if [[ ${#positional[@]} -eq 2 ]]; then
  bazaar_apk="${positional[0]}"
  play_apk="${positional[1]}"
elif [[ ${#positional[@]} -ne 0 ]]; then
  usage
fi
if [[ -z "$bazaar_apk" ]]; then
  bazaar_apk="$outputs/apk/bazaar/debug/app-bazaar-debug.apk"
  play_apk="$outputs/apk/play/debug/app-play-debug.apk"
fi

for apk in "$bazaar_apk" "$play_apk"; do
  [[ -f "$apk" ]] || { echo "error: no APK at $apk (build it first: ./gradlew :app:assembleBazaarDebug :app:assemblePlayDebug)" >&2; exit 2; }
done

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk" && -f "$android_dir/local.properties" ]]; then
  sdk="$(sed -n 's/^sdk\.dir=//p' "$android_dir/local.properties" | tail -n 1)"
fi
[[ -n "$sdk" && -d "$sdk/build-tools" ]] || { echo "error: Android SDK not found: set ANDROID_HOME" >&2; exit 2; }
tools_dir="$(ls -d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1)"
dexdump="${tools_dir}dexdump"
aapt2="${tools_dir}aapt2"
[[ -x "$dexdump" ]] || { echo "error: dexdump not found in $sdk/build-tools" >&2; exit 2; }
[[ -x "$aapt2" ]] || { echo "error: aapt2 not found in $sdk/build-tools" >&2; exit 2; }
command -v unzip >/dev/null || { echo "error: unzip is required" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The R8 mapping that belongs to a release APK under app/build/outputs, if any.
mapping_for() {
  local apk="$1" flavor type
  case "$apk" in
    */outputs/apk/*/release/*) ;;
    *) return 0 ;;
  esac
  flavor="$(basename "$(dirname "$(dirname "$apk")")")"
  type="$(basename "$(dirname "$apk")")"
  local candidate="$outputs/mapping/${flavor}${type^}/mapping.txt"
  [[ -f "$candidate" ]] && echo "$candidate"
  return 0
}
[[ -n "$bazaar_mapping" ]] || bazaar_mapping="$(mapping_for "$bazaar_apk")"
[[ -n "$play_mapping" ]] || play_mapping="$(mapping_for "$play_apk")"

# unpack NAME APK MAPPING: the APK's dex as text, its classes (original names), its manifest and resources.
#   $work/NAME/code.txt      dexdump -d of every classes*.dex
#   $work/NAME/classes.txt   class descriptors, original names, one per line
#   $work/NAME/strings.txt   "class<TAB>string" for every const-string, original class names
#   $work/NAME/manifest.txt  the merged manifest as aapt2 prints it
#   $work/NAME/files/        res/, resources.arsc and assets/
unpack() {
  local name="$1" apk="$2" mapping="$3" out="$work/$1"
  mkdir -p "$out/dex" "$out/files"
  unzip -q -o "$apk" 'classes*.dex' -d "$out/dex" || { echo "error: no classes*.dex in $apk" >&2; exit 2; }
  unzip -q -o "$apk" 'res/*' 'resources.arsc' 'assets/*' -d "$out/files" 2>/dev/null || true
  local dex
  for dex in "$out/dex"/classes*.dex; do
    "$dexdump" -d "$dex" 2>/dev/null
  done > "$out/code.txt"
  "$aapt2" dump xmltree --file AndroidManifest.xml "$apk" > "$out/manifest.txt" 2>/dev/null \
    || { echo "error: aapt2 could not read the manifest of $apk" >&2; exit 2; }

  # Obfuscated class -> original class (slash form), from the R8 mapping.
  : > "$out/classmap.txt"
  if [[ -n "$mapping" ]]; then
    awk '/^[^ #].* -> .*:$/ { o=$1; n=$3; sub(/:$/, "", n); gsub(/\./, "/", o); gsub(/\./, "/", n); print n, o }' "$mapping" > "$out/classmap.txt"
  fi

  awk -v mapfile="$out/classmap.txt" -v classes="$out/classes.txt" -v strings="$out/strings.txt" '
    BEGIN { while ((getline line < mapfile) > 0) { split(line, f, " "); orig[f[1]] = f[2] } }
    /^  Class descriptor  : / {
      d = $0; sub(/^  Class descriptor  : .L/, "", d); sub(/;.$/, "", d)
      cls = (d in orig) ? orig[d] : d
      print cls > classes
      next
    }
    /const-string(\/jumbo)? / {
      s = $0
      i = index(s, "\""); if (i == 0) next
      s = substr(s, i + 1)
      j = match(s, /" \/\/ string@/); if (j == 0) next
      print cls "\t" substr(s, 1, j - 1) > strings
    }
  ' "$out/code.txt"
  touch "$out/strings.txt"
  sort -u -o "$out/classes.txt" "$out/classes.txt"

  # A minified APK read without its mapping would make every class look like a library one.
  local unnamed total
  unnamed="$(grep -cv '/' "$out/classes.txt" || true)"
  total="$(wc -l < "$out/classes.txt")"
  if [[ -z "$mapping" && "$total" -gt 0 && $((unnamed * 4)) -gt "$total" ]]; then
    echo "error: $apk is minified ($unnamed of $total classes renamed) and its R8 mapping was not found; pass --${name}-mapping" >&2
    exit 2
  fi
}

unpack bazaar "$bazaar_apk" "$bazaar_mapping"
unpack play "$play_apk" "$play_mapping"

status=0

ok() { echo "ok:   $*"; }
fail() { echo "FAIL: $*"; status=1; }

# forbid_classes NAME REGEX WHAT: fails when any class matches
forbid_classes() {
  local name="$1" pattern="$2" what="$3" hits
  hits="$(grep -E "$pattern" "$work/$name/classes.txt" || true)"
  if [[ -n "$hits" ]]; then
    fail "the $name APK contains $(wc -l <<<"$hits") $what class(es), e.g.:"
    head -n 10 <<<"$hits" | sed 's/^/  /'
  else
    ok "the $name APK has no $what classes"
  fi
}

# require_classes NAME REGEX WHAT: fails when no class matches (the check would be vacuous)
require_classes() {
  local name="$1" pattern="$2" what="$3" count
  count="$(grep -cE "$pattern" "$work/$name/classes.txt" || true)"
  if [[ "$count" -eq 0 ]]; then
    fail "the $name APK has no $what classes at all: wrong APK, or dexdump read nothing"
  else
    ok "the $name APK has its own $what ($count classes)"
  fi
}

# forbid_manifest NAME WHAT FIXED_STRING...: fails when the merged manifest names any of them
forbid_manifest() {
  local name="$1" what="$2" hits="" s
  shift 2
  for s in "$@"; do
    if grep -qF -- "$s" "$work/$name/manifest.txt"; then hits+="  $s"$'\n'; fi
  done
  if [[ -n "$hits" ]]; then
    fail "the $name APK's merged manifest names $what:"
    printf '%s' "$hits"
  else
    ok "the $name APK's merged manifest names no $what"
  fi
}

# utf16 STRING: a grep -P pattern for STRING in UTF-16LE (each character followed by a NUL byte)
utf16() {
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in [.\\/+*?\[\]\(\)\{\}^\$\|]) c="\\$c" ;; esac
    out+="$c\\x00"
  done
  printf '%s' "$out"
}

# forbid_resources NAME STRING...: fails when res/, resources.arsc or assets/ hold any of them (UTF-8 or UTF-16)
forbid_resources() {
  local name="$1" hits="" s files
  shift
  for s in "$@"; do
    files="$( { grep -rlaF -- "$s" "$work/$name/files" 2>/dev/null; grep -rlaP -- "$(utf16 "$s")" "$work/$name/files" 2>/dev/null; } | sort -u | sed "s|$work/$name/files/||" || true)"
    if [[ -n "$files" ]]; then hits+="  \"$s\" in: $(head -n 5 <<<"$files" | tr '\n' ' ')"$'\n'; fi
  done
  if [[ -n "$hits" ]]; then
    fail "the $name APK's resources hold forbidden strings:"
    printf '%s' "$hits"
  else
    ok "the $name APK's resources hold none of: $*"
  fi
}

# forbid_strings NAME CLASS_REGEX EXEMPT_REGEX WHAT STRING...: fails when code in classes matching
# CLASS_REGEX (and not EXEMPT_REGEX) holds any of the strings as a constant
forbid_strings() {
  local name="$1" scope="$2" exempt="$3" what="$4" hits="" s found
  shift 4
  for s in "$@"; do
    found="$(awk -F'\t' -v scope="$scope" -v exempt="$exempt" -v s="$s" \
      '$1 ~ scope && (exempt == "" || $1 !~ exempt) && index($2, s) { print $1 }' "$work/$name/strings.txt" | sort -u)"
    if [[ -n "$found" ]]; then hits+="  \"$s\" in: $(head -n 5 <<<"$found" | tr '\n' ' ')"$'\n'; fi
  done
  if [[ -n "$hits" ]]; then
    fail "the $name APK's $what holds forbidden strings:"
    printf '%s' "$hits"
  else
    ok "the $name APK's $what holds none of: $*"
  fi
}

# Every class name of the dex, as written (to search raw descriptors for strings stored outside code).
forbid_dex_bytes() {
  local name="$1" hits="" s
  shift
  for s in "$@"; do
    if grep -qaF -- "$s" "$work/$name/dex"/classes*.dex; then hits+="  $s"$'\n'; fi
  done
  if [[ -n "$hits" ]]; then
    fail "the $name APK's dex holds forbidden strings:"
    printf '%s' "$hits"
  else
    ok "the $name APK's dex holds none of: $*"
  fi
}

# forbid_dialog_calls NAME MAPPING: code outside Play services referencing its Play Store dialogs,
# by their own names and, in a minified APK, by the names R8 gave them.
forbid_dialog_calls() {
  local name="$1" mapping="$2" cls="com/google/android/gms/common/GoogleApiAvailability" methods="getErrorDialog|makeGooglePlayServicesAvailable|showErrorDialogFragment" hits
  local pattern="L${cls};\\.(${methods}):" target names
  if [[ -n "$mapping" ]]; then
    target="$(awk -v c="${cls//\//.}" '$1 == c && $2 == "->" { n = $3; sub(/:$/, "", n); gsub(/\./, "/", n); print n; exit }' "$mapping")"
    if [[ -n "$target" ]]; then
      names="$(awk -v c="${cls//\//.}" -v want="$methods" '
        /^[^ ]/ { inside = ($1 == c); next }
        inside && /->/ {
          line = $0; sub(/^ +([0-9]+:[0-9]+:)?/, "", line)
          split(line, f, " "); m = f[2]; sub(/\(.*/, "", m); o = f[4]
          if (m ~ "^(" want ")$") print o
        }' "$mapping" | sort -u | paste -sd'|' -)"
      [[ -n "$names" ]] && pattern="${pattern}|L${target};\\.(${names}):"
    fi
  fi
  hits="$(awk -v mapfile="$work/$name/classmap.txt" -v pat="$pattern" '
    BEGIN { while ((getline line < mapfile) > 0) { split(line, f, " "); orig[f[1]] = f[2] } }
    /^  Class descriptor  : / { d = $0; sub(/^  Class descriptor  : .L/, "", d); sub(/;.$/, "", d); cls = (d in orig) ? orig[d] : d; next }
    /invoke-/ && $0 ~ pat && cls !~ /^com\/google\/android\/gms\// { print cls }
  ' "$work/$name/code.txt" | sort -u)"
  if [[ -n "$hits" ]]; then
    fail "the $name APK calls Play services' Play Store dialogs from:"
    head -n 10 <<<"$hits" | sed 's/^/  /'
  else
    ok "the $name APK calls none of GoogleApiAvailability's Play Store dialogs outside Play services"
  fi
}

bazaar_sdk='^(ir/cafebazaar/|com/farsitel/)'
play_sdk='^(com/android/billingclient/|com/google/android/play/)'
google_sign_in='^(com/google/android/libraries/identity/googleid/|androidx/credentials/|app/core/store/GoogleSignIn)'

echo "Cafe Bazaar APK: $bazaar_apk ($(wc -l < "$work/bazaar/classes.txt") classes${bazaar_mapping:+, R8 mapping $bazaar_mapping})"
require_classes bazaar '^ir/cafebazaar/poolakey/' "Poolakey"
forbid_classes bazaar "$play_sdk" "Google Play (com.android.billingclient, com.google.android.play)"
forbid_classes bazaar "$google_sign_in" "Google sign-in (googleid, androidx.credentials)"
forbid_manifest bazaar "Google Play billing or Play Store links" "com.android.vending.BILLING" "play.google.com/store" "market://"
# Every class but Play services' own: R8 merges classes across packages in a release build, so a
# string of app/core can sit in a class named after a library one, and the other way round.
forbid_strings bazaar '.' '^com/google/android/gms/' "code (Play services' own classes aside)" "play.google.com/store" "market://"
forbid_resources bazaar "play.google.com/store" "market://"
forbid_dialog_calls bazaar "$bazaar_mapping"

echo "Google Play APK: $play_apk ($(wc -l < "$work/play/classes.txt") classes${play_mapping:+, R8 mapping $play_mapping})"
require_classes play '^com/android/billingclient/' "Play Billing"
forbid_classes play "$bazaar_sdk" "Cafe Bazaar (ir.cafebazaar, com.farsitel)"
forbid_manifest play "Cafe Bazaar's permission, package or receiver" \
  "com.farsitel.bazaar.permission.PAY_THROUGH_BAZAAR" "com.farsitel.bazaar" "ir.cafebazaar.poolakey.receiver.BillingReceiver"
forbid_dex_bytes play "ir.cafebazaar" "com.farsitel.bazaar" "cafebazaar.ir" "bazaar://"
forbid_resources play "ir.cafebazaar" "com.farsitel.bazaar" "cafebazaar.ir" "bazaar://"

if [[ $status -eq 0 ]]; then
  echo "Store separation: clean."
else
  echo "Store separation: FAILED. A store's SDK, link or text reached the other store's build: check that it is a"
  echo "bazaarImplementation / playImplementation dependency or lives in src/bazaar / src/play, and that src/main does not name it."
fi
exit $status
