#!/usr/bin/env bash
# Manual rollback: repoint the _active rerank-pool alias to a prior dated
# version (or to the known-good marker's version if no arg is given). Verifies
# the target files exist before copying, and echoes exactly what it did.
#
# Usage:
#   tools/restore_rerank_pool.sh [<version>]
# Examples:
#   tools/restore_rerank_pool.sh 20260520   # repoint active alias to that dated pool
#   tools/restore_rerank_pool.sh            # repoint active alias to known-good version
#
# NOTE: This only swaps the local _active alias files. For the change to take
# effect on staging, .env.staging's rerank-pool paths must point at the _active
# alias and the artifacts must be (re)deployed. This script does NOT touch
# .env.staging and does NOT advance the watermark or known-good marker.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${REPO_ROOT}/backend/.venv/bin/python"
PROMOTE="${REPO_ROOT}/tools/rerank_pool_promote.py"
VISUAL_INDEX_DIR="${REPO_ROOT}/backend/data/visual-index"
MODEL_SLUG="clip-vit-base-patch32"

ACTIVE_NPZ="${VISUAL_INDEX_DIR}/visual_index_user_photos_rerank_pool_active_${MODEL_SLUG}.npz"
ACTIVE_MANIFEST="${VISUAL_INDEX_DIR}/visual_index_user_photos_rerank_pool_active_manifest.json"

VERSION="${1:-}"
if [[ -z "${VERSION}" ]]; then
  echo "[restore_rerank_pool] no version arg; reading known-good marker"
  KG_JSON="$("${PYTHON}" "${PROMOTE}" read-known-good)" || {
    echo "ERROR: no version arg and no known-good marker to fall back to." >&2
    exit 1
  }
  VERSION="$(echo "${KG_JSON}" | "${PYTHON}" -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
  echo "[restore_rerank_pool] known-good version: ${VERSION}"
fi

TARGET_NPZ="${VISUAL_INDEX_DIR}/visual_index_user_photos_rerank_pool_${VERSION}_${MODEL_SLUG}.npz"
TARGET_MANIFEST="${VISUAL_INDEX_DIR}/visual_index_user_photos_rerank_pool_${VERSION}_manifest.json"

if [[ ! -f "${TARGET_NPZ}" ]]; then
  echo "ERROR: target NPZ not found: ${TARGET_NPZ}" >&2
  exit 1
fi
if [[ ! -f "${TARGET_MANIFEST}" ]]; then
  echo "ERROR: target manifest not found: ${TARGET_MANIFEST}" >&2
  exit 1
fi

cp "${TARGET_NPZ}" "${ACTIVE_NPZ}"
cp "${TARGET_MANIFEST}" "${ACTIVE_MANIFEST}"

echo "[restore_rerank_pool] repointed active alias to version ${VERSION}:"
echo "  ${TARGET_NPZ}"
echo "    -> ${ACTIVE_NPZ}"
echo "  ${TARGET_MANIFEST}"
echo "    -> ${ACTIVE_MANIFEST}"
echo "[restore_rerank_pool] done. Redeploy artifacts for the change to take effect on staging."
