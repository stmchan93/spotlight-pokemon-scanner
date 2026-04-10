# Spotlight Scanner Master Status

Date: 2026-04-09

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

Use this backend spec first:

- [raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md)

Use this OCR planning spec next:

- [ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md)

## Current Product State

- scanner UI remains intact
- raw scan UX remains active
- backend now always returns a best raw candidate for valid raw scans
- low-confidence raw scans still return a best guess plus review state
- current OCR implementation remains the legacy path while a full shared-front-half OCR rewrite is planned
- the shared front half has now been extracted into dedicated OCR modules:
  - frame source selection
  - target selection
  - perspective normalization
- the simulator-backed OCR fixture runner is landed and now writes legacy reference outputs under:
  - [qa/ocr-golden/simulator-legacy-v1](/Users/stephenchan/Code/spotlight/qa/ocr-golden/simulator-legacy-v1)
- the rewrite raw branch is now landed behind the feature-flagged coordinator
- the simulator-backed OCR fixture runner now also writes rewrite raw stage-2 outputs under:
  - [qa/ocr-golden/simulator-rewrite-v1-raw-stage2](/Users/stephenchan/Code/spotlight/qa/ocr-golden/simulator-rewrite-v1-raw-stage2)
- the legacy OCR path now emits a transitional `ocrAnalysis` envelope with:
  - normalized target metadata
  - mode sanity scores/warnings
  - legacy raw/slab evidence fields
- the rewrite raw stage-2 path now emits:
  - rewrite pipeline version metadata
  - broad raw evidence plus selective escalation from:
    - `headerWide`
    - `footerBandWide`
    - `nameplateTight`
    - `footerLeft`
    - `footerRight`
  - centralized OCR field-confidence outputs and still-photo retry decisions
  - per-fixture simulator outputs for review
- the app now routes scanner OCR through a feature-flagged OCR coordinator, while still keeping legacy OCR as the active runtime path
- slab matching, slab pricing, and slab backend logic are deferred until the slab rebuild

## Current Scope Order

1. raw backend reset: done
2. OCR rewrite contracts + fixture baseline: active
3. simulator-backed OCR fixture execution: done
4. mode sanity signals + feature-flagged rewrite entrypoint: done
5. raw branch stage 1: done
6. raw escalation and confidence: done
7. slab branch stage 1: next
8. slab/backend rebuild after OCR contracts settle

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

1. build the slab OCR branch behind the same rollout model
2. run side-by-side old-vs-new OCR comparisons before deleting the legacy path
3. start the slab/backend rebuild only after the new OCR payloads settle
