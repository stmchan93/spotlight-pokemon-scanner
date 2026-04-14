#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_ROOT="$REPO_ROOT/backend"

DATABASE_PATH="${SPOTLIGHT_DATABASE_PATH:-$BACKEND_ROOT/data/spotlight_scanner.sqlite}"

python3 "$BACKEND_ROOT/sync_scrydex_catalog.py" \
  --database-path "$DATABASE_PATH" \
  "$@"
