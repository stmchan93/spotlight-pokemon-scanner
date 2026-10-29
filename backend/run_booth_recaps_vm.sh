#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_CONFIG_FILE="${SPOTLIGHT_VM_RUNTIME_CONFIG:-$SCRIPT_DIR/.vm-runtime.conf}"

set -a
if [ -f "$RUNTIME_CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$RUNTIME_CONFIG_FILE"
fi
if [ -n "${SPOTLIGHT_RUNTIME_ENV_FILE:-}" ] && [ -f "${SPOTLIGHT_RUNTIME_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SPOTLIGHT_RUNTIME_ENV_FILE}"
fi
if [ -n "${SPOTLIGHT_SECRETS_FILE:-}" ] && [ -f "${SPOTLIGHT_SECRETS_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${SPOTLIGHT_SECRETS_FILE}"
fi
set +a

# Post-show booth recaps (send_booth_recaps.py). Daily via the deploy_to_vm.sh
# crontab; the SQL dedupes per claimer + show, so a re-run sends nothing new.
# Missing Supabase credentials log "booth recaps disabled" and exit 0.
PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$SCRIPT_DIR/data/spotlight_scanner.sqlite}"

cd "$SCRIPT_DIR"
exec "$PYTHON_BIN" "$SCRIPT_DIR/send_booth_recaps.py" --database-path "$DATABASE_PATH" "$@"
