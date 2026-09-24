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

# Set spotlight weekly pick + stored payload. Daily via the deploy_to_vm.sh
# crontab. Writes a small precomputed table in this box's own database; the feed
# endpoint only reads it. Same flag as the endpoint, so the cron line is a no-op
# until the env turns the feature on.
case "$(printf '%s' "${SET_SPOTLIGHT_ENABLED:-0}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ;;
  *)
    echo "[set-spotlight] $(date -u +"%Y-%m-%dT%H:%M:%SZ") SET_SPOTLIGHT_ENABLED is off; skipping"
    exit 0
    ;;
esac

PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$SCRIPT_DIR/data/spotlight_scanner.sqlite}"
HOSTNAME_VALUE="$(hostname -s 2>/dev/null || hostname)"
export SPOTLIGHT_RUNTIME_LABEL="${SPOTLIGHT_RUNTIME_LABEL:-vm-set-spotlight:${HOSTNAME_VALUE}}"

echo "[set-spotlight] $(date -u +"%Y-%m-%dT%H:%M:%SZ") computing"
# "$@" forwards manual flags; the cron passes none.
cd "$SCRIPT_DIR"
"$PYTHON_BIN" "$SCRIPT_DIR/set_spotlight.py" --database-path "$DATABASE_PATH" "$@"
