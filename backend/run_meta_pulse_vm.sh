#!/bin/bash

# Nightly Meta pulse compute (docs/meta-trends-news-feed-plan-2026-09-23.md).
# Reads price history already in the local DB and writes the small
# meta_pulse_* result tables — no network, no credits. Run it after the day's
# price syncs (TCGCSV 13:05 PT; Scrydex on production). Stays dark unless
# META_PULSE_ENABLED is truthy in the env/secrets files; pass --force to run
# anyway. Other flags (--games, --windows, --as-of) are forwarded.

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

FORCE=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=1
  else
    ARGS+=("$arg")
  fi
done

case "$(printf '%s' "${META_PULSE_ENABLED:-0}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ;;
  *)
    if [ "$FORCE" != "1" ]; then
      echo "[meta-pulse] $(date -u +"%Y-%m-%dT%H:%M:%SZ") META_PULSE_ENABLED is off; skipping"
      exit 0
    fi
    ;;
esac

PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$SCRIPT_DIR/data/spotlight_scanner.sqlite}"
HOSTNAME_VALUE="$(hostname -s 2>/dev/null || hostname)"
export SPOTLIGHT_RUNTIME_LABEL="${SPOTLIGHT_RUNTIME_LABEL:-vm-meta-pulse:${HOSTNAME_VALUE}}"

echo "[meta-pulse] $(date -u +"%Y-%m-%dT%H:%M:%SZ") computing"
cd "$SCRIPT_DIR"
"$PYTHON_BIN" "$SCRIPT_DIR/meta_pulse.py" \
  --compute \
  --database-path "$DATABASE_PATH" \
  ${ARGS[@]+"${ARGS[@]}"}
echo "[meta-pulse] $(date -u +"%Y-%m-%dT%H:%M:%SZ") done"
