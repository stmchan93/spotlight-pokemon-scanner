# OCR Simplification And Performance Implementation Spec

Date: 2026-04-10

## Status

- This document is the concrete implementation spec for the next OCR refactor pass.
- It refines the broader architecture in [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md).
- Landed so far from this spec:
  - raw preview-frame-first capture
  - raw footer-first staging
  - remnant-aware fallback normalization from search-crop card remnants
  - fallback salvage canonicalizes recovered cards into tighter card-filling OCR inputs
  - deterministic selected-target debug artifact (`04_selected_target_crop.jpg`)
  - simplified deterministic footer band plus tight left/right metadata extraction
  - PSA-only staged slab parser

## Why This Exists

The current OCR architecture is directionally correct, but the live runtime is doing more work than necessary on the hot scan path.

The main product simplifications are now explicit:

- raw cards:
  - keep the current bottom-left / bottom-right footer strategy
  - make raw OCR footer-first instead of title-first
  - keep title OCR as fallback evidence, not the default first read
- slabs:
  - rebuild slab OCR as a cleaner top-label parser
  - support PSA only for this phase
  - do not keep pretending one shared heuristic parser should cover PSA, CGC, BGS, TAG, and future graders

The main performance goal is:

- reduce OCR latency and unnecessary work before backend matching
- especially reduce:
  - unnecessary still-photo capture on raw
  - unnecessary OCR region passes
  - unnecessary image upscaling
  - unnecessary debug image export I/O

## Scope

This spec covers only:

- OCR capture source policy
- OCR target selection and normalization usage
- raw OCR ROI/stage design
- slab OCR ROI/stage design
- OCR evidence synthesis
- OCR debug/export behavior
- frontend OCR-to-backend request payload compatibility

This spec does not cover:

- backend resolver redesign in depth
- pricing logic
- scanner UI redesign
- non-PSA slab family support
- OCR fixture harness architecture beyond the validation needed for this refactor

## Current Runtime Findings

### Current route reality

- Raw scans currently default to the rewrite raw pipeline. See [Spotlight/Services/OCR/ModeSanitySignals.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/ModeSanitySignals.swift#L76).
- Slab scans still use the legacy `SlabScanner`. See [Spotlight/Services/OCR/ModeSanitySignals.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/ModeSanitySignals.swift#L96).

### Current raw capture policy is slower than intended

- Raw scan tap currently prefers a real still photo immediately. See [Spotlight/ViewModels/ScannerViewModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift#L81).
- The camera controller already supports preview-frame-first capture, but raw is explicitly opting out of it. See [Spotlight/Services/CameraSessionController.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CameraSessionController.swift#L175).

This conflicts with the broader OCR policy documented in [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md), which says preview frame first and still image only when justified.

### Current raw ROI order is now footer-first and intentionally narrow

- Rewrite raw stage 1 runs:
  - `footerBandWide`
  - `footerLeft`
  - `footerRight`
 - Rewrite raw stage 2 runs:
  - `headerWide`

See [Spotlight/Services/OCR/Raw/RawROIPlanner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawROIPlanner.swift#L38).

### Current raw evidence is broader than needed on easy scans

- Raw overall evidence weights:
  - title: 40%
  - collector: 40%
  - set: 20%

See [Spotlight/Services/OCR/Raw/RawConfidenceModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawConfidenceModel.swift#L89).

- The backend still uses title as a meaningful retrieval signal for raw matching. See [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py#L439) and [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py#L536).

This means raw cannot become truly footer-only unless the backend matcher also changes. For this phase, raw should become footer-first, not footer-only.

### Current slab OCR is already top-label-first

- Slab OCR crops only top label regions plus a cert-focused region:
  - `panelRegion`
  - `primaryRegion`
  - `expandedRegion`
  - `certRegion`

See [Spotlight/Services/CardRectangleAnalyzer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardRectangleAnalyzer.swift#L59) and [Spotlight/Services/CardRectangleAnalyzer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardRectangleAnalyzer.swift#L1038).

- Slab also does:
  - barcode detection in top regions
  - PSA-style visual inference from the label image

See [Spotlight/Services/CardRectangleAnalyzer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardRectangleAnalyzer.swift#L1286) and [Spotlight/Services/CardRectangleAnalyzer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardRectangleAnalyzer.swift#L1452).

The active slab path is already functionally "top-only", but it is implemented as a broad shared heuristic parser instead of a clean PSA parser.

### Current artifact export is likely contributing to perceived OCR slowness

- `ScanStageArtifactWriter` has debug exports enabled by default. See [Spotlight/Services/OCR/ScanStageArtifactWriter.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/ScanStageArtifactWriter.swift#L63).
- It writes capture images, selection images, ROI images, and JSON manifests to disk on every scan unless explicitly disabled. See [Spotlight/Services/OCR/ScanStageArtifactWriter.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/ScanStageArtifactWriter.swift#L104).

### Example raw scan findings

From `/Users/stephenchan/Downloads/26B363D4-242B-4C64-A228-6CA23F6933C8`:

- one raw scan wrote:
  - 19 files
  - about 12 MB total
- OCR analysis time:
  - about 1467 ms
- source:
  - `live_still_photo`
- raw pipeline:
  - `rewrite_v1`
- that scan escalated into all six rewrite raw ROIs

Representative image sizes from that one scan:

- normalized OCR input:
  - `1010 x 1410`
- footer band wide export:
  - `3636 x 1120`
- footer left export:
  - `1700 x 1016`
- footer right export:
  - `1780 x 1016`
- title band expanded export:
  - `2586 x 1174`

This is not proof that upscaling itself is the main bottleneck, but it is strong evidence that the current path is doing too much work for easy raw scans.

## Product Decisions

### Decision 1: keep the shared front half

Do not remove:

- source image selection
- reticle-guided target selection
- perspective correction
- raw holder recovery
- normalization

That front half is what makes footer-only regions and slab-top-only regions reliable enough to use.

### Decision 2: raw becomes footer-first, not title-first

For raw cards, the hot path should start with footer evidence:

- footer band
- bottom left
- bottom right

Title/header OCR becomes fallback evidence only.

### Decision 3: slab becomes PSA-only in this phase

The active slab OCR path for this refactor must only support PSA.

For non-PSA slabs:

- do not attempt to parse with the PSA parser
- do not guess using shared regex soup
- return unsupported / needs review with an explicit reason

This phase is about shipping one clean slab parser, not another multi-grader compromise.

### Decision 4: debug artifact export must not be on by default

The hot scan path must not write scan-stage JPEGs and JSON artifacts to disk unless the user or developer explicitly turns that on.

Temporary local-troubleshooting override:

- keep debug artifact export enabled by default for local builds while OCR troubleshooting is active
- do not treat this as the long-term default

## Target Design

## Shared Front Half

Keep the current front half structure:

1. choose source image
2. detect target rectangle candidates
3. choose best target near reticle
4. perspective-correct and normalize
5. recover inner card for raw-holder cases when needed
6. emit target quality / fallback metadata

No redesign is needed here for this phase.

## Raw OCR V2

### Raw objective

Extract enough evidence to identify the card quickly, with footer evidence as the primary path:

- collector number exact or partial
- set hint token when present
- promo prefix when present
- footer-band text for fallback parsing
- optional title text only when needed

### Raw stage order

#### Raw Stage 1: footer-first pass

Always run these three ROIs first:

- `footerBandWide`
- `footerLeft`
- `footerRight`

Rationale:

- the collector number and printed set clues live here
- the confidence model already considers footer corner agreement the strongest raw signal
- the current implementation cannot early-exit on the strongest signal because it reads the corners too late

#### Raw Stage 1 output

Stage 1 must attempt to produce:

- `collectorNumberExact`
- `collectorNumberPartial`
- `setHintTokens`
- `promoCodeHint`
- `footerBandText`
- `footerAgreementState`
  - `corner_corner_agree`
  - `band_corner_agree`
  - `single_source_only`
  - `contradictory`
  - `missing`

#### Raw Stage 1 early-exit rule

Stage 1 must stop the raw pipeline when one of these holds:

- exact collector number from both corners
- exact collector number from band + one corner with agreement
- exact collector number plus strong set hint token
- promo-format collector plus strong set hint token

Initial confidence target:

- collector confidence `>= 0.82`
- and either:
  - set confidence `>= 0.58`
  - or footer agreement confirms the collector

#### Raw Stage 2: title fallback

Only if stage 1 is weak, ambiguous, or contradictory, run title fallback:

- `headerWide`
- `nameplateTight`

Do not run both title ROIs plus the broad title expansion by default.

#### Raw Stage 3: title rescue

Only if title is still weak after stage 2, run:

- `titleBandExpanded`

This region becomes the most expensive title rescue, not the default escalation step.

### Raw ROI budget changes

#### Keep

- footer left and footer right geometry
- footer band geometry
- footer-biased collector parsing rules

#### Change

- move footer left and footer right into stage 1
- move header and title regions behind footer failure
- keep `nameplateTight` before `titleBandExpanded`

### Raw preprocessing and upscale rules

#### Footer ROIs

- keep footer corners high quality
- keep corner OCR more aggressive than title OCR
- do not remove the corner design

Initial parameter direction:

- `footerLeft` / `footerRight`
  - keep around `4.0x` unless fixture testing shows a lower factor is safe
- `footerBandWide`
  - reduce from `3.6x` to approximately `3.0x` to `3.2x`
  - because it is broad and expensive

#### Title ROIs

Reduce title fallback cost modestly:

- `headerWide`
  - roughly `2.2x` to `2.4x`
- `nameplateTight`
  - roughly `2.6x` to `2.8x`
- `titleBandExpanded`
  - roughly `2.8x`

#### Global upscale cap

Lower the OCR-pass runner longest-side clamp from `4096` to `3072` for this phase unless fixture regressions show a measurable identification drop.

See current clamp in [Spotlight/Services/OCR/Raw/RawOCRPassRunner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawOCRPassRunner.swift#L124).

### Raw capture source policy

Restore the intended policy:

- raw should use preview frame first on tap
- raw should not default to a still photo on every scan

Still photo may be used only when:

- a later retry policy explicitly requests it
- and the retry path is enabled

For this phase:

- do not auto-trigger a still-photo retry in the default user path
- keep the preview frame authoritative unless explicitly testing retry behavior

### Raw evidence contract

The raw payload sent to backend must remain compatible:

- continue sending:
  - `collectorNumber`
  - `setHintTokens`
  - `promoCodeHint`
  - `ocrAnalysis.rawEvidence.footerBandText`
- send title fields only when stage 2 or stage 3 actually ran

Important:

- title may now be empty on many successful raw scans
- that is acceptable
- backend matcher work must tolerate footer-first evidence in the next backend refactor

## PSA Slab OCR V2

### PSA slab objective

Parse only PSA slab top-label information needed for lookup:

- grader
- grade
- cert
- card number when available
- normalized label text for fallback

Do not attempt multi-grader support in this phase.

### PSA slab stage order

#### PSA Stage 1

Run:

- `topLabelWide`
- `certFocus`
- barcode detection on top label
- PSA visual profile extraction

This is the default and expected hot path.

#### PSA Stage 2

Only if stage 1 is weak or contradictory, run:

- `topLabelExpanded`
- `rightColumnFocused`

Do not keep the current overlapping `panel + primary + expanded` set as always-on redundant crops.

### PSA parser behavior

The new slab parser must be PSA-specific:

- explicit PSA token parsing
- PSA grade adjective and grade parsing
- PSA cert parsing
- barcode cert extraction
- PSA label-layout inference only as support

The parser must return:

- `grader`
- `grade`
- `cert`
- `cardNumber`
- `labelWideText`
- `recommendedLookupPath`
- `isPSAConfident`
- `unsupportedReason` when applicable

### Non-PSA behavior

If slab OCR does not produce strong PSA confidence:

- do not pass the scan through the PSA parser as if it were generic
- return slab OCR output marked unsupported
- include a reason such as:
  - `non_psa_slab_not_supported_yet`
  - `psa_label_not_confident_enough`

### Slab backend handoff

The slab payload shape may remain compatible, but the active supported path is PSA only.

Short-term behavior:

- if PSA:
  - send grader / grade / cert / card number / label text
- if not PSA:
  - send unsupported slab OCR state
  - avoid fake certainty

## Performance Rules

### Rule 1: no full artifact export by default

Replace the current single boolean default with explicit export modes:

- `off`
- `manifests_only`
- `full`

Default runtime mode must be:

- `off`

### Rule 2: no ROI JPEG export in normal user scans

In normal runtime:

- do not write ROI images
- do not write capture images
- do not write selection overlay images

Only write these when full exports are explicitly enabled.

### Rule 3: reduce raw common-case ROI count

Target common raw exact scans to execute:

- 3 OCR ROIs, not 6

Those 3 are:

- footer band
- footer left
- footer right

### Rule 4: keep OCR sequential for now

Do not add OCR pass concurrency in this phase.

Reason:

- the biggest wins are:
  - fewer passes
  - less disk I/O
  - preview-frame-first capture
- parallel Vision work can be considered only after the OCR budget is smaller and measured

### Rule 5: keep logs lighter by default

Keep summary logging, but reduce verbose per-region logging in the default runtime path.

## File-Level Implementation Plan

### Files to change

- [Spotlight/ViewModels/ScannerViewModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift)
  - restore preview-frame-first raw capture policy
- [Spotlight/Services/CameraSessionController.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CameraSessionController.swift)
  - no major architecture change needed
  - keep preview/still-photo support; adjust caller behavior
- [Spotlight/Services/OCR/Raw/RawROIPlanner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawROIPlanner.swift)
  - reorder stages
  - reduce default ROI count
  - tune upscales
- [Spotlight/Services/OCR/Raw/RawConfidenceModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawConfidenceModel.swift)
  - make footer-first early-exit the primary happy path
  - revise stage-1 escalation logic
- [Spotlight/Services/OCR/Raw/RawEvidenceSynthesizer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawEvidenceSynthesizer.swift)
  - support successful raw results with empty title fields
  - include footer agreement metadata if useful
- [Spotlight/Services/OCR/Raw/RawPipeline.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawPipeline.swift)
  - preserve shared front half
  - run new stage order
- [Spotlight/Services/OCR/Raw/RawOCRPassRunner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawOCRPassRunner.swift)
  - lower upscale clamp
- [Spotlight/Services/OCR/ScanStageArtifactWriter.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/ScanStageArtifactWriter.swift)
  - make exports off by default
  - add explicit export modes
- [Spotlight/Services/OCR/ModeSanitySignals.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/ModeSanitySignals.swift)
  - route slab mode to the new PSA slab pipeline when implemented
- [Spotlight/Services/SlabLabelParsing.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/SlabLabelParsing.swift)
  - retire as the active shared multi-grader parser
  - either narrow it to PSA or replace it with a new PSA parser
- [Spotlight/Services/CardRectangleAnalyzer.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardRectangleAnalyzer.swift)
  - keep only as legacy path during migration
  - do not continue expanding the slab legacy heuristics

### Recommended new files

- `Spotlight/Services/OCR/Slab/PSASlabPipeline.swift`
- `Spotlight/Services/OCR/Slab/PSALabelParser.swift`
- optional:
  - `Spotlight/Services/OCR/Slab/PSAVisualProfile.swift`

## Rollout Plan

### Phase 1

- restore preview-frame-first raw capture
- keep local debug artifact export enabled for now
- keep existing functionality otherwise

Expected impact:

- immediate latency improvement
- disk I/O reduction is deferred until the debug-export default is relaxed

### Phase 2

- reorder raw stages to footer-first
- keep title OCR as fallback only
- preserve payload compatibility

Expected impact:

- common raw exact scans stop at 3 ROIs
- fewer broad OCR passes

### Phase 3

- add PSA-only slab pipeline
- route slab scans through PSA-only parser
- return unsupported for non-PSA slabs

Expected impact:

- cleaner slab behavior
- less heuristic overlap
- lower maintenance burden

### Phase 4

- tune thresholds and upscales against fixtures
- revisit whether `titleBandExpanded` is still needed often enough to justify its cost

## Acceptance Criteria

### Raw

- raw no longer defaults to still-photo capture on every tap
- common raw exact scans run footer-first and avoid title OCR
- raw keeps bottom-left / bottom-right OCR design
- raw title OCR only runs when footer evidence is weak or contradictory
- raw payload remains backend-compatible

### Slab

- slab active path is PSA-only
- non-PSA slabs do not go through fake generic parsing
- PSA parsing is cleaner and less redundant than the current shared heuristic path

### Performance

- full scan artifact export is off by default
- normal runtime scans do not write ROI JPEGs
- OCR instrumentation can show:
  - capture source
  - target selection result
  - executed ROIs
  - whether stage 2 or stage 3 ran
  - OCR analysis time

## Validation

Run after implementation:

```bash
zsh tools/run_ocr_simulator_fixture_tests.sh
python3 -m py_compile backend/catalog_tools.py backend/pokemontcg_api_client.py backend/pokemontcg_pricing_adapter.py backend/pricecharting_adapter.py backend/pricing_provider.py backend/pricing_utils.py backend/scrydex_adapter.py backend/validate_scrydex.py backend/server.py
zsh tools/run_card_identifier_parser_tests.sh
zsh tools/run_raw_card_decision_tests.sh
zsh tools/run_scanner_reticle_layout_tests.sh
zsh tools/run_scan_tray_logic_tests.sh
xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build
```

Fixture validation focus:

- Japanese raw cards with footer-visible set tokens
- promos with prefix-style collector numbers
- holder-like raw scenes
- weak-footer raw scenes where title fallback is still needed
- PSA slabs with:
  - clear cert
  - cert missing but strong grade layout
  - glare on the right column
- non-PSA slabs returning explicit unsupported state

## Open Coordination Note

This OCR refactor intentionally moves raw toward footer-first evidence. The backend raw matcher still uses title as a meaningful retrieval signal today. That is acceptable for this phase as long as the payload remains compatible, but the next backend OCR-facing cleanup should explicitly support footer-first raw evidence without assuming title is usually present.
