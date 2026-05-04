#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/spotlight-rn"
SMOKE_ENV_FILE="${SPOTLIGHT_STAGING_SMOKE_ENV_FILE:-$REPO_ROOT/.env.staging.smoke.local}"
MOBILE_ENV_FILE="${SPOTLIGHT_STAGING_MOBILE_ENV_FILE:-}"
TEMP_MOBILE_ENV_FILE=""
SIMULATOR_DEVICE="${SPOTLIGHT_MAESTRO_IOS_SIMULATOR_DEVICE:-iPhone 16}"
AUTH_SETTLE_SECONDS="${SPOTLIGHT_STAGING_SMOKE_AUTH_SETTLE_SECONDS:-8}"

ensure_local_tooling_paths() {
  if [ -d "$HOME/.maestro/bin" ]; then
    export PATH="$HOME/.maestro/bin:$PATH"
  fi
  if [ -d "/opt/homebrew/opt/openjdk@17/bin" ]; then
    export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"
  fi
  if [ -z "${JAVA_HOME:-}" ] && [ -d "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" ]; then
    export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
  fi
}

load_env_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    echo "Missing env file: $path" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$path"
  set +a
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  local key="$1"
  local value="${!key:-}"
  if [ -z "$value" ]; then
    echo "Missing required value: $key" >&2
    exit 1
  fi
}

load_env_file "$SMOKE_ENV_FILE"
ensure_local_tooling_paths

cleanup() {
  if [ -n "$TEMP_MOBILE_ENV_FILE" ] && [ -f "$TEMP_MOBILE_ENV_FILE" ]; then
    rm -f "$TEMP_MOBILE_ENV_FILE"
  fi
}

trap cleanup EXIT INT TERM

if [ -n "$MOBILE_ENV_FILE" ]; then
  load_env_file "$MOBILE_ENV_FILE"
else
  TEMP_MOBILE_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/spotlight-staging-mobile.XXXXXX.env")"
  python3 "$SCRIPT_DIR/mobile_env_resolver.py" --environment staging --profile staging --output "$TEMP_MOBILE_ENV_FILE"
  load_env_file "$TEMP_MOBILE_ENV_FILE"
fi

export SPOTLIGHT_APP_ENV=staging
export EXPO_NO_DOTENV=1
export EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED="${EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED:-1}"

require_command maestro
require_command xcrun
require_command open

require_env SPOTLIGHT_STAGING_SMOKE_EMAIL
require_env SPOTLIGHT_STAGING_SMOKE_PASSWORD
require_env SPOTLIGHT_MAESTRO_CATALOG_QUERY
require_env SPOTLIGHT_MAESTRO_CATALOG_RESULT_ID
require_env SPOTLIGHT_MAESTRO_SINGLE_SELL_ENTRY_ID
require_env SPOTLIGHT_MAESTRO_SINGLE_SELL_PRICE
require_env SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_ONE
require_env SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_TWO
require_env SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_ONE
require_env SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_TWO
require_env SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_ONE
require_env SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_TWO
require_env SPOTLIGHT_IOS_BUNDLE_IDENTIFIER

echo "== reset staging smoke fixture =="
python3 "$SCRIPT_DIR/reset_staging_smoke_fixture.py"

echo "== boot iOS simulator =="
xcrun simctl boot "$SIMULATOR_DEVICE" || true
open -a Simulator
xcrun simctl bootstatus "$SIMULATOR_DEVICE" -b

echo "== reset simulator keychain =="
xcrun simctl keychain booted reset

echo "== clear simulator app state =="
xcrun simctl terminate booted "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true
xcrun simctl uninstall booted "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true

echo "== build and launch staging app =="
(
  cd "$APP_DIR"
  pnpm exec expo run:ios --device "$SIMULATOR_DEVICE"
)

echo "== prepare app permissions =="
xcrun simctl privacy booted grant camera "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true
xcrun simctl privacy booted grant photos "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true
xcrun simctl privacy booted grant microphone "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true

echo "== bootstrap staging smoke session =="
BOOTSTRAP_URL="$(python3 "$SCRIPT_DIR/bootstrap_staging_simulator_auth.py")"
echo "== enter Looty dev client =="
cd "$REPO_ROOT"
maestro test apps/spotlight-rn/.maestro/staging-smoke-open-dev-client.yml
xcrun simctl openurl booted "$BOOTSTRAP_URL"
sleep "$AUTH_SETTLE_SECONDS"

MAESTRO_ENV_ARGS=(
  -e "SPOTLIGHT_MAESTRO_CATALOG_QUERY=$SPOTLIGHT_MAESTRO_CATALOG_QUERY"
  -e "SPOTLIGHT_MAESTRO_CATALOG_RESULT_ID=$SPOTLIGHT_MAESTRO_CATALOG_RESULT_ID"
  -e "SPOTLIGHT_MAESTRO_SINGLE_SELL_ENTRY_ID=$SPOTLIGHT_MAESTRO_SINGLE_SELL_ENTRY_ID"
  -e "SPOTLIGHT_MAESTRO_SINGLE_SELL_PRICE=$SPOTLIGHT_MAESTRO_SINGLE_SELL_PRICE"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_ONE=$SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_ONE"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_TWO=$SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_TWO"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_ONE=$SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_ONE"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_TWO=$SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_TWO"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_ONE=$SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_ONE"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_TWO=$SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_TWO"
)

echo "== run maestro staging smoke =="
maestro test "${MAESTRO_ENV_ARGS[@]}" apps/spotlight-rn/.maestro/staging-smoke.yml

echo "== run maestro scanner fixture smoke =="
maestro test "${MAESTRO_ENV_ARGS[@]}" apps/spotlight-rn/.maestro/staging-scan-fixture-smoke.yml
