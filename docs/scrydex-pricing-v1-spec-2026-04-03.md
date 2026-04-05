# Scrydex Pricing V1 Spec

Date: 2026-04-03

This doc defines the active pricing path for scanner v1.

## Goal

Use `Scrydex` as the active pricing provider for:

- raw singles
- PSA slabs

Keep the existing local SQLite snapshot model, but refresh card pricing from Scrydex when credentials are configured.

## Provider Rules

- `Raw cards`
  - refresh from Scrydex card endpoint with `include=prices`
  - choose the best matching raw price record for the preferred variant
- `PSA slabs`
  - refresh from Scrydex card endpoint with `include=prices`
  - choose the exact `company=PSA` + `grade=<n>` price record
- `Fallback`
  - if Scrydex returns nothing for a raw card, keep the existing cached/raw import path
  - if Scrydex returns nothing for a PSA slab, fall back to the existing local slab-comp model

## Environment

- `SCRYDEX_API_KEY`
- `SCRYDEX_TEAM_ID`
- optional: `SCRYDEX_BASE_URL`

## Runtime Contract

`POST /api/v1/cards/<card_id>/refresh-pricing`

- raw cards:
  - try Scrydex raw refresh first
  - if it succeeds, write `card_price_summaries.source = scrydex`
- PSA slabs:
  - try Scrydex PSA refresh first
  - if it succeeds, write `slab_price_snapshots.source = scrydex`

## Data Expectations

Raw summary:

- `source = scrydex`
- `pricingMode = raw_snapshot`
- `low / market / mid / high`
- `variant`

PSA summary:

- `source = scrydex`
- `pricingMode = psa_grade_estimate`
- `pricingTier = scrydex_exact_grade`
- exact grade fields from Scrydex graded pricing

## UI Expectations

- raw rows should show `Scrydex` as source after refresh
- PSA rows should show `Scrydex PSA`
- legacy provider labels are no longer the active runtime path
