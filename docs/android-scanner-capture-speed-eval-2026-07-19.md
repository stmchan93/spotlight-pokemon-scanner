# Android Scanner Capture Speed — Levers to Try + Eval Plan

**Status:** Active (Android launch prep). Date: 2026-07-19.
**Problem:** On Android, burst scanning produces motion-blurred captures. The full
photo pipeline is slow, so the phone has moved to the next card before the shutter
resolves. On iOS the shutter is fast enough (~0.2s) that burst scanning is smooth.

## Hard constraint (the ZSL lesson — don't relearn it)
**Match accuracy outranks shutter latency.** Android briefly used
`qualityPrioritization: 'speed'` (zero-shutter-lag). ZSL serves a ring-buffer frame
that can **predate the tap**, so in burst scanning it produced stale/blurred frames
and **WRONG MATCHES**. That's why capture is `'balanced'` on both platforms. Any
speed lever must not reintroduce stale/pre-tap frames, and must be validated against
match accuracy, not just felt latency.

## Lever 1 (takeSnapshot) — TRIED, REVERTED (2026-07-19)
On-device burst test failed hard: three rapid taps at three DIFFERENT cards
(chikorita → basic energy → boss's orders) **all resolved to boss's orders** (the
LAST card), plus general blur/lag. Root cause: `takeSnapshot()` screenshots the
**preview surface** whenever its async chain resolves — it is NOT timed to the tap.
Under burst load the CameraX preview lags, so every snapshot resolved *after* the
phone had already settled on the final card. This is a *different* staleness than
ZSL (reads too LATE, not pre-tap) but the same net failure: wrong card. Reverted.
Lesson: `capturePhoto()` latches the sensor **at the tap** and is the only
correctly-timed source on Android — the fix must make *it* faster, not replace it.

## Current state (in test) — Lever 4b: disable virtual-device image fusion
- On **Android only**, `capturePhoto()` now passes `enableVirtualDeviceFusion:
  false` (`raw-scanner-capture-surface.tsx`). The back device bundles ultra-wide +
  wide + telephoto (for iOS Auto-Macro), so CameraX defaults to blending several
  frames from multiple sensors per shot — slow, and during burst hand-motion the
  frames don't align → motion-blur/ghosting + shutter lag behind the tap. Disabling
  fusion latches ONE frame immediately, correctly timed to the tap. Still
  `'balanced'` (NOT the reverted ZSL `'speed'`). Multi-lens device kept, so
  close-focus/macro is unchanged. iOS byte-for-byte unchanged.
  **Open question:** is fusion the whole slowdown, or is lens-switching also a
  factor? If still laggy, next lever = single `wide-angle` device on Android
  (eliminates fusion AND lens hunting; risk = close-focus regression, must validate).

## Levers to try (ranked)

| # | Lever | Expected effect | Tradeoff / risk | Test |
|---|---|---|---|---|
| 1 | **takeSnapshot preview frame** (Android) — *shipped* | Near-instant, current frame | Lower res → possible accuracy drop | accuracy vs full capture (below) |
| 2 | **Snapshot JPEG quality** (currently `rawVisualCaptureQuality`≈62) | Higher q = sharper crop, bigger file | Latency/upload size | sweep q ∈ {50,62,80}; accuracy + size |
| 3 | **Lower `targetResolution` for capturePhoto** (Android, keep full-capture path) | Smaller = faster encode | Less detail | latency + accuracy vs HD |
| 4 | **Disable HDR / multi-frame** (`photoHdr:false`, stabilization off) if on | Fewer frames = faster shutter | Slightly noisier | latency delta; accuracy |
| 5 | **Capture-confirm UX** — crisp flash/haptic the instant the shutter *actually* fires | Kills "moved too early" blur without changing capture | None (pure UX) | on-device feel; blur rate |
| 6 | **"Capture when steady" gate** — fire only on a stable frame | Sharper stills | ADDS latency (opposite of goal) | blur rate vs latency |
| 7 | **Device/format pick** — choose the fastest-capturing lens/format on Android | Faster pipeline | Device-specific | per-device latency |
| 8 | **Frame-processor continuous capture** — stream frames, auto-pick the sharpest near the tap | Best sharpness, no shutter wait | Bigger change; CPU | prototype + accuracy |

## Evaluation methodology (the part that actually decides it)
The only metric that matters is **match accuracy**, measured honestly on held-out
real scans — not felt speed.

1. **Capture a paired batch on the same Android device:** ~50–100 real cards, each
   captured BOTH ways (takeSnapshot vs full capturePhoto) under normal burst motion.
2. **Run both through the matcher** and compare **top-1 / top-10** against the known
   labels. Reuse the existing accuracy harness / show-holdout benchmark and the
   matcher-replay recipe (see `visual-retrain-runbook` / `candidate-depth-experiment`
   harness) rather than eyeballing.
3. **Also record:** capture latency (tap → file ready), file size, and a subjective
   blur/miss rate during fast bursts.
4. **Decision rule:** ship `takeSnapshot` on Android if top-1 holds within a small
   margin (e.g. ≤2–3 pp) of full capture. If it drops more, keep full capture and
   pursue levers 5 (confirm UX) + 3/4 (faster full capture) instead.

## Notes
- iOS is the shipping platform and is smooth — none of this touches the iOS path.
- Keep every lever **Android-gated** (`Platform.OS === 'android'`) so iOS stays
  byte-for-byte unchanged (same discipline as the zoom-guard + snapshot changes).
- Don't re-open ZSL/`'speed'` — it's the known wrong-match trap.
