# React Native Scanner Normalized-Target MVP Plan

Date: 2026-04-28

## Status

- This is an interim execution plan for the React Native scanner.
- It is intentionally narrower than the full [scanner-model-rewrite-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scanner-model-rewrite-spec-2026-04-23.md).
- The goal is to test the **current live visual model** with the **right scan input contract** without paying for the full RN native scanner rewrite yet.

## Goal

Make the React Native scanner send the same class of image the visual model is supposed to evaluate:

- no camera zoom for the first pass
- crop to the visible reticle only
- normalize that crop into the canonical raw-card target
- send that normalized target to `/api/v1/scan/visual-match`
- show that exact same normalized target in the scan review UI

This is the smallest useful scanner MVP for evaluating the current visual model honestly on React Native.

## Non-Goals

This plan does **not** include:

- the full 4/23 native scanner bridge
- `react-native-vision-camera`
- frame processors
- rectangle-detection parity with iOS
- Swift normalization bridging
- OCR/rerank redesign
- Android scanner-native parity work
- scan artifact / GCS / labeling pipeline expansion

## Why This Exists

Current RN scanner behavior is not testing the model fairly.

Today:

- RN captures a full camera photo through `expo-camera`
- RN computes reticle crop metadata afterward
- RN still uploads the full JPEG to `/api/v1/scan/visual-match`
- the review UI later tries to reconstruct the crop visually from metadata

That creates two problems:

1. The model is seeing a full-frame camera shot instead of the intended card target.
2. The review image can look rotated, shifted, or otherwise wrong, because it is a reconstructed display crop rather than the actual matcher input.

## Current Source Of Truth

The 4/23 scanner spec says the scanner contract should center on a `normalized_target`:

- If rectangle selection is strong: perspective-correct + canonicalize to `630x880`
- Else: exact reticle crop + canonicalize to `630x880`

For this MVP, use only the valid fallback branch:

- exact reticle crop
- canonicalize to `630x880`

Reference:

- [scanner-model-rewrite-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scanner-model-rewrite-spec-2026-04-23.md)

## Important Clarification

`630x880` is **not** the zoom.

It is only the canonical normalized output canvas.

Two separate concepts:

- zoom = how large the card is in the original source capture
- canonical target = the final standardized card image shape the model sees

So the first MVP experiment is:

- no zoom
- but still crop to the reticle
- then normalize to the canonical target

This isolates the biggest current problem first: wrong image contract.

## Reticle / Aspect Rule

The intended raw-card reticle shape and the canonical target shape match:

- iOS/spec reticle aspect = `88:63` height/width
- canonical target aspect = `880:630` height/width

The current RN reticle is slightly off from that.

Before evaluating the visual model, RN should align its reticle aspect to the same canonical raw-card frame shape so:

- what the user sees
- what is cropped
- what is normalized

all represent the same intended target.

## MVP Decision

Implement the following path in RN:

1. User taps scan.
2. RN captures a normal camera image with the current camera library.
3. RN immediately crops the source image to the current reticle bounds.
4. RN rotates/orients that crop into a stable portrait card target when needed.
5. RN fits that crop into a `630x880` canvas without stretching.
6. RN uploads the normalized target bytes to `/api/v1/scan/visual-match`.
7. RN stores and shows that same normalized image in scan review.

Do **not** upload the full-frame source photo to the matcher in this MVP.

## Implementation Scope

### Step 1: Align RN reticle aspect

Update the RN reticle layout math so it matches the raw-card canonical frame shape used by iOS/spec.

Primary file:

- [apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx)

Expected outcome:

- the visible RN reticle is the same target shape the canonical `630x880` image expects

### Step 2: Crop the captured image to the reticle

Keep the current capture call, but after capture:

- use the reticle bounds
- map them into source-image pixel coordinates
- crop the photo bytes to that region

Do not stop at storing `sourceImageCrop` metadata only.

Expected outcome:

- there is now a real reticle-cropped image, not just crop coordinates

### Step 3: Normalize to `630x880`

Take the reticle crop and:

- orient it upright
- fit it into a `630x880` portrait canvas
- avoid stretching
- pad if needed rather than distort the crop

Expected outcome:

- every raw scan sent to the matcher has one stable output size and framing contract

### Step 4: Send normalized target to visual match

Change the RN scan request so `/api/v1/scan/visual-match` receives:

- normalized target JPEG base64
- normalized target width/height

instead of the full-frame captured image.

Primary files:

- [apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx)
- [packages/api-client/src/spotlight/repository.ts](/Users/stephenchan/Code/spotlight/packages/api-client/src/spotlight/repository.ts)

Expected outcome:

- the existing visual model is evaluated on the intended image contract

### Step 5: Show the same normalized target in review

The scan review screen should stop reconstructing a crop from the full source photo for this MVP.

Instead:

- store the actual normalized target image URI or bytes for the session
- render that exact image in the “cards found / similar cards” review screen

Primary files:

- [apps/spotlight-rn/src/features/scanner/scan-candidate-review-session.ts](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/scanner/scan-candidate-review-session.ts)
- [apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx)
- [apps/spotlight-rn/src/features/cards/screens/scan-candidate-review-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/cards/screens/scan-candidate-review-screen.tsx)

Expected outcome:

- the image shown to the user matches the image the matcher actually evaluated

## Logging / Instrumentation

For this MVP, add explicit debug logging for:

- source capture width/height
- reticle crop width/height
- normalized target width/height
- encoded payload size
- upload/request time
- backend round-trip time
- backend `serverProcessingMs`

This does not need a full observability refactor. It just needs enough signal to verify:

- the crop math is correct
- the matcher is receiving the smaller normalized target
- latency improved or at least stayed understandable

## Acceptance Criteria

This MVP is successful if all of the following are true:

1. RN visual-match requests are no longer sending the full-frame camera JPEG.
2. The request image corresponds to the visible reticle only.
3. The request image is normalized to `630x880`.
4. The review image matches the exact normalized matcher input.
5. The review image no longer shows the weird horizontal/shifted reconstruction artifact.
6. Scanner candidate quality can now be judged as model quality rather than capture-contract noise.

## Validation Plan

Run a small live manual test set:

1. Scan the same physical raw card 3 times.
2. Confirm the review image looks like the intended reticle crop each time.
3. Compare top-1 consistency before vs after.
4. Compare round-trip latency before vs after.
5. Compare “background-heavy false match” behavior before vs after.

Use at least:

- one easy modern card
- one low-value modern card
- one older card with weaker visual signal
- one scan with slightly imperfect centering

## What This MVP Will Tell Us

After this lands, we should be able to answer:

- Is the current visual model materially better when fed the correct normalized target?
- Is “no zoom but correct crop/normalize” already good enough for an interim RN scanner?
- Is zoom still needed after the image contract is corrected?

## What Comes Next If Results Are Still Weak

If the model still performs poorly after this MVP, the next experiment should be:

- keep reticle crop + `630x880` normalization
- add iOS-like camera zoom
- re-measure top-1 consistency

Only after that should we seriously consider the larger RN scanner-native rewrite path.

## Explicit Decision

Do this first:

- no zoom
- correct reticle crop
- canonical `630x880`
- exact same normalized image sent to matcher and shown in review

Do **not** do the large scanner refactor first.
