# Spotlight Scanner Master Status

Date: 2026-04-11

This is the current product/source-of-truth status doc.

## Current Backend State

- backend runtime is intentionally **raw-only**
- raw backend reset is landed and active
- old slab/sync/cache backend modules were deleted
- runtime SQLite is now exactly:
  - `cards`
  - `card_price_snapshots`
  - `scan_events`
- active raw pricing provider:
  - Pokemon TCG API
- preserved thin provider shells:
  - Scrydex
  - PriceCharting
- slab rebuild target:
  - OCR cert-first slab identification
  - Scrydex graded pricing
  - no PSA API dependency

Use this raw backend migration spec first:

- [raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md)

Use this next-step visual retrieval improvement spec after that:

- [raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md)

Use this earlier landed backend reset spec next for the currently shipped OCR-primary resolver baseline:

- [raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md)

Use this OCR planning spec next:

- [ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md)

Use this slab rebuild implementation spec when slab work resumes:

- [slab-cert-first-rebuild-implementation-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md)

## Current Product State

- scanner UI remains intact
- raw scan UX remains active
- backend now always returns a best raw candidate for valid raw scans
- low-confidence raw scans still return a best guess plus review state
- raw OCR runtime now uses the rewrite path while slab OCR still uses the legacy slab path
- the next raw-identification direction is now:
  - visual matching as the primary raw identity signal
  - OCR as confirmation and reranking evidence
- the shared front half has now been extracted into dedicated OCR modules:
  - frame source selection
  - target selection
  - perspective normalization
- the user-provided raw photo corpus under:
  - [qa/raw-footer-layout-check](/Users/stephenchan/Code/spotlight/qa/raw-footer-layout-check)
  is now the canonical seed raw regression suite
- current seed raw regression baseline:
  - exact collector: `31/67`
  - set hint: `11/67`
  - backend recoverable heuristic: `21/67`
- current raw visual proof-of-concept baseline on the provider-supported subset:
  - provider-supported fixtures: `47`
  - provider-unsupported fixtures: `20`
  - visual top-1: `39/47`
  - visual top-5 contains-truth: `41/47`
- current full-index visual-only baseline on the same provider-supported subset:
  - retained catalog cards: `20,237`
  - embedded entries: `20,182`
  - skipped entries: `55`
  - visual top-1: `22/47`
  - visual top-5 contains-truth: `28/47`
- current visual top-10 ceiling on the same provider-supported subset:
  - visual top-10 contains-truth: `32/47`
- current larger-K ceiling sweep on the same provider-supported subset:
  - visual top-20 contains-truth: `35/47`
  - visual top-30 contains-truth: `35/47`
  - visual top-50 contains-truth: `35/47`
  - runtime decision: keep visual retrieval at `top-K = 10`
- current fixed artwork-only crop result:
  - top-1: `15/47`
  - top-5 contains-truth: `26/47`
- current first hybrid visual + OCR result on the same provider-supported subset:
  - honest post-harness-fix hybrid baseline: `28/47`
  - current hybrid top-1 after leader protection + fuzzy-set dampening: `30/47`
  - current hybrid top-5 contains-truth: `31/47`
- current local commands for the raw visual migration:
  - `zsh tools/run_raw_visual_poc.sh`
  - `zsh tools/run_build_raw_visual_index.sh`
  - `python tools/run_raw_visual_hybrid_regression.py`
- first landed command for the next visual-model-improvement phase:
  - `python3 tools/build_raw_visual_training_manifest.py ...`
- the simulator-backed OCR fixture runner is landed and now writes legacy slab reference outputs under:
  - [qa/ocr-golden/simulator-legacy-v1](/Users/stephenchan/Code/spotlight/qa/ocr-golden/simulator-legacy-v1)
- the rewrite raw branch is now the live raw runtime path
- the simulator-backed OCR fixture runner now also writes rewrite raw stage-2 outputs under:
  - [qa/ocr-golden/simulator-rewrite-v1-raw-stage2](/Users/stephenchan/Code/spotlight/qa/ocr-golden/simulator-rewrite-v1-raw-stage2)
- the remaining legacy slab OCR path now emits a transitional `ocrAnalysis` envelope with:
  - normalized target metadata
  - mode sanity scores/warnings
  - legacy slab evidence fields
- the rewrite raw stage-2 path now emits:
  - rewrite pipeline version metadata
  - broad raw evidence plus selective escalation from:
    - `headerWide`
    - `footerBandWide`
    - `footerLeft`
    - `footerRight`
  - centralized OCR field-confidence outputs and still-photo retry decisions
  - per-fixture simulator outputs for review
- the app now routes raw scanner OCR through the rewrite coordinator path directly
- the shipped app path still keeps slab matching feature-flagged off by default
- slab rebuild groundwork is now landed:
  - experimental resolver paths:
    - `psa_cert_barcode`
    - `psa_cert_ocr`
  - repeat-scan slab cert cache resolution in `scan_events`
  - slab identity can succeed without exact graded pricing
  - slab detail refresh preserves `certNumber`
  - first experimental label-only slab OCR fallback path
  - `qa/slab-regression/` scaffold and `zsh tools/run_slab_regression.sh`
  - current slab fixture scaffold status:
    - tuning fixtures: `28`
    - full slab fixtures: `14`
    - label-only fixtures: `14` derived crops
    - held-out fixtures: `0`
    - current OCR-only tuning score on `qa/slab-regression/simulator-vision-v1/scorecard.json`:
      - grader exact: `28/28`
      - grade exact: `28/28`
      - cert exact: `28/28`
      - card number exact: `28/28`
      - treat this as tuning-only because the `label_only` fixtures are derived crops, not independent captures
    - current tuning import source:
      - `~/Downloads/drive-download-20260412T181003Z-3-001`
    - excluded from phase 1:
      - `IMG_0162.JPG` because it is `CGC`
- the slab rebuild implementation contract is now documented as:
  - cert-first
  - PSA-only for phase 1
  - label-only scan support as a first-class path
  - identity decoupled from graded pricing
  - Scrydex-backed identification/pricing, not PSA verification

## Current Scope Order

1. raw backend reset: done
2. raw visual-match hybrid migration: active
3. OCR rewrite contracts + fixture baseline: active
4. simulator-backed OCR fixture execution: done
5. mode sanity signals + rewrite entrypoint: done
6. raw branch stage 1: done
7. raw escalation and confidence: done
8. slab branch stage 1: active groundwork
9. slab/backend rebuild after raw hybrid direction settles using the cert-first slab rebuild spec and Scrydex pricing lane

## What To Treat As Deleted Legacy

- old slab backend modules
- old slab pricing/sync docs
- old provider-abstraction rollout docs
- old sync/checklist/todo docs
- bundled backend catalog artifacts

Do not use those older documents as implementation guidance.

## Validation Baseline

Current kept backend validation:

```bash
python3 -m py_compile \
  backend/catalog_tools.py \
  backend/pokemontcg_api_client.py \
  backend/pokemontcg_pricing_adapter.py \
  backend/pricecharting_adapter.py \
  backend/pricing_provider.py \
  backend/pricing_utils.py \
  backend/scrydex_adapter.py \
  backend/validate_scrydex.py \
  backend/server.py

python3 -m unittest -v \
  backend.tests.test_backend_reset_phase1 \
  backend.tests.test_raw_evidence_phase3 \
  backend.tests.test_raw_retrieval_phase4 \
  backend.tests.test_raw_decision_phase5 \
  backend.tests.test_pricing_phase6 \
  backend.tests.test_scan_logging_phase7 \
  backend.tests.test_pokemontcg_api_client \
  backend.tests.test_pricing_utils
```

## Next Work

1. keep the current hybrid baseline frozen at `30/47` top-1
2. build the separate visual training corpus and manifest tooling
3. train and evaluate a lightweight visual adapter on top of frozen CLIP
4. rebuild the full visual index only if the held-out suite improves
5. only then resume app/backend raw-contract work and legacy raw-path cleanup
6. in parallel with slab planning, keep the next slab execution slice focused on:
   - `qa/slab-regression/`
   - collecting at least `10` real PSA label-only held-out photos
   - label-only slab OCR hardening on real photos
   - cert-first slab routing into Scrydex-backed identity/pricing
