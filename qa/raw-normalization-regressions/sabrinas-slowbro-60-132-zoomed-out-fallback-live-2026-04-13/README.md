This folder is a frozen copy of the original live device debug export from
`53FFB14E-EAFD-4717-94F6-99243002B825`.

Why this matters:
- target selection saw two plausible rectangles but they were too close to call
- the simplified front end correctly fell back to the exact reticle crop
- `06_ocr_input_normalized.jpg` is usable and OCR recovered both title and exact
  collector number
- the real failure is that the slightly zoomed-out fallback crop has poor visual
  recall, so the truth card never reaches the backend shortlist

Truth card:
- `Sabrina's Slowbro`
- `60/132`
- `G1`

Companion regression fixture:
- `qa/raw-footer-layout-check/sabrinas-slowbro-60-132-zoomed-out-fallback`

Use this frozen folder when comparing pre-fix and post-fix behavior. Do not
overwrite these artifacts with regenerated output.
