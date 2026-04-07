# Spotlight Scanner Backend

Local scaffold for the scanner-first MVP.

What it does:
- initializes a SQLite catalog and telemetry schema
- seeds a small Pokémon sample catalog
- generates Apple Vision feature-print embeddings for any catalog cards with local reference images when those artifacts exist
- keeps a metadata-hash fallback embedding for cards that do not have a local reference image
- exposes local JSON endpoints for scan matching, search, and feedback
- can import a larger Pokémon catalog from Pokémon TCG API, with optional legacy reference-image download
- normalizes imported `tcgplayer` / `cardmarket` payloads into a single candidate `pricing` summary
- now supports grade-aware PSA slab pricing snapshots when slab comp data exists locally
- now uses a multi-provider pricing architecture with specialized providers:
  - **Pokemon TCG API** for raw/singles pricing (free, official) when `POKEMONTCG_API_KEY` is configured
  - **Scrydex** for PSA slab pricing (primary) when `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` are configured
  - **PriceCharting** as an auxiliary/manual PSA provider when `PRICECHARTING_API_KEY` is configured
  - imported snapshot pricing as final fallback
- provider prices are **never** blended together; one active provider is used per refresh

Important limitation:
- this is a `hybrid local matcher`, not a production vector database service yet
- visual retrieval is real and image-derived, and candidate retrieval now uses a deterministic in-memory LSH index before OCR / metadata reranking
- once the real catalog grows further, the next backend step is swapping this in-memory ANN layer for a dedicated vector index

## Endpoints

- `GET /api/v1/health`
- `GET /api/v1/ops/provider-status`
- `GET /api/v1/ops/catalog-sync-status`
- `GET /api/v1/ops/pricing-refresh-failures`
- `GET /api/v1/ops/unmatched-scans`
- `GET /api/v1/cards/search?q=charizard`
- `GET /api/v1/cards/<card_id>`
- `POST /api/v1/cards/<card_id>/refresh-pricing`
- `POST /api/v1/catalog/import-card`
- `POST /api/v1/catalog/resolve-miss`
- `POST /api/v1/scan/match`
- `POST /api/v1/scan/feedback`
- `GET /api/v1/slab-sync/status`
- `POST /api/v1/slab-sync/run-once`

Grade-aware detail and refresh:

- `GET /api/v1/cards/<card_id>?grader=PSA&grade=10`
- `POST /api/v1/cards/<card_id>/refresh-pricing?grader=PSA&grade=10`

If a slab snapshot exists for that card + grade, the backend returns slab pricing.
If not, the scanner runtime returns slab unsupported / no price rather than silently substituting a raw-card price.

The scanner runtime routes requests by mode:

**Raw card pricing**
1. Read the latest persisted raw snapshot from SQLite.
2. If it is fresh within the default `24 hour` window, return it immediately.
3. If it is stale, refresh live through `Pokemon TCG API`.
4. Persist the refreshed snapshot and return it.

**PSA slab pricing**
1. Read the latest persisted slab snapshot from SQLite.
2. If it is fresh within the default `24 hour` window, return it immediately.
3. If it is stale, refresh live through `Scrydex`.
4. If live refresh fails, keep the slab lane strict and return the existing slab snapshot or no price; do not degrade into raw proxy pricing.

Manual refresh can bypass the freshness window:

- `POST /api/v1/cards/<card_id>/refresh-pricing?forceRefresh=1`
- `POST /api/v1/cards/<card_id>/refresh-pricing?grader=PSA&grade=<grade>&forceRefresh=1`

Slab comp source sync:

- `POST /api/v1/slab-sales/import`
- `GET /api/v1/cards/<card_id>/slab-sales?grader=PSA&grade=10`
- `GET /api/v1/cards/<card_id>/slab-price-snapshot?grader=PSA&grade=10`

## Run

```bash
python3 backend/server.py --cards-file backend/catalog/cards.sample.json --database-path backend/data/sample_scanner.sqlite --port 8787
```

The iOS app should target a local backend for development.

App environment routing is now driven by Xcode config files:

- `Debug` => local backend
- `Staging` => TestFlight / internal backend
- `Release` => production backend

The machine-local override file is:

- `Spotlight/Config/LocalOverrides.xcconfig`

Current defaults:

- `Debug` simulator => `http://127.0.0.1:8788/`
- `Staging` => `https://spotlight-backend-grhsfspaia-uc.a.run.app/`
- `Release` => `https://spotlight-backend-grhsfspaia-uc.a.run.app/`

On a physical device, `127.0.0.1` points to the phone itself, so set `SPOTLIGHT_LOCAL_DEVICE_API_BASE_URL` in `LocalOverrides.xcconfig` to your Mac's LAN URL instead.

`SPOTLIGHT_API_BASE_URL` is still supported as a runtime override, but it is intended for one-off debugging, not as the primary environment switch.

Catalog-storage rule:

- keep bundled/offline identifier assets minimal
- use runtime metadata/provider APIs for rich metadata and pricing
- treat `backend/catalog/pokemontcg/all_cards_cache.json` as the acceptable lightweight local cache artifact
- do not re-introduce `cards.json.backup` or a large checked-in image corpus as required product assets

Example `LocalOverrides.xcconfig`:

```bash
SPOTLIGHT_LOCAL_DEVICE_API_BASE_URL=http://192.168.0.225:8788/
SPOTLIGHT_STAGING_API_BASE_URL=https://spotlight-backend-grhsfspaia-uc.a.run.app/
SPOTLIGHT_PRODUCTION_API_BASE_URL=https://spotlight-backend-grhsfspaia-uc.a.run.app/
```

## Cloud Run Deploy

Cloud Run deployment is now split cleanly into:

- tracked non-secret runtime env files:
  - `backend/.env.staging`
  - `backend/.env.production`
- one local backend secrets file:
  - `backend/.env`

Recommended flow:

```bash
backend/deploy.sh staging backend/.env
```

Production uses the same pattern:

```bash
backend/deploy.sh production backend/.env
```

Notes:

- `backend/.env` is the single local secrets file for backend development and Cloud Run secret sync.
- `deploy.sh` is the main entrypoint. It merges the tracked runtime env file (`backend/.env.staging` or `backend/.env.production`) with secret values from `backend/.env`, then deploys Cloud Run with that combined env payload.
- `deploy_to_cloud_run.sh` remains the lower-level helper if you need to call it directly.
- `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_REGION` can be exported to override the active `gcloud` config.
- `CLOUD_RUN_SERVICE_NAME` can be exported if you want a different service name than the default `spotlight-backend`.
- This is intentionally optimized for simple local-to-Cloud-Run deployment flow, not Secret Manager indirection.

## Seed Only

```bash
python3 backend/server.py --seed-only --cards-file backend/catalog/cards.sample.json --database-path backend/data/sample_scanner.sqlite
```

## Import A Larger Pokémon Catalog

The importer targets the official Pokémon TCG API and writes a local catalog JSON. Downloading local reference images is optional and is considered a legacy path.

```bash
python3 backend/import_pokemontcg_catalog.py \
  --api-key "$POKEMONTCG_API_KEY" \
  --query 'set.series:"Scarlet & Violet"' \
  --max-cards 1000 \
  --replace-output
```

This writes:

- `backend/catalog/pokemontcg/cards.json`

Optional legacy image download:

```bash
python3 backend/import_pokemontcg_catalog.py \
  --api-key "$POKEMONTCG_API_KEY" \
  --query 'set.series:"Scarlet & Violet"' \
  --max-cards 1000 \
  --replace-output \
  --download-images
```

That additionally writes:

- `backend/catalog/pokemontcg/images/*`

After that, reseed the backend:

```bash
python3 backend/build_catalog.py \
  --cards-file backend/catalog/pokemontcg/cards.json \
  --database-path backend/data/imported_scanner.sqlite
```

Then run the imported catalog backend on a separate port:

```bash
python3 backend/server.py \
  --cards-file backend/catalog/pokemontcg/cards.json \
  --database-path backend/data/imported_scanner.sqlite \
  --port 8788
```

Notes:

- the importer is resumable by default if `cards.json` already exists; use `--replace-output` to rebuild from scratch
- local reference-image download is now opt-in; do not treat checked-in images as required runtime assets for OCR-first scanner work
- some card image `*_hires` URLs can 404; the importer falls back to the small image and skips broken assets instead of aborting the run
- imported search and match payloads now include an optional `pricing` object when normalized price data is available
- imported card detail payloads include richer metadata plus normalized pricing via `GET /api/v1/cards/<card_id>`
- `POST /api/v1/cards/<card_id>/refresh-pricing` now uses persisted snapshot freshness as the source of truth:
  - if the stored snapshot is still fresh, it returns the stored snapshot
  - if it is stale, it refreshes the live provider for the active lane and updates SQLite
  - `forceRefresh=1` bypasses the normal freshness gate
- the current imported local catalog has been expanded to `2004` cards across `Scarlet & Violet` and `Sword & Shield` slices, plus targeted adds like `Umbreon VMAX`
- if you omit `--cards-file`, the backend prefers `backend/catalog/pokemontcg/cards.json` when present and otherwise falls back to `backend/catalog/cards.sample.json`

## Sync Pokémon Catalog

Sample manifest:

- `backend/catalog/catalog_sync.sample.json`

Plan the next sync run:

```bash
python3 backend/sync_catalog.py \
  --manifest backend/catalog/catalog_sync.sample.json \
  --database-path backend/data/imported_scanner.sqlite \
  --cards-file backend/catalog/pokemontcg/cards.json \
  --state-path backend/data/catalog_sync_state.json \
  --plan-only
```

Run once:

```bash
python3 backend/sync_catalog.py \
  --manifest backend/catalog/catalog_sync.sample.json \
  --database-path backend/data/imported_scanner.sqlite \
  --cards-file backend/catalog/pokemontcg/cards.json \
  --state-path backend/data/catalog_sync_state.json
```

Watch mode:

```bash
python3 backend/sync_catalog.py \
  --manifest backend/catalog/catalog_sync.sample.json \
  --database-path backend/data/imported_scanner.sqlite \
  --cards-file backend/catalog/pokemontcg/cards.json \
  --state-path backend/data/catalog_sync_state.json \
  --watch \
  --interval-seconds 3600
```

Live catalog miss recovery:

- `POST /api/v1/catalog/import-card` imports one exact Pokémon TCG API card ID into SQLite and the local `cards.json` snapshot.
- `POST /api/v1/catalog/resolve-miss` tries to resolve a structured raw scan miss from OCR hints and caches the result immediately when it finds a match.

## Sync PSA Slab Sales Sources

The first real slab-sales adapter in the repo is `psa_apr_html`, which ingests PSA Auction Prices HTML pages or local HTML exports through a manifest.

Run once:

```bash
python3 backend/sync_slab_sources.py \
  --manifest backend/catalog/slab_sources.sample.json \
  --database-path backend/data/imported_scanner.sqlite
```

Watch mode:

```bash
python3 backend/sync_slab_sources.py \
  --manifest backend/catalog/slab_sources.sample.json \
  --database-path backend/data/imported_scanner.sqlite \
  --watch \
  --interval-seconds 900
```

Optional env vars:

- `SPOTLIGHT_SLAB_SOURCE_MANIFEST`
- `SPOTLIGHT_SLAB_SYNC_STATE_PATH`
- `SPOTLIGHT_SLAB_SYNC_INTERVAL_SECONDS`
- `PSA_APR_COOKIE`
- `SCRYDEX_API_KEY`
- `SCRYDEX_TEAM_ID`
- `SCRYDEX_BASE_URL`

The backend can also expose sync status and trigger a run on demand if `SPOTLIGHT_SLAB_SOURCE_MANIFEST` is configured before starting `server.py`.

Production-ready sample manifest:

- `backend/catalog/slab_sources.production.sample.json`

Validate manifest/auth readiness without running sync:

```bash
python3 backend/sync_slab_sources.py \
  --manifest backend/catalog/slab_sources.production.sample.json \
  --validate
```

Operational visibility:

- `GET /api/v1/ops/provider-status` reports Scrydex configuration, slab-sync configuration, latest raw/slab refresh timestamps, and open unmatched/review counts.
- `GET /api/v1/ops/catalog-sync-status` reports recent catalog sync runs and latest sync status.
- `GET /api/v1/ops/pricing-refresh-failures?limit=20` reports recent raw/PSA refresh failures.
- `GET /api/v1/ops/unmatched-scans?limit=25` reports recent unresolved scans, likely unsupported scans, and abandoned scans.

## Pricing Provider Architecture

The backend uses a multi-provider pricing system with specialized providers for different pricing types:

### Supported Providers

1. **Pokemon TCG API** (raw pricing, priority 1)
   - Environment: `POKEMONTCG_API_KEY`
   - Supports: **raw pricing only** (not PSA)
   - Source: Official Pokemon TCG API (free)
   - File: `backend/pokemontcg_pricing_adapter.py`
   - Price sources: tcgplayer (USD), cardmarket (EUR)

2. **Scrydex** (primary PSA pricing in scanner runtime)
   - Environment: `SCRYDEX_API_KEY`, `SCRYDEX_TEAM_ID`
   - Supports: raw pricing, PSA graded pricing
   - File: `backend/scrydex_adapter.py`

3. **PriceCharting** (auxiliary/manual PSA provider)
   - Environment: `PRICECHARTING_API_KEY`
   - Supports: **PSA graded pricing only** (not raw)
   - Source: PriceCharting.com
   - File: `backend/pricecharting_adapter.py`

4. **Persisted SQLite snapshots**
   - No credentials required
   - Source of truth for freshness checks and the default return path when snapshots are still fresh

### How It Works

- Each provider implements the `PricingProvider` contract (`backend/pricing_provider.py`)
- `PricingProviderRegistry` remains available for shared provider wiring, diagnostics, and non-scanner/manual flows
- Scanner runtime refresh is lane-specific and freshness-aware:
  - raw => Pokemon TCG API only
  - slab => Scrydex only
  - persisted SQLite timestamps decide whether a live refresh is needed
- **Important**: Provider prices are never blended or averaged together
- One active provider is used per refresh; tray shows that provider's result
- Future support for side-by-side provider comparison in detail views

### Configuration

```bash
# Configure Pokemon TCG API for raw pricing (required for raw cards)
export POKEMONTCG_API_KEY=your_pokemontcg_api_key

# Configure Scrydex for PSA pricing (primary for slabs)
export SCRYDEX_API_KEY=your_scrydex_key
export SCRYDEX_TEAM_ID=your_team_id

# Configure PriceCharting for auxiliary/manual PSA workflows (optional)
export PRICECHARTING_API_KEY=your_pricecharting_key

# Optional: override base URLs
export PRICECHARTING_BASE_URL=https://www.pricecharting.com/api
export SCRYDEX_BASE_URL=https://api.scrydex.com
```

### Provider Status

Check provider readiness and last refresh times:

```bash
curl -s http://127.0.0.1:8788/api/v1/ops/provider-status | python3 -m json.tool
```

Response includes:
- List of all registered providers
- Provider metadata (ID, label, readiness, capabilities)
- Active raw/PSA providers
- Last refresh timestamps per provider

## Refresh Raw Or PSA From Active Provider

Example: Force-refresh PSA 9 pricing through the slab lane:

```bash
# Configure Scrydex for slab pricing
export SCRYDEX_API_KEY=your_api_key_here
export SCRYDEX_TEAM_ID=your_team_id_here

curl -s -X POST \
  'http://127.0.0.1:8788/api/v1/cards/sv8-238/refresh-pricing?grader=PSA&grade=9&forceRefresh=1' \
  | python3 -m json.tool
```

Expected response fields:
- `source` = active provider ID (e.g., "pokemontcg_api", "scrydex", or "pricecharting")
- `pricingMode` = "psa_grade_estimate" for slab pricing, "raw" for raw cards
- `pricingTier` = provider-specific tier (e.g., "pricecharting_exact_grade", "scrydex_exact_grade")

### Validate Provider Configuration

Check Scrydex credentials:
```bash
python3 backend/validate_scrydex.py
```

Check overall provider status:
```bash
curl -s http://127.0.0.1:8788/api/v1/ops/provider-status | python3 -m json.tool
```

If credentials are missing, commands exit cleanly and tell you which env vars need to be set.

## Latency Benchmark

Run the scanner benchmark against the real-world pack:

```bash
SPOTLIGHT_BENCHMARK_ITERATIONS=1 zsh tools/run_scan_latency_benchmark.sh
```

Or point it at a different server:

```bash
SPOTLIGHT_SCANNER_SERVER=http://127.0.0.1:8788/ \
SPOTLIGHT_BENCHMARK_ITERATIONS=1 \
zsh tools/run_scan_latency_benchmark.sh
```
