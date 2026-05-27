# CLIP Encoder ONNX / Quantization Findings

Date: 2026-05-26

## TL;DR

- **FP32 ONNX export of the CLIP image encoder is a no-regression, ship-ready win.** Embeddings are numerically identical to the torch path (parity cosine **1.000000**; max elementwise diff 7.9e-7), so the prebuilt 44k visual index stays valid with **no rebuild**. On the real staging VM (`e2-medium`, 2 vCPU) it cuts the forward pass from **~215 ms → ~140 ms (≈1.5×)** and tightens the latency distribution (p90 148 ms hugs the 140 ms median).
- **INT8 dynamic quantization is NOT ready and is deferred.** On the held-out suite it churned **23 of 71** top-1 rankings and lost **5 top-1 / 7 top-10** truth cards, and it was **not even faster** on arm64 (11.8 ms vs FP32's 7.9 ms — dynamic int8 needs VNNI/AVX-512 to win, which `e2-medium` may not have). It fights the `top-1 > top-10 > speed` priority for an uncertain payoff.
- **Can our tests promise "no regression"? Split answer:** Yes for FP32 (drift is ~0, so the operation is provably an identity — fixture count is irrelevant). **No for INT8** — 71 in-repo (≈143 with the external holdout) fixtures over a 44k-card index can *reject* a bad quant but cannot *certify* the absence of small production regressions on the ~43,900 cards not in the fixture set.

## Why this exists

Goal was the "highest durable win" on raw visual-match latency: optimize the CLIP encoder itself (export to ONNX Runtime and/or quantize) to cut CPU cost. The forward pass (`get_image_features`) is the single biggest fixed cost in `RawVisualMatcher.match_payload` (~150–215 ms of the ~305–349 ms p50 on the VM; see [visual-match-tail-latency-investigation-plan-2026-05-18.md](/Users/stephenchan/Code/spotlight/docs/visual-match-tail-latency-investigation-plan-2026-05-18.md), where this is "Hypothesis 1 / Fix #4").

The hard constraint: **no accuracy regression** (`top-1 > top-10 > speed`). So before committing, we asked whether the eval harness is even strong enough to make that promise.

## Method

- **Encoder under test:** `openai/clip-vit-base-patch32`, vision tower `pooler_output` → `visual_projection` (the canonical 512-d path that `RawVisualFrozenEncoder._coerce_image_features` resolves to for ViT-B/32). Exported via `torch.onnx.export(..., dynamo=False, opset=17)`; INT8 via `onnxruntime.quantization.quantize_dynamic` (QInt8 weights).
- **Eval harness:** the existing per-fixture retrieval eval (shape of `tools/eval_raw_visual_model.py`) — embed each query image through encoder + adapter, search the **real active index** (`visual_index_active_*.npz`, 43,982 rows), score visual top-1/5/10 and hybrid top-1/5 against provider-mapped ground truth. Crucially it supports a **deterministic per-fixture ranking diff**, not just an aggregate rate.
- **Fixtures:** 71 self-contained in-repo (`qa/raw-footer-layout-check/`); ~143 when combined with the external holdout (`~/spotlight-datasets/raw-visual-expansion-holdouts/delta-raw-20260504-audit`, 72 fixtures).
- **Active adapter:** `raw_visual_adapter_active.pt` (v010, dated 2026-05-05).

## Results

### Per-fixture eval (71 in-repo fixtures, searched against the real 44k index)

| backend | top-1 | top-10 | embedding drift vs torch |
|---|---|---|---|
| torch (baseline) | 0.4366 | 0.7606 | — |
| **FP32 ONNX** | **0.4366** | **0.7606** | cosine = 1.000000 |
| INT8 ONNX | 0.4085 | 0.6761 | cosine = 0.954 (median) |

**Per-fixture ranking diff vs torch:**
- **FP32 ONNX: 0 rankings changed** (0 top-1 flips, 0 top-10 membership changes). Numerically an identity.
- **INT8: 23 of 71 top-1 rankings changed** — 5 truth cards lost from top-1, 7 lost from top-10 (e.g. all the Bellibolt-ex capture variants dropped systematically).

**Why INT8 churns (the structural reason):** torch top-1-vs-top-2 similarity margin is **median 0.0196**, but INT8's embedding drift is **median 0.046 (1−cos)** — the quantization noise is *larger than the gap between the #1 and #2 card* for most fixtures. Even a symmetric index rebuild (which would partly cancel correlated quantization noise) is unlikely to get drift safely under that margin.

> Caveat on the INT8 number: this test is **asymmetric** (INT8 query vs the FP32-built index), which is pessimistic. A faithful INT8 deployment would re-embed the index with the quantized encoder (symmetric). That would reduce — but per the margin math, not eliminate — the churn. We did not run the symmetric rebuild because INT8 was also not faster (below), so the payoff didn't justify the 44k-image rebuild.

### Forward-pass timing

| | torch | FP32 ONNX | INT8 ONNX |
|---|---|---|---|
| **VM `e2-medium` (2 vCPU, x86)** | ~215 ms (steady) | **140.5 ms** (p90 148.3, min 137.6) | not measured |
| arm64 Mac (2-thread, proxy) | 22.0 ms | 7.9 ms | 11.8 ms |

- **VM speedup: ~1.5×** on the forward pass (~75 ms/scan saved), confirmed on the live staging hardware. Warm-up note: the first inference after restart was ~642 ms before settling to ~215 ms — the ONNX path's tight p90 should reduce that variance.
- The arm64 ratio (2.8×) is larger because eager torch is unusually slow there; x86 with optimized torch is closer. **INT8 was slower than FP32 on arm64** — dynamic int8 kernels need VNNI/AVX-512 int8 acceleration to win.
- VM memory during the onnx-only benchmark stayed safe (available ~1.16 GB throughout; onnxruntime mmaps the model so RSS impact is small). The live service (RSS ~2.43 GB on a 3.9 GB box) was not disturbed.

## Are the tests good enough to promise "no regression"?

This was the gating question and the answer is **split by how lossy the change is**:

- **Numerically-identical change (FP32 ONNX): yes, provably.** Drift is ~1e-7, so the operation is a mathematical identity for ranking purposes. When drift is that small, fixture *count* is irrelevant — there is nothing to miss. The harness confirmed 0 changes.
- **Lossy change (INT8): no.** The harness is the right *shape* (deterministic, real index, per-fixture diff — it caught the 23 changed rankings even though net top-1 only moved by 2) but the wrong *size* for a certification. 71–143 fixtures sample a tiny slice of a 44k-card index and the long tail of real captures. The binomial CI on a ~44% rate at n=71 is ≈ ±12 points, so a genuine 1–2 card production regression sits *inside the aggregate noise* — you must use the per-fixture diff, and even then it only covers the cards that happen to be in the fixture set. The harness can **reject** a bad quant (it did) but cannot **bless** a borderline one.

**Practical rule for future model swaps:** trust the eval to *catch gross/moderate* regression; do not trust 100–150 fixtures to *certify* a drifty change. Certification needs a held-out set that is large and representative relative to the change's drift magnitude.

## What shipped in this change

- `tools/export_clip_onnx.py` — exports the CLIP image encoder to FP32 ONNX (default), with `--int8` for the experimental quantized artifact. Verifies FP32 parity (fails if cosine < 0.9999) and writes a `.metadata.json` sidecar (sha256, dim, parity).
- `backend/raw_visual_model.py` — env-flagged ONNX encoder backend. `SPOTLIGHT_VISUAL_ENCODER_BACKEND=onnx|torch` (**default `torch`** — fully reversible, nothing changes until flipped). The ONNX path does **not** load torch CLIP weights (memory win); only the lightweight processor + config. Thread pinning via `SPOTLIGHT_VISUAL_ONNX_INTRA_OP_THREADS` / `..._INTER_OP_THREADS`. Artifact path via `SPOTLIGHT_VISUAL_ENCODER_ONNX_PATH` (defaults to `backend/data/visual-models/<slug>_vision_fp32.onnx`).
- `backend/requirements.vm.txt` — added `onnxruntime==1.26.0` (`onnx`/`onnxscript` are export-time only and stay out of the VM image).
- `backend/tests/test_raw_visual_model.py` — backend resolution, default path, and ONNX embed normalize/shape-validation tests.
- The `.onnx` artifact itself is **not** committed (`backend/data/visual-models/` is gitignored, like the index `.npz` and adapter `.pt`).

## Enablement status — DONE on staging 2026-05-26 (now the default 2026-05-27)

ONNX FP32 is **live on staging** as of 2026-05-26 (commits `41428f7` code, `6a2ee4f` staging flag). Verified on the VM: prewarm succeeded at startup, `encoderForwardMs ~60-69ms`, `matchPayloadMs ~105ms`, local + public health 200.

**Update 2026-05-27 (`1bf25ea`): ONNX is now the runtime default — no env flag needed.** `RawVisualMatcher._ensure_runtime` constructs the encoder with `backend="onnx"` by default; the encoder falls back to torch automatically if the artifact or onnxruntime is missing. `SPOTLIGHT_VISUAL_ENCODER_BACKEND=torch` forces torch (rollback). Offline tools keep the torch default (ONNX is CPU-only and would lose MPS on Mac index builds). The `SPOTLIGHT_VISUAL_ENCODER_BACKEND=onnx` line was removed from `backend/.env.staging`.

Note: the staging VM was migrated off the throttled `e2-medium` to `t2d-standard-2` (8 GB) during this work, so the live `~65ms` forward is faster than the `e2-medium` `140ms` benchmark — different hardware, but the apples-to-apples `215ms→140ms` (1.5x) e2-medium comparison still stands as the validated ONNX-vs-torch delta. No torch baseline was captured on `t2d-standard-2`.

### Enablement runbook (for production or re-enablement)

The backend deploy (`tools/deploy_backend.sh`) **excludes `./data`** from its bundle, so the artifact must be placed on the VM out-of-band, exactly like the index/adapter already are:

1. Generate locally: `backend/.venv/bin/python tools/export_clip_onnx.py`
2. Copy to the VM data dir (instance `spotlight-backend-vm-small`, zone `us-central1-b`, remote dir `~/spotlight`):
   `gcloud compute scp backend/data/visual-models/clip-vit-base-patch32_vision_fp32.onnx spotlight-backend-vm-small:~/spotlight/data/visual-models/clip-vit-base-patch32_vision_fp32.onnx --zone us-central1-b --tunnel-through-iap`
3. In the staging env, set: `SPOTLIGHT_VISUAL_ENCODER_BACKEND=onnx`, `SPOTLIGHT_VISUAL_ENCODER_ONNX_PATH=<remote_dir>/data/visual-models/clip-vit-base-patch32_vision_fp32.onnx`, `SPOTLIGHT_VISUAL_ONNX_INTRA_OP_THREADS=2`, `SPOTLIGHT_VISUAL_ONNX_INTER_OP_THREADS=1`.
4. Deploy via the gate (`pnpm backend:deploy:staging`) — `requirements.vm.txt` now installs onnxruntime — then confirm via `/api/v1/health?prewarm=visual` that `encoderForwardMs` dropped (~215 → ~140 ms).
5. Rollback is a one-line flip back to `SPOTLIGHT_VISUAL_ENCODER_BACKEND=torch` + restart.

`onnxruntime==1.26.0` is already pip-installed in the staging service venv (`~/spotlight/.venv`) from the VM benchmark on 2026-05-26.

## Revisit INT8 later — explicit conditions

INT8 is parked until the planned data/retrain cycle (operator intends to capture **~500–1000 more card photos**, then retrain the adapter and rebuild). Revisit **only when all of these hold**:

1. **Bigger held-out set.** A held-out eval substantially larger and more representative than today's 71–143 fixtures — enough that a per-fixture diff plus aggregate CI can actually certify a drifty change. (This is the real blocker per the "are the tests good enough" finding above.)
2. **Retrained adapter + rebuilt index** on the expanded corpus (the data/retrain cycle the operator is planning).
3. **Symmetric quantization.** Rebuild the index with the *same* quantized encoder used at query time (re-embed all rows; source images are cached at `backend/data/visual-index/.cache/reference_images`, ~36 GB). Never run INT8 query against an FP32-built index.
4. **Per-fixture eval gate.** Gate on zero net top-1 loss on the expanded held-out set, measured by the deterministic per-fixture diff — not just an unchanged aggregate rate.
5. **Confirm the speedup is real on `e2-medium`.** Dynamic INT8 was *slower* than FP32 on arm64; verify x86 `e2-medium` actually has the int8 acceleration (VNNI) to make it worth it before investing in the rebuild. If not, consider static (calibrated) quantization or skip INT8 entirely.

Until then: **FP32 ONNX is the recommended encoder optimization.**

## Cross-references

- Tail-latency investigation (frames this as Hypothesis 1 / Fix #4): [visual-match-tail-latency-investigation-plan-2026-05-18.md](/Users/stephenchan/Code/spotlight/docs/visual-match-tail-latency-investigation-plan-2026-05-18.md)
- Raw visual model improvement spec (adapter training, dataset workflow): [raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md)
- User-photo rerank (source of the "~150 ms encoder forward" figure): [raw-visual-user-photo-rerank-2026-05-12.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-user-photo-rerank-2026-05-12.md)
- Code: `backend/raw_visual_model.py` (encoder backend), `tools/export_clip_onnx.py` (exporter)
