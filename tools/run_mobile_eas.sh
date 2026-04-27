#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/spotlight-rn"

ENVIRONMENT="${1:-}"
ACTION="${2:-}"
PLATFORM="${3:-ios}"
PROFILE="${4:-$ENVIRONMENT}"
ENV_FILE="$APP_DIR/.env.${ENVIRONMENT}"

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

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Create it from apps/spotlight-rn/.env.${ENVIRONMENT}.example" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
export SPOTLIGHT_APP_ENV="$ENVIRONMENT"
set +a

require_non_placeholder_env "EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL"
require_non_placeholder_env "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_URL"
require_non_placeholder_env "EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY"
require_non_placeholder_env "SPOTLIGHT_EXPO_OWNER"

if [ "$PLATFORM" = "ios" ]; then
  require_non_placeholder_env "SPOTLIGHT_IOS_BUNDLE_IDENTIFIER"
fi

if [ "$PLATFORM" = "android" ]; then
  require_non_placeholder_env "SPOTLIGHT_ANDROID_PACKAGE"
fi

cd "$APP_DIR"

if [ "$ACTION" = "build" ]; then
  exec pnpm dlx eas-cli build --platform "$PLATFORM" --profile "$PROFILE"
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
  exec pnpm dlx eas-cli build --platform "$PLATFORM" --profile "$PROFILE" --auto-submit
fi

exec pnpm dlx eas-cli submit --platform "$PLATFORM" --profile "$PROFILE"
