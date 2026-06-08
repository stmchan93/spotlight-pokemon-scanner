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

  // expo-camera returns/selects lenses by *localizedName* (e.g. "Back Triple
  // Camera"), so pickScannerLens matches those, not builtInTripleCamera ids.
  describe('pickScannerLens', () => {
    it('selects the virtual triple camera (Pro devices) by localized name', () => {
      expect(pickScannerLens([
        'Back Camera',
        'Back Dual Wide Camera',
        'Back Telephoto Camera',
        'Back Triple Camera',
        'Back Ultra Wide Camera',
      ])).toBe('Back Triple Camera');
    });

    it('selects the dual-wide virtual camera when there is no triple camera', () => {
      expect(pickScannerLens([
        'Back Camera',
        'Back Dual Wide Camera',
        'Back Ultra Wide Camera',
      ])).toBe('Back Dual Wide Camera');
    });

    it('returns undefined (expo default wide) when no macro-capable virtual device exists', () => {
      // wide + telephoto only (no ultra-wide) -> no Auto Macro; "Back Dual Camera"
      // is wide+tele and must NOT be treated as macro-capable.
      expect(pickScannerLens(['Back Camera', 'Back Telephoto Camera', 'Back Dual Camera']))
        .toBeUndefined();
      expect(pickScannerLens(['Back Camera'])).toBeUndefined();
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
