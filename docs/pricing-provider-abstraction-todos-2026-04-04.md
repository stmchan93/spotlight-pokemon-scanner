# Pricing Provider Abstraction Todos

Date: 2026-04-04

## Phase 1: Shared Backend Layer

- [ ] Create a shared pricing provider contract
- [ ] Create a provider registry
- [ ] Make provider priority configurable
- [ ] Refactor backend refresh endpoints to use the registry

## Phase 2: Restore PriceCharting For Testing

- [ ] Re-add `backend/pricecharting_adapter.py`
- [ ] Implement raw-card refresh in the shared provider contract
- [ ] Implement PSA refresh in the shared provider contract
- [ ] Make `PriceCharting` the default active provider for both raw and PSA

## Phase 3: Keep Scrydex Side By Side

- [ ] Refactor `backend/scrydex_adapter.py` to use the shared provider contract
- [ ] Keep Scrydex available as fallback/provider option
- [ ] Expose provider readiness and priority order in ops status

## Phase 4: UI And Data Presentation

- [ ] Make app/provider labels fully provider-agnostic
- [ ] Keep tray UI on one active/default provider value
- [ ] Preserve source/freshness labels
- [ ] Prepare detail-path data model for future side-by-side provider display

## Phase 5: Fallback Rules

- [ ] Raw fallback order:
  - `pricecharting`
  - `scrydex`
  - imported snapshot
- [ ] PSA fallback order:
  - `pricecharting`
  - `scrydex`
  - local slab-comp model
  - raw proxy

## Phase 6: Tests

- [ ] Add tests for provider registry fallback order
- [ ] Add tests for PriceCharting raw refresh
- [ ] Add tests for PriceCharting PSA refresh
- [ ] Add tests for Scrydex through the shared provider layer
- [ ] Add tests for provider status/readiness payloads
- [ ] Re-run backend tests, tray tests, clean regression, real-world regression, and iOS build

## Phase 7: Docs

- [ ] Update master status doc
- [ ] Update backend README
- [ ] Update AGENTS.md
- [ ] Update PLAN.md
- [ ] Update SESSION_REPORT.md after implementation
