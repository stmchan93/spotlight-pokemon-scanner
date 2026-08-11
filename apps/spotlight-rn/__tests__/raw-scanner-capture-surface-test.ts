import { colors } from '@spotlight/design-system';

import {
  getRawScannerCollapsedTrayReservedHeight,
  getRawScannerEmptyTrayVisualHeight,
  makeRawScannerCaptureLayout,
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
