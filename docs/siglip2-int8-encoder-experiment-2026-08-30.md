# SigLIP2-384 INT8 Encoder Experiment

Date: 2026-08-30
Status: **measured, DON'T SHIP** (defaults unchanged; INT8 stays a dormant env-flag experiment)

> **CORRECTION (2026-08-30, later the same day):** every absolute accuracy number in this doc is
> deflated by a measurement bug. The active index npz stores **already-adapter-projected**
> embeddings, and the harness invocation below re-projected them (double projection). The true
> fp32 baseline on this same 204-scan holdout is **162/204 (79%) top-1 / 91% top-5 / 92% top-10**,
> not 139/204 (68%). See
> [docs/show-benchmark-true-baseline-2026-08-30.md](/Users/stephenchan/Code/spotlight/docs/show-benchmark-true-baseline-2026-08-30.md).
> Both arms here shared the same double-projected gallery, so the int8-vs-fp32 *comparison* was
> internally consistent and the **DON'T SHIP verdict stands directionally** (the margin-vs-drift
> argument is geometry the bug didn't change qualitatively) — but the specific deltas and margin
> stats must be re-derived with `--reproject-index` handling (now built into
> `tools/eval_show_benchmark.py`) before this experiment is ever revisited.

## TL;DR

- **Recommendation: don't ship INT8.** On the honest 204-scan held-out show benchmark it loses **15 net top-1 (139 → 124, 68% → 60%)** and 3 net top-10 (182 → 179) against the exact deployment condition (INT8 query vs the fp32-built active index). That directly violates `top-1 > top-10 > speed`. No speed win justifies it, and on the VM-like 2-thread CPU config it wasn't even faster on this Mac.
- The repo is left **byte-for-byte default-identical**: fp32 ONNX remains the runtime artifact, `SPOTLIGHT_VISUAL_ENCODER_PRECISION` defaults to `fp32`, and the INT8 artifact just sits next to the fp32 one, unused unless the flag is set.
- This is the SigLIP2-era rerun of the 2026-05-26 CLIP INT8 experiment ([docs/clip-encoder-onnx-quantization-findings-2026-05-26.md](/Users/stephenchan/Code/spotlight/docs/clip-encoder-onnx-quantization-findings-2026-05-26.md)) — same verdict, now on a 204-scan held-out set instead of 71 fixtures, so the rejection is much firmer.

## Artifacts (nothing overwritten)

| file | size | sha256 (prefix) |
|---|---|---|
| `backend/data/visual-models/siglip2-base-patch16-384_vision_fp32.onnx` (runtime, untouched) | 373 MB | `99a4a769…` |
| `backend/data/visual-models/siglip2-base-patch16-384_vision_int8.onnx` (experiment) | 99 MB | `a882e630…` |

The INT8 artifact was produced by `tools/export_siglip_onnx.py --int8` (onnxruntime `quantize_dynamic`, QInt8 weights) from the *identical* fp32 artifact (sha verified against `siglip2-base-patch16-384_vision_fp32.metadata.json`). Op inventory: 75 of 102 MatMuls became `MatMulInteger` (all constant-weight Linear layers); the ~27 activation×activation MatMuls (Q·Kᵀ and attn·V in each of the 13 blocks, plus the attention-pooling head) and all `LayerNormalization`/`Softmax`/`Tanh` stay fp32 — expected for dynamic quantization.

## How to enable / disable (fully reversible)

- New env flag in `backend/raw_visual_model.py`: **`SPOTLIGHT_VISUAL_ENCODER_PRECISION`** — `fp32` (default) / `int8`. With `int8`, the ONNX loader swaps the resolved artifact for its `_int8.onnx` sibling **only if that file exists**; otherwise it logs and uses fp32 (encoder then reports `precision="fp32"`). Works with the default artifact path and with `SPOTLIGHT_VISUAL_ENCODER_ONNX_PATH`. Torch backend ignores it.
- The chosen values surface in the match debug payload as `encoderBackend` / `encoderPrecision` (next to `modelId` in `raw_visual_matcher.py`).
- **Rollback = unset the flag** (or set `fp32`). Default behavior with the flag unset is unchanged — the int8 sibling is never even stat'd unless the flag says `int8`.
- Unit coverage: `backend/tests/test_raw_visual_model.py` (precision resolution, sibling-path derivation, missing-artifact fallback, default-never-touches-int8). `python3 -m unittest backend.tests.test_raw_visual_model` — 15 tests green.

## Accuracy — held-out show benchmark (the gate that fails)

`tools/eval_show_benchmark.py`, 204 held-out show scans (`~/spotlight-datasets/raw-visual-expansion-holdouts/labeled-20260519-20260604`), active adapter, active 44,484-row index, run per-precision via the env flags (the harness builds `RawVisualFrozenEncoder` with `backend=None`, so `SPOTLIGHT_VISUAL_ENCODER_BACKEND=onnx` + the precision flag exercise the exact runtime encoder path):

| encoder | top-1 | top-5 | top-10 |
|---|---|---|---|
| torch (reference) | 139/204 (68%) | 177/204 (86%) | 182/204 (89%) |
| **ONNX fp32 (runtime)** | **139/204 (68%)** | 177/204 (86%) | 182/204 (89%) |
| ONNX int8 | 124/204 (60%) | 164/204 (80%) | 178/204 (87%) |

Per-fixture diff (int8 vs fp32, same adapter/index; scorer alongside the raw outputs in the scratchpad run):

- **53/204 top-1 rankings changed**; 202/204 had some top-10 membership change.
- Truth cards: **20 lost / 5 gained at top-1 (net −15)**; 6 lost / 3 gained at top-10 (net −3). (The churn scorer's own top-10 tally differs from the harness by ±1 fixture due to tie ordering; the direction is identical.)
- Structural reason, same as the CLIP finding: int8 embedding drift vs fp32 is **median 0.0497 (1−cos, min cosine 0.743)** while the fp32 top-1-vs-top-2 similarity margin is median 0.0561 with p25 **0.0231** — the quantization noise is the same size as (or bigger than) the gap between #1 and #2 for a large share of scans.
- Caveat: this is the *asymmetric* setup (int8 query vs fp32-built index) — pessimistic in principle, but it is also exactly what shipping the flag without an index rebuild would do, so it is the number that matters. A symmetric test would require re-embedding the 44k index with int8 (not done; forbidden here and unjustified given the result).

## Latency — this Mac (M4 Pro, arm64, CPUExecutionProvider) — proxy only

Warm medians over 20 runs, `modelForwardMs` only:

| config | fp32 batch 1 | int8 batch 1 | fp32 batch 9 | int8 batch 9 (per-image) |
|---|---|---|---|---|
| 2 intra-op threads (VM-pinned config) | 78.5 ms | **122.7 ms (1.56× slower)** | 754.8 ms | 1058.7 ms (117.6) |
| default threads (14 cores) | 81.3 ms | 67.5 ms (1.20× faster) | 821.2 ms | 622.6 ms (69.2) |

**Hardware caveat (flagged, not resolved):** arm64 int8 kernels ≠ x86. The VMs are x86 — staging `e2-standard-2` (Broadwell-class, likely **no** AVX-512 VNNI → int8 probably slow there too) and prod `t2d-4` (Milan, AVX2 VPDPBUSD-style int8 is decent → int8 *might* win there). So the speedup on prod is *plausible* but unproven; only an on-VM measurement would settle it, and the accuracy result makes that moot.

## Verdict

**Don't ship.** −7.4 pts top-1 on the honest show holdout is a decisive rejection (a 204-scan suite can't certify a borderline quant, but it can absolutely reject this one — and it did, by 15 net cards). The flag, tests, and artifact stay in place as cheap infrastructure if this is ever revisited; per the 2026-05-26 doc the revisit conditions still stand (symmetric index rebuild, bigger holdout, on-VM x86 timing proof), and this run adds: even then, expect the margin math to fight you — drift must get well under ~0.02 (p25 margin), which dynamic QInt8 does not deliver on this encoder.

## Reproduce

- Bench + parity + churn scripts and raw outputs: session scratchpad `…/scratchpad/int8/` (`bench_int8.py`, `churn.py`, `run_all.sh`, `run_all.log`, `bench_threads*.json`, `churn.json`).
- Harness invocation per precision: `SPOTLIGHT_VISUAL_ENCODER_BACKEND=onnx SPOTLIGHT_VISUAL_ENCODER_PRECISION=<fp32|int8> backend/.venv/bin/python tools/eval_show_benchmark.py --model-id google/siglip2-base-patch16-384 --device cpu --adapter backend/data/visual-models/raw_visual_adapter_active.pt --base-index-npz backend/data/visual-index/visual_index_active_siglip2-base-patch16-384.npz --base-index-manifest backend/data/visual-index/visual_index_active_manifest.json`
