import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { CardWishlistCounter } from '@/features/cards/components/card-wishlist-counter';

const safeAreaMetrics = {
  frame: { height: 852, width: 393, x: 0, y: 0 },
  insets: { top: 59, right: 0, bottom: 34, left: 0 },
};

function renderCounter(props: React.ComponentProps<typeof CardWishlistCounter>) {
  return render(
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <SpotlightThemeProvider>
        <CardWishlistCounter {...props} />
      </SpotlightThemeProvider>
    </SafeAreaProvider>,
  );
}

describe('CardWishlistCounter', () => {
  it('renders a comma-formatted wishlist count', () => {
    renderCounter({ count: 1234, testID: 'wishlist' });
    expect(screen.getByTestId('wishlist-value').props.children).toBe('1,234');
  });

  it('caps the counter at 9999+', () => {
    renderCounter({ count: 25000, testID: 'wishlist' });
    expect(screen.getByTestId('wishlist-value').props.children).toBe('9999+');
  });

  it('shows 9,999 exactly (only values above the cap collapse to 9999+)', () => {
    renderCounter({ count: 9999, testID: 'wishlist' });
    expect(screen.getByTestId('wishlist-value').props.children).toBe('9,999');
  });

  it('renders nothing when nobody has wishlisted the card', () => {
    renderCounter({ count: 0, testID: 'wishlist' });
    expect(screen.queryByTestId('wishlist')).toBeNull();
  });
});
