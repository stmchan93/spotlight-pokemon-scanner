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

PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$SCRIPT_DIR/data/spotlight_scanner.sqlite}"
HOSTNAME_VALUE="$(hostname -s 2>/dev/null || hostname)"
export SPOTLIGHT_RUNTIME_LABEL="${SPOTLIGHT_RUNTIME_LABEL:-vm-sync:${HOSTNAME_VALUE}}"

# Every supported game, in catalog_tools.GAMES registry order. The sync loops
# per game inside sync_scrydex_catalog.py (own provider_sync_runs row each,
# continue-on-failure), so a dead game still exits nonzero AFTER the others ran.
#
# Extra args pass through: the catch-up schedule adds --catch-up (only games not
# yet synced today, capped attempts).
#
# Alerts (Healthchecks.io): a failure pings `<url>/fail`, which alerts at once —
# but only when retries are exhausted. A failure with catch-up attempts left
# (exit 4: one Scrydex page timing out) pings `<url>/log`, which records the
# event on the check without changing its state or alerting (2026-11-15: a
# single 504 at 6 PM paged "ekalight-prod is DOWN" though the retry succeeded).
# SPOTLIGHT_SYNC_PING_URL is a dedicated daily check (also pinged on success, so
# its grace period catches a run that never happened). Without one, failures go
# to the VM health check's URL instead; the 11/12-11/15 lock failures went
# unnoticed for four days with no alert at all.
sync_ping() {
  if [ -n "${SPOTLIGHT_SYNC_PING_URL:-}" ]; then
    curl -fsS -m 10 --retry 3 "${SPOTLIGHT_SYNC_PING_URL}$1" >/dev/null 2>&1 || true
  elif { [ "$1" = "/fail" ] || [ "$1" = "/log" ]; } && [ -n "${SPOTLIGHT_HEALTHCHECK_PING_URL:-}" ]; then
    curl -fsS -m 10 --retry 3 "${SPOTLIGHT_HEALTHCHECK_PING_URL}$1" >/dev/null 2>&1 || true
  fi
}

set +e
"$PYTHON_BIN" "$SCRIPT_DIR/sync_scrydex_catalog.py" \
  --database-path "$DATABASE_PATH" \
  --games pokemon,onepiece,lorcana,riftbound,gundam \
  --scheduled-for "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  "$@"
SYNC_EXIT_CODE=$?
set -e

if [ "$SYNC_EXIT_CODE" -eq 3 ]; then
  echo "[sync] catch-up: every game already synced today, nothing to do"
  exit 0
fi
if [ "$SYNC_EXIT_CODE" -eq 4 ]; then
  echo "[sync] a game failed but has retries left; the hourly catch-up will retry (no alert)" >&2
  sync_ping /log
  exit "$SYNC_EXIT_CODE"
fi
if [ "$SYNC_EXIT_CODE" -ne 0 ]; then
  echo "[sync] FAILED (exit $SYNC_EXIT_CODE): out of retries today, or a non-retryable error" >&2
  sync_ping /fail
  exit "$SYNC_EXIT_CODE"
fi
sync_ping ""

# Post-sync: embed any newly-synced cards into the visual index and hot-reload
# the matcher in place (no restart, no downtime), so new Scrydex sets become
# scannable the same day instead of waiting for a manual full rebuild. This is
# best-effort: a refresh failure must never fail the sync job.
REFRESH_URL="http://127.0.0.1:8788/api/v1/ops/refresh-visual-index"
if [ -n "${SPOTLIGHT_OPS_REFRESH_TOKEN:-}" ]; then
  REFRESH_URL="${REFRESH_URL}?token=${SPOTLIGHT_OPS_REFRESH_TOKEN}"
fi
echo "[sync] triggering incremental visual-index refresh"
if curl -sS -m 900 -X POST "$REFRESH_URL"; then
  echo
  echo "[sync] visual-index refresh complete"
else
  echo "[sync] visual-index refresh request failed (non-fatal)" >&2
fi

# Post-sync: the new price snapshot moves MAX(price_date), which invalidates
# every owner's dashboard/inventory/performance caches — without a prewarm the
# first user per owner pays a ~25s cold recompute. The endpoint kicks off the
# warm in a background thread and acks immediately, so a short timeout is
# enough. Best-effort: a prewarm failure must never fail the sync job.
PREWARM_URL="http://127.0.0.1:8788/api/v1/ops/prewarm-portfolio"
if [ -n "${SPOTLIGHT_OPS_REFRESH_TOKEN:-}" ]; then
  PREWARM_URL="${PREWARM_URL}?token=${SPOTLIGHT_OPS_REFRESH_TOKEN}"
fi
echo "[sync] triggering portfolio cache prewarm"
if curl -sS -m 30 -X POST "$PREWARM_URL"; then
  echo
  echo "[sync] portfolio prewarm started"
else
  echo "[sync] portfolio prewarm request failed (non-fatal)" >&2
fi
