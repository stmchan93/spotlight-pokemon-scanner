# Tuning Split

Place PSA slab fixtures here when they are allowed to influence OCR/parser
iteration.

Recommended mix:

- clean full slab
- angled full slab
- clean label only
- angled label only
- barcode present
- barcode cropped out
- easy cert OCR
- noisy cert OCR

Current imported tuning set:

- `14` real PSA full-slab photos from
  `~/Downloads/drive-download-20260412T181003Z-3-001`
- `14` derived label-only crops from those same PSA photos
- excluded from phase 1:
  - `IMG_0162.JPG` because it is `CGC`

This split is now the first slab tuning corpus. It is good enough for OCR/parser
iteration, but it is not valid held-out evidence because the `label_only`
fixtures are derived from the same source photos as the `full_slab` fixtures.

Next required acquisition:

- at least `10` real PSA label-only photos for `qa/slab-regression/heldout/`
