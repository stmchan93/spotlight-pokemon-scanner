# Spotlight Scanner Backend

Temporary raw-only backend reset.

What this backend currently does:
- stores runtime card metadata in SQLite `cards`
- stores raw and future graded pricing snapshots in SQLite `card_price_snapshots`
- stores scan telemetry in SQLite `scan_events`
- resolves raw cards through the new evidence -> retrieval -> rerank flow
- refreshes raw pricing from Scrydex
- treats Scrydex as the active raw identity/reference/pricing lane
- preserves PriceCharting as a thin non-active shell

What is intentionally removed right now:
- slab runtime matching
- slab pricing runtime flow
- slab sync/import pipelines
- old catalog sync/cache layers
- old collector-number-first raw matcher
- legacy raw importer CLI / catalog JSON / image download path

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
  --database-path backend/data/spotlight_scanner.sqlite \
  --port 8788
```
The backend is always live-only. It does not support seeded catalog startup anymore.

## VM beta deploy

For the current beta stage, the recommended hosted path is one Linux VM with:
- one backend process
- one SQLite file
- one daily Scrydex sync at `3:00 AM America/Los_Angeles`

Run this on the VM after cloning the repo:

```bash
backend/deploy.sh vm staging backend/.env
```

What it does:
- creates `backend/.venv`
- installs CPU-only `torch` for the VM visual runtime
- installs Python runtime dependencies from `backend/requirements.vm.txt`
- writes `backend/.vm-runtime.conf`
- validates Scrydex credentials
- runs one initial full sync unless `SPOTLIGHT_SKIP_INITIAL_SYNC=1`
- installs user `crontab` entries for:
  - `@reboot` backend start
  - a minute-level scheduler wrapper that evaluates the desired local timezone and fires the Scrydex sync at `3:00 AM America/Los_Angeles`
- starts the backend immediately on `0.0.0.0:8788`

Useful follow-ups on the VM:

```bash
curl http://127.0.0.1:8788/api/v1/health
curl http://127.0.0.1:8788/api/v1/ops/provider-status
tail -f backend/logs/backend.log
tail -f backend/logs/scrydex_sync.log
```

## Environment

Active raw runtime provider:
- `SCRYDEX_API_KEY`
- `SCRYDEX_TEAM_ID`
- `SCRYDEX_BASE_URL`

Thin provider shells preserved for the later slab rebuild / future experiments:
- `PRICECHARTING_API_KEY`
- `PRICECHARTING_BASE_URL`

## Useful commands

Compile the kept backend:

```bash
python3 -m py_compile \
  backend/catalog_tools.py \
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
  backend.tests.test_pricing_utils
```

Validate thin Scrydex env wiring:

```bash
python3 backend/validate_scrydex.py
```
