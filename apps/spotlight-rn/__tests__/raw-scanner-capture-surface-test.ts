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
    })).toBe(197);
  });

  it('keeps the empty tray visual shell compact before any scans exist', () => {
    expect(getRawScannerEmptyTrayVisualHeight({
      bottomInset: 48,
    })).toBe(121);
  });

  it('reserves enough vertical gap between controls and tray', () => {
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
    const controlsBottom = layout.controlsTop + 56;

    expect(trayReservedHeight).toBe(197);
    expect(trayTop - controlsBottom).toBeGreaterThanOrEqual(rawScannerModeToggleGap);
  });
});
