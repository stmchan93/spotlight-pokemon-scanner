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
# shellcheck disable=SC1090
. "$RUNTIME_CONFIG_FILE"
set +a

PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
SYNC_CRON_SCHEDULE="${SPOTLIGHT_VM_SYNC_CRON:-0 13 * * *}"
SYNC_CRON_TIMEZONE="${SPOTLIGHT_VM_SYNC_CRON_TZ:-America/Los_Angeles}"
SYNC_LOCK_FILE="${SPOTLIGHT_SYNC_LOCK_FILE:-$SCRIPT_DIR/data/scrydex-sync.lock}"
SYNC_LOG_FILE="${SPOTLIGHT_SYNC_LOG_FILE:-$SCRIPT_DIR/logs/scrydex_sync.log}"
FLOCK_BIN="${FLOCK_BIN_OVERRIDE:-$(command -v flock)}"

if [ -z "$FLOCK_BIN" ]; then
  echo "flock is required to run scheduled syncs." >&2
  exit 1
fi

# Catch-up: hourly retries for any game that has not synced for today's (UTC)
# price date. Every hour from 7 PM to 3 PM PT stamps the same UTC date as the
# 6 PM run; 4-6 PM is left out so a catch-up never runs AHEAD of the main sync
# once the UTC date rolls over. Empty string disables it.
SYNC_CATCHUP_CRON_SCHEDULE="${SPOTLIGHT_VM_SYNC_CATCHUP_CRON-15 19-23,0-15 * * *}"

run_mode=""
if "$PYTHON_BIN" "$SCRIPT_DIR/vm_sync_schedule.py" \
  --cron "$SYNC_CRON_SCHEDULE" \
  --timezone "$SYNC_CRON_TIMEZONE" \
  --should-run-now; then
  run_mode="main"
elif [ -n "$SYNC_CATCHUP_CRON_SCHEDULE" ] && "$PYTHON_BIN" "$SCRIPT_DIR/vm_sync_schedule.py" \
  --cron "$SYNC_CATCHUP_CRON_SCHEDULE" \
  --timezone "$SYNC_CRON_TIMEZONE" \
  --should-run-now; then
  run_mode="catch-up"
fi

if [ -z "$run_mode" ]; then
  exit 0
fi

sync_args=()
if [ "$run_mode" = "catch-up" ]; then
  sync_args+=(--catch-up)
fi

if ! "$FLOCK_BIN" -n "$SYNC_LOCK_FILE" "$SCRIPT_DIR/run_sync_vm.sh" "${sync_args[@]}" >> "$SYNC_LOG_FILE" 2>&1; then
  # Nonzero is either a held lock or a failed sync (run_sync_vm.sh logs and
  # pings for the latter itself).
  printf '[sync-scheduler] %s run ended nonzero (lock held or sync failed) for %s (%s)\n' \
    "$run_mode" "$SYNC_CRON_SCHEDULE" "$SYNC_CRON_TIMEZONE" >> "$SYNC_LOG_FILE"
fi
