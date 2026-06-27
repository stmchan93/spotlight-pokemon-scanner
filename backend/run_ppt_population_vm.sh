#!/bin/bash

# Daily PPT GemRate population refresh (enrichment-only — writes population_json,
# NEVER a price/provider). Timed by cron just after the PPT /export resets at
# 06:00 UTC. Downloads the bulk `type=population` dump (1 of the 2 daily exports)
# and runs the metadata-only population sync. The PPT key is read from the env
# (SPOTLIGHT_SECRETS_FILE), never passed on the command line.

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

PYTHON_BIN="${SPOTLIGHT_VM_PYTHON:-$SCRIPT_DIR/.venv/bin/python}"
DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$SCRIPT_DIR/data/spotlight_scanner.sqlite}"
EXPORT_PATH="/tmp/ppt_export_population.csv"

if [ -z "${PPT_API_KEY:-}" ]; then
  echo "[ppt-pop] PPT_API_KEY not set (add it to SPOTLIGHT_SECRETS_FILE)" >&2
  exit 1
fi

echo "[ppt-pop] $(date -u +%FT%TZ) downloading population export"
# Key is read from os.environ inside python — kept off the process command line.
"$PYTHON_BIN" - "$EXPORT_PATH" <<'PY'
import os, sys
from sync_ppt_catalog import download_ppt_export
data = download_ppt_export(os.environ["PPT_API_KEY"], "population")
with open(sys.argv[1], "wb") as f:
    f.write(data)
header = data.decode("utf-8", "replace").splitlines()[:1]
print(f"[ppt-pop] downloaded {len(data)} bytes; header={header}")
PY

echo "[ppt-pop] $(date -u +%FT%TZ) running population sync"
"$PYTHON_BIN" "$SCRIPT_DIR/sync_ppt_catalog.py" \
  --population-csv "$EXPORT_PATH" \
  --database-path "$DATABASE_PATH"
echo "[ppt-pop] $(date -u +%FT%TZ) done"
