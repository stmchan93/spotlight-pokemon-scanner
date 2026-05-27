# User-photo rerank pool automation flywheel

Keeps the stage-2 user-photo rerank pool fresh as more confirmed card-show scans
accrue, behind a two-sided safety gate so it can never silently degrade accuracy.

## Pieces

- `tools/rerank_pool_promote.py` — pure, unit-tested decision/state logic:
  - `decide_promotion(...)` promotes only if BOTH new leave-one-out top-1 and new
    holdout top-1 are >= the last known-good values; otherwise rolls back.
  - known-good marker (`tools/state/rerank_pool_known_good.json`) and watermark
    (`tools/state/rerank_pool_watermark.txt`) read/write helpers.
  - `parse_eval_top1(...)` extracts the top-1 hit count from
    `eval_rerank_with_user_photos.py` stdout at a given alpha/threshold row.
  - Also a small CLI: `decide`, `parse-top1`, `read|write-known-good`,
    `read|write-watermark`.
- `tools/refresh_rerank_pool.sh` — the orchestrator: export confirmed scans since
  the watermark, import (tier-route + Tier-1 firewall + run batch), build a curated
  dated pool, eval leave_one_out + holdout (alpha 0.1, threshold 0.80), then
  PROMOTE-OR-ROLLBACK. On promote it swaps the `_active` alias, advances the
  known-good marker and the watermark. On rollback it leaves the alias untouched,
  prints `ALERT: pool NOT promoted (accuracy regressed)`, and exits non-zero
  WITHOUT advancing the watermark (so the window retries).
- `tools/restore_rerank_pool.sh <version>` — manual rollback: repoint the
  `_active` alias to a prior dated version, or to the known-good version if no arg.

## Active alias / deploy

The live artifacts are the `_active` alias files:

    backend/data/visual-index/visual_index_user_photos_rerank_pool_active_clip-vit-base-patch32.npz
    backend/data/visual-index/visual_index_user_photos_rerank_pool_active_manifest.json

`backend/.env.staging` should point its rerank-pool paths at these `_active` files
so a promote/rollback takes effect via a file swap (do NOT point them at a dated
version):

    SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_POOL_NPZ_PATH=backend/data/visual-index/visual_index_user_photos_rerank_pool_active_clip-vit-base-patch32.npz
    SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_POOL_MANIFEST_PATH=backend/data/visual-index/visual_index_user_photos_rerank_pool_active_manifest.json

(This README does not edit `.env.staging`.)

## Ingest trust filter

`tools/build_user_photo_rerank_pool.py --review-queue` routes the per-card
far-from-centroid exemplars that curation ALREADY drops to a review queue CSV
(`tools/state/rerank_review_queue.csv`) instead of silently dropping them, and
records the rejected count + queue path under `curation.reviewQueue` in the pool
manifest. The outlier math is not duplicated — the builder consumes
`CardCurationStats.droppedOutlierIndices` from `curate_card_embeddings`.

## Tests

    backend/.venv/bin/python -m unittest -v backend.tests.test_rerank_pool_automation
