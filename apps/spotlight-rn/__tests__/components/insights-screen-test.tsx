import { screen, waitFor } from '@testing-library/react-native';

import type { TransactionInsights } from '@spotlight/api-client';
import { InsightsScreen } from '@/features/insights/screens/insights-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

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
};

describe('InsightsScreen', () => {
  it('renders simple transaction-log analytics: month/all-time counts, top sale, biggest sale', async () => {
    renderWithProviders(<InsightsScreen />, {
      spotlightRepository: createTestSpotlightRepository({
        loadTransactionInsights: async () => sampleInsights,
      }),
    });

    expect(screen.getByTestId('insights-header-title').props.children).toBe('Insights');

    // Biggest sale highlight renders with its price.
    await waitFor(() => {
      expect(screen.getByTestId('insights-biggest-sale')).toBeTruthy();
    });
    expect(screen.getByTestId('insights-biggest-sale-price').props.children).toBe('$1,200.00');

    // Top sale this month renders with its price.
    expect(screen.getByTestId('insights-top-sale-sale-1-price').props.children).toBe('$450.00');

    // Month + all-time stat cards present; the month-sold count shows 12.
    expect(screen.getByTestId('insights-month-sold')).toBeTruthy();
    expect(screen.getByTestId('insights-all-sold')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('shows empty states when there is no activity', async () => {
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
      topSalesThisMonth: [],
    };

    renderWithProviders(<InsightsScreen />, {
      spotlightRepository: createTestSpotlightRepository({
        loadTransactionInsights: async () => empty,
      }),
    });

    await waitFor(() => {
      expect(screen.getByText('Your highest-price sale will show up here.')).toBeTruthy();
    });
    expect(screen.queryByTestId('insights-biggest-sale')).toBeNull();
  });
});
