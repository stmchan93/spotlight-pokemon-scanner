# Collection Import Spec

Date: 2026-04-20

## Status

- This document is the planned source of truth for future collection import work.
- It is a follow-on spec under the current inventory / ledger / portfolio workstream.
- It does not replace:
  - [docs/inventory-portfolio-selling-spec-2026-04-15.md](/Users/stephenchan/Code/spotlight/docs/inventory-portfolio-selling-spec-2026-04-15.md)
  - [docs/manual-card-search-v1-spec-2026-04-20.md](/Users/stephenchan/Code/spotlight/docs/manual-card-search-v1-spec-2026-04-20.md)
- Current phase status:
  - Phase 0 source-format fixtures and adapter contract: not started
  - Phase 1 backend import-job model: not started
  - Phase 2 app import preview / resolution UX: not started
  - Phase 3 commit path and bulk inventory mutations: not started

## Why This Exists

Looty is increasingly a seller-first inventory app, not only a scanner.

That changes the onboarding problem.

A dealer with `500-5,000+` cards already tracked in another app will not re-scan everything just to try Looty.

The import feature exists to solve that migration problem cleanly:

1. bring current holdings into Looty fast
2. preserve inventory credibility
3. avoid fake cost-basis or fake exact matches
4. keep the product feeling dealer-first rather than spreadsheet-first

This is especially important for the current ICP:

- show vendors
- small entrepreneurial sellers
- users who care about speed, clarity, and table-side usefulness

For this user, import is not a backup novelty.

It is an activation and switching feature.

## Research Findings

As of `2026-04-20`, the externally documented reality is:

- Collectr officially documents file-based import/export, not a public authenticated collection-sync API:
  - [Import / Export Your Collection](https://getcollectr.notion.site/Import-Export-Your-Collection-9aa6e5f4d0cd4efb995dadc992760c8e)
- Collectr’s public site markets API access for product details / prices / trends, but does not publicly document a user-portfolio import/export API:
  - [Collectr API Access](https://www.getcollectr.com/)
- Collectr’s terms prohibit collecting information in unauthorized or automated ways without permission:
  - [Collectr Terms](https://getcollectr.com/marketing-website/terms-and-conditions.html)
- TCGplayer officially documents CSV export of collection data including product ID, condition, language, variant, and quantity:
  - [How to Migrate Your Data from the Previous Version of the TCGplayer App](https://help.tcgplayer.com/hc/en-us/articles/33797162920599-How-to-Migrate-Your-Data-from-the-Previous-Version-of-the-TCGplayer-App)

Implication:

- V1 should be file-import-first.
- Do not plan V1 around scraping Collectr or calling an undocumented private mobile API.
- The architecture should keep future source adapters open, but the first shipped path should assume exported files, not live account sync.

## Product Goal

The feature should let a seller import owned cards from another system into Looty’s inventory with a clear preview and an honest commit path.

The intended user story is:

1. user opens Portfolio / Inventory
2. user taps `Import`
3. user selects a CSV export from TCGplayer, Collectr, or another supported source
4. Looty parses the file and shows:
   - exact matches
   - rows that need review
   - unsupported rows
5. user resolves or skips problematic rows
6. user commits the import
7. Looty updates inventory and optional buy history

The user should end with:

- a real current inventory snapshot
- optional buy/cost-basis history only where supported by the source data
- no silent fuzzy matches

## Scope

This spec covers:

- import product behavior
- source-adapter strategy
- backend import-job model
- row normalization and matching rules
- app import review / resolve / commit flow
- schema / API additions
- implementation order

This spec does not cover:

- scanner changes
- live third-party account linking
- OAuth integrations with external apps
- scraping or reverse-engineering private mobile APIs
- slab import in the first shipped phase
- multi-user shared inventory
- cross-account merge / dedupe beyond one user’s local inventory
- automatic marketplace listing creation from imported cards
- accounting-grade tax workflows

## Product Constraints

- Import must stay inventory-first and vendor-usable.
- V1 should be file-based, not live sync.
- Preview and commit must be separate steps.
- Ambiguous matches must never auto-commit silently.
- External market-price fields must not become acquisition cost by default.
- Missing cost basis is acceptable.
- Missing identity is not acceptable for auto-commit.
- Normal import preview should remain local-catalog-first and should not fan out into unbounded live provider calls.
- Source collection names from external tools may be preserved as metadata, but they must not force a new portfolio segmentation model in V1.

## Current Runtime Reality

The repo already has the foundations needed for a future import feature.

### What is already real

- current inventory persistence:
  - [`deck_entries`](/Users/stephenchan/Code/spotlight/backend/schema.sql:176)
- current card catalog:
  - [`cards`](/Users/stephenchan/Code/spotlight/backend/schema.sql:3)
- add-to-inventory path:
  - [`create_deck_entry(...)`](/Users/stephenchan/Code/spotlight/backend/server.py:6213)
- buy-ledger path:
  - [`record_buy(...)`](/Users/stephenchan/Code/spotlight/backend/server.py:2383)
  - [`POST /api/v1/portfolio/buys`](/Users/stephenchan/Code/spotlight/backend/server.py:7279)
- app-side buy wiring:
  - [`CollectionStore.recordBuy(...)`](/Users/stephenchan/Code/spotlight/Spotlight/App/AppContainer.swift:457)
- shared network surface:
  - [`CardMatchingService`](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardMatchingService.swift:4)

### What is missing

- no import-job tables
- no bulk import preview endpoint
- no bulk commit endpoint
- no manual row-resolution flow
- no external ID crosswalk table for import formats like TCGplayer product IDs
- no import-specific ledger semantics for quantity-only holdings with unknown cost basis

### Important current limitation

The current buy flow requires `unitPrice`.

That is correct for explicit buys, but it is not correct for many imported holdings files.

A lot of external exports provide:

- quantity
- condition
- language
- card identity
- maybe market value

but not true acquisition price.

Therefore collection import cannot be modeled as:

- “just call the buy endpoint for every row”

That would fabricate cost basis where none exists.

## Core Decisions

### Decision 1: V1 is file-import-first, not API-sync-first

The first shipping feature should support exported files.

Do not block the feature on:

- Collectr OAuth
- undocumented private APIs
- account linking

The architecture should use source adapters so that a future official API adapter can be added later without changing the normalized row contract.

### Decision 2: import is a server-side job with preview and commit

Large vendor imports need durable state.

Do not make the app hold all resolution state in memory and then POST one huge final payload.

Use a persistent import-job model:

1. create preview job
2. parse and match rows on the backend
3. let the app fetch and edit row state
4. commit selected rows

### Decision 3: quantity-only holdings and buy history are different commit modes

Imported rows fall into two classes:

1. holdings rows with no true cost basis
2. buy-like rows with explicit acquisition price

They must not be forced into one path.

Commit rules:

- if a row has explicit acquisition price from the source or user edit:
  - commit as a buy-like ledger mutation
- if a row has quantity only:
  - commit as an inventory-seeding adjustment

### Decision 4: external market price is not cost basis

Many exports include current market value.

That value is useful for preview context, but it is not proof of acquisition cost.

Do not silently map:

- `market_price`
- `tcg_market_price`
- `current_value`

to:

- `unitPrice`
- `costBasisTotal`

Default rule:

- use explicit acquisition cost only
- otherwise leave cost basis unknown

### Decision 5: local-catalog-first matching

Normal preview matching should prefer the local catalog and local indexes.

Do not design preview around issuing per-row live Scrydex searches.

Matching priority should be:

1. exact known internal `card_id`
2. exact external-ID crosswalk
3. exact local catalog match using structured fields
4. local ranked search shortlist with review required
5. unresolved

Live remote fallback, if ever added later, should be explicit, bounded, and not part of the first shipped contract.

### Decision 6: source collection names are metadata, not a new inventory model

External tools often export:

- collection / binder name
- folder name
- portfolio name

Looty does not currently have a first-class multi-binder inventory model.

V1 should:

- preserve source collection names in import metadata
- show them in preview if useful
- not block shipping on creating a new multi-collection architecture

### Decision 7: slabs are out of scope for the first shipped import slice

The slab inventory / pricing lane is still under separate product and backend work.

V1 collection import should target:

- raw cards only

If a source row is clearly graded/slabbed, it should be marked:

- unsupported
- skipped

rather than being coerced into a raw row.

## Supported Source Strategy

### Phase-1 shipping adapters

- `tcgplayer_csv_v1`
- `spotlight_template_csv_v1`

### Phase-1.5 gated adapter

- `collectr_csv_v1`

This adapter should not be implemented until the repo has real sample Collectr export fixtures.

Reason:

- the official docs confirm export exists
- the public docs do not fully publish a stable CSV header contract
- implementation should be based on real exported files, not guessed headers

### Future adapters

- `binderpos_csv_v1`
- `custom_generic_csv_v1`
- future official API-based adapters if a provider publishes a real collection-import contract

## Normalized Row Contract

Every source adapter should normalize incoming rows into one internal contract.

Suggested normalized fields:

```json
{
  "sourceType": "tcgplayer_csv_v1",
  "sourceRowIndex": 12,
  "sourceCollectionName": "Show Case A",
  "externalIDs": {
    "tcgplayerProductID": "123456"
  },
  "cardName": "Charizard ex",
  "setName": "Obsidian Flames",
  "setCode": "OBF",
  "collectorNumber": "223",
  "language": "en",
  "condition": "Near Mint",
  "variant": "Raw",
  "quantity": 3,
  "acquisitionUnitPrice": null,
  "acquisitionTotalPrice": null,
  "marketUnitPrice": 54.12,
  "currencyCode": "USD",
  "notes": null
}
```

Rules:

- `quantity` is required and must be `>= 1`
- `cardName` alone is not enough for auto-commit
- `acquisitionUnitPrice` and `marketUnitPrice` must remain separate fields
- source-specific extra columns should remain in raw row JSON for debugging and future reuse

## Backend Design

### New schema additions

Add import-job tables.

Recommended tables:

#### `portfolio_import_jobs`

- `id`
- `source_type`
- `status`
- `source_file_name`
- `source_sha256`
- `row_count`
- `matched_count`
- `ambiguous_count`
- `unresolved_count`
- `unsupported_count`
- `committed_count`
- `skipped_count`
- `summary_json`
- `error_text`
- `created_at`
- `updated_at`
- `committed_at`

#### `portfolio_import_rows`

- `id`
- `job_id`
- `row_index`
- `source_collection_name`
- `raw_row_json`
- `normalized_row_json`
- `match_status`
- `matched_card_id`
- `match_strategy`
- `candidate_card_ids_json`
- `quantity`
- `condition`
- `variant_name`
- `currency_code`
- `acquisition_unit_price`
- `acquisition_total_price`
- `market_unit_price`
- `commit_action`
- `commit_result_json`
- `error_text`
- `created_at`
- `updated_at`

#### `card_external_refs`

This table is the clean place to store reusable crosswalks such as:

- TCGplayer product ID -> Looty `card_id`
- future Collectr export identifiers -> Looty `card_id`

Suggested fields:

- `provider`
- `external_id`
- `card_id`
- `metadata_json`
- `created_at`
- `updated_at`

Primary key:

- `(provider, external_id)`

### Import-specific ledger behavior

Add explicit import event kinds.

Suggested new `deck_entry_events.event_kind` values:

- `import_seed`
- `import_buy`
- `import_skip` is not needed in ledger; skip stays on import-job rows only

Rules:

- `import_seed` adjusts current inventory quantity when cost basis is unknown
- `import_buy` is allowed only when a real acquisition price exists

Do not overload:

- `buy`

for rows that do not actually contain buy history.

### New backend module seams

Likely files:

- new:
  - `backend/portfolio_imports.py`
  - `backend/import_source_adapters.py`
- touched:
  - [backend/schema.sql](/Users/stephenchan/Code/spotlight/backend/schema.sql)
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
  - [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)

The important rule is not the exact module names.

The important rule is:

- do not grow import parsing, row matching, and commit orchestration directly inside one huge `server.py` branch

### API contract

#### `POST /api/v1/portfolio/imports/preview`

Request:

```json
{
  "sourceType": "tcgplayer_csv_v1",
  "fileName": "tcgplayer_collection_2026_04_20.csv",
  "csvText": "Collection Name,Product ID,..."
}
```

Behavior:

- create import job
- parse rows through selected adapter
- normalize and validate rows
- attempt local matching
- return summary plus first page of row results

Response shape should include:

- `jobID`
- `status`
- summary counts
- paginated rows
- source-detection warnings

#### `GET /api/v1/portfolio/imports/{jobID}`

Behavior:

- return job summary
- return rows with filters such as:
  - `matched`
  - `ambiguous`
  - `unresolved`
  - `unsupported`
  - `ready_to_commit`

#### `POST /api/v1/portfolio/imports/{jobID}/resolve`

Behavior:

- allow user-approved per-row overrides

Examples:

- choose exact `cardID`
- edit condition
- edit acquisition price
- mark row skipped

#### `POST /api/v1/portfolio/imports/{jobID}/commit`

Behavior:

- commit all ready rows in one backend-owned operation
- apply bulk mutations server-side
- return counts and any partial failures

Important:

- the app should not loop over thousands of rows and call one mutation endpoint per row

### Matching pipeline

Per normalized row:

1. validate quantity and basic field shape
2. exact-match by `card_id` if present
3. exact-match by external crosswalk if available
4. attempt structured local identity match using:
   - name
   - set
   - collector number
   - language
5. if one clear winner exists:
   - mark `matched`
6. if several plausible winners exist:
   - mark `ambiguous`
   - persist shortlist candidate IDs
7. if no plausible winner exists:
   - mark `unresolved`

Matching must be conservative.

It is better to make the user review a row than to silently import the wrong Charizard.

### Commit rules

For each ready row:

- hydrate the local card if needed only through bounded exact-ID paths
- if explicit acquisition price exists:
  - write inventory and append `import_buy`
- else:
  - write inventory and append `import_seed`

Default field rules:

- missing condition:
  - keep `NULL`
- missing acquisition cost:
  - do not backfill from market price
- duplicate matched rows:
  - commit separately unless the normalized identity and pricing semantics are truly identical

### Performance goals

V1 should handle realistic dealer files without feeling broken.

Target operating envelope:

- `<= 5,000` rows per import job
- preview results paginated
- backend commit chunked internally

If processing becomes slow:

- keep the job model
- move parse/match/commit phases onto background execution later

Do not redesign the contract around background workers before the simpler job model exists.

## App Design

### Entry point

Add a portfolio / inventory import CTA.

Likely surfaces:

- portfolio header action
- portfolio empty-state CTA
- later settings/help link for import template download

### App flow

1. user taps `Import`
2. app opens file picker for `.csv`
3. app asks for source type only if auto-detection is weak
4. app sends file text to preview endpoint
5. app shows import summary screen:
   - matched rows
   - needs review
   - unsupported
6. user resolves ambiguous rows
7. user commits
8. app shows completion summary and refreshes inventory

### App UI rules

- this flow belongs in portfolio, not in scanner
- progress and counts should be bold and obvious
- unresolved rows should be impossible to miss
- user should be able to filter to:
  - ready
  - review needed
  - skipped
- manual row resolution should reuse the existing portfolio-first search/detail mental model rather than inventing a scanner-style candidate tray

### App-side files likely touched later

- [Spotlight/App/AppContainer.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/AppContainer.swift)
- [Spotlight/Services/CardMatchingService.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardMatchingService.swift)
- new:
  - `Spotlight/Models/PortfolioImportModels.swift`
  - `Spotlight/ViewModels/PortfolioImportViewModel.swift`
  - `Spotlight/Views/PortfolioImportView.swift`
  - `Spotlight/Views/PortfolioImportReviewView.swift`

## Validation Plan

### Fixture requirement

Before implementation, add anonymized import fixtures under a dedicated folder.

Recommended root:

- `qa/import-fixtures/`

Add:

- `tcgplayer/`
- `collectr/`
- `spotlight-template/`

Each fixture should include:

- raw CSV
- README describing source and date
- expected normalized rows
- expected preview classification counts

### Backend tests

Add tests for:

- CSV header detection
- row normalization
- quantity validation
- exact external-ID crosswalk matching
- exact structured local matching
- ambiguous multi-match classification
- unresolved rows
- commit behavior for:
  - `import_seed`
  - `import_buy`
- market price not becoming cost basis

Likely files:

- `backend/tests/test_portfolio_imports.py`
- `backend/tests/test_import_source_adapters.py`

### App QA

Manual QA should cover:

1. import a small TCGplayer file with exact matches only
2. import a file with ambiguous Charizard-style rows that require resolution
3. import rows with quantity but no price
4. import rows with explicit acquisition cost
5. skip unsupported rows and commit the rest
6. verify inventory refresh after commit
7. verify no fake cost basis appears when only market price existed in the source

## Implementation Order

### Phase 0: fixtures and adapter contract

- collect real anonymized sample exports
- add `qa/import-fixtures/`
- define normalized row contract
- define source detection rules

This phase is mandatory before a Collectr adapter is attempted.

### Phase 1: backend import-job foundation

- add import-job tables
- add import source-adapter module
- add preview endpoint
- add row listing / filtering endpoint
- add backend tests for parsing and matching

### Phase 2: app preview and review UX

- add portfolio import CTA
- add file picker flow
- add preview summary UI
- add row review / resolution UI

### Phase 3: commit path

- add commit endpoint
- add import-specific ledger event kinds
- add server-side bulk mutation orchestration
- refresh app inventory after commit

### Phase 4: crosswalk and adapter expansion

- add `card_external_refs`
- support TCGplayer exact product-ID mapping
- add Collectr adapter once real fixture files exist
- add Spotlight template CSV export/import loop if useful

### Phase 5: polish

- import resume behavior
- better duplicate grouping
- optional downloadable template
- import analytics / support diagnostics

## Acceptance Criteria

### Product acceptance

- A seller can start from Portfolio and import a supported CSV file.
- The preview clearly separates matched, review-needed, and unsupported rows.
- The user can resolve ambiguous rows before committing.
- Committing updates current inventory.
- Rows without true acquisition cost do not create fake purchase history.

### Backend acceptance

- Preview does not rely on unbounded live provider calls.
- Import jobs are durable and re-openable.
- Import commit runs server-side and does not require one client request per row.
- External-ID crosswalks are modeled cleanly instead of overloading `cards.source_record_id`.

### Data acceptance

- Market value fields remain distinct from acquisition cost.
- Unresolved rows never auto-commit.
- Raw-card imports do not fabricate slab context.

## Explicit Non-Decisions

This spec does not decide:

- the final slab import design
- a future live Collectr or marketplace account sync
- whether multi-binder inventory becomes a first-class product model later
- whether import provenance should later show in end-user analytics

Those should be follow-on decisions after V1 file import is real.
