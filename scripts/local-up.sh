#!/usr/bin/env bash
# Start the local CivicOS identity platform: Mailpit (SMTP 1025, UI 8025) and Keycloak 26.4.7
# on http://localhost:8180 in dev mode with Postgres database keycloak_local, realm ocn applied
# from realm/config, the fake council IdP realm council-sim, and the local test users.
#
#   scripts/local-up.sh            start (or refresh config if already running)
#   scripts/local-up.sh --rebuild  rebuild the CivicOS extension JAR first, then restart Keycloak
#
# Writes client secrets to $LOCAL_DIR/clients.env and a status page to $LOCAL_DIR/STATUS.md.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
KC_HOME="${KC_HOME:-$HOME/Repositories/ocn-keycloak/keycloak-dev}"
LOCAL_DIR="${LOCAL_DIR:-$HOME/Repositories/ocn-keycloak/local}"
KC_PORT="${KC_PORT:-8180}"
KC_MGMT_PORT="${KC_MGMT_PORT:-9180}"
PGURL_BASE="${PGURL_BASE:-postgresql://toby@localhost:5432}"
DB_NAME="${KC_DB_NAME:-keycloak_local}"
export KC_SERVER="http://localhost:${KC_PORT}"
export KC_ADMIN="${KC_ADMIN:-admin}" KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-admin}"
JAVA21="${JAVA21:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
mkdir -p "$LOCAL_DIR"

say() { printf '>> %s\n' "$*"; }

# 1. Mailpit
if ! curl -fsS -m 2 http://localhost:8025/api/v1/info >/dev/null 2>&1; then
  command -v mailpit >/dev/null || brew install mailpit
  brew services start mailpit >/dev/null
  for _ in $(seq 1 20); do curl -fsS -m 1 http://localhost:8025/api/v1/info >/dev/null 2>&1 && break; sleep 0.5; done
fi
say "Mailpit up (SMTP localhost:1025, UI http://localhost:8025)"

# 2. Database
if ! psql "$PGURL_BASE/postgres" -Atqc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1; then
  createdb -h localhost -U toby "$DB_NAME"; say "created database $DB_NAME"
fi

# 3. Extension JAR and theme
JAR_SRC="$REPO/extension/target/civicos-signin-policy.jar"
if [ -d "$REPO/extension" ]; then
  if [ "${1:-}" = "--rebuild" ] || [ ! -f "$JAR_SRC" ]; then
    say "building CivicOS sign-in policy extension"
    (cd "$REPO/extension" && JAVA_HOME="$JAVA21" mvn -q -DskipTests package)
  fi
  cp "$JAR_SRC" "$KC_HOME/providers/civicos-signin-policy.jar"
fi
ln -sfn "$REPO/themes/src/main/resources/theme/ocn" "$KC_HOME/themes/ocn"
mkdir -p "$KC_HOME/data/password-blacklists"
cp "$REPO/realm/civicos-password-blocklist.txt" "$KC_HOME/data/password-blacklists/" 2>/dev/null || true

# 4. Keycloak
PIDFILE="$LOCAL_DIR/keycloak.pid"
running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
if [ "${1:-}" = "--rebuild" ] && running; then "$REPO/scripts/local-down.sh" --keycloak-only; fi
if ! running; then
  say "starting Keycloak on :$KC_PORT (log $LOCAL_DIR/keycloak.log)"
  (
    export JAVA_HOME="$JAVA21"
    export KC_BOOTSTRAP_ADMIN_USERNAME="$KC_ADMIN" KC_BOOTSTRAP_ADMIN_PASSWORD="$KC_ADMIN_PASSWORD"
    export JAVA_OPTS_KC_HEAP="-Xms256m -Xmx1024m"
    nohup "$KC_HOME/bin/kc.sh" start-dev \
      --http-port="$KC_PORT" --http-management-port="$KC_MGMT_PORT" \
      --db=postgres --db-url="jdbc:postgresql://localhost:5432/$DB_NAME" --db-username=toby --db-password=unused \
      --spi-theme--static-max-age=-1 --spi-theme--cache-themes=false --spi-theme--cache-templates=false \
      --spi-password-policy--password-blacklist--blacklists-path="$KC_HOME/data/password-blacklists" \
      > "$LOCAL_DIR/keycloak.log" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
  )
fi
for i in $(seq 1 120); do
  curl -fsS -m 2 "$KC_SERVER/realms/master" >/dev/null 2>&1 && break
  if ! running; then echo "Keycloak exited; see $LOCAL_DIR/keycloak.log" >&2; tail -30 "$LOCAL_DIR/keycloak.log" >&2; exit 1; fi
  sleep 2
done
say "Keycloak up at $KC_SERVER"

# 5. Realm ocn: create from the sanitised snapshot on first run (minus production-only parts)
if ! curl -fsS -m 2 "$KC_SERVER/realms/ocn" >/dev/null 2>&1; then
  say "creating realm ocn from realm/ocn-realm.json (sanitised for local)"
  TOKEN=$(curl -fsS "$KC_SERVER/realms/master/protocol/openid-connect/token" -d grant_type=password -d client_id=admin-cli -d "username=$KC_ADMIN" -d "password=$KC_ADMIN_PASSWORD" | jq -r .access_token)
  jq '
      del(.id)
    | ([.clients[] | select(.protocol == "saml") | .clientId]) as $saml
    | .clients |= map(select(.protocol != "saml") | del(.secret) | del(.id))
    | .roles.client |= (with_entries(select(.key as $k | $saml | index($k) | not)))
    | .scopeMappings |= ((. // []) | map(select(.client as $c | $saml | index($c) | not)))
    | .clientScopeMappings |= ((. // {}) | with_entries(select(.key as $k | $saml | index($k) | not)))
    | .identityProviders = [] | .identityProviderMappers = []
    | .attributes.frontendUrl = ""
    | del(.smtpServer)
    | .clientScopes |= map(del(.id) | .protocolMappers |= ((. // []) | map(del(.id))))
  ' "$REPO/realm/ocn-realm.json" > "$LOCAL_DIR/ocn-realm.local.json"
  curl -fsS -X POST "$KC_SERVER/admin/realms" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' --data-binary @"$LOCAL_DIR/ocn-realm.local.json"
fi

# 6. Apply realm config as code, then local seed (organisations, users, fake council IdP)
node "$REPO/scripts/realm/apply.mjs" --env local --secrets-out "$LOCAL_DIR/clients.env"
node "$REPO/scripts/local/seed.mjs"
# Second pass so the IdP picks up the broker flows if they were only just created.
node "$REPO/scripts/realm/apply.mjs" --env local --secrets-out "$LOCAL_DIR/clients.env" >/dev/null
node "$REPO/scripts/local/seed.mjs" >/dev/null
node "$REPO/scripts/local/write-status.mjs" "$LOCAL_DIR"
say "done: see $LOCAL_DIR/STATUS.md"
