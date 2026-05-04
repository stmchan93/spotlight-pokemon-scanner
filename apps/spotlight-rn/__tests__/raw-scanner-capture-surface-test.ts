import {
  getRawScannerCollapsedTrayReservedHeight,
  getRawScannerEmptyTrayVisualHeight,
  makeRawScannerCaptureLayout,
  rawScannerModeToggleGap,
} from '@/features/scanner/raw-scanner-capture-surface';

describe('raw scanner capture layout', () => {
  it('reserves one-row tray space from the first render', () => {
    expect(getRawScannerCollapsedTrayReservedHeight({
      bottomInset: 48,
    })).toBe(183);
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

    expect(trayReservedHeight).toBe(183);
    expect(trayTop - modeToggleBottom).toBeGreaterThanOrEqual(rawScannerModeToggleGap);
  });
});
