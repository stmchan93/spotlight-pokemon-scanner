# Inventory / Ledger / Portfolio Implementation Spec

Date: 2026-04-15

## Status

- This document is the source of truth for the next inventory / ledger / portfolio workstream.
- It is intentionally product-first and implementation-concrete.
- Current phase status:
  - Phase 0 product/model review: complete
  - Phase 1 schema/API implementation: not started
  - Phase 2 app ledger wiring: not started
  - Phase 3 portfolio chart: not started
- Current runtime reality:
  - inventory add + quantity + condition persistence is already real
  - inventory browsing/search/sort is already real
  - the current deal/ledger surfaces are still mostly mock UI
  - there is no real append-only ledger yet
  - there is no truthful historical holdings model yet

## Why This Exists

Looty is becoming two things at once:

1. a scan-first inventory tool
2. a sticky collector / seller app

That is a good direction, but only if the product model is clean.

Right now the codebase has a real inventory foundation:

- app collection state:
  - [Spotlight/App/AppContainer.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/AppContainer.swift)
- inventory / collection UI:
  - [Spotlight/Views/ScannerRootView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerRootView.swift)
- product detail + condition UI:
  - [Spotlight/Views/ScanResultDetailView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScanResultDetailView.swift)
- backend inventory persistence:
  - [backend/schema.sql](/Users/stephenchan/Code/spotlight/backend/schema.sql)
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
  - [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)

But the current deal / ledger layer is still mostly presentational:

- mock deal state and sample activity:
  - [Spotlight/Views/ScannerRootView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerRootView.swift)
- no append-only ledger table:
  - [backend/schema.sql](/Users/stephenchan/Code/spotlight/backend/schema.sql)
- no ledger mutation endpoint:
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)

The portfolio chart has a similar structural gap:

- the backend already stores daily card price history:
  - [backend/schema.sql](/Users/stephenchan/Code/spotlight/backend/schema.sql)
- but current holdings are only stored as a latest snapshot in `deck_entries`
- there is no append-only inventory ledger to reconstruct what the user owned on past dates

This spec exists to prevent two bad outcomes:

1. bolting on seller UI without real persistence
2. bolting on a chart that looks nice but lies

## Product Goal

The product should be inventory-first, with ledger fidelity and portfolio stickiness emerging naturally from history.

The intended user story is:

1. user scans a card
2. user confirms identity / checks the current value
3. user adds it to inventory
4. user optionally records a buy cost basis
5. user later records a sell or adjustment
6. user can later look back and understand:
   - what they currently own
   - what they sold
   - how their collection value changed over time

That means the main product concepts should be:

- inventory = what I currently own
- ledger = append-only history of buys, sells, and adjustments
- deals = the user-facing transaction records that make up the ledger
- portfolio = the historical market value of the inventory I owned at each point in time

The product should **not** start by mixing cash and cards into one confusing “net worth” graph.

## Terminology

Use these terms consistently.

### Inventory

- the current cards the user owns
- seller-first language, but the product is now inventory-first
- this should be the primary user-facing name for the existing deck/inventory surface

### Ledger

- append-only record of inventory-changing events
- source of truth for:
  - buys
  - sells
  - quantity changes
  - condition changes
  - future transfers or trades

### Deal

- one concrete user-entered transaction in the ledger
- usually a buy or sell
- may later include other transaction kinds, but MVP should stay simple

### Buy

- an acquisition into inventory
- should record quantity, unit cost, total cost, date, and optional note
- is the basis for future cost-basis and realized-profit work

### Sell

- a realized disposal of inventory for money
- should record quantity, sold price, sold date, payment method, and optional note
- should reduce inventory quantity from that point forward

### Cost Basis

- the acquisition cost of a card or position
- needed for realized profit and margin later
- not required to ship the first truthful inventory / ledger slice

### Portfolio

- a view over inventory history plus price history
- should mean:
  - “what was my collection worth on a given day?”
- not:
  - “how much cash plus cards plus trades plus untracked expenses do I have?”

## Scope

This spec covers:

- inventory data model
- real deal persistence
- append-only ledger foundation
- truthful daily collection-value chart design
- backend endpoints needed to support inventory, deals, and charting
- app routing and UX changes for inventory / ledger flows
- implementation order

This spec does not cover:

- pop report integration
- eBay comps as a primary data surface
- a single-square scanner mode
- social/followers/feed
- consignment workflows
- buyer CRM
- multi-user shared inventory
- live auction features
- advanced P&L / tax reporting
- multi-item trade accounting in the first shipping slice
- a cash + cards combined net worth chart in v1

If a link-out to an external comp source already exists and is trivial, keep it as a convenience action only. Do not make it part of the MVP contract.

## Product Constraints

- MVP should stay focused on inventory usefulness first.
- The product should not overload the user with analytics before the inventory / ledger loop is solid.
- Inventory must be real and persistent before seller/deal UI is expanded.
- The portfolio chart must be daily, not intraday.
- The main chart must represent collection value only.
- Selling a card should remove it from collection value from that point forward.
- Buy and sell proceeds should be tracked separately from collection value.
- Current SQLite data should remain the serving layer for inventory reads.
- Current price history should stay SQLite-backed and Scrydex-snapshot-backed.
- Ledger bookkeeping should not depend on runtime pricing refresh.

## Current Runtime Reality

### What is already real

Inventory persistence is already real:

- `deck_entries` table exists:
  - [backend/schema.sql](/Users/stephenchan/Code/spotlight/backend/schema.sql)
- add-to-inventory endpoint exists:
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
- condition update endpoint exists:
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
- inventory list endpoint exists:
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
- iOS collection store refreshes from backend:
  - [Spotlight/App/AppContainer.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/AppContainer.swift)
- the app already supports:
  - add to inventory
  - quantity display
  - condition tagging
  - inventory browsing
  - search
  - sort
  - detail-page navigation from inventory

### What is only partial or mock

The current deal / ledger layer is not real yet:

- the deal state is a local mock object:
  - `DealsMockState`
  - [Spotlight/Views/ScannerRootView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerRootView.swift)
- the deal sheet is a UI form only:
  - [Spotlight/Views/ScannerRootView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerRootView.swift)
- pressing `CONFIRM DEAL` currently just dismisses the sheet
- there is no backend ledger endpoint
- there is no inventory decrement-on-sell behavior
- there is no append-only holdings ledger
- there is no historical holdings reconstruction

### Why the chart cannot be truthful today

The backend currently knows:

- current holdings snapshot via `deck_entries`
- daily card price history via `card_price_history_daily`

But it does not know:

- when quantity changed historically
- when cards left inventory
- when a buy happened
- when a cost basis was assigned

So a truthful portfolio chart cannot exist until the backend can reconstruct:

- what the user owned on day N
- in what quantity
- under which condition / slab context
- with what acquisition cost, if known

## Core Product Decisions

### Decision 1: inventory-first mental model, collector-friendly payoff

The user-facing product should feel like:

- Scan
- Inventory
- Ledger

Portfolio value is a consequence of using the product, not the first job to be done.

### Decision 2: the main chart is “Collection value,” not “Net worth”

The portfolio chart should answer:

- “What was my collection worth over time?”

It should not answer:

- “What were my cards plus cash plus trade deltas worth over time?”

This avoids confusion and makes the chart honest.

### Decision 3: selling a card should make collection value go down

If a user sells a card:

- the card is no longer in inventory
- collection value should drop from that point forward

The user should see realized proceeds in the ledger, not inside the collection-value chart.

### Decision 4: buy and sell records are separate from collection value

The ledger should track:

- buys
- sells
- adjustments

The portfolio chart should derive only from what was owned at the time.

### Decision 5: append-only holdings history is required

Do not fake the chart by projecting current quantity backwards in time.

We need a ledger of inventory changes so the backend can rebuild holdings per day.

### Decision 6: keep `deck_entries` as the fast current snapshot

Do not throw away the existing snapshot table.

The right architecture is:

- `deck_entries` = fast current inventory read model
- `inventory_ledger_events` = append-only source of historical truth

### Decision 7: single-item deal logging ships before generalized trade accounting

The first shipping slice should support:

- buying one inventory card
- selling one inventory card
- optional quantity > 1 if inventory allows it
- optional cost basis

Do not block the first slice on a generalized trade engine.

### Decision 8: chart points are daily only

Use daily points because:

- price history is daily
- a daily chart is enough for the product need
- this matches the desired UX without false intraday precision

## MVP UX Definition

This is the smallest valuable inventory / ledger loop.

### Surface 1: Scan

Keep the current scanner-first experience.

After a scan:

- user can inspect detail
- user can add to inventory
- user can open trivial external links if they already exist

No major redesign is required for this spec.

### Surface 2: Inventory

Current “Deck” becomes the real inventory surface.

User can:

- search cards
- sort
- tap into detail
- see quantity
- see condition
- later sell from there

### Surface 3: Ledger

The ledger becomes the bookkeeping surface for:

- buys
- sells
- quantity changes
- condition changes

The ledger should be readable as a transaction history, not a show log.

### Surface 4: Product Detail

The detail page becomes the single source of truth for:

- pricing
- condition
- quantity
- buy action
- sell action
- optional external links

This should be the same detail route whether the user came from:

- scan tray
- alternatives
- inventory

### Surface 5: Portfolio Header Chart

This is the first meaningful portfolio view.

When idle:

- large current collection value
- range delta
- smooth line chart
- range pills:
  - `7D`
  - `30D`
  - `90D`
  - `ALL`

When scrubbing:

- value updates to the point under the finger
- date label updates
- highlighted point
- vertical guide line
- small haptic step between days

Below the chart:

- priced coverage text:
  - for example `12 priced cards, 3 excluded`
- separate ledger metric cards:
  - buys count
  - sells count
  - gross sold

## Proposed Data Model

### Keep: `deck_entries`

`deck_entries` stays the current inventory snapshot.

It should continue to answer:

- what does the user own now?
- in what quantity?
- under what condition / slab context?

### Change: `deck_entries.quantity` semantics

Current code effectively assumes quantity is always at least `1`.

That is fine for add-only inventory, but it breaks real selling.

We should change the semantics to:

- `quantity >= 0`
- `0` means:
  - known historical inventory position
  - currently not owned

This allows:

- preserving identity/history
- avoiding destructive deletion of historical rows
- keeping a stable key for linking events and sales

The app inventory list should later filter to:

- active entries with `quantity > 0`

### Add: `inventory_ledger_events`

This is the critical new ledger for truthful history.

Suggested schema:

- `id TEXT PRIMARY KEY`
- `deck_entry_id TEXT NOT NULL REFERENCES deck_entries(id)`
- `card_id TEXT NOT NULL REFERENCES cards(id)`
- `event_kind TEXT NOT NULL`
  - `buy`
  - `sell`
  - `adjustment`
  - `condition_update`
  - later:
    - `trade_in`
    - `trade_out`
- `quantity_delta INTEGER NOT NULL DEFAULT 0`
- `unit_cost REAL`
- `unit_price REAL`
- `currency_code TEXT`
- `payment_method TEXT`
- `condition TEXT`
- `grader TEXT`
- `grade TEXT`
- `cert_number TEXT`
- `variant_name TEXT`
- `source_scan_id TEXT`
- `source_confirmation_id TEXT`
- `note TEXT`
- `created_at TEXT NOT NULL`

Why this is needed:

- inventory history
- truthful charting
- transaction trail
- future cost-basis analysis

### Add: `sale_events`

This is optional if the ledger table above is used for every deal.

If retained separately, it should stay a derived, sale-only convenience table:

- `id TEXT PRIMARY KEY`
- `deck_entry_id TEXT NOT NULL REFERENCES deck_entries(id)`
- `card_id TEXT NOT NULL REFERENCES cards(id)`
- `quantity INTEGER NOT NULL`
- `currency_code TEXT NOT NULL`
- `unit_price REAL NOT NULL`
- `gross_total REAL NOT NULL`
- `payment_method TEXT`
- `sold_at TEXT NOT NULL`
- `condition TEXT`
- `grader TEXT`
- `grade TEXT`
- `cert_number TEXT`
- `variant_name TEXT`
- `market_price_at_sale REAL`
- `pricing_provider TEXT`
- `pricing_mode TEXT`
- `source_scan_id TEXT`
- `source_confirmation_id TEXT`
- `note TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Why this may still be useful:

- ledger queries become simpler
- seller analytics become straightforward

## Backend Behavior Changes

### 1. Adding inventory should emit a ledger event

When `POST /api/v1/deck/entries` succeeds:

- keep upserting `deck_entries`
- also append an `inventory_ledger_events` row with:
  - `event_kind = buy`
  - `quantity_delta = +N`
  - cost basis if supplied
  - condition/slab context snapshot
  - source scan metadata if present

### 2. Condition updates should emit a ledger event

When `POST /api/v1/deck/entries/condition` succeeds:

- update the current snapshot
- append an `inventory_ledger_events` row:
  - `event_kind = condition_update`
  - `quantity_delta = 0`
  - `condition = new condition`

Condition changes should affect chart valuation from that day forward.

### 3. Selling should be a real backend mutation

Add a real sell mutation:

- `POST /api/v1/deals/sell`

Payload should include:

- `cardID`
- `slabContext`
- `quantity`
- `unitPrice`
- `paymentMethod`
- `soldAt`
- `note`
- optional scan/selection provenance
- optional cost basis if known

Server behavior:

1. resolve `deck_entry_id`
2. ensure current quantity is sufficient
3. create a ledger row
4. decrement `deck_entries.quantity`
5. commit transaction atomically

### 4. Inventory reads should default to active positions

Current `GET /api/v1/deck/entries` can later support:

- `includeInactive=false` default
- `includeInactive=true` optional for history/admin use

For MVP:

- inventory UI should only show `quantity > 0`

### 5. Portfolio history needs one server-side aggregation endpoint

Add:

- `GET /api/v1/inventory/history?range=30D`

Response should include:

- `range`
- `currentValue`
- `startValue`
- `deltaValue`
- `deltaPercent`
- `points`
  - `date`
  - `totalValue`
  - `pricedCardCount`
  - `excludedCardCount`
- `coverage`

Do not build this as N separate client history calls.

## Portfolio Chart Aggregation Rules

The chart must be honest.

### Daily valuation rule

For each day in the requested range:

1. reconstruct inventory quantity per deck entry as of end-of-day using `inventory_ledger_events`
2. ignore entries whose quantity is `<= 0`
3. determine the effective valuation context:
   - raw:
     - current/effective condition as of that date
   - slab:
     - grader / grade / variant context
4. read the latest available price on or before that date from `card_price_history_daily`
5. if daily history is missing for that day, use the last earlier known point
6. if no usable history exists for that card/context, exclude it from that day’s priced total
7. sum the priced positions

### Current-day value rule

For the latest point:

- prefer the freshest current snapshot / pricing detail already served by the backend
- but keep the returned series daily

### Coverage rule

Always tell the truth about what is priced vs excluded.

Examples:

- `12 priced cards, 3 excluded`
- `9 active positions priced, 1 missing`

Do not silently include guessed values for cards with no price history.

### Sell impact rule

If a card is sold on day D:

- quantity after the sale should be reduced from day D onward
- if the sale zeroes out the position, collection value should no longer include that card from that point forward

### Buy / cost-basis rule

If a card is bought on day D:

- quantity should be added from day D onward
- later cost-basis and realized-profit features should be able to read the recorded buy amount

## Ledger Metrics Rules

The ledger layer should have honest, minimal metrics in v1.

### Metrics we can support cleanly in v1

- gross sold
- cards sold
- average sale price
- buys count
- sells count

### Metrics we should delay unless cost basis exists

- realized profit
- ROI
- margin

Those require acquisition cost / buy ledger fidelity.

### Optional v1.5 metric

If market price at sale is recorded:

- `sold above market`
- `sold below market`

This is easier than true profit and still useful to vendors.

## App UX Changes

### Inventory tab naming

The underlying data model can keep existing `deck` naming temporarily, but the product should increasingly speak in inventory-first language:

- preferred user-facing tab label:
  - `Inventory`

### Detail page actions

The detail page should become the main inventory-management surface.

For a card already in inventory:

- show quantity
- show condition
- show buy action
- show sell action

For a card not yet in inventory:

- show add action

### Deal flow

Current deal UI should keep roughly its existing shape, but change behavior:

- same sheet or slightly refined sheet
- real network mutation
- optimistic update allowed only if backend-backed refresh follows

Success result:

- quantity decremented or incremented in inventory
- ledger updated
- inventory summary updated
- detail page reflects new quantity

### Portfolio header chart

This should sit at the top of the inventory screen, above `All cards`.

Design intent:

- premium, calm, dark
- line chart with subtle fill
- large value label
- daily scrub
- range pills

When not scrubbing:

- show current collection value
- show delta over selected range

When scrubbing:

- replace the headline value with the point value
- show exact day label
- animate the guide line and point

## API Contract Sketch

### `POST /api/v1/deals/sell`

Request:

- `cardID`
- `slabContext`
- `quantity`
- `unitPrice`
- `currencyCode`
- `paymentMethod`
- `soldAt`
- `note`
- `sourceScanID`
- `sourceConfirmationID`

Response:

- `dealID`
- `deckEntryID`
- `remainingQuantity`
- `grossTotal`
- `soldAt`

### `POST /api/v1/deals/buy`

Request:

- `cardID`
- `slabContext`
- `quantity`
- `unitCost`
- `currencyCode`
- `boughtAt`
- `note`
- `sourceScanID`
- `sourceConfirmationID`

Response:

- `dealID`
- `deckEntryID`
- `quantity`
- `boughtAt`

### `GET /api/v1/inventory/history`

Query:

- `range=7D|30D|90D|ALL`

Response:

- `range`
- `currentValue`
- `startValue`
- `deltaValue`
- `deltaPercent`
- `coverage`
- `points[]`

## Smallest Viable Shipping Slice

This is the smallest slice that makes inventory + ledger real and keeps the portfolio chart on honest footing.

### Phase 1: inventory and ledger data foundation

1. add `inventory_ledger_events`
2. optionally add `sale_events` if a separate sale convenience table is still useful
3. make add-to-inventory emit `buy` events
4. make condition updates emit `condition_update` events

### Phase 2: real deal flow

1. add `POST /api/v1/deals/sell`
2. add `POST /api/v1/deals/buy`
3. wire the current deal UI to call them
4. decrement or increment inventory quantity
5. replace mock deal activity with backend reads when possible

### Phase 3: truthful portfolio chart

1. add `GET /api/v1/inventory/history`
2. implement daily holdings reconstruction from `inventory_ledger_events`
3. build chart UI in the inventory header
4. add scrub interaction

### Phase 4: optional convenience polish

1. keep trivial external link-outs if already present
2. add lightweight note / filter / sort polish
3. defer any nonessential comparison or report surfaces

## Implementation Order

The order matters.

### Step 1

Backend schema and persistence first.

Do not add more inventory or ledger UI before:

- buys are real
- sells are real
- history is reconstructable

### Step 2

Wire the current deal UI to real endpoints.

This gives immediate user value with minimal redesign.

### Step 3

Build the chart after the ledger exists.

Do not build the chart first.

### Step 4

Replace mock deal state only after ledger persistence exists.

## Migration Notes

### Existing inventory rows

Current `deck_entries` rows should remain valid.

Migration should:

- keep current entries
- create no-op / inferred initial `buy` events for existing rows if necessary
- use `added_at` as the first-known ownership timestamp

This will not perfectly recover historical truth for pre-ledger entries, but it is acceptable.

### Existing app model names

Current code uses:

- `DeckView`
- `DeckCardEntry`
- `/api/v1/deck/entries`

We do not need a big rename before shipping the ledger backend.

Recommended approach:

- keep backend/internal names stable for now
- evolve user-facing copy toward `Inventory` and `Ledger`

## Validation Requirements

### Backend tests

Add tests for:

- creating a buy increments quantity
- selling the final copy results in quantity `0`
- insufficient quantity rejects
- add-to-inventory emits event
- condition update emits event
- history aggregation respects sell dates
- history aggregation respects buy dates
- history aggregation respects condition-change dates

### App tests

Add tests for:

- deal sheet confirm actually triggers backend mutation
- inventory quantity updates after sell or buy
- selling from detail and selling from inventory use the same backend flow
- portfolio chart scrubbing updates value/date text
- inventory view hides quantity `0` entries by default

### Manual QA

Manual checks:

1. scan card
2. add to inventory
3. set condition
4. buy or sell quantity `1`
5. verify inventory changed correctly
6. verify ledger entry appears
7. verify chart later reflects the owned position correctly

## Risks and Tradeoffs

### Risk 1: chart correctness vs speed

Server-side daily replay can become expensive if done naively.

Mitigation:

- keep the range bounded
- use indexed event reads
- consider later materialized daily portfolio snapshots if needed

### Risk 2: pre-ledger entries have imperfect history

Old entries will not have full historical acquisition detail.

Mitigation:

- seed initial buy events from `added_at`
- accept that pre-ledger historical fidelity is approximate

### Risk 3: quantity `0` semantics touch multiple read paths

Current app/backend code often assumes `quantity >= 1`.

Mitigation:

- explicitly update all quantity read/formatting code
- add focused tests around zero-quantity filtering

### Risk 4: terminology drift

The product already had “show” language in older planning notes.

Mitigation:

- keep “ledger” for bookkeeping history
- keep “deal” for the user-visible transaction record
- avoid reintroducing “show” as a primary product concept

## Non-Goals for the First Shipping Slice

Do not do these before real buys, sells, and truthful history land:

- pop report integration
- eBay comps as a core surface
- a single-square scanner
- combined cash + cards net worth chart
- generalized multi-card trade ledger
- realized profit / ROI without cost basis
- social portfolio features
- over-designed analytics screens

## Final Product Read

The right product stack is:

1. inventory is the source of truth for what the user owns now
2. ledger is the source of truth for what the user bought, sold, or adjusted
3. the portfolio chart is derived from holdings history plus daily price history

That gives Looty the right long-term shape:

- useful at a scan bench today
- sticky as a collector / seller portfolio later
- honest in the chart
- not overloaded for MVP
