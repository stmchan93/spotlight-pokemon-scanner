#!/bin/bash

# Hourly market-alert pushes (price moves, Sunday summary, deferred deals).
# Hourly because every window is in the USER's local time: quiet hours
# 21:00-09:00 and the Sunday 17:00 summary land on different UTC hours per user.
# Reads the local DB only; the limiter (1 push/user/day, 3-day card cooldown,
# quiet-hours deferral) lives in market_alerts.py. Stays dark unless
# MARKET_ALERTS_ENABLED is truthy in the env files. Flags (--dry-run, --now)
# are forwarded.

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

case "$(printf '%s' "${MARKET_ALERTS_ENABLED:-0}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ;;
  *)
    echo "[market-alerts] $(date -u +"%Y-%m-%dT%H:%M:%SZ") MARKET_ALERTS_ENABLED is off; skipping"
    exit 0
    ;;
esac

PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$SCRIPT_DIR/data/spotlight_scanner.sqlite}"
MARKET_ALERTS_LOCK_FILE="${SPOTLIGHT_MARKET_ALERTS_LOCK_FILE:-$SCRIPT_DIR/data/market-alerts.lock}"
FLOCK_BIN="${FLOCK_BIN_OVERRIDE:-$(command -v flock || true)}"
HOSTNAME_VALUE="$(hostname -s 2>/dev/null || hostname)"
export SPOTLIGHT_RUNTIME_LABEL="${SPOTLIGHT_RUNTIME_LABEL:-vm-market-alerts:${HOSTNAME_VALUE}}"

if [ -z "$FLOCK_BIN" ]; then
  echo "flock is required to run the market alerts job." >&2
  exit 1
fi

echo "[market-alerts] $(date -u +"%Y-%m-%dT%H:%M:%SZ") running"
cd "$SCRIPT_DIR"
# The ledger's UNIQUE claim already makes an overlap harmless; the lock just
# keeps a slow run from stacking a second one.
if ! "$FLOCK_BIN" -n "$MARKET_ALERTS_LOCK_FILE" \
  "$PYTHON_BIN" "$SCRIPT_DIR/market_alerts.py" --database-path "$DATABASE_PATH" "$@"; then
  echo "[market-alerts] run failed or lock already held (non-fatal)" >&2
fi
