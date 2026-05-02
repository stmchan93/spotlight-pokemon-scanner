# Spotlight Scanner Backend

Shared Spotlight runtime backend for authenticated scan, inventory, portfolio, and pricing flows.

What this backend currently does:
- stores runtime card metadata in SQLite `cards`
- stores raw and future graded pricing snapshots in SQLite `card_price_snapshots`
- stores scan telemetry in SQLite `scan_events`
- stores scan artifacts, confirmations, deck entries, deal history, and portfolio import jobs in SQLite
- resolves raw cards through the new evidence -> retrieval -> rerank flow
- serves authenticated deck / buy / sell / portfolio history / ledger / scan confirmation routes
- refreshes raw pricing from Scrydex
- treats Scrydex as the active raw identity/reference/pricing lane
- preserves PriceCharting as a thin non-active shell

What is intentionally removed right now:
- old catalog sync/cache layers
- old collector-number-first raw matcher
- legacy raw importer CLI / catalog JSON / image download path

## Runtime tables

- `cards`
- `card_price_snapshots`
- `scan_events`
- `scan_artifacts`
- `scan_confirmations`
- `deck_entries`
- `deck_entry_events`
- `sale_events`
- `portfolio_import_jobs`

## Active endpoints

- `GET /api/v1/health`
- `GET /api/v1/ops/provider-status`
- `GET /api/v1/ops/scrydex-usage`
- `GET /api/v1/ops/unmatched-scans`
- `GET /api/v1/cards/search?q=charizard`
- `GET /api/v1/cards/<card_id>`
- `GET /api/v1/cards/<card_id>/ebay-comps`
- `GET /api/v1/deck/entries`
- `GET /api/v1/deck/history`
- `GET /api/v1/portfolio/history`
- `GET /api/v1/portfolio/ledger`
- `GET /api/v1/ledger`
- `GET /api/v1/deals`
- `GET /api/v1/portfolio/imports/<job_id>`
- `POST /api/v1/cards/<card_id>/refresh-pricing`
- `POST /api/v1/scan/match`
- `POST /api/v1/scan/visual-match`
- `POST /api/v1/scan/rerank`
- `POST /api/v1/scan/feedback`
- `POST /api/v1/scan-artifacts`
- `POST /api/v1/deck/entries`
- `POST /api/v1/deck/entries/condition`
- `POST /api/v1/deck/entries/purchase-price`
- `POST /api/v1/deck/entries/replace`
- `POST /api/v1/buys`
- `POST /api/v1/sales`
- `POST /api/v1/sales/batch`
- `POST /api/v1/portfolio/imports/preview`
- `POST /api/v1/portfolio/imports/resolve`
- `POST /api/v1/portfolio/imports/<job_id>/commit`

## Auth / user isolation

- Staging and production should run with `SPOTLIGHT_AUTH_REQUIRED=1`.
- The backend validates Supabase bearer tokens using `SUPABASE_URL`.
- Hosted auth may use `SUPABASE_JWT_SECRET` for symmetric bearer tokens or Supabase JWKS for asymmetric bearer tokens.
- Local dev may use `SPOTLIGHT_AUTH_FALLBACK_USER_ID` when auth is intentionally bypassed.
- `SPOTLIGHT_LEGACY_OWNER_USER_ID` is migration-only and must not be used as runtime request identity.
- Mutable scan / deck / buy / sell / portfolio import routes and their corresponding read paths are owner-scoped by `owner_user_id`.
- `backend/deploy_to_vm.sh` now refuses a hosted deploy if:
  - `SPOTLIGHT_AUTH_REQUIRED` is not enabled
  - `SUPABASE_URL` is missing
  - `SPOTLIGHT_AUTH_FALLBACK_USER_ID` is set

Run this before a staged/prod VM deploy or mobile release:

```bash
pnpm release:audit:staging
pnpm release:audit:production
```

Those audits check the hosted backend env file, the backend secrets file, and the matching mobile release env file for the selected environment.

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

Prepare one env-specific secrets file per hosted environment:

```bash
cp backend/.env.secrets.example backend/.env.staging.secrets
cp backend/.env.secrets.example backend/.env.production.secrets
```

Run this on the VM after cloning the repo:

```bash
backend/deploy.sh staging backend/.env.staging.secrets
```

Or from your local machine, use the single deploy entrypoint:

```bash
pnpm deploy:staging
pnpm deploy:production
```

Those commands run `tools/deploy_backend.sh`, which:
- runs the release-config audit locally
- syncs the backend bundle to the configured GCE VM over `gcloud`
- runs the VM-local deploy script on the remote host
- runs the VM health check after deploy

If you want the deploy plus authenticated staging smoke plus optional TestFlight step in one gate, use:

```bash
pnpm release:gate:staging
pnpm release:gate:staging:build
pnpm release:gate:staging:release
```

That wrapper lives in [tools/run_release_gate.py](/Users/stephenchan/Code/spotlight/tools/run_release_gate.py:1) and expects a dedicated staging smoke user via `SPOTLIGHT_STAGING_SMOKE_EMAIL` / `SPOTLIGHT_STAGING_SMOKE_PASSWORD`.

The normal staging shortcuts now route through the same gate:

```bash
pnpm deploy:staging
pnpm mobile:build:ios:staging
pnpm mobile:release:ios:staging
```

You can also call the script directly:

```bash
bash tools/deploy_backend.sh staging
bash tools/deploy_backend.sh production backend/.env.production.secrets
```

Remote wrapper target settings:
- staging defaults:
  - instance: `spotlight-backend-vm-small`
  - zone: `us-central1-b`
- optional overrides:
  - `SPOTLIGHT_GCLOUD_PROJECT`
  - `SPOTLIGHT_VM_STAGING_INSTANCE`
  - `SPOTLIGHT_VM_STAGING_ZONE`
  - `SPOTLIGHT_VM_PRODUCTION_INSTANCE`
  - `SPOTLIGHT_VM_PRODUCTION_ZONE`
  - `SPOTLIGHT_VM_REMOTE_DIR`

Important path split:
- `backend/deploy.sh` and `backend/deploy_to_vm.sh` are VM-local scripts and should be run on the Linux VM host
- `tools/deploy_backend.sh` is the canonical local remote-deploy wrapper for your laptop/workstation
- `tools/deploy_vm_one_shot.sh` remains as a compatibility shim only

The deploy helper uses two inputs:

- `backend/.env.staging` or `backend/.env.production` for checked-in environment defaults
- the second argument secrets file, typically `backend/.env.staging.secrets` or `backend/.env.production.secrets`, for machine-specific secrets like:
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

For the staging labeling -> retrain -> guarded publish cycle on the VM, use:

```bash
zsh tools/run_staging_labeling_cycle.sh
```

That wrapper:
- uses the same VM runtime config / env files when available
- runs `tools/run_labeling_retrain_cycle.py` against the staging SQLite DB
- only publishes a candidate when the release gate passes
- restarts `spotlight-backend.service` after a successful publish
- writes per-run summaries under `~/spotlight-datasets/raw-visual-train/ops/runs/`

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
