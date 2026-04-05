# PSA Grade Pricing Todos

Status: Active
Date: 2026-04-03

- [x] Add slab pricing schema tables.
- [x] Add PSA label grade parsing and slab context extraction.
- [x] Add slab price snapshot computation with tiers:
  - [x] exact same grade
  - [x] same-card grade ladder
  - [x] bucket index model
  - [x] raw fallback metadata
- [x] Add backend API support for grade-aware card detail and refresh.
- [x] Return slab pricing in scan-match results when available.
- [x] Add app models for slab context and pricing mode.
- [x] Surface slab pricing cleanly in tray rows.
- [x] Show `Raw proxy` only when slab pricing is unavailable.
- [x] Add unit tests for grade parsing, tier selection, and API payloads.
- [x] Update master status doc with PSA-grade pricing state and next steps.

## Still Next

- [ ] Add a real slab comp ingestion source instead of test-only fixture sales.
- [ ] Add cert-aware deduping and listing normalization for slab sales.
- [ ] Add grade-specific refresh jobs so slab values update when new comps land.
- [ ] Add clearer UI copy for `Exact`, `Modeled`, and `Raw proxy`.
