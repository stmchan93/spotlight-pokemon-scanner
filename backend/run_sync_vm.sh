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

"$PYTHON_BIN" "$SCRIPT_DIR/sync_scrydex_catalog.py" \
  --database-path "$DATABASE_PATH" \
  --scheduled-for "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

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
