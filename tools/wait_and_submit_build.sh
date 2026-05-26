#!/bin/bash
#
# Polls an EAS build by ID until it reaches a terminal state, then submits the
# finished artifact to App Store Connect. Designed for unattended overnight
# runs: env is resolved via mobile_env_resolver.py so it works without a
# pre-existing .env file, and all eas-cli invocations use --non-interactive.
#
# Usage: wait_and_submit_build.sh <build-id> [environment] [profile] [platform]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/spotlight-rn"
ENV_RESOLVER_SCRIPT="$REPO_ROOT/tools/mobile_env_resolver.py"

BUILD_ID="${1:-}"
ENVIRONMENT="${2:-staging}"
PROFILE="${3:-$ENVIRONMENT}"
PLATFORM="${4:-ios}"

if [ -z "$BUILD_ID" ]; then
  echo "Usage: $0 <build-id> [environment] [profile] [platform]" >&2
  exit 1
fi

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

TEMP_ENV_FILE="$(mktemp -t "spotlight-submit-${ENVIRONMENT}.XXXXXX.env")"
cleanup() {
  if [ -n "${TEMP_ENV_FILE:-}" ] && [ -f "$TEMP_ENV_FILE" ]; then
    rm -f "$TEMP_ENV_FILE"
  fi
}
trap cleanup EXIT INT TERM

python3 "$ENV_RESOLVER_SCRIPT" --environment "$ENVIRONMENT" --profile "$PROFILE" --output "$TEMP_ENV_FILE"

set -a
# shellcheck disable=SC1090
. "$TEMP_ENV_FILE"
export SPOTLIGHT_APP_ENV="$ENVIRONMENT"
export EXPO_NO_DOTENV=1
set +a

cd "$APP_DIR"

POLL_SECONDS=60
MAX_WAIT_SECONDS=$((90 * 60))
START_TS=$(date +%s)

log "Watching build $BUILD_ID (env=$ENVIRONMENT profile=$PROFILE platform=$PLATFORM)"

while true; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - START_TS ))
  if [ "$ELAPSED" -gt "$MAX_WAIT_SECONDS" ]; then
    log "ERROR: exceeded $MAX_WAIT_SECONDS seconds waiting for build $BUILD_ID"
    exit 2
  fi

  BUILD_JSON="$(pnpm dlx eas-cli build:view "$BUILD_ID" --json 2>/dev/null || true)"
  if [ -z "$BUILD_JSON" ]; then
    log "build:view returned empty payload; retrying in $POLL_SECONDS s"
    sleep "$POLL_SECONDS"
    continue
  fi

  STATUS=$(echo "$BUILD_JSON" | python3 -c 'import json,sys; print((json.load(sys.stdin) or {}).get("status",""))' 2>/dev/null || echo "")
  log "build status: ${STATUS:-<empty>}"

  case "$STATUS" in
    FINISHED|finished)
      log "Build finished. Submitting to TestFlight."
      break
      ;;
    ERRORED|errored|CANCELED|canceled)
      log "ERROR: build terminated with status=$STATUS; aborting submit"
      exit 3
      ;;
    *)
      sleep "$POLL_SECONDS"
      ;;
  esac
done

SUBMIT_OUTPUT="$(pnpm dlx eas-cli submit --platform "$PLATFORM" --profile "$PROFILE" --id "$BUILD_ID" --non-interactive 2>&1)"
SUBMIT_EXIT=$?
echo "$SUBMIT_OUTPUT"
if [ "$SUBMIT_EXIT" -ne 0 ]; then
  log "ERROR: eas submit exited with code $SUBMIT_EXIT"
  exit "$SUBMIT_EXIT"
fi

log "Submit dispatched. TestFlight will email when Apple finishes processing."
