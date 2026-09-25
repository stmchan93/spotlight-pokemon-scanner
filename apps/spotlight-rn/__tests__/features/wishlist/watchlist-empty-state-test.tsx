import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';

import type { CardFavoriteEntry, WatchlistSuggestion } from '@spotlight/api-client';

import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';
import { capturePostHogEvent } from '@/lib/observability/posthog';

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

function suggestion(overrides: Partial<WatchlistSuggestion> & Pick<WatchlistSuggestion, 'cardId' | 'name'>): WatchlistSuggestion {
  return {
    cardNumber: '4/102',
    setName: 'Base Set',
    imageUrl: 'https://example.com/card.png',
    game: 'pokemon',
    language: 'English',
    marketPrice: 12.5,
    currencyCode: 'USD',
    lastScannedAt: '2026-09-23T00:00:00+00:00',
    ...overrides,
  };
}

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
    expect(screen.getByText('Suggest cards to watch')).toBeTruthy();
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

  it('loads suggestions on Suggest and watches one through setCardFavorite', async () => {
    let favorites: CardFavoriteEntry[] = [];
    const getWatchlistSuggestions = jest.fn(async () => [
      suggestion({ cardId: 'base1-2', name: 'Blastoise' }),
      suggestion({ cardId: 'base1-15', name: 'Venusaur' }),
    ]);
    const setCardFavorite = jest.fn(async (cardId: string) => {
      favorites = [{ ...favoriteEntry, cardId, watchKey: `${cardId}|`, name: 'Blastoise' }];
      return { cardId, isFavorite: true, favoritedAt: '2026-09-24T00:00:00.000Z', watchVariant: null };
    });
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
      getWatchlistSuggestions,
      setCardFavorite,
    });
    renderWithProviders(<WishlistScreen />, { spotlightRepository: repository });

    const suggest = await screen.findByTestId('watchlist-empty-suggest');
    await act(async () => {
      fireEvent.press(suggest);
    });

    expect(getWatchlistSuggestions).toHaveBeenCalledWith(6);
    expect(capturePostHogEvent).toHaveBeenCalledWith('watchlist_suggestions_requested');
    expect(await screen.findByTestId('watchlist-suggestion-base1-2')).toBeTruthy();
    expect(screen.getByText('Venusaur')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('watchlist-suggestion-watch-base1-2'));
    });

    expect(setCardFavorite).toHaveBeenCalledWith('base1-2', true);
    expect(capturePostHogEvent).toHaveBeenCalledWith('watchlist_item_added', {
      source: 'watchlist_suggestion',
      kind: 'card',
      has_printing: false,
    });
    // The screen re-reads favorites, so the watched card becomes a real row.
    await waitFor(() => {
      expect(screen.queryByTestId('watchlist-empty-example')).not.toBeOnTheScreen();
    });
    expect(screen.getByText('Blastoise')).toBeTruthy();
  });

  it('shows the fallback line when there is nothing to suggest', async () => {
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => [],
      getWatchlistSuggestions: async () => [],
    });
    renderWithProviders(<WishlistScreen />, { spotlightRepository: repository });

    const suggest = await screen.findByTestId('watchlist-empty-suggest');
    await act(async () => {
      fireEvent.press(suggest);
    });

    expect(await screen.findByText("Scan a few cards and we'll suggest some here.")).toBeTruthy();
  });

  it('shows a quiet retry when suggestions fail', async () => {
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => [],
      getWatchlistSuggestions: async () => {
        throw new Error('offline');
      },
    });
    renderWithProviders(<WishlistScreen />, { spotlightRepository: repository });

    const suggest = await screen.findByTestId('watchlist-empty-suggest');
    await act(async () => {
      fireEvent.press(suggest);
    });

    expect(await screen.findByTestId('watchlist-suggestions-error')).toBeTruthy();
  });

  it('sends guests to login instead of watching', async () => {
    mockIsGuest = true;
    const setCardFavorite = jest.fn();
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => [],
      getWatchlistSuggestions: async () => [suggestion({ cardId: 'base1-2', name: 'Blastoise' })],
      setCardFavorite,
    });
    renderWithProviders(<WishlistScreen />, { spotlightRepository: repository });

    const suggest = await screen.findByTestId('watchlist-empty-suggest');
    await act(async () => {
      fireEvent.press(suggest);
    });
    mockOpenLogin.mockClear();
    const watch = await screen.findByTestId('watchlist-suggestion-watch-base1-2');
    await act(async () => {
      fireEvent.press(watch);
    });

    expect(mockOpenLogin).toHaveBeenCalled();
    expect(setCardFavorite).not.toHaveBeenCalled();
  });
});
