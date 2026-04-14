This folder is a frozen copy of the original live device debug export from
`4E9731FB-3A38-4D65-BEAF-3D8E210305EF`.

Why this matters:
- target selection rejected the only rectangle for aspect mismatch
- the front end fell back to the exact reticle crop
- the footer band ROI still read `60/132`
- the header ROI was pinned too high and mostly cropped laptop background, so
  title OCR returned nothing
- once title OCR was lost, the backend had only collector evidence and the true
  card never reached the visual shortlist

Truth card:
- `Sabrina's Slowbro`
- `60/132`
- `G1`

Use this frozen folder when comparing pre-fix and post-fix behavior. Do not
overwrite these artifacts with regenerated output.
