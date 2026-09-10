import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { colors, fontFamilies, textStyles } from '@spotlight/design-system';

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
  it('labels the target in REGULAR 16, not the SemiBold every other pill uses', () => {
    /*
      Figma 5085:15158 asks for Plus Jakarta Sans Regular 16 here, against the
      design system's own default that a tappable control takes the SemiBold
      `control` role. The reason outlives the spec: this label is the NAME of
      what you are scanning, not a command, so SemiBold reads as an instruction.
      Pinned because a later sweep that "fixes" pills to `control` would undo it
      silently.
    */
    render(<ScanTargetPill flag="en" label="Pokémon EN" onPress={() => {}} testID="pill" />);

    const label = StyleSheet.flatten(
      screen.getByText('Pokémon EN').props.style as never,
    ) as Record<string, unknown>;
    expect(label.fontFamily).toBe(fontFamilies.bodyRegular);
    expect(label.fontSize).toBe(16);
    expect(label.fontFamily).not.toBe(textStyles.control.fontFamily);
  });

  it('falls back to the shared light glass fill when glass is unavailable', () => {
    render(<ScanTargetPill flag="en" label="Pokémon EN" onPress={jest.fn()} testID="pill" />);

    // Frost chrome over the camera falls back to solid gray0 (the white tint
    // floor with nothing to see through), like every scanner chip.
    expect(surfaceFill('pill-surface')).toBe(colors.gray0);
  });

  it('is 44pt tall, level with the toolbar bubbles beside it', () => {
    render(<ScanTargetPill flag="jp" label="Pokémon JP" onPress={jest.fn()} testID="pill" />);

    // Top-toolbar control: no reticle coupling here — the capture geometry is
    // frozen behind its own constants in raw-scanner-capture-surface.
    const flattened = StyleSheet.flatten(
      screen.getByTestId('pill-surface').props.style as never,
    ) as Record<string, unknown>;
    expect(flattened.height).toBe(44);
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
