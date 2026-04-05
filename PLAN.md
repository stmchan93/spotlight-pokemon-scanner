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
- PriceCharting restored as default active provider
- Scrydex available as fallback through the same shared layer
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

Status: `done`

- Explicit unsupported/review state exists in the app
- Source and freshness labels exist in tray rows
- Local fallback mode is visible in the UI
- Provider status, unmatched-scan reporting, and pricing-refresh failure reporting exist
- Real-world unsupported/fake regressions are green

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
  - analysis avg `719.0ms`, p95 `1015.7ms`
  - match avg `46.0ms`, p95 `171.1ms`
  - total avg `764.9ms`, p95 `1088.7ms`
- App install/launch was verified on the booted iPhone 17 simulator
- Human tap-through verification in the simulator/device is still outstanding

## Remaining tasks

1. Finish live source syncing for slab comps with real authenticated sources and production manifests.
2. Configure and validate provider credentials (PriceCharting API key, Scrydex credentials).
3. Do human tap-through verification for raw / PSA / unsupported flows on simulator or device.
4. Measure true in-app latency on a real device or fully interactive simulator session and compare it to the ship target.
5. Continue improving scanner quality and resolver accuracy on real-world photo sets.

## Immediate next best tasks

1. Configure PriceCharting API credentials for testing the default provider.
2. Validate live provider refresh with real credentials.
3. Run regression tests with the new provider architecture.
4. Do human tap-through verification for pricing flows on simulator or device.

## Full execution checklist

Use [scanner-v1-completion-checklist-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/scanner-v1-completion-checklist-2026-04-03.md) for the broader scanner track and [pricing-provider-abstraction-todos-2026-04-04.md](/Users/stephenchan/Code/spotlight/docs/pricing-provider-abstraction-todos-2026-04-04.md) for the next pricing-provider implementation pass.
