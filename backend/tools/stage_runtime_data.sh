#!/usr/bin/env bash
# Stage ONLY the ~1.7 GB runtime data slice (not the 54 GB dev tree) into a target
# dir you can rsync/scp to the new box's ./data. The file list is the active
# SigLIP2 index/adapter/onnx referenced by .env.production, plus the small runtime
# aux files. Run from anywhere:
#
#   backend/tools/stage_runtime_data.sh /tmp/spotlight-data
#   rsync -avP /tmp/spotlight-data/ user@box:/opt/spotlight/backend/data/
#
# DB CONSISTENCY: copy a quiesced DB. Either stop the running backend first, or
# checkpoint the WAL before copying:
#   sqlite3 backend/data/spotlight_scanner.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
# (Or skip this script for the DB and use `litestream restore` on the new box.)
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/data"
DEST="${1:?usage: stage_runtime_data.sh <dest-data-dir>}"
mkdir -p "$DEST/visual-index" "$DEST/visual-models"

FILES=(
  # --- SQLite runtime DB (WAL/SHM copied if present) ---
  spotlight_scanner.sqlite
  spotlight_scanner.sqlite-wal
  spotlight_scanner.sqlite-shm
  # --- Active SigLIP2 visual index + manifest ---
  visual-index/visual_index_active_siglip2-base-patch16-384.npz
  visual-index/visual_index_active_manifest.json
  # --- User-photo rerank pool (SigLIP2 space, 2026-06-08) ---
  visual-index/visual_index_user_photos_rerank_pool_20260608-siglip2_siglip2-base-patch16-384.npz
  visual-index/visual_index_user_photos_rerank_pool_20260608-siglip2_manifest.json
  # --- Small runtime aux (card-back denylist, basic-energy mini index) ---
  visual-index/placeholder_card_ids.json
  visual-index/basic_energy_mini_index.npz
  # --- Encoder ONNX (auto-resolved by model_id) + adapter + language probe ---
  visual-models/siglip2-base-patch16-384_vision_fp32.onnx
  visual-models/siglip2-base-patch16-384_vision_fp32.metadata.json
  visual-models/raw_visual_adapter_active.pt
  visual-models/raw_visual_adapter_active_metadata.json
  visual-models/raw_visual_runtime_active.json
  visual-models/language_probe_v1.npz
)

missing=0
for f in "${FILES[@]}"; do
  if [ -f "$SRC/$f" ]; then
    cp -v "$SRC/$f" "$DEST/$f"
  else
    echo "WARN missing (skipped): $SRC/$f" >&2
    missing=$((missing + 1))
  fi
done

echo
echo "Staged runtime slice -> $DEST"
du -sh "$DEST"
[ "$missing" -eq 0 ] || echo "($missing file(s) were missing — check names above)"
