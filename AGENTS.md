# AGENTS

Repo-specific workflow notes for future coding agents.

## Scope

- This repo is a local iOS + Python backend prototype for a Pokemon card scanner.
- The active product/status doc is [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md).

## Current provider rules

- Pricing provider abstraction is now implemented with specialized providers:
- Runtime uses a provider registry with priority-based fallback:
  - **Pokemon TCG API** for raw/singles pricing (priority 1, free official data)
  - **PriceCharting** for PSA slab pricing (priority 2, specialized graded pricing)
  - **Scrydex** as fallback for both raw and PSA (priority 3)
  - Each provider implements the shared `PricingProvider` contract
- Provider prices are **not** blended or averaged together.
- The tray shows one active/default provider result.
- The architecture supports future side-by-side provider display in detail views.
- Implementation files:
  - [backend/pricing_provider.py](/Users/stephenchan/Code/spotlight/backend/pricing_provider.py) - provider contract and registry
  - [backend/pricing_utils.py](/Users/stephenchan/Code/spotlight/backend/pricing_utils.py) - shared price normalization utilities
  - [backend/pokemontcg_pricing_adapter.py](/Users/stephenchan/Code/spotlight/backend/pokemontcg_pricing_adapter.py) - Pokemon TCG API implementation
  - [backend/pricecharting_adapter.py](/Users/stephenchan/Code/spotlight/backend/pricecharting_adapter.py) - PriceCharting implementation
  - [backend/scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py) - Scrydex implementation

## Key backend entry points

- `backend/server.py`
- `backend/catalog_tools.py`
- `backend/scrydex_adapter.py`
- `backend/slab_source_sync.py`
- `backend/catalog_sync.py`
- `backend/sync_catalog.py`
- `backend/validate_scrydex.py`

## Key app entry points

- `Spotlight/ViewModels/ScannerViewModel.swift`
- `Spotlight/Views/ScannerView.swift`
- `Spotlight/Models/CardCandidate.swift`
- `Spotlight/Models/ScanModels.swift`
- `Spotlight/Models/ScanTrayLogic.swift`

## Validation commands

Run these after backend or app changes:

```bash
python3 -m py_compile backend/catalog_tools.py backend/import_pokemontcg_catalog.py backend/catalog_sync.py backend/sync_catalog.py backend/slab_source_sync.py backend/sync_slab_sources.py backend/scrydex_adapter.py backend/validate_scrydex.py backend/server.py
python3 -m unittest discover -s backend/tests -p 'test_*.py' -v
zsh tools/run_scan_tray_logic_tests.sh
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build
SPOTLIGHT_SCANNER_SERVER=http://127.0.0.1:8788/ zsh tools/run_scanner_regression.sh
zsh tools/run_realworld_regression.sh
SPOTLIGHT_BENCHMARK_ITERATIONS=1 zsh tools/run_scan_latency_benchmark.sh
```

## Runtime commands

Imported backend:

```bash
export SCRYDEX_API_KEY=your_api_key
export SCRYDEX_TEAM_ID=your_team_id
python3 backend/server.py \
  --cards-file backend/catalog/pokemontcg/cards.json \
  --database-path backend/data/imported_scanner.sqlite \
  --port 8788
```

Sample backend:

```bash
python3 backend/server.py \
  --cards-file backend/catalog/cards.sample.json \
  --database-path backend/data/sample_scanner.sqlite \
  --port 8787
```

## QA assets

- Clean image regression runner: `tools/run_scanner_regression.sh`
- Real-world image regression runner: `tools/run_realworld_regression.sh`
- Latency benchmark runner: `tools/run_scan_latency_benchmark.sh`
- Simulator photo import: `tools/import_simulator_media.sh`

## Notes

- There is no `.git` directory in this workspace right now, so do not rely on `git status` for change discovery.
- Prefer updating the master status doc and `PLAN.md` when milestones move.
- Before touching provider code, read the new provider-abstraction docs above. The intended behavior is:
  - one active/default provider result for the tray
  - future side-by-side provider display in details
  - no cross-provider averaging
- Important ops endpoints now exist:
  - `GET /api/v1/ops/provider-status`
  - `GET /api/v1/ops/catalog-sync-status`
  - `GET /api/v1/ops/pricing-refresh-failures`
  - `GET /api/v1/ops/unmatched-scans`
- The backend can now import live catalog misses through `POST /api/v1/catalog/import-card` and `POST /api/v1/catalog/resolve-miss`.
- Production slab-source manifest sample exists at `backend/catalog/slab_sources.production.sample.json`.
- Validate slab-source auth/readiness without running sync:
  - `python3 backend/sync_slab_sources.py --manifest backend/catalog/slab_sources.production.sample.json --validate`
- Validate Scrydex creds/live provider wiring:
  - `python3 backend/validate_scrydex.py`
