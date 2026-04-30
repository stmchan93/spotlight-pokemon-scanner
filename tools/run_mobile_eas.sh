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
  echo "Usage: $0 <development|staging|production> <build|submit|release> [ios|android] [profile]" >&2
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
  build|submit|release)
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

if [ -z "${MOBILE_EAS_ENV_FILE:-}" ] && [ "$ENVIRONMENT" = "staging" ]; then
  TEMP_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/spotlight-mobile-${ENVIRONMENT}.XXXXXX.env")"
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
