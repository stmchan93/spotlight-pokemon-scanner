## Deck / Portfolio User Isolation Phase 2

Date: 2026-04-21

## Status

- This document proposes the Phase 2 design for per-user inventory ownership.
- It is the source of truth for fixing the current global shared deck / portfolio problem.

## Problem

Right now auth and inventory are disconnected.

- The app already has Supabase auth and gates the shell before portfolio/scanner:
  - [Spotlight/Auth/AuthStore.swift](/Users/stephenchan/Code/spotlight/Spotlight/Auth/AuthStore.swift)
  - [Spotlight/Services/SupabaseAuthService.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/SupabaseAuthService.swift)
  - [Spotlight/App/SpotlightApp.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/SpotlightApp.swift)
- The Python backend still accepts anonymous requests and stores inventory/ledger rows globally:
  - [Spotlight/Services/CardMatchingService.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardMatchingService.swift)
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
  - [backend/schema.sql](/Users/stephenchan/Code/spotlight/backend/schema.sql)
- The phase-1 auth doc explicitly calls out that auth does not yet isolate deck / portfolio data by user:
  - [docs/supabase-auth-phase1-setup-2026-04-19.md](/Users/stephenchan/Code/spotlight/docs/supabase-auth-phase1-setup-2026-04-19.md)

Today that means:

- all inventory rows in `deck_entries` are globally shared
- all buys / sells / ledger reads are globally shared
- import jobs are globally shared
- scan confirmation state can be attached to inventory without a user boundary

That is not a UI bug. It is a backend ownership bug.

## Goal

Make every mutable user record belong to exactly one authenticated user, and make the backend derive that user from the verified Supabase JWT on every user-scoped request.

The backend must stop trusting:

- anonymous requests
- UI state
- client-supplied user IDs in the JSON body

The backend must trust only:

- a verified Supabase access token
- the `sub` claim from that token as the canonical app user ID

## Non-Goals

- multi-user shared inventory
- team accounts / shop accounts
- cross-user transfers
- social portfolio visibility
- replacing Supabase auth

This is single-owner isolation only.

## Decision Summary

### Decision 1: use Supabase user ID as the canonical owner key

Use the authenticated Supabase user UUID as `owner_user_id` everywhere in mutable user data.

Do not create a second app-specific owner ID for this phase.

### Decision 2: backend JWT verification is mandatory for user-scoped routes

The app should send the Supabase access token as:

```text
Authorization: Bearer <access-token>
```

The backend should:

1. parse the bearer token
2. verify it against the Supabase JWKS
3. validate expiry and issuer
4. read the `sub` claim
5. use that `sub` as `owner_user_id`

Do not accept `ownerUserID` or `userID` fields in request payloads.

### Decision 3: ownership belongs in the schema, not just request filtering

Add `owner_user_id` to all mutable user-owned tables.

Minimum required tables:

- `scan_events`
- `scan_confirmations`
- `scan_artifacts`
- `deck_entries`
- `deck_entry_events`
- `sale_events`
- `portfolio_import_jobs`

Optional in phase 2:

- `portfolio_import_rows`

`portfolio_import_rows` can derive ownership via `job_id`, so it does not need an owner column immediately unless query simplicity becomes worth the duplication.

### Decision 4: stop using the deck entry natural key as the primary key

The current deck entry ID is a global natural key:

- raw: `raw|<card_id>`
- slab: `slab|<card_id>|<grader>|<grade>|<cert>|<variant>`

That shape is what makes global collision inevitable.

Do not fix this by prefixing the user ID onto the current string key. That is the quickest patch, but it hard-bakes ownership into an ugly external ID and keeps the wrong data model.

Recommended shape:

- `deck_entries.id` = opaque UUID primary key
- `deck_entries.identity_key` = normalized raw/slab identity string for dedupe within one owner
- unique index on `(owner_user_id, identity_key)`

Example:

- `id = de_01H...`
- `identity_key = raw|base1-4`

This keeps:

- stable ownership scoping
- per-user dedupe
- future freedom to change dedupe semantics without rewriting public IDs

### Decision 5: resolve inventory rows by owner + identity, not by global ID math

The existing helper in [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py) currently computes the row identity directly from card/slab context:

- [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py:3559)

That helper should remain, but it should become:

- `deck_entry_identity_key(...)`

and be used for:

- unique owner-scoped dedupe
- owner-scoped lookup

It should no longer be treated as the primary key itself.

## Route Scope

### Routes that must require authenticated ownership

- scan write surfaces:
  - `POST /api/v1/scan/match`
  - `POST /api/v1/scan/visual-match`
  - `POST /api/v1/scan/rerank`
  - `POST /api/v1/scan/feedback`
  - `POST /api/v1/scan/artifacts`
- inventory / deck:
  - `GET /api/v1/deck/entries`
  - `POST /api/v1/deck/entries`
  - `POST /api/v1/deck/entries/condition`
  - `POST /api/v1/deck/entries/purchase-price`
- portfolio / ledger:
  - `GET /api/v1/portfolio/history`
  - `GET /api/v1/portfolio/ledger`
  - `POST /api/v1/portfolio/buys`
  - `POST /api/v1/portfolio/sales`
  - `POST /api/v1/portfolio/sales/batch`
  - `POST /api/v1/portfolio/buys/<id>/price`
  - `POST /api/v1/portfolio/sales/<id>/price`
- import:
  - `POST /api/v1/portfolio/imports/preview`
  - `GET /api/v1/portfolio/imports/<job_id>`
  - `POST /api/v1/portfolio/imports/<job_id>/resolve`
  - `POST /api/v1/portfolio/imports/<job_id>/commit`

### Routes that may stay anonymous for now

- `GET /api/v1/health`
- internal ops endpoints under `/api/v1/ops/*`
- pure catalog reads if desired:
  - card search
  - card detail
  - card pricing detail

Those can still become authenticated later for simplicity, but they are not the reason deck state is globally shared.

## App Design

## 1. Auth header injection

`RemoteScanMatchingService` should be able to fetch the current Supabase access token before every request and attach it as a bearer header.

Current construction point:

- [Spotlight/App/AppContainer.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/AppContainer.swift:723)

Recommended design:

- introduce an `AuthTokenProvider` protocol on the app side
- have `AuthStore` expose the current access token from `currentSession`
- inject the provider into `RemoteScanMatchingService`
- automatically attach the bearer token to every authenticated backend request

Do not thread `userID` manually through view code.

## 2. Account / portfolio UX

No new deck picker or visible “switch user” control is needed.

The UX rule should be:

- the signed-in account owns the inventory
- signing out clears local user-scoped caches
- signing in as another user loads that other user’s inventory from the backend

This should feel automatic, not like a settings toggle.

## Backend Design

## 1. Request identity object

Add a small resolved request identity abstraction in the backend.

Recommended shape:

```python
@dataclass(frozen=True)
class RequestIdentity:
    user_id: str
    auth_source: str
```

The HTTP handler should resolve this once per request and pass it into user-scoped service methods.

That keeps service methods testable without forcing unit tests to synthesize raw HTTP headers.

## 2. Service method contract

User-scoped service methods should accept an explicit identity or `owner_user_id` parameter.

Example direction:

- `deck_entries(identity=...)`
- `create_deck_entry(identity=..., payload=...)`
- `record_buy(identity=..., payload=...)`
- `portfolio_ledger(identity=..., ...)`

Do not make business logic methods reach back into HTTP request state.

## 3. Supabase JWT verification

Add a backend auth helper module that:

- reads Supabase project URL / issuer config from env
- fetches the project JWKS
- caches keys in memory with TTL
- verifies JWT signature and claims
- returns `RequestIdentity`

Recommended envs:

- `SPOTLIGHT_SUPABASE_URL`
- `SPOTLIGHT_SUPABASE_JWKS_URL` optional override
- `SPOTLIGHT_AUTH_REQUIRED`
- `SPOTLIGHT_DEV_FALLBACK_USER_ID` optional local-only fallback

Behavior:

- production / staging: auth required
- local debug: may allow one configured fallback user if explicitly enabled
- tests: pass `owner_user_id` directly to service methods instead of exercising HTTP auth

## Schema Design

### `deck_entries`

Add:

- `owner_user_id TEXT NOT NULL`
- `identity_key TEXT NOT NULL`

Keep:

- `id TEXT PRIMARY KEY`

New index:

```sql
CREATE UNIQUE INDEX idx_deck_entries_owner_identity
ON deck_entries(owner_user_id, identity_key);
```

New query indexes:

```sql
CREATE INDEX idx_deck_entries_owner_added_at
ON deck_entries(owner_user_id, added_at DESC, id DESC);

CREATE INDEX idx_deck_entries_owner_quantity
ON deck_entries(owner_user_id, quantity, added_at DESC, id DESC);
```

### `deck_entry_events`

Add:

- `owner_user_id TEXT NOT NULL`

New index:

```sql
CREATE INDEX idx_deck_entry_events_owner_created_at
ON deck_entry_events(owner_user_id, created_at DESC, id DESC);
```

### `sale_events`

Add:

- `owner_user_id TEXT NOT NULL`

New indexes:

```sql
CREATE INDEX idx_sale_events_owner_sold_at
ON sale_events(owner_user_id, sold_at DESC, created_at DESC);

CREATE INDEX idx_sale_events_owner_deck_entry_id
ON sale_events(owner_user_id, deck_entry_id, sold_at DESC, created_at DESC);
```

### `scan_events`

Add:

- `owner_user_id TEXT NOT NULL`

New indexes:

```sql
CREATE INDEX idx_scan_events_owner_created_at
ON scan_events(owner_user_id, created_at DESC);

CREATE INDEX idx_scan_events_owner_deck_entry_id
ON scan_events(owner_user_id, deck_entry_id);
```

### `scan_confirmations`

Add:

- `owner_user_id TEXT NOT NULL`

### `scan_artifacts`

Either:

- add `owner_user_id TEXT NOT NULL`

or:

- keep ownership derived via `scan_id -> scan_events`

Recommendation: add the owner column for simpler cleanup and auditing.

### `portfolio_import_jobs`

Add:

- `owner_user_id TEXT NOT NULL`

New indexes:

```sql
CREATE INDEX idx_portfolio_import_jobs_owner_created_at
ON portfolio_import_jobs(owner_user_id, created_at DESC, id DESC);

CREATE INDEX idx_portfolio_import_jobs_owner_status
ON portfolio_import_jobs(owner_user_id, status, updated_at DESC);
```

## Query Rules

Every inventory / ledger / import query must include owner scope.

Examples:

- `SELECT ... FROM deck_entries WHERE owner_user_id = ?`
- `SELECT ... FROM sale_events WHERE owner_user_id = ?`
- `SELECT ... FROM portfolio_import_jobs WHERE owner_user_id = ?`

Do not rely on filtering only by:

- `deck_entry_id`
- `job_id`
- `scan_id`

Those should still be unique identifiers, but owner scope should be part of every user-facing query path.

## Migration Plan

## Phase 1: additive schema

Add the new owner columns and indexes.

For local/prototype migration:

- add nullable columns first
- backfill existing rows to one configured legacy owner
- then enforce non-null in new writes

Recommended env for one-time migration:

- `SPOTLIGHT_LEGACY_OWNER_USER_ID`

This should only be used for backfilling existing beta data where all rows are known to belong to one person.

Do not guess ownership for mixed historical data.

## Phase 2: decouple deck entry ID from identity

Rebuild `deck_entries` so:

- `id` is opaque
- `identity_key` holds the current raw/slab dedupe key

Then update child foreign keys in:

- `sale_events`
- `deck_entry_events`
- `scan_events`
- `scan_confirmations`

This is the highest-risk migration step, but it is the clean long-term fix.

## Phase 3: enforce authenticated request scope

Once the schema supports ownership:

- turn on backend auth verification
- reject unauthenticated access to user-scoped routes
- update the app to always send bearer tokens

## Phase 4: cache/session cleanup on sign-out

On sign-out, clear in-memory portfolio / inventory state so the next user never sees stale rows from the previous session.

## Important Implementation Notes

### Do not trust client-supplied owner IDs

Even if the app knows the current user ID, the request body should not carry ownership as authoritative input.

The server should derive ownership from the verified token only.

### Do not solve this with a frontend-only filter

A frontend filter would still leave:

- global writes
- global imports
- global sale rows
- global confirmation links

That would only hide the problem, not fix it.

### Do not keep global deterministic deck entry IDs

That shape is exactly what created the collision.

Keep deterministic dedupe as `identity_key`, but move row identity to an opaque ID.

## Recommended Shipping Order

1. add backend auth helper and request identity plumbing
2. add `owner_user_id` to user-owned tables
3. add `identity_key` and decouple `deck_entries.id`
4. owner-scope deck / portfolio / import queries and mutations
5. inject bearer tokens from the app
6. migrate old rows to one known owner
7. then enable auth-required mode outside local development

## Acceptance Criteria

- signing in as user A shows only user A inventory, buys, sales, imports, and portfolio history
- signing in as user B cannot read or mutate user A inventory
- adding the same raw card for two different users creates two independent inventory rows
- import jobs and review states are isolated by user
- scan confirmation cannot attach another user’s `scan_id` to inventory
- sign-out clears portfolio / inventory state locally

## Recommendation

This should be the next backend/product integrity feature after the current inventory/import work.

Until this lands, every new inventory, ledger, import, and show-session feature is building on top of globally shared state.
