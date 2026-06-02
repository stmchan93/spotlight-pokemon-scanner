import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import type { CardFavoriteEntry } from '@spotlight/api-client';

import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

// The shared jest.setup iconoir mock only stubs a fixed set of icon names and
// does not include `Upload` (used by the wishlist share button), so it resolves
// to undefined and breaks the render. Override iconoir here with a Proxy that
// returns a no-op View component for every icon name.
jest.mock('iconoir-react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');

  const make = (name: string) => {
    const Component = (props: Record<string, unknown>) =>
      React.createElement(View, {
        ...props,
        testID: props.testID ?? `iconoir-${name}`,
      });
    Component.displayName = `MockIconoir(${name})`;
    return Component;
  };

  return new Proxy(
    {},
    {
      get: (_target, prop: string) => make(String(prop)),
    },
  );
});

function buildFavoriteEntry(
  overrides: Partial<CardFavoriteEntry> & Pick<CardFavoriteEntry, 'cardId' | 'name'>,
): CardFavoriteEntry {
  return {
    cardNumber: '#001/100',
    setName: 'Test Set',
    imageUrl: 'https://example.com/card.png',
    smallImageUrl: null,
    largeImageUrl: null,
    marketPrice: 1,
    currencyCode: 'USD',
    favoritedAt: '2026-05-01T00:00:00.000Z',
    isOwned: false,
    ...overrides,
  };
}

function renderWishlistScreen(repository?: ReturnType<typeof createTestSpotlightRepository>) {
  return renderWithProviders(<WishlistScreen />, { spotlightRepository: repository });
}

describe('WishlistScreen', () => {
  const push = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({
      push,
      back: jest.fn(),
      replace: jest.fn(),
    });
  });

  it('paginates the list view: shows 10 rows + View More, then reveals more on tap', async () => {
    const favorites = Array.from({ length: 12 }, (_, index) =>
      buildFavoriteEntry({
        cardId: `page-${index}`,
        name: `Card ${index}`,
      }),
    );
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);

    await screen.findByTestId('wishlist-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('wishlist-row-page-0')).toBeTruthy();
    });

    // Only the first page of 10 rows is rendered initially (default is list view).
    expect(screen.queryAllByTestId(/^wishlist-row-page-\d+$/).length).toBe(10);
    expect(screen.getByTestId('wishlist-row-page-9')).toBeTruthy();
    expect(screen.queryByTestId('wishlist-row-page-10')).toBeNull();
    expect(screen.queryByTestId('wishlist-row-page-11')).toBeNull();

    // The pagination footer shows the View More button.
    expect(screen.getByTestId('wishlist-list-pagination')).toBeTruthy();
    expect(screen.getByTestId('wishlist-list-pagination-view-more')).toBeTruthy();

    // Tapping View More reveals the remaining rows.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-list-pagination-view-more'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('wishlist-row-page-10')).toBeTruthy();
    });
    expect(screen.getByTestId('wishlist-row-page-11')).toBeTruthy();
    expect(screen.queryAllByTestId(/^wishlist-row-page-\d+$/).length).toBe(12);

    // All rows are now visible, so View More is gone but Back to top remains.
    expect(screen.queryByTestId('wishlist-list-pagination-view-more')).toBeNull();
    expect(screen.getByTestId('wishlist-list-pagination-back-to-top')).toBeTruthy();
  });

  it('paginates the grid view: shows 10 tiles + View More, then reveals more on tap', async () => {
    const favorites = Array.from({ length: 12 }, (_, index) =>
      buildFavoriteEntry({
        cardId: `page-${index}`,
        name: `Card ${index}`,
      }),
    );
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);

    await screen.findByTestId('wishlist-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('wishlist-row-page-0')).toBeTruthy();
    });

    // Default view is list — switch to grid (card) view via the toggle.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-view-toggle'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('wishlist-grid-tile-page-0')).toBeTruthy();
    });

    // Only the first page of 10 tiles is rendered initially.
    expect(screen.queryAllByTestId(/^wishlist-grid-tile-page-\d+$/).length).toBe(10);
    expect(screen.getByTestId('wishlist-grid-tile-page-9')).toBeTruthy();
    expect(screen.queryByTestId('wishlist-grid-tile-page-10')).toBeNull();
    expect(screen.queryByTestId('wishlist-grid-tile-page-11')).toBeNull();

    // The pagination footer shows the View More button in grid view too.
    expect(screen.getByTestId('wishlist-list-pagination')).toBeTruthy();
    expect(screen.getByTestId('wishlist-list-pagination-view-more')).toBeTruthy();

    // Tapping View More reveals the remaining tiles.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-list-pagination-view-more'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('wishlist-grid-tile-page-10')).toBeTruthy();
    });
    expect(screen.getByTestId('wishlist-grid-tile-page-11')).toBeTruthy();
    expect(screen.queryAllByTestId(/^wishlist-grid-tile-page-\d+$/).length).toBe(12);

    // All tiles are now visible, so View More is gone but Back to top remains.
    expect(screen.queryByTestId('wishlist-list-pagination-view-more')).toBeNull();
    expect(screen.getByTestId('wishlist-list-pagination-back-to-top')).toBeTruthy();
  });

  it('features the first favorite in the hero and re-features the tapped row', async () => {
    const favorites = [
      buildFavoriteEntry({
        cardId: 'charizard',
        name: 'Charizard',
        cardNumber: '100/101',
        setName: 'Dragon Frontiers',
        marketPrice: 129198.3,
        isOwned: true,
        slabContext: { grader: 'PSA', grade: '10' },
        dayChangeAmount: 3.99,
      }),
      buildFavoriteEntry({
        cardId: 'gengar',
        name: 'Gengar ex',
        cardNumber: '193/162',
        setName: 'Perfect Order',
        marketPrice: 450.12,
        isOwned: true,
        conditionShortLabel: 'NM',
        dayChangeAmount: 3.99,
      }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);

    // Hero defaults to the first favorite, with its price + grade + delta.
    const heroPrice = await screen.findByTestId('wishlist-hero-price');
    expect(heroPrice).toHaveTextContent('$129,198.30');
    expect(screen.getByTestId('wishlist-hero-trend')).toBeTruthy();
    expect(screen.getByTestId('wishlist-hero-gradient')).toBeTruthy();

    // The list row carries the grade + price delta sourced from the favorite.
    await waitFor(() => {
      expect(screen.getByTestId('wishlist-row-gengar')).toBeTruthy();
    });

    // Tapping the second row promotes it into the hero.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-row-gengar'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('wishlist-hero-price')).toHaveTextContent('$450.12');
    });

    // Tapping the hero card (a release with no drag) opens the featured card's
    // detail screen. The card is driven by PanResponder, so fire its release
    // handler directly rather than a Pressable press.
    await act(async () => {
      fireEvent(screen.getByTestId('wishlist-hero-card'), 'responderRelease', {
        nativeEvent: {},
      });
    });
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/cards/[cardId]',
        params: expect.objectContaining({ cardId: 'gengar' }),
      }),
    );
  });

  it('does not render the pagination footer when the wishlist is empty', async () => {
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => [],
    });

    renderWishlistScreen(repository);

    await screen.findByTestId('wishlist-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('wishlist-empty')).toBeTruthy();
    });

    expect(screen.queryByTestId('wishlist-list-pagination')).toBeNull();
  });
});
