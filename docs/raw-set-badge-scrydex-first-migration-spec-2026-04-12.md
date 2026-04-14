# Raw Set-Badge + Scrydex-First Migration Spec

Date: 2026-04-12

## Status

- This document is the source of truth for the next raw-card backend/OCR/provider migration.
- It is additive to:
  - [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md)
  - [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md)
- Where this document conflicts with older Pokemon TCG API raw-provider assumptions, this document wins.
- Current landed state:
  - typed badge-first raw set evidence is in place
  - junk broad-OCR set hints such as `p270` are suppressed from trusted backend set evidence
  - backend badge-image matching is landed for icon-like set badges
  - raw remote retrieval, catalog hydration, and raw pricing are now Scrydex-first
  - the held-out provider manifest is now `67/67` supported through Scrydex mapping
  - the winning Scrydex visual candidate is now promoted:
    - active alias publication: `v004-scrydex-b8`
    - active held-out/runtime-shaped result: hybrid top-1 `36/67`
  - the legacy Pokemon TCG API raw helper files/tests have been deleted from active repo surfaces
  - Scrydex request-budget guardrails are now landed:
    - cached raw scans/details should issue `0` live Scrydex requests
    - first-seen visual-hybrid top-1 hydration should issue `1` Scrydex fetch-by-id request
    - non-visual remote raw fallback is capped at `2` Scrydex search queries max
    - `GET /api/v1/ops/provider-status` exposes `scrydexRequestStats`

## Why This Shift Exists

- The current raw pipeline is visual-first and OCR-second, but set evidence is still too generic.
- The current `setHints` bucket mixes:
  - text-like badge reads
  - fuzzy broad-footer/header OCR
  - junk tokens such as `p270`
- That is structurally wrong for cards whose set indicator is:
  - a text badge like `DRI`
  - a symbol-only badge with no OCR-readable text
- Japanese cards are not first-class in the current provider-backed visual/reference flow.
- The current Pokemon TCG API-backed raw lane is materially incomplete for Japanese identity/reference coverage.

## Core Decisions

### 1. Raw set evidence becomes badge-first, not broad-text-first

- Trusted raw set evidence may only come from the dedicated set-badge region.
- Broad footer/header OCR may still exist for debugging, but it must not become trusted set evidence by default.
- Junk values like `p270` must not become a meaningful set hint.

### 2. Set badge evidence is typed

- The raw OCR output must move from one free-form `setHints` bucket to a typed badge signal:
  - `text`
  - `icon`
  - `unknown`
- Canonical set tokens are derived from the badge signal, not directly from broad OCR text.

### 3. Japanese is a first-class raw identity lane

- Japanese raw cards must be treated as canonical identities, not English approximations.
- The raw identity/reference provider lane should be Scrydex-first.
- Japanese cards must be allowed in the visual/reference corpus as normal supported cards.

### 4. Scrydex becomes the raw provider target

- End state:
  - raw identity source = Scrydex
  - raw reference-image source = Scrydex
  - raw pricing source = Scrydex
- Pokemon TCG API should be treated as legacy/deprecated for raw runtime.
- Deletion of the Pokemon TCG API raw lane only happens after Scrydex parity is validated.

## Current Problems To Solve

### Problem A: Set hints are too generic

Current bad behavior:

- `RawConfidenceModel` extracts set hints from broad footer/header OCR text.
- Those values are currently serialized as if they were meaningful set evidence.
- Backend raw evidence currently defaults untrusted set hints into `trustedSetHintTokens` too aggressively.

Examples:

- `DRI` in a printed badge can be a useful badge-text signal.
- `p270` from `HP 270` is not a useful set signal at all.
- Japanese symbol-only set marks cannot be recovered correctly by text OCR alone.

### Problem B: Japanese cards are provider-gapped

Current bad behavior:

- The provider-backed visual/reference manifest still has unsupported Japanese truth keys.
- Example:
  - `Eevee & Snorlax GX | 066/095 | SM9`
  - `providerSupported: false`
  - `mappingReason: "No provider candidate was found."`

Meaning:

- the true card has no reference image in the current provider-backed index
- visual matching cannot return the right card because the right card is absent

### Problem C: Raw identity and raw pricing are still split across legacy assumptions

Current bad behavior:

- raw runtime still assumes Pokemon TCG API for the primary raw provider lane
- Scrydex is only partially used:
  - Japanese raw search fallback
  - slab identity/pricing
- this is not good enough if Japanese raw support is a first-class requirement

## Target Architecture

### App side

- Capture and normalization remain unchanged in principle:
  - capture frame/photo
  - select target
  - perspective-correct / canonicalize
  - generate normalized image
- OCR continues to run locally on the normalized image.
- Raw OCR now outputs:
  - title evidence
  - collector evidence
  - `setBadgeHint`
  - broad debug text
- The app still sends:
  - normalized image
  - OCR analysis payload
  to the backend.

### Backend side

- Backend still does:
  - visual retrieval first
  - OCR rerank second
- Raw set evidence is only trusted when it comes from a typed badge signal.
- Raw provider target becomes Scrydex-first for:
  - remote raw retrieval
  - catalog hydration
  - raw pricing
- Current Pokemon TCG API runtime assumptions are treated as transitional debt.

## New Data Contracts

### Raw set badge signal

New typed concept:

```json
{
  "setBadgeHint": {
    "kind": "text",
    "rawValue": "DRI",
    "canonicalTokens": ["dri"],
    "confidence": {
      "score": 0.78,
      "agreementScore": 0.74,
      "tokenConfidenceAverage": 0.83,
      "reasons": ["raw_set_badge_ocr"]
    },
    "source": "badge_ocr"
  }
}
```

Allowed `kind` values:

- `text`
- `icon`
- `unknown`

Allowed `source` values:

- `badge_ocr`
- `badge_icon`
- `badge_fused`
- `none`

Rules:

- `canonicalTokens` are the only set tokens that may become trusted backend set evidence by default.
- `setHints` may remain as a compatibility field temporarily, but must be derived from `setBadgeHint.canonicalTokens`, not broad OCR junk.

## Implementation Phases

### Phase 1: Typed badge contract + junk suppression

Scope:

- Add `setBadgeHint` to app OCR data contracts.
- Stop trusting broad OCR set-hint tokens by default.
- Suppress obvious junk tokens such as `p270`.
- Keep icon matching unimplemented for now by returning `unknown` when no badge-text signal is strong.

Expected outcome:

- `DRI`-style badge text continues to help.
- icon-only Japanese badges no longer emit fake text hints.
- backend no longer over-trusts broad OCR junk.

### Phase 2: Badge-text-only trusted path

Scope:

- `RawConfidenceModel` resolves trusted raw set evidence from the dedicated badge ROI only.
- broad footer/header hint mining may remain for debugging, but not trusted matching.

Expected outcome:

- set evidence quality improves immediately
- false set signals stop dragging hybrid ranking around

### Phase 3: Scrydex-first raw backend routing

Scope:

- raw remote candidate search becomes Scrydex-first
- raw catalog hydration becomes Scrydex-first
- raw pricing becomes Scrydex-first
- health/provider status should report Scrydex as the active raw pricing provider

Important dependency:

- This phase is safe to land before a full visual-index rebuild as long as legacy visual candidates can still be hydrated and displayed.
- Full deletion of Pokemon TCG API raw runtime should wait until the Scrydex-based visual/reference artifacts are ready.

### Phase 4: Scrydex-backed visual/reference tooling

Scope:

- provider reference manifest generation becomes Scrydex-first
- visual training-manifest mapping becomes Scrydex-first
- full visual reference index build becomes Scrydex-backed
- retrain the visual adapter on the Scrydex-backed reference corpus

Expected outcome:

- Japanese cards become first-class supported entries in the visual/reference lane
- visual runtime no longer depends on Pokemon TCG API coverage gaps

### Phase 5: Badge icon matching

Scope:

- add a set-badge icon matcher for symbol-only badges
- badge classification output can emit:
  - `kind = icon`
  - canonical set tokens from the icon library

Important:

- Start with a reference-library/template/embedding matcher.
- Do not start with a custom classifier unless the reference-library approach is insufficient.

## Raw Set Rules

### What counts as trusted raw set evidence

- badge OCR text from the dedicated badge ROI
- badge icon classification from the dedicated badge ROI
- fused badge result from both of the above

### What does not count as trusted raw set evidence

- `HP` values
- arbitrary broad footer text fragments
- whole-card OCR text that merely resembles a set token
- header text fragments

### Badge-first modality rule

The set system should not be:

- always OCR
- always icon

It should be:

- always badge-based
- then interpreted as:
  - `text`
  - `icon`
  - `unknown`

## Scrydex Migration Rules

### Raw identity

- Scrydex becomes the intended raw identity provider.
- Japanese raw should no longer be treated as a side-lane.
- English and Japanese raw identities should resolve from the same provider family where feasible.

### Raw pricing

- Scrydex becomes the active raw pricing provider target.
- Pokemon TCG API raw pricing becomes legacy/deprecated.

### Visual/reference artifacts

- New reference manifests and indexes should use Scrydex card IDs and Scrydex reference images.
- Do not silently mix old Pokemon TCG API reference IDs with new Scrydex IDs in the same runtime contract without explicit mapping.

## Validation Requirements

Before keeping each phase:

1. run the raw OCR regression suite
2. run the raw visual hybrid regression suite
3. verify a known text-badge case
4. verify a known icon-only Japanese case
5. verify provider status / active raw pricing provider

Minimum target checks:

- junk set hints like `p270` are not trusted
- `DRI`-style badges still help
- Japanese unsupported-card cases improve under Scrydex-backed tooling
- active raw pricing provider reports Scrydex after the provider flip

## Immediate Next Implementation Slice

The first code slice tied to this spec should do all of the following:

1. add the typed `setBadgeHint` contract
2. stop defaulting generic `setHints` into trusted backend set evidence
3. change raw set extraction so trusted hints come from the badge ROI path only
4. move raw provider defaults toward Scrydex-first runtime behavior

The first code slice should not yet try to land the full badge icon matcher.

## Explicit Non-Goals For The First Slice

- full badge icon classifier/model training
- full deletion of all Pokemon TCG API code on day one
- retuning every OCR ROI
- changing visual-first architecture back to OCR-first
- using broad footer/header OCR as if it were canonical set identity
