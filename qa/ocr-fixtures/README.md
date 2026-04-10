# OCR Fixtures

This directory holds the canonical OCR fixture manifests for the rewrite.

Each fixture lives in its own folder and contains:

- `fixture.json`: expectations for the image

Source images currently live in `qa/incoming-ocr-fixtures/` and are referenced
from each manifest so we do not duplicate assets while the harness is still
being built.

The manifest schema is intentionally minimal for Phase 2:

- `fixtureName`
- `selectedMode`
- `sourceImage`
- `tags`
- `expects`

`expects` currently records:

- expected card identity
- expected collector number when known
- expected set name and optional set code hint
- expected confidence bucket
- whether the fixture should preserve low-confidence evidence rather than force
  a strong result

As the runner lands, this format can grow to include stage-level assertions and
old-vs-new OCR diffs without rewriting the initial fixture pack.
