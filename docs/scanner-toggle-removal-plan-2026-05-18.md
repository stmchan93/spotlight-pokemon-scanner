# Scanner Raw/Slab Toggle Removal Plan

Date: 2026-05-18

## Status

- Implementation plan, not yet started.
- Source of truth for replacing the manual raw/slab scanner toggle with a single mode-less capture flow that auto-detects type post-capture via a native classifier.
- Current phase status:
  - Phase 0 product decision: complete
  - Phase 1 fixture replay validation: not started
  - Phase 2 native classifier (iOS + Android): not started
  - Phase 3 scanner screen rewire + UI cleanup: not started
  - Phase 4 QA + rollout: not started

## Why This Exists

The scanner currently asks the user to choose between "Ungraded" (raw) and "Graded" (slabs) before each scan. Real users repeatedly forget to toggle when switching between raw cards and slabs in the same session, which causes:

- Bad scans (slab captured in raw mode normalizes incorrectly; raw card captured in slab mode runs unnecessary ML Kit analysis and lands in the wrong pipeline).
- User confusion about why a perfectly-framed capture failed to identify.
- Support burden from "scanner is broken" reports that are actually mode-mismatch errors.

The backend already supports auto-detection. See [`backend/catalog_tools.py:5591 resolver_mode_for_payload`](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py:5591) — when no `resolverModeHint` is sent, it routes by slab evidence (cert, grader, grade text in OCR payload) and falls back to raw. The client-side toggle is essentially overriding logic that already exists server-side.

Removing the toggle is a UX win. The remaining engineering question is how to dispatch the right client-side pipeline (raw normalization vs slab analysis) without forcing the user to choose.

## Product Goal

Single shutter. User points at any card. App auto-detects raw vs PSA slab post-capture and dispatches to the right pipeline. The mode toggle UI is removed entirely.

Constraints:

- Per-scan latency MUST NOT regress measurably. Allowed: +5–10ms native classifier overhead. Not allowed: pre-capture preview-frame scanning, periodic `takePictureAsync` polling, or any approach that adds 100ms+ to a scan.
- Recovery affordance for the rare case where auto-detection picks wrong (e.g., CGC slab miscalled as raw, sleeved card with glare miscalled as slab).
- Same behavior on iOS and Android. Same JS bridge. Parallel native implementations with shared fixture tests.

## MVP Product Decisions

### Core decisions

- Replace the `ScannerMode` ("raw"/"slabs") toggle with a single shutter button.
- Add a native fast classifier on the existing `SpotlightSlabScanner` module that takes a captured image URI and returns a slab-likely / not-likely hint.
- Dispatch the rest of the capture pipeline (normalization, slab analysis, match payload) based on the classifier hint.
- Use a single unified camera capture config (resolution + quality) for all captures. Picked empirically via fixture replay.
- Keep the backend resolver routing logic as-is. Drop `resolverModeHint` from the match payload; the backend's slab-evidence fallback handles routing.

### Naming decisions

- Native function: `quickClassifyCapture(imageUri: string)` on `SpotlightSlabScanner`.
- JS-facing type: `SlabHint`.
- Telemetry event: `scan_classifier_decided`.

### What MVP explicitly avoids

- Pre-capture preview-frame analysis (would require react-native-vision-camera migration or hand-rolled native preview-stream plumbing; multi-week scope).
- Periodic background `takePictureAsync` (battery hit, blocks user shutter on iOS).
- A new ML model. The classifier is pure pixel-level heuristics (hue threshold + edge density) — no model file, no inference runtime.
- Backend changes. `resolver_mode_for_payload` already auto-detects from OCR evidence.
- Changing the slab-analysis pipeline (`analyzeSlabCapture` / `scanPSALabel`) itself. We're only changing *whether and when* it runs.

## Current Runtime Reality

### What is already real

- The native module is already cross-platform with parallel Swift + Kotlin implementations:
  - iOS: [`modules/spotlight-slab-scanner/ios/SpotlightSlabScannerModule.swift`](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/modules/spotlight-slab-scanner/ios/SpotlightSlabScannerModule.swift) (240 lines, ML Kit Text + Barcode)
  - Android: [`modules/spotlight-slab-scanner/android/.../SpotlightSlabScannerModule.kt`](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/modules/spotlight-slab-scanner/android/src/main/java/expo/modules/spotlightslabscanner/SpotlightSlabScannerModule.kt) (272 lines, ML Kit Text + Barcode)
  - JS bridge: [`src/features/scanner/slab-scanner-native.ts`](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/scanner/slab-scanner-native.ts) (60 lines, exposes `scanPSALabel`)
- The visual-signal vocabulary already exists in [`psa-slab-parser.ts:9 PSASlabVisualSignals`](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/scanner/psa-slab-parser.ts): `redBandConfidence`, `barcodeRegionConfidence`, `rightColumnConfidence`, `whitePanelConfidence`. These are currently populated downstream from ML Kit output; the classifier will compute them directly from pixels.
- The backend's [`resolver_mode_for_payload`](/Users/stephenchan/Code/spotlight/backend/catalog_tools.py:5591) already routes correctly when `resolverModeHint` is absent.

### What is not good enough yet

- Scanner screen has 48 references to `scannerMode`, branching capture config, capture quality, visual guide overlay, normalization function, slab analysis invocation, and match payload contents on it. See [`scanner-screen.tsx:183, 245, 453, 461, 548, 583, 622, 637, 662, 695, 711, 736, 749, 817, 836, 858, 877, 924, 932, 942, 955, 968, 969, 986, 991, 1079, 1158, 1485, 1519, 1594, 1598, 1652, 1662, 1688, 1693`](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx).
- The api-client maps `mode === 'slabs'` to `resolverModeHint: 'psa_slab'` at [`repository.ts:1196`](/Users/stephenchan/Code/spotlight/packages/api-client/src/spotlight/repository.ts:1196). Drop the hint; backend already handles fallback.
- Raw capture and slab capture today use different `pictureSize` + `quality` settings. There is no validation that one unified config works for both pipelines.
- There is no on-device classifier. ML Kit text recognition + barcode scanning is the current "is this a slab" answer; running it on every scan would add ~300ms tax to raw scans, which violates the latency constraint.

## End-to-End Flow After Removal

```
user opens scanner (no mode toggle)
  → user taps shutter
    → takePictureAsync (unified capture config)
    → native quickClassifyCapture(uri) (~5–10ms)
      ↳ hint.isSlabLikely === true:
          buildSlabScannerTarget → analyzeSlabCapture (existing ~300ms ML Kit path) → match payload includes slabAnalysis
      ↳ hint.isSlabLikely === false:
          buildNormalizedScannerTarget (existing) → match payload omits slabAnalysis
    → POST /api/v1/scan/match (no resolverModeHint)
    → server resolver_mode_for_payload routes from payload evidence
    → result returned, displayed in tray
```

Steady-state cost: **+5–10ms per scan** (native classifier). All other phases unchanged.

## Detailed Implementation

### Phase 1 — Fixture replay (validate unified capture config)

Before writing any code, confirm a single unified camera config works for both pipelines.

Inputs:

- 20–30 slab fixtures (PSA 10, PSA 9, PSA 8, edge cases like off-center labels, slight glare) captured at the current slab settings.
- 20–30 raw fixtures at current raw settings.

Process:

1. Re-capture each slab fixture using the raw config (`pictureSize` = `rawVisualPictureSize`, `quality` = 0.7).
2. Run them through `analyzeSlabCapture` (`scanPSALabel` natively).
3. Confirm cert / grade / grader extraction rate matches or exceeds the current slab config.
4. Re-capture each raw fixture using a config bumped from 0.62 → 0.70 quality.
5. Confirm visual match top-1 accuracy doesn't drop (run them through `/api/v1/scan/visual-match` against the staging index).

Deliverable: Recommendation memo on the unified config. If both pipelines work at `rawVisualPictureSize` + quality 0.70, that's the unified config. If slab OCR regresses, fall back to keeping per-mode capture config dispatched by the classifier output (still mode-less from the user's POV; the classifier just dictates the *next* capture's config).

Estimated effort: **1 day.**

### Phase 2 — Native classifier

#### 2a. iOS implementation

File: [`apps/spotlight-rn/modules/spotlight-slab-scanner/ios/SpotlightSlabScannerModule.swift`](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/modules/spotlight-slab-scanner/ios/SpotlightSlabScannerModule.swift).

Add an `AsyncFunction("quickClassifyCapture")` that:

1. Loads the image from the URI as `UIImage` (existing pattern; reuse the helper that `scanPSALabel` uses).
2. Downsamples to ~400px long-side for sampling (Core Graphics, no need for full res).
3. Samples the top ~18% horizontal strip:
   - Convert each sampled pixel to HSV.
   - Count pixels with hue in PSA red range (approx hue 350–360° OR 0–10°, saturation > 0.6, value > 0.4).
   - Coverage ratio → `redBandScore`.
4. Samples the bottom ~12% horizontal strip:
   - Compute Sobel-equivalent edge magnitude on a downscaled grayscale copy.
   - Edge density → `barcodeRegionScore`.
5. Returns `{ isSlabLikely: redBandScore > 0.45 && barcodeRegionScore > 0.40, confidence: weighted_combination, redBandScore, barcodeRegionScore, decodeMs, classifyMs }`.

Thresholds (`0.45`, `0.40`) are starting guesses; tune them empirically in Phase 4 using the fixture suite.

Expected runtime: 5–10ms on iPhone 12+, up to 15ms on older devices.

#### 2b. Android implementation

File: [`apps/spotlight-rn/modules/spotlight-slab-scanner/android/src/main/java/expo/modules/spotlightslabscanner/SpotlightSlabScannerModule.kt`](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/modules/spotlight-slab-scanner/android/src/main/java/expo/modules/spotlightslabscanner/SpotlightSlabScannerModule.kt).

Mirror the Swift logic in Kotlin:

1. `BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = 4 })` for the downsampled decode. The `inSampleSize` is important on Android — `BitmapFactory` is meaningfully slower than `UIImage` on full-resolution JPEGs.
2. `android.graphics.Color.colorToHSV(pixel, hsv)` for HSV conversion.
3. Sobel implemented directly in Kotlin (or via RenderScript if it ends up too slow).
4. Same threshold + return shape as iOS.

#### 2c. JS bridge

File: [`apps/spotlight-rn/src/features/scanner/slab-scanner-native.ts`](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/scanner/slab-scanner-native.ts).

Add:

```ts
export type SlabHint = {
  isSlabLikely: boolean;
  confidence: number;          // 0..1, combined score
  redBandScore: number;        // 0..1, raw signal
  barcodeRegionScore: number;  // 0..1, raw signal
  decodeMs: number;            // native decode time
  classifyMs: number;          // native classify time (excludes decode)
};

export async function quickClassifyCapture(imageUri: string): Promise<SlabHint> {
  if (!nativeModule) {
    throw new Error(
      `Native module ${SLAB_SCANNER_NATIVE_MODULE_NAME} is not registered in this build. `
        + 'Build a custom dev client (Expo Go is not supported).',
    );
  }
  // ...input validation matching scanPSALabel...
  return await nativeModule.quickClassifyCapture(trimmed);
}
```

Extend the `NativeBindings` type to include the new function.

#### 2d. Cross-platform parity tests

New file: `apps/spotlight-rn/__tests__/slab-native-classifier-test.ts`.

Use the existing `slab-native-analysis-test.ts` as the template. The classifier test should:

- Mock the native module the same way (`expo-modules-core` `requireOptionalNativeModule`).
- Verify the JS-facing shape and error paths.

Separately, add a fixture-based integration test that runs on both platforms in CI:

- Load each fixture image (20–30 raws, 20–30 slabs, 5–10 edge cases).
- Call `quickClassifyCapture`.
- Assert classification matches the expected label.
- Assert iOS and Android produce the same classification for each fixture (parity check).

Estimated effort: **3 days total** (1 day iOS, 1 day Android, 1 day tests + parity harness).

### Phase 3 — Scanner screen rewire

File: [`apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx`](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx).

#### 3a. Remove

- `scannerMode` / `setScannerMode` state (line 183) and all reads.
- `scannerModes` constant (lines 110–111).
- Segmented control UI block (lines 1688–1693).
- `showSlabGuide={scannerMode === 'slabs'}` and the slab guide overlay rendering path (line 1598).
- All `scannerMode === 'raw'` / `=== 'slabs'` ternaries (~48 sites). Each one collapses to either always-run-the-raw-thing, always-run-the-slab-thing, or use-the-classifier-result.
- `scannerPreparationReviewReason(scannerMode, ...)` second arg (line 969).
- `mode` field from `ScannerCapturePayload` construction site (lines 695, 711, 858, etc.).
- `resolverModeHint` derivation in [`repository.ts:1196`](/Users/stephenchan/Code/spotlight/packages/api-client/src/spotlight/repository.ts:1196). The field stays in the API contract for one release cycle to support old clients, then can be removed.

#### 3b. Add

After `takePictureAsync` completes and we have `photo.uri`, before normalization:

```ts
const classifierStartedAt = Date.now();
const hint = await quickClassifyCapture(photo.uri);
const classifierMs = Date.now() - classifierStartedAt;
capturePostHogEvent('scan_classifier_decided', {
  is_slab_likely: hint.isSlabLikely,
  confidence: hint.confidence,
  red_band_score: hint.redBandScore,
  barcode_region_score: hint.barcodeRegionScore,
  decode_ms: hint.decodeMs,
  classify_ms: hint.classifyMs,
  total_ms: classifierMs,
});
const isSlab = hint.isSlabLikely;
```

Use `isSlab` to dispatch:

- `isSlab ? buildSlabScannerTarget(...) : buildNormalizedScannerTarget(...)` (replaces line 836).
- `if (isSlab) { /* analyzeSlabCapture + slabAnalysis in payload */ }` (replaces the block at lines 877–898).

`ScannerCapturePayload['mode']` field becomes derived rather than user-chosen. Keep the field in the type — it's still useful for the tray UI and downstream telemetry — but it's now computed: `mode: isSlab ? 'slabs' : 'raw'`.

Estimated effort: **1 day.**

### Phase 4 — UI cleanup and recovery affordance

#### 4a. Drop mode-toggle UI

- Remove the segmented control at the bottom of the scanner screen.
- Remove the "Open as raw / Open as slab" tray label variants (lines 1485, 1519). Replace with the actual detected type from the classifier output (`capture.mode === 'slabs' ? 'PSA Slab' : 'Raw card'`).
- Adjust layout constants in [`raw-scanner-capture-surface.tsx:23–27`](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/scanner/raw-scanner-capture-surface.tsx): `rawScannerModeToggleGap`, `rawScannerModeToggleReservedHeight` become 0 or get deleted; tray geometry recalculates.

#### 4b. Add "Scanned wrong type?" recovery

On each capture result card (the tray rows in the scanner screen and the candidate review screen), add a small inline affordance: "Not a slab?" or "Actually a slab?" depending on the classifier's call. Tapping it forces re-dispatch with the opposite assumption:

- Re-run normalization with the other geometry.
- For raw-misclassified-as-slab: re-submit match with no `slabAnalysis`.
- For slab-misclassified-as-raw: run `analyzeSlabCapture` retroactively and re-submit.

Telemetry: `scan_classifier_corrected` event with the original hint + the user's correction. This is the gold-standard signal for tuning classifier thresholds over time.

Estimated effort: **1 day.**

### Phase 5 — Tests and rollout

#### 5a. Test updates

- `apps/spotlight-rn/__tests__/scanner-screen-test.tsx`: strip mode-toggle assertions, replace with mocked classifier output.
- `apps/spotlight-rn/__tests__/slab-native-classifier-test.ts`: new (see Phase 2d).
- `apps/spotlight-rn/__tests__/components/scan-candidate-review-screen-test.tsx`: update any references to `mode` being a user choice.
- Backend has no required changes. No backend test updates.

#### 5b. Rollout

1. Land native module changes in a custom dev client first (EAS rebuild required; this is not OTA-shippable).
2. Optional: feature-flag the new flow with a remote-config or build constant for one release so it can A/B against the toggle build. Strongly recommend doing this because the dataset of classifier accuracy in the wild is the deciding signal.
3. Once classifier accuracy and recovery-rate telemetry look good (target: <2% `scan_classifier_corrected` events; >98% correct classifications), remove the legacy mode-toggle code paths and the flag.
4. Bump `resolverModeHint` deprecation: send `undefined` from new clients, leave the backend handler in place for one release cycle to support old clients still rolling out.

Estimated effort: **1 day for test updates; 2–3 days elapsed for QA sweep.**

## Risks and Mitigations

1. **Unified capture config regresses one side.** Risk that raw quality 0.7 hurts visual matcher, or that raw `pictureSize` makes slab OCR worse.
   - *Mitigation:* Phase 1 fixture replay before any code changes. If results regress, switch to "classifier dispatches per-mode capture config" — same removal of the user-facing toggle, just keeps two capture configs internally.

2. **Classifier mis-fires on ambiguous captures** (CGC/BGS slabs, sleeved cards with glare, badly framed slabs).
   - *Mitigation:* "Scanned wrong type?" recovery affordance (Phase 4b). Backend's existing `needs_review` disposition still serves as the safety net for cases where neither pipeline produces a confident match.

3. **Native code parity drift between iOS and Android.** Same JPEG, different classifications.
   - *Mitigation:* Cross-platform fixture parity test in CI (Phase 2d). Tune in HSV/Lab color space rather than raw RGB to minimize platform color-decode differences.

4. **Android JPEG decode latency on older devices.** `BitmapFactory.decodeFile` at full res can take 50–100ms on Android 8 / mid-tier devices.
   - *Mitigation:* `BitmapFactory.Options().inSampleSize = 4` during classify. Decode-at-quarter-res is plenty for hue and edge sampling; full-resolution decode still happens later for the actual match pipeline.

5. **Threshold drift over time.** PSA's label design could change subtly across slab generations (already has historically — older slabs have different label proportions).
   - *Mitigation:* `scan_classifier_corrected` telemetry feeds a threshold-tuning loop. Thresholds are constants in the native code, easy to bump in subsequent releases.

## Effort Estimate Summary

| Phase | Effort |
|---|---|
| Phase 1: Fixture replay validation | 1 day |
| Phase 2: Native classifier (iOS + Android + JS bridge + tests) | 3 days |
| Phase 3: Scanner screen rewire | 1 day |
| Phase 4: UI cleanup + recovery affordance | 1 day |
| Phase 5: Test updates + QA | 1 day active, 2–3 days elapsed |

**Total: ~7 dev days active work. ~10 days elapsed including QA.** Native work is the long pole; rest can run in parallel.

## Success Criteria

The toggle removal is successful if:

- The mode toggle UI is gone from the scanner screen.
- Median end-to-end scan latency (`scan_match_succeeded` event, `endToEndMs`) stays within +15ms of the pre-change baseline for raw scans. p90 stays within +20ms.
- Classifier accuracy in production telemetry is >98% (`scan_classifier_corrected` events <2% of scans).
- No measurable regression in slab cert/grade extraction rate (compared to fixture baseline).
- iOS and Android produce identical classifications on the parity fixture suite.

## Out Of Scope For This Plan

- Replacing the slab analysis pipeline itself. Still uses `scanPSALabel` and ML Kit. Only the *trigger* changes.
- Pre-capture preview-frame classification. Requires a different camera library or hand-rolled native preview-stream plumbing. Could be a future optimization once `react-native-vision-camera` becomes attractive for other reasons.
- Backend resolver changes. The auto-detection logic is already there and working.
- Non-PSA slab support (CGC, BGS, etc.). Out of scope for the classifier — those scans route to the raw pipeline today and will continue to do so. A future expansion could add other-grader classifier paths.
- Removing the `mode` field from `ScannerCapturePayload`. The field stays as a derived value for tray UI and telemetry. Only its *source* changes (user → classifier).

## Follow-Up After This Lands

Only after the classifier ships and produces a few weeks of real-world data:

- Tune `redBandScore` and `barcodeRegionScore` thresholds using `scan_classifier_corrected` telemetry.
- Consider expanding the classifier to other-grader slab signals (CGC blue band, BGS gold).
- Consider Option C-true: pre-capture preview-frame classification, once `react-native-vision-camera` migration is independently justified.
