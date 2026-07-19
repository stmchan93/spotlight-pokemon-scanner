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

## Lever 4b (disable fusion) — WORKS for correctness (2026-07-19)
On-device: photos look much better and each row resolved to the RIGHT card (the
takeSnapshot wrong-card failure is gone). BUT re-tap latency still ~2-3s. Measured
`captureMs` across a burst: `1548, 3393, 3310, 3346, 3407, 2356, 1084, 3368, 2374,
1127, 1158 ms`. The **variance** (1.1s→3.4s) rules out encode (which would be
constant) and points to **3A (auto-focus/exposure) re-converging per shot**. Same
log: we capture 1080×2340 (2.5MP) but only use a 630×880 crop (4.6× waste, but not
the bottleneck), and `roundTripMs` climbed 2s→16s across the burst (2-vCPU staging
box saturating — separate capacity issue). Fusion-off is KEPT (it fixed
correctness); it just doesn't touch the focus-convergence wait.

## Lever `qualityPrioritization: 'speed'` on Android — TRIED, REVERTED (2026-07-19)
A/B'd on-device. **Speed: clear win** — captureMs dropped from ~3.3s median to
~1.3s (measured burst: 680–1417ms). **Correctness: FAIL** — burst captures got
corrupted: an earlier tray row's image was overwritten by a LATER capture's frame
(~every other shot). Thumbnail was correct at capture, then replaced. Cause:
minimize-latency uses a recycled buffer pool; a later capture recycles the frame
an earlier not-yet-saved `Photo` still references → the earlier row's saved file
ends up with the newer pixels. This is the ZSL-family trap again (surfaced as
image-content overwrite, not a stale preview). Per the decision rule (any wrong
row → revert), reverted to fusion-off `'balanced'` (the known-good baseline).

**Ceiling reached for config-level levers.** Remaining Android capture latency
(~2-3s, 3A convergence on the budget ISP) can't be cut safely by a photo-output
toggle. Real further speedup needs a **native frame-processor capture pipeline**
that deep-copies each frame the instant it arrives (before the pool recycles),
decoupling capture from 3A wait without the buffer-aliasing corruption. That's a
project (lever 8), not a toggle. Alternatively accept the A17's ~3s as budget-
device reality (iPhone's ISP is genuinely much faster) and prioritize the server
round-trip (2s→16s under burst on the 2-vCPU box) for total scan-to-result time.

## (superseded) Lever 4b: disable virtual-device image fusion
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
