import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { colors } from '@spotlight/design-system';

import { ScanTargetPill } from '@/features/scanner/components/scan-target-pill';

/*
  The scanner's chrome floats over a live camera, and it renders in two
  materials: real Liquid Glass on iOS 26, and a translucent dark scrim
  everywhere else (iOS < 26 and ALL of Android).

  The scrim is the case worth pinning. It is what the overwhelming majority of
  devices actually draw, it is byte-identical to what shipped before glass
  existed, and it is invisible to anyone developing on an iOS 26 simulator — so
  it is exactly the kind of thing that rots silently. `jest.setup` forces
  `isLiquidGlassAvailable()` to false, which is that path.
*/
function surfaceFill(testID: string): unknown {
  const flattened = StyleSheet.flatten(
    screen.getByTestId(testID).props.style as never,
  ) as Record<string, unknown> | undefined;
  return flattened?.backgroundColor;
}

describe('ScanTargetPill', () => {
  it('falls back to the scanner chrome scrim when glass is unavailable', () => {
    render(<ScanTargetPill flag="en" label="Pokémon EN" onPress={jest.fn()} testID="pill" />);

    // Not a hard-coded literal any more — one token, shared with the zoom dock
    // and the tray's SCAN/TOTAL pills.
    expect(surfaceFill('pill-surface')).toBe(colors.scannerChromeFill);
    expect(colors.scannerChromeFill).toBe('rgba(0, 0, 0, 0.35)');
  });

  it('keeps the 36pt height the reticle geometry is derived from', () => {
    render(<ScanTargetPill flag="jp" label="Pokémon JP" onPress={jest.fn()} testID="pill" />);

    /*
      `rawScannerControlsRowHeight` (36) reserves this row, and the reticle inset
      is computed from it — and the reticle IS the capture crop. A taller pill
      silently changes what gets cropped, and therefore match accuracy, with no
      visible symptom until scans start missing.
    */
    const flattened = StyleSheet.flatten(
      screen.getByTestId('pill-surface').props.style as never,
    ) as Record<string, unknown>;
    expect(flattened.height).toBe(36);
  });

  it('still renders its label, flag and affordance through the surface', () => {
    const onPress = jest.fn();
    render(<ScanTargetPill flag="en" label="Pokémon EN" onPress={onPress} testID="pill" />);

    // The material must not swallow the content it wraps.
    expect(screen.getByText('Pokémon EN')).toBeTruthy();
    expect(screen.getByTestId('pill')).toBeTruthy();
    expect(screen.getByTestId('pill').props.accessibilityLabel).toBe(
      'Scanning for Pokémon EN. Change scan target',
    );
  });
});
