import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { GlassSurface, SpotlightThemeProvider } from '@spotlight/design-system';

// The jest.setup mock forces `isLiquidGlassAvailable()` to false (real Liquid
// Glass only exists on an iOS 26 device + Xcode-26 build), so these tests assert
// the solid fallback path that Android and every non-iOS-26 target render.
function renderSurface(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

describe('GlassSurface (fallback path)', () => {
  it('renders a plain solid View in the fallbackColor when glass is unavailable', () => {
    renderSurface(
      <GlassSurface fallbackColor="#123456" testID="glass">
        <Text>child</Text>
      </GlassSurface>,
    );

    const flattened =
      (StyleSheet.flatten(screen.getByTestId('glass').props.style as never) as Record<
        string,
        unknown
      >) ?? {};
    expect(flattened.backgroundColor).toBe('#123456');
    // Children still render through the fallback.
    expect(screen.getByText('child')).toBeTruthy();
  });

  it('never applies a blur/translucent imitation on the fallback', () => {
    renderSurface(<GlassSurface fallbackColor="#FFFFFF" testID="glass-solid" />);

    const flattened =
      (StyleSheet.flatten(screen.getByTestId('glass-solid').props.style as never) as Record<
        string,
        unknown
      >) ?? {};
    // Solid, fully opaque token color — not an rgba() knockoff.
    expect(flattened.backgroundColor).toBe('#FFFFFF');
  });
});
