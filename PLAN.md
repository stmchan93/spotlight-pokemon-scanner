# PLAN

Date: 2026-04-04

## Current milestone status

### Milestone 1: Scanner-first tray UX

Status: `done`

- Persistent scanner surface exists
- Tray-first scan flow exists
- Inline pricing rows exist
- Running total exists

### Milestone 2: Resolver router

Status: `done`

- Raw-card routing exists
- PSA slab routing exists
- Visual fallback exists
- Fake/custom-card rejection was hardened

### Milestone 3: Local pricing foundation

Status: `done`

- Imported catalog path exists
- Local raw pricing snapshots exist
- Slab comp tables and snapshot model exist

### Milestone 4: Multi-provider pricing abstraction

Status: `done`

- Shared provider contract and registry implemented
- Pokemon TCG API is the default raw-card provider
- Scrydex is the default PSA slab provider
- PriceCharting remains available in the shared layer for non-default/manual PSA workflows
- Provider prices are not blended together
- Tray shows one active/default provider result
- Architecture supports future side-by-side provider display

### Milestone 5: PSA comp ingestion foundation

Status: `partially done`

- Slab sales ingestion pipeline exists
- PSA APR/source sync scaffolding exists
- Snapshot recompute exists
- Multi-source adapter layer exists
- Production auth/readiness validation exists for PSA APR, eBay, Goldin, Heritage, and Fanatics manifests
- Live production marketplace sync coverage is still incomplete because credentials and source-specific deployment configs are still missing

### Milestone 6: Scanner trust and unsupported handling

Status: `partially done`

- Explicit unsupported/review state exists in the app
- Source and freshness labels exist in tray rows
- Local fallback mode is visible in the UI
- Provider status, unmatched-scan reporting, and pricing-refresh failure reporting exist
- Real-world fake-card false positives were materially reduced by excluding synthetic non-Pokemon-TCG raw identifier entries from the local runtime map
- The real-world regression pack is improved but not fully green yet:
  - current result = `14/20 passed`
  - remaining misses are primarily slab-pricing coverage and low-confidence review cases, not the old dangerous fake-card direct matches

### Milestone 7: Catalog freshness foundation

Status: `partially done`

- Catalog sync/state module exists
- Sync CLI exists with full-sync and release-window preload planning
- Live structured raw catalog miss import + retry exists
- Recent sync runs can be reported through ops endpoints
- Remaining work is real scheduled deployment and live provider validation

### Milestone 8: Latency and manual verification

Status: `partially done`

- CLI latency benchmark exists and runs against the real-world pack
- Current benchmark on the imported backend is:
  - analysis avg `656.9ms`, p95 `1159.4ms`
  - match avg `35.0ms`, p95 `75.0ms`
  - total avg `691.9ms`, p95 `1190.6ms`
- App install/launch was verified on the booted iPhone 17 simulator
- Human tap-through verification in the simulator/device is still outstanding

## Remaining tasks

1. Finish live source syncing for slab comps with real authenticated sources and production manifests.
2. Configure and validate provider credentials for production-like tester traffic.
3. Do human tap-through verification for raw / PSA / unsupported flows on simulator or device.
4. Measure true in-app latency on a real device or fully interactive simulator session and compare it to the ship target.
5. Continue improving scanner quality and resolver accuracy on real-world photo sets.
6. Keep the lightweight card-identifier parser regression runner green when OCR cleanup changes land.
7. Improve slab pricing/data coverage on correctly matched slab labels that currently return no grade snapshot.
8. Tighten or document low-confidence review cases in the real-world photo pack before broader external testing.

## TestFlight Readiness TODOs

1. Decide the TestFlight backend target:
   - keep `Staging` and `Release` on the Cloud Run backend
   - confirm backend env vars are present in that deployment:
     - `POKEMONTCG_API_KEY`
     - `SCRYDEX_API_KEY`
     - `SCRYDEX_TEAM_ID`
2. Verify production-mode provider rules on Cloud Run:
   - raw scans must price through Pokemon TCG API
   - slab scans must price through Scrydex
   - slab scans must not degrade into raw proxy pricing
3. Run a real-device TestFlight smoke pass covering:
   - modern English raw cards
   - vintage English raw cards
   - PSA slabs with readable labels
   - unsupported/custom/fake cards
   - low-light / glare / angled-card captures
4. Add lightweight tester telemetry before broad rollout:
   - count successful scans
   - count unsupported scans
   - count manual correction usage
   - count pricing refresh failures
   - count backend/provider failures by provider
5. Add a small known-supported QA pack for external testing:
   - 10-20 raw cards across eras
   - 3-5 PSA slabs with expected labels and prices
   - document expected match + price source for each
6. Harden the unsupported UX for external testers:
   - clear “could not scan this card” messaging
   - clear “price unavailable” messaging
   - optional “search manually” escape hatch
7. Confirm Cloud Run operational visibility:
   - `GET /api/v1/ops/provider-status`
   - `GET /api/v1/ops/pricing-refresh-failures`
   - `GET /api/v1/ops/unmatched-scans`
   - `GET /api/v1/ops/cache-status`
8. Decide rollout scope:
   - internal-only TestFlight first
   - then a small external tester cohort
   - then wider external testers only after unsupported/mis-match rates are acceptable
9. Publish a short tester script:
   - what cards to try
   - what to do when a scan fails
   - how to report wrong match vs wrong price vs unsupported
10. Decide whether Japanese/custom-numbering support is in or out for the first TestFlight.
    - if out, document that clearly in tester instructions

## Consolidated Pre-TestFlight TODOs

### A. Pricing Refresh Architecture

1. Replace in-memory-cache-as-truth with DB-snapshot freshness as the canonical pricing freshness rule.
2. Use persisted snapshot timestamps in SQLite to decide whether a price is fresh or stale.
3. Keep the default freshness window at `24 hours` for both raw and slab pricing unless product requirements change.
4. Add a `force refresh` path for explicit user refresh so a user can bypass the standard freshness window.
5. Keep any in-memory cache only as an optimization layer, not as the correctness layer.
6. Ensure Cloud Run behavior does not depend on per-instance memory cache semantics.
7. Return explicit freshness metadata to the app:
   - snapshot timestamp
   - provider-updated timestamp
   - whether the response was live-refreshed or served from existing snapshot/cache
8. Add ops/debug visibility for pricing freshness:
   - oldest snapshots
   - refresh failure counts
   - average snapshot age
   - provider-specific refresh success rate
9. Decide whether internal testers should see a UI affordance that says:
   - `Fresh`
   - `Cached`
   - `Stale`
   - `Live refreshed`

### B. Backend / Cloud Run Readiness

1. Verify Cloud Run env vars and secrets are correct:
   - `POKEMONTCG_API_KEY`
   - `SCRYDEX_API_KEY`
   - `SCRYDEX_TEAM_ID`
2. Verify raw scans always use Pokemon TCG API pricing in runtime flow.
3. Verify slab scans always use Scrydex pricing in runtime flow.
4. Verify slab scans do not silently degrade into raw-card pricing.
5. Verify unsupported scans return explicit unsupported/review states instead of weak wrong matches.
6. Verify Cloud Run endpoints are healthy and useful:
   - `/api/v1/ops/provider-status`
   - `/api/v1/ops/pricing-refresh-failures`
   - `/api/v1/ops/unmatched-scans`
   - `/api/v1/ops/cache-status`
7. Verify Cloud Run logs make pricing and matcher provenance obvious enough for debugging tester reports.
8. Decide whether the current SQLite deployment model is sufficient for tester traffic or whether persistence behavior needs to be hardened first.

### C. Scanner Product Readiness

1. Re-test raw card OCR on the real-device card pack that has already been working well.
2. Re-test slab scanning on real PSA slabs with readable labels.
3. Verify raw/slab mode toggle affects real routing, not just presentation.
4. Verify unsupported/custom/fake cards fail clearly.
5. Verify manual search fallback is good enough for cards that scanner cannot resolve.
6. Decide and document first-TestFlight scope:
   - English raw only?
   - PSA only for readable labels?
   - Japanese/custom-numbering excluded?

### D. QA / TestFlight Operations

1. Create a small internal tester script:
   - what cards to try
   - what results should appear
   - how to report wrong match vs wrong price vs unsupported
2. Create a known-good QA card pack:
   - modern raw
   - vintage raw
   - PSA slabs
   - unsupported/custom controls
3. Add lightweight telemetry or at least structured logging for:
   - scan success rate
   - unsupported rate
   - correction usage
   - pricing refresh failures
   - provider failures
4. Do an internal-only TestFlight first.
5. Expand only after mismatch/unsupported rates are acceptable on real cards outside the current personal test set.

### E. Codebase Audit / Cleanup

1. Audit the iOS app for duplicate, dead, or stale scanner logic.
2. Audit the backend for duplicate pricing/provider code paths and remove legacy fallback behavior that no longer matches product rules.
3. Remove unused structs, helpers, adapters, and stale compatibility branches where safe.
4. Identify code that is still legacy/experimental and either delete it or clearly mark it as non-runtime.
5. Sweep docs for outdated statements about provider priority, slab raw proxies, or environment behavior.
6. Reduce confusing duplicate sources of truth in scanner configuration and environment selection.
7. Prefer extracting shared parsing/routing logic into testable units rather than leaving it embedded in large files.

### F. Tests / Reliability

1. Add regression tests for pricing freshness policy:
   - fresh snapshot returned without provider refresh
   - stale snapshot triggers provider refresh
   - force refresh bypasses normal freshness gate
2. Add integration tests for raw-mode provider routing.
3. Add integration tests for slab-mode provider routing.
4. Add tests proving slab scans never return raw proxy pricing.
5. Add tests for unsupported scans and weak OCR behavior.
6. Add tests for Cloud Run/runtime environment configuration where practical.
7. Expand Swift-side tests around scan mode, tray state, and price refresh state.
8. Keep parser, reticle-layout, and tray-logic test runners green after cleanup changes.
9. After cleanup, run the full validation suite again and fix or delete stale tests instead of carrying broken legacy tests.

### G. Nice-To-Have After Internal TestFlight Starts

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

Use [scanner-v1-completion-checklist-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/scanner-v1-completion-checklist-2026-04-03.md) for the broader scanner track and [pricing-provider-abstraction-todos-2026-04-04.md](/Users/stephenchan/Code/spotlight/docs/pricing-provider-abstraction-todos-2026-04-04.md) for the next pricing-provider implementation pass.
