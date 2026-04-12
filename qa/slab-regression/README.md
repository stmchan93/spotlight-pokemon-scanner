# Slab Regression Fixtures

This directory is the canonical fixture corpus for the cert-first slab rebuild.

Phase 1 scope:

- PSA slabs
- Pokemon cards
- full slab captures
- label-only captures
- Scrydex-backed graded pricing

This corpus is split into:

- `tuning/`
  - fixtures allowed for OCR/parser iteration
- `heldout/`
  - fixtures reserved for final scorekeeping

Each fixture lives in its own folder under one of those splits and must contain:

- `fixture.json`

Source images do not need to be duplicated yet. A fixture may reference an image
outside its directory through `sourceImage`, for example under
`qa/incoming-slab-regression/`.

Derived crops are acceptable for `tuning/` bootstrap fixtures when a real capture
does not exist yet. Do not use derived crops in `heldout/`.

Current imported bootstrap corpus:

- `14` real PSA full-slab photos imported from
  `~/Downloads/drive-download-20260412T181003Z-3-001`
- `14` derived label-only crops generated from those same PSA photos
- `0` held-out fixtures so far
- excluded from phase 1:
  - `IMG_0162.JPG` because it is `CGC`

Next required acquisition before runtime cutover:

- at least `10` real PSA label-only photos for `heldout/`

From a fixture folder like `qa/slab-regression/tuning/<fixture>/`, that should be
written as:

```json
"sourceImage": "../../../incoming-slab-regression/example.jpg"
```

## Minimal Fixture Schema

- `fixtureName`
- `split`
- `selectedMode`
- `captureKind`
- `sourceImage`
- `tags`
- `truth`
- `expects`

`captureKind` should be one of:

- `full_slab`
- `label_only`

`truth` should record:

- `grader`
- `grade`
- `certNumber`
- `cardID`
- `cardName`
- `setName`
- `cardNumber`
- `pricingProvider`
- `pricingLookup`

For the current slab rebuild, `pricingLookup.mode` should be:

- `card_id_grade`

That reflects the current backend contract:

- OCR reads the cert from the slab label
- the cert helps with repeat-scan cache resolution and confidence
- first-seen slab identity resolves to a card ID
- Scrydex graded pricing is then fetched by `cardID + grader + grade`

The current repo does not assume a documented Scrydex cert endpoint.

## Runner

Use:

```bash
zsh tools/run_slab_regression.sh
```

Current scaffold behavior:

- validates fixture manifests
- validates `sourceImage` paths
- warns when the corpus still lacks any `label_only` fixtures
- warns when the corpus still lacks any `heldout` fixtures
- replays the slab OCR path on the simulator over the available corpus
- writes per-fixture OCR summaries under:
  - `qa/slab-regression/simulator-vision-v1/<split>/<fixture>/`
- writes an OCR scorecard to:
  - `qa/slab-regression/simulator-vision-v1/scorecard.json`
- writes a summary JSON report to:
  - `qa/slab-regression/manifest_summary.json`

The current runner is OCR-only. Backend identity/pricing scoring can be layered on
later without changing the fixture layout.

Current tuning baseline on the imported `2026-04-12` PSA corpus:

- `28/28` grader exact
- `28/28` grade exact
- `28/28` cert exact
- `28/28` card number exact

That result is useful for tuning only. It must not be treated as a shipping
accuracy claim because the `label_only` half of the corpus is still derived from
the same source photos as the `full_slab` half.
