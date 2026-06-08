import {
  getRawScannerCollapsedTrayReservedHeight,
  getRawScannerEmptyTrayVisualHeight,
  makeRawScannerCaptureLayout,
  pickScannerLens,
  rawScannerModeToggleGap,
} from '@/features/scanner/raw-scanner-capture-surface';

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

  describe('pickScannerLens', () => {
    it('prefers the macro-capable virtual triple camera (Pro devices)', () => {
      expect(pickScannerLens([
        'builtInUltraWideCamera',
        'builtInWideAngleCamera',
        'builtInTelephotoCamera',
        'builtInTripleCamera',
      ])).toBe('builtInTripleCamera');
    });

    it('prefers the dual-wide virtual device when there is no triple camera', () => {
      expect(pickScannerLens([
        'builtInUltraWideCamera',
        'builtInWideAngleCamera',
        'builtInDualWideCamera',
      ])).toBe('builtInDualWideCamera');
    });

    it('falls back to the physical wide lens when no macro virtual device exists', () => {
      expect(pickScannerLens(['builtInWideAngleCamera', 'builtInTelephotoCamera']))
        .toBe('builtInWideAngleCamera');
    });

    it('returns undefined when no preferred lens is available', () => {
      expect(pickScannerLens(['builtInUltraWideCamera'])).toBeUndefined();
      expect(pickScannerLens([])).toBeUndefined();
    });
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
