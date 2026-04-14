This folder is a frozen copy of the original live device debug export from
`F5AD370E-A198-419B-83BB-AAA1E861FACB`.

Why this matters:
- target selection found a single strong holder-shaped rectangle
- normalization went down `holder_inner_card_inset_fallback`
- the inset heuristic forced a narrow holder crop back to card aspect ratio by
  vertically center-cropping it
- `06_ocr_input_normalized.jpg` lost both the title and footer/collector

Truth card:
- `Mega Dragonite ex`
- `232/193`
- `M2a`

Companion regression fixture:
- `qa/raw-footer-layout-check/mega-dragonite-ex-232-193-holder-inset`

Use this frozen folder when comparing pre-fix and post-fix behavior. Do not
overwrite these artifacts with regenerated output.
