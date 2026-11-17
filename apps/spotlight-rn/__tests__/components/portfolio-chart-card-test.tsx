import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import * as mockApiClient from '../mock-api-client';
import { mockPortfolioDashboard } from '@spotlight/api-client';
import { SpotlightThemeProvider } from '@spotlight/design-system';

import {
  PortfolioChartCard,
  portfolioLineYDomain,
  portfolioRangeSummaryAfterWarmup,
  trimPortfolioWarmup,
} from '@/features/portfolio/components/portfolio-chart-card';

jest.mock('@spotlight/api-client', () => mockApiClient);

function scrub(xs: number[], gesture: 'drag' | 'hold' = 'drag') {
  act(() => {
    fireGestureHandler(getByGestureTestId(`portfolio-price-chart-${gesture}`), [
      { state: State.BEGAN, x: xs[0] },
      { state: State.ACTIVE, x: xs[0] },
      ...xs.slice(1).map((x) => ({ x })),
      { state: State.END, x: xs[xs.length - 1] },
    ]);
  });
}

// Portfolio mode draws through the PDP's PriceScrubChart, which measures itself.
function layoutChart() {
  fireEvent(screen.getByTestId('portfolio-price-chart'), 'layout', { nativeEvent: { layout: { width: 320, height: 200 } } });
}

function renderChart(overrides: Partial<React.ComponentProps<typeof PortfolioChartCard>> = {}) {
  const onRangeChange = jest.fn();
  const onActivePointChange = jest.fn();

  const props: React.ComponentProps<typeof PortfolioChartCard> = {
    chartMode: 'portfolio',
    dashboard: mockPortfolioDashboard,
    selectedRange: '1W',
    onRangeChange,
    onActivePointChange,
    ...overrides,
  };

  const result = render(
    <SpotlightThemeProvider>
      <PortfolioChartCard {...props} />
    </SpotlightThemeProvider>,
  );

  return { ...result, onRangeChange, onActivePointChange };
}

describe('PortfolioChartCard', () => {
  it('renders the chart in portfolio mode and exposes the new range pills', () => {
    renderChart();

    expect(screen.getByTestId('portfolio-chart-portfolio')).toBeTruthy();
    ['1W', '1M', '3M', '1Y', 'ALL'].forEach((range) => {
      expect(screen.getByTestId(`range-${range}`)).toBeTruthy();
    });
  });

  it('renders the sales bars when chart mode is sales', () => {
    renderChart({ chartMode: 'sales' });

    expect(screen.getByTestId('portfolio-chart-sales')).toBeTruthy();
  });

  it('calls onRangeChange when a different pill is pressed', () => {
    const { onRangeChange } = renderChart();

    fireEvent.press(screen.getByTestId('range-3M'));

    expect(onRangeChange).toHaveBeenCalledWith('3M');
  });

  it('draws the purple gradient + grid fill under the portfolio line', () => {
    renderChart();
    layoutChart();
    expect(screen.getByTestId('portfolio-price-chart-fill')).toBeTruthy();
  });

  it('draws no positioning dot on the line at rest', () => {
    renderChart();
    layoutChart();
    expect(screen.getByTestId('portfolio-price-chart-canvas')).toBeTruthy();
    expect(screen.queryByTestId('portfolio-price-chart-dot')).toBeNull();
  });

  it('emits onActivePointChange while the user scrubs the chart', () => {
    const { onActivePointChange } = renderChart();

    // The chart only mounts the gesture target after it gets a non-zero width.
    layoutChart();
    scrub([20, 160, 300]);

    const calls = onActivePointChange.mock.calls;
    const lastNonNullCall = [...calls].reverse().find(([arg]) => arg !== null);
    expect(lastNonNullCall).toBeDefined();
    expect(lastNonNullCall?.[0]).toEqual(
      expect.objectContaining({
        isHovering: true,
        dateLabel: expect.any(String),
        valueLabel: expect.any(String),
        changeAmountLabel: expect.any(String),
      }),
    );
    // Lift-off clears the header back to the resting value.
    expect(onActivePointChange).toHaveBeenLastCalledWith(null);
  });

  it('locks the pager/scroll for the whole scrub, from a drag or a still press', () => {
    const onScrubLockChange = jest.fn();
    renderChart({ onScrubLockChange });
    layoutChart();

    scrub([160, 200]);
    expect(onScrubLockChange.mock.calls.map((call) => call[0])).toEqual([true, false]);

    scrub([160], 'hold');
    expect(onScrubLockChange.mock.calls.map((call) => call[0])).toEqual([true, false, true, false]);
  });

  it('resets the parent and scrub-lock if it unmounts mid-scrub', () => {
    // Regression: a chart that unmounts while scrubbing (tab switch, error
    // swap) used to strand the parent on the last hovered point — e.g. a
    // $0.00 baseline — so the portfolio value got stuck at 0 until restart.
    const onScrubLockChange = jest.fn();
    let unmountChart: () => void = () => {};
    let unmounted = false;
    const onActivePointChange = jest.fn((active: unknown) => {
      // Unmount from INSIDE the gesture, the moment a point is first active.
      if (active && !unmounted) {
        unmounted = true;
        unmountChart();
      }
    });
    const { unmount } = renderChart({ onActivePointChange, onScrubLockChange });
    unmountChart = unmount;
    layoutChart();

    scrub([160, 200, 240]);

    expect(unmounted).toBe(true);
    expect(onScrubLockChange).toHaveBeenCalledWith(true);
    // Unmount cleanup must clear both so neither outlives the gesture.
    expect(onScrubLockChange).toHaveBeenLastCalledWith(false);
    expect(onActivePointChange).toHaveBeenLastCalledWith(null);
  });

  it('leaves no tooltip and brings the range row back after a scrub', () => {
    renderChart();
    layoutChart();

    // No active point yet → no tooltip, range row visible.
    expect(screen.queryByTestId('portfolio-chart-tooltip')).toBeNull();
    expect(screen.getByTestId('range-1W')).toBeTruthy();

    scrub([160, 220]);

    expect(screen.queryByTestId('portfolio-chart-tooltip')).toBeNull();
    expect(screen.getByTestId('range-1W')).toBeTruthy();
  });

  // The buy-marker (add-day dots) feature was removed entirely (2026-07-18):
  // even points that carry addedCount/addedValue from the backend rollup must
  // render no dots.
  it('renders no add-day markers even when points carry adds', () => {
    const pointsWithAdds = [
      { isoDate: '2026-03-21', shortLabel: 'Mar 21', value: 4, addedCount: 3, addedValue: 210 },
      { isoDate: '2026-04-04', shortLabel: 'Apr 4', value: 88, addedCount: 1, addedValue: 5 },
      { isoDate: '2026-04-21', shortLabel: 'Apr 21', value: 194.61, addedCount: 0, addedValue: 0 },
    ];
    const dashboardWithAdds = {
      ...mockPortfolioDashboard,
      ranges: {
        ...mockPortfolioDashboard.ranges,
        '1M': { ...mockPortfolioDashboard.ranges['1M'], portfolio: pointsWithAdds },
      },
    };

    renderChart({ dashboard: dashboardWithAdds, selectedRange: '1M' });
    const chartContainer = screen.getByTestId('portfolio-chart-portfolio');
    fireEvent(chartContainer, 'layout', { nativeEvent: { layout: { width: 320, height: 200 } } });

    expect(screen.queryByTestId('portfolio-chart-add-markers')).toBeNull();
  });

  it('shows the skeleton when loading and no series points are available', () => {
    const emptyDashboard = {
      ...mockPortfolioDashboard,
      ranges: {
        ...mockPortfolioDashboard.ranges,
        '1W': { portfolio: [], sales: [] },
      },
    };

    renderChart({ dashboard: emptyDashboard, isLoading: true });

    expect(screen.getByTestId('portfolio-chart-skeleton')).toBeTruthy();
  });
});

describe('portfolioLineYDomain', () => {
  it('keeps a 3% dip to about a third of the chart instead of the full height', () => {
    const { min, max } = portfolioLineYDomain([1730, 1720, 1690, 1680]);
    expect((1730 - 1680) / (max - min)).toBeCloseTo(50 / (1730 * 0.08), 5);
    expect(min).toBeLessThan(1680);
    expect(max).toBeGreaterThan(1730);
  });

  it('still fills the chart for a large move, with headroom', () => {
    const { min, max } = portfolioLineYDomain([1000, 1500]);
    expect(max - min).toBeCloseTo(600, 5);
  });

  it('centers a flat line', () => {
    const { min, max } = portfolioLineYDomain([100, 100]);
    expect((min + max) / 2).toBe(100);
    expect(max - min).toBeGreaterThan(0);
  });
});

describe('portfolio warm-up trim', () => {
  // Staging account shape: a few cards, a partial add, then the bulk add.
  const points = [{ value: 18 }, { value: 46 }, { value: 534 }, { value: 2900 }, { value: 2950 }, { value: 2971 }];

  it('starts the line on the last day the value doubled', () => {
    expect(trimPortfolioWarmup(points).map((p) => p.value)).toEqual([2900, 2950, 2971]);
  });

  it('never cuts gradual growth', () => {
    const gradual = [1000, 1300, 1700, 2200, 2900].map((value) => ({ value }));
    expect(trimPortfolioWarmup(gradual)).toHaveLength(5);
  });

  it('keeps at least two points when the jump is the newest day', () => {
    expect(trimPortfolioWarmup([{ value: 10 }, { value: 12 }, { value: 500 }])).toHaveLength(3);
  });

  it('leaves a series with no warm-up untouched', () => {
    expect(trimPortfolioWarmup([{ value: 900 }, { value: 1000 }])).toHaveLength(2);
  });

  it('re-bases the range change onto the first plotted day', () => {
    const summary = { currentValue: 2971, startValue: 18, changeAmount: 2953, changePercent: 16405.56 };
    expect(portfolioRangeSummaryAfterWarmup(points, summary)).toEqual({
      currentValue: 2971,
      startValue: 2900,
      changeAmount: 71,
      changePercent: 2.45,
    });
  });
});
