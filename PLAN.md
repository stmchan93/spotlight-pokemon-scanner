# PLAN

Date: 2026-04-04

## Current planning override

- The current backend reset / raw-matcher redesign source of truth is [docs/raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md).
- The current OCR rewrite / rollout source of truth is [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md).
- The raw backend reset has now landed.
- Treat the current backend runtime as:
  - raw-only
  - 3-table SQLite (`cards`, `card_price_snapshots`, `scan_events`)
  - thin provider shells preserved for Pokemon TCG API, Scrydex, and PriceCharting
- Treat the old slab/sync/cache backend modules as deleted legacy state, not as code to revive.
- Treat the current OCR implementation as temporary legacy structure while the new OCR pipeline is planned and evaluated side-by-side.

## Current OCR planning override

- The next OCR rewrite must use:
  - a shared front half
  - a raw branch
  - a slab branch
- Top-level OCR routing follows the UI-selected mode:
  - `raw`
  - `slab`
- `raw in holder` is not a separate top-level mode.
  - holder / sleeve / top-loader cases stay inside raw as scene traits
- The new OCR path must be:
  - fixture-first
  - replayable by stage
  - launched behind a feature flag
  - run side-by-side with the old path before old OCR is deleted

## Current milestone status

### Milestone 1: Raw backend reset

Status: `done`

- raw-only backend runtime is landed
- runtime SQLite is simplified to:
  - `cards`
  - `card_price_snapshots`
  - `scan_events`
- raw backend now returns a best candidate even at low confidence

### Milestone 2: OCR architecture rewrite

Status: `active`

- the source-of-truth OCR rewrite spec is now documented
- shared OCR data contracts are landed
- the stage-artifact writer is landed
- shared front-half extraction is landed:
  - frame source selection
  - target selection
  - perspective normalization
- simulator-backed legacy OCR fixture execution is landed
- mode sanity signals and the feature-flagged OCR coordinator are landed
- raw branch stage 1 is landed behind the rewrite path
- raw escalation and confidence is landed behind the rewrite path
- the current OCR path is still the active runtime path

### Milestone 3: OCR fixture-first rollout

Status: `active`

- fixture manifests and host baseline runner are landed
- stage-local replay artifact wiring is landed
- simulator-backed legacy OCR execution is landed
- mode sanity signals and the feature-flagged OCR coordinator are landed
- simulator-backed rewrite raw stage-1 execution is landed
- raw branch stage 1 is landed
- raw escalation and confidence is landed
- run old vs new OCR side-by-side before cutover

### Milestone 4: Slab/backend rebuild

Status: `deferred`

- slab backend runtime remains removed for now
- slab OCR branch and later slab backend rebuild will follow after OCR contracts settle

## Remaining tasks

1. Freeze the OCR rewrite contracts and keep [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md) as the source of truth.
2. Build the new slab OCR branch with card-identity evidence plus grader / grade / optional cert.
3. Run side-by-side old-vs-new OCR comparisons on fixtures and captured debug sessions.
4. Do human tap-through verification for launch speed, permission flow, and raw/scanner behavior on device.
5. Only then remove the old OCR path and proceed to slab backend/pricing rebuild on top of the new OCR payloads.

## Current validation priorities

1. Keep the backend reset validation commands green.
2. Keep the existing Swift parser / reticle / tray test scripts green.
3. Keep both OCR fixture runners green before deleting legacy OCR logic:
   - `zsh tools/run_ocr_fixture_runner.sh`
   - `zsh tools/run_ocr_simulator_fixture_tests.sh`

1. Consider a small scheduled prewarm job only for hot cards:
   - recently scanned cards
   - user collection/watchlist cards
   - top frequently scanned cards
2. Add richer tester-visible freshness labels if testers care about how live a price is.
3. Revisit broader Japanese/custom-numbering support once English/TestFlight signal is strong.

## Pricing Freshness Today

- Persisted SQLite snapshot timestamps are now the source of truth for the `24 hour` freshness window.
- Refresh checks read the stored snapshot first:
  - if the snapshot is fresh, the backend returns it immediately
  - if the snapshot is stale, the backend refreshes the active live provider for that lane and persists the new snapshot
- Manual refresh can bypass the normal freshness gate with `forceRefresh=1`.
- The legacy in-memory provider cache may still exist as an optimization path in shared provider code, but scanner runtime correctness no longer depends on it.
- The app usually shows the stored snapshot immediately, then schedules an idle refresh about `1.8 seconds` after a card is accepted into the tray if the pricing is not already marked fresh.
- User-triggered refresh now goes through the same backend refresh path with `forceRefresh=1`, so it can bypass the normal freshness window.
- App-side offline fallback cache is separate and lasts `7 days`; that is only for showing a previously seen card when the backend is unavailable.

## Pricing Freshness Decision

- Do **not** run a daily cron that refreshes all `15k+` cards. That is wasteful for the current product stage.
- Keep pricing refresh **on-demand**:
  - fast scan/match path reads the latest persisted snapshot from storage
  - if the stored snapshot is older than the target TTL, trigger a provider refresh and persist the new result
  - otherwise return the stored snapshot immediately
- Keep the default freshness window at `24 hours` for now for both raw and slab pricing.
- Add a separate **force refresh** path for explicit user refresh so the user can bypass the 24-hour freshness gate when they really want live data.
- If we add scheduled refreshing later, it should only prewarm a small hot set:
  - recently scanned cards
  - cards in the user collection/watchlist
  - maybe the top N most frequently scanned cards
  not the whole catalog.

## Pricing Freshness Follow-Up TODOs

1. Keep provider/in-memory caching as an optimization, not as the sole source of the 24-hour policy.
2. Add explicit freshness metadata to API responses so the app can show:
   - snapshot age
   - provider updated-at
   - whether the latest response was live-fetched or cache-served
3. Add an ops view/report for pricing freshness:
   - oldest snapshots
   - average snapshot age
   - refresh success/failure rates by provider
4. If Cloud Run remains multi-instance, avoid relying on per-instance memory cache semantics for correctness.
5. Consider a small scheduled prewarm job only after TestFlight proves there is repeated demand for the same cards.

## Immediate next best tasks

1. Verify the new app environment split on device and simulator:
   `Debug` => local, `Staging` => TestFlight/internal, `Release` => production.
2. Verify the real-device scanner fixes for local identifier lookup, safe backend-outage fallback, and Dark Weezing pricing/detail fetch.
3. Re-run the real-world regression set for vintage footer OCR, especially `60/132` cases where the right-side footer can be missed.
4. Add backend catalog coverage or explicit mapping for Japanese / custom-numbering cards that OCR now reads correctly but the backend still treats as unsupported.
5. Configure Scrydex credentials for default PSA testing and keep PriceCharting credentials as fallback coverage.
6. Validate live provider refresh with real credentials.
7. Run regression tests with the new provider architecture.
8. Do human tap-through verification for pricing flows on simulator or device.

## Full execution checklist

Use [raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md) for backend execution guidance and [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md) for the current product/runtime state.
