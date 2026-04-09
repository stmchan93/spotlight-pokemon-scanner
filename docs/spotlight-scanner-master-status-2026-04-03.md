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

## Current Product State

- scanner UI remains intact
- raw scan UX remains active
- backend now always returns a best raw candidate for valid raw scans
- low-confidence raw scans still return a best guess plus review state
- slab matching, slab pricing, and slab backend logic are deferred until the slab rebuild

## Current Scope Order

1. raw backend reset: done
2. slab backend/pricing redesign: next
3. OCR redesign/refinement: later

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
  backend/import_pokemontcg_catalog.py \
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
  backend.tests.test_import_pokemontcg_catalog \
  backend.tests.test_pricing_utils
```

## Next Work

1. rebuild slab/backend identity flow cleanly
2. rebuild slab pricing on the simplified backend
3. revisit OCR after slab/backend design is settled
