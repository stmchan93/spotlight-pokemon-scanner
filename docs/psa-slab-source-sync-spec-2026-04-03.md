# PSA Slab Source Sync Spec

Status: Active
Date: 2026-04-03

## Goal

Move PSA pricing from fixture-only inputs to a real source-ingestion path.

The first real source for PSA slabs should be:

- `PSA Auction Prices Realized`

Why:

- it is official PSA slab sales data
- it is already organized around slab sales rather than raw cards
- it fits the Card Ladder-style pricing model much better than raw-card sources

## Source Strategy

### Primary Source: `psa_apr_html`

The repo should support a manifest-driven source adapter for PSA Auction Prices pages.

Each source entry defines:

- `provider`
- `cardID`
- `grader`
- `url` or `filePath`
- optional `headerEnvs`

The adapter should:

1. fetch HTML from a URL or local fixture/export
2. parse sale rows into normalized `slab_sales`
3. import those sales through the shared slab-ingestion pipeline
4. recompute all affected PSA snapshots

### Why not eBay first

We are not using eBay as the first production adapter in this repo because:

- the old Finding API sold-listings path is deprecated
- broader sold-market data access is more constrained
- PSA Auction Prices is more directly aligned to PSA slab pricing

The ingestion layer remains provider-agnostic, so additional sources can be added later.

## Manifest Shape

```json
{
  "sources": [
    {
      "id": "neo1-9-psa-apr",
      "provider": "psa_apr_html",
      "cardID": "neo1-9",
      "grader": "PSA",
      "url": "https://www.psacard.com/auctionprices/...",
      "headerEnvs": {
        "Cookie": "PSA_APR_COOKIE"
      }
    }
  ]
}
```

## Sync Behavior

### Run Once

- fetch source
- parse sales
- import/dedupe
- recompute affected snapshots
- write sync status

### Scheduled Mode

The repo should support a watch mode:

- poll sources every `N` seconds
- import new sales
- recompute snapshots immediately when new sales land

This is server-side update scheduling, not mobile push notifications.

## State Tracking

Each sync run should persist a JSON state payload containing:

- `updatedAt`
- source status
- inserted count
- duplicate count
- errors

This keeps the first implementation easy to inspect and test.

## Pricing Update Behavior

When new slab sales are imported:

1. update `slab_sales`
2. recompute `slab_price_snapshots`
3. card detail/refresh endpoints immediately begin returning the new PSA snapshot

The app still pulls updated values through its normal refresh path.

## Initial Scope

Implement now:

- `psa_apr_html` adapter
- manifest-driven sync runner
- watch mode scheduler
- sync state file
- deterministic fixture-based tests

Do later:

- additional providers
- cert-aware cross-source merge logic
- push notifications or server-sent update streams
