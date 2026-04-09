# Spotlight Scanner Master Status

Date: 2026-04-04

This is the current source of truth for the Spotlight scanner project.

Current rollout/runbook for the first internal tester cohort:

- [internal-testflight-rollout-2026-04-07.md](/Users/stephenchan/Code/spotlight/docs/internal-testflight-rollout-2026-04-07.md)

Current validation snapshot as of 2026-04-07:

- backend tests: `92/92` passing
- app build: `xcodebuild ... build` passing
- real-world regression pack: `14/20 passed`
- real-world latency benchmark:
  - analysis avg `656.9ms`, p95 `1159.4ms`
  - match avg `35.0ms`, p95 `75.0ms`
  - total avg `691.9ms`, p95 `1190.6ms`

Use this doc first for:

- current product direction
- what is implemented
- how raw vs PSA scans work
- how pricing works today
- how PSA-grade pricing works right now
- how to test the repo
- what is blocked
- what should be built next

Active implementation spec:

- [resolver-router-implementation-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/resolver-router-implementation-spec-2026-04-03.md)
- [psa-grade-pricing-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/psa-grade-pricing-spec-2026-04-03.md)
- [psa-slab-source-sync-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/psa-slab-source-sync-spec-2026-04-03.md)
- [scrydex-pricing-v1-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/scrydex-pricing-v1-spec-2026-04-03.md)
- [pricing-provider-abstraction-spec-2026-04-04.md](/Users/stephenchan/Code/spotlight/docs/pricing-provider-abstraction-spec-2026-04-04.md)

Active implementation checklist:

- [tray-first-scanner-implementation-todos-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/tray-first-scanner-implementation-todos-2026-04-03.md)
- [psa-grade-pricing-todos-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/psa-grade-pricing-todos-2026-04-03.md)
- [psa-slab-source-sync-todos-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/psa-slab-source-sync-todos-2026-04-03.md)
- [scrydex-pricing-v1-todos-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/scrydex-pricing-v1-todos-2026-04-03.md)
- [scanner-v1-completion-checklist-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/scanner-v1-completion-checklist-2026-04-03.md)
- [pricing-provider-abstraction-todos-2026-04-04.md](/Users/stephenchan/Code/spotlight/docs/pricing-provider-abstraction-todos-2026-04-04.md)

## Product Direction

The current product cut is:

- Pokemon-first
- one persistent scanner surface
- one-card-at-a-time capture
- live stack/tray on the same screen
- instant cached price on row creation
- inline row expansion for more pricing
- raw-card scans and PSA slab scans routed differently

### Scanner V1 Supported Scope

Scanner v1 currently supports:

- Pokémon only
- one card per photo
- tray-first scanner UI
- raw cards and PSA slabs
- English-first scans
- explicit review/unsupported handling instead of silent forced matches

Scanner v1 explicitly does not support:

- binder pages or multi-card photos
- continuous bulk auto-detect without explicit capture/import
- generalized Japanese support unless the card is specifically imported and tested
- BGS / CGC grade-aware pricing
- pretending raw proxy prices are true slab prices

The intended feel is:

- `scan -> row snaps into tray -> keep scanning`

Not:

- `scan -> go to detail page -> go back -> scan again`

## What Exists Today

### iOS App

The iOS app is now tray-first.

Main behaviors:

- persistent scanner surface
- tap-anywhere scan when camera is live
- import-photo fallback
- pending tray row appears immediately
- resolved row updates in place
- low-confidence scans open the correction sheet
- compact row shows one primary price
- expanded row shows `low / market / mid / high`
- row-scoped refresh
- running total in tray header

Main files:

- [ScannerView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerView.swift)
- [ScannerRootView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerRootView.swift)
- [ScannerViewModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift)
- [AlternateMatchesView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/AlternateMatchesView.swift)
- [ScanModels.swift](/Users/stephenchan/Code/spotlight/Spotlight/Models/ScanModels.swift)
- [ScanTrayLogic.swift](/Users/stephenchan/Code/spotlight/Spotlight/Models/ScanTrayLogic.swift)

### On-Device Analysis

The app still does local preprocessing before matching.

Current analyzer behavior:

- rectangle/crop detection
- OCR on full card
- OCR on top label region
- OCR on bottom strip
- OCR on bottom-left and bottom-right regions
- collector number extraction
- promo-code hint extraction
- set-hint extraction
- resolver-mode hinting

Main file:

- [CardRectangleAnalyzer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardRectangleAnalyzer.swift)

### Backend Matcher

The backend is a local Python service with:

- `health`
- `ops/provider-status`
- `ops/catalog-sync-status`
- `ops/pricing-refresh-failures`
- `ops/unmatched-scans`
- `cards/search`
- `cards/<id>`
- `cards/<id>/refresh-pricing`
- `catalog/import-card`
- `catalog/resolve-miss`
- `scan/match`
- `scan/feedback`

Main files:

- [server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
- [catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)
- [schema.sql](/Users/stephenchan/Code/spotlight/backend/schema.sql)

## Current Resolver Architecture

The current runtime path is a router, not one universal resolver.

### Raw Card Path

Happy path:

1. crop/orient card
2. read bottom strip
3. extract `collector number / promo code / set hints`
4. direct catalog lookup
5. return candidate pricing immediately

Only if that is weak:

- fall back to hybrid visual/metadata retrieval

### PSA Slab Path

Happy path:

1. inspect top label text
2. detect slab-like label signals
3. parse label card number and name/set clues
4. run PSA label lookup
5. return candidate pricing immediately

Important pricing rule:

- PSA slab scans do not pretend raw prices are slab comps
- if PSA label OCR or slab pricing is unavailable, the scan stays unsupported / no-price instead of degrading into a raw proxy

### Unknown Fallback Path

Used when:

- routing is weak
- OCR is weak
- card is unusual
- card may be fake/custom/unsupported

Behavior:

- hybrid visual + metadata shortlist
- lower trust
- more likely to open correction sheet
- unsupported/custom cards can now land in an explicit unsupported tray state instead of looking like a vague weak match

### Auto-Accept Rule

The app no longer auto-accepts every non-low result.

Current rule:

- `high` confidence -> auto-accept
- `medium` confidence -> auto-accept only for `direct_lookup` or `psa_label`
- `medium` visual fallback -> review
- `low` -> review

That change is specifically to reduce silent wrong matches on custom/fake/ambiguous cards.

## Pricing Model Today

Pricing today uses a multi-provider architecture:

- **Provider Registry**: Priority-based fallback system with pluggable pricing providers
- **Active Providers**:
  - `Pokemon TCG API` (default raw provider, priority 1) - when `POKEMONTCG_API_KEY` is configured or anonymous access is sufficient
  - `Scrydex` (default PSA provider, priority 2) - when `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` are configured
  - `PriceCharting` (auxiliary/manual PSA provider, priority 3) - when `PRICECHARTING_API_KEY` is configured
- **Fallback Behavior**:
  - Raw cards in scanner runtime: pokemontcg_api → imported snapshot / existing stored data
  - PSA slabs in scanner runtime: scrydex → local slab comp / unsupported
- **Important**: Provider prices are **never** blended or averaged together
- **Tray Display**: Shows one active/default provider result

### Pricing Freshness Today

- Persisted SQLite snapshot timestamps are the source of truth for the scanner runtime `24 hour` freshness window.
- Refresh reads the stored snapshot first:
  - fresh snapshot => return it immediately
  - stale snapshot => refresh the live provider for the active lane and persist the result
- Manual refresh can bypass the normal freshness window with `forceRefresh=1`.
- Background cache cleanup still exists for the legacy in-memory provider cache, but scanner runtime correctness no longer depends on that cache.
- The app can show an existing stored pricing snapshot immediately during match resolution.
- After a card is accepted into the tray, the app schedules an idle pricing refresh after about `1.8 seconds` if the shown price is not already fresh.
- User-triggered refresh uses the same backend refresh path with force-refresh enabled.
- Separate from provider refresh caching, the app keeps a `7-day` local/offline scan cache for previously seen cards.
- **Future Support**: Architecture ready for side-by-side provider display in detail views

Imported snapshot pricing is retained as the cache fallback when:
- A persisted snapshot already exists and is still within the freshness window
- A live provider refresh fails and the app needs to keep showing the last known snapshot
- A card has not been refreshed yet but still has seeded/imported local pricing

Pricing is not yet:

- live eBay sold comp aggregation
- a final production pricing stack
- showing multiple providers side-by-side in details

PSA-grade pricing now works like this:

- parse PSA label text for grader + grade
- try each pricing provider in priority order
- look for a `slab_price_snapshot` for that exact card + grade
- use tiered slab pricing:
  - `exact_same_grade`
  - `same_card_grade_ladder`
  - `bucket_index_model`
- if no slab pricing exists, fall back to raw pricing only as `Raw proxy`

This is now implemented in:

- [pricing-provider-abstraction-spec-2026-04-04.md](/Users/stephenchan/Code/spotlight/docs/pricing-provider-abstraction-spec-2026-04-04.md)
- [psa-grade-pricing-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/psa-grade-pricing-spec-2026-04-03.md)
- [scrydex-pricing-v1-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/scrydex-pricing-v1-spec-2026-04-03.md)
- [pricing_provider.py](/Users/stephenchan/Code/spotlight/backend/pricing_provider.py)
- [pricecharting_adapter.py](/Users/stephenchan/Code/spotlight/backend/pricecharting_adapter.py)
- [scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py)
- [catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)
- [server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
- [CardCandidate.swift](/Users/stephenchan/Code/spotlight/Spotlight/Models/CardCandidate.swift)
- [ScannerViewModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift)

PSA slab-source sync now works like this:

1. define slab sales sources in a manifest
2. fetch a PSA Auction Prices page or local HTML export
3. parse sale rows into normalized `slab_sales`
4. import + dedupe those sales
5. recompute affected `slab_price_snapshots`
6. return the updated slab snapshot through normal detail/refresh endpoints

Current source-sync files:

- [psa-slab-source-sync-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/psa-slab-source-sync-spec-2026-04-03.md)
- [slab_source_sync.py](/Users/stephenchan/Code/spotlight/backend/slab_source_sync.py)
- [sync_slab_sources.py](/Users/stephenchan/Code/spotlight/backend/sync_slab_sources.py)

Current slab-source adapter coverage:

- PSA Auction Prices HTML
- eBay sold JSON fixture/adapter
- Goldin sales JSON fixture/adapter
- Heritage sales JSON fixture/adapter
- Fanatics sales JSON fixture/adapter

The parser layer is now provider-agnostic, even though production live-auth coverage is still incomplete.

Production sync readiness now also exists:

- manifest env placeholders can be validated before sync
- provider status reports whether slab-source auth is actually ready
- the sample production manifest covers:
  - PSA APR
  - eBay
  - Goldin
  - Heritage
  - Fanatics
- the live sync step is still blocked until real auth values are provided

## Catalog Freshness And Miss Recovery

The scanner no longer depends only on one-off manual imports.

Current catalog freshness tooling:

- sync planning/state via [catalog_sync.py](/Users/stephenchan/Code/spotlight/backend/catalog_sync.py)
- runnable sync CLI via [sync_catalog.py](/Users/stephenchan/Code/spotlight/backend/sync_catalog.py)
- live catalog miss recovery for structured raw scans
- immediate local cache writes into SQLite
- ops visibility through:
  - `GET /api/v1/ops/catalog-sync-status`
  - `GET /api/v1/ops/unmatched-scans`
  - `GET /api/v1/ops/pricing-refresh-failures`

Catalog miss recovery endpoints:

- `POST /api/v1/catalog/import-card`
- `POST /api/v1/catalog/resolve-miss`

Current policy:

- if a structured raw scan has useful set/number clues but no strong local match, the backend can try a live catalog lookup, cache the card locally, refresh the in-memory index, and retry once

## Trust And Unsupported States

The app now distinguishes between:

- ready
- needs review
- unsupported

Tray rows now surface:

- source label
- freshness label
- methodology summary
- fallback mode
- unsupported/review reason when relevant
- per-scan latency metrics when available

This is implemented in:

- [CardCandidate.swift](/Users/stephenchan/Code/spotlight/Spotlight/Models/CardCandidate.swift)
- [ScanModels.swift](/Users/stephenchan/Code/spotlight/Spotlight/Models/ScanModels.swift)
- [ScanTrayLogic.swift](/Users/stephenchan/Code/spotlight/Spotlight/Models/ScanTrayLogic.swift)
- [ScannerView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerView.swift)
- [ScannerViewModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift)

## Regression Status

Current automated status:

- backend unit tests: `55/55` passing
- local clean-card regression: `6/6` passing against the imported backend on `8788`
- real-world photo regression: `20/20` passing
- real-world latency benchmark:
  - analysis avg `719.0ms`, p95 `1015.7ms`
  - match avg `46.0ms`, p95 `171.1ms`
  - total avg `764.9ms`, p95 `1088.7ms`
- iOS simulator build: `BUILD SUCCEEDED`
- app install/launch on the booted iPhone 17 simulator: verified

The current real-world batch includes:

- raw cards
- top loaders
- PSA slabs
- intentionally fake/custom cards that should stay low-confidence

Recent hardening that is now in place:

- fake/custom raw cards no longer get confident number-only direct lookup matches
- generic tokens like `ex` no longer count as meaningful name support for raw direct lookup
- PSA slab label OCR now includes an extra upper-right label pass
- PSA grade parsing now survives adjective-only OCR like `MINT` even when the digit is dropped
- [sync_slab_sources.py](/Users/stephenchan/Code/spotlight/backend/sync_slab_sources.py)
- [slab_sources.sample.json](/Users/stephenchan/Code/spotlight/backend/catalog/slab_sources.sample.json)

Current pricing pipeline:

1. import card metadata from Pokémon TCG API
2. normalize `tcgplayer` and `cardmarket` price blocks
3. store summaries in `card_price_summaries`
4. attach pricing to candidates and detail payloads

Current scan-latency behavior:

- use candidate pricing from `scan/match` immediately
- show row immediately
- do not fetch detail in the hot path
- defer refresh until scan activity pauses
- row refresh can also be triggered manually

This means “cached quote” currently means:

- local backend snapshot price already stored in SQLite

It does not mean:

- exact live market price at that second

Current pricing-trust behavior:

- rows show source and freshness state
- fallback mode is explicit in the app when the backend is unavailable
- unsupported/custom cards can land in an explicit unsupported state
- low-confidence slab scans and visual-fallback matches stay reviewable instead of auto-accepting silently
- structured raw scans can attempt a live catalog miss import and retry without leaving the scan flow
- live provider validation and production slab-source validation now have explicit CLI commands instead of only ad hoc manual debugging

## Catalog State

Two backend modes still exist:

- sample backend on `8787`
- imported backend on `8788`

Current imported catalog:

- sourced from Pokémon TCG API
- local reference images are a legacy optional artifact, not the intended source of truth for scanner/product metadata
- current catalog size: `2020` cards

Imported artifacts:

- [images](/Users/stephenchan/Code/spotlight/backend/catalog/pokemontcg/images)
- [spotlight_scanner.sqlite](/Users/stephenchan/Code/spotlight/backend/data/spotlight_scanner.sqlite)

Current repo rules for development:

- use a **local backend** during scanner debugging, not a hardcoded production cloud backend
- app environment selection should come from Xcode config files:
  - `Debug` => local
  - `Staging` => TestFlight/internal
  - `Release` => production
- use `Spotlight/Config/LocalOverrides.xcconfig` as the machine-local app override file
- current `Staging` and `Release` both point at `https://spotlight-backend-grhsfspaia-uc.a.run.app/`
- raw-card scans now use OCR-plus-backend matching directly; there is no bundled raw identifier map in the app runtime path
- treat checked-in local image bundles and backup catalog files as legacy importer artifacts unless/until the backend is intentionally redesigned around them

Targeted real-card coverage added so far includes:

- `neo1-9` Lugia
- `base1-2` Blastoise
- `base6-3` Charizard
- `base6-64` Snorlax
- `ex13-103` Mewtwo Star
- `ecard3-146` Charizard
- `ecard3-30` Starmie
- `ecard3-H28` Starmie
- `sm9-170` Latias & Latios-GX
- `sv8-238` Pikachu ex
- `sv3pt5-168` Charmander
- `pop5-16` Espeon Star
- `swsh12pt5gg-GG37` Simisear VSTAR
- `xy4-35`, `xy4-121`, `xyp-XY166` M Gengar-EX variants

Targeted exact-card import now supports:

- `python3 backend/import_pokemontcg_catalog.py --card-id <id> --exact-only`

Catalog freshness tooling now exists:

- scheduled sync/state module:
  - [catalog_sync.py](/Users/stephenchan/Code/spotlight/backend/catalog_sync.py)
- runnable sync CLI:
  - [sync_catalog.py](/Users/stephenchan/Code/spotlight/backend/sync_catalog.py)
- sample manifest:
  - [catalog_sync.sample.json](/Users/stephenchan/Code/spotlight/backend/catalog/catalog_sync.sample.json)

Current catalog freshness behavior:

- nightly-style full sync and release-window syncs can be planned/run from a state file
- live structured raw scan misses can import a new card into SQLite
- sync runs and pricing refresh failures are logged for ops visibility

## Validation Status

### Build

Validated:

- `xcodebuild` iOS simulator build passes

### Automated Tests

Validated:

- backend unit tests pass
- tray logic command-line tests pass

Main test files:

- [test_scanner_backend.py](/Users/stephenchan/Code/spotlight/backend/tests/test_scanner_backend.py)
- [scan_tray_logic_tests.swift](/Users/stephenchan/Code/spotlight/tools/scan_tray_logic_tests.swift)

Current backend test coverage includes:

- collector-number normalization
- slash-left lookup keys like `146/144 -> 146`
- set-hint normalization
- direct lookup ordering
- raw direct-lookup matching
- promo direct lookup
- PSA label routing
- vintage slab label matching
- modern slab label matching like `sv8-238` Pikachu ex PSA 9
- low-confidence handling for custom-card style payloads
- pricing-backed card detail

### Image Regression Pack

The on-disk fixture pack still exists and remains useful for deterministic scanner QA.

Files:

- [qa/images](/Users/stephenchan/Code/spotlight/qa/images)
- [scanner-regression.local.json](/Users/stephenchan/Code/spotlight/qa/scanner-regression.local.json)
- [scanner_eval.swift](/Users/stephenchan/Code/spotlight/tools/scanner_eval.swift)
- [run_scanner_regression.sh](/Users/stephenchan/Code/spotlight/tools/run_scanner_regression.sh)

Current clean-pack status:

- sample backend: `6/6`
- imported backend: `6/6`

## Real-World Photo Batch Status

The uploaded photo batch from this thread was useful for product and routing decisions.

What it showed:

- raw modern cards
- raw cards inside top loaders
- rotated cards
- vintage raw cards
- PSA slabbed vintage cards
- Japanese PSA slab
- likely custom/fake cards

That directly motivated the resolver-router split:

- `raw_card`
- `psa_slab`
- `unknown_fallback`

Important blocker:

- chat-attached images are not local filesystem files in this environment
- because of that, they cannot be added directly to [qa/images](/Users/stephenchan/Code/spotlight/qa/images) by code alone

So today we have:

- real-card text/label regressions in backend tests
- not yet full image regressions for those exact uploaded photos

To complete that last step, those images need to exist on disk under the repo or another local path.

## Manual Testing

### Run Imported Backend

```bash
cd /Users/stephenchan/Code/spotlight
python3 backend/server.py \
  --skip-seed \
  --database-path backend/data/spotlight_scanner.sqlite \
  --port 8788
```

### Run Sample Backend

```bash
cd /Users/stephenchan/Code/spotlight
python3 backend/server.py \
  --cards-file backend/catalog/sample_catalog.json \
  --database-path backend/data/sample_scanner.sqlite \
  --port 8787
```

### Run App

Open [Spotlight.xcodeproj](/Users/stephenchan/Code/spotlight/Spotlight.xcodeproj) in Xcode and run the `Spotlight` scheme.

Default backend:

- `http://127.0.0.1:8788/`

### Import Fixture Images Into Simulator

```bash
cd /Users/stephenchan/Code/spotlight
zsh tools/import_simulator_media.sh
```

### Run Automated Validation

```bash
cd /Users/stephenchan/Code/spotlight
python3 -m unittest discover -s backend/tests -p 'test_*.py' -v
zsh tools/run_scan_tray_logic_tests.sh
SPOTLIGHT_SCANNER_SERVER=http://127.0.0.1:8788/ zsh tools/run_scanner_regression.sh
zsh tools/run_realworld_regression.sh
SPOTLIGHT_BENCHMARK_ITERATIONS=1 zsh tools/run_scan_latency_benchmark.sh
python3 backend/sync_slab_sources.py --manifest backend/catalog/slab_sources.production.sample.json --validate
python3 backend/validate_scrydex.py
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build
```

### Best Current Manual Cards To Try

Supported real cards in the current imported backend include:

- `charizard-ex-223-197.png`
- `charizard-ex-125-197.png`
- `charizard-ex-svp-056.png`
- `iono-254-193.png`
- `basic-lightning-energy-257-198.png`
- `umbreon-vmax-tg23-tg30.png`

And via OCR/text coverage or exact imports, the backend now also supports the real-card identities behind many of the newer raw/slab examples:

- Lugia Neo Genesis
- Blastoise Base
- Charizard Legendary Collection
- Charizard Skyridge
- Snorlax Legendary Collection
- Mewtwo Star Holon Phantoms
- Latias & Latios-GX Team Up
- Charmander 151
- Espeon Star
- Simisear VSTAR GG37

## What Is Not Built Yet

Not built yet:

- bundle pricing totals beyond the current running primary-price sum
- deal log
- want list
- inventory management
- baseball/sports support
- dedicated set-symbol classifier
- final pricing credibility layer
- final live slab comp ingestion stack
- persistent ANN/vector service beyond the current in-process LSH shortlist
- actual on-disk regression pack for every chat-uploaded real-world photo batch
- human tap-through verification for raw / PSA / unsupported flows
- true in-app device latency validation against the ship threshold

## Recommended Next Steps

Highest-value next work:

1. Validate Scrydex live with real credentials on one raw card and one PSA slab.
2. Fill in and validate the production slab-source manifest with real auth values.
3. Do a human simulator/device pass for one raw scan, one PSA scan, and one unsupported scan.
4. Measure true in-app latency on a device or interactive simulator session.
5. Continue cleaning stale active-doc provider references and improving hard real-world raw/slab coverage.

## Related Docs

Supporting docs:

- [resolver-router-implementation-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/resolver-router-implementation-spec-2026-04-03.md)
- [live-scan-stack-ocr-first-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/live-scan-stack-ocr-first-spec-2026-04-03.md)
- [bundle-scanner-first-mvp-2026-04-02.md](/Users/stephenchan/Code/spotlight/docs/bundle-scanner-first-mvp-2026-04-02.md)
- [pokemon-scanner-architecture-2026-04-02.md](/Users/stephenchan/Code/spotlight/docs/pokemon-scanner-architecture-2026-04-02.md)
- [pokemon-scanner-system-design-2026-04-02.md](/Users/stephenchan/Code/spotlight/docs/pokemon-scanner-system-design-2026-04-02.md)
- [scan-api-contract-2026-04-02.md](/Users/stephenchan/Code/spotlight/docs/scan-api-contract-2026-04-02.md)
- [card-scanner-competitive-research-2026-04-02.md](/Users/stephenchan/Code/spotlight/docs/card-scanner-competitive-research-2026-04-02.md)
- wireframes under [docs/wireframes](/Users/stephenchan/Code/spotlight/docs/wireframes)
