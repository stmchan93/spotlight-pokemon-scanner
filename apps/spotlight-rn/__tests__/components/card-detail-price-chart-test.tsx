import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Linking } from 'react-native';
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
    // Figma 6322:8976: amount and percent are separate runs.
    expect(screen.getByTestId('detail-price-chart-delta-amount').props.children).toBe('$2.00');
    expect(screen.getByTestId('detail-price-chart-delta-percent').props.children).toBe('(20.00%)');
    // At rest: price + delta only — no range caption, no as-of line (Figma 6322:8976).
    expect(screen.queryByTestId('detail-price-chart-delta-suffix')).toBeNull();
    expect(screen.queryByTestId('detail-price-chart-as-of')).toBeNull();

    fireEvent.press(screen.getByTestId('detail-price-chart-chip'));
    expect(await screen.findByTestId('detail-price-chart-sheet-option-normal|LP-detail')).toBeTruthy();
    fireEvent.press(screen.getByTestId('detail-price-chart-sheet-option-normal|LP'));

    await waitFor(() => {
      expect(screen.getByTestId('detail-price-chart-delta-amount').props.children).toBe('$1.00');
    });
    // One history read serves every row and range.
    fireEvent.press(screen.getByTestId('detail-price-chart-range-1W'));
    expect(getCardConditionHistory).toHaveBeenCalledTimes(1);
  });

  it('shows the charted row\'s price one-liner and follows the picked row', async () => {
    const getCardConditionHistory = jest.fn(async () => rawHistory());
    const getCardPriceTrendsWithInsight = jest.fn(async (query: { mode: string }) => ({
      mode: query.mode as 'raw' | 'graded',
      provider: (query.mode === 'graded' ? 'ebay' : 'tcgplayer') as 'ebay' | 'tcgplayer',
      rows: trendRows(query.mode).map((row) => (row.key === 'normal|NM'
        ? {
          ...row,
          insight: {
            text: 'Up 18% in 30 days · near its 90-day high',
            facts: [{ kind: 'change_30d' as const, value: 18 }, { kind: 'high_90d' as const, value: 12 }],
          },
        }
        : { ...row, insight: null })),
    }));
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({
        getCardPriceTrends: getCardPriceTrendsWithInsight,
        getCardConditionHistory,
      }),
    });

    const line = await screen.findByTestId('detail-price-insight');
    expect(line.props.children).toBe('Up 18% in 30 days · near its 90-day high');
    expect(within(screen.getByTestId('detail-price-chart')).getByTestId('detail-price-insight')).toBeTruthy();

    // LP has nothing notable: the line goes away, leaving no gap.
    fireEvent.press(screen.getByTestId('detail-price-chart-chip'));
    fireEvent.press(await screen.findByTestId('detail-price-chart-sheet-option-normal|LP'));
    await waitFor(() => expect(screen.queryByTestId('detail-price-insight')).not.toBeOnTheScreen());
  });

  it('renders no one-liner when the rows carry none', async () => {
    const getCardConditionHistory = jest.fn(async () => rawHistory());
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends, getCardConditionHistory }),
    });
    expect(await screen.findByTestId('detail-price-chart-chip')).toBeTruthy();
    expect(screen.queryByTestId('detail-price-insight')).toBeNull();
  });

  it('draws the line with no end dot at rest', async () => {
    const getCardConditionHistory = jest.fn(async () => rawHistory());
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends, getCardConditionHistory }),
    });

    const chart = await screen.findByTestId('detail-price-chart-chart');
    fireEvent(chart, 'layout', { nativeEvent: { layout: { width: 300, height: 200, x: 0, y: 0 } } });
    expect(await screen.findByTestId('detail-price-chart-chart-canvas')).toBeTruthy();
    // The dot only appears under the finger while scrubbing.
    expect(screen.queryByTestId('detail-price-chart-chart-dot')).toBeNull();
  });

  it('switches Raw → PSA from the grader chip beside the row chip', async () => {
    const getCardConditionHistory = jest.fn(async () => rawHistory());
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends, getCardConditionHistory }),
    });

    const graderChip = await screen.findByTestId('detail-price-chart-grader-chip');
    expect(within(graderChip).getByText('RAW')).toBeTruthy();
    expect(within(screen.getByTestId('detail-price-chart-chip')).getByText('NEAR MINT')).toBeTruthy();

    fireEvent.press(graderChip);
    fireEvent.press(await screen.findByTestId('detail-price-chart-grader-sheet-option-PSA'));

    await waitFor(() => {
      expect(getCardPriceTrends).toHaveBeenCalledWith(expect.objectContaining({ mode: 'graded', grader: 'PSA' }));
    });
    // The grader chip names the company, so the row chip drops it: "PSA 10" → "10".
    await waitFor(() => {
      expect(within(screen.getByTestId('detail-price-chart-grader-chip')).getByText('PSA')).toBeTruthy();
      expect(within(screen.getByTestId('detail-price-chart-chip')).getByText('10')).toBeTruthy();
    });
  });

  it('the condition chip only opens the picker; the TCGplayer logo is the one link', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const getCardConditionHistory = jest.fn(async () => rawHistory());
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends, getCardConditionHistory }),
    });

    fireEvent.press(await screen.findByTestId('detail-price-chart-chip'));
    expect(await screen.findByTestId('detail-price-chart-sheet-option-normal|LP')).toBeTruthy();
    expect(openURL).not.toHaveBeenCalled();

    // Picking a row keeps the chart (and the closing sheet) mounted: no
    // skeleton swap that tears the Modal down under the finger.
    fireEvent.press(screen.getByTestId('detail-price-chart-sheet-option-normal|LP'));
    expect(screen.queryByTestId('detail-price-chart-skeleton')).toBeNull();
    expect(screen.getByTestId('detail-price-chart-sheet')).toBeTruthy();
    expect(openURL).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('detail-price-chart-delta-amount').props.children).toBe('$1.00');
    });

    // The logo opens TCGplayer for the CHARTED condition.
    fireEvent.press(screen.getByTestId('detail-price-chart-tcgplayer'));
    expect(openURL).toHaveBeenCalledTimes(1);
    const url = String(openURL.mock.calls[0][0]);
    expect(url).toContain('tcgplayer.com');
    expect(url).toContain('Lightly+Played');
    openURL.mockRestore();
  });

  it('puts the TCGplayer logo beside the price when there is no price change', async () => {
    const flatOnePoint = rawHistory();
    flatOnePoint.series[0] = { ...flatOnePoint.series[0]!, points: [flatOnePoint.series[0]!.points.at(-1)!] };
    const getCardConditionHistory = jest.fn(async () => flatOnePoint);
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends, getCardConditionHistory }),
    });

    const priceRow = await screen.findByTestId('detail-price-chart-price-row');
    await waitFor(() => expect(screen.queryByTestId('detail-price-chart-delta-amount')).not.toBeOnTheScreen());
    expect(within(priceRow).getByTestId('detail-price-chart-tcgplayer')).toBeTruthy();
  });

  it('keeps the TCGplayer logo on the price-change line when there is one', async () => {
    const getCardConditionHistory = jest.fn(async () => rawHistory());
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends, getCardConditionHistory }),
    });
    const delta = await screen.findByTestId('detail-price-chart-delta');
    await waitFor(() => expect(within(delta).getByTestId('detail-price-chart-tcgplayer')).toBeTruthy());
    expect(within(screen.getByTestId('detail-price-chart-price-row')).queryByTestId('detail-price-chart-tcgplayer')).toBeNull();
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

    fireEvent.press(await screen.findByTestId('detail-price-chart-grader-chip'));
    fireEvent.press(await screen.findByTestId('detail-price-chart-grader-sheet-option-PSA'));

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
    // Graded comps have no exact TCGplayer page: no logo link.
    expect(screen.queryByTestId('detail-price-chart-tcgplayer')).toBeNull();
    // Viewing the graded lane spends nothing: only the cache-only read ran.
    const calls = getCardRecentSales.mock.calls as unknown as [{ refresh?: boolean }][];
    expect(calls.filter(([query]) => query.refresh === true)).toHaveLength(0);
  });

  it('a PRICES raw row opens TCGplayer and leaves the chart on its condition', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const getCardConditionHistory = jest.fn(async () => rawHistory());
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends, getCardConditionHistory }),
    });

    expect(within(await screen.findByTestId('detail-price-chart-chip')).getByText('NEAR MINT')).toBeTruthy();
    fireEvent.press(await screen.findByTestId('detail-prices-conditions-toggle'));
    fireEvent.press(screen.getByTestId('detail-prices-raw-LP'));

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL.mock.calls[0]![0]).toContain('Condition=Lightly+Played');
    expect(within(screen.getByTestId('detail-price-chart-chip')).getByText('NEAR MINT')).toBeTruthy();
    // Raw rows no longer collapse the toggle away.
    expect(screen.getByTestId('detail-prices-conditions-toggle')).toHaveTextContent('Show less');
    openURL.mockRestore();
  });

  it('a raw row tapped from the graded lane opens TCGplayer and keeps the graded chart', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const getCardConditionHistory = jest.fn(async () => rawHistory());
    renderWithProviders(<CardDetailScreen cardId="sm7-1" onBack={jest.fn()} />, {
      spotlightRepository: createTestSpotlightRepository({ getCardPriceTrends, getCardConditionHistory }),
    });

    fireEvent.press(await screen.findByTestId('detail-price-chart-grader-chip'));
    fireEvent.press(await screen.findByTestId('detail-price-chart-grader-sheet-option-PSA'));
    await waitFor(() => {
      expect(within(screen.getByTestId('detail-price-chart-grader-chip')).getByText('PSA')).toBeTruthy();
    });
    // Raw rows stay listed in the graded lane (read from the raw lane).
    fireEvent.press(await screen.findByTestId('detail-prices-conditions-toggle'));
    fireEvent.press(await screen.findByTestId('detail-prices-raw-LP'));

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL.mock.calls[0]![0]).toContain('Condition=Lightly+Played');
    expect(within(screen.getByTestId('detail-price-chart-grader-chip')).getByText('PSA')).toBeTruthy();
    openURL.mockRestore();
  });
});
