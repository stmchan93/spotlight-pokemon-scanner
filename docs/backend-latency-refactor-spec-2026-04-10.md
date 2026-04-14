# Backend Latency / Network Refactor Spec

Date: 2026-04-10

## Status

- This document is the pre-implementation source of truth for the backend latency / network-call refactor.
- Phase status:
  - Phase 1 analysis: complete
  - Phase 2 implementation: not started
- Scope is intentionally limited to:
  - backend retrieval
  - matching
  - candidate persistence
  - pricing snapshot serving
  - refresh scheduling design seams
  - response building
- Out of scope:
  - OCR rewrites
  - unrelated cleanup
  - broad app/UI changes

## Product Constraints

- The mobile app currently renders only the top matched candidate.
- The backend response must already be structured to support:
  - one top candidate
  - alternates
  - confidence / ambiguity metadata
  - cached pricing snapshot metadata
  - freshness / staleness metadata
- Prices do not need to be live-fetched on every scan.
- The database is the pricing cache / snapshot store.
- Future provider refresh is expected to move to a scheduled job.
- The scan hot path should prefer local DB snapshot reads over live provider pricing calls.
- Keep the Scrydex search branch. It is intentional and must remain supported.

## Core Design Rule

Keep these concerns separate:

1. identity resolution
2. price serving
3. price refresh

Do not mix them in the scan hot path unless absolutely necessary.

## Current Code Reality

Primary runtime entrypoints:

- [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)
- [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)
- deleted legacy raw API client
- deleted legacy raw pricing adapter
- [backend/scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py)
- [backend/fx_rates.py](/Users/stephenchan/Code/spotlight/backend/fx_rates.py)

Primary DB schema:

- [backend/schema.sql](/Users/stephenchan/Code/spotlight/backend/schema.sql)

## Current Problems

### 1. Retrieval plan is overly additive

- `build_raw_retrieval_plan(...)` can activate many routes at once for a strong exact scan.
- Current strong scans can trigger:
  - `collector_set_exact`
  - `title_set_primary`
  - `title_collector`
  - `title_only`
  - `collector_only`
- Source:
  - [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py#L536)

### 2. Local matching still does Python-side full-table scans

- The local matcher still relies on `SELECT * FROM cards` and Python scoring loops.
- This happens in:
  - `search_cards(...)`
  - `_candidate_rows(...)`
  - `search_cards_local_title_set(...)`
  - `search_cards_local_title_only(...)`
  - `search_cards_local_collector_set(...)`
  - `search_cards_local_collector_only(...)`
- Sources:
  - [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py#L682)
  - [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py#L1312)

### 3. Remote search fans out too much

- Legacy raw-provider remote search currently:
  - builds many queries
  - executes them sequentially
  - does not early-exit after a good hit
- Sources:
  - deleted legacy raw API client search helpers

Observed representative strong-query example:

- A strong exact English scan like `Charizard ex`, `223/197`, `OBF` currently generates 17 legacy-provider search queries before any early stopping because there is no early stopping.

### 4. Search payloads are too heavy

- Legacy raw-provider identity search requests `tcgplayer` and `cardmarket` fields even during candidate search.
- Scrydex search uses `include_prices=True` during identity search.
- Sources:
  - deleted legacy raw API client request builder
  - [backend/scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py#L248)
  - [backend/scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py#L262)

### 5. Identity search and price hydration are too coupled

- `_ensure_raw_card_cached(...)` may persist pricing from remote search payloads.
- `_raw_candidate_payload(...)` still calls `refresh_card_pricing(...)` when top-candidate pricing is missing.
- This means scan/match can still trigger live price work.
- Sources:
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py#L1192)
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py#L1268)

### 6. Top candidate path does extra work

- The hot path currently:
  - ensures the winner is cached
  - may refresh price if missing
  - re-reads pricing for `card_detail(...)`
  - re-reads pricing for scan logging provenance
- Sources:
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py#L1268)
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py#L1755)
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py#L1831)
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py#L663)

### 7. The server is still single-threaded

- This matters, but it is second wave after over-calling is reduced.
- Source:
  - [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py#L2189)

## Design Target

### Hot scan path

1. OCR evidence arrives
2. backend does staged identity retrieval with early exit
3. backend returns ranked candidates
4. price info is attached from local DB snapshots first
5. live provider pricing is generally not used during scan/match

### Warmth model

- `cards` is the identity cache / local catalog
- `card_price_snapshots` is the pricing serving cache
- a future scheduled refresh job updates price snapshots out of band

## Required Behavior Changes

### 1. Staged retrieval with early exit

- Replace additive retrieval with stage groups ordered by specificity.
- Suggested raw stage order:
  - Stage 1: collector + trusted set
  - Stage 2: title + trusted set
  - Stage 3: title + collector
  - Stage 4: broad fallback only if still weak
- After each stage:
  - merge candidates
  - rerank
  - stop if top score and score margin are sufficient

### 2. Separate identity search from price hydration

- Remote candidate search should request identity-bearing fields only.
- Do not request pricing-bearing fields during identity search.
- Price data in scan responses should come from local DB snapshots.

### 3. Response should return best candidate and alternates

- Preserve the current response enough that the existing UI can keep using the top result.
- Add a more explicit future-proof response structure:
  - `bestCandidate`
  - `alternates[]`
  - `matchConfidence`
  - `ambiguityFlags`
  - `pricing snapshot metadata`

### 4. Persist candidate identities

- Strong remote candidates should be upserted into `cards`.
- Do not persist prices for all candidates during scan.
- Identity persistence should make future scans cheaper.

### 5. Use DB-backed pricing snapshots as the serving path

- Read price data from local `card_price_snapshots`.
- Include freshness state:
  - `fresh`
  - `stale`
  - `missing`
- Missing prices should not force live provider refresh on scan.

### 6. Preserve a clean seam for scheduled price refresh

- Scheduled refresh should be able to:
  - iterate known cards
  - call providers out of band
  - update `card_price_snapshots`
- The scan hot path should not depend on live refresh completion.

### 7. Keep alternates lightweight

- Alternates should be returned now.
- Alternates may include cached snapshot summaries if present.
- Alternates should not trigger extra live provider calls.

### 8. Add instrumentation

Track and expose:

- local routes evaluated
- remote query groups executed
- provider call count
- stage timings
- cache hit / miss
- whether any live price hydration occurred
- why remote expansion or fallback happened

## Smallest Viable Refactor

This is the smallest implementation that should materially reduce latency and provider calls without broad redesign.

### Change set

1. Convert raw retrieval to staged execution with early exit.
2. Split remote identity search from price hydration.
3. Make Pokemon and Scrydex search payloads identity-only.
4. Persist strong remote candidate identities locally.
5. Return `bestCandidate` plus `alternates[]`, while keeping current top-candidate compatibility.
6. Serve pricing for returned candidates from local snapshots only during scan.
7. Add per-request memoization for repeated local reads.

## Target Request Flows

### 1. Hot local match

1. Build evidence and staged plan.
2. Run local exact / high-specificity stages only.
3. Rank and stop early.
4. Read pricing snapshots locally for returned candidates.
5. Return:
   - `bestCandidate`
   - `alternates`
   - confidence / ambiguity
   - freshness metadata
6. No provider price refresh happens inline.

### 2. Cold remote identity match

1. Local stages are weak or sparse.
2. Run the first remote identity query group only.
3. Merge and rerank.
4. Stop when score and margin are good enough.
5. Persist strong candidate identities into `cards`.
6. Read local price snapshots if present.
7. Return candidates with `fresh` / `stale` / `missing`.
8. No live provider price hydration happens inline.

### 3. Scan with stale or missing local price snapshot

1. Identity resolution proceeds normally.
2. Returned candidate includes the local snapshot state:
   - stale
   - missing
3. Scan response does not block on live provider refresh.
4. Future scheduled refresh updates the snapshot out of band.

## Target Response Shape

Preserve current compatibility:

- keep `topCandidates`

Add explicit future-proof fields:

- `bestCandidate`
- `alternates`
- `matchConfidence`
- `ambiguityFlags`
- `rawDecisionDebug`

Candidate payload target:

- identity fields
- `pricingSnapshot`
- `pricingStatus`
- `snapshotUpdatedAt`
- `sourceUpdatedAt`
- `didHydrateLivePrice`

Suggested `pricingStatus` values:

- `fresh`
- `stale`
- `missing`

## Files Likely To Change In Phase 2

### [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)

- `_retrieve_local_raw_candidates(...)`
- `_retrieve_remote_raw_candidates(...)`
- `_resolve_raw_candidates(...)`
- `_ensure_raw_card_cached(...)`
- `_raw_candidate_payload(...)`
- `_build_raw_match_response(...)`
- `refresh_card_pricing(...)`
- `card_detail(...)`

### [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)

- `build_raw_retrieval_plan(...)`
- `search_cards(...)`
- local route search helpers
- pricing snapshot helper reads for returned candidates

### deleted legacy raw API client

- split search fields from detail fields
- staged remote query groups
- early exit behavior

### [backend/scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py)

- identity-only search payloads
- preserve Scrydex retrieval branch
- keep detail fetch-by-id for explicit pricing refresh flows

### deleted legacy raw pricing adapter

- preserve as explicit refresh seam
- remove scan-path dependence on it

### [backend/fx_rates.py](/Users/stephenchan/Code/spotlight/backend/fx_rates.py)

- likely minimal phase-2 touch only
- avoid repeated FX work during one scan request

## Provider Call Counts

Representative target comparison:

### Strong exact raw scan

- Before:
  - multiple local full-table passes
  - many sequential legacy-provider queries possible
  - possible live pricing fetch for top candidate
- After:
  - local stages only in the common case
  - 0 live provider price calls
  - remote identity search usually skipped

### Cold English raw identity miss

- Before:
  - multiple sequential legacy-provider search queries
  - possible live price fetch on top
- After:
  - one staged remote identity group first
  - early exit if sufficient
  - no live price fetch during scan

### Cold Japanese / Scrydex scan

- Before:
  - grouped Scrydex search
  - price-bearing search payloads
- After:
  - grouped Scrydex identity-only search
  - no live price hydration during scan

## Price Snapshot Serving Model

- Scan/match reads from `card_price_snapshots`.
- Candidate response includes:
  - snapshot presence
  - freshness state
  - snapshot timestamps
  - cached summary values if present
- Live provider refresh remains available through explicit refresh flows and future scheduled jobs, not through normal scan/match.

## Scheduled Refresh Seam

Future scheduled job plugs into existing provider refresh logic:

- [backend/pricing_provider.py](/Users/stephenchan/Code/spotlight/backend/pricing_provider.py)
- [backend/scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py)

Expected job behavior:

1. select cards needing refresh by age / provider
2. fetch fresh provider pricing out of band
3. write updated `card_price_snapshots`
4. leave scan hot path read-only against snapshots

## Second-Wave Work

Not part of the first implementation wave:

- concurrent server runtime
- remote result TTL caches
- SQL / FTS-backed local retrieval instead of Python full-table scans
- async background warming / queued refreshes

## Phase 2 Implementation Order

1. staged identity retrieval with early exit
2. split identity search from price serving
3. lighter remote search payloads
4. candidate identity persistence
5. response shape with `bestCandidate + alternates[]`
6. DB snapshot pricing reads for returned candidates
7. per-request memoization
8. instrumentation
