import { fireEvent, screen } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';

import type { CardFavoriteEntry } from '@spotlight/api-client';

import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../../test-utils';

jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) =>
  key === '@spotlight/wishlist/view-mode' ? 'list' : null,
);

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => true,
}));

const mockOpenLogin = jest.fn();
let mockIsGuest = false;
jest.mock('@/features/auth/use-guest-gate', () => ({
  useGuestGate: () => ({
    ensureGuestSession: jest.fn(),
    gate: (fn: () => void) => fn,
    isGuest: mockIsGuest,
    openLogin: mockOpenLogin,
  }),
}));

jest.mock('@/features/auth/access-gate-provider', () => ({
  useAccessGate: () => ({ refresh: jest.fn(), state: 'allowed', status: null }),
}));

jest.mock('@/lib/observability/posthog', () => ({
  ...jest.requireActual('@/lib/observability/posthog'),
  capturePostHogEvent: jest.fn(),
}));

// Same catch-all iconoir stub as wishlist-screen-test (the shared mock lacks
// several icons this screen uses).
jest.mock('iconoir-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        const Component = (props: Record<string, unknown>) =>
          React.createElement(View, { ...props, testID: props.testID ?? `iconoir-${String(prop)}` });
        Component.displayName = `MockIconoir(${String(prop)})`;
        return Component;
      },
    },
  );
});

const favoriteEntry: CardFavoriteEntry = {
  cardId: 'sm7-1',
  watchVariant: null,
  watchKey: 'sm7-1|',
  name: 'Treecko',
  cardNumber: '#1',
  setName: 'Celestial Storm',
  imageUrl: 'https://example.com/treecko.png',
  marketPrice: 1,
  currencyCode: 'USD',
  favoritedAt: '2026-09-01T00:00:00.000Z',
  isOwned: false,
};

describe('Watchlist empty state', () => {
  const push = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsGuest = false;
    (useRouter as jest.Mock).mockReturnValue({ push, back: jest.fn(), replace: jest.fn() });
  });

  it('teaches the feature with the Charizard example and copy', async () => {
    const repository = createTestSpotlightRepository({ getCardFavorites: async () => [] });
    renderWithProviders(<WishlistScreen />, { spotlightRepository: repository });

    await screen.findByTestId('wishlist-empty');
    expect(screen.getByTestId('watchlist-empty-example')).toBeTruthy();
    expect(screen.getByTestId('watchlist-empty-example-tag')).toBeTruthy();
    expect(screen.getByText('Charizard')).toBeTruthy();
    expect(screen.getByText('Base Set')).toBeTruthy();
    expect(screen.getByText('Watch cards you want')).toBeTruthy();
    expect(
      screen.getByText("We'll alert you when one's listed under market on eBay or drops in price."),
    ).toBeTruthy();
    expect(screen.queryByText('Suggest cards to watch')).toBeNull();
    expect(screen.queryByText('Scan a card to add it to your watchlist.')).toBeNull();
  });

  it('keeps the filter message when favorites exist but none match', async () => {
    const repository = createTestSpotlightRepository({ getCardFavorites: async () => [favoriteEntry] });
    renderWithProviders(<WishlistScreen />, { spotlightRepository: repository });

    await screen.findByText('Treecko');
    fireEvent.changeText(screen.getByPlaceholderText('Search your watchlist'), 'zzz-no-match');

    await screen.findByText('No cards match your filters.');
    expect(screen.queryByTestId('watchlist-empty-example')).toBeNull();
  });
});
