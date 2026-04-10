# OCR Architecture Rewrite Spec

Date: 2026-04-09

## Status

- This document is the planning source of truth for the upcoming OCR rewrite.
- The current OCR path remains in place until the new path proves better on named fixtures.
- This is a full OCR rewrite plan with:
  - a shared front half
  - a raw branch
  - a slab branch
- Implementation status:
  - Phase 0 docs/contracts freeze: landed
  - Phase 1 shared data contracts: landed
  - Phase 2 fixture manifests + host baseline runner: landed
  - Phase 3 stage artifact and replay framework: landed
  - Phase 4 shared front half extraction: landed
  - Phase 5 simulator-backed legacy OCR fixture execution: landed
  - Phase 6 mode sanity signals + feature-flagged rewrite entrypoint: landed
  - Phase 7 raw branch stage 1: landed
  - Phase 8 raw escalation and confidence: landed
  - Phase 9 slab branch stage 1: next

## Current Fixture Outputs

- Canonical fixture manifests live under:
  - [qa/ocr-fixtures](/Users/stephenchan/Code/spotlight/qa/ocr-fixtures)
- Host-side manifest validation and baseline materialization writes to:
  - [qa/ocr-golden/phase2-baseline](/Users/stephenchan/Code/spotlight/qa/ocr-golden/phase2-baseline)
- Simulator-backed legacy OCR execution now writes per-fixture outputs to:
  - [qa/ocr-golden/simulator-legacy-v1](/Users/stephenchan/Code/spotlight/qa/ocr-golden/simulator-legacy-v1)
- Simulator-backed rewrite raw stage-2 execution now writes per-fixture outputs to:
  - [qa/ocr-golden/simulator-rewrite-v1-raw-stage2](/Users/stephenchan/Code/spotlight/qa/ocr-golden/simulator-rewrite-v1-raw-stage2)
- Those simulator-backed fixture outputs now also include:
  - pipeline version
  - normalized target geometry/fallback fields
  - mode sanity scores and warnings

The simulator-backed runs are now the current reference corpora for:

- legacy OCR
- rewrite raw stage 2

They should be used for side-by-side comparison before the legacy path is removed.

## Core Decisions

- There are only two top-level scan modes:
  - `raw`
  - `slab`
- Top-level mode comes from the UI toggle, not from OCR auto-routing.
- `raw in holder` is not a separate mode.
  - sleeves / top-loaders / holders stay inside the raw branch as scene traits.
- The shared front half ends after:
  - frame source selection
  - target selection
  - perspective normalization
  - mode sanity signals
- After normalization, OCR must branch:
  - raw OCR pipeline
  - slab OCR pipeline
- OCR owns evidence extraction and field confidence.
- Backend owns candidate-resolution confidence and final match confidence.
- The reticle is a target-selection hint, not the exact OCR crop.
- The new OCR path must ship behind a feature flag and run side-by-side with the old path before legacy OCR is deleted.

## Why The Split Happens After Normalization

Before normalization, raw and slab share the same geometric problem:

1. choose the best available source image
2. find the intended object near the reticle
3. isolate that object
4. normalize it into a stable upright target

After normalization, they diverge:

- raw needs title / footer / broader card evidence
- slab needs card-identity evidence from the label plus grader / grade / optional cert
- ROI geometry, escalation rules, and evidence synthesis are different enough that one generic post-normalization OCR flow would become muddy and hard to tune

So the split should happen exactly after:

- `FrameSourceSelection`
- `TargetSelection`
- `PerspectiveNormalization`
- `ModeSanitySignals`

## Responsibilities

### Raw pipeline

OCR extracts:

- title / name evidence
- collector-number evidence
- set evidence
- footer-band evidence
- optional broader card text
- field confidences

Backend uses that evidence to:

- resolve the card
- fetch raw pricing

### Slab pipeline

OCR extracts:

- card identity evidence:
  - name / title
  - set
  - card number
  - broader label text
- slab-specific evidence:
  - grader
  - grade
  - optional cert
- field confidences

Backend uses that evidence to:

1. resolve the underlying card from name + set + card number + label text
2. then apply grader + grade, plus optional cert, to choose slab pricing

Important:

- cert is supportive verification, not the only usable slab key
- the slab branch still needs the same core identity fields raw relies on

## Architecture Diagram

```text
User-selected mode
  -> raw
  -> slab

Capture Input
  -> Shared Front Half
      - frame source selection
      - reticle-guided target selection
      - perspective normalization
      - mode sanity signals
      - stage artifact capture

If selected mode == raw:
  -> Raw Pipeline
      - raw scene traits
      - raw ROI planning
      - progressive raw OCR
      - raw evidence synthesis
      - raw field confidence scoring
      - raw evidence payload to backend

If selected mode == slab:
  -> Slab Pipeline
      - slab scene traits
      - slab ROI planning
      - progressive slab OCR
      - slab evidence synthesis
      - slab field confidence scoring
      - slab evidence payload to backend
```

## Source Image Policy

- OCR should use the best available captured image:
  - preview frame first when it is sufficient
  - still image only when escalation logic says a retry is justified
- The reticle should not be treated as the final OCR crop.
- The reticle is only:
  - a hint for target selection
  - a bias toward user intent
- The selected target and normalized crop become the OCR input.

This is required for:

- off-center cards
- farther-away captures
- holders / top-loaders
- slabs with extra margins
- preview-frame drift

## Scene Traits

### Raw scene traits

Raw must support:

- bare raw cards
- sleeved cards
- top-loaders / holders

These are traits inside the raw branch, not separate modes.

Examples:

- `hasHolderEdgesLikely`
- `hasInnerCardWindowLikely`
- `hasGlareLikely`
- `footerOcclusionRisk`
- `borderOcclusionRisk`

These traits tune:

- target selection
- ROI insets / expansion
- escalation thresholds

### Slab scene traits

Examples:

- `labelContrastWeak`
- `barcodeLikelyVisible`
- `glareAcrossLabel`
- `rightColumnStructureLikely`

These traits tune:

- slab ROI planning
- field-specific escalation

## Progressive OCR Budget

Do not run multi-pass OCR everywhere by default.

### Shared front half

Always do:

- source image selection
- target selection
- normalization

### Raw pipeline

Stage 1:

- `headerWide`
- `footerBandWide`
- one normal OCR pass each

Stop early if:

- title evidence is already usable
- collector or set evidence is already usable
- overall evidence is sufficient for backend handoff

Escalate to Stage 2 only if:

- title evidence is weak
- collector evidence is weak
- or evidence is contradictory
- and target quality is good enough to justify more OCR work

Stage 2:

- `nameplateTight`
- `footerLeft`
- `footerRight`

Escalate to Stage 3 only if:

- Stage 2 remains weak or contradictory
- source resolution is high enough
- target quality is strong enough

Stage 3:

- selective preprocessing variants only on weak ROIs
- usually header or footer, not the full ROI set

### Slab pipeline

Stage 1:

- `labelWide`
- `descriptionWide`
- one normal OCR pass each

These should try to extract:

- title / name clues
- set clues
- card-number clues
- grader / grade clues when available

Escalate to Stage 2 only if:

- identity fields are weak
- grader / grade remain weak
- and target quality is good enough

Stage 2:

- focused title / name ROI
- focused card-number ROI
- focused set ROI
- focused grader / grade ROI

Escalate to Stage 3 only if:

- identity or pricing-critical fields are still ambiguous
- target quality is high
- additional OCR work is likely to help

Stage 3:

- optional cert-focused ROI
- optional selective preprocessing on weak slab ROIs

Important:

- cert is optional
- cert should not be the only slab OCR success criterion

## Dual Confidence Model

There are two different confidence layers.

### OCR field confidence

This belongs in the app OCR pipeline.

It answers:

- how confident are we that we read each field correctly from the image?

Examples:

- `targetConfidence`
- `titleConfidence`
- `collectorConfidence`
- `setConfidence`
- `graderConfidence`
- `gradeConfidence`
- `certConfidence`

This should be based on:

- OCR token confidence
- agreement across ROIs
- agreement across OCR passes
- parser validity
- target quality
- contradictions

### Backend match confidence

This belongs in the backend matcher.

It answers:

- how confident are we that this evidence matches this card?

Examples:

- top candidate margin
- agreement among title / set / number
- ambiguity among similar candidates
- final confidence bucket

### Rule

- OCR sends fields plus field confidences
- backend uses them as weighted evidence
- backend still computes its own final match confidence

Do not collapse these two layers into one score.

## Tunable Confidence Model

Confidence weights and thresholds must be centralized and tunable.

They should live in a dedicated config module, not be scattered through the OCR pipeline.

Suggested file:

- `Spotlight/Services/OCR/OCRTuning.swift`

Suggested config groups:

- target selection thresholds
- ROI escalation thresholds
- still-photo retry thresholds
- raw field confidence thresholds
- slab field confidence thresholds
- low-confidence warning thresholds

Low overall confidence must not drop evidence fields on the floor.

Even low-confidence outputs should preserve:

- weak titles
- partial collector numbers
- weak set hints
- weak grader / grade candidates
- optional cert candidates

## Replayable Stage Artifacts

The new pipeline must support replay/debug from each major stage.

Required artifacts:

- original full frame
- selected target rectangle
- normalized target crop
- generated ROIs
- OCR pass outputs per ROI
- synthesized evidence object
- final decision / fallback reason

This is required so debugging can happen at the failing stage instead of guessing end-to-end.

## Fixture-First Migration

Before deleting old OCR logic, the new pipeline must run against named golden fixtures.

Required cases:

- `raw_centered_clean`
- `raw_offcenter`
- `raw_farther`
- `raw_leading_zero`
- `raw_special_format`
- `raw_in_holder`
- `raw_multi_object_choose_target`
- `raw_low_confidence_fallback`
- `slab_centered_clean`
- `slab_offcenter`
- `slab_farther`
- `slab_glare_moderate`
- `slab_multi_object_choose_target`
- `slab_low_confidence_fallback`

Each fixture should include:

- source image
- expected mode
- expected target selection behavior
- expected key evidence fields
- expected fallback behavior when confidence is low

## Side-by-Side Rollout

Do not replace the old OCR path immediately.

Use feature flags such as:

- `useNewOCRPipeline`
- `runBothOCRPipelinesForDebug`

During migration:

- old OCR remains runnable
- new OCR remains runnable
- fixture harness can run both on the same input
- debug artifacts and synthesized evidence can be diffed

Only remove the old path once the new path proves better on named fixtures and on-device debug runs.

## Specific Files To Create

### Shared

- `Spotlight/Services/OCR/ScanPipelineTypes.swift`
- `Spotlight/Services/OCR/FrameSourceSelection.swift`
- `Spotlight/Services/OCR/TargetSelection.swift`
- `Spotlight/Services/OCR/PerspectiveNormalization.swift`
- `Spotlight/Services/OCR/ModeSanitySignals.swift`
- `Spotlight/Services/OCR/ScanStageArtifactWriter.swift`
- `Spotlight/Services/OCR/OCRTuning.swift`

### Raw

- `Spotlight/Services/OCR/Raw/RawSceneTraits.swift`
- `Spotlight/Services/OCR/Raw/RawROIPlanner.swift`
- `Spotlight/Services/OCR/Raw/RawOCRPassRunner.swift`
- `Spotlight/Services/OCR/Raw/RawEvidenceSynthesizer.swift`
- `Spotlight/Services/OCR/Raw/RawConfidenceModel.swift`
- `Spotlight/Services/OCR/Raw/RawPipeline.swift`

### Slab

- `Spotlight/Services/OCR/Slab/SlabSceneTraits.swift`
- `Spotlight/Services/OCR/Slab/SlabROIPlanner.swift`
- `Spotlight/Services/OCR/Slab/SlabOCRPassRunner.swift`
- `Spotlight/Services/OCR/Slab/SlabEvidenceSynthesizer.swift`
- `Spotlight/Services/OCR/Slab/SlabConfidenceModel.swift`
- `Spotlight/Services/OCR/Slab/SlabPipeline.swift`

### Fixtures / tools

- `tools/ocr_fixture_runner.swift`
- `tools/run_ocr_fixture_runner.sh`
- `qa/ocr-fixtures/`
- `qa/ocr-golden/`

## Specific Files To Keep Temporarily

- `Spotlight/Services/CardRectangleAnalyzer.swift`
- `Spotlight/Services/CardIdentifierParsing.swift`
- `Spotlight/Services/SlabLabelParsing.swift`
- `Spotlight/ViewModels/ScannerViewModel.swift`
- `Spotlight/Models/ScanModels.swift`

## OCR Phase-By-Phase Implementation Checklist

### Phase 0: Freeze contracts and docs

Goal:

- define the new OCR source-of-truth docs before coding

Files:

- `AGENTS.md`
- `PLAN.md`
- `docs/spotlight-scanner-master-status-2026-04-03.md`
- `docs/ocr-architecture-rewrite-spec-2026-04-09.md`

Deliverables:

- agreed architecture
- agreed responsibilities
- agreed rollout order

### Phase 1: Shared data contracts

Goal:

- define the shared stage payloads and evidence models

Files:

- `Spotlight/Services/OCR/ScanPipelineTypes.swift`
- `Spotlight/Models/ScanModels.swift`

Add:

- normalized target contract
- raw evidence contract
- slab evidence contract
- field confidence contract

### Phase 2: Fixture harness first

Goal:

- build golden fixtures before deleting any OCR logic

Files:

- `tools/ocr_fixture_runner.swift`
- `tools/run_ocr_fixture_runner.sh`
- `qa/ocr-fixtures/`
- `qa/ocr-golden/`

Add:

- named fixture packs
- expected outputs
- diffable reports for old vs new OCR

### Phase 3: Stage artifact and replay framework

Goal:

- make the rewrite debuggable stage by stage

Files:

- `Spotlight/Services/OCR/ScanStageArtifactWriter.swift`
- `Spotlight/Services/OCR/ScanPipelineTypes.swift`

Add:

- original frame artifact
- target selection artifact
- normalized target artifact
- ROI manifest
- OCR-pass output manifest
- synthesized evidence artifact
- final fallback / decision artifact

### Phase 4: Shared front half

Goal:

- pull shared geometry and source selection into dedicated modules

Files:

- `Spotlight/Services/OCR/FrameSourceSelection.swift`
- `Spotlight/Services/OCR/TargetSelection.swift`
- `Spotlight/Services/OCR/PerspectiveNormalization.swift`

Use:

- best available source image
- reticle-guided target selection
- normalized upright target crop

Keep old OCR path alive while the shared front half is validated on fixtures.

### Phase 5: Mode sanity signals and feature flags

Goal:

- branch by UI-selected mode, not OCR auto-routing

Files:

- `Spotlight/Services/OCR/ModeSanitySignals.swift`
- `Spotlight/ViewModels/ScannerViewModel.swift`
- `Spotlight/Models/ScanModels.swift`

Add:

- `useNewOCRPipeline`
- `runBothOCRPipelinesForDebug`
- raw/slab sanity warnings only

Do not silently reroute raw to slab or slab to raw.

### Phase 6: Raw branch stage 1

Goal:

- build the first useful raw branch with cheap broad OCR only

Files:

- `Spotlight/Services/OCR/Raw/RawSceneTraits.swift`
- `Spotlight/Services/OCR/Raw/RawROIPlanner.swift`
- `Spotlight/Services/OCR/Raw/RawOCRPassRunner.swift`
- `Spotlight/Services/OCR/Raw/RawEvidenceSynthesizer.swift`
- `Spotlight/Services/OCR/Raw/RawPipeline.swift`

Initial scope:

- `headerWide`
- `footerBandWide`
- one pass each
- evidence output only

### Phase 7: Raw escalation and confidence

Goal:

- add selective escalation without exploding latency

Files:

- `Spotlight/Services/OCR/Raw/RawConfidenceModel.swift`
- `Spotlight/Services/OCR/OCRTuning.swift`

Add:

- `nameplateTight`
- `footerLeft`
- `footerRight`
- selective preprocessing only when needed
- raw field confidence outputs
- still-photo retry rules
- per-fixture rewrite outputs under `qa/ocr-golden/simulator-rewrite-v1-raw-stage2`

### Phase 8: Slab branch stage 1

Goal:

- build the first useful slab branch with broad label OCR

Files:

- `Spotlight/Services/OCR/Slab/SlabSceneTraits.swift`
- `Spotlight/Services/OCR/Slab/SlabROIPlanner.swift`
- `Spotlight/Services/OCR/Slab/SlabOCRPassRunner.swift`
- `Spotlight/Services/OCR/Slab/SlabEvidenceSynthesizer.swift`
- `Spotlight/Services/OCR/Slab/SlabPipeline.swift`

Initial scope:

- `labelWide`
- `descriptionWide`
- identity evidence
- grader / grade when easy
- optional cert support

### Phase 9: Slab escalation and confidence

Goal:

- add focused slab field extraction only when needed

Files:

- `Spotlight/Services/OCR/Slab/SlabConfidenceModel.swift`
- `Spotlight/Services/OCR/OCRTuning.swift`

Add:

- focused title / number / set / grader / grade ROIs
- optional cert ROI
- slab field confidence outputs

### Phase 10: Backend payload integration

Goal:

- send richer OCR evidence and field confidence to backend without breaking runtime flow

Files:

- `Spotlight/Models/ScanModels.swift`
- `Spotlight/Services/CardMatchingService.swift`
- `backend/server.py`
- `backend/catalog_tools.py`

Rules:

- raw backend consumes OCR evidence + field confidence
- backend still owns final match confidence
- slab payload is designed for later slab backend rebuild, even if the current backend remains raw-only

### Phase 11: Side-by-side comparisons

Goal:

- prove the new pipeline is better before cutover

Files:

- `tools/ocr_fixture_runner.swift`
- `qa/ocr-golden/`

Requirements:

- old vs new diff report
- fixture pass/fail report
- on-device debug artifact comparisons

### Phase 12: Controlled cutover

Goal:

- switch default OCR path only after evidence supports it

Files:

- `Spotlight/ViewModels/ScannerViewModel.swift`
- `Spotlight/Services/CardRectangleAnalyzer.swift`

Do:

- make the new pipeline the default
- keep the legacy path behind debug-only fallback until confidence is high

### Phase 13: Legacy OCR deletion

Goal:

- remove the old intertwined OCR path only after cutover proves safe

Files:

- `Spotlight/Services/CardRectangleAnalyzer.swift`
- any duplicate legacy OCR helpers no longer used

## Deletion Criteria For The Old OCR Path

Only remove the old OCR path when all are true:

1. fixture harness exists and is repeatable
2. the new path runs behind a feature flag
3. both paths can run side-by-side on the same fixture/capture
4. raw fixtures are at least as good as the old path on the named raw cases
5. slab fixtures are at least as good as the old path on the named slab cases
6. replayable stage artifacts exist for the new path
7. confidence/scoring is centralized and tunable
8. there is no major on-device latency regression

## Biggest Remaining Risks

- target selection may still be the hardest problem for holders and glare
- slab label layouts may vary more than the first ROI model expects
- OCR variance across preprocessing passes may make confidence tuning noisy at first
- escalation rules may grow latency if thresholds are too loose
- weak fixture quality will make the rewrite look better than it really is
