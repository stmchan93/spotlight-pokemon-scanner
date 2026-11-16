import { colors } from '@spotlight/design-system';

import {
  getRawScannerCollapsedTrayReservedHeight,
  getRawScannerEmptyTrayVisualHeight,
  isBenignCameraCancellation,
  makeRawScannerCaptureLayout,
  rawScannerModeToggleGap,
  reticleLockedOutlineColor,
  reticleRestingOutlineColor,
} from '@/features/scanner/raw-scanner-capture-surface';

/*
  The reticle frame has been purple, then white, then purple again. Nothing
  guarded it, so each flip was invisible until someone looked at a phone. These
  are literals on purpose — asserting `toBe(colors.purple200)` would pass if the
  token itself were repointed, which is exactly the drift worth catching.
*/
describe('reticle outline colours', () => {
  it('rests on the purple 500 stroke, per Figma 5559:7112', () => {
    expect(reticleRestingOutlineColor).toBe('#A54BFA');
    expect(reticleRestingOutlineColor).not.toBe(colors.scannerTextPrimary);
  });

  it('pulses white on capture, against the purple 500 frame', () => {
    expect(reticleLockedOutlineColor).toBe('#FFFFFF');
  });

  it('keeps the two states distinguishable, or the capture pulse says nothing', () => {
    expect(reticleLockedOutlineColor).not.toBe(reticleRestingOutlineColor);
  });
});

describe('raw scanner capture layout', () => {
  it('reserves one-row tray space from the first render', () => {
    expect(getRawScannerCollapsedTrayReservedHeight({
      bottomInset: 48,
    })).toBe(211);
  });

  it('keeps the empty tray visual shell compact before any scans exist', () => {
    expect(getRawScannerEmptyTrayVisualHeight({
      bottomInset: 48,
    })).toBe(121);
  });

  it('uses the Figma 6322:9081 frame when the controls sit inside it', () => {
    // iPhone 16 Pro: 852pt window, 59pt safe area, 87pt scanner tab bar, 24pt tray bottom inset.
    const trayReservedHeight = getRawScannerCollapsedTrayReservedHeight({ bottomInset: 24 });
    const base = { containerHeight: 852 - 87, containerWidth: 393, safeAreaTop: 59, trayReservedHeight };
    const legacy = makeRawScannerCaptureLayout(base);
    const scanner = makeRawScannerCaptureLayout({ ...base, controlsInsideFrame: true });
    const trayTop = base.containerHeight - trayReservedHeight;

    expect(scanner.reticle.x).toBe(16);
    expect(scanner.reticle.width).toBe(361);
    expect(scanner.reticle.y).toBe(59 + 72);
    // Bottom edge 26pt above the handle, which sits 17pt below the reserved tray top.
    expect(scanner.reticle.y + scanner.reticle.height).toBe(trayTop + 17 - 26);
    // Much taller than the old frame, which reserved a controls row below itself.
    expect(scanner.reticle.height).toBeGreaterThan(legacy.reticle.height + 80);
    // The matcher crop is the largest card-shaped rect inside the frame, centered:
    // a card fitted to the frame's top and bottom edges fills it exactly.
    const crop = scanner.captureCropRect;
    expect(crop.height / crop.width).toBeCloseTo(880 / 630, 2);
    expect(crop.y).toBeGreaterThanOrEqual(scanner.reticle.y);
    expect(crop.y + crop.height).toBeLessThanOrEqual(scanner.reticle.y + scanner.reticle.height);
    expect(crop.x).toBeGreaterThanOrEqual(scanner.reticle.x);
    expect(crop.x + crop.width).toBeLessThanOrEqual(scanner.reticle.x + scanner.reticle.width);
    expect(scanner.reticle.height - crop.height).toBeLessThanOrEqual(2);
    expect(Math.abs(crop.x + crop.width / 2 - (scanner.reticle.x + scanner.reticle.width / 2))).toBeLessThanOrEqual(1);
  });

  it('multi-scan uses the same Figma box as single scan, with the grid inside it', () => {
    const trayReservedHeight = getRawScannerCollapsedTrayReservedHeight({ bottomInset: 24 });
    const base = { containerHeight: 874 - 96, containerWidth: 402, controlsInsideFrame: true, safeAreaTop: 62, trayReservedHeight };
    const single = makeRawScannerCaptureLayout(base);
    const page = makeRawScannerCaptureLayout({ ...base, mode: 'page', pageAspectRatio: 880 / 630 });
    const grid = page.captureCropRect;

    // Same box: switching modes moves neither its top nor its bottom.
    expect(page.reticle).toEqual(single.reticle);
    // The 3x3 grid fits INSIDE the box (it used to overhang into the game pill).
    expect(grid.y).toBeGreaterThanOrEqual(single.reticle.y);
    expect(grid.y + grid.height).toBeLessThanOrEqual(single.reticle.y + single.reticle.height);
    expect(grid.x).toBeGreaterThanOrEqual(single.reticle.x);
    expect(grid.height / grid.width).toBeCloseTo(880 / 630, 1);
    // And it stays nearly as wide as the old full-width grid (322pt on this phone).
    expect(grid.width).toBeGreaterThan(310);
  });

  it('leaves the labeling layout (controls row below the frame) unchanged', () => {
    const base = { containerHeight: 852, containerWidth: 393, safeAreaTop: 59 };
    expect(makeRawScannerCaptureLayout(base).reticle.x).toBe(40);
  });

  it('fits a taller binder layout inside the page frame instead of running into the controls', () => {
    const trayReservedHeight = getRawScannerCollapsedTrayReservedHeight({ bottomInset: 34 });
    const base = { containerHeight: 852, containerWidth: 393, safeAreaTop: 59, trayReservedHeight };
    const threeByThree = makeRawScannerCaptureLayout({ ...base, mode: 'page', pageAspectRatio: 880 / 630 });
    const threeByFour = makeRawScannerCaptureLayout({ ...base, mode: 'page', pageAspectRatio: (4 * 880) / (3 * 630) });

    // 3×3 is full width; the taller 3×4 page can't be, so it narrows and
    // stays centered and inside the visible frame box.
    expect(threeByThree.captureCropRect.width).toBe(threeByThree.reticle.width);
    expect(threeByFour.captureCropRect.width).toBeLessThan(threeByThree.captureCropRect.width);
    // Stays inside the visible frame box (page mode trims the vertical insets
    // to 16 so the taller page gets every point it can), never into the
    // controls row or the top chrome.
    expect(threeByFour.captureCropRect.height).toBeLessThanOrEqual(threeByFour.reticle.height);
    expect(threeByFour.captureCropRect.y).toBeGreaterThanOrEqual(threeByFour.reticle.y);
    const centerX = threeByFour.captureCropRect.x + threeByFour.captureCropRect.width / 2;
    expect(Math.abs(centerX - (threeByFour.reticle.x + threeByFour.reticle.width / 2))).toBeLessThanOrEqual(1);
    expect(threeByFour.captureCropRect.height / threeByFour.captureCropRect.width).toBeCloseTo((4 * 880) / (3 * 630), 1);

    // Single-card layout is byte-identical with or without the page aspect.
    const card = makeRawScannerCaptureLayout(base);
    const cardWithAspect = makeRawScannerCaptureLayout({ ...base, pageAspectRatio: 2 });
    expect(cardWithAspect).toEqual(card);
  });

  it('reserves enough height for the first scan row without covering the mode toggle', () => {
    const trayReservedHeight = getRawScannerCollapsedTrayReservedHeight({
      bottomInset: 48,
    });
    const layout = makeRawScannerCaptureLayout({
      containerHeight: 844,
      containerWidth: 390,
      safeAreaTop: 59,
      trayReservedHeight,
    });

    const trayTop = 844 - trayReservedHeight;
    const modeToggleBottom = layout.controlsTop + 56;

    expect(trayReservedHeight).toBe(211);
    expect(trayTop - modeToggleBottom).toBeGreaterThanOrEqual(rawScannerModeToggleGap);
  });
});


// The Android shutter died after single<->multi: CameraX cancelled a superseded
// zoom request, the app treated it as fatal and gated the shutter forever.
describe('isBenignCameraCancellation', () => {
  it('treats a superseded zoom request as benign', () => {
    const message = 'androidx.camera.core.CameraControl$OperationCanceledException: Cancelled due to another zoom value being set.';
    expect(isBenignCameraCancellation(new Error(message))).toBe(true);
    expect(isBenignCameraCancellation({ code: 'unknown/unknown', message })).toBe(true);
  });

  it('keeps real session errors fatal', () => {
    expect(isBenignCameraCancellation(new Error('session/camera-has-been-disconnected'))).toBe(false);
    expect(isBenignCameraCancellation({ code: 'device/camera-in-use-by-other-app', message: 'in use' })).toBe(false);
    expect(isBenignCameraCancellation(null)).toBe(false);
  });
});
