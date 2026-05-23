# Scanner Live Lock-On UX Spec — 2026-05-21

## Status

**Deferred.** Active scanner-accuracy investment is corpus growth (see
[scanner-model-rewrite-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scanner-model-rewrite-spec-2026-04-23.md)
and
[raw-visual-local-dataset-workflow-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-local-dataset-workflow-2026-04-12.md)).
This spec captures the Phynite/PriceCharting-style lock-on capture UX design at the point
where it was scoped, so it can be picked up without re-deriving the architecture once corpus
growth plateaus.

**Revisit trigger.** Both conditions must hold:

1. Held-out top-1 has stopped moving with additional corpus growth + hard-negative mining
   cycles.
2. Failure-shape review on the held-out suite shows remaining misses are dominated by
   mis-framed / low-pixel-per-card captures, not visually-similar lookalikes. (If the
   remaining failures are lookalikes, the next investment is backbone/adapter work, not
   capture UX.)

## Context & motivation

Co-worker discussion compared the current scanner experience to:

- **Phynite** — animated frame "zooms" onto the card before capture, conveying that the
  framing has been understood.
- **PriceCharting** — live lock-on; the camera locks onto the card as the user pans, and
  auto-scans once aligned.

Distilled experience asks:

- Animated frame that "zooms" onto the detected card.
- White screen flash on shutter.
- Double haptic — one buzz on shutter, one on confirmation.
- Live lock-on overlay that follows the detected card.
- Tap anywhere after lock to commit the capture.

**Honest accuracy framing.** Per
[raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md)
and [scanner-model-rewrite-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scanner-model-rewrite-spec-2026-04-23.md):

- Capture-UX improvements (animated lock, perspective-correct crop, zoom 1.5→2.0×) are
  projected at **+1–3 fixtures** on the held-out suite. They feed Layer-A health metrics
  (pixels-per-card-height ≥80%, temporal stability) rather than retrieval ceiling.
- Corpus growth + hard-negative mining is projected at **+3–8 fixtures**. The K=20
  visual-pool ceiling — currently missing the truth card for 12/47 held-out fixtures — is
  not movable by framing.

This is real-but-secondary upside. Frame messaging around "better feel + small accuracy
nudge," not "this fixes the scanner."

## Scoping decisions (locked)

- **Modes.** Raw + slab, one unified flow.
- **Trigger.** Tap-anywhere-after-lock. No auto-capture in this scope. (Auto-capture is a
  later follow-up, deliberately deferred to lower false-trigger risk.)
- **Platforms.** iOS and Android together, via a single ML Kit Object Detection code path.

## Current state baseline

Confirmed at time of writing; verify before implementing.

- `apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx` owns capture
  orchestration in `handleCapture()` (≈L664–1040). One Light haptic at ≈L682
  (`triggerScannerHaptic()`). No flash, no sound, no animation.
- `apps/spotlight-rn/src/features/scanner/raw-scanner-capture-surface.tsx` mounts
  `CameraView` from `expo-camera`. Static reticle, `Pressable` over the reticle for
  tap-to-capture (≈L208–225).
- `apps/spotlight-rn/modules/spotlight-slab-scanner/ios/SpotlightSlabScannerModule.swift`
  runs ML Kit only on already-captured stills (`scanPSALabel`, `quickClassifyCapture`).
  **No live frame stream and no event emitter exist today.**
- Crop ROI today is the static reticle rect, applied post-capture by
  `makeReticleSourceImageCrop()` (`scanner-screen.tsx:~L784`).
- Legacy `Spotlight/Services/OCR/TargetSelection.swift` has `VNDetectRectanglesRequest`
  with proximity/aspect/confidence/area scoring. Reference logic only; do not wire from
  the legacy Swift app.

## Recommended architecture

Add a **parallel native live-detection view** to the existing `spotlight-slab-scanner`
Expo Module. Attach it to Expo Camera's existing back-camera capture session — do NOT
swap to `react-native-vision-camera` at this stage.

Trade-off: Vision Camera is the cleaner long-term answer and is already named as the
Phase 4–5 target in
[scanner-model-rewrite-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scanner-model-rewrite-spec-2026-04-23.md).
But swapping now means rewriting `raw-scanner-capture-surface.tsx`, tray gestures, lens /
picture-size handling, capture-quality plumbing, and `takePictureAsync` in
`handleCapture()` — large blast radius across recent-capture-swipe and slab-mode toggling.
A parallel sibling view keeps the still-photo path on Expo Camera while the analysis
stream gets its own `AVCaptureVideoDataOutput` (iOS) / CameraX `ImageAnalysis` (Android)
attached to the same device. When we later need single-source capture, promote to Vision
Camera with the JS contract already stable.

Detector: **ML Kit Object Detection**, `STREAM_MODE`, `enableClassification=false`,
single-object tracking on. ML Kit is already a `spotlight-slab-scanner` dependency. For
PSA slabs, keep the existing barcode + red-band cues from `quickClassifyCapture()` as a
secondary signal that boosts `classHint`.

## Detection event contract (native → JS)

New event `onLiveDetection` exposed via Expo Modules `Events("onLiveDetection")`:

```ts
type LiveDetection = {
  detectionId: string;           // monotonic per session
  ts: number;                    // ms since epoch
  previewSize: { w: number; h: number }; // preview-view points
  quad: {
    tl: { x: number; y: number };
    tr: { x: number; y: number };
    bl: { x: number; y: number };
    br: { x: number; y: number };
  };
  axisAlignedBox: { x: number; y: number; w: number; h: number };
  confidence: number;            // 0..1
  stabilityFrames: number;       // consecutive frames within 10px corner agreement
  locked: boolean;               // stabilityFrames >= 2 && confidence >= 0.62
  classHint: "raw" | "slab" | "unknown";
  zoomFactor: number;            // current device zoom
};
```

- **Cadence.** Detector runs at camera frame rate (~30 Hz) natively. Native side throttles
  emission to JS to ~10 Hz (drop intermediate frames; coalesce stability counter).
- **Stability gate.** Native — not JS — to avoid bridge-jitter resets. Matches
  `docs/scanner-model-rewrite-spec-2026-04-23.md:184` ("two consecutive preview frames
  within 10 px corner agreement") so this UX and the model rewrite share a single
  definition.
- **Coordinate mapping.** Native side must convert from `CMSampleBuffer` pixel space to
  preview-view points (`AVCaptureVideoPreviewLayer.layerPointConverted(fromCaptureDevicePoint:)`
  on iOS, equivalent transform on Android). Wrong mapping = corner guides drift relative
  to the card.

## UI overlay + animation

- New component `apps/spotlight-rn/src/features/scanner/live-detection-overlay.tsx`
  mounted via the existing `children` slot of `RawScannerCaptureSurface`
  (`raw-scanner-capture-surface.tsx:55, 276`).
- **Reanimated 3**, four corner-guide `Animated.View`s driven by `useSharedValue`s updated
  from the JS detection event via `withSpring`. SVG is overkill for four brackets.
- **"Zoom" is an animated overlay frame**, not a preview digital zoom. Animate the
  corner-guide quad from the static reticle rect to the locked-quad bbox over ~180 ms with
  `withTiming` and dim the surrounding mask. This visually matches Phynite's snap-to-card
  feel without touching Expo Camera's preview zoom (unreliable across SDK 55 versions).
- The Phase-2-spec'd device zoom 1.5×→2.0× remains a separate decision applied to the
  still-capture path (`CameraView` `zoom` prop), not the animated UX.

## Tap-anywhere-after-lock

- Replace the small reticle `Pressable` (`raw-scanner-capture-surface.tsx:208–225`) with a
  **full-surface `Pressable`** mounted below the existing `children` slot, so the tray
  gesture and back-button — both already in `children` — hit-test first.
- Tap behavior gated on a new `lockState` ref kept in `scanner-screen.tsx`:
  - `locked`: tap fires `handleCapture()` immediately, passing the locked quad through to
    the capture pipeline.
  - `unlocked`: tap falls back to today's behavior — fires `handleCapture()` using the
    static reticle (no regression for existing users). Add a subtle "Hold steady" hint
    if the surface has been unlocked >1.5 s after first detection.
- The recent-capture tray gesture (`recent-capture-tray-gesture.ts`) and the chrome back
  button stay unchanged because they're rendered above the new full-surface `Pressable`
  in the same `children` block.

## Feedback — white flash + double haptic

- **White flash.** Full-screen white `Animated.View`, `pointerEvents="none"`, opacity
  0 → 0.92 → 0 over ~140 ms, triggered on shutter press. Do NOT use the `CameraView`
  torch — torch is a hardware LED, not a shutter effect, and adds latency + permission
  noise.
- **Double haptic.** Promote `triggerScannerHaptic()` to take
  `kind: "shutter" | "confirm"`.
  - First buzz: existing `void triggerScannerHaptic("shutter")` at
    `scanner-screen.tsx:~L682` (Light impact). No behavior change here.
  - Second buzz: fire inside `runMatchForCapture` (`scanner-screen.tsx:~L1094`) at the
    point where the candidate list resolves, using
    `Haptics.NotificationFeedbackType.Success`. Do NOT fire on the local quick-classifier
    — users would feel a buzz that doesn't correlate with a visible UI change.

## Crop pipeline

- Today: `makeReticleSourceImageCrop()` (`scanner-screen.tsx:~L784`) returns an
  axis-aligned reticle rect.
- New: `makeLockedQuadSourceImageCrop()` in
  `apps/spotlight-rn/src/features/scanner/scanner-normalized-target.ts`. Accepts the
  locked preview-coord quad + capture dimensions; returns an extended `ScanSourceImageCrop`
  carrying both an axis-aligned bbox (for legacy consumers) and four corner points.
- **Perspective correction stays native**, gated to Phase 3:
  - iOS: extend `SpotlightSlabScannerModule.swift` with
    `AsyncFunction("perspectiveCorrectCapture")` using Core Image `CIPerspectiveCorrection`.
  - Android: matching Kotlin function in `SpotlightSlabScannerModule.kt` using
    `android.graphics.Matrix.setPolyToPoly` + bitmap re-sampling. Avoids adding OpenCV;
    keeps APK size sane.
- Output dimensions `630×880` to match the canonical normalized canvas
  (`docs/scanner-model-rewrite-spec-2026-04-23.md:46, 93`).
- Branching in `handleCapture()`: if `lockState.locked && lockState.quad`, call native
  `perspectiveCorrectCapture` then feed the corrected URI into the existing normalize
  step. Otherwise current `makeReticleSourceImageCrop` path. Populate
  `normalized_target_metadata.source_branch` as `"rectangle"` vs `"exact_reticle"` per
  the existing contract.

## Phased delivery

### Phase 0 — iOS session-coexistence spike (1–2 days)

Highest-risk item. Confirm we can attach an `AVCaptureVideoDataOutput` to Expo Camera's
existing `AVCaptureSession` without breaking still capture. This requires reaching into
`expo-camera`'s view to grab the session (private API). If blocked: fallback is
`AVCaptureMultiCamSession` (A12+ only — would force a device floor). Run the spike on an
iPhone 12-class device and an iPhone XS to bracket perf.

Exit criterion: demo branch shows ML Kit ObjectDetector bounding boxes overlaid on the
live preview while Expo Camera still successfully takes a still photo without session
interruption.

### Phase 1 — lock-on + tap behind a flag (~1.5–2 weeks)

- Native: add `SpotlightLiveDetectorView` Expo Module view in both `ios/` and `android/`
  of `spotlight-slab-scanner`. Expose `onLiveDetection` event. ML Kit Object Detection
  only; emit quad, confidence, stability.
- JS: new hook `apps/spotlight-rn/src/features/scanner/use-live-detection.ts` subscribing
  to the event and owning `lockState`. New `live-detection-overlay.tsx` rendering
  animated corner guides.
- Wire into `scanner-screen.tsx` via the `children` slot of `RawScannerCaptureSurface`.
  Full-surface tap added.
- **PostHog feature flag `scanner_live_detection_v1`**, default OFF, dogfood internally,
  then ramp.

Acceptance:

- With flag off, zero behavior change. The existing
  `apps/spotlight-rn/__tests__/scanner-screen-test.tsx` regression suite passes
  unchanged.
- With flag on, locked quad triggers tap-anywhere; `handleCapture()` runs the existing
  static-reticle crop path (no perspective correction yet).

### Phase 2 — polish (~3–5 days)

- Corner-guide spring-in animation.
- White flash overlay.
- Double haptic at `runMatchForCapture` resolution.
- Slab-mode awareness for `classHint`.
- Telemetry: `scan_lock_acquired_ms`, `scan_lock_stability_frames`,
  `scan_tap_after_lock_ms`, `scan_unlocked_tap_count`.

### Phase 3 — perspective-corrected crop (~1 week)

- Add `perspectiveCorrectCapture` native function on both platforms.
- `makeLockedQuadSourceImageCrop` becomes the default when locked; falls back to the
  static reticle when unlocked.
- Aligns `source_branch` reporting with the model-rewrite spec.
- **This is the phase that actually feeds better crops into the model** and where the
  projected +1–3 fixture top-1 movement lands.

Total focused effort: **~3–5 weeks**.

## Risks & unknowns

- **iOS `AVCaptureSession` coexistence with Expo Camera.** Single biggest risk —
  de-risk in Phase 0. iOS allows only one `AVCaptureSession` per camera device at a
  time. The native detector view must attach an `AVCaptureVideoDataOutput` to Expo
  Camera's existing session. If blocked, fallback `AVCaptureMultiCamSession` forces a
  device floor.
- **Android CameraX coexistence.** `expo-camera` uses CameraX. Adding a second
  `ImageAnalysis` use case on the same `ProcessCameraProvider` is supported —
  lower risk than iOS.
- **ML Kit Android binary size.** Use the unbundled
  `com.google.android.gms:play-services-mlkit-object-detection` (on-demand from Play
  Services) rather than the bundled variant to avoid ~3–4 MB APK bloat.
- **Older-device perf.** ML Kit object detection on iPhone XS / SE2 sustains ~20 Hz.
  Cap our emit at 10 Hz; suspend the detector while `isCapturing=true` to free camera
  bandwidth for `takePictureAsync`.
- **Coordinate mapping.** Must be native — preview-view points vs `CMSampleBuffer` pixel
  space.

## Critical files

- `apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx` — capture
  orchestration, haptic, match resolution.
- `apps/spotlight-rn/src/features/scanner/raw-scanner-capture-surface.tsx` — camera
  mount, reticle, tap surface, `children` slot.
- `apps/spotlight-rn/modules/spotlight-slab-scanner/ios/SpotlightSlabScannerModule.swift`
  — add live detector view + `perspectiveCorrectCapture`.
- `apps/spotlight-rn/modules/spotlight-slab-scanner/android/src/main/java/expo/modules/spotlightslabscanner/SpotlightSlabScannerModule.kt`
  — Android counterpart.
- `apps/spotlight-rn/src/features/scanner/scanner-normalized-target.ts` — add
  `makeLockedQuadSourceImageCrop`.
- `apps/spotlight-rn/src/features/scanner/screens/scanner-screen-helpers.ts` — extend
  `triggerScannerHaptic` with `'shutter' | 'confirm'`.
- New: `apps/spotlight-rn/src/features/scanner/use-live-detection.ts`,
  `apps/spotlight-rn/src/features/scanner/live-detection-overlay.tsx`.

## Verification (when implemented)

- **Phase 0.** Spike demo: ML Kit ObjectDetector bounding boxes overlaid on live preview
  while Expo Camera takes a still photo without session interruption. Repeat on an
  iPhone 12-class device and an iPhone XS.
- **Phase 1.** Flag-off path identical to current behavior. Regression-test the existing
  `apps/spotlight-rn/__tests__/scanner-screen-test.tsx` suite. With flag on, dogfood
  for a week. Acceptance: lock acquired within 800 ms in good light on ≥80% of attempts;
  tap-after-lock fires capture within 100 ms.
- **Phase 2.** Visual QA via `pnpm mobile:visual:design` for flash + corner animation.
  Telemetry sanity check (events firing, lock-acquired-ms percentile distribution
  sensible).
- **Phase 3.** Re-run held-out fixture suite (`backend/run_all_tests.sh` plus the
  visual-eval harness) comparing `source_branch="rectangle"` vs `"exact_reticle"`
  captures. Look for `pixels_per_card_height` median ≥80% and the projected +1–3 fixture
  top-1 movement. If we don't see it, the win is purely UX — accept and say so.

## Cross-references

- [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md)
  — current product/runtime status.
- [raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md)
  — visual-retrieval-is-the-bottleneck framing.
- [scanner-model-rewrite-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scanner-model-rewrite-spec-2026-04-23.md)
  — Phase 2 temporal-stability and zoom decisions overlap with sections "Detection event
  contract" and "Crop pipeline" above.
- [scan-data-labeling-pipeline-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scan-data-labeling-pipeline-spec-2026-04-23.md)
  — labeling pipeline that consumes the corpus we're growing first.
- [react-native-scanner-normalized-target-mvp-plan-2026-04-28.md](/Users/stephenchan/Code/spotlight/docs/react-native-scanner-normalized-target-mvp-plan-2026-04-28.md)
  — normalized-target plan whose `source_branch` field this design populates.
- [react-native-ml-kit-psa-slab-plan-2026-04-29.md](/Users/stephenchan/Code/spotlight/docs/react-native-ml-kit-psa-slab-plan-2026-04-29.md)
  — RN cross-platform ML Kit slab plan; share ML Kit dependency footprint.
