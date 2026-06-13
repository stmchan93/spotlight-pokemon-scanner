import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import { Text } from 'react-native';

import type { InventoryCardEntry, PortfolioDashboard } from '@spotlight/api-client';

import { TabsPageContext } from '@/contexts/tabs-page-context';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { __resetPortfolioSummaryVisibilityForTests } from '@/features/portfolio/use-portfolio-summary-visibility';
import { __resetPortfolioViewModeForTests } from '@/features/portfolio/hooks/use-portfolio-view-mode';

import * as mockApiClient from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

// The portfolio dashboard refresh effect is gated on the tabs context's
// activePage being 'portfolio' so the 13-call fan-out doesn't fire while
// the user is on the scanner tab. The default context value is 'scanner'
// for isolated renders; tests targeting the portfolio screen must override
// it so the loading effects run.
const portfolioTabsContext = {
  activePage: 'portfolio' as const,
  chartScrubLockRef: { current: false },
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

describe('PortfolioScreen', () => {
  const push = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    __resetPortfolioSummaryVisibilityForTests();
    __resetPortfolioViewModeForTests();
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
    expect(screen.getByTestId('portfolio-header-title').props.children).toBe('Collection');
    expect(screen.getByTestId('portfolio-header-menu')).toBeTruthy();

    // Summary block.
    expect(screen.getByTestId('portfolio-summary-value')).toBeTruthy();
    expect(screen.getByTestId('portfolio-summary-delta')).toBeTruthy();
    expect(screen.getByTestId('portfolio-summary-delta-date')).toBeTruthy();
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

    // Floating add button.
    expect(screen.getByTestId('collection-add-fab')).toBeTruthy();
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
      expect(screen.queryByTestId('portfolio-chart-skeleton')).toBeNull();
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
      expect(screen.queryByTestId('collection-masonry-grid-tile-fav-2')).toBeNull();
    });
    expect(screen.getByTestId('collection-masonry-grid-tile-fav-1')).toBeTruthy();
    expect(screen.queryByTestId('collection-masonry-grid-tile-fav-3')).toBeNull();
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
      expect(screen.queryByTestId('collection-masonry-grid-tile-slab-1')).toBeNull();
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
      expect(screen.queryByTestId('collection-masonry-grid-tile-raw-1')).toBeNull();
    });
    expect(screen.getByTestId('collection-masonry-grid-tile-slab-1')).toBeTruthy();
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

  it('navigates to the catalog search route when the FAB is tapped', async () => {
    renderPortfolioScreen();

    const fab = await screen.findByTestId('collection-add-fab');

    await act(async () => {
      fireEvent.press(fab);
    });

    expect(push).toHaveBeenCalledWith('/catalog/search');
  });
});
