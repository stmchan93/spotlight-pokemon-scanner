import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as mockApiClient from '../mock-api-client';
import { mockPortfolioDashboard } from '@spotlight/api-client';
import { SpotlightThemeProvider } from '@spotlight/design-system';

import { PortfolioChartCard } from '@/features/portfolio/components/portfolio-chart-card';

jest.mock('@spotlight/api-client', () => mockApiClient);

function buildDateSequence(startDateISO: string, length: number) {
  const dates: string[] = [];
  const cursor = new Date(`${startDateISO}T12:00:00.000Z`);

  for (let index = 0; index < length; index += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

const dashboardWithThousandAxis = {
  ...mockPortfolioDashboard,
  ranges: {
    ...mockPortfolioDashboard.ranges,
    '7D': {
      ...mockPortfolioDashboard.ranges['7D'],
      portfolio: mockPortfolioDashboard.ranges['7D'].portfolio.map((point, index) => ({
        ...point,
        value: [42, 86, 776, 776, 776, 776, 450][index] ?? point.value,
      })),
    },
  },
};

const dashboardWithPredictableDeltas = {
  ...mockPortfolioDashboard,
  summary: {
    currentValue: 999.99,
    changeAmount: 1.23,
    changePercent: 4.56,
    asOfLabel: 'Wrong',
  },
  ranges: {
    ...mockPortfolioDashboard.ranges,
    '7D': {
      ...mockPortfolioDashboard.ranges['7D'],
      portfolio: mockPortfolioDashboard.ranges['7D'].portfolio.map((point, index) => ({
        ...point,
        value: [100, 120, 150, 170, 190, 200, 220][index] ?? point.value,
      })),
    },
    '1M': {
      ...mockPortfolioDashboard.ranges['1M'],
      portfolio: mockPortfolioDashboard.ranges['1M'].portfolio.map((point, index) => ({
        ...point,
        value: [80, 100, 140, 180, 220][index] ?? point.value,
      })),
    },
  },
};

const dashboardWithTrailingZeroSales = {
  ...mockPortfolioDashboard,
  recentSales: [
    {
      ...mockPortfolioDashboard.recentSales[0],
      id: 'trailing-zero-sale-1',
      soldAtISO: '2026-03-21T12:00:00.000Z',
      soldAtLabel: 'Sold on Mar 21, 2026',
      soldPrice: 9,
    },
    {
      ...mockPortfolioDashboard.recentSales[1],
      id: 'trailing-zero-sale-2',
      soldAtISO: '2026-03-21T14:00:00.000Z',
      soldAtLabel: 'Sold on Mar 21, 2026',
      soldPrice: 12,
    },
  ],
  ranges: {
    ...mockPortfolioDashboard.ranges,
    '3M': {
      ...mockPortfolioDashboard.ranges['3M'],
      sales: mockPortfolioDashboard.ranges['3M'].sales.map((point, index) => ({
        ...point,
        value: [0, 4, 21, 0][index] ?? point.value,
      })),
    },
  },
};

const dashboardWithBackendSellCounts = {
  ...mockPortfolioDashboard,
  recentSales: [],
  ranges: {
    ...mockPortfolioDashboard.ranges,
    '1Y': {
      ...mockPortfolioDashboard.ranges['1Y'],
      sales: [
        {
          isoDate: '2026-04-15',
          shortLabel: 'Apr 15',
          value: 0,
          salesCount: 0,
        },
        {
          isoDate: '2026-04-16',
          shortLabel: 'Apr 16',
          value: 534.87,
          salesCount: 13,
        },
        {
          isoDate: '2026-04-17',
          shortLabel: 'Apr 17',
          value: 0,
          salesCount: 0,
        },
      ],
    },
  },
};

const denseMonthlySalesDates = buildDateSequence('2026-03-28', 30);
const denseQuarterlySalesDates = buildDateSequence('2026-01-27', 90);

const dashboardWithDenseSalesRanges = {
  ...mockPortfolioDashboard,
  recentSales: [],
  ranges: {
    ...mockPortfolioDashboard.ranges,
    '1M': {
      ...mockPortfolioDashboard.ranges['1M'],
      sales: denseMonthlySalesDates.map((date, index) => ({
        isoDate: date,
        shortLabel: index === 0 || index === denseMonthlySalesDates.length - 1
          ? new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '')
          : '',
        value: index === denseMonthlySalesDates.length - 1 ? 22 : 0,
        salesCount: index === denseMonthlySalesDates.length - 1 ? 1 : 0,
      })),
    },
    '3M': {
      ...mockPortfolioDashboard.ranges['3M'],
      sales: denseQuarterlySalesDates.map((date, index) => ({
        isoDate: date,
        shortLabel: index === 0 || index === denseQuarterlySalesDates.length - 1
          ? new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '')
          : '',
        value: index === denseQuarterlySalesDates.length - 1 ? 44 : 0,
        salesCount: index === denseQuarterlySalesDates.length - 1 ? 2 : 0,
      })),
    },
  },
};

describe('PortfolioChartCard', () => {
  function Harness({ dashboard = dashboardWithPredictableDeltas }: { dashboard?: typeof mockPortfolioDashboard }) {
    const [chartMode, setChartMode] = useState<'portfolio' | 'sales'>('portfolio');
    const [selectedRange, setSelectedRange] = useState<'7D' | '1M' | '3M' | '1Y' | 'ALL'>('7D');

    return (
      <PortfolioChartCard
        chartMode={chartMode}
        dashboard={dashboard}
        onModeChange={setChartMode}
        onRangeChange={setSelectedRange}
        selectedRange={selectedRange}
      />
    );
  }

  it('renders the current range summary and updates for chart mode and range changes', () => {
    render(
      <SpotlightThemeProvider>
        <Harness />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByText('PORTFOLIO VALUE')).toBeTruthy();
    expect(screen.getByText('$220.00')).toBeTruthy();
    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Apr 21');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('+$120.00 · 120.00%');
    expect(screen.queryByTestId('portfolio-chart-summary-context')).toBeNull();
    expect(screen.getByText('Portfolio')).toBeTruthy();
    expect(screen.getByText('Sales')).toBeTruthy();
    expect(screen.getByText('All')).toBeTruthy();

    fireEvent.press(screen.getByText('Sales'));

    expect(screen.getByText('GROSS SALES')).toBeTruthy();
    expect(screen.getByTestId('portfolio-chart-summary-value').props.children).toBe('$98.10');
    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Apr 15 - Apr 21');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('6 sales');
    expect(screen.queryByTestId('portfolio-chart-summary-context')).toBeNull();
    expect(screen.getByText('$60')).toBeTruthy();
    expect(screen.getByText('$30')).toBeTruthy();
    expect(screen.getByText('$0.00')).toBeTruthy();

    fireEvent.press(screen.getByTestId('range-1M'));

    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Mar 21 - Apr 21');
    expect(screen.getByTestId('portfolio-chart-summary-value').props.children).toBe('$98.10');
  });

  it('recomputes the portfolio summary from the start of the selected range', () => {
    render(
      <SpotlightThemeProvider>
        <Harness />
      </SpotlightThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('range-1M'));

    expect(screen.getByTestId('portfolio-chart-summary-value').props.children).toBe('$220.00');
    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Apr 21');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('+$140.00 · 175.00%');
  });

  it('uses the first positive point as the percent baseline when the range starts at zero', () => {
    render(
      <SpotlightThemeProvider>
        <PortfolioChartCard
          chartMode="portfolio"
          dashboard={mockPortfolioDashboard}
          onModeChange={() => {}}
          onRangeChange={() => {}}
          selectedRange="7D"
        />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('+$112.20 · 136.15%');
  });

  it('keeps larger portfolio axis labels readable on one line', () => {
    render(
      <SpotlightThemeProvider>
        <PortfolioChartCard
          chartMode="portfolio"
          dashboard={dashboardWithThousandAxis}
          onModeChange={() => {}}
          onRangeChange={() => {}}
          selectedRange="7D"
        />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByText('$776')).toBeTruthy();
    expect(screen.getByText('$388')).toBeTruthy();
  });

  it('updates the fixed summary header while scrubbing both chart modes without a floating tooltip', () => {
    render(
      <SpotlightThemeProvider>
        <Harness />
      </SpotlightThemeProvider>,
    );

    fireEvent(screen.getByTestId('portfolio-chart-portfolio'), 'layout', {
      nativeEvent: {
        layout: {
          height: 236,
          width: 320,
        },
      },
    });

    fireEvent(screen.getByTestId('portfolio-chart-touch-target'), 'responderGrant', {
      nativeEvent: {
        locationX: 94,
      },
    });

    expect(screen.queryByTestId('portfolio-chart-tooltip')).toBeNull();
    expect(screen.getByText('$150.00')).toBeTruthy();
    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Apr 17');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('+$50.00 · 50.00%');

    fireEvent.press(screen.getByText('Sales'));

    fireEvent(screen.getByTestId('portfolio-chart-sales'), 'layout', {
      nativeEvent: {
        layout: {
          height: 236,
          width: 320,
        },
      },
    });

    fireEvent(screen.getByTestId('portfolio-chart-touch-target'), 'responderGrant', {
      nativeEvent: {
        locationX: 94,
      },
    });

    expect(screen.queryByTestId('portfolio-chart-tooltip')).toBeNull();
    expect(screen.getByTestId('portfolio-chart-summary-value').props.children).toBe('$0.00');
    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Apr 17');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('No sales');
  });

  it('defaults sales mode to the total selected-range revenue when the range ends on a zero-sales day', () => {
    render(
      <SpotlightThemeProvider>
        <PortfolioChartCard
          chartMode="sales"
          dashboard={dashboardWithTrailingZeroSales}
          onModeChange={() => {}}
          onRangeChange={() => {}}
          selectedRange="3M"
        />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByTestId('portfolio-chart-summary-value').props.children).toBe('$25.00');
    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Jan 21 - Apr 21');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('2 sales');
  });

  it('uses backend sell counts for sales summaries and hovered points', () => {
    render(
      <SpotlightThemeProvider>
        <PortfolioChartCard
          chartMode="sales"
          dashboard={dashboardWithBackendSellCounts}
          onModeChange={() => {}}
          onRangeChange={() => {}}
          selectedRange="1Y"
        />
      </SpotlightThemeProvider>,
    );

    expect(screen.getByTestId('portfolio-chart-summary-value').props.children).toBe('$534.87');
    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Apr 15 - Apr 17');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('13 sales');

    fireEvent(screen.getByTestId('portfolio-chart-sales'), 'layout', {
      nativeEvent: {
        layout: {
          height: 236,
          width: 320,
        },
      },
    });

    fireEvent(screen.getByTestId('portfolio-chart-touch-target'), 'responderGrant', {
      nativeEvent: {
        locationX: 132,
      },
    });

    expect(screen.getByTestId('portfolio-chart-summary-value').props.children).toBe('$534.87');
    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Apr 16');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('13 sales');
  });

  it('keeps dense 1M and 3M sales bars inside the chart so the right edge reaches the last bucket', () => {
    function SalesHarness() {
      const [selectedRange, setSelectedRange] = useState<'7D' | '1M' | '3M' | '1Y' | 'ALL'>('1M');

      return (
        <PortfolioChartCard
          chartMode="sales"
          dashboard={dashboardWithDenseSalesRanges}
          onModeChange={() => {}}
          onRangeChange={setSelectedRange}
          selectedRange={selectedRange}
        />
      );
    }

    render(
      <SpotlightThemeProvider>
        <SalesHarness />
      </SpotlightThemeProvider>,
    );

    fireEvent(screen.getByTestId('portfolio-chart-sales'), 'layout', {
      nativeEvent: {
        layout: {
          height: 236,
          width: 320,
        },
      },
    });

    fireEvent(screen.getByTestId('portfolio-chart-touch-target'), 'responderGrant', {
      nativeEvent: {
        locationX: 264,
      },
    });

    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Apr 26');
    expect(screen.getByTestId('portfolio-chart-summary-value').props.children).toBe('$22.00');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('1 sale');

    fireEvent.press(screen.getByTestId('range-3M'));

    fireEvent(screen.getByTestId('portfolio-chart-sales'), 'layout', {
      nativeEvent: {
        layout: {
          height: 236,
          width: 320,
        },
      },
    });

    fireEvent(screen.getByTestId('portfolio-chart-touch-target'), 'responderGrant', {
      nativeEvent: {
        locationX: 264,
      },
    });

    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Apr 26');
    expect(screen.getByTestId('portfolio-chart-summary-value').props.children).toBe('$44.00');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('2 sales');
  });

  it('uses the first positive point while scrubbing a zero-start portfolio range', () => {
    render(
      <SpotlightThemeProvider>
        <PortfolioChartCard
          chartMode="portfolio"
          dashboard={mockPortfolioDashboard}
          onModeChange={() => {}}
          onRangeChange={() => {}}
          selectedRange="7D"
        />
      </SpotlightThemeProvider>,
    );

    fireEvent(screen.getByTestId('portfolio-chart-portfolio'), 'layout', {
      nativeEvent: {
        layout: {
          height: 236,
          width: 320,
        },
      },
    });

    fireEvent(screen.getByTestId('portfolio-chart-touch-target'), 'responderGrant', {
      nativeEvent: {
        locationX: 94,
      },
    });

    expect(screen.getByTestId('portfolio-chart-summary-date').props.children).toBe('Apr 17');
    expect(screen.getByTestId('portfolio-chart-summary-detail').props.children).toBe('+$62.70 · 76.08%');
  });
});
