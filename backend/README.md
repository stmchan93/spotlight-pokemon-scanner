# Spotlight Scanner Backend

Local scaffold for the scanner-first MVP.

What it does:
- initializes a SQLite catalog and telemetry schema
- seeds a small Pokémon sample catalog
- generates Apple Vision feature-print embeddings for any catalog cards with local reference images
- keeps a metadata-hash fallback embedding for cards that do not have a local reference image yet
- exposes local JSON endpoints for scan matching, search, and feedback
- can import a larger Pokémon catalog plus reference images from Pokémon TCG API
- normalizes imported `tcgplayer` / `cardmarket` payloads into a single candidate `pricing` summary
- now supports grade-aware PSA slab pricing snapshots when slab comp data exists locally
- now uses a multi-provider pricing architecture with specialized providers:
  - **Pokemon TCG API** for raw/singles pricing (free, official) when `POKEMONTCG_API_KEY` is configured
  - **PriceCharting** for PSA slab pricing (specialized) when `PRICECHARTING_API_KEY` is configured
  - **Scrydex** as fallback for both when `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` are configured
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
If not, it returns raw pricing only as a labeled `raw_fallback`.

The pricing provider registry routes requests based on pricing type:

**Raw card pricing** tries providers in order:
1. `Pokemon TCG API` (if `POKEMONTCG_API_KEY` is configured)
2. `Scrydex` (if `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` are configured)
3. Imported snapshot (fallback cache)

**PSA slab pricing** tries providers in order:
1. `PriceCharting` (if `PRICECHARTING_API_KEY` is configured)
2. `Scrydex` (if `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` are configured)
3. Local slab comp model
4. Raw proxy (fallback)

`POST /api/v1/cards/<card_id>/refresh-pricing` tries raw providers in order until one succeeds.
`POST /api/v1/cards/<card_id>/refresh-pricing?grader=PSA&grade=<grade>` tries PSA providers in order.

Slab comp source sync:

- `POST /api/v1/slab-sales/import`
- `GET /api/v1/cards/<card_id>/slab-sales?grader=PSA&grade=10`
- `GET /api/v1/cards/<card_id>/slab-price-snapshot?grader=PSA&grade=10`

## Run

```bash
python3 backend/server.py --cards-file backend/catalog/cards.sample.json --database-path backend/data/sample_scanner.sqlite --port 8787
```

The iOS app currently defaults to `http://127.0.0.1:8788/` through the shared Xcode scheme and `AppContainer.swift`, and it falls back to the local matcher if the service is unavailable.

To point the app at a different backend, set `SPOTLIGHT_API_BASE_URL` in the Xcode scheme environment.

Example:

```bash
SPOTLIGHT_API_BASE_URL=http://127.0.0.1:8788/
```

## Seed Only

```bash
python3 backend/server.py --seed-only --cards-file backend/catalog/cards.sample.json --database-path backend/data/sample_scanner.sqlite
```

## Import A Larger Pokémon Catalog

The importer targets the official Pokémon TCG API and writes a local catalog JSON plus downloaded reference images.

```bash
python3 backend/import_pokemontcg_catalog.py \
  --api-key "$POKEMONTCG_API_KEY" \
  --query 'set.series:"Scarlet & Violet"' \
  --max-cards 1000 \
  --replace-output
```

This writes:

- `backend/catalog/pokemontcg/cards.json`
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
- some card image `*_hires` URLs can 404; the importer falls back to the small image and skips broken assets instead of aborting the run
- imported search and match payloads now include an optional `pricing` object when normalized price data is available
- imported card detail payloads include richer metadata plus normalized pricing via `GET /api/v1/cards/<card_id>`
- `POST /api/v1/cards/<card_id>/refresh-pricing` refreshes the imported price snapshot from Pokémon TCG API and updates the local cache timestamp
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

2. **PriceCharting** (PSA pricing, priority 2)
   - Environment: `PRICECHARTING_API_KEY`
   - Supports: **PSA graded pricing only** (not raw)
   - Source: PriceCharting.com
   - File: `backend/pricecharting_adapter.py`

3. **Scrydex** (both, fallback priority 3)
   - Environment: `SCRYDEX_API_KEY`, `SCRYDEX_TEAM_ID`
   - Supports: raw pricing, PSA graded pricing
   - File: `backend/scrydex_adapter.py`

4. **Imported Snapshots** (final fallback)
   - No credentials required
   - Uses locally cached pricing from Pokemon TCG API

### How It Works

- Each provider implements the `PricingProvider` contract (`backend/pricing_provider.py`)
- `PricingProviderRegistry` manages provider priority and fallback
- When refreshing pricing, the registry tries providers in order until one succeeds
- **Important**: Provider prices are never blended or averaged together
- One active provider is used per refresh; tray shows that provider's result
- Future support for side-by-side provider comparison in detail views

### Configuration

```bash
# Configure Pokemon TCG API for raw pricing (required for raw cards)
export POKEMONTCG_API_KEY=your_pokemontcg_api_key

# Configure PriceCharting for PSA pricing (required for PSA slabs)
export PRICECHARTING_API_KEY=your_pricecharting_key

# Configure Scrydex as fallback (optional)
export SCRYDEX_API_KEY=your_scrydex_key
export SCRYDEX_TEAM_ID=your_team_id

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

Example: Refresh PSA 9 pricing (tries providers in order until one succeeds):

```bash
# Configure at least one provider
export PRICECHARTING_API_KEY=your_key_here
# or
export SCRYDEX_API_KEY=your_api_key_here
export SCRYDEX_TEAM_ID=your_team_id_here

curl -s -X POST \
  'http://127.0.0.1:8788/api/v1/cards/sv8-238/refresh-pricing?grader=PSA&grade=9' \
  | python3 -m json.tool
```

Expected response fields:
- `source` = active provider ID (e.g., "pricecharting", "scrydex", or "pokemontcg_api")
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
