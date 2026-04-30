#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SMOKE_ENV_FILE="${SPOTLIGHT_STAGING_SMOKE_ENV_FILE:-$REPO_ROOT/.env.staging.smoke.local}"

if [ -f "$SMOKE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$SMOKE_ENV_FILE"
  set +a
fi

echo "== run staging backend prerelease gate =="
python3 "$SCRIPT_DIR/run_release_gate.py" --environment staging --skip-deploy "$@"

echo "== run staging iOS simulator UI smoke =="
bash "$SCRIPT_DIR/run_local_staging_ui_smoke.sh"
