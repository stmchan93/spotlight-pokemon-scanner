# Manual Card Search V1 Spec

Date: 2026-04-20

## Status

- This document is the source of truth for the first manual metadata-search add flow.
- It is scoped to the first shipping slice only.
- Current phase status:
  - Phase 0 product review: complete
  - Phase 1 backend search rewrite: not started
  - Phase 2 app manual search flow: not started
  - Phase 3 polish and QA: not started
- Current runtime reality:
  - inventory add and buy flows are already real
  - portfolio inventory browsing/search/sort is already real
  - a card search endpoint already exists, but it is not production-grade for primary user entry
  - scanner-side manual search fallback already exists, but it is scoped to scan correction rather than inventory-first add

## Why This Exists

Scanner-first remains the main product behavior, but it is not enough.

Users still need to add cards when:

- the card is not in front of them
- they bought a stack and want to backfill later
- they know the card and want to enter it faster than scanning
- scan quality is poor and they would rather type than retake

Right now the repo has almost everything needed except the dedicated flow:

- portfolio and inventory state:
  - [Spotlight/App/AppContainer.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/AppContainer.swift)
- portfolio inventory UI:
  - [Spotlight/Views/PortfolioView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/PortfolioView.swift)
- shared card detail surface:
  - [Spotlight/Views/ScanResultDetailView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScanResultDetailView.swift)
- buy/add sheet:
  - [Spotlight/Views/ShowsView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ShowsView.swift)
- backend card detail and inventory endpoints:
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
  - [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)
  - [backend/schema.sql](/Users/stephenchan/Code/spotlight/backend/schema.sql)

The gap is that there is no inventory-first typed search flow that feels deliberate, fast, and native to the portfolio tab.

## Product Goal

Allow a user to search for a raw Pokemon card by typed metadata and add it to inventory without scanning.

The flow should feel:

- portfolio-first
- fast enough for dealer use
- lightweight and high-signal
- consistent with the existing inventory and buy semantics

The flow should not create a second ownership model or invent a second add-to-collection contract.

## V1 Product Decisions

### Core decisions

- V1 is raw-card only.
- V1 starts from the portfolio surface, not from the scanner.
- V1 uses one freeform query field, not an advanced filter form.
- V1 selection opens the existing shared detail view.
- V1 add uses the existing buy/add sheet, not a new inline quick-add model.
- V1 search is local-catalog-only and SQLite-backed.
- V1 does not create scan events, scan confirmations, or scan artifacts.

### Naming decisions

- User-facing language should stay inventory / collection first.
- Backend/runtime table names such as `deck_entries` can stay unchanged.
- The feature should be described internally as `manual card search`, not `manual deck search`, because the current product language is no longer deck-first.

### What V1 explicitly avoids

- slab / graded manual search
- advanced structured filters in the first release
- bulk multi-add workflows
- set-browser grid UI
- hidden live Scrydex search requests
- remote import fallback during a normal search session
- scanner-state coupling for portfolio search

## Current Runtime Reality

### What is already real

- the app already supports inventory detail navigation from portfolio:
  - [Spotlight/App/SpotlightApp.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/SpotlightApp.swift)
  - [Spotlight/ViewModels/ScannerViewModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift)
- the app already supports a buy/add sheet from card detail:
  - [Spotlight/Views/ScanResultDetailView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScanResultDetailView.swift)
  - [Spotlight/Views/ShowsView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ShowsView.swift)
- the app already supports card search through the shared matcher service:
  - [Spotlight/Services/CardMatchingService.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardMatchingService.swift)
- the backend already exposes:
  - `GET /api/v1/cards/search`
  - `GET /api/v1/cards/<card_id>`
  - `POST /api/v1/portfolio/buys`

### What is not good enough yet

The existing backend card search is not acceptable as the primary manual-add flow.

Current search implementation:

- endpoint:
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
- search function:
  - [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)

Current behavior:

- loads candidate rows into Python
- computes token overlap in-process
- does not use the indexed alias table as the main retrieval path
- is acceptable for small fallback use but not for portfolio-first typeahead

Current measured local runtime on the active SQLite snapshot:

- `cards` rows: about `43,991`
- `card_name_aliases` rows: about `108,522`
- current `search_cards(...)` latency on common queries: about `3.8s - 4.1s`
- indexed prefix probes on alias / set / number fields: sub-`5ms` in quick spot checks

That means V1 should reuse the endpoint path, but not the current implementation.

## V1 User Flow

### Entry points

Required entry points:

- portfolio header CTA
- portfolio empty-state CTA

Optional if trivial during implementation:

- inventory browser top-bar CTA

V1 should not add a new top-level tab for manual search.

### Primary flow

1. User opens Portfolio.
2. User taps `Add Card`.
3. App presents a dedicated manual search sheet or full-screen search surface.
4. User types one query such as:
   - `charizard base set`
   - `pikachu svp`
   - `gardevoir ex 245`
   - `151 mew`
5. App shows ranked search results.
6. User taps a result.
7. App opens the shared detail overlay using an ephemeral preview inventory entry.
8. User taps `Add to Collection`.
9. Existing buy/add sheet appears.
10. User confirms quantity, condition, and optional buy price.
11. App records the buy using the existing portfolio buy endpoint.
12. Portfolio refreshes and the card appears in inventory.

### Search result row content

Each result row should show:

- artwork thumbnail
- card name
- set name
- card number
- language
- optional cached price if already present locally
- optional owned-quantity pill if the user already has that card in inventory

V1 should not show an inline plus button in the search results list.

Reason:

- the current product already has an add sheet with quantity / condition / cost-basis semantics
- bypassing that would create two competing add contracts
- selection should emphasize correct identity first, then add semantics

### Empty and loading states

The manual search surface should support:

- idle state:
  - short helper copy such as `Search by name, set, or number`
- loading state:
  - visible spinner / skeleton during debounced fetch
- no-results state:
  - copy such as `No cards match that search`
- failure state:
  - copy such as `Search unavailable right now`

## Product Constraints

- Search must stay local-catalog-first and SQLite-backed.
- Search must not silently hit live Scrydex search endpoints.
- Search must not auto-import missing cards from remote providers.
- Search must not create scan telemetry rows.
- Search must preserve the existing inventory / buy semantics.
- Scanner correction search may reuse the same endpoint, but portfolio manual add is the primary V1 surface.
- The user should never need to understand provider lanes, set-badge logic, or OCR state to use this feature.

## V1 Scope

This spec covers:

- portfolio-first manual card search UX
- backend search contract for typed metadata search
- app wiring into shared detail and buy/add flows
- ranking rules for the first search implementation
- QA and acceptance criteria for the first shipping slice

This spec does not cover:

- slab search
- grading filters
- advanced filter chips
- collection import from CSV
- batch add by pasted list
- remote provider search fallback
- public marketplace browsing as part of the add flow
- search analytics dashboarding

## Search Behavior

### Query model

V1 uses one query string.

Supported user intent inside that single field:

- card name
- set name
- set code
- collector number
- mixed name + set
- mixed name + number

Examples:

- `charizard`
- `base set charizard`
- `svp pikachu`
- `151 mew`
- `gardevoir ex 245`

### App-side interaction rules

- trim leading and trailing whitespace
- debounce requests by about `250-300ms`
- do not auto-search empty input
- prefer a `2` character minimum for automatic requests
- pressing search / return may still submit a shorter exact query if needed
- replace results on every completed query; do not append pages in V1

### Backend ranking rules

The ranking rules should prefer identity confidence over broad fuzzy recall.

Target ranking order:

1. exact alias / exact canonical name match
2. alias / canonical name prefix match
3. strong name token overlap plus exact set match
4. strong name token overlap plus exact collector-number match
5. exact collector number plus set hint
6. broader token overlap fallback

Additional ranking behavior:

- exact collector-number matches should get a strong bonus
- exact set-code matches should get a strong bonus
- set-name prefix matches should outrank broad set contains matches
- de-prioritize `tcgp-*` digital-card style entries for raw physical search
- stable tie-breakers should fall back to:
  - score descending
  - name ascending
  - number ascending

### Local-only rule

Manual catalog search must be local only in V1.

That means:

- no `search_remote_scrydex_raw_candidates(...)`
- no automatic `import_catalog_card(...)`
- no hidden live pricing refresh during normal result retrieval

If a card is missing from local SQLite, V1 should simply return no result.

## Backend Contract

### Endpoint

Keep the existing endpoint path:

- `GET /api/v1/cards/search`

### Query params

Required:

- `q`

Optional:

- `limit`

V1 behavior:

- default `limit = 20`
- max `limit = 50`

### Response shape

V1 should remain backward-compatible with the current app contract.

Minimum response:

```json
{
  "results": [
    {
      "id": "scrydex:...",
      "name": "Charizard",
      "setName": "Base Set",
      "number": "4/102",
      "rarity": "Holo Rare",
      "variant": "Unlimited",
      "language": "English",
      "imageSmallURL": "https://...",
      "imageLargeURL": "https://...",
      "pricing": null
    }
  ]
}
```

Allowed additive fields:

- `query`
- `limit`
- `hasMore`

The first app slice does not require pagination support.

### Result payload rules

- return `CardCandidate`-compatible payloads
- pricing may be omitted or cached-only
- do not refresh pricing live during search
- do not require `CardDetail` hydration to open a result

### Implementation direction

Replace the current Python full-table scan with indexed SQL retrieval centered on:

- `card_name_aliases.normalized_alias`
- `cards.name`
- `cards.number`
- `cards.set_name`
- `cards.set_id`
- `cards.set_ptcgo_code`

Suggested search implementation shape:

1. normalize query
2. derive lightweight token groups:
   - text tokens
   - candidate collector-number token
   - candidate set-code token
3. fetch candidate IDs from indexed tables using:
   - exact alias
   - alias prefix
   - exact number
   - exact set code
   - set-name prefix
4. union and dedupe candidate IDs
5. score a bounded candidate pool in Python
6. return the top `limit`

The important rule is not the exact SQL form.

The important rule is:

- SQL narrows the pool fast
- Python scoring only handles a bounded shortlist
- the endpoint becomes suitable for typeahead use

## App Architecture

### New app surface

Create a dedicated manual-search presentation surface in the portfolio lane.

Recommended file shape:

- new search view:
  - `Spotlight/Views/ManualCardSearchView.swift`
- new focused view model:
  - `Spotlight/ViewModels/ManualCardSearchViewModel.swift`

Do not reuse:

- `ScannerViewModel.searchQuery`
- `ScannerViewModel.searchResults`

Reason:

- that state is coupled to scanner alternatives and route transitions
- portfolio manual add deserves its own lifecycle and debounce behavior

### Service reuse

The new manual-search view model should reuse:

- [Spotlight/Services/CardMatchingService.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardMatchingService.swift)

Recommended service update:

- allow `search(query:limit:)`

The app can preserve a convenience overload if desired, but the manual search surface should be able to request a deliberate result count.

### Detail handoff

When the user taps a search result:

- create an ephemeral preview entry via:
  - [CollectionStore.previewEntry(...)](/Users/stephenchan/Code/spotlight/Spotlight/App/AppContainer.swift)
- route to the shared detail overlay via:
  - [ScannerViewModel.presentResultDetail(for entry:)](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift)

This is acceptable in V1 because:

- the detail surface already works with `DeckCardEntry`
- the detail view already uses card candidate data plus market-history fetches
- no scan event is required for this route

### Add semantics

Manual search should use the existing buy/add path, not `create_deck_entry(...)`.

Required behavior:

- `sourceScanID = nil`
- no `scan_events` mutation
- no `scan_confirmations` mutation
- inventory is updated through the existing buy pathway:
  - [CollectionStore.recordBuy(...)](/Users/stephenchan/Code/spotlight/Spotlight/App/AppContainer.swift)
  - [POST /api/v1/portfolio/buys](/Users/stephenchan/Code/spotlight/backend/server.py)

Reason:

- this preserves quantity and cost-basis semantics
- this matches the portfolio-first inventory model
- `manual_search` is a scan-correction concept, not a no-scan inventory concept

## UX Details

### Portfolio insertion points

Required:

- header CTA near the account button area
- empty-state CTA in inventory section

V1 UI tone:

- clear
- lightweight
- buyer-facing clean
- not enterprise-form-heavy

### Search view layout

Recommended layout:

- top bar:
  - dismiss button
  - title `Add Card`
- search field
- helper copy
- results list

Suggested result row layout:

- left: artwork
- middle:
  - card name
  - set and number
  - detail line such as language / rarity / owned quantity
- right:
  - optional cached price
  - chevron

### Existing inventory awareness

If the user already owns a result:

- show an `OWN n` or `QTY n` style pill in the result row
- still allow tapping through to detail and adding more

V1 should not block adding duplicates.

## Data and Logging Rules

- Manual metadata search is not scan training data.
- Do not write `scan_events` rows for typed search sessions.
- Do not write `scan_artifacts` rows.
- Do not write `scan_confirmations` rows.
- Inventory mutations should still write the normal buy / deck-entry ledger records.
- If lightweight product analytics are added later, they should be a separate event stream, not a fake scan record.

## Acceptance Criteria

### Product acceptance

- A user can start from Portfolio and open `Add Card`.
- A user can type a raw-card query and get ranked results.
- Tapping a result opens the existing card detail overlay.
- Tapping `Add to Collection` opens the existing buy/add sheet.
- Confirming the sheet adds the card to inventory with `sourceScanID = nil`.
- The new card appears in portfolio inventory after refresh.

### Backend acceptance

- `GET /api/v1/cards/search` stays backward-compatible for the scanner fallback path.
- Normal search requests do not hit live Scrydex search endpoints.
- Normal search requests do not auto-import missing cards.
- Search uses indexed retrieval and avoids full Python scans over the whole catalog.

### Performance acceptance

- Typeahead feels immediate on the current local mirror dataset.
- Search should no longer behave like a multi-second operation on common queries.
- The app should debounce aggressively enough to avoid wasteful request spam.

### Quality acceptance

- Existing scanner alternatives search still works.
- Existing portfolio inventory search still works.
- Manual add does not create scan artifact or scan confirmation side effects.
- Buying the same card multiple times still increments inventory correctly.

## Validation Plan

### Backend tests

Add tests covering:

- exact alias match
- alias prefix match
- exact number match
- set plus name ranking
- digital-card de-prioritization
- local-only rule
- `limit` clamping

Likely files:

- `backend/tests/test_manual_card_search.py`
- existing search helpers in:
  - [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)

### App QA

Manual QA should cover:

1. Portfolio -> Add Card -> `charizard` -> open detail -> add to collection
2. Query by set code and number such as `svp pikachu`
3. Query with no result
4. Existing owned card shows quantity and still allows add
5. Dismiss search without mutation
6. Scanner alternative search still works after the backend rewrite

## Implementation Order

### Phase 1: backend search rewrite

- keep endpoint path
- add `limit`
- replace full-table Python search with indexed shortlist retrieval
- add backend tests

### Phase 2: app manual search surface

- add portfolio CTA
- add manual search view and view model
- wire debounced search
- show owned quantity in results

### Phase 3: shared detail and add wiring

- tap result -> preview entry -> shared detail
- reuse existing buy/add sheet
- refresh inventory after successful add

### Phase 4: polish and QA

- empty states
- loading states
- keyboard behavior
- scanner fallback regression check

## Explicit Non-Decision For V1

This spec does not decide the final graded/slab manual search design.

When graded search is revisited later, it should be a separate follow-on spec with explicit decisions about:

- grader filtering
- grade filtering
- cert lookup
- whether graded search is unified or mode-specific

For now, V1 should ship the smallest clean thing:

- raw cards
- portfolio-first
- fast local search
- existing add flow reuse
