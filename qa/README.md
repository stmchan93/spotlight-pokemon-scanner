# Scanner QA

## Recommended Manual Cards

See [scanner-test-matrix.md](/Users/stephenchan/Code/spotlight/qa/scanner-test-matrix.md).

## Pending Real-World Capture

Do this later when you are able:

- take `50-100` real Pokémon card phone photos for evaluation
- include harsh overhead lighting, sleeves, glare, angled shots, and slightly blurry captures
- prioritize hard cases: promos, energies, same-name different-number cards, trainer cards, and holo/reverse-holo variants
- add them into [qa/images](/Users/stephenchan/Code/spotlight/qa/images) and extend [scanner-regression.local.json](/Users/stephenchan/Code/spotlight/qa/scanner-regression.local.json)

This is the real accuracy gate for convention-floor scanning. The clean fixture set is only a bootstrap check.

## Current Real-World Photo Batch Constraint

This repo now has a dedicated real-world image regression pack:

- images: [realworld-2026-04-03](/Users/stephenchan/Code/spotlight/qa/images/realworld-2026-04-03)
- manifest: [scanner-regression.realworld-2026-04-03.json](/Users/stephenchan/Code/spotlight/qa/scanner-regression.realworld-2026-04-03.json)
- one-command runner: [run_realworld_regression.sh](/Users/stephenchan/Code/spotlight/tools/run_realworld_regression.sh)

It includes:

- Lugia Neo Genesis PSA
- Mewtwo Star PSA
- Charizard Skyridge PSA
- Charizard Legendary Collection PSA
- Snorlax Legendary Collection PSA
- Latias & Latios-GX PSA
- Charmander 151
- Espeon Star
- Simisear VSTAR GG37
- fake/custom Mega Gengar / Mega Starmie / gold Charizard review cases
- Pikachu ex Surging Sparks PSA 9

Backend text/label coverage for the same families also lives in [test_scanner_backend.py](/Users/stephenchan/Code/spotlight/backend/tests/test_scanner_backend.py).

Expected outcomes for that batch are tracked in:

- [realworld-photo-batch-support-2026-04-03.md](/Users/stephenchan/Code/spotlight/qa/realworld-photo-batch-support-2026-04-03.md)

Run that real-world batch with one command:

```bash
zsh tools/run_realworld_regression.sh
```

Current expected result:

- `20/20` passing on the checked-in real-world batch

## Local QA Pack

Save your six reference images into [qa/images](/Users/stephenchan/Code/spotlight/qa/images) with these exact filenames:

- `basic-lightning-energy-257-198.png`
- `charizard-ex-125-197.png`
- `charizard-ex-223-197.png`
- `charizard-ex-svp-056.png`
- `iono-254-193.png`
- `umbreon-vmax-tg23-tg30.png`

The ready-to-run manifest is [scanner-regression.local.json](/Users/stephenchan/Code/spotlight/qa/scanner-regression.local.json).

## Import To Simulator

With a Simulator booted:

```bash
zsh tools/import_simulator_media.sh
```

That imports every image from [qa/images](/Users/stephenchan/Code/spotlight/qa/images) into the simulator Photos app for manual testing.

## Automated Regression Runner

Run one image:

```bash
swift tools/scanner_eval.swift \
  --image /absolute/path/to/card.jpg \
  --expected pokemon-charizard-ex-223-197
```

If you prefer a compiled binary:

```bash
swiftc tools/scanner_eval.swift -o ./.scanner_eval
./.scanner_eval \
  --image /absolute/path/to/card.jpg \
  --expected pokemon-charizard-ex-223-197
```

One-command manifest run:

```bash
zsh tools/run_scanner_regression.sh
```

Manifest cases can validate with:

- `expectedCardID` for a single exact catalog ID
- `acceptedCardIDs` for multiple valid IDs across different catalogs
- `expectedCardName`, `expectedSetName`, and `expectedNumber` for strict identity checks
- `acceptedSetNames` and `acceptedNumbers` when the same card has slightly different labels across catalogs

That lets the same QA pack work against both the sample backend and the imported Pokémon TCG backend.

To point the regression suite at the imported pricing backend instead of the sample backend:

```bash
SPOTLIGHT_SCANNER_SERVER=http://127.0.0.1:8788/ zsh tools/run_scanner_regression.sh
```

Run multiple images from a manifest:

```bash
swift tools/scanner_eval.swift \
  --manifest qa/scanner-regression.example.json
```

The runner uses the same crop and OCR approach as the iOS app. By default it also calls the local backend at `http://127.0.0.1:8787/` to verify the actual match result.

If you only want to inspect crop/OCR without backend matching:

```bash
swift tools/scanner_eval.swift \
  --image /absolute/path/to/card.jpg \
  --offline
```

To use the backend matcher, start it first:

```bash
python3 backend/server.py
```
