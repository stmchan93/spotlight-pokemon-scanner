# Scanner QA

## Recommended Manual Cards

See [scanner-test-matrix.md](/Users/stephenchan/Code/spotlight/qa/scanner-test-matrix.md).

## Pending Real-World Capture

Do this later when you are able:

- take `50-100` real Pokémon card phone photos for evaluation
- include harsh overhead lighting, sleeves, glare, angled shots, and slightly blurry captures
- prioritize hard cases: promos, energies, same-name different-number cards, trainer cards, and holo/reverse-holo variants
- add them into [qa/images](/Users/stephenchan/Code/spotlight/qa/images)

This is the real accuracy gate for convention-floor scanning. The clean fixture set is only a bootstrap check.

## Local QA Pack

Save your six reference images into [qa/images](/Users/stephenchan/Code/spotlight/qa/images) with these exact filenames:

- `basic-lightning-energy-257-198.png`
- `charizard-ex-125-197.png`
- `charizard-ex-223-197.png`
- `charizard-ex-svp-056.png`
- `iono-254-193.png`
- `umbreon-vmax-tg23-tg30.png`

## Import To Simulator

With a Simulator booted:

```bash
zsh tools/import_simulator_media.sh
```

That imports every image from [qa/images](/Users/stephenchan/Code/spotlight/qa/images) into the simulator Photos app for manual testing.

## Automated Checks Kept In Repo

The actively kept lightweight checks are:

- `zsh tools/run_card_identifier_parser_tests.sh`
- `zsh tools/run_ocr_fixture_runner.sh`
- `zsh tools/run_ocr_simulator_fixture_tests.sh`
- `zsh tools/run_raw_card_decision_tests.sh`
- `zsh tools/run_scanner_reticle_layout_tests.sh`
- `zsh tools/run_scan_tray_logic_tests.sh`

These cover parser and UI logic that still belongs to the current raw-backend implementation. The older image-manifest scanner harness was removed as part of the cleanup.

## OCR Fixture Pack

The OCR rewrite now has a canonical fixture pack under:

- [qa/ocr-fixtures](/Users/stephenchan/Code/spotlight/qa/ocr-fixtures)

Run:

```bash
zsh tools/run_ocr_fixture_runner.sh
```

That validates fixture manifests and materializes a stable baseline output tree
under:

- [qa/ocr-golden/phase2-baseline](/Users/stephenchan/Code/spotlight/qa/ocr-golden/phase2-baseline)

Run:

```bash
zsh tools/run_ocr_simulator_fixture_tests.sh
```

That executes the real legacy OCR analyzers on the simulator fixture pack and
writes the current simulator reference outputs under:

- [qa/ocr-golden/simulator-legacy-v1](/Users/stephenchan/Code/spotlight/qa/ocr-golden/simulator-legacy-v1)
- [qa/ocr-golden/simulator-rewrite-v1-raw-stage2](/Users/stephenchan/Code/spotlight/qa/ocr-golden/simulator-rewrite-v1-raw-stage2)

Those simulator summaries now include:

- OCR pipeline version
- normalized-target geometry/fallback metadata
- mode sanity scores and warnings

The rewrite raw corpus now includes selective escalation:

- `headerWide`
- `footerBandWide`
- `nameplateTight`
- `footerLeft`
- `footerRight`

It also records centralized raw field-confidence and still-photo retry
decisions. The next OCR fixture milestone is the first slab rewrite corpus,
then old-vs-new diff reporting on top of that same output layout.
