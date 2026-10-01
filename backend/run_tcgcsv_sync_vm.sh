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
export SPOTLIGHT_RUNTIME_LABEL="${SPOTLIGHT_RUNTIME_LABEL:-vm-tcgcsv-sync:${HOSTNAME_VALUE}}"

# "$@" forwards manual flags (--force, --dry-run); the cron passes none.
"$PYTHON_BIN" "$SCRIPT_DIR/sync_tcgcsv_prices.py" \
  --database-path "$DATABASE_PATH" \
  --scheduled-for "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  "$@"

# TCGplayer-only cards (TCGCSV_TCGPLAYER_ONLY_INGEST=on) land in `cards` during
# the sync above; embed them into the visual index the same day. Staging never
# runs the Scrydex sync, whose run_sync_vm.sh hook would otherwise do this.
# Best-effort, same as there: a refresh failure must never fail the sync job.
case "$(printf '%s' "${TCGCSV_TCGPLAYER_ONLY_INGEST:-}" | tr '[:upper:]' '[:lower:]')" in
  on|1|true|yes)
    REFRESH_URL="http://127.0.0.1:8788/api/v1/ops/refresh-visual-index"
    if [ -n "${SPOTLIGHT_OPS_REFRESH_TOKEN:-}" ]; then
      REFRESH_URL="${REFRESH_URL}?token=${SPOTLIGHT_OPS_REFRESH_TOKEN}"
    fi
    echo "[tcgcsv] triggering incremental visual-index refresh"
    if curl -sS -m 900 -X POST "$REFRESH_URL"; then
      echo
      echo "[tcgcsv] visual-index refresh complete"
    else
      echo "[tcgcsv] visual-index refresh request failed (non-fatal)" >&2
    fi
    ;;
esac

# Post-sync: the TCGCSV write bumps pricing_sync_generation, which invalidates
# every owner's dashboard/collection/watchlist caches and the Top Trends cache.
# Staging runs no Scrydex sync, so without this the first user per owner after
# each daily sync paid the cold recompute (an 18s Top Trends miss contended with
# 5-29s collection reads on 2026-09-30). Same fire-and-forget hook as
# run_sync_vm.sh; a warm cache makes it a no-op. Never fails the sync job.
PREWARM_URL="http://127.0.0.1:8788/api/v1/ops/prewarm-portfolio"
if [ -n "${SPOTLIGHT_OPS_REFRESH_TOKEN:-}" ]; then
  PREWARM_URL="${PREWARM_URL}?token=${SPOTLIGHT_OPS_REFRESH_TOKEN}"
fi
echo "[tcgcsv] triggering portfolio cache prewarm"
if curl -sS -m 30 -X POST "$PREWARM_URL"; then
  echo
  echo "[tcgcsv] portfolio prewarm started"
else
  echo "[tcgcsv] portfolio prewarm request failed (non-fatal)" >&2
fi
