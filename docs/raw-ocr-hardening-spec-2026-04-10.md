# Raw OCR Hardening Spec

Date: 2026-04-10

## Why This Exists

Recent on-device raw scans exposed three distinct failure classes:

1. good fallback salvage with correct footer evidence
2. fallback salvage with wrong collector OCR because the normalized target was still too small or underconstrained
3. no-rectangle-detected scans that fell through to a weak generic fallback crop and produced unusable backend evidence

Representative scan IDs:

- `F27F0118-5878-4739-9A42-D2A879CECAB2`
  - good fallback salvage
  - correct `199/182`
  - correct set hint `dri`
- `F307CB26-FADE-4B20-AA3B-D5970A60FF99`
  - wrong collector OCR (`099/117`)
  - tiny normalized target
  - stage 2 title fallback fired, but footer collector evidence was already corrupted
- `6BF0EB22-C154-482F-A9A0-3B5AD60BD94E`
  - correct collector OCR (`199/182`)
  - no set hints
  - no title evidence
  - backend request was underconstrained and same-number ambiguous
- `3AA6BEB1-E5F2-4531-88A9-EC29D96D3726`
  - no rectangle detected
  - fallback crop produced no useful collector or set evidence
- `7380818F-5446-4BDB-8D01-BF9AAFAD64A8`
  - no rectangle detected
  - zero OCR signal reached the backend

## Current Failure Analysis

### Failure 1: Raw normalization is not fully canonical

Observed normalized sizes varied significantly across scans:

- `538x752`
- `359x500`
- `549x766`
- `759x1060`

That means deterministic ROI math is still being applied to non-deterministic parent images.

### Failure 2: The no-rectangle path is too weak

When `selection_manifest.json` has `candidates: []`, the current path can fall through to a large generic fallback crop.

That produces:

- weak or empty footer OCR
- no reliable collector number
- no reliable set hints
- backend requests with almost no useful evidence

### Failure 3: Stage 1 exits too early for same-number cards

If raw OCR gets:

- exact collector number
- but no set hints
- and no title evidence

the scan request is still underconstrained for backend matching.

The current pipeline can still stop too early, which leads to same-number ambiguity downstream.

## Design Goals

1. Every successful raw normalization path should end on one fixed-size canonical raw-card canvas.
2. `no_rectangle_detected` should first try a low-signal small-card rescue before giving up.
3. Raw stage 1 should not early-exit when the backend request would still be underconstrained.
4. Debug artifacts should make the backend request evidence obvious from the folder alone.

## Concrete Implementation Plan

### A. Fixed-size canonical raw normalization

Target file:

- [Spotlight/Services/OCR/PerspectiveNormalization.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/PerspectiveNormalization.swift)

Changes:

- add one canonical raw-card canvas size
  - target: `630x880`
- apply canonicalization to:
  - chosen rectangle path
  - holder inner-card path
  - low-signal rescue path
  - remnant salvage path
  - final raw fallback path

Result:

- raw ROI coordinates are applied to a deterministic parent image
- footer crops become more comparable across scans

### B. Low-signal small-card rescue

Target file:

- [Spotlight/Services/OCR/PerspectiveNormalization.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/PerspectiveNormalization.swift)

Changes:

- after the normal fallback rectangle recovery attempt fails, run a second raw-card detector tuned for:
  - smaller minimum area
  - lower minimum confidence
  - wider accepted aspect envelope
  - larger allowed center distance
- run that second detector on:
  - the original fallback image
  - an enhanced high-contrast grayscale version of the same image

Result:

- distant but still centered cards can still be promoted into a real normalized card image
- `no_rectangle_detected` becomes less common for small centered cards

### C. Remove holder fallback from ordinary raw-card fallback scans

Target file:

- [Spotlight/Services/OCR/PerspectiveNormalization.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/PerspectiveNormalization.swift)

Problem:

- holder-specific inset fallback should not run on ordinary raw-card scenes

Change:

- only allow holder-style fallback recovery when the image actually looks holder-like

Result:

- non-holder raw scans stop inheriting a misleading oversized fallback crop

### D. Stricter stage-1 early-exit rules

Target file:

- [Spotlight/Services/OCR/Raw/RawConfidenceModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawConfidenceModel.swift)

Change:

- do not early-exit stage 1 for exact collector-only cases when set evidence is missing
- require stronger corroboration for fallback scans before stage 1 can stop early

Desired behavior:

- `F27...` still stops early
- `6BF...` escalates to `headerWide`
- same-number collector scans stop reaching the backend with only bare collector evidence when avoidable

### E. Better request debug artifact

Target file:

- [Spotlight/ViewModels/ScannerViewModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift)

Change:

- `frontend_backend_request.json` should include:
  - `cropConfidence`
  - `collectorNumberPartial`
  - `titleTextPrimary`
  - `titleTextSecondary`
  - whether `ocrAnalysis` was included

Result:

- future scan folders make it clear what evidence informed the backend request

## Validation

Required:

- `xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build`
- `zsh tools/run_ocr_simulator_fixture_tests.sh`

Target validation outcomes:

1. raw normalized images should converge on one canonical size
2. low-signal distant raw cards should prefer `fallback_*_small_card_detected` or `fallback_*_partial_card_salvaged` over generic inset fallback
3. exact-collector but no-set scans should escalate instead of stopping at stage 1
4. the request artifact should show the actual OCR evidence summary used for backend handoff

## Second-Wave Work

Not in this pass:

- backend-side same-number ambiguity hardening
- OCR ambiguity-preserving collector candidates like `199/182` vs `099/117`
- adaptive camera guidance in the UI when the card is too far away
