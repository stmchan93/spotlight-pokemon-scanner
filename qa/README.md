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
- `zsh tools/run_raw_card_decision_tests.sh`
- `zsh tools/run_scanner_reticle_layout_tests.sh`
- `zsh tools/run_scan_tray_logic_tests.sh`

These cover parser and UI logic that still belongs to the current raw-backend implementation. The older image-manifest scanner harness was removed as part of the cleanup.
