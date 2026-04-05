# Resolver Router Implementation Spec

Date: 2026-04-03

Purpose: define the resolver-router scanner architecture and document what has already been implemented.

This spec is still the active design doc, but it now also reflects the current implemented baseline.

Related current docs:

- [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md)
- [live-scan-stack-ocr-first-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/live-scan-stack-ocr-first-spec-2026-04-03.md)

## Decision Summary

Do not build one universal resolver.

Build a `resolver router` with mode-specific resolvers:

- `raw_card_resolver`
- `psa_slab_resolver`
- `unknown_fallback_resolver`

Routing should happen before identity resolution.

The scanner should decide:

- what kind of object is in the frame
- which resolver should handle it
- which pricing surface should be shown for that object

## Current Implementation Status

Implemented already:

- tray-first scanner UX
- immediate pending-row insertion
- candidate-pricing hot path
- deferred idle refresh
- `resolverModeHint` in the scan contract
- raw-card direct lookup
- PSA-label routing and lookup
- fallback visual retrieval
- slab pricing context note in the UI

Still not fully implemented:

- explicit `routingConfidence` and `routingReasons` in the public API
- dedicated set-symbol classifier
- grade-specific slab pricing
- true image regressions for the uploaded chat-only photo batch

## Scan Latency Strategy

Fast scanning matters more than eager detail loading.

The scanner should optimize for:

- one fast identity request
- immediate row insertion
- immediate cached/local price display when available
- background refresh only after the user pauses

It should not do this on every successful scan:

- fetch a separate detail payload immediately
- fetch a separate live price payload immediately
- show a blocking loading state before the row appears

### Hot Path Rule

For every successful scan:

1. identify card
2. use candidate pricing already returned by the match response
3. insert row into the live stack immediately
4. keep camera flow uninterrupted

### Background Refresh Rule

Live refresh should be:

- deferred
- low-priority
- triggered after a short idle window

The app should assume the user may scan several cards back-to-back during a negotiation.

So:

- do not trigger a network refresh for every scan in a burst
- cancel older auto-refresh work when a new scan happens
- refresh the newest row once scanning pauses

### User-Initiated Refresh Rule

If the user explicitly taps refresh:

- fetch latest pricing immediately
- show explicit loading state for that row only
- do not block the rest of the scanner

### Detail Fetch Rule

The detail endpoint is not part of the hot path anymore.

In v1:

- the stack row should render from match candidate data alone
- detail fetches should be lazy or omitted unless needed for a later screen

This keeps scan-to-stack latency low and avoids extra network round-trips on bad event Wi-Fi.

### Auto-Accept Rule

The app should not auto-accept every non-low result.

Current implemented rule:

- `high` confidence: auto-accept
- `medium` confidence from `direct_lookup` or `psa_label`: auto-accept
- `medium` confidence from `visual_fallback`: review
- `low` confidence: review

This protects against silent bad matches on unusual/custom/fake cards.

## Why This Exists

The current app is optimized for modern raw Pokemon cards:

- bottom-strip OCR
- collector number extraction
- set hint parsing
- direct lookup
- visual fallback

That is correct for many raw cards, but it is not the best path for slab photos.

For PSA slabs, the top label often contains the strongest structured signal:

- year
- brand/set
- card name
- card number
- grade
- cert

Forcing slab images through the raw bottom-strip resolver is slower, less reliable, and harder to explain.

## Active Scope

### In Scope

- routing one scanned photo into the right resolver
- `raw_card_resolver`
- `psa_slab_resolver`
- `unknown_fallback_resolver`
- compact scan-stack rows on the same scanner screen
- per-mode confidence rules
- per-mode pricing behavior
- telemetry that records route choice and correction behavior

### Out Of Scope

- baseball or sports cards
- BGS/CGC slab support
- multi-card-in-one-photo scanning
- deal log
- inventory management
- bundle totals
- marketplace or selling workflows

## Resolver Modes

## `raw_card_resolver`

Use when the capture appears to be:

- a raw card
- a sleeved card
- a top-loaded card
- a one-touch or semi-rigid holder without a grading label

Main signals:

- card body fills most of the frame
- no PSA-style label region
- bottom metadata strip is visible or partially visible

Primary path:

1. detect and crop the card
2. orient it upright
3. OCR bottom strip
4. extract:
   - collector number
   - promo code
   - set hint tokens
5. direct catalog lookup
6. if weak, run visual fallback

Price behavior:

- show raw-card pricing

## `psa_slab_resolver`

Use when the capture appears to be:

- a PSA slab

Main signals:

- slab silhouette
- PSA red/white label at top
- card occupies lower portion of a plastic slab

Primary path:

1. detect slab
2. isolate top label first
3. OCR label
4. extract:
   - grader
   - cert number
   - grade
   - year
   - set/brand text
   - card name
   - card number if present
5. direct lookup against slab-aware catalog or slab-specific mapping
6. only if weak, inspect the card body and/or run visual fallback

Price behavior:

- show grade-specific slab pricing when available
- never silently show raw pricing as if it were slab pricing
- if slab pricing is unavailable, explicitly label fallback pricing as `Raw proxy` or `Price unavailable`

## `unknown_fallback_resolver`

Use when:

- the router cannot confidently decide between raw and slab
- OCR is weak
- crop is weak
- the object is unusual

Primary path:

1. run hybrid visual retrieval
2. use OCR to rerank
3. return top candidates
4. likely open correction sheet more often than direct paths

Price behavior:

- use candidate pricing if confidence is acceptable
- otherwise require confirmation first

## Router Contract

Ideal router response should return:

- `resolverMode`
  - `raw_card`
  - `psa_slab`
  - `unknown_fallback`
- `routingConfidence`
  - `high`
  - `medium`
  - `low`
- `routingReasons`
- `regionsOfInterest`
  - card bounds
  - slab bounds if any
  - top label bounds if any
  - bottom-strip bounds if any

### Current Implemented Router Response

The current API already returns:

- `resolverMode`
- `resolverPath`

It does not yet return:

- `routingConfidence`
- `routingReasons`
- explicit `regionsOfInterest`

### Initial Router Heuristics

V1 routing should use simple heuristics, not a full ML classifier.

Suggested signals:

- top label text density in the upper 18-22% of the image
- strong presence of PSA label colors / layout
- slab-like outer rectangle plus inner card rectangle
- card-only crop with Pokemon-card aspect ratio
- whether the lower metadata strip is readable

### V1 Routing Rules

Route to `psa_slab_resolver` if:

- slab silhouette is detected and
- upper label region OCR is strong enough or
- image layout strongly resembles a PSA slab

Route to `raw_card_resolver` if:

- a single card rectangle is detected and
- no PSA label is detected

Route to `unknown_fallback_resolver` if:

- both routes are weak
- crop confidence is poor
- multiple conflicting signals exist

## Detailed Pipelines

## Raw Card Pipeline

### Client

1. capture photo
2. detect single card rectangle
3. crop and normalize
4. OCR:
   - full card
   - name/header
   - bottom strip
   - bottom-left
   - bottom-right
5. parse:
   - collector number
   - promo code
   - set hint tokens
6. send lightweight request first without image bytes if direct lookup is likely
7. retry with image bytes only if direct lookup is weak

### Backend

1. direct lookup by normalized `set/promo + number`
2. rank candidates by:
   - exact number match
   - set hint match
   - name overlap
3. if no strong candidate:
   - visual retrieval
   - metadata retrieval
   - merge shortlist
   - rerank

## PSA Slab Pipeline

### Client

1. capture photo
2. detect slab bounds
3. isolate top label region
4. OCR top label with higher priority than card body
5. optionally OCR cert line separately
6. optionally OCR card body as secondary signal
7. send label-first request

### Backend

1. try direct slab lookup by:
   - cert number
   - year + set + name + number + grade
2. if no slab-specific match:
   - try raw card identity from label/card name
   - mark pricing as raw proxy or unavailable
3. if still weak:
   - run visual fallback on card area

## Unknown Fallback Pipeline

### Client

1. send crop, OCR text, and image bytes

### Backend

1. visual retrieval
2. metadata retrieval
3. rerank
4. return alternates aggressively

## API Changes

The scan API should add:

- `resolverModeHint`
- `routingConfidence`
- `routingReasons`
- `labelRecognizedText`
- `labelTokens`
- `cardBodyRecognizedText`
- `pricingMode`
  - `raw`
  - `psa_grade`
  - `raw_proxy`
  - `unavailable`

Response should add:

- `resolverPath`
  - existing
- `resolverMode`
  - `raw_card`
  - `psa_slab`
  - `unknown_fallback`
- `pricingMode`
- `pricingWarning`

## Confidence Rules

## Raw Card Confidence

High confidence if:

- exact collector number match and
- set hint matches and
- crop confidence is acceptable

Medium confidence if:

- exact collector number match but weak set hint
- or partial number match plus strong visual support

Low confidence if:

- collector number missing
- multiple same-name candidates remain close
- crop/OCR quality is weak

## PSA Slab Confidence

High confidence if:

- cert number matches exactly
- or label fields strongly match one card and one grade

Medium confidence if:

- label identifies the card but grade-specific pricing is missing

Low confidence if:

- label OCR is weak
- slab is detected but card identity is still ambiguous

## UI Behavior

The primary screen remains the scanner stack.

Each successful scan adds a row with:

- thumbnail
- card name
- set / number or slab label summary
- one primary price
- source / freshness

Expanded row can show:

- low
- market
- mid
- high
- grade if slabbed
- pricing mode
- source
- refresh

For slab rows, compact subtitle should prefer:

- `PSA 10 • Team Up #170`

not just:

- raw set / number

## Telemetry Requirements

Log these fields for every scan:

- `resolverMode`
- `routingConfidence`
- `routingReasons`
- `resolverPath`
- `pricingMode`
- whether lightweight lookup succeeded without image bytes
- whether visual fallback was required
- whether user corrected the result

This matters because the moat is not just successful matches.
It is:

- which route was chosen
- which route was wrong
- which photos systematically fail
- which slab labels OCR well
- which raw-card bottom strips fail under glare

## Catalog Requirements

### For Raw Cards

Need:

- card ID
- name
- set name
- set ID / set code
- printed number
- promo code when relevant
- raw pricing

### For PSA Slabs

Need either:

- direct slab records

or at minimum:

- mapping from label fields to raw card identity
- explicit ability to say slab price unavailable

Do not fake slab support by returning raw prices without labeling them.

## Implementation Order

### Phase 1

- add router layer
- add `resolverMode` to payloads and responses
- keep current raw resolver intact
- add route telemetry

### Phase 2

- add `psa_slab_resolver`
- add label OCR regions
- add slab-specific UI subtitle and pricing mode labels

### Phase 3

- improve routing heuristics
- add dedicated set-symbol recognition for raw cards
- add better slab-pricing integration

## Acceptance Criteria

This spec is implemented correctly when:

1. raw modern Pokemon cards still resolve through bottom-strip direct lookup first
2. PSA slab photos route to label-first logic
3. scanner rows stay on the same screen
4. slab scans do not pretend raw prices are slab prices
5. telemetry records which resolver handled each scan
6. low-confidence routes still surface corrections quickly

## Open Questions

- where slab-specific pricing will come from
- whether cert numbers will be used as first-class lookup keys
- whether Japanese raw cards should stay in fallback mode initially
- how broad the first PSA-supported catalog slice should be

## Recommendation

Approve this spec, then build in this order:

1. router contract and telemetry
2. raw-card resolver cleanup under the router
3. PSA slab resolver
4. pricing-mode display

That keeps the current raw-card scanner working while adding the right architecture for the photo mix you are already seeing.
