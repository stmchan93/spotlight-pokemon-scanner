# React Native ML Kit PSA Slab Plan

Date: 2026-04-29

Status: Planning only. Do not treat this as implemented.

## Goal

Support scanner behavior in the React Native app across iOS and Android with:

- raw card scans using visual matching first, with no raw OCR dependency for the first cross-platform release
- PSA slab scans using ML Kit OCR and barcode scanning on both iOS and Android
- one React Native-facing scanner contract so platform-specific native code returns the same payload shape

## Product Decision

Raw cards should prioritize visual matching. Current evidence suggests visual matching is stronger than OCR as the primary raw identifier, so the React Native raw path should focus on producing a good normalized image and sending it to the backend visual matcher.

PSA slabs still need OCR/barcode evidence because the backend needs structured slab fields such as grader, grade, cert number, barcode payloads, and parsed label text. For cross-platform parity, use ML Kit on both iOS and Android instead of Apple Vision on iOS plus ML Kit on Android.

## Current Repo State

The React Native raw path already has most of the visual-match plumbing:

- `apps/spotlight-rn/src/features/scanner/scanner-normalized-target.ts`
  - crops the camera image to the reticle
  - fixes the common portrait rotation case
  - resizes to `630x880`
  - returns a JPEG base64 normalized target
- `packages/api-client/src/spotlight/repository.ts`
  - sends raw scans to `/api/v1/scan/visual-match`

The React Native slab path is currently only a shell:

- UI has a `SLABS` mode
- request sets `resolverModeHint: "psa_slab"`
- slab evidence fields are currently null or empty:
  - `slabGrader`
  - `slabGrade`
  - `slabCertNumber`
  - `slabBarcodePayloads`
  - `slabParsedLabelText`
  - `ocrAnalysis`

Because of that, React Native slab scans should not be considered functional yet.

## Target Architecture

Use one React Native scanner flow with platform-specific native analysis behind a shared interface.

```text
React Native camera UI
  -> capture photo
  -> raw mode:
       crop/resize normalized target
       send image to /api/v1/scan/visual-match
  -> slab mode:
       crop PSA label or slab target
       run native ML Kit OCR/barcode
       parse PSA slab evidence
       send populated payload to /api/v1/scan/match
```

Recommended module shape:

```text
apps/spotlight-rn/modules/spotlight-scanner
  ios/
    Swift ML Kit text recognition and barcode scanning
  android/
    Kotlin ML Kit text recognition and barcode scanning
  src/
    TypeScript wrapper and shared result types
```

## Raw Card Plan

For the first cross-platform raw release, keep OCR out of the raw runtime path.

Flow:

```text
Expo Camera capture
reticle crop
resize to 630x880
send JPEG base64 to /api/v1/scan/visual-match
backend visual matcher resolves card
```

Work needed:

1. Prove the existing RN raw visual path on Android hardware.
2. Confirm camera permissions and capture behavior.
3. Confirm Android source image dimensions and EXIF/orientation handling.
4. Confirm reticle-to-source crop math is correct.
5. Confirm normalized image is not sideways, stretched, blank, or over-compressed.
6. Compare backend match quality from Android captures against known labels.
7. Only move raw crop/rotate/resize into native code if real Android captures show the JS/Expo image path is unreliable.

Acceptance:

- Android raw capture produces valid `630x880` normalized targets.
- Backend `/api/v1/scan/visual-match` receives valid images.
- Known-card Android fixture scans return acceptable top-1/top-5 candidates.
- iOS raw behavior does not regress.

## PSA Slab Plan

Use ML Kit text recognition and barcode scanning on both iOS and Android.

Native module should expose a low-level method that returns OCR and barcode observations:

```ts
scanPSALabel(imageUri: string): Promise<{
  width: number;
  height: number;
  textBlocks: Array<{
    text: string;
    boundingBox?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  barcodes: Array<{
    rawValue: string;
    format?: string;
    boundingBox?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
}>;
```

Keep product parsing shared above the native layer where possible:

```text
ML Kit native layer:
  image input
  text recognition
  barcode scanning
  raw observations

Shared TypeScript layer:
  PSA grader detection
  non-PSA detection
  grade parsing
  cert extraction
  barcode-first cert preference
  confidence/reason model
  backend payload construction
```

The parsed slab result should populate the existing backend fields:

```ts
{
  slabGrader: "PSA" | null;
  slabGrade: string | null;
  slabCertNumber: string | null;
  slabBarcodePayloads: string[];
  slabParsedLabelText: string[];
  slabCardNumberRaw: string | null;
  slabGraderConfidence: number | null;
  slabGradeConfidence: number | null;
  slabCertConfidence: number | null;
  slabClassifierReasons: string[];
  slabRecommendedLookupPath: "psa_cert" | "label_text_search" | "needs_review" | null;
  ocrAnalysis: Record<string, unknown>;
}
```

Parsing priority:

1. Prefer cert numbers found in barcode payloads.
2. Then prefer cert numbers near explicit `CERT`, `CERTIFICATE`, `VERIFY`, or `PSA` label text.
3. Then allow standalone 7-10 digit cert-like numbers with lower confidence.
4. Detect explicit non-PSA graders and return an unsupported/non-PSA reason instead of forcing PSA.

## Slab Capture UX

Start with a label-first slab capture experience.

First version:

- user selects `SLABS`
- UI shows a clear PSA label reticle
- user aligns the top PSA label area, including barcode/cert region
- app captures and crops that label region
- ML Kit reads OCR and barcode from that crop

This is simpler and more cross-platform than immediately reproducing the full Swift slab rectangle detection pipeline.

Later enhancements:

- full-slab reticle
- automatic red PSA label-band detection
- full-slab rectangle detection
- perspective correction
- label-only fallback if full slab detection is weak

## Implementation Phases

### Phase 1: Raw Android Visual Proof

- run RN raw scanner on Android hardware
- collect normalized target outputs
- send to `/api/v1/scan/visual-match`
- compare results against known labels
- fix orientation/crop only if evidence shows a problem

### Phase 2: Native Module Shell

- add local Expo native module
- add iOS Swift module shell
- add Android Kotlin module shell
- expose TypeScript wrapper
- add an Android/iOS stub returning structured errors until ML Kit is wired

### Phase 3: ML Kit OCR/Barcode

- add ML Kit text recognition dependency for iOS
- add ML Kit barcode scanning dependency for iOS
- add ML Kit text recognition dependency for Android
- add ML Kit barcode scanning dependency for Android
- return raw text blocks and barcode payloads through the shared TypeScript wrapper

### Phase 4: Shared PSA Parser

- port useful logic from `Spotlight/Services/SlabLabelParsing.swift` into TypeScript
- keep behavior deterministic and fixture-testable
- build parser tests for:
  - barcode cert
  - OCR cert
  - grade adjective parsing
  - explicit PSA detection
  - noisy PSA tokens
  - non-PSA slab rejection

### Phase 5: RN Slab Wiring

- update slab capture flow to call the native ML Kit module
- build populated `/api/v1/scan/match` payloads
- remove null-only slab request behavior from real runtime
- show review/unsupported states based on backend response

### Phase 6: QA And Fixtures

- create a small PSA slab fixture set
- include iOS and Android captures
- include mixed grades, glare, angles, and barcode quality
- validate:
  - grader parsed
  - grade parsed
  - cert parsed
  - barcode payload captured when visible
  - backend returns candidates instead of unsupported for valid PSA slabs
  - iOS and Android produce comparable parsed fields

## Backend Expectations

Backend slab resolver should mostly stay unchanged because it already accepts the required fields. Expected request path remains:

```text
/api/v1/scan/match
```

Backend tests should be added or updated for React Native slab payloads once the client sends real slab evidence.

## Risks

- Android camera orientation may differ from iOS and break normalized raw crops.
- ML Kit OCR output may differ enough from Apple Vision that slab parsing needs fresh tuning.
- PSA label glare and small cert text may require stricter capture guidance.
- Full automatic slab detection is likely more expensive than label-first capture and should not block the first version.
- Native module work means Expo Go is not sufficient; development and QA need dev-client/EAS/native builds.

## Recommended Execution Order

1. Prove Android raw visual match with real device captures.
2. Add the local Expo native scanner module shell.
3. Implement ML Kit OCR/barcode outputs on iOS and Android.
4. Port PSA parsing to shared TypeScript.
5. Wire RN slab mode end to end.
6. Build PSA slab fixture QA and compare iOS vs Android behavior.
