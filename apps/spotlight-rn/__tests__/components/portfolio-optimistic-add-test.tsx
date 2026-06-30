import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';
import { Pressable, Text } from 'react-native';

import type { InventoryCardEntry, PortfolioDashboard } from '@spotlight/api-client';

import { TabsPageContext } from '@/contexts/tabs-page-context';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { useAppServices } from '@/providers/app-providers';
import { __resetPortfolioSummaryVisibilityForTests } from '@/features/portfolio/use-portfolio-summary-visibility';
import { __resetPortfolioViewModeForTests } from '@/features/portfolio/hooks/use-portfolio-view-mode';

import * as mockApiClient from '../mock-api-client';
import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

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

const portfolioTabsContext = {
  activePage: 'portfolio' as const,
  chartScrubLockRef: { current: false },
  collectionEditing: false,
  setCollectionEditing: () => {},
};

function buildInventoryEntry(
  overrides: Partial<InventoryCardEntry> & Pick<InventoryCardEntry, 'id' | 'name'>,
): InventoryCardEntry {
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

// Exposes the shared optimistic-add hook as a button so the test can simulate an
// add from another screen (card detail / scanner) WITHOUT routing into it.
function OptimisticAddButton({
  entry,
  alsoRefresh = false,
}: {
  entry: InventoryCardEntry;
  alsoRefresh?: boolean;
}) {
  const { prependOptimisticInventoryEntry, refreshData } = useAppServices();
  return (
    <Pressable
      testID="optimistic-add-trigger"
      onPress={() => {
        // Mirror the real add call sites: prepend optimistically, then kick the
        // background reconciliation refetch.
        prependOptimisticInventoryEntry(entry);
        if (alsoRefresh) {
          refreshData();
        }
      }}
    >
      <Text>add</Text>
    </Pressable>
  );
}

function renderHarness({
  repository,
  newEntry,
  alsoRefresh = false,
}: {
  repository: mockApiClient.SpotlightRepository;
  newEntry: InventoryCardEntry;
  alsoRefresh?: boolean;
}) {
  return renderWithProviders(
    <TabsPageContext.Provider value={portfolioTabsContext}>
      <PortfolioScreen />
      <OptimisticAddButton entry={newEntry} alsoRefresh={alsoRefresh} />
    </TabsPageContext.Provider>,
    { spotlightRepository: repository },
  );
}

describe('Portfolio optimistic add', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetPortfolioSummaryVisibilityForTests();
    __resetPortfolioViewModeForTests();
    (useRouter as jest.Mock).mockReturnValue({
      push: jest.fn(),
      back: jest.fn(),
      replace: jest.fn(),
    });
  });

  it('shows the new card at the TOP of the collection immediately, before the dashboard refetch resolves', async () => {
    const existing = buildInventoryEntry({
      id: 'existing-1',
      name: 'Existing Card',
      addedAt: '2026-05-01T00:00:00.000Z',
    });
    const dashboard = buildDashboardWithInventory([existing]);
    const newEntry = buildInventoryEntry({
      id: 'real-entry-id',
      cardId: 'card-new',
      name: 'Freshly Added',
      addedAt: '2026-06-27T12:00:00.000Z',
      marketPrice: 25,
    });

    // First dashboard load resolves so the grid mounts. A SUBSEQUENT load
    // (triggered by refreshData after an add) never resolves, proving the
    // optimistic row appears without waiting on the slow refetch.
    let dashboardCalls = 0;
    let blockSecondLoad: () => void = () => {};
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({ state: 'success', data: [existing], errorMessage: null }),
      loadPortfolioDashboard: async () => {
        dashboardCalls += 1;
        if (dashboardCalls === 1) {
          return { state: 'success', data: dashboard, errorMessage: null };
        }
        return new Promise(() => {
          // Never resolves — simulates the slow 3-5s dashboard refetch.
          blockSecondLoad = () => {};
        });
      },
    });

    renderHarness({ repository, newEntry });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-existing-1')).toBeTruthy();
    });
    expect(screen.queryByTestId('collection-masonry-grid-tile-real-entry-id')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('optimistic-add-trigger'));
    });

    // The new card is present immediately even though the second (refresh)
    // dashboard load is still pending.
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-real-entry-id')).toBeTruthy();
    });
    expect(screen.getByTestId('collection-masonry-grid-tile-existing-1')).toBeTruthy();
    // The summary total bumped by the new card's value (100 + 25).
    expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$125.00');
    blockSecondLoad();
  });

  it('reconciles by id — the server refetch returning the same entry yields exactly one row', async () => {
    const existing = buildInventoryEntry({ id: 'existing-1', name: 'Existing Card' });
    const newEntry = buildInventoryEntry({
      id: 'real-entry-id',
      cardId: 'card-new',
      name: 'Freshly Added',
      addedAt: '2026-06-27T12:00:00.000Z',
      marketPrice: 25,
    });

    const initialBase = buildDashboardWithInventory([existing]);
    const initialDashboard: PortfolioDashboard = {
      ...initialBase,
      ranges: {
        ...initialBase.ranges,
        '1W': { portfolio: [{ isoDate: '2026-06-01', shortLabel: 'Jun 1', value: 100 }], sales: [] },
      },
    };
    // The reconciled dashboard the slow refetch eventually returns — it contains
    // the SAME new entry (same id) the optimistic add inserted, with the server's
    // true post-add total. A hydrated series keeps the parallel inventory load
    // merging into it (rather than recomputing the value from inventory).
    const reconciledBase = buildDashboardWithInventory([newEntry, existing]);
    const reconciledDashboard: PortfolioDashboard = {
      ...reconciledBase,
      summary: { ...reconciledBase.summary, currentValue: 125 },
      ranges: {
        ...reconciledBase.ranges,
        '1W': { portfolio: [{ isoDate: '2026-06-01', shortLabel: 'Jun 1', value: 125 }], sales: [] },
      },
    };

    let dashboardCalls = 0;
    let inventoryCalls = 0;
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => {
        inventoryCalls += 1;
        return {
          state: 'success',
          data: inventoryCalls === 1 ? [existing] : [newEntry, existing],
          errorMessage: null,
        };
      },
      loadPortfolioDashboard: async () => {
        dashboardCalls += 1;
        return dashboardCalls === 1
          ? { state: 'success', data: initialDashboard, errorMessage: null }
          : { state: 'success', data: reconciledDashboard, errorMessage: null };
      },
    });

    renderHarness({ repository, newEntry, alsoRefresh: true });

    await screen.findByTestId('portfolio-header-title');
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-existing-1')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('optimistic-add-trigger'));
    });

    // Optimistic row appears immediately.
    await waitFor(() => {
      expect(screen.getByTestId('collection-masonry-grid-tile-real-entry-id')).toBeTruthy();
    });

    // After the slow refetch lands with the same id, there must be exactly ONE
    // row for it (no duplicate) — the container testID has no trailing suffix.
    await waitFor(() => {
      expect(dashboardCalls).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      const tilePattern = /^collection-masonry-grid-tile-real-entry-id$/;
      expect(screen.queryAllByTestId(tilePattern).length).toBe(1);
    });
    // Totals don't double-count the reconciled entry.
    expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$125.00');
  });
});
