#!/bin/sh
# Static checks of docker-compose.yml without Coolify or a Docker daemon (the
# docker CLI with its compose plugin is enough):
#
#   deploy/coolify/check.sh [stack.env ...]
#
#   1. `docker compose config` accepts the file as Coolify runs it: the
#      repository root as the project directory, the variables of
#      .env.example, and without `exclude_from_hc`, a key of Coolify's own
#      that it removes before it calls compose.
#   2. Every ${VAR} of the file is listed in .env.example and every variable
#      of .env.example is used by the file.
#   3. Only livekit publishes host ports; everything else is reached through
#      Coolify's proxy or the stack's network.
#   4. The configurations written at start (realtime server, media server)
#      and the relay's render from their templates with sample values, with
#      every placeholder filled.
#   5. The variables of .env.example's "Required" block are exactly the ones
#      the file requires (${VAR:?...}), so a deploy without one stops.
#   6. No Dockerfile copies files with a mode that has no execute bit into a
#      directory COPY would create (a path ending in "/"): BuildKit gives
#      that new directory the same mode, so a non-root process cannot enter it.
#   7. ADMIN_TOTP_REQUIRED, as compose hands it to the api service (the
#      JSON render, so `export`, quotes and comments in an env file read as
#      on a deploy) and the API reads it (empty is the default; trimmed, any
#      case, true/1/yes/on or false/0/no/off). The shared files keep it on:
#      the file passes it as ${ADMIN_TOTP_REQUIRED:-true}, a stack that
#      leaves it unset gets true and .env.example sets true; otherwise the
#      check fails. An env file named on the command line (a stack's own
#      variables) that turns it off is a WARNING line only: test stacks may
#      turn the second factor off. A value the API refuses fails.
#   8. ADMIN_DEFAULT_LOCALE, as compose hands it to the admin service (the
#      same renders as step 7) and the admin container reads it (trimmed;
#      empty is fa): the file passes it as ${ADMIN_DEFAULT_LOCALE:-fa}, and
#      the value of a stack that leaves it unset, of .env.example and of each
#      env file named on the command line must be a panel language (en, fa
#      or tr), and one of the brand's languages when that env file's BRAND
#      is a brand of the repository (brands/<BRAND>/brand.json); otherwise
#      the admin container does not start, and the check fails.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
compose="$here/docker-compose.yml"
example="$here/.env.example"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
status=0

sed '/^[[:space:]]*exclude_from_hc:/d' "$compose" > "$work/compose.yml"
if docker compose --project-directory "$root" -f "$work/compose.yml" --env-file "$example" config > "$work/rendered.yml" 2> "$work/err"; then
  echo "check: compose file is valid"
else
  grep -v 'level=warning' "$work/err" >&2 || true
  echo "check: compose file is NOT valid" >&2
  status=1
fi

grep -o '\${[A-Z0-9_]*' "$compose" | sed 's/^\${//' | sort -u > "$work/used"
grep -E '^[A-Z0-9_]+=' "$example" | cut -d= -f1 | sort -u > "$work/listed"
missing=$(comm -23 "$work/used" "$work/listed")
unused=$(comm -13 "$work/used" "$work/listed")
if [ -n "$missing" ]; then
  echo "check: used but not in .env.example: $(echo $missing)" >&2
  status=1
fi
if [ -n "$unused" ]; then
  echo "check: in .env.example but not used: $(echo $unused)" >&2
  status=1
fi
[ -n "$missing$unused" ] || echo "check: .env.example lists exactly the variables the file uses"

awk '/^# ── Required/ { on = 1; next } /^# ──/ { on = 0 } on && /^[A-Z0-9_]+=/ { sub("=.*", ""); print }' "$example" | sort -u > "$work/required-listed"
grep -o '\${[A-Z0-9_]*:?' "$compose" | sed 's/^\${//; s/:?$//' | sort -u > "$work/required-used"
if cmp -s "$work/required-listed" "$work/required-used"; then
  echo "check: the required variables of .env.example are the ones the file requires"
else
  echo "check: required in .env.example but not in the file: $(echo $(comm -23 "$work/required-listed" "$work/required-used"))" >&2
  echo "check: required by the file but not in .env.example's Required block: $(echo $(comm -13 "$work/required-listed" "$work/required-used"))" >&2
  status=1
fi

# COPY --chmod without an execute bit into a directory COPY creates: the
# directory gets that mode too. Directories made beforehand (install -d -m 0755)
# are listed as known; anything else ending in "/" with such a mode fails.
bad_copies=""
for dockerfile in "$root"/deploy/docker/*.Dockerfile; do
  made=$(grep -oE 'install -d -m 0?755 [^ &;]+' "$dockerfile" | awk '{print $NF}' | sed 's:/*$::')
  # "<mode> <destination>" for every COPY with --chmod.
  grep -E '^COPY .*--chmod=[0-7]+ ' "$dockerfile" \
    | sed -E 's/.*--chmod=([0-7]+) .* ([^ ]+)$/\1 \2/' > "$work/copies" || true
  while read -r mode dest; do
    [ -n "$mode" ] || continue
    case "$dest" in */) ;; *) continue ;; esac
    owner=$(printf '%s' "$mode" | tail -c 3 | cut -c1)
    [ $((owner % 2)) -eq 1 ] && continue
    dir=$(echo "$dest" | sed 's:/*$::')
    echo "$made" | grep -qx "$dir" && continue
    bad_copies="$bad_copies $(basename "$dockerfile"):$dest"
  done < "$work/copies"
done
if [ -z "$bad_copies" ]; then
  echo "check: no restrictive COPY --chmod into a directory the copy creates"
else
  echo "check: COPY --chmod without an execute bit into a new directory (it gets that mode):$bad_copies" >&2
  status=1
fi

# Services with a top-level `ports:` key, from the rendered file.
published=$(awk '
  /^services:/ { in_services = 1; next }
  in_services && /^[^ ]/ { in_services = 0 }
  in_services && /^  [a-z0-9_-]+:$/ { svc = $1; sub(":", "", svc) }
  in_services && /^    ports:/ { print svc }
' "$work/rendered.yml" | sort -u | tr '\n' ' ')
if [ "$published" = "livekit " ]; then
  echo "check: only livekit publishes host ports"
else
  echo "check: services publishing host ports: ${published:-none} (expected: livekit)" >&2
  status=1
fi

# The start scripts in their "write the file and stop" mode, with sample values.
sample_secret=sample0123456789abcdefghijklmnopqrstuvwxyz
if CENTRIFUGO_TOKEN_HMAC_SECRET="$sample_secret" CENTRIFUGO_API_KEY=sample-api-key-0123456789 KV_RT_PASSWORD=sample \
   CENTRIFUGO_PROXY_KEY=sample-proxy-key-0123456789abcdefghij CENTRIFUGO_PROXY_URL=http://api:8081 \
   CENTRIFUGO_ALLOWED_ORIGINS=https://admin.example.com CENTRIFUGO_TEMPLATE="$root/deploy/centrifugo/config.json" \
   CENTRIFUGO_CONFIG_OUT="$work/centrifugo.json" CENTRIFUGO_CONFIG_ONLY=1 sh "$root/deploy/centrifugo/start.sh" \
   && LIVEKIT_API_KEY=sample LIVEKIT_API_SECRET="$sample_secret" LIVEKIT_WEBHOOK_URL=http://api:8080/v1/webhooks/livekit \
   LIVEKIT_NODE_IP=203.0.113.10 LIVEKIT_TEMPLATE="$root/deploy/livekit/livekit.yaml" LIVEKIT_CONFIG_OUT="$work/livekit.yaml" \
   LIVEKIT_CONFIG_ONLY=1 sh "$root/deploy/livekit/start.sh" \
   && printf '%s\n' "$sample_secret" > "$work/relay-secret" \
   && CONFIG_ONLY=1 CONF="$work/turnserver.conf" SECRET_FILE="$work/relay-secret" PUBLIC_IP=198.51.100.7 PEER_IPS=203.0.113.10 \
   sh "$root/deploy/relay/configure.sh"; then
  echo "check: realtime, media and relay configurations render"
else
  echo "check: a configuration template does NOT render" >&2
  status=1
fi

# The admin second factor: on in the shared files; off only in a stack's own variables, never silently.
totp_line='- ADMIN_TOTP_REQUIRED=${ADMIN_TOTP_REQUIRED:-true}'
# The value compose gives NAME in SECTION ("environment", or "args" of its
# build) of SERVICE, rendered with ENV_FILE (the JSON render, so `export`,
# quotes and comments in an env file read as on a deploy): "=<value>", or
# "unset" without one; fails when compose refuses the file.
#   service_value SERVICE SECTION NAME ENV_FILE
service_value() {
  docker compose --project-directory "$root" -f "$work/compose.yml" --env-file "$4" config --format json "$1" > "$work/service.json" 2> /dev/null || return 1
  awk -v svc="$1" -v section="$2" -v name="$3" '
    $0 == "    \"" svc "\": {" { inside = 1; next }
    inside && $0 ~ ("^ *\"" section "\": [{]$") { open = 1; next }
    open && /^ *[}]/ { exit }
    open && index($0, "\"" name "\": \"") { value = $0; sub(/^ *"[A-Za-z0-9_]+": "/, "", value); sub(/",?$/, "", value); found = 1; print "=" value; exit }
    END { if (!found) print "unset" }
  ' "$work/service.json"
}
# The api service's ADMIN_TOTP_REQUIRED rendered with env file $1.
api_totp() {
  service_value api environment ADMIN_TOTP_REQUIRED "$1"
}
# How the API takes a rendered value: on, off or invalid (it does not start).
totp_state() {
  case $1 in
    unset | =) echo on; return ;;
  esac
  case $(printf '%s' "${1#=}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr 'A-Z' 'a-z') in
    true | 1 | yes | on) echo on ;;
    false | 0 | no | off) echo off ;;
    *) echo invalid ;;
  esac
}
totp_warned=0
totp_failed=0
if ! grep -Eq '^[[:space:]]*- ADMIN_TOTP_REQUIRED=\$\{ADMIN_TOTP_REQUIRED:-true\}$' "$compose"; then
  echo "check: docker-compose.yml does not pass the api service \"$totp_line\": a stack that leaves it unset may sign admins in without a second factor" >&2
  totp_failed=1
fi
sed '/ADMIN_TOTP_REQUIRED/d' "$example" > "$work/totp-unset.env"
for env_file in "$work/totp-unset.env" "$example" "$@"; do
  case $env_file in
    "$work/totp-unset.env") name="a stack without ADMIN_TOTP_REQUIRED"; shared=1 ;;
    "$example") name=".env.example"; shared=1 ;;
    *) name=$env_file; shared=0 ;;
  esac
  if [ ! -f "$env_file" ]; then
    echo "check: no such env file: $env_file" >&2
    totp_failed=1
    continue
  fi
  if ! value=$(api_totp "$env_file"); then
    echo "check: compose does not render with $name" >&2
    totp_failed=1
    continue
  fi
  case $(totp_state "$value") in
    on) ;;
    off)
      if [ "$shared" -eq 1 ]; then
        echo "check: $name gives the api ADMIN_TOTP_REQUIRED${value}: the shared files must keep the second factor on (set it off in a test stack's own variables)" >&2
        totp_failed=1
      else
        echo "check: WARNING: $name gives the api ADMIN_TOTP_REQUIRED${value}: every admin signs in with the password alone (no TOTP); test stacks only" >&2
        totp_warned=1
      fi
      ;;
    invalid)
      echo "check: $name gives the api ADMIN_TOTP_REQUIRED${value}, which is not true or false: the API does not start" >&2
      totp_failed=1
      ;;
  esac
done
if [ "$totp_failed" -eq 1 ]; then
  status=1
elif [ "$totp_warned" -eq 0 ]; then
  echo "check: ADMIN_TOTP_REQUIRED stays true: admin sign-in asks for a TOTP code"
fi

# The admin panel's default language: a language of the panel and of the brand, or the container stops.
locale_line='- ADMIN_DEFAULT_LOCALE=${ADMIN_DEFAULT_LOCALE:-fa}'
locale_failed=0
if ! grep -Eq '^[[:space:]]*- ADMIN_DEFAULT_LOCALE=\$\{ADMIN_DEFAULT_LOCALE:-fa\}$' "$compose"; then
  echo "check: docker-compose.yml does not pass the admin service \"$locale_line\": the panel's default language would not reach its container" >&2
  locale_failed=1
fi
sed '/ADMIN_DEFAULT_LOCALE/d' "$example" > "$work/locale-unset.env"
for env_file in "$work/locale-unset.env" "$example" "$@"; do
  case $env_file in
    "$work/locale-unset.env") name="a stack without ADMIN_DEFAULT_LOCALE" ;;
    "$example") name=".env.example" ;;
    *) name=$env_file ;;
  esac
  [ -f "$env_file" ] || continue
  if ! value=$(service_value admin environment ADMIN_DEFAULT_LOCALE "$env_file"); then
    echo "check: compose does not render with $name" >&2
    locale_failed=1
    continue
  fi
  # As admin-runtime.sh reads it: CR/LF dropped, trimmed, empty is fa.
  locale=$(printf '%s' "${value#=}" | sed 's/\\[rn]//g; s/^[[:space:]]*//; s/[[:space:]]*$//')
  [ "$value" != unset ] || locale=
  [ -n "$locale" ] || locale=fa
  case $locale in
    en | fa | tr) ;;
    *)
      echo "check: $name gives the admin ADMIN_DEFAULT_LOCALE=$locale: not a panel language (en, fa, tr); the admin container does not start" >&2
      locale_failed=1
      continue
      ;;
  esac
  brand=$(service_value admin args BRAND "$env_file" || echo unset)
  brand=${brand#=}
  case $brand in
    '' | unset | *[!A-Za-z0-9_-]*) continue ;;
  esac
  brand_json="$root/brands/$brand/brand.json"
  [ -f "$brand_json" ] || continue
  brand_locales=$(tr -d '\n' < "$brand_json" | grep -o '"locales"[[:space:]]*:[[:space:]]*\[[^]]*\]' | grep -o '"[a-z][a-z]"' | tr -d '"' | tr '\n' ' ')
  case " $brand_locales" in
    *" $locale "*) ;;
    *)
      echo "check: $name gives the admin ADMIN_DEFAULT_LOCALE=$locale, which brand $brand does not have (its languages: ${brand_locales% }); the admin container does not start" >&2
      locale_failed=1
      ;;
  esac
done
if [ "$locale_failed" -eq 1 ]; then
  status=1
else
  echo "check: ADMIN_DEFAULT_LOCALE is a language of the admin panel"
fi

exit "$status"
