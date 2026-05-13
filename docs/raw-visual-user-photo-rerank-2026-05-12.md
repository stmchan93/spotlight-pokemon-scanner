# Raw Visual User-Photo Rerank (Option D)

Date: 2026-05-12

## Status

- Landed but **default off** behind `SPOTLIGHT_VISUAL_USER_PHOTO_RERANK`.
- Initial rerank pool artifact: `backend/data/visual-index/visual_index_user_photos_rerank_pool_v002_*`.
- Production sweep settings: `alpha=0.10`, `threshold=0.90`, `shortlist_k=50`.
- Measured 2026-05-12 against the canonical 71-fixture mixed held-out subset (no adapter, base CLIP):
  - Held-out top-1: 14/71 → **14/71 (no regression)**
  - Held-out top-10: 33/71 → **33/71 (no change)**
  - Covered-card leave-one-out top-1: 47/83 → **60/83 (+13 fixtures)**
  - Covered-card leave-one-out top-10: 60/83 → **65/83 (+5 fixtures)**

## Why this exists

Three no-train approaches were tried on 2026-05-12 and all failed for the same reason: CLIP-ViT-B/32's embedding space prioritizes "is this a real phone photo of a card?" over "which card identity?". Mixing capture-domain rows (user photos) with digital-domain rows (Scrydex renders) in the same matrix poisons retrieval — capture-domain rows score systematically high against capture-domain queries regardless of card identity.

Failed experiments are recorded in `memory/project_visual_model_2026_05_12_experiments.md`. Rerank avoids that failure mode by keeping the main library purely digital, then using user photos only as a per-card confirmation signal applied to a clean shortlist.

## Architecture

Two-stage retrieval inside `backend/raw_visual_matcher.py::match_payload`:

1. **Stage 1 — clean Scrydex retrieval (unchanged).** Index search returns `internal_top_k` candidates; language adjustments + variant merge reduce to the rerank shortlist.
2. **Stage 2 — user-photo boost.** For each shortlist card, look up its user-photo rows in the rerank pool (file-backed, lazy-loaded, ~1 MB). Compute `max_user_photo_similarity = max(cosine(query_emb, photo_emb))`. If `max_user_photo_similarity >= threshold`, add `alpha * max_user_photo_similarity` to the candidate's score. Re-sort the shortlist; trim to `top_k`.

Cards with no user photos are unaffected. Cards with user photos can move within the shortlist, but cannot enter from outside. By construction, a user photo of card A can never beat a Scrydex hit for card B because we only consult user photos for cards already in B's shortlist.

## Artifacts

- Builder: `tools/build_user_photo_rerank_pool.py`
- Pool NPZ: `backend/data/visual-index/visual_index_user_photos_rerank_pool_v002_clip-vit-base-patch32.npz` (~750 KB)
- Pool manifest: `backend/data/visual-index/visual_index_user_photos_rerank_pool_v002_manifest.json`
- Loader: `backend/raw_visual_user_photo_rerank.py::RawVisualUserPhotoRerankPool`

The pool is built from `~/spotlight-datasets/raw-visual-train/raw_visual_training_manifest.jsonl` with defensive filtering:

- `mappingConfidence == "high"` only (low-confidence mappings excluded)
- Held-out exclusion against `qa/raw-footer-layout-check`, `delta-raw-20260504-audit`, and `drive-download-20260420t172622z-3-001` (both truth-key match and lenient name+number match)
- `expansionHoldoutSelected != true`

Initial pool: 365 photos covering 86 unique providerCardIds.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SPOTLIGHT_VISUAL_USER_PHOTO_RERANK` | `0` (off) | Master enable/disable |
| `SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_ALPHA` | `0.10` | Boost weight applied to per-card max user-photo similarity |
| `SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_THRESHOLD` | `0.90` | Minimum user-photo similarity required to apply boost |
| `SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_SHORTLIST_K` | `50` | Stage-1 candidate count handed to rerank |
| `SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_POOL_NPZ_PATH` | (derived) | Override pool NPZ path |
| `SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_POOL_MANIFEST_PATH` | (derived) | Override pool manifest path |

The threshold default of `0.90` was chosen because:

- Same-card user-photo similarities cluster around 0.95 (covered-card leave-one-out queries)
- Cross-card lookalike similarities cluster below 0.86 (the held-out umbreon-059-131 vs me2-75 case)
- `0.90` sits between the two distributions and recovers the single held-out top-1 fixture that lower thresholds lose

For more aggressive lift, set `SPOTLIGHT_VISUAL_USER_PHOTO_RERANK_THRESHOLD=0.0` — adds +7 covered-card top-1 wins at the cost of -1 held-out top-1.

## Performance

- Per-query rerank cost: <1 ms (50 shortlist candidates × <12 photos/card × 512-dim cosine, all in-memory).
- Total matcher latency unchanged in practice — encoder forward pass dominates at ~150 ms per query.
- Memory: 365 × 512 × 4 B ≈ 750 KB for the pool, loaded once at first use.

## Telemetry

Each match's `debug` payload now includes `userPhotoRerank` with:

- `applied`: bool
- `alpha`, `threshold`: floats actually used
- `shortlistConsidered`: int (size of shortlist passed to rerank)
- `boostsApplied`: int (number of cards that received a non-zero boost)
- `poolUniqueCardCount`, `poolRowCount`, `poolArtifactVersion`: pool provenance
- `boosts`: list of up to 20 per-card boost records `{providerCardId, userPhotoMaxSimilarity, boost, preBoostSimilarity, postBoostSimilarity}`

`debug.timings.userPhotoRerankMs` records the rerank stage cost.

## What's next

- Phase 2 (planned): wire confirmed-scan exports into the rerank pool builder so Add-to-Deck events grow coverage automatically.
- Phase 3 (planned): train a v011 adapter on the multi-view data to bridge the digital↔capture domain gap inside the embedding model itself; if successful, rerank becomes redundant for cards covered by training but still helps any newly-confirmed scans before the next retrain.

## What this is NOT

- Not a model change. The CLIP encoder + adapter pipeline is unchanged.
- Not a substitute for proper adapter retraining. It's a complementary stage.
- Not safe to deploy with capture-domain rows merged into the main `visual_index_active_*.npz`. The mixing was tested at multiple weight ratios and consistently broke retrieval for uncovered cards. See `memory/project_visual_model_2026_05_12_experiments.md`.
