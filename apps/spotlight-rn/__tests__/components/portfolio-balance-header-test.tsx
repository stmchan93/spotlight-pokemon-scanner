import { render, screen } from '@testing-library/react-native';

import { SpotlightThemeProvider } from '@spotlight/design-system';

import { PortfolioBalanceHeader } from '@/features/portfolio/components/portfolio-balance-header';
import type { PortfolioChartActivePoint } from '@/features/portfolio/components/portfolio-chart-card';

// RollingNumberText is a slot-machine display (each digit is a column rendering
// 0-9), so its text content isn't the literal value. Swap it for a plain Text so
// tests can assert the displayed portfolio value directly.
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

const summary = {
  currentValue: 194.61,
  changeAmount: 12.4,
  changePercent: 6.8,
  asOfLabel: 'Apr 21',
};

function buildActivePoint(overrides: Partial<PortfolioChartActivePoint> = {}): PortfolioChartActivePoint {
  return {
    valueLabel: '$128.00',
    dateLabel: 'April 11, 2026',
    changeAmount: 124,
    changePercent: 31,
    changeAmountLabel: '+$124.00',
    changePercentLabel: '+31.00%',
    isHovering: true,
    ...overrides,
  };
}

function renderHeader(props: Partial<React.ComponentProps<typeof PortfolioBalanceHeader>> = {}) {
  return render(
    <SpotlightThemeProvider>
      <PortfolioBalanceHeader
        activeChartPoint={null}
        isSummaryHidden={false}
        onToggleHidden={jest.fn()}
        summary={summary}
        {...props}
      />
    </SpotlightThemeProvider>,
  );
}

describe('PortfolioBalanceHeader', () => {
  it('renders the resting summary without the scrub-only added line', () => {
    renderHeader();

    expect(screen.getByTestId('portfolio-balance-header')).toBeTruthy();
    expect(screen.getByTestId('portfolio-summary-value')).toBeTruthy();
    expect(screen.getByTestId('portfolio-summary-delta')).toBeTruthy();
    expect(screen.queryByTestId('portfolio-summary-added')).toBeNull();
  });

  it('shows "Added N cards (+$...)" while scrubbing a point with adds', () => {
    renderHeader({
      activeChartPoint: buildActivePoint({ addedCount: 3, addedValueLabel: '+$210.00' }),
    });

    expect(screen.getByTestId('portfolio-summary-added')).toHaveTextContent(
      'Added 3 cards (+$210.00)',
    );
    // The scrub date still renders alongside the new line.
    expect(screen.getByTestId('portfolio-summary-delta-date')).toBeTruthy();
  });

  it('uses the singular "card" for a single add', () => {
    renderHeader({
      activeChartPoint: buildActivePoint({ addedCount: 1, addedValueLabel: '+$5.00' }),
    });

    expect(screen.getByTestId('portfolio-summary-added')).toHaveTextContent(
      'Added 1 card (+$5.00)',
    );
  });

  it('hides the added line when the scrubbed point has no adds', () => {
    renderHeader({
      activeChartPoint: buildActivePoint({ addedCount: 0, addedValueLabel: null }),
    });

    expect(screen.queryByTestId('portfolio-summary-added')).toBeNull();
  });

  it('hides the added line for payloads without the add fields (older chart)', () => {
    renderHeader({ activeChartPoint: buildActivePoint() });

    expect(screen.queryByTestId('portfolio-summary-added')).toBeNull();
  });

  it('masks the dollar amount on the added line while the summary is hidden', () => {
    renderHeader({
      activeChartPoint: buildActivePoint({ addedCount: 3, addedValueLabel: '+$210.00' }),
      isSummaryHidden: true,
    });

    const addedLine = screen.getByTestId('portfolio-summary-added');
    expect(addedLine).toHaveTextContent('Added 3 cards');
    expect(addedLine).not.toHaveTextContent('$210.00');
  });
});
