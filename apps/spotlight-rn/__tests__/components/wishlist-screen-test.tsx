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

  it('highlights the Wishlist tab in the bottom nav (filled bookmark)', async () => {
    renderWishlistScreen();
    const tab = await screen.findByTestId('bottom-nav-wishlist');
    expect(tab.props.accessibilityState?.selected).toBe(true);
    // Collection is no longer the highlighted tab while on Wishlist.
    const portfolioTab = await screen.findByTestId('bottom-nav-portfolio');
    expect(portfolioTab.props.accessibilityState?.selected).toBe(false);
  });

  it('renders the whole list view virtualized, with no View More gate', async () => {
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

    // The list is virtualized (FlatList): the first window of rows mounts up
    // front and the rest stream in on scroll. The data is no longer sliced
    // behind a "View More" gate.
    expect(screen.getByTestId('wishlist-row-page-9')).toBeTruthy();
    expect(screen.queryByTestId('wishlist-list-pagination')).toBeNull();
    expect(screen.queryByTestId('wishlist-list-pagination-view-more')).toBeNull();
  });

  it('list rows show the SINCE-ADDED change pill (not day change) with caption + sparkline', async () => {
    const favorites = [
      buildFavoriteEntry({
        cardId: 'since-1',
        name: 'Charizard',
        marketPrice: 600,
        // Day change present but must NOT drive the row pill anymore.
        dayChangeAmount: 2.5,
        dayChangePercent: 0.4,
        sinceAddedChangeAmount: 142,
        sinceAddedChangePercent: 31,
        sinceAddedBaselineDate: '2026-03-12',
        sparkPoints: [500, 520, 480, 600],
        sparkTrendPct: 20,
      }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);

    await screen.findByTestId('wishlist-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('wishlist-row-since-1')).toBeTruthy();
    });

    // Signed since-favorited percent stacked under the price (Robinhood-style).
    expect(screen.getByTestId('wishlist-row-since-1-trend')).toBeTruthy();
    expect(screen.getByText('+31.00%')).toBeTruthy();
    // The day-change amount is no longer rendered on the row.
    expect(screen.queryByText('$2.50')).toBeNull();
    // The 30d sparkline renders between the copy block and the price column.
    expect(screen.getByTestId('wishlist-row-since-1-sparkline')).toBeTruthy();
  });

  it('list rows hide the pill and sparkline when the since-added fields are null', async () => {
    const favorites = [
      buildFavoriteEntry({
        cardId: 'since-none',
        name: 'Bulbasaur',
        dayChangeAmount: 2.5,
        sinceAddedChangeAmount: null,
        sinceAddedChangePercent: null,
        sinceAddedBaselineDate: null,
        sparkPoints: null,
        sparkTrendPct: null,
      }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);

    await screen.findByTestId('wishlist-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('wishlist-row-since-none')).toBeTruthy();
    });

    expect(screen.queryByTestId('wishlist-row-since-none-trend')).toBeNull();
    expect(screen.queryByText('since added')).toBeNull();
    expect(screen.queryByTestId('wishlist-row-since-none-sparkline')).toBeNull();
  });

  it('renders the whole grid view virtualized, with no View More gate', async () => {
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

    // Card view packs two tiles per ruled row, so the whole 12-card wishlist
    // fits in the FlatList's initial window — every tile is present and there
    // is no "View More" gate.
    expect(screen.getByTestId('wishlist-grid-tile-page-11')).toBeTruthy();
    expect(screen.queryAllByTestId(/^wishlist-grid-tile-page-\d+$/).length).toBe(12);
    expect(screen.queryByTestId('wishlist-list-pagination')).toBeNull();
    expect(screen.queryByTestId('wishlist-list-pagination-view-more')).toBeNull();
  });

  it('renders the header (no hero) and opens the detail page when a row is tapped', async () => {
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

    // The featured hero card was removed — the screen opens straight into the
    // header + list, with no hero price/trend/backdrop/card.
    expect(await screen.findByTestId('wishlist-header-title')).toBeTruthy();
    expect(screen.queryByTestId('wishlist-hero-price')).toBeNull();
    expect(screen.queryByTestId('wishlist-hero-trend')).toBeNull();
    expect(screen.queryByTestId('wishlist-hero-backdrop')).toBeNull();
    expect(screen.queryByTestId('wishlist-hero-card')).toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId('wishlist-row-gengar')).toBeTruthy();
    });

    // Tapping a row opens that card's detail page.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-row-gengar'));
    });

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/cards/[cardId]',
        params: expect.objectContaining({ cardId: 'gengar' }),
      }),
    );
  });

  it('removes a wishlist item via swipe-to-delete on the row', async () => {
    const setCardFavorite = jest.fn().mockResolvedValue(undefined);
    const favorites = [
      buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' }),
      buildFavoriteEntry({ cardId: 'gengar', name: 'Gengar ex' }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
      setCardFavorite,
    });

    renderWishlistScreen(repository);

    // The row's swipe-reveal Delete action unfavorites that card.
    const deleteAction = await screen.findByTestId('wishlist-row-delete-charizard', {
      includeHiddenElements: true,
    });
    await act(async () => {
      fireEvent.press(deleteAction);
    });

    expect(setCardFavorite).toHaveBeenCalledWith('charizard', false);
  });

  it('enters edit mode from the header, swapping in Done + the edit bar and hiding the tab bar', async () => {
    const favorites = [
      buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' }),
      buildFavoriteEntry({ cardId: 'gengar', name: 'Gengar ex' }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);

    const editButton = await screen.findByTestId('wishlist-header-edit');
    // The Collection tab is shown in the bottom nav before edit mode.
    expect(screen.queryByTestId('bottom-nav-portfolio')).toBeTruthy();

    await act(async () => {
      fireEvent.press(editButton);
    });

    expect(screen.getByTestId('wishlist-header-done')).toBeTruthy();
    expect(screen.getByTestId('wishlist-edit-bar')).toBeTruthy();
    // The bottom tab bar is hidden while selecting.
    expect(screen.queryByTestId('bottom-nav-portfolio')).toBeNull();
  });

  it('toggles a row selection (instead of navigating) when tapped in edit mode', async () => {
    const favorites = [
      buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' }),
      buildFavoriteEntry({ cardId: 'gengar', name: 'Gengar ex' }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wishlist-header-edit'));
    });

    // Each row shows a selection check-circle in edit mode.
    expect(screen.getByTestId('wishlist-row-charizard-select')).toBeTruthy();
    expect(screen.getByTestId('wishlist-edit-count').props.children).toBe('0 selected');

    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-row-charizard'));
    });

    // Tapping the row selects it instead of opening its detail page.
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId('wishlist-edit-count').props.children).toBe('1 selected');
  });

  it('select-all then bulk-remove un-favorites every selected card', async () => {
    const setCardFavorite = jest.fn().mockResolvedValue(undefined);
    const favorites = [
      buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' }),
      buildFavoriteEntry({ cardId: 'gengar', name: 'Gengar ex' }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
      setCardFavorite,
    });

    renderWishlistScreen(repository);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wishlist-header-edit'));
    });

    // Select every visible card.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-edit-select-all'));
    });
    expect(screen.getByTestId('wishlist-edit-count').props.children).toBe('2 selected');

    // Delete opens the confirm sheet; confirming removes them.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-edit-delete'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-bulk-remove-sheet-confirm'));
    });

    expect(setCardFavorite).toHaveBeenCalledWith('charizard', false);
    expect(setCardFavorite).toHaveBeenCalledWith('gengar', false);

    await waitFor(() => {
      expect(screen.queryByTestId('wishlist-row-charizard')).toBeNull();
      expect(screen.queryByTestId('wishlist-row-gengar')).toBeNull();
    });
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
