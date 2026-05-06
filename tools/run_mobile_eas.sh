#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/spotlight-rn"
RELEASE_NOTES_SCRIPT="$REPO_ROOT/tools/release_notes.mjs"
ENV_RESOLVER_SCRIPT="$REPO_ROOT/tools/mobile_env_resolver.py"

ENVIRONMENT="${1:-}"
ACTION="${2:-}"
PLATFORM="${3:-ios}"
PROFILE="${4:-$ENVIRONMENT}"
ENV_FILE="${MOBILE_EAS_ENV_FILE:-$APP_DIR/.env.${ENVIRONMENT}}"
TEMP_ENV_FILE=""

if [ -z "$ENVIRONMENT" ] || [ -z "$ACTION" ]; then
  echo "Usage: $0 <development|staging|production> <build|submit|release|update> [ios|android] [profile]" >&2
  exit 1
fi

case "$ENVIRONMENT" in
  development|staging|production)
    ;;
  *)
    echo "Unsupported environment: $ENVIRONMENT" >&2
    exit 1
    ;;
esac

case "$ACTION" in
  build|submit|release|update)
    ;;
  *)
    echo "Unsupported action: $ACTION" >&2
    exit 1
    ;;
esac

require_non_placeholder_env() {
  local key="$1"
  local value="${!key:-}"
  if [ -z "$value" ]; then
    echo "Missing required value in $ENV_FILE: $key" >&2
    exit 1
  fi
  case "$value" in
    *example.com*|*your-project-ref*|*your-supabase-anon-or-publishable-key*|*com.yourcompany.*|your-expo-account|00000000-0000-0000-0000-000000000000)
      echo "Placeholder value detected for $key in $ENV_FILE. Replace it before running this command." >&2
      exit 1
      ;;
  esac
}

require_non_empty_env() {
  local key="$1"
  local value="${!key:-}"
  if [ -z "$value" ]; then
    echo "Missing required value for $key." >&2
    exit 1
  fi
}

is_enabled_flag() {
  case "${1:-}" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

cleanup() {
  if [ -n "$TEMP_ENV_FILE" ] && [ -f "$TEMP_ENV_FILE" ]; then
    rm -f "$TEMP_ENV_FILE"
  fi
}

trap cleanup EXIT INT TERM

create_temp_env_file() {
  python3 - "$1" "${TMPDIR:-/tmp}" <<'PY'
import os
import sys
import tempfile

environment = sys.argv[1]
tmpdir = sys.argv[2]
fd, path = tempfile.mkstemp(prefix=f"spotlight-mobile-{environment}.", suffix=".env", dir=tmpdir)
os.close(fd)
print(path)
PY
}

ensure_clean_git_worktree() {
  if [ "${SPOTLIGHT_ALLOW_DIRTY_MOBILE_RELEASE:-0}" = "1" ]; then
    return 0
  fi

  local status_output
  status_output="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)"
  if [ -n "$status_output" ]; then
    echo "Refusing to run $ACTION for $ENVIRONMENT with a dirty git worktree." >&2
    echo "Commit or stash your changes first, or set SPOTLIGHT_ALLOW_DIRTY_MOBILE_RELEASE=1 to bypass." >&2
    echo "$status_output" >&2
    exit 1
  fi
}

resolve_eas_server_environment() {
  python3 - "$APP_DIR/eas.json" "$PROFILE" <<'PY'
import json
import sys

eas_json_path = sys.argv[1]
profile = sys.argv[2]
with open(eas_json_path, "r", encoding="utf-8") as handle:
    data = json.load(handle)

environment = (
    ((data.get("build") or {}).get(profile) or {}).get("environment")
    or profile
)
print(str(environment).strip())
PY
}

verify_channel_head_matches_git_commit() {
  local channel_name="$1"
  local platform_name="$2"
  local expected_commit="$3"
  local channel_json

  channel_json="$(pnpm dlx eas-cli channel:view "$channel_name" --json 2>/dev/null)"
  python3 - "$platform_name" "$expected_commit" "$channel_json" <<'PY'
import json
import sys

platform = sys.argv[1]
expected_commit = sys.argv[2]
payload = json.loads(sys.argv[3])

groups = (
    ((payload.get("currentPage") or {}).get("updateBranches") or [{}])[0]
    .get("updateGroups")
    or []
)
if not groups or not groups[0]:
    raise SystemExit("Could not find any update groups on the channel.")

latest_group = groups[0]
matching_update = next((item for item in latest_group if item.get("platform") == platform), None)
if matching_update is None:
    raise SystemExit(f"Could not find a {platform} update in the latest channel group.")

actual_commit = str(matching_update.get("gitCommitHash") or "").strip()
if actual_commit != expected_commit:
    raise SystemExit(
        f"Staging channel drift detected for {platform}: expected {expected_commit}, got {actual_commit or '<empty>'}."
    )

print(actual_commit)
PY
}

if [ -z "${MOBILE_EAS_ENV_FILE:-}" ] && [ "$ENVIRONMENT" = "staging" ]; then
  TEMP_ENV_FILE="$(create_temp_env_file "$ENVIRONMENT")"
  python3 "$ENV_RESOLVER_SCRIPT" --environment "$ENVIRONMENT" --profile "$PROFILE" --output "$TEMP_ENV_FILE"
  ENV_FILE="$TEMP_ENV_FILE"
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  export SPOTLIGHT_APP_ENV="$ENVIRONMENT"
  export EXPO_NO_DOTENV=1
  set +a
elif [ "${CI:-}" != "true" ] && [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Create it from apps/spotlight-rn/.env.${ENVIRONMENT}.example" >&2
  exit 1
fi

export SPOTLIGHT_APP_ENV="$ENVIRONMENT"
export EXPO_NO_DOTENV=1

EAS_SERVER_ENVIRONMENT="$(resolve_eas_server_environment)"

require_non_placeholder_env "EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL"
require_non_placeholder_env "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL"
require_non_placeholder_env "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY"
require_non_placeholder_env "EXPO_PUBLIC_SPOTLIGHT_AUTH_REDIRECT_URL"
require_non_placeholder_env "EXPO_PUBLIC_SPOTLIGHT_AUTH_SCHEME"
require_non_placeholder_env "SPOTLIGHT_APP_SCHEME"
require_non_placeholder_env "SPOTLIGHT_EXPO_OWNER"
require_non_placeholder_env "SPOTLIGHT_EAS_PROJECT_ID"

if [ "$PLATFORM" = "ios" ]; then
  require_non_placeholder_env "SPOTLIGHT_IOS_BUNDLE_IDENTIFIER"
fi

if [ "$PLATFORM" = "android" ]; then
  require_non_placeholder_env "SPOTLIGHT_ANDROID_PACKAGE"
fi

if is_enabled_flag "${EXPO_PUBLIC_SPOTLIGHT_POSTHOG_ENABLED:-0}"; then
  require_non_empty_env "EXPO_PUBLIC_SPOTLIGHT_POSTHOG_API_KEY"
  if [ -n "${EXPO_PUBLIC_SPOTLIGHT_POSTHOG_HOST:-}" ]; then
    require_non_placeholder_env "EXPO_PUBLIC_SPOTLIGHT_POSTHOG_HOST"
  fi
fi

cd "$APP_DIR"

resolve_build_message() {
  if [ -n "${SPOTLIGHT_BUILD_MESSAGE:-}" ]; then
    printf '%s' "$SPOTLIGHT_BUILD_MESSAGE"
    return 0
  fi

  if [ -f "$RELEASE_NOTES_SCRIPT" ]; then
    node "$RELEASE_NOTES_SCRIPT" --format build-message 2>/dev/null || true
  fi
}

resolve_testflight_notes() {
  if [ -n "${SPOTLIGHT_TESTFLIGHT_NOTES:-}" ]; then
    printf '%s' "$SPOTLIGHT_TESTFLIGHT_NOTES"
    return 0
  fi

  if [ -n "${SPOTLIGHT_TESTFLIGHT_NOTES_FILE:-}" ] && [ -f "$SPOTLIGHT_TESTFLIGHT_NOTES_FILE" ]; then
    cat "$SPOTLIGHT_TESTFLIGHT_NOTES_FILE"
    return 0
  fi

  if [ -f "$RELEASE_NOTES_SCRIPT" ]; then
    node "$RELEASE_NOTES_SCRIPT" --format testflight 2>/dev/null || true
  fi
}

BUILD_MESSAGE="$(resolve_build_message)"
TESTFLIGHT_NOTES=""
if [ "$PLATFORM" = "ios" ] && [ "$ENVIRONMENT" != "development" ]; then
  TESTFLIGHT_NOTES="$(resolve_testflight_notes)"
fi

if [ "$ENVIRONMENT" != "development" ] && [ "$ACTION" != "submit" ]; then
  ensure_clean_git_worktree
  export SPOTLIGHT_RUNTIME_VERSION="$ENVIRONMENT-$(git -C "$REPO_ROOT" rev-parse HEAD)"
fi

TESTFLIGHT_CHANGELOG_ENABLED="${SPOTLIGHT_EAS_TESTFLIGHT_CHANGELOG_ENABLED:-0}"
testflight_changelog_enabled() {
  case "$TESTFLIGHT_CHANGELOG_ENABLED" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

log_testflight_notes_skipped() {
  echo "Skipping TestFlight changelog notes because EAS changelog submission requires an Enterprise plan." >&2
  echo "Set SPOTLIGHT_EAS_TESTFLIGHT_CHANGELOG_ENABLED=1 to pass --what-to-test explicitly." >&2
}

run_update() {
  local channel_name="$ENVIRONMENT"
  local expected_commit
  expected_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"

  UPDATE_ARGS=(update --channel "$channel_name" --platform "$PLATFORM" --environment "$EAS_SERVER_ENVIRONMENT" --non-interactive)
  if [ -n "$BUILD_MESSAGE" ]; then
    UPDATE_ARGS+=(--message "$BUILD_MESSAGE")
  fi

  pnpm dlx eas-cli "${UPDATE_ARGS[@]}"
  verify_channel_head_matches_git_commit "$channel_name" "$PLATFORM" "$expected_commit" >/dev/null
}

if [ "$ACTION" = "update" ]; then
  run_update
  exit 0
fi

if [ "$ACTION" = "build" ]; then
  BUILD_ARGS=(build --platform "$PLATFORM" --profile "$PROFILE")
  if [ -n "$BUILD_MESSAGE" ]; then
    BUILD_ARGS+=(--message "$BUILD_MESSAGE")
  fi
  exec pnpm dlx eas-cli "${BUILD_ARGS[@]}"
fi

if [ "$ACTION" = "release" ]; then
  if [ "$ENVIRONMENT" = "development" ]; then
    echo "The development profile is for internal dev-client builds only. Use staging or production for TestFlight release." >&2
    exit 1
  fi
  if [ "$PLATFORM" != "ios" ]; then
    echo "The release action is currently intended for iOS/TestFlight." >&2
    exit 1
  fi
  if [ "$ENVIRONMENT" = "staging" ]; then
    run_update
  fi
  BUILD_ARGS=(build --platform "$PLATFORM" --profile "$PROFILE" --auto-submit)
  if [ -n "$BUILD_MESSAGE" ]; then
    BUILD_ARGS+=(--message "$BUILD_MESSAGE")
  fi
  if [ -n "$TESTFLIGHT_NOTES" ]; then
    if testflight_changelog_enabled; then
      BUILD_ARGS+=(--what-to-test "$TESTFLIGHT_NOTES")
    else
      log_testflight_notes_skipped
    fi
  fi
  exec pnpm dlx eas-cli "${BUILD_ARGS[@]}"
fi

SUBMIT_ARGS=(submit --platform "$PLATFORM" --profile "$PROFILE")
if [ -n "$TESTFLIGHT_NOTES" ]; then
  if testflight_changelog_enabled; then
    SUBMIT_ARGS+=(--what-to-test "$TESTFLIGHT_NOTES")
  else
    log_testflight_notes_skipped
  fi
fi
exec pnpm dlx eas-cli "${SUBMIT_ARGS[@]}"
