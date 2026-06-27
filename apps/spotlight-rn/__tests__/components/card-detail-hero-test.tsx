import { render, screen } from '@testing-library/react-native';
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

describe('CardDetailHero wishlist counter', () => {
  it('labels the count as "Wishlisted" with a comma-formatted value', () => {
    renderHero({ likeCount: 1234 });
    expect(screen.getByText('1,234 Wishlisted')).toBeTruthy();
  });

  it('caps the counter at 9999+', () => {
    renderHero({ likeCount: 25000 });
    expect(screen.getByText('9999+ Wishlisted')).toBeTruthy();
  });

  it('shows 9,999 exactly (only values above the cap collapse to 9999+)', () => {
    renderHero({ likeCount: 9999 });
    expect(screen.getByText('9,999 Wishlisted')).toBeTruthy();
  });

  it('hides the counter when nobody has wishlisted the card', () => {
    renderHero({ likeCount: 0 });
    expect(screen.queryByTestId('hero-like-count')).toBeNull();
  });
});
