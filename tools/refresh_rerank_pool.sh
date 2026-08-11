#!/usr/bin/env bash
# Automation flywheel: refresh the user-photo rerank pool from newly confirmed
# card-show scans, behind a two-sided safety gate so it can never silently
# degrade accuracy.
#
# Pipeline:
#   a. read the watermark (last successfully-promoted window end)
#   b. export confirmed scans since the watermark -> review CSV
#   c. import + tier-route + Tier-1 firewall, hand to process_raw_visual_batch
#   d. build a curated, date-versioned rerank pool
#   e. eval leave_one_out (covered-card lift) + holdout (regression check)
#   f. PROMOTE-OR-ROLLBACK:
#        promote -> swap the _active alias, advance known-good marker + watermark
#        rollback -> leave _active untouched, ALERT, exit non-zero, do NOT advance
#
# NOTE ON DEPLOY: backend/.env.staging's
#   SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_POOL_NPZ_PATH
#   SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_POOL_MANIFEST_PATH
# should point at the _active alias files written here so a promote/rollback
# takes effect via a file swap. This script does NOT edit .env.staging.
#
# Usage:
#   tools/refresh_rerank_pool.sh [--since ISO] [--until ISO] [--db PATH] [--dry-run]
# Defaults: --since from the watermark file; --until "now"; db = backend/data/spotlight_scanner.local.sqlite
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${REPO_ROOT}/backend/.venv/bin/python"
TOOLS="${REPO_ROOT}/tools"
STATE_DIR="${TOOLS}/state"
VISUAL_INDEX_DIR="${REPO_ROOT}/backend/data/visual-index"
PROMOTE="${TOOLS}/rerank_pool_promote.py"

# Backbone. The SigLIP2 migration (2026-06-08) rebuilt the pool on a new encoder
# and wired the backend straight at the dated artifact, which left this script
# building CLIP pools nothing consumed. Slug, model id, and adapter must move
# together — a pool built in a different space than the query encoder is worse
# than no pool at all.
MODEL_SLUG="siglip2-base-patch16-384"
MODEL_ID="google/siglip2-base-patch16-384"
ADAPTER_CHECKPOINT="${REPO_ROOT}/backend/data/visual-models/raw_visual_adapter_siglip2-384-v001-candidate.pt"
ALPHA="0.1"
THRESHOLD="0.80"

ACTIVE_NPZ="${VISUAL_INDEX_DIR}/visual_index_user_photos_rerank_pool_active_${MODEL_SLUG}.npz"
ACTIVE_MANIFEST="${VISUAL_INDEX_DIR}/visual_index_user_photos_rerank_pool_active_manifest.json"

# The eval tool still defaults its base index to the CLIP artifact, so the
# backbone has to be passed explicitly here too.
BASE_NPZ="${VISUAL_INDEX_DIR}/visual_index_active_${MODEL_SLUG}.npz"
BASE_MANIFEST="${VISUAL_INDEX_DIR}/visual_index_active_manifest.json"

# --- args -------------------------------------------------------------------
SINCE=""
UNTIL=""
DB="${REPO_ROOT}/backend/data/spotlight_scanner.local.sqlite"
STORAGE="${SPOTLIGHT_SCAN_ARTIFACTS_STORAGE:-gcs}"
GCS_BUCKET="${SPOTLIGHT_SCAN_ARTIFACTS_GCS_BUCKET:-looty-staging}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --until) UNTIL="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --gcs-bucket) GCS_BUCKET="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "${STATE_DIR}"

log() { echo "[refresh_rerank_pool] $*"; }

# --- a. watermark -----------------------------------------------------------
if [[ -z "${SINCE}" ]]; then
  if SINCE="$("${PYTHON}" "${PROMOTE}" read-watermark 2>/dev/null)"; then
    log "watermark found: since=${SINCE}"
  else
    echo "ERROR: no watermark file and no --since provided. Pass --since ISO to bootstrap." >&2
    exit 2
  fi
else
  log "since (override): ${SINCE}"
fi

if [[ -z "${UNTIL}" ]]; then
  # 'now' window end, also used to advance the watermark on promote.
  UNTIL="$("${PYTHON}" -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00","Z"))')"
fi
log "window: ${SINCE} -> ${UNTIL}"

TODAY="$(date -u +%Y%m%d)"
log "artifact version (today): ${TODAY}"

# --- b. export confirmed scans ----------------------------------------------
EXPORT_BATCH="refresh-rerank-${TODAY}-$(date -u +%H%M%S)"
EXPORT_ROOT="${HOME}/spotlight-datasets/raw-visual-train/scan-review-exports/${EXPORT_BATCH}"
log "exporting confirmed scans -> ${EXPORT_ROOT}"
"${PYTHON}" "${TOOLS}/export_scan_training_rows.py" \
  --db "${DB}" \
  --storage "${STORAGE}" --gcs-bucket "${GCS_BUCKET}" \
  --confirmed-only \
  --since "${SINCE}" --until "${UNTIL}" \
  --batch-id "${EXPORT_BATCH}" \
  --output-root "${EXPORT_ROOT}"
CSV_PATH="${EXPORT_ROOT}/scan_review.csv"
log "review CSV: ${CSV_PATH}"

# --- c. import + tier-route + firewall + run batch --------------------------
log "importing confirmed scans (tier route + Tier-1 firewall + run batch)"
"${PYTHON}" "${TOOLS}/import_confirmed_scans_to_training.py" \
  --csv "${CSV_PATH}" \
  --db "${DB}" \
  --run-batch

# --- d. build curated dated pool --------------------------------------------
log "building curated rerank pool (version ${TODAY})"
"${PYTHON}" "${TOOLS}/build_user_photo_rerank_pool.py" \
  --artifact-version "${TODAY}" \
  --model-id "${MODEL_ID}" \
  --adapter-checkpoint "${ADAPTER_CHECKPOINT}" \
  --review-queue

NEW_NPZ="${VISUAL_INDEX_DIR}/visual_index_user_photos_rerank_pool_${TODAY}_${MODEL_SLUG}.npz"
NEW_MANIFEST="${VISUAL_INDEX_DIR}/visual_index_user_photos_rerank_pool_${TODAY}_manifest.json"
if [[ ! -f "${NEW_NPZ}" || ! -f "${NEW_MANIFEST}" ]]; then
  echo "ERROR: expected pool artifacts not found: ${NEW_NPZ}" >&2
  exit 1
fi

# --- e. eval (leave_one_out lift + holdout regression) ----------------------
LOO_LOG="${EXPORT_ROOT}/eval_leave_one_out.log"
HOLDOUT_LOG="${EXPORT_ROOT}/eval_holdout.log"

log "eval leave_one_out (alpha=${ALPHA}, threshold=${THRESHOLD})"
"${PYTHON}" "${TOOLS}/eval_rerank_with_user_photos.py" \
  --mode leave_one_out --curate \
  --base-manifest "${BASE_MANIFEST}" --base-npz "${BASE_NPZ}" --model-id "${MODEL_ID}" \
  --alphas "${ALPHA}" --thresholds "${THRESHOLD}" | tee "${LOO_LOG}"

log "eval holdout (alpha=${ALPHA}, threshold=${THRESHOLD})"
"${PYTHON}" "${TOOLS}/eval_rerank_with_user_photos.py" \
  --mode holdout --curate \
  --base-manifest "${BASE_MANIFEST}" --base-npz "${BASE_NPZ}" --model-id "${MODEL_ID}" \
  --alphas "${ALPHA}" --thresholds "${THRESHOLD}" | tee "${HOLDOUT_LOG}"

NEW_LOO_TOP1="$("${PYTHON}" "${PROMOTE}" parse-top1 --alpha "${ALPHA}" --threshold "${THRESHOLD}" --file "${LOO_LOG}")"
NEW_HOLDOUT_TOP1="$("${PYTHON}" "${PROMOTE}" parse-top1 --alpha "${ALPHA}" --threshold "${THRESHOLD}" --file "${HOLDOUT_LOG}")"
log "new metrics: leave_one_out top-1=${NEW_LOO_TOP1}, holdout top-1=${NEW_HOLDOUT_TOP1}"

# --- known-good baseline ----------------------------------------------------
if KG_JSON="$("${PYTHON}" "${PROMOTE}" read-known-good 2>/dev/null)"; then
  KG_LOO_TOP1="$(echo "${KG_JSON}" | "${PYTHON}" -c 'import json,sys; print(json.load(sys.stdin)["leaveOneOutTop1"])')"
  KG_HOLDOUT_TOP1="$(echo "${KG_JSON}" | "${PYTHON}" -c 'import json,sys; print(json.load(sys.stdin)["holdoutTop1"])')"
else
  echo "ERROR: no known-good marker; cannot gate. Seed tools/state/rerank_pool_known_good.json first." >&2
  exit 1
fi
log "known-good baseline: leave_one_out top-1=${KG_LOO_TOP1}, holdout top-1=${KG_HOLDOUT_TOP1}"

# --- f. PROMOTE-OR-ROLLBACK -------------------------------------------------
DECISION_JSON="$("${PYTHON}" "${PROMOTE}" decide \
  --new-loo-top1 "${NEW_LOO_TOP1}" --new-holdout-top1 "${NEW_HOLDOUT_TOP1}" \
  --known-good-loo-top1 "${KG_LOO_TOP1}" --known-good-holdout-top1 "${KG_HOLDOUT_TOP1}")" && PROMOTE_OK=1 || PROMOTE_OK=0
log "decision: ${DECISION_JSON}"

if [[ "${PROMOTE_OK}" -eq 1 ]]; then
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    log "DRY RUN: would PROMOTE version ${TODAY} (active alias + known-good + watermark not changed)."
    exit 0
  fi
  log "PROMOTE: swapping active alias to version ${TODAY}"
  cp "${NEW_NPZ}" "${ACTIVE_NPZ}"
  cp "${NEW_MANIFEST}" "${ACTIVE_MANIFEST}"
  "${PYTHON}" "${PROMOTE}" write-known-good \
    --version "${TODAY}" --loo-top1 "${NEW_LOO_TOP1}" --holdout-top1 "${NEW_HOLDOUT_TOP1}"
  "${PYTHON}" "${PROMOTE}" write-watermark "${UNTIL}"
  log "PROMOTED ${TODAY}. Active alias updated, known-good + watermark advanced to ${UNTIL}."
  log "Deploy: ensure .env.staging rerank-pool paths point at the _active alias, then push."
  exit 0
else
  echo "" >&2
  echo "ALERT: pool NOT promoted (accuracy regressed)." >&2
  echo "  new      leave_one_out top-1=${NEW_LOO_TOP1}  holdout top-1=${NEW_HOLDOUT_TOP1}" >&2
  echo "  known-good leave_one_out top-1=${KG_LOO_TOP1}  holdout top-1=${KG_HOLDOUT_TOP1}" >&2
  echo "  decision: ${DECISION_JSON}" >&2
  echo "  Active alias LEFT UNTOUCHED. Watermark NOT advanced; this window will retry." >&2
  echo "  Dated artifacts kept for inspection: ${NEW_NPZ}" >&2
  exit 1
fi
