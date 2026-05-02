#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -d "$REPO_ROOT/backend" ]; then
  BACKEND_DIR="$REPO_ROOT/backend"
else
  BACKEND_DIR="$REPO_ROOT"
fi
RUNTIME_CONFIG_FILE="${SPOTLIGHT_VM_RUNTIME_CONFIG:-$BACKEND_DIR/.vm-runtime.conf}"

if [ -f "$RUNTIME_CONFIG_FILE" ]; then
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
  # Re-apply runtime config last so VM overrides win.
  # shellcheck disable=SC1090
  . "$RUNTIME_CONFIG_FILE"
  set +a
fi

PYTHON_BIN="${SPOTLIGHT_LABELING_RETRAIN_PYTHON:-${SPOTLIGHT_VM_PYTHON:-python3}}"
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$BACKEND_DIR/data/spotlight_scanner.sqlite}"
RESTART_SERVICE="${SPOTLIGHT_LABELING_RETRAIN_RESTART_SERVICE:-spotlight-backend.service}"

cd "$REPO_ROOT"

exec "$PYTHON_BIN" tools/run_labeling_retrain_cycle.py \
  --environment staging \
  --database-path "$DATABASE_PATH" \
  --publish-if-pass \
  --restart-service "$RESTART_SERVICE" \
  "$@"
