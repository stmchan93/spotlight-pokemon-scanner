#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/spotlight-rn"
MAESTRO_FLOW_DIR="$APP_DIR/.maestro"
SMOKE_ENV_FILE="${SPOTLIGHT_STAGING_SMOKE_ENV_FILE:-$REPO_ROOT/.env.staging.smoke.local}"
MOBILE_ENV_FILE="${SPOTLIGHT_STAGING_MOBILE_ENV_FILE:-}"
TEMP_MOBILE_ENV_FILE=""
SIMULATOR_DEVICE="${SPOTLIGHT_IOS_SIMULATOR_DEVICE:-${SPOTLIGHT_MAESTRO_IOS_SIMULATOR_DEVICE:-${IOS_SIMULATOR_DEVICE:-iPhone 16}}}"
AUTH_SETTLE_SECONDS="${SPOTLIGHT_STAGING_SMOKE_AUTH_SETTLE_SECONDS:-8}"
DERIVED_DATA_PATH="${SPOTLIGHT_STAGING_SMOKE_DERIVED_DATA_PATH:-$REPO_ROOT/.derivedData/staging-smoke}"
IOS_SCHEME="${SPOTLIGHT_STAGING_SMOKE_IOS_SCHEME:-Spotlight}"
IOS_CONFIGURATION="${SPOTLIGHT_STAGING_SMOKE_IOS_CONFIGURATION:-Release}"
IOS_APP_PRODUCT_NAME="${SPOTLIGHT_STAGING_SMOKE_IOS_APP_PRODUCT_NAME:-Spotlight}"
SIMULATOR_UDID=""
SKIP_FIXTURE_RESET="${SPOTLIGHT_STAGING_SMOKE_SKIP_FIXTURE_RESET:-0}"
STAGING_SMOKE_APP_ENV_TEST_ID=""
STAGING_SMOKE_API_BASE_URL_TEST_ID=""

normalize_staging_smoke_diagnostic_value() {
  python3 - "$1" <<'PY'
from __future__ import annotations

import re
import sys

value = (sys.argv[1] or "").strip().lower()
value = re.sub(r"^https?://", lambda match: f"{match.group(0)[:-3]}-", value)
value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
print(value or "missing")
PY
}

build_staging_smoke_diagnostic_test_id() {
  local prefix="$1"
  local value="$2"
  local normalized
  normalized="$(normalize_staging_smoke_diagnostic_value "$value")"
  printf '%s-%s' "$prefix" "$normalized"
}

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

load_env_file_if_present() {
  local path="$1"
  if [ -f "$path" ]; then
    load_env_file "$path"
  fi
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

ensure_local_tooling_paths
load_env_file_if_present "$SMOKE_ENV_FILE"

cleanup() {
  if [ -n "$TEMP_MOBILE_ENV_FILE" ] && [ -f "$TEMP_MOBILE_ENV_FILE" ]; then
    rm -f "$TEMP_MOBILE_ENV_FILE"
  fi
}

trap cleanup EXIT INT TERM

has_resolved_mobile_env() {
  [ -n "${EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL:-}" ] \
    && [ -n "${EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL:-}" ] \
    && [ -n "${EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY:-}" ] \
    && [ -n "${SPOTLIGHT_IOS_BUNDLE_IDENTIFIER:-}" ]
}

if [ -n "$MOBILE_ENV_FILE" ]; then
  load_env_file "$MOBILE_ENV_FILE"
elif has_resolved_mobile_env; then
  :
else
  TEMP_MOBILE_ENV_FILE="$(mktemp "${TMPDIR%/}/spotlight-staging-mobile.XXXXXX")"
  python3 "$SCRIPT_DIR/mobile_env_resolver.py" --environment staging --profile staging --output "$TEMP_MOBILE_ENV_FILE"
  load_env_file "$TEMP_MOBILE_ENV_FILE"
fi

export SPOTLIGHT_APP_ENV=staging
export EXPO_NO_DOTENV=1
export EXPO_PUBLIC_SPOTLIGHT_STAGING_SMOKE_ENABLED="${EXPO_PUBLIC_SPOTLIGHT_STAGING_SMOKE_ENABLED:-1}"
export EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED="${EXPO_PUBLIC_SPOTLIGHT_SCANNER_SMOKE_ENABLED:-1}"

require_command maestro
require_command xcrun
require_command open
require_command xcodebuild

require_env SPOTLIGHT_MAESTRO_CATALOG_QUERY
require_env SPOTLIGHT_MAESTRO_CATALOG_RESULT_ID
require_env SPOTLIGHT_MAESTRO_SINGLE_SELL_ENTRY_ID
require_env SPOTLIGHT_MAESTRO_SINGLE_SELL_BOUGHT_PRICE
require_env SPOTLIGHT_MAESTRO_SINGLE_SELL_PRICE
require_env SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_ONE
require_env SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_TWO
require_env SPOTLIGHT_MAESTRO_BULK_SELL_BOUGHT_PRICE_ONE
require_env SPOTLIGHT_MAESTRO_BULK_SELL_BOUGHT_PRICE_TWO
require_env SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_ONE
require_env SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_TWO
require_env SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_ONE
require_env SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_TWO
require_env SPOTLIGHT_IOS_BUNDLE_IDENTIFIER

if [ "$SKIP_FIXTURE_RESET" != "1" ]; then
  require_env SPOTLIGHT_STAGING_SMOKE_EMAIL
  require_env SPOTLIGHT_STAGING_SMOKE_PASSWORD
fi

if [ -z "${SPOTLIGHT_MAESTRO_AUTH_BOOTSTRAP_LINK:-}" ]; then
  require_env SPOTLIGHT_STAGING_SMOKE_EMAIL
  require_env SPOTLIGHT_STAGING_SMOKE_PASSWORD
fi

resolve_simulator_udid() {
  python3 - "$SIMULATOR_DEVICE" <<'PY'
import json
import subprocess
import sys

device_name = sys.argv[1]
payload = json.loads(
    subprocess.check_output(
        ["xcrun", "simctl", "list", "devices", "available", "-j"],
        text=True,
    )
)
matches = []
for runtime, devices in (payload.get("devices") or {}).items():
    for device in devices or []:
        if device.get("name") != device_name:
            continue
        matches.append(
            (
                0 if device.get("state") == "Booted" else 1,
                runtime,
                device.get("udid") or "",
            )
        )

matches = [match for match in matches if match[2]]
if not matches:
    raise SystemExit(f"Unable to find available iOS simulator named '{device_name}'.")

matches.sort()
print(matches[0][2])
PY
}

validate_staging_target() {
  python3 - <<'PY'
from __future__ import annotations

import os
import sys
import urllib.parse

api_base_url = str(os.environ.get("EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL") or "").strip()
app_env = str(os.environ.get("SPOTLIGHT_APP_ENV") or "").strip()

if app_env != "staging":
    raise SystemExit(f"Expected SPOTLIGHT_APP_ENV=staging, got {app_env or '<empty>'}.")

if not api_base_url:
    raise SystemExit("Missing EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL for staging smoke.")

parsed = urllib.parse.urlparse(api_base_url)
hostname = (parsed.hostname or "").strip().lower()
if parsed.scheme not in {"http", "https"} or not hostname:
    raise SystemExit(f"Invalid staging API base URL: {api_base_url}")

local_hosts = {"127.0.0.1", "localhost", "0.0.0.0"}
if hostname in local_hosts or hostname.endswith(".local"):
    raise SystemExit(f"Refusing to run staging smoke against local API base URL: {api_base_url}")

if hostname.startswith("10.") or hostname.startswith("192.168.") or hostname.startswith("172.16.") or hostname.startswith("172.17.") or hostname.startswith("172.18.") or hostname.startswith("172.19.") or hostname.startswith("172.20.") or hostname.startswith("172.21.") or hostname.startswith("172.22.") or hostname.startswith("172.23.") or hostname.startswith("172.24.") or hostname.startswith("172.25.") or hostname.startswith("172.26.") or hostname.startswith("172.27.") or hostname.startswith("172.28.") or hostname.startswith("172.29.") or hostname.startswith("172.30.") or hostname.startswith("172.31."):
    raise SystemExit(f"Refusing to run staging smoke against RFC1918 API base URL: {api_base_url}")

print(f"Resolved staging app env: {app_env}")
print(f"Resolved staging API base URL: {api_base_url}")
PY
}

build_install_and_launch_app() {
  local built_app_path="$DERIVED_DATA_PATH/Build/Products/${IOS_CONFIGURATION}-iphonesimulator/${IOS_APP_PRODUCT_NAME}.app"

  echo "== build release-style staging simulator app =="
  rm -rf "$DERIVED_DATA_PATH"
  (
    cd "$APP_DIR/ios"
    RCT_NO_LAUNCH_PACKAGER=1 \
      xcodebuild \
      -workspace Spotlight.xcworkspace \
      -scheme "$IOS_SCHEME" \
      -configuration "$IOS_CONFIGURATION" \
      -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
      -derivedDataPath "$DERIVED_DATA_PATH" \
      CODE_SIGNING_ALLOWED=NO \
      CODE_SIGNING_REQUIRED=NO \
      build
  )

  if [ ! -d "$built_app_path" ]; then
    echo "Expected built app at $built_app_path" >&2
    exit 1
  fi

  local built_bundle_id
  built_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$built_app_path/Info.plist" 2>/dev/null || true)"
  if [ -z "$built_bundle_id" ]; then
    echo "Unable to read built app bundle identifier from $built_app_path/Info.plist" >&2
    exit 1
  fi
  if [ "$built_bundle_id" != "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" ]; then
    echo "Built app bundle identifier mismatch: expected $SPOTLIGHT_IOS_BUNDLE_IDENTIFIER, got $built_bundle_id" >&2
    exit 1
  fi

  echo "== install deterministic staging app =="
  xcrun simctl terminate "$SIMULATOR_UDID" "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true
  xcrun simctl uninstall "$SIMULATOR_UDID" "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true
  xcrun simctl install "$SIMULATOR_UDID" "$built_app_path"

  local installed_app_path
  installed_app_path="$(xcrun simctl get_app_container "$SIMULATOR_UDID" "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" app 2>/dev/null || true)"
  if [ -z "$installed_app_path" ] || [ ! -d "$installed_app_path" ]; then
    echo "Failed to resolve installed app container for $SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >&2
    exit 1
  fi
  local installed_bundle_id
  installed_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$installed_app_path/Info.plist" 2>/dev/null || true)"
  if [ "$installed_bundle_id" != "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" ]; then
    echo "Installed app bundle identifier mismatch: expected $SPOTLIGHT_IOS_BUNDLE_IDENTIFIER, got ${installed_bundle_id:-<empty>}" >&2
    exit 1
  fi

  echo "Installed app container: $installed_app_path"

  echo "== prepare app permissions =="
  xcrun simctl privacy "$SIMULATOR_UDID" grant camera "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true
  xcrun simctl privacy "$SIMULATOR_UDID" grant photos "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true
  xcrun simctl privacy "$SIMULATOR_UDID" grant microphone "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true

  echo "== launch deterministic staging app =="
  xcrun simctl launch "$SIMULATOR_UDID" "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER"
}

validate_staging_target
SIMULATOR_UDID="$(resolve_simulator_udid)"
STAGING_SMOKE_APP_ENV_TEST_ID="$(build_staging_smoke_diagnostic_test_id "staging-smoke-app-env" "${SPOTLIGHT_APP_ENV:-staging}")"
STAGING_SMOKE_API_BASE_URL_TEST_ID="$(build_staging_smoke_diagnostic_test_id "staging-smoke-api-base-url" "${EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL:-}")"

echo "Using simulator device: $SIMULATOR_DEVICE ($SIMULATOR_UDID)"

echo "== reset staging smoke fixture =="
if [ "$SKIP_FIXTURE_RESET" = "1" ]; then
  echo "Skipping staging smoke fixture reset"
else
  python3 "$SCRIPT_DIR/reset_staging_smoke_fixture.py"
fi

echo "== boot iOS simulator =="
xcrun simctl boot "$SIMULATOR_UDID" || true
open -a Simulator --args -CurrentDeviceUDID "$SIMULATOR_UDID" || open -a Simulator
xcrun simctl bootstatus "$SIMULATOR_UDID" -b

echo "== reset simulator keychain =="
xcrun simctl keychain "$SIMULATOR_UDID" reset

echo "== clear simulator app state =="
xcrun simctl terminate "$SIMULATOR_UDID" "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true
xcrun simctl uninstall "$SIMULATOR_UDID" "$SPOTLIGHT_IOS_BUNDLE_IDENTIFIER" >/dev/null 2>&1 || true

build_install_and_launch_app

MAESTRO_ENV_ARGS=(
  -e "SPOTLIGHT_MAESTRO_CATALOG_QUERY=$SPOTLIGHT_MAESTRO_CATALOG_QUERY"
  -e "SPOTLIGHT_MAESTRO_CATALOG_RESULT_ID=$SPOTLIGHT_MAESTRO_CATALOG_RESULT_ID"
  -e "SPOTLIGHT_MAESTRO_SINGLE_SELL_ENTRY_ID=$SPOTLIGHT_MAESTRO_SINGLE_SELL_ENTRY_ID"
  -e "SPOTLIGHT_MAESTRO_SINGLE_SELL_BOUGHT_PRICE=$SPOTLIGHT_MAESTRO_SINGLE_SELL_BOUGHT_PRICE"
  -e "SPOTLIGHT_MAESTRO_SINGLE_SELL_PRICE=$SPOTLIGHT_MAESTRO_SINGLE_SELL_PRICE"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_ONE=$SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_ONE"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_TWO=$SPOTLIGHT_MAESTRO_BULK_SELL_ENTRY_ID_TWO"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_BOUGHT_PRICE_ONE=$SPOTLIGHT_MAESTRO_BULK_SELL_BOUGHT_PRICE_ONE"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_BOUGHT_PRICE_TWO=$SPOTLIGHT_MAESTRO_BULK_SELL_BOUGHT_PRICE_TWO"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_ONE=$SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_ONE"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_TWO=$SPOTLIGHT_MAESTRO_BULK_SELL_SOLD_PRICE_ID_TWO"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_ONE=$SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_ONE"
  -e "SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_TWO=$SPOTLIGHT_MAESTRO_BULK_SELL_PRICE_TWO"
  -e "SPOTLIGHT_STAGING_SMOKE_EXPECTED_APP_ENV_TEST_ID=$STAGING_SMOKE_APP_ENV_TEST_ID"
  -e "SPOTLIGHT_STAGING_SMOKE_EXPECTED_API_BASE_URL_TEST_ID=$STAGING_SMOKE_API_BASE_URL_TEST_ID"
)

echo "== verify staging app is ready before auth bootstrap =="
maestro test "${MAESTRO_ENV_ARGS[@]}" "$MAESTRO_FLOW_DIR/staging-smoke-runtime-assertions.yml"

echo "== bootstrap staging smoke session =="
BOOTSTRAP_URL="${SPOTLIGHT_MAESTRO_AUTH_BOOTSTRAP_LINK:-}"
if [ -z "$BOOTSTRAP_URL" ]; then
  BOOTSTRAP_URL="$(python3 "$SCRIPT_DIR/bootstrap_staging_simulator_auth.py")"
fi
xcrun simctl openurl "$SIMULATOR_UDID" "$BOOTSTRAP_URL"
sleep "$AUTH_SETTLE_SECONDS"

echo "== run maestro staging smoke =="
maestro test "${MAESTRO_ENV_ARGS[@]}" "$MAESTRO_FLOW_DIR/staging-smoke.yml"

echo "== run maestro scanner fixture smoke =="
maestro test "${MAESTRO_ENV_ARGS[@]}" "$MAESTRO_FLOW_DIR/staging-scan-fixture-smoke.yml"
