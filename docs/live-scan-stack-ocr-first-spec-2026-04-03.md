# Live Scan Stack + OCR-First Resolver Spec

Date: 2026-04-03

Update: see [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md) for the current single-source project summary. This document remains the detailed design appendix for the active product direction.

Goal: lock the product and technical direction for the next phase before implementing more scanner UX.

This document replaces the earlier assumption that the primary v1 flow should be:

- scan one card
- navigate to a detail page
- go back
- scan again

For Pokemon, that is not the right event-floor interaction.

## Decision

Active product direction:

- one persistent `Live Scan Stack` screen
- Pokemon-first
- bottom-strip resolver first
- visual retrieval second
- no dedicated detail page in the primary scan loop

The primary flow should feel like:

- `scan -> card snaps into stack -> next scan`

Not:

- `scan -> navigate to detail -> back -> scan again`

## Why This Is The Right Cut

For event use, speed matters more than depth.

Users do not want to be pushed into a detail page after every scan.

They want:

- a fast identity result
- one trusted primary price
- a compact running list
- the ability to scan the next card immediately

That means the scan surface itself should become the main product.

## Pokemon Resolver Decision

For Pokemon, the primary resolver should not be full-image retrieval.

It should be:

1. crop the card
2. read the bottom strip
3. extract:
   - collector number like `223/197`
   - promo code like `SVP 056`
   - set symbol / set code
4. do a direct catalog lookup
5. only if that fails, fall back to visual retrieval

### Reliable mental model

For Pokemon identification:

- collector number alone is not enough
- set symbol or promo prefix alone is not enough
- `set + collector number` is usually enough

### Why this should be the happy path

- faster
- cheaper
- easier to explain
- smaller network payload
- better on degraded show Wi-Fi
- stronger against same-artwork reprints

### Important nuance

This is not pure OCR-only matching.

The real resolver is:

- `OCR + symbol recognition + direct lookup`

You still need vision because set symbols are icons, not text.

## Product Scope

### In scope

- live single-card scan loop
- compact result cards stacking on the scanner screen
- one primary price per card row
- inline expand for more pricing details
- remove card from stack
- quick manual correction path

### Out of scope

- dedicated detail page as the main scan path
- bundle totals in the first version of this flow
- inventory management
- deal log
- exports
- eBay sync
- baseball card support

Baseball should remain a later expansion because its identifiers are less uniform and often require stronger front/back workflows.

## Live Scan Stack UX

## Screen Structure

Single primary screen:

### Top area

- simple title: `Scan Cards`
- optional show/network status
- optional small freshness badge

### Middle area

- live camera preview
- one-card framing guide
- very small helper text:
  - `One card only`
  - `Keep bottom strip visible`
  - `Avoid glare`

### Bottom area

- stacked result tray over the lower part of the camera
- tray can be collapsed, half-open, or expanded
- newest successful scan appears at the top

### Bottom controls

- capture button
- import photo
- flash

## Result Row Design

Each scanned card row should show:

- card thumbnail
- card name
- set + printed number
- one primary price, default `Market`
- tiny source / freshness label

Example shape:

- `Charizard ex`
- `Obsidian Flames • 223/197`
- `$13.98`
- `TCGplayer • fresh`

## Row Interactions

### Default row state

Compact and scannable.

### Tap row

Expand inline and show:

- Low
- Market
- Mid
- High
- source
- freshness
- optional `Remove`

### Swipe left

- remove row

### Tap mismatch action

- open correction sheet, not a full-screen detail page

Correction sheet should offer:

- top alternate matches
- manual search

## Behavior

### Successful scan

1. user scans card
2. app resolves identity
3. app fetches price
4. new row animates into stack
5. camera stays live
6. user scans next card

### Low-confidence scan

1. user scans card
2. system cannot confidently resolve `set + number`
3. correction sheet appears
4. user picks alternate or searches manually
5. corrected card enters stack

### No-price case

If a card is identified but pricing is missing:

- still add the card to the stack
- show `Price unavailable`
- allow later refresh

## Resolver Architecture

## On-device pipeline

The phone should do:

1. rectangle detection
2. perspective correction
3. normalized crop
4. bottom-strip region extraction
5. OCR over:
   - bottom-left strip
   - bottom-right strip
   - name bar when needed
6. local quality checks

Output from device:

- crop confidence
- OCR tokens
- probable collector number
- probable promo code
- set symbol crop
- optional lightweight image fingerprint
- warnings like glare / blur / partial crop

## Resolver stages

### Stage 1. Direct number parse

Try to parse:

- `223/197`
- `254/193`
- `TG23/TG30`
- `SVP 056`

If no number-like token is found, continue anyway with lower confidence.

### Stage 2. Set symbol / promo inference

Resolve one of:

- set symbol
- promo prefix
- special subset marker like `TG`

This can come from:

- OCR text
- tiny symbol classifier
- known formatting patterns

### Stage 3. Direct catalog lookup

Use:

- `set + number`
- or `promo prefix + number`

This should be the first real retrieval path.

### Stage 4. Candidate narrowing

If the direct lookup is incomplete or ambiguous, narrow with:

- card name
- rarity
- supertype
- language
- OCR token consistency

### Stage 5. Visual fallback

Only if the direct resolver is weak:

- run visual retrieval
- get top K candidates
- rerank with OCR and catalog fields

### Stage 6. Confidence

Confidence should be based on:

- exactness of `set + number` match
- symbol/promo agreement
- OCR quality
- visual agreement when fallback is used
- closeness of top candidates

## Confidence Rules

### High confidence

Use automatically when:

- exact `set + number` match exists
- no strong conflict from OCR or visual signals

### Medium confidence

Use when:

- number is clear but set is weak
- or set is clear but number parse is imperfect

### Low confidence

Use when:

- direct resolver fails
- visual fallback returns close candidates
- OCR is noisy

Low confidence should open the correction sheet by default.

## Pricing Strategy In This UX

Do not show all pricing fields by default.

Default compact row:

- one primary price: `Market`

Inline expand:

- `Low`
- `Market`
- `Mid`
- `High`
- source
- freshness

This keeps the stack readable while still exposing enough trust information.

## Network Strategy

Optimize for degraded internet:

- resolve as much as possible from OCR + symbol + direct lookup
- send tiny structured payloads first
- only use heavier visual retrieval when needed
- cache recent cards and recent price snapshots

Priority order:

1. direct local parse
2. direct catalog query
3. visual fallback
4. manual correction

## API Direction

The scan API should evolve toward:

### Request

- scan id
- OCR tokens
- collector number
- promo code
- set symbol class
- crop confidence
- quality warnings
- optional image fingerprint
- optional cropped image only when fallback is needed

### Response

- confidence
- best match
- alternates
- resolver path:
  - `direct_lookup`
  - `direct_lookup_plus_rerank`
  - `visual_fallback`
- primary price
- source
- freshness

## Why Baseball Is Not V1

This resolver is strong for Pokemon because the printed front-card conventions are relatively structured.

It should not be assumed to generalize cleanly to baseball because:

- numbering is less uniform
- some cards need back-side identification
- some sets are unnumbered
- front/back variations matter more

So the correct product sequencing is:

- `Pokemon v1`
- `sports cards later`

## Recommended Build Order

1. replace detail-page-first flow with a single `Live Scan Stack` screen
2. change resolver priority to `bottom strip first`
3. keep visual retrieval as fallback only
4. make row-level pricing compact by default
5. add correction sheet
6. only after the stack feels fast, add totals

## Success Criteria

This direction is correct if a user can:

- scan a Pokemon card
- get a result row in under a couple seconds
- trust the card identity
- see one useful price immediately
- keep scanning without leaving the camera surface

That is the right wedge for an event-floor tool.
