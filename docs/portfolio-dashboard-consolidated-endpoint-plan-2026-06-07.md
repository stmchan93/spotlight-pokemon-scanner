# Portfolio Dashboard — Consolidated Endpoint Plan (Option B)

Date: 2026-06-07
Status: PLAN (not implemented). Ships with the next backend deploy.

## Plain-English summary

Opening the Collection / Portfolio screen currently makes the app fire **14
separate backend requests at once** — inventory, 6 portfolio-history ranges
(1W/1M/3M/YTD/1Y/ALL), 6 ledger ranges (1W/30D/90D/YTD/1Y/ALL), and insights —
then waits for all of them. Each has a tight timeout and no retry, and the app
treats the whole refresh as failed if any single one is slow. On a busy or
burst-throttled VM, one slow call out of 14 makes the user see
"Couldn't refresh just now — showing your last update," even though the backend
is up and their data is fine.

**What we have:** 14 parallel client calls, each re-querying overlapping data on
the server, all-or-nothing on the client.

**What we need:** one fast call that returns everything the screen needs, with
the server doing the work once.

This plan replaces the 14-request fan-out with a single endpoint,
`GET /api/v1/portfolio/dashboard`, that the backend computes in one pass and
(optionally) caches per user. Client goes from 14 requests → 1.

> Companion: a smaller **client-only resilience fix** (request timeout 6s→12s +
> partial tolerance so a slow secondary range can't blank the screen) is already
> implemented and tested in the working tree, unshipped. It is independent of
> this plan and protects the fallback path; ship it whenever. See Appendix C.

## The endpoint

`GET /api/v1/portfolio/dashboard`

- Auth: same Supabase bearer token as the existing portfolio routes.
- Query params (all optional): `timeZone` (for date binning).
- Response: exactly the shape the client already assembles today (so the client
  mapping barely changes), e.g.:

```jsonc
{
  "currencyCode": "USD",
  "inventory": { "entries": [ /* deck entries, as /api/v1/deck/entries */ ] },
  "insights": { /* as /api/v1/portfolio/insights, or null */ },
  "ranges": {
    "1W":  { "history": { /* as /portfolio/history */ }, "ledger": { /* as /portfolio/ledger */ } },
    "1M":  { "history": { ... }, "ledger": { ... } },
    "3M":  { "history": { ... }, "ledger": { ... } },
    "YTD": { "history": { ... }, "ledger": { ... } },
    "1Y":  { "history": { ... }, "ledger": { ... } },
    "ALL": { "history": { ... }, "ledger": { ... } }
  },
  "sections": { /* optional: per-section ok/error flags, see "Partial results" */ }
}
```

Reusing the existing per-section payload shapes means `loadPortfolioDashboard`
only changes *where it gets the data*, not how it maps each piece.

## Why this is fast (the core idea)

The 6 history ranges and 6 ledger ranges are **all derived from the same
underlying rows** — the user's deck entries, deck-entry events, and sale events.
Today each range independently re-queries those tables and re-bins them (see
Appendix B). The consolidated handler should:

1. Load the user's `deck_entries`, `deck_entry_events`, and `sale_events`
   **once**.
2. Hydrate card metadata + pricing **once** from the already-cached pricing
   snapshots (pricing is read from the SQLite snapshot cache — no live pricing
   fetches; see `_should_use_cached_pricing_snapshot`, server.py:1661).
3. Compute all 6 history ranges + 6 ledger ranges + insights in-memory from that
   single dataset by slicing/binning to each range's window.

Net: one DB read pass instead of ~13, and zero client fan-out.

## Optional: short-TTL per-user response cache

To absorb pull-to-refresh spam and repeated screen mounts (and to shield a
throttled VM), cache the assembled dashboard per user for a short TTL
(e.g. 30–60s). Key by user id. Invalidate on any inventory/sale mutation
(add/edit/delete entry, log transaction) so a user always sees their own writes
immediately. This is additive and can be a fast-follow after the endpoint lands.

## Client changes (ship over OTA after backend is live)

In `packages/api-client/src/spotlight/repository.ts`:

- Add `loadPortfolioDashboardConsolidated()` that issues the single request and
  maps the response into the existing `PortfolioDashboard` (the per-section
  mappers — `mapPortfolioSeries`, `buildSalesSeries`, `buildRecentSales`,
  inventory mapping — are reused unchanged).
- `loadPortfolioDashboard()` tries the consolidated endpoint first; on `404`
  (old backend) or transport error, **falls back to the current 14-request
  path**. This is mandatory: OTA clients and the backend deploy will not be in
  lockstep, so the new client must work against a backend that doesn't have the
  endpoint yet, and vice-versa.
- Keep the partial-tolerance gating (Appendix C) on the fallback path.

No screen/hook changes required — `use-portfolio-screen-model.ts` keeps calling
`loadPortfolioDashboard()` and gets the same `PortfolioDashboard` back.

## Partial results (recommended)

Have the server compute each section independently and include a `sections` map
of ok/error flags, returning `200` as long as inventory + 1W history succeeded
(mirroring the client's partial-tolerance rule). That way a single slow section
degrades gracefully server-side too, and the client never blanks on a secondary
range.

## Rollout

1. Implement the endpoint + (optional) cache behind the existing auth.
2. Deploy backend via the gate: `pnpm backend:deploy:staging` (never the raw
   wrapper — per AGENTS.md).
3. Verify on staging (Appendix D).
4. Ship the client change over OTA (`pnpm frontend:update:staging`). Because of
   the 404 fallback, this is safe to ship before or after the backend; do
   backend first to get the benefit immediately.
5. Production later via the same gated path.

## Risks & mitigations

- **Single point of failure for the whole screen.** Mitigated by the client
  404/transport fallback to the 14-request path, plus server-side partial
  results, plus the resilience fix.
- **Larger single payload** vs many small ones — it is the same data; negligible,
  and gzip applies. Cap inventory page size as today (`limit`).
- **One request must finish under the client timeout.** One-pass compute should
  be faster than 13 separate queries; validate p95 on staging. The 12s client
  timeout (resilience fix) gives ample headroom.
- **Cache staleness after a write.** Invalidate per-user cache on inventory/sale
  mutations; short TTL bounds worst case anyway.
- **Backend not yet ready to deploy** (current state). This plan is intentionally
  parked until the next backend deploy; the client resilience fix carries us in
  the meantime.

## Appendix A — current client fan-out
- `packages/api-client/src/spotlight/repository.ts`
  - `loadPortfolioDashboard()` — the 14-way `Promise.all` (≈ line 3131).
  - `requestJson()` — timeout/abort + candidate-URL fallback (≈ line 4180).

## Appendix B — current backend handlers (to consolidate)
- `backend/server.py`
  - `GET /api/v1/deck/entries` route ≈ 12513 → `deck_entries()` ≈ 11852
  - `GET /api/v1/portfolio/history` route ≈ 12548 → `deck_history()` ≈ 3201
  - `GET /api/v1/portfolio/ledger` route ≈ 12675 → `portfolio_ledger()` ≈ 3555
  - `GET /api/v1/portfolio/insights` route ≈ 12658 → `portfolio_insights()` ≈ 11153
  - pricing snapshot cache gate: `_should_use_cached_pricing_snapshot()` ≈ 1661

## Appendix C — companion client resilience fix (already implemented, unshipped)
- `repository.ts`: `defaultHttpRequestTimeoutMs` 6000 → 12000.
- `repository.ts` `loadPortfolioDashboard()`: gate `error` on **inventory + 1W
  history only** (secondary ranges tolerated).
- Tests in `apps/spotlight-rn/__tests__/repository/spotlight-repository-loading-test.ts`
  (partial-tolerance + critical-failure + 12s timeout).

## Appendix D — staging verification checklist
- Endpoint returns `200` with all sections for a populated account.
- One section forced to error → still `200`, `sections` flags the failure, client
  renders fresh inventory + value.
- p95 latency under load < client timeout.
- After logging a sale / adding a card, the next dashboard call reflects it
  (cache invalidation works).
- Old client (without the consolidated call) still works against the new backend;
  new client still works against a backend without the endpoint (404 fallback).
