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
  it('falls back to gray50 — the fill the buttons it replaces already used', () => {
    renderGroup(
      <GlassButtonGroup testID="group">
        <Text>a</Text>
      </GlassButtonGroup>,
    );

    // Deliberately NOT a new shade: `IconButton variant="subtle"` is gray50, and
    // the design's glass composites to #f7f7f7 over a white page. Inventing a
    // different grey here would make the fallback look like a regression on
    // every device that is not an iOS 26 phone.
    expect(styleOf('group').backgroundColor).toBe(colors.gray50);
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
    expect(style.height).toBe(40);
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
    expect(style.height).toBe(40);
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
