import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Animated, FlatList, Share, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

import type { CardFavoriteEntry } from '@spotlight/api-client';

import { __resetTrendWindowForTests } from '@/features/portfolio/hooks/use-trend-window';
import {
  WISHLIST_HEADER_BAR_HEIGHT,
  WISHLIST_TITLE_HIDE_DISTANCE,
} from '@/features/wishlist/components/wishlist-header';
import { WishlistScreen } from '@/features/wishlist/screens/wishlist-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

// Focus is what decides whether the guest bounce is allowed to fire, so the
// test drives it directly.
let mockIsFocused = true;
jest.mock('@react-navigation/native', () => ({
  // Keep the real module — expo-router's testing library needs its navigator
  // factory; only the focus signal is swapped.
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => mockIsFocused,
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

// The share sheet is a real DM send. Stub the network edges so the test can
// assert what actually lands in the thread.
jest.mock('@/features/social/dm-service', () => ({
  // An existing thread, so a recipient renders without going through the
  // debounced people search.
  fetchConversations: jest.fn(async () => [
    {
      id: 'conversation-1',
      isGroup: false,
      otherUserId: 'recipient-1',
      otherUser: {
        displayName: 'Misty',
        handle: 'misty',
        avatarUrl: null,
        isVerified: false,
      },
      lastMessageAt: null,
      lastMessagePreview: null,
    },
  ]),
  findOrCreateDm: jest.fn(async () => 'conversation-1'),
  sendMessage: jest.fn(async () => true),
}));
jest.mock('@/features/profile/profile-service', () => ({
  searchUsers: jest.fn(async () => []),
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

  it('sorts by descending price from a chip whose arrow points down', async () => {
    const favorites = [
      buildFavoriteEntry({ cardId: 'cheap', name: 'Cheap Card', marketPrice: 1 }),
      buildFavoriteEntry({ cardId: 'dear', name: 'Expensive Card', marketPrice: 100 }),
      buildFavoriteEntry({ cardId: 'mid', name: 'Middle Card', marketPrice: 10 }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);
    await screen.findByTestId('wishlist-row-cheap');

    // Highest-first sort ⇒ a downward arrow. It pointed up for a while, which
    // read as "ascending" over a list that was anything but.
    const priceChip = screen.getByTestId('wishlist-filter-price');
    expect(within(priceChip).getByTestId('iconoir-ArrowDown')).toBeTruthy();
    expect(within(priceChip).queryByTestId('iconoir-ArrowUp')).toBeNull();

    fireEvent.press(priceChip);

    await waitFor(() => {
      const ids = screen
        .getAllByTestId(/^wishlist-row-(cheap|dear|mid)$/)
        .map((node) => node.props.testID);
      expect(ids).toEqual(['wishlist-row-dear', 'wishlist-row-mid', 'wishlist-row-cheap']);
    });
  });

  it('sorts A-Z case-insensitively, matching the Collection collation', async () => {
    const favorites = [
      buildFavoriteEntry({ cardId: 'ban', name: 'banana Split' }),
      buildFavoriteEntry({ cardId: 'zeb', name: 'Zebstrika' }),
      buildFavoriteEntry({ cardId: 'abs', name: 'absol' }),
    ];
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => favorites,
    });

    renderWishlistScreen(repository);
    await screen.findByTestId('wishlist-row-ban');

    fireEvent.press(screen.getByTestId('wishlist-filter-az'));

    // A codepoint sort would put the capital Z first ('Z' < 'a').
    await waitFor(() => {
      const ids = screen
        .getAllByTestId(/^wishlist-row-(ban|zeb|abs)$/)
        .map((node) => node.props.testID);
      expect(ids).toEqual(['wishlist-row-abs', 'wishlist-row-ban', 'wishlist-row-zeb']);
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

  it('sends the wishlist as a hydrated reference, not a card list or a raw URL', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const repository = createTestSpotlightRepository({
      getCardFavorites: async () => [
        buildFavoriteEntry({ cardId: 'charizard', name: 'Charizard' }),
        buildFavoriteEntry({ cardId: 'gengar', name: 'Gengar ex' }),
      ],
    });

    renderWishlistScreen(repository);
    // Wait for the favourites to land — sharing before they load would share
    // an empty list, which is a different (also tested) path.
    await screen.findByText('Charizard');

    await act(async () => {
      fireEvent.press(screen.getByTestId('wishlist-header-share'));
    });

    /*
      Sent IN-APP now, not out through the OS share sheet: the message carries a
      `spotlight://` link to the sender's public Wishlist tab, which only
      resolves for someone who already has the build. A DM is the one channel
      where that is guaranteed.
    */
    expect(shareSpy).not.toHaveBeenCalled();
    const sheet = await screen.findByTestId('wishlist-share-sheet');
    expect(sheet).toBeTruthy();
    expect(screen.getByText('Send wishlist to')).toBeTruthy();

    // Pick a recipient and assert what actually lands in the thread.
    await act(async () => {
      fireEvent.press(await screen.findByText('Misty'));
    });

    const { sendMessage } = jest.requireMock('@/features/social/dm-service');
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    /*
      A REFERENCE, not text (social_24). This went through three forms and the
      last one is the point:

        1. the card list as text — duplicated what the link already showed
        2. a one-liner plus a `spotlight://` URL — the URL rendered PURPLE on the
           sender's own purple bubble, so it was invisible to the person sending
           it and read as "sharing just sends text"
        3. an attachment id, hydrated into a preview card on every read

      Only (3) can respect a block created after the send: text baked into a body
      is a permanent pointer nobody can revoke.
    */
    const [, body, options] = (sendMessage as jest.Mock).mock.calls[0];
    // Caption-less: `body` is NOT NULL, so the attachment carries the meaning.
    expect(body).toBe('');
    expect(options).toMatchObject({ sharedProfileTab: 'wishlist' });
    expect(options.sharedProfileUserId).toBeTruthy();

    shareSpy.mockRestore();
  });

  it('stays silent when there is nothing to share', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const repository = createTestSpotlightRepository({ getCardFavorites: async () => [] });

    renderWishlistScreen(repository);

    await act(async () => {
      fireEvent.press(await screen.findByTestId('wishlist-header-share'));
    });

    // Opening the OS sheet with a header and no cards under it is worse than
    // the button appearing to do nothing.
    expect(shareSpy).not.toHaveBeenCalled();

    shareSpy.mockRestore();
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

  /*
    "The buttons stay but the wishlist goes away because it goes out of the view
    when you scroll" — the same relationship Home already has between its pinned
    bubbles and its departing search pill.

    The bar therefore FLOATS over the list instead of sitting in a row above it,
    and three things about that wiring fail silently, so all three are pinned
    here. (Where the fade STARTS and what it looks like belongs to
    `wishlist-header-test`; this file is about the screen's half of the contract.)

    1. NATIVE DRIVER. The list's `onScroll` is an `Animated.event` with
       `useNativeDriver: true`. `useScrollToTop(ref, onScroll)` wraps whatever it
       is handed in a plain JS `useCallback`, so passing that event in and using
       the result as `onScroll` would drop the native driver — and, because a
       native `Animated.event` is an OBJECT rather than a function, would throw
       on the first scroll. The hook is given NO handler; its `handleScroll` runs
       inside the event's `listener`.

    2. THE RESERVATION. A floating bar contributes nothing to layout, so the list
       has to reserve its height, safe area included — this list is NOT inset by
       UIKit, unlike Home's.

    3. THE REST OFFSET. Because it is not inset, it rests at 0 on both platforms:
       "Back to top" targets 0 and needs no `scrollToOverflowEnabled` to survive
       RN's clamp.
  */
  describe('the floating top bar', () => {
    /** The top inset `renderWithProviders` mounts. */
    const TOP_INSET = 59;
    /** The viewport `handleLayout` is told about, i.e. the FAB's threshold. */
    const VIEWPORT = 800;

    function wishlistList() {
      return screen.getByTestId('wishlist-scroll');
    }

    /** The `Animated.View` carrying the title — the clip's only child. */
    function titleWrapper() {
      return screen.getByTestId('wishlist-header-title-clip').props.children;
    }

    async function measureViewport() {
      await act(async () => {
        fireEvent(wishlistList(), 'layout', {
          nativeEvent: { layout: { height: VIEWPORT, width: 393, x: 0, y: 0 } },
        });
      });
    }

    async function scrollList(y: number) {
      await act(async () => {
        fireEvent.scroll(wishlistList(), {
          nativeEvent: {
            contentOffset: { y },
            contentSize: { height: 4000, width: 393 },
            layoutMeasurement: { height: VIEWPORT, width: 393 },
          },
        });
      });
    }

    it('keeps the scroll handler natively driven', async () => {
      renderWishlistScreen();
      await screen.findByTestId('wishlist-header-title');

      // `Animated.event` returns the AnimatedEvent OBJECT when it is native and
      // a plain handler function when it is not, so this distinguishes the two.
      // Composing the FAB by passing this handler through `useScrollToTop` would
      // turn it into a function here and move the bar's motion onto the bridge.
      const onScroll = screen.UNSAFE_getByType(Animated.FlatList as never).props.onScroll;
      expect(typeof onScroll).toBe('object');
      expect(onScroll.__isNative).toBe(true);
    });

    it('reserves the bar’s height, safe area and all, so the list starts below it', async () => {
      renderWishlistScreen();
      await screen.findByTestId('wishlist-header-title');

      const content = StyleSheet.flatten(wishlistList().props.contentContainerStyle);
      expect(content.paddingTop).toBe(TOP_INSET + WISHLIST_HEADER_BAR_HEIGHT);
    });

    // An empty wishlist has no rows to push the copy down, so this is the case
    // where a missing reservation would tuck the empty state under the bubbles.
    it('still reserves it when the wishlist is empty', async () => {
      const repository = createTestSpotlightRepository({ getCardFavorites: async () => [] });
      renderWishlistScreen(repository);

      await screen.findByTestId('wishlist-empty');
      const content = StyleSheet.flatten(wishlistList().props.contentContainerStyle);
      expect(content.paddingTop).toBe(TOP_INSET + WISHLIST_HEADER_BAR_HEIGHT);
    });

    /*
      END TO END: the listener really does run off the native event. The title is
      live at rest and disarmed once the page has travelled the hide distance —
      `pointerEvents` is not animatable, so this is the JS half of the motion and
      the only part of it observable from the screen.
    */
    it('disarms the departed title, while the buttons stay tappable', async () => {
      renderWishlistScreen();
      await screen.findByTestId('wishlist-header-title');
      await measureViewport();

      expect(titleWrapper().props.pointerEvents).toBe('auto');

      await scrollList(WISHLIST_TITLE_HIDE_DISTANCE);
      expect(titleWrapper().props.pointerEvents).toBe('none');

      // ...and the pinned controls are untouched: still mounted, still working.
      expect(screen.getByTestId('wishlist-header-menu')).toBeTruthy();
      await act(async () => {
        fireEvent.press(screen.getByTestId('wishlist-header-search'));
      });
      expect(push).toHaveBeenCalledWith('/catalog/search');
    });

    // The FAB rides on the SAME listener. Passing the animated event through
    // `useScrollToTop` is what would have broken the native driver, so this is
    // the assertion that the alternative wiring actually kept the FAB working.
    it('keeps "Back to top" working, and lands it on the true top', async () => {
      const scrollToOffset = jest
        .spyOn(FlatList.prototype, 'scrollToOffset')
        .mockImplementation(() => {});

      renderWishlistScreen();
      await screen.findByTestId('wishlist-header-title');
      await measureViewport();

      await scrollList(VIEWPORT + 1);
      await act(async () => {
        fireEvent.press(screen.getByTestId('wishlist-scroll-to-top'));
      });

      // 0, not `-insets.top`: this list is not inset by UIKit, so 0 IS its top —
      // and a target of 0 needs no `scrollToOverflowEnabled` to survive RN's
      // clamp, which is why the prop is absent here but required on Home.
      expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
      expect(wishlistList().props.scrollToOverflowEnabled).toBeUndefined();

      scrollToOffset.mockRestore();
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

  /*
    NativeTabs mounts tab screens eagerly, so this screen exists before the tab
    is ever opened. Bouncing a guest to login from mount therefore threw the
    login modal over the scanner on a first launch — the app looked like it
    opened on a login wall. The bounce is allowed only while FOCUSED.
  */
  describe('guest bounce', () => {
    afterEach(() => {
      mockIsFocused = true;
      mockIsGuest = false;
      mockOpenLogin.mockClear();
    });

    it('does NOT open login while the tab is merely mounted, not focused', async () => {
      mockIsGuest = true;
      mockIsFocused = false;

      renderWithProviders(<WishlistScreen />);

      // The screen really did mount — the assertion below is about the bounce
      // being withheld, not about the screen being absent.
      await waitFor(() => {
        expect(screen.getByTestId('wishlist-filter-row')).toBeTruthy();
      });
      expect(mockOpenLogin).not.toHaveBeenCalled();
    });

    it('opens login for a guest once the tab is actually focused', async () => {
      mockIsGuest = true;
      mockIsFocused = true;

      renderWithProviders(<WishlistScreen />);

      await waitFor(() => {
        expect(mockOpenLogin).toHaveBeenCalled();
      });
    });
  });
});
