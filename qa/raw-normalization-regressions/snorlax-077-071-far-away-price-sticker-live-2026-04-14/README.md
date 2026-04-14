This folder is a frozen copy of the original live device debug export from
`B890C51E-603E-4895-A100-9272600ECB21`.

Why this matters:
- target selection found no rectangle and fell back to `exact_reticle_fallback`
- the normalized image stayed usable enough for OCR
- OCR recovered:
  - Japanese title support for `カビゴン`
  - exact collector `077/071`
- the live backend response still chose arbitrary same-number Japanese candidates
  instead of `Snorlax`
- this is a good regression for:
  - far-away fallback scans
  - sticker-occluded set badge / weak set evidence
  - same-number ambiguity where title evidence should break the tie

Truth card:
- `Snorlax`
- `077/071`
- `S10a`

Companion regression fixture:
- `qa/raw-footer-layout-check/snorlax-077-071-far-away-price-sticker`

Current note:
- replaying this scan against the current backend code with the saved normalized
  image attached produces `Snorlax` top-1
- if a live device/backend run still returns `Baxcalibur` here, the most likely
  cause is that the running backend process is stale or missing the newer
  local-only fallback rescue behavior
