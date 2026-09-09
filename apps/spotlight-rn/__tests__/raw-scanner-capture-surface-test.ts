import { colors } from '@spotlight/design-system';

import {
  getRawScannerCollapsedTrayReservedHeight,
  getRawScannerEmptyTrayVisualHeight,
  makeRawScannerCaptureLayout,
  rawScannerControlsRowHeight,
  rawScannerControlsRowLift,
  rawScannerModeToggleGap,
  reticleLockedCornerColor,
  reticleRestingCornerColor,
} from '@/features/scanner/raw-scanner-capture-surface';

/*
  The reticle frame has been purple, then white, then purple again. Nothing
  guarded it, so each flip was invisible until someone looked at a phone. These
  are literals on purpose — asserting `toBe(colors.purple300)` would pass if the
  token itself were repointed, which is exactly the drift worth catching.
*/
describe('reticle corner colours', () => {
  it('rests on brand purple, per Figma 2227:22484 Color/purple/300', () => {
    expect(reticleRestingCornerColor).toBe('#C47EFF');
    expect(reticleRestingCornerColor).not.toBe(colors.scannerTextPrimary);
  });

  it('pulses to the saturated brand purple on capture', () => {
    expect(reticleLockedCornerColor).toBe('#A54BFA');
  });

  it('keeps the two states distinguishable, or the capture pulse says nothing', () => {
    expect(reticleLockedCornerColor).not.toBe(reticleRestingCornerColor);
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

