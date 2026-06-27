import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { CardDetailHero } from '@/features/cards/components/card-detail-hero';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderHero(props: Partial<React.ComponentProps<typeof CardDetailHero>> = {}) {
  return render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <CardDetailHero
          imageUrl="https://cdn.spotlight.test/card.png"
          isFavorite={false}
          name="Treecko"
          onToggleFavorite={jest.fn()}
          testID="hero"
          {...props}
        />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('CardDetailHero', () => {
  it('renders the hero with a favorite toggle', () => {
    renderHero();
    expect(screen.getByTestId('hero')).toBeTruthy();
    const favorite = screen.getByTestId('hero-favorite');
    expect(favorite.props.accessibilityLabel).toBe('Add to wishlist');
  });

  it('reflects the favorited state in the accessibility label', () => {
    renderHero({ isFavorite: true });
    expect(screen.getByTestId('hero-favorite').props.accessibilityLabel).toBe('Remove from wishlist');
  });

  it('invokes onToggleFavorite when the heart is pressed', () => {
    const onToggleFavorite = jest.fn();
    renderHero({ onToggleFavorite });
    fireEvent.press(screen.getByTestId('hero-favorite'));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
  });
});
