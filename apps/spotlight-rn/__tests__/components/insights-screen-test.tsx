import { screen, waitFor } from '@testing-library/react-native';

import type { TransactionInsights } from '@spotlight/api-client';
import { InsightsScreen } from '@/features/insights/screens/insights-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

// TransactionThumb (via 03fbbfd) calls useAuth; these screens render it without
// an AuthProvider in the harness, so stub the hook to the no-token path.
jest.mock('@/providers/auth-provider', () => ({
  ...jest.requireActual('@/providers/auth-provider'),
  useAuth: () => ({ accessToken: null }),
}));

const sampleInsights: TransactionInsights = {
  currencyCode: 'USD',
  thisMonth: {
    sold: { count: 12, amountCents: 84000 },
    bought: { count: 8, amountCents: 31000 },
    traded: { count: 3, amountCents: 0 },
  },
  allTime: {
    sold: { count: 142, amountCents: 931000 },
    bought: { count: 98, amountCents: 340000 },
    traded: { count: 21, amountCents: 0 },
  },
  biggestSale: {
    id: 'biggest-1',
    kind: 'sold',
    amountCents: 120000,
    currencyCode: 'USD',
    occurredAt: '2026-05-02T00:00:00.000Z',
    occurredAtLabel: 'May 2, 2026',
    note: 'Moonbreon',
    itemCount: 1,
    photoUrl: null,
    imageUrl: 'https://cdn.spotlight.test/moonbreon.png',
  },
  biggestPurchase: {
    id: 'purchase-1',
    kind: 'bought',
    amountCents: 88000,
    currencyCode: 'USD',
    occurredAt: '2026-04-18T00:00:00.000Z',
    occurredAtLabel: 'Apr 18, 2026',
    note: 'Booth pickup',
    itemCount: 2,
    photoUrl: null,
    imageUrl: 'https://cdn.spotlight.test/booth.png',
    paymentMethod: 'cash',
  },
  topSalesThisMonth: [
    {
      id: 'sale-1',
      kind: 'sold',
      amountCents: 45000,
      currencyCode: 'USD',
      occurredAt: '2026-06-03T00:00:00.000Z',
      occurredAtLabel: 'Jun 3, 2026',
      note: 'Charizard',
      itemCount: 1,
      photoUrl: null,
      imageUrl: 'https://cdn.spotlight.test/charizard.png',
    },
  ],
  totalPortfolioValueCents: 180000,
  scannedCount: 2876,
  wishlistedCount: 40,
  topGrowth: [
    {
      cardId: 'sm1-1',
      name: 'Ludicolo',
      setName: 'Sun & Moon',
      cardNumber: '1/149',
      imageUrl: 'https://images.pokemontcg.io/sm1/1.png',
      currencyCode: 'USD',
      changeAmountCents: 399,
      changePct: 3.2,
    },
  ],
};

describe('InsightsScreen', () => {
  it('highlights the Collection tab in the bottom nav', async () => {
    renderWithProviders(<InsightsScreen />, {
      spotlightRepository: createTestSpotlightRepository({
        loadTransactionInsights: async () => sampleInsights,
      }),
    });
    const tab = await screen.findByTestId('bottom-nav-portfolio');
    expect(tab.props.accessibilityState?.selected).toBe(true);
  });

  it('renders the redesigned highlights layout', async () => {
    renderWithProviders(<InsightsScreen />, {
      spotlightRepository: createTestSpotlightRepository({
        loadTransactionInsights: async () => sampleInsights,
      }),
    });

    // Header title + monthly highlights eyebrow.
    expect(screen.getByTestId('insights-header-title').props.children).toBe('Insights');
    expect(screen.getByTestId('insights-month-eyebrow').props.children).toBe(
      'Monthly Highlights',
    );

    // Top-growth card renders with its name + green change line.
    await waitFor(() => {
      expect(screen.getByTestId('insights-growth-card-0')).toBeTruthy();
    });
    expect(screen.getByText('Ludicolo')).toBeTruthy();
    expect(screen.getByText('+$3.99 (+3.20%)')).toBeTruthy();

    // "Here's how you did" stat values.
    expect(screen.getByTestId('insights-stat-total-portfolio-value-value').props.children).toBe(
      '$1,800.00',
    );
    expect(screen.getByTestId('insights-stat-scanned-value').props.children).toBe('2,876');
    expect(screen.getByTestId('insights-stat-wishlisted-value').props.children).toBe('40');
  });

  it('shows empty tiles when there is no activity', async () => {
    const empty: TransactionInsights = {
      currencyCode: 'USD',
      thisMonth: {
        sold: { count: 0, amountCents: 0 },
        bought: { count: 0, amountCents: 0 },
        traded: { count: 0, amountCents: 0 },
      },
      allTime: {
        sold: { count: 0, amountCents: 0 },
        bought: { count: 0, amountCents: 0 },
        traded: { count: 0, amountCents: 0 },
      },
      biggestSale: null,
      biggestPurchase: null,
      topSalesThisMonth: [],
      totalPortfolioValueCents: 0,
      scannedCount: 0,
      wishlistedCount: 0,
      topGrowth: [],
    };

    renderWithProviders(<InsightsScreen />, {
      spotlightRepository: createTestSpotlightRepository({
        loadTransactionInsights: async () => empty,
      }),
    });

    await waitFor(() => {
      expect(
        screen.getByText('Your biggest monthly gainers will show up here.'),
      ).toBeTruthy();
    });
  });
});
