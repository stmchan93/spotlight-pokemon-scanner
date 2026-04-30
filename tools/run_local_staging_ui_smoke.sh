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

echo "== boot iOS simulator =="
xcrun simctl boot "$SIMULATOR_DEVICE" || true
open -a Simulator
xcrun simctl bootstatus "$SIMULATOR_DEVICE" -b

echo "== build and launch staging app =="
(
  cd "$APP_DIR"
  pnpm exec expo run:ios --simulator "$SIMULATOR_DEVICE"
)

echo "== bootstrap staging smoke session =="
BOOTSTRAP_URL="$(python3 "$SCRIPT_DIR/bootstrap_staging_simulator_auth.py")"
xcrun simctl openurl booted "$BOOTSTRAP_URL"
sleep "$AUTH_SETTLE_SECONDS"

echo "== run maestro staging smoke =="
cd "$REPO_ROOT"
pnpm mobile:smoke:staging:maestro

echo "== run maestro scanner fixture smoke =="
pnpm mobile:smoke:staging:maestro:scan-fixture
