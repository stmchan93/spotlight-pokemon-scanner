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
  // Focus effect runs the composer-refresh consumer; no-op in tests.
  useFocusEffect: jest.fn(),
}));

jest.mock('@spotlight/design-system', () => {
  const actual = jest.requireActual('@spotlight/design-system');
   
  const React = require('react');
   
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

// Staging, 2026-09-29: a sealed box deleted from the Collection dropped the
// balance while the chart kept it. The delete must move the chart with the
// headline immediately, and a dashboard read issued BEFORE the delete must not
// land after it and put the box back.
function DeleteButton({ id }: { id: string }) {
  const { removeOptimisticInventoryEntries, refreshData } = useAppServices();
  return (
    <Pressable
      testID="optimistic-delete-trigger"
      onPress={() => {
        removeOptimisticInventoryEntries([id]);
        refreshData();
      }}
    >
      <Text>delete</Text>
    </Pressable>
  );
}

function RefreshButton() {
  const { refreshData } = useAppServices();
  return (
    <Pressable testID="refresh-trigger" onPress={() => refreshData()}>
      <Text>refresh</Text>
    </Pressable>
  );
}

function charted(items: InventoryCardEntry[], values: number[]): PortfolioDashboard {
  const base = buildDashboardWithInventory(items);
  const last = values[values.length - 1];
  return {
    ...base,
    summary: { ...base.summary, currentValue: last },
    ranges: {
      ...base.ranges,
      '1W': {
        portfolio: values.map((value, index) => ({ isoDate: `2026-09-2${index + 7}`, shortLabel: `${index}`, value })),
        sales: [],
        summary: { currentValue: last, startValue: values[0], changeAmount: last - values[0], changePercent: null },
      },
    },
  };
}

describe('Portfolio delete keeps the chart and the headline together', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetPortfolioSummaryVisibilityForTests();
    __resetPortfolioViewModeForTests();
    (useRouter as jest.Mock).mockReturnValue({ push: jest.fn(), back: jest.fn(), replace: jest.fn() });
  });

  it('a pre-delete dashboard read that lands late does not restore the deleted box', async () => {
    const card = buildInventoryEntry({ id: 'card-1', name: 'Card', marketPrice: 100 });
    const box = buildInventoryEntry({
      id: 'box-1', cardId: 'tcgp-sealed-709029', name: 'Sealed Box', marketPrice: 2300, conditionCode: undefined,
    });
    const before = charted([box, card], [100, 2400]);
    const after = charted([card], [100, 100]);

    const pending: Array<(value: PortfolioDashboard) => void> = [];
    let dashboardCalls = 0;
    let deleted = false;
    const repository = createTestSpotlightRepository({
      loadInventoryEntries: async () => ({
        state: 'success', data: deleted ? [card] : [box, card], errorMessage: null,
      }),
      loadPortfolioDashboard: async () => {
        dashboardCalls += 1;
        if (dashboardCalls === 1) {
          return { state: 'success', data: before, errorMessage: null };
        }
        return new Promise((resolve) => {
          pending.push((data) => resolve({ state: 'success', data, errorMessage: null }));
        });
      },
    });

    renderWithProviders(
      <TabsPageContext.Provider value={portfolioTabsContext}>
        <PortfolioScreen />
        <RefreshButton />
        <DeleteButton id="box-1" />
      </TabsPageContext.Provider>,
      { spotlightRepository: repository },
    );

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$2,400.00');
    });

    // A read in flight from before the delete (e.g. a scan's refresh).
    await act(async () => {
      fireEvent.press(screen.getByTestId('refresh-trigger'));
    });
    await waitFor(() => expect(pending.length).toBe(1));

    deleted = true;
    await act(async () => {
      fireEvent.press(screen.getByTestId('optimistic-delete-trigger'));
    });
    await waitFor(() => expect(pending.length).toBe(2));
    expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$100.00');

    // The post-delete read lands first, then the stale pre-delete one.
    await act(async () => {
      pending[1](after);
    });
    await act(async () => {
      pending[0](before);
    });

    expect(screen.getByTestId('portfolio-summary-value')).toHaveTextContent('$100.00');
    expect(screen.queryByTestId('collection-masonry-grid-tile-box-1')).toBeNull();
  });
});
