# Slab Cert-First Scrydex Rebuild Implementation Spec

Date: 2026-04-11

## Status

- This document is the slab implementation source of truth for the next slab rebuild.
- It replaces ad hoc slab follow-up ideas scattered across older docs and code comments.
- Current runtime reality:
  - slab OCR still exists in the app
  - slab backend resolution and graded pricing code still exist on the backend
  - the app keeps slab `/api/v1/scan/match` requests feature-flagged off by default in the shipped path
  - current slab OCR is PSA-only by design
  - experimental repeat-scan cert-cache resolver paths are already landed:
    - `psa_cert_barcode`
    - `psa_cert_ocr`
  - identity-without-pricing responses are already landed
- Current phase status:
  - Phase 0 codebase review: complete
  - Phase 1 implementation: groundwork in progress
  - cleanup/deletion: not started

## Why This Exists

Slab scanning should not be treated like raw scanning.

A slab label gives the app and backend cleaner signals than a raw card:

- a printed cert number
- a printed grade
- a printed grader
- a printed card name and set context
- often a barcode carrying the cert number

That changes the correct architecture:

- slabs should be OCR-primary
- slabs should be cert-first
- slabs do not need visual matching
- slab identity must be separable from slab pricing

The current codebase is split-brain:

- docs say slab runtime is deferred / raw-only
- the app still exposes slab mode
- the backend still contains slab resolution and graded pricing paths
- the app blocks the actual match request before the backend can run

This spec defines the clean cutover path and the cleanup that must follow it.

This phase is about slab identification and Scrydex pricing, not PSA verification.

## Product Goal

Phase-1 slab goal:

- support PSA slab scans for Pokemon cards
- support both:
  - full slab photos
  - label-only photos
- make cert-number resolution the primary identity path
- use Scrydex as the slab pricing source once the underlying card identity is known
- return identified slab/card details even when exact graded pricing is unavailable
- reach:
  - cert exact-match rate above `90%`
  - end-to-end correct identification rate above `95%` on the held-out PSA slab regression suite

## Scope

This spec covers:

- slab capture and target-selection behavior
- slab OCR path design
- slab evidence synthesis
- slab backend cert-first resolution
- slab response contract changes
- slab pricing behavior after identity is known
- slab regression fixtures and runners
- slab cleanup / deletion after cutover

This spec does not cover:

- non-PSA slab families in the first shipping phase
- non-Pokemon cross-game catalog support
- raw visual matching work
- broad scanner UI redesign outside slab-specific bug fixes

## Product Constraints

- Treat label-only scans as a first-class product path, not a degraded fallback.
- Do not add visual matching for slabs.
- Do not block identity on pricing availability.
- Do not broaden to CGC/BGS/TAG until PSA cert-first is stable.
- Do not add PSA API integration or official-verification claims in phase 1.
- Do not claim generic “all cards / all slabs” support in this phase.
  - Phase 1 target is:
    - PSA
    - Pokemon
- Cleanup of dead slab code is a required phase, not optional follow-up.

## Current Runtime Reality

### App routing

- The app still routes slab mode into `SlabScanner` through `OCRPipelineCoordinator`.
- The slab scanner still emits a transitional legacy `ocrAnalysis` envelope.
- The app packages slab OCR evidence into the backend payload shape.
- The app now gates slab scan-match requests behind `SPOTLIGHT_ENABLE_SLAB_MATCHING`.

### OCR behavior

- Current slab OCR is top-label-first and PSA-weighted.
- It uses fixed ROIs on a normalized slab image:
  - top label wide
  - cert region
  - expanded top label
  - right column
- It uses:
  - text OCR
  - barcode detection
  - PSA-style visual inference
- It still assumes full-slab geometry too strongly for the main user behavior.

### Target-selection gap

- Current slab target selection prefers a full slab portrait rectangle.
- If that is not found, slab falls back to the exact reticle crop.
- There is no dedicated label-only path that treats “just the top label” as a valid primary input.

### Backend behavior

- The backend still routes slab payloads into a slab matcher.
- The first cert-first backend rung is now a repeat-scan cert cache in `scan_events`.
- First-seen slabs still resolve candidates by:
  - title
  - set hints
  - card number
- Scrydex remains the pricing source once the card identity is known.
- No live PSA verifier is part of this phase.
- Identity can now succeed even when exact graded pricing is missing.

### Cleanup gap

- Docs still frame slab runtime as deferred.
- Backend health/provider-status still advertise slab support.
- Old heuristic slab repair logic still exists to compensate for weak upstream OCR.

## Core Decisions

### Decision 1: label-only scans move to Priority 1

If most slab users scan only the label, then label-only support is part of the primary architecture.

Do not defer it to a polish phase.

### Decision 2: cert is the primary slab key

Slab resolution priority order:

1. barcode-derived cert
2. OCR-derived cert
3. fallback text identity search

If a cert is strong, the backend should resolve from the cert path first.

In phase 1 that means:

- repeat-scan cert cache hits first
- optional provider-side cert lookup later only if Scrydex exposes it cleanly
- no PSA verification calls

### Decision 3: full-slab and label-only are separate OCR entry paths

There are two valid slab capture shapes:

- a full slab photo
- a top-label-only photo

Do not force both through one geometry assumption.

### Decision 4: identity and pricing are separate backend concerns

The backend must be allowed to return:

- exact slab identity
- grader / grade / cert
- underlying card identity
- `pricing = null`

That is still a successful slab scan.

### Decision 5: PSA-only for the first shipped rebuild

Phase 1 supports:

- PSA slabs only

For non-PSA slabs:

- return explicit unsupported / needs-review state
- do not route them through pretend generic parsing

### Decision 6: no slab visual matcher

Do not add CLIP retrieval, artwork search, or raw-style visual matching for slabs.

The cert / label path is the correct architecture.

### Decision 7: mandatory cleanup after cutover

When the cert-first slab path is green on the held-out suite:

- delete obsolete slab heuristics
- remove dead transitional app/backend branches
- align docs and ops metadata with real runtime behavior

## Revised Implementation Order

1. build `qa/slab-regression/` with tuning and held-out PSA fixtures
2. measure current baseline:
  - cert exact match
  - grade match
  - card identity match
  - end-to-end scan success
3. implement slab OCR split:
  - full-slab path
  - label-only path
4. make cert extraction dominant in iOS:
  - barcode first
  - OCR cert second
  - conservative normalization
5. add backend cert-first resolver and distinct slab resolver paths
6. decouple slab identity from graded pricing
7. re-enable slab backend matching through a real feature flag
8. fix known bugs:
  - cert-loss refresh
  - medium-confidence auto-accept
  - misleading provider status
9. run held-out regression and tune only against the tuning suite
10. perform required cleanup and deletion before broadening slab scope

## Target Architecture

### Capture and target selection

#### Path A: full slab

When a slab-shaped rectangle is confidently detected:

1. perspective-correct the slab
2. normalize it upright
3. run fixed PSA label ROIs on the normalized slab

#### Path B: label-only

When a full slab rectangle is not confidently detected:

1. treat the reticle crop / search crop as a valid label candidate
2. run:
  - barcode detection on the whole crop
  - cert OCR on the whole crop
  - broad label OCR on the crop
3. optionally localize a high-contrast label block inside the crop before OCR

Label-only is a supported primary path, not a fallback-only debug mode.

### OCR evidence priority

The slab OCR output should prioritize:

1. cert
2. grader
3. grade
4. card number
5. title / set context

The parser should be conservative:

- normalize whitespace
- normalize obvious OCR confusables in constrained numeric fields
- do not aggressively repair or abbreviate title text

### Backend resolution ladder

Resolver order:

1. `psa_cert_barcode`
  - strong cert from barcode with repeat-scan cache hit
2. `psa_cert_ocr`
  - strong cert from OCR with repeat-scan cache hit
3. `psa_label`
  - fallback title / set / card-number search through local cache + Scrydex

The backend response should preserve which path was used.

### Response contract

Successful slab identity responses may have:

- card identity present
- slab context present
- pricing present or absent

Missing pricing should not force `unsupported`.

### Pricing behavior

After identity resolution:

- return cached exact-grade pricing if available
- refresh exact-grade pricing from Scrydex only when needed by freshness rules or explicit user refresh
- if no exact-grade pricing exists, return the identity payload with pricing unavailable

## File-By-File Change Plan

### App OCR routing and structure

#### [Spotlight/App/AppContainer.swift](/Users/stephenchan/Code/spotlight/Spotlight/App/AppContainer.swift)

Changes:

- replace direct construction of legacy `SlabScanner` as the long-term slab implementation with a dedicated slab pipeline entry once new slab files exist
- keep the coordinator seam, but route slab through the new slab pipeline instead of growing the legacy analyzer

Target:

- one explicit slab pipeline object
- no ambiguity about legacy vs active slab path

#### [Spotlight/Services/OCR/ModeSanitySignals.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/ModeSanitySignals.swift)

Changes:

- keep the coordinator split:
  - raw branch
  - slab branch
- replace the legacy slab envelope builder with a dedicated slab rewrite envelope builder
- emit slab pipeline version metadata distinct from `legacy_v1`

Target:

- slab uses the same contract shape as raw:
  - normalized target
  - mode sanity
  - slab evidence
  - field confidences

### App slab target selection

#### [Spotlight/Services/OCR/TargetSelection.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/TargetSelection.swift)

Changes:

- preserve current full-slab rectangle detection path
- add slab-specific label-only acceptance path when no full slab rectangle is accepted
- distinguish:
  - `full_slab_selected`
  - `slab_label_only_fallback`
  - `exact_reticle_fallback`
- add slab-specific fallback reason strings that are useful in regression outputs

Target:

- full slab photos still use perspective-corrected slab geometry
- label-only photos no longer fail simply because no full slab rectangle was found

#### [Spotlight/Services/OCR/PerspectiveNormalization.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/PerspectiveNormalization.swift)

Changes:

- add slab fallback normalization behavior instead of raw-only special cases
- preserve current full-slab normalization
- add a slab label-only normalization/result path that does not pretend the crop is a full slab

Target:

- slab normalization reports whether the OCR input is:
  - full slab
  - label-only
  - generic fallback

### App slab OCR implementation

#### New file: [Spotlight/Services/OCR/Slab/SlabPipeline.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Slab/SlabPipeline.swift)

Changes:

- create the dedicated slab pipeline actor
- own slab stage orchestration
- call target selection
- branch into:
  - full-slab OCR
  - label-only OCR
- produce `AnalyzedCapture` with slab rewrite metadata

Target:

- remove slab orchestration pressure from `SlabScanner.swift`

#### New file: [Spotlight/Services/OCR/Slab/SlabROIPlanner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Slab/SlabROIPlanner.swift)

Changes:

- define ROI sets for:
  - full slab
  - label-only crop
- keep PSA-only geometry for phase 1
- express ROI/stage order explicitly

Target:

- cert-first ROI planning
- no ad hoc ROI growth inside the analyzer

#### New file: [Spotlight/Services/OCR/Slab/SlabCertDetector.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Slab/SlabCertDetector.swift)

Changes:

- centralize:
  - barcode detection
  - cert OCR extraction
  - cert confidence merging
- prefer barcode over OCR when both succeed
- output:
  - normalized cert
  - source
  - confidence

Target:

- cert extraction becomes the dominant slab signal instead of one field among many

#### [Spotlight/Services/SlabLabelParsing.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/SlabLabelParsing.swift)

Changes:

- keep PSA-only behavior for phase 1
- separate parsers internally:
  - cert parser
  - grader parser
  - grade parser
  - card-number parser
  - title/set text parser
- reduce aggressive title repair / inferred text recovery
- keep numeric OCR cleanup in constrained fields
- preserve explicit non-PSA detection and unsupported behavior
- expose cert-first lookup recommendations more explicitly

Target:

- clean title text stays clean
- cert extraction quality improves
- fallback text matching stops depending on over-processed titles

#### Transitional file: [Spotlight/Services/SlabScanner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/SlabScanner.swift)

Changes:

- phase 1:
  - stop adding new slab logic here
  - keep only a thin compatibility wrapper if needed during migration
- phase 2 cleanup:
  - remove slab pipeline implementation from this file once the dedicated slab pipeline is active

Target:

- this file should no longer be the long-term home of slab OCR behavior

### App networking and UI behavior

#### [Spotlight/Services/CardMatchingService.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardMatchingService.swift)

Changes:

- replace `isScanMatchRequestTemporarilyDisabled = true` with a real runtime feature flag
- allow slab match requests to hit the backend when the flag is enabled
- preserve request payload fields already being sent:
  - cert
  - barcode payloads
  - grader / grade
  - slab analysis envelope

Target:

- no hardcoded “pretend unsupported” slab behavior in the shipped path

#### [Spotlight/ViewModels/ScannerViewModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift)

Changes:

- do not auto-accept medium-confidence slab matches
- preserve the original `slabContext.certNumber` when detail refresh responses omit it
- treat:
  - identified slab with pricing unavailable
  - unsupported slab
  as distinct states

Target:

- slab rows remain useful even without live graded pricing
- cert does not disappear after refresh

#### [Spotlight/Views/ScannerView.swift](/Users/stephenchan/Code/spotlight/Spotlight/Views/ScannerView.swift)

Changes:

- display identified slab details even when `pricing == nil`
- keep explicit messaging for:
  - identity found
  - graded pricing unavailable
- keep showing:
  - grader
  - grade
  - cert
  when present

Target:

- users see “we identified your slab” instead of a blanket unsupported state when pricing is absent

#### [Spotlight/Models/CardCandidate.swift](/Users/stephenchan/Code/spotlight/Spotlight/Models/CardCandidate.swift)

Changes:

- preserve existing optional pricing shape
- ensure slab context survives detail and refresh flows cleanly
- no schema redesign required unless variant/cert display needs explicit additions

### Backend slab identity resolution

#### [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)

Changes:

- add a cert-first slab resolver before text-based slab candidate search
- consume:
  - cert
  - barcode-derived cert
  - lookup-path hints
- separate:
  - identity resolution
  - price serving
  - price refresh
- add distinct slab resolver paths:
  - `psa_cert_barcode`
  - `psa_cert_ocr`
  - `psa_label`
- stop returning `unsupported` only because exact graded pricing is missing
- preserve cert in `card_detail(...)` responses
- update health/provider-status outputs to match real slab runtime state

Target:

- repeat-scan cert hits bypass heuristic slab search
- identified slabs can succeed without exact-grade pricing

#### New file: [backend/slab_cert_resolver.py](/Users/stephenchan/Code/spotlight/backend/slab_cert_resolver.py)

Changes:

- add a dedicated slab cert-resolution seam
- own:
  - cert normalization
  - repeat-scan cert cache lookup
  - future provider-side cert lookup integration if Scrydex exposes it cleanly
  - mapping cert hits into catalog card identity
- return:
  - resolved card record
  - grader
  - grade
  - cert
  - source path / confidence

Target:

- cert logic stops being implicit inside generic slab search code

#### [backend/scrydex_adapter.py](/Users/stephenchan/Code/spotlight/backend/scrydex_adapter.py)

Changes:

- keep Scrydex as the first-seen slab identity/pricing provider
- add a cert-based lookup path only if Scrydex exposes one cleanly
- keep current title / set / number slab search as fallback only
- avoid expanding heuristic slab query generation once cert-first is active

Target:

- Scrydex supports:
  - first-seen slab identity/pricing by card identity today
  - cert lookup later if the provider supports it
  - fallback label search only when cert resolution fails

#### [backend/catalog_tools.py](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py)

Changes:

- keep resolver-mode routing support for slab payloads
- do not grow slab identity heuristics here
- use this module only for shared DB / pricing utilities needed by the new slab path

Target:

- slab logic does not sprawl further into generic raw catalog tooling

### Backend pricing behavior

#### [backend/pricing_provider.py](/Users/stephenchan/Code/spotlight/backend/pricing_provider.py)

Changes:

- keep identity separate from pricing refresh behavior
- no major contract change required unless cert-aware provider refresh metadata is needed

#### [backend/pricecharting_adapter.py](/Users/stephenchan/Code/spotlight/backend/pricecharting_adapter.py)

Changes:

- stop advertising PSA support if the adapter intentionally fails for graded pricing in the current build
- keep it as an honest thin shell, not a misleading ready provider

Target:

- provider-status output matches reality

#### [backend/pricing_provider.py](/Users/stephenchan/Code/spotlight/backend/pricing_provider.py)

Changes:

- no slab-pricing expansion in this phase
- keep raw-only pricing support explicit

### QA and regression

#### New directory: [qa/slab-regression](/Users/stephenchan/Code/spotlight/qa/slab-regression)

Contents:

- tuning fixtures
- held-out fixtures
- ground-truth manifest with:
  - grader
  - grade
  - cert
  - card identity
  - scan shape:
    - full slab
    - label only

#### New tool: [tools/run_slab_regression.sh](/Users/stephenchan/Code/spotlight/tools/run_slab_regression.sh)

Changes:

- run slab OCR / backend regression over the fixture corpus
- report:
  - cert exact-match rate
  - grader exact-match rate
  - grade exact-match rate
  - card identity exact-match rate
  - end-to-end success rate
  - split by:
    - full slab
    - label only

#### New test module: [backend/tests/test_slab_cert_resolution.py](/Users/stephenchan/Code/spotlight/backend/tests/test_slab_cert_resolution.py)

Changes:

- add focused cert-first tests separate from the older mixed phase-1 test file
- cover:
  - barcode cert resolution
  - OCR cert resolution
  - fallback text resolution
  - identity with no pricing
  - non-PSA explicit unsupported path

#### [tools/slab_label_parser_tests.swift](/Users/stephenchan/Code/spotlight/tools/slab_label_parser_tests.swift)

Changes:

- expand beyond the single noisy-grade case
- add:
  - clean PSA cert case
  - barcode-preferred cert case
  - label-only cert OCR case
  - non-PSA explicit unsupported case
  - conservative title handling case

### Docs and planning

#### [PLAN.md](/Users/stephenchan/Code/spotlight/PLAN.md)

Changes:

- point slab planning to this spec
- keep milestone state honest until implementation actually lands

#### [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md)

Changes:

- reference this spec as the slab rebuild source of truth
- clarify the current split state until the app/backend cutover is finished

## Required Cleanup / Deletion Phase

After the held-out slab regression passes:

1. remove the hard-disabled slab match behavior from the app
2. delete obsolete slab logic from `SlabScanner.swift`
3. remove slab title-repair heuristics that only exist to compensate for weak OCR
4. remove transitional “legacy slab” naming where the rewrite path has replaced it
5. align docs, health output, and provider-status output with actual runtime behavior
6. remove stale slab tests that validate pre-cert-first behavior instead of the shipped path

Do not begin broad non-PSA expansion before this cleanup is done.

## Validation Plan

### Success metrics

Held-out PSA slab suite targets:

- cert exact-match: `>= 90%`
- end-to-end correct identification: `>= 95%`
- pricing-unavailable-but-identity-correct cases:
  - counted as identity success
  - not counted as unsupported failure

### Required validation

- run slab parser unit tests
- run slab backend cert-resolution tests
- run end-to-end slab regression on:
  - full slab fixtures
  - label-only fixtures
- verify refresh preserves:
  - grader
  - grade
  - cert
- verify no medium-confidence slab auto-accept

## Explicit Non-Goals For Phase 1

- CGC support
- BGS support
- TAG support
- slab visual retrieval
- multi-game catalog support
- broad “all slabs” marketing claims

Phase 1 should ship one clean promise:

- PSA Pokemon slabs
- full slab and label-only captures
- cert-first identity
- graceful no-price handling
