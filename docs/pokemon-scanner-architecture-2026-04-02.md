# Pokemon Card Scanner Architecture

Date: 2026-04-02

Update: see [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md) for the current source of truth. This document is still useful background, but the preferred Pokemon v1 path is now `bottom-strip resolver first, visual fallback second`.

Goal: Define the best practical architecture for a show-floor Pokemon card scanner that must still be usable on bad internet.

## Recommendation

Use a `hybrid architecture`:

- on-device capture, crop, quality checks, and OCR
- server-side candidate matching against the full card catalog
- local offline cache for recent cards and hot-card subsets

Do not start with:

- fully cloud-only matching
- fully on-device full-catalog matching

The best first build is:

1. iPhone captures one card photo
2. App crops and normalizes the card on-device
3. App extracts lightweight signals on-device
4. App sends a small payload to a matching service
5. Service returns top candidate matches plus confidence
6. App lets user confirm or correct

That is the best tradeoff between speed, accuracy, and implementation risk.

## Why This Is The Best Approach

### Pure cloud is too fragile for show floors

If the app sends a full raw image to the server and waits for everything remotely:

- weak internet kills responsiveness
- uploads are larger than they need to be
- users will lose trust during spotty connectivity

### Pure on-device is too ambitious for v1

A fully offline matcher across the whole Pokemon catalog sounds attractive, but it is the wrong first battle because:

- building and updating a full high-quality on-device model is hard
- variant and foil disambiguation are difficult
- catalog updates become a deployment problem
- you will still need pricing and metadata services later

### Hybrid lets you ship sooner

The phone should do the fast deterministic work locally.

The server should do the expensive catalog retrieval work.

That gives you:

- lower payload size
- faster perceived response
- better degraded-network behavior
- simpler iteration on matching quality

## What Other Scanners Appear To Do

Public docs strongly suggest this pattern:

- `TCGplayer` identifies largely from artwork, warns that identical artwork across sets causes mistakes, and exposes confidence levels plus manual correction.
- `PriceCharting` returns best matches and explicitly warns on low confidence.
- `PSA` shows a carousel of likely matches from a card photo.
- `Ludex` says it uses image recognition and analyzes finish, reflectivity, color, and texture for difficult variants.

This implies the common production pattern is:

1. detect card
2. crop / normalize
3. generate candidate matches
4. use metadata and finish cues to disambiguate
5. return top candidates with confidence

Sources:

- TCGplayer scanning tips: https://help.tcgplayer.com/hc/en-us/articles/115009674788-Tips-for-Accurate-Scanning
- TCGplayer Scan & Identify: https://help.tcgplayer.com/hc/en-us/articles/27303403772823-How-To-Use-Scan-Identify
- TCGplayer technology notes: https://help.tcgplayer.com/hc/en-us/articles/27303183354007-How-Scan-Identify-Technology-Works
- PriceCharting app page: https://www.pricecharting.com/page/app
- PSA Snap to Submit: https://www.psacard.com/articles/articleview/11053/snap-to-submit-in-the-psa-app
- Ludex lighting article: https://www.ludex.com/blog/trading-card-university/how-lighting-affects-trading-card-scan-accuracy-in-ludex/

## Recommended System Architecture

## Client Responsibilities

The iPhone app should do all of this before any network call:

- detect the card rectangle
- perspective-correct the image
- crop tightly
- reject obviously bad images
- run OCR on the likely text regions
- compress the upload
- cache recent results locally

This should be built with iOS-native tooling first.

Apple primitives that fit this:

- `VNDetectRectanglesRequest` for rectangular region detection
- `VNRecognizeTextRequest` for OCR
- `VNGenerateImageFeaturePrintRequest` or a Core ML embedding model for local image fingerprints

Sources:

- Rectangle detection: https://developer.apple.com/documentation/vision/vndetectrectanglesrequest
- Text recognition: https://developer.apple.com/documentation/vision/vnrecognizetextrequest
- Vision feature prints: https://developer.apple.com/documentation/vision/vngenerateimagefeatureprintrequestrevision1
- Core ML overview: https://developer.apple.com/documentation/CoreML

## Server Responsibilities

The server should do:

- candidate retrieval from the Pokemon catalog
- reranking
- confidence scoring
- metadata assembly
- later, pricing lookup

The server is where you want the full catalog intelligence, because:

- catalog changes do not require app updates
- ranking logic can iterate quickly
- pricing and identity data can live in one place

## Matching Pipeline

Recommended pipeline:

### Step 1. Capture

Input:

- one front photo of one card

Rules:

- portrait orientation
- plain background preferred
- entire card visible

### Step 2. On-device crop and normalization

Use rectangle detection and perspective correction to produce:

- cropped card image
- normalized orientation
- normalized size

Reject or warn on:

- low sharpness
- severe glare
- partial card
- multiple card-like rectangles

### Step 3. On-device signal extraction

Extract lightweight signals:

- OCR text candidates
- probable collector number
- set symbol region crop
- image fingerprint / embedding

### What OCR Is Actually Doing

OCR should be treated as a `supporting signal`, not the main matcher.

For this scanner, OCR is not:

- reading the entire card perfectly
- creating text embeddings for every card in the catalog
- replacing image comparison

Instead, OCR should do narrower, high-value extraction:

- collector number like `223/197`
- promo number like `SVP 056`
- card name when readable
- HP or other large text when useful

Then that extracted text should be normalized and used to narrow or rerank image candidates.

Recommended mental model:

1. image retrieval finds visually similar cards
2. OCR extracts a few useful text tokens
3. those tokens help break ties between near-identical candidates

Example:

- the image matcher thinks the card is one of 5 Charizard variants
- OCR finds `223/197`
- the reranker boosts the candidate whose catalog number matches `223/197`

That is much more reliable than trying to identify Pokemon cards from OCR alone.

Important:

Do not depend entirely on OCR.

Pokemon OCR is noisy because:

- stylized fonts
- holo glare
- tiny collector numbers
- multilingual cards

OCR-only matching would fail often because:

- many cards share the same name
- text can be partially obscured by glare or cropping
- the collector number is small and easy to miss
- promo and set variants often require visual comparison, not just text

### Step 4. Server-side candidate retrieval

Use the image fingerprint or embedding to retrieve top-K likely matches from the catalog.

Then narrow candidates with:

- OCR card number if found
- language hint
- card border / era hint
- rarity or finish hint if available

The practical data structures for OCR are usually:

- exact lookup on normalized collector number
- fuzzy lookup on card name
- optional indexed fields for language and set

Not:

- semantic text embeddings across the whole catalog as the primary retrieval method

### Step 5. Reranking

Rerank the top candidates using a weighted score across:

- artwork similarity
- collector number match
- set match
- frame / era similarity
- finish / parallel cues
- OCR consistency

### Step 6. Confidence scoring

Return:

- best match
- top 3 to 5 alternatives
- confidence level
- reasons or flags

Example flags:

- same artwork appears in multiple sets
- collector number unreadable
- foil / non-foil ambiguous
- promo vs set card ambiguity

### Step 7. Client confirmation

If confidence is high:

- show the best match first

If confidence is medium or low:

- show alternate matches immediately
- make manual search one tap away

## How Retrieval Actually Works

This section explains the retrieval system more concretely.

### The simple mental model

You do not compare the scanned image against every card image one by one at runtime.

Instead:

1. precompute a vector for every reference card image
2. store those vectors in a nearest-neighbor index
3. turn the scanned card into one query vector
4. ask the index for the nearest vectors
5. rerank only that small candidate set

So the runtime flow is:

- `1 query vector -> top K candidates`

Not:

- `1 query vector -> compare against all 100k vectors manually`

### What the catalog build does

Offline batch job:

1. take each reference card image
2. run the same embedding model on it
3. store:
   - `card_id`
   - `image_id`
   - `embedding`
   - metadata
4. add that embedding to an ANN index

ANN means `approximate nearest neighbor`.

That is the data structure that makes search fast.

Examples of ANN systems:

- HNSW
- FAISS
- ScaNN
- pgvector with ANN indexing

The key point is:

- you pre-index the vectors once
- then query-time lookup is fast

### What happens at scan time

At scan time:

1. user scans one card
2. app crops and normalizes it
3. the same embedding model turns it into a query vector
4. query vector is sent to the index
5. index returns top 20 or top 50 nearest matches quickly
6. only those candidates are reranked

So yes, cosine similarity is part of the idea, but you do not brute-force cosine similarity against the entire catalog on every request.

You usually do one of these:

- cosine similarity on normalized vectors
- dot product on normalized vectors
- Euclidean distance

And the ANN index gives you the top nearest items efficiently.

### Why this is fast enough

Because:

- embedding generation is one pass through a model
- ANN lookup is sublinear and optimized
- reranking only touches a tiny subset

For your scale, 100k vectors is not remotely a scary number if the index is built correctly.

## Where OCR Fits Technically

OCR is not a second full embedding retrieval system in v1.

You probably do not want:

- image retrieval over the whole catalog
- then text embedding retrieval over the whole catalog again

That is unnecessary.

The better pattern is:

1. image retrieval gets top K visual candidates
2. OCR extracts structured tokens
3. those tokens rerank the K candidates

### Example OCR outputs

From the scanned card you might extract:

- `charizard ex`
- `223/197`
- `svp 056`
- `hp 330`

Then you use those as structured filters or scoring boosts.

Examples:

- exact match on collector number is a huge boost
- fuzzy match on card name is a medium boost
- promo code match is a huge boost
- no OCR result is acceptable, not fatal

So in practice OCR is often:

- exact string compare
- normalized field lookup
- fuzzy text match

Not:

- text embeddings over the whole catalog as the main search method

### Why OCR comes after image retrieval

Because image retrieval is better at answering:

- what cards look like this?

OCR is better at answering:

- which of these similar-looking cards has the right text?

That is why OCR should usually work on the narrowed candidate set.

## Recommended Scoring Strategy

A practical reranker score might look like:

- `0.55 * image_similarity`
- `0.25 * collector_number_score`
- `0.10 * name_score`
- `0.05 * set_score`
- `0.05 * finish_or_variant_score`

The exact weights will change over time.

The point is:

- image similarity gets you close
- OCR and metadata break ties

## Confidence Logic

Confidence is not magic.

It is a function of:

- how far above the next-best candidate the top match is
- whether OCR agrees with the top match
- whether collector number matched exactly
- whether there are ambiguity flags
- whether image quality was poor

Simple example:

High confidence:

- top image candidate clearly beats the others
- collector number matches exactly
- no ambiguity flags

Medium confidence:

- top candidate is only moderately better
- OCR partial match
- possible variant ambiguity

Low confidence:

- top 3 candidates are close
- OCR missing or conflicting
- glare / blur / partial crop

## Moat-Oriented Data Model

The moat is not the catalog itself.

The moat is the real-world labeled scan data you accumulate.

You want to store enough information to answer:

- what did the model predict?
- what did the user actually choose?
- why did it fail?
- what conditions caused the failure?

### Core entities

Recommended high-level tables or collections:

- `cards`
- `card_images`
- `card_embeddings`
- `scan_sessions`
- `scan_events`
- `scan_candidates`
- `scan_feedback`

## Catalog-side schema

### `cards`

Fields:

- `card_id`
- `name`
- `set_name`
- `set_code`
- `card_number`
- `rarity`
- `variant`
- `language`
- `release_date`
- `normalized_name`
- `normalized_number`

### `card_images`

Fields:

- `image_id`
- `card_id`
- `image_url`
- `image_type`
  - reference_front
  - alternate_reference
- `source`
- `width`
- `height`
- `hash`

### `card_embeddings`

Fields:

- `embedding_id`
- `image_id`
- `card_id`
- `model_version`
- `embedding_vector`
- `created_at`

Important:

- version your embeddings
- never assume all historical embeddings came from the same model forever

## Runtime scan-side schema

### `scan_sessions`

Fields:

- `session_id`
- `user_id` or `device_id`
- `show_id` if available
- `device_model`
- `app_version`
- `network_state`
- `started_at`

### `scan_events`

One row per attempted scan.

Fields:

- `scan_id`
- `session_id`
- `captured_at`
- `raw_image_path` or temporary blob reference
- `cropped_image_path`
- `crop_polygon`
- `blur_score`
- `glare_score`
- `crop_confidence`
- `ocr_text_raw`
- `ocr_tokens`
- `ocr_confidence`
- `embedding_model_version`
- `query_embedding_vector` or pointer
- `match_status`
  - matched
  - corrected
  - abandoned
  - queued_offline

### `scan_candidates`

Store the candidates returned for each scan.

Fields:

- `scan_id`
- `rank`
- `card_id`
- `image_similarity_score`
- `collector_number_score`
- `name_score`
- `final_score`
- `confidence_label`
- `ambiguity_flags`

This table matters a lot because later it tells you:

- what was almost chosen
- which cards confuse the model
- where reranking failed

### `scan_feedback`

Store the final human-labeled outcome.

Fields:

- `scan_id`
- `selected_card_id`
- `was_top_prediction`
- `correction_type`
  - accepted_top
  - chose_alternative
  - manual_search
  - abandoned
- `time_to_selection_ms`
- `selected_at`

This is one of the most important moat tables.

It converts raw scan traffic into labeled training data.

## Why This Creates A Moat

After enough real scans, you will know:

- which cards are commonly confused
- which lighting conditions break matching
- which variants need more reference images
- where OCR is reliable and where it is useless
- which features predict correction risk

That lets you improve:

- reranking weights
- confidence thresholds
- augmentation strategy
- reference-image coverage
- future fine-tuned models

That is much harder to copy than simply collecting catalog images.

## Recommended Data Contract

For the first version, the scanner service should return at least:

- `card_id`
- `name`
- `set_name`
- `card_number`
- `rarity`
- `variant`
- `language`
- `image_url`
- `confidence_score`
- `confidence_label`
- `ambiguity_flags[]`
- `alternate_matches[]`

This is enough to support the UI before pricing exists.

## Offline Strategy

This is the important part for shows.

Do not promise full offline matching in v1.

Instead, build `degraded-mode support`.

### V1 offline strategy

When internet is weak:

- still allow capture
- still crop and OCR on-device
- still show local quality warnings
- try request with a tiny payload first
- if request fails, queue the scan locally
- allow manual search against a cached lightweight catalog subset

This gives users something useful even on bad WiFi, without overcommitting.

### What to cache locally

For v1:

- recent confirmed scans
- recent search results
- top sets / top cards likely to appear at the show
- minimal metadata for cached cards
  - name
  - set
  - number
  - thumbnail

For v2:

- local embedding index for a hot subset of cards
- lightweight set-symbol and collector-number lookup tables

### Why this matters

The best bad-internet behavior is:

- capture still works
- the app feels responsive
- if matching cannot complete now, the user understands why
- the scan is not lost

That is much better than pretending you are fully offline-capable when you are not.

## Recommended Phase Plan

### Phase 0: Prove scan identity

- capture one photo
- crop and normalize
- send to matcher
- return top candidates
- user confirms or corrects

### Phase 1: Improve resilience

- local queue for failed scans
- cached recent cards
- better OCR
- better confidence logic

### Phase 2: Add pricing on confirmed match

- once identity is confirmed, fetch pricing
- keep identity and pricing services logically separate

### Phase 3: Add bundle accumulation

- only after single-card identity and pricing are stable

## Recommended Tech Shape

Pragmatic v1 stack:

- iOS app
  - AVFoundation for camera
  - Vision for rectangle detection and OCR
  - local SQLite or Core Data cache
- API service
  - scan match endpoint
  - search endpoint
  - future pricing endpoint
- catalog store
  - Pokemon card metadata
  - card images / reference crops
  - precomputed embeddings
- ANN retrieval layer
  - top-K nearest-neighbor search over card embeddings

## What Not To Do First

- do not solve full bundle scanning first
- do not solve full offline full-catalog matching first
- do not couple pricing tightly into the first identity pipeline
- do not hide low confidence behind a fake single answer

## Biggest Risks

### 1. Wrong variant with right artwork

Pokemon has many near-identical prints.

### 2. Promo vs main-set ambiguity

Artwork alone is often not enough.

### 3. Holo / reverse holo / special finish ambiguity

Lighting and reflectivity matter.

### 4. Overpromising offline support

Bad trust hit if users think it works offline and it silently fails.

## Final Recommendation

Build a `hybrid single-card scanner` first:

- on-device crop, OCR, quality gating
- server-side candidate retrieval and confidence
- local degraded-mode caching for bad internet

That is the fastest path to a usable product and the lowest-risk architecture for a show-floor environment.
