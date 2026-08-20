#!/usr/bin/env bash
# Start the spike backend against the MERGED multi-game test catalog.
#
# Two things this sets up that a plain `python backend/server.py` does not:
#   1. the merged database (Pokémon + the four new games in ONE catalog — the
#      per-game POC databases can't be served together, and the backend serves
#      exactly one file)
#   2. the Pokémon visual index, which lives in the MAIN tree; only the four new
#      per-game indexes were built here, so without these the Pokémon lane would
#      report itself unavailable
#
# Port 8788 matches EXPO_PUBLIC_SPOTLIGHT_API_BASE_URL in .env.development.example,
# so the app needs no config change.
set -euo pipefail

MAIN=/Users/stephenchan/Code/spotlight
WORKTREE=/Users/stephenchan/Code/spotlight-onepiece
DB="$WORKTREE/backend/data/spotlight_multigame_test.sqlite"

if [ ! -f "$DB" ]; then
  echo "Missing $DB — build it first (see docs/one-piece-tcg-spike-2026-08-13.md)." >&2
  exit 1
fi

cd "$WORKTREE"
export SPOTLIGHT_DATABASE_PATH="$DB"
export SPOTLIGHT_VISUAL_INDEX_NPZ_PATH="$MAIN/backend/data/visual-index/visual_index_active_siglip2-base-patch16-384.npz"
export SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH="$MAIN/backend/data/visual-index/visual_index_active_manifest.json"

exec "$MAIN/backend/.venv/bin/python" backend/server.py --port "${1:-8788}"
