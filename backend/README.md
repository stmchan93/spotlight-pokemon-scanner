# Spotlight Scanner Backend

Temporary raw-only backend reset.

What this backend currently does:
- stores runtime card metadata in SQLite `cards`
- stores raw and future graded pricing snapshots in SQLite `card_price_snapshots`
- stores scan telemetry in SQLite `scan_events`
- resolves raw cards through the new evidence -> retrieval -> rerank flow
- refreshes raw pricing from Pokemon TCG API
- preserves thin Scrydex and PriceCharting adapters only for env/config structure

What is intentionally removed right now:
- slab runtime matching
- slab pricing runtime flow
- slab sync/import pipelines
- old catalog sync/cache layers
- old collector-number-first raw matcher

## Runtime tables

- `cards`
- `card_price_snapshots`
- `scan_events`

## Active endpoints

- `GET /api/v1/health`
- `GET /api/v1/ops/provider-status`
- `GET /api/v1/ops/unmatched-scans`
- `GET /api/v1/cards/search?q=charizard`
- `GET /api/v1/cards/<card_id>`
- `POST /api/v1/cards/<card_id>/refresh-pricing`
- `POST /api/v1/catalog/import-card`
- `POST /api/v1/scan/match`
- `POST /api/v1/scan/feedback`

## Run

```bash
python3 backend/server.py \
  --skip-seed \
  --database-path backend/data/spotlight_scanner.sqlite \
  --port 8788
```

Optional explicit seed flow:

```bash
python3 backend/server.py \
  --cards-file /absolute/path/to/cards.json \
  --database-path /absolute/path/to/dev_seed.sqlite \
  --port 8787
```

If you do not pass `--cards-file`, the backend runs live-only and does not depend on any bundled catalog directory.

## Environment

Raw runtime provider:
- `POKEMONTCG_API_KEY`

Thin provider shells preserved for the later slab rebuild:
- `SCRYDEX_API_KEY`
- `SCRYDEX_TEAM_ID`
- `SCRYDEX_BASE_URL`
- `PRICECHARTING_API_KEY`
- `PRICECHARTING_BASE_URL`

## Useful commands

Compile the kept backend:

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
```

Run the kept raw/backend tests:

```bash
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

Validate thin Scrydex env wiring:

```bash
python3 backend/validate_scrydex.py
```
