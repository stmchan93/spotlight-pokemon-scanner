This folder is a frozen copy of the original live device debug export from
`13B85EB4-C995-4541-9C0D-DC5611525936`.

Why this matters:
- the scanner did not detect a real full-card rectangle
- the only rectangle candidates were wide horizontal strips
- fallback partial-card salvage reconstructed a fake full card from the lower remnant
- `06_ocr_input_normalized.jpg` clipped the title and collector number

Truth card:
- `Snorlax`
- `077/071`
- `S10a`

Companion regression fixture:
- `qa/raw-footer-layout-check/snorlax-077-071-price-sticker`

Use this frozen folder when comparing pre-fix and post-fix behavior. Do not
overwrite these artifacts with regenerated output.
