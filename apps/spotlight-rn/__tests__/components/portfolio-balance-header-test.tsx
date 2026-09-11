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

  // The buy-marker "Added N cards" feature was removed entirely (2026-07-18):
  // the added line must never render, even while scrubbing.
  it('never renders an added line while scrubbing', () => {
    renderHeader({ activeChartPoint: buildActivePoint() });

    expect(screen.queryByTestId('portfolio-summary-added')).toBeNull();
    expect(screen.getByTestId('portfolio-summary-delta-date')).toBeTruthy();
  });
});

/*
  THE HEADLINE MUST NOT PRINT A NUMBER IT IS ABOUT TO REPLACE.

  A cold open used to show three figures in a couple of seconds: the mask, then
  the inventory-only fallback's estimate, then the authoritative total, with the
  rolling digits scrambling between the last two (user, 2026-09-11: "it shows
  like - or 0 or some other value outside of my 424k and then flickers").

  The fallback still earns the headline when the dashboard is NOT coming — an
  unreachable backend, where an inventory-derived total beats a permanent dash.
*/
describe('PortfolioBalanceHeader — what counts as a known total', () => {
  const summaryOf = (currentValue: number) => ({
    currentValue,
    changeAmount: 0,
    changePercent: 0,
    asOfLabel: 'Today',
  });

  it('masks the total while the real one is still loading', () => {
    render(
      <PortfolioBalanceHeader
        activeChartPoint={null}
        isSummaryHidden={false}
        isValueKnown={false}
        onToggleHidden={jest.fn()}
        summary={summaryOf(14601.58)}
        testIDPrefix="balance"
      />,
    );

    expect(screen.queryByText(/14,601/)).toBeNull();
  });

  it('shows the total once it is the real one', () => {
    render(
      <PortfolioBalanceHeader
        activeChartPoint={null}
        isSummaryHidden={false}
        isValueKnown
        onToggleHidden={jest.fn()}
        summary={summaryOf(424141.44)}
        testIDPrefix="balance"
      />,
    );

    // The file mocks RollingNumberText to a plain Text, so the formatted value
    // is assertable directly.
    expect(screen.getByText('$424,141.44')).toBeTruthy();
  });
});
