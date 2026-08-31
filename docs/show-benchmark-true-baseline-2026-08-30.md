# Show-Benchmark True Baseline: 79% Top-1 (Double-Projection Bug Found + Fixed)

Date: 2026-08-30
Status: **resolved** — no accuracy regression ever existed; eval tooling hardened

## TL;DR

- The scanner's true baseline on the 204-scan held-out show benchmark is
  **162/204 (79%) top-1 / 187 (91%) top-5 / 188 (92%) top-10** with the shipped stack
  (SigLIP2-384 fp32 ONNX, `siglip2-384-v001-candidate` adapter, 44,484-row active index).
- The "139/204 (68%)" measured on 2026-08-30 (INT8 experiment doc) — and the apparent ~11-point
  "regression" vs June's 79% — was a **measurement artifact**: the active index npz stores
  **already-adapter-projected** embeddings, and `tools/eval_show_benchmark.py` re-projected them,
  double-applying the adapter to the gallery while queries got it once.
- `tools/eval_show_benchmark.py` now auto-detects the manifest's `adapterCheckpointPath` marker and
  skips gallery projection (`--reproject-index auto|always|never`). The trap is closed.

## How it was isolated (3-arm A/B, same tool / adapter / 204 queries)

| gallery | rows | top-1 | top-5 | top-10 |
|---|---|---|---|---|
| v002 active index, re-projected (the trap) | 44,484 | 139 (68%) | 177 (86%) | 182 (89%) |
| v001 pre-rebuild index, re-projected (the trap) | 43,982 | 139 (68%) | 177 (86%) | 182 (89%) |
| June bakeoff base gallery, projected once | 43,982 | **162 (79%)** | 187 (91%) | 189 (92%) |
| **v002 active index used AS-STORED, queries projected once (= runtime semantics)** | 44,484 | **162 (79%)** | 187 (91%) | 188 (92%) |

v001 vs v002 identical ⇒ the June-14 index rebuild and its +502 new rows cost nothing.
Identity proof: `cos(adapter(bakeoff_base_row), v001_row) = 1.0000` (mean and min over 200 sampled
cards) — runtime index rows ARE the adapter-projected base embeddings.

Root cause chain: `tools/build_raw_visual_index.py --adapter-checkpoint` projects reference
embeddings before writing the npz (by design — runtime `raw_visual_index.search` uses the matrix
as-stored and only projects the query). `eval_show_benchmark.py` was written for base indexes and
re-projected whatever it was given; its docstring warned about this, but the warning was missed on
2026-08-30 (and by the first two arms above).

## Corrected records

- `docs/siglip2-int8-encoder-experiment-2026-08-30.md` — correction block added; its DON'T-SHIP
  verdict stands directionally, but all absolute numbers there are deflated.
- Any future eval must pass a projected index as-stored. The harness now handles this automatically;
  the reference invocation is unchanged except it no longer needs babysitting.

## What actually limits accuracy now (miss taxonomy, the real 42 top-1 misses)

| category | count | note |
|---|---|---|
| same name, different printing | 23 | right art recognized, wrong printing row wins (JA↔EN same art, McDonald's promos vs main-set, reprints) |
| different card entirely | 17 | true recognition failures — the retrain lever |
| cross-language different card | 2 | |

~60% of remaining misses are printing/disambiguation errors, not recognition errors. Rank-of-truth
distribution over the 42 misses: **25 at rank 2–5, 1 at 6–10, 4 at 11–30, 12 beyond rank 30**.
14 misses sit at rank 2–5 with margin ≤ 0.03 — inside the disabled collector-number tiebreak's
window (`raw_visual_matcher.py`, margin 0.03 / beta 0.04), and most of those truths' collector
numbers match the scanned footer. The 12 deep misses (>30) are true recognition failures only
in-domain retraining addresses. Per-fixture ranks/margins: session scratchpad `prod_equiv_ranks.json`.

## Rerank-policy sweep (same day, runtime-faithful replay over the 204 scans)

The user-photo rerank pool excludes holdout cards by construction, so on this benchmark rerank has
zero possible upside — the sweep measures pure harm. Shipped prod config (thr 0.30 / alpha 0.10 /
K 50): **−3 top-1** vs rerank-off (159 vs 162); alpha is the only harm lever; K irrelevant.
thr 0.50 / alpha 0.10 recovers 1 of 3 and stays inside the LOO-validated 0.0–0.7 benefit band →
both env files set to **0.50** (prod change rides the next approved prod deploy). Staging's old
0.80 was blocking nearly all covered-card benefit. Sweep artifacts: session scratchpad
`rerank_sweep/` (`capture_and_sweep.py` replays the exact runtime boost formula).

## Letterbox A/B at SigLIP2-384 (same day) — negative, keep squash

Full offline A/B on the 204 holdout (44,484-image letterbox gallery rebuilt on MPS):
letterbox both sides **163/184/188** vs squash control **162/187/188**; query-side-only letterbox
**160/186/189** (strictly worse — preprocessing-domain mismatch). Miss overlap: letterbox fixes 10
control misses but breaks 9 new ones, all rank-2–5 shuffle; 15 of 16 deep misses stay broken. The
2026-05-12 CLIP-224 "harmful" verdict softens to "no benefit" at 384; default stays OFF (comment
updated at `backend/raw_visual_model.py`). Caveat: the active adapter was trained on squash
embeddings — letterbox + a letterbox-retrained adapter is untested, but nothing here suggests it
would touch the deep misses. Harness + per-fixture results: session scratchpad `letterbox_ab/`.

## Reproduce

```bash
SPOTLIGHT_VISUAL_ENCODER_BACKEND=onnx backend/.venv/bin/python tools/eval_show_benchmark.py \
  --model-id google/siglip2-base-patch16-384 --device cpu \
  --adapter backend/data/visual-models/raw_visual_adapter_active.pt \
  --base-index-npz backend/data/visual-index/visual_index_active_siglip2-base-patch16-384.npz \
  --base-index-manifest backend/data/visual-index/visual_index_active_manifest.json
```

(now prints "index is pre-projected … gallery used as-stored" and reports 79/91/92)
