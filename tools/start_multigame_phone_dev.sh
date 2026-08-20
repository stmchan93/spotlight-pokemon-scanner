#!/usr/bin/env bash
# Phone testing for the multi-TCG spike: backend on the LAN + Expo pointed at it.
#
# Delegates to the repo's existing tools/start_mobile_phone_dev.sh rather than
# reinventing LAN-IP detection and the Expo wiring; this only supplies the three
# things the spike needs on top:
#
#   1. the MERGED catalog — the per-game POC databases can't be served together,
#      and the backend serves exactly one file
#   2. the Pokémon visual index, which lives in the MAIN tree; only the four new
#      per-game indexes were built in this worktree, so without these the Pokémon
#      lane reports itself unavailable
#   3. the main tree's venv — this worktree has no backend/.venv of its own
#
# The backend binds 0.0.0.0 (the delegate's default) so the phone can reach it.
# 127.0.0.1 is loopback and a phone cannot.
#
#   bash tools/start_multigame_phone_dev.sh                # backend + Expo Go
#   bash tools/start_multigame_phone_dev.sh --backend-only
#   bash tools/start_multigame_phone_dev.sh --dev-client
#
# If LAN IP detection fails (VPN, multiple interfaces), pass it explicitly:
#   SPOTLIGHT_PHONE_IP=192.168.1.23 bash tools/start_multigame_phone_dev.sh
set -euo pipefail

MAIN=/Users/stephenchan/Code/spotlight
WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
DB="$WORKTREE/backend/data/spotlight_multigame_test.sqlite"

if [ ! -f "$DB" ]; then
  echo "Missing $DB" >&2
  echo "Build it first:  python tools/build_multigame_test_db.py --rebuild" >&2
  exit 1
fi

# A backend already listening on this port wins — the delegate reuses a healthy
# one. Loudly rejecting that is better than silently testing the wrong catalog.
# Skipped for --frontend-only, where reusing the running backend is the point
# (restarting Metro to pick up .env changes must not require killing it).
PORT="${SPOTLIGHT_PORT:-8788}"
frontend_only=0
for arg in "$@"; do
  [ "$arg" = "--frontend-only" ] && frontend_only=1
done
if [ "$frontend_only" -eq 0 ] && curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
  echo "Something is already serving port ${PORT}." >&2
  echo "If it is an older backend it will be REUSED and you will test the wrong" >&2
  echo "database. Stop it first:  lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs kill" >&2
  exit 1
fi

export SPOTLIGHT_DATABASE_PATH="$DB"
export SPOTLIGHT_PYTHON_BIN="$MAIN/backend/.venv/bin/python"
export SPOTLIGHT_VISUAL_INDEX_NPZ_PATH="$MAIN/backend/data/visual-index/visual_index_active_siglip2-base-patch16-384.npz"
export SPOTLIGHT_VISUAL_INDEX_MANIFEST_PATH="$MAIN/backend/data/visual-index/visual_index_active_manifest.json"

# The encoder MUST match the one the indexes were built with. The code default
# is still CLIP ViT-B/32, and staging only gets SigLIP2 from .env.staging — so
# omitting this loads the wrong encoder against a SigLIP2 index and every scan
# fails with "visual-only resolver could not run". The adapter lives in the main
# tree (this worktree has no visual-models of its own; there is a symlink, and
# these paths make it explicit rather than incidental).
export SPOTLIGHT_VISUAL_MODEL_ID="google/siglip2-base-patch16-384"
export SPOTLIGHT_VISUAL_ADAPTER_CHECKPOINT_PATH="$MAIN/backend/data/visual-models/raw_visual_adapter_active.pt"
export SPOTLIGHT_VISUAL_ADAPTER_METADATA_PATH="$MAIN/backend/data/visual-models/raw_visual_adapter_active_metadata.json"

exec zsh "$WORKTREE/tools/start_mobile_phone_dev.sh" "$@"
