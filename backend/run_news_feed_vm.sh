#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_CONFIG_FILE="${SPOTLIGHT_VM_RUNTIME_CONFIG:-$SCRIPT_DIR/.vm-runtime.conf}"

if [ ! -f "$RUNTIME_CONFIG_FILE" ]; then
  echo "Missing VM runtime config: $RUNTIME_CONFIG_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$RUNTIME_CONFIG_FILE"
if [ -n "${SPOTLIGHT_RUNTIME_ENV_FILE:-}" ] && [ -f "${SPOTLIGHT_RUNTIME_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SPOTLIGHT_RUNTIME_ENV_FILE}"
fi
if [ -n "${SPOTLIGHT_SECRETS_FILE:-}" ] && [ -f "${SPOTLIGHT_SECRETS_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SPOTLIGHT_SECRETS_FILE}"
fi
# Re-apply runtime config last so VM-specific overrides win over staged defaults.
# shellcheck disable=SC1090
. "$RUNTIME_CONFIG_FILE"
set +a

# Card news + videos poller. Hourly at :17 via the deploy_to_vm.sh crontab
# (off the :00 mark, clear of the :05/:35 TCGCSV and :50 deal-scan minutes).
#
# Same flag as the endpoint: the job is a no-op until the env turns the feature on,
# so installing the cron line early costs nothing. YOUTUBE_API_KEY is optional —
# without it the YouTube half logs once and skips.
case "$(printf '%s' "${NEWS_FEED_ENABLED:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ;;
  *)
    echo "$(date -u +%FT%TZ) news-feed: NEWS_FEED_ENABLED is off — skipping."
    exit 0
    ;;
esac

PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$SCRIPT_DIR/data/spotlight_scanner.sqlite}"
NEWS_FEED_LOCK_FILE="${SPOTLIGHT_NEWS_FEED_LOCK_FILE:-$SCRIPT_DIR/data/news-feed.lock}"
FLOCK_BIN="${FLOCK_BIN_OVERRIDE:-$(command -v flock || true)}"
HOSTNAME_VALUE="$(hostname -s 2>/dev/null || hostname)"
export SPOTLIGHT_RUNTIME_LABEL="${SPOTLIGHT_RUNTIME_LABEL:-vm-news-feed:${HOSTNAME_VALUE}}"

if [ -z "$FLOCK_BIN" ]; then
  echo "flock is required to run the news feed poller." >&2
  exit 1
fi

echo "[news-feed] $(date -u +"%Y-%m-%dT%H:%M:%SZ") polling"
# A slow previous run (a feed hanging to its timeout) must not stack up a second one.
# "$@" forwards manual flags (--skip-youtube, --skip-rss); the cron passes none.
if ! "$FLOCK_BIN" -n "$NEWS_FEED_LOCK_FILE" \
  "$PYTHON_BIN" "$SCRIPT_DIR/news_feed.py" --database-path "$DATABASE_PATH" "$@"; then
  echo "[news-feed] run failed or lock already held (non-fatal)" >&2
fi
