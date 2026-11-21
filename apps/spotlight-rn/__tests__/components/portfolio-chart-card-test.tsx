import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import * as mockApiClient from '../mock-api-client';
import { mockPortfolioDashboard } from '@spotlight/api-client';
import { SpotlightThemeProvider } from '@spotlight/design-system';

import {
  PortfolioChartCard,
  portfolioChangePercent,
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

// The owner's history (2026-11-21), pre backend fix: near-empty start, a real
// climb, a bad $422K plateau 7/11–8/06, real $6.5K → $13K, then a live $427K spike.
function ownerSeries({ plateauContinues = false } = {}) {
  const DAY = 86400000;
  const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
  const lerp = (t: number, from: string, to: string, a: number, b: number) =>
    a + ((t - at(from)) / (at(to) - at(from))) * (b - a);
  const points: { isoDate: string; value: number }[] = [];
  for (let t = at('2026-04-29'); t <= at('2026-11-21'); t += DAY) {
    let value: number;
    if (t < at('2026-05-30')) value = 1.68 + (t - at('2026-04-29')) / DAY * 20;
    else if (t < at('2026-06-24')) value = lerp(t, '2026-05-30', '2026-06-24', 1900, 10700);
    else if (t < at('2026-07-11')) value = 10700;
    else if (plateauContinues) value = lerp(t, '2026-07-11', '2026-11-21', 422000, 427000);
    else if (t <= at('2026-08-06')) value = 422000;
    else if (t < at('2026-11-21')) value = lerp(t, '2026-08-07', '2026-11-20', 6500, 13000);
    else value = 427000;
    points.push({ isoDate: new Date(t).toISOString().slice(0, 10), value: Math.round(value * 100) / 100 });
  }
  return points;
}

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

  it('clamps a one-day spike instead of letting it set the scale', () => {
    const week = [12700, 12750, 12800, 12850, 12900, 12950, 13000, 427000];
    const { min, max } = portfolioLineYDomain(week);
    expect(max).toBeLessThan(15000);
    expect(min).toBeGreaterThan(11500);
  });

  it('fits the real history and clamps the bad plateau and spike (owner ALL range)', () => {
    const plotted = trimPortfolioWarmup(ownerSeries());
    const { min, max } = portfolioLineYDomain(plotted.map((p) => p.value));
    // The real $1.9K–$13K history fills the plot (with headroom)...
    expect(min).toBeLessThanOrEqual(1900);
    expect(max).toBeGreaterThanOrEqual(13000);
    expect((13000 - 1900) / (max - min)).toBeGreaterThan(0.8);
    // ...and the $422K/$427K days sit clamped above it.
    expect(max).toBeLessThan(422000);
  });

  it('fits a plateau that is real (post backend fix)', () => {
    const plotted = trimPortfolioWarmup(ownerSeries({ plateauContinues: true }));
    const { min, max } = portfolioLineYDomain(plotted.map((p) => p.value));
    expect(min).toBeLessThanOrEqual(422000);
    expect(max).toBeGreaterThanOrEqual(427000);
    expect(max - min).toBeLessThan(427000 * 0.1);
  });

  it('never clamps a real recent jump', () => {
    const values = [2000, 2000, 2000, 2000, 2000, 10000, 10000];
    const { max } = portfolioLineYDomain(values);
    expect(max).toBeGreaterThanOrEqual(10000);
  });
});

describe('portfolio warm-up trim', () => {
  // Staging account shape: a few cards, a partial add, then the bulk add.
  const points = [{ value: 18 }, { value: 46 }, { value: 534 }, { value: 2900 }, { value: 2950 }, { value: 2971 }];

  it('starts the line on the first day at 10% of the latest value', () => {
    expect(trimPortfolioWarmup(points).map((p) => p.value)).toEqual([534, 2900, 2950, 2971]);
  });

  it('skips the near-empty weeks of the owner history, ignoring the final spike', () => {
    const plotted = trimPortfolioWarmup(ownerSeries());
    expect(plotted[0]).toEqual({ isoDate: '2026-05-30', value: 1900 });
  });

  it('starts at the plateau when the plateau is the real value (post backend fix)', () => {
    expect(trimPortfolioWarmup(ownerSeries({ plateauContinues: true }))[0].isoDate).toBe('2026-07-11');
  });

  it('never cuts gradual growth', () => {
    const gradual = [1000, 1300, 1700, 2200, 2900].map((value) => ({ value }));
    expect(trimPortfolioWarmup(gradual)).toHaveLength(5);
  });

  it('keeps at least two points', () => {
    expect(trimPortfolioWarmup([{ value: 1 }, { value: 2 }, { value: 500 }, { value: 500 }])).toHaveLength(2);
    expect(trimPortfolioWarmup([{ value: 10 }, { value: 500 }])).toHaveLength(2);
  });

  it('leaves a series with no warm-up untouched', () => {
    expect(trimPortfolioWarmup([{ value: 900 }, { value: 1000 }])).toHaveLength(2);
  });

  it('re-bases the range change onto the first plotted day', () => {
    const summary = { currentValue: 2971, startValue: 18, changeAmount: 2953, changePercent: 16405.56 };
    expect(portfolioRangeSummaryAfterWarmup(points, summary)).toEqual({
      currentValue: 2971,
      startValue: 534,
      changeAmount: 2437,
      changePercent: 456.37,
    });
  });
});

describe('portfolio change percent', () => {
  it('hides the percent on a $1.68 baseline against $13K', () => {
    expect(portfolioChangePercent(1.68, 13000 - 1.68, 13000)).toBeNull();
  });

  it('shows the percent on a $5K baseline against $13K', () => {
    expect(portfolioChangePercent(5000, 8000, 13000)).toBe(160);
  });

  it('hides the percent under the $100 floor and under 5% of the current value', () => {
    expect(portfolioChangePercent(99, 1, 100)).toBeNull();
    expect(portfolioChangePercent(600, 12400, 13000)).toBeNull();
    expect(portfolioChangePercent(650, 12350, 13000)).toBe(1900);
  });

  it('keeps a server-hidden percent hidden and hides one the server should have', () => {
    const untrimmed = [{ value: 900 }, { value: 1000 }];
    const hidden = { currentValue: 1000, startValue: 900, changeAmount: 100, changePercent: null };
    expect(portfolioRangeSummaryAfterWarmup(untrimmed, hidden)?.changePercent).toBeNull();
    const tiny = { currentValue: 1000, startValue: 40, changeAmount: 960, changePercent: 2400 };
    expect(portfolioRangeSummaryAfterWarmup([{ value: 40 }, { value: 1000 }], tiny)?.changePercent).toBeNull();
  });

  it('hides the re-based percent of the owner history only when the start is too small', () => {
    const series = ownerSeries();
    const summary = { currentValue: 427000, startValue: 1.68, changeAmount: 13000 - 1.68, changePercent: null };
    const rebased = portfolioRangeSummaryAfterWarmup(series, summary);
    expect(rebased?.startValue).toBe(1900);
    expect(rebased?.changeAmount).toBe(11100);
    // $1,900 ≥ max($100, 5% × $13,000) → shown.
    expect(rebased?.changePercent).toBe(584.21);
  });
});
