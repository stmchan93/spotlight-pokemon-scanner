import { fireEvent, render, screen } from '@testing-library/react-native';
import * as mockApiClient from '../mock-api-client';
import { mockPortfolioDashboard } from '@spotlight/api-client';
import { SpotlightThemeProvider } from '@spotlight/design-system';

import { PortfolioChartCard } from '@/features/portfolio/components/portfolio-chart-card';

jest.mock('@spotlight/api-client', () => mockApiClient);

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

  it('emits onActivePointChange while the user scrubs the chart', () => {
    const { onActivePointChange } = renderChart();

    // The chart only mounts the touch-target after it gets a non-zero width
    // from onLayout — fire that on the chart container first.
    const chartContainer = screen.getByTestId('portfolio-chart-portfolio');
    fireEvent(chartContainer, 'layout', { nativeEvent: { layout: { width: 320, height: 200 } } });

    const touchTarget = screen.getByTestId('portfolio-chart-touch-target');
    fireEvent(touchTarget, 'responderGrant', { nativeEvent: { locationX: 160 } });

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

  });

  it('resets the parent and scrub-lock if it unmounts mid-scrub', () => {
    // Regression: a chart that unmounts while scrubbing (tab switch, error
    // swap) used to strand the parent on the last hovered point — e.g. a
    // $0.00 baseline — so the portfolio value got stuck at 0 until restart.
    const onScrubLockChange = jest.fn();
    const { onActivePointChange, unmount } = renderChart({ onScrubLockChange });

    const chartContainer = screen.getByTestId('portfolio-chart-portfolio');
    fireEvent(chartContainer, 'layout', { nativeEvent: { layout: { width: 320, height: 200 } } });

    const touchTarget = screen.getByTestId('portfolio-chart-touch-target');
    fireEvent(touchTarget, 'responderGrant', { nativeEvent: { locationX: 160 } });

    // Mid-scrub: a point is active and the scrub-lock is engaged.
    expect(onScrubLockChange).toHaveBeenLastCalledWith(true);

    unmount();

    // Unmount cleanup must clear both so neither outlives the gesture.
    expect(onScrubLockChange).toHaveBeenLastCalledWith(false);
    expect(onActivePointChange).toHaveBeenLastCalledWith(null);
  });

  it('shows the date/value tooltip and hides the range row while scrubbing', () => {
    renderChart();

    const chartContainer = screen.getByTestId('portfolio-chart-portfolio');
    fireEvent(chartContainer, 'layout', { nativeEvent: { layout: { width: 320, height: 200 } } });

    // No active point yet → no tooltip, range row visible.
    expect(screen.queryByTestId('portfolio-chart-tooltip')).toBeNull();
    expect(screen.getByTestId('range-1W')).toBeTruthy();

    const touchTarget = screen.getByTestId('portfolio-chart-touch-target');
    fireEvent(touchTarget, 'responderGrant', { nativeEvent: { locationX: 160 } });

    const tooltip = screen.getByTestId('portfolio-chart-tooltip');
    expect(tooltip).toBeTruthy();
    // Date headline matches the "JAN, 1, 2026" Figma format.
    expect(screen.getByText(/^[A-Z]{3}, \d{1,2}, \d{4}$/)).toBeTruthy();

    // Releasing clears the tooltip.
    fireEvent(touchTarget, 'responderRelease', { nativeEvent: { locationX: 160 } });
    expect(screen.queryByTestId('portfolio-chart-tooltip')).toBeNull();
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
