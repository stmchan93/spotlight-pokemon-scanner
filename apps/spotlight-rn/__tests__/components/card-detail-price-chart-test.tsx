import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useRouter } from 'expo-router';

import type { CardConditionHistory, CardRecentSalesRecord } from '@spotlight/api-client';
import { clearCardDetailCache } from '@/features/cards/card-detail-prefetch';
import { CardDetailScreen } from '@/features/cards/screens/card-detail-screen';

import { createTestSpotlightRepository, renderWithProviders } from '../test-utils';

jest.mock('@/lib/observability/posthog', () => ({
  capturePostHogEvent: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

const DAY = 86_400_000;
function isoDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * DAY);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const trendRows = (mode: string) => (mode === 'graded'
  ? [
    { label: 'PSA 10', key: 'PSA|10|normal', currentPrice: 500, currencyCode: 'USD', points: [], trendPct: null },
    { label: 'PSA 9', key: 'PSA|9|normal', currentPrice: 200, currencyCode: 'USD', points: [], trendPct: null },
  ]
  : [
    { label: 'Near Mint', key: 'normal|NM', currentPrice: 12, currencyCode: 'USD', points: [], trendPct: null },
    { label: 'Lightly Played', key: 'normal|LP', currentPrice: 8, currencyCode: 'USD', points: [], trendPct: null },
  ]);

const getCardPriceTrends = jest.fn(async (query: { mode: string }) => ({
  mode: query.mode as 'raw' | 'graded',
  provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
  rows: trendRows(query.mode),
}));

function rawHistory(): CardConditionHistory {
  const points = (values: number[]) => values.map((market, index) => ({
    date: isoDaysAgo(values.length - 1 - index),
    market,
    low: null,
    mid: null,
    high: null,
  }));
  return {
    cardId: 'sm7-1',
    lane: 'raw',
    currencyCode: 'USD',
    series: [
      { key: 'normal|NM', label: 'NM', variantKey: 'normal', condition: 'NM', grader: null, grade: null, points: points([10, 11, 12]) },
      { key: 'normal|LP', label: 'LP', variantKey: 'normal', condition: 'LP', grader: null, grade: null, points: points([9, 8]) },
    ],
  };
}

describe('CardDetailScreen price chart', () => {
  beforeEach(() => {
    (useRouter as jest.Mock).mockReturnValue({ replace: jest.fn(), push: jest.fn(), back: jest.fn() });
  });

  afterEach(() => {
    clearCardDetailCache();
    jest.clearAllMocks();
  });

  it('charts the raw NM series and switches rows from the chip', async () => {
    const getCardConditionHistory = jest.fn(async () => rawHistory());
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends, getCardConditionHistory }),
    });

    expect(await screen.findByTestId('detail-price-chart-chip')).toBeTruthy();
    expect(getCardConditionHistory).toHaveBeenCalledWith({ cardId: 'sm7-1', lane: 'raw', days: 365 });
    expect(screen.getByTestId('detail-price-chart-delta-amount').props.children).toBe('$2.00 (20.00%)');
    // At rest: price + delta only — no range caption, no as-of line (Figma 6322:8976).
    expect(screen.queryByTestId('detail-price-chart-delta-suffix')).toBeNull();
    expect(screen.queryByTestId('detail-price-chart-as-of')).toBeNull();

    fireEvent.press(screen.getByTestId('detail-price-chart-chip'));
    expect(await screen.findByTestId('detail-price-chart-sheet-option-normal|LP-detail')).toBeTruthy();
    fireEvent.press(screen.getByTestId('detail-price-chart-sheet-option-normal|LP'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-price-chart-delta-amount').props.children).toBe('$1.00 (11.11%)');
    });
    // One history read serves every row and range.
    fireEvent.press(screen.getByTestId('detail-price-chart-range-1W'));
    expect(getCardConditionHistory).toHaveBeenCalledTimes(1);
  });

  it('reads graded comps cache-only and goes grey on too few sales', async () => {
    const sales: CardRecentSalesRecord = {
      source: 'ebay',
      status: 'available',
      canRefresh: false,
      saleCount: 2,
      sales: [
        { id: 's1', title: 'PSA 10', soldAt: isoDaysAgo(3), priceAmount: 510, currencyCode: 'USD' },
        { id: 's2', title: 'PSA 10', soldAt: isoDaysAgo(9), priceAmount: 480, currencyCode: 'USD' },
      ],
    };
    const getCardRecentSales = jest.fn(async () => sales);
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends, getCardRecentSales }),
    });

    fireEvent.press(await screen.findByTestId('detail-configurator-grader-PSA'));

    expect(await screen.findByTestId('detail-price-chart-empty')).toBeTruthy();
    expect(getCardRecentSales).toHaveBeenCalledWith({
      cardId: 'sm7-1',
      slabContext: { grader: 'PSA', grade: '10', variantName: 'normal' },
      source: 'ebay',
      limit: 20,
      refresh: false,
    });
    expect(screen.getByText('2 sales in this range. Not enough to call a trend.')).toBeTruthy();
    expect(screen.queryByTestId('detail-price-chart-delta-amount')).toBeNull();
    expect(screen.queryByTestId('detail-price-chart-delta-suffix')).toBeNull();
  });
});
