import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { PillButton, SpotlightThemeProvider } from '@spotlight/design-system';

function renderPill(node: React.ReactElement) {
  return render(<SpotlightThemeProvider>{node}</SpotlightThemeProvider>);
}

function flattenPressableStyle(style: unknown): Record<string, unknown> {
  const resolved = typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
  return (StyleSheet.flatten(resolved as never) as Record<string, unknown>) ?? {};
}

describe('PillButton', () => {
  describe("tone='filter'", () => {
    it('renders a white background when not selected', () => {
      renderPill(
        <PillButton
          label="Favorites"
          onPress={jest.fn()}
          selected={false}
          testID="filter-chip"
          tone="filter"
        />,
      );

      const chip = screen.getByTestId('filter-chip');
      expect(chip).toBeTruthy();
      expect(chip.props.accessibilityState).toMatchObject({ selected: false });
      expect(screen.getByText('Favorites')).toBeTruthy();

      const flattened = flattenPressableStyle(chip.props.style);
      // gray0 maps to a white surface in the theme.
      expect(typeof flattened.backgroundColor).toBe('string');
      // gray0 is white in the design system.
      expect(flattened.backgroundColor).toMatch(/^#?[Ff][Ff][Ff]/);
    });

    it('marks accessibilityState.selected when selected', () => {
      renderPill(
        <PillButton
          label="Favorites"
          onPress={jest.fn()}
          selected
          testID="filter-chip"
          tone="filter"
        />,
      );

      const chip = screen.getByTestId('filter-chip');
      expect(chip.props.accessibilityState).toMatchObject({ selected: true });
    });

    it('fires onPress when tapped', () => {
      const onPress = jest.fn();
      renderPill(
        <PillButton
          label="Favorites"
          onPress={onPress}
          tone="filter"
          testID="filter-chip"
        />,
      );

      fireEvent.press(screen.getByTestId('filter-chip'));
      expect(onPress).toHaveBeenCalledTimes(1);
    });
  });

  it("renders without a tone prop (default) as a regression check", () => {
    const onPress = jest.fn();
    renderPill(<PillButton label="1W" onPress={onPress} testID="default-pill" />);

    const pill = screen.getByTestId('default-pill');
    expect(pill).toBeTruthy();
    expect(screen.getByText('1W')).toBeTruthy();

    fireEvent.press(pill);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
