import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import type { CardFavoriteEntry } from '@spotlight/api-client';

import { __resetTrendWindowForTests } from '@/features/portfolio/hooks/use-trend-window';
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
    __resetTrendWindowForTests();
    (useRouter as jest.Mock).mockReturnValue({
      push,
      back: jest.fn(),
      replace: jest.fn(),
    });
  });

  // Was: "highlights the Wishlist tab in the bottom nav (filled bookmark)".
  // Wishlist is a real tab now (`(tabs)/wishlist.tsx`) and the bar is Apple's
  // native iOS 26 one, drawn by UIKit from `(tabs)/_layout.tsx` — there is no JS
  // bar left to assert a selected state on, and it can't be reached from jest.
  // Inverted into the regression guard for the bug that motivated the change:
  // the screen kept rendering its own `AppBottomTabBar`, so the user saw TWO
  // stacked bottom bars.
  it('renders no JS bottom tab bar — the native tab bar is the only one', async () => {
    renderWishlistScreen();
    await screen.findByTestId('wishlist-header-title');
    expect(screen.queryByTestId('bottom-nav-wishlist')).toBeNull();
    expect(screen.queryByTestId('bottom-nav-portfolio')).toBeNull();
    expect(screen.queryByTestId('bottom-nav-scan')).toBeNull();
  });

  // Wishlist is one of the four TABS now. It carried a back chevron from when it
  // was pushed in from the drawer, which by then popped you to whatever you had
  // visited before — or did nothing. A tab is a root: hamburger, like Home and
  // You, plus the same left-edge drag.
  it('opens the drawer from the header, and has no back button to press', async () => {
    renderWishlistScreen();
    await screen.findByTestId('wishlist-header-title');

    expect(screen.queryByTestId('wishlist-header-back')).toBeNull();
    expect(screen.getByTestId('wishlist-header-menu')).toBeTruthy();
    expect(screen.getByTestId('drawer-edge-swipe')).toBeTruthy();
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

  it('rarity chips keep only entries whose served bucket matches (missing bucket never matches)', async () => {
    const favorites = [
      buildFavoriteEntry({ cardId: 'sir-card', name: 'Charizard ex', rarityBucket: 'sir' }),
      buildFavoriteEntry({ cardId: 'shiny-card', name: 'Shiny Gengar', rarityBucket: 'shiny' }),
      // Older cached payloads carry no rarityBucket → excluded by every chip.
      buildFavoriteEntry({ cardId: 'plain-card', name: 'Pidgey' }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);
    await screen.findByTestId('wishlist-row-sir-card');

    // Chip labels come from the api-client RARITY_BUCKET_LABELS map.
    expect(screen.getByText('SIR')).toBeTruthy();
    fireEvent.press(screen.getByTestId('wishlist-filter-sir'));

    await waitFor(() => {
      expect(screen.queryByTestId('wishlist-row-shiny-card')).not.toBeOnTheScreen();
    });
    expect(screen.getByTestId('wishlist-row-sir-card')).toBeTruthy();
    expect(screen.queryByTestId('wishlist-row-plain-card')).toBeNull();

    // Back to All restores every entry.
    fireEvent.press(screen.getByTestId('wishlist-filter-all'));
    await waitFor(() => {
      expect(screen.getByTestId('wishlist-row-plain-card')).toBeTruthy();
    });
  });

  // The since-added/30d trend UI was removed from the wishlist (2026-07-18,
  // same as Collection; it is moving to the PDP): no header tag, no row/tile
  // percents, no row sparklines — even when entries carry the trend data.
  it('renders no trend tag, row/tile percents, or row sparklines', async () => {
    const favorites = [
      buildFavoriteEntry({
        cardId: 'window-1',
        name: 'Charizard',
        marketPrice: 600,
        sinceAddedChangeAmount: 142,
        sinceAddedChangePercent: 31,
        sinceAddedBaselineDate: '2026-03-12',
        sparkPoints: [500, 520, 480, 600],
        sparkTrendPct: 12,
      }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);

    // List view: row renders without tag, percent, or sparkline.
    await screen.findByTestId('wishlist-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('wishlist-row-window-1')).toBeTruthy();
    });
    expect(screen.queryByTestId('wishlist-trend-window-tag')).toBeNull();
    expect(screen.queryByTestId('wishlist-row-window-1-trend')).toBeNull();
    expect(screen.queryByTestId('wishlist-row-window-1-sparkline')).toBeNull();
    expect(screen.queryByText('+31.00%')).toBeNull();

    // Grid view: tile renders without tag or percent.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-view-toggle'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('wishlist-grid-tile-window-1')).toBeTruthy();
    });
    expect(screen.queryByTestId('wishlist-trend-window-tag')).toBeNull();
    expect(screen.queryByTestId('wishlist-grid-tile-window-1-trend')).toBeNull();
    expect(screen.queryByText('+31.00%')).toBeNull();
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

  // The "hides the tab bar" half of this test is gone: that was the JS
  // `AppBottomTabBar` this screen used to draw. UIKit owns the bar now and it
  // can't be hidden per-screen, so edit mode only swaps the header + edit bar.
  it('enters edit mode from the header, swapping in Done + the edit bar', async () => {
    const favorites = [
      buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' }),
      buildFavoriteEntry({ cardId: 'gengar', name: 'Gengar ex' }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);

    const editButton = await screen.findByTestId('wishlist-header-edit');
    // The catalog-search button sits beside Edit before edit mode...
    expect(screen.queryByTestId('wishlist-header-search')).toBeTruthy();

    await act(async () => {
      fireEvent.press(editButton);
    });

    expect(screen.getByTestId('wishlist-header-done')).toBeTruthy();
    expect(screen.getByTestId('wishlist-edit-bar')).toBeTruthy();
    // ...and stands down while selecting, leaving Done alone in the right slot.
    expect(screen.queryByTestId('wishlist-header-search')).toBeNull();
  });

  // The catalog search used to be a floating magnifier FAB pinned above the tab
  // bar (`CollectionAddFab`). It is a header button now, sitting beside Edit and
  // built from the same `GlassNavBubble` — same destination, same label.
  it('opens the catalog search from a header button, not a floating FAB', async () => {
    const favorites = [buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' })];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);

    const searchButton = await screen.findByTestId('wishlist-header-search');
    expect(searchButton.props.accessibilityLabel).toBe('Search the card catalog');
    // The floating variant is gone from this screen entirely.
    expect(screen.queryByTestId('collection-add-fab')).toBeNull();

    await act(async () => {
      fireEvent.press(searchButton);
    });

    expect(push).toHaveBeenCalledWith('/catalog/search');
  });

  it('groups add, edit and share into one pill', async () => {
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => [buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' })],
    });

    renderWishlistScreen(repository);

    /*
      Figma 3725:59578 — one glass pill, not three separate bubbles. `within`
      is what pins the GROUPING; asserting the three testIDs exist would still
      pass if they drifted back apart into individual circles.
    */
    const actions = await screen.findByTestId('wishlist-header-actions');
    expect(within(actions).getByTestId('wishlist-header-search')).toBeTruthy();
    expect(within(actions).getByTestId('wishlist-header-edit')).toBeTruthy();
    expect(within(actions).getByTestId('wishlist-header-share')).toBeTruthy();
  });

  it('shows share, and share deliberately does nothing yet', async () => {
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => [buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' })],
    });

    renderWishlistScreen(repository);

    const share = await screen.findByTestId('wishlist-header-share');
    expect(share.props.accessibilityLabel).toBe('Share wishlist');

    await act(async () => {
      fireEvent.press(share);
    });

    /*
      A PLACEHOLDER, on purpose: the wishlist is private (the public profile has
      Collection / For Sale / Activity and no Wishlist tab), so there is no URL
      to share and no decision yet on text vs image vs a public tab. This test
      exists so that when the handler gains a body, someone has to come here and
      say what it now does — rather than it quietly starting to fire something.
    */
    expect(push).not.toHaveBeenCalled();
  });

  // A header button is chrome, not an overlay on the list, so it survives the
  // case a list-anchored FAB had to special-case: an empty wishlist.
  it('keeps the header search reachable when the wishlist is empty', async () => {
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => [],
    });

    renderWishlistScreen(repository);

    await screen.findByTestId('wishlist-empty');
    const searchButton = screen.getByTestId('wishlist-header-search');

    await act(async () => {
      fireEvent.press(searchButton);
    });

    expect(push).toHaveBeenCalledWith('/catalog/search');
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
      expect(screen.queryByTestId('wishlist-row-charizard')).not.toBeOnTheScreen();
      expect(screen.queryByTestId('wishlist-row-gengar')).not.toBeOnTheScreen();
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
