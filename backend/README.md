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
- `GET /api/v1/ops/scrydex-usage`
- `GET /api/v1/ops/unmatched-scans`
- `GET /api/v1/cards/search?q=charizard`
- `GET /api/v1/cards/<card_id>`
- `GET /api/v1/cards/<card_id>/ebay-comps`
- `POST /api/v1/cards/<card_id>/refresh-pricing`
- `POST /api/v1/scan/match`
- `POST /api/v1/scan/feedback`

## Run

```bash
backend/.venv/bin/python -m pip install -r backend/requirements.vm.txt
backend/.venv/bin/python backend/server.py \
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
cp backend/.env.secrets.example backend/.env
backend/deploy.sh staging backend/.env
```

Or from the repo root, use the one-shot wrapper:

```bash
pnpm deploy:staging:vm
```

That wrapper runs the deploy and then immediately runs the VM health check.

The deploy helper uses two inputs:

- `backend/.env.staging` or `backend/.env.production` for checked-in environment defaults
- the second argument secrets file, typically `backend/.env`, for machine-specific secrets like:
  - `SCRYDEX_API_KEY`
  - `SCRYDEX_TEAM_ID`
  - optional eBay credentials

What it does:
- creates `backend/.venv`
- installs CPU-only `torch` for the VM visual runtime
- installs Python runtime dependencies from `backend/requirements.vm.txt`
- writes `backend/.vm-runtime.conf`
- validates Scrydex credentials
- skips the initial full sync by default
- only runs an initial full sync when `SPOTLIGHT_RUN_INITIAL_SYNC=1`
- installs user `crontab` entries for:
  - `@reboot` backend start
  - a minute-level scheduler wrapper that evaluates the desired local timezone and fires the Scrydex sync at `3:00 AM America/Los_Angeles`
- starts the backend immediately on `0.0.0.0:8788`
- validates `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` before restart when `SPOTLIGHT_EBAY_BROWSE_ENABLED=1`

Useful follow-ups on the VM:

```bash
curl http://127.0.0.1:8788/api/v1/health
curl http://127.0.0.1:8788/api/v1/ops/provider-status
curl http://127.0.0.1:8788/api/v1/ops/scrydex-usage | python3 -m json.tool
tail -f backend/logs/backend.log
tail -f backend/logs/scrydex_sync.log
```

Persistent Scrydex request audit:

- default audit DB: `backend/data/scrydex_request_audit.sqlite`
- override path with `SPOTLIGHT_SCRYDEX_AUDIT_DB_PATH`
- runtime source labels come from `SPOTLIGHT_RUNTIME_LABEL`
- raw per-request audit rows are retained for `30` days
- rows older than `30` days are automatically rolled into daily usage rollups and pruned from the raw audit table
- VM wrappers now default to:
  - `vm-backend:<hostname>`
  - `vm-sync:<hostname>`

Useful local audit summary command:

```bash
python3 backend/summarize_scrydex_usage.py --hours 24 --limit 50
```

## Environment

Active raw runtime provider:
- `SCRYDEX_API_KEY`
- `SCRYDEX_TEAM_ID`
- `SCRYDEX_BASE_URL`

Thin provider shells preserved for the later slab rebuild / future experiments:
- `PRICECHARTING_API_KEY`
- `PRICECHARTING_BASE_URL`

Optional eBay Browse live-listings integration:
- `SPOTLIGHT_EBAY_BROWSE_ENABLED=1`
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_MARKETPLACE_ID=EBAY_US`

For VM deploys, it is safest to keep `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` in the deploy secrets file you pass to `backend/deploy.sh` or `backend/deploy_to_vm.sh`.

Current eBay listings endpoint notes:
- `GET /api/v1/cards/<card_id>/ebay-comps` returns active listings only, not sold comps
- raw card requests work without `grader` or `grade`
- graded/slab requests still accept `grader` and `grade`
- responses are normalized to return at most `5` listings, or fewer when `limit` asks for a smaller number
- active listing results are sorted lowest-first by eBay price ordering

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
