# Incoming Slab Regression Photos

Drop new slab source images here before creating fixture manifests under
`qa/slab-regression/`.

Suggested naming:

- `psa-charizard-pgo-label-only-01.jpg`
- `psa-charizard-pgo-full-slab-01.jpg`

When a photo becomes part of the canonical corpus, reference it from:

- `qa/slab-regression/tuning/<fixture>/fixture.json`
- or `qa/slab-regression/heldout/<fixture>/fixture.json`

Current imported source set:

- `14` PSA full-slab photos copied from
  `~/Downloads/drive-download-20260412T181003Z-3-001`
- matching derived label-only crops for tuning only
- source-to-import map:
  - [import_map_2026-04-12.md](/Users/stephenchan/Code/spotlight/qa/incoming-slab-regression/import_map_2026-04-12.md)

Still needed:

- at least `10` real PSA label-only photos for the held-out split
