# Internal TestFlight Rollout

Date: 2026-04-07

This doc is the working rollout/runbook for the first internal TestFlight cohort.

## Current Validation Snapshot

- Backend tests: `92/92` passing
- Swift shell regressions:
  - `card_identifier_parser_tests: PASS`
  - `scanner_reticle_layout_tests: PASS`
  - `scan_tray_logic_tests: PASS`
- App build:
  - `xcodebuild ... build` succeeded
- Real-world regression pack:
  - `14/20 passed`
  - dangerous fake mega-card direct matches were eliminated
  - remaining misses are mostly slab-pricing coverage or known low-confidence review cases
- Latency benchmark on the real-world pack:
  - analysis avg `656.9ms`, p95 `1159.4ms`
  - match avg `35.0ms`, p95 `75.0ms`
  - total avg `691.9ms`, p95 `1190.6ms`

## Product Scope

- Raw mode:
  - resolver mode = `raw_card`
  - pricing source of truth = `Pokemon TCG API`
- Slab mode:
  - resolver mode = `psa_slab`
  - pricing source of truth = `Scrydex`
  - no silent fallback to raw-card pricing if slab label OCR or slab pricing is unavailable
- Pricing freshness:
  - persisted SQLite snapshot timestamps are the source of truth
  - default freshness window = `24 hours`
  - manual refresh may bypass freshness with `forceRefresh=1`

## Backend Target

- `Debug` on a physical device should use the Mac-hosted local backend.
- `Staging` and `Release` currently target:
  - `https://spotlight-backend-grhsfspaia-uc.a.run.app/`
- Required Cloud Run env vars:
  - `POKEMONTCG_API_KEY`
  - `SCRYDEX_API_KEY`
  - `SCRYDEX_TEAM_ID`

## Tester Script

1. Launch the app and confirm the scanner opens without crashing.
2. Test at least 3 raw cards and 2 slabs from the smoke pack below.
3. For each scan, record:
   - matched card name
   - set and collector number
   - price value
   - price source label
   - whether the result was auto-accepted, review, or unsupported
4. If a scan fails, classify it as one of:
   - wrong match
   - right match, wrong price
   - unsupported but should have worked
   - correctly unsupported
   - slow scan
5. If manual refresh is used, note whether the price source/value changed.

## Known-Good Smoke Pack

See [internal-testflight-smoke-pack-2026-04-07.json](/Users/stephenchan/Code/spotlight/qa/internal-testflight-smoke-pack-2026-04-07.json).

Recommended first-pass cards:

- Raw:
  - Dark Weezing `14/82`
  - Pikachu VMAX `SWSH286`
  - Slowpoke `204/198`
  - Espeon Star `16/17`
- Slab:
  - Snorlax Legendary Collection PSA 10
  - Lugia Neo Genesis PSA 9
  - Lugia Neo Genesis PSA 10
  - Mewtwo Gold Star PSA 10
  - Pikachu ex Surging Sparks PSA 9

## Known Limitations For Internal TestFlight

- Japanese and custom-numbering support is not broad enough for general release.
- Some slabs may match correctly but still show no price if there is no slab snapshot and Scrydex does not return a live value for that card/grade.
- Unsupported/fake/custom cards should usually land in low-confidence review or unsupported states, but testers should still report any obviously wrong confident matches.
- The real-world regression pack is not fully green yet; current strength is modern/vintage English raw cards plus a subset of PSA slabs with known data coverage.
- Current known misses in the real-world pack include:
  - several correctly identified Latias & Latios slabs that still do not have pricing coverage
  - Charizard Skyridge slab matching without a price snapshot
  - a low-confidence Blastoise case photo that still lands below the desired confidence threshold
- Synthetic Scrydex-hosted raw identifier entries are filtered out of the bundled local identifier lookup to reduce fake-card false positives.

## Pricing Freshness

- The app may show the existing stored snapshot immediately.
- If the stored snapshot is older than `24 hours`, the backend refresh path should fetch live provider data and persist the result.
- Manual refresh may bypass the `24 hour` gate.
- Freshness should be interpreted as:
  - `Fresh` = newly refreshed or very recent snapshot
  - `Cached` = within freshness window
  - `Stale` = older snapshot still being shown because live refresh was unavailable

## Ops Checks

Run or inspect:

- `GET /api/v1/ops/provider-status`
- `GET /api/v1/ops/pricing-refresh-failures`
- `GET /api/v1/ops/unmatched-scans`
- `GET /api/v1/ops/cache-status`

What to confirm:

- raw provider = `pokemontcg_api`
- slab provider = `scrydex`
- slab lane is not surfacing raw proxy prices
- persisted snapshot ages look sane
- local/internal runtime is not silently matching synthetic Scrydex-hosted raw identifier entries

## Bug Report Template

- Card:
- Mode: `Raw` or `Slab`
- Expected:
- Actual:
- Price shown:
- Source label shown:
- Confidence / review state:
- Screenshot:
- Log snippet:
