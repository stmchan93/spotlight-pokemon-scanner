# Slab Recent Sales MVP Spec

Date: 2026-05-03

## Status

- This document is the source of truth for the first shipped slab recent-sales experience.
- It is scoped to the MVP only.
- Current phase status:
  - Phase 0 product decision: complete
  - Phase 1 backend cache + endpoint design: not started
  - Phase 2 app detail-screen integration: not started
  - Phase 3 polish + QA: not started

## Why This Exists

The current slab detail experience is not showing the right market signal.

Current runtime reality:

- the backend eBay comps endpoint returns active listings only, not sold comps:
  - [backend/README.md](/Users/stephenchan/Code/spotlight/backend/README.md:254)
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py:6876)
- the React Native slab detail screen is labeled around active eBay listings:
  - [apps/spotlight-rn/src/features/cards/screens/card-detail-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/cards/screens/card-detail-screen.tsx:1138)
- Scrydex provides sold listing / recent-sales data through the Pokémon listings endpoint:
  - `GET /pokemon/v1/cards/<card_id>/listings`
  - docs: https://scrydex.com/docs/pokemon/listings

The product need is to keep slab sellers inside the app with a trustworthy recent-sales view, without blowing through Scrydex credits during MVP.

## Product Goal

Show recent eBay sold sales for PSA slabs inside the slab detail screen.

The experience should feel:

- immediate when data is already cached
- clear about freshness
- safe on Scrydex credit usage
- premium enough that users do not need to leave the app for a normal slab pricing check

The MVP should not pretend to be a live streaming market feed.

## MVP Product Decisions

### Core decisions

- MVP is slab-detail only.
- MVP is PSA slab only.
- MVP uses Scrydex recent eBay sold sales, not the current eBay Browse active listings feed.
- MVP stores fetched recent-sales rows in local SQLite cache.
- MVP does not run a nightly full-catalog listings sync.
- MVP does not run an all-show-active slab nightly listings sync.
- MVP fetches recent sales on demand from the slab detail screen.
- MVP always shows freshness age in hours when cached recent sales exist.
- MVP only shows a `Refresh` action when cached sales are at least `24h` old.

### Naming decisions

- User-facing label should be `Recent Sales`.
- Missing-state CTA should be `Load recent eBay sales`.
- Freshness copy should use hours:
  - `Updated 6h ago`
  - `Updated 27h ago`
- Do not use vague copy such as:
  - `Updated recently`
  - `Updated yesterday`

### What MVP explicitly avoids

- raw-card recent sales
- non-PSA slab recent sales
- automatic live fetch on every slab detail open
- nightly listings refresh across all cards
- nightly listings refresh across all vendor-owned slabs
- hidden refresh behavior with no visible freshness label
- multiple marketplace sources in the same section
- complex hot / warm / cold prefetch policies

## Current Runtime Reality

### What is already real

- card detail exists in the React Native app:
  - [apps/spotlight-rn/src/features/cards/screens/card-detail-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/cards/screens/card-detail-screen.tsx)
- the API client already performs a separate detail-side market request:
  - [packages/api-client/src/spotlight/repository.ts](/Users/stephenchan/Code/spotlight/packages/api-client/src/spotlight/repository.ts:2670)
- the backend already has card detail and market-history paths:
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
- SQLite already stores:
  - card snapshots
  - daily price history
  - user inventory / sale ledger

### What is not good enough yet

- current eBay comps are active listings, not sold recent sales
- current slab detail market section is conceptually the wrong data source for sold comps
- there is no recent-sales cache table in SQLite
- there is no dedicated backend recent-sales endpoint for slab detail
- there is no freshness / refresh UI contract for recent sales

## MVP User Flow

### Entry point

The feature starts from the slab detail screen only.

### Primary flow

1. User opens a slab detail screen.
2. The normal slab detail pricing surface loads as it does today.
3. The app renders a `Recent Sales` section.
4. The app checks whether cached recent eBay sales exist for the slab context.
5. The slab context is effectively keyed by:
   - `card_id`
   - `grader`
   - `grade`
   - `source = ebay`
6. The section behaves according to one of the states below.

## MVP UI States

### State A: Cached recent sales exist and are less than 24 hours old

The app should:

- render the cached recent-sales rows immediately
- show freshness copy in hours:
  - `Updated 6h ago`
- not show a `Refresh` action

Reason:

- the cache is considered fresh enough for MVP
- showing refresh early invites unnecessary credit spend

### State B: Cached recent sales exist and are 24 hours old or older

The app should:

- render the cached recent-sales rows immediately
- show freshness copy in hours:
  - `Updated 31h ago`
- show a `Refresh` action

Reason:

- the user still gets instant data
- the app stays honest about age
- the user can explicitly request a newer read when it matters

### State C: No cached recent sales exist

The app should:

- render the `Recent Sales` section shell
- show a lightweight CTA:
  - `Load recent eBay sales`
- not auto-fetch simply because the detail screen opened

Reason:

- protects Scrydex credits during MVP
- keeps cost tied to explicit demand

### State D: Recent sales were requested and none were found

The app should:

- show an unavailable / empty state inside `Recent Sales`
- keep the section visible
- show freshness age once the empty result is cached

Suggested copy:

- title:
  - `Recent eBay sales unavailable`
- supporting copy:
  - `No recent sold sales were returned for this slab.`

## Recent Sales Row Content

Each row should show:

- sale price
- sold date
- listing title
- tap-through to original eBay URL if present

The section does not need advanced charting in MVP.

## MVP Backend Behavior

### Cache-first contract

The backend should:

1. check SQLite for cached recent sales for the slab context
2. return cached rows immediately when present
3. only fetch Scrydex when:
   - there is no cache and the user explicitly requested load
   - or cached rows are at least 24 hours old and the user explicitly requested refresh

### Refresh rule

- cached age `< 24h`
  - serve cache
  - no refresh CTA in UI
- cached age `>= 24h`
  - serve cache
  - allow refresh CTA in UI
- no cache
  - require explicit load

### Negative caching

If Scrydex returns no recent sales:

- persist that empty result
- persist the fetch timestamp
- do not immediately retry on every detail open

Recommended MVP negative-cache window:

- `48h`

## Database Requirements

MVP requires a new recent-sales cache table.

This data should not be shoved into:

- `sale_events`
  - user-owned transaction ledger
- `card_price_history_daily`
  - aggregated price history, not per-sale market rows

The recent-sales cache must support:

- slab context lookup
- persisted fetched timestamp
- multiple sale rows per slab context
- persisted empty/unavailable result state

The exact final schema is implementation detail, but the product behavior requires:

- context key
- sale rows
- fetched timestamp
- empty/unavailable status support

## API Requirements

MVP requires a dedicated recent-sales API contract.

Example shape:

```text
GET /api/v1/cards/<card_id>/recent-sales?source=ebay&grader=PSA&grade=9&limit=5
```

Behavior:

- returns cached rows when available
- may fetch Scrydex when explicitly requested by the app under the MVP rules above
- returns freshness metadata needed for:
  - `Updated Xh ago`
  - `Refresh`
  - `Load recent eBay sales`

The endpoint does not need to be merged into the general pricing endpoint for MVP.

## Why This Is The MVP

This approach gives:

- correct sold-sales data source for slabs
- in-app slab pricing support
- explicit freshness trust signals
- bounded Scrydex usage
- no full-catalog listings sync
- no broad nightly slab listings sync

It also generates the usage data needed to decide later whether a nightly hot-set prewarm is actually justified.

## Out Of Scope For MVP

- nightly hot-slab prewarm
- show-active slab recent-sales sync
- demand-scored hot / warm / cold refresh logic
- non-PSA slabs
- raw-card recent sales
- live background refresh on every detail open
- portfolio-wide or inventory-grid recent-sales embeds

## Success Criteria

MVP is successful if:

- slab detail can show recent eBay sold sales from Scrydex
- cached sales render immediately when available
- missing sales do not auto-burn credits on every detail open
- freshness is visible in hours
- refresh is only offered once cached data is at least 24 hours old
- users can stay inside the app for normal slab recent-sales checks

## Follow-Up After MVP

Only after real usage data exists should the app consider:

- nightly prewarm for a small hot slab set
- show-active slab prewarm
- broader refresh-tier policies
- richer recent-sales charting or insights
