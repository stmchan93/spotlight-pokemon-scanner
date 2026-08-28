import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { GlassButtonGroup, SpotlightThemeProvider, colors } from '@spotlight/design-system';

/*
  `jest.setup` forces `isLiquidGlassAvailable()` to false — real Liquid Glass
  needs an iOS 26 device and an Xcode-26 build — so these assert the solid
  fallback, which is what Android and every non-iOS-26 target actually draws.
*/
function renderGroup(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

function styleOf(testID: string): Record<string, unknown> {
  return (StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as Record<
    string,
    unknown
  >) ?? {};
}

describe('GlassButtonGroup', () => {
  it('falls back to glassFallback gray, the same fill GlassNavBubble uses', () => {
    renderGroup(
      <GlassButtonGroup testID="group">
        <Text>a</Text>
      </GlassButtonGroup>,
    );

    /*
      One material, one fallback: this group sits NEXT TO `GlassNavBubble`, and
      on the platforms with no glass to hide a difference the two must share a
      fill. That shared fill is `glassFallback` (Figma 4211:83834's composited
      "Fill + Shadow" stack) — pure white shipped an invisible pill on white
      pages, which is what the user reported on the Wishlist bar (2026-08-19).
    */
    expect(styleOf('group').backgroundColor).toBe(colors.glassFallback);
  });

  /*
    …AND THE SHADOW THAT MAKES THAT SURVIVABLE. `canvasElevated` IS the page
    colour, so a white pill with no raised edge is an invisible one. `gray50`
    never needed this; white does.
  */
  it('raises itself off the page when there is no glass to do it', () => {
    renderGroup(
      <GlassButtonGroup testID="group">
        <Text>a</Text>
      </GlassButtonGroup>,
    );

    // jest runs the non-glass path, which is the one that needs the shadow.
    expect(styleOf('group').shadowOpacity).toBeGreaterThan(0);
  });

  it('lays its children out as ONE pill, not adjacent circles', () => {
    renderGroup(
      <GlassButtonGroup testID="group">
        <Text>a</Text>
        <Text>b</Text>
      </GlassButtonGroup>,
    );

    const style = styleOf('group');
    // 40 tall so it sits level with the compact nav bubble and the search pill;
    // 6/6 inset and gap so two 36pt controls fit exactly (Figma 3686:55175).
    expect(style.height).toBe(44);
    expect(style.paddingHorizontal).toBe(6);
    expect(style.gap).toBe(6);
    expect(style.flexDirection).toBe('row');
    // Clipped, or the material spills past the pill's corners.
    expect(style.overflow).toBe('hidden');
  });

  it('accepts a caller fallback without losing its layout', () => {
    renderGroup(
      <GlassButtonGroup fallbackColor="#123456" testID="group">
        <Text>a</Text>
      </GlassButtonGroup>,
    );

    const style = styleOf('group');
    expect(style.backgroundColor).toBe('#123456');
    expect(style.height).toBe(44);
  });

  it('renders its children through the surface', () => {
    renderGroup(
      <GlassButtonGroup testID="group">
        <Text>delete</Text>
        <Text>share</Text>
      </GlassButtonGroup>,
    );

    // The material must not swallow what it wraps.
    expect(screen.getByText('delete')).toBeTruthy();
    expect(screen.getByText('share')).toBeTruthy();
  });
});
