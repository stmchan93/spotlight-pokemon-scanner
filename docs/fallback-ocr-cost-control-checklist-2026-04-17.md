# Fallback OCR Cost Control Checklist

Date: 2026-04-17

## Goal

Reduce the catastrophic latency of the raw fallback OCR path without lowering normal-scan accuracy.

Current measured evidence to anchor on:

- OCR total on a bad fallback scan: `~4.3s`
- fallback `12_raw_header_wide`: `~3.5s`
- visual phase round-trip: `~0.9s`
- rerank round-trip: `~0.4s`
- `waitAfterOCRMs=0`, so the visual phase is already overlapping correctly

This checklist is intentionally split into:

- no-risk transport / observability work
- behavior-changing fallback gating work

## Phase 1

### No-Risk Transport / Observability

Scope:

- keep OCR decisions unchanged
- improve logs and payload visibility so the remaining cost can be measured precisely
- trim only request/response overhead that does not change OCR output

Files:

- [Spotlight/ViewModels/ScannerViewModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/ViewModels/ScannerViewModel.swift)
- [Spotlight/Services/CardMatchingService.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/CardMatchingService.swift)
- [backend/server.py](/Users/stephenchan/Code/spotlight/backend/server.py)

Checklist:

1. Keep the current split timing logs for:
   - `waitAfterOCRMs`
   - `visualRoundTripMs`
   - `visualServerMs`
   - `visualTransportMs`
   - `resolutionRoundTripMs`
   - `resolutionServerMs`
   - `resolutionTransportMs`
2. Keep backend cache logs for:
   - shortlist store
   - shortlist reuse
   - rerank completion
   - rerank fallback
3. Keep endpoint wall-time logs for:
   - `/api/v1/scan/visual-match`
   - `/api/v1/scan/rerank`
4. If the provisional visual response is still hidden in UI, keep the response payload minimal.
5. If response payload trimming is attempted, do not alter match ranking, candidate ordering, or OCR evidence.

Acceptance:

- logs show where rerank time is spent without changing match decisions
- no scan result quality changes relative to the current hidden-parallel baseline
- device logs clearly separate visual phase, OCR phase, and rerank phase

Validation:

- `python3 -m py_compile backend/server.py`
- `python3 -m unittest -q backend.tests.test_scan_two_phase_phase8`
- `xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build`

Risks:

- low
- the only real risk is confusing signal with no-op logging noise if the payload is not narrowed enough

## Phase 2

### Behavior-Changing Fallback Gating

Scope:

- reduce the pathological `raw_header_wide` cost only on the weak fallback path
- do not change the normal raw OCR path
- do not weaken footer OCR first-pass quality

Files:

- [Spotlight/Services/OCR/Raw/RawPipeline.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawPipeline.swift)
- [Spotlight/Services/OCR/Raw/RawConfidenceModel.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawConfidenceModel.swift)
- [Spotlight/Services/OCR/Raw/RawROIPlanner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawROIPlanner.swift)
- [Spotlight/Services/OCR/Raw/RawOCRPassRunner.swift](/Users/stephenchan/Code/spotlight/Spotlight/Services/OCR/Raw/RawOCRPassRunner.swift)
- [SpotlightTests/ScanReliabilityHeuristicsTests.swift](/Users/stephenchan/Code/spotlight/SpotlightTests/ScanReliabilityHeuristicsTests.swift)
- [SpotlightTests/OCRRewriteStage1FixtureTests.swift](/Users/stephenchan/Code/spotlight/SpotlightTests/OCRRewriteStage1FixtureTests.swift)

Checklist:

1. Extend the existing lowered-header skip gate instead of introducing a new OCR branch.
2. Only skip the full `12_raw_header_wide` pass when the lowered fallback pass already produced enough signal to avoid escalation.
3. Keep full header escalation when the lowered pass is weak, ambiguous, or missing title evidence.
4. Avoid changing the footer band or footer metadata pass behavior in this phase.
5. Keep the non-fallback `header_wide` path untouched.
6. Add or update tests around:
   - exact-reticle fallback with strong lowered header
   - exact-reticle fallback with weak lowered header
   - non-fallback behavior remaining unchanged
   - Japanese-title fallback still allowing escalation when the lowered pass is not confidently resolved

Acceptance:

- bad fallback scans stop paying the full `header_wide` cost when the lowered pass already settled the title strongly enough
- weak fallback scans still escalate when they truly need the extra OCR evidence
- fixture and heuristic tests stay green on the frozen suite
- no regression in match quality on the held-out raw regression corpus

Validation:

- `python3 -m unittest -q backend.tests.test_scan_two_phase_phase8`
- `xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -destination 'platform=iOS Simulator,id=7311EF3D-4B20-476B-9D36-1A65607C23CC' -derivedDataPath .derivedData test -only-testing:SpotlightTests/ScanReliabilityHeuristicsTests -only-testing:SpotlightTests/OCRRewriteStage1FixtureTests`
- `zsh tools/run_ocr_simulator_fixture_tests.sh`

Risks:

- medium
- the main risk is skipping `header_wide` too aggressively on weak fallback scans and losing a useful tie-breaker
- keep the gate narrow and data-driven

## Phase 3

### Acceptance Gates

Scope:

- prove the change did not harm the scan
- verify the latency win is real on the bad-tail cases

Checklist:

1. Compare fallback scan latency before and after the gating change.
2. Compare top-1 and top-3 match quality on the frozen held-out suite.
3. Ensure the normal non-fallback OCR path remains unchanged.
4. Confirm the worst fallback scans no longer spend seconds in `12_raw_header_wide`.

Acceptance:

- no quality regression on the frozen suite
- measurable reduction in fallback worst-case latency
- no increase in unsupported or review-only outcomes for strong scans

Validation:

- `python3 -m unittest -q backend.tests.test_scan_two_phase_phase8 backend.tests.test_raw_decision_phase5`
- `python3 -m unittest -q SpotlightTests.ScanReliabilityHeuristicsTests SpotlightTests.OCRRewriteStage1FixtureTests`

Risks:

- medium
- if the gate is too broad, the scan can lose a useful rescue pass and confidence can drop on fallback images

