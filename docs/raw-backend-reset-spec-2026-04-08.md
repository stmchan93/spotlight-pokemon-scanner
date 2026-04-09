# Raw Backend Reset Spec

Date: 2026-04-08

## Status

- This document is the planning source of truth for the upcoming backend reset.
- Implementation status:
  - Phase 0 / 1 foundation: landed
  - Phase 2 provider import cutover onto `cards`: landed
  - Phase 3 raw evidence model: landed
  - Phase 4 title-first raw candidate retrieval: landed
  - Phase 5 footer-based rerank + live raw cutover: landed
  - Phase 6 pricing cutover onto `card_price_snapshots`: landed
  - Phase 7 scan logging cutover onto `scan_events`: landed
  - Phase 8 raw runtime cutover off the legacy matcher: landed
  - Phase 9 raw test migration onto the new resolver: landed
  - Phase 10 legacy raw helper deletion: landed
- Scope order:
  1. raw backend matching reset
  2. slab identity / slab pricing redesign
  3. OCR redesign later
- Raw runtime now uses the new evidence -> retrieval -> rerank flow only.
- The backend contraction is now complete:
  - runtime is raw-only
  - legacy slab/sync/cache modules were deleted
  - bundled `backend/catalog/` artifacts were deleted
  - thin `scrydex_adapter.py` and `pricecharting_adapter.py` shells remain only for env/config structure and later rebuild work
- Remaining legacy backend debt is mostly slab-side rebuild work and older docs that still describe the deleted backend surfaces.

## Core Decisions

- The app remains a capture/OCR client.
- The backend owns:
  - candidate retrieval
  - identity resolution
  - pricing refresh
  - scan logging
- Raw matching is no longer collector-number-first.
- Raw matching becomes:
  1. retrieve candidates from stronger broad evidence
  2. rerank/confirm with footer collector OCR
- The backend must always return a best candidate for a valid raw scan.
- Low confidence affects review state and future candidate switching, not whether the UI shows a card.
- Raw identity and raw pricing stay on the Pokemon TCG API lane.
- Slab identity and slab pricing stay on the Scrydex lane.
- The current local DB may be reset. We are not preserving the old schema.

## Target Runtime SQLite

The runtime backend DB should be simplified to exactly three tables.

### `cards`

One row per canonical card.

Required fields:
- `id`
- `source_provider`
- `name`
- `set_name`
- `set_id`
- `set_series`
- `number`
- `language`
- `rarity`
- `supertype`
- `subtypes_json`
- `types_json`
- `artist`
- `image_url`
- `source_payload_json`
- `created_at`
- `updated_at`

Purpose:
- canonical identity
- enough metadata to render the app
- cache imported provider records

### `card_price_snapshots`

One row per pricing context.

Required fields:
- `id`
- `card_id`
- `pricing_mode`
- `provider`
- `grader`
- `grade`
- `variant`
- `currency_code`
- `low_price`
- `market_price`
- `mid_price`
- `high_price`
- `direct_low_price`
- `trend_price`
- `source_url`
- `source_updated_at`
- `source_payload_json`
- `updated_at`

Behavior:
- raw cards get one `pricing_mode = raw` snapshot
- slabs get one `pricing_mode = graded` snapshot per `card_id + grader + grade`

### `scan_events`

One row per scan attempt.

Required fields:
- `scan_id`
- `created_at`
- `resolver_mode`
- `resolver_path`
- `request_json`
- `response_json`
- `selected_card_id`
- `confidence`
- `review_disposition`
- `completed_at`

Purpose:
- debugging
- scan telemetry
- future correction workflows

## Tables To Remove

The redesign target removes these runtime tables and concepts:

- `card_images`
- `card_catalog_metadata`
- `card_price_summaries`
- `external_price_mappings`
- `slab_sales`
- `slab_price_snapshots`
- `scan_candidates`
- `scan_feedback`
- embedding / ANN tables if the old raw matcher no longer uses them:
  - `embedding_models`
  - `card_embeddings`

## Target Raw Matching Architecture

### Raw evidence model

The backend should derive a raw evidence bundle from the existing scan payload using fields such as:

- `fullRecognizedText`
- `metadataStripRecognizedText`
- `collectorNumber`
- `setHintTokens`
- `promoCodeHint`
- `recognizedTokens`
- `cropConfidence`

Later app payload enrichment is allowed, but phase 1 should work from the current contract.

### Strict raw backend function spec

The backend reset should use explicit helper names and small data structures so the raw matcher remains debuggable.

#### `backend/catalog_tools.py`

Add these dataclasses:

- `RawEvidence`
- `RawSignalScores`
- `RawRetrievalPlan`
- `RawCandidateScoreBreakdown`
- `RawCandidateMatch`
- `RawDecisionResult`

Add these helpers:

- `build_raw_evidence(payload: dict[str, Any]) -> RawEvidence`
- `score_raw_signals(evidence: RawEvidence) -> RawSignalScores`
- `build_raw_retrieval_plan(evidence: RawEvidence, signals: RawSignalScores) -> RawRetrievalPlan`
- `search_cards_local_title_set(connection: sqlite3.Connection, evidence: RawEvidence, limit: int = 12) -> list[dict[str, Any]]`
- `search_cards_local_title_only(connection: sqlite3.Connection, evidence: RawEvidence, limit: int = 12) -> list[dict[str, Any]]`
- `search_cards_local_collector_set(connection: sqlite3.Connection, evidence: RawEvidence, limit: int = 12) -> list[dict[str, Any]]`
- `search_cards_local_collector_only(connection: sqlite3.Connection, evidence: RawEvidence, limit: int = 12) -> list[dict[str, Any]]`
- `merge_raw_candidate_pools(candidate_groups: list[list[dict[str, Any]]]) -> list[dict[str, Any]]`
- `score_raw_candidate_retrieval(card: dict[str, Any], evidence: RawEvidence, signals: RawSignalScores) -> RawCandidateScoreBreakdown`
- `score_raw_candidate_resolution(card: dict[str, Any], evidence: RawEvidence, signals: RawSignalScores) -> RawCandidateScoreBreakdown`
- `rank_raw_candidates(cards: list[dict[str, Any]], evidence: RawEvidence, signals: RawSignalScores) -> list[RawCandidateMatch]`
- `compute_raw_confidence(matches: list[RawCandidateMatch], evidence: RawEvidence, signals: RawSignalScores) -> tuple[str, float]`
- `finalize_raw_decision(matches: list[RawCandidateMatch], evidence: RawEvidence, signals: RawSignalScores) -> RawDecisionResult`
- `raw_debug_payload(evidence: RawEvidence, signals: RawSignalScores, plan: RawRetrievalPlan, matches: list[RawCandidateMatch], decision: RawDecisionResult) -> dict[str, Any]`

Deleted in Phase 10:

- `direct_lookup_candidate_indices`
- `direct_lookup_has_name_support`
- `direct_lookup_has_exact_candidate`
- `direct_lookup_score`

#### `backend/import_pokemontcg_catalog.py`

Add these helpers:

- `build_raw_provider_queries(evidence: RawEvidence, signals: RawSignalScores) -> list[str]`
- `search_remote_raw_candidates(queries: list[str], api_key: str | None, page_size: int = 10) -> list[dict[str, Any]]`
- `best_remote_raw_candidates(results: list[dict[str, Any]], evidence: RawEvidence, signals: RawSignalScores, limit: int = 12) -> list[dict[str, Any]]`

The remote layer stays retrieval-only. It should not pick the final winner by itself.

#### `backend/server.py`

Add these helpers:

- `_resolve_raw_candidates(self, payload: dict[str, Any]) -> RawDecisionResult`
- `_retrieve_local_raw_candidates(self, evidence: RawEvidence, signals: RawSignalScores, plan: RawRetrievalPlan) -> list[dict[str, Any]]`
- `_retrieve_remote_raw_candidates(self, evidence: RawEvidence, signals: RawSignalScores, plan: RawRetrievalPlan, api_key: str | None) -> list[dict[str, Any]]`
- `_ensure_raw_card_cached(self, card: dict[str, Any], trigger_source: str) -> dict[str, Any]`
- `_build_raw_match_response(self, payload: dict[str, Any], decision: RawDecisionResult) -> dict[str, Any]`
- `_log_raw_scan_event(self, payload: dict[str, Any], decision: RawDecisionResult, response: dict[str, Any]) -> None`

Replace in `match_scan(...)`:

- raw-mode branch should call `_resolve_raw_candidates(...)`
- slab branch can remain intact for now
- response building should continue to use `topCandidates` so the app contract does not change

#### `backend/pokemontcg_pricing_adapter.py`

Rewrite persistence to:

- `upsert_price_snapshot(..., pricing_mode="raw", ...)`

#### `backend/scrydex_adapter.py`

Keep slab-focused for now, but rewrite persistence to:

- `upsert_price_snapshot(..., pricing_mode="graded", ...)`

### Raw matching stages

For raw mode, the target backend flow is:

1. extract a normalized raw evidence bundle
2. retrieve local candidates using stronger broad signals first:
   - title/name overlap
   - set overlap
   - broader footer-band support
3. query live Pokemon TCG API candidates when local evidence is weak or sparse
4. merge local and live candidates into one ranked pool
5. rerank with footer-specific signals:
   - exact collector number
   - partial collector number
   - denominator / printed-total support
   - footer set hints
6. return:
   - best candidate always
   - alternates when available
   - confidence
   - ambiguity flags
   - review disposition

### Exact route-opening logic

The backend should not choose one permanent resolver path first. It should compute signal strengths, open the relevant retrieval routes, merge candidates, and then rerank.

Signal thresholds:

- `collector_signal >= 80` and `set_signal >= 55`
  - open `collector_set_exact`
- `title_signal >= 65` and `set_signal >= 45`
  - open `title_set_primary`
- `title_signal >= 65` and `collector_signal >= 45`
  - open `title_collector`
- `title_signal >= 70`
  - open `title_only`
- `collector_signal >= 70`
  - open `collector_only`
- if no route opens but recognized text still exists
  - open `broad_text_fallback`

Retrieval order:

1. local routes first
2. remote Pokemon TCG API routes second when:
   - local candidate count is too low
   - or local top score is weak
   - or the top two local candidates are too close

### Exact score fields

#### `RawSignalScores`

Use 0-100 fields:

- `title_signal`
- `collector_signal`
- `set_signal`
- `footer_signal`
- `overall_signal`

Recommended meaning:

- `title_signal`
  - strong readable title/nameplate text
- `collector_signal`
  - exact parsed collector number is strongest
  - partial collector support is weaker
- `set_signal`
  - trusted set hints or strong set-name clues
- `footer_signal`
  - broader footer-band readability independent of exact parsed number

#### `RawCandidateScoreBreakdown`

Use 0-100 subfields:

- `title_overlap_score`
- `set_overlap_score`
- `collector_exact_score`
- `collector_partial_score`
- `collector_denominator_score`
- `footer_text_support_score`
- `promo_support_score`
- `cache_presence_score`
- `contradiction_penalty`
- `retrieval_total`
- `resolution_total`
- `final_total`

`final_total` should be the score used for ranking.

### Exact scoring rules

Retrieval weights:

- title overlap: up to `35`
- set overlap: up to `20`
- collector retrieval support: up to `15`
- footer text support: up to `10`
- promo / era / language support: up to `5`
- cache/local provider presence: up to `5`
- remaining score budget reserved for combination bonuses and light penalties

Resolution weights:

- exact collector match: up to `30`
- partial collector match: up to `15`
- denominator / printed-total support: up to `10`
- footer set confirmation: up to `10`
- footer contradiction penalty: up to `-25`

Combination bonuses:

- strong title + strong set: `+8`
- strong collector + strong set: `+10`
- title and footer both support the same candidate: `+10`

### Exact confidence logic

The returned confidence should be a percentage before it is bucketed to `high`, `medium`, or `low`.

Definitions:

- `support_percent = top_match.final_total`
- `margin_percent = clamp((top_match.final_total - runner_up.final_total) * 4, 0, 100)`
- `completeness_percent = min(100, (title_signal * 0.40) + (collector_signal * 0.40) + (set_signal * 0.20))`
- `penalty_percent = min(25, top_match.breakdown.contradiction_penalty)`

Final confidence percentage:

- `final_confidence_percent = (support_percent * 0.60) + (margin_percent * 0.25) + (completeness_percent * 0.15) - penalty_percent`

Bucket mapping:

- `high` if `final_confidence_percent >= 85`
- `medium` if `final_confidence_percent >= 65`
- `low` otherwise

Important rule:

- low confidence still returns the best candidate
- low confidence should add ambiguity flags and `needs_review`

### Confidence behavior

- `high`: exact structured support
- `medium`: strong title/set support plus partial confirmation
- `low`: best guess with weak or conflicting confirmation

The backend still returns the best candidate at low confidence.

### Raw pricing behavior

After the backend chooses a winner:

1. use the resolved `card_id`
2. check `card_price_snapshots` freshness
3. if stale or missing, refresh from Pokemon TCG API
4. return the chosen card plus pricing

### Final response rules

For raw scans:

- always return at least one best candidate if any local or live search returns candidates
- include up to three alternates when available
- set `reviewDisposition = needs_review` for weak or ambiguous cases
- attach raw pricing for the top candidate only
- preserve `topCandidates` so the app can later support explicit candidate switching

## Legacy Raw Matcher Deleted

The old collector-number-first raw path has been removed from active raw runtime behavior.

Phase 8-10 completed these deletions/migrations:

- removed raw `direct_lookup`-first routing in `backend/server.py`
- removed old raw candidate helpers in `backend/catalog_tools.py`:
  - `direct_lookup_candidate_indices`
  - `direct_lookup_has_name_support`
  - `direct_lookup_has_exact_candidate`
  - `direct_lookup_score`
- migrated raw tests away from asserting success specifically through `direct_lookup`
- kept the client-visible raw `resolverPath` as `visual_fallback` for compatibility, while the backend debug payload now reflects the new raw resolver internals

Still deferred:

- deeper cleanup of older embedding / ANN helper code and any slab-specific legacy schema/runtime paths

## Implementation Checklist

### Phase 0: Freeze the HTTP contract

Files:
- `backend/server.py`
- `Spotlight/Models/ScanModels.swift`
- `Spotlight/Services/CardMatchingService.swift`

Do:
- keep `POST /api/v1/scan/match` stable
- keep `topCandidates` as the UI contract
- optionally add a new raw resolver path label, such as `raw_hybrid`

### Phase 1: Replace schema with 3 tables

Files:
- `backend/schema.sql`
- `backend/catalog_tools.py`

Do:
- create only:
  - `cards`
  - `card_price_snapshots`
  - `scan_events`
- rewrite DB helpers around those tables

### Phase 2: Rebuild card import around `cards`

Files:
- `backend/import_pokemontcg_catalog.py`
- `backend/scrydex_adapter.py`
- `backend/server.py`
- `backend/catalog_tools.py`

Do:
- make Pokemon TCG API and Scrydex imports write the simplified `cards` row shape

### Phase 3: Build raw evidence extraction

Files:
- `backend/server.py`
- `backend/catalog_tools.py`

Do:
- add a normalized raw evidence bundle from current payload fields
- implement:
  - `build_raw_evidence`
  - `score_raw_signals`
  - `build_raw_retrieval_plan`

### Phase 4: Implement title-first raw candidate retrieval

Files:
- `backend/catalog_tools.py`
- `backend/import_pokemontcg_catalog.py`
- `backend/server.py`

Do:
- retrieve local candidates by broad evidence
- query live Pokemon TCG API when needed
- merge both sources
- implement:
  - `search_cards_local_title_set`
  - `search_cards_local_title_only`
  - `search_cards_local_collector_set`
  - `search_cards_local_collector_only`
  - `build_raw_provider_queries`
  - `search_remote_raw_candidates`
  - `merge_raw_candidate_pools`

### Phase 5: Add footer-based reranking and final decision

Files:
- `backend/catalog_tools.py`
- `backend/server.py`

Do:
- use footer collector OCR as reranking/confirmation
- always return a best candidate
- implement:
  - `score_raw_candidate_retrieval`
  - `score_raw_candidate_resolution`
  - `rank_raw_candidates`
  - `compute_raw_confidence`
  - `finalize_raw_decision`
  - `_resolve_raw_candidates`
  - `_build_raw_match_response`

### Phase 6: Rewrite pricing onto `card_price_snapshots`

Files:
- `backend/pokemontcg_pricing_adapter.py`
- `backend/scrydex_adapter.py`
- `backend/pricing_provider.py`
- `backend/catalog_tools.py`
- `backend/server.py`

Do:
- raw pricing writes `pricing_mode = raw`
- graded pricing writes `pricing_mode = graded`
- implement:
  - `upsert_price_snapshot`
  - `price_snapshot_for_card`
  - replace old raw/slab price summary reads with the unified snapshot read path

### Phase 7: Rewrite scan logging onto `scan_events`

Files:
- `backend/server.py`
- `backend/catalog_tools.py`

Do:
- log request/response/final winner/confidence in `scan_events`
- implement:
  - `_log_raw_scan_event`
  - `upsert_scan_event`

### Phase 8: Delete legacy raw logic

Files:
- `backend/server.py`
- `backend/catalog_tools.py`
- `backend/tests/test_scanner_backend.py`

Do:
- remove the old raw matcher path completely

Status:
- landed

### Phase 9: Write tests

Files:
- `backend/tests/test_scanner_backend.py`
- provider adapter test files as needed

Do:
- schema tests
- raw retrieval tests
- raw reranking tests
- low-confidence best-candidate tests
- pricing snapshot tests
- end-to-end backend match tests

Status:
- landed for the raw reset slice

### Phase 10: Delete legacy raw helper functions

Files:
- `backend/catalog_tools.py`
- `backend/server.py`
- `backend/tests/test_scanner_backend.py`

Do:
- remove dead raw helper functions that only existed for the old collector-number-first matcher
- remove stale raw exact-match/confidence branches that depended on `direct_lookup`
- rename or update stale test expectations/names so the suite reflects the new raw resolver

Status:
- landed

## Out Of Scope For This Reset

- slab OCR redesign
- slab backend redesign beyond preserving current behavior
- app UI redesign
- camera/reticle redesign
- broad OCR rewrite

Those come later.
