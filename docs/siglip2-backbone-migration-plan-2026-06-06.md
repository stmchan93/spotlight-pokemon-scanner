# SigLIP2 Backbone Migration Plan (2026-06-06)

## TL;DR

Swapping the raw-visual backbone from CLIP-B/32 to **SigLIP2-base-patch16-384** and training
the existing v011 adapter recipe is a **validated, decisive win** on the 204-card show holdout
(the gate benchmark). **SHIP TARGET = the 384 variant** (chosen after a resolution sweep — see
below):

| model | top-1 | top-5 | top-10 | dim-foil t1 |
|---|---|---|---|---|
| **SigLIP2-384 + trained adapter** ← SHIP | **79%** | **91%** | **92%** | 49/56 |
| SigLIP2-512 + trained adapter | 79% | 90% | 91% | 44/56 |
| SigLIP2-224 + trained adapter | 69% | 85% | 86% | 41/56 |
| CLIP-B/32 + trained adapter (v011, LIVE) | 48% | 69% | 73% | 27/56 |

**+31pt top-1 over live production.** Resolution sweep verdict: **384 is the sweet spot** — ties
512 on top-1 but beats it on every other axis at 1.6× less latency, so 512 does not pay off; 256
and naflex were weaker. Latency cost is server-side only (no on-device encoder). 384 ≈ 118ms on a
laptop-CPU proxy; **the real 2-4 vCPU VM number is the one gating unknown** (likely ~250-350ms) —
measure it + export ONNX before locking ship-as-is vs ONNX-first vs bigger VM.

This plan tracks productionizing it. **Gate every step on the show holdout**
(`tools/backbone_bakeoff/` harness). Nothing ships without beating the live numbers.

## Evidence / provenance

- Bake-off + trained result + harness: [[project_backbone_bakeoff_2026_06_06]] memory.
- Experiment code (experiment-only, no runtime touched): `tools/backbone_bakeoff/`
  - `bakeoff.py` — zero-shot backbone comparison.
  - `train_siglip2_adapter.py [RES ...]` — monkeypatches a SigLIP2 shim into the real
    `train_raw_visual_adapter.main()`; reuses v011 manifest/hard-negs/registry verbatim.
  - `sweep_siglip2_resolution.py` — zero-shot resolution sweep (256/384/512/naflex) + CPU latency.
  - SHIP candidate adapter (384): `backend/data/visual-models/raw_visual_adapter_siglip2-384-v001-candidate.pt` (768-dim).
    (Also have `-224-` and `-512-` candidates for comparison.)
  - Cached SigLIP2-384 gallery (43,982×768): `~/spotlight-datasets/backbone-bakeoff/gal_google_siglip2-base-patch16-384.npy`.

## Done (2026-06-06)

- [x] **Feasibility / latency gate** — server-side, ≈1.8× CLIP, acceptable. No mobile constraint (encoder is server-side in `raw_visual_matcher.py`).
- [x] **Backend encoder is SigLIP2-capable** — `backend/raw_visual_model.py`: additive
      `detect_model_family()` + SigLIP branches in `__init__`/`_init_torch_backend` +
      `_infer_embedding_dim()` probe. CLIP path byte-for-byte unchanged (dim 512, deterministic,
      71 encoder/matcher tests green). SigLIP verified cosine≈1.0 vs cached gallery, dim 768.
      ONNX backend gracefully falls back to torch when no SigLIP artifact exists.

## Remaining (each gated on the show holdout; ⚠️ = irreversible/deploy — confirm before running)

1. **Re-mine hard negatives in SigLIP2 space.** Current candidate reused CLIP-mined negs and
   still won; re-mining (`mine_raw_visual_hard_negatives.py` against a SigLIP2 base index) can
   only help. Retrain `siglip2-v002-candidate`, re-gate.
2. **Build the SigLIP2 runtime base index** (43,982 refs). The cached bake-off gallery already
   IS these embeddings — wrap into a versioned `.npz` + manifest via `build_raw_visual_index.py`
   (now needs the SigLIP2 encoder; or reuse the cached matrix directly). Then build the candidate
   runtime index by projecting the base through the trained adapter.
3. **Export SigLIP2 vision tower to ONNX** for the VM runtime (matches the CLIP ONNX path;
   without it the VM uses torch CPU — still fine at ~100ms but ONNX is the production parity).
   Validate cosine≈1.0 torch-vs-ONNX like the CLIP export did.
4. **Rebuild the user-photo rerank pool in SigLIP2 space** (`build_user_photo_rerank_pool.py`
   with the now-active SigLIP2 adapter). A pool in the wrong embedding space is harmful — this
   is the v011 cutover gotcha. Point `.env.staging` `RERANK_POOL_*_PATH` at it.
5. ⚠️ **Cutover + deploy to staging.** New active adapter+index ship OUT-OF-BAND (the deploy
   bundle excludes `data/`): stage the 4 runtime files to GCS, `gsutil cp` into the VM's
   `data/visual-{models,index}/`, back up the prior set, restart, verify
   `GET /api/v1/health?prewarm=visual`. Follow the exact runbook in [[project_visual_retrain_runbook]].
   Update the active adapter metadata `modelId` → `google/siglip2-base-patch16-384` so the
   runtime constructs the SigLIP encoder at the chosen resolution.

## Risks / watchouts

- **modelId drives the encoder family.** The runtime reads `model_id` from active adapter
  metadata; cutover must flip it to the SigLIP id or it will build a CLIP encoder against a
  768-dim index (hard failure / garbage). Covered by the metadata swap in step 5.
- **Rerank pool space mismatch** — see step 4; the deploy preflight guard should catch it.
- **ONNX parity** — until step 3, the VM runs SigLIP on torch CPU. Acceptable but verify load
  time / memory on the VM size (see [[project_backend_vm_sizing]]).
- Do not collapse `confirmed_card_id` semantics or change the show-holdout gate definition.
