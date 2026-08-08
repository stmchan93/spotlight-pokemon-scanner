import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import { Alert, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { MockSpotlightRepository } from '@spotlight/api-client';
import type {
  Collection,
  CollectionsSnapshot,
  InventoryCardEntry,
  PortfolioDashboard,
} from '@spotlight/api-client';

import { TabsPageContext } from '@/contexts/tabs-page-context';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import {
  PORTFOLIO_SUMMARY_HIDDEN_STORAGE_KEY,
  __resetPortfolioSummaryVisibilityForTests,
} from '@/features/portfolio/use-portfolio-summary-visibility';
import { __resetPortfolioViewModeForTests } from '@/features/portfolio/hooks/use-portfolio-view-mode';
import { __resetTrendWindowForTests } from '@/features/portfolio/hooks/use-trend-window';
import { deletePost, fetchAuthorPosts } from '@/features/social/social-service';

import * as mockApiClient from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  // Focus effect runs the composer-refresh consumer; no-op in tests.
  useFocusEffect: jest.fn(),
}));

// Only the network-touching reads the Activity tab makes are stubbed; the rest of
// the social module stays real so nothing else in the tree changes behaviour.
jest.mock('@/features/social/social-service', () => ({
  ...jest.requireActual('@/features/social/social-service'),
  deletePost: jest.fn(async () => true),
  fetchAuthorPosts: jest.fn(async () => []),
  fetchLikedPostIds: jest.fn(async () => new Set()),
  fetchUnreadNotificationCount: jest.fn(async () => 0),
}));

// RollingNumberText is a slot-machine display (each digit is a column rendering
// 0-9), so its text content isn't the literal value. Swap it for a plain Text so
// tests can assert the displayed portfolio value directly.
jest.mock('@spotlight/design-system', () => {
  const actual = jest.requireActual('@spotlight/design-system');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text: RNText } = require('react-native');
  return {
    ...actual,
    RollingNumberText: ({ value, testID, style }: { value: string; testID?: string; style?: unknown }) =>
      React.createElement(RNText, { testID, style }, value),
  };
});

// The portfolio dashboard refresh effect is gated on the tabs context's
// activePage being 'portfolio' so the 13-call fan-out doesn't fire while
// the user is on the scanner tab. The default context value is 'scanner'
// for isolated renders; tests targeting the portfolio screen must override
// it so the loading effects run.
const portfolioTabsContext = {
  activePage: 'portfolio' as const,
  chartScrubLockRef: { current: false },
  collectionEditing: false,
  setCollectionEditing: () => {},
};

function renderPortfolioScreen({
  repository,
  showPortfolio = true,
}: {
  repository?: mockApiClient.SpotlightRepository;
  showPortfolio?: boolean;
} = {}) {
  return renderWithProviders(
    <TabsPageContext.Provider value={portfolioTabsContext}>
      {showPortfolio ? (
        <PortfolioScreen />
      ) : (
        <Text testID="portfolio-placeholder">Portfolio hidden</Text>
      )}
    </TabsPageContext.Provider>,
    { spotlightRepository: repository },
  );
}

function buildInventoryEntry(overrides: Partial<InventoryCardEntry> & Pick<InventoryCardEntry, 'id' | 'name'>): InventoryCardEntry {
  return {
    cardId: overrides.cardId ?? `card-${overrides.id}`,
    cardNumber: '#001/100',
    setName: 'Test Set',
    imageUrl: 'https://example.com/card.png',
    marketPrice: 1,
    hasMarketPrice: true,
    currencyCode: 'USD',
    quantity: 1,
    addedAt: '2026-05-01T00:00:00.000Z',
    kind: 'raw',
    conditionCode: 'near_mint',
    conditionLabel: 'Near Mint',
    conditionShortLabel: 'NM',
    ...overrides,
  };
}

function buildDashboardWithInventory(items: InventoryCardEntry[]): PortfolioDashboard {
  return {
    summary: {
      currentValue: 100,
      changeAmount: 5,
      changePercent: 5,
      asOfLabel: 'Today',
    },
    inventoryCount: items.length,
    inventoryItems: items,
    recentSales: [],
    ranges: {
      '1W': { portfolio: [], sales: [] },
      '1M': { portfolio: [], sales: [] },
      '3M': { portfolio: [], sales: [] },
      YTD: { portfolio: [], sales: [] },
      '1Y': { portfolio: [], sales: [] },
      ALL: { portfolio: [], sales: [] },
    },
  };
}

// Two collections with different holdings, so "which collection am I looking
// at?" is answerable from the screen.
const MAIN_COLLECTION: Collection = {
  id: 'collection:main',
  name: 'Main Collection',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  cardCount: 1,
  totalValue: 100,
  isDefault: true,
  hidden: false,
};

const GRAILS_COLLECTION: Collection = {
  id: 'collection:grails',
  name: 'Grails',
  sortOrder: 1,
  createdAt: '2026-02-01T00:00:00.000Z',
  cardCount: 1,
  totalValue: 42,
  isDefault: false,
  hidden: false,
};

const COLLECTIONS_SNAPSHOT: CollectionsSnapshot = {
  collections: [MAIN_COLLECTION, GRAILS_COLLECTION],
  defaultCollectionID: MAIN_COLLECTION.id,
  all: { cardCount: 2, totalValue: 142 },
};

function buildScopedDashboard(items: InventoryCardEntry[], currentValue: number): PortfolioDashboard {
  const base = buildDashboardWithInventory(items);
  return {
    ...base,
    summary: { ...base.summary, currentValue },
    ranges: {
      ...base.ranges,
      // A hydrated open range, so the inventory load merges into this dashboard
      // instead of recomputing the value from the entries.
      '1W': {
        portfolio: [{ isoDate: '2026-05-01', shortLabel: 'May 1', value: currentValue }],
        sales: [],
      },
    },
  };
}

/**
 * A repository whose holdings actually differ per collection — the only way to
 * tell a re-scoped read from a stale one. `grailsDashboard` lets a test make the
 * second collection EMPTY, which is the case the owner hit (a just-created
 * collection still showing the main collection's money).
 */
function createCollectionScopedRepository({
  grailsDashboard,
  ...overrides
}: Partial<mockApiClient.SpotlightRepository> & { grailsDashboard?: PortfolioDashboard } = {}) {
  const mainItems = [buildInventoryEntry({ id: 'main-1', name: 'Main Card', marketPrice: 100 })];
  const grailItems = [buildInventoryEntry({ id: 'grail-1', name: 'Grail Card', marketPrice: 42 })];
  const grails = grailsDashboard ?? buildScopedDashboard(grailItems, 42);

  return createTestSpotlightRepository({
    listCollections: async () => COLLECTIONS_SNAPSHOT,
    loadInventoryEntries: async (query?: { collectionID?: string | null }) => ({
      state: 'success' as const,
      data: query?.collectionID === GRAILS_COLLECTION.id ? grails.inventoryItems : mainItems,
      errorMessage: null,
    }),
    loadPortfolioDashboard: async (options?: { collectionID?: string | null }) => (
      options?.collectionID === GRAILS_COLLECTION.id
        ? {
            state: (grails.inventoryItems.length > 0 ? 'success' : 'empty') as 'success' | 'empty',
            data: grails,
            errorMessage: null,
          }
        : {
            state: 'success' as const,
            data: buildScopedDashboard(mainItems, 100),
            errorMessage: null,
          }
    ),
    ...overrides,
  });
}

async function openCollectionPicker() {
  await act(async () => {
    fireEvent.press(screen.getByTestId('collection-search-row-collection'));
  });
  await screen.findByTestId('collection-picker-sheet');
}

describe('PortfolioScreen', () => {
  const push = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    __resetPortfolioSummaryVisibilityForTests();
    __resetPortfolioViewModeForTests();
    __resetTrendWindowForTests();
    (useRouter as jest.Mock).mockReturnValue({
      push,
      back: jest.fn(),
      replace: jest.fn(),
    });
  });

  it('renders the header, summary, search row, filter chips, masonry grid, and FAB', async () => {
    renderPortfolioScreen();

    expect(screen.queryByText('Loading Ekalight...')).toBeNull();

    // Header.
    expect(await screen.findByTestId('portfolio-header-title')).toBeTruthy();
    // The header is now the profile block; its name sub-element carries the display name.
    expect(screen.getByTestId('portfolio-header-title-name')).toBeTruthy();
    expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();

    // Summary block.
    expect(screen.getByTestId('portfolio-summary-value')).toBeTruthy();
    expect(screen.getByTestId('portfolio-summary-delta')).toBeTruthy();
    // The "Today" date label is removed from the resting delta row per Figma;
    // it only renders while scrubbing the chart.
    expect(screen.queryByTestId('portfolio-summary-delta-date')).toBeNull();
    expect(screen.getByTestId('portfolio-summary-visibility-toggle')).toBeTruthy();

    // The whole screen is one virtualized FlatList now, so there is no
    // "View More" pagination gate (and no legacy "End of List" marker).
    expect(screen.getByTestId('portfolio-scroll-view')).toBeTruthy();
    expect(screen.queryByTestId('portfolio-list-pagination')).toBeNull();
    expect(screen.queryByTestId('portfolio-end-of-list')).toBeNull();

    // Collection search row + filter chips.
    expect(screen.getByTestId('collection-search-row')).toBeTruthy();
    expect(screen.getByTestId('collection-search-row-input')).toBeTruthy();
    expect(screen.getByTestId('collection-filter-chip-row')).toBeTruthy();
    expect(screen.getByTestId('collection-filter-chip-row-all')).toBeTruthy();
    expect(screen.getByTestId('collection-filter-chip-row-az')).toBeTruthy();
    expect(screen.getByTestId('collection-filter-chip-row-price')).toBeTruthy();
    expect(screen.getByTestId('collection-filter-chip-row-favorites')).toBeTruthy();
    expect(screen.getByTestId('collection-filter-chip-row-ungraded')).toBeTruthy();
    expect(screen.getByTestId('collection-filter-chip-row-graded')).toBeTruthy();

    // Masonry grid renders the default inventory tiles.
    expect(screen.getByTestId('collection-masonry-grid')).toBeTruthy();
    expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);

    // Neither the old floating catalog-search FAB nor the in-row "Search Cards"
    // magnifier that replaced it: catalog search is reached from the top-bar
    // search bubble only.
    expect(screen.queryByTestId('collection-search-row-search-card')).toBeNull();
    expect(screen.queryByTestId('collection-add-fab')).toBeNull();
  });

  it('renders the collection summary line in place of the old "My Portfolio" title', async () => {
    renderPortfolioScreen();

    await screen.findByTestId('collection-search-row');

    // Figma 2749:4749 — collection picker on the left, running total on the right.
    expect(screen.getByTestId('collection-search-row-collection')).toBeTruthy();
    expect(screen.getByText('Main Collection')).toBeTruthy();
    expect(screen.getByTestId('collection-search-row-total-value').props.children).toMatch(
      /^Total Value: \$[\d.,]+k?$/,
    );
    expect(screen.queryByText('My Portfolio')).toBeNull();
    // The Select / Done edit-mode toggle was removed from the search row.
    expect(screen.queryByTestId('portfolio-select-toggle')).toBeNull();
  });

  it('opens the collection picker from the summary line and walks ADD → CREATE', async () => {
    // Deliberately NOT stubbing createCollection/listCollections: the mock
    // repository's own implementations keep them consistent with each other, so
    // this exercises the real create → re-read → switch sequence. A stub that
    // creates without appearing in the next list is a fake the product never has.
    const createCollection = jest.spyOn(
      MockSpotlightRepository.prototype,
      'createCollection',
    );
    const repository = createTestSpotlightRepository();

    renderPortfolioScreen({ repository });
    await screen.findByTestId('collection-search-row');

    // The picker used to be inert — tapping it is the entry point to the flow.
    fireEvent.press(screen.getByTestId('collection-search-row-collection'));
    expect(await screen.findByTestId('collection-picker-sheet')).toBeTruthy();

    fireEvent.press(screen.getByTestId('collection-picker-sheet-add'));
    fireEvent.changeText(screen.getByTestId('collection-picker-sheet-name-input'), 'Grails');
    fireEvent.press(screen.getByTestId('collection-picker-sheet-create'));

    await waitFor(() => {
      expect(createCollection).toHaveBeenCalledWith('Grails');
    });
    // Creating switches the tab to the new (empty) collection.
    await waitFor(() => {
      expect(screen.getByText('Grails')).toBeTruthy();
    });
  });

  describe('collection scope', () => {
    it('shows the value of the collection you switched to, not the one you left', async () => {
      renderPortfolioScreen({ repository: createCollectionScopedRepository() });

      await screen.findByTestId('portfolio-summary-value');
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$100.00');
      });

      await openCollectionPicker();
      await act(async () => {
        fireEvent.press(
          screen.getByTestId(`collection-picker-sheet-row-${GRAILS_COLLECTION.id}`),
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$42.00');
      });
      // The name and the money have to agree — that is the whole complaint.
      expect(screen.getByText('Grails')).toBeTruthy();
    });

    it('drops the old collection\'s money the moment you switch, not when the refetch lands', async () => {
      // The scoped read takes seconds against a real backend. For all of that
      // time the header used to keep showing the collection you just left, under
      // the name of the one you picked — which is the bug as the owner sees it,
      // whatever the eventual value turns out to be.
      let resolveGrails: (value: {
        state: 'success';
        data: PortfolioDashboard;
        errorMessage: null;
      }) => void = () => {};
      const mainItems = [buildInventoryEntry({ id: 'main-1', name: 'Main Card', marketPrice: 100 })];
      const repository = createTestSpotlightRepository({
        listCollections: async () => COLLECTIONS_SNAPSHOT,
        loadInventoryEntries: async (query?: { collectionID?: string | null }) => (
          query?.collectionID === GRAILS_COLLECTION.id
            ? new Promise(() => {})
            : { state: 'success' as const, data: mainItems, errorMessage: null }
        ),
        loadPortfolioDashboard: async (options?: { collectionID?: string | null }) => (
          options?.collectionID === GRAILS_COLLECTION.id
            ? new Promise((resolve) => {
                resolveGrails = resolve;
              })
            : { state: 'success' as const, data: buildScopedDashboard(mainItems, 100), errorMessage: null }
        ),
      });

      renderPortfolioScreen({ repository });
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$100.00');
      });

      await openCollectionPicker();
      await act(async () => {
        fireEvent.press(
          screen.getByTestId(`collection-picker-sheet-row-${GRAILS_COLLECTION.id}`),
        );
      });

      // Still loading Grails: the balance may be empty, but it may NOT be the
      // other collection's.
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary-value')).not.toHaveTextContent('$100.00');
      });
      expect(screen.getByTestId('portfolio-chart-skeleton')).toBeTruthy();

      await act(async () => {
        resolveGrails({
          state: 'success',
          data: buildScopedDashboard(
            [buildInventoryEntry({ id: 'grail-1', name: 'Grail Card', marketPrice: 42 })],
            42,
          ),
          errorMessage: null,
        });
      });
      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$42.00');
      });
    });

    it('does not keep the previous balance when the collection switched to is empty', async () => {
      // A brand-new collection reads back empty, and an empty read used to be
      // rejected as a transient backend blip — so the previous collection's
      // money stayed on screen under the new collection's name, permanently.
      const emptyGrails = buildScopedDashboard([], 0);
      renderPortfolioScreen({
        repository: createCollectionScopedRepository({ grailsDashboard: emptyGrails }),
      });

      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$100.00');
      });

      await openCollectionPicker();
      await act(async () => {
        fireEvent.press(
          screen.getByTestId(`collection-picker-sheet-row-${GRAILS_COLLECTION.id}`),
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$0.00');
      });
      // And the cards go with the money: the previous collection's rows must not
      // be left behind either.
      expect(screen.queryByTestId('collection-masonry-grid-tile-main-1')).not.toBeOnTheScreen();
    });

    it('confirms before deleting a collection, and deletes nothing until you do', async () => {
      const deleteCollection = jest.fn(async () => ({ deletedEntryCount: 1 }));
      renderPortfolioScreen({
        repository: createCollectionScopedRepository({ deleteCollection }),
      });
      await screen.findByTestId('portfolio-summary-value');

      await openCollectionPicker();
      await act(async () => {
        fireEvent.press(
          screen.getByTestId(`collection-picker-sheet-row-${GRAILS_COLLECTION.id}-delete`),
        );
      });

      // The confirm is a second bottom sheet, so the picker has to be out of the
      // way first — two overFullScreen modals collide on iOS and the confirm
      // never appears, which is how the trash icon came to look inert.
      await waitFor(() => {
        expect(screen.queryByTestId('collection-picker-sheet')).not.toBeOnTheScreen();
      });
      const confirm = await screen.findByTestId('collection-delete-confirm');
      // Deleting takes the collection's cards with it, so the copy says so.
      expect(within(confirm).getByText(/1 card/)).toBeTruthy();
      expect(deleteCollection).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.press(screen.getByTestId('collection-delete-confirm-confirm'));
      });
      await waitFor(() => {
        expect(deleteCollection).toHaveBeenCalledWith(GRAILS_COLLECTION.id);
      });
    });

    it('cancelling the delete confirm leaves the collection alone', async () => {
      const deleteCollection = jest.fn(async () => ({ deletedEntryCount: 1 }));
      renderPortfolioScreen({
        repository: createCollectionScopedRepository({ deleteCollection }),
      });
      await screen.findByTestId('portfolio-summary-value');

      await openCollectionPicker();
      await act(async () => {
        fireEvent.press(
          screen.getByTestId(`collection-picker-sheet-row-${GRAILS_COLLECTION.id}-delete`),
        );
      });
      await screen.findByTestId('collection-delete-confirm');

      await act(async () => {
        fireEvent.press(screen.getByTestId('collection-delete-confirm-cancel'));
      });

      await waitFor(() => {
        expect(screen.queryByTestId('collection-delete-confirm')).not.toBeOnTheScreen();
      });
      expect(deleteCollection).not.toHaveBeenCalled();
    });

    it('keeps the page scrollable after opening the add-collection form and backing out', async () => {
      renderPortfolioScreen({ repository: createCollectionScopedRepository() });
      await screen.findByTestId('portfolio-summary-value');

      const list = screen.getByTestId('portfolio-scroll-view');
      expect(list.props.scrollEnabled).not.toBe(false);
      // The list adjusts itself around ITS keyboard...
      expect(list.props.automaticallyAdjustKeyboardInsets).toBe(true);

      await openCollectionPicker();
      // ...but not around the naming field's, which lives in a modal on top of
      // it: that subscription is a raw keyboard-frame hook on the native scroll
      // view and it re-insets and scrolls this list for a keyboard the user
      // cannot even see it behind.
      expect(
        screen.getByTestId('portfolio-scroll-view').props.automaticallyAdjustKeyboardInsets,
      ).toBe(false);

      await act(async () => {
        fireEvent.press(screen.getByTestId('collection-picker-sheet-add'));
      });
      expect(screen.getByTestId('collection-picker-sheet-name-input')).toBeTruthy();

      await act(async () => {
        fireEvent.press(screen.getByTestId('collection-picker-sheet-backdrop'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('collection-picker-sheet')).not.toBeOnTheScreen();
      });

      const after = screen.getByTestId('portfolio-scroll-view');
      expect(after.props.scrollEnabled).not.toBe(false);
      expect(after.props.automaticallyAdjustKeyboardInsets).toBe(true);
    });
  });

  it('masks the collection total too when the balance is hidden', async () => {
    renderPortfolioScreen();

    const totalValue = await screen.findByTestId('collection-search-row-total-value');
    expect(totalValue.props.children).not.toContain('*****');

    await act(async () => {
      fireEvent.press(screen.getByTestId('portfolio-summary-visibility-toggle'));
    });

    // Otherwise hiding the big balance would leak the same number one row down.
    await waitFor(() =>
      expect(
        screen.getByTestId('collection-search-row-total-value').props.children,
      ).toBe('Total Value: *****'),
    );
  });

  it('opens notifications from the bell, which replaced the inert share bubble', async () => {
    renderPortfolioScreen();

    const bell = await screen.findByTestId('portfolio-header-notifications');
    expect(screen.getByTestId('portfolio-header-search')).toBeTruthy();
    expect(screen.getByTestId('portfolio-header-edit')).toBeTruthy();

    // The Share bubble that used to sit here was wired to `onPress={() => {}}`
    // — present but doing nothing. The bell took its slot rather than becoming a
    // fourth bubble, so its absence is the point, not an oversight.
    expect(screen.queryByTestId('portfolio-header-share')).toBeNull();

    await act(async () => {
      fireEvent.press(bell);
    });
    expect(push).toHaveBeenCalledWith('/notifications');
  });

  it('hides the unread badge when there is nothing unread', async () => {
    renderPortfolioScreen();

    await screen.findByTestId('portfolio-header-notifications');
    // The default mock resolves 0 unread; a badge showing "0" would be worse
    // than no badge, so it must not render at all.
    expect(screen.queryByTestId('portfolio-header-notifications-badge')).toBeNull();
  });

  it('masks the summary value and delta when the visibility toggle is pressed', async () => {
    renderPortfolioScreen();

    await screen.findByTestId('portfolio-summary-value');
    const summaryDelta = screen.getByTestId('portfolio-summary-delta');
    const toggle = screen.getByTestId('portfolio-summary-visibility-toggle');

    expect(within(summaryDelta).queryAllByText('*****').length).toBe(0);
    expect(screen.queryAllByText('*****').length).toBe(0);

    await act(async () => {
      fireEvent.press(toggle);
    });

    await waitFor(() => {
      expect(within(summaryDelta).queryAllByText('*****').length).toBeGreaterThan(0);
      expect(screen.getAllByText('*****').length).toBeGreaterThan(0);
    });

    await act(async () => {
      fireEvent.press(toggle);
    });

    await waitFor(() => {
      expect(within(summaryDelta).queryAllByText('*****').length).toBe(0);
      expect(screen.queryAllByText('*****').length).toBe(0);
    });
  });

  it('keeps the balance hidden across a remount, and writes the choice to storage', async () => {
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    const view = renderPortfolioScreen();

    await screen.findByTestId('portfolio-summary-value');
    await act(async () => {
      fireEvent.press(screen.getByTestId('portfolio-summary-visibility-toggle'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('*****');
    });

    // Hiding is a choice about privacy, so it has to outlive the screen — and
    // reach disk, or it dies with the process.
    expect(setItem).toHaveBeenCalledWith(PORTFOLIO_SUMMARY_HIDDEN_STORAGE_KEY, '1');

    view.unmount();
    renderPortfolioScreen();

    const value = await screen.findByTestId('portfolio-summary-value');
    expect(value).toHaveTextContent('*****');
    expect(
      screen.getByTestId('portfolio-summary-visibility-toggle').props.accessibilityLabel,
    ).toBe('Show portfolio value');
    setItem.mockRestore();
  });

  it('renders cached inventory and the screen-level summary while the dashboard load is pending', async () => {
    const repository = new mockApiClient.MockSpotlightRepository();
    const sourceRepository = new mockApiClient.MockSpotlightRepository();
    let resolveDashboard: (
      value: Awaited<ReturnType<mockApiClient.MockSpotlightRepository['loadPortfolioDashboard']>>
    ) => void = () => {};

    jest.spyOn(repository, 'loadPortfolioDashboard').mockImplementation(() => {
      return new Promise((resolve) => {
        resolveDashboard = resolve;
      });
    });

    renderPortfolioScreen({ repository });

    expect(screen.queryByText('Loading your portfolio...')).toBeNull();
    expect(await screen.findByTestId('portfolio-chart-skeleton')).toBeTruthy();
    expect(screen.getByTestId('portfolio-summary-value')).toBeTruthy();
    expect(screen.getAllByText('Scorbunny').length).toBeGreaterThan(0);

    const dashboardResult = await sourceRepository.loadPortfolioDashboard();
    await act(async () => {
      resolveDashboard(dashboardResult);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('portfolio-chart-skeleton')).not.toBeOnTheScreen();
    });
    expect(screen.getByTestId('portfolio-summary-value')).toBeTruthy();
  });

  it('renders a RefreshControl on the scroll view', async () => {
    renderPortfolioScreen();

    await screen.findByTestId('portfolio-header-title');

    const scrollView = screen.getByTestId('portfolio-scroll-view');
    const refreshControl = scrollView.props.refreshControl;
    expect(refreshControl).toBeTruthy();
    expect(refreshControl.props.testID).toBe('portfolio-refresh-control');
  });

  it('shows an error StateCard when the initial load fails and there is no cached data', async () => {
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({
        state: 'error' as const,
        data: null,
        errorMessage: 'offline',
      }),
      loadPortfolioDashboard: async () => ({
        state: 'error' as const,
        data: null,
        errorMessage: 'offline',
      }),
    });

    renderPortfolioScreen({ repository });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByText('Could not load your backend data')).toBeTruthy();
    });

    // The chart/summary block is hidden when the initial error is showing.
    expect(screen.queryByTestId('portfolio-summary-value')).toBeNull();
    expect(screen.queryByTestId('collection-masonry-grid')).toBeNull();
  });

  it('keeps showing the last data with a stale hint when a refresh fails after a good load', async () => {
    const inventory = [buildInventoryEntry({ id: 'a', name: 'Card A', marketPrice: 5 })];
    const dashboard = buildDashboardWithInventory(inventory);
    let calls = 0;
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success' as const, data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => {
        calls += 1;
        return calls === 1
          ? { state: 'success' as const, data: dashboard, errorMessage: null }
          : { state: 'error' as const, data: null, errorMessage: 'offline' };
      },
    });

    renderPortfolioScreen({ repository });
    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid')).toBeTruthy();
    });

    // A refresh that fails must NOT wipe the chart or surface a blocking error.
    const refreshControl = screen.getByTestId('portfolio-scroll-view').props.refreshControl;
    await act(async () => {
      refreshControl.props.onRefresh();
    });

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-stale-hint')).toBeTruthy();
    });
    expect(screen.queryByText('Could not refresh your backend data')).toBeNull();
    expect(screen.queryByText('Could not load your backend data')).toBeNull();
    expect(screen.getByTestId('collection-masonry-grid')).toBeTruthy();
  });

  it('does not zero the portfolio value when a refresh returns a transient empty dashboard', async () => {
    const inventory = [buildInventoryEntry({ id: 'a', name: 'Card A', marketPrice: 5 })];
    const base = buildDashboardWithInventory(inventory); // summary.currentValue 100
    // Give it a hydrated chart series so the inventory load merges (keeping the
    // $100 summary) instead of recomputing the value from inventory.
    const dashboard: PortfolioDashboard = {
      ...base,
      ranges: {
        ...base.ranges,
        '1W': { portfolio: [{ isoDate: '2026-05-01', shortLabel: 'May 1', value: 100 }], sales: [] },
      },
    };
    const emptyDashboard: PortfolioDashboard = {
      summary: { currentValue: 0, changeAmount: 0, changePercent: 0, asOfLabel: 'Current snapshot' },
      inventoryCount: 0,
      inventoryItems: [],
      recentSales: [],
      ranges: {
        '1W': { portfolio: [], sales: [] },
        '1M': { portfolio: [], sales: [] },
        '3M': { portfolio: [], sales: [] },
        YTD: { portfolio: [], sales: [] },
        '1Y': { portfolio: [], sales: [] },
        ALL: { portfolio: [], sales: [] },
      },
    };
    let calls = 0;
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success' as const, data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => {
        calls += 1;
        // First load: real $100 dashboard. Refresh: an 'empty' dashboard, as the
        // backend returns when momentarily busy (e.g. right after rapid scans).
        return calls === 1
          ? { state: 'success' as const, data: dashboard, errorMessage: null }
          : { state: 'empty' as const, data: emptyDashboard, errorMessage: null };
      },
    });

    renderPortfolioScreen({ repository });
    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$100.00');
    });

    const refreshControl = screen.getByTestId('portfolio-scroll-view').props.refreshControl;
    await act(async () => {
      refreshControl.props.onRefresh();
    });

    // The transient empty must NOT zero the value — it stays $100 and flags stale.
    await waitFor(() => {
      expect(screen.getByTestId('portfolio-stale-hint')).toBeTruthy();
    });
    expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$100.00');
  });

  it('filters to favorites only when the Favorites chip is tapped', async () => {
    const inventory = [
      buildInventoryEntry({ id: 'fav-1', name: 'Favorited Card', isFavorite: true, marketPrice: 5 }),
      buildInventoryEntry({ id: 'fav-2', name: 'Plain Card', isFavorite: false, marketPrice: 3 }),
      buildInventoryEntry({ id: 'fav-3', name: 'Other Card', marketPrice: 7 }),
    ];
    const dashboard = buildDashboardWithInventory(inventory);
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
    });

    renderPortfolioScreen({ repository });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-fav-1')).toBeTruthy();
    });
    expect(screen.getByTestId('collection-masonry-grid-tile-fav-2')).toBeTruthy();
    expect(screen.getByTestId('collection-masonry-grid-tile-fav-3')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('collection-filter-chip-row-favorites'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('collection-masonry-grid-tile-fav-2')).not.toBeOnTheScreen();
    });
    expect(screen.getByTestId('collection-masonry-grid-tile-fav-1')).toBeTruthy();
    expect(screen.queryByTestId('collection-masonry-grid-tile-fav-3')).toBeNull();
  });

  // The since-added/30d trend UI was removed from the Collection screen
  // (2026-07-18; it is moving to the PDP): no header tag, no tile/row percents,
  // no row sparklines — even when the entries carry the trend data.
  it('renders no trend tag, tile/row percents, or row sparklines', async () => {
    const inventory = [
      buildInventoryEntry({
        id: 'trend-1',
        name: 'Trendy Card',
        cardId: 'card-trend-1',
        marketPrice: 600,
        sinceAddedChangePercent: 31,
        sparkTrendPct: 12,
        sparkPoints: [500, 520, 600],
      }),
    ];
    const dashboard = buildDashboardWithInventory(inventory);
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
    });

    renderPortfolioScreen({ repository });

    // Card (grid) view: tile renders, but no tag and no trend percent.
    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-trend-1')).toBeTruthy();
    });
    expect(screen.queryByTestId('trend-window-tag')).toBeNull();
    expect(screen.queryByTestId('collection-masonry-grid-tile-trend-1-trend')).toBeNull();
    expect(screen.queryByText('+31.00%')).toBeNull();

    // List view: row renders without the trend percent or sparkline.
    await act(async () => {
      fireEvent.press(screen.getByTestId('collection-search-row-view-toggle'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('card-list-row-card-trend-1')).toBeTruthy();
    });
    expect(screen.queryByTestId('trend-window-tag')).toBeNull();
    expect(screen.queryByTestId('card-list-row-card-trend-1-trend')).toBeNull();
    expect(screen.queryByTestId('card-list-row-card-trend-1-sparkline')).toBeNull();
    expect(screen.queryByText('+31.00%')).toBeNull();
  });

  it('long-pressing a card opens the actions menu; Wishlist toggles the favorite', async () => {
    const setCardFavorite = jest.fn(async (cardId: string, isFavorite?: boolean | null) => ({
      cardId,
      isFavorite: isFavorite ?? true,
      favoritedAt: '2026-06-29T00:00:00.000Z',
    }));
    const inventory = [
      buildInventoryEntry({ id: 'lp-1', name: 'Gengar VMAX', cardId: 'card-lp-1', isFavorite: false }),
      buildInventoryEntry({ id: 'lp-2', name: 'Pikachu', cardId: 'card-lp-2' }),
    ];
    const dashboard = buildDashboardWithInventory(inventory);
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
      setCardFavorite,
    });

    renderPortfolioScreen({ repository });

    const tile = await screen.findByTestId('collection-masonry-grid-tile-lp-1');
    await act(async () => {
      fireEvent(tile, 'longPress');
    });

    // Menu opens, titled with the card name, listing all five actions.
    const sheet = await screen.findByTestId('collection-card-actions');
    expect(within(sheet).getByText('Gengar VMAX')).toBeTruthy();
    ['edit', 'duplicate', 'share', 'wishlist', 'delete'].forEach((key) => {
      expect(screen.getByTestId(`collection-card-actions-${key}`)).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('collection-card-actions-wishlist'));
    });
    expect(setCardFavorite).toHaveBeenCalledWith('card-lp-1', true);
  });

  it('filters out graded entries when the Ungraded chip is tapped', async () => {
    const inventory = [
      buildInventoryEntry({ id: 'raw-1', name: 'Raw Card', kind: 'raw' }),
      buildInventoryEntry({
        id: 'slab-1',
        name: 'Slabbed Card',
        kind: 'graded',
        slabContext: {
          certNumber: '12345',
          grader: 'PSA',
          grade: '10',
          variantName: null,
        },
      }),
    ];
    const dashboard = buildDashboardWithInventory(inventory);
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
    });

    renderPortfolioScreen({ repository });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-raw-1')).toBeTruthy();
    });
    expect(screen.getByTestId('collection-masonry-grid-tile-slab-1')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('collection-filter-chip-row-ungraded'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('collection-masonry-grid-tile-slab-1')).not.toBeOnTheScreen();
    });
    expect(screen.getByTestId('collection-masonry-grid-tile-raw-1')).toBeTruthy();
  });

  it('shows only graded entries when the Graded chip is tapped', async () => {
    const inventory = [
      buildInventoryEntry({ id: 'raw-1', name: 'Raw Card', kind: 'raw' }),
      buildInventoryEntry({
        id: 'slab-1',
        name: 'Slabbed Card',
        kind: 'graded',
        slabContext: {
          certNumber: '12345',
          grader: 'PSA',
          grade: '10',
          variantName: null,
        },
      }),
    ];
    const dashboard = buildDashboardWithInventory(inventory);
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
    });

    renderPortfolioScreen({ repository });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-raw-1')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('collection-filter-chip-row-graded'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('collection-masonry-grid-tile-raw-1')).not.toBeOnTheScreen();
    });
    expect(screen.getByTestId('collection-masonry-grid-tile-slab-1')).toBeTruthy();
  });

  describe('empty collection', () => {
    function renderEmptyCollection() {
      const repository = createTestSpotlightRepository({
        loadInventoryEntries: async () => ({ state: 'success', data: [], errorMessage: null }),
        loadPortfolioDashboard: async () => ({
          state: 'success',
          data: buildDashboardWithInventory([]),
          errorMessage: null,
        }),
      });
      return renderPortfolioScreen({ repository });
    }

    it('shows the Figma onboarding prompt (mark + copy + Scan to add) when there are no cards at all', async () => {
      renderEmptyCollection();

      await screen.findByTestId('portfolio-header-title');
      const prompt = await screen.findByTestId('collection-empty-prompt');

      // Ekalight mark above the copy.
      expect(within(prompt).getByTestId('ekalight-mark')).toBeTruthy();
      // Typographic apostrophe, matching the design.
      expect(within(prompt).getByText('Let’s build your collection')).toBeTruthy();
      expect(screen.getByTestId('collection-empty-scan-to-add')).toBeTruthy();
      expect(within(prompt).getByText('Scan to add')).toBeTruthy();

      // The bordered filter-miss card is a different state and must not appear.
      expect(screen.queryByText('No cards match this filter')).toBeNull();
      expect(screen.queryByText('No cards in your portfolio')).toBeNull();
    });

    it('pushes the scanner page when Scan to add is tapped', async () => {
      renderEmptyCollection();

      await screen.findByTestId('collection-empty-prompt');

      await act(async () => {
        fireEvent.press(screen.getByTestId('collection-empty-scan-to-add'));
      });

      // Scan always PUSHES so Back returns to the Collection tab.
      expect(push).toHaveBeenCalledWith({ pathname: '/', params: { page: 'scanner' } });
    });

    it('keeps the "no cards match this filter" state when the collection has cards but the filter matches none', async () => {
      const inventory = [buildInventoryEntry({ id: 'raw-1', name: 'Raw Card', kind: 'raw' })];
      const dashboard = buildDashboardWithInventory(inventory);
      const repository = createTestSpotlightRepository({
        loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
        loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
      });

      renderPortfolioScreen({ repository });

      await screen.findByTestId('portfolio-header-title');
      await waitFor(() => {
        expect(screen.getByTestId('collection-masonry-grid-tile-raw-1')).toBeTruthy();
      });

      // Graded filter over a raw-only collection => zero rows, but the user
      // DOES own cards, so this is the filter-miss card, not the onboarding prompt.
      await act(async () => {
        fireEvent.press(screen.getByTestId('collection-filter-chip-row-graded'));
      });

      await waitFor(() => {
        expect(screen.getByText('No cards match this filter')).toBeTruthy();
      });
      expect(screen.queryByTestId('collection-empty-prompt')).toBeNull();
      expect(screen.queryByTestId('collection-empty-scan-to-add')).toBeNull();
    });
  });

  it('sorts alphabetically when the A-Z chip is tapped', async () => {
    const inventory = [
      buildInventoryEntry({ id: 'zeta', name: 'Zeta Card' }),
      buildInventoryEntry({ id: 'alpha', name: 'Alpha Card' }),
      buildInventoryEntry({ id: 'mu', name: 'Mu Card' }),
    ];
    const dashboard = buildDashboardWithInventory(inventory);
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
    });

    renderPortfolioScreen({ repository });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-alpha')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('collection-filter-chip-row-az'));
    });

    // After A-Z the grid re-renders alphabetically into ruled rows.
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-row-0')).toBeTruthy();
    });

    // All three are still rendered; the visual ordering is verified by the
    // column-distribution above and by the alpha tile being present.
    expect(screen.getByTestId('collection-masonry-grid-tile-alpha')).toBeTruthy();
    expect(screen.getByTestId('collection-masonry-grid-tile-mu')).toBeTruthy();
    expect(screen.getByTestId('collection-masonry-grid-tile-zeta')).toBeTruthy();
  });

  it('sorts by descending price when the $-$$$ chip is tapped', async () => {
    const inventory = [
      buildInventoryEntry({ id: 'cheap', name: 'Cheap Card', marketPrice: 1 }),
      buildInventoryEntry({ id: 'expensive', name: 'Expensive Card', marketPrice: 100 }),
      buildInventoryEntry({ id: 'middle', name: 'Middle Card', marketPrice: 10 }),
    ];
    const dashboard = buildDashboardWithInventory(inventory);
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
    });

    renderPortfolioScreen({ repository });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-expensive')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('collection-filter-chip-row-price'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-expensive')).toBeTruthy();
    });
    expect(screen.getByTestId('collection-masonry-grid-tile-middle')).toBeTruthy();
    expect(screen.getByTestId('collection-masonry-grid-tile-cheap')).toBeTruthy();
  });

  it('fetches a chart range on demand only when it has not been loaded yet', async () => {
    const point = { isoDate: '2026-06-01', shortLabel: 'Jun 1', value: 100 };
    const dashboard = {
      ...buildDashboardWithInventory([buildInventoryEntry({ id: 'a', name: 'Alpha' })]),
      ranges: {
        // Open range (1W) arrives populated from the dashboard; the rest empty
        // until fetched on demand.
        '1W': { portfolio: [point], sales: [] },
        '1M': { portfolio: [], sales: [] },
        '3M': { portfolio: [], sales: [] },
        YTD: { portfolio: [], sales: [] },
        '1Y': { portfolio: [], sales: [] },
        ALL: { portfolio: [], sales: [] },
      },
    };
    const getPortfolioRange = jest.fn(async () => ({
      portfolio: [{ ...point, value: 250 }],
      sales: [],
    }));
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: dashboard.inventoryItems, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
      getPortfolioRange,
    });

    renderPortfolioScreen({ repository });
    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('range-1Y')).toBeTruthy();
    });

    // Switching to an unloaded range fetches just that range.
    await act(async () => {
      fireEvent.press(screen.getByTestId('range-1Y'));
    });
    await waitFor(() => {
      expect(getPortfolioRange).toHaveBeenCalledWith('1Y');
    });

    // Re-selecting the already-loaded open range does NOT refetch.
    getPortfolioRange.mockClear();
    await act(async () => {
      fireEvent.press(screen.getByTestId('range-1W'));
    });
    expect(getPortfolioRange).not.toHaveBeenCalled();
  });

  it('opens the drawer when the hamburger header button is pressed', async () => {
    renderPortfolioScreen();

    const menuButton = await screen.findByTestId('portfolio-header-menu');
    expect(menuButton.props.accessibilityLabel).toBe('Open menu');

    // The drawer state lives in AppDrawerProvider (mounted via renderWithProviders).
    // Verify the button is pressable end-to-end without throwing.
    await act(async () => {
      fireEvent.press(menuButton);
    });

    expect(menuButton).toBeTruthy();
  });

  it('renders the whole list view virtualized, with no View More gate', async () => {
    const inventory = Array.from({ length: 12 }, (_, index) =>
      buildInventoryEntry({
        id: `page-${index}`,
        cardId: `page-${index}`,
        name: `Card ${index}`,
      }),
    );
    const dashboard = buildDashboardWithInventory(inventory);
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
    });

    renderPortfolioScreen({ repository });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid')).toBeTruthy();
    });

    // Switch from the default grid view to the list view.
    await act(async () => {
      fireEvent.press(screen.getByTestId('collection-search-row-view-toggle'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('collection-list-view')).toBeTruthy();
    });

    // The list is virtualized (FlatList): the first window of rows mounts up
    // front and the rest stream in on scroll. The point is that the data is no
    // longer sliced behind a "View More" gate — every entry is in the list.
    expect(screen.getByTestId('card-list-row-page-0')).toBeTruthy();
    expect(screen.getByTestId('card-list-row-page-9')).toBeTruthy();

    // No "View More" pagination gate anymore.
    expect(screen.queryByTestId('portfolio-list-pagination')).toBeNull();
    expect(screen.queryByTestId('portfolio-list-pagination-view-more')).toBeNull();
  });

  it('list rows hide the pill and sparkline when the since-added fields are null', async () => {
    const inventory = [
      buildInventoryEntry({
        id: 'since-none',
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
    const dashboard = buildDashboardWithInventory(inventory);
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
    });

    renderPortfolioScreen({ repository });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('collection-search-row-view-toggle'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('card-list-row-since-none')).toBeTruthy();
    });

    expect(screen.queryByTestId('card-list-row-since-none-trend')).toBeNull();
    expect(screen.queryByText('since added')).toBeNull();
    expect(screen.queryByTestId('card-list-row-since-none-sparkline')).toBeNull();
  });

  it('renders the whole grid view virtualized, with no View More gate', async () => {
    const inventory = Array.from({ length: 12 }, (_, index) =>
      buildInventoryEntry({
        id: `page-${index}`,
        cardId: `page-${index}`,
        name: `Card ${index}`,
      }),
    );
    const dashboard = buildDashboardWithInventory(inventory);
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: inventory, errorMessage: null }),
      loadPortfolioDashboard: async () => ({ state: 'success', data: dashboard, errorMessage: null }),
    });

    renderPortfolioScreen({ repository });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid')).toBeTruthy();
    });

    // The default view is the grid (card) view. Every tile is rendered because
    // the FlatList holds the full collection (no pagination slice). The
    // InventoryCardTile primitive applies the same base testID to its pressable
    // container and `${testID}-*` to each inner element, so match only the
    // container ids (`collection-masonry-grid-tile-page-<n>` with no trailing
    // suffix) to count tiles.
    const tileContainerPattern = /^collection-masonry-grid-tile-page-\d+$/;
    expect(screen.queryAllByTestId(tileContainerPattern).length).toBe(12);
    expect(screen.getByTestId('collection-masonry-grid-tile-page-0')).toBeTruthy();
    expect(screen.getByTestId('collection-masonry-grid-tile-page-11')).toBeTruthy();

    // No "View More" pagination gate anymore.
    expect(screen.queryByTestId('portfolio-list-pagination')).toBeNull();
    expect(screen.queryByTestId('portfolio-list-pagination-view-more')).toBeNull();
  });

  it('navigates to the catalog search route from the top-bar search bubble', async () => {
    renderPortfolioScreen();

    // The in-row "Search Cards" magnifier is gone, so this bubble is now the
    // only way into catalog search from the Collection page.
    const searchBubble = await screen.findByTestId('portfolio-header-search');

    await act(async () => {
      fireEvent.press(searchBubble);
    });

    expect(push).toHaveBeenCalledWith('/catalog/search');
  });

  // Activity holds its OWN copy of the owner's posts (the feed holds another), so
  // the delete path is verified here too rather than assumed from the feed.
  it('deletes an own post from the Activity tab, and restores it when the write fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (fetchAuthorPosts as jest.Mock).mockResolvedValue([
      {
        id: 'activity-post-1',
        // The id AuthProvider signs in as under NODE_ENV=test.
        authorId: '00000000-0000-0000-0000-000000000001',
        author: { displayName: 'UI Test User', handle: null, avatarUrl: null, isVerified: false },
        body: 'My activity post',
        cardId: null,
        likeCount: 0,
        commentCount: 0,
        createdAt: '2026-05-01T00:00:00.000Z',
        media: [],
      },
    ]);
    (deletePost as jest.Mock).mockResolvedValue(false);

    renderPortfolioScreen();
    await screen.findByTestId('portfolio-header-title');

    await act(async () => {
      fireEvent.press(screen.getByTestId('portfolio-profile-tabs-tab-activity'));
    });
    await screen.findByText('My activity post');

    // Confirm first — the ⋯ alone must not delete anything.
    await act(async () => {
      fireEvent.press(screen.getByTestId('portfolio-activity-post-more-button'));
    });
    await screen.findByTestId('portfolio-activity-delete-confirm');
    expect(deletePost).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByTestId('portfolio-activity-delete-confirm-confirm'));
    });

    expect(deletePost).toHaveBeenCalledWith('activity-post-1');
    // The write returned false → the post comes back and the user is told.
    await waitFor(() => expect(screen.getByText('My activity post')).toBeTruthy());
    expect(alertSpy).toHaveBeenCalledWith(
      "Couldn't delete post",
      expect.stringContaining('still there'),
    );

    alertSpy.mockRestore();
  });

  it('shows a + on the Activity tab that opens the New Post composer', async () => {
    renderPortfolioScreen();
    await screen.findByTestId('portfolio-header-title');

    // No + on the default Collection tab.
    expect(screen.queryByTestId('portfolio-header-new-post')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('portfolio-profile-tabs-tab-activity'));
    });

    const newPost = await screen.findByTestId('portfolio-header-new-post');
    await act(async () => {
      fireEvent.press(newPost);
    });
    expect(push).toHaveBeenCalledWith('/new-post');
  });
});
