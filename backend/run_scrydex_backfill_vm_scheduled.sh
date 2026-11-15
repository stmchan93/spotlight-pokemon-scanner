#!/bin/bash
# Nightly Scrydex history gap backfill (backfill_scrydex_history_gaps.py).
# Minute-level wrapper like run_sync_vm_scheduled.sh: it evaluates
# SPOTLIGHT_VM_SCRYDEX_BACKFILL_CRON in PT itself, and it takes the SAME lock as
# the Scrydex sync so the two never write the DB at the same time.
#
# Every request is one Scrydex credit. Budgets default to the Growth plan
# (50k/month, cycle on the 7th): the nightly sync uses ~17.4k, so the backfill
# may use 30k per cycle, 2k per night. Defaults live HERE, not in
# .vm-runtime.conf, because deploys rewrite that file. Set either to 0 to stop.
# The cron line is installed on production only (deploy_to_vm.sh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_CONFIG_FILE="${SPOTLIGHT_VM_RUNTIME_CONFIG:-$SCRIPT_DIR/.vm-runtime.conf}"
[ -f "$RUNTIME_CONFIG_FILE" ] || { echo "Missing VM runtime config: $RUNTIME_CONFIG_FILE" >&2; exit 1; }

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
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$SCRIPT_DIR/data/spotlight_scanner.sqlite}"
# 11:45 PM PT: after the 6 PM sync and its first catch-up retries.
BACKFILL_CRON="${SPOTLIGHT_VM_SCRYDEX_BACKFILL_CRON:-45 23 * * *}"
CRON_TIMEZONE="${SPOTLIGHT_VM_SYNC_CRON_TZ:-America/Los_Angeles}"
SYNC_LOCK_FILE="${SPOTLIGHT_SYNC_LOCK_FILE:-$SCRIPT_DIR/data/scrydex-sync.lock}"
LOG_FILE="${SPOTLIGHT_SCRYDEX_BACKFILL_LOG_FILE:-$SCRIPT_DIR/logs/scrydex_backfill.log}"
NIGHTLY_MAX="${SPOTLIGHT_SCRYDEX_BACKFILL_NIGHTLY_MAX:-2000}"
CYCLE_BUDGET="${SPOTLIGHT_SCRYDEX_BACKFILL_CYCLE_BUDGET:-30000}"
CYCLE_DAY="${SPOTLIGHT_SCRYDEX_BILLING_CYCLE_DAY:-7}"
MAX_TIER="${SPOTLIGHT_SCRYDEX_BACKFILL_MAX_TIER:-2}"

if ! "$PYTHON_BIN" "$SCRIPT_DIR/vm_sync_schedule.py" --cron "$BACKFILL_CRON" --timezone "$CRON_TIMEZONE" --should-run-now; then
  exit 0
fi
if [ "$NIGHTLY_MAX" -le 0 ] || [ "$CYCLE_BUDGET" -le 0 ]; then
  exit 0
fi

export SPOTLIGHT_RUNTIME_LABEL="${SPOTLIGHT_RUNTIME_LABEL:-vm-scrydex-backfill:$(hostname -s 2>/dev/null || hostname)}"
if ! flock -n "$SYNC_LOCK_FILE" "$PYTHON_BIN" "$SCRIPT_DIR/backfill_scrydex_history_gaps.py" \
  --database-path "$DATABASE_PATH" \
  --max-requests "$NIGHTLY_MAX" \
  --cycle-budget "$CYCLE_BUDGET" \
  --cycle-day "$CYCLE_DAY" \
  --max-tier "$MAX_TIER" >> "$LOG_FILE" 2>&1; then
  printf '[scrydex-backfill] %s ended nonzero (sync lock held or job failed)\n' "$(date -u +%FT%TZ)" >> "$LOG_FILE"
fi
